import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {EventEmitter} from 'node:events';
import {mkdtemp, mkdir, realpath, rm, writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import test, {type TestContext} from 'node:test';
import {fileURLToPath} from 'node:url';
import {TOOL_MATRIX} from '../src/shared/tool-matrix.js';
import type {Adapter, RunSpec} from '../src/runner/adapter.js';
import {recoverProcess, startTool, type ProcessEntry, type ProcessGroup, type ProcessInspector} from '../src/runner/process.js';
import {signalIfStillOwned, type SignalChild} from '../src/runner/signal-gate.js';

const fake = fileURLToPath(new URL('./fixtures/fake-tool.mjs', import.meta.url));
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {resolve = done;});
  return {promise, resolve};
}
async function advanceTime(t: TestContext, milliseconds: number): Promise<void> {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 25) {
    t.mock.timers.tick(Math.min(25, milliseconds - elapsed));
    await flush();
  }
}
function mockPlatform(t: TestContext, platform: NodeJS.Platform): void {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', {...descriptor, value: platform});
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
}
function observe<T>(promise: Promise<T>) {
  return promise.then(value => ({ok: true as const, value}), error => ({ok: false as const, error: error as unknown}));
}

async function simulatedGuardian(t: TestContext, root = 910000) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'mdai-signal-gate-'));
  const runDir = join(directory, '.maddots', 'runs', 'fixture');
  await mkdir(runDir, {recursive: true});
  const promptFile = join(runDir, 'prompt.md');
  await writeFile(promptFile, 'Do the work');
  const bin = await realpath(process.execPath);
  const matrix = structuredClone(TOOL_MATRIX);
  matrix.tools.find(item => item.key === 'codex')!.run = {adapter: 'codex', card: 'TLS-26', offered: true, platforms: {darwin: {accepted: true}, linux: {accepted: true}}, folderOnly: 'os-sandbox', mcpLevel: 'servers-off', reason: null, checkedAt: '2026-10-14'};
  const adapter: Adapter = {
    info: {tool: 'codex', harness: 'codex', card: 'TLS-26', folderOnly: 'os-sandbox', mcpLevel: 'servers-off', skillsDir: '{runDir}/skills', promptVia: 'stdin', runHome: false},
    identity: async () => ({ok: true, version: '1.0.0'}),
    supports: () => ({ok: true, reason: null}),
    build: spec => ({argv: [spec.bin, fake, 'sleep'], env: {}, envUnset: [], stdinFile: spec.promptFile, files: [], projectFiles: [], spawnCwd: null, secretEnv: {}}),
    parse: result => ({ok: result.exitCode === 0, text: result.stdout, failureCode: result.exitCode === 0 ? null : 'tool_failed'}),
  };
  const spec: RunSpec = {bin, cwd: directory, runDir, promptFile, model: 'fixture', provider: null, effort: null, access: 'folder_only', skillsDir: join(runDir, 'skills'), maxTurns: 50, timeoutSeconds: 0, runHome: null};
  const signals: {target: number; signal: NodeJS.Signals | number | undefined; childAlive: boolean}[] = [];
  const child = Object.assign(new EventEmitter(), {
    pid: root, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, connected: false,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: (signal: NodeJS.Signals) => {signals.push({target: root, signal, childAlive: child.exitCode === null && child.signalCode === null}); return true;},
  });
  let spawned = false;
  const spawning = t.mock.method(childProcess, 'spawn', () => {spawned = true; return child;});
  syncBuiltinESMExports();
  t.mock.method(process, 'kill', (target: number, signal?: NodeJS.Signals | number) => {
    signals.push({target, signal, childAlive: child.exitCode === null && child.signalCode === null});
    return true;
  });
  const model = {rows: [{pid: root, ppid: process.pid, pgid: root, sid: String(root), startedAt: 'guardian-original'}] as ProcessEntry[]};
  const samples: (string | undefined)[] = [];
  const row = (pid: number) => model.rows.find(value => value.pid === pid);
  const inspector: ProcessInspector = {
    sessionGuardian: true,
    table: async () => spawned ? structuredClone(model.rows) : [],
    identity: async pid => {const startedAt = row(pid)?.startedAt; samples.push(startedAt); return startedAt ?? null;},
    inspect: async pid => {const current = row(pid); samples.push(current?.startedAt); return current ? {...current} : null;},
    fencePids: async () => [],
    signalGroup: (pgid, signal) => {signals.push({target: -pgid, signal, childAlive: child.exitCode === null && child.signalCode === null});},
  };
  const exit = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = 0;
    child.stdout.end(); child.stderr.end(); child.stdin.destroy();
    child.emit('exit', 0, null); child.emit('close', 0, null);
  };
  const launch = (extra: Partial<Parameters<typeof startTool>[0]> = {}) => startTool({adapter, spec, matrix, processes: inspector,
    claimedAt: Date.now(), expiresAt: Date.now() + 7_200_000, maxRunMinutes: 1, ...extra});
  const dispose = async () => {
    exit();
    spawning.mock.restore(); syncBuiltinESMExports();
    await rm(directory, {recursive: true, force: true});
  };
  return {root, child, model, samples, signals, inspector, exit, launch, dispose};
}

