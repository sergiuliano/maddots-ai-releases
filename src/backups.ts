import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readlink, rename } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { TOOL_MATRIX } from './shared/tool-matrix.js';
import { HelperError } from './config.js';
import type { DeliveryTarget } from './delivery/index.js';
import type { LockEntry } from './lock.js';
import { managedReadFolder } from './local-edits.js';
import { assertNoSymlinks, atomicWrite, ensurePrivateDirectory, inside, readPrivateFile, type HelperPaths } from './paths.js';
import { assertRouteRoot, durableRename, readSkillTree, stageBuild, syncDirectory } from './safe-fs.js';
import { treeDigest } from './shared/build-format.js';
import { assertUnmanagedTarget, resolveToolFolder, toolHomeRoot, toolHomes, type FolderRef } from './unmanaged.js';

export type BackupManifest = {
  format: 1;
  id: string;
  originalPath: string;
  route: string;
  folderName: string;
  reason: string;
  digest: string | null;
  createdAt: string;
  /** A read-only tool cache snapshot restores to the managed delivery copy. */
  restorePath?: string;
  unmanaged?: { original: FolderRef; links: (FolderRef & { target: string })[]; keepOriginal?: true };
};
const idPattern = /^\d{8}T\d{9}Z-[0-9a-f-]{36}$/u;
const manifestKeys = ['format', 'id', 'originalPath', 'route', 'folderName', 'reason', 'digest', 'createdAt'];

function safeName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value !== '.' && value !== '..' && value !== '.maddots' && value !== '.DS_Store' &&
    value === value.normalize('NFC') && Buffer.byteLength(value) <= 255 && !value.includes('/') && !value.includes('\\') && !Array.from(value).some(character => {
      const code = character.codePointAt(0)!;
      return code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029;
    });
}

function routeRoot(paths: HelperPaths, route: string): string {
  const definition = Object.hasOwn(TOOL_MATRIX.routes, route) ? TOOL_MATRIX.routes[route] : undefined;
  if (!definition || definition.kind === 'zip' || !definition.path.startsWith('~/')) {
    throw new HelperError('BACKUP_INVALID', 'The backup names an unsupported delivery route.');
  }
  return resolve(paths.home, definition.path.slice(2));
}

async function sourcePath(paths: HelperPaths, source: string, route: string): Promise<string> {
  const root = routeRoot(paths, route);
  await assertRouteRoot(paths, root);
  const absolute = resolve(source);
  if (absolute === root || !inside(root, absolute) || relative(root, absolute).split(sep).some(part => !safeName(part))) {
    throw new HelperError('BACKUP_INVALID', 'The original folder is outside its delivery route or has unsafe path components.');
  }
  await assertNoSymlinks(absolute, paths.home);
  return absolute;
}

async function backupRoot(paths: HelperPaths): Promise<void> {
  if (resolve(paths.backups) !== join(resolve(paths.data), 'backups') || !inside(resolve(paths.data), resolve(paths.backups))) {
    throw new HelperError('BACKUP_INVALID', 'Backups must be in private helper storage.');
  }
  await ensurePrivateDirectory(paths.data);
  await ensurePrivateDirectory(paths.backups);
}

