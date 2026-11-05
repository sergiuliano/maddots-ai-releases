import {createHash, randomUUID} from 'node:crypto';
import {HelperError} from '../config.js';
import {listBound, readBound, writeBound} from './state.js';
import type {RunnerStorageDirectory} from './storage-lock.js';

export const JOURNAL_MANIFEST = 'journal-manifest.json';
export const JOURNAL_HEAD = 'journal-head.json';
export const JOURNAL_LIMITS = Object.freeze({maxRecords: 4096, maxBytes: 8 * 1024 * 1024, maxRecordBytes: 4096});
/** Fixed S2 production gate. S3 must wire the durable lifecycle and retained
 * containment capabilities before replacing this refusal. There is no runtime
 * configuration option that re-enables the former Linux execution path.
 */
export const linuxContainmentAdmission = {
  requireAvailable(): void {
    throw new HelperError('LINUX_CONTAINMENT_UNAVAILABLE', 'Linux run containment is not available.');
  },
};
const ZERO = '0'.repeat(64);
const BACKEND = 'linux-cgroup-v2';
const STAGES = ['INTENT', 'CONTAINMENT_BOUND', 'LAUNCH_ALLOWED', 'STOPPING', 'CLEAN'] as const;
export type JournalStage = typeof STAGES[number];
export type JournalReason = 'migration-required' | 'journal-invalid' | 'storage-unavailable' | 'storage-limit' |
  'boot-recovery-required' | 'contract-recovery-required' | 'containment-recovery-required' |
  'containment-unavailable' | 'session-revoked' | 'operation-ambiguous';

/** Only process-management metadata belongs in the persisted registration. */
export type JournalContainmentRegistration = Readonly<{
  backend: typeof BACKEND; namespaceId: string; name: string; objectIdentity: string;
}>;
/** S3 must supply retained capability checks. No process scan or saved path implements this seam. */
export interface JournalContainmentBackend {
  verifyRegistration(registration: JournalContainmentRegistration): Promise<boolean>;
  verifyCompletion(registration: JournalContainmentRegistration, proof: unknown): Promise<boolean>;
}
export type JournalContext = {
  directoryIdentity: string; bootId: string; ownerEpoch: string; generation: number;
  isCurrent(): boolean;
  completionScope: 'full-run'; contractVersion: 1;
  backend?: JournalContainmentBackend;
};
type Limits = typeof JOURNAL_LIMITS;
type Manifest = {
  format: 'maddots-runner-journal'; schemaVersion: 1; journalId: string;
  directoryIdentity: string; bootId: string; backend: typeof BACKEND;
  completionScope: 'full-run'; contractVersion: 1;
  maxRecords: number; maxBytes: number; maxRecordBytes: number;
};
type RecordPayload = {
  schemaVersion: 1; journalId: string; sequence: number; previous: string;
  ownerEpoch: string; bootId: string; generation: number; backend: typeof BACKEND;
  runId: string | null; incarnation: string | null; revision: number;
  completionScope: 'full-run'; contractVersion: 1; stage: JournalStage | 'EPOCH';
  registration: JournalContainmentRegistration | null;
  completion: {admissionSealed: true; populated: 0; objectIdentity: string} | null;
};
type Envelope<T> = {payload: T; checksum: string};
type Head = {schemaVersion: 1; journalId: string; sequence: number; recordChecksum: string};
export type JournalObligation = Readonly<{
  runId: string; incarnation: string; ownerEpoch: string; bootId: string; generation: number;
  revision: number; stage: JournalStage; completionScope: 'full-run'; contractVersion: 1;
  registration: JournalContainmentRegistration | null;
}>;
declare const TOKEN: unique symbol;
/** The class also checks object identity. Copying these diagnostic fields grants nothing. */
export type JournalToken = Readonly<JournalObligation & {[TOKEN]: true}>;
export type JournalReplay = {busy: boolean; reason?: JournalReason; obligations: JournalObligation[]};
/** Inert metadata only. Registration handles, permission tokens and completion
 * proof objects never cross this read-only observation seam. */
