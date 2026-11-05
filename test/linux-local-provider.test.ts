import assert from 'node:assert/strict';
import {fstatSync} from 'node:fs';
import fsPromises, {chmod, readFile, rename, symlink, writeFile, type FileHandle} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {dirname, join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {assertLinuxLocalProviderSpec, LINUX_LOCAL_PROVIDER_MODEL, LINUX_LOCAL_PROVIDER_URL, linuxLocalProviderSelection,
  LINUX_LOCAL_PROVIDER_PREPARE_MS, parseLinuxLocalProviderInventory, preparedLinuxLocalProvider, prepareLinuxLocalProvider, revalidateLinuxLocalProvider} from '../src/runner/linux-local-provider.js';
import {createOpenCodeAdapter} from '../src/runner/adapters/opencode.js';
import {localProviderFixture} from './support/linux-local-provider-fixture.js';

test('Linux local provider selects one explicit policy tag and refuses aliases and alternate providers', () => {
  const input = {tool: 'opencode', provider: 'ollama', model: LINUX_LOCAL_PROVIDER_MODEL};
  assert(linuxLocalProviderSelection(input));
  assert(linuxLocalProviderSelection({...input, provider: null, model: `ollama/${LINUX_LOCAL_PROVIDER_MODEL}`}));
  for (const model of ['latest', 'qwen3-coder:30b-a3b-q4_K_M', 'mdai-qwen3-coder:latest', `ollama/${LINUX_LOCAL_PROVIDER_MODEL}`, `${LINUX_LOCAL_PROVIDER_MODEL}/fallback`]) {
    assert.equal(linuxLocalProviderSelection({...input, model}), false);
  }
  for (const provider of ['lmstudio', 'openrouter', 'custom', null]) assert.equal(linuxLocalProviderSelection({...input, provider}), false);
  const adapter = createOpenCodeAdapter({platform: 'linux', pathPresent: () => false, home: () => '/home/fixture'});
  assert(adapter.supports({...input, effort: null, access: 'full_access'}).ok);
  for (const provider of ['lmstudio', 'custom']) assert.equal(adapter.supports({...input, provider, effort: null, access: 'full_access'}).ok, false);
  for (const model of ['latest', 'qwen3:8b']) assert.equal(adapter.supports({...input, model, effort: null, access: 'full_access'}).ok, false);
});

test('Linux local provider is immutable, JSON-safe, fully pinned, and opaque after data-only preparation', async t => {
  const fixture = await localProviderFixture(t), spec = (await fixture.prepare())!;
  assertLinuxLocalProviderSpec(spec);
  assert.equal(preparedLinuxLocalProvider(fixture.input), spec);
  assert.equal(spec.model, LINUX_LOCAL_PROVIDER_MODEL); assert.equal(spec.baseURL, LINUX_LOCAL_PROVIDER_URL);
  assert.equal(spec.files.length, fixture.inventory.closure.files.length + fixture.inventory.store.blobs.length + 3);
  assert.equal(spec.resources.memoryMax, 25_000_000_000); assert.equal(spec.resources.cpuMax, '1600000 100000');
  assert.deepEqual(spec.parameters, {num_thread: 16, num_ctx: 8192, num_gpu: 0});
  assert.equal(spec.env.OLLAMA_MODELS, spec.modelsPath); assert.equal(spec.env.OLLAMA_NO_CLOUD, '1');
  assert(Object.isFrozen(spec)); assert(Object.isFrozen(spec.env)); assert(Object.isFrozen(spec.files[0]));
  assert.throws(() => assertLinuxLocalProviderSpec(JSON.parse(JSON.stringify(spec))), /preparation is required/);
  await revalidateLinuxLocalProvider(spec);
  assert.equal(await prepareLinuxLocalProvider({tool: 'codex', provider: null, model: 'default'}), undefined);
});

test('Linux OpenCode keeps primary and small models on the fixed namespace URL', () => {
  const adapter = createOpenCodeAdapter({platform: 'linux', home: () => '/home/fixture', pathPresent: () => false});
  const invocation = adapter.build({bin: '/usr/local/bin/opencode', cwd: '/work', runDir: '/work/.maddots/runs/fixture', promptFile: '/work/prompt',
    skillsDir: '/work/skills', provider: 'ollama', model: LINUX_LOCAL_PROVIDER_MODEL, effort: null, access: 'full_access', maxTurns: 10, timeoutSeconds: 60, runHome: null});
  const overlay = JSON.parse(invocation.env.OPENCODE_CONFIG_CONTENT);
  assert.equal(overlay.model, `ollama/${LINUX_LOCAL_PROVIDER_MODEL}`); assert.equal(overlay.small_model, overlay.model);
  assert.equal(overlay.provider.ollama.options.baseURL, LINUX_LOCAL_PROVIDER_URL);
  assert.deepEqual(overlay.enabled_providers, ['ollama']);
});

test('Linux local provider inventory refuses missing pins, reordered inventory, duplicate files, and wrong versions', async t => {
  const fixture = await localProviderFixture(t);
  assert.equal(parseLinuxLocalProviderInventory(fixture.inventory), fixture.inventory);
  for (const mutate of [
    (value: any) => {value.version = 'latest';},
    (value: any) => {value.extra = true;},
    (value: any) => {value.store.blobs.pop();},
    (value: any) => {value.closure.files.reverse();},
    (value: any) => {value.store.blobs.push(value.store.blobs[0]);},
    (value: any) => {value.closure.executable = '../bin/ollama';},
    (value: any) => {value.store.policyManifest.sha256 = '0'.repeat(64);},
  ]) {const value = structuredClone(fixture.inventory); mutate(value); assert.throws(() => parseLinuxLocalProviderInventory(value), {code: 'adapter_refused'});}
});

test('Linux local provider hashes every blob and refuses corrupt bytes of the same size', async t => {
  const fixture = await localProviderFixture(t);
  const original = await readFile(fixture.weightPath);
  await chmod(fixture.weightPath, 0o644); await writeFile(fixture.weightPath, Buffer.alloc(original.length, 88)); await chmod(fixture.weightPath, 0o444);
  await assert.rejects(fixture.prepare(), {code: 'adapter_refused'});
  assert.throws(() => preparedLinuxLocalProvider(fixture.input), {code: 'adapter_refused'});
});

test('Linux local provider hashes weight data in bounded streaming chunks', async t => {
  const fixture = await localProviderFixture(t, {weightBytes: 2 * 1024 * 1024 + 7});
  let chunks = 0;
  const spec = await fixture.prepare({}, {checkpoint: (point, path) => {if (point === 'chunk' && path === fixture.weightPath) chunks++;}});
  assert(spec); assert.equal(chunks, 3);
});

const parameterVariants: Record<string, number>[] = [{num_thread: 32, num_ctx: 8192, num_gpu: 0}, {num_thread: 16, num_ctx: 65536, num_gpu: 0},
  {num_thread: 16, num_ctx: 8192, num_gpu: 1}, {num_thread: 16, num_ctx: 8192, num_gpu: 0, temperature: 1}];
for (const parameters of parameterVariants) {
  test(`Linux local provider refuses a hash-valid policy layer with unapproved parameters ${JSON.stringify(parameters)}`, async t => {
    const fixture = await localProviderFixture(t, {parameters});
    await assert.rejects(fixture.prepare(), {code: 'adapter_refused'});
  });
}

test('Linux local provider rejects a replaced or symlinked blob and preserves retained file identity', async t => {
  const fixture = await localProviderFixture(t), spec = (await fixture.prepare())!;
  const data = await readFile(fixture.weightPath), replacement = join(fixture.root, 'replacement');
  await writeFile(replacement, data, {mode: 0o444}); await chmod(dirname(fixture.weightPath), 0o755); await rename(replacement, fixture.weightPath); await chmod(dirname(fixture.weightPath), 0o555);
  await assert.rejects(revalidateLinuxLocalProvider(spec), {code: 'adapter_refused'});
  await chmod(dirname(fixture.weightPath), 0o755); await rename(fixture.weightPath, replacement); await symlink(replacement, fixture.weightPath); await chmod(dirname(fixture.weightPath), 0o555);
  await assert.rejects(fixture.prepare(), {code: 'adapter_refused'});
});

test('Linux local provider verifies immutable directory and file permission policy', async t => {
  const fixture = await localProviderFixture(t);
  await chmod(fixture.weightPath, 0o644);
  await assert.rejects(fixture.prepare(), {code: 'adapter_refused'});
  await chmod(fixture.weightPath, 0o444); await chmod(fixture.modelsPath, 0o755);
  await assert.rejects(fixture.prepare(), {code: 'adapter_refused'});
});

test('Linux local provider cancellation interrupts streaming and issues no prepared receipt', async t => {
  const fixture = await localProviderFixture(t), controller = new AbortController();
  await assert.rejects(fixture.prepare({signal: controller.signal}, {checkpoint: point => {if (point === 'chunk') controller.abort();}}), {code: 'runner_stopped'});
  assert.throws(() => preparedLinuxLocalProvider(fixture.input), {code: 'adapter_refused'});
});

test('Linux local provider revalidates files after preparation and cancellation at the final boundary', async t => {
  const fixture = await localProviderFixture(t), controller = new AbortController();
  await assert.rejects(fixture.prepare({signal: controller.signal}, {checkpoint: point => {if (point === 'prepared') controller.abort();}}), {code: 'runner_stopped'});
  await assert.rejects(fixture.prepare({}, {checkpoint: async point => {if (point === 'prepared') {await chmod(fixture.weightPath, 0o644); await writeFile(fixture.weightPath, 'replaced'); await chmod(fixture.weightPath, 0o444);}}}), {code: 'adapter_refused'});
});

test('Linux local provider preparation deadline bounds stalled work across wall-clock rollback', async t => {
  const fixture = await localProviderFixture(t), now = Date.now, started = performance.now();
  t.after(() => {Date.now = now;});
  await assert.rejects(fixture.prepare({deadline: now() + 30}, {checkpoint: async () => {Date.now = () => now() - 1_000_000; await new Promise(() => {});}}), {code: 'adapter_refused'});
  assert(performance.now() - started < 1000);
  assert.throws(() => preparedLinuxLocalProvider(fixture.input), {code: 'adapter_refused'});
});

function latch() {
  let release!: () => void;
  return {promise: new Promise<void>(resolve => {release = resolve;}), release: () => release()};
}

/** Real descriptor, with the same close dependency as a pending libuv read. */
function heldInventoryHandle(t: TestContext, inventoryPath: string, mode: {read?: boolean; open?: boolean; rejectClose?: boolean} = {}) {
  const openStarted = latch(), openGate = latch(), opened = latch(), readStarted = latch(), readGate = latch(), readSettled = latch();
  const closeStarted = latch(), closeGate = latch(), closed = latch(), closeSettled = latch();
  const originalOpen = fsPromises.open;
  let calls = 0, descriptor = -1, actualClose: (() => Promise<void>) | undefined;
  if (!mode.open) openGate.release();
  if (!mode.read) readGate.release();
  const intercepted = t.mock.method(fsPromises, 'open', (async (...args: Parameters<typeof originalOpen>) => {
    calls++;
    if (args[0] !== inventoryPath || calls !== 1) return originalOpen(...args);
    openStarted.release(); await openGate.promise;
    const file = await originalOpen(...args); descriptor = file.fd;
    const read = file.read.bind(file); actualClose = file.close.bind(file);
    if (mode.read) file.read = (async (...readArgs: Parameters<FileHandle['read']>) => {
      readStarted.release();
      try {await readGate.promise; return await read(...readArgs);}
      finally {readSettled.release();}
    }) as FileHandle['read'];
    file.close = async () => {
      closeStarted.release();
      try {
        if (mode.read) await readSettled.promise;
        await closeGate.promise;
        if (mode.rejectClose) throw new Error('synthetic unconfirmed close');
        await actualClose!(); closed.release();
      } finally {closeSettled.release();}
    };
    opened.release(); return file;
  }) as typeof originalOpen);
  syncBuiltinESMExports();
  t.after(async () => {
    openGate.release(); readGate.release(); closeGate.release();
    if (calls) {await opened.promise; await closeSettled.promise; await actualClose!();}
    intercepted.mock.restore(); syncBuiltinESMExports();
  });
  return {openStarted: openStarted.promise, opened: opened.promise, readStarted: readStarted.promise, closeStarted: closeStarted.promise,
    // Notify after consumers of file.close() have observed its fulfillment.
    closed: closed.promise.then(() => new Promise<void>(resolve => setImmediate(resolve))), closeSettled: closeSettled.promise,
    releaseOpen: openGate.release, releaseRead: readGate.release,
    releaseClose: closeGate.release, calls: () => calls, descriptor: () => descriptor};
}

for (const stop of ['cancellation', 'deadline'] as const) {
  test(`Linux local provider ${stop} returns while read and close remain pending without accumulating descriptors`, {timeout: 10_000}, async t => {
    const fixture = await localProviderFixture(t), held = heldInventoryHandle(t, fixture.inventoryPath, {read: true});
    const controller = new AbortController();
    t.mock.timers.enable({apis: ['Date', 'setTimeout']});
    const warming = fixture.prepare({signal: controller.signal});
    const refused = assert.rejects(warming, {code: stop === 'cancellation' ? 'runner_stopped' : 'adapter_refused'});
    await held.readStarted;
    await assert.rejects(fixture.prepare(), /active or awaiting file cleanup/);
    if (stop === 'cancellation') controller.abort(); else t.mock.timers.tick(LINUX_LOCAL_PROVIDER_PREPARE_MS + 1);
    await refused; await held.closeStarted;
    assert.doesNotThrow(() => fstatSync(held.descriptor()), 'the pending read retains one real descriptor');
    for (let i = 0; i < 32; i++) await assert.rejects(fixture.prepare(), /active or awaiting file cleanup/);
    assert.equal(held.calls(), 1, 'refused retries must not open more files');
    assert.throws(() => preparedLinuxLocalProvider(fixture.input), {code: 'adapter_refused'});
    held.releaseRead();
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(fixture.prepare(), /active or awaiting file cleanup/);
    assert.doesNotThrow(() => fstatSync(held.descriptor()), 'read completion alone does not prove close');
    held.releaseClose(); await held.closed;
    assert.throws(() => fstatSync(held.descriptor()), {code: 'EBADF'});
    t.mock.timers.reset();
    assert(await fixture.prepare(), 'a confirmed close permits the next preparation');
  });
}

test('Linux local provider deadline bounds close after a successful read', {timeout: 10_000}, async t => {
  const fixture = await localProviderFixture(t), held = heldInventoryHandle(t, fixture.inventoryPath);
  t.mock.timers.enable({apis: ['Date', 'setTimeout']});
  const refused = assert.rejects(fixture.prepare(), {code: 'adapter_refused'});
  await held.closeStarted;
  t.mock.timers.tick(LINUX_LOCAL_PROVIDER_PREPARE_MS + 1);
  await refused;
  await assert.rejects(fixture.prepare(), /active or awaiting file cleanup/);
  assert.equal(held.calls(), 1);
  held.releaseClose(); await held.closed;
  assert.throws(() => fstatSync(held.descriptor()), {code: 'EBADF'});
  t.mock.timers.reset();
  assert(await fixture.prepare());
});

for (const stop of ['cancellation', 'deadline'] as const) {
  test(`Linux local provider tracks an open completing after ${stop} until its actual close`, {timeout: 10_000}, async t => {
    const fixture = await localProviderFixture(t), held = heldInventoryHandle(t, fixture.inventoryPath, {open: true});
    const controller = new AbortController();
    t.mock.timers.enable({apis: ['Date', 'setTimeout']});
    const refused = assert.rejects(fixture.prepare({signal: controller.signal}), {code: stop === 'cancellation' ? 'runner_stopped' : 'adapter_refused'});
    await held.openStarted;
    if (stop === 'cancellation') controller.abort(); else t.mock.timers.tick(LINUX_LOCAL_PROVIDER_PREPARE_MS + 1);
    await refused;
    await assert.rejects(fixture.prepare(), /active or awaiting file cleanup/);
    assert.equal(held.calls(), 1);
    held.releaseOpen(); await held.closeStarted;
    assert.doesNotThrow(() => fstatSync(held.descriptor()));
    await assert.rejects(fixture.prepare(), /active or awaiting file cleanup/);
    held.releaseClose(); await held.closed;
    assert.throws(() => fstatSync(held.descriptor()), {code: 'EBADF'});
    t.mock.timers.reset();
    assert(await fixture.prepare());
  });
}

test('Linux local provider retains its lease after a rejected close', {timeout: 10_000}, async t => {
  // A failed close must disable this provider instance permanently. Keep the
  // deliberately poisoned lease separate from other tests in this worker.
  const isolated = await import(new URL('../src/runner/linux-local-provider.js?unconfirmed-close', import.meta.url).href);
  const fixture = await localProviderFixture(t), held = heldInventoryHandle(t, fixture.inventoryPath, {rejectClose: true});
  const refused = assert.rejects(isolated.prepareLinuxLocalProvider(fixture.input, fixture.options), {code: 'adapter_refused'});
  await held.closeStarted; held.releaseClose(); await refused;
  assert.doesNotThrow(() => fstatSync(held.descriptor()));
  for (let i = 0; i < 32; i++) await assert.rejects(isolated.prepareLinuxLocalProvider(fixture.input, fixture.options), /active or awaiting file cleanup/);
  assert.equal(held.calls(), 1, 'an unconfirmed close must never allow another open');
});