test('FIX9: a legacy lifetime mismatch permanently revokes child fallback through a later outage', async t => {
  mockPlatform(t, 'darwin');
  const pid = 910030;
  const child = {pid, exitCode: null, signalCode: null};
  const authority: SignalChild = {child};
  t.mock.method(process, 'kill', () => assert.fail('disproved child authority cannot signal during an inspection outage'));
  assert.deepEqual(await signalIfStillOwned({kind: 'pid', pid}, 'SIGTERM', {
    startedAt: 'original-lifetime', authority, identity: async () => 'replacement-lifetime',
  }), {status: 'unproven', cleanupPending: true});
  assert.equal(authority.revoked, true);
  const unavailable = () => {throw new Error('injected inspection outage');};
  assert.deepEqual(await signalIfStillOwned({kind: 'group', pid}, 'SIGKILL', {
    witness: {pid, startedAt: 'original-lifetime'}, authority, read: unavailable, allowChildPidFallback: true,
  }), {status: 'unproven', cleanupPending: true});
  assert.deepEqual(await signalIfStillOwned({kind: 'pid', pid}, 'SIGKILL', {
    startedAt: 'original-lifetime', authority, identity: unavailable,
  }), {status: 'unproven', cleanupPending: true});
});

test('FIX9: a PID target cannot borrow a different witness lifetime or live child', async t => {
  mockPlatform(t, 'darwin');
  const target = 910060, witness = 910061;
  let reads = 0;
  t.mock.method(process, 'kill', () => assert.fail('a different process cannot authorize the requested PID'));
  for (const liveChild of [false, true]) {
    assert.deepEqual(await signalIfStillOwned({kind: 'pid', pid: target}, 'SIGKILL', {
      witness: {pid: witness, startedAt: 'other-lifetime'},
      ...(liveChild ? {child: {pid: witness, exitCode: null, signalCode: null}} : {}),
      read: () => {reads++; return {pid: witness, pgid: witness, startedAt: 'other-lifetime'};},
    }), {status: 'unproven', cleanupPending: true});
  }
  assert.equal(reads, 0, 'an inconsistent PID target is rejected before reading the other witness');
});

test('FIX9: a live child can authorize its own PID before a start identity is captured, while absence revokes it', async t => {
  mockPlatform(t, 'darwin');
  const pid = 910062;
  const authority: SignalChild = {child: {pid, exitCode: null, signalCode: null}};
  const sent: number[] = [];
  t.mock.method(process, 'kill', (target: number) => {sent.push(target); return true;});
  const read = () => ({pid, pgid: pid, startedAt: 'newly-observed-lifetime'});
  assert.deepEqual(await signalIfStillOwned({kind: 'pid', pid}, 'SIGTERM', {authority, read}),
    {status: 'sent', cleanupPending: true});
  assert.deepEqual(sent, [pid]);
  assert.deepEqual(await signalIfStillOwned({kind: 'pid', pid}, 'SIGKILL', {authority, read: () => null}),
    {status: 'unproven', cleanupPending: true});
  assert.equal(authority.revoked, true, 'a complete absent read revokes even a child without a captured start identity');
  assert.deepEqual(await signalIfStillOwned({kind: 'pid', pid}, 'SIGKILL', {authority, read}),
    {status: 'unproven', cleanupPending: true});
  assert.deepEqual(sent, [pid], 'a later matching row cannot restore the revoked capability');
});

