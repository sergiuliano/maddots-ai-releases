import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { constants, fstatSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { clock } from '../src/config.js';
import { acquireDirectoryWriteGuard, acquireWriteGuard } from '../src/write-lock.js';

test('Linux flock refusal is bounded without signaling and retains its descriptor until utility close', {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-flock-retained-'));
  await chmod(root, 0o700);
  const path = join(root, '.guard');
  const processes = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
  const filesystem = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises');
  const originalSpawn = processes.spawn, originalKill = process.kill;
  const originalOpen = filesystem.open;
  const child = Object.assign(new EventEmitter(), {pid: 777777, exitCode: null, signalCode: null});
  let descriptor = -1, signalCalls = 0, spawnCalls = 0, spawned!: () => void;
  let openedUtilityFile = false, closeStarted!: () => void, finishClose!: () => void, closed!: () => void;
  const closeRequested = new Promise<void>(resolve => {closeStarted = resolve;});
  const closeDelay = new Promise<void>(resolve => {finishClose = resolve;});
  const closeFinished = new Promise<void>(resolve => {closed = resolve;});
  const utilityStarted = new Promise<void>(resolve => {spawned = resolve;});
  filesystem.open = (async (...args: Parameters<typeof originalOpen>) => {
    const file = await originalOpen(...args);
    if (args[0] === path && !openedUtilityFile) {
      openedUtilityFile = true;
      const close = file.close.bind(file);
      file.close = async () => {
        closeStarted();
        // Model a close queued behind occupied libuv workers without relying on
        // a particular CPU speed, thread-pool size or number of event-loop turns.
        await closeDelay;
        try { await close(); } finally {closed();}
      };
    }
    return file;
  }) as typeof originalOpen;
  processes.spawn = ((_file: string, _args: string[], options: {stdio: unknown[]}) => {
    spawnCalls++; descriptor = options.stdio[3] as number; spawned(); return child;
  }) as typeof originalSpawn;
  process.kill = (() => {signalCalls++; throw new Error('numeric signal forbidden');}) as typeof process.kill;
  syncBuiltinESMExports();
  t.mock.timers.enable({apis: ['Date', 'setTimeout']});
  const timing = {now: () => Date.now(), sleep: clock.sleep};
  let release: (() => Promise<void>) | undefined;
  const acquisition = acquireWriteGuard(path, timing, Date.now() + 10_000).then(value => {release = value;});
  void acquisition.catch(() => {});
  try {
    await utilityStarted;
    t.mock.timers.tick(2001);
    await assert.rejects(acquisition, {code: 'LOCK_UNSAFE'});
    assert.equal(signalCalls, 0, 'utility deadlines must never signal a numeric process target');
    assert.doesNotThrow(() => fstatSync(descriptor), 'timed-out utility still owns its original descriptor');
    await assert.rejects(acquireWriteGuard(path, timing, Date.now() + 100), {code: 'HELPER_BUSY'});
    assert.equal(spawnCalls, 1, 'a pending utility cannot be replaced or overlapped');
    child.emit('close', 0, null);
    await closeRequested;
    // Ten turns do not prove FileHandle.close() completed when libuv is busy.
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
    assert.doesNotThrow(() => fstatSync(descriptor), 'the delayed close remains pending across event-loop turns');
    finishClose();
    await closeFinished;
    assert.throws(() => fstatSync(descriptor), {code: 'EBADF'});
  } finally {
    finishClose();
    child.emit('close', 0, null);
    await acquisition.catch(() => {}); await release?.();
    if (openedUtilityFile) await closeFinished;
    t.mock.timers.reset();
    filesystem.open = originalOpen; processes.spawn = originalSpawn; process.kill = originalKill; syncBuiltinESMExports();
    await rm(root, {recursive: true, force: true});
  }
});

test('Linux directory flock retains its own inode across caller close, alias rename and guard replacement until utility close settles', {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-directory-flock-retained-'));
  await chmod(root, 0o700);
  const data = join(root, 'data'), renamed = join(root, 'renamed'), alias = join(root, 'alias');
  await mkdir(data, {mode: 0o700});
  const guard = join(data, '.runner-storage.guard');
  await writeFile(guard, '', {mode: 0o600});
  const processes = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
  const filesystem = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises');
  const originalSpawn = processes.spawn, originalKill = process.kill, originalOpen = filesystem.open;
  const directory = await originalOpen(data, constants.O_RDONLY | constants.O_DIRECTORY | 0x80000);
  const initial = await directory.stat();
  const child = Object.assign(new EventEmitter(), {pid: 777778, exitCode: null, signalCode: null});
  let descriptor = -1, signalCalls = 0, spawnCalls = 0, spawned!: () => void;
  let openedUtilityFile = false, closeStarted!: () => void, finishClose!: () => void, closed!: () => void;
  const closeRequested = new Promise<void>(resolve => {closeStarted = resolve;});
  const closeDelay = new Promise<void>(resolve => {finishClose = resolve;});
  const closeFinished = new Promise<void>(resolve => {closed = resolve;});
  const utilityStarted = new Promise<void>(resolve => {spawned = resolve;});
  filesystem.open = (async (...args: Parameters<typeof originalOpen>) => {
    const file = await originalOpen(...args);
    if (args[0] === `/proc/self/fd/${directory.fd}/.` && !openedUtilityFile) {
      openedUtilityFile = true;
      const close = file.close.bind(file);
      file.close = async () => {
        closeStarted();
        await closeDelay;
        try {await close();} finally {closed();}
      };
    }
    return file;
  }) as typeof originalOpen;
  processes.spawn = ((...args: Parameters<typeof originalSpawn>) => {
    spawnCalls++;
    if (spawnCalls > 1) return originalSpawn(...args);
    descriptor = (args[2]!.stdio as unknown[])[3] as number;
    spawned(); return child;
  }) as typeof originalSpawn;
  process.kill = (() => {signalCalls++; throw new Error('numeric signal forbidden');}) as typeof process.kill;
  syncBuiltinESMExports();
  t.mock.timers.enable({apis: ['Date', 'setTimeout']});
  const timing = {now: () => Date.now(), sleep: clock.sleep};
  let release: (() => Promise<void>) | undefined;
  let aliasDirectory: Awaited<ReturnType<typeof originalOpen>> | undefined;
  const acquisition = acquireDirectoryWriteGuard(directory, timing, Date.now() + 10_000).then(value => {release = value;});
  void acquisition.catch(() => {});
  // A native utility uses the selected open description, independently of the
  // mocked child's lifecycle. A separately opened descriptor tests kernel
  // exclusion without relying on the process-local pending-utility registry.
  const nativeFlock = async (fd: number) => {
    const utility = originalSpawn('/usr/bin/flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '75', '3'], {
      env: {}, stdio: ['ignore', 'ignore', 'pipe', fd],
    });
    const [code, signal] = await once(utility, 'close');
    assert.equal(signal, null);
    return code;
  };
  try {
    await utilityStarted;
    assert.notEqual(descriptor, directory.fd, 'the utility owns an independently opened directory descriptor');
    const flags = /^flags:\s+([0-7]+)$/mu.exec(await readFile(`/proc/self/fdinfo/${descriptor}`, 'utf8'))![1];
    assert.ok(Number.parseInt(flags, 8) & 0x80000, 'the utility parent descriptor is close-on-exec');
    t.mock.timers.tick(2001);
    await assert.rejects(acquisition, {code: 'LOCK_UNSAFE'});
    await directory.close();
    assert.equal(fstatSync(descriptor).ino, initial.ino, 'caller cleanup cannot close the retained utility descriptor');
    await rename(data, renamed); await symlink(renamed, alias);
    await rename(join(renamed, '.runner-storage.guard'), join(renamed, '.saved.guard'));
    await writeFile(join(renamed, '.runner-storage.guard'), '', {mode: 0o600});
    aliasDirectory = await originalOpen(alias, constants.O_RDONLY | constants.O_DIRECTORY | 0x80000);
    assert.equal((await aliasDirectory.stat()).ino, initial.ino);
    await assert.rejects(acquireDirectoryWriteGuard(aliasDirectory, timing, Date.now() + 100), {code: 'HELPER_BUSY'});
    assert.equal(spawnCalls, 1, 'renaming the directory and replacing a child guard cannot overlap the delayed utility');
    assert.equal(await nativeFlock(descriptor), 0, 'the delayed utility can still acquire its original open description');
    assert.equal(await nativeFlock(aliasDirectory.fd), 75, 'the renamed alias contends on the same directory inode');
    child.emit('close', 0, null);
    await closeRequested;
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(await nativeFlock(aliasDirectory.fd), 75, 'utility exit alone cannot release a lock whose descriptor close is pending');
    await assert.rejects(acquireDirectoryWriteGuard(aliasDirectory, timing, Date.now() + 100), {code: 'HELPER_BUSY'});
    assert.equal(spawnCalls, 1, 'late close settlement must still refuse a replacement utility');
    assert.equal(signalCalls, 0, 'a delayed directory utility must never receive a numeric signal');
    finishClose(); await closeFinished;
    assert.throws(() => fstatSync(descriptor), {code: 'EBADF'});
    release = await acquireDirectoryWriteGuard(aliasDirectory, timing, Date.now() + 1000);
    assert.equal(spawnCalls, 2, 'the same inode becomes available after retained close settles');
    assert.equal(await nativeFlock(aliasDirectory.fd), 75, 'the successor owns the same directory kernel lock');
    await release();
    assert.equal(await nativeFlock(aliasDirectory.fd), 0, 'successor release closes its independent lock description');
  } finally {
    finishClose(); child.emit('close', 0, null);
    await acquisition.catch(() => {}); await release?.();
    if (openedUtilityFile) await closeFinished;
    await directory.close(); await aliasDirectory?.close();
    t.mock.timers.reset();
    filesystem.open = originalOpen; processes.spawn = originalSpawn; process.kill = originalKill; syncBuiltinESMExports();
    await rm(root, {recursive: true, force: true});
  }
});
