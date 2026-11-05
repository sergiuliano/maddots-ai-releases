import assert from 'node:assert/strict';
import {AdapterRegistry} from '../src/runner/adapters/index.js';
import {randomUUID} from 'node:crypto';
import * as filesystem from 'node:fs/promises';
import {mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile} from 'node:fs/promises';
import {createRequire, syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {linuxContainmentAdmission} from '../src/runner/journal.js';
import {withLinuxOwnerContext} from '../src/runner/linux-lifecycle.js';
import {cleanupRunHome, type ProcessInspector} from '../src/runner/process.js';
import {RunsOnController, type RunsOnOptions} from '../src/runner/runs-on.js';
import {acquireRunnerControllerLease, acquireRunnerStorageLock, controllerStorageBusy} from '../src/runner/storage-lock.js';
import type {RunnerStorageOwner} from '../src/runner/storage-owner.js';
import {diagnosticStorageBusy, recoverTestRuns, runToolTest} from '../src/runner/test-run.js';

const fsp = createRequire(import.meta.url)('node:fs/promises') as typeof filesystem;
const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
const nativeOpen = fsp.open;

/** Keep the real Linux lease and retained row read, then select the existing
 * Darwin observer only for the historical S1 publication/storage schedule.
 * Production Linux requires durable containment retirement and never installs
 * this seam. Restore Linux before any subsequent native lease acquisition. */
function historicalDiagnosticAfterRetainedRead(t: TestContext, aiToolId: string): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const open = fsp.open;
  let selected = false;
  const restore = () => Object.defineProperty(process, 'platform', descriptor);
  fsp.open = (async (...args: Parameters<typeof open>) => {
    const file = await open(...args);
    if (!selected && String(args[0]).startsWith('/proc/self/fd/') && String(args[0]).endsWith(aiToolId + '.json')) {
      selected = true;
      Object.defineProperty(process, 'platform', {...descriptor, value: 'darwin'});
    }
    return file;
  }) as typeof open;
  syncBuiltinESMExports();
  t.after(() => {restore(); fsp.open = nativeOpen; syncBuiltinESMExports();});
  return restore;
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-controller-bound-'));
  const data = join(root, 'data'); await mkdir(data, {mode: 0o700});
  t.after(() => rm(root, {recursive: true, force: true}));
  return {root, data};
}
const absent: ProcessInspector = {identity: async () => null, table: async () => [], fencePids: async () => []};

test('Linux controller leaf leases nest under an owned core root and exclude only their own subsystem', {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const {data} = await fixture(t), core = await acquireRunnerStorageLock(data);
  const activation = await acquireRunnerControllerLease(data, 'activation');
  const tests = await acquireRunnerControllerLease(data, 'tests');
  try {
    await assert.rejects(acquireRunnerControllerLease(data, 'activation', undefined, Date.now() + 100), {code: 'HELPER_BUSY'});
    await assert.rejects(acquireRunnerControllerLease(data, 'tests', undefined, Date.now() + 100), {code: 'HELPER_BUSY'});
    await core.assertCurrent(); await activation.assertCurrent(); await tests.assertCurrent();
  } finally {await tests.release(); await activation.release(); await core.release();}
  const successor = await acquireRunnerControllerLease(data, 'tests'); await successor.release();
});

for (const replacement of ['before cleanup', 'during queued unlink'] as const) {
  test(`Linux single-home cleanup preserves a replacement home ${replacement}`, {skip: process.platform !== 'linux'}, async t => {
    const {root, data} = await fixture(t), runId = 'test-owned';
    const lock = await acquireRunnerStorageLock(data), directory = await lock.directory('run-homes');
    await mkdir(join(data, 'run-homes', runId), {mode: 0o700});
    await writeFile(join(data, 'run-homes', runId, 'sentinel'), 'original');
    const originalUnlink = fsp.unlink;
    let changed = false;
    const replace = async () => {
      await rename(data, join(root, 'original'));
      await mkdir(join(data, 'run-homes', runId), {recursive: true, mode: 0o700});
      await writeFile(join(data, 'run-homes', runId, 'sentinel'), 'replacement'); changed = true;
    };
    t.after(async () => {fsp.unlink = originalUnlink; syncBuiltinESMExports(); await lock.release();});
    if (replacement === 'before cleanup') await replace();
    else {
      fsp.unlink = (async (...args: Parameters<typeof originalUnlink>) => {
        if (!changed && String(args[0]).startsWith('/proc/self/fd/') && String(args[0]).endsWith('/sentinel')) await replace();
        return originalUnlink(...args);
      }) as typeof originalUnlink;
      syncBuiltinESMExports();
    }
    await assert.rejects(cleanupRunHome(data, runId, {directory}));
    assert.equal(changed, true);
    assert.equal(await readFile(join(data, 'run-homes', runId, 'sentinel'), 'utf8'), 'replacement');
  });
}

