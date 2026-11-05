import {constants as C, type Stats} from 'node:fs';
import {lstat, mkdir, open, rename, unlink, type FileHandle} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname, isAbsolute, join, normalize} from 'node:path';
import {parseJsonWithoutDuplicateKeys} from '../shared/strict-json.js';
import {HelperError, clock, type Timing} from '../config.js';
import type {WriteGuardRelease} from '../write-lock.js';
import * as writeLock from '../write-lock.js';
import {prepareProviderLogin, selectedLoginError, safeSelectedLoginError,
  type LinuxSelectedLoginBinding, type LinuxSelectedLoginTool, type ProviderLoginOptions} from './linux-login-provider.js';

export type {LinuxSelectedLoginBinding, LinuxSelectedLoginTool} from './linux-login-provider.js';
export type LinuxSelectedLoginSelection = Readonly<{tool: LinuxSelectedLoginTool; profilePath: string}>;
export type LinuxSelectedLoginOptions = Partial<ProviderLoginOptions> & {
  /** Production is the dedicated mdai UID. Overrides are for synthetic fixtures. */
  uid?: number; trustedAncestorUid?: number; timing?: Timing; lockDeadline?: number;
  checkpoint?: (point: string) => void | Promise<void>;
};
const MAX = 64 * 1024;
const RECORD_MAX = MAX;
const CLOSE_ON_EXEC = 0x80000;
const RUN_RECORD = '.selected-login.json';
const STAGE = '.selected-login-stage';
const FILES = Object.freeze({codex: 'auth.json', claude: 'oauth-token'});
const FRAGMENT_BYTES = 16;
const PUBLIC_MAX = 64 * 1024 * 1024;
const HASH_BASE = 16777619;
const HASH_POWER = Array.from({length: FRAGMENT_BYTES}).reduce<number>(value => Math.imul(value, HASH_BASE), 1);
const HASH_FILTER_MASK = (1 << 20) - 1;
const BASE64_VALUES = new Int16Array(256).fill(-1);
for (const [index, value] of Buffer.from('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/').entries()) {
  BASE64_VALUES[value] = index;
}
BASE64_VALUES[45] = 62; BASE64_VALUES[95] = 63;
const HEX_VALUES = new Int16Array(256).fill(-1);
for (const [index, value] of Buffer.from('0123456789abcdef').entries()) HEX_VALUES[value] = index;
for (const [index, value] of Buffer.from('ABCDEF').entries()) HEX_VALUES[value] = index + 10;
const encodedWhitespace = (value: number) => value === 32 || (value >= 9 && value <= 13);
const hexSeparator = (value: number) => encodedWhitespace(value) || value === 45 || value === 58;
const ref = (file: FileHandle) => `/proc/self/fd/${file.fd}`;
const identity = (info: {dev: number; ino: number}) => `${info.dev}:${info.ino}`;
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
function refuse(code?: Parameters<typeof selectedLoginError>[0]): never {throw selectedLoginError(code);}
/** Internal publication policy signal, with the same sanitized public error.
 * Workspace callers may withhold only this incompletely scanned artifact. */
export class SelectedLoginScanIncompleteError extends HelperError {
  constructor() {
    const error = selectedLoginError(); super(error.code, error.message);
  }
}
function incomplete(): never {throw new SelectedLoginScanIncompleteError();}

/** Index only exact credential bytes, never document syntax or decoded JWT
 * claims. Every lookup verifies bytes; an eight-entry collision cap makes the
 * work per input byte bounded even for adversarial rolling-hash collisions. */
