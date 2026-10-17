import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants, closeSync, openSync, writeSync } from 'node:fs';
import { access, lstat, mkdir, readFile, realpath, readdir, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, delimiter } from 'node:path';
import { promisify } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import { TOOL_MATRIX, type ToolMatrix } from '../shared/tool-matrix.js';
import { RELEASE } from '../release-identity.js';
import { assertNoSymlinks } from '../paths.js';
import type { Adapter, AdapterFile, ParsedResult, RunSpec } from './adapter.js';

const exec = promisify(execFile);
const OUTPUT_LIMIT = 50 * 1024 * 1024;
const identityCache = new WeakMap<Adapter, Map<string, { fingerprint: string; version: string | null }>>();
const forbidden = new Set(['--bare', '--mcp-config', '--approve-mcps', '--allow-all-paths', '--allow-all-urls', '-k', '--key', '--api-key', '--mcp']);
const dshForbidden = new Set(['--session-id', '--from-default-profile', '--dump-config', '--dump-default-config', '--dump-config-schema']);
const PS_ENV = Object.freeze({ TZ: 'UTC0', LC_ALL: 'C' });

// These are the global options of the verified adapter, not the executable's
// physical filename (package managers commonly version that filename).
const commandRules: Record<string, { forbidden: string; values: Set<string>; flags: Set<string> }> = {
  codex: { forbidden: 'app', values: new Set(['-c', '--config', '-m', '--model', '-p', '--profile', '-s', '--sandbox', '-a', '--ask-for-approval', '-C', '--cd', '--add-dir', '--enable', '--disable', '--local-provider', '-i', '--image']), flags: new Set(['--oss', '--full-auto', '--dangerously-bypass-approvals-and-sandbox', '--ignore-user-config', '--search', '--no-alt-screen', '-h', '--help', '-V', '--version']) },
  cursor: { forbidden: 'agent', values: new Set(['--model', '--output-format', '--workspace', '--sandbox', '--config', '--user-data-dir', '--extensions-dir', '--profile', '--locale', '--log']), flags: new Set(['-p', '--print', '--trust', '--force', '--yolo', '--list-models', '-h', '--help', '-v', '--version', '--verbose', '--wait', '--new-window', '--reuse-window']) },
  copilot: { forbidden: 'copilot', values: new Set(['-p', '--prompt', '--model', '--output-format', '--add-dir', '--disable-mcp-server', '--available-tools', '--hostname', '--config-dir', '--log-level', '--log-dir']), flags: new Set(['--no-ask-user', '--no-auto-update', '--allow-all-tools', '--disable-builtin-mcps', '-s', '--silent', '-h', '--help', '-v', '--version']) },
  devin: { forbidden: '.', values: new Set(['--model', '--permission-mode', '--respect-workspace-trust', '--export', '--prompt-file', '--config']), flags: new Set(['-p', '--print', '--sandbox', '-h', '--help', '-v', '--version']) },
};

function checkSubcommand(tool: string, argv: string[]): void {
  const rule = commandRules[tool];
  if (!rule) return;
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') {
      if (argv[index + 1] === rule.forbidden) throw new ProcessRefusal('adapter_refused');
      return;
    }
    if (!arg.startsWith('-') || arg === '-') {
      if (arg === rule.forbidden) throw new ProcessRefusal('adapter_refused');
      return;
    }
    if (rule.flags.has(arg)) continue;
    if (rule.values.has(arg)) {
      if (++index >= argv.length) throw new ProcessRefusal('adapter_refused');
      continue;
    }
    const equal = arg.indexOf('=');
    if (equal > 0 && rule.values.has(arg.slice(0, equal))) continue;
    if (!arg.startsWith('--') && arg.length > 2 && rule.values.has(arg.slice(0, 2))) continue;
    // An unknown option's arity cannot safely identify the following command.
    throw new ProcessRefusal('adapter_refused');
  }
}

export class ProcessRefusal extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ProcessRefusal'; }
}
export class ProcessCleanupError extends Error {
  readonly code = 'tool_failed';
  constructor() { super('Run processes could not be verified gone.'); }
}

export interface AdapterCheck extends Pick<RunSpec, 'bin' | 'model' | 'provider' | 'effort' | 'access'> {
  adapter: Adapter;
  recordedRealpath?: string;
  matrix?: ToolMatrix;
  allowNotOffered?: boolean;
}

async function fingerprint(bin: string): Promise<string> {
  const info = await stat(bin, { bigint: true });
  if (!info.isFile()) throw new ProcessRefusal('tool_not_found');
  await access(bin, constants.X_OK);
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
}

