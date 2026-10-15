import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

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

// execFile never invokes a shell. Failed commands are redacted because security
// may echo its stdin, and tool output may contain credentials.
export const runCommand: Runner = (file, args, options = {}) => new Promise((done, reject) => {
  const child = execFile(file, [...args], {
    env: cleanEnvironment(options.env), timeout: options.timeout ?? 10_000, signal: options.signal,
    maxBuffer: 1024 * 1024, encoding: 'utf8',
  }, (error, stdout, stderr) => {
    if (error) reject(new CommandError(typeof error.code === 'number' ? error.code : undefined));
    else done({ stdout, stderr });
  });
  child.stdin?.on('error', () => {});
  child.stdin?.end(options.input);
});

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

export type HelperConfig = { endpoint: URL; home: string; dataDir: string; env: NodeJS.ProcessEnv };
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

export function readConfig(env: NodeJS.ProcessEnv = process.env, home = homedir()): HelperConfig {
  if (!isAbsolute(home) || (env.MADDOTS_AI_HOME && !isAbsolute(env.MADDOTS_AI_HOME))) {
    throw new HelperError('CONFIG_INVALID', 'The helper home override must be an absolute path.');
  }
  return { endpoint: endpointUrl(env), home: resolve(home), dataDir: resolve(env.MADDOTS_AI_HOME ?? join(home, 'Library/Application Support/maddots-ai')), env };
}
