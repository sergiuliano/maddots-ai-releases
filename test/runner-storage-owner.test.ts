import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, realpath, rename, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {AdapterRegistry} from '../src/runner/adapters/index.js';
import {PROCESS_CLEANUP_CAP_MS} from '../src/runner/process.js';
import {createRunFolder, runFolderAvailable} from '../src/runner/run-folder.js';
import {RunnerCore, type RunnerOptions} from '../src/runner/runner.js';
import {RunnerState, type ActiveRun, type PendingOutcome} from '../src/runner/state.js';
import {acquireRunnerStorageLock, type RunnerStorageLock} from '../src/runner/storage-lock.js';
import {RunnerStorageOwner} from '../src/runner/storage-owner.js';
import {initializeCleanRunnerJournal, isolateS1DiagnosticRecovery} from './support/runner-journal-fixture.js';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {resolve = done; reject = fail;});
  return {promise, resolve, reject};
}

function fixture(t: TestContext) {
  const state = new RunnerState('/unused-owner-fixture');
  let releases = 0;
  const lock: RunnerStorageLock = {
    data: state.data, identity: 'fixture-directory', assertCurrent: async () => {},
    directory: async () => {throw new Error('The physical fixture methods must be explicitly instrumented.');},
    release: async () => {releases++;},
  };
  const owner = new RunnerStorageOwner(state, lock, () => {});
  const generation = owner.attach(); owner.stateLoaded = true; owner.initialized = true;
  t.after(() => t.mock.timers.reset());
  return {state, owner, generation, releases: () => releases};
}

test('S1 serializes outcome creation, removal and logging behind the same physical active publisher', async t => {
  const f = fixture(t), held = deferred(), started = deferred(), calls: string[] = [];
  t.mock.method(f.state, 'writeActive', async () => {calls.push('active'); started.resolve(); await held.promise;});
  t.mock.method(f.state, 'queue', async () => {calls.push('queue');});
  t.mock.method(f.state, 'drop', async () => {calls.push('drop');});
  t.mock.method(f.state, 'log', async () => {calls.push('log');});
  const active = f.owner.save(f.generation); await started.promise;
  const queue = f.owner.operation(f.generation, state => state.queue({} as PendingOutcome), true);
  const drop = f.owner.operation(f.generation, state => state.drop(randomUUID()), true);
  const log = f.owner.operation(f.generation, state => state.log(randomUUID(), 'posting', null, 0), true);
  await flush();
  assert.deepEqual(calls, ['active'], 'no other physical mutation runs while active publication remains unresolved');
  assert.equal(f.owner.busy, true);
  held.resolve(); await Promise.all([active, queue, drop, log]); await flush();
  assert.deepEqual(calls, ['active', 'queue', 'drop', 'log']);
  assert.equal(f.owner.busy, false);
  await f.owner.detach(f.generation);
  assert.equal(f.releases(), 1, 'ordinary clean completion permits lock release');
});

for (const outcome of ['success', 'EIO'] as const) {
  test(`S1 a timed-out outcome mutation retains physical ownership through late ${outcome}`, async t => {
    const f = fixture(t), held = deferred(), started = deferred();
    t.mock.method(f.state, 'queue', async () => {started.resolve(); await held.promise;});
    t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
    const call = f.owner.operation(f.generation, state => state.queue({} as PendingOutcome), true);
    const refused = assert.rejects(call, {code: 'RUNNER_STATE_UNAVAILABLE'});
    await started.promise;
    t.mock.timers.tick(PROCESS_CLEANUP_CAP_MS); await refused;
    await f.owner.detach(f.generation);
    assert.equal(f.releases(), 0, 'public timeout and detach cannot release the physical mutation');
    assert.equal(f.owner.busy, true);
    assert.throws(() => f.owner.attach(), {code: 'RUNNER_STATE_UNAVAILABLE'});
    if (outcome === 'EIO') held.reject(Object.assign(new Error('late queue failure'), {code: 'EIO'}));
    else held.resolve();
    await flush(); await flush();
    assert.equal(f.releases(), 0, 'the retained owner cannot release itself from a late continuation');
    if (outcome === 'EIO') {
      assert.equal(f.owner.busy, true, 'a rejected mutation retains uncertainty after physical settlement');
      assert.throws(() => f.owner.attach(), {code: 'RUNNER_STATE_UNAVAILABLE'});
    } else {
      assert.equal(f.owner.busy, false, 'successful physical settlement permits explicit clean memory handoff');
      const successor = f.owner.attach();
      assert.notEqual(successor, f.generation);
      let staleCalls = 0;
      await assert.rejects(f.owner.operation(f.generation, async () => {staleCalls++;}, true), {code: 'RUNNER_STATE_UNAVAILABLE'});
      await assert.rejects(f.owner.save(f.generation), {code: 'RUNNER_STATE_UNAVAILABLE'});
      assert.equal(staleCalls, 0, 'an old callback cannot enter the physical writer after handoff');
      await f.owner.operation(successor, async () => {});
      await f.owner.detach(successor);
      assert.equal(f.releases(), 1, 'a clean explicit handoff retires timeout-only retention and releases the kernel lock');
    }
  });
}

