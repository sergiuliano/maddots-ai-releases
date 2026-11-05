import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {EventEmitter} from 'node:events';
import {mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import test, {type TestContext} from 'node:test';
import {TOOL_MATRIX} from '../src/shared/tool-matrix.js';
import type {Adapter, RunSpec} from '../src/runner/adapter.js';
import {ProcessCleanupError, startTool, type LinuxToolLaunchRequest, type ProcessEntry, type ProcessGroup, type ProcessInspector} from '../src/runner/process.js';
import type {LinuxContainedRun} from '../src/runner/linux-containment.js';
import {CODEX_FIXTURE_PROVIDER} from './support/codex-local-provider-fixture.js';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const cleanupCap = 20_000;

async function advanceTime(t: TestContext, milliseconds: number): Promise<void> {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 25) {
    t.mock.timers.tick(Math.min(25, milliseconds - elapsed));
    await flush();
  }
}

function observe<T>(promise: Promise<T>) {
  const state: {settled: boolean; value?: T; error?: unknown; at?: number} = {settled: false};
  void promise.then(value => {state.settled = true; state.value = value; state.at = Date.now();}, error => {
    state.settled = true; state.error = error; state.at = Date.now();
  });
  return state;
}

function mockPlatform(t: TestContext, platform: NodeJS.Platform): void {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', {...descriptor, value: platform});
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'mdai-cleanup-cap-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const runDir = join(directory, '.maddots', 'runs', 'fixture');
  await mkdir(runDir, {recursive: true});
  const promptFile = join(runDir, 'prompt.md');
  await writeFile(promptFile, 'Fixture task.');
  const bin = await realpath(process.execPath);
  const root = 920_100, descendant = root + 1;
  const child = Object.assign(new EventEmitter(), {
    pid: root, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  });
  let closeCount = 0, disposed = false, cleanupCompletes = false, launchBlocked = false, toolStarts = 0;
  let launchBarrier: Promise<void> | undefined;
  let toolStartFailure: 'tool-error' | 'child-error' | 'null-start' | undefined;
  child.on('close', () => {closeCount++;});
  let spawned = false, descendantAlive = true, blockPersistence = false;
  let persistenceBlocked = false, releasePersistence!: () => void;
  const persistence = new Promise<void>(resolve => {releasePersistence = resolve;});
  const spawning = t.mock.method(childProcess, 'spawn', () => {spawned = true; return child;});
  syncBuiltinESMExports();
  const signals: {target: number; signal: NodeJS.Signals | number | undefined; at: number}[] = [];
  t.mock.method(process, 'kill', (target: number, signal?: NodeJS.Signals | number) => {
    signals.push({target, signal, at: Date.now()}); return true;
  });
  t.mock.timers.enable({apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000});
  // Deadline fixtures advance a synthetic timer clock. Keep the independent
  // process clock deterministic too; rollback cases override it explicitly.
  const timerNow = Date.now, clockOrigin = process.hrtime.bigint();
  t.mock.method(process.hrtime, 'bigint', () => clockOrigin + BigInt(Math.floor((timerNow() - 1_000_000) * 1e6)));
  const rows = (): ProcessEntry[] => !spawned ? [] : [
    ...(child.exitCode === null ? [{pid: root, ppid: process.pid, pgid: root, startedAt: 'root-start'}] : []),
    ...(descendantAlive ? [{pid: descendant, ppid: child.exitCode === null ? root : 1, pgid: root, startedAt: 'descendant-start'}] : []),
  ];
  const inspector: ProcessInspector = {
    table: async () => rows(),
    identity: async pid => rows().find(row => row.pid === pid)?.startedAt ?? null,
    inspectSync: pid => rows().find(row => row.pid === pid) ?? null,
    // Startup probes fencePids separately from cleanup's coherent fenceEntries.
    fencePids: async () => rows().filter(row => row.pid === descendant).map(row => row.pid),
    fenceEntries: async () => rows().filter(row => row.pid === descendant),
    signalGroup: (pgid, signal) => {signals.push({target: -pgid, signal, at: Date.now()});},
  };
  const parse = t.mock.fn(() => ({ok: true, text: 'Unexpected success.', failureCode: null}));
  const adapter: Adapter = {
    info: {tool: 'codex', harness: 'codex', card: 'TLS-26', folderOnly: 'os-sandbox', mcpLevel: 'servers-off',
      skillsDir: '{runDir}/skills', promptVia: 'stdin', runHome: false},
    identity: async () => ({ok: true, version: 'fixture'}), supports: () => ({ok: true, reason: null}),
    build: spec => ({argv: [spec.bin], env: {}, envUnset: [], stdinFile: spec.promptFile,
      files: [], projectFiles: [], spawnCwd: null, secretEnv: {}}),
    parse,
  };
  const spec: RunSpec = {bin, cwd: directory, runDir, promptFile, model: 'fixture', provider: CODEX_FIXTURE_PROVIDER,
    effort: null, access: process.platform === 'linux' ? 'full_access' : 'folder_only', skillsDir: join(runDir, 'skills'), maxTurns: 50,
    timeoutSeconds: 0, runHome: null};
  const matrix = structuredClone(TOOL_MATRIX);
  Object.assign(matrix.tools.find(tool => tool.key === 'codex')!.run!, {offered: true, platforms: {darwin: {accepted: true}, linux: {accepted: true}}, folderOnly: 'os-sandbox'});
  const saved: ProcessGroup[][] = [];
  const preparedDeadlines: number[] = [];
  const launch = (maxRunMinutes = 1, callbacks: Pick<Parameters<typeof startTool>[0], 'onGroups' | 'onStarted' | 'onSpawn' | 'assertLaunchAllowed' | 'now' | 'signal'> = {}) => startTool({...callbacks, adapter, spec, matrix, processes: inspector,
    ...(process.platform === 'linux' ? {linuxLifecycle: {
      // This is an explicit retained-backend simulation. It never enables the
      // production backend or turns process observations into signal authority.
      prepare: async (request: LinuxToolLaunchRequest) => {
        preparedDeadlines.push(request.deadline);
        const guardian = childProcess.spawn('trusted-contained-fixture', [], {}) as unknown as LinuxContainedRun['child'];
        let sealed = false;
        const ready = (async () => {
          if (!inspector.inspectSync) await inspector.identity(root);
          saved.push([{pgid: root, startedAt: '', cleanupPending: true}]);
          await callbacks.onGroups?.(saved.at(-1)!);
        })();
        void ready.catch(() => undefined);
        return {child: guardian, ready,
          seal: () => {sealed = true;}, start: () => !sealed,
          registration: {backend: 'linux-cgroup-v2', namespaceId: 'fixture', name: 'run-fixture', objectIdentity: 'fixture'},
        } as unknown as LinuxContainedRun;
      },
      launch: async (run: LinuxContainedRun, assertLaunchAllowed?: () => void) => {
        if (launchBarrier) {launchBlocked = true; await launchBarrier;}
        assertLaunchAllowed?.();
        if (!run.start({binding: 'a'.repeat(64), incarnation: '00000000-0000-0000-0000-000000000001',
          notAfterMonotonicNs: (process.hrtime.bigint() + 1_000_000_000n).toString()})) throw new ProcessCleanupError();
        toolStarts++;
        if (toolStartFailure === 'tool-error') child.emit('message', {type: 'tool-error'});
        else if (toolStartFailure === 'child-error') child.emit('error', new Error('fixture admission handshake failed'));
        else child.emit('message', {type: 'tool-start', pid: toolStartFailure === 'null-start' ? null : child.pid});
        const control = child as typeof child & {connected?: boolean; send?: (message: string, done: () => void) => void};
        if (control.connected) control.send?.('start', () => undefined);
      },
      cleanup: async (run: LinuxContainedRun, deadline: number) => {
        run.seal();
        if (!saved.length) saved.push([{pgid: root, startedAt: '', cleanupPending: true}]);
        if (cleanupCompletes && child.exitCode === null) {descendantAlive = false; exit(); close();}
        if (blockPersistence) {persistenceBlocked = true; await persistence;}
        while (descendantAlive || child.exitCode === null) {
          if (Date.now() >= deadline) throw new ProcessCleanupError();
          await new Promise<void>(resolve => setTimeout(resolve, 25));
        }
      },
    }} : {}),
    claimedAt: callbacks.now?.() ?? Date.now(), expiresAt: (callbacks.now?.() ?? Date.now()) + 7_200_000, maxRunMinutes,
    onGroups: async groups => {
      saved.push(structuredClone(groups));
      if (blockPersistence) {persistenceBlocked = true; await persistence;}
      await callbacks.onGroups?.(groups);
    }});
  const exit = () => {child.exitCode = 0; child.emit('exit', 0, null);};
  const close = () => {
    child.stdout.end(); child.stderr.end(); child.stdin.destroy();
    child.emit('close', 0, null);
  };
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    releasePersistence(); descendantAlive = false;
    if (child.exitCode === null) exit();
    child.stdout.end(); child.stderr.end(); child.stdin.destroy();
    child.emit('close', 0, null);
    await flush();
    spawning.mock.restore(); syncBuiltinESMExports();
  };
  return {child, adapter, inspector, signals, saved, parse, launch, exit, close, dispose, releasePersistence, spawning, preparedDeadlines,
    completeOnCleanup: () => {cleanupCompletes = true;},
    holdLaunch: (pending: Promise<void>) => {launchBarrier = pending;},
    failToolStart: (failure: NonNullable<typeof toolStartFailure>) => {toolStartFailure = failure;},
    get launchBlocked() {return launchBlocked;}, get toolStarts() {return toolStarts;},
    removeDescendant: () => {descendantAlive = false;},
    blockPersistence: () => {blockPersistence = true;},
    get persistenceBlocked() {return persistenceBlocked;}, get closeCount() {return closeCount;}};
}

