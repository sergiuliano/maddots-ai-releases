import {constants as C} from 'node:fs';
import {open, lstat, mkdir, readdir, realpath, rename, rmdir, unlink, type FileHandle} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {HelperError} from '../config.js';
import {assertLinuxToolClosurePath} from '../linux-tool-closures.js';
import {SelectedLoginScanIncompleteError} from './linux-selected-login.js';

const fail = (): never => {throw new HelperError('LINUX_WORKSPACE_UNAVAILABLE', 'The isolated workspace could not be staged or published safely.');};
const inside = (root: string, path: string) => path === root || path.startsWith(root + '/');
const internal = new Set(['.mdai-runtime', '.mdai-home']);
// Credentials are explicitly selected per run. A workspace snapshot never
// imports host login/configuration stores or ambient dotenv credentials.
const excluded = (name: string) => internal.has(name) || ['.ssh', '.aws', '.gnupg', '.config', '.local', '.cache', '.codex', '.claude', '.docker',
  '.git', '.netrc', '.npmrc', '.pypirc', '.git-credentials', '.claude.json', '.credentials.json', 'auth.json', 'oauth-token', 'credentials.json',
  'selected-login.json'].includes(name) || name.startsWith('.selected-login') || name.startsWith('.mdai-selected-login-') ||
  name.startsWith('.mdai-login-') || name === '.env' || name.startsWith('.env.');