for (const posting of [false, true]) {
test(`S1 successful timed-out publication retires after explicit ${posting ? 'completed posting' : 'empty'} handoff`, async t => {
  const f = fixture(t), held = deferred(), started = deferred(), runId = randomUUID();
  if (posting) f.owner.active.set(runId, {runId, agentId: randomUUID(), aiToolId: randomUUID(), pid: 0,
    startedAt: 'completed-run', runDir: join('/fixture', '.maddots', 'runs', runId), phase: 'posting', fence: 'a'.repeat(32)});
  t.mock.method(f.state, 'writeActive', async () => {started.resolve(); await held.promise;});
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
  const save = f.owner.save(f.generation), refused = assert.rejects(save, {code: 'RUNNER_STATE_UNAVAILABLE'});
  await started.promise;
  const physical = f.owner.writes!;
  t.mock.timers.tick(PROCESS_CLEANUP_CAP_MS); await refused;
  await f.owner.detach(f.generation);
  assert.equal(f.releases(), 0, 'detach cannot release a pending physical publication');
  held.resolve(); await physical; await flush();
  assert.equal(f.owner.busy, false);
  assert.equal(f.owner.unmatchedWrites.length, 0);
  assert.equal(f.releases(), 0, 'physical settlement alone does not perform an implicit handoff');
  const successor = f.owner.attach();
  assert.equal(f.owner.active.size, posting ? 1 : 0, 'completed posting rows transfer with their completion status');
  assert.equal(f.owner.unrecovered.size, 0, 'a completed posting fence does not become a new unresolved process obligation');
  await assert.rejects(f.owner.save(f.generation), {code: 'RUNNER_STATE_UNAVAILABLE'});
  await f.owner.detach(successor);
  assert.equal(f.releases(), 1, 'the explicitly handed-off clean owner releases its kernel lock');
});
}

for (const evidence of ['pid', 'pgid', 'processGroups', 'legacyProcessIdentity', 'unrecoveredFence'] as const) {
test(`S1 a settled timeout cannot retire ${evidence} evidence in a posting row`, async t => {
  const f = fixture(t), held = deferred(), started = deferred(), runId = randomUUID();
  const row: ActiveRun = {runId, agentId: randomUUID(), aiToolId: randomUUID(), pid: 0,
    startedAt: 'unresolved-run', runDir: join('/fixture', '.maddots', 'runs', runId), phase: 'posting'};
  if (evidence === 'pid') row.pid = 900140;
  else if (evidence === 'pgid') row.pgid = 900140;
  else if (evidence === 'processGroups') row.processGroups = [{pgid: 900140, startedAt: 'unresolved-group'}];
  else if (evidence === 'legacyProcessIdentity') row.legacyProcessIdentity = true;
  else row.fence = 'a'.repeat(32);
  (evidence === 'unrecoveredFence' ? f.owner.unrecovered : f.owner.active).set(runId, row);
  t.mock.method(f.state, 'writeActive', async () => {started.resolve(); await held.promise;});
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
  const refused = assert.rejects(f.owner.save(f.generation), {code: 'RUNNER_STATE_UNAVAILABLE'});
  await started.promise;
  const physical = f.owner.writes!;
  t.mock.timers.tick(PROCESS_CLEANUP_CAP_MS); await refused;
  await f.owner.detach(f.generation);
  held.resolve(); await physical; await flush();
  assert.equal(f.owner.busy, true, 'posting does not override retained physical process evidence');
  assert.throws(() => f.owner.attach(), {code: 'RUNNER_STATE_UNAVAILABLE'});
  assert.equal(f.releases(), 0);
});
}

