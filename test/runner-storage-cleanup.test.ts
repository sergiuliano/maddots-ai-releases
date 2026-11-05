import assert from 'node:assert/strict';
import * as filesystem from 'node:fs/promises';
import {lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile} from 'node:fs/promises';
import {createRequire, syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {AdapterRegistry} from '../src/runner/adapters/index.js';
import {cleanupRunHomes, PROCESS_CLEANUP_CAP_MS} from '../src/runner/process.js';
import {RunnerCore} from '../src/runner/runner.js';
import {acquireRunnerStorageLock} from '../src/runner/storage-lock.js';
import {initializeCleanRunnerJournal} from './support/runner-journal-fixture.js';

const fsp = createRequire(import.meta.url)('node:fs/promises') as typeof filesystem;
const linux = {skip: process.platform !== 'linux', timeout: 10_000};
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 3000;
  while (!check() && performance.now() < deadline) await flush();
  assert(check(), 'the held filesystem operation must progress');
}

async function retainedFixture(t: TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-cleanup-bound-'));
  const data = join(root, 'data');
  await mkdir(data, {mode: 0o700});
  const lock = await acquireRunnerStorageLock(data), directory = await lock.directory('run-homes');
  t.after(async () => {await lock.release(); await rm(root, {recursive: true, force: true});});
  const home = join(data, 'run-homes/old-run'), nested = join(home, 'nested');
  await mkdir(nested, {recursive: true, mode: 0o700});
  await writeFile(join(nested, 'evidence'), 'old evidence');
  return {root, data, lock, directory, home, nested, clean: () => cleanupRunHomes(data, {directory})};
}

test('S1 review3 P2: cleanup after an empty ledger load never deletes replacement storage run homes', {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-cleanup-replaced-'));
  const data = join(root, 'data');
  await mkdir(data, {mode: 0o700});
  await initializeCleanRunnerJournal(data);
  const core = new RunnerCore({data, registry: new AdapterRegistry([]), connections: async () => [], localAgents: async () => [],
    verifiedBuild: async () => true, allowedBuild: async () => true, stageSkills: async () => {},
    deliver: async () => {assert.fail('initialization never delivers');}, removeDeviceKey: async () => {}});
  t.after(async () => {await core.close(); await rm(root, {recursive: true, force: true});});
  const original = core['state'].active.bind(core['state']);
  const sentinel = join(data, 'run-homes/successor-run/evidence');
  let loaded = false;
  t.mock.method(core['state'], 'active', async () => {
    const rows = await original();
    assert.deepEqual(rows, []);
    assert(core['owner'], 'the old empty ledger is read under its retained owner');
    loaded = true;
    await rename(data, join(root, 'retained-data'));
    await mkdir(join(data, 'run-homes/successor-run'), {recursive: true, mode: 0o700});
    await writeFile(sentinel, 'successor recovery evidence');
    return rows;
  });
  await assert.rejects(core.init(), {code: 'RUNNER_STATE_UNAVAILABLE'});
  assert.equal(loaded, true);
  assert.equal(await readFile(sentinel, 'utf8'), 'successor recovery evidence',
    'refusing initialization after deleting the replacement is too late');
});

test('descriptor-bound cleanup removes nested files, skips diagnostic homes and closes child descriptors', linux, async t => {
  const f = await retainedFixture(t), diagnostic = `test-${'a'.repeat(32)}`;
  await mkdir(join(f.data, 'run-homes', diagnostic), {mode: 0o700});
  await writeFile(join(f.data, 'run-homes', diagnostic, 'keep'), 'diagnostic is independently leased');
  const before = (await readdir('/proc/self/fd')).length;
  const originalRm = fsp.rm;
  fsp.rm = (async () => {assert.fail('descriptor-bound cleanup must not call recursive rm');}) as typeof originalRm;
  syncBuiltinESMExports();
  try {
    await cleanupRunHomes(f.data, {directory: f.directory, skipTests: true});
    assert.deepEqual(await readdir(join(f.data, 'run-homes')), [diagnostic]);
    assert.equal(await readFile(join(f.data, 'run-homes', diagnostic, 'keep'), 'utf8'), 'diagnostic is independently leased');
    assert.equal((await readdir('/proc/self/fd')).length, before, 'all traversal descriptors close after physical settlement');
  } finally {fsp.rm = originalRm; syncBuiltinESMExports();}
});

