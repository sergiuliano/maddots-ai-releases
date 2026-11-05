import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {constants} from 'node:fs';
import {createRequire, syncBuiltinESMExports} from 'node:module';
import {dirname, join, resolve} from 'node:path';
import test, {type TestContext} from 'node:test';
import {AdapterRegistry} from '../src/runner/adapters/index.js';
import {PROCESS_CLEANUP_CAP_MS} from '../src/runner/process.js';
import {RunnerCore} from '../src/runner/runner.js';
import {RunnerState} from '../src/runner/state.js';
import {acquireStorageOwner} from '../src/runner/storage-owner.js';
import {initializeCleanRunnerJournal} from './support/runner-journal-fixture.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {resolve = done;});
  return {promise, resolve};
}

let fixtureSequence = 0;
/** Deterministic namespace/FD scheduling, while exercising real Core, State and lock code. */
async function fixture(t: TestContext) {
  const root = `/runner-identity-fixture-${++fixtureSequence}`;
  const a = join(root, 'a'), b = join(root, 'b'), alias = join(root, 'alias');
  type Entry = {ino: number; directory: boolean; content: string};
  const entries = new Map<string, Entry>(), descriptors = new Map<number, {path: string; entry: Entry; flags: number}>();
  const heldLocks = new Map<number, number>();
  const reads: string[] = [], publications: string[] = [], acquisitions: string[] = [];
  let nextInode = fixtureSequence * 1000, nextFd = 100_000, aliasTarget = a;
  const add = (path: string, directory: boolean) => {
    const entry = {ino: ++nextInode, directory, content: ''}; entries.set(path, entry); return entry;
  };
  for (const path of ['/', root, a, b]) add(path, true);
  const missing = () => Object.assign(new Error('fixture path absent'), {code: 'ENOENT'});
  const pathOf = (input: unknown): string => {
    const path = String(input), descriptor = /^\/proc\/self\/fd\/(\d+)(\/.*)?$/u.exec(path);
    if (descriptor) {
      const held = descriptors.get(Number(descriptor[1]));
      assert(held, 'procfs references must name a retained descriptor');
      return resolve(held.path, '.' + (descriptor[2] ?? ''));
    }
    return path;
  };
  const entryAt = (input: unknown) => {
    const entry = entries.get(pathOf(input)); if (!entry) throw missing(); return entry;
  };
  const info = (entry: Entry) => ({dev: 7, ino: entry.ino, uid: process.getuid?.(),
    mode: entry.directory ? 0o700 : 0o600, nlink: entry.directory ? 1 : [...entries.values()].filter(candidate => candidate === entry).length, size: Buffer.byteLength(entry.content),
    isDirectory: () => entry.directory, isFile: () => !entry.directory, isSymbolicLink: () => false});
  const require = createRequire(import.meta.url);
  const filesystem = require('node:fs/promises') as typeof import('node:fs/promises');
  const syncFilesystem = require('node:fs') as typeof import('node:fs');
  const children = require('node:child_process') as typeof import('node:child_process');
  let resolveAlias: (() => Promise<void>) | undefined, resolveCanonical: (() => Promise<void>) | undefined;
  let acquireGuard: (() => Promise<void>) | undefined;
  t.mock.method(filesystem, 'realpath', async (input: unknown) => {
    if (String(input) === alias) {await resolveAlias?.(); return aliasTarget;}
    if (String(input) === a) await resolveCanonical?.();
    const path = pathOf(input); entryAt(path); return path;
  });
  t.mock.method(filesystem, 'lstat', async (input: unknown) => info(entryAt(input)));
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
  t.mock.method(syncFilesystem, 'lstatSync', (input: unknown) => {return info(entryAt(input));});
  t.mock.method(syncFilesystem, 'fstatSync', (fd: number) => {
    const held = descriptors.get(fd); assert(held, 'the independent inode pin must remain open');
    return info(held.entry);
  });
  const closeDescriptor = (fd: number) => {
    const held = descriptors.get(fd); assert(held, 'closing must name a live descriptor');
    descriptors.delete(fd);
    if (heldLocks.get(held.entry.ino) === fd) heldLocks.delete(held.entry.ino);
  };
  t.mock.method(syncFilesystem, 'closeSync', closeDescriptor);
  t.mock.method(filesystem, 'readFile', async (input: unknown) => {
    if (String(input) === '/proc/sys/kernel/random/boot_id') return '11111111-2222-4333-8444-555555555555';
    const descriptor = /^\/proc\/self\/fdinfo\/(\d+)$/u.exec(String(input));
    if (descriptor) {
      const held = descriptors.get(Number(descriptor[1])); assert(held);
      return `flags:\t${held.flags.toString(8)}\n`;
    }
    return entryAt(input).content;
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
    return {
      fd, stat: async () => info(entry), sync: async () => {},
      close: async () => {closeDescriptor(fd);},
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        reads.push(path);
        const bytesRead = Buffer.from(entry.content).copy(buffer, offset, position, position + length);
        return {bytesRead, buffer};
      },
      writeFile: async (content: string) => {entry.content = content;},
    };
  });
  const rename = (source: unknown, target: unknown) => {
    const from = pathOf(source), to = pathOf(target);
    assert(entryAt(dirname(to)).directory); entries.set(to, entryAt(from)); entries.delete(from); publications.push(to);
  };
  const link = (source: unknown, target: unknown) => {
    const from = pathOf(source), to = pathOf(target);
    if (entries.has(to)) throw Object.assign(new Error('fixture entry exists'), {code: 'EEXIST'});
    assert(entryAt(dirname(to)).directory); entries.set(to, entryAt(from)); publications.push(to);
  };
  const unlink = (input: unknown) => {const path = pathOf(input); entryAt(path); entries.delete(path);};
  t.mock.method(filesystem, 'rename', async (source: unknown, target: unknown) => rename(source, target));
  t.mock.method(filesystem, 'link', async (source: unknown, target: unknown) => link(source, target));
  t.mock.method(filesystem, 'unlink', async (input: unknown) => unlink(input));
  t.mock.method(syncFilesystem, 'renameSync', rename);
  t.mock.method(syncFilesystem, 'linkSync', link);
  t.mock.method(syncFilesystem, 'unlinkSync', unlink);
  t.mock.method(children, 'spawn', (command: string, args: string[], options: {stdio: unknown[]}) => {
    assert.equal(command, '/usr/bin/flock');
    assert.deepEqual(args, ['--exclusive', '--nonblock', '--conflict-exit-code', '75', '3']);
    const fd = options.stdio[3] as number, descriptor = descriptors.get(fd); assert(descriptor);
    const child = new EventEmitter();
    const code = heldLocks.has(descriptor.entry.ino) ? 75 : 0;
    if (!code) {heldLocks.set(descriptor.entry.ino, fd); acquisitions.push(descriptor.path);}
    void Promise.resolve().then(acquireGuard).then(() => child.emit('close', code, null));
    return child;
  });
  syncBuiltinESMExports();
  const cores: RunnerCore[] = [];
  const core = (data: string) => {
    const result = new RunnerCore({data, registry: new AdapterRegistry([]), connections: async () => [], localAgents: async () => [],
      verifiedBuild: async () => true, allowedBuild: async () => true, stageSkills: async () => {}, removeDeviceKey: async () => {},
      deliver: async () => {throw new Error('The empty fixture cannot deliver a workload.');}});
    cores.push(result); return result;
  };
  t.after(async () => {
    for (const instance of cores) await instance.close();
    t.mock.timers.reset();
    t.mock.restoreAll(); syncBuiltinESMExports();
  });
  await initializeCleanRunnerJournal(a); await initializeCleanRunnerJournal(b);
  reads.length = 0; publications.length = 0; acquisitions.length = 0;
  return {a, b, alias, core, reads, publications, acquisitions, descriptors,
    retarget: (target: string) => {aliasTarget = target;},
    onResolveAlias: (hook: () => Promise<void>) => {resolveAlias = hook;},
    onResolveCanonical: (hook: () => Promise<void>) => {resolveCanonical = hook;},
    onAcquireGuard: (hook: () => Promise<void>) => {acquireGuard = hook;},
    replace: (path: string) => {add(path, true);},
    seedActive: (path: string) => {add(join(path, 'runner', 'active.json'), false).content = '[]';},
  };
}

