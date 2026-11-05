import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {access, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {clock} from '../src/config.js';
import type {Adapter} from '../src/runner/adapter.js';
import {AdapterRegistry} from '../src/runner/adapters/index.js';
import type {MaddotsApi} from '../src/runner/maddots-api.js';
import {ProcessCleanupError, PROCESS_CLEANUP_CAP_MS, type ProcessInspector} from '../src/runner/process.js';
import type {RunnerAgent, RunnerClaim} from '../src/runner/protocol-client.js';
import {createRunFolder} from '../src/runner/run-folder.js';
import {RunnerCore, type RunnerConnection, type RunnerOptions} from '../src/runner/runner.js';
import {RunnerState, type ActiveRun} from '../src/runner/state.js';
import {RunnerStorageOwner} from '../src/runner/storage-owner.js';
import {recoverTestRuns} from '../src/runner/test-run.js';
import {initializeCleanRunnerJournal, isolateS1DiagnosticRecovery} from './support/runner-journal-fixture.js';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean): Promise<void> {
  // Real file I/O needs wall time even while the cleanup clock is frozen.
  const deadline = performance.now() + 2000;
  while (!check() && performance.now() < deadline) await flush();
  assert(check(), 'the pending operation must make progress without advancing its cleanup clock');
}
const never = <T>(): Promise<T> => new Promise(() => {});

function legacyProcessAfterLinuxOwner(t: TestContext): void {
  if (process.platform !== 'linux') return;
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const replay = RunnerStorageOwner.prototype.replayJournal;
  t.mock.method(RunnerStorageOwner.prototype, 'replayJournal', async function(this: RunnerStorageOwner, generation: number) {
    await replay.call(this, generation);
    Object.defineProperty(process, 'platform', {...descriptor, value: 'darwin'});
  });
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
}

function stalledStorage(t: TestContext, core: RunnerCore) {
  const state = core['state'], write = state.writeActive.bind(state);
  let release!: () => void, reject!: (error: Error) => void;
  const held = new Promise<void>((resolve, fail) => {release = resolve; reject = fail;});
  const snapshots: ActiveRun[][] = [];
  let writing = 0, maximumWriting = 0;
  t.mock.method(state, 'writeActive', async (rows: ActiveRun[]) => {
    snapshots.push(rows); writing++; maximumWriting = Math.max(maximumWriting, writing);
    try { if (snapshots.length === 1) await held; await write(rows); }
    finally { writing--; }
  });
  return {release, reject, snapshots, maximumWriting: () => maximumWriting};
}

async function fixture(t: TestContext, diagnostic = true) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-core-cap-'));
  const data = join(root, 'data'), cwd = join(root, 'work');
  await mkdir(data, {mode: 0o700}); await mkdir(cwd, {mode: 0o700});
  if (diagnostic) isolateS1DiagnosticRecovery(t);
  else await initializeCleanRunnerJournal(data);
  const options: RunnerOptions = {
    data, registry: new AdapterRegistry([]), connections: async () => [], localAgents: async () => [],
    verifiedBuild: async () => true, allowedBuild: async () => true, stageSkills: async () => {},
    deliver: async () => {assert.fail('Unverified cleanup must never deliver a result.');}, removeDeviceKey: async () => {},
  };
  const state = new RunnerState(data); await state.init();
  const runId = randomUUID(), folder = await createRunFolder({cwd, dataDir: data, runId});
  await folder.stageProjectFile({path: 'pending-config', content: 'preserve until verified gone', kind: 'config'});
  const row: ActiveRun = {runId, agentId: randomUUID(), aiToolId: randomUUID(), pid: 910801,
    startedAt: 'owned-start', runDir: folder.runDir, phase: 'running', fence: 'a'.repeat(32),
    processGroups: [{pgid: 910801, startedAt: 'owned-start', cleanupPending: true}]};
  const core = new RunnerCore(options);
  t.after(async () => {await core.close(); await folder.release(); await rm(root, {recursive: true, force: true});});
  return {options, state, row, core, cwd, folder};
}

