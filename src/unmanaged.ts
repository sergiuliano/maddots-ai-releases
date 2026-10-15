import { lstat, readdir, readlink, realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { TOOL_MATRIX } from './shared/tool-matrix.js';
import { detectCode } from './shared/skill-checks/risk-signs.js';
import { scanSecrets } from './shared/skill-checks/secret-rules.js';
import { HelperError } from './config.js';
import { safeName } from './lock.js';
import { assertNoSymlinks, inside, type HelperPaths } from './paths.js';
import { readSkillTree } from './safe-fs.js';
import { readStamp } from './stamp.js';
import { BuildVerifier } from './verify.js';

export type ToolHome = {home: string; root: string; tools: string[]};
export type FolderRef = {home: string; folderName: string};
export type FolderLink = {target: string; targetName: string; targetHome: string | null};
export type UnmanagedFolder = FolderRef & {
  path: string; realPath: string; link: FolderLink | null; alsoLinkedFrom: FolderRef[]; hasScripts: boolean;
};
export type UnmanagedInventory = FolderRef & {link: {targetName: string; targetHome: string | null} | null; hasScripts: boolean};
const overlap = (a: string, b: string) => inside(a, b) || inside(b, a);
const absent = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
const denied = (error: unknown) => ['EACCES', 'EPERM', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '');
const unsafe = () => new HelperError('PATH_UNSAFE', 'The skill folder must be in an allowed tool home without chained or interior links.');

/** Reads may include Claude skills, but never helper, MCP, or credential storage. */
function allowed(paths: HelperPaths, path: string): boolean {
  const home = resolve(paths.home), absolute = resolve(path);
  const protectedPaths = [paths.data, '.config/ibl-projects-mcp', '.cache/maddots-mcp', '.ssh', '.aws', '.gnupg',
    '.config/op', 'Library/Keychains', 'Library/Group Containers/2BUA8C4S2C.com.1password', 'Library/LaunchAgents']
    .map(value => resolve(home, value));
  return absolute !== home && inside(home, absolute) && !protectedPaths.some(protectedPath => overlap(protectedPath, absolute));
}

/** Expand matrix globs a component at a time, without traversing linked homes. */
async function expand(paths: HelperPaths, template: string): Promise<string[]> {
  if (!template.startsWith('~/')) return [];
  let candidates = [paths.home];
  for (const segment of template.slice(2).split('/')) {
    const next: string[] = [];
    const pattern = new RegExp('^' + segment.split('*').map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    for (const parent of candidates) {
      try {
        await assertNoSymlinks(parent, paths.home);
        const names = segment.includes('*') ? (await readdir(parent)).filter(name => pattern.test(name)) : [segment];
        for (const name of names) {
          const path = join(parent, name);
          const info = await lstat(path).catch(error => { if (absent(error) || denied(error)) return null; throw error; });
          if (info?.isDirectory() && !info.isSymbolicLink()) next.push(path);
        }
      } catch (error) { if (!absent(error) && !denied(error) && (error as HelperError).code !== 'PATH_UNSAFE') throw error; }
    }
    candidates = next;
  }
  return candidates.filter(path => allowed(paths, path));
}

// Colons are escaped too, so a nested home cannot collide with a literal name.
const homeKey = (paths: HelperPaths, root: string) => relative(paths.home, dirname(root)).split(sep)
  .map(part => part.replaceAll('%', '%25').replaceAll(':', '%3A')).join(':');

/** Validate a matrix home even when its skills directory has not been created yet. */
export async function toolHomeRoot(paths: HelperPaths, home: string): Promise<string> {
  if (await realpath(paths.home) !== paths.home) throw unsafe();
  if (!safeName(home)) throw unsafe();
  let parts: string[];
  try { parts = home.split(':').map(part => decodeURIComponent(part)); } catch { throw unsafe(); }
  if (parts.some(part => !safeName(part))) throw unsafe();
  const parent = join(paths.home, ...parts), roots = new Set<string>();
  for (const tool of TOOL_MATRIX.tools) {
    for (const template of [...tool.homes.map(home => home.skills), ...tool.reads, ...tool.legacyReads]) {
      if (!template.startsWith('~/')) continue;
      const root = join(parent, basename(template));
      const expression = new RegExp('^' + template.slice(2).split('*').map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');
      if (expression.test(relative(paths.home, root)) && homeKey(paths, root) === home) roots.add(root);
    }
  }
  if (roots.size !== 1) throw unsafe();
  const root = [...roots][0];
  if (!allowed(paths, root)) throw unsafe();
  await assertNoSymlinks(root, paths.home);
  return root;
}

/** Replacement and restore destinations cannot write Claude skills or protected data. */
export async function assertUnmanagedTarget(paths: HelperPaths, path: string, allowFinalSymlink = false): Promise<void> {
  if (await realpath(paths.home) !== paths.home) throw unsafe();
  if (resolve(path) !== path || !allowed(paths, path) || overlap(join(paths.home, '.claude/skills'), path)) throw unsafe();
  await assertNoSymlinks(allowFinalSymlink ? dirname(path) : path, paths.home);
}

export async function toolHomes(paths: HelperPaths): Promise<ToolHome[]> {
  if (await realpath(paths.home) !== paths.home) throw unsafe();
  const homes = new Map<string, ToolHome>();
  for (const tool of TOOL_MATRIX.tools) {
    const templates = new Set([...tool.homes.map(home => home.skills), ...tool.reads, ...tool.legacyReads]);
    for (const template of templates) {
      for (const root of await expand(paths, template)) {
        const home = homeKey(paths, root);
        if (!safeName(home)) continue;
        const existing = homes.get(home);
        if (existing && existing.root !== root) throw unsafe();
        if (existing) { if (!existing.tools.includes(tool.key)) existing.tools.push(tool.key); }
        else homes.set(home, {home, root, tools: [tool.key]});
      }
    }
  }
  return [...homes.values()].sort((a, b) => a.home.localeCompare(b.home));
}

async function resolveFolder(paths: HelperPaths, ref: FolderRef, homes: ToolHome[]) {
  if (!safeName(ref.home) || !safeName(ref.folderName)) throw unsafe();
  const home = homes.find(home => home.home === ref.home);
  if (!home) throw unsafe();
  const path = join(home.root, ref.folderName);
  await assertNoSymlinks(home.root, paths.home);
  const info = await lstat(path);
  let realPath = path, link: FolderLink | null = null;
  if (info.isSymbolicLink()) {
    realPath = resolve(home.root, await readlink(path));
    if (!allowed(paths, realPath)) throw unsafe();
    await assertNoSymlinks(realPath, paths.home);
    if (!(await lstat(realPath)).isDirectory()) throw unsafe();
    link = {target: realPath, targetName: basename(realPath), targetHome: homes.find(home => home.root === dirname(realPath))?.home ?? null};
  } else if (!info.isDirectory()) throw unsafe();
  if (!allowed(paths, realPath)) throw unsafe();
  await assertNoSymlinks(realPath, paths.home);
  if (await realpath(realPath) !== realPath) throw unsafe();
  return {path, realPath, link};
}

/** Only the final folder may be a link; its target must be an ordinary HOME directory. */
export async function resolveToolFolder(paths: HelperPaths, ref: FolderRef): Promise<{path: string; realPath: string; link: FolderLink | null}> {
  return resolveFolder(paths, ref, await toolHomes(paths));
}

export async function listUnmanaged(paths: HelperPaths, options: {verifier?: BuildVerifier; helperIds?: string[]} = {}): Promise<UnmanagedFolder[]> {
  const homes = await toolHomes(paths), verifier = options.verifier ?? new BuildVerifier();
  const folders = new Map<string, UnmanagedFolder>();
  for (const home of homes) {
    await assertNoSymlinks(home.root, paths.home);
    let names: string[];
    try { names = (await readdir(home.root)).sort(); }
    catch (error) { if (absent(error) || denied(error)) continue; throw error; }
    for (const folderName of names) {
      if (!safeName(folderName)) continue;
      const ref = {home: home.home, folderName};
      try {
        const resolved = await resolveFolder(paths, ref, homes);
        const skill = await lstat(join(resolved.realPath, 'SKILL.md'));
        if (!skill.isFile() || skill.isSymbolicLink()) continue;
        try { await readStamp(resolved.realPath, verifier, options.helperIds ?? []); continue; }
        catch { /* A missing, foreign, or invalid signature is unmanaged. */ }
        const prior = folders.get(resolved.realPath);
        if (prior) {
          if (prior.link && !resolved.link) {
            folders.set(resolved.realPath, {...prior, ...ref, ...resolved, alsoLinkedFrom: [{home: prior.home, folderName: prior.folderName}, ...prior.alsoLinkedFrom]});
          } else prior.alsoLinkedFrom.push(ref);
          continue;
        }
        // Caps and inner links are upload refusals, not listing filters. Unknown content counts as code.
        let hasScripts = true;
        try {
          const files = await readSkillTree(resolved.realPath, paths.home);
          hasScripts = files.some(file => {
            const text = file.content.toString('utf8');
            return detectCode(file.path, text, file.mode === '100755', /^\ufeff?---\s*[\r\n][\s\S]*?allowed-tools\s*:/i.test(text)).length > 0 ||
              /(?:^|[\r\n])[ \t]*!/.test(text) || / !`/.test(text);
          });
        } catch (error) {
          if (absent(error)) continue;
          if (!(error instanceof HelperError) && !denied(error)) throw error;
        }
        folders.set(resolved.realPath, {...ref, ...resolved, alsoLinkedFrom: [], hasScripts});
      } catch (error) {
        if (!absent(error) && !(error instanceof HelperError) && !denied(error)) throw error;
      }
    }
  }
  return [...folders.values()].sort((a, b) => a.home.localeCompare(b.home) || a.folderName.localeCompare(b.folderName));
}

/** Inventory deliberately omits paths and file contents, including for aliases. */
export function unmanagedInventory(folders: readonly UnmanagedFolder[]): UnmanagedInventory[] {
  return folders.flatMap(folder => {
    const name = folder.link?.targetName ?? folder.folderName;
    const home = folder.link?.targetHome ?? (folder.link ? null : folder.home);
    const targetName = scanSecrets('', name).length ? '[redacted]' : name;
    const targetHome = home && scanSecrets('', home).length ? null : home;
    return [{home: folder.home, folderName: folder.folderName, hasScripts: folder.hasScripts,
      link: folder.link ? {targetName, targetHome} : null}, ...folder.alsoLinkedFrom.map(ref => ({...ref,
      hasScripts: folder.hasScripts, link: {targetName, targetHome}}))]
      .filter(ref => !scanSecrets('', ref.home).length && !scanSecrets('', ref.folderName).length);
  });
}
