import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {initializeCleanJournal, RunnerJournal, type JournalToken} from '../src/runner/journal.js';
import {PROCESS_CLEANUP_CAP_MS} from '../src/runner/process.js';
import {RunnerState} from '../src/runner/state.js';
import {acquireRunnerStorageLock} from '../src/runner/storage-lock.js';
import {RunnerStorageOwner} from '../src/runner/storage-owner.js';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {resolve = done; reject = fail;});
  return {promise, resolve, reject};
}
async function fixture(t: TestContext, verify?: (kind: 'registration' | 'empty') => Promise<void>) {
  const data = await mkdtemp(join(tmpdir(), 'mdai-owner-journal-'));
  const lock = await acquireRunnerStorageLock(data), state = new RunnerState(data);
  state.bindDirectory(lock);
  const directory = await lock.directory('runner');
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  await initializeCleanJournal(directory, {directoryIdentity: lock.identity, bootId,
    ownerEpoch: randomUUID(), generation: 1, isCurrent: () => true, completionScope: 'full-run', contractVersion: 1});
  const proof = Object.freeze({sealed: true, empty: true});
  const owner = new RunnerStorageOwner(state, lock, () => {}, () => false, true,
    {verifyRegistration: async () => {await verify?.('registration'); return true;},
      verifyCompletion: async (_registration, value) => {await verify?.('empty'); return value === proof;}});
  const generation = owner.attach();
  await owner.replayJournal(generation);
  owner.stateLoaded = true; owner.initialized = true;
  t.after(async () => {t.mock.timers.reset(); await owner.detach(generation); await lock.release(); await rm(data, {recursive: true, force: true});});
  const begin = () => owner.journalOperation(generation, journal => journal.intent({runId: randomUUID(), incarnation: randomUUID()}));
  const allow = async (intent: JournalToken) => {
    const bound = await owner.journalOperation(generation, journal => journal.bind(intent,
      {backend: 'linux-cgroup-v2', namespaceId: randomUUID(), name: `run-${intent.incarnation}`, objectIdentity: '3:4'}));
    return owner.journalOperation(generation, journal => journal.allow(bound));
  };
  return {owner, generation, proof, begin, allow};
}

test('S2 owner keeps busy through durable retirement and consumes both permissions once', {skip: process.platform !== 'linux'}, async t => {
  const f = await fixture(t);
  assert.equal(f.owner.busy, false);
  const intent = await f.begin();
  assert.equal(f.owner.busy, true);
  assert.equal(f.owner.consumeJournalPermission(f.generation, intent, 'launcher'), true);
  assert.equal(f.owner.consumeJournalPermission(f.generation, intent, 'launcher'), false);
  const allowed = await f.allow(intent);
  assert.equal(f.owner.consumeJournalPermission(f.generation, allowed, 'workload'), true);
  assert.equal(f.owner.consumeJournalPermission(f.generation, allowed, 'workload'), false);
  f.owner.sealJournalAdmission(f.generation, allowed);
  const stopping = await f.owner.journalOperation(f.generation, journal => journal.stopping(allowed));
  assert.equal(f.owner.busy, true);
  await f.owner.journalOperation(f.generation, journal => journal.clean(stopping, f.proof));
  assert.equal(f.owner.busy, false);
  await f.owner.detach(f.generation);
  assert.equal(f.owner.busy, false, 'a clean detach does not invent a new replay obligation');
  assert.equal(f.owner.consumeJournalPermission(f.generation, allowed, 'workload'), false);
});

test('S2 stopping seals admission before a queued physical publication can begin', {skip: process.platform !== 'linux'}, async t => {
  const f = await fixture(t), allowed = await f.allow(await f.begin()), held = deferred(), started = deferred();
  const occupying = f.owner.operation(f.generation, async () => {started.resolve(); await held.promise;});
  await started.promise;
  f.owner.sealJournalAdmission(f.generation, allowed);
  const stopping = f.owner.journalOperation(f.generation, journal => journal.stopping(allowed));
  assert.equal(f.owner.consumeJournalPermission(f.generation, allowed, 'workload'), false,
    'queued STOPPING cannot leave an old start message available');
  held.resolve(); await occupying; await stopping;
  assert.equal(f.owner.busy, true);
});

test('S2 an inner durable intent cannot release permission before the owner acknowledges its operation', {skip: process.platform !== 'linux'}, async t => {
  const f = await fixture(t), held = deferred(), inner = deferred();
  let token: JournalToken | undefined;
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
  const publishing = f.owner.journalOperation(f.generation, async journal => {
    token = await journal.intent({runId: randomUUID(), incarnation: randomUUID()});
    assert.equal(f.owner.consumeJournalPermission(f.generation, token, 'launcher'), false,
      'an inner journal acknowledgment is not the public owner acknowledgment');
    inner.resolve(); await held.promise;
    return token;
  });
  const refused = assert.rejects(publishing, {code: 'RUNNER_STATE_UNAVAILABLE'});
  await inner.promise; t.mock.timers.tick(PROCESS_CLEANUP_CAP_MS); await refused;
  held.resolve(); await flush(); await flush();
  assert.equal(f.owner.consumeJournalPermission(f.generation, token!, 'launcher'), false);
  assert.equal(f.owner.busy, true);
});