test('S3 Linux translates the runner clock once and keeps that original deadline through a held launch', async t => {
  mockPlatform(t, 'linux');
  const f = await fixture(t); f.completeOnCleanup();
  let release!: () => void;
  f.holdLaunch(new Promise<void>(done => {release = done;}));
  const runnerNow = () => Date.now() - 900_000;
  const started = t.mock.fn(async () => {}), spawned = t.mock.fn();
  const starting = observe(f.launch(1, {now: runnerNow, onStarted: started, onSpawn: spawned}));
  try {
    const ends = performance.now() + 2000;
    while (!f.launchBlocked && !starting.settled && performance.now() < ends) await flush();
    assert(f.launchBlocked);
    const [preparedDeadline] = f.preparedDeadlines;
    assert(preparedDeadline <= 1_060_000 && preparedDeadline > 1_059_000,
      'containment receives the remaining real-time budget, never the runner absolute clock');
    await advanceTime(t, 500);
    release(); await advanceTime(t, 1);
    assert.equal(starting.error, undefined, 'the actual start handshake uses the same translated deadline');
    assert(starting.value); assert.equal(started.mock.callCount(), 1); assert.equal(spawned.mock.callCount(), 1);
    assert.deepEqual(f.preparedDeadlines, [preparedDeadline], 'held launch work cannot rebase or extend the original deadline');
    await advanceTime(t, 59_500);
    assert.equal((await starting.value.finished).failureCode, 'run_time_limit');
    assert.deepEqual(f.signals, []);
  } finally {release(); await f.dispose();}
});

