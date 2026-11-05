import {constants as C, fstatSync, lstatSync, type Stats} from 'node:fs';
import {access, lstat, mkdir, open, readFile, readdir, realpath, rename, rmdir, statfs, unlink, type FileHandle} from 'node:fs/promises';
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {userInfo} from 'node:os';
import type {Duplex} from 'node:stream';
import {HelperError} from '../config.js';
import type {JournalContainmentBackend, JournalContainmentRegistration} from './journal.js';
import {LINUX_GUARDIAN, LINUX_INNER_LAUNCHER} from './linux-guardian.js';
import {registerContainmentSignalEndpoint, revokeContainmentSignalEndpoint, signalIfStillOwned, type ContainmentSignalEndpoint} from './signal-gate.js';
import {type LinuxSelectedLogin, completeSelectedLogin} from './linux-selected-login.js';
import {revalidateLinuxLocalProvider, type LinuxLocalProviderSpec} from './linux-local-provider.js';

export const LINUX_CONTAINMENT_PATHS = Object.freeze({
  unit: 'mdai-helper.service', root: '/sys/fs/cgroup/system.slice/mdai-helper.service',
  controller: '/sys/fs/cgroup/system.slice/mdai-helper.service/controller',
  runs: '/var/lib/mdai/runs', node: '/usr/local/libexec/mdai/node',
  bwrap: '/usr/local/libexec/mdai/bwrap', python: '/usr/bin/python3', pasta: '/usr/bin/pasta',
  trusted: '/usr/local/libexec/mdai', profile: 'mdai-helper-bwrap',
});
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const RELEASE_BINDING = /^[a-f0-9]{64}$/u;
const IDENTITY = /^[0-9]{1,24}:[0-9]{1,24}$/u;
const CGROUP2 = 0x63677270;
const identity = (info: {dev: number | bigint; ino: number | bigint}) => `${info.dev}:${info.ino}`;
const same = (a: JournalContainmentRegistration, b: JournalContainmentRegistration) =>
  a.backend === b.backend && a.namespaceId === b.namespaceId && a.name === b.name && a.objectIdentity === b.objectIdentity;
function unavailable(detail: string): never {throw new HelperError('LINUX_CONTAINMENT_UNAVAILABLE', `Linux run containment is unavailable: ${detail}.`);}
function requireThat(ok: unknown, detail: string): asserts ok {if (!ok) unavailable(detail);}

export type LinuxContainmentContext = Readonly<{
  directoryIdentity: string; bootId: string; ownerEpoch: string;
  /** Exclusive retained owner, independent of the caller's admission generation. */
  isCurrent(): boolean;
  /** Complete registration inventory from verified same-boot journal replay. */
  registrations?: readonly JournalContainmentRegistration[];
  /** Only registrations whose CLEAN record has a durable acknowledged head. */
  completedRegistrations?: readonly JournalContainmentRegistration[];
}>;
export type LinuxContainmentRequest = {
  incarnation: string; file: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv;
  /** Digest of the immutable exact operation mapping, including this incarnation. */
  releaseBinding: string;
  /** Consumed synchronously immediately before trusted bootstrap spawn. */
  admitLauncher(): boolean;
  /** Only this run's explicitly selected credentials. Never a host home/config bind. */
  credentials?: Readonly<Record<string, string>>;
  selectedLogin?: Readonly<{tool: 'codex' | 'claude'; profilePath: string}>;
  /** Controller-prevalidated lease, retained from before durable INTENT. */
  preparedLogin?: LinuxSelectedLogin;
  /** Closed provider snapshot, included in the immutable RELEASE binding. */
  provider?: LinuxLocalProviderSpec;
  /** Retain cleanup authority before publishing INTENT or attempting bootstrap. */
  onReserved?: (run: LinuxRecoveredRun) => Promise<void>;
  /** Trusted preparation only. Must create ordinary files/directories, never sockets or symlinks. */
  prepareWork?: (workPath: string) => Promise<void>;
};
export type LinuxContainmentRelease = Readonly<{
  binding: string; incarnation: string;
  /** Linux CLOCK_MONOTONIC nanoseconds, from the controller's process.hrtime.bigint(). */
  notAfterMonotonicNs: string;
}>;
function validRelease(release: LinuxContainmentRelease, binding: string, incarnation: string): boolean {
  return !!release && Object.keys(release).sort().join(',') === 'binding,incarnation,notAfterMonotonicNs' &&
    release.binding === binding && release.incarnation === incarnation &&
    typeof release.notAfterMonotonicNs === 'string' && /^[1-9][0-9]{0,18}$/u.test(release.notAfterMonotonicNs) &&
    BigInt(release.notAfterMonotonicNs) <= 9223372036854775807n && process.hrtime.bigint() < BigInt(release.notAfterMonotonicNs);
}
export interface LinuxRecoveredRun {
  readonly registration: JournalContainmentRegistration;
  seal(): void;
  term(): Promise<void>;
  forceKill(): Promise<void>;
  empty(): Promise<boolean>;
  completionProof(): Promise<unknown>;
  /** Available only after selected-login completion; never returns secrets. */
  assertPublicContent?(content: Buffer | string): void;
  retire(isDurablyClean: () => boolean): Promise<void>;
}
export interface LinuxContainedRun extends LinuxRecoveredRun {
  readonly child: ChildProcessWithoutNullStreams;
  readonly ready: Promise<void>;
  start(release: LinuxContainmentRelease): boolean;
}
export interface LinuxContainmentBackend extends JournalContainmentBackend {
  readonly namespaceId: string;
  /** No executable is launched by qualification. Recovery never needs it. */
  qualifyAdmission?(): Promise<void>;
  reserve(request: LinuxContainmentRequest): Promise<LinuxContainedRun>;
  /** Only a reserved object for which no INTENT was attempted and no spawn began. */
  discardUnlaunched?(run: LinuxRecoveredRun): Promise<void>;
  /** Caller must obtain this registration from intact, same-boot journal replay. */
  reopen(registration: JournalContainmentRegistration): Promise<LinuxRecoveredRun>;
  /** Crash housekeeping after durable CLEAN, never a new signaling capability. */
  retireCompleted(registration: JournalContainmentRegistration): Promise<void>;
  close(): Promise<void>;
}

/** Small OS seam for fault fixtures. Production always constructs NativeNamespace. */
export interface LinuxContainmentObject {
  readonly registration: JournalContainmentRegistration;
  readonly workPath: string;
  assertCurrent(): Promise<void>;
  spawn(request: LinuxContainmentRequest): Promise<{
    child: ChildProcessWithoutNullStreams; ready: Promise<void>; start(release: LinuxContainmentRelease): boolean; seal(): void; term(): Promise<void>;
    /** Resolves only when the original trusted launcher cannot enter the run later. */
    admissionClosed(): boolean;
  }>;
  forceKill(): Promise<void>;
  empty(): Promise<boolean>;
  prepareCompletion?(assertExtinct: () => Promise<void>): Promise<void>;
  assertPublicContent?(content: Buffer | string): void;
  retire(): Promise<void>;
}
export interface LinuxContainmentNamespace {
  readonly namespaceId: string;
  assertCurrent(): Promise<void>;
  qualifyAdmission?(): Promise<void>;
  reserve(request: LinuxContainmentRequest): Promise<LinuxContainmentObject>;
  reopen(registration: JournalContainmentRegistration): Promise<LinuxContainmentObject>;
  retireCompleted?(registration: JournalContainmentRegistration): Promise<void>;
  close?(): Promise<void>;
}

