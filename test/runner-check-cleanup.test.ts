import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {access, mkdir, mkdtemp, readFile, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import type {Timing} from '../src/config.js';
import {JOURNAL_HEAD, RunnerJournal, type JournalToken} from '../src/runner/journal.js';
import {RunnerState} from '../src/runner/state.js';
import {acquireRunnerStorageLock, type RunnerStorageLock} from '../src/runner/storage-lock.js';
import {acquireStorageOwner, storageOwnerDiagnostics} from '../src/runner/storage-owner.js';
import {cleanupNativeFixtureRoot} from './support/linux-native-workloads.js';
import {initializeCleanRunnerJournal} from './support/runner-journal-fixture.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-check-cleanup-'));
  const data = join(root, 'data');
  await mkdir(data, {mode: 0o700});
  await initializeCleanRunnerJournal(data);
  const locks: RunnerStorageLock[] = [];
  t.after(async () => {
    await Promise.all(locks.map(lock => lock.release()));
    // These rootless regressions create no workloads. Remove their synthetic
    // unresolved intent only after every test-owned kernel lock is released.
    await rm(root, {recursive: true, force: true});
  });
  return {root, data, hold: async () => {
    const lock = await acquireRunnerStorageLock(data); locks.push(lock); return lock;
  }};
}

test('TLS22 fixture cleanup waits for physical lock release beyond the old two-second teardown window', {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const {root, data, hold} = await fixture(t);
  const held = await hold();
  let elapsed = 0, closed = false;
  const timing: Timing = {now: () => elapsed, sleep: async () => {
    assert(closed, 'the owning fixture must finish its shutdown callback before lock handoff');
    await access(root);
    // Deterministic oversleep models slow physical retirement without a real
    // two-second delay. Contention and release still use the real kernel lock.
    elapsed += 1000;
    if (elapsed === 3000) await held.release();
  }};
  await cleanupNativeFixtureRoot(t, root, data, async () => {closed = true;}, timing);
  assert.equal(elapsed, 3000, 'cleanup must allow the real lock to outlive the old two-second caller window');
  await assert.rejects(access(root), {code: 'ENOENT'});
});

test('TLS22 fixture cleanup preserves evidence when physical lock release never completes', {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const {root, data, hold} = await fixture(t);
  await hold();
  const before = await readFile(join(data, 'runner', JOURNAL_HEAD), 'utf8');
  let elapsed = 0;
  const timing: Timing = {now: () => elapsed, sleep: async () => {elapsed += 100_000;}};
  await assert.rejects(cleanupNativeFixtureRoot(t, root, data, async () => {}, timing), {code: 'HELPER_BUSY'});
  assert.equal(await readFile(join(data, 'runner', JOURNAL_HEAD), 'utf8'), before,
    'a timeout must leave the retained journal intact and must not replay without the lock');
});

test('TLS22 fixture cleanup still refuses an unresolved journal after successful lock handoff', {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const {root, data, hold} = await fixture(t);
  const held = await hold();
  try {
    const journal = new RunnerJournal(await held.directory('runner'), {
      directoryIdentity: held.identity, bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
      ownerEpoch: randomUUID(), generation: 1, isCurrent: () => true, completionScope: 'full-run', contractVersion: 1,
    });
    await journal.replay();
    await journal.establishEpoch();
    // An intent alone starts no workload and grants no cleanup proof.
    await journal.intent({runId: randomUUID(), incarnation: randomUUID()});
  } finally {await held.release();}
  const before = await readFile(join(data, 'runner', JOURNAL_HEAD), 'utf8');
  await assert.rejects(cleanupNativeFixtureRoot(t, root, data, async () => {}), /Native fixture journal remains unresolved/u);
  assert.equal(await readFile(join(data, 'runner', JOURNAL_HEAD), 'utf8'), before,
    'read-only teardown replay must neither establish a new epoch nor erase unresolved evidence');
});

