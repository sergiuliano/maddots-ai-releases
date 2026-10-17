import { ApiClient, ApiError, isObject, isSkillsToken, type ApiRequestOptions, type ApiResponse } from './api.js';
import { HelperError, clock, type Timing } from './config.js';
import type { DetectedTool } from './detect.js';
import { parseConnections, parseScopes, reportedTools, safeText, type PairingCredential } from './pairing.js';
import type { SecretStore } from './secret-store.js';
import type { HelperState, StateStore } from './state.js';
import { disconnectRunners } from './runner/runner.js';

export type TokenRequestOptions = Omit<ApiRequestOptions, 'token'>;
export type TokenStatus = { state: HelperState; renewReminder: boolean; syncAllowed: boolean; message: string };
const day = 24 * 60 * 60 * 1000;
const hour = 60 * 60 * 1000;
const pairAgainCodes = new Set(['TOKEN_REVOKED', 'TOKEN_LAPSED', 'TOKEN_INVALID']);
const identity = (tool: { tool: string; variant: string }) => `${tool.tool}\0${tool.variant}`;
function date(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }

function toolIdentities(value: unknown): Set<string> {
  if (!Array.isArray(value) || value.length > 40) throw new HelperError('API_RESPONSE_INVALID', 'MadDots AI returned invalid tool approval information.');
  return new Set(value.map(item => {
    if (!isObject(item) || !safeText(item.tool, 80) || !safeText(item.variant, 80)) {
      throw new HelperError('API_RESPONSE_INVALID', 'MadDots AI returned invalid tool approval information.');
    }
    return identity({ tool: item.tool, variant: item.variant });
  }));
}

export class TokenManager {
  private currentToken?: string;
  private rotation?: Promise<void>;
  private retryRenewAt = 0;
  constructor(
    private readonly api: ApiClient,
    private readonly secrets: SecretStore,
    private readonly stateStore: Pick<StateStore, 'read' | 'write'>,
    private readonly timing: Timing = clock,
    private readonly remind?: (message: string) => Promise<void>,
  ) {}

  async acceptPairing(credential: PairingCredential, tools: DetectedTool[]): Promise<HelperState> {
    if (!isSkillsToken(credential.token)) throw new HelperError('PAIRING_RESPONSE_INVALID', 'MadDots AI returned an invalid skills token.');
    await this.secrets.set('skills-token', credential.token, credential.scopes);
    if (await this.secrets.get('skills-token') !== credential.token) {
      throw new HelperError('SECRET_VERIFY_FAILED', 'The saved skills token could not be verified. Connect this computer again.');
    }
    const previous = await this.stateStore.read();
    const state: HelperState = {
      ...previous, status: 'connected', helperId: credential.helperId, account: credential.account,
      scopes: [...credential.scopes], issuedAt: new Date(this.timing.now()).toISOString(),
      renewBy: credential.renewBy, idleLapseAt: credential.idleLapseAt,
      tools: tools.map(tool => ({...tool, models: [...tool.models]})), pendingTools: [], tokenStorage: this.secrets.storage,
      lastDetectionAt: new Date(this.timing.now()).toISOString(),
      connections: credential.connections.map(connection => ({ ...connection })), proposedTools: [],
    };
    // tools is the detected inventory. Approval is represented only by the server.
    delete state.lastRenewDialogAt;
    delete state.lastRenewCheckAt;
    await this.stateStore.write(state);
    this.currentToken = credential.token;
    this.retryRenewAt = 0;
    return state;
  }

  private async loadToken(): Promise<string> {
    if (!this.currentToken) {
      const saved = await this.secrets.get('skills-token');
      if (!isSkillsToken(saved)) throw new HelperError('TOKEN_REQUIRED', 'Run maddots-ai connect to connect this computer.');
      this.currentToken = saved;
    }
    return this.currentToken;
  }

