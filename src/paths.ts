import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { TOOL_MATRIX } from './shared/tool-matrix.js';
import { HelperError, clock, type HelperConfig, type Timing } from './config.js';

export type HelperPaths = {
  home: string; data: string; logs: string; holding: string; backups: string;
  state: string; lock: string; servicePlist: string; routes: string[];
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
  for (let ancestor = data; ; ancestor = dirname(ancestor)) {
    try { await lstat(join(ancestor, '.git')); throw new HelperError('PATH_UNSAFE', 'The data folder cannot be inside a Git work tree.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (ancestor === dirname(ancestor)) break;
  }
  return { home, data, logs: join(data, 'logs'), holding: join(data, 'holding'), backups: join(data, 'backups'),
    state: join(data, 'state.json'), lock: join(data, '.lock'), servicePlist: join(home, 'Library/LaunchAgents/app.maddots.ai.helper.plist'), routes: prohibited };
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
  for (const path of [paths.data, paths.logs, paths.holding, paths.backups, ...['staging', 'cache/builds', 'exports/claude-desktop', 'updates'].map(name => join(paths.data, name))]) {
    await ensurePrivateDirectory(path);
  }
}

export async function readPrivateFile(path: string, limit = 1024 * 1024): Promise<string> {
  await assertNoSymlinks(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== owner() || (info.mode & 0o777) !== 0o600 || info.size > limit) {
      throw new HelperError('FILE_UNSAFE', 'The helper file must be private, regular, and owned by this user.');
    }
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new HelperError('FILE_UNSAFE', 'The helper file exceeded its size limit.');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await file.close(); }
}

export async function atomicWrite(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  await assertNoSymlinks(path);
  try { await readPrivateFile(path, 4 * 1024 * 1024); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(content); await file.sync(); await file.close();
    await assertNoSymlinks(path);
    await rename(temporary, path);
    const folder = await open(directory, constants.O_RDONLY);
    try { await folder.sync(); } finally { await folder.close(); }
  } finally { await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
export async function withWriteLock<T>(paths: HelperPaths, action: () => Promise<T>, timing: Timing = clock, alive: (pid: number) => boolean = processAlive): Promise<T> {
  await ensurePrivateDirectory(paths.data);
  const deadline = timing.now() + 10_000;
  let file;
  while (!file) {
    await assertNoSymlinks(paths.lock);
    try { file = await open(paths.lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const previous = await lstat(paths.lock);
        const text = await readPrivateFile(paths.lock, 32);
        if (!text && timing.now() < deadline) { await timing.sleep(50); continue; }
        const pid = Number(text);
        if (!/^\d+$/.test(text) || !Number.isSafeInteger(pid) || pid <= 0) throw new HelperError('LOCK_UNSAFE', 'The helper lock is invalid. Inspect the private .lock file before reconnecting.');
        if (!alive(pid)) {
          const latest = await lstat(paths.lock);
          if (previous.dev === latest.dev && previous.ino === latest.ino) await unlink(paths.lock);
          continue;
        }
      } catch (inspection) { if ((inspection as NodeJS.ErrnoException).code === 'ENOENT') continue; throw inspection; }
      if (timing.now() >= deadline) throw new HelperError('HELPER_BUSY', 'Another helper command is writing. Try again shortly.');
      await timing.sleep(50);
    }
  }
  try { await file.writeFile(String(process.pid)); await file.sync(); return await action(); }
  finally { await file.close(); await unlink(paths.lock); }
}

export async function assertSecretPath(path: string, paths: HelperPaths): Promise<void> {
  if (!isAbsolute(path) || paths.routes.some(route => overlaps(route, resolve(path))) || inside(paths.data, resolve(path)) || inside(dirname(paths.servicePlist), resolve(path)) || resolve(path) === join(paths.home, '.claude.json')) {
    throw new HelperError('FILE_UNSAFE', 'The token file must be an absolute path outside tool folders, helper data, and LaunchAgents.');
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
}
