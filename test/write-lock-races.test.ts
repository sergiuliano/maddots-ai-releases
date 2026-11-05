import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { withAgentDestinationLocks } from '../src/agent-fence.js';
import type { Timing } from '../src/config.js';
import { entryKey } from '../src/lock.js';
import { withWriteLock, type HelperPaths } from '../src/paths.js';

const promisesModule = createRequire(import.meta.url)('node:fs/promises') as typeof fsp;
const crashedPid = 2_147_483_647;
const exclusiveDarwinLock = 0x20;
const errno = (code: string) => Object.assign(new Error(code), {code});
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => {resolve = done;});
  return {promise, resolve};
}

async function fixture(t: TestContext, platform: NodeJS.Platform = 'darwin') {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-write-lock-races-'));
  const data = join(root, 'data'); await mkdir(data, {mode: 0o700});
  const paths: HelperPaths = {home: root, data, logs: join(data, 'logs'), holding: join(data, 'holding'),
    backups: join(data, 'backups'), state: join(data, 'state.json'), lock: join(data, '.lock'),
    servicePlist: join(root, 'helper.plist'), routes: []};
  const originalOpen = promisesModule.open, originalUnlink = promisesModule.unlink, originalKill = process.kill;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  if (platform) Object.defineProperty(process, 'platform', {...originalPlatform, value: platform});
  const heldGuards = new Map<string, fsp.FileHandle>(), handles = new Set<fsp.FileHandle>();
  const guardAttempts: number[] = [], events: string[] = [], pending: Promise<unknown>[] = [];
  const resumes: (() => void)[] = [];
  const hooks: {lock: string; beforeUnlink?: () => Promise<void>; afterUnlink?: () => Promise<void>;
    guardError?: () => Error | undefined; initializeError?: {method: 'writeFile' | 'sync'; failure: Error}} = {lock: paths.lock};
  let closing = false, creations = 0, inside = 0, maximumInside = 0;
  function gate() {
    const result = deferred(); resumes.push(() => result.resolve());
    if (closing) result.resolve();
    return result;
  }
  function clock() {
    let now = 0, changed = deferred();
    const requests: {milliseconds: number; resume: () => void}[] = [];
    const timing: Timing = {now: () => now, sleep: async milliseconds => {
      const resume = gate(); requests.push({milliseconds, resume: () => resume.resolve()});
      changed.resolve(); changed = deferred();
      await resume.promise; now += milliseconds;
    }};
    return {timing, requests, wait: async (index: number) => {
      while (requests.length <= index) await changed.promise;
      return requests[index];
    }};
  }
  function track<T>(promise: Promise<T>) {
    pending.push(promise); void promise.catch(() => {}); return promise;
  }
  // Model a kernel-released lock independently of the host. The real guard flags
  // are asserted before stripping Darwin's bit from the backing file open.
  promisesModule.open = (async (...args: Parameters<typeof originalOpen>) => {
    const path = String(args[0]), flags = args[1];
    if (!path.endsWith('.guard')) {
      if (path === hooks.lock && typeof flags === 'number' && (flags & constants.O_CREAT)) creations++;
      return originalOpen(...args);
    }
    assert.equal(typeof flags, 'number');
    const required = constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK |
      (process.platform === 'darwin' ? exclusiveDarwinLock : constants.O_EXCL);
    assert.equal((flags as number) & required, required, 'acquire the guard atomically with no-follow and nonblocking flags');
    assert.equal(args[2], 0o600);
    guardAttempts.push(flags as number); events.push('guard attempt');
    const failure = hooks.guardError?.(); if (failure) throw failure;
    if (heldGuards.has(path)) throw errno(process.platform === 'darwin' ? 'EWOULDBLOCK' : 'EEXIST');
    // Reserve before awaiting the real filesystem, just as atomic open/flock does.
    heldGuards.set(path, undefined as unknown as fsp.FileHandle);
    let file: fsp.FileHandle;
    try {
      file = await originalOpen(args[0], process.platform === 'darwin' ? (flags as number) & ~exclusiveDarwinLock : flags, args[2]);
    } catch (error) {heldGuards.delete(path); throw error;}
    heldGuards.set(path, file); handles.add(file);
    const close = file.close.bind(file);
    file.close = async () => {
      await close(); handles.delete(file);
      if (heldGuards.get(path) === file) heldGuards.delete(path);
      events.push('guard closed');
    };
    if (hooks.initializeError) {
      const {method, failure} = hooks.initializeError;
      file[method] = async () => {throw failure;};
    }
    return file;
  }) as typeof originalOpen;
  promisesModule.unlink = (async (...args: Parameters<typeof originalUnlink>) => {
    const path = String(args[0]);
    if (path.endsWith('.guard') && process.platform === 'darwin') assert.fail('a kernel guard inode must never be unlinked');
    if (path === hooks.lock) {
      assert.equal(heldGuards.has(path + '.guard'), true, 'stale recovery and release must hold the guard');
      await hooks.beforeUnlink?.();
    }
    await originalUnlink(...args);
    if (path === hooks.lock) {events.push('lock unlinked'); await hooks.afterUnlink?.();}
  }) as typeof originalUnlink;
  process.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
    if (pid === crashedPid) throw errno('ESRCH');
    return originalKill(pid, signal);
  }) as typeof originalKill;
  syncBuiltinESMExports();
  t.after(async () => {
    closing = true; for (const resume of resumes) resume();
    await Promise.allSettled(pending);
    for (const file of handles) await file.close();
    promisesModule.open = originalOpen; promisesModule.unlink = originalUnlink; process.kill = originalKill;
    Object.defineProperty(process, 'platform', originalPlatform);
    syncBuiltinESMExports(); await rm(root, {recursive: true, force: true});
  });
  async function seed(pid = crashedPid) {
    const file = await originalOpen(hooks.lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {await file.writeFile(String(pid));} finally {await file.close();}
  }
  type Acquire = (action: (release: () => Promise<void>) => Promise<void>, timing: Timing) => Promise<void>;
  function holder(name: string, acquire: Acquire = (action, timing) =>
    withWriteLock(paths, action, timing, pid => pid !== crashedPid)) {
    const entered = gate(), finish = gate(), timer = clock();
    const done = track(acquire(async () => {
      inside++; maximumInside = Math.max(maximumInside, inside); events.push(name + ' entered'); entered.resolve();
      try {await finish.promise;} finally {inside--;}
    }, timer.timing));
    return {name, entered, finish, timer, done};
  }
  async function blocked(contender: ReturnType<typeof holder>, retry: number) {
    return Promise.race([contender.timer.wait(retry),
      contender.entered.promise.then(() => {throw new Error(contender.name + ' entered while another holder owned the guard');}),
      contender.done.then(() => {throw new Error(contender.name + ' finished before waiting for the guard');})]);
  }
  async function reached<T>(promise: Promise<T>, task: Promise<unknown>): Promise<T> {
    return Promise.race([promise, task.then(() => {throw new Error('holder finished before the injected filesystem pause');})]);
  }
  return {root, paths, hooks, gate, clock, track, holder, blocked, reached, seed, originalOpen, originalUnlink,
    heldGuards, guardAttempts, events, creations: () => creations, maximumInside: () => maximumInside};
}