for (const clock of ['caller', 'host'] as const) test(`S4 Linux ${clock} clock rollback during preflight cannot extend the original workload lifetime`, async t => {
  mockPlatform(t, 'linux');
  const f = await fixture(t); f.completeOnCleanup();
  let monotonic = 1_000_000_000_000n, wallShift = 0, callerShift = 0;
  t.mock.method(process.hrtime, 'bigint', () => monotonic);
  const hostNow = Date.now;
  t.mock.method(Date, 'now', () => hostNow() + wallShift);
  const runnerNow = () => Date.now() - 900_000 + callerShift;
  let entered = false, release!: () => void;
  const pending = new Promise<void>(done => {release = done;});
  f.adapter.preflight = async () => {entered = true; await pending; return {ok: true, reason: null};};
  const started = t.mock.fn(async () => {}), spawned = t.mock.fn();
  const starting = observe(f.launch(1, {now: runnerNow, onStarted: started, onSpawn: spawned}));
  try {
    const ends = performance.now() + 2000;
    while (!entered && !starting.settled && performance.now() < ends) await flush();
    assert(entered);
    await advanceTime(t, 10_000); monotonic += 10_000_000_000n;
    if (clock === 'host') wallShift = -60_000; else callerShift = -60_000;
    release();
    while (!starting.settled && performance.now() < ends) await flush();
    assert.equal(starting.error, undefined); assert(starting.value);
    assert.deepEqual(f.preparedDeadlines, [Date.now() + 50_000], 'preflight consumes the original monotonic budget despite clock rollback');
    assert.equal(started.mock.callCount(), 1); assert.equal(spawned.mock.callCount(), 1);
    const finished = observe(starting.value.finished);
    await advanceTime(t, 49_999); assert.equal(finished.settled, false);
    await advanceTime(t, 1);
    assert(finished.value); assert.equal(finished.value.failureCode, 'run_time_limit');
    assert.deepEqual(f.signals, []);
  } finally {release(); await f.dispose();}
});

for (const failure of ['child-error', 'tool-error', 'null-start'] as const) test(`S4 Linux ${failure} handshake cannot deliver callbacks or stdin before verified admission`, async t => {
  mockPlatform(t, 'linux');
  const f = await fixture(t); f.completeOnCleanup(); f.failToolStart(failure);
  const started = t.mock.fn(async () => {}), spawned = t.mock.fn();
  const input: Buffer[] = []; f.child.stdin.on('data', chunk => input.push(Buffer.from(chunk)));
  const starting = observe(f.launch(1, {onStarted: started, onSpawn: spawned}));
  try {
    const ends = performance.now() + 2000;
    while (!f.toolStarts && !starting.settled && performance.now() < ends) await flush();
    assert.equal(f.toolStarts, 1);
    await advanceTime(t, failure === 'null-start' ? 2000 : 1);
    assert(starting.settled); assert(starting.error, 'a failed native admission handshake must reject startup');
    assert.equal(started.mock.callCount(), 0); assert.equal(spawned.mock.callCount(), 0);
    assert.deepEqual(input, []); assert.deepEqual(f.signals, []);
    assert.equal(f.child.exitCode, 0, 'the retained lifecycle performs cleanup before startup rejects');
  } finally {await f.dispose();}
});

test('S3 Linux cancellation during a held launch barrier vetoes the final start after journal settlement', async t => {
  mockPlatform(t, 'linux');
  const f = await fixture(t); f.completeOnCleanup();
  let release!: () => void, allowed = true;
  const pending = new Promise<void>(done => {release = done;}); f.holdLaunch(pending);
  const refused = Object.assign(new Error('run was cancelled during durable launch'), {code: 'runner_stopped'});
  const finalVeto = t.mock.fn(() => {if (!allowed) throw refused;});
  const started = t.mock.fn(async () => {}), spawned = t.mock.fn();
  const input: Buffer[] = []; f.child.stdin.on('data', chunk => input.push(Buffer.from(chunk)));
  const starting = observe(f.launch(1, {assertLaunchAllowed: finalVeto, onStarted: started, onSpawn: spawned}));
  try {
    const ends = performance.now() + 2000;
    while (!f.launchBlocked && !starting.settled && performance.now() < ends) await flush();
    assert(f.launchBlocked); assert.equal(f.toolStarts, 0);
    allowed = false; release(); await advanceTime(t, 1);
    assert.equal(starting.error, refused);
    assert.equal(f.toolStarts, 0, 'late durable permission cannot start a cancelled workload');
    assert.equal(finalVeto.mock.callCount(), 4, 'admission is checked before executable probes, before preparation, before launch and at the final start');
    assert.equal(started.mock.callCount(), 0); assert.equal(spawned.mock.callCount(), 0);
    assert.deepEqual(input, []); assert.deepEqual(f.signals, []);
  } finally {release(); await f.dispose();}
});

