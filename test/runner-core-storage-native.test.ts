import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {access, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {inspectLinuxProcessSync, LinuxProcError, linuxProcessTable} from '../src/linux-proc.js';
import {AdapterRegistry} from '../src/runner/adapters/index.js';
import {PROCESS_CLEANUP_CAP_MS, type ProcessInspector} from '../src/runner/process.js';
import {createRunFolder} from '../src/runner/run-folder.js';
import {RunnerCore} from '../src/runner/runner.js';
import {RunnerState, type ActiveRun} from '../src/runner/state.js';
import {RunnerStorageOwner} from '../src/runner/storage-owner.js';
import {directFixtureProcesses} from './native-process-fixture.js';
import {initializeCleanRunnerJournal, isolateS1DiagnosticRecovery} from './support/runner-journal-fixture.js';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
// Capture the real timers before MockTimers replaces them. Native process
// readiness and filesystem progress have no relationship to event-loop turns.
const realClock = {setTimeout, clearTimeout};

/** Native observations remain Linux observations while the historical S1
 * schedule selects the existing Darwin recovery algorithm below. */
function storageFixtureProcesses(): ProcessInspector {
  if (process.platform !== 'linux') return directFixtureProcesses();
  const inspect = (pid: number, deadline?: number) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    // The native reader itself enforces its host platform. Restore the legacy
    // algorithm selection synchronously before returning to the signal gate.
    Object.defineProperty(process, 'platform', {...descriptor, value: 'linux'});
    try {return inspectLinuxProcessSync(pid, deadline);}
    finally {Object.defineProperty(process, 'platform', descriptor);}
  };
  return {
    table: async () => (await linuxProcessTable()).filter(row => !row.zombie),
    identity: async pid => Number.isInteger(pid) && pid > 0 ? inspect(pid)?.startedAt ?? null : null,
    inspect: async pid => inspect(pid), inspectSync: inspect, fencePids: async () => [],
  };
}

/** Acquire the real Linux owner first, then exercise S1's old observational
 * storage schedule through the existing Darwin process backend. S3 Linux
 * production never installs this seam or turns observations into authority. */
function historicalRecoveryAfterLinuxOwner(t: TestContext): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const restore = () => Object.defineProperty(process, 'platform', descriptor);
  if (process.platform === 'linux') {
    const replay = RunnerStorageOwner.prototype.replayJournal;
    t.mock.method(RunnerStorageOwner.prototype, 'replayJournal', async function(this: RunnerStorageOwner, generation: number) {
      await replay.call(this, generation);
      Object.defineProperty(process, 'platform', {...descriptor, value: 'darwin'});
    });
    t.after(restore);
  }
  return restore;
}

async function until(check: () => boolean | Promise<boolean>, waitingFor = 'native fixture progress'): Promise<void> {
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        while (!stopped) {
          if (await check()) return;
          await new Promise<void>(resolve => realClock.setTimeout(resolve, 5));
        }
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = realClock.setTimeout(() => reject(new Error(`Timed out after 5 real seconds waiting for ${waitingFor}.`)), 5000);
      }),
    ]);
  } finally { stopped = true; realClock.clearTimeout(timer); }
}

