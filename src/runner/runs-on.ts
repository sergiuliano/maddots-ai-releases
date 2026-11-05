import {setTimeout as delay} from 'node:timers/promises';
import {join} from 'node:path';
import {ApiError, isObject} from '../api.js';
import {HelperError} from '../config.js';
import {VERSION} from '../release-identity.js';
import {atomicWrite, ensurePrivateDirectory, readPrivateFile, withWriteLock, type HelperPaths} from '../paths.js';
import type {RunnerTestResultBody} from '../shared/runner-protocol.js';
import type {RunnerBootstrapAgent, RunnerDefinitionFields} from '../shared/runner-acceptance.js';
import {TOOL_MATRIX, toolRunCapability, type ToolMatrix} from '../shared/tool-matrix.js';
import type {DeviceKeyStore, RunnerDeviceKey} from './device-key.js';
import type {RunnerProtocolClient} from './protocol-client.js';
import {acceptanceAcknowledgment, acceptanceAuthorization, hasAcceptance, type VerifiedAcceptance} from './acceptance.js';
import {readBound, writeBound} from './state.js';
import {acquireRunnerControllerLease, type RunnerControllerStorage} from './storage-lock.js';
import {runTestCode, type RunTestConnection, type RunTestResult} from './test-run.js';
import type {LocalAgents} from './agents-local.js';
import {createAcceptanceOperation, type LinuxAcceptanceOperation} from './linux-authorization.js';
import {linuxLocalProviderSelection, prepareLinuxLocalProvider} from './linux-local-provider.js';

export type RunGrant = {aiToolId: string; expiresAt: string};
/** Terminal evidence can reconcile a result, but supplies no executable permission. */
export type TerminalTestResult = Omit<RunnerTestResultBody, 'authorization'>;
export type RunTestContext = {model?: string; signal: AbortSignal; purpose: 'activation' | 'diagnostic';
  acceptance?: VerifiedAcceptance; acceptanceOperation?: LinuxAcceptanceOperation};
