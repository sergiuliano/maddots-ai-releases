import { realpath, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import type { ToolMatrix } from '../shared/tool-matrix.js';
import { RUN_TOKEN_ERROR_CODES, type RunnerAccess, type RunnerOutcomeBody } from '../shared/runner-protocol.js';
import { clock, HelperError, type Timing } from '../config.js';
import { VERSION } from '../release-identity.js';
import type { Adapter } from './adapter.js';
import { AdapterRegistry } from './adapters/index.js';
import { buildCardPrompt, safeUploadName, type RunCardRead } from './card-prompt.js';
import { MadDotsApiError, type MaddotsApi } from './maddots-api.js';
import { enforceAdapter, startTool, recoverProcess, processStartIdentity, cleanupRunHomes, timeoutSeconds, computeRunDeadline, ProcessCleanupError, type ProcessInspector, type RunningTool } from './process.js';
import type { RunnerAgent, RunnerClaim, RunnerProtocolClient, RunnerSkill } from './protocol-client.js';
import { reserveRunFolder, recoverStagedFiles, releaseLeftoverLock, runFolderAvailable, type RunFolder } from './run-folder.js';
import { RunnerState, outcomeMetadataValid, type ActiveRun } from './state.js';

export type LocalAgent = { agentId: string; aiToolId: string; cwd: string; access: RunnerAccess };
export type RunnerConnection = {
  aiToolId: string; deviceKeyId: string; tool: string; toolVersion: string | null; bin: string; realpath: string;
  runsOn: boolean; protocol: Pick<RunnerProtocolClient, 'heartbeat' | 'claim' | 'outcome'>;
};
type Posted = RunnerOutcomeBody['posted'];
export type RunnerOptions = {
  data: string; connections: () => Promise<RunnerConnection[]>; localAgents: () => Promise<LocalAgent[]>;
  registry: AdapterRegistry; matrix?: ToolMatrix; now?: () => number; sleep?: Timing['sleep']; processes?: ProcessInspector;
  verifiedBuild: (digest: string, skill: RunnerSkill, connection: RunnerConnection, agentId: string) => Promise<boolean>;
  allowedBuild: (skill: RunnerSkill, connection: RunnerConnection, agentId: string) => Promise<boolean>;
  skillDescription?: (skill: RunnerSkill, connection: RunnerConnection, agentId: string) => Promise<string>;
  stageSkills: (context: {claim: RunnerClaim; folder: RunFolder; skillsDir: string; connection: RunnerConnection; signal: AbortSignal}) => Promise<void>;
  // TLS-22 and TLS-23 supply these hooks. Content is handed directly to delivery, never to the protocol client.
  startCheck?: (context: {api: MaddotsApi; claim: RunnerClaim; stop: (code: string) => Promise<void>}) => Promise<() => void>;
  deliver: (context: {api: MaddotsApi; claim: RunnerClaim; folder: RunFolder; text: string; signal: AbortSignal}) => Promise<{posted: Posted; outcome?: RunnerOutcomeBody['outcome']; code?: string | null}>;
  removeDeviceKey: (aiToolId: string, deviceKeyId: string | null) => Promise<void>;
  paired?: () => Promise<boolean>;
};
const runners = new Set<RunnerCore>();
const emptyPosted = (): Posted => ({comments: 0, attachments: 0, filesSkipped: 0, moved: false, moveSkipped: null});
// TLS-08's scope guard precedes the revoked-key check when the last runs grant is removed.
const lostKey = new Set(['DEVICE_KEY_REVOKED', 'RUNS_NOT_ENABLED', 'SCOPE_MISSING']);
const codeOf = (error: unknown) => error instanceof HelperError ? error.code :
  error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'tool_failed';
const safeCode = (error: unknown) => { const code = codeOf(error); return /^[A-Za-z0-9_]{1,60}$/.test(code) ? code : 'folder_unavailable'; };
// BRIEF-C2 4.9: agent_runs.failure_code is a closed list.
const FAILED_CODES = new Set(['tool_failed', 'tool_not_found', 'tool_identity', 'adapter_refused', 'provider_key_missing', 'run_time_limit',
  'token_expired', 'mcp_started', 'secret_in_output', 'output_empty', 'output_too_large', 'card_read_failed', 'question_missing',
  'skills_not_ready', 'skills_conflict', 'config_conflict', 'folder_unavailable', 'post_failed', 'runner_restarted', 'runner_stopped']);
const STOPPED_CODES = new Set(['check_mismatch', 'heartbeat_stop']);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function isRunCard(value: unknown): value is RunCardRead {
  return isRecord(value) && isRecord(value.card) && typeof value.card.title === 'string' &&
    Array.isArray(value.comments) && value.comments.every(comment => isRecord(comment) && typeof comment.id === 'string' && typeof comment.body === 'string' &&
      typeof comment.createdAt === 'string' && typeof comment.postedByAgentRun === 'boolean' && typeof comment.authorCanEdit === 'boolean') &&
    Array.isArray(value.attachments) && value.attachments.every(attachment => isRecord(attachment) && typeof attachment.id === 'string' &&
      ['upload', 'link', 'google_drive'].includes(attachment.source as string) && typeof attachment.name === 'string');
}
class KeyLost extends Error {}
async function signed<T>(call: Promise<T>): Promise<T> {
  try { return await call; } catch (error) { throw lostKey.has(codeOf(error)) ? new KeyLost() : error; }
}

export function runnerBusy(): boolean { return [...runners].some(runner => runner.busy); }
export async function tickRunners(): Promise<void> { await Promise.allSettled([...runners].map(runner => runner.tick())); }
export async function stopRunners(): Promise<void> { await Promise.allSettled([...runners].map(runner => runner.close())); }
// TokenManager deletes the complete device-key item while holding its existing write lock.
export async function disconnectRunners(): Promise<void> { await Promise.allSettled([...runners].map(runner => runner.disconnect(false))); }

export class RunnerCore {
  private readonly state: RunnerState;
  private readonly active = new Map<string, ActiveRun>();
  private readonly unrecovered = new Map<string, ActiveRun>();
  private readonly recoveryFolders = new Map<string, RunFolder>();
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly tools = new Map<string, RunningTool>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly reasons = new Map<string, string>();
  private readonly lostKeys = new Set<string>();
  private readonly runKeys = new Map<string, string>();
  private readonly folders = new Set<string>();
  private runHomesUnsafe = false;
  private lastError: string | null = null;
  private initialized = false;
  private initializing?: Promise<void>;
  private cycling?: Promise<void>;
  private writes = Promise.resolve();
  private closed = false;
  private nextCycle = 0;
  constructor(private readonly options: RunnerOptions) { this.state = new RunnerState(options.data); runners.add(this); }
  // Posting rows and outcomes survive a restart; only live work holds the updater.
  get busy(): boolean { return this.jobs.size > 0 || [...this.unrecovered.values()].some(row => !!row.fence) || [...this.active.values()].some(row => row.phase !== 'posting'); }
  private lost(connection: RunnerConnection): boolean { return this.lostKeys.has(connection.deviceKeyId); }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private save(): Promise<void> {
    this.writes = this.writes.catch(() => {}).then(() => this.state.writeActive([...this.active.values(), ...this.unrecovered.values()])); return this.writes;
  }
  private async recoverRow(row: ActiveRun): Promise<void> {
    const cwd = dirname(dirname(dirname(row.runDir)));
    if (resolve(row.runDir) !== join(cwd, '.maddots', 'runs', row.runId)) throw new HelperError('RUNNER_STATE_INVALID', 'The saved run folder is invalid.');
    const onGroups = async (processGroups: ActiveRun['processGroups']) => { row.processGroups = processGroups; await this.save(); };
    // Validate paths before inspecting or signalling any saved process.
    if (row.pid > 0) {
      const identity = await (this.options.processes?.identity ?? processStartIdentity)(row.pid);
      if (identity === null) {
        let alive = true;
        try { process.kill(row.pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
        if (alive) throw new HelperError('RUNNER_RECOVERY_UNAVAILABLE', 'Process identity could not be verified safely. Retry recovery when process inspection is available.');
      } else if (!row.fence && !row.pgid && !row.processGroups?.length && identity === row.startedAt && !await recoverProcess(row.pid, row.startedAt, this.options.processes, undefined, [], onGroups)) {
        throw new HelperError('RUNNER_RECOVERY_UNAVAILABLE', 'Process identity changed during recovery. Retry recovery safely.');
      }
    }
    // The direct child may already be gone, reused, or not yet saved after spawn.
    if (row.fence || row.pgid || row.processGroups?.length) await recoverProcess(row.pid, row.startedAt, this.options.processes, row.fence,
      [...(row.pgid || row.pid ? [{pgid: row.pgid ?? row.pid, startedAt: row.startedAt}] : []), ...row.processGroups ?? []], onGroups);
    // Once verified gone, never inspect a possibly reused pid during a later folder retry.
    row.pid = 0; delete row.fence; delete row.pgid; delete row.processGroups;
    await recoverStagedFiles({cwd, dataDir: this.options.data, runId: row.runId});
    const held = this.recoveryFolders.get(row.runId);
    if (held) { await held.release(); this.recoveryFolders.delete(row.runId); }
    else await releaseLeftoverLock(cwd, row.runId);
  }
  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      await this.state.init();
      this.active.clear(); this.unrecovered.clear(); this.folders.clear();
      const restored: ActiveRun[] = [];
      const rows = await this.state.active();
      // Recovery callbacks persist the entire ledger, including rows whose
      // cleanup has not started and rows awaiting pending-outcome validation.
      for (const row of rows) this.unrecovered.set(row.runId, row);
      for (const row of rows) {
        try { await this.recoverRow(row); restored.push({...row, pid: 0, phase: 'posting'}); }
        catch (error) {
          // One absent or damaged folder never blocks other runs, sync or credential removal.
          this.unrecovered.set(row.runId, row);
          this.folders.add(resolve(dirname(dirname(dirname(row.runDir)))));
          await this.state.log(row.runId, 'recovery', safeCode(error), 0).catch(() => {});
        }
      }
      // Homes are cleaned only after every recorded process was safely verified gone.
      if ([...this.unrecovered.values()].some(row => row.pid > 0 || row.fence)) this.runHomesUnsafe = true;
      else {
        try { await cleanupRunHomes(this.options.data); }
        catch { this.runHomesUnsafe = true; }
      }
      // Recover processes before validating pending files. A row without an outcome already finished.
      const pendingRuns = new Set((await this.state.pending()).map(pending => pending.runId));
      for (const row of restored) {
        this.unrecovered.delete(row.runId);
        if (pendingRuns.has(row.runId)) this.active.set(row.runId, row);
      }
      await this.save(); this.initialized = true;
    })();
    try { await this.initializing; } finally { this.initializing = undefined; }
  }
  async tick(): Promise<void> {
    if (this.closed) return;
    if (this.cycling) return this.cycling;
    this.cycling = this.cycle().catch(error => { this.lastError = safeCode(error); });
    try { await this.cycling; } finally { this.cycling = undefined; }
  }
  private async cycle(): Promise<void> {
    await this.init();
    if (this.options.paired && !await this.options.paired()) { await this.disconnect(); return; }
    if (this.now() < this.nextCycle) return;
    this.nextCycle = this.now() + 15_000;
    for (const row of [...this.unrecovered.values()]) {
      try {
        await this.recoverRow(row);
        this.unrecovered.delete(row.runId);
        this.folders.delete(resolve(dirname(dirname(dirname(row.runDir)))));
        if ((await this.state.pending()).some(pending => pending.runId === row.runId)) this.active.set(row.runId, {...row, pid: 0, phase: 'posting'});
        await this.save();
      } catch { await this.save().catch(() => {}); /* Persist verified process cleanup even when folder recovery must retry. */ }
    }
    const connections = await this.options.connections();
    await this.expire();
    const locals = await this.options.localAgents();
    for (const connection of connections) {
      if (!connection.runsOn || this.lost(connection)) continue;
      try {
        await this.flush(connection);
        const running = new Map([...this.active.values()].filter(row => row.aiToolId === connection.aiToolId).map(({runId, phase}) => [runId, {runId, phase}]));
        for (const pending of await this.state.pending()) if (pending.aiToolId === connection.aiToolId && !running.has(pending.runId)) running.set(pending.runId, {runId: pending.runId, phase: 'posting'});
        const connectionLocals = locals.filter(local => local.aiToolId === connection.aiToolId);
        const heartbeat = await signed(connection.protocol.heartbeat({helperVersion: VERSION, toolVersion: connection.toolVersion,
          agents: connectionLocals.slice(0, 200).map(local => ({agentId: local.agentId, access: local.access})),
          running: [...running.values()].slice(0, 20)}));
        for (const stop of heartbeat.stop) await this.stop(stop.runId, 'heartbeat_stop');
        for (const offered of heartbeat.claimable) {
          if (this.closed || this.active.size + this.unrecovered.size >= 20 || this.lost(connection)) break;
          const agent = heartbeat.agents.find(agent => agent.agentId === offered.agentId);
          const local = connectionLocals.find(local => local.agentId === offered.agentId);
          const key = local ? await realpath(local.cwd).catch(() => null) : null;
          const adapter = this.options.registry.get(connection.tool);
          if (!agent || !local || !key || !adapter || agent.status !== 'active' || this.active.has(offered.runId) ||
            [...this.active.values(), ...this.unrecovered.values()].some(row => row.agentId === local.agentId) || this.folders.has(key) ||
            !outcomeMetadataValid(agent.model, agent.provider) || this.runHomesUnsafe && adapter.info.runHome ||
            !await runFolderAvailable(local.cwd) || !await this.buildsReady(agent.skills, connection, agent.agentId)) continue;
          const accepted = await enforceAdapter({adapter, bin: connection.bin, recordedRealpath: connection.realpath,
            model: agent.model, provider: agent.provider, effort: agent.effort, access: local.access, matrix: this.options.matrix});
          if (!accepted.ok) continue;
          // Reserve the O_EXCL folder lock before issuing a claim, including across helper processes.
          let reservation: Awaited<ReturnType<typeof reserveRunFolder>>;
          try { reservation = await reserveRunFolder({cwd: local.cwd, runId: offered.runId, dataDir: this.options.data}); } catch { continue; }
          this.folders.add(key);
          let response: Awaited<ReturnType<RunnerProtocolClient['claim']>>;
          try { response = await signed(connection.protocol.claim({runId: offered.runId, access: local.access, toolVersion: connection.toolVersion})); }
          catch (error) {
            try { await reservation.release(); } finally { this.folders.delete(key); }
            if (error instanceof KeyLost) { await this.loseKey(connection.aiToolId, [connection.deviceKeyId]); break; }
            continue;
          }
          const {claim, api} = response;
          if (this.closed || this.lost(connection) || claim.runId !== offered.runId || claim.agentId !== agent.agentId || claim.kind !== offered.kind || !outcomeMetadataValid(claim.model, claim.provider)) {
            api.dispose(); try { await reservation.release(); } finally { this.folders.delete(key); } continue;
          }
          let folder: RunFolder;
          try { folder = await reservation.create(); }
          catch {
            api.dispose(); try { await reservation.release(); } finally { this.folders.delete(key); }
            await this.state.queue({runId: claim.runId, aiToolId: connection.aiToolId, queuedAt: this.now(),
              body: this.outcome(claim, connection, local.access, this.now(), 'failed', 'folder_unavailable')});
            continue;
          }
          if (this.closed || this.lost(connection)) {
            api.dispose(); try { await folder.release(); } finally { this.folders.delete(key); } continue;
          }
          this.runKeys.set(claim.runId, connection.deviceKeyId);
          const controller = new AbortController(); this.controllers.set(claim.runId, controller);
          this.active.set(claim.runId, {runId: claim.runId, agentId: claim.agentId, aiToolId: connection.aiToolId,
            pid: 0, startedAt: new Date(this.now()).toISOString(), runDir: folder.runDir, phase: 'preparing', fence: randomBytes(16).toString('hex')});
          const claimedAt = this.now();
          try {
            await this.state.queue({runId: claim.runId, aiToolId: connection.aiToolId, queuedAt: claimedAt,
              body: this.outcome(claim, connection, local.access, claimedAt, 'failed', 'runner_restarted')});
            await this.save();
          } catch {
            api.dispose(); this.controllers.delete(claim.runId); this.active.delete(claim.runId); this.runKeys.delete(claim.runId);
            try { await folder.release(); } finally { this.folders.delete(key); }
            await this.save().catch(() => {});
            continue;
          }
          if (this.closed || this.lost(connection)) await this.stop(claim.runId);
          const job = this.execute(connection, local, agent, adapter, claim, api, folder, claimedAt, controller)
            .catch(() => {}) // Content and errors from tool code are never logged by the service.
            .finally(() => { this.jobs.delete(claim.runId); this.controllers.delete(claim.runId); this.reasons.delete(claim.runId); this.runKeys.delete(claim.runId); });
          this.jobs.set(claim.runId, job);
        }
      } catch (error) { if (error instanceof KeyLost) await this.loseKey(connection.aiToolId, [connection.deviceKeyId]); }
    }
  }
  private async buildsReady(skills: RunnerSkill[], connection: RunnerConnection, agentId: string): Promise<boolean> {
    for (const skill of skills) if (!skill.digest || !await this.options.verifiedBuild(skill.digest, skill, connection, agentId) || skill.hasCode && !await this.options.allowedBuild(skill, connection, agentId)) return false;
    return true;
  }
  private async read<T>(action: () => Promise<T>, expiresAt: string, signal: AbortSignal): Promise<T> {
    let attempt = 0;
    const expiry = Date.parse(expiresAt);
    while (!signal.aborted) {
      if (this.now() >= expiry) throw new HelperError('maddots_unreachable', 'MadDots could not be reached before the run expired.');
      try {
        const result = await action();
        if (signal.aborted) throw new HelperError('runner_stopped', 'The run stopped.');
        return result;
      }
      catch (error) {
        if (signal.aborted) throw new HelperError('runner_stopped', 'The run stopped.');
        if (!(error instanceof MadDotsApiError) || error.classification !== 'retry') throw error;
        const delay = Math.min(attempt < 5 ? 1000 * 2 ** attempt : 30_000, Math.max(0, expiry - this.now()));
        attempt++; await (this.options.sleep ?? clock.sleep)(delay, signal);
      }
    }
    throw new HelperError('runner_stopped', 'The run stopped.');
  }
  private outcome(claim: RunnerClaim, connection: RunnerConnection, access: RunnerAccess, started: number,
    outcome: RunnerOutcomeBody['outcome'], code: string | null, posted = emptyPosted()): RunnerOutcomeBody {
    return {outcome, code, access, toolVersion: connection.toolVersion, model: claim.model, provider: claim.provider,
      skills: claim.skills.map(({skillId, version, settingsRevision, digest}) => ({skillId, version, settingsRevision, digest})),
      posted, startedAt: new Date(started).toISOString(), finishedAt: new Date(this.now()).toISOString()};
  }
  private async execute(connection: RunnerConnection, local: LocalAgent, agent: RunnerAgent, adapter: Adapter,
    claim: RunnerClaim, api: MaddotsApi, folder: RunFolder, claimedAt: number, controller: AbortController): Promise<void> {
    let stopCheck: (() => void) | undefined;
    let cleanupIncomplete = false;
    let outcome: RunnerOutcomeBody;
    let posted = emptyPosted();
    const checkStopped = () => { if (controller.signal.aborted) throw new HelperError(this.reasons.get(claim.runId) ?? 'runner_stopped', 'The run stopped.'); };
    try {
      stopCheck = await this.options.startCheck?.({api, claim, stop: code => this.stop(claim.runId, code)});
      checkStopped();
      let card: RunCardRead;
      try {
        const read = await this.read(() => api.readCard<unknown>(claim.cardId, controller.signal), claim.expiresAt, controller.signal);
        if (!isRunCard(read)) throw new HelperError('card_read_failed', 'The card could not be read.');
        card = read;
      } catch (error) {
        if (controller.signal.aborted || error instanceof MadDotsApiError && error.classification === 'final' || codeOf(error) === 'maddots_unreachable') throw error;
        throw new HelperError('card_read_failed', 'The card could not be read.');
      }
      checkStopped();
      const uploads: {id: string; path: string}[] = [];
      let total = 0;
      for (const attachment of card.attachments) {
        checkStopped(); if (attachment.source !== 'upload' || (attachment.byteSize ?? 0) > 10 * 1024 * 1024 || total + (attachment.byteSize ?? 0) > 50 * 1024 * 1024) continue;
        try {
          const bytes = await this.read(() => api.downloadAttachment(attachment.id, controller.signal), claim.expiresAt, controller.signal);
          checkStopped();
          if (total + bytes.byteLength > 50 * 1024 * 1024) continue;
          const path = join(folder.materialDir, safeUploadName(attachment.id, attachment.name));
          await writeFile(path, bytes, {flag: 'wx', mode: 0o600}); total += bytes.byteLength; uploads.push({id: attachment.id, path});
        } catch (error) { if (controller.signal.aborted || error instanceof MadDotsApiError && error.classification === 'final' || codeOf(error) === 'maddots_unreachable') throw error; }
      }
      const prompt = buildCardPrompt({runId: claim.runId, kind: claim.kind, agentName: agent.name, commentId: claim.commentId,
        runDir: folder.runDir, card, skills: await Promise.all(claim.skills.map(async skill =>
          ({name: skill.name, description: await this.options.skillDescription?.(skill, connection, claim.agentId) ?? ''}))), uploads});
      await writeFile(folder.promptFile, prompt, {flag: 'wx', mode: 0o600});
      if (!await this.buildsReady(claim.skills, connection, claim.agentId)) throw new HelperError('skills_not_ready', 'A verified skill build is no longer available.');
      checkStopped();
      const skillsDir = adapter.info.skillsDir.replaceAll('{cwd}', folder.cwd).replaceAll('{runDir}', folder.runDir);
      await this.options.stageSkills({claim, folder, skillsDir, connection, signal: controller.signal});
      checkStopped();
      const supported = adapter.supports({model: claim.model, provider: claim.provider, effort: claim.effort, access: local.access});
      if (!supported.ok) throw new HelperError('adapter_refused', 'The claimed settings are unsupported.');
      const deadline = computeRunDeadline(claimedAt, Date.parse(claim.expiresAt), claim.maxRunMinutes);
      const tool = await startTool({adapter, spec: {bin: connection.bin, cwd: folder.cwd, runDir: folder.runDir, promptFile: folder.promptFile,
        model: claim.model, provider: claim.provider, effort: claim.effort, access: local.access, skillsDir, maxTurns: 50,
        timeoutSeconds: timeoutSeconds(deadline, this.now()), runHome: null}, recordedRealpath: connection.realpath, claimedAt,
        expiresAt: Date.parse(claim.expiresAt), maxRunMinutes: claim.maxRunMinutes, matrix: this.options.matrix, processes: this.options.processes, now: this.options.now,
        fence: this.active.get(claim.runId)!.fence,
        stageProjectFile: file => folder.stageProjectFile({...file, kind: 'config'}),
        onSpawn: async (pid, startedAt, pgid) => {
          const row = this.active.get(claim.runId)!;
          const groups = row.processGroups ?? [];
          this.active.set(claim.runId, {...row, pid, startedAt: startedAt || row.startedAt, pgid,
            processGroups: [...groups.filter(group => group.pgid !== pgid), {...groups.find(group => group.pgid === pgid), pgid, startedAt}], phase: 'running'}); await this.save();
        },
        onGroups: async processGroups => {
          const row = this.active.get(claim.runId);
          if (row) { this.active.set(claim.runId, {...row, processGroups}); await this.save(); }
        }});
      this.tools.set(claim.runId, tool);
      if (controller.signal.aborted) await tool.stop(this.reasons.get(claim.runId) ?? 'runner_stopped');
      const result = await tool.finished;
      this.tools.delete(claim.runId);
      // Completion verified the process tree. Never retain group authority
      // while a posting outcome waits, because its numeric ID can be reused.
      const completed = this.active.get(claim.runId);
      if (completed) { completed.pid = 0; delete completed.pgid; delete completed.processGroups; await this.save(); }
      if (!result.ok) throw new HelperError(result.failureCode ?? 'tool_failed', 'The tool could not complete the run.');
      checkStopped(); this.active.get(claim.runId)!.phase = 'posting'; await this.save();
      const delivery = await this.options.deliver({api, claim, folder, text: result.text, signal: controller.signal});
      posted = delivery.posted;
      checkStopped();
      outcome = this.outcome(claim, connection, local.access, claimedAt, delivery.outcome ?? 'done', delivery.code ?? null, delivery.posted);
    } catch (error) {
      cleanupIncomplete = error instanceof ProcessCleanupError;
      const reason = this.reasons.get(claim.runId) ?? codeOf(error);
      const final = error instanceof MadDotsApiError && error.classification === 'final';
      const contract = Object.hasOwn(RUN_TOKEN_ERROR_CODES, reason);
      const code = reason === 'TOKEN_EXPIRED' ? 'token_expired'
        : final ? (contract ? reason : `HTTP_${(error as MadDotsApiError).status}`)
        : FAILED_CODES.has(reason) || STOPPED_CODES.has(reason) || reason === 'maddots_unreachable' ||
          this.reasons.has(claim.runId) && (contract || /^HTTP_\d{3}$/.test(reason)) ? reason : 'tool_failed';
      outcome = this.outcome(claim, connection, local.access, claimedAt,
        code === 'maddots_unreachable' ? 'not_delivered' : (final || controller.signal.aborted) && !['token_expired', 'runner_stopped'].includes(code) ? 'stopped' : 'failed', code, posted);
    } finally {
      this.tools.delete(claim.runId);
      try { stopCheck?.(); } catch { /* Cleanup hooks cannot retain the token or folder lock. */ }
      api.dispose();
      if (cleanupIncomplete) {
        const row = this.active.get(claim.runId)!;
        this.recoveryFolders.set(claim.runId, folder);
        this.unrecovered.set(claim.runId, row); this.active.delete(claim.runId);
        this.runHomesUnsafe = true;
        await this.state.queue({runId: claim.runId, aiToolId: connection.aiToolId, queuedAt: this.now(), body: outcome!});
        await this.save();
      } else {
        try { await folder.backupStaged(this.options.data); }
        catch { if (outcome!.outcome === 'done') outcome = this.outcome(claim, connection, local.access, claimedAt, 'failed', 'folder_unavailable', outcome!.posted); }
        finally {
          try { await folder.release(); }
          catch { if (outcome!.outcome === 'done') outcome = this.outcome(claim, connection, local.access, claimedAt, 'failed', 'folder_unavailable', outcome!.posted); }
          finally { this.folders.delete(folder.cwd); }
        }
      }
    }
    if (cleanupIncomplete) return;
    if (!this.lost(connection)) {
      await this.state.queue({runId: claim.runId, aiToolId: connection.aiToolId, queuedAt: this.now(), body: outcome});
      const row = this.active.get(claim.runId); if (row) this.active.set(claim.runId, {...row, pid: 0, phase: 'posting'});
      await this.save(); await this.state.log(claim.runId, 'posting', outcome.code, this.now() - claimedAt);
    }
  }
  private async expire(): Promise<void> {
    const pending = await this.state.pending(), kept = new Set<string>();
    let changed = false;
    for (const row of pending) {
      if (this.jobs.has(row.runId) || this.unrecovered.get(row.runId)?.fence || this.now() - row.queuedAt < 7 * 86400_000) { kept.add(row.runId); continue; }
      if (this.active.delete(row.runId)) await this.save();
      await this.state.drop(row.runId);
    }
    for (const row of [...this.active.values()]) if (row.phase === 'posting' && !this.jobs.has(row.runId) && !kept.has(row.runId)) {
      this.active.delete(row.runId); changed = true;
    }
    for (const row of [...this.unrecovered.values()]) if (!row.fence && this.now() - Date.parse(row.startedAt) > 7 * 86400_000) {
      await this.state.log(row.runId, 'recovery', 'folder_unavailable', 0).catch(() => {});
      this.unrecovered.delete(row.runId); this.folders.delete(resolve(dirname(dirname(dirname(row.runDir))))); changed = true;
    }
    if (changed) await this.save();
  }
  private async flush(connection: RunnerConnection): Promise<void> {
    for (const pending of await this.state.pending()) {
      if (pending.aiToolId !== connection.aiToolId || this.jobs.has(pending.runId) || this.unrecovered.get(pending.runId)?.fence) continue;
      if (this.now() - pending.queuedAt < 7 * 86400_000) {
        try { await signed(connection.protocol.outcome(pending.runId, pending.body)); }
        catch (error) { if (error instanceof KeyLost) throw error; if (codeOf(error) !== 'RUN_FINISHED') continue; }
      }
      // Keep the outcome if persisting the active row's removal fails.
      if (!this.unrecovered.has(pending.runId)) this.active.delete(pending.runId);
      await this.save(); await this.state.drop(pending.runId);
    }
  }
  async stop(runId: string, code = 'runner_stopped'): Promise<void> {
    if (!this.reasons.has(runId)) this.reasons.set(runId, code);
    this.controllers.get(runId)?.abort(); await this.tools.get(runId)?.stop(code);
  }
  private async loseKey(aiToolId: string, deviceKeyIds: string[], removeKey = true): Promise<void> {
    const rows = [...this.active.values()].filter(row => row.aiToolId === aiToolId);
    for (const id of [...deviceKeyIds, ...rows.map(row => this.runKeys.get(row.runId))]) if (id) this.lostKeys.add(id);
    try {
      const jobs = rows.map(row => this.jobs.get(row.runId));
      await Promise.allSettled(rows.map(row => this.stop(row.runId, 'runner_stopped')));
      await Promise.allSettled(jobs);
      for (const row of rows) this.active.delete(row.runId);
      await this.save();
      for (const pending of await this.state.pending()) if (pending.aiToolId === aiToolId) await this.state.drop(pending.runId);
    } finally {
      // Corrupt outcome files or an unavailable disk cannot retain a revoked credential.
      if (removeKey) {
        const ids = [...new Set(deviceKeyIds)];
        await Promise.allSettled((ids.length ? ids : [null]).map(id => this.options.removeDeviceKey(aiToolId, id)));
      }
    }
  }
  async disconnect(removeKey = true): Promise<void> {
    try { await this.init(); } catch { /* Still revoke every known key when saved state is unreadable. */ }
    const keys = new Map<string, string[]>();
    for (const row of [...this.active.values(), ...this.unrecovered.values()]) keys.set(row.aiToolId, []);
    for (const connection of await this.options.connections().catch(() => [])) {
      keys.set(connection.aiToolId, [...keys.get(connection.aiToolId) ?? [], connection.deviceKeyId]);
    }
    for (const [id, ids] of keys) await this.loseKey(id, ids, removeKey).catch(() => {});
  }
  async idle(): Promise<void> { await Promise.all([...this.jobs.values()]); }
  async close(): Promise<void> {
    this.closed = true;
    if (this.cycling) await this.cycling;
    await Promise.allSettled([...this.active.values()].map(row => this.stop(row.runId)));
    await this.idle(); runners.delete(this);
  }
}
