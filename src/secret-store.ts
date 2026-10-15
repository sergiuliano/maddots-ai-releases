import { createHash } from 'node:crypto';
import { lstat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import type { Scope } from './api.js';
import { CommandError, HelperError, cleanEnvironment, runCommand, type Runner } from './config.js';
import { assertSecretPath, atomicWrite, ensurePrivateDirectory, readPrivateFile, type HelperPaths } from './paths.js';
import { RELEASE } from './release-identity.js';

export type SecretName = 'skills-token' | 'device-key';
export interface SecretStore {
  readonly storage: 'keychain' | 'file';
  get(name: SecretName): Promise<string | undefined>;
  set(name: SecretName, secret: string, scopes?: Scope[]): Promise<void>;
  delete(name: SecretName): Promise<void>;
}
const quote = (value: string) => {
  if ([...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new HelperError('SECRET_INVALID', 'A stored secret contains invalid characters.');
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
};

export class KeychainSecretStore implements SecretStore {
  readonly storage = 'keychain' as const;
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
  private constructor(readonly path: string, private readonly paths: HelperPaths) {}
  static async open(path: string, paths: HelperPaths, options: { explicit: boolean; confirmed: boolean; scopes?: Scope[] }): Promise<FileSecretStore> {
    if (!options.explicit || !options.confirmed) throw new HelperError('FILE_CONFIRMATION_REQUIRED', FILE_STORAGE_WARNING);
    if (options.scopes?.includes('run_claim')) throw new HelperError('FILE_RUNS_REFUSED', 'Agent runs require Keychain storage.');
    await assertSecretPath(path, paths);
    await ensurePrivateDirectory(dirname(path));
    const store = new FileSecretStore(path, paths);
    await store.values();
    return store;
  }
  private async values(): Promise<Partial<Record<SecretName, string>>> {
    await assertSecretPath(this.path, this.paths);
    try {
      const value: unknown = JSON.parse(await readPrivateFile(this.path, 16_384));
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([name, secret]) => name !== 'skills-token' || typeof secret !== 'string' || !secret || secret.length > 8192)) throw new Error();
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new HelperError('FILE_UNSAFE', 'The token file is invalid or cannot be read privately.');
    }
  }
  async get(name: SecretName): Promise<string | undefined> { return (await this.values())[name]; }
  async set(name: SecretName, secret: string, scopes: Scope[] = []): Promise<void> {
    if (name === 'device-key' || scopes.includes('run_claim')) throw new HelperError('FILE_RUNS_REFUSED', 'Agent runs require Keychain storage.');
    if (!secret || secret.length > 8192) throw new HelperError('SECRET_INVALID', 'The helper secret is invalid.');
    const value = { ...await this.values(), [name]: secret };
    await atomicWrite(this.path, JSON.stringify(value) + '\n');
    if (await this.get(name) !== secret) throw new HelperError('SECRET_STORE_FAILED', 'The helper could not verify its token file.');
  }
  async delete(name: SecretName): Promise<void> {
    const value = await this.values();
    if (value[name] === undefined) return;
    delete value[name];
    if (Object.keys(value).length) await atomicWrite(this.path, JSON.stringify(value) + '\n');
    else {
      await readPrivateFile(this.path, 16_384);
      // The no-follow read and path check refuse links before removal.
      if ((await lstat(this.path)).isSymbolicLink()) throw new HelperError('FILE_UNSAFE', 'The helper refuses linked token files.');
      await unlink(this.path);
    }
  }
}
