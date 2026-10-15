import { constants, type Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { HelperError } from './config.js';
import { assertNoSymlinks, atomicWrite, ensurePrivateDirectory, readPrivateFile, type HelperPaths } from './paths.js';
import type { PlanItem } from './verify.js';

export type UnmanagedSnapshot = {format: 1; helperId: string; itemId: string; skillId: string; target: PlanItem['target']; name: string;
  digest: string; reported: boolean; completed?: true};
const unchanged = (before: Stats, after: Stats) => before.dev === after.dev && before.ino === after.ino && before.mode === after.mode &&
  before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
const changed = () => new HelperError('UNMANAGED_CHANGED', 'The unmanaged folder changed since its conflict was reported. It was kept.');
const snapshotFile = (paths: HelperPaths, itemId: string) => join(paths.data, 'unmanaged-conflicts', itemId + '.json');

/** Hash every preserved entry, including metadata and link text, without following links. */
export async function unmanagedDigest(paths: HelperPaths, folder: string, anchor = paths.home): Promise<string> {
  await assertNoSymlinks(folder, anchor);
  const hash = createHash('sha256'); let entries = 0;
  async function walk(path: string, name: string, depth: number): Promise<void> {
    if (++entries > 100_000 || depth > 100) throw new HelperError('UNMANAGED_UNREADABLE', 'The unmanaged folder is too large to compare safely.');
    await assertNoSymlinks(name ? join(path, '..') : path, anchor);
    const before = await lstat(path);
    const type = before.isDirectory() ? 'directory' : before.isFile() ? 'file' : before.isSymbolicLink() ? 'link' : null;
    if (!type || (!name && type !== 'directory')) throw new HelperError('UNMANAGED_UNREADABLE', 'The unmanaged folder contains an unsupported entry.');
    hash.update(JSON.stringify([name, type, before.mode, before.size]) + '\n');
    if (type === 'directory') {
      await assertNoSymlinks(path, anchor);
      for (const child of (await readdir(path)).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
        await walk(join(path, child), name ? name + '/' + child : child, depth + 1);
      }
    } else if (type === 'link') hash.update(JSON.stringify(await readlink(path)) + '\n');
    else {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!unchanged(before, await file.stat())) throw changed();
        const buffer = Buffer.alloc(64 * 1024); let offset = 0;
        while (offset < before.size) {
          const result = await file.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
          if (!result.bytesRead) throw changed();
          hash.update(buffer.subarray(0, result.bytesRead)); offset += result.bytesRead;
        }
        if (!unchanged(before, await file.stat())) throw changed();
      } finally { await file.close(); }
    }
    if (!unchanged(before, await lstat(path))) throw changed();
  }
  await walk(folder, '', 0); return hash.digest('hex');
}

export function unmanagedSnapshot(helperId: string, item: PlanItem, digest: string): UnmanagedSnapshot {
  return {format: 1, helperId, itemId: item.itemId, skillId: item.skillId, target: item.target, name: item.name, digest, reported: false};
}

export async function readUnmanagedSnapshot(paths: HelperPaths, helperId: string, item: Pick<PlanItem, 'itemId' | 'skillId' | 'target' | 'name'>): Promise<UnmanagedSnapshot> {
  let value: UnmanagedSnapshot;
  try { value = JSON.parse(await readPrivateFile(snapshotFile(paths, item.itemId))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new HelperError('UNMANAGED_NOT_REPORTED', 'Report this unmanaged conflict before replacing it.');
    throw error;
  }
  if (!value || value.format !== 1 || value.helperId !== helperId || value.itemId !== item.itemId || value.skillId !== item.skillId ||
      value.target !== item.target || value.name !== item.name || !/^[a-f0-9]{64}$/.test(value.digest) || typeof value.reported !== 'boolean' ||
      (value.completed !== undefined && value.completed !== true)) throw new HelperError('UNMANAGED_SNAPSHOT_INVALID', 'The unmanaged conflict snapshot is invalid.');
  return value;
}

/** A later scan cannot silently renew the first reported replacement baseline. */
export async function rememberUnmanagedSnapshot(paths: HelperPaths, snapshot: UnmanagedSnapshot): Promise<void> {
  try { await readUnmanagedSnapshot(paths, snapshot.helperId, snapshot); return; }
  catch (error) { if (!(error instanceof HelperError && error.code === 'UNMANAGED_NOT_REPORTED')) throw error; }
  await ensurePrivateDirectory(join(paths.data, 'unmanaged-conflicts'));
  await atomicWrite(snapshotFile(paths, snapshot.itemId), JSON.stringify(snapshot) + '\n');
}

export async function reportUnmanagedSnapshot(paths: HelperPaths, snapshot: UnmanagedSnapshot): Promise<void> {
  const saved = await readUnmanagedSnapshot(paths, snapshot.helperId, snapshot);
  // A changed retry cannot promote an earlier interrupted or failed report.
  if (saved.digest !== snapshot.digest || saved.reported) return;
  await atomicWrite(snapshotFile(paths, snapshot.itemId), JSON.stringify({...saved, reported: true}) + '\n');
}

export async function completeUnmanagedSnapshot(paths: HelperPaths, helperId: string,
  item: Pick<PlanItem, 'itemId' | 'skillId' | 'target' | 'name'>, digest: string): Promise<void> {
  const snapshot = await readUnmanagedSnapshot(paths, helperId, item);
  if (!snapshot.reported || snapshot.digest !== digest) throw new HelperError('UNMANAGED_SNAPSHOT_INVALID', 'The replacement journal does not match the reported folder.');
  await atomicWrite(snapshotFile(paths, item.itemId), JSON.stringify({...snapshot, completed: true}) + '\n');
}
