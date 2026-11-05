// maddots-write-lock-protocol: 3
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, unlink, type FileHandle } from 'node:fs/promises';
import { HelperError, clock, type Timing } from './config.js';
import { assertNoSymlinks, ensurePrivateDirectory, readPrivateFile, type HelperPaths } from './paths.js';
import { assertLockUpgradeReady } from './write-lock-upgrade.js';
import { linuxProcessIdentity } from './linux-proc.js';
import { signalIfStillOwned } from './runner/signal-gate.js';

const owner = () => process.getuid?.();
async function processAlive(pid: number): Promise<boolean> {
  if (process.platform === 'linux') return await linuxProcessIdentity(pid) !== null;
  try { return (await signalIfStillOwned({kind: 'probe', pid}, 0)).status === 'sent'; }
  catch { return true; }
}
const lockBusy = () => new HelperError('HELPER_BUSY', 'Another helper command is writing. Try again shortly.');
const sameFile = (a: {dev: number; ino: number}, b: {dev: number; ino: number}) => a.dev === b.dev && a.ino === b.ino;
// Node/libuv also sets close-on-exec, but request it at the Linux open itself.
// Node does not expose Linux's O_CLOEXEC in fs.constants.
const linuxCloseOnExec = 0x80000;
const pendingLinuxUtilities = new Map<string, {file: FileHandle; child: ReturnType<typeof spawn>; settlement: Promise<void>}>();
class RetainedUtilityRefusal extends HelperError {
  constructor() { super('LOCK_UNSAFE', 'The helper could not acquire its Linux kernel write lock. Check that /usr/bin/flock is available, then retry.'); }
}

// flock(1) operates on the inherited open file description, so the parent keeps
// the kernel lock after the short-lived utility exits. Node opens its original
// descriptor close-on-exec; only this explicitly selected child receives FD 3.
function linuxFlock(file: FileHandle, identity: string, remaining: number): Promise<boolean> {
  if (pendingLinuxUtilities.has(identity)) return Promise.reject(lockBusy());
  return new Promise((resolve, reject) => {
    const failed = () => new HelperError('LOCK_UNSAFE', 'The helper could not acquire its Linux kernel write lock. Check that /usr/bin/flock is available, then retry.');
    const child = spawn('/usr/bin/flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '75', '3'], {
      env: {}, stdio: ['ignore', 'ignore', 'ignore', file.fd],
    });
    let settled!: () => void, retained = false;
    const settlement = new Promise<void>(done => {settled = done;});
    const responsibility = {file, child, settlement};
    pendingLinuxUtilities.set(identity, responsibility);
    const refuse = () => {
      if (retained) return;
      retained = true;
      // A timeout ends only this caller's wait. A utility that is delayed before
      // flock may still acquire the inherited open description later. Keep the
      // original FD and child strongly reachable, with no replacement attempt,
      // until close proves that utility can no longer acquire or hold the lock.
      void settlement.then(async () => {
        await file.close();
        if (pendingLinuxUtilities.get(identity) === responsibility) pendingLinuxUtilities.delete(identity);
      }).catch(() => {}); // Failed close retains responsibility and refuses reuse.
      reject(new RetainedUtilityRefusal());
    };
    const timeout = setTimeout(refuse, Math.max(1, Math.min(2000, remaining)));
    child.once('error', () => { clearTimeout(timeout); refuse(); });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      settled();
      if (retained) return;
      if (pendingLinuxUtilities.get(identity) === responsibility) pendingLinuxUtilities.delete(identity);
      if (signal || (code !== 0 && code !== 75)) reject(failed());
      else resolve(code === 0);
    });
  });
}

