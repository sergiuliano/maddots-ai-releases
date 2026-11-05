import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, open, readFile, readlink, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { helperPlatform, type HelperPlatform } from './platform.js';
import type { RuntimeContext } from './runtime.js';

export class HelperError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'HelperError'; }
}
export class CommandError extends HelperError {
  constructor(readonly exitCode: number | undefined) { super('COMMAND_FAILED', 'The helper command failed or timed out.'); }
}

export type CommandOptions = { input?: string; timeout?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal };
export type Runner = (file: string, args: readonly string[], options?: CommandOptions) => Promise<{ stdout: string; stderr: string }>;
export function cleanEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => !/TOKEN|KEY|SECRET/i.test(key) && value !== undefined));
}

const sameArgs = (args: readonly string[], expected: readonly string[]) => args.length === expected.length && args.every((arg, index) => arg === expected[index]);
const decimal = (value: string | undefined) => value !== undefined && /^\d+$/u.test(value);
const serviceTarget = (value: string | undefined) => value !== undefined && /^gui\/\d+\/app\.maddots\.ai\.helper$/u.test(value);
const fixedImageScript = 'ffdd25c569c9085da5935b94dc0d28784e344e4a8d12003513ec733591a32a9d';
const secretToolArgs = (args: readonly string[]) => {
  const fields = args[0] === 'store' && ['--label=MadDots AI helper', '--label=MadDots AI availability check'].includes(args[1]) ? args.slice(2) :
    ['lookup', 'clear'].includes(args[0]) ? args.slice(1) : [];
  return fields.length === 4 && sameArgs(fields.slice(0, 3), ['service', 'app.maddots.ai', 'account']) && fields[3].length > 0;
};

const trustedInstallOwner = (uid: number) => uid === 0 || uid === process.getuid?.();

async function ownedInstallPath(path: string): Promise<boolean> {
  const info = await lstat(path);
  return info.isFile() && info.nlink === 1 && trustedInstallOwner(info.uid) && (info.mode & 0o022) === 0;
}

async function assertInstallAncestors(entrypoint: string): Promise<void> {
  const pending = entrypoint.split('/').filter(Boolean);
  let path = '/', links = 0;
  // Check from / down, including every alias hop Terminal will traverse.
  // Expand symlinks before processing '..', just as pathname lookup does.
  while (pending.length) {
    const info = await lstat(path);
    const refuse = (reason: string): never => {
      throw new HelperError('HELPER_COMMAND_REFUSED', `The helper Terminal entrypoint has an unsafe ancestor ${path}: ${reason}`);
    };
    if (!info.isDirectory()) refuse('must be a real directory, not a symlink.');
    if (!trustedInstallOwner(info.uid)) refuse('must be owned by root or the current user.');
    const next = join(path, pending.shift()!), child = await lstat(next);
    if ((info.mode & 0o022) !== 0) {
      if ((info.mode & 0o1000) === 0) refuse('group/other-writable directories must have the sticky bit.');
      if (!trustedInstallOwner(child.uid)) refuse('a sticky directory must have a next component owned by root or the current user.');
    }
    if (child.isSymbolicLink()) {
      if (++links > 40) refuse('too many symlinks in the entrypoint path.');
      const target = await readlink(next);
      pending.unshift(...target.split('/').filter(Boolean));
      if (isAbsolute(target)) path = '/';
    } else path = next;
  }
}

/** The package manifest binds a CLI to this helper install, including npm's
 * nested development build layout. Resolve aliases before comparing paths. */
async function installedEntrypoint(root: string): Promise<string | undefined> {
  root = await realpath(root);
  const manifestPath = join(root, 'package.json');
  if (!await ownedInstallPath(manifestPath)) return;
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const bin = manifest.bin?.['maddots-ai'];
  if (manifest.name !== 'maddots-ai' || !['dist/cli.js', 'dist/helper/cli.js'].includes(bin)) return;
  const entrypoint = join(root, bin);
  // Do not let an install's manifest or a symlink enroll another program.
  if (await realpath(entrypoint) !== entrypoint || !await ownedInstallPath(entrypoint)) return;
  await assertInstallAncestors(entrypoint);
  return entrypoint;
}

