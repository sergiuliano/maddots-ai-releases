import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { CommandError, cleanEnvironment, endpointUrl, readConfig, type Runner } from '../src/config.js';
import { atomicWrite, createPaths, ensurePaths, readPrivateFile, withWriteLock } from '../src/paths.js';
import { FILE_STORAGE_WARNING, FileSecretStore, KeychainSecretStore } from '../src/secret-store.js';
import { StateStore } from '../src/state.js';
import { TOOL_MATRIX } from '../src/shared/tool-matrix.js';

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-storage-'));
  const home = join(root, 'home'); await mkdir(home, { mode: 0o700 });
  const config = readConfig({}, home), paths = await createPaths(config); await ensurePaths(paths);
  return { root, home, paths, config, close: () => rm(root, { recursive: true, force: true }) };
}
test('endpoint defaults to production and refuses credentials, paths, and unsafe HTTP', () => {
  assert.equal(endpointUrl({}).href, 'https://ai.maddots.app/');
  for (const value of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/?token=secret', 'https://example.com/#code', 'https://example.com/path', 'ftp://localhost']) {
    assert.throws(() => endpointUrl({ MADDOTS_AI_URL: value }));
  }
  assert.throws(() => endpointUrl({ MADDOTS_AI_URL: 'http://127.0.0.1:8765' }));
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) assert.equal(endpointUrl({ MADDOTS_AI_URL: `http://${host}:8765`, MADDOTS_AI_ALLOW_INSECURE_LOOPBACK: '1' }).protocol, 'http:');
  assert.deepEqual(cleanEnvironment({ PATH: '/bin', TOKEN: 'hidden', X_API_KEY: 'hidden', secret_value: 'hidden', HOME: '/tmp' }), { PATH: '/bin', HOME: '/tmp' });
});
test('data, holding and backups are private, outside skill routes and Git trees, and never inside maddots-mcp', async () => {
  const f = await fixture();
  try {
    for (const path of [f.paths.data, f.paths.holding, f.paths.backups]) assert.equal((await lstat(path)).mode & 0o777, 0o700);
    const unsafe = [join(f.home, '.config/ibl-projects-mcp'), join(f.home, '.cache/maddots-mcp'), join(f.home, '.codex-other/skills'),
      ...Object.values(TOOL_MATRIX.routes).filter(route => route.kind !== 'zip').map(route => route.path.replace(/^~/, f.home))];
    for (const path of unsafe) await assert.rejects(createPaths(readConfig({ MADDOTS_AI_HOME: join(path, 'private-data') }, f.home)), /outside|tool home/);
    const work = join(f.root, 'work'); await mkdir(join(work, '.git'), { recursive: true });
    await assert.rejects(createPaths(readConfig({ MADDOTS_AI_HOME: join(work, 'private-data') }, f.home)), /Git work tree/);
    const agents = join(f.home, '.agents'); await mkdir(agents, { mode: 0o700 });
    const privateData = join(f.home, 'private-data'); await mkdir(privateData, { mode: 0o700 });
    await symlink(privateData, join(agents, 'skills'));
    await assert.rejects(createPaths(readConfig({ MADDOTS_AI_HOME: privateData }, f.home)), /physical targets/);
  } finally { await f.close(); }
});
test('data and token files refuse symlink components and unsafe permissions', async () => {
  const f = await fixture();
  try {
    const actual = join(f.home, 'actual'); await mkdir(actual, { mode: 0o700 });
    await symlink(actual, join(f.home, 'linked'));
    await assert.rejects(createPaths(readConfig({ MADDOTS_AI_HOME: join(f.home, 'linked/data') }, f.home)), /symlink/);
    const target = join(actual, 'token.json'); await writeFile(target, '{}', { mode: 0o600 });
    const link = join(actual, 'link.json'); await symlink(target, link);
    await assert.rejects(FileSecretStore.open(link, f.paths, { explicit: true, confirmed: true }), /symlink/);
    await chmod(target, 0o644);
    await assert.rejects(FileSecretStore.open(target, f.paths, { explicit: true, confirmed: true }), /privately/);
    await assert.rejects(atomicWrite(link, '{}'), /symlink/);
    assert.equal(await readFile(target, 'utf8'), '{}');
  } finally { await f.close(); }
});
test('atomic state contains no token and the write lock serializes writers', async () => {
  const f = await fixture();
  try {
    const store = new StateStore(f.paths, f.config.endpoint), state = await store.read();
    await store.write(state); assert.equal((await lstat(f.paths.state)).mode & 0o777, 0o600);
    await assert.rejects(store.write({ ...state, account: { id: 'id', name: 'mdai_skill_' + 'A'.repeat(43) } }), /Secrets/);
    const order: string[] = []; let release!: () => void, started!: () => void;
    const entered = new Promise<void>(done => { started = done; });
    const hold = new Promise<void>(done => { release = done; });
    const first = withWriteLock(f.paths, async () => { order.push('first'); started(); await hold; order.push('first done'); });
    await entered;
    const second = withWriteLock(f.paths, async () => { order.push('second'); await store.write({ ...state, helperId: 'computer' }); });
    release(); await Promise.all([first, second]);
    assert.deepEqual(order, ['first', 'first done', 'second']);
    assert.equal((await store.read()).helperId, 'computer');
    await assert.rejects(lstat(f.paths.lock), { code: 'ENOENT' });
  } finally { await f.close(); }
});
test('write locks recover only a private dead-owner lock and retain a live lock', async () => {
  const f = await fixture();
  try {
    await writeFile(f.paths.lock, '12345', { mode: 0o600 });
    let called = false;
    await withWriteLock(f.paths, async () => { called = true; }, undefined, pid => { assert.equal(pid, 12345); return false; });
    assert.ok(called); await assert.rejects(lstat(f.paths.lock), { code: 'ENOENT' });
    await writeFile(f.paths.lock, '12345', { mode: 0o600 });
    let now = 0;
    await assert.rejects(withWriteLock(f.paths, async () => {}, { now: () => now, sleep: async ms => { now += ms; } }, () => true), /Another helper/);
    assert.equal(await readFile(f.paths.lock, 'utf8'), '12345');
    await chmod(f.paths.lock, 0o644);
    await assert.rejects(withWriteLock(f.paths, async () => {}, undefined, () => false), /private/);
  } finally { await f.close(); }
});
test('Keychain writes use interactive stdin with -U, read back, and never expose secrets in argv or env', async () => {
  const calls: { file: string; args: readonly string[]; input?: string; env?: NodeJS.ProcessEnv }[] = [];
  let saved: string | undefined, mismatch = false, failReadback = false;
  const runner: Runner = async (file, args, options = {}) => {
    calls.push({ file, args, input: options.input, env: options.env });
    if (args[0] === '-i') { const value = /-w ("(?:\\.|[^"\\])*")/.exec(options.input!); saved = JSON.parse(value![1]); mismatch = failReadback; failReadback = false; return { stdout: '', stderr: '' }; }
    if (args[0] === 'delete-generic-password') { saved = undefined; return { stdout: '', stderr: '' }; }
    if (saved === undefined) throw new CommandError(44);
    const result = mismatch ? 'different' : saved; mismatch = false;
    return { stdout: result + '\n', stderr: '' };
  };
  const store = new KeychainSecretStore(new URL('https://ai.maddots.app'), '/private/helper', runner, { PRIVATE_TOKEN: 'forbidden' });
  const secret = 'mdai_skill_' + 'A'.repeat(43);
  await store.set('skills-token', secret);
  assert.equal(await store.get('skills-token'), secret);
  assert.equal(calls.filter(call => call.input).length, 1);
  assert.ok(calls.find(call => call.input)?.input?.startsWith('add-generic-password -U '));
  for (const call of calls) { assert.equal(call.file, '/usr/bin/security'); assert.ok(!JSON.stringify(call.args).includes(secret)); assert.ok(!JSON.stringify(call.env).includes('forbidden')); }
  failReadback = true;
  await assert.rejects(store.set('skills-token', 'new-value'), /verify/);
  assert.equal(await store.get('skills-token'), secret, 'An unverified write restores the previous token.');
  await store.delete('skills-token'); assert.equal(await store.get('skills-token'), undefined);
});
test('file storage needs the explicit warning and confirmation, uses 0600, refuses runs, and preserves backups', async () => {
  const f = await fixture();
  try {
    const path = join(f.root, 'private', 'token.json');
    assert.match(FILE_STORAGE_WARNING, /plaintext.*Type I understand/);
    for (const options of [{ explicit: false, confirmed: true }, { explicit: true, confirmed: false }]) await assert.rejects(FileSecretStore.open(path, f.paths, options), /Warning/);
    await assert.rejects(FileSecretStore.open(path, f.paths, { explicit: true, confirmed: true, scopes: ['run_claim'] }), /Keychain/);
    await assert.rejects(FileSecretStore.open(join(f.home, '.agents/skills/token.json'), f.paths, { explicit: true, confirmed: true }), /outside/);
    for (const path of [join(f.home, '.codex-work/skills/credentials.json'), f.paths.servicePlist, join(f.paths.logs, 'service.log'), join(f.paths.data, 'lock.json')]) {
      await assert.rejects(FileSecretStore.open(path, f.paths, { explicit: true, confirmed: true }), /outside/);
    }
    await mkdir(join(f.home, '.agents'), { mode: 0o700 });
    const linkedRoute = join(f.root, 'linked-route'); await mkdir(linkedRoute, { mode: 0o700 });
    await symlink(linkedRoute, join(f.home, '.agents/skills'));
    await assert.rejects(FileSecretStore.open(join(linkedRoute, 'token.json'), f.paths, { explicit: true, confirmed: true }), /physical targets/);
    const store = await FileSecretStore.open(path, f.paths, { explicit: true, confirmed: true });
    await store.set('skills-token', 'mdai_skill_' + 'B'.repeat(43), ['sync']);
    assert.equal((await lstat(dirname(path))).mode & 0o777, 0o700); assert.equal((await lstat(path)).mode & 0o777, 0o600);
    await assert.rejects(store.set('skills-token', 'secret', ['run_claim']), /Keychain/);
    await assert.rejects(store.set('device-key', 'secret'), /Keychain/);
    const proof = join(f.paths.backups, 'kept.txt'); await writeFile(proof, 'backup');
    await store.delete('skills-token'); assert.equal(await store.get('skills-token'), undefined);
    assert.equal(await readFile(proof, 'utf8'), 'backup');
    await assert.rejects(readPrivateFile(path), { code: 'ENOENT' });
  } finally { await f.close(); }
});
