import { spawn, execFile, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants, closeSync, openSync, writeSync, type Stats } from 'node:fs';
import { access, lstat, mkdir, open, readFile, realpath, readdir, rm, rmdir, stat, unlink, writeFile, chmod, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, delimiter } from 'node:path';
import { promisify } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import { TOOL_MATRIX, isLinuxAcceptanceCandidate, toolRunCapability, type ToolMatrix } from '../shared/tool-matrix.js';
import { RELEASE } from '../release-identity.js';
import {withClaimedToolCommands} from '../tool-command.js';
import {assertLinuxToolClosure, linuxToolClosure} from '../linux-tool-closures.js';
import { inspectLinuxProcess, LinuxProcError, linuxFencePids, linuxProcessIdentity, linuxProcessTable, type LinuxProcScope } from '../linux-proc.js';
import * as linuxProc from '../linux-proc.js';
import { assertNoSymlinks } from '../paths.js';
import { isValidDeepseekKey, KeychainProviderKeyStore } from '../provider-keys.js';
import {selectedLoginFailure} from './linux-login-provider.js';
import {preparedLinuxLocalProvider, type LinuxLocalProviderSpec} from './linux-local-provider.js';
import type { Adapter, AdapterFile, AdapterOperationContext, ParsedResult, RunSpec } from './adapter.js';
import { signalIfStillOwned, type SignalChild } from './signal-gate.js';
import type { RunnerStorageDirectory } from './storage-lock.js';
import type { LinuxContainedRun } from './linux-containment.js';
import {assertAcceptanceOperation, hasAcceptanceOperation, acceptanceOperationWorkloadBudget, type LinuxAcceptanceOperation} from './linux-authorization.js';
import type {RunnerAuthorizationPurpose} from '../shared/runner-acceptance.js';

const exec = promisify(execFile);
const OUTPUT_LIMIT = 50 * 1024 * 1024;
const identityCache = new WeakMap<Adapter, Map<string, { fingerprint: string; version: string | null }>>();
const forbidden = new Set(['--bare', '--mcp-config', '--approve-mcps', '--allow-all-paths', '--allow-all-urls', '-k', '--key', '--api-key', '--mcp']);
const dshForbidden = new Set(['--session-id', '--from-default-profile', '--dump-config', '--dump-default-config', '--dump-config-schema']);
const PS_ENV = Object.freeze({ TZ: 'UTC0', LC_ALL: 'C', LC_TIME: 'C' });
const INSPECTION_TIMEOUT = 2000;
const TERM_GRACE = 5000;
const VERIFY_CAP = 15_000;
export const PROCESS_CLEANUP_CAP_MS = TERM_GRACE + VERIFY_CAP;

/** Accepted key characters may be literal or JSON Unicode escapes, even in mixed form. */
function outputKeyRedactor(key: string) {
  const characters = [...key].map(literal => ({literal, escaped: '\\u' + literal.charCodeAt(0).toString(16).padStart(4, '0')}));
  return (input: string, final: boolean) => {
    let output = '', cursor = 0, copied = 0, found = false;
    let raw = input.indexOf(key[0]), escaped = input.indexOf('\\');
    while (cursor < input.length) {
      if (raw >= 0 && raw < cursor) raw = input.indexOf(key[0], cursor);
      if (escaped >= 0 && escaped < cursor) escaped = input.indexOf('\\', cursor);
      const start = raw < 0 ? escaped : escaped < 0 ? raw : Math.min(raw, escaped);
      if (start < 0) break;
      let end = start, matched = 0, mismatch = false;
      for (const character of characters) {
        if (end === input.length) break;
        if (input[end] === character.literal) {end++; matched++; continue;}
        if (input[end] !== '\\') {mismatch = true; break;}
        const fragment = input.slice(end, end + 6);
        // Only hex digits are case insensitive. JSON requires a lowercase u.
        if (!character.escaped.startsWith(fragment.slice(0, 2) + fragment.slice(2).toLowerCase())) {mismatch = true; break;}
        if (fragment.length < 6) break;
        end += 6; matched++;
      }
      if (mismatch) {cursor = start + 1; continue;}
      // A partial match ends at EOF or inside its last Unicode escape.
      if (matched < characters.length) return {text: output + input.slice(copied, start) + (final ? '[REDACTED]' : ''), pending: final ? '' : input.slice(start), found};
      output += input.slice(copied, start) + '[REDACTED]';
      found = true;
      copied = cursor = end;
    }
    return {text: output + input.slice(copied), pending: '', found};
  };
}

// These are the global options of the verified adapter, not the executable's
// physical filename (package managers commonly version that filename).
const commandRules: Record<string, { forbidden: string; values: Set<string>; flags: Set<string> }> = {
  codex: { forbidden: 'app', values: new Set(['-c', '--config', '-m', '--model', '-p', '--profile', '-s', '--sandbox', '-a', '--ask-for-approval', '-C', '--cd', '--add-dir', '--enable', '--disable', '--local-provider', '-i', '--image']), flags: new Set(['--oss', '--full-auto', '--dangerously-bypass-approvals-and-sandbox', '--ignore-user-config', '--search', '--no-alt-screen', '-h', '--help', '-V', '--version']) },
  cursor: { forbidden: 'agent', values: new Set(['--model', '--output-format', '--workspace', '--sandbox', '--config', '--user-data-dir', '--extensions-dir', '--profile', '--locale', '--log']), flags: new Set(['-p', '--print', '--trust', '--force', '--yolo', '--list-models', '-h', '--help', '-v', '--version', '--verbose', '--wait', '--new-window', '--reuse-window']) },
  copilot: { forbidden: 'copilot', values: new Set(['-p', '--prompt', '--model', '--output-format', '--add-dir', '--disable-mcp-server', '--available-tools', '--additional-mcp-config', '--hostname', '--config-dir', '--log-level', '--log-dir']), flags: new Set(['--no-ask-user', '--no-auto-update', '--allow-all-tools', '--allow-all', '--disable-builtin-mcps', '-s', '--silent', '-h', '--help', '-v', '--version']) },
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

/** Static eligibility only. Safe before claiming: never calls identity or preflight. */
export async function enforceAdapter(input: AdapterCheck): Promise<{ ok: boolean; code: string | null; version: string | null }> {
  const fail = (code: string) => ({ ok: false, code, version: null });
  try {
    const { adapter, bin } = input;
    const recorded = input.recordedRealpath ?? bin;
    if (!isAbsolute(bin) || !isAbsolute(recorded) || basename(bin) === 'agent' || basename(recorded) === 'agent') return fail('adapter_refused');
    if (await realpath(bin) !== recorded || await realpath(recorded) !== recorded) return fail('tool_identity');
    // Preserve lexical selection before identity receives only its canonical path.
    // Generic fixture utilities retain their separate executable contract.
    if (process.platform === 'linux' && bin !== recorded && linuxToolClosure(adapter.info.tool)) {
      try {await assertLinuxToolClosure(adapter.info.tool, bin);} catch {return fail('tool_identity');}
    }
    const definition = (input.matrix ?? TOOL_MATRIX).tools.find((tool) => tool.run?.adapter === adapter.info.tool);
    const run = toolRunCapability(definition, process.platform);
    if (!run || !definition?.variants.some(variant => variant.key === 'cli' && !variant.syncOnly) ||
      run.adapter !== adapter.info.tool || (input.allowNotOffered && (RELEASE || process.platform === 'linux')) ||
      (!run.offered && !(process.platform === 'linux' && isLinuxAcceptanceCandidate(definition)) &&
        !(!RELEASE && process.platform === 'darwin' && input.allowNotOffered))) return fail('adapter_refused');
    const folderRank = { none: 0, 'no-shell': 1, 'os-sandbox': 2 };
    if (folderRank[run.folderOnly] > folderRank[adapter.info.folderOnly] || (run.mcpLevel === 'servers-off' && adapter.info.mcpLevel !== 'servers-off')) return fail('adapter_refused');
    if (input.access === 'folder_only' && run.folderOnly === 'none') return fail('adapter_refused');
    if (!adapter.supports(input).ok) return fail('adapter_refused');
    await fingerprint(recorded);
    return { ok: true, code: null, version: null };
  } catch (error) {
    return fail(error instanceof ProcessRefusal ? error.code : 'tool_not_found');
  }
}

/** Post-claim/setup/diagnostic checks. Linux adapters execute each closed probe
 * through runToolCommand and its own durable, isolated utility lifecycle. */
export async function enforceExecutableAdapter(input: AdapterCheck & Partial<Pick<RunSpec, 'cwd' | 'runDir'>> &
  { operation?: AdapterOperationContext; acceptanceOperation?: LinuxAcceptanceOperation }): Promise<{ ok: boolean; code: string | null; version: string | null }> {
  const checked = await enforceAdapter(input);
  if (!checked.ok) return checked;
  const fail = (code: string) => ({ ok: false, code, version: null });
  const expired = () => input.operation?.signal?.aborted || input.operation?.deadline !== undefined &&
    (!Number.isFinite(input.operation.deadline) || Date.now() >= input.operation.deadline);
  try {
    if (process.platform === 'linux' && !toolRunCapability((input.matrix ?? TOOL_MATRIX).tools.find(tool =>
      tool.run?.adapter === input.adapter.info.tool), 'linux')?.offered) {
      if (!hasAcceptanceOperation(input.acceptanceOperation, {toolKey: input.adapter.info.tool, platform: 'linux'})) return fail('adapter_refused');
    }
    if (expired()) return fail('adapter_refused');
    const { adapter, bin } = input;
    const recorded = input.recordedRealpath ?? bin;
    const before = await fingerprint(recorded);
    try {
      if (adapter.preflight && !(await adapter.preflight({...input, bin: recorded})).ok) return fail('adapter_refused');
    } catch { return fail('adapter_refused'); }
    if (expired()) return fail('adapter_refused');
    if (await fingerprint(recorded) !== before || await realpath(bin) !== recorded) return fail('tool_identity');
    let cache = identityCache.get(adapter);
    if (!cache) { cache = new Map(); identityCache.set(adapter, cache); }
    const previous = cache.get(recorded);
    if (previous?.fingerprint === before) return { ok: true, code: null, version: previous.version };
    const identity = await adapter.identity(recorded, input.operation);
    if (expired()) return fail('adapter_refused');
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
  const names = process.platform === 'linux' ? ['LANG', 'LC_ALL', 'LC_CTYPE'] :
    ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SSH_AUTH_SOCK'];
  for (const name of names) if (source[name] !== undefined) result[name] = source[name];
  const path: string[] = [];
  const candidates = process.platform === 'linux' ? [dirname(bin), dirname(process.execPath), '/usr/local/bin'] :
    [dirname(bin), dirname(process.execPath), join(source.HOME ?? homedir(), '.bun/bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const entry of candidates) {
    try { if ((await stat(entry)).isDirectory() && !path.includes(entry)) path.push(entry); } catch { /* absent optional PATH directory */ }
  }
  result.PATH = [...path, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter);
  Object.assign(result, { TERM: 'dumb', NO_COLOR: '1' }, env);
  if (process.platform === 'linux') delete result.SSH_AUTH_SOCK;
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
  try { return await inspectStartIdentity(pid); } catch { return null; }
}
function darwinStartIdentity(value: string): string {
  const identity = value.trim();
  // C-locale lstart uses strftime's space-padded day and UTC from PS_ENV.
  // Missing output, a diagnostic or an impossible date cannot identify a lifetime.
  const match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( [1-9]|[12]\d|3[01]) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d) (\d{4})$/u.exec(identity);
  if (!match) throw new Error('Invalid process start identity.');
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(match[1]);
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(match[2]);
  const day = Number(match[3]), year = Number(match[7]);
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(Number(match[4]), Number(match[5]), Number(match[6]), 0);
  if (year < 1 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day || date.getUTCDay() !== weekday) {
    throw new Error('Invalid process start identity.');
  }
  return identity;
}
async function inspectStartIdentity(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid < 1) return null;
  if (process.platform === 'linux') return linuxProcessIdentity(pid);
  try {
    const { stdout } = await exec('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { env: { ...PS_ENV }, timeout: INSPECTION_TIMEOUT, killSignal: 'SIGKILL', maxBuffer: 4096 });
    return darwinStartIdentity(stdout);
  } catch (error) {
    const result = error as { code?: number; stdout?: string; stderr?: string };
    // ps exits 1 with no output for a missing PID. Inspection errors, including
    // timeouts, must remain distinct from an absent process during cleanup.
    if (result.code === 1 && result.stdout === '' && result.stderr === '') return null;
    throw error;
  }
}

/** A zombie has exited even when its parent has not reaped its PID yet. */
export async function processIsRunning(pid: number): Promise<boolean> {
  if (process.platform === 'linux') {
    try { return !(await inspectLinuxProcess(pid)).zombie; }
    catch (error) { if (error instanceof LinuxProcError && error.code === 'gone') return false; throw error; }
  }
  return (await signalIfStillOwned({kind: 'probe', pid}, 0)).status === 'sent';
}

export interface ProcessEntry { pid: number; ppid: number; pgid: number; sid?: string; startedAt?: string; fenceMatch?: boolean }
interface ProcessIdentity { pid: number; startedAt: string }
export interface ProcessGroup {
  pgid: number; startedAt: string; sid?: string; spawnedBy?: number;
  /** Completion obligation only. Never evidence authorizing a signal. */
  cleanupPending?: true;
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
  if (process.platform === 'linux') return (await linuxProcessTable()).filter(row => !row.zombie);
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], { env: { ...PS_ENV }, timeout: INSPECTION_TIMEOUT, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 });
  return stdout.split('\n').flatMap(line => {
    if (!line.trim()) return [];
    const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
    if (!row || !row.slice(1, 4).every(value => Number.isSafeInteger(Number(value)))) throw new Error('Invalid process table row.');
    return [{ pid: Number(row[1]), ppid: Number(row[2]), pgid: Number(row[3]), startedAt: darwinStartIdentity(row[4]) }];
  });
}