export type RunsOnSnapshot = {
  aiToolId: string; state: 'waiting' | 'testing' | 'on' | 'failed'; failureCode: string | null;
  deviceKeyId: string | null; toolVersion: string | null; grantExpiresAt: string | null;
  pendingResult?: TerminalTestResult;
  awaitingLocalSetup?: true;
};
export type RunsOnOptions = {
  paths: Pick<HelperPaths, 'data'> & Partial<Pick<HelperPaths, 'platform'>>; helperId?: string; matrix?: ToolMatrix;
  keys: Pick<DeviceKeyStore, 'ensure' | 'get' | 'remove' | 'registerExisting'>;
  connection: (aiToolId: string) => Promise<RunTestConnection | undefined>;
  localAgents?: Pick<LocalAgents, 'read'>;
  protocol: (key: RunnerDeviceKey, aiToolId: string) => Pick<RunnerProtocolClient, 'testResult' | 'heartbeat'> & Partial<Pick<RunnerProtocolClient, 'testAcceptance' | 'agentDefinitions'>>;
  test: (connection: RunTestConnection, options: RunTestContext) => Promise<RunTestResult>;
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  /** Data-only preparation precedes the test acceptance request. */
  prepareLocalProvider?: typeof prepareLinuxLocalProvider;
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const nullable = (value: unknown) => value === null || typeof value === 'string' && value.length <= 200 && /^(?!.*(?:pm_|mdai_skill_))[A-Za-z0-9][A-Za-z0-9._+:/-]*$/.test(value);
function validAcknowledgment(value: unknown): boolean {
  return isObject(value) && Object.keys(value).sort().join(',') === 'deviceKeyId,generation,purpose,runId,scopeId,scopeVersion' &&
    value.purpose === 'activation-result' && typeof value.deviceKeyId === 'string' && uuid.test(value.deviceKeyId) &&
    typeof value.runId === 'string' && uuid.test(value.runId) && typeof value.generation === 'string' && /^[a-f0-9]{64}$/.test(value.generation) &&
    typeof value.scopeId === 'string' && uuid.test(value.scopeId) && Number.isSafeInteger(value.scopeVersion) && Number(value.scopeVersion) >= 1;
}
function validResult(value: unknown): value is TerminalTestResult {
  return isObject(value) && Object.keys(value).every(key => ['ok', 'code', 'toolVersion', 'acknowledgment'].includes(key)) && typeof value.ok === 'boolean' &&
    (value.code === null || typeof value.code === 'string' && /^(?!.*(?:pm_|mdai_skill_))[A-Za-z0-9_]{1,60}$/.test(value.code)) && nullable(value.toolVersion) &&
    (value.ok ? value.code === null : value.code !== null) && (value.acknowledgment === undefined || validAcknowledgment(value.acknowledgment));
}
function terminalResult(value: RunnerTestResultBody): TerminalTestResult {
  return {ok: value.ok, code: value.code, toolVersion: value.toolVersion,
    ...(value.acknowledgment ? {acknowledgment: structuredClone(value.acknowledgment)} : {})};
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
  private storage?: RunnerControllerStorage;
  constructor(private readonly options: RunsOnOptions) {}
  get busy(): boolean {return this.jobs.size > 0;}
  private get file() {return join(this.options.paths.data, 'runner', 'runs.json');}
  private async boundRead<T>(action: (storage?: RunnerControllerStorage) => Promise<T>): Promise<T> {
    if (process.platform !== 'linux' || this.storage) return action(this.storage);
    const storage = await acquireRunnerControllerLease(this.options.paths.data, 'activation');
    try {return await action(storage);} finally {await storage.release();}
  }
  async init(): Promise<void> {
    this.loading ??= this.boundRead(async storage => {
      if (!storage) await ensurePrivateDirectory(join(this.options.paths.data, 'runner'));
      let value: unknown;
      try {value = JSON.parse(storage ? await readBound(await storage.directory('runner'), 'runs.json') : await readPrivateFile(this.file));}
      catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new HelperError('RUNNER_STATE_INVALID', 'The saved run activation state is invalid.');}
      if (!isObject(value) || Object.keys(value).sort().join(',') !== 'format,tools' || value.format !== 1 || !Array.isArray(value.tools) || value.tools.length > 200) throw new HelperError('RUNNER_STATE_INVALID', 'The saved run activation state is invalid.');
      const loaded = new Map<string, RunsOnSnapshot>();
      for (const row of value.tools) {
        if (!isObject(row) || Object.keys(row).some(key => !['aiToolId', 'state', 'failureCode', 'deviceKeyId', 'toolVersion', 'grantExpiresAt', 'pendingResult', 'awaitingLocalSetup'].includes(key)) ||
            typeof row.aiToolId !== 'string' || !uuid.test(row.aiToolId) || loaded.has(row.aiToolId) || !['waiting', 'testing', 'on', 'failed'].includes(row.state as string) ||
            !(row.failureCode === null || typeof row.failureCode === 'string' && /^(?!.*(?:pm_|mdai_skill_))[A-Za-z0-9_]{1,60}$/.test(row.failureCode)) ||
            !(row.deviceKeyId === null || typeof row.deviceKeyId === 'string' && uuid.test(row.deviceKeyId)) || !nullable(row.toolVersion) ||
            !(row.grantExpiresAt === null || typeof row.grantExpiresAt === 'string' && Number.isFinite(Date.parse(row.grantExpiresAt))) ||
            row.pendingResult !== undefined && !validResult(row.pendingResult) ||
            row.awaitingLocalSetup !== undefined && (row.awaitingLocalSetup !== true || row.state !== 'waiting' || row.pendingResult !== undefined)) throw new HelperError('RUNNER_STATE_INVALID', 'The saved run activation state is invalid.');
        loaded.set(row.aiToolId, row as RunsOnSnapshot);
      }
      this.rows = loaded;
    });
    return this.loading;
  }
  private async reload(): Promise<void> {this.loading = undefined; this.rows = new Map(); await this.init();}
  async snapshot(): Promise<RunsOnSnapshot[]> {if (!this.jobs.size) await this.reload(); else await this.init(); return [...this.rows.values()].map(row => structuredClone(row));}
  private async save(): Promise<void> {
    const storage = this.storage;
    this.writes = this.writes.catch(() => {}).then(async () => {
      const content = JSON.stringify({format: 1, tools: [...this.rows.values()].map(row => ({...row,
        ...(row.pendingResult ? {pendingResult: terminalResult(row.pendingResult)} : {})}))}) + '\n';
      if (process.platform === 'linux') {
        if (!storage) throw new HelperError('RUNNER_STATE_UNAVAILABLE', 'The activation storage lease is unavailable.');
        await (storage.assertHeld ?? storage.assertCurrent)(); await writeBound(await storage.directory('runner'), 'runs.json', content);
      } else await atomicWrite(this.file, content);
    });
    await this.writes;
  }
  async syncGrants(value: unknown): Promise<void> {
    const grants = parseRunGrants(value);
    await this.init(); if (this.closed) return;
    const current = grants.filter(grant => Date.parse(grant.expiresAt) > (this.options.now ?? Date.now)());
    const granted = new Set(current.map(grant => grant.aiToolId));
    for (const grant of current) {
      this.schedule(grant.aiToolId, () => this.activate(grant), grant.expiresAt);
    }
    // Registration removes a waiting grant. Resume tests/results with the already registered key after a crash.
    for (const row of this.rows.values()) if (!granted.has(row.aiToolId) && (row.pendingResult || row.state === 'testing' || row.state === 'waiting')) {
      this.schedule(row.aiToolId, () => this.resume(row.aiToolId));
    }
  }
  private async exclusive<T>(work: () => Promise<T>, timing?: {now: () => number; sleep: (ms: number) => Promise<void>}): Promise<T> {
    if (process.platform === 'linux') {
      const storage = await acquireRunnerControllerLease(this.options.paths.data, 'activation', timing);
      try {this.storage = storage; await this.reload(); return await work();}
      finally {this.storage = undefined; await storage.release();}
    }
    const directory = join(this.options.paths.data, 'runner');
    await ensurePrivateDirectory(directory);
    // Keep the long-lived activation lease separate from the helper's credential write lock.
    const lockPaths = {data: directory, lock: join(directory, '.activation.lock')} as HelperPaths;
    return withWriteLock(lockPaths, async () => {await this.reload(); return work();}, timing);
  }
  private schedule(id: string, work: () => Promise<void>, grantExpiresAt?: string): void {
    if (this.jobs.has(id) || this.closed) return;
    this.errors.delete(id);
    const job = this.exclusive(async () => {
      if (this.closed) return;
      try {await this.bootstrap(id, work, grantExpiresAt);}
      catch (error) {
        this.errors.set(id, runTestCode(error));
        const row = this.rows.get(id);
        if (row) {row.failureCode = row.pendingResult && !row.pendingResult.ok ? row.pendingResult.code : runTestCode(error); await this.save();}
      }
    }).catch(error => {this.errors.set(id, runTestCode(error));}).finally(() => {this.jobs.delete(id); this.controllers.delete(id);});
    this.jobs.set(id, job);
  }
  /** Retry a revoked bootstrap key once, with server registration as the grant check. */
  private async bootstrap<T>(id: string, work: () => Promise<T>, grantExpiresAt?: string): Promise<T> {
    try {
      try {return await work();}
      catch (error) {
        const row = this.rows.get(id);
        if (!row?.awaitingLocalSetup || runTestCode(error) !== 'DEVICE_KEY_REVOKED') throw error;
        // The caller holds the activation lease throughout retirement, registration
        // and the row update. Persist the cleared binding before creating a key.
        await this.options.keys.remove(id, null);
        row.deviceKeyId = null; row.failureCode = 'DEVICE_KEY_REVOKED';
        if (grantExpiresAt) row.grantExpiresAt = grantExpiresAt;
        await this.save();
        const key = await this.options.keys.ensure(id);
        row.deviceKeyId = key.deviceKeyId; row.failureCode = null; await this.save();
        return await work();
      }
    } catch (error) {
      const row = this.rows.get(id), code = runTestCode(error);
      if (row?.awaitingLocalSetup && (error instanceof ApiError || code === 'TOKEN_IN_FILE') &&
          ['DEVICE_KEY_REVOKED', 'DEVICE_KEY_EXISTS', 'SCOPE_MISSING', 'RUNS_NOT_GRANTED', 'DEVICE_PROOF_INVALID', 'TOKEN_IN_FILE'].includes(code)) {
        await this.options.keys.remove(id, null);
        delete row.awaitingLocalSetup;
        row.deviceKeyId = null; row.state = 'failed'; row.failureCode = code; await this.save();
      }
      throw error;
    }
  }
  private async activate(grant: RunGrant): Promise<void> {
    let row = this.rows.get(grant.aiToolId);
    if (row?.grantExpiresAt && row.grantExpiresAt !== grant.expiresAt && Date.parse(grant.expiresAt) <= Date.parse(row.grantExpiresAt)) return;
    // CLI bootstrap may consume a grant before its service response arrives.
    // Prove that its key is still registered before associating it with this grant.
    if (row?.awaitingLocalSetup && row.grantExpiresAt !== grant.expiresAt) {
      const key = await this.options.keys.registerExisting(row.aiToolId, true);
      if (key) {row.deviceKeyId = key.deviceKeyId; row.grantExpiresAt = grant.expiresAt; await this.save();}
    }
    const continued = row?.grantExpiresAt === grant.expiresAt;
    if (row?.grantExpiresAt === grant.expiresAt && ['on', 'failed'].includes(row.state) && !row.pendingResult) return;
    if (!row || row.grantExpiresAt !== grant.expiresAt) await this.options.keys.remove(grant.aiToolId, row?.deviceKeyId ?? null);
    if (!row || row.grantExpiresAt !== grant.expiresAt) {
      row = {aiToolId: grant.aiToolId, state: 'waiting', failureCode: null, deviceKeyId: null, toolVersion: null, grantExpiresAt: grant.expiresAt};
      this.rows.set(grant.aiToolId, row); await this.save();
    }
    if (this.closed) return;
    const connection = await this.options.connection(row.aiToolId);
    const refusal = !connection ? 'tool_not_found' : connection.aiToolId !== row.aiToolId || !nullable(connection.toolVersion) ? 'tool_identity' : null;
    // Recheck approval immediately before key creation, after local I/O and discovery.
    if (this.closed || Date.parse(grant.expiresAt) <= (this.options.now ?? Date.now)()) return;
    const key = await this.registration(row, true);
    if (!key) return;
    if (this.closed) return;
    row.deviceKeyId = key.deviceKeyId; row.toolVersion = refusal ? null : connection!.toolVersion; row.failureCode = null;
    if (!refusal && !row.pendingResult && this.requiresAcceptance(connection!) && (!continued || row.awaitingLocalSetup)) {
      row.state = 'waiting'; row.awaitingLocalSetup = true; await this.save();
      if (!await this.hasLocalAccess(connection!, key)) return;
    }
    row.state = 'testing';
    if (refusal) {row.pendingResult = {ok: false, code: refusal, toolVersion: null}; row.state = 'failed'; row.failureCode = refusal;}
    else if (continued && !row.awaitingLocalSetup && !row.pendingResult && this.requiresAcceptance(connection!)) {
      row.pendingResult = {ok: false, code: 'activation_interrupted', toolVersion: connection!.toolVersion};
      row.state = 'failed'; row.failureCode = 'activation_interrupted';
    }
    delete row.awaitingLocalSetup;
    await this.save();
    await this.execute(row, refusal ? undefined : connection, key);
  }
  private async resume(id: string): Promise<void> {
    const row = this.rows.get(id);
    if (!row || !row.pendingResult && !['waiting', 'testing'].includes(row.state) || this.closed) return;
    // A lost bootstrap registration consumed the server grant. Recover only
    // the saved proof, even when the CLI never learned that grant's expiry.
    const key = await this.options.keys.get(id) ?? await (row.awaitingLocalSetup ? this.options.keys.registerExisting(id) : this.registration(row, false));
    if (!key || row.deviceKeyId !== null && key.deviceKeyId !== row.deviceKeyId) return;
    if (row.awaitingLocalSetup) {row.deviceKeyId = key.deviceKeyId; row.failureCode = null; await this.save();}
    const connection = row.pendingResult ? undefined : await this.options.connection(id);
    if (!row.pendingResult && (!connection || connection.aiToolId !== id || !nullable(connection.toolVersion))) {
      const code = connection ? 'tool_identity' : 'tool_not_found';
      row.pendingResult = {ok: false, code, toolVersion: null}; row.failureCode = code;
    } else if (!row.pendingResult && connection && this.requiresAcceptance(connection) && row.awaitingLocalSetup) {
      if (!await this.hasLocalAccess(connection, key)) return;
    } else if (!row.pendingResult && connection && this.requiresAcceptance(connection)) {
      // A persisted in-progress row cannot prove whether user code already ran.
      // Recover its terminal failure without fetching another execution grant.
      row.pendingResult = {ok: false, code: 'activation_interrupted', toolVersion: connection.toolVersion};
      row.failureCode = 'activation_interrupted';
    }
    delete row.awaitingLocalSetup;
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
        if (row.awaitingLocalSetup && code === 'DEVICE_KEY_REVOKED') throw error;
        if (['DEVICE_KEY_REVOKED', 'DEVICE_KEY_EXISTS', 'SCOPE_MISSING', 'RUNS_NOT_GRANTED', 'DEVICE_PROOF_INVALID', 'TOKEN_IN_FILE'].includes(code)) {
          // This grant cannot accept the pending key. Retire it with a visible final reason.
          await this.options.keys.remove(row.aiToolId, null);
          delete row.awaitingLocalSetup;
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
    let initialBody: RunnerTestResultBody | undefined;
    if (!row.pendingResult) {
      if (!connection) throw new HelperError('tool_not_found', 'The approved tool is not available on this computer.');
      const controller = new AbortController(); this.controllers.set(row.aiToolId, controller);
      if (this.closed) controller.abort();
      let result: RunTestResult;
      try {result = await this.test(connection, key, {model, signal: controller.signal, purpose: 'activation'});}
      catch (error) {result = {ok: false, code: runTestCode(error), toolVersion: connection.toolVersion};}
      initialBody = result;
      row.pendingResult = terminalResult(result); row.state = result.ok ? 'testing' : 'failed'; row.failureCode = result.code;
      await this.save();
    }
    const body = row.pendingResult;
    if (body.ok && !initialBody && !body.acknowledgment && (this.options.paths.platform ?? process.platform) === 'linux') {
      const restoredConnection = connection ?? await this.options.connection(row.aiToolId);
      if (!restoredConnection || restoredConnection.aiToolId !== row.aiToolId || this.requiresAcceptance(restoredConnection)) {
        row.state = 'failed'; row.failureCode = 'activation_evidence_missing'; delete row.pendingResult; await this.save();
        throw new HelperError('activation_evidence_missing', 'The saved result does not identify a completed activation.');
      }
    }
    const protocol = this.options.protocol(key, row.aiToolId);
    try {
      const answer = await protocol.testResult(initialBody ?? body);
      if (answer.state !== (body.ok ? 'on' : 'failed')) throw new HelperError('API_RESPONSE_INVALID', 'The test result acknowledgement is invalid.');
      row.state = answer.state; row.failureCode = body.code; delete row.pendingResult; await this.save();
    } catch (error) {
      if (body.ok && !body.acknowledgment && runTestCode(error) === 'RUNS_NOT_TESTING') {
        await protocol.heartbeat({helperVersion: VERSION, toolVersion: body.toolVersion, agents: [], running: []});
        row.state = 'on'; row.failureCode = null; delete row.pendingResult; await this.save();
      } else if (!body.ok && ['DEVICE_KEY_REVOKED', 'SCOPE_MISSING'].includes(runTestCode(error))) {
        // A failed test revokes this key, including when its first acknowledgement was lost.
        row.state = 'failed'; row.failureCode = body.code; delete row.pendingResult; await this.save();
      } else if (body.ok && ['DEVICE_KEY_REVOKED', 'SCOPE_MISSING', 'RUNS_NOT_TESTING', 'RUNS_NOT_GRANTED', 'RUNS_ACCEPTANCE_SCOPE', 'RUN_ACCEPTANCE_INVALID', 'RUN_ACCEPTANCE_SIGNATURE_INVALID'].includes(runTestCode(error))) {
        row.state = 'failed'; row.failureCode = runTestCode(error); delete row.pendingResult; await this.save(); throw error;
      } else throw error;
    }
    return body;
  }
  private requiresAcceptance(connection: RunTestConnection): boolean {
    const capability = toolRunCapability((this.options.matrix ?? TOOL_MATRIX).tools.find(tool => tool.key === connection.tool), this.options.paths.platform ?? process.platform);
    return Boolean(capability && !capability.offered && (this.options.paths.platform ?? process.platform) === 'linux');
  }
  private async hasLocalAccess(connection: RunTestConnection, key: RunnerDeviceKey): Promise<boolean> {
    const protocol = this.options.protocol(key, connection.aiToolId);
    if (!protocol.agentDefinitions) throw new HelperError('adapter_refused', 'The server definition bootstrap is unavailable.');
    const definitions = await protocol.agentDefinitions(connection.tool as RunnerDefinitionFields['toolKey']);
    const local = await this.options.localAgents?.read() ?? {};
    return definitions.length > 0 && definitions.every(agent => local[agent.agentId]?.aiToolId === connection.aiToolId && local[agent.agentId].access === 'full_access');
  }
  /** Bootstrap registration and metadata never run a tool or create an execution receipt. */
  async agentDefinitions(aiToolId: string): Promise<RunnerBootstrapAgent[]> {
    if (!uuid.test(aiToolId) || this.closed) throw new HelperError('RUNS_NOT_GRANTED', 'The connection is unavailable.');
    return this.exclusive(() => this.bootstrap(aiToolId, async () => {
      const connection = await this.options.connection(aiToolId);
      let row = this.rows.get(aiToolId);
      if (!connection || connection.aiToolId !== aiToolId || !this.requiresAcceptance(connection)) throw new HelperError('adapter_refused', 'Scoped local setup is unavailable for this tool.');
      if (row && !row.awaitingLocalSetup) throw new HelperError('RUNS_NOT_TESTING', 'The connection is not waiting for local setup.');
      // Registration consumes the grant. Persist the setup wait first so a lost
      // registration/definition reply cannot expose this key to service heartbeats.
      row ??= {aiToolId, state: 'waiting', failureCode: null, deviceKeyId: null,
        toolVersion: connection.toolVersion, grantExpiresAt: null, awaitingLocalSetup: true};
      this.rows.set(aiToolId, row); await this.save();
      const key = await this.options.keys.get(aiToolId) ?? await this.options.keys.ensure(aiToolId);
      row.deviceKeyId = key.deviceKeyId; row.toolVersion = connection.toolVersion; row.failureCode = null;
      await this.save();
      const protocol = this.options.protocol(key, aiToolId);
      if (!protocol.agentDefinitions) throw new HelperError('adapter_refused', 'The server definition bootstrap is unavailable.');
      return protocol.agentDefinitions(connection.tool as RunnerDefinitionFields['toolKey']);
    }));
  }
  private async test(connection: RunTestConnection, key: RunnerDeviceKey, options: Omit<RunTestContext, 'acceptance' | 'acceptanceOperation'>): Promise<RunTestResult> {
    const platform = this.options.paths.platform ?? process.platform;
    let preparedConnection = connection;
    const capability = toolRunCapability((this.options.matrix ?? TOOL_MATRIX).tools.find(tool => tool.key === connection.tool), platform);
    if (!capability || !capability.offered && platform !== 'linux') throw new HelperError('adapter_refused', 'This tool cannot run on this platform.');
    let acceptance: VerifiedAcceptance | undefined;
    let acceptanceOperation: LinuxAcceptanceOperation | undefined;
    if (!capability.offered) {
      const helperId = this.options.helperId;
      if (!helperId || !uuid.test(helperId)) throw new HelperError('adapter_refused', 'The selected helper identity is unavailable.');
      const protocol = this.options.protocol(key, connection.aiToolId);
      if (!protocol.testAcceptance) throw new HelperError('adapter_refused', 'The scoped test authorization is unavailable.');
      const agents = options.purpose === 'activation' ? Object.entries(await this.options.localAgents?.read() ?? {})
        .filter(([, agent]) => agent.aiToolId === connection.aiToolId).map(([agentId, agent]) => ({agentId, access: agent.access})) : undefined;
      if (agents && !agents.length) throw new HelperError('adapter_refused', 'Confirm local access for the acceptance agent before testing this connection.');
      if (platform === 'linux' && connection.tool === 'opencode') {
        if (!protocol.agentDefinitions) throw new HelperError('adapter_refused', 'The approved local provider model definition is unavailable.');
        const definitions = await protocol.agentDefinitions('opencode');
        if (!definitions.length || definitions.some(definition => !linuxLocalProviderSelection({tool: connection.tool,
          provider: definition.provider, model: definition.model})) || options.model !== undefined &&
          !linuxLocalProviderSelection({tool: connection.tool, provider: definitions[0].provider, model: options.model}) || connection.model !== undefined &&
          !linuxLocalProviderSelection({tool: connection.tool, provider: connection.provider ?? null, model: connection.model})) {
          throw new HelperError('adapter_refused', 'The approved local provider model definition is unavailable.');
        }
        await (this.options.prepareLocalProvider ?? prepareLinuxLocalProvider)({tool: connection.tool,
          provider: definitions[0].provider, model: definitions[0].model, signal: options.signal});
        preparedConnection = {...connection, model: definitions[0].model, provider: definitions[0].provider, effort: definitions[0].effort};
        if (options.signal.aborted || this.closed) throw new HelperError('runner_stopped', 'The runner has stopped.');
      }
      try {acceptance = await protocol.testAcceptance(options.purpose === 'activation' ? {purpose: 'activation', agents: agents!} : {purpose: 'diagnostic'});}
      catch (error) {
        if (error instanceof ApiError && error.code === 'NOT_FOUND' && error.status === 404) {
          throw new HelperError('adapter_refused', 'The server cannot authorize this scoped test.');
        }
        throw error;
      }
      if (!hasAcceptance(acceptance, {toolKey: connection.tool, platform, purpose: options.purpose,
        helperId, aiToolId: connection.aiToolId, deviceKeyId: key.deviceKeyId})) throw new HelperError('adapter_refused', 'The scoped test authorization is invalid.');
      acceptanceOperation = createAcceptanceOperation(acceptance, {toolKey: connection.tool, platform,
        helperId, aiToolId: connection.aiToolId, deviceKeyId: key.deviceKeyId, runId: acceptance.runId,
        generation: acceptance.generation, purpose: options.purpose});
    }
    if (options.signal.aborted) throw new HelperError('runner_stopped', 'The runner has stopped.');
    const value = await this.options.test(preparedConnection, {...options, ...(acceptance ? {acceptance, acceptanceOperation} : {})});
    // The controller owns result authorization. Callback-supplied permission or
    // acknowledgment fields never become trusted result evidence.
    const result = value.ok && options.signal.aborted ? {ok: false, code: 'runner_stopped', toolVersion: value.toolVersion} :
      {ok: value.ok, code: value.code, toolVersion: value.toolVersion};
    if (!validResult(result)) throw new HelperError('tool_failed', 'The run test result is invalid.');
    if (!acceptance || options.purpose !== 'activation') return result;
    const acknowledgment = acceptanceAcknowledgment(acceptance);
    if (!result.ok) return {...result, acknowledgment};
    try {
      // startBy limits admission. A completed test must still be within the
      // signed workload/scope lifetime when it asks the server to enable runs.
      return {...result, authorization: acceptanceAuthorization(acceptance), acknowledgment};
    } catch (error) {return {ok: false, code: runTestCode(error), toolVersion: result.toolVersion, acknowledgment};}
  }
  async testConnection(aiToolId: string, options: {model?: string} = {}): Promise<RunTestResult> {
    if (!uuid.test(aiToolId)) throw new HelperError('RUNS_NOT_GRANTED', 'The tool connection id is invalid.');
    if (this.closed) throw new HelperError('runner_stopped', 'The runner has stopped.');
    if (this.jobs.has(aiToolId)) await this.jobs.get(aiToolId);
    let result: RunTestResult | undefined;
    // Claim a controller job before waiting for the cross-process lease, so stop waits for this test too.
    this.schedule(aiToolId, async () => {
      const connection = await this.options.connection(aiToolId);
      let row = this.rows.get(aiToolId);
      const key = await this.options.keys.get(aiToolId) ?? (row?.awaitingLocalSetup ? await this.options.keys.registerExisting(aiToolId) : undefined);
      if (!connection || connection.aiToolId !== aiToolId || !nullable(connection.toolVersion) || !key) throw new HelperError('RUNS_NOT_GRANTED', 'Turn on runs in MadDots AI before testing this tool.');
      if (row?.awaitingLocalSetup) {
        row.deviceKeyId = key.deviceKeyId; row.failureCode = null; await this.save();
        if (!await this.hasLocalAccess(connection, key)) throw new HelperError('AGENT_SETUP_REQUIRED', 'Run agent setup to confirm local access first.');
        delete row.awaitingLocalSetup; row.state = 'testing'; await this.save();
        result = await this.execute(row, connection, key, options.model);
        return;
      }
      if (!row || row.state === 'on' || row.state === 'failed' && !row.pendingResult) {
        // A later diagnostic has its own bounded purpose and never submits an activation result.
        const controller = new AbortController(); this.controllers.set(aiToolId, controller);
        if (this.closed) controller.abort();
        try {result = await this.test(connection, key, {...options, signal: controller.signal, purpose: 'diagnostic'});}
        catch (error) {result = {ok: false, code: runTestCode(error), toolVersion: connection.toolVersion};}
        return;
      }
      if (row.pendingResult) {
        // Retrying a terminal result must never discard evidence and rerun a tool.
        result = await this.execute(row, undefined, key);
        return;
      }
      if (this.requiresAcceptance(connection)) {
        row.pendingResult = {ok: false, code: 'activation_interrupted', toolVersion: connection.toolVersion};
        row.failureCode = 'activation_interrupted';
        result = await this.execute(row, undefined, key);
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
