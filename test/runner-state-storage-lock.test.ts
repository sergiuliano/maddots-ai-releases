import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as filesystem from 'node:fs/promises';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RunnerState, type ActiveRun, type PendingOutcome } from '../src/runner/state.js';
import { acquireRunnerStorageLock, type RunnerStorageLock } from '../src/runner/storage-lock.js';

const fsp = createRequire(import.meta.url)('node:fs/promises') as typeof filesystem;
const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
function pending(runId: string, model: string): PendingOutcome {
  return {runId, aiToolId: randomUUID(), queuedAt: 1, body: {outcome: 'done', code: null, access: 'folder_only', toolVersion: null,
    model, provider: null, skills: [], posted: {comments: 0, attachments: 0, filesSkipped: 0, moved: false, moveSkipped: null},
    startedAt: '2026-10-29T00:00:00.000Z', finishedAt: '2026-10-29T00:00:01.000Z'}};
}

for (const operation of ['active', 'queue', 'drop', 'log'] as const) {
test(`Linux descriptor-bound ${operation} cannot mutate a replacement data directory after its physical operation was delayed`, {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-state-bound-'));
  await chmod(root, 0o700);
  const data = join(root, 'data'); await mkdir(data, {mode: 0o700});
  const locks: RunnerStorageLock[] = [];
  const originalRename = fsp.rename, originalUnlink = fsp.unlink, originalOpen = fsp.open, originalLstat = fsp.lstat;
  const originalOpenSync = fs.openSync;
  let resume!: () => void, held!: () => void, armed = true;
  const delayed = new Promise<void>(resolve => {resume = resolve;});
  const reached = new Promise<void>(resolve => {held = resolve;});
  const work: {pending?: Promise<void>} = {};
  t.after(async () => {
    resume(); await work.pending?.catch(() => {});
    fsp.unlink = originalUnlink; fsp.open = originalOpen; fsp.lstat = originalLstat; fs.openSync = originalOpenSync;
    syncBuiltinESMExports();
    await Promise.all(locks.map(lock => lock.release())); await rm(root, {recursive: true, force: true});
  });
  async function state() {
    const lock = await acquireRunnerStorageLock(data); locks.push(lock);
    const storage = new RunnerState(data); storage.bindDirectory(lock); await storage.init(); return storage;
  }
  const old = await state(), runId = randomUUID(), oldPending = pending(runId, 'old');
  await old.writeActive([]); await old.queue(oldPending);
  const row: ActiveRun = {runId, agentId: randomUUID(), aiToolId: oldPending.aiToolId, pid: 900001,
    startedAt: 'linux:11111111-2222-4333-8444-555555555555:1', phase: 'running',
    runDir: join(root, 'workspace/.maddots/runs', runId)};
  const matches = (path: string) => path.startsWith('/proc/self/fd/') &&
    path.endsWith(operation === 'active' ? '/active.json' : `/${runId}.json`);
  if (operation === 'active' || operation === 'queue') {
    const pinned = new Map<number, string>(), closed = new Set<string>();
    fs.openSync = ((...args: Parameters<typeof originalOpenSync>) => {
      const fd = originalOpenSync(...args), path = String(args[0]);
      if (path.endsWith('.tmp')) pinned.set(fd, path);
      return fd;
    }) as typeof originalOpenSync;
    fsp.open = (async (...args: Parameters<typeof originalOpen>) => {
      const file = await originalOpen(...args), adopted = /^\/proc\/self\/fd\/(\d+)$/u.exec(String(args[0]));
      const path = adopted ? pinned.get(Number(adopted[1])) : undefined;
      if (adopted) pinned.delete(Number(adopted[1]));
      if (path) {
        const close = file.close.bind(file);
        file.close = async () => {await close(); closed.add(path);};
      }
      return file;
    }) as typeof originalOpen;
    // Hold the final asynchronous temporary validation, after the payload has
    // closed and before the synchronous checked publication changes names.
    fsp.lstat = (async (...args: Parameters<typeof originalLstat>) => {
      if (armed && closed.has(String(args[0]))) {armed = false; held(); await delayed;}
      return originalLstat(...args);
    }) as typeof originalLstat;
  } else if (operation === 'drop') {
    fsp.unlink = (async (...args: Parameters<typeof originalUnlink>) => {
      if (armed && matches(String(args[0]))) {armed = false; held(); await delayed;}
      return originalUnlink(...args);
    }) as typeof originalUnlink;
  } else {
    fsp.open = (async (...args: Parameters<typeof originalOpen>) => {
      const file = await originalOpen(...args);
      if (armed && String(args[0]).startsWith('/proc/self/fd/') && String(args[0]).endsWith('/runner.log')) {
        const write = file.writeFile.bind(file);
        file.writeFile = async (...values) => {armed = false; held(); await delayed; return write(...values);};
      }
      return file;
    }) as typeof originalOpen;
  }
  syncBuiltinESMExports();
  work.pending = operation === 'active' ? old.writeActive([]) : operation === 'queue' ? old.queue(oldPending) :
    operation === 'drop' ? old.drop(runId) : old.log(runId, 'running', null, 1);
  void work.pending.catch(() => {});
  await Promise.race([reached, work.pending.then(() => {throw new Error('write was not delayed');})]);
  await originalRename(data, join(root, 'original')); await mkdir(data, {mode: 0o700});
  const replacement = await state(), replacementPending = pending(runId, 'replacement');
  await replacement.writeActive([row]); await replacement.queue(replacementPending);
  await replacement.log(runId, 'replacement', null, 2);
  const newActive = await readFile(join(data, 'runner/active.json'), 'utf8');
  const newOutcome = await readFile(join(data, 'runner/outcomes', runId + '.json'), 'utf8');
  const newLog = await readFile(join(data, 'logs/runner.log'), 'utf8');
  resume();
  await assert.rejects(work.pending, {code: 'RUNNER_STATE_UNAVAILABLE'});
  assert.equal(await readFile(join(data, 'runner/active.json'), 'utf8'), newActive);
  assert.equal(await readFile(join(data, 'runner/outcomes', runId + '.json'), 'utf8'), newOutcome);
  assert.equal(await readFile(join(data, 'logs/runner.log'), 'utf8'), newLog);
  await assert.rejects(old.active(), {code: 'RUNNER_STATE_UNAVAILABLE'});
});
}

