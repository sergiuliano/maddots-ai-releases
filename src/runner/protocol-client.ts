import {randomBytes} from 'node:crypto';
import {ApiError, boundedJson, isObject, isSkillsToken} from '../api.js';
import {HelperError} from '../config.js';
import {RELEASE} from '../release-identity.js';
import {RUNNER_CONSTANTS, RUNNER_HEADERS, signRunnerRequest, type RunnerAccess, type RunnerClaimBody, type RunnerHeartbeatBody, type RunnerOutcomeBody, type RunnerTestResultBody} from '../shared/runner-protocol.js';
import type {RunnerDeviceKey} from './device-key.js';
import {MaddotsApi, type MadDotsOptions} from './maddots-api.js';

export type RunnerSkill = {skillId: string; name: string; version: number; settingsRevision: number; digest: string | null; hasCode: boolean};
export type RunnerAgent = {agentId: string; name: string; handle: string; status: 'active' | 'paused' | 'needs_owner'; model: string; provider: string | null; effort: string | null; accessWanted: RunnerAccess; maxRunMinutes: number; skills: RunnerSkill[]};
export type RunnerHeartbeat = {heartbeatSeconds: 15; agents: RunnerAgent[]; claimable: {runId: string; agentId: string; kind: 'assignment' | 'mention'}[]; stop: {runId: string; reason: string}[]};
export type RunnerClaim = {runId: string; kind: 'assignment' | 'mention'; agentId: string; cardId: string; boardId: string; commentId: string | null; expiresAt: string; model: string; provider: string | null; effort: string | null; maxRunMinutes: number; skills: (RunnerSkill & {digest: string})[]};
export type RunnerProtocolOptions = {endpoint: URL; token: () => Promise<string>; deviceKey: RunnerDeviceKey; fetcher?: typeof fetch; now?: () => number; env?: NodeJS.ProcessEnv; maddots?: MadDotsOptions};

export class RunnerProtocolClient {
  private offsetSeconds = 0;
  private readonly endpoint: URL;
  constructor(private readonly options: RunnerProtocolOptions) {
    const endpoint = new URL(options.endpoint.href);
    const loopback = endpoint.hostname === 'localhost' || endpoint.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(endpoint.hostname);
    const insecureLoopback = !RELEASE && endpoint.protocol === 'http:' && loopback && (options.env ?? process.env).MADDOTS_AI_ALLOW_INSECURE_LOOPBACK === '1';
    if (endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash ||
      endpoint.protocol !== 'https:' && !insecureLoopback ||
      RELEASE && endpoint.origin !== 'https://ai.maddots.app') throw new HelperError('CONFIG_INVALID', 'The runner service origin is invalid.');
    this.endpoint = endpoint;
  }
  private async request<T>(path: string, body: RunnerHeartbeatBody | RunnerClaimBody | RunnerOutcomeBody | RunnerTestResultBody): Promise<T> {
    // Fixed entry points below are the only paths allowed to carry runner credentials.
    if (!/^\/api\/runner\/(?:heartbeat|claims|test-result|runs\/[a-f0-9-]{36}\/outcome)$/.test(path)) throw new HelperError('API_ROUTE_INVALID', 'Use a signed runner route.');
    const payload = JSON.stringify(body), bodyBytes = Buffer.from(payload);
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.options.token();
      if (!isSkillsToken(token)) throw new HelperError('TOKEN_FOREIGN', 'The saved credential is not a skills token.');
      const now = () => Math.floor((this.options.now ?? Date.now)() / 1000);
      const timestamp = String(now() + this.offsetSeconds), nonce = randomBytes(RUNNER_CONSTANTS.nonceMinBytes).toString('base64url');
      const headers = new Headers({authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json',
        [RUNNER_HEADERS.deviceKey]: this.options.deviceKey.deviceKeyId, [RUNNER_HEADERS.timestamp]: timestamp, [RUNNER_HEADERS.nonce]: nonce,
        [RUNNER_HEADERS.signature]: signRunnerRequest({method: 'POST', path, body: bodyBytes, timestamp, nonce, deviceKeyId: this.options.deviceKey.deviceKeyId}, this.options.deviceKey.privateKey)});
      let response: Response;
      try {response = await (this.options.fetcher ?? fetch)(new URL(path, this.endpoint), {method: 'POST', body: payload, headers,
        redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(15_000)});}
      catch {throw new HelperError('API_CONNECTION_FAILED', 'Could not reach the runner service. Retry later.');}
      const serverTime = response.headers.get(RUNNER_HEADERS.serverTime);
      const hasTime = serverTime !== null && /^[1-9][0-9]*$/.test(serverTime) && Number.isSafeInteger(Number(serverTime));
      if (hasTime) this.offsetSeconds = Number(serverTime) - now();
      const envelope = await boundedJson(response, 1024 * 1024);
      if (!response.ok) {
        const code = isObject(envelope.error) && typeof envelope.error.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(envelope.error.code) ? envelope.error.code : 'API_FAILED';
        if (code === 'DEVICE_TIMESTAMP_STALE' && hasTime && attempt === 0) continue;
        throw new ApiError(code, response.status, response.headers);
      }
      if (!Object.hasOwn(envelope, 'data')) throw new HelperError('API_RESPONSE_INVALID', 'The runner response envelope is invalid.');
      return envelope.data as T;
    }
    throw new HelperError('API_FAILED', 'The runner request could not be completed.');
  }
  heartbeat(body: RunnerHeartbeatBody): Promise<RunnerHeartbeat> {return this.request('/api/runner/heartbeat', body);}
  async claim(body: RunnerClaimBody): Promise<{claim: RunnerClaim; api: MaddotsApi}> {
    const data = await this.request<RunnerClaim & {token: string}>('/api/runner/claims', body);
    // Remove the raw bearer from the received object before returning metadata.
    const api = new MaddotsApi(data.token, this.options.maddots);
    delete (data as Partial<typeof data>).token;
    return {claim: data, api};
  }
  outcome(runId: string, body: RunnerOutcomeBody): Promise<{recorded: true}> {return this.request(`/api/runner/runs/${runId}/outcome`, body);}
  testResult(body: RunnerTestResultBody): Promise<{state: 'on' | 'failed'}> {return this.request('/api/runner/test-result', body);}
}
