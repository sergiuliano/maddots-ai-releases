import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import * as filesystem from 'node:fs/promises';
import {chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile} from 'node:fs/promises';
import {createRequire, syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {JOURNAL_HEAD, JOURNAL_LIMITS, JOURNAL_MANIFEST, RunnerJournal, initializeCleanJournal,
  type JournalContext, type JournalToken} from '../src/runner/journal.js';
import {acquireRunnerStorageLock, type RunnerStorageDirectory} from '../src/runner/storage-lock.js';

const bootId = '11111111-2222-4333-8444-555555555555';
const fsp = createRequire(import.meta.url)('node:fs/promises') as typeof filesystem;
const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
const steps = ['EPOCH', 'INTENT', 'CONTAINMENT_BOUND', 'LAUNCH_ALLOWED', 'STOPPING', 'CLEAN'] as const;
type Step = typeof steps[number];

async function fixture(t: TestContext, limits: {maxRecords: number; maxBytes: number; maxRecordBytes: number} = JOURNAL_LIMITS) {
  const data = await mkdtemp(join(tmpdir(), 'mdai-journal-fixture-')); await chmod(data, 0o700);
  const lock = await acquireRunnerStorageLock(data), directory = await lock.directory('runner');
  t.after(async () => {await lock.release(); await rm(data, {recursive: true, force: true});});
  let current = true;
  const completionProof = Object.freeze({sealedRetainedCapability: randomUUID()});
  const context: JournalContext = {directoryIdentity: lock.identity, bootId, ownerEpoch: randomUUID(), generation: 1,
    isCurrent: () => current, completionScope: 'full-run', contractVersion: 1, backend: {
      verifyRegistration: async () => true,
      verifyCompletion: async (_registration, proof) => proof === completionProof,
    }};
  await initializeCleanJournal(directory, context, limits);
  const journal = new RunnerJournal(directory, context);
  assert.equal((await journal.replay()).busy, false);
  const run = {runId: randomUUID(), incarnation: randomUUID()};
  const registration = Object.freeze({backend: 'linux-cgroup-v2' as const, namespaceId: randomUUID(),
    name: `run-${run.incarnation}`, objectIdentity: '10:200'});
  let token: JournalToken | undefined;
  const perform = async (stage: Step) => {
    if (stage === 'EPOCH') {await journal.establishEpoch(); return;}
    token = stage === 'INTENT' ? await journal.intent(run) : stage === 'CONTAINMENT_BOUND' ? await journal.bind(token!, registration) :
      stage === 'LAUNCH_ALLOWED' ? await journal.allow(token!) : stage === 'STOPPING' ? await journal.stopping(token!) :
        await journal.clean(token!, completionProof);
    if (stage === 'INTENT') assert.equal(journal.consumeLauncher(token), true);
    return token;
  };
  const before = async (stage: Step) => {for (const previous of steps.slice(0, steps.indexOf(stage))) await perform(previous);};
  const fresh = () => new RunnerJournal(directory, {...context, ownerEpoch: randomUUID(), generation: 1, isCurrent: () => true});
  return {data, lock, directory, context, journal, run, registration, completionProof, perform, before, fresh,
    token: () => token!, revoke: () => {current = false;}};
}

function canonical(value: any): string {
  return value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
}
async function rewrite(path: string, mutate: (payload: any) => void) {
  const envelope = JSON.parse(await readFile(path, 'utf8')); mutate(envelope.payload);
  envelope.checksum = createHash('sha256').update(canonical(envelope.payload)).digest('hex');
  await writeFile(path, canonical(envelope) + '\n', {mode: 0o600});
}

type Boundary = 'record-sync' | 'record-publish' | 'record-directory-sync' | 'head-sync' | 'head-rename' | 'head-directory-sync';
const boundaries: Boundary[] = ['record-sync', 'record-publish', 'record-directory-sync', 'head-sync', 'head-rename', 'head-directory-sync'];
function inject(t: TestContext, directory: RunnerStorageDirectory, boundary: Boundary, when: 'before' | 'after', effect: () => Promise<void>) {
  const originalOpen = fsp.open, originalLstat = fsp.lstat, originalSync = directory.sync;
  const originalOpenSync = fs.openSync, originalLinkSync = fs.linkSync, originalRenameSync = fs.renameSync;
  let armed = true, directorySyncs = 0;
  const pinned = new Map<number, string>(), closed = new Set<string>(), published = new Set<string>(), checked = new Set<string>();
  let afterPublication: {path: string; boundary: Boundary} | undefined;
  const hit = async (where: Boundary, moment: 'before' | 'after') => {
    if (armed && where === boundary && moment === when) {armed = false; await effect();}
  };
  fs.openSync = ((...args: Parameters<typeof originalOpenSync>) => {
    const fd = originalOpenSync(...args), path = String(args[0]);
    if (path.endsWith('.tmp')) pinned.set(fd, path);
    return fd;
  }) as typeof originalOpenSync;
  fsp.open = (async (...args: Parameters<typeof originalOpen>) => {
    const file = await originalOpen(...args);
    const adopted = /^\/proc\/self\/fd\/(\d+)$/u.exec(String(args[0]));
    const path = adopted ? pinned.get(Number(adopted[1])) : undefined;
    if (adopted) pinned.delete(Number(adopted[1]));
    if (path) {
      const kind = path.includes('/.journal-head.json.') ? 'head' : 'record';
      const sync = file.sync.bind(file), close = file.close.bind(file);
      file.sync = async () => {
        await hit(kind === 'record' ? 'record-sync' : 'head-sync', 'before');
        await sync();
        await hit(kind === 'record' ? 'record-sync' : 'head-sync', 'after');
      };
      file.close = async () => {await close(); closed.add(path);};
    }
    return file;
  }) as typeof originalOpen;
  // Hold the real asynchronous validation immediately around publication. The
  // synchronous primitive still performs its final checks and namespace change.
  fsp.lstat = (async (...args: Parameters<typeof originalLstat>) => {
    const path = String(args[0]);
    if (afterPublication?.path === path) {
      const where = afterPublication.boundary; afterPublication = undefined;
      await hit(where, 'after');
    }
    if (closed.has(path) && !published.has(path) && !checked.has(path)) {
      checked.add(path); await hit(path.includes('/.journal-head.json.') ? 'head-rename' : 'record-publish', 'before');
    }
    return originalLstat(...args);
  }) as typeof originalLstat;
  fs.linkSync = ((...args: Parameters<typeof originalLinkSync>) => {
    const result = originalLinkSync(...args); published.add(String(args[0]));
    afterPublication = {path: String(args[1]), boundary: 'record-publish'}; return result;
  }) as typeof originalLinkSync;
  fs.renameSync = ((...args: Parameters<typeof originalRenameSync>) => {
    const result = originalRenameSync(...args); published.add(String(args[0]));
    afterPublication = {path: String(args[1]), boundary: 'head-rename'}; return result;
  }) as typeof originalRenameSync;
  directory.sync = async () => {
    const where = ++directorySyncs === 1 ? 'record-directory-sync' : 'head-directory-sync';
    await hit(where, 'before'); await originalSync(); await hit(where, 'after');
  };
  syncBuiltinESMExports();
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true; fsp.open = originalOpen; fsp.lstat = originalLstat;
    fs.openSync = originalOpenSync; fs.linkSync = originalLinkSync; fs.renameSync = originalRenameSync;
    directory.sync = originalSync; syncBuiltinESMExports();
  };
  t.after(restore);
  return {restore, hit: () => !armed};
}