async function helperEntrypoint(path: string, runtime?: Readonly<RuntimeContext>): Promise<boolean> {
  if (!isAbsolute(path)) return false;
  const current = await realpath(fileURLToPath(new URL('./cli.js', import.meta.url)));
  const candidate = await realpath(path);
  if (path !== candidate) await assertInstallAncestors(path);
  if (runtime) {
    if (await installedEntrypoint(runtime.runningRoot) !== current) return false;
    if (candidate === current) return true;
    const bootstrap = await installedEntrypoint(runtime.bundledRoot);
    return bootstrap !== undefined && bootstrap === await realpath(runtime.bootstrapEntrypoint) && candidate === bootstrap;
  }
  // Standalone notification callers use only this module's own installed CLI.
  for (let root = dirname(current); dirname(root) !== root; root = dirname(root)) {
    try { if (await installedEntrypoint(root) === current) return candidate === current; }
    catch (error) {
      if (error instanceof HelperError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
  }
  return false;
}

/** Read only the helper's generated Terminal launcher. Every shell word must
 * be single-quoted data, followed by this installation's Node and CLI paths. */
async function helperLauncher(path: string, runtime?: Readonly<RuntimeContext>): Promise<boolean> {
  if (!isAbsolute(path) || !['allow.command', 'agent-setup.command'].includes(basename(path))) return false;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o777) !== 0o700 || info.size > 32_768) return false;
    const text = await file.readFile('utf8'), prefix = '#!/bin/sh\nexec /usr/bin/env -i ';
    const suffix = basename(path) === 'allow.command' ? ' allow\n' : ' agent setup\n';
    if (!text.startsWith(prefix) || !text.endsWith(suffix)) return false;
    const source = text.slice(prefix.length, -suffix.length), words: string[] = [];
    let offset = 0;
    while (offset < source.length) {
      if (source[offset++] !== "'") return false;
      let word = '', closed = false;
      while (offset < source.length) {
        if (source.startsWith("'\\''", offset)) {word += "'"; offset += 4;}
        else if (source[offset] === "'") {offset++; closed = true; break;}
        else word += source[offset++];
      }
      if (!closed || /[\p{Cc}\p{Cf}]/u.test(word)) return false;
      words.push(word);
      if (offset < source.length && source[offset++] !== ' ') return false;
    }
    const entrypoint = words.pop(), executable = words.pop();
    if (!entrypoint || !executable || !isAbsolute(executable) || await realpath(executable) !== await realpath(process.execPath) ||
        !await helperEntrypoint(entrypoint, runtime)) return false;
    const values = new Map<string, string>();
    for (const word of words) {
      const split = word.indexOf('='), key = word.slice(0, split), value = word.slice(split + 1);
      if (split < 1 || values.has(key) || !['HOME', 'PATH', 'MADDOTS_AI_HOME', 'MADDOTS_AI_URL', 'MADDOTS_AI_ALLOW_INSECURE_LOOPBACK', 'MADDOTS_AI_AUTO_UPDATE'].includes(key)) return false;
      values.set(key, value);
    }
    return isAbsolute(values.get('HOME') ?? '') && values.get('MADDOTS_AI_HOME') === dirname(path) &&
      values.get('PATH') === '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' && values.has('MADDOTS_AI_URL') &&
      (!values.has('MADDOTS_AI_ALLOW_INSECURE_LOOPBACK') || values.get('MADDOTS_AI_ALLOW_INSECURE_LOOPBACK') === '1') &&
      (!values.has('MADDOTS_AI_AUTO_UPDATE') || values.get('MADDOTS_AI_AUTO_UPDATE') === '0');
  } finally {await file.close();}
}

/** A utility is a fixed program and vector, never a basename or PATH lookup.
 * Interpreters accept only the helper's closed scripts. Tool commands, npm,
 * shells and arbitrary Node entrypoints belong to the admitted tool boundary. */