test('S2 closing a core seals a late successful intent even before the owner can detach', {skip: process.platform !== 'linux'}, async t => {
  const f = await fixture(t), held = deferred(), durable = deferred();
  const publishing = f.owner.journalOperation(f.generation, async journal => {
    const token = await journal.intent({runId: randomUUID(), incarnation: randomUUID()});
    durable.resolve(); await held.promise;
    return token;
  });
  await durable.promise;
  // RunnerCore.close retains physical work while initialization or jobs are
  // still unwinding. Permission must be sealed at close, before later detach.
  f.owner.retainRuntime();
  held.resolve();
  const token = await publishing;
  assert.equal(f.owner.consumeJournalPermission(f.generation, token, 'launcher'), false);
  assert.equal(f.owner.busy, true);
});

for (const stage of ['intent', 'clean'] as const) for (const settlement of ['success', 'EIO'] as const) {
  test(`S2 owner ${stage} timeout revokes late ${settlement} acknowledgment without releasing busy`, {skip: process.platform !== 'linux'}, async t => {
    const f = await fixture(t), held = deferred(), durable = deferred();
    let token: JournalToken | undefined;
    if (stage === 'clean') {
      const allowed = await f.allow(await f.begin());
      f.owner.sealJournalAdmission(f.generation, allowed);
      token = await f.owner.journalOperation(f.generation, journal => journal.stopping(allowed));
    }
    let physicalToken: JournalToken | undefined;
    const original = RunnerJournal.prototype[stage];
    t.mock.method(RunnerJournal.prototype, stage, async function (this: RunnerJournal, ...args: never[]) {
      physicalToken = await Reflect.apply(original, this, args);
      durable.resolve(); await held.promise;
      return physicalToken;
    });
    t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
    const action = stage === 'intent' ? f.begin() : f.owner.journalOperation(f.generation, journal => journal.clean(token!, f.proof));
    const refused = assert.rejects(action, {code: 'RUNNER_STATE_UNAVAILABLE'});
    await durable.promise;
    assert.equal(f.owner.busy, true, 'the owner retains the physical slot even after payload sync');
    t.mock.timers.tick(PROCESS_CLEANUP_CAP_MS); await refused;
    assert.equal(f.owner.busy, true);
    if (settlement === 'success') held.resolve();
    else held.reject(Object.assign(new Error('late physical rejection'), {code: 'EIO'}));
    await flush(); await flush();
    assert.equal(f.owner.busy, true, 'late durable CLEAN is not an acknowledgment to a revoked caller');
    assert.equal(f.owner.consumeJournalPermission(f.generation, physicalToken!, 'launcher'), false);
    assert.equal(f.owner.consumeJournalPermission(f.generation, physicalToken!, 'workload'), false);
    await f.owner.detach(f.generation);
    assert.throws(() => f.owner.attach(), {code: 'RUNNER_STATE_UNAVAILABLE'});
  });
}

for (const stage of ['registration', 'empty'] as const) for (const settlement of ['success', 'EIO'] as const) {
  test(`S2 owner held ${stage} proof remains bounded and busy through late ${settlement}`, {skip: process.platform !== 'linux'}, async t => {
    const held = deferred(), reached = deferred();
    const f = await fixture(t, async kind => {
      if (kind === stage) {reached.resolve(); await held.promise;}
    });
    let token = await f.begin();
    if (stage === 'empty') {
      token = await f.allow(token);
      f.owner.sealJournalAdmission(f.generation, token);
      token = await f.owner.journalOperation(f.generation, journal => journal.stopping(token));
    }
    t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
    const operation = f.owner.journalOperation(f.generation, journal => stage === 'registration' ? journal.bind(token,
      {backend: 'linux-cgroup-v2', namespaceId: randomUUID(), name: `run-${token.incarnation}`, objectIdentity: '3:4'}) : journal.clean(token, f.proof));
    const refused = assert.rejects(operation, {code: 'RUNNER_STATE_UNAVAILABLE'});
    await reached.promise;
    assert.equal(f.owner.busy, true);
    assert.equal(f.owner.consumeJournalPermission(f.generation, token, 'launcher'), false);
    assert.equal(f.owner.consumeJournalPermission(f.generation, token, 'workload'), false);
    t.mock.timers.tick(PROCESS_CLEANUP_CAP_MS); await refused;
    assert.equal(f.owner.busy, true);
    if (settlement === 'success') held.resolve();
    else held.reject(Object.assign(new Error('late proof failure'), {code: 'EIO'}));
    await flush(); await flush();
    assert.equal(f.owner.busy, true);
    assert.equal(f.owner.consumeJournalPermission(f.generation, token, 'launcher'), false);
    assert.equal(f.owner.consumeJournalPermission(f.generation, token, 'workload'), false);
    await f.owner.detach(f.generation);
    assert.throws(() => f.owner.attach(), {code: 'RUNNER_STATE_UNAVAILABLE'});
  });
}

