import { constants, lstatSync, readdirSync, type Stats } from 'node:fs';
import { lstat, open, readFile, realpath, type FileHandle } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { HelperError, clock, type Timing } from '../config.js';
import { ensurePrivateDirectory, type HelperPaths } from '../paths.js';
import { assertLockUpgradeReady } from '../write-lock-upgrade.js';
import type { DirectoryWriteGuardProgress, WriteGuardRelease } from '../write-lock.js';
import * as writeLock from '../write-lock.js';
import {createPinnedStorageEntry, hasExactStorageMode, pinStorageDirectory, type PinnedStorageCreation, type PinnedStorageDirectory} from './storage-creation.js';

const CLOSE_ON_EXEC = 0x80000;
const sameFile = (a: {dev: number; ino: number}, b: {dev: number; ino: number}) => a.dev === b.dev && a.ino === b.ino;
const replaced = () => new HelperError('RUNNER_STATE_UNAVAILABLE', 'The runner storage directory or its lock was replaced. Restart the helper after restoring its private storage.');

function requireDirectoryWriteGuard(): typeof writeLock.acquireDirectoryWriteGuard {
  // This Linux-only ABI is newer than completed Darwin lock snapshots.
  const acquire = writeLock.acquireDirectoryWriteGuard;
  if (typeof acquire !== 'function') throw new HelperError('LOCK_UNSAFE',
    'Linux directory write locking is unavailable in this retained helper runtime. Update or reinstall the helper before enabling runs.');
  return acquire;
}

export type RunnerStorageDirectoryName = 'runner' | 'runner/outcomes' | 'runner/staged' | 'runner/excludes' |
  'runner/test-processes' | 'runner/activation' | 'logs' | 'run-homes' | 'backups' | 'backups/run-stage';

export interface RunnerStorageLock {
  /** Canonical path of the directory whose identity is retained by this lock. */
  readonly data: string;
  readonly identity: string;
  /** Revalidate a caller's public path before acquisition or attachment. */
  assertCurrent(): Promise<void>;
  /** Warm operations use retained descriptors, without resolving caller aliases. */
  assertHeld?(): Promise<void>;
  /** Fresh bootstrap inventories absence and pins accepted children without yielding. */
  inventoryFresh?(): void;
  directory(name: RunnerStorageDirectoryName, options?: {createOnly?: boolean}): Promise<RunnerStorageDirectory>;
  release(): Promise<void>;
}

export interface RunnerStorageDirectory {
  /** Trusted procfs reference to a retained directory, never a user path. */
  readonly path: string;
  assertCurrent(): Promise<void>;
  /** Recheck bound links before publication after a held FD was validated. */
  assertLinked?(): Promise<void>;
  sync(): Promise<void>;
  /** Fresh bootstrap retains published creations until its final inventory. */
  retainCreatedFile?(name: string, creation: PinnedStorageCreation): void;
  assertCreatedFiles?(): Promise<void>;
}

export interface RetainedRunnerStorageDirectory {
  readonly data: string;
  /** Derived from the retained descriptor, never from a second path lookup. */
  readonly identity: string;
  assertCurrent(): Promise<void>;
  /** Transfers the retained descriptor into the lock, including failed acquisition cleanup. */
  acquireLock(timing?: Timing, deadline?: number): Promise<RunnerStorageLock>;
  /** Only unused cache-lookup candidates may be closed directly. */
  close(): Promise<void>;
}

/** Resolve existing aliases before creating any missing private descendants. */
export async function canonicalRunnerStorageDirectory(data: string, discovered?: (canonical: string) => void): Promise<string> {
  const requested = resolve(data);
  let ancestor = requested;
  while (true) {
    let canonical: string;
    try {
      canonical = resolve(await realpath(ancestor), relative(ancestor, requested));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || ancestor === dirname(ancestor)) throw error;
      ancestor = dirname(ancestor);
      continue;
    }
    // A data-only owner can reuse registered storage, never extend coverage.
    // Validate the resolved target before recording it or creating a directory.
    if (process.platform === 'linux') await assertLockUpgradeReady({data: canonical} as HelperPaths);
    discovered?.(canonical);
    await ensurePrivateDirectory(canonical);
    return canonical;
  }
}

/** The retained descriptors are controller capabilities, never workload stdio. */
async function assertCloseOnExec(file: FileHandle): Promise<void> {
  const text = await readFile(`/proc/self/fdinfo/${file.fd}`, 'utf8');
  const flags = /^flags:\s+([0-7]+)$/mu.exec(text)?.[1];
  if (!flags || !(Number.parseInt(flags, 8) & CLOSE_ON_EXEC)) {
    throw new HelperError('LOCK_UNSAFE', 'The runner storage descriptor must be close-on-exec.');
  }
}

