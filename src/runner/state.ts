import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { appendFile, lstat, open, opendir, readdir, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { runnerOutcomeSchema, type RunnerOutcomeBody } from '../shared/runner-protocol.js';
import { HelperError } from '../config.js';
import { assertNoSymlinks, atomicWrite, ensurePrivateDirectory, readPrivateFile } from '../paths.js';
import type { ProcessGroup } from './process.js';
import {createPinnedStorageEntry} from './storage-creation.js';
import type { RunnerStorageDirectory, RunnerStorageLock } from './storage-lock.js';

export type ActiveRun = {
  runId: string; agentId: string; aiToolId: string; pid: number; startedAt: string;
  /** Wall-clock claim time. Process identity is an opaque lifetime token. */
  claimedAt?: number;
  /** A pre-/proc Linux ledger needs positive cleanup evidence before retirement. */
  legacyProcessIdentity?: true;
  /** Original legacy candidates remain barriers even after current groups are pruned. */
  legacyProcessGroups?: ProcessGroup[];
  runDir: string; phase: 'preparing' | 'running' | 'posting';
  /** Legacy rows have no fence; every newly claimed run does. */
  fence?: string;
  /** Process containment metadata, kept only in the helper's private state. */
  pgid?: number;
  processGroups?: ProcessGroup[];
};
export type PendingOutcome = { runId: string; aiToolId: string; queuedAt: number; body: RunnerOutcomeBody };
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const fail = (): never => { throw new HelperError('RUNNER_STATE_INVALID', 'Runner state could not be read safely.'); };
const CLOSE_ON_EXEC = 0x80000;
const sameFile = (a: {dev: number; ino: number}, b: {dev: number; ino: number}) => a.dev === b.dev && a.ino === b.ino;
export function boundPath(directory: RunnerStorageDirectory, name: string): string {
  // Only exact retained descriptors and a single local basename may cross the
  // procfs anchor. User paths and nested/symlink traversal never use this seam.
  if (!/^\/proc\/self\/fd\/\d+$/u.test(directory.path) || !/^[A-Za-z0-9._-]+$/u.test(name) || name === '.' || name === '..') fail();
  return join(directory.path, name);
}
async function privateBoundFile(file: FileHandle, path: string, limit = Number.MAX_SAFE_INTEGER): Promise<number> {
  const info = await file.stat(), latest = await lstat(path);
  if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.nlink !== 1 ||
      info.size > limit || !latest.isFile() || !sameFile(info, latest)) fail();
  return info.size;
}
async function readBoundFile(directory: RunnerStorageDirectory, name: string, limit: number): Promise<string> {
  const path = boundPath(directory, name);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | CLOSE_ON_EXEC);
  try {
    const size = await privateBoundFile(file, path, limit);
    const buffer = Buffer.alloc(limit + 1), {bytesRead} = await file.read(buffer, 0, buffer.length, 0);
    // A short read can end at a valid JSON prefix while hiding a corrupt tail.
    // Treat short reads and size changes as uncertainty without extra warm I/O.
    if (bytesRead !== size || bytesRead > limit) fail();
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {await file.close();}
}
export async function readBound(directory: RunnerStorageDirectory, name: string, limit = 1024 * 1024): Promise<string> {
  await directory.assertCurrent();
  try {return await readBoundFile(directory, name, limit);}
  finally {await directory.assertCurrent();}
}
async function checkBoundTarget(path: string, limit: number): Promise<Stats | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.nlink !== 1 || info.size > limit) fail();
    return info;
  } catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
}
/** Physical publication only. The retained owner supplies serialization and caller deadlines. */
export async function writeBound(directory: RunnerStorageDirectory, name: string, content: string,
  options: {createOnly?: boolean} = {}): Promise<void> {
  await directory.assertCurrent();
  const path = boundPath(directory, name);
  try {await readBoundFile(directory, name, 4 * 1024 * 1024);}
  catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
  // Preserve the publication target in its temporary namespace so replay can
  // distinguish companion saves from ambiguous journal publication debris.
  const temporary = boundPath(directory, `.${name}.${randomUUID()}.tmp`);
  const creation = await createPinnedStorageEntry(temporary, 'file'), file = creation.file;
  let retained = false;
  try {
    await file.writeFile(content); await file.sync(); await file.close();
    // A second payload read adds no authority. Refuse unsafe replacement
    // targets by metadata, then publish through the retained directory only.
    const previous = await checkBoundTarget(path, 4 * 1024 * 1024);
    await (directory.assertLinked ?? directory.assertCurrent)();
    await directory.assertCreatedFiles?.();
    await creation.assertLinked(temporary);
    // Both names resolve through the same retained directory. The shared
    // primitive rechecks the pins without yielding before changing names.
    creation.publish(temporary, path, {...options, previous});
    await creation.assertLinked(path, options.createOnly ? 2 : 1);
    if (options.createOnly) {
      // link(2) supplies atomic no-replace publication. Unlike rename(2), it
      // cannot overwrite an immutable journal record even if a name appears
      // between validation and publication. A crash with both links present
      // remains invalid until an explicit recovery protocol handles it.
      await creation.assertLinked(temporary, 2);
      creation.unlink(temporary, path);
    }
    await creation.assertLinked(path);
    await directory.sync();
    await creation.assertLinked(path);
    await directory.assertCurrent();
    if (directory.retainCreatedFile) {directory.retainCreatedFile(name, creation); retained = true;}
  } finally {
    // A failed publication is evidence, including an unexpected replacement in
    // the temporary namespace. Never unlink it as generic failure cleanup.
    try {await file.close().catch(() => {});} finally {if (!retained) creation.closePin();}
  }
}

