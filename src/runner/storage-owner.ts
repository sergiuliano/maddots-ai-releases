import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {HelperError} from '../config.js';
import {beforeDeadline, PROCESS_CLEANUP_CAP_MS, ProcessCleanupError} from './process.js';
import {retainRunnerStorageDirectory, type RetainedRunnerStorageDirectory, type RunnerStorageLock} from './storage-lock.js';
import type {ActiveRun, RunnerState} from './state.js';
import type {RunFolder} from './run-folder.js';
import {initializeCleanJournal, RunnerJournal, type JournalContainmentBackend, type JournalDiagnostics, type JournalToken} from './journal.js';
import type {LinuxContainmentBackend} from './linux-containment.js';

export class RunnerStorageError extends HelperError {
  constructor() { super('RUNNER_STATE_UNAVAILABLE', 'Runner state could not be saved. Retry when storage is available.'); }
}

// A cache of the kernel-locked owner, never a substitute for the kernel lock.
// Entries with uncertain I/O deliberately survive the last RunnerCore.
type OwnerAcquisition = {owner: Promise<RunnerStorageOwner>; callers: number};
const owners = new Map<string, OwnerAcquisition>();
// A live owner also reserves its public names, so replacement cannot create a
// second owner merely by changing the inode found at the original pathname.
const ownedPaths = new Map<string, string>();
const retainedOwners = new Set<RunnerStorageOwner>();
// Diagnostic aliases are observations of successful acquisitions, never cache
// keys or a reason to authorize a handoff or drop a retained owner.
const diagnosticOwnerPaths = new WeakMap<RunnerStorageOwner, Set<string>>();
// Initialization already has a recovery duty before it owns a lock: an unread
// directory may contain an earlier controller's obligations. Closing unused FDs
// must not silently certify that disk clean. A successor's acknowledged replay
// can discharge this reservation, but never while its physical I/O is pending.
const acquisitionUncertainty = new Set<StorageAcquisitionUncertainty>();
class StorageAcquisitionUncertainty {
  readonly paths: Set<string>;
  identity?: string;
  private pending = 0;
  private finished = false;
  private provenIdentity?: string;
  constructor(data: string) {
    this.paths = new Set([resolve(data)]);
    acquisitionUncertainty.add(this);
  }
  track<T>(work: Promise<T>): Promise<T> {
    this.pending++;
    const settled = () => {this.pending--; this.releaseProven();};
    void work.then(settled, settled);
    return work;
  }
  bind(directory: RetainedRunnerStorageDirectory): void {
    this.identity = directory.identity;
    this.paths.add(directory.data);
  }
  finish(): void {this.finished = true; this.releaseProven();}
  diagnosticSnapshot(): Readonly<{identity: string | null; pending: number; finished: boolean}> {
    return Object.freeze({identity: this.identity ?? null, pending: this.pending, finished: this.finished});
  }
  prove(identity: string, paths: readonly string[]): void {
    if (this.identity === identity || paths.some(path => this.paths.has(path))) {
      this.provenIdentity = identity;
      this.releaseProven();
    }
  }
  private releaseProven(): void {
    if (this.finished && !this.pending && this.identity !== undefined && this.identity === this.provenIdentity) {
      acquisitionUncertainty.delete(this);
    }
  }
}
export const storageOwnersBusy = (data?: string): boolean =>
  [...acquisitionUncertainty].some(item => data === undefined || item.paths.has(resolve(data))) ||
  [...retainedOwners].some(owner => (data === undefined || owner.state.data === resolve(data)) && owner.busy);
export type RunnerCleanupDiagnosticPhase = 'stopping' | 'term' | 'grace' | 'kill' | 'verify-empty' | 'completion-proof' | 'journal-clean' | 'publication';
type RunDiagnostics = Readonly<{runId: string; phase: ActiveRun['phase']; fenced: boolean; processEvidence: boolean}>;
export type RunnerStorageOwnerDiagnostics = Readonly<{
  data: string; directoryIdentity: string; busy: boolean; attached: boolean; retired: boolean; retained: boolean;
  generation: number; journalGeneration: number; ownerEpoch: string | null;
  stateLoaded: boolean; initialized: boolean; failure: boolean; unavailable: boolean; admissionBlocked: boolean;
  pendingOperations: number; validating: number; timedOutOperations: number; runtimePending: boolean;
  draining: boolean; releasing: boolean; writeRequested: boolean; dirty: boolean; unmatchedWrites: number;
  active: readonly RunDiagnostics[]; unrecovered: readonly RunDiagnostics[];
  recoveryFolders: number; folders: number;
  cleanup: readonly Readonly<{runId: string; phase: RunnerCleanupDiagnosticPhase; failed: boolean}>[];
  journal: JournalDiagnostics | null;
}>;
/** A retained same-directory holder may be clean and still own the kernel
 * lock. Report its memory without I/O, replay, retirement or permission checks. */