function parseManifest(value: unknown, id: string): BackupManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HelperError('BACKUP_INVALID', 'The backup manifest is invalid.');
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => ![...manifestKeys, 'restorePath', 'unmanaged'].includes(key)) || manifestKeys.some(key => !(key in item)) || item.format !== 1 || item.id !== id ||
      typeof item.originalPath !== 'string' || item.originalPath.startsWith('/') || item.originalPath.includes('\\') || item.originalPath.split('/').some(part => !safeName(part)) ||
      typeof item.route !== 'string' || !/^[a-z][a-z0-9-]{0,100}$/u.test(item.route) || !safeName(item.folderName) ||
      typeof item.reason !== 'string' || !/^[a-z][a-z0-9_-]{0,100}$/u.test(item.reason) ||
      (item.digest !== null && (typeof item.digest !== 'string' || !/^[0-9a-f]{64}$/u.test(item.digest))) ||
      typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt)) || new Date(item.createdAt).toISOString() !== item.createdAt ||
      (item.restorePath !== undefined && (typeof item.restorePath !== 'string' || item.restorePath.startsWith('/') || item.restorePath.includes('\\') || item.restorePath.split('/').some(part => !safeName(part))))) {
    throw new HelperError('BACKUP_INVALID', 'The backup manifest has unsafe or invalid fields.');
  }
  if (item.unmanaged !== undefined) {
    const unmanaged = item.unmanaged as BackupManifest['unmanaged'];
    const ref = (value: unknown, link = false): boolean => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const record = value as Record<string, unknown>;
      return Object.keys(record).length === (link ? 3 : 2) && safeName(record.home) && safeName(record.folderName) &&
        (!link || (typeof record.target === 'string' && record.target.length > 0 && Buffer.byteLength(record.target) <= 4096 && !record.target.includes('\0')));
    };
    if (!unmanaged || typeof unmanaged !== 'object' || Array.isArray(unmanaged) ||
        Object.keys(unmanaged).length !== (unmanaged.keepOriginal === undefined ? 2 : 3) || !ref(unmanaged.original) || !Array.isArray(unmanaged.links) ||
        (unmanaged.keepOriginal !== undefined && (unmanaged.keepOriginal !== true || !unmanaged.links.length)) ||
        unmanaged.links.length > 256 || unmanaged.links.some(link => !ref(link, true)) || item.route !== 'local-import' ||
        new Set(unmanaged.links.map(link => JSON.stringify([link.home, link.folderName]))).size !== unmanaged.links.length) {
      throw new HelperError('BACKUP_INVALID', 'The unmanaged backup references are invalid.');
    }
  }
  return item as BackupManifest;
}

function storedFolder(paths: HelperPaths, manifest: BackupManifest): string {
  return join(paths.backups, manifest.id, manifest.route, manifest.folderName);
}

async function readManifest(paths: HelperPaths, id: string): Promise<BackupManifest> {
  if (!idPattern.test(id)) throw new HelperError('BACKUP_INVALID', 'The backup id is invalid.');
  await backupRoot(paths);
  const raw = await readPrivateFile(join(paths.backups, id, 'manifest.json'), 64 * 1024);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new HelperError('BACKUP_INVALID', 'The backup manifest is invalid JSON.'); }
  const manifest = parseManifest(parsed, id);
  const original = resolve(paths.home, manifest.restorePath ?? manifest.originalPath);
  if (manifest.unmanaged) {
    await unmanagedPaths(paths, manifest);
    return manifest;
  }
  const root = routeRoot(paths, manifest.route);
  if (!inside(paths.home, original) || basename(original) !== manifest.folderName || original === root || !inside(root, original)) {
    throw new HelperError('BACKUP_INVALID', 'The backup original path does not match its route.');
  }
  if (manifest.restorePath !== undefined) {
    // The cached originalPath is informational. Restore writes to the managed
    // restorePath validated above, even after the matrix readPath changes.
    const cached = resolve(paths.home, manifest.originalPath);
    const definition = Object.hasOwn(TOOL_MATRIX.routes, manifest.route) ? TOOL_MATRIX.routes[manifest.route] : undefined;
    if (manifest.reason !== 'local_read_copy' || definition?.target !== 'claude-plugin' ||
        cached === paths.home || !inside(paths.home, cached) || inside(paths.data, cached) || inside(cached, paths.data) ||
        basename(cached) !== manifest.folderName) {
      throw new HelperError('BACKUP_INVALID', 'The read copy snapshot is invalid.');
    }
  }
  return manifest;
}

type ReadCopyContext = {entry: LockEntry; target: DeliveryTarget};