test('FIX9: an expired signal deadline never starts a row or lifetime read', async t => {
  mockPlatform(t, 'darwin');
  const pid = 910031;
  let reads = 0;
  t.mock.method(Date, 'now', () => 1000);
  t.mock.method(process, 'kill', () => assert.fail('an expired cleanup budget cannot signal'));
  for (const reader of ['read', 'identity'] as const) {
    const evidence = {
      startedAt: 'original-lifetime', deadline: 1000,
      ...(reader === 'read' ? {read: () => {reads++; return {pid, pgid: pid, startedAt: 'original-lifetime'};}} :
        {identity: () => {reads++; return 'original-lifetime';}}),
    };
    assert.deepEqual(await signalIfStillOwned({kind: 'pid', pid}, 'SIGKILL', evidence), {status: 'unproven', cleanupPending: true});
  }
  assert.equal(reads, 0, 'the deadline is checked before either inspection hook is invoked');
});

test('FIX9: expiry during an awaited row read suppresses the signal', async t => {
  mockPlatform(t, 'darwin');
  const pid = 910032, sampled = deferred(), release = deferred();
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(process, 'kill', () => assert.fail('a row returned after the deadline cannot authorize a signal'));
  const pending = signalIfStillOwned({kind: 'group', pid}, 'SIGKILL', {
    startedAt: 'original-lifetime', deadline: 1100,
    read: async () => {
      const row = {pid, pgid: pid, startedAt: 'original-lifetime'};
      sampled.resolve();
      await release.promise;
      return row;
    },
  });
  await sampled.promise;
  now = 1100;
  release.resolve();
  assert.deepEqual(await pending, {status: 'unproven', cleanupPending: true});
});

test('FIX9: a coherent synchronous reader reaches the signal before a queued child-exit microtask', async t => {
  mockPlatform(t, 'darwin');
  const pid = 910033;
  const child = {pid, exitCode: null as number | null, signalCode: null};
  const events: string[] = [];
  t.mock.method(process, 'kill', (target: number, signal?: NodeJS.Signals | number) => {
    assert.equal(target, -pid);
    assert.equal(signal, 'SIGTERM');
    assert.equal(child.exitCode, null, 'validation and the signal sink remain in one synchronous turn');
    events.push('signal');
    return true;
  });
  const pending = signalIfStillOwned({kind: 'group', pid}, 'SIGTERM', {
    startedAt: 'original-lifetime', child,
    read: () => {
      events.push('read');
      queueMicrotask(() => {child.exitCode = 0; events.push('exit');});
      return {pid, pgid: pid, startedAt: 'original-lifetime'};
    },
  });
  assert.deepEqual(events, ['read', 'signal'], 'the gate introduces no await after a synchronous read');
  assert.deepEqual(await pending, {status: 'sent', cleanupPending: true});
  assert.deepEqual(events, ['read', 'signal', 'exit']);
});

test('FIX9: a stale awaited row cannot signal a child that exited before the read resolves', async t => {
  mockPlatform(t, 'darwin');
  const pid = 910034, sampled = deferred(), release = deferred();
  const child = {pid, exitCode: null as number | null, signalCode: null};
  t.mock.method(process, 'kill', () => assert.fail('the exited child revokes authority despite the sampled matching row'));
  const pending = signalIfStillOwned({kind: 'group', pid}, 'SIGKILL', {
    startedAt: 'original-lifetime', child,
    read: async () => {
      const row = {pid, pgid: pid, startedAt: 'original-lifetime'};
      sampled.resolve();
      await release.promise;
      return row;
    },
  });
  await sampled.promise;
  child.exitCode = 0;
  release.resolve();
  assert.deepEqual(await pending, {status: 'unproven', cleanupPending: true});
});

test('FIX9: self-group authority requires this process and its current group membership', async t => {
  mockPlatform(t, 'darwin');
  const sent: {pid: number; signal: NodeJS.Signals | number | undefined}[] = [];
  t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {sent.push({pid, signal}); return true;});
  const other = 910050;
  assert.deepEqual(await signalIfStillOwned({kind: 'self-group', pid: other}, 'SIGKILL', {
    read: () => ({pid: other, pgid: other}),
  }), {status: 'unproven', cleanupPending: true});
  assert.deepEqual(await signalIfStillOwned({kind: 'self-group', pid: process.pid}, 'SIGKILL', {
    read: () => ({pid: process.pid, pgid: other}),
  }), {status: 'unproven', cleanupPending: true});
  assert.deepEqual(await signalIfStillOwned({kind: 'self-group', pid: process.pid}, 'SIGKILL', {
    read: () => null,
  }), {status: 'unproven', cleanupPending: true});
  assert.deepEqual(sent, []);
  assert.deepEqual(await signalIfStillOwned({kind: 'self-group', pid: process.pid}, 'SIGKILL', {
    read: () => ({pid: process.pid, pgid: process.pid}),
  }), {status: 'sent', cleanupPending: true});
  assert.deepEqual(sent, [{pid: -process.pid, signal: 'SIGKILL'}]);
});

