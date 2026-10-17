import {join} from 'node:path';
import {TOOL_MATRIX, type ToolMatrix} from '../shared/tool-matrix.js';
import {isSkillsToken, type ApiClient} from '../api.js';
import {clock, HelperError, type Timing} from '../config.js';
import type {NotifyOptions} from '../notify.js';
import {atomicWrite, ensurePrivateDirectory, readPrivateFile, withWriteLock, type HelperPaths} from '../paths.js';
import type {SecretStore} from '../secret-store.js';
import type {StateStore} from '../state.js';
import type {BuildVerifier} from '../verify.js';
import {adapters, type AdapterRegistry} from './adapters/index.js';
import {LocalAgents, reserveAgentSetupDialog, showAgentSetupDialog} from './agents-local.js';
import {DeviceKeyStore, type RunnerDeviceKey} from './device-key.js';
import {postResult} from './post.js';
import {RunnerProtocolClient, type RunnerAgent, type RunnerHeartbeat} from './protocol-client.js';
import {RunnerCore, type RunnerConnection, type RunnerOptions} from './runner.js';
import {RunsOnController} from './runs-on.js';
import {createSkillStager} from './stage-skills.js';
import {recoverTestRuns, runToolTest, type RunTestConnection} from './test-run.js';
import {startTokenCheck} from './token-check.js';

type CompositionOptions = Omit<RunnerOptions, 'data' | 'verifiedBuild' | 'allowedBuild' | 'skillDescription' | 'stageSkills' | 'startCheck' | 'deliver'> & {
  paths: HelperPaths; helperId: string; verifier?: BuildVerifier; timing?: Timing;
};

/** The production construction site. These lifecycle hooks are never optional here. */
export function createComposedRunner({paths, helperId, verifier, timing = clock, ...options}: CompositionOptions): RunnerCore {
  return new RunnerCore({...options, data: paths.data, now: timing.now, sleep: timing.sleep,
    ...createSkillStager({paths, helperId, verifier}),
    startCheck: context => startTokenCheck(context, timing),
    deliver: context => postResult(context, timing)});
}

type CatalogAgent = RunnerAgent & {aiToolId: string; claimable: boolean};
type RunsRuntimeOptions = {
  paths: HelperPaths; helperId: string; api: ApiClient; secrets: SecretStore; state: StateStore;
  endpoint: URL; env?: NodeJS.ProcessEnv; request?: typeof fetch; timing?: Timing; verifier?: BuildVerifier;
  registry?: AdapterRegistry; matrix?: ToolMatrix; processes?: RunnerOptions['processes']; notify?: NotifyOptions;
};