for (const pending of ['native handshake', 'onStarted', 'onSpawn'] as const) test(`S4 Linux cancellation during pending ${pending} cleans admission before the core receives its handle`, async t => {
  mockPlatform(t, 'linux');
  const f = await fixture(t); f.completeOnCleanup();
  const controller = new AbortController();
  let entered = false, release!: () => void;
  const held = new Promise<void>(done => {release = done;});
  if (pending === 'native handshake') f.failToolStart('null-start');
  const started = t.mock.fn(async () => {if (pending === 'onStarted') {entered = true; await held;}});
  const spawned = t.mock.fn(async () => {if (pending === 'onSpawn') {entered = true; await held;}});
  const input: Buffer[] = []; f.child.stdin.on('data', chunk => input.push(Buffer.from(chunk)));
  const starting = observe(f.launch(1, {signal: controller.signal, onStarted: started, onSpawn: spawned}));
  try {
    const ends = performance.now() + 2000;
    while (!(pending === 'native handshake' ? f.toolStarts : entered) && !starting.settled && performance.now() < ends) await flush();
    assert.equal(f.toolStarts, 1); assert.equal(starting.settled, false);
    controller.abort(); await advanceTime(t, 1);
    assert(starting.error && typeof starting.error === 'object' && 'code' in starting.error);
    assert.equal(starting.error.code, 'runner_stopped');
    assert.equal(f.child.exitCode, 0, 'the retained cleanup must extinguish an admitted tool before exposing a public handle');
    assert.equal(started.mock.callCount(), pending === 'native handshake' ? 0 : 1);
    assert.equal(spawned.mock.callCount(), pending === 'onSpawn' ? 1 : 0);
    assert.deepEqual(input, []); assert.deepEqual(f.signals, []);
    const failure = starting.error;
    release(); f.child.emit('message', {type: 'tool-start', pid: f.child.pid});
    await advanceTime(t, 1000);
    assert.equal(starting.error, failure, 'a late handshake or callback cannot replace the cancellation result');
    assert.equal(spawned.mock.callCount(), pending === 'onSpawn' ? 1 : 0);
    assert.deepEqual(input, [], 'late startup settlement cannot deliver task stdin');
    assert.equal(f.parse.mock.callCount(), 0);
  } finally {release(); await f.dispose();}
});

test('S3 Linux refuses every tool entry before identity, provider lookup or spawn without a retained lifecycle', async t => {
  mockPlatform(t, 'linux');
  const identity = t.mock.fn(async () => ({ok: true, version: 'never'}));
  const spawned = t.mock.method(childProcess, 'spawn', () => assert.fail('uncontained Linux launch'));
  syncBuiltinESMExports(); t.after(syncBuiltinESMExports);
  const provider = t.mock.fn(async () => 'never-read');
  await assert.rejects(startTool({adapter: {identity} as unknown as Adapter, spec: {} as RunSpec,
    claimedAt: Date.now(), expiresAt: Date.now() + 7_200_000, maxRunMinutes: 1, readProviderKey: provider}),
  {code: 'linux_containment_unavailable'});
  assert.equal(identity.mock.callCount(), 0); assert.equal(provider.mock.callCount(), 0); assert.equal(spawned.mock.callCount(), 0);
});

for (const callback of ['onStarted', 'onSpawn'] as const) {
  test(`S3 Linux cleanup in progress prevents a released ${callback} from resuming startup`, async t => {
    mockPlatform(t, 'linux');
    const f = await fixture(t);
    let entered = false, release!: () => void;
    const pending = new Promise<void>(resolve => {release = resolve;});
    const started = t.mock.fn(async () => {if (callback === 'onStarted') {entered = true; await pending;}});
    const spawned = t.mock.fn(async () => {if (callback === 'onSpawn') {entered = true; await pending;}});
    const input: Buffer[] = []; f.child.stdin.on('data', chunk => input.push(Buffer.from(chunk)));
    const starting = observe(f.launch(1, {onStarted: started, onSpawn: spawned}));
    try {
      const until = performance.now() + 2000;
      while (!entered && !starting.settled && performance.now() < until) await flush();
      assert(entered);
      f.blockPersistence(); f.removeDescendant(); f.exit(); f.close(); await flush();
      assert(f.persistenceBlocked, 'physical cleanup is done while durable retirement is held');
      release(); await advanceTime(t, 1);
      assert.equal(starting.settled, false, 'a released callback must await the existing cleanup result');
      assert.equal(spawned.mock.callCount(), callback === 'onSpawn' ? 1 : 0);
      assert.deepEqual(input, [], 'no prompt reaches an exited workload while retirement is pending');
      f.releasePersistence(); await advanceTime(t, 1);
      assert(starting.value); assert.equal((await starting.value.finished).stopped, false);
      assert.deepEqual(f.signals, []);
    } finally {release(); await f.dispose();}
  });
}

test('S3 Linux retained cleanup settles a deadline while initial readiness is pending without late launch', async t => {
  mockPlatform(t, 'linux');
  const f = await fixture(t); f.completeOnCleanup(); delete f.inspector.inspectSync;
  let entered = false, release!: () => void;
  const pending = new Promise<string>(resolve => {release = () => resolve('late-diagnostic-identity');});
  f.inspector.identity = async () => {entered = true; return pending;};
  const started = t.mock.fn(async () => {}), spawned = t.mock.fn();
  const input: Buffer[] = []; f.child.stdin.on('data', chunk => input.push(Buffer.from(chunk)));
  const starting = observe(f.launch(0.001, {onStarted: started, onSpawn: spawned}));
  try {
    const until = performance.now() + 2000;
    while (!entered && !starting.settled && performance.now() < until) await flush();
    assert(entered);
    await advanceTime(t, 60);
    assert(starting.value, 'a retained cleanup capability can finish while diagnostic identity is unavailable');
    assert.equal((await starting.value.finished).failureCode, 'run_time_limit');
    release(); await advanceTime(t, 80_001);
    assert.equal(started.mock.callCount(), 0); assert.equal(spawned.mock.callCount(), 0);
    assert.deepEqual(input, []); assert.deepEqual(f.signals, []);
  } finally {release(); await f.dispose();}
});

