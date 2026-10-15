import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import {cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {treeDigest} from '../src/shared/build-format.js';
import {planItemId} from '../src/shared/plan-item-id.js';
import {TOOL_MATRIX} from '../src/shared/tool-matrix.js';
import {runAllow} from '../src/allow.js';
import type {ApiClient, ApiRequestOptions} from '../src/api.js';
import {HelperError, readConfig} from '../src/config.js';
import {FolderDeliveryTarget, type DeliveryTarget} from '../src/delivery/index.js';
import {HoldingStore} from '../src/holding.js';
import {createPaths, ensurePaths} from '../src/paths.js';
import {atomicWriteBuild, durableRename} from '../src/safe-fs.js';
import {SyncEngine, type SyncPlan} from '../src/sync.js';
import {BuildVerifier, signedBuildString, type PlanItem, type SignedBuild} from '../src/verify.js';

async function fixture(t: {after(fn: () => void | Promise<void>): void}, readCopy = false) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-replacement-allow-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const home = join(root, 'home'); await mkdir(home, {mode: 0o700});
  const paths = await createPaths(readConfig({}, home)); await ensurePaths(paths);
  const route = readCopy ? 'claude-plugin' : 'agents-folder';
  const sourceRoot = join(home, readCopy ? '.maddots-ai/claude-code' : '.agents/skills');
  const readRoot = readCopy ? join(home, '.claude/plugins/cache/maddots-ai') : sourceRoot;
  await mkdir(sourceRoot, {recursive: true}); await mkdir(readRoot, {recursive: true});
  if (readCopy) {
    const previous = TOOL_MATRIX.routes['claude-plugin'].readPath;
    TOOL_MATRIX.routes['claude-plugin'].readPath = '~/.claude/plugins/cache/maddots-ai';
    t.after(() => {TOOL_MATRIX.routes['claude-plugin'].readPath = previous;});
  }
  const signer = generateKeyPairSync('ed25519');
  const publicKey = signer.publicKey.export({type: 'spki', format: 'der'}).subarray(-32);
  const keyId = createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
  const verifier = new BuildVerifier({keys: [{keyId, publicKey: publicKey.toString('base64')}], env: {}});
  const content = Buffer.from('# Code skill\n! printf original\n');
  const build: SignedBuild = {format: 1, keyId, skillId: 'skill-replacement', version: 1, settingsRevision: 0,
    level: 'workspace', workspaceId: 'workspace-test', boardId: null, target: readCopy ? 'claude-plugin' : 'folder',
    name: 'example', hasCode: true, draft: false, signature: '', digest: treeDigest([{path: 'SKILL.md', mode: '100644', content}]),
    report: {renamedFrom: null, unresolvedOptionalReferences: [], unsetSettings: []},
    files: [{path: 'SKILL.md', mode: '100644', size: content.length,
      sha256: createHash('sha256').update(content).digest('hex'), content: content.toString('base64')}]};
  build.signature = sign(null, Buffer.from(signedBuildString(build)), signer.privateKey).toString('base64');
  const item: PlanItem = {itemId: '1'.repeat(64), kind: 'install', skillId: build.skillId, name: build.name,
    sourceName: build.name, level: build.level, workspaceId: build.workspaceId, workspaceIds: [build.workspaceId],
    boardIds: [], target: build.target, route, fromVersion: null, version: 1, settingsRevision: 0, digest: build.digest,
    hasCode: true, draft: false, dependencyOf: null, missingDependencies: [], forAgentIds: [],
    state: 'approved', answer: 'update', reason: null, restartHints: []};
  const makePlan = (value: PlanItem): SyncPlan => ({planRevision: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    degraded: false, pollAfterSeconds: 60, items: [value], revoked: [], instructions: []});
  let current = makePlan(item), now = Date.parse('2026-10-15T12:00:00Z'), refreshes = 0;
  const reports: {holdingCount: number; reports: {allowedAt: string; tools: string[]}[]}[] = [];
  const planHeaders: (string | null)[] = [];
  const client = {request: async (path: string, options?: ApiRequestOptions) => {
    let data: unknown;
    if (path === '/api/helper/plan') {
      const revision = new Headers(options?.headers).get('If-None-Match'); planHeaders.push(revision);
      if (revision === current.planRevision) return {data: undefined, status: 304, headers: new Headers()};
      data = structuredClone(current);
    }
    else if (path.startsWith('/api/helper/builds/')) data = build;
    else if (path === '/api/helper/allow') {reports.push(structuredClone(options!.body) as typeof reports[number]); data = {ok: true};}
    else if (path === '/api/helper/inventory') data = {ok: true};
    else throw new Error('Unexpected route: ' + path);
    return {data, status: 200, headers: new Headers()};
  }} as Pick<ApiClient, 'request'>;
  const target: DeliveryTarget = readCopy ? {route, target: 'claude-plugin', root: () => sourceRoot,
    folderFor: entry => join(sourceRoot, entry.name), place: async (value, staged) => durableRename(staged, join(sourceRoot, value.name)),
    remove: async () => {}, refreshReadCopy: async () => {refreshes++;}} : new FolderDeliveryTarget(paths, route, sourceRoot);
  const options = {paths, helperId: 'helper-replacement', client, verifier, targets: [target],
    timing: {now: () => now, sleep: async (ms: number) => {now += ms;}}, watchRoute: () => ({close() {}})};
  const engine = new SyncEngine(options); t.after(() => engine.close()); await engine.reconcile();
  let prompts = 0;
  const allow = (answer = 'yes', instance = engine) => runAllow(instance, client, {isTTY: true, output() {},
    confirm: async () => {prompts++; return answer;}});
  async function replacement() {
    if (readCopy) await cp(join(sourceRoot, build.name), join(readRoot, build.name), {recursive: true});
    await writeFile(join(readRoot, build.name, 'SKILL.md'), 'Local edited command\n');
    const localDigest = (await engine.inventory()).managed[0].localDigest!;
    const choice = {...item, kind: 'local_newer' as const, answer: 'replace' as const, fromVersion: 1};
    choice.itemId = planItemId({helperId: options.helperId, ...choice, agentId: null, localDigest});
    current = makePlan(choice); now += 1000; return {choice, plan: current};
  }
  return {root, paths, sourceRoot, readRoot, build, item, engine, options, client, reports, planHeaders, allow, replacement,
    plan: () => current, prompts: () => prompts, refreshes: () => refreshes};
}

