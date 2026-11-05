import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {access, mkdir, mkdtemp, readFile, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {AdapterRegistry} from '../src/runner/adapters/index.js';
import {PROCESS_CLEANUP_CAP_MS, type ProcessEntry, type ProcessInspector} from '../src/runner/process.js';
import {createRunFolder} from '../src/runner/run-folder.js';
import {RunnerCore, runnerBusy, type RunnerOptions} from '../src/runner/runner.js';
import {RunnerState, type ActiveRun} from '../src/runner/state.js';
import {RunnerStorageOwner} from '../src/runner/storage-owner.js';
import {initializeCleanRunnerJournal, isolateS1DiagnosticRecovery} from './support/runner-journal-fixture.js';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 3000;
  while (!check() && performance.now() < deadline) await flush();
  assert(check(), 'the fixture must progress without extending the mocked cleanup deadline');
}

async function fixture(t: TestContext, diagnostic = false) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-owner-repro-'));
  const data = join(root, 'data'), cwd = join(root, 'work');
  await mkdir(data, {mode: 0o700}); await mkdir(cwd, {mode: 0o700});
  if (diagnostic) isolateS1DiagnosticRecovery(t);
  else await initializeCleanRunnerJournal(data);
  const options: RunnerOptions = {
    data, registry: new AdapterRegistry([]), connections: async () => [], localAgents: async () => [],
    verifiedBuild: async () => true, allowedBuild: async () => true, stageSkills: async () => {},
    deliver: async () => {assert.fail('Unavailable storage must never authorize delivery.');}, removeDeviceKey: async () => {},
  };
  const state = new RunnerState(data); await state.init();
  const runId = randomUUID(), folder = await createRunFolder({cwd, dataDir: data, runId});
  await folder.stageProjectFile({path: 'pending-config', content: 'preserve the observed obligation', kind: 'config'});
  const core = new RunnerCore(options), successor = new RunnerCore({...options, data: `${data}/../data/.`});
  const row: ActiveRun = {runId, agentId: randomUUID(), aiToolId: randomUUID(), pid: 910801,
    startedAt: 'old-root', runDir: folder.runDir, phase: 'running',
    processGroups: [{pgid: 910801, startedAt: 'old-root', cleanupPending: true,
      members: [{pid: 910802, startedAt: 'observed-child'}]}]};
  t.after(async () => {
    t.mock.timers.reset();
    await core.close(); await successor.close(); await folder.release();
    await rm(root, {recursive: true, force: true});
  });
  return {options, core, successor, state, row, cwd};
}

function holdWrite(t: TestContext, core: RunnerCore) {
  const write = core['state'].writeActive.bind(core['state']);
  let resolve!: () => void, reject!: (error: Error) => void;
  const held = new Promise<void>((release, fail) => {resolve = release; reject = fail;});
  const snapshots: ActiveRun[][] = [];
  let writing = 0, maximumWriting = 0;
  t.mock.method(core['state'], 'writeActive', async (rows: ActiveRun[]) => {
    snapshots.push(rows); writing++; maximumWriting = Math.max(maximumWriting, writing);
    try {if (snapshots.length === 1) await held; await write(rows);} finally {writing--;}
  });
  t.after(async () => {resolve(); await core['writes']?.catch(() => {});});
  return {resolve, reject, snapshots, writing: () => writing, maximumWriting: () => maximumWriting};
}

