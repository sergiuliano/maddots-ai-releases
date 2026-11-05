import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {initializeCleanJournal, RunnerJournal, type JournalContext, type JournalToken} from '../src/runner/journal.js';
import {acquireRunnerStorageLock} from '../src/runner/storage-lock.js';

async function fixture(t: TestContext) {
  const data = await mkdtemp(join(tmpdir(), 'mdai-s3-journal-'));
  const lock = await acquireRunnerStorageLock(data), directory = await lock.directory('runner');
  t.after(async () => {await lock.release(); await rm(data, {recursive: true, force: true});});
  let valid = true, sealed = false, populated = true;
  const proof = Object.freeze({retained: randomUUID()}), run = {runId: randomUUID(), incarnation: randomUUID()};
  const registration = Object.freeze({backend: 'linux-cgroup-v2' as const, namespaceId: randomUUID(), name: `run-${run.incarnation}`, objectIdentity: '11:22'});
  const context: JournalContext = {directoryIdentity: lock.identity, bootId: randomUUID(), ownerEpoch: randomUUID(), generation: 1,
    isCurrent: () => true, completionScope: 'full-run', contractVersion: 1,
    backend: {verifyRegistration: async value => valid && value.backend === registration.backend && value.namespaceId === registration.namespaceId &&
      value.name === registration.name && value.objectIdentity === registration.objectIdentity,
      verifyCompletion: async (_registration, value) => valid && sealed && !populated && value === proof}};
  await initializeCleanJournal(directory, context);
  const journal = new RunnerJournal(directory, context); await journal.replay(); await journal.establishEpoch();
  const intent = await journal.intent(run);
  const at = async (stage: 'INTENT' | 'CONTAINMENT_BOUND' | 'LAUNCH_ALLOWED' | 'STOPPING') => {
    let token = intent;
    if (stage === 'INTENT') return token;
    token = await journal.bind(token, registration);
    if (stage === 'CONTAINMENT_BOUND') return token;
    token = await journal.allow(token);
    if (stage === 'LAUNCH_ALLOWED') return token;
    return journal.stopping(token);
  };
  return {data, directory, journal, intent, at, context, run, registration, proof,
    empty: () => {sealed = true; populated = false;}, invalidate: () => {valid = false;},
    fresh: () => new RunnerJournal(directory, {...context, ownerEpoch: randomUUID(), generation: 2})};
}

for (const stage of ['INTENT', 'CONTAINMENT_BOUND', 'LAUNCH_ALLOWED', 'STOPPING'] as const) {
  test(`S3 cancellation from ${stage} requires sealed-empty proof and never releases a launch permission`, {skip: process.platform !== 'linux'}, async t => {
    const f = await fixture(t), token = await f.at(stage);
    f.empty();
    const sync = f.directory.sync.bind(f.directory);
    let publications = 0;
    t.mock.method(f.directory, 'sync', async () => {
      assert.equal(f.journal.consumeLauncher(token), false);
      assert.equal(f.journal.consumeLaunch(token), false);
      publications++; await sync();
    });
    const clean = await f.journal.retireSealed(token, f.registration, f.proof);
    assert(publications > 0);
    assert.equal(clean.stage, 'CLEAN');
    assert.equal(f.journal.consumeLauncher(clean), false);
    assert.equal(f.journal.consumeLaunch(clean), false);
    assert.equal(f.journal.busy, false);
    const records = (await readdir(join(f.data, 'runner'))).filter(name => /^journal-\d/u.test(name)).sort();
    assert.deepEqual(await Promise.all(records.map(async name => JSON.parse(await readFile(join(f.data, 'runner', name), 'utf8')).payload.stage)),
      ['EPOCH', 'INTENT', 'CONTAINMENT_BOUND', 'LAUNCH_ALLOWED', 'STOPPING', 'CLEAN']);
    assert.equal((await f.fresh().replay()).busy, false);
  });
}

for (const stage of ['CONTAINMENT_BOUND', 'LAUNCH_ALLOWED', 'STOPPING'] as const) {
  test(`S3 same-boot ${stage} recovery finishes the old epoch without reconstructing a start token`, {skip: process.platform !== 'linux'}, async t => {
    const f = await fixture(t), token = await f.at(stage);
    const first = f.fresh();
    assert.equal((await first.replay()).busy, true);
    assert.equal(first.consumeLaunch(token), false);
    const second = f.fresh();
    assert.equal((await second.replay()).busy, true, 'a second crash cannot erase the original obligation');
    f.empty(); await second.recoverSameBootContainment(f.run.runId, f.proof);
    assert.equal(second.busy, false);
    assert.equal(second.consumeLaunch(token), false);
    await second.establishEpoch();
    assert.equal(second.ready, true);
    const final = f.fresh(); assert.equal((await final.replay()).busy, false);
    assert.equal(final.isClean(f.run.runId), true);
  });
}

for (const invalid of ['populated', 'forged-proof', 'lost-provenance', 'unregistered-intent', 'different-boot'] as const) {
  test(`S3 recovery retains busy on ${invalid}`, {skip: process.platform !== 'linux'}, async t => {
    const f = await fixture(t);
    let token: JournalToken = f.intent;
    if (invalid !== 'unregistered-intent') token = await f.at('LAUNCH_ALLOWED');
    if (invalid !== 'populated') f.empty();
    if (invalid === 'lost-provenance') f.invalidate();
    const next = invalid === 'different-boot' ? new RunnerJournal(f.directory, {...f.context, bootId: randomUUID(), ownerEpoch: randomUUID()}) : f.fresh();
    assert.equal((await next.replay()).busy, true);
    await assert.rejects(next.recoverSameBootContainment(f.run.runId, invalid === 'forged-proof' ? {...f.proof} : f.proof));
    assert.equal(next.busy, true);
    assert.equal(next.isClean(f.run.runId), false);
    assert.equal(next.consumeLaunch(token), false);
  });
}