/** Used before claiming, and repeated immediately before spawning. */
export async function enforceAdapter(input: AdapterCheck): Promise<{ ok: boolean; code: string | null; version: string | null }> {
  const fail = (code: string) => ({ ok: false, code, version: null });
  try {
    const { adapter, bin } = input;
    const recorded = input.recordedRealpath ?? bin;
    if (!isAbsolute(bin) || !isAbsolute(recorded) || basename(bin) === 'agent' || basename(recorded) === 'agent') return fail('adapter_refused');
    if (await realpath(bin) !== recorded || await realpath(recorded) !== recorded) return fail('tool_identity');
    const run = (input.matrix ?? TOOL_MATRIX).tools.find((tool) => tool.run?.adapter === adapter.info.tool)?.run;
    if (!run || run.adapter !== adapter.info.tool || (input.allowNotOffered && RELEASE) || (!run.offered && !(!RELEASE && input.allowNotOffered))) return fail('adapter_refused');
    const folderRank = { none: 0, 'no-shell': 1, 'os-sandbox': 2 };
    if (folderRank[run.folderOnly] > folderRank[adapter.info.folderOnly] || (run.mcpLevel === 'servers-off' && adapter.info.mcpLevel !== 'servers-off')) return fail('adapter_refused');
    if (input.access === 'folder_only' && run.folderOnly === 'none') return fail('adapter_refused');
    if (!adapter.supports(input).ok) return fail('adapter_refused');
    const before = await fingerprint(recorded);
    let cache = identityCache.get(adapter);
    if (!cache) { cache = new Map(); identityCache.set(adapter, cache); }
    const previous = cache.get(recorded);
    if (previous?.fingerprint === before) return { ok: true, code: null, version: previous.version };
    const identity = await adapter.identity(recorded);
    if (!identity.ok || await fingerprint(recorded) !== before || await realpath(bin) !== recorded) return fail('tool_identity');
    cache.set(recorded, { fingerprint: before, version: identity.version });
    return { ok: true, code: null, version: identity.version };
  } catch (error) {
    return fail(error instanceof ProcessRefusal ? error.code : 'tool_not_found');
  }
}

export function computeRunDeadline(claimedAt: number, expiresAt: number, maxRunMinutes: number): number {
  if (![claimedAt, expiresAt, maxRunMinutes].every(Number.isFinite) || maxRunMinutes <= 0) throw new ProcessRefusal('adapter_refused');
  return Math.min(claimedAt + maxRunMinutes * 60_000, expiresAt - 300_000, claimedAt + 7_200_000);
}

export function timeoutSeconds(deadline: number, now = Date.now()): number {
  return Math.max(0, Math.floor((deadline - now) / 1000) - 30);
}

/** No inherited credentials or helper configuration reach a tool. */
export async function buildToolEnvironment(bin: string, env: Record<string, string>, envUnset: string[], source: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  const result: NodeJS.ProcessEnv = {};
  const names = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SSH_AUTH_SOCK'];
  for (const name of names) if (source[name] !== undefined) result[name] = source[name];
  const path: string[] = [];
  for (const entry of [dirname(bin), dirname(process.execPath), join(source.HOME ?? homedir(), '.bun/bin'), '/opt/homebrew/bin', '/usr/local/bin']) {
    try { if ((await stat(entry)).isDirectory() && !path.includes(entry)) path.push(entry); } catch { /* absent optional PATH directory */ }
  }
  result.PATH = [...path, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter);
  Object.assign(result, { TERM: 'dumb', NO_COLOR: '1' }, env);
  for (const name of envUnset) delete result[name];
  for (const [name, value] of Object.entries(result)) {
    if (/MADDOTS/iu.test(name) || /^(?:pm_|mdai_)/u.test(value ?? '') || /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu.test(name)) delete result[name];
  }
  return result;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && rel !== '..' && !isAbsolute(rel);
}

async function configFile(root: string, file: AdapterFile): Promise<void> {
  if (!isAbsolute(file.path) || resolve(file.path) !== file.path || !inside(root, file.path)) throw new ProcessRefusal('adapter_refused');
  let current = root;
  for (const part of relative(root, dirname(file.path)).split('/').filter(Boolean)) {
    current = join(current, part);
    await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    if (!(await lstat(current)).isDirectory() || (await lstat(current)).isSymbolicLink()) throw new ProcessRefusal('adapter_refused');
  }
  await writeFile(file.path, file.content, { mode: 0o600, flag: 'wx' });
  await chmod(file.path, 0o600);
}

export async function processStartIdentity(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid < 1) return null;
  try {
    const { stdout } = await exec('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { env: { ...PS_ENV }, timeout: 2000, maxBuffer: 4096 });
    return stdout.trim() || null;
  } catch { return null; }
}