test('S1 P1-4: a timed-out empty publisher bounds every API and stays globally busy after close', {
  skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t), held = holdWrite(t, f.core);
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
  let initError: unknown, disconnectError: unknown, tickDone = false;
  const initial = f.core.init().catch(error => {initError = error;});
  await until(() => held.snapshots.length === 1);
  const loaded = t.mock.method(RunnerState.prototype, 'active');
  assert.deepEqual(held.snapshots[0], [], 'the baseline publisher has no process rows to make busy true accidentally');
  const tick = f.core.tick().then(() => {tickDone = true;});
  const disconnect = f.core.disconnect().catch(error => {disconnectError = error;});
  t.mock.timers.tick(PROCESS_CLEANUP_CAP_MS);
  await until(() => initError !== undefined && disconnectError !== undefined && tickDone);
  await Promise.all([initial, tick, disconnect]);
  assert.equal((initError as {code: string}).code, 'RUNNER_STATE_UNAVAILABLE');
  assert.equal((disconnectError as {code: string}).code, 'RUNNER_STATE_UNAVAILABLE');
  await assert.rejects(f.core.init(), {code: 'RUNNER_STATE_UNAVAILABLE'});
  await f.core.tick();
  await assert.rejects(f.core.disconnect(), {code: 'RUNNER_STATE_UNAVAILABLE'});
  await f.core.close();
  await assert.rejects(f.successor.init(), {code: 'RUNNER_STATE_UNAVAILABLE'});
  assert.equal(loaded.mock.callCount(), 0);
  assert.equal(Date.now(), 1_000_000 + PROCESS_CLEANUP_CAP_MS, 'none of the retry or close calls rejoin the physical writer');
  t.mock.timers.tick(1_000_000); await flush();
  assert.equal(held.writing(), 1, 'the physical write remains unresolved beyond every public deadline');
  assert.equal(f.core.busy, true, 'storage uncertainty remains busy even without a process row');
  assert.equal(runnerBusy(), true, 'unregistering the closed core cannot hide the retained publisher from update gates');
});