export function storageOwnerDiagnostics(data: string) {
  const path = resolve(data);
  const acquisitions = [...acquisitionUncertainty].filter(item => item.paths.has(path)).map(item => item.diagnosticSnapshot());
  const holders = [...retainedOwners].filter(owner => owner.state.data === path || diagnosticOwnerPaths.get(owner)?.has(path))
    .map(owner => owner.diagnosticSnapshot());
  return Object.freeze({busy: acquisitions.length > 0 || holders.some(owner => owner.busy),
    acquisitions: Object.freeze(acquisitions), owners: Object.freeze(holders)});
}
const processEvidence = (row: ActiveRun): boolean => row.pid > 0 || !!row.pgid ||
  !!row.processGroups?.length || !!row.legacyProcessIdentity;
const unresolved = (row: ActiveRun): boolean => !!row.fence || processEvidence(row);
// A completed posting row can retain its run fence as metadata. It must not
// regain process obligations merely because the in-memory owner is handed off.
const activePending = (row: ActiveRun): boolean => row.phase !== 'posting' || processEvidence(row);

/** A successful caller keeps its reservation until it attaches or abandons it. */
export interface RunnerStorageAcquisition {
  readonly owner: RunnerStorageOwner;
  attach(): number;
  release(): Promise<void>;
}

export async function acquireStorageOwner(data: string, state: RunnerState): Promise<RunnerStorageAcquisition> {
  const deadline = Date.now() + PROCESS_CLEANUP_CAP_MS;
  const uncertainty = new StorageAcquisitionUncertainty(data);
  // The same retained directory FD supplies both the cache key and the lock.
  // Only directory creation precedes the guard; no authoritative state is read.
  const preparing = uncertainty.track(retainRunnerStorageDirectory(data).then(directory => {
    uncertainty.bind(directory); return directory;
  }));
  let directory: RetainedRunnerStorageDirectory;
  try { directory = await beforeDeadline(deadline, () => preparing); }
  catch {
    // A caller deadline cannot abandon a directory FD returned by late I/O.
    void uncertainty.track(preparing.then(candidate => candidate.close())).catch(() => {});
    uncertainty.finish();
    throw new RunnerStorageError();
  }
  let transferred = false;
  let acquisition: OwnerAcquisition | undefined, reserved = false;
  const release = async () => {
    if (!reserved) return;
    reserved = false;
    acquisition!.callers--;
    // Acquisition may finish after this caller's deadline. Its real result,
    // not the caller timeout, determines when the retained FDs can close.
    const owner = await acquisition!.owner;
    await owner.retireIfUnused();
  };
  try {
    const identity = directory.identity, canonical = directory.data;
    const previousIdentity = ownedPaths.get(canonical);
    if (previousIdentity !== undefined && previousIdentity !== identity) throw new RunnerStorageError();
    acquisition = owners.get(identity);
    if (!acquisition) {
      const entry: OwnerAcquisition = {owner: undefined!, callers: 0};
      const forget = () => {
        if (owners.get(identity) !== entry) return;
        owners.delete(identity);
        for (const [path, heldIdentity] of ownedPaths) if (heldIdentity === identity) ownedPaths.delete(path);
      };
      transferred = true;
      entry.owner = uncertainty.track((async () => {
        const lock = await directory.acquireLock();
        state.bindDirectory(lock);
        const owner = new RunnerStorageOwner(state, lock, forget, () => entry.callers > 0, true);
        retainedOwners.add(owner);
        diagnosticOwnerPaths.set(owner, new Set([resolve(data), canonical]));
        return owner;
      })());
      acquisition = entry;
      owners.set(identity, entry);
      void entry.owner.catch(forget);
    }
    acquisition.callers++; reserved = true;
    ownedPaths.set(canonical, identity);
    const ownership = uncertainty.track(acquisition.owner);
    const owner = await beforeDeadline(deadline, () => ownership);
    diagnosticOwnerPaths.get(owner)?.add(resolve(data));
    await owner.validate(deadline);
    // Cached owners retain their original requested alias. Validate this
    // caller's separately pinned alias too before permitting a handoff.
    const checking = uncertainty.track(directory.assertCurrent());
    await beforeDeadline(deadline, () => checking);
    return {owner, release: async () => {
      const retiring = uncertainty.track(release()).catch(() => {});
      await beforeDeadline(deadline, () => retiring).catch(() => {});
    }, attach: () => {
      if (!reserved) throw new RunnerStorageError();
      try { return owner.attach(); }
      finally { void uncertainty.track(release()).catch(() => {}); }
    }};
  } catch {
    const retiring = uncertainty.track(release()).catch(() => {});
    await beforeDeadline(deadline, () => retiring).catch(() => {});
    throw new RunnerStorageError();
  }
  finally {
    if (!transferred) {
      // Start cleanup even when the caller already exhausted its wait budget.
      const closing = uncertainty.track(directory.close()).catch(() => {});
      await beforeDeadline(deadline, () => closing).catch(() => {});
    }
    uncertainty.finish();
  }
}

