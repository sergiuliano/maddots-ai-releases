import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import * as filesystem from 'node:fs/promises';
import {access, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile} from 'node:fs/promises';
import {createRequire, syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test, {type TestContext} from 'node:test';
import {AdapterRegistry} from '../src/runner/adapters/index.js';
import {initializeCleanJournal, RunnerJournal, type JournalContext} from '../src/runner/journal.js';
import {PROCESS_CLEANUP_CAP_MS} from '../src/runner/process.js';
import {RunnerCore, runnerBusy, type RunnerOptions} from '../src/runner/runner.js';
import {createRunFolder} from '../src/runner/run-folder.js';
import {RunnerState, type ActiveRun} from '../src/runner/state.js';
import {acquireRunnerStorageLock} from '../src/runner/storage-lock.js';
import {directFixtureProcesses} from './native-process-fixture.js';

const workerPath = fileURLToPath(new URL('./runner-core-journal-worker.ts', import.meta.url));
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
async function simulatedUntil(check: () => boolean) {
  const deadline = performance.now() + 5000;
  while (!check() && performance.now() < deadline) await flush();
  assert(check(), 'fixture progress must not require extending the public mocked deadline');
}
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {resolve = done; reject = fail;});
  return {promise, resolve, reject};
}
function coreOptions(data: string): RunnerOptions {
  return {data, registry: new AdapterRegistry([]), connections: async () => [], localAgents: async () => [],
    verifiedBuild: async () => true, allowedBuild: async () => true, stageSkills: async () => {}, removeDeviceKey: async () => {},
    deliver: async () => {assert.fail('The durability fixture cannot authorize delivery.');}};
}
async function until(check: () => boolean | Promise<boolean>, description: string) {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {if (await check()) return; await sleep(5);}
  assert.fail(`Timed out waiting for ${description}.`);
}
const exists = async (path: string) => {try {await access(path); return true;} catch {return false;}};
async function seedJournal(data: string, runId?: string) {
  const lock = await acquireRunnerStorageLock(data);
  try {
    const directory = await lock.directory('runner');
    const context: JournalContext = {directoryIdentity: lock.identity,
      bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(), ownerEpoch: randomUUID(), generation: 1,
      isCurrent: () => true, completionScope: 'full-run', contractVersion: 1};
    await initializeCleanJournal(directory, context);
    const journal = new RunnerJournal(directory, context);
    await journal.replay(); await journal.establishEpoch();
    if (runId) await journal.intent({runId, incarnation: randomUUID()});
  } finally {await lock.release();}
}
async function cleanFixture(t: TestContext) {
  const data = await mkdtemp(join(await realpath(tmpdir()), 'mdai-journal-owner-'));
  await seedJournal(data);
  const core = new RunnerCore(coreOptions(data)), successor = new RunnerCore(coreOptions(`${data}/../${data.split('/').at(-1)}/.`));
  t.after(async () => {
    t.mock.timers.reset(); await core.close(); await successor.close();
    await rm(data, {recursive: true, force: true});
  });
  return {data, core, successor};
}
function worker(mode: 'observe' | 'replay', data: string, leader = 0) {
  const environment = {...process.env}; delete environment.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['--import', 'tsx', workerPath, mode, data, String(leader)],
    {stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: environment});
  let stderr = '', exited = false, exitCode: number | null = null;
  const replies: Record<string, unknown>[] = [];
  child.stderr!.on('data', value => {stderr += String(value);});
  child.on('message', value => {replies.push(value as Record<string, unknown>);});
  const exit = new Promise<void>(resolve => {child.on('exit', code => {exitCode = code; exited = true; resolve();});});
  return {child, exit, exited: () => exited, reply: async (kind: string) => {
    await until(() => {
      const failure = replies.find(reply => reply.kind === 'fixture-error');
      if (failure) assert.fail(String(failure.failure));
      if (exited && !replies.some(reply => reply.kind === kind)) assert.fail(`Isolated helper exited (${exitCode}): ${stderr}`);
      return replies.some(reply => reply.kind === kind);
    }, `isolated helper ${kind}`);
    return replies.find(reply => reply.kind === kind)!;
  }, assertExit: () => assert.equal(exitCode, 0, stderr)};
}