test('S2 missing initialized manifest stays migration-required even on an empty directory', {skip: process.platform !== 'linux'}, async t => {
  const data = await mkdtemp(join(tmpdir(), 'mdai-journal-')); await chmod(data, 0o700);
  const lock = await acquireRunnerStorageLock(data);
  t.after(async () => {await lock.release(); await rm(data, {recursive: true, force: true});});
  const directory = await lock.directory('runner');
  const context: JournalContext = {directoryIdentity: lock.identity, bootId, ownerEpoch: randomUUID(), generation: 1,
    isCurrent: () => true, completionScope: 'full-run', contractVersion: 1};
  const journal = new RunnerJournal(directory, context);
  assert.deepEqual(await journal.replay(), {busy: true, reason: 'migration-required', obligations: []});
  assert.equal(journal.busy, true);
  await assert.rejects(journal.establishEpoch());
});

test('S2 explicit clean initialization permits only durable epoch and intent before launcher admission', {skip: process.platform !== 'linux'}, async t => {
  const data = await mkdtemp(join(tmpdir(), 'mdai-journal-')); await chmod(data, 0o700);
  const lock = await acquireRunnerStorageLock(data);
  t.after(async () => {await lock.release(); await rm(data, {recursive: true, force: true});});
  const directory = await lock.directory('runner');
  const context: JournalContext = {directoryIdentity: lock.identity, bootId, ownerEpoch: randomUUID(), generation: 1,
    isCurrent: () => true, completionScope: 'full-run', contractVersion: 1};
  await initializeCleanJournal(directory, context);
  const journal = new RunnerJournal(directory, context);
  assert.equal((await journal.replay()).busy, false);
  await journal.establishEpoch();
  const token = await journal.intent({runId: randomUUID(), incarnation: randomUUID()});
  assert.equal(journal.busy, true);
  assert.equal(journal.consumeLauncher(token), true);
  assert.equal(journal.consumeLauncher(token), false);
  assert.equal(journal.consumeLaunch(token), false);
  const successor = new RunnerJournal(directory, {...context, ownerEpoch: randomUUID(), generation: 2});
  const replay = await successor.replay();
  assert.equal(replay.busy, true);
  assert.equal(replay.obligations.length, 1);
  assert.equal(replay.obligations[0].stage, 'INTENT');
  assert.equal(successor.consumeLauncher(token), false);
});

