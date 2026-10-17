import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_MATRIX, type ToolMatrix } from '../shared/tool-matrix.js';
import { HelperError, cleanEnvironment, clock, endpointUrl, runCommand } from '../config.js';
import { type NotifyOptions } from '../notify.js';
import { assertNoSymlinks, atomicWrite, ensurePrivateDirectory, inside, readPrivateFile, withWriteLock, type HelperPaths } from '../paths.js';
import type { Access, Adapter } from './adapter.js';
import { startTool, type ProcessInspector, type StartToolOptions } from './process.js';
import type { LocalAgent } from './runner.js';

export const FULL_ACCESS_WARNING = "Full access: the run can reach everything your user account can reach: other folders, keys (including saved MadDots tokens such as maddots-mcp's), the network. It follows the card's instructions, so anyone who can edit an assigned card can steer it. The folder is where it works, not a wall.";
export const AGENT_DIALOG_INTERVAL_MS = 4 * 60 * 60 * 1000;
export type LocalAgentRecord = {
  aiToolId: string; handle: string; folder: string; folderCreated: boolean;
  access: Access; accessConfirmedAt: number; setupDone: boolean;
};
export type AgentIdentity = { agentId: string; aiToolId: string; handle: string };
export type AgentInteraction = {
  isTTY: boolean; prompt: (question: string) => Promise<string>; output: (line: string) => void;
  now?: () => number; adapter?: Adapter; matrix?: ToolMatrix;
};
export type AgentSetupOptions = AgentInteraction & {
  adapter: Adapter; bin: string; model: string; provider?: string | null; effort?: string | null;
  processes?: ProcessInspector; startTool?: typeof startTool;
};
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
const handleValid = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u.test(value);
const fail = (code = 'AGENTS_LOCAL_INVALID', message = 'Local agent settings could not be read safely.'): never => { throw new HelperError(code, message); };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function validRow(value: unknown): value is LocalAgentRecord {
  if (!record(value) || Object.keys(value).sort().join(',') !== 'access,accessConfirmedAt,aiToolId,folder,folderCreated,handle,setupDone') return false;
  return uuid(value.aiToolId) && handleValid(value.handle) && typeof value.folder === 'string' && isAbsolute(value.folder) && resolve(value.folder) === value.folder &&
    !/[\p{Cc}\p{Cf}]/u.test(value.folder) && typeof value.folderCreated === 'boolean' && typeof value.setupDone === 'boolean' &&
    ['folder_only', 'full_access'].includes(value.access as string) && Number.isSafeInteger(value.accessConfirmedAt) && Number(value.accessConfirmedAt) >= 0;
}
function validRows(value: unknown): value is Record<string, LocalAgentRecord> {
  return record(value) && Object.keys(value).length <= 200 && Object.entries(value).every(([id, row]) => uuid(id) && validRow(row));
}
async function physicalPath(path: string): Promise<string> {
  let ancestor = resolve(path);
  while (true) {
    try { return resolve(await realpath(ancestor), resolve(path).slice(ancestor.length + (ancestor === sep ? 0 : 1))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || ancestor === dirname(ancestor)) throw error; ancestor = dirname(ancestor); }
  }
}