export class RunnerStorageOwner {
  readonly active = new Map<string, ActiveRun>();
  readonly unrecovered = new Map<string, ActiveRun>();
  readonly recoveryFolders = new Map<string, RunFolder>();
  readonly folders = new Set<string>();
  // Projection failures remain local evidence too. The write-ahead journal is
  // the independent restart barrier and cannot be retired by these snapshots.
  readonly unmatchedWrites: {sequence: number; rows: ActiveRun[]; error: unknown}[] = [];
  stateLoaded = false;
  initialized = false;
  private generation = 0;
  private attached = false;
  private retired = false;
  private retained = false;
  private failure = false;
  private pending = 0;
  private readonly preparations = new Set<Promise<void>>();
  private validating = 0;
  private sequence = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private requested = false;
  private dirty = false;
  private readonly timedOut = new Set<Promise<unknown>>();
  private draining?: Promise<void>;
  private releasing?: Promise<void>;
  private runtimePending = false;
  private permissionsSealed = false;
  private physicalStarted = false;
  private journal?: RunnerJournal;
  private journalGeneration = 0;
  private journalBootId?: string;
  private journalOwnerEpoch?: string;
  private containment?: Promise<LinuxContainmentBackend>;
  private retainedContainment?: LinuxContainmentBackend;
  private readonly cleanupDiagnostics = new Map<string, Readonly<{phase: RunnerCleanupDiagnosticPhase; failed: boolean}>>();

