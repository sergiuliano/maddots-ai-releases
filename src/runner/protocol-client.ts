import {randomBytes} from 'node:crypto';
import {ApiError, boundedJson, isObject, isSkillsToken} from '../api.js';
import {HelperError} from '../config.js';
import {RELEASE} from '../release-identity.js';
import {RUNNER_CONSTANTS, RUNNER_HEADERS, signRunnerRequest, type RunnerAccess, type RunnerAcceptanceCheckBody, type RunnerClaimBody, type RunnerHeartbeatBody, type RunnerOutcomeBody, type RunnerTestAcceptanceBody, type RunnerTestResultBody} from '../shared/runner-protocol.js';
import type {RunnerAuthorizationPurpose, SignedRunnerAuthorization, RunnerBootstrapAgent, RunnerDefinitionFields} from '../shared/runner-acceptance.js';
import {RunnerAcceptanceVerifier, verifiedAcceptance, type VerifiedAcceptance} from './acceptance.js';
import type {RunnerDeviceKey} from './device-key.js';
import {MaddotsApi, type MadDotsOptions} from './maddots-api.js';

export type RunnerSkill = {skillId: string; name: string; version: number; settingsRevision: number; digest: string | null; hasCode: boolean};
export type RunnerAgent = {agentId: string; name: string; handle: string; status: 'active' | 'paused' | 'needs_owner'; model: string; provider: string | null; effort: string | null; accessWanted: RunnerAccess; maxRunMinutes: number; skills: RunnerSkill[]};
export type RunnerHeartbeat = {heartbeatSeconds: 15; agents: RunnerAgent[]; claimable: {runId: string; agentId: string; kind: 'assignment' | 'mention'}[]; stop: {runId: string; reason: string}[]};
export type RunnerClaim = {runId: string; generation?: string; kind: 'assignment' | 'mention'; agentId: string; cardId: string; boardId: string; commentId: string | null; expiresAt: string; model: string; provider: string | null; effort: string | null; maxRunMinutes: number; skills: (RunnerSkill & {digest: string})[]};
export type RunnerProtocolOptions = {endpoint: URL; helperId: string; aiToolId: string; token: () => Promise<string>;
  deviceKey: RunnerDeviceKey; fetcher?: typeof fetch; now?: () => number; monotonicNow?: () => number; env?: NodeJS.ProcessEnv; maddots?: MadDotsOptions;
  acceptanceVerifier?: RunnerAcceptanceVerifier};
export {acceptanceAcknowledgment, acceptanceAuthorization, checkAcceptance, hasAcceptance, RunnerAcceptanceVerifier,
  type AcceptanceBinding, type AcceptanceOperationBinding, type VerifiedAcceptance} from './acceptance.js';