test('S2 exact durable sequence, single-use permissions and certified CLEAN survive two restarts', {skip: process.platform !== 'linux'}, async t => {
  const f = await fixture(t);
  await f.before('LAUNCH_ALLOWED');
  assert.equal(f.journal.consumeLauncher(f.token()), false);
  await f.perform('LAUNCH_ALLOWED');
  assert.equal(f.journal.consumeLaunch(f.token()), true);
  assert.equal(f.journal.consumeLaunch(f.token()), false);
  await f.perform('STOPPING');
  assert.equal(f.journal.consumeLaunch(f.token()), false);
  assert.equal(f.journal.isClean(f.run.runId), false);
  await f.perform('CLEAN');
  assert.equal(f.journal.busy, false);
  assert.equal(f.journal.isClean(f.run.runId), true);
  for (let restart = 0; restart < 2; restart++) {
    const journal = f.fresh();
    assert.deepEqual(await journal.replay(), {busy: false, obligations: []});
    assert.equal(journal.isClean(f.run.runId), true);
    await journal.establishEpoch();
    assert.equal(journal.ready, true);
    assert.equal(journal.consumeLaunch(f.token()), false);
  }
  const names = (await readdir(join(f.data, 'runner'))).filter(name => /^journal-\d/.test(name));
  assert.equal(names.length, 8);
  for (const name of [JOURNAL_MANIFEST, JOURNAL_HEAD, ...names]) {
    const stat = await lstat(join(f.data, 'runner', name));
    assert.equal(stat.mode & 0o777, 0o600); assert.equal(stat.nlink, 1);
  }
});

