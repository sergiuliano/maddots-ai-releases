import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { TOOL_MATRIX, type ToolMatrix } from './shared/tool-matrix.js';
import { HelperError } from './config.js';
import { skillFrontmatterName } from './delivery/agents-folder.js';
import type { DetectedTool } from './detect.js';
import { safeName, type LockEntry } from './lock.js';
import { assertNoSymlinks, inside, type HelperPaths } from './paths.js';
import { readStamp } from './stamp.js';
import type { BuildVerifier, PlanItem } from './verify.js';

type FoundTool = Pick<DetectedTool, 'tool' | 'variant'>;
type ManagedSkill = Pick<LockEntry, 'skillId' | 'name' | 'route' | 'target' | 'workspaceId'>;
export type Duplicate = {tool: string; home: string; folderName: string; skillId: string | null};
export type DuplicateQuestion = Duplicate & {action: 'replace_local'; message: 'Replace local copies'};
export type SyncQuestion = PlanItem & {duplicates: DuplicateQuestion[]};
const MAX_ROOTS = 256;
const MAX_ENTRIES = 8000;
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const unsafe = (error: unknown) => absent(error) || ['ENOTDIR', 'ELOOP', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '') ||
  error instanceof HelperError && ['PATH_UNSAFE', 'STAMP_INVALID', 'BUILD_SIGNATURE_INVALID', 'BUILD_KEY_UNKNOWN', 'FILE_UNSAFE'].includes(error.code);

function allowed(paths: HelperPaths, path: string): boolean {
  return inside(paths.home, path) && path !== paths.home && !inside(paths.data, path) &&
    !inside(join(paths.home, '.config/ibl-projects-mcp'), path) && !inside(join(paths.home, '.cache/maddots-mcp'), path);
}

/** Bounded, descriptor-checked reads of just SKILL.md, stamps, or ignore config. */
async function readMetadata(path: string, paths: HelperPaths, limit = 1024 * 1024): Promise<string | null> {
  if (!allowed(paths, path)) return null;
  try {
    await assertNoSymlinks(path, paths.home);
    const before = await lstat(path);
    if (!before.isFile() || before.size > limit) return null;
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino || info.size > limit) return null;
      const buffer = Buffer.alloc(info.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = await file.read(buffer, length, buffer.length - length, length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      const after = await file.stat();
      await assertNoSymlinks(path, paths.home);
      const latest = await lstat(path);
      if (length !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs ||
          latest.dev !== info.dev || latest.ino !== info.ino) return null;
      return buffer.subarray(0, length).toString('utf8');
    } finally { await file.close(); }
  } catch (error) { if (unsafe(error)) return null; throw error; }
}

