import {createHash, createPublicKey, verify, type KeyObject} from 'node:crypto';
import {parseRunnerAuthorization, signedRunnerAuthorizationString, parseRunnerDefinition, signedRunnerDefinitionString,
  type RunnerAuthorizationPurpose, type SignedRunnerAuthorization, type SignedRunnerDefinition} from '../shared/runner-acceptance.js';
import type {RunnerActivationAcknowledgment} from '../shared/runner-protocol.js';
import {RELEASE_BUILD_KEYS} from '../build-keys.js';
import {HelperError} from '../config.js';
import {RELEASE} from '../release-identity.js';
import type {BuildPublicKey} from '../verify.js';

export type AcceptanceBinding = {toolKey: string; platform: NodeJS.Platform; runId?: string; generation?: string;
  purpose?: RunnerAuthorizationPurpose; helperId?: string; aiToolId?: string; deviceKeyId?: string};
export type AcceptanceOperationBinding = AcceptanceBinding & {runId: string; generation: string; purpose: RunnerAuthorizationPurpose};
export type VerifiedAcceptance = Readonly<{runId: string; generation: string; purpose: RunnerAuthorizationPurpose;
  expiresAt: string; startBy: string; workloadDeadline: string}>;
type Evidence = {authorization: SignedRunnerAuthorization; verifier: RunnerAcceptanceVerifier;
  refresh: () => Promise<SignedRunnerAuthorization>; now: () => number; monotonicNow: () => number;
  deadlines: {startBy: number; workload: number; scope: number}; lastMonotonic: number; refused: boolean; refreshing: boolean};
const verified = new WeakMap<VerifiedAcceptance, Evidence>();
const refused = () => new HelperError('RUN_ACCEPTANCE_INVALID', 'The server acceptance authorization is unavailable or no longer valid.');

/** Abandoning an in-flight release check permanently poisons its receipt. */
export function invalidateAcceptance(value: VerifiedAcceptance): void {
  const evidence = verified.get(value);
  if (evidence) evidence.refused = true;
}

