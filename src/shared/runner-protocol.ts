import {createHash, createPublicKey, sign, verify, type KeyObject} from 'node:crypto';
import contract from './runner-contract.json' with {type: 'json'};
import {AGENT_NAME_SCHEMA} from './agent-name.js';
import {RUNNER_DEFINITION_CREDENTIAL_PATTERN, type RunnerAcceptanceGrant, type RunnerAuthorizationPurpose, type SignedRunnerAuthorization} from './runner-acceptance.js';

export const RUNNER_CONSTANTS = contract['x-constants'].limits;
export const RUN_TOKEN_POLICY = contract['x-run-token-policy'];
export const RUN_TOKEN_FINAL_REFUSAL_CODES: readonly string[] = contract['x-constants'].runTokenFinalRefusalCodes;
export const RUN_TOKEN_PREFIX = contract['x-constants'].tokenPrefixes.run;
export const RUN_TOKEN_ERROR_CODES = contract['x-constants'].errorCodes;
export const RUNNER_HEADERS = {deviceKey: 'x-mdai-device-key', timestamp: 'x-mdai-device-timestamp', nonce: 'x-mdai-device-nonce', signature: 'x-mdai-device-signature', serverTime: 'x-mdai-server-time'} as const;
export const RUNNER_ERROR_CODES = ['DEVICE_HEADERS', 'DEVICE_KEY_UNKNOWN', 'DEVICE_KEY_REVOKED', 'DEVICE_SIGNATURE_INVALID', 'DEVICE_TIMESTAMP_STALE', 'DEVICE_NONCE_REPLAYED', 'DEVICE_PROOF_INVALID', 'DEVICE_KEY_EXISTS', 'RUNS_NOT_GRANTED', 'RUNS_NOT_ENABLED', 'RUNS_NOT_TESTING', 'RUNS_NOT_OFFERED', 'TOKEN_IN_FILE', 'TOOL_EXCLUDED', 'RUN_NOT_CLAIMABLE', 'RUN_ALREADY_CLAIMED', 'RUN_FINISHED', 'RUNNER_RATE_LIMIT'] as const;
export type RunnerAccess = 'folder_only' | 'full_access';
export type RunnerDeviceKeyBody = {aiToolId: string; publicKey: string; proof: string};
/** Terminal evidence can reconcile a recorded result, never authorize a workload or enable runs. */
export type RunnerActivationAcknowledgment = {purpose: 'activation-result'; deviceKeyId: string; runId: string;
  generation: string; scopeId: string; scopeVersion: number};
export type RunnerTestResultBody = {ok: boolean; code: string | null; toolVersion: string | null;
  authorization?: SignedRunnerAuthorization; acknowledgment?: RunnerActivationAcknowledgment};
export type RunnerAcceptanceCheckBody = {runId: string; generation: string; purpose: RunnerAuthorizationPurpose;
  scopeId: string; scopeVersion: number; toolKey: RunnerAcceptanceGrant['toolKey']; workloadDeadline: string; authorization: SignedRunnerAuthorization};
export type RunnerAgentDefinitionsBody = {toolKey: RunnerAcceptanceGrant['toolKey']};
export type RunnerTestAcceptanceBody = {purpose: 'activation'; agents: {agentId: string; access: RunnerAccess}[]} | {purpose: 'diagnostic'};
export type RunnerHeartbeatBody = {helperVersion: string; toolVersion: string | null; agents: {agentId: string; access: RunnerAccess}[]; running: {runId: string; phase: 'preparing' | 'running' | 'posting'}[]};
export type RunnerClaimBody = {runId: string; access: RunnerAccess; toolVersion: string | null};
export type RunnerOutcomeBody = {outcome: 'done' | 'failed' | 'stopped' | 'not_delivered'; code: string | null; access: RunnerAccess; toolVersion: string | null; model: string; provider: string | null; skills: {skillId: string; version: number; settingsRevision: number; digest: string}[]; posted: {comments: number; attachments: number; filesSkipped: number; moved: boolean; moveSkipped: null | 'person_moved' | 'failed'}; startedAt: string; finishedAt: string};