for (const contenders of [2, 3]) {
  test(`${contenders} contenders cannot unlink a new live lock after checking the same crashed holder`, {timeout: 10_000}, async t => {
    const f = await fixture(t); await f.seed();
    const stale = await lstat(f.paths.lock), checked = f.gate(), remove = f.gate();
    let paused = false;
    f.hooks.beforeUnlink = async () => {
      if (!paused) {paused = true; checked.resolve(); await remove.promise;}
    };
    const first = f.holder('first'); await f.reached(checked.promise, first.done);
    // This is the old failing boundary: the dead inode was checked, but its
    // pathname unlink has not run. Every other contender is explicitly advanced.
    const others = Array.from({length: contenders - 1}, (_, i) => f.holder('contender ' + (i + 2)));
    for (const other of others) {
      (await f.blocked(other, 0)).resume(); await f.blocked(other, 1);
    }
    assert.equal((await lstat(f.paths.lock)).ino, stale.ino);
    assert.equal(f.creations(), 1, 'other contenders cannot reach .lock acquisition or stale recovery');
    remove.resolve(); await f.reached(first.entered.promise, first.done);
    const live = await lstat(f.paths.lock);
    assert.equal(await readFile(f.paths.lock, 'utf8'), String(process.pid));
    for (const other of others) {
      other.timer.requests[1].resume(); await f.blocked(other, 2);
      assert.equal((await lstat(f.paths.lock)).ino, live.ino);
    }
    first.finish.resolve(); await first.done;
    for (const other of others) {
      other.timer.requests[2].resume(); await f.reached(other.entered.promise, other.done);
      assert.equal(f.maximumInside(), 1);
      other.finish.resolve(); await other.done;
    }
    assert.equal(f.maximumInside(), 1); assert.ok(f.guardAttempts.length >= contenders);
    assert.equal(f.heldGuards.size, 0);
    assert.ok(f.events.lastIndexOf('guard closed') > f.events.lastIndexOf('lock unlinked'), 'the guard closes after lock removal');
    if (process.platform === 'darwin') assert.equal((await lstat(f.paths.lock + '.guard')).nlink, 1);
  });
}

