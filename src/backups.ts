import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, mkdir, readdir, readlink, rename } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { TOOL_MATRIX } from './shared/tool-matrix.js';
import { HelperError } from './config.js';
import type { DeliveryTarget } from './delivery/index.js';
import type { LockEntry } from './lock.js';
import { managedReadFolder } from './local-edits.js';
import { assertNoSymlinks, atomicWrite, ensurePrivateDirectory, inside, readPrivateFile, type HelperPaths } from './paths.js';
import { assertRouteRoot, atomicSymlink, directorySymlink, durableRename, placeRestoredObject, preserveSymlink, readSkillTree, restoredObjectState, stageBuild, syncDirectory, type RestorePlacementOptions, type SymlinkHooks } from './safe-fs.js';
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
  /** An unexpected object preserved independently of the replacement snapshot. */
  displaced?: {linkTarget: string | null};
  unmanaged?: { original: FolderRef; links: (FolderRef & { target: string })[]; keepOriginal?: true;
    /** HOME-relative verified delivery. Every alias points directly here after replacement. */
    managedTarget?: string };
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
  if (Object.keys(item).some(key => ![...manifestKeys, 'restorePath', 'unmanaged', 'displaced'].includes(key)) || manifestKeys.some(key => !(key in item)) || item.format !== 1 || item.id !== id ||
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
        Object.keys(unmanaged).some(key => !['original', 'links', 'keepOriginal', 'managedTarget'].includes(key)) || !ref(unmanaged.original) || !Array.isArray(unmanaged.links) ||
        (unmanaged.keepOriginal !== undefined && (unmanaged.keepOriginal !== true || !unmanaged.links.length)) ||
        (unmanaged.managedTarget !== undefined && (typeof unmanaged.managedTarget !== 'string' || unmanaged.managedTarget.startsWith('/') ||
          unmanaged.managedTarget.includes('\\') || unmanaged.managedTarget.split('/').some(part => !safeName(part)))) ||
        unmanaged.links.length > 256 || unmanaged.links.some(link => !ref(link, true)) || item.route !== 'local-import' ||
        new Set(unmanaged.links.map(link => JSON.stringify([link.home, link.folderName]))).size !== unmanaged.links.length) {
      throw new HelperError('BACKUP_INVALID', 'The unmanaged backup references are invalid.');
    }
  }
  if (item.displaced !== undefined) {
    const displaced = item.displaced as BackupManifest['displaced'], unmanaged = item.unmanaged as BackupManifest['unmanaged'];
    if (!displaced || typeof displaced !== 'object' || Array.isArray(displaced) || Object.keys(displaced).length !== 1 ||
        (displaced.linkTarget !== null && (typeof displaced.linkTarget !== 'string' || !displaced.linkTarget.length ||
          Buffer.byteLength(displaced.linkTarget) > 4096 || displaced.linkTarget.includes('\0'))) ||
        !unmanaged || unmanaged.links.length || unmanaged.keepOriginal || unmanaged.managedTarget || item.restorePath !== undefined ||
        !['replacement-displaced', 'restore-replaced'].includes(item.reason as string)) throw invalidBackup();
  }
  return item as BackupManifest;
}

function storedFolder(paths: HelperPaths, manifest: BackupManifest): string {
  return join(paths.backups, manifest.id, manifest.route, manifest.folderName);
}

