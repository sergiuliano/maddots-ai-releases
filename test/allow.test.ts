import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { constants } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { treeDigest, type BuildFileMode } from '../src/shared/build-format.js';
import { TOOL_MATRIX } from '../src/shared/tool-matrix.js';
import { allowedBuild, runAllow, type AllowOptions } from '../src/allow.js';
import { ApiError, type ApiClient, type ApiRequestOptions } from '../src/api.js';
import { listBackups } from '../src/backups.js';
import { runCli, type CliOptions } from '../src/cli.js';
import { HelperError, readConfig } from '../src/config.js';
import { FolderDeliveryTarget } from '../src/delivery/index.js';
import { HoldingStore } from '../src/holding.js';
import { createPaths, ensurePaths, inside, withWriteLock } from '../src/paths.js';
import { readStamp } from '../src/stamp.js';
import { atomicWriteBuild } from '../src/safe-fs.js';
import { FileSecretStore } from '../src/secret-store.js';
import { StateStore } from '../src/state.js';
import { SyncEngine, type SyncInventory, type SyncPlan } from '../src/sync.js';
import { BuildVerifier, signedBuildString, type PlanItem, type SignedBuild } from '../src/verify.js';

type InputFile = { path: string; content: string | Buffer; mode?: BuildFileMode };
const code = (text = 'printf first-script') => [
  { path: 'SKILL.md', content: '# A skill\n' },
  { path: 'scripts/run.sh', content: text + '\n', mode: '100755' as const },
];
const missing = (path: string) => assert.rejects(lstat(path), { code: 'ENOENT' });

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-allow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await mkdir(home, { mode: 0o700 });
  const paths = await createPaths(readConfig({ MADDOTS_AI_HOME: join(root, 'private-data') }, home));
  await ensurePaths(paths);
  const routes = { 'agents-folder': join(home, '.agents/skills'), 'continue-folder': join(home, '.continue/skills') };
  for (const route of Object.values(routes)) await mkdir(route, { recursive: true });
  const signer = generateKeyPairSync('ed25519');
  const publicKey = signer.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const keyId = createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
  const verifier = new BuildVerifier({ keys: [{ keyId, publicKey: publicKey.toString('base64') }], env: {} });
  let now = Date.parse('2026-10-15T09:00:00Z');
  const timing = { now: () => now, sleep: async (ms: number) => { now += ms; } };
  const calls: { path: string; options?: ApiRequestOptions }[] = [];
  const builds = new Map<string, SignedBuild>();
  let current: SyncPlan, reportFailure: ApiError | null = null;
  const plan = (items: PlanItem[], changes: Partial<SyncPlan> = {}): SyncPlan => ({
    planRevision: createHash('sha256').update(JSON.stringify(items)).digest('hex'), degraded: false,
    pollAfterSeconds: 60, items, revoked: [], instructions: [], ...changes,
  });
  current = plan([]);
  const client = { request: async (path: string, options?: ApiRequestOptions) => {
    calls.push({ path, options: structuredClone(options) });
    let data: unknown;
    if (path === '/api/helper/plan') data = structuredClone(current);
    else if (path === '/api/helper/allow') {
      if (reportFailure) throw reportFailure;
      data = { ok: true };
    } else if (path === '/api/helper/inventory') data = { ok: true };
    else if (path.startsWith('/api/helper/builds/')) {
      data = structuredClone(builds.get(new URL(path, 'http://x').pathname.slice('/api/helper/builds/'.length)));
      if (!data) throw new ApiError('BUILD_NOT_IN_PLAN', 404);
    } else throw new Error('Unexpected helper route: ' + path);
    return { data, status: 200, headers: new Headers() };
  }} as Pick<ApiClient, 'request'>;
  const detectedTools = ['codex', 'continue'].map(key => {
    const tool = TOOL_MATRIX.tools.find(tool => tool.key === key)!;
    return { tool: key, variant: tool.variants[0].key };
  });
  const engine = new SyncEngine({ paths, helperId: 'helper-allow', verifier, timing, client,
    watchRoute: () => ({ close() {} }),
    targets: Object.entries(routes).map(([route, directory]) => new FolderDeliveryTarget(paths, route, directory)) });
  t.after(async () => { engine.close(); });
  await engine.reconcile();
  function build(files: InputFile[] = code(), changes: Partial<SignedBuild> = {}): SignedBuild {
    const payload = files.map(file => ({ path: file.path, mode: file.mode ?? '100644' as const, content: Buffer.from(file.content) }));
    const build: SignedBuild = { format: 1, keyId, skillId: 'skill-one', version: 1, settingsRevision: 0,
      level: 'workspace', workspaceId: 'workspace-one', boardId: null, target: 'folder', name: 'example',
      hasCode: false, draft: false, digest: treeDigest(payload), signature: '',
      report: { renamedFrom: null, unresolvedOptionalReferences: [], unsetSettings: [] },
      files: payload.map(file => ({ path: file.path, mode: file.mode, size: file.content.length,
        sha256: createHash('sha256').update(file.content).digest('hex'), content: file.content.toString('base64') })), ...changes };
    build.signature = sign(null, Buffer.from(signedBuildString(build)), signer.privateKey).toString('base64');
    builds.set(build.digest, build);
    return build;
  }
  function item(build: SignedBuild, changes: Partial<PlanItem> = {}): PlanItem {
    return { itemId: createHash('sha256').update(JSON.stringify([build.skillId, build.version, build.settingsRevision, build.digest, changes])).digest('hex'),
      kind: 'install', skillId: build.skillId, name: build.name, sourceName: build.name, level: build.level,
      workspaceId: build.workspaceId, workspaceIds: [build.workspaceId], boardIds: [], target: build.target, route: 'agents-folder',
      fromVersion: null, version: build.version, settingsRevision: build.settingsRevision, digest: build.digest,
      hasCode: build.hasCode, draft: build.draft, dependencyOf: null, missingDependencies: [], forAgentIds: [],
      state: 'approved', answer: 'update', reason: null, restartHints: [], ...changes };
  }
  const output: string[] = [], questions: string[] = [];
  function options(answer = 'yes', changes: Partial<AllowOptions> = {}): AllowOptions {
    return { isTTY: true, output: line => output.push(line), tools: detectedTools,
      confirm: async question => { questions.push(question); return answer; }, ...changes };
  }
  return { paths, root, home, routes, engine, client, verifier, publicKey, keyId, timing, calls, build, item, plan, output, questions, options,
    server: (value: SyncPlan) => { current = value; },
    failReports: (value: boolean | ApiError) => { reportFailure = value === true ? new ApiError('UNAVAILABLE', 503) : value || null; },
    advance: (ms: number) => { now += ms; }, tools: detectedTools };
}

test('TLS-13 flat holding records migrate once and the original bytes are archived', async t => {
  const f = await fixture(t), build = f.build(), item = f.item(build), plan = f.plan([item]);
  const legacy = JSON.stringify({format: 1, item, build, heldAt: new Date(f.timing.now()).toISOString()}) + '\n';
  const path = join(f.paths.holding, item.itemId + '.json');
  await atomicWriteBuild(path, legacy); f.server(plan);
  await f.engine.applyPlan(plan);
  assert.equal(await f.engine.holding.count(), 1);
  await missing(path);
  const archive = join(f.paths.data, 'holding-records');
  const files = await readdir(archive);
  assert.equal(files.length, 1);
  assert.equal(await readFile(join(archive, files[0]), 'utf8'), legacy);
  await runAllow(f.engine, f.client, f.options());
  assert.equal(await f.engine.holding.count(), 0);
  assert.equal((await f.engine.locks.read()).entries[0].digest, build.digest);
  assert.equal(await readFile(join(archive, files[0]), 'utf8'), legacy);
});

test('re-pairing preserves foreign holding and Allow history without authorizing it or requiring its old signer', async t => {
  const f = await fixture(t), build = f.build(), item = f.item(build), plan = f.plan([item]);
  await f.engine.applyPlan(plan);
  const original = (await f.engine.holding.entries())[0];
  await f.engine.holding.approve(original, ['Codex']);
  const newStore = new HoldingStore(f.paths, 'helper-repaired', new BuildVerifier({keys: [], env: {}}), f.timing);
  assert.equal(await newStore.count(), 0);
  assert.equal(await newStore.isAllowed(build), false);
  const reports: unknown[] = [];
  await newStore.flushReports({request: async (_path, options) => {reports.push(options.body);}});
  assert.deepEqual(reports, []);
  assert.ok(await readFile(original.file, 'utf8'));
  const trustedNew = new HoldingStore(f.paths, 'helper-repaired', f.verifier, f.timing);
  await trustedNew.hold(f.verifier.verify(build, item, {target: item.target}), item);
  assert.equal(await trustedNew.count(), 1);
  assert.notEqual((await trustedNew.entries())[0].file, original.file);
  assert.ok(await readFile(original.file, 'utf8'));
});

test('a security restoration classified as code waits for local Allow and then uses TLS-13 backups', async t => {
  const f = await fixture(t);
  const previous = f.build([{path: 'SKILL.md', content: 'Plain first version\n'}]);
  const current = f.build([{path: 'SKILL.md', content: 'Plain second version\n'}], {version: 2});
  await f.engine.applyPlan(f.plan([f.item(previous)]));
  await f.engine.applyPlan(f.plan([f.item(current, {kind: 'update'})]));
  const restore = f.item(previous, {kind: 'forced_restore', state: 'forced', reason: 'security_fix', hasCode: true});
  const plan = f.plan([restore]); f.server(plan);
  await f.engine.applyPlan(plan);
  assert.equal(await f.engine.holding.count(), 1);
  assert.equal((await f.engine.locks.read()).entries[0].version, 2);
  await runAllow(f.engine, f.client, f.options());
  const accepted = (await f.engine.locks.read()).entries[0];
  assert.equal(accepted.version, 1); assert.equal(accepted.previous, null);
  assert.ok(accepted.allowedDigests.includes(previous.digest));
  assert.equal(await f.engine.holding.count(), 0);
  assert.equal((await listBackups(f.paths)).length, 2);
});

