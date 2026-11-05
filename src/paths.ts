import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, readlink, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { TOOL_MATRIX } from './shared/tool-matrix.js';
import { HelperError, type HelperConfig } from './config.js';
import {findGitRepository, GitRepositoryError} from './git-repository.js';
import { helperPlatform, type HelperPlatform } from './platform.js';
import { assertLockUpgradeReady } from './write-lock-upgrade.js';

export type HelperPaths = {
  home: string; data: string; logs: string; holding: string; backups: string;
  state: string; lock: string; servicePlist: string; routes: string[];
  platform?: HelperPlatform; config?: string; stateDir?: string; runtime?: string;
  serviceUnit?: string; serviceHeartbeat?: string; credentialFile?: string;
  linuxStorage?: {roots: string[]; states: string[]};
};
const owner = () => process.getuid?.();
export function inside(parent: string, child: string): boolean {
  const distance = relative(parent, child);
  return !distance || (!isAbsolute(distance) && distance !== '..' && !distance.startsWith(`..${sep}`));
}
const overlaps = (a: string, b: string) => inside(a, b) || inside(b, a);
const expand = (path: string, home: string, data: string) => resolve(path.replace(/^~(?=\/|$)/, home).replaceAll('<data>', data));

export async function assertNoSymlinks(path: string, anchor: string = sep): Promise<void> {
  const absolute = resolve(path), base = resolve(anchor);
  if (!inside(base, absolute)) throw new HelperError('PATH_UNSAFE', 'The path is outside its allowed folder.');
  let current = base;
  for (const segment of ['', ...relative(base, absolute).split(sep).filter(Boolean)]) {
    if (segment) current = join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new HelperError('PATH_UNSAFE', 'The helper refuses symlink path components.');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

async function canonicalParent(path: string): Promise<string> {
  let ancestor = dirname(path);
  while (true) {
    try { return await realpath(ancestor); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (ancestor === dirname(ancestor)) throw error;
      ancestor = dirname(ancestor);
    }
  }
}

async function physicalPath(path: string): Promise<string> {
  let ancestor = path;
  while (true) {
    try { return resolve(await realpath(ancestor), relative(ancestor, path)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (ancestor === dirname(ancestor)) throw error;
      ancestor = dirname(ancestor);
    }
  }
}
async function existingGlobPaths(pattern: string): Promise<string[]> {
  let paths = [sep as string];
  for (const part of pattern.split(sep).filter(Boolean)) {
    if (!part.includes('*')) { paths = paths.map(path => join(path, part)); continue; }
    const expression = new RegExp('^' + part.split('*').map(text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    const next: string[] = [];
    for (const parent of paths) {
      let entries: string[];
      try { entries = await readdir(parent); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      next.push(...entries.filter(name => expression.test(name)).map(name => join(parent, name)));
    }
    paths = next;
  }
  return paths;
}

export async function createPaths(config: HelperConfig): Promise<HelperPaths> {
  return checkedPaths(config, false);
}

/** Recovery alone can inspect the fixed user-unit mask. All other paths and
 * ordinary writer entrypoints retain the no-symlink boundary. Live recovery
 * separately verifies both masks, their parents and the systemd unit state. */
export async function createRecoveryPaths(config: HelperConfig): Promise<HelperPaths> {
  return checkedPaths(config, true);
}

async function checkedPaths(config: HelperConfig, recovery: boolean): Promise<HelperPaths> {
  const platform = helperPlatform(config.platform ?? 'darwin');
  const home = await realpath(config.home);
  const requested = config.dataDir;
  const anchor = inside(config.home, requested) ? home : await canonicalParent(requested);
  // A home alias is resolved once. Components beneath that real root are never followed.
  const data = inside(config.home, requested) ? resolve(home, relative(config.home, requested)) : requested;
  await assertNoSymlinks(data, anchor);
  const routes = Object.values(TOOL_MATRIX.routes).filter(route => route.kind !== 'zip').flatMap(route => [route.path, ...(route.readPath ? [route.readPath] : [])]).map(route => expand(route, home, data));
  const reads = TOOL_MATRIX.tools.flatMap(tool => [...tool.reads, ...tool.legacyReads, ...tool.homes.map(entry => entry.skills)]);
  const prohibited = [join(home, '.config/ibl-projects-mcp'), join(home, '.cache/maddots-mcp'), ...routes,
    ...reads.filter(path => !path.includes('*')).map(path => expand(path, home, data))];
  if (prohibited.some(path => overlaps(path, data))) throw new HelperError('PATH_UNSAFE', 'The data folder must be outside tool skill folders and maddots-mcp storage.');
  // Tools can read a symlinked skill route. Check its physical target without
  // writing or traversing its contents, so it cannot expose holding or backups.
  const routePatterns = [...routes, ...reads.map(path => expand(path, home, data))];
  for (const pattern of routePatterns) {
    for (const route of pattern.includes('*') ? await existingGlobPaths(pattern) : [pattern]) {
      if (overlaps(await physicalPath(route), data)) throw new HelperError('PATH_UNSAFE', 'The data folder must be outside the physical targets of tool skill folders.');
    }
  }
  // Configured extra tool homes are conservative boundaries for data overrides.
  for (const tool of TOOL_MATRIX.tools) {
    for (const entry of tool.homes) {
      const path = expand(entry.glob, home, data);
      const prefix = path.split('*')[0];
      if (entry.glob.includes('*') && (data.startsWith(prefix) || prefix.startsWith(data + sep))) {
        throw new HelperError('PATH_UNSAFE', 'The data folder cannot be inside a tool home.');
      }
    }
  }
  try {
    if (await findGitRepository(data)) throw new HelperError('PATH_UNSAFE', 'The data folder cannot be inside a Git work tree.');
  } catch (error) {
    if (error instanceof GitRepositoryError) throw new HelperError('PATH_UNSAFE', 'The data folder cannot use symlink or unsafe Git path components.');
    throw error;
  }
  const paths: HelperPaths = { home, data, logs: join(data, 'logs'), holding: join(data, 'holding'), backups: join(data, 'backups'),
    state: join(data, 'state.json'), lock: join(data, '.lock'), servicePlist: join(home, 'Library/LaunchAgents/app.maddots.ai.helper.plist'), routes: prohibited, platform };
  if (platform === 'darwin') return paths;

  // Resolve a home alias once, then reject linked components in every private
  // XDG boundary, including overrides outside HOME.
  const privatePath = async (requested: string, serviceMask = false): Promise<string> => {
    if (!isAbsolute(requested)) throw new HelperError('CONFIG_INVALID', 'XDG helper paths must be absolute.');
    const path = inside(config.home, requested) ? resolve(home, relative(config.home, requested)) : resolve(requested);
    const anchor = inside(config.home, requested) ? home : await canonicalParent(requested);
    if (recovery && serviceMask && path === join(home, '.config/systemd/user/app.maddots.ai.helper.service')) {
      await assertNoSymlinks(dirname(path), anchor);
      try {
        const before = await lstat(path, {bigint: true});
        if (before.isSymbolicLink()) {
          if (before.uid !== BigInt(owner()!) || before.nlink !== 1n || await readlink(path) !== '/dev/null') {
            throw new HelperError('PATH_UNSAFE', 'Recovery accepts only the owned user-unit mask pointing directly to /dev/null.');
          }
          const after = await lstat(path, {bigint: true});
          if (!after.isSymbolicLink() || after.uid !== before.uid || after.nlink !== before.nlink ||
              after.dev !== before.dev || after.ino !== before.ino || after.ctimeNs !== before.ctimeNs || await readlink(path) !== '/dev/null') {
            throw new HelperError('PATH_UNSAFE', 'The recovery user-unit mask changed during inspection.');
          }
          await assertNoSymlinks(dirname(path), anchor);
          return path;
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    await assertNoSymlinks(path, anchor);
    return path;
  };
  const configHome = config.env.XDG_CONFIG_HOME || join(config.home, '.config');
  const stateHome = config.env.XDG_STATE_HOME || join(config.home, '.local/state');
  const configDir = await privatePath(join(configHome, 'maddots-ai'));
  const stateDir = await privatePath(join(stateHome, 'maddots-ai'));
  const runtime = await privatePath(config.env.XDG_RUNTIME_DIR ? join(config.env.XDG_RUNTIME_DIR, 'mdai') : join(stateDir, 'runtime'));
  const serviceUnit = await privatePath(join(configHome, 'systemd/user/app.maddots.ai.helper.service'), true);
  if (overlaps(configDir, data) || overlaps(stateDir, data) || overlaps(runtime, data) || overlaps(configDir, stateDir) || overlaps(configDir, runtime)) {
    throw new HelperError('PATH_UNSAFE', 'Helper credential, data, state and runtime folders must keep their private boundaries separate.');
  }
  if ([data, configDir, stateDir, runtime].some(root => overlaps(root, serviceUnit))) {
    throw new HelperError('PATH_UNSAFE', 'The helper service unit must be outside its credential, data, state and runtime folders.');
  }
  // Linux private storage must be outside the whole vendor home, not just its
  // skills route. Check physical aliases as well as not-yet-created glob homes.
  const homes = TOOL_MATRIX.tools.flatMap(tool => tool.homes.map(entry => expand(entry.glob, home, data)));
  for (const path of [data, configDir, stateDir, runtime, serviceUnit]) {
    if (path === home || path === sep || prohibited.some(route => overlaps(route, path))) {
      throw new HelperError('PATH_UNSAFE', 'Private helper paths must be outside tool folders and maddots-mcp storage.');
    }
    for (const pattern of homes) {
      const prefix = pattern.split('*')[0];
      if (pattern.includes('*') ? path.startsWith(prefix) || prefix.startsWith(path + sep) : overlaps(pattern, path)) {
        throw new HelperError('PATH_UNSAFE', 'Private helper paths must be outside every tool home.');
      }
      for (const toolHome of pattern.includes('*') ? await existingGlobPaths(pattern) : [pattern]) {
        if (overlaps(await physicalPath(toolHome), path)) throw new HelperError('PATH_UNSAFE', 'Private helper paths must be outside the physical targets of tool homes.');
      }
    }
    try {
      // Repository discovery takes a directory. The unit may already exist as
      // a regular file when the service restarts or the user checks status.
      if (await findGitRepository(path === serviceUnit ? dirname(path) : path)) throw new HelperError('PATH_UNSAFE', 'Private helper paths cannot be inside a Git work tree.');
    } catch (error) {
      if (error instanceof GitRepositoryError) throw new HelperError('PATH_UNSAFE', 'Private helper paths cannot use symlink or unsafe Git path components.');
      throw error;
    }
  }
  // Preserve configured and default candidates even when today's overrides
  // hide them. In particular MADDOTS_AI_HOME must not erase XDG_DATA_HOME.
  // These are inspection boundaries, not directories to create. Historical
  // arbitrary overrides cannot be reconstructed without a coordinator record.
  const canonical = (path: string) => inside(config.home, path) ? resolve(home, relative(config.home, path)) : resolve(path);
  const dataRoots = [...new Set([data, canonical(join(config.env.XDG_DATA_HOME || join(config.home, '.local/share'), 'maddots-ai')),
    join(home, '.local/share/maddots-ai'), join(home, 'Library/Application Support/maddots-ai')])];
  const stateRoots = [...new Set([stateDir, join(home, '.local/state/maddots-ai')])];
  const linuxStorage = {
    roots: [...new Set([...dataRoots, configDir, join(home, '.config/maddots-ai'), ...stateRoots,
      ...stateRoots.map(root => join(root, 'runtime')), runtime, `/run/user/${owner()}/mdai`])].sort(),
    states: [...new Set([...dataRoots, ...stateRoots].map(root => join(root, 'state.json')))].sort(),
  };
  return {...paths, config: configDir, stateDir, runtime, serviceUnit, servicePlist: serviceUnit, linuxStorage,
    serviceHeartbeat: join(stateDir, 'service-heartbeat.json'), state: join(stateDir, 'state.json')};
}

/** Private helper boundaries shared by import and local-folder validation. */
export function protectedHelperPaths(paths: HelperPaths): string[] {
  if (paths.platform !== 'linux') return [paths.data, dirname(paths.servicePlist)];
  return [...new Set([paths.data, paths.logs, paths.backups, paths.config ?? join(paths.home, '.config/maddots-ai'),
    paths.stateDir ?? dirname(paths.state), paths.runtime ?? join(paths.stateDir ?? dirname(paths.state), 'runtime'),
    dirname(paths.serviceUnit ?? paths.servicePlist), ...(paths.credentialFile ? [dirname(paths.credentialFile)] : [])])];
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await assertNoSymlinks(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await assertNoSymlinks(path);
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== owner() || (info.mode & 0o777) !== 0o700) {
    throw new HelperError('PATH_UNSAFE', 'Private helper folders must be owned by this user with permissions 0700.');
  }
}
export async function ensurePaths(paths: HelperPaths): Promise<void> {
  await assertLockUpgradeReady(paths);
  for (const path of [paths.data, ...(paths.platform === 'linux' ? [paths.config, paths.stateDir, paths.runtime].filter((path): path is string => !!path) : []),
    paths.logs, paths.holding, paths.backups, ...['staging', 'cache/builds', 'exports/claude-desktop', 'updates'].map(name => join(paths.data, name))]) {
    await ensurePrivateDirectory(path);
  }
}

type PrivateFileOptions = {singleLink?: boolean};
export async function readPrivateFile(path: string, limit = 1024 * 1024, options: PrivateFileOptions = {}): Promise<string> {
  await assertNoSymlinks(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== owner() || (options.singleLink && info.nlink !== 1) || (info.mode & 0o777) !== 0o600 || info.size > limit) {
      throw new HelperError('FILE_UNSAFE', 'The helper file must be private, regular, and owned by this user.');
    }
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new HelperError('FILE_UNSAFE', 'The helper file exceeded its size limit.');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await file.close(); }
}

export async function atomicWrite(path: string, content: string,
  options: PrivateFileOptions & {namedTemporary?: boolean} = {}): Promise<void> {
  const directory = dirname(path);
  await assertNoSymlinks(path);
  try { await readPrivateFile(path, 4 * 1024 * 1024, options); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // Opt in only for publications sharing a directory with the Linux journal.
  const temporary = join(directory, `.${options.namedTemporary ? basename(path) + '.' : ''}${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(content); await file.sync(); await file.close();
    await assertNoSymlinks(path);
    await rename(temporary, path);
    const folder = await open(directory, constants.O_RDONLY);
    try { await folder.sync(); } finally { await folder.close(); }
  } finally { await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
}

export { withWriteLock } from './write-lock.js';

export async function assertSecretPath(path: string, paths: HelperPaths): Promise<void> {
  const absolute = resolve(path), credentialDir = paths.config ?? join(paths.home, '.config/maddots-ai');
  const defaultCredential = paths.platform === 'linux' && absolute === join(credentialDir, 'credentials.json');
  const selectedCredential = paths.platform === 'linux' && absolute === paths.credentialFile;
  if (!isAbsolute(path) || paths.routes.some(route => overlaps(route, absolute)) || protectedHelperPaths(paths).some(root =>
    inside(root, absolute) && !(defaultCredential && root === credentialDir) && !(selectedCredential && root === dirname(paths.credentialFile!))) || absolute === join(paths.home, '.claude.json')) {
    throw new HelperError('FILE_UNSAFE', paths.platform === 'linux' ? 'The token file must be an absolute path outside tool folders and helper credential, data, state, runtime and service storage.' : 'The token file must be an absolute path outside tool folders, helper data, and LaunchAgents.');
  }
  for (const tool of TOOL_MATRIX.tools) {
    for (const entry of tool.homes) {
      const home = expand(entry.glob, paths.home, paths.data), prefix = home.split('*')[0];
      if (entry.glob.includes('*') ? resolve(path).startsWith(prefix) : inside(home, resolve(path))) {
        throw new HelperError('FILE_UNSAFE', 'The token file must be outside every tool home.');
      }
    }
  }
  const patterns = [...paths.routes, ...TOOL_MATRIX.tools.flatMap(tool => tool.homes.map(entry => expand(entry.glob, paths.home, paths.data)))];
  for (const pattern of patterns) {
    for (const route of pattern.includes('*') ? await existingGlobPaths(pattern) : [pattern]) {
      if (overlaps(await physicalPath(route), resolve(path))) throw new HelperError('FILE_UNSAFE', 'The token file must be outside the physical targets of tool folders.');
    }
  }
  await assertNoSymlinks(path);
  if (paths.platform === 'linux') {
    try {
      if (await findGitRepository(dirname(path))) throw new HelperError('FILE_UNSAFE', 'The credential file cannot be inside a Git work tree.');
    } catch (error) {
      if (error instanceof GitRepositoryError) throw new HelperError('FILE_UNSAFE', 'The credential file cannot use unsafe Git path components.');
      throw error;
    }
  }
}