test('S1 P2-1: alias retarget during acquisition cannot cache B under A after the first core closes', {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const f = await fixture(t), resolving = deferred(), proceed = deferred();
  f.seedActive(f.a); f.seedActive(f.b);
  let resolutions = 0;
  f.onResolveAlias(async () => {
    if (++resolutions === 2) {resolving.resolve(); await proceed.promise; f.retarget(f.b);}
  });
  const first = f.core(f.alias), successor = f.core(f.a);
  const initializing = assert.rejects(first.init(), {code: 'RUNNER_STATE_UNAVAILABLE'});
  await resolving.promise;
  await first.close(); proceed.resolve(); await initializing;
  await successor.init();
  assert.equal(successor.dataDirectory, f.a, 'a direct A core must never receive B from the owner cache');
  assert.deepEqual([...new Set(f.reads)], ['journal-manifest.json', 'journal-head.json', 'active.json'].map(name => join(f.a, 'runner', name)), 'real retained state reads only A');
  assert.deepEqual(f.publications, ['journal-0000000001.json', 'journal-head.json', 'active.json'].map(name => join(f.a, 'runner', name)), 'real retained state publishes only A');
  assert.deepEqual(f.acquisitions, [f.a], 'the retargeted acquisition never owns B');
  await successor.close();
  assert.equal(f.descriptors.size, 0, 'rejected and successful acquisitions close their own directory descriptors');
});

