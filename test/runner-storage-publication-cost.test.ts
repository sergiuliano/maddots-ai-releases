import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {constants} from 'node:fs';
import {createRequire, syncBuiltinESMExports} from 'node:module';
import {dirname, join, resolve} from 'node:path';
import test, {type TestContext} from 'node:test';
import {RunnerState} from '../src/runner/state.js';
import {acquireRunnerStorageLock} from '../src/runner/storage-lock.js';
import {acquireStorageOwner, RunnerStorageOwner} from '../src/runner/storage-owner.js';
import {initializeCleanRunnerJournal} from './support/runner-journal-fixture.js';
import {AdapterRegistry} from '../src/runner/adapters/index.js';
import {RunnerCore} from '../src/runner/runner.js';

/** Count actual production filesystem calls without platform scheduling noise. */
let sequence = 0;
function fixture(t: TestContext) {
  const data = `/runner-publication-cost-${++sequence}`;
  type Entry = {dev: number; ino: number; directory: boolean; content: string; uid: number | undefined; mode: number};
  const entries = new Map<string, Entry>();
  const descriptors = new Map<number, {path: string; entry: Entry; flags: number}>();
  let nextInode = 0, nextFd = 100_000;
  const add = (path: string, directory: boolean) => {
    const entry = {dev: 7, ino: ++nextInode, directory, content: '', uid: process.getuid?.(), mode: directory ? 0o700 : 0o600};
    entries.set(path, entry); return entry;
  };
  add('/', true); add(data, true);
  const missing = () => Object.assign(new Error('fixture path absent'), {code: 'ENOENT'});
  const pathOf = (input: unknown): string => {
    const path = String(input), reference = /^\/proc\/self\/fd\/(\d+)(\/.*)?$/u.exec(path);
    if (!reference) return path;
    const held = descriptors.get(Number(reference[1]));
    assert(held, 'a procfs operation must retain its directory descriptor');
    return resolve(held.path, '.' + (reference[2] ?? ''));
  };
  const entryAt = (input: unknown) => {
    const entry = entries.get(pathOf(input)); if (!entry) throw missing(); return entry;
  };
  const info = (entry: Entry) => ({dev: entry.dev, ino: entry.ino, uid: entry.uid,
    mode: entry.mode, nlink: entry.directory ? 1 : [...entries.values()].filter(candidate => candidate === entry).length, size: Buffer.byteLength(entry.content),
    isDirectory: () => entry.directory, isFile: () => !entry.directory, isSymbolicLink: () => false});
  const counts = {realpath: 0, fstat: 0, lstat: 0, fsync: 0}, syncCounts = {fstat: 0, lstat: 0};
  const stats: string[] = [], resolutions: string[] = [], mutations: string[] = [];
  const require = createRequire(import.meta.url);
  const filesystem = require('node:fs/promises') as typeof import('node:fs/promises');
  const syncFilesystem = require('node:fs') as typeof import('node:fs');
  const children = require('node:child_process') as typeof import('node:child_process');
  t.mock.method(filesystem, 'realpath', async (input: unknown) => {
    counts.realpath++; resolutions.push(String(input)); const path = pathOf(input); entryAt(path); return path;
  });
  t.mock.method(filesystem, 'lstat', async (input: unknown) => {counts.lstat++; return info(entryAt(input));});
  const createDirectory = (input: unknown, options?: {recursive?: boolean}) => {
    const path = pathOf(input);
    if (entries.has(path)) {
      if (options?.recursive) return;
      throw Object.assign(new Error('fixture entry exists'), {code: 'EEXIST'});
    }
    assert(entryAt(dirname(path)).directory); add(path, true);
  };
  t.mock.method(filesystem, 'mkdir', async (input: unknown, options?: {recursive?: boolean}) => createDirectory(input, options));
  t.mock.method(syncFilesystem, 'mkdirSync', createDirectory);
  t.mock.method(syncFilesystem, 'lstatSync', (input: unknown) => {counts.lstat++; syncCounts.lstat++; return info(entryAt(input));});
  t.mock.method(syncFilesystem, 'fstatSync', (fd: number) => {
    const held = descriptors.get(fd); assert(held, 'the independent inode pin must remain open');
    counts.fstat++; syncCounts.fstat++; stats.push(held.path); return info(held.entry);
  });
  const closeDescriptor = (fd: number) => {
    const held = descriptors.get(fd); assert(held, 'closing must name a live descriptor');
    descriptors.delete(fd);
  };
  t.mock.method(syncFilesystem, 'closeSync', closeDescriptor);
  t.mock.method(filesystem, 'readFile', async (input: unknown) => {
    if (String(input) === '/proc/sys/kernel/random/boot_id') return '11111111-2222-4333-8444-555555555555';
    const reference = /^\/proc\/self\/fdinfo\/(\d+)$/u.exec(String(input));
    if (!reference) return entryAt(input).content;
    const held = descriptors.get(Number(reference[1])); assert(held);
    return `flags:\t${held.flags.toString(8)}\n`;
  });
  const readDirectory = (input: unknown) => {
    const path = pathOf(input); assert(entryAt(path).directory);
    return [...entries.keys()].filter(item => dirname(item) === path && item !== path).map(item => item.slice(path.length + 1));
  };
  t.mock.method(filesystem, 'readdir', async (input: unknown) => readDirectory(input));
  t.mock.method(syncFilesystem, 'readdirSync', readDirectory);
  t.mock.method(filesystem, 'opendir', async (input: unknown) => {
    const path = pathOf(input); assert(entryAt(path).directory);
    const children = [...entries.keys()].filter(item => dirname(item) === path && item !== path);
    return {close: async () => {}, async *[Symbol.asyncIterator]() {for (const item of children) yield {name: item.slice(path.length + 1)};}};
  });
  // A bare procfs FD open adopts its held inode, even if the original name
  // has changed. Pins and adopted handles remain separate live descriptors.
  const openDescriptor = (input: unknown, flags: number) => {
    const path = pathOf(input), adopted = /^\/proc\/self\/fd\/(\d+)(?:\/\.)?$/u.exec(String(input));
    let entry = adopted ? descriptors.get(Number(adopted[1]))!.entry : entries.get(path);
    if (entry && (flags & constants.O_CREAT) && (flags & constants.O_EXCL)) {
      throw Object.assign(new Error('fixture entry exists'), {code: 'EEXIST'});
    }
    if (!entry && (flags & constants.O_CREAT)) {
      assert(entryAt(dirname(path)).directory); entry = add(path, false);
    }
    if (!entry) throw missing();
    if (flags & constants.O_DIRECTORY) assert(entry.directory);
    const fd = ++nextFd; descriptors.set(fd, {path, entry, flags}); return fd;
  };
  t.mock.method(syncFilesystem, 'openSync', openDescriptor);
  t.mock.method(filesystem, 'open', async (input: unknown, flags: number) => {
    const fd = openDescriptor(input, flags), {path, entry} = descriptors.get(fd)!;
    return {fd,
      stat: async () => {counts.fstat++; stats.push(path); const held = descriptors.get(fd); assert(held); return info(held.entry);},
      sync: async () => {counts.fsync++;},
      close: async () => {closeDescriptor(fd);},
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        const bytesRead = Buffer.from(entry.content).copy(buffer, offset, position, position + length);
        return {bytesRead, buffer};
      },
      writeFile: async (content: string) => {entry.content = content;},
    };
  });
  const rename = (source: unknown, target: unknown) => {
    mutations.push(String(source), String(target));
    const from = pathOf(source), to = pathOf(target);
    assert(entryAt(dirname(to)).directory); entries.set(to, entryAt(from)); entries.delete(from);
  };
  const link = (source: unknown, target: unknown) => {
    const from = pathOf(source), to = pathOf(target);
    if (entries.has(to)) throw Object.assign(new Error('fixture entry exists'), {code: 'EEXIST'});
    assert(entryAt(dirname(to)).directory); entries.set(to, entryAt(from)); mutations.push(String(source), String(target));
  };
  const unlink = (input: unknown) => {
    mutations.push(String(input)); const path = pathOf(input); entryAt(path); entries.delete(path);
  };
  t.mock.method(filesystem, 'rename', async (source: unknown, target: unknown) => rename(source, target));
  t.mock.method(filesystem, 'link', async (source: unknown, target: unknown) => link(source, target));
  t.mock.method(filesystem, 'unlink', async (input: unknown) => unlink(input));
  t.mock.method(syncFilesystem, 'renameSync', rename);
  t.mock.method(syncFilesystem, 'linkSync', link);
  t.mock.method(syncFilesystem, 'unlinkSync', unlink);
  t.mock.method(children, 'spawn', (command: string, args: string[], options: {stdio: unknown[]}) => {
    assert.equal(command, '/usr/bin/flock');
    assert.deepEqual(args, ['--exclusive', '--nonblock', '--conflict-exit-code', '75', '3']);
    assert(descriptors.has(options.stdio[3] as number));
    const child = new EventEmitter(); queueMicrotask(() => child.emit('close', 0, null)); return child;
  });
  syncBuiltinESMExports();
  t.after(() => {t.mock.restoreAll(); syncBuiltinESMExports();});
  return {data, counts, syncCounts, stats, resolutions, mutations, descriptors,
    reset: () => {counts.realpath = counts.fstat = counts.lstat = counts.fsync = syncCounts.fstat = syncCounts.lstat = 0; stats.length = resolutions.length = mutations.length = 0;},
    changeHeld: (path: string, property: 'dev' | 'ino' | 'uid' | 'mode') => {
      const held = [...descriptors.values()].find(descriptor => descriptor.path === path); assert(held);
      // Model a replaced descriptor independently of the still-correct public
      // pathname, so namespace checks alone cannot detect this failure.
      held.entry = {...held.entry, [property]: (held.entry[property] ?? 0) + 1};
    },
  };
}