for (const mode of ['preliminary identity', 'sweep after slow identity', 'legacy verification after slow identity'] as const) {
  test(`FIX15: runner recovery shares one cleanup cap with ${mode}`, async t => {
    const f = await fixture(t);
    legacyProcessAfterLinuxOwner(t);
    if (mode.startsWith('legacy')) {
      delete f.row.fence; delete f.row.processGroups;
      f.row.legacyProcessIdentity = true;
      f.row.legacyProcessGroups = [{pgid: f.row.pid, startedAt: f.row.startedAt, cleanupPending: true}];
    }
    await f.state.writeActive([f.row]);
    let identities = 0, tables = 0;
    f.options.processes = {
      identity: async () => {
        identities++;
        if (mode === 'preliminary identity') return never<string | null>();
        if (identities === 1) await new Promise(resolve => setTimeout(resolve, 7000));
        return mode.startsWith('legacy') ? 'replacement-start' : f.row.startedAt;
      },
      table: () => {tables++; return never();}, fencePids: async () => [],
      signalGroup: () => {assert.fail('Incomplete inspection cannot authorize a signal.');},
    } satisfies ProcessInspector;
    const signals = t.mock.method(process, 'kill', () => {assert.fail('Incomplete inspection cannot authorize a PID signal.');});
    t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
    let settled = false;
    const work = f.core.init().then(() => {settled = true;});
    await until(() => identities === 1);
    if (mode !== 'preliminary identity') {
      t.mock.timers.tick(7000); await until(() => tables > 0);
    }
    t.mock.timers.tick(PROCESS_CLEANUP_CAP_MS - (Date.now() - 1_000_000) - 1);
    await flush(); assert.equal(settled, false, 'an unresolved inspection retains recovery until the cap');
    t.mock.timers.tick(1); await until(() => settled); await work;
    assert.equal(Date.now(), 1_000_000 + PROCESS_CLEANUP_CAP_MS);
    assert.equal(f.core.busy, true, 'failed cleanup remains recoverable');
    const saved = (await f.state.active())[0];
    assert.equal(saved.pid, f.row.pid);
    assert(saved.processGroups?.some(group => group.cleanupPending) || saved.legacyProcessGroups?.some(group => group.cleanupPending));
    assert.equal(await readFile(join(f.cwd, 'pending-config'), 'utf8'), 'preserve until verified gone');
    await access(join(f.cwd, '.maddots', 'run.lock'));
    assert.equal(signals.mock.callCount(), 0);
  });
}

for (const stopReason of ['runner_stopped', 'heartbeat_stop', 'run_time_limit'] as const) {
  test(`FIX15: cleanup failure overrides ${stopReason} and retains the recovery obligation`, async t => {
    const f = await fixture(t); await f.core.init();
    f.core['active'].set(f.row.runId, f.row);
    const controller = new AbortController();
    f.core['controllers'].set(f.row.runId, controller);
    const toolFailure = new ProcessCleanupError();
    f.options.startCheck = async ({stop}) => {
      await stop(stopReason);
      // Model the process layer's failed cleanup contract. Core must not
      // relabel it as a normal stop or clear its saved process authority.
      throw toolFailure;
    };
    const claim: RunnerClaim = {runId: f.row.runId, agentId: f.row.agentId, cardId: randomUUID(), boardId: randomUUID(),
      kind: 'assignment', commentId: null, expiresAt: new Date(Date.now() + 60_000).toISOString(),
      model: 'fixture', provider: null, effort: null, maxRunMinutes: 1, skills: []};
    const connection = {aiToolId: f.row.aiToolId, deviceKeyId: randomUUID(), toolVersion: 'fixture'} as RunnerConnection;
    let disposed = false;
    const api = {dispose: () => {disposed = true;}} as unknown as MaddotsApi;
    await f.core['execute'](connection, {agentId: f.row.agentId, aiToolId: f.row.aiToolId, cwd: f.cwd, access: 'folder_only'},
      {} as RunnerAgent, {} as Adapter, claim, api, f.folder, Date.now(), controller);
    assert.equal(disposed, true);
    const pending = (await f.state.pending())[0];
    assert.equal(pending.body.code, 'tool_failed'); assert.equal(pending.body.outcome, 'failed');
    assert.equal(f.core.busy, true);
    const saved = (await f.state.active())[0];
    assert.equal(saved.pid, f.row.pid); assert.equal(saved.fence, f.row.fence);
    assert.equal(saved.processGroups?.[0].cleanupPending, true);
    assert.equal(await readFile(join(f.cwd, 'pending-config'), 'utf8'), 'preserve until verified gone');
    await access(join(f.cwd, '.maddots', 'run.lock'));
  });
}

