import { basename, isAbsolute, relative, resolve } from 'node:path';
import { treeDigest } from './shared/build-format.js';
import { TOOL_MATRIX } from './shared/tool-matrix.js';
import { HelperError } from './config.js';
import type { DeliveryTarget } from './delivery/index.js';
import type { LockEntry } from './lock.js';
import { assertNoSymlinks, inside, type HelperPaths } from './paths.js';
import { assertRouteRoot, readSkillTree, type SafeBuildFile } from './safe-fs.js';

/** Adapters own their read-copy layout; generic routes retain the matrix layout. */
export async function managedReadFolder(paths: HelperPaths, entry: LockEntry, destination: string, target?: DeliveryTarget): Promise<string> {
  const route = Object.hasOwn(TOOL_MATRIX.routes, entry.route) ? TOOL_MATRIX.routes[entry.route] : undefined;
  if (!route || route.target !== entry.target || !route.path.startsWith('~/')) throw new HelperError('ROUTE_INVALID', 'Invalid managed skill route.');
  const root = resolve(paths.home, route.path.slice(2));
  if (destination === root || !inside(root, destination)) throw new HelperError('PATH_UNSAFE', 'The managed skill is outside its route.');
  if (target?.readFolderFor) {
    if (target.route !== entry.route || target.target !== entry.target || resolve(target.folderFor(entry)) !== resolve(destination)) {
      throw new HelperError('ROUTE_INVALID', 'The read-copy adapter does not match the managed skill.');
    }
    const folder = await target.readFolderFor(entry);
    if (!isAbsolute(folder) || basename(folder) !== basename(destination) || /[<>*?]/u.test(folder) ||
        resolve(folder) !== resolve(destination) && (inside(root, resolve(folder)) || inside(resolve(folder), root))) {
      throw new HelperError('PATH_UNSAFE', 'The tool read copy must have a separate, unambiguous path.');
    }
    // Missing caches remain observable, but their existing ancestors must still
    // pass the same HOME, protected-storage and symlink checks as route roots.
    try { await assertRouteRoot(paths, folder); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return folder;
  }
  const template = entry.target === 'claude-plugin' ? route.readPath : null;
  if (!template) return destination;
  if ((!template.startsWith('~/') && !template.startsWith('/')) || /[<>*?]/.test(template)) {
    throw new HelperError('ROUTE_INVALID', 'The tool read path must be a concrete root.');
  }
  const readRoot = template.startsWith('~/') ? resolve(paths.home, template.slice(2)) : resolve(template);
  await assertRouteRoot(paths, readRoot);
  const folder = resolve(readRoot, relative(root, destination));
  if (folder === readRoot || !inside(readRoot, folder)) throw new HelperError('PATH_UNSAFE', 'The tool read copy is outside its root.');
  await assertNoSymlinks(folder, paths.home);
  return folder;
}

export async function readLocalEdit(paths: HelperPaths, entry: LockEntry, destination: string, target?: DeliveryTarget): Promise<{folder: string; files: SafeBuildFile[]; localDigest: string}> {
  const folder = await managedReadFolder(paths, entry, destination, target);
  const files = await readSkillTree(folder, paths.home);
  return {folder, files, localDigest: treeDigest(files)};
}

/** Keep applies only to the chosen version and exact local copy. */
export function localEditNeedsQuestion(entry: LockEntry, localDigest: string, version = entry.version): boolean {
  return localDigest !== entry.digest && !(entry.keepLocal?.version === version && entry.keepLocal.localDigest === localDigest);
}
