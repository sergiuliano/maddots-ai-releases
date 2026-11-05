import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import * as filesystemSync from 'node:fs';
import * as filesystem from 'node:fs/promises';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {createRequire, syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import type {HelperPaths} from '../src/paths.js';
import {AdapterRegistry} from '../src/runner/adapters/index.js';
import {LocalAgents} from '../src/runner/agents-local.js';
import {RunsRuntime} from '../src/runner/cli-runs.js';
import {RunnerJournal} from '../src/runner/journal.js';
import {RunnerCore} from '../src/runner/runner.js';
import {RunsOnController, type RunsOnOptions} from '../src/runner/runs-on.js';
import {acquireRunnerStorageLock} from '../src/runner/storage-lock.js';
import {initializeCleanRunnerJournal} from './support/runner-journal-fixture.js';

const fsp = createRequire(import.meta.url)('node:fs/promises') as typeof filesystem;
const fs = createRequire(import.meta.url)('node:fs') as typeof filesystemSync;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {resolve = done;});
  return {promise, resolve};
}
function core(data: string) {
  return new RunnerCore({data, registry: new AdapterRegistry([]), connections: async () => [], localAgents: async () => [],
    verifiedBuild: async () => true, allowedBuild: async () => true, stageSkills: async () => {}, removeDeviceKey: async () => {},
    deliver: async () => {assert.fail('Companion publication cannot authorize delivery.');}});
}
function controllerOptions(data: string): RunsOnOptions {
  return {paths: {data}, keys: {ensure: async () => {assert.fail('No key creation.');},
    get: async () => undefined, remove: async () => {}, registerExisting: async () => {assert.fail('No registration.');}},
    connection: async () => undefined, protocol: () => {assert.fail('No protocol calls.');},
    test: async () => {assert.fail('No tool may be started.');}};
}
async function fixture() {
  const data = await mkdtemp(join(tmpdir(), 'mdai-journal-companion-'));
  await initializeCleanRunnerJournal(data);
  const paths: HelperPaths = {home: data, data, logs: join(data, 'logs'), holding: join(data, 'holding'),
    backups: join(data, 'backups'), state: join(data, 'state.json'), lock: join(data, '.write.lock'),
    servicePlist: join(data, 'unused.plist'), routes: [], platform: 'linux'};
  return {data, paths};
}
function holdNextTemporarySync(t: TestContext, filename: string) {
  const entered = deferred(), resume = deferred(), originalOpen = fsp.open, originalOpenSync = fs.openSync;
  const pinned = new Map<number, string>();
  const namedTemporary = (path: string) => path.includes(`/.${filename}.`) && path.endsWith('.tmp');
  let temporary: string | undefined, seam: 'descriptor-adoption' | 'temporary-open' | undefined, hits = 0;
  fs.openSync = ((...args: Parameters<typeof originalOpenSync>) => {
    const fd = originalOpenSync(...args), path = String(args[0]), flags = args[1];
    if (typeof flags === 'number' && (flags & fs.constants.O_CREAT) && (flags & fs.constants.O_EXCL) &&
        namedTemporary(path)) pinned.set(fd, path);
    return fd;
  }) as typeof originalOpenSync;
  fsp.open = (async (...args: Parameters<typeof originalOpen>) => {
    const requested = String(args[0]), adopted = /^\/proc\/self\/fd\/(\d+)$/u.exec(requested);
    // Bound activation writes adopt their exclusive pin; companion metadata
    // still uses atomicWrite's direct temporary handle.
    const path = adopted ? pinned.get(Number(adopted[1])) : namedTemporary(requested) ? requested : undefined;
    if (adopted) pinned.delete(Number(adopted[1]));
    const file = await originalOpen(...args);
    if (!temporary && path) {
      temporary = path; seam = adopted ? 'descriptor-adoption' : 'temporary-open';
      const sync = file.sync.bind(file);
      file.sync = async () => {hits++; entered.resolve(); await resume.promise; await sync();};
    }
    return file;
  }) as typeof originalOpen;
  syncBuiltinESMExports();
  const restore = () => {resume.resolve(); fsp.open = originalOpen; fs.openSync = originalOpenSync; syncBuiltinESMExports();};
  t.after(restore);
  return {entered: entered.promise, resume: resume.resolve, restore, temporary: () => temporary, hits: () => hits, seam: () => seam};
}

