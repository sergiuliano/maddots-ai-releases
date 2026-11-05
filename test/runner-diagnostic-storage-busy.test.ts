import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {constants} from 'node:fs';
import {createRequire, syncBuiltinESMExports} from 'node:module';
import {dirname, join, resolve} from 'node:path';
import test, {type TestContext} from 'node:test';
import {clock} from '../src/config.js';
import {runnerBusy} from '../src/runner/runner.js';
import {recoverTestRuns} from '../src/runner/test-run.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {resolve = done;});
  return {promise, resolve};
}

/** Exercise production lease and recovery methods without real fixture processes. */
let fixtureSequence = 0;
function fixture(t: TestContext, hold: 'opendir' | 'flock' | 'contention' | 'open' | 'locked-check' | undefined) {
  const sequence = ++fixtureSequence, data = `/diagnostic-storage-busy-${sequence}`;
  type Entry = {dev: number; ino: number; path: string};
  const entries = new Map<string, Entry>(), descriptors = new Map<number, {entry: Entry; flags: number}>();
  const reached = deferred(), resume = deferred(), utility = new EventEmitter();
  let nextInode = 0, nextFd = sequence * 1000, directoryReads = 0, utilityFd = -1, signals = 0;
  let utilityClosed = false, acquisitionHeld = false;
  const add = (path: string) => {const entry = {dev: sequence, ino: ++nextInode, path}; entries.set(path, entry); return entry;};
  add('/'); add(data);
  const missing = () => Object.assign(new Error('fixture entry absent'), {code: 'ENOENT'});
  const pathOf = (input: unknown): string => {
    const path = String(input), match = /^\/proc\/self\/fd\/(\d+)(\/.*)?$/u.exec(path);
    if (!match) return path;
    const descriptor = descriptors.get(Number(match[1])); assert(descriptor, 'the bound directory descriptor must remain open');
    return resolve(descriptor.entry.path, '.' + (match[2] ?? ''));
  };
  const entryAt = (input: unknown) => {const entry = entries.get(pathOf(input)); if (!entry) throw missing(); return entry;};
  const info = (entry: Entry) => ({dev: entry.dev, ino: entry.ino, uid: process.getuid?.(), mode: 0o700,
    isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false});
  const require = createRequire(import.meta.url);
  const filesystem = require('node:fs/promises') as typeof import('node:fs/promises');
  const syncFilesystem = require('node:fs') as typeof import('node:fs');
  const children = require('node:child_process') as typeof import('node:child_process');
  t.mock.method(filesystem, 'realpath', async (input: unknown) => entryAt(input === data + '-alias' ? data : input).path);
  t.mock.method(filesystem, 'lstat', async (input: unknown) => {
    if (hold === 'locked-check' && utilityClosed && !acquisitionHeld && input === data) {
      acquisitionHeld = true; reached.resolve(); await resume.promise;
    }
    return info(entryAt(input));
  });
  const createDirectory = (input: unknown, options?: {recursive?: boolean}) => {
    const path = pathOf(input);
    if (entries.has(path)) {
      if (options?.recursive) return;
      throw Object.assign(new Error('fixture entry exists'), {code: 'EEXIST'});
    }
    entryAt(dirname(path)); add(path);
  };
  t.mock.method(filesystem, 'mkdir', async (input: unknown, options?: {recursive?: boolean}) => createDirectory(input, options));
  // Exclusive child creation and inventory pinning use synchronous descriptors;
  // async opens below adopt the same fake inode through its retained procfs FD.
  t.mock.method(syncFilesystem, 'mkdirSync', createDirectory);
  t.mock.method(syncFilesystem, 'lstatSync', (input: unknown) => info(entryAt(input)));
  t.mock.method(syncFilesystem, 'openSync', (input: unknown, flags: number) => {
    const entry = entryAt(input), fd = ++nextFd;
    assert(flags & constants.O_DIRECTORY);
    descriptors.set(fd, {entry, flags}); return fd;
  });
  t.mock.method(syncFilesystem, 'fstatSync', (fd: number) => {
    const descriptor = descriptors.get(fd); assert(descriptor, 'the synchronous inode pin must remain open');
    return info(descriptor.entry);
  });
  t.mock.method(syncFilesystem, 'closeSync', (fd: number) => {assert(descriptors.delete(fd));});
  t.mock.method(filesystem, 'readFile', async (input: unknown) => {
    const match = /^\/proc\/self\/fdinfo\/(\d+)$/u.exec(String(input)); assert(match);
    const descriptor = descriptors.get(Number(match[1])); assert(descriptor);
    return `flags:\t${descriptor.flags.toString(8)}\n`;
  });
  t.mock.method(filesystem, 'open', async (input: unknown, flags: number) => {
    // Source storage admission probes the optional migration sidecar before
    // opening its directories. Missing files must preserve ENOENT here.
    const entry = entryAt(input), fd = ++nextFd;
    assert(flags & constants.O_DIRECTORY);
    descriptors.set(fd, {entry, flags});
    if (hold === 'open' && input === data && !acquisitionHeld) {
      acquisitionHeld = true; reached.resolve(); await resume.promise;
    }
    return {fd, stat: async () => {assert(descriptors.has(fd)); return info(entry);},
      sync: async () => {}, close: async () => {descriptors.delete(fd);}};
  });
  t.mock.method(filesystem, 'opendir', async (input: unknown) => {
    assert.equal(pathOf(input), join(data, 'runner/test-processes'));
    directoryReads++;
    if (hold === 'opendir') {reached.resolve(); await resume.promise;}
    return {close: async () => {}, async *[Symbol.asyncIterator]() {yield* [];}};
  });
  t.mock.method(children, 'spawn', (command: string, args: string[], options: {stdio: unknown[]}) => {
    assert.equal(command, '/usr/bin/flock');
    assert.deepEqual(args, ['--exclusive', '--nonblock', '--conflict-exit-code', '75', '3']);
    utilityFd = options.stdio[3] as number; assert(descriptors.has(utilityFd));
    if (hold === 'flock') reached.resolve();
    else queueMicrotask(() => {utilityClosed = true; utility.emit('close', hold === 'contention' ? 75 : 0, null);});
    return utility;
  });
  t.mock.method(process, 'kill', () => {signals++; throw new Error('diagnostic initialization must never signal');});
  syncBuiltinESMExports();
  t.after(() => {resume.resolve(); utility.emit('close', 0, null); t.mock.restoreAll(); syncBuiltinESMExports();});
  return {data, descriptors, reached, resume, utility, allowRecovery: () => {hold = undefined; resume.resolve();}, directoryReads: () => directoryReads,
    utilityFd: () => utilityFd, signals: () => signals};
}