class CredentialFragments {
  readonly filter = new Uint8Array(HASH_FILTER_MASK + 1);
  readonly buckets = new Map<number, Buffer[]>();
  readonly shortPatterns: Buffer[] = [];
  minimumBytes = FRAGMENT_BYTES;
  private readonly shortForms = new Set<string>();
  constructor(tokens: ReadonlySet<string>) {
    let total = 0;
    for (const token of tokens) {
      const bytes = Buffer.from(token); total += bytes.length;
      if (total > 3 * MAX) incomplete();
      if (bytes.length < FRAGMENT_BYTES) {
        // Preserve the existing whole-value protection for unusually short
        // source credentials without lowering the partial-token threshold.
        for (const form of [token, JSON.stringify(token).slice(1, -1), encodeURIComponent(token),
          bytes.toString('base64'), bytes.toString('base64url'), bytes.toString('hex')]) this.shortForms.add(form);
        this.shortPatterns.push(bytes); this.minimumBytes = Math.min(this.minimumBytes, bytes.length);
        continue;
      }
      let hash = 0;
      for (let index = 0; index < bytes.length; index++) {
        hash = (Math.imul(hash, HASH_BASE) + bytes[index] -
          (index >= FRAGMENT_BYTES ? Math.imul(bytes[index - FRAGMENT_BYTES], HASH_POWER) : 0)) >>> 0;
        if (index + 1 < FRAGMENT_BYTES) continue;
        const pattern = bytes.subarray(index + 1 - FRAGMENT_BYTES, index + 1), bucket = this.buckets.get(hash);
        if (bucket?.some(existing => existing.equals(pattern))) continue;
        if (bucket && bucket.length >= 8) incomplete();
        if (bucket) bucket.push(pattern); else this.buckets.set(hash, [pattern]);
        this.filter[hash & HASH_FILTER_MASK] = 1;
      }
    }
  }
  assertRaw(bytes: Buffer): void {
    for (const form of this.shortForms) if (bytes.includes(form)) refuse();
    let hash = 0;
    for (let index = 0; index < bytes.length; index++) {
      hash = (Math.imul(hash, HASH_BASE) + bytes[index] -
        (index >= FRAGMENT_BYTES ? Math.imul(bytes[index - FRAGMENT_BYTES], HASH_POWER) : 0)) >>> 0;
      if (index + 1 < FRAGMENT_BYTES || !this.filter[hash & HASH_FILTER_MASK]) continue;
      const bucket = this.buckets.get(hash);
      if (!bucket) continue;
      for (const pattern of bucket) {
        let offset = 0;
        while (offset < FRAGMENT_BYTES && pattern[offset] === bytes[index + 1 - FRAGMENT_BYTES + offset]) offset++;
        if (offset === FRAGMENT_BYTES) refuse();
      }
    }
  }
  assertEncoded(bytes: Buffer): void {
    const cursor = new FragmentCursor(this);
    // Decode publication views, not stored tokens. Trying four base64 phases
    // catches standalone fragments and fragments embedded in a longer encoded
    // value, including when surrounding text joins the same alphabetic run.
    // Layout whitespace never resets a quantum, phase or fragment window.
    for (let start = 0; start < bytes.length;) {
      if (BASE64_VALUES[bytes[start]] < 0) {start++; continue;}
      let end = start + 1, symbols = 1;
      for (; end < bytes.length; end++) {
        if (BASE64_VALUES[bytes[end]] >= 0) symbols++;
        else if (!encodedWhitespace(bytes[end])) break;
      }
      for (let phase = 0; phase < 4 && symbols - phase >= Math.ceil(this.minimumBytes * 8 / 6); phase++) {
        cursor.reset(); let word = 0, bits = 0, skip = phase;
        for (let index = start; index < end; index++) {
          const value = BASE64_VALUES[bytes[index]];
          if (value < 0) continue;
          if (skip) {skip--; continue;}
          word = (word << 6) | value; bits += 6;
          if (bits >= 8) {bits -= 8; cursor.push((word >>> bits) & 255);}
        }
      }
      start = end;
    }
    // Both nibble alignments are needed when unrelated adjacent text is hex.
    // Hex dumps can separate even individual nibbles with whitespace, ':' or '-'.
    for (let start = 0; start < bytes.length;) {
      if (HEX_VALUES[bytes[start]] < 0) {start++; continue;}
      let end = start + 1, symbols = 1;
      for (; end < bytes.length; end++) {
        if (HEX_VALUES[bytes[end]] >= 0) symbols++;
        else if (!hexSeparator(bytes[end])) break;
      }
      for (let phase = 0; phase < 2 && symbols - phase >= 2 * this.minimumBytes; phase++) {
        cursor.reset(); let nibble = -1, skip = phase;
        for (let index = start; index < end; index++) {
          const value = HEX_VALUES[bytes[index]];
          if (value < 0) continue;
          if (skip) {skip--; continue;}
          if (nibble < 0) nibble = value;
          else {cursor.push((nibble << 4) | value); nibble = -1;}
        }
      }
      start = end;
    }
    if (!bytes.includes(37)) return;
    cursor.reset();
    for (let index = 0; index < bytes.length; index++) {
      if (bytes[index] === 37 && index + 2 < bytes.length && HEX_VALUES[bytes[index + 1]] >= 0 && HEX_VALUES[bytes[index + 2]] >= 0) {
        cursor.push((HEX_VALUES[bytes[index + 1]] << 4) | HEX_VALUES[bytes[index + 2]]); index += 2;
      } else cursor.push(bytes[index]);
    }
  }
}
/** A reusable fixed-size window keeps decoded views allocation-free, including
 * binary fragments that are not valid UTF-8. */