for (const stage of steps.slice(1, -1)) {
  test(`S2 replay retains ${stage} through two restarts without launching or inferring cleanup`, {skip: process.platform !== 'linux'}, async t => {
    const f = await fixture(t); await f.before(stage); await f.perform(stage);
    for (let restart = 0; restart < 2; restart++) {
      const journal = f.fresh(), result = await journal.replay();
      assert.equal(result.busy, true); assert.equal(result.obligations.length, 1);
      assert.equal(result.obligations[0].stage, stage);
      assert.equal(journal.consumeLauncher(f.token()), false); assert.equal(journal.consumeLaunch(f.token()), false);
      await assert.rejects(journal.establishEpoch(), {reason: 'containment-recovery-required'});
      assert.equal(journal.busy, true);
    }
  });
}

for (const stage of steps) for (const boundary of boundaries) for (const when of ['before', 'after'] as const) {
  test(`S2 ${stage} ${when} ${boundary} EIO/ENOSPC retains uncertainty and valid prefix`, {skip: process.platform !== 'linux'}, async t => {
    for (const code of ['EIO', 'ENOSPC']) {
      const f = await fixture(t); await f.before(stage);
      const fault = inject(t, f.directory, boundary, when, async () => {throw Object.assign(new Error(code), {code});});
      try {
        await assert.rejects(f.perform(stage), {code: 'RUNNER_JOURNAL_UNAVAILABLE'});
        assert.equal(fault.hit(), true); assert.equal(f.journal.busy, true); assert.equal(f.journal.ready, false);
        assert.equal(f.journal.isClean(f.run.runId), false);
        if (f.token()) {assert.equal(f.journal.consumeLauncher(f.token()), false); assert.equal(f.journal.consumeLaunch(f.token()), false);}
      } finally {fault.restore();}
      for (let restart = 0; restart < 2; restart++) {
        const journal = f.fresh(), replay = await journal.replay();
        // A final head already renamed can be replayed as committed. All
        // pre-CLEAN records remain obligations even when their head committed.
        const headPublished = boundary === 'head-directory-sync' || boundary === 'head-rename' && when === 'after';
        // A failed pre-publication write retains its temporary as ambiguous
        // evidence, so an otherwise clean earlier prefix cannot certify idle.
        if ((stage === 'CLEAN' || stage === 'EPOCH') && headPublished) {
          assert.equal(replay.busy, false);
        } else assert.equal(replay.busy, true);
        if (stage !== 'CLEAN') assert.equal(journal.isClean(f.run.runId), false);
        assert.equal(journal.consumeLaunch(f.token()), false);
      }
    }
  });
}

for (const stage of steps) for (const boundary of boundaries) for (const when of ['before', 'after'] as const) {
  for (const settlement of ['success', 'EIO'] as const) {
    test(`S2 timed-out ${stage} ${when} ${boundary}, late ${settlement} cannot acknowledge or launch`, {skip: process.platform !== 'linux'}, async t => {
      const f = await fixture(t); await f.before(stage);
      let resume!: () => void, reached!: () => void;
      const stalled = new Promise<void>(resolve => {resume = resolve;}), entered = new Promise<void>(resolve => {reached = resolve;});
      const fault = inject(t, f.directory, boundary, when, async () => {
        reached(); await stalled;
        if (settlement === 'EIO') throw Object.assign(new Error('late EIO'), {code: 'EIO'});
      });
      const pending = f.perform(stage); void pending.catch(() => {});
      await entered;
      assert.equal(f.journal.busy, true);
      // The owner performs this revocation when its bounded caller wait ends.
      // The physical publication remains pending until the held I/O settles.
      f.journal.invalidate('operation-ambiguous');
      assert.equal(f.journal.ready, false);
      if (f.token()) assert.equal(f.journal.consumeLaunch(f.token()), false);
      resume();
      await assert.rejects(pending, {code: 'RUNNER_JOURNAL_UNAVAILABLE'});
      fault.restore();
      assert.equal(f.journal.busy, true); assert.equal(f.journal.isClean(f.run.runId), false);
      assert.equal(f.journal.consumeLaunch(f.token()), false);
      assert.equal((await f.journal.replay()).busy, true);
    });
  }
}