  /** Authenticated helper requests, including safe rotation and one credential re-read. */
  async request<T>(path: string, options: TokenRequestOptions = {}): Promise<ApiResponse<T>> {
    let state = await this.stateStore.read();
    if (state.status === 'unpaired' || state.status === 'pair_again') {
      throw new HelperError('TOKEN_REQUIRED', 'Run maddots-ai connect to connect this computer.');
    }
    if (state.idleLapseAt && this.timing.now() >= Date.parse(state.idleLapseAt)) {
      await this.clearCredentials();
      throw new ApiError('TOKEN_LAPSED', 401);
    }
    if (state.renewBy && this.timing.now() >= Date.parse(state.renewBy) && state.status !== 'renew_required') {
      state = { ...state, status: 'renew_required' };
      await this.stateStore.write(state);
    }
    if (state.lastRenewCheckAt) this.retryRenewAt = Math.max(this.retryRenewAt, Date.parse(state.lastRenewCheckAt) + hour);
    if (state.status === 'renew_required' && path !== '/api/helper/status' && path !== '/api/helper/token/revoke') {
      if (this.timing.now() >= this.retryRenewAt) await this.refreshStatus();
      if ((await this.stateStore.read()).status === 'renew_required') throw new ApiError('TOKEN_RENEW_REQUIRED', 401);
    }
    if (state.status === 'renew_required' && path === '/api/helper/status' && this.timing.now() < this.retryRenewAt) {
      throw new ApiError('TOKEN_RENEW_REQUIRED', 401);
    }
    let token = await this.loadToken();
    for (let attempt = 0; attempt < 2; attempt++) {
      let response: ApiResponse<T>;
      try {
        response = await this.api.request<T>(path, { ...options, token });
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        if ((error.code === 'TOKEN_ROTATED' || error.code === 'TOKEN_INVALID') && attempt === 0) {
          const saved = await this.secrets.get('skills-token');
          if (isSkillsToken(saved)) { this.currentToken = saved; token = saved; continue; }
          if (error.code === 'TOKEN_ROTATED') throw error;
        }
        if (error.code === 'TOKEN_RENEW_REQUIRED') {
          const latest = await this.stateStore.read();
          await this.stateStore.write({ ...latest, status: 'renew_required', lastRenewCheckAt: new Date(this.timing.now()).toISOString() });
          this.retryRenewAt = this.timing.now() + hour;
          await this.showReminder();
        } else if (pairAgainCodes.has(error.code)) {
          await this.clearCredentials();
        }
        throw error;
      }
      const latest = await this.stateStore.read();
      await this.stateStore.write({ ...latest, idleLapseAt: new Date(this.timing.now() + 30 * day).toISOString() });
      // Handle rotation after the completed operation. A rotation error must never replay a successful mutation.
      if (response.headers.get('x-mdai-rotate') === '1' && path !== '/api/helper/token/rotate' && path !== '/api/helper/token/revoke') {
        await this.rotate(token);
      }
      return response;
    }
    throw new HelperError('TOKEN_REQUIRED', 'Run maddots-ai connect to connect this computer.');
  }

  private async rotate(oldToken: string): Promise<void> {
    if (this.rotation) return this.rotation;
    this.rotation = this.performRotation(oldToken);
    try { await this.rotation; } finally { this.rotation = undefined; }
  }

  private async performRotation(oldToken: string): Promise<void> {
    // Reuse token error handling for the rotation request only, never the original operation.
    let response: ApiResponse<unknown>;
    try { response = await this.request<unknown>('/api/helper/token/rotate', { method: 'POST', body: {} }); }
    catch (error) {
      if (error instanceof HelperError && ['API_CONNECTION_FAILED', 'API_TIMEOUT'].includes(error.code)) return;
      throw error;
    }
    const data = response.data;
    if (!isObject(data) || !isSkillsToken(data.token) || !date(data.renewBy) || !date(data.idleLapseAt)) {
      throw new HelperError('API_RESPONSE_INVALID', 'MadDots AI returned invalid token rotation information.');
    }
    const state = await this.stateStore.read();
    const predecessor = this.currentToken ?? oldToken;
    try {
      await this.secrets.set('skills-token', data.token, state.scopes);
      if (await this.secrets.get('skills-token') !== data.token) throw new Error();
    } catch {
      // The predecessor remains usable during its grace period. Retry on the next rotation header.
      this.currentToken = predecessor;
      return;
    }
    await this.stateStore.write({ ...state, renewBy: data.renewBy, idleLapseAt: data.idleLapseAt });
    this.currentToken = data.token;
  }

  async refreshStatus(onStatus?: (data: Record<string, unknown>) => void): Promise<HelperState> {
    const response = await this.request<unknown>('/api/helper/status');
    const data = response.data;
    if (!isObject(data) || !isObject(data.account) || !safeText(data.account.id, 128) || !safeText(data.account.name) ||
        !date(data.renewBy) || !date(data.idleLapseAt)) {
      throw new HelperError('API_RESPONSE_INVALID', 'MadDots AI returned invalid connection status.');
    }
    const scopes = parseScopes(data.scopes);
    if (this.secrets.storage === 'file' && scopes.includes('run_claim')) {
      throw new HelperError('FILE_RUNS_REFUSED', 'Running agents requires Keychain storage.');
    }
    const pending = toolIdentities(data.pending);
    const connections = parseConnections(data.connections);
    const connected = new Set(connections.map(identity));
    const previous = await this.stateStore.read();
    const state: HelperState = {
      ...previous, status: 'connected', account: { id: data.account.id, name: data.account.name },
      scopes, renewBy: data.renewBy, idleLapseAt: data.idleLapseAt,
      connections,
      proposedTools: previous.proposedTools ?? previous.pendingTools.map(({ tool, variant }) => ({ tool, variant })),
      pendingTools: previous.tools.filter(tool => pending.has(identity(tool)) && !connected.has(identity(tool))),
    };
    delete state.lastRenewCheckAt;
    if (this.currentToken && JSON.stringify({ account: state.account, pendingTools: state.pendingTools, connections }).includes(this.currentToken)) {
      throw new HelperError('API_RESPONSE_INVALID', 'MadDots AI returned invalid connection status.');
    }
    await this.stateStore.write(state);
    this.retryRenewAt = 0;
    await this.showReminder();
    onStatus?.(data);
    return this.stateStore.read();
  }