// Call only while holding the guard. Keeping the descriptor open also prevents
// inode reuse before the comparison. The guard makes compare/unlink indivisible
// with respect to other acquisitions, recoveries and releases.
async function removeOwnedLock(path: string, file: FileHandle): Promise<void> {
  const held = await file.stat();
  try { if (sameFile(held, await lstat(path))) await unlink(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

export type WriteGuardRelease = (() => Promise<void>) & {assertCurrent(): Promise<void>};
export type DirectoryWriteGuardProgress = 'acquiring' | 'contended';

/** Linux runner exclusion is the directory inode, never a replaceable child name. */
export async function acquireDirectoryWriteGuard(directory: FileHandle, timing: Timing, deadline: number,
  progress?: (state: DirectoryWriteGuardProgress) => void): Promise<WriteGuardRelease> {
  progress?.('acquiring');
  if (process.platform !== 'linux') throw new HelperError('LOCK_UNSAFE', 'Directory write locks require Linux.');
  const retained = await directory.stat();
  if (!retained.isDirectory() || retained.uid !== owner() || (retained.mode & 0o777) !== 0o700) {
    throw new HelperError('LOCK_UNSAFE', 'The runner lock requires a retained private directory.');
  }
  // Open the pinned object, not its public pathname. This independent open
  // description belongs to the lock utility even if acquisition times out and
  // the caller closes its original directory FD. Its inode cannot be recycled
  // while either reference survives, and aliases necessarily flock that inode.
  const file = await open(`/proc/self/fd/${directory.fd}/.`,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | linuxCloseOnExec);
  try {
    const info = await file.stat();
    if (!info.isDirectory() || !sameFile(retained, info) || info.uid !== owner() || (info.mode & 0o777) !== 0o700) {
      throw new HelperError('LOCK_UNSAFE', 'The runner lock directory was replaced.');
    }
    while (true) {
      if (timing.now() >= deadline) throw lockBusy();
      progress?.('acquiring');
      if (await linuxFlock(file, `${info.dev}:${info.ino}`, deadline - timing.now())) break;
      // Only a completed nonblocking flock conflict certifies contention.
      // Directory preparation or an outstanding utility remains unresolved.
      progress?.('contended');
      if (timing.now() >= deadline) throw lockBusy();
      await timing.sleep(50);
    }
    let released: Promise<void> | undefined;
    return Object.assign(() => released ??= file.close(), {assertCurrent: async () => {
      // The storage owner validates the retained directory's metadata and
      // namespace. No child pathname can change this kernel lock's identity.
      if (released) throw new HelperError('LOCK_UNSAFE', 'The runner directory lock was released.');
    }});
  } catch (error) {
    // linuxFlock retains its own directory FD until the utility's real close.
    if (!(error instanceof RetainedUtilityRefusal)) await file.close();
    throw error;
  }
}

export async function acquireWriteGuard(path: string, timing: Timing, deadline: number,
  retainedDirectory?: FileHandle): Promise<WriteGuardRelease> {
  // Darwin's <sys/fcntl.h> defines O_EXLOCK as 0x20; Node does not export it.
  // The kernel releases this flock on close/crash. NEVER unlink its stable inode:
  // replacing it would let two processes lock different inodes for the same path.
  const kernelLock = process.platform === 'darwin' || process.platform === 'linux';
  const flags = constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK |
    (process.platform === 'darwin' ? 0x20 : process.platform === 'linux' ? linuxCloseOnExec : constants.O_EXCL);
  while (true) {
    if (timing.now() >= deadline) throw lockBusy();
    if (retainedDirectory) {
      // Only the runner's Linux controller may supply this capability. The
      // procfs prefix is fixed by its live descriptor, with one local basename;
      // O_NOFOLLOW below still refuses a symlink at that basename.
      const prefix = `/proc/self/fd/${retainedDirectory.fd}/`, name = path.slice(prefix.length);
      const info = await retainedDirectory.stat();
      if (process.platform !== 'linux' || !path.startsWith(prefix) || !/^[A-Za-z0-9._-]+$/u.test(name) ||
          name === '.' || name === '..' || !info.isDirectory() || info.uid !== owner() || (info.mode & 0o777) !== 0o700) {
        throw new HelperError('LOCK_UNSAFE', 'The helper lock guard requires a retained private directory.');
      }
    } else await assertNoSymlinks(path);
    let guard: FileHandle;
    try { guard = await open(path, flags, 0o600); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (kernelLock ? code !== 'EAGAIN' && code !== 'EWOULDBLOCK' : code !== 'EEXIST') throw error;
      // Unsupported platforms use O_EXCL and deliberately never reclaim an
      // abandoned guard. PID/age checks would just repeat the stale-unlink race.
      if (timing.now() >= deadline) throw lockBusy();
      await timing.sleep(50); continue;
    }
    let retainedIdentity!: {dev: number; ino: number};
    try {
      const info = await guard.stat();
      if (!info.isFile() || info.uid !== owner() || (info.mode & 0o777) !== 0o600 || info.nlink !== 1) {
        throw new HelperError('LOCK_UNSAFE', 'The helper lock guard must be a private, owned, regular file with one link.');
      }
      if (!sameFile(info, await lstat(path))) throw new HelperError('LOCK_UNSAFE', 'The helper lock guard was replaced.');
      if (process.platform === 'linux') {
        if (!await linuxFlock(guard, `${info.dev}:${info.ino}`, deadline - timing.now())) {
          await guard.close();
          if (timing.now() >= deadline) throw lockBusy();
          await timing.sleep(50); continue;
        }
        if (!sameFile(info, await lstat(path))) throw new HelperError('LOCK_UNSAFE', 'The helper lock guard was replaced.');
      }
      if (!kernelLock) { await guard.writeFile(String(process.pid)); await guard.sync(); }
      retainedIdentity = {dev: info.dev, ino: info.ino};
    } catch (error) {
      if (error instanceof RetainedUtilityRefusal) throw error;
      try { if (!kernelLock) await removeOwnedLock(path, guard); }
      finally { await guard.close(); }
      throw error;
    }
    let released = false;
    const release = async () => {
      released = true;
      try { if (!kernelLock) await removeOwnedLock(path, guard); }
      finally { await guard.close(); }
    };
    return Object.assign(release, {assertCurrent: async () => {
      if (retainedDirectory && released) throw new HelperError('LOCK_UNSAFE', 'The helper lock guard was released.');
      const descriptor = retainedDirectory ? undefined : await guard.stat();
      const current = await lstat(path);
      // A matching name beneath the retained directory is the locked inode:
      // guard stays open until release, so its identity cannot be recycled.
      // Avoid a second metadata read of that same inode for bound Linux guards.
      const held = descriptor ?? current;
      if (!held.isFile() || !current.isFile() || !sameFile(retainedIdentity, held) || !sameFile(retainedIdentity, current) ||
          held.nlink !== 1 || current.nlink !== 1 || held.uid !== owner() || current.uid !== owner() ||
          (held.mode & 0o777) !== 0o600 || (current.mode & 0o777) !== 0o600) {
        throw new HelperError('LOCK_UNSAFE', 'The helper lock guard was replaced.');
      }
    }});
  }
}

export async function withWriteLock<T>(paths: HelperPaths, action: (release: () => Promise<void>) => Promise<T>, timing: Timing = clock,
  alive: (pid: number) => boolean | Promise<boolean> = processAlive, deadline = timing.now() + 10_000): Promise<T> {
  await assertLockUpgradeReady(paths, timing);
  await ensurePrivateDirectory(paths.data);
  const unlockGuard = await acquireWriteGuard(paths.lock + '.guard', timing, deadline);
  let file: FileHandle | undefined;
  let released: Promise<void> | undefined;
  const release = () => released ??= (async () => {
    try { if (file) await removeOwnedLock(paths.lock, file); }
    finally { try { await file?.close(); } finally { await unlockGuard(); } }
  })();
  try {
    while (!file) {
      if (timing.now() >= deadline) throw lockBusy();
      await assertNoSymlinks(paths.lock);
      try { file = await open(paths.lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          const previous = await lstat(paths.lock);
          const text = await readPrivateFile(paths.lock, 32);
          if (!text && timing.now() < deadline) { await timing.sleep(50); continue; }
          const pid = Number(text);
          if (!/^\d+$/.test(text) || !Number.isSafeInteger(pid) || pid <= 0) throw new HelperError('LOCK_UNSAFE', 'The helper lock is invalid. Inspect the private .lock file before reconnecting.');
          if (!await alive(pid)) {
            const latest = await lstat(paths.lock);
            if (sameFile(previous, latest)) await unlink(paths.lock);
            continue;
          }
        } catch (inspection) { if ((inspection as NodeJS.ErrnoException).code === 'ENOENT') continue; throw inspection; }
        if (timing.now() >= deadline) throw lockBusy();
        await timing.sleep(50);
      }
    }
    await file.writeFile(String(process.pid)); await file.sync(); return await action(release);
  }
  finally { await release(); }
}
