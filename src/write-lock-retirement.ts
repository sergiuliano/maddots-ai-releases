// A saved cohort, rather than a timeout, retires JavaScript already in memory.
// Supported helper children use spawn/exec, so children started after all launch
// roots are patched read the new modules. Node workers retain their host PID.
import type {BigIntStats} from 'node:fs';
import {lstat, readlink} from 'node:fs/promises';
import {userInfo} from 'node:os';
import { posix } from 'node:path';
import { HelperError, runCommand, type Runner } from './config.js';
import { processImages } from './process-image.js';
import { linuxBootId, linuxProcessTable, type LinuxProcess } from './linux-proc.js';

// Persist only the boot UUID and process PID/start time for lifetime checks, plus
// the verified executable path so retry instructions identify the app to close.
// Real UID and zombie state are checked during scans, never stored in the cohort.
export interface ProcessIdentity { pid: number; started: string; executable: string }
export interface Retirement { boot: string; processes: ProcessIdentity[] }
export interface LinuxRecoveryMask {
  path: string;
  dev: string;
  ino: string;
  ctimeNs: string;
  parentDev: string;
  parentIno: string;
  parentMtimeNs: string;
  parentCtimeNs: string;
}
export interface LinuxRecoveryEntrypoint {
  scope: 'system' | 'user';
  unit: string;
  loadState: 'masked';
  activeState: 'inactive';
  subState: 'dead';
  unitFileState: 'masked';
  mainPid: 0;
  activeEnterTimestampMonotonic: string;
  inactiveExitTimestampMonotonic: string;
  mask: LinuxRecoveryMask;
}
/** Function arguments are fixture seams, never executable choices from argv/env. */
export interface RetirementOptions {
  runner?: Runner;
  uid?: number;
  pid?: number;
  platform?: NodeJS.Platform;
  images?: typeof processImages;
  recoveryMask?: (scope: 'system' | 'user') => Promise<LinuxRecoveryMask>;
  linux?: {
    boot: () => Promise<string>;
    table: (options: {uid: number; exe?: boolean}) => Promise<LinuxProcess[]>;
  };
}

const BOOT = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
export const LINUX_LOCK_RETIREMENT_UNVERIFIED_MESSAGE = 'Linux lock retirement cannot be verified. Keep runs disabled; have the installation owner stop old helper/update entrypoints and follow the S5-10 recovery procedure. Retained state is preserved.';
/** Uncertainty never grants Linux writer admission or erases retained evidence. */
export function linuxLockRetirementUnverified(): HelperError {
  return new HelperError('LINUX_LOCK_RETIREMENT_UNVERIFIED', LINUX_LOCK_RETIREMENT_UNVERIFIED_MESSAGE);
}
const INSPECTION_MESSAGE = 'The helper could not verify which old processes are still running. Retry the command. If this continues, quit and reopen your AI tools and command terminals, then retry.';
const busy = (message = INSPECTION_MESSAGE) => new HelperError('HELPER_BUSY', message);
const ENV = { LC_ALL: 'C', TZ: 'UTC0' };
const SERVICE = 'app.maddots.ai.helper';
// The supported runtime is Node CLI processes, spawn/exec children and workers.
// Native injection, dlopen-based Node embedding and native fork-without-exec
// inheritance are outside that model; including them would invalidate even
// stock shell exemptions. Only kernel paths qualify, never ps comm/argv0.
const NO_HELPER_IMAGE = new Set([
  '/bin/bash', '/bin/csh', '/bin/dash', '/bin/ksh', '/bin/sh', '/bin/tcsh', '/bin/zsh',
  '/sbin/launchd', '/bin/launchctl', '/bin/ps', '/usr/sbin/sysctl',
  '/usr/sbin/cfprefsd', '/usr/sbin/distnoted', '/usr/sbin/notifyd', '/usr/sbin/syslogd',
  '/usr/libexec/pboard', '/usr/libexec/pbs', '/usr/libexec/lsd',
]);
const validPid = (pid: number) => Number.isSafeInteger(pid) && pid > 0;
const isControl = (value: string) => value.charCodeAt(0) < 32 || value.charCodeAt(0) === 127;
const printable = (value: string) => value.length > 0 && value.length <= 4096 && ![...value].some(isControl);
const HOST_BASENAME = /^(?:node.*|bun(?:x|[ ._-].*|\d.*)?|deno(?:[ ._-].*|\d.*)?|electron.*|osascript.*|osacompile.*|applet|python.*|ruby.*|perl.*|java.*|jsc(?:[-_.]?\d.*)?|js(?:[-_.]?\d.*)?|qjs(?:[-_.]?\d.*)?|quickjs.*|d8|v8.*|.*extension[ -]?host.*|.*helper \(plugin\).*)$/iu;

