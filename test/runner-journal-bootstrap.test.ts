import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test, {type TestContext} from 'node:test';

// Unprivileged native local-filesystem qualification. No service, credentials,
// workload, root operation, cgroup or external destination is used.
// TMPDIR=<fixture-volume> node --import tsx --import
// ./helper/test/support/runner-signal-runtime-guard.ts
// helper/test/runner-journal-bootstrap.test.ts
const worker = fileURLToPath(new URL('./fixtures/runner-journal-bootstrap.ts', import.meta.url));
type Configuration = {mode: 'bootstrap' | 'probe' | 'failure' | 'crash' | 'hold' | 'late'; data: string;
  evidencePath: string; evidenceSha256: string; boundary?: string; when?: 'before' | 'after'; error?: 'EIO' | 'ENOSPC';
  useDefaultEvidenceOwner?: boolean; foreignOwner?: 'data' | 'evidence' | 'ancestor'};
type Reply = {kind: string; error: string | null; hits: number; physical: number; maximumPhysical: number;
  initCalls: number; activeReads: number; replays: number; epochs: number; trace: string[];
  owner?: {busy: boolean; pendingOperations: number; failure: boolean; unavailable: boolean; journal: {reason: string | null} | null};
  diagnostics: {busy: boolean; owners: unknown[]}};
function controller(configuration: Configuration) {
  const environment = {...process.env}; delete environment.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['--import', 'tsx', worker, JSON.stringify(configuration)],
    {env: environment, stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
  const messages: Reply[] = [], waiters = new Map<string, (reply: Reply) => void>();
  let stderr = '', exitCode: number | null = null, signal: NodeJS.Signals | null = null;
  child.stderr!.on('data', chunk => {stderr += String(chunk);});
  child.on('message', (message: Reply) => {messages.push(message); waiters.get(message.kind)?.(message);});
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject); child.once('exit', (code, reason) => {exitCode = code; signal = reason; resolve();});
  });
  async function reply(kind: string): Promise<Reply> {
    const existing = messages.find(message => message.kind === kind); if (existing) return existing;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([new Promise<Reply>(resolve => {waiters.set(kind, resolve);}),
        exited.then(() => {throw new Error(`Bootstrap fixture exited before ${kind}: ${JSON.stringify(messages)} ${stderr}`);}),
        new Promise<Reply>((_resolve, reject) => {timer = setTimeout(() => reject(new Error(`Bootstrap fixture timed out before ${kind}: ${JSON.stringify(messages)} ${stderr}`)), 12_000);})]);
    } finally {if (timer) clearTimeout(timer); waiters.delete(kind);}
  }
  return {reply, release: () => {if (child.connected) child.send('release');},
    finish: async (expected = 0) => {await exited; assert.equal(signal, null, stderr); assert.equal(exitCode, expected, `${JSON.stringify(messages)} ${stderr}`);}};
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-journal-bootstrap-'));
  const data = join(root, 'data'); await mkdir(data, {mode: 0o700});
  const info = await lstat(data), now = Date.now();
  const evidence = {format: 'mdai-journal-bootstrap-v1', uid: process.getuid!(), data, directoryIdentity: `${info.dev}:${info.ino}`,
    bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(), issuedAt: now - 1000, expiresAt: now + 600_000,
    launchEntrypointsFenced: true, updateEntrypointsFenced: true, oldWritersExtinct: true, workloadsExtinct: true,
    prerequisiteSha256: 'a'.repeat(64)};
  const evidencePath = join(root, 'founder-evidence.json');
  let evidenceSha256 = '';
  async function saveEvidence() {
    await chmod(evidencePath, 0o600).catch(error => {if (error.code !== 'ENOENT') throw error;});
    const bytes = JSON.stringify(evidence) + '\n';
    await writeFile(evidencePath, bytes, {mode: 0o444}); await chmod(evidencePath, 0o444);
    evidenceSha256 = createHash('sha256').update(bytes).digest('hex');
  }
  await saveEvidence();
  const children: ReturnType<typeof controller>[] = [];
  t.after(async () => {
    for (const child of children) child.release();
    await Promise.allSettled(children.map(child => child.finish()));
    await rm(root, {recursive: true, force: true});
  });
  function start(mode: Configuration['mode'], overrides: Partial<Configuration> = {}) {
    const child = controller({mode, data, evidencePath, evidenceSha256, ...overrides}); children.push(child); return child;
  }
  async function run(mode: Configuration['mode'], overrides: Partial<Configuration> = {}) {
    const child = start(mode, overrides), result = await child.reply('result'); await child.finish(); return result;
  }
  return {root, data, evidencePath, evidence, saveEvidence, start, run};
}
async function records(data: string) {
  const names = (await readdir(join(data, 'runner'))).filter(name => /^journal-\d{10}\.json$/u.test(name)).sort();
  return Promise.all(names.map(async name => JSON.parse(await readFile(join(data, 'runner', name), 'utf8')).payload));
}
async function journalBytes(data: string) {
  const names = (await readdir(join(data, 'runner')).catch(error => {
    if (error.code === 'ENOENT') return []; throw error;
  })).filter(name => /^\.?journal-/u.test(name)).sort();
  return Promise.all(names.map(async name => [name, await readFile(join(data, 'runner', name))] as const));
}
function assertJournalPreserved(before: Awaited<ReturnType<typeof journalBytes>>, after: Awaited<ReturnType<typeof journalBytes>>,
  successful: boolean, message: string) {
  if (!successful) {assert.deepEqual(after, before, message); return;}
  const latest = new Map(after);
  for (const [name, bytes] of before) {
    if (name !== 'journal-head.json') assert.deepEqual(latest.get(name), bytes, `${message}: ${name}`);
  }
}
const native = {skip: process.platform !== 'linux', timeout: 20_000};
const refusalCodes = new Set(['RUNNER_JOURNAL_BOOTSTRAP_REFUSED', 'RUNNER_JOURNAL_UNAVAILABLE', 'RUNNER_STATE_UNAVAILABLE', 'PATH_UNSAFE', 'EIO', 'ENOSPC']);
function assertRefused(result: Reply) {assert(refusalCodes.has(result.error!), JSON.stringify(result));}