const object = (properties: Record<string, unknown>) => ({type: 'object', additionalProperties: false, properties, required: Object.keys(properties)});
// Versions remain compact identifiers; model/provider metadata follows the contract's model domain.
const text = {type: 'string', minLength: 1, maxLength: 200, pattern: '^(?!.*(?:pm_|mdai_skill_))[A-Za-z0-9][A-Za-z0-9._+:/-]*$'};
const modelText = {type: 'string', minLength: 1, maxLength: 200, pattern: '^(?!.*(?:pm_|mdai_skill_))[^\\u0000-\\u001f\\u007f]+$'};
const uuid = {type: 'string', format: 'uuid'};
const nullable = (schema: object) => ({anyOf: [schema, {type: 'null'}]});
const access = {type: 'string', enum: ['folder_only', 'full_access']};
const code = nullable({type: 'string', minLength: 1, maxLength: 60, pattern: '^(?!.*(?:pm_|mdai_skill_))[A-Za-z0-9_]+$'});
const count = {type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER};
const version = {type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER};
const digest = {type: 'string', pattern: '^[a-f0-9]{64}$'};
export const runnerDeviceKeySchema = object({aiToolId: uuid, publicKey: {type: 'string', pattern: '^[A-Za-z0-9_-]{43}$'}, proof: {type: 'string', pattern: '^[A-Za-z0-9_-]{86}$'}});
const time = {type: 'string', format: 'date-time'};
const purpose = {enum: ['claim', 'activation', 'diagnostic']};
const acceptanceToolKey = {enum: ['codex', 'claude-code', 'opencode']};
export const runnerAgentDefinitionsSchema = object({toolKey: acceptanceToolKey});
const definitionMetadata = {...modelText, pattern: `^(?!.*${RUNNER_DEFINITION_CREDENTIAL_PATTERN})[^\\u0000-\\u001f\\u007f]+$`};
export const runnerBootstrapAgentSchema = object({agentId: uuid, name: AGENT_NAME_SCHEMA,
  handle: {type: 'string', pattern: '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$'}, model: definitionMetadata,
  provider: nullable(definitionMetadata), effort: nullable({...definitionMetadata, maxLength: 60}), accessWanted: {const: 'full_access'}});
export const runnerDefinitionSchema = object({format: {const: 1}, keyId: {type: 'string', pattern: '^[a-f0-9]{16}$'},
  purpose: {const: 'agent-definition'}, helperId: uuid, aiToolId: uuid, deviceKeyId: uuid,
  requestNonce: {type: 'string', pattern: '^[A-Za-z0-9_-]{22,86}$'}, issuedAt: time, expiresAt: time,
  scopeId: uuid, scopeVersion: version, toolKey: acceptanceToolKey, platform: {const: 'linux'},
  agents: {type: 'array', minItems: 1, maxItems: 1, items: runnerBootstrapAgentSchema},
  signature: {type: 'string', pattern: '^[A-Za-z0-9+/]{86}==$'}});
export const runnerAcceptanceGrantSchema = object({scopeId: uuid, scopeVersion: version, toolKey: acceptanceToolKey,
  platform: {const: 'linux'}, expiresAt: time});
export const runnerAuthorizationSchema = object({format: {const: 1}, keyId: {type: 'string', pattern: '^[a-f0-9]{16}$'}, purpose,
  helperId: uuid, aiToolId: uuid, deviceKeyId: uuid, runId: uuid, generation: digest,
  requestNonce: {type: 'string', pattern: '^[A-Za-z0-9_-]{22,86}$'}, issuedAt: time, startBy: time, workloadDeadline: time,
  acceptanceGrant: runnerAcceptanceGrantSchema, signature: {type: 'string', pattern: '^[A-Za-z0-9+/]{86}==$'}});
export const runnerAcceptanceCheckSchema = object({runId: uuid, generation: digest, purpose, scopeId: uuid,
  scopeVersion: version, toolKey: acceptanceToolKey, workloadDeadline: time, authorization: runnerAuthorizationSchema});