for (const retargetAt of [5, 6, 7]) {
test(`S1 P2-1: unused owner retires after alias retarget at resolution ${retargetAt}`, {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const f = await fixture(t), first = f.core(f.alias), successor = f.core(f.a);
  f.seedActive(f.a); f.seedActive(f.b);
  let resolutions = 0;
  f.onResolveAlias(async () => {if (++resolutions === retargetAt) f.retarget(f.b);});
  await assert.rejects(first.init(), {code: 'RUNNER_STATE_UNAVAILABLE'});
  assert.equal(resolutions, retargetAt, 'the failure occurs at the selected post-lock validation');
  assert.deepEqual(f.reads, [], 'a refused acquisition never reads authoritative state');
  assert.deepEqual(f.publications, [], 'a refused acquisition never publishes state');
  await first.close();
  assert.equal(f.descriptors.size, 0, 'failed initialization leaves no directory or guard descriptors');
  await successor.init();
  assert.equal(successor.dataDirectory, f.a);
  assert.deepEqual([...new Set(f.reads)], ['journal-manifest.json', 'journal-head.json', 'active.json'].map(name => join(f.a, 'runner', name)));
  assert.deepEqual(f.publications, ['journal-0000000001.json', 'journal-head.json', 'active.json'].map(name => join(f.a, 'runner', name)));
  assert.deepEqual(f.acquisitions, [f.a, f.a]);
  await successor.close();
  assert.equal(f.descriptors.size, 0);
});
}

test('S1 P2-1: closing a core during its final acquisition validation retires its unused owner', {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const f = await fixture(t), first = f.core(f.alias), successor = f.core(f.a);
  const validating = deferred(), proceed = deferred();
  let resolutions = 0;
  f.onResolveAlias(async () => {if (++resolutions === 6) {validating.resolve(); await proceed.promise;}});
  const refused = assert.rejects(first.init(), {code: 'RUNNER_STATE_UNAVAILABLE'});
  await validating.promise;
  await first.close();
  assert.equal(f.descriptors.size, 2, 'the in-flight acquisition still owns the retained directory and lock');
  proceed.resolve(); await refused;
  assert.deepEqual(f.reads, []); assert.deepEqual(f.publications, []);
  assert.equal(f.descriptors.size, 0, 'closed admission releases the acquisition before attaching');
  await successor.init(); await successor.close();
  assert.equal(f.descriptors.size, 0);
});