for (const replacement of ['data', 'run-homes', 'run', 'nested'] as const) {
  test(`descriptor-bound cleanup cannot traverse a ${replacement} replacement while unlink is queued`, linux, async t => {
    const f = await retainedFixture(t), originalUnlink = fsp.unlink;
    let intercepted = false;
    const changed = replacement === 'data' ? f.data : replacement === 'run-homes' ? join(f.data, 'run-homes') :
      replacement === 'run' ? f.home : f.nested;
    const sentinel = join(changed, 'successor/evidence');
    fsp.unlink = (async (...args: Parameters<typeof originalUnlink>) => {
      if (!intercepted && String(args[0]).startsWith('/proc/self/fd/') && String(args[0]).endsWith('/evidence')) {
        intercepted = true;
        await rename(changed, join(f.root, 'retained-subtree'));
        await mkdir(join(changed, 'successor'), {recursive: true, mode: 0o700});
        await writeFile(sentinel, 'replacement evidence');
      }
      return originalUnlink(...args);
    }) as typeof originalUnlink;
    syncBuiltinESMExports();
    try {
      await assert.rejects(f.clean());
      assert.equal(intercepted, true);
      assert.equal(await readFile(sentinel, 'utf8'), 'replacement evidence');
    } finally {fsp.unlink = originalUnlink; syncBuiltinESMExports();}
  });
}

for (const replacement of ['directory', 'symlink'] as const) {
  test(`descriptor-bound cleanup refuses a child ${replacement} swapped during its no-follow open`, linux, async t => {
    const f = await retainedFixture(t), originalOpen = fsp.open;
    const successor = join(f.root, 'successor');
    await mkdir(successor, {mode: 0o700}); await writeFile(join(successor, 'keep'), 'successor evidence');
    let intercepted = false;
    fsp.open = (async (...args: Parameters<typeof originalOpen>) => {
      if (!intercepted && String(args[0]).startsWith('/proc/self/fd/') && String(args[0]).endsWith('/nested')) {
        intercepted = true;
        await rename(f.nested, join(f.root, 'retained-nested'));
        if (replacement === 'directory') await rename(successor, f.nested);
        else await symlink(successor, f.nested);
      }
      return originalOpen(...args);
    }) as typeof originalOpen;
    syncBuiltinESMExports();
    try {
      await assert.rejects(f.clean());
      assert.equal(intercepted, true);
      assert.equal(await readFile(join(replacement === 'directory' ? f.nested : successor, 'keep'), 'utf8'), 'successor evidence');
      assert.equal(await readFile(join(f.root, 'retained-nested/evidence'), 'utf8'), 'old evidence');
    } finally {fsp.open = originalOpen; syncBuiltinESMExports();}
  });
}

test('descriptor-bound cleanup never recursively removes a directory replaced while rmdir is queued', linux, async t => {
  const f = await retainedFixture(t), originalRmdir = fsp.rmdir;
  let intercepted = false;
  fsp.rmdir = (async (...args: Parameters<typeof originalRmdir>) => {
    if (!intercepted && String(args[0]).startsWith('/proc/self/fd/') && String(args[0]).endsWith('/nested')) {
      intercepted = true;
      await rename(f.nested, join(f.root, 'retained-nested'));
      await mkdir(f.nested, {mode: 0o700});
      await writeFile(join(f.nested, 'keep'), 'replacement evidence');
    }
    return originalRmdir(...args);
  }) as typeof originalRmdir;
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.clean(), {code: 'ENOTEMPTY'});
    assert.equal(intercepted, true);
    assert.equal(await readFile(join(f.nested, 'keep'), 'utf8'), 'replacement evidence');
  } finally {fsp.rmdir = originalRmdir; syncBuiltinESMExports();}
});

test('descriptor-bound cleanup validates the full batch before deleting and refuses symlink traversal', linux, async t => {
  const f = await retainedFixture(t), external = join(f.root, 'external');
  await mkdir(external, {mode: 0o700}); await writeFile(join(external, 'keep'), 'external evidence');
  await mkdir(join(f.data, 'run-homes/z-unsafe'), {mode: 0o700});
  await symlink(external, join(f.data, 'run-homes/z-unsafe/link'));
  const before = (await readdir('/proc/self/fd')).length;
  await assert.rejects(f.clean(), {code: 'adapter_refused'});
  assert.equal(await readFile(join(f.nested, 'evidence'), 'utf8'), 'old evidence');
  assert.equal(await readFile(join(external, 'keep'), 'utf8'), 'external evidence');
  assert.equal((await readdir('/proc/self/fd')).length, before, 'failed inspection also closes every retained child');
});

