import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, open, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Scope } from './api.js';
import { CommandError, HelperError, cleanEnvironment, createSecretServiceRunner, runCommand, type Runner } from './config.js';
import { assertSecretPath, atomicWrite, ensurePrivateDirectory, readPrivateFile, type HelperPaths } from './paths.js';
import { assertLockUpgradeReady } from './write-lock-upgrade.js';
import { RELEASE } from './release-identity.js';
import { helperPlatform, type HelperPlatform } from './platform.js';

export type SecretName = 'skills-token' | 'device-key';
export type SecretStorage = 'keychain' | 'secret-service' | 'file';
export interface SecretStore {
  readonly storage: SecretStorage;
  readonly platform?: HelperPlatform;
  get(name: SecretName): Promise<string | undefined>;
  set(name: SecretName, secret: string, scopes?: Scope[]): Promise<void>;
  delete(name: SecretName): Promise<void>;
}
export type CredentialCapability = 'deviceKeys' | 'runClaims' | 'providerKeys';
/** Storage capability is separate from the platform execution gate. Linux runs stay disabled in round 1. */
export function credentialCapabilities(storage: SecretStorage, platform: NodeJS.Platform = process.platform): Record<CredentialCapability, boolean> {
  const current = helperPlatform(platform);
  const runs = current === 'darwin' ? storage === 'keychain' : storage === 'file' || storage === 'secret-service';
  return { deviceKeys: runs, runClaims: runs, providerKeys: current === 'darwin' && storage === 'keychain' };
}
export function requireCredentialCapability(store: Pick<SecretStore, 'storage' | 'platform'>, capability: CredentialCapability, platform = store.platform ?? process.platform): void {
  if (!credentialCapabilities(store.storage, platform)[capability]) {
    throw new HelperError('FILE_RUNS_REFUSED', 'Agent runs on macOS require Keychain storage.');
  }
}
function validateSecret(secret: string): void {
  if (!secret || secret.length > 8192 || [...secret].some(character => [0, 10, 13].includes(character.charCodeAt(0)))) throw new HelperError('SECRET_INVALID', 'The helper secret is invalid.');
}
function sessionBus(env: NodeJS.ProcessEnv): boolean {
  const address = env.DBUS_SESSION_BUS_ADDRESS;
  return typeof address === 'string' && /^unix:(?:path=\/[^;]+|abstract=[^;]+)$/u.test(address) && !/[\p{Cc}\p{Cf}]/u.test(address);
}
const quote = (value: string) => {
  if ([...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new HelperError('SECRET_INVALID', 'A stored secret contains invalid characters.');
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
};

export class KeychainSecretStore implements SecretStore {
  readonly storage = 'keychain' as const;
  readonly platform = 'darwin' as const;
  private readonly binary: string;
  constructor(readonly endpoint: URL, readonly dataDir: string, private readonly runner: Runner = runCommand, private readonly env: NodeJS.ProcessEnv = process.env) {
    this.binary = !RELEASE && env.MADDOTS_AI_SECURITY_BIN ? env.MADDOTS_AI_SECURITY_BIN : '/usr/bin/security';
    if (!isAbsolute(this.binary)) throw new HelperError('CONFIG_INVALID', 'The security command must be an absolute path.');
  }
  private account(name: SecretName): string {
    return `${name}:${this.endpoint.host}:${createHash('sha256').update(this.dataDir).digest('hex').slice(0, 12)}`;
  }
  async get(name: SecretName): Promise<string | undefined> {
    try {
      const result = await this.runner(this.binary, ['find-generic-password', '-w', '-s', 'app.maddots.ai', '-a', this.account(name)], { env: cleanEnvironment(this.env) });
      return result.stdout.replace(/\r?\n$/, '');
    } catch (error) { if (error instanceof CommandError && error.exitCode === 44) return; throw new HelperError('SECRET_STORE_FAILED', 'The helper could not read its Keychain item.'); }
  }
  private async write(name: SecretName, secret: string): Promise<void> {
    const input = `add-generic-password -U -s ${quote('app.maddots.ai')} -a ${quote(this.account(name))} -w ${quote(secret)}\n`;
    await this.runner(this.binary, ['-i'], { input, env: cleanEnvironment(this.env) });
  }
  async set(name: SecretName, secret: string, _scopes?: Scope[]): Promise<void> {
    if (!secret || secret.length > 8192) throw new HelperError('SECRET_INVALID', 'The helper secret is invalid.');
    const previous = await this.get(name);
    try {
      await this.write(name, secret);
      if (await this.get(name) !== secret) throw new Error();
    } catch {
      if (previous !== undefined) await this.write(name, previous).catch(() => {});
      throw new HelperError('SECRET_STORE_FAILED', 'The helper could not verify the Keychain update. The current token is retained for retry.');
    }
  }
  async delete(name: SecretName): Promise<void> {
    try { await this.runner(this.binary, ['delete-generic-password', '-s', 'app.maddots.ai', '-a', this.account(name)], { env: cleanEnvironment(this.env) }); }
    catch (error) { if (!(error instanceof CommandError && error.exitCode === 44)) throw new HelperError('SECRET_STORE_FAILED', 'The helper could not remove its Keychain item.'); }
  }
}

export const FILE_STORAGE_WARNING = 'Warning: a token file stores the skills token as plaintext. It can be read by programs running as you. Agent runs are unavailable with file storage. Type I understand to continue.';
export class FileSecretStore implements SecretStore {
  readonly storage = 'file' as const;
  readonly platform: HelperPlatform;
  private constructor(readonly path: string, private readonly paths: HelperPaths) { this.platform = helperPlatform(paths.platform); }
  static async open(path: string, paths: HelperPaths, options: { explicit: boolean; confirmed: boolean; scopes?: Scope[] }): Promise<FileSecretStore> {
    if (!options.explicit || !options.confirmed) throw new HelperError('FILE_CONFIRMATION_REQUIRED', FILE_STORAGE_WARNING);
    if (!isAbsolute(path)) throw new HelperError('FILE_UNSAFE', 'The token file must be an absolute path.');
    path = resolve(path);
    if (options.scopes?.includes('run_claim')) requireCredentialCapability({storage: 'file', platform: helperPlatform(paths.platform)}, 'runClaims');
    await assertSecretPath(path, paths);
    if (process.platform === 'linux') await assertLockUpgradeReady({...paths, credentialFile: path});
    await ensurePrivateDirectory(dirname(path));
    if (paths.platform === 'linux') paths.credentialFile = path;
    const store = new FileSecretStore(path, paths);
    await store.values();
    return store;
  }
  private async values(): Promise<Partial<Record<SecretName, string>>> {
    await assertSecretPath(this.path, this.paths);
    if (process.platform === 'linux') await assertLockUpgradeReady(this.paths);
    if (this.platform === 'linux') await ensurePrivateDirectory(dirname(this.path));
    try {
      const value: unknown = JSON.parse(await readPrivateFile(this.path, this.platform === 'linux' ? 32_768 : 16_384, {singleLink: this.platform === 'linux'}));
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([name, secret]) =>
        !(name === 'skills-token' || name === 'device-key' && credentialCapabilities(this.storage, this.platform).deviceKeys) ||
        typeof secret !== 'string' || !secret || secret.length > 8192 ||
        this.platform === 'linux' && [...secret].some(character => [0, 10, 13].includes(character.charCodeAt(0))))) throw new Error();
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new HelperError('FILE_UNSAFE', 'The token file is invalid or cannot be read privately.');
    }
  }
  async get(name: SecretName): Promise<string | undefined> { return (await this.values())[name]; }
  async set(name: SecretName, secret: string, scopes: Scope[] = []): Promise<void> {
    if (name === 'device-key') requireCredentialCapability(this, 'deviceKeys');
    if (scopes.includes('run_claim')) requireCredentialCapability(this, 'runClaims');
    if (this.platform === 'linux') validateSecret(secret);
    else if (!secret || secret.length > 8192) throw new HelperError('SECRET_INVALID', 'The helper secret is invalid.');
    const previous = await this.values(), value = { ...previous, [name]: secret };
    try {
      await atomicWrite(this.path, JSON.stringify(value) + '\n', {singleLink: this.platform === 'linux'});
      if (await this.get(name) !== secret) throw new Error();
    } catch {
      await atomicWrite(this.path, JSON.stringify(previous) + '\n', {singleLink: this.platform === 'linux'}).catch(() => {});
      throw new HelperError('SECRET_STORE_FAILED', 'The helper could not verify its credential file update.');
    }
  }
  async delete(name: SecretName): Promise<void> {
    const value = await this.values();
    if (value[name] === undefined) return;
    delete value[name];
    if (Object.keys(value).length) await atomicWrite(this.path, JSON.stringify(value) + '\n', {singleLink: this.platform === 'linux'});
    else {
      await readPrivateFile(this.path, this.platform === 'linux' ? 32_768 : 16_384, {singleLink: this.platform === 'linux'});
      // The no-follow read and path check refuse links before removal.
      const info = await lstat(this.path);
      if (!info.isFile() || this.platform === 'linux' && info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600) throw new HelperError('FILE_UNSAFE', 'The helper refuses linked or unsafe credential files.');
      await unlink(this.path);
      if (this.platform === 'linux') {
        const directory = await open(dirname(this.path), constants.O_RDONLY | constants.O_NOFOLLOW);
        try { await directory.sync(); } finally { await directory.close(); }
      }
    }
    if (await this.get(name) !== undefined) throw new HelperError('SECRET_STORE_FAILED', 'The helper could not verify credential removal.');
  }
}