test('S3 Linux retained empty proof cannot make inherited pipe hangs exceed the cleanup cap', async t => {
  mockPlatform(t, 'linux');
  const f = await fixture(t);
  try {
    const running = await f.launch(), finished = observe(running.finished);
    f.removeDescendant(); f.exit(); const began = Date.now(); await flush();
    await advanceTime(t, 1000);
    assert(f.child.stdout.destroyed && f.child.stderr.destroyed);
    assert.equal(finished.settled, false);
    await advanceTime(t, cleanupCap - 1000);
    assert.equal(finished.at, began + cleanupCap); assert(finished.error instanceof ProcessCleanupError);
    assert.equal(f.parse.mock.callCount(), 0); assert.deepEqual(f.signals, []);
  } finally {await f.dispose();}
});

for (const trigger of ['manual stop', 'deadline', 'natural exit', 'stuck retirement'] as const) {
  test(`S3 Linux ${trigger} keeps unresolved containment while bounding finished`, async t => {
    mockPlatform(t, 'linux');
    const f = await fixture(t);
    try {
      const running = await f.launch(trigger === 'deadline' ? 0.001 : 1), finished = observe(running.finished);
      let stop: ReturnType<typeof observe> | undefined;
      if (trigger === 'natural exit') f.exit();
      else if (trigger === 'deadline') await advanceTime(t, 60);
      else {if (trigger === 'stuck retirement') f.blockPersistence(); stop = observe(running.stop('runner_stopped'));}
      const began = Date.now(); await flush();
      await advanceTime(t, cleanupCap - 1); assert.equal(finished.settled, false);
      await advanceTime(t, 1); assert.equal(finished.at, began + cleanupCap);
      assert(finished.error instanceof ProcessCleanupError); if (stop) assert(stop.error instanceof ProcessCleanupError);
      assert(f.child.stdin.destroyed && f.child.stdout.destroyed && f.child.stderr.destroyed);
      assert(f.saved.some(groups => groups.some(group => group.cleanupPending)));
      assert.deepEqual(f.signals, []); assert.equal(f.parse.mock.callCount(), 0);
      const failure = finished.error; f.releasePersistence(); await advanceTime(t, 1000);
      assert.equal(finished.error, failure); assert.deepEqual(f.signals, []);
    } finally {await f.dispose();}
  });
}

test('S1: a revoked launch generation vetoes the initial spawn before any child or startup callback exists', async t => {
  mockPlatform(t, 'linux');
  const f = await fixture(t), failure = Object.assign(new Error('fixture owner generation revoked'), {code: 'RUNNER_STATE_UNAVAILABLE'});
  const allowed = t.mock.fn(() => {throw failure;});
  const started = t.mock.fn(async () => {}), spawned = t.mock.fn();
  const input: Buffer[] = []; f.child.stdin.on('data', chunk => {input.push(Buffer.from(chunk));});
  const starting = observe(f.launch(1, {assertLaunchAllowed: allowed, onStarted: started, onSpawn: spawned}));
  try {
    const began = performance.now();
    while (!starting.settled && performance.now() - began < 2000) await flush();
    assert.equal(starting.settled, true, 'the synchronous veto must settle without a cleanup wait');
    assert.equal(starting.error, failure);
    assert.equal(allowed.mock.callCount(), 1);
    assert.equal(f.spawning.mock.callCount(), 0, 'revoked admission cannot create even the initial child');
    assert.equal(started.mock.callCount(), 0); assert.equal(spawned.mock.callCount(), 0);
    assert.deepEqual(f.saved, []); assert.deepEqual(f.signals, []); assert.deepEqual(input, []);
    await advanceTime(t, cleanupCap + 60_001);
    assert.equal(starting.error, failure);
    assert.equal(f.spawning.mock.callCount(), 0);
    assert.equal(started.mock.callCount(), 0); assert.equal(spawned.mock.callCount(), 0);
    assert.equal(f.parse.mock.callCount(), 0); assert.deepEqual(input, []);
  } finally {await f.dispose();}
});