/** Pin the identity before cache lookup; acquisition must use this same descriptor. */
async function retainStorageDirectory(data: string, discovered?: (canonical: string) => void): Promise<RetainedRunnerStorageDirectory & {bindController(): Promise<RunnerControllerStorage>}> {
  if (process.platform !== 'linux') throw new HelperError('LOCK_UNSAFE', 'The runner storage kernel lock is Linux-only.');
  requireDirectoryWriteGuard();
  const requested = resolve(data), canonical = await canonicalRunnerStorageDirectory(requested, discovered);
  const directory = await open(canonical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | CLOSE_ON_EXEC);
  let closed: Promise<void> | undefined, transferred = false;
  const close = () => closed ??= directory.close();
  try {
    const directoryInfo = await directory.stat();
    if (!directoryInfo.isDirectory() || directoryInfo.uid !== process.getuid?.() || !hasExactStorageMode(directoryInfo, 0o700)) {
      throw new HelperError('LOCK_UNSAFE', 'The runner storage directory must be private and owned by this user.');
    }
    await assertCloseOnExec(directory);
    const currentNamespace = async () => {
      try {
        const latest = await lstat(canonical);
        if (closed || !latest.isDirectory() || !sameFile(directoryInfo, latest) || latest.uid !== process.getuid?.() ||
            !hasExactStorageMode(latest, 0o700)) throw replaced();
      } catch {throw replaced();}
    };
    const currentDirectory = async () => {
      await currentNamespace();
      // Acquisition/attachment still consumes the caller's public alias. A
      // retained capability operation below never traverses that alias again.
      try {if (await realpath(requested) !== canonical) throw replaced();}
      catch {throw replaced();}
    };
    const currentHeldDirectory = async () => {
      try {
        const held = await directory.stat();
        if (!held.isDirectory() || !sameFile(directoryInfo, held) || held.uid !== process.getuid?.() ||
            !hasExactStorageMode(held, 0o700)) throw replaced();
        await currentNamespace();
      } catch {throw replaced();}
    };
    await currentDirectory();
    const identity = `${directoryInfo.dev}:${directoryInfo.ino}`;
    return {
      data: canonical, identity, assertCurrent: currentDirectory,
      acquireLock: (timing = clock, deadline = timing.now() + 2000) => {
        if (transferred || closed) return Promise.reject(replaced());
        transferred = true;
        return lockRunnerStorageDirectory(directory, canonical, identity, currentDirectory, currentHeldDirectory,
          currentNamespace, close, timing, deadline);
      },
      bindController: () => {
        if (transferred || closed) return Promise.reject(replaced());
        transferred = true;
        return lockRunnerStorageDirectory(directory, canonical, identity, currentDirectory, currentHeldDirectory,
          currentNamespace, close, clock, clock.now() + 2000, false);
      },
      close: () => transferred ? Promise.reject(replaced()) : close(),
    };
  } catch (error) {await close(); throw error;}
}

export async function retainRunnerStorageDirectory(data: string): Promise<RetainedRunnerStorageDirectory> {
  return retainStorageDirectory(data);
}

/** A controller namespace binding supplies path integrity, never core journal or cleanup authority. */
export type RunnerControllerStorage = Pick<RunnerStorageLock, 'data' | 'identity' | 'assertCurrent' | 'assertHeld' | 'directory' | 'release'>;
export async function retainRunnerControllerStorage(data: string, discovered?: (canonical: string) => void): Promise<RunnerControllerStorage> {
  return (await retainStorageDirectory(data, discovered)).bindController();
}

const pendingControllerAcquisitions = new Map<symbol, Set<string>>();
const uncertainControllerStorage = new Set<RunnerControllerStorage>();
// A refused unsafe acquisition may still own a utility descriptor, and no
// diagnostic or activation state has been read. Its later close is not a
// recovery proof. Keep this uncertainty until an explicit recovery protocol
// can discharge it, independently of the acquisition promise's settlement.
const uncertainControllerPaths = new Set<string>();
/** Keep the public busy code while distinguishing unread acquisition from known contention. */
export class RunnerControllerLeaseRefusal extends HelperError {
  constructor(readonly unresolved: boolean, readonly storagePaths: ReadonlySet<string> = new Set()) {
    super('HELPER_BUSY', 'The controller storage lease is busy or unavailable.');
  }
}
export const controllerStorageBusy = (data?: string): boolean =>
  [...pendingControllerAcquisitions.values()].some(paths => data === undefined || paths.has(resolve(data))) ||
  [...uncertainControllerStorage].some(storage => data === undefined || storage.data === resolve(data)) ||
  [...uncertainControllerPaths].some(path => data === undefined || path === resolve(data));

