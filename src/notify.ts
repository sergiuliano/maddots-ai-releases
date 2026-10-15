import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, rename } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HelperError, cleanEnvironment, clock, endpointUrl, runCommand, type Runner, type Timing } from './config.js';
import { assertNoSymlinks, atomicWrite, ensurePrivateDirectory, readPrivateFile, type HelperPaths } from './paths.js';

export const ALLOW_NOTIFICATION_INTERVAL_MS = 4 * 60 * 60 * 1000;
export const ALLOW_DIALOG_GIVE_UP_S = ALLOW_NOTIFICATION_INTERVAL_MS / 1000 - 60;
export type WaitingNotification = { skillId: string; version: number; digests: readonly string[] };
export type PendingDialog = { count: number; command: string; fingerprint: string; reservedAt: number };
export type NotifyOptions = {
  runner?: Runner; timing?: Timing; execPath?: string; entrypoint?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal;
};
export type NotifyResult = 'empty' | 'unchanged' | 'throttled' | 'later' | 'opened';
type NotificationState = { format: 1; notifiedSets: string[]; lastDialogAt?: number; interruptedSet?: string };

function waitingSet(waiting: readonly WaitingNotification[]): { count: number; fingerprint: string } {
  const entries = new Map<string, Set<string>>();
  for (const item of waiting) {
    if (typeof item.skillId !== 'string' || !item.skillId || item.skillId.length > 255 || /[\p{Cc}\p{Cf}]/u.test(item.skillId) ||
        !Number.isSafeInteger(item.version) || item.version < 1 || !Array.isArray(item.digests) || !item.digests.length ||
        item.digests.some(digest => typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest))) {
      throw new HelperError('NOTIFY_INVALID', 'The waiting notification contains an invalid skill or digest.');
    }
    const key = JSON.stringify([item.skillId, item.version]);
    const digests = entries.get(key) ?? new Set<string>();
    for (const digest of item.digests) digests.add(digest);
    entries.set(key, digests);
  }
  const canonical = [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, digests]) => [key, [...digests].sort()]);
  return { count: entries.size, fingerprint: createHash('sha256').update(JSON.stringify(canonical)).digest('hex') };
}

async function readNotificationState(path: string): Promise<NotificationState> {
  let content: string;
  try { content = await readPrivateFile(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { format: 1, notifiedSets: [] };
    throw error;
  }
  try {
    const state = JSON.parse(content) as NotificationState;
    if (state.format !== 1 || !Array.isArray(state.notifiedSets) ||
        state.notifiedSets.some(hash => typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash)) ||
        new Set(state.notifiedSets).size !== state.notifiedSets.length ||
        (state.lastDialogAt !== undefined && (!Number.isSafeInteger(state.lastDialogAt) || state.lastDialogAt < 0)) ||
        (state.notifiedSets.length > 0 && state.lastDialogAt === undefined) ||
        (state.interruptedSet !== undefined && !state.notifiedSets.includes(state.interruptedSet)) ||
        Object.keys(state).some(key => !['format', 'notifiedSets', 'lastDialogAt', 'interruptedSet'].includes(key))) throw new Error();
    return state;
  } catch { throw new HelperError('NOTIFY_STATE_INVALID', 'The desktop notification state is invalid.'); }
}

function shellQuote(value: string): string {
  if (/[\p{Cc}\p{Cf}]/u.test(value)) throw new HelperError('NOTIFY_INVALID', 'The Allow launcher contains an invalid character.');
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function launcher(paths: HelperPaths, options: NotifyOptions): string {
  const executable = options.execPath ?? process.execPath;
  const entrypoint = options.entrypoint ?? fileURLToPath(new URL('./cli.js', import.meta.url));
  if (!isAbsolute(executable) || !isAbsolute(entrypoint)) {
    throw new HelperError('NOTIFY_INVALID', 'The Allow launcher needs absolute runtime and helper paths.');
  }
  const source = options.env ?? process.env;
  const env = {
    HOME: paths.home,
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    MADDOTS_AI_HOME: paths.data,
    MADDOTS_AI_URL: endpointUrl(source).origin,
    ...(source.MADDOTS_AI_ALLOW_INSECURE_LOOPBACK === '1' ? { MADDOTS_AI_ALLOW_INSECURE_LOOPBACK: '1' } : {}),
    ...(source.MADDOTS_AI_AUTO_UPDATE === '0' ? { MADDOTS_AI_AUTO_UPDATE: '0' } : {}),
  };
  // Terminal requires a .command script. This is the brief's explicit exception
  // to the no-shell rule; helper process execution still goes through Runner.
  return '#!/bin/sh\nexec /usr/bin/env -i ' + Object.entries(env).map(([key, value]) => shellQuote(`${key}=${value}`)).join(' ') +
    ' ' + shellQuote(executable) + ' ' + shellQuote(entrypoint) + ' allow\n';
}

async function assertLauncher(path: string): Promise<void> {
  await assertNoSymlinks(path);
  const info = await lstat(path);
  if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o777) !== 0o700) {
    throw new HelperError('PATH_UNSAFE', 'The Allow launcher must be a private executable file owned by this user.');
  }
}