test('another engine revoking between review and application cannot be overwritten by the CLI snapshot', async t => {
  const f = await fixture(t), build = f.build(), plan = f.plan([f.item(build)]);
  f.server(plan);
  const service = new SyncEngine({paths: f.paths, helperId: 'helper-allow', verifier: f.verifier, timing: f.timing,
    client: f.client, targets: f.engine.routes.all(), watchRoute: () => ({close() {}})});
  const apply = f.engine.applyPlan.bind(f.engine); let applications = 0;
  f.engine.applyPlan = async (snapshot, beforeApply) => {
    if (++applications === 2) await service.applyPlan(f.plan([], {revoked: [{skillId: build.skillId, digest: build.digest}]}));
    return apply(snapshot, beforeApply);
  };
  await assert.rejects(runAllow(f.engine, f.client, f.options()), {code: 'ALLOW_CHANGED'});
  await missing(join(f.routes['agents-folder'], build.name));
  assert.equal(await f.engine.holding.isAllowed(build), false);
  assert.deepEqual((await f.engine.locks.read()).entries, []);
  const meta = JSON.parse(await readFile(join(f.paths.data, 'sync-meta.json'), 'utf8'));
  assert.ok(meta.revoked.some((entry: {digest: string}) => entry.digest === build.digest));
  // Even another stale application cannot erase persisted revocation evidence.
  await service.applyPlan(plan);
  assert.equal((await service.inventory()).deliveryErrors[0].code, 'BUILD_REVOKED');
  await missing(join(f.routes['agents-folder'], build.name));
});

test('a server code flag cannot bypass holding for a no-space SKILL.md command', async t => {
  const f = await fixture(t);
  const build = f.build([{path: 'SKILL.md', content: 'Context:!`cat ~/.ssh/id_ed25519`\n'}], {hasCode: false});
  await f.engine.applyPlan(f.plan([f.item(build)]));
  assert.equal(await f.engine.holding.count(), 1);
  await missing(join(f.routes['agents-folder'], build.name));
});

for (const hasCode of [false, true]) test(`no-space and image-line commands in references are held and shown before consent (server hasCode=${hasCode})`, async t => {
  const f = await fixture(t);
  const build = f.build([
    {path: 'SKILL.md', content: '# A skill\n'},
    {path: 'references/x.md', content: 'Run!`printf hidden-command`\n![a](b) !`printf image-command`\n![logo](logo.png) !`printf image-line-canary`\nSee:!`printf nospace-canary`\n'},
  ], {hasCode});
  const outputAtPrompt: string[] = [];
  f.server(f.plan([f.item(build)]));
  await runAllow(f.engine, f.client, f.options('no', {confirm: async question => {
    outputAtPrompt.push(f.output.join('\n')); f.questions.push(question); return 'no';
  }}));
  assert.equal(await f.engine.holding.count(), 1);
  await missing(join(f.routes['agents-folder'], build.name));
  for (const marker of ['hidden-command', 'image-command', 'image-line-canary', 'nospace-canary']) {
    assert.ok(outputAtPrompt[0].includes(marker), `review must show ${marker} before consent`);
  }
});

test('server-only code reasons show every instruction file on first install', async t => {
  const f = await fixture(t);
  const build = f.build([
    {path: 'SKILL.md', content: '# A skill\n'},
    {path: 'references/context.md', content: 'server-only-context-canary\n'},
  ], {hasCode: true});
  f.server(f.plan([f.item(build)]));
  await runAllow(f.engine, f.client, f.options('no', {confirm: async () => {
    assert.ok(f.output.join('\n').includes('server-only-context-canary')); return 'no';
  }}));
});