test('S5-07 fresh bootstrap uses one physical owner, persists EPOCH before outcomes, and refuses a second initialization', native, async t => {
  const f = await fixture(t), result = await f.run('bootstrap');
  assert.equal(result.error, null, JSON.stringify(result));
  assert.equal(result.maximumPhysical, 1); assert.equal(result.physical, 0);
  assert.equal(result.initCalls, 1); assert.equal(result.activeReads, 1); assert.equal(result.replays, 1); assert.equal(result.epochs, 1);
  assert(result.trace.indexOf('after:epoch-head-directory-sync') < result.trace.indexOf('before:outcomes-create-directory-sync'));
  const history = await records(f.data);
  assert.deepEqual(history.map(row => ({sequence: row.sequence, stage: row.stage})), [{sequence: 1, stage: 'EPOCH'}]);
  assert.equal(history.some(row => row.stage === 'CLEAN'), false);
  const before = await journalBytes(f.data), second = await f.run('bootstrap');
  assertRefused(second); assert.equal(second.replays, 0); assert.equal(second.initCalls, 0); assert.equal(second.activeReads, 0);
  assert.deepEqual(await journalBytes(f.data), before, 'repeat bootstrap cannot mutate any retained journal bytes');
  for (let restart = 0; restart < 2; restart++) {
    const replay = await f.run('probe'); assert.equal(replay.error, null, JSON.stringify(replay));
    assert.equal(replay.replays, 1); assert.equal(replay.activeReads, 1); assert.equal(replay.epochs, 1);
  }
  const restarted = await records(f.data);
  assert.deepEqual(restarted.map(row => row.stage), ['EPOCH', 'EPOCH', 'EPOCH']);
  assert.equal(new Set(restarted.map(row => row.ownerEpoch)).size, 3);
});

test('S5-07 ordinary startup keeps missing-manifest refusal and cannot bootstrap implicitly', native, async t => {
  const f = await fixture(t), result = await f.run('probe');
  assert.equal(result.error, 'RUNNER_STATE_UNAVAILABLE'); assert.equal(result.replays, 1);
  assert.equal(result.epochs, 0); assert.equal(result.activeReads, 0); assert.equal(result.initCalls, 0);
  assert.equal(result.owner?.journal?.reason, 'migration-required');
  assert.deepEqual(await readdir(join(f.data, 'runner')), []);
  assertRefused(await f.run('bootstrap'));
});

test('S5-07 fresh bootstrap retains initially accepted empty logs without replacing its inode', native, async t => {
  const f = await fixture(t), logs = join(f.data, 'logs');
  await mkdir(logs, {mode: 0o700}); const accepted = await lstat(logs);
  const result = await f.run('bootstrap'); assert.equal(result.error, null, JSON.stringify(result));
  assert.equal(result.maximumPhysical, 1); assert.equal(result.initCalls, 1); assert.equal(result.epochs, 1);
  assert.equal((await lstat(logs)).ino, accepted.ino); assert.deepEqual(await readdir(logs), []);
  assert.deepEqual((await records(f.data)).map(row => row.stage), ['EPOCH']);
});

for (const name of ['runner', 'run-homes', 'backups/run-stage', 'runner/outcomes', 'runner/active.json', 'runner/journal-head.json',
  'runner/journal-manifest.json', 'runner/.journal-head.json.11111111-2222-4333-8444-555555555555.tmp']) {
  test(`S5-07 bootstrap preserves pre-existing ${name} evidence`, native, async t => {
    const f = await fixture(t), target = join(f.data, name);
    if (name.endsWith('.json') || name.endsWith('.tmp')) {
      await mkdir(join(f.data, 'runner'), {mode: 0o700}); await writeFile(target, 'retained evidence\n', {mode: 0o600});
    } else await mkdir(target, {recursive: true, mode: 0o700});
    const before = await lstat(target), result = await f.run('bootstrap'); assertRefused(result);
    assert.equal(result.initCalls, 0); assert.equal(result.activeReads, 0); assert.equal(result.replays, 0);
    assert.equal((await lstat(target)).ino, before.ino);
    if (before.isFile()) assert.equal(await readFile(target, 'utf8'), 'retained evidence\n');
  });
}

