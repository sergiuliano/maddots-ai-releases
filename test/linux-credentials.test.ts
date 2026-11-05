import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {ApiClient} from '../src/api.js';
import {CommandError, readConfig, type Runner} from '../src/config.js';
import {createPaths, ensurePaths} from '../src/paths.js';
import {DeviceKeyStore} from '../src/runner/device-key.js';
import {credentialCapabilities, FileSecretStore, SecretServiceSecretStore, selectSecretStore} from '../src/secret-store.js';
import {StateStore} from '../src/state.js';
import {TokenManager} from '../src/token.js';
import {deviceKeyFingerprint} from '../src/shared/runner-protocol.js';

const token = 'mdai_skill_' + 'A'.repeat(43);
const successor = 'mdai_skill_' + 'B'.repeat(43);
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-linux-credentials-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const home = join(root, 'home'); await mkdir(home, {mode: 0o700});
  const config = readConfig({}, home, 'linux'), paths = await createPaths(config);
  await ensurePaths(paths);
  const state = new StateStore(paths, config.endpoint);
  return {root, home, paths, config, state};
}
function secretService() {
  const values = new Map<string, string>();
  const calls: {file: string; args: readonly string[]; input?: string; env?: NodeJS.ProcessEnv}[] = [];
  let unavailable = false, mismatchNextWrite = false, mismatchRead = false, ignoreDelete = false;
  const runner: Runner = async (file, args, options = {}) => {
    calls.push({file, args, input: options.input, env: options.env});
    if (unavailable) throw new CommandError(1);
    const account = args[args.indexOf('account') + 1];
    if (args[0] === 'store') {
      values.set(account, options.input!.replace(/\n$/, ''));
      if (!account.startsWith('availability-') && mismatchNextWrite) {mismatchRead = true; mismatchNextWrite = false;}
      return {stdout: '', stderr: ''};
    }
    if (args[0] === 'clear') {if (!ignoreDelete) values.delete(account); return {stdout: '', stderr: ''};}
    if (!values.has(account)) throw new CommandError(1);
    if (mismatchRead) {mismatchRead = false; return {stdout: 'incorrect\n', stderr: ''};}
    return {stdout: values.get(account)! + '\n', stderr: ''};
  };
  return {runner, values, calls, down: () => {unavailable = true;}, mismatch: () => {mismatchNextWrite = true;},
    ignoreDelete: () => {ignoreDelete = true;}};
}

test('Linux headless selects private credentials outside helper data and persists device keys and run claims', async t => {
  const f = await fixture(t), saved = await f.state.read();
  assert.equal(saved.tokenStorage, 'file');
  let commands = 0;
  const secrets = await selectSecretStore({paths: f.paths, endpoint: f.config.endpoint, saved, env: {}, runner: async () => {commands++; throw new Error('No D-Bus command is permitted.');}});
  assert(secrets instanceof FileSecretStore);
  assert.equal(secrets.path, join(f.home, '.config/maddots-ai/credentials.json'));
  await secrets.set('skills-token', token, ['sync', 'run_claim']);
  await secrets.set('device-key', '{"format":1,"keys":{}}', ['run_claim']);
  assert.equal(await secrets.get('skills-token'), token);
  assert.equal(await secrets.get('device-key'), '{"format":1,"keys":{}}');
  assert.equal((await lstat(f.paths.config!)).mode & 0o777, 0o700);
  assert.equal((await lstat(secrets.path)).mode & 0o777, 0o600);
  assert.equal((await lstat(secrets.path)).nlink, 1);
  assert.equal(commands, 0);
  assert.deepEqual(credentialCapabilities('file', 'linux'), {deviceKeys: true, runClaims: true, providerKeys: false});
  assert.deepEqual(credentialCapabilities('file', 'darwin'), {deviceKeys: false, runClaims: false, providerKeys: false});
  assert.deepEqual(credentialCapabilities('keychain', 'linux'), {deviceKeys: false, runClaims: false, providerKeys: false});
  assert.deepEqual(credentialCapabilities('secret-service', 'darwin'), {deviceKeys: false, runClaims: false, providerKeys: false});
});

test('Linux file credentials rotate atomically and verified deletion preserves the other credential and backups', async t => {
  const f = await fixture(t), secrets = await selectSecretStore({paths: f.paths, endpoint: f.config.endpoint, saved: await f.state.read(), env: {}});
  assert(secrets instanceof FileSecretStore);
  await secrets.set('skills-token', token);
  const predecessor = await lstat(secrets.path);
  await secrets.set('skills-token', successor);
  const current = await lstat(secrets.path);
  assert.notEqual(current.ino, predecessor.ino);
  assert.equal(current.mode & 0o777, 0o600);
  assert.equal(await secrets.get('skills-token'), successor);
  assert.deepEqual(await readdir(f.paths.config!), ['credentials.json']);
  await secrets.set('device-key', 'private-fixture-key', ['run_claim']);
  const backup = join(f.paths.backups, 'kept.txt'); await writeFile(backup, 'backup');
  await secrets.delete('skills-token');
  assert.equal(await secrets.get('skills-token'), undefined);
  assert.equal(await secrets.get('device-key'), 'private-fixture-key');
  await secrets.delete('device-key');
  await assert.rejects(lstat(secrets.path), {code: 'ENOENT'});
  assert.equal(await readFile(backup, 'utf8'), 'backup');
});