/**
 * Model state and proof identity are shared with deterministic fault fixtures.
 * No registration fields, caller booleans, process scan or serialized proof can
 * manufacture completion. Actual production endpoints come only from NativeNamespace.
 */
export function containmentBackendForNamespace(context: LinuxContainmentContext, namespace: LinuxContainmentNamespace): LinuxContainmentBackend {
  const runs = new Map<string, {object: LinuxContainmentObject; run: LinuxRecoveredRun; sealed: boolean; retired: boolean;
    live?: Awaited<ReturnType<LinuxContainmentObject['spawn']>>; spawning?: boolean; proof?: object}>();
  let closed = false;
  const proofs = new WeakMap<object, {object: LinuxContainmentObject; registration: JournalContainmentRegistration}>();
  const current = async () => {requireThat(!closed, 'namespace capability is closed'); requireThat(context.isCurrent(), 'exclusive owner was revoked'); await namespace.assertCurrent();};
  async function wrap(object: LinuxContainmentObject, live?: Awaited<ReturnType<LinuxContainmentObject['spawn']>>, binding?: string): Promise<LinuxRecoveredRun> {
    const registration = Object.freeze({...object.registration});
    requireThat(registration.namespaceId === namespace.namespaceId && registration.backend === 'linux-cgroup-v2' &&
      /^run-[a-f0-9-]+$/u.test(registration.name) && IDENTITY.test(registration.objectIdentity), 'invalid retained registration');
    const state = {object, sealed: !live, retired: false, live, run: undefined as unknown as LinuxRecoveredRun, proof: undefined as object | undefined};
    const valid = async () => {await current(); requireThat(!state.retired, 'retired capability'); await object.assertCurrent();};
    const signalCurrent = () => {requireThat(!closed && context.isCurrent(), 'exclusive owner was revoked'); requireThat(!state.retired, 'retired capability');};
    const run: LinuxRecoveredRun = {
      registration,
      seal() {state.sealed = true; state.proof = undefined; live?.seal();},
      // Durable storage failure blocks further admission and completion, but
      // cannot revoke this still-owned original kernel/channel capability.
      async term() {run.seal(); signalCurrent(); await live?.term();},
      async forceKill() {run.seal(); signalCurrent(); await object.forceKill();},
      async empty() {await valid(); return state.sealed && (!live || live.admissionClosed()) && await object.empty();},
      async completionProof() {
        requireThat(await run.empty(), 'sealed registered run is not empty');
        await valid();
        await object.prepareCompletion?.(async () => {requireThat(await run.empty(), 'sealed registered run is not empty');});
        requireThat(await run.empty(), 'registered run changed during completion preparation');
        const proof = Object.freeze({admissionSealed: true, populated: 0, objectIdentity: registration.objectIdentity});
        proofs.set(proof, {object, registration}); state.proof = proof; return proof;
      },
      assertPublicContent(content) {
        requireThat(state.proof && object.assertPublicContent, 'selected login completion is not proven');
        object.assertPublicContent(content);
      },
      async retire(isDurablyClean) {
        await valid();
        requireThat(isDurablyClean() && state.proof && await run.empty(), 'durable CLEAN and retained empty proof are required');
        requireThat(isDurablyClean(), 'durable retirement permission was revoked');
        await object.retire(); state.retired = true; runs.delete(registration.name);
      },
    };
    if (live) Object.assign(run, {child: live.child, ready: live.ready,
      start(release: LinuxContainmentRelease) {
        if (!context.isCurrent() || state.sealed || state.retired) return false;
        if (!binding || !validRelease(release, binding, registration.name.slice(4))) {run.seal(); return false;}
        return live.start(Object.freeze({...release}));
      }});
    state.run = Object.freeze(run); runs.set(registration.name, state); return state.run;
  }
  return Object.freeze({
    namespaceId: namespace.namespaceId,
    async qualifyAdmission() {await current(); await namespace.qualifyAdmission?.();},
    async close() {requireThat(runs.size === 0, 'unresolved run capabilities must remain retained'); await namespace.close?.(); closed = true;},
    async reserve(request: LinuxContainmentRequest) {
      await current(); requireThat(UUID.test(request.incarnation), 'invalid incarnation');
      requireThat(RELEASE_BINDING.test(request.releaseBinding), 'invalid release binding');
      const binding = request.releaseBinding;
      requireThat(!runs.has(`run-${request.incarnation}`), 'incarnation already reserved');
      await namespace.qualifyAdmission?.();
      const object = await namespace.reserve(request);
      // Publish the retained cleanup endpoint before INTENT or any staging and
      // bootstrap work. A failed spawn still has a provable retirement path.
      const retained = await wrap(object);
      await request.onReserved?.(retained);
      await current();
      runs.get(object.registration.name)!.spawning = true;
      const live = await object.spawn(request);
      return await wrap(object, live, binding) as LinuxContainedRun;
    },
    async discardUnlaunched(run: LinuxRecoveredRun) {
      await current();
      const held = runs.get(run.registration.name);
      requireThat(held?.run === run && !held.live && !held.spawning && !held.retired, 'reservation may already have launched');
      run.seal();
      requireThat(await run.empty(), 'unlaunched reservation is not empty');
      await run.completionProof();
      await held.object.retire(); held.retired = true; runs.delete(run.registration.name);
    },
    async reopen(registration: JournalContainmentRegistration) {
      await current();
      requireThat(registration.namespaceId === namespace.namespaceId, 'protected namespace continuity is missing');
      const retained = runs.get(registration.name);
      if (retained) {requireThat(same(retained.object.registration, registration), 'registration changed'); retained.run.seal(); return retained.run;}
      return wrap(await namespace.reopen(registration));
    },
    async retireCompleted(registration: JournalContainmentRegistration) {
      await current();
      requireThat(context.completedRegistrations?.some(completed => same(completed, registration)), 'durable CLEAN provenance is required for housekeeping');
      requireThat(namespace.retireCompleted, 'completed-run housekeeping is unavailable');
      await namespace.retireCompleted(registration);
    },
    async verifyRegistration(registration: JournalContainmentRegistration) {
      try {
        await current(); const retained = runs.get(registration.name);
        if (!retained || retained.retired || !same(retained.object.registration, registration)) return false;
        await retained.object.assertCurrent(); return true;
      } catch {return false;}
    },
    async verifyCompletion(registration: JournalContainmentRegistration, proof: unknown) {
      try {
        await current(); const retained = runs.get(registration.name);
        if (!proof || typeof proof !== 'object' || !retained || retained.proof !== proof) return false;
        const held = proofs.get(proof);
        return !!held && held.object === retained.object && same(held.registration, registration) && await retained.run.empty();
      } catch {return false;}
    },
  });
}

type NamespaceReceipt = {format: 1; namespaceId: string; directoryIdentity: string; bootId: string;
  rootIdentity: string; namespaceIdentity: string};
