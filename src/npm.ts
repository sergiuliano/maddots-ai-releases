// npm discovery is independent of Node's prefix, including managed launchers.
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, open, realpath } from 'node:fs/promises';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { HelperError, cleanEnvironment } from './config.js';
import { assertNoSymlinks } from './paths.js';

export const PACKAGE_TIMEOUT_MS = 120_000;
export interface NpmCommand { command: string; args: string[] }
export interface PackageRunOptions { cwd: string; env: NodeJS.ProcessEnv; timeout: number; signal?: AbortSignal; input?: string }
export type PackageRunner = (file: string, args: readonly string[], options: PackageRunOptions) => Promise<{ stdout: string; stderr: string }>;
const execute = promisify(execFile);
export const runPackageCommand: PackageRunner = async (file, args, options) => {
  try {
    const output = await execute(file, [...args], { cwd: options.cwd, env: cleanEnvironment(options.env), timeout: options.timeout,
      maxBuffer: 4 * 1024 * 1024, signal: options.signal, encoding: 'utf8' });
    return { stdout: output.stdout, stderr: output.stderr };
  } catch { throw new HelperError('PACKAGE_COMMAND_FAILED', 'The package command failed or timed out.'); }
};

export function installEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(cleanEnvironment(environment))) {
    if (/^(PATH|HOME|USER|LOGNAME|TMPDIR|TEMP|TMP|VOLTA_HOME|ASDF_DIR|ASDF_DATA_DIR|NVM_DIR|FNM_DIR|MISE_DATA_DIR|MISE_CONFIG_DIR|NODE_EXTRA_CA_CERTS|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i.test(key) || /^npm_config_/i.test(key)) result[key] = value;
  }
  result.PATH = dirname(process.execPath) + delimiter + (result.PATH ?? '');
  result.npm_config_ignore_scripts = 'true'; result.npm_config_audit = 'false'; result.npm_config_fund = 'false';
  return result;
}

export async function discoverNpm(environment: NodeJS.ProcessEnv, node = process.execPath): Promise<NpmCommand> {
  const candidates: string[] = [], executables: string[] = [];
  const hint = environment.npm_execpath ?? environment.NPM_EXECPATH;
  if (hint && isAbsolute(hint) && /^(npm-cli|npm)\.[cm]?js$/.test(basename(hint))) candidates.push(hint);
  const prefixes = new Set([dirname(node)]);
  try { prefixes.add(dirname(await realpath(node))); } catch { /* A test may provide a synthetic node path. */ }
  for (const prefix of prefixes) candidates.push(join(prefix, 'node_modules/npm/bin/npm-cli.js'), resolve(prefix, '../lib/node_modules/npm/bin/npm-cli.js'));
  for (const prefix of (environment.PATH ?? '').split(delimiter).filter(isAbsolute)) {
    const executable = join(prefix, 'npm');
    try {
      const actual = await realpath(executable);
      if (/^npm-cli\.[cm]?js$/.test(basename(actual))) candidates.push(actual);
      candidates.push(resolve(dirname(actual), 'node_modules/npm/bin/npm-cli.js'), resolve(dirname(actual), '../lib/node_modules/npm/bin/npm-cli.js'));
      executables.push(executable);
    } catch { /* Continue through separate manager prefixes. */ }
  }
  for (const candidate of new Set(candidates)) {
    try { await access(candidate, constants.R_OK); return { command: node, args: [candidate] }; } catch { /* Try the next layout. */ }
  }
  for (const executable of executables) {
    try { await access(executable, constants.X_OK); return { command: executable, args: [] }; } catch { /* Try the next manager. */ }
  }
  throw new HelperError('NPM_UNAVAILABLE', 'npm could not be found.');
}

async function configurationFile(path: string): Promise<string> {
  await assertNoSymlinks(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 1024 * 1024) throw new HelperError('FILE_UNSAFE', 'The package configuration file is unsafe.');
    return await file.readFile('utf8');
  } finally { await file.close(); }
}

export interface PackageInfrastructure {
  env: NodeJS.ProcessEnv; npm: NpmCommand; proxy?: string; noProxy?: string; ca?: string;
  strictSSL: boolean; offline: boolean;
}
export async function packageInfrastructure(environment: NodeJS.ProcessEnv, root: string, signal?: AbortSignal,
  runner: PackageRunner = runPackageCommand): Promise<PackageInfrastructure> {
  const env = installEnvironment(environment), npm = await discoverNpm(environment);
  const output = await runner(npm.command, [...npm.args, 'config', 'list', '--json'], { cwd: root, env, signal, timeout: PACKAGE_TIMEOUT_MS });
  let config: Record<string, unknown>;
  try { config = JSON.parse(output.stdout) as Record<string, unknown>; if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(); }
  catch { throw new HelperError('NPM_CONFIGURATION_UNAVAILABLE', 'The npm configuration could not be read.'); }
  const string = (name: string) => typeof config[name] === 'string' && config[name] ? config[name] as string : undefined;
  const proxy = string('https-proxy') ?? string('proxy') ?? env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy;
  const noProxy = (Array.isArray(config.noproxy) ? config.noproxy.join(',') : string('noproxy')) ?? env.NO_PROXY ?? env.no_proxy;
  let ca = Array.isArray(config.ca) ? config.ca.join('\n') : string('ca');
  const cafile = string('cafile');
  if (cafile) { const path = resolve(root, cafile); ca = await configurationFile(path); env.NODE_EXTRA_CA_CERTS = path; env.npm_config_cafile = path; }
  if (proxy) { env.HTTPS_PROXY = proxy; env.HTTP_PROXY = proxy; }
  if (noProxy) env.NO_PROXY = noProxy;
  // Verification and transport never disable TLS certificate checks, even if npm was configured to do so.
  return { env: cleanEnvironment(env), npm, proxy, noProxy, ca, strictSSL: true, offline: config.offline === true };
}