test('FIX15: diagnostic recovery does not restart its cap for legacy absence verification', async t => {
  const f = await fixture(t);
  // This historical process-table recovery contract is Darwin-only. Linux
  // diagnostic ledgers require journaled containment retirement before scans.
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', {...descriptor, value: 'darwin'});
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
  const cwd = await mkdtemp(join(await realpath(tmpdir()), 'maddots-ai-test-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  const directory = join(f.options.data, 'runner', 'test-processes');
  await mkdir(directory, {mode: 0o700});
  const ledger = join(directory, `${f.row.aiToolId}.json`);
  const row = {format: 1, aiToolId: f.row.aiToolId, cwd, fence: f.row.fence, pid: f.row.pid, startedAt: 'old-start',
    groups: [{pgid: f.row.pid, startedAt: 'old-start'}], legacyProcessIdentity: true,
    legacyProcessGroups: [{pgid: f.row.pid, startedAt: 'old-start', cleanupPending: true}]};
  await writeFile(ledger, JSON.stringify(row), {mode: 0o600});
  let identities = 0, tables = 0;
  const processes: ProcessInspector = {
    identity: async () => {if (++identities === 1) await new Promise(resolve => setTimeout(resolve, 7000)); return null;},
    // The sweep's two coherent tables prove that current groups are absent.
    // The final legacy check is independently required and becomes unavailable.
    table: async () => ++tables <= 2 ? [] : never(), fencePids: async () => [],
    signalGroup: () => {assert.fail('An empty tree must not be signalled.');},
  };
  t.mock.method(process, 'kill', () => {assert.fail('An empty tree must not receive PID signals.');});
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
  // The separate controller lease uses Timing.now, captured before MockTimers.
  // Keep it on this test's same clock without moving the cleanup deadline.
  t.mock.method(clock, 'now', () => Date.now());
  let error: unknown;
  const work = recoverTestRuns({data: f.options.data, processes}).catch(cause => {error = cause;});
  await until(() => identities > 0 || error !== undefined);
  assert.equal(error, undefined, 'the diagnostic ledger must reach process recovery');
  t.mock.timers.tick(7000); await until(() => tables === 3);
  t.mock.timers.tick(PROCESS_CLEANUP_CAP_MS - 7000 - 1); await flush();
  assert.equal(error, undefined);
  t.mock.timers.tick(1); await until(() => error !== undefined); await work;
  assert.equal((error as unknown as {code: string}).code, 'RUNNER_TEST_RECOVERY_UNAVAILABLE');
  assert.equal(Date.now(), 1_000_000 + PROCESS_CLEANUP_CAP_MS);
  const saved = JSON.parse(await readFile(ledger, 'utf8'));
  assert.deepEqual(saved.groups, [], 'the verified current sweep remains recorded');
  assert.deepEqual(saved.legacyProcessGroups, row.legacyProcessGroups, 'legacy candidates survive the unavailable final scan');
  await access(cwd);
});

for (const platform of ['linux', 'darwin'] as const) {
  test(`FIX18: ${platform} a closed runner retains its directory until its timed-out writer physically settles`, async t => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', {...descriptor, value: platform});
    t.after(() => {Object.defineProperty(process, 'platform', descriptor);});
    const f = await fixture(t, false);
    const replacement = new RunnerCore({...f.options, data: `${f.options.data}/../data/.`});
    let release!: () => void;
    const held = new Promise<void>(resolve => {release = resolve;});
    t.after(async () => {release(); await f.core['writes']?.catch(() => {}); await replacement.close();});
    const oldWrite = f.core['state'].writeActive.bind(f.core['state']);
    const newWrite = replacement['state'].writeActive.bind(replacement['state']);
    let writing = 0, maximumWriting = 0;
    const oldSnapshots: ActiveRun[][] = [], newSnapshots: ActiveRun[][] = [];
    t.mock.method(f.core['state'], 'writeActive', async (rows: ActiveRun[]) => {
      oldSnapshots.push(rows); writing++; maximumWriting = Math.max(maximumWriting, writing);
      try {await held; await oldWrite(rows);} finally {writing--;}
    });
    t.mock.method(replacement['state'], 'writeActive', async (rows: ActiveRun[]) => {
      newSnapshots.push(rows); writing++; maximumWriting = Math.max(maximumWriting, writing);
      try {await newWrite(rows);} finally {writing--;}
    });
    const loaded = t.mock.method(replacement['state'], 'active');
    t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
    let initError: unknown, tickDone = false;
    const initial = f.core.init().catch(error => {initError = error;});
    await until(() => oldSnapshots.length === 1);
    assert.deepEqual(oldSnapshots[0], [], 'reproduce the obsolete empty initialization snapshot');
    const tick = f.core.tick().then(() => {tickDone = true;});
    t.mock.timers.tick(PROCESS_CLEANUP_CAP_MS);
    await until(() => initError !== undefined && tickDone); await Promise.all([initial, tick]);
    assert.equal((initError as {code: string}).code, 'RUNNER_STATE_UNAVAILABLE');
    assert.equal(f.core['lastError'], 'RUNNER_STATE_UNAVAILABLE');
    await f.core.close();
    await assert.rejects(replacement.init(), {code: 'RUNNER_STATE_UNAVAILABLE'});
    await replacement.tick();
    assert.equal(replacement['lastError'], 'RUNNER_STATE_UNAVAILABLE');
    assert.equal(Date.now(), 1_000_000 + PROCESS_CLEANUP_CAP_MS, 'close and replacement retries add no unbounded storage wait');
    assert.equal(loaded.mock.callCount(), 0, 'a replacement cannot load a stale ledger before the old physical writer finishes');
    assert.equal(newSnapshots.length, 0);
    assert.equal(writing, 1);
    const other = await fixture(t, false); await other.core.init();
    assert.equal(other.core['initialized'], true, 'a stalled directory does not block another data directory');

    release(); await f.core['writes'];
    await replacement.init();
    replacement['active'].set(f.row.runId, f.row); await replacement['save']();
    assert.deepEqual(await f.state.active(), [f.row]);
    await assert.rejects(f.core.init(), {code: 'RUNNER_STATE_UNAVAILABLE'});
    await assert.rejects(f.core['save'](), {code: 'RUNNER_STATE_UNAVAILABLE'});
    await f.core.close(); await flush();
    assert.deepEqual(await f.state.active(), [f.row], 'the obsolete closed core can never erase the replacement ledger');
    assert.equal(loaded.mock.callCount(), platform === 'linux' ? 0 : 1,
      'Linux handoff reuses retained owner state instead of reloading a potentially stale disk projection');
    assert.equal(maximumWriting, 1, 'physical writers must be exclusive across runner instances');
  });

  test(`FIX17: ${platform} stalled recovery save bounds init, tick, and immediate disconnect`, async t => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', {...descriptor, value: platform});
    t.after(() => {Object.defineProperty(process, 'platform', descriptor);});
    const f = await fixture(t);
    legacyProcessAfterLinuxOwner(t);
    f.row.legacyProcessIdentity = true;
    await f.state.writeActive([f.row]);
    const loaded = t.mock.method(f.core['state'], 'active');
    const logged = t.mock.method(f.core['state'], 'log', () => never<void>());
    const pending = t.mock.method(f.core['state'], 'pending', () => never<[]>());
    let identities = 0, removed = 0;
    f.options.processes = {identity: async () => {identities++; return 'replacement-start';}, table: async () => [], fencePids: async () => [],
      signalGroup: () => {assert.fail('Storage failure must not authorize a process signal.');}};
    f.options.removeDeviceKey = async () => {removed++;};
    t.mock.method(process, 'kill', () => {assert.fail('Storage failure must not authorize a PID signal.');});
    const storage = stalledStorage(t, f.core);
    t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
    let initError: unknown, disconnectError: unknown, tickDone = false;
    const initial = f.core.init().catch(error => {initError = error;});
    await until(() => storage.snapshots.length === 1);
    const disconnect = f.core.disconnect().catch(error => {disconnectError = error;});
    const tick = f.core.tick().then(() => {tickDone = true;});
    t.mock.timers.tick(PROCESS_CLEANUP_CAP_MS - 1); await flush();
    assert.equal(initError, undefined); assert.equal(disconnectError, undefined); assert.equal(removed, 0);
    t.mock.timers.tick(1);
    await until(() => initError !== undefined && disconnectError !== undefined && tickDone);
    await Promise.all([initial, disconnect, tick]);
    assert.equal((initError as unknown as {code: string}).code, 'RUNNER_STATE_UNAVAILABLE');
    assert.equal((disconnectError as unknown as {code: string}).code, 'RUNNER_STATE_UNAVAILABLE');
    assert.equal(f.core['lastError'], 'RUNNER_STATE_UNAVAILABLE');
    assert.equal(Date.now(), 1_000_000 + PROCESS_CLEANUP_CAP_MS);
    assert.equal(removed, 1, 'storage cannot prevent credential removal');
    assert.equal(identities, 0, 'the required save precedes inspection and signals');
    assert.equal(f.core.busy, true);
    assert.deepEqual((await f.state.active())[0], f.row, 'the prior durable recovery obligation remains intact');
    assert.deepEqual(f.core['unrecovered'].get(f.row.runId)?.legacyProcessGroups, f.row.processGroups);
    await access(join(f.cwd, '.maddots', 'run.lock'));
    assert.equal(await readFile(join(f.cwd, 'pending-config'), 'utf8'), 'preserve until verified gone');
    await assert.rejects(f.core.init(), {code: 'RUNNER_STATE_UNAVAILABLE'});
    await f.core.tick();
    assert.equal(storage.snapshots.length, 1, 'retries never replace the unresolved writer');
    assert.equal(loaded.mock.callCount(), 1, 'retries retain the live recovery ledger');
    assert.equal(logged.mock.callCount(), 0, 'known storage failure cannot start another disk wait for logging');
    assert.equal(pending.mock.callCount(), 0, 'known storage failure cannot start another disk wait for finalization');

    logged.mock.restore(); pending.mock.restore();
    storage.release(); await f.core['writes'];
    assert.equal(storage.maximumWriting(), 1);
    assert.equal(storage.snapshots.length, 2, 'the queued latest ledger follows the late original write');
    assert.deepEqual((await f.state.active())[0].legacyProcessGroups, f.row.processGroups);
    await f.core.init();
    assert.equal(loaded.mock.callCount(), 1);
    assert.deepEqual(await f.state.active(), []);
    assert.equal(f.core.busy, false);
    assert.equal(f.core['folders'].size, 0, 'a successful initialization retry releases the old folder reservation');
    assert.equal(f.core['runHomesUnsafe'], false);
  });

  test(`FIX17: ${platform} final initialization save timeout retries without reloading obsolete process authority`, async t => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', {...descriptor, value: platform});
    t.after(() => {Object.defineProperty(process, 'platform', descriptor);});
    const f = await fixture(t);
    delete f.row.fence; delete f.row.processGroups;
    await f.state.writeActive([f.row]);
    let identities = 0;
    f.options.processes = {identity: async () => {identities++; return 'replacement-start';}, table: async () => [], fencePids: async () => []};
    t.mock.method(process, 'kill', () => {assert.fail('A replaced process must not be signalled.');});
    const loaded = t.mock.method(f.core['state'], 'active'), storage = stalledStorage(t, f.core);
    t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
    let error: unknown;
    const initial = f.core.init().catch(cause => {error = cause;});
    await until(() => storage.snapshots.length === 1);
    assert.deepEqual(storage.snapshots[0], []);
    t.mock.timers.tick(PROCESS_CLEANUP_CAP_MS); await until(() => error !== undefined); await initial;
    assert.equal((error as {code: string}).code, 'RUNNER_STATE_UNAVAILABLE');
    await assert.rejects(f.core.init(), {code: 'RUNNER_STATE_UNAVAILABLE'});
    storage.release(); await f.core['writes'];
    await f.core.init();
    assert.equal(identities, 1, 'the obsolete disk PID is never inspected again');
    assert.equal(loaded.mock.callCount(), 1);
    assert.deepEqual(await f.state.active(), []);
    assert.equal(storage.maximumWriting(), 1);
  });
}

