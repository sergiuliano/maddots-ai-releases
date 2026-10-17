import assert from 'node:assert/strict';
import {generateKeyPairSync, randomUUID} from 'node:crypto';
import {lstat, mkdir, mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {ApiClient} from '../src/api.js';
import {readConfig} from '../src/config.js';
import {createPaths, ensurePaths} from '../src/paths.js';
import {DeviceKeyStore} from '../src/runner/device-key.js';
import type {SecretName, SecretStore} from '../src/secret-store.js';
import {deviceKeyFingerprint} from '../src/shared/runner-protocol.js';

function storedKey(deviceKeyId: string | null) {
  const {d, x} = generateKeyPairSync('ed25519').privateKey.export({format: 'jwk'});
  return {deviceKeyId, d: d!, x: x!};
}

async function fixture(t: TestContext, register?: (publicKey: string) => Promise<string>) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-device-key-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const home = join(root, 'home'); await mkdir(home, {mode: 0o700});
  const paths = await createPaths(readConfig({}, home)); await ensurePaths(paths);
  const stored = new Map<SecretName, string>([['skills-token', 'mdai_skill_' + 'A'.repeat(43)]]);
  let writes = 0, deletions = 0, ignoreDelete = false;
  const locked = async () => {assert.equal((await lstat(paths.lock)).isFile(), true);};
  const secrets: SecretStore = {
    storage: 'keychain',
    get: async name => {await locked(); return stored.get(name);},
    set: async (name, value) => {await locked(); stored.set(name, value); writes++;},
    delete: async name => {await locked(); if (!ignoreDelete) stored.delete(name); deletions++;},
  };
  const api = new ApiClient(new URL('https://ai.maddots.app'), async (_input, init) => {
    await locked();
    const {publicKey} = JSON.parse(String(init?.body)) as {publicKey: string};
    const deviceKeyId = register ? await register(publicKey) : randomUUID();
    return Response.json({data: {deviceKeyId, fingerprint: deviceKeyFingerprint(publicKey)}});
  });
  const store = new DeviceKeyStore({paths, secrets, helperId: randomUUID(), api});
  return {store, stored, paths, counts: () => ({writes, deletions}), ignoreDelete: () => {ignoreDelete = true;},
    allowDelete: () => {ignoreDelete = false;}};
}

test('stale device key removal preserves the replacement and every other connection', async t => {
  const f = await fixture(t), aiToolId = randomUUID(), otherToolId = randomUUID();
  const oldId = randomUUID(), newId = randomUUID();
  const original = JSON.stringify({format: 1, keys: {[aiToolId]: storedKey(newId), [otherToolId]: storedKey(randomUUID())}});
  f.stored.set('device-key', original);
  await f.store.remove(aiToolId, oldId);
  assert.equal(f.stored.get('device-key'), original);
  assert.deepEqual(f.counts(), {writes: 0, deletions: 0});
  await assert.rejects(lstat(f.paths.lock), {code: 'ENOENT'});
});

test('matching removal changes only that connection and null removes any current key', async t => {
  const f = await fixture(t), aiToolId = randomUUID(), otherToolId = randomUUID(), deviceKeyId = randomUUID();
  const other = storedKey(null);
  f.stored.set('device-key', JSON.stringify({format: 1, keys: {[aiToolId]: storedKey(deviceKeyId), [otherToolId]: other}}));
  await f.store.remove(aiToolId, deviceKeyId);
  assert.deepEqual(JSON.parse(f.stored.get('device-key')!), {format: 1, keys: {[otherToolId]: other}});
  await f.store.remove(otherToolId, null);
  assert.equal(f.stored.has('device-key'), false);
  await f.store.remove(aiToolId, deviceKeyId);
  await f.store.remove(otherToolId, null);
  assert.deepEqual(f.counts(), {writes: 1, deletions: 1});
  await assert.rejects(lstat(f.paths.lock), {code: 'ENOENT'});
});

test('stale removal waits for replacement registration and checks its id under the shared lock', async t => {
  let entered!: () => void, release!: () => void;
  const registering = new Promise<void>(resolve => {entered = resolve;}), gate = new Promise<void>(resolve => {release = resolve;});
  const newId = randomUUID(), oldId = randomUUID(), aiToolId = randomUUID();
  const f = await fixture(t, async () => {entered(); await gate; return newId;});
  const replacement = f.store.ensure(aiToolId);
  await registering;
  let removed = false;
  const removal = f.store.remove(aiToolId, oldId).then(() => {removed = true;});
  try {
    await new Promise<void>(resolve => {setImmediate(resolve);});
    assert.equal(removed, false);
    assert.equal(JSON.parse(f.stored.get('device-key')!).keys[aiToolId].deviceKeyId, null);
  } finally {release();}
  assert.equal((await replacement).deviceKeyId, newId);
  await removal;
  assert.equal(JSON.parse(f.stored.get('device-key')!).keys[aiToolId].deviceKeyId, newId);
  assert.deepEqual(f.counts(), {writes: 2, deletions: 0});
  await f.store.remove(aiToolId, null);
  assert.equal(f.stored.has('device-key'), false);
  await assert.rejects(lstat(f.paths.lock), {code: 'ENOENT'});
});

test('device key removal verifies deletion and releases the shared lock on failure', async t => {
  const f = await fixture(t), aiToolId = randomUUID(), deviceKeyId = randomUUID();
  f.stored.set('device-key', JSON.stringify({format: 1, keys: {[aiToolId]: storedKey(deviceKeyId)}}));
  f.ignoreDelete();
  await assert.rejects(f.store.remove(aiToolId, deviceKeyId), {code: 'SECRET_STORE_FAILED'});
  await assert.rejects(lstat(f.paths.lock), {code: 'ENOENT'});
  f.allowDelete();
  await f.store.remove(aiToolId, deviceKeyId);
  assert.equal(f.stored.has('device-key'), false);
  await assert.rejects(lstat(f.paths.lock), {code: 'ENOENT'});
});