test('FIX9: probes permit zero only and ordinary signal targets reject zero', async t => {
  mockPlatform(t, 'darwin');
  const pid = 910051, sent: (NodeJS.Signals | number | undefined)[] = [];
  t.mock.method(process, 'kill', (_pid: number, signal?: NodeJS.Signals | number) => {sent.push(signal); return true;});
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    assert.deepEqual(await signalIfStillOwned({kind: 'probe', pid}, signal), {status: 'unproven', cleanupPending: true});
  }
  for (const kind of ['pid', 'group'] as const) {
    assert.deepEqual(await signalIfStillOwned({kind, pid}, 0), {status: 'unproven', cleanupPending: true});
  }
  assert.deepEqual(sent, []);
  assert.deepEqual(await signalIfStillOwned({kind: 'probe', pid}, 0), {status: 'sent', cleanupPending: false});
  assert.deepEqual(sent, [0]);
});

test('FIX9: a complete absent row permanently revokes child authority', async t => {
  mockPlatform(t, 'darwin');
  const pid = 910052;
  const authority: SignalChild = {child: {pid, exitCode: null, signalCode: null}};
  t.mock.method(process, 'kill', () => assert.fail('a complete absent row cannot be restored by a later inspection outage'));
  assert.deepEqual(await signalIfStillOwned({kind: 'group', pid}, 'SIGTERM', {
    startedAt: 'original-lifetime', authority, allowChildPidFallback: true, read: () => null,
  }), {status: 'unproven', cleanupPending: true});
  assert.equal(authority.revoked, true);
  assert.deepEqual(await signalIfStillOwned({kind: 'group', pid}, 'SIGKILL', {
    startedAt: 'original-lifetime', authority, allowChildPidFallback: true,
    read: () => {throw new Error('injected inspection outage');},
  }), {status: 'unproven', cleanupPending: true});
});

for (const kind of ['pid', 'group'] as const) test(`FIX15: a changed parent revokes spawned-child ${kind} authority through a later outage`, async t => {
  mockPlatform(t, 'darwin');
  const pid = 910070;
  const authority: SignalChild = {child: {pid, exitCode: null, signalCode: null}, parentPid: process.pid};
  t.mock.method(process, 'kill', () => assert.fail('a different parent disproves the live child handle'));
  assert.deepEqual(await signalIfStillOwned({kind, pid}, 'SIGTERM', {
    startedAt: 'original-lifetime', authority, allowChildPidFallback: true,
    read: () => ({pid, ppid: process.pid + 1, pgid: pid, sid: String(pid), startedAt: 'original-lifetime'}),
  }), {status: 'unproven', cleanupPending: true});
  assert.equal(authority.revoked, true);
  assert.deepEqual(await signalIfStillOwned({kind, pid}, 'SIGKILL', {
    startedAt: 'original-lifetime', authority, allowChildPidFallback: true,
    read: () => {throw new Error('inspection unavailable');},
  }), {status: 'unproven', cleanupPending: true});
});

