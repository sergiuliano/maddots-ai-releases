import { constants, type Stats } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { treeDigest, type BuildFileMode } from './shared/build-format.js';
import { SKILL_LIMITS } from './shared/skill-limits.js';
import { HelperError } from './config.js';
import { assertNoSymlinks, ensurePrivateDirectory, inside, type HelperPaths } from './paths.js';

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
