import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import test, { type TestContext } from 'node:test';
import { clock, type Timing } from '../src/config.js';
import { acquireWriteGuard, withWriteLock } from '../src/write-lock.js';
import type { HelperPaths } from '../src/paths.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-linux-flock-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, {recursive: true, force: true}));
  return join(root, '.lock.guard');
}

test('Linux flock excludes contenders and keeps its inode after release and errors', {skip: process.platform !== 'linux'}, async t => {
  const path = await fixture(t), release = await acquireWriteGuard(path, clock, Date.now() + 5000);
  const inode = (await lstat(path)).ino;
  let now = 0;
  const timing: Timing = {now: () => now, sleep: async ms => {now += ms;}};
  await assert.rejects(acquireWriteGuard(path, timing, 100), {code: 'HELPER_BUSY'});
  assert.equal((await lstat(path)).ino, inode);
  await release();
  for (let i = 0; i < 3; i++) {
    const unlock = await acquireWriteGuard(path, clock, Date.now() + 5000);
    assert.equal((await lstat(path)).ino, inode);
    await unlock();
  }
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
});

test('Linux kernel guard rejects unsafe files before entering the writer', {skip: process.platform !== 'linux'}, async t => {
  const path = await fixture(t);
  await writeFile(path, '', {mode: 0o644});
  await assert.rejects(acquireWriteGuard(path, clock, Date.now() + 5000), {code: 'LOCK_UNSAFE'});
  await rm(path); await mkdir(path, {mode: 0o700});
  await assert.rejects(acquireWriteGuard(path, clock, Date.now() + 5000));
  await rm(path, {recursive: true}); await symlink('/dev/null', path);
  await assert.rejects(acquireWriteGuard(path, clock, Date.now() + 5000));
});

test('Linux flock command errors fail closed and close their verified descriptor', {skip: process.platform !== 'linux'}, async t => {
  const path = await fixture(t);
  const processes = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
  const original = processes.spawn;
  t.after(() => {processes.spawn = original; syncBuiltinESMExports();});
  for (const outcome of ['missing', 'error', 'signal'] as const) {
    processes.spawn = ((file: string, args: string[], options: {env: NodeJS.ProcessEnv; stdio: unknown[]}) => {
      assert.equal(file, '/usr/bin/flock');
      assert.deepEqual(args, ['--exclusive', '--nonblock', '--conflict-exit-code', '75', '3']);
      assert.deepEqual(options.env, {});
      assert.deepEqual(options.stdio.slice(0, 3), ['ignore', 'ignore', 'ignore']);
      assert.equal(typeof options.stdio[3], 'number');
      const child = new EventEmitter();
      queueMicrotask(() => {
        if (outcome === 'missing') {
          child.emit('error', Object.assign(new Error('PRIVATE_DETAILS'), {code: 'ENOENT'}));
          child.emit('close', -2, null);
        }
        else child.emit('close', outcome === 'error' ? 70 : null, outcome === 'signal' ? 'SIGKILL' : null);
      });
      return child;
    }) as typeof original;
    syncBuiltinESMExports();
    const before = (await readdir('/proc/self/fd')).length;
    await assert.rejects(acquireWriteGuard(path, clock, Date.now() + 5000), error => error instanceof Error &&
      'code' in error && error.code === 'LOCK_UNSAFE' && !error.message.includes('PRIVATE'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await readdir('/proc/self/fd')).length, before);
  }
});

test('Linux SIGKILL releases the stable inode even while an ordinary child remains alive', {skip: process.platform !== 'linux', timeout: 15_000}, async t => {
  const path = await fixture(t);
  const readyFile = join(dirname(path), 'ready.json');
  const script = `
    import {spawn} from 'node:child_process';
    import {writeFile} from 'node:fs/promises';
    import {withWriteLock} from ${JSON.stringify(new URL('../src/write-lock.ts', import.meta.url).href)};
    const timing = {now: Date.now, sleep: ms => new Promise(done => setTimeout(done, ms))};
    await withWriteLock(${JSON.stringify({data: dirname(path), lock: join(dirname(path), '.lock')})}, async () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});
      await writeFile(${JSON.stringify(readyFile)}, JSON.stringify({pid: child.pid}), {mode: 0o600});
      await new Promise(() => {setInterval(() => {}, 1000);});
    }, timing);
  `;
  const holder = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    stdio: 'ignore',
  });
  const descendant: {pid?: number} = {};
  t.after(async () => {
    holder.kill('SIGKILL');
    if (descendant.pid) try { process.kill(descendant.pid, 'SIGKILL'); } catch { /* Already exited. */ }
    if (holder.exitCode === null && holder.signalCode === null) await once(holder, 'close');
  });
  const deadline = Date.now() + 5000;
  while (true) {
    try { descendant.pid = (JSON.parse(await readFile(readyFile, 'utf8')) as {pid: number}).pid; break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || Date.now() >= deadline) throw error;
      await clock.sleep(20);
    }
  }
  const childPid = descendant.pid;
  const inode = (await lstat(path)).ino;
  const descriptors = await readdir(`/proc/${childPid}/fd`);
  const targets = await Promise.all(descriptors.map(fd => readlink(`/proc/${childPid}/fd/${fd}`).catch(() => '')));
  assert.equal(targets.includes(path), false, 'tool descendants do not inherit the write guard');
  const closed = once(holder, 'close');
  holder.kill('SIGKILL'); await closed;
  await withWriteLock({data: dirname(path), lock: join(dirname(path), '.lock')} as HelperPaths, async () => {
    assert.equal((await lstat(path)).ino, inode);
    assert.doesNotThrow(() => process.kill(childPid, 0));
  });
});

test('Linux repeated acquisitions and contention do not leak descriptors', {skip: process.platform !== 'linux', timeout: 15_000}, async t => {
  const path = await fixture(t);
  const warm = await acquireWriteGuard(path, clock, Date.now() + 5000); await warm();
  const before = (await readdir('/proc/self/fd')).length;
  for (let i = 0; i < 20; i++) {
    const release = await acquireWriteGuard(path, clock, Date.now() + 5000);
    let now = 0;
    await assert.rejects(acquireWriteGuard(path, {now: () => now, sleep: async ms => {now += ms;}}, 50), {code: 'HELPER_BUSY'});
    await release();
  }
  assert.equal((await readdir('/proc/self/fd')).length, before);
});