test('FIX17 native: stalled recovery storage preserves the live child, then retry completes cleanup', {
  skip: !['linux', 'darwin'].includes(process.platform), timeout: 30_000,
}, async t => {
  isolateS1DiagnosticRecovery(t);
  historicalRecoveryAfterLinuxOwner(t);
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-core-storage-native-'));
  const data = join(root, 'data'), cwd = join(root, 'work'), ready = join(root, 'ready'), stop = join(root, 'stop');
  await mkdir(data, {mode: 0o700}); await mkdir(cwd, {mode: 0o700});
  const child = spawn(process.execPath, ['-e',
    'const fs = require("node:fs"); fs.writeFileSync(process.argv[1], String(process.pid)); setInterval(() => { if (fs.existsSync(process.argv[2])) process.exit(0); }, 10);',
    ready, stop], {detached: true, stdio: 'ignore'});
  let exitCode: number | null | undefined, exitSignal: NodeJS.Signals | null | undefined;
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {exitCode = code; exitSignal = signal; resolve();});
  });
  let release = () => {};
  const holder: {core?: RunnerCore} = {};
  t.after(async () => {
    const core = holder.core;
    t.mock.timers.reset();
    release(); await core?.['writes']?.catch(() => {}); await core?.close();
    await writeFile(stop, 'stop', {mode: 0o600}); await exited;
    await rm(root, {recursive: true, force: true});
  });
  await until(async () => {try {await access(ready); return true;} catch {return false;}});
  const pid = Number(await readFile(ready, 'utf8'));
  assert.equal(pid, child.pid);
  const processes = storageFixtureProcesses(), startedAt = await processes.identity(pid);
  assert(startedAt, 'native inspection must bind the child before constructing its recovery row');
  const runId = randomUUID(), folder = await createRunFolder({cwd, dataDir: data, runId});
  await folder.stageProjectFile({path: 'pending-config', content: 'preserve while child lives', kind: 'config'});
  // Recreate the saved lock without this fixture's live reservation, as on a
  // helper restart. Only verified recovery may remove that on-disk lock.
  const lock = join(cwd, '.maddots', 'run.lock'), savedLock = await readFile(lock);
  await folder.release(); await writeFile(lock, savedLock, {mode: 0o600});
  const row: ActiveRun = {runId, agentId: randomUUID(), aiToolId: randomUUID(), pid, startedAt,
    runDir: folder.runDir, phase: 'running', legacyProcessIdentity: true,
    processGroups: [{pgid: pid, startedAt, cleanupPending: true}]};
  const state = new RunnerState(data); await state.init(); await state.writeActive([row]);
  let removed = 0;
  const core = new RunnerCore({data, registry: new AdapterRegistry([]), processes,
    connections: async () => [], localAgents: async () => [], verifiedBuild: async () => true,
    allowedBuild: async () => true, stageSkills: async () => {}, removeDeviceKey: async () => {removed++;},
    deliver: async () => {assert.fail('An interrupted native recovery cannot deliver a result.');}});
  holder.core = core;
  const coreState = core['state'], write = coreState.writeActive.bind(coreState);
  const held = new Promise<void>(resolve => {release = resolve;});
  let writes = 0, writing = 0, maximumWriting = 0;
  t.mock.method(coreState, 'writeActive', async (rows: ActiveRun[]) => {
    writes++; writing++; maximumWriting = Math.max(maximumWriting, writing);
    try {if (writes === 1) await held; await write(rows);} finally {writing--;}
  });
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: Date.now()});
  let initError: unknown, disconnectError: unknown;
  const initial = core.init().catch(error => {initError = error;});
  await until(() => writes === 1);
  const disconnect = core.disconnect().catch(error => {disconnectError = error;});
  t.mock.timers.tick(PROCESS_CLEANUP_CAP_MS);
  await until(() => initError !== undefined && disconnectError !== undefined);
  await Promise.all([initial, disconnect]);
  assert.equal((initError as {code: string}).code, 'RUNNER_STATE_UNAVAILABLE');
  assert.equal((disconnectError as {code: string}).code, 'RUNNER_STATE_UNAVAILABLE');
  assert.equal(removed, 1); assert.equal(core.busy, true);
  assert.equal(await processes.identity(pid), startedAt, 'no process is signalled before its required save completes');
  assert.equal(await readFile(join(cwd, 'pending-config'), 'utf8'), 'preserve while child lives');
  await access(join(cwd, '.maddots', 'run.lock'));
  assert.deepEqual(await state.active(), [row]);

  t.mock.timers.reset();
  release(); await core['writes'];
  await core.init(); await exited;
  assert.equal(exitCode, null); assert.equal(exitSignal, 'SIGTERM');
  assert.equal(await processes.identity(pid), null);
  assert.equal(maximumWriting, 1);
  assert.deepEqual(await state.active(), []); assert.equal(core.busy, false);
  await assert.rejects(access(join(cwd, 'pending-config')), {code: 'ENOENT'});
  await assert.rejects(access(join(cwd, '.maddots', 'run.lock')), {code: 'ENOENT'});
});