async function helperUtilityAllowed(file: string, args: readonly string[], options: CommandOptions, runtime?: Readonly<RuntimeContext>, secretService?: string): Promise<boolean> {
  if (!args.every(arg => typeof arg === 'string' && !arg.includes('\0'))) return false;
  if (file === secretService) {
    try {
      if (!isAbsolute(file) || basename(file) !== 'secret-tool' || await realpath(file) !== file) return false;
      const info = await lstat(file);
      if (!info.isFile() || ![0, process.getuid?.()].includes(info.uid) || (info.mode & 0o022) !== 0) return false;
      await access(file, constants.X_OK);
      return secretToolArgs(args);
    } catch { return false; }
  }
  switch (file) {
    case '/usr/sbin/scutil': return sameArgs(args, ['--get', 'LocalHostName']);
    case '/usr/sbin/sysctl': return sameArgs(args, ['-n', 'kern.bootsessionuuid']);
    case '/bin/ps': return args.length === 4 && args[0] === '-U' && decimal(args[1]) && sameArgs(args.slice(2), ['-o', 'pid=,ruid=,state=,lstart=']);
    case '/usr/bin/plutil': return args.length === 5 && sameArgs(args.slice(0, 4), ['-convert', 'json', '-o', '-']) && isAbsolute(args[4]) && basename(args[4]) === 'Info.plist';
    case '/usr/bin/security':
      return (args[0] === 'find-generic-password' && args.length === 6 && args[1] === '-w' && args[2] === '-s' && ['app.maddots.ai', 'app.maddots.ai.provider-key'].includes(args[3]) && args[4] === '-a') ||
        (args[0] === 'delete-generic-password' && args.length === 5 && args[1] === '-s' && ['app.maddots.ai', 'app.maddots.ai.provider-key'].includes(args[2]) && args[3] === '-a') ||
        (sameArgs(args, ['-i']) && /^add-generic-password -U -s "app\.maddots\.ai(?:\.provider-key)?" -a "(?:[^"\\\r\n]|\\["\\])*" -w "(?:[^"\\\r\n]|\\["\\])*"\n$/u.test(options.input ?? ''));
    case '/bin/secret-tool': case '/usr/bin/secret-tool': return secretToolArgs(args);
    case '/usr/bin/systemctl':
      return args.length === 3 && args[0] === 'show' && args[1] === 'mdai-helper.service' && /^--property=[A-Za-z,]+$/u.test(args[2]) ||
        sameArgs(args, ['--user', 'show', 'app.maddots.ai.helper.service', '--property=Id,LoadState,MainPID', '--no-pager']) ||
        sameArgs(args, ['--user', 'show', 'app.maddots.ai.helper.service', '--property=Id,LoadState,ActiveState,SubState,UnitFileState,MainPID,ActiveEnterTimestampMonotonic,InactiveExitTimestampMonotonic', '--no-pager']) ||
        sameArgs(args, ['--user', 'restart', 'app.maddots.ai.helper.service']);
    case '/bin/launchctl':
      return args.length === 1 && ['manageruid', 'managername', 'list'].includes(args[0]) ||
        args.length === 2 && ['print', 'bootout'].includes(args[0]) && serviceTarget(args[1]) ||
        args.length === 3 && args[0] === 'kickstart' && args[1] === '-k' && serviceTarget(args[2]) ||
        args.length === 3 && args[0] === 'bootstrap' && /^gui\/\d+$/u.test(args[1]) && isAbsolute(args[2]) && args[2].endsWith('/Library/LaunchAgents/app.maddots.ai.helper.plist');
    case '/usr/bin/osascript':
      return args.length === 3 && args[0] === '-e' && args[1] === 'on run argv\ndisplay dialog (item 1 of argv) buttons {"OK"} default button "OK"\nend run' ||
        args.length === 2 && args[0] === '-e' && /^display dialog "\d+ (?:skills with code wait for Allow on this computer" buttons \{"Later", "Open Allow list"\}|agents need setup or Allow on this computer" buttons \{"Later", "Set up"\}) default button "Later" with title "MadDots AI" giving up after \d+$/u.test(args[1]) ||
        args.length >= 5 && sameArgs(args.slice(0, 3), ['-l', 'JavaScript', '-e']) &&
          createHash('sha256').update(args[3]).digest('hex') === fixedImageScript && args.slice(4).every(decimal);
    case '/usr/bin/open': return args.length === 3 && sameArgs(args.slice(0, 2), ['-a', 'Terminal']) && helperLauncher(args[2], runtime).catch(error => {
      if (error instanceof HelperError) throw error;
      return false;
    });
    default: {
      if (file !== process.execPath || args.length !== 3 || !sameArgs(args.slice(0, 2), ['--input-type=module', '-e'])) return false;
      const updater = new URL(import.meta.url.endsWith('.ts') ? './updater.ts' : './updater.js', import.meta.url).href;
      const script = `import {verifyReleaseBundle} from ${JSON.stringify(updater)};let input='';for await(const chunk of process.stdin)input+=chunk;try{const d=JSON.parse(input);process.stdout.write(JSON.stringify(await verifyReleaseBundle(d.identity,d.bundle,d.cache)))}catch{process.exitCode=1}`;
      return args[2] === script;
    }
  }
}

// Fixed programs must not inherit interpreter or dynamic-loader hooks.
function utilityEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const permitted = /^(?:HOME|PATH|USER|LOGNAME|TMPDIR|TEMP|TMP|TZ|LANG|LC_[A-Z_]+|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|NODE_EXTRA_CA_CERTS|(?:HTTP|HTTPS|ALL|NO)_PROXY)$/iu;
  return Object.fromEntries(Object.entries(cleanEnvironment(source)).filter(([key, value]) => permitted.test(key) &&
    (key !== 'DBUS_SESSION_BUS_ADDRESS' || /^unix:(?:path=\/[^;]+|abstract=[^;]+)$/u.test(value ?? ''))));
}