for (const posting of [false, true]) {
test(`S1 clean ${posting ? 'posting' : 'empty'} successor releases the real kernel lock after a successful timeout`, {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-owner-clean-retirement-'));
  const data = join(root, 'data'); await mkdir(data, {mode: 0o700});
  await initializeCleanRunnerJournal(data);
  const options: RunnerOptions = {data, registry: new AdapterRegistry([]), connections: async () => [], localAgents: async () => [],
    verifiedBuild: async () => true, allowedBuild: async () => true, stageSkills: async () => {},
    deliver: async () => {throw new Error('No workload belongs to this storage fixture.');}, removeDeviceKey: async () => {}};
  const core = new RunnerCore(options), successor = new RunnerCore(options), held = deferred(), started = deferred();
  t.after(async () => {held.resolve(); t.mock.timers.reset(); await core.close(); await successor.close(); await rm(root, {recursive: true, force: true});});
  await core.init();
  const runId = randomUUID();
  if (posting) core['active'].set(runId, {runId, agentId: randomUUID(), aiToolId: randomUUID(), pid: 0,
    startedAt: 'completed-run', runDir: join(root, 'work', '.maddots', 'runs', runId), phase: 'posting', fence: 'a'.repeat(32)});
  const write = core['state'].writeActive.bind(core['state']);
  t.mock.method(core['state'], 'writeActive', async (rows: ActiveRun[]) => {started.resolve(); await held.promise; await write(rows);});
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
  const refused = assert.rejects(core['save'](), {code: 'RUNNER_STATE_UNAVAILABLE'});
  await started.promise;
  const physical = core['writes']!;
  t.mock.timers.tick(PROCESS_CLEANUP_CAP_MS); await refused; await core.close();
  held.resolve(); await physical; await flush(); t.mock.timers.reset();
  const load = t.mock.method(RunnerState.prototype, 'active');
  await successor.init();
  assert.equal(load.mock.callCount(), 0, 'a settled clean handoff keeps the authoritative memory without any reload');
  assert.equal(successor.busy, false);
  await successor.close();
  const lock = await acquireRunnerStorageLock(data, undefined, Date.now() + 500);
  await lock.release();
});
}

test('S1 failed active publication retains an immutable unmatched snapshot after later success', async t => {
  const f = fixture(t), runId = randomUUID();
  const row: ActiveRun = {runId, agentId: randomUUID(), aiToolId: randomUUID(), pid: 900123,
    startedAt: 'fixture-start', runDir: join('/fixture', '.maddots', 'runs', runId), phase: 'running',
    processGroups: [{pgid: 900124, startedAt: 'observed-child', cleanupPending: true}]};
  f.owner.unrecovered.set(runId, row);
  let calls = 0;
  t.mock.method(f.state, 'writeActive', async () => {
    if (++calls === 1) throw Object.assign(new Error('rename or sync uncertainty'), {code: 'EIO'});
  });
  await assert.rejects(f.owner.save(f.generation), {code: 'EIO'});
  row.pid = 0; delete row.processGroups;
  f.owner.unrecovered.delete(runId);
  await f.owner.save(f.generation); await flush();
  assert.equal(calls, 2);
  assert.equal(f.owner.unmatchedWrites.length, 1);
  assert.equal(f.owner.unmatchedWrites[0].rows[0].pid, 900123);
  assert.equal(f.owner.unmatchedWrites[0].rows[0].processGroups![0].pgid, 900124);
  assert.equal(f.owner.busy, true, 'a later empty projection cannot retire unmatched evidence');
  await f.owner.detach(f.generation);
  assert.equal(f.releases(), 0);
  assert.throws(() => f.owner.attach(), {code: 'RUNNER_STATE_UNAVAILABLE'});
});

