import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {readFile} from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {HelperError} from '../src/config.js';
import {LINUX_CONTAINMENT_PATHS, type LinuxContainmentNamespace, type LinuxContainmentObject, type LinuxContainmentRequest} from '../src/runner/linux-containment.js';

const namespaceId = '7b04c642-4674-44e3-8df3-1c6ff90b70f1';
const incarnation = '3d96eda7-95f4-4ca1-af2f-f3acfe9b5ccd';
const bootId = '337acde8-979a-402f-8982-f3f1d27a005c';
const request: LinuxContainmentRequest = {incarnation, releaseBinding: 'a'.repeat(64), file: '/usr/bin/true', args: [], cwd: '/work', env: {}, admitLauncher: () => true};
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {resolve = done;});
  return {promise, resolve};
}

/** Execute the unmodified production classes; replace only OS operations and
 * qualification. No real cgroup, credentials, child, or signal is touched. */
async function fixture() {
  const namespacePath = `${LINUX_CONTAINMENT_PATHS.root}/ns-${namespaceId}`;
  const receiptPath = '/fixture/receipt.json';
  const receipt = {format: 1, namespaceId, directoryIdentity: '1:2', bootId, rootIdentity: '1:3', namespaceIdentity: '1:4'};
  type Entry = {ino: number; directory: boolean; content: string};
  const entries = new Map<string, Entry>([
    [LINUX_CONTAINMENT_PATHS.root, {ino: 3, directory: true, content: ''}],
    [namespacePath, {ino: 4, directory: true, content: ''}],
    [LINUX_CONTAINMENT_PATHS.runs, {ino: 5, directory: true, content: ''}],
    [receiptPath, {ino: 6, directory: false, content: JSON.stringify(receipt) + '\n'}],
  ]);
  let nextInode = 10, opens = 0, failOpen = false;
  const opening = deferred(), releaseOpen = deferred();
  const info = (entry: Entry) => ({dev: 1, ino: entry.ino, uid: 999, mode: entry.directory ? 0o700 : 0o600,
    size: entry.content.length, nlink: 1, isDirectory: () => entry.directory, isFile: () => !entry.directory});
  const lookup = (name: string) => {
    const entry = entries.get(name);
    if (!entry) throw Object.assign(new Error(`ENOENT ${name}`), {code: 'ENOENT'});
    return entry;
  };
  const io = {
    async lstat(name: string) {return info(lookup(name));},
    async readFile(name: string) {assert.equal(name, '/proc/sys/kernel/random/boot_id'); return bootId + '\n';},
    async mkdir(name: string) {
      if (entries.has(name)) throw Object.assign(new Error('EEXIST'), {code: 'EEXIST'});
      entries.set(name, {ino: nextInode++, directory: true, content: ''});
      if (path.dirname(name) === namespacePath) entries.set(path.join(name, 'cgroup.events'), {ino: nextInode++, directory: false, content: 'populated 0\n'});
    },
    async rmdir(name: string) {
      assert.equal(lookup(path.join(name, 'cgroup.events')).content, 'populated 0\n');
      entries.delete(path.join(name, 'cgroup.events')); entries.delete(name);
    },
    async readdir(name: string) {
      return [...entries.keys()].filter(key => path.dirname(key) === name).map(key => ({name: path.basename(key), isDirectory: () => lookup(key).directory}));
    },
    async open(name: string, flags: number) {
      if (flags & fs.constants.O_CREAT) {
        assert.ok(!entries.has(name)); entries.set(name, {ino: nextInode++, directory: false, content: ''});
      }
      const entry = lookup(name);
      return {fd: 21, async stat() {return info(entry);}, async readFile() {return entry.content;},
        async read(buffer: Buffer) {const bytes = Buffer.from(entry.content); bytes.copy(buffer); return {bytesRead: bytes.length};},
        async writeFile(content: string) {entry.content = content;}, async sync() {}, async close() {}};
    },
  };
  const sourceUrl = new URL('../src/runner/linux-containment.ts', import.meta.url);
  const configUrl = new URL('../src/config.js', import.meta.url);
  const source = await readFile(sourceUrl, 'utf8');
  const javascript = ts.transpileModule(source + '\nexport {NativeNamespace, NativeObject};', {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
  }).outputText;
  const exports: Record<string, unknown> = {};
  runInNewContext(javascript, {exports, Buffer, process, require(name: string) {
    if (name === 'node:fs') return fs;
    if (name === 'node:fs/promises') return io;
    if (name === 'node:path') return path;
    if (new URL(name, sourceUrl).href === configUrl.href) return {HelperError};
    // Other imports declare functions but are never invoked by this fixture.
    return {};
  }});
  type Namespace = LinuxContainmentNamespace & {qualifyAdmission(): Promise<void>};
  const NativeNamespace = exports.NativeNamespace as new (...args: unknown[]) => Namespace;
  const NativeObject = exports.NativeObject as {open(...args: unknown[]): Promise<LinuxContainmentObject>};
  NativeObject.open = async (_namespace, name) => {
    opens++; opening.resolve(); await releaseOpen.promise;
    if (failOpen) throw new Error('EIO retained endpoint open');
    return {registration: {backend: 'linux-cgroup-v2', namespaceId, name: String(name), objectIdentity: `1:${lookup(path.join(namespacePath, String(name))).ino}`}} as LinuxContainmentObject;
  };
  const namespace = new NativeNamespace({directoryIdentity: '1:2', bootId, ownerEpoch: incarnation, isCurrent: () => true}, receipt,
    receiptPath, {fd: 20, async stat() {return info(lookup(namespacePath));}, async close() {}}, namespacePath, 999);
  namespace.qualifyAdmission = async () => {};
  return {namespace, opening, releaseOpen, fail() {failOpen = true;}, succeed() {failOpen = false;}, get opens() {return opens;},
    addForeign() {entries.set(`${namespacePath}/run-foreign`, {ino: nextInode++, directory: true, content: ''});}};
}

