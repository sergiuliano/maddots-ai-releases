import { constants } from 'node:fs';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommandError, HelperError, endpointUrl, runCommand, type Runner } from './config.js';
import { assertNoSymlinks, atomicWrite, ensurePaths, ensurePrivateDirectory, readPrivateFile, type HelperPaths } from './paths.js';
import { helperPlatform } from './platform.js';
import { assertLockUpgradeReady } from './write-lock-upgrade.js';

export const SERVICE_LABEL = 'app.maddots.ai.helper';
export const SERVICE_INTERVAL_MS = 60_000;
export const SERVICE_UNIT = 'mdai-helper.service';
export const LINUX_SERVICE_FRAGMENT = '/etc/systemd/system/mdai-helper.service';
export const LINUX_SERVICE_NODE = '/usr/local/libexec/mdai/node';
export const LINUX_SERVICE_ENTRYPOINT = '/usr/local/libexec/mdai/helper/dist/cli.js';
const LAUNCHCTL = '/bin/launchctl';
const SYSTEMCTL = '/usr/bin/systemctl';

export type ServiceOptions = {
  runner?: Runner;
  uid?: number;
  execPath?: string;
  entrypoint?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  toolDirectories?: readonly string[];
  now?: () => number;
  heartbeatMaxAgeMs?: number;
};

export type ServiceHeartbeat = { pid: number; updatedAt: number; fresh: boolean };
export type ServiceStatus = {
  platform: 'darwin' | 'linux';
  manager: 'launchd' | 'systemd';
  installed: boolean;
  running: boolean;
  healthy: boolean;
  loadState?: string;
  activeState?: string;
  subState?: string;
  mainPid?: number;
  linger?: 'yes' | 'no' | 'unknown';
  heartbeat?: ServiceHeartbeat | null;
};

function xml(value: string): string {
  if ([...value].some(character => {
    const code = character.codePointAt(0)!;
    return code < 0x20 || code === 0x7f || (code >= 0xd800 && code <= 0xdfff) || code === 0xfffe || code === 0xffff;
  })) {
    throw new HelperError('SERVICE_CONFIG_INVALID', 'The service configuration contains an invalid character.');
  }
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function domain(options: ServiceOptions): string {
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) {
    throw new HelperError('SERVICE_CONFIG_INVALID', 'The helper needs a valid macOS user id.');
  }
  return `gui/${uid}`;
}

/** Only configuration needed by the service survives terminal setup. */
function serviceEnvironment(paths: HelperPaths, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    HOME: paths.home,
    PATH: source.PATH ?? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    MADDOTS_AI_HOME: paths.data,
    MADDOTS_AI_URL: endpointUrl(source).origin,
  };
  if (source.MADDOTS_AI_ALLOW_INSECURE_LOOPBACK === '1') result.MADDOTS_AI_ALLOW_INSECURE_LOOPBACK = '1';
  if (source.MADDOTS_AI_AUTO_UPDATE === '0') result.MADDOTS_AI_AUTO_UPDATE = '0';
  return result;
}

function assertPlistPath(paths: HelperPaths): void {
  const expected = join(paths.home, 'Library/LaunchAgents', `${SERVICE_LABEL}.plist`);
  if (resolve(paths.servicePlist) !== expected) {
    throw new HelperError('PATH_UNSAFE', 'The helper can manage only its own launchd plist.');
  }
}

async function agentDirectory(paths: HelperPaths, create: boolean): Promise<void> {
  assertPlistPath(paths);
  const directory = dirname(paths.servicePlist);
  await assertNoSymlinks(paths.servicePlist, paths.home);
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertNoSymlinks(paths.servicePlist, paths.home);
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0) {
      throw new HelperError('PATH_UNSAFE', 'The LaunchAgents folder must be owned by this user and must not be writable by others.');
    }
  } catch (error) {
    if (create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    const info = await lstat(paths.servicePlist);
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600) {
      throw new HelperError('PATH_UNSAFE', 'The helper plist must be a private regular file owned by this user.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function loaded(runner: Runner, target: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  try { await runner(LAUNCHCTL, ['print', target], { env }); return true; }
  catch (error) {
    // launchctl's ESRCH exit is an absent service, not an authorization failure.
    if (error instanceof CommandError && error.exitCode === 113) return false;
    throw error;
  }
}

async function prepareLogs(paths: HelperPaths): Promise<void> {
  for (const name of ['service.log', 'service-error.log']) {
    const path = join(paths.logs, name);
    await assertNoSymlinks(path, paths.logs);
    const file = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600) {
        throw new HelperError('PATH_UNSAFE', 'The service logs must be private regular files owned by this user.');
      }
    } finally { await file.close(); }
  }
}

