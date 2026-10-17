import { constants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, link, lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { processStartIdentity } from './process.js';
import { ensurePrivateDirectory, readPrivateFile } from '../paths.js';

export class RunFolderError extends Error {
  constructor(readonly code: 'folder_unavailable' | 'skills_conflict' | 'config_conflict') { super(code); }
}
type Stage = {path: string; excludeLine: string | null; excludeFile: string | null; sha256: string; ino?: number; dev?: number};
type Journal = {format: 1; runId: string; cwd: string; git: Git | null; paths: Stage[]};
type Exclusions = {format: 1; lines: Record<string, {owned: boolean; consumers: string[]}>};
const reservations = new Set<string>();
// A process's own identity is stable, but a failed probe is retried on later folder work.
let ownStart: Promise<string | null> | undefined;
const ownProcessStart = () => ownStart ??= processStartIdentity(process.pid).then(value => { if (value === null) ownStart = undefined; return value; });
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const digest = (content: string | Uint8Array) => createHash('sha256').update(content).digest('hex');
function runName(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw new RunFolderError('folder_unavailable');
}
function within(root: string, path: string): boolean {
  const part = relative(root, path); return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}
async function stat(path: string) {
  try { return await lstat(path); } catch (error) { if (missing(error)) return null; throw error; }
}
/** Follow no symlinks, including an existing final component. */
async function directory(path: string, create = false): Promise<void> {
  const parent = dirname(path);
  if (parent !== path) await directory(parent, create);
  let info = await stat(path);
  if (!info && create) { try { await mkdir(path, {mode: 0o700}); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } info = await stat(path); }
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new RunFolderError('folder_unavailable');
}
async function readSafeBytes(path: string): Promise<Buffer> {
  await directory(dirname(path));
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { if (!(await handle.stat()).isFile()) throw new RunFolderError('folder_unavailable'); return await handle.readFile(); }
  finally { await handle.close(); }
}
async function readSafe(path: string): Promise<string> { return (await readSafeBytes(path)).toString('utf8'); }
async function writeNew(path: string, content: string | Uint8Array, mode = 0o600): Promise<void> {
  await directory(dirname(path), true);
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { await handle.chmod(mode); await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
}
async function writeJournal(path: string, journal: Journal | Exclusions): Promise<void> {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  await writeNew(temporary, JSON.stringify(journal));
  await rename(temporary, path);
}
type Git = {root: string; commonDir: string; excludeFile: string};
async function gitLocation(cwd: string): Promise<Git | null> {
  for (let root = cwd;; root = dirname(root)) {
    const path = join(root, '.git'), info = await stat(path);
    if (info) {
      if (info.isSymbolicLink()) throw new RunFolderError('folder_unavailable');
      let gitDir = path;
      if (info.isFile()) {
        const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(await readSafe(path));
        if (!match) throw new RunFolderError('folder_unavailable');
        gitDir = resolve(root, match[1]);
      } else if (!info.isDirectory()) throw new RunFolderError('folder_unavailable');
      await directory(gitDir);
      const common = join(gitDir, 'commondir');
      if (await stat(common)) {
        const value = (await readSafe(common)).trim();
        if (!value || /[\r\n\0]/.test(value)) throw new RunFolderError('folder_unavailable');
        gitDir = resolve(gitDir, value); await directory(gitDir);
      }
      gitDir = await realpath(gitDir);
      return {root, commonDir: gitDir, excludeFile: join(gitDir, 'info', 'exclude')};
    }
    if (dirname(root) === root) return null;
  }
}
function excludeLine(root: string, path: string, folder = false): string {
  // Git wildmatch metacharacters must represent literal project path bytes.
  const part = relative(root, path).split(sep).join('/').replace(/[\\*?[\]#! ]/g, '\\$&');
  if (/[\r\n\0]/.test(part)) throw new RunFolderError('folder_unavailable');
  return `/${part}${folder ? '/' : ''}`;
}
async function appendExclude(path: string, line: string): Promise<boolean> {
  await directory(dirname(path), true);
  const handle = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) throw new RunFolderError('folder_unavailable');
    const original = await handle.readFile('utf8');
    if (original.split('\n').includes(line)) return false;
    await handle.writeFile(`${original && !original.endsWith('\n') ? '\n' : ''}${line}\n`); await handle.sync(); return true;
  } finally { await handle.close(); }
}
async function removeExclude(path: string, line: string): Promise<void> {
  await directory(dirname(path));
  let handle;
  try { handle = await open(path, constants.O_RDWR | constants.O_NOFOLLOW); } catch (error) { if (missing(error)) return; throw error; }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) throw new RunFolderError('folder_unavailable');
    const content = await handle.readFile('utf8'), lines = content.split('\n'), index = lines.indexOf(line);
    if (index === -1) return;
    lines.splice(index, 1); const next = lines.join('\n');
    await handle.write(next, 0, 'utf8'); await handle.truncate(Buffer.byteLength(next)); await handle.sync();
  } finally { await handle.close(); }
}
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
async function staleLock(path: string, recoverMalformed = false) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    let value: {pid?: number; startedAt?: string; processStart?: string};
    try { value = JSON.parse(await readSafe(path)); }
    catch (error) {
      if (error instanceof SyntaxError && recoverMalformed && Date.now() - info.mtimeMs > 30_000) return info;
      throw error;
    }
    if (!Number.isSafeInteger(value.pid) || value.pid! <= 0) return false;
    if (!pidAlive(value.pid!)) return info;
    if (value.pid === process.pid) return reservations.has(path) ? false : info;
    const current = await processStartIdentity(value.pid!);
    if (current === null) return false;
    if (value.processStart) return value.processStart !== current ? info : false;
    if (value.startedAt && Date.parse(`${current} UTC`) > Date.parse(value.startedAt) + 1000) return info;
    return false;
  } catch (error) { if (missing(error)) return null; return false; }
}
/** Only startup recovery, after the matching run's process tree is confirmed gone. */
export async function releaseLeftoverLock(cwd: string, runId: string): Promise<void> {
  runName(runId); cwd = await realpath(cwd); await directory(cwd);
  const base = join(cwd, '.maddots'); if (!(await stat(base))) return; await directory(base);
  const path = join(base, 'run.lock'), before = await stat(path);
  if (!before?.isFile() || before.isSymbolicLink() || reservations.has(path)) return;
  let value: {runId?: string}; try { value = JSON.parse(await readSafe(path)); } catch { return; }
  if (value.runId !== runId) return;
  const current = await stat(path);
  if (current?.ino === before.ino && current.dev === before.dev) await unlink(path);
}