test('FIX17: timed-out save keeps an immutable snapshot and serializes the latest recovery obligation', async t => {
  const f = await fixture(t); await f.core.init();
  f.core['unrecovered'].set(f.row.runId, f.row);
  const storage = stalledStorage(t, f.core);
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
  let error: unknown;
  const initial = f.core['save']().catch(cause => {error = cause;});
  await until(() => storage.snapshots.length === 1);
  t.mock.timers.tick(PROCESS_CLEANUP_CAP_MS); await until(() => error !== undefined); await initial;
  f.row.processGroups![0].members = [{pid: 910802, startedAt: 'newly-discovered-start'}];
  await assert.rejects(f.core['save'](), {code: 'RUNNER_STATE_UNAVAILABLE'});
  assert.equal(storage.snapshots[0][0].processGroups![0].members, undefined, 'late mutation cannot change an in-flight snapshot');
  assert.equal(storage.snapshots.length, 1);
  storage.release(); await f.core['writes'];
  assert.equal(storage.maximumWriting(), 1);
  assert.equal(storage.snapshots.length, 2);
  assert.deepEqual((await f.state.active())[0].processGroups![0].members, f.row.processGroups![0].members);
});

test('FIX17: a save at writer completion cannot join an already drained snapshot', async t => {
  const f = await fixture(t); await f.core.init();
  f.core['unrecovered'].set(f.row.runId, f.row);
  const snapshots: ActiveRun[][] = [];
  let next: Promise<void> | undefined;
  t.mock.method(f.core['state'], 'writeActive', (rows: ActiveRun[]) => {
    snapshots.push(rows);
    if (snapshots.length === 1) queueMicrotask(() => queueMicrotask(() => {
      f.row.processGroups![0].members = [{pid: 910802, startedAt: 'completion-boundary-start'}];
      next = f.core['save']();
    }));
    return Promise.resolve();
  });
  await f.core['save'](); await until(() => next !== undefined); await next;
  assert.equal(snapshots.length, 2);
  assert.deepEqual(snapshots[1][0].processGroups![0].members, f.row.processGroups![0].members);
});

