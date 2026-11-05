import {isValidAgentName} from './agent-name.js';

/** Server authority is separate from the device signature and local configuration.
 * startBy is at most issuedAt + 30 seconds, bounded by workloadDeadline and scope.
 * Activation and diagnostic workloads last at most 60 seconds from issuedAt;
 * refreshing authorization never extends the original workload deadline. */
export const RUNNER_AUTHORIZATION_START_WINDOW_MS = 30_000;
export const RUNNER_DIAGNOSTIC_WORKLOAD_MS = 60_000;
export type RunnerAuthorizationPurpose = 'claim' | 'activation' | 'diagnostic';
export type RunnerAcceptanceGrant = {
  scopeId: string; scopeVersion: number; toolKey: 'codex' | 'claude-code' | 'opencode';
  platform: 'linux'; expiresAt: string;
};
export type RunnerAuthorizationFields = {
  format: 1; keyId: string; purpose: RunnerAuthorizationPurpose; helperId: string; aiToolId: string;
  deviceKeyId: string; runId: string; generation: string; requestNonce: string; issuedAt: string;
  startBy: string; workloadDeadline: string; acceptanceGrant: RunnerAcceptanceGrant;
};
export type SignedRunnerAuthorization = RunnerAuthorizationFields & {signature: string};

/** Setup metadata is not an authorization to start a workload or enable runs. */
export const RUNNER_DEFINITION_WINDOW_MS = 30_000;
export type RunnerBootstrapAgent = {agentId: string; name: string; handle: string; model: string;
  provider: string | null; effort: string | null; accessWanted: 'full_access'};
export type RunnerDefinitionFields = {
  format: 1; keyId: string; purpose: 'agent-definition'; helperId: string; aiToolId: string; deviceKeyId: string;
  requestNonce: string; issuedAt: string; expiresAt: string; scopeId: string; scopeVersion: number;
  toolKey: RunnerAcceptanceGrant['toolKey']; platform: 'linux'; agents: RunnerBootstrapAgent[];
};
export type SignedRunnerDefinition = RunnerDefinitionFields & {signature: string};

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const isoDate = (value: unknown): value is string => typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' &&
  !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fields = ['acceptanceGrant', 'aiToolId', 'deviceKeyId', 'format', 'generation', 'helperId', 'issuedAt', 'keyId',
  'purpose', 'requestNonce', 'runId', 'startBy', 'workloadDeadline'];

/** Fixed field order and domain separation cover every identity, purpose and deadline. */
export function signedRunnerAuthorizationString(value: RunnerAuthorizationFields): string {
  if (!record(value) || Object.keys(value).filter(key => key !== 'signature').sort().join(',') !== fields.join(',') ||
    value.format !== 1 || typeof value.keyId !== 'string' || !/^[a-f0-9]{16}$/.test(value.keyId) ||
    !['claim', 'activation', 'diagnostic'].includes(value.purpose) ||
    ![value.helperId, value.aiToolId, value.deviceKeyId, value.runId].every(id => typeof id === 'string' && uuid.test(id)) ||
    typeof value.generation !== 'string' || !/^[a-f0-9]{64}$/.test(value.generation) ||
    typeof value.requestNonce !== 'string' || !/^[A-Za-z0-9_-]{22,86}$/.test(value.requestNonce) ||
    Buffer.from(value.requestNonce, 'base64url').toString('base64url') !== value.requestNonce ||
    !isoDate(value.issuedAt) || !isoDate(value.startBy) || !isoDate(value.workloadDeadline) ||
    !record(value.acceptanceGrant)) throw new Error('RUN_ACCEPTANCE_INVALID');
  const grant = value.acceptanceGrant;
  if (Object.keys(grant).sort().join(',') !== 'expiresAt,platform,scopeId,scopeVersion,toolKey' ||
    typeof grant.scopeId !== 'string' || !uuid.test(grant.scopeId) || !Number.isSafeInteger(grant.scopeVersion) || grant.scopeVersion < 1 ||
    !['codex', 'claude-code', 'opencode'].includes(grant.toolKey) || grant.platform !== 'linux' ||
    !isoDate(grant.expiresAt)) throw new Error('RUN_ACCEPTANCE_INVALID');
  const issued = Date.parse(value.issuedAt), start = Date.parse(value.startBy), deadline = Date.parse(value.workloadDeadline);
  if (start <= issued || start > issued + RUNNER_AUTHORIZATION_START_WINDOW_MS || start > deadline ||
    deadline > Date.parse(grant.expiresAt) || deadline <= issued ||
    value.purpose !== 'claim' && deadline > issued + RUNNER_DIAGNOSTIC_WORKLOAD_MS) throw new Error('RUN_ACCEPTANCE_INVALID');
  return ['maddots-ai-run-authorization-v1', value.keyId, value.purpose, value.helperId, value.aiToolId,
    value.deviceKeyId, value.runId, value.generation, value.requestNonce, value.issuedAt, value.startBy, value.workloadDeadline,
    grant.scopeId, String(grant.scopeVersion), grant.toolKey, grant.platform, grant.expiresAt].join('\n');
}