test('S3 P3 failed diagnostic acquisition retains its discovered canonical alias identity', {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const f = fixture(t, 'flock'), alias = f.data + '-alias';
  t.mock.timers.enable({apis: ['setTimeout']});
  const recovery = recoverTestRuns({data: alias});
  const refused = assert.rejects(recovery, {code: 'LOCK_UNSAFE'});
  await f.reached.promise;
  const canonicalWhilePending = runnerBusy(f.data);
  t.mock.timers.tick(2001); await refused;
  f.utility.emit('close', 0, null);
  await new Promise<void>(done => setImmediate(done));
  assert.equal(runnerBusy(alias), true, 'the requested name remains unresolved');
  assert.equal(canonicalWhilePending, true, 'discovered canonical storage stays busy during acquisition');
  assert.equal(runnerBusy(f.data), true, 'late descriptor close must retain the same canonical uncertainty');
  assert.equal(f.descriptors.size, 0);
  assert.equal(f.directoryReads(), 0);
  assert.equal(f.signals(), 0);
});

test('S3 P3 canonical identity is busy before a delayed directory open can return', {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const f = fixture(t, 'open'), alias = f.data + '-alias';
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: Date.now()});
  t.mock.method(clock, 'now', () => Date.now());
  const recovery = recoverTestRuns({data: alias});
  const refused = assert.rejects(recovery, {code: 'HELPER_BUSY'});
  await f.reached.promise;
  const canonicalPending = runnerBusy(f.data);
  t.mock.timers.tick(10_001); await refused;
  f.resume.resolve();
  for (let turn = 0; f.descriptors.size && turn < 100; turn++) await new Promise<void>(done => setImmediate(done));
  assert.equal(canonicalPending, true, 'canonical discovery must be retained before later filesystem I/O');
  assert.equal(runnerBusy(f.data), true);
  assert.equal(runnerBusy(alias), true);
  assert.equal(f.descriptors.size, 0);
  assert.equal(f.directoryReads(), 0);
  assert.equal(f.signals(), 0);
});

