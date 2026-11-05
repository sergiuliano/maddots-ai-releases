import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import * as filesystem from 'node:fs/promises';
import {lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile} from 'node:fs/promises';
import {createRequire, syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join, relative} from 'node:path';
import test from 'node:test';
import {AdapterRegistry} from '../src/runner/adapters/index.js';
import {RunnerCore} from '../src/runner/runner.js';
import type {JournalContext} from '../src/runner/journal.js';
import {RunnerState, type ActiveRun} from '../src/runner/state.js';

const fsp = createRequire(import.meta.url)('node:fs/promises') as typeof filesystem;
const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');

test('Linux core recovery never reads or deletes a replacement staged journal after authoritative active load', {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-staged-replacement-'));
  const data = join(root, 'data'), cwd = join(root, 'workspace'), runId = randomUUID();
  await mkdir(data, {mode: 0o700}); await mkdir(cwd, {mode: 0o700});
  const row: ActiveRun = {runId, agentId: randomUUID(), aiToolId: randomUUID(), pid: 0,
    startedAt: '2026-10-29T00:00:00.000Z', claimedAt: Date.parse('2026-10-29T00:00:00.000Z'), phase: 'posting', runDir: join(cwd, '.maddots/runs', runId)};
  const {acquireRunnerStorageLock} = await import('../src/runner/storage-lock.js');
  const {initializeCleanJournal, RunnerJournal} = await import('../src/runner/journal.js');
  const seeding = await acquireRunnerStorageLock(data);
  try {
    const proof = Object.freeze({fixture: 'sealed-empty'}), incarnation = randomUUID();
    const context: JournalContext = {directoryIdentity: seeding.identity,
      bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(), ownerEpoch: randomUUID(), generation: 1,
      isCurrent: () => true, completionScope: 'full-run', contractVersion: 1,
      backend: {verifyRegistration: async () => true, verifyCompletion: async (_registration, candidate) => candidate === proof}};
    const directory = await seeding.directory('runner');
    await initializeCleanJournal(directory, context);
    const journal = new RunnerJournal(directory, context); await journal.replay(); await journal.establishEpoch();
    let token = await journal.intent({runId, incarnation}); assert.equal(journal.consumeLauncher(token), true);
    token = await journal.bind(token, {backend: 'linux-cgroup-v2', namespaceId: randomUUID(), name: `run-${incarnation}`, objectIdentity: '10:200'});
    token = await journal.allow(token); assert.equal(journal.consumeLaunch(token), true);
    token = await journal.stopping(token); await journal.clean(token, proof);
    assert.equal(journal.isClean(runId), true);
  } finally {await seeding.release();}
  const original = new RunnerState(data); await original.init(); await original.writeActive([row]);
  const core = new RunnerCore({data, registry: new AdapterRegistry([]), connections: async () => [], localAgents: async () => [],
    verifiedBuild: async () => true, allowedBuild: async () => true, stageSkills: async () => {}, removeDeviceKey: async () => {},
    deliver: async () => {throw new Error('Recovery must not deliver.');}});
  const stage = join(data, 'runner/staged', runId + '.json');
  const content = JSON.stringify({format: 1, runId, cwd, git: null, paths: []});
  let validRowLoaded = false, replacementReads = 0, recoveries = 0;
  let replacementInfo: {dev: number; ino: number} | undefined;
  const recovering = core as unknown as {recoverRow(row: ActiveRun): Promise<void>};
  const recoverRow = recovering.recoverRow.bind(core);
  t.mock.method(recovering, 'recoverRow', async (row: ActiveRun) => {recoveries++; return recoverRow(row);});
  const open = fsp.open, active = core['state'].active.bind(core['state']);
  t.after(async () => {
    fsp.open = open; syncBuiltinESMExports();
    await core.close(); await rm(root, {recursive: true, force: true});
  });
  t.mock.method(core['state'], 'active', async () => {
    const rows = await active();
    assert.deepEqual(rows, [row]); validRowLoaded = true;
    await rename(data, join(root, 'original')); await mkdir(join(data, 'runner/staged'), {recursive: true, mode: 0o700});
    await writeFile(stage, content, {mode: 0o600}); replacementInfo = await lstat(stage);
    return rows;
  });
  fsp.open = (async (...args: Parameters<typeof open>) => {
    const file = await open(...args);
    if (replacementInfo && String(args[0]).endsWith('/' + runId + '.json')) {
      const info = await file.stat();
      if (info.dev === replacementInfo.dev && info.ino === replacementInfo.ino) replacementReads++;
    }
    return file;
  }) as typeof open;
  syncBuiltinESMExports();
  await assert.rejects(core.init(), {code: 'RUNNER_STATE_UNAVAILABLE'});
  assert.equal(validRowLoaded, true);
  assert.equal(recoveries, 1, 'the matching durable CLEAN row must reach actual folder recovery after projection validation');
  const replacementContent = await readFile(stage, 'utf8').catch(error => (error as NodeJS.ErrnoException).code);
  assert.deepEqual({replacementReads, replacementContent}, {replacementReads: 0, replacementContent: content},
    'replacement staged journal must never be opened or deleted');
});