  async proposeTools(tools: DetectedTool[]): Promise<HelperState> {
    const state = await this.stateStore.read();
    const known = new Set(state.tools.map(identity));
    const connected = new Set((state.connections ?? []).map(identity));
    const waiting = new Set(state.pendingTools.map(identity));
    const previousProposals = state.proposedTools ?? state.pendingTools.map(({ tool, variant }) => ({ tool, variant }));
    const proposed = new Set(previousProposals.map(identity));
    const detected = tools.map(tool => ({...tool, models: [...tool.models]}));
    // Initial unticked tools remain untracked. Only later tools previously proposed may retry after expiry or decline.
    const fresh = detected.filter(tool => !connected.has(identity(tool)) && !waiting.has(identity(tool)) &&
      (!known.has(identity(tool)) || proposed.has(identity(tool))));
    const detectionTime = new Date(this.timing.now()).toISOString();
    if (!fresh.length) {
      const previousPending = new Set(state.pendingTools.map(identity));
      const updated: HelperState = { ...state, tools: detected, pendingTools: detected.filter(tool => previousPending.has(identity(tool))), proposedTools: previousProposals, lastDetectionAt: detectionTime };
      await this.stateStore.write(updated);
      return updated;
    }
    const response = await this.request<unknown>('/api/helper/tools', { method: 'POST', body: { tools: reportedTools(fresh) } });
    const data = response.data;
    if (!isObject(data)) throw new HelperError('API_RESPONSE_INVALID', 'MadDots AI returned invalid tool approval information.');
    const pending = toolIdentities(data.pending);
    const reportedConnections = parseConnections(data.connected);
    const latest = await this.stateStore.read();
    const previousPending = new Set(latest.pendingTools.map(identity));
    const connections = new Map((latest.connections ?? []).map(connection => [identity(connection), connection]));
    for (const connection of reportedConnections) connections.set(identity(connection), connection);
    const proposals = new Map(previousProposals.map(tool => [identity(tool), tool]));
    for (const { tool, variant } of fresh) proposals.set(identity({ tool, variant }), { tool, variant });
    const updated: HelperState = {
      ...latest, tools: detected, connections: [...connections.values()], proposedTools: [...proposals.values()],
      pendingTools: detected.filter(tool => !connections.has(identity(tool)) && (pending.has(identity(tool)) || previousPending.has(identity(tool)))),
      lastDetectionAt: detectionTime,
    };
    await this.stateStore.write(updated);
    return updated;
  }

  async status(): Promise<TokenStatus> {
    await this.showReminder();
    const state = await this.stateStore.read();
    const renewReminder = !!state.renewBy && this.timing.now() >= Date.parse(state.renewBy) - 14 * day;
    const syncAllowed = state.status === 'connected' && !(state.renewBy && this.timing.now() >= Date.parse(state.renewBy));
    const message = state.status === 'pair_again' || state.status === 'unpaired' ? 'Run maddots-ai connect to connect this computer.'
      : state.status === 'renew_required' || renewReminder ? 'Renew on ai.maddots.app.'
        : state.pendingTools.length ? 'Waiting for approval on ai.maddots.app.' : 'Connected to MadDots AI.';
    return { state, renewReminder, syncAllowed, message };
  }

  private async showReminder(): Promise<void> {
    const state = await this.stateStore.read();
    if (!this.remind || !state.renewBy || (state.status !== 'connected' && state.status !== 'renew_required') ||
        this.timing.now() < Date.parse(state.renewBy) - 14 * day ||
        (state.lastRenewDialogAt && this.timing.now() - Date.parse(state.lastRenewDialogAt) < day)) return;
    await this.stateStore.write({ ...state, lastRenewDialogAt: new Date(this.timing.now()).toISOString() });
    await this.remind('Renew on ai.maddots.app.').catch(() => {});
  }

  async clearCredentials(): Promise<void> {
    this.currentToken = undefined;
    await disconnectRunners().catch(() => {});
    const state = await this.stateStore.read();
    await this.stateStore.write({ ...state, status: 'pair_again', scopes: [], pendingTools: [], connections: [], proposedTools: [] });
    // Do not touch skills, lock.json, or backups. Attempt both removals even if one fails.
    const results = await Promise.allSettled([this.secrets.delete('skills-token'), this.secrets.delete('device-key')]);
    if (results.some(result => result.status === 'rejected')) {
      throw new HelperError('SECRET_DELETE_FAILED', 'The connection stopped, but a saved credential could not be removed. Retry uninstall.');
    }
  }

  async revoke(): Promise<void> {
    const token = await this.secrets.get('skills-token');
    try {
      if (isSkillsToken(token)) await this.api.request('/api/helper/token/revoke', { method: 'POST', body: {}, token });
    } finally { await this.clearCredentials(); }
  }
}
