import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {basename, dirname, resolve} from 'node:path';
import {afterEach, mock} from 'node:test';
import {fileURLToPath} from 'node:url';

const testDirectory = fileURLToPath(new URL('../', import.meta.url));
const gateFile = fileURLToPath(new URL('../../src/runner/signal-gate.ts', import.meta.url));
const runnerTest = /^runner-.*\.test\.[cm]?[jt]s$/u;
let installed = false;

// The preload is present in the complete test command, but only runner workers
// install it. Child tools and unrelated helper/API tests keep their own harness.
const entry = process.argv[1];
if (entry && dirname(resolve(entry)) === resolve(testDirectory) && runnerTest.test(basename(entry))) installSignalRuntimeGuard();

/** Explicit opt-in for the isolated runtime regression fixtures. */
export function installSignalRuntimeGuard(): void {
  if (installed) return;
  installed = true;
  const violations: Error[] = [];
  type Sink = (...args: any[]) => any;
  type Slot = {object: object; key: string; current: Sink};
  const slots: Slot[] = [];
  const guardedSinks = new WeakMap<Sink, Sink>();
  const retainedKillFd = (value: unknown): boolean => {
    if (!Number.isSafeInteger(value) || Number(value) < 0) return false;
    try {return /(?:^|\/)cgroup\.kill(?: \(deleted\))?$/u.test(fs.readlinkSync(`/proc/self/fd/${value}`));}
    catch {return false;}
  };
  const containmentWrite = (args: unknown[]): boolean => {
    const target = args[0];
    return retainedKillFd(target) || typeof target === 'string' && /(?:^|\/)cgroup\.kill$/u.test(target) ||
      target instanceof URL && /(?:^|\/)cgroup\.kill$/u.test(target.pathname);
  };
  const signalUtility = /(?:^|[;&|\n])\s*(?:(?:exec|sudo)\s+)*["']?(?:[^\s"';&|]*\/)?(?:kill|pkill|killall)(?=["'\s]|$)/u;
  const signalExecutable = (value: string): boolean => /(?:^|\/)(?:kill|pkill|killall)$/u.test(value) || signalUtility.test(value);
  function signalCommand(args: unknown[]): boolean {
    const command = args[0];
    if (typeof command !== 'string') return false;
    if (signalExecutable(command)) return true;
    // Shell and env launchers can carry the utility in their argument vector.
    if (!/(?:^|\/)(?:(?:ba|da|z|k)?sh|env)$/u.test(command)) return false;
    return Array.isArray(args[1]) && args[1].some(argument => typeof argument === 'string' && signalExecutable(argument));
  }

  function protect(object: object, key: string, label: string, isSignal: (args: unknown[]) => boolean,
    fixtureAllowed = false, transformResult?: (result: any) => any): void {
    const wrappers = new WeakMap<Sink, Sink>();
    function wrap(sink: Sink): Sink {
      if (guardedSinks.has(sink)) return sink;
      const existing = wrappers.get(sink);
      if (existing) return existing;
      function guarded(this: unknown, ...args: unknown[]): unknown {
        if (isSignal(args)) {
          const origin = new Error(`Runner signal bypass: ${label} must be issued by signalIfStillOwned.`);
          const previous = Error.prepareStackTrace;
          let caller: NodeJS.CallSite | undefined;
          try {
            Error.prepareStackTrace = (_error, frames) => frames;
            Error.captureStackTrace(origin, guarded);
            caller = (origin.stack as unknown as NodeJS.CallSite[])[0];
          } finally { Error.prepareStackTrace = previous; }
          const source = caller?.getFileName();
          const path = source?.startsWith('file:') ? fileURLToPath(source) : source;
          const fromGate = path === gateFile && caller?.getFunctionName() === 'signalIfStillOwned';
          // Direct fixture liveness/teardown calls retain their existing allowance.
          // Production code cannot borrow a test or gate ancestor frame.
          const fromFixture = fixtureAllowed && !!path && dirname(resolve(path)) === resolve(testDirectory) && runnerTest.test(basename(path));
          // Node owns its automatic child timeouts and abort handling. These are
          // not explicit helper signal calls, and must keep working under preload.
          const fromNode = label === 'ChildProcess.kill' && source?.startsWith('node:');
          if (!fromGate && !fromFixture && !fromNode) {
            const violation = Object.assign(new Error(`${origin.message} Caller: ${caller?.toString() ?? 'unknown'}`),
              {code: 'ERR_RUNNER_SIGNAL_BYPASS'});
            violations.push(violation);
            process.exitCode = 1;
            throw violation;
          }
        }
        const result = Reflect.apply(sink, this, args);
        return transformResult ? transformResult(result) : result;
      }
      // Preserve mock inspection and promisify metadata. The latter can itself
      // be a callable that bypasses the public function, so guard it as well.
      const guardedSink = new Proxy(guarded, {get: (_target, property) => {
        const value = Reflect.get(sink, property);
        return property === Symbol.for('nodejs.util.promisify.custom') && typeof value === 'function' ? wrap(value) : value;
      }});
      guardedSinks.set(guardedSink, sink);
      wrappers.set(sink, guardedSink);
      return guardedSink;
    }
    const slot: Slot = {object, key, current: wrap(Reflect.get(object, key))};
    slots.push(slot);
    Object.defineProperty(object, key, {
      configurable: false, enumerable: true,
      get: () => slot.current,
      set: (sink: Sink) => {slot.current = wrap(sink); syncBuiltinESMExports();},
    });
  }

  protect(process, 'kill', 'process.kill', () => true, true);
  protect(childProcess.ChildProcess.prototype, 'kill', 'ChildProcess.kill', () => true, true);
  for (const key of ['writeSync', 'write', 'writev', 'writevSync', 'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync']) {
    protect(fs, key, `fs.${key}`, containmentWrite);
  }
  protect(fs, 'createWriteStream', 'fs.createWriteStream', args => containmentWrite(args) ||
    !!args[1] && typeof args[1] === 'object' && retainedKillFd(Reflect.get(args[1], 'fd')));
  for (const key of ['writeFile', 'appendFile']) protect(fsPromises, key, `fs.promises.${key}`, containmentWrite);
  // FileHandle methods otherwise bypass both public fs write APIs. Retain the
  // endpoint's actual FD identity, including indirect handles and deleted names.
  const guardedHandles = new WeakSet<object>();
  protect(fsPromises, 'open', 'fs.promises.open', () => false, false, result => Promise.resolve(result).then(handle => {
    if (guardedHandles.has(handle)) return handle;
    guardedHandles.add(handle);
    for (const key of ['write', 'writeFile', 'appendFile', 'writev', 'createWriteStream']) if (typeof Reflect.get(handle, key) === 'function') {
      protect(handle, key, `FileHandle.${key}`, () => retainedKillFd(handle.fd));
    }
    return handle;
  }));
  for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    protect(childProcess, key, `child_process.${key}`, signalCommand);
  }

  // MockTracker.method needs data properties. A private proxy holder routes
  // installs and restores through the accessor, so mocks cannot disable checks.
  const tracker = Object.getPrototypeOf(mock);
  const mockMethod = tracker.method;
  Object.defineProperty(tracker, 'method', {configurable: true, writable: true,
    value(this: unknown, object: object, key: PropertyKey, ...args: unknown[]) {
      const slot = slots.find(slot => slot.object === object && slot.key === key);
      if (!slot) return Reflect.apply(mockMethod, this, [object, key, ...args]);
      // Passthrough spies call the raw sink after the outer caller check.
      const holder = new Proxy({[key]: guardedSinks.get(slot.current) ?? slot.current}, {
        defineProperty(target, property, descriptor) {
          const changed = Reflect.defineProperty(target, property, descriptor);
          if (changed) Reflect.set(object, key, descriptor.value);
          return changed;
        },
      });
      return Reflect.apply(mockMethod, this, [holder, key, ...args]);
    },
  });
  syncBuiltinESMExports();

  // Signal callers often catch ESRCH/inspection errors. Remember every bypass
  // so swallowing the thrown guard error still fails the owning runner test.
  afterEach(() => {
    const rejected = violations.splice(0);
    assert.equal(rejected.length, 0, rejected.map(error => error.message).join('\n'));
  });
}