async function writeLauncher(paths: HelperPaths, content: string): Promise<string> {
  const path = join(paths.data, 'allow.command');
  await assertNoSymlinks(path);
  try { await assertLauncher(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = join(paths.data, `.allow-${randomUUID()}.command`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o700);
  try { await file.writeFile(content); await file.sync(); }
  finally { await file.close(); }
  await assertNoSymlinks(path);
  await rename(temporary, path);
  await assertLauncher(path);
  const directory = await open(paths.data, constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
  return path;
}

/** Call while holding the helper write lock. Records the set and writes the launcher; shows nothing. */
export async function reserveWaitingDialog(paths: HelperPaths, waiting: readonly WaitingNotification[], options: NotifyOptions = {}): Promise<'empty' | 'unchanged' | 'throttled' | PendingDialog> {
  const set = waitingSet(waiting);
  if (!set.count) return 'empty';
  await ensurePrivateDirectory(paths.data);
  const statePath = join(paths.data, 'notification-state.json');
  const state = await readNotificationState(statePath);
  const interrupted = state.interruptedSet === set.fingerprint;
  if (!interrupted && state.notifiedSets.includes(set.fingerprint)) return 'unchanged';
  const now = (options.timing ?? clock).now();
  if (!Number.isSafeInteger(now) || now < 0) throw new HelperError('NOTIFY_INVALID', 'The notification clock is invalid.');
  if (!interrupted && state.lastDialogAt !== undefined && now - state.lastDialogAt < ALLOW_NOTIFICATION_INTERVAL_MS) return 'throttled';
  const next: NotificationState = { format: 1, notifiedSets: [...new Set([...state.notifiedSets, set.fingerprint])], lastDialogAt: now };
  const content = JSON.stringify(next) + '\n';
  if (Buffer.byteLength(content) > 1024 * 1024) throw new HelperError('NOTIFY_STATE_INVALID', 'The desktop notification state exceeded its size limit.');
  const command = await writeLauncher(paths, launcher(paths, options));
  // Reserve the attempt before displaying it so a crash or dialog failure cannot
  // repeatedly interrupt the person. Throttled sets are never marked as shown.
  await atomicWrite(statePath, content);
  return { count: set.count, command, fingerprint: set.fingerprint, reservedAt: now };
}

/** Call under the write lock after cancelling a service-owned child, retaining its set for restart. */
export async function interruptWaitingDialog(paths: HelperPaths, dialog: PendingDialog): Promise<void> {
  const statePath = join(paths.data, 'notification-state.json');
  const state = await readNotificationState(statePath);
  if (state.lastDialogAt !== dialog.reservedAt || !state.notifiedSets.includes(dialog.fingerprint)) return;
  await atomicWrite(statePath, JSON.stringify({ ...state, interruptedSet: dialog.fingerprint }) + '\n');
}

/** Call outside the helper write lock and do not await it from the sync tick. */
export async function showWaitingDialog(dialog: PendingDialog, options: NotifyOptions = {}): Promise<'later' | 'opened'> {
  const runner = options.runner ?? runCommand;
  const env = cleanEnvironment(options.env ?? process.env);
  const script = `display dialog "${dialog.count} skills with code wait for Allow on this computer" buttons {"Later", "Open Allow list"} default button "Later" with title "MadDots AI" giving up after ${ALLOW_DIALOG_GIVE_UP_S}`;
  const result = await runner('/usr/bin/osascript', ['-e', script], { env, timeout: (ALLOW_DIALOG_GIVE_UP_S + 60) * 1000, signal: options.signal });
  // AppleScript includes the give-up flag when the dialog has a deadline.
  if (result.stdout.trim() !== 'button returned:Open Allow list, gave up:false') return 'later';
  await assertLauncher(dialog.command);
  await runner('/usr/bin/open', ['-a', 'Terminal', dialog.command], { env, timeout: 10_000, signal: options.signal });
  return 'opened';
}

export async function notifyWaiting(paths: HelperPaths, waiting: readonly WaitingNotification[], options: NotifyOptions = {}): Promise<NotifyResult> {
  const pending = await reserveWaitingDialog(paths, waiting, options);
  return typeof pending === 'string' ? pending : showWaitingDialog(pending, options);
}
