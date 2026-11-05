// Dedicated unprivileged file-backed fixture. These process exits test storage
// crashes, not production cgroups or the S3 containment qualification.
import {randomUUID} from 'node:crypto';
import * as filesystem from 'node:fs/promises';
import {readFile, writeFile} from 'node:fs/promises';
import {createRequire, syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {RunnerJournal, initializeCleanJournal, type JournalContext, type JournalToken} from '../../src/runner/journal.js';
import {acquireRunnerStorageLock} from '../../src/runner/storage-lock.js';

const [mode, data, target, boundary, when] = process.argv.slice(2);
if (!['crash', 'replay'].includes(mode) || !data) throw new Error('Invalid journal crash fixture arguments.');
const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
const lock = await acquireRunnerStorageLock(data), directory = await lock.directory('runner');
const proof = Object.freeze({fixtureOnly: true});
const context: JournalContext = {directoryIdentity: lock.identity, bootId, ownerEpoch: randomUUID(), generation: 1,
  isCurrent: () => true, completionScope: 'full-run', contractVersion: 1, backend: {
    verifyRegistration: async () => true, verifyCompletion: async (_registration, actual) => actual === proof,
  }};
const run = {runId: '11111111-2222-4333-8444-555555555555', incarnation: '22222222-3333-4444-8555-666666666666'};
if (mode === 'replay') {
  const journal = new RunnerJournal(directory, context), replay = await journal.replay();
  // A clean restart must durably acknowledge its own owner epoch before it
  // exposes idle. Repeating this in another OS process also checks the cursor.
  if (!replay.busy) await journal.establishEpoch();
  await writeFile(join(data, 'replay-report.json'), JSON.stringify({...replay, busy: journal.busy,
    isClean: journal.isClean(run.runId)}) + '\n', {mode: 0o600});
  await lock.release();
} else {
  const steps = ['EPOCH', 'INTENT', 'CONTAINMENT_BOUND', 'LAUNCH_ALLOWED', 'STOPPING', 'CLEAN'];
  if (!steps.includes(target) || !['before', 'after'].includes(when)) throw new Error('Invalid crash boundary.');
  await initializeCleanJournal(directory, context);
  const journal = new RunnerJournal(directory, context); await journal.replay();
  const registration = {backend: 'linux-cgroup-v2' as const, namespaceId: randomUUID(), name: `run-${run.incarnation}`, objectIdentity: '10:200'};
  let token: JournalToken;
  const perform = async (stage: string) => {
    if (stage === 'EPOCH') {await journal.establishEpoch(); return;}
    token = stage === 'INTENT' ? await journal.intent(run) : stage === 'CONTAINMENT_BOUND' ? await journal.bind(token, registration) :
      stage === 'LAUNCH_ALLOWED' ? await journal.allow(token) : stage === 'STOPPING' ? await journal.stopping(token) : await journal.clean(token, proof);
    if (stage === 'INTENT' && !journal.consumeLauncher(token)) throw new Error('Intent was not acknowledged.');
  };
  for (const previous of steps.slice(0, steps.indexOf(target))) await perform(previous);
  const fsp = createRequire(import.meta.url)('node:fs/promises') as typeof filesystem;
  const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
  const originalOpen = fsp.open, originalSync = directory.sync;
  const originalOpenSync = fs.openSync, originalLinkSync = fs.linkSync, originalRenameSync = fs.renameSync;
  const pinned = new Set<number>();
  const crash = (where: string, moment: string) => {
    if (boundary === where && when === moment) process.exit(86);
  };
  fs.openSync = ((...args: Parameters<typeof originalOpenSync>) => {
    const fd = originalOpenSync(...args);
    if (String(args[0]).endsWith('.tmp')) pinned.add(fd);
    return fd;
  }) as typeof originalOpenSync;
  fsp.open = (async (...args: Parameters<typeof originalOpen>) => {
    const file = await originalOpen(...args);
    const adopted = /^\/proc\/self\/fd\/(\d+)$/u.exec(String(args[0]));
    if (adopted && pinned.delete(Number(adopted[1]))) {
      let kind = 'head';
      const write = file.writeFile.bind(file), sync = file.sync.bind(file);
      file.writeFile = async (...values) => {kind = JSON.parse(String(values[0])).payload.stage ? 'record' : 'head'; return write(...values);};
      file.sync = async () => {crash(`${kind}-sync`, 'before'); await sync(); crash(`${kind}-sync`, 'after');};
    }
    return file;
  }) as typeof originalOpen;
  fs.linkSync = ((...args: Parameters<typeof originalLinkSync>) => {
    crash('record-publish', 'before'); const result = originalLinkSync(...args); crash('record-publish', 'after'); return result;
  }) as typeof originalLinkSync;
  fs.renameSync = ((...args: Parameters<typeof originalRenameSync>) => {
    crash('head-rename', 'before'); const result = originalRenameSync(...args); crash('head-rename', 'after'); return result;
  }) as typeof originalRenameSync;
  let syncs = 0;
  directory.sync = async () => {
    const kind = ++syncs === 1 ? 'record' : 'head';
    crash(`${kind}-directory-sync`, 'before'); await originalSync(); crash(`${kind}-directory-sync`, 'after');
  };
  syncBuiltinESMExports();
  await perform(target);
  throw new Error('Requested crash boundary was not reached.');
}