test('standalone Linux cleanup acquires a retained lock and never uses recursive rm', linux, async t => {
  const f = await retainedFixture(t);
  await f.lock.release();
  const originalRm = fsp.rm, originalUnlink = fsp.unlink;
  let intercepted = false;
  fsp.rm = (async () => {assert.fail('standalone Linux cleanup must use retained traversal');}) as typeof originalRm;
  fsp.unlink = (async (...args: Parameters<typeof originalUnlink>) => {
    if (!intercepted && String(args[0]).startsWith('/proc/self/fd/') && String(args[0]).endsWith('/evidence')) {
      intercepted = true;
      await assert.rejects(acquireRunnerStorageLock(f.data), {code: 'HELPER_BUSY'}, 'the physical cleanup retains exclusion');
    }
    return originalUnlink(...args);
  }) as typeof originalUnlink;
  syncBuiltinESMExports();
  try {
    await cleanupRunHomes(f.data);
    assert.equal(intercepted, true);
    assert.deepEqual(await readdir(join(f.data, 'run-homes')), []);
    const next = await acquireRunnerStorageLock(f.data); await next.release();
    await cleanupRunHomes(join(f.root, 'missing'));
    await assert.rejects(lstat(join(f.root, 'missing')), {code: 'ENOENT'}, 'missing-data cleanup does not create directories');
  } finally {fsp.rm = originalRm; fsp.unlink = originalUnlink; syncBuiltinESMExports();}
});

test('a safely refused leftover symlink keeps the ledger usable for adapters without run homes', linux, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-cleanup-unsafe-'));
  const data = join(root, 'data');
  await mkdir(join(data, 'run-homes'), {recursive: true, mode: 0o700});
  await initializeCleanRunnerJournal(data);
  await symlink(root, join(data, 'run-homes/unsafe'));
  const core = new RunnerCore({data, registry: new AdapterRegistry([]), connections: async () => [], localAgents: async () => [],
    verifiedBuild: async () => true, allowedBuild: async () => true, stageSkills: async () => {},
    deliver: async () => {assert.fail('initialization never delivers');}, removeDeviceKey: async () => {}});
  t.after(async () => {await core.close(); await rm(root, {recursive: true, force: true});});
  await core.init(); await core.init();
  assert.equal(core['runHomesUnsafe'], true);
  assert.equal(core['owner']!.admissionBlocked, false, 'benign unsafe contents do not poison retained storage');
  assert.equal((await lstat(join(data, 'run-homes/unsafe'))).isSymbolicLink(), true);
});

test('a cleanup timeout and core close retain ownership until physical deletion settles', linux, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-cleanup-timeout-'));
  const data = join(root, 'data');
  await mkdir(join(data, 'run-homes/old-run/nested'), {recursive: true, mode: 0o700});
  await initializeCleanRunnerJournal(data);
  await writeFile(join(data, 'run-homes/old-run/nested/evidence'), 'old evidence');
  const options = {data, registry: new AdapterRegistry([]), connections: async () => [], localAgents: async () => [],
    verifiedBuild: async () => true, allowedBuild: async () => true, stageSkills: async () => {},
    deliver: async () => {assert.fail('initialization never delivers');}, removeDeviceKey: async () => {}};
  const core = new RunnerCore(options), successor = new RunnerCore(options), originalUnlink = fsp.unlink;
  let held = false, resume!: () => void;
  const delayed = new Promise<void>(resolve => {resume = resolve;});
  fsp.unlink = (async (...args: Parameters<typeof originalUnlink>) => {
    if (!held && String(args[0]).startsWith('/proc/self/fd/') && String(args[0]).endsWith('/evidence')) {
      held = true; await delayed;
    }
    return originalUnlink(...args);
  }) as typeof originalUnlink;
  syncBuiltinESMExports();
  t.after(async () => {
    resume(); t.mock.timers.reset();
    fsp.unlink = originalUnlink; syncBuiltinESMExports();
    await core.close(); await successor.close(); await rm(root, {recursive: true, force: true});
  });
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
  const initialization = core.init();
  const refused = assert.rejects(initialization, {code: 'RUNNER_STATE_UNAVAILABLE'});
  await until(() => held);
  const owner = core['owner']!;
  const descriptors = (await readdir('/proc/self/fd')).length;
  t.mock.timers.tick(PROCESS_CLEANUP_CAP_MS); await refused;
  await core.close();
  assert.equal(core.busy, true);
  assert.equal(owner['pending'], 1, 'physical cleanup still owns the serial slot after its caller times out');
  assert.equal((await readdir('/proc/self/fd')).length, descriptors, 'close cannot release descriptors used by pending cleanup');
  await assert.rejects(successor.init(), {code: 'RUNNER_STATE_UNAVAILABLE'});
  assert.equal(await readFile(join(data, 'run-homes/old-run/nested/evidence'), 'utf8'), 'old evidence');
  resume(); await until(() => owner['pending'] === 0);
  assert.deepEqual(await readdir(join(data, 'run-homes')), []);
  await successor.init();
  assert.equal(successor.busy, false, 'successful physical cleanup permits explicit clean handoff');
  await assert.rejects(lstat(join(data, 'run-homes/old-run')), {code: 'ENOENT'});
});
