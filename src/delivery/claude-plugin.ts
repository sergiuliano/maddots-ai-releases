import { constants, watch } from 'node:fs';
import { createHash } from 'node:crypto';
import { access, lstat, mkdir, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { treeDigest } from '../shared/build-format.js';
import { TOOL_MATRIX, validateToolMatrix, type ToolMatrix } from '../shared/tool-matrix.js';
import { backupFolder } from '../backups.js';
import { cleanEnvironment, HelperError, runCommand, type Runner } from '../config.js';
import { entryKey, LockStore, safeName, type LockEntry } from '../lock.js';
import { assertNoSymlinks, atomicWrite, ensurePrivateDirectory, inside, readPrivateFile, withWriteLock, type HelperPaths } from '../paths.js';
import { assertRouteRoot, durableRename, readSkillTree } from '../safe-fs.js';
import { readStamp } from '../stamp.js';
import { SyncEngine, type DeliveryError, type SyncInventory, type SyncOptions, type SyncPlan } from '../sync.js';
import { BuildVerifier, type PlanItem, type SignedBuild } from '../verify.js';
import type { DeliveryTarget } from './index.js';

type Skill = Pick<LockEntry, 'skillId' | 'target' | 'name' | 'workspaceId'>;
type Plugin = {workspaceId: string; slug: string; counter: number; fingerprint: string; installed: number};
type Registration = {format: 1; marketplaceAdded: boolean; plugins: Plugin[]; readCopyRepairs?: string[]};
export type ClaudePluginOptions = {
  paths: HelperPaths; helperId: string; runner?: Runner; env?: NodeJS.ProcessEnv;
  /** An already detected absolute CLI path, or null when only an app was found. */
  claudePath?: string | null;
  matrix?: ToolMatrix;
  /** Stable workspace slugs from the caller; IDs are used when no mapping exists. */
  workspaceSlugs?: Readonly<Record<string, string>>;
};
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const unregistered = '0'.repeat(64);
const validRepairKey = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 2000) return false;
  try { const key = JSON.parse(value); return Array.isArray(key) && key.length === 3 && safeName(key[0]) && key[1] === 'claude-plugin' && safeName(key[2]); }
  catch { return false; }
};