for (const platform of ['linux', 'darwin'] as const) {
  test(`FIX17: ${platform} a late write rejection permits initialization retry without losing in-memory recovery obligations`, async t => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', {...descriptor, value: platform});
    t.after(() => {Object.defineProperty(process, 'platform', descriptor);});
    const f = await fixture(t);
    f.row.legacyProcessIdentity = true;
    await f.state.writeActive([f.row]);
    let identities = 0;
    f.options.processes = {identity: () => {identities++; return never();}, table: async () => [], fencePids: async () => []};
    const loaded = t.mock.method(f.core['state'], 'active'), storage = stalledStorage(t, f.core);
    t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
    let error: unknown;
    const initial = f.core.init().catch(cause => {error = cause;});
    await until(() => storage.snapshots.length === 1);
    t.mock.timers.tick(PROCESS_CLEANUP_CAP_MS); await until(() => error !== undefined); await initial;
    const row = f.core['unrecovered'].get(f.row.runId)!;
    row.legacyProcessGroups!.push({pgid: 910802, startedAt: 'discovered-start', cleanupPending: true});
    const lateFailure = assert.rejects(f.core['writes']!, /fixture disk failure/u);
    storage.reject(new Error('fixture disk failure')); await lateFailure;
    let done = false;
    const retry = f.core.init().then(() => {done = true;});
    await until(() => identities > 0);
    t.mock.timers.tick(PROCESS_CLEANUP_CAP_MS); await until(() => done); await retry;
    assert.equal(loaded.mock.callCount(), 1, 'a rejected physical write cannot replace the current ledger with old disk data');
    assert.equal(storage.maximumWriting(), 1);
    assert.deepEqual((await f.state.active())[0].legacyProcessGroups, row.legacyProcessGroups);
    assert.equal(f.core.busy, true);
  });

  test(`FIX17: ${platform} public recovery on an initialized core bounds a stalled discovery save`, async t => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', {...descriptor, value: platform});
    t.after(() => {Object.defineProperty(process, 'platform', descriptor);});
    const f = await fixture(t); await f.core.init();
    f.core['unrecovered'].set(f.row.runId, f.row);
    await f.state.writeActive([f.row]);
    f.options.processes = {identity: async () => f.row.startedAt, table: async () => [], fencePids: async () => []};
    t.mock.method(process, 'kill', () => {assert.fail('A stalled discovery save cannot authorize signalling.');});
    const storage = stalledStorage(t, f.core);
    t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
    let done = false;
    const tick = f.core.tick().then(() => {done = true;});
    await until(() => storage.snapshots.length === 1);
    t.mock.timers.tick(PROCESS_CLEANUP_CAP_MS); await until(() => done); await tick;
    assert.equal(f.core['lastError'], 'RUNNER_STATE_UNAVAILABLE');
    assert.equal(f.core.busy, true);
    await f.core.tick();
    assert.equal(storage.snapshots.length, 1);
    storage.release(); await f.core['writes'];
    assert.equal(storage.maximumWriting(), 1);
    assert.deepEqual(await f.state.active(), [f.row]);
  });
}
