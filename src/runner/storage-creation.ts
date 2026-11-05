import {closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, type Stats} from 'node:fs';
import {lstat, open, type FileHandle} from 'node:fs/promises';
import {HelperError} from '../config.js';

const CLOSE_ON_EXEC = 0x80000;
const replaced = () => new HelperError('RUNNER_STATE_UNAVAILABLE', 'A pinned runner storage entry was replaced. Preserve its evidence before restarting.');
/** Creation, retained validation and restart inventory share the complete mode. */
export const hasExactStorageMode = (info: Pick<Stats, 'mode'>, mode: number): boolean => (info.mode & 0o7777) === mode;

export interface PinnedStorageDirectory {
  readonly path: string;
  readonly info: Stats;
  assertLinked(): void;
  adopt(): Promise<FileHandle>;
  closePin(): void;
}

/** Capture an accepted inventory entry before yielding. Later adoption resolves
 * only this descriptor, never the name that supplied the initial identity.
 */
export function pinStorageDirectory(path: string, expected: Stats): PinnedStorageDirectory {
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | CLOSE_ON_EXEC;
  const fd = openSync(path, flags);
  let closed = false;
  const closePin = () => {if (!closed) {closed = true; closeSync(fd);}};
  try {
    const valid = (info: Stats) => info.isDirectory() && info.dev === expected.dev && info.ino === expected.ino &&
      info.uid === process.getuid?.() && hasExactStorageMode(info, 0o700);
    if (!valid(expected)) throw replaced();
    const assertLinked = () => {
      try {if (closed || !valid(fstatSync(fd)) || !valid(lstatSync(path))) throw replaced();}
      catch {throw replaced();}
    };
    assertLinked();
    return {path: `/proc/self/fd/${fd}`, info: expected, assertLinked, closePin, adopt: async () => {
      assertLinked();
      const file = await open(`/proc/self/fd/${fd}/.`, flags);
      try {assertLinked(); return file;}
      catch (error) {await file.close(); throw error;}
    }};
  } catch (error) {closePin(); throw error;}
}

export interface PinnedStorageCreation {
  readonly file: FileHandle;
  readonly info: Stats;
  assertLinked(path: string, links?: number): Promise<void>;
  publish(temporary: string, path: string, options: {createOnly?: boolean; previous?: Stats}): void;
  unlink(temporary: string, path: string): void;
  /** The independent pin survives closing the asynchronous write handle. */
  closePin(): void;
}

/** Exclusive creation and identity capture must precede the first yield. All
 * later opens adopt this inode through its descriptor, never a mutable name.
 * The admitted owner supplies the retained parent and owns both descriptors.
 */
export async function createPinnedStorageEntry(path: string, kind: 'directory' | 'file'): Promise<PinnedStorageCreation> {
  const directory = kind === 'directory', mode = directory ? 0o700 : 0o600;
  const flags = (directory ? constants.O_RDONLY | constants.O_DIRECTORY : constants.O_WRONLY) | CLOSE_ON_EXEC;
  let fd: number;
  try {
    if (directory) mkdirSync(path, {mode});
    fd = openSync(path, flags | constants.O_NOFOLLOW | (directory ? 0 : constants.O_CREAT | constants.O_EXCL), mode);
  } catch (error) {if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw replaced(); throw error;}
  let closed = false, file: FileHandle | undefined;
  const closePin = () => {if (!closed) {closed = true; closeSync(fd);}};
  try {
    const info = fstatSync(fd);
    const valid = (current: Stats) => (directory ? current.isDirectory() : current.isFile()) &&
      current.dev === info.dev && current.ino === info.ino && current.uid === process.getuid?.() &&
      hasExactStorageMode(current, mode);
    if (!valid(info)) throw replaced();
    file = await open(`/proc/self/fd/${fd}${directory ? '/.' : ''}`, flags | (directory ? constants.O_NOFOLLOW : 0));
    const assertLinked = async (currentPath: string, links = 1) => {
      try {
        if (closed) throw replaced();
        const held = fstatSync(fd), latest = await lstat(currentPath);
        if (!valid(held) || !valid(latest) || !directory && (held.nlink !== links || latest.nlink !== links)) throw replaced();
      } catch {throw replaced();}
    };
    const assertLinkedSync = (currentPath: string, links: number) => {
      try {
        if (closed || directory) throw replaced();
        const held = fstatSync(fd), latest = lstatSync(currentPath);
        if (!valid(held) || !valid(latest) || held.nlink !== links || latest.nlink !== links) throw replaced();
      } catch {throw replaced();}
    };
    await assertLinked(path);
    return {file, info, assertLinked, closePin,
      publish: (temporary, target, options) => {
        // No yield may separate the final inode checks from the namespace
        // mutation. In particular, a delayed rename must not erase a foreign
        // replacement of the old head, or publish a replacement temporary.
        assertLinkedSync(temporary, 1);
        if (options.createOnly) {
          try {linkSync(temporary, target);}
          catch (error) {if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw replaced(); throw error;}
        }
        else {
          let latest: Stats | undefined;
          try {latest = lstatSync(target);} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
          const previous = options.previous;
          if (previous ? !latest || !latest.isFile() || latest.dev !== previous.dev || latest.ino !== previous.ino ||
              latest.uid !== previous.uid || latest.mode !== previous.mode || latest.nlink !== 1 : latest) throw replaced();
          renameSync(temporary, target);
        }
      },
      unlink: (temporary, target) => {
        assertLinkedSync(temporary, 2); assertLinkedSync(target, 2);
        unlinkSync(temporary);
      }};
  } catch (error) {
    try {await file?.close();} finally {closePin();}
    throw error;
  }
}