test('FIX18 native: replacement storage waits for the closed runner physical write before saving a live child', {
  skip: !['linux', 'darwin'].includes(process.platform), timeout: 30_000,
}, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-core-replacement-native-'));
  const data = join(root, 'data'), cwd = join(root, 'work'), ready = join(root, 'ready'), stop = join(root, 'stop');
  await mkdir(data, {mode: 0o700}); await mkdir(cwd, {mode: 0o700});
  await initializeCleanRunnerJournal(data);
  const child = spawn(process.execPath, ['-e',
    'const fs = require("node:fs"); fs.writeFileSync(process.argv[1], String(process.pid)); setInterval(() => { if (fs.existsSync(process.argv[2])) process.exit(0); }, 10);',
    ready, stop], {detached: true, stdio: 'ignore'});
  const exited = new Promise<void>((resolve, reject) => {child.once('error', reject); child.once('exit', () => resolve());});
  const options = {data, registry: new AdapterRegistry([]),
    connections: async () => [], localAgents: async () => [], verifiedBuild: async () => true,
    allowedBuild: async () => true, stageSkills: async () => {}, removeDeviceKey: async () => {},
    deliver: async (): Promise<never> => {assert.fail('The storage fixture cannot deliver a result.');}};
  const old = new RunnerCore(options), replacement = new RunnerCore({...options, data: `${data}/../data/.`});
  let release!: () => void;
  const held = new Promise<void>(resolve => {release = resolve;});
  t.after(async () => {
    t.mock.timers.reset(); release();
    await old['writes']?.catch(() => {}); await old.close(); await replacement.close();
    await writeFile(stop, 'stop', {mode: 0o600}); await exited;
    await rm(root, {recursive: true, force: true});
  });
  await until(async () => {try {await access(ready); return true;} catch {return false;}});
  const pid = Number(await readFile(ready, 'utf8')), processes = directFixtureProcesses();
  const startedAt = await processes.identity(pid);
  assert(startedAt, 'the replacement ledger must describe a real, live child');
  const oldWrite = old['state'].writeActive.bind(old['state']);
  const newWrite = replacement['state'].writeActive.bind(replacement['state']);
  let oldWrites = 0, newWrites = 0, writing = 0, maximumWriting = 0;
  t.mock.method(old['state'], 'writeActive', async (rows: ActiveRun[]) => {
    oldWrites++; writing++; maximumWriting = Math.max(maximumWriting, writing);
    if (oldWrites === 1) assert.deepEqual(rows, [], 'the timed-out physical writer carries the destructive empty snapshot');
    try {await held; await oldWrite(rows);} finally {writing--;}
  });
  t.mock.method(replacement['state'], 'writeActive', async (rows: ActiveRun[]) => {
    newWrites++; writing++; maximumWriting = Math.max(maximumWriting, writing);
    try {await newWrite(rows);} finally {writing--;}
  });
  // Handoff keeps the predecessor's state object. Prototype spies observe
  // reads through either core, retained owner.state, or a newly created state.
  const loaded = t.mock.method(RunnerState.prototype, 'active');
  const pending = t.mock.method(RunnerState.prototype, 'pending');
  const initialized = t.mock.method(RunnerState.prototype, 'init');
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: Date.now()});
  let error: unknown, tickDone = false;
  const initial = old.init().catch(cause => {error = cause;});
  await until(() => oldWrites === 1);
  const initialLoads = loaded.mock.callCount(), initialPending = pending.mock.callCount(), initialInits = initialized.mock.callCount();
  const tick = old.tick().then(() => {tickDone = true;});
  t.mock.timers.tick(PROCESS_CLEANUP_CAP_MS);
  await until(() => error !== undefined && tickDone); await Promise.all([initial, tick]);
  assert.equal((error as {code: string}).code, 'RUNNER_STATE_UNAVAILABLE');
  await old.close();
  await assert.rejects(replacement.init(), {code: 'RUNNER_STATE_UNAVAILABLE'});
  await replacement.tick();
  assert.equal(replacement['lastError'], 'RUNNER_STATE_UNAVAILABLE');
  assert.equal(loaded.mock.callCount(), initialLoads); assert.equal(pending.mock.callCount(), initialPending);
  assert.equal(initialized.mock.callCount(), initialInits);
  assert.equal(newWrites, 0);
  assert.equal(writing, 1);

  t.mock.timers.reset(); release(); await old['writes'];
  await replacement.init();
  const runId = randomUUID();
  const row: ActiveRun = {runId, agentId: randomUUID(), aiToolId: randomUUID(), pid, startedAt,
    runDir: join(cwd, '.maddots', 'runs', runId), phase: 'running',
    processGroups: [{pgid: pid, startedAt, cleanupPending: true}]};
  replacement['active'].set(runId, row); await replacement['save']();
  await assert.rejects(old['save'](), {code: 'RUNNER_STATE_UNAVAILABLE'});
  await old.close(); await flush();
  assert.equal(maximumWriting, 1);
  assert.equal(await processes.identity(pid), startedAt, 'the live child still needs its durable recovery obligation');
  assert.equal(loaded.mock.callCount() - initialLoads, process.platform === 'linux' ? 0 : 1,
    'Linux clean handoff reuses the retained state instead of reopening the disk projection');
  assert.deepEqual(await new RunnerState(data).active(), [row], 'a late closed writer cannot erase the live child ledger');
});