export const runnerTestAcceptanceSchema = {oneOf: [object({purpose: {const: 'activation'},
  agents: {type: 'array', minItems: 1, maxItems: 200, items: object({agentId: uuid, access})}}), object({purpose: {const: 'diagnostic'}})]};
export const runnerActivationAcknowledgmentSchema = object({purpose: {const: 'activation-result'}, deviceKeyId: uuid,
  runId: uuid, generation: digest, scopeId: uuid, scopeVersion: version});
export const runnerTestResultSchema = {...object({ok: {type: 'boolean'}, code, toolVersion: nullable(text),
  authorization: runnerAuthorizationSchema, acknowledgment: runnerActivationAcknowledgmentSchema}), required: ['ok', 'code', 'toolVersion']};
export const runnerHeartbeatSchema = object({helperVersion: text, toolVersion: nullable(text), agents: {type: 'array', maxItems: 200, items: object({agentId: uuid, access})}, running: {type: 'array', maxItems: 20, items: object({runId: uuid, phase: {enum: ['preparing', 'running', 'posting']}})}});
export const runnerClaimSchema = object({runId: uuid, access, toolVersion: nullable(text)});
export const runnerOutcomeSchema = object({outcome: {enum: ['done', 'failed', 'stopped', 'not_delivered']}, code, access, toolVersion: nullable(text), model: modelText, provider: nullable(modelText), skills: {type: 'array', maxItems: 50, items: object({skillId: uuid, version, settingsRevision: count, digest})}, posted: object({comments: count, attachments: count, filesSkipped: count, moved: {type: 'boolean'}, moveSkipped: {enum: [null, 'person_moved', 'failed']}}), startedAt: {type: 'string', format: 'date-time'}, finishedAt: {type: 'string', format: 'date-time'}});

export function canonicalBase64url(value: string, bytes?: number): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return (bytes === undefined || decoded.length === bytes) && decoded.toString('base64url') === value;
}
export type RunnerSignedRequest = {method: string; path: string; body: Uint8Array; timestamp: string; nonce: string; deviceKeyId: string};
export function canonicalRunnerRequest(input: RunnerSignedRequest): string {
  return ['maddots-ai-runner-v1', input.method, input.path, createHash('sha256').update(input.body).digest('hex'), input.timestamp, input.nonce, input.deviceKeyId].join('\n');
}
export function signRunnerRequest(input: RunnerSignedRequest, privateKey: KeyObject): string {
  return sign(null, Buffer.from(canonicalRunnerRequest(input), 'utf8'), privateKey).toString('base64url');
}
export function runnerPublicKey(publicKey: string): KeyObject {
  if (!canonicalBase64url(publicKey, 32)) throw new Error('Invalid runner public key');
  return createPublicKey({key: {kty: 'OKP', crv: 'Ed25519', x: publicKey}, format: 'jwk'});
}
export function verifyRunnerRequest(input: RunnerSignedRequest, signature: string, publicKey: string): boolean {
  if (!canonicalBase64url(signature, 64)) return false;
  try {return verify(null, Buffer.from(canonicalRunnerRequest(input), 'utf8'), runnerPublicKey(publicKey), Buffer.from(signature, 'base64url'));} catch {return false;}
}
export function deviceKeyProof(helperId: string, aiToolId: string, publicKey: string): string {
  return ['maddots-ai-device-key-v1', helperId, aiToolId, publicKey].join('\n');
}
export function verifyDeviceKeyProof(helperId: string, aiToolId: string, publicKey: string, proof: string): boolean {
  if (!canonicalBase64url(proof, 64)) return false;
  try {return verify(null, Buffer.from(deviceKeyProof(helperId, aiToolId, publicKey), 'utf8'), runnerPublicKey(publicKey), Buffer.from(proof, 'base64url'));} catch {return false;}
}
export function deviceKeyFingerprint(publicKey: string): string {
  if (!canonicalBase64url(publicKey, 32)) throw new Error('Invalid runner public key');
  return createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex').slice(0, 16);
}