test('Linux credentials refuse readable files, directories, hard links, symlinks and unsafe credential directories', async t => {
  const f = await fixture(t), path = join(f.paths.config!, 'credentials.json');
  const open = () => FileSecretStore.open(path, f.paths, {explicit: true, confirmed: true});
  await writeFile(path, '{}\n', {mode: 0o644});
  await assert.rejects(open(), {code: 'FILE_UNSAFE'});
  await chmod(path, 0o600);
  const alias = join(f.root, 'alias.json'); await link(path, alias);
  await assert.rejects(open(), {code: 'FILE_UNSAFE'});
  await rm(path); await symlink(alias, path);
  await assert.rejects(open(), {code: 'PATH_UNSAFE'});
  await rm(path); await mkdir(path, {mode: 0o700});
  await assert.rejects(open(), {code: 'FILE_UNSAFE'});
  await rm(path, {recursive: true});
  await chmod(f.paths.config!, 0o755);
  await assert.rejects(open(), {code: 'PATH_UNSAFE'});
});

test('Linux Secret Service selection requires a usable bus and client and sends values only on stdin', async t => {
  const f = await fixture(t), client = join(f.root, 'secret-tool');
  await writeFile(client, 'fixture', {mode: 0o700});
  const fake = secretService();
  const env = {DBUS_SESSION_BUS_ADDRESS: 'unix:path=/fixture/bus', PATH: f.root, PRIVATE_TOKEN: 'must-not-leak', PASSWORD: 'also-must-not-leak'};
  const secrets = await selectSecretStore({paths: f.paths, endpoint: f.config.endpoint, saved: await f.state.read(), runner: fake.runner, env});
  assert(secrets instanceof SecretServiceSecretStore);
  assert.equal(fake.values.size, 0, 'Availability probes leave no items.');
  await secrets.set('skills-token', token, ['sync', 'run_claim']);
  await secrets.set('device-key', 'private-fixture-key', ['run_claim']);
  assert.equal(await secrets.get('skills-token'), token);
  assert.equal(await secrets.get('device-key'), 'private-fixture-key');
  for (const call of fake.calls) {
    assert.equal(call.file, client);
    assert(!JSON.stringify(call.args).includes(token));
    assert(!JSON.stringify(call.args).includes('private-fixture-key'));
    assert(!JSON.stringify(call.env).includes('must-not-leak'));
  }
  assert(fake.calls.some(call => call.args[0] === 'store' && call.input === token + '\n'));
  fake.mismatch();
  await assert.rejects(secrets.set('skills-token', successor), {code: 'SECRET_STORE_FAILED'});
  assert.equal(await secrets.get('skills-token'), token, 'Failed verification restores the predecessor.');
  await secrets.delete('device-key');
  assert.equal(await secrets.get('device-key'), undefined);
  await secrets.delete('device-key');
});

test('Linux can initially fall back from unusable Secret Service but a saved backend never downgrades', async t => {
  const f = await fixture(t), client = join(f.root, 'secret-tool');
  await writeFile(client, 'fixture', {mode: 0o700});
  const fake = secretService(); fake.down();
  const env = {DBUS_SESSION_BUS_ADDRESS: 'unix:path=/fixture/bus', PATH: f.root};
  const saved = await f.state.read();
  assert.equal((await selectSecretStore({paths: f.paths, endpoint: f.config.endpoint, saved, runner: fake.runner, env})).storage, 'file');
  const selected = {...saved, tokenStorage: 'secret-service' as const, credentialBackendSelected: true};
  await f.state.write(selected);
  assert.equal((await f.state.read()).tokenStorage, 'secret-service');
  for (const environment of [env, {}, {PATH: f.root}]) {
    await assert.rejects(selectSecretStore({paths: f.paths, endpoint: f.config.endpoint, saved: selected, runner: fake.runner, env: environment}), {code: 'SECRET_STORE_UNAVAILABLE'});
  }
  await assert.rejects(selectSecretStore({paths: f.paths, endpoint: f.config.endpoint, saved: selected, env: {}, tokenFile: join(f.root, 'other.json'), confirmed: true}), {code: 'SECRET_BACKEND_MISMATCH'});
  const fileSelected = {...saved, credentialBackendSelected: true};
  const usable = secretService();
  assert.equal((await selectSecretStore({paths: f.paths, endpoint: f.config.endpoint, saved: fileSelected, env, runner: usable.runner})).storage, 'file');
  assert.equal(usable.calls.length, 0, 'A saved file backend stays selected even when Secret Service becomes available.');
});