async function bootout(runner: Runner, target: string, env: NodeJS.ProcessEnv): Promise<void> {
  try { await runner(LAUNCHCTL, ['bootout', target], { env }); }
  catch (error) {
    if (!(error instanceof CommandError && error.exitCode === 113)) throw error;
  }
}

function plist(paths: HelperPaths, executable: string, entrypoint: string, env: NodeJS.ProcessEnv): string {
  if (!isAbsolute(executable) || !isAbsolute(entrypoint)) {
    throw new HelperError('SERVICE_CONFIG_INVALID', 'The service executable and helper entrypoint must use absolute paths.');
  }
  const environment = Object.entries(env).map(([key, value]) => `    <key>${xml(key)}</key><string>${xml(value ?? '')}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(executable)}</string>
    <string>--disable-sigusr1</string>
    <string>${xml(entrypoint)}</string>
    <string>service</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${environment}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${xml(join(paths.logs, 'service.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(join(paths.logs, 'service-error.log'))}</string>
</dict>
</plist>
`;
}

/** The CLI holds the helper write lock while installing or removing a service. */
async function installLaunchAgent(paths: HelperPaths, options: ServiceOptions): Promise<void> {
  const runner = options.runner ?? runCommand;
  const scope = domain(options);
  const env = serviceEnvironment(paths, options.env ?? process.env);
  const content = plist(paths, options.execPath ?? process.execPath,
    options.entrypoint ?? fileURLToPath(new URL('./cli.js', import.meta.url)), env);
  await ensurePaths(paths);
  await agentDirectory(paths, true);
  await prepareLogs(paths);
  if (await loaded(runner, `${scope}/${SERVICE_LABEL}`, env)) {
    await bootout(runner, `${scope}/${SERVICE_LABEL}`, env);
  }
  await atomicWrite(paths.servicePlist, content);
  await runner(LAUNCHCTL, ['bootstrap', scope, paths.servicePlist], { env });
}

async function removeLaunchAgent(paths: HelperPaths, options: ServiceOptions): Promise<void> {
  const runner = options.runner ?? runCommand;
  const scope = domain(options);
  const env = serviceEnvironment(paths, options.env ?? process.env);
  await agentDirectory(paths, false);
  if (await loaded(runner, `${scope}/${SERVICE_LABEL}`, env)) {
    await bootout(runner, `${scope}/${SERVICE_LABEL}`, env);
  }
  await assertNoSymlinks(paths.servicePlist, paths.home);
  try { await unlink(paths.servicePlist); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

function platform(paths: HelperPaths, options: ServiceOptions): 'darwin' | 'linux' {
  return helperPlatform(options.platform ?? paths.platform ?? process.platform);
}

function validValue(value: string): string {
  if ([...value].some(character => {
    const code = character.codePointAt(0)!;
    return code < 0x20 || code === 0x7f || (code >= 0xd800 && code <= 0xdfff);
  })) throw new HelperError('SERVICE_CONFIG_INVALID', 'The systemd service configuration contains an invalid character.');
  return value;
}

/** systemd.syntax(7), Quoting: quotes wrap a whole item, starting at its
 * beginning and ending before whitespace or end of line. Pass NAME=value as
 * one item, never NAME="value": https://www.freedesktop.org/software/systemd/man/systemd.syntax.html#Quoting
 * systemd expands percent specifiers and ExecStart dollars even inside quotes. */
function unitArgument(value: string): string {
  return `"${validValue(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => '$$')}"`;
}

/** Reviewable founder installation contract. This function performs no host writes. */
export function linuxSystemServiceUnit(entrypoint = LINUX_SERVICE_ENTRYPOINT, endpoint = 'https://ai.maddots.app'): string {
  if (!/^\/usr\/local\/libexec\/mdai\/[A-Za-z0-9./_-]+$/u.test(entrypoint) || resolve(entrypoint) !== entrypoint) {
    throw new HelperError('SERVICE_CONFIG_INVALID', 'The system service entrypoint must remain in the trusted private runtime.');
  }
  const origin = endpointUrl({MADDOTS_AI_URL: endpoint}).origin;
  return `[Unit]
Description=MadDots AI contained Linux helper
ConditionPathExists=${entrypoint}

[Service]
Type=exec
User=mdai
Group=mdai
UMask=0077
WorkingDirectory=/var/lib/mdai
ExecStart=/usr/bin/env -i HOME=/var/lib/mdai/home PATH=/usr/local/libexec/mdai:/usr/bin:/bin MADDOTS_AI_HOME=/var/lib/mdai/data ${unitArgument(`MADDOTS_AI_URL=${origin}`)} XDG_CONFIG_HOME=/var/lib/mdai/config XDG_STATE_HOME=/var/lib/mdai/state XDG_RUNTIME_DIR=/run/mdai-helper ${unitArgument(LINUX_SERVICE_NODE)} --disable-sigusr1 ${unitArgument(entrypoint)} service
Delegate=
DelegateSubgroup=controller
MemoryMax=64G
CPUQuota=5120%
CPUWeight=100
IOWeight=100
TasksMax=4096
NoNewPrivileges=yes
RestrictSUIDSGID=yes
ProtectHome=yes
PrivateTmp=yes
RuntimeDirectory=mdai-helper
RuntimeDirectoryMode=0700
Restart=no
KillMode=control-group
TimeoutStopSec=30s
SendSIGKILL=yes
LimitCORE=0
StandardOutput=journal
StandardError=journal
`;
}

const systemProperties = ['LoadState', 'ActiveState', 'SubState', 'MainPID', 'FragmentPath', 'DropInPaths',
  'User', 'Group', 'ControlGroup', 'Delegate', 'DelegateControllers', 'DelegateSubgroup', 'TasksMax',
  'NoNewPrivileges', 'KillMode', 'Restart', 'ExecStart'];
async function installedSystemService(options: ServiceOptions): Promise<Record<string, string>> {
  let response: {stdout: string; stderr: string};
  try {
    response = await (options.runner ?? runCommand)(SYSTEMCTL, ['show', SERVICE_UNIT, '--property=' + systemProperties.join(',')],
      {env: {PATH: '/usr/bin:/bin', LC_ALL: 'C'}});
  } catch (error) {
    if (!(error instanceof CommandError)) throw error;
    throw new HelperError('SERVICE_MANAGER_UNAVAILABLE', `systemctl show ${SERVICE_UNIT} failed${error.exitCode === undefined ? '' : ` (exit ${error.exitCode})`}.`);
  }
  const values: Record<string, string> = {};
  for (const line of response.stdout.trim().split('\n')) {
    const index = line.indexOf('=');
    if (index <= 0 || Object.hasOwn(values, line.slice(0, index))) throw new HelperError('SERVICE_STATUS_INVALID', 'The system manager returned invalid service properties.');
    values[line.slice(0, index)] = line.slice(index + 1);
  }
  if (!values.LoadState || !values.ActiveState || !values.SubState || !/^\d+$/u.test(values.MainPID ?? '') || !Number.isSafeInteger(Number(values.MainPID))) {
    throw new HelperError('SERVICE_STATUS_INVALID', 'The system manager returned incomplete helper service status.');
  }
  return values;
}
function requireSystemContract(values: Record<string, string>, options: ServiceOptions): void {
  const entrypoint = options.entrypoint ?? LINUX_SERVICE_ENTRYPOINT;
  linuxSystemServiceUnit(entrypoint);
  const expected: Record<string, string> = {LoadState: 'loaded', FragmentPath: LINUX_SERVICE_FRAGMENT, DropInPaths: '',
    User: 'mdai', Group: 'mdai', ControlGroup: '/system.slice/mdai-helper.service', Delegate: 'yes', DelegateControllers: '',
    DelegateSubgroup: 'controller', TasksMax: '4096', NoNewPrivileges: 'yes', KillMode: 'control-group', Restart: 'no'};
  const mismatch = Object.entries(expected).find(([name, value]) => values[name] !== value);
  const executable = /^\{ path=\/usr\/bin\/env ; argv\[\]=([^;]+) ; ignore_errors=no ;[^}]*\}$/u.exec(values.ExecStart ?? '');
  const expectedArguments = `/usr/bin/env -i HOME=/var/lib/mdai/home PATH=/usr/local/libexec/mdai:/usr/bin:/bin MADDOTS_AI_HOME=/var/lib/mdai/data MADDOTS_AI_URL=${endpointUrl(options.env ?? {}).origin} XDG_CONFIG_HOME=/var/lib/mdai/config XDG_STATE_HOME=/var/lib/mdai/state XDG_RUNTIME_DIR=/run/mdai-helper ${LINUX_SERVICE_NODE} --disable-sigusr1 ${entrypoint} service`;
  if (mismatch || executable?.[1].trim() !== expectedArguments) {
    throw new HelperError('SERVICE_PROVISIONING_REQUIRED', `The founder-installed ${SERVICE_UNIT} containment contract is missing or incompatible${mismatch ? ` (${mismatch[0]})` : ' (ExecStart)'}. Review linuxSystemServiceUnit() and provision the trusted runtime before enabling Linux execution.`);
  }
  if (options.execPath !== undefined && options.execPath !== LINUX_SERVICE_NODE || options.toolDirectories?.length) {
    throw new HelperError('SERVICE_CONFIG_INVALID', 'Linux service runtime paths are fixed by the founder-installed containment contract.');
  }
}
async function installSystemdUnit(_paths: HelperPaths, options: ServiceOptions): Promise<void> {
  // Account, profile, trusted executable copies and system-unit installation are
  // founder-owned. The helper must never install a competing legacy user unit.
  requireSystemContract(await installedSystemService(options), options);
}
async function removeSystemdUnit(_paths: HelperPaths, _options: ServiceOptions): Promise<void> {
  throw new HelperError('SERVICE_FOUNDER_ACTION_REQUIRED', `Removing ${SERVICE_UNIT} requires the founder to stop the system service and verify all journal obligations before removing its unit. No host changes were made.`);
}

/** The CLI holds the helper write lock while installing or removing a service. */
export async function installService(paths: HelperPaths, options: ServiceOptions = {}): Promise<void> {
  if (platform(paths, options) === 'linux') await installSystemdUnit(paths, options);
  else await installLaunchAgent(paths, options);
}

export async function removeService(paths: HelperPaths, options: ServiceOptions = {}): Promise<void> {
  if (platform(paths, options) === 'linux') await removeSystemdUnit(paths, options);
  else await removeLaunchAgent(paths, options);
}

function heartbeatPath(paths: HelperPaths): string {
  const expected = join(paths.stateDir ?? paths.data, 'service-heartbeat.json');
  if (paths.serviceHeartbeat && paths.serviceHeartbeat !== expected) throw new HelperError('PATH_UNSAFE', 'The helper heartbeat must remain in its private state folder.');
  return expected;
}

/** Write only after a completed service tick, so stalled or failed work ages out. */
export async function writeServiceHeartbeat(paths: HelperPaths, options: { pid?: number; now?: () => number } = {}): Promise<void> {
  if (helperPlatform(paths.platform ?? process.platform) !== 'linux') return;
  const pid = options.pid ?? process.pid, updatedAt = (options.now ?? Date.now)();
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    throw new HelperError('SERVICE_CONFIG_INVALID', 'The helper heartbeat needs a valid process id and timestamp.');
  }
  const path = heartbeatPath(paths);
  await assertLockUpgradeReady(paths);
  await ensurePrivateDirectory(dirname(path));
  await atomicWrite(path, JSON.stringify({ pid, updatedAt }) + '\n');
}

async function heartbeat(paths: HelperPaths, options: ServiceOptions, pid: number): Promise<ServiceHeartbeat | null> {
  let content: string;
  try { content = await readPrivateFile(heartbeatPath(paths), 1024); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  let value: { pid?: unknown; updatedAt?: unknown };
  try { value = JSON.parse(content) as typeof value; }
  catch { return null; }
  if (!value || !Number.isSafeInteger(value.pid) || !Number.isSafeInteger(value.updatedAt) || (value.pid as number) <= 0 || (value.updatedAt as number) < 0) return null;
  const age = (options.now ?? Date.now)() - (value.updatedAt as number);
  return { pid: value.pid as number, updatedAt: value.updatedAt as number,
    fresh: value.pid === pid && age >= -30_000 && age <= (options.heartbeatMaxAgeMs ?? 3 * SERVICE_INTERVAL_MS) };
}

async function systemdStatus(paths: HelperPaths, options: ServiceOptions): Promise<ServiceStatus> {
  const values = await installedSystemService(options);
  const {LoadState: loadState, ActiveState: activeState, SubState: subState} = values;
  const installed = loadState === 'loaded', mainPid = Number(values.MainPID);
  if (installed) requireSystemContract(values, options);
  const running = installed && activeState === 'active' && subState === 'running' && mainPid > 0;
  const recent = await heartbeat(paths, options, mainPid);
  return {platform: 'linux', manager: 'systemd', installed, running, healthy: running && recent?.fresh === true,
    loadState, activeState, subState, mainPid, heartbeat: recent};
}

export async function serviceStatus(paths: HelperPaths, options: ServiceOptions = {}): Promise<ServiceStatus> {
  if (platform(paths, options) === 'linux') return systemdStatus(paths, options);
  await agentDirectory(paths, false);
  let installed = true;
  try { await lstat(paths.servicePlist); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; installed = false; }
  const running = await loaded(options.runner ?? runCommand, `${domain(options)}/${SERVICE_LABEL}`, serviceEnvironment(paths, options.env ?? process.env));
  return { platform: 'darwin', manager: 'launchd', installed, running, healthy: running };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/** Sequential ticks prevent the service from overlapping its own writes. */
export async function runService(tick: () => Promise<void>, options: {
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  intervalMs?: () => number;
} = {}): Promise<void> {
  const pause = options.sleep ?? sleep;
  while (!options.signal?.aborted) {
    await tick();
    if (options.signal?.aborted) return;
    try { await pause(options.intervalMs?.() ?? SERVICE_INTERVAL_MS, options.signal); }
    catch (error) { if (!options.signal?.aborted) throw error; }
  }
}