test('S1 P2-1: a failed alias acquisition preserves a concurrent canonical caller before attachment', {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const f = await fixture(t), acquiring = deferred(), proceed = deferred(), aliased = deferred();
  f.onAcquireGuard(async () => {acquiring.resolve(); await proceed.promise;});
  let resolutions = 0;
  f.onResolveAlias(async () => {
    if (++resolutions === 2) aliased.resolve();
    if (resolutions === 3) f.retarget(f.b);
  });
  const canonical = acquireStorageOwner(f.a, new RunnerState(f.a));
  await acquiring.promise;
  const refused = assert.rejects(acquireStorageOwner(f.alias, new RunnerState(f.alias)), {code: 'RUNNER_STATE_UNAVAILABLE'});
  await aliased.promise; proceed.resolve();
  const acquisition = await canonical, owner = acquisition.owner;
  await refused;
  assert.equal(f.descriptors.size, 2, 'the rejected alias cannot release the successful caller awaiting attachment');
  const generation = acquisition.attach(); await owner.replayJournal(generation); owner.stateLoaded = true; owner.initialized = true;
  await owner.validate();
  await owner.detach(generation);
  assert.equal(f.descriptors.size, 0);
});

for (const heldAt of [4, 5, 6]) {
test(`S1 P2-1: timed-out acquisition at resolution ${heldAt} retires after its retained work settles`, {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const f = await fixture(t), first = f.core(f.alias), successor = f.core(f.a);
  const validating = deferred(), proceed = deferred();
  let resolutions = 0;
  f.onResolveAlias(async () => {if (++resolutions === heldAt) {validating.resolve(); await proceed.promise;}});
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
  const refused = assert.rejects(first.init(), {code: 'RUNNER_STATE_UNAVAILABLE'});
  await validating.promise;
  t.mock.timers.tick(PROCESS_CLEANUP_CAP_MS); await refused;
  await first.close();
  assert.deepEqual(f.reads, []); assert.deepEqual(f.publications, []);
  if (heldAt === 4) assert.equal(f.descriptors.size, 2, 'an unfinished lock acquisition retains responsibility until its real result');
  proceed.resolve();
  const deadline = performance.now() + 1000;
  while (f.descriptors.size && performance.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.descriptors.size, 0, 'the last failed caller has a late-result retirement continuation');
  await successor.init(); await successor.close();
  assert.equal(f.descriptors.size, 0);
});
}

test('S1 P2-1: successful callers retain separate reservations until the last unused acquisition releases', {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([
    acquireStorageOwner(f.a, new RunnerState(f.a)), acquireStorageOwner(f.alias, new RunnerState(f.alias)),
  ]);
  assert.equal(first.owner, second.owner);
  await first.release();
  assert.equal(f.descriptors.size, 2, 'the second successful caller still owns an attachment reservation');
  assert.throws(() => first.attach(), {code: 'RUNNER_STATE_UNAVAILABLE'}, 'an abandoned acquisition cannot regain attachment rights');
  await second.release();
  assert.equal(f.descriptors.size, 0);
  await second.release();
  assert.equal(f.descriptors.size, 0, 'abandonment is idempotent');
});

test('S1 P2-1: closing a clean core preserves a validating caller until that caller fails', {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const f = await fixture(t), core = f.core(f.a), validating = deferred(), proceed = deferred();
  await core.init();
  let resolutions = 0;
  f.onResolveAlias(async () => {if (++resolutions === 3) {validating.resolve(); await proceed.promise; f.retarget(f.b);}});
  const refused = assert.rejects(acquireStorageOwner(f.alias, new RunnerState(f.alias)), {code: 'RUNNER_STATE_UNAVAILABLE'});
  await validating.promise;
  await core.close();
  // The accepted runner inode has an independent inventory pin in addition
  // to its adopted handle and the waiting caller's duplicate root descriptor.
  assert.equal(f.descriptors.size, 8, 'the waiting caller protects the clean owner, inventory pin and duplicate directory descriptor');
  proceed.resolve(); await refused;
  assert.equal(f.descriptors.size, 0, 'a failed last caller also retires the detached clean owner');
});