/** Bound the directory walk itself, rather than materializing an unbounded readdir result. */
export async function listBound(directory: RunnerStorageDirectory, limit: number): Promise<string[]> {
  if (!/^\/proc\/self\/fd\/\d+$/u.test(directory.path) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100_000) fail();
  await directory.assertCurrent();
  const names: string[] = [], folder = await opendir(directory.path);
  try {
    for await (const entry of folder) {
      if (names.length >= limit) fail();
      names.push(entry.name);
    }
  } finally {await folder.close().catch(() => {}); await directory.assertCurrent();}
  return names.sort();
}

// A small schema walker keeps this helper independent of the server's validator.
function matches(value: unknown, schema: Record<string, any>): boolean {
  if (schema.anyOf) return schema.anyOf.some((part: Record<string, any>) => matches(value, part));
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === 'null') return value === null;
  if (schema.type === 'string') return typeof value === 'string' &&
    (!schema.minLength || value.length >= schema.minLength) && (!schema.maxLength || value.length <= schema.maxLength) &&
    (!schema.pattern || new RegExp(schema.pattern).test(value)) && (schema.format !== 'date-time' || Number.isFinite(Date.parse(value))) &&
    (schema.format !== 'uuid' || id(value));
  if (schema.type === 'integer') return typeof value === 'number' && Number.isSafeInteger(value) && value >= schema.minimum && value <= schema.maximum;
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'array') return Array.isArray(value) && value.length <= schema.maxItems && value.every(item => matches(item, schema.items));
  if (schema.type === 'object') return !!value && typeof value === 'object' && !Array.isArray(value) &&
    schema.required.every((key: string) => Object.hasOwn(value, key)) &&
    Object.entries(value).every(([key, item]) => Object.hasOwn(schema.properties, key) && matches(item, schema.properties[key]));
  return true;
}
export function outcomeMetadataValid(model: string, provider: string | null): boolean {
  return matches(model, runnerOutcomeSchema.properties.model as Record<string, any>) &&
    matches(provider, runnerOutcomeSchema.properties.provider as Record<string, any>) && !/pm_|mdai_skill_/.test(model + (provider ?? ''));
}
function validActive(rows: unknown): rows is ActiveRun[] {
  // Historical tool pids may now belong to this helper. Validate their shape
  // here; recovery checks identities and excludes this helper before signalling.
  const processIdentity = (value: {pid: number; startedAt: string}) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === 'pid,startedAt' && Number.isSafeInteger(value.pid) && value.pid > 1 &&
    typeof value.startedAt === 'string' && !!value.startedAt && value.startedAt.length <= 100 && !/[^\x20-\x7e]/u.test(value.startedAt);
  const fields = ['agentId', 'aiToolId', 'phase', 'pid', 'runDir', 'runId', 'startedAt'].join(',');
  return Array.isArray(rows) && rows.length <= 20 && new Set(rows.map(row => row?.runId)).size === rows.length && rows.every(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).filter(key => !['fence', 'pgid', 'processGroups', 'claimedAt', 'legacyProcessIdentity', 'legacyProcessGroups'].includes(key)).sort().join(',') !== fields ||
      row.claimedAt !== undefined && (!Number.isSafeInteger(row.claimedAt) || row.claimedAt < 0) ||
      row.legacyProcessIdentity !== undefined && row.legacyProcessIdentity !== true ||
      row.legacyProcessGroups !== undefined && row.legacyProcessIdentity !== true ||
      row.fence !== undefined && (typeof row.fence !== 'string' || !/^[a-f0-9]{32}$/u.test(row.fence)) ||
      row.pgid !== undefined && (!Number.isSafeInteger(row.pgid) || row.pgid <= 1) ||
      [row.processGroups, row.legacyProcessGroups].some(groups => groups !== undefined && (!Array.isArray(groups) || groups.length > 4096 ||
        groups.some((group: ProcessGroup) => !group || typeof group !== 'object' || Array.isArray(group) ||
          Object.keys(group).some(key => !['pgid', 'startedAt', 'spawnedBy', 'sid', 'members', 'sessionLeader', 'cleanupPending'].includes(key)) ||
          !Number.isSafeInteger(group.pgid) || group.pgid <= 1 ||
          typeof group.startedAt !== 'string' || group.startedAt.length > 100 || /[^\x20-\x7e]/u.test(group.startedAt) ||
          group.spawnedBy !== undefined && (!Number.isSafeInteger(group.spawnedBy) || group.spawnedBy < 0) ||
          group.cleanupPending !== undefined && group.cleanupPending !== true ||
          group.sid !== undefined && (typeof group.sid !== 'string' || !group.sid || group.sid.length > 100 || /[^\x21-\x7e]/u.test(group.sid)) ||
          group.members !== undefined && (!Array.isArray(group.members) || group.members.length > 4096 || !group.members.every(processIdentity)) ||
          group.sessionLeader !== undefined && !processIdentity(group.sessionLeader)))) ||
      !id(row.runId) || !id(row.agentId) || !id(row.aiToolId) || !Number.isSafeInteger(row.pid) || row.pid < 0 || row.pid === 1 ||
      typeof row.startedAt !== 'string' || !row.startedAt || row.startedAt.length > 100 || [...row.startedAt].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
      typeof row.runDir !== 'string' || !isAbsolute(row.runDir) || resolve(row.runDir) !== row.runDir ||
      !['preparing', 'running', 'posting'].includes(row.phase) || /pm_run_|mdai_skill_/.test(JSON.stringify(row))) return false;
    const cwd = dirname(dirname(dirname(row.runDir)));
    return row.runDir === join(cwd, '.maddots', 'runs', row.runId);
  });
}

