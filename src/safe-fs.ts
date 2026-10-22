import { constants, type Stats } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readdir, readlink, realpath, rename, symlink, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { treeDigest, type BuildFileMode } from './shared/build-format.js';
import { SKILL_LIMITS } from './shared/skill-limits.js';
import { HelperError } from './config.js';
import { assertNoSymlinks, atomicWrite, ensurePrivateDirectory, inside, readPrivateFile, type HelperPaths } from './paths.js';

export type SafeBuildFile = { path: string; mode: BuildFileMode; content: Buffer };
const FILE_BYTES = SKILL_LIMITS.fileBytes;
const TREE_BYTES = SKILL_LIMITS.versionBytes;
const sameFile = (left: Stats, right: Stats) => left.dev === right.dev && left.ino === right.ino;
const overlap = (left: string, right: string) => inside(left, right) || inside(right, left);

async function realDirectory(path: string, anchor: string = sep): Promise<Stats> {
  await assertNoSymlinks(path, anchor);
  const info = await lstat(path);
  if (!info.isDirectory() || await realpath(path) !== resolve(path)) {
    throw new HelperError('PATH_UNSAFE', 'The helper requires a real directory without symlink components.');
  }
  return info;
}

/** Only real, HOME-contained route roots outside helper and protected storage. */
export async function assertRouteRoot(paths: HelperPaths, root: string): Promise<void> {
  const home = resolve(paths.home), absolute = resolve(root);
  const prohibited = [paths.data, join(home, '.config/ibl-projects-mcp'), join(home, '.cache/maddots-mcp'), join(home, '.claude/skills')];
  if (!isAbsolute(root) || absolute === home || !inside(home, absolute) || prohibited.some(path => overlap(resolve(path), absolute))) {
    throw new HelperError('PATH_UNSAFE', 'The route must be inside HOME and outside helper data, maddots-mcp, and Claude skills.');
  }
  if (await realpath(home) !== home) throw new HelperError('PATH_UNSAFE', 'HOME must be its resolved real path.');
  await realDirectory(absolute, home);
}

/** Read only ordinary files. Ignored metadata is never traversed. */
export async function readSkillTree(folder: string, home: string): Promise<SafeBuildFile[]> {
  const root = resolve(folder), anchor = resolve(home);
  if (!isAbsolute(folder) || !inside(anchor, root) || root === anchor || await realpath(anchor) !== anchor) {
    throw new HelperError('PATH_UNSAFE', 'The skill must be inside its real HOME.');
  }
  const files: SafeBuildFile[] = [];
  let bytes = 0, entriesRead = 0;
  async function walk(directory: string, prefix: string): Promise<void> {
    const before = await realDirectory(directory, anchor);
    const entries = await readdir(directory);
    entriesRead += entries.length;
    if (entriesRead > SKILL_LIMITS.files * (SKILL_LIMITS.pathDepth + 1)) throw new HelperError('BUILD_TOO_LARGE', 'The skill has too many filesystem entries.');
    await assertNoSymlinks(directory, anchor);
    if (!sameFile(before, await lstat(directory))) throw new HelperError('PATH_CHANGED', 'The skill folder changed while it was being read.');
    for (const name of entries.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))) {
      const path = join(directory, name), relativePath = prefix + name;
      await assertNoSymlinks(path, anchor);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new HelperError('PATH_UNSAFE', 'Skill files must not be symbolic links.');
      if (name === '.DS_Store' || (!prefix && name === '.maddots')) continue;
      if (relativePath.split('/').length > SKILL_LIMITS.pathDepth || Buffer.byteLength(relativePath.normalize('NFC')) > SKILL_LIMITS.pathBytes) {
        throw new HelperError('BUILD_INVALID', 'The skill path is too long or too deeply nested.');
      }
      if (info.isDirectory()) { await walk(path, relativePath + '/'); continue; }
      if (files.length >= SKILL_LIMITS.files) throw new HelperError('BUILD_TOO_LARGE', 'The skill has too many files.');
      if (!info.isFile() || info.size > FILE_BYTES) throw new HelperError('FILE_UNSAFE', 'Skill files must be regular files no larger than 1 MiB.');
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = await file.stat();
        if (!opened.isFile() || !sameFile(info, opened) || opened.size > FILE_BYTES) throw new HelperError('FILE_UNSAFE', 'The skill file changed while being opened.');
        const content = Buffer.alloc(Math.min(opened.size + 1, FILE_BYTES + 1));
        let length = 0;
        while (length < content.length) {
          const read = await file.read(content, length, content.length - length, length);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        const after = await file.stat();
        await assertNoSymlinks(path, anchor);
        if (length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || !sameFile(opened, await lstat(path))) {
          throw new HelperError('PATH_CHANGED', 'The skill file changed while it was being read.');
        }
        bytes += length;
        if (bytes > TREE_BYTES) throw new HelperError('BUILD_TOO_LARGE', 'The skill exceeds the 10 MiB build limit.');
        files.push({ path: relativePath.normalize('NFC'), mode: opened.mode & 0o111 ? '100755' : '100644', content: content.subarray(0, length) });
      } finally { await file.close(); }
    }
    await assertNoSymlinks(directory, anchor);
    const after = await lstat(directory);
    if (!sameFile(before, after) || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new HelperError('PATH_CHANGED', 'The skill folder changed while it was being read.');
    }
  }
  await walk(root, '');
  // Share the digest's path/collision/cap validation without defining new framing.
  try { treeDigest(files); }
  catch { throw new HelperError('BUILD_INVALID', 'The local skill has invalid or colliding file paths.'); }
  return files;
}