test('an earlier envelope Allow cannot release Replace until its exact choice is confirmed locally', async t => {
  const f = await fixture(t);
  await f.engine.applyPlan(f.plan()); await f.allow();
  assert.equal(await f.engine.holding.isAllowed(f.build), true); assert.equal(f.reports.length, 1);
  const {choice, plan} = await f.replacement();
  await f.engine.applyPlan(plan); await f.engine.applyPlan(plan);
  assert.equal(await f.engine.holding.count(), 1);
  assert.equal(await f.engine.holding.isReplacementAllowed(f.build, choice), false);
  assert.equal(await f.allow('no'), 0); assert.equal(await f.engine.holding.count(), 1);
  const held = (await f.engine.holding.entries())[0];
  assert.equal(await f.allow(), 1);
  assert.equal(await f.engine.holding.count(), 0);
  assert.equal(await f.engine.holding.isReplacementAllowed(f.build, choice), true);
  assert.equal(await f.engine.holding.isReplacementAllowed(f.build, {...choice, boardIds: ['board-other']}), false);
  assert.equal(await new HoldingStore(f.paths, 'another-helper', f.engine.verifier).isReplacementAllowed(f.build, choice), false);
  assert.equal(await readFile(join(f.sourceRoot, 'example/SKILL.md'), 'utf8'), '# Code skill\n! printf original\n');
  assert.equal(f.reports.length, 2); assert.notEqual(f.reports[0].reports[0].allowedAt, f.reports[1].reports[0].allowedAt);
  assert.equal(f.reports[1].holdingCount, 0);
  await f.engine.holding.approve(held, ['Different tool']);
  await f.engine.holding.flushReports(f.client);
  assert.equal(f.reports.length, 2, 'replaying the same confirmation must not duplicate its audit report');
  await f.engine.applyPlan(plan);
  assert.equal(f.prompts(), 3); assert.equal(await f.engine.holding.count(), 0);
});