test('Linux diagnostic recovery retains its original home and ledger binding when storage is replaced after row load', {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  // Isolate the S1 retained-directory schedule; default S2 recovery refuses below.
  t.mock.method(linuxContainmentAdmission, 'requireAvailable', () => {});
  const {root, data} = await fixture(t), aiToolId = randomUUID(), fence = '1234567890abcdef1234567890abcdef';
  const cwd = await mkdtemp(join(await realpath(tmpdir()), 'maddots-ai-test-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  const ledger = join(data, 'runner/test-processes', aiToolId + '.json');
  const home = join(data, 'run-homes', `test-${fence}`);
  await mkdir(join(data, 'runner/test-processes'), {recursive: true, mode: 0o700});
  await mkdir(home, {recursive: true, mode: 0o700}); await writeFile(join(home, 'sentinel'), 'original');
  const row = JSON.stringify({format: 1, aiToolId, cwd, fence, pid: 0, startedAt: '', groups: []});
  await writeFile(ledger, row, {mode: 0o600});
  const restorePlatform = historicalDiagnosticAfterRetainedRead(t, aiToolId);
  let changed = false;
  await assert.rejects(recoverTestRuns({data, processes: {...absent, fencePids: async () => {
    if (!changed) {
      changed = true; await rename(data, join(root, 'original'));
      await mkdir(join(data, 'runner/test-processes'), {recursive: true, mode: 0o700});
      await mkdir(home, {recursive: true, mode: 0o700}); await writeFile(join(home, 'sentinel'), 'replacement');
      await writeFile(ledger, row, {mode: 0o600});
    }
    return [];
  }}}), {code: 'RUNNER_TEST_RECOVERY_UNAVAILABLE'});
  restorePlatform();
  assert.equal(changed, true);
  assert.equal(await readFile(join(home, 'sentinel'), 'utf8'), 'replacement');
  assert.equal(await readFile(ledger, 'utf8'), row);
  assert.equal(await readFile(join(root, 'original/runner/test-processes', aiToolId + '.json'), 'utf8'), row);
});

function controllerOptions(data: string): RunsOnOptions {
  return {paths: {data}, keys: {ensure: async () => {throw new Error('No activation key may be created.');},
    get: async () => undefined, remove: async () => {}, registerExisting: async () => {throw new Error('No registration.');}},
    connection: async () => undefined, protocol: () => ({testResult: async () => {}, heartbeat: async () => ({})}) as never,
    test: async () => {throw new Error('No tool may be started.');}};
}
for (const operation of ['read', 'write'] as const) {
  test(`Linux activation ${operation} keeps the retained controller directory during queued filesystem work`, {
    skip: process.platform !== 'linux', timeout: 10_000,
  }, async t => {
    const {root, data} = await fixture(t), file = join(data, 'runner/runs.json');
    await mkdir(join(data, 'runner'), {mode: 0o700}); await writeFile(file, '{"format":1,"tools":[]}', {mode: 0o600});
    const controller = new RunsOnController(controllerOptions(data));
    const open = fsp.open, originalRename = fsp.rename, openSync = fs.openSync;
    const temporaryPins = new Set<number>();
    let changed = false, seamFired = 0;
    const replace = async () => {
      changed = true; await originalRename(data, join(root, 'original'));
      await mkdir(join(data, 'runner'), {recursive: true, mode: 0o700});
      await writeFile(file, 'replacement sentinel', {mode: 0o600});
    };
    t.after(async () => {fsp.open = open; fs.openSync = openSync; syncBuiltinESMExports(); await controller.close().catch(() => {});});
    if (operation === 'read') {
      fsp.open = (async (...args: Parameters<typeof open>) => {
        if (!changed && String(args[0]).startsWith('/proc/self/fd/') && String(args[0]).endsWith('/runs.json')) await replace();
        return open(...args);
      }) as typeof open;
    } else {
      fs.openSync = ((...args: Parameters<typeof openSync>) => {
        const fd = openSync(...args);
        if (String(args[0]).startsWith('/proc/self/fd/') && /\/\.runs\.json\.[a-f0-9-]+\.tmp$/u.test(String(args[0]))) temporaryPins.add(fd);
        return fd;
      }) as typeof openSync;
      fsp.open = (async (...args: Parameters<typeof open>) => {
        const file = await open(...args), adopted = /^\/proc\/self\/fd\/(\d+)$/u.exec(String(args[0]));
        if (adopted && temporaryPins.delete(Number(adopted[1]))) {
          const sync = file.sync.bind(file);
          file.sync = async () => {await sync(); seamFired++; await replace();};
        }
        return file;
      }) as typeof open;
    }
    syncBuiltinESMExports();
    if (operation === 'read') await assert.rejects(controller.init(), {code: 'RUNNER_STATE_INVALID'});
    else {
      await controller.syncGrants([{aiToolId: randomUUID(), expiresAt: new Date(Date.now() + 60_000).toISOString()}]);
      await controller.idle().catch(() => {});
    }
    assert.equal(changed, true);
    if (operation === 'write') {
      assert.equal(seamFired, 1, 'the adopted runs.json payload fsync must reach the replacement schedule');
      assert.equal(await readFile(join(root, 'original/runner/runs.json'), 'utf8'), '{"format":1,"tools":[]}',
        'a refused activation write must preserve the displaced publication as evidence');
    }
    assert.equal(await readFile(file, 'utf8'), 'replacement sentinel');
  });
}

test('Linux diagnostic timeout retains its leaf lease and descriptors until a delayed observation publication settles', {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  // Isolate the S1 physical writer schedule; this is not S2 admission proof.
  t.mock.method(linuxContainmentAdmission, 'requireAvailable', () => {});
  const {data} = await fixture(t), aiToolId = randomUUID(), cwd = await mkdtemp(join(await realpath(tmpdir()), 'maddots-ai-test-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  const ledger = join(data, 'runner/test-processes', aiToolId + '.json');
  await mkdir(join(data, 'runner/test-processes'), {recursive: true, mode: 0o700});
  await writeFile(ledger, JSON.stringify({format: 1, aiToolId, cwd, fence: '1234567890abcdef1234567890abcdef',
    pid: 0, startedAt: '', groups: [], legacyProcessIdentity: true}), {mode: 0o600});
  const open = fsp.open, openSync = fs.openSync, temporaryPins = new Set<number>();
  let held!: () => void, resume!: () => void, armed = true, clockStarted = false, seamFired = 0;
  const reached = new Promise<void>(resolve => {held = resolve;}), delayed = new Promise<void>(resolve => {resume = resolve;});
  t.after(() => {resume(); t.mock.timers.reset(); fsp.open = open; fs.openSync = openSync; syncBuiltinESMExports();});
  fs.openSync = ((...args: Parameters<typeof openSync>) => {
    const fd = openSync(...args);
    if (String(args[0]).startsWith('/proc/self/fd/') && String(args[0]).includes('/.' + aiToolId + '.json.') && String(args[0]).endsWith('.tmp')) temporaryPins.add(fd);
    return fd;
  }) as typeof openSync;
  fsp.open = (async (...args: Parameters<typeof open>) => {
    const file = await open(...args);
    if (!clockStarted && String(args[0]).endsWith(aiToolId + '.json')) {
      clockStarted = true; t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
    }
    const adopted = /^\/proc\/self\/fd\/(\d+)$/u.exec(String(args[0]));
    if (armed && adopted && temporaryPins.delete(Number(adopted[1]))) {
      armed = false; const sync = file.sync.bind(file);
      file.sync = async () => {seamFired++; held(); await delayed; return sync();};
    }
    return file;
  }) as typeof open;
  syncBuiltinESMExports();
  const restorePlatform = historicalDiagnosticAfterRetainedRead(t, aiToolId);
  const call = recoverTestRuns({data, processes: absent});
  const rejected = assert.rejects(call, {code: 'RUNNER_TEST_RECOVERY_UNAVAILABLE'});
  await reached;
  assert.equal(seamFired, 1, 'the adopted diagnostic payload must reach its held fsync');
  t.mock.timers.tick(20_000); await rejected; t.mock.timers.reset();
  restorePlatform();
  assert.equal(diagnosticStorageBusy(data), true, 'the timed-out physical publication keeps global busy set');
  await assert.rejects(acquireRunnerControllerLease(data, 'tests', undefined, Date.now() + 100), {code: 'HELPER_BUSY'});
  resume();
  const successor = await acquireRunnerControllerLease(data, 'tests');
  await successor.release();
  const deadline = performance.now() + 5000;
  while (diagnosticStorageBusy(data) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(diagnosticStorageBusy(data), false, 'settled successful physical work can release its retained lease');
  assert.deepEqual(JSON.parse(await readFile(ledger, 'utf8')).legacyProcessGroups, [], 'late publication remains durable recovery evidence');
});

test('S2 Linux diagnostics refuse before adapter discovery, controller leases or launcher work, including no-data callers', {
  skip: process.platform !== 'linux',
}, async t => {
  const {data} = await fixture(t), registry = new AdapterRegistry([]);
  let discoveries = 0;
  t.mock.method(registry, 'get', () => {discoveries++; throw new Error('No adapter discovery before admission.');});
  const connection = {aiToolId: randomUUID(), tool: 'codex', toolVersion: 'fixture', bin: '/fixture/tool', realpath: '/fixture/tool'};
  // S3 now acquires an owner for standalone diagnostics. Preserve this S2
  // early-admission contract with an explicit already-held, unavailable owner
  // context; its generation check refuses before any standalone acquisition.
  const owner = {state: {data}, assertGeneration: () => {}};
  await withLinuxOwnerContext(owner as unknown as RunnerStorageOwner, 1, async () => {
    owner.assertGeneration = () => linuxContainmentAdmission.requireAvailable();
    for (const directory of [data, undefined]) {
      assert.deepEqual(await runToolTest({data: directory, connection, registry}),
        {ok: false, code: 'LINUX_CONTAINMENT_UNAVAILABLE', toolVersion: 'fixture'});
    }
  });
  assert.equal(discoveries, 0);
  assert.deepEqual(await fsp.readdir(data), [], 'the refusal must not create a lease, ledger, run home or launcher artifact');
});

test('S2 Linux diagnostic recovery preserves every legacy row and home without any process scan or signal', {
  skip: process.platform !== 'linux',
}, async t => {
  const {data} = await fixture(t), aiToolId = randomUUID(), fence = '1234567890abcdef1234567890abcdef';
  const ledger = join(data, 'runner/test-processes', aiToolId + '.json'), home = join(data, 'run-homes', `test-${fence}`);
  await mkdir(join(data, 'runner/test-processes'), {recursive: true, mode: 0o700});
  await mkdir(home, {recursive: true, mode: 0o700}); await writeFile(join(home, 'sentinel'), 'unresolved');
  const row = JSON.stringify({format: 1, aiToolId, cwd: '/unexamined/workspace', fence, pid: 999999, startedAt: 'old', groups: []});
  await writeFile(ledger, row, {mode: 0o600});
  let scans = 0;
  const inspect = async () => {scans++; throw new Error('No diagnostic scan may discharge a legacy row.');};
  await assert.rejects(recoverTestRuns({data, processes: {identity: inspect, table: inspect, fencePids: inspect}}), {code: 'RUNNER_TEST_RECOVERY_UNAVAILABLE'});
  assert.equal(scans, 0);
  assert.equal(diagnosticStorageBusy(data), true, 'legacy recovery uncertainty remains globally busy');
  assert.equal(await readFile(ledger, 'utf8'), row);
  assert.equal(await readFile(join(home, 'sentinel'), 'utf8'), 'unresolved');
});

test('S2 Linux diagnostic recovery accepts an empty retained ledger without process inspection', {
  skip: process.platform !== 'linux',
}, async t => {
  const {data} = await fixture(t);
  const inspect = async () => {throw new Error('An empty ledger needs no process inspection.');};
  assert.equal(await recoverTestRuns({data, processes: {identity: inspect, table: inspect, fencePids: inspect}}), true);
});

test('Linux controller acquisition timeout retains a delayed open and closes its late descriptor before clearing busy', {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const {data} = await fixture(t), open = fsp.open;
  let armed = true, closed = false, held!: () => void, resume!: () => void;
  const reached = new Promise<void>(resolve => {held = resolve;}), delayed = new Promise<void>(resolve => {resume = resolve;});
  t.after(() => {resume(); fsp.open = open; syncBuiltinESMExports();});
  fsp.open = (async (...args: Parameters<typeof open>) => {
    const file = await open(...args);
    if (armed && args[0] === data) {
      armed = false; const close = file.close.bind(file);
      file.close = async () => {await close(); closed = true;};
      held(); await delayed;
    }
    return file;
  }) as typeof open;
  syncBuiltinESMExports();
  const started = performance.now(), work = acquireRunnerControllerLease(data, 'tests', undefined, Date.now() + 100);
  const refused = assert.rejects(work, {code: 'HELPER_BUSY'});
  await reached; await refused;
  assert.ok(performance.now() - started < 1000);
  assert.equal(closed, false); assert.equal(controllerStorageBusy(data), true);
  resume();
  const deadline = performance.now() + 5000;
  while (controllerStorageBusy(data) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(closed, true); assert.equal(controllerStorageBusy(data), false);
});

test('Linux failed diagnostic publication retains uncertainty and excludes successors after physical settlement', {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  // Historical observer schedule only, production admission remains closed.
  t.mock.method(linuxContainmentAdmission, 'requireAvailable', () => {});
  const {data} = await fixture(t), aiToolId = randomUUID(), cwd = await mkdtemp(join(await realpath(tmpdir()), 'maddots-ai-test-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  const ledger = join(data, 'runner/test-processes', aiToolId + '.json');
  await mkdir(join(data, 'runner/test-processes'), {recursive: true, mode: 0o700});
  await writeFile(ledger, JSON.stringify({format: 1, aiToolId, cwd, fence: '1234567890abcdef1234567890abcdef',
    pid: 0, startedAt: '', groups: [], legacyProcessIdentity: true}), {mode: 0o600});
  const originalRename = fs.renameSync;
  let failed = false, seamFired = 0;
  t.after(() => {fs.renameSync = originalRename; syncBuiltinESMExports();});
  fs.renameSync = ((...args: Parameters<typeof originalRename>) => {
    originalRename(...args);
    if (!failed && String(args[1]).startsWith('/proc/self/fd/') && String(args[1]).endsWith(aiToolId + '.json')) {
      seamFired++; failed = true; throw Object.assign(new Error('uncertain diagnostic rename'), {code: 'EIO'});
    }
  }) as typeof originalRename;
  syncBuiltinESMExports();
  const restorePlatform = historicalDiagnosticAfterRetainedRead(t, aiToolId);
  await assert.rejects(recoverTestRuns({data, processes: absent}), {code: 'RUNNER_TEST_RECOVERY_UNAVAILABLE'});
  restorePlatform();
  assert.equal(seamFired, 1, 'the actual diagnostic rename syscall must publish before its injected acknowledgment failure');
  assert.equal(failed, true); assert.equal(diagnosticStorageBusy(data), true);
  await assert.rejects(acquireRunnerControllerLease(data, 'tests', undefined, Date.now() + 100), {code: 'HELPER_BUSY'});
  assert.deepEqual(JSON.parse(await readFile(ledger, 'utf8')).legacyProcessGroups, []);
});