export type JournalDiagnostics = Readonly<{
  busy: boolean; ready: boolean; replayed: boolean; epochReady: boolean; pending: boolean;
  reason: JournalReason | null;
  acknowledgedHead: Readonly<{sequence: number; recordChecksum: string}> | null;
  observedSequence: number;
  obligations: readonly Readonly<{
    runId: string; incarnation: string; ownerEpoch: string; generation: number;
    revision: number; stage: JournalStage; registered: boolean;
  }>[];
  completedCount: number;
}>;
type TokenState = {row: JournalObligation; launcherConsumed: boolean; launchConsumed: boolean; sealed: boolean};

export class RunnerJournalError extends HelperError {
  constructor(readonly reason: JournalReason) {
    super('RUNNER_JOURNAL_UNAVAILABLE', `Runner cleanup journal requires recovery (${reason}).`);
  }
}
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
const identity = (value: unknown): value is string => typeof value === 'string' && /^[0-9]{1,24}:[0-9]{1,24}$/u.test(value);
const integer = (value: unknown, minimum = 1): value is number => Number.isSafeInteger(value) && (value as number) >= minimum;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: unknown, expected: string[]): boolean => object(value) &&
  Object.keys(value).sort().join(',') === expected.slice().sort().join(',');
function canonical(value: unknown): string {
  if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
const encode = <T>(payload: T): string => canonical({payload, checksum: digest(payload)}) + '\n';
function decode<T>(text: string): Envelope<T> {
  const value: unknown = JSON.parse(text);
  if (!keys(value, ['payload', 'checksum']) || !object(value) || typeof value.checksum !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.checksum) || !object(value.payload) || digest(value.payload) !== value.checksum ||
    canonical(value) + '\n' !== text) throw new RunnerJournalError('journal-invalid');
  return value as Envelope<T>;
}
function validRegistration(value: unknown, incarnation: string): value is JournalContainmentRegistration {
  return keys(value, ['backend', 'namespaceId', 'name', 'objectIdentity']) && object(value) &&
    value.backend === BACKEND && uuid(value.namespaceId) && value.name === `run-${incarnation}` && identity(value.objectIdentity);
}
function validContext(context: JournalContext): boolean {
  return identity(context.directoryIdentity) && uuid(context.bootId) && uuid(context.ownerEpoch) && integer(context.generation) &&
    context.completionScope === 'full-run' && context.contractVersion === 1 && typeof context.isCurrent === 'function';
}
function validLimits(value: {maxRecords: number; maxBytes: number; maxRecordBytes: number}): boolean {
  return integer(value.maxRecords) && value.maxRecords <= JOURNAL_LIMITS.maxRecords && integer(value.maxBytes) &&
    value.maxBytes <= JOURNAL_LIMITS.maxBytes && integer(value.maxRecordBytes, 1024) && value.maxRecordBytes <= JOURNAL_LIMITS.maxRecordBytes;
}
function validManifest(value: unknown): value is Manifest {
  return keys(value, ['format', 'schemaVersion', 'journalId', 'directoryIdentity', 'bootId', 'backend', 'completionScope',
    'contractVersion', 'maxRecords', 'maxBytes', 'maxRecordBytes']) && object(value) && value.format === 'maddots-runner-journal' &&
    value.schemaVersion === 1 && uuid(value.journalId) && identity(value.directoryIdentity) && uuid(value.bootId) &&
    value.backend === BACKEND && value.completionScope === 'full-run' && value.contractVersion === 1 &&
    validLimits(value as unknown as Limits);
}
const filename = (sequence: number) => `journal-${String(sequence).padStart(10, '0')}.json`;
const journalName = (name: string) => name.startsWith('journal-');
// The runner directory also contains status/configuration and staging owned by
// their existing protocols. Recognizing their names grants no cleanup proof.
const companionFiles = new Set(['active.json', 'agents.json', 'runs.json', 'agents-catalog.json']);
const companionNames = new Set([...companionFiles, 'outcomes', 'staged', 'excludes', 'test-processes', 'activation',
  '.activation.lock', '.activation.lock.guard',
  '.test-process.lock', '.test-process.lock.guard']);