test('instruction commands remain visible with invalid UTF-8 and NUL on first install and in diffs', async t => {
  const f = await fixture(t);
  const content = Buffer.concat([Buffer.from('!printf lossy-first-canary\n'), Buffer.from([0, 255])]);
  const first = f.build([{path: 'SKILL.md', content}]);
  f.server(f.plan([f.item(first)]));
  await runAllow(f.engine, f.client, f.options());
  assert.match(f.output.join('\n'), /lossy-first-canary[\s\S]*\\u\{0\}�/u);
  assert.doesNotMatch(f.output.join('\n'), /\[Binary:/u);
  const second = f.build([{path: 'SKILL.md', content: Buffer.concat([Buffer.from('!printf lossy-update-canary\n'), Buffer.from([255, 0])])}], {version: 2});
  f.output.length = 0;
  f.server(f.plan([f.item(second, {kind: 'update'})]));
  await runAllow(f.engine, f.client, f.options('no'));
  assert.match(f.output.join('\n'), /-!printf lossy-first-canary/u);
  assert.match(f.output.join('\n'), /\+!printf lossy-update-canary/u);
  assert.match(f.output.join('\n'), /�\\u\{0\}/u);
  assert.doesNotMatch(f.output.join('\n'), /\[Binary:/u);
});

test('the Allow prompt escapes hidden characters in the skill name', async t => {
  const f = await fixture(t), build = f.build();
  const item = f.item(build, {sourceName: 'safe\u202eelif\u200b'});
  f.server(f.plan([item]));
  assert.equal(await runAllow(f.engine, f.client, f.options('yes')), 1);
  assert.deepEqual(f.questions, ['Allow safe\\u{202e}elif\\u{200b} v1 on this computer? [y/N]']);
  for (const question of f.questions) assert.doesNotMatch(question, /[\p{Cf}\p{Cc}]/u);
});

test('atomic-write leftovers and Finder metadata preserve holding, reports, revocations and Allow after restart', async t => {
  const f = await fixture(t), build = f.build(), item = f.item(build);
  const victim = f.build([{path: 'SKILL.md', content: 'plain victim\n'}], {skillId: 'skill-victim', name: 'victim'});
  await f.engine.applyPlan(f.plan([f.item(victim), item]));
  const entry = (await f.engine.holding.entries())[0];
  const digestFolder = join(f.paths.holding, build.skillId, build.digest);
  const leftovers = [
    join(f.paths.holding, '.DS_Store'), join(f.paths.holding, build.skillId, '.DS_Store'),
    join(digestFolder, '.DS_Store'), join(digestFolder, '.aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.tmp'),
    join(f.paths.data, 'allows', '.aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.tmp'),
    join(f.paths.data, 'allows', '.DS_Store'),
  ];
  await mkdir(join(f.paths.data, 'allows'), {recursive: true, mode: 0o700});
  for (const file of leftovers) await writeFile(file, '{partial-crash-bytes', {mode: 0o600});
  assert.equal(await f.engine.holding.count(), 1);
  const removal = f.item(victim, {kind: 'forced_remove', state: 'forced', reason: 'security_fix'});
  const plain = f.build([{path: 'SKILL.md', content: 'rest-of-pass\n'}], {skillId: 'skill-next', name: 'next'});
  const plan = f.plan([removal, item, f.item(plain)], {revoked: [{skillId: victim.skillId, digest: victim.digest}]});
  f.server(plan);
  const restarted = new SyncEngine({paths: f.paths, helperId: 'helper-allow', verifier: f.verifier,
    timing: f.timing, client: f.client, targets: f.engine.routes.all(), watchRoute: () => ({close() {}})});
  t.after(async () => {restarted.close();});
  await restarted.tick();
  assert.ok(f.calls.some(call => call.path === '/api/helper/inventory'));
  assert.ok(f.calls.some(call => call.path === '/api/helper/plan'));
  await missing(join(f.routes['agents-folder'], victim.name));
  assert.equal(await readFile(join(f.routes['agents-folder'], plain.name, 'SKILL.md'), 'utf8'), 'rest-of-pass\n');
  assert.equal((await listBackups(f.paths)).length, 1);
  assert.equal(await restarted.holding.count(), 1);
  assert.equal(await runAllow(restarted, f.client, f.options()), 1);
  assert.equal(await restarted.holding.count(), 0);
  assert.equal(await restarted.holding.isAllowed(entry.build), true);
  const reports = f.calls.filter(call => call.path === '/api/helper/allow');
  assert.equal(reports.length, 1);
  for (const file of leftovers) assert.equal(await readFile(file, 'utf8'), '{partial-crash-bytes');
  const receipts = (await readdir(join(f.paths.data, 'allows'))).filter(file => !file.startsWith('.'));
  assert.equal(JSON.parse(await readFile(join(f.paths.data, 'allows', receipts[0]), 'utf8')).reported, true);
});

for (const reason of ['retired-key', 'retired-route', 'invalid-json', 'legacy-invalid-json']) test(`unverifiable holding (${reason}) is archived without stopping a forced removal`, async t => {
  const f = await fixture(t), build = f.build(), item = f.item(build);
  const victim = f.build([{path: 'SKILL.md', content: 'plain before revocation\n'}], {skillId: 'skill-victim', name: 'victim'});
  await f.engine.applyPlan(f.plan([f.item(victim), item]));
  let file = (await f.engine.holding.entries())[0].file;
  if (reason === 'retired-route') {
    const record = JSON.parse(await readFile(file, 'utf8')); record.item.route = 'retired-route';
    await atomicWriteBuild(file, JSON.stringify(record) + '\n');
  } else if (reason.includes('invalid-json')) {
    if (reason === 'legacy-invalid-json') file = join(f.paths.holding, 'a'.repeat(64) + '.json');
    await atomicWriteBuild(file, '{malformed');
  }
  const original = await readFile(file, 'utf8');
  const verifier = reason === 'retired-key' ? new BuildVerifier({keys: [], env: {}}) : f.verifier;
  const restarted = new SyncEngine({paths: f.paths, helperId: 'helper-allow', verifier,
    timing: f.timing, client: f.client, targets: f.engine.routes.all(), watchRoute: () => ({close() {}})});
  t.after(async () => {restarted.close();});
  const plan = f.plan([f.item(victim, {kind: 'forced_remove', state: 'forced', reason: 'revoked'})],
    {revoked: [{skillId: victim.skillId, digest: victim.digest}]});
  f.server(plan);
  await restarted.tick();
  await missing(join(f.routes['agents-folder'], victim.name));
  assert.equal((await listBackups(f.paths)).length, 1);
  assert.equal(await restarted.holding.count(), 0);
  assert.ok(f.calls.some(call => call.path === '/api/helper/inventory'));
  assert.ok(f.calls.some(call => call.path === '/api/helper/plan'));
  await missing(file);
  const archive = join(f.paths.data, 'holding-records');
  const files = (await readdir(archive)).filter(file => /^(?:legacy-)?unverifiable-/u.test(file));
  assert.equal(files.length, 1);
  assert.equal(await readFile(join(archive, files[0]), 'utf8'), original);
});

test('holding reconciliation and counting failures do not stop revocations or the rest of a sync pass', async t => {
  const f = await fixture(t);
  const victim = f.build([{path: 'SKILL.md', content: 'plain victim\n'}], {skillId: 'skill-victim', name: 'victim'});
  await f.engine.applyPlan(f.plan([f.item(victim)]));
  const next = f.build([{path: 'SKILL.md', content: 'plain next\n'}], {skillId: 'skill-next', name: 'next'});
  f.engine.holding.reconcile = async () => {throw new HelperError('HOLDING_INVALID', 'Injected holding error.');};
  f.engine.holding.count = async () => {throw new HelperError('HOLDING_INVALID', 'Injected holding error.');};
  f.server(f.plan([f.item(victim, {kind: 'forced_remove', state: 'forced', reason: 'security_fix'}), f.item(next)],
    {revoked: [{skillId: victim.skillId, digest: victim.digest}]}));
  await f.engine.tick();
  await missing(join(f.routes['agents-folder'], victim.name));
  assert.equal(await readFile(join(f.routes['agents-folder'], next.name, 'SKILL.md'), 'utf8'), 'plain next\n');
  assert.equal((await listBackups(f.paths)).length, 1);
  assert.ok(f.calls.some(call => call.path === '/api/helper/plan'));
  const inventory = await f.engine.inventory();
  assert.equal(inventory.holdingCount, 0);
  assert.deepEqual(inventory.deliveryErrors, []);
});

test('Allow-report 400 failures retry independently while inventory, revocations and plain delivery continue', async t => {
  const f = await fixture(t), build = f.build();
  f.server(f.plan([f.item(build)]));
  f.failReports(new ApiError('VALIDATION_FAILED', 400));
  await runAllow(f.engine, f.client, f.options());
  const receiptFile = join(f.paths.data, 'allows', (await readdir(join(f.paths.data, 'allows')))[0]);
  const next = f.build([{path: 'SKILL.md', content: 'plain next\n'}], {skillId: 'skill-next', name: 'next'});
  f.server(f.plan([f.item(build, {kind: 'forced_remove', state: 'forced', reason: 'revoked'}), f.item(next)],
    {revoked: [{skillId: build.skillId, digest: build.digest}]}));
  f.calls.length = 0;
  for (let index = 0; index < 5; index++) {await f.engine.tick(); f.advance(3_600_000);}
  assert.equal(f.calls.filter(call => call.path === '/api/helper/plan').length, 5);
  assert.equal(f.calls.filter(call => call.path === '/api/helper/inventory').length, 5);
  assert.equal(f.calls.filter(call => call.path === '/api/helper/allow').length, 5);
  assert.ok(f.calls.findIndex(call => call.path === '/api/helper/plan') < f.calls.findIndex(call => call.path === '/api/helper/allow'));
  await missing(join(f.routes['agents-folder'], build.name));
  assert.equal((await listBackups(f.paths)).length, 1);
  assert.equal(await readFile(join(f.routes['agents-folder'], next.name, 'SKILL.md'), 'utf8'), 'plain next\n');
  assert.equal(JSON.parse(await readFile(receiptFile, 'utf8')).reported, false);
  f.failReports(false); await f.engine.tick();
  assert.equal(JSON.parse(await readFile(receiptFile, 'utf8')).reported, true);
});

test('malformed receipts stay preserved and never block valid reports or plan polling', async t => {
  const f = await fixture(t), build = f.build();
  f.server(f.plan([f.item(build)])); f.failReports(true);
  await runAllow(f.engine, f.client, f.options());
  const invalid = join(f.paths.data, 'allows', 'a'.repeat(64) + '.json');
  await writeFile(invalid, '{bad-json', {mode: 0o600});
  const warnings: string[] = [];
  t.mock.method(console, 'error', (message: string) => {warnings.push(message);});
  f.failReports(false); f.calls.length = 0;
  await f.engine.tick();
  await f.engine.holding.flushReports(f.client);
  assert.ok(f.calls.some(call => call.path === '/api/helper/plan'));
  assert.ok(f.calls.some(call => call.path === '/api/helper/allow'));
  assert.equal(await readFile(invalid, 'utf8'), '{bad-json');
  assert.deepEqual(warnings, ['An invalid Allow report is preserved locally: ALLOW_INVALID']);
});

test('post-commit holding cleanup errors do not turn a delivered skill into a failed item', async t => {
  const f = await fixture(t);
  const build = f.build([{path: 'SKILL.md', content: 'plain delivered\n'}]);
  f.engine.holding.finish = async () => {throw new HelperError('HOLDING_INVALID', 'Injected cleanup error.');};
  await f.engine.applyPlan(f.plan([f.item(build)]));
  assert.equal((await f.engine.locks.read()).entries[0].digest, build.digest);
  assert.equal(await readFile(join(f.routes['agents-folder'], build.name, 'SKILL.md'), 'utf8'), 'plain delivered\n');
  assert.equal((await f.engine.inventory()).deliveryErrors.some(error => error.skillId === build.skillId), false);
});

test('symlinks at holding digest, record and receipt levels remain fatal even with dot names', async t => {
  for (const level of ['digest', 'record', 'receipt']) {
    const f = await fixture(t), build = f.build();
    await f.engine.applyPlan(f.plan([f.item(build)]));
    const outside = join(f.root, 'outside-' + level); await mkdir(outside);
    const folder = level === 'digest' ? join(f.paths.holding, build.skillId) : level === 'record' ?
      join(f.paths.holding, build.skillId, build.digest) : join(f.paths.data, 'allows');
    await mkdir(folder, {recursive: true, mode: 0o700});
    await symlink(outside, join(folder, '.injected'));
    if (level === 'receipt') await assert.rejects(f.engine.holding.flushReports(f.client), {code: 'PATH_UNSAFE'});
    else await assert.rejects(f.engine.holding.waiting(), {code: 'PATH_UNSAFE'});
    assert.deepEqual(await readdir(outside), []);
  }
});

test('unexpected holding names stay local while real delivery errors and strict inventory plan polls continue', async t => {
  const f = await fixture(t), build = f.build();
  const rejected = f.build([{path: 'SKILL.md', content: 'plain rejected\n'}], {skillId: 'skill-rejected', name: 'rejected'});
  const plan = f.plan([f.item(build), f.item(rejected, {route: 'missing-folder'})]);
  f.server(plan);
  await f.engine.applyPlan(plan);
  const stray = join(f.paths.holding, build.skillId, build.digest, 'unrecognized-record');
  await writeFile(stray, 'preserved-stray-content', {mode: 0o600});
  const rootStray = join(f.paths.holding, 'notes.json');
  const legacy = join(f.paths.holding, 'a'.repeat(64) + '.json');
  await writeFile(rootStray, '{arbitrary-json', {mode: 0o600});
  await writeFile(legacy, '{invalid-legacy-json', {mode: 0o600});
  assert.equal(await f.engine.holding.count(), 1);
  const inventory = await f.engine.inventory();
  assert.equal(inventory.holdingCount, 1, 'stray and unverifiable legacy JSON never inflate the waiting count');
  const expectedErrors = [{skillId: rejected.skillId, target: rejected.target, name: rejected.name, code: 'ROUTE_INVALID'}];
  assert.deepEqual(inventory.deliveryErrors, expectedErrors);
  assert.doesNotMatch(JSON.stringify(inventory), /preserved-stray-content|unrecognized-record|notes\.json|holding-records|HOLDING_INVALID/u);
  assert.equal(await readFile(stray, 'utf8'), 'preserved-stray-content');
  assert.equal(await readFile(rootStray, 'utf8'), '{arbitrary-json');
  assert.equal(await readFile(legacy, 'utf8'), '{invalid-legacy-json');
  const request = f.client.request;
  f.client.request = async <T>(path: string, options?: ApiRequestOptions) => {
    if (path === '/api/helper/inventory') {
      const body = options!.body as SyncInventory;
      // TLS-07 accepts real skill identities and safe names, never diagnostic sentinels.
      if (body.deliveryErrors.some(error => ![build.skillId, rejected.skillId].includes(error.skillId) ||
          !/^[a-z0-9-]+$/u.test(error.name))) throw new ApiError('VALIDATION_FAILED', 400);
      assert.deepEqual(body.deliveryErrors, expectedErrors);
      assert.doesNotMatch(JSON.stringify(body), /preserved-stray-content|unrecognized-record|notes\.json|holding-records|HOLDING_INVALID/u);
    }
    return request<T>(path, options);
  };
  f.calls.length = 0;
  for (let pass = 0; pass < 3; pass++) {await f.engine.tick(); f.advance(600_000);}
  assert.equal(f.calls.filter(call => call.path === '/api/helper/inventory').length, 3);
  assert.equal(f.calls.filter(call => call.path === '/api/helper/plan').length, 3);
  assert.equal(await readFile(stray, 'utf8'), 'preserved-stray-content');
  assert.equal(await readFile(rootStray, 'utf8'), '{arbitrary-json');
  const archived = (await readdir(join(f.paths.data, 'holding-records'))).filter(file => file.startsWith('legacy-unverifiable-'));
  assert.equal(archived.length, 1);
  assert.equal(await readFile(join(f.paths.data, 'holding-records', archived[0]), 'utf8'), '{invalid-legacy-json');
});

for (const hasWaiting of [false, true]) test(`status and Allow show one exact local unreadable-record notice with ${hasWaiting ? 'a waiting skill' : 'no waiting skills'}`, async t => {
  const f = await fixture(t), build = f.build();
  const plan = f.plan(hasWaiting ? [f.item(build)] : []);
  f.server(plan); await f.engine.applyPlan(plan);
  await writeFile(join(f.paths.holding, 'notes.json'), 'local-only-note', {mode: 0o600});
  await writeFile(join(f.paths.holding, 'second-note'), 'another-local-note', {mode: 0o600});
  const notice = '2 holding records could not be read and were kept in holding-records/';
  const cli = await connectedCli(f);
  await runCli(['status'], cli.options);
  assert.deepEqual(f.output.filter(line => line.includes('holding records')), [notice]);
  assert.ok(f.output.includes(`${hasWaiting ? 1 : 0} skill(s) with code wait for Allow on this computer.`));
  assert.doesNotMatch(f.output.join('\n'), /local-only-note|another-local-note|notes\.json|second-note/u);
  f.output.length = 0;
  assert.equal(await runAllow(f.engine, f.client, f.options('no')), 0);
  assert.deepEqual(f.output.filter(line => line.includes('holding records')), [notice]);
  if (hasWaiting) assert.equal(f.questions.length, 1);
  else assert.ok(f.output.includes('No skills wait for Allow.'));
  assert.doesNotMatch(f.output.join('\n'), /local-only-note|another-local-note|notes\.json|second-note/u);
  assert.equal(await readFile(join(f.paths.holding, 'notes.json'), 'utf8'), 'local-only-note');
  assert.equal(await readFile(join(f.paths.holding, 'second-note'), 'utf8'), 'another-local-note');
});

test('initial reconciliation failures use sync backoff instead of retrying every second', async t => {
  const f = await fixture(t);
  const restarted = new SyncEngine({paths: f.paths, helperId: 'helper-allow', client: f.client, targets: [], timing: f.timing});
  let attempts = 0;
  restarted.reconcile = async () => {attempts++; throw new HelperError('HOLDING_INVALID', 'Injected startup error.');};
  await restarted.tick();
  assert.equal(restarted.retryAt, f.timing.now() + 60_000);
  f.advance(1000); await restarted.tick();
  assert.equal(attempts, 1);
  f.advance(59_000); await restarted.tick();
  assert.equal(attempts, 2);
  assert.equal(restarted.retryAt, f.timing.now() + 120_000);
});

async function connectedCli(f: Awaited<ReturnType<typeof fixture>>) {
  const token = 'mdai_skill_' + 'T'.repeat(43);
  const tokenFile = join(f.root, 'credentials/skills.json');
  const secrets = await FileSecretStore.open(tokenFile, f.paths, { explicit: true, confirmed: true, scopes: ['sync'] });
  await secrets.set('skills-token', token, ['sync']);
  const connections = f.tools.map((tool, index) => ({ id: `connection-${index}`, ...tool }));
  const account = { id: 'person-one', name: 'Test person' };
  const renewBy = new Date(f.timing.now() + 90 * 86400_000).toISOString();
  const idleLapseAt = new Date(f.timing.now() + 30 * 86400_000).toISOString();
  await new StateStore(f.paths, new URL('https://ai.maddots.app')).write({
    format: 1, endpoint: 'https://ai.maddots.app/', status: 'connected', helperId: 'helper-allow',
    account, scopes: ['sync'], issuedAt: new Date(f.timing.now()).toISOString(), renewBy, idleLapseAt,
    tools: [], pendingTools: [], tokenStorage: 'file', tokenFile, connections,
  });
  const http: string[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://ai.maddots.app');
    if (url.pathname.startsWith('/api/helper/builds/')) assert.match(url.search, /^\?itemId=[A-Za-z0-9-]+$/u); else assert.equal(url.search, '');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token}`);
    assert.equal(init?.redirect, 'error');
    http.push(url.pathname);
    let data: unknown;
    if (url.pathname === '/api/helper/status') data = { account, scopes: ['sync'], renewBy, idleLapseAt, pending: [], connections };
    else {
      const response = await f.client.request(url.pathname, {
        method: (init?.method ?? 'GET') as ApiRequestOptions['method'],
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      data = response.data;
    }
    return new Response(JSON.stringify({ data }), { status: 200 });
  };
  const options: CliOptions = {
    home: f.home, env: { MADDOTS_AI_HOME: f.paths.data, MADDOTS_AI_AUTO_UPDATE: '0', PATH: join(f.root, 'empty-bin') },
    request, timing: f.timing, verifier: f.verifier, isTTY: true, watchRoute: () => ({ close() {} }),
    deliveryTargets: Object.entries(f.routes).map(([route, directory]) => new FolderDeliveryTarget(f.paths, route, directory)),
    runtime: { bundledRoot: f.root, runningRoot: f.root, bootstrapVersion: '0.1.0', bootstrapEntrypoint: join(f.root, 'bootstrap/cli.js') },
    output: line => f.output.push(line),
  };
  return { options, http, token, tokenFile, secrets };
}

test('verified code waits only in private data, stays out of all routes, and inventory sends only its count', async t => {
  const f = await fixture(t), build = f.build(code('private-script-canary'));
  f.server(f.plan([f.item(build)]));
  await f.engine.tick();
  const waiting = await new HoldingStore(f.paths, 'helper-allow', f.verifier, f.timing).waiting();
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].entries.length, 1);
  assert.ok(inside(join(f.paths.holding, build.skillId, build.digest), waiting[0].entries[0].file));
  assert.equal((await lstat(waiting[0].entries[0].file)).mode & 0o777, 0o600);
  assert.equal((await lstat(join(f.paths.holding, build.skillId, build.digest))).mode & 0o777, 0o700);
  for (const route of Object.values(f.routes)) assert.deepEqual(await readdir(route), []);
  assert.deepEqual((await f.engine.locks.read()).entries, []);
  assert.equal((await f.engine.inventory()).holdingCount, 1);
  f.advance(1001);
  await f.engine.tick();
  const reports = f.calls.filter(call => call.path === '/api/helper/inventory');
  const inventory = reports.at(-1)!.options!.body as { holdingCount: number; managed: unknown[] };
  assert.equal(inventory.holdingCount, 1);
  assert.deepEqual(inventory.managed, []);
  assert.doesNotMatch(JSON.stringify(inventory), /private-script-canary|scripts\/run\.sh|content|allowedDigests/u);
});

test('one skill/version groups distinct route digests, repeated polls do not duplicate it, and one local prompt releases both routes', async t => {
  const f = await fixture(t);
  const first = f.build(code('agents script'));
  const second = f.build(code('continue script'), { name: 'example-continue' });
  const items = [f.item(first), f.item(second, { route: 'continue-folder', sourceName: 'example' })];
  f.server(f.plan(items));
  await f.engine.applyPlan(f.plan(items));
  await f.engine.applyPlan(f.plan(items));
  const groups = await f.engine.holding.waiting();
  assert.equal(groups.length, 1);
  assert.equal(groups[0].entries.length, 2);
  assert.deepEqual(new Set(groups[0].digests), new Set([first.digest, second.digest]));
  assert.equal((await f.engine.inventory()).holdingCount, 1);
  assert.equal(await runAllow(f.engine, f.client, f.options()), 1);
  assert.deepEqual(f.questions, ['Allow example v1 on this computer? [y/N]']);
  assert.match(f.output.join('\n'), /Route: agents-folder; tools: Codex/u);
  assert.match(f.output.join('\n'), /Route: continue-folder; tools: Continue/u);
  assert.equal(await readFile(join(f.routes['agents-folder'], first.name, 'scripts/run.sh'), 'utf8'), 'agents script\n');
  assert.equal(await readFile(join(f.routes['continue-folder'], second.name, 'scripts/run.sh'), 'utf8'), 'continue script\n');
  assert.equal((await f.engine.locks.read()).entries.length, 2);
  assert.equal(await f.engine.holding.count(), 0);
});

test('individual prompts default to refusal and persist consent only for the skill explicitly accepted', async t => {
  const f = await fixture(t);
  const first = f.build(code('first'), { skillId: 'skill-a', name: 'alpha' });
  const second = f.build(code('second'), { skillId: 'skill-b', name: 'beta' });
  f.server(f.plan([f.item(first), f.item(second)]));
  const answers = ['', 'Y'];
  assert.equal(await runAllow(f.engine, f.client, f.options('', {
    confirm: async question => { f.questions.push(question); return answers.shift()!; },
  })), 1);
  assert.deepEqual(f.questions, ['Allow alpha v1 on this computer? [y/N]', 'Allow beta v1 on this computer? [y/N]']);
  await missing(join(f.routes['agents-folder'], first.name));
  assert.equal(await f.engine.holding.isAllowed(first), false);
  assert.equal(await f.engine.holding.isAllowed(second), true);
  assert.equal(await f.engine.holding.count(), 1);
  assert.equal((await f.engine.locks.read()).entries[0].skillId, second.skillId);
});

test('--all shows every review before its single confirmation, and a non-yes response releases nothing', async t => {
  const f = await fixture(t);
  const builds = [f.build(code('alpha-body'), { skillId: 'skill-a', name: 'alpha' }),
    f.build(code('beta-body'), { skillId: 'skill-b', name: 'beta' })];
  f.server(f.plan(builds.map(build => f.item(build))));
  let prompts = 0;
  const confirmed = f.options('', { all: true, confirm: async question => {
    prompts++;
    assert.equal(question, 'Allow all 2? [y/N]');
    assert.ok(f.output.join('\n').includes('alpha-body'));
    assert.ok(f.output.join('\n').includes('beta-body'));
    return 'yes';
  }});
  assert.equal(await runAllow(f.engine, f.client, { ...confirmed, confirm: async question => {
    assert.equal(question, 'Allow all 2? [y/N]');
    return 'yes please';
  }}), 0);
  assert.equal((await f.engine.locks.read()).entries.length, 0);
  assert.equal(await f.engine.holding.count(), 2);
  assert.equal(await runAllow(f.engine, f.client, confirmed), 2);
  assert.equal(prompts, 1);
  assert.equal(await f.engine.holding.count(), 0);
});

test('first install shows scripts, executable files, allowed-tools values, bang commands and visible hidden/control characters', async t => {
  const f = await fixture(t);
  const build = f.build([
    { path: 'SKILL.md', content: '---\nname: example\nallowed-tools: Bash(echo hello)\n---\n! echo bang-command\nTry !`printf inline-command`\n![image](asset.png)\n' },
    { path: 'references/help.md', content: '---\nallowed-tools: Read\n---\n! printf reference-command\n' },
    { path: 'scripts/run.sh', content: 'printf script-command\n' },
    { path: 'bin/execute', mode: '100755', content: 'printf executable-command\n# hide\u202eevil\u200b\t\x1b[31m\n' },
    { path: 'assets/plain.txt', content: 'irrelevant-asset-marker' },
  ]);
  f.server(f.plan([f.item(build)]));
  await runAllow(f.engine, f.client, f.options('no'));
  const review = f.output.join('\n');
  for (const marker of ['Bash(echo hello)', 'allowed-tools: Read', 'bang-command', 'inline-command', 'reference-command', 'script-command', 'executable-command']) {
    assert.ok(review.includes(marker), 'missing code review: ' + marker);
  }
  for (const point of ['202e', '200b', '9', '1b']) assert.ok(review.includes('\\u{' + point + '}'));
  assert.doesNotMatch(review, /[\u202e\u200b\t]/u);
  assert.equal(review.includes(String.fromCharCode(27)), false);
  assert.doesNotMatch(review, /irrelevant-asset-marker/u);
  await missing(join(f.routes['agents-folder'], build.name));
});

test('updates show unified diffs for edits, deletion, new binary content and mode changes; Allow preserves the old build in a backup', async t => {
  const f = await fixture(t);
  const initial = f.build([
    { path: 'SKILL.md', content: '# original instruction\n' },
    { path: 'scripts/run.sh', content: 'printf old-command\n', mode: '100644' },
    { path: 'scripts/removed.sh', content: 'printf deleted-command\n' },
  ]);
  f.server(f.plan([f.item(initial)]));
  await runAllow(f.engine, f.client, f.options());
  f.output.length = 0; f.questions.length = 0;
  const updated = f.build([
    { path: 'SKILL.md', content: '# revised instruction\n' },
    { path: 'scripts/run.sh', content: 'printf new-command\n', mode: '100755' },
    { path: 'assets/blob.bin', content: Buffer.from([0, 255, 1]) },
  ], { version: 2 });
  f.server(f.plan([f.item(updated, { kind: 'update', fromVersion: 1 })]));
  assert.equal(await runAllow(f.engine, f.client, f.options()), 1);
  const review = f.output.join('\n');
  assert.match(review, /--- allowed\/SKILL\.md\n\+\+\+ waiting\/SKILL\.md\n@@ -1,1 \+1,1 @@\n-# original instruction\n\+# revised instruction/u);
  assert.match(review, /--- allowed\/scripts\/removed\.sh\n\+\+\+ \/dev\/null/u);
  assert.ok(review.includes('-printf deleted-command'));
  assert.match(review, /Mode: 100644 -> 100755/u);
  assert.match(review, /\+\[Binary: 3 bytes, sha256 [a-f0-9]{64}\]/u);
  const entry = (await f.engine.locks.read()).entries[0];
  assert.equal(entry.version, 2);
  assert.equal(entry.previous?.digest, initial.digest);
  assert.deepEqual(new Set(entry.allowedDigests), new Set([initial.digest, updated.digest]));
  const stamp = await readStamp(join(f.routes['agents-folder'], updated.name), f.verifier, ['helper-allow']);
  assert.equal(stamp.signature, updated.signature);
  assert.equal(stamp.digest, updated.digest);
  const backups = await listBackups(f.paths);
  assert.equal(backups.length, 1);
  const backup = backups[0];
  assert.equal(await readFile(join(f.paths.backups, backup.id, backup.route, backup.folderName, 'scripts/removed.sh'), 'utf8'), 'printf deleted-command\n');
  await missing(join(f.routes['agents-folder'], updated.name, 'scripts/removed.sh'));
  assert.equal((await lstat(join(f.paths.data, 'lock.json'))).mode & 0o777, 0o600);
});

test('an identical content digest in a new signed version asks again and keeps the last accepted version until local confirmation', async t => {
  const f = await fixture(t), first = f.build();
  f.server(f.plan([f.item(first)]));
  await runAllow(f.engine, f.client, f.options());
  const newer = f.build(code(), { version: 2 });
  assert.equal(first.digest, newer.digest);
  assert.notEqual(first.signature, newer.signature);
  const nextPlan = f.plan([f.item(newer, { kind: 'update', fromVersion: 1 })]);
  f.server(nextPlan);
  await f.engine.applyPlan(nextPlan);
  assert.equal(await f.engine.holding.count(), 1);
  assert.equal(await f.engine.holding.isAllowed(newer), false);
  assert.equal((await f.engine.locks.read()).entries[0].version, 1);
  f.output.length = 0; f.questions.length = 0;
  assert.equal(await runAllow(f.engine, f.client, f.options()), 1);
  assert.deepEqual(f.questions, ['Allow example v2 on this computer? [y/N]']);
  assert.ok(f.output.includes('No file changes. This signed version still needs Allow.'));
  assert.equal((await f.engine.locks.read()).entries[0].version, 2);
  assert.equal((await allowedBuild(first.skillId, first.target, first.name, {
    paths: f.paths, helperId: 'helper-allow', verifier: f.verifier,
  })).build.version, 2);
});

test('Allow requires a TTY and the CLI rejects --yes without running commands or contacting the server', async t => {
  const f = await fixture(t);
  f.server(f.plan([f.item(f.build())]));
  await assert.rejects(runAllow(f.engine, f.client, f.options('yes', { isTTY: false })), { code: 'ALLOW_TTY_REQUIRED' });
  assert.equal(f.calls.length, 0);
  let external = 0;
  await assert.rejects(runCli(['allow', '--yes'], {
    home: f.home, env: {}, runner: async () => { external++; throw new Error('No commands expected'); },
    request: async () => { external++; throw new Error('No HTTP expected'); },
  }), { code: 'USAGE' });
  assert.equal(external, 0);
  assert.deepEqual(await readdir(f.paths.holding), []);
});

test('Allow queues exact TLS07 reports per digest and retries them durably once the server accepts', async t => {
  const f = await fixture(t);
  const first = f.build(code('agents'));
  const second = f.build(code('continue'), { name: 'example-continue' });
  f.server(f.plan([f.item(first), f.item(second, { route: 'continue-folder', sourceName: 'example' })]));
  f.failReports(true);
  assert.equal(await runAllow(f.engine, f.client, f.options()), 1);
  assert.ok(f.output.includes('Allow saved on this computer. The audit report is queued for retry.'));
  const failed = f.calls.filter(call => call.path === '/api/helper/allow');
  assert.equal(failed.length, 1);
  const expected = { holdingCount: 0, reports: [
    { skillId: first.skillId, version: 1, digest: first.digest, tools: ['codex'], allowedAt: new Date(f.timing.now()).toISOString() },
    { skillId: second.skillId, version: 1, digest: second.digest, tools: ['continue'], allowedAt: new Date(f.timing.now()).toISOString() },
  ] };
  const normalized = (value: unknown) => {
    const body = value as typeof expected;
    return { ...body, reports: [...body.reports].sort((a, b) => a.digest.localeCompare(b.digest)) };
  };
  assert.deepEqual(normalized(failed[0].options!.body), normalized(expected));
  assert.equal(failed[0].options!.method, 'POST');
  f.failReports(false);
  const restarted = new HoldingStore(f.paths, 'helper-allow', f.verifier, f.timing);
  await restarted.flushReports(f.client);
  const accepted = f.calls.filter(call => call.path === '/api/helper/allow');
  assert.equal(accepted.length, 2);
  assert.deepEqual(normalized(accepted[1].options!.body), normalized(expected));
  await restarted.flushReports(f.client);
  assert.equal(f.calls.filter(call => call.path === '/api/helper/allow').length, 2);
  for (const file of await readdir(join(f.paths.data, 'allows'))) {
    assert.equal(JSON.parse(await readFile(join(f.paths.data, 'allows', file), 'utf8')).reported, true);
  }
});

test('agent caches cannot serve code before Allow, then allowedBuild returns only the accepted locally allowed agent envelope', async t => {
  const f = await fixture(t), build = f.build();
  const agentPlan = f.plan([f.item(build, { forAgentIds: ['agent-one'] })]);
  f.server(agentPlan);
  await f.engine.applyPlan(agentPlan);
  await assert.rejects(f.engine.verifiedBuild(build.digest, 'agent-one'), { code: 'BUILD_NOT_ACCEPTED' });
  const selection = { paths: f.paths, helperId: 'helper-allow', verifier: f.verifier, agentId: 'agent-one' };
  await assert.rejects(allowedBuild(build.skillId, build.target, build.name, selection), { code: 'BUILD_NOT_ACCEPTED' });
  assert.deepEqual((await f.engine.agentLocks.read()).entries, []);
  assert.equal(await runAllow(f.engine, f.client, f.options()), 1);
  const accepted = await allowedBuild(build.skillId, build.target, build.name, selection);
  assert.equal(accepted.hasCode, true);
  assert.equal(accepted.build.signature, build.signature);
  assert.equal((await f.engine.verifiedBuild(build.digest, 'agent-one')).build.digest, build.digest);
  await assert.rejects(allowedBuild(build.skillId, build.target, build.name, { ...selection, agentId: 'agent-two' }), { code: 'BUILD_NOT_ACCEPTED' });
  assert.deepEqual((await f.engine.locks.read()).entries, []);
  assert.deepEqual(await readdir(f.routes['agents-folder']), []);
  await f.engine.applyPlan(f.plan([], { revoked: [{ skillId: build.skillId, digest: build.digest }] }));
  await assert.rejects(allowedBuild(build.skillId, build.target, build.name, selection), { code: 'BUILD_REVOKED' });
});

test('withdrawal or revocation while reviewing prevents consent, delivery and reports, while preserving archived records', async t => {
  for (const revoked of [false, true]) {
    const f = await fixture(t), build = f.build();
    const initial = f.plan([f.item(build)]);
    f.server(initial);
    await assert.rejects(runAllow(f.engine, f.client, f.options('yes', { confirm: async () => {
      f.server(revoked ? f.plan(initial.items, { revoked: [{ skillId: build.skillId, digest: build.digest }] }) : f.plan([]));
      return 'yes';
    }})), { code: 'ALLOW_CHANGED' });
    await missing(join(f.routes['agents-folder'], build.name));
    assert.equal(await f.engine.holding.isAllowed(build), false);
    assert.deepEqual((await f.engine.locks.read()).entries, []);
    assert.equal(await f.engine.holding.count(), 0);
    assert.equal(f.calls.filter(call => call.path === '/api/helper/allow').length, 0);
    const archives = await readdir(join(f.paths.data, 'holding-records'));
    assert.equal(archives.length, 1);
    assert.match(archives[0], /^withdrawn-/u);
    assert.equal(JSON.parse(await readFile(join(f.paths.data, 'holding-records', archives[0]), 'utf8')).build.digest, build.digest);
  }
});

test('a symlink inserted into holding is refused and cannot be used to authorize or follow external files', async t => {
  const f = await fixture(t), build = f.build();
  f.server(f.plan([f.item(build)]));
  await f.engine.applyPlan(f.plan([f.item(build)]));
  const outside = join(f.root, 'outside');
  await mkdir(outside);
  await symlink(outside, join(f.paths.holding, 'injected'));
  await assert.rejects(f.engine.holding.waiting(), { code: 'PATH_UNSAFE' });
  await assert.rejects(runAllow(f.engine, f.client, f.options()), { code: 'PATH_UNSAFE' });
  assert.deepEqual(await readdir(outside), []);
  await missing(join(f.routes['agents-folder'], build.name));
  assert.equal(f.questions.length, 0);
});

test('allowedBuild selects the exact accepted skill when two signed skills have identical content digests', async t => {
  const f = await fixture(t);
  const first = f.build(code(), { skillId: 'skill-alpha', name: 'alpha' });
  f.server(f.plan([f.item(first)]));
  await runAllow(f.engine, f.client, f.options());
  const second = f.build(code(), { skillId: 'skill-beta', name: 'beta' });
  assert.equal(first.digest, second.digest);
  assert.notEqual(first.signature, second.signature);
  f.server(f.plan([f.item(second)]));
  await runAllow(f.engine, f.client, f.options());
  assert.equal((await f.engine.locks.read()).entries.length, 2);
  const selection = { paths: f.paths, helperId: 'helper-allow', verifier: f.verifier };
  for (const build of [first, second]) {
    const selected = await allowedBuild(build.skillId, build.target, build.name, selection);
    assert.equal(selected.build.skillId, build.skillId);
    assert.equal(selected.build.name, build.name);
    assert.equal(selected.build.signature, build.signature);
  }
});

test('route, agent or approval changes and malformed live plans during confirmation never persist consent', async t => {
  const changes: { change: (plan: SyncPlan) => SyncPlan; code: string }[] = [
    { change: plan => ({ ...plan, items: plan.items.map(item => ({ ...item, route: 'continue-folder' })) }), code: 'ALLOW_CHANGED' },
    { change: plan => ({ ...plan, items: plan.items.map(item => ({ ...item, forAgentIds: ['agent-other'] })) }), code: 'ALLOW_CHANGED' },
    { change: plan => ({ ...plan, items: plan.items.map(item => ({ ...item, answer: 'always' })) }), code: 'ALLOW_CHANGED' },
    { change: plan => ({ ...plan, pollAfterSeconds: 0 }), code: 'PLAN_INVALID' },
  ];
  for (const { change, code: errorCode } of changes) {
    const f = await fixture(t), build = f.build();
    const initial = f.plan([f.item(build)]);
    f.server(initial);
    await assert.rejects(runAllow(f.engine, f.client, f.options('yes', { confirm: async () => {
      f.server(change(initial));
      return 'yes';
    }})), { code: errorCode });
    assert.equal(await f.engine.holding.isAllowed(build), false);
    assert.deepEqual((await f.engine.locks.read()).entries, []);
    assert.deepEqual((await f.engine.agentLocks.read()).entries, []);
    assert.equal(f.calls.filter(call => call.path === '/api/helper/allow').length, 0);
    for (const route of Object.values(f.routes)) assert.deepEqual(await readdir(route), []);
  }
});

test('the authenticated CLI allow --all reviews, delivers and reports through its real file-token command path', async t => {
  const f = await fixture(t);
  const first = f.build(code('cli-alpha'), { skillId: 'skill-alpha', name: 'alpha' });
  const second = f.build(code('cli-beta'), { skillId: 'skill-beta', name: 'beta' });
  f.server(f.plan([f.item(first), f.item(second)]));
  const cli = await connectedCli(f);
  let externalCalls = 0;
  await runCli(['allow', '--all'], {
    ...cli.options,
    runner: async file => { externalCalls++; assert.equal(file, '/usr/sbin/scutil'); return {stdout: 'Allow-Test-Mac\n', stderr: ''}; },
    confirm: async question => {
      f.questions.push(question);
      assert.equal(question, 'Allow all 2? [y/N]');
      assert.ok(f.output.join('\n').includes('cli-alpha'));
      assert.ok(f.output.join('\n').includes('cli-beta'));
      return 'yes';
    },
  });
  assert.deepEqual(f.questions, ['Allow all 2? [y/N]']);
  assert.equal(externalCalls, 1);
  assert.equal((await f.engine.locks.read()).entries.length, 2);
  assert.equal(await f.engine.holding.count(), 0);
  for (const build of [first, second]) {
    assert.equal(await readFile(join(f.routes['agents-folder'], build.name, 'scripts/run.sh'), 'utf8'), `cli-${build.name}\n`);
  }
  const report = f.calls.find(call => call.path === '/api/helper/allow')!.options!.body as { holdingCount: number; reports: unknown[] };
  assert.equal(report.holdingCount, 0);
  assert.equal(report.reports.length, 2);
  assert.ok(cli.http.includes('/api/helper/plan'));
  assert.ok(cli.http.includes('/api/helper/allow'));
  assert.equal(await cli.secrets.get('skills-token'), cli.token);
  assert.doesNotMatch(f.output.join('\n'), /mdai_skill_/u);
  assert.doesNotMatch(await readFile(f.paths.state, 'utf8'), /mdai_skill_/u);
});

test('the authenticated service polls code into holding, sends its count and shows one fake dialog across two ticks', async t => {
  const f = await fixture(t), build = f.build(code('service-private-script'));
  f.server(f.plan([f.item(build)]));
  const cli = await connectedCli(f), stop = new AbortController();
  const commands: { file: string; args: readonly string[] }[] = [];
  let sleeps = 0, watched = 0, closed = 0;
  await runCli(['service'], {
    ...cli.options, isTTY: false, signal: stop.signal,
    watchRoute: root => {
      assert.ok(Object.values(f.routes).includes(root));
      watched++;
      return { close() { closed++; } };
    },
    timing: { now: f.timing.now, sleep: async ms => {
      f.advance(Math.max(ms, 1001));
      if (++sleeps >= 2) stop.abort();
    } },
    runner: async (file, args) => {
      commands.push({ file, args });
      if (file === '/usr/sbin/scutil') return {stdout: 'Allow-Test-Mac\n', stderr: ''};
      if (file === '/usr/bin/osascript') return { stdout: 'button returned:Later\n', stderr: '' };
      throw new Error('No other external command is available in the temp home');
    },
  });
  assert.ok(stop.signal.aborted);
  assert.equal(watched, 2);
  assert.equal(closed, watched);
  const dialogs = commands.filter(command => command.file === '/usr/bin/osascript');
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0].args.join(' '), /1 skills with code wait for Allow on this computer/u);
  assert.equal(commands.some(command => command.file === '/usr/bin/security' || command.file === '/usr/bin/open'), false);
  const inventories = f.calls.filter(call => call.path === '/api/helper/inventory').map(call => call.options!.body as { holdingCount: number; computerName: string });
  assert.ok(inventories.every(inventory => inventory.computerName === 'Allow-Test-Mac'));
  assert.equal(inventories[0].holdingCount, 0);
  assert.ok(inventories.some(inventory => inventory.holdingCount === 1));
  assert.doesNotMatch(JSON.stringify(inventories), /service-private-script|scripts\/run\.sh|mdai_skill_/u);
  assert.equal(await f.engine.holding.count(), 1);
  assert.deepEqual((await f.engine.locks.read()).entries, []);
  await missing(join(f.routes['agents-folder'], build.name));
  assert.equal(f.calls.some(call => call.path === '/api/helper/allow'), false);
  assert.ok(cli.http.includes('/api/helper/status'));
  assert.ok(cli.http.includes('/api/helper/plan'));
  assert.equal((await lstat(join(f.paths.data, 'allow.command'))).mode & 0o777, 0o700);
});

test('the service registers only pilot routes when Codex, Continue and Hermes are connected', async t => {
  const f = await fixture(t);
  const hermes = TOOL_MATRIX.tools.find(tool => tool.key === 'hermes')!;
  f.tools.push({ tool: hermes.key, variant: hermes.variants[0].key });
  // Release 8 merge: TLS-15's agents-folder adapter checks the frontmatter name against the folder.
  const pilot = '---\nname: example\ndescription: A plain pilot skill.\n---\nA plain pilot skill.\n';
  const build = f.build([{ path: 'SKILL.md', content: pilot }]);
  const later = f.build([{ path: 'SKILL.md', content: 'A plain later skill.\n' }], { skillId: 'skill-hermes', name: 'hermes-example' });
  f.server(f.plan([
    f.item(build, { route: 'continue-folder' }), f.item(build), f.item(later, { route: 'hermes-folder' }),
  ]));
  const hermesDirectory = join(f.home, '.hermes/skills');
  await mkdir(hermesDirectory, { recursive: true });
  const cli = await connectedCli(f), stop = new AbortController();
  let sleeps = 0;
  await runCli(['service'], {
    ...cli.options, deliveryTargets: undefined, isTTY: false, signal: stop.signal,
    timing: { now: f.timing.now, sleep: async ms => {
      assert.equal(ms, 1000); f.advance(ms);
      if (++sleeps === 2) stop.abort();
    } },
    runner: async file => {
      assert.equal(file, '/usr/sbin/scutil');
      return { stdout: 'Pilot-Test-Mac\n', stderr: '' };
    },
  });
  assert.deepEqual(await readdir(f.routes['continue-folder']), []);
  assert.deepEqual(await readdir(hermesDirectory), []);
  assert.equal(await readFile(join(f.routes['agents-folder'], build.name, 'SKILL.md'), 'utf8'), pilot);
  const entries = (await f.engine.locks.read()).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].route, 'agents-folder');
  const inventory = f.calls.filter(call => call.path === '/api/helper/inventory').at(-1)!.options!.body as {
    deliveryErrors: { skillId: string; code: string }[];
  };
  assert.ok(inventory.deliveryErrors.some(error => error.skillId === later.skillId && error.code === 'ROUTE_UNKNOWN'));
  assert.ok(inventory.deliveryErrors.every(error => error.code === 'ROUTE_UNKNOWN'));
  assert.doesNotMatch(f.output.join('\n'), /PLAN_CONFLICT|ROUTE_INVALID/u);
});

test('the CLI composes Claude plugin sync so accepted builds are stamped and registered once', async t => {
  const f = await fixture(t);
  const claude = TOOL_MATRIX.tools.find(tool => tool.key === 'claude-code')!;
  f.tools.push({tool: claude.key, variant: claude.variants[0].key});
  const build = f.build([{path: 'SKILL.md', content: '---\nname: example\ndescription: CLI plugin integration\n---\nExplain the fixture.\n'}],
    {target: 'claude-plugin'});
  f.server(f.plan([f.item(build, {route: 'claude-plugin'})]));
  const cli = await connectedCli(f), bin = join(f.root, 'claude-bin'), executable = join(bin, 'claude');
  await mkdir(bin, {mode: 0o700});
  await writeFile(executable, 'fixture executable', {mode: 0o700});
  const calls: string[][] = [];
  const options: CliOptions = {...cli.options, deliveryTargets: undefined,
    env: {...cli.options.env, PATH: bin}, runner: async (file, args) => {
      if (file === '/usr/sbin/scutil') return {stdout: 'Plugin-Test-Mac\n', stderr: ''};
      assert.equal(file, executable);
      calls.push([...args]);
      if (args[0] === '--version') return {stdout: '2.1.289 (Claude Code)\n', stderr: ''};
      if (args.join(' ') === 'plugin marketplace list --json') return {stdout: '[]', stderr: ''};
      return {stdout: '', stderr: ''};
    }};
  await runCli(['allow', '--all'], options);
  await runCli(['allow', '--all'], options);
  const entry = (await f.engine.locks.read()).entries.find(entry => entry.skillId === build.skillId)!;
  assert.equal(entry.route, 'claude-plugin');
  assert.equal(entry.target, 'claude-plugin');
  const folder = join(f.home, '.maddots-ai/claude-code/maddots-workspace-one/skills/example');
  const stamp = await readStamp(folder, f.verifier, ['helper-allow']);
  assert.equal(stamp.signature, build.signature);
  assert.equal(stamp.digest, build.digest);
  assert.equal(calls.filter(args => args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add').length, 1);
  assert.equal(calls.filter(args => args[0] === 'plugin' && args[1] === 'install').length, 1);
  await missing(join(f.home, '.claude/skills/example'));
});

test('the mixed Codex/Claude CLI service backs up a reported unmanaged conflict only after replace_unmanaged', async t => {
  const f = await fixture(t);
  f.tools.splice(0, f.tools.length, ...['codex', 'claude-code'].map(key => {
    const tool = TOOL_MATRIX.tools.find(tool => tool.key === key)!;
    return {tool: key, variant: tool.variants[0].key};
  }));
  const original = '---\nname: example\ndescription: My existing skill.\n---\nKeep my local copy.\n';
  const delivered = '---\nname: example\ndescription: The approved skill.\n---\nDeliver this version.\n';
  const folder = join(f.routes['agents-folder'], 'example');
  await mkdir(join(folder, '.maddots/empty'), {recursive: true});
  await writeFile(join(folder, 'SKILL.md'), original);
  await writeFile(join(folder, '.maddots/notes'), 'personal metadata');
  const build = f.build([{path: 'SKILL.md', content: delivered}]);
  const pluginBuild = f.build([{path: 'SKILL.md', content: '---\nname: plugin-example\ndescription: A plugin skill.\n---\nPlugin content.\n'}],
    {skillId: 'skill-plugin', name: 'plugin-example', target: 'claude-plugin'});
  const asking = f.item(build, {state: 'asking', answer: null});
  const pluginItem = f.item(pluginBuild, {route: 'claude-plugin'});
  f.server(f.plan([asking, pluginItem]));
  const cli = await connectedCli(f), bin = join(f.root, 'claude-bin'), executable = join(bin, 'claude');
  await mkdir(bin, {mode: 0o700});
  await writeFile(executable, 'fixture executable', {mode: 0o700});
  const calls: string[][] = [], stop = new AbortController();
  let sleeps = 0;
  await runCli(['service'], {
    ...cli.options, deliveryTargets: undefined, env: {...cli.options.env, PATH: bin}, isTTY: false, signal: stop.signal,
    runner: async (file, args) => {
      if (file === '/usr/sbin/scutil') return {stdout: 'Mixed-Tools-Mac\n', stderr: ''};
      assert.equal(file, executable);
      calls.push([...args]);
      if (args[0] === '--version') return {stdout: '2.1.289 (Claude Code)\n', stderr: ''};
      if (args.join(' ') === 'plugin marketplace list --json') return {stdout: '[]', stderr: ''};
      return {stdout: '', stderr: ''};
    },
    timing: {now: f.timing.now, sleep: async ms => {
      assert.equal(ms, 1000);
      sleeps++;
      if (sleeps <= 2) {
        assert.equal(await readFile(join(folder, 'SKILL.md'), 'utf8'), original);
        assert.deepEqual(await listBackups(f.paths), []);
        assert.ok(!(await f.engine.locks.read()).entries.some(entry => entry.skillId === build.skillId));
      }
      if (sleeps === 2) {
        const report = f.calls.filter(call => call.path === '/api/helper/inventory').at(-1)!.options!.body as SyncInventory;
        assert.ok(report.unmanaged.some(value => {
          const conflict = value as {home: string; folderName: string; canonicalConflict?: {skillId: string}};
          return conflict.home === '.agents' && conflict.folderName === build.name && conflict.canonicalConflict?.skillId === build.skillId;
        }));
        f.server(f.plan([{...asking, state: 'approved', answer: 'replace_unmanaged'}, pluginItem]));
      }
      if (sleeps === 3) assert.equal(await readFile(join(folder, 'SKILL.md'), 'utf8'), delivered);
      if (sleeps === 4) stop.abort();
      f.advance(600_000);
    }},
  });
  const backups = await listBackups(f.paths);
  assert.equal(backups.length, 1);
  assert.equal(backups[0].reason, 'unmanaged_replaced');
  assert.equal(backups[0].originalPath, '.agents/skills/example');
  const preserved = join(f.paths.backups, backups[0].id, 'agents-folder/example');
  assert.equal(await readFile(join(preserved, 'SKILL.md'), 'utf8'), original);
  assert.equal(await readFile(join(preserved, '.maddots/notes'), 'utf8'), 'personal metadata');
  assert.ok((await lstat(join(preserved, '.maddots/empty'))).isDirectory());
  const snapshot = JSON.parse(await readFile(join(f.paths.data, 'unmanaged-conflicts', asking.itemId + '.json'), 'utf8'));
  assert.equal(snapshot.reported, true);
  assert.equal(snapshot.completed, true);
  assert.equal((await readStamp(folder, f.verifier, ['helper-allow'])).signature, build.signature);
  const pluginFolder = join(f.home, '.maddots-ai/claude-code/maddots-workspace-one/skills/plugin-example');
  assert.equal((await readStamp(pluginFolder, f.verifier, ['helper-allow'])).signature, pluginBuild.signature);
  assert.equal((await f.engine.locks.read()).entries.length, 2);
  assert.equal(calls.filter(args => args[0] === 'plugin' && args[1] === 'install').length, 1);
  const report = f.calls.filter(call => call.path === '/api/helper/inventory').at(-1)!.options!.body as SyncInventory;
  assert.deepEqual(report.deliveryErrors, []);
});

test('TLS-49 the default service delivers a DeepSeek-only connection to the shared folder without creating its legacy home', async t => {
  const f = await fixture(t);
  const tool = TOOL_MATRIX.tools.find(tool => tool.key === 'deepseek-harness')!;
  f.tools.splice(0, f.tools.length, { tool: tool.key, variant: tool.variants[0].key });
  const text = '---\nname: example\ndescription: A plain DeepSeek skill.\n---\nA plain DeepSeek skill.\n';
  const build = f.build([{ path: 'SKILL.md', content: text }]);
  f.server(f.plan([f.item(build)]));
  const cli = await connectedCli(f), stop = new AbortController();
  let sleeps = 0;
  await runCli(['service'], {
    ...cli.options, deliveryTargets: undefined, isTTY: false, signal: stop.signal,
    timing: { now: f.timing.now, sleep: async ms => {
      assert.equal(ms, 1000); f.advance(ms);
      if (++sleeps === 2) stop.abort();
    } },
    runner: async file => {
      assert.equal(file, '/usr/sbin/scutil');
      return { stdout: 'DeepSeek-Test-Mac\n', stderr: '' };
    },
  });
  assert.deepEqual(await readdir(f.routes['agents-folder']), [build.name]);
  assert.equal(await readFile(join(f.routes['agents-folder'], build.name, 'SKILL.md'), 'utf8'), text);
  assert.deepEqual(await readdir(f.routes['continue-folder']), []);
  await missing(join(f.home, '.dsh'));
  const entries = (await f.engine.locks.read()).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].route, 'agents-folder');
  assert.equal(entries[0].digest, build.digest);
  const inventory = f.calls.filter(call => call.path === '/api/helper/inventory').at(-1)!.options!.body as SyncInventory;
  assert.deepEqual(inventory.deliveryErrors, []);
  assert.deepEqual(await listBackups(f.paths), []);
});

test('a pending service dialog leaves the lock free and cannot overlap a later eligible waiting set', { timeout: 30_000 }, async t => {
  const f = await fixture(t), first = f.build();
  const second = f.build(code('second waiting script'), { skillId: 'skill-second', name: 'second' });
  f.server(f.plan([f.item(first)]));
  const cli = await connectedCli(f), stop = new AbortController();
  let dialogs = 0, sleeps = 0, acquired = false, cancelled = false;
  await runCli(['service'], {
    ...cli.options, isTTY: false, signal: stop.signal,
    timing: { now: f.timing.now, sleep: async ms => {
      assert.equal(ms, 1000);
      if (++sleeps === 1) {
        assert.equal(dialogs, 1);
        await withWriteLock(f.paths, async () => { acquired = true; }, f.timing);
        f.server(f.plan([f.item(first), f.item(second)]));
        // Both the one-minute check and four-hour throttle are eligible now.
        f.advance(4 * 60 * 60 * 1000 + 60_000);
      } else stop.abort();
    } },
    runner: async (file, args, options) => {
      if (file === '/usr/sbin/scutil') return { stdout: 'Dialog-Test-Mac\n', stderr: '' };
      assert.equal(file, '/usr/bin/osascript');
      assert.match(args.join(' '), /giving up after 14340/u);
      assert.ok(options!.timeout! > 14_340_000);
      dialogs++;
      assert.ok(options?.signal);
      return new Promise<never>((_resolve, reject) => {
        options.signal!.addEventListener('abort', () => {
          cancelled = true;
          reject(new HelperError('COMMAND_FAILED', 'Cancelled dialog.'));
        }, { once: true });
      });
    },
  });
  assert.equal(sleeps, 2);
  assert.equal(acquired, true);
  assert.equal(dialogs, 1);
  assert.equal(cancelled, true);
  assert.equal(f.calls.filter(call => call.path === '/api/helper/plan').length, 2);
  assert.equal(await f.engine.holding.count(), 2);
  const notification = JSON.parse(await readFile(join(f.paths.data, 'notification-state.json'), 'utf8')) as { notifiedSets: string[] };
  assert.equal(notification.notifiedSets.length, 1);
});

for (const ending of ['pointer', 'prepared', 'fatal', 'SIGTERM'] as const) {
  test(`service ${ending} cancels the real pending dialog child, exits promptly and shows the set after restart`, { timeout: 15_000 }, async t => {
    const f = await fixture(t), build = f.build(), plan = f.plan([f.item(build)]);
    f.server(plan);
    const cli = await connectedCli(f);
    const state = await new StateStore(f.paths, new URL('https://ai.maddots.app')).read();
    const modules = {
      cli: fileURLToPath(new URL('../src/cli.ts', import.meta.url)),
      config: fileURLToPath(new URL('../src/config.ts', import.meta.url)),
      verify: fileURLToPath(new URL('../src/verify.ts', import.meta.url)),
    };
    const program = `
      import assert from 'node:assert/strict';
      import { runCli } from ${JSON.stringify(modules.cli)};
      import { HelperError, runCommand } from ${JSON.stringify(modules.config)};
      import { BuildVerifier } from ${JSON.stringify(modules.verify)};
      const ending = ${JSON.stringify(ending)};
      const state = ${JSON.stringify(state)};
      const build = ${JSON.stringify(build)}, plan = ${JSON.stringify(plan)};
      const stop = new AbortController();
      process.once('SIGTERM', () => stop.abort());
      let opened = false;
      const request = async input => {
        const path = new URL(String(input)).pathname;
        let data;
        if (path === '/api/helper/status') data = { ...state, pending: [] };
        else if (path === '/api/helper/inventory') data = { ok: true };
        else if (path === '/api/helper/plan') data = plan;
        else if (new URL(path, 'http://x').pathname === '/api/helper/builds/' + build.digest) data = build;
        else throw new Error('Unexpected service request: ' + path);
        return new Response(JSON.stringify({ data }));
      };
      const runner = (file, _args, options) => {
        if (file === '/usr/sbin/scutil') return Promise.resolve({ stdout: 'Shutdown-Test-Mac', stderr: '' });
        assert.equal(file, '/usr/bin/osascript');
        opened = true;
        process.stdout.write('dialog-opened\\n');
        return runCommand('/bin/sleep', ['6'], options);
      };
      await runCli(['service'], {
        home: ${JSON.stringify(f.home)},
        env: { MADDOTS_AI_HOME: ${JSON.stringify(f.paths.data)}, PATH: ${JSON.stringify(join(f.root, 'empty-bin'))}, MADDOTS_AI_AUTO_UPDATE: ending === 'prepared' ? '1' : '0' },
        request, runner, signal: stop.signal, output() {},
        verifier: new BuildVerifier({ keys: [{ keyId: ${JSON.stringify(f.keyId)}, publicKey: ${JSON.stringify(f.publicKey.toString('base64'))} }], env: {} }),
        timing: { now: () => ${f.timing.now()}, sleep: async () => {
          assert.ok(opened);
          if (ending === 'SIGTERM') { process.kill(process.pid, 'SIGTERM'); await new Promise(resolve => setImmediate(resolve)); }
          else throw new Error('Unexpected service sleep');
        } },
        watchRoute: () => ({ close() {} }),
        runtime: ${JSON.stringify(cli.options.runtime)},
        updates: {
          select: async () => {
            assert.ok(opened);
            if (ending === 'fatal') throw new Error('Fatal service failure');
            return { root: ending === 'pointer' ? '/selected-new-helper' : ${JSON.stringify(f.root)} };
          },
          check: async () => { assert.ok(opened); return { status: 'prepared', version: '0.2.0' }; },
        },
      }).then(() => {
        assert.equal(ending, 'SIGTERM'); process.stdout.write('loop-ended:SIGTERM\\n');
      }, error => {
        assert.ok(opened);
        assert.equal(error instanceof HelperError ? error.code : error.message, ending === 'fatal' ? 'Fatal service failure' : 'UPDATE_RESTART');
        process.stdout.write('loop-ended:' + ending + '\\n');
        process.exitCode = 1;
      });
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    let stdout = '', stderr = '';
    let loopEndedAt = 0;
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (!loopEndedAt && stdout.includes('loop-ended:')) loopEndedAt = Date.now();
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => resolve(code));
    });
    const elapsed = Date.now() - loopEndedAt;
    assert.equal(exitCode, ending === 'SIGTERM' ? 0 : 1, stderr);
    assert.match(stdout, /dialog-opened\nloop-ended:/u, stderr);
    assert.ok(loopEndedAt && elapsed < 2_000, `Service took ${elapsed} ms after its loop ended to exit with a six-second dialog child.`);
    assert.equal(await f.engine.holding.count(), 1);
    assert.deepEqual((await f.engine.locks.read()).entries, []);
    await missing(join(f.routes['agents-folder'], build.name));
    const notification = JSON.parse(await readFile(join(f.paths.data, 'notification-state.json'), 'utf8'));
    assert.equal(notification.interruptedSet, notification.notifiedSets[0]);

    const restarted = new AbortController();
    let shownAgain = 0;
    await runCli(['service'], {
      ...cli.options, signal: restarted.signal,
      timing: { now: f.timing.now, sleep: async () => {
        await new Promise<void>(resolve => setImmediate(resolve));
        restarted.abort();
      } },
      runner: async file => {
        if (file === '/usr/sbin/scutil') return { stdout: 'Shutdown-Test-Mac', stderr: '' };
        assert.equal(file, '/usr/bin/osascript');
        shownAgain++;
        return { stdout: 'button returned:Later, gave up:false', stderr: '' };
      },
    });
    assert.equal(shownAgain, 1);
    assert.equal(await f.engine.holding.count(), 1);
    const afterRestart = JSON.parse(await readFile(join(f.paths.data, 'notification-state.json'), 'utf8'));
    assert.equal(afterRestart.interruptedSet, undefined);
    assert.equal(afterRestart.notifiedSets.length, 1);
  });
}

