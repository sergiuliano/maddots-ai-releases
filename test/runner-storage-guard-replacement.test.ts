import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile} from 'node:fs/promises';
import {createRequire, syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {RunnerState, type ActiveRun} from '../src/runner/state.js';
import {acquireRunnerStorageLock, type RunnerStorageLock} from '../src/runner/storage-lock.js';

for (const mutation of ['rename', 'unlink', 'write'] as const) {
test(`S1 fix3: ${mutation} of a guard cannot admit a successor during an adopted payload fsync`, {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-guard-queued-rename-'));
  const data = join(root, 'data'); await mkdir(data, {mode: 0o700});
  // A legacy guard may still exist after a clean migration. Its name must not
  // determine exclusion for any new runner writer sharing this directory.
  const guard = join(data, '.runner-storage.guard'); await writeFile(guard, '', {mode: 0o600});
  const filesystem = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises');
  const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
  const rename = filesystem.rename, open = filesystem.open, openSync = fs.openSync, locks: RunnerStorageLock[] = [];
  const temporaryPins = new Set<number>();
  let resume!: () => void, reached!: () => void, armed = true, seamFired = 0;
  const held = new Promise<void>(done => {resume = done;}), started = new Promise<void>(done => {reached = done;});
  const work: {writing?: Promise<void>} = {};
  t.after(async () => {
    resume(); await work.writing?.catch(() => {});
    t.mock.restoreAll(); syncBuiltinESMExports();
    await Promise.all(locks.map(lock => lock.release())); await rm(root, {recursive: true, force: true});
  });
  const first = await acquireRunnerStorageLock(data); locks.push(first);
  const state = new RunnerState(data); state.bindDirectory(first); await state.init(); await state.writeActive([]);
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof openSync>) => {
    const fd = openSync(...args);
    if (String(args[0]).startsWith('/proc/self/fd/') && /\/\.active\.json\.[a-f0-9-]+\.tmp$/u.test(String(args[0]))) temporaryPins.add(fd);
    return fd;
  });
  t.mock.method(filesystem, 'open', async (...args: Parameters<typeof open>) => {
    const file = await open(...args), adopted = /^\/proc\/self\/fd\/(\d+)$/u.exec(String(args[0]));
    if (armed && adopted && temporaryPins.delete(Number(adopted[1]))) {
      armed = false; const sync = file.sync.bind(file);
      file.sync = async () => {seamFired++; reached(); await held; return sync();};
    }
    return file;
  });
  syncBuiltinESMExports();
  const writing = work.writing = state.writeActive([]); void writing.catch(() => {}); await started;
  assert.equal(seamFired, 1, 'the adopted active.json payload must reach its held fsync');
  if (mutation === 'rename') await rename(guard, guard + '.aside');
  else if (mutation === 'unlink') await unlink(guard);
  else await writeFile(guard, 'changed contents', {mode: 0o600});
  if (mutation !== 'write') await writeFile(guard, 'replacement guard', {mode: 0o600});
  let refusal: unknown, contender: RunnerStorageLock | undefined;
  try {contender = await acquireRunnerStorageLock(data, undefined, Date.now() + 150); locks.push(contender);}
  catch (error) {refusal = error;}
  const runId = randomUUID(), row: ActiveRun = {runId, agentId: randomUUID(), aiToolId: randomUUID(), pid: 900003,
    startedAt: 'successor', phase: 'running', runDir: join(root, 'work/.maddots/runs', runId)};
  if (contender) {
    const successor = new RunnerState(data); successor.bindDirectory(contender); await successor.init(); await successor.writeActive([row]);
  }
  resume(); await writing.catch(() => {});
  if (contender) assert.equal(JSON.parse(await readFile(join(data, 'runner/active.json'), 'utf8')).length, 1,
    'a delayed old publication must never erase the successor ledger from one row to zero');
  assert.equal((refusal as {code?: string})?.code, 'HELPER_BUSY', 'the same directory remains exclusively owned until the old publisher releases');
  await first.release();
  const next = await acquireRunnerStorageLock(data); locks.push(next);
  const successor = new RunnerState(data); successor.bindDirectory(next); await successor.init(); await successor.writeActive([row]);
  assert.deepEqual(await successor.active(), [row]);
});
}