for (const field of ['launchEntrypointsFenced', 'updateEntrypointsFenced', 'oldWritersExtinct', 'workloadsExtinct'] as const) {
  test(`S5-07 bootstrap requires founder attestation ${field}`, native, async t => {
    const f = await fixture(t); f.evidence[field] = false; await f.saveEvidence();
    const result = await f.run('bootstrap'); assertRefused(result); assert.equal(result.maximumPhysical, 0);
    assert.deepEqual(await readdir(f.data), []);
  });
}

for (const problem of ['wrong-hash', 'wrong-directory', 'wrong-identity', 'wrong-boot', 'wrong-uid', 'expired', 'future', 'too-long', 'extra-field',
  'writable-evidence', 'linked-evidence', 'symlink-evidence', 'aliased-data', 'public-data', 'writable-ancestor', 'inside-data-evidence',
  'nonempty-logs', 'public-logs'] as const) {
  test(`S5-07 bootstrap rejects ${problem} before persistence`, native, async t => {
    const f = await fixture(t), overrides: Partial<Configuration> = {};
    if (problem === 'wrong-hash') overrides.evidenceSha256 = '0'.repeat(64);
    else if (problem === 'wrong-directory') f.evidence.data = join(f.root, 'other');
    else if (problem === 'wrong-identity') f.evidence.directoryIdentity = '1:2';
    else if (problem === 'wrong-boot') f.evidence.bootId = '11111111-2222-4333-8444-555555555555';
    else if (problem === 'wrong-uid') f.evidence.uid++;
    else if (problem === 'expired') f.evidence.expiresAt = Date.now() - 1;
    else if (problem === 'future') f.evidence.issuedAt = Date.now() + 60_000;
    else if (problem === 'too-long') f.evidence.expiresAt = f.evidence.issuedAt + 900_001;
    else if (problem === 'extra-field') Object.assign(f.evidence, {unexpected: true});
    else if (problem === 'aliased-data') f.evidence.data = join(f.root, 'data-alias');
    await f.saveEvidence();
    if (problem === 'writable-evidence') await chmod(f.evidencePath, 0o666);
    else if (problem === 'linked-evidence') await link(f.evidencePath, join(f.root, 'second-evidence-link'));
    else if (problem === 'symlink-evidence') {overrides.evidencePath = join(f.root, 'evidence-alias'); await symlink(f.evidencePath, overrides.evidencePath);}
    else if (problem === 'aliased-data') {overrides.data = join(f.root, 'data-alias'); await symlink(f.data, overrides.data);}
    else if (problem === 'public-data') await chmod(f.data, 0o755);
    else if (problem === 'writable-ancestor') await chmod(f.root, 0o777);
    else if (problem === 'inside-data-evidence') {overrides.evidencePath = join(f.data, 'evidence.json'); await rename(f.evidencePath, overrides.evidencePath);}
    else if (problem === 'nonempty-logs' || problem === 'public-logs') {
      await mkdir(join(f.data, 'logs'), {mode: problem === 'public-logs' ? 0o755 : 0o700});
      if (problem === 'nonempty-logs') await writeFile(join(f.data, 'logs', 'retained.log'), 'retained\n', {mode: 0o600});
    }
    const result = await f.run('bootstrap', overrides); assertRefused(result);
    assert.equal(result.initCalls, 0); assert.equal(result.activeReads, 0); assert.equal(result.replays, 0);
    await assert.rejects(lstat(join(f.data, 'runner')), {code: 'ENOENT'});
  });
}

test('S5-07 production default refuses a fixture-owned receipt without the explicit trusted fixture owner', native, async t => {
  const f = await fixture(t), result = await f.run('bootstrap', {useDefaultEvidenceOwner: true});
  assertRefused(result); assert.equal(result.maximumPhysical, 0); assert.deepEqual(await readdir(f.data), []);
});
for (const foreignOwner of ['data', 'evidence', 'ancestor'] as const) {
  test(`S5-07 simulated foreign ${foreignOwner} ownership refuses before persistence`, native, async t => {
    const f = await fixture(t), result = await f.run('bootstrap', {foreignOwner});
    assertRefused(result); assert.equal(result.maximumPhysical, 0); assert.deepEqual(await readdir(f.data), []);
  });
}