export interface ProcessInspector {
  table(): Promise<ProcessEntry[]>;
  identity(pid: number): Promise<string | null>;
  /** A fresh lifetime and group snapshot at the signal boundary. */
  inspect?(pid: number, fence?: string): Promise<ProcessEntry | null>;
  /** Native final snapshot, read inside the signal gate without yielding. */
  inspectSync?(pid: number, deadline?: number): ProcessEntry | null;
  /** Internal cleanup bound, also enforced after the gate's final read. */
  signalDeadline?: number;
  fencePids?(fence: string, deadline?: number, observed?: LinuxProcScope): Promise<number[]>;
  /** A fence and lifetime must come from the same inspected process. */
  fenceEntries?(fence: string, deadline?: number, observed?: LinuxProcScope): Promise<ProcessEntry[]>;
  /** Test hosts may lack permission to signal a group after its leader exits. */
  signalGroup?(pid: number, signal: NodeJS.Signals): void;
  /** Native inspectors may retain the session guardian in tests. */
  sessionGuardian?: boolean;
}

// Darwin's current release keeps the detached session leader until cleanup.
// Its authenticated lifetime, rather than a recycled numeric SID/PGID, proves
// ownership of late same-session children even after the actual tool exits.
const sessionGuardian = `
import {spawn, execFileSync} from 'node:child_process';
const signalIfStillOwned = ${signalIfStillOwned.toString()};
process.on('SIGTERM', () => {});
process.once('disconnect', () => {
  const cleanupEnds = Date.now() + ${TERM_GRACE + VERIFY_CAP};
  void (async () => {
    let pause = 25;
    while (Date.now() < cleanupEnds) {
      try {
        await signalIfStillOwned({kind: 'self-group', pid: process.pid}, 'SIGKILL', {deadline: cleanupEnds, read: () => {
          const remaining = cleanupEnds - Date.now();
          if (remaining <= 0) throw new Error('Process inspection deadline expired.');
          const pgid = Number(execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'pgid='], {encoding: 'utf8', timeout: Math.min(${INSPECTION_TIMEOUT}, remaining), maxBuffer: 4096, env: {LC_ALL: 'C', LC_TIME: 'C', TZ: 'UTC0'}}).trim());
          return {pid: process.pid, pgid};
        }});
      } catch { /* A denied signal also needs fresh inspection on retry. */ }
      // Successful group KILL ends the guardian itself. Refusal or ESRCH is
      // not proof of cleanup: retain this witness until the original cap.
      const remaining = cleanupEnds - Date.now();
      if (remaining <= 0) break;
      await new Promise(done => setTimeout(done, Math.min(pause, remaining)));
      pause = Math.min(pause * 2, 250);
    }
    // The helper persisted cleanupPending before starting the tool. Without
    // a complete absence scan, leave that obligation intact for recovery.
    process.exit(1);
  })();
});
let started = false;
const report = message => { if (process.connected) process.send(message, () => {}); };
process.on('message', message => {
  if (message === 'release') process.exit(0);
  if (message !== 'start' || started) return;
  started = true;
  const tool = spawn(process.argv[1], process.argv.slice(2), {stdio: [0, 1, 2]});
  if (tool.pid) report({type: 'tool-start', pid: tool.pid});
  tool.once('error', () => { report({type: 'tool-error'}); });
  tool.once('exit', (code, signal) => { report({type: 'tool-exit', code, signal}); });
});
`;
async function fencePids(fence: string, deadline?: number, observed: LinuxProcScope = {pids: [process.pid]}): Promise<number[]> {
  if (!/^[a-f0-9]{32}$/u.test(fence) || !process.getuid) throw new ProcessRefusal('adapter_refused');
  if (process.platform === 'linux') return linuxFencePids(fence, deadline, {observed, contained: true});
  const uid = process.getuid();
  const { stdout } = await exec('/bin/ps', ['-A', '-E', '-ww', '-o', 'pid=,uid=,command='], { env: { ...PS_ENV }, timeout: INSPECTION_TIMEOUT, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024 });
  const token = new RegExp(`(?:^|\\s)MDAI_RUN_FENCE=${fence}(?=\\s|$)`, 'u');
  return stdout.split('\n').flatMap(line => {
    if (!line.trim()) return [];
    const row = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    if (!row || !row[3].trim() || !row.slice(1, 3).every(value => Number.isSafeInteger(Number(value)))) throw new Error('Invalid process fence row.');
    if (Number(row[2]) !== uid || Number(row[1]) <= 1 || Number(row[1]) === process.pid || !token.test(row[3])) return [];
    return [Number(row[1])];
  });
}
function requireLinuxSyncInspection(): typeof linuxProc.inspectLinuxProcessSync {
  // Completed Darwin coordinators retain the older Linux module ABI. Resolve
  // this Linux-only export when needed so those installations can still link.
  const inspect = linuxProc.inspectLinuxProcessSync;
  if (typeof inspect !== 'function') throw Object.assign(new ProcessRefusal('adapter_refused'), {
    message: 'Linux synchronous process inspection is unavailable in this retained helper runtime. Update or reinstall the helper before enabling runs.',
  });
  return inspect;
}
const systemInspector: ProcessInspector = {
  table: processTable, identity: processStartIdentity, fencePids,
  inspectSync: (pid, deadline) => {
    if (process.platform === 'linux') return requireLinuxSyncInspection()(pid, deadline);
    const remaining = Math.min(INSPECTION_TIMEOUT, (deadline ?? Infinity) - Date.now());
    if (remaining <= 0) throw new ProcessCleanupError();
    try {
      const stdout = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'pid=,ppid=,pgid=,lstart='],
        {encoding: 'utf8', env: {...PS_ENV}, timeout: Math.max(1, Math.floor(remaining)), maxBuffer: 4096});
      const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([^\n]+)\s*$/u.exec(stdout);
      if (!row || !row.slice(1, 4).every(value => Number.isSafeInteger(Number(value))) || Number(row[1]) !== pid) throw new Error('Invalid process snapshot.');
      return {pid, ppid: Number(row[2]), pgid: Number(row[3]), startedAt: darwinStartIdentity(row[4])};
    } catch (error) {
      const result = error as {status?: number; stdout?: string; stderr?: string};
      if (result.status === 1 && result.stdout === '' && result.stderr === '') return null;
      throw error;
    }
  },
  ...(process.platform === 'linux' ? {fenceEntries: async (fence: string, deadline?: number, observed: LinuxProcScope = {pids: [process.pid]}) =>
    (await linuxProcessTable({fence, deadline, observed, contained: true})).filter(row => !row.zombie && row.pid > 1 && row.pid !== process.pid && row.fenceMatch)} : {}),
  inspect: async (pid, fence) => {
    if (process.platform !== 'linux') return (await processTable()).find(row => row.pid === pid) ?? null;
    try { const row = await inspectLinuxProcess(pid, {fence}); return row.zombie ? null : row; }
    catch (error) { if (error instanceof LinuxProcError && error.code === 'gone') return null; throw error; }
  },
};

/** Refuse activation before a tool can run if complete process inspection is unavailable. */
export async function requireProcessInspection(): Promise<void> {
  if (process.platform === 'linux') requireLinuxSyncInspection();
  try {
    await systemInspector.table();
    if (!await systemInspector.identity(process.pid)) throw new Error('helper process identity unavailable');
    await fencePids(randomBytes(16).toString('hex'));
  } catch { throw new ProcessRefusal('adapter_refused'); }
}

/** Legacy dates cannot authenticate a Linux process. Keep their ledger while any candidate remains. */
export async function verifyLegacyProcessAbsence(pid: number, groups: ProcessGroup[], inspector: ProcessInspector = systemInspector,
  deadline = Date.now() + PROCESS_CLEANUP_CAP_MS): Promise<void> {
  if (process.platform === 'linux') throw new ProcessCleanupError();
  const candidates = new Set([pid, ...groups.flatMap(group => [group.pgid, ...group.members?.map(member => member.pid) ?? [], group.sessionLeader?.pid ?? 0])].filter(value => value > 1));
  const groupIds = new Set(groups.map(group => group.pgid));
  if ((await beforeDeadline(deadline, () => inspector.table())).some(row => candidates.has(row.pid) || groupIds.has(row.pgid))) throw new ProcessCleanupError();
}

export function hasLegacyLinuxIdentity(pid: number, startedAt: string, groups: ProcessGroup[]): boolean {
  const dated = (value: string) => /^(?:\d{4}-\d{2}-\d{2}T|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s)/u.test(value);
  return process.platform === 'linux' && (pid > 0 && dated(startedAt) || groups.some(group => dated(group.startedAt) ||
    group.members?.some(member => dated(member.startedAt)) || group.sessionLeader && dated(group.sessionLeader.startedAt)));
}

class ProcessInspectionError extends Error {}
export async function beforeDeadline<T>(deadline: number, action: () => Promise<T>): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ProcessCleanupError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([action(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new ProcessCleanupError()), remaining);
    })]);
  } finally { clearTimeout(timer); }
}
function boundedInspector(inspector: ProcessInspector, deadline: number): ProcessInspector {
  const inspect = async <T>(action: () => Promise<T>): Promise<T> => {
    try { return await beforeDeadline(deadline, action); }
    catch (cause) { throw new ProcessInspectionError('Process inspection failed.', { cause }); }
  };
  return {
    ...inspector,
    signalDeadline: deadline,
    table: () => inspect(() => inspector.table()),
    identity: pid => inspect(() => inspector === systemInspector ? inspectStartIdentity(pid) : inspector.identity(pid)),
    fencePids: (fence, _deadline, observed) => inspect(() => (inspector.fencePids ?? fencePids)(fence, deadline, observed)),
    ...(inspector.inspect ? {inspect: (pid: number, fence?: string) => inspect(() => inspector.inspect!(pid, fence))} : {}),
    ...(inspector.fenceEntries ? {fenceEntries: (fence: string, _deadline?: number, observed?: LinuxProcScope) =>
      inspect(() => inspector.fenceEntries!(fence, deadline, observed))} : {}),
  };
}