test('a placed code Replace retries its read copy using the accepted allowance after restart', async t => {
  const f = await fixture(t, true);
  await f.engine.applyPlan(f.plan()); await f.allow();
  const {choice, plan} = await f.replacement();
  await f.engine.applyPlan(plan);
  assert.equal(await f.engine.holding.count(), 1);
  await f.allow();
  const receiptFile = join(f.paths.data, 'local-choices', choice.itemId + '.replace.json');
  assert.equal(JSON.parse(await readFile(receiptFile, 'utf8')).placed, true);
  assert.notEqual(JSON.parse(await readFile(receiptFile, 'utf8')).completed, true);
  assert.equal(await f.engine.holding.count(), 0); assert.deepEqual(await f.engine.locks.allPending(), []);
  const restarted = new SyncEngine(f.options); t.after(() => restarted.close()); await restarted.reconcile();
  restarted.holding.isReplacementAllowed = async () => {throw new Error('Placed retry must reuse its lock allowance');};
  for (let retry = 0; retry < 3; retry++) await restarted.applyPlan(plan);
  assert.equal(await restarted.holding.count(), 0); assert.equal(f.prompts(), 2);
  assert.ok(f.refreshes() >= 4); assert.deepEqual((await restarted.inventory()).deliveryErrors, []);
  assert.deepEqual(await restarted.locks.allPending(), []);
  await cp(join(f.sourceRoot, 'example'), join(f.readRoot, 'example'), {recursive: true});
  await restarted.applyPlan(plan);
  assert.equal(JSON.parse(await readFile(receiptFile, 'utf8')).completed, true);
  assert.equal((await restarted.inventory()).managed[0].state, 'ok'); assert.equal(f.reports.length, 2);
});

test('a placed Replace keeps its plan pollable when its read-copy adapter temporarily fails', async t => {
  const f = await fixture(t, true);
  await f.engine.applyPlan(f.plan()); await f.allow();
  const metaFile = join(f.paths.data, 'sync-meta.json');
  const {choice, plan} = await f.replacement();
  await f.engine.applyPlan(plan); await f.allow();
  const priorRevision = JSON.parse(await readFile(metaFile, 'utf8')).planRevision;
  const retryPlan = {...plan, planRevision: createHash('sha256').update(plan.planRevision + ':placed').digest('hex')};
  const receiptFile = join(f.paths.data, 'local-choices', choice.itemId + '.replace.json');
  const receipt = JSON.parse(await readFile(receiptFile, 'utf8'));
  assert.equal(receipt.placed, true); assert.match(receipt.readDigest, /^[a-f0-9]{64}$/u);
  assert.notEqual(receipt.completed, true); assert.notEqual(priorRevision, retryPlan.planRevision);
  assert.deepEqual(await f.engine.locks.allPending(), []);
  const target = f.options.targets[0];
  target.readFolderFor = async () => {throw new HelperError('CLAUDE_PLUGIN_WAITING', 'Injected temporary registration failure');};
  await assert.doesNotReject(f.engine.applyPlan(retryPlan));
  assert.equal(JSON.parse(await readFile(metaFile, 'utf8')).planRevision, priorRevision);
  assert.deepEqual(await f.engine.locks.allPending(), []);
  assert.notEqual(JSON.parse(await readFile(receiptFile, 'utf8')).completed, true);
  assert.equal((await f.engine.inventory()).deliveryErrors[0].code, 'CLAUDE_PLUGIN_WAITING');
  // An earlier holding pass may already have acknowledged this same revision.
  // Recreate that durable state, then restart before its read-copy retry.
  const meta = JSON.parse(await readFile(metaFile, 'utf8'));
  await atomicWriteBuild(metaFile, JSON.stringify({...meta, planRevision: retryPlan.planRevision}) + '\n');
  const restarted = new SyncEngine(f.options); t.after(() => restarted.close()); await restarted.reconcile();
  await assert.doesNotReject(restarted.applyPlan(retryPlan));
  assert.equal(JSON.parse(await readFile(metaFile, 'utf8')).planRevision, null);
  assert.deepEqual(await restarted.locks.allPending(), []);
  assert.notEqual(JSON.parse(await readFile(receiptFile, 'utf8')).completed, true);
  assert.equal((await restarted.inventory()).deliveryErrors[0].code, 'CLAUDE_PLUGIN_WAITING');
  target.readFolderFor = entry => join(f.readRoot, entry.name);
  await cp(join(f.sourceRoot, 'example'), join(f.readRoot, 'example'), {recursive: true});
  await restarted.applyPlan(retryPlan);
  assert.equal(JSON.parse(await readFile(receiptFile, 'utf8')).completed, true);
  assert.equal(JSON.parse(await readFile(metaFile, 'utf8')).planRevision, retryPlan.planRevision);
  assert.deepEqual(await restarted.locks.allPending(), []);
  assert.deepEqual((await restarted.inventory()).deliveryErrors, []);
});