export interface ProcessEntry { pid: number; ppid: number; pgid: number; sid?: string; startedAt?: string }
interface ProcessIdentity { pid: number; startedAt: string }
export interface ProcessGroup {
  pgid: number; startedAt: string; sid?: string; spawnedBy?: number;
  members?: ProcessIdentity[];
  sessionLeader?: ProcessIdentity;
}
interface TrackedProcess { startedAt: string; pgid: number; sid?: string }
function sessionId(sid: string | undefined): string | undefined {
  // Darwin's sess is 0, not a usable session identity. Ignore old saved sess
  // values too: only Linux's real numeric sid can supply ownership evidence.
  return process.platform === 'linux' && sid !== undefined && /^[1-9]\d*$/u.test(sid) && Number.isSafeInteger(Number(sid)) ? sid : undefined;
}
async function processTable(): Promise<ProcessEntry[]> {
  const linux = process.platform === 'linux';
  const { stdout } = await exec('/bin/ps', ['-axo', `pid=,ppid=,pgid=,${linux ? 'sid=,' : ''}lstart=`], { env: { ...PS_ENV }, timeout: 2000, maxBuffer: 8 * 1024 * 1024 });
  return stdout.split('\n').flatMap(line => {
    const row = (linux ? /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/u : /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/u).exec(line);
    return row ? [{ pid: Number(row[1]), ppid: Number(row[2]), pgid: Number(row[3]), ...(linux && sessionId(row[4]) ? { sid: row[4] } : {}), startedAt: row[linux ? 5 : 4] }] : [];
  });
}