for (const oldProjection of ['missing', 'empty'] as const) test(`S2 migration: ${oldProjection} old projection without initialized manifest remains unavailable and busy`, {
  skip: process.platform !== 'linux',
}, async t => {
  const data = await mkdtemp(join(await realpath(tmpdir()), 'mdai-journal-unknown-'));
  const state = new RunnerState(data); await state.init();
  if (oldProjection === 'empty') await state.writeActive([]);
  const core = new RunnerCore({data, registry: new AdapterRegistry([]),
    connections: async () => [], localAgents: async () => [], verifiedBuild: async () => true,
    allowedBuild: async () => true, stageSkills: async () => {}, removeDeviceKey: async () => {},
    deliver: async () => {assert.fail('Unknown migration state cannot authorize delivery.');}});
  t.after(async () => {await core.close(); await rm(data, {recursive: true, force: true});});
  let error: unknown;
  await core.init().catch(value => {error = value;});
  t.diagnostic(JSON.stringify({oldProjection, error: (error as {code?: string} | undefined)?.code ?? null, busy: core.busy}));
  assert.equal((error as {code?: string} | undefined)?.code, 'RUNNER_STATE_UNAVAILABLE',
    'an empty projection cannot prove the old controller lost no obligation');
  assert.equal(core.busy, true);
});

test('S2 valid empty journal permits initialization but keeps production Linux claims closed without S3', {
  skip: process.platform !== 'linux',
}, async t => {
  const f = await cleanFixture(t);
  let connectionReads = 0, agentReads = 0;
  f.core['options'].connections = async () => {connectionReads++; return [];};
  f.core['options'].localAgents = async () => {agentReads++; return [];};
  await f.core.init(); assert.equal(f.core.busy, false);
  await f.core.tick();
  assert.equal(f.core['lastError'], 'LINUX_CONTAINMENT_UNAVAILABLE');
  assert.equal(connectionReads, 0, 'the closed production barrier precedes heartbeat and claim processing');
  assert.equal(agentReads, 0);
});

test('S2 simulated Darwin retains legacy empty-state initialization without a Linux manifest', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', {...descriptor, value: 'darwin'});
  const data = await mkdtemp(join(await realpath(tmpdir()), 'mdai-journal-darwin-'));
  const core = new RunnerCore(coreOptions(data));
  t.after(async () => {
    try {await core.close(); await rm(data, {recursive: true, force: true});}
    finally {Object.defineProperty(process, 'platform', descriptor);}
  });
  await core.init(); assert.equal(core.busy, false);
  await core.tick(); assert.equal(core['lastError'], null);
  await assert.rejects(access(join(data, 'runner', 'journal-manifest.json')), {code: 'ENOENT'});
});