for (const replacement of ['guard', 'symlink', 'hardlink', 'permissions', 'directory'] as const) {
test(replacement === 'guard' ? 'Linux publication keeps directory exclusion across guard replacement during payload fsync' :
  `Linux publication refuses ${replacement} replacement during payload fsync before publishing`, {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-state-publication-race-'));
  await chmod(root, 0o700);
  const data = join(root, 'data'); await mkdir(data, {mode: 0o700});
  if (replacement === 'guard') await writeFile(join(data, '.runner-storage.guard'), '', {mode: 0o600});
  const lock = await acquireRunnerStorageLock(data), storage = new RunnerState(data);
  const locks = [lock]; storage.bindDirectory(lock); await storage.init(); await storage.writeActive([]);
  const active = join(data, 'runner/active.json'), sentinel = join(root, 'sentinel');
  await writeFile(sentinel, 'untouched sentinel', {mode: 0o600});
  const originalOpen = fsp.open, originalOpenSync = fs.openSync;
  const pinned = new Set<number>();
  let armed = true, changed = false;
  t.after(async () => {
    fsp.open = originalOpen; fs.openSync = originalOpenSync; syncBuiltinESMExports();
    await Promise.all(locks.map(held => held.release())); await rm(root, {recursive: true, force: true});
  });
  fs.openSync = ((...args: Parameters<typeof originalOpenSync>) => {
    const fd = originalOpenSync(...args);
    if (String(args[0]).endsWith('.tmp')) pinned.add(fd);
    return fd;
  }) as typeof originalOpenSync;
  fsp.open = (async (...args: Parameters<typeof originalOpen>) => {
    const file = await originalOpen(...args);
    const adopted = /^\/proc\/self\/fd\/(\d+)$/u.exec(String(args[0]));
    if (adopted && pinned.delete(Number(adopted[1])) && armed) {
      const sync = file.sync.bind(file);
      file.sync = async () => {
        await sync(); armed = false; changed = true;
        if (replacement === 'guard') {
          await fsp.rename(join(data, '.runner-storage.guard'), join(data, '.saved.guard'));
          await assert.rejects(acquireRunnerStorageLock(data, undefined, Date.now() + 100), {code: 'HELPER_BUSY'});
        } else if (replacement === 'permissions') await chmod(active, 0o644);
        else {
          await unlink(active);
          if (replacement === 'symlink') await symlink(sentinel, active);
          else if (replacement === 'hardlink') await link(sentinel, active);
          else await mkdir(active, {mode: 0o700});
        }
      };
    }
    return file;
  }) as typeof originalOpen;
  syncBuiltinESMExports();
  if (replacement === 'guard') await storage.writeActive([]);
  else await assert.rejects(storage.writeActive([]), {code: 'RUNNER_STATE_INVALID'});
  assert.equal(changed, true);
  if (replacement === 'guard') assert.deepEqual(await storage.active(), [], 'only the original owner can publish');
  else {
    const target = await lstat(active);
    assert.equal(target.isSymbolicLink(), replacement === 'symlink');
    assert.equal(target.isDirectory(), replacement === 'directory');
    if (replacement === 'hardlink') assert.equal(target.nlink, 2);
    if (replacement === 'permissions') assert.equal(target.mode & 0o777, 0o644);
  }
  assert.equal(await readFile(sentinel, 'utf8'), 'untouched sentinel');
});
}