/** Source files remain in the TLS-13 route. Claude's cache is observation-only. */
export class ClaudePluginDeliveryTarget implements DeliveryTarget {
  readonly route = 'claude-plugin';
  readonly target = 'claude-plugin';
  readonly paths: HelperPaths;
  readonly helperId: string;
  private readonly matrix: ToolMatrix;
  private readonly runner: Runner;
  private readonly env: NodeJS.ProcessEnv;
  private binary: string | undefined;
  private registrationError: string | null = null;
  private sourceErrors = new Map<string, string>();
  private failedWorkspaces = new Map<string, string>();
  private bound = new Map<string, string>();
  private stateUnreadable = false;
  private readCopyRepairs = new Set<string>();
  private waiting: Skill[] = [];
  private waitingCode = 'CLAUDE_CLI_MISSING';
  constructor(private readonly options: ClaudePluginOptions) {
    this.paths = options.paths; this.helperId = options.helperId;
    this.matrix = options.matrix ? validateToolMatrix(options.matrix) : TOOL_MATRIX;
    this.runner = options.runner ?? runCommand;
    this.env = cleanEnvironment({...options.env ?? process.env, HOME: this.paths.home});
    const route = this.matrix.routes[this.route];
    if (!route || route.kind !== this.target || route.target !== this.target || route.path !== TOOL_MATRIX.routes[this.route].path) {
      throw new HelperError('ROUTE_INVALID', 'Claude plugins must use the matrix marketplace route.');
    }
    if (options.claudePath && !isAbsolute(options.claudePath)) throw new HelperError('PATH_UNSAFE', 'The detected Claude CLI path must be absolute.');
    const slugs = Object.values(options.workspaceSlugs ?? {});
    if (slugs.some(slug => !slugPattern.test(slug) || slug.length > 200) || new Set(slugs).size !== slugs.length) {
      throw new HelperError('PLUGIN_WORKSPACE_INVALID', 'Workspace plugin slugs must be safe and unique.');
    }
  }
  private slug(workspaceId: string): string {
    if (!safeName(workspaceId)) throw new HelperError('PATH_UNSAFE', 'Invalid workspace identifier.');
    const saved = this.bound.get(workspaceId); if (saved) return saved;
    const mapped = this.options.workspaceSlugs && Object.hasOwn(this.options.workspaceSlugs, workspaceId) ? this.options.workspaceSlugs[workspaceId] : undefined;
    const slug = mapped ?? (slugPattern.test(workspaceId) && workspaceId.length <= 200 ? workspaceId : `workspace-${digest(workspaceId).slice(0, 32)}`);
    if (!slugPattern.test(slug) || slug.length > 200) throw new HelperError('PLUGIN_WORKSPACE_INVALID', 'Invalid workspace plugin slug.');
    return slug;
  }
  pluginName(workspaceId: string): string { return `maddots-${this.slug(workspaceId)}`; }
  namespacedName(entry: Skill): string { this.folderFor(entry); return `${this.pluginName(entry.workspaceId)}:${entry.name}`; }
  private directory(): string { return resolve(this.paths.home, this.matrix.routes[this.route].path.slice(2)); }
  async root(): Promise<string> {
    const root = this.directory();
    await assertNoSymlinks(root, this.paths.home);
    await mkdir(root, {recursive: true, mode: 0o700});
    await assertRouteRoot(this.paths, root);
    await this.state().catch(() => { this.stateUnreadable = true; });
    return root;
  }
  folderFor(entry: Skill): string {
    if (this.stateUnreadable) throw new HelperError('PLUGIN_STATE_INVALID', 'The saved workspace plugin names cannot be read safely.');
    if (entry.target !== this.target || !slugPattern.test(entry.name) || !safeName(entry.name)) throw new HelperError('PATH_UNSAFE', 'Invalid plugin skill destination.');
    return join(this.directory(), this.pluginName(entry.workspaceId), 'skills', entry.name);
  }
  /** TLS-05 has not added command fields to the matrix yet. These are its brief's provisional vectors. */
  commands(workspaceId: string): readonly (readonly string[])[] {
    const plugin = `${this.pluginName(workspaceId)}@maddots-ai`;
    return [['plugin', 'marketplace', 'add', this.directory()], ['plugin', 'install', plugin],
      ['plugin', 'marketplace', 'update', 'maddots-ai'], ['plugin', 'update', plugin]];
  }
  /** Read-only: refuse to repoint a person's own marketplace, including after a previous registration. */
  private async marketplaceIsOurs(run: (args: readonly string[]) => Promise<{stdout: string; stderr: string}>): Promise<boolean> {
    const listed = await run(['plugin', 'marketplace', 'list', '--json']);
    let marketplaces: unknown;
    try { marketplaces = JSON.parse(listed.stdout); } catch { throw new HelperError('CLAUDE_PLUGIN_COMMAND_FAILED', 'Claude Code returned an unreadable marketplace list.'); }
    if (!Array.isArray(marketplaces)) throw new HelperError('CLAUDE_PLUGIN_COMMAND_FAILED', 'Claude Code returned an unreadable marketplace list.');
    const existing = marketplaces.find(item => item && typeof item === 'object' && item.name === 'maddots-ai') as {source?: unknown; path?: unknown} | undefined;
    if (!existing) return false;
    const root = await realpath(this.directory());
    const path = typeof existing.path === 'string' && isAbsolute(existing.path) ? await realpath(existing.path).catch(() => resolve(existing.path as string)) : null;
    if (existing.source !== 'directory' || path !== root) {
      throw new HelperError('UNMANAGED_CONFLICT', 'Claude Code already has a marketplace named maddots-ai from another source. Remove or rename it, then sync again.');
    }
    return true;
  }
  waitingHint(workspaceId: string, installed = false): string {
    const commands = this.commands(workspaceId);
    const lines = installed ? [commands[2], commands[3]] : [['plugin', 'marketplace', 'add', this.matrix.routes[this.route].path], commands[1]];
    return lines.map(args => `claude ${args.join(' ')}`).join('\n');
  }
  async requireCli(): Promise<string> {
    if (this.binary) {
      try { await access(this.binary, constants.X_OK); return this.binary; }
      catch { this.binary = undefined; }
    }
    const variant = this.matrix.tools.find(tool => tool.key === 'claude-code')?.variants.find(variant => variant.detect.binaries.length);
    const candidates = this.options.claudePath === null ? [] : this.options.claudePath ? [this.options.claudePath] :
      (variant?.detect.binaries ?? []).flatMap(binary => binary.includes('/') ? [binary.replace(/^~(?=\/)/u, this.paths.home)] :
        (this.env.PATH ?? '').split(':').filter(isAbsolute).slice(0, 256).map(directory => join(directory, binary)));
    for (const candidate of candidates) {
      if (!isAbsolute(candidate) || !variant) continue;
      try {
        if (!(await stat(candidate)).isFile()) continue;
        await access(candidate, constants.X_OK);
        const absolute = await realpath(candidate);
        const result = await this.runner(absolute, variant.detect.versionArgs, {timeout: 10_000, env: this.env});
        if (result.stdout.length + result.stderr.length > 1024 * 1024 || !new RegExp(variant.detect.versionPattern, 'imu').test(`${result.stdout}\n${result.stderr}`)) continue;
        this.binary = absolute; return this.binary;
      } catch { /* Try another matrix binary, without exposing CLI output. */ }
    }
    throw new HelperError('CLAUDE_CLI_MISSING', 'Claude Code is waiting for its CLI. Run maddots-ai status for the commands.');
  }
  async setWaiting(items: Skill[], code = 'CLAUDE_CLI_MISSING'): Promise<void> {
    await atomicWrite(join(this.paths.data, 'claude-plugin-waiting.json'), JSON.stringify({format: 1, code, workspaceIds: [...new Set(items.map(item => item.workspaceId))].sort()}) + '\n');
    this.waiting = items; this.waitingCode = code;
  }
  async statusLines(): Promise<string[]> {
    let waiting: {format: number; code: string; workspaceIds: string[]};
    try { waiting = JSON.parse(await readPrivateFile(join(this.paths.data, 'claude-plugin-waiting.json'))); }
    catch (error) { if (absent(error)) return []; throw new HelperError('PLUGIN_STATE_INVALID', 'Invalid Claude waiting state.'); }
    if (!waiting || waiting.format !== 1 || !safeName(waiting.code) || !Array.isArray(waiting.workspaceIds) || waiting.workspaceIds.length > 2000 || waiting.workspaceIds.some(id => !safeName(id))) {
      throw new HelperError('PLUGIN_STATE_INVALID', 'Invalid Claude waiting state.');
    }
    if (waiting.code !== 'CLAUDE_CLI_MISSING' || !waiting.workspaceIds.length) return [];
    const state = await this.state();
    return ["Claude Code skills are waiting: the claude CLI was not found on the helper's PATH. Once it is found, MadDots runs:",
      ...waiting.workspaceIds.map(id => this.waitingHint(id, !!state.plugins.find(plugin => plugin.workspaceId === id)?.installed))];
  }
  async validateWorkspaces(items: readonly Skill[]): Promise<void> {
    const state = await this.state();
    const entries = (await new LockStore(this.paths, this.helperId).read()).entries.filter(entry => entry.route === this.route);
    const bySlug = new Map(state.plugins.map(plugin => [plugin.slug, plugin.workspaceId]));
    for (const entry of [...entries, ...items]) {
      const slug = this.slug(entry.workspaceId), prior = state.plugins.find(plugin => plugin.workspaceId === entry.workspaceId);
      if (prior && prior.slug !== slug || bySlug.has(slug) && bySlug.get(slug) !== entry.workspaceId) {
        throw new HelperError('PLUGIN_WORKSPACE_INVALID', 'Workspace plugin slugs cannot change or collide.');
      }
      bySlug.set(slug, entry.workspaceId);
    }
  }
  async place(build: SignedBuild, stagedDir: string): Promise<void> {
    await this.validateWorkspaces([build]);
    await this.requireCli();
    await this.root();
    const destination = this.folderFor(build), parent = dirname(destination);
    await assertNoSymlinks(parent, this.paths.home);
    await mkdir(parent, {recursive: true, mode: 0o700});
    await assertRouteRoot(this.paths, this.directory());
    await this.bind(build.workspaceId);
    await durableRename(stagedDir, destination);
  }
  async remove(entry: LockEntry, _reason: string): Promise<void> {
    await this.state();
    await this.root(); await assertNoSymlinks(this.folderFor(entry), this.paths.home);
    // TLS-13 already preserved the removed skill in backups. Keep the empty plugin.
  }
  private stateFile(): string { return join(this.paths.data, 'claude-plugin-registration.json'); }
  private async state(): Promise<Registration> {
    let state: Registration;
    try { state = JSON.parse(await readPrivateFile(this.stateFile())); }
    catch (error) {
      if (absent(error)) { this.bound = new Map(); this.readCopyRepairs = new Set(); this.stateUnreadable = false; return {format: 1, marketplaceAdded: false, plugins: []}; }
      throw new HelperError('PLUGIN_STATE_INVALID', 'Invalid plugin registration state.');
    }
    if (!state || state.format !== 1 || typeof state.marketplaceAdded !== 'boolean' || !Array.isArray(state.plugins) || state.plugins.length > 2000 ||
      state.readCopyRepairs !== undefined && (!Array.isArray(state.readCopyRepairs) || state.readCopyRepairs.length > 2000 || state.readCopyRepairs.some(key => !validRepairKey(key))) ||
      state.plugins.some(plugin => !plugin || !safeName(plugin.workspaceId) || !slugPattern.test(plugin.slug) || plugin.slug.length > 200 ||
        !Number.isSafeInteger(plugin.counter) || plugin.counter < 1 || !Number.isSafeInteger(plugin.installed) || plugin.installed < 0 || plugin.installed > plugin.counter || !/^[a-f0-9]{64}$/u.test(plugin.fingerprint)) ||
      new Set(state.plugins.map(plugin => plugin.workspaceId)).size !== state.plugins.length || new Set(state.plugins.map(plugin => plugin.slug)).size !== state.plugins.length) {
      throw new HelperError('PLUGIN_STATE_INVALID', 'Invalid plugin registration state.');
    }
    this.bound = new Map(state.plugins.map(plugin => [plugin.workspaceId, plugin.slug]));
    this.readCopyRepairs = new Set(state.readCopyRepairs ?? []); this.stateUnreadable = false;
    return state;
  }
  private async save(state: Registration): Promise<void> {
    await atomicWrite(this.stateFile(), JSON.stringify(state) + '\n');
    this.bound = new Map(state.plugins.map(plugin => [plugin.workspaceId, plugin.slug]));
    this.readCopyRepairs = new Set(state.readCopyRepairs ?? []); this.stateUnreadable = false;
  }
  private async bind(workspaceId: string): Promise<void> {
    const state = await this.state();
    if (state.plugins.some(plugin => plugin.workspaceId === workspaceId)) return;
    const slug = this.slug(workspaceId);
    if (state.plugins.some(plugin => plugin.slug === slug)) throw new HelperError('PLUGIN_WORKSPACE_INVALID', 'Workspace plugin slugs cannot change or collide.');
    for (const directory of [...(state.plugins.length ? [] : [join(this.directory(), '.claude-plugin')]), join(this.directory(), `maddots-${slug}`, '.claude-plugin')]) {
      try { await lstat(directory); throw new HelperError('UNMANAGED_CONFLICT', 'An unmanaged marketplace or plugin manifest already exists.'); }
      catch (error) { if (!absent(error)) throw error; }
    }
    state.plugins.push({workspaceId, slug, counter: 1, installed: 0, fingerprint: unregistered});
    state.plugins.sort((a, b) => a.slug.localeCompare(b.slug)); await this.save(state);
  }
  private async metadata(directory: string, filename: string, value: object): Promise<void> {
    const content = JSON.stringify(value, null, 2) + '\n', file = join(directory, filename);
    await assertNoSymlinks(file, this.paths.home);
    try {
      if (await readPrivateFile(file) === content) return;
      await backupFolder(this.paths, directory, this.route, 'plugin_metadata', null);
    } catch (error) { if (!absent(error)) throw error; }
    await ensurePrivateDirectory(directory);
    await atomicWrite(file, content);
  }
  /** Called with TLS-13's write lock, including after recovery and identical-item retries. */
  async reconcileRegistration(verifier = new BuildVerifier()): Promise<void> {
    this.failedWorkspaces = new Map();
    try { this.sourceErrors = await this.register(verifier); this.registrationError = null; }
    catch (error) {
      this.registrationError = this.failedWorkspaces.size ? null : error instanceof HelperError ? error.code : 'CLAUDE_PLUGIN_COMMAND_FAILED';
      throw error;
    }
  }
  hasRegistrationFailures(): boolean { return this.registrationError !== null || this.failedWorkspaces.size > 0; }
  /** Retire only verified helper copies of a committed key that moved to another workspace plugin. */
  private async retireMoved(entries: readonly LockEntry[], verifier: BuildVerifier): Promise<void> {
    const root = this.directory(), plugins: string[] = [];
    const locks = new LockStore(this.paths, this.helperId), helperIds = locks.knownIds(await locks.read());
    for (const name of await readdir(root)) {
      if (name.startsWith('maddots-') && (await lstat(join(root, name))).isDirectory()) plugins.push(name);
    }
    for (const entry of entries) {
      for (const plugin of plugins) {
        if (plugin === this.pluginName(entry.workspaceId)) continue;
        const stale = join(root, plugin, 'skills', entry.name);
        await assertNoSymlinks(stale, this.paths.home);
        let stamp;
        try { stamp = await readStamp(stale, verifier, helperIds); }
        catch (error) { if (absent(error) || error instanceof HelperError && error.code !== 'PATH_UNSAFE' && error.code !== 'FILE_UNSAFE') continue; throw error; }
        if (entryKey(stamp) !== entryKey(entry) || plugin !== this.pluginName(stamp.workspaceId)) continue;
        await backupFolder(this.paths, stale, this.route, 'workspace_moved', treeDigest(await readSkillTree(stale, this.paths.home)));
      }
    }
  }
  private async register(verifier: BuildVerifier): Promise<Map<string, string>> {
    const sourceErrors = new Map<string, string>(), blocked = new Set<string>();
    const locks = new LockStore(this.paths, this.helperId);
    if ((await locks.allPending()).some(pending => pending.entry.route === this.route)) {
      throw new HelperError('CLAUDE_PLUGIN_WAITING', 'Plugin registration waits for an interrupted Claude plugin delivery.');
    }
    const entries = (await locks.read()).entries.filter(entry => entry.route === this.route);
    const state = await this.state();
    if (!entries.length && !state.plugins.length) return sourceErrors;
    await this.root();
    await this.retireMoved(entries, verifier);
    for (const entry of entries.filter(entry => !entry.removed)) {
      let code: string | null = null;
      try { if (treeDigest(await readSkillTree(this.folderFor(entry), this.paths.home)) !== entry.digest) code = 'CLAUDE_PLUGIN_EDITED'; }
      catch (error) { if (!absent(error)) throw error; code = 'CLAUDE_PLUGIN_SOURCE_MISSING'; }
      if (code) { sourceErrors.set(entryKey(entry), code); blocked.add(entry.workspaceId); }
    }
    this.sourceErrors = sourceErrors;
    if (!state.plugins.length) {
      try { await lstat(join(this.directory(), '.claude-plugin')); throw new HelperError('UNMANAGED_CONFLICT', 'An unmanaged marketplace already exists.'); }
      catch (error) { if (!absent(error)) throw error; }
    }
    const workspaces = new Set([...entries.map(entry => entry.workspaceId), ...state.plugins.map(plugin => plugin.workspaceId)]);
    for (const workspaceId of [...workspaces].sort()) {
      const slug = this.slug(workspaceId);
      let plugin = state.plugins.find(plugin => plugin.workspaceId === workspaceId);
      if (plugin && plugin.slug !== slug || state.plugins.some(plugin => plugin.workspaceId !== workspaceId && plugin.slug === slug)) {
        throw new HelperError('PLUGIN_WORKSPACE_INVALID', 'Workspace plugin slugs cannot change or collide.');
      }
      const fingerprint = digest(JSON.stringify(entries.filter(entry => entry.workspaceId === workspaceId && !entry.removed)
        .map(entry => [entry.skillId, entry.name, entry.version, entry.settingsRevision, entry.digest]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))));
      if (blocked.has(workspaceId)) continue;
      if (!plugin) {
        const directory = join(this.directory(), `maddots-${slug}`, '.claude-plugin');
        try { await lstat(directory); throw new HelperError('UNMANAGED_CONFLICT', 'An unmanaged plugin manifest already exists.'); }
        catch (error) { if (!absent(error)) throw error; }
        plugin = {workspaceId, slug, fingerprint, counter: 1, installed: 0}; state.plugins.push(plugin);
      } else if (plugin.fingerprint === unregistered) plugin.fingerprint = fingerprint;
      else if (plugin.fingerprint !== fingerprint) { plugin.fingerprint = fingerprint; plugin.counter++; }
      if (!Number.isSafeInteger(plugin.counter)) throw new HelperError('PLUGIN_STATE_INVALID', 'Plugin version counter exhausted.');
    }
    state.plugins.sort((a, b) => a.slug.localeCompare(b.slug));
    if (!state.plugins.length) return sourceErrors;
    // Persist generation before metadata/CLI operations. Retries reuse this version.
    if (JSON.stringify(state) + '\n' !== await readPrivateFile(this.stateFile()).catch(error => {if (absent(error)) return ''; throw error;})) await this.save(state);
    if (!state.plugins.some(plugin => plugin.fingerprint !== unregistered)) return sourceErrors;
    for (const plugin of state.plugins.filter(plugin => plugin.fingerprint !== unregistered)) {
      await this.metadata(join(this.directory(), `maddots-${plugin.slug}`, '.claude-plugin'), 'plugin.json',
        {name: `maddots-${plugin.slug}`, version: `1.0.${plugin.counter}`, description: 'MadDots AI workspace skills', skills: './skills/'});
    }
    await this.metadata(join(this.directory(), '.claude-plugin'), 'marketplace.json', {name: 'maddots-ai', owner: {name: 'MadDots AI'},
      plugins: state.plugins.filter(plugin => plugin.fingerprint !== unregistered).map(plugin => ({name: `maddots-${plugin.slug}`, source: `./maddots-${plugin.slug}`, version: `1.0.${plugin.counter}`}))});
    const due = state.plugins.filter(plugin => plugin.installed !== plugin.counter && !blocked.has(plugin.workspaceId));
    if (due.length) {
      const binary = await this.requireCli();
      const run = (args: readonly string[]) => this.runner(binary, args, {timeout: 120_000, env: this.env});
      const code = (error: unknown) => error instanceof HelperError ? error.code : 'CLAUDE_PLUGIN_COMMAND_FAILED';
      const ours = await this.marketplaceIsOurs(run);
      if (!ours) await run(this.commands(due[0].workspaceId)[0]);
      if (!state.marketplaceAdded) { state.marketplaceAdded = true; await this.save(state); }
      let installed: Set<string> | undefined;
      if (due.some(plugin => plugin.installed > 0)) {
        let listed: unknown;
        try { listed = JSON.parse((await run(['plugin', 'list', '--json'])).stdout); }
        catch (error) { if (error instanceof HelperError) throw error; throw new HelperError('CLAUDE_PLUGIN_COMMAND_FAILED', 'Claude Code returned an unreadable plugin list.'); }
        if (!Array.isArray(listed)) throw new HelperError('CLAUDE_PLUGIN_COMMAND_FAILED', 'Claude Code returned an unreadable plugin list.');
        installed = new Set(listed.flatMap(plugin => plugin && typeof plugin === 'object' && typeof (plugin.id ?? plugin.name) === 'string' ? [plugin.id ?? plugin.name] : []));
      }
      const failures = new Map<string, string>();
      let marketplace: string | null | undefined;
      for (const plugin of due) {
        const commands = this.commands(plugin.workspaceId);
        try {
          if (!plugin.installed) await run(commands[1]);
          else {
            if (!installed!.has(commands[3][2])) throw new HelperError('CLAUDE_PLUGIN_NOT_INSTALLED', 'The plugin was uninstalled; registration waits for an explicit answer.');
            if (marketplace === undefined) {
              try { await run(commands[2]); marketplace = null; }
              catch (error) { marketplace = code(error); }
            }
            if (marketplace) throw new HelperError(marketplace, 'Marketplace update failed.');
            await run(commands[3]);
          }
          plugin.installed = plugin.counter; await this.save(state);
        } catch (error) { failures.set(plugin.workspaceId, code(error)); }
      }
      this.failedWorkspaces = failures;
      if (failures.size) throw new HelperError('CLAUDE_PLUGIN_COMMAND_FAILED', 'Some plugin registrations failed.');
    }
    return sourceErrors;
  }
  /** Explicit equal-pair approval repairs a missing read copy without touching it directly. */
  async repairReadCopies(items: readonly PlanItem[]): Promise<void> {
    if (!this.matrix.routes[this.route].readPath || !items.length) return;
    const locks = new LockStore(this.paths, this.helperId);
    if ((await locks.allPending()).some(pending => pending.entry.route === this.route)) return;
    const state = await this.state();
    const entries = (await locks.read()).entries.filter(entry => entry.route === this.route && !entry.removed);
    const repairs = new Set(state.readCopyRepairs ?? []);
    let changed = false;
    for (const item of items) {
      const entry = entries.find(entry => entryKey(entry) === entryKey(item) && entry.workspaceId === item.workspaceId &&
        entry.digest === item.digest && entry.version === item.version && entry.settingsRevision === item.settingsRevision);
      const plugin = state.plugins.find(plugin => plugin.workspaceId === item.workspaceId);
      if (!entry || !plugin?.installed || plugin.installed !== plugin.counter) continue;
      try { await lstat(await this.readFolderFor(entry)); }
      catch (error) { if (absent(error)) { plugin.installed = 0; changed = true; repairs.add(entryKey(entry)); } }
    }
    if (changed) { state.readCopyRepairs = [...repairs].sort(); await this.save(state); }
  }
  /** Replace is persisted by TLS-19 before registration asks Claude to re-copy. */
  async refreshReadCopy(entry: LockEntry): Promise<void> {
    if (!this.matrix.routes[this.route].readPath) return;
    const locks = new LockStore(this.paths, this.helperId);
    const accepted = (await locks.read()).entries.find(value => entryKey(value) === entryKey(entry));
    if (entry.route !== this.route || !accepted || accepted.removed || accepted.workspaceId !== entry.workspaceId ||
        accepted.version !== entry.version || accepted.settingsRevision !== entry.settingsRevision || accepted.digest !== entry.digest) {
      throw new HelperError('LOCAL_EDIT_INVALID', 'Only an accepted plugin source can refresh its read copy.');
    }
    const state = await this.state(), plugin = state.plugins.find(value => value.workspaceId === entry.workspaceId);
    if (!plugin) throw new HelperError('CLAUDE_PLUGIN_WAITING', 'The plugin has not been registered yet.');
    // A durable repair request lets normal registration perform all CLI, source
    // verification and interrupted-write checks without editing the cache here.
    plugin.installed = 0;
    state.readCopyRepairs = [...new Set([...(state.readCopyRepairs ?? []), entryKey(entry)])].sort();
    await this.save(state);
  }
  async readFolderFor(entry: Skill): Promise<string> {
    const source = this.folderFor(entry);
    const template = this.matrix.routes[this.route].readPath;
    if (!template) return source;
    const plugin = (await this.state()).plugins.find(plugin => plugin.workspaceId === entry.workspaceId);
    if (!plugin?.installed || plugin.installed !== plugin.counter) throw new HelperError('CLAUDE_PLUGIN_WAITING', 'Claude has not installed this plugin generation yet.');
    const base = template.replace(/^~(?=\/)/u, this.paths.home);
    const path = /<(?:plugin|version|name)>/u.test(base) ? base.replaceAll('<plugin>', `maddots-${plugin.slug}`).replaceAll('<version>', `1.0.${plugin.installed}`).replaceAll('<name>', entry.name) :
      join(base, `maddots-${plugin.slug}`, `1.0.${plugin.installed}`, 'skills', entry.name);
    if (!isAbsolute(path) || !inside(this.paths.home, resolve(path)) || /[<>*]/u.test(path) || inside(this.directory(), resolve(path)) || inside(this.paths.data, resolve(path))) {
      throw new HelperError('PATH_UNSAFE', 'The matrix read copy must be an unambiguous HOME-contained path.');
    }
    await assertNoSymlinks(path, this.paths.home); return path;
  }
  async observe(inventory: SyncInventory): Promise<SyncInventory> {
    const entries = (await new LockStore(this.paths, this.helperId).read()).entries.filter(entry => entry.route === this.route);
    const missingRepairs = new Set<string>();
    const managed = await Promise.all(inventory.managed.map(async item => {
      const entry = entries.find(entry => entry.skillId === item.skillId && entry.target === item.target && entry.name === item.name);
      if (!entry || entry.removed || !this.matrix.routes[this.route].readPath) return item;
      try {
        const localDigest = treeDigest(await readSkillTree(await this.readFolderFor(entry), this.paths.home));
        return {...item, localDigest, state: item.state === 'ok' && localDigest === entry.digest ? 'ok' as const : 'edited' as const};
      } catch (error) {
        if (absent(error) && this.readCopyRepairs.has(entryKey(entry))) missingRepairs.add(entryKey(entry));
        return {...item, localDigest: null, state: absent(error) || error instanceof HelperError && error.code === 'CLAUDE_PLUGIN_WAITING' ? 'missing' as const : 'edited' as const};
      }
    }));
    const errors: DeliveryError[] = this.waiting.map(entry => ({skillId: entry.skillId, target: entry.target, name: entry.name, code: this.waitingCode}));
    for (const entry of entries) {
      const code = this.failedWorkspaces.get(entry.workspaceId) ?? this.registrationError ?? (!entry.removed ? this.sourceErrors.get(entryKey(entry)) : undefined) ??
        (!entry.removed && missingRepairs.has(entryKey(entry)) ? 'CLAUDE_PLUGIN_READ_COPY_MISSING' : undefined);
      if (code) errors.push({skillId: entry.skillId, target: entry.target, name: entry.name, code});
    }
    const registered = await this.state().then(state => state.plugins.map(plugin => `maddots-${plugin.slug}`), () => []);
    const containers = new Set(['.claude-plugin', ...registered, ...entries.map(entry => this.pluginName(entry.workspaceId))]);
    // SyncEngine associates replacement snapshots with this array's identity.
    const unmanaged = inventory.unmanaged;
    for (let index = unmanaged.length - 1; index >= 0; index--) {
      const folder = unmanaged[index] as {home?: string; folderName?: string} | null;
      if (folder?.home === this.route && containers.has(folder.folderName ?? '')) unmanaged.splice(index, 1);
    }
    return {...inventory, managed, unmanaged, deliveryErrors: [...inventory.deliveryErrors, ...errors]};
  }
  async watchReadCopy(changed: () => void, watcher: (path: string, changed: () => void) => {close(): void}): Promise<{close(): void} | undefined> {
    const template = this.matrix.routes[this.route].readPath;
    if (!template) return;
    const expanded = template.replace(/^~(?=\/)/u, this.paths.home), prefix = expanded.split(/<|\*/u)[0];
    const root = resolve(prefix === expanded || prefix.endsWith('/') ? prefix.replace(/\/$/u, '') : dirname(prefix));
    if (!isAbsolute(expanded) || root === this.paths.home || !inside(this.paths.home, root) || inside(this.directory(), root) || inside(this.paths.data, root)) return;
    try {
      await assertNoSymlinks(root, this.paths.home);
      if (!(await lstat(root)).isDirectory()) return;
    } catch (error) {
      if (absent(error) || error instanceof HelperError && ['PATH_UNSAFE', 'ROUTE_INVALID'].includes(error.code)) return;
      throw error;
    }
    const handle = watcher(root, changed);
    changed(); return handle;
  }
}

