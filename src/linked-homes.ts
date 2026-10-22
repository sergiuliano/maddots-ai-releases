import { lstat, readdir, readlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { scanSecrets } from './shared/skill-checks/secret-rules.js';
import { HelperError } from './config.js';
import { entryKey, safeName, type LockEntry } from './lock.js';
import { assertNoSymlinks, type HelperPaths } from './paths.js';
import { readStamp, stampMatches } from './stamp.js';
import { toolHomes, type FolderRef } from './unmanaged.js';
import type { BuildVerifier } from './verify.js';

type ManagedIdentity = Pick<LockEntry, 'skillId' | 'target' | 'name' | 'route' | 'workspaceId'>;
/** Local paths are used for verification only, never sent in inventory. */
export type ManagedHomeLink = FolderRef & {path: string; destination: string; skillKey: string};
const skipped = (error: unknown) => ['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException)?.code ?? '') || error instanceof HelperError;

/** Discover only direct aliases to the signed shared copy, without following link chains. */
export async function discoverManagedLinks(options: {paths: HelperPaths; managed: readonly ManagedIdentity[];
  verifier: BuildVerifier; helperIds: readonly string[]}): Promise<ManagedHomeLink[]> {
  const {paths, managed, verifier, helperIds} = options;
  const destinations = new Map<string, string>();
  for (const entry of managed) {
    if (entry.route !== 'agents-folder' || entry.target !== 'folder' || !safeName(entry.name)) continue;
    const destination = join(paths.home, '.agents/skills', entry.name);
    try {
      await assertNoSymlinks(destination, paths.home);
      if (!(await lstat(destination)).isDirectory()) continue;
      const stamp = await readStamp(destination, verifier, helperIds);
      if (entryKey(stamp) !== entryKey(entry) || stamp.workspaceId !== entry.workspaceId ||
          'signature' in entry && !stampMatches(stamp, entry as LockEntry)) continue;
      destinations.set(destination, entryKey(entry));
    } catch (error) { if (!skipped(error)) throw error; }
  }
  if (!destinations.size) return [];
  const links: ManagedHomeLink[] = [];
  let visited = 0;
  for (const home of await toolHomes(paths)) {
    if (scanSecrets('', home.home).length) continue;
    try {
      await assertNoSymlinks(home.root, paths.home);
      for (const entry of (await readdir(home.root, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
        if (++visited > 8000 || links.length >= 2000) return links;
        if (!entry.isSymbolicLink() || !safeName(entry.name) || scanSecrets('', entry.name).length) continue;
        const path = join(home.root, entry.name);
        try {
          const before = await lstat(path), target = await readlink(path);
          const destination = resolve(dirname(path), target), skillKey = destinations.get(destination);
          if (!before.isSymbolicLink() || !skillKey) continue;
          // A canonical folder and all its parents must remain ordinary directories.
          await assertNoSymlinks(destination, paths.home);
          const after = await lstat(path);
          if (!after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || await readlink(path) !== target) continue;
          links.push({home: home.home, folderName: entry.name, path, destination, skillKey});
        } catch (error) { if (!skipped(error)) throw error; }
      }
    } catch (error) { if (!skipped(error)) throw error; }
  }
  return links;
}

export const linkedHomeRefs = (links: readonly ManagedHomeLink[], entry: Pick<LockEntry, 'skillId' | 'target' | 'name'>): FolderRef[] =>
  links.filter(link => link.skillKey === entryKey(entry)).map(({home, folderName}) => ({home, folderName}));

export function linkedHomesWarning(name: string, homes: readonly FolderRef[]): string | null {
  return homes.length ? `${name} is also used by linked homes: ${homes.map(ref => `${ref.home}/${ref.folderName}`).join(', ')}. Updating this managed copy updates all listed homes; their links are preserved.`
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, character => '\\u{' + character.codePointAt(0)!.toString(16) + '}') : null;
}
