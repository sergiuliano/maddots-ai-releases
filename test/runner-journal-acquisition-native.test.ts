import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, readdir, realpath, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test, {type TestContext} from 'node:test';
import {initializeCleanRunnerJournal} from './support/runner-journal-fixture.js';

// Native local-filesystem command; run on gate-linux's intended fixture volume
// for qualification: TMPDIR=<fixture-root> node --import tsx --import
// ./helper/test/support/runner-signal-runtime-guard.ts
// helper/test/runner-journal-acquisition-native.test.ts
const worker = fileURLToPath(new URL('./fixtures/runner-journal-acquisition.ts', import.meta.url));
type Reply = {kind: string; data?: string; error?: string | null; busy?: boolean; replays?: number; journalReads?: number;
  activeReads?: number; epochs?: number; maximumPhysical?: number; physical?: number; runId?: string;
  obligations?: {runId: string; stage: string}[]};
function controller(mode: string, data: string, observe: (reply: Reply) => void = () => {}) {
  const environment = {...process.env}; delete environment.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['--import', 'tsx', worker, mode, data], {env: environment, stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
  const messages: Reply[] = [], waiters = new Map<string, (reply: Reply) => void>();
  let stderr = '', exitCode: number | null = null;
  child.stderr!.on('data', chunk => {stderr += String(chunk);});
  child.on('message', (reply: Reply) => {messages.push(reply); observe(reply); waiters.get(reply.kind)?.(reply);});
  const exited = new Promise<void>(resolve => {child.once('exit', code => {exitCode = code; resolve();});});
  const reply = async (kind: string): Promise<Reply> => {
    const existing = messages.find(message => message.kind === kind); if (existing) return existing;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([new Promise<Reply>(resolve => {waiters.set(kind, resolve);}),
        exited.then(() => {throw new Error(`Fixture exited before ${kind}: ${JSON.stringify(messages)} ${stderr}`);}),
        new Promise<Reply>((_resolve, reject) => {timer = setTimeout(() => reject(new Error(`Fixture timed out before ${kind}.`)), 8000);})]);
    } finally {if (timer) clearTimeout(timer); waiters.delete(kind);}
  };
  return {reply, release: () => {if (child.connected) child.send('release');},
    finish: async () => {await exited; assert.equal(exitCode, 0, stderr);}};
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-journal-acquisition-'));
  const children: ReturnType<typeof controller>[] = [];
  t.after(async () => {
    for (const child of children) child.release();
    await Promise.allSettled(children.map(child => child.finish()));
    await rm(root, {recursive: true, force: true});
  });
  const data = join(root, 'data'); await initializeCleanRunnerJournal(data);
  return {root, data, start: (mode: string, path: string, observe?: (reply: Reply) => void) => {
    const child = controller(mode, path, observe); children.push(child); return child;
  }};
}
async function records(data: string) {
  const names = (await readdir(join(data, 'runner'))).filter(name => /^journal-\d{10}\.json$/u.test(name)).sort();
  return Promise.all(names.map(async name => JSON.parse(await readFile(join(data, 'runner', name), 'utf8')).payload));
}

test('S2 native acquisition excludes same and aliased processes before replay, then permits a durable clean handoff', {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const {root, data, start} = await fixture(t), distinct = join(root, 'distinct'), alias = join(root, 'alias');
  await initializeCleanRunnerJournal(distinct); await symlink(data, alias);
  const publishing = new Map<string, number>(), maximum = new Map<string, number>();
  const observe = (reply: Reply) => {
    if (!['publication-start', 'publication-end'].includes(reply.kind)) return;
    const count = (publishing.get(reply.data!) ?? 0) + (reply.kind === 'publication-start' ? 1 : -1);
    publishing.set(reply.data!, count); maximum.set(reply.data!, Math.max(maximum.get(reply.data!) ?? 0, count));
  };
  const first = start('hold-epoch', data, observe);
  assert.equal((await first.reply('held')).physical, 1);
  const same = start('probe', data, observe), aliased = start('probe', alias, observe);
  const independent = start('probe', distinct, observe);
  const [sameResult, aliasResult, independentResult] = await Promise.all([same.reply('result'), aliased.reply('result'), independent.reply('result')]);
  for (const refused of [sameResult, aliasResult]) {
    assert.equal(refused.error, 'RUNNER_STATE_UNAVAILABLE'); assert.equal(refused.busy, true);
    assert.equal(refused.replays, 0); assert.equal(refused.journalReads, 0); assert.equal(refused.activeReads, 0);
    assert.equal(refused.epochs, 0); assert.equal(refused.maximumPhysical, 0);
  }
  assert.equal(independentResult.error, null); assert.equal(independentResult.busy, false);
  assert.equal(independentResult.replays, 1); assert.equal(independentResult.epochs, 1); assert.equal(independentResult.activeReads, 1);
  assert.equal(publishing.get(data), 1, 'the predecessor still owns the sole physical acknowledgment');
  await Promise.all([same.finish(), aliased.finish(), independent.finish()]);
  first.release();
  const firstResult = await first.reply('result'); assert.equal(firstResult.error, null); assert.equal(firstResult.busy, false);
  const closed = await first.reply('closed');
  assert.equal(closed.physical, 0); assert.equal(closed.busy, false); await first.finish();
  const successor = start('probe', alias, observe), successorResult = await successor.reply('result');
  assert.equal(successorResult.error, null); assert.equal(successorResult.busy, false);
  assert.equal(successorResult.replays, 1); assert.equal(successorResult.epochs, 1); assert.equal(successorResult.activeReads, 1);
  await successor.finish();
  assert.equal(maximum.get(data), 1); assert.equal(publishing.get(data), 0);
  const history = await records(data);
  assert.deepEqual(history.map(row => ({sequence: row.sequence, stage: row.stage})), [{sequence: 1, stage: 'EPOCH'}, {sequence: 2, stage: 'EPOCH'}]);
  assert.notEqual(history[0].ownerEpoch, history[1].ownerEpoch);
  assert.deepEqual((await records(distinct)).map(row => row.sequence), [1]);
  t.diagnostic(JSON.stringify({same: sameResult, alias: aliasResult, distinct: independentResult, successor: successorResult,
    maximumPhysical: maximum.get(data), sequences: history.map(row => row.sequence)}));
});

test('S2 native acquisition after predecessor exit retains durable INTENT and refuses before loading the old projection', {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async t => {
  const {data, start} = await fixture(t), predecessor = start('intent', data);
  const written = await predecessor.reply('result');
  assert.equal(written.error, null); assert.equal(written.busy, true); assert(written.runId);
  await predecessor.finish();
  const fresh = start('probe', data), replayed = await fresh.reply('result'); await fresh.finish();
  assert.equal(replayed.error, 'RUNNER_STATE_UNAVAILABLE'); assert.equal(replayed.busy, true);
  assert.equal(replayed.replays, 1); assert.equal(replayed.activeReads, 0); assert.equal(replayed.epochs, 0);
  assert.equal(replayed.maximumPhysical, 0); assert((replayed.journalReads ?? 0) >= 4);
  assert.deepEqual(replayed.obligations, [{runId: written.runId, stage: 'INTENT'}]);
  assert.deepEqual((await records(data)).map(row => ({sequence: row.sequence, stage: row.stage})), [{sequence: 1, stage: 'EPOCH'}, {sequence: 2, stage: 'INTENT'}]);
  t.diagnostic(JSON.stringify({predecessorExited: true, written, replayed}));
});