/** Caller refusal never abandons an acquisition whose physical I/O can still finish. */
export function acquireRunnerControllerLease(data: string, kind: 'activation' | 'tests', timing: Timing = clock,
  deadline = timing.now() + 10_000): Promise<RunnerControllerStorage> {
  const reservation = Symbol('controller acquisition');
  const paths = new Set([resolve(data)]);
  pendingControllerAcquisitions.set(reservation, paths);
  return new Promise((resolveLease, reject) => {
    let expired = false;
    let progress: DirectoryWriteGuardProgress = 'acquiring';
    const timer = setTimeout(() => {
      expired = true;
      const expiredUnresolved = progress !== 'contended';
      // The reservation owns unresolved physical acquisition. A bounded caller
      // refusal alone does not establish permanent controller corruption. The
      // diagnostic caller separately retains its unread-ledger obligation,
      // including canonical paths discovered after this refusal was returned.
      reject(new RunnerControllerLeaseRefusal(expiredUnresolved, paths));
    }, Math.max(1, deadline - timing.now()));
    const preparing = acquireControllerLease(data, kind, timing, deadline, state => {progress = state;},
      canonical => {paths.add(canonical);});
    void preparing.then(async storage => {
      clearTimeout(timer);
      if (expired) {
        try {await storage.release(); pendingControllerAcquisitions.delete(reservation);}
        catch {uncertainControllerStorage.add(storage);}
      } else {pendingControllerAcquisitions.delete(reservation); resolveLease(storage);}
    }, error => {
      // HELPER_BUSY is returned only after acquisition closes its resources,
      // including when a pending directory open resumes after the deadline.
      // LOCK_UNSAFE with a retained utility or other integrity failures stay
      // unresolved independently of the bounded caller's refusal.
      if ((error as {code?: string}).code !== 'HELPER_BUSY') {
        for (const path of paths) uncertainControllerPaths.add(path);
      }
      clearTimeout(timer); pendingControllerAcquisitions.delete(reservation);
      if (!expired) reject((error as {code?: string}).code === 'HELPER_BUSY' ? new RunnerControllerLeaseRefusal(progress !== 'contended', paths) : error);
    });
  });
}

/** Separate activation and diagnostic leases can nest without taking the core's root flock. */
async function acquireControllerLease(data: string, kind: 'activation' | 'tests', timing: Timing,
  deadline: number, progress: (state: DirectoryWriteGuardProgress) => void,
  discovered: (canonical: string) => void): Promise<RunnerControllerStorage> {
  const storage = await retainRunnerControllerStorage(data, discovered);
  // Bind uncertainty as soon as this canonical object is known. A later
  // acquisition failure or utility close cannot erase its unread obligation.
  discovered(storage.data);
  let file: FileHandle | undefined, unlock: WriteGuardRelease | undefined, released: Promise<void> | undefined;
  try {
    const directory = await storage.directory(kind === 'tests' ? 'runner/test-processes' : 'runner/activation');
    file = await open(directory.path + '/.', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | CLOSE_ON_EXEC);
    await directory.assertCurrent();
    while (!unlock) {
      try {unlock = await requireDirectoryWriteGuard()(file, timing, deadline, progress);}
      catch (error) {
        if ((error as {code?: string}).code !== 'HELPER_BUSY' || timing.now() >= deadline) throw error;
        await timing.sleep(50); await directory.assertCurrent();
      }
    }
    await directory.assertCurrent();
    const validate = async (current: () => Promise<void>) => {
      if (released) throw replaced();
      await current(); await directory.assertCurrent(); await unlock!.assertCurrent();
    };
    const assertCurrent = () => validate(storage.assertCurrent);
    const assertHeld = () => validate(storage.assertHeld ?? storage.assertCurrent);
    return {data: storage.data, identity: storage.identity, assertCurrent, assertHeld, directory: async name => {
      await assertHeld(); return storage.directory(name);
    }, release: () => released ??= (async () => {
      try {await unlock!();} finally {try {await file!.close();} finally {await storage.release();}}
    })()};
  } catch (error) {
    try {await unlock?.();} finally {try {await file?.close();} finally {await storage.release();}}
    throw error;
  }
}

