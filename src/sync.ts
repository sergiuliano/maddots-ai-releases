import { watch, type FSWatcher } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { treeDigest } from './shared/build-format.js';
import { planItemId } from './shared/plan-item-id.js';
import { TOOL_MATRIX } from './shared/tool-matrix.js';
import type { DetectedTool } from './detect.js';
import { ApiError, type ApiClient } from './api.js';
import { HelperError, clock, type Timing } from './config.js';
import { backupFolder, listBackups, restoreBackup, snapshotReadCopy } from './backups.js';
import { DeliveryRegistry, type DeliveryTarget } from './delivery/index.js';
import { ImportEngine } from './imports.js';
import { agentsFolderReloadHints } from './delivery/agents-folder.js';
import { duplicateQuestions, scanDuplicates, type DuplicateQuestion, type SyncQuestion } from './duplicates.js';
import { entryKey, LockStore, safeName, type LockEntry, type PendingWrite, type SkillLock } from './lock.js';
import { atomicWrite, assertNoSymlinks, ensurePaths, ensurePrivateDirectory, inside, readPrivateFile, withWriteLock, type HelperPaths } from './paths.js';
import { VERSION } from './release-identity.js';
import { assertRouteRoot, atomicWriteBuild, durableRename, readSkillTree, stageBuild } from './safe-fs.js';
import { makeStamp, readStamp, stampMatches } from './stamp.js';
import { BuildVerifier, type PlanItem, type SignedBuild, type VerifiedBuild } from './verify.js';
import { HoldingStore } from './holding.js';
import { listUnmanaged, unmanagedInventory, type UnmanagedInventory } from './unmanaged.js';
import { managedReadFolder, readLocalEdit } from './local-edits.js';
import { parseSendProposalInstruction, sendProposal } from './proposals.js';
import { completeUnmanagedSnapshot, readUnmanagedSnapshot, rememberUnmanagedSnapshot, reportUnmanagedSnapshot, unmanagedDigest, unmanagedSnapshot, type UnmanagedSnapshot } from './unmanaged-replacement.js';

type ReportedTool = Pick<DetectedTool, 'tool' | 'variant' | 'version' | 'models' | 'syncOnly'>;

export type SyncPlan = {planRevision: string; degraded: boolean; pollAfterSeconds: number; items: PlanItem[];
  revoked: {skillId: string; digest: string}[]; instructions: unknown[]};
export type DeliveryError = {skillId: string; target: string; name: string; code: string};
export type ManagedInventory = {skillId: string; target: string; name: string; version: number; settingsRevision: number;
  digest: string; localDigest: string | null; state: 'ok' | 'edited' | 'missing' | 'held'};
export type SyncInventory = {
  helperVersion: string; computerName: string; os: 'macos' | 'linux' | 'windows'; tokenStorage: 'keychain' | 'file'; tools: ReportedTool[];
  managed: ManagedInventory[]; duplicates: unknown[]; unmanaged: unknown[]; holdingCount: number; deliveryErrors: DeliveryError[];
};
export type SyncOptions = {
  paths: HelperPaths; helperId: string; client: Pick<ApiClient, 'request'>; targets: readonly DeliveryTarget[];
  verifier?: BuildVerifier; timing?: Timing; computerName?: string; tools?: ReportedTool[]; tokenStorage?: 'keychain' | 'file';
  /** TLS-14 checks a local Allow record for this exact skill/version/settings/digest. */
  allowedBuild?: (build: SignedBuild) => Promise<boolean>;
  /** A Replace choice needs a new local Allow, rather than an earlier build allowance. */
  allowedReplacement?: (build: SignedBuild, item: PlanItem) => Promise<boolean>;
  hold?: (build: VerifiedBuild, item: PlanItem) => Promise<void>;
  holdingCount?: () => Promise<number>;
  inventoryExtras?: () => Promise<{unmanaged: unknown[]; duplicates: unknown[]}>;
  crash?: (step: 'staged' | 'backed_up' | 'placed' | 'locked' | 'proposal_sent' | 'holding') => void | Promise<void>;
  watchRoute?: (root: string, changed: () => void) => {close(): void};
};
type SyncMeta = {format: 1; planRevision: string | null; revoked: SyncPlan['revoked']; pollAfterSeconds: number; degraded?: boolean};
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const exists = async (path: string) => { try { await lstat(path); return true; } catch (error) { if (absent(error)) return false; throw error; } };
const codeFor = (error: unknown) => error instanceof HelperError ? error.code :
  typeof (error as NodeJS.ErrnoException)?.code === 'string' && /^[A-Z_]{1,60}$/.test((error as NodeJS.ErrnoException).code!) ? (error as NodeJS.ErrnoException).code! : 'DELIVERY_FAILED';
const cachedEnvelope = (paths: HelperPaths, digest: string, signature: string) =>
  join(paths.data, 'cache/builds', digest + '-' + createHash('sha256').update(signature).digest('hex') + '.json');

/** Independently checks the on-disk cache. C2 must supply this helper's paths and trust roots. */
export async function verifiedBuild(digest: string, options: {paths: HelperPaths; verifier?: BuildVerifier;
  helperId: string; agentId?: string; revoked?: SyncPlan['revoked']; accepted?: Pick<LockEntry, 'skillId' | 'target' | 'name'>;
  allowedBuild?: (build: SignedBuild) => Promise<boolean>}): Promise<VerifiedBuild> {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new HelperError('BUILD_DIGEST_INVALID', 'Invalid build digest.');
  const verifier = options.verifier ?? new BuildVerifier();
  let revoked: SyncPlan['revoked'] = [];
  try {
    const meta: SyncMeta = JSON.parse(await readPrivateFile(join(options.paths.data, 'sync-meta.json'), 4 * 1024 * 1024));
    if (!Array.isArray(meta.revoked) || meta.revoked.some(entry => !entry || !safeName(entry.skillId) || !/^[a-f0-9]{64}$/.test(entry.digest))) throw new HelperError('SYNC_META_INVALID', 'The sync revocation list is invalid.');
    revoked = meta.revoked;
  } catch (error) { if (!absent(error)) throw error; }
  revoked = [...revoked, ...options.revoked ?? []];
  const locks = await Promise.all([new LockStore(options.paths, options.helperId).read(), new LockStore(options.paths, options.helperId, 'agent-lock.json').read()]);
  const accepted = (options.agentId ? locks[1].entries.filter(entry => entry.agentId === options.agentId) : locks[0].entries).find(entry => entry.digest === digest && !entry.removed &&
    (!options.accepted || entryKey(entry) === entryKey(options.accepted)));
  if (!accepted) throw new HelperError('BUILD_NOT_ACCEPTED', 'This build is not the accepted version for this tool or agent.');
  const build = verifier.verifyCached(JSON.parse(await readPrivateFile(cachedEnvelope(options.paths, digest, accepted.signature), 16 * 1024 * 1024)), digest, revoked);
  if (entryKey(accepted) !== entryKey(build.build) || accepted.version !== build.build.version || accepted.settingsRevision !== build.build.settingsRevision || accepted.signature !== build.build.signature) {
    throw new HelperError('BUILD_CACHE_INVALID', 'The cached envelope does not match its accepted version.');
  }
  const hasCode = build.hasCode || accepted.hasCode;
  if (hasCode && !await options.allowedBuild?.(build.build)) throw new HelperError('BUILD_HELD', 'This code build still needs Allow on this computer.');
  return {...build, hasCode};
}