for (const heldAt of ['directory', 'lock'] as const) for (const saved of (heldAt === 'lock' ?
  ['clean', 'unresolved', 'missing', 'replacement'] as const : ['clean', 'unresolved', 'missing'] as const)) test(`S2 closed core retains held initial ${heldAt} acquisition uncertainty until ${saved} successor replay`, {
  skip: process.platform !== 'linux',
}, async t => {
  const data = await mkdtemp(join(await realpath(tmpdir()), 'mdai-journal-acquisition-'));
  if (saved !== 'missing') await seedJournal(data, saved === 'unresolved' ? randomUUID() : undefined);
  const core = new RunnerCore(coreOptions(data)), held = deferred(), reached = deferred(), descriptorClosed = deferred();
  const fsp = createRequire(import.meta.url)('node:fs/promises') as typeof filesystem;
  const originalRealpath = fsp.realpath, originalOpen = fsp.open;
  let resolutions = 0, watchedDescriptor = false;
  const successor = new RunnerCore(coreOptions(data)), moved = `${data}-original`;
  const original = new RunnerCore(coreOptions(moved));
  fsp.realpath = (async (...args: Parameters<typeof originalRealpath>) => {
    if (String(args[0]) === data && ++resolutions === (heldAt === 'directory' ? 1 : 3)) {
      reached.resolve(); await held.promise;
    }
    return originalRealpath(...args);
  }) as typeof originalRealpath;
  fsp.open = (async (...args: Parameters<typeof originalOpen>) => {
    const file = await originalOpen(...args);
    if (!watchedDescriptor && String(args[0]) === data) {
      watchedDescriptor = true; const close = file.close.bind(file);
      file.close = async () => {await close(); descriptorClosed.resolve();};
    }
    return file;
  }) as typeof originalOpen;
  syncBuiltinESMExports();
  t.after(async () => {
    held.resolve(); t.mock.timers.reset(); await initial.catch(() => {});
    fsp.realpath = originalRealpath; fsp.open = originalOpen; syncBuiltinESMExports();
    await core.close(); await successor.close(); await original.close();
    await rm(data, {recursive: true, force: true}); await rm(moved, {recursive: true, force: true});
  });
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
  const initial = core.init(); void initial.catch(() => {});
  await reached.promise;
  if (saved === 'replacement') {
    await rename(data, moved); await mkdir(data, {mode: 0o700}); await seedJournal(data);
  }
  assert.equal(runnerBusy(data), true);
  await core.close();
  assert.equal(runnerBusy(data), true, 'closing before owner acquisition must retain global initialization uncertainty');
  const refused = assert.rejects(initial, {code: 'RUNNER_STATE_UNAVAILABLE'});
  t.mock.timers.tick(PROCESS_CLEANUP_CAP_MS); await refused;
  await core.tick(); await core.close();
  assert.equal(runnerBusy(data), true, 'public timeout cannot release the physical acquisition reservation');
  held.resolve(); await descriptorClosed.promise;
  await flush(); await flush();
  assert.equal(runnerBusy(data), true, 'a closed unused directory FD does not prove old durable obligations clean');
  fsp.realpath = originalRealpath; fsp.open = originalOpen; syncBuiltinESMExports();
  t.mock.timers.reset();
  if (saved === 'clean' || saved === 'replacement') {
    await successor.init(); await successor.close();
    if (saved === 'replacement') {
      assert.equal(runnerBusy(data), true, 'a different directory at the same pathname cannot discharge original uncertainty');
      await original.init(); await original.close();
    }
    assert.equal(runnerBusy(data), false, 'successful durable successor replay discharges the acquisition uncertainty');
  } else {
    await assert.rejects(successor.init(), {code: 'RUNNER_STATE_UNAVAILABLE'}); await successor.close();
    assert.equal(runnerBusy(data), true, 'missing or unresolved journal evidence survives both closed cores');
  }
});

test('S2 failed preparation without retained identity cannot be cleared by replaying a retargeted alias', {
  skip: process.platform !== 'linux',
}, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-journal-unidentified-'));
  const a = join(root, 'a'), b = join(root, 'b'), alias = join(root, 'alias');
  await mkdir(a, {mode: 0o700}); await mkdir(b, {mode: 0o700});
  await seedJournal(a, randomUUID()); await seedJournal(b); await symlink(a, alias);
  const first = new RunnerCore(coreOptions(alias)), successor = new RunnerCore(coreOptions(alias));
  const fsp = createRequire(import.meta.url)('node:fs/promises') as typeof filesystem;
  const original = fsp.realpath; let armed = true;
  fsp.realpath = (async (...args: Parameters<typeof original>) => {
    if (armed && String(args[0]) === alias) {
      armed = false; throw Object.assign(new Error('initial directory lookup unavailable'), {code: 'EIO'});
    }
    return original(...args);
  }) as typeof original;
  syncBuiltinESMExports();
  t.after(async () => {
    fsp.realpath = original; syncBuiltinESMExports();
    await first.close(); await successor.close(); await rm(root, {recursive: true, force: true});
  });
  await assert.rejects(first.init(), {code: 'RUNNER_STATE_UNAVAILABLE'}); await first.close();
  assert.equal(runnerBusy(alias), true);
  await unlink(alias); await symlink(b, alias);
  await successor.init(); await successor.close();
  assert.equal(runnerBusy(alias), true, 'a pathname-only proof cannot identify the unread predecessor directory');
});