/** Linux only. Acquire before authoritative load and retain through all writes. */
export async function acquireRunnerStorageLock(data: string, timing: Timing = clock,
  deadline = timing.now() + 2000): Promise<RunnerStorageLock> {
  return (await retainRunnerStorageDirectory(data)).acquireLock(timing, deadline);
}

async function lockRunnerStorageDirectory(directory: FileHandle, canonical: string, identity: string,
  currentDirectory: () => Promise<void>, currentHeldDirectory: () => Promise<void>, currentNamespace: () => Promise<void>,
  close: () => Promise<void>, timing: Timing, deadline: number, kernelLock = true): Promise<RunnerStorageLock> {
  let unlock: WriteGuardRelease | undefined, released: Promise<void> | undefined;
  type ChildDirectory = {binding: RunnerStorageDirectory; file: FileHandle; assertLinked(): Promise<void>; closePins(): void};
  const childDirectories = new Map<string, Promise<ChildDirectory>>();
  // A recorded absence is as binding as a retained inode. Failed acquisition
  // never discards either observation and cannot adopt later replacement evidence.
  const childInventory = new Map<RunnerStorageDirectoryName, PinnedStorageDirectory | undefined>();
  try {
    await currentDirectory();
    if (kernelLock) unlock = await requireDirectoryWriteGuard()(directory, timing, deadline);
    const validate = async (checkDirectory: () => Promise<void>) => {
      try {
        if (released) throw replaced();
        for (const pin of childInventory.values()) pin?.assertLinked();
        await checkDirectory();
        // The kernel lock belongs to this directory inode, independent of all
        // child names and held until every physical operation has settled.
        await unlock?.assertCurrent();
        for (const pin of childInventory.values()) pin?.assertLinked();
      } catch (error) {
        if (error instanceof HelperError && error.code === 'RUNNER_STATE_UNAVAILABLE') throw error;
        throw replaced();
      }
    };
    const assertCurrent = () => validate(currentDirectory);
    const assertHeld = () => validate(currentHeldDirectory);
    const assertLinked = () => validate(currentNamespace);
    await assertCurrent();
    const inventory = (name: RunnerStorageDirectoryName, path: string, createOnly = false) => {
      if (childInventory.has(name)) return;
      let info: Stats | undefined;
      try {info = lstatSync(path);}
      catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
      if (info && createOnly) throw replaced();
      childInventory.set(name, info ? pinStorageDirectory(path, info) : undefined);
    };
    const inventoryFresh = () => {
      if (released || childInventory.size || childDirectories.size) throw replaced();
      const path = `/proc/self/fd/${directory.fd}`;
      inventory('runner', join(path, 'runner'), true);
      childInventory.set('runner/outcomes', undefined);
      inventory('logs', join(path, 'logs'));
      const logs = childInventory.get('logs');
      // Readdir does not yield between the initial inode pin and acceptance.
      // All subsequent inspections use the adopted descriptor and its pin.
      if (logs) {
        logs.assertLinked();
        if (readdirSync(logs.path).length) throw replaced();
        logs.assertLinked();
      }
    };
    const directoryBinding = (name: RunnerStorageDirectoryName, createOnly = false): Promise<ChildDirectory> => {
      let pending = childDirectories.get(name);
      if (pending && createOnly) throw replaced();
      if (!pending) {
        pending = (async () => {
          await assertHeld();
          const slash = name.lastIndexOf('/');
          const parent = slash >= 0 ? await directoryBinding(name.slice(0, slash) as RunnerStorageDirectoryName) :
            {binding: {path: `/proc/self/fd/${directory.fd}`}, file: directory, assertLinked};
          await parent.assertLinked();
          const path = join(parent.binding.path, name.slice(slash + 1));
          inventory(name, path, createOnly);
          const accepted = childInventory.get(name);
          if (accepted && createOnly) throw replaced();
          let creation: PinnedStorageCreation | undefined;
          let file: FileHandle | undefined;
          const createdFiles = new Map<string, PinnedStorageCreation>();
          try {
            if (accepted) file = await accepted.adopt();
            else {creation = await createPinnedStorageEntry(path, 'directory'); file = creation.file;}
            const retained = file, info = creation?.info ?? accepted!.info;
            const linked = async () => {
              try {
                await parent.assertLinked();
                const latest = await lstat(path);
                if (!latest.isDirectory() || !sameFile(info, latest) || latest.uid !== process.getuid?.() || !hasExactStorageMode(latest, 0o700)) throw replaced();
              } catch {throw replaced();}
            };
            const current = async () => {
              try {
                if (released) throw replaced();
                const held = await retained.stat();
                if (!held.isDirectory() || !sameFile(info, held) || held.uid !== process.getuid?.() || !hasExactStorageMode(held, 0o700)) throw replaced();
                // Check parent links once without recursively fstat'ing every
                // ancestor. Every operation itself uses this retained child FD.
                await linked();
              } catch {throw replaced();}
            };
            if (!info.isDirectory() || info.uid !== process.getuid?.() || !hasExactStorageMode(info, 0o700)) throw replaced();
            await assertCloseOnExec(retained); await current();
            if (creation) {await parent.file.sync(); await current();}
            const retainedPath = `/proc/self/fd/${retained.fd}`;
            return {file, assertLinked: linked, closePins: () => {for (const pin of createdFiles.values()) pin.closePin();},
              binding: {path: retainedPath, assertCurrent: current, assertLinked: linked, sync: () => retained.sync(),
                ...(createOnly ? {
                  retainCreatedFile: (fileName: string, pin: PinnedStorageCreation) => {
                    createdFiles.get(fileName)?.closePin(); createdFiles.set(fileName, pin);
                  },
                  assertCreatedFiles: async () => {
                    await current();
                    for (const [fileName, pin] of createdFiles) await pin.assertLinked(join(retainedPath, fileName));
                    await current();
                  },
                } : {})}};
          } catch (error) {await file?.close(); throw error;}
          finally {creation?.closePin();}
        })();
        childDirectories.set(name, pending);
        void pending.catch(() => {if (childDirectories.get(name) === pending) childDirectories.delete(name);});
      }
      return pending;
    };
    return {
      data: canonical, identity, assertCurrent, assertHeld, inventoryFresh,
      directory: async (name, options) => {
        const {binding} = await directoryBinding(name, options?.createOnly);
        return binding;
      },
      release: () => released ??= (async () => {
        try {
          const children = await Promise.allSettled(childDirectories.values());
          const closures = await Promise.allSettled(children.filter(result => result.status === 'fulfilled').map(async result => {
            try {await result.value.file.close();} finally {result.value.closePins();}
          }));
          const failed = closures.find(result => result.status === 'rejected');
          if (failed?.status === 'rejected') throw failed.reason;
        } finally {
          try {for (const pin of childInventory.values()) pin?.closePin();}
          finally {try {await unlock?.();} finally {await close();}}
        }
      })(),
    };
  } catch (error) {
    try {await unlock?.();} finally {await close();}
    throw error;
  }
}