async function readCopySource(paths: HelperPaths, source: string, destination: string, route: string, context?: ReadCopyContext): Promise<void> {
  if (context?.target.readFolderFor) {
    if (context.entry.route !== route || context.entry.target !== 'claude-plugin' ||
        resolve(source) === destination || resolve(source) !== resolve(await managedReadFolder(paths, context.entry, destination, context.target))) {
      throw new HelperError('BACKUP_INVALID', 'The read copy does not match its managed destination.');
    }
    return;
  }
  const definition = TOOL_MATRIX.routes[route], template = definition?.readPath;
  if (definition?.target !== 'claude-plugin' || !template || /[<>*?]/.test(template) || (!template.startsWith('~/') && !template.startsWith('/'))) {
    throw new HelperError('BACKUP_INVALID', 'The tool cache is not a configured read path.');
  }
  const readRoot = template.startsWith('~/') ? resolve(paths.home, template.slice(2)) : resolve(template);
  if (!inside(paths.home, readRoot) || readRoot === paths.home || inside(paths.data, readRoot) || inside(readRoot, paths.data)) {
    throw new HelperError('BACKUP_INVALID', 'The cached copy must be inside HOME and outside helper storage.');
  }
  await assertRouteRoot(paths, readRoot);
  if (resolve(source) !== resolve(readRoot, relative(routeRoot(paths, route), destination))) {
    throw new HelperError('BACKUP_INVALID', 'The read copy does not match its managed destination.');
  }
  await assertNoSymlinks(source, paths.home);
}

/** Preserve edited cache content without writing to the tool's read-only copy. */
export async function snapshotReadCopy(paths: HelperPaths, source: string, destination: string, route: string, digest: string, now = Date.now(), context?: ReadCopyContext): Promise<BackupManifest> {
  const managed = await sourcePath(paths, destination, route);
  await readCopySource(paths, source, managed, route, context);
  const files = await readSkillTree(source, paths.home);
  if (treeDigest(files) !== digest) throw new HelperError('LOCAL_EDIT_CHANGED', 'The local copy changed before it could be backed up.');
  const createdAt = new Date(now).toISOString(), id = createdAt.replace(/[-:.]/gu, '') + '-' + randomUUID();
  const manifest = parseManifest({format: 1, id, originalPath: relative(paths.home, source).split(sep).join('/'),
    restorePath: relative(paths.home, managed).split(sep).join('/'), route, folderName: basename(managed), reason: 'local_read_copy', digest, createdAt}, id);
  await backupRoot(paths);
  const directory = join(paths.backups, id), routeDirectory = join(directory, route);
  await mkdir(directory, {mode: 0o700}); await mkdir(routeDirectory, {mode: 0o700});
  await atomicWrite(join(directory, 'manifest.json'), JSON.stringify(manifest) + '\n');
  const staged = await stageBuild(paths, files, {format: 1, snapshot: true});
  await durableRename(staged, storedFolder(paths, manifest));
  await syncDirectory(directory); await syncDirectory(paths.backups);
  return manifest;
}

/** Preserve the manifest before moving content so an interrupted move is recoverable. */
export async function backupFolder(paths: HelperPaths, source: string, route: string, reason: string, digest: string | null, now = Date.now(), beforeMove?: (manifest: BackupManifest) => Promise<void>): Promise<BackupManifest> {
  const original = await sourcePath(paths, source, route);
  const info = await lstat(original);
  if (!info.isDirectory()) throw new HelperError('PATH_UNSAFE', 'Only real skill folders can be backed up.');
  const createdAt = new Date(now).toISOString();
  const id = createdAt.replace(/[-:.]/gu, '') + '-' + randomUUID();
  const manifest = parseManifest({ format: 1, id, originalPath: relative(paths.home, original).split(sep).join('/'),
    route, folderName: basename(original), reason, digest, createdAt }, id);
  await backupRoot(paths);
  const directory = join(paths.backups, id), routeDirectory = join(directory, route);
  await mkdir(directory, { mode: 0o700 });
  await mkdir(routeDirectory, { mode: 0o700 });
  await atomicWrite(join(directory, 'manifest.json'), JSON.stringify(manifest) + '\n');
  await syncDirectory(routeDirectory);
  await syncDirectory(directory);
  await syncDirectory(paths.backups);
  // Persist the journal's backup reference before the route copy can disappear.
  await beforeMove?.(manifest);
  await sourcePath(paths, original, route);
  await durableRename(original, storedFolder(paths, manifest));
  return manifest;
}