for (const outcome of ['success', 'EIO'] as const) test(`S2 P1-4: held durable epoch acknowledgment bounds every API and late ${outcome} cannot reopen admission`, {
  skip: process.platform !== 'linux',
}, async t => {
  const f = await cleanFixture(t), held = deferred();
  let reached = false, physical = 0, maximumPhysical = 0;
  const establish = RunnerJournal.prototype.establishEpoch;
  t.mock.method(RunnerJournal.prototype, 'establishEpoch', async function(this: RunnerJournal) {
    physical++; maximumPhysical = Math.max(maximumPhysical, physical);
    try {await establish.call(this); reached = true; await held.promise;} finally {physical--;}
  });
  const loaded = t.mock.method(RunnerState.prototype, 'active');
  t.after(async () => {held.resolve(); await f.core['owner']?.['tail'];});
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
  let initError: unknown, disconnectError: unknown, tickDone = false;
  const initial = f.core.init().catch(error => {initError = error;});
  await simulatedUntil(() => reached);
  const tick = f.core.tick().then(() => {tickDone = true;});
  const disconnect = f.core.disconnect().catch(error => {disconnectError = error;});
  t.mock.timers.tick(PROCESS_CLEANUP_CAP_MS);
  await simulatedUntil(() => initError !== undefined && disconnectError !== undefined && tickDone);
  await Promise.all([initial, tick, disconnect]);
  assert.equal((initError as {code: string}).code, 'RUNNER_STATE_UNAVAILABLE');
  assert.equal((disconnectError as {code: string}).code, 'RUNNER_STATE_UNAVAILABLE');
  await assert.rejects(f.core.init(), {code: 'RUNNER_STATE_UNAVAILABLE'});
  await f.core.tick(); await f.core.close();
  await assert.rejects(f.successor.init(), {code: 'RUNNER_STATE_UNAVAILABLE'});
  assert.equal(loaded.mock.callCount(), 0, 'neither caller may load the status projection before replay acknowledgment');
  assert.equal(Date.now(), 1_000_000 + PROCESS_CLEANUP_CAP_MS, 'retry, close and successor never rejoin physical I/O');
  assert.equal(physical, 1); assert.equal(f.core.busy, true); assert.equal(runnerBusy(), true);
  if (outcome === 'EIO') held.reject(Object.assign(new Error('late epoch acknowledgment EIO'), {code: 'EIO'}));
  else held.resolve();
  await simulatedUntil(() => physical === 0 && f.core['owner']?.['pending'] === 0);
  await assert.rejects(f.successor.init(), {code: 'RUNNER_STATE_UNAVAILABLE'});
  assert.equal(f.core.busy, true, 'late physical settlement never restores a timed-out journal session');
  assert.equal(loaded.mock.callCount(), 0); assert.equal(maximumPhysical, 1); assert.equal(runnerBusy(), true);
});

test('S2 P1-5: held projection after durable replay cannot overwrite a successor after clean handoff', {
  skip: process.platform !== 'linux',
}, async t => {
  const f = await cleanFixture(t), held = deferred(), state = f.core['state'];
  const write = state.writeActive.bind(state), snapshots: ActiveRun[][] = [];
  let physical = 0, maximumPhysical = 0;
  t.mock.method(state, 'writeActive', async (rows: ActiveRun[]) => {
    snapshots.push(structuredClone(rows)); physical++; maximumPhysical = Math.max(maximumPhysical, physical);
    try {if (snapshots.length === 1) await held.promise; await write(rows);} finally {physical--;}
  });
  const loaded = t.mock.method(RunnerState.prototype, 'active');
  t.after(async () => {held.resolve(); await f.core['writes']?.catch(() => {});});
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
  let error: unknown;
  const initial = f.core.init().catch(value => {error = value;});
  await simulatedUntil(() => snapshots.length === 1);
  t.mock.timers.tick(PROCESS_CLEANUP_CAP_MS); await simulatedUntil(() => error !== undefined); await initial;
  assert.equal((error as {code: string}).code, 'RUNNER_STATE_UNAVAILABLE');
  assert.deepEqual(snapshots[0], []); assert.equal(loaded.mock.callCount(), 1);
  await f.core.close();
  await assert.rejects(f.successor.init(), {code: 'RUNNER_STATE_UNAVAILABLE'});
  assert.equal(loaded.mock.callCount(), 1); assert.equal(physical, 1);
  held.resolve(); await f.core['writes'];
  await f.successor.init();
  assert.equal(loaded.mock.callCount(), 1, 'explicit clean handoff reuses authoritative memory without stale disk reload');
  const runId = randomUUID();
  const row: ActiveRun = {runId, agentId: randomUUID(), aiToolId: randomUUID(), pid: 922001, startedAt: 'successor-process',
    runDir: join(f.data, '.maddots', 'runs', runId), phase: 'running'};
  f.successor['active'].set(runId, row); await f.successor['save']();
  await assert.rejects(f.core['save'](), {code: 'RUNNER_STATE_UNAVAILABLE'});
  assert.deepEqual(await new RunnerState(f.data).active(), [row], 'a late old snapshot must not erase the successor obligation');
  assert.equal(maximumPhysical, 1); assert.equal(f.successor.busy, true);
});