const companionName = (name: string) => {
  // Only known companion targets use this disjoint publication namespace.
  // Generic legacy, unknown-target and journal temporaries remain ambiguous.
  const temporary = /^\.(.+)\.([a-f0-9-]+)\.tmp$/u.exec(name);
  return companionNames.has(name) || !!temporary && companionFiles.has(temporary[1]) && uuid(temporary[2]) ||
    /^\.agent-setup-[a-f0-9]{64}\.lock(?:\.guard)?$/u.test(name) || /^agent-setup-[A-Za-z0-9]{6}$/u.test(name);
};

/**
 * Explicit fresh bootstrap, reviewed migration and isolated-test seam. The caller must already
 * own the retained directory and have separately proved old writers/workloads
 * extinct. Production startup must never invoke this function automatically.
 */
export async function initializeCleanJournal(directory: RunnerStorageDirectory, context: JournalContext,
  limits: {maxRecords: number; maxBytes: number; maxRecordBytes: number} = JOURNAL_LIMITS): Promise<void> {
  if (!validContext(context) || !validLimits(limits) || !context.isCurrent()) throw new RunnerJournalError('session-revoked');
  const names = await listBound(directory, JOURNAL_LIMITS.maxRecords + 32);
  // A missing manifest does not authorize overwriting even an empty old ledger.
  if (names.length) throw new RunnerJournalError('migration-required');
  const payload: Manifest = {format: 'maddots-runner-journal', schemaVersion: 1, journalId: randomUUID(),
    directoryIdentity: context.directoryIdentity, bootId: context.bootId, backend: BACKEND,
    completionScope: context.completionScope, contractVersion: context.contractVersion, ...limits};
  const manifestText = encode(payload), headText = encode<Head>({schemaVersion: 1, journalId: payload.journalId, sequence: 0, recordChecksum: ZERO});
  if (Buffer.byteLength(manifestText) + Buffer.byteLength(headText) > limits.maxBytes) throw new RunnerJournalError('storage-limit');
  await writeBound(directory, JOURNAL_HEAD, headText, {createOnly: true});
  if (!context.isCurrent()) throw new RunnerJournalError('session-revoked');
  await writeBound(directory, JOURNAL_MANIFEST, manifestText, {createOnly: true});
  if (!context.isCurrent()) throw new RunnerJournalError('session-revoked');
}

/**
 * Physical journal operations are invoked only through RunnerStorageOwner.operation.
 * This class does not acquire another lock, create a writer queue, or race I/O
 * against deadlines. The owner invalidates it when a caller stops waiting.
 */
export class RunnerJournal {
  private manifest?: Manifest;
  private replayed = false;
  private epochReady = false;
  private pending = false;
  private failure?: JournalReason;
  private sequence = 0;
  private acknowledgedHead?: Readonly<{sequence: number; recordChecksum: string}>;
  private checksum = ZERO;
  private bytes = 0;
  private headBytes = 0;
  private readonly rows = new Map<string, JournalObligation>();
  private readonly completed = new Map<string, JournalObligation>();
  private readonly incarnations = new Set<string>();
  private readonly epochs = new Set<string>();
  private readonly tokens = new WeakMap<object, TokenState>();
  private readonly currentTokens = new Map<string, JournalToken>();