test('S1 warm publication validates retained capabilities without repeated path resolution', {
  skip: process.platform !== 'linux',
}, async t => {
  const f = fixture(t);
  await initializeCleanRunnerJournal(f.data);
  const state = new RunnerState(f.data), acquisition = await acquireStorageOwner(f.data, state);
  const owner = acquisition.owner, generation = acquisition.attach();
  try {
    await owner.replayJournal(generation);
    await owner.operation(generation, storage => storage.init());
    owner.stateLoaded = true; owner.initialized = true;
    await owner.save(generation);
    f.reset();
    await owner.save(generation);
    t.diagnostic(`warm publication calls: ${JSON.stringify(f.counts)}; synchronous validation: ${JSON.stringify(f.syncCounts)}; fstat targets: ${JSON.stringify(f.stats)}; realpath targets: ${JSON.stringify(f.resolutions)}`);
    // Eight accepted-runner pin checks and seven temporary-inode checks add
    // fifteen synchronous fstats. The eight pin checks plus final temporary
    // and destination checks add ten synchronous lstats. Async calls remain
    // four fstats and fourteen lstats, with no warm realpath and two fsyncs.
    assert.deepEqual(f.syncCounts, {fstat: 15, lstat: 10});
    assert.deepEqual(f.counts, {realpath: 0, fstat: 19, lstat: 24, fsync: 2});
    assert(f.mutations.every(path => /^\/proc\/self\/fd\/\d+\/[A-Za-z0-9._-]+$/u.test(path)),
      'every publication and cleanup path is relative to a retained directory');
  } finally {await owner.detach(generation);}
  assert.equal(f.descriptors.size, 0);
});