export async function syncDirectory(path: string): Promise<void> {
  const before = await realDirectory(path);
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = await directory.stat();
    if (!opened.isDirectory() || !sameFile(before, opened)) throw new HelperError('PATH_CHANGED', 'The directory changed before syncing.');
    await directory.sync();
  } finally { await directory.close(); }
}

/** Preserve exact link text without following it or creating an availability gap. */
export async function preserveSymlink(source: string, destination: string, target: string): Promise<void> {
  const parent = await realDirectory(dirname(source));
  await realDirectory(dirname(destination));
  const before = await lstat(source);
  if (!before.isSymbolicLink() || before.uid !== process.getuid?.() || await readlink(source) !== target) {
    throw new HelperError('PATH_CHANGED', 'The skill link changed before it could be backed up.');
  }
  // macOS does not support hard-linking a symlink. Snapshot its exact text in
  // an exclusive backup slot before an atomic repoint replaces the live link.
  await symlink(target, destination);
  const saved = await lstat(destination);
  if (!saved.isSymbolicLink() || await readlink(destination) !== target ||
      !sameFile(parent, await realDirectory(dirname(source))) || !sameFile(before, await lstat(source))) {
    throw new HelperError('PATH_CHANGED', 'The skill link changed while it was being backed up.');
  }
  await syncDirectory(dirname(destination));
}

export type SymlinkHooks = {
  beforeStage?: () => Promise<void>;
  beforePreserve?: () => Promise<void>;
  afterPreserve?: () => Promise<void>;
  beforePlace?: () => Promise<void>;
};
type LinkIdentity = {dev: number; ino: number; type: number};
const linkIdentity = (info: Stats): LinkIdentity => ({dev: info.dev, ino: info.ino, type: info.mode & constants.S_IFMT});
const sameIdentity = (expected: LinkIdentity, info: Stats) => expected.dev === info.dev && expected.ino === info.ino && expected.type === (info.mode & constants.S_IFMT);
type LinkJournal = {format: 1; path: string; target: string; preserved: string; identity: LinkIdentity};
const maybeStat = async (path: string) => lstat(path).catch(error => {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
  throw error;
});

