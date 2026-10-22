import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import type { ReadStream } from 'node:tty';
import { CommandError, HelperError, cleanEnvironment, runCommand, type Runner } from './config.js';
import { RELEASE } from './release-identity.js';

export type ProviderKeyName = 'deepseek';
const SERVICE = 'app.maddots.ai.provider-key';
export const isValidDeepseekKey = (value: string): boolean => /^sk-[A-Za-z0-9_-]{20,200}$/u.test(value);
const quote = (value: string) => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';

/** Provider keys belong to the computer, independently of helper pairings. */
export class KeychainProviderKeyStore {
  private readonly binary: string;
  constructor(private readonly runner: Runner = runCommand, private readonly env: NodeJS.ProcessEnv = process.env) {
    this.binary = !RELEASE && env.MADDOTS_AI_SECURITY_BIN ? env.MADDOTS_AI_SECURITY_BIN : '/usr/bin/security';
    if (!isAbsolute(this.binary)) throw new HelperError('CONFIG_INVALID', 'The security command must be an absolute path.');
  }
  async get(provider: ProviderKeyName): Promise<string | undefined> {
    try {
      const result = await this.runner(this.binary, ['find-generic-password', '-w', '-s', SERVICE, '-a', provider], {env: cleanEnvironment(this.env)});
      const key = result.stdout.replace(/\r?\n$/, '');
      if (!isValidDeepseekKey(key)) throw new Error();
      return key;
    } catch (error) {
      if (error instanceof CommandError && error.exitCode === 44) return;
      throw new HelperError('SECRET_STORE_FAILED', 'The helper could not read its provider Keychain item.');
    }
  }
  private async write(provider: ProviderKeyName, key: string): Promise<void> {
    await this.runner(this.binary, ['-i'], {
      input: `add-generic-password -U -s ${quote(SERVICE)} -a ${quote(provider)} -w ${quote(key)}\n`,
      env: cleanEnvironment(this.env),
    });
  }
  async set(provider: ProviderKeyName, key: string): Promise<void> {
    if (!isValidDeepseekKey(key)) throw new HelperError('PROVIDER_KEY_INVALID', 'A DeepSeek API key must start with sk- followed by 20 to 200 letters, digits, hyphens (-), or underscores (_).');
    const previous = await this.get(provider);
    try {
      await this.write(provider, key);
      if (await this.get(provider) !== key) throw new Error();
    } catch {
      if (previous === undefined) await this.delete(provider).catch(() => {});
      else await this.write(provider, previous).catch(() => {});
      throw new HelperError('SECRET_STORE_FAILED', 'The helper could not verify the provider Keychain update.');
    }
  }
  async delete(provider: ProviderKeyName): Promise<void> {
    try {
      await this.runner(this.binary, ['delete-generic-password', '-s', SERVICE, '-a', provider], {env: cleanEnvironment(this.env)});
    } catch (error) {
      if (!(error instanceof CommandError && error.exitCode === 44)) throw new HelperError('SECRET_STORE_FAILED', 'The helper could not remove its provider Keychain item.');
    }
  }
}

/** Readline handles editing and raw-mode restoration, while its output is discarded. */
export async function readProviderKey(input: ReadStream = process.stdin, output: Writable = process.stdout): Promise<string> {
  if (!input.isTTY) throw new HelperError('PROVIDER_KEY_TTY_REQUIRED', 'Setting a provider key requires an interactive terminal on this computer.');
  output.write('DeepSeek API key: ');
  const muted = new Writable({write(_chunk, _encoding, callback) {callback();}});
  const reader = createInterface({input, output: muted, terminal: true, crlfDelay: Infinity});
  try {
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      reader.once('line', key => {settled = true; resolve(key); reader.close();});
      reader.once('SIGINT', () => {reader.close();});
      reader.once('close', () => {
        if (!settled) reject(new HelperError('CANCELLED', 'The provider key prompt was cancelled.'));
      });
      reader.once('error', () => {reader.close();});
    });
  } finally {
    reader.close();
    muted.end();
    output.write('\n');
  }
}