/** TLS-13 owns acceptance, verification, staging, backups and lock commits. */
export class ClaudePluginSyncEngine extends SyncEngine {
  private readWatcher: {close(): void} | undefined;
  private running = false;
  private nextRegistration = 0;
  private registrationFailures = 0;
  private readonly watcher: (root: string, changed: () => void) => {close(): void};
  constructor(private readonly syncOptions: SyncOptions, readonly plugin: ClaudePluginDeliveryTarget) {
    super({...syncOptions, targets: [...syncOptions.targets.filter(target => target.route !== plugin.route), plugin]});
    if (syncOptions.paths !== plugin.paths || syncOptions.helperId !== plugin.helperId) throw new HelperError('ROUTE_INVALID', 'The plugin and sync engine must share paths and helper identity.');
    this.watcher = syncOptions.watchRoute ?? ((root, changed) => watch(root, {recursive: true}, changed));
  }
  override async inventory(): Promise<SyncInventory> { return this.plugin.observe(await super.inventory()); }
  private async startReadWatcher(): Promise<void> {
    if (!this.running || this.readWatcher) return;
    try { this.readWatcher = await this.plugin.watchReadCopy(() => this.notifyChange(), this.watcher); }
    catch { /* Observation only. An unwatchable copy cannot stop other routes; registration retries. */ }
  }
  private async registration(repair: readonly PlanItem[] = []): Promise<void> {
    try { await withWriteLock(this.syncOptions.paths, async () => {
      await this.plugin.repairReadCopies(repair);
      await this.plugin.reconcileRegistration(this.syncOptions.verifier);
    }, this.syncOptions.timing); }
    catch { /* Registration failures remain in inventory and retry on the next poll. */ }
    this.registrationFailures = this.plugin.hasRegistrationFailures() ? this.registrationFailures + 1 : 0;
    this.nextRegistration = (this.syncOptions.timing?.now() ?? Date.now()) + Math.min(60_000 * 2 ** Math.max(0, this.registrationFailures - 1), 30 * 60_000);
    await this.startReadWatcher();
  }
  override async reconcile(): Promise<void> { await super.reconcile(); await this.registration(); }
  override async applyPlan(plan: SyncPlan, beforeApply?: (current: SyncPlan) => Promise<void>): Promise<void> {
    const waiting = plan.items.filter(item => item.route === this.plugin.route && item.state === 'approved' && item.kind !== 'forced_remove' && !item.forAgentIds.length);
    let ready = true, code: string | undefined;
    if (waiting.length) {
      try { await this.plugin.validateWorkspaces(waiting); await this.plugin.requireCli(); }
      catch (error) { ready = false; code = error instanceof HelperError ? error.code : 'CLAUDE_PLUGIN_COMMAND_FAILED'; }
    }
    await this.plugin.setWaiting(ready ? [] : waiting, code);
    const accepted = (await this.locks.read()).entries.filter(entry => entry.route === this.plugin.route && !entry.removed);
    const redeliveries = plan.degraded ? [] : waiting.filter(item => ['install', 'update', 'local_newer'].includes(item.kind) &&
      ['update', 'always', 'replace'].includes(item.answer ?? '') && (item.kind !== 'local_newer' || item.answer === 'replace') && !item.missingDependencies.length &&
      !plan.revoked.some(revoked => revoked.digest === item.digest) && accepted.some(entry => entryKey(entry) === entryKey(item) && entry.workspaceId === item.workspaceId &&
        entry.digest === item.digest && entry.version === item.version && entry.settingsRevision === item.settingsRevision));
    let repair: PlanItem[] = [];
    // A distinct ETag keeps the original plan pollable when the CLI becomes available.
    try {
      await super.applyPlan(ready ? plan : {...plan, planRevision: digest(`claude-waiting:${plan.planRevision}`),
        items: plan.items.map(item => waiting.includes(item) ? {...item, state: 'later', answer: null} : item)}, beforeApply);
      if (ready && redeliveries.length) {
        const failed = new Set((await super.inventory()).deliveryErrors.map(error => JSON.stringify([error.skillId, error.target, error.name])));
        repair = redeliveries.filter(item => !failed.has(entryKey(item)));
      }
    } finally { await this.registration(repair); }
  }
  override async tick(): Promise<void> {
    await super.tick();
    if ((this.syncOptions.timing?.now() ?? Date.now()) >= this.nextRegistration) await this.registration();
  }
  override async run(signal?: AbortSignal): Promise<void> {
    this.running = true;
    try {
      await this.startReadWatcher();
      await super.run(signal);
    } finally { this.running = false; this.readWatcher?.close(); this.readWatcher = undefined; }
  }
}