/** Release artifacts use only compiled trust roots. Environment and config never add keys. */
export class RunnerAcceptanceVerifier {
  readonly #keys = new Map<string, KeyObject>();
  constructor(options: {keys?: readonly BuildPublicKey[]; release?: true} = {}) {
    const keys = !RELEASE && !options.release && options.keys ? options.keys : RELEASE_BUILD_KEYS.map(publicKey =>
      ({publicKey, keyId: createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex').slice(0, 16)}));
    for (const key of keys) {
      const raw = Buffer.from(key.publicKey, 'base64');
      if (raw.length !== 32 || raw.toString('base64') !== key.publicKey ||
        createHash('sha256').update(raw).digest('hex').slice(0, 16) !== key.keyId || this.#keys.has(key.keyId)) throw refused();
      this.#keys.set(key.keyId, createPublicKey({key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), type: 'spki', format: 'der'}));
    }
  }
  verify(value: unknown): SignedRunnerAuthorization {
    let authorization: SignedRunnerAuthorization;
    try {authorization = parseRunnerAuthorization(value);} catch {throw refused();}
    const key = this.#keys.get(authorization.keyId);
    if (!key || !verify(null, Buffer.from(signedRunnerAuthorizationString(authorization)), key, Buffer.from(authorization.signature, 'base64'))) {
      throw new HelperError('RUN_ACCEPTANCE_SIGNATURE_INVALID', 'The server acceptance signature is invalid.');
    }
    return Object.freeze({...authorization, acceptanceGrant: Object.freeze({...authorization.acceptanceGrant})});
  }
  /** Definition signatures authenticate metadata, never enter the execution receipt registry. */
  verifyDefinition(value: unknown): SignedRunnerDefinition {
    let definition: SignedRunnerDefinition;
    try {definition = parseRunnerDefinition(value);} catch {throw refused();}
    const key = this.#keys.get(definition.keyId);
    if (!key || !verify(null, Buffer.from(signedRunnerDefinitionString(definition)), key, Buffer.from(definition.signature, 'base64'))) {
      throw new HelperError('RUN_ACCEPTANCE_SIGNATURE_INVALID', 'The server definition signature is invalid.');
    }
    return structuredClone(definition);
  }
}

function fresh(evidence: Evidence, admission: boolean): boolean {
  const monotonic = evidence.monotonicNow(), now = evidence.now(), authorization = evidence.authorization;
  if (!Number.isFinite(now) || !Number.isFinite(monotonic) || monotonic < evidence.lastMonotonic) return false;
  evidence.lastMonotonic = monotonic;
  // Signed startBy is at most issuedAt + 30 seconds, bounded by workload/scope;
  // activation and diagnostics have at most 60 seconds from issuedAt.
  // Calibration and refreshed signatures may only shorten local deadlines.
  // Wall-clock rollback cannot restore elapsed receipt authority.
  evidence.deadlines.startBy = Math.min(evidence.deadlines.startBy, monotonic + Date.parse(authorization.startBy) - now);
  evidence.deadlines.workload = Math.min(evidence.deadlines.workload, monotonic + Date.parse(authorization.workloadDeadline) - now);
  evidence.deadlines.scope = Math.min(evidence.deadlines.scope, monotonic + Date.parse(authorization.acceptanceGrant.expiresAt) - now);
  // One second accommodates the signed-request protocol's whole-second clock correction.
  return Date.parse(authorization.issuedAt) <= now + 1000 && evidence.deadlines.scope > monotonic &&
    evidence.deadlines.workload > monotonic && (!admission || evidence.deadlines.startBy > monotonic);
}

/** This object is an in-memory handle, never a restorable grant or execution permit. */
export function verifiedAcceptance(value: SignedRunnerAuthorization, verifier: RunnerAcceptanceVerifier,
  refresh: () => Promise<SignedRunnerAuthorization>, now: () => number, monotonicNow: () => number = () => performance.now()): VerifiedAcceptance {
  const authorization = verifier.verify(value);
  const evidence: Evidence = {authorization, verifier, refresh, now, monotonicNow,
    deadlines: {startBy: Infinity, workload: Infinity, scope: Infinity}, lastMonotonic: -Infinity, refused: false, refreshing: false};
  if (!fresh(evidence, true)) throw refused();
  const receipt = Object.freeze({runId: authorization.runId, generation: authorization.generation, purpose: authorization.purpose,
    expiresAt: authorization.acceptanceGrant.expiresAt, startBy: authorization.startBy, workloadDeadline: authorization.workloadDeadline});
  verified.set(receipt, evidence);
  return receipt;
}

export function hasAcceptance(value: VerifiedAcceptance | undefined, binding: AcceptanceBinding): boolean {
  const evidence = value && verified.get(value);
  if (!evidence || evidence.refused || evidence.refreshing || !fresh(evidence, true)) return false;
  const {authorization} = evidence, grant = authorization.acceptanceGrant;
  return binding.platform === 'linux' && grant.platform === binding.platform && grant.toolKey === binding.toolKey &&
    (binding.runId === undefined || binding.runId === authorization.runId) &&
    (binding.generation === undefined || binding.generation === authorization.generation) &&
    (binding.purpose === undefined || binding.purpose === authorization.purpose) &&
    (binding.helperId === undefined || binding.helperId === authorization.helperId) &&
    (binding.aiToolId === undefined || binding.aiToolId === authorization.aiToolId) &&
    (binding.deviceKeyId === undefined || binding.deviceKeyId === authorization.deviceKeyId);
}

/** Remaining calibrated admission budget, bounded by the original and refreshed
 * startBy, workload and scope deadlines. Refresh never extends the workload.
 * Never interpret signed server timestamps using the host wall clock. */
export function acceptanceStartBudget(value: VerifiedAcceptance, binding: AcceptanceOperationBinding,
  authorization?: SignedRunnerAuthorization): number {
  const evidence = verified.get(value);
  if (!evidence || !hasAcceptance(value, binding) || authorization && evidence.authorization !== authorization) throw refused();
  const remaining = Math.min(evidence.deadlines.startBy, evidence.deadlines.workload, evidence.deadlines.scope) - evidence.monotonicNow();
  if (!Number.isFinite(remaining) || remaining <= 0) throw refused();
  return remaining;
}

export function acceptanceWorkloadBudget(value: VerifiedAcceptance): number {
  const evidence = verified.get(value);
  if (!evidence || evidence.refused || !fresh(evidence, false)) throw refused();
  const remaining = Math.min(evidence.deadlines.workload, evidence.deadlines.scope) - evidence.monotonicNow();
  if (!Number.isFinite(remaining) || remaining <= 0) throw refused();
  return remaining;
}

/** Return signed operation context for the later single-use admission barrier. */
export async function checkAcceptance(value: VerifiedAcceptance | undefined, binding: AcceptanceOperationBinding,
  live = false): Promise<SignedRunnerAuthorization> {
  const evidence = value && verified.get(value);
  if (!evidence) throw refused();
  try {
    if (typeof binding.runId !== 'string' || typeof binding.generation !== 'string' || !binding.purpose ||
      !hasAcceptance(value, binding) || evidence.refreshing) throw refused();
    const original = evidence.verifier.verify(evidence.authorization);
    if (live) {
      evidence.refreshing = true;
      const current = evidence.verifier.verify(await evidence.refresh());
      for (const field of ['purpose', 'helperId', 'aiToolId', 'deviceKeyId', 'runId', 'generation', 'workloadDeadline'] as const) {
        if (current[field] !== original[field]) throw refused();
      }
      for (const field of ['scopeId', 'scopeVersion', 'toolKey', 'platform', 'expiresAt'] as const) {
        if (current.acceptanceGrant[field] !== original.acceptanceGrant[field]) throw refused();
      }
      // An offline or delayed refresh cannot revive the original expired start window.
      if (evidence.refused || !fresh(evidence, true)) throw refused();
      evidence.authorization = current;
      evidence.refreshing = false;
    }
    if (!hasAcceptance(value, binding)) throw refused();
    return evidence.authorization;
  } catch (error) {evidence.refused = true; throw error;}
  finally {evidence.refreshing = false;}
}

/** Terminal reporting may finish after startBy, but cannot extend the workload deadline. */
export function acceptanceAuthorization(value: VerifiedAcceptance): SignedRunnerAuthorization {
  const evidence = verified.get(value);
  if (!evidence || evidence.refused || !fresh(evidence, false)) throw refused();
  return evidence.verifier.verify(evidence.authorization);
}

/** This plain terminal identity may be persisted. It grants no executable authority. */
export function acceptanceAcknowledgment(value: VerifiedAcceptance): RunnerActivationAcknowledgment {
  const evidence = verified.get(value);
  if (!evidence || evidence.authorization.purpose !== 'activation') throw refused();
  const {deviceKeyId, runId, generation, acceptanceGrant: {scopeId, scopeVersion}} = evidence.authorization;
  return Object.freeze({purpose: 'activation-result', deviceKeyId, runId, generation, scopeId, scopeVersion});
}
