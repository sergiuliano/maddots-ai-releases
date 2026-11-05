import type { ChildProcess } from 'node:child_process';
import {writeSync} from 'node:fs';

declare const containmentEndpointBrand: unique symbol;
export interface ContainmentSignalEndpoint {readonly [containmentEndpointBrand]: true}
const containmentEndpoints = new WeakMap<ContainmentSignalEndpoint, {fd: number; valid: () => boolean; revoked: boolean}>();

/** Only the trusted containment backend registers its retained cgroup.kill FD. */
export function registerContainmentSignalEndpoint(fd: number, valid: () => boolean): ContainmentSignalEndpoint {
  if (!Number.isSafeInteger(fd) || fd < 0) throw new Error('Invalid containment endpoint.');
  const endpoint = Object.freeze({}) as ContainmentSignalEndpoint;
  containmentEndpoints.set(endpoint, {fd, valid, revoked: false});
  return endpoint;
}
export function revokeContainmentSignalEndpoint(endpoint: ContainmentSignalEndpoint): void {
  const retained = containmentEndpoints.get(endpoint);
  if (retained) retained.revoked = true;
}

export interface SignalSnapshot { pid: number; pgid: number; ppid?: number; sid?: string; startedAt?: string }
export interface SignalChild {
  child: Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode'>;
  /** The helper that spawned this child. A changed parent disproves ownership. */
  parentPid?: number;
  /** Contradictory evidence permanently revokes this live-child capability. */
  revoked?: boolean;
  valid?: () => boolean;
}
export interface SignalEvidence {
  startedAt?: string;
  witness?: {pid: number; startedAt: string};
  sid?: string;
  child?: Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode'>;
  authority?: SignalChild;
  /** Native readers are synchronous. Async test readers must return a coherent row. */
  read?: () => SignalSnapshot | null | undefined | Promise<SignalSnapshot | null | undefined>;
  /** PID-only legacy inspection. It cannot authorize a group. */
  identity?: () => string | null | Promise<string | null>;
  /** Reconfirm discovery-only authority (for example a run fence) before the final read. */
  confirm?: () => boolean | Promise<boolean>;
  allowChildPidFallback?: boolean;
  sendGroup?: (pgid: number, signal: NodeJS.Signals) => void;
  deadline?: number;
}
export type SignalTarget = {kind: 'pid' | 'group' | 'probe' | 'self-group'; pid: number} |
  {kind: 'containment'; endpoint: ContainmentSignalEndpoint};
export type SignalResult = {status: 'sent' | 'gone' | 'unproven'; cleanupPending: boolean};

/**
 * Linux accepts only an opaque retained cgroup endpoint or invariant self-group
 * TERM. Its separate native guardian implements the same self-group rule.
 * A signal result cannot retire Linux responsibility: retirement requires sealed
 * admission, registered empty proof and durable S2 CLEAN.
 * Darwin retains its legacy lifetime and membership checks in one final snapshot,
 * with no await between validation and the signal. An unreaped ChildProcess can
 * authorize its own PID during an outage. Its guardian embeds this function's
 * source; a later complete scan remains Darwin's legacy completion check.
 */