function legacyWallTime(identity: string): number | undefined {
  // Old Linux rows used either an ISO claim time or ps's UTC/C lstart value.
  // No kernel identity can be reconstructed from either wall-clock value.
  const time = /^\d{4}-\d{2}-\d{2}T/u.test(identity) ? Date.parse(identity)
    : /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s/u.test(identity) ? Date.parse(`${identity} UTC`) : NaN;
  return Number.isSafeInteger(time) && time >= 0 ? time : undefined;
}

function migrateActive(row: ActiveRun): ActiveRun {
  const claimedAt = row.claimedAt ?? legacyWallTime(row.startedAt);
  const oldIdentity = (row.pid > 0 || row.pgid !== undefined || !!row.processGroups?.length) && legacyWallTime(row.startedAt) !== undefined ||
    row.processGroups?.some(group => legacyWallTime(group.startedAt) !== undefined ||
      group.members?.some(member => legacyWallTime(member.startedAt) !== undefined) ||
      group.sessionLeader && legacyWallTime(group.sessionLeader.startedAt) !== undefined);
  return {...row, ...(claimedAt === undefined ? {} : {claimedAt}),
    ...(process.platform === 'linux' && oldIdentity ? {legacyProcessIdentity: true as const} : {})};
}
function validPending(row: unknown): row is PendingOutcome {
  if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).sort().join(',') !== 'aiToolId,body,queuedAt,runId') return false;
  const value = row as PendingOutcome;
  return id(value.runId) && id(value.aiToolId) && Number.isSafeInteger(value.queuedAt) && value.queuedAt >= 0 &&
    matches(value.body, runnerOutcomeSchema) && !/pm_run_|mdai_skill_/.test(JSON.stringify(value));
}