test('S1 owner acquisition shares a retained identity across concurrent canonical and alias callers', {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const f = await fixture(t), acquiring = deferred(), proceed = deferred(), aliased = deferred();
  f.onAcquireGuard(async () => {acquiring.resolve(); await proceed.promise;});
  let aliasResolutions = 0;
  f.onResolveAlias(async () => {if (++aliasResolutions === 2) aliased.resolve();});
  const first = acquireStorageOwner(f.a, new RunnerState(f.a));
  await acquiring.promise;
  const second = acquireStorageOwner(f.alias, new RunnerState(f.alias));
  await aliased.promise; proceed.resolve();
  const [acquisition, shared] = await Promise.all([first, second]), owner = acquisition.owner;
  assert.equal(owner, shared.owner, 'both callers join the same owner acquisition');
  assert.deepEqual(f.acquisitions, [f.a]);
  assert.equal(f.descriptors.size, 2, 'the unused cache candidate closes while the original directory and guard stay retained');
  const generation = acquisition.attach(); await owner.replayJournal(generation); owner.stateLoaded = true; owner.initialized = true;
  assert.throws(() => shared.attach(), {code: 'RUNNER_STATE_UNAVAILABLE'}, 'a competing attachment drops only its own reservation');
  await owner.detach(generation);
  assert.equal(f.descriptors.size, 0);
});

test('S1 a cached owner rejects a caller alias that retargets during validation', {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const f = await fixture(t), core = f.core(f.a);
  await core.init();
  let resolutions = 0;
  f.onResolveAlias(async () => {if (++resolutions === 3) f.retarget(f.b);});
  await assert.rejects(acquireStorageOwner(f.alias, new RunnerState(f.alias)), {code: 'RUNNER_STATE_UNAVAILABLE'});
  assert.deepEqual(f.acquisitions, [f.a]);
  assert.equal(f.descriptors.size, 7, 'the attached canonical owner keeps every retained descriptor, including its runner inventory pin');
  await core.init();
  await core.close();
  assert.equal(f.descriptors.size, 0, 'rejecting a cached caller closes its candidate without closing the owner early');
});

test('S1 a replaced canonical path cannot create another cached owner with its new inode', {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const f = await fixture(t), core = f.core(f.a);
  await core.init();
  const published = [...f.publications];
  f.replace(f.a);
  await assert.rejects(f.core(f.a).init(), {code: 'RUNNER_STATE_UNAVAILABLE'});
  assert.deepEqual(f.acquisitions, [f.a]);
  assert.deepEqual(f.publications, published, 'the replacement never publishes a second ledger');
  await core.close();
  assert.equal(f.descriptors.size, 0);
});

test('S1 timed-out directory preparation closes a late retained candidate without acquiring its lock', {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const f = await fixture(t), resolving = deferred(), proceed = deferred();
  let resolutions = 0;
  f.onResolveAlias(async () => {if (++resolutions === 2) {resolving.resolve(); await proceed.promise;}});
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
  const refused = assert.rejects(f.core(f.alias).init(), {code: 'RUNNER_STATE_UNAVAILABLE'});
  await resolving.promise;
  t.mock.timers.tick(PROCESS_CLEANUP_CAP_MS); await refused;
  assert.equal(f.descriptors.size, 1, 'preparation still owns the candidate while its validation is unresolved');
  proceed.resolve();
  const deadline = performance.now() + 1000;
  while (f.descriptors.size && performance.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.descriptors.size, 0, 'late preparation has an explicit descriptor cleanup continuation');
  assert.deepEqual(f.acquisitions, []);
});

test('S1 timing out cached-owner alias validation closes the duplicate directory despite an exhausted deadline', {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const f = await fixture(t), core = f.core(f.a), resolving = deferred(), proceed = deferred();
  await core.init();
  let resolutions = 0;
  f.onResolveAlias(async () => {if (++resolutions === 3) {resolving.resolve(); await proceed.promise;}});
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
  const refused = assert.rejects(acquireStorageOwner(f.alias, new RunnerState(f.alias)), {code: 'RUNNER_STATE_UNAVAILABLE'});
  await resolving.promise;
  t.mock.timers.tick(PROCESS_CLEANUP_CAP_MS); await refused;
  assert.equal(f.descriptors.size, 7, 'the duplicate FD closes, leaving the original owner descriptors and runner inventory pin');
  proceed.resolve();
  await core.close();
  assert.equal(f.descriptors.size, 0);
});