  constructor(readonly state: RunnerState, private readonly lock: RunnerStorageLock, private readonly forget: () => void,
    private readonly acquiring: () => boolean = () => false, readonly requiresJournal = false,
    private readonly journalBackend?: JournalContainmentBackend) {}
  get writes(): Promise<void> | undefined { return this.draining; }
  get unavailable(): boolean { return this.timedOut.size > 0 || this.retired; }
  get admissionBlocked(): boolean { return this.failure || this.unmatchedWrites.length > 0 || this.unavailable ||
    this.requiresJournal && (this.journalGeneration !== this.generation || !!this.journal?.admissionBlocked); }
  get busy(): boolean {
    return this.requiresJournal && (!this.journal || this.attached && this.journalGeneration !== this.generation || !!this.journal?.busy) ||
      !this.stateLoaded || !this.initialized || this.runtimePending || this.pending > 0 || this.preparations.size > 0 || this.validating > 0 || this.dirty || this.failure ||
      this.unmatchedWrites.length > 0 || [...this.unrecovered.values()].some(unresolved) ||
      [...this.active.values()].some(activePending);
  }
  /** Observational phase markers do not grant cleanup authority or affect busy
   * and retirement decisions. Failed phases survive for teardown diagnostics. */
  setCleanupDiagnostic(runId: string, phase: RunnerCleanupDiagnosticPhase, failed = false): void {
    this.cleanupDiagnostics.set(runId, Object.freeze({phase, failed}));
  }
  clearCleanupDiagnostic(runId: string): void {this.cleanupDiagnostics.delete(runId);}
  diagnosticSnapshot(): RunnerStorageOwnerDiagnostics {
    const runs = (rows: Iterable<ActiveRun>) => Object.freeze([...rows].map(row => Object.freeze({runId: row.runId,
      phase: row.phase, fenced: !!row.fence, processEvidence: processEvidence(row)})));
    return Object.freeze({data: this.state.data, directoryIdentity: this.lock.identity, busy: this.busy,
      attached: this.attached, retired: this.retired, retained: this.retained, generation: this.generation,
      journalGeneration: this.journalGeneration, ownerEpoch: this.journalOwnerEpoch ?? null,
      stateLoaded: this.stateLoaded, initialized: this.initialized, failure: this.failure, unavailable: this.unavailable,
      admissionBlocked: this.admissionBlocked, pendingOperations: this.pending, validating: this.validating,
      timedOutOperations: this.timedOut.size, runtimePending: this.runtimePending, draining: !!this.draining,
      releasing: !!this.releasing, writeRequested: this.requested, dirty: this.dirty, unmatchedWrites: this.unmatchedWrites.length,
      active: runs(this.active.values()), unrecovered: runs(this.unrecovered.values()), recoveryFolders: this.recoveryFolders.size,
      folders: this.folders.size, cleanup: Object.freeze([...this.cleanupDiagnostics].map(([runId, state]) => Object.freeze({runId, ...state}))),
      journal: this.journal?.diagnosticSnapshot() ?? null});
  }
  assertGeneration(generation: number): void {
    if (this.retired || !this.attached || generation !== this.generation) throw new RunnerStorageError();
  }
  /** Retained cleanup authority survives a journal I/O failure, but never an
   * owner handoff. Creating it does not grant launcher or workload admission. */
  getLinuxContainment(generation: number): Promise<LinuxContainmentBackend> {
    this.assertGeneration(generation);
    if (!this.journalBootId || !this.journalOwnerEpoch) throw new RunnerStorageError();
    if (!this.containment) {
      const registrations = this.journal!.containmentRegistrations;
      const completedRegistrations = this.journal!.completedContainmentRegistrations;
      // Native preparation can outlive its caller's deadline. Keep the owner
      // and lock until the physical operation settles, without nesting the
      // journal writer queue during restart recovery.
      this.pending++;
      this.containment = (async () => {
        const {createLinuxContainmentBackend} = await import('./linux-containment.js');
        const backend = await createLinuxContainmentBackend({directoryIdentity: this.lock.identity, bootId: this.journalBootId!,
          ownerEpoch: this.journalOwnerEpoch!, registrations, completedRegistrations,
          isCurrent: () => !this.retired && this.attached && this.generation === generation});
        this.retainedContainment = backend;
        try {for (const registration of completedRegistrations) await backend.retireCompleted(registration);}
        catch (error) {this.failure = true; this.retained = true; throw error;}
        return backend;
      })().finally(() => {this.pending--; void this.retireIfUnused().catch(() => {});});
    }
    return this.containment;
  }
  isRunRetired(runId: string): boolean {return this.journal?.isClean(runId) === true;}
  /** Explicit fresh-install command only. The real owner supplies both the
   * physical queue and revocable generation; ordinary replay never bootstraps.
   * Evidence reads/FD closure belong to the physical callback, not its waiter.
   */
  async bootstrapJournal(generation: number,
    revalidate: (lock: RunnerStorageLock, fresh: boolean) => Promise<string>,
    deadline = Date.now() + PROCESS_CLEANUP_CAP_MS): Promise<void> {
    this.assertGeneration(generation);
    if (!this.requiresJournal || this.stateLoaded || this.initialized || this.failure || this.physicalStarted) {
      throw new RunnerStorageError();
    }
    try {
      await this.operation(generation, async (_state, lock) => {
        const bootId = await revalidate(lock, true);
        await lock.assertCurrent();
        this.assertGeneration(generation);
        if (this.unavailable || Date.now() >= deadline) throw new RunnerStorageError();
        // EEXIST, even for an empty directory, is prior/partial evidence. A
        // concurrent mkdir must not turn a fresh install into a migration.
        const directory = await lock.directory('runner', {createOnly: true});
        await initializeCleanJournal(directory, {directoryIdentity: lock.identity, bootId,
          ownerEpoch: randomUUID(), generation, completionScope: 'full-run', contractVersion: 1,
          isCurrent: () => !this.retired && this.attached && this.generation === generation &&
            !this.failure && !this.unavailable && !this.permissionsSealed && Date.now() < deadline});
      }, true, deadline);
      // Use the unchanged replay path, including its ordinary EPOCH. Only then
      // may init create outcomes or read the projection and permit retirement.
      await this.replayJournal(generation, deadline);
      await this.operation(generation, async (state, lock) => {
        await state.init();
        if ((await state.active()).length || await revalidate(lock, false) !== this.journalBootId) throw new RunnerStorageError();
        await lock.assertCurrent();
        this.assertGeneration(generation);
        if (this.unavailable || this.failure || Date.now() >= deadline) throw new RunnerStorageError();
        this.stateLoaded = true; this.initialized = true;
      }, true, deadline);
    } catch (error) {
      this.journal?.invalidate('operation-ambiguous');
      this.failure = true; this.retained = true;
      throw error;
    }
  }
  /** Replay is authoritative and precedes even loading the status projection.
   * Raw owners constructed by storage-only fixtures do not enable the protocol;
   * every production acquisition above does, without a configuration switch.
   */
  async replayJournal(generation: number, deadline = Date.now() + PROCESS_CLEANUP_CAP_MS): Promise<void> {
    if (!this.requiresJournal) return;
    this.assertGeneration(generation);
    if (this.journalGeneration === generation) {
      if (this.journal?.busy || this.failure) throw new RunnerStorageError();
      return;
    }
    try {
      await this.operation(generation, async (_state, lock) => {
        const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
        if (this.retainedContainment) await this.retainedContainment.close();
        this.retainedContainment = undefined;
        this.journalBootId = bootId; this.journalOwnerEpoch = randomUUID(); this.containment = undefined;
        const directory = await lock.directory('runner');
        const journal = new RunnerJournal(directory, {directoryIdentity: lock.identity, bootId,
          ownerEpoch: this.journalOwnerEpoch, generation, completionScope: 'full-run', contractVersion: 1,
          backend: this.journalBackend ?? {
            verifyRegistration: async registration => (await this.getLinuxContainment(generation)).verifyRegistration(registration),
            verifyCompletion: async (registration, proof) => (await this.getLinuxContainment(generation)).verifyCompletion(registration, proof),
          },
          isCurrent: () => !this.retired && this.attached && this.generation === generation && !this.failure});
        this.journal = journal;
        const replay = await journal.replay();
        if (replay.busy) {
          if (replay.reason || !replay.obligations.length || this.journalBackend) throw new RunnerStorageError();
          const backend = await this.getLinuxContainment(generation);
          for (const row of replay.obligations) {
            if (!row.registration || !['CONTAINMENT_BOUND', 'LAUNCH_ALLOWED', 'STOPPING'].includes(row.stage)) throw new RunnerStorageError();
            const run = await backend.reopen(row.registration);
            run.seal();
            await run.forceKill();
            while (!await run.empty()) {
              if (Date.now() >= deadline) throw new RunnerStorageError();
              await new Promise<void>(done => setTimeout(done, 25));
            }
            const proof = await run.completionProof();
            await journal.recoverSameBootContainment(row.runId, proof);
            await run.retire(() => journal.isClean(row.runId));
          }
          if (journal.busy) throw new RunnerStorageError();
        }
        await journal.establishEpoch();
      }, true, deadline);
      this.assertGeneration(generation);
      this.journalGeneration = generation;
      this.acknowledgeCleanAcquisition(generation);
    } catch {
      this.journal?.invalidate('operation-ambiguous');
      this.failure = true; this.retained = true;
      throw new RunnerStorageError();
    }
  }
  private acknowledgeCleanAcquisition(generation: number): void {
    this.assertGeneration(generation);
    if (this.requiresJournal && (this.journalGeneration !== generation || !this.journal?.ready || this.journal.busy || this.failure)) {
      throw new RunnerStorageError();
    }
    for (const acquisition of acquisitionUncertainty) {
      acquisition.prove(this.lock.identity, [this.lock.data, resolve(this.state.data)]);
    }
  }
  /** S3's trusted backend uses this owner queue for every durable transition.
   * A timeout revokes the caller's permission immediately. Physical settlement
   * keeps the FD and writer slot, and can never resurrect that permission.
   */
  async journalOperation<T>(generation: number, action: (journal: RunnerJournal) => Promise<T>,
    deadline = Date.now() + PROCESS_CLEANUP_CAP_MS): Promise<T> {
    this.assertGeneration(generation);
    const journal = this.journal;
    if (!journal || this.journalGeneration !== generation || this.failure) throw new RunnerStorageError();
    try {
      const value = await this.operation(generation, async () => action(journal), true, deadline);
      this.assertGeneration(generation);
      return value;
    } catch {
      journal.invalidate('operation-ambiguous');
      this.failure = true; this.retained = true;
      throw new RunnerStorageError();
    }
  }
  /** S3 calls this synchronously before queuing STOPPING or requesting a kill.
   * The pending storage queue must never leave a launch permission usable.
   */
  sealJournalAdmission(generation: number, token: JournalToken): void {
    this.assertGeneration(generation);
    if (!this.journal || this.journalGeneration !== generation) throw new RunnerStorageError();
    this.journal.seal(token);
  }
  /** One synchronous capability consumption immediately before the S3 spawn/send.
   * Permission is not released inside an asynchronous storage continuation.
   */
  consumeJournalPermission(generation: number, token: JournalToken, kind: 'launcher' | 'workload'): boolean {
    try {this.assertGeneration(generation);} catch {return false;}
    if (!this.journal || this.journalGeneration !== generation || this.failure || this.unavailable || this.permissionsSealed ||
      this.pending > 0 || this.draining) return false;
    return kind === 'launcher' ? this.journal.consumeLauncher(token) : this.journal.consumeLaunch(token);
  }
  /** A status row never supplies cleanup authority or upgrades legacy state. */
  assertRetiredProjection(runId: string): void {
    if (!this.requiresJournal) return;
    if (!this.journal || !this.journal.isClean(runId)) {
      this.journal?.invalidate('operation-ambiguous');
      this.failure = true; this.retained = true;
      throw new RunnerStorageError();
    }
  }
  /** Empty containment reservation precedes INTENT. Keep this generation and
   * its native endpoints until reservation or its late cleanup settles. This
   * lease never occupies the journal writer queue or authorizes admission. */
  retainPreparation(generation: number): () => void {
    this.assertGeneration(generation);
    let finish!: () => void;
    const preparation = new Promise<void>(resolve => {finish = resolve;});
    this.preparations.add(preparation);
    let released = false;
    return () => {
      if (released) return; released = true;
      this.preparations.delete(preparation); finish();
      void this.retireIfUnused().catch(() => {});
    };
  }
  retainRuntime(): void {
    if (this.attached) {
      this.runtimePending = true;
      // close() may have to leave the owner attached while jobs unwind. Seal
      // admission now, so a late successful callback cannot use that interval.
      this.permissionsSealed = true;
    }
  }
  async validate(deadline = Date.now() + PROCESS_CLEANUP_CAP_MS): Promise<void> {
    if (this.retired || this.releasing || Date.now() >= deadline) throw new RunnerStorageError();
    this.validating++;
    const validation = (async () => {
      try { await this.lock.assertCurrent(); }
      catch { this.retained = true; this.failure = true; throw new RunnerStorageError(); }
      finally {
        this.validating--;
        // A timed-out caller may already have dropped its reservation and the
        // core may have closed. Only real validation settlement releases FDs.
        void this.retireIfUnused().catch(() => {});
      }
    })();
    // A deadline releases this caller's wait only. Real rejection above still
    // records storage uncertainty even if it arrives after the caller left.
    try { await beforeDeadline(deadline, () => validation); }
    catch { throw new RunnerStorageError(); }
  }
  attach(): number {
    if (this.retired || this.attached || this.pending || this.preparations.size || this.validating || this.draining || this.releasing || this.timedOut.size) throw new RunnerStorageError();
    // Explicit clean handoff. Unmatched/dirty obligations need S2 replay and
    // S3 completion proof; merely copying memory must never certify them gone.
    if (this.generation && (!this.stateLoaded || this.dirty || this.failure || this.journal?.busy || this.unmatchedWrites.length ||
      this.retained && ([...this.unrecovered.values()].some(unresolved) ||
        [...this.active.values()].some(activePending)))) throw new RunnerStorageError();
    if (this.generation) {
      // A caller timeout alone is not permanent uncertainty. Only an explicit
      // handoff after successful physical settlement may retire that reason
      // for retention; failed, dirty and unresolved evidence above still veto it.
      this.retained = false;
      for (const row of this.active.values()) if (activePending(row)) {
        this.unrecovered.set(row.runId, row); this.active.delete(row.runId);
      }
    }
    this.attached = true; this.permissionsSealed = false;
    return ++this.generation;
  }
  async detach(generation: number): Promise<void> {
    if (!this.attached || generation !== this.generation) return;
    if (this.preparations.size) {
      // Stop admission now, but keep cleanup authority for a reservation that
      // can return after its caller deadline. Detach itself does not wait on
      // that physical operation or let another generation reuse its objects.
      this.permissionsSealed = true;
      void Promise.all([...this.preparations]).then(() => this.detach(generation)).catch(() => {});
      return;
    }
    this.runtimePending = false;
    this.attached = false;
    // Revoke callbacks before an asynchronous close can admit another core.
    this.generation++;
    await this.retireIfUnused();
  }
  async retireIfUnused(): Promise<void> {
    if (this.retired || this.attached || this.acquiring() || this.validating) return;
    // Validation alone can fail before the owner ever touches authoritative
    // state. Such a failed acquisition has no recovery duty to preserve.
    // Once physical work starts, ordinary dirty/failure retention still wins.
    const unused = !this.physicalStarted && !this.stateLoaded && !this.initialized && !this.pending && !this.preparations.size && !this.draining &&
      !this.runtimePending && !this.requested && !this.dirty && !this.timedOut.size && !this.active.size &&
      !this.unrecovered.size && !this.recoveryFolders.size && !this.folders.size && !this.unmatchedWrites.length;
    if (!unused && (this.busy || this.retained || this.recoveryFolders.size)) return;
    this.retired = true;
    this.releasing = (async () => {
      try {
        await this.retainedContainment?.close();
        await this.lock.release(); this.forget(); retainedOwners.delete(this);
      }
      catch { this.retained = true; this.failure = true; }
    })();
    await beforeDeadline(Date.now() + PROCESS_CLEANUP_CAP_MS, () => this.releasing!).catch(() => {});
  }
  private physical<T>(action: () => Promise<T>): Promise<T> {
    this.pending++;
    const result = this.tail.then(async () => {
      try { await (this.lock.assertHeld ?? this.lock.assertCurrent)(); }
      catch (error) { this.retained = true; this.failure = true; throw error; }
      this.physicalStarted = true;
      return action();
    });
    // Settlement, including rejection, is the only event that frees a physical
    // slot. A public deadline never alters this chain or closes its descriptor.
    this.tail = result.then(() => {}, () => {}).finally(() => { this.pending--; });
    return result;
  }
  private async wait<T>(work: Promise<T>, deadline: number): Promise<T> {
    try { return await beforeDeadline(deadline, () => work); }
    catch (error) {
      if (Date.now() >= deadline) {
        this.timedOut.add(work); this.retained = true;
        void work.finally(() => { this.timedOut.delete(work); }).catch(() => {});
        throw new RunnerStorageError();
      }
      throw error;
    }
  }
  async operation<T>(generation: number, action: (state: RunnerState, lock: RunnerStorageLock) => Promise<T>,
    mutation: boolean | ((error: unknown) => boolean) = false,
    deadline = Date.now() + PROCESS_CLEANUP_CAP_MS): Promise<T> {
    this.assertGeneration(generation);
    if (this.unavailable) throw new RunnerStorageError();
    const work = this.physical(async () => {
      this.assertGeneration(generation);
      try { return await action(this.state, this.lock); }
      catch (error) {
        if (typeof mutation === 'function' ? mutation(error) : mutation) { this.failure = true; this.retained = true; }
        throw error;
      }
    });
    return this.wait(work, deadline);
  }
  async save(generation: number, deadline = Date.now() + PROCESS_CLEANUP_CAP_MS): Promise<void> {
    this.assertGeneration(generation);
    this.requested = true; this.dirty = true;
    if (this.unavailable) throw new RunnerStorageError();
    if (!this.draining) {
      const writing = (async () => {
        await Promise.resolve();
        try {
          while (this.requested) {
            this.requested = false;
            const sequence = ++this.sequence;
            const rows = structuredClone([...this.active.values(), ...this.unrecovered.values()]);
            try { await this.physical(() => this.state.writeActive(rows)); }
            catch (error) {
              this.unmatchedWrites.push({sequence, rows, error});
              this.retained = true; this.failure = true;
              throw error;
            }
          }
          this.dirty = false;
        } finally { this.draining = undefined; }
      })();
      this.draining = writing;
      void writing.catch(() => {});
    }
    // An already exhausted cleanup budget says nothing about I/O health. The
    // queued snapshot still belongs to this owner, but no wait was attempted.
    if (Date.now() >= deadline) throw new ProcessCleanupError();
    await this.wait(this.draining, deadline);
  }
}