export async function signalIfStillOwned(target: SignalTarget, signal: NodeJS.Signals | 0, evidence: SignalEvidence = {}): Promise<SignalResult> {
  const pending: SignalResult = {status: 'unproven', cleanupPending: true};
  if (evidence.deadline !== undefined && Date.now() >= evidence.deadline) return pending;
  if (target.kind === 'containment') {
    if (process.platform !== 'linux' || signal !== 'SIGKILL') return pending;
    const retained = containmentEndpoints.get(target.endpoint);
    if (!retained || retained.revoked) return pending;
    // The last generation check and retained-FD write are synchronous. Failed
    // validity permanently revokes this capability, including after FD reuse.
    try { if (!retained.valid()) {retained.revoked = true; return pending;} }
    catch {retained.revoked = true; return pending;}
    if (evidence.deadline !== undefined && Date.now() >= evidence.deadline) return pending;
    writeSync(retained.fd, '1\n');
    return {status: 'sent', cleanupPending: true};
  }
  // Linux process-table rows, child fields, saved witnesses and fences are
  // diagnostics only. They can never manufacture a numeric signal recipient.
  if (process.platform === 'linux' && (target.kind !== 'self-group' || signal !== 'SIGTERM')) return pending;
  if (!Number.isSafeInteger(target.pid) || target.pid < 1 ||
    (target.kind !== 'probe' && (target.pid <= 1 || target.pid === process.pid && target.kind !== 'self-group')) ||
    (target.kind === 'probe') !== (signal === 0) ||
    target.kind === 'pid' && evidence.witness !== undefined && evidence.witness.pid !== target.pid) return pending;
  const authority = evidence.authority;
  const child = authority?.child ?? evidence.child;
  const witness = evidence.witness;
  let row: SignalSnapshot | null | undefined, identity: string | null | undefined;
  let unavailable = false;
  if (evidence.confirm) {
    try {
      const confirmation = evidence.confirm();
      if (!(typeof confirmation === 'boolean' ? confirmation : await confirmation)) return pending;
    } catch { return pending; }
  }
  if (evidence.deadline !== undefined && Date.now() >= evidence.deadline) return pending;
  try {
    if (evidence.read) {
      const value = evidence.read();
      row = value && 'then' in value ? await value : value;
    } else if (evidence.identity) {
      const value = evidence.identity();
      identity = value !== null && typeof value === 'object' ? await value : value;
    }
  } catch { unavailable = true; }

  // Everything below is synchronous, including all child/deadline checks and
  // the sink. A delayed inspector cannot keep an exited child's authority.
  if (evidence.deadline !== undefined && Date.now() >= evidence.deadline) return pending;
  if (child && (authority?.revoked || authority?.valid?.() === false ||
    child.pid !== (witness?.pid ?? target.pid) || child.exitCode !== null || child.signalCode !== null)) return pending;
  let destination = target.kind === 'self-group' && process.platform === 'linux' ? 0 :
    target.kind === 'group' || target.kind === 'self-group' ? -target.pid : target.pid;
  if (target.kind === 'self-group') {
    // The executing guardian itself pins this lifetime, but must still be in
    // the group it proposes to signal. Tools never inherit its private IPC.
    if (target.pid !== process.pid || row?.pid !== process.pid || row.pgid !== process.pid) return pending;
  } else if (target.kind !== 'probe') {
    const expected = witness?.startedAt ?? evidence.startedAt;
    const expectedPid = witness?.pid ?? target.pid;
    const contradicts = !unavailable && evidence.identity && identity !== expected || row === null || row && (row.pid !== expectedPid ||
      authority?.parentPid !== undefined && row.ppid !== undefined && row.ppid !== authority.parentPid ||
      !!expected && !!row.startedAt && row.startedAt !== expected ||
      target.kind === 'group' && (row.pgid !== target.pid || evidence.sid !== undefined && row.sid !== evidence.sid));
    if (contradicts) {
      if (authority) authority.revoked = true;
      return pending;
    }
    if (target.kind === 'group') {
      if (!unavailable && row && expected && row.startedAt === expected) {
        // Coherent lifetime, PGID and (when supplied) SID have all matched.
      } else if (child && evidence.allowChildPidFallback && (unavailable || row === undefined || !expected)) destination = child.pid!;
      else return pending;
    } else if (!(expected && (row?.startedAt ?? identity) === expected)) {
      if (!child || expected && row !== undefined && !unavailable || evidence.identity && !unavailable) return pending;
    }
  }
  try {
    if (destination < 0 && evidence.sendGroup && signal !== 0) evidence.sendGroup(-destination, signal);
    else process.kill(destination, signal);
    return {status: 'sent', cleanupPending: target.kind !== 'probe'};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return {status: 'gone', cleanupPending: target.kind !== 'probe'};
    throw error;
  }
}
