/**
 * Native S5 component cases, invoked only by the installed service driver.
 * These use the production owner, journal, lifecycle and containment backend.
 * They do not supply a production signed authorization or close the complete
 * S5-01/S5-03 matrix. Failed journals and their held locks survive until this
 * fixture process exits; a teardown kill never manufactures durable CLEAN.
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {lstat, mkdir, mkdtemp, readFile, realpath, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {inspectLinuxProcess} from '../src/linux-proc.js';
import {JOURNAL_HEAD, RunnerJournal, initializeCleanJournal, type JournalContext, type JournalObligation} from '../src/runner/journal.js';
import {LINUX_CONTAINMENT_PATHS, type LinuxContainedRun, type LinuxContainmentBackend} from '../src/runner/linux-containment.js';
import {createLinuxToolLifecycle} from '../src/runner/linux-lifecycle.js';
import {ProcessCleanupError, recoverProcess, type ProcessGroup, type ProcessInspector} from '../src/runner/process.js';
import {RunnerState} from '../src/runner/state.js';
import {acquireRunnerStorageLock} from '../src/runner/storage-lock.js';
import {RunnerStorageOwner} from '../src/runner/storage-owner.js';

const nativeSkip = process.platform !== 'linux' || process.env.MDAI_LINUX_NATIVE_CONTAINMENT !== '1'
  ? 'S5 native component case requires the installed mdai ExecReload driver and real delegated containment.' : false;
const options = {skip: nativeSkip, timeout: 90_000};
const base = '/var/lib/mdai/qualification';
// FileHandle finalization must not silently release an unresolved owner's lock
// when a completed test's local variables become collectible.
const retainedFixtures: unknown[] = [];
const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {resolve = done;});
  return {promise, resolve};
}
async function within<T>(promise: Promise<T>, label: string, ms = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_done, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: no proof within ${ms}ms`)), ms);
    })]);
  } finally {clearTimeout(timer);}
}
async function present(path: string): Promise<boolean> {
  try {await lstat(path); return true;} catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error;}
}
async function until(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!await check()) {assert(Date.now() < deadline, label); await pause(20);}
}

const workload = String.raw`
import os, signal, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
with open('/work/started', 'w') as output:
    output.write(open('/proc/self/cgroup').read().strip())
count = 0
while True:
    count += 1
    with open('/work/heartbeat.tmp', 'w') as output:
        output.write(str(count))
    os.replace('/work/heartbeat.tmp', '/work/heartbeat')
    time.sleep(0.02)
`;

async function fixture(t: TestContext, cleanupExpectation: 'clean' | 'unresolved' = 'clean') {
  assert.equal(process.getuid?.(), 999);
  assert.equal(await realpath(process.execPath), LINUX_CONTAINMENT_PATHS.node);
  assert.equal((await readFile('/proc/self/cgroup', 'utf8')).trim(), '0::/system.slice/mdai-helper.service/controller');
  const parent = await lstat(base); assert.equal(parent.uid, 999); assert.equal(parent.mode & 0o777, 0o700);
  const root = await mkdtemp(join(base, 's5-native-')), data = join(root, 'controller'), workspace = join(root, 'work');
  await mkdir(data, {mode: 0o700}); await mkdir(workspace, {mode: 0o700});
  await writeFile(join(workspace, 'workload.py'), workload, {mode: 0o700, flag: 'wx'});
  const lock = await acquireRunnerStorageLock(data), directory = await lock.directory('runner');
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  const context: JournalContext = {directoryIdentity: lock.identity, bootId, ownerEpoch: randomUUID(), generation: 1,
    isCurrent: () => true, completionScope: 'full-run', contractVersion: 1};
  // Only this newly created private fixture directory may be initialized.
  await initializeCleanJournal(directory, context);
  const state = new RunnerState(data); state.bindDirectory(lock);
  const owner = new RunnerStorageOwner(state, lock, () => {}, () => false, true);
  const generation = owner.attach(); await owner.replayJournal(generation);
  owner.stateLoaded = true; owner.initialized = true;
  const backend = await owner.getLinuxContainment(generation);
  await backend.qualifyAdmission?.();
  retainedFixtures.push({owner, lock, directory, backend});
  const runId = randomUUID(), lifecycle = createLinuxToolLifecycle(owner, generation, runId);
  let run: LinuxContainedRun | undefined;
  let stagedWork: string | undefined;
  // Observe the real backend without replacing any endpoint, proof or
  // admission check. Remember work even when launcher permission is refused
  // before reserve can return a live handle to prepare's caller.
  const observed: LinuxContainmentBackend = {...backend, reserve: async request => {
    const prepareWork = request.prepareWork;
    request.prepareWork = async path => {stagedWork = path; await prepareWork?.(path);};
    const value = await backend.reserve(request);
    run = value;
    value.child.stdout.resume();
    value.child.stderr.on('data', bytes => t.diagnostic(`S5 guardian: ${String(bytes).slice(0, 4096)}`));
    value.child.stdin.on('error', () => {});
    return value;
  }};
  t.mock.method(owner, 'getLinuxContainment', async (currentGeneration: number) => {
    owner.assertGeneration(currentGeneration); return observed;
  });
  let attemptedCleanup = false;
  const work = () => {
    assert(stagedWork, 'native work staging must have occurred');
    return stagedWork;
  };
  const prepare = async (deadline = Date.now() + 20_000, signal?: AbortSignal) => {
    run = await lifecycle.prepare({argv: [LINUX_CONTAINMENT_PATHS.python, '-I', join(workspace, 'workload.py')],
      cwd: workspace, workspace, env: {}, deadline, signal});
    return run;
  };
  const replay = async (replayDirectory = directory) => {
    // Independent read-only replay does not acquire an epoch, obtain a native
    // endpoint, or pretend that a second process owns the retained directory.
    const journal = new RunnerJournal(replayDirectory, {...context, ownerEpoch: randomUUID(), generation: 2});
    return {journal, result: await journal.replay()};
  };
  const cleanup = async () => {
    attemptedCleanup = true;
    try {
      if (run) {
        // Healthy fixtures must complete the production lifecycle. Only an
        // explicitly unresolved fixture may use physical fallback cleanup.
        const cleaning = lifecycle.cleanup(run, Date.now() + 10_000);
        if (cleanupExpectation === 'clean') await cleaning;
        else {
          await cleaning.catch(error => {
            t.diagnostic(`S5 expected unresolved lifecycle cleanup: ${String(error)}`);
          });
          if (!owner.isRunRetired(runId)) {
            t.diagnostic(`S5 unresolved physical fallback: ${root}; containment=${run.registration.name}`);
            run.seal(); await run.forceKill();
            await until(() => run!.empty(), 'retained native cgroup must become empty');
            await run.completionProof();
          }
        }
      }
    } finally {
      await owner.detach(generation);
      t.diagnostic(`S5 component evidence: ${root}; expected=${cleanupExpectation}; busy=${owner.busy}; clean=${owner.isRunRetired(runId)}`);
    }
    if (cleanupExpectation === 'clean') {
      assert.equal(owner.busy, false, 'healthy fixture cleanup must leave no owner obligation');
      if (run) assert.equal(owner.isRunRetired(runId), true, 'healthy fixture cleanup must durably retire its run');
      const successor = await acquireRunnerStorageLock(data, undefined, Date.now() + 1000);
      try {
        const {journal, result} = await replay(await successor.directory('runner'));
        assert.equal(result.busy, false, 'healthy fixture journal must replay clean after owner release');
        assert.deepEqual(result.obligations, []);
        if (run) assert.equal(journal.isClean(runId), true, 'healthy fixture CLEAN must survive independent replay');
      } finally {await successor.release();}
    } else {
      assert.equal(owner.busy, true, 'an unresolved fixture must retain its owner obligation after teardown');
      assert.equal(owner.isRunRetired(runId), false, 'physical fallback must never manufacture durable CLEAN');
    }
  };
  t.after(async () => {if (!attemptedCleanup) await cleanup();});
  return {root, data, workspace, directory, owner, generation, backend, lifecycle, runId, prepare, work, replay, cleanup,
    run: () => run, workIfStaged: () => stagedWork};
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type HeldStage = 'INTENT' | 'CONTAINMENT_BOUND' | 'LAUNCH_ALLOWED';
function holdPublishedHead(t: TestContext, f: Fixture, stage: HeldStage, late: 'success' | 'EIO') {
  const entered = deferred(), release = deferred(), settled = deferred();
  const sync = f.directory.sync.bind(f.directory);
  let armed = true;
  const mock = t.mock.method(f.directory, 'sync', async () => {
    await sync();
    if (!armed) return;
    const head = JSON.parse(await readFile(join(f.directory.path, JOURNAL_HEAD), 'utf8')) as {payload: {sequence: number}};
    if (!head.payload.sequence) return;
    const name = `journal-${String(head.payload.sequence).padStart(10, '0')}.json`;
    const record = JSON.parse(await readFile(join(f.directory.path, name), 'utf8')) as {payload: {stage: string}};
    if (record.payload.stage !== stage) return;
    armed = false; entered.resolve();
    try {
      await release.promise;
      if (late === 'EIO') throw Object.assign(new Error('S5 injected late directory-sync EIO'), {code: 'EIO'});
    } finally {settled.resolve();}
  });
  return {entered, release, settled, restore: () => mock.mock.restore()};
}

async function assertNoStart(f: Fixture, mayHaveRetired = false) {
  if (f.workIfStaged()) assert.equal(await present(join(f.work(), 'started')), false, 'independent workload-side start marker must remain absent');
  assert.equal(await present(join(f.workspace, 'started')), false, 'no started output may be published');
  if (!mayHaveRetired) assert.equal(f.owner.isRunRetired(f.runId), false, 'absence of a start marker does not certify CLEAN');
}

async function assertUnresolvedAfterCleanup(f: Fixture, obligation: JournalObligation) {
  assert.equal(f.owner.busy, true, 'failed owner must remain busy after teardown');
  assert.equal(f.owner.admissionBlocked, true, 'failed owner admission must remain blocked after teardown');
  assert.equal(f.owner.isRunRetired(f.runId), false, 'teardown must not retire the failed owner');
  const {journal, result} = await f.replay();
  assert.equal(result.busy, true, 'failed owner journal must remain unresolved after teardown');
  assert.deepEqual(result.obligations, [obligation], 'teardown must preserve the original restart obligation');
  assert.equal(journal.isClean(f.runId), false);
  const run = f.run();
  if (run) {
    const {registration} = run;
    const path = join(LINUX_CONTAINMENT_PATHS.root, `ns-${registration.namespaceId}`, registration.name);
    const info = await lstat(path);
    assert.equal(`${info.dev}:${info.ino}`, registration.objectIdentity, 'teardown must retain the original cgroup object');
    assert.match(await readFile(join(path, 'cgroup.events'), 'utf8'), /^populated 0$/mu, 'the retained cgroup must be empty');
  }
  let successor: Awaited<ReturnType<typeof acquireRunnerStorageLock>> | undefined;
  try {
    await assert.rejects(async () => {successor = await acquireRunnerStorageLock(f.data, undefined, Date.now() + 250);},
      'failed owner must still exclude a successor after teardown');
  } finally {await successor?.release();}
}

for (const stage of ['INTENT', 'CONTAINMENT_BOUND', 'LAUNCH_ALLOWED'] as const) {
  for (const event of ['cancel', 'close', 'deadline-success', 'deadline-EIO'] as const) {
    test(`S5-03 native lifecycle ${event} while ${stage} durable publication acknowledgment is held`, options, async t => {
      const unresolved = stage === 'INTENT' || event.startsWith('deadline-');
      const f = await fixture(t, unresolved ? 'unresolved' : 'clean'), abort = new AbortController();
      const held = holdPublishedHead(t, f, stage, event === 'deadline-EIO' ? 'EIO' : 'success');
      const deadline = Date.now() + 15_000;
      let callbacks = 0;
      const launching = (async () => {
        const run = await f.prepare(deadline, abort.signal);
        await f.lifecycle.launch(run);
        callbacks++; run.child.stdin.end('forbidden fixture stdin');
      })();
      const rejected = assert.rejects(launching);
      let obligation: JournalObligation;
      try {
        await within(held.entered.promise, `${stage} published head`);
        await assertNoStart(f);
        assert.equal(f.owner.busy, true);
        if (event === 'cancel') abort.abort();
        else if (event === 'close') f.owner.retainRuntime();
        else {
          // Use the real wall and monotonic clocks. Fake timers cannot stand in
          // for the production guardian's monotonic pre-exec admission check.
          await within(rejected, 'caller persistence deadline', Math.max(1000, deadline - Date.now() + 2000));
          assert.equal(f.owner.admissionBlocked, true);
          await assert.rejects(acquireRunnerStorageLock(f.data, undefined, Date.now() + 250));
        }
        held.release.resolve(); await held.settled.promise; await within(rejected, 'late publication refusal');
        assert.equal(callbacks, 0, 'no workload callback or stdin write follows refused admission');
        await assertNoStart(f);
        const replay = await f.replay();
        assert.equal(replay.result.busy, true);
        assert.equal(replay.result.obligations.length, 1);
        assert.equal(replay.result.obligations[0].runId, f.runId);
        // retainRuntime closes final permission synchronously. If BOUND has
        // already published, ALLOW can finish before consumption refuses it.
        const lastStage = event === 'close' && stage === 'CONTAINMENT_BOUND' ? 'LAUNCH_ALLOWED' : stage;
        assert.equal(replay.result.obligations[0].stage, lastStage, 'the final durable head remains the restart obligation');
        assert.equal(replay.journal.isClean(f.runId), false);
        obligation = replay.result.obligations[0];
      } finally {held.release.resolve(); held.restore();}
      await f.cleanup();
      await assertNoStart(f, !unresolved);
      if (unresolved) await assertUnresolvedAfterCleanup(f, obligation);
    });
  }
}

test('S5-01 native failed projection publication retains original containment, excludes a successor and preserves an independent sentinel', options, async t => {
  const f = await fixture(t, 'unresolved'), sentinel = await fixture(t);
  const run = await f.prepare(), sentry = await sentinel.prepare();
  await f.lifecycle.launch(run); await sentinel.lifecycle.launch(sentry);
  await until(() => present(join(f.work(), 'heartbeat')), 'first workload heartbeat');
  await until(() => present(join(sentinel.work(), 'heartbeat')), 'independent sentinel heartbeat');
  assert.equal(await readFile(join(f.work(), 'started'), 'utf8'), '0::/');
  // The independent sentinel is a real live native lifetime. Old numeric
  // metadata, even with a matching final observer, grants no recovery signal.
  // This does not claim to force actual kernel PID reuse or reproduce every
  // historical R19 table/ledger scheduling permutation.
  assert(sentry.child.pid);
  const identity = await inspectLinuxProcess(sentry.child.pid);
  let observations = 0, publications = 0;
  const inspector: ProcessInspector = {
    table: async () => {observations++; return [identity];},
    identity: async () => {observations++; return identity.startedAt;},
    inspectSync: () => {observations++; return identity;},
    signalGroup: () => assert.fail('legacy metadata must never signal the native sentinel'),
  };
  for (const scenario of ['cached-parent', 'cached-witness', 'cached-session-witness'] as const) {
    const saved: ProcessGroup[] = [{pgid: identity.pgid, startedAt: 'obsolete-fixture-leader', cleanupPending: true,
      ...(scenario === 'cached-session-witness'
        ? {sid: identity.sid, sessionLeader: {pid: identity.pid, startedAt: 'obsolete-fixture-witness'}}
        : {members: [{pid: identity.pid, startedAt: 'obsolete-fixture-parent-or-witness'}]})}];
    const before = JSON.stringify(saved);
    await assert.rejects(recoverProcess(identity.pid, 'obsolete-fixture-leader', inspector, undefined, saved,
      () => {publications++;}), ProcessCleanupError);
    assert.equal(JSON.stringify(saved), before, `${scenario} must retain its original obligation`);
  }
  assert.equal(observations, 0, 'native process discovery is not Linux cleanup authority');
  assert.equal(publications, 0, 'no replacement is adopted or retired through a diagnostic ledger');
  const originalHead = await readFile(join(f.data, 'runner', JOURNAL_HEAD), 'utf8');
  // Save the real status projection, holding its retained directory sync only
  // after the native filesystem has performed it. The journal's existing
  // ALLOW head identifies this fixture, and is never modified by the fault.
  const held = holdPublishedHead(t, f, 'LAUNCH_ALLOWED', 'EIO');
  const publication = f.owner.save(f.generation, Date.now() + 1000), rejected = assert.rejects(publication);
  try {
    await within(held.entered.promise, 'held active projection publication');
    f.owner.retainRuntime();
    await within(rejected, 'projection deadline');
    await assert.rejects(acquireRunnerStorageLock(f.data, undefined, Date.now() + 250));
    held.release.resolve(); await held.settled.promise;
    // A late physical EIO is not necessarily observed in the public waiter.
    await until(async () => f.owner.unmatchedWrites.length === 1, 'late EIO retained as unmatched ownership evidence');
    assert.equal(f.owner.busy, true); assert.equal(f.owner.admissionBlocked, true);
    await assert.rejects(acquireRunnerStorageLock(f.data, undefined, Date.now() + 250));
    const replay = await f.replay();
    assert.equal(replay.result.busy, true); assert.equal(replay.result.obligations.length, 1);
    assert.equal(replay.result.obligations[0].runId, f.runId);
    assert.equal(replay.result.obligations[0].stage, 'LAUNCH_ALLOWED');
    assert.deepEqual(replay.result.obligations[0].registration, run.registration);
    assert.equal(replay.journal.isClean(f.runId), false);
    assert.equal(await readFile(join(f.data, 'runner', JOURNAL_HEAD), 'utf8'), originalHead);
    assert.equal(await run.empty(), false, 'failed projection cannot be mistaken for extinction of the original native workload');
    await f.cleanup();
    await assertUnresolvedAfterCleanup(f, replay.result.obligations[0]);
    const before = await readFile(join(sentinel.work(), 'heartbeat'), 'utf8');
    await until(async () => await readFile(join(sentinel.work(), 'heartbeat'), 'utf8') !== before,
      'independent sentinel must survive original endpoint cleanup');
    assert.equal(await sentry.empty(), false);
    assert.equal(f.owner.isRunRetired(f.runId), false, 'sealed native emptiness cannot erase a failed owner publication');
    assert.equal(await readFile(join(f.data, 'runner', JOURNAL_HEAD), 'utf8'), originalHead);
  } finally {held.release.resolve(); held.restore();}
});