// Linux uses retained containment and self-group TERM, covered by runner-linux-signal-capability.
for (const platform of ['darwin'] as ('linux' | 'darwin')[]) for (const ending of ['stop', 'deadline', 'natural exit'] as const) {
  test(`FIX15: a spawned child in its own group and session completes ${ending} cleanup on ${platform}`, async t => {
    mockPlatform(t, platform);
    const f = await simulatedGuardian(t);
    f.inspector.sessionGuardian = false;
    const reads: ProcessEntry[] = [];
    f.inspector.inspectSync = pid => {
      const row = f.model.rows.find(value => value.pid === pid);
      if (row) reads.push({...row});
      return row ? {...row} : null;
    };
    f.inspector.signalGroup = (pgid, signal) => {
      assert.equal(pgid, f.root, 'the coherent native row authenticates only the launched child group');
      f.signals.push({target: -pgid, signal, childAlive: f.child.exitCode === null});
      f.model.rows = [];
      f.exit();
    };
    t.mock.timers.enable({apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000});
    try {
      const running = await f.launch({maxRunMinutes: ending === 'deadline' ? 0.001 : 1});
      const result = observe(running.finished);
      if (ending === 'stop') await running.stop('runner_stopped');
      else if (ending === 'deadline') await advanceTime(t, 100);
      else {f.model.rows = []; f.exit();}
      await advanceTime(t, 500);
      const completed = await result;
      assert.equal(completed.ok, true, 'verified disappearance settles finished without a cleanup error');
      assert.equal(completed.value.stopped, ending !== 'natural exit');
      assert.equal(completed.value.failureCode, ending === 'stop' ? 'runner_stopped' : ending === 'deadline' ? 'run_time_limit' : null);
      assert.equal(completed.value.ok, ending === 'natural exit');
      assert(reads.length >= 2, 'startup and the signal boundary use coherent native snapshots');
      assert(reads.every(row => row.pid === f.root && row.ppid === process.pid && row.pgid === f.root && row.sid === String(f.root)));
      assert.deepEqual(f.signals.map(({target, signal}) => ({target, signal})), ending === 'natural exit' ? [] :
        [{target: -f.root, signal: 'SIGTERM'}]);
    } finally {await f.dispose();}
  });
}

// Linux uses retained containment and self-group TERM, covered by runner-linux-signal-capability.
for (const platform of ['darwin'] as ('linux' | 'darwin')[]) {
  test(`FIX16: a verified deadline during pending initial identity returns the stopped handle on ${platform}`, async t => {
    mockPlatform(t, platform);
    const f = await simulatedGuardian(t);
    f.inspector.sessionGuardian = false;
    const entered = deferred(), release = deferred();
    let initial = true;
    const identity = f.inspector.identity;
    f.inspector.identity = async pid => {
      if (initial) {
        initial = false;
        entered.resolve();
        await release.promise;
        return 'late-startup-identity';
      }
      return identity(pid);
    };
    t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
      assert.equal(pid, f.root, 'an unresolved lifetime authorizes only the owned child PID');
      assert.equal(signal, 'SIGTERM');
      f.signals.push({target: pid, signal, childAlive: f.child.exitCode === null});
      f.model.rows = [];
      f.exit();
      return true;
    });
    const started = t.mock.fn(async () => undefined), spawned = t.mock.fn();
    const saved: ProcessGroup[][] = [];
    const input: Buffer[] = [];
    f.child.stdin.on('data', chunk => input.push(chunk));
    t.mock.timers.enable({apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000});
    let settled: {ok: true; value: Awaited<ReturnType<typeof startTool>>} | {ok: false; error: unknown} | undefined;
    const starting = observe(f.launch({maxRunMinutes: 0.001, onStarted: started, onSpawn: spawned,
      onGroups: groups => {saved.push(structuredClone(groups));}})).then(value => {settled = value; return value;});
    try {
      await entered.promise;
      await advanceTime(t, 500);
      assert(settled, 'verified cleanup settles startup without waiting for initial identity or the cap');
      assert.equal(settled.ok, true);
      const running = settled.value, result = await running.finished;
      assert.equal(result.stopped, true);
      assert.equal(result.failureCode, 'run_time_limit');
      assert(saved.some(groups => groups.some(group => group.pgid === f.root && !group.startedAt && group.cleanupPending)),
        'the unresolved spawned group is durable before termination');
      assert(saved.at(-1)?.every(group => !group.cleanupPending), 'verified absence retires the cleanup obligation');
      assert.deepEqual(f.signals.map(({target, signal}) => ({target, signal})), [{target: f.root, signal: 'SIGTERM'}]);
      release.resolve();
      await advanceTime(t, 500);
      assert.equal((await starting), settled);
      assert.equal(await running.finished, result);
      assert.equal(started.mock.callCount(), 0);
      assert.equal(spawned.mock.callCount(), 0);
      assert.deepEqual(input, []);
      assert(saved.every(groups => groups.every(group => group.startedAt !== 'late-startup-identity')),
        'late identity completion cannot resume startup or change its saved lifetime');
    } finally {release.resolve(); await f.dispose();}
  });
}

