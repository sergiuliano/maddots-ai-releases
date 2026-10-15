import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { HelperError } from './config.js';
import { assertNoSymlinks, atomicWrite, ensurePrivateDirectory, readPrivateFile, type HelperPaths } from './paths.js';
import type { BuildTarget } from './verify.js';

export type AcceptedBuild = {version: number; settingsRevision: number; digest: string};
export type LockEntry = AcceptedBuild & {
  skillId: string; target: BuildTarget; route: string; name: string; workspaceId: string;
  keyId: string; signature: string; hasCode: boolean; draft: boolean;
  acceptedAt: string; acceptedBy: 'install' | 'update' | 'always' | 'forced';
  previous: AcceptedBuild | null; allowedDigests: string[];
  keepLocal: {version: number; localDigest: string} | null;
  agentId?: string;
  removed?: boolean;
};
export type SkillLock = {
  format: 1; helperId: string; updatedAt: string; entries: LockEntry[];
  previousHelperIds?: string[];
  replaced: {sessionId: string; home: string; folderName: string; backupId: string}[];
};
export type PendingWrite = {
  format: 1; helperId: string; operation: 'place' | 'remove'; entry: LockEntry;
  prior: LockEntry | null; stagedName: string | null;
  itemId?: string;
  backupId?: string;
  /** Explicit replacement of the exact unmanaged tree reported by this helper. */
  unmanagedDigest?: string;
};
export const entryKey = (entry: Pick<LockEntry, 'skillId' | 'target' | 'name'>) => JSON.stringify([entry.skillId, entry.target, entry.name]);
export function safeName(value: unknown): value is string {
  return typeof value === 'string' && value === value.normalize('NFC') && value.length > 0 &&
    Buffer.byteLength(value) <= 255 && !/[\\/]/u.test(value) && !Array.from(value).some(character => {
      const code = character.codePointAt(0)!; return code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029;
    }) && value !== '.' && value !== '..' && value !== '.maddots' && value !== '.DS_Store';
}
const pairValid = (value: AcceptedBuild) => Number.isSafeInteger(value.version) && value.version > 0 &&
  Number.isSafeInteger(value.settingsRevision) && value.settingsRevision >= 0 && /^[a-f0-9]{64}$/.test(value.digest);