test('S5-07 a retained bootstrap excludes competing real and aliased processes before replay', native, async t => {
  const f = await fixture(t), alias = join(f.root, 'data-alias'); await symlink(f.data, alias);
  const first = f.start('hold', {boundary: 'initial-head-sync'});
  const held = await first.reply('held'); assert.equal(held.physical, 1);
  const independent = await fixture(t);
  assert.equal((await independent.run('bootstrap')).error, null, 'another retained storage inode has an independent real owner');
  const same = f.start('bootstrap'), aliased = f.start('bootstrap', {data: alias}), ordinary = f.start('probe');
  const aliasedOrdinary = f.start('probe', {data: alias});
  for (const competitor of [same, aliased, ordinary, aliasedOrdinary]) {
    const refused = await competitor.reply('result'); assertRefused(refused);
    assert.equal(refused.replays, 0); assert.equal(refused.activeReads, 0); assert.equal(refused.epochs, 0);
    assert.equal(refused.maximumPhysical, 0); await competitor.finish();
  }
  first.release(); assert.equal((await first.reply('result')).error, null); await first.finish();
  assert.equal((await f.run('probe')).error, null);
});

for (const replacement of ['data', 'runner', 'evidence'] as const) {
  test(`S5-07 replacement of retained ${replacement} refuses and preserves the replacement inode`, native, async t => {
    const f = await fixture(t), first = f.start('hold', {boundary: 'initial-head-sync'});
    await first.reply('held');
    const target = replacement === 'data' ? f.data : replacement === 'runner' ? join(f.data, 'runner') : f.evidencePath;
    await rename(target, target + '.original');
    if (replacement === 'evidence') await writeFile(target, 'replacement must survive\n', {mode: 0o444});
    else {await mkdir(target, {mode: 0o700}); await writeFile(join(target, 'replacement'), 'replacement must survive\n', {mode: 0o600});}
    const inode = (await lstat(target)).ino;
    first.release(); const refused = await first.reply('result'); await first.finish(); assertRefused(refused);
    assert.equal((await lstat(target)).ino, inode);
    assert.equal(await readFile(replacement === 'evidence' ? target : join(target, 'replacement'), 'utf8'), 'replacement must survive\n');
    assert.equal(refused.initCalls, replacement === 'evidence' ? 1 : 0);
    assert.equal(refused.activeReads, replacement === 'evidence' ? 1 : 0);
  });
}

for (const name of ['runner/outcomes', 'logs'] as const) {
  test(`S5-07 an initially absent empty ${name} introduced during initial-head sync refuses and preserves its inode`, native, async t => {
    const f = await fixture(t), first = f.start('hold', {boundary: 'initial-head-sync'});
    await first.reply('held');
    const target = join(f.data, name); await mkdir(target, {mode: 0o700});
    const introduced = await lstat(target);
    first.release(); const refused = await first.reply('result'); await first.finish(); assertRefused(refused);
    assert.equal(refused.hits, 1); assert.equal(refused.diagnostics.busy, true);
    assert.equal((await lstat(target)).ino, introduced.ino); assert.deepEqual(await readdir(target), []);
    const retained = await journalBytes(f.data); assertRefused(await f.run('bootstrap'));
    assert.deepEqual(await journalBytes(f.data), retained, 'retry preserves the refused journal namespace');
    assert.equal((await lstat(target)).ino, introduced.ino); assert.deepEqual(await readdir(target), []);
  });
}

test('S5-07 initially accepted empty logs replaced during initial-head sync refuses and preserves both inodes', native, async t => {
  const f = await fixture(t), target = join(f.data, 'logs'), original = join(f.root, 'accepted-logs');
  await mkdir(target, {mode: 0o700}); const accepted = await lstat(target);
  const first = f.start('hold', {boundary: 'initial-head-sync'}); await first.reply('held');
  await rename(target, original); await mkdir(target, {mode: 0o700});
  const replacement = await lstat(target); assert.notEqual(replacement.ino, accepted.ino);
  first.release(); const refused = await first.reply('result'); await first.finish(); assertRefused(refused);
  assert.equal(refused.hits, 1); assert.equal(refused.diagnostics.busy, true);
  const retained = await journalBytes(f.data); assertRefused(await f.run('bootstrap'));
  assert.deepEqual(await journalBytes(f.data), retained, 'retry preserves the refused journal namespace');
  assert.equal((await lstat(target)).ino, replacement.ino); assert.equal((await lstat(original)).ino, accepted.ino);
  assert.deepEqual(await readdir(target), []); assert.deepEqual(await readdir(original), []);
});

for (const name of ['runner', 'runner/outcomes', 'logs']) for (const operation of ['open', 'sync']) {
  for (const when of ['before', 'after'] as const) {
    const boundary = `${name.split('/').at(-1)}-create-directory-${operation}`;
    test(`S5-07 pinned ${name} creation refuses an empty private replacement ${when} ${boundary}`, native, async t => {
      const f = await fixture(t), first = f.start('hold', {boundary, when});
      const held = await first.reply('held'); assert.equal(held.physical, 1);
      const target = join(f.data, name), original = join(f.root, 'original-directory');
      const before = await lstat(target);
      await rename(target, original); await mkdir(target, {mode: 0o700});
      const replacement = await lstat(target); assert.notEqual(replacement.ino, before.ino);
      first.release(); const refused = await first.reply('result'); await first.finish(); assertRefused(refused);
      assert.equal(refused.hits, 1);
      assert.equal((await lstat(target)).ino, replacement.ino); assert.equal((await lstat(original)).ino, before.ino);
      assert.deepEqual(await readdir(target), []); assert.deepEqual(await readdir(original), []);
      if (name === 'runner') {
        assert.equal(refused.replays, 0); assert.equal(refused.epochs, 0);
        assert.equal(refused.initCalls, 0); assert.equal(refused.activeReads, 0);
      }
    });
  }
}

