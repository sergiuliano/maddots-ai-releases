import { constants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, link, lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { processIsRunning, processStartIdentity } from './process.js';
import { ensurePrivateDirectory, readPrivateFile } from '../paths.js';
import {readBound, writeBound} from './state.js';
import {acquireRunnerStorageLock, retainRunnerStorageChild, type RunnerStorageDirectory, type RunnerStorageDirectoryName, type RunnerStorageLock} from './storage-lock.js';
import {findGitRepository as gitLocation, repositoryCommonDir, type GitRepository as Git} from '../git-repository.js';

export class RunFolderError extends Error {
  constructor(readonly code: 'folder_unavailable' | 'skills_conflict' | 'config_conflict') { super(code); }
}
const storageFailures = new WeakSet<object>();
export function isRunFolderStorageFailure(error: unknown): boolean {
  return error !== null && typeof error === 'object' && storageFailures.has(error);
}
async function controllerIO<T>(action: () => Promise<T>): Promise<T> {
  try {return await action();}
  catch (error) {if (error !== null && typeof error === 'object') storageFailures.add(error); throw error;}
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
function excludeLine(root: string, path: string, folder = false): string {
  // Git wildmatch metacharacters must represent literal project path bytes.
  const part = relative(root, path).split(sep).join('/').replace(/[\\*?[\]#! ]/g, '\\$&');
  if (/[\r\n\0]/.test(part)) throw new RunFolderError('folder_unavailable');
  return `/${part}${folder ? '/' : ''}`;
}
async function appendExclude(git: Git, line: string): Promise<boolean> {
  // The repository can disappear after discovery. Never recreate its ancestors.
  if (await repositoryCommonDir(git.gitDir ?? git.commonDir) !== git.commonDir) throw new RunFolderError('folder_unavailable');
  const path = git.excludeFile, infoDir = dirname(path);
  try { await mkdir(infoDir, {mode: 0o700}); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await directory(infoDir);
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
async function staleLock(path: string, recoverMalformed = false, bound?: RunnerStorageDirectory) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    let value: {pid?: number; startedAt?: string; processStart?: string};
    try { value = JSON.parse(bound ? (await readBackup(path, bound)).toString('utf8') : await readSafe(path)); }
    catch (error) {
      if (error instanceof SyntaxError && recoverMalformed && Date.now() - info.mtimeMs > 30_000) return info;
      throw error;
    }
    if (!Number.isSafeInteger(value.pid) || value.pid! <= 0) return false;
    if (!await processIsRunning(value.pid!)) return info;
    if (value.pid === process.pid) return reservations.has(path) ? false : info;
    const current = await processStartIdentity(value.pid!);
    if (current === null) return false;
    if (value.processStart) {
      // Date-based legacy Linux identities cannot prove PID reuse against ticks.
      if (current.startsWith('linux:') && !value.processStart.startsWith('linux:')) return false;
      return value.processStart !== current ? info : false;
    }
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

async function protectedData(cwd: string, dataDir: string, storage?: RunnerStorageLock): Promise<string> {
  const data = storage ? (await controllerIO(storage.assertHeld ?? storage.assertCurrent), storage.data) : await realpath(dataDir);
  if (storage && resolve(dataDir) !== data && await realpath(dataDir) !== data) throw new RunFolderError('folder_unavailable');
  if (data === cwd || within(cwd, data)) throw new RunFolderError('folder_unavailable');
  if (!storage) {await directory(data); await ensurePrivateDirectory(dataDir);}
  return data;
}

type ControllerDirectory = {path: string; binding?: RunnerStorageDirectory};
async function withControllerStorage<T>(data: string, supplied: RunnerStorageLock | undefined,
  action: (storage: RunnerStorageLock | undefined) => Promise<T>, identity?: string): Promise<T> {
  if (process.platform !== 'linux') return action(undefined);
  const storage = supplied ?? await controllerIO(() => acquireRunnerStorageLock(data));
  try {
    await controllerIO(storage.assertHeld ?? storage.assertCurrent);
    if (identity !== undefined && storage.identity !== identity) await controllerIO(async () => {throw new RunFolderError('folder_unavailable');});
    return await action(storage);
  } finally {if (!supplied) await controllerIO(() => storage.release());}
}
async function controllerDirectory(data: string, name: RunnerStorageDirectoryName, storage?: RunnerStorageLock): Promise<ControllerDirectory> {
  if (storage) {
    const binding = await controllerIO(() => storage.directory(name)); await controllerIO(() => binding.assertCurrent());
    return {path: binding.path, binding};
  }
  let path = data;
  for (const part of name.split('/')) {path = join(path, part); await controllerIO(() => ensurePrivateDirectory(path));}
  return {path};
}
async function controllerUnlink(root: ControllerDirectory, name: string): Promise<void> {
  return controllerIO(async () => {
    await root.binding?.assertCurrent();
    await unlink(join(root.path, name)).catch(error => {if (!missing(error)) throw error;});
    if (root.binding) {await root.binding.sync(); await root.binding.assertCurrent();}
  });
}
async function controllerWrite(root: ControllerDirectory, name: string, value: Journal | Exclusions, create = false): Promise<void> {
  return controllerIO(async () => {
    if (root.binding) return writeBound(root.binding, name, JSON.stringify(value), create ? {createOnly: true} : undefined);
    if (create) await writeNew(join(root.path, name), JSON.stringify(value));
    else await writeJournal(join(root.path, name), value);
  });
}
async function saveStageJournal(root: ControllerDirectory, journal: Journal): Promise<void> {
  await controllerWrite(root, journal.runId + '.json', journal);
  // Informational copy only. A tool can delete or corrupt it, so it is never recovery authority.
  await writeJournal(join(journal.cwd, '.maddots', 'runs', journal.runId, 'staged-paths.json'), journal).catch(() => {});
}

/** One cross-process lock and consumer ledger per canonical repository in the helper data root. */
async function withExclusions<T>(git: Git, data: string, action: (state: Exclusions, save: () => Promise<void>) => Promise<T>, storage?: RunnerStorageLock): Promise<T> {
  const retained = await controllerDirectory(data, 'runner/excludes', storage), root = retained.path;
  const key = digest(git.commonDir), lock = join(root, `${key}.lock`), ledger = join(root, `${key}.json`);
  // Interrupted preparation can leave a private sibling, but never an incomplete published lock.
  for (const name of await controllerIO(() => readdir(root))) if (name.startsWith(`${key}.lock.`) && name.endsWith('.tmp')) {
    const path = join(root, name);
    await (async () => {
      const before = await controllerIO(() => stat(path));
      if (!before?.isFile() || before.isSymbolicLink() || Date.now() - before.mtimeMs <= 30_000) return;
      const current = await controllerIO(() => stat(path));
      if (current?.ino === before.ino && current.dev === before.dev) await controllerIO(() => unlink(path));
    })().catch(() => {});
  }
  const content = JSON.stringify({pid: process.pid, startedAt: new Date().toISOString(), processStart: await ownProcessStart()});
  const temporary = `${lock}.${randomBytes(8).toString('hex')}.tmp`;
  if (retained.binding) {
    await controllerIO(() => retained.binding!.assertCurrent());
    const file = await controllerIO(() => open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | 0x80000, 0o600));
    try {await controllerIO(async () => {await file.writeFile(content); await file.sync();});} finally {await controllerIO(() => file.close());}
  } else await writeNew(temporary, content);
  let acquired = false;
  try {
    for (let attempt = 0; attempt < 1000; attempt++) {
      try { await controllerIO(async () => retained.binding?.assertCurrent()); await controllerIO(() => link(temporary, lock)); acquired = true; reservations.add(lock); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const stale = await staleLock(lock, true, retained.binding), current = await controllerIO(() => stat(lock));
        if (stale && current?.ino === stale.ino && current.dev === stale.dev) await controllerIO(() => unlink(lock)).catch(error => { if (!missing(error)) throw error; });
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
  } finally { await controllerIO(() => unlink(temporary)).catch(error => { if (!missing(error)) throw error; }); }
  if (!acquired) throw new RunFolderError('folder_unavailable');
  const owned = await controllerIO(() => lstat(lock));
  try {
    const state: Exclusions = await controllerIO(() => stat(ledger)) ? JSON.parse(retained.binding ? await controllerIO(() => readBound(retained.binding!, `${key}.json`)) : await controllerIO(() => readSafe(ledger))) : {format: 1, lines: {}};
    if (state.format !== 1 || !state.lines || typeof state.lines !== 'object' || Array.isArray(state.lines)) throw new RunFolderError('folder_unavailable');
    return await action(state, async () => {
      if (Object.keys(state.lines).length) await controllerWrite(retained, `${key}.json`, state);
      else await controllerUnlink(retained, `${key}.json`);
    });
  } finally {
    const current = await controllerIO(() => stat(lock));
    if (current?.ino === owned.ino && current.dev === owned.dev) await controllerIO(() => unlink(lock));
    reservations.delete(lock);
    await controllerIO(async () => retained.binding?.assertCurrent());
  }
}
function consumer(cwd: string, runId: string, path: string): string { return digest(JSON.stringify([cwd, runId, path])); }
async function addConsumer(git: Git, data: string, line: string, id: string, storage?: RunnerStorageLock): Promise<void> {
  await withExclusions(git, data, async (state, save) => {
    let entry = state.lines[line];
    if (!entry) {
      const prior = await stat(git.excludeFile) ? await readSafe(git.excludeFile) : '';
      entry = state.lines[line] = {owned: !prior.split('\n').includes(line), consumers: []};
    }
    if (!entry.consumers.includes(id)) entry.consumers.push(id);
    // Write-ahead ownership survives a crash before the actual exclude append.
    await save(); await appendExclude(git, line);
  }, storage);
}
async function dropConsumer(git: Git, data: string, line: string, id: string, storage?: RunnerStorageLock): Promise<void> {
  await withExclusions(git, data, async (state, save) => {
    const entry = state.lines[line]; if (!entry || !entry.consumers.includes(id)) return;
    if (entry.consumers.length === 1) {
      if (entry.owned) await removeExclude(git.excludeFile, line);
      delete state.lines[line];
    } else entry.consumers = entry.consumers.filter(value => value !== id);
    await save();
  }, storage);
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
type RunFolderOptions = {cwd: string; dataDir: string; runId: string; startedAt?: string; pid?: number; storage?: RunnerStorageLock};
export async function createRunFolder(options: RunFolderOptions): Promise<RunFolder> {
  const reservation = await reserveRunFolder(options);
  try { return await reservation.create(); } catch (error) { await reservation.release(); throw error; }
}
/** Reserve the folder before claiming, without creating a run artifact on claim refusal. */
export async function reserveRunFolder(options: RunFolderOptions): Promise<RunFolderReservation> {
  runName(options.runId);
  const cwd = await realpath(options.cwd); await directory(cwd);
  if (process.platform === 'linux') {
    const requestedData = options.storage?.data ?? await realpath(options.dataDir);
    if (requestedData === cwd || within(cwd, requestedData)) throw new RunFolderError('folder_unavailable');
  }
  const held = await withControllerStorage(options.dataDir, options.storage, async storage =>
    ({data: await protectedData(cwd, options.dataDir, storage), identity: storage?.identity}));
  const {data} = held;
  const control = <T>(action: (storage: RunnerStorageLock | undefined) => Promise<T>) =>
    withControllerStorage(data, options.storage, action, held.identity);
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
    return {release, create: () => control(async storage => {
      if (!live || created) throw new RunFolderError('folder_unavailable');
      const current = await stat(lock);
      if (current?.ino !== owned.ino || current.dev !== owned.dev) throw new RunFolderError('folder_unavailable');
      created = true;
      await directory(join(base, 'runs'), true);
      const runDir = join(base, 'runs', options.runId); await mkdir(runDir, {mode: 0o700});
      for (const folder of ['material', 'skills', 'out', 'config']) await mkdir(join(runDir, folder), {mode: 0o700});
      const git = await gitLocation(cwd);
      if (git) await withExclusions(git, data, async () => { await appendExclude(git, excludeLine(git.root, base, true)); }, storage);
      const staged = await controllerDirectory(data, 'runner/staged', storage);
      const journal: Journal = {format: 1, runId: options.runId, cwd, git, paths: []};
      await controllerWrite(staged, options.runId + '.json', journal, true);
      await saveStageJournal(staged, journal);
      return {cwd, runId: options.runId, runDir, promptFile: join(runDir, 'prompt.md'), outDir: join(runDir, 'out'), materialDir: join(runDir, 'material'), release,
        stageProjectFile: file => control(async storage => {
          const staged = await controllerDirectory(data, 'runner/staged', storage);
          const path = resolve(cwd, file.path), code = file.kind === 'skills' ? 'skills_conflict' : 'config_conflict';
          if (!within(cwd, path) || within(base, path) || path === base || relative(cwd, path).split(sep).includes('.git')) throw new RunFolderError(code);
          try { await directory(dirname(path), true); if (await stat(path)) throw new RunFolderError(code); }
          catch { throw new RunFolderError(code); }
          const entry: Stage = {path, excludeLine: git ? excludeLine(git.root, path) : null, excludeFile: git?.excludeFile ?? null, sha256: digest(file.content)};
          journal.paths.push(entry); await saveStageJournal(staged, journal);
          if (git) await addConsumer(git, data, entry.excludeLine!, consumer(cwd, options.runId, path), storage);
          try { await writeNew(path, file.content, file.mode ?? 0o600); }
          catch { if (git) await dropConsumer(git, data, entry.excludeLine!, consumer(cwd, options.runId, path), storage); journal.paths.splice(journal.paths.indexOf(entry), 1); await saveStageJournal(staged, journal); throw new RunFolderError(code); }
          const info = await lstat(path); entry.ino = info.ino; entry.dev = info.dev; await saveStageJournal(staged, journal);
        }),
        backupStaged: dataDir => control(async storage => {
          if (await protectedData(cwd, dataDir, storage) !== data) throw new RunFolderError('folder_unavailable');
          await recoverJournal(journal, data, await controllerDirectory(data, 'runner/staged', storage), storage);
        }),
      };
    })};
  } catch (error) { await lockHandle.close().catch(() => {}); await release(); throw error; }
}

export async function recoverStagedFiles(options: {cwd: string; dataDir: string; runId?: string; storage?: RunnerStorageLock}): Promise<void> {
  return withControllerStorage(options.dataDir, options.storage, async storage => {
    const cwd = await realpath(options.cwd); await directory(cwd);
    const data = await protectedData(cwd, options.dataDir, storage);
    if (!storage && !(await stat(join(data, 'runner/staged')))) return;
    const staged = await controllerDirectory(data, 'runner/staged', storage);
    const names = options.runId ? [options.runId] : (await controllerIO(() => readdir(staged.path))).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5));
    await controllerIO(async () => staged.binding?.assertCurrent());
    for (const name of names) {
      runName(name); await controllerIO(async () => staged.binding?.assertCurrent());
      const journalFile = join(staged.path, `${name}.json`); if (!(await controllerIO(() => stat(journalFile)))) continue;
      const journal = JSON.parse(await controllerIO(() => staged.binding ? readBound(staged.binding, name + '.json') : readPrivateFile(journalFile))) as Journal;
      if (journal.format !== 1 || journal.runId !== name || !Array.isArray(journal.paths)) throw new RunFolderError('folder_unavailable');
      if (journal.cwd !== cwd) { if (options.runId) throw new RunFolderError('folder_unavailable'); continue; }
      await recoverJournal(journal, data, staged, storage);
    }
  });
}

async function withBackup<T>(data: string, name: string, projectPath: string, storage: RunnerStorageLock | undefined,
  action: (path: string, directory?: RunnerStorageDirectory) => Promise<T>): Promise<T> {
  if (!storage) {
    const path = join(data, 'backups', 'run-stage', name, projectPath);
    await directory(dirname(path), true); return action(path);
  }
  const retained: (RunnerStorageDirectory & {close(): Promise<void>})[] = [];
  const close = async () => {
    const closed = await Promise.allSettled(retained.reverse().map(directory => controllerIO(() => directory.close())));
    const failed = closed.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  };
  try {
    let parent = await controllerIO(() => storage.directory('backups/run-stage'));
    const segments = projectPath.split(sep), basename = segments.pop()!;
    for (const segment of [name, ...segments]) {
      const child = await controllerIO(() => retainRunnerStorageChild(parent, segment)); retained.push(child); parent = child;
    }
    if (!basename || basename === '.' || basename === '..' || basename.includes('/') || basename.includes('\0')) throw new RunFolderError('folder_unavailable');
    await controllerIO(() => parent.assertCurrent());
    return await action(join(parent.path, basename), parent);
  } finally {await close();}
}
async function readBackup(path: string, bound?: RunnerStorageDirectory): Promise<Buffer> {
  if (!bound) return readSafeBytes(path);
  return controllerIO(async () => {
    await bound.assertCurrent();
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | 0x80000);
    try {
      if (!(await file.stat()).isFile()) throw new RunFolderError('folder_unavailable');
      const bytes = await file.readFile(); await bound.assertCurrent(); return bytes;
    } finally {await file.close();}
  });
}

async function recoverJournal(journal: Journal, data: string, staged: ControllerDirectory, storage?: RunnerStorageLock): Promise<void> {
  const {cwd, runId: name, git} = journal;
  runName(name);
  await directory(cwd);
  if (await realpath(cwd) !== cwd) throw new RunFolderError('folder_unavailable');
  // These locations were established before the tool started and come only from our record.
  // Never rediscover .git here: the tool can plant or redirect it during a run.
  if (git !== null && (!git || typeof git.root !== 'string' || !isAbsolute(git.root) ||
    (git.gitDir !== undefined && (typeof git.gitDir !== 'string' || !isAbsolute(git.gitDir))) ||
    typeof git.commonDir !== 'string' || !isAbsolute(git.commonDir) ||
    git.excludeFile !== join(git.commonDir, 'info', 'exclude') || !(cwd === git.root || within(git.root, cwd)))) throw new RunFolderError('folder_unavailable');
  for (const entry of [...journal.paths]) {
    if (typeof entry.path !== 'string' || !isAbsolute(entry.path) || !within(cwd, entry.path) || entry.path === join(cwd, '.maddots') || within(join(cwd, '.maddots'), entry.path) || relative(cwd, entry.path).split(sep).includes('.git')) throw new RunFolderError('folder_unavailable');
    if (entry.excludeFile !== (git?.excludeFile ?? null) || (git ? typeof entry.excludeLine !== 'string' || !entry.excludeLine.startsWith('/') || /[\r\n\0]/.test(entry.excludeLine) : entry.excludeLine !== null)) throw new RunFolderError('folder_unavailable');
    await directory(dirname(entry.path)); const source = await stat(entry.path);
    if (source) {
      if (!source.isFile() || source.isSymbolicLink() || (entry.ino !== undefined ? source.ino !== entry.ino || source.dev !== entry.dev : digest(await readSafeBytes(entry.path)) !== entry.sha256)) throw new RunFolderError('folder_unavailable');
      await withBackup(data, name, relative(cwd, entry.path), storage, async (backup, bound) => {
        // Exclusive creation also supports a data folder on another filesystem.
        // A crash after creating the backup is replayable only if its bytes match.
        try { await controllerIO(() => link(entry.path, backup)); }
        catch (error) {
          let backupExists = (error as NodeJS.ErrnoException).code === 'EEXIST';
          if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
            try { await controllerIO(() => copyFile(entry.path, backup, constants.COPYFILE_EXCL)); }
            catch (copyError) { if ((copyError as NodeJS.ErrnoException).code !== 'EEXIST') throw copyError; backupExists = true; }
          } else if (!backupExists) throw error;
          if (backupExists && digest(await readBackup(backup, bound)) !== digest(await readSafeBytes(entry.path))) throw new RunFolderError('folder_unavailable');
        }
        if (bound) {
          const file = await controllerIO(() => open(backup, constants.O_RDONLY | constants.O_NOFOLLOW | 0x80000));
          try {await controllerIO(async () => {if (!(await file.stat()).isFile()) throw new RunFolderError('folder_unavailable'); await file.sync();});}
          finally {await controllerIO(() => file.close());}
          await controllerIO(async () => {await bound.sync(); await bound.assertCurrent();});
        }
      });
      await unlink(entry.path);
    }
    if (git && entry.excludeLine) await dropConsumer(git, data, entry.excludeLine, consumer(cwd, name, entry.path), storage);
    journal.paths.splice(journal.paths.indexOf(entry), 1); await saveStageJournal(staged, journal);
  }
  if (journal.paths.length === 0) {
    await writeJournal(join(cwd, '.maddots', 'runs', name, 'staged-paths.json'), journal).catch(() => {});
    await controllerUnlink(staged, name + '.json');
  }
}