test('S3 namespace validation waits for the controller to register its newly created cgroup', async () => {
  const f = await fixture();
  const reserve = f.namespace.reserve(request);
  await f.opening.promise;
  const validation = assert.doesNotReject(f.namespace.assertCurrent());
  validation.catch(() => {});
  await flush();
  f.releaseOpen.resolve();
  await reserve; await validation;
  await f.namespace.assertCurrent();
});

test('S3 concurrent namespace reservations cannot observe an unregistered sibling', async () => {
  const f = await fixture();
  const first = f.namespace.reserve(request);
  await f.opening.promise;
  const second = f.namespace.reserve({...request, incarnation: 'acee2fe2-6620-488d-836a-70423489f951'});
  // Attach the expectation before allowing asynchronous validation to finish.
  const both = assert.doesNotReject(Promise.all([first, second]));
  both.catch(() => {});
  await flush(); f.releaseOpen.resolve();
  await both;
  assert.equal(f.opens, 2);
  await f.namespace.assertCurrent();
});

test('S3 failed endpoint acquisition removes its never-launched empty cgroup and allows the next reservation', async () => {
  const f = await fixture(); f.fail();
  const reserve = assert.rejects(f.namespace.reserve(request), /EIO retained endpoint open/u);
  await f.opening.promise; f.releaseOpen.resolve(); await reserve;
  await f.namespace.assertCurrent();
  f.succeed();
  await f.namespace.reserve({...request, incarnation: 'acee2fe2-6620-488d-836a-70423489f951'});
  await f.namespace.assertCurrent();
});

test('S3 namespace serialization never admits an actual unregistered cgroup', async () => {
  const f = await fixture(); f.addForeign();
  await assert.rejects(f.namespace.assertCurrent(), /unregistered or replaced object/u);
  await assert.rejects(f.namespace.reserve(request), /unregistered or replaced object/u);
  assert.equal(f.opens, 0);
});