async function protectedData(cwd: string, dataDir: string): Promise<string> {
  const data = await realpath(dataDir); await directory(data);
  if (data === cwd || within(cwd, data)) throw new RunFolderError('folder_unavailable');
  await ensurePrivateDirectory(dataDir);
  return data;
}

async function saveStageJournal(path: string, journal: Journal): Promise<void> {
  await writeJournal(path, journal);
  // Informational copy only. A tool can delete or corrupt it, so it is never recovery authority.
  await writeJournal(join(journal.cwd, '.maddots', 'runs', journal.runId, 'staged-paths.json'), journal).catch(() => {});
}

/** One cross-process lock and consumer ledger per canonical repository in the helper data root. */
async function withExclusions<T>(git: Git, data: string, action: (state: Exclusions, save: () => Promise<void>) => Promise<T>): Promise<T> {
  await ensurePrivateDirectory(join(data, 'runner'));
  const root = join(data, 'runner', 'excludes'); await ensurePrivateDirectory(root);
  const key = digest(git.commonDir), lock = join(root, `${key}.lock`), ledger = join(root, `${key}.json`);
  // Interrupted preparation can leave a private sibling, but never an incomplete published lock.
  for (const name of await readdir(root)) if (name.startsWith(`${key}.lock.`) && name.endsWith('.tmp')) {
    const path = join(root, name);
    await (async () => {
      const before = await stat(path);
      if (!before?.isFile() || before.isSymbolicLink() || Date.now() - before.mtimeMs <= 30_000) return;
      const current = await stat(path);
      if (current?.ino === before.ino && current.dev === before.dev) await unlink(path);
    })().catch(() => {});
  }
  const content = JSON.stringify({pid: process.pid, startedAt: new Date().toISOString(), processStart: await ownProcessStart()});
  const temporary = `${lock}.${randomBytes(8).toString('hex')}.tmp`;
  await writeNew(temporary, content);
  let acquired = false;
  try {
    for (let attempt = 0; attempt < 1000; attempt++) {
      try { await link(temporary, lock); acquired = true; reservations.add(lock); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const stale = await staleLock(lock, true), current = await stat(lock);
        if (stale && current?.ino === stale.ino && current.dev === stale.dev) await unlink(lock).catch(error => { if (!missing(error)) throw error; });
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
  } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
  if (!acquired) throw new RunFolderError('folder_unavailable');
  const owned = await lstat(lock);
  try {
    const state: Exclusions = await stat(ledger) ? JSON.parse(await readSafe(ledger)) : {format: 1, lines: {}};
    if (state.format !== 1 || !state.lines || typeof state.lines !== 'object' || Array.isArray(state.lines)) throw new RunFolderError('folder_unavailable');
    return await action(state, async () => {
      if (Object.keys(state.lines).length) await writeJournal(ledger, state);
      else await unlink(ledger).catch(error => { if (!missing(error)) throw error; });
    });
  } finally {
    const current = await stat(lock);
    if (current?.ino === owned.ino && current.dev === owned.dev) await unlink(lock);
    reservations.delete(lock);
  }
}
function consumer(cwd: string, runId: string, path: string): string { return digest(JSON.stringify([cwd, runId, path])); }
async function addConsumer(git: Git, data: string, line: string, id: string): Promise<void> {
  await withExclusions(git, data, async (state, save) => {
    let entry = state.lines[line];
    if (!entry) {
      const prior = await stat(git.excludeFile) ? await readSafe(git.excludeFile) : '';
      entry = state.lines[line] = {owned: !prior.split('\n').includes(line), consumers: []};
    }
    if (!entry.consumers.includes(id)) entry.consumers.push(id);
    // Write-ahead ownership survives a crash before the actual exclude append.
    await save(); await appendExclude(git.excludeFile, line);
  });
}
async function dropConsumer(git: Git, data: string, line: string, id: string): Promise<void> {
  await withExclusions(git, data, async (state, save) => {
    const entry = state.lines[line]; if (!entry || !entry.consumers.includes(id)) return;
    if (entry.consumers.length === 1) {
      if (entry.owned) await removeExclude(git.excludeFile, line);
      delete state.lines[line];
    } else entry.consumers = entry.consumers.filter(value => value !== id);
    await save();
  });
}
export async function runFolderAvailable(cwd: string): Promise<boolean> {
  try {
    cwd = await realpath(cwd); await directory(cwd);
    const folder = join(cwd, '.maddots');
    if (!(await stat(folder))) return true;
    await directory(folder); return (await staleLock(join(folder, 'run.lock'))) !== false;
  } catch { return false; }
}
export interface RunFolder {
  cwd: string; runId: string; runDir: string; promptFile: string; outDir: string; materialDir: string;
  stageProjectFile(file: {path: string; content: string | Uint8Array; kind: 'skills' | 'config'; mode?: number}): Promise<void>;
  backupStaged(dataDir: string): Promise<void>;
  release(): Promise<void>;
}
export interface RunFolderReservation {create(): Promise<RunFolder>; release(): Promise<void>}
type RunFolderOptions = {cwd: string; dataDir: string; runId: string; startedAt?: string; pid?: number};
export async function createRunFolder(options: RunFolderOptions): Promise<RunFolder> {
  const reservation = await reserveRunFolder(options);
  try { return await reservation.create(); } catch (error) { await reservation.release(); throw error; }
}
/** Reserve the folder before claiming, without creating a run artifact on claim refusal. */
export async function reserveRunFolder(options: RunFolderOptions): Promise<RunFolderReservation> {
  runName(options.runId);
  const cwd = await realpath(options.cwd); await directory(cwd);
  const data = await protectedData(cwd, options.dataDir);
  const base = join(cwd, '.maddots'); await directory(base, true);
  const lock = join(base, 'run.lock');
  let lockHandle;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { lockHandle = await open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt) throw new RunFolderError('folder_unavailable');
      const stale = await staleLock(lock);
      if (stale === false) throw new RunFolderError('folder_unavailable');
      const current = await stat(lock);
      if (stale && current?.ino === stale.ino && current.dev === stale.dev) await unlink(lock);
    }
  }
  if (!lockHandle) throw new RunFolderError('folder_unavailable');
  reservations.add(lock);
  const owned = await lockHandle.stat();
  let live = true, created = false;
  const release = async () => { if (!live) return; const current = await stat(lock); if (current?.ino === owned.ino && current.dev === owned.dev) await unlink(lock); reservations.delete(lock); live = false; };
  try {
    const pid = options.pid ?? process.pid;
    await lockHandle.writeFile(JSON.stringify({runId: options.runId, pid, startedAt: options.startedAt ?? new Date().toISOString(), processStart: pid === process.pid ? await ownProcessStart() : await processStartIdentity(pid)}));
    await lockHandle.sync(); await lockHandle.close();
    if (!(await stat(join(base, '.gitignore')))) await writeNew(join(base, '.gitignore'), '*\n');
    else if (await readSafe(join(base, '.gitignore')) !== '*\n' && await readSafe(join(base, '.gitignore')) !== '*') throw new RunFolderError('folder_unavailable');
    return {release, async create() {
      if (!live || created) throw new RunFolderError('folder_unavailable');
      const current = await stat(lock);
      if (current?.ino !== owned.ino || current.dev !== owned.dev) throw new RunFolderError('folder_unavailable');
      created = true;
      await directory(join(base, 'runs'), true);
      const runDir = join(base, 'runs', options.runId); await mkdir(runDir, {mode: 0o700});
      for (const folder of ['material', 'skills', 'out', 'config']) await mkdir(join(runDir, folder), {mode: 0o700});
      const git = await gitLocation(cwd);
      if (git) await withExclusions(git, data, async () => { await appendExclude(git.excludeFile, excludeLine(git.root, base, true)); });
      await ensurePrivateDirectory(join(data, 'runner'));
      await ensurePrivateDirectory(join(data, 'runner', 'staged'));
      const journal: Journal = {format: 1, runId: options.runId, cwd, git, paths: []};
      const journalFile = join(data, 'runner', 'staged', `${options.runId}.json`); await writeNew(journalFile, JSON.stringify(journal));
      await saveStageJournal(journalFile, journal);
      return {cwd, runId: options.runId, runDir, promptFile: join(runDir, 'prompt.md'), outDir: join(runDir, 'out'), materialDir: join(runDir, 'material'), release,
        async stageProjectFile(file) {
          const path = resolve(cwd, file.path), code = file.kind === 'skills' ? 'skills_conflict' : 'config_conflict';
          if (!within(cwd, path) || within(base, path) || path === base || relative(cwd, path).split(sep).includes('.git')) throw new RunFolderError(code);
          try { await directory(dirname(path), true); if (await stat(path)) throw new RunFolderError(code); }
          catch { throw new RunFolderError(code); }
          const entry: Stage = {path, excludeLine: git ? excludeLine(git.root, path) : null, excludeFile: git?.excludeFile ?? null, sha256: digest(file.content)};
          journal.paths.push(entry); await saveStageJournal(journalFile, journal);
          if (git) await addConsumer(git, data, entry.excludeLine!, consumer(cwd, options.runId, path));
          try { await writeNew(path, file.content, file.mode ?? 0o600); }
          catch { if (git) await dropConsumer(git, data, entry.excludeLine!, consumer(cwd, options.runId, path)); journal.paths.splice(journal.paths.indexOf(entry), 1); await saveStageJournal(journalFile, journal); throw new RunFolderError(code); }
          const info = await lstat(path); entry.ino = info.ino; entry.dev = info.dev; await saveStageJournal(journalFile, journal);
        },
        async backupStaged(dataDir) { if (await protectedData(cwd, dataDir) !== data) throw new RunFolderError('folder_unavailable'); await recoverJournal(journal, data, journalFile); },
      };
    }};
  } catch (error) { await lockHandle.close().catch(() => {}); await release(); throw error; }
}

