import assert from 'node:assert/strict';
import test from 'node:test';
import {PROCESS_CLEANUP_CAP_MS} from '../src/runner/process.js';
import {RunnerState} from '../src/runner/state.js';
import type {RunnerStorageLock} from '../src/runner/storage-lock.js';
import {RunnerStorageOwner} from '../src/runner/storage-owner.js';

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {resolve = done; reject = fail;});
  return {promise, resolve, reject};
}

function fixture() {
  let releases = 0, forgotten = 0;
  const state = new RunnerState('/unused-validation-fixture');
  const lock: RunnerStorageLock = {
    data: state.data, identity: 'validation-fixture', assertCurrent: async () => {},
    directory: async () => {throw new Error('These tests perform no state I/O.');},
    release: async () => {releases++;},
  };
  const owner = new RunnerStorageOwner(state, lock, () => {forgotten++;});
  return {owner, lock, releases: () => releases, forgotten: () => forgotten};
}

test('S1 owner validation holds every pending physical check through detached retirement', async t => {
  const f = fixture(), first = deferred(), second = deferred();
  const generation = f.owner.attach();
  f.owner.stateLoaded = true; f.owner.initialized = true;
  let calls = 0;
  t.mock.method(f.lock, 'assertCurrent', () => ++calls === 1 ? first.promise : second.promise);
  const a = f.owner.validate(), b = f.owner.validate();
  assert.equal(calls, 2);
  await f.owner.detach(generation);
  assert.equal(f.releases(), 0);
  assert.equal(f.owner.busy, true);
  first.resolve(); await a;
  assert.equal(f.releases(), 0, 'one successful validation cannot retire another pending validation');
  assert.equal(f.owner.busy, true);
  assert.throws(() => f.owner.attach(), {code: 'RUNNER_STATE_UNAVAILABLE'});
  second.resolve(); await b;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.releases(), 1);
  assert.equal(f.forgotten(), 1);
});

test('S1 owner validation cannot start once descriptor retirement has begun', async t => {
  const f = fixture(), retiring = deferred(), proceed = deferred();
  const generation = f.owner.attach();
  f.owner.stateLoaded = true; f.owner.initialized = true;
  const checks = t.mock.method(f.lock, 'assertCurrent');
  t.mock.method(f.lock, 'release', async () => {retiring.resolve(); await proceed.promise;});
  const detached = f.owner.detach(generation);
  await retiring.promise;
  await assert.rejects(f.owner.validate(), {code: 'RUNNER_STATE_UNAVAILABLE'});
  assert.equal(checks.mock.callCount(), 0, 'validation never touches a descriptor being retired');
  assert.throws(() => f.owner.attach(), {code: 'RUNNER_STATE_UNAVAILABLE'});
  proceed.resolve(); await detached;
  await assert.rejects(f.owner.validate(), {code: 'RUNNER_STATE_UNAVAILABLE'});
  assert.equal(checks.mock.callCount(), 0);
  assert.equal(f.forgotten(), 1);
});

test('S1 unused owner retires only after a timed-out validation actually rejects', async t => {
  const f = fixture(), held = deferred();
  t.mock.method(f.lock, 'assertCurrent', () => held.promise);
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
  const refused = assert.rejects(f.owner.validate(), {code: 'RUNNER_STATE_UNAVAILABLE'});
  t.mock.timers.tick(PROCESS_CLEANUP_CAP_MS); await refused;
  await f.owner.retireIfUnused();
  assert.equal(f.releases(), 0, 'even an owner with no authoritative state must finish its physical validation');
  held.reject(Object.assign(new Error('late validation EIO'), {code: 'EIO'}));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.releases(), 1, 'a never-used owner has no recovery duty after actual validation settlement');
  assert.equal(f.forgotten(), 1);
});

test('S1 an already expired validation deadline starts no I/O and creates no permanent failure', async t => {
  const f = fixture(), generation = f.owner.attach();
  f.owner.stateLoaded = true; f.owner.initialized = true;
  const checks = t.mock.method(f.lock, 'assertCurrent');
  await assert.rejects(f.owner.validate(Date.now() - 1), {code: 'RUNNER_STATE_UNAVAILABLE'});
  assert.equal(checks.mock.callCount(), 0);
  assert.equal(f.owner.admissionBlocked, false);
  await f.owner.validate();
  assert.equal(checks.mock.callCount(), 1);
  await f.owner.detach(generation);
  assert.equal(f.releases(), 1);
});