/** libsecret's command line client receives credential values only through stdin. */
export class SecretServiceSecretStore implements SecretStore {
  readonly storage = 'secret-service' as const;
  readonly platform = 'linux' as const;
  constructor(readonly endpoint: URL, readonly dataDir: string, readonly binary: string,
    private readonly runner: Runner = runCommand, private readonly env: NodeJS.ProcessEnv = process.env) {
    if (!isAbsolute(binary) || !sessionBus(env)) throw new HelperError('SECRET_STORE_UNAVAILABLE', 'Secret Service requires secret-tool and an accessible local Unix user session bus.');
    if (runner === runCommand) this.runner = createSecretServiceRunner(binary);
  }
  private attributes(name: string): string[] {
    return ['service', 'app.maddots.ai', 'account', `${name}:${this.endpoint.host}:${createHash('sha256').update(this.dataDir).digest('hex').slice(0, 12)}`];
  }
  private command(args: string[], input?: string) {
    const env = Object.fromEntries(['HOME', 'PATH', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'LANG', 'LC_ALL', 'LC_CTYPE']
      .flatMap(name => this.env[name] === undefined ? [] : [[name, this.env[name]]]));
    return this.runner(this.binary, args, {input, timeout: 5000, env});
  }
  /** A private, non-secret round trip proves the collection is usable without inferring it from lookup's exit 1. */
  async verifyAvailable(): Promise<void> {
    const attributes = this.attributes(`availability-${randomUUID()}`), value = randomUUID();
    try {
      await this.command(['store', '--label=MadDots AI availability check', ...attributes], value + '\n');
      if ((await this.command(['lookup', ...attributes])).stdout.replace(/\r?\n$/, '') !== value) throw new Error();
      await this.command(['clear', ...attributes]);
      try { await this.command(['lookup', ...attributes]); throw new Error(); }
      catch (error) { if (!(error instanceof CommandError && error.exitCode === 1)) throw error; }
    } catch {
      // A failed or timed-out store may still have committed. Attempt removal
      // even when its success answer was lost, without exposing any credential.
      let cleanupFailed = false;
      try { await this.command(['clear', ...attributes]); }
      catch { cleanupFailed = true; }
      throw new HelperError('SECRET_STORE_UNAVAILABLE', cleanupFailed
        ? 'Secret Service is unavailable and its non-secret availability check could not be removed. Restore the user session bus and secret-tool; the helper will not switch credential stores.'
        : 'The selected Secret Service backend is unavailable. Restore the user session bus and secret-tool; the helper will not switch credential stores.');
    }
  }
  async get(name: SecretName): Promise<string | undefined> {
    try { return (await this.command(['lookup', ...this.attributes(name)])).stdout.replace(/\r?\n$/, ''); }
    catch (error) {
      if (error instanceof CommandError && error.exitCode === 1) { await this.verifyAvailable(); return; }
      throw new HelperError('SECRET_STORE_FAILED', 'The helper could not read its Secret Service item.');
    }
  }
  private async write(name: SecretName, secret: string): Promise<void> {
    await this.command(['store', '--label=MadDots AI helper', ...this.attributes(name)], secret + '\n');
  }
  async set(name: SecretName, secret: string, scopes: Scope[] = []): Promise<void> {
    if (name === 'device-key') requireCredentialCapability(this, 'deviceKeys');
    if (scopes.includes('run_claim')) requireCredentialCapability(this, 'runClaims');
    validateSecret(secret);
    const previous = await this.get(name);
    try {
      await this.write(name, secret);
      if (await this.get(name) !== secret) throw new Error();
    } catch {
      if (previous !== undefined) await this.write(name, previous).catch(() => {});
      else await this.delete(name).catch(() => {});
      throw new HelperError('SECRET_STORE_FAILED', 'The helper could not verify its Secret Service update.');
    }
  }
  async delete(name: SecretName): Promise<void> {
    try {
      try { await this.command(['clear', ...this.attributes(name)]); }
      catch (error) { if (!(error instanceof CommandError && error.exitCode === 1)) throw error; }
      if (await this.get(name) !== undefined) throw new Error();
    } catch { throw new HelperError('SECRET_STORE_FAILED', 'The helper could not verify Secret Service credential removal.'); }
  }
}

