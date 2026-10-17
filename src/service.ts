import { constants } from 'node:fs';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommandError, HelperError, endpointUrl, runCommand, type Runner } from './config.js';
import { assertNoSymlinks, atomicWrite, ensurePaths, type HelperPaths } from './paths.js';

export const SERVICE_LABEL = 'app.maddots.ai.helper';
export const SERVICE_INTERVAL_MS = 60_000;
const LAUNCHCTL = '/bin/launchctl';

export type ServiceOptions = {
  runner?: Runner;
  uid?: number;
  execPath?: string;
  entrypoint?: string;
  env?: NodeJS.ProcessEnv;
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
export async function installService(paths: HelperPaths, options: ServiceOptions = {}): Promise<void> {
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

export async function removeService(paths: HelperPaths, options: ServiceOptions = {}): Promise<void> {
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