export class RunnerProtocolClient {
  private offsetMilliseconds = 0;
  private serverClock: {upperBoundAtSend: number; monotonicAtSend: number} | undefined;
  private readonly endpoint: URL;
  private readonly acceptanceVerifier: RunnerAcceptanceVerifier;
  constructor(private readonly options: RunnerProtocolOptions) {
    const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
    if (!uuid.test(options.helperId) || !uuid.test(options.aiToolId)) {
      throw new HelperError('CONFIG_INVALID', 'The runner requires the selected helper and tool identity.');
    }
    const endpoint = new URL(options.endpoint.href);
    const loopback = endpoint.hostname === 'localhost' || endpoint.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(endpoint.hostname);
    const insecureLoopback = !RELEASE && endpoint.protocol === 'http:' && loopback && (options.env ?? process.env).MADDOTS_AI_ALLOW_INSECURE_LOOPBACK === '1';
    if (endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash ||
      endpoint.protocol !== 'https:' && !insecureLoopback ||
      RELEASE && endpoint.origin !== 'https://ai.maddots.app') throw new HelperError('CONFIG_INVALID', 'The runner service origin is invalid.');
    this.endpoint = endpoint;
    this.acceptanceVerifier = !RELEASE && options.acceptanceVerifier ? options.acceptanceVerifier : new RunnerAcceptanceVerifier();
  }
  private async request<T>(path: string,
    body: RunnerHeartbeatBody | RunnerClaimBody | RunnerOutcomeBody | RunnerTestResultBody | RunnerAcceptanceCheckBody | RunnerTestAcceptanceBody | {toolKey: RunnerDefinitionFields['toolKey']},
    validate?: (data: T, nonce: string) => T): Promise<T> {
    // Fixed entry points below are the only paths allowed to carry runner credentials.
    if (!/^\/api\/runner\/(?:heartbeat|claims|test-result|test-acceptance|acceptance-check|agent-definitions|runs\/[a-f0-9-]{36}\/outcome)$/.test(path)) throw new HelperError('API_ROUTE_INVALID', 'Use a signed runner route.');
    const payload = JSON.stringify(body), bodyBytes = Buffer.from(payload);
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.options.token();
      if (!isSkillsToken(token)) throw new HelperError('TOKEN_FOREIGN', 'The saved credential is not a skills token.');
      const monotonicAtSend = this.monotonicNow(), sentAt = (this.options.now ?? Date.now)();
      const timestamp = String(Math.floor(this.now() / 1000)), nonce = randomBytes(RUNNER_CONSTANTS.nonceMinBytes).toString('base64url');
      const headers = new Headers({authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json',
        [RUNNER_HEADERS.deviceKey]: this.options.deviceKey.deviceKeyId, [RUNNER_HEADERS.timestamp]: timestamp, [RUNNER_HEADERS.nonce]: nonce,
        [RUNNER_HEADERS.signature]: signRunnerRequest({method: 'POST', path, body: bodyBytes, timestamp, nonce, deviceKeyId: this.options.deviceKey.deviceKeyId}, this.options.deviceKey.privateKey)});
      let response: Response;
      try {response = await (this.options.fetcher ?? fetch)(new URL(path, this.endpoint), {method: 'POST', body: payload, headers,
        redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(15_000)});}
      catch {throw new HelperError('API_CONNECTION_FAILED', 'Could not reach the runner service. Retry later.');}
      const serverTime = response.headers.get(RUNNER_HEADERS.serverTime);
      const hasTime = serverTime !== null && /^[1-9][0-9]*$/.test(serverTime) && Number.isSafeInteger((Number(serverTime) + 1) * 1000);
      if (hasTime) {
        // The header is stamped at request entry and truncated to seconds. Anchor
        // its upper bound at send time so neither transit nor body delay buys time.
        const upperBoundAtSend = (Number(serverTime) + 1) * 1000;
        this.offsetMilliseconds = upperBoundAtSend - sentAt;
        this.serverClock = {upperBoundAtSend, monotonicAtSend};
      }
      const envelope = await boundedJson(response, 1024 * 1024);
      if (!response.ok) {
        const code = isObject(envelope.error) && typeof envelope.error.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(envelope.error.code) ? envelope.error.code : 'API_FAILED';
        if (code === 'DEVICE_TIMESTAMP_STALE' && hasTime && attempt === 0) continue;
        throw new ApiError(code, response.status, response.headers);
      }
      if (!Object.hasOwn(envelope, 'data')) throw new HelperError('API_RESPONSE_INVALID', 'The runner response envelope is invalid.');
      return validate ? validate(envelope.data as T, nonce) : envelope.data as T;
    }
    throw new HelperError('API_FAILED', 'The runner request could not be completed.');
  }
  heartbeat(body: RunnerHeartbeatBody): Promise<RunnerHeartbeat> {return this.request('/api/runner/heartbeat', body);}
  async agentDefinitions(toolKey: RunnerDefinitionFields['toolKey']): Promise<RunnerBootstrapAgent[]> {
    return this.request<unknown>('/api/runner/agent-definitions', {toolKey}, (data, nonce) => {
      if (!isObject(data) || Object.keys(data).join(',') !== 'definition') throw new HelperError('RUN_ACCEPTANCE_INVALID', 'The server definition response is invalid.');
      const definition = this.acceptanceVerifier.verifyDefinition(data.definition), now = this.now();
      if (definition.requestNonce !== nonce || definition.helperId !== this.options.helperId || definition.aiToolId !== this.options.aiToolId ||
        definition.deviceKeyId !== this.options.deviceKey.deviceKeyId || definition.toolKey !== toolKey || !Number.isFinite(now) ||
        Date.parse(definition.issuedAt) > now + 1000 || Date.parse(definition.expiresAt) <= now) {
        throw new HelperError('RUN_ACCEPTANCE_INVALID', 'The server definition does not match this request.');
      }
      // Discard the signed envelope. These values configure local setup only.
      return definition.agents;
    }) as Promise<RunnerBootstrapAgent[]>;
  }
  private monotonicNow(): number {return (this.options.monotonicNow ?? (() => performance.now()))();}
  private now(): number {
    const wallTime = (this.options.now ?? Date.now)() + this.offsetMilliseconds;
    if (!this.serverClock) return wallTime;
    const elapsed = this.monotonicNow() - this.serverClock.monotonicAtSend;
    return Number.isFinite(elapsed) && elapsed >= 0 ? Math.max(wallTime, this.serverClock.upperBoundAtSend + elapsed) : NaN;
  }
  private authorization(value: unknown, nonce: string,
    expected: {purpose: RunnerAuthorizationPurpose; runId?: string; generation?: string}): SignedRunnerAuthorization {
    const authorization = this.acceptanceVerifier.verify(value), now = this.now();
    if (authorization.requestNonce !== nonce || authorization.deviceKeyId !== this.options.deviceKey.deviceKeyId ||
      authorization.helperId !== this.options.helperId || authorization.aiToolId !== this.options.aiToolId ||
      authorization.purpose !== expected.purpose || expected.runId !== undefined && authorization.runId !== expected.runId ||
      expected.generation !== undefined && authorization.generation !== expected.generation || !Number.isFinite(now) ||
      Date.parse(authorization.issuedAt) > now + 1000 || Date.parse(authorization.startBy) <= now ||
      Date.parse(authorization.workloadDeadline) <= now || Date.parse(authorization.acceptanceGrant.expiresAt) <= now) {
      throw new HelperError('RUN_ACCEPTANCE_INVALID', 'The server acceptance authorization does not match this request.');
    }
    return authorization;
  }
  private acceptance(authorization: SignedRunnerAuthorization): VerifiedAcceptance {
    const {runId, generation, purpose, workloadDeadline, acceptanceGrant: {scopeId, scopeVersion, toolKey}} = authorization;
    let previous = authorization;
    return verifiedAcceptance(authorization, this.acceptanceVerifier, async () => {
      const reply = await this.request<{authorization: SignedRunnerAuthorization}>('/api/runner/acceptance-check',
        {runId, generation, purpose, scopeId, scopeVersion, toolKey, workloadDeadline, authorization: previous},
        (data, nonce) => ({authorization: this.authorization(data?.authorization, nonce, {runId, generation, purpose})}));
      previous = reply.authorization;
      return reply.authorization;
    }, () => this.now(), () => this.monotonicNow());
  }
  async testAcceptance(body: RunnerTestAcceptanceBody): Promise<VerifiedAcceptance> {
    const reply = await this.request<{authorization: SignedRunnerAuthorization}>('/api/runner/test-acceptance', body,
      (data, nonce) => ({authorization: this.authorization(data?.authorization, nonce, {purpose: body.purpose})}));
    return this.acceptance(reply.authorization);
  }
  async claim(body: RunnerClaimBody): Promise<{claim: RunnerClaim; api: MaddotsApi; acceptance?: VerifiedAcceptance}> {
    let acceptance: VerifiedAcceptance | undefined;
    const data = await this.request<RunnerClaim & {token: string; authorization?: SignedRunnerAuthorization}>('/api/runner/claims', body,
      (data, nonce) => {
        if (data.authorization !== undefined) {
          if (data.runId !== body.runId || typeof data.generation !== 'string') throw new HelperError('RUN_ACCEPTANCE_INVALID', 'The accepted run binding is invalid.');
          const authorization = this.authorization(data.authorization, nonce, {purpose: 'claim', runId: body.runId, generation: data.generation});
          if (Date.parse(authorization.workloadDeadline) > Date.parse(data.expiresAt) || !Number.isFinite(Date.parse(data.expiresAt))) {
            throw new HelperError('RUN_ACCEPTANCE_INVALID', 'The signed workload deadline outlives the claimed run token.');
          }
          acceptance = this.acceptance(authorization);
        }
        return data;
      });
    // Remove the raw bearer from the received object before returning metadata.
    const api = new MaddotsApi(data.token, this.options.maddots);
    delete (data as Partial<typeof data>).token;
    delete data.authorization;
    return {claim: data, api, ...(acceptance ? {acceptance} : {})};
  }
  outcome(runId: string, body: RunnerOutcomeBody): Promise<{recorded: true}> {return this.request(`/api/runner/runs/${runId}/outcome`, body);}
  testResult(body: RunnerTestResultBody): Promise<{state: 'on' | 'failed'}> {return this.request('/api/runner/test-result', body);}
}