async function secretTool(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  for (const directory of (env.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(':').filter(isAbsolute)) {
    const candidate = join(directory, 'secret-tool');
    try {
      await access(candidate, constants.X_OK);
      const binary = await realpath(candidate);
      if ((await lstat(binary)).isFile()) return binary;
    } catch { /* A missing client is normal on headless hosts. */ }
  }
}

async function selectedSecretTool(path: string): Promise<string> {
  try {
    if (!isAbsolute(path)) throw new Error();
    await access(path, constants.X_OK);
    const binary = await realpath(path);
    if (!(await lstat(binary)).isFile()) throw new Error();
    return binary;
  } catch { throw new HelperError('SECRET_STORE_UNAVAILABLE', 'The selected Secret Service client is unavailable. Restore secret-tool at its saved location; the helper will not switch credential stores.'); }
}

export type SecretSelectionState = {status: string; tokenStorage: SecretStorage; tokenFile?: string; credentialBackendSelected?: boolean; scopes?: Scope[]; secretServiceBinary?: string};
/** First pairing may select an available backend. A saved selection is never silently downgraded. */
export async function selectSecretStore(options: {paths: HelperPaths; endpoint: URL; saved: SecretSelectionState;
  env?: NodeJS.ProcessEnv; runner?: Runner; tokenFile?: string; confirmed?: boolean}): Promise<SecretStore> {
  const {paths, endpoint, saved, runner = runCommand, env = process.env} = options;
  const platform = helperPlatform(paths.platform);
  if (options.tokenFile && !isAbsolute(options.tokenFile) || saved.tokenFile && !isAbsolute(saved.tokenFile)) {
    throw new HelperError('FILE_UNSAFE', 'The token file must be an absolute path.');
  }
  const requestedFile = options.tokenFile && resolve(options.tokenFile), savedFile = saved.tokenFile && resolve(saved.tokenFile);
  const persisted = saved.credentialBackendSelected || saved.status !== 'unpaired' || Boolean(saved.tokenFile) ||
    saved.tokenStorage !== (platform === 'linux' ? 'file' : 'keychain');
  if (requestedFile && persisted && saved.tokenStorage !== 'file') {
    throw new HelperError('SECRET_BACKEND_MISMATCH', 'The helper cannot change its selected credential backend. Uninstall it before selecting another backend.');
  }
  if (requestedFile && savedFile && requestedFile !== savedFile) {
    throw new HelperError('FILE_UNSAFE', 'Use the previously selected credential file.');
  }
  const openFile = (path: string) => FileSecretStore.open(path, paths, {explicit: true,
    confirmed: platform === 'linux' && !requestedFile || Boolean(options.confirmed) || persisted && saved.tokenStorage === 'file' && savedFile === path, scopes: saved.scopes});
  if (requestedFile) return openFile(requestedFile);
  if (platform === 'darwin') {
    if (persisted && saved.tokenStorage === 'secret-service') throw new HelperError('SECRET_BACKEND_MISMATCH', 'Secret Service is available only on Linux.');
    if (saved.tokenStorage === 'file') {
      if (!savedFile) throw new HelperError('FILE_UNSAFE', 'The saved token file path is missing.');
      return openFile(savedFile);
    }
    return new KeychainSecretStore(endpoint, paths.data, runner, env);
  }
  if (persisted && saved.tokenStorage === 'keychain') throw new HelperError('SECRET_BACKEND_MISMATCH', 'The saved Keychain credential backend cannot be used on Linux.');
  if (persisted && saved.tokenStorage === 'file') return openFile(savedFile ?? join(paths.config ?? join(paths.home, '.config/maddots-ai'), 'credentials.json'));
  const retainedBinary = persisted && saved.tokenStorage === 'secret-service' ? saved.secretServiceBinary : undefined;
  const binary = sessionBus(env) ? retainedBinary ? await selectedSecretTool(retainedBinary) : await secretTool(env) : undefined;
  if (binary) {
    const store = new SecretServiceSecretStore(endpoint, paths.data, binary, runner, env);
    try { await store.verifyAvailable(); return store; }
    catch (error) { if (persisted) throw error; }
  }
  if (persisted && saved.tokenStorage === 'secret-service') throw new HelperError('SECRET_STORE_UNAVAILABLE', 'The selected Secret Service backend requires an accessible user session bus and secret-tool. The helper will not switch credential stores.');
  return openFile(join(paths.config ?? join(paths.home, '.config/maddots-ai'), 'credentials.json'));
}