test('S1 settling one timed-out publisher cannot clear another timed-out physical mutation', async t => {
  const f = fixture(t), active = deferred(), activeStarted = deferred(), queue = deferred(), queueStarted = deferred();
  t.mock.method(f.state, 'writeActive', async () => {activeStarted.resolve(); await active.promise;});
  t.mock.method(f.state, 'queue', async () => {queueStarted.resolve(); await queue.promise;});
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
  const writing = f.owner.save(f.generation);
  const refusedWrite = assert.rejects(writing, {code: 'RUNNER_STATE_UNAVAILABLE'});
  await activeStarted.promise;
  const outcome = f.owner.operation(f.generation, state => state.queue({} as PendingOutcome), true);
  const refusedOutcome = assert.rejects(outcome, {code: 'RUNNER_STATE_UNAVAILABLE'});
  t.mock.timers.tick(PROCESS_CLEANUP_CAP_MS); await Promise.all([refusedWrite, refusedOutcome]);
  active.resolve(); await queueStarted.promise; await flush();
  try {
    assert.equal(f.owner.unavailable, true, 'the second physical mutation remains timed out after active publication settles');
  } finally {queue.resolve(); await flush(); await flush();}
});

test('S1 rename success followed by directory sync EIO retains the owner and prevents stale reload', {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-owner-sync-eio-'));
  const data = join(root, 'data'); await mkdir(data, {mode: 0o700});
  await initializeCleanRunnerJournal(data);
  const options: RunnerOptions = {data, registry: new AdapterRegistry([]), connections: async () => [], localAgents: async () => [],
    verifiedBuild: async () => true, allowedBuild: async () => true, stageSkills: async () => {},
    deliver: async () => {throw new Error('No workload belongs to this storage fixture.');}, removeDeviceKey: async () => {}};
  const core = new RunnerCore(options), successor = new RunnerCore(options);
  t.after(async () => {await core.close(); await successor.close(); await rm(root, {recursive: true, force: true});});
  await core.init();
  const owner = core['owner']!, directory = await owner['lock'].directory('runner');
  const sync = directory.sync.bind(directory);
  t.mock.method(directory, 'sync', async () => {
    await sync(); throw Object.assign(new Error('fixture acknowledgment failure after rename'), {code: 'EIO'});
  });
  const runId = randomUUID();
  const row: ActiveRun = {runId, agentId: randomUUID(), aiToolId: randomUUID(), pid: 900126,
    startedAt: 'newly-observed-run', runDir: join(root, 'work', '.maddots', 'runs', runId), phase: 'running'};
  core['active'].set(runId, row);
  await assert.rejects(core['save'](), {code: 'EIO'});
  assert.deepEqual(await new RunnerState(data).active(), [row], 'the rename published before its acknowledgment failed');
  assert.equal(owner.unmatchedWrites.length, 1);
  assert.deepEqual(owner.unmatchedWrites[0].rows, [row]);
  await core.close();
  assert.equal(core.busy, true);
  const load = t.mock.method(RunnerState.prototype, 'active');
  await assert.rejects(successor.init(), {code: 'RUNNER_STATE_UNAVAILABLE'});
  assert.equal(load.mock.callCount(), 0, 'a replacement core cannot reinterpret an ambiguous commit by reloading disk');
  await assert.rejects(acquireRunnerStorageLock(data, undefined, Date.now() + 100), {code: 'HELPER_BUSY'});
});