test('Linux Secret Service reuses its selected absolute client after the service drops the SSH PATH', async t => {
  const f = await fixture(t), client = join(f.root, 'secret-tool');
  await writeFile(client, 'fixture', {mode: 0o700});
  const fake = secretService(), bus = {DBUS_SESSION_BUS_ADDRESS: 'unix:path=/fixture/bus'};
  const selected = await selectSecretStore({paths: f.paths, endpoint: f.config.endpoint, saved: await f.state.read(),
    env: {...bus, PATH: f.root}, runner: fake.runner});
  assert(selected instanceof SecretServiceSecretStore);
  const saved = {...await f.state.read(), tokenStorage: selected.storage, credentialBackendSelected: true, secretServiceBinary: selected.binary};
  await f.state.write(saved);
  assert.equal((await f.state.read()).secretServiceBinary, client);
  const restarted = await selectSecretStore({paths: f.paths, endpoint: f.config.endpoint, saved,
    env: {...bus, PATH: '/usr/bin'}, runner: fake.runner});
  assert(restarted instanceof SecretServiceSecretStore);
  assert.equal(restarted.binary, client);
  await chmod(client, 0o600);
  await assert.rejects(selectSecretStore({paths: f.paths, endpoint: f.config.endpoint, saved,
    env: {...bus, PATH: '/usr/bin'}, runner: fake.runner}), {code: 'SECRET_STORE_UNAVAILABLE'});
  await rm(client);
  await assert.rejects(selectSecretStore({paths: f.paths, endpoint: f.config.endpoint, saved,
    env: {...bus, PATH: '/usr/bin'}, runner: fake.runner}), {code: 'SECRET_STORE_UNAVAILABLE'});
});

test('Linux Secret Service outage is an error instead of a missing credential and deletion is verified', async t => {
  const f = await fixture(t), fake = secretService();
  const secrets = new SecretServiceSecretStore(f.config.endpoint, f.paths.data, '/fixture/secret-tool', fake.runner, {DBUS_SESSION_BUS_ADDRESS: 'unix:path=/fixture/bus'});
  await secrets.delete('device-key');
  await secrets.set('skills-token', token);
  fake.ignoreDelete();
  await assert.rejects(secrets.delete('skills-token'), {code: 'SECRET_STORE_FAILED'});
  fake.down();
  await assert.rejects(secrets.get('skills-token'), {code: 'SECRET_STORE_UNAVAILABLE'});
});

test('Linux device key registration and run_claim refresh use the shared file capability policy', async t => {
  const f = await fixture(t), secrets = await selectSecretStore({paths: f.paths, endpoint: f.config.endpoint, saved: await f.state.read(), env: {}});
  const helperId = randomUUID(), aiToolId = randomUUID(), deviceKeyId = randomUUID();
  const scopes = ['sync', 'import_upload', 'proposal_upload'] as const;
  const api = new ApiClient(f.config.endpoint, async (url, init) => {
    if (String(url).endsWith('/device-key')) {
      const {publicKey} = JSON.parse(String(init?.body)) as {publicKey: string};
      return Response.json({data: {deviceKeyId, fingerprint: deviceKeyFingerprint(publicKey)}});
    }
    return Response.json({data: {account: {id: 'user-1', name: 'Ana'}, scopes: [...scopes, 'run_claim'],
      renewBy: new Date(Date.now() + 90 * 86400000).toISOString(), idleLapseAt: new Date(Date.now() + 30 * 86400000).toISOString(), pending: [], connections: []}});
  });
  const tokens = new TokenManager(api, secrets, f.state);
  await tokens.acceptPairing({token, helperId, account: {id: 'user-1', name: 'Ana'}, scopes: [...scopes],
    renewBy: new Date(Date.now() + 90 * 86400000).toISOString(), idleLapseAt: new Date(Date.now() + 30 * 86400000).toISOString(), connections: []}, []);
  assert.equal((await f.state.read()).credentialBackendSelected, true);
  assert((await tokens.refreshStatus()).scopes.includes('run_claim'));
  const keys = new DeviceKeyStore({paths: f.paths, secrets, helperId, api});
  assert.equal((await keys.ensure(aiToolId)).deviceKeyId, deviceKeyId);
  assert.equal((await keys.get(aiToolId))?.deviceKeyId, deviceKeyId);
  await keys.remove(aiToolId, deviceKeyId);
  assert.equal(await secrets.get('device-key'), undefined);
  await tokens.clearCredentials();
  assert.equal(await secrets.get('skills-token'), undefined);
});
