import {readFile, rm, writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import type {TestContext} from 'node:test';
import {clock, type Timing} from '../../src/config.js';
import {LINUX_CONTAINMENT_PATHS, type LinuxContainedRun, type LinuxContainmentBackend} from '../../src/runner/linux-containment.js';
import {RunnerStorageOwner, storageOwnerDiagnostics, type RunnerStorageOwnerDiagnostics} from '../../src/runner/storage-owner.js';
import {currentLinuxToolLifecycle, withLinuxRunContext} from '../../src/runner/linux-lifecycle.js';
import {startTool, type RunningTool, type StartToolOptions} from '../../src/runner/process.js';
import {RunnerJournal} from '../../src/runner/journal.js';
import {acquireRunnerStorageLock} from '../../src/runner/storage-lock.js';

/**
 * These tests require the real provisioned service, cgroups, namespaces and
 * guardian. Selecting the native lane never substitutes an uncontained tool.
 * The opt-in must be supplied by the fixture service's test invocation.
 */
export const linuxNativeWorkloadSkip = process.platform === 'linux' && process.env.MDAI_LINUX_NATIVE_TESTS !== '1'
  ? 'Native Linux workload fixture requires the provisioned mdai system service; run with MDAI_LINUX_NATIVE_TESTS=1.' : false;

/** Real qualification, staging and sealed cleanup may include TERM grace.
 * Keep historical Darwin timing while allowing the native Linux protocol. */
export const linuxNativeFixtureTimeout = (historical: number): number =>
  process.platform === 'linux' && !linuxNativeWorkloadSkip ? 90_000 : historical;

/** Readiness must stop as soon as the owning run finishes, including an early
 * admission refusal. Queued pending rows alone are not terminal: a live claim
 * deliberately persists its crash outcome before it begins preparation. */
export async function waitForNativeFixtureState(check: () => boolean | Promise<boolean>, options: {
  label: string;
  finished?: Promise<unknown>;
  timeout?: number;
  interval?: number;
}): Promise<void> {
  const deadline = Date.now() + (options.timeout ?? linuxNativeFixtureTimeout(8000));
  const ended = options.finished?.then(
    result => new Error(`${options.label}: run ended before the expected state: ${JSON.stringify(result)}`),
    cause => new Error(`${options.label}: run failed before the expected state`, {cause}),
  );
  while (!await check()) {
    assert(Date.now() < deadline, `${options.label}: fixture did not reach its expected state`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pause = new Promise<void>(resolve => {timer = setTimeout(resolve, options.interval ?? 10);});
      const failure = await (ended ? Promise.race([pause, ended]) : pause);
      if (failure) {
        // The requested state may itself be the final queued outcome. Observe
        // it once more after completion before reporting an early finish.
        if (await check()) return;
        throw failure;
      }
    } finally {clearTimeout(timer);}
  }
}

type NativeFixtureCoreDiagnostics = Readonly<{
  busy: boolean; idle: boolean; jobs: number; closed: boolean; closeFinished: boolean;
  initializing: boolean; cycling: boolean; disconnecting: number; tools: number;
  owner?: RunnerStorageOwnerDiagnostics | null;
}>;

/** Fixture cleanup never destroys a journal whose complete acknowledged
 * history cannot be replayed as CLEAN. This read-only replay grants no launch,
 * recovery or cleanup capability and never establishes a new owner epoch. */
export async function cleanupNativeFixtureRoot(t: TestContext, root: string, data: string, cleanup: () => Promise<void>,
  timing: Timing = clock, diagnostics?: () => NativeFixtureCoreDiagnostics): Promise<void> {
  let phase = 'cleanup';
  try {
    await cleanup();
    if (process.platform === 'linux') {
      // Core shutdown is bounded, including owner retirement. Its caller may
      // finish before the retained descriptors physically close. Wait for the
      // real kernel-lock transfer before replay; neither an outcome nor idle
      // grants permission to delete the fixture's journal.
      phase = 'lock-acquisition';
      const lock = await acquireRunnerStorageLock(data, timing, timing.now() + linuxNativeFixtureTimeout(8000));
      let current = true;
      try {
        phase = 'journal-replay';
        const journal = new RunnerJournal(await lock.directory('runner'), {
          directoryIdentity: lock.identity, bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
          ownerEpoch: randomUUID(), generation: 1, isCurrent: () => current, completionScope: 'full-run', contractVersion: 1,
        });
        if ((await journal.replay()).busy) throw new Error('Native fixture journal remains unresolved.');
      } finally {current = false; await lock.release();}
    }
    phase = 'remove-root';
    await rm(root, {recursive: true, force: true});
  } catch (error) {
    t.diagnostic(`Retained unresolved native fixture evidence at ${root} (journal: ${data}).`);
    // The retained registry and optional core callback are synchronous, inert
    // memory observations. In particular, failed lock acquisition never opens
    // or replays the journal and diagnostics cannot release its holder.
    let core: NativeFixtureCoreDiagnostics | {unavailable: true} | null = null;
    if (diagnostics) {
      try {
        const snapshot = diagnostics();
        core = {busy: snapshot.busy, idle: snapshot.idle, jobs: snapshot.jobs, closed: snapshot.closed,
          closeFinished: snapshot.closeFinished, initializing: snapshot.initializing, cycling: snapshot.cycling,
          disconnecting: snapshot.disconnecting, tools: snapshot.tools, owner: snapshot.owner ?? null};
      } catch {core = {unavailable: true};}
    }
    t.diagnostic(`Native fixture holder diagnostics: ${JSON.stringify({phase, storage: storageOwnerDiagnostics(data), core})}`);
    throw error;
  }
}

/** Only pre-launch refusal fixtures may pass qualification without a native
 * service. Every execution, recovery and proof operation is an explicit test
 * failure. The opted-in native lane always keeps the real backend. */
export function qualifyLinuxFixtureWithoutWorkloads(t: TestContext): void {
  if (!linuxNativeWorkloadSkip) return;
  let unexpected = 0;
  const refuse = async (): Promise<never> => {unexpected++; throw new Error('A pre-launch fixture attempted a containment operation.');};
  const backend: LinuxContainmentBackend = {namespaceId: 'pre-launch-fixture', reserve: refuse, reopen: refuse,
    retireCompleted: refuse, verifyRegistration: refuse, verifyCompletion: refuse, close: async () => {}};
  t.mock.method(RunnerStorageOwner.prototype, 'getLinuxContainment', async function(this: RunnerStorageOwner, generation: number) {
    this.assertGeneration(generation); return backend;
  });
  t.after(() => assert.equal(unexpected, 0, 'the pre-launch fixture must never execute or recover a workload'));
}

/** Retain the real durable owner until the returned finished promise settles. */
export async function startNativeFixtureTool(data: string, options: StartToolOptions): Promise<RunningTool> {
  if (process.platform !== 'linux') return startTool(options);
  if (linuxNativeWorkloadSkip) throw new Error(linuxNativeWorkloadSkip);
  let started!: (running: RunningTool) => void, failed!: (error: unknown) => void;
  const ready = new Promise<RunningTool>((resolve, reject) => {started = resolve; failed = reject;});
  const finished = withLinuxRunContext(data, async () => {
    const running = await startTool({...options, linuxLifecycle: currentLinuxToolLifecycle(randomUUID())});
    started(running); return running.finished;
  });
  void finished.catch(failed);
  const running = await ready;
  return {...running, finished};
}

export function observeNativeLinuxWorkloads(t: TestContext, hooks: {
  term?: (run: LinuxContainedRun) => void;
  captured?: (run: LinuxContainedRun) => void;
  ready?: (run: LinuxContainedRun) => void | Promise<void>;
  empty?: (run: LinuxContainedRun, isEmpty: boolean) => void;
  proof?: (run: LinuxContainedRun, proof: unknown) => void;
} = {}) {
  const runs: LinuxContainedRun[] = [];
  if (process.platform === 'linux' && !linuxNativeWorkloadSkip) {
    const original = RunnerStorageOwner.prototype.getLinuxContainment;
    const wrapped = new WeakMap<LinuxContainmentBackend, LinuxContainmentBackend>();
    t.mock.method(RunnerStorageOwner.prototype, 'getLinuxContainment', async function(this: RunnerStorageOwner, generation: number) {
      const backend = await original.call(this, generation);
      let observer = wrapped.get(backend);
      if (!observer) {
        observer = {...backend, reserve: async request => {
          const run = await backend.reserve(request);
          // Keep the real retained endpoints and opaque proof implementation.
          // This wrapper records requests, never supplies cleanup authority.
          const observed: LinuxContainedRun = {...run,
            ready: run.ready.then(() => hooks.ready?.(run)),
            term: async () => {hooks.term?.(run); await run.term();},
            empty: async () => {const empty = await run.empty(); hooks.empty?.(run, empty); return empty;},
            completionProof: async () => {const proof = await run.completionProof(); hooks.proof?.(run, proof); return proof;}};
          void observed.ready.catch(() => undefined);
          hooks.captured?.(run);
          runs.push(observed); return observed;
        }};
        wrapped.set(backend, observer);
      }
      return observer;
    });
  }
  const latest = () => runs.at(-1);
  const work = (run: LinuxContainedRun) => join(LINUX_CONTAINMENT_PATHS.runs, run.registration.name.slice(4), 'work');
  return {
    latest,
    /** Scoped cgroup diagnostics support liveness assertions, never signaling. */
    async processNamed(name: string): Promise<number> {
      const run = latest(); if (!run) return 0;
      const cgroup = join(LINUX_CONTAINMENT_PATHS.root, `ns-${run.registration.namespaceId}`, run.registration.name, 'cgroup.procs');
      let text: string;
      try {text = await readFile(cgroup, 'utf8');} catch {return 0;}
      for (const pid of text.trim().split('\n').map(Number).filter(pid => Number.isSafeInteger(pid) && pid > 1)) {
        try {if ((await readFile(`/proc/${pid}/comm`, 'utf8')).trim() === name) return pid;} catch { /* A fixture process may exit between reads. */ }
      }
      return 0;
    },
    async finish(): Promise<void> {
      const run = latest(); if (!run) throw new Error('The native fixture has no admitted run.');
      await writeFile(join(work(run), '.native-fixture-finish'), 'finish\n', {mode: 0o600});
    },
    async cleanup(): Promise<void> {
      for (const run of runs) {
        // After successful retirement this capability is revoked. On failure,
        // teardown can still use only its original retained containment.
        try {run.seal(); await run.forceKill();} catch { /* The owning core retains any unresolved obligation. */ }
      }
    },
  };
}