/** Incomplete stages and already-restored manifests are retained, but not offered. */
export async function listBackups(paths: HelperPaths): Promise<BackupManifest[]> {
  await backupRoot(paths);
  const results: BackupManifest[] = [];
  for (const id of await readdir(paths.backups)) {
    if (!idPattern.test(id)) continue;
    let manifest: BackupManifest;
    try { manifest = await readManifest(paths, id); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (manifest.unmanaged?.keepOriginal) {
      for (const index of manifest.unmanaged.links.keys()) {
        const saved = storedLink(paths, manifest, index);
        await assertNoSymlinks(dirname(saved), paths.backups);
        if (await exists(saved)) { results.push(manifest); break; }
      }
      continue;
    }
    const folder = storedFolder(paths, manifest);
    await assertNoSymlinks(folder, paths.backups);
    try {
      const info = await lstat(folder);
      if (!info.isDirectory() && !(manifest.unmanaged && info.isFile())) throw new HelperError('BACKUP_INVALID', 'A backup must contain a real folder or preserved ordinary file.');
      results.push(manifest);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return results.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
}

/** Restore by rename and preserve any current copy as a separate backup first. */
export async function restoreBackup(paths: HelperPaths, id: string): Promise<BackupManifest> {
  const manifest = await readManifest(paths, id);
  if (manifest.unmanaged) return restoreUnmanaged(paths, manifest);
  const destination = await sourcePath(paths, join(paths.home, manifest.restorePath ?? manifest.originalPath), manifest.route);
  const folder = storedFolder(paths, manifest);
  await assertNoSymlinks(folder, paths.backups);
  if (!(await lstat(folder)).isDirectory()) throw new HelperError('BACKUP_INVALID', 'The backup folder is unavailable.');
  let occupied = false;
  try { await lstat(destination); occupied = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (occupied) await backupFolder(paths, destination, manifest.route, 'restore-replaced', null);
  await sourcePath(paths, destination, manifest.route);
  await durableRename(folder, destination);
  return manifest;
}

const invalidBackup = () => new HelperError('BACKUP_INVALID', 'The unmanaged backup has unsafe or changed paths.');
const exists = async (path: string) => lstat(path).catch(error => {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
  throw error;
});
const storedLink = (paths: HelperPaths, manifest: BackupManifest, index: number) => join(paths.backups, manifest.id, 'links', String(index));

/** Resolve references from matrix roots even when the original no longer exists. */
async function unmanagedPaths(paths: HelperPaths, manifest: BackupManifest): Promise<{ original: string; links: string[] }> {
  const unmanaged = manifest.unmanaged;
  if (!unmanaged) throw invalidBackup();
  const original = resolve(paths.home, manifest.originalPath);
  if (basename(original) !== manifest.folderName) throw invalidBackup();
  await assertUnmanagedTarget(paths, original, true);
  const root = await toolHomeRoot(paths, unmanaged.original.home);
  // The selected folder itself can have been a link, hence originalPath may be
  // outside this root. Its precise physical target is recorded before moving it.
  await assertUnmanagedTarget(paths, root);
  const links: string[] = [];
  for (const link of unmanaged.links) {
    const linkRoot = await toolHomeRoot(paths, link.home);
    const path = join(linkRoot, link.folderName);
    await assertUnmanagedTarget(paths, linkRoot);
    if (path === original || inside(original, path) || inside(path, original) || resolve(linkRoot, link.target) !== original) throw invalidBackup();
    await assertNoSymlinks(dirname(path), paths.home);
    links.push(path);
  }
  return { original, links };
}

async function checkLink(path: string, target: string): Promise<void> {
  await assertNoSymlinks(dirname(path));
  if (!(await lstat(path)).isSymbolicLink() || await readlink(path) !== target) throw invalidBackup();
}

/** Move the link inode itself without following its target or unlinking it. */
async function moveLink(source: string, destination: string, target: string): Promise<void> {
  await checkLink(source, target);
  await assertNoSymlinks(dirname(destination));
  if (await exists(destination)) throw new HelperError('DESTINATION_EXISTS', 'The link destination must be empty.');
  try { await rename(source, destination); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EXDEV') throw new HelperError('EXDEV', 'The helper cannot rename between volumes; the source was preserved.');
    throw error;
  }
  await syncDirectory(dirname(destination));
  if (dirname(source) !== dirname(destination)) await syncDirectory(dirname(source));
}

async function prepareUnmanaged(paths: HelperPaths, source: string, ref: FolderRef, links: (FolderRef & {target: string})[], reason: string, now: number, keepOriginal = false): Promise<BackupManifest> {
  const original = resolve(source), createdAt = new Date(now).toISOString();
  const id = createdAt.replace(/[-:.]/gu, '') + '-' + randomUUID();
  const manifest = parseManifest({format: 1, id, originalPath: relative(paths.home, original).split(sep).join('/'),
    route: 'local-import', folderName: basename(original), reason, digest: null, createdAt,
    unmanaged: {original: {home: ref.home, folderName: ref.folderName}, links: links.map(link => ({...link})),
      ...(keepOriginal ? {keepOriginal: true as const} : {})}}, id);
  if (Buffer.byteLength(JSON.stringify(manifest) + '\n') > 64 * 1024) throw invalidBackup();
  await unmanagedPaths(paths, manifest);
  await backupRoot(paths);
  const directory = join(paths.backups, id);
  await mkdir(directory, {mode: 0o700});
  await mkdir(join(directory, manifest.route), {mode: 0o700});
  await mkdir(join(directory, 'links'), {mode: 0o700});
  await atomicWrite(join(directory, 'manifest.json'), JSON.stringify(manifest) + '\n');
  await syncDirectory(join(directory, manifest.route));
  await syncDirectory(join(directory, 'links'));
  await syncDirectory(directory);
  await syncDirectory(paths.backups);
  return manifest;
}

/** Journal the original and its outer aliases before preserving them by rename. */
export async function backupUnmanaged(paths: HelperPaths, source: string, ref: FolderRef, links: (FolderRef & {target: string})[], now = Date.now(), beforeMove?: (manifest: BackupManifest) => Promise<void>): Promise<BackupManifest> {
  const selected = await resolveToolFolder(paths, ref);
  const original = resolve(source);
  if (selected.realPath !== original || !(await lstat(original)).isDirectory()) throw invalidBackup();
  if (selected.link && !links.some(link => link.home === ref.home && link.folderName === ref.folderName)) throw invalidBackup();
  // Validate every alias before writing or moving any part of the original.
  for (const link of links) {
    if (!safeName(link.folderName)) throw invalidBackup();
    const root = await toolHomeRoot(paths, link.home);
    if (resolve(root, link.target) !== original) throw invalidBackup();
    await checkLink(join(root, link.folderName), link.target);
  }
  const keepOriginal = !(await toolHomes(paths)).some(home => inside(home.root, original));
  if (keepOriginal && (!selected.link || !links.length)) throw invalidBackup();
  const manifest = await prepareUnmanaged(paths, original, ref, links, 'local-import', now, keepOriginal);
  await beforeMove?.(manifest);
  return finishUnmanagedBackup(paths, manifest.id);
}

/** Safe to retry after any original/link rename; completed moves are not repeated. */
export async function finishUnmanagedBackup(paths: HelperPaths, id: string, expected?: {originalPath: string; original: FolderRef; links: (FolderRef & {target: string})[]}): Promise<BackupManifest> {
  const manifest = await readManifest(paths, id);
  if (expected) {
    const refKey = (ref: FolderRef) => JSON.stringify([ref.home, ref.folderName]);
    const linkKeys = (links: (FolderRef & {target: string})[]) => links.map(link => JSON.stringify([link.home, link.folderName, link.target])).sort();
    if (!manifest.unmanaged || manifest.originalPath !== expected.originalPath ||
        refKey(manifest.unmanaged.original) !== refKey(expected.original) ||
        JSON.stringify(linkKeys(manifest.unmanaged.links)) !== JSON.stringify(linkKeys(expected.links))) throw invalidBackup();
  }
  const {original, links} = await unmanagedPaths(paths, manifest);
  if (manifest.unmanaged!.keepOriginal) {
    if (!(await lstat(original)).isDirectory()) throw invalidBackup();
    for (const [index, path] of links.entries()) {
      const saved = storedLink(paths, manifest, index);
      await assertNoSymlinks(dirname(saved), paths.backups);
      await checkLink(await exists(saved) ? saved : path, manifest.unmanaged!.links[index].target);
    }
    for (const [index, path] of links.entries()) {
      const saved = storedLink(paths, manifest, index);
      if (!await exists(saved)) await moveLink(path, saved, manifest.unmanaged!.links[index].target);
    }
    return manifest;
  }
  const folder = storedFolder(paths, manifest);
  await assertNoSymlinks(folder, paths.backups);
  const stored = await exists(folder);
  if (stored && !stored.isDirectory() && !stored.isFile()) throw invalidBackup();
  // An interrupted backup may be resumed only while its physical source stays
  // empty. A newly appeared source must not lose aliases to its new contents.
  if (stored && await exists(original)) throw invalidBackup();
  if (!stored) {
    const info = await lstat(original);
    if (!info.isDirectory() && !info.isFile()) throw invalidBackup();
  }
  // Check all pending and stored aliases before the first move.
  for (const [index, path] of links.entries()) {
    const saved = storedLink(paths, manifest, index);
    await assertNoSymlinks(dirname(saved), paths.backups);
    await checkLink(await exists(saved) ? saved : path, manifest.unmanaged!.links[index].target);
  }
  if (!stored) await durableRename(original, folder);
  for (const [index, path] of links.entries()) {
    const saved = storedLink(paths, manifest, index);
    if (!await exists(saved)) await moveLink(path, saved, manifest.unmanaged!.links[index].target);
  }
  return manifest;
}

async function preserveOccupied(paths: HelperPaths, path: string, ref: FolderRef): Promise<void> {
  const info = await exists(path);
  if (!info) return;
  if (!info.isDirectory() && !info.isFile()) throw invalidBackup();
  const backup = await prepareUnmanaged(paths, path, ref, [], 'restore-replaced', Date.now());
  await durableRename(path, storedFolder(paths, backup));
}

async function restoreUnmanaged(paths: HelperPaths, manifest: BackupManifest): Promise<BackupManifest> {
  const {original, links} = await unmanagedPaths(paths, manifest);
  const keepOriginal = manifest.unmanaged!.keepOriginal === true;
  const folder = storedFolder(paths, manifest);
  if (!keepOriginal) {
    await assertNoSymlinks(folder, paths.backups);
    const info = await lstat(folder);
    if (!info.isDirectory() && !info.isFile()) throw invalidBackup();
  }
  const current = await exists(original);
  if (keepOriginal ? !current?.isDirectory() : current && !current.isDirectory() && !current.isFile()) throw invalidBackup();
  // A link already returned by an interrupted restore is accepted only when
  // its backup slot is empty and its exact original text is still present.
  const pending: number[] = [];
  for (const [index, path] of links.entries()) {
    const saved = storedLink(paths, manifest, index), target = manifest.unmanaged!.links[index].target;
    await assertNoSymlinks(dirname(saved), paths.backups);
    if (await exists(saved)) {
      await checkLink(saved, target);
      const occupied = await exists(path);
      if (occupied && !occupied.isDirectory() && !occupied.isFile()) throw invalidBackup();
      pending.push(index);
    } else await checkLink(path, target);
  }
  if (!keepOriginal) await preserveOccupied(paths, original, manifest.unmanaged!.original);
  for (const index of pending) await preserveOccupied(paths, links[index], manifest.unmanaged!.links[index]);
  for (const destination of keepOriginal ? links : [original, ...links]) {
    await assertNoSymlinks(dirname(destination), paths.home);
    await mkdir(dirname(destination), {recursive: true, mode: 0o700});
    await assertNoSymlinks(dirname(destination), paths.home);
  }
  for (const index of pending) await moveLink(storedLink(paths, manifest, index), links[index], manifest.unmanaged!.links[index].target);
  if (keepOriginal) return manifest;
  // Return the original last, so an interrupted restore remains discoverable.
  await assertUnmanagedTarget(paths, original);
  await durableRename(folder, original);
  return manifest;
}
