import {HelperError} from '../config.js';
import {acceptanceAuthorization, acceptanceStartBudget, acceptanceWorkloadBudget, checkAcceptance, hasAcceptance, invalidateAcceptance,
  type AcceptanceOperationBinding, type VerifiedAcceptance} from './acceptance.js';
import type {SignedRunnerAuthorization} from '../shared/runner-acceptance.js';

/** Opaque, memory-only context. It conveys no journal, signal or CLEAN authority. */
export type LinuxAcceptanceOperation = Readonly<{kind: 'linux-acceptance-operation'}>;
type Binding = Required<AcceptanceOperationBinding>;
type Operation = {receipt: VerifiedAcceptance; binding: Binding; identity: Readonly<Record<string, string | number>>};
const operations = new WeakMap<LinuxAcceptanceOperation, Operation>();
const refused = () => new HelperError('RUN_ACCEPTANCE_INVALID', 'The exact Linux operation authorization is unavailable.');

export function createAcceptanceOperation(receipt: VerifiedAcceptance, binding: Binding): LinuxAcceptanceOperation {
  if (binding.platform !== 'linux' || !binding.helperId || !binding.aiToolId || !binding.deviceKeyId ||
    !binding.runId || !binding.generation || !binding.purpose || !hasAcceptance(receipt, binding)) throw refused();
  const signed = acceptanceAuthorization(receipt);
  const context = Object.freeze({kind: 'linux-acceptance-operation' as const});
  operations.set(context, {receipt, binding: Object.freeze({...binding}), identity: Object.freeze({
    ...binding, scopeId: signed.acceptanceGrant.scopeId, scopeVersion: signed.acceptanceGrant.scopeVersion,
    expiresAt: signed.acceptanceGrant.expiresAt, workloadDeadline: signed.workloadDeadline,
  })});
  return context;
}

export function hasAcceptanceOperation(context: LinuxAcceptanceOperation | undefined,
  expected: Partial<Binding> = {}): boolean {
  const operation = context && operations.get(context);
  return !!operation && Object.entries(expected).every(([key, value]) => operation.binding[key as keyof Binding] === value) &&
    hasAcceptance(operation.receipt, operation.binding);
}

export function assertAcceptanceOperation(context: LinuxAcceptanceOperation | undefined, expected: Partial<Binding> = {}): void {
  if (!hasAcceptanceOperation(context, expected)) throw refused();
}

export function acceptanceOperationIdentity(context: LinuxAcceptanceOperation): Readonly<Record<string, string | number>> {
  assertAcceptanceOperation(context);
  return operations.get(context)!.identity;
}

export function acceptanceOperationBudget(context: LinuxAcceptanceOperation, signed?: SignedRunnerAuthorization): number {
  const operation = operations.get(context);
  if (!operation) throw refused();
  return acceptanceStartBudget(operation.receipt, operation.binding, signed);
}

export function acceptanceOperationWorkloadBudget(context: LinuxAcceptanceOperation): number {
  const operation = operations.get(context);
  if (!operation) throw refused();
  return acceptanceWorkloadBudget(operation.receipt);
}

export function invalidateAcceptanceOperation(context: LinuxAcceptanceOperation | undefined): void {
  const operation = context && operations.get(context);
  if (operation) invalidateAcceptance(operation.receipt);
}

/** The caller must bound this wait and discard a reply after sealing. */
export function refreshAcceptanceOperation(context: LinuxAcceptanceOperation): Promise<SignedRunnerAuthorization> {
  const operation = operations.get(context);
  if (!operation) return Promise.reject(refused());
  return checkAcceptance(operation.receipt, operation.binding, true);
}