function signalGroup(pid: number, signal: NodeJS.Signals, inspector: ProcessInspector): void {
  if (inspector.signalGroup) { inspector.signalGroup(pid, signal); return; }
  try { process.kill(-pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}

export interface ProcessInspector {
  table(): Promise<ProcessEntry[]>;
  identity(pid: number): Promise<string | null>;
  fencePids?(fence: string, deadline?: number): Promise<number[]>;
  /** Test hosts may lack permission to signal a group after its leader exits. */
  signalGroup?(pid: number, signal: NodeJS.Signals): void;
}
async function fencePids(fence: string, deadline?: number): Promise<number[]> {
  if (!/^[a-f0-9]{32}$/u.test(fence) || !process.getuid) throw new ProcessRefusal('adapter_refused');
  const uid = process.getuid();
  const timeout = deadline === undefined ? 2000 : Math.max(250, Math.min(2000, deadline - Date.now()));
  const { stdout } = await exec('/bin/ps', ['-A', '-E', '-ww', '-o', 'pid=,uid=,command='], { env: { ...PS_ENV }, timeout, maxBuffer: 32 * 1024 * 1024 });
  const token = new RegExp(`(?:^|\\s)MDAI_RUN_FENCE=${fence}(?=\\s|$)`, 'u');
  return stdout.split('\n').flatMap(line => {
    const row = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    if (!row || Number(row[2]) !== uid || Number(row[1]) <= 1 || Number(row[1]) === process.pid || !token.test(row[3])) return [];
    return [Number(row[1])];
  });
}
const systemInspector: ProcessInspector = { table: processTable, identity: processStartIdentity, fencePids };

async function groupOwned(group: ProcessGroup, table: ProcessEntry[], inspector: ProcessInspector, fenced: number[] = [], liveGroups?: Map<number, number>): Promise<boolean> {
  if (group.pgid <= 1 || group.pgid === process.pid) return false;
  const members = table.filter(row => row.pgid === group.pgid);
  const sid = sessionId(group.sid);
  if (sid && members.length && !members.some(row => sessionId(row.sid) === sid)) return false;
  if (!members.length) return !!group.startedAt && await inspector.identity(group.pgid) === group.startedAt;
  const leader = table.find(row => row.pid === group.pgid);
  if (leader && group.startedAt) {
    const current = await entryIdentity(leader, inspector);
    if (current === group.startedAt) return true;
    if (current !== null) return false;
  }
  // A saved numeric group or session can have been reused during downtime.
  // Persisted groups require a live process with durable identity or the exact
  // run fence to authorize their leaderless members.
  for (const saved of group.members ?? []) {
    const member = members.find(row => row.pid === saved.pid);
    if (member && saved.startedAt && await entryIdentity(member, inspector) === saved.startedAt) return true;
  }
  if (leader) return false;
  // The spawning helper has watched these groups without a restart. A pgid
  // cannot be reused while members remain. Persisted groups never get this
  // authority, and a long inspection gap cannot refresh it from a number alone.
  if (liveGroups && Date.now() - (liveGroups.get(group.pgid) ?? -Infinity) <= 5000) return true;
  if (members.some(row => fenced.includes(row.pid))) return true;
  const session = group.sessionLeader;
  const sessionLeader = sid && session?.pid === Number(sid) && table.find(row => row.pid === session.pid && sessionId(row.sid) === sid);
  return !!sid && members.some(row => sessionId(row.sid) === sid) && !!sessionLeader && !!session?.startedAt &&
    await entryIdentity(sessionLeader, inspector) === session.startedAt;
}
async function entryIdentity(row: ProcessEntry, inspector: ProcessInspector): Promise<string | null> {
  return row.startedAt ?? inspector.identity(row.pid);
}
async function safeGroupSignal(pid: number, startedAt: string, signal: NodeJS.Signals, inspector: ProcessInspector): Promise<void> {
  if (pid <= 1 || pid === process.pid) return;
  if (startedAt && await inspector.identity(pid) === startedAt) { signalGroup(pid, signal, inspector); return; }
  if (await groupOwned({ pgid: pid, startedAt }, await inspector.table(), inspector)) signalGroup(pid, signal, inspector);
}

async function rememberMembers(group: ProcessGroup, table: ProcessEntry[], inspector: ProcessInspector): Promise<void> {
  const rows = table.filter(row => row.pgid === group.pgid);
  const members = new Map((group.members ?? []).filter(member => rows.some(row => row.pid === member.pid)).map(member => [member.pid, member]));
  for (const row of rows) {
    const identity = await entryIdentity(row, inspector);
    if (identity) members.set(row.pid, { pid: row.pid, startedAt: identity });
  }
  group.members = [...members.values()];
}

async function descendants(pid: number, startedAt: string, known: Map<number, TrackedProcess>, groups: Map<number, ProcessGroup>, inspector: ProcessInspector, liveGroups?: Map<number, number>): Promise<void> {
  const table = await inspector.table();
  const rows = new Map(table.map(row => [row.pid, row]));
  const parents = new Set<number>();
  const root = rows.get(pid);
  if (startedAt && (root ? await entryIdentity(root, inspector) : await inspector.identity(pid)) === startedAt) parents.add(pid);
  for (const [child, tracked] of known) {
    const row = rows.get(child);
    if (!row) { known.delete(child); continue; }
    const current = await entryIdentity(row, inspector);
    if (current === tracked.startedAt) parents.add(child);
    // A transient failed identity lookup must not discard a still-listed PID.
    else if (current !== null) known.delete(child);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of table) if (parents.has(row.ppid) && !parents.has(row.pid)) { parents.add(row.pid); changed = true; }
  }
  for (const child of parents) {
    const row = rows.get(child);
    if (!row) continue;
    const identity = known.get(child)?.startedAt ?? await entryIdentity(row, inspector);
    if (!identity) continue;
    const sid = sessionId(row.sid);
    if (child !== pid && !known.has(child)) known.set(child, { startedAt: identity, pgid: row.pgid, ...(sid ? { sid } : {}) });
    if (!groups.has(row.pgid) && row.pgid > 1) {
      const leader = rows.get(row.pgid);
      groups.set(row.pgid, { pgid: row.pgid, startedAt: leader ? await entryIdentity(leader, inspector) ?? '' : '', ...(sid ? { sid } : {}) });
    } else if (sid && !sessionId(groups.get(row.pgid)?.sid)) {
      const group = groups.get(row.pgid);
      if (group) group.sid = sid;
    }
    const group = groups.get(row.pgid);
    if (group) {
      const members = new Map((group.members ?? []).filter(member => rows.has(member.pid)).map(member => [member.pid, member]));
      members.set(child, { pid: child, startedAt: identity });
      group.members = [...members.values()];
      const sessionLeader = sid ? rows.get(Number(sid)) : undefined;
      if (!group.sessionLeader && sessionLeader && sessionId(sessionLeader.sid) === sid) {
        const sessionStart = await entryIdentity(sessionLeader, inspector);
        if (sessionStart) group.sessionLeader = { pid: sessionLeader.pid, startedAt: sessionStart };
      }
    }
  }
  // While an identified member still proves ownership, record the identities
  // of its group peers too. They remain valid witnesses after reparenting or
  // leader exit, including when their environments have been cleared.
  for (const group of groups.values()) if (await groupOwned(group, table, inspector, [], liveGroups)) {
    await rememberMembers(group, table, inspector);
    if (liveGroups && table.some(row => row.pgid === group.pgid)) liveGroups.set(group.pgid, Date.now());
  }
  // Retain original groups after their leaders disappear, but forget a group
  // once the whole group is gone so a later reuse cannot inherit ownership.
  for (const [pgid, group] of groups) if (!table.some(row => row.pgid === pgid) && !(pgid === pid && group.startedAt && await inspector.identity(pid) === group.startedAt)) {
    groups.delete(pgid);
    liveGroups?.delete(pgid);
  }
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  if (pid <= 1 || pid === process.pid) return;
  try { process.kill(pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}

// The fence catches inherited environments, and saved groups/sessions catch
// observed descendants after reparenting. A descendant that enters a new session
// before any scan sees it and either clears its environment or execs an Apple
// platform binary can escape: macOS hides platform-binary environments from ps.
// This accepted limit follows concept 12 rule 4. This is not an OS sandbox.
async function cleanupProcess(pid: number, startedAt: string, fence: string | undefined, known: Map<number, TrackedProcess>, groups: Map<number, ProcessGroup>, inspector: ProcessInspector,
  signalOwnedGroup = (signal: NodeJS.Signals) => safeGroupSignal(pid, startedAt, signal, inspector), changed?: () => Promise<void>, ownChildAlive = () => false,
  liveGroups?: Map<number, number>, rootVerified = () => false): Promise<void> {
  const scanFence = (deadline?: number) => fence ? (inspector.fencePids ?? fencePids)(fence, deadline) : Promise.resolve([]);
  const scan = async (deadline?: number) => {
    try {
      const fenced = await scanFence(deadline);
      await descendants(pid, startedAt, known, groups, inspector, liveGroups);
      const table = await inspector.table();
      const ownedGroups: ProcessGroup[] = [];
      const unverifiedGroups: ProcessGroup[] = [];
      let uncertainGroup = false;
      for (const group of groups.values()) {
        const sid = sessionId(group.sid);
        const verifiedRootGroup = group.pgid === pid && pid > 1 && rootVerified() && !table.some(row => row.pid === pid) &&
          table.some(row => row.pgid === pid && (!sid || sessionId(row.sid) === sid));
        if (verifiedRootGroup || await groupOwned(group, table, inspector, fenced, liveGroups)) {
          // Turn live authority into saved member evidence before signalling, so
          // a crash during cleanup still requires positive evidence on restart.
          await rememberMembers(group, table, inspector);
          ownedGroups.push(group);
        }
        else {
          // Keep unauthenticated numeric groups out of the signal set. A fence
          // scan may still identify their members without trusting a reused ID.
          unverifiedGroups.push(group);
          const leader = table.find(row => row.pid === group.pgid);
          if (leader && (!sid || sessionId(leader.sid) === sid)) {
            const identity = await entryIdentity(leader, inspector);
            // lstart is UTC/C with second resolution. Only a strictly later
            // second proves that an unresolved spawn-window pid was reused.
            const leaderSecond = identity ? Math.floor(Date.parse(`${identity} UTC`) / 1000) : NaN;
            const reused = group.spawnedBy !== undefined && Number.isFinite(leaderSecond) && leaderSecond > Math.floor(group.spawnedBy / 1000);
            if (identity === null || (!group.startedAt && !reused)) uncertainGroup = true;
          }
        }
      }
      const live: number[] = [];
      for (const [child, tracked] of known) {
        const row = table.find(row => row.pid === child);
        if (!row) { known.delete(child); continue; }
        const identity = await entryIdentity(row, inspector);
        if (identity === tracked.startedAt) live.push(child);
        else if (identity !== null) known.delete(child);
      }
      return { fenced, ownedGroups, unverifiedGroups, live, uncertain: uncertainGroup || known.size > live.length };
    } finally {
      // Inspection can fail after discovering a new member. Keep that evidence
      // durable for the next cleanup attempt before any signal can be sent.
      await changed?.();
    }
  };
  let state = await scan();
  const any = () => ownChildAlive() || state.fenced.length || state.ownedGroups.length || state.live.length || state.uncertain;
  // Empty normal exits need neither a TERM grace period nor a cleanup budget.
  if (!any()) return;
  const graceEnds = Date.now() + 5000, cleanupEnds = graceEnds + 2000;
  const signal = async (kind: NodeJS.Signals) => {
    if (ownChildAlive() && !state.ownedGroups.some(group => group.pgid === pid)) await signalOwnedGroup(kind);
    for (const group of state.ownedGroups) signalGroup(group.pgid, kind, inspector);
    for (const child of new Set([...state.live, ...state.fenced])) signalPid(child, kind);
  };
  await signal('SIGTERM');
  const termed = new Set(state.fenced);
  for (let round = 0; round < 20 && Date.now() < graceEnds; round++) {
    await new Promise(done => setTimeout(done, Math.min(250, Math.max(0, graceEnds - Date.now()))));
    state = await scan(cleanupEnds);
    if (!any()) return;
    for (const child of state.fenced) if (!termed.has(child)) { signalPid(child, 'SIGTERM'); termed.add(child); }
  }
  await signal('SIGKILL');
  for (let round = 0; round <= 40; round++) {
    state = await scan(cleanupEnds);
    // Always inspect before enforcing the deadline: slow inspection of an
    // already-empty tree is successful cleanup, not a surviving process.
    if (!any()) return;
    if (round === 40 || Date.now() >= cleanupEnds) throw new ProcessCleanupError();
    await signal('SIGKILL');
    await new Promise(done => setTimeout(done, 50));
  }
}

/** Saved groups survive leader exit; identity and session checks reject reuse. */
export async function recoverProcess(pid: number, startedAt: string, inspector: ProcessInspector = systemInspector, fence?: string, savedGroups: ProcessGroup[] = [],
  onGroups?: (groups: ProcessGroup[]) => Promise<void> | void): Promise<boolean> {
  if (fence !== undefined && !/^[a-f0-9]{32}$/u.test(fence)) throw new ProcessRefusal('adapter_refused');
  const validPid = Number.isInteger(pid) && pid > 1 && pid !== process.pid;
  const matches = validPid && !!startedAt && await inspector.identity(pid) === startedAt;
  const groups = new Map(savedGroups.filter(group => Number.isInteger(group.pgid) && group.pgid > 1 && group.pgid !== process.pid).map(group => [group.pgid, { ...group }]));
  if (validPid && !groups.has(pid)) groups.set(pid, { pgid: pid, startedAt });
  if (!matches && !fence && !await Promise.all([...groups.values()].map(async group => groupOwned(group, await inspector.table(), inspector))).then(owned => owned.some(Boolean))) return false;
  const persistGroups = onGroups ? async () => { await onGroups(structuredClone([...groups.values()])); } : undefined;
  await cleanupProcess(validPid ? pid : 0, startedAt, fence, new Map(), groups, inspector, undefined, persistGroups, undefined, undefined, () => matches);
  return true;
}

/** Call only after crash recovery or service stop has removed every process tree. */
export async function cleanupRunHomes(dataDir: string): Promise<void> {
  if (!isAbsolute(dataDir) || resolve(dataDir) !== dataDir || dirname(dataDir) === dataDir) throw new ProcessRefusal('adapter_refused');
  const root = join(dataDir, 'run-homes');
  await assertNoSymlinks(root);
  let entries: string[];
  try {
    if (!(await lstat(root)).isDirectory()) throw new ProcessRefusal('adapter_refused');
    entries = await readdir(root);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const validateTree = async (path: string): Promise<void> => {
    if (!inside(root, path)) throw new ProcessRefusal('adapter_refused');
    const info = await lstat(path);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new ProcessRefusal('adapter_refused');
    if (info.isDirectory()) for (const name of await readdir(path)) await validateTree(join(path, name));
  };
  // Validate the entire batch first, so an unsafe leftover preserves all recovery evidence.
  for (const name of entries) {
    const path = join(root, name);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(name) || !(await lstat(path)).isDirectory()) throw new ProcessRefusal('adapter_refused');
    await validateTree(path);
  }
  for (const name of entries) {
    const path = join(root, name);
    await assertNoSymlinks(path);
    if (!inside(root, await realpath(path))) throw new ProcessRefusal('adapter_refused');
    await rm(path, { recursive: true });
  }
}

export interface ProcessResult extends ParsedResult { exitCode: number | null; signal: string | null; stopped: boolean }
export interface RunningTool { pid: number; startedAt: string; fence: string; finished: Promise<ProcessResult>; stop(code: string): Promise<void> }
export interface StartToolOptions {
  adapter: Adapter;
  spec: RunSpec;
  recordedRealpath?: string;
  claimedAt: number;
  expiresAt: number;
  maxRunMinutes: number;
  allowNotOffered?: boolean;
  matrix?: ToolMatrix;
  fence?: string;
  onSpawn?: (pid: number, startedAt: string, pgid: number) => Promise<void> | void;
  onGroups?: (groups: ProcessGroup[]) => Promise<void> | void;
  stageProjectFile?: (file: AdapterFile) => Promise<void>;
  /** Host operations are injectable so socket-free unit tests need no process-table permission. */
  processes?: ProcessInspector;
  now?: () => number;
}

export async function startTool(options: StartToolOptions): Promise<RunningTool> {
  const { adapter, spec } = options;
  const inspector = options.processes ?? systemInspector;
  const now = options.now ?? Date.now;
  const checked = await enforceAdapter({ ...spec, ...options });
  if (!checked.ok) throw new ProcessRefusal(checked.code!);
  const deadline = computeRunDeadline(options.claimedAt, options.expiresAt, options.maxRunMinutes);
  if (deadline <= now()) throw new ProcessRefusal('run_time_limit');
  const recorded = options.recordedRealpath ?? spec.bin;
  const preparedFingerprint = await fingerprint(recorded);
  if (identityCache.get(adapter)?.get(recorded)?.fingerprint !== preparedFingerprint) throw new ProcessRefusal('tool_identity');
  const invocation = adapter.build({ ...spec, bin: recorded, timeoutSeconds: timeoutSeconds(deadline, now()) });
  if (invocation.argv[0] !== recorded || invocation.argv.some((arg) => forbidden.has(arg) || (adapter.info.tool === 'continue' && arg === '--agent') || (adapter.info.tool === 'deepseek-harness' && dshForbidden.has(arg)))) throw new ProcessRefusal('adapter_refused');
  const tokenPattern = /(?:pm_run_|mdai_skill_)[A-Za-z0-9_-]+/u;
  if (invocation.argv.some((arg) => tokenPattern.test(arg)) || [...invocation.files, ...invocation.projectFiles].some((file) => tokenPattern.test(file.path) || tokenPattern.test(file.content))) throw new ProcessRefusal('adapter_refused');
  checkSubcommand(adapter.info.tool, invocation.argv);
  // TLS-50 implements isolated run homes and the sole provider-key exception.
  if (adapter.info.runHome || spec.runHome || invocation.spawnCwd || Object.keys(invocation.secretEnv ?? {}).length) throw new ProcessRefusal('adapter_refused');
  const prompt = await readFile(spec.promptFile, 'utf8');
  if (adapter.info.promptVia === 'arg' && Buffer.byteLength(prompt) > 64 * 1024) {
    const index = invocation.argv.indexOf(prompt);
    if (index < 1) throw new ProcessRefusal('adapter_refused');
    invocation.argv = invocation.argv.map((arg, position) => position > 0 && arg === prompt ? `Follow the task in ${spec.promptFile}.` : arg);
  }
  if (invocation.stdinFile !== null && invocation.stdinFile !== spec.promptFile) throw new ProcessRefusal('adapter_refused');
  const config = join(await realpath(spec.runDir), 'config');
  await mkdir(config, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
  if ((await lstat(config)).isSymbolicLink() || !(await lstat(config)).isDirectory()) throw new ProcessRefusal('adapter_refused');
  for (const file of invocation.files) await configFile(config, file);
  for (const file of invocation.projectFiles) {
    if (!options.stageProjectFile) throw new ProcessRefusal('adapter_refused');
    await options.stageProjectFile(file);
  }
  const env = await buildToolEnvironment(recorded, invocation.env, invocation.envUnset);
  const fence = options.fence ?? randomBytes(16).toString('hex');
  if (!/^[a-f0-9]{32}$/u.test(fence)) throw new ProcessRefusal('adapter_refused');
  // Added last, so neither adapter env nor envUnset can replace the run's fence.
  env.MDAI_RUN_FENCE = fence;
  // Without process inspection, escaped descendants and safe crash recovery cannot be enforced.
  try { await inspector.table(); await (inspector.fencePids ?? fencePids)(fence); } catch { throw new ProcessRefusal('adapter_refused'); }
  if (await fingerprint(recorded) !== preparedFingerprint || await realpath(spec.bin) !== recorded) throw new ProcessRefusal('tool_identity');
  const stdoutFd = openSync(join(spec.runDir, 'stdout.log'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let stderrFd: number;
  try { stderrFd = openSync(join(spec.runDir, 'stderr.log'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); } catch (error) { closeSync(stdoutFd); throw error; }
  const child = spawn(recorded, invocation.argv.slice(1), { cwd: spec.cwd, env, detached: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  const spawnedBy = Date.now();
  let stdout = '';
  let stderr = '';
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');
  let reason: string | null = null;
  let stopping: Promise<void> | null = null;
  const known = new Map<number, TrackedProcess>();
  // Capture the OS-created group before the first awaited identity lookup.
  // Fast exits can leave an environment-cleared child in this original group.
  const groups = new Map<number, ProcessGroup>(child.pid ? [[child.pid, { pgid: child.pid, startedAt: '', spawnedBy }]] : []);
  const liveGroups = new Map<number, number>(child.pid ? [[child.pid, spawnedBy]] : []);
  let savedGroups = '';
  const persistGroups = async () => {
    const values = [...groups.values()].map(group => ({ ...group }));
    const current = JSON.stringify(values);
    if (current !== savedGroups) { await options.onGroups?.(values); savedGroups = current; }
  };
  let startedAt = '';
  let snapshot: Promise<void> = Promise.resolve();
  const scan = () => { snapshot = snapshot.then(() => child.pid ? descendants(child.pid, startedAt, known, groups, inspector, liveGroups).then(persistGroups) : undefined).catch(() => undefined); return snapshot; };
  const signalOwnedGroup = async (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    // An unreaped direct child retains its PID, so this remains safe if ps later fails.
    if (child.exitCode === null && child.signalCode === null && !spawnError) { signalGroup(child.pid, signal, inspector); return; }
    await safeGroupSignal(child.pid, startedAt, signal, inspector);
  };
  let pipeTimer: ReturnType<typeof setTimeout> | undefined;
  let pipesClosed = false;
  const cleanup = (): Promise<void> => {
    stopping ??= (async () => {
      clearInterval(interval);
      await snapshot;
      await cleanupProcess(child.pid ?? 0, startedAt, fence, known, groups, inspector, signalOwnedGroup, persistGroups,
        () => !!child.pid && child.exitCode === null && child.signalCode === null && !spawnError, liveGroups,
        () => !!child.pid && !spawnError && (child.exitCode !== null || child.signalCode !== null));
    })().catch(async () => {
      // Even an unavailable fence scan must not leave our known child running.
      try { await signalOwnedGroup('SIGKILL'); for (const [pid, tracked] of known) if (await inspector.identity(pid) === tracked.startedAt) signalPid(pid, 'SIGKILL'); } catch { /* Preserve the saved fence for recovery. */ }
      throw new ProcessCleanupError();
    });
    // Escaped processes may retain inherited pipes. Bound draining even when
    // containment fails; otherwise close/finished and key deletion can hang.
    void stopping.finally(() => {
      if (pipesClosed) return;
      pipeTimer ??= setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); }, 1000);
    }).catch(() => undefined);
    void stopping.catch(() => undefined);
    return stopping;
  };
  const stop = (code: string): Promise<void> => {
    reason ??= code;
    return cleanup();
  };
  const handleChunk = (chunk: Buffer, output: 'stdout' | 'stderr') => {
    const bytes = output === 'stdout' ? stdoutBytes : stderrBytes;
    const allowed = chunk.subarray(0, Math.max(0, OUTPUT_LIMIT - bytes));
    writeSync(output === 'stdout' ? stdoutFd : stderrFd, allowed);
    if (output === 'stdout') { stdoutBytes += chunk.length; stdout += stdoutDecoder.write(allowed); }
    else { stderrBytes += chunk.length; stderr += stderrDecoder.write(allowed); }
    if (bytes + chunk.length > OUTPUT_LIMIT) { void stop('output_too_large'); return; }
    if (output === 'stdout' && adapter.selfCheck) {
      try {
        const check = adapter.selfCheck(stdout);
        if (check && (check.mcpServers.length || check.browserTools.length)) void stop('mcp_started');
      } catch { void stop('tool_failed'); }
    }
  };
  const receive = (chunk: Buffer, output: 'stdout' | 'stderr') => {
    try { handleChunk(chunk, output); } catch { void stop('tool_failed'); }
  };
  child.stdout.on('data', (chunk: Buffer) => receive(chunk, 'stdout'));
  child.stderr.on('data', (chunk: Buffer) => receive(chunk, 'stderr'));
  child.stdin.on('error', () => { /* early exits can close stdin before the prompt is consumed */ });
  const timer = setTimeout(() => { void stop('run_time_limit'); }, Math.max(0, deadline - now()));
  const interval = setInterval(() => { void scan(); }, 250);
  let spawnError = false;
  child.on('error', () => { spawnError = true; });
  child.once('exit', () => { void cleanup(); });
  const finished = new Promise<ProcessResult>((done, reject) => {
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      clearTimeout(pipeTimer);
      pipesClosed = true;
      closeSync(stdoutFd);
      closeSync(stderrFd);
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      void (async () => {
        try {
          await cleanup();
          await snapshot;
        } catch { throw new ProcessCleanupError(); }
        finally { clearInterval(interval); }
        const result = reason ? { ok: false, text: '', failureCode: reason } : spawnError ? { ok: false, text: '', failureCode: 'tool_not_found' } : adapter.parse({ stdout, stderr, exitCode, signal, runDir: spec.runDir });
        done({ ...result, exitCode, signal, stopped: reason !== null });
      })().catch(reject);
    });
  });
  // A fast exit can finish cleanup before startTool returns its public promise.
  void finished.catch(() => undefined);
  const pid = child.pid ?? 0;
  // Persist the detached group before a slow identity lookup. A crash in that
  // window leaves an unverified group, recoverable only through the run fence.
  try { await persistGroups(); } catch (error) { await stop('runner_stopped'); await finished; throw error; }
  startedAt = pid ? await inspector.identity(pid) ?? '' : '';
  if (pid && !startedAt && child.exitCode === null && child.signalCode === null && !spawnError) {
    // The ChildProcess still identifies our own live child, but recovery could not.
    reason = 'adapter_refused';
    child.kill('SIGKILL');
    await finished;
    throw new ProcessRefusal('adapter_refused');
  }
  if (pid && startedAt) groups.set(pid, { ...groups.get(pid), pgid: pid, startedAt, spawnedBy });
  try { if (pid) { await options.onSpawn?.(pid, startedAt, pid); await persistGroups(); } } catch (error) { await stop('runner_stopped'); await finished; throw error; }
  if (!reason) child.stdin.end(invocation.stdinFile ? prompt : undefined);
  else child.stdin.end();
  return { pid, startedAt, fence, finished, stop };
}