// Linux uses retained containment and self-group TERM, covered by runner-linux-signal-capability.
for (const platform of ['darwin'] as ('linux' | 'darwin')[]) for (const boundary of ['initial', 'post-save'] as const) {
  test(`FIX15: a native ${boundary} absent snapshot waits for the spawned child's queued natural exit on ${platform}`, async t => {
    mockPlatform(t, platform);
    const f = await simulatedGuardian(t);
    f.inspector.sessionGuardian = false;
    const saved: ProcessGroup[][] = [];
    let reads = 0, pendingExit = false;
    f.inspector.inspectSync = pid => {
      if (++reads === (boundary === 'initial' ? 1 : 2)) {
        assert.equal(f.child.exitCode, null, 'the OS sees the zombie before Node delivers its exit event');
        f.model.rows = [];
        pendingExit = true;
        queueMicrotask(() => f.exit());
        return null;
      }
      const row = f.model.rows.find(value => value.pid === pid);
      return row ? {...row} : null;
    };
    try {
      const running = await f.launch({onGroups: groups => {saved.push(structuredClone(groups));}});
      const result = await running.finished;
      assert.equal(pendingExit, true);
      assert.equal(result.ok, true);
      assert.equal(result.stopped, false);
      assert.equal(result.failureCode, null);
      assert.equal(result.exitCode, 0);
      assert.deepEqual(f.signals, [], 'an absent lifetime is never signalled while awaiting the real exit event');
      assert(saved.at(-1)?.every(group => !group.cleanupPending), 'complete absence retires the initial cleanup obligation');
    } finally {await f.dispose();}
  });
}