for (const name of ['runner', 'runner/outcomes', 'logs']) {
  const boundaries = new Set([`${name.split('/').at(-1)}-create-directory-sync`, 'logs-create-directory-sync']);
  for (const boundary of boundaries) for (const when of ['before', 'after'] as const) {
    for (const [permission, mode] of [['setgid', 0o2700], ['setuid', 0o4700], ['sticky', 0o1700], ['group', 0o770]] as const) {
      test(`S5-07 ${name} ${permission} mode change ${when} ${boundary} refuses bootstrap and restart`, native, async t => {
        const f = await fixture(t), first = f.start('hold', {boundary, when});
        const held = await first.reply('held'); assert.equal(held.physical, 1);
        const target = join(f.data, name), original = await lstat(target);
        await chmod(target, mode);
        assert.equal((await lstat(target)).mode & 0o7777, mode, 'the real directory must carry every injected permission bit');
        first.release(); const refused = await first.reply('result'); await first.finish(); assertRefused(refused);
        assert.equal(refused.hits, 1); assert.equal(refused.diagnostics.busy, true);
        const retained = await journalBytes(f.data), replay = await f.run('probe'); assertRefused(replay);
        assert.equal(replay.activeReads, 0, 'restart must refuse before reading active runs');
        // A restart can append its own EPOCH before discovering a bad outcomes
        // or logs directory, but it must preserve all prior immutable evidence.
        const latest = new Map(await journalBytes(f.data));
        for (const [entry, bytes] of retained) {
          if (entry !== 'journal-head.json') assert.deepEqual(latest.get(entry), bytes, entry);
        }
        const after = await lstat(target);
        assert.equal(after.ino, original.ino); assert.equal(after.mode & 0o7777, mode, 'refusal must never repair permissions');
      });
    }
  }
}

for (const name of ['run-homes', 'backups/run-stage', 'runner-retained', '.runner-retained', '.run-retained', 'logs/late.log']) {
  test(`S5-07 late external ${name} evidence refuses final bootstrap acknowledgment`, native, async t => {
    const f = await fixture(t), first = f.start('hold', {boundary: 'logs-create-directory-sync'});
    await first.reply('held');
    const target = join(f.data, name), before = await journalBytes(f.data);
    if (name.endsWith('.log')) await writeFile(target, 'retained late evidence\n', {mode: 0o600});
    else await mkdir(target, {recursive: true, mode: 0o700});
    const evidence = await lstat(target);
    first.release(); const refused = await first.reply('result'); await first.finish();
    assert.equal(refused.error, 'RUNNER_JOURNAL_BOOTSTRAP_REFUSED', JSON.stringify(refused));
    assert.equal(refused.hits, 1); assert.equal(refused.diagnostics.busy, true);
    assert.equal((await lstat(target)).ino, evidence.ino);
    if (evidence.isFile()) assert.equal(await readFile(target, 'utf8'), 'retained late evidence\n');
    assert.deepEqual(await journalBytes(f.data), before, 'final refusal preserves the durable journal prefix');
    assertRefused(await f.run('bootstrap'));
    assert.deepEqual(await journalBytes(f.data), before, 'retry cannot repair a refused bootstrap');
  });
}

const stages = ['initial-head', 'manifest', 'epoch-record', 'epoch-head'];
const syncBoundaries = [...stages.flatMap(stage => [`${stage}-sync`, `${stage}-directory-sync`]),
  'runner-create-directory-sync', 'outcomes-create-directory-sync', 'logs-create-directory-sync'];
const persistenceBoundaries = [...stages.flatMap(stage => ['open', 'write', 'close', 'sync', 'publish', 'directory-sync'].map(operation => `${stage}-${operation}`)),
  ...stages.filter(stage => stage !== 'epoch-head').map(stage => `${stage}-unlink`),
  'runner-create-directory-sync', 'outcomes-create-directory-sync', 'logs-create-directory-sync'];
const syscallBoundaries = [...stages.map(stage => `${stage}-openSync-exclusive`),
  ...stages.filter(stage => stage !== 'epoch-head').flatMap(stage => [`${stage}-linkSync`, `${stage}-unlinkSync`]),
  'epoch-head-renameSync', ...['runner', 'outcomes', 'logs'].flatMap(name => [`${name}-mkdirSync`, `${name}-openSync-directory`])];