test('fresh acquisition cannot enter the gap after stale removal and before replacement creation', {timeout: 10_000}, async t => {
  const f = await fixture(t); await f.seed();
  const removed = f.gate(), replace = f.gate(); let paused = false;
  f.hooks.afterUnlink = async () => {
    if (!paused) {paused = true; removed.resolve(); await replace.promise;}
  };
  const recovery = f.holder('recovery'); await f.reached(removed.promise, recovery.done);
  await assert.rejects(lstat(f.paths.lock), {code: 'ENOENT'});
  const fresh = f.holder('fresh'); (await f.blocked(fresh, 0)).resume(); await f.blocked(fresh, 1);
  assert.equal(f.creations(), 1, 'a missing .lock does not bypass the held guard');
  replace.resolve(); await f.reached(recovery.entered.promise, recovery.done);
  fresh.timer.requests[1].resume(); await f.blocked(fresh, 2);
  recovery.finish.resolve(); await recovery.done;
  fresh.timer.requests[2].resume(); await f.reached(fresh.entered.promise, fresh.done);
  fresh.finish.resolve(); await fresh.done; assert.equal(f.maximumInside(), 1);
});

test('late release after recovery and early release preserves a replacement holder', {timeout: 10_000}, async t => {
  const f = await fixture(t); await f.seed();
  const released = f.gate(), finishOld = f.gate();
  let lateRelease!: () => Promise<void>;
  const old = f.track(withWriteLock(f.paths, async release => {
    lateRelease = release; await release(); released.resolve(); await finishOld.promise;
  }, undefined, pid => pid !== crashedPid));
  await f.reached(released.promise, old);
  const replacement = f.holder('replacement'); await f.reached(replacement.entered.promise, replacement.done);
  const identity = await lstat(f.paths.lock);
  await lateRelease(); finishOld.resolve(); await old;
  assert.equal((await lstat(f.paths.lock)).ino, identity.ino);
  const waiting = f.holder('waiting'); await f.blocked(waiting, 0);
  assert.equal(await readFile(f.paths.lock, 'utf8'), String(process.pid));
  replacement.finish.resolve(); await replacement.done;
  waiting.timer.requests[0].resume(); await f.reached(waiting.entered.promise, waiting.done);
  waiting.finish.resolve(); await waiting.done;
});

test('release compares its descriptor identity and preserves an externally replaced .lock inode', {timeout: 10_000}, async t => {
  const f = await fixture(t), first = f.holder('first'); await f.reached(first.entered.promise, first.done);
  const old = await lstat(f.paths.lock);
  await f.originalUnlink(f.paths.lock); await f.seed(process.pid);
  const replacement = await lstat(f.paths.lock); assert.notEqual(replacement.ino, old.ino);
  first.finish.resolve(); await first.done;
  assert.equal((await lstat(f.paths.lock)).ino, replacement.ino);
  assert.equal(await readFile(f.paths.lock, 'utf8'), String(process.pid)); assert.equal(f.heldGuards.size, 0);
});

test('sync and runner destination fences exclude each other while recovering a crashed holder', {timeout: 10_000}, async t => {
  const f = await fixture(t), destination = {agentId: 'race-agent', skillId: 'race-skill', target: 'folder' as const, name: 'example'};
  const directory = join(f.paths.data, 'agent-fences'); await mkdir(directory, {mode: 0o700});
  const key = createHash('sha256').update(JSON.stringify([destination.agentId, entryKey(destination)])).digest('hex');
  f.hooks.lock = join(directory, key + '.lock'); await f.seed();
  const checked = f.gate(), recover = f.gate(); let paused = false;
  f.hooks.beforeUnlink = async () => {
    if (!paused) {paused = true; checked.resolve(); await recover.promise;}
  };
  const acquire = (action: (release: () => Promise<void>) => Promise<void>, timing: Timing) =>
    withAgentDestinationLocks(f.paths, [destination], action, timing);
  const sync = f.holder('sync', acquire); await f.reached(checked.promise, sync.done);
  const runner = f.holder('runner', acquire); (await f.blocked(runner, 0)).resume(); await f.blocked(runner, 1);
  assert.equal(f.creations(), 1);
  recover.resolve(); await f.reached(sync.entered.promise, sync.done);
  const live = await lstat(f.hooks.lock);
  runner.timer.requests[1].resume(); await f.blocked(runner, 2);
  assert.equal((await lstat(f.hooks.lock)).ino, live.ino);
  sync.finish.resolve(); await sync.done;
  runner.timer.requests[2].resume(); await f.reached(runner.entered.promise, runner.done);
  runner.finish.resolve(); await runner.done; assert.equal(f.maximumInside(), 1);
});