test('S1: revocation during guardian persistence vetoes its start message and bounds cleanup without stdin or late callbacks', async t => {
  mockPlatform(t, 'linux');
  const f = await fixture(t), failure = Object.assign(new Error('fixture owner generation revoked'), {code: 'RUNNER_STATE_UNAVAILABLE'});
  f.inspector.sessionGuardian = true;
  const inspect = f.inspector.inspectSync!, table = f.inspector.table;
  f.inspector.inspectSync = pid => {
    const row = inspect(pid); return row ? {...row, sid: String(f.child.pid)} : row;
  };
  f.inspector.table = async () => (await table()).map(row => ({...row, sid: String(f.child.pid)}));
  const sent: unknown[] = [];
  Object.assign(f.child, {connected: true, send: (message: unknown, callback?: () => void) => {sent.push(message); callback?.();}});
  let admitted = true, entered = false, release!: () => void;
  const pending = new Promise<void>(resolve => {release = resolve;});
  const allowed = t.mock.fn(() => {if (!admitted) throw failure;});
  const started = t.mock.fn(async () => {}), spawned = t.mock.fn();
  const input: Buffer[] = []; f.child.stdin.on('data', chunk => {input.push(Buffer.from(chunk));});
  const starting = observe(f.launch(1, {assertLaunchAllowed: allowed, onStarted: started, onSpawn: spawned,
    onGroups: async () => {if (!entered) {entered = true; await pending;}},
  }));
  try {
    const began = performance.now();
    while (!entered && !starting.settled && performance.now() - began < 2000) await flush();
    assert(entered, 'the trusted guardian must wait on its persistence barrier');
    assert.equal(f.spawning.mock.callCount(), 1); assert.equal(allowed.mock.callCount(), 2);
    assert.equal(sent.length, 0, 'the paused guardian has not received launch permission');
    admitted = false; release();
    const revokedAt = Date.now(), checking = performance.now();
    while (allowed.mock.callCount() < 3 && !starting.settled && performance.now() - checking < 2000) await flush();
    assert.equal(allowed.mock.callCount(), 3, 'late persistence must recheck admission immediately before start');
    assert.equal(sent.includes('start'), false);
    await advanceTime(t, cleanupCap - 1);
    assert.equal(starting.settled, false, 'a surviving paused guardian still owns its cleanup obligation');
    await advanceTime(t, 1);
    assert.equal(starting.settled, true); assert(starting.error instanceof ProcessCleanupError);
    assert.equal(starting.at, revokedAt + cleanupCap);
    assert.equal(f.spawning.mock.callCount(), 1, 'revocation cannot create a tool or replacement child');
    assert.equal(sent.includes('start'), false);
    assert.equal(started.mock.callCount(), 0); assert.equal(spawned.mock.callCount(), 0);
    assert(f.child.stdin.destroyed && f.child.stdout.destroyed && f.child.stderr.destroyed);
    assert.deepEqual(input, []); assert.equal(f.parse.mock.callCount(), 0);
    const rejected = starting.error, savesAtFailure = f.saved.length;
    await advanceTime(t, 1000);
    assert.equal(starting.error, rejected); assert.equal(f.saved.length, savesAtFailure);
    assert.equal(sent.includes('start'), false); assert.deepEqual(input, []);
    assert.equal(started.mock.callCount(), 0); assert.equal(spawned.mock.callCount(), 0);
    assert(f.signals.every(({at}) => at <= revokedAt + cleanupCap), 'cleanup cannot signal after its original cap');
  } finally {release(); await f.dispose();}
});

for (const platform of ['linux', 'darwin'] as const) {
  test(`FIX17: natural exit during pending initial identity returns the completed handle on ${platform}`, async t => {
    mockPlatform(t, platform);
    const f = await fixture(t);
    delete f.inspector.inspectSync;
    let release!: () => void, entered = false;
    const pending = new Promise<string>(resolve => {release = () => resolve('late-startup-identity');});
    const identity = f.inspector.identity;
    f.inspector.identity = pid => {
      if (!entered) {entered = true; return pending;}
      return identity(pid);
    };
    const started = t.mock.fn(async () => undefined), spawned = t.mock.fn();
    const input: Buffer[] = [];
    f.child.stdin.on('data', chunk => {input.push(Buffer.from(chunk));});
    const starting = observe(f.launch(1, {onStarted: started, onSpawn: spawned}));
    try {
      const waitingAt = performance.now();
      while (!entered && !starting.settled && performance.now() - waitingAt < 2000) await flush();
      assert(entered, 'the initial lifetime inspection must be pending before natural exit');
      f.removeDescendant(); f.exit(); f.close();
      await advanceTime(t, 1);
      assert(starting.settled, 'verified natural exit must release the pending initial inspection');
      assert.equal(starting.error, undefined);
      assert(starting.value);
      assert.equal(starting.value.startedAt, '');
      const result = await starting.value.finished;
      assert.equal(result.ok, true);
      assert.equal(result.stopped, false);
      release();
      await advanceTime(t, 1000);
      assert.equal(starting.value.startedAt, '');
      assert.equal(await starting.value.finished, result);
      assert.equal(started.mock.callCount(), 0);
      assert.equal(spawned.mock.callCount(), 0);
      assert.deepEqual(input, []);
      assert.deepEqual(f.signals, []);
      assert(f.saved.every(groups => groups.every(group => group.startedAt !== 'late-startup-identity')));
    } finally {release(); await f.dispose();}
  });
}