test('S1 P2-3: a competing caller timeout cannot poison a successfully settled shared-owner validation', {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const f = await fixture(t), core = f.core(f.a), resolving = deferred(), proceed = deferred();
  await core.init();
  const retainedDescriptors = f.descriptors.size;
  let resolutions = 0;
  f.onResolveCanonical(async () => {
    if (++resolutions === 1) {resolving.resolve(); await proceed.promise;}
  });
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
  const refused = assert.rejects(acquireStorageOwner(f.alias, new RunnerState(f.alias)), {code: 'RUNNER_STATE_UNAVAILABLE'});
  await resolving.promise;
  t.mock.timers.tick(PROCESS_CLEANUP_CAP_MS); await refused;
  assert.equal(f.descriptors.size, retainedDescriptors, 'only the competing caller abandons its candidate');
  proceed.resolve(); await new Promise(resolve => setImmediate(resolve));
  await core.init();
  const published = f.publications.length;
  await core['save']();
  assert.equal(f.publications.length, published + 1, 'the original healthy core can still publish');
  assert.equal(core.busy, false);
  await core.close();
  assert.equal(f.descriptors.size, 0, 'successful physical validation leaves no permanent retention reason');
  const successor = f.core(f.a);
  await successor.init(); await successor.close();
  assert.equal(f.descriptors.size, 0, 'a canonical successor acquires and releases normally');
});

for (const settlement of ['success', 'EIO'] as const) {
test(`S1 P2-3: detached owner retains timed-out validation descriptors through late ${settlement}`, {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const f = await fixture(t), core = f.core(f.a), resolving = deferred(), proceed = deferred();
  await core.init();
  const retainedDescriptors = f.descriptors.size;
  let resolutions = 0;
  f.onResolveCanonical(async () => {
    if (++resolutions === 1) {
      resolving.resolve(); await proceed.promise;
      if (settlement === 'EIO') throw Object.assign(new Error('late validation EIO'), {code: 'EIO'});
    }
  });
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
  const refused = assert.rejects(acquireStorageOwner(f.alias, new RunnerState(f.alias)), {code: 'RUNNER_STATE_UNAVAILABLE'});
  await resolving.promise;
  t.mock.timers.tick(PROCESS_CLEANUP_CAP_MS); await refused;
  await core.close();
  assert.equal(core.busy, true, 'the closed core remains busy while physical validation can still use its lock');
  assert.equal(f.descriptors.size, retainedDescriptors, 'caller timeout and core close cannot free live validation descriptors');
  const acquisitions = f.acquisitions.length, reads = f.reads.length;
  const successor = f.core(f.a);
  await assert.rejects(successor.init(), {code: 'RUNNER_STATE_UNAVAILABLE'});
  assert.equal(f.acquisitions.length, acquisitions, 'a successor cannot acquire another kernel lock during validation');
  assert.equal(f.reads.length, reads, 'a successor cannot reload state during validation');
  proceed.resolve(); await new Promise(resolve => setImmediate(resolve));
  if (settlement === 'success') {
    assert.equal(core.busy, false);
    assert.equal(f.descriptors.size, 0, 'late successful validation retires the clean detached owner');
    await successor.init(); await successor.close();
    assert.equal(f.descriptors.size, 0);
  } else {
    assert.equal(core.busy, true, 'an actual late storage error remains unresolved');
    assert.equal(f.descriptors.size, retainedDescriptors, 'actual failure preserves the original owner');
    await assert.rejects(successor.init(), {code: 'RUNNER_STATE_UNAVAILABLE'});
    assert.equal(f.reads.length, reads, 'a failed owner never reloads an older ledger');
  }
});
}