test('S2 diagnostic recovery stays busy while its initial retained-directory read is unresolved', {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const f = fixture(t, 'opendir');
  assert.equal(runnerBusy(f.data), false);
  const recovery = recoverTestRuns({data: f.data});
  try {
    assert.equal(runnerBusy(f.data), true);
    await f.reached.promise;
    assert.equal(f.directoryReads(), 1);
    assert.equal(f.descriptors.size, 6);
    assert.equal(runnerBusy(f.data), true, 'acquiring the lease does not certify unread diagnostic state as idle');
  } finally {f.resume.resolve(); await recovery;}
  assert.equal(runnerBusy(f.data), false, 'successful empty-ledger recovery and descriptor release establish idle');
  assert.equal(f.descriptors.size, 0);
  assert.equal(f.signals(), 0);
});

test('S2 diagnostic recovery retains busy after flock acquisition timeout and late utility close', {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const f = fixture(t, 'flock');
  t.mock.timers.enable({apis: ['setTimeout']});
  const recovery = recoverTestRuns({data: f.data});
  const refused = assert.rejects(recovery, {code: 'LOCK_UNSAFE'});
  await f.reached.promise;
  assert.equal(runnerBusy(f.data), true);
  t.mock.timers.tick(2001); await refused;
  assert.equal(f.directoryReads(), 0, 'failed acquisition must not read diagnostic state');
  assert.equal(f.descriptors.size, 1, 'the delayed utility retains its independent directory descriptor');
  assert.equal(f.descriptors.has(f.utilityFd()), true);
  const busyAtRefusal = runnerBusy(f.data);
  f.utility.emit('close', 0, null);
  await new Promise<void>(done => setImmediate(done));
  assert.equal(f.descriptors.size, 0);
  assert.equal(f.signals(), 0);
  assert.equal(busyAtRefusal, true, 'LOCK_UNSAFE cannot drop an unresolved acquisition obligation');
  assert.equal(runnerBusy(f.data), true, 'utility close cannot certify an unread diagnostic ledger as recovered');
  f.allowRecovery();
  assert.equal(await recoverTestRuns({data: f.data}), true);
  assert.equal(f.descriptors.size, 0);
  assert.equal(runnerBusy(f.data), true, 'a later empty scan cannot discharge prior unsafe-acquisition history');
});

test('S2 diagnostic skipBusy contention releases its reservation without inventing unsafe history', {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const f = fixture(t, 'contention');
  assert.equal(await recoverTestRuns({data: f.data, skipBusy: true}), false);
  const deadline = performance.now() + 1000;
  while (f.descriptors.size && performance.now() < deadline) await new Promise<void>(done => setTimeout(done, 5));
  assert.equal(f.descriptors.size, 0);
  assert.equal(f.directoryReads(), 0, 'known contention cannot inspect another diagnostic lease');
  assert.equal(runnerBusy(f.data), false, 'ordinary contention must not create permanent acquisition uncertainty');
  f.allowRecovery();
  assert.equal(await recoverTestRuns({data: f.data}), true);
  assert.equal(runnerBusy(f.data), false);
});

for (const hold of ['open', 'locked-check'] as const) {
  for (const skipBusy of [false, true]) {
    test(`S2 diagnostic ${skipBusy ? 'skipBusy ' : ''}acquisition timeout retains unread state after late ${hold} settlement`, {
      skip: process.platform !== 'linux', timeout: 10_000,
    }, async t => {
      const f = fixture(t, hold);
      t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: Date.now()});
      t.mock.method(clock, 'now', () => Date.now());
      const recovery = recoverTestRuns({data: f.data, skipBusy});
      const refused = skipBusy ? recovery.then(value => {assert.equal(value, false);}) : assert.rejects(recovery, {code: 'HELPER_BUSY'});
      await f.reached.promise;
      t.mock.timers.tick(skipBusy ? 101 : 10_001); await refused;
      assert.equal(runnerBusy(f.data), true, 'the caller timeout cannot abandon pending acquisition I/O');
      f.resume.resolve();
      for (let turn = 0; f.descriptors.size && turn < 100; turn++) await new Promise<void>(done => setImmediate(done));
      assert.equal(f.descriptors.size, 0, 'late acquisition settlement closes every unused descriptor');
      assert.equal(f.directoryReads(), 0);
      assert.equal(runnerBusy(f.data), true, 'closing an unused acquisition cannot certify the unread diagnostic ledger');
      assert.equal(f.signals(), 0);
    });
  }
}
