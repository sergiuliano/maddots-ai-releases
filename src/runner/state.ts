import { appendFile, readdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { runnerOutcomeSchema, type RunnerOutcomeBody } from '../shared/runner-protocol.js';
import { HelperError } from '../config.js';
import { assertNoSymlinks, atomicWrite, ensurePrivateDirectory, readPrivateFile } from '../paths.js';
import type { ProcessGroup } from './process.js';

export type ActiveRun = {
  runId: string; agentId: string; aiToolId: string; pid: number; startedAt: string;
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
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).filter(key => !['fence', 'pgid', 'processGroups'].includes(key)).sort().join(',') !== fields ||
      row.fence !== undefined && (typeof row.fence !== 'string' || !/^[a-f0-9]{32}$/u.test(row.fence)) ||
      row.pgid !== undefined && (!Number.isSafeInteger(row.pgid) || row.pgid <= 1) ||
      row.processGroups !== undefined && (!Array.isArray(row.processGroups) || row.processGroups.length > 4096 ||
        row.processGroups.some((group: ProcessGroup) => !group || typeof group !== 'object' || Array.isArray(group) ||
          Object.keys(group).some(key => !['pgid', 'startedAt', 'spawnedBy', 'sid', 'members', 'sessionLeader'].includes(key)) ||
          !Number.isSafeInteger(group.pgid) || group.pgid <= 1 ||
          typeof group.startedAt !== 'string' || group.startedAt.length > 100 || /[^\x20-\x7e]/u.test(group.startedAt) ||
          group.spawnedBy !== undefined && (!Number.isSafeInteger(group.spawnedBy) || group.spawnedBy < 0) ||
          group.sid !== undefined && (typeof group.sid !== 'string' || !group.sid || group.sid.length > 100 || /[^\x21-\x7e]/u.test(group.sid)) ||
          group.members !== undefined && (!Array.isArray(group.members) || group.members.length > 4096 || !group.members.every(processIdentity)) ||
          group.sessionLeader !== undefined && !processIdentity(group.sessionLeader))) ||
      !id(row.runId) || !id(row.agentId) || !id(row.aiToolId) || !Number.isSafeInteger(row.pid) || row.pid < 0 || row.pid === 1 ||
      typeof row.startedAt !== 'string' || !row.startedAt || row.startedAt.length > 100 || [...row.startedAt].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
      typeof row.runDir !== 'string' || !isAbsolute(row.runDir) || resolve(row.runDir) !== row.runDir ||
      !['preparing', 'running', 'posting'].includes(row.phase) || /pm_run_|mdai_skill_/.test(JSON.stringify(row))) return false;
    const cwd = dirname(dirname(dirname(row.runDir)));
    return row.runDir === join(cwd, '.maddots', 'runs', row.runId);
  });
}
function validPending(row: unknown): row is PendingOutcome {
  if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).sort().join(',') !== 'aiToolId,body,queuedAt,runId') return false;
  const value = row as PendingOutcome;
  return id(value.runId) && id(value.aiToolId) && Number.isSafeInteger(value.queuedAt) && value.queuedAt >= 0 &&
    matches(value.body, runnerOutcomeSchema) && !/pm_run_|mdai_skill_/.test(JSON.stringify(value));
}

export class RunnerState {
  readonly directory: string;
  readonly outcomes: string;
  constructor(readonly data: string) { this.directory = join(data, 'runner'); this.outcomes = join(this.directory, 'outcomes'); }
  async init(): Promise<void> {
    await ensurePrivateDirectory(this.directory); await ensurePrivateDirectory(this.outcomes);
    await ensurePrivateDirectory(join(this.data, 'logs'));
  }
  async active(): Promise<ActiveRun[]> {
    try {
      const rows: unknown = JSON.parse(await readPrivateFile(join(this.directory, 'active.json')));
      if (!validActive(rows)) return fail();
      return rows;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; if (error instanceof HelperError) throw error; return fail(); }
  }
  async writeActive(rows: ActiveRun[]): Promise<void> {
    // Project fields explicitly: no claim response, content, or credential can reach this file.
    const projected = rows.map(({runId, agentId, aiToolId, pid, startedAt, runDir, phase, fence, pgid, processGroups}) => ({runId, agentId, aiToolId, pid, startedAt, runDir, phase,
      ...(fence === undefined ? {} : {fence}), ...(pgid === undefined ? {} : {pgid}),
      ...(processGroups === undefined ? {} : {processGroups: processGroups.map(({pgid, startedAt, spawnedBy, sid, members, sessionLeader}) => ({pgid, startedAt,
        ...(spawnedBy === undefined ? {} : {spawnedBy}), ...(sid === undefined ? {} : {sid}),
        ...(members === undefined ? {} : {members: members.map(({pid, startedAt}) => ({pid, startedAt}))}),
        ...(sessionLeader === undefined ? {} : {sessionLeader: {pid: sessionLeader.pid, startedAt: sessionLeader.startedAt}})}))})}));
    if (!validActive(projected)) fail();
    await atomicWrite(join(this.directory, 'active.json'), JSON.stringify(projected) + '\n');
  }
  async queue(pending: PendingOutcome): Promise<void> {
    if (!validPending(pending)) fail();
    const text = JSON.stringify(pending);
    if (/pm_|mdai_skill_/.test(text)) fail();
    await atomicWrite(join(this.outcomes, pending.runId + '.json'), text + '\n');
  }
  async pending(): Promise<PendingOutcome[]> {
    const rows: PendingOutcome[] = [];
    for (const name of (await readdir(this.outcomes)).sort()) {
      if (!name.endsWith('.json') || !id(name.slice(0, -5))) continue;
      let row: PendingOutcome;
      try { row = JSON.parse(await readPrivateFile(join(this.outcomes, name))); } catch { return fail(); }
      if (!validPending(row) || row.runId + '.json' !== name) fail();
      rows.push(row);
    }
    return rows;
  }
  async drop(runId: string): Promise<void> {
    if (!id(runId)) fail();
    const path = join(this.outcomes, runId + '.json'); await assertNoSymlinks(path);
    await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  async log(runId: string, phase: string, code: string | null, duration: number): Promise<void> {
    if (!id(runId) || !/^[a-z_]{1,30}$/.test(phase) || !Number.isFinite(duration) || (code !== null && !/^[A-Za-z0-9_]{1,60}$/.test(code))) fail();
    const path = join(this.data, 'logs', 'runner.log'); await assertNoSymlinks(path);
    await appendFile(path, JSON.stringify({runId, phase, code, duration: Math.max(0, Math.round(duration))}) + '\n', {mode: 0o600});
  }
}