class FragmentCursor {
  private readonly bytes = new Uint8Array(FRAGMENT_BYTES);
  private hash = 0;
  private count = 0;
  private next = 0;
  constructor(private readonly fragments: CredentialFragments) {}
  reset(): void {this.bytes.fill(0); this.hash = 0; this.count = 0; this.next = 0;}
  push(byte: number): void {
    this.hash = (Math.imul(this.hash, HASH_BASE) + byte - Math.imul(this.bytes[this.next], HASH_POWER)) >>> 0;
    this.bytes[this.next] = byte; this.next = (this.next + 1) & (FRAGMENT_BYTES - 1);
    if (this.count < FRAGMENT_BYTES) this.count++;
    for (const pattern of this.fragments.shortPatterns) {
      if (this.count < pattern.length) continue;
      let offset = 0;
      while (offset < pattern.length && pattern[offset] === this.bytes[(this.next + FRAGMENT_BYTES - pattern.length + offset) & (FRAGMENT_BYTES - 1)]) offset++;
      if (offset === pattern.length) refuse();
    }
    if (this.count < FRAGMENT_BYTES || !this.fragments.filter[this.hash & HASH_FILTER_MASK]) return;
    const bucket = this.fragments.buckets.get(this.hash);
    if (!bucket) return;
    for (const pattern of bucket) {
      let offset = 0;
      while (offset < FRAGMENT_BYTES && pattern[offset] === this.bytes[(this.next + offset) & (FRAGMENT_BYTES - 1)]) offset++;
      if (offset === FRAGMENT_BYTES) refuse();
    }
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) refuse();
}
function string(value: unknown, limit = 16384): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !/\p{Cc}/u.test(value);
}
function parsed(bytes: Buffer): Record<string, unknown> {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) refuse();
  let value: unknown;
  try {value = parseJsonWithoutDuplicateKeys(text);} catch {refuse();}
  if (!object(value)) refuse();
  return value;
}
function binding(bytes: Buffer, tool: LinuxSelectedLoginTool): LinuxSelectedLoginBinding {
  const value = parsed(bytes);
  keys(value, ['version', 'tool', 'profileId', 'accountBinding', 'subjectBinding', 'userBinding', 'organizationBinding', 'expiresAt', 'files']);
  if (value.version !== 1 || value.tool !== tool || !string(value.profileId, 256) || !string(value.accountBinding, 256)) refuse();
  for (const key of ['subjectBinding', 'userBinding', 'organizationBinding']) {
    if (value[key] !== undefined && !string(value[key], 256)) refuse();
  }
  if (tool === 'codex' && !string(value.subjectBinding, 256)) refuse();
  if (tool === 'claude') {
    // Founder provisioning is the authority for this opaque setup token. An
    // unpinned profile must refuse before we even open its credential source.
    if (!object(value.files) || Object.keys(value.files).length !== 1 ||
        typeof value.files['oauth-token'] !== 'string' || !/^[a-f0-9]{64}$/u.test(value.files['oauth-token'])) {
      refuse('LINUX_SELECTED_LOGIN_CLAUDE_IDENTITY_UNAVAILABLE');
    }
  } else if (value.files !== undefined) refuse();
  if (value.expiresAt !== undefined && (!Number.isSafeInteger(value.expiresAt) || Number(value.expiresAt) <= 0)) refuse();
  return Object.freeze(value) as LinuxSelectedLoginBinding;
}
function privateFile(info: Stats, uid: number, maximum: number): void {
  if (!info.isFile() || info.uid !== uid || (info.mode & 0o7777) !== 0o600 || info.nlink !== 1 || info.size < 1 || info.size > maximum) refuse();
}
function privateDirectory(info: Stats, uid: number): void {
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o7777) !== 0o700) refuse();
}
type Snapshot = {bytes: Buffer; info: Stats; file: FileHandle};
async function snapshot(path: string, uid: number, maximum = MAX): Promise<Snapshot> {
  const file = await open(path, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK | CLOSE_ON_EXEC);
  try {
    const before = await file.stat(); privateFile(before, uid, maximum);
    const bytes = Buffer.alloc(before.size + 1); let length = 0;
    while (length < bytes.length) {
      const next = await file.read(bytes, length, bytes.length - length, length);
      if (!next.bytesRead) break; length += next.bytesRead;
    }
    const after = await file.stat(); privateFile(after, uid, maximum);
    if (length !== before.size || identity(before) !== identity(after) || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || identity(await lstat(path)) !== identity(after)) refuse();
    return {file, info: after, bytes: bytes.subarray(0, length)};
  } catch (error) {await file.close(); throw error;}
}
async function read(path: string, uid: number, maximum = MAX): Promise<Buffer> {
  const value = await snapshot(path, uid, maximum);
  try {return value.bytes;} finally {await value.file.close();}
}
function unchanged(before: Snapshot, current: Snapshot): boolean {
  return identity(before.info) === identity(current.info) && before.info.size === current.info.size &&
    before.info.mtimeMs === current.info.mtimeMs && before.info.ctimeMs === current.info.ctimeMs && before.bytes.equals(current.bytes);
}
/** Fixed reserved temporary basenames are the only orphan files we remove.
 * Keep the descriptor while comparing/unlinking; never follow or repair aliases. */