/** Resolve a typed alias once, and keep only the owned, permitted physical folder. */
export async function validateAgentFolder(paths: HelperPaths, path: string): Promise<string> {
  if (!isAbsolute(path) || /[\p{Cc}\p{Cf}]/u.test(path)) return fail('FOLDER_UNSAFE', 'Choose an absolute path to an existing folder owned by you.');
  const folder = await realpath(path), home = await realpath(paths.home), info = await lstat(folder);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || folder === sep || folder === home) return fail('FOLDER_UNSAFE', 'Choose an existing folder owned by you, other than HOME or the filesystem root.');
  const exclusions = [paths.data, paths.backups, join(home, '.maddots-ai'), join(home, 'Library'), ...paths.routes];
  for (const excluded of exclusions) {
    if (inside(resolve(excluded), folder) || inside(await physicalPath(excluded), folder)) return fail('FOLDER_UNSAFE', 'The working folder must be outside helper data, tool delivery folders, backups and Library.');
  }
  await assertNoSymlinks(folder);
  const after = await lstat(folder);
  if (info.dev !== after.dev || info.ino !== after.ino || await realpath(path) !== folder) return fail('FOLDER_UNSAFE', 'The working folder changed while it was checked.');
  return folder;
}
function confirmationTime(options: Pick<AgentInteraction, 'now'>): number {
  const now = (options.now ?? Date.now)();
  if (!Number.isSafeInteger(now) || now < 0) return fail('AGENT_SETUP_INVALID', 'The local confirmation time is invalid.');
  return now;
}
function terminal(options: AgentInteraction): void {
  if (!options.isTTY) fail('TTY_REQUIRED', 'Agent setup and raising access require an interactive terminal. There is no --yes option.');
}
async function fullAccess(options: AgentInteraction): Promise<void> {
  terminal(options); options.output(FULL_ACCESS_WARNING);
  if (await options.prompt('Type full to confirm Full access: ') !== 'full') fail('ACCESS_NOT_CONFIRMED', 'Full access was not confirmed.');
}