for (const companion of ['activation', 'local agents', 'agent catalog'] as const) {
  test(`S2 ${companion} publication overlapping core replay permits initialization and retry after save`, {
    skip: process.platform !== 'linux', timeout: 10_000,
  }, async t => {
    const f = await fixture(), instance = core(f.data), aiToolId = randomUUID(), deviceKeyId = randomUUID();
    const controller = new RunsOnController(controllerOptions(f.data));
    const local = new LocalAgents(f.paths), agent = {agentId: randomUUID(), aiToolId, handle: 'assistant'};
    const runtime = companion === 'agent catalog' ? new RunsRuntime({paths: f.paths, helperId: randomUUID(),
      endpoint: new URL('https://fixture.invalid'), api: {} as never, secrets: {} as never, state: {} as never}) : undefined;
    const filename = companion === 'activation' ? 'runs.json' : companion === 'local agents' ? 'agents.json' : 'agents-catalog.json';
    const initial = companion === 'activation' ? {format: 1, tools: [{aiToolId, state: 'on', failureCode: null,
      deviceKeyId, toolVersion: 'fixture', grantExpiresAt: null}]} : companion === 'local agents' ? {
      [agent.agentId]: {aiToolId, handle: agent.handle, folder: join(f.data, 'workspace'), folderCreated: false,
        access: 'full_access', accessConfirmedAt: 1, setupDone: true}} : [];
    await writeFile(join(f.data, 'runner', filename), JSON.stringify(initial), {mode: 0o600});
    const held = holdNextTemporarySync(t, filename);
    const publishing = companion === 'activation' ? controller.forget(aiToolId, deviceKeyId) : companion === 'local agents' ?
      local.access(agent, 'folder-only', {isTTY: false, now: () => 2, prompt: async () => {assert.fail('No prompt.');}, output: () => {}}) :
      runtime!['rememberAgents'](aiToolId, {agents: [], claimable: [], stop: [], heartbeatSeconds: 15});
    void publishing.catch(() => {});
    t.after(async () => {
      held.resume(); await publishing.catch(() => {}); held.restore();
      await controller.close(); await runtime?.core.close(); await instance.close();
      await rm(f.data, {recursive: true, force: true});
    });
    await held.entered;
    assert(held.temporary());
    assert.equal(held.hits(), 1, 'the production temporary sync must be held');
    assert.equal(held.seam(), companion === 'activation' ? 'descriptor-adoption' : 'temporary-open');
    assert((await readdir(join(f.data, 'runner'))).some(name => name.endsWith('.tmp')),
      'the production companion publisher must still have its temporary entry visible during replay');
    let initialError: unknown;
    await instance.init().catch(error => {initialError = error;});
    held.resume(); await publishing;
    assert(!(await readdir(join(f.data, 'runner'))).some(name => name.endsWith('.tmp')));
    // The review repro permanently poisoned this same core after an ordinary
    // save succeeded. Retrying must remain possible once that save settles.
    await instance.init();
    assert.equal(initialError, undefined, 'an unrelated companion publication is not a corrupt journal tail');
    assert.equal(instance.busy, false);
    const saved = JSON.parse(await readFile(join(f.data, 'runner', filename), 'utf8'));
    if (companion === 'activation') assert.deepEqual(saved, {format: 1, tools: []});
    else if (companion === 'local agents') assert.equal(saved[agent.agentId].access, 'folder_only');
    else assert.deepEqual(saved, []);
  });
}

for (const debris of ['legacy generic', 'journal head', 'journal record', 'unknown target', 'malformed companion'] as const) {
  test(`S2 ${debris} temporary debris still refuses replay after two restarts`, {
    skip: process.platform !== 'linux', timeout: 10_000,
  }, async t => {
    const f = await fixture(), lock = await acquireRunnerStorageLock(f.data);
    t.after(async () => {await lock.release(); await rm(f.data, {recursive: true, force: true});});
    const name = debris === 'legacy generic' ? `.${randomUUID()}.tmp` : debris === 'journal head' ? `.journal-head.json.${randomUUID()}.tmp` :
      debris === 'journal record' ? `.journal-0000000001.json.${randomUUID()}.tmp` : debris === 'unknown target' ? `.unknown.json.${randomUUID()}.tmp` :
        '.runs.json.not-a-uuid.tmp';
    await writeFile(join(f.data, 'runner', name), '{}\n', {mode: 0o600});
    for (let restart = 0; restart < 2; restart++) {
      const journal = new RunnerJournal(await lock.directory('runner'), {directoryIdentity: lock.identity,
        bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(), ownerEpoch: randomUUID(), generation: 1,
        isCurrent: () => true, completionScope: 'full-run', contractVersion: 1});
      assert.deepEqual(await journal.replay(), {busy: true, reason: 'journal-invalid', obligations: []});
      await assert.rejects(journal.establishEpoch(), {reason: 'journal-invalid'});
      assert.equal(await readFile(join(f.data, 'runner', name), 'utf8'), '{}\n', 'replay must preserve ambiguous debris');
    }
  });
}