test('S2 warm admission refusal uses the cached replay without journal reads, publications or syncs', {
  skip: process.platform !== 'linux',
}, async t => {
  const f = fixture(t);
  await initializeCleanRunnerJournal(f.data);
  const core = new RunnerCore({data: f.data, registry: new AdapterRegistry([]), connections: async () => [],
    localAgents: async () => [], verifiedBuild: async () => true, allowedBuild: async () => true,
    stageSkills: async () => {}, removeDeviceKey: async () => {},
    deliver: async () => {throw new Error('The storage-only fixture cannot deliver.');}});
  try {
    await core.init(); f.reset();
    await core.tick();
    t.diagnostic(`warm tick calls: ${JSON.stringify(f.counts)}; synchronous validation: ${JSON.stringify(f.syncCounts)}; fstat targets: ${JSON.stringify(f.stats)}`);
    assert.equal(core['lastError'], 'LINUX_CONTAINMENT_UNAVAILABLE');
    assert.deepEqual(f.mutations, []);
    // Cached admission still revalidates the accepted runner inventory pin
    // on both sides of its namespace check, without any publication or fsync.
    assert.deepEqual(f.syncCounts, {fstat: 2, lstat: 2});
    assert.deepEqual(f.counts, {realpath: 1, fstat: 2, lstat: 3, fsync: 0});
  } finally {await core.close();}
  assert.equal(f.descriptors.size, 0);
});

for (const directory of ['root', 'runner'] as const) {
for (const property of ['dev', 'ino', 'uid', 'mode'] as const) {
test(`S1 publication refuses a changed held ${directory} directory ${property} before writing`, {
  skip: process.platform !== 'linux',
}, async t => {
  const f = fixture(t), lock = await acquireRunnerStorageLock(f.data), state = new RunnerState(f.data);
  state.bindDirectory(lock);
  const owner = new RunnerStorageOwner(state, lock, () => {}), generation = owner.attach();
  try {
    await owner.operation(generation, storage => storage.init());
    owner.stateLoaded = true; owner.initialized = true;
    await owner.save(generation); f.reset();
    f.changeHeld(directory === 'root' ? f.data : join(f.data, 'runner'), property);
    await assert.rejects(owner.save(generation), {code: 'RUNNER_STATE_UNAVAILABLE'});
    assert.deepEqual(f.mutations, [], 'no rename or cleanup reaches the invalid capability');
    assert.equal(owner.busy, true, 'refusal retains the unpublished state obligation');
  } finally {await lock.release();}
  assert.equal(f.descriptors.size, 0);
});
}
}