test('300 one-second service ticks keep idle write locks and release selections on minute timers', async t => {
  const f = await fixture(t), empty = f.plan([], { degraded: true });
  // An unchanged cached plan returns 304, so this counts idle service work.
  // Degraded mode skips main's separate import retry lock on each 304 poll.
  await f.engine.applyPlan(empty);
  const cli = await connectedCli(f), stop = new AbortController();
  const originalOpen = fsPromises.open;
  let lockOpens = 0, selections = 0, sleeps = 0, plans = 0;
  fsPromises.open = async (path, flags, mode) => {
    if (String(path) === f.paths.lock && typeof flags === 'number' && (flags & constants.O_EXCL) !== 0) lockOpens++;
    return originalOpen(path, flags, mode);
  };
  syncBuiltinESMExports();
  try {
    await runCli(['service'], {
      ...cli.options, isTTY: false, signal: stop.signal,
      request: async (input, init) => {
        if (new URL(String(input)).pathname === '/api/helper/plan') {
          assert.equal(new Headers(init?.headers).get('if-none-match'), empty.planRevision);
          plans++;
          return new Response(null, { status: 304 });
        }
        return cli.options.request!(input, init);
      },
      timing: { now: f.timing.now, sleep: async ms => {
        assert.equal(ms, 1000); f.advance(ms);
        if (++sleeps === 300) stop.abort();
      } },
      updates: { select: async () => { selections++; return { root: f.root, version: '0.1.0' }; } },
      runner: async file => {
        assert.equal(file, '/usr/sbin/scutil');
        return { stdout: 'Idle-Test-Mac\n', stderr: '' };
      },
    });
  } finally {
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
  }
  assert.equal(sleeps, 300);
  assert.equal(plans, 5);
  assert.equal(cli.http.filter(path => path === '/api/helper/status').length, 5);
  assert.ok(lockOpens > 0 && lockOpens <= 16, `Idle service acquired ${lockOpens} write locks.`);
  assert.ok(selections > 0 && selections <= 5, `Idle service selected a release ${selections} times.`);
  assert.equal(f.calls.filter(call => call.path === '/api/helper/allow').length, 0);
});