  private readonly context: JournalContext;
  constructor(private readonly directory: RunnerStorageDirectory, context: JournalContext) {
    this.context = Object.freeze({...context, ...(context.backend ? {backend: Object.freeze({
      verifyRegistration: context.backend.verifyRegistration.bind(context.backend),
      verifyCompletion: context.backend.verifyCompletion.bind(context.backend),
    })} : {})});
    if (!validContext(context)) this.failure = 'contract-recovery-required';
  }
  get reason(): JournalReason | undefined {return this.failure;}
  get unresolvedReason(): JournalReason | undefined {return this.failure;}
  get ready(): boolean {return this.replayed && this.epochReady && !this.failure && !this.pending;}
  get unavailable(): boolean {return !!this.failure || !this.replayed;}
  get admissionBlocked(): boolean {return !this.ready;}
  get busy(): boolean {return !this.replayed || this.pending || !!this.failure || this.rows.size > 0;}
  get obligations(): ReadonlyMap<string, JournalObligation> {return new Map(this.rows);}
  /** Synchronous inspection of retained memory, never replay or capability
   * validation. A busy owner can safely report this without reacquiring a lock. */
  diagnosticSnapshot(): JournalDiagnostics {
    return Object.freeze({busy: this.busy, ready: this.ready, replayed: this.replayed, epochReady: this.epochReady,
      pending: this.pending, reason: this.failure ?? null,
      acknowledgedHead: this.acknowledgedHead ? Object.freeze({...this.acknowledgedHead}) : null,
      observedSequence: this.sequence,
      obligations: Object.freeze([...this.rows.values()].map(row => Object.freeze({runId: row.runId,
        incarnation: row.incarnation, ownerEpoch: row.ownerEpoch, generation: row.generation,
        revision: row.revision, stage: row.stage, registered: row.registration !== null}))), completedCount: this.completed.size});
  }
  /** Inventory comes only from the fully validated journal, including CLEAN
   * history. It never discovers or adopts an object from a filesystem scan. */
  get containmentRegistrations(): readonly JournalContainmentRegistration[] {
    this.assertCurrent();
    if (!this.replayed || this.pending) throw new RunnerJournalError('operation-ambiguous');
    return [...this.completed.values(), ...this.rows.values()].flatMap(row => row.registration ? [row.registration] : []);
  }
  get completedContainmentRegistrations(): readonly JournalContainmentRegistration[] {
    this.assertCurrent();
    if (!this.replayed || this.pending) throw new RunnerJournalError('operation-ambiguous');
    return [...this.completed.values()].flatMap(row => row.registration ? [row.registration] : []);
  }
  isClean(runId: string): boolean {return this.replayed && !this.failure && !this.pending && this.completed.has(runId);}
  invalidate(reason: JournalReason = 'operation-ambiguous'): void {
    this.failure ??= reason;
    for (const token of this.currentTokens.values()) this.tokens.get(token)!.sealed = true;
  }
  private result(): JournalReplay {
    return {busy: this.busy, ...(this.failure ? {reason: this.failure} : {}), obligations: [...this.rows.values()]};
  }
  private fail(reason: JournalReason): never {this.invalidate(reason); throw new RunnerJournalError(this.failure!);}
  private assertCurrent(): void {
    if (!this.context.isCurrent()) this.fail('session-revoked');
    if (this.failure) throw new RunnerJournalError(this.failure);
  }
  private begin(): void {
    this.assertCurrent();
    if (this.pending) this.fail('operation-ambiguous');
    this.pending = true;
  }
  private storageFailure(error: unknown): never {
    this.invalidate(error instanceof RunnerJournalError ? error.reason : 'storage-unavailable');
    throw new RunnerJournalError(this.failure!);
  }