export class LocalAgents {
  readonly file: string;
  constructor(readonly paths: HelperPaths) { this.file = join(paths.data, 'runner', 'agents.json'); }
  async read(): Promise<Record<string, LocalAgentRecord>> {
    try { const rows: unknown = JSON.parse(await readPrivateFile(this.file)); if (!validRows(rows)) return fail(); return rows; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; if (error instanceof HelperError) throw error; return fail(); }
  }
  private async update(agentId: string, row: LocalAgentRecord, expected: LocalAgentRecord | undefined): Promise<void> {
    if (!uuid(agentId) || !validRow(row)) fail();
    await withWriteLock(this.paths, async () => {
      await ensurePrivateDirectory(join(this.paths.data, 'runner'));
      const current = await this.read();
      if (JSON.stringify(current[agentId] ?? null) !== JSON.stringify(expected ?? null)) fail('AGENT_SETTINGS_CHANGED', 'Local agent settings changed while you were confirming them. Run the command again.');
      const rows = { ...current, [agentId]: row };
      if (!validRows(rows)) fail();
      await atomicWrite(this.file, JSON.stringify(rows) + '\n');
    });
  }
  private async finishSetup(agentId: string, expected: LocalAgentRecord): Promise<LocalAgentRecord> {
    return withWriteLock(this.paths, async () => {
      const rows = await this.read(), current = rows[agentId];
      if (!current || current.aiToolId !== expected.aiToolId || current.folder !== expected.folder) return fail('AGENT_SETTINGS_CHANGED', 'The agent binding changed during setup. Run setup for its current folder.');
      // A concurrent access reduction remains authoritative when trust finishes.
      const row = {...current, setupDone: true}; rows[agentId] = row;
      await atomicWrite(this.file, JSON.stringify(rows) + '\n'); return row;
    });
  }
  /** The runner receives only locally confirmed, successfully set up agents. */
  async ready(): Promise<LocalAgent[]> {
    const agents: LocalAgent[] = [];
    for (const [agentId, row] of Object.entries(await this.read())) {
      if (!row.setupDone) continue;
      try {
        const cwd = await validateAgentFolder(this.paths, row.folder);
        if (cwd === row.folder) agents.push({agentId, aiToolId: row.aiToolId, cwd, access: row.access});
      } catch { /* A missing or changed working folder is never offered for a claim. */ }
    }
    return agents;
  }
  async setup(agent: AgentIdentity, options: AgentSetupOptions): Promise<LocalAgentRecord> {
    terminal(options);
    if (!uuid(agent.agentId) || !uuid(agent.aiToolId) || !handleValid(agent.handle)) return fail('AGENT_SETUP_INVALID', 'The agent identity is invalid.');
    const matrixRun = (options.matrix ?? TOOL_MATRIX).tools.find(tool => tool.run?.adapter === options.adapter.info.tool)?.run;
    if (!matrixRun) return fail('AGENT_SETUP_INVALID', 'The tool has no runner access configuration.');
    const rows = await this.read(), previous = rows[agent.agentId];
    const defaultFolder = join(this.paths.home, 'MadDots Agents', `${agent.handle}-${agent.agentId.slice(0, 8)}`);
    const typed = await options.prompt(`Working folder [${defaultFolder}]: `);
    let folderCreated = false;
    if (!typed) {
      await ensurePrivateDirectory(join(this.paths.home, 'MadDots Agents'));
      try { await mkdir(defaultFolder, { mode: 0o700 }); folderCreated = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      await ensurePrivateDirectory(defaultFolder);
    }
    const expanded = typed === '~' ? this.paths.home : typed.startsWith('~/') ? join(this.paths.home, typed.slice(2)) : typed;
    const folder = await validateAgentFolder(this.paths, expanded || defaultFolder);
    const sameBinding = previous?.aiToolId === agent.aiToolId && previous.folder === folder;
    const defaultFull = sameBinding && previous.access === 'full_access';
    const answer = await options.prompt(defaultFull ? 'Access [full], or type folder-only: ' : matrixRun.folderOnly === 'none' ? 'This tool requires Full access. Type full to choose it: ' : 'Access [folder-only], or type full: ');
    let access: Access = 'folder_only';
    if (answer === 'full') { await fullAccess(options); access = 'full_access'; }
    else if (answer === '' && defaultFull) access = 'full_access';
    else if (answer !== '' && answer !== 'folder-only' || matrixRun.folderOnly === 'none') return fail('ACCESS_NOT_CONFIRMED', 'The selected access is unavailable or was not confirmed.');
    const setupAlreadyDone = Object.values(rows).some(row => row.aiToolId === agent.aiToolId && row.folder === folder && row.setupDone);
    let row: LocalAgentRecord = { aiToolId: agent.aiToolId, handle: agent.handle, folder,
      folderCreated: folderCreated || !!(previous?.folder === folder && previous.folderCreated), access,
      accessConfirmedAt: sameBinding && previous.access === access && answer !== 'full' ? previous.accessConfirmedAt : confirmationTime(options), setupDone: !options.adapter.agentSetup || setupAlreadyDone };
    await this.update(agent.agentId, row, previous);
    if (!row.setupDone) {
      const argv = options.adapter.agentSetup!(options.bin, folder);
      options.output('One-time tool setup: ' + argv.map(argument => JSON.stringify(argument)).join(' '));
      if (await options.prompt('Type yes to run this one-time setup: ') !== 'yes') return fail('SETUP_NOT_CONFIRMED', 'One-time tool setup was not confirmed.');
      const key = createHash('sha256').update(JSON.stringify([agent.aiToolId, folder])).digest('hex');
      await withWriteLock({...this.paths, lock: join(this.paths.data, 'runner', `.agent-setup-${key}.lock`)}, async () => {
        const current = await this.read(), latest = current[agent.agentId];
        if (!latest || latest.aiToolId !== agent.aiToolId || latest.folder !== folder) return fail('AGENT_SETTINGS_CHANGED', 'The agent binding changed before setup started.');
        await validateAgentFolder(this.paths, folder);
        if (!Object.values(current).some(value => value.aiToolId === agent.aiToolId && value.folder === folder && value.setupDone)) await this.runSetup(folder, argv, latest.access, options);
        row = await this.finishSetup(agent.agentId, row);
      });
    }
    return row;
  }
  async access(agent: AgentIdentity, requested: 'folder-only' | 'full', options: AgentInteraction): Promise<LocalAgentRecord> {
    if (!uuid(agent.agentId) || !uuid(agent.aiToolId) || !['folder-only', 'full'].includes(requested)) return fail('AGENT_SETUP_INVALID', 'Choose an agent and folder-only or full access.');
    const old = (await this.read())[agent.agentId];
    if (!old || old.aiToolId !== agent.aiToolId) return fail('AGENT_NOT_FOUND', 'Run agent setup for the current tool before changing access.');
    const access: Access = requested === 'full' ? 'full_access' : 'folder_only';
    if (access === 'folder_only' && options.adapter) {
      const run = (options.matrix ?? TOOL_MATRIX).tools.find(tool => tool.run?.adapter === options.adapter!.info.tool)?.run;
      if (!run || run.folderOnly === 'none') return fail('ACCESS_UNAVAILABLE', 'This tool does not offer Folder only.');
    }
    if (access === 'full_access' && old.access !== access) await fullAccess(options);
    const row = { ...old, handle: handleValid(agent.handle) ? agent.handle : old.handle, access, accessConfirmedAt: access === old.access ? old.accessConfirmedAt : confirmationTime(options) };
    await this.update(agent.agentId, row, old); return row;
  }
  private async runSetup(folder: string, argv: string[], access: Access, options: AgentSetupOptions): Promise<void> {
    const directory = await mkdtemp(join(this.paths.data, 'runner', 'agent-setup-'));
    try {
      const promptFile = join(directory, 'prompt.md'); await writeFile(promptFile, '', {mode: 0o600, flag: 'wx'});
      // Core owns binary identity, argv restrictions, environment and process cleanup.
      const adapter: Adapter = { ...options.adapter,
        build: () => ({ argv, env: {}, envUnset: [], stdinFile: null, files: [], projectFiles: [], spawnCwd: null, secretEnv: {} }),
        parse: result => ({ ok: result.exitCode === 0 && result.signal === null, text: '', failureCode: result.exitCode === 0 ? null : 'tool_failed' }) };
      const now = (options.now ?? Date.now)();
      const input: StartToolOptions = { adapter, recordedRealpath: options.bin, spec: {bin: options.bin, cwd: folder, runDir: directory, promptFile,
        skillsDir: folder, model: options.model, provider: options.provider ?? null, effort: options.effort ?? null, access,
        maxTurns: 1, timeoutSeconds: 270, runHome: null}, claimedAt: now, expiresAt: now + 600_000, maxRunMinutes: 5,
        matrix: options.matrix, processes: options.processes, now: options.now };
      const running = await (options.startTool ?? startTool)(input), result = await running.finished;
      if (!result.ok || result.stopped) return fail('AGENT_SETUP_FAILED', 'The one-time tool setup failed.');
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}

export type PendingAgentDialog = { count: number; command: string; reservedAt: number };
type DialogState = { format: 1; notifiedAgents: string[]; lastDialogAt?: number };
function shellQuote(value: string): string {
  if (/[\p{Cc}\p{Cf}]/u.test(value)) return fail('NOTIFY_INVALID', 'The setup launcher contains invalid characters.');
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
async function assertLauncher(path: string): Promise<void> {
  await assertNoSymlinks(path); const info = await lstat(path);
  if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o777) !== 0o700) fail('NOTIFY_INVALID', 'The setup launcher must be a private executable owned by you.');
}
async function writeLauncher(paths: HelperPaths, options: NotifyOptions): Promise<string> {
  const executable = options.execPath ?? process.execPath, entrypoint = options.entrypoint ?? fileURLToPath(new URL('../cli.js', import.meta.url));
  if (!isAbsolute(executable) || !isAbsolute(entrypoint)) return fail('NOTIFY_INVALID', 'The setup launcher requires absolute runtime and helper paths.');
  const source = options.env ?? process.env;
  const env = { HOME: paths.home, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', MADDOTS_AI_HOME: paths.data,
    MADDOTS_AI_URL: endpointUrl(source).origin, ...(source.MADDOTS_AI_ALLOW_INSECURE_LOOPBACK === '1' ? {MADDOTS_AI_ALLOW_INSECURE_LOOPBACK: '1'} : {}) };
  const content = '#!/bin/sh\nexec /usr/bin/env -i ' + Object.entries(env).map(([key, value]) => shellQuote(`${key}=${value}`)).join(' ') + ' ' + shellQuote(executable) + ' ' + shellQuote(entrypoint) + ' agent setup\n';
  const path = join(paths.data, 'agent-setup.command'), temporary = join(paths.data, `.agent-setup-${randomUUID()}.command`);
  await assertNoSymlinks(path);
  try { await assertLauncher(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o700);
  try {
    await file.chmod(0o700); await file.writeFile(content); await file.sync(); await file.close();
    await assertNoSymlinks(path); await rename(temporary, path); await assertLauncher(path);
    const parent = await open(paths.data, constants.O_RDONLY); try { await parent.sync(); } finally { await parent.close(); }
  } finally { await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
  return path;
}
/** Reserve under the helper write lock, then display outside it. A new agent can prompt once. */
export async function reserveAgentSetupDialog(paths: HelperPaths, waiting: readonly {agentId: string}[], options: NotifyOptions = {}): Promise<'empty' | 'unchanged' | 'throttled' | PendingAgentDialog> {
  const agents = [...new Set(waiting.map(agent => agent.agentId))];
  if (agents.some(agent => !uuid(agent))) return fail('NOTIFY_INVALID', 'The setup notification contains an invalid agent.');
  if (!agents.length) return 'empty';
  await ensurePrivateDirectory(paths.data);
  const path = join(paths.data, 'agent-notification-state.json');
  let state: DialogState = {format: 1, notifiedAgents: []};
  try {
    const raw: unknown = JSON.parse(await readPrivateFile(path));
    if (!record(raw) || raw.format !== 1 || !Array.isArray(raw.notifiedAgents) || raw.notifiedAgents.some(agent => !uuid(agent)) ||
      new Set(raw.notifiedAgents).size !== raw.notifiedAgents.length || Object.keys(raw).some(key => !['format', 'notifiedAgents', 'lastDialogAt'].includes(key)) ||
      raw.lastDialogAt !== undefined && (!Number.isSafeInteger(raw.lastDialogAt) || Number(raw.lastDialogAt) < 0) || raw.notifiedAgents.length && raw.lastDialogAt === undefined) return fail('NOTIFY_STATE_INVALID');
    state = raw as DialogState;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { if (error instanceof HelperError) throw error; return fail('NOTIFY_STATE_INVALID'); } }
  if (agents.every(agent => state.notifiedAgents.includes(agent))) return 'unchanged';
  const now = (options.timing ?? clock).now();
  if (!Number.isSafeInteger(now) || now < 0) return fail('NOTIFY_INVALID');
  if (state.lastDialogAt !== undefined && now - state.lastDialogAt < AGENT_DIALOG_INTERVAL_MS) return 'throttled';
  const command = await writeLauncher(paths, options);
  const text = JSON.stringify({format: 1, notifiedAgents: [...new Set([...state.notifiedAgents, ...agents])], lastDialogAt: now}) + '\n';
  if (Buffer.byteLength(text) > 1024 * 1024) return fail('NOTIFY_STATE_INVALID');
  await atomicWrite(path, text);
  return { count: agents.length, command, reservedAt: now };
}
export async function showAgentSetupDialog(dialog: PendingAgentDialog, options: NotifyOptions = {}): Promise<'later' | 'opened'> {
  const runner = options.runner ?? runCommand, env = cleanEnvironment(options.env ?? process.env);
  if (!Number.isSafeInteger(dialog.count) || dialog.count < 1) return fail('NOTIFY_INVALID');
  const seconds = AGENT_DIALOG_INTERVAL_MS / 1000 - 60;
  const result = await runner('/usr/bin/osascript', ['-e', `display dialog "${dialog.count} agents need setup or Allow on this computer" buttons {"Later", "Set up"} default button "Later" with title "MadDots AI" giving up after ${seconds}`], {env, timeout: (seconds + 60) * 1000, signal: options.signal});
  if (result.stdout.trim() !== 'button returned:Set up, gave up:false') return 'later';
  await assertLauncher(dialog.command);
  await runner('/usr/bin/open', ['-a', 'Terminal', dialog.command], {env, timeout: 10_000, signal: options.signal});
  return 'opened';
}
