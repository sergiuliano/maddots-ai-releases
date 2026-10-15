import { ApiClient, ApiError, isObject, isSkillsToken, type Scope } from './api.js';
import { HelperError, clock, type Timing } from './config.js';
import type { DetectedTool } from './detect.js';

/** Protocol OS names; kept local to the reviewed helper package. */
export type PairingOS = 'macos' | 'linux' | 'windows';
export function helperOs(platform: string = process.platform): PairingOS {
  return platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : 'linux';
}
export type PairingReport = { helperVersion: string; computerName: string; os: PairingOS; tools: DetectedTool[] };
export type PendingPairing = { status: 'pending'; userCode: string; connectUrl: string; expiresAt: string; expiresIn: number };
export type Connection = { id: string; tool: string; variant: string };
export type PairingCredential = {
  token: string;
  helperId: string;
  account: { id: string; name: string };
  scopes: Scope[];
  renewBy: string;
  idleLapseAt: string;
  connections: Connection[];
};
export const pairingScopes: Scope[] = ['sync', 'import_upload', 'proposal_upload'];

export function safeText(value: unknown, max = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    Array.from(value).every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127);
}

export function parseScopes(value: unknown, pairing = false): Scope[] {
  const allowed: Scope[] = pairing ? pairingScopes : [...pairingScopes, 'run_claim'];
  if (!Array.isArray(value) || !value.length || value.length > allowed.length ||
      value.some(scope => !allowed.includes(scope as Scope)) || new Set(value).size !== value.length ||
      (pairing && value.length !== pairingScopes.length)) {
    throw new HelperError('API_RESPONSE_INVALID', 'MadDots AI returned invalid connection permissions.');
  }
  return value as Scope[];
}

export function parseConnections(value: unknown): Connection[] {
  if (!Array.isArray(value) || value.length > 40) throw new HelperError('API_RESPONSE_INVALID', 'MadDots AI returned invalid tool connections.');
  return value.map(connection => {
    if (!isObject(connection) || !safeText(connection.id, 128) || !safeText(connection.tool, 80) || !safeText(connection.variant, 80)) {
      throw new HelperError('API_RESPONSE_INVALID', 'MadDots AI returned invalid tool connections.');
    }
    return { id: connection.id, tool: connection.tool, variant: connection.variant };
  });
}

/** Project the inventory to protocol fields, never upload local executable paths. */
export function reportedTools(tools: DetectedTool[]): DetectedTool[] {
  return tools.map(({ tool, variant, version, models, syncOnly }) => ({ tool, variant, version, models: [...models], syncOnly }));
}

function parseCredential(data: unknown, now: number, deviceCode: string): PairingCredential {
  if (!isObject(data) || data.status !== 'connected' || !isSkillsToken(data.token) || !safeText(data.helperId, 128) ||
      !isObject(data.account) || !safeText(data.account.id, 128) || !safeText(data.account.name, 256) ||
      typeof data.renewBy !== 'string' || !Number.isFinite(Date.parse(data.renewBy)) || Date.parse(data.renewBy) <= now ||
      typeof data.idleLapseAt !== 'string' || !Number.isFinite(Date.parse(data.idleLapseAt)) || Date.parse(data.idleLapseAt) <= now) {
    throw new HelperError('PAIRING_RESPONSE_INVALID', 'MadDots AI returned invalid account connection information.');
  }
  const account = { id: data.account.id, name: data.account.name };
  const connections = parseConnections(data.connections);
  if (JSON.stringify({ account, helperId: data.helperId, connections }).includes(deviceCode) ||
      JSON.stringify({ account, helperId: data.helperId, connections }).includes(data.token)) {
    throw new HelperError('PAIRING_RESPONSE_INVALID', 'MadDots AI returned invalid account connection information.');
  }
  return { token: data.token, helperId: data.helperId, account, scopes: parseScopes(data.scopes, true), renewBy: data.renewBy, idleLapseAt: data.idleLapseAt, connections };
}