export function validEntry(entry: LockEntry): boolean {
  return !!entry && pairValid(entry) && safeName(entry.skillId) && safeName(entry.name) && safeName(entry.route) && safeName(entry.workspaceId) &&
    ['folder', 'claude-plugin', 'desktop-zip'].includes(entry.target) && /^[a-f0-9]{16}$/.test(entry.keyId) &&
    typeof entry.signature === 'string' && typeof entry.hasCode === 'boolean' && typeof entry.draft === 'boolean' &&
    typeof entry.acceptedAt === 'string' && Number.isFinite(Date.parse(entry.acceptedAt)) &&
    ['install', 'update', 'always', 'forced'].includes(entry.acceptedBy) &&
    (entry.previous === null || pairValid(entry.previous)) && Array.isArray(entry.allowedDigests) &&
    entry.allowedDigests.every(digest => /^[a-f0-9]{64}$/.test(digest)) &&
    (entry.keepLocal === null || (Number.isSafeInteger(entry.keepLocal.version) && /^[a-f0-9]{64}$/.test(entry.keepLocal.localDigest))) &&
    (entry.agentId === undefined || safeName(entry.agentId)) && (entry.removed === undefined || typeof entry.removed === 'boolean');
}
export class LockStore {
  readonly file: string;
  readonly pendingFile: string;
  private readonly pendingDirectory: string;
  constructor(readonly paths: HelperPaths, readonly helperId: string, private readonly filename: 'lock.json' | 'agent-lock.json' = 'lock.json') {
    this.file = join(paths.data, filename); this.pendingFile = join(paths.data, 'sync-pending.json');
    this.pendingDirectory = join(paths.data, 'sync-pending');
  }
  private validate(lock: SkillLock): void {
    if (!lock || lock.format !== 1 || !safeName(lock.helperId) ||
        (lock.previousHelperIds !== undefined && (!Array.isArray(lock.previousHelperIds) || lock.previousHelperIds.length > 20 || lock.previousHelperIds.some(id => !safeName(id)))) ||
        !Array.isArray(lock.entries) || lock.entries.length > 2000 ||
        lock.entries.some(entry => !validEntry(entry) || (this.filename === 'agent-lock.json' ? !safeName(entry.agentId) : entry.agentId !== undefined)) ||
        new Set(lock.entries.map(entry => this.filename === 'agent-lock.json' ? JSON.stringify([entry.agentId, entryKey(entry)]) : entryKey(entry))).size !== lock.entries.length ||
        !Array.isArray(lock.replaced) || lock.replaced.some(value => !value || !safeName(value.sessionId) || !safeName(value.home) || !safeName(value.folderName) || !safeName(value.backupId))) {
      throw new HelperError('LOCK_INVALID', 'The skill lock is invalid.');
    }
  }
  async read(): Promise<SkillLock> {
    let text: string;
    try { text = await readPrivateFile(this.file, 4 * 1024 * 1024); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {format: 1, helperId: this.helperId, updatedAt: new Date(0).toISOString(), entries: [], replaced: []};
      throw error;
    }
    let lock: SkillLock;
    try { lock = JSON.parse(text); } catch { throw new HelperError('LOCK_INVALID', 'The skill lock is invalid.'); }
    this.validate(lock); return lock;
  }
  async write(lock: SkillLock): Promise<void> {
    this.validate(lock);
    if (lock.helperId !== this.helperId) throw new HelperError('LOCK_INVALID', 'Adopt the skill lock before writing with a new helper.');
    await atomicWrite(this.file, JSON.stringify(lock) + '\n');
  }
  /** Call while holding the helper write lock. Preserve the exact original before adoption. */
  async adopt(): Promise<void> {
    let text: string;
    try { text = await readPrivateFile(this.file, 4 * 1024 * 1024); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.adoptLegacyInstall(); return;
    }
    let lock: SkillLock;
    try { lock = JSON.parse(text); } catch { throw new HelperError('LOCK_INVALID', 'The skill lock is invalid.'); }
    this.validate(lock);
    if (lock.helperId === this.helperId) return;
    const archive = `${this.filename.slice(0, -5)}-adopted-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`;
    await atomicWrite(join(this.paths.data, archive), text);
    await this.write({...lock, helperId: this.helperId, previousHelperIds: [...new Set([...(lock.previousHelperIds ?? []), lock.helperId])].slice(-20)});
  }
  private async adoptLegacyInstall(): Promise<void> {
    if (this.filename !== 'lock.json') return;
    let text: string;
    try { text = await readPrivateFile(this.pendingFile, 1024 * 1024); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    let value: PendingWrite | null;
    try { value = JSON.parse(text); } catch { throw new HelperError('JOURNAL_INVALID', 'The pending skill write is invalid.'); }
    if (value === null) return;
    if (!value || !safeName(value.helperId)) throw new HelperError('JOURNAL_INVALID', 'The pending skill write is invalid.');
    const pending = this.parsePending(text, [value.helperId]);
    if (!pending || pending.operation !== 'place' || pending.prior !== null) throw new HelperError('JOURNAL_INVALID', 'A legacy journal without a lock must be a first install.');
    // Older helpers could crash before ever creating a lock. Only this complete
    // first-install journal may establish the previous pairing of the data folder.
    const lock = await this.read();
    await this.write({...lock, previousHelperIds: pending.helperId === this.helperId ? [] : [pending.helperId]});
  }
  knownIds(lock: SkillLock): string[] {
    return [...new Set([this.helperId, lock.helperId, ...(lock.previousHelperIds ?? [])])];
  }
  private pendingPath(key: string): string {
    return join(this.pendingDirectory, createHash('sha256').update(key).digest('hex') + '.json');
  }
  private parsePending(text: string, helperIds: readonly string[]): PendingWrite | null {
    let value: PendingWrite | null;
    try { value = JSON.parse(text); } catch { throw new HelperError('JOURNAL_INVALID', 'The pending skill write is invalid.'); }
    if (value === null) return null;
    if (value.format !== 1 || !helperIds.includes(value.helperId) || !['place', 'remove'].includes(value.operation) ||
        !validEntry(value.entry) || value.entry.agentId !== undefined ||
        (value.prior !== null && (!validEntry(value.prior) || value.prior.agentId !== undefined || entryKey(value.prior) !== entryKey(value.entry))) ||
        (value.operation === 'place' ? !safeName(value.stagedName) : value.stagedName !== null) ||
        (value.backupId !== undefined && (value.operation !== 'place' || typeof value.backupId !== 'string' || !/^\d{8}T\d{9}Z-[0-9a-f-]{36}$/.test(value.backupId))) ||
        (value.itemId !== undefined && !/^[a-f0-9]{64}$/.test(value.itemId))) {
      throw new HelperError('JOURNAL_INVALID', 'The pending skill write is invalid.');
    }
    // Removed entries retain acceptance history, but no longer own the destination.
    if (value.unmanagedDigest !== undefined && (value.operation !== 'place' || (value.prior !== null && value.prior.removed !== true) || value.entry.route !== 'agents-folder' ||
        value.entry.target !== 'folder' || !value.itemId || !/^[a-f0-9]{64}$/.test(value.unmanagedDigest))) {
      throw new HelperError('JOURNAL_INVALID', 'The unmanaged replacement journal is invalid.');
    }
    return value;
  }
  private async readPending(path: string, helperIds: readonly string[]): Promise<PendingWrite | null> {
    let text: string;
    try { text = await readPrivateFile(path, 1024 * 1024); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const value = this.parsePending(text, helperIds);
    if (value && path !== this.pendingFile && this.pendingPath(entryKey(value.entry)) !== path) {
      throw new HelperError('JOURNAL_INVALID', 'The pending skill write does not match its entry key.');
    }
    return value;
  }
  async pending(key: string): Promise<PendingWrite | null> {
    if (this.filename !== 'lock.json') return null;
    return this.readPending(this.pendingPath(key), this.knownIds(await this.read()));
  }
  /** Migrate the old single journal before enumerating independent entry transactions. */
  async allPending(): Promise<PendingWrite[]> {
    // Agent locks only authorize cached builds and must never consume route journals.
    if (this.filename !== 'lock.json') return [];
    const helperIds = this.knownIds(await this.read());
    const legacy = await this.readPending(this.pendingFile, helperIds);
    if (legacy) {
      const key = entryKey(legacy.entry), path = this.pendingPath(key);
      const existing = await this.readPending(path, helperIds);
      if (existing && JSON.stringify(existing) !== JSON.stringify(legacy)) {
        throw new HelperError('JOURNAL_INVALID', 'The legacy pending write conflicts with its entry journal.');
      }
      if (!existing) {
        await ensurePrivateDirectory(this.pendingDirectory);
        await atomicWrite(path, JSON.stringify(legacy) + '\n');
      }
      // A crash before this write safely repeats migration without dropping either journal.
      await atomicWrite(this.pendingFile, 'null\n');
    }
    let names: string[];
    try { await assertNoSymlinks(this.pendingDirectory); names = await readdir(this.pendingDirectory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const pending: PendingWrite[] = [];
    for (const name of names.sort()) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const value = await this.readPending(join(this.pendingDirectory, name), helperIds);
      if (value) pending.push(value);
    }
    return pending;
  }
  async setPending(key: string, value: PendingWrite | null): Promise<void> {
    if (this.filename !== 'lock.json') throw new HelperError('JOURNAL_INVALID', 'Agent cache locks do not use delivery journals.');
    if (value) {
      const lock = await this.read();
      this.parsePending(JSON.stringify(value), this.knownIds(lock));
      if (entryKey(value.entry) !== key) throw new HelperError('JOURNAL_INVALID', 'The pending skill write does not match its entry key.');
      // Even a first-install crash must retain the pairing ID needed to adopt its journal.
      try { await lstat(this.file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await this.write(lock); }
    }
    await ensurePrivateDirectory(this.pendingDirectory);
    await atomicWrite(this.pendingPath(key), JSON.stringify(value) + '\n');
  }
}