export async function readBackupManifest(paths: HelperPaths, id: string): Promise<BackupManifest> {
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
    return reconcilePreservation(paths, manifest);
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

/** Offer preserved content, including aliases from a partially completed transaction. */
export type BackupListing = BackupManifest & {attention?: string};
export async function listBackups(paths: HelperPaths): Promise<BackupListing[]> {
  await backupRoot(paths);
  const results = new Map<string, BackupListing>();
  async function add(manifest: BackupManifest): Promise<void> {
    const folder = storedFolder(paths, manifest);
    if (await restoredObjectState(folder) === 'restored') return;
    await assertNoSymlinks(manifest.displaced ? dirname(folder) : folder, paths.backups);
    const info = await exists(folder);
    if (!info) return;
    if (manifest.displaced?.linkTarget !== undefined && manifest.displaced.linkTarget !== null) {
      await checkLink(folder, manifest.displaced.linkTarget);
    } else if (!info.isDirectory() && !(manifest.unmanaged && info.isFile())) {
      throw new HelperError('BACKUP_INVALID', 'A backup must contain a real folder or preserved ordinary file.');
    }
    results.set(manifest.id, manifest);
  }
  for (const id of await readdir(paths.backups)) {
    if (!idPattern.test(id)) continue;
    let manifest: BackupManifest | undefined;
    try {
      manifest = await readBackupManifest(paths, id);
      if (manifest.unmanaged) {
        if (manifest.unmanaged.managedTarget) {
          for (const backup of (await accountDisplacedObjects(paths, manifest)).backups) await add(backup);
        }
        let savedAliases = false;
        for (const index of manifest.unmanaged.links.keys()) {
          const saved = storedLink(paths, manifest, index);
          await assertNoSymlinks(dirname(saved), paths.backups);
          const state = await restoredObjectState(saved);
          if (state === 'pending' || state === 'restoring') {
            if (await exists(saved)) await checkLink(saved, manifest.unmanaged.links[index].target);
            savedAliases = true;
          }
        }
        if (savedAliases) { results.set(manifest.id, manifest); continue; }
        if (manifest.unmanaged.keepOriginal) continue;
      }
      await add(manifest);
    } catch (error) {
      // A broken transaction must not hide the other recoverable backups.
      results.set(id, {...manifest ?? {format: 1, id, originalPath: '(unreadable manifest)', route: 'local-import',
        folderName: '(unknown)', reason: 'needs-attention', digest: null, createdAt: new Date(0).toISOString()},
        attention: error instanceof HelperError ? error.code : 'BACKUP_INVALID'});
    }
  }
  return [...results.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
}

/** Preserve any current copy, then restore with exclusive file/link placement. */
export type RestoreBackupHooks = {path?: (path: string) => SymlinkHooks & RestorePlacementOptions};
async function resumeRestore(source: string, destination: string, hooks: RestoreBackupHooks): Promise<boolean> {
  const state = await restoredObjectState(source, destination);
  if (state === 'restored') return true;
  if (state !== 'restoring') return false;
  await placeRestoredObject(source, destination, hooks.path?.(destination));
  return true;
}
export async function restoreBackup(paths: HelperPaths, id: string, hooks: RestoreBackupHooks = {}): Promise<BackupManifest> {
  const manifest = await readBackupManifest(paths, id);
  if (manifest.displaced) return restoreDisplaced(paths, manifest, hooks);
  if (manifest.unmanaged) return restoreUnmanaged(paths, manifest, hooks);
  const destination = await sourcePath(paths, join(paths.home, manifest.restorePath ?? manifest.originalPath), manifest.route);
  const folder = storedFolder(paths, manifest);
  if (await resumeRestore(folder, destination, hooks)) return manifest;
  await assertNoSymlinks(folder, paths.backups);
  if (!(await lstat(folder)).isDirectory()) throw new HelperError('BACKUP_INVALID', 'The backup folder is unavailable.');
  let occupied = false;
  try { await lstat(destination); occupied = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (occupied) await backupFolder(paths, destination, manifest.route, 'restore-replaced', null);
  await sourcePath(paths, destination, manifest.route);
  await placeRestoredObject(folder, destination, hooks.path?.(destination));
  return manifest;
}

const invalidBackup = () => new HelperError('BACKUP_INVALID', 'The unmanaged backup has unsafe or changed paths.');
const exists = async (path: string) => lstat(path).catch(error => {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
  throw error;
});
const storedLink = (paths: HelperPaths, manifest: BackupManifest, index: number) => join(paths.backups, manifest.id, 'links', String(index));
const objectIdentity = (info: Stats) => ({dev: info.dev, ino: info.ino, type: info.mode & 0o170000});
const sameObject = (left: ReturnType<typeof objectIdentity>, right: ReturnType<typeof objectIdentity>) =>
  left.dev === right.dev && left.ino === right.ino && left.type === right.type;

/** A move can capture a different inode than the preflight saw. The durable
 * intent lets listing and restore repair metadata from the saved object itself. */
async function reconcilePreservation(paths: HelperPaths, manifest: BackupManifest): Promise<BackupManifest> {
  let journal;
  try { journal = JSON.parse(await readPrivateFile(join(paths.backups, manifest.id, 'preserve.json'), 16 * 1024)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return manifest; throw error; }
  const folder = storedFolder(paths, manifest);
  if (!journal || journal.format !== 1 || journal.id !== manifest.id || journal.preserved !== folder ||
      typeof journal.source !== 'string' || (!inside(paths.home, journal.source) && !inside(paths.backups, journal.source)) || !journal.identity ||
      !['dev', 'ino', 'type'].every(key => Number.isSafeInteger(journal.identity[key]))) throw invalidBackup();
  await assertNoSymlinks(dirname(folder), paths.backups);
  const info = await exists(folder);
  if (!info) return manifest;
  if (!info.isFile() && !info.isDirectory() && !info.isSymbolicLink()) throw invalidBackup();
  const linkTarget = info.isSymbolicLink() ? await readlink(folder) : null;
  if (!sameObject(objectIdentity(info), objectIdentity(await lstat(folder)))) throw invalidBackup();
  if ((manifest.displaced || info.isSymbolicLink()) && (!manifest.displaced || manifest.displaced.linkTarget !== linkTarget)) {
    manifest = parseManifest({...manifest, displaced: {linkTarget}}, manifest.id);
    await atomicWrite(join(paths.backups, manifest.id, 'manifest.json'), JSON.stringify(manifest) + '\n');
  }
  return manifest;
}

/** Preserve into a unique private slot, then describe the inode actually moved.
 * No unjournaled live-path unlink is used when capturing an unexpected object. */
async function preserveObject(paths: HelperPaths, source: string, manifest: BackupManifest, hooks: SymlinkHooks = {}): Promise<BackupManifest> {
  const destination = storedFolder(paths, manifest);
  await assertNoSymlinks(dirname(source)); await assertNoSymlinks(dirname(destination), paths.backups);
  const before = await lstat(source);
  if (!before.isDirectory() && !before.isFile() && !before.isSymbolicLink()) throw invalidBackup();
  await atomicWrite(join(paths.backups, manifest.id, 'preserve.json'), JSON.stringify({format: 1, id: manifest.id,
    source, preserved: destination, identity: objectIdentity(before)}) + '\n');
  await hooks.beforePreserve?.();
  await assertNoSymlinks(dirname(source)); await assertNoSymlinks(dirname(destination), paths.backups);
  if (await exists(destination)) throw new HelperError('DESTINATION_EXISTS', 'The preservation slot is already occupied.');
  await rename(source, destination);
  await syncDirectory(dirname(destination)); await syncDirectory(dirname(source));
  await hooks.afterPreserve?.();
  const reconciled = await reconcilePreservation(paths, manifest);
  if (!sameObject(objectIdentity(before), objectIdentity(await lstat(destination)))) {
    throw new HelperError('PATH_CHANGED', 'The displaced object changed; its actual contents are preserved in a separate backup.');
  }
  return reconciled;
}

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

async function prepareUnmanaged(paths: HelperPaths, source: string, ref: FolderRef, links: (FolderRef & {target: string})[], reason: string, now: number, keepOriginal = false, managedTarget?: string, displaced?: BackupManifest['displaced']): Promise<BackupManifest> {
  const original = resolve(source), createdAt = new Date(now).toISOString();
  const id = createdAt.replace(/[-:.]/gu, '') + '-' + randomUUID();
  const manifest = parseManifest({format: 1, id, originalPath: relative(paths.home, original).split(sep).join('/'),
    route: 'local-import', folderName: basename(original), reason, digest: null, createdAt, ...(displaced ? {displaced} : {}),
    unmanaged: {original: {home: ref.home, folderName: ref.folderName}, links: links.map(link => ({...link})),
      ...(keepOriginal ? {keepOriginal: true as const} : {}),
      ...(managedTarget ? {managedTarget: relative(paths.home, managedTarget).split(sep).join('/')} : {})}}, id);
  if (Buffer.byteLength(JSON.stringify(manifest) + '\n') > 64 * 1024) throw invalidBackup();
  await unmanagedPaths(paths, manifest);
  if (managedTarget) await replacementTarget(paths, manifest);
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

async function replacementTarget(paths: HelperPaths, manifest: BackupManifest): Promise<string> {
  const target = resolve(paths.home, manifest.unmanaged!.managedTarget!);
  const original = resolve(paths.home, manifest.originalPath);
  const route = Object.values(TOOL_MATRIX.routes).find(route => route.kind === 'folder' && route.path.startsWith('~/') &&
    dirname(target) === resolve(paths.home, route.path.slice(2)));
  if (!route || inside(original, target) || inside(target, original)) throw invalidBackup();
  await assertRouteRoot(paths, dirname(target));
  await assertNoSymlinks(target, paths.home);
  if (!(await lstat(target)).isDirectory()) throw invalidBackup();
  return target;
}

/** Journal the child backup before moving an unexpected object out of its
 * transaction slot. Retrying after either write or rename keeps the same id. */
async function accountDisplacedObjects(paths: HelperPaths, manifest: BackupManifest): Promise<{backups: BackupManifest[]; primary?: BackupManifest}> {
  const {original, links} = await unmanagedPaths(paths, manifest), unmanaged = manifest.unmanaged!;
  const slots: {path: string; ref: FolderRef; slot: string; target: string; primary: boolean}[] = links.flatMap((path, index) => [
    {path, ref: unmanaged.links[index], slot: storedLink(paths, manifest, index) + '.displaced', target: unmanaged.links[index].target, primary: false},
    {path, ref: unmanaged.links[index], slot: storedLink(paths, manifest, index) + '.restore-displaced',
      target: relative(dirname(path), resolve(paths.home, unmanaged.managedTarget!)), primary: false},
  ]);
  if (!unmanaged.keepOriginal) slots.push({path: original, ref: unmanaged.original,
    slot: storedFolder(paths, manifest), target: '', primary: true},
  {path: original, ref: unmanaged.original, slot: join(paths.backups, manifest.id, 'managed-original-link'),
    target: relative(dirname(original), resolve(paths.home, unmanaged.managedTarget!)), primary: false});
  const backups: BackupManifest[] = [];
  let primary: BackupManifest | undefined;
  for (const entry of slots) {
    await assertNoSymlinks(dirname(entry.slot), paths.backups);
    const info = await exists(entry.slot), reference = entry.slot + '.backup.json';
    let child: BackupManifest | undefined, rawReference: string | undefined;
    try { rawReference = await readPrivateFile(reference, 4096); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (rawReference !== undefined) {
      const value = JSON.parse(rawReference);
      if (!value || value.format !== 1 || typeof value.id !== 'string' || Object.keys(value).length !== 2) throw invalidBackup();
      child = await readBackupManifest(paths, value.id);
      if (!child.displaced || child.reason !== 'replacement-displaced' || child.originalPath !== relative(paths.home, entry.path).split(sep).join('/') ||
          child.unmanaged!.original.home !== entry.ref.home || child.unmanaged!.original.folderName !== entry.ref.folderName) throw invalidBackup();
    }
    if (!child && info) {
      let unexpected = entry.primary ? !info.isDirectory() : !info.isSymbolicLink() || await readlink(entry.slot) !== entry.target;
      try {
        const journal = JSON.parse(await readPrivateFile(entry.slot + '.json', 16 * 1024));
        if (!journal || journal.format !== 1 || journal.path !== entry.path || journal.preserved !== entry.slot || !journal.identity ||
            !['dev', 'ino', 'type'].every(key => Number.isSafeInteger(journal.identity[key]))) throw invalidBackup();
        unexpected ||= journal.identity.dev !== info.dev || journal.identity.ino !== info.ino || journal.identity.type !== (info.mode & 0o170000);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (!unexpected) continue;
      if (!info.isDirectory() && !info.isFile() && !info.isSymbolicLink()) throw invalidBackup();
      child = await prepareUnmanaged(paths, entry.path, entry.ref, [], 'replacement-displaced', Date.now(), false, undefined,
        {linkTarget: info.isSymbolicLink() ? await readlink(entry.slot) : null});
      await atomicWrite(reference, JSON.stringify({format: 1, id: child.id}) + '\n');
    }
    if (!child) continue;
    if (info) child = await preserveObject(paths, entry.slot, child);
    backups.push(child);
    if (entry.primary) primary = child;
  }
  return {backups, primary};
}

/** Restore a preserved object itself, including a link inode, without following
 * it. A live occupant receives its own backup before the original is returned. */
async function restoreDisplaced(paths: HelperPaths, manifest: BackupManifest, hooks: RestoreBackupHooks): Promise<BackupManifest> {
  const {original} = await unmanagedPaths(paths, manifest), folder = storedFolder(paths, manifest);
  if (await resumeRestore(folder, original, hooks)) return manifest;
  await assertNoSymlinks(dirname(folder), paths.backups);
  const info = await lstat(folder);
  if (manifest.displaced!.linkTarget === null) {
    if (!info.isDirectory() && !info.isFile()) throw invalidBackup();
  } else await checkLink(folder, manifest.displaced!.linkTarget);
  const occupied = await exists(original);
  if (occupied) {
    if (!occupied.isDirectory() && !occupied.isFile() && !occupied.isSymbolicLink()) throw invalidBackup();
    const replacement = await prepareUnmanaged(paths, original, manifest.unmanaged!.original, [], 'restore-replaced', Date.now(), false, undefined,
      {linkTarget: occupied.isSymbolicLink() ? await readlink(original) : null});
    await preserveObject(paths, original, replacement, hooks.path?.(original));
  }
  await assertNoSymlinks(dirname(original), paths.home);
  await mkdir(dirname(original), {recursive: true, mode: 0o700});
  await placeRestoredObject(folder, original, hooks.path?.(original));
  return manifest;
}

export type UnmanagedBackupHooks = {symlink?: (path: string) => SymlinkHooks};

/** Preserve aliases and journal each inode before the two-step link placement. */
async function finishLinkedReplacement(paths: HelperPaths, manifest: BackupManifest, original: string, links: string[], hooks: UnmanagedBackupHooks): Promise<BackupManifest> {
  if ((await accountDisplacedObjects(paths, manifest)).backups.length) {
    throw new HelperError('PATH_CHANGED', 'An unexpected object has its own backup. Restore this replacement before trying again.');
  }
  const target = await replacementTarget(paths, manifest), unmanaged = manifest.unmanaged!;
  const folder = storedFolder(paths, manifest), stored = await exists(folder), current = await exists(original);
  await assertNoSymlinks(folder, paths.backups);
  if (unmanaged.keepOriginal ? !current?.isDirectory() : stored
    ? !stored.isDirectory() || current && (!current.isSymbolicLink() || await readlink(original) !== relative(dirname(original), target))
    : !current?.isDirectory()) throw invalidBackup();
  // Refuse any changed live or saved alias before changing the first one.
  for (const [index, path] of links.entries()) {
    const saved = storedLink(paths, manifest, index), before = unmanaged.links[index].target;
    await assertNoSymlinks(dirname(saved), paths.backups);
    if (await exists(saved)) {
      await checkLink(saved, before);
      if (await exists(path)) {
        const live = await readlink(path);
        if (live !== before && live !== relative(dirname(path), target)) throw invalidBackup();
        await checkLink(path, live);
      } else await checkLink(saved + '.displaced', before);
    } else await checkLink(path, before);
  }
  for (const [index, path] of links.entries()) {
    const saved = storedLink(paths, manifest, index), before = unmanaged.links[index].target;
    if (!await exists(saved)) await preserveSymlink(path, saved, before);
  }
  for (const [index, path] of links.entries()) {
    const next = relative(dirname(path), target);
    if (!await exists(path) || await readlink(path) !== next) await atomicSymlink(path, next, unmanaged.links[index].target,
      {preserved: storedLink(paths, manifest, index) + '.displaced', hooks: hooks.symlink?.(path)});
  }
  if (!unmanaged.keepOriginal) {
    if (!stored || await exists(folder + '.json')) await directorySymlink(original, relative(dirname(original), target), folder, hooks.symlink?.(original));
    else if (!await exists(original)) await atomicSymlink(original, relative(dirname(original), target), null, {hooks: hooks.symlink?.(original)});
  }
  return manifest;
}

/** Journal the original and its outer aliases before preserving them by rename. */
export async function backupUnmanaged(paths: HelperPaths, source: string, ref: FolderRef, links: (FolderRef & {target: string})[], now = Date.now(), beforeMove?: (manifest: BackupManifest) => Promise<void>, managedTarget?: string, hooks: UnmanagedBackupHooks = {}): Promise<BackupManifest> {
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
  const manifest = await prepareUnmanaged(paths, original, ref, links, 'local-import', now, keepOriginal, managedTarget);
  await beforeMove?.(manifest);
  return finishUnmanagedBackup(paths, manifest.id, undefined, hooks);
}

/** Safe to retry after any original/link rename; completed moves are not repeated. */
export async function finishUnmanagedBackup(paths: HelperPaths, id: string, expected?: {originalPath: string; original: FolderRef; links: (FolderRef & {target: string})[]; managedTarget?: string}, hooks: UnmanagedBackupHooks = {}): Promise<BackupManifest> {
  const manifest = await readBackupManifest(paths, id);
  try {
    const restore = JSON.parse(await readPrivateFile(join(paths.backups, manifest.id, 'restore.json'), 4096));
    if (restore?.format !== 1 || restore.id !== manifest.id || !['restoring', 'restored'].includes(restore.state)) throw invalidBackup();
    throw new HelperError('BACKUP_RESTORED', 'This replacement was restored or is being restored; replacement cannot resume.');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (expected) {
    const refKey = (ref: FolderRef) => JSON.stringify([ref.home, ref.folderName]);
    const linkKeys = (links: (FolderRef & {target: string})[]) => links.map(link => JSON.stringify([link.home, link.folderName, link.target])).sort();
    if (!manifest.unmanaged || manifest.originalPath !== expected.originalPath ||
        refKey(manifest.unmanaged.original) !== refKey(expected.original) ||
        JSON.stringify(linkKeys(manifest.unmanaged.links)) !== JSON.stringify(linkKeys(expected.links)) ||
        manifest.unmanaged.managedTarget !== expected.managedTarget) throw invalidBackup();
  }
  const {original, links} = await unmanagedPaths(paths, manifest);
  if (manifest.unmanaged!.managedTarget) return finishLinkedReplacement(paths, manifest, original, links, hooks);
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

async function preserveOccupied(paths: HelperPaths, path: string, ref: FolderRef, independent = false, hooks: RestoreBackupHooks = {}): Promise<void> {
  const info = await exists(path);
  if (!info) return;
  if (!info.isDirectory() && !info.isFile()) throw invalidBackup();
  const backup = await prepareUnmanaged(paths, path, ref, [], 'restore-replaced', Date.now(), false, undefined,
    independent ? {linkTarget: null} : undefined);
  await preserveObject(paths, path, backup, hooks.path?.(path));
}

async function restoreUnmanaged(paths: HelperPaths, manifest: BackupManifest, hooks: RestoreBackupHooks): Promise<BackupManifest> {
  const {original, links} = await unmanagedPaths(paths, manifest);
  if (manifest.unmanaged!.managedTarget) return restoreLinkedReplacement(paths, manifest, original, links, hooks);
  const keepOriginal = manifest.unmanaged!.keepOriginal === true;
  const folder = storedFolder(paths, manifest);
  const originalRestored = !keepOriginal && await resumeRestore(folder, original, hooks);
  if (!keepOriginal && !originalRestored) {
    await assertNoSymlinks(folder, paths.backups);
    const info = await lstat(folder);
    if (!info.isDirectory() && !info.isFile()) throw invalidBackup();
  }
  const current = await exists(original);
  if (keepOriginal ? !current?.isDirectory() : !originalRestored && current && !current.isDirectory() && !current.isFile()) throw invalidBackup();
  // Exclusive symlink placement can finish before its saved source is consumed.
  // Accept that durable dual state and consume the snapshot without touching live data.
  const pending: number[] = [], placed: number[] = [];
  for (const [index, path] of links.entries()) {
    const saved = storedLink(paths, manifest, index), target = manifest.unmanaged!.links[index].target;
    await assertNoSymlinks(dirname(saved), paths.backups);
    const state = await restoredObjectState(saved, path);
    if (state === 'restored') continue;
    if (state === 'restoring') { placed.push(index); continue; }
    if (await exists(saved)) {
      await checkLink(saved, target);
      const occupied = await exists(path);
      if (occupied?.isSymbolicLink() && await readlink(path) === target) {placed.push(index); continue;}
      if (occupied && !occupied.isDirectory() && !occupied.isFile()) throw invalidBackup();
      pending.push(index);
    } else await checkLink(path, target);
  }
  const restoreJournal = join(paths.backups, manifest.id, 'restore.json');
  await atomicWrite(restoreJournal, JSON.stringify({format: 1, id: manifest.id, state: 'restoring'}) + '\n');
  if (!keepOriginal && !originalRestored) await preserveOccupied(paths, original, manifest.unmanaged!.original, false, hooks);
  for (const index of pending) await preserveOccupied(paths, links[index], manifest.unmanaged!.links[index], false, hooks);
  for (const index of placed) await placeRestoredObject(storedLink(paths, manifest, index), links[index], {...hooks.path?.(links[index]), alreadyPlaced: true});
  for (const destination of keepOriginal ? links : [original, ...links]) {
    await assertNoSymlinks(dirname(destination), paths.home);
    await mkdir(dirname(destination), {recursive: true, mode: 0o700});
    await assertNoSymlinks(dirname(destination), paths.home);
  }
  for (const index of pending) await placeRestoredObject(storedLink(paths, manifest, index), links[index], hooks.path?.(links[index]));
  if (!keepOriginal && !originalRestored) {
    // Return the original last, so an interrupted restore remains discoverable.
    await assertUnmanagedTarget(paths, original);
    await placeRestoredObject(folder, original, hooks.path?.(original));
  }
  await atomicWrite(restoreJournal, JSON.stringify({format: 1, id: manifest.id, state: 'restored'}) + '\n');
  return manifest;
}

async function restoreLinkedReplacement(paths: HelperPaths, manifest: BackupManifest, original: string, links: string[], hooks: RestoreBackupHooks): Promise<BackupManifest> {
  // The managed delivery may have been removed since the backup; restore only
  // inspects link text and never follows that now possibly missing target.
  const unmanaged = manifest.unmanaged!, target = resolve(paths.home, unmanaged.managedTarget!);
  const displaced = await accountDisplacedObjects(paths, manifest);
  const folder = storedFolder(paths, manifest), keepOriginal = unmanaged.keepOriginal === true;
  const originalRestored = !keepOriginal && await resumeRestore(folder, original, hooks);
  await assertNoSymlinks(folder, paths.backups);
  const stored = await exists(folder), returnOriginal = !keepOriginal && !originalRestored && !!stored;
  if (stored && !stored.isDirectory()) throw invalidBackup();
  const current = await exists(original), forwarded = relative(dirname(original), target);
  if (!returnOriginal && !originalRestored) {
    if (displaced.primary) {
      if (current && !current.isDirectory() && !current.isFile() &&
          (!current.isSymbolicLink() || await readlink(original) !== displaced.primary.displaced!.linkTarget)) throw invalidBackup();
    } else if (!current?.isDirectory()) throw invalidBackup();
  } else if (returnOriginal && current && !current.isDirectory() && !current.isFile() &&
      (!current.isSymbolicLink() || await readlink(original) !== forwarded)) throw invalidBackup();
  const pending: number[] = [];
  for (const [index, path] of links.entries()) {
    const saved = storedLink(paths, manifest, index), before = unmanaged.links[index].target;
    await assertNoSymlinks(dirname(saved), paths.backups);
    const state = await restoredObjectState(saved, path);
    if (state === 'restored') continue;
    if (state === 'restoring') { pending.push(index); continue; }
    if (!await exists(saved)) { await checkLink(path, before); continue; }
    await checkLink(saved, before);
    const occupied = await exists(path);
    if (occupied && !occupied.isDirectory() && !occupied.isFile() &&
        (!occupied.isSymbolicLink() || ![before, relative(dirname(path), target)].includes(await readlink(path)))) throw invalidBackup();
    pending.push(index);
  }
  // Restoring is an explicit reversal. Journal its intent before mutations so
  // a pending import cannot replay replacement after an interrupted restore.
  const restoreJournal = join(paths.backups, manifest.id, 'restore.json');
  await atomicWrite(restoreJournal, JSON.stringify({format: 1, id: manifest.id, state: 'restoring'}) + '\n');
  if (returnOriginal && current?.isSymbolicLink()) {
    const slot = join(paths.backups, manifest.id, 'managed-original-link');
    await checkLink(original, forwarded);
    const before = current;
    await atomicWrite(slot + '.json', JSON.stringify({format: 1, path: original, target: forwarded,
      preserved: slot, identity: objectIdentity(before)}) + '\n');
    await hooks.path?.(original).beforePreserve?.();
    await assertNoSymlinks(dirname(original), paths.home); await assertNoSymlinks(dirname(slot), paths.backups);
    if (await exists(slot)) throw new HelperError('DESTINATION_EXISTS', 'The preservation slot is already occupied.');
    await rename(original, slot);
    await syncDirectory(dirname(slot)); await syncDirectory(dirname(original));
    await hooks.path?.(original).afterPreserve?.();
    if (!sameObject(objectIdentity(before), objectIdentity(await lstat(slot)))) {
      throw new HelperError('PATH_CHANGED', 'The primary link changed; the displaced object is preserved in the transaction backup.');
    }
    await checkLink(slot, forwarded);
  } else if (returnOriginal) await preserveOccupied(paths, original, unmanaged.original, true, hooks);
  for (const index of pending) {
    const path = links[index], next = relative(dirname(path), target), saved = storedLink(paths, manifest, index);
    // Pin the saved inode before link placement invokes any hooks. A same-target
    // replacement in the saved slot must never become this operation's identity.
    await placeRestoredObject(saved, path, {...hooks.path?.(path), placeAlias: async () => {
      if ((await exists(path))?.isSymbolicLink()) {
        if (await readlink(path) !== unmanaged.links[index].target) {
          await atomicSymlink(path, unmanaged.links[index].target, next, {preserved: saved + '.restore-displaced', hooks: hooks.path?.(path)});
        }
      } else {
        await preserveOccupied(paths, path, unmanaged.links[index], true, hooks);
        await atomicSymlink(path, unmanaged.links[index].target, null, {hooks: hooks.path?.(path)});
      }
    }});
  }
  if (returnOriginal) await placeRestoredObject(folder, original, hooks.path?.(original));
  await atomicWrite(restoreJournal, JSON.stringify({format: 1, id: manifest.id, state: 'restored'}) + '\n');
  return manifest;
}