export async function recoverStagedFiles(options: {cwd: string; dataDir: string; runId?: string}): Promise<void> {
  const cwd = await realpath(options.cwd); await directory(cwd);
  const data = await protectedData(cwd, options.dataDir), runs = join(data, 'runner', 'staged');
  if (!(await stat(runs))) return;
  await ensurePrivateDirectory(join(data, 'runner')); await ensurePrivateDirectory(runs);
  const names = options.runId ? [options.runId] : (await readdir(runs)).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5));
  for (const name of names) {
    runName(name); const journalFile = join(runs, `${name}.json`); if (!(await stat(journalFile))) continue;
    const journal = JSON.parse(await readPrivateFile(journalFile)) as Journal;
    if (journal.format !== 1 || journal.runId !== name || !Array.isArray(journal.paths)) throw new RunFolderError('folder_unavailable');
    if (journal.cwd !== cwd) { if (options.runId) throw new RunFolderError('folder_unavailable'); continue; }
    await recoverJournal(journal, data, journalFile);
  }
}

async function recoverJournal(journal: Journal, data: string, journalFile: string): Promise<void> {
  const {cwd, runId: name, git} = journal;
  runName(name);
  await directory(cwd);
  if (await realpath(cwd) !== cwd) throw new RunFolderError('folder_unavailable');
  // These locations were established before the tool started and come only from our record.
  // Never rediscover .git here: the tool can plant or redirect it during a run.
  if (git !== null && (!git || typeof git.root !== 'string' || !isAbsolute(git.root) ||
    typeof git.commonDir !== 'string' || !isAbsolute(git.commonDir) ||
    git.excludeFile !== join(git.commonDir, 'info', 'exclude') || !(cwd === git.root || within(git.root, cwd)))) throw new RunFolderError('folder_unavailable');
  for (const entry of [...journal.paths]) {
    if (typeof entry.path !== 'string' || !isAbsolute(entry.path) || !within(cwd, entry.path) || entry.path === join(cwd, '.maddots') || within(join(cwd, '.maddots'), entry.path) || relative(cwd, entry.path).split(sep).includes('.git')) throw new RunFolderError('folder_unavailable');
    if (entry.excludeFile !== (git?.excludeFile ?? null) || (git ? typeof entry.excludeLine !== 'string' || !entry.excludeLine.startsWith('/') || /[\r\n\0]/.test(entry.excludeLine) : entry.excludeLine !== null)) throw new RunFolderError('folder_unavailable');
    await directory(dirname(entry.path)); const source = await stat(entry.path);
    if (source) {
      if (!source.isFile() || source.isSymbolicLink() || (entry.ino !== undefined ? source.ino !== entry.ino || source.dev !== entry.dev : digest(await readSafeBytes(entry.path)) !== entry.sha256)) throw new RunFolderError('folder_unavailable');
      const backup = join(data, 'backups', 'run-stage', name, relative(cwd, entry.path));
      await directory(dirname(backup), true);
      // Exclusive creation also supports a data folder on another filesystem.
      // A crash after creating the backup is replayable only if its bytes match.
      try { await link(entry.path, backup); }
      catch (error) {
        let backupExists = (error as NodeJS.ErrnoException).code === 'EEXIST';
        if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
          try { await copyFile(entry.path, backup, constants.COPYFILE_EXCL); }
          catch (copyError) { if ((copyError as NodeJS.ErrnoException).code !== 'EEXIST') throw copyError; backupExists = true; }
        } else if (!backupExists) throw error;
        if (backupExists && digest(await readSafeBytes(backup)) !== digest(await readSafeBytes(entry.path))) throw new RunFolderError('folder_unavailable');
      }
      await unlink(entry.path);
    }
    if (git && entry.excludeLine) await dropConsumer(git, data, entry.excludeLine, consumer(cwd, name, entry.path));
    journal.paths.splice(journal.paths.indexOf(entry), 1); await saveStageJournal(journalFile, journal);
  }
  if (journal.paths.length === 0) {
    await writeJournal(join(cwd, '.maddots', 'runs', name, 'staged-paths.json'), journal).catch(() => {});
    await unlink(journalFile).catch(error => { if (!missing(error)) throw error; });
  }
}