/** Preserve the actual displaced inode, then place exclusively. The journal recovers the two-step gap. */
async function placeSymlink(path: string, target: string, expected: string | null | {directory: true}, preserved: string | undefined, hooks: SymlinkHooks): Promise<void> {
  if (!target || target.includes('\0')) throw new HelperError('PATH_UNSAFE', 'Invalid skill link target.');
  const parent = dirname(path), directory = await realDirectory(parent);
  if (expected !== null && !preserved) throw new HelperError('PATH_UNSAFE', 'Replacing a skill path requires a transaction preservation slot.');
  if (preserved) await realDirectory(dirname(preserved));
  const checkExpected = async (candidate: string) => {
    const info = await maybeStat(candidate);
    if (expected === null ? info !== null : !info || info.uid !== process.getuid?.() || (typeof expected === 'string'
      ? !info.isSymbolicLink() || await readlink(candidate) !== expected : !info.isDirectory())) {
      throw new HelperError('PATH_CHANGED', 'The skill link changed before it could be placed.');
    }
    return info;
  };
  let journal: LinkJournal | undefined;
  if (preserved) {
    try {
      journal = JSON.parse(await readPrivateFile(preserved + '.json', 4096)) as LinkJournal;
      if (!journal || typeof journal !== 'object' || Array.isArray(journal) || journal.format !== 1 || journal.path !== path || journal.target !== target || journal.preserved !== preserved ||
          !journal.identity || !['dev', 'ino', 'type'].every(key => Number.isSafeInteger(journal!.identity[key as keyof LinkIdentity]))) {
        throw new HelperError('BACKUP_INVALID', 'The skill link operation journal is invalid.');
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const moved = preserved ? await maybeStat(preserved) : null;
  if (moved && (!journal || !sameIdentity(journal.identity, moved))) throw new HelperError('PATH_CHANGED', 'The displaced skill object changed; it remains preserved in the transaction backup.');
  if (moved) {
    await checkExpected(preserved!);
    const current = await maybeStat(path);
    if (current?.isSymbolicLink() && current.uid === process.getuid?.() && await readlink(path) === target) {
      await syncDirectory(dirname(preserved!)); await syncDirectory(parent);
      return;
    }
    if (current) throw new HelperError('PATH_CHANGED', 'The skill destination became occupied; both objects were preserved.');
  }
  const before = moved ? null : await checkExpected(path);
  if (journal && before && !sameIdentity(journal.identity, before)) throw new HelperError('PATH_CHANGED', 'The journaled skill object changed.');
  const temporary = join(parent, `.${randomUUID()}.tmp`);
  await hooks.beforeStage?.();
  await symlink(target, temporary);
  const staged = await lstat(temporary);
  try {
    await syncDirectory(parent);
    if (!sameFile(directory, await realDirectory(parent)) || !sameFile(staged, await lstat(temporary)) || await readlink(temporary) !== target) {
      throw new HelperError('PATH_CHANGED', 'The skill link directory changed before it could be placed.');
    }
    if (before && preserved) {
      if (!journal) {
        journal = {format: 1, path, target, preserved, identity: linkIdentity(before)};
        await atomicWrite(preserved + '.json', JSON.stringify(journal) + '\n');
      }
      await hooks.beforePreserve?.();
      if (!sameFile(directory, await realDirectory(parent))) throw new HelperError('PATH_CHANGED', 'The skill directory changed before preservation.');
      if (await maybeStat(preserved)) throw new HelperError('DESTINATION_EXISTS', 'The preservation slot is already occupied.');
      // Never rename over the live path. Whatever actually occupies it is
      // retained before its identity is inspected, including a raced-in file.
      await rename(path, preserved);
      await syncDirectory(dirname(preserved)); await syncDirectory(parent);
      if (!sameIdentity(journal.identity, await lstat(preserved))) {
        throw new HelperError('PATH_CHANGED', 'The displaced skill object changed; it remains preserved in the transaction backup.');
      }
      await checkExpected(preserved);
      await hooks.afterPreserve?.();
    }
    await hooks.beforePlace?.();
    if (!sameFile(directory, await realDirectory(parent))) throw new HelperError('PATH_CHANGED', 'The skill directory changed before link placement.');
    // Exclusive creation also protects files that appear after preservation.
    // rename(temporary, path) would reopen the original destructive race.
    await symlink(target, path);
    await syncDirectory(parent);
  } finally {
    // Only our generated temporary link is removed. Originals stay in backups.
    try {
      if (sameFile(directory, await realDirectory(parent)) && sameFile(staged, await lstat(temporary))) await unlink(temporary);
    } catch { /* Preserve anything whose identity changed. */ }
  }
}

export async function atomicSymlink(path: string, target: string, expected: string | null,
  options: {preserved?: string; hooks?: SymlinkHooks} = {}): Promise<void> {
  await placeSymlink(path, target, expected, options.preserved, options.hooks ?? {});
}

/** The manifest and this operation's inode journal precede moving the primary folder. */
export async function directorySymlink(path: string, target: string, preserved: string, hooks: SymlinkHooks = {}): Promise<void> {
  await placeSymlink(path, target, {directory: true}, preserved, hooks);
}

/** Atomically replace a private serialized build, including base64 payloads. */
export async function atomicWriteBuild(path: string, content: string): Promise<void> {
  const limit = 16 * 1024 * 1024;
  if (typeof content !== 'string' || Buffer.byteLength(content) > limit) throw new HelperError('BUILD_TOO_LARGE', 'Serialized builds must be no larger than 16 MiB.');
  async function existing(): Promise<Stats | undefined> {
    await assertNoSymlinks(path);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.size > limit) {
        throw new HelperError('FILE_UNSAFE', 'The existing build must be a private, owned regular file no larger than 16 MiB.');
      }
      return info;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return undefined; }
  }
  const directory = dirname(path), beforeDirectory = await realDirectory(directory), before = await existing();
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const temporaryInfo = await file.stat();
  try {
    await file.chmod(0o600); await file.writeFile(content); await file.sync(); await file.close();
    const after = await existing();
    if (!sameFile(beforeDirectory, await realDirectory(directory)) || (!!before !== !!after) ||
        (before && after && (!sameFile(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs))) {
      throw new HelperError('PATH_CHANGED', 'The cached build changed before it could be replaced.');
    }
    await assertNoSymlinks(temporary);
    if (!sameFile(temporaryInfo, await lstat(temporary))) throw new HelperError('PATH_CHANGED', 'The temporary build changed before it could be placed.');
    await rename(temporary, path);
    await syncDirectory(directory);
  } finally {
    await file.close().catch(() => {});
    try {
      await assertNoSymlinks(temporary);
      if (sameFile(beforeDirectory, await lstat(directory)) && sameFile(temporaryInfo, await lstat(temporary))) await unlink(temporary);
    } catch { /* Never clean through a changed directory or remove another file. */ }
  }
}

/** Every stage is private and unique; interrupted stages are preserved. */
export async function stageBuild(paths: HelperPaths, files: readonly SafeBuildFile[], stamp: object): Promise<string> {
  if (!Array.isArray(files) || files.length > SKILL_LIMITS.files || files.some((file: SafeBuildFile) => !file || typeof file.path !== 'string' || !Buffer.isBuffer(file.content) || file.path !== file.path.normalize('NFC') ||
      file.path.split('/').length > SKILL_LIMITS.pathDepth || file.path === '.maddots' || file.path.startsWith('.maddots/') || file.path.split('/').includes('.DS_Store'))) {
    throw new HelperError('BUILD_INVALID', 'Build files must have canonical paths without local metadata.');
  }
  try { treeDigest(files); }
  catch { throw new HelperError('BUILD_INVALID', 'Build files failed path, mode, collision, or size validation.'); }
  const metadata = JSON.stringify(stamp);
  if (!stamp || Array.isArray(stamp) || typeof stamp !== 'object' || !metadata || Buffer.byteLength(metadata) > FILE_BYTES) {
    throw new HelperError('STAMP_INVALID', 'The build stamp must be a bounded JSON object.');
  }
  const staging = join(paths.data, 'staging');
  await ensurePrivateDirectory(paths.data);
  await ensurePrivateDirectory(staging);
  const staged = join(staging, randomUUID());
  await mkdir(staged, { mode: 0o700 });
  const directories = new Set([staged]);
  async function write(path: string, content: Buffer | string, mode: number): Promise<void> {
    const parent = dirname(path);
    if (!directories.has(parent)) {
      await assertNoSymlinks(parent, staged);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      let current = parent;
      while (inside(staged, current)) { directories.add(current); if (current === staged) break; current = dirname(current); }
    }
    await realDirectory(parent, staged);
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    try { await file.chmod(mode); await file.writeFile(content); await file.sync(); }
    finally { await file.close(); }
    await assertNoSymlinks(path, staged);
  }
  for (const file of files) await write(join(staged, file.path), file.content, file.mode === '100755' ? 0o755 : 0o644);
  await write(join(staged, '.maddots/skill.json'), metadata + '\n', 0o600);
  for (const directory of [...directories].sort((left, right) => right.split(sep).length - left.split(sep).length)) await syncDirectory(directory);
  await syncDirectory(staging);
  return staged;
}

export type RenameOptions = { rename?: (source: string, destination: string) => Promise<void> };

export type RestorePlacementOptions = {
  beforePlace?: () => Promise<void>;
  afterIntent?: () => Promise<void>;
  afterPlace?: () => Promise<void>;
  beforeConsume?: () => Promise<void>;
  afterConsume?: () => Promise<void>;
  /** The caller has already restored an alias with exclusive symlink creation. */
  alreadyPlaced?: boolean;
  /** Repoint an alias after its saved identity and restore intent are durable. */
  placeAlias?: () => Promise<void>;
};

type RestoreIdentity = LinkIdentity & {size: number; digest: string | null};
type RestoreJournal = {format: 1; source: string; destination: string; state: 'placing' | 'consumed'; identity: RestoreIdentity};
const restoreChanged = () => new HelperError('PATH_CHANGED', 'The restore object changed; remaining objects were preserved.');

/** Bound the sidecar component even when the saved basename is 255 bytes. */
export const restoreJournalPath = (source: string): string => join(dirname(source), `.restore-${createHash('sha256').update(basename(source)).digest('hex')}.json`);

/** Hash an open regular file, never a target reached through a saved symlink. */
async function restoreIdentity(path: string, expected: Stats): Promise<RestoreIdentity> {
  let digest: string | null = null;
  if (expected.isFile()) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat();
      if (!before.isFile() || !sameFile(expected, before) || before.size !== expected.size) throw restoreChanged();
      const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
      let offset = 0;
      while (offset < before.size) {
        const {bytesRead} = await file.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
        if (!bytesRead) throw restoreChanged();
        hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
      }
      const after = await file.stat();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw restoreChanged();
      digest = hash.digest('hex');
    } finally { await file.close(); }
  } else if (expected.isSymbolicLink()) digest = createHash('sha256').update(await readlink(path)).digest('hex');
  else if (!expected.isDirectory()) throw new HelperError('PATH_UNSAFE', 'Only ordinary files, real folders, and symbolic links can be restored.');
  const after = await lstat(path);
  if (!sameIdentity(linkIdentity(expected), after) || after.size !== expected.size ||
      after.mtimeMs !== expected.mtimeMs || after.ctimeMs !== expected.ctimeMs) throw restoreChanged();
  return {...linkIdentity(expected), size: expected.size, digest};
}