export class SyncEngine {
  readonly holding: HoldingStore;
  readonly locks: LockStore;
  readonly agentLocks: LockStore;
  readonly verifier: BuildVerifier;
  readonly routes: DeliveryRegistry;
  private readonly timing: Timing;
  private meta: SyncMeta = {format: 1, planRevision: null, revoked: [], pollAfterSeconds: 60};
  private readonly errors = new Map<string, DeliveryError>();
  private watched = new Map<string, FSWatcher | {close(): void}>();
  private nextInventory = 0;
  private nextPlan = 0;
  private changedAt: number | null = null;
  private firstFailure: number | null = null;
  private failures = 0;
  private initialized = false;
  private stoppedForToken = false;
  private tokenRetryAt = 0;
  private questionItems: PlanItem[] = [];
  private duplicateRevision = '[]';
  private nextWatchAt = 0;
  private nextReportAt = 0;
  private reportFailures = 0;
  private lastHoldingCount = 0;
  private readonly readCopyRetries = new Set<string>();
  private readonly conflictSnapshots = new WeakMap<unknown[], UnmanagedSnapshot[]>();
  constructor(private readonly options: SyncOptions) {
    this.locks = new LockStore(options.paths, options.helperId); this.agentLocks = new LockStore(options.paths, options.helperId, 'agent-lock.json');
    this.verifier = options.verifier ?? new BuildVerifier();
    this.holding = new HoldingStore(options.paths, options.helperId, this.verifier, options.timing ?? clock);
    this.routes = new DeliveryRegistry(options.targets); this.timing = options.timing ?? clock;
  }
  get retryAt(): number { return this.nextPlan; }
  get client(): Pick<ApiClient, 'request'> { return this.options.client; }
  private error(entry: Pick<LockEntry, 'skillId' | 'target' | 'name'>, error: unknown): void {
    const code = codeFor(error);
    if (this.errors.get(entryKey(entry))?.code !== code) this.notifyChange();
    this.errors.set(entryKey(entry), {skillId: entry.skillId, target: entry.target, name: entry.name, code});
  }
  private importRetry(error: unknown): void {
    const code = codeFor(error);
    // Local import and journal failures retry independently of plan polling.
    // Report only a safe code to the helper log, never a fabricated inventory skill.
    if (error instanceof ApiError || code.startsWith('TOKEN_') || code.startsWith('API_')) throw error;
    console.error(`Replace local copies will retry locally: ${code}`);
  }
  private async routeRoot(target: DeliveryTarget): Promise<string> {
    const definition = Object.hasOwn(TOOL_MATRIX.routes, target.route) ? TOOL_MATRIX.routes[target.route] : undefined;
    const root = resolve(await target.root());
    if (!definition || definition.target !== target.target || !definition.path.startsWith('~/') ||
        root !== resolve(this.options.paths.home, definition.path.slice(2))) throw new HelperError('ROUTE_INVALID', 'The adapter root does not match its allowed delivery route.');
    await assertRouteRoot(this.options.paths, root); return root;
  }
  private async destination(target: DeliveryTarget, entry: Pick<LockEntry, 'skillId' | 'target' | 'name' | 'workspaceId'>): Promise<string> {
    const root = await this.routeRoot(target);
    const destination = resolve(target.folderFor(entry));
    if (destination === root || !inside(root, destination) || basename(destination) !== entry.name) {
      throw new HelperError('PATH_UNSAFE', 'The delivery adapter selected an unsafe destination.');
    }
    await assertNoSymlinks(destination, this.options.paths.home);
    return destination;
  }
  private async finishHolding(item: Pick<PlanItem, 'itemId'>): Promise<void> {
    try {
      await this.holding.finish(item.itemId);
      const held = join(this.options.paths.holding, item.itemId + '.json');
      if (!await exists(held)) return;
      const archive = join(this.options.paths.data, 'holding-records'); await ensurePrivateDirectory(archive);
      await durableRename(held, join(archive, item.itemId + '-' + randomUUID() + '.json'));
    } catch (error) { this.holdingFailure(error); }
  }
  private holdingFailure(error: unknown): void {
    const code = codeFor(error);
    if (error instanceof ApiError || code.startsWith('TOKEN_')) throw error;
    this.notifyChange();
  }
  private async finishRecoveredChoice(pending: PendingWrite): Promise<void> {
    if (!pending.itemId) return;
    if (pending.unmanagedDigest) {
      await completeUnmanagedSnapshot(this.options.paths, pending.helperId, {...pending.entry, itemId: pending.itemId}, pending.unmanagedDigest);
      return;
    }
    const receipt = join(this.options.paths.data, 'local-choices', pending.itemId + '.replace.json');
    let choice;
    try { choice = JSON.parse(await readPrivateFile(receipt)); } catch (error) { if (absent(error)) return; throw error; }
    if (choice.answer !== 'replace' || choice.itemId !== pending.itemId || choice.digest !== pending.entry.digest ||
        choice.version !== pending.entry.version || choice.settingsRevision !== pending.entry.settingsRevision) {
      throw new HelperError('LOCAL_EDIT_INVALID', 'The recovered choice does not match its placement.');
    }
    if (choice.readDigest) {
      choice.held = false;
      choice.placed = true;
      await atomicWrite(receipt, JSON.stringify(choice) + '\n');
      // Recovery finishes placement only. The normal Replace retry refreshes
      // the read copy without keeping a completed delivery journal pending.
      return;
    }
    await atomicWrite(receipt, JSON.stringify({...choice, completed: true}) + '\n');
  }
  private async commit(entry: LockEntry): Promise<void> {
    const lock = await this.locks.read();
    lock.entries = [...lock.entries.filter(value => entryKey(value) !== entryKey(entry)), entry];
    lock.updatedAt = new Date(this.timing.now()).toISOString(); await this.locks.write(lock);
  }
  private async checkUnmanagedBackup(pending: PendingWrite, destination: string): Promise<void> {
    if (!pending.unmanagedDigest) return;
    const backup = (await listBackups(this.options.paths)).find(value => value.id === pending.backupId && value.reason === 'unmanaged_replaced' &&
      value.digest === pending.unmanagedDigest && value.route === pending.entry.route && value.folderName === pending.entry.name &&
      resolve(this.options.paths.home, value.originalPath) === destination);
    if (!backup) throw new HelperError('RECOVERY_CONFLICT', 'The unmanaged source has no matching replacement backup.');
    const folder = join(this.options.paths.backups, backup.id, backup.route, backup.folderName);
    let matches = false;
    try { matches = await unmanagedDigest(this.options.paths, folder, this.options.paths.data) === pending.unmanagedDigest; }
    catch { /* Any unreadable or concurrently changed backup must be returned before refusing. */ }
    if (!matches) {
      if (!await exists(destination)) {
        await restoreBackup(this.options.paths, backup.id);
        await this.locks.setPending(entryKey(pending.entry), null);
      }
      throw new HelperError('UNMANAGED_CHANGED', 'The unmanaged folder changed during backup. Its contents were preserved.');
    }
  }
  private async recover(pending: PendingWrite): Promise<void> {
    const key = entryKey(pending.entry), lock = await this.locks.read();
    if (!this.locks.knownIds(lock).includes(pending.helperId)) throw new HelperError('JOURNAL_INVALID', 'The pending helper does not belong to the adopted lock.');
    const target = this.routes.get(pending.entry.route);
    if (target.target !== pending.entry.target) throw new HelperError('ROUTE_INVALID', 'The pending target changed.');
    const destination = await this.destination(target, pending.entry);
    if (pending.operation === 'remove') {
      // Only a durable forced-removal transaction may be resumed without a plan.
      if (pending.entry.acceptedBy !== 'forced' || !pending.prior) throw new HelperError('JOURNAL_INVALID', 'Invalid pending removal.');
      if (await exists(destination)) await backupFolder(this.options.paths, destination, target.route, 'forced_remove', await this.localDigest(destination), this.timing.now());
      await target.remove(pending.entry, 'forced_remove'); await this.commit(pending.entry); await this.locks.setPending(key, null); return;
    }
    const staged = join(this.options.paths.data, 'staging', pending.stagedName!);
    // Re-pairing adopts the journal, while consent remains bound to its original helper.
    const snapshot = pending.unmanagedDigest ? await readUnmanagedSnapshot(this.options.paths, pending.helperId,
      {...pending.entry, itemId: pending.itemId!}) : undefined;
    if (snapshot && (!snapshot.reported || snapshot.digest !== pending.unmanagedDigest)) {
      throw new HelperError('RECOVERY_CONFLICT', 'The unmanaged replacement consent changed.');
    }
    if (await exists(destination)) {
      let stamp;
      try { stamp = await readStamp(destination, this.verifier, this.locks.knownIds(lock)); }
      catch (error) { if (!absent(error) && !(error instanceof HelperError)) throw error; /* Any unreadable or unverifiable stamp is an edited copy. */ }
      if (stamp && stampMatches(stamp, pending.entry)) {
        if (pending.unmanagedDigest) {
          if (await this.localDigest(destination) !== pending.entry.digest) {
            throw new HelperError('UNMANAGED_CHANGED', 'The replacement folder changed during recovery. It was kept.');
          }
          await this.checkUnmanagedBackup(pending, destination);
        }
        await this.commit(pending.entry); if (pending.itemId) await this.finishHolding({itemId: pending.itemId}); await this.finishRecoveredChoice(pending); await this.locks.setPending(key, null); return;
      }
      if (!pending.prior && !pending.unmanagedDigest) throw new HelperError('RECOVERY_CONFLICT', 'The destination changed during a pending delivery.');
    }
    if (this.meta.revoked.some(entry => entry.digest === pending.entry.digest)) {
      // Retain staging and backups, but never finish placement of a newly revoked build.
      await this.locks.setPending(key, null); return;
    }
    if (!await exists(staged)) throw new HelperError('RECOVERY_MISSING', 'The staged skill is missing. Existing copies and backups are preserved.');
    const stamp = await readStamp(staged, this.verifier, this.locks.knownIds(lock));
    if (!stampMatches(stamp, pending.entry) || treeDigest(await readSkillTree(staged, this.options.paths.data)) !== pending.entry.digest) throw new HelperError('RECOVERY_INVALID', 'The staged skill changed during delivery.');
    const build = this.verifier.verifyCached(JSON.parse(await readPrivateFile(cachedEnvelope(this.options.paths, pending.entry.digest, pending.entry.signature), 16 * 1024 * 1024)), pending.entry.digest, this.meta.revoked);
    if (build.build.skillId !== pending.entry.skillId || build.build.name !== pending.entry.name || build.build.version !== pending.entry.version ||
        build.build.settingsRevision !== pending.entry.settingsRevision || build.build.signature !== pending.entry.signature || build.build.target !== pending.entry.target ||
        build.build.keyId !== pending.entry.keyId || build.build.workspaceId !== pending.entry.workspaceId) {
      throw new HelperError('RECOVERY_INVALID', 'The cached build does not match the pending delivery.');
    }
    if (build.hasCode && !pending.entry.allowedDigests.includes(build.build.digest)) throw new HelperError('BUILD_HELD', 'The pending build needs Allow.');
    if (pending.unmanagedDigest) {
      // Completed consent may only finish cleanup of a verified placement above.
      if (snapshot!.completed) throw new HelperError('RECOVERY_CONFLICT', 'The unmanaged replacement consent changed.');
      if (await exists(destination) && await unmanagedDigest(this.options.paths, destination) !== pending.unmanagedDigest) {
        throw new HelperError('UNMANAGED_CHANGED', 'The unmanaged folder changed since its conflict was reported. It was kept.');
      }
      if (!await exists(destination) && !(await listBackups(this.options.paths)).some(backup => backup.id === pending.backupId &&
          backup.reason === 'unmanaged_replaced' && backup.digest === pending.unmanagedDigest && backup.route === target.route &&
          resolve(this.options.paths.home, backup.originalPath) === destination)) {
        throw new HelperError('RECOVERY_CONFLICT', 'The unmanaged source has no matching replacement backup.');
      }
    }
    if (await exists(destination)) await backupFolder(this.options.paths, destination, target.route,
      pending.unmanagedDigest ? 'unmanaged_replaced' : 'recovery', pending.unmanagedDigest ?? await this.localDigest(destination), this.timing.now(), async manifest => {
      if (pending.unmanagedDigest && await unmanagedDigest(this.options.paths, destination) !== pending.unmanagedDigest) {
        throw new HelperError('UNMANAGED_CHANGED', 'The unmanaged folder changed before it could be backed up. It was kept.');
      }
      pending.backupId = manifest.id; await this.locks.setPending(key, pending);
    });
    await this.checkUnmanagedBackup(pending, destination);
    try { await target.place(build.build, staged); }
    catch (error) {
      if (pending.backupId && !await exists(destination)) {
        await restoreBackup(this.options.paths, pending.backupId); await this.locks.setPending(key, null);
      }
      throw error;
    }
    await this.commit(pending.entry); if (pending.itemId) await this.finishHolding({itemId: pending.itemId}); await this.finishRecoveredChoice(pending); await this.locks.setPending(key, null);
  }
  private async recoverPending(): Promise<Set<string>> {
    const stuck = new Set<string>();
    for (const pending of await this.locks.allPending()) {
      try { await this.recover(pending); }
      catch (error) { this.error(pending.entry, error); stuck.add(entryKey(pending.entry)); }
    }
    return stuck;
  }
  async reconcile(): Promise<void> {
    await ensurePaths(this.options.paths);
    try {
      const value: SyncMeta = JSON.parse(await readPrivateFile(join(this.options.paths.data, 'sync-meta.json'), 4 * 1024 * 1024));
      if (value.format !== 1 || !Array.isArray(value.revoked) || value.revoked.some(entry => !entry || !safeName(entry.skillId) || !/^[a-f0-9]{64}$/.test(entry.digest))) throw new Error();
      if (value.pollAfterSeconds !== undefined && (!Number.isFinite(value.pollAfterSeconds) || value.pollAfterSeconds < 1 || value.pollAfterSeconds > 86400)) throw new Error();
      if (value.degraded !== undefined && typeof value.degraded !== 'boolean') throw new Error();
      this.meta = {...value, pollAfterSeconds: value.pollAfterSeconds ?? 60};
    } catch (error) { if (!absent(error)) throw new HelperError('SYNC_META_INVALID', 'The sync metadata is invalid.'); }
    await withWriteLock(this.options.paths, async () => {
      await this.locks.adopt(); await this.agentLocks.adopt();
      await this.recoverPending();
    }, this.timing);
    await this.inventory(); this.initialized = true;
  }
  private async localDigest(folder: string): Promise<string | null> {
    try { return treeDigest(await readSkillTree(folder, this.options.paths.home)); } catch { return null; }
  }
  async inventory(): Promise<SyncInventory> {
    const lock = await this.locks.read(); const managed: ManagedInventory[] = [];
    const heldKeys = new Set<string>();
    try {
      for (const held of await this.holding.entries()) {
        if (held.item.kind === 'local_newer' && held.item.answer === 'replace' && !held.item.forAgentIds.length) heldKeys.add(entryKey(held.item));
      }
    } catch (error) { this.holdingFailure(error); }
    for (const entry of lock.entries) {
      let state: ManagedInventory['state'] = 'missing', localDigest: string | null = null;
      try {
        const target = this.routes.get(entry.route);
        const destination = await this.destination(target, entry);
        // Adapters that observe their own cache also retain source integrity checks.
        const folder = target.readFolderFor ? destination : await managedReadFolder(this.options.paths, entry, destination, target);
        // Removed entries retain acceptance history. Only a restored copy with
        // a matching trusted stamp belongs to that history; fresh folders are unmanaged.
        if (await exists(folder) && (!entry.removed || await readStamp(folder, this.verifier, this.locks.knownIds(lock))
          .then(stamp => stampMatches(stamp, entry)).catch(() => false))) {
          state = 'edited'; localDigest = await this.localDigest(folder);
          const stamp = await readStamp(folder, this.verifier, this.locks.knownIds(lock));
          if (!entry.removed && stampMatches(stamp, entry) && localDigest === entry.digest) state = 'ok';
        }
      } catch (error) { if (!absent(error)) { state = 'edited'; this.error(entry, error); } }
      if (state === 'missing' && heldKeys.has(entryKey(entry))) state = 'held';
      managed.push({skillId: entry.skillId, target: entry.target, name: entry.name, version: entry.version,
        settingsRevision: entry.settingsRevision, digest: entry.digest, localDigest, state});
    }
    const live = lock.entries.filter(entry => !entry.removed);
    const extras = await this.options.inventoryExtras?.() ?? {duplicates: await scanDuplicates({paths: this.options.paths,
      tools: this.options.tools ?? [], managed: live, managedFolders: this.managedFolders(live), verifier: this.verifier,
      helperIds: this.locks.knownIds(lock)}), unmanaged: await this.unmanaged(lock)};
    let holdingCount = this.lastHoldingCount;
    try {
      holdingCount = await this.options.holdingCount?.() ?? await this.holding.count();
      this.lastHoldingCount = holdingCount;
    } catch (error) { this.holdingFailure(error); }
    const unmanaged = extras.unmanaged.slice(0, 2000);
    const reportedConflicts = new Set(unmanaged.flatMap(value => {
      const conflict = (value as {canonicalConflict?: Pick<PlanItem, 'skillId' | 'target' | 'name'>} | null)?.canonicalConflict;
      return conflict ? [entryKey(conflict)] : [];
    }));
    this.conflictSnapshots.set(unmanaged, (this.conflictSnapshots.get(extras.unmanaged) ?? []).filter(snapshot => reportedConflicts.has(entryKey(snapshot))));
    return {helperVersion: VERSION, computerName: this.options.computerName ?? 'Computer', os: 'macos', tokenStorage: this.options.tokenStorage ?? 'keychain',
      tools: (this.options.tools ?? []).map(tool => ({tool: tool.tool, variant: tool.variant, version: tool.version, models: tool.models.slice(0, 50), syncOnly: tool.syncOnly})), managed,
      unmanaged, duplicates: extras.duplicates.slice(0, 2000), holdingCount,
      deliveryErrors: [...this.errors.values()]};
  }
  /** Only an accepted report establishes the durable local replacement baseline. */
  async reportInventory(): Promise<void> {
    const report = await this.inventory();
    const snapshots = this.conflictSnapshots.get(report.unmanaged) ?? [];
    if (snapshots.length) await withWriteLock(this.options.paths, async () => {
      for (const snapshot of snapshots) await rememberUnmanagedSnapshot(this.options.paths, snapshot);
    }, this.timing);
    await this.options.client.request('/api/helper/inventory', {method: 'POST', body: report});
    if (snapshots.length) await withWriteLock(this.options.paths, async () => {
      for (const snapshot of snapshots) await reportUnmanagedSnapshot(this.options.paths, snapshot);
    }, this.timing);
  }
  /** Local presentation seam for TLS-07/10; no answer or replacement is implied. */
  async questions(): Promise<SyncQuestion[]> {
    const items = this.questionItems.filter(item => item.state === 'asking' && !item.forAgentIds.length);
    const duplicates = await this.localCopyQuestions();
    return items.map(item => ({...item, restartHints: item.route === 'agents-folder' ? agentsFolderReloadHints(this.options.tools ?? []) : item.restartHints,
      duplicates: duplicates.filter(duplicate => duplicate.skillId === item.skillId)}));
  }
  /** Duplicates still need attention when there is no install/update question. */
  async localCopyQuestions(): Promise<DuplicateQuestion[]> {
    const lock = await this.locks.read();
    const managed = [...lock.entries.filter(entry => !entry.removed), ...this.questionItems.filter(item => !item.forAgentIds.length && item.kind !== 'forced_remove')];
    return duplicateQuestions(await scanDuplicates({paths: this.options.paths, tools: this.options.tools ?? [],
      managed, managedFolders: this.managedFolders(managed),
      verifier: this.verifier, helperIds: this.locks.knownIds(lock)}));
  }
  private managedFolders(entries: readonly Pick<LockEntry, 'skillId' | 'target' | 'name' | 'workspaceId' | 'route'>[]): string[] {
    return entries.flatMap(entry => {
      try { return [resolve(this.routes.get(entry.route).folderFor(entry))]; }
      catch (error) {
        if (!(error instanceof HelperError)) throw error;
        const route = Object.hasOwn(TOOL_MATRIX.routes, entry.route) ? TOOL_MATRIX.routes[entry.route] : undefined;
        return route?.kind === 'folder' && route.path.startsWith('~/') && safeName(entry.name) ?
          [resolve(this.options.paths.home, route.path.slice(2), entry.name)] : [];
      }
    });
  }
  private async unmanaged(lock: SkillLock): Promise<unknown[]> {
    const folders = await listUnmanaged(this.options.paths, {verifier: this.verifier, helperIds: this.locks.knownIds(lock)});
    const inventory: (UnmanagedInventory & {canonicalConflict?: {skillId: string; target: string; name: string}})[] = unmanagedInventory(folders);
    // TLS-15: an unmanaged directory in the shared agents folder that blocks a canonical delivery is reported as a conflict.
    const agentsTarget = this.routes.all().find(target => target.route === 'agents-folder');
    let agentsRoot: string | undefined;
    try { agentsRoot = agentsTarget ? await this.routeRoot(agentsTarget) : undefined; }
    catch (error) { if (!absent(error) && !(error instanceof HelperError && ['PATH_UNSAFE', 'ROUTE_INVALID'].includes(error.code))) throw error; }
    if (!agentsRoot) return inventory;
    const snapshots: UnmanagedSnapshot[] = [];
    for (const folder of folders) {
      if (folder.link || dirname(folder.path) !== agentsRoot) continue;
      const conflict = this.questionItems.find(item =>
        item.route === 'agents-folder' && item.name === folder.folderName && !item.forAgentIds.length && item.kind !== 'forced_remove');
      const entry = conflict && inventory.find(ref => ref.home === folder.home && ref.folderName === folder.folderName);
      if (conflict && entry) {
        entry.canonicalConflict = {skillId: conflict.skillId, target: conflict.target, name: conflict.name};
        try { snapshots.push(unmanagedSnapshot(this.options.helperId, conflict, await unmanagedDigest(this.options.paths, folder.path))); }
        catch { /* Unreadable trees remain visible, but cannot authorize replacement. */ }
      }
    }
    this.conflictSnapshots.set(inventory, snapshots);
    return inventory;
  }
  validatePlan(plan: SyncPlan): void {
    if (!plan || typeof plan.planRevision !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(plan.planRevision) || typeof plan.degraded !== 'boolean' ||
        !Number.isFinite(plan.pollAfterSeconds) || plan.pollAfterSeconds < 1 || plan.pollAfterSeconds > 86400 || !Array.isArray(plan.items) || plan.items.length > 2000 ||
        !Array.isArray(plan.revoked) || plan.revoked.some(entry => !entry || !safeName(entry.skillId) || !/^[a-f0-9]{64}$/.test(entry.digest)) || !Array.isArray(plan.instructions)) {
      throw new HelperError('PLAN_INVALID', 'The sync plan is invalid.');
    }
    for (const item of plan.items) {
      if (!item || !/^[a-f0-9]{64}$/.test(item.itemId) || !safeName(item.skillId) || !safeName(item.name) || !safeName(item.sourceName) || !safeName(item.route) || !safeName(item.workspaceId) ||
          !Array.isArray(item.workspaceIds) || item.workspaceIds.some(id => !safeName(id)) || !Array.isArray(item.forAgentIds) || item.forAgentIds.length > 1 || item.forAgentIds.some(id => !safeName(id)) ||
          !Array.isArray(item.boardIds) || item.boardIds.some(id => !safeName(id)) || !Array.isArray(item.missingDependencies) ||
          !Number.isSafeInteger(item.version) || item.version < 1 || !Number.isSafeInteger(item.settingsRevision) || item.settingsRevision < 0 || !/^[a-f0-9]{64}$/.test(item.digest) ||
          !['folder', 'claude-plugin', 'desktop-zip'].includes(item.target) ||
          !['install', 'update', 'local_newer', 'forced_remove', 'forced_restore'].includes(item.kind) ||
          !['asking', 'approved', 'later', 'kept_local', 'forced', 'held', 'delivered', 'failed'].includes(item.state)) throw new HelperError('PLAN_INVALID', 'A sync item is invalid.');
    }
  }
  async applyPlan(plan: SyncPlan, beforeApply?: (current: SyncPlan) => Promise<void>): Promise<void> {
    this.validatePlan(plan);
    this.questionItems = plan.items.map(item => structuredClone(item));
    const duplicatesBefore = JSON.stringify(await this.localCopyQuestions());
    await withWriteLock(this.options.paths, async () => {
      // The CLI and service have separate engines. Revocation evidence written
      // by either one remains binding when the other applies an older snapshot.
      let persistedRevoked: SyncPlan['revoked'] = [];
      try {
        const saved: SyncMeta = JSON.parse(await readPrivateFile(join(this.options.paths.data, 'sync-meta.json'), 4 * 1024 * 1024));
        if (saved.format !== 1 || !Array.isArray(saved.revoked) || saved.revoked.some(entry =>
          !entry || !safeName(entry.skillId) || !/^[a-f0-9]{64}$/.test(entry.digest))) throw new HelperError('SYNC_META_INVALID', 'Invalid persisted revocation evidence.');
        persistedRevoked = saved.revoked;
      } catch (error) {if (!absent(error)) throw error;}
      plan = {...plan, revoked: [...new Map([...persistedRevoked, ...this.meta.revoked, ...plan.revoked].map(entry => [entry.digest, entry])).values()]};
      await beforeApply?.(plan);
      this.readCopyRetries.clear();
      this.meta = {...this.meta, revoked: plan.revoked, pollAfterSeconds: plan.pollAfterSeconds, degraded: plan.degraded};
      await atomicWrite(join(this.options.paths.data, 'sync-meta.json'), JSON.stringify(this.meta) + '\n');
      try { await this.holding.reconcile(plan.items, plan.revoked, plan.degraded); }
      catch (error) { this.holdingFailure(error); }
      // New revocation evidence takes priority over an interrupted placement.
      const stuck = await this.recoverPending();
      const outcomes = new Map<string, boolean>(), visiting = new Set<string>(), written = new Map<string, PlanItem>();
      let retryUpload: unknown;
      const apply = async (item: PlanItem): Promise<boolean> => {
        if (outcomes.has(item.itemId)) return outcomes.get(item.itemId)!;
        if (stuck.has(entryKey(item))) { outcomes.set(item.itemId, false); return false; }
        if (visiting.has(item.itemId)) throw new HelperError('DEPENDENCY_CYCLE', 'The plan contains a dependency cycle.');
        visiting.add(item.itemId);
        const localChoice = item.kind === 'local_newer' && item.answer === 'keep_local' && item.state === 'kept_local';
        if ((item.state !== 'approved' && item.state !== 'held' && item.state !== 'forced' && !localChoice) ||
            (plan.degraded && !(item.state === 'forced' && ['revoked', 'security_fix'].includes(item.reason ?? '')))) { outcomes.set(item.itemId, false); return false; }
        try {
          if (item.kind === 'local_newer' && ['keep_local', 'send_proposal', 'publish'].includes(item.answer ?? '')) {
            const ready = await this.applyLocalChoice(item, plan.instructions);
            if (ready) this.errors.delete(entryKey(item));
            outcomes.set(item.itemId, ready); return ready;
          }
          if (item.kind !== 'forced_remove') {
            if (item.missingDependencies.length) throw new HelperError('DEPENDENCY_MISSING', 'The skill has a missing hard dependency.');
            for (const dependency of plan.items.filter(value => value.dependencyOf === item.itemId)) {
              if (!await apply(dependency)) throw new HelperError('DEPENDENCY_HELD', 'A hard dependency is not ready.');
            }
          }
          const key = entryKey(item);
          const duplicate = item.forAgentIds.length ? undefined : written.get(key);
          if (duplicate && !(duplicate.kind === 'forced_remove' && item.kind === 'forced_restore' && item.state === 'forced')) {
            if (duplicate.route !== item.route || duplicate.digest !== item.digest || duplicate.version !== item.version || duplicate.settingsRevision !== item.settingsRevision) throw new HelperError('PLAN_CONFLICT', 'The plan gives conflicting destinations or versions for one skill.');
            outcomes.set(item.itemId, true); return true;
          }
          const ready = await this.applyItem(item, plan.revoked);
          if (ready) {
            if (!item.forAgentIds.length) written.set(key, item);
            this.errors.delete(key);
          }
          outcomes.set(item.itemId, ready); return ready;
        } catch (error) {
          this.error(item, error);
          const code = codeFor(error);
          const upload = item.kind === 'local_newer' && ['send_proposal', 'publish'].includes(item.answer ?? '');
          if (code.startsWith('TOKEN_') || (error instanceof ApiError && (error.status === 401 || error.code === 'SCOPE_MISSING'))) throw error;
          if (!upload && (error instanceof ApiError || code.startsWith('API_'))) throw error;
          if (upload && (['API_TIMEOUT', 'API_CONNECTION_FAILED', 'API_RESPONSE_INVALID', 'API_FAILED'].includes(code) ||
              (error instanceof ApiError && (error.status >= 500 || [408, 429].includes(error.status))))) retryUpload ??= error;
          outcomes.set(item.itemId, false); return false;
        }
        finally {
          visiting.delete(item.itemId);
          if (await this.locks.pending(entryKey(item))) stuck.add(entryKey(item));
        }
      };
      for (const item of plan.items) {
        await apply(item);
      }
      let retryInstructions = false;
      if (!plan.degraded) {
        try {
          await new ImportEngine({paths: this.options.paths, helperId: this.options.helperId, client: this.options.client,
            targets: this.options.targets, verifier: this.verifier, timing: this.timing}).executeInstructions(plan.instructions);
        } catch (error) {
          this.importRetry(error);
          // A local retry may have prevented journaling the click. Fetch its full plan again.
          retryInstructions = plan.instructions.length > 0;
        }
      }
      // An Allow retry may reuse the already remembered held-plan revision.
      // Keep fetching its full plan until the tool's refreshed copy is observed.
      if (this.readCopyRetries.size && this.meta.planRevision === plan.planRevision) {
        this.meta.planRevision = null;
        await atomicWrite(join(this.options.paths.data, 'sync-meta.json'), JSON.stringify(this.meta) + '\n');
      }
      if (retryUpload === undefined && !this.readCopyRetries.size && !retryInstructions && !(await this.locks.allPending()).length) {
        this.meta.planRevision = plan.planRevision;
        await atomicWrite(join(this.options.paths.data, 'sync-meta.json'), JSON.stringify(this.meta) + '\n');
      }
      if (retryUpload !== undefined) throw retryUpload;
    }, this.timing);
    const duplicatesAfter = JSON.stringify(await this.localCopyQuestions());
    if (duplicatesBefore !== duplicatesAfter || this.duplicateRevision !== duplicatesAfter) this.notifyChange();
    this.duplicateRevision = duplicatesAfter;
  }
  private bindsLocalDigest(item: PlanItem, localDigest: string | null | undefined): boolean {
    return !!localDigest && planItemId({helperId: this.options.helperId, skillId: item.skillId, target: item.target,
      workspaceId: item.workspaceId, name: item.name, kind: item.kind, version: item.version,
      settingsRevision: item.settingsRevision, agentId: item.forAgentIds[0] ?? null, localDigest}) === item.itemId;
  }
  private async refreshReadCopy(target: DeliveryTarget, entry: LockEntry, destination: string): Promise<boolean> {
    const readCopy = await managedReadFolder(this.options.paths, entry, destination, target);
    if (readCopy === destination || await this.localDigest(readCopy) === entry.digest) return true;
    this.readCopyRetries.add(entryKey(entry));
    if (!target.refreshReadCopy) throw new HelperError('LOCAL_EDIT_REFRESH_UNAVAILABLE', 'This tool cannot refresh its copy yet.');
    try { await target.refreshReadCopy(entry); await target.afterChange?.(); }
    catch (error) { this.error(entry, error); return false; }
    this.notifyChange();
    // Observe the refreshed copy on the next plan before completing the receipt.
    return false;
  }
  private async applyLocalChoice(item: PlanItem, instructions: unknown[]): Promise<boolean> {
    const lock = await this.locks.read(), entry = lock.entries.find(value => entryKey(value) === entryKey(item));
    if (!entry || entry.removed || entry.route !== item.route || item.forAgentIds.length || entry.version !== (item.fromVersion ?? item.version)) {
      throw new HelperError('LOCAL_EDIT_INVALID', 'The local choice does not match an accepted skill.');
    }
    const choiceDirectory = join(this.options.paths.data, 'local-choices');
    // Stable item identities exclude the answer; proposal and Replace receipts are independent.
    const receipt = join(choiceDirectory, item.itemId + '.proposal.json');
    if (item.answer !== 'keep_local') {
      try {
        const saved = JSON.parse(await readPrivateFile(receipt));
        if (saved.itemId !== item.itemId || !['send_proposal', 'publish'].includes(saved.answer) || !this.bindsLocalDigest(item, saved.localDigest)) {
          throw new HelperError('LOCAL_EDIT_INVALID', 'The local choice receipt does not match the item.');
        }
        return true;
      } catch (error) { if (!absent(error)) throw error; }
    }
    const target = this.routes.get(entry.route);
    const destination = await this.destination(target, entry);
    const local = await readLocalEdit(this.options.paths, entry, destination, target);
    if (!this.bindsLocalDigest(item, local.localDigest) || local.localDigest === entry.digest) {
      throw new HelperError('LOCAL_EDIT_CHANGED', 'The local copy changed since the question was answered.');
    }
    if (item.answer === 'keep_local') {
      if (entry.keepLocal?.version !== item.version || entry.keepLocal.localDigest !== local.localDigest) {
        await this.commit({...entry, keepLocal: {version: item.version, localDigest: local.localDigest}}); this.notifyChange();
      }
      return true;
    }
    const matching = instructions.filter(value => value && typeof value === 'object' &&
      (value as {type?: unknown}).type === 'send_proposal' && (value as {itemId?: unknown}).itemId === item.itemId);
    if (!matching.length) return false;
    if (matching.length !== 1) throw new HelperError('PROPOSAL_INSTRUCTION_INVALID', 'The proposal instruction must be unique.');
    const instruction = parseSendProposalInstruction(matching[0]);
    if (instruction.baseVersion !== entry.version) throw new HelperError('LOCAL_EDIT_INVALID', 'The proposal base does not match the accepted skill.');
    try {
      await sendProposal({client: this.options.client, instruction, item, localDigest: local.localDigest, files: local.files});
    } catch (error) {
      if (error instanceof ApiError && error.code === 'PROPOSAL_ALREADY_UPLOADED') { /* Complete the receipt after a lost response. */ }
      else if (error instanceof ApiError && error.status >= 400 && error.status < 500 && ![401, 408, 429].includes(error.status) &&
          !error.code.startsWith('TOKEN_') && error.code !== 'SCOPE_MISSING') {
        throw new HelperError(/^[A-Z_]{1,60}$/.test(error.code) && !error.code.startsWith('API_') ? error.code : 'PROPOSAL_REJECTED',
          'The server refused this proposal.');
      } else throw error;
    }
    await this.options.crash?.('proposal_sent');
    await ensurePrivateDirectory(choiceDirectory);
    await atomicWrite(receipt, JSON.stringify({format: 1, itemId: item.itemId, answer: item.answer, localDigest: local.localDigest}) + '\n');
    return true;
  }
  private async applyItem(item: PlanItem, revoked: SyncPlan['revoked']): Promise<boolean> {
    const lock = await this.locks.read(), routePrior = lock.entries.find(entry => entryKey(entry) === entryKey(item)) ?? null;
    const agentLock = await this.agentLocks.read();
    const agentPrior = agentLock.entries.filter(entry => entryKey(entry) === entryKey(item) && item.forAgentIds.includes(entry.agentId!))
      .sort((a, b) => b.version - a.version || b.settingsRevision - a.settingsRevision)[0] ?? null;
    const prior = item.forAgentIds.length ? agentPrior : routePrior;
    if (item.state === 'forced' ? !['forced_remove', 'forced_restore'].includes(item.kind) : !['install', 'update', 'local_newer', 'forced_restore'].includes(item.kind)) {
      throw new HelperError('FORCED_EFFECT_INVALID', 'A forced change can only remove or restore a previous build.');
    }
    if (item.kind.startsWith('forced_') && item.state !== 'forced') throw new HelperError('FORCED_EFFECT_INVALID', 'Forced changes require a forced plan item.');
    if (['approved', 'held'].includes(item.state) && !['update', 'always', 'replace', 'replace_unmanaged'].includes(item.answer ?? '')) throw new HelperError('BUILD_ACTION_INVALID', 'Delivery requires an explicit approval answer.');
    const replacingUnmanaged = item.answer === 'replace_unmanaged';
    let unmanagedSourceDigest: string | undefined;
    if (replacingUnmanaged) {
      if (item.route !== 'agents-folder' || item.target !== 'folder' || item.forAgentIds.length || !['install', 'update'].includes(item.kind) || !['approved', 'held'].includes(item.state)) {
        throw new HelperError('BUILD_ACTION_INVALID', 'Unmanaged replacement requires an explicit approved shared-folder item.');
      }
      const snapshot = await readUnmanagedSnapshot(this.options.paths, this.options.helperId, item);
      if (!snapshot.reported) throw new HelperError('UNMANAGED_NOT_REPORTED', 'Report this unmanaged conflict before replacing it.');
      if (snapshot.completed) {
        if (prior && prior.digest === item.digest && prior.version === item.version && prior.settingsRevision === item.settingsRevision) {
          const destination = await this.destination(this.routes.get(item.route), prior);
          if (await exists(destination) && stampMatches(await readStamp(destination, this.verifier, this.locks.knownIds(lock)), prior) &&
              await this.localDigest(destination) === item.digest) return true;
        }
        throw new HelperError('UNMANAGED_REPLACEMENT_COMPLETED', 'This replacement was already completed. The current folder was kept.');
      }
      if (prior && !prior.removed) throw new HelperError('UNMANAGED_CONFLICT', 'The destination is already an accepted skill.');
      unmanagedSourceDigest = snapshot.digest;
      const destination = await this.destination(this.routes.get(item.route), item);
      if (!await exists(destination) || await unmanagedDigest(this.options.paths, destination) !== snapshot.digest) {
        throw new HelperError('UNMANAGED_CHANGED', 'The unmanaged folder changed since its conflict was reported. It was kept.');
      }
    }
    if (item.kind === 'local_newer' && item.answer !== 'replace') throw new HelperError('BUILD_ACTION_INVALID', 'Local edits require an explicit Replace answer.');
    if (item.kind === 'local_newer' && (!prior || item.forAgentIds.length)) throw new HelperError('LOCAL_EDIT_INVALID', 'Replace requires an accepted tool copy.');
    if (prior && prior.route !== item.route) throw new HelperError('ROUTE_INVALID', 'An accepted skill cannot silently change routes.');
    const definition = Object.hasOwn(TOOL_MATRIX.routes, item.route) ? TOOL_MATRIX.routes[item.route] : undefined;
    if (!definition || definition.target !== item.target) throw new HelperError('ROUTE_INVALID', 'The plan selected an unknown route or target.');
    const target = item.forAgentIds.length ? undefined : this.routes.get(item.route);
    if (target && target.target !== item.target) throw new HelperError('BUILD_TARGET_INVALID', 'The build target does not match its route.');
    const replacing = item.kind === 'local_newer' && item.answer === 'replace';
    const choiceDirectory = join(this.options.paths.data, 'local-choices'), replaceReceipt = join(choiceDirectory, item.itemId + '.replace.json');
    let replacement: {itemId: string; answer: string; readDigest?: string; held?: boolean; placed?: boolean; completed?: boolean;
      digest: string; version: number; settingsRevision: number; localDigest?: string; holdBackupId?: string; holdBackupDigest?: string} | undefined;
    let boundLocalDigest: string | undefined;
    if (replacing) {
      try {
        replacement = JSON.parse(await readPrivateFile(replaceReceipt));
        if (replacement?.itemId !== item.itemId || replacement.answer !== 'replace' || replacement.digest !== item.digest ||
            replacement.version !== item.version || replacement.settingsRevision !== item.settingsRevision || !this.bindsLocalDigest(item, replacement.localDigest)) {
          throw new HelperError('LOCAL_EDIT_INVALID', 'The Replace receipt does not match the item.');
        }
      } catch (error) { if (!absent(error)) throw error; }
      boundLocalDigest = replacement?.localDigest;
      if (replacement?.completed) return true;
      if (replacement?.readDigest) this.readCopyRetries.add(entryKey(item));
      if (replacement?.held) {
        const destination = await this.destination(target!, prior!);
        if (await exists(destination)) throw new HelperError('LOCAL_EDIT_CHANGED', 'A local copy was created while Replace was waiting for Allow.');
      }
      if (!replacement?.held) {
        const destination = await this.destination(target!, prior!);
        const movedForHold = !!replacement?.holdBackupId && !await exists(destination) &&
          /^[a-f0-9]{64}$/.test(replacement.holdBackupDigest ?? '') &&
          (await listBackups(this.options.paths)).some(backup => backup.id === replacement!.holdBackupId && backup.digest === replacement!.holdBackupDigest &&
            backup.route === item.route && backup.folderName === item.name && resolve(this.options.paths.home, backup.originalPath) === destination);
        const readCopy = await managedReadFolder(this.options.paths, prior!, destination, target);
        if (!movedForHold || readCopy !== destination) {
          const missingReadCopy = !!replacement?.readDigest && readCopy !== destination && !await exists(readCopy);
          if (!missingReadCopy) {
            const local = await readLocalEdit(this.options.paths, prior!, destination, target);
            if (!this.bindsLocalDigest(item, local.localDigest) && !(replacement?.readDigest && local.localDigest === item.digest)) {
              throw new HelperError('LOCAL_EDIT_CHANGED', 'The local copy changed since Replace was chosen.');
            }
            boundLocalDigest ??= local.localDigest;
          }
        }
      }
    }
    const completeReplace = async () => {
      if (!replacing) return;
      await ensurePrivateDirectory(choiceDirectory);
      await atomicWrite(replaceReceipt, JSON.stringify({...replacement, itemId: item.itemId, answer: 'replace', digest: item.digest,
        version: item.version, settingsRevision: item.settingsRevision, localDigest: boundLocalDigest, completed: true}) + '\n');
      this.readCopyRetries.delete(entryKey(item));
    };
    if (item.kind === 'forced_remove') {
      if (!prior || item.digest !== prior.digest || item.version !== prior.version || item.settingsRevision !== prior.settingsRevision) throw new HelperError('FORCED_EFFECT_INVALID', 'Only the accepted local build may be removed.');
      const entry = {...prior, removed: true, acceptedBy: 'forced' as const, acceptedAt: new Date(this.timing.now()).toISOString()};
      if (item.forAgentIds.length) {
        agentLock.entries = agentLock.entries.map(value => entryKey(value) === entryKey(entry) && item.forAgentIds.includes(value.agentId!) ? {...value, removed: true, acceptedBy: 'forced', acceptedAt: entry.acceptedAt} : value);
        agentLock.updatedAt = entry.acceptedAt; await this.agentLocks.write(agentLock); return true;
      }
      const destination = await this.destination(target!, entry);
      await this.locks.setPending(entryKey(entry), {format: 1, helperId: this.options.helperId, operation: 'remove', entry, prior: routePrior, stagedName: null});
      if (await exists(destination)) await backupFolder(this.options.paths, destination, target!.route, item.reason ?? 'forced_remove', await this.localDigest(destination), this.timing.now());
      await this.options.crash?.('backed_up'); await target!.remove(entry, item.reason ?? 'forced_remove');
      await this.commit(entry); await this.options.crash?.('locked'); await this.locks.setPending(entryKey(entry), null); this.notifyChange(); await target!.afterChange?.(); return true;
    }
    if (revoked.some(entry => entry.digest === item.digest)) throw new HelperError('BUILD_REVOKED', 'BUILD_REVOKED');
    if (item.kind === 'forced_restore' && item.forAgentIds.length && prior && prior.previous === null && !prior.removed && prior.acceptedBy === 'forced' &&
        prior.digest === item.digest && prior.version === item.version && prior.settingsRevision === item.settingsRevision) {
      await this.verifiedBuild(item.digest, item.forAgentIds[0]); return true;
    }
    if (item.kind === 'forced_restore' && routePrior && routePrior.previous === null && routePrior.acceptedBy === 'forced' &&
        routePrior.digest === item.digest && routePrior.version === item.version && routePrior.settingsRevision === item.settingsRevision && target) {
      const destination = await this.destination(target, routePrior);
      if (await exists(destination) && stampMatches(await readStamp(destination, this.verifier, this.locks.knownIds(lock)), routePrior) && await this.localDigest(destination) === item.digest) return true;
    }
    let raw: unknown;
    try { raw = JSON.parse(await readPrivateFile(join(this.options.paths.data, 'cache/builds', item.digest + '.json'), 16 * 1024 * 1024)); }
    catch (error) { if (!absent(error)) throw error; }
    // A digest can name identical content in different signed versions. Use the
    // network when cached metadata does not match this plan, then verify again.
    let build: VerifiedBuild;
    try { if (!raw) throw new Error(); build = this.verifier.verify(raw, item, {target: item.target, revoked, entry: prior}); }
    catch {
      raw = (await this.options.client.request<unknown>('/api/helper/builds/' + item.digest + '?itemId=' + item.itemId)).data;
      build = this.verifier.verify(raw, item, {target: item.target, revoked, entry: prior});
    }
    // This flag is outside the signed framing. Persist the conservative result
    // so an agent read cannot forget a code classification supplied by the plan.
    build = {...build, build: {...build.build, hasCode: build.hasCode}};
    const serialized = JSON.stringify(build.build) + '\n';
    await atomicWriteBuild(join(this.options.paths.data, 'cache/builds', item.digest + '.json'), serialized);
    await atomicWriteBuild(cachedEnvelope(this.options.paths, item.digest, build.build.signature), serialized);
    const allowed = new Set(prior?.allowedDigests ?? []);
    const previouslyAllowed = prior && allowed.has(item.digest) &&
      ((prior.version === item.version && prior.settingsRevision === item.settingsRevision && prior.digest === item.digest && prior.signature === build.build.signature) ||
        (item.kind === 'forced_restore' && prior.previous?.version === item.version && prior.previous.settingsRevision === item.settingsRevision && prior.previous.digest === item.digest));
    const replaceHeld = replacement?.held === true;
    if (replacing) {
      const destination = await this.destination(target!, prior!);
      const readCopy = await managedReadFolder(this.options.paths, prior!, destination, target);
      if (readCopy !== destination && await exists(readCopy)) {
        const localDigest = await this.localDigest(readCopy);
        if (!localDigest) throw new HelperError('LOCAL_EDIT_INVALID', 'The read copy cannot be safely preserved.');
        if (replaceHeld && replacement?.readDigest && replacement.readDigest !== localDigest) {
          throw new HelperError('LOCAL_EDIT_CHANGED', 'The read copy changed while Replace was waiting for Allow.');
        }
        if (localDigest !== prior!.digest && replacement?.readDigest !== localDigest) {
          const snapshot = await snapshotReadCopy(this.options.paths, readCopy, destination, item.route, localDigest, this.timing.now(), {entry: prior!, target: target!});
          await ensurePrivateDirectory(choiceDirectory);
          replacement = {...replacement, itemId: item.itemId, answer: 'replace', readDigest: localDigest, held: replaceHeld,
            digest: item.digest, version: item.version, settingsRevision: item.settingsRevision, localDigest: boundLocalDigest};
          await atomicWrite(replaceReceipt, JSON.stringify({...replacement, readBackupId: snapshot.id}) + '\n');
        }
      }
    }
    const locallyAllowed = build.hasCode && (replacing ?
      replacement?.placed ? previouslyAllowed : replaceHeld && (await this.holding.isReplacementAllowed(build.build, item) || !!await this.options.allowedReplacement?.(build.build, item)) :
      previouslyAllowed || await this.holding.isAllowed(build.build) || await this.options.allowedBuild?.(build.build));
    if (build.hasCode && !locallyAllowed) {
      if (replacing) {
        const destination = await this.destination(target!, prior!);
        // Move the edited source before holding, so it cannot remain live as code.
        if (await exists(destination)) await backupFolder(this.options.paths, destination, target!.route, 'local_newer', await this.localDigest(destination), this.timing.now(), async manifest => {
          // Persist the backup identity before moving the copy so interrupted holding can resume.
          let saved = {};
          try { saved = JSON.parse(await readPrivateFile(replaceReceipt)); } catch (error) { if (!absent(error)) throw error; }
          await ensurePrivateDirectory(choiceDirectory);
          await atomicWrite(replaceReceipt, JSON.stringify({...saved, itemId: item.itemId, answer: 'replace', held: false, digest: item.digest,
            version: item.version, settingsRevision: item.settingsRevision, localDigest: boundLocalDigest,
            holdBackupId: manifest.id, holdBackupDigest: manifest.digest}) + '\n');
        });
      }
      if (this.options.hold) await this.options.hold(build, item);
      else await this.holding.hold(build, item, prior);
      await this.options.crash?.('holding');
      if (replacing) {
        let receipt = {};
        try { receipt = JSON.parse(await readPrivateFile(replaceReceipt)); } catch (error) { if (!absent(error)) throw error; }
        await ensurePrivateDirectory(choiceDirectory);
        await atomicWrite(replaceReceipt, JSON.stringify({...receipt, itemId: item.itemId, answer: 'replace', held: true,
          digest: item.digest, version: item.version, settingsRevision: item.settingsRevision, localDigest: boundLocalDigest}) + '\n');
        await target!.afterChange?.();
      }
      this.notifyChange();
      return false;
    }
    if (locallyAllowed) allowed.add(item.digest);
    const entry: LockEntry = {skillId: item.skillId, target: item.target, route: item.route, name: item.name, workspaceId: item.workspaceId,
      version: item.version, settingsRevision: item.settingsRevision, digest: item.digest, keyId: build.build.keyId, signature: build.build.signature,
      hasCode: build.hasCode, draft: build.build.draft, acceptedAt: new Date(this.timing.now()).toISOString(),
      acceptedBy: item.state === 'forced' ? 'forced' : item.answer === 'always' ? 'always' : prior ? 'update' : 'install',
      previous: item.kind === 'forced_restore' ? null : prior && (prior.digest !== item.digest || prior.version !== item.version || prior.settingsRevision !== item.settingsRevision) ?
        {version: prior.version, settingsRevision: prior.settingsRevision, digest: prior.digest} : prior?.previous ?? null,
      allowedDigests: [...allowed], keepLocal: null};
    if (item.forAgentIds.length) {
      agentLock.entries = [...agentLock.entries.filter(value => entryKey(value) !== entryKey(entry) || !item.forAgentIds.includes(value.agentId!)),
        ...item.forAgentIds.map(agentId => ({...entry, agentId}))];
      agentLock.updatedAt = new Date(this.timing.now()).toISOString(); await this.agentLocks.write(agentLock); await this.finishHolding(item); return true;
    }
    const destination = await this.destination(target!, entry);
    const readCopyReplaced = replacing && !!replacement?.readDigest;
    let unchanged = false;
    if (await exists(destination)) {
      if (!routePrior && !replacingUnmanaged) throw new HelperError('UNMANAGED_CONFLICT', 'An unmanaged folder already uses this delivered name.');
      try { unchanged = stampMatches(await readStamp(destination, this.verifier, this.locks.knownIds(lock)), entry) && await this.localDigest(destination) === entry.digest; }
      catch { /* Approved updates preserve edited copies in a backup. */ }
    }
    if (unchanged) {
      await this.commit(entry); await this.finishHolding(item);
      if (readCopyReplaced && !await this.refreshReadCopy(target!, entry, destination)) return false;
      await completeReplace(); return true;
    }
    await target!.validate?.(build.build, build.files);
    const staged = await stageBuild(this.options.paths, build.files, makeStamp(build.build, item, this.options.helperId, this.timing.now()));
    if (replacing) {
      await ensurePrivateDirectory(choiceDirectory);
      await atomicWrite(replaceReceipt, JSON.stringify({...replacement, itemId: item.itemId, answer: 'replace', digest: item.digest,
        version: item.version, settingsRevision: item.settingsRevision, localDigest: boundLocalDigest, completed: false}) + '\n');
    }
    const pending: PendingWrite = {format: 1, helperId: this.options.helperId, operation: 'place', entry, prior, stagedName: basename(staged), itemId: item.itemId,
      ...(unmanagedSourceDigest ? {unmanagedDigest: unmanagedSourceDigest} : {})};
    const key = entryKey(entry);
    await this.locks.setPending(key, pending); await this.options.crash?.('staged');
    if (unmanagedSourceDigest && !await exists(destination)) throw new HelperError('UNMANAGED_CHANGED', 'The unmanaged folder disappeared before backup. No build was placed.');
    const backup = await exists(destination) ? await backupFolder(this.options.paths, destination, target!.route,
      replacingUnmanaged ? 'unmanaged_replaced' : item.kind, unmanagedSourceDigest ?? await this.localDigest(destination), this.timing.now(), async manifest => {
      if (unmanagedSourceDigest && await unmanagedDigest(this.options.paths, destination) !== unmanagedSourceDigest) {
        throw new HelperError('UNMANAGED_CHANGED', 'The unmanaged folder changed before it could be backed up. It was kept.');
      }
      pending.backupId = manifest.id; await this.locks.setPending(key, pending);
    }) : null;
    await this.options.crash?.('backed_up');
    await this.checkUnmanagedBackup(pending, destination);
    try { await target!.place(build.build, staged); }
    catch (error) {
      if (backup && !await exists(destination)) {
        await restoreBackup(this.options.paths, backup.id); await this.locks.setPending(key, null);
      }
      throw error;
    }
    await this.options.crash?.('placed');
    await this.commit(entry); await this.options.crash?.('locked'); await this.finishHolding(item);
    if (readCopyReplaced) {
      replacement = {...replacement!, held: false, placed: true};
      await atomicWrite(replaceReceipt, JSON.stringify({...replacement, completed: false}) + '\n');
      // Placement is durable. A tool refresh must not block later updates or
      // forced removals by leaving this journal pending.
      this.readCopyRetries.add(entryKey(entry));
      await this.locks.setPending(key, null);
    }
    await target!.afterChange?.();
    if (readCopyReplaced) {
      try { await target!.refreshReadCopy?.(entry); }
      catch (error) { this.error(entry, error); return false; }
      this.notifyChange();
      return false;
    }
    await completeReplace();
    if (unmanagedSourceDigest) await completeUnmanagedSnapshot(this.options.paths, this.options.helperId, item, unmanagedSourceDigest);
    await this.locks.setPending(key, null);
    this.changedAt = this.timing.now(); return true;
  }
  async verifiedBuild(digest: string, agentId?: string): Promise<VerifiedBuild> {
    const lock = await (agentId ? this.agentLocks : this.locks).read();
    return verifiedBuild(digest, {paths: this.options.paths, helperId: this.options.helperId, agentId, verifier: this.verifier,
      allowedBuild: async build => lock.entries.some(entry => entry.skillId === build.skillId && entry.target === build.target &&
        (!agentId || entry.agentId === agentId) &&
        entry.version === build.version && entry.settingsRevision === build.settingsRevision && entry.digest === build.digest && entry.allowedDigests.includes(build.digest)) ||
        await this.holding.isAllowed(build) || !!await this.options.allowedBuild?.(build)});
  }
  notifyChange(): void { if (this.changedAt === null) this.changedAt = this.timing.now(); }
  async tick(): Promise<void> {
    const now = this.timing.now();
    if (this.stoppedForToken || now < this.tokenRetryAt) return;
    if (!this.failures || now >= this.nextPlan) try {
      if (!this.initialized) await this.reconcile();
      if (now >= this.nextWatchAt) {await this.watchRoutes(); this.nextWatchAt = now + 600_000;}
      if (now >= this.nextInventory || (this.changedAt !== null && now >= this.changedAt + 1000)) {
        await this.reportInventory();
        this.nextInventory = now + 600_000; this.changedAt = null;
      }
      if (now >= this.nextPlan) {
        // A separate Allow CLI can invalidate a held plan while this service
        // still remembers its ETag. Honor that durable request for a full poll.
        try {
          const saved: SyncMeta = JSON.parse(await readPrivateFile(join(this.options.paths.data, 'sync-meta.json'), 4 * 1024 * 1024));
          if (saved.format !== 1 || (saved.planRevision !== null &&
              (typeof saved.planRevision !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(saved.planRevision)))) {
            throw new HelperError('SYNC_META_INVALID', 'Invalid persisted plan revision.');
          }
          if (saved.planRevision === null) this.meta.planRevision = null;
        } catch (error) { if (!absent(error)) throw error; }
        const response = await this.options.client.request<SyncPlan>('/api/helper/plan', {headers: this.meta.planRevision ? {'If-None-Match': this.meta.planRevision} : {}});
        if (response.status !== 304) {
          await this.applyPlan(response.data); this.nextPlan = now + response.data.pollAfterSeconds * 1000;
        } else {
          if (this.meta.degraded === false) {
            try {
              await new ImportEngine({paths: this.options.paths, helperId: this.options.helperId, client: this.options.client,
                targets: this.options.targets, verifier: this.verifier, timing: this.timing}).applyInstructions([]);
            } catch (error) {this.importRetry(error);}
          }
          this.nextPlan = now + this.meta.pollAfterSeconds * 1000;
        }
        this.firstFailure = null; this.failures = 0;
      }
    } catch (error) {
      const code = codeFor(error);
      if (code === 'TOKEN_RENEW_REQUIRED' || code === 'TOKEN_ROTATED') { this.tokenRetryAt = this.nextPlan = now + 3_600_000; return; }
      if (code.startsWith('TOKEN_')) { this.stoppedForToken = true; throw error; }
      this.firstFailure ??= now; this.failures++;
      this.nextPlan = now + (now - this.firstFailure >= 7 * 86400_000 ? 86400_000 : Math.min(1800_000, 60_000 * 2 ** Math.min(this.failures - 1, 5)));
    }
    // Reports have their own retry schedule and never gate inventory, plans or revocations.
    if (now < this.nextReportAt) return;
    this.nextReportAt = now + 60_000;
    try {
      await withWriteLock(this.options.paths, () => this.holding.flushReports(this.options.client), this.timing);
      this.reportFailures = 0;
    } catch (error) {
      const code = codeFor(error);
      if (code === 'TOKEN_RENEW_REQUIRED' || code === 'TOKEN_ROTATED') { this.tokenRetryAt = this.nextPlan = now + 3_600_000; return; }
      if (code.startsWith('TOKEN_')) { this.stoppedForToken = true; throw error; }
      this.reportFailures++;
      this.nextReportAt = now + Math.min(1800_000, 60_000 * 2 ** Math.min(this.reportFailures - 1, 5));
    }
  }
  private async watchRoutes(): Promise<void> {
    for (const target of this.routes.all()) {
      if (this.watched.has(target.route)) continue;
      try {
        const root = await this.routeRoot(target);
        const definition = TOOL_MATRIX.routes[target.route];
        const readRoot = target.target === 'claude-plugin' && !target.readFolderFor && definition.readPath ?
          definition.readPath.startsWith('~/') ? resolve(this.options.paths.home, definition.readPath.slice(2)) : resolve(definition.readPath) : root;
        await assertRouteRoot(this.options.paths, readRoot);
        const watcher = this.options.watchRoute ? this.options.watchRoute(readRoot, () => this.notifyChange()) : watch(readRoot, {recursive: true}, () => this.notifyChange());
        if ('unref' in watcher && typeof watcher.unref === 'function') watcher.unref();
        this.watched.set(target.route, watcher);
      } catch (error) {
        if (!absent(error) && !(error instanceof HelperError && ['PATH_UNSAFE', 'ROUTE_INVALID'].includes(error.code))) throw error;
      }
    }
  }
  async run(signal?: AbortSignal): Promise<void> {
    try {
      while (!signal?.aborted) {
        await this.tick(); await this.timing.sleep(1000, signal);
      }
    } finally { this.close(); }
  }
  close(): void {for (const watcher of this.watched.values()) watcher.close(); this.watched.clear();}
}