for (const corruption of ['missing-manifest', 'missing-head', 'missing-final-intent', 'gap', 'torn-tail', 'corrupt-prefix',
  'duplicate-sequence', 'wrong-generation', 'wrong-epoch', 'wrong-incarnation', 'head-checksum', 'unrecognized-tail', 'temporary-tail'] as const) {
  test(`S2 ${corruption} is retained busy after two independent replays`, {skip: process.platform !== 'linux'}, async t => {
    const f = await fixture(t); await f.before('LAUNCH_ALLOWED');
    const directory = join(f.data, 'runner'), epoch = join(directory, 'journal-0000000001.json');
    const intent = join(directory, 'journal-0000000002.json'), bound = join(directory, 'journal-0000000003.json');
    if (corruption === 'missing-manifest') await unlink(join(directory, JOURNAL_MANIFEST));
    else if (corruption === 'missing-head') await unlink(join(directory, JOURNAL_HEAD));
    else if (corruption === 'missing-final-intent') {
      // Remove every trailing run record, leaving an apparently clean EPOCH.
      await unlink(intent); await unlink(bound);
    } else if (corruption === 'gap') await unlink(intent);
    else if (corruption === 'torn-tail') await writeFile(bound, (await readFile(bound, 'utf8')).slice(0, -9));
    else if (corruption === 'corrupt-prefix') await writeFile(epoch, '{"broken":');
    else if (corruption === 'duplicate-sequence') await rewrite(bound, row => {row.sequence = 2;});
    else if (corruption === 'wrong-generation') await rewrite(bound, row => {row.generation++;});
    else if (corruption === 'wrong-epoch') await rewrite(bound, row => {row.ownerEpoch = randomUUID();});
    else if (corruption === 'wrong-incarnation') await rewrite(bound, row => {row.incarnation = randomUUID();});
    else if (corruption === 'head-checksum') await rewrite(join(directory, JOURNAL_HEAD), row => {row.recordChecksum = '0'.repeat(64);});
    else if (corruption === 'unrecognized-tail') await writeFile(join(directory, 'journal-duplicate.json'), '{}\n', {mode: 0o600});
    else await writeFile(join(directory, `.${randomUUID()}.tmp`), '{}\n', {mode: 0o600});
    for (let restart = 0; restart < 2; restart++) {
      const journal = f.fresh(), replay = await journal.replay();
      assert.equal(replay.busy, true); assert.ok(replay.reason); assert.equal(journal.isClean(f.run.runId), false);
      assert.equal(journal.consumeLaunch(f.token()), false);
    }
  });
}

test('S2 corrupt tail following CLEAN cannot certify idle or projection retirement', {skip: process.platform !== 'linux'}, async t => {
  const f = await fixture(t); await f.before('CLEAN'); await f.perform('CLEAN');
  await writeFile(join(f.data, 'runner/journal-0000000007.json'), 'torn', {mode: 0o600});
  const journal = f.fresh(); assert.equal((await journal.replay()).busy, true);
  assert.equal(journal.isClean(f.run.runId), false);
});

test('S2 boot change, contract downgrade and missing same-boot containment have no automatic recovery', {skip: process.platform !== 'linux'}, async t => {
  const f = await fixture(t); await f.before('CLEAN'); await f.perform('CLEAN');
  const rebooted = new RunnerJournal(f.directory, {...f.context, bootId: randomUUID(), ownerEpoch: randomUUID()});
  assert.equal((await rebooted.replay()).reason, 'boot-recovery-required');
  assert.throws(() => rebooted.recoverBootChange(), {reason: 'boot-recovery-required'});
  const downgraded = new RunnerJournal(f.directory, {...f.context, completionScope: 'group-only' as 'full-run', ownerEpoch: randomUUID()});
  assert.equal((await downgraded.replay()).reason, 'contract-recovery-required');
  const g = await fixture(t); await g.before('LAUNCH_ALLOWED');
  const missing = new RunnerJournal(g.directory, {...g.context, backend: undefined, ownerEpoch: randomUUID()});
  assert.equal((await missing.replay()).busy, true);
  assert.throws(() => missing.recoverSameBootContainment(), {reason: 'containment-recovery-required'});
});