test('S2 R19 P1-6 durability: held native observation, natural cleared-environment fork, close and late EIO survive a fresh helper process', {
  skip: process.platform !== 'linux', timeout: 45_000,
}, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-journal-native-'));
  const data = join(root, 'data'), cwd = join(root, 'work');
  await mkdir(data, {mode: 0o700}); await mkdir(cwd, {mode: 0o700});
  const runId = randomUUID();
  // The encompassing obligation precedes even fixture workload creation. An
  // observation may add diagnostics, but its loss can never discharge INTENT.
  await seedJournal(data, runId);
  const originalReady = join(root, 'original'), leaderReady = join(root, 'leader'), orphanReady = join(root, 'orphan');
  const retire = join(root, 'retire'), fork = join(root, 'fork'), stop = join(root, 'stop');
  const fixture = spawn('python3', ['-c', `
import ctypes, os, sys, time
original, leader, orphan, retire, fork, stop = sys.argv[1:]
def publish(path):
    with open(path + '.tmp', 'w') as stream: stream.write(str(os.getpid()))
    os.replace(path + '.tmp', path)
if ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) != 0: raise RuntimeError('subreaper unavailable')
child = os.fork()
if child:
    while not os.path.exists(stop):
        try: os.waitpid(-1, os.WNOHANG)
        except ChildProcessError: pass
        time.sleep(0.005)
    while True:
        try: os.waitpid(-1, 0)
        except ChildProcessError: break
    os._exit(0)
os.setpgid(0, 0)
publish(original)
child = os.fork()
if child:
    while not os.path.exists(retire) and not os.path.exists(stop): time.sleep(0.005)
    os._exit(0)
os.setsid()
publish(leader)
while not os.path.exists(fork):
    if os.path.exists(stop): os._exit(0)
    time.sleep(0.005)
child = os.fork()
if child:
    while not os.path.exists(orphan) and not os.path.exists(stop): time.sleep(0.005)
    os._exit(0)
# Exec replaces the procfs environment too, proving this survivor has no run
# fence even to an external inspector rather than only to Python's environ.
os.execve(sys.executable, [sys.executable, '-c', '''
import os, sys, time
ready, stop = sys.argv[1:]
with open(ready + '.tmp', 'w') as stream: stream.write(str(os.getpid()))
os.replace(ready + '.tmp', ready)
while not os.path.exists(stop): time.sleep(0.005)
''', orphan, stop], {})
`, originalReady, leaderReady, orphanReady, retire, fork, stop], {stdio: 'ignore'});
  let fixtureExited = false;
  const fixtureExit = new Promise<void>(resolve => {fixture.on('exit', () => {fixtureExited = true; resolve();});});
  const helpers: ChildProcess[] = [];
  t.after(async () => {
    await writeFile(stop, 'stop', {mode: 0o600});
    for (const helper of helpers) if (helper.connected) helper.send('exit');
    await until(() => fixtureExited, 'private fixture descendants to be reaped'); await fixtureExit;
    await Promise.all(helpers.map(helper => helper.exitCode !== null ? Promise.resolve() :
      new Promise<void>(resolve => helper.once('exit', () => resolve()))));
    await rm(root, {recursive: true, force: true});
  });
  await until(() => exists(originalReady), 'original root acknowledgment');
  await until(() => exists(leaderReady), 'setsid leader acknowledgment');
  const original = Number(await readFile(originalReady, 'utf8')), leader = Number(await readFile(leaderReady, 'utf8'));
  const processes = directFixtureProcesses();
  const gone = async (pid: number) => {
    try {return await processes.identity(pid) === null;}
    catch (error) {
      // A native lifetime can change between coherent /proc reads. Retry the
      // observation; a race is never evidence that the process is absent.
      if ((error as {code?: string}).code === 'race') return false;
      throw error;
    }
  };
  const originalIdentity = await processes.identity(original), leaderIdentity = await processes.identity(leader);
  assert(originalIdentity); assert(leaderIdentity);
  await writeFile(retire, 'retire', {mode: 0o600});
  await until(() => gone(original), 'original root natural exit');
  const folder = await createRunFolder({cwd, dataDir: data, runId});
  await folder.stageProjectFile({path: 'pending-config', content: 'retain while the survivor lives', kind: 'config'});
  const lock = join(cwd, '.maddots', 'run.lock'), savedLock = await readFile(lock);
  await folder.release(); await writeFile(lock, savedLock, {mode: 0o600});
  const row: ActiveRun = {runId, agentId: randomUUID(), aiToolId: randomUUID(), pid: 0, startedAt: originalIdentity,
    runDir: folder.runDir, phase: 'running', processGroups: [{pgid: original, startedAt: originalIdentity,
      cleanupPending: true, members: [{pid: leader, startedAt: leaderIdentity}]}]};
  const state = new RunnerState(data); await state.init(); await state.writeActive([row]);
  const predecessor = worker('observe', data, leader); helpers.push(predecessor.child);
  const observed = await predecessor.reply('observed');
  assert.equal(observed.busy, true); assert.equal(observed.physical, 1); assert.equal(observed.maximumPhysical, 1);
  await writeFile(fork, 'fork', {mode: 0o600});
  await until(() => exists(orphanReady), 'environment-cleared survivor acknowledgment');
  const orphan = Number(await readFile(orphanReady, 'utf8'));
  await until(() => gone(leader), 'observed leader natural exit');
  assert.equal((await readFile(`/proc/${orphan}/environ`)).length, 0, 'the survivor really has an empty native environment');
  const orphanIdentity = await processes.identity(orphan); assert(orphanIdentity);
  predecessor.child.send('close-and-fail');
  const failed = await predecessor.reply('failed');
  assert.equal(failed.oldRowsUnchanged, true); assert.equal(failed.busy, true);
  assert.equal(failed.maximumPhysical, 1);
  predecessor.child.send('exit'); await predecessor.exit; predecessor.assertExit();
  assert.deepEqual(await state.active(), [row], 'fresh helper receives exactly the old disk snapshot');
  const successor = worker('replay', data); helpers.push(successor.child);
  const replayed = await successor.reply('replayed'); await successor.exit; successor.assertExit();
  const survivorAlive = await processes.identity(orphan) === orphanIdentity;
  t.diagnostic(JSON.stringify({observed, failed, replayed, predecessorExited: true, survivorAlive}));
  assert.equal(survivorAlive, true, 'restart must not confuse a forgotten orphan with extinction');
  assert.equal(replayed.busy, true, 'fresh no-memory replay must retain the unresolved containment or migration obligation');
  assert.equal(replayed.error, 'RUNNER_STATE_UNAVAILABLE');
  assert.deepEqual(replayed.obligations, [{runId, stage: 'INTENT'}], 'refusal must retain the original durable intent, not merely reject malformed fixture state');
  assert.equal(replayed.journalReason, 'operation-ambiguous');
  assert.equal(replayed.reads, 0, 'durable replay must refuse before stale active.json can authorize cleanup');
  const restartedAgain = worker('replay', data); helpers.push(restartedAgain.child);
  const secondReplay = await restartedAgain.reply('replayed'); await restartedAgain.exit; restartedAgain.assertExit();
  assert.equal(secondReplay.busy, true); assert.equal(secondReplay.error, 'RUNNER_STATE_UNAVAILABLE');
  assert.deepEqual(secondReplay.obligations, [{runId, stage: 'INTENT'}]);
  assert.equal(secondReplay.journalReason, 'operation-ambiguous');
  assert.equal(secondReplay.reads, 0, 'a second process restart cannot clear the same unfinished intent');
  assert.equal(await readFile(join(cwd, 'pending-config'), 'utf8'), 'retain while the survivor lives');
  await access(lock);
});