for (const outcome of ['success', 'EIO'] as const) {
  test(`S1 native ${outcome}: an observed fork/setsid group survives close and cannot be handed to a successor`, {
    skip: process.platform !== 'linux', timeout: 30_000,
  }, async t => {
    isolateS1DiagnosticRecovery(t);
    const restorePlatform = historicalRecoveryAfterLinuxOwner(t);
    const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-owner-dirty-native-'));
    const data = join(root, 'data'), cwd = join(root, 'work');
    await mkdir(data, {mode: 0o700}); await mkdir(cwd, {mode: 0o700});
    const rootReady = join(root, 'original-root'), leaderReady = join(root, 'leader'), orphanReady = join(root, 'orphan');
    const retireRoot = join(root, 'retire-root'), fork = join(root, 'fork'), stop = join(root, 'stop');
    // Every process is a private fixture. The original group leader
    // exits on a file command; its child creates a session and later forks a
    // survivor with an empty environment. Teardown uses files, never signals.
    const launcher = spawn('python3', ['-c', `
import ctypes, os, sys, time
root_ready, leader_ready, orphan_ready, retire_root, fork, stop = sys.argv[1:]
def publish(path):
    with open(path + '.tmp', 'w') as stream: stream.write(str(os.getpid()))
    os.replace(path + '.tmp', path)
# Keep one fixture controller alive and reap only its own descendants.
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
publish(root_ready)
child = os.fork()
if child:
    while not os.path.exists(retire_root) and not os.path.exists(stop): time.sleep(0.005)
    os._exit(0)
os.setsid()
publish(leader_ready)
while not os.path.exists(fork):
    if os.path.exists(stop): os._exit(0)
    time.sleep(0.005)
child = os.fork()
if child:
    while not os.path.exists(orphan_ready) and not os.path.exists(stop): time.sleep(0.005)
    os._exit(0)
os.environ.clear()
publish(orphan_ready)
while not os.path.exists(stop): time.sleep(0.005)
os._exit(0)
`, rootReady, leaderReady, orphanReady, retireRoot, fork, stop], {detached: true, stdio: 'ignore'});
    let launcherStopped = false, launcherError: unknown;
    const exited = new Promise<void>(resolve => {
      launcher.once('error', error => {launcherError = error; launcherStopped = true; resolve();});
      launcher.once('exit', () => {launcherStopped = true; resolve();});
    });
    const ready = (path: string, stage: string) => until(async () => {
      if (launcherStopped) throw launcherError ?? new Error(`The native controller exited before ${stage}.`);
      try {await access(path); return true;} catch (error) {
        if ((error as {code?: string}).code === 'ENOENT') return false;
        throw error;
      }
    }, stage);
    const processes = storageFixtureProcesses();
    const gone = async (pid: number) => {
      try {return await processes.identity(pid) === null;}
      catch (error) {
        if ((error as {code?: string}).code === 'race') return false;
        throw error;
      }
    };
    const options = {data, registry: new AdapterRegistry([]), processes,
      connections: async () => [], localAgents: async () => [], verifiedBuild: async () => true,
      allowedBuild: async () => true, stageSkills: async () => {}, removeDeviceKey: async () => {},
      deliver: async (): Promise<never> => {assert.fail('The dirty owner fixture cannot deliver.');}};
    const core = new RunnerCore(options), successor = new RunnerCore({...options, data: `${data}/../data/.`});
    let release = () => {}, leader = 0, orphan = 0;
    t.after(async () => {
      t.mock.timers.reset(); release();
      // Stop and reap the private fixture even when readiness or init fails.
      // Recovery closure may still be waiting on inspection or a held save.
      await writeFile(stop, 'stop', {mode: 0o600});
      await until(() => launcherStopped, 'the native controller to reap its descendants'); await exited;
      await core['writes']?.catch(() => {}); await core.close(); await successor.close();
      if (leader) await until(() => gone(leader));
      if (orphan) await until(() => gone(orphan));
      await rm(root, {recursive: true, force: true});
    });
    await ready(rootReady, 'the original root readiness acknowledgment');
    await ready(leaderReady, 'the setsid leader readiness acknowledgment');
    leader = Number(await readFile(leaderReady, 'utf8'));
    const originalRoot = Number(await readFile(rootReady, 'utf8'));
    const leaderIdentity = await processes.identity(leader), rootIdentity = await processes.identity(originalRoot);
    assert(leaderIdentity); assert(rootIdentity);
    await writeFile(retireRoot, 'retire', {mode: 0o600}); await until(() => gone(originalRoot));
    const runId = randomUUID(), folder = await createRunFolder({cwd, dataDir: data, runId});
    await folder.stageProjectFile({path: 'pending-config', content: 'preserve the live orphan', kind: 'config'});
    const lock = join(cwd, '.maddots', 'run.lock'), savedLock = await readFile(lock);
    await folder.release(); await writeFile(lock, savedLock, {mode: 0o600});
    const row: ActiveRun = {runId, agentId: randomUUID(), aiToolId: randomUUID(), pid: 0, startedAt: rootIdentity,
      runDir: folder.runDir, phase: 'running', processGroups: [{pgid: originalRoot, startedAt: rootIdentity,
        cleanupPending: true, members: [{pid: leader, startedAt: leaderIdentity}]}]};
    const state = new RunnerState(data); await state.init(); await state.writeActive([row]);
    const write = core['state'].writeActive.bind(core['state']);
    let fail!: (error: Error) => void;
    const held = new Promise<void>((resolve, reject) => {release = resolve; fail = reject;});
    const snapshots: ActiveRun[][] = [];
    let writing = 0, maximumWriting = 0;
    t.mock.method(core['state'], 'writeActive', async (rows: ActiveRun[]) => {
      snapshots.push(rows); writing++; maximumWriting = Math.max(maximumWriting, writing);
      try {if (snapshots.length === 1) await held; await write(rows);} finally {writing--;}
    });
    const loaded = t.mock.method(RunnerState.prototype, 'active');
    const pending = t.mock.method(RunnerState.prototype, 'pending');
    const initialized = t.mock.method(RunnerState.prototype, 'init');
    const reads = () => ({active: loaded.mock.callCount(), pending: pending.mock.callCount(), init: initialized.mock.callCount()});
    const table = processes.table.bind(processes);
    let tables = 0;
    t.mock.method(processes, 'table', async () => {
      tables++;
      // A complete native table can lose a process during inspection. Keep
      // this retry in the schedule instead of depending on a race-free host.
      if (tables === 1) throw new LinuxProcError('race');
      return table();
    });
    t.mock.method(process, 'kill', () => {assert.fail('The storage fixture cannot send PID signals.');});
    processes.signalGroup = () => {assert.fail('Uncommitted storage cannot authorize a native group signal.');};
    t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: Date.now()});
    let initError: unknown;
    const initial = core.init().catch(error => {initError = error;});
    // Recovery backs off on native inspection races. Advance those mocked
    // timers with real elapsed time while waiting for its first publication.
    // Storage's cleanup-cap jump remains below, after the write is held.
    let retryAt = performance.now() + 250;
    await until(() => {
      if (snapshots.length === 1) return true;
      if (performance.now() >= retryAt) {
        t.mock.timers.tick(250);
        retryAt = performance.now() + 250;
      }
      return false;
    }, 'native inspection to reach its held publication');
    const initialReads = reads();
    assert(snapshots[0][0].processGroups?.some(group => group.pgid === leader && group.cleanupPending),
      'the held physical write must be the newly observed native own-group');
    t.mock.timers.tick(PROCESS_CLEANUP_CAP_MS); await until(() => initError !== undefined); await initial;
    assert.equal((initError as {code: string}).code, 'RUNNER_STATE_UNAVAILABLE');
    await writeFile(fork, 'fork', {mode: 0o600});
    await ready(orphanReady, 'the empty-environment survivor readiness acknowledgment');
    orphan = Number(await readFile(orphanReady, 'utf8'));
    await until(() => gone(leader));
    const orphanIdentity = await processes.identity(orphan); assert(orphanIdentity);
    await core.close();
    restorePlatform();
    await assert.rejects(successor.init(), {code: 'RUNNER_STATE_UNAVAILABLE'});
    assert.deepEqual(reads(), initialReads); assert.equal(writing, 1);
    const physical = core['writes']!;
    if (outcome === 'EIO') {
      const rejected = assert.rejects(physical, {code: 'EIO'});
      fail(Object.assign(new Error('native fixture late EIO'), {code: 'EIO'})); await rejected;
      assert.deepEqual(await state.active(), [row]);
    } else {release(); await physical;}
    const readsBeforeRetry = {...initialReads, active: initialReads.active + (outcome === 'EIO' ? 1 : 0)};
    assert.deepEqual(reads(), readsBeforeRetry, 'late settlement permits only the explicit EIO disk-oracle read');
    let successorDone = false, successorError: unknown;
    const previousTables = tables;
    const replacement = successor.init().catch(error => {successorError = error;}).finally(() => {successorDone = true;});
    await until(() => successorDone || tables > previousTables);
    const settleWindow = performance.now() + 200;
    while (!successorDone && performance.now() < settleWindow) await flush();
    if (!successorDone) t.mock.timers.tick(PROCESS_CLEANUP_CAP_MS);
    await until(() => successorDone); await replacement;
    if (loaded.mock.callCount() !== readsBeforeRetry.active) t.diagnostic(JSON.stringify({outcome, successorLoaded: loaded.mock.callCount() - readsBeforeRetry.active,
      successorBusy: successor.busy, predecessorBusy: core.busy,
      predecessorRetainsObservedGroup: core['unrecovered'].get(runId)?.processGroups?.some(group => group.pgid === leader && group.cleanupPending),
      survivorIdentityIntact: await processes.identity(orphan) === orphanIdentity}));
    assert.deepEqual(reads(), readsBeforeRetry, 'neither a late acknowledgment nor EIO reloads through any RunnerState instance');
    assert.equal((successorError as {code?: string} | undefined)?.code, 'RUNNER_STATE_UNAVAILABLE');
    assert.equal(core.busy, true); assert.equal(maximumWriting, 1);
    assert.equal(await processes.identity(orphan), orphanIdentity, 'the empty-environment survivor is still live');
    assert.equal(await readFile(join(cwd, 'pending-config'), 'utf8'), 'preserve the live orphan');
    await access(lock);
  });
}