test('S2 process diagnostics and caller booleans cannot prove full-run CLEAN', {skip: process.platform !== 'linux'}, async t => {
  const f = await fixture(t); await f.before('CLEAN');
  await assert.rejects(f.journal.clean(f.token(), {admissionSealed: true, populated: 0, pidMissing: true,
    processGroups: [], objectIdentity: f.registration.objectIdentity}), {reason: 'containment-unavailable'});
  assert.equal(f.journal.busy, true); assert.equal(f.journal.obligations.get(f.run.runId)?.stage, 'STOPPING');
  assert.equal((await f.fresh().replay()).busy, true);
});

test('S2 current session token identity, revision and generation are required', {skip: process.platform !== 'linux'}, async t => {
  const forged = await fixture(t); await forged.before('CONTAINMENT_BOUND');
  await assert.rejects(forged.journal.bind({...forged.token()}, forged.registration), {reason: 'session-revoked'});
  const stale = await fixture(t); await stale.before('CONTAINMENT_BOUND'); const old = stale.token();
  await stale.perform('CONTAINMENT_BOUND');
  await assert.rejects(stale.journal.bind(old, stale.registration), {reason: 'session-revoked'});
  const revoked = await fixture(t); await revoked.before('LAUNCH_ALLOWED'); await revoked.perform('LAUNCH_ALLOWED'); revoked.revoke();
  assert.equal(revoked.journal.consumeLaunch(revoked.token()), false);
  await assert.rejects(revoked.journal.stopping(revoked.token()), {reason: 'session-revoked'});
});

test('S2 synchronous sealing revokes delayed permission before STOPPING is queued', {skip: process.platform !== 'linux'}, async t => {
  const f = await fixture(t); await f.before('STOPPING'); const permission = f.token();
  f.journal.seal(permission);
  assert.equal(f.journal.consumeLaunch(permission), false);
  assert.equal(f.journal.obligations.get(f.run.runId)?.stage, 'LAUNCH_ALLOWED');
  await f.perform('STOPPING'); await f.perform('CLEAN');
  assert.equal(f.journal.busy, false);
});

test('S2 immutable record collision never overwrites an existing file', {skip: process.platform !== 'linux'}, async t => {
  const f = await fixture(t); await f.before('INTENT');
  const path = join(f.data, 'runner/journal-0000000002.json'), content = '{"existing":"sentinel"}\n';
  await writeFile(path, content, {mode: 0o600});
  await assert.rejects(f.perform('INTENT'));
  assert.equal(await readFile(path, 'utf8'), content); assert.equal(f.journal.busy, true);
});

test('S2 capacity reserves all outstanding transitions and never compacts unresolved history', {skip: process.platform !== 'linux'}, async t => {
  const f = await fixture(t, {...JOURNAL_LIMITS, maxRecords: 7}); await f.before('CONTAINMENT_BOUND');
  const before = await readdir(join(f.data, 'runner'));
  await assert.rejects(f.journal.intent({runId: randomUUID(), incarnation: randomUUID()}), {reason: 'storage-limit'});
  assert.deepEqual(await readdir(join(f.data, 'runner')), before);
  assert.equal(f.journal.obligations.size, 1); assert.equal(f.journal.busy, true);
});