/** Expand matrix globs only below the real HOME, skipping links at every step. */
async function rootsFor(template: string, paths: HelperPaths): Promise<string[]> {
  if (!template.startsWith('~/')) return [];
  let roots = [paths.home];
  for (const segment of template.slice(2).split('/')) {
    const next: string[] = [];
    const pattern = new RegExp('^' + segment.split('*').map(text => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('.*') + '$', 'u');
    for (const root of roots) {
      try {
        await assertNoSymlinks(root, paths.home);
        if (!allowed(paths, root) && root !== paths.home) continue;
        if (!(await lstat(root)).isDirectory()) continue;
        const entries = segment.includes('*') ? (await readdir(root, {withFileTypes: true})).filter(entry => entry.isDirectory() && pattern.test(entry.name)).map(entry => entry.name).sort() : [segment];
        for (const entry of entries) {
          const path = join(root, entry);
          if (!allowed(paths, path)) continue;
          await assertNoSymlinks(path, paths.home);
          if ((await lstat(path)).isDirectory()) next.push(path);
          if (next.length >= MAX_ROOTS) break;
        }
      } catch (error) { if (!unsafe(error)) throw error; }
      if (next.length >= MAX_ROOTS) break;
    }
    roots = next;
  }
  return roots;
}

const toolHomeKey = (paths: HelperPaths, root: string) => relative(paths.home, dirname(root)).split(sep)
  .map(part => part.replaceAll('%', '%25').replaceAll(':', '%3A')).join(':');

/** Reads covered by a grok-ignore tool's TLS-45 `[skills] ignore` entry. */
function ignoredPluginReads(tool: ToolMatrix['tools'][number]): string[] {
  if (tool.duplicateRule !== 'grok-ignore') return [];
  const plugin = TOOL_MATRIX.routes['claude-plugin'];
  return [...(plugin.readPath ? [plugin.readPath] : []), ...tool.reads.filter(path => path.includes('/plugins/'))];
}

/** Read-only evidence. TLS-18 alone performs the explicitly approved replacement. */
export async function scanDuplicates(options: {paths: HelperPaths; tools: readonly FoundTool[]; managed: readonly ManagedSkill[];
  managedFolders?: readonly string[]; verifier?: BuildVerifier; helperIds?: string[]}): Promise<Duplicate[]> {
  const {paths, managed} = options;
  if (!managed.length) return [];
  // Each adapter supplies its own layout, including all delivered names and routes.
  const canonical = new Set((options.managedFolders ?? managed.flatMap(skill => {
    const route = Object.hasOwn(TOOL_MATRIX.routes, skill.route) ? TOOL_MATRIX.routes[skill.route] : undefined;
    return route?.kind === 'folder' && route.path.startsWith('~/') && safeName(skill.name)
      ? [join(paths.home, route.path.slice(2), skill.name)] : [];
  })).map(folder => resolve(folder)));
  const plugin = TOOL_MATRIX.routes['claude-plugin'];
  const owned = new Set<string>();
  for (const template of [plugin.path, ...(plugin.readPath ? [plugin.readPath] : [])]) {
    for (const root of await rootsFor(template, paths)) owned.add(root);
  }
  const isOwned = (folder: string) => [...owned].some(root => inside(root, folder));
  const duplicates = new Map<string, Duplicate>();
  for (const tool of TOOL_MATRIX.tools.filter(tool => options.tools.some(found => found.tool === tool.key && tool.variants.some(variant => variant.key === found.variant)))) {
    // Grok's plugin reads belong to the TLS-45 ignore entry and status warning.
    const handled = ignoredPluginReads(tool);
    const visible = new Set([...tool.reads, ...tool.legacyReads].filter(template => !handled.includes(template)));
    const visibleSkillIds = new Set(managed.filter(skill => {
      const route = Object.hasOwn(TOOL_MATRIX.routes, skill.route) ? TOOL_MATRIX.routes[skill.route] : undefined;
      return route && (tool.route === skill.route || visible.has(route.path) || route.readPath !== null && visible.has(route.readPath));
    }).map(skill => skill.skillId));
    if (!visibleSkillIds.size) continue;
    const roots = new Set<string>();
    const templates = [...tool.reads, ...tool.legacyReads, ...(tool.key === 'codex' ? tool.homes.map(home => home.skills) : [])];
    for (const template of templates) {
      if (handled.includes(template)) continue;
      for (const root of await rootsFor(template, paths)) roots.add(root);
    }
    for (const root of roots) {
      const home = toolHomeKey(paths, root);
      if (!safeName(home)) continue;
      // Check each level before descending, with an independent budget per root.
      let visited = 0, level = [root];
      for (let depth = 0; depth <= 12 && level.length && visited < MAX_ENTRIES && duplicates.size < 2000; depth++) {
        const nested: string[] = [];
        for (const directory of level) {
          if (visited >= MAX_ENTRIES || duplicates.size >= 2000) break;
          if (isOwned(directory)) continue;
          try {
            await assertNoSymlinks(directory, paths.home);
            for (const entry of (await readdir(directory, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
              if (++visited > MAX_ENTRIES || duplicates.size >= 2000) break;
              if (!safeName(entry.name) || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
              const folder = join(directory, entry.name);
              if (!allowed(paths, folder) || canonical.has(resolve(folder)) || isOwned(folder)) continue;
              const text = entry.isDirectory() ? await readMetadata(join(folder, 'SKILL.md'), paths) : null;
              const name = text === null ? null : skillFrontmatterName(text);
              let skillId: string | null = null;
              if (entry.isDirectory() && options.verifier && options.helperIds?.length) {
                try {
                  // First reject special or oversized metadata, then verify the stamp.
                  if (await readMetadata(join(folder, '.maddots/skill.json'), paths) !== null) {
                    skillId = (await readStamp(folder, options.verifier, options.helperIds)).skillId;
                  }
                } catch (error) { if (!unsafe(error) && !(error instanceof HelperError)) throw error; }
              }
              const match = (skillId === null ? undefined : managed.find(skill => skill.skillId === skillId)) ??
                managed.find(skill => skill.name === entry.name || skill.name === name);
              // TLS-18 can address only a direct child using {home, folderName}.
              if (match && visibleSkillIds.has(match.skillId) && depth === 0) {
                const duplicate = {tool: tool.key, home, folderName: entry.name, skillId: match.skillId};
                duplicates.set(JSON.stringify(duplicate), duplicate);
              }
              // Skip VCS and package trees when walking nested skill collections.
              if (entry.isDirectory() && text === null && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                nested.push(folder);
              }
            }
          } catch (error) { if (!unsafe(error)) throw error; }
        }
        level = nested;
      }
    }
  }
  return [...duplicates.values()];
}

export function duplicateQuestions(duplicates: readonly Duplicate[]): DuplicateQuestion[] {
  return duplicates.map(duplicate => ({...duplicate, action: 'replace_local', message: 'Replace local copies'}));
}

export async function grokDuplicateWarning(options: {paths: HelperPaths; tools: readonly FoundTool[]; activeRoutes: readonly string[]}): Promise<string | null> {
  const grok = TOOL_MATRIX.tools.find(tool => tool.key === 'grok')!;
  if (!options.activeRoutes.includes('claude-plugin') || !options.tools.some(tool => tool.tool === grok.key && grok.variants.some(variant => variant.key === tool.variant))) return null;
  const ignoredPaths = ignoredPluginReads(grok);
  const configs = [...grok.variants.flatMap(variant => variant.detect.configPaths), ...grok.homes.map(home => home.glob + '/config.toml')];
  for (const template of new Set(configs.filter(path => path.endsWith('/config.toml')))) {
    for (const config of await rootsForConfig(template, options.paths)) {
      const text = await readMetadata(config, options.paths, 64 * 1024);
      if (text === null || text.includes('"""') || text.includes("'''")) continue;
      // This is a conservative recognizer of TLS-45's simple generated entry,
      // not a general TOML parser. Ambiguous or unrelated config keeps the warning.
      const tables = [...text.matchAll(/^\[skills\][ \t]*(?:#.*)?\r?$/gmu)];
      if (tables.length !== 1) continue;
      const section = text.slice(tables[0].index! + tables[0][0].length).split(/^\s*\[/mu)[0];
      const entries = [...section.matchAll(/^ignore[ \t]*=[ \t]*(\[(?:[^\]\r\n]|\r?\n)*\])[ \t]*(?:#.*)?$/gmu)];
      if (entries.length !== 1) continue;
      const values = entries[0][1].slice(1, -1).trim();
      if (!/^(?:(?:"[^"\\\r\n]*"|'[^'\r\n]*')[ \t\r\n]*(?:,[ \t\r\n]*(?:"[^"\\\r\n]*"|'[^'\r\n]*')[ \t\r\n]*)*,?)?$/u.test(values)) continue;
      const ignored = [...values.matchAll(/"([^"\\\r\n]*)"|'([^'\r\n]*)'/gu)].map(match => match[1] ?? match[2]);
      if (ignoredPaths.some(path => ignored.includes(path) || ignored.includes(join(options.paths.home, path.slice(2))))) return null;
    }
  }
  return 'Grok may list MadDots skills twice';
}

async function rootsForConfig(template: string, paths: HelperPaths): Promise<string[]> {
  const parents = await rootsFor(template.slice(0, template.lastIndexOf('/')), paths);
  return parents.map(parent => join(parent, basename(template)));
}