for (const platform of ['linux', 'darwin'] as const) for (const callback of ['onStarted', 'onSpawn'] as const) {
  test(`FIX17: verified natural exit interrupts a stuck ${callback} on ${platform}`, async t => {
    mockPlatform(t, platform);
    const f = await fixture(t);
    let release!: () => void, entered = false;
    const pending = new Promise<void>(resolve => {release = resolve;});
    const blocked = async () => {entered = true; await pending;};
    const started = t.mock.fn(async () => {if (callback === 'onStarted') await blocked();});
    const spawned = t.mock.fn(async () => {if (callback === 'onSpawn') await blocked();});
    const input: Buffer[] = [];
    f.child.stdin.on('data', chunk => {input.push(Buffer.from(chunk));});
    const starting = observe(f.launch(1, {onStarted: started, onSpawn: spawned}));
    try {
      const waitingAt = performance.now();
      while (!entered && !starting.settled && performance.now() - waitingAt < 2000) await flush();
      assert(entered, 'the startup callback must be pending before natural exit');
      f.removeDescendant(); f.exit(); f.close();
      const exitedAt = Date.now();
      await advanceTime(t, 1);
      assert(starting.settled, 'verified natural completion must release startup without its callback');
      assert.equal(starting.error, undefined);
      assert(starting.value, 'startup returns the verified completed handle');
      const result = await starting.value.finished;
      assert.equal(result.ok, true);
      assert.equal(result.stopped, false);
      assert.equal(result.failureCode, null);
      assert.equal(result.exitCode, 0);
      assert(starting.at! <= exitedAt + 1, 'startup completion does not wait for the cleared run deadline');
      assert.equal(f.parse.mock.callCount(), 1);
      assert.equal(started.mock.callCount(), 1);
      assert.equal(spawned.mock.callCount(), callback === 'onSpawn' ? 1 : 0);
      assert.deepEqual(input, [], 'a completed run cannot receive a late task prompt');
      const savesAtCompletion = f.saved.length;
      release();
      await advanceTime(t, 80_001);
      assert.equal(await starting.value.finished, result);
      assert.equal(started.mock.callCount(), 1);
      assert.equal(spawned.mock.callCount(), callback === 'onSpawn' ? 1 : 0, 'late callback resolution cannot resume startup');
      assert.equal(f.saved.length, savesAtCompletion, 'late callback resolution cannot resume startup bookkeeping');
      assert.deepEqual(input, []);
      assert.deepEqual(f.signals, [], 'verified process absence needs no signals');
    } finally {release(); await f.dispose();}
  });

  test(`FIX17: natural exit cleanup failure interrupts a stuck ${callback} on ${platform}`, async t => {
    mockPlatform(t, platform);
    const f = await fixture(t);
    let release!: () => void, entered = false;
    const pending = new Promise<void>(resolve => {release = resolve;});
    const blocked = async () => {entered = true; await pending;};
    const spawned = t.mock.fn(async () => {if (callback === 'onSpawn') await blocked();});
    const input: Buffer[] = [];
    f.child.stdin.on('data', chunk => {input.push(Buffer.from(chunk));});
    const starting = observe(f.launch(1, {
      onStarted: async () => {if (callback === 'onStarted') await blocked();}, onSpawn: spawned,
    }));
    try {
      const waitingAt = performance.now();
      while (!entered && !starting.settled && performance.now() - waitingAt < 2000) await flush();
      assert(entered, 'the startup callback must be pending before natural exit');
      f.exit(); f.close();
      const exitedAt = Date.now();
      await advanceTime(t, cleanupCap - 1);
      assert.equal(starting.settled, false);
      await advanceTime(t, 1);
      assert.equal(starting.settled, true);
      assert(starting.error instanceof ProcessCleanupError, 'natural exit cannot hide a surviving descendant');
      assert.equal(starting.at, exitedAt + cleanupCap);
      assert.equal(starting.value, undefined);
      assert.equal(f.parse.mock.callCount(), 0);
      assert(f.saved.some(groups => groups.some(group => group.cleanupPending)));
      const failed = starting.error;
      const savesAtFailure = f.saved.length;
      release();
      await advanceTime(t, 1000);
      assert.equal(starting.error, failed);
      assert.equal(f.saved.length, savesAtFailure);
      assert.equal(spawned.mock.callCount(), callback === 'onSpawn' ? 1 : 0);
      assert.deepEqual(input, []);
      assert(f.signals.every(({at}) => at <= exitedAt + cleanupCap));
    } finally {release(); await f.dispose();}
  });
}

test('FIX15: verified deadline cleanup interrupts a stuck onStarted callback without waiting for the cleanup cap', async t => {
  mockPlatform(t, 'darwin');
  const f = await fixture(t);
  let release!: () => void, entered = false;
  const pending = new Promise<void>(resolve => {release = resolve;});
  const spawned = t.mock.fn();
  const signalGroup = f.inspector.signalGroup!;
  f.inspector.signalGroup = (pgid, signal) => {
    signalGroup(pgid, signal);
    if (signal === 'SIGTERM') queueMicrotask(() => {
      f.removeDescendant(); f.exit();
      f.child.stdout.end(); f.child.stderr.end(); f.child.stdin.destroy();
      f.child.emit('close', 0, null);
    });
  };
  const began = Date.now();
  const starting = observe(f.launch(0.001, {
    onStarted: async () => {entered = true; await pending;}, onSpawn: spawned,
  }));
  try {
    const waitingAt = performance.now();
    while (!entered && !starting.settled && performance.now() - waitingAt < 2000) await flush();
    assert(entered, 'the startup callback must remain pending before the deadline');
    await advanceTime(t, 59);
    assert.equal(starting.settled, false);
    await advanceTime(t, 1);
    assert.equal(starting.settled, true, 'verified cleanup must interrupt startup as soon as the stopped result is available');
    assert.equal((starting.error as {code?: string})?.code, 'run_time_limit');
    assert.equal(starting.at, began + 60);
    assert.equal(f.closeCount, 1);
    assert.equal(f.parse.mock.callCount(), 0);
    assert.deepEqual(f.signals.map(({signal}) => signal), ['SIGTERM']);
    assert.equal(spawned.mock.callCount(), 0);
    const rejected = starting.error;
    release();
    await advanceTime(t, 1000);
    assert.equal(starting.error, rejected, 'late startup completion cannot replace the stopped result');
    assert.equal(spawned.mock.callCount(), 0, 'late callback completion cannot resume the launch');
  } finally {release(); await f.dispose();}
});