async function removeTemporary(directory: {location: string; file: FileHandle; current(): Promise<void>}, name: string, uid: number): Promise<void> {
  await directory.current();
  const path = join(directory.location, name); let file: FileHandle;
  try {file = await open(path, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK | CLOSE_ON_EXEC);}
  catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error;}
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== uid || (info.mode & 0o7777) !== 0o600 || info.nlink !== 1 || info.size > RECORD_MAX ||
      identity(info) !== identity(await lstat(path))) refuse();
    await unlink(path); await directory.file.sync();
  } finally {await file.close();}
}
/** Every component is opened through the retained parent FD, including the final
 * private directory. Rechecking all links detects replacement of any ancestor. */
class Directory {
  private constructor(readonly path: string, readonly uid: number,
    private readonly chain: {file: FileHandle; info: Stats; link: string}[]) {}
  static async retain(path: string, uid: number, ancestorUid = 0): Promise<Directory> {
    if (!isAbsolute(path) || normalize(path) !== path || path === '/' || path.includes('\0')) refuse();
    const chain: {file: FileHandle; info: Stats; link: string}[] = [];
    try {
      const root = await open('/', C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW | CLOSE_ON_EXEC);
      chain.push({file: root, info: await root.stat(), link: '/'});
      const parts = path.slice(1).split('/');
      for (const [index, part] of parts.entries()) {
        const link = join(ref(chain.at(-1)!.file), part);
        const file = await open(link, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW | CLOSE_ON_EXEC);
        const info = await file.stat(); chain.push({file, info, link});
        if (index === parts.length - 1) privateDirectory(info, uid);
        else if (!info.isDirectory() || !((info.uid === ancestorUid && ((info.mode & 0o022) === 0 || (info.mode & 0o1000) !== 0)) ||
          (info.uid === uid && (info.mode & 0o7777) === 0o700))) refuse();
      }
      const result = new Directory(path, uid, chain); await result.current(); return result;
    } catch (error) {await Promise.allSettled(chain.map(row => row.file.close())); throw error;}
  }
  get file(): FileHandle {return this.chain.at(-1)!.file;}
  get id(): string {return identity(this.chain.at(-1)!.info);}
  get location(): string {return ref(this.file);}
  async current(): Promise<void> {
    for (const [index, row] of this.chain.entries()) {
      const held = await row.file.stat(), linked = await lstat(row.link);
      if (identity(held) !== identity(row.info) || identity(linked) !== identity(row.info) || held.uid !== row.info.uid ||
        held.mode !== row.info.mode || !held.isDirectory() || !linked.isDirectory()) refuse();
      if (index === this.chain.length - 1) privateDirectory(held, this.uid);
    }
  }
  async close(): Promise<void> {
    const results = await Promise.allSettled(this.chain.map(row => row.file.close()));
    if (results.some(row => row.status === 'rejected')) refuse();
  }
}