async function groupOwned(group: ProcessGroup, table: ProcessEntry[], inspector: ProcessInspector, fenced: number[] = []): Promise<boolean> {
  if (group.pgid <= 1 || group.pgid === process.pid) return false;
  const members = table.filter(row => row.pgid === group.pgid);
  const sid = sessionId(group.sid);
  if (sid && members.length && !members.some(row => sessionId(row.sid) === sid)) return false;
  if (!members.length) return !!group.startedAt && await inspector.identity(group.pgid) === group.startedAt;
  const leader = table.find(row => row.pid === group.pgid);
  if (leader && group.startedAt) {
    const current = await entryIdentity(leader, inspector);
    // The table is not atomic: a cached leader can precede peers from a
    // recycled PGID/SID. Its still-live lifetime must pin the group through
    // the completed scan before any peer becomes durable ownership evidence.
    if (current === group.startedAt) return !!await verifiedGroupLeader(group.pgid, group.startedAt, inspector, sid);
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
  // Even a recent numeric observation cannot prove continuity across scans.
  // Leaderless groups need a live lifetime, fence, or authenticated session.
  if (members.some(row => fenced.includes(row.pid))) return true;
  const session = group.sessionLeader;
  const sessionLeader = sid && session?.pid === Number(sid) && table.find(row => row.pid === session.pid && sessionId(row.sid) === sid);
  return !!sid && members.some(row => sessionId(row.sid) === sid) && !!sessionLeader && !!session?.startedAt &&
    await entryIdentity(sessionLeader, inspector) === session.startedAt;
}
async function entryIdentity(row: ProcessEntry, inspector: ProcessInspector): Promise<string | null> {
  return row.startedAt ?? inspector.identity(row.pid);
}
function signalEntry(inspector: ProcessInspector, pid: number): ProcessEntry | null | undefined | Promise<ProcessEntry | null | undefined> {
  if (inspector.inspectSync) return inspector.inspectSync(pid, inspector.signalDeadline);
  if (inspector.inspect) return inspector.inspect(pid);
  return inspector.table().then(rows => rows.find(row => row.pid === pid) ?? null);
}
async function verifiedGroupLeader(pid: number, startedAt: string, inspector: ProcessInspector, sid?: string): Promise<ProcessEntry | undefined> {
  try {
    const row = await signalEntry(inspector, pid);
    if (row === undefined || row && (!row.startedAt || row.pid !== pid)) throw new ProcessInspectionError('Group leader lifetime is unavailable.');
    return row?.pid === pid && row.pgid === pid && row.startedAt === startedAt &&
      (!sid || sessionId(row.sid) === sid) ? row : undefined;
  } catch (cause) { throw new ProcessInspectionError('Group leader inspection failed.', {cause}); }
}
async function safeGroupSignal(pid: number, startedAt: string, signal: NodeJS.Signals, inspector: ProcessInspector): Promise<boolean> {
  return (await signalIfStillOwned({kind: 'group', pid}, signal, {
    witness: {pid, startedAt}, read: () => signalEntry(inspector, pid), sendGroup: inspector.signalGroup, deadline: inspector.signalDeadline,
  })).status === 'sent';
}

async function persistDiscovery(deadline: number, changed?: () => Promise<void>): Promise<void> {
  try {
    // Start the save even after expiry, but never extend the cleanup budget
    // waiting for unavailable storage. Observe late rejections as well.
    const persistence = changed?.();
    if (persistence) {
      void persistence.catch(() => undefined);
      await beforeDeadline(deadline, () => persistence);
    }
  } catch { throw new ProcessCleanupError(); }
}

async function rememberMembers(group: ProcessGroup, table: ProcessEntry[], inspector: ProcessInspector, changed?: () => Promise<void>): Promise<void> {
  const rows = table.filter(row => row.pgid === group.pgid);
  // A group change does not end a process lifetime. Keep that member durable
  // until a complete scan verifies absence or a different lifetime.
  const members = new Map<number, ProcessIdentity>();
  for (const member of group.members ?? []) {
    const current = table.find(row => row.pid === member.pid);
    if (current && [null, member.startedAt].includes(await entryIdentity(current, inspector))) members.set(member.pid, member);
  }
  for (const row of rows) {
    const identity = await entryIdentity(row, inspector);
    if (identity) {
      members.set(row.pid, { pid: row.pid, startedAt: identity });
      group.members = [...members.values()];
      await changed?.();
    }
  }
  group.members = [...members.values()];
  await changed?.();
}

async function descendants(pid: number, startedAt: string, known: Map<number, TrackedProcess>, groups: Map<number, ProcessGroup>, inspector: ProcessInspector, liveGroups?: Map<number, number>, changed?: () => Promise<void>): Promise<void> {
  const table = await inspector.table();
  const rows = new Map(table.map(row => [row.pid, row]));
  const parents = new Set<number>();
  const unverifiedParents = new Set<number>();
  const observedLeaders = new Map<number, ProcessEntry>();
  const observeLeader = async (child: number, identity: string) => {
    // Keep the verified observation even if the leader exits during a later
    // await. That lifetime already established a durable cleanup obligation.
    const observed = observedLeaders.get(child);
    if (observed?.startedAt === identity) return observed;
    const leader = await verifiedGroupLeader(child, identity, inspector);
    if (leader) {
      observedLeaders.set(child, leader);
      // Bind the obligation before another inspection or persistence await
      // can fail. This does not adopt any peers from the process table.
      const previous = groups.get(child), sid = sessionId(leader.sid);
      if (previous?.startedAt !== identity || sessionId(previous.sid) !== sid) {
        const members = (previous?.members ?? []).filter(member => member.pid !== child);
        members.push({pid: child, startedAt: identity});
        groups.set(child, {pgid: child, startedAt: identity, cleanupPending: true, members,
          ...(sid ? {sid} : {}), ...(sid === String(child) ? {sessionLeader: {pid: child, startedAt: identity}} : {})});
        await changed?.();
      } else if (!previous.cleanupPending) {
        previous.cleanupPending = true;
        await changed?.();
      }
    }
    return leader;
  };
  const root = rows.get(pid);
  if (startedAt && (root ? await entryIdentity(root, inspector) : await inspector.identity(pid)) === startedAt &&
    (!root || root.pgid !== pid || await observeLeader(pid, startedAt))) parents.add(pid);
  for (const [child, tracked] of known) {
    const row = rows.get(child);
    if (!row) { known.delete(child); continue; }
    const current = await entryIdentity(row, inspector);
    if (current === tracked.startedAt) {
      // A cached own-leader row can precede a replacement's children in the
      // same table. Validate its lifetime before expanding ancestry,
      // as well as before recording its own-group obligation below.
      if (row.pgid === child && !await observeLeader(child, tracked.startedAt)) {
        unverifiedParents.add(child); parents.delete(child);
      }
      else parents.add(child);
    }
    // A transient failed identity lookup must not discard a still-listed PID.
    else if (current !== null) known.delete(child);
  }
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const row of table) if (parents.has(row.ppid) && !unverifiedParents.has(row.pid) && !parents.has(row.pid)) { parents.add(row.pid); expanded = true; }
  }
  for (const child of parents) {
    const row = rows.get(child);
    if (!row) continue;
    const identity = known.get(child)?.startedAt ?? await entryIdentity(row, inspector);
    if (!identity) continue;
    const tracked = known.get(child);
    if (row.pgid === child && await entryIdentity(row, inspector) === identity &&
      (tracked?.pgid !== row.pgid || groups.get(child)?.startedAt !== identity ||
      sessionId(groups.get(child)?.sid) !== sessionId(row.sid))) {
      // Observe an own-group obligation separately from peer membership. Only
      // this owned lifetime, freshly seen as leader, can bind the new group.
      // An obsolete ledger on the same number belongs to a different lifetime.
      const leader = await observeLeader(child, identity);
      // Newly discovered ancestry is traversed parent first. If its own
      // leader is contradicted, abandon this scan before any of its cached
      // descendants can acquire authority or any signal can be sent.
      if (!leader) throw new ProcessInspectionError('Discovered group leader changed.');
    }
    // A tracked member's move never authenticates other members from this
    // table. Keep its original PGID, even after observing its own new group.
    if (tracked && tracked.pgid !== row.pgid) continue;
    const sid = sessionId(row.sid);
    if (child !== pid && !known.has(child)) known.set(child, { startedAt: identity, pgid: row.pgid, ...(sid ? { sid } : {}) });
    const newGroup = !groups.has(row.pgid) && row.pgid > 1;
    const movedParent = known.has(row.ppid) && known.get(row.ppid)!.pgid !== rows.get(row.ppid)?.pgid;
    if (newGroup && movedParent && !parents.has(row.pgid)) {
      const sessionLeader = sid ? rows.get(Number(sid)) : undefined;
      const session = [...groups.values()].find(group => sessionId(group.sid) === sid && group.sessionLeader?.pid === sessionLeader?.pid)?.sessionLeader;
      const ownedSession = session && sessionLeader && sessionId(sessionLeader.sid) === sid &&
        await entryIdentity(sessionLeader, inspector) === session.startedAt;
      if (!ownedSession) {
        // A moved process can fork inside somebody else's existing group.
        // Persist that child's lifetime with the parent's original ledger,
        // without adopting the unrelated leader or its peers as our targets.
        const original = groups.get(known.get(row.ppid)?.pgid ?? pid);
        if (original) {
          known.set(child, {startedAt: identity, pgid: original.pgid, ...(sid ? {sid} : {})});
          const members = new Map((original.members ?? []).map(member => [member.pid, member]));
          members.set(child, {pid: child, startedAt: identity});
          original.members = [...members.values()];
          await changed?.();
        }
        continue;
      }
    }
    if (newGroup) {
      const leaderStart = rows.get(row.pgid)?.startedAt ?? (row.pgid === child ? identity : '');
      groups.set(row.pgid, { pgid: row.pgid, startedAt: leaderStart, ...(sid ? { sid } : {}) });
    } else if (sid && !sessionId(groups.get(row.pgid)?.sid)) {
      const group = groups.get(row.pgid);
      if (group) group.sid = sid;
    }
    const group = groups.get(row.pgid);
    if (group) {
      const members = new Map((group.members ?? []).filter(member => rows.has(member.pid)).map(member => [member.pid, member]));
      members.set(child, { pid: child, startedAt: identity });
      group.members = [...members.values()];
      group.cleanupPending = true;
      const sessionLeader = sid ? rows.get(Number(sid)) : undefined;
      const sessionStart = sessionLeader?.startedAt ?? (sessionLeader?.pid === child ? identity : undefined);
      if (!group.sessionLeader && sessionLeader && sessionId(sessionLeader.sid) === sid && sessionStart) {
        group.sessionLeader = { pid: sessionLeader.pid, startedAt: sessionStart };
      }
      // The identified member proves ownership even if its leader's next
      // identity inspection fails or consumes the remaining budget.
      await changed?.();
      const leader = newGroup ? rows.get(row.pgid) : undefined;
      if (leader && !group.startedAt) {
        group.startedAt = await entryIdentity(leader, inspector) ?? '';
        await changed?.();
      }
      if (!group.sessionLeader && sessionLeader && sessionId(sessionLeader.sid) === sid) {
        const sessionStart = await entryIdentity(sessionLeader, inspector);
        if (sessionStart) {
          group.sessionLeader = { pid: sessionLeader.pid, startedAt: sessionStart };
          await changed?.();
        }
      }
    }
  }
  // While an identified member still proves ownership, record the identities
  // of its group peers too. They remain valid witnesses after reparenting or
  // leader exit, including when their environments have been cleared.
  for (const group of groups.values()) if (await groupOwned(group, table, inspector)) {
    group.cleanupPending = true;
    await changed?.();
    await rememberMembers(group, table, inspector, changed);
    for (const member of group.members ?? []) if (!known.has(member.pid)) known.set(member.pid, {startedAt: member.startedAt, pgid: group.pgid});
    if (liveGroups && table.some(row => row.pgid === group.pgid)) liveGroups.set(group.pgid, Date.now());
  }
  // Retain original groups after their leaders disappear, but forget a group
  // once the whole group is gone so a later reuse cannot inherit ownership.
  for (const [pgid, group] of groups) if (!table.some(row => row.pgid === pgid) &&
    !(group.members ?? []).some(member => known.get(member.pid)?.startedAt === member.startedAt) &&
    !(pgid === pid && group.startedAt && await inspector.identity(pid) === group.startedAt)) {
    groups.delete(pgid);
    liveGroups?.delete(pgid);
  }
}