async function readRestoreJournal(source: string, destination?: string): Promise<RestoreJournal | null> {
  let value: RestoreJournal;
  try { value = JSON.parse(await readPrivateFile(restoreJournalPath(source), 16 * 1024)) as RestoreJournal; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (!value || value.format !== 1 || value.source !== source || typeof value.destination !== 'string' || !isAbsolute(value.destination) ||
      (destination !== undefined && value.destination !== destination) || !['placing', 'consumed'].includes(value.state) || !value.identity ||
      !['dev', 'ino', 'type', 'size'].every(key => Number.isSafeInteger(value.identity[key as keyof RestoreIdentity]) && Number(value.identity[key as keyof RestoreIdentity]) >= 0) ||
      ![constants.S_IFREG, constants.S_IFLNK, constants.S_IFDIR].includes(value.identity.type) ||
      (value.identity.type === constants.S_IFDIR ? value.identity.digest !== null : typeof value.identity.digest !== 'string' || !/^[0-9a-f]{64}$/u.test(value.identity.digest))) {
    throw new HelperError('BACKUP_INVALID', 'The restore operation journal is invalid.');
  }
  return value;
}

async function matchesRestore(path: string, identity: RestoreIdentity, recreatedLink = false): Promise<boolean> {
  const current = await maybeStat(path);
  if (!current || current.size !== identity.size || (recreatedLink && identity.type === constants.S_IFLNK
    ? !current.isSymbolicLink() : !sameIdentity(identity, current))) return false;
  return (await restoreIdentity(path, current)).digest === identity.digest;
}

/** Without a destination, classify the saved slot for listing: a different
 * object is pending content. With a destination, recover the journaled operation
 * independently of that slot, so a retry never starts restoring its replacement. */
export async function restoredObjectState(source: string, destination?: string): Promise<'missing' | 'pending' | 'restoring' | 'restored'> {
  await realDirectory(dirname(source));
  const journal = await readRestoreJournal(source, destination), current = await maybeStat(source);
  if (journal && (destination !== undefined || !current || await matchesRestore(source, journal.identity))) return journal.state === 'consumed' ? 'restored' : 'restoring';
  return current ? 'pending' : 'missing';
}

/**
 * Restore without replacing an occupied file or link destination. Keep the saved
 * source as evidence and journal consumption after the new entry is durable.
 *
 * Node exposes no portable rename-noreplace for directories, so their final
 * absence check and rename still have a race with an arriving empty directory.
 * Parent-path checks and source-identity checks also cannot be joined atomically
 * to placement without native directory-relative/conditional operations.
 */
export async function placeRestoredObject(source: string, destination: string, options: RestorePlacementOptions = {}): Promise<void> {
  const sourceParent = dirname(source), destinationParent = dirname(destination);
  const sourceDirectory = await realDirectory(sourceParent), destinationDirectory = await realDirectory(destinationParent);
  let journal = await readRestoreJournal(source, destination);
  const state = await restoredObjectState(source, destination);
  if (state === 'restored') return;
  const original = await maybeStat(source);
  if (!original && (state !== 'restoring' || !journal)) throw restoreChanged();
  const identity = state === 'restoring' ? journal!.identity : await restoreIdentity(source, original!);
  const isDirectory = identity.type === constants.S_IFDIR, isFile = identity.type === constants.S_IFREG;
  const checkParents = async () => {
    if (!sameFile(sourceDirectory, await realDirectory(sourceParent)) || !sameFile(destinationDirectory, await realDirectory(destinationParent))) {
      throw new HelperError('PATH_CHANGED', 'A restore parent changed; the saved object was preserved.');
    }
  };
  const checkSource = async () => {
    const current = await maybeStat(source);
    if (!current || !await matchesRestore(source, identity)) {
      throw new HelperError('PATH_CHANGED', 'The saved object changed before restore completed.');
    }
  };
  const occupied = () => new HelperError('DESTINATION_EXISTS', 'The restore destination is occupied; the saved object was preserved.');
  await checkParents();
  let placed = await maybeStat(destination);
  const alreadyPlaced = (state === 'restoring' || options.alreadyPlaced) && placed && await matchesRestore(destination, identity, true);
  if (state !== 'restoring') {
    await checkSource();
    if (!alreadyPlaced && !options.placeAlias && await maybeStat(destination)) throw occupied();
    journal = {format: 1, source, destination, state: 'placing', identity};
    await atomicWrite(restoreJournalPath(source), JSON.stringify(journal) + '\n');
  }
  await options.afterIntent?.();
  if (!alreadyPlaced) {
    if (!options.placeAlias) await options.beforePlace?.();
    await checkParents();
    await checkSource();
    try {
      if (options.placeAlias) {
        if (identity.type !== constants.S_IFLNK) throw new HelperError('PATH_UNSAFE', 'Alias placement requires a saved symbolic link.');
        await options.placeAlias();
      } else if (isDirectory) {
        // Keep this last check adjacent to rename. A file or symlink arriving in
        // the remaining gap is refused by rename, but an empty folder can be lost.
        if (await maybeStat(destination)) throw occupied();
        await rename(source, destination);
      } else if (isFile) {
        // link is exclusive even if a destination appears after all path checks.
        await link(source, destination);
      } else {
        // Recreate exact link text: macOS cannot hard-link a symbolic link.
        await symlink(await readlink(source), destination);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EISDIR' || code === 'ENOTDIR') throw occupied();
      if (code === 'EXDEV') throw new HelperError('EXDEV', 'The helper cannot restore between volumes; the source was preserved.');
      throw error;
    }
  }
  await options.afterPlace?.();
  await checkParents();
  placed = await lstat(destination);
  const checkDestination = async () => {
    const current = await maybeStat(destination);
    if (!current || !sameIdentity(linkIdentity(placed!), current) || !await matchesRestore(destination, identity, true)) {
      throw new HelperError('PATH_CHANGED', 'The restore destination changed; remaining objects were preserved.');
    }
  };
  await checkDestination();
  if (isFile) {
    const file = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!sameIdentity(identity, await file.stat())) throw new HelperError('PATH_CHANGED', 'The restored file changed before syncing.');
      await file.sync();
    } finally { await file.close(); }
  }
  await syncDirectory(destinationParent);
  await checkParents();
  await checkDestination();
  if (sourceParent !== destinationParent) await syncDirectory(sourceParent);
  await options.beforeConsume?.();
  // Never unlink or archive this pathname: another process may have replaced
  // it since validation. Consumption describes only the restored identity.
  await atomicWrite(restoreJournalPath(source), JSON.stringify({...journal!, state: 'consumed'}) + '\n');
  await options.afterConsume?.();
}

/** Rename only. A different volume is a reported error, never a copy fallback. */
export async function durableRename(source: string, destination: string, options: RenameOptions = {}): Promise<void> {
  await assertNoSymlinks(source);
  await assertNoSymlinks(destination);
  const info = await lstat(source);
  if (!info.isDirectory() && !info.isFile()) throw new HelperError('PATH_UNSAFE', 'Only ordinary files and real folders can be renamed.');
  await realDirectory(dirname(source));
  await realDirectory(dirname(destination));
  try { await lstat(destination); throw new HelperError('DESTINATION_EXISTS', 'The destination must be empty before a folder is placed.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try { await (options.rename ?? rename)(source, destination); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EXDEV') throw new HelperError('EXDEV', 'The helper cannot rename between volumes; the source was preserved.');
    throw error;
  }
  await syncDirectory(dirname(destination));
  if (dirname(source) !== dirname(destination)) await syncDirectory(dirname(source));
}