// Linux uses retained containment and self-group TERM, covered by runner-linux-signal-capability.
for (const platform of ['darwin'] as ('linux' | 'darwin')[]) {
  test(`FIX9: initial identity rejection plus persistent outage rejects startup within its cap without child close on ${platform}`, async t => {
    mockPlatform(t, platform);
    const f = await simulatedGuardian(t);
    t.mock.timers.enable({apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000});
    const began = deferred();
    let outage = false;
    let settled: {ok: true; value: Awaited<ReturnType<typeof startTool>>} | {ok: false; error: unknown} | undefined;
    const table = f.inspector.table;
    f.inspector.table = async () => {
      if (outage) throw new Error('persistent process inspection outage');
      return table();
    };
    f.inspector.identity = async () => {
      outage = true;
      began.resolve();
      throw new Error('initial identity inspection rejected');
    };
    f.inspector.inspect = async () => {throw new Error('persistent process inspection outage');};
    const starting = observe(f.launch());
    void starting.then(outcome => {settled = outcome;});
    try {
      await began.promise;
      await flush();
      const cleanupStarted = Date.now();
      await advanceTime(t, 20_000);
      assert.ok(settled, 'failed cleanup rejects startup without waiting forever for an absent close event');
      assert.equal(settled.ok, false);
      if (!settled.ok) assert.equal((settled.error as {code?: string}).code, 'tool_failed');
      assert.ok(Date.now() - cleanupStarted <= 20_000, 'startup retains the existing cleanup cap');
      assert.equal(f.child.exitCode, null, 'the fixture supplies no child exit or close during the cleanup budget');
    } finally {
      f.model.rows = []; f.exit();
      await advanceTime(t, 20_000);
      const outcome = await starting;
      if (outcome.ok) await outcome.value.finished.catch(() => undefined);
      await f.dispose();
    }
  });

  test(`FIX9: startup cleans the spawned guardian when post-save identity inspection rejects on ${platform}`, async t => {
    mockPlatform(t, platform);
    const f = await simulatedGuardian(t);
    f.model.rows.push({pid: f.root + 1, ppid: f.root, pgid: f.root, sid: String(f.root), startedAt: 'owned-tool'});
    t.mock.timers.enable({apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000});
    let lookups = 0, reported = false;
    const identity = f.inspector.identity;
    f.inspector.identity = async pid => {
      if (pid === f.root && ++lookups === 2) throw new Error('post-save identity inspection rejected');
      return identity(pid);
    };
    const sendGroup = f.inspector.signalGroup!;
    f.inspector.signalGroup = (pgid, signal) => {
      sendGroup(pgid, signal);
      f.model.rows = [];
      f.exit();
    };
    const starting = observe(f.launch({onSpawn: () => {reported = true;}}));
    try {
      await advanceTime(t, 20_000);
      const outcome = await starting;
      assert.equal(outcome.ok, false, 'the failed startup inspection rejects the launch');
      if (!outcome.ok) assert.match(String(outcome.error), /post-save identity inspection rejected/u);
      assert.equal(reported, false, 'startup never reports this failed launch as ready');
      assert.equal(f.child.exitCode, 0, 'startup waits for the spawned guardian to exit');
      assert.deepEqual(f.signals.map(signal => ({target: signal.target, signal: signal.signal})), [{target: -f.root, signal: 'SIGTERM'}]);
    } finally {
      f.model.rows = []; f.exit();
      await advanceTime(t, 20_000);
      const outcome = await starting;
      if (outcome.ok) await outcome.value.finished.catch(() => undefined);
      await f.dispose();
    }
  });

  test(`FIX9: successful first save cannot adopt a replacement guardian on ${platform}`, async t => {
    mockPlatform(t, platform);
    const f = await simulatedGuardian(t);
    t.mock.timers.enable({apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000});
    const saving = deferred(), release = deferred();
    const snapshots: ProcessGroup[][] = [], reportedStarts: string[] = [];
    let first = true, capturedBeforeSave = false;
    const starting = observe(f.launch({
      onGroups: async groups => {
        snapshots.push(structuredClone(groups));
        if (!first) return;
        first = false;
        capturedBeforeSave = f.samples.includes('guardian-original');
        saving.resolve();
        await release.promise;
      },
      onSpawn: (_pid, startedAt) => {reportedStarts.push(startedAt);},
    }));
    let finished: ReturnType<typeof observe> | undefined;
    try {
      await saving.promise;
      f.exit();
      f.model.rows = [
        {pid: f.root, ppid: 1, pgid: f.root, sid: String(f.root), startedAt: 'guardian-replacement'},
        {pid: f.root + 1, ppid: f.root, pgid: f.root, sid: String(f.root), startedAt: 'replacement-member'},
      ];
      release.resolve();
      await advanceTime(t, 20_000);
      const outcome = await starting;
      if (outcome.ok) {finished = observe(outcome.value.finished); await advanceTime(t, 20_000); await finished;}
      assert.equal(capturedBeforeSave, true, 'the original lifetime is captured before persistence can yield');
      assert.ok(reportedStarts.every(value => value !== 'guardian-replacement'), 'startup never reports the replacement as its child');
      assert.ok(snapshots.every(groups => groups.every(group => group.startedAt !== 'guardian-replacement' &&
        !group.members?.some(member => member.startedAt === 'guardian-replacement' || member.startedAt === 'replacement-member'))),
      'the replacement lifetime and peers never enter the owned ledger');
      assert.deepEqual(f.signals, [], 'neither the replacement PID nor its group receives a signal');
    } finally {
      release.resolve(); f.exit();
      await advanceTime(t, 40_000);
      const outcome = await starting;
      if (outcome.ok) await outcome.value.finished.catch(() => undefined);
      await finished;
      await f.dispose();
    }
  });

  for (const kind of ['SIGTERM', 'SIGKILL'] as const) test(`FIX9: complete-scan ${kind} refuses a guardian that exits during inspection on ${platform}`, async t => {
    mockPlatform(t, platform);
    const f = await simulatedGuardian(t);
    f.model.rows.push({pid: f.root + 1, ppid: f.root, pgid: f.root, sid: String(f.root), startedAt: 'owned-tool'});
    t.mock.timers.enable({apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000});
    const sampled = deferred(), release = deferred();
    let trap = false, paused = false;
    const inspect = f.inspector.inspect!;
    f.inspector.inspect = async pid => {
      const snapshot = await inspect(pid);
      if (trap && !paused && pid === f.root) {
        paused = true;
        assert.equal(f.child.exitCode, null, 'the guardian is live when its row is sampled');
        sampled.resolve();
        await release.promise;
      }
      return snapshot;
    };
    const sendGroup = f.inspector.signalGroup!;
    f.inspector.signalGroup = (pgid, signal) => {
      sendGroup(pgid, signal);
      if (kind === 'SIGKILL' && signal === 'SIGTERM') trap = true;
    };
    const running = await f.launch();
    const finished = observe(running.finished);
    if (kind === 'SIGTERM') trap = true;
    const stopping = observe(running.stop('runner_stopped'));
    try {
      await advanceTime(t, kind === 'SIGKILL' ? 5_100 : 25);
      await sampled.promise;
      f.exit();
      f.model.rows = [
        {pid: f.root, ppid: 1, pgid: f.root, sid: String(f.root), startedAt: 'replacement-guardian'},
        {pid: f.root + 2, ppid: f.root, pgid: f.root, sid: String(f.root), startedAt: 'replacement-peer'},
      ];
      release.resolve();
      await advanceTime(t, 20_000);
      await stopping; await finished;
      assert.equal(paused, true, 'the complete cleanup scan reaches the awaited signal-boundary inspection');
      assert.ok(f.signals.every(signal => signal.childAlive), 'a stale complete scan never signals from an exited child');
      assert.deepEqual(f.signals.filter(signal => signal.target === -f.root).map(signal => signal.signal), kind === 'SIGKILL' ? ['SIGTERM'] : [],
        'only the live guardian can authorize TERM before the KILL race');
    } finally {
      release.resolve(); f.exit();
      await advanceTime(t, 40_000);
      await stopping; await finished;
      await f.dispose();
    }
  });

  test(`FIX9: split lifetime lookup cannot authorize a moved witness group on ${platform}`, async t => {
    mockPlatform(t, platform);
    t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
    const pgid = 910010, member = 910011, unrelated = 910012;
    let present = true, inspected = false, moved = false;
    const groupSignals: number[] = [], pidSignals: number[] = [];
    const memberRow = (): ProcessEntry => ({pid: member, ppid: 1, pgid: moved ? unrelated : pgid});
    const inspector: ProcessInspector = {
      table: async () => [
        ...(present ? [memberRow()] : []),
        {pid: unrelated, ppid: 1, pgid: unrelated, startedAt: 'unrelated-leader'},
      ],
      identity: async pid => {
        if (pid !== member || !present) return pid === unrelated ? 'unrelated-leader' : null;
        if (inspected && !moved) {await flush(); moved = true;}
        return 'owned-member';
      },
      inspect: async pid => {
        if (pid !== member || !present) return null;
        const snapshot = memberRow();
        inspected = true;
        return snapshot;
      },
      fencePids: async () => [],
      signalGroup: pgid => {groupSignals.push(pgid);},
    };
    t.mock.method(process, 'kill', (pid: number) => {pidSignals.push(pid); if (pid === member) present = false; return true;});
    const recovery = observe(recoverProcess(0, '', inspector, undefined,
      [{pgid, startedAt: 'exited-leader', members: [{pid: member, startedAt: 'owned-member'}]}]));
    await advanceTime(t, 20_000);
    const outcome = await recovery;
    assert.equal(outcome.ok, true);
    if (outcome.ok) assert.equal(outcome.value, true);
    assert.equal(moved, true, 'the witness moves while its separate lifetime lookup is awaited');
    assert.deepEqual(groupSignals, [], 'a lifetime lookup cannot complete an older membership snapshot');
    assert.deepEqual(pidSignals, [member], 'the independently revalidated owned lifetime still receives PID cleanup');
  });

  test(`FIX9: a live coherent owned group remains cleanable on ${platform}`, async t => {
    mockPlatform(t, platform);
    t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
    const root = 910020, member = 910021;
    let present = true;
    const rows = [
      {pid: root, ppid: 1, pgid: root, sid: String(root), startedAt: 'owned-leader'},
      {pid: member, ppid: root, pgid: root, sid: String(root), startedAt: 'owned-member'},
    ];
    const groupSignals: {pgid: number; signal: NodeJS.Signals}[] = [];
    const inspector: ProcessInspector & {inspectSync(pid: number): ProcessEntry | null} = {
      table: async () => present ? structuredClone(rows) : [],
      identity: async pid => present ? rows.find(row => row.pid === pid)?.startedAt ?? null : null,
      inspect: async pid => present ? rows.find(row => row.pid === pid) ?? null : null,
      inspectSync: pid => present ? rows.find(row => row.pid === pid) ?? null : null,
      fencePids: async () => [],
      signalGroup: (pgid, signal) => {groupSignals.push({pgid, signal}); present = false;},
    };
    t.mock.method(process, 'kill', () => assert.fail('one verified group signal covers both owned lifetimes'));
    const recovery = observe(recoverProcess(root, 'owned-leader', inspector, undefined,
      [{pgid: root, startedAt: 'owned-leader', members: [{pid: member, startedAt: 'owned-member'}]}]));
    await advanceTime(t, 20_000);
    const outcome = await recovery;
    assert.equal(outcome.ok, true);
    if (outcome.ok) assert.equal(outcome.value, true);
    assert.deepEqual(groupSignals, [{pgid: root, signal: 'SIGTERM'}]);
    assert.equal(present, false);
  });
}