for (const outcome of ['success', 'EIO'] as const) {
  test(`S1 ${outcome === 'EIO' ? 'R19 P1-6' : 'P1-5'}: late ${outcome} cannot hand off a newly observed group to stale successor recovery`, {
    skip: process.platform !== 'linux',
  }, async t => {
    const f = await fixture(t, true);
    // Preserve the actual Linux directory owner, kernel lock and publisher.
    // Only after acquisition/replay use Darwin's released observational
    // process backend for this historical S1 observation/write schedule.
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const replay = RunnerStorageOwner.prototype.replayJournal;
    t.mock.method(RunnerStorageOwner.prototype, 'replayJournal', async function(this: RunnerStorageOwner, generation: number) {
      await replay.call(this, generation);
      Object.defineProperty(process, 'platform', {...descriptor, value: 'darwin'});
    });
    t.after(() => Object.defineProperty(process, 'platform', descriptor));
    await f.state.writeActive([f.row]);
    let leaderAlive = true, tables = 0;
    const leader: ProcessEntry = {pid: 910802, ppid: 1, pgid: 910802, sid: '910802', startedAt: 'observed-child'};
    const orphan: ProcessEntry = {pid: 910803, ppid: 1, pgid: 910802, sid: '910802', startedAt: 'environment-cleared-orphan'};
    const current = () => leaderAlive ? [leader] : [orphan];
    f.options.processes = {
      identity: async pid => current().find(row => row.pid === pid)?.startedAt ?? (pid === f.row.pid ? 'replacement-root' : null),
      table: async () => {tables++; return current();}, inspectSync: pid => current().find(row => row.pid === pid) ?? null,
      fencePids: async () => [], signalGroup: () => {assert.fail('An uncommitted discovery must not signal a group.');},
    } satisfies ProcessInspector;
    // Both cores use the same diagnostic view. The orphan has no run fence and
    // no saved identity; only the predecessor's observed group retains it.
    f.successor['options'].processes = f.options.processes;
    t.mock.method(process, 'kill', () => {assert.fail('The fixture must never send a real or simulated PID signal.');});
    const held = holdWrite(t, f.core);
    t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
    let initError: unknown, disconnectError: unknown, tickDone = false;
    const initial = f.core.init().catch(error => {initError = error;});
    await until(() => held.snapshots.length === 1);
    const loaded = t.mock.method(RunnerState.prototype, 'active');
    const observed = f.core['unrecovered'].get(f.row.runId)!;
    assert(observed.processGroups?.some(group => group.pgid === leader.pid && group.cleanupPending),
      'actual recovery must observe and retain the new own-group before the held save');
    assert(!f.row.processGroups?.some(group => group.pgid === leader.pid), 'the old durable snapshot does not contain the new group');
    const disconnect = f.core.disconnect().catch(error => {disconnectError = error;});
    const tick = f.core.tick().then(() => {tickDone = true;});
    t.mock.timers.tick(PROCESS_CLEANUP_CAP_MS);
    await until(() => initError !== undefined && disconnectError !== undefined && tickDone);
    await Promise.all([initial, disconnect, tick]);
    assert.equal((initError as {code: string}).code, 'RUNNER_STATE_UNAVAILABLE');
    assert.equal((disconnectError as {code: string}).code, 'RUNNER_STATE_UNAVAILABLE');
    leaderAlive = false; // Natural fork/exit while the physical observation save is still held.
    await f.core.close();
    await assert.rejects(f.successor.init(), {code: 'RUNNER_STATE_UNAVAILABLE'});
    assert.equal(loaded.mock.callCount(), 0);
    assert.equal(held.writing(), 1);
    const physical = f.core['writes']!;
    if (outcome === 'EIO') {
      const rejected = assert.rejects(physical, {code: 'EIO'});
      held.reject(Object.assign(new Error('fixture late write EIO'), {code: 'EIO'})); await rejected;
      assert.deepEqual(await f.state.active(), [f.row], 'late EIO leaves the older durable ledger unchanged');
    } else {
      held.resolve(); await physical;
      assert((await f.state.active())[0].processGroups?.some(group => group.pgid === leader.pid && group.cleanupPending),
        'late success persists the observation but does not prove extinction');
    }
    // Capture both outcomes before asserting. On the historical EIO path the
    // successor would load old rows and finish idle while orphan remains live.
    let successorError: unknown, successorDone = false;
    // Include reads through the predecessor's retained owner.state as well as
    // every newly constructed state. Exactly one disk-oracle read above was
    // deliberate; physical settlement itself must not hide an extra reload.
    const readsBeforeSuccessor = 1;
    assert.equal(loaded.mock.callCount(), readsBeforeSuccessor, 'physical settlement never reloads through any state instance');
    const previousTables = tables;
    const successor = f.successor.init().catch(error => {successorError = error;}).finally(() => {successorDone = true;});
    await until(() => successorDone || tables > previousTables);
    const settleWindow = performance.now() + 200;
    while (!successorDone && performance.now() < settleWindow) await flush();
    if (!successorDone) t.mock.timers.tick(PROCESS_CLEANUP_CAP_MS);
    await until(() => successorDone); await successor;
    if (loaded.mock.callCount() !== readsBeforeSuccessor) t.diagnostic(JSON.stringify({outcome, successorLoaded: loaded.mock.callCount() - readsBeforeSuccessor,
      successorBusy: f.successor.busy, predecessorBusy: f.core.busy,
      predecessorRetainsObservedGroup: observed.processGroups?.some(group => group.pgid === leader.pid && group.cleanupPending),
      survivor: current()[0].pid}));
    assert.equal(loaded.mock.callCount(), readsBeforeSuccessor, 'no state instance may load disk after the predecessor loses its public waiter');
    assert.equal((successorError as {code?: string} | undefined)?.code, 'RUNNER_STATE_UNAVAILABLE');
    assert.equal(f.core.busy, true);
    assert.equal(runnerBusy(), true, 'the observed cleanup obligation outlives core unregister and physical settlement');
    assert(observed.processGroups?.some(group => group.pgid === leader.pid && group.cleanupPending));
    assert.equal(held.maximumWriting(), 1);
    assert.equal(current()[0], orphan, 'the environment-cleared survivor remains live in the fixture');
    assert.equal(await readFile(join(f.cwd, 'pending-config'), 'utf8'), 'preserve the observed obligation');
    await access(join(f.cwd, '.maddots', 'run.lock'));
  });
}