for (const retryRelease of [false, true]) {
test(`S1 normal memory handoff retains the RunFolder capability${retryRelease ? ' across a failed release and another handoff' : ' until successor recovery releases it'}`, {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-owner-folder-handoff-'));
  const data = join(root, 'data'), cwd = join(root, 'work');
  await mkdir(data, {mode: 0o700}); await mkdir(cwd, {mode: 0o700});
  isolateS1DiagnosticRecovery(t);
  const options: RunnerOptions = {data, registry: new AdapterRegistry([]), connections: async () => [], localAgents: async () => [],
    verifiedBuild: async () => true, allowedBuild: async () => true, stageSkills: async () => {},
    processes: {identity: async () => 'replacement-lifetime', table: async () => []},
    deliver: async () => {throw new Error('No workload belongs to this storage fixture.');}, removeDeviceKey: async () => {}};
  const core = new RunnerCore(options), successor = new RunnerCore(options), retry = new RunnerCore(options), runId = randomUUID();
  const folder = await createRunFolder({cwd, dataDir: data, runId});
  t.after(async () => {await core.close(); await successor.close(); await retry.close(); await folder.release(); await rm(root, {recursive: true, force: true});});
  await core.init();
  const originalRelease = folder.release.bind(folder);
  let releases = 0;
  const release = t.mock.method(folder, 'release', async () => {
    if (++releases === 1 && retryRelease) throw new Error('fixture transient folder release failure');
    await originalRelease();
  });
  const row: ActiveRun = {runId, agentId: randomUUID(), aiToolId: randomUUID(), pid: 900127,
    startedAt: 'original-lifetime', runDir: folder.runDir, phase: 'running'};
  core['unrecovered'].set(runId, row); core['recoveryFolders'].set(runId, folder); core['folders'].add(cwd);
  await core['save'](); await core.close();
  assert.equal(release.mock.callCount(), 0, 'closing a core cannot release an unresolved run folder');
  assert.equal(await runFolderAvailable(cwd), false);
  const load = t.mock.method(RunnerState.prototype, 'active');
  await successor.init();
  assert.equal(load.mock.callCount(), 0, 'normal handoff uses retained owner evidence instead of reloading disk');
  assert.equal(release.mock.callCount(), 1, 'successor recovery uses the exact held capability');
  if (retryRelease) {
    assert.equal(successor.busy, false, 'verified process cleanup leaves only a folder obligation');
    assert.equal(await runFolderAvailable(cwd), false);
    await successor.close();
    await retry.init();
    assert.equal(load.mock.callCount(), 0, 'a folder-only owner still hands off its retained capability without any state reload');
    assert.equal(release.mock.callCount(), 2);
    assert.equal(retry.busy, false);
  }
  assert.equal(await runFolderAvailable(cwd), true, 'the old process-local reservation cannot strand the recovered folder');
  assert.equal(successor.busy, false);
});
}

test('S1 replacing a directory during a held core publication cannot erase a replacement owner ledger', {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-owner-replacement-'));
  const data = join(root, 'data'); await mkdir(data, {mode: 0o700});
  await initializeCleanRunnerJournal(data);
  const options: RunnerOptions = {data, registry: new AdapterRegistry([]), connections: async () => [], localAgents: async () => [],
    verifiedBuild: async () => true, allowedBuild: async () => true, stageSkills: async () => {},
    deliver: async () => {throw new Error('No workload belongs to this storage fixture.');}, removeDeviceKey: async () => {}};
  const core = new RunnerCore(options), held = deferred(), started = deferred();
  const replacementLocks: RunnerStorageLock[] = [];
  t.after(async () => {
    held.resolve(); await core['writes']?.catch(() => {});
    await core.close(); await Promise.all(replacementLocks.map(lock => lock.release())); await rm(root, {recursive: true, force: true});
  });
  await core.init();
  const state = core['state'], publish = state.writeActive.bind(state);
  t.mock.method(state, 'writeActive', async (rows: ActiveRun[]) => {started.resolve(); await held.promise; await publish(rows);});
  const publication = core['save']();
  const refused = assert.rejects(publication, {code: 'RUNNER_STATE_UNAVAILABLE'});
  await started.promise;
  await rename(data, join(root, 'original')); await mkdir(data, {mode: 0o700});
  replacementLocks.push(await acquireRunnerStorageLock(data));
  const replacement = new RunnerState(data); await replacement.init();
  const runId = randomUUID();
  const row: ActiveRun = {runId, agentId: randomUUID(), aiToolId: randomUUID(), pid: 900125,
    startedAt: 'replacement-live-run', runDir: join(root, 'work', '.maddots', 'runs', runId), phase: 'running'};
  await replacement.writeActive([row]);
  held.resolve(); await refused;
  assert.deepEqual(await replacement.active(), [row], 'the old empty publisher cannot touch the replacement directory');
  assert.equal(core.busy, true, 'detected storage replacement remains unresolved');
});

