import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import * as filesystem from 'node:fs/promises';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, symlink } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { acquireRunnerStorageLock } from '../src/runner/storage-lock.js';
import { initializeCleanRunnerJournal } from './support/runner-journal-fixture.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-runner-storage-lock-'));
  await chmod(root, 0o700);
  const data = join(root, 'data'); await mkdir(data, {mode: 0o700});
  t.after(() => rm(root, {recursive: true, force: true}));
  return {root, data};
}

test('Linux runner lock keeps its inode, canonicalizes aliases and has close-on-exec controller descriptors', {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const {root, data} = await fixture(t), alias = join(root, 'alias'); await symlink(data, alias);
  const lock = await acquireRunnerStorageLock(alias);
  t.after(() => lock.release());
  assert.equal(lock.data, data);
  const initial = await lstat(data);
  for (const name of ['runner', 'runner/outcomes', 'logs'] as const) await lock.directory(name);
  const controls = [data, join(data, 'runner'), join(data, 'runner/outcomes'), join(data, 'logs')];
  const descriptors: string[] = [];
  for (const descriptor of await readdir('/proc/self/fd')) {
    const target = await readlink(`/proc/self/fd/${descriptor}`).catch(() => '');
    if (controls.includes(target)) descriptors.push(descriptor);
  }
  assert.equal(descriptors.length, 5, 'all retained directory and lock descriptors are accounted for');
  for (const descriptor of descriptors) {
    const info = await readFile(`/proc/self/fdinfo/${descriptor}`, 'utf8');
    const flags = /^flags:\s+([0-7]+)$/mu.exec(info)![1];
    assert.ok(Number.parseInt(flags, 8) & 0x80000, 'controller descriptor is close-on-exec');
  }
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {readdir, readlink} from 'node:fs/promises';
    const targets = await Promise.all((await readdir('/proc/self/fd')).map(fd => readlink('/proc/self/fd/' + fd).catch(() => '')));
    process.send(targets, () => process.disconnect());
  `], {env: {}, stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
  const received = once(child, 'message');
  const closed = once(child, 'close');
  const [inherited] = await received as [string[]];
  const [code, signal] = await closed;
  assert.equal(code, 0); assert.equal(signal, null);
  for (const path of controls) assert.equal(inherited.includes(path), false, 'workload does not inherit a directory or lock capability');
  await lock.assertCurrent(); await lock.release();
  const next = await acquireRunnerStorageLock(data);
  try {assert.equal((await lstat(data)).ino, initial.ino); assert.equal(next.identity, lock.identity);}
  finally {await next.release();}
});

test('Linux runner lock refuses directory and alias replacement', {skip: process.platform !== 'linux'}, async t => {
  const {root, data} = await fixture(t), alias = join(root, 'alias'); await symlink(data, alias);
  const lock = await acquireRunnerStorageLock(alias);
  try {
    await rename(data, join(root, 'original')); await mkdir(data, {mode: 0o700});
    await assert.rejects(lock.assertCurrent(), {code: 'RUNNER_STATE_UNAVAILABLE'});
  } finally {await lock.release();}
  const replacement = await acquireRunnerStorageLock(alias);
  try {
    await rm(alias); await symlink(join(root, 'original'), alias);
    await assert.rejects(replacement.assertCurrent(), {code: 'RUNNER_STATE_UNAVAILABLE'});
  } finally {await replacement.release();}
});

test('Linux runner lock never adopts a directory replacement after locking its retained inode', {
  skip: process.platform !== 'linux',
}, async t => {
  const {data, root} = await fixture(t);
  const fsp = createRequire(import.meta.url)('node:fs/promises') as typeof filesystem;
  const originalLstat = fsp.lstat, originalOpen = fsp.open;
  let armed = false, swapped = false, acquired: Awaited<ReturnType<typeof acquireRunnerStorageLock>> | undefined;
  t.mock.method(fsp, 'open', async (...args: Parameters<typeof originalOpen>) => {
    const file = await originalOpen(...args);
    if (/^\/proc\/self\/fd\/\d+\/\.$/u.test(String(args[0]))) armed = true;
    return file;
  });
  t.mock.method(fsp, 'lstat', async (...args: Parameters<typeof originalLstat>) => {
    // The independent directory lock FD has been opened and flocked. Change
    // the public name before its first post-acquisition namespace validation.
    if (armed && args[0] === data) {
      armed = false; await rename(data, join(root, 'original'));
      await mkdir(data, {mode: 0o700}); swapped = true;
    }
    return originalLstat(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(acquireRunnerStorageLock(data).then(lock => {acquired = lock;}), {code: 'RUNNER_STATE_UNAVAILABLE'});
    assert.equal(swapped, true);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports(); await acquired?.release();
  }
  const successor = await acquireRunnerStorageLock(data); await successor.release();
});

test('Linux helper processes contend on the same runner directory and alias while a separate directory proceeds', {
  skip: process.platform !== 'linux', timeout: 15_000,
}, async t => {
  const {root, data} = await fixture(t), alias = join(root, 'alias'), separate = join(root, 'separate');
  await symlink(data, alias); await mkdir(separate, {mode: 0o700});
  const children: {child: ChildProcess; closed: Promise<unknown[]>}[] = [];
  t.after(async () => {
    for (const {child} of children) if (child.connected) child.send('release');
    await Promise.all(children.map(({closed}) => closed));
  });
  const script = `
    import {acquireRunnerStorageLock} from ${JSON.stringify(new URL('../src/runner/storage-lock.ts', import.meta.url).href)};
    const send = value => new Promise(done => process.send(value, done));
    try {
      const lock = await acquireRunnerStorageLock(process.argv[1], undefined, Date.now() + 300);
      process.once('message', async () => {await lock.release(); process.disconnect();});
      await send({status: 'held', data: lock.data, identity: lock.identity});
    } catch (error) {
      await send({status: 'refused', code: error.code}); process.disconnect();
    }
  `;
  function helper(directory: string) {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, directory], {
      env: {}, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let errors = ''; child.stderr!.on('data', chunk => {errors += chunk;});
    const closed = once(child, 'close'); children.push({child, closed});
    const message = once(child, 'message').then(([value]) => value as {status: string; code?: string; data?: string; identity?: string});
    return {child, message: Promise.race([message, closed.then(([code, signal]) => {
      throw new Error(`fixture helper closed before reporting: code=${code} signal=${signal} ${errors}`);
    })])};
  }
  const first = helper(data), held = await first.message;
  assert.equal(held.status, 'held');
  const direct = helper(data), aliased = helper(alias), independent = helper(separate);
  const [directResult, aliasResult, separateResult] = await Promise.all([direct.message, aliased.message, independent.message]);
  assert.deepEqual(directResult, {status: 'refused', code: 'HELPER_BUSY'});
  assert.deepEqual(aliasResult, {status: 'refused', code: 'HELPER_BUSY'});
  assert.equal(separateResult.status, 'held'); assert.notEqual(separateResult.identity, held.identity);
  assert.equal(held.identity, `${(await lstat(data)).dev}:${(await lstat(data)).ino}`);
});

test('Linux RunnerCore processes acquire ownership before authoritative loads across the same directory and alias', {
  skip: process.platform !== 'linux', timeout: 15_000,
}, async t => {
  const {root, data} = await fixture(t), alias = join(root, 'alias'), separate = join(root, 'separate');
  await symlink(data, alias); await mkdir(separate, {mode: 0o700});
  // These isolated empty fixtures have an explicit clean S2 migration boundary.
  // Production startup must continue refusing an uninitialized manifest.
  await initializeCleanRunnerJournal(data); await initializeCleanRunnerJournal(separate);
  const children: {child: ChildProcess; closed: Promise<unknown[]>}[] = [];
  t.after(async () => {
    for (const {child} of children) if (child.connected) child.send('release');
    await Promise.all(children.map(({closed}) => closed));
  });
  const script = `
    import {AdapterRegistry} from ${JSON.stringify(new URL('../src/runner/adapters/index.ts', import.meta.url).href)};
    import {RunnerCore} from ${JSON.stringify(new URL('../src/runner/runner.ts', import.meta.url).href)};
    const send = value => new Promise(done => process.send(value, done));
    const core = new RunnerCore({
      data: process.argv[1], registry: new AdapterRegistry([]),
      connections: async () => [], localAgents: async () => [],
      verifiedBuild: async () => true, allowedBuild: async () => true,
      stageSkills: async () => {}, removeDeviceKey: async () => {},
      deliver: async () => {throw new Error('An empty core must never deliver.');},
    });
    const active = core['state'].active.bind(core['state']);
    let activeLoads = 0;
    core['state'].active = async () => {activeLoads++; return active();};
    const started = performance.now();
    try {
      await core.init();
      process.once('message', async () => {await core.close(); process.disconnect();});
      await send({status: 'initialized', activeLoads, data: core.dataDirectory});
    } catch (error) {
      await core.close();
      await send({status: 'refused', code: error.code, activeLoads, elapsed: performance.now() - started});
      process.disconnect();
    }
  `;
  function helper(directory: string) {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, directory], {
      env: {}, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let errors = ''; child.stderr!.on('data', chunk => {errors += chunk;});
    const closed = once(child, 'close'); children.push({child, closed});
    const message = once(child, 'message').then(([value]) => value as {
      status: string; code?: string; activeLoads: number; elapsed?: number; data?: string;
    });
    return {child, closed, message: Promise.race([message, closed.then(([code, signal]) => {
      throw new Error(`RunnerCore fixture closed before reporting: code=${code} signal=${signal} ${errors}`);
    })])};
  }
  const first = helper(data);
  assert.deepEqual(await first.message, {status: 'initialized', activeLoads: 1, data});
  const direct = helper(data), aliased = helper(alias), independent = helper(separate);
  const [directResult, aliasResult, independentResult] = await Promise.all([direct.message, aliased.message, independent.message]);
  for (const result of [directResult, aliasResult]) {
    assert.equal(result.status, 'refused');
    assert.equal(result.code, 'RUNNER_STATE_UNAVAILABLE');
    assert.equal(result.activeLoads, 0, 'contenders cannot read authoritative state before acquiring ownership');
    assert(result.elapsed! < 10_000, 'lock contention must return bounded unavailable');
  }
  assert.deepEqual(independentResult, {status: 'initialized', activeLoads: 1, data: separate});
  first.child.send('release');
  assert.deepEqual(await first.closed, [0, null]);
  const successor = helper(alias);
  assert.deepEqual(await successor.message, {status: 'initialized', activeLoads: 1, data});
});