test('the service finds a failed CLI Allow receipt within one minute despite a day-long plan poll', async t => {
  const f = await fixture(t), build = f.build();
  f.server(f.plan([f.item(build)], { pollAfterSeconds: 86400 }));
  const cli = await connectedCli(f), stop = new AbortController();
  const serviceReports: number[] = [];
  let sleeps = 0, failedAt = 0, plansAfterCli = 0;
  const runner: NonNullable<CliOptions['runner']> = async file => {
    if (file === '/usr/sbin/scutil') return { stdout: 'Retry-Test-Mac\n', stderr: '' };
    assert.equal(file, '/usr/bin/osascript');
    return { stdout: 'button returned:Later, gave up:false\n', stderr: '' };
  };
  await runCli(['service'], {
    ...cli.options, isTTY: false, signal: stop.signal, runner,
    request: async (input, init) => {
      if (new URL(String(input)).pathname === '/api/helper/allow') serviceReports.push(f.timing.now());
      return cli.options.request!(input, init);
    },
    timing: { now: f.timing.now, sleep: async ms => {
      assert.equal(ms, 1000);
      if (++sleeps === 1) {
        f.failReports(true);
        await runCli(['allow'], { ...cli.options, runner, confirm: async () => 'yes' });
        failedAt = f.timing.now();
        assert.ok(f.output.includes('Allow saved on this computer. The audit report is queued for retry.'));
        const receipts = await readdir(join(f.paths.data, 'allows'));
        assert.equal(receipts.length, 1);
        assert.equal(JSON.parse(await readFile(join(f.paths.data, 'allows', receipts[0]), 'utf8')).reported, false);
        plansAfterCli = f.calls.filter(call => call.path === '/api/helper/plan').length;
        f.failReports(false);
      }
      f.advance(ms);
      if (sleeps === 61) stop.abort();
    } },
  });
  assert.equal(serviceReports.length, 1);
  assert.ok(serviceReports[0] > failedAt && serviceReports[0] - failedAt <= 60_000);
  assert.equal(f.calls.filter(call => call.path === '/api/helper/plan').length, plansAfterCli);
  assert.equal(f.calls.filter(call => call.path === '/api/helper/allow').length, 2);
  const receipts = await readdir(join(f.paths.data, 'allows'));
  assert.equal(JSON.parse(await readFile(join(f.paths.data, 'allows', receipts[0]), 'utf8')).reported, true);
});