test('the running service observes a separate Allow CLI clearing its remembered Replace revision', async t => {
  const f = await fixture(t, true), service = f.engine;
  await service.applyPlan(f.plan()); await f.allow();
  const {choice, plan} = await f.replacement();
  await service.applyPlan(plan);
  const metaFile = join(f.paths.data, 'sync-meta.json');
  assert.equal(JSON.parse(await readFile(metaFile, 'utf8')).planRevision, plan.planRevision);
  assert.equal(await service.holding.count(), 1);
  const cli = new SyncEngine(f.options); t.after(() => cli.close()); await cli.reconcile();
  assert.equal(await f.allow('yes', cli), 1);
  const receiptFile = join(f.paths.data, 'local-choices', choice.itemId + '.replace.json');
  const receipt = JSON.parse(await readFile(receiptFile, 'utf8'));
  assert.equal(receipt.placed, true); assert.notEqual(receipt.completed, true);
  assert.equal(JSON.parse(await readFile(metaFile, 'utf8')).planRevision, null);
  const requestsBefore = f.planHeaders.length, refreshesBefore = f.refreshes();
  await service.tick();
  assert.deepEqual(f.planHeaders.slice(requestsBefore), [null], 'the service must discard its stale in-memory ETag');
  assert.equal(f.refreshes(), refreshesBefore + 1, 'a full plan must resume the pending read-copy refresh');
  assert.deepEqual(await service.locks.allPending(), []);
  assert.equal(JSON.parse(await readFile(metaFile, 'utf8')).planRevision, null);
  assert.notEqual(JSON.parse(await readFile(receiptFile, 'utf8')).completed, true);
  await cp(join(f.sourceRoot, 'example'), join(f.readRoot, 'example'), {recursive: true});
  await f.options.timing.sleep(60_000); await service.tick();
  assert.equal(JSON.parse(await readFile(receiptFile, 'utf8')).completed, true);
  assert.equal(JSON.parse(await readFile(metaFile, 'utf8')).planRevision, plan.planRevision);
  assert.deepEqual((await service.inventory()).deliveryErrors, []);
});

test('replacement consent receipt keys are bounded, unique hashes and legacy receipts remain valid', async t => {
  const f = await fixture(t); await f.engine.applyPlan(f.plan()); await f.allow();
  const files = await readdir(join(f.paths.data, 'allows'));
  const path = join(f.paths.data, 'allows', files[0]), legacy = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(legacy.replacementContexts, undefined); assert.equal(await f.engine.holding.isAllowed(f.build), true);
  for (const replacementContexts of [['invalid'], ['1'.repeat(64), '1'.repeat(64)], Array.from({length: 2001}, (_, i) => i.toString(16).padStart(64, '0'))]) {
    await atomicWriteBuild(path, JSON.stringify({...legacy, replacementContexts}) + '\n');
    await assert.rejects(f.engine.holding.isAllowed(f.build), {code: 'ALLOW_INVALID'});
  }
  await atomicWriteBuild(path, JSON.stringify(legacy) + '\n');
  assert.equal(await f.engine.holding.isAllowed(f.build), true);
});