for (const callback of ['onGroups', 'onStarted'] as const) {
  test(`FIX15: a stuck startup ${callback} rejects at the deadline plus cleanup cap without close`, async t => {
    mockPlatform(t, 'darwin');
    const f = await fixture(t);
    let release!: () => void, entered = false;
    const pending = new Promise<void>(resolve => {release = resolve;});
    const blocked = async () => {entered = true; await pending;};
    const started = t.mock.fn(async () => {if (callback === 'onStarted') await blocked();});
    const spawned = t.mock.fn();
    const input: Buffer[] = [];
    f.child.stdin.on('data', chunk => {input.push(Buffer.from(chunk));});
    const began = Date.now();
    const starting = observe(f.launch(0.001, {
      ...(callback === 'onGroups' ? {onGroups: blocked} : {}), onStarted: started, onSpawn: spawned,
    }));
    try {
      const waitingAt = performance.now();
      while (!entered && !starting.settled && performance.now() - waitingAt < 2000) await flush();
      assert(entered, `the fixture must reach the startup callback before advancing the deadline: ${String(starting.error ?? 'still starting')}`);
      assert.equal(starting.settled, false);
      await advanceTime(t, 60);
      await advanceTime(t, cleanupCap - 1);
      assert.equal(starting.settled, false, 'the blocked callback remains pending before cleanup expires');
      await advanceTime(t, 1);
      assert.equal(starting.settled, true, 'startup must reject without the callback or child close');
      assert(starting.error instanceof ProcessCleanupError);
      assert.equal(starting.at, began + 60 + cleanupCap);
      assert.equal(f.closeCount, 0);
      assert(f.child.stdin.destroyed && f.child.stdout.destroyed && f.child.stderr.destroyed);
      assert(f.saved.some(groups => groups.some(group => group.cleanupPending)));
      assert.equal(started.mock.callCount(), callback === 'onStarted' ? 1 : 0);
      assert.equal(spawned.mock.callCount(), 0, 'startup must not reach the spawn callback after its failure');
      assert.deepEqual(input, [], 'a blocked startup must not deliver the task prompt');
      const failedAt = starting.at;
      release();
      await advanceTime(t, 1000);
      assert.equal(starting.at, failedAt, 'late startup completion cannot replace the cleanup failure');
      assert.equal(started.mock.callCount(), callback === 'onStarted' ? 1 : 0);
      assert.equal(spawned.mock.callCount(), 0, 'late callback completion cannot resume the launch');
      assert.deepEqual(input, []);
      assert(f.signals.every(({at}) => at <= failedAt!), 'late callbacks cannot authorize signals after the cap');
    } finally {release(); await f.dispose();}
  });
}

test('FIX15: verified process absence still bounds finished when inherited pipes never close', async t => {
  mockPlatform(t, 'darwin');
  const f = await fixture(t);
  try {
    const running = await f.launch();
    const finished = observe(running.finished);
    f.removeDescendant(); f.exit();
    const began = Date.now();
    await flush();
    await advanceTime(t, 1000);
    assert(f.child.stdout.destroyed && f.child.stderr.destroyed, 'verified cleanup bounds pipe draining');
    assert.equal(finished.settled, false, 'missing close keeps the public result pending');
    await advanceTime(t, cleanupCap - 1001);
    assert.equal(finished.settled, false);
    await advanceTime(t, 1);
    assert.equal(finished.settled, true, 'waiting for close cannot extend successful process verification');
    assert(finished.error instanceof ProcessCleanupError);
    assert.equal(finished.at, began + cleanupCap);
    assert.equal(f.closeCount, 0);
    assert.deepEqual(f.signals, [], 'complete process absence needs no signal');
    assert.equal(f.parse.mock.callCount(), 0, 'an absent close cannot be reported as successful output');
  } finally {await f.dispose();}
});

for (const trigger of ['manual stop', 'deadline', 'natural exit', 'stuck persistence'] as const) {
  test(`FIX15: ${trigger} settles finished within the cleanup cap when the child never closes`, async t => {
    mockPlatform(t, 'darwin');
    const f = await fixture(t);
    try {
      const running = await f.launch(trigger === 'deadline' ? 0.001 : 1);
      const finished = observe(running.finished);
      let stopped: ReturnType<typeof observe> | undefined;
      if (trigger === 'natural exit') f.exit();
      else if (trigger === 'deadline') await advanceTime(t, 60);
      else {
        if (trigger === 'stuck persistence') f.blockPersistence();
        stopped = observe(running.stop('runner_stopped'));
      }
      const began = Date.now();
      await flush();
      if (trigger === 'stuck persistence') assert(f.persistenceBlocked, 'cleanup must reach the blocked save');
      await advanceTime(t, cleanupCap - 1);
      assert.equal(finished.settled, false, 'unfinished cleanup keeps finished pending until the cap');
      if (stopped) assert.equal(stopped.settled, false, 'stop shares the unfinished cleanup obligation');
      await advanceTime(t, 1);
      assert.equal(finished.settled, true, 'finished must settle without waiting for exit or close');
      assert(finished.error instanceof ProcessCleanupError, 'unverified cleanup must reject with ProcessCleanupError');
      assert.equal(finished.at, began + cleanupCap, 'the original cleanup deadline is a hard bound');
      if (stopped) {
        assert.equal(stopped.settled, true, 'stop must settle within the same cleanup bound');
        assert(stopped.error instanceof ProcessCleanupError);
      }
      assert.equal(f.closeCount, 0, 'the fixture has never emitted close');
      assert(f.child.stdin.destroyed && f.child.stdout.destroyed && f.child.stderr.destroyed,
        'cleanup expiry releases the helper pipe handles without requiring child close');
      assert.equal(f.parse.mock.callCount(), 0, 'cleanup failure cannot produce a successful parse');
      assert(f.saved.some(groups => groups.some(group => group.cleanupPending)), 'unresolved cleanup remains durable');
      const settledAt = finished.at;
      f.releasePersistence();
      await advanceTime(t, 1000);
      assert(f.signals.every(({at}) => at <= began + cleanupCap), 'late storage settlement cannot authorize signals after the cap');
      await f.dispose();
      assert.equal(finished.at, settledAt, 'late close and persistence settlement cannot replace the cap failure');
    } finally {await f.dispose();}
  });
}