async function privateDirectory(path: string, uid: number): Promise<void> {
  requireThat(await realpath(path) === path, `${path} is not canonical`);
  const info = await lstat(path);
  requireThat(info.isDirectory() && info.uid === uid && (info.mode & 0o777) === 0o700, `${path} must be owned mode 0700`);
}
async function trustedSource(path: string, directory = false): Promise<void> {
  const canonical = await realpath(path), info = await lstat(canonical);
  requireThat((directory ? info.isDirectory() : info.isFile()) && info.uid === 0 && !(info.mode & 0o6022), `${path} is not a trusted root-owned source`);
  for (let parent = dirname(canonical); parent !== '/'; parent = dirname(parent)) {
    const ancestor = await lstat(parent);
    requireThat(ancestor.isDirectory() && ancestor.uid === 0 && !(ancestor.mode & 0o022), `${path} has an untrusted ancestor`);
  }
  if (!directory) await access(canonical, C.R_OK);
}

/** Metadata-only qualification of the exact read-only runtime mounts. A
 * read-only bind still exposes sockets and nested mounts, and therefore cannot
 * itself establish this boundary. Root administrator changes remain trusted;
 * every descendant is inaccessible for modification by an unprivileged UID. */
export type LinuxRuntimeTreeIO = {
  lstat(path: string): Promise<Stats>;
  readdir(path: string): Promise<string[]>;
  realpath(path: string): Promise<string>;
  mountInfo(): Promise<string>;
};
const runtimeTreeIO: LinuxRuntimeTreeIO = {lstat, readdir, realpath,
  mountInfo: () => readFile('/proc/self/mountinfo', 'utf8')};