for (const stage of stages) for (const operation of ['open', 'sync', 'publish', 'unlink']) for (const when of ['before', 'after'] as const) {
  if (operation === 'unlink' && (stage === 'epoch-head' || when === 'after') ||
    operation === 'publish' && stage === 'epoch-head' && when === 'after') continue;
  const boundary = `${stage}-${operation}`;
  test(`S5-07 pinned ${stage} temporary refuses the same-byte replacement ${when} ${boundary}`, native, async t => {
    const f = await fixture(t), first = f.start('hold', {boundary, when}); await first.reply('held');
    const runner = join(f.data, 'runner'), names = (await readdir(runner)).filter(name => /^\.journal-.*\.tmp$/u.test(name));
    assert.equal(names.length, 1, JSON.stringify(names));
    const target = join(runner, names[0]), original = join(f.root, 'original-temporary');
    const before = await lstat(target), bytes = await readFile(target);
    await rename(target, original); await writeFile(target, bytes, {mode: 0o600});
    const replacement = await lstat(target); assert.notEqual(replacement.ino, before.ino);
    first.release(); const refused = await first.reply('result'); await first.finish(); assertRefused(refused);
    assert.equal(refused.hits, 1); assert.equal((await lstat(target)).ino, replacement.ino);
    assert.equal((await lstat(original)).ino, before.ino);
    assert.deepEqual(await readFile(target), bytes, 'refusal preserves the replacement temporary bytes');
    assert.deepEqual(await readFile(original), bytes, 'refusal preserves the displaced pinned temporary bytes');
    const retained = await journalBytes(f.data); assertRefused(await f.run('bootstrap'));
    assert.deepEqual(await journalBytes(f.data), retained, 'bootstrap cannot erase a replaced temporary');
    const probe = await f.run('probe'); assertRefused(probe);
    assert.deepEqual(await journalBytes(f.data), retained, 'ordinary refusal cannot erase a replaced temporary');
  });
}

for (const stage of stages) for (const when of ['before', 'after'] as const) {
  const boundary = `${stage}-publish`;
  test(`S5-07 ${stage} publication refuses a private replacement ${when} ${boundary}`, native, async t => {
    const f = await fixture(t), first = f.start('hold', {boundary, when}); await first.reply('held');
    const name = stage === 'manifest' ? 'journal-manifest.json' : stage === 'epoch-record' ? 'journal-0000000001.json' : 'journal-head.json';
    const target = join(f.data, 'runner', name), original = join(f.root, 'original-publication');
    const prior = await lstat(target).catch(error => {if (error.code !== 'ENOENT') throw error;});
    const bytes = prior ? await readFile(target) : Buffer.from([0x00, 0xff, 0xfe, 0x0a]);
    if (prior) await rename(target, original);
    await writeFile(target, bytes, {mode: 0o600}); const replacement = await lstat(target);
    if (prior) assert.notEqual(replacement.ino, prior.ino);
    first.release(); const refused = await first.reply('result'); await first.finish(); assertRefused(refused);
    assert.equal(refused.hits, 1); assert.equal((await lstat(target)).ino, replacement.ino);
    assert.deepEqual(await readFile(target), bytes, 'refusal preserves the replacement publication bytes');
    if (prior) {
      assert.equal((await lstat(original)).ino, prior.ino);
      assert.deepEqual(await readFile(original), bytes, 'refusal preserves the displaced publication bytes');
    }
  });
}

for (const name of ['journal-head.json', 'journal-manifest.json', 'journal-0000000001.json']) {
  for (const when of ['before', 'after'] as const) {
    test(`S5-07 retained ${name} refuses later same-byte replacement ${when} logs parent sync`, native, async t => {
      const f = await fixture(t), first = f.start('hold', {boundary: 'logs-create-directory-sync', when}); await first.reply('held');
      const target = join(f.data, 'runner', name), original = join(f.root, 'original-published-file');
      const prior = await lstat(target), bytes = await readFile(target);
      await rename(target, original); await writeFile(target, bytes, {mode: 0o600});
      const replacement = await lstat(target); assert.notEqual(replacement.ino, prior.ino);
      first.release(); const refused = await first.reply('result'); await first.finish(); assertRefused(refused);
      assert.equal(refused.hits, 1); assert.equal((await lstat(target)).ino, replacement.ino);
      assert.equal((await lstat(original)).ino, prior.ino);
      assert.deepEqual(await readFile(target), bytes); assert.deepEqual(await readFile(original), bytes);
    });
  }
}