for (const code of ['EACCES', 'EIO', 'ENOTSUP']) {
  test(`guard acquisition ${code} fails closed before touching .lock`, async t => {
    const f = await fixture(t); await f.seed(); const identity = await lstat(f.paths.lock);
    const failure = errno(code); f.hooks.guardError = () => failure;
    let entered = false;
    await assert.rejects(withWriteLock(f.paths, async () => {entered = true;}), error => error === failure);
    assert.equal(entered, false); assert.equal(f.creations(), 0);
    assert.equal((await lstat(f.paths.lock)).ino, identity.ino); assert.equal(f.heldGuards.size, 0);
  });
}

test('guard contention uses the shared deadline and leaves the crashed .lock untouched on timeout', async t => {
  const f = await fixture(t); await f.seed(); const identity = await lstat(f.paths.lock);
  f.hooks.guardError = () => errno(process.platform === 'darwin' ? 'EAGAIN' : 'EEXIST');
  let now = 0, entered = false;
  const sleeps: number[] = [], timing: Timing = {now: () => now, sleep: async ms => {sleeps.push(ms); now += ms;}};
  await assert.rejects(withWriteLock(f.paths, async () => {entered = true;}, timing, () => false, 125), {code: 'HELPER_BUSY'});
  assert.equal(entered, false); assert.deepEqual(sleeps, [50, 50, 50]);
  assert.equal(f.creations(), 0); assert.equal((await lstat(f.paths.lock)).ino, identity.ino);
});

test('Darwin retains the crashed guard inode across recovery, repeated acquisition and action failure', async t => {
  const f = await fixture(t, 'darwin'); await f.seed();
  const guard = f.paths.lock + '.guard';
  const crashedGuard = await f.originalOpen(guard, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
  await crashedGuard.close();
  const original = await lstat(guard), failure = new Error('action failed');
  for (let i = 0; i < 3; i++) {
    const task = withWriteLock(f.paths, async () => {
      assert.equal((await lstat(guard)).ino, original.ino);
      assert.equal((await lstat(f.paths.lock)).mode & 0o777, 0o600);
      assert.equal(await readFile(f.paths.lock, 'utf8'), String(process.pid));
      if (i === 1) throw failure;
    }, undefined, pid => pid !== crashedPid);
    if (i === 1) await assert.rejects(task, error => error === failure);
    else await task;
    assert.equal((await lstat(guard)).ino, original.ino); assert.equal(f.heldGuards.size, 0);
    await assert.rejects(lstat(f.paths.lock), {code: 'ENOENT'});
  }
  assert.equal(f.guardAttempts.length, 3);
});

test('unsupported-platform fallback never reclaims an abandoned guard with a dead PID', async t => {
  const f = await fixture(t, 'freebsd'); await f.seed();
  const guard = f.paths.lock + '.guard';
  const abandoned = await f.originalOpen(guard, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  await abandoned.writeFile(String(crashedPid)); await abandoned.close();
  const originalGuard = await lstat(guard), originalLock = await lstat(f.paths.lock);
  let now = 0, entered = false;
  const sleeps: number[] = [], timing: Timing = {now: () => now, sleep: async ms => {sleeps.push(ms); now += ms;}};
  await assert.rejects(withWriteLock(f.paths, async () => {entered = true;}, timing, () => false, 100), {code: 'HELPER_BUSY'});
  assert.equal(entered, false); assert.equal(now, 100); assert.deepEqual(sleeps, [50, 50]);
  assert.equal(f.creations(), 0); assert.equal((await lstat(guard)).ino, originalGuard.ino);
  assert.equal((await lstat(f.paths.lock)).ino, originalLock.ino);
  assert.equal(await readFile(guard, 'utf8'), String(crashedPid));
});

for (const method of ['writeFile', 'sync'] as const) {
  test(`unsupported-platform fallback cleans up its guard when initial ${method} fails`, async t => {
    const f = await fixture(t, 'freebsd'), failure = errno('EIO');
    f.hooks.initializeError = {method, failure};
    let entered = false;
    await assert.rejects(withWriteLock(f.paths, async () => {entered = true;}), error => error === failure);
    assert.equal(entered, false); assert.equal(f.creations(), 0); assert.equal(f.heldGuards.size, 0);
    await assert.rejects(lstat(f.paths.lock + '.guard'), {code: 'ENOENT'});
    f.hooks.initializeError = undefined;
    await withWriteLock(f.paths, async () => {entered = true;});
    assert.equal(entered, true); await assert.rejects(lstat(f.paths.lock + '.guard'), {code: 'ENOENT'});
  });
}