const runtimeMounts = ['/usr', '/etc/ssl/certs'] as const;
export async function qualifyLinuxRuntimeMounts(io: LinuxRuntimeTreeIO = runtimeTreeIO): Promise<string> {
  const inside = (root: string, path: string) => path === root || path.startsWith(root === '/' ? '/' : root + '/');
  const decode = (value: string) => value.replace(/\\([0-7]{3})/gu, (_match, digits: string) => String.fromCharCode(parseInt(digits, 8)));
  const mountInfo = await io.mountInfo();
  requireThat(mountInfo.length > 0 && mountInfo.length < 4 * 1024 * 1024, 'runtime mount inventory is unavailable');
  const mounts = mountInfo.trim().split('\n').map(line => {
    const [before, after, ...extra] = line.split(' - '), fields = before.split(' ');
    requireThat(!extra.length && fields.length >= 6 && after, 'runtime mount inventory is malformed');
    const type = after.split(' ')[0], path = decode(fields[4]);
    requireThat(path.startsWith('/') && !path.includes('\0') && type, 'runtime mount inventory is malformed');
    return {path, type};
  });
  for (const root of runtimeMounts) {
    requireThat(await io.realpath(root) === root, 'runtime mount is not canonical');
    requireThat(!mounts.some(mount => mount.path !== root && inside(root, mount.path)), 'runtime contains a nested mount');
    const covering = mounts.filter(mount => inside(mount.path, root)).sort((a, b) => b.path.length - a.path.length)[0];
    requireThat(covering && !/^(?:proc|sysfs|cgroup2?|devtmpfs|devpts|securityfs|debugfs|tracefs|bpf|fusectl|mqueue|nsfs|sockfs)$/u.test(covering.type),
      'runtime uses an unsupported management filesystem');
  }
  let entries = 0;
  const deadline = Date.now() + 120_000;
  const stamp = (info: Stats) => `${identity(info)}:${info.uid}:${info.mode}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  const pending = runtimeMounts.map(path => ({path: String(path), depth: 0}));
  const directories: {path: string; before: string}[] = [];
  const inspect = async ({path, depth}: {path: string; depth: number}): Promise<void> => {
    requireThat(++entries <= 1_000_000 && depth <= 128 && Date.now() < deadline, 'runtime qualification limit exceeded');
    const info = await io.lstat(path);
    requireThat(info.uid === 0, `runtime contains an untrusted owner at ${path}`);
    // A link is resolved inside the sandbox root. For example an installed
    // /usr/lib/ssl link into the absent /etc/ssl/private is inert, and must
    // never cause us to traverse that host directory during qualification.
    // Every target that is actually host-mounted is independently traversed.
    if (!info.isSymbolicLink()) {
      requireThat((info.isDirectory() || info.isFile()) && !(info.mode & 0o022), `runtime contains a writable or special object at ${path}`);
      if (info.isDirectory()) {
        const names = await io.readdir(path);
        requireThat(pending.length + names.length <= 1_000_000, 'runtime qualification limit exceeded');
        for (const name of names) {
          requireThat(name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\0'), 'runtime entry is invalid');
          pending.push({path: join(path, name), depth: depth + 1});
        }
        directories.push({path, before: stamp(info)});
      }
    }
    requireThat(stamp(await io.lstat(path)) === stamp(info), 'runtime changed during qualification');
  };
  // At most 32 filesystem inspections are outstanding, including deep trees.
  for (let offset = 0; offset < pending.length;) {
    const batch = pending.slice(offset, offset + 32);
    await Promise.all(batch.map(inspect)); offset += batch.length;
  }
  for (let offset = 0; offset < directories.length; offset += 32) {
    await Promise.all(directories.slice(offset, offset + 32).map(async ({path, before}) => {
      requireThat(Date.now() < deadline && stamp(await io.lstat(path)) === before, 'runtime changed during qualification');
    }));
  }
  requireThat(await io.mountInfo() === mountInfo, 'runtime mount inventory changed during qualification');
  return mountInfo;
}
async function privateFile(path: string, uid: number, limit: number): Promise<string> {
  const file = await open(path, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
  try {
    const info = await file.stat();
    requireThat(info.isFile() && info.nlink === 1 && info.uid === uid && (info.mode & 0o777) === 0o600 && info.size <= limit, 'unsafe protected receipt');
    return await file.readFile('utf8');
  } finally {await file.close();}
}
async function writePrivate(path: string, content: string): Promise<void> {
  const file = await open(path, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
  try {await file.writeFile(content); await file.sync();} finally {await file.close();}
  const directory = await open(dirname(path), C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
  try {await directory.sync();} finally {await directory.close();}
}
function inWork(work: string, path: string): boolean {return path === work || path.startsWith(work + '/');}
async function safeWorkTree(path: string, budget = {entries: 0}): Promise<void> {
  for (const entry of await readdir(path, {withFileTypes: true})) {
    requireThat(++budget.entries < 100_000 && (entry.isDirectory() || entry.isFile()), 'workspace contains an unsupported object');
    const target = join(path, entry.name), info = await lstat(target);
    requireThat(!info.isSymbolicLink() && (info.isDirectory() || info.isFile() && info.nlink === 1), 'workspace contains aliases');
    if (entry.isDirectory()) await safeWorkTree(target, budget);
  }
}
const grokImportFlags = new Set([
  ...['CLAUDE', 'CURSOR', 'CODEX'].flatMap(source => ['MCPS', 'SKILLS', 'RULES', 'AGENTS', 'HOOKS', 'SESSIONS'].map(kind => `GROK_${source}_${kind}_ENABLED`)),
  'GROK_MANAGED_MCPS_ENABLED', 'GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED',
]);
export function cleanLinuxToolEnvironment(source: NodeJS.ProcessEnv, workPath: string): Record<string, string> {
  const result: Record<string, string> = {PATH: '/usr/local/libexec/mdai:/usr/local/bin:/usr/bin:/bin', HOME: '/tmp/home',
    TMPDIR: '/tmp', XDG_CONFIG_HOME: '/tmp/home/.config', XDG_CACHE_HOME: '/tmp/home/.cache', XDG_DATA_HOME: '/tmp/home/.local/share'};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (['PATH', 'HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'].includes(key)) continue;
    const grokFlag = grokImportFlags.has(key);
    requireThat((key === 'DISABLE_AUTOUPDATER' && value === '1' || grokFlag && value === 'false' || /^(?:LANG|LC_ALL|LC_CTYPE|LC_TIME|TZ|TERM|NO_COLOR|CI|MDAI_RUN_FENCE|MADDOTS_AI_RUN_[A-Z_]+|CODEX_HOME|CLAUDE_CONFIG_DIR|ENABLE_CLAUDEAI_MCP_SERVERS|CURSOR_CLI_BLOCK_CURSOR_AGENT|GROK_DISABLE_AUTOUPDATER|GEMINI_CLI_[A-Z_]+|DSH_[A-Z_]+|OPENCODE_[A-Z_]+)$/u.test(key)) &&
      !/TOKEN|SECRET|KEY|SOCK|PROXY|OPTIONS|PRELOAD|LIBRARY/u.test(key), `environment setting ${key} is not approved`);
    requireThat(!value.includes('\0') && (key !== 'MDAI_RUN_FENCE' || /^[a-f0-9]{32}$/u.test(value)), 'invalid environment value');
    result[key] = value.replaceAll(workPath, '/work');
  }
  return result;
}
function credentialValues(value: LinuxContainmentRequest['credentials']): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, content] of Object.entries(value ?? {})) {
    requireThat(/^(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|DEEPSEEK_API_KEY|OPENROUTER_API_KEY|GOOGLE_API_KEY|GEMINI_API_KEY|CODEX_API_KEY)$/u.test(key) &&
      typeof content === 'string' && !content.includes('\0') && content.length <= 65536, 'unsupported run credential');
    result[key] = content;
  }
  return result;
}

export function linuxSandboxArguments(workPath: string, dataPath: string): string[] {
  const incarnation = dataPath.slice(LINUX_CONTAINMENT_PATHS.runs.length + 1);
  requireThat(UUID.test(incarnation) && dataPath === `${LINUX_CONTAINMENT_PATHS.runs}/${incarnation}` &&
    workPath === `${dataPath}/work`, 'sandbox mount source is outside the private run allowlist');
  return ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-net', '--unshare-uts', '--unshare-cgroup',
    '--disable-userns', '--assert-userns-disabled', '--cap-drop', 'ALL', '--clearenv',
    '--ro-bind', '/usr', '/usr', '--ro-bind', LINUX_CONTAINMENT_PATHS.trusted, LINUX_CONTAINMENT_PATHS.trusted,
    '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/tmp/home',
    '--dir', '/etc', '--ro-bind', '/etc/ssl/certs', '/etc/ssl/certs',
    '--ro-bind', join(dataPath, 'resolv.conf'), '/etc/resolv.conf',
    '--ro-bind', join(dataPath, 'passwd'), '/etc/passwd', '--ro-bind', join(dataPath, 'group'), '/etc/group',
    '--ro-bind', join(dataPath, 'launch.json'), '/etc/mdai-launch.json',
    '--ro-bind', join(dataPath, 'credentials.json'), '/etc/mdai-credentials.json',
    '--bind', workPath, '/work', '--chdir', '/work', '--remount-ro', '/',
    '--', LINUX_CONTAINMENT_PATHS.python, '-I', '-S', '-c', LINUX_INNER_LAUNCHER];
}

async function retainedEmpty(events: FileHandle): Promise<boolean> {
  const bytes = Buffer.alloc(4096), {bytesRead} = await events.read(bytes, 0, bytes.length, 0);
  const value = bytes.toString('utf8', 0, bytesRead), matches = [...value.matchAll(/^populated ([01])$/gm)];
  requireThat(matches.length === 1 && bytesRead < bytes.length, 'malformed registered cgroup.events');
  return matches[0][1] === '0';
}

export const LINUX_PROVIDER_CGROUP_LIMITS = Object.freeze({
  'cpu.max': '1600000 100000', 'memory.max': '25000000000', 'memory.swap.max': '0', 'memory.oom.group': '1',
});
/** Descriptor-backed in production; a data-only seam permits synthetic denial
 * and readback tests without creating or modifying any host cgroup. */
export async function configureLinuxProviderResources(io: {
  read(name: string): Promise<string>; write(name: string, value: string): Promise<void>;
}): Promise<void> {
  let controllers: string[];
  try {controllers = (await io.read('cgroup.controllers')).trim().split(/\s+/u);}
  catch {unavailable('Ollama requires founder-provisioned CPU and memory controller delegation');}
  requireThat(['cpu', 'memory'].every(controller => controllers.includes(controller)),
    'Ollama requires founder-provisioned CPU and memory controller delegation and hierarchy enablement');
  for (const [name, expected] of Object.entries(LINUX_PROVIDER_CGROUP_LIMITS)) {
    try {
      await io.write(name, expected);
      requireThat((await io.read(name)).trim() === expected, `Ollama resource limit ${name} readback failed`);
    } catch (error) {
      if (error instanceof HelperError) throw error;
      unavailable(`Ollama resource limit ${name} is unavailable; founder CPU and memory delegation is required`);
    }
  }
}
export function linuxProviderOomCount(value: string): bigint {
  requireThat(value.length < 4096, 'Ollama memory.events exceeded its bound');
  const fields = new Map<string, bigint>();
  for (const line of value.trim().split('\n')) {
    const match = /^([a-z_]+) ([0-9]+)$/u.exec(line);
    requireThat(match && !fields.has(match[1]), 'Ollama memory.events is malformed');
    fields.set(match[1], BigInt(match[2]));
  }
  requireThat(fields.has('oom') && fields.has('oom_kill') && fields.has('oom_group_kill'), 'Ollama OOM accounting is unavailable');
  return fields.get('oom')! + fields.get('oom_kill')! + fields.get('oom_group_kill')!;
}
async function removePrivateTree(parent: FileHandle, name: string, budget = {entries: 0}, depth = 0): Promise<void> {
  requireThat(++budget.entries <= 100_000 && depth <= 128 && name !== '.' && name !== '..' && !name.includes('/'), 'private credential cleanup limit exceeded');
  const path = `/proc/self/fd/${parent.fd}/${name}`;
  let info;
  try {info = await lstat(path);} catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error;}
  if (info.isDirectory()) {
    const child = await open(path, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
    try {for (const entry of await readdir(`/proc/self/fd/${child.fd}`)) await removePrivateTree(child, entry, budget, depth + 1);}
    finally {await child.close();}
    await rmdir(path);
  } else await unlink(path); // A workload-created symlink is removed, never traversed.
}
async function cleanRunCredentials(dataPath: string, uid: number): Promise<void> {
  await privateDirectory(dataPath, uid);
  const data = await open(dataPath, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
  try {
    for (const name of ['credentials.json', 'launch.json', 'resolv.conf', 'passwd', 'group']) {
      await unlink(`/proc/self/fd/${data.fd}/${name}`).catch(error => {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;});
    }
    const work = await open(`/proc/self/fd/${data.fd}/work`, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
    try {await removePrivateTree(work, '.mdai-home'); await work.sync();} finally {await work.close();}
    await data.sync();
  } finally {await data.close();}
}

class NativeNamespace implements LinuxContainmentNamespace {
  readonly namespaceId: string;
  private readonly objects = new Map<string, NativeObject>();
  private readonly known = new Map<string, JournalContainmentRegistration>();
  private closed = false;
  private readonly retainedFd: number;
  private admission?: Promise<void>;
  private runtimeMountInfo?: string;
  private providerRun?: string;
  private operations: Promise<void> = Promise.resolve();
  constructor(readonly context: LinuxContainmentContext, readonly receipt: NamespaceReceipt,
    readonly receiptPath: string, readonly directory: FileHandle, readonly path: string, readonly uid: number) {
    this.namespaceId = receipt.namespaceId;
    this.retainedFd = directory.fd;
    for (const registration of context.registrations ?? []) {
      requireThat(registration.namespaceId === this.namespaceId && /^run-[a-f0-9-]+$/u.test(registration.name) &&
        UUID.test(registration.name.slice(4)) && IDENTITY.test(registration.objectIdentity), 'journal namespace registration is inconsistent');
      const prior = this.known.get(registration.name);
      requireThat(!prior || same(prior, registration), 'ambiguous namespace registration');
      this.known.set(registration.name, Object.freeze({...registration}));
    }
  }
  signalCurrent(): boolean {
    try {return !this.closed && this.context.isCurrent() && this.directory.fd === this.retainedFd &&
      identity(fstatSync(this.retainedFd)) === this.receipt.namespaceIdentity &&
      identity(lstatSync(this.path)) === this.receipt.namespaceIdentity &&
      identity(lstatSync(LINUX_CONTAINMENT_PATHS.root)) === this.receipt.rootIdentity;}
    catch {return false;}
  }
  async qualifyAdmission(): Promise<void> {
    requireThat(this.signalCurrent(), 'exclusive namespace capability is unavailable');
    this.admission ??= (async () => {
      const paths = LINUX_CONTAINMENT_PATHS;
      for (const path of [paths.node, paths.bwrap, paths.python, paths.pasta]) {await trustedSource(path); await access(path, C.X_OK);}
      await trustedSource(paths.trusted, true); await trustedSource('/usr', true); await trustedSource('/etc/ssl/certs', true);
      await trustedSource('/etc/apparmor.d/' + paths.profile);
      this.runtimeMountInfo = await qualifyLinuxRuntimeMounts();
    })();
    await this.admission;
    requireThat(await readFile('/proc/self/mountinfo', 'utf8') === this.runtimeMountInfo, 'runtime mounts changed after qualification');
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation);
    // A failed operation leaves its physical objects subject to the same
    // fail-closed inventory check. It must not strand later validations.
    this.operations = result.then(() => {}, () => {});
    return result;
  }
  close(): Promise<void> {return this.exclusive(async () => {
    requireThat([...this.objects.values()].every(object => object.disposed), 'unresolved native endpoints must remain retained');
    if (!this.closed) {await this.directory.close(); this.closed = true;}
  });}
  assertCurrent(): Promise<void> {return this.exclusive(() => this.validateCurrent());}
  private async validateCurrent(): Promise<void> {
    requireThat(!this.closed, 'native namespace is closed');
    requireThat(this.context.isCurrent(), 'exclusive owner was revoked');
    requireThat(identity(await this.directory.stat()) === this.receipt.namespaceIdentity && identity(await lstat(this.path)) === this.receipt.namespaceIdentity,
      'protected namespace was removed or replaced');
    requireThat(identity(await lstat(LINUX_CONTAINMENT_PATHS.root)) === this.receipt.rootIdentity &&
      (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() === this.context.bootId,
    'service namespace or boot changed');
    requireThat(await privateFile(this.receiptPath, this.uid, 4096) === JSON.stringify(this.receipt) + '\n', 'protected namespace receipt changed');
    for (const entry of await readdir(this.path, {withFileTypes: true})) if (entry.isDirectory()) {
      const registration = this.known.get(entry.name);
      requireThat(registration && identity(await lstat(join(this.path, entry.name))) === registration.objectIdentity, 'unregistered or replaced object in protected namespace');
    }
  }
  reserve(request: LinuxContainmentRequest): Promise<LinuxContainmentObject> {return this.exclusive(async () => {
    await this.validateCurrent(); await this.qualifyAdmission();
    requireThat(!this.providerRun && (!request.provider || [...this.objects.values()].every(object => object.disposed)),
      'Ollama requires an exclusive run until joint retirement');
    const name = `run-${request.incarnation}`, data = join(LINUX_CONTAINMENT_PATHS.runs, request.incarnation);
    // The private directory is a durable tombstone, retained even after CLEAN.
    // EEXIST never authorizes reopening or reusing an incarnation.
    await mkdir(data, {mode: 0o700});
    const parent = await open(LINUX_CONTAINMENT_PATHS.runs, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
    try {await parent.sync();} finally {await parent.close();}
    await writePrivate(join(data, 'incarnation.json'), JSON.stringify({format: 1, namespaceId: this.namespaceId, incarnation: request.incarnation}) + '\n');
    await mkdir(join(data, 'work'), {mode: 0o700});
    const path = join(this.path, name);
    await mkdir(path);
    // No launcher has received a migration descriptor at this point. If open
    // fails, remove only the exact newly created, still-empty cgroup so a
    // rejected reservation cannot poison the namespace inventory.
    const created = identity(await lstat(path));
    try {
      const object = await NativeObject.open(this, name, data);
      this.known.set(name, object.registration);
      this.objects.set(name, object);
      if (request.provider) this.providerRun = name;
      return object;
    } catch (error) {
      requireThat(identity(await lstat(path)) === created, 'failed reservation object was replaced');
      const events = await open(join(path, 'cgroup.events'), C.O_RDONLY | C.O_NOFOLLOW);
      try {requireThat(await retainedEmpty(events), 'failed reservation became populated'); await rmdir(path);}
      finally {await events.close();}
      throw error;
    }
  });}
  retireCompleted(registration: JournalContainmentRegistration): Promise<void> {return this.exclusive(async () => {
    await this.validateCurrent();
    requireThat(this.context.completedRegistrations?.some(completed => same(completed, registration)) &&
      this.known.has(registration.name), 'durable CLEAN provenance is required for housekeeping');
    const data = join(LINUX_CONTAINMENT_PATHS.runs, registration.name.slice(4));
    await privateDirectory(data, this.uid);
    requireThat(await privateFile(join(data, 'incarnation.json'), this.uid, 4096) === JSON.stringify({format: 1,
      namespaceId: this.namespaceId, incarnation: registration.name.slice(4)}) + '\n', 'completed run tombstone changed');
    let directory: FileHandle | undefined, events: FileHandle | undefined;
    const path = join(this.path, registration.name);
    try {
      try {directory = await open(path, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);}
      catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
      if (directory) {
        requireThat(identity(await directory.stat()) === registration.objectIdentity &&
          identity(await lstat(path)) === registration.objectIdentity, 'completed run object was replaced');
        events = await open(join(path, 'cgroup.events'), C.O_RDONLY | C.O_NOFOLLOW);
        requireThat(await retainedEmpty(events), 'completed run became populated');
      }
      // No writable migration or signal endpoint is opened by this path.
      // Durable CLEAN already follows selected-login disposal. A later
      // founder rotation must not make completed-run housekeeping reopen the
      // profile or replay an old credential transaction.
      await cleanRunCredentials(data, this.uid);
      if (directory) {
        requireThat(await retainedEmpty(events!), 'completed run became populated');
        await rmdir(path);
      }
    } finally {await events?.close(); await directory?.close();}
  });}
  reopen(registration: JournalContainmentRegistration): Promise<LinuxContainmentObject> {return this.exclusive(async () => {
    await this.validateCurrent();
    requireThat(registration.namespaceId === this.namespaceId && /^run-[a-f0-9-]+$/u.test(registration.name) &&
      UUID.test(registration.name.slice(4)) && IDENTITY.test(registration.objectIdentity), 'invalid replay registration');
    const retained = this.objects.get(registration.name);
    if (retained) {requireThat(same(retained.registration, registration), 'retained registration changed'); return retained;}
    const data = join(LINUX_CONTAINMENT_PATHS.runs, registration.name.slice(4));
    await privateDirectory(data, this.uid);
    requireThat(await privateFile(join(data, 'incarnation.json'), this.uid, 4096) === JSON.stringify({format: 1,
      namespaceId: this.namespaceId, incarnation: registration.name.slice(4)}) + '\n', 'run tombstone continuity is missing');
    const object = await NativeObject.open(this, registration.name, data);
    requireThat(same(object.registration, registration), 'registered cgroup was removed or replaced');
    this.objects.set(registration.name, object); return object;
  });}
  retireObject(object: NativeObject): Promise<void> {return this.exclusive(async () => {
    await this.validateCurrent();
    requireThat(this.objects.get(object.name) === object, 'native object is not retained');
    await object.retireCurrent();
    if (this.providerRun === object.name) this.providerRun = undefined;
  });}
}

class NativeObject implements LinuxContainmentObject {
  readonly registration: JournalContainmentRegistration;
  readonly workPath: string;
  private retired = false;
  private spawned = false;
  private selectedLogin?: LinuxSelectedLogin;
  private completionPrepared = false;
  private memoryEvents?: FileHandle;
  private oomBaseline = 0n;
  private finishResourceMonitoring?: () => Promise<void>;
  private endpoint: ContainmentSignalEndpoint;
  get disposed(): boolean {return this.retired;}
  private constructor(readonly namespace: NativeNamespace, readonly name: string, readonly data: string,
    readonly directory: FileHandle, readonly procs: FileHandle, readonly killFile: FileHandle, readonly events: FileHandle, objectIdentity: string) {
    this.registration = Object.freeze({backend: 'linux-cgroup-v2', namespaceId: namespace.namespaceId, name, objectIdentity});
    this.workPath = join(data, 'work');
    const killFd = killFile.fd, killIdentity = identity(fstatSync(killFd)), directoryFd = directory.fd;
    this.endpoint = registerContainmentSignalEndpoint(killFd, () => {
      if (this.retired || !namespace.signalCurrent()) return false;
      try {return killFile.fd === killFd && identity(fstatSync(killFd)) === killIdentity && directory.fd === directoryFd &&
        identity(fstatSync(directoryFd)) === objectIdentity && identity(lstatSync(join(namespace.path, name))) === objectIdentity;}
      catch {return false;}
    });
  }
  static async open(namespace: NativeNamespace, name: string, data: string): Promise<NativeObject> {
    const path = join(namespace.path, name), handles: FileHandle[] = [];
    try {
      const directory = await open(path, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW); handles.push(directory);
      const info = await directory.stat();
      requireThat(info.uid === namespace.uid && (await statfs(path)).type === CGROUP2 &&
        (await readFile(join(path, 'cgroup.type'), 'utf8')).trim() === 'domain', 'run is not a delegated domain cgroup');
      const procs = await open(join(path, 'cgroup.procs'), C.O_WRONLY | C.O_NOFOLLOW); handles.push(procs);
      const kill = await open(join(path, 'cgroup.kill'), C.O_WRONLY | C.O_NOFOLLOW); handles.push(kill);
      const events = await open(join(path, 'cgroup.events'), C.O_RDONLY | C.O_NOFOLLOW); handles.push(events);
      return new NativeObject(namespace, name, data, directory, procs, kill, events, identity(info));
    } catch (error) {for (const handle of handles) await handle.close(); throw error;}
  }
  async assertCurrent(): Promise<void> {
    await this.namespace.assertCurrent(); requireThat(!this.retired, 'run already retired');
    requireThat(identity(await this.directory.stat()) === this.registration.objectIdentity &&
      identity(await lstat(join(this.namespace.path, this.name))) === this.registration.objectIdentity, 'registered run object changed');
  }
  async spawn(request: LinuxContainmentRequest): Promise<Awaited<ReturnType<LinuxContainmentObject['spawn']>>> {
    const binding = request.releaseBinding, incarnation = request.incarnation;
    const selection = request.selectedLogin && Object.freeze({...request.selectedLogin});
    requireThat(RELEASE_BINDING.test(binding) && this.name === `run-${incarnation}`, 'invalid release binding or incarnation');
    await this.assertCurrent(); requireThat(!this.spawned && await this.empty(), 'run already admitted'); this.spawned = true;
    if (request.provider) {
      await revalidateLinuxLocalProvider(request.provider);
      const path = `/proc/self/fd/${this.directory.fd}`;
      await configureLinuxProviderResources({
        read: async name => {
          const file = await open(`${path}/${name}`, C.O_RDONLY | C.O_NOFOLLOW);
          try {return await file.readFile('utf8');} finally {await file.close();}
        },
        write: async (name, value) => {
          const file = await open(`${path}/${name}`, C.O_WRONLY | C.O_NOFOLLOW);
          try {await file.writeFile(value);} finally {await file.close();}
        },
      });
      this.memoryEvents = await open(`${path}/memory.events`, C.O_RDONLY | C.O_NOFOLLOW);
      this.oomBaseline = await this.providerOomCount();
    }
    await request.prepareWork?.(this.workPath);
    if (selection) {
      requireThat(!request.credentials && request.env[selection.tool === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] ===
        `/work/.mdai-home/${selection.tool}`, 'selected login transport does not match the tool home');
      requireThat(request.preparedLogin, 'selected login was not prevalidated');
      this.selectedLogin = request.preparedLogin;
      await this.selectedLogin.stage(this.workPath, this.data);
    }
    await privateDirectory(this.workPath, this.namespace.uid); await safeWorkTree(this.workPath);
    const cwd = (request.cwd === '/work' || request.cwd.startsWith('/work/')) && resolve(request.cwd) === request.cwd ? request.cwd :
      inWork(this.workPath, resolve(request.cwd)) ? '/work' + resolve(request.cwd).slice(this.workPath.length) : null;
    requireThat(cwd, 'workspace must be inside the private run work directory');
    requireThat(isAbsolute(request.file), 'tool executable must be absolute');
    const hostFile = request.file.startsWith('/work/') ? this.workPath + request.file.slice(5) : request.file;
    const canonical = await realpath(hostFile);
    const workExecutable = inWork(this.workPath, canonical);
    requireThat((workExecutable || canonical.startsWith('/usr/')) && (await lstat(canonical)).isFile(), 'tool executable is outside the approved runtime or work directory');
    if (!workExecutable) await trustedSource(canonical);
    else requireThat(canonical === hostFile, 'workspace executable aliases are refused');
    await access(canonical, C.X_OK);
    const file = workExecutable ? '/work' + canonical.slice(this.workPath.length) : canonical;
    const args = request.args.map(argument => {requireThat(!argument.includes('\0'), 'invalid tool argument'); return argument.replaceAll(this.workPath, '/work');});
    const launch = {file, args, cwd, env: cleanLinuxToolEnvironment(request.env, this.workPath),
      ...(request.provider ? {provider: request.provider} : {}),
      ...(selection ? {selectedLogin: selection.tool} : {})};
    await writePrivate(join(this.data, 'launch.json'), JSON.stringify(launch) + '\n');
    await writePrivate(join(this.data, 'credentials.json'), JSON.stringify(credentialValues(request.credentials)) + '\n');
    await writePrivate(join(this.data, 'resolv.conf'), 'nameserver 169.254.1.1\noptions timeout:2 attempts:2\n');
    await writePrivate(join(this.data, 'passwd'), `mdai:x:${this.namespace.uid}:${process.getgid?.()}:run:/tmp/home:/usr/sbin/nologin\n`);
    await writePrivate(join(this.data, 'group'), `mdai:x:${process.getgid?.()}:\n`);
    await this.namespace.qualifyAdmission();
    await this.assertCurrent();
    if (request.provider) await revalidateLinuxLocalProvider(request.provider);
    requireThat(request.admitLauncher(), 'durable launcher permission was revoked');
    const child = spawn(LINUX_CONTAINMENT_PATHS.python, ['-I', '-S', '-c', LINUX_GUARDIAN,
      relative('/sys/fs/cgroup', join(this.namespace.path, this.name)).replace(/^/u, '/'),
      LINUX_CONTAINMENT_PATHS.bwrap, JSON.stringify(linuxSandboxArguments(this.workPath, this.data)), LINUX_CONTAINMENT_PATHS.pasta,
      JSON.stringify({binding, incarnation})],
    {cwd: '/', env: {}, detached: true, stdio: ['pipe', 'pipe', 'pipe', this.procs.fd, 'pipe']}) as ChildProcessWithoutNullStreams;
    const control = child.stdio[4] as Duplex;
    let ready = false, started = false, sealed = false, sealAcknowledged = false, dead = false, exitReceived = false, error: Error | undefined;
    let terminationAcknowledged = false, channelCompleted = false;
    let resolveReady!: () => void, rejectReady!: (error: Error) => void;
    const readiness = new Promise<void>((resolve, reject) => {resolveReady = resolve; rejectReady = reject;});
    readiness.catch(() => {});
    const fail = (failure: Error) => {
      if (error) return;
      error = failure; sealed = true; rejectReady(error);
      // Once ready, rejecting the readiness promise alone cannot wake the
      // workload owner. Every channel/provider/resource failure stays terminal.
      child.emit('message', {type: 'tool-error'}); send('SEAL');
    };
    let buffer = '';
    const send = (command: string): boolean => {
      if (dead || control.destroyed || !control.writable) return false;
      try {control.write(command + '\n'); return true;} catch {return false;}
    };
    const timer = setTimeout(() => {fail(new Error('guardian readiness timed out')); send('SEAL');}, 15_000);
    timer.unref();
    let checkingMemory: Promise<void> | undefined, statusTimer: ReturnType<typeof setTimeout> | undefined;
    const checkMemory = () => this.providerOomCount().then(count => {
      if (count !== this.oomBaseline) fail(new Error('Ollama cgroup OOM is terminal'));
    }, () => fail(new Error('Ollama OOM accounting failed')));
    const memoryTimer = this.memoryEvents ? setInterval(() => {
      if (checkingMemory || dead || error) return;
      checkingMemory = checkMemory().finally(() => {checkingMemory = undefined;});
    }, 50) : undefined;
    memoryTimer?.unref();
    this.finishResourceMonitoring = async () => {
      clearInterval(memoryTimer);
      await checkingMemory;
      // Extinction makes this final sample stable. Join any earlier read before
      // sampling again or allowing retirement to close the retained descriptor.
      if (this.memoryEvents) await checkMemory();
    };
    const clearTimers = () => {clearTimeout(timer); clearTimeout(statusTimer); clearInterval(memoryTimer);};
    child.once('error', failure => {dead = true; clearTimers(); fail(failure);});
    child.once('exit', () => {dead = true; clearTimers(); if (!ready) fail(new Error('guardian exited before readiness'));});
    // Node closes the child after its stdio streams. A destroyed private stream
    // can close without EOF or an error, so check positive completion before
    // the process owner's subsequently registered close handler can finish.
    child.once('close', () => {if (!channelCompleted) fail(new Error('guardian private channel incomplete'));});
    control.on('error', failure => {fail(failure);});
    control.on('end', () => {
      // Process exit and socket EOF are independent notifications. Require the
      // workload status and complete TERM acknowledgement even when Node has
      // already reaped the guardian. Its exit code cannot stand in for either
      // frame, and no partial final frame may be accepted as clean teardown.
      if (!exitReceived || !terminationAcknowledged || buffer) fail(new Error('guardian private channel closed'));
      else if (!error) channelCompleted = true;
    });
    control.on('data', (bytes: Buffer) => {
      buffer += bytes.toString('utf8');
      if (buffer.length > 16384) {fail(new Error('guardian response exceeded limit')); send('SEAL'); return;}
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        try {
          const event = JSON.parse(line) as {event?: string; code?: number | null; signal?: string | null};
          if (event.event === 'ready' && !ready && !sealed) {ready = true; clearTimeout(timer); resolveReady();}
          else if (event.event === 'started' && started && !sealed) child.emit('message', {type: 'tool-start', pid: child.pid});
          else if (event.event === 'sealed' || event.event === 'terminated') {
            sealed = true; sealAcknowledged = true;
            if (event.event === 'terminated') {
              terminationAcknowledged = true; child.emit('message', {type: 'guardian-terminated'});
            }
          }
          else if (event.event === 'exit') {
            if (!(Number.isInteger(event.code) && event.code! >= 0 && event.signal === null ||
                event.code === null && typeof event.signal === 'string' && event.signal.length > 0)) {
              throw new Error('invalid guardian workload status');
            }
            if (!exitReceived) {
              exitReceived = true; sealed = true; sealAcknowledged = true; clearTimeout(statusTimer);
              child.emit('message', {type: 'tool-exit', code: event.code, signal: event.signal});
            }
          }
          else if (event.event === 'provider-ready' && request.provider && started && !sealed) {
            child.emit('message', {type: 'provider-ready'});
          }
          else if (event.event === 'workload-exited' && request.provider && started) {
            // The monitor stops its surviving provider, allowing bwrap to
            // report the original task's authoritative status. A stuck wrapper
            // cannot keep this run alive indefinitely after the task exits.
            // Frames can arrive in either order, and repeated notifications
            // must neither restart this bound nor replace a received status.
            if (!exitReceived && !statusTimer) {
              statusTimer = setTimeout(() => fail(new Error('Ollama workload exit status timed out')), 1000);
              statusTimer.unref();
            }
          }
          else if (event.event === 'provider-failed' || event.event === 'provider-monitor-failed') fail(new Error('Ollama provider or trusted monitor failed'));
          else if (event.event === 'tool-error' || event.event === 'exec-error') {sealed = true; sealAcknowledged = true; child.emit('message', {type: event.event});}
          else if (event.event === 'network-failed') {fail(new Error('workload network bridge failed')); child.emit('message', {type: 'tool-exit', code: 125, signal: null});}
          else throw new Error('unexpected guardian response');
        } catch (failure) {fail(failure instanceof Error ? failure : new Error('invalid guardian response')); send('SEAL');}
      }
    });
    return {child, ready: readiness,
      start(release) {
        if (!ready || started || sealed || dead || error) return false;
        // Consume before writing. Failed or ambiguous sends can never be retried.
        started = true;
        if (!validRelease(release, binding, incarnation)) {sealed = true; send('SEAL'); return false;}
        if (!send(JSON.stringify({type: 'START', version: 1, ...release}))) {sealed = true; send('SEAL'); return false;}
        return true;
      },
      seal() {if (!sealed) {sealed = true; send('SEAL');} else if (!sealAcknowledged) send('SEAL');},
      async term() {sealed = true; send('TERM');},
      admissionClosed() {return dead || sealAcknowledged;},
    };
  }
  async forceKill(): Promise<void> {
    requireThat((await signalIfStillOwned({kind: 'containment', endpoint: this.endpoint}, 'SIGKILL')).status === 'sent', 'retained containment endpoint was refused');
  }
  private async providerOomCount(): Promise<bigint> {
    requireThat(this.memoryEvents, 'Ollama OOM accounting descriptor is unavailable');
    const bytes = Buffer.alloc(4096), {bytesRead} = await this.memoryEvents.read(bytes, 0, bytes.length, 0);
    requireThat(bytesRead < bytes.length, 'Ollama memory.events exceeded its bound');
    return linuxProviderOomCount(bytes.toString('utf8', 0, bytesRead));
  }
  async empty(): Promise<boolean> {
    await this.assertCurrent();
    return retainedEmpty(this.events);
  }
  async prepareCompletion(assertExtinct: () => Promise<void>): Promise<void> {
    await assertExtinct();
    await this.assertCurrent(); requireThat(await this.empty(), 'registered run remains populated');
    await this.finishResourceMonitoring?.();
    try {
      if (this.selectedLogin) await this.selectedLogin.complete(assertExtinct);
      else this.selectedLogin = await completeSelectedLogin(this.data, this.namespace.uid, assertExtinct);
    } catch (error) {
      // Recovery can reopen the private stage snapshot after an I/O failure.
      // Never retain a failed descriptor or consult the mutable workload cache.
      try {await this.selectedLogin?.close();} finally {this.selectedLogin = undefined;}
      throw error;
    }
    await cleanRunCredentials(this.data, this.namespace.uid);
    this.completionPrepared = true;
  }
  assertPublicContent(content: Buffer | string): void {
    requireThat(this.completionPrepared && this.selectedLogin, 'selected login completion is unavailable');
    this.selectedLogin.assertPublicContent(content);
  }
  async retire(): Promise<void> {
    await this.namespace.retireObject(this);
  }
  /** Called only while the namespace mutation/validation queue is held. */
  async retireCurrent(): Promise<void> {
    requireThat(this.completionPrepared, 'credential disposal must precede retirement');
    requireThat(!this.retired && identity(await this.directory.stat()) === this.registration.objectIdentity &&
      identity(await lstat(join(this.namespace.path, this.name))) === this.registration.objectIdentity, 'registered run object changed');
    requireThat(await retainedEmpty(this.events), 'registered run remains populated');
    await cleanRunCredentials(this.data, this.namespace.uid);
    requireThat(await retainedEmpty(this.events), 'registered run remains populated');
    await this.selectedLogin?.close();
    await this.memoryEvents?.close(); this.memoryEvents = undefined;
    await rmdir(join(this.namespace.path, this.name));
    this.retired = true; revokeContainmentSignalEndpoint(this.endpoint);
    for (const file of [this.procs, this.killFile, this.events, this.directory]) await file.close();
  }
}

/** Never creates or repairs the S2 journal manifest. Missing provisioning fails closed. */
export async function createLinuxContainmentBackend(context: LinuxContainmentContext): Promise<LinuxContainmentBackend> {
  requireThat(process.platform === 'linux' && process.getuid?.() === 999 && userInfo().username === 'mdai', 'the dedicated mdai UID 999 system service is required');
  requireThat(IDENTITY.test(context.directoryIdentity) && UUID.test(context.bootId) && UUID.test(context.ownerEpoch) && context.isCurrent(), 'invalid exclusive owner context');
  const paths = LINUX_CONTAINMENT_PATHS, uid = process.getuid!();
  requireThat((await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() === context.bootId, 'boot identity changed');
  requireThat(await realpath(process.execPath) === paths.node, 'controller must use the trusted private Node runtime');
  requireThat((await readFile('/proc/self/cgroup', 'utf8')).trim() === '0::/system.slice/mdai-helper.service/controller', 'helper is outside the delegated controller leaf');
  requireThat(await realpath(paths.root) === paths.root && (await statfs(paths.root)).type === CGROUP2, 'the delegated cgroup v2 namespace is missing');
  const root = await lstat(paths.root);
  requireThat(root.uid === uid && (await readFile(join(paths.root, 'cgroup.procs'), 'utf8')).trim() === '' &&
    (await readFile(join(paths.root, 'cgroup.type'), 'utf8')).trim() === 'domain' &&
    (await readFile(join(paths.root, 'pids.max'), 'utf8')).trim() === '4096', 'the installed service delegation or TasksMax contract is missing');
  await privateDirectory(paths.runs, uid);
  await trustedSource(paths.node);
  const key = createHash('sha256').update(context.directoryIdentity).digest('hex');
  const receiptPath = join(paths.runs, `.namespace-${key}.json`);
  let receipt: NamespaceReceipt;
  try {receipt = JSON.parse(await privateFile(receiptPath, uid, 4096)) as NamespaceReceipt;}
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    requireThat(!(context.registrations?.length), 'registered namespace receipt is missing');
    const namespaceId = randomUUID(), path = join(paths.root, `ns-${namespaceId}`);
    // A durable reservation is published first. A crash leaves an incomplete
    // receipt which is refused, never a new empty namespace replacement.
    await writePrivate(receiptPath, JSON.stringify({format: 1, pending: true, namespaceId, directoryIdentity: context.directoryIdentity, bootId: context.bootId}) + '\n');
    await mkdir(path);
    receipt = {format: 1, namespaceId, directoryIdentity: context.directoryIdentity, bootId: context.bootId,
      rootIdentity: identity(root), namespaceIdentity: identity(await lstat(path))};
    const temporary = receiptPath + '.complete';
    await writePrivate(temporary, JSON.stringify(receipt) + '\n'); await rename(temporary, receiptPath);
    const directory = await open(paths.runs, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
    try {await directory.sync();} finally {await directory.close();}
  }
  requireThat(Object.keys(receipt).sort().join(',') === ['format', 'namespaceId', 'directoryIdentity', 'bootId', 'rootIdentity', 'namespaceIdentity'].sort().join(',') &&
    receipt.format === 1 && UUID.test(receipt.namespaceId) && receipt.directoryIdentity === context.directoryIdentity && receipt.bootId === context.bootId &&
    receipt.rootIdentity === identity(root) && IDENTITY.test(receipt.namespaceIdentity), 'protected namespace receipt is incomplete or inconsistent');
  const path = join(paths.root, `ns-${receipt.namespaceId}`), directory = await open(path, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
  const namespace = new NativeNamespace(context, receipt, receiptPath, directory, path, uid);
  try {await namespace.assertCurrent(); return containmentBackendForNamespace(context, namespace);}
  catch (error) {await directory.close(); throw error;}
}
