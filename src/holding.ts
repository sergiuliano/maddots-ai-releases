import { createHash, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { TOOL_MATRIX } from './shared/tool-matrix.js';
import { HelperError, clock, type Timing } from './config.js';
import { LockStore, entryKey, safeName } from './lock.js';
import { assertNoSymlinks, ensurePrivateDirectory, readPrivateFile, type HelperPaths } from './paths.js';
import { atomicWriteBuild, durableRename } from './safe-fs.js';
import { BuildVerifier, type PlanItem, type SignedBuild, type VerificationEntry, type VerifiedBuild } from './verify.js';

export type HeldBuild = {format: 1; helperId: string; item: PlanItem; build: SignedBuild; heldAt: string; verificationEntry: VerificationEntry | null};
export type HoldingEntry = HeldBuild & {file: string; verified: VerifiedBuild};
export type WaitingSkill = {skillId: string; version: number; name: string; digests: string[]; entries: HoldingEntry[]};
export type AllowReport = {skillId: string; version: number; digest: string; tools: string[]; allowedAt: string};
type AllowReceipt = {format: 1; helperId: string; identity: string; report: AllowReport; reported: boolean; replacementContexts?: string[]};
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const hex = /^[a-f0-9]{64}$/;
const maxReplacementContexts = 2000;
function refuseUnsafe(error: unknown): void {
  if (error instanceof HelperError && error.code === 'PATH_UNSAFE') throw error;
  if ((error as NodeJS.ErrnoException)?.code === 'ELOOP') throw new HelperError('PATH_UNSAFE', 'Holding paths cannot be symlinks.');
}
function validReceipt(value: AllowReceipt): boolean {
  return !!value && value.format === 1 && safeName(value.helperId) && typeof value.identity === 'string' && hex.test(value.identity) &&
    !!value.report && safeName(value.report.skillId) && typeof value.report.digest === 'string' && hex.test(value.report.digest) &&
    Number.isSafeInteger(value.report.version) && value.report.version > 0 && Array.isArray(value.report.tools) &&
    value.report.tools.length <= 40 && value.report.tools.every(tool => typeof tool === 'string' && tool.length <= 80 && !/\p{Cc}/u.test(tool)) &&
    typeof value.report.allowedAt === 'string' && Number.isFinite(Date.parse(value.report.allowedAt)) && typeof value.reported === 'boolean' &&
    (value.replacementContexts === undefined || Array.isArray(value.replacementContexts) &&
      value.replacementContexts.length <= maxReplacementContexts && value.replacementContexts.every(context => typeof context === 'string' && hex.test(context)) &&
      new Set(value.replacementContexts).size === value.replacementContexts.length);
}
export function consentContext(item: PlanItem): string {
  return JSON.stringify([item.itemId, item.kind, item.skillId, item.name, item.sourceName, item.level, item.workspaceId,
    item.workspaceIds, item.boardIds, item.target, item.route, item.fromVersion, item.version, item.settingsRevision,
    item.digest, item.hasCode, item.draft, item.dependencyOf, item.missingDependencies, item.forAgentIds, item.answer,
    item.reason, item.restartHints]);
}
/** A digest can recur in a new signed version. Local consent covers this exact envelope. */
function identity(build: SignedBuild): string {
  return hash(JSON.stringify([build.skillId, build.version, build.settingsRevision, build.digest,
    build.target, build.name, build.workspaceId, build.keyId, build.signature]));
}

/** All mutations run under TLS-13's helper write lock. Held data is archived, never deleted. */
export class HoldingStore {
  /** Local paths are diagnostic only and must never be included in inventory. */
  readonly invalid = new Set<string>();
  private readonly stale = new Set<string>();
  private readonly loggedInvalidReports = new Set<string>();
  constructor(readonly paths: HelperPaths, readonly helperId: string,
    readonly verifier = new BuildVerifier(), readonly timing: Timing = clock) {}
  private folder(build: SignedBuild): string {
    if (!safeName(build.skillId) || !hex.test(build.digest)) throw new HelperError('HOLDING_INVALID', 'Invalid holding identity.');
    return join(this.paths.holding, build.skillId, build.digest);
  }
  async hold(verified: VerifiedBuild, item: PlanItem, verificationEntry: VerificationEntry | null = null): Promise<void> {
    const checked = this.verifier.verify(verified.build, item, {target: item.target, entry: verificationEntry});
    if (!checked.hasCode || !hex.test(item.itemId)) throw new HelperError('HOLDING_INVALID', 'Only verified code builds can wait for Allow.');
    const folder = this.folder(checked.build); await ensurePrivateDirectory(folder);
    const record: HeldBuild = {format: 1, helperId: this.helperId, item,
      build: {...checked.build, hasCode: true}, heldAt: new Date(this.timing.now()).toISOString(), verificationEntry};
    const file = join(folder, item.itemId + '-' + hash(this.helperId + ':' + identity(record.build)) + '.json');
    // Repeated polls preserve the original record and never duplicate a waiting entry.
    try { await readPrivateFile(file, 16 * 1024 * 1024); return; } catch (error) { if (!absent(error)) throw error; }
    await atomicWriteBuild(file, JSON.stringify(record) + '\n');
  }
  async entries(): Promise<HoldingEntry[]> {
    this.invalid.clear(); this.stale.clear();
    await assertNoSymlinks(this.paths.holding);
    const result: HoldingEntry[] = [];
    for (const skill of await readdir(this.paths.holding, {withFileTypes: true})) {
      if (skill.isSymbolicLink()) throw new HelperError('PATH_UNSAFE', 'Holding entries cannot be symlinks.');
      if (skill.name.startsWith('.')) continue;
      // TLS-13's flat records are adopted or archived only during reconciliation.
      if (skill.isFile() && /^[a-f0-9]{64}\.json$/.test(skill.name)) continue;
      if (!skill.isDirectory() || !safeName(skill.name)) {this.invalid.add(join(this.paths.holding, skill.name)); continue;}
      const skillFolder = join(this.paths.holding, skill.name); await assertNoSymlinks(skillFolder);
      for (const digest of await readdir(skillFolder, {withFileTypes: true})) {
        if (digest.isSymbolicLink()) throw new HelperError('PATH_UNSAFE', 'Holding entries cannot be symlinks.');
        if (digest.name.startsWith('.')) continue;
        if (!digest.isDirectory() || !hex.test(digest.name)) {this.invalid.add(join(skillFolder, digest.name)); continue;}
        const folder = join(skillFolder, digest.name); await assertNoSymlinks(folder);
        for (const file of await readdir(folder, {withFileTypes: true})) {
          if (file.isSymbolicLink()) throw new HelperError('PATH_UNSAFE', 'Holding records cannot be symlinks.');
          if (file.name.startsWith('.')) continue;
          const path = join(folder, file.name);
          if (!file.isFile() || !/^[a-f0-9]{64}-[a-f0-9]{64}\.json$/.test(file.name)) {this.invalid.add(path); continue;}
          try {
            const record = JSON.parse(await readPrivateFile(path, 16 * 1024 * 1024)) as HeldBuild;
            if (!record || record.format !== 1 || !safeName(record.helperId) || !record.item || !hex.test(record.item.itemId) ||
                !safeName(record.item.sourceName) || typeof record.heldAt !== 'string' || !Number.isFinite(Date.parse(record.heldAt)) ||
                !record.build || record.build.skillId !== skill.name || record.build.digest !== digest.name ||
                file.name !== record.item.itemId + '-' + hash(record.helperId + ':' + identity(record.build)) + '.json') throw new HelperError('HOLDING_INVALID', 'Invalid holding record identity.');
            const route = Object.hasOwn(TOOL_MATRIX.routes, record.item.route) ? TOOL_MATRIX.routes[record.item.route] : undefined;
            if (!route || route.target !== record.item.target || !['approved', 'held', 'forced'].includes(record.item.state)) throw new HelperError('HOLDING_INVALID', 'Invalid holding route or approval.');
            if (record.helperId !== this.helperId) continue; // Preserve records from an earlier pairing without allowing them.
            const verified = this.verifier.verify(record.build, record.item, {target: record.item.target, entry: record.verificationEntry});
            if (!verified.hasCode) throw new HelperError('HOLDING_INVALID', 'A holding record must contain code.');
            result.push({...record, file: path, verified});
          } catch (error) {
            refuseUnsafe(error);
            this.invalid.add(path);
            // Read failures may be temporary. Only proven invalid records are archived.
            if (error instanceof HelperError || error instanceof SyntaxError) this.stale.add(path);
          }
          if (result.length > 2000) throw new HelperError('HOLDING_TOO_LARGE', 'Too many waiting builds.');
        }
      }
    }
    return result;
  }
  async waiting(): Promise<WaitingSkill[]> {
    const groups = new Map<string, WaitingSkill>();
    for (const entry of await this.entries()) {
      const key = JSON.stringify([entry.build.skillId, entry.build.version]);
      const group = groups.get(key) ?? {skillId: entry.build.skillId, version: entry.build.version,
        name: entry.item.sourceName, digests: [], entries: []};
      group.entries.push(entry);
      if (!group.digests.includes(entry.build.digest)) group.digests.push(entry.build.digest);
      groups.set(key, group);
    }
    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version - b.version);
  }
  async count(): Promise<number> { return (await this.waiting()).length; }
  private async archive(entry: HoldingEntry, reason: string): Promise<void> {
    const archive = join(this.paths.data, 'holding-records'); await ensurePrivateDirectory(archive);
    await durableRename(entry.file, join(archive, reason + '-' + entry.item.itemId + '-' + randomUUID() + '.json'));
  }
  private async archiveInvalid(path: string, reason: string): Promise<void> {
    try {
      const archive = join(this.paths.data, 'holding-records'); await ensurePrivateDirectory(archive);
      await durableRename(path, join(archive, reason + '-' + basename(path, '.json') + '-' + randomUUID() + '.json'));
    } catch (error) {
      refuseUnsafe(error);
      // A failed archive keeps its source for a later attempt, without blocking other items.
      this.invalid.add(path);
    }
  }
  async finish(itemId: string): Promise<void> {
    for (const entry of await this.entries()) if (entry.item.itemId === itemId) await this.archive(entry, 'delivered');
  }
  async reconcile(items: readonly PlanItem[], revoked: readonly {digest: string}[], degraded = false): Promise<void> {
    const entries = await this.entries();
    for (const path of this.stale) await this.archiveInvalid(path, 'unverifiable');
    // Adopt TLS-13's pre-TLS-14 flat records only when the current plan still
    // authorizes the same item. Archive the original bytes after safe adoption.
    for (const file of await readdir(this.paths.holding, {withFileTypes: true})) {
      if (file.isSymbolicLink()) throw new HelperError('PATH_UNSAFE', 'Holding entries cannot be symlinks.');
      if (!file.isFile() || !/^[a-f0-9]{64}\.json$/.test(file.name)) continue;
      const path = join(this.paths.holding, file.name);
      let legacy: HeldBuild;
      try {
        legacy = JSON.parse(await readPrivateFile(path, 16 * 1024 * 1024)) as HeldBuild;
        if (!legacy || legacy.format !== 1 || !legacy.item || file.name !== legacy.item.itemId + '.json' ||
            !safeName(legacy.item.sourceName) || typeof legacy.heldAt !== 'string' || !Number.isFinite(Date.parse(legacy.heldAt))) throw new HelperError('HOLDING_INVALID', 'Invalid legacy holding record.');
        const route = Object.hasOwn(TOOL_MATRIX.routes, legacy.item.route) ? TOOL_MATRIX.routes[legacy.item.route] : undefined;
        if (!route || route.target !== legacy.item.target || !['approved', 'held', 'forced'].includes(legacy.item.state)) throw new HelperError('HOLDING_INVALID', 'Invalid legacy holding route or approval.');
        this.verifier.verifyCached(legacy.build, legacy.item.digest);
      } catch (error) {
        refuseUnsafe(error); this.invalid.add(path);
        if (!absent(error)) await this.archiveInvalid(path, 'legacy-unverifiable');
        continue;
      }
      const current = items.find(item => consentContext(item) === consentContext(legacy.item) && ['approved', 'held', 'forced'].includes(item.state));
      if (current && !revoked.some(value => value.digest === legacy.build.digest)) {
        const lock = await new LockStore(this.paths, this.helperId, current.forAgentIds.length ? 'agent-lock.json' : 'lock.json').read();
        const prior = lock.entries.find(entry => entryKey(entry) === entryKey(current) &&
          (!current.forAgentIds.length || current.forAgentIds.includes(entry.agentId!))) ?? null;
        let verified: VerifiedBuild;
        try { verified = this.verifier.verify(legacy.build, current, {target: current.target, entry: prior}); }
        catch (error) {
          refuseUnsafe(error); this.invalid.add(path);
          await this.archiveInvalid(path, 'legacy-unverifiable'); continue;
        }
        await this.hold(verified, current, prior);
      } else if (degraded && !revoked.some(value => value.digest === legacy.build.digest)) continue;
      const archive = join(this.paths.data, 'holding-records'); await ensurePrivateDirectory(archive);
      await durableRename(path, join(archive, 'legacy-' + legacy.item.itemId + '-' + randomUUID() + '.json'));
    }
    for (const entry of entries) {
      const current = items.find(item => consentContext(item) === consentContext(entry.item));
      if (revoked.some(value => value.digest === entry.build.digest) || (!degraded &&
          (!current || !['approved', 'held', 'forced'].includes(current.state)))) await this.archive(entry, 'withdrawn');
    }
  }
  private receiptFile(build: SignedBuild): string { return join(this.paths.data, 'allows', hash(this.helperId + ':' + identity(build)) + '.json'); }
  private async receipt(build: SignedBuild): Promise<AllowReceipt | null> {
    try {
      const value = JSON.parse(await readPrivateFile(this.receiptFile(build))) as AllowReceipt;
      if (!validReceipt(value) || value.helperId !== this.helperId || value.identity !== identity(build) ||
          value.report.skillId !== build.skillId || value.report.version !== build.version || value.report.digest !== build.digest) {
        throw new HelperError('ALLOW_INVALID', 'The local Allow receipt is invalid.');
      }
      return value;
    } catch (error) {
      refuseUnsafe(error);
      if (absent(error)) return null;
      if (error instanceof SyntaxError) throw new HelperError('ALLOW_INVALID', 'The local Allow receipt is invalid.');
      throw error;
    }
  }
  async isAllowed(build: SignedBuild): Promise<boolean> { return !!await this.receipt(build); }
  /** Replace requires consent for this choice even when the same envelope was allowed earlier. */
  async isReplacementAllowed(build: SignedBuild, item: PlanItem): Promise<boolean> {
    if (item.kind !== 'local_newer' || item.answer !== 'replace') return false;
    return !!(await this.receipt(build))?.replacementContexts?.includes(hash(consentContext(item)));
  }
  async approve(entry: HoldingEntry, tools: string[]): Promise<void> {
    if (!tools.length) throw new HelperError('ALLOW_TOOLS_REQUIRED', 'Allow needs a connected tool for this build route.');
    const directory = join(this.paths.data, 'allows'); await ensurePrivateDirectory(directory);
    const existing = await this.receipt(entry.build);
    const replacement = entry.item.kind === 'local_newer' && entry.item.answer === 'replace' ? hash(consentContext(entry.item)) : undefined;
    if (existing && (!replacement || existing.replacementContexts?.includes(replacement))) return;
    const replacementContexts = [...existing?.replacementContexts ?? [], ...replacement ? [replacement] : []];
    if (replacementContexts.length > maxReplacementContexts) throw new HelperError('ALLOW_TOO_LARGE', 'Too many replacement consent records for this build.');
    const receipt: AllowReceipt = {format: 1, helperId: this.helperId, identity: identity(entry.build), reported: false,
      ...(replacementContexts.length ? {replacementContexts} : {}),
      report: {skillId: entry.build.skillId, version: entry.build.version, digest: entry.build.digest,
        tools: [...new Set(tools)].sort(), allowedAt: new Date(this.timing.now()).toISOString()}};
    await atomicWriteBuild(this.receiptFile(entry.build), JSON.stringify(receipt) + '\n');
  }
  async flushReports(client: {request: (path: string, options: {method: 'POST'; body: unknown}) => Promise<unknown>}): Promise<void> {
    const directory = join(this.paths.data, 'allows'); await ensurePrivateDirectory(directory);
    const pending: {file: string; receipt: AllowReceipt}[] = [];
    for (const file of await readdir(directory, {withFileTypes: true})) {
      if (file.isSymbolicLink()) throw new HelperError('PATH_UNSAFE', 'Allow receipts cannot be symlinks.');
      if (!file.isFile() || !/^[a-f0-9]{64}\.json$/.test(file.name)) continue;
      const path = join(directory, file.name); let receipt: AllowReceipt;
      try {
        receipt = JSON.parse(await readPrivateFile(path)) as AllowReceipt;
        if (!validReceipt(receipt) || file.name !== hash(receipt.helperId + ':' + receipt.identity) + '.json') throw new HelperError('ALLOW_INVALID', 'Invalid Allow report.');
      } catch (error) {
        refuseUnsafe(error);
        if (!this.loggedInvalidReports.has(path)) {
          this.loggedInvalidReports.add(path);
          console.error('An invalid Allow report is preserved locally: ALLOW_INVALID');
        }
        continue;
      }
      if (receipt.helperId === this.helperId && !receipt.reported) pending.push({file: path, receipt});
    }
    // A bounded batch remains below TLS-07's 256 KiB route limit.
    for (let start = 0; start < pending.length; start += 50) {
      const batch = pending.slice(start, start + 50);
      // Older helpers queued display names. Preserve their consent and retry using
      // the matrix keys required by the wire protocol and the server's audit match.
      const reports = batch.map(({receipt}) => ({...receipt.report, tools: [...new Set(receipt.report.tools.map(value =>
        TOOL_MATRIX.tools.find(tool => tool.name === value)?.key ?? value))].sort()}));
      await client.request('/api/helper/allow', {method: 'POST', body: {holdingCount: await this.count(), reports}});
      for (const value of batch) await atomicWriteBuild(value.file, JSON.stringify({...value.receipt, reported: true}) + '\n');
    }
  }
}