for (const unresolved of [false, true]) test(`TLS22 fixture cleanup reports the retained ${unresolved ? 'unresolved' : 'clean'} owner without changing its held lock`, {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const {root, data} = await fixture(t);
  const acquisition = await acquireStorageOwner(data, new RunnerState(data));
  const owner = acquisition.owner, generation = acquisition.attach();
  let token: JournalToken | undefined;
  // Synthetic journal metadata is never launched. Only this rootless test's
  // finalizer accepts its synthetic proof to release the test-owned fixture.
  const refuse = async (): Promise<never> => {throw new Error('The rootless holder fixture cannot launch or recover workloads.');};
  const namespaceId = randomUUID();
  t.mock.method(owner, 'getLinuxContainment', async () => ({namespaceId, reserve: refuse, reopen: refuse,
    retireCompleted: refuse, verifyRegistration: async () => true, verifyCompletion: async () => true, close: async () => {}}));
  try {
    await owner.replayJournal(generation);
    owner.stateLoaded = true; owner.initialized = true;
    if (unresolved) {
      token = await owner.journalOperation(generation, journal => journal.intent({runId: randomUUID(), incarnation: randomUUID()}));
      owner.retainRuntime();
      owner.setCleanupDiagnostic(token.runId, 'verify-empty', true);
    }
    const before = await readFile(join(data, 'runner', JOURNAL_HEAD), 'utf8');
    const messages: string[] = [], report = t.diagnostic.bind(t);
    t.mock.method(t, 'diagnostic', (message: string) => {messages.push(message); report(message);});
    let replays = 0;
    const replay = RunnerJournal.prototype.replay;
    const observer = t.mock.method(RunnerJournal.prototype, 'replay', async function(this: RunnerJournal) {
      replays++; return replay.call(this);
    });
    let elapsed = 0;
    const timing: Timing = {now: () => elapsed, sleep: async () => {elapsed += 100_000;}};
    await assert.rejects(cleanupNativeFixtureRoot(t, root, data, async () => {}, timing, () => ({
      busy: owner.busy, idle: true, jobs: 0, closed: true, closeFinished: true,
      initializing: false, cycling: false, disconnecting: 0, tools: 0, owner: owner.diagnosticSnapshot(),
    })), {code: 'HELPER_BUSY'});
    observer.mock.restore();
    const prefix = 'Native fixture holder diagnostics: ';
    const message = messages.find(message => message.startsWith(prefix));
    assert(message, 'failed kernel-lock acquisition must emit the retained holder snapshot');
    const diagnostic = JSON.parse(message.slice(prefix.length)) as {phase: string;
      storage: ReturnType<typeof storageOwnerDiagnostics>; core: {busy: boolean; idle: boolean; jobs: number}};
    assert.equal(diagnostic.phase, 'lock-acquisition');
    assert.equal(diagnostic.storage.owners.length, 1, 'only this directory\'s retained owner belongs in the diagnostic');
    const held = diagnostic.storage.owners[0];
    assert.equal(held.busy, unresolved);
    assert.equal(held.attached, true);
    assert.equal(held.generation, generation);
    assert.equal(held.journalGeneration, generation);
    assert.equal(held.runtimePending, unresolved);
    assert.equal(held.pendingOperations, 0);
    assert(held.ownerEpoch, 'the diagnostic includes the retained owner epoch');
    assert.equal(held.journal?.acknowledgedHead?.sequence, unresolved ? 2 : 1);
    assert.equal(held.journal?.busy, unresolved);
    assert.equal(held.journal?.obligations.length, unresolved ? 1 : 0);
    if (unresolved) {
      assert.equal(held.journal?.obligations[0].runId, token!.runId);
      assert.equal(held.journal?.obligations[0].stage, 'INTENT');
      assert.deepEqual(held.cleanup, [{runId: token!.runId, phase: 'verify-empty', failed: true}]);
    } else assert.deepEqual(held.cleanup, []);
    assert.deepEqual(diagnostic.core && {busy: diagnostic.core.busy, idle: diagnostic.core.idle, jobs: diagnostic.core.jobs},
      {busy: unresolved, idle: true, jobs: 0}, 'idle work and retained owner obligations remain distinguishable');
    assert.equal(replays, 0, 'holder diagnostics must never replay storage without owning its kernel lock');
    assert.equal(await readFile(join(data, 'runner', JOURNAL_HEAD), 'utf8'), before);
    assert.equal(owner.diagnosticSnapshot().generation, generation, 'observing the holder must not detach or revoke its generation');
    await assert.rejects(acquireRunnerStorageLock(data, timing, timing.now() + 2000), {code: 'HELPER_BUSY'},
      'reporting diagnostics must leave the retained owner\'s real kernel lock held');
  } finally {
    if (token) {
      await owner.journalOperation(generation, journal => journal.retireSealed(token!, {backend: 'linux-cgroup-v2',
        namespaceId, name: `run-${token!.incarnation}`, objectIdentity: '1:1'}, Object.freeze({rootlessFixture: true})));
      owner.clearCleanupDiagnostic(token.runId);
    }
    await owner.detach(generation);
  }
});