type Entry = {kind: 'file' | 'directory'; mode: number; digest?: string};
type Budget = {entries: number; bytes: number};
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const ref = (file: FileHandle) => `/proc/self/fd/${file.fd}`;
const id = (info: {dev: number; ino: number}) => `${info.dev}:${info.ino}`;
async function directory(path: string): Promise<FileHandle> {
  const file = await open(path, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
  if (!(await file.stat()).isDirectory()) {await file.close(); fail();}
  return file;
}
async function bytes(path: string, budget: Budget): Promise<{content: Buffer; mode: number}> {
  const file = await open(path, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > 64 * 1024 * 1024 || budget.bytes + before.size > 512 * 1024 * 1024) fail();
    // Failed reads also consume the scan budget. A series of interrupted files
    // must not cause unbounded allocation or I/O while clean siblings are scanned.
    budget.bytes += before.size;
    // Bound growth as well as the stat size. Do not let a hostile file extend
    // a controller read without limit after the initial size check.
    const content = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < content.length) {
      const read = await file.read(content, count, content.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const after = await file.stat();
    if (count !== before.size || id(before) !== id(after) || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail();
    return {content: content.subarray(0, count), mode: before.mode & 0o700};
  } finally {await file.close();}
}
async function writeNew(path: string, content: Buffer, mode: number): Promise<void> {
  const file = await open(path, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, mode | 0o600);
  try {await file.writeFile(content); await file.sync();} finally {await file.close();}
}

/** An isolated copy, never a bind mount of a user-supplied host directory. */
export class LinuxWorkspace {
  private source?: FileHandle;
  private sourceIdentity?: string;
  private work?: FileHandle;
  private baseline = new Map<string, Entry>();
  private omitted = new Set<string>();
  private excludedSourceIdentities = new Set<string>();
  private sourcePath?: string;
  private workPath?: string;
  private mappings: [string, string][] = [];
  private closed = false;

  constructor(private readonly workspace: string, private readonly controllerData: string,
    private readonly executable: string, private readonly runHome?: string,
    private readonly assertPublicContent?: (value: Buffer | string) => void,
    private readonly excludedRoots: readonly string[] = []) {}

  async stage(workPath: string): Promise<void> {
    if (this.work || this.closed) fail();
    this.workPath = workPath; this.work = await directory(workPath);
    if (this.workspace !== '/work') {
      const source = await realpath(this.workspace);
      const forbidden = ['/', homedir(), '/home', '/root', '/var/lib/mdai', '/run', '/proc', '/sys', '/etc', '/usr'];
      if (forbidden.includes(source) || ['/proc', '/sys', '/run', '/etc'].some(path => inside(path, source)) ||
        inside(source, resolve(this.controllerData)) || inside(resolve(this.controllerData), source)) fail();
      this.sourcePath = source; this.source = await directory(source);
      this.sourceIdentity = id(await this.source.stat());
      for (const root of this.excludedRoots) {
        const canonical = await realpath(root), rootIdentity = id(await lstat(canonical));
        if (inside(source, canonical) || inside(canonical, source) || rootIdentity === this.sourceIdentity) fail();
        this.excludedSourceIdentities.add(rootIdentity);
      }
      this.mappings.push([source, '/work']);
      await this.copy(this.source, this.work, '', this.baseline, {entries: 0, bytes: 0});
    }
    if (this.runHome) {
      // This is only the fresh helper-created run home supplied by startTool.
      // Host HOME and arbitrary config roots are never accepted here.
      const home = await realpath(this.runHome), data = await realpath(this.controllerData);
      if (!inside(join(data, 'run-homes'), home) || home === join(data, 'run-homes')) fail();
      await mkdir(join(ref(this.work), '.mdai-home'), {mode: 0o700});
      const from = await directory(home), to = await directory(join(ref(this.work), '.mdai-home'));
      try {await this.copy(from, to, '', new Map(), {entries: 0, bytes: 0}, false);} finally {await from.close(); await to.close();}
      this.mappings.push([home, '/work/.mdai-home']);
    }
    const executable = await realpath(this.executable);
    await assertLinuxToolClosurePath(this.executable);
    await assertLinuxToolClosurePath(executable);
    if (!executable.startsWith('/usr/') && !this.mappings.some(([source]) => inside(source, executable))) {
      // A selected executable is data until the guardian executes it inside
      // the sandbox. Only this file is copied, never its host config/home.
      await mkdir(join(ref(this.work), '.mdai-runtime'), {mode: 0o700});
      const runtime = await directory(join(ref(this.work), '.mdai-runtime'));
      try {
        const selected = await bytes(executable, {entries: 0, bytes: 0});
        if (!(selected.mode & 0o100)) fail();
        await writeNew(join(ref(runtime), basename(executable)), selected.content, 0o700);
      } finally {await runtime.close();}
      this.mappings.push([executable, '/work/.mdai-runtime/' + basename(executable)]);
    }
    this.mappings.sort((a, b) => b[0].length - a[0].length);
    await this.work.sync();
  }
  map(value: string): string {
    for (const [source, destination] of this.mappings) value = value.replaceAll(source, destination);
    return value;
  }
  hostExecutable(): string {
    const mapped = this.map(this.executable);
    return mapped.startsWith('/work/') ? this.workPath! + mapped.slice('/work'.length) : mapped;
  }
  private async copy(from: FileHandle, to: FileHandle, prefix: string, entries: Map<string, Entry>, budget: Budget,
    omit = true): Promise<void> {
    for (const name of (await readdir(ref(from))).sort()) {
      if (++budget.entries > 50_000) fail();
      const key = prefix ? prefix + '/' + name : name;
      if (omit && excluded(name)) {this.omitted.add(key); continue;}
      const path = join(ref(from), name), info = await lstat(path);
      if (this.excludedSourceIdentities.has(id(info))) fail();
      if (info.isDirectory()) {
        const child = await directory(path);
        await mkdir(join(ref(to), name), {mode: 0o700});
        const target = await directory(join(ref(to), name));
        try {entries.set(key, {kind: 'directory', mode: 0o700}); await this.copy(child, target, key, entries, budget, omit);}
        finally {await target.close(); await child.close();}
      } else {
        const selected = await bytes(path, budget);
        entries.set(key, {kind: 'file', mode: selected.mode, digest: digest(selected.content)});
        await writeNew(join(ref(to), name), selected.content, selected.mode);
      }
    }
  }
  private async scan(root: FileHandle, budget: Budget, prefix = '', result = new Map<string, Entry>(),
    publicOutput = false, withheld?: Set<string>, names?: string[]): Promise<Map<string, Entry>> {
    for (const name of (names ?? await readdir(ref(root))).sort()) {
      if (++budget.entries > 50_000) fail();
      const key = prefix ? prefix + '/' + name : name;
      if (excluded(name) || this.omitted.has(key)) continue;
      if (publicOutput) try {this.assertPublicContent?.(key);}
      catch (error) {if (!withheld || !(error instanceof SelectedLoginScanIncompleteError)) throw error; withheld.add(key); continue;}
      const path = join(ref(root), name);
      let info: Awaited<ReturnType<typeof lstat>>;
      try {info = await lstat(path);}
      catch (error) {if (!withheld) throw error; withheld.add(key); continue;}
      if (info.isDirectory()) {
        let child: FileHandle;
        try {child = await directory(path);}
        catch (error) {if (!withheld) throw error; withheld.add(key); continue;}
        try {
          // List failures withhold this subtree, but guard failures in any child
          // still refuse publication before the first host mutation.
          let names: string[];
          try {names = await readdir(ref(child));}
          catch (error) {if (!withheld) throw error; withheld.add(key); continue;}
          result.set(key, {kind: 'directory', mode: 0o700});
          await this.scan(child, budget, key, result, publicOutput, withheld, names);
        } finally {await child.close();}
      } else {
        let selected: Awaited<ReturnType<typeof bytes>>;
        try {selected = await bytes(path, budget);}
        catch (error) {if (!withheld) throw error; withheld.add(key); continue;}
        if (publicOutput) try {this.assertPublicContent?.(selected.content);}
        catch (error) {if (!withheld || !(error instanceof SelectedLoginScanIncompleteError)) throw error; withheld.add(key); continue;}
        result.set(key, {kind: 'file', mode: selected.mode, digest: digest(selected.content)});
      }
    }
    return result;
  }
  private async parent(root: FileHandle, key: string): Promise<{file: FileHandle; owned: boolean; assertCurrent(): Promise<void>}> {
    let file = root, owned = false;
    const chain: {name: string; identity: string}[] = [];
    try {
      for (const part of dirname(key).split('/').filter(part => part !== '.')) {
        if (!part || part === '..') fail();
        const next = await directory(join(ref(file), part));
        chain.push({name: part, identity: id(await next.stat())});
        if (owned) await file.close(); file = next; owned = true;
      }
      return {file, owned, assertCurrent: async () => {
        if (root === this.source && (await realpath(this.workspace) !== this.sourcePath ||
          id(await lstat(this.sourcePath!)) !== this.sourceIdentity)) fail();
        let current = root, close = false;
        try {
          for (const step of chain) {
            const child = await directory(join(ref(current), step.name));
            if (close) await current.close(); current = child; close = true;
            if (id(await child.stat()) !== step.identity) fail();
          }
          if (id(await current.stat()) !== id(await file.stat())) fail();
        } finally {if (close) await current.close();}
      }};
    } catch (error) {if (owned) await file.close(); throw error;}
  }
  private async assertUnchanged(parent: FileHandle, name: string, expected?: Entry): Promise<void> {
    const path = join(ref(parent), name);
    if (!expected) {
      try {await lstat(path); fail();} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
      return;
    }
    if (expected.kind === 'directory') {if (!(await lstat(path)).isDirectory()) fail(); return;}
    const current = await bytes(path, {entries: 0, bytes: 0});
    if (current.mode !== expected.mode || digest(current.content) !== expected.digest) fail();
  }
  async removePrivateHome(isClean: () => boolean): Promise<void> {
    if (!isClean() || !this.work || this.closed) fail();
    const work = this.work!;
    const erase = async (parent: FileHandle, name: string): Promise<void> => {
      const path = join(ref(parent), name);
      const info = await lstat(path).catch(error => {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error;});
      if (!info) return;
      if (info.isDirectory()) {
        const child = await directory(path);
        try {for (const entry of await readdir(ref(child))) await erase(child, entry);} finally {await child.close();}
        await rmdir(path);
      } else await unlink(path); // A hostile link is unlinked, never traversed.
    };
    await erase(work, '.mdai-home'); await work.sync();
  }
  /** Only after sealed empty evidence and durable CLEAN. Never follow a
   * workload-created link. Reject observed conflicting host edits; ordinary
   * filesystem rename does not provide compare-and-swap against host writers. */
  async publish(isClean: () => boolean): Promise<void> {
    if (!isClean() || this.closed || !this.work) fail();
    if (!this.source) return;
    const source = this.source, work = this.work!;
    if (await realpath(this.workspace) !== this.sourcePath || id(await lstat(this.sourcePath!)) !== this.sourceIdentity) fail();
    const current = await this.scan(source, {entries: 0, bytes: 0});
    // Scan every candidate before mutation. With selected login, an unreadable,
    // unstable or over-budget artifact is withheld, never treated as a deletion.
    // Apply this even on normal exit so late TERM/KILL and deadline races cannot
    // accidentally authorize an unscanned artifact. Scanned clean siblings stay
    // eligible. A detected credential still refuses the complete candidate tree.
    const withheld = new Set<string>();
    const output = await this.scan(work, {entries: 0, bytes: 0}, '', new Map(), true,
      this.assertPublicContent ? withheld : undefined);
    const isWithheld = (key: string) => {
      for (let path = key; path !== '.'; path = dirname(path)) if (withheld.has(path)) return true;
      return false;
    };
    // Controller stdout logs and unrelated host edits may advance while the
    // sandbox runs. Compare only files that the workload changed or removed;
    // untouched source files must never be copied back over those edits.
    for (const key of new Set([...this.baseline.keys(), ...output.keys()])) {
      if (isWithheld(key)) continue;
      const prior = JSON.stringify(this.baseline.get(key));
      if (JSON.stringify(output.get(key)) !== prior && JSON.stringify(current.get(key)) !== prior) fail();
    }
    if (!isClean()) fail();
    for (const [key, entry] of output) {
      if (isWithheld(key)) continue;
      if (JSON.stringify(this.baseline.get(key)) === JSON.stringify(entry)) continue;
      if (this.baseline.has(key) && this.baseline.get(key)!.kind !== entry.kind) fail();
      try {this.assertPublicContent?.(key);}
      catch (error) {if (!(error instanceof SelectedLoginScanIncompleteError)) throw error; withheld.add(key); continue;}
      const target = await this.parent(source, key);
      try {
        if (entry.kind === 'directory') {
          await this.assertUnchanged(target.file, basename(key));
          await target.assertCurrent();
          await mkdir(join(ref(target.file), basename(key)), {mode: 0o700});
          await target.assertCurrent(); continue;
        }
        let origin: {file: FileHandle; owned: boolean} | undefined;
        let content: Buffer;
        try {
          origin = await this.parent(work, key);
          content = (await bytes(join(ref(origin.file), basename(key)), {entries: 0, bytes: 0})).content;
        }
        catch (error) {if (!this.assertPublicContent) throw error; withheld.add(key); continue;}
        finally {if (origin?.owned) await origin.file.close();}
        if (!isClean()) fail();
        if (digest(content) !== entry.digest) {
          if (!this.assertPublicContent) fail();
          withheld.add(key); continue;
        }
        try {this.assertPublicContent?.(content);}
        catch (error) {if (!(error instanceof SelectedLoginScanIncompleteError)) throw error; withheld.add(key); continue;}
        const temporary = join(ref(target.file), '.mdai-publish-' + randomUUID());
        await target.assertCurrent();
        await writeNew(temporary, content, entry.mode);
        try {
          await this.assertUnchanged(target.file, basename(key), this.baseline.get(key));
          await target.assertCurrent();
          await rename(temporary, join(ref(target.file), basename(key))); await target.file.sync();
          await target.assertCurrent();
        }
        finally {await unlink(temporary).catch(() => {});}
      } finally {if (target.owned) await target.file.close();}
    }
    for (const [key, entry] of [...this.baseline].reverse()) if (!output.has(key) && !isWithheld(key)) {
      const target = await this.parent(source, key);
      try {
        if (!isClean()) fail();
        await this.assertUnchanged(target.file, basename(key), entry);
        await target.assertCurrent();
        await (entry.kind === 'directory' ? rmdir : unlink)(join(ref(target.file), basename(key)));
        await target.file.sync();
        await target.assertCurrent();
      } finally {if (target.owned) await target.file.close();}
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.source?.close(); await this.work?.close();
  }
}