export class RunnerState {
  directory: string;
  outcomes: string;
  private storage?: RunnerStorageLock;
  constructor(public data: string) { this.directory = join(data, 'runner'); this.outcomes = join(this.directory, 'outcomes'); }
  // Linux's retained owner binds paths once, after acquiring the directory
  // object. This also makes symlink aliases use the same canonical writer.
  bindDirectory(storage: RunnerStorageLock): void {
    this.storage = storage;
    this.data = storage.data; this.directory = join(this.data, 'runner'); this.outcomes = join(this.directory, 'outcomes');
  }
  async init(): Promise<void> {
    if (this.storage) {
      for (const name of ['runner', 'runner/outcomes', 'logs'] as const) await (await this.storage.directory(name)).assertCurrent();
      return;
    }
    await ensurePrivateDirectory(this.directory); await ensurePrivateDirectory(this.outcomes);
    await ensurePrivateDirectory(join(this.data, 'logs'));
  }
  async active(): Promise<ActiveRun[]> {
    try {
      const rows: unknown = JSON.parse(this.storage ? await readBound(await this.storage.directory('runner'), 'active.json') :
        await readPrivateFile(join(this.directory, 'active.json')));
      if (!validActive(rows)) return fail();
      return rows.map(migrateActive);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; if (error instanceof HelperError) throw error; return fail(); }
  }
  async writeActive(rows: ActiveRun[]): Promise<void> {
    // Project fields explicitly: no claim response, content, or credential can reach this file.
    const projectGroups = (groups: ProcessGroup[]) => groups.map(({pgid, startedAt, spawnedBy, sid, members, sessionLeader, cleanupPending}) => ({pgid, startedAt,
      ...(spawnedBy === undefined ? {} : {spawnedBy}), ...(sid === undefined ? {} : {sid}),
      ...(cleanupPending === undefined ? {} : {cleanupPending}),
      ...(members === undefined ? {} : {members: members.map(({pid, startedAt}) => ({pid, startedAt}))}),
      ...(sessionLeader === undefined ? {} : {sessionLeader: {pid: sessionLeader.pid, startedAt: sessionLeader.startedAt}})}));
    const projected = rows.map(({runId, agentId, aiToolId, pid, startedAt, claimedAt, legacyProcessIdentity, legacyProcessGroups, runDir, phase, fence, pgid, processGroups}) => ({runId, agentId, aiToolId, pid, startedAt, runDir, phase,
      ...(claimedAt === undefined ? {} : {claimedAt}), ...(legacyProcessIdentity === undefined ? {} : {legacyProcessIdentity}),
      ...(fence === undefined ? {} : {fence}), ...(pgid === undefined ? {} : {pgid}),
      ...(processGroups === undefined ? {} : {processGroups: projectGroups(processGroups)}),
      ...(legacyProcessGroups === undefined ? {} : {legacyProcessGroups: projectGroups(legacyProcessGroups)})}));
    if (!validActive(projected)) fail();
    const text = JSON.stringify(projected) + '\n';
    if (Buffer.byteLength(text) > 1024 * 1024) fail();
    if (this.storage) await writeBound(await this.storage.directory('runner'), 'active.json', text);
    else await atomicWrite(join(this.directory, 'active.json'), text);
  }
  async queue(pending: PendingOutcome): Promise<void> {
    if (!validPending(pending)) fail();
    const text = JSON.stringify(pending);
    if (/pm_|mdai_skill_/.test(text)) fail();
    if (this.storage) await writeBound(await this.storage.directory('runner/outcomes'), pending.runId + '.json', text + '\n');
    else await atomicWrite(join(this.outcomes, pending.runId + '.json'), text + '\n');
  }
  async pending(): Promise<PendingOutcome[]> {
    const rows: PendingOutcome[] = [];
    const directory = this.storage ? await this.storage.directory('runner/outcomes') : undefined;
    if (directory) await directory.assertCurrent();
    for (const name of (await readdir(directory?.path ?? this.outcomes)).sort()) {
      if (!name.endsWith('.json') || !id(name.slice(0, -5))) continue;
      let row: PendingOutcome;
      try { row = JSON.parse(directory ? await readBound(directory, name) : await readPrivateFile(join(this.outcomes, name))); } catch { return fail(); }
      if (!validPending(row) || row.runId + '.json' !== name) fail();
      rows.push(row);
    }
    if (directory) await directory.assertCurrent();
    return rows;
  }
  async drop(runId: string): Promise<void> {
    if (!id(runId)) fail();
    if (this.storage) {
      const directory = await this.storage.directory('runner/outcomes'), path = boundPath(directory, runId + '.json');
      try {await readBound(directory, runId + '.json');}
      catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
      await unlink(path).catch(error => {if (error.code !== 'ENOENT') throw error;});
      await directory.sync(); await directory.assertCurrent();
      return;
    }
    const path = join(this.outcomes, runId + '.json'); await assertNoSymlinks(path);
    await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  async log(runId: string, phase: string, code: string | null, duration: number): Promise<void> {
    if (!id(runId) || !/^[a-z_]{1,30}$/.test(phase) || !Number.isFinite(duration) || (code !== null && !/^[A-Za-z0-9_]{1,60}$/.test(code))) fail();
    const content = JSON.stringify({runId, phase, code, duration: Math.max(0, Math.round(duration))}) + '\n';
    if (this.storage) {
      const directory = await this.storage.directory('logs'), path = boundPath(directory, 'runner.log');
      await directory.assertCurrent();
      const file = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK | CLOSE_ON_EXEC, 0o600);
      try {await privateBoundFile(file, path); await file.writeFile(content); await directory.assertCurrent();}
      finally {await file.close();}
      return;
    }
    const path = join(this.data, 'logs', 'runner.log'); await assertNoSymlinks(path);
    await appendFile(path, content, {mode: 0o600});
  }
}