/** Classify canonical kernel images under the supported Node runtime model. */
export function isStockNonHostImage(image: string): boolean {
  if (!printable(image) || !posix.isAbsolute(image) || posix.normalize(image) !== image ||
      HOST_BASENAME.test(posix.basename(image))) return false;
  // These sealed stock roots do not host helper JS through a supported API.
  // The trailing slash is deliberate: similarly named external paths qualify
  // for no exemption. Known interpreters/extension hosts above always remain.
  return NO_HELPER_IMAGE.has(image) || image.startsWith('/System/Library/') || image.startsWith('/usr/libexec/');
}

function settings(options: RetirementOptions): {runner: Runner; uid: number; pid: number; platform: NodeJS.Platform} {
  const uid = options.uid ?? process.getuid?.(), pid = options.pid ?? process.pid;
  const platform = options.platform ?? process.platform;
  if (!['darwin', 'linux'].includes(platform) || uid === undefined ||
      !Number.isSafeInteger(uid) || uid < 0 || !validPid(pid)) {
    throw platform === 'linux' ? linuxLockRetirementUnverified() : busy();
  }
  return { runner: options.runner ?? runCommand, uid, pid, platform };
}

const LINUX_NON_HOSTS = new Set([
  '/usr/bin/bash', '/usr/bin/dash', '/usr/bin/zsh', '/usr/bin/fish', '/usr/bin/sh',
  '/usr/bin/flock', '/usr/bin/systemctl', '/usr/bin/ps', '/usr/bin/sleep', '/usr/bin/timeout',
  '/usr/lib/systemd/systemd',
]);

async function linuxBoot(options: RetirementOptions): Promise<string> {
  try {
    const boot = await (options.linux?.boot ?? linuxBootId)();
    if (!BOOT.test(boot)) throw linuxLockRetirementUnverified();
    return boot.toLowerCase();
  } catch { throw linuxLockRetirementUnverified(); }
}

async function linuxRows(context: ReturnType<typeof settings>, options: RetirementOptions, exe = false): Promise<LinuxProcess[]> {
  try {
    // Retirement covers independently launched old Node CLI/module hosts too,
    // not just S3 workloads. An unreadable host outside every helper cgroup can
    // still retain old JS, so contained-run outsider exclusion is unsafe here.
    // Relaxing this needs trusted proof that the old writer generation drained.
    const rows = await (options.linux?.table ?? linuxProcessTable)({uid: context.uid, exe});
    if (!rows.some(row => row.pid === context.pid && !row.zombie) ||
        rows.some(row => row.uid !== context.uid || !validPid(row.pid) || !BOOT.test(row.bootId) ||
          !/^\d+$/u.test(row.startTicks) || row.startedAt !== `linux:${row.bootId}:${row.startTicks}`) ||
        new Set(rows.map(row => row.pid)).size !== rows.length) throw linuxLockRetirementUnverified();
    return rows;
  } catch { throw linuxLockRetirementUnverified(); }
}