for (const operation of ['stage', 'exclude', 'stage-delete', 'backup'] as const) {
  test(`Linux retained ${operation} operation cannot publish into replacement controller storage after queued filesystem work`, {
    skip: process.platform !== 'linux', timeout: 10_000,
  }, async t => {
    const {acquireRunnerStorageLock} = await import('../src/runner/storage-lock.js');
    const {createRunFolder} = await import('../src/runner/run-folder.js');
    const {createGitDirectory} = await import('./git-fixture.js');
    const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-staged-queued-'));
    const data = join(root, 'data'), cwd = join(root, 'workspace'), runId = randomUUID();
    await mkdir(data, {mode: 0o700}); await mkdir(cwd, {mode: 0o700});
    if (operation === 'exclude') await createGitDirectory(join(cwd, '.git'));
    const storage = await acquireRunnerStorageLock(data);
    const folder = await createRunFolder({cwd, dataDir: data, runId, storage});
    if (operation === 'backup') await folder.stageProjectFile({path: 'nested/config', content: 'original', kind: 'config'});
    const originalRename = fsp.rename, originalLink = fsp.link, originalUnlink = fsp.unlink;
    const originalOpen = fsp.open, originalOpenSync = fs.openSync, temporaryPins = new Map<number, string>();
    let seamFired = 0, armed = true, held!: () => void, resume!: () => void;
    const reached = new Promise<void>(resolve => {held = resolve;});
    const delayed = new Promise<void>(resolve => {resume = resolve;});
    let replacement: string | undefined, originalPublication: string | undefined;
    const task: {work?: Promise<void>} = {};
    const pause = async (path: string) => {
      if (!armed || !path.startsWith('/proc/self/fd/')) return;
      const name = path.slice(path.lastIndexOf('/') + 1);
      if (operation === 'stage' && name !== runId + '.json' || operation === 'exclude' && !/^[a-f0-9]{64}\.json$/.test(name) ||
          operation === 'stage-delete' && name !== runId + '.json' || operation === 'backup' && name !== 'config') return;
      armed = false; seamFired++;
      replacement = operation === 'stage' || operation === 'stage-delete' ? join(data, 'runner/staged', name) :
        operation === 'exclude' ? join(data, 'runner/excludes', name) : join(data, 'backups/run-stage', runId, 'nested/config');
      if (operation === 'stage' || operation === 'exclude') originalPublication = await readFile(path, 'utf8').catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      held(); await delayed;
    };
    if (operation === 'stage' || operation === 'exclude') {
      fs.openSync = ((...args: Parameters<typeof originalOpenSync>) => {
        const fd = originalOpenSync(...args), path = String(args[0]);
        const temporary = /\/\.([a-f0-9-]+\.json)\.[a-f0-9-]+\.tmp$/u.exec(path);
        if (path.startsWith('/proc/self/fd/') && temporary) temporaryPins.set(fd, path.slice(0, path.lastIndexOf('/') + 1) + temporary[1]);
        return fd;
      }) as typeof originalOpenSync;
      fsp.open = (async (...args: Parameters<typeof originalOpen>) => {
        const file = await originalOpen(...args), adopted = /^\/proc\/self\/fd\/(\d+)$/u.exec(String(args[0]));
        const target = adopted ? temporaryPins.get(Number(adopted[1])) : undefined;
        if (adopted) temporaryPins.delete(Number(adopted[1]));
        if (target) {
          const sync = file.sync.bind(file);
          file.sync = async () => {await sync(); await pause(target);};
        }
        return file;
      }) as typeof originalOpen;
    }
    fsp.link = (async (...args: Parameters<typeof originalLink>) => {
      if (operation === 'backup') await pause(String(args[1]));
      return originalLink(...args);
    }) as typeof originalLink;
    fsp.unlink = (async (...args: Parameters<typeof originalUnlink>) => {
      if (operation === 'stage-delete') await pause(String(args[0]));
      return originalUnlink(...args);
    }) as typeof originalUnlink;
    syncBuiltinESMExports();
    t.after(async () => {
      resume(); await task.work?.catch(() => {});
      fsp.open = originalOpen; fs.openSync = originalOpenSync; fsp.link = originalLink; fsp.unlink = originalUnlink; syncBuiltinESMExports();
      await folder.release(); await storage.release(); await rm(root, {recursive: true, force: true});
    });
    const work = task.work = operation === 'stage' || operation === 'exclude' ? folder.stageProjectFile({path: 'config', content: 'original', kind: 'config'}) : folder.backupStaged(data);
    void work.catch(() => {});
    await Promise.race([reached, work.then(() => {throw new Error('The operation was not delayed.');})]);
    assert.equal(seamFired, 1, 'the retained payload fsync or queued mutation must reach the replacement schedule');
    assert.ok(replacement);
    await originalRename(data, join(root, 'original'));
    await mkdir(replacement.slice(0, replacement.lastIndexOf('/')), {recursive: true, mode: 0o700});
    await writeFile(replacement, 'replacement sentinel', {mode: 0o600});
    resume();
    await assert.rejects(work, {code: 'RUNNER_STATE_UNAVAILABLE'});
    assert.equal(await readFile(replacement, 'utf8'), 'replacement sentinel');
    if (operation === 'stage' || operation === 'exclude') {
      const displaced = await readFile(join(root, 'original', relative(data, replacement)), 'utf8').catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      assert.equal(displaced, originalPublication, 'a refused retained write must preserve the displaced publication as evidence');
    }
    if (operation === 'backup') assert.equal(await readFile(join(cwd, 'nested/config'), 'utf8'), 'original');
  });
}
