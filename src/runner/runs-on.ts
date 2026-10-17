import {setTimeout as delay} from 'node:timers/promises';
import {join} from 'node:path';
import {isObject} from '../api.js';
import {HelperError} from '../config.js';
import {VERSION} from '../release-identity.js';
import {atomicWrite, ensurePrivateDirectory, readPrivateFile, withWriteLock, type HelperPaths} from '../paths.js';
import type {RunnerTestResultBody} from '../shared/runner-protocol.js';
import type {DeviceKeyStore, RunnerDeviceKey} from './device-key.js';
import type {RunnerProtocolClient} from './protocol-client.js';
import {runTestCode, type RunTestConnection, type RunTestResult} from './test-run.js';

export type RunGrant = {aiToolId: string; expiresAt: string};
export type RunsOnSnapshot = {
  aiToolId: string; state: 'waiting' | 'testing' | 'on' | 'failed'; failureCode: string | null;
  deviceKeyId: string | null; toolVersion: string | null; grantExpiresAt: string | null;
  pendingResult?: RunnerTestResultBody;
};
export type RunsOnOptions = {
  paths: Pick<HelperPaths, 'data'>; keys: Pick<DeviceKeyStore, 'ensure' | 'get' | 'remove' | 'registerExisting'>;
  connection: (aiToolId: string) => Promise<RunTestConnection | undefined>;
  protocol: (key: RunnerDeviceKey) => Pick<RunnerProtocolClient, 'testResult' | 'heartbeat'>;
  test: (connection: RunTestConnection, options: {model?: string; signal: AbortSignal}) => Promise<RunTestResult>;
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const nullable = (value: unknown) => value === null || typeof value === 'string' && value.length <= 200 && /^(?!.*(?:pm_|mdai_skill_))[A-Za-z0-9][A-Za-z0-9._+:/-]*$/.test(value);
function validResult(value: unknown): value is RunnerTestResultBody {
  return isObject(value) && Object.keys(value).sort().join(',') === 'code,ok,toolVersion' && typeof value.ok === 'boolean' &&
    (value.code === null || typeof value.code === 'string' && /^(?!.*(?:pm_|mdai_skill_))[A-Za-z0-9_]{1,60}$/.test(value.code)) && nullable(value.toolVersion) &&
    (value.ok ? value.code === null : value.code !== null);
}
export function parseRunGrants(value: unknown): RunGrant[] {
  if (!Array.isArray(value) || value.length > 200) throw new HelperError('API_RESPONSE_INVALID', 'The run grants response is invalid.');
  const ids = new Set<string>();
  return value.map(grant => {
    if (!isObject(grant) || Object.keys(grant).sort().join(',') !== 'aiToolId,expiresAt' ||
        typeof grant.aiToolId !== 'string' || !uuid.test(grant.aiToolId) || ids.has(grant.aiToolId) ||
        typeof grant.expiresAt !== 'string' || !Number.isFinite(Date.parse(grant.expiresAt))) throw new HelperError('API_RESPONSE_INVALID', 'The run grants response is invalid.');
    ids.add(grant.aiToolId); return {aiToolId: grant.aiToolId, expiresAt: grant.expiresAt};
  });
}

/** Approval is represented only by a current server grant; reads and explicit retests never mint a key. */
export class RunsOnController {
  private rows = new Map<string, RunsOnSnapshot>();
  private loading?: Promise<void>;
  private writes = Promise.resolve();
  private jobs = new Map<string, Promise<void>>();
  private controllers = new Map<string, AbortController>();
  private errors = new Map<string, string>();
  private closed = false;
  private shutdown = new AbortController();
  constructor(private readonly options: RunsOnOptions) {}
  get busy(): boolean {return this.jobs.size > 0;}
  private get file() {return join(this.options.paths.data, 'runner', 'runs.json');}
  async init(): Promise<void> {
    this.loading ??= (async () => {
      await ensurePrivateDirectory(join(this.options.paths.data, 'runner'));
      let value: unknown;
      try {value = JSON.parse(await readPrivateFile(this.file));}
      catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new HelperError('RUNNER_STATE_INVALID', 'The saved run activation state is invalid.');}
      if (!isObject(value) || Object.keys(value).sort().join(',') !== 'format,tools' || value.format !== 1 || !Array.isArray(value.tools) || value.tools.length > 200) throw new HelperError('RUNNER_STATE_INVALID', 'The saved run activation state is invalid.');
      const loaded = new Map<string, RunsOnSnapshot>();
      for (const row of value.tools) {
        if (!isObject(row) || Object.keys(row).some(key => !['aiToolId', 'state', 'failureCode', 'deviceKeyId', 'toolVersion', 'grantExpiresAt', 'pendingResult'].includes(key)) ||
            typeof row.aiToolId !== 'string' || !uuid.test(row.aiToolId) || loaded.has(row.aiToolId) || !['waiting', 'testing', 'on', 'failed'].includes(row.state as string) ||
            !(row.failureCode === null || typeof row.failureCode === 'string' && /^(?!.*(?:pm_|mdai_skill_))[A-Za-z0-9_]{1,60}$/.test(row.failureCode)) ||
            !(row.deviceKeyId === null || typeof row.deviceKeyId === 'string' && uuid.test(row.deviceKeyId)) || !nullable(row.toolVersion) ||
            !(row.grantExpiresAt === null || typeof row.grantExpiresAt === 'string' && Number.isFinite(Date.parse(row.grantExpiresAt))) ||
            row.pendingResult !== undefined && !validResult(row.pendingResult)) throw new HelperError('RUNNER_STATE_INVALID', 'The saved run activation state is invalid.');
        loaded.set(row.aiToolId, row as RunsOnSnapshot);
      }
      this.rows = loaded;
    })();
    return this.loading;
  }
  private async reload(): Promise<void> {this.loading = undefined; this.rows = new Map(); await this.init();}
  async snapshot(): Promise<RunsOnSnapshot[]> {if (!this.jobs.size) await this.reload(); else await this.init(); return [...this.rows.values()].map(row => structuredClone(row));}
  private async save(): Promise<void> {
    this.writes = this.writes.catch(() => {}).then(() => atomicWrite(this.file, JSON.stringify({format: 1, tools: [...this.rows.values()]}) + '\n'));
    await this.writes;
  }
  async syncGrants(value: unknown): Promise<void> {
    const grants = parseRunGrants(value);
    await this.init(); if (this.closed) return;
    const granted = new Set(grants.map(grant => grant.aiToolId));
    for (const grant of grants) {
      if (Date.parse(grant.expiresAt) <= (this.options.now ?? Date.now)()) continue;
      this.schedule(grant.aiToolId, () => this.activate(grant));
    }
    // Registration removes a waiting grant. Resume tests/results with the already registered key after a crash.
    for (const row of this.rows.values()) if (!granted.has(row.aiToolId) && (row.pendingResult || row.state === 'testing' || row.state === 'waiting')) {
      this.schedule(row.aiToolId, () => this.resume(row.aiToolId));
    }
  }
  private async exclusive<T>(work: () => Promise<T>, timing?: {now: () => number; sleep: (ms: number) => Promise<void>}): Promise<T> {
    const directory = join(this.options.paths.data, 'runner');
    await ensurePrivateDirectory(directory);
    // Keep the long-lived activation lease separate from the helper's credential write lock.
    const lockPaths = {data: directory, lock: join(directory, '.activation.lock')} as HelperPaths;
    return withWriteLock(lockPaths, async () => {await this.reload(); return work();}, timing);
  }
  private schedule(id: string, work: () => Promise<void>): void {
    if (this.jobs.has(id) || this.closed) return;
    this.errors.delete(id);
    const job = this.exclusive(async () => {
      if (this.closed) return;
      try {await work();}
      catch (error) {
        this.errors.set(id, runTestCode(error));
        const row = this.rows.get(id);
        if (row) {row.failureCode = row.pendingResult && !row.pendingResult.ok ? row.pendingResult.code : runTestCode(error); await this.save();}
      }
    }).catch(error => {this.errors.set(id, runTestCode(error));}).finally(() => {this.jobs.delete(id); this.controllers.delete(id);});
    this.jobs.set(id, job);
  }
  private async activate(grant: RunGrant): Promise<void> {
    let row = this.rows.get(grant.aiToolId);
    if (row?.grantExpiresAt && row.grantExpiresAt !== grant.expiresAt && Date.parse(grant.expiresAt) <= Date.parse(row.grantExpiresAt)) return;
    if (row?.grantExpiresAt === grant.expiresAt && ['on', 'failed'].includes(row.state) && !row.pendingResult) return;
    if (!row || row.grantExpiresAt !== grant.expiresAt) await this.options.keys.remove(grant.aiToolId, row?.deviceKeyId ?? null);
    if (!row || row.grantExpiresAt !== grant.expiresAt) {
      row = {aiToolId: grant.aiToolId, state: 'waiting', failureCode: null, deviceKeyId: null, toolVersion: null, grantExpiresAt: grant.expiresAt};
      this.rows.set(grant.aiToolId, row); await this.save();
    }
    if (this.closed) return;
    const connection = await this.options.connection(row.aiToolId);
    const refusal = !connection ? 'tool_not_found' : !nullable(connection.toolVersion) ? 'tool_identity' : null;
    // Recheck approval immediately before key creation, after local I/O and discovery.
    if (this.closed || Date.parse(grant.expiresAt) <= (this.options.now ?? Date.now)()) return;
    const key = await this.registration(row, true);
    if (!key) return;
    if (this.closed) return;
    row.deviceKeyId = key.deviceKeyId; row.toolVersion = refusal ? null : connection!.toolVersion; row.state = 'testing'; row.failureCode = null;
    if (refusal) {row.pendingResult = {ok: false, code: refusal, toolVersion: null}; row.state = 'failed'; row.failureCode = refusal;}
    await this.save();
    await this.execute(row, refusal ? undefined : connection, key);
  }
  private async resume(id: string): Promise<void> {
    const row = this.rows.get(id);
    if (!row || !row.pendingResult && !['waiting', 'testing'].includes(row.state) || this.closed) return;
    const key = await this.options.keys.get(id) ?? await this.registration(row, false);
    if (!key || row.deviceKeyId !== null && key.deviceKeyId !== row.deviceKeyId) return;
    const connection = row.pendingResult ? undefined : await this.options.connection(id);
    if (!row.pendingResult && (!connection || !nullable(connection.toolVersion))) {
      const code = connection ? 'tool_identity' : 'tool_not_found';
      row.pendingResult = {ok: false, code, toolVersion: null}; row.failureCode = code;
    }
    row.deviceKeyId = key.deviceKeyId; row.state = 'testing'; await this.save();
    await this.execute(row, connection, key);
  }
  private async registration(row: RunsOnSnapshot, create: boolean): Promise<RunnerDeviceKey | undefined> {
    let retry = 0;
    while (!this.closed && row.grantExpiresAt && Date.parse(row.grantExpiresAt) > (this.options.now ?? Date.now)()) {
      try {
        return await (create ? this.options.keys.ensure(row.aiToolId) : this.options.keys.registerExisting(row.aiToolId));
      } catch (error) {
        const code = runTestCode(error);
        if (['DEVICE_KEY_REVOKED', 'DEVICE_KEY_EXISTS', 'SCOPE_MISSING', 'RUNS_NOT_GRANTED', 'DEVICE_PROOF_INVALID', 'TOKEN_IN_FILE'].includes(code)) {
          // This grant cannot accept the pending key. Retire it with a visible final reason.
          await this.options.keys.remove(row.aiToolId, null);
          row.state = 'failed'; row.failureCode = code; row.deviceKeyId = null; await this.save();
          return undefined;
        }
        // A lost reply is retryable; malformed responses and local errors still throw.
        if (!['API_CONNECTION_FAILED', 'API_TIMEOUT'].includes(code)) throw error;
        create = false;
        const remaining = Date.parse(row.grantExpiresAt) - (this.options.now ?? Date.now)();
        if (remaining <= 0) throw error;
        const milliseconds = Math.min(1000 * 2 ** Math.min(retry++, 5), 30_000, remaining);
        if (this.options.sleep) await this.options.sleep(milliseconds, this.shutdown.signal);
        else await delay(milliseconds, undefined, {signal: this.shutdown.signal});
      }
    }
    return undefined;
  }
  private async execute(row: RunsOnSnapshot, connection: RunTestConnection | undefined, key: RunnerDeviceKey, model?: string): Promise<RunTestResult> {
    if (!row.pendingResult) {
      if (!connection) throw new HelperError('tool_not_found', 'The approved tool is not available on this computer.');
      const controller = new AbortController(); this.controllers.set(row.aiToolId, controller);
      if (this.closed) controller.abort();
      let result: RunTestResult;
      try {result = await this.options.test(connection, {model, signal: controller.signal});}
      catch (error) {result = {ok: false, code: runTestCode(error), toolVersion: connection.toolVersion};}
      if (!validResult(result)) result = {ok: false, code: 'tool_failed', toolVersion: connection.toolVersion};
      row.pendingResult = result; row.state = result.ok ? 'testing' : 'failed'; row.failureCode = result.code;
      await this.save();
    }
    const body = row.pendingResult;
    const protocol = this.options.protocol(key);
    try {
      const answer = await protocol.testResult(body);
      if (answer.state !== (body.ok ? 'on' : 'failed')) throw new HelperError('API_RESPONSE_INVALID', 'The test result acknowledgement is invalid.');
      row.state = answer.state; row.failureCode = body.code; delete row.pendingResult; await this.save();
    } catch (error) {
      if (body.ok && runTestCode(error) === 'RUNS_NOT_TESTING') {
        await protocol.heartbeat({helperVersion: VERSION, toolVersion: body.toolVersion, agents: [], running: []});
        row.state = 'on'; row.failureCode = null; delete row.pendingResult; await this.save();
      } else if (!body.ok && ['DEVICE_KEY_REVOKED', 'SCOPE_MISSING'].includes(runTestCode(error))) {
        // A failed test revokes this key, including when its first acknowledgement was lost.
        row.state = 'failed'; row.failureCode = body.code; delete row.pendingResult; await this.save();
      } else if (body.ok && ['DEVICE_KEY_REVOKED', 'SCOPE_MISSING'].includes(runTestCode(error))) {
        row.state = 'failed'; row.failureCode = runTestCode(error); delete row.pendingResult; await this.save(); throw error;
      } else throw error;
    }
    return body;
  }
  async testConnection(aiToolId: string, options: {model?: string} = {}): Promise<RunTestResult> {
    if (!uuid.test(aiToolId)) throw new HelperError('RUNS_NOT_GRANTED', 'The tool connection id is invalid.');
    if (this.closed) throw new HelperError('runner_stopped', 'The runner has stopped.');
    if (this.jobs.has(aiToolId)) await this.jobs.get(aiToolId);
    let result: RunTestResult | undefined;
    // Claim a controller job before waiting for the cross-process lease, so stop waits for this test too.
    this.schedule(aiToolId, async () => {
      const connection = await this.options.connection(aiToolId), key = await this.options.keys.get(aiToolId);
      if (!connection || !nullable(connection.toolVersion) || !key) throw new HelperError('RUNS_NOT_GRANTED', 'Turn on runs in MadDots AI before testing this tool.');
      let row = this.rows.get(aiToolId);
      if (!row || row.state === 'on' || row.state === 'failed' && !row.pendingResult) {
        // The protocol only accepts activation tests. A later diagnostic must never replace a live heartbeat.
        const controller = new AbortController(); this.controllers.set(aiToolId, controller);
        if (this.closed) controller.abort();
        try {result = await this.options.test(connection, {...options, signal: controller.signal});}
        catch (error) {result = {ok: false, code: runTestCode(error), toolVersion: connection.toolVersion};}
        return;
      }
      row ??= {aiToolId, state: 'testing', failureCode: null, deviceKeyId: key.deviceKeyId, toolVersion: connection.toolVersion, grantExpiresAt: null};
      row.state = 'testing'; row.failureCode = null; row.deviceKeyId = key.deviceKeyId; delete row.pendingResult;
      this.rows.set(aiToolId, row); await this.save();
      result = await this.execute(row, connection, key, options.model);
    });
    await this.jobs.get(aiToolId);
    if (!result) {
      const row = this.rows.get(aiToolId);
      throw new HelperError(this.errors.get(aiToolId) ?? row?.failureCode ?? 'RUNS_NOT_GRANTED', 'The run test could not be completed.');
    }
    return result;
  }
  /** Reconcile only the retired live activation, without erasing test failures or replacements. */
  async forget(aiToolId: string, deviceKeyId: string | null): Promise<void> {
    await this.exclusive(async () => {
      const row = this.rows.get(aiToolId);
      if (row?.state !== 'on' || deviceKeyId !== null && row.deviceKeyId !== deviceKeyId) return;
      this.rows.delete(aiToolId); await this.save();
    }, {now: this.options.now ?? Date.now, sleep: async () => {throw new HelperError('HELPER_BUSY', 'The activation lease is busy.');}});
  }
  async idle(): Promise<void> {while (this.jobs.size) await Promise.all([...this.jobs.values()]); await this.writes;}
  async close(): Promise<void> {this.closed = true; this.shutdown.abort(); for (const controller of this.controllers.values()) controller.abort(); await this.idle();}
}