// The unrestricted primitive stays module-private. Failed commands are redacted
// because a fixed credential utility may echo its stdin.
async function dispatchHelperCommand(file: string, args: readonly string[], options: CommandOptions = {}, runtime?: Readonly<RuntimeContext>, secretService?: string) {
  args = [...args];
  options = {...options, env: utilityEnvironment(options.env)};
  if (file === process.execPath) {
    const {systemRuntimeMode} = await import('./system-runtime-preflight.js');
    if (systemRuntimeMode(runtime?.bundledRoot ?? '') || systemRuntimeMode(runtime?.runningRoot ?? '')) {
      throw new HelperError('SYSTEM_RUNTIME_FIXED', 'The fixed Linux system helper refuses an unguarded Node utility child.');
    }
  }
  if (!await helperUtilityAllowed(file, args, options, runtime, secretService)) throw new HelperError('HELPER_COMMAND_REFUSED', 'The helper utility command is not an approved fixed program.');
  return new Promise<{stdout: string; stderr: string}>((done, reject) => {
  const child = execFile(file, [...args], {
    env: options.env, timeout: options.timeout ?? 10_000, signal: options.signal,
    maxBuffer: 1024 * 1024, encoding: 'utf8', shell: false,
  }, (error, stdout, stderr) => {
    if (error) reject(new CommandError(typeof error.code === 'number' ? error.code : undefined));
    else done({ stdout, stderr });
  });
  child.stdin?.on('error', () => {});
  child.stdin?.end(options.input);
  });
}

export const runCommand: Runner = (file, args, options) => dispatchHelperCommand(file, args, options);

/** Runtime context comes from the bootstrap's verified release selection, never
 * launcher contents or environment. Keep the authority local to this runner. */
export function createRuntimeRunner(runtime: Readonly<RuntimeContext>): Runner {
  const context = {...runtime};
  return (file, args, options) => dispatchHelperCommand(file, args, options, context);
}

/** Only Secret Service selection supplies this canonical, discovered or saved
 * executable. The capability admits its fixed credential vectors at that path. */
export function createSecretServiceRunner(binary: string): Runner {
  return (file, args, options) => {
    if (file !== binary) return Promise.reject(new HelperError('HELPER_COMMAND_REFUSED', 'The selected Secret Service client does not match.'));
    return dispatchHelperCommand(file, args, options, undefined, binary);
  };
}

export type Timing = { now: () => number; sleep: (ms: number, signal?: AbortSignal) => Promise<void> };
export const clock: Timing = {
  now: Date.now,
  sleep: (ms, signal) => new Promise((done, reject) => {
    if (signal?.aborted) { reject(new HelperError('CANCELLED', 'The helper operation was cancelled.')); return; }
    const abort = () => { clearTimeout(timer); reject(new HelperError('CANCELLED', 'The helper operation was cancelled.')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); done(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  }),
};

export type HelperConfig = { endpoint: URL; home: string; dataDir: string; env: NodeJS.ProcessEnv; platform?: HelperPlatform };
export function endpointUrl(env: NodeJS.ProcessEnv = process.env): URL {
  let url: URL;
  try { url = new URL(env.MADDOTS_AI_URL ?? 'https://ai.maddots.app'); }
  catch { throw new HelperError('CONFIG_INVALID', 'MADDOTS_AI_URL must be a valid HTTPS origin.'); }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && env.MADDOTS_AI_ALLOW_INSECURE_LOOPBACK === '1')) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new HelperError('CONFIG_INVALID', 'MADDOTS_AI_URL must be HTTPS; HTTP loopback requires explicit opt-in.');
  }
  return url;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env, home = homedir(), platform: NodeJS.Platform = process.platform): HelperConfig {
  const selected = helperPlatform(platform);
  if (!isAbsolute(home) || (env.MADDOTS_AI_HOME && !isAbsolute(env.MADDOTS_AI_HOME))) {
    throw new HelperError('CONFIG_INVALID', 'The helper home override must be an absolute path.');
  }
  if (selected === 'linux') {
    for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR']) {
      if (env[key] && !isAbsolute(env[key]!)) throw new HelperError('CONFIG_INVALID', `${key} must be an absolute path.`);
    }
  }
  const data = selected === 'darwin' ? join(home, 'Library/Application Support/maddots-ai') : join(env.XDG_DATA_HOME || join(home, '.local/share'), 'maddots-ai');
  return { endpoint: endpointUrl(env), home: resolve(home), dataDir: resolve(env.MADDOTS_AI_HOME ?? data), env, platform: selected };
}