  async replay(): Promise<JournalReplay> {
    if (this.replayed || this.pending || this.failure) {if (this.pending) this.invalidate(); return this.result();}
    this.begin();
    try {
      const names = await listBound(this.directory, JOURNAL_LIMITS.maxRecords + 32);
      if (!names.includes(JOURNAL_MANIFEST)) this.fail('migration-required');
      const text = await readBound(this.directory, JOURNAL_MANIFEST, 4096);
      const manifest = decode<Manifest>(text).payload;
      if (!validManifest(manifest) || manifest.directoryIdentity !== this.context.directoryIdentity) this.fail('journal-invalid');
      this.manifest = manifest; this.bytes = Buffer.byteLength(text);
      if (manifest.completionScope !== this.context.completionScope || manifest.contractVersion !== this.context.contractVersion) {
        this.fail('contract-recovery-required');
      }
      const headText = await readBound(this.directory, JOURNAL_HEAD, 1024);
      const head = decode<Head>(headText).payload;
      if (!keys(head, ['schemaVersion', 'journalId', 'sequence', 'recordChecksum']) || head.schemaVersion !== 1 ||
        head.journalId !== manifest.journalId || !integer(head.sequence, 0) || head.sequence > manifest.maxRecords ||
        typeof head.recordChecksum !== 'string' || !/^[a-f0-9]{64}$/u.test(head.recordChecksum)) this.fail('journal-invalid');
      this.acknowledgedHead = Object.freeze({sequence: head.sequence, recordChecksum: head.recordChecksum});
      this.headBytes = Buffer.byteLength(headText); this.bytes += this.headBytes;
      if (this.bytes > manifest.maxBytes) this.fail('storage-limit');
      const records = names.filter(name => name !== JOURNAL_MANIFEST && name !== JOURNAL_HEAD && journalName(name));
      if (records.length > manifest.maxRecords || names.some(name => ![JOURNAL_MANIFEST, JOURNAL_HEAD].includes(name) && !companionName(name) &&
        !/^journal-\d{10}\.json$/u.test(name))) this.fail('journal-invalid');
      let epoch: {ownerEpoch: string; generation: number} | undefined;
      for (const name of records) {
        if (name !== filename(this.sequence + 1)) this.fail('journal-invalid');
        const content = await readBound(this.directory, name, manifest.maxRecordBytes);
        this.bytes += Buffer.byteLength(content);
        if (this.bytes > manifest.maxBytes) this.fail('storage-limit');
        const record = decode<RecordPayload>(content);
        const row = record.payload;
        if (!this.validRecord(row, manifest)) this.fail('journal-invalid');
        if (row.stage === 'EPOCH') {
          if (this.rows.size || this.epochs.has(row.ownerEpoch)) this.fail('journal-invalid');
          this.epochs.add(row.ownerEpoch); epoch = {ownerEpoch: row.ownerEpoch, generation: row.generation};
        } else {
          if (!epoch || row.ownerEpoch !== epoch.ownerEpoch || row.generation !== epoch.generation) this.fail('journal-invalid');
          // A record ahead of the acknowledged cursor is an ambiguous tail.
          // Preserve its unresolved reservation, but never apply its CLEAN.
          if (row.stage !== 'CLEAN' || row.sequence <= head.sequence) this.apply(row);
        }
        this.sequence = row.sequence; this.checksum = record.checksum;
      }
      if (head.sequence !== this.sequence || head.recordChecksum !== this.checksum) this.fail('journal-invalid');
      // Even completely CLEAN history does not authorize accepting a new boot.
      if (manifest.bootId !== this.context.bootId) this.fail('boot-recovery-required');
      this.assertCurrent();
    } catch (error) {this.invalidate(error instanceof RunnerJournalError ? error.reason : 'journal-invalid');}
    finally {this.pending = false; this.replayed = true;}
    return this.result();
  }
  private validRecord(row: unknown, manifest: Manifest): row is RecordPayload {
    if (!keys(row, ['schemaVersion', 'journalId', 'sequence', 'previous', 'ownerEpoch', 'bootId', 'generation', 'backend',
      'runId', 'incarnation', 'revision', 'completionScope', 'contractVersion', 'stage', 'registration', 'completion']) || !object(row) ||
      row.schemaVersion !== 1 || row.journalId !== manifest.journalId || row.sequence !== this.sequence + 1 || row.previous !== this.checksum ||
      !uuid(row.ownerEpoch) || row.bootId !== manifest.bootId || !integer(row.generation) || row.backend !== BACKEND ||
      row.completionScope !== manifest.completionScope || row.contractVersion !== manifest.contractVersion) return false;
    if (row.stage === 'EPOCH') return row.runId === null && row.incarnation === null && row.revision === 0 && row.registration === null && row.completion === null;
    if (!uuid(row.runId) || !uuid(row.incarnation) || !STAGES.includes(row.stage as JournalStage) ||
      row.revision !== STAGES.indexOf(row.stage as JournalStage) + 1) return false;
    if (row.stage === 'INTENT' ? row.registration !== null : !validRegistration(row.registration, row.incarnation)) return false;
    return row.stage === 'CLEAN' ? keys(row.completion, ['admissionSealed', 'populated', 'objectIdentity']) && object(row.completion) &&
      row.completion.admissionSealed === true && row.completion.populated === 0 &&
      row.completion.objectIdentity === (row.registration as JournalContainmentRegistration).objectIdentity : row.completion === null;
  }
  private apply(row: RecordPayload): JournalObligation {
    const current = this.rows.get(row.runId!);
    if (row.stage === 'INTENT') {
      if (current || this.completed.has(row.runId!) || this.incarnations.has(row.incarnation!)) this.fail('journal-invalid');
      this.incarnations.add(row.incarnation!);
    } else if (!current || current.revision + 1 !== row.revision || current.incarnation !== row.incarnation ||
      current.ownerEpoch !== row.ownerEpoch || current.bootId !== row.bootId || current.generation !== row.generation ||
      current.completionScope !== row.completionScope || current.contractVersion !== row.contractVersion ||
      current.registration !== null && canonical(current.registration) !== canonical(row.registration)) this.fail('journal-invalid');
    const obligation: JournalObligation = Object.freeze({runId: row.runId!, incarnation: row.incarnation!, ownerEpoch: row.ownerEpoch,
      bootId: row.bootId, generation: row.generation, revision: row.revision, stage: row.stage as JournalStage,
      completionScope: row.completionScope, contractVersion: row.contractVersion,
      registration: row.registration && Object.freeze({...row.registration})});
    if (row.stage === 'CLEAN') {this.rows.delete(row.runId!); this.completed.set(row.runId!, obligation);}
    else this.rows.set(row.runId!, obligation);
    return obligation;
  }
  private makeRecord(stage: RecordPayload['stage'], row?: {runId: string; incarnation: string},
    registration: JournalContainmentRegistration | null = null): RecordPayload {
    return {schemaVersion: 1, journalId: this.manifest!.journalId, sequence: this.sequence + 1, previous: this.checksum,
      ownerEpoch: this.context.ownerEpoch, bootId: this.context.bootId, generation: this.context.generation, backend: BACKEND,
      runId: row?.runId ?? null, incarnation: row?.incarnation ?? null, revision: stage === 'EPOCH' ? 0 : STAGES.indexOf(stage) + 1,
      completionScope: this.context.completionScope, contractVersion: this.context.contractVersion, stage, registration,
      completion: stage === 'CLEAN' ? {admissionSealed: true, populated: 0, objectIdentity: registration!.objectIdentity} : null};
  }
  private async publish(row: RecordPayload): Promise<void> {
    const content = encode(row), manifest = this.manifest!, checksum = digest(row);
    const headText = encode<Head>({schemaVersion: 1, journalId: manifest.journalId, sequence: row.sequence, recordChecksum: checksum});
    if (row.sequence > manifest.maxRecords || Buffer.byteLength(content) > manifest.maxRecordBytes ||
      this.bytes + Buffer.byteLength(content) + Buffer.byteLength(headText) - this.headBytes > manifest.maxBytes) this.fail('storage-limit');
    await writeBound(this.directory, filename(row.sequence), content, {createOnly: true});
    // A durable late write remains an obligation. It never becomes a fresh
    // acknowledgment for a revoked/timed-out caller or releases CLEAN locally.
    this.assertCurrent();
    await writeBound(this.directory, JOURNAL_HEAD, headText);
    this.assertCurrent();
    this.acknowledgedHead = Object.freeze({sequence: row.sequence, recordChecksum: checksum});
    this.sequence = row.sequence; this.checksum = checksum;
    this.bytes += Buffer.byteLength(content) + Buffer.byteLength(headText) - this.headBytes;
    this.headBytes = Buffer.byteLength(headText);
  }
  async establishEpoch(): Promise<void> {
    this.begin();
    try {
      if (!this.replayed || !this.manifest || this.rows.size || this.epochReady || this.epochs.has(this.context.ownerEpoch)) {
        this.fail(this.rows.size ? 'containment-recovery-required' : 'journal-invalid');
      }
      await this.publish(this.makeRecord('EPOCH'));
      this.epochs.add(this.context.ownerEpoch); this.epochReady = true;
    } catch (error) {this.storageFailure(error);}
    finally {this.pending = false;}
  }
  private token(row: JournalObligation, previous?: TokenState): JournalToken {
    const token = Object.freeze({...row}) as JournalToken;
    this.tokens.set(token, {row, launcherConsumed: previous?.launcherConsumed ?? false,
      launchConsumed: previous?.launchConsumed ?? false, sealed: previous?.sealed ?? false});
    this.currentTokens.set(row.runId, token);
    return token;
  }
  private requireToken(token: JournalToken, stage: JournalStage): TokenState {
    this.assertCurrent();
    const state = this.tokens.get(token);
    if (!this.replayed || !this.epochReady || !state || this.currentTokens.get(token.runId) !== token || state.row.stage !== stage ||
      token.ownerEpoch !== this.context.ownerEpoch || token.generation !== this.context.generation) this.fail('session-revoked');
    return state;
  }
  async intent(input: {runId: string; incarnation: string}): Promise<JournalToken> {
    this.begin();
    try {
      if (!this.epochReady || !this.manifest || !uuid(input.runId) || !uuid(input.incarnation) || this.rows.has(input.runId) || this.completed.has(input.runId) ||
        this.incarnations.has(input.incarnation)) this.fail('journal-invalid');
      // Reserve all five transitions. Never start work whose normal retirement
      // already exceeds the immutable history's fixed capacity.
      const reserved = [...this.rows.values()].reduce((sum, row) => sum + 5 - row.revision, 0);
      if (this.sequence + reserved + 5 > this.manifest.maxRecords ||
        this.bytes + (reserved + 5) * this.manifest.maxRecordBytes > this.manifest.maxBytes) {
        this.fail('storage-limit');
      }
      const row = this.makeRecord('INTENT', input);
      // Keep the obligation in memory before any physical I/O can fail.
      const obligation = this.apply(row);
      await this.publish(row);
      return this.token(obligation);
    } catch (error) {return this.storageFailure(error);}
    finally {this.pending = false;}
  }
  consumeLauncher(token: JournalToken): boolean {
    const state = this.tokens.get(token);
    if (!this.context.isCurrent() || this.failure || this.pending || !this.epochReady || !state || state.sealed || state.launcherConsumed ||
      state.row.stage !== 'INTENT' || this.currentTokens.get(token.runId) !== token) return false;
    state.launcherConsumed = true; return true;
  }
  consumeLaunch(token: JournalToken): boolean {
    const state = this.tokens.get(token);
    if (!this.context.isCurrent() || this.failure || this.pending || !this.epochReady || !state || state.sealed || state.launchConsumed ||
      state.row.stage !== 'LAUNCH_ALLOWED' || this.currentTokens.get(token.runId) !== token) return false;
    state.launchConsumed = true; return true;
  }
  /** Invoke synchronously before queuing STOPPING on the owner's writer. */
  seal(token: JournalToken): void {
    const state = this.tokens.get(token);
    if (!state || this.currentTokens.get(token.runId) !== token) this.fail('session-revoked');
    state.sealed = true;
  }
  async bind(token: JournalToken, registration: JournalContainmentRegistration): Promise<JournalToken> {
    const previous = this.requireToken(token, 'INTENT');
    if (previous.sealed) this.fail('session-revoked');
    const candidate = Object.freeze({...registration});
    return this.transition(token, previous, 'CONTAINMENT_BOUND', async () => {
      if (!validRegistration(candidate, token.incarnation) || !this.context.backend ||
        !await this.context.backend.verifyRegistration(candidate)) this.fail('containment-unavailable');
      return candidate;
    });
  }
  async allow(token: JournalToken): Promise<JournalToken> {
    const previous = this.requireToken(token, 'CONTAINMENT_BOUND');
    if (previous.sealed) this.fail('session-revoked');
    return this.transition(token, previous, 'LAUNCH_ALLOWED', async () => token.registration!);
  }
  async stopping(token: JournalToken): Promise<JournalToken> {
    // Seal immediately, even if the owner queues this publication behind I/O.
    this.seal(token);
    const previous = this.requireToken(token, 'LAUNCH_ALLOWED');
    return this.transition(token, previous, 'STOPPING', async () => token.registration!);
  }
  async clean(token: JournalToken, proof: unknown): Promise<JournalToken> {
    const previous = this.requireToken(token, 'STOPPING');
    return this.transition(token, previous, 'CLEAN', async () => {
      if (!previous.sealed || !this.context.backend || !await this.context.backend.verifyCompletion(token.registration!, proof)) {
        this.fail('containment-unavailable');
      }
      return token.registration!;
    });
  }
  /** A cancelled trusted bootstrap can fail before its normal launch barrier.
   * Complete the same immutable history only after sealed-empty proof. Every
   * intermediate token stays sealed, so these records can never issue a start.
   * A crash during publication is conservatively replayed as an obligation. */
  async retireSealed(token: JournalToken, registration: JournalContainmentRegistration, proof: unknown): Promise<JournalToken> {
    this.seal(token);
    const previous = this.requireToken(token, token.stage);
    this.begin();
    try {
      const candidate = Object.freeze({...registration}), backend = this.context.backend;
      if (token.stage === 'CLEAN' || !validRegistration(candidate, token.incarnation) ||
        token.registration && canonical(token.registration) !== canonical(candidate) || !backend ||
        !await backend.verifyRegistration(candidate) || !await backend.verifyCompletion(candidate, proof)) this.fail('containment-unavailable');
      let retired = token;
      for (const stage of STAGES.slice(STAGES.indexOf(token.stage) + 1)) {
        this.assertCurrent();
        if (!await backend.verifyCompletion(candidate, proof)) this.fail('containment-unavailable');
        const record = this.makeRecord(stage, token, candidate);
        await this.publish(record);
        retired = this.token(this.apply(record), previous);
      }
      return retired;
    } catch (error) {return this.storageFailure(error);}
    finally {this.pending = false;}
  }
  private async transition(token: JournalToken, previous: TokenState, stage: JournalStage,
    registration: () => Promise<JournalContainmentRegistration>): Promise<JournalToken> {
    this.begin();
    try {
      const bound = await registration(); this.assertCurrent();
      const row = this.makeRecord(stage, token, bound);
      await this.publish(row);
      return this.token(this.apply(row), previous);
    } catch (error) {return this.storageFailure(error);}
    finally {this.pending = false;}
  }
  /** Boot-change retirement remains an explicit S5 migration operation. */
  recoverBootChange(): never {return this.fail('boot-recovery-required');}
  recoverSameBootContainment(): never;
  recoverSameBootContainment(runId: string, proof: unknown): Promise<void>;
  recoverSameBootContainment(runId?: string, proof?: unknown): Promise<void> | never {
    if (runId === undefined) return this.fail('containment-recovery-required');
    return this.recoverRegisteredContainment(runId, proof);
  }
  private async recoverRegisteredContainment(runId: string, proof: unknown): Promise<void> {
    this.begin();
    try {
      const row = this.rows.get(runId), backend = this.context.backend;
      // Replay never issues a launcher or start token. An unregistered intent,
      // corrupt history or a boot change stays busy.
      if (!this.replayed || this.epochReady || !row?.registration || row.bootId !== this.context.bootId ||
        !['CONTAINMENT_BOUND', 'LAUNCH_ALLOWED', 'STOPPING'].includes(row.stage) || !backend ||
        !await backend.verifyRegistration(row.registration) || !await backend.verifyCompletion(row.registration, proof)) {
        this.fail('containment-recovery-required');
      }
      this.assertCurrent();
      // Finish the old epoch's obligation before establishing the successor's
      // epoch. The new controller cannot obtain a live permission from these
      // records and must prove sealed admission on the retained kernel object.
      const record = (stage: 'LAUNCH_ALLOWED' | 'STOPPING' | 'CLEAN'): RecordPayload => ({
        ...this.makeRecord(stage, row, row.registration), ownerEpoch: row.ownerEpoch, generation: row.generation,
      });
      if (row.stage === 'CONTAINMENT_BOUND') {
        // This sealed recovery continuation emits no token or start message.
        const allowed = record('LAUNCH_ALLOWED');
        await this.publish(allowed); this.apply(allowed);
      }
      if (row.stage !== 'STOPPING') {
        const stopping = record('STOPPING');
        await this.publish(stopping); this.apply(stopping);
      }
      if (!await backend.verifyCompletion(row.registration, proof)) this.fail('containment-recovery-required');
      this.assertCurrent();
      const clean = record('CLEAN');
      await this.publish(clean); this.apply(clean);
    } catch (error) {this.storageFailure(error);}
    finally {this.pending = false;}
  }
}
