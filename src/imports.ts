import { readlink } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { treeDigest } from './shared/build-format.js';
import { HELPER_IMPORT_UPLOAD_BYTES, type HelperImportReceipt, type HelperImportSession, type HelperImportUpload, type HelperImportResult } from './shared/helper-imports-protocol.js';
import { scanSecrets } from './shared/skill-checks/secret-rules.js';
import { TOOL_MATRIX } from './shared/tool-matrix.js';
import { ApiError, isObject, type ApiClient } from './api.js';
import { backupUnmanaged, finishUnmanagedBackup, type BackupManifest } from './backups.js';
import { HelperError, clock, type Timing } from './config.js';
import { DeliveryRegistry, type DeliveryTarget } from './delivery/index.js';
import { LockStore, safeName } from './lock.js';
import { atomicWrite, assertNoSymlinks, inside, readPrivateFile, withWriteLock, type HelperPaths } from './paths.js';
import { readSkillTree } from './safe-fs.js';
import { scanFiles } from './scan.js';
import { readStamp, stampMatches } from './stamp.js';
import { listUnmanaged, resolveToolFolder, toolHomeRoot, toolHomes, type FolderRef } from './unmanaged.js';
import { BuildVerifier } from './verify.js';

export type ReplaceLocalInstruction = FolderRef & {
  type: 'replace_local'; sessionId: string; skillId: string; alsoLinkedFrom: FolderRef[];
};
type SavedFolder = FolderRef & {originalPath: string; links: (FolderRef & {target: string})[]; backupId?: string; complete?: boolean;
  instruction?: ReplaceLocalInstruction; reported?: boolean; failed?: string; kept?: 'protected_home'};