/** Local service composition. Card contents and local folder paths never enter its protocol bodies. */
export class RunsRuntime {
  readonly local: LocalAgents;
  readonly activation: RunsOnController;
  readonly core: RunnerCore;
  private readonly keys: DeviceKeyStore;
  private readonly registry: AdapterRegistry;
  private readonly timing: Timing;
  private readonly catalogPath: string;
  private dialog?: Promise<void>;
  private readonly dialogStop = new AbortController();
  private nextRecovery = 0;
  private catalogWrite: Promise<void> = Promise.resolve();
  constructor(private readonly options: RunsRuntimeOptions) {
    this.local = new LocalAgents(options.paths);
    this.registry = options.registry ?? adapters;
    this.timing = options.timing ?? clock;
    this.catalogPath = join(options.paths.data, 'runner', 'agents-catalog.json');
    this.keys = new DeviceKeyStore({paths: options.paths, secrets: options.secrets, helperId: options.helperId, api: options.api});
    this.activation = new RunsOnController({paths: options.paths, keys: this.keys, now: this.timing.now, sleep: this.timing.sleep,
      connection: id => this.testConnection(id), protocol: key => this.protocol(key),
      test: (connection, testOptions) => runToolTest({connection, ...testOptions, registry: this.registry,
        matrix: options.matrix, processes: options.processes, now: this.timing.now, data: options.paths.data})});
    this.core = createComposedRunner({paths: options.paths, helperId: options.helperId, verifier: options.verifier, timing: this.timing,
      matrix: options.matrix, processes: options.processes, registry: this.registry,
      connections: () => this.connections(), localAgents: () => this.local.ready(),
      paired: async () => (await options.state.read()).status !== 'pair_again' && (await options.state.read()).status !== 'unpaired',
      removeDeviceKey: async (id, key) => {
        await this.keys.remove(id, key);
        // Credential removal must succeed even while another activation owns its lease.
        await this.activation.forget(id, key).catch(() => {});
      }});
  }
  async init(): Promise<void> {
    if (this.timing.now() < this.nextRecovery) return;
    // CLI diagnostics may start after service startup, then lose their owning process.
    // Revisit recovery on the service tick; a cooperating live test keeps its lease.
    this.nextRecovery = this.timing.now() + 60_000;
    const recovered = await recoverTestRuns({data: this.options.paths.data, processes: this.options.processes, skipBusy: true});
    if (!recovered) this.nextRecovery = 0;
  }
  private protocol(key: RunnerDeviceKey): RunnerProtocolClient {
    return new RunnerProtocolClient({endpoint: this.options.endpoint, deviceKey: key, now: this.timing.now,
      env: this.options.env, fetcher: this.options.request, maddots: {env: this.options.env, fetcher: this.options.request},
      token: async () => {
        const value = await this.options.secrets.get('skills-token');
        if (!isSkillsToken(value)) throw new HelperError('TOKEN_REQUIRED', 'Connect this computer before running agents.');
        return value;
      }});
  }
  private async testConnection(aiToolId: string): Promise<RunTestConnection | undefined> {
    const state = await this.options.state.read();
    if (state.status !== 'connected' || state.helperId !== this.options.helperId || state.tokenStorage !== 'keychain') return;
    const connection = state.connections?.find(item => item.id === aiToolId && item.variant === 'cli');
    const tool = connection && state.tools.find(item => item.tool === connection.tool && item.variant === 'cli');
    if (!connection || !tool?.path || !tool.realpath || !this.registry.get(connection.tool)) return;
    return {aiToolId, tool: connection.tool, bin: tool.path, realpath: tool.realpath, toolVersion: tool.version};
  }
  async connections(): Promise<RunnerConnection[]> {
    const state = await this.options.state.read();
    if (state.status !== 'connected' || state.helperId !== this.options.helperId || state.tokenStorage !== 'keychain') return [];
    const result: RunnerConnection[] = [];
    const activations = await this.activation.snapshot();
    for (const item of state.connections ?? []) {
      const activation = activations.find(row => row.aiToolId === item.id);
      if (activation && activation.state !== 'on') continue;
      const tool = await this.testConnection(item.id);
      if (!tool) continue;
      const key = await this.keys.get(item.id);
      if (!key) continue;
      const protocol = this.protocol(key);
      result.push({...tool, deviceKeyId: key.deviceKeyId, runsOn: true, protocol: {
        claim: body => protocol.claim(body), outcome: (id, body) => protocol.outcome(id, body),
        heartbeat: async body => {
          const heartbeat = await protocol.heartbeat(body);
          // Catalog persistence must not discard Stop or claimable answers already received.
          this.catalogWrite = this.catalogWrite.then(() => this.rememberAgents(item.id, heartbeat)).catch(() => {});
          return heartbeat;
        },
      }});
    }
    return result;
  }
  private async rememberAgents(aiToolId: string, heartbeat: RunnerHeartbeat): Promise<void> {
    // This catalog contains agent configuration only, never cards, prompts, folders or output.
    await withWriteLock(this.options.paths, async () => {
      const currentIds = new Set(heartbeat.agents.map(agent => agent.agentId));
      const rows = (await this.catalog().catch(() => [])).filter(agent => agent.aiToolId !== aiToolId && !currentIds.has(agent.agentId));
      rows.push(...heartbeat.agents.map(agent => ({...agent, aiToolId, claimable: heartbeat.claimable.some(run => run.agentId === agent.agentId)})));
      await ensurePrivateDirectory(join(this.options.paths.data, 'runner'));
      await atomicWrite(this.catalogPath, JSON.stringify(rows) + '\n');
    }, {now: this.timing.now, sleep: async () => {
      // The next heartbeat can refresh this disposable cache; never wait behind an import.
      throw new HelperError('HELPER_BUSY', 'The agent catalog update will retry on the next heartbeat.');
    }});
  }
  async catalogSettled(): Promise<void> {await this.catalogWrite;}
  async catalog(): Promise<CatalogAgent[]> {
    try {
      const value: unknown = JSON.parse(await readPrivateFile(this.catalogPath));
      if (!Array.isArray(value) || value.length > 8000 || value.some(row => !row || typeof row !== 'object' ||
        typeof row.agentId !== 'string' || typeof row.aiToolId !== 'string' || typeof row.handle !== 'string' ||
        typeof row.model !== 'string' || !Array.isArray(row.skills))) throw new Error();
      return value as CatalogAgent[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new HelperError('AGENT_STATE_INVALID', 'The local agent catalog is invalid. Wait for the next heartbeat.');
    }
  }
  async notifySetup(): Promise<void> {
    if (this.dialog || this.dialogStop.signal.aborted) return;
    const locals = await this.local.read(), connections = await this.connections();
    const stager = createSkillStager({paths: this.options.paths, helperId: this.options.helperId, verifier: this.options.verifier});
    const waiting: {agentId: string}[] = [];
    for (const agent of await this.catalog()) {
      const connection = agent.status === 'active' ? connections.find(item => item.aiToolId === agent.aiToolId) : undefined;
      if (!connection) continue;
      const local = locals[agent.agentId];
      let needs = !local?.setupDone || local.aiToolId !== agent.aiToolId || agent.accessWanted === 'full_access' && local.access !== 'full_access';
      if (agent.claimable) for (const skill of agent.skills) {
        if (!skill.digest || !await stager.verifiedBuild(skill.digest, skill, connection, agent.agentId) ||
          skill.hasCode && !await stager.allowedBuild(skill, connection, agent.agentId)) needs = true;
      }
      if (needs) waiting.push({agentId: agent.agentId});
    }
    const options = {...this.options.notify, timing: this.timing, env: this.options.env, signal: this.dialogStop.signal};
    const pending = await withWriteLock(this.options.paths, () => reserveAgentSetupDialog(this.options.paths, waiting, options), this.timing);
    if (typeof pending !== 'string') this.dialog = showAgentSetupDialog(pending, options).then(() => {}, () => {}).finally(() => {this.dialog = undefined;});
  }
  async command(argv: string[], io: {isTTY: boolean; prompt: (question: string) => Promise<string>; output: (line: string) => void}): Promise<void> {
    if (argv[0] === 'runs') {
      if (argv.length === 1) {
        const rows = await this.activation.snapshot();
        for (const connection of (await this.options.state.read()).connections ?? []) {
          const row = rows.find(value => value.aiToolId === connection.id);
          let state: string = row?.state ?? 'off';
          if (row?.state === 'on') {
            const key = await this.keys.get(connection.id).catch(() => null);
            // Unreadable credentials keep their saved state; a missing/replaced key cannot run.
            if (key !== null && key?.deviceKeyId !== row.deviceKeyId) state = 'off';
          }
          io.output(`${connection.tool}: ${state}${state !== 'off' && row?.failureCode ? ` (${row.failureCode})` : ''}`);
        }
        return;
      }
      if (argv[1] !== 'test' || !argv[2] || !(argv.length === 3 || argv.length === 5 && argv[3] === '--model' && argv[4])) throw new HelperError('USAGE', 'Use maddots-ai runs test <tool> [--model <model>].');
      const connection = (await this.options.state.read()).connections?.find(item => item.tool === argv[2] && item.variant === 'cli');
      if (!connection) throw new HelperError('tool_not_found', 'This command-line tool is not connected.');
      const result = await this.activation.testConnection(connection.id, {model: argv[4]});
      io.output(`${connection.tool} test: ${result.ok ? 'passed' : result.code}.`);
      return this.command(['runs'], io);
    }
    if (argv[0] !== 'agent' || !['setup', 'access'].includes(argv[1]) || argv.some(value => value.startsWith('--'))) throw new HelperError('USAGE', 'Use maddots-ai agent setup [handle|agent-id] or agent access <handle|agent-id> folder-only|full.');
    if (!io.isTTY && (argv[1] === 'setup' || argv[3] === 'full')) throw new HelperError('AGENT_TTY_REQUIRED', 'Agent setup requires an interactive terminal on this computer.');
    const connected = new Set(((await this.options.state.read()).connections ?? []).map(connection => connection.id));
    const catalog = (await this.catalog()).filter(agent => connected.has(agent.aiToolId));
    const selected = catalog.filter(agent => (!argv[2] || agent.agentId === argv[2] || agent.handle === argv[2].replace(/^@/, '')) && agent.status === 'active');
    if (!selected.length) throw new HelperError('AGENT_NOT_FOUND', 'No matching agent has been received. Wait for the helper heartbeat.');
    if (argv[1] === 'setup' && argv.length > 3 || argv[1] === 'access' && (argv.length !== 4 || !['folder-only', 'full'].includes(argv[3]))) throw new HelperError('USAGE', 'Use agent setup [handle|agent-id] or agent access <handle|agent-id> folder-only|full.');
    for (const agent of selected) {
      const connection = await this.testConnection(agent.aiToolId), adapter = connection && this.registry.get(connection.tool);
      if (!connection || !adapter) throw new HelperError('tool_not_found', 'The agent tool is unavailable on this computer.');
      const setupOptions = {...io, adapter, bin: connection.realpath, model: agent.model, provider: agent.provider,
        effort: agent.effort, matrix: this.options.matrix ?? TOOL_MATRIX, processes: this.options.processes, now: this.timing.now};
      if (selected.length > 1) io.output(`@${agent.handle} (${agent.agentId}):`);
      if (argv[1] === 'setup') await this.local.setup(agent, setupOptions);
      else {
        const local = (await this.local.read())[agent.agentId];
        if (!local || local.aiToolId !== agent.aiToolId) throw new HelperError('AGENT_NOT_FOUND', 'Run agent setup for the current tool before changing access.');
        await this.local.access(agent, argv[3] as 'folder-only' | 'full', setupOptions);
      }
      io.output(`@${agent.handle}: local setup saved.`);
    }
    if (argv[1] === 'setup') io.output('If skills with code wait for Allow on this computer, run maddots-ai allow.');
  }
  async close(): Promise<void> {
    this.dialogStop.abort();
    await this.activation.close();
    await this.core.close();
    await this.catalogWrite;
    await this.dialog;
  }
}