for (const terminal of ['success', 'EIO'] as const) {
test(`S1 cleanup bookkeeping after bounded close ${terminal === 'success' ? 'persists before owner release' : 'retains failed terminal publication'}`, {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-owner-late-cleanup-'));
  const data = join(root, 'data'); await mkdir(data, {mode: 0o700});
  await initializeCleanRunnerJournal(data);
  const options: RunnerOptions = {data, registry: new AdapterRegistry([]), connections: async () => [], localAgents: async () => [],
    verifiedBuild: async () => true, allowedBuild: async () => true, stageSkills: async () => {},
    deliver: async () => {throw new Error('Closed admission cannot deliver.');}, removeDeviceKey: async () => {}};
  const core = new RunnerCore(options), successor = new RunnerCore(options);
  const cycleHeld = deferred(), cleanupHeld = deferred(), runId = randomUUID();
  const controller = new AbortController();
  const cleanupJobs: Promise<void>[] = [];
  let cleanupError: unknown;
  t.after(async () => {
    cycleHeld.resolve(); cleanupHeld.resolve(); t.mock.timers.reset();
    await Promise.all(cleanupJobs); await core.close(); await successor.close(); await rm(root, {recursive: true, force: true});
  });
  await core.init();
  const owner = core['owner']!, state = core['state'];
  const row: ActiveRun = {runId, agentId: randomUUID(), aiToolId: randomUUID(), pid: 900130,
    startedAt: 'original-run', runDir: join(root, 'work', '.maddots', 'runs', runId), phase: 'running'};
  core['active'].set(runId, row); core['controllers'].set(runId, controller); await core['save']();
  const write = state.writeActive.bind(state), snapshots: ActiveRun[][] = [];
  t.mock.method(state, 'writeActive', async (rows: ActiveRun[]) => {
    snapshots.push(structuredClone(rows));
    if (terminal === 'EIO' && rows[0]?.phase === 'posting') throw Object.assign(new Error('late terminal write failure'), {code: 'EIO'});
    await write(rows);
  });
  const cycling = cycleHeld.promise.finally(() => {core['cycling'] = undefined; core['releaseStorage']();});
  core['cycling'] = cycling;
  // This is an already accepted cleanup job. Its owner token remains valid
  // after the bounded public close, until the job's actual finalizer detaches.
  const cleanup = (async () => {
    await cleanupHeld.promise;
    core['assertStorageGeneration']();
    row.processGroups = [{pgid: 900131, startedAt: 'late-observed-child', cleanupPending: true}];
    await core['save']();
    row.pid = 0; delete row.processGroups; row.phase = 'posting';
    await core['save']();
  })().catch(error => {cleanupError = error;}).finally(() => {
    core['jobs'].delete(runId); core['controllers'].delete(runId); core['releaseStorage']();
  });
  cleanupJobs.push(cleanup);
  core['jobs'].set(runId, cleanup);
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
  const close = core.close(); await flush();
  assert.equal(controller.signal.aborted, true, 'close seals admission before waiting on a held cycle');
  t.mock.timers.tick(PROCESS_CLEANUP_CAP_MS); await close;
  assert.equal(core['closeFinished'], true);
  assert.equal(core.busy, true);
  const load = t.mock.method(RunnerState.prototype, 'active');
  await assert.rejects(successor.init(), {code: 'RUNNER_STATE_UNAVAILABLE'});
  assert.equal(load.mock.callCount(), 0);
  cycleHeld.resolve(); await cycling;
  cleanupHeld.resolve(); await cleanup; await flush();
  assert.equal(snapshots.length, 2, 'both post-close observation and terminal projection reach their retained owner');
  assert.equal(snapshots[0][0].processGroups![0].pgid, 900131);
  assert.throws(() => core['assertStorageGeneration'](), {code: 'RUNNER_STATE_UNAVAILABLE'},
    'the generation is revoked only after its accepted cleanup job settles');
  const persisted = await new RunnerState(data).active();
  assert.equal(load.mock.callCount(), 1, 'only the explicit disk oracle reads during cleanup settlement');
  if (terminal === 'success') {
    assert.equal(cleanupError, undefined);
    assert.equal(persisted[0].pid, 0); assert.equal(persisted[0].phase, 'posting');
    assert.equal(persisted[0].processGroups, undefined);
    assert.equal(core.busy, false);
  } else {
    assert.equal((cleanupError as {code?: string}).code, 'EIO');
    assert.equal(persisted[0].processGroups![0].pgid, 900131);
    assert.equal(owner.unmatchedWrites.length, 1);
    assert.equal(core.busy, true, 'failed terminal acknowledgment cannot become a clean owner release');
    await assert.rejects(successor.init(), {code: 'RUNNER_STATE_UNAVAILABLE'});
    assert.equal(load.mock.callCount(), 1);
  }
});
}