type SavedSession = {sessionId: string; folders: SavedFolder[]};
type ImportJournal = {format: 1; sessions: SavedSession[]; closed?: string[]};
const MAX_SESSIONS = 1000, MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
export type ImportOptions = {
  paths: HelperPaths; helperId: string; client: Pick<ApiClient, 'request'>;
  targets?: readonly DeliveryTarget[]; verifier?: BuildVerifier; timing?: Timing;
  crash?: (step: 'backup_prepared') => void | Promise<void>;
};
const identity = (ref: FolderRef) => JSON.stringify([ref.home, ref.folderName]);
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const invalid = () => new HelperError('IMPORT_SESSION_INVALID', 'Use the folders in an open import started on ai.maddots.app.');
function validRef(value: unknown): value is FolderRef & Record<string, unknown> {
  return isObject(value) && safeName(value.home) && safeName(value.folderName) &&
    !scanSecrets('', value.home).length && !scanSecrets('', value.folderName).length;
}
function validateSession(value: unknown): asserts value is HelperImportSession {
  if (!isObject(value) || !safeName(value.sessionId) || typeof value.tool !== 'string' || !TOOL_MATRIX.tools.some(tool => tool.key === value.tool) ||
      !Number.isSafeInteger(value.expiresAt) || !Array.isArray(value.folders) || !value.folders.length || value.folders.length > 100 ||
      value.folders.some(ref => !isObject(ref) || !safeName(ref.folderName) || scanSecrets('', ref.folderName).length ||
        ref.home !== undefined && (!safeName(ref.home) || scanSecrets('', ref.home).length)) ||
      new Set(value.folders.map(ref => (ref as {folderName: string}).folderName)).size !== value.folders.length) throw invalid();
}
const homePattern = (template: string) => new RegExp('^' + template.slice(2).split('*')
  .map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');
async function homeOwners(paths: HelperPaths, refs: readonly FolderRef[]) {
  const owners = new Map<string, (typeof TOOL_MATRIX.tools)[number]>();
  for (const ref of refs) {
    const rel = relative(paths.home, await toolHomeRoot(paths, ref.home)).split(sep).join('/');
    for (const tool of TOOL_MATRIX.tools)
      if (tool.homes.some(home => home.skills.startsWith('~/') && homePattern(home.skills).test(rel))) owners.set(tool.key, tool);
  }
  return [...owners.values()];
}
const errorCode = (error: unknown) => error instanceof HelperError ? error.code : (error as NodeJS.ErrnoException)?.code ?? 'REPLACE_FAILED';
const transient = (error: unknown) => error instanceof ApiError
  ? error.status >= 500 || error.status === 429 || error.code === 'READ_ONLY' || error.code.startsWith('TOKEN_')
  : /^(API_|TOKEN_)/.test(errorCode(error)) || ['EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE', 'EIO'].includes(errorCode(error));
export function replaceInstruction(value: unknown): ReplaceLocalInstruction | null {
  if (!isObject(value) || value.type !== 'replace_local') return null;
  if (!validRef(value) || !safeName(value.sessionId) || !safeName(value.skillId) || !Array.isArray(value.alsoLinkedFrom) ||
      value.alsoLinkedFrom.length > 2000 || value.alsoLinkedFrom.some(ref => !validRef(ref)) ||
      Object.keys(value).some(key => !['type', 'sessionId', 'skillId', 'home', 'folderName', 'alsoLinkedFrom'].includes(key))) throw invalid();
  return value as ReplaceLocalInstruction;
}

/** Only browser-selected sessions authorize content. The journal contains paths, never content. */
export class ImportEngine {
  private readonly verifier: BuildVerifier;
  private readonly locks: LockStore;
  private readonly timing: Timing;
  private readonly file: string;
  private readonly routes: DeliveryRegistry;
  constructor(private readonly options: ImportOptions) {
    this.verifier = options.verifier ?? new BuildVerifier();
    this.locks = new LockStore(options.paths, options.helperId);
    this.timing = options.timing ?? clock;
    this.file = join(options.paths.data, 'imports.json');
    this.routes = new DeliveryRegistry(options.targets);
  }
  private async journal(): Promise<ImportJournal> {
    let value: ImportJournal;
    try { value = JSON.parse(await readPrivateFile(this.file, MAX_JOURNAL_BYTES)); }
    catch (error) { if (absent(error)) return {format: 1, sessions: []}; throw error; }
    if (!value || value.format !== 1 || !Array.isArray(value.sessions) || value.sessions.length > MAX_SESSIONS ||
        value.closed !== undefined && (!Array.isArray(value.closed) || value.closed.length > 10000 || value.closed.some(id => !safeName(id))) ||
        value.sessions.some(session => !safeName(session.sessionId) || !Array.isArray(session.folders) || session.folders.length > 100 ||
          session.folders.some(folder => !validRef(folder) || typeof folder.originalPath !== 'string' ||
            folder.originalPath.split('/').some(part => !safeName(part)) || !Array.isArray(folder.links) || folder.links.length > 2000 ||
            folder.links.some(link => !validRef(link) || typeof link.target !== 'string' || link.target.includes('\0')) ||
            (folder.backupId !== undefined && !safeName(folder.backupId)) || (folder.complete !== undefined && typeof folder.complete !== 'boolean') ||
            (folder.reported !== undefined && typeof folder.reported !== 'boolean') ||
            (folder.failed !== undefined && (typeof folder.failed !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(folder.failed))) ||
            (folder.kept !== undefined && folder.kept !== 'protected_home') ||
            (folder.instruction !== undefined && (!replaceInstruction(folder.instruction) || identity(folder.instruction) !== identity(folder) || folder.instruction.sessionId !== session.sessionId))))) {
      throw new HelperError('IMPORT_JOURNAL_INVALID', 'The local import journal is invalid.');
    }
    return value;
  }
  private prune(journal: ImportJournal, preserveSession?: string): void {
    const done = journal.sessions.filter(session => session.folders.every(folder => folder.reported === true));
    journal.closed = [...new Set([...(journal.closed ?? []), ...done.map(session => session.sessionId)])].slice(-10000);
    journal.sessions = journal.sessions.filter(session => !done.includes(session));
    let excess = journal.sessions.length - MAX_SESSIONS;
    journal.sessions = journal.sessions.filter(session => {
      if (excess <= 0 || session.sessionId === preserveSession || session.folders.some(folder => folder.instruction || folder.backupId)) return true;
      excess--;
      journal.closed!.push(session.sessionId);
      return false;
    });
    journal.closed = [...new Set(journal.closed)].slice(-10000);
  }
  private journalText(journal: ImportJournal, preserveSession?: string): string {
    this.prune(journal, preserveSession);
    const text = JSON.stringify(journal) + '\n';
    if (journal.sessions.length > MAX_SESSIONS || Buffer.byteLength(text) > MAX_JOURNAL_BYTES)
      throw new HelperError('IMPORT_JOURNAL_FULL', 'Finish Replace local copies for earlier imports before importing more.');
    return text;
  }
  private async save(journal: ImportJournal): Promise<void> {
    await atomicWrite(this.file, this.journalText(journal));
  }
  /** Call under the helper write lock, including from the existing service tick. */
  async uploadPending(): Promise<HelperImportReceipt[]> {
    const {data} = await this.options.client.request<unknown>('/api/helper/imports');
    if (!Array.isArray(data) || data.length > 1000) throw invalid();
    data.forEach(validateSession);
    const receipts: HelperImportReceipt[] = [];
    let failure: HelperError | undefined;
    for (const session of data) {
      try { receipts.push(await this.upload(session)); }
      catch (error) {
        if (!(error instanceof HelperError) || ['IMPORT_JOURNAL_INVALID', 'IMPORT_JOURNAL_FULL', 'API_CONNECTION_FAILED', 'API_TIMEOUT', 'API_CANCELLED',
          'SCOPE_MISSING', 'READ_ONLY'].includes(error.code) || error.code.startsWith('TOKEN_') ||
          error instanceof ApiError && (error.status === 401 || error.status >= 500)) throw error;
        failure ??= error;
        receipts.push({sessionId: session.sessionId, state: 'failed', resultVersionIds: []});
      }
    }
    if (failure && receipts.every(receipt => receipt.state === 'failed')) throw failure;
    return receipts;
  }
  async poll(): Promise<HelperImportReceipt[]> {
    return withWriteLock(this.options.paths, () => this.uploadPending(), this.timing);
  }
  private async upload(session: HelperImportSession): Promise<HelperImportReceipt> {
    if (session.expiresAt <= this.timing.now()) throw invalid();
    const journal = await this.journal(), lock = await this.locks.read();
    const unmanaged = await listUnmanaged(this.options.paths, {verifier: this.verifier, helperIds: this.locks.knownIds(lock)});
    const serving = new Set((await toolHomes(this.options.paths)).filter(home => home.tools.includes(session.tool)).map(home => home.home));
    const clean: HelperImportUpload['folders'] = [], results: HelperImportResult[] = [], saved: SavedFolder[] = [];
    const denied = new Map<string, string>(), managed = new Map<string, string>();
    const candidates = (folderName: string) => unmanaged.flatMap(listed => [{home: listed.home, folderName: listed.folderName, realPath: listed.realPath, listed, primary: !listed.link},
      ...listed.alsoLinkedFrom.map(alias => ({...alias, realPath: listed.realPath, listed, primary: false}))])
      .filter(ref => ref.folderName === folderName && serving.has(ref.home));
    let size = Buffer.byteLength('{"folders":[]}');
    // Managed folders are omitted from the listing. Settle ticked managed-only names as blocked metadata.
    for (const selected of session.folders) for (const home of candidates(selected.folderName).length ? [] : serving) {
      try {
        const candidate = await resolveToolFolder(this.options.paths, {home, folderName: selected.folderName});
        let stamped = false;
        try { await readStamp(candidate.realPath, this.verifier, this.locks.knownIds(lock)); stamped = true; } catch { /* unmanaged */ }
        if (stamped) managed.set(selected.folderName, home);
      } catch (error) {
        if (error instanceof HelperError && error.code === 'IMPORT_SESSION_INVALID') throw error;
        if (['EACCES', 'EPERM', 'ELOOP'].includes(errorCode(error))) denied.set(selected.folderName, home);
      }
    }
    // Read and scan the complete selection before any HTTP mutation.
    for (const selected of session.folders) {
      const refs = candidates(selected.folderName);
      const distinct = new Set(refs.map(ref => ref.realPath)).size;
      if (managed.has(selected.folderName)) {
        results.push({home: managed.get(selected.folderName)!, folderName: selected.folderName, status: 'blocked', findings: [{rule: 'unsafe-path', path: '[redacted]', line: 1}]});
        continue;
      }
      if (distinct === 0 && denied.has(selected.folderName)) {
        results.push({home: denied.get(selected.folderName)!, folderName: selected.folderName, status: 'blocked', findings: [{rule: 'read-failed', path: '[redacted]', line: 1}]});
        continue;
      }
      if (distinct !== 1) {
        results.push({folderName: selected.folderName, status: 'unavailable', reason: distinct ? 'ambiguous' : 'not_found'});
        continue;
      }
      const chosen = refs.find(ref => ref.primary) ?? refs[0], listed = chosen.listed;
      const ref = {home: chosen.home, folderName: selected.folderName};
      const refuse = (rule: string) => results.push({...ref, status: 'blocked', findings: [{rule, path: '[redacted]', line: 1}]});
      try {
        await toolHomeRoot(this.options.paths, ref.home);
        const folder = await resolveToolFolder(this.options.paths, ref);
        let stamped = false;
        try { await readStamp(folder.realPath, this.verifier, this.locks.knownIds(lock)); stamped = true; } catch { /* unmanaged */ }
        if (stamped) { refuse('unsafe-path'); continue; }
        if (folder.realPath !== listed.realPath) throw new HelperError('PATH_CHANGED', 'The selected folder changed since it was listed.');
        const files = await readSkillTree(folder.realPath, this.options.paths.home);
        if (!files.some(file => file.path === 'SKILL.md')) throw new HelperError('FILE_UNSAFE', 'The selected folder has no SKILL.md.');
        if (files.some(file => file.path.split('/').includes('.maddots'))) throw new HelperError('IMPORT_PATH_INVALID', 'Imports cannot contain helper metadata.');
        const scan = scanFiles(files);
        if (scan.blocked) { results.push({...ref, status: 'blocked', findings: scan.findings.slice(0, 100)}); continue; }
        const links: SavedFolder['links'] = [];
        for (const alias of [listed, ...listed.alsoLinkedFrom]) {
          const resolved = await resolveToolFolder(this.options.paths, alias);
          if (resolved.realPath !== folder.realPath) throw new HelperError('PATH_CHANGED', 'A local skill link changed before import.');
          if (resolved.link) links.push({home: alias.home, folderName: alias.folderName, target: await readlink(resolved.path)});
        }
        const entry = {...ref, files: files.map(file => ({path: file.path, mode: file.mode, content: file.content.toString('base64')}))};
        const added = Buffer.byteLength(JSON.stringify(entry)) + (clean.length ? 1 : 0);
        if (size + added > HELPER_IMPORT_UPLOAD_BYTES) { refuse('upload-size-limit'); continue; }
        size += added; clean.push(entry);
        saved.push({...ref, originalPath: relative(this.options.paths.home, folder.realPath).split(sep).join('/'), links});
      } catch (error) {
        if (error instanceof HelperError && error.code === 'IMPORT_SESSION_INVALID') throw error;
        const code = errorCode(error);
        const rule = code === 'BUILD_TOO_LARGE' ? 'folder-size-limit' : code === 'FILE_UNSAFE' ? 'file-size-limit'
          : ['PATH_UNSAFE', 'IMPORT_PATH_INVALID', 'BUILD_INVALID', 'PATH_CHANGED'].includes(code) ? 'unsafe-path' : 'read-failed';
        refuse(rule);
      }
    }
    const body = {folders: clean};
    if (Buffer.byteLength(JSON.stringify(body)) > HELPER_IMPORT_UPLOAD_BYTES)
      throw new HelperError('IMPORT_TOO_LARGE', 'The selected folders exceed the single-upload limit. Choose a smaller selection.');
    if (clean.length) {
      const prior = journal.sessions.find(value => value.sessionId === session.sessionId);
      if (prior?.folders.some(folder => folder.backupId || folder.instruction)) throw invalid();
      if (prior) prior.folders = saved;
      else journal.sessions.push({sessionId: session.sessionId, folders: saved});
      // Check provenance capacity before posting any result or content.
      this.journalText(journal, session.sessionId);
    }
    let receipt: HelperImportReceipt = {sessionId: session.sessionId, state: 'blocked', resultVersionIds: []};
    for (const result of results) receipt = (await this.options.client.request<HelperImportReceipt>(`/api/helper/imports/${session.sessionId}/results`,
      {method: 'POST', body: result})).data;
    if (!clean.length) return receipt;
    if (session.expiresAt <= this.timing.now()) throw invalid();
    await this.save(journal);
    return (await this.options.client.request<HelperImportReceipt>(`/api/helper/imports/${session.sessionId}/uploads`, {method: 'POST', body})).data;
  }
  private async revoked(): Promise<{digest: string}[]> {
    try {
      const meta = JSON.parse(await readPrivateFile(join(this.options.paths.data, 'sync-meta.json'), MAX_JOURNAL_BYTES));
      if (!Array.isArray(meta.revoked) || meta.revoked.some((entry: unknown) => !isObject(entry) || !safeName(entry.skillId) || typeof entry.digest !== 'string' || !/^[a-f0-9]{64}$/.test(entry.digest))) throw new HelperError('SYNC_META_INVALID', 'The sync revocation list is invalid.');
      return meta.revoked;
    } catch (error) {
      if (absent(error)) return [];
      if (error instanceof SyntaxError) throw new HelperError('SYNC_META_INVALID', 'The sync revocation list is invalid.');
      throw error;
    }
  }
  private async delivered(skillId: string, original: string, refs: readonly FolderRef[]): Promise<boolean> {
    const lock = await this.locks.read();
    const revoked = await this.revoked();
    const covered = new Set<string>();
    for (const entry of lock.entries.filter(entry => entry.skillId === skillId && !entry.removed)) {
      if (covered.has(entry.route)) continue;
      if (revoked.some(value => value.digest === entry.digest) || entry.hasCode && !entry.allowedDigests.includes(entry.digest)) continue;
      const definition = TOOL_MATRIX.routes[entry.route];
      if (!definition || definition.kind === 'zip' || !definition.path.startsWith('~/')) continue;
      const root = resolve(this.options.paths.home, definition.path.slice(2));
      const adapter = this.routes.all().find(target => target.route === entry.route);
      if (!adapter && definition.kind !== 'folder') continue;
      const destination = adapter?.folderFor(entry) ?? join(root, entry.name);
      if (resolve(destination) === original || !inside(root, resolve(destination)) || resolve(destination) === root) continue;
      try {
        await assertNoSymlinks(destination, this.options.paths.home);
        if (stampMatches(await readStamp(destination, this.verifier, this.locks.knownIds(lock)), entry) &&
            treeDigest(await readSkillTree(destination, this.options.paths.home)) === entry.digest) covered.add(entry.route);
      } catch (error) { if (!absent(error) && !(error instanceof HelperError)) throw error; }
    }
    // An outer alias may target another tool's physical home under a different name.
    const canonical = (await toolHomes(this.options.paths)).filter(home => inside(home.root, original))
      .map(home => ({home: home.home, folderName: refs[0].folderName}));
    const owners = await homeOwners(this.options.paths, [...refs, ...canonical]);
    return owners.length > 0 && owners.every(tool => [...covered].some(route => {
      const definition = TOOL_MATRIX.routes[route];
      return tool.reads.includes(definition.readPath ?? definition.path);
    }));
  }
  /** Authenticated plan instructions are the browser's recorded click. Call under the write lock. */
  async executeInstructions(instructions: readonly unknown[]): Promise<void> {
    const pending = await this.journal();
    // Shared corruption must remain recoverable after repair, never become a terminal folder failure.
    await this.locks.read();
    await this.revoked();
    let changed = false;
    for (const raw of instructions) {
      let instruction: ReplaceLocalInstruction | null;
      try { instruction = replaceInstruction(raw); } catch { continue; }
      if (!instruction || pending.closed?.includes(instruction.sessionId)) continue;
      const selected = pending.sessions.find(session => session.sessionId === instruction.sessionId)?.folders.find(folder => identity(folder) === identity(instruction));
      if (!selected || selected.instruction) continue;
      selected.instruction = instruction; changed = true;
    }
    if (changed) await this.save(pending);
    let retry: unknown;
    for (const folder of pending.sessions.flatMap(session => session.folders).filter(folder => folder.instruction && !folder.reported && !folder.failed)) {
      try { await this.replaceOne(pending, folder); }
      catch (error) {
        if (error instanceof HelperError && error.code.startsWith('TOKEN_')) throw error;
        if (transient(error) || folder.backupId && !folder.complete && ['EACCES', 'EPERM'].includes(errorCode(error))) {
          // A later server failure must not be hidden by an earlier local retry.
          if (retry === undefined || error instanceof HelperError && !(retry instanceof HelperError)) retry = error;
          continue;
        }
        const raw = errorCode(error);
        folder.failed = ['ENOENT', 'ENOTDIR'].includes(raw) ? 'ORIGINAL_MISSING' : /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : 'REPLACE_FAILED';
        await this.save(pending);
      }
    }
    if (retry) throw retry;
  }
  private async replaceOne(journal: ImportJournal, folder: SavedFolder): Promise<void> {
    const instruction = folder.instruction!, original = resolve(this.options.paths.home, folder.originalPath);
    const claudeSkills = join(this.options.paths.home, '.claude', 'skills');
    const touchesClaude = async () => [original, ...await Promise.all([folder, ...folder.links, ...instruction.alsoLinkedFrom]
      .map(async ref => join(await toolHomeRoot(this.options.paths, ref.home), ref.folderName)))]
      .some(path => inside(claudeSkills, path) || inside(path, claudeSkills));
    if (!folder.complete && (folder.kept || await touchesClaude())) {
      if (!folder.kept) { folder.kept = 'protected_home'; await this.save(journal); }
      await this.options.client.request(`/api/helper/imports/${instruction.sessionId}/results`, {method: 'POST',
        body: {home: instruction.home, folderName: instruction.folderName, skillId: instruction.skillId, status: 'kept', reason: 'protected_home'}});
      folder.reported = true;
      await this.save(journal);
      return;
    }
    if (!folder.complete) {
      if (!await this.delivered(instruction.skillId, original, [folder, ...folder.links, ...instruction.alsoLinkedFrom])) return;
      // Once backupId is journaled, aliases were saved with it and the original may already have moved.
      if (!folder.backupId) for (const ref of instruction.alsoLinkedFrom) {
        if (folder.links.some(link => identity(link) === identity(ref))) continue;
        let alias: Awaited<ReturnType<typeof resolveToolFolder>>;
        try { alias = await resolveToolFolder(this.options.paths, ref); } catch (error) { if (absent(error)) continue; throw error; }
        if (alias.realPath === original && alias.path === original) continue;
        if (!alias.link || alias.realPath !== original) throw invalid();
        folder.links.push({...ref, target: await readlink(alias.path)});
      }
      let backup: BackupManifest;
      if (folder.backupId) backup = await finishUnmanagedBackup(this.options.paths, folder.backupId,
        {originalPath: folder.originalPath, original: {home: folder.home, folderName: folder.folderName}, links: folder.links});
      else {
        const current = await resolveToolFolder(this.options.paths, folder);
        if (current.realPath !== original) throw new HelperError('PATH_CHANGED', 'The imported original moved; replacement stopped.');
        backup = await backupUnmanaged(this.options.paths, original, folder, folder.links, this.timing.now(), async manifest => {
          folder.backupId = manifest.id;
          await this.save(journal);
          await this.options.crash?.('backup_prepared');
        });
      }
      const lock = await this.locks.read();
      if (!lock.replaced.some(value => value.sessionId === instruction.sessionId && identity(value) === identity(folder))) {
        lock.replaced.push({sessionId: instruction.sessionId, home: folder.home, folderName: folder.folderName, backupId: backup.id});
        lock.updatedAt = new Date(this.timing.now()).toISOString();
        await this.locks.write(lock);
      }
      folder.complete = true;
      await this.save(journal);
    }
    await this.options.client.request(`/api/helper/imports/${instruction.sessionId}/results`, {method: 'POST',
      body: {home: instruction.home, folderName: instruction.folderName, skillId: instruction.skillId, status: 'replaced', backupId: folder.backupId}});
    folder.reported = true;
    await this.save(journal);
  }
  async applyInstructions(instructions: readonly unknown[]): Promise<void> {
    return withWriteLock(this.options.paths, () => this.executeInstructions(instructions), this.timing);
  }
}

/** Human-readable local listing may show full targets; inventory uses unmanagedInventory instead. */
export async function describeUnmanaged(paths: HelperPaths, helperId: string): Promise<string[]> {
  const locks = new LockStore(paths, helperId), lock = await locks.read();
  const folders = await listUnmanaged(paths, {helperIds: locks.knownIds(lock)});
  return folders.map(folder => `${folder.home}/${folder.folderName}${folder.link ? ` -> ${folder.link.target}` : ''}` +
    (folder.alsoLinkedFrom.length ? ` (also linked from ${folder.alsoLinkedFrom.map(ref => `${ref.home}/${ref.folderName}`).join(', ')})` : ''));
}
