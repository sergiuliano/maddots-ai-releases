import assert from 'node:assert/strict';
import {lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {ApiClient} from '../src/api.js';
import {readConfig} from '../src/config.js';
import {createPaths, ensurePaths} from '../src/paths.js';
import {FileSecretStore, type SecretName, type SecretStore} from '../src/secret-store.js';
import {StateStore} from '../src/state.js';
import {TokenManager} from '../src/token.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-credential-removal-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const home = join(root, 'home'); await mkdir(home, {mode: 0o700});
  const config = readConfig({}, home, 'linux'), paths = await createPaths(config);
  await ensurePaths(paths);
  const state = new StateStore(paths, config.endpoint);
  const manager = (secrets: SecretStore) => new TokenManager(new ApiClient(config.endpoint, async () => {
    assert.fail('Local credential removal must not send a request.');
  }), secrets, state);
  return {paths, state, manager};
}

test('clearing credentials removes both entries from a shared read-modify-write store', async t => {
  const f = await fixture(t);
  let values: Partial<Record<SecretName, string>> = {'skills-token': 'fixture-token', 'device-key': 'fixture-key'};
  const secrets: SecretStore = {
    storage: 'file', platform: 'linux',
    get: async name => values[name],
    set: async (name, secret) => {values[name] = secret;},
    delete: async name => {
      const next = {...values};
      // Both concurrent deletions capture the same snapshot before either write.
      await Promise.resolve();
      delete next[name];
      values = next;
    },
  };
  await f.manager(secrets).clearCredentials();
  assert.deepEqual(values, {});
  assert.equal((await f.state.read()).status, 'pair_again');
});

test('clearing Linux file credentials removes both keys and the file while preserving backups', async t => {
  const f = await fixture(t), path = join(f.paths.config!, 'credentials.json');
  const secrets = await FileSecretStore.open(path, f.paths, {explicit: true, confirmed: true});
  await secrets.set('skills-token', 'fixture-token');
  await secrets.set('device-key', 'fixture-key');
  const backup = join(f.paths.backups, 'kept.txt'); await writeFile(backup, 'fixture-backup');
  await f.manager(secrets).clearCredentials();
  assert.equal(await secrets.get('skills-token'), undefined);
  assert.equal(await secrets.get('device-key'), undefined);
  await assert.rejects(lstat(path), {code: 'ENOENT'});
  assert.equal(await readFile(backup, 'utf8'), 'fixture-backup');
  assert.equal((await f.state.read()).status, 'pair_again');
});

for (const failed of ['skills-token', 'device-key'] as const) {
  test(`clearing credentials still attempts both removals when ${failed} deletion fails`, async t => {
    const f = await fixture(t), calls: SecretName[] = [];
    const values = new Map<SecretName, string>([['skills-token', 'fixture-token'], ['device-key', 'fixture-key']]);
    const secrets: SecretStore = {
      storage: 'file', platform: 'linux',
      get: async name => values.get(name),
      set: async (name, secret) => {values.set(name, secret);},
      delete: async name => {
        calls.push(name);
        if (name === failed) throw new Error('Fixture deletion failure.');
        values.delete(name);
      },
    };
    await assert.rejects(f.manager(secrets).clearCredentials(), {code: 'SECRET_DELETE_FAILED'});
    assert.deepEqual(calls, ['skills-token', 'device-key']);
    assert.deepEqual([...values.keys()], [failed]);
    assert.equal((await f.state.read()).status, 'pair_again');
  });
}