// The fence catches inherited environments, and saved groups/sessions catch
// observed descendants after reparenting. A descendant that enters a new session
// before any scan sees it and either clears its environment or execs an Apple
// platform binary can escape: macOS hides platform-binary environments from ps.
// This accepted limit follows concept 12 rule 4. This is not an OS sandbox.
async function cleanupProcess(pid: number, startedAt: string, fence: string | undefined, known: Map<number, TrackedProcess>, groups: Map<number, ProcessGroup>, inspector: ProcessInspector,
  signalOwnedGroup = (signal: NodeJS.Signals, inspecting: ProcessInspector) => safeGroupSignal(pid, startedAt, signal, inspecting), changed?: () => Promise<void>, ownChildAlive = () => false,
  liveGroups?: Map<number, number>, rootVerified = () => false, cleanupStarted = Date.now(), rootTermSent = false, retainedRoot = false,
  rootAuthority?: SignalChild): Promise<void> {
  // Initial inspection and joining an in-flight snapshot count toward the total
  // bound. They can reduce verification, but never lengthen the 20-second cap.
  const cleanupEnds = cleanupStarted + TERM_GRACE + VERIFY_CAP;
  const persist = () => persistDiscovery(cleanupEnds, changed);
  let graceEnds = rootTermSent || ownChildAlive() ? cleanupStarted + TERM_GRACE : undefined;
  inspector = boundedInspector(inspector, cleanupEnds);
  // Fence discoveries remain part of this observation even after reparenting,
  // setsid or a later permission denial. These sets grant no signal authority.
  const observedFencePids = new Set<number>(), observedFenceGroups = new Set<number>(), observedFenceSessions = new Set<string>();
  const observationScope = (): LinuxProcScope => ({pids: [process.pid, ...(pid > 1 ? [pid] : []), ...known.keys(), ...observedFencePids,
    ...[...groups.values()].flatMap(group => [...(group.members ?? []).map(member => member.pid),
      ...(group.sessionLeader ? [group.sessionLeader.pid] : [])])],
    pgids: [...groups.keys(), ...observedFenceGroups], sids: [...observedFenceSessions,
      ...[...groups.values()].flatMap(group => sessionId(group.sid) ? [group.sid!] : [])]});
  const scanFence = async (deadline?: number) => {
    const identities = new Map<number, string>();
    if (!fence) return identities;
    if (inspector.fenceEntries) {
      for (const row of await inspector.fenceEntries(fence, deadline, observationScope())) {
        observedFencePids.add(row.pid);
        if (row.pgid > 0) observedFenceGroups.add(row.pgid);
        if (sessionId(row.sid)) observedFenceSessions.add(row.sid!);
        const identity = await entryIdentity(row, inspector);
        if (identity) identities.set(row.pid, identity);
      }
    } else {
      const scan = inspector.fencePids ?? fencePids;
      const unresolved = new Set<number>();
      for (const child of await scan(fence, deadline, observationScope())) {
        observedFencePids.add(child);
        const identity = await inspector.identity(child);
        if (identity) identities.set(child, identity);
        else unresolved.add(child);
      }
      if (identities.size) for (const row of await inspector.table()) {
        if (!identities.has(row.pid) || identities.get(row.pid) !== await entryIdentity(row, inspector)) continue;
        if (row.pgid > 0) observedFenceGroups.add(row.pgid);
        if (sessionId(row.sid)) observedFenceSessions.add(row.sid!);
      }
      // Legacy inspectors expose separate PID/fence reads. Bracket the
      // lifetime lookup so a PID alone cannot become ownership evidence.
      if (identities.size || unresolved.size) {
        const current = new Set(await scan(fence, deadline, observationScope()));
        for (const child of identities.keys()) if (!current.has(child)) identities.delete(child);
        if ([...unresolved].some(child => current.has(child))) throw new ProcessInspectionError('Fenced process lifetime is unavailable.');
      }
    }
    return identities;
  };
  const scan = async (deadline?: number) => {
    try {
      const fenceIdentities = await scanFence(deadline);
      const fenced = [...fenceIdentities.keys()].filter(child => !retainedRoot || child !== pid);
      await descendants(pid, startedAt, known, groups, inspector, liveGroups, persist).finally(persist);
      const table = await inspector.table();
      const fencedMembers: number[] = [];
      for (const row of table) if (fenceIdentities.has(row.pid) && await entryIdentity(row, inspector) === fenceIdentities.get(row.pid)) fencedMembers.push(row.pid);
      const ownedGroups: ProcessGroup[] = [];
      const unverifiedGroups: ProcessGroup[] = [];
      let uncertainGroup = false;
      for (const group of groups.values()) {
        if (retainedRoot && group.pgid === pid && !table.some(row => row.pgid === pid && row.pid !== pid)) continue;
        const sid = sessionId(group.sid);
        // A previously verified root cannot authenticate a recycled PGID.
        if (await groupOwned(group, table, inspector, fencedMembers)) {
          group.cleanupPending = true;
          await persist();
          // Turn live authority into saved member evidence before signalling, so
          // a crash during cleanup still requires positive evidence on restart.
          await rememberMembers(group, table, inspector, persist);
          for (const member of group.members ?? []) if (!known.has(member.pid)) known.set(member.pid, {startedAt: member.startedAt, pgid: group.pgid});
          ownedGroups.push(group);
        }
        else {
          // Keep unauthenticated numeric groups out of the signal set. A fence
          // scan may still identify their members without trusting a reused ID.
          unverifiedGroups.push(group);
          const leader = table.find(row => row.pid === group.pgid);
          const members = table.filter(row => row.pgid === group.pgid);
          let replaced = !!sid && !!members.length && !members.some(row => sessionId(row.sid) === sid);
          if ((group.pgid === pid && rootVerified() || liveGroups?.has(group.pgid)) && !leader &&
            table.some(row => row.pgid === group.pgid && (!sid || sessionId(row.sid) === sid))) uncertainGroup = true;
          // An unresolved initial group has no lifetime to distinguish its
          // surviving members from PGID reuse, regardless of the backend.
          if (!leader && !group.startedAt && table.some(row => row.pgid === group.pgid)) uncertainGroup = true;
          if (leader && (!sid || sessionId(leader.sid) === sid)) {
            const identity = await entryIdentity(leader, inspector);
            // lstart is UTC/C with second resolution. Only a strictly later
            // second proves that an unresolved spawn-window pid was reused.
            const leaderSecond = identity ? Math.floor(Date.parse(`${identity} UTC`) / 1000) : NaN;
            const reused = group.spawnedBy !== undefined && Number.isFinite(leaderSecond) && leaderSecond > Math.floor(group.spawnedBy / 1000);
            replaced ||= identity !== null && (group.startedAt ? identity !== group.startedAt : reused);
            if (identity === null || (!group.startedAt && !reused)) uncertainGroup = true;
          }
          if (group.cleanupPending && !replaced && members.length) {
            const witnesses = [...(group.startedAt ? [{pid: group.pgid, startedAt: group.startedAt}] : []), ...group.members ?? []];
            replaced = true;
            for (const member of members) {
              const saved = witnesses.filter(witness => witness.pid === member.pid);
              const current = await entryIdentity(member, inspector);
              if (!saved.length || current === null || saved.some(witness => witness.startedAt === current)) {replaced = false; break;}
            }
          }
          // An obligation can block completion, but cannot grant ownership.
          // A complete absence scan or a different leader/session retires only
          // the old group obligation; moved member lifetimes remain independent.
          if (group.cleanupPending && (replaced || !members.length)) {
            delete group.cleanupPending;
            await persist();
          } else if (group.cleanupPending) uncertainGroup = true;
        }
      }
      const live: number[] = [];
      for (const [child, tracked] of known) {
        if (retainedRoot && child === pid) {known.delete(child); continue;}
        const row = table.find(row => row.pid === child);
        if (!row) { known.delete(child); continue; }
        const identity = await entryIdentity(row, inspector);
        if (identity === tracked.startedAt) live.push(child);
        else if (identity !== null) known.delete(child);
      }
      return { fenced, fenceIdentities, ownedGroups, unverifiedGroups, live, uncertain: uncertainGroup || known.size > live.length };
    } catch (error) {
      // A failed or timed-out inspection provides no negative evidence. Retry
      // the entire scan, never signal from a partial or stale snapshot.
      if (error instanceof ProcessInspectionError) return null;
      throw error;
    } finally {
      // Inspection can fail after discovering a new member. Keep that evidence
      // durable for the next cleanup attempt before any signal can be sent.
      await persist();
    }
  };
  const signalCurrentPid = async (child: number, expected: string | undefined, kind: NodeJS.Signals, fenced: boolean): Promise<boolean> => {
    if (!expected) return false;
    // The scan captured and persisted this exact lifetime, whether ancestry,
    // saved membership or a fence first identified it. Its current PID does
    // not authorize any peers, even if the member has moved to another group.
    return (await signalIfStillOwned({kind: 'pid', pid: child}, kind, {
      startedAt: expected, deadline: cleanupEnds, authority: child === pid ? rootAuthority : undefined,
      ...(fenced && fence ? {confirm: async () => (await scanFence(cleanupEnds)).get(child) === expected} : {}),
      ...(inspector.inspectSync ? {read: () => inspector.inspectSync!(child, cleanupEnds)} : {identity: () => inspector.identity(child)}),
    })).status === 'sent';
  };
  const signalCurrentGroup = async (group: ProcessGroup, kind: NodeJS.Signals): Promise<boolean> => {
    // Persistence may await arbitrary I/O. Recheck both lifetime and group
    // after those awaits, before letting a saved member authorize a signal.
    const witnesses = [...(group.startedAt ? [{pid: group.pgid, startedAt: group.startedAt}] : []), ...group.members ?? []];
    for (const witness of witnesses) {
      const result = await signalIfStillOwned({kind: 'group', pid: group.pgid}, kind, {
        witness, sid: sessionId(group.sid), deadline: cleanupEnds,
        authority: witness.pid === pid ? rootAuthority : undefined,
        read: () => signalEntry(inspector, witness.pid), sendGroup: inspector.signalGroup,
      });
      if (result.status === 'sent') return true;
    }
    return false;
  };
  const termed = new Set<string>(rootTermSent ? [`group:${pid}`] : []);
  const attemptSignal = async (target: string, kind: NodeJS.Signals, action: () => void | boolean | Promise<void | boolean>) => {
    if (Date.now() >= cleanupEnds || (kind === 'SIGTERM' && termed.has(target))) return;
    try { if (await action() !== false && kind === 'SIGTERM') termed.add(target); }
    catch (error) {
      // Darwin can deny a group signal in the exit/reap window. A denial is
      // neither proof of life nor death: require fresh inspection either way.
      if (!(error instanceof ProcessInspectionError) && !['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  };
  while (Date.now() < cleanupEnds) {
    const state = await scan(cleanupEnds);
    if (state && !ownChildAlive() && !state.fenced.length && !state.ownedGroups.length && !state.live.length && !state.uncertain) return;
    // Recovered groups have no ChildProcess authority for an early TERM. Give
    // them their grace after the first complete scan, within the same hard cap.
    if (state) graceEnds ??= Date.now() + TERM_GRACE;
    const kind = graceEnds !== undefined && Date.now() >= graceEnds ? 'SIGKILL' : 'SIGTERM';
    // The ChildProcess supplies independent identity even when inspection fails.
    if (ownChildAlive() && !state?.ownedGroups.some(group => group.pgid === pid)) {
      await attemptSignal(`group:${pid}`, kind, () => signalOwnedGroup(kind, inspector));
    }
    if (state) {
      const signalledGroups = new Set<number>();
      for (const group of state.ownedGroups) await attemptSignal(`group:${group.pgid}`, kind, async () => {
        const sent = await signalCurrentGroup(group, kind);
        if (sent) signalledGroups.add(group.pgid);
        return sent;
      });
      for (const child of new Set([...state.live, ...state.fenced])) {
        if (state.ownedGroups.some(group => signalledGroups.has(group.pgid) && group.members?.some(member => member.pid === child))) continue;
        const tracked = known.get(child);
        await attemptSignal(`pid:${child}`, kind, () => signalCurrentPid(child, tracked?.startedAt ?? state.fenceIdentities.get(child), kind, !tracked));
      }
    }
    // No round limit: even three expensive complete scans may need most of the
    // verification window. Only a successful empty scan or the cap ends it.
    const until = Math.min(cleanupEnds, kind === 'SIGTERM' ? graceEnds ?? cleanupEnds : cleanupEnds);
    const pause = Math.min(kind === 'SIGTERM' ? 250 : 100, until - Date.now());
    if (pause > 0) await new Promise(done => setTimeout(done, pause));
  }
  throw new ProcessCleanupError();
}

/** Saved groups survive leader exit; identity and session checks reject reuse. */
export async function recoverProcess(pid: number, startedAt: string, inspector: ProcessInspector = systemInspector, fence?: string, savedGroups: ProcessGroup[] = [],
  onGroups?: (groups: ProcessGroup[]) => Promise<void> | void, cleanupStarted = Date.now()): Promise<boolean> {
  if (fence !== undefined && !/^[a-f0-9]{32}$/u.test(fence)) throw new ProcessRefusal('adapter_refused');
  // Legacy Linux rows are migration obligations, never capabilities. Neither
  // an empty scan nor a matching replacement identity can retire this scope.
  // Journal replay recovers registered containment through its retained backend.
  if (process.platform === 'linux') throw new ProcessCleanupError();
  const cleanupEnds = cleanupStarted + PROCESS_CLEANUP_CAP_MS;
  const inspecting = boundedInspector(inspector, cleanupEnds);
  const validPid = Number.isInteger(pid) && pid > 1 && pid !== process.pid;
  const groups = new Map(savedGroups.filter(group => Number.isInteger(group.pgid) && group.pgid > 1 && group.pgid !== process.pid).map(group => [group.pgid, structuredClone(group)]));
  if (validPid && !groups.has(pid)) groups.set(pid, { pgid: pid, startedAt });
  const known = new Map<number, TrackedProcess>();
  const candidates = new Map<number, TrackedProcess[]>();
  for (const group of groups.values()) for (const member of [...(group.startedAt ? [{pid: group.pgid, startedAt: group.startedAt}] : []), ...group.members ?? []]) {
    if (member.pid > 1 && member.pid !== process.pid && member.startedAt) {
      const tracked = {startedAt: member.startedAt, pgid: group.pgid};
      candidates.set(member.pid, [...candidates.get(member.pid) ?? [], tracked]);
      // Prefer the original membership ledger when the same lifetime has
      // also been observed leading its own group. Its move fence stays put.
      if (!known.has(member.pid) || member.pid !== group.pgid) known.set(member.pid, tracked);
    }
  }
  if (validPid && startedAt) {
    const tracked = {startedAt, pgid: pid};
    candidates.set(pid, [...candidates.get(pid) ?? [], tracked]);
    if (!known.has(pid)) known.set(pid, tracked);
  }
  const persistGroups = onGroups ? async () => { await onGroups(structuredClone([...groups.values()])); } : undefined;
  let matches = false;
  for (;;) {
    try {
      for (const [child, saved] of candidates) if (new Set(saved.map(member => member.startedAt)).size > 1) {
        // Ledger order cannot make an obsolete leader overwrite a newly
        // tracked lifetime. Resolve conflicts only among saved identities.
        const current = await inspecting.identity(child);
        if (current === null) {
          if ((await inspecting.table()).some(row => row.pid === child)) throw new ProcessInspectionError('Saved process lifetime is unresolved.');
          known.delete(child);
        } else {
          const matching = saved.filter(member => member.startedAt === current);
          const tracked = matching.find(member => member.pgid !== child) ?? matching[0];
          if (tracked) known.set(child, tracked);
          else known.delete(child);
        }
      }
      matches = validPid && !!startedAt && await inspecting.identity(pid) === startedAt;
      if (matches) {
        groups.get(pid)!.cleanupPending = true;
        await persistDiscovery(cleanupEnds, persistGroups);
      }
      if (!matches && !fence) {
        const table = await inspecting.table();
        const memberLives = await Promise.all([...known].map(async ([child, tracked]) => {
          const row = table.find(value => value.pid === child);
          return !!row && [null, tracked.startedAt].includes(await entryIdentity(row, inspecting));
        }));
        for (const group of groups.values()) if (await groupOwned(group, table, inspecting)) {
          group.cleanupPending = true;
          await persistDiscovery(cleanupEnds, persistGroups);
        }
        if (![...groups.values()].some(group => group.cleanupPending) && !memberLives.some(Boolean)) return false;
      }
      break;
    } catch (error) {
      if (!(error instanceof ProcessInspectionError)) throw error;
      if (Date.now() >= cleanupEnds) throw new ProcessCleanupError();
      await new Promise(done => setTimeout(done, Math.min(250, cleanupEnds - Date.now())));
    }
  }
  await cleanupProcess(validPid ? pid : 0, startedAt, fence, known, groups, inspector, undefined, persistGroups, undefined, undefined, () => matches, cleanupStarted);
  return true;
}

type CleanupDirectory = Pick<RunnerStorageDirectory, 'path' | 'assertCurrent'>;
type CleanupEntry = {
  parent: CleanupDirectory; name: string; info: Stats;
  directory?: CleanupDirectory; children?: CleanupEntry[];
};

/** Retain every directory before removing any evidence. Never ask rm to traverse a mutable name. */
async function cleanupBoundRunHomes(root: RunnerStorageDirectory, skipTests: boolean, runId?: string): Promise<void> {
  const retained: FileHandle[] = [];
  const sameFile = (left: {dev: number; ino: number}, right: {dev: number; ino: number}) =>
    left.dev === right.dev && left.ino === right.ino;
  const refused = () => new ProcessRefusal('adapter_refused');
  const pathFor = (parent: CleanupDirectory, name: string) => {
    if (!/^\/proc\/self\/fd\/\d+$/u.test(parent.path) || !name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) throw refused();
    return join(parent.path, name);
  };
  const matches = (left: CleanupEntry['info'], right: CleanupEntry['info']) =>
    sameFile(left, right) && left.isDirectory() === right.isDirectory() && left.isFile() === right.isFile();
  function inspect(parent: CleanupDirectory, name: string): Promise<CleanupEntry>;
  function inspect(parent: CleanupDirectory, name: string, allowMissing: boolean): Promise<CleanupEntry | undefined>;
  async function inspect(parent: CleanupDirectory, name: string, allowMissing = false): Promise<CleanupEntry | undefined> {
    await parent.assertCurrent();
    const path = pathFor(parent, name);
    let info: CleanupEntry['info'];
    try {info = await lstat(path);}
    catch (error) {
      // Only the requested home's initial lookup may certify it absent.
      // A missing descendant or failed traversal still leaves unresolved work.
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (!info.isDirectory() && !info.isFile()) throw refused();
    const entry: CleanupEntry = {parent, name, info};
    if (info.isDirectory()) {
      const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | 0x80000);
      retained.push(file);
      // Compare against the pre-open observation, so swapping a child while
      // open was queued cannot silently make the new directory ours to clean.
      const held = await file.stat();
      if (!held.isDirectory() || !sameFile(info, held)) throw refused();
      const flags = /^flags:\s+([0-7]+)$/mu.exec(await readFile(`/proc/self/fdinfo/${file.fd}`, 'utf8'))?.[1];
      if (!flags || !(Number.parseInt(flags, 8) & 0x80000)) throw refused();
      const directory: CleanupDirectory = {path: `/proc/self/fd/${file.fd}`, assertCurrent: async () => {
        await parent.assertCurrent();
        const current = await lstat(path);
        if (!current.isDirectory() || !sameFile(info, current)) throw refused();
      }};
      entry.directory = directory;
      await directory.assertCurrent();
      entry.children = [];
      for (const child of await readdir(directory.path)) entry.children.push(await inspect(directory, child));
    }
    return entry;
  }
  const remove = async (entry: CleanupEntry): Promise<void> => {
    if (entry.children) for (const child of entry.children) await remove(child);
    await entry.parent.assertCurrent();
    const path = pathFor(entry.parent, entry.name);
    if (!matches(entry.info, await lstat(path))) throw refused();
    // A renamed ancestor cannot redirect either operation: all ancestors are
    // retained descriptors, and unlink/rmdir never follow the final basename.
    // In particular, rmdir refuses a replacement subtree containing any files.
    if (entry.directory) await rmdir(path);
    else await unlink(path);
    await entry.parent.assertCurrent();
  };
  const close = async () => {
    const closed = await Promise.allSettled(retained.map(file => file.close()));
    const failed = closed.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  };
  try {
    await root.assertCurrent();
    const entries: CleanupEntry[] = [];
    for (const name of runId === undefined ? await readdir(root.path) : [runId]) {
      if (skipTests && /^test-[a-f0-9]{32}$/u.test(name)) continue;
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(name)) throw refused();
      const entry = await inspect(root, name, runId !== undefined);
      if (!entry) continue;
      if (!entry.directory) throw refused();
      entries.push(entry);
    }
    // Keep the legacy whole-batch safety check: an unsafe tree preserves all
    // homes, including entries inspected before the offending symlink/file.
    await root.assertCurrent();
    for (const entry of entries) await remove(entry);
    await root.assertCurrent();
  } finally {
    // This promise belongs to the owner's physical operation. Caller timeout
    // and RunnerCore.close cannot close/reuse any descriptor still in use.
    await close();
  }
}

/** Call only after crash recovery or service stop has removed every process tree. */
export async function cleanupRunHomes(dataDir: string, options: {skipTests?: boolean; directory?: RunnerStorageDirectory} = {}): Promise<void> {
  if (options.directory) return cleanupBoundRunHomes(options.directory, !!options.skipTests);
  if (!isAbsolute(dataDir) || resolve(dataDir) !== dataDir || dirname(dataDir) === dataDir) throw new ProcessRefusal('adapter_refused');
  const root = join(dataDir, 'run-homes');
  await assertNoSymlinks(root);
  try {
    if (!(await lstat(root)).isDirectory()) throw new ProcessRefusal('adapter_refused');
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (process.platform === 'linux') {
    // Standalone callers have no retained core owner. Acquire exclusion and
    // retain its handles until physical cleanup settles, just like the core.
    const {acquireRunnerStorageLock} = await import('./storage-lock.js');
    const lock = await acquireRunnerStorageLock(dataDir);
    try {await cleanupBoundRunHomes(await lock.directory('run-homes'), !!options.skipTests);}
    finally {await lock.release();}
    return;
  }
  let entries: string[];
  try {
    entries = (await readdir(root)).filter(name => !(options.skipTests && /^test-[a-f0-9]{32}$/u.test(name)));
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
export interface LinuxToolLaunchRequest {
  argv: string[]; cwd: string; env: NodeJS.ProcessEnv; deadline: number;
  workspace?: string; credentials?: Record<string, string>; runHome?: string;
  /** Selects a founder-provisioned profile, never an ambient CLI home. */
  selectedLogin?: 'codex' | 'claude';
  /** Verified, data-only preparation from before claim/test authorization. */
  localProvider?: LinuxLocalProviderSpec;
  acceptanceOperation?: LinuxAcceptanceOperation;
  /** Closed probe ID or the main workload purpose, included in native binding. */
  operationProfile?: string;
  signal?: AbortSignal;
}
/** The retained owner journals every admission and retires only after empty proof. */
export interface LinuxToolLifecycle {
  prepare(request: LinuxToolLaunchRequest): Promise<LinuxContainedRun>;
  launch(run: LinuxContainedRun, assertLaunchAllowed?: () => void): Promise<void>;
  cleanup(run: LinuxContainedRun, deadline: number): Promise<void>;
}
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
  /** Bounds executable probes during preparation; never grants admission. */
  signal?: AbortSignal;
  /** Release the agent skill fence after adapter spawn, before further bookkeeping awaits. */
  onStarted?: () => Promise<void>;
  onSpawn?: (pid: number, startedAt: string, pgid: number, toolRoot?: ProcessIdentity) => Promise<void> | void;
  onGroups?: (groups: ProcessGroup[]) => Promise<void> | void;
  /** S1 owner-generation seam: synchronous admission veto, never cleanup authority. */
  assertLaunchAllowed?: () => void;
  linuxLifecycle?: LinuxToolLifecycle;
  acceptanceOperation?: LinuxAcceptanceOperation;
  operationPurpose?: RunnerAuthorizationPurpose;
  stageProjectFile?: (file: AdapterFile) => Promise<void>;
  /** Host operations are injectable so socket-free unit tests need no process-table permission. */
  processes?: ProcessInspector;
  now?: () => number;
  /** Private helper data, outside the workspace. The core owns every run home. */
  dataDir?: string;
  runId?: string;
  /** Retained controller root supplied by the owner for single-home cleanup. */
  runHomesDirectory?: RunnerStorageDirectory;
  /** Source-only loopback probes. Never accepted by a release artifact. */
  qaEnv?: Record<string, string>;
  /** Source-only fake Keychain for socket-free tests. */
  readProviderKey?: () => Promise<string | null | undefined>;
}

export function validateQaEnv(env: Record<string, string> | undefined, release = RELEASE): Record<string, string> {
  if (env === undefined) return {};
  if (release) throw new ProcessRefusal('adapter_refused');
  for (const [name, value] of Object.entries(env)) {
    if (!['DEEPSEEK_BASE_URL', 'DSH_TELEMETRY_OTLP_URL'].includes(name)) throw new ProcessRefusal('adapter_refused');
    let url: URL;
    try { url = new URL(value); } catch { throw new ProcessRefusal('adapter_refused'); }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash) throw new ProcessRefusal('adapter_refused');
  }
  return {...env};
}

async function runHomePath(dataDir: string, runId: string): Promise<string> {
  if (!isAbsolute(dataDir) || resolve(dataDir) !== dataDir || dirname(dataDir) === dataDir ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(runId)) throw new ProcessRefusal('adapter_refused');
  const home = join(dataDir, 'run-homes', runId);
  await assertNoSymlinks(home);
  return home;
}

/** Only call after the named run's complete process tree is verified gone. */
export async function cleanupRunHome(dataDir: string, runId: string, options: {directory?: RunnerStorageDirectory} = {}): Promise<void> {
  if (!isAbsolute(dataDir) || resolve(dataDir) !== dataDir || dirname(dataDir) === dataDir ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(runId)) throw new ProcessRefusal('adapter_refused');
  if (options.directory) return cleanupBoundRunHomes(options.directory, false, runId);
  if (process.platform === 'linux') {
    const {acquireRunnerStorageLock} = await import('./storage-lock.js');
    const lock = await acquireRunnerStorageLock(dataDir);
    try {await cleanupBoundRunHomes(await lock.directory('run-homes'), false, runId);}
    finally {await lock.release();}
    return;
  }
  const home = await runHomePath(dataDir, runId);
  try {
    if (!(await lstat(home)).isDirectory() || await realpath(home) !== home) throw new ProcessRefusal('adapter_refused');
    // rm does not follow symlinks within a tree; the root and its ancestors are checked above.
    await rm(home, {recursive: true});
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

export async function startTool(options: StartToolOptions): Promise<RunningTool> {
  if (process.platform === 'linux' && !options.linuxLifecycle) throw new ProcessRefusal('linux_containment_unavailable');
  validateQaEnv(options.qaEnv);
  if (RELEASE && options.readProviderKey || options.spec.runHome !== null) throw new ProcessRefusal('adapter_refused');
  if (!options.adapter.info.runHome) return startPreparedTool(options);
  throw new ProcessRefusal('adapter_refused');
}

async function startPreparedTool(options: StartToolOptions): Promise<RunningTool> {
  const { adapter, spec } = options;
  const linux = process.platform === 'linux';
  if (linux && !options.linuxLifecycle) throw new ProcessRefusal('linux_containment_unavailable');
  const inspector = options.processes ?? systemInspector;
  const now = options.now ?? Date.now;
  const startedAtClock = now(), workloadClock = process.hrtime.bigint();
  const deadline = Math.min(computeRunDeadline(options.claimedAt, options.expiresAt, options.maxRunMinutes),
    options.acceptanceOperation ? startedAtClock + acceptanceOperationWorkloadBudget(options.acceptanceOperation) : Infinity);
  if (deadline <= now()) throw new ProcessRefusal('run_time_limit');
  const workloadNotAfter = workloadClock + BigInt(Math.floor(Math.max(0, deadline - startedAtClock) * 1e6));
  const workloadRemaining = () => Math.max(0, Math.min(deadline - now(), Number(workloadNotAfter - process.hrtime.bigint()) / 1e6));
  // Linux checks the owner when entering its claim scope below, before any
  // executable probe. Darwin retains its original admission boundary.
  if (!linux) options.assertLaunchAllowed?.();
  const admitted = await enforceAdapter({...spec, ...options});
  if (!admitted.ok) throw new ProcessRefusal(admitted.code!);
  if (linux && !toolRunCapability((options.matrix ?? TOOL_MATRIX).tools.find(tool => tool.run?.adapter === adapter.info.tool), 'linux')?.offered) {
    const purpose = options.operationPurpose ?? 'claim';
    assertAcceptanceOperation(options.acceptanceOperation, {toolKey: adapter.info.tool, platform: 'linux', purpose,
      ...(purpose === 'claim' ? {runId: options.runId ?? ''} : {})});
    if (['codex', 'claude-code'].includes(adapter.info.tool) && spec.access !== 'full_access') throw new ProcessRefusal('adapter_refused');
  }
  const operation = {signal: options.signal, deadline: Date.now() + workloadRemaining()};
  const check = () => enforceExecutableAdapter({...spec, ...options, operation});
  const checked = await (linux ? withClaimedToolCommands({tool: adapter.info.tool,
    file: options.recordedRealpath ?? spec.bin, deadline: operation.deadline, signal: options.signal,
    matrix: options.matrix,
    contained: !!options.linuxLifecycle, operation: options.acceptanceOperation, assertAllowed: options.assertLaunchAllowed}, check) : check());
  if (!checked.ok) throw new ProcessRefusal(checked.code!);
  const workspace = await realpath(spec.cwd);
  if (deadline <= now()) throw new ProcessRefusal('run_time_limit');
  const recorded = options.recordedRealpath ?? spec.bin;
  const preparedFingerprint = await fingerprint(recorded);
  if (identityCache.get(adapter)?.get(recorded)?.fingerprint !== preparedFingerprint) throw new ProcessRefusal('tool_identity');
  const invocation = adapter.build({ ...spec, bin: recorded, timeoutSeconds: timeoutSeconds(deadline, now()) });
  const localProvider = linux ? preparedLinuxLocalProvider({tool: adapter.info.tool, provider: spec.provider, model: spec.model}) : undefined;
  if (invocation.argv[0] !== recorded || invocation.argv.some((arg) => forbidden.has(arg) || (adapter.info.tool === 'continue' && arg === '--agent') || (adapter.info.tool === 'deepseek-harness' && dshForbidden.has(arg)))) throw new ProcessRefusal('adapter_refused');
  const tokenPattern = /(?:pm_run_|mdai_skill_)[A-Za-z0-9_-]+/u;
  if (invocation.argv.some((arg) => tokenPattern.test(arg)) || [...invocation.files, ...invocation.projectFiles].some((file) => tokenPattern.test(file.path) || tokenPattern.test(file.content))) throw new ProcessRefusal('adapter_refused');
  checkSubcommand(adapter.info.tool, invocation.argv);
  const isDsh = adapter.info.tool === 'deepseek-harness';
  const selectedLogin = linux && spec.provider === null ?
    adapter.info.tool === 'codex' ? 'codex' : adapter.info.tool === 'claude-code' ? 'claude' : undefined : undefined;
  if (selectedLogin) {
    const key = selectedLogin === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
    const version = selectedLogin === 'codex' ? '0.162.1' : '2.1.296';
    if (spec.access !== 'full_access' || invocation.env[key] !== `/work/.mdai-home/${selectedLogin}` ||
        identityCache.get(adapter)?.get(recorded)?.version !== version) throw new ProcessRefusal('adapter_refused');
  }
  const secretNames = Object.keys(invocation.secretEnv ?? {});
  if (isDsh) {
    if (!adapter.info.runHome || !spec.runHome || invocation.spawnCwd !== join(spec.runHome, 'launch') ||
        invocation.env.DSH_HOME !== join(spec.runHome, 'dsh-home') || invocation.env.TMPDIR !== join(spec.runHome, 'tmp') || invocation.env.DSH_TELEMETRY_DISABLED !== '1' ||
        invocation.env.DSH_PERMISSION_MODE !== (spec.access === 'folder_only' ? 'workspace-write' : 'danger-full-access') ||
        secretNames.length !== 1 || invocation.secretEnv.DEEPSEEK_API_KEY !== 'provider-key:deepseek' ||
        invocation.argv.length !== 7 || invocation.argv.slice(1).join('\0') !== ['--profile', 'headless', '--patch', join(spec.runDir, 'config/dsh.patch.yml'), '--json', '-'].join('\0') ||
        Object.keys(invocation.env).some(name => !['DSH_HOME', 'TMPDIR', 'DSH_TELEMETRY_DISABLED', 'DSH_PERMISSION_MODE', ...(!RELEASE ? ['HOME'] : [])].includes(name))) throw new ProcessRefusal('adapter_refused');
    await assertNoSymlinks(invocation.spawnCwd);
    if (await realpath(invocation.spawnCwd) !== invocation.spawnCwd) throw new ProcessRefusal('adapter_refused');
  } else if (adapter.info.runHome || spec.runHome || invocation.spawnCwd || secretNames.length || options.qaEnv !== undefined || options.readProviderKey) throw new ProcessRefusal('adapter_refused');
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
  const env = await buildToolEnvironment(recorded, invocation.env, invocation.envUnset);
  if (isDsh && (env.DSH_HOME !== invocation.env.DSH_HOME || env.TMPDIR !== invocation.env.TMPDIR || env.DSH_TELEMETRY_DISABLED !== '1' || env.DSH_PERMISSION_MODE !== invocation.env.DSH_PERMISSION_MODE)) throw new ProcessRefusal('adapter_refused');
  Object.assign(env, validateQaEnv(options.qaEnv));
  const fence = options.fence ?? randomBytes(16).toString('hex');
  if (!/^[a-f0-9]{32}$/u.test(fence)) throw new ProcessRefusal('adapter_refused');
  // Added last, so neither adapter env nor envUnset can replace the run's fence.
  env.MDAI_RUN_FENCE = fence;
  if (!linux) {
    try { await inspector.table(); await (inspector.fencePids ?? fencePids)(fence); } catch { throw new ProcessRefusal('adapter_refused'); }
  }
  if (await fingerprint(recorded) !== preparedFingerprint || await realpath(spec.bin) !== recorded) throw new ProcessRefusal('tool_identity');
  let providerKey: string | undefined;
  if (isDsh) {
    try { providerKey = await (options.readProviderKey ? options.readProviderKey() : new KeychainProviderKeyStore().get('deepseek')) ?? undefined; }
    catch { throw new ProcessRefusal('provider_key_missing'); }
    if (!providerKey || !isValidDeepseekKey(providerKey)) throw new ProcessRefusal('provider_key_missing');
    if ([...invocation.argv, ...Object.values(invocation.env), ...[...invocation.files, ...invocation.projectFiles].flatMap(file => [file.path, file.content])].some(value => value.includes(providerKey!))) throw new ProcessRefusal('adapter_refused');
    env.DEEPSEEK_API_KEY = providerKey;
  }
  for (const file of invocation.files) await configFile(config, file);
  for (const file of invocation.projectFiles) {
    if (!options.stageProjectFile) throw new ProcessRefusal('adapter_refused');
    await options.stageProjectFile(file);
  }
  if (await fingerprint(recorded) !== preparedFingerprint || await realpath(spec.bin) !== recorded) throw new ProcessRefusal('tool_identity');
  const stdoutFd = openSync(join(spec.runDir, 'stdout.log'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let stderrFd: number;
  try { stderrFd = openSync(join(spec.runDir, 'stderr.log'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); } catch (error) { closeSync(stdoutFd); throw error; }
  let transcriptFd: number | undefined;
  try {
    if (isDsh) {
      // Do not let dsh persist raw events: its NDJSON projection can truncate a secret
      // before the core ever sees it. This transcript uses only the redacted pipe.
      const transcript = join(await realpath(spec.runDir), 'transcript');
      await mkdir(transcript, { mode: 0o700 });
      transcriptFd = openSync(join(transcript, 'events.jsonl'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    }
  } catch (error) { closeSync(stdoutFd); closeSync(stderrFd); throw error; }
  // Keep a live group leader on Darwin too. A tool can fork a child in its
  // TERM handler and exit between scans; the guardian's exact lifetime still
  // authenticates that group without trusting historical PGID observations.
  const retainedRoot = linux || process.platform === 'darwin' && (inspector === systemInspector || inspector.sessionGuardian === true);
  const spawnOptions = {cwd: invocation.spawnCwd ?? spec.cwd, env, detached: true, shell: false};
  try { options.assertLaunchAllowed?.(); }
  catch (error) {
    closeSync(stdoutFd); closeSync(stderrFd); if (transcriptFd !== undefined) closeSync(transcriptFd);
    delete env.DEEPSEEK_API_KEY;
    throw error;
  }
  let contained: LinuxContainedRun | undefined;
  let containmentDeadline = deadline;
  let child: ChildProcessWithoutNullStreams;
  try {
    if (linux) {
      const workloadEnv = {...env};
      delete workloadEnv.DEEPSEEK_API_KEY;
      // The runner can supply its own clock. Convert its remaining budget once
      // into the real-time domain used by containment and native handshakes.
      const preparingAt = Date.now();
      containmentDeadline = preparingAt + workloadRemaining();
      contained = await options.linuxLifecycle!.prepare({argv: [...invocation.argv], cwd: invocation.spawnCwd ?? spec.cwd,
        workspace: spec.cwd, env: workloadEnv, deadline: containmentDeadline, ...(providerKey ? {credentials: {DEEPSEEK_API_KEY: providerKey}} : {}),
        acceptanceOperation: options.acceptanceOperation, operationProfile: 'workload', signal: options.signal,
        ...(selectedLogin ? {selectedLogin} : {}),
        ...(localProvider ? {localProvider} : {}),
        ...(spec.runHome ? {runHome: spec.runHome} : {})});
      child = contained.child;
    } else child = (retainedRoot ? spawn(process.execPath, ['--input-type=module', '-e', sessionGuardian, ...invocation.argv], {...spawnOptions, stdio: ['pipe', 'pipe', 'pipe', 'ipc']}) :
      spawn(recorded, invocation.argv.slice(1), {...spawnOptions, stdio: ['pipe', 'pipe', 'pipe']})) as ChildProcessWithoutNullStreams;
  } catch (error) {
    closeSync(stdoutFd); closeSync(stderrFd); if (transcriptFd !== undefined) closeSync(transcriptFd);
    delete env.DEEPSEEK_API_KEY;
    throw error;
  }
  delete env.DEEPSEEK_API_KEY;
  const spawnedBy = Date.now();
  let stdout = '';
  let stderr = '';
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputTruncated = false;
  // Child close (and even stream close) does not prove that all bytes drained.
  // Only observed, error-free EOF on both pipes can authorize publication.
  const outputEnded = {stdout: false, stderr: false};
  let cleanupAfterOutputEOF = false;
  let guardianTerminatedAfterEOF = false;
  let reportOutputEnded!: () => void;
  const outputEOF = new Promise<void>(resolve => {reportOutputEnded = resolve;});
  const outputComplete = () => outputEnded.stdout && outputEnded.stderr &&
    !child.stdout.errored && !child.stderr.errored;
  const truncateIncompleteOutput = () => {if (!outputComplete()) outputTruncated = true;};
  const destroyOutput = () => {
    truncateIncompleteOutput();
    child.stdout.destroy(); child.stderr.destroy();
  };
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');
  let reason: string | null = null;
  let stopping: Promise<void> | null = null;
  const known = new Map<number, TrackedProcess>();
  // Capture the OS-created group before the first awaited identity lookup.
  // Fast exits can leave an environment-cleared child in this original group.
  const groups = new Map<number, ProcessGroup>(!linux && child.pid ? [[child.pid, { pgid: child.pid, startedAt: '', spawnedBy, cleanupPending: true }]] : []);
  const liveGroups = new Map<number, number>(!linux && child.pid ? [[child.pid, spawnedBy]] : []);
  let savedGroups = '';
  const durableCleanup = new Set<number>();
  const persistGroups = async () => {
    if (linux) return;
    const values = [...groups.values()].map(group => ({ ...group }));
    const current = JSON.stringify(values);
    if (current !== savedGroups) {
      await options.onGroups?.(values);
      savedGroups = current;
      durableCleanup.clear();
      for (const group of values) if (group.cleanupPending) durableCleanup.add(group.pgid);
    }
  };
  let startedAt = '';
  let snapshot: Promise<void> = Promise.resolve();
  let scanning = false;
  const scan = () => {
    // Coalesce interval ticks instead of building a queue of slow ps scans.
    // Cleanup joins this one snapshot and owns inspection from then on.
    if (linux || stopping || scanning || !child.pid) return snapshot;
    scanning = true;
    snapshot = descendants(child.pid, startedAt, known, groups, boundedInspector(inspector, Date.now() + INSPECTION_TIMEOUT), liveGroups, persistGroups)
      .finally(persistGroups).catch(() => undefined).finally(() => { scanning = false; });
    return snapshot;
  };
  const ownChildAlive = () => !!child.pid && child.exitCode === null && child.signalCode === null && !spawnError;
  const rootAuthority: SignalChild = {child, parentPid: process.pid, valid: () => !spawnError};
  const signalOwnedGroup = async (signal: NodeJS.Signals, inspecting = inspector): Promise<boolean> => {
    return (await signalIfStillOwned({kind: 'group', pid: child.pid ?? 0}, signal, {
      witness: {pid: child.pid ?? 0, startedAt}, authority: rootAuthority,
      read: () => signalEntry(inspecting, child.pid ?? 0), allowChildPidFallback: true,
      sendGroup: inspecting.signalGroup, deadline: inspecting.signalDeadline,
    })).status === 'sent';
  };
  let pipeTimer: ReturnType<typeof setTimeout> | undefined;
  let pipesClosed = false;
  let outputsClosed = false;
  let reportPipesClosed!: () => void;
  const closed = new Promise<void>(resolve => { reportPipesClosed = resolve; });
  let reportChildExit!: () => void;
  const childExited = new Promise<void>(resolve => { reportChildExit = resolve; });
  let rejectFinished!: (error: Error) => void;
  const cleanup = (): Promise<void> => {
    const cleanupStarted = Date.now(), cleanupEnds = cleanupStarted + TERM_GRACE + VERIFY_CAP;
    stopping ??= (async () => {
      clearInterval(interval);
      if (contained) {
        // Revoke admission synchronously before storage, grace or event waits.
        contained.seal();
        // The guardian releases its own output descriptors after spawn. A
        // natural main exit can still leave descendant writers alive, so prove
        // EOF before cleanup can terminate them. Bound this wait by the same
        // workload/cleanup budgets; an expired drain can never publish a prefix.
        if (selectedLogin && toolExit?.code === 0 && !toolExit.signal && !reason && !outputTruncated && !outputComplete()) {
          let drainTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([outputEOF, new Promise<void>(resolve => {
              drainTimer = setTimeout(resolve, Math.max(0, Math.min(1000, cleanupEnds - Date.now(), workloadRemaining())));
            })]);
          } finally {clearTimeout(drainTimer);}
        }
        if (selectedLogin) truncateIncompleteOutput();
        cleanupAfterOutputEOF = outputComplete() && !outputTruncated;
        await beforeDeadline(cleanupEnds, () => options.linuxLifecycle!.cleanup(contained!, cleanupEnds));
        if (child.exitCode === null && child.signalCode === null) await beforeDeadline(cleanupEnds, () => childExited);
        if (!pipesClosed) {
          pipeTimer ??= setTimeout(destroyOutput, Math.min(1000, Math.max(0, cleanupEnds - Date.now())));
          await beforeDeadline(cleanupEnds, () => closed);
        }
        return;
      }
      let rootTermSent = false;
      // Start the direct child's TERM grace before joining a slow snapshot.
      // Group signals additionally require a fresh lifetime/group snapshot.
      if (!retainedRoot && child.pid && ownChildAlive()) {
        if (!durableCleanup.has(child.pid)) {
          await persistDiscovery(cleanupEnds, persistGroups);
        }
        try { if (ownChildAlive()) rootTermSent = await signalOwnedGroup('SIGTERM', boundedInspector(inspector, cleanupEnds)); }
        catch (error) { if (!['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
      }
      try { await beforeDeadline(cleanupEnds, () => snapshot); }
      finally { await persistDiscovery(cleanupEnds, persistGroups); }
      await cleanupProcess(child.pid ?? 0, startedAt, fence, known, groups, inspector, signalOwnedGroup, persistGroups,
        () => !retainedRoot && ownChildAlive(), liveGroups,
        () => !!child.pid && !spawnError && (child.exitCode !== null || child.signalCode !== null), cleanupStarted, rootTermSent, retainedRoot, rootAuthority);
      if (retainedRoot && child.exitCode === null && child.signalCode === null) {
        if (child.connected) child.send('release', () => undefined);
        await beforeDeadline(cleanupEnds, () => childExited);
      }
      // Descendants can hold inherited pipes after the child exits. Draining
      // and the close event share the original cleanup budget too.
      if (!pipesClosed) {
        pipeTimer ??= setTimeout(destroyOutput, Math.min(1000, Math.max(0, cleanupEnds - Date.now())));
        await beforeDeadline(cleanupEnds, () => closed);
      }
    })().catch(async failure => {
      // Even an unavailable fence scan must not leave our known child running.
      // Never extend the cleanup bound with fresh inspection after it expires.
      try {
        if (linux) throw new ProcessCleanupError();
        const inspecting = boundedInspector(inspector, cleanupEnds);
        if (child.pid && ownChildAlive() && Date.now() >= cleanupEnds) {
          // At the cap no new inspection may extend cleanup. The unreaped
          // child handle can still terminate only its own PID synchronously.
          await signalIfStillOwned({kind: 'pid', pid: child.pid}, 'SIGKILL', {authority: rootAuthority});
        } else if (child.pid && ownChildAlive()) {
          if (!durableCleanup.has(child.pid)) {
            await persistDiscovery(cleanupEnds, persistGroups);
          }
          if (ownChildAlive()) await signalOwnedGroup('SIGKILL', inspecting);
        }
        else if (Date.now() < cleanupEnds) await signalOwnedGroup('SIGKILL', inspecting);
        for (const [pid, tracked] of known) if (Date.now() < cleanupEnds) await signalIfStillOwned({kind: 'pid', pid}, 'SIGKILL', {
          startedAt: tracked.startedAt, deadline: cleanupEnds, authority: pid === child.pid ? rootAuthority : undefined,
          ...(inspecting.inspectSync ? {read: () => inspecting.inspectSync!(pid, cleanupEnds)} : {identity: () => inspecting.identity(pid)}),
        });
      } catch { /* Preserve the saved fence for recovery. */ }
      // A denied signal may leave the child alive, so close is not guaranteed.
      // Settle the public result at the cap and release our I/O handles while
      // retaining the durable cleanup obligation for the next recovery.
      clearTimeout(timer);
      clearTimeout(pipeTimer);
      clearInterval(interval);
      child.stdin.destroy(); destroyOutput();
      child.unref?.(); child.channel?.unref();
      try { closeOutput(true); } catch { /* Still settle failed cleanup if log finalization fails. */ }
      const error = selectedLoginFailure(failure) ?? new ProcessCleanupError();
      rejectFinished(error);
      throw error;
    });
    void stopping.catch(() => undefined);
    return stopping;
  };
  const stop = (code: string): Promise<void> => {
    // Stopping the workload can cut a credential before the pipes later reach
    // EOF. Keep this irreversible even if cleanup subsequently drains them.
    truncateIncompleteOutput();
    reason ??= code;
    return cleanup();
  };
  const pending = {stdout: '', stderr: ''};
  const loggedBytes = {stdout: 0, stderr: 0};
  const redactKey = providerKey ? outputKeyRedactor(providerKey) : undefined;
  const append = (value: string, output: 'stdout' | 'stderr', final = false) => {
    let text = pending[output] + value;
    pending[output] = '';
    if (redactKey) {
      const redacted = redactKey(text, final);
      text = redacted.text;
      pending[output] = redacted.pending;
      if (redacted.found) void stop('secret_in_output');
    }
    const bytes = Buffer.from(text).subarray(0, Math.max(0, OUTPUT_LIMIT - loggedBytes[output]));
    writeSync(output === 'stdout' ? stdoutFd : stderrFd, bytes);
    if (output === 'stdout' && transcriptFd !== undefined) writeSync(transcriptFd, bytes);
    loggedBytes[output] += bytes.length;
    if (output === 'stdout') stdout += text;
    else stderr += text;
  };
  const handleChunk = (chunk: Buffer, output: 'stdout' | 'stderr') => {
    const bytes = output === 'stdout' ? stdoutBytes : stderrBytes;
    const allowed = chunk.subarray(0, Math.max(0, OUTPUT_LIMIT - bytes));
    // Keep selected-login output in bounded memory until extinction and
    // credential disposal let the prepared credential guard approve publication.
    if (!providerKey && !selectedLogin) writeSync(output === 'stdout' ? stdoutFd : stderrFd, allowed);
    if (output === 'stdout') {
      stdoutBytes += chunk.length;
      const text = stdoutDecoder.write(allowed);
      if (providerKey) append(text, output); else stdout += text;
    } else {
      stderrBytes += chunk.length;
      const text = stderrDecoder.write(allowed);
      if (providerKey) append(text, output); else stderr += text;
    }
    if (bytes + chunk.length > OUTPUT_LIMIT) {
      outputTruncated = true;
      void stop('output_too_large');
      return;
    }
    if (output === 'stdout' && adapter.selfCheck) {
      try {
        const check = adapter.selfCheck(stdout);
        if (check && (check.mcpServers.length || check.browserTools.length)) void stop('mcp_started');
      } catch { void stop('tool_failed'); }
    }
  };
  const receive = (chunk: Buffer, output: 'stdout' | 'stderr') => {
    if (outputsClosed) return;
    try { handleChunk(chunk, output); } catch { outputTruncated = true; void stop('tool_failed'); }
  };
  function closeOutput(discard = false): void {
    if (outputsClosed) return;
    outputsClosed = true;
    truncateIncompleteOutput();
    let failure: unknown;
    try {
      if (providerKey) {
        append(stdoutDecoder.end(), 'stdout', true);
        append(stderrDecoder.end(), 'stderr', true);
      } else {
        stdout += stdoutDecoder.end();
        stderr += stderrDecoder.end();
      }
      // Capture completeness is independent of fragment scanning. Incomplete
      // output must reach neither log publication nor the result parser, even
      // when the retained fragment is shorter than the guard's minimum.
      if (selectedLogin && outputTruncated && !spawnError) reason ??= 'tool_failed';
      if (selectedLogin && !discard && !outputTruncated && outputComplete()) {
        if (!contained?.assertPublicContent) throw new ProcessCleanupError();
        contained.assertPublicContent(stdout); contained.assertPublicContent(stderr);
        writeSync(stdoutFd, stdout); writeSync(stderrFd, stderr);
      }
    } catch (error) { failure = error; }
    finally {
      for (const fd of [stdoutFd, stderrFd, transcriptFd]) if (fd !== undefined) {
        try { closeSync(fd); } catch (error) { failure ??= error; }
      }
    }
    if (failure) throw failure;
  }
  for (const output of ['stdout', 'stderr'] as const) {
    const stream = child[output];
    if (stream.destroyed || stream.errored) outputTruncated = true;
    stream.once('end', () => {
      outputEnded[output] = true;
      if (outputEnded.stdout && outputEnded.stderr) reportOutputEnded();
    });
    stream.once('close', () => {if (!outputEnded[output]) outputTruncated = true;});
    stream.on('error', () => {outputTruncated = true; void stop('tool_failed');});
    stream.on('data', (chunk: Buffer) => receive(chunk, output));
  }
  child.stdin.on('error', () => { /* early exits can close stdin before the prompt is consumed */ });
  const timer = setTimeout(() => { void stop('run_time_limit'); }, workloadRemaining());
  const interval = setInterval(() => { void scan(); }, 250);
  let spawnError = false;
  let spawnFailureCode = 'tool_not_found';
  let toolExit: {code: number | null; signal: NodeJS.Signals | null} | undefined;
  let reportToolStart!: (pid: number | null) => void;
  const toolStarted = new Promise<number | null>(resolve => {reportToolStart = resolve;});
  child.on('error', () => { outputTruncated = true; spawnError = true; reportToolStart(null); });
  if (retainedRoot) child.on('message', message => {
    if (!message || typeof message !== 'object' || !('type' in message)) return;
    if (message.type === 'guardian-terminated' && cleanupAfterOutputEOF) guardianTerminatedAfterEOF = true;
    if (message.type === 'tool-start' && 'pid' in message && Number.isSafeInteger(message.pid) && Number(message.pid) > 1) reportToolStart(Number(message.pid));
    if (message.type === 'tool-error' || linux && message.type === 'exec-error') {
      spawnError = true;
      outputTruncated = true;
      // S4's unproven bootstrap death remains an admission refusal. Only an
      // explicit execve failure identifies a Linux workload spawn error.
      spawnFailureCode = linux && message.type === 'tool-error' ? 'adapter_refused' : 'tool_not_found';
      reportToolStart(null); void cleanup();
    }
    if (message.type === 'tool-exit' && 'code' in message && 'signal' in message &&
      (message.code === null || Number.isInteger(message.code)) && (message.signal === null || typeof message.signal === 'string')) {
      toolExit = {code: message.code as number | null, signal: message.signal as NodeJS.Signals | null};
      // Pipe EOF and workload status arrive on different channels. A signal
      // can have cut the writer before EOF even if its status arrives later.
      if (toolExit.signal) outputTruncated = true;
      void cleanup();
    }
  });
  child.once('exit', (_code, signal) => {
    // Linux deliberately kills the retained guardian after a natural workload
    // exit. Its post-EOF TERM acknowledgement proves it was still alive then,
    // even when an earlier external kill's exit notification arrives after EOF.
    if (signal && (!toolExit || toolExit.code !== 0 || toolExit.signal || selectedLogin && !guardianTerminatedAfterEOF)) outputTruncated = true;
    reportChildExit(); reportToolStart(null); void cleanup();
  });
  const finished = new Promise<ProcessResult>((done, reject) => {
    rejectFinished = reject;
    child.once('close', (exitCode, signal) => {
      if (signal && (!toolExit || toolExit.code !== 0 || toolExit.signal || selectedLogin && !guardianTerminatedAfterEOF)) outputTruncated = true;
      truncateIncompleteOutput();
      if (toolExit) {exitCode = toolExit.code; signal = toolExit.signal;}
      clearTimeout(timer);
      clearTimeout(pipeTimer);
      pipesClosed = true;
      reportPipesClosed();
      let outputError: unknown;
      if (!selectedLogin) try { closeOutput(); } catch (error) { outputError = error; }
      void (async () => {
        try {
          await cleanup();
          if (selectedLogin) closeOutput();
        } catch (error) { closeOutput(true); throw selectedLoginFailure(error) ?? new ProcessCleanupError(); }
        finally { clearInterval(interval); }
        if (outputError) throw outputError;
        const result = reason ? { ok: false, text: '', failureCode: reason } : spawnError ? { ok: false, text: '', failureCode: spawnFailureCode } : adapter.parse({ stdout, stderr, exitCode, signal, runDir: spec.runDir, cwd: workspace });
        if (selectedLogin) contained!.assertPublicContent!(result.text);
        done({ ...result, exitCode, signal, stopped: reason !== null });
      })().catch(reject);
    });
  });
  // A fast exit can finish cleanup before startTool returns its public promise.
  void finished.catch(() => undefined);
  // Cancellation can arrive before the core has received the public handle.
  // Seal and clean through the retained lifecycle immediately in that interval.
  const abortStartup = () => {void stop('runner_stopped').catch(() => undefined);};
  if (linux) {
    options.signal?.addEventListener('abort', abortStartup, {once: true});
    void finished.finally(() => options.signal?.removeEventListener('abort', abortStartup)).catch(() => undefined);
    if (options.signal?.aborted) abortStartup();
  }
  // Startup callbacks can outlive the tool, including a natural exit whose
  // close event cancels the run deadline. Every finished result must interrupt
  // startup; only verified natural completion returns the finished handle.
  const startupComplete = Symbol('startup complete');
  let startupEnded = false;
  let startupEnd: unknown;
  const startupFinished = finished.then(result => {
    startupEnded = true;
    startupEnd = result.stopped ? new ProcessRefusal(result.failureCode ?? 'runner_stopped') : startupComplete;
    throw startupEnd;
  }, error => {
    startupEnded = true;
    startupEnd = error;
    throw error;
  });
  void startupFinished.catch(() => undefined);
  const duringStartup = <T>(action: () => Promise<T>): Promise<T> => {
    // A preceding action may settle in the same turn as finished. Never invoke
    // another callback once the terminal result has already been observed.
    if (startupEnded) return Promise.reject(startupEnd);
    if (linux && options.signal?.aborted) return Promise.reject(new ProcessRefusal('runner_stopped'));
    return Promise.race([action(), startupFinished]);
  };
  const pid = child.pid ?? 0;
  const runningHandle = (): RunningTool => ({pid, startedAt, fence, finished, stop});
  const settleStartup = async (error: unknown, code: string): Promise<RunningTool> => {
    if (error === startupComplete) return runningHandle();
    await stop(code);
    await finished;
    throw error;
  };
  let rootAbsent = false;
  // Freeze the spawned lifetime BEFORE the first persistence/callback await.
  // A later lookup may reject this identity, but can never replace it.
  try {
    if (contained) {
      await duringStartup(() => contained!.ready);
      // Diagnostic projection only. The retained registration, never this PID
      // or start string, is the Linux cleanup authority.
      startedAt = 'linux-contained';
    } else {
      const initialRow = pid && inspector.inspectSync ? inspector.inspectSync(pid) : undefined;
      rootAbsent = initialRow === null;
      if (initialRow === null || initialRow && (initialRow.pid !== pid || initialRow.pgid !== pid || initialRow.ppid !== process.pid)) rootAuthority.revoked = true;
      const initial = !pid ? null : inspector.inspectSync ? initialRow?.startedAt ?? null : await duringStartup(() => inspector.identity(pid));
      if (ownChildAlive() && !rootAuthority.revoked) startedAt = initial ?? '';
      else rootAuthority.revoked = true;
    }
  }
  catch (error) {
    if (error === startupComplete) return runningHandle();
    let cleanupError: unknown;
    try { await stop('adapter_refused'); } catch (error) { cleanupError = error; }
    if (!cleanupError) try { await finished; } catch (error) { cleanupError = error; }
    if (cleanupError) throw cleanupError;
    // A deadline can finish verified cleanup before initial identity returns.
    // Preserve the stopped handle/result instead of treating that private
    // startup interruption as a failed identity check. Never resume callbacks.
    if (startupEnd instanceof ProcessRefusal && error === startupEnd) return runningHandle();
    throw new ProcessRefusal('adapter_refused');
  }
  if (!linux && pid && startedAt) groups.set(pid, { ...groups.get(pid), pgid: pid, startedAt, spawnedBy });
  try { await duringStartup(persistGroups); } catch (error) { return settleStartup(error, 'runner_stopped'); }
  try {
    if (!linux && pid && startedAt && ownChildAlive()) {
      const current = inspector.inspectSync ? inspector.inspectSync(pid)?.startedAt ?? null : await duringStartup(() => inspector.identity(pid));
      if (!ownChildAlive() || current !== startedAt) rootAuthority.revoked = true;
      rootAbsent = current === null;
    }
    // Native readers treat reaped/zombie processes as absent. Node may not
    // have delivered exit yet. Keep signalling revoked, but let that pending
    // event finish a normal run instead of misclassifying it as a live reuse.
    if (rootAbsent && ownChildAlive()) await duringStartup(() => beforeDeadline(Date.now() + INSPECTION_TIMEOUT, () => childExited));
    if (rootAuthority.revoked && ownChildAlive()) throw new ProcessRefusal('adapter_refused');
  } catch (error) { return settleStartup(error, 'adapter_refused'); }
  if (!retainedRoot) {
    try { await duringStartup(async () => options.onStarted?.()); } catch (error) { return settleStartup(error, 'runner_stopped'); }
  }
  if (pid && !startedAt && child.exitCode === null && child.signalCode === null && !spawnError) {
    // The ChildProcess still identifies our own live child, but recovery could not.
    reason = 'adapter_refused';
    await signalIfStillOwned({kind: 'pid', pid}, 'SIGKILL', {
      authority: rootAuthority, ...(inspector.inspectSync ? {read: () => inspector.inspectSync!(pid)} : {}),
    });
    await stop('adapter_refused');
    await finished;
    throw new ProcessRefusal('adapter_refused');
  }
  try {
    if (pid) {
      let toolRoot: ProcessIdentity | undefined;
      if (retainedRoot) await duringStartup(persistGroups);
      // The tool only starts once its session anchor is durable. Its private
      // IPC descriptor is never inherited by the tool or its descendants.
      if (contained && !reason && !stopping && ownChildAlive()) {
        options.assertLaunchAllowed?.();
        await duringStartup(() => options.linuxLifecycle!.launch(contained!, options.assertLaunchAllowed));
        const admittedPid = await duringStartup(() => beforeDeadline(Math.min(containmentDeadline, Date.now() + INSPECTION_TIMEOUT), () => toolStarted));
        if (options.signal?.aborted) throw new ProcessRefusal('runner_stopped');
        if (!admittedPid || spawnError) throw new ProcessRefusal(spawnError ? spawnFailureCode : 'adapter_refused');
        if (stopping) await startupFinished;
        await duringStartup(async () => options.onStarted?.());
      } else if (retainedRoot && !reason && !rootAuthority.revoked && ownChildAlive() && child.connected) {
        options.assertLaunchAllowed?.();
        child.send('start', () => undefined);
        const toolPid = await duringStartup(() => beforeDeadline(Date.now() + INSPECTION_TIMEOUT, () => toolStarted));
        if (toolPid) {
          // Spawning the guardian alone does not start the adapter. Keep skill
          // destinations fenced through persistence and the launch handshake.
          await duringStartup(async () => options.onStarted?.());
          // The guardian spawns exactly one child. Recheck this parent link
          // with the native lifetime so reused PIDs cannot become QA exemptions.
          const row = await duringStartup(() => systemInspector.inspect!(toolPid));
          if (row?.ppid === pid && row.pgid === pid && (process.platform !== 'linux' || sessionId(row.sid) === String(pid)) && row.startedAt) toolRoot = {pid: toolPid, startedAt: row.startedAt};
        }
      }
      if (linux && stopping) await startupFinished;
      await duringStartup(async () => options.onSpawn?.(pid, startedAt, pid, toolRoot));
      await duringStartup(persistGroups);
    }
  } catch (error) { return settleStartup(error, 'runner_stopped'); }
  if (linux && stopping) {
    try {await startupFinished;} catch (error) {return settleStartup(error, 'runner_stopped');}
  }
  if (startupEnded) return settleStartup(startupEnd, 'runner_stopped');
  if (linux && options.signal?.aborted) return settleStartup(new ProcessRefusal('runner_stopped'), 'runner_stopped');
  if (!reason) child.stdin.end(invocation.stdinFile ? prompt : undefined);
  else child.stdin.end();
  return runningHandle();
}