/** Scoped backup descendants are retained only for the physical operation, not for every future run. */
export async function retainRunnerStorageChild(parent: RunnerStorageDirectory, name: string): Promise<RunnerStorageDirectory & {close(): Promise<void>}> {
  if (!/^\/proc\/self\/fd\/\d+$/u.test(parent.path) || !name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) throw replaced();
  await parent.assertCurrent();
  const path = join(parent.path, name);
  let initial: Stats | undefined;
  try {initial = lstatSync(path);}
  catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
  const accepted = initial ? pinStorageDirectory(path, initial) : undefined;
  let creation: PinnedStorageCreation | undefined, file: FileHandle | undefined;
  let closed: Promise<void> | undefined;
  try {
    if (accepted) file = await accepted.adopt();
    else {creation = await createPinnedStorageEntry(path, 'directory'); file = creation.file;}
    const retained = file, info = creation?.info ?? accepted!.info;
    if (!info.isDirectory() || info.uid !== process.getuid?.() || !hasExactStorageMode(info, 0o700)) throw replaced();
    const assertLinked = async () => {
      try {
        if (closed) throw replaced();
        await (parent.assertLinked ?? parent.assertCurrent)();
        const current = await lstat(path);
        if (!current.isDirectory() || !sameFile(info, current) || current.uid !== process.getuid?.() || !hasExactStorageMode(current, 0o700)) throw replaced();
      } catch {throw replaced();}
    };
    const assertCurrent = async () => {
      try {
        const held = await retained.stat();
        if (!held.isDirectory() || !sameFile(info, held) || held.uid !== process.getuid?.() || !hasExactStorageMode(held, 0o700)) throw replaced();
        await assertLinked();
      } catch {throw replaced();}
    };
    await assertCloseOnExec(retained); await assertCurrent();
    if (creation) {await parent.sync(); await assertCurrent();}
    return {path: `/proc/self/fd/${retained.fd}`, assertCurrent, assertLinked, sync: () => retained.sync(), close: () => closed ??= retained.close()};
  } catch (error) {await file?.close(); throw error;}
  finally {creation?.closePin(); accepted?.closePin();}
}