const heldBoundaries = [...persistenceBoundaries, ...['runner', 'outcomes', 'logs'].map(name => `${name}-create-directory-open`)];
for (const boundary of heldBoundaries) for (const when of ['before', 'after'] as const) {
  for (const entry of ['outcome', 'journal-temporary']) {
    test(`S5-07 unexpected ${entry} ${when} ${boundary} refuses acknowledgment and preserves evidence`, native, async t => {
      const f = await fixture(t), first = f.start('hold', {boundary, when}); await first.reply('held');
      const parent = join(f.data, 'runner', ...(entry === 'outcome' ? ['outcomes'] : []));
      if (entry === 'outcome') await mkdir(parent, {mode: 0o700}).catch(error => {if (error.code !== 'EEXIST') throw error;});
      const target = join(parent, entry === 'outcome' ? '11111111-2222-4333-8444-555555555555.json' :
        '.journal-head.json.11111111-2222-4333-8444-555555555555.tmp');
      const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x0a]); await writeFile(target, bytes, {mode: 0o600});
      const before = await lstat(target);
      first.release(); const refused = await first.reply('result'); await first.finish(); assertRefused(refused);
      assert.equal(refused.hits, 1); assert.equal((await lstat(target)).ino, before.ino);
      assert.deepEqual(await readFile(target), bytes, 'bootstrap preserves the unexpected binary evidence');
      const retained = await journalBytes(f.data); assertRefused(await f.run('bootstrap'));
      assert.deepEqual(await journalBytes(f.data), retained, 'retry preserves the entire journal namespace');
      assert.equal((await lstat(target)).ino, before.ino); assert.deepEqual(await readFile(target), bytes);
    });
  }
}

for (const name of ['active.json', 'staged', 'journal-0000000002.json', '.unknown']) {
  for (const when of ['before', 'after'] as const) {
    test(`S5-07 unexpected runner ${name} ${when} logs sync refuses and preserves exact inventory`, native, async t => {
      const f = await fixture(t), first = f.start('hold', {boundary: 'logs-create-directory-sync', when}); await first.reply('held');
      const target = join(f.data, 'runner', name), bytes = name === 'active.json' ? Buffer.from('[]\n') : Buffer.from([0x00, 0xff, 0x0a]);
      if (name === 'staged') await mkdir(target, {mode: 0o700});
      else await writeFile(target, bytes, {mode: 0o600});
      const before = await lstat(target);
      first.release(); const refused = await first.reply('result'); await first.finish(); assertRefused(refused);
      assert.equal(refused.hits, 1); assert.equal((await lstat(target)).ino, before.ino);
      if (name === 'staged') assert.deepEqual(await readdir(target), []);
      else assert.deepEqual(await readFile(target), bytes);
      const retained = await journalBytes(f.data); assertRefused(await f.run('bootstrap'));
      assert.deepEqual(await journalBytes(f.data), retained, 'bootstrap retry preserves the exact refused journal namespace');
      assert.equal((await lstat(target)).ino, before.ino);
      if (name === 'staged') assert.deepEqual(await readdir(target), []);
      else assert.deepEqual(await readFile(target), bytes);
    });
  }
}

for (const error of ['EIO', 'ENOSPC'] as const) for (const boundary of [...persistenceBoundaries, ...syscallBoundaries]) {
  test(`S5-07 ${error} at ${boundary} never acknowledges bootstrap or overwrites partial evidence`, native, async t => {
    const f = await fixture(t), failed = await f.run('failure', {boundary, error});
    assert.equal(failed.hits, 1, JSON.stringify(failed)); assertRefused(failed);
    assert.equal(failed.maximumPhysical, 1); assert.equal(failed.physical, 0);
    assert.equal(failed.diagnostics.busy, true, 'an uncertain mutation retains its real owner');
    assert(failed.trace.includes(`before:${boundary}`), 'the selected production call must be intercepted');
    if (boundary === 'runner-mkdirSync') {
      assert.deepEqual(await readdir(f.data), [], 'failed mkdir leaves no created runner or journal evidence');
      assert.equal((await f.run('bootstrap')).error, null, 'a new process may explicitly bootstrap untouched fresh storage');
      return;
    }
    const before = await journalBytes(f.data), repeated = await f.run('bootstrap');
    assertRefused(repeated); assert.deepEqual(await journalBytes(f.data), before);
    const replay = await f.run('probe');
    assertJournalPreserved(before, await journalBytes(f.data), replay.error === null,
      'ordinary restart preserves every retained failure byte');
    if (replay.error === null) {
      const history = await records(f.data); assert(history.length > 0); assert(history.every(row => row.stage === 'EPOCH'));
    } else {
      assert.equal(replay.error, 'RUNNER_STATE_UNAVAILABLE'); assert.equal(replay.activeReads, 0); assert.equal(replay.initCalls, 0);
    }
  });
}

