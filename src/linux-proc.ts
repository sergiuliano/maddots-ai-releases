import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, openSync, opendirSync, readSync, statfsSync, statSync } from 'node:fs';
import { chmod, copyFile, mkdtemp, open, opendir, readlink, rm, stat, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, posix } from 'node:path';

export type LinuxProcCode = 'gone' | 'permission' | 'malformed' | 'race' | 'unavailable' | 'limit';
/** The error deliberately contains neither proc contents nor filesystem errors. */
export class LinuxProcError extends Error {
  readonly code: LinuxProcCode;
  constructor(code: LinuxProcCode) { super(`Linux process inspection: ${code}`); this.name = 'LinuxProcError'; this.code = code; }
}
export interface LinuxProcess {
  pid: number; ppid: number; pgid: number; sid: string; uid: number;
  state: string; zombie: boolean; bootId: string; startTicks: string; startedAt: string;
  exe?: string; cmdline?: string[]; fenceMatch?: boolean;
}
/** Observation only, never signal authority. Retain known roots after reparenting. */
export interface LinuxProcScope {
  pids?: readonly number[];
  pgids?: readonly number[];
  sids?: readonly string[];
}
export interface LinuxProcOptions {
  /** Fixture seam. Production callers use the kernel's /proc mount. */
  root?: string;
  uid?: number;
  timeoutMs?: number;
  deadline?: number;
  maxProcesses?: number;
  exe?: boolean;
  cmdline?: boolean;
  /** Only this exact MDAI_RUN_FENCE value is retained as a boolean. */
  fence?: string;
  /** Positive observations are never eligible for outsider exclusion. */
  observed?: LinuxProcScope;
  /** Only S3-contained workload observation may use cgroup outsider exclusion.
   * Generic fences, direct inspection and legacy module retirement stay strict. */
  contained?: true;
  /** Bounded fixture reads, never selected by argv or environment. */
  read?: (path: string, maximum: number) => Promise<Buffer>;
}
const BOOT = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const MAX_PID = 2_147_483_647;
const validPid = (value: number, minimum = 1) => Number.isSafeInteger(value) && value >= minimum && value <= MAX_PID;
const control = (value: string) => [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const fail = (code: LinuxProcCode): never => { throw new LinuxProcError(code); };
function normalizedError(error: unknown): LinuxProcError {
  if (error instanceof LinuxProcError) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  return new LinuxProcError(code === 'ENOENT' || code === 'ESRCH' ? 'gone' :
    code === 'EPERM' || code === 'EACCES' ? 'permission' : 'unavailable');
}
interface Context { root: string; uid: number; deadline: number; maxProcesses: number; read?: LinuxProcOptions['read'] }
function context(options: LinuxProcOptions): Context {
  const root = options.root ?? '/proc', uid = options.uid ?? process.getuid?.();
  const timeout = options.timeoutMs ?? 2000, maxProcesses = options.maxProcesses ?? 65_536;
  if (!isAbsolute(root) || uid === undefined || !Number.isSafeInteger(uid) || uid < 0 ||
    !Number.isSafeInteger(timeout) || timeout < 1 || !Number.isSafeInteger(maxProcesses) || maxProcesses < 1 ||
    (options.deadline !== undefined && !Number.isFinite(options.deadline)) ||
    (options.fence !== undefined && !/^[a-f0-9]{32}$/u.test(options.fence)) ||
    (options.contained !== undefined && (options.contained !== true || !options.observed)) ||
    (options.observed !== undefined && (![...(options.observed.pids ?? []), ...(options.observed.pgids ?? [])].every(value => validPid(value)) ||
      !(options.observed.sids ?? []).every(value => typeof value === 'string' && /^[1-9]\d*$/u.test(value) && validPid(Number(value))) ||
      ![...(options.observed.pids ?? []), ...(options.observed.pgids ?? []), ...(options.observed.sids ?? [])].length))) fail('malformed');
  return {root, uid: uid!, deadline: Math.min(Date.now() + timeout, options.deadline ?? Infinity), maxProcesses, read: options.read};
}
function checkDeadline(ctx: Context): void { if (Date.now() >= ctx.deadline) fail('limit'); }
async function boundedRead(path: string, maximum: number, ctx: Context, ptraceGate = false): Promise<Buffer> {
  checkDeadline(ctx);
  let file;
  let buffer: Buffer | undefined;
  try {
    if (ctx.read) {
      const bytes = await ctx.read(path, maximum).catch(error => {
        if (ptraceGate && normalizedError(error).code === 'permission') throw new OptionalAccessError();
        throw error;
      });
      checkDeadline(ctx);
      if (!Buffer.isBuffer(bytes)) return fail('malformed');
      if (bytes.length > maximum) return fail('limit');
      return bytes;
    }
    try { file = await open(path, 'r'); }
    catch (error) {
      if (ptraceGate && normalizedError(error).code === 'permission') throw new OptionalAccessError();
      throw error;
    }
    buffer = Buffer.alloc(Math.min(maximum + 1, 4096));
    let length = 0;
    for (;;) {
      checkDeadline(ctx);
      if (length > maximum) fail('limit');
      if (length === buffer.length) {
        const grown = Buffer.alloc(Math.min(maximum + 1, buffer.length * 2));
        buffer.copy(grown, 0, 0, length);
        buffer.fill(0);
        buffer = grown;
      }
      const read = await file.read(buffer, length, buffer.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    checkDeadline(ctx);
    if (length > maximum) fail('limit');
    return buffer.subarray(0, length);
  } catch (error) { buffer?.fill(0); throw normalizedError(error); }
  finally { await file?.close(); }
}
/** The final signal check cannot yield between reading proc metadata and signaling. */
function boundedReadSync(path: string, maximum: number, ctx: Context): Buffer {
  checkDeadline(ctx);
  let file: number | undefined;
  const buffer = Buffer.alloc(maximum + 1);
  try {
    file = openSync(path, 'r');
    let length = 0;
    for (;;) {
      checkDeadline(ctx);
      const count = readSync(file, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
      if (length > maximum) return fail('limit');
    }
    checkDeadline(ctx);
    return buffer.subarray(0, length);
  } catch (error) { buffer.fill(0); throw normalizedError(error); }
  finally { if (file !== undefined) closeSync(file); }
}
function decode(bytes: Buffer): string {
  try { return new TextDecoder('utf-8', {fatal: true}).decode(bytes); }
  catch { return fail('malformed'); }
}
async function boot(ctx: Context): Promise<string> {
  try {
    const record = decode(await boundedRead(join(ctx.root, 'sys/kernel/random/boot_id'), 64, ctx));
    const value = record.endsWith('\n') ? record.slice(0, -1) : record;
    if (!BOOT.test(value)) fail('malformed');
    return value.toLowerCase();
  } catch (error) {
    const failure = normalizedError(error);
    throw failure.code === 'gone' ? new LinuxProcError('unavailable') : failure;
  }
}
function bootSync(ctx: Context): string {
  try {
    const record = decode(boundedReadSync('/proc/sys/kernel/random/boot_id', 64, ctx));
    const value = record.endsWith('\n') ? record.slice(0, -1) : record;
    if (!BOOT.test(value)) return fail('malformed');
    return value.toLowerCase();
  } catch (error) {
    const failure = normalizedError(error);
    throw failure.code === 'gone' ? new LinuxProcError('unavailable') : failure;
  }
}
export function linuxProcessIdentityFrom(bootId: string, startTicks: string): string {
  if (!BOOT.test(bootId) || !/^(?:0|[1-9]\d{0,19})$/u.test(startTicks) || BigInt(startTicks) > 18_446_744_073_709_551_615n) fail('malformed');
  return `linux:${bootId.toLowerCase()}:${startTicks}`;
}
/** stat's comm is parenthesized and can itself contain spaces, newlines and ')'. */
export function parseLinuxProcStat(value: string, expectedPid?: number): Omit<LinuxProcess, 'uid' | 'bootId' | 'startedAt'> {
  const match = /^(\d+) \(([\s\S]*)\) ([RSDZTWtXxKIP]) (.*)\n?$/u.exec(value);
  if (!match || !value.endsWith('\n')) return fail('malformed');
  const pid = Number(match[1]), fields = match[4].trim().split(/\s+/u);
  if (!validPid(pid) || (expectedPid !== undefined && pid !== expectedPid) || fields.length < 49 ||
    fields.some(field => !/^-?\d+$/u.test(field))) return fail('malformed');
  // fields begin at kernel stat field 4; starttime is field 22.
  const ppid = Number(fields[0]), pgid = Number(fields[1]), sid = Number(fields[2]), startTicks = fields[18];
  if (!validPid(ppid, 0) || !validPid(pgid, 0) || !validPid(sid, 0)) return fail('malformed');
  linuxProcessIdentityFrom('00000000-0000-0000-0000-000000000000', startTicks);
  return {pid, ppid, pgid, sid: String(sid), state: match[3], zombie: /^[ZXx]$/u.test(match[3]), startTicks};
}
function realUid(value: string, pid: number): number {
  const users = [...value.matchAll(/^Uid:[ \t]+(\d+)[ \t]+(\d+)[ \t]+(\d+)[ \t]+(\d+)[ \t]*$/gmu)];
  const ids = [...value.matchAll(/^Pid:[ \t]+(\d+)[ \t]*$/gmu)];
  if (!value.endsWith('\n') || users.length !== 1 || ids.length !== 1 || Number(ids[0][1]) !== pid) return fail('malformed');
  const uid = Number(users[0][1]);
  if (!Number.isSafeInteger(uid) || uid < 0) return fail('malformed');
  return uid;
}
async function metadata(pid: number, ctx: Context): Promise<Omit<LinuxProcess, 'bootId' | 'startedAt'>> {
  const row = parseLinuxProcStat(decode(await boundedRead(join(ctx.root, String(pid), 'stat'), 64 * 1024, ctx)), pid);
  const uid = realUid(decode(await boundedRead(join(ctx.root, String(pid), 'status'), 64 * 1024, ctx)), pid);
  return {...row, uid};
}
function metadataSync(pid: number, ctx: Context): Omit<LinuxProcess, 'bootId' | 'startedAt'> {
  const uid = realUid(decode(boundedReadSync(`/proc/${pid}/status`, 64 * 1024, ctx)), pid);
  const row = parseLinuxProcStat(decode(boundedReadSync(`/proc/${pid}/stat`, 64 * 1024, ctx)), pid);
  return {...row, uid};
}
function processErrorSync(error: unknown, pid: number, ctx: Context, bootId: string): LinuxProcError {
  const failure = normalizedError(error);
  if (failure.code !== 'gone') return failure;
  try { statSync(`/proc/${pid}`); return new LinuxProcError('race'); }
  catch (probe) {
    const absence = normalizedError(probe);
    if (absence.code !== 'gone') return absence;
    try {
      checkDeadline(ctx);
      if (statfsSync('/proc').type !== 0x9fa0) return fail('unavailable');
      const directory = opendirSync('/proc');
      try { directory.readSync(); }
      finally { directory.closeSync(); }
      if (bootSync(ctx) !== bootId) return fail('unavailable');
      checkDeadline(ctx);
      return absence;
    } catch (outage) {
      const unavailable = normalizedError(outage);
      return unavailable.code === 'gone' ? new LinuxProcError('unavailable') : unavailable;
    }
  }
}
async function verifyDisappearance(ctx: Context, bootId: string): Promise<void> {
  checkDeadline(ctx);
  // Production must still be on procfs. Fixture roots deliberately use normal
  // directories so tests can model a mount disappearing during an inspection.
  if (ctx.root === '/proc' && (await statfs(ctx.root)).type !== 0x9fa0) fail('unavailable');
  const directory = await opendir(ctx.root);
  try { await directory.read(); }
  finally { await directory.close(); }
  if (await boot(ctx) !== bootId) fail('unavailable');
  checkDeadline(ctx);
}
async function processError(error: unknown, pid: number, ctx: Context, bootId: string): Promise<LinuxProcError> {
  const failure = normalizedError(error);
  if (failure.code !== 'gone') return failure;
  // A missing individual proc file is not disappearance when the PID's
  // directory still exists. Keep incomplete/replaced inspections fail closed.
  try { await stat(join(ctx.root, String(pid))); return new LinuxProcError('race'); }
  catch (probe) {
    const absence = normalizedError(probe);
    if (absence.code !== 'gone') return absence;
    // An unavailable/replaced mount can remove both files and the directory.
    // Only a readable proc mount from the original boot proves this PID exited.
    try { await verifyDisappearance(ctx, bootId); return absence; }
    catch (outage) {
      const unavailable = normalizedError(outage);
      return unavailable.code === 'gone' ? new LinuxProcError('unavailable') : unavailable;
    }
  }
}
async function image(pid: number, ctx: Context): Promise<{path: string; key: string}> {
  checkDeadline(ctx);
  const target = join(ctx.root, String(pid), 'exe');
  let value: string;
  try { value = await readlink(target); }
  catch (error) {
    // Only readlink is ptrace gated. A subsequent target stat can fail because
    // of ordinary filesystem permissions, which never qualifies for omission.
    if (normalizedError(error).code === 'permission') throw new OptionalAccessError();
    throw error;
  }
  const info = await stat(target, {bigint: true});
  checkDeadline(ctx);
  // A deleted executable still identifies the live kernel image. Preserve its
  // path for comparisons, removing only the kernel's informational suffix.
  const path = value.endsWith(' (deleted)') ? value.slice(0, -10) : value;
  if (!posix.isAbsolute(path) || posix.normalize(path) !== path || path === '/' || control(path) || Buffer.byteLength(path) >= 4096) fail('malformed');
  if (!info.isFile()) return fail('malformed');
  return {path, key: `${info.dev}:${info.ino}`};
}
class OptionalAccessError extends LinuxProcError {
  readonly row?: LinuxProcess;
  constructor(row?: LinuxProcess) { super('permission'); this.row = row; }
}
function sameProcess(a: Omit<LinuxProcess, 'bootId' | 'startedAt'>, b: Omit<LinuxProcess, 'bootId' | 'startedAt'>): boolean {
  return a.pid === b.pid && a.uid === b.uid && a.startTicks === b.startTicks && a.ppid === b.ppid &&
    a.pgid === b.pgid && a.sid === b.sid && a.zombie === b.zombie;
}
function nulEntries(bytes: Buffer): string[] {
  if (!bytes.length) return [];
  if (bytes[bytes.length - 1] !== 0) return fail('malformed');
  return decode(bytes.subarray(0, -1)).split('\u0000');
}
/** Returns only an exact entry comparison; other environment entries are never decoded. */
export function linuxFenceMatches(bytes: Buffer, fence: string): boolean {
  if (!/^[a-f0-9]{32}$/u.test(fence) || (bytes.length && bytes[bytes.length - 1] !== 0)) return fail('malformed');
  const expected = Buffer.from(`MDAI_RUN_FENCE=${fence}`);
  let matched = false, offset = 0;
  while (offset < bytes.length) {
    const end = bytes.indexOf(0, offset);
    if (end < 0) return fail('malformed');
    if (end - offset === expected.length && bytes.subarray(offset, end).equals(expected)) matched = true;
    offset = end + 1;
  }
  return matched;
}
async function optionalReadFailure(error: unknown, before: Omit<LinuxProcess, 'bootId' | 'startedAt'>,
  ctx: Context, bootId: string, fenceMatch?: boolean): Promise<LinuxProcess> {
  const failure = normalizedError(error);
  if (failure.code !== 'permission' && failure.code !== 'gone') throw failure;
  // The kernel can deny environ/exe access as a just-signalled task exits.
  // Accept only a positively observed exit of this exact UID and lifetime.
  const after = await metadata(before.pid, ctx);
  if (after.uid !== before.uid || after.startTicks !== before.startTicks) return fail('race');
  if (!after.zombie) {
    if (!sameProcess(before, after)) return fail('race');
    if (failure instanceof OptionalAccessError) throw new OptionalAccessError({...after, bootId, ...(fenceMatch ? {fenceMatch} : {}),
      startedAt: linuxProcessIdentityFrom(bootId, after.startTicks)});
    throw failure;
  }
  return {...after, bootId, startedAt: linuxProcessIdentityFrom(bootId, after.startTicks)};
}
async function inspect(pid: number, options: LinuxProcOptions, ctx: Context, bootId: string): Promise<LinuxProcess> {
  if (!validPid(pid)) return fail('malformed');
  try {
    const before = await metadata(pid, ctx);
    if (before.uid !== ctx.uid) return fail('permission');
    let exe: string | undefined, executableKey: string | undefined, cmdline: string[] | undefined, fenceMatch: boolean | undefined;
    if (!before.zombie) {
      try {
        // Preserve a positive fence even when a subsequent executable read is
        // denied. Such a row is observed and can never qualify as an outsider.
        if (options.fence !== undefined) {
          const bytes = await boundedRead(join(ctx.root, String(pid), 'environ'), 2 * 1024 * 1024, ctx, true);
          try { fenceMatch = linuxFenceMatches(bytes, options.fence); }
          finally { bytes.fill(0); }
        }
        if (options.exe) {
          const value = await image(pid, ctx); exe = value.path; executableKey = value.key;
        }
        if (options.cmdline) cmdline = nulEntries(await boundedRead(join(ctx.root, String(pid), 'cmdline'), 1024 * 1024, ctx));
      } catch (error) { return await optionalReadFailure(error, before, ctx, bootId, fenceMatch); }
    }
    const after = await metadata(pid, ctx);
    if (after.startTicks !== before.startTicks || after.uid !== before.uid || after.ppid !== before.ppid ||
      after.pgid !== before.pgid || after.sid !== before.sid || after.zombie !== before.zombie) return fail('race');
    if (options.exe && !after.zombie) {
      let current;
      try { current = await image(pid, ctx); }
      catch (error) { return await optionalReadFailure(error, before, ctx, bootId, fenceMatch); }
      if (current.path !== exe || current.key !== executableKey) return fail('race');
    }
    checkDeadline(ctx);
    return {...after, bootId, startedAt: linuxProcessIdentityFrom(bootId, after.startTicks),
      ...(exe !== undefined ? {exe} : {}), ...(cmdline !== undefined ? {cmdline} : {}),
      ...(fenceMatch !== undefined ? {fenceMatch} : {})};
  } catch (error) { throw await processError(error, pid, ctx, bootId); }
}
async function stableInspect(pid: number, options: LinuxProcOptions, ctx: Context, bootId: string): Promise<LinuxProcess> {
  for (let attempt = 0; ; attempt++) {
    try { return await inspect(pid, options, ctx, bootId); }
    catch (error) {
      // A retry may have seen this process inside the run before reparenting,
      // setsid or PID reuse. Never let a later denial erase that observation.
      if (error instanceof OptionalAccessError && attempt > 0) return fail('permission');
      if (!(error instanceof LinuxProcError) || error.code !== 'race' || attempt >= 2) throw error;
      checkDeadline(ctx);
    }
  }
}
export async function linuxBootId(options: LinuxProcOptions = {}): Promise<string> {
  try { return await boot(context(options)); } catch (error) { throw normalizedError(error); }
}
export async function inspectLinuxProcess(pid: number, options: LinuxProcOptions = {}): Promise<LinuxProcess> {
  const ctx = context(options);
  try {
    const bootId = await boot(ctx), row = await stableInspect(pid, options, ctx, bootId);
    if (await boot(ctx) !== bootId) return fail('race');
    return row;
  } catch (error) { throw normalizedError(error); }
}
/** Native final inspection: fixed proc mount, current real UID and no optional data. */
export function inspectLinuxProcessSync(pid: number, deadline?: number): LinuxProcess | null {
  if (!validPid(pid)) return fail('malformed');
  if (process.platform !== 'linux') return fail('unavailable');
  const ctx = context({deadline}), bootId = bootSync(ctx);
  try {
    const before = metadataSync(pid, ctx);
    if (before.uid !== ctx.uid) return fail('permission');
    if (bootSync(ctx) !== bootId) return fail('race');
    // Keep the final lifetime/group/session/parent observation after every
    // other proc read, directly before the gate validates and signals.
    const after = metadataSync(pid, ctx);
    if (after.startTicks !== before.startTicks || after.uid !== before.uid || after.ppid !== before.ppid ||
      after.pgid !== before.pgid || after.sid !== before.sid || after.zombie !== before.zombie) return fail('race');
    checkDeadline(ctx);
    return after.zombie ? null : {...after, bootId, startedAt: linuxProcessIdentityFrom(bootId, after.startTicks)};
  } catch (error) {
    const failure = processErrorSync(error, pid, ctx, bootId);
    if (failure.code === 'gone') return null;
    throw failure;
  }
}
export async function linuxProcessIdentity(pid: number, options: LinuxProcOptions = {}): Promise<string | null> {
  try { const row = await inspectLinuxProcess(pid, options); return row.zombie ? null : row.startedAt; }
  catch (error) { if (error instanceof LinuxProcError && error.code === 'gone') return null; throw error; }
}
// S3 fixes this entire service subtree, including launcher/controller bootstrap,
// previous owner namespaces and every run descendant. Do not narrow to a journal.
const HELPER_CGROUP = '/system.slice/mdai-helper.service';
// Linux reserves this initial namespace inode; dynamic namespace IDs start at
// 0xF0000000. Also published as CGROUP_NS_INIT_INO in linux/nsfs.h. Self access
// succeeds before ptrace credential checks, even for a non-dumpable caller.
// https://github.com/torvalds/linux/blob/v6.8/include/linux/proc_ns.h
// https://github.com/torvalds/linux/blob/v6.8/fs/proc/generic.c
const INITIAL_CGROUP_NAMESPACE = 'cgroup:[4026531835]';
interface ProcCredentials {
  users: number[]; groups: number[]; permitted: bigint; effective: bigint; bounding: bigint;
  pids: number[]; tgids: number[];
}
function credentials(value: string, expectedPid?: number): ProcCredentials {
  if (!value.endsWith('\n')) return fail('malformed');
  const field = (name: string): string => {
    const matches = [...value.matchAll(new RegExp(`^${name}:([^\\n]*)$`, 'gm'))];
    if (matches.length !== 1 || !/^[ \t]+[^\r\n]*$/u.test(matches[0][1])) return fail('malformed');
    return matches[0][1].replace(/^[ \t]+|[ \t]+$/gu, '');
  };
  const numbers = (name: string, count?: number): number[] => {
    const text = field(name);
    if (!/^\d+(?:[ \t]+\d+)*$/u.test(text)) return fail('malformed');
    const values = text.split(/[ \t]+/u).map(Number);
    if ((count !== undefined && values.length !== count) || values.some(value =>
      !Number.isSafeInteger(value) || value < 0 || value > 4_294_967_295)) return fail('malformed');
    return values;
  };
  const capability = (name: string): bigint => {
    const text = field(name);
    if (!/^[a-fA-F0-9]{16}$/u.test(text)) return fail('malformed');
    return BigInt(`0x${text}`);
  };
  const [pid] = numbers('Pid', 1), [tgid] = numbers('Tgid', 1);
  const pids = numbers('NSpid'), tgids = numbers('NStgid');
  if (!validPid(pid) || tgid !== pid || (expectedPid !== undefined && pid !== expectedPid) ||
    pids[0] !== pid || tgids[0] !== tgid || pids.length !== tgids.length ||
    pids.some((value, index) => !validPid(value) || value !== tgids[index])) return fail('malformed');
  const permitted = capability('CapPrm'), effective = capability('CapEff'), bounding = capability('CapBnd');
  if ((effective & ~permitted) !== 0n) return fail('malformed');
  return {users: numbers('Uid', 4), groups: numbers('Gid', 4), permitted, effective, bounding, pids, tgids};
}
async function unifiedCgroup(pid: string, ctx: Context): Promise<string> {
  const value = decode(await boundedRead(join(ctx.root, pid, 'cgroup'), 64 * 1024, ctx));
  // S3 requires unified v2. Hybrid/v1, partial, escaped/deleted, namespace-relative
  // and noncanonical records cannot prove nonmembership in the service subtree.
  const match = /^0::(\/[^\n]*)\n$/u.exec(value);
  if (!match || match[0] !== value || control(match[1]) || match[1].includes('\\') || match[1].endsWith(' (deleted)') ||
    (match[1] !== '/' && match[1].endsWith('/')) ||
    posix.normalize(match[1]) !== match[1] || match[1].split('/').some(part => part === '.' || part === '..')) return fail('malformed');
  return match[1];
}
/** World-readable target metadata proves location, never the reason ptrace denied it. */
async function containedOutsiderProof(row: LinuxProcess, ctx: Context): Promise<string | undefined> {
  if (ctx.root === '/proc' && (await statfs(ctx.root)).type !== 0x9fa0) return fail('unavailable');
  // Paths are rendered relative to the reader's cgroup namespace. PID 1 or a
  // leading slash alone cannot establish this view. Never inspect target ns/*.
  if (await readlink(join(ctx.root, 'self/ns/cgroup')) !== INITIAL_CGROUP_NAMESPACE) return undefined;
  const target = credentials(decode(await boundedRead(join(ctx.root, String(row.pid), 'status'), 64 * 1024, ctx)), row.pid);
  const caller = credentials(decode(await boundedRead(join(ctx.root, 'self/status'), 64 * 1024, ctx)));
  if (target.users[0] !== row.uid) return fail('race');
  if (!target.users.every(uid => uid === ctx.uid) || !caller.users.every(uid => uid === ctx.uid) ||
    (caller.effective & (1n << 19n)) !== 0n) return undefined;
  const cgroup = await unifiedCgroup(String(row.pid), ctx), ownCgroup = await unifiedCgroup('self', ctx);
  if (cgroup === HELPER_CGROUP || cgroup.startsWith(`${HELPER_CGROUP}/`)) return undefined;
  // These credentials are stability evidence only. Capabilities across unknown
  // user namespaces cannot prove ptrace denial or absence of an old JS host.
  return JSON.stringify({target, caller, cgroup, ownCgroup}, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value);
}
async function verifyRestrictedOutsiders(denied: LinuxProcess[], rows: LinuxProcess[], scope: LinuxProcScope,
  ctx: Context, bootId: string): Promise<void> {
  const table = new Map([...rows, ...denied].map(row => [row.pid, row]));
  const ancestors = new Set<number>();
  // Follow metadata through foreign-UID ancestors too. They expose no optional
  // data, but omitting them could hide a descendant through a setuid parent.
  for (const row of denied) {
    let current = row;
    const visited = new Set<number>();
    while (current.pid > 1) {
      checkDeadline(ctx);
      if (visited.has(current.pid)) return fail('malformed');
      visited.add(current.pid); ancestors.add(current.pid);
      if (current.ppid <= 1) break;
      let parent = table.get(current.ppid);
      if (!parent) {
        if (table.size >= ctx.maxProcesses) return fail('limit');
        const before = await metadata(current.ppid, ctx), after = await metadata(current.ppid, ctx);
        if (!sameProcess(before, after)) return fail('race');
        parent = {...after, bootId, startedAt: linuxProcessIdentityFrom(bootId, after.startTicks)};
        table.set(parent.pid, parent);
      }
      current = parent;
    }
  }
  const pids = new Set(scope.pids), groups = new Set(scope.pgids), sessions = new Set(scope.sids);
  // A readable matching fence is also positive observation evidence. Finish
  // the inventory before deciding, so a denied child preceding its parent in
  // readdir order cannot be silently excluded.
  for (const row of table.values()) if (row.fenceMatch) pids.add(row.pid);
  let changed = true;
  while (changed) {
    checkDeadline(ctx); changed = false;
    for (const row of table.values()) {
      if (!pids.has(row.pid) && !pids.has(row.ppid) && !groups.has(row.pgid) && !sessions.has(row.sid)) continue;
      if (!pids.has(row.pid)) { pids.add(row.pid); changed = true; }
      if (row.pgid > 0 && !groups.has(row.pgid)) { groups.add(row.pgid); changed = true; }
      if (Number(row.sid) > 0 && !sessions.has(row.sid)) { sessions.add(row.sid); changed = true; }
    }
  }
  const proofs = new Map<number, string>();
  for (const row of denied) {
    if (pids.has(row.pid)) return fail('permission');
    const proof = await containedOutsiderProof(row, ctx);
    if (!proof) return fail('permission');
    proofs.set(row.pid, proof);
  }
  // Bracket every exclusion and its ancestry/observation anchors. Identity,
  // parent, group or session changes invalidate the entire omission decision.
  for (const row of table.values()) if (ancestors.has(row.pid) || pids.has(row.pid)) {
    if (!sameProcess(row, await metadata(row.pid, ctx))) return fail('race');
  }
  for (const row of denied) {
    if (await containedOutsiderProof(row, ctx) !== proofs.get(row.pid) || !sameProcess(row, await metadata(row.pid, ctx))) return fail('race');
  }
}
export async function linuxProcessTable(options: LinuxProcOptions = {}): Promise<LinuxProcess[]> {
  const ctx = context(options);
  try {
    const bootId = await boot(ctx), directory = await opendir(ctx.root), pids: number[] = [];
    for await (const entry of directory) {
      checkDeadline(ctx);
      if (!/^[1-9]\d*$/u.test(entry.name)) continue;
      const pid = Number(entry.name);
      if (!validPid(pid) || pids.length >= ctx.maxProcesses) return fail('limit');
      pids.push(pid);
    }
    const rows: LinuxProcess[] = [], denied: LinuxProcess[] = [];
    for (const pid of pids) {
      checkDeadline(ctx);
      try {
        // Proc directory ownership is not real-UID or dumpability evidence.
        // Read only UID/PID metadata before
        // touching stat, executable, argv or environment of an owned process.
        const owner = realUid(decode(await boundedRead(join(ctx.root, String(pid), 'status'), 64 * 1024, ctx)), pid);
        if (owner !== ctx.uid) continue;
        rows.push(await stableInspect(pid, options, ctx, bootId));
      } catch (error) {
        if (options.contained && options.observed && error instanceof OptionalAccessError && error.row) {
          denied.push(error.row); continue;
        }
        const failure = await processError(error, pid, ctx, bootId);
        if (failure.code !== 'gone') throw failure;
      }
    }
    if (denied.length) await verifyRestrictedOutsiders(denied, rows, options.observed!, ctx, bootId);
    if (await boot(ctx) !== bootId) return fail('race');
    return rows;
  } catch (error) {
    const failure = normalizedError(error);
    // A missing proc mount is an outage, not evidence that every PID exited.
    throw failure.code === 'gone' ? new LinuxProcError('unavailable') : failure;
  }
}
export async function linuxFencePids(fence: string, deadline?: number, options: LinuxProcOptions = {}): Promise<number[]> {
  return (await linuxProcessTable({...options, fence, deadline: deadline ?? options.deadline})).filter(row =>
    !row.zombie && row.pid > 1 && row.pid !== process.pid && row.fenceMatch).map(row => row.pid);
}

/** QA must prove its observer sees long executable names before accepting silence. */
export async function verifyLinuxProcExecutable(
  inspect: (pid: number, options: LinuxProcOptions) => Promise<LinuxProcess | undefined> = inspectLinuxProcess,
  timeoutMs = 2500,
): Promise<void> {
  const {systemRuntimeMode, SystemRuntimeError} = await import('./system-runtime-preflight.js');
  if (systemRuntimeMode('')) throw new SystemRuntimeError('The fixed Linux system helper refuses the copied-Node QA observer.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) fail('malformed');
  const within = async <T>(operation: Promise<T>, timeout = timeoutMs): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new LinuxProcError('limit')), timeout);
      })]);
    } finally { clearTimeout(timer); }
  };
  const folder = await mkdtemp(join(tmpdir(), 'mdai-proc-control-'));
  const executable = join(folder, `mdai-proc-control-${randomBytes(8).toString('hex')}`);
  let child: ReturnType<typeof spawn> | undefined, exited: Promise<void> | undefined;
  let failure: LinuxProcError | undefined;
  try {
    await copyFile(process.execPath, executable);
    await chmod(executable, 0o700);
    // This fixed observer fixture executes no tool or user-supplied code.
    // Its only lifetime control is EOF on the fresh stdin pipe, so Linux
    // qualification does not borrow numeric cleanup authority from a PID.
    child = spawn(executable, ['-e', "process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); setTimeout(() => process.exit(0), 10000).unref()"],
      {env: {}, stdio: ['pipe', 'ignore', 'ignore']});
    exited = new Promise(resolve => { child!.once('exit', () => resolve()); child!.once('error', () => resolve()); });
    await within(new Promise<void>((resolve, reject) => { child!.once('spawn', resolve); child!.once('error', reject); }));
    // The control proves visibility of the child we own. A machine-wide scan
    // can fail on unrelated processes without saying anything about this image.
    const row = await within(inspect(child.pid!, {exe: true}));
    if (!row || row.pid !== child.pid || row.ppid !== process.pid || row.uid !== process.getuid?.() ||
      row.zombie || row.exe !== executable || row.startedAt !== linuxProcessIdentityFrom(row.bootId, row.startTicks)) fail('unavailable');
  } catch (error) { failure = normalizedError(error); }
  try {
    if (child && exited) {
      child.stdin?.end();
      await within(exited, 2000);
    }
  } catch (error) { failure ??= normalizedError(error); }
  try { await rm(folder, {recursive: true, force: true}); }
  catch (error) { failure ??= normalizedError(error); }
  if (failure) throw failure;
}