export class PairingFlow {
  private readonly controller = new AbortController();
  private started = false;
  private pending?: PendingPairing;
  private completion?: Promise<PairingCredential>;
  constructor(private readonly api: ApiClient, private readonly timing: Timing = clock) {}
  cancel(): void { this.controller.abort(); }
  snapshot(): PendingPairing | undefined { return this.pending && { ...this.pending }; }

  async start(report: PairingReport): Promise<PendingPairing> {
    if (this.started) throw new HelperError('PAIRING_IN_PROGRESS', 'This account connection has already started.');
    this.started = true;
    this.checkCancelled();
    const response = await this.api.request<unknown>('/api/helper/pairings', {
      method: 'POST', body: { ...report, tools: reportedTools(report.tools) }, signal: this.controller.signal,
    });
    const data = response.data;
    const now = this.timing.now();
    if (!isObject(data) || !safeText(data.deviceCode, 43) || !/^[A-Za-z0-9_-]{43}$/.test(data.deviceCode) ||
        !safeText(data.userCode, 8) || !/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(data.userCode) ||
        data.connectUrl !== new URL('/tools/connect', this.api.endpoint.origin).href ||
        typeof data.expiresAt !== 'string' || !Number.isFinite(Date.parse(data.expiresAt)) || Date.parse(data.expiresAt) <= now ||
        data.expiresIn !== 300 || typeof data.interval !== 'number' || !Number.isInteger(data.interval) || data.interval < 3 || data.interval > 30) {
      throw new HelperError('PAIRING_RESPONSE_INVALID', 'MadDots AI returned invalid approval instructions.');
    }
    const deadline = Math.min(Date.parse(data.expiresAt), now + 300_000);
    this.pending = { status: 'pending', userCode: data.userCode, connectUrl: data.connectUrl, expiresAt: new Date(deadline).toISOString(), expiresIn: Math.ceil((deadline - now) / 1000) };
    this.completion = this.poll(data.deviceCode, deadline, data.interval * 1000);
    void this.completion.catch(() => {});
    return this.snapshot()!;
  }

  async wait(): Promise<PairingCredential> {
    if (!this.completion) throw new HelperError('PAIRING_NOT_STARTED', 'Start connecting this computer first.');
    return this.completion;
  }

  private checkCancelled(): void {
    if (this.controller.signal.aborted) throw new HelperError('PAIRING_CANCELLED', 'Account connection was cancelled.');
  }

  private async poll(deviceCode: string, deadline: number, interval: number): Promise<PairingCredential> {
    let delay = interval;
    while (this.timing.now() < deadline) {
      try { await this.timing.sleep(Math.min(delay, deadline - this.timing.now()), this.controller.signal); }
      catch { this.checkCancelled(); throw new HelperError('PAIRING_CONNECTION_FAILED', 'Account connection was interrupted. Run maddots-ai connect again.'); }
      this.checkCancelled();
      if (this.timing.now() >= deadline) break;
      let data: unknown;
      try {
        data = (await this.api.request<unknown>('/api/helper/pairings/poll', {
          method: 'POST', body: { deviceCode }, signal: this.controller.signal,
        })).data;
      } catch (error) {
        this.checkCancelled();
        if (error instanceof ApiError && error.status === 429) {
          const retry = error.headers.get('retry-after') ?? '';
          const retryMs = /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - this.timing.now();
          delay = Math.max(interval, Number.isFinite(retryMs) && retryMs > 0 ? Math.min(retryMs, 300_000) : interval);
          continue;
        }
        throw error;
      }
      this.checkCancelled();
      if (this.timing.now() >= deadline) break;
      if (isObject(data) && data.status === 'pending') { delay = interval; continue; }
      return parseCredential(data, this.timing.now(), deviceCode);
    }
    throw new HelperError('PAIRING_EXPIRED', 'The approval code expired. Run maddots-ai connect for a new code.');
  }
}