const LINUX_RECOVERY_PROPERTIES = 'Id,LoadState,ActiveState,SubState,UnitFileState,MainPID,ActiveEnterTimestampMonotonic,InactiveExitTimestampMonotonic';
const MASK_FIELDS = ['path', 'dev', 'ino', 'ctimeNs', 'parentDev', 'parentIno', 'parentMtimeNs', 'parentCtimeNs'] as const;
/** Schema validation is pure; live verification also binds the scope's fixed path. */
export function validLinuxRecoveryMask(value: unknown): value is LinuxRecoveryMask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === MASK_FIELDS.length && Object.keys(record).every(key => MASK_FIELDS.includes(key as typeof MASK_FIELDS[number])) &&
    typeof record.path === 'string' && printable(record.path) && posix.isAbsolute(record.path) && posix.normalize(record.path) === record.path &&
    MASK_FIELDS.slice(1).every(key => typeof record[key] === 'string' && /^[1-9]\d{0,31}$/u.test(record[key] as string));
}
function linuxRecoveryMaskPath(scope: 'system' | 'user'): string {
  if (scope === 'system') return '/etc/systemd/system/mdai-helper.service';
  const home = userInfo().homedir;
  if (!printable(home) || !posix.isAbsolute(home) || posix.normalize(home) !== home) throw linuxLockRetirementUnverified();
  return posix.join(home, '.config/systemd/user', `${SERVICE}.service`);
}
export function validateLinuxRecoveryMask(value: unknown, scope?: 'system' | 'user'): asserts value is LinuxRecoveryMask {
  if (!validLinuxRecoveryMask(value) || scope !== undefined && value.path !== linuxRecoveryMaskPath(scope)) throw linuxLockRetirementUnverified();
}
const sameMask = (a: LinuxRecoveryMask, b: LinuxRecoveryMask) => MASK_FIELDS.every(key => a[key] === b[key]);
async function inspectLinuxRecoveryMask(scope: 'system' | 'user', uid: number): Promise<LinuxRecoveryMask> {
  const path = linuxRecoveryMaskPath(scope), parent = posix.dirname(path), expectedOwner = BigInt(scope === 'system' ? 0 : uid);
  const ancestors = ['/', ...parent.split('/').filter(Boolean).map((_part, index, parts) => '/' + parts.slice(0, index + 1).join('/'))];
  const directories = new Map<string, BigIntStats>();
  for (const directory of ancestors) {
    const info = await lstat(directory, {bigint: true});
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022n) !== 0n ||
        (scope === 'system' ? info.uid !== 0n : info.uid !== 0n && info.uid !== expectedOwner) ||
        directory === parent && info.uid !== expectedOwner) throw linuxLockRetirementUnverified();
    directories.set(directory, info);
  }
  const before = await lstat(path, {bigint: true});
  if (!before.isSymbolicLink() || before.uid !== expectedOwner || before.nlink !== 1n || await readlink(path) !== '/dev/null') throw linuxLockRetirementUnverified();
  const after = await lstat(path, {bigint: true});
  if (!after.isSymbolicLink() || after.uid !== before.uid || after.nlink !== before.nlink || after.dev !== before.dev ||
      after.ino !== before.ino || after.ctimeNs !== before.ctimeNs || await readlink(path) !== '/dev/null') throw linuxLockRetirementUnverified();
  for (const [directory, beforeDirectory] of directories) {
    const afterDirectory = await lstat(directory, {bigint: true});
    if (!afterDirectory.isDirectory() || afterDirectory.isSymbolicLink() || afterDirectory.uid !== beforeDirectory.uid ||
        afterDirectory.mode !== beforeDirectory.mode || afterDirectory.dev !== beforeDirectory.dev || afterDirectory.ino !== beforeDirectory.ino ||
        afterDirectory.mtimeNs !== beforeDirectory.mtimeNs || afterDirectory.ctimeNs !== beforeDirectory.ctimeNs) throw linuxLockRetirementUnverified();
  }
  const owner = directories.get(parent)!;
  const mask = {path, dev: before.dev.toString(), ino: before.ino.toString(), ctimeNs: before.ctimeNs.toString(),
    parentDev: owner.dev.toString(), parentIno: owner.ino.toString(), parentMtimeNs: owner.mtimeNs.toString(), parentCtimeNs: owner.ctimeNs.toString()};
  validateLinuxRecoveryMask(mask, scope);
  return mask;
}
/** Observe only the fixed production and legacy entrypoints; never stop them. */
export async function verifyLinuxRecoveryEntrypoints(postBoot: boolean, options: RetirementOptions = {}): Promise<LinuxRecoveryEntrypoint[]> {
  const context = settings(options);
  if (context.platform !== 'linux' || typeof postBoot !== 'boolean') throw linuxLockRetirementUnverified();
  const observations: LinuxRecoveryEntrypoint[] = [];
  try {
    const maskFor = async (scope: 'system' | 'user') => {
      const mask = await (options.recoveryMask ? options.recoveryMask(scope) : inspectLinuxRecoveryMask(scope, context.uid));
      validateLinuxRecoveryMask(mask, scope); return {...mask};
    };
    const masks = {system: await maskFor('system'), user: await maskFor('user')};
    for (const scope of ['system', 'user'] as const) {
      const unit = scope === 'system' ? 'mdai-helper.service' : `${SERVICE}.service`;
      const args = scope === 'system' ? ['show', unit, `--property=${LINUX_RECOVERY_PROPERTIES}`] :
        ['--user', 'show', unit, `--property=${LINUX_RECOVERY_PROPERTIES}`, '--no-pager'];
      const env = scope === 'system' ? ENV : {...ENV, XDG_RUNTIME_DIR: `/run/user/${context.uid}`,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${context.uid}/bus`};
      const result = await context.runner('/usr/bin/systemctl', args, {env, timeout: 2000});
      if (result.stderr.trim() || !result.stdout.endsWith('\n') || result.stdout.length > 4096) throw linuxLockRetirementUnverified();
      const fields = new Map<string, string>(), names = LINUX_RECOVERY_PROPERTIES.split(',');
      for (const line of result.stdout.slice(0, -1).split('\n')) {
        const split = line.indexOf('='), key = line.slice(0, split), value = line.slice(split + 1);
        if (split < 1 || !names.includes(key) || fields.has(key)) throw linuxLockRetirementUnverified();
        fields.set(key, value);
      }
      const loadState = fields.get('LoadState'), unitFileState = fields.get('UnitFileState');
      const activeEnterTimestampMonotonic = fields.get('ActiveEnterTimestampMonotonic') ?? '';
      const inactiveExitTimestampMonotonic = fields.get('InactiveExitTimestampMonotonic') ?? '';
      if (fields.size !== names.length || fields.get('Id') !== unit || fields.get('ActiveState') !== 'inactive' ||
          fields.get('SubState') !== 'dead' || fields.get('MainPID') !== '0' ||
          loadState !== 'masked' || unitFileState !== 'masked' ||
          ![activeEnterTimestampMonotonic, inactiveExitTimestampMonotonic].every(value => /^(?:0|[1-9]\d*)$/u.test(value)) ||
          postBoot && (activeEnterTimestampMonotonic !== '0' || inactiveExitTimestampMonotonic !== '0')) {
        throw linuxLockRetirementUnverified();
      }
      observations.push({scope, unit, loadState: 'masked', activeState: 'inactive', subState: 'dead', unitFileState: 'masked', mainPid: 0,
        activeEnterTimestampMonotonic, inactiveExitTimestampMonotonic, mask: masks[scope]});
    }
    for (const scope of ['system', 'user'] as const) if (!sameMask(masks[scope], await maskFor(scope))) throw linuxLockRetirementUnverified();
    return observations;
  } catch { throw linuxLockRetirementUnverified(); }
}

async function captureLinux(options: RetirementOptions, context: ReturnType<typeof settings>): Promise<Retirement> {
  const boot = await linuxBoot(options), rows = await linuxRows(context, options, true);
  // A cohort captured across boots is incomplete evidence, not an empty cohort.
  if (await linuxBoot(options) !== boot) throw linuxLockRetirementUnverified();
  const processes: ProcessIdentity[] = [];
  for (const row of rows) {
    if (row.bootId !== boot) throw linuxLockRetirementUnverified();
    if (row.zombie) continue;
    const image = row.pid === context.pid ? process.execPath : row.exe;
    if (!image || !printable(image) || !posix.isAbsolute(image) || posix.normalize(image) !== image) throw linuxLockRetirementUnverified();
    // Linux has no sealed system roots. Only exact known native images qualify
    // for an exemption; arbitrary programs under /usr/libexec remain candidates.
    if (row.pid === context.pid || (!NO_HELPER_IMAGE.has(image) && !LINUX_NON_HOSTS.has(image))) {
      processes.push({pid: row.pid, started: row.startedAt, executable: image});
    }
  }
  return {boot, processes: processes.sort((a, b) => a.pid - b.pid)};
}

async function bootId(runner: Runner): Promise<string> {
  try {
    const result = await runner('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {env: ENV, timeout: 2000});
    if (result.stderr.trim()) throw busy();
    const value = result.stdout.trim();
    if (!BOOT.test(value)) throw busy();
    return value.toLowerCase();
  } catch { throw busy(); }
}

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function canonicalStart(value: string): string {
  const match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/u.exec(value);
  if (!match) throw busy();
  const [, weekday, month, day, hour, minute, second, year] = match;
  const date = new Date(Date.UTC(Number(year), months.indexOf(month), Number(day), Number(hour), Number(minute), Number(second)));
  if (Number(year) < 1970 || date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== months.indexOf(month) ||
      date.getUTCDate() !== Number(day) || date.getUTCHours() !== Number(hour) || date.getUTCMinutes() !== Number(minute) ||
      date.getUTCSeconds() !== Number(second) || weekdays[date.getUTCDay()] !== weekday) throw busy();
  return `${weekday} ${month} ${Number(day)} ${hour}:${minute}:${second} ${year}`;
}

interface ProcessRow {pid: number; started: string; zombie: boolean}
function parseTable(stdout: string, uid: number, ownPid: number): ProcessRow[] {
  // execFile rejects maxBuffer overflow. Requiring the final newline also rejects
  // a partial final row instead of accidentally interpreting it as disappearance.
  if (!stdout || !stdout.endsWith('\n') || stdout.length > 1024 * 1024) throw busy();
  // Do not request ps comm: Darwin derives it from mutable argv0.
  const seen = new Set<number>(), rows: ProcessRow[] = [];
  for (const line of stdout.slice(0, -1).split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+([IRSTUZ][+<>AELNSsVWX]*)\s+((?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+\S+\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*$/u.exec(line);
    if (!match) throw busy();
    const pid = Number(match[1]), user = Number(match[2]);
    if (!validPid(pid) || user !== uid || seen.has(pid)) throw busy();
    seen.add(pid);
    rows.push({pid, zombie: match[3].startsWith('Z'), started: canonicalStart(match[4])});
  }
  if (!rows.some(row => row.pid === ownPid && !row.zombie)) throw busy();
  return rows;
}

async function processTable(context: ReturnType<typeof settings>): Promise<ProcessRow[]> {
  try {
    // A single real-UID selector restricts Darwin's kernel query (KERN_PROC_RUID),
    // including processes without a terminal. Never collect all users then filter.
    const result = await context.runner('/bin/ps', ['-U', String(context.uid), '-o', 'pid=,ruid=,state=,lstart='], {env: ENV, timeout: 2000});
    if (result.stderr.trim()) throw busy();
    return parseTable(result.stdout, context.uid, context.pid);
  } catch { throw busy(); }
}

/** Call after every supported on-disk legacy launch root is patched/disabled. */
export async function captureRetirement(options: RetirementOptions = {}): Promise<Retirement> {
  const context = settings(options);
  if (context.platform === 'linux') return captureLinux(options, context);
  const boot = await bootId(context.runner);
  const rows = await processTable(context);
  // An unreaped zombie has exited even though Darwin retains its PID/start time.
  // Its executable path may already return ESRCH, so do not request an image.
  const owned = rows.filter(row => !row.zombie);
  let images: Map<number, string>;
  try { images = await (options.images ?? processImages)(owned.filter(row => row.pid !== context.pid).map(row => row.pid), context.runner, {platform: context.platform}); }
  catch { throw busy(); }
  // Bind every image to the captured real UID, start time and boot session before
  // retaining it. The user-filtered scan omits PIDs now owned by another user;
  // its parser also rejects any unexpected UID. A replaced lifetime has exited,
  // and its replacement's image must never enter the saved cohort.
  // Exec discards loaded modules; a later exec reads the patched launch roots.
  const verified = new Map((await processTable(context)).map(row => [row.pid, row]));
  if (await bootId(context.runner) !== boot) return {boot, processes: []};
  const processes: ProcessIdentity[] = [];
  for (const row of owned) {
    const current = verified.get(row.pid);
    if (!current || current.started !== row.started || current.zombie) continue;
    if (row.pid === context.pid) { processes.push({pid: row.pid, started: row.started, executable: process.execPath}); continue; }
    const image = images.get(row.pid);
    // ESRCH alone cannot retire an identity still live in the second scan.
    if (!image || !image.startsWith('/') || !printable(image)) throw busy();
    if (!isStockNonHostImage(image)) {
      processes.push({pid: row.pid, started: row.started, executable: image});
    }
  }
  return {boot, processes: processes.sort((a, b) => a.pid - b.pid)};
}

/** A new image/title does not prove a process discarded an imported module. */
export async function pendingRetirement(retirement: Retirement, options: RetirementOptions = {}): Promise<ProcessIdentity[]> {
  const context = settings(options);
  if (!BOOT.test(retirement.boot) || !Array.isArray(retirement.processes) || retirement.processes.some(row =>
    !row || !validPid(row.pid) || typeof row.started !== 'string' ||
    (context.platform === 'linux' ? !new RegExp(`^linux:${retirement.boot.toLowerCase()}:\\d+$`, 'u').test(row.started) : canonicalStart(row.started) !== row.started) ||
    typeof row.executable !== 'string' || !printable(row.executable)) ||
    new Set(retirement.processes.map(row => row.pid)).size !== retirement.processes.length) {
    throw context.platform === 'linux' ? linuxLockRetirementUnverified() : busy();
  }
  if (context.platform === 'linux') {
    if (await linuxBoot(options) !== retirement.boot.toLowerCase()) return [];
    const rows = await linuxRows(context, options);
    if (await linuxBoot(options) !== retirement.boot.toLowerCase()) return [];
    const live = new Map(rows.filter(row => !row.zombie).map(row => [row.pid, row.startedAt]));
    return retirement.processes.filter(row => live.get(row.pid) === row.started);
  }
  if (await bootId(context.runner) !== retirement.boot.toLowerCase()) return [];
  const rows = await processTable(context), live = new Map(rows.filter(row => !row.zombie).map(row => [row.pid, row.started]));
  // lstart has second precision. A PID reused in that same second remains busy,
  // which is conservative; a different start identity proves the old PID exited.
  return retirement.processes.filter(row => live.get(row.pid) === row.started);
}

function servicePid(stdout: string): number | undefined {
  if (!stdout.endsWith('\n') || stdout.length > 1024 * 1024) throw busy();
  const [header, ...lines] = stdout.slice(0, -1).split('\n');
  if (!/^PID\s+Status\s+Label$/u.test(header)) throw busy();
  const labels = new Set<string>();
  let result: number | undefined;
  for (const line of lines) {
    const match = /^(\d+|-)\s+(-?\d+|-)\s+(\S(?:.*\S)?)$/u.exec(line);
    if (!match) throw busy();
    const [, pid, status, label] = match;
    if ((pid !== '-' && !validPid(Number(pid))) || (status !== '-' && !Number.isSafeInteger(Number(status))) ||
        !printable(label) || labels.has(label)) throw busy();
    labels.add(label);
    if (label === SERVICE && pid !== '-') result = Number(pid);
  }
  return result;
}

/** Restart only our own launchd label, never a numeric PID or an AI tool. */
export async function restartLegacyService(pending: readonly ProcessIdentity[], options: RetirementOptions = {}): Promise<void> {
  const context = settings(options);
  if (!pending.some(row => row.pid !== context.pid)) return;
  if (context.platform === 'linux') {
    const unit = `${SERVICE}.service`, env = {...ENV, XDG_RUNTIME_DIR: `/run/user/${context.uid}`,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${context.uid}/bus`};
    const message = `The helper could not restart its background service. Run systemctl --user restart ${unit}, then retry the helper command.`;
    try {
      const result = await context.runner('/usr/bin/systemctl', ['--user', 'show', unit, '--property=Id,LoadState,MainPID', '--no-pager'], {env, timeout: 2000});
      if (result.stderr.trim() || !result.stdout.endsWith('\n') || result.stdout.length > 4096) throw busy();
      const fields = new Map<string, string>();
      for (const line of result.stdout.slice(0, -1).split('\n')) {
        const match = /^(Id|LoadState|MainPID)=(.*)$/u.exec(line);
        if (!match || fields.has(match[1])) throw busy();
        fields.set(match[1], match[2]);
      }
      if (fields.size !== 3 || fields.get('Id') !== unit || !['loaded', 'not-found'].includes(fields.get('LoadState') ?? '') ||
          !/^\d+$/u.test(fields.get('MainPID') ?? '') || !Number.isSafeInteger(Number(fields.get('MainPID')))) throw busy();
      const pid = Number(fields.get('MainPID'));
      if (fields.get('LoadState') === 'not-found') { if (pid !== 0) throw busy(); return; }
      if (pid === 0 || pid === context.pid || !pending.some(row => row.pid === pid)) return;
      const restarted = await context.runner('/usr/bin/systemctl', ['--user', 'restart', unit], {env, timeout: 10_000});
      if (restarted.stderr.trim()) throw busy();
    } catch { throw busy(message); }
    return;
  }
  const target = `gui/${context.uid}/${SERVICE}`;
  const message = `The helper could not restart its background service. Run launchctl kickstart -k ${target} in Terminal, then retry the helper command.`;
  let pid: number | undefined;
  try {
    // Bare list emits only PID, exit status and label. A label argument (or print)
    // would collect arguments/environment too. Legacy list uses the caller's
    // bootstrap domain, so verify it is this user's GUI (Aqua) domain first.
    // Root's legacy list targets the system domain even in an Aqua context.
    if (context.uid === 0) throw busy();
    const metadata = async (command: string) => {
      const result = await context.runner('/bin/launchctl', [command], {env: ENV, timeout: 2000});
      if (result.stderr.trim()) throw busy();
      return result.stdout;
    };
    if (await metadata('manageruid') !== `${context.uid}\n` || await metadata('managername') !== 'Aqua\n') throw busy();
    pid = servicePid(await metadata('list'));
  } catch { throw busy(message); }
  // Loaded but not running, or absent in a verified domain, has no old process.
  if (pid === undefined || pid === context.pid || !pending.some(row => row.pid === pid)) return;
  try {
    const result = await context.runner('/bin/launchctl', ['kickstart', '-k', target], {env: ENV, timeout: 10_000});
    if (result.stderr.trim()) throw busy();
  }
  catch { throw busy(message); }
}

export function formatRetirementMessage(pending: readonly ProcessIdentity[], ownPid = process.pid): string {
  const labels = pending.filter(row => row.pid !== ownPid).map(row => {
    const image = [...row.executable].map(value => isControl(value) ? '?' : value).join('');
    const name = posix.basename(image) || 'process';
    return `${name} (PID ${row.pid}) at ${image}`;
  });
  let message = 'The helper lock upgrade is waiting for old processes to finish. Wait for running helper commands, then retry.';
  if (labels.length) message += ` Quit and reopen the listed apps. For running commands, wait for them to finish or close their owning command terminal. Processes: ${labels.join(', ')}.`;
  if (pending.some(row => row.pid === ownPid)) message += ' Let this helper command finish, then retry it in a new process.';
  return message;
}