export function parseRunnerAuthorization(value: unknown): SignedRunnerAuthorization {
  if (!record(value) || Object.keys(value).sort().join(',') !== [...fields, 'signature'].sort().join(',') ||
    typeof value.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(value.signature) ||
    Buffer.from(value.signature, 'base64').toString('base64') !== value.signature) throw new Error('RUN_ACCEPTANCE_INVALID');
  signedRunnerAuthorizationString(value as SignedRunnerAuthorization);
  return value as SignedRunnerAuthorization;
}

const definitionFields = ['agents', 'aiToolId', 'deviceKeyId', 'expiresAt', 'format', 'helperId', 'issuedAt', 'keyId',
  'platform', 'purpose', 'requestNonce', 'scopeId', 'scopeVersion', 'toolKey'];
const bootstrapAgentFields = 'accessWanted,agentId,effort,handle,model,name,provider';
// Run/skill tokens have 43 base64url characters. Other MadDots token kinds
// retain the token scanner's suffix floor, without treating ordinary pm_ text as credentials.
export const RUNNER_DEFINITION_CREDENTIAL_PATTERN = '(?:pm_(?:api|oauth|refresh)_[A-Za-z0-9_-]{16,}|(?:pm_run_|mdai_skill_)[A-Za-z0-9_-]{43})';
const definitionCredential = new RegExp(RUNNER_DEFINITION_CREDENTIAL_PATTERN, 'u');
const metadata = (value: unknown, max: number): value is string => typeof value === 'string' &&
  [...value].length >= 1 && [...value].length <= max && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) &&
  !definitionCredential.test(value);

/** Separate domain and exact fields prevent setup metadata from becoming execution authority. */
export function signedRunnerDefinitionString(value: RunnerDefinitionFields): string {
  if (!record(value) || Object.keys(value).filter(key => key !== 'signature').sort().join(',') !== definitionFields.join(',') ||
    value.format !== 1 || typeof value.keyId !== 'string' || !/^[a-f0-9]{16}$/.test(value.keyId) ||
    value.purpose !== 'agent-definition' || value.platform !== 'linux' ||
    ![value.helperId, value.aiToolId, value.deviceKeyId, value.scopeId].every(id => typeof id === 'string' && uuid.test(id)) ||
    !Number.isSafeInteger(value.scopeVersion) || value.scopeVersion < 1 ||
    !['codex', 'claude-code', 'opencode'].includes(value.toolKey) ||
    typeof value.requestNonce !== 'string' || !/^[A-Za-z0-9_-]{22,86}$/.test(value.requestNonce) ||
    Buffer.from(value.requestNonce, 'base64url').toString('base64url') !== value.requestNonce ||
    !isoDate(value.issuedAt) || !isoDate(value.expiresAt) ||
    Date.parse(value.expiresAt) <= Date.parse(value.issuedAt) ||
    Date.parse(value.expiresAt) > Date.parse(value.issuedAt) + RUNNER_DEFINITION_WINDOW_MS ||
    !Array.isArray(value.agents) || value.agents.length !== 1) throw new Error('RUN_DEFINITION_INVALID');
  const agents = value.agents.map(agent => {
    if (!record(agent) || Object.keys(agent).sort().join(',') !== bootstrapAgentFields ||
      typeof agent.agentId !== 'string' || !uuid.test(agent.agentId) || !isValidAgentName(agent.name) || !metadata(agent.name, 40) ||
      typeof agent.handle !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(agent.handle) ||
      !metadata(agent.model, 200) || agent.provider !== null && !metadata(agent.provider, 200) ||
      agent.effort !== null && !metadata(agent.effort, 60) || agent.accessWanted !== 'full_access') {
      throw new Error('RUN_DEFINITION_INVALID');
    }
    return {agentId: agent.agentId, name: agent.name, handle: agent.handle, model: agent.model,
      provider: agent.provider, effort: agent.effort, accessWanted: agent.accessWanted};
  });
  return ['maddots-ai-agent-definition-v1', value.keyId, value.purpose, value.helperId, value.aiToolId,
    value.deviceKeyId, value.requestNonce, value.issuedAt, value.expiresAt, value.scopeId, String(value.scopeVersion),
    value.toolKey, value.platform, JSON.stringify(agents)].join('\n');
}

export function parseRunnerDefinition(value: unknown): SignedRunnerDefinition {
  if (!record(value) || Object.keys(value).sort().join(',') !== [...definitionFields, 'signature'].sort().join(',') ||
    typeof value.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(value.signature) ||
    Buffer.from(value.signature, 'base64').toString('base64') !== value.signature) throw new Error('RUN_DEFINITION_INVALID');
  signedRunnerDefinitionString(value as SignedRunnerDefinition);
  return value as SignedRunnerDefinition;
}