/** The profile flock covers validation, refresh and atomic source persistence.
 * Only a controller-synthesized, nonrenewable document crosses into S3. */
export class LinuxSelectedLogin {
  private source?: Snapshot;
  private selectionFile?: Snapshot;
  private profile?: Directory;
  private runDirectory?: Directory;
  private work?: Directory;
  private unlock?: WriteGuardRelease;
  private stagedBytes?: Buffer;
  private completed = false;
  private guardAvailable = true;
  private closed = false;
  private staging = false;
  private refreshPending = false;
  private readonly tokens = new Set<string>();
  private fragments?: CredentialFragments;
  private readonly uid: number;
  private constructor(private readonly selection: LinuxSelectedLoginSelection, private readonly options: LinuxSelectedLoginOptions) {
    this.uid = options.uid ?? 999;
  }
  private remember(bytes: Buffer): void {
    this.fragments = undefined;
    if (this.selection.tool === 'claude') {this.tokens.add(bytes.toString('utf8')); return;}
    const tokens = parsed(bytes).tokens;
    if (object(tokens)) for (const key of ['id_token', 'access_token', 'refresh_token', 'account_id']) {
      if (typeof tokens[key] === 'string' && tokens[key]) this.tokens.add(tokens[key]);
    }
  }
  assertPublicContent(content: Buffer | string): void {
    if (!this.completed || !this.guardAvailable) refuse();
    if (content.length > PUBLIC_MAX) incomplete();
    if (typeof content === 'string' && Buffer.byteLength(content) > PUBLIC_MAX) incomplete();
    let bytes = typeof content === 'string' ? Buffer.from(content) : content;
    if (bytes.length > PUBLIC_MAX) incomplete();
    const fragments = this.fragments ??= new CredentialFragments(this.tokens);
    // Bound normalization work as well as individual artifact size. Small
    // nested JSON values retain the 32-view allowance; large views cannot
    // multiply the artifact scan without limit.
    let budget = Math.max(4 * bytes.length, 4 * MAX);
    // JSONL logs and published JSON can spell any character as a Unicode escape.
    // Inspect decoded views before any bytes leave the controller, including
    // nested JSON strings. Excessive nesting refuses publication, never skips it.
    for (let depth = 0; depth < 32; depth++) {
      budget -= bytes.length; if (budget < 0) incomplete();
      fragments.assertRaw(bytes); fragments.assertEncoded(bytes);
      if (!bytes.includes(92)) return;
      const text = bytes.toString('utf8');
      const decoded = text.replace(/\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/gu, (_match, hex: string | undefined, escape: string) =>
        hex !== undefined ? String.fromCharCode(parseInt(hex, 16)) :
          ({'"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t'} as Record<string, string>)[escape]);
      if (decoded === text) return;
      bytes = Buffer.from(decoded);
    }
    incomplete();
  }
  private async point(name: string): Promise<void> {await this.options.checkpoint?.(name);}
  private get refreshMarker(): string {return `.mdai-selected-login-${this.selection.tool}.refresh.json`;}
  private async beginRefresh(): Promise<void> {
    await this.current();
    const file = await open(join(this.profile!.location, this.refreshMarker),
      C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW | CLOSE_ON_EXEC, 0o600);
    try {
      await file.writeFile(JSON.stringify({version: 2, kind: 'controller-refresh', source: digest(this.source!.bytes)}) + '\n');
      await file.sync();
    } finally {await file.close();}
    await this.profile!.file.sync(); this.refreshPending = true;
    await this.point('refresh:intent');
  }
  private async current(): Promise<void> {
    if (this.closed || !this.profile || !this.unlock || !this.selectionFile || !this.source) refuse();
    await this.profile.current(); await this.unlock.assertCurrent();
    for (const [name, before] of [['selected-login.json', this.selectionFile], [FILES[this.selection.tool], this.source]] as const) {
      const current = await snapshot(join(this.profile.location, name), this.uid);
      try {if (!unchanged(before, current)) refuse('LINUX_SELECTED_LOGIN_CONFLICT');} finally {await current.file.close();}
    }
  }
  /** Never accepts a workload candidate. Callers hold the original profile flock. */
  private async persistSource(bytes: Buffer): Promise<void> {
    const profile = this.profile!, name = FILES[this.selection.tool];
    const temporaryName = `.mdai-selected-login-${this.selection.tool}.source.tmp`;
    await removeTemporary(profile, temporaryName, this.uid);
    const temporary = join(profile.location, temporaryName);
    let file: FileHandle | undefined;
    try {
      file = await open(temporary, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW | CLOSE_ON_EXEC, 0o600);
      await file.writeFile(bytes); await this.point('source:write');
      await file.sync(); await this.point('source:file-sync');
      await this.current();
      await rename(temporary, join(profile.location, name));
      await this.point('source:rename');
      await profile.file.sync(); await this.point('source:directory-sync');
      const next = await snapshot(join(profile.location, name), this.uid);
      if (identity(next.info) !== identity(await file.stat()) || !next.bytes.equals(bytes)) {
        await next.file.close(); refuse('LINUX_SELECTED_LOGIN_CONFLICT');
      }
      await this.source!.file.close(); this.source = next;
    } finally {
      await file?.close();
      // The provider may already have rotated. Keep the private candidate and
      // uncertainty marker on failure; never silently retry the stale grant.
    }
  }
  static async open(selection: LinuxSelectedLoginSelection, options: LinuxSelectedLoginOptions = {}): Promise<LinuxSelectedLogin> {
    const lease = new LinuxSelectedLogin(Object.freeze({...selection}), options);
    try {
      if (process.platform !== 'linux' || process.getuid?.() !== lease.uid ||
          (selection.tool !== 'codex' && selection.tool !== 'claude')) refuse();
      if (!Number.isFinite(options.deadline) || options.deadline! <= (options.now?.() ?? Date.now())) refuse('LINUX_SELECTED_LOGIN_EXPIRED');
      // A Darwin revision-1 repair retains an older write-lock module. Resolve
      // this Linux-only capability at use time, before opening the profile.
      const acquireDirectoryWriteGuard = writeLock.acquireDirectoryWriteGuard;
      if (typeof acquireDirectoryWriteGuard !== 'function') refuse();
      lease.profile = await Directory.retain(selection.profilePath, lease.uid, options.trustedAncestorUid);
      const timing = options.timing ?? clock;
      const lockDeadline = Math.min(options.lockDeadline ?? timing.now() + 5000, options.deadline!);
      // A concurrent in-process flock utility may still be settling. Wait for
      // that retained utility rather than acquiring a second descriptor early.
      while (!lease.unlock) {
        try {lease.unlock = await acquireDirectoryWriteGuard(lease.profile.file, timing, lockDeadline);}
        catch (error) {
          if (!(error instanceof HelperError) || error.code !== 'HELPER_BUSY' || timing.now() >= lockDeadline) throw error;
          await timing.sleep(Math.min(25, lockDeadline - timing.now()));
        }
      }
      await lease.profile.current();
      lease.selectionFile = await snapshot(join(lease.profile.location, 'selected-login.json'), lease.uid);
      const selected = binding(lease.selectionFile.bytes, selection.tool);
      // The obsolete write-back protocol is never replayed or silently removed.
      try {await lstat(join(lease.profile.location, `.mdai-selected-login-${selection.tool}.json`)); refuse('LINUX_SELECTED_LOGIN_CONFLICT');}
      catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
      try {await lstat(join(lease.profile.location, lease.refreshMarker)); refuse('LINUX_SELECTED_LOGIN_CONFLICT');}
      catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
      lease.source = await snapshot(join(lease.profile.location, FILES[selection.tool]), lease.uid);
      await lease.current();
      lease.remember(lease.source.bytes);
      const prepared = await prepareProviderLogin(selection.tool, selected, lease.source.bytes, {
        deadline: options.deadline!, fetch: options.fetch, now: options.now, beforeRefresh: () => lease.beginRefresh(),
      });
      lease.remember(prepared.source); lease.remember(prepared.staged);
      if (!prepared.source.equals(lease.source.bytes)) await lease.persistSource(prepared.source);
      await lease.current(); lease.stagedBytes = prepared.staged;
      if (lease.refreshPending) {
        await unlink(join(lease.profile.location, lease.refreshMarker)); await lease.profile.file.sync();
        lease.refreshPending = false;
      }
      return lease;
    } catch (error) {await lease.close().catch(() => {}); throw safeSelectedLoginError(error);}
  }
  async stage(workPath: string, recoveryDirectory = dirname(workPath)): Promise<void> {
    try {
      await this.current();
      if (this.staging || this.completed || !this.stagedBytes) refuse();
      this.staging = true;
      if (workPath !== join(recoveryDirectory, 'work') || this.selection.profilePath === recoveryDirectory ||
          this.selection.profilePath.startsWith(recoveryDirectory + '/') || recoveryDirectory.startsWith(this.selection.profilePath + '/')) refuse();
      if (this.options.deadline! <= (this.options.now?.() ?? Date.now())) refuse('LINUX_SELECTED_LOGIN_EXPIRED');
      this.runDirectory = await Directory.retain(recoveryDirectory, this.uid, this.options.trustedAncestorUid);
      this.work = await Directory.retain(workPath, this.uid, this.options.trustedAncestorUid);
      // Protected controller snapshot contains only the exact synthesized bytes.
      // It is outside the /work mount; no refresh token is ever copied to a run.
      for (const [name, bytes] of [[STAGE, this.stagedBytes], [RUN_RECORD, Buffer.from(JSON.stringify({
        version: 2, tool: this.selection.tool, digest: digest(this.stagedBytes), runIdentity: this.runDirectory.id,
      }) + '\n')]] as const) {
        const file = await open(join(this.runDirectory.location, name), C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW | CLOSE_ON_EXEC, 0o600);
        try {await file.writeFile(bytes); await file.sync();} finally {await file.close();}
        await this.runDirectory.file.sync(); await this.point(`stage:${name}`);
      }
      const homePath = join(this.work.location, '.mdai-home');
      try {await mkdir(homePath, {mode: 0o700});} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;}
      const home = await open(homePath, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW | CLOSE_ON_EXEC);
      try {
        privateDirectory(await home.stat(), this.uid);
        const toolPath = join(ref(home), this.selection.tool);
        try {await mkdir(toolPath, {mode: 0o700});} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;}
        const tool = await open(toolPath, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW | CLOSE_ON_EXEC);
        try {
          privateDirectory(await tool.stat(), this.uid);
          const staged = await open(join(ref(tool), FILES[this.selection.tool]), C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW | CLOSE_ON_EXEC, 0o600);
          try {await staged.writeFile(this.stagedBytes); await staged.sync();} finally {await staged.close();}
          await tool.sync(); await home.sync(); await this.work.file.sync();
        } finally {await tool.close();}
      } finally {await home.close();}
      await this.point('stage:complete');
      await this.current();
      await this.releaseProfile();
    } catch (error) {throw safeSelectedLoginError(error);}
  }
  /** Only the retained containment authority may certify extinction. No reads of
   * the workload cache, profile mutation, network, or refresh occur here. */
  async complete(assertExtinct: () => Promise<void>): Promise<void> {
    if (this.completed) return;
    try {
      if (typeof assertExtinct !== 'function') refuse();
      await assertExtinct();
      if (this.runDirectory) {
        await this.runDirectory.current();
        await unlink(join(this.runDirectory.location, STAGE)).catch(error => {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;});
        await this.runDirectory.file.sync(); await this.point('stage:removed');
      }
      this.completed = true; await this.close();
    } catch (error) {throw safeSelectedLoginError(error);}
  }
  private async releaseProfile(): Promise<void> {
    const source = this.source, selection = this.selectionFile, unlock = this.unlock, profile = this.profile;
    this.source = undefined; this.selectionFile = undefined; this.unlock = undefined; this.profile = undefined;
    const results = await Promise.allSettled([source?.file.close(), selection?.file.close()]);
    try {await unlock?.();} finally {await profile?.close();}
    if (results.some(row => row.status === 'rejected')) refuse();
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true;
    try {await this.releaseProfile();}
    finally {
      const results = await Promise.allSettled([this.runDirectory?.close(), this.work?.close()]);
      this.runDirectory = undefined; this.work = undefined;
      if (results.some(row => row.status === 'rejected')) refuse();
    }
  }
  static async recover(data: string, uid: number, assertExtinct: () => Promise<void>,
    options: LinuxSelectedLoginOptions = {}): Promise<LinuxSelectedLogin | undefined> {
    let directory: Directory | undefined, lease: LinuxSelectedLogin | undefined;
    try {
      await assertExtinct();
      directory = await Directory.retain(data, uid, options.trustedAncestorUid);
      let bytes: Buffer;
      try {bytes = await read(join(directory.location, RUN_RECORD), uid);}
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // Missing marker proves staging did not reach any workload file.
        await removeTemporary(directory, STAGE, uid); return undefined;
      }
      const record = parsed(bytes); keys(record, ['version', 'tool', 'digest', 'runIdentity']);
      if (record.version !== 2 || (record.tool !== 'codex' && record.tool !== 'claude') ||
          typeof record.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(record.digest) || record.runIdentity !== directory.id) refuse();
      lease = new LinuxSelectedLogin({tool: record.tool, profilePath: ''}, {...options, uid});
      lease.runDirectory = directory; directory = undefined;
      try {
        const staged = await read(join(lease.runDirectory.location, STAGE), uid);
        if (digest(staged) !== record.digest) refuse();
        lease.remember(staged);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // A crash after erasure can retire but cannot publish without guards.
        lease.guardAvailable = false;
      }
      await lease.complete(assertExtinct); return lease;
    } catch (error) {await lease?.close().catch(() => {}); throw safeSelectedLoginError(error);}
    finally {await directory?.close();}
  }
}
export async function completeSelectedLogin(data: string, uid: number, assertExtinct: () => Promise<void>,
  options: LinuxSelectedLoginOptions = {}): Promise<LinuxSelectedLogin | undefined> {
  return LinuxSelectedLogin.recover(data, uid, assertExtinct, options);
}