test('S2 bounded byte capacity refuses intent before physical publication', {skip: process.platform !== 'linux'}, async t => {
  const f = await fixture(t, {...JOURNAL_LIMITS, maxBytes: 16 * 1024}); await f.before('INTENT');
  await assert.rejects(f.perform('INTENT'), {reason: 'storage-limit'});
  assert.equal((await readdir(join(f.data, 'runner'))).length, 3);
});

test('S2 explicit initialization refuses existing status, artifacts, and initialized storage', {skip: process.platform !== 'linux'}, async t => {
  const f = await fixture(t);
  const original = await readFile(join(f.data, 'runner', JOURNAL_MANIFEST), 'utf8');
  await assert.rejects(initializeCleanJournal(f.directory, f.context), {reason: 'migration-required'});
  assert.equal(await readFile(join(f.data, 'runner', JOURNAL_MANIFEST), 'utf8'), original);
});

test('S2 known runner companion directories and metadata do not become journal obligations', {skip: process.platform !== 'linux'}, async t => {
  const f = await fixture(t);
  for (const name of ['outcomes', 'staged', 'excludes', 'test-processes', 'activation']) {
    await mkdir(join(f.data, 'runner', name), {mode: 0o700});
  }
  for (const name of ['agents.json', 'runs.json', 'agents-catalog.json', '.activation.lock.guard', '.test-process.lock.guard']) {
    await writeFile(join(f.data, 'runner', name), '{}\n', {mode: 0o600});
  }
  assert.deepEqual(await f.fresh().replay(), {busy: false, obligations: []});
});

test('S2 containment registration is immutable while backend verification awaits', {skip: process.platform !== 'linux'}, async t => {
  const f = await fixture(t); await f.before('CONTAINMENT_BOUND');
  const candidate = {...f.registration, objectIdentity: String(f.registration.objectIdentity)}, binding = f.journal.bind(f.token(), candidate);
  candidate.objectIdentity = '999:999'; candidate.namespaceId = randomUUID();
  const bound = await binding;
  assert.deepEqual(bound.registration, f.registration);
  assert.deepEqual((await f.fresh().replay()).obligations[0].registration, f.registration);
});

for (const mutation of ['short-read-hiding-tail', 'growth-after-stat', 'truncation-after-stat'] as const) {
  test(`S2 ${mutation} cannot turn an incomplete read into CLEAN proof`, {skip: process.platform !== 'linux'}, async t => {
    const f = await fixture(t); await f.before('CLEAN'); await f.perform('CLEAN');
    const name = 'journal-0000000006.json', path = join(f.data, 'runner', name), valid = await readFile(path, 'utf8');
    await writeFile(path, mutation === 'growth-after-stat' ? valid.slice(0, -1) : valid + 'CORRUPT_TAIL\n');
    const originalOpen = fsp.open;
    let reached = false;
    t.mock.method(fsp, 'open', async (...args: Parameters<typeof originalOpen>) => {
      const file = await originalOpen(...args);
      if (String(args[0]).endsWith('/' + name)) {
        const originalRead = file.read.bind(file);
        t.mock.method(file, 'read', async (buffer: Buffer, offset: number, length: number, position: number | null) => {
          reached = true;
          if (mutation !== 'short-read-hiding-tail') await writeFile(path, valid);
          return originalRead(buffer, offset, mutation === 'short-read-hiding-tail' ? Math.min(length, Buffer.byteLength(valid)) : length, position);
        });
      }
      return file;
    });
    syncBuiltinESMExports();
    t.after(() => {t.mock.restoreAll(); syncBuiltinESMExports();});
    const successor = f.fresh(), replay = await successor.replay();
    assert.equal(reached, true);
    assert.equal(replay.busy, true, 'a canonical CLEAN prefix is insufficient when the entire size-checked file was not read');
    assert.equal(replay.reason, 'journal-invalid');
    assert.equal(successor.isClean(f.run.runId), false);
    assert.equal(replay.obligations[0].stage, 'STOPPING');
    assert.equal(successor.consumeLaunch(f.token()), false);
  });
}