for (const error of ['EIO', 'ENOSPC'] as const) for (const boundary of syncBoundaries) {
  test(`S5-07 ${error} acknowledgment failure after ${boundary} cannot report success`, native, async t => {
    const f = await fixture(t), failed = await f.run('failure', {boundary, error, when: 'after'});
    assert.equal(failed.hits, 1, JSON.stringify(failed)); assertRefused(failed);
    assert.equal(failed.diagnostics.busy, true);
    const before = await journalBytes(f.data), prefix = await records(f.data);
    assertRefused(await f.run('bootstrap'));
    assert.deepEqual(await journalBytes(f.data), before, 'bootstrap preserves the post-sync failure prefix');
    const cleanPrefix = ['manifest-directory-sync', 'epoch-head-directory-sync',
      'outcomes-create-directory-sync', 'logs-create-directory-sync'].includes(boundary);
    for (let restart = 0; restart < 2; restart++) {
      const beforeRestart = await journalBytes(f.data);
      const replay = await f.run('probe');
      assert.equal(replay.error, cleanPrefix ? null : 'RUNNER_STATE_UNAVAILABLE', JSON.stringify(replay));
      assert.equal(replay.replays, 1); assert.equal(replay.activeReads, cleanPrefix ? 1 : 0);
      assert.equal(replay.initCalls, cleanPrefix ? 1 : 0); assert.equal(replay.epochs, cleanPrefix ? 1 : 0);
      assertJournalPreserved(beforeRestart, await journalBytes(f.data), replay.error === null,
        'ordinary restart preserves every post-sync failure byte');
      if (cleanPrefix) {
        const history = await records(f.data);
        assert.deepEqual(history.slice(0, prefix.length), prefix); assert.equal(history.length, prefix.length + restart + 1);
        assert(history.every(row => row.stage === 'EPOCH'));
      } else assert.deepEqual(await journalBytes(f.data), before, 'ordinary refusal preserves the post-sync failure prefix');
    }
  });
}

for (const boundary of syncBoundaries) for (const when of ['before', 'after'] as const) {
  test(`S5-07 process crash ${when} ${boundary} is safely replayed by two fresh owners`, native, async t => {
    const f = await fixture(t), crashed = f.start('crash', {boundary, when}); await crashed.finish(86);
    const afterCrash = await journalBytes(f.data);
    assertRefused(await f.run('bootstrap'));
    assert.deepEqual(await journalBytes(f.data), afterCrash, 'bootstrap never repairs or erases an interrupted prefix');
    const cleanPrefix = boundary === 'manifest-directory-sync' || boundary === 'epoch-head-directory-sync' ||
      boundary === 'outcomes-create-directory-sync' || boundary === 'logs-create-directory-sync';
    for (let restart = 0; restart < 2; restart++) {
      const beforeRestart = await journalBytes(f.data);
      const replay = await f.run('probe');
      assert.equal(replay.error, cleanPrefix ? null : 'RUNNER_STATE_UNAVAILABLE', JSON.stringify(replay));
      if (!cleanPrefix) {assert.equal(replay.activeReads, 0); assert.equal(replay.initCalls, 0); assert.equal(replay.epochs, 0);}
      assertJournalPreserved(beforeRestart, await journalBytes(f.data), replay.error === null,
        'crash restart preserves every retained crash byte');
    }
  });
}

for (const boundary of persistenceBoundaries) {
  test(`S5-07 late physical success at ${boundary} retains ownership after the caller deadline`, native, async t => {
    const f = await fixture(t), late = f.start('late', {boundary});
    await late.reply('held'); const timedOut = await late.reply('timed-out');
    assertRefused(timedOut); assert.equal(timedOut.physical, 1); assert.equal(timedOut.diagnostics.busy, true);
    assert((timedOut.owner?.pendingOperations ?? 0) > 0);
    const result = await late.reply('result'); await late.finish();
    assertRefused(result); assert.equal(result.physical, 0); assert.equal(result.maximumPhysical, 1);
    assert.equal(result.diagnostics.busy, true, 'late durable success cannot acknowledge an expired bootstrap generation');
    const before = await journalBytes(f.data), prefix = await records(f.data);
    assertRefused(await f.run('bootstrap'));
    assert.deepEqual(await journalBytes(f.data), before, 'bootstrap preserves the settled late-I/O prefix');
    const cleanPrefix = boundary.startsWith('manifest-') || boundary.startsWith('epoch-head-') ||
      boundary === 'outcomes-create-directory-sync' || boundary === 'logs-create-directory-sync';
    for (let restart = 0; restart < 2; restart++) {
      const beforeRestart = await journalBytes(f.data);
      const replay = await f.run('probe');
      assert.equal(replay.error, cleanPrefix ? null : 'RUNNER_STATE_UNAVAILABLE', JSON.stringify(replay));
      assert.equal(replay.replays, 1); assert.equal(replay.activeReads, cleanPrefix ? 1 : 0);
      assert.equal(replay.initCalls, cleanPrefix ? 1 : 0); assert.equal(replay.epochs, cleanPrefix ? 1 : 0);
      assertJournalPreserved(beforeRestart, await journalBytes(f.data), replay.error === null,
        'ordinary restart preserves every settled late-I/O byte');
      if (cleanPrefix) {
        const history = await records(f.data);
        assert.deepEqual(history.slice(0, prefix.length), prefix); assert.equal(history.length, prefix.length + restart + 1);
        assert(history.every(row => row.stage === 'EPOCH'));
      } else assert.deepEqual(await journalBytes(f.data), before, 'ordinary refusal preserves the settled late-I/O prefix');
    }
  });
}
