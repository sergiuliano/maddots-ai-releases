import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { treeDigest } from '../src/shared/build-format.js';
import { planItemId } from '../src/shared/plan-item-id.js';
import { TOOL_MATRIX } from '../src/shared/tool-matrix.js';
import { ApiError, type ApiClient } from '../src/api.js';
import { listBackups, restoreBackup } from '../src/backups.js';
import { HelperError, readConfig } from '../src/config.js';
import { FolderDeliveryTarget } from '../src/delivery/index.js';
import { entryKey } from '../src/lock.js';
import { localEditNeedsQuestion } from '../src/local-edits.js';
import { atomicWrite, createPaths, ensurePaths } from '../src/paths.js';
import { readStamp } from '../src/stamp.js';
import { SyncEngine, type SyncOptions, type SyncPlan } from '../src/sync.js';
import { BuildVerifier, signedBuildString, type PlanItem, type SignedBuild } from '../src/verify.js';

async function fixture(externalData = false) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-sync-'));
  const home = join(root, 'home'); await mkdir(home, {mode: 0o700});
  const paths = await createPaths(readConfig(externalData ? {MADDOTS_AI_HOME: join(root, 'private-data')} : {}, home));
  await ensurePaths(paths);
  const route = join(home, '.agents/skills'); await mkdir(route, {recursive: true});
  const signer = generateKeyPairSync('ed25519');
  const publicKey = signer.publicKey.export({type: 'spki', format: 'der'}).subarray(-32);
  const keyId = createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
  const verifier = new BuildVerifier({keys: [{keyId, publicKey: publicKey.toString('base64')}], env: {}});
  const builds = new Map<string, SignedBuild>(), calls: {path: string; body?: unknown; headers?: HeadersInit}[] = [];
  let now = 1_760_000_000_000, currentPlan: SyncPlan | undefined;
  let failure: {path: string; code: string; status: number} | undefined, conditional304 = false;
  const client = {request: async (path: string, options: {body?: unknown; headers?: HeadersInit} = {}) => {
    calls.push({path, ...options});
    if (failure?.path === new URL(path, 'http://x').pathname || failure?.path === '*') throw new ApiError(failure!.code, failure!.status);
    if (path === '/api/helper/plan') {
      if (conditional304 && new Headers(options.headers).has('If-None-Match')) return {status: 304, headers: new Headers(), data: undefined};
      return {status: 200, headers: new Headers(), data: currentPlan};
    }
    if (path === '/api/helper/inventory') return {status: 200, headers: new Headers(), data: {ok: true}};
    if (path === '/api/helper/proposals') return {status: 201, headers: new Headers(), data: {proposalId: 'proposal-test'}};
    const build = builds.get(new URL(path, 'http://x').pathname.slice('/api/helper/builds/'.length));
    if (!build) throw new ApiError('BUILD_NOT_IN_PLAN', 404);
    return {status: 200, headers: new Headers(), data: structuredClone(build)};
  }} as Pick<ApiClient, 'request'>;
  const options: SyncOptions = {paths, helperId: 'helper-test', client, targets: [new FolderDeliveryTarget(paths, 'agents-folder', route)], verifier,
    watchRoute: () => ({close() {}}),
    timing: {now: () => now, sleep: async ms => {now += ms;}}};
  function build(version = 1, settingsRevision = 0, text = `Version ${version}`, changes: Partial<SignedBuild> = {}): SignedBuild {
    const content = Buffer.from(text), files = [{path: 'SKILL.md', mode: '100644' as const, size: content.length,
      sha256: createHash('sha256').update(content).digest('hex'), content: content.toString('base64')}];
    const result: SignedBuild = {format: 1, keyId, skillId: 'skill-test', version, settingsRevision, level: 'workspace', workspaceId: 'workspace-test', boardId: null,
      target: 'folder', name: 'example', hasCode: false, draft: false, files, report: {renamedFrom: null, unresolvedOptionalReferences: [], unsetSettings: []},
      digest: treeDigest([{path: 'SKILL.md', mode: '100644', content}]), signature: '', ...changes};
    result.signature = sign(null, Buffer.from(signedBuildString(result)), signer.privateKey).toString('base64');
    builds.set(result.digest, result); return result;
  }
  function item(build: SignedBuild, changes: Partial<PlanItem> & {localDigest?: string} = {}): PlanItem {
    const {localDigest, ...fields} = changes;
    const value: PlanItem = {itemId: createHash('sha256').update(JSON.stringify([build.skillId, build.version, build.settingsRevision, build.digest, fields])).digest('hex'),
      kind: 'install', skillId: build.skillId, name: build.name, sourceName: build.name, level: build.level, workspaceId: build.workspaceId,
      workspaceIds: [build.workspaceId], boardIds: build.boardId ? [build.boardId] : [], target: build.target, route: 'agents-folder', fromVersion: null,
      version: build.version, settingsRevision: build.settingsRevision, digest: build.digest, hasCode: build.hasCode, draft: build.draft,
      dependencyOf: null, missingDependencies: [], forAgentIds: [], state: 'approved', answer: 'update', reason: null, restartHints: [], ...fields};
    if (value.kind === 'local_newer' && !changes.itemId) value.itemId = planItemId({helperId: 'helper-test', ...value,
      agentId: value.forAgentIds[0] ?? null, localDigest: localDigest ?? null});
    return value;
  }
  const plan = (items: PlanItem[], changes: Partial<SyncPlan> = {}): SyncPlan => ({planRevision: createHash('sha256').update(JSON.stringify(items)).digest('hex'),
    degraded: false, pollAfterSeconds: 60, items, revoked: [], instructions: [], ...changes});
  return {root, home, paths, route, verifier, options, calls, builds, build, item, plan,
    engine: () => new SyncEngine(options), advance: (ms: number) => {now += ms;}, now: () => now,
    serverPlan: (value: SyncPlan) => {currentPlan = value;}, fail: (value?: typeof failure) => {failure = value;}, conditional: () => {conditional304 = true;},
    close: () => rm(root, {recursive: true, force: true})};
}
const missing = async (path: string) => assert.rejects(lstat(path), {code: 'ENOENT'});

test('TLS-19 inventory detects payload edits by digest and sends only bounded metadata', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(), build = f.build(); await engine.reconcile(); await engine.applyPlan(f.plan([f.item(build)]));
    await writeFile(join(f.route, 'example/.DS_Store'), 'ignored');
    await writeFile(join(f.route, 'example/.maddots/local-note.txt'), 'ignored');
    assert.equal((await engine.inventory()).managed[0].state, 'ok');
    await writeFile(join(f.route, 'example/SKILL.md'), 'Private local edit');
    const report = await engine.inventory(), digest = treeDigest([{path: 'SKILL.md', mode: '100644', content: Buffer.from('Private local edit')}]);
    assert.equal(report.managed[0].state, 'edited'); assert.equal(report.managed[0].localDigest, digest);
    assert.ok(!JSON.stringify(report).includes('Private local edit')); assert.ok(!JSON.stringify(report).includes(f.home));
    assert.deepEqual(Object.keys(report.managed[0]).sort(), ['skillId', 'target', 'name', 'version', 'settingsRevision', 'digest', 'localDigest', 'state'].sort());
  } finally {await f.close();}
});

test('TLS-19 Keep saves the exact pair, leaves files, survives restart and permits newer updates', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(), build = f.build(); await engine.reconcile(); await engine.applyPlan(f.plan([f.item(build)]));
    const text = 'Keep these local edits'; await writeFile(join(f.route, 'example/SKILL.md'), text);
    const localDigest = (await engine.inventory()).managed[0].localDigest!;
    const keep = f.item(build, {kind: 'local_newer', state: 'kept_local', answer: 'keep_local', localDigest, fromVersion: 1});
    const requests = f.calls.length; await engine.applyPlan(f.plan([keep]));
    const entry = (await engine.locks.read()).entries[0];
    assert.deepEqual(entry.keepLocal, {version: 1, localDigest}); assert.equal(entry.digest, build.digest);
    assert.equal(await readFile(join(f.route, 'example/SKILL.md'), 'utf8'), text); assert.equal(f.calls.length, requests);
    assert.equal(localEditNeedsQuestion(entry, localDigest), false);
    assert.equal(localEditNeedsQuestion(entry, localDigest, 2), true);
    assert.equal(localEditNeedsQuestion(entry, 'a'.repeat(64)), true);
    const restart = f.engine(); await restart.reconcile(); await restart.applyPlan(f.plan([keep]));
    assert.equal((await restart.locks.read()).entries[0].keepLocal?.localDigest, localDigest);
    assert.equal((await listBackups(f.paths)).length, 0);
    const newer = f.build(2); await restart.applyPlan(f.plan([f.item(newer, {kind: 'update', fromVersion: 1})]));
    assert.equal((await restart.locks.read()).entries[0].keepLocal, null);
    const backup = (await listBackups(f.paths))[0];
    assert.equal(await readFile(join(f.paths.backups, backup.id, backup.route, backup.folderName, 'SKILL.md'), 'utf8'), text);
  } finally {await f.close();}
});

test('TLS-19 proposal requires the recorded instruction and clean scan, reverses settings, and sends once after restart', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(), content = '---\nname: example\ndescription: A local guide\nmetadata:\n  maddots_version: 1\n  team: docs\n---\nWorks best with: Sample Model\nUse Example Company.\n';
    const build = f.build(1, 0, content); await engine.reconcile(); await engine.applyPlan(f.plan([f.item(build)]));
    await writeFile(join(f.route, 'example/SKILL.md'), content + 'A useful local change.\n');
    const localDigest = (await engine.inventory()).managed[0].localDigest!;
    const item = f.item(build, {kind: 'local_newer', answer: 'send_proposal', localDigest, fromVersion: 1});
    const instruction = {type: 'send_proposal', itemId: item.itemId, intent: 'proposal', baseVersion: 1,
      placeholders: [{name: 'brand_name', value: 'Example Company'}], nameMap: [], modelLine: 'Works best with: Sample Model'};
    await engine.applyPlan(f.plan([item])); assert.equal(f.calls.filter(call => call.path === '/api/helper/proposals').length, 0);
    await engine.applyPlan(f.plan([{...item, state: 'asking'}], {instructions: [instruction]}));
    assert.equal(f.calls.filter(call => call.path === '/api/helper/proposals').length, 0);
    const plan = f.plan([item], {instructions: [instruction]}); await engine.applyPlan(plan);
    const uploads = f.calls.filter(call => call.path === '/api/helper/proposals'); assert.equal(uploads.length, 1);
    const upload = uploads[0].body as {files: {content: string}[]; localDigest: string};
    const source = Buffer.from(upload.files[0].content, 'base64').toString('utf8');
    assert.ok(source.includes('{{brand_name}}')); assert.ok(source.includes('A useful local change.'));
    assert.ok(!source.includes('Example Company')); assert.ok(!source.includes('Works best with:')); assert.ok(!source.includes('maddots_version'));
    assert.equal(upload.localDigest, localDigest);
    await engine.applyPlan(plan); const restarted = f.engine(); await restarted.reconcile(); await restarted.applyPlan(plan);
    assert.equal(f.calls.filter(call => call.path === '/api/helper/proposals').length, 1);
    assert.equal(await readFile(join(f.route, 'example/SKILL.md'), 'utf8'), content + 'A useful local change.\n');
  } finally {await f.close();}
});

test('TLS-19 blocked proposals and stale Keep/Replace choices preserve content and never upload', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(), build = f.build(1, 0, '---\nname: example\ndescription: A guide\n---\nOriginal\n');
    await engine.reconcile(); await engine.applyPlan(f.plan([f.item(build)]));
    const text = '---\nname: example\ndescription: A guide\n---\n' + 'mdai_skill_' + 'A'.repeat(43);
    await writeFile(join(f.route, 'example/SKILL.md'), text);
    const localDigest = (await engine.inventory()).managed[0].localDigest!;
    const item = f.item(build, {kind: 'local_newer', answer: 'send_proposal', localDigest, fromVersion: 1});
    await engine.applyPlan(f.plan([item], {instructions: [{type: 'send_proposal', itemId: item.itemId, intent: 'proposal', baseVersion: 1, placeholders: [], nameMap: [], modelLine: null}]}));
    assert.equal((await engine.inventory()).deliveryErrors[0].code, 'PROPOSAL_SCAN_BLOCKED');
    assert.equal(f.calls.filter(call => call.path === '/api/helper/proposals').length, 0);
    await writeFile(join(f.route, 'example/SKILL.md'), 'Changed after choice');
    for (const answer of ['keep_local', 'replace'] as const) {
      await engine.applyPlan(f.plan([f.item(build, {kind: 'local_newer', answer, state: answer === 'keep_local' ? 'kept_local' : 'approved', localDigest, fromVersion: 1})]));
      assert.equal((await engine.inventory()).deliveryErrors[0].code, 'LOCAL_EDIT_CHANGED');
    }
    assert.equal(await readFile(join(f.route, 'example/SKILL.md'), 'utf8'), 'Changed after choice');
    assert.equal((await listBackups(f.paths)).length, 0); assert.equal((await engine.locks.read()).entries[0].keepLocal, null);
  } finally {await f.close();}
});

test('TLS-19 Replace backs up exact edits, completes once, and does not replace later edits on replay', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(), build = f.build(); await engine.reconcile(); await engine.applyPlan(f.plan([f.item(build)]));
    await writeFile(join(f.route, 'example/SKILL.md'), 'Preserve me');
    const localDigest = (await engine.inventory()).managed[0].localDigest!;
    const item = f.item(build, {kind: 'local_newer', answer: 'replace', localDigest, fromVersion: 1}), plan = f.plan([item]);
    await engine.applyPlan(plan); assert.equal(await readFile(join(f.route, 'example/SKILL.md'), 'utf8'), 'Version 1');
    const backup = (await listBackups(f.paths))[0];
    assert.equal(await readFile(join(f.paths.backups, backup.id, backup.route, backup.folderName, 'SKILL.md'), 'utf8'), 'Preserve me');
    await writeFile(join(f.route, 'example/SKILL.md'), 'A later edit');
    const restarted = f.engine(); await restarted.reconcile(); await restarted.applyPlan(plan);
    assert.equal(await readFile(join(f.route, 'example/SKILL.md'), 'utf8'), 'A later edit'); assert.equal((await listBackups(f.paths)).length, 1);
  } finally {await f.close();}
});

test('TLS-19 code Replace backs up before holding and requires Allow for that replacement', async () => {
  const f = await fixture();
  try {
    f.options.allowedBuild = async () => true;
    const engine = f.engine(), build = f.build(1, 0, '! original command'); await engine.reconcile(); await engine.applyPlan(f.plan([f.item(build)]));
    await writeFile(join(f.route, 'example/SKILL.md'), '! locally changed command');
    const localDigest = (await engine.inventory()).managed[0].localDigest!;
    const item = f.item(build, {kind: 'local_newer', answer: 'replace', localDigest, fromVersion: 1}), plan = f.plan([item]);
    await engine.applyPlan(plan); await missing(join(f.route, 'example'));
    assert.equal((await engine.inventory()).managed[0].state, 'held'); assert.equal((await engine.inventory()).holdingCount, 1);
    const waiting = await engine.holding.waiting(); assert.equal(waiting.length, 1);
    assert.deepEqual(waiting[0].digests, [build.digest]); assert.equal(waiting[0].entries[0].item.itemId, item.itemId);
    assert.equal((await engine.holding.entries()).length, 1);
    const backup = (await listBackups(f.paths))[0];
    assert.equal(await readFile(join(f.paths.backups, backup.id, backup.route, backup.folderName, 'SKILL.md'), 'utf8'), '! locally changed command');
    await engine.applyPlan(plan); await missing(join(f.route, 'example')); assert.equal((await listBackups(f.paths)).length, 1);
    f.options.allowedReplacement = async (_build, choice) => choice.itemId === item.itemId;
    await engine.applyPlan(plan); assert.equal(await readFile(join(f.route, 'example/SKILL.md'), 'utf8'), '! original command');
    assert.equal((await engine.inventory()).holdingCount, 0);
  } finally {await f.close();}
});

test('TLS-19 a copy recreated during code holding survives the stale Replace choice', async () => {
  const f = await fixture();
  try {
    f.options.allowedBuild = async () => true;
    const engine = f.engine(), build = f.build(1, 0, '! original command'); await engine.reconcile(); await engine.applyPlan(f.plan([f.item(build)]));
    await writeFile(join(f.route, 'example/SKILL.md'), '! chosen edit');
    const item = f.item(build, {kind: 'local_newer', answer: 'replace', localDigest: (await engine.inventory()).managed[0].localDigest!, fromVersion: 1});
    const plan = f.plan([item]); await engine.applyPlan(plan); await missing(join(f.route, 'example'));
    await mkdir(join(f.route, 'example')); await writeFile(join(f.route, 'example/SKILL.md'), 'Created while holding');
    f.options.allowedReplacement = async () => true; await engine.applyPlan(plan);
    assert.equal(await readFile(join(f.route, 'example/SKILL.md'), 'utf8'), 'Created while holding');
    assert.equal((await engine.inventory()).deliveryErrors[0].code, 'LOCAL_EDIT_CHANGED'); assert.equal((await listBackups(f.paths)).length, 1);
  } finally {await f.close();}
});

for (const step of ['staged', 'backed_up', 'placed', 'locked'] as const) test(`TLS-19 Replace interrupted at ${step} recovers once without overwriting a later edit`, async () => {
  const f = await fixture();
  try {
    const engine = f.engine(), build = f.build(), newer = f.build(2); await engine.reconcile(); await engine.applyPlan(f.plan([f.item(build)]));
    await writeFile(join(f.route, 'example/SKILL.md'), 'Chosen local copy');
    const item = f.item(newer, {kind: 'local_newer', answer: 'replace', localDigest: (await engine.inventory()).managed[0].localDigest!, fromVersion: 1});
    const plan = f.plan([item]); f.options.crash = where => {if (where === step) throw new Error('Injected crash');};
    await engine.applyPlan(plan); f.options.crash = undefined;
    const restart = f.engine(); await restart.reconcile();
    assert.equal(await readFile(join(f.route, 'example/SKILL.md'), 'utf8'), 'Version 2');
    await writeFile(join(f.route, 'example/SKILL.md'), 'After recovered replace'); await restart.applyPlan(plan);
    assert.equal(await readFile(join(f.route, 'example/SKILL.md'), 'utf8'), 'After recovered replace');
    const backups = await listBackups(f.paths); assert.equal(backups.length, 1);
    assert.equal(await readFile(join(f.paths.backups, backups[0].id, backups[0].route, backups[0].folderName, 'SKILL.md'), 'utf8'), 'Chosen local copy');
  } finally {await f.close();}
});

test('TLS-19 Claude equal-pair Replace refreshes once, waits for its digest, and preserves one snapshot', async () => {
  const f = await fixture(), previous = TOOL_MATRIX.routes['claude-plugin'].readPath;
  try {
    const root = join(f.home, '.maddots-ai/claude-code'), readRoot = join(f.home, '.claude/plugins/cache/maddots-ai');
    await mkdir(root, {recursive: true}); await mkdir(readRoot, {recursive: true});
    TOOL_MATRIX.routes['claude-plugin'].readPath = '~/.claude/plugins/cache/maddots-ai';
    let refreshes = 0, changes = 0;
    f.options.targets = [{route: 'claude-plugin', target: 'claude-plugin', root: () => root, folderFor: entry => join(root, entry.name),
      place: async (build, staged) => { const {durableRename} = await import('../src/safe-fs.js'); await durableRename(staged, join(root, build.name)); }, remove: async () => {},
      afterChange: async () => { changes++; },
      refreshReadCopy: async entry => { refreshes++; await cp(join(root, entry.name), join(readRoot, entry.name), {recursive: true}); }}];
    const engine = f.engine(), build = f.build(1, 0, 'Claude source', {target: 'claude-plugin'});
    const install = f.item(build, {route: 'claude-plugin'}); await engine.reconcile(); await engine.applyPlan(f.plan([install]));
    await cp(join(root, 'example'), join(readRoot, 'example'), {recursive: true});
    await writeFile(join(readRoot, 'example/SKILL.md'), 'Edited tool cache');
    const local = (await engine.inventory()).managed[0]; assert.equal(local.state, 'edited');
    const watched: string[] = [], controller = new AbortController();
    f.options.watchRoute = path => {watched.push(path); return {close() {}};};
    f.options.timing = {now: f.now, sleep: async () => {controller.abort();}};
    f.serverPlan(f.plan([])); await f.engine().run(controller.signal); assert.deepEqual(watched, [readRoot]);
    const replace = f.item(build, {route: 'claude-plugin', kind: 'local_newer', answer: 'replace', localDigest: local.localDigest!, fromVersion: 1});
    const plan = f.plan([replace]), receipt = join(f.paths.data, 'local-choices', replace.itemId + '.replace.json');
    const beforeChanges = changes; await engine.applyPlan(plan);
    assert.equal(refreshes, 1); assert.equal(changes, beforeChanges + 1);
    assert.notEqual(JSON.parse(await readFile(receipt, 'utf8')).completed, true);
    assert.equal(await readFile(join(root, 'example/SKILL.md'), 'utf8'), 'Claude source');
    assert.equal(await readFile(join(readRoot, 'example/SKILL.md'), 'utf8'), 'Claude source');
    const refreshed = (await engine.inventory()).managed[0];
    assert.equal(refreshed.state, 'ok'); assert.equal(refreshed.localDigest, build.digest);
    await engine.applyPlan(plan); assert.equal(JSON.parse(await readFile(receipt, 'utf8')).completed, true);
    await engine.applyPlan(plan); assert.equal(refreshes, 1); assert.equal((await listBackups(f.paths)).length, 1);
    const snapshot = (await listBackups(f.paths)).find(backup => backup.restorePath)!; assert.ok(snapshot);
    assert.equal(await readFile(join(f.paths.backups, snapshot.id, snapshot.route, snapshot.folderName, 'SKILL.md'), 'utf8'), 'Edited tool cache');
    await rm(readRoot, {recursive: true}); assert.ok((await listBackups(f.paths)).some(backup => backup.id === snapshot.id));
    await restoreBackup(f.paths, snapshot.id);
    assert.equal(await readFile(join(root, 'example/SKILL.md'), 'utf8'), 'Edited tool cache');
    await missing(readRoot);
  } finally {TOOL_MATRIX.routes['claude-plugin'].readPath = previous; await f.close();}
});

const proposalInstruction = (item: PlanItem) => ({type: 'send_proposal', itemId: item.itemId,
  intent: item.answer === 'publish' ? 'publish' : 'proposal', baseVersion: item.fromVersion ?? item.version,
  placeholders: [], nameMap: [], modelLine: null});
const proposalCalls = (f: Awaited<ReturnType<typeof fixture>>) => f.calls.filter(call => call.path === '/api/helper/proposals').length;
const syncRevision = async (f: Awaited<ReturnType<typeof fixture>>) => JSON.parse(await readFile(join(f.paths.data, 'sync-meta.json'), 'utf8')).planRevision;

for (const mode of ['unavailable', 'deferred', 'throws', 'disappears'] as const) {
  test(`TLS-19 Claude Replace ${mode} refresh keeps its receipt pending until the read copy matches`, async () => {
    const f = await fixture(), previous = TOOL_MATRIX.routes['claude-plugin'].readPath;
    try {
      const root = join(f.home, '.maddots-ai/claude-code'), readRoot = join(f.home, '.claude/plugins/cache/maddots-ai');
      await mkdir(root, {recursive: true}); await mkdir(readRoot, {recursive: true});
      TOOL_MATRIX.routes['claude-plugin'].readPath = '~/.claude/plugins/cache/maddots-ai';
      let refreshes = 0, placements = 0;
      const target: SyncOptions['targets'][number] = {route: 'claude-plugin', target: 'claude-plugin', root: () => root,
        folderFor: entry => join(root, entry.name), remove: async () => {},
        place: async (build, staged) => { placements++; const {durableRename} = await import('../src/safe-fs.js'); await durableRename(staged, join(root, build.name)); }};
      if (mode !== 'unavailable') target.refreshReadCopy = async () => {
        refreshes++;
        if (mode === 'throws') throw new HelperError('TOOL_REFRESH_FAILED', 'Injected tool failure');
        if (mode === 'disappears') {
          if (refreshes === 1) await rm(join(readRoot, 'example'), {recursive: true});
          else await cp(join(root, 'example'), join(readRoot, 'example'), {recursive: true});
        }
      };
      f.options.targets = [target];
      const engine = f.engine(), build = f.build(1, 0, 'Claude source', {target: 'claude-plugin'});
      await engine.reconcile(); await engine.applyPlan(f.plan([f.item(build, {route: 'claude-plugin'})]));
      await cp(join(root, 'example'), join(readRoot, 'example'), {recursive: true}); await writeFile(join(readRoot, 'example/SKILL.md'), 'Edited cache');
      const item = f.item(build, {route: 'claude-plugin', kind: 'local_newer', answer: 'replace', localDigest: (await engine.inventory()).managed[0].localDigest!});
      const plan = f.plan([item]), oldRevision = await syncRevision(f), receipt = join(f.paths.data, 'local-choices', item.itemId + '.replace.json');
      await engine.applyPlan(plan);
      assert.notEqual(JSON.parse(await readFile(receipt, 'utf8')).completed, true);
      if (mode === 'disappears') {
        await missing(join(readRoot, 'example')); await engine.applyPlan(plan);
        assert.notEqual(JSON.parse(await readFile(receipt, 'utf8')).completed, true);
        assert.equal(await syncRevision(f), oldRevision); assert.deepEqual((await engine.inventory()).deliveryErrors, []);
      } else assert.equal(await readFile(join(readRoot, 'example/SKILL.md'), 'utf8'), 'Edited cache');
      assert.equal(await syncRevision(f), oldRevision); assert.equal(placements, 1);
      if (mode === 'unavailable' || mode === 'throws') assert.equal((await engine.inventory()).deliveryErrors[0].code, mode === 'unavailable' ? 'LOCAL_EDIT_REFRESH_UNAVAILABLE' : 'TOOL_REFRESH_FAILED');
      // The tool completes the requested refresh, then the same protocol item can finish.
      await cp(join(root, 'example'), join(readRoot, 'example'), {recursive: true});
      const restart = f.engine(); await restart.reconcile(); await restart.applyPlan(plan);
      assert.equal(JSON.parse(await readFile(receipt, 'utf8')).completed, true); assert.equal((await listBackups(f.paths)).length, 1);
      assert.equal(refreshes, mode === 'unavailable' ? 0 : mode === 'disappears' ? 2 : 1); assert.equal((await restart.inventory()).managed[0].state, 'ok');
      assert.deepEqual((await restart.inventory()).deliveryErrors, []); assert.equal(await syncRevision(f), plan.planRevision);
    } finally {TOOL_MATRIX.routes['claude-plugin'].readPath = previous; await f.close();}
  });
}

for (const mode of ['unavailable', 'throws'] as const) for (const next of ['forced_remove', 'update'] as const) {
  test(`TLS-19 R2 full-placement Replace with ${mode} refresh clears its journal and permits ${next}`, async () => {
    const f = await fixture(), previous = TOOL_MATRIX.routes['claude-plugin'].readPath;
    try {
      const root = join(f.home, '.maddots-ai/claude-code'), readRoot = join(f.home, '.claude/plugins/cache/maddots-ai');
      await mkdir(root, {recursive: true}); await mkdir(readRoot, {recursive: true});
      TOOL_MATRIX.routes['claude-plugin'].readPath = '~/.claude/plugins/cache/maddots-ai';
      let refreshes = 0, removals = 0;
      const target: SyncOptions['targets'][number] = {route: 'claude-plugin', target: 'claude-plugin', root: () => root,
        folderFor: entry => join(root, entry.name),
        place: async (build, staged) => { const {durableRename} = await import('../src/safe-fs.js'); await durableRename(staged, join(root, build.name)); },
        remove: async (_entry, reason) => {assert.equal(reason, 'security_fix'); removals++;}};
      if (mode === 'throws') target.refreshReadCopy = async () => {refreshes++; throw new HelperError('TOOL_REFRESH_FAILED', 'Injected refresh failure');};
      f.options.targets = [target];
      const engine = f.engine(), v1 = f.build(1, 0, 'Claude v1', {target: 'claude-plugin'}), v2 = f.build(2, 0, 'Claude v2', {target: 'claude-plugin'});
      await engine.reconcile(); await engine.applyPlan(f.plan([f.item(v1, {route: 'claude-plugin'})]));
      await cp(join(root, 'example'), join(readRoot, 'example'), {recursive: true}); await writeFile(join(readRoot, 'example/SKILL.md'), 'Edited v1 cache');
      const item = f.item(v2, {route: 'claude-plugin', kind: 'local_newer', answer: 'replace', fromVersion: 1,
        localDigest: (await engine.inventory()).managed[0].localDigest!}), plan = f.plan([item]);
      await engine.applyPlan(plan);
      assert.deepEqual(await engine.locks.allPending(), []);
      assert.equal((await engine.locks.read()).entries[0].digest, v2.digest);
      assert.equal(await readFile(join(root, 'example/SKILL.md'), 'utf8'), 'Claude v2');
      assert.equal(await readFile(join(readRoot, 'example/SKILL.md'), 'utf8'), 'Edited v1 cache');
      assert.equal((await listBackups(f.paths)).length, 2);
      const errors = (await engine.inventory()).deliveryErrors;
      if (mode === 'throws') assert.equal(errors[0].code, 'TOOL_REFRESH_FAILED');
      else assert.deepEqual(errors, []);
      const restart = f.engine(); await restart.reconcile();
      if (mode === 'throws') {
        await restart.applyPlan(plan);
        assert.equal(refreshes, 2); assert.deepEqual(await restart.locks.allPending(), []);
        assert.equal((await restart.inventory()).deliveryErrors[0].code, 'TOOL_REFRESH_FAILED');
        assert.equal((await listBackups(f.paths)).length, 2);
      }
      const v3 = f.build(3, 0, 'Claude v3', {target: 'claude-plugin'});
      const followup = f.plan([f.item(next === 'forced_remove' ? v2 : v3, {route: 'claude-plugin', kind: next, fromVersion: 2,
        ...(next === 'forced_remove' ? {state: 'forced' as const, reason: 'security_fix'} : {})})]);
      await restart.applyPlan(followup);
      assert.deepEqual(await restart.locks.allPending(), []); assert.deepEqual((await restart.inventory()).deliveryErrors, []);
      assert.equal(await syncRevision(f), followup.planRevision);
      const entry = (await restart.locks.read()).entries[0];
      if (next === 'forced_remove') {
        assert.equal(entry.removed, true); assert.equal(removals, 1); await missing(join(root, 'example'));
      } else {
        assert.equal(entry.version, 3); assert.equal(entry.digest, v3.digest); assert.equal(removals, 0);
        assert.equal(await readFile(join(root, 'example/SKILL.md'), 'utf8'), 'Claude v3');
      }
    } finally {TOOL_MATRIX.routes['claude-plugin'].readPath = previous; await f.close();}
  });
}

for (const failure of ['refresh_api', 'after_change'] as const) {
  test(`TLS-19 R2 full-placement ${failure} failure clears its journal, defers revision, and permits unrelated delivery`, async () => {
    const f = await fixture(), previous = TOOL_MATRIX.routes['claude-plugin'].readPath;
    try {
      const root = join(f.home, '.maddots-ai/claude-code'), readRoot = join(f.home, '.claude/plugins/cache/maddots-ai');
      await mkdir(root, {recursive: true}); await mkdir(readRoot, {recursive: true});
      TOOL_MATRIX.routes['claude-plugin'].readPath = '~/.claude/plugins/cache/maddots-ai';
      let failAfterChange = false, refreshes = 0;
      f.options.targets = [{route: 'claude-plugin', target: 'claude-plugin', root: () => root, folderFor: entry => join(root, entry.name),
        place: async (build, staged) => {const {durableRename} = await import('../src/safe-fs.js'); await durableRename(staged, join(root, build.name));},
        remove: async () => {},
        afterChange: async () => {if (failAfterChange) {failAfterChange = false; throw new HelperError('TOOL_CHANGE_FAILED', 'Injected change failure');}},
        refreshReadCopy: async () => {refreshes++; throw new ApiError('API_UNAVAILABLE', 503);}}];
      const engine = f.engine(), v1 = f.build(1, 0, 'Claude v1', {target: 'claude-plugin'}), v2 = f.build(2, 0, 'Claude v2', {target: 'claude-plugin'});
      await engine.reconcile(); await engine.applyPlan(f.plan([f.item(v1, {route: 'claude-plugin'})]));
      await cp(join(root, 'example'), join(readRoot, 'example'), {recursive: true}); await writeFile(join(readRoot, 'example/SKILL.md'), 'Edited v1 cache');
      const item = f.item(v2, {route: 'claude-plugin', kind: 'local_newer', answer: 'replace', fromVersion: 1,
        localDigest: (await engine.inventory()).managed[0].localDigest!});
      const unrelated = f.build(1, 0, 'Unrelated source', {target: 'claude-plugin', skillId: 'skill-other', name: 'other'});
      const oldRevision = await syncRevision(f), plan = f.plan([item, f.item(unrelated, {route: 'claude-plugin'})]);
      failAfterChange = failure === 'after_change';
      await assert.doesNotReject(engine.applyPlan(plan));
      assert.deepEqual(await engine.locks.allPending(), []); assert.equal(await syncRevision(f), oldRevision);
      assert.equal(await readFile(join(root, 'example/SKILL.md'), 'utf8'), 'Claude v2');
      assert.equal(await readFile(join(root, 'other/SKILL.md'), 'utf8'), 'Unrelated source');
      assert.equal((await engine.locks.read()).entries.find(entry => entry.skillId === v2.skillId)?.digest, v2.digest);
      const error = (await engine.inventory()).deliveryErrors.find(entry => entry.skillId === v2.skillId);
      assert.equal(error?.code, failure === 'refresh_api' ? 'API_UNAVAILABLE' : 'TOOL_CHANGE_FAILED');
      assert.equal(refreshes, failure === 'refresh_api' ? 1 : 0);
      await assert.doesNotReject(engine.applyPlan(plan));
      assert.deepEqual(await engine.locks.allPending(), []); assert.equal(await syncRevision(f), oldRevision);
      assert.equal(await readFile(join(root, 'other/SKILL.md'), 'utf8'), 'Unrelated source');
      assert.equal((await engine.inventory()).deliveryErrors.find(entry => entry.skillId === v2.skillId)?.code, 'API_UNAVAILABLE');
    } finally {TOOL_MATRIX.routes['claude-plugin'].readPath = previous; await f.close();}
  });
}

for (const mode of ['unavailable', 'throws'] as const) {
  test(`TLS-19 R2 recovered Replace with ${mode} refresh clears its journal before forced removal`, async () => {
    const f = await fixture(), previous = TOOL_MATRIX.routes['claude-plugin'].readPath;
    try {
      const root = join(f.home, '.maddots-ai/claude-code'), readRoot = join(f.home, '.claude/plugins/cache/maddots-ai');
      await mkdir(root, {recursive: true}); await mkdir(readRoot, {recursive: true});
      TOOL_MATRIX.routes['claude-plugin'].readPath = '~/.claude/plugins/cache/maddots-ai';
      let refreshes = 0, removals = 0;
      const target: SyncOptions['targets'][number] = {route: 'claude-plugin', target: 'claude-plugin', root: () => root,
        folderFor: entry => join(root, entry.name),
        place: async (build, staged) => { const {durableRename} = await import('../src/safe-fs.js'); await durableRename(staged, join(root, build.name)); },
        remove: async () => {removals++;}};
      if (mode === 'throws') target.refreshReadCopy = async () => {refreshes++; throw new HelperError('TOOL_REFRESH_FAILED', 'Injected refresh failure');};
      f.options.targets = [target];
      const engine = f.engine(), v1 = f.build(1, 0, 'Claude v1', {target: 'claude-plugin'}), v2 = f.build(2, 0, 'Claude v2', {target: 'claude-plugin'});
      await engine.reconcile(); await engine.applyPlan(f.plan([f.item(v1, {route: 'claude-plugin'})]));
      await cp(join(root, 'example'), join(readRoot, 'example'), {recursive: true}); await writeFile(join(readRoot, 'example/SKILL.md'), 'Edited v1 cache');
      const item = f.item(v2, {route: 'claude-plugin', kind: 'local_newer', answer: 'replace', fromVersion: 1,
        localDigest: (await engine.inventory()).managed[0].localDigest!});
      f.options.crash = step => {if (step === 'placed') throw new Error('Injected placement interruption');};
      await engine.applyPlan(f.plan([item])); assert.equal((await engine.locks.allPending()).length, 1); f.options.crash = undefined;
      const restart = f.engine(); await restart.reconcile();
      assert.deepEqual(await restart.locks.allPending(), []); assert.equal(refreshes, 0);
      const receipt = JSON.parse(await readFile(join(f.paths.data, 'local-choices', item.itemId + '.replace.json'), 'utf8'));
      assert.equal(receipt.placed, true); assert.notEqual(receipt.completed, true);
      assert.equal(await readFile(join(root, 'example/SKILL.md'), 'utf8'), 'Claude v2');
      assert.deepEqual((await restart.inventory()).deliveryErrors, []);
      if (mode === 'throws') {
        await restart.applyPlan(f.plan([item])); assert.equal(refreshes, 1);
        assert.deepEqual(await restart.locks.allPending(), []);
        assert.equal((await restart.inventory()).deliveryErrors[0].code, 'TOOL_REFRESH_FAILED');
      }
      const removal = f.plan([f.item(v2, {route: 'claude-plugin', kind: 'forced_remove', state: 'forced', reason: 'security_fix'})]);
      await restart.applyPlan(removal);
      assert.equal(removals, 1); assert.equal((await restart.locks.read()).entries[0].removed, true);
      await missing(join(root, 'example')); assert.deepEqual(await restart.locks.allPending(), []);
      assert.equal(await syncRevision(f), removal.planRevision); assert.deepEqual((await restart.inventory()).deliveryErrors, []);
    } finally {TOOL_MATRIX.routes['claude-plugin'].readPath = previous; await f.close();}
  });
}

test('TLS-19 R2 placed code Replace reuses its allowed digest through deferred refresh and restart', async () => {
  const f = await fixture(), previous = TOOL_MATRIX.routes['claude-plugin'].readPath;
  try {
    const root = join(f.home, '.maddots-ai/claude-code'), readRoot = join(f.home, '.claude/plugins/cache/maddots-ai');
    await mkdir(root, {recursive: true}); await mkdir(readRoot, {recursive: true});
    TOOL_MATRIX.routes['claude-plugin'].readPath = '~/.claude/plugins/cache/maddots-ai';
    let allowances = 0, refreshes = 0, placements = 0;
    f.options.targets = [{route: 'claude-plugin', target: 'claude-plugin', root: () => root, folderFor: entry => join(root, entry.name),
      place: async (build, staged) => {placements++; const {durableRename} = await import('../src/safe-fs.js'); await durableRename(staged, join(root, build.name));},
      remove: async () => {}, refreshReadCopy: async () => {refreshes++;}}];
    f.options.allowedBuild = async () => true;
    f.options.allowedReplacement = async () => ++allowances === 1;
    const engine = f.engine(), build = f.build(1, 0, '! Claude source', {target: 'claude-plugin'});
    await engine.reconcile(); await engine.applyPlan(f.plan([f.item(build, {route: 'claude-plugin'})]));
    await cp(join(root, 'example'), join(readRoot, 'example'), {recursive: true}); await writeFile(join(readRoot, 'example/SKILL.md'), '! Edited cache');
    const item = f.item(build, {route: 'claude-plugin', kind: 'local_newer', answer: 'replace', fromVersion: 1,
      localDigest: (await engine.inventory()).managed[0].localDigest!}), plan = f.plan([item]);
    const receipt = join(f.paths.data, 'local-choices', item.itemId + '.replace.json');
    await engine.applyPlan(plan); await missing(join(root, 'example')); assert.equal((await engine.inventory()).holdingCount, 1);
    assert.equal(allowances, 0);
    await engine.applyPlan(plan);
    assert.equal(allowances, 1); assert.equal(refreshes, 1);
    assert.equal(JSON.parse(await readFile(receipt, 'utf8')).placed, true);
    assert.ok((await engine.locks.read()).entries[0].allowedDigests.includes(build.digest));
    const restart = f.engine(); await restart.reconcile();
    for (let retry = 0; retry < 3; retry++) {
      await restart.applyPlan(plan);
      assert.equal(allowances, 1); assert.equal(placements, 2);
      assert.equal(await readFile(join(root, 'example/SKILL.md'), 'utf8'), '! Claude source');
      assert.equal((await restart.inventory()).holdingCount, 0); assert.deepEqual((await restart.inventory()).deliveryErrors, []);
      assert.equal((await listBackups(f.paths)).length, 2); assert.deepEqual(await restart.locks.allPending(), []);
      assert.notEqual(JSON.parse(await readFile(receipt, 'utf8')).completed, true);
    }
    await cp(join(root, 'example'), join(readRoot, 'example'), {recursive: true});
    await restart.applyPlan(plan); await restart.applyPlan(plan);
    assert.equal(JSON.parse(await readFile(receipt, 'utf8')).completed, true); assert.equal(allowances, 1);
    assert.equal((await restart.inventory()).managed[0].state, 'ok'); assert.equal((await restart.inventory()).holdingCount, 0);
    assert.equal((await listBackups(f.paths)).length, 2); assert.equal(await syncRevision(f), plan.planRevision);
  } finally {TOOL_MATRIX.routes['claude-plugin'].readPath = previous; await f.close();}
});

for (const interruptHold of [false, true, 'later_cache_edit'] as const) {
  test(`TLS-19 Claude code Replace ${interruptHold === 'later_cache_edit' ? 'refuses a cache changed after interrupted holding' :
    'preserves Allow through refresh' + (interruptHold ? ' after interrupted holding and a missing cache' : '')}`, async () => {
    const f = await fixture(), previous = TOOL_MATRIX.routes['claude-plugin'].readPath;
    try {
      const root = join(f.home, '.maddots-ai/claude-code'), readRoot = join(f.home, '.claude/plugins/cache/maddots-ai');
      await mkdir(root, {recursive: true}); await mkdir(readRoot, {recursive: true});
      TOOL_MATRIX.routes['claude-plugin'].readPath = '~/.claude/plugins/cache/maddots-ai';
      let refreshes = 0;
      f.options.targets = [{route: 'claude-plugin', target: 'claude-plugin', root: () => root, folderFor: entry => join(root, entry.name),
        place: async (build, staged) => { const {durableRename} = await import('../src/safe-fs.js'); await durableRename(staged, join(root, build.name)); },
        remove: async () => {}, refreshReadCopy: async entry => {refreshes++; await cp(join(root, entry.name), join(readRoot, entry.name), {recursive: true});}}];
      f.options.allowedBuild = async () => true;
      const engine = f.engine(), build = f.build(1, 0, '! Claude source', {target: 'claude-plugin'});
      await engine.reconcile(); await engine.applyPlan(f.plan([f.item(build, {route: 'claude-plugin'})]));
      await cp(join(root, 'example'), join(readRoot, 'example'), {recursive: true}); await writeFile(join(readRoot, 'example/SKILL.md'), '! Edited cache');
      const item = f.item(build, {route: 'claude-plugin', kind: 'local_newer', answer: 'replace', localDigest: (await engine.inventory()).managed[0].localDigest!});
      const plan = f.plan([item]), receipt = join(f.paths.data, 'local-choices', item.itemId + '.replace.json');
      if (interruptHold) f.options.hold = async () => {throw new Error('Injected hold failure');};
      await engine.applyPlan(plan); await missing(join(root, 'example'));
      if (interruptHold) {
        f.options.hold = undefined;
        if (interruptHold === 'later_cache_edit') await writeFile(join(readRoot, 'example/SKILL.md'), '! Cache changed after the answer');
        else await rm(join(readRoot, 'example'), {recursive: true});
      }
      const restart = f.engine(); await restart.reconcile(); await restart.applyPlan(plan);
      if (interruptHold === 'later_cache_edit') {
        assert.equal((await restart.inventory()).deliveryErrors[0].code, 'LOCAL_EDIT_CHANGED');
        assert.equal((await restart.inventory()).holdingCount, 0); assert.equal((await listBackups(f.paths)).length, 2);
        assert.equal(await readFile(join(readRoot, 'example/SKILL.md'), 'utf8'), '! Cache changed after the answer');
        f.options.allowedReplacement = async () => true; await restart.applyPlan(plan); await missing(join(root, 'example'));
        assert.equal(refreshes, 0); return;
      }
      assert.deepEqual((await restart.inventory()).deliveryErrors, []); assert.equal((await restart.inventory()).holdingCount, 1);
      f.options.allowedReplacement = async () => true; await restart.applyPlan(plan);
      assert.equal(refreshes, 1); assert.notEqual(JSON.parse(await readFile(receipt, 'utf8')).completed, true);
      await restart.applyPlan(plan); await restart.applyPlan(plan);
      assert.equal(JSON.parse(await readFile(receipt, 'utf8')).completed, true); assert.equal(refreshes, 1);
      assert.equal((await restart.inventory()).managed[0].state, 'ok'); assert.equal((await restart.inventory()).holdingCount, 0);
      assert.deepEqual((await restart.inventory()).deliveryErrors, []);
      const backups = await listBackups(f.paths); assert.equal(backups.length, 2);
      assert.equal(backups.filter(backup => backup.reason === 'local_read_copy').length, 1);
      assert.equal(await readFile(join(root, 'example/SKILL.md'), 'utf8'), '! Claude source');
    } finally {TOOL_MATRIX.routes['claude-plugin'].readPath = previous; await f.close();}
  });
}

for (const [code, status] of [['BLOCKED_SECRET', 422], ['FORBIDDEN', 403], ['CONFLICT', 409]] as const) {
  test(`TLS-19 proposal refusal ${code} stays on its item while an unrelated install and revision complete`, async () => {
    const f = await fixture();
    try {
      const engine = f.engine(), build = f.build(); await engine.reconcile(); await engine.applyPlan(f.plan([f.item(build)]));
      await writeFile(join(f.route, 'example/SKILL.md'), 'A local proposal');
      const item = f.item(build, {kind: 'local_newer', answer: 'send_proposal', localDigest: (await engine.inventory()).managed[0].localDigest!});
      const other = f.build(1, 0, 'Unrelated install', {skillId: 'skill-other', name: 'other'});
      const plan = f.plan([item, f.item(other)], {instructions: [proposalInstruction(item)]});
      f.fail({path: '/api/helper/proposals', code, status}); await engine.applyPlan(plan);
      assert.equal(await readFile(join(f.route, 'other/SKILL.md'), 'utf8'), 'Unrelated install');
      assert.deepEqual((await engine.inventory()).deliveryErrors, [{skillId: item.skillId, target: item.target, name: item.name, code}]);
      await missing(join(f.paths.data, 'local-choices', item.itemId + '.proposal.json'));
      assert.equal(await syncRevision(f), plan.planRevision);
    } finally {await f.close();}
  });
}

for (const failure of [{code: 'API_TIMEOUT', status: 0}, {code: 'READ_ONLY', status: 503}, {code: 'RATE_LIMITED', status: 429}, {code: 'REQUEST_TIMEOUT', status: 408}]) {
  test(`TLS-19 transient upload ${failure.code} allows later items and retains the revision for retry`, async () => {
    const f = await fixture();
    try {
      const engine = f.engine(), build = f.build(); await engine.reconcile(); await engine.applyPlan(f.plan([f.item(build)]));
      const oldRevision = await syncRevision(f); await writeFile(join(f.route, 'example/SKILL.md'), 'A local proposal');
      const item = f.item(build, {kind: 'local_newer', answer: 'send_proposal', localDigest: (await engine.inventory()).managed[0].localDigest!});
      const other = f.build(1, 0, 'Unrelated install', {skillId: 'skill-other', name: 'other'});
      const plan = f.plan([item, f.item(other)], {instructions: [proposalInstruction(item)]});
      f.fail({path: '/api/helper/proposals', ...failure}); await assert.rejects(engine.applyPlan(plan), {code: failure.code});
      assert.equal(await readFile(join(f.route, 'other/SKILL.md'), 'utf8'), 'Unrelated install'); assert.equal(await syncRevision(f), oldRevision);
      f.fail({path: '/api/helper/proposals', code: 'PROPOSAL_ALREADY_UPLOADED', status: 409});
      f.serverPlan(plan); await engine.tick();
      assert.equal(await syncRevision(f), plan.planRevision); assert.equal(proposalCalls(f), 2);
      await engine.applyPlan(plan); assert.equal(proposalCalls(f), 2); assert.deepEqual((await engine.inventory()).deliveryErrors, []);
    } finally {await f.close();}
  });
}

test('TLS-19 restart after proposal_sent writes the duplicate receipt and keeps polling without failure backoff', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(), build = f.build(); await engine.reconcile(); await engine.applyPlan(f.plan([f.item(build)]));
    await writeFile(join(f.route, 'example/SKILL.md'), 'A chosen local proposal');
    const item = f.item(build, {kind: 'local_newer', answer: 'send_proposal', localDigest: (await engine.inventory()).managed[0].localDigest!});
    const other = f.build(1, 0, 'Unrelated install', {skillId: 'skill-other', name: 'other'});
    const plan = f.plan([item, f.item(other)], {instructions: [proposalInstruction(item)]});
    f.options.crash = step => { if (step === 'proposal_sent') throw new Error('Injected crash after committed upload'); };
    await engine.applyPlan(plan); assert.equal(proposalCalls(f), 1);
    await missing(join(f.paths.data, 'local-choices', item.itemId + '.proposal.json'));
    f.options.crash = undefined; f.fail({path: '/api/helper/proposals', code: 'PROPOSAL_ALREADY_UPLOADED', status: 409}); f.serverPlan(plan);
    const restart = f.engine(); await restart.tick();
    assert.equal(JSON.parse(await readFile(join(f.paths.data, 'local-choices', item.itemId + '.proposal.json'), 'utf8')).localDigest,
      (await restart.inventory()).managed.find(entry => entry.name === 'example')!.localDigest);
    assert.equal(await readFile(join(f.route, 'other/SKILL.md'), 'utf8'), 'Unrelated install');
    assert.equal(restart.retryAt, f.now() + 60_000); assert.equal(await syncRevision(f), plan.planRevision);
    f.advance(60_000); await restart.tick(); assert.equal(proposalCalls(f), 2); assert.deepEqual((await restart.inventory()).deliveryErrors, []);
  } finally {await f.close();}
});

for (const answer of ['keep_local', 'send_proposal', 'publish', 'replace'] as const) {
  test(`TLS-19 contract-shaped ${answer} binds the answered digest and refuses a later edit`, async () => {
    const f = await fixture();
    try {
      const engine = f.engine(), build = f.build(); await engine.reconcile(); await engine.applyPlan(f.plan([f.item(build)]));
      await writeFile(join(f.route, 'example/SKILL.md'), 'Answered copy');
      const localDigest = (await engine.inventory()).managed[0].localDigest!;
      const item = f.item(build, {kind: 'local_newer', answer, state: answer === 'keep_local' ? 'kept_local' : 'approved', localDigest});
      assert.ok(!Object.hasOwn(item, 'localDigest'));
      assert.equal(item.itemId, createHash('sha256').update(['helper-test', build.skillId, build.target, build.workspaceId,
        build.name, 'local_newer', String(build.version), String(build.settingsRevision), '', localDigest].join('\n')).digest('hex'));
      const plan = f.plan([item], {instructions: [proposalInstruction(item)]});
      await writeFile(join(f.route, 'example/SKILL.md'), 'Changed after answer'); await engine.applyPlan(plan);
      assert.equal((await engine.inventory()).deliveryErrors[0].code, 'LOCAL_EDIT_CHANGED'); assert.equal(proposalCalls(f), 0);
      assert.equal((await listBackups(f.paths)).length, 0); assert.equal(await readFile(join(f.route, 'example/SKILL.md'), 'utf8'), 'Changed after answer');
      await writeFile(join(f.route, 'example/SKILL.md'), 'Answered copy'); await engine.applyPlan(plan);
      assert.deepEqual((await engine.inventory()).deliveryErrors, []);
      if (answer === 'keep_local') assert.deepEqual((await engine.locks.read()).entries[0].keepLocal, {version: build.version, localDigest});
      else if (answer === 'replace') assert.equal(await readFile(join(f.route, 'example/SKILL.md'), 'utf8'), 'Version 1');
      else assert.equal(proposalCalls(f), 1);
    } finally {await f.close();}
  });
}

for (const answer of ['replace', 'keep_local', 'publish'] as const) {
  test(`TLS-19 one stable item can change from send_proposal to ${answer}`, async () => {
    const f = await fixture();
    try {
      const engine = f.engine(), build = f.build(); await engine.reconcile(); await engine.applyPlan(f.plan([f.item(build)]));
      await writeFile(join(f.route, 'example/SKILL.md'), 'Keep my proposal edit');
      const localDigest = (await engine.inventory()).managed[0].localDigest!;
      const item = f.item(build, {kind: 'local_newer', answer: 'send_proposal', localDigest});
      await engine.applyPlan(f.plan([item], {instructions: [proposalInstruction(item)]})); assert.equal(proposalCalls(f), 1);
      const next = f.item(build, {kind: 'local_newer', answer, localDigest, state: answer === 'keep_local' ? 'kept_local' : 'approved'});
      assert.equal(next.itemId, item.itemId); await engine.applyPlan(f.plan([next], {instructions: [proposalInstruction(next)]}));
      assert.deepEqual((await engine.inventory()).deliveryErrors, []); assert.equal(proposalCalls(f), 1);
      if (answer === 'replace') {
        const backup = (await listBackups(f.paths))[0]; assert.equal((await listBackups(f.paths)).length, 1);
        assert.equal(await readFile(join(f.paths.backups, backup.id, backup.route, backup.folderName, 'SKILL.md'), 'utf8'), 'Keep my proposal edit');
        assert.equal(await readFile(join(f.route, 'example/SKILL.md'), 'utf8'), 'Version 1');
      } else if (answer === 'keep_local') assert.deepEqual((await engine.locks.read()).entries[0].keepLocal, {version: 1, localDigest});
    } finally {await f.close();}
  });
}

for (const crash of ['hold_callback', 'holding'] as const) {
  test(`TLS-19 code Replace resumes after ${crash} fails with one backup and a later Allow`, async () => {
    const f = await fixture();
    try {
      f.options.allowedBuild = async () => true;
      const engine = f.engine(), build = f.build(1, 0, '! original command'); await engine.reconcile(); await engine.applyPlan(f.plan([f.item(build)]));
      await writeFile(join(f.route, 'example/SKILL.md'), '! chosen edit');
      const item = f.item(build, {kind: 'local_newer', answer: 'replace', localDigest: (await engine.inventory()).managed[0].localDigest!});
      const plan = f.plan([item]);
      if (crash === 'hold_callback') f.options.hold = async () => { throw new Error('Injected hold failure'); };
      else f.options.crash = step => {if (step === 'holding') throw new Error('Injected crash after holding');};
      await engine.applyPlan(plan); await missing(join(f.route, 'example'));
      f.options.hold = undefined; f.options.crash = undefined;
      const restart = f.engine(); await restart.reconcile(); await restart.applyPlan(plan);
      assert.equal((await restart.inventory()).managed[0].state, 'held'); assert.deepEqual((await restart.inventory()).deliveryErrors, []);
      f.options.allowedReplacement = async () => true; await restart.applyPlan(plan);
      assert.equal(await readFile(join(f.route, 'example/SKILL.md'), 'utf8'), '! original command');
      assert.equal((await restart.inventory()).managed[0].state, 'ok'); assert.equal((await restart.inventory()).holdingCount, 0);
      assert.equal((await listBackups(f.paths)).length, 1);
    } finally {await f.close();}
  });
}

test('asking, later and kept-local items never download or write skill folders', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const build = f.build();
    for (const state of ['asking', 'later', 'kept_local'] as const) await engine.applyPlan(f.plan([f.item(build, {state})]));
    await missing(join(f.route, build.name)); assert.equal(f.calls.length, 0); assert.equal((await engine.locks.read()).entries.length, 0);
  } finally {await f.close();}
});
test('approved install/update/Always write one folder, a signed stamp, a private lock and preserved backups', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const v1 = f.build(), v2 = f.build(2);
    const install = f.item(v1);
    await engine.applyPlan(f.plan([install, f.item(v1, {itemId: 'a'.repeat(64)})]));
    assert.ok(f.calls.some(call => call.path === '/api/helper/builds/' + v1.digest + '?itemId=' + install.itemId));
    assert.equal((await engine.locks.read()).entries.length, 1);
    const update = f.item(v2, {kind: 'update', answer: 'always'}); await engine.applyPlan(f.plan([update]));
    const entry = (await engine.locks.read()).entries[0], stamp = await readStamp(join(f.route, 'example'), f.verifier, ['helper-test']);
    assert.equal(entry.acceptedBy, 'always'); assert.equal(entry.previous?.digest, v1.digest); assert.equal(stamp.digest, entry.digest);
    assert.equal((await lstat(join(f.paths.data, 'lock.json'))).mode & 0o777, 0o600);
    assert.equal((await listBackups(f.paths)).length, 1);
    await engine.applyPlan(f.plan([update])); assert.equal((await listBackups(f.paths)).length, 1);
    assert.equal((await engine.verifiedBuild(v2.digest)).build.version, 2);
    await assert.rejects(engine.verifiedBuild(v1.digest), /accepted version/);
  } finally {await f.close();}
});
test('degraded security fix removes and restores exactly previous in one plan; local edits survive in backup', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const v1 = f.build(), v2 = f.build(2);
    await engine.applyPlan(f.plan([f.item(v1)])); await engine.applyPlan(f.plan([f.item(v2, {kind: 'update'})]));
    await writeFile(join(f.route, 'example/SKILL.md'), 'Local edits');
    const remove = f.item(v2, {kind: 'forced_remove', state: 'forced', reason: 'security_fix', missingDependencies: ['missing-skill']});
    const restore = f.item(v1, {kind: 'forced_restore', state: 'forced', reason: 'security_fix'});
    await engine.applyPlan(f.plan([remove, restore], {degraded: true, revoked: [{skillId: v2.skillId, digest: v2.digest}]}));
    assert.equal(await readFile(join(f.route, 'example/SKILL.md'), 'utf8'), 'Version 1');
    assert.equal((await engine.locks.read()).entries[0].previous, null);
    const backups = await listBackups(f.paths); assert.equal(backups.length, 2);
    assert.ok((await Promise.all(backups.map(b => readFile(join(f.paths.backups, b.id, b.route, b.folderName, 'SKILL.md'), 'utf8')))).includes('Local edits'));
    await engine.applyPlan(f.plan([restore])); assert.equal((await listBackups(f.paths)).length, 2);
  } finally {await f.close();}
});
test('forced effects cannot install or restore arbitrary content; removal keeps downgrade floor', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const v1 = f.build(), v2 = f.build(2);
    await engine.applyPlan(f.plan([f.item(v2)]));
    await engine.applyPlan(f.plan([f.item(v1, {state: 'forced'})]));
    assert.equal((await engine.inventory()).deliveryErrors[0].code, 'FORCED_EFFECT_INVALID');
    await engine.applyPlan(f.plan([f.item(v1, {kind: 'forced_restore', state: 'forced'})]));
    assert.equal((await engine.inventory()).deliveryErrors[0].code, 'BUILD_RESTORE_INVALID');
    await engine.applyPlan(f.plan([f.item(v2, {kind: 'forced_remove', state: 'forced', reason: 'revoked'})]));
    await missing(join(f.route, 'example')); assert.equal((await engine.locks.read()).entries[0].version, 2);
    await engine.applyPlan(f.plan([f.item(v1)])); await missing(join(f.route, 'example'));
    assert.equal((await engine.inventory()).deliveryErrors[0].code, 'BUILD_ROLLBACK');
  } finally {await f.close();}
});
for (const step of ['staged', 'backed_up', 'placed', 'locked'] as const) test(`crash at ${step} recovers stamp and lock, including an external data home`, async () => {
  const f = await fixture(step === 'backed_up');
  try {
    const engine = f.engine(); await engine.reconcile(); const v1 = f.build(), v2 = f.build(2);
    await engine.applyPlan(f.plan([f.item(v1)]));
    f.options.crash = where => {if (where === step) throw new Error('Injected crash');};
    await engine.applyPlan(f.plan([f.item(v2, {kind: 'update'})]));
    assert.ok(await engine.locks.pending(entryKey(v2))); f.options.crash = undefined;
    const restarted = f.engine(); await restarted.reconcile();
    assert.equal((await restarted.locks.read()).entries[0].digest, v2.digest);
    assert.equal((await restarted.inventory()).managed[0].state, 'ok'); assert.equal(await restarted.locks.pending(entryKey(v2)), null);
    assert.equal((await listBackups(f.paths)).length, 1);
  } finally {await f.close();}
});
test('new revocation cancels interrupted staging before it can become visible', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const v1 = f.build(), v2 = f.build(2);
    await engine.applyPlan(f.plan([f.item(v1)])); f.options.crash = step => {if (step === 'staged') throw new Error('Crash');};
    await engine.applyPlan(f.plan([f.item(v2, {kind: 'update'})])); f.options.crash = undefined;
    await engine.applyPlan(f.plan([], {revoked: [{skillId: v2.skillId, digest: v2.digest}]}));
    assert.equal(await readFile(join(f.route, 'example/SKILL.md'), 'utf8'), 'Version 1'); assert.equal(await engine.locks.pending(entryKey(v2)), null);
  } finally {await f.close();}
});
test('local code detection holds builds, including agent caches, and a new version needs a new Allow', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const v1 = f.build(1, 0, '! run command');
    await engine.applyPlan(f.plan([f.item(v1)])); await missing(join(f.route, 'example'));
    assert.equal((await engine.inventory()).holdingCount, 1); await assert.rejects(engine.verifiedBuild(v1.digest));
    f.options.allowedBuild = async build => build.version === 1;
    await engine.applyPlan(f.plan([f.item(v1)])); assert.equal((await engine.verifiedBuild(v1.digest)).hasCode, true);
    assert.equal((await engine.inventory()).holdingCount, 0);
    const v2 = f.build(2, 0, '! run command'); await engine.applyPlan(f.plan([f.item(v2, {kind: 'update'})]));
    assert.equal((await engine.locks.read()).entries[0].version, 1);
    const agent = f.item(v2, {forAgentIds: ['agent-one']}); await engine.applyPlan(f.plan([agent]));
    await assert.rejects(engine.verifiedBuild(v2.digest, 'agent-one'));
    assert.equal((await engine.agentLocks.read()).entries.length, 0);
  } finally {await f.close();}
});
test('agent-only builds never reach routes, have independent acceptance and reject per-agent rollback', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const v1 = f.build(), v2 = f.build(2);
    await engine.applyPlan(f.plan([f.item(v2, {forAgentIds: ['agent-one']}), f.item(v1, {forAgentIds: ['agent-two']})]));
    await missing(join(f.route, 'example')); assert.equal((await engine.locks.read()).entries.length, 0);
    assert.equal((await engine.verifiedBuild(v2.digest, 'agent-one')).build.version, 2);
    assert.equal((await engine.verifiedBuild(v1.digest, 'agent-two')).build.version, 1);
    await engine.applyPlan(f.plan([f.item(v1, {forAgentIds: ['agent-one']})]));
    assert.equal((await engine.agentLocks.read()).entries.find(entry => entry.agentId === 'agent-one')?.version, 2);
    await assert.rejects(engine.verifiedBuild(v1.digest, 'agent-one'));
    // Identical content still keeps distinct signed versions for each agent.
    const same2 = f.build(3, 0, 'Version 1'); await engine.applyPlan(f.plan([f.item(same2, {forAgentIds: ['agent-one']})]));
    assert.equal((await engine.verifiedBuild(v1.digest, 'agent-two')).build.version, 1);
    assert.equal((await engine.verifiedBuild(same2.digest, 'agent-one')).build.version, 3);
  } finally {await f.close();}
});
test('equal-pair Replace and missing redelivery work; equal-pair different digest and older settings fail', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const v1 = f.build(1, 8);
    await engine.applyPlan(f.plan([f.item(v1)])); await writeFile(join(f.route, 'example/SKILL.md'), 'Local edits');
    await engine.applyPlan(f.plan([f.item(v1, {kind: 'local_newer', answer: 'replace', localDigest: (await engine.inventory()).managed[0].localDigest!})]));
    assert.equal(await readFile(join(f.route, 'example/SKILL.md'), 'utf8'), 'Version 1');
    await rm(join(f.route, 'example'), {recursive: true}); await engine.applyPlan(f.plan([f.item(v1)]));
    assert.equal((await engine.inventory()).managed[0].state, 'ok');
    const different = f.build(1, 8, 'Different'); await engine.applyPlan(f.plan([f.item(different)]));
    assert.equal((await engine.inventory()).deliveryErrors[0].code, 'BUILD_ROLLBACK');
    const board = f.build(1, 9, 'Board render', {level: 'board', boardId: 'board-test'});
    await engine.applyPlan(f.plan([f.item(board)])); assert.equal((await engine.locks.read()).entries[0].settingsRevision, 9);
  } finally {await f.close();}
});
test('reconcile verifies stamp signatures and reports edited/missing without deleting local contents', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const build = f.build(); await engine.applyPlan(f.plan([f.item(build)]));
    const path = join(f.route, 'example/.maddots/skill.json'), stamp = JSON.parse(await readFile(path, 'utf8'));
    stamp.signature = Buffer.alloc(64).toString('base64'); await atomicWrite(path, JSON.stringify(stamp));
    const restarted = f.engine(); await restarted.reconcile(); assert.equal((await restarted.inventory()).managed[0].state, 'edited');
    assert.equal(await readFile(join(f.route, 'example/SKILL.md'), 'utf8'), 'Version 1');
    await rm(join(f.route, 'example'), {recursive: true}); assert.equal((await restarted.inventory()).managed[0].state, 'missing');
  } finally {await f.close();}
});
test('unmanaged destinations and symlinked routes are preserved and refused', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const build = f.build();
    await mkdir(join(f.route, 'example')); await writeFile(join(f.route, 'example/SKILL.md'), 'Unmanaged');
    await engine.applyPlan(f.plan([f.item(build)])); assert.equal((await engine.inventory()).deliveryErrors[0].code, 'UNMANAGED_CONFLICT');
    assert.equal(await readFile(join(f.route, 'example/SKILL.md'), 'utf8'), 'Unmanaged'); assert.equal((await listBackups(f.paths)).length, 0);
    await rm(f.route, {recursive: true}); await symlink(join(f.home, 'other'), f.route);
    await engine.applyPlan(f.plan([f.item(build)])); assert.equal((await engine.inventory()).deliveryErrors[0].code, 'PATH_UNSAFE');
  } finally {await f.close();}
});
test('cache files are reverified on read and revocation immediately prevents serving an accepted digest', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const build = f.build(); await engine.applyPlan(f.plan([f.item(build)]));
    const variant = join(f.paths.data, 'cache/builds', build.digest + '-' + createHash('sha256').update(build.signature).digest('hex') + '.json');
    const bad = structuredClone(build); bad.files[0].content = Buffer.from('Tampered!').toString('base64'); await atomicWrite(variant, JSON.stringify(bad));
    await assert.rejects(engine.verifiedBuild(build.digest)); await atomicWrite(variant, JSON.stringify(build));
    await engine.applyPlan(f.plan([], {revoked: [{skillId: build.skillId, digest: build.digest}]}));
    await assert.rejects(engine.verifiedBuild(build.digest), /BUILD_REVOKED/);
    assert.equal(await readFile(join(f.route, 'example/SKILL.md'), 'utf8'), 'Version 1');
  } finally {await f.close();}
});
test('build 404 retries without ETag, then succeeds; TOKEN errors stop the sync loop', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(), build = f.build(); f.serverPlan(f.plan([f.item(build)]));
    f.fail({path: '/api/helper/builds/' + build.digest, code: 'BUILD_NOT_IN_PLAN', status: 404}); await engine.tick();
    assert.equal(engine.retryAt, f.now() + 60_000); f.advance(60_000); f.fail(); f.conditional(); await engine.tick();
    assert.equal(await readFile(join(f.route, 'example/SKILL.md'), 'utf8'), 'Version 1');
    const planCalls = f.calls.filter(call => call.path === '/api/helper/plan'); assert.equal(new Headers(planCalls[1].headers).has('If-None-Match'), false);
    f.advance(60_000); f.serverPlan(f.plan([f.item(f.build(2))]));
    f.fail({path: '/api/helper/plan', code: 'TOKEN_REVOKED', status: 401}); await assert.rejects(engine.tick(), /disconnected/);
    const count = f.calls.length; f.advance(86400_000); await engine.tick(); assert.equal(f.calls.length, count);
  } finally {await f.close();}
});
test('server 404 for seven days backs off to daily and never removes installed skills', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const build = f.build(); await engine.applyPlan(f.plan([f.item(build)]));
    f.fail({path: '*', code: 'NOT_FOUND', status: 404}); await engine.tick();
    for (let count = 0; count < 7; count++) {f.advance(engine.retryAt - f.now()); await engine.tick();}
    assert.equal(engine.retryAt - f.now(), 1800_000);
    f.advance(7 * 86400_000); await engine.tick(); assert.equal(engine.retryAt - f.now(), 86400_000);
    assert.equal(await readFile(join(f.route, 'example/SKILL.md'), 'utf8'), 'Version 1');
  } finally {await f.close();}
});
test('watched changes report within ten seconds independently of plan cadence; inventories repeat every ten minutes', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); f.serverPlan(f.plan([], {pollAfterSeconds: 600})); await engine.tick(); f.conditional();
    engine.notifyChange(); f.advance(1000); await engine.tick();
    assert.equal(f.calls.filter(call => call.path === '/api/helper/inventory').length, 2);
    f.advance(599_000); await engine.tick();
    assert.equal(f.calls.filter(call => call.path === '/api/helper/inventory').length, 2);
    f.advance(1000); await engine.tick(); assert.equal(f.calls.filter(call => call.path === '/api/helper/inventory').length, 3);
    assert.ok(new Headers(f.calls.filter(call => call.path === '/api/helper/plan').at(-1)?.headers).has('If-None-Match'));
  } finally {await f.close();}
});
test('hard dependencies in holding prevent dependent delivery and approval without an answer is refused', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const main = f.build(), code = f.build(1, 0, '! command', {name: 'dependency', skillId: 'skill-dependency'});
    const parent = f.item(main), dependency = f.item(code, {dependencyOf: parent.itemId});
    await engine.applyPlan(f.plan([parent, dependency])); await missing(join(f.route, 'example')); await missing(join(f.route, 'dependency'));
    assert.equal((await engine.inventory()).deliveryErrors.find(entry => entry.skillId === main.skillId)?.code, 'DEPENDENCY_HELD');
    await engine.applyPlan(f.plan([f.item(main, {answer: null})])); await missing(join(f.route, 'example'));
  } finally {await f.close();}
});
test('archived agent cache acceptance is inactive until exact previous restoration; interactive acceptance is independent', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const v1 = f.build(), v2 = f.build(2);
    await engine.applyPlan(f.plan([f.item(v1), f.item(v1, {forAgentIds: ['agent-one']})]));
    assert.equal((await engine.agentLocks.read()).entries.length, 1);
    await engine.applyPlan(f.plan([f.item(v2, {kind: 'update', forAgentIds: ['agent-one']})]));
    await engine.applyPlan(f.plan([f.item(v2, {kind: 'forced_remove', state: 'forced', reason: 'archived', forAgentIds: ['agent-one']})]));
    await assert.rejects(engine.verifiedBuild(v2.digest, 'agent-one'));
    assert.equal((await engine.verifiedBuild(v1.digest)).build.version, 1);
    await engine.applyPlan(f.plan([f.item(v1, {kind: 'forced_restore', state: 'forced', reason: 'security_fix', forAgentIds: ['agent-one']})]));
    assert.equal((await engine.verifiedBuild(v1.digest, 'agent-one')).build.version, 1);
    await engine.applyPlan(f.plan([f.item(v1, {kind: 'forced_restore', state: 'forced', reason: 'security_fix', forAgentIds: ['agent-one']})]));
    assert.equal((await engine.inventory()).deliveryErrors.length, 0);
    await engine.applyPlan(f.plan([f.item(v1, {kind: 'forced_remove', state: 'forced', reason: 'archived'})]));
    await assert.rejects(engine.verifiedBuild(v1.digest));
    assert.equal((await engine.locks.read()).entries[0].removed, true);
    await restoreBackup(f.paths, (await listBackups(f.paths))[0].id);
    await engine.applyPlan(f.plan([f.item(v1)]));
    assert.equal((await engine.verifiedBuild(v1.digest)).build.version, 1);
    assert.equal((await engine.locks.read()).entries[0].removed, undefined);
  } finally {await f.close();}
});
test('the adapter cannot redirect an allowed route to another home folder', async () => {
  const f = await fixture();
  try {
    const documents = join(f.home, 'Documents'); await mkdir(documents);
    f.options.targets = [new FolderDeliveryTarget(f.paths, 'agents-folder', documents)];
    const engine = f.engine(); await engine.reconcile(); const build = f.build(); await engine.applyPlan(f.plan([f.item(build)]));
    await missing(join(documents, 'example')); assert.equal((await engine.inventory()).deliveryErrors[0].code, 'ROUTE_INVALID');
  } finally {await f.close();}
});
test('an engine cache read observes revocations recorded by a different sync instance', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const build = f.build(); await engine.applyPlan(f.plan([f.item(build)]));
    const other = f.engine(); await other.reconcile(); await other.applyPlan(f.plan([], {revoked: [{skillId: build.skillId, digest: build.digest}]}));
    await assert.rejects(engine.verifiedBuild(build.digest), /BUILD_REVOKED/);
  } finally {await f.close();}
});
test('the protocol requires a separate stable plan item per agent and refuses combined prior histories', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const v1 = f.build(), v2 = f.build(2);
    await engine.applyPlan(f.plan([f.item(v1, {forAgentIds: ['agent-one']}), f.item(v2, {forAgentIds: ['agent-two']})]));
    await assert.rejects(engine.applyPlan(f.plan([f.item(f.build(3), {forAgentIds: ['agent-one', 'agent-two']})])), /sync item is invalid/);
    assert.equal((await engine.verifiedBuild(v1.digest, 'agent-one')).build.version, 1);
    assert.equal((await engine.verifiedBuild(v2.digest, 'agent-two')).build.version, 2);
  } finally {await f.close();}
});
test('the service watches only registered routes, debounces changes and closes watchers on shutdown', async () => {
  const f = await fixture();
  try {
    const controller = new AbortController(); let changed: (() => void) | undefined, closed = false, sleeps = 0;
    f.options.watchRoute = (root, callback) => {assert.equal(root, f.route); changed = callback; return {close: () => {closed = true;}};};
    f.options.timing = {now: f.now, sleep: async ms => {
      if (++sleeps === 1) {changed!(); changed!(); f.advance(ms);} else controller.abort();
    }};
    f.serverPlan(f.plan([], {pollAfterSeconds: 600}));
    await f.engine().run(controller.signal);
    assert.equal(closed, true); assert.equal(f.calls.filter(call => call.path === '/api/helper/inventory').length, 2);
  } finally {await f.close();}
});
test('a conservative has-code classification from the plan survives the cache boundary', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const build = f.build(); const item = f.item(build, {hasCode: true, forAgentIds: ['agent-one']});
    await engine.applyPlan(f.plan([item]));
    assert.equal(JSON.parse(await readFile(join(f.paths.data, 'cache/builds', build.digest + '.json'), 'utf8')).hasCode, true);
    await assert.rejects(engine.verifiedBuild(build.digest, 'agent-one'));
    f.options.allowedBuild = async () => true; await engine.applyPlan(f.plan([item]));
    assert.equal((await engine.verifiedBuild(build.digest, 'agent-one')).hasCode, true);
  } finally {await f.close();}
});

test('persistent placement failure restores the prior copy and does not block a revoked sibling', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile();
    const a1 = f.build(), a2 = f.build(2), b = f.build(1, 0, 'Beta', {skillId: 'skill-beta', name: 'beta'});
    await engine.applyPlan(f.plan([f.item(a1), f.item(b)]));
    const target = f.options.targets[0], place = target.place.bind(target);
    target.place = async (build, staged) => {
      if (build.skillId === a1.skillId) throw new HelperError('ADAPTER_FAILED', 'Injected persistent failure');
      await place(build, staged);
    };
    await engine.applyPlan(f.plan([f.item(a2, {kind: 'update'})]));
    assert.equal(await readFile(join(f.route, 'example/SKILL.md'), 'utf8'), 'Version 1');
    assert.equal(await engine.locks.pending(entryKey(a1)), null);
    const manifests = (await readdir(f.paths.backups)).map(id => join(f.paths.backups, id, 'manifest.json'));
    assert.equal(manifests.length, 1); assert.ok(await readFile(manifests[0], 'utf8'));
    await engine.applyPlan(f.plan([f.item(b, {kind: 'forced_remove', reason: 'revoked', state: 'forced'})],
      {degraded: true, revoked: [{skillId: b.skillId, digest: b.digest}]}));
    await missing(join(f.route, 'beta')); assert.equal(await readFile(join(f.route, 'example/SKILL.md'), 'utf8'), 'Version 1');
    assert.equal((await engine.locks.read()).entries.find(entry => entry.skillId === b.skillId)?.removed, true);
  } finally {await f.close();}
});

for (const step of ['staged', 'backed_up'] as const) test(`persistent placement failure during ${step} recovery restores local edits and still removes a revoked sibling`, async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile();
    const a1 = f.build(), a2 = f.build(2), b = f.build(1, 0, 'Beta', {skillId: 'skill-beta', name: 'beta'});
    await engine.applyPlan(f.plan([f.item(a1), f.item(b)]));
    await writeFile(join(f.route, 'example/SKILL.md'), 'Local edits before crash');
    f.options.crash = where => {if (where === step) throw new Error('Injected crash');};
    await engine.applyPlan(f.plan([f.item(a2, {kind: 'update'})])); f.options.crash = undefined;
    const pending = (await engine.locks.pending(entryKey(a1)))!;
    assert.ok(pending);
    if (step === 'backed_up') {
      assert.ok(pending.backupId); await missing(join(f.route, 'example'));
      assert.ok(await readFile(join(f.paths.backups, pending.backupId, 'manifest.json'), 'utf8'));
    }
    const target = f.options.targets[0], place = target.place.bind(target);
    target.place = async (build, staged) => {
      if (build.skillId === a1.skillId) throw new HelperError('ADAPTER_FAILED', 'Injected persistent failure');
      await place(build, staged);
    };
    const restarted = f.engine(); await restarted.reconcile();
    assert.equal(await readFile(join(f.route, 'example/SKILL.md'), 'utf8'), 'Local edits before crash');
    assert.equal(await restarted.locks.pending(entryKey(a1)), null);
    assert.equal((await restarted.locks.read()).entries.find(entry => entry.skillId === a1.skillId)?.digest, a1.digest);
    assert.equal((await restarted.inventory()).deliveryErrors.find(entry => entry.skillId === a1.skillId)?.code, 'ADAPTER_FAILED');
    await restarted.applyPlan(f.plan([f.item(b, {kind: 'forced_remove', reason: 'revoked', state: 'forced'})],
      {degraded: true, revoked: [{skillId: b.skillId, digest: b.digest}]}));
    await missing(join(f.route, 'beta')); assert.equal(await readFile(join(f.route, 'example/SKILL.md'), 'utf8'), 'Local edits before crash');
    assert.equal((await restarted.locks.read()).entries.find(entry => entry.skillId === b.skillId)?.removed, true);
    const manifests = (await readdir(f.paths.backups)).map(id => join(f.paths.backups, id, 'manifest.json'));
    assert.equal(manifests.length, 2); for (const manifest of manifests) assert.ok(await readFile(manifest, 'utf8'));
  } finally {await f.close();}
});

for (const stampState of ['missing', 'invalid', 'tampered'] as const) test(`interrupted delivery preserves a ${stampState} stamp copy and still removes a revoked sibling`, async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile();
    const a1 = f.build(), a2 = f.build(2), b = f.build(1, 0, 'Beta', {skillId: 'skill-beta', name: 'beta'});
    await engine.applyPlan(f.plan([f.item(a1), f.item(b)]));
    await writeFile(join(f.route, 'example/SKILL.md'), 'Edited copy');
    if (stampState === 'missing') await rm(join(f.route, 'example/.maddots'), {recursive: true});
    else if (stampState === 'invalid') await atomicWrite(join(f.route, 'example/.maddots/skill.json'), '{invalid');
    else {
      // A well-formed stamp whose signed fields were edited fails signature verification, not parsing.
      const stamp = JSON.parse(await readFile(join(f.route, 'example/.maddots/skill.json'), 'utf8'));
      await atomicWrite(join(f.route, 'example/.maddots/skill.json'), JSON.stringify({...stamp, version: stamp.version + 100}));
    }
    f.options.crash = step => {if (step === 'staged') throw new Error('Injected crash');};
    await engine.applyPlan(f.plan([f.item(a2, {kind: 'update'})])); f.options.crash = undefined;
    await engine.applyPlan(f.plan([f.item(b, {kind: 'forced_remove', state: 'forced', reason: 'revoked'})],
      {degraded: true, revoked: [{skillId: b.skillId, digest: b.digest}]}));
    assert.equal(await readFile(join(f.route, 'example/SKILL.md'), 'utf8'), 'Version 2'); await missing(join(f.route, 'beta'));
    const backups = await listBackups(f.paths);
    assert.ok((await Promise.all(backups.map(backup => readFile(join(f.paths.backups, backup.id, backup.route, backup.folderName, 'SKILL.md'), 'utf8')))).includes('Edited copy'));
    assert.equal((await engine.locks.allPending()).length, 0);
  } finally {await f.close();}
});

test('a stuck journal stays isolated while a second journal recovers and applies a forced removal', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile();
    const a1 = f.build(), a2 = f.build(2), b1 = f.build(1, 0, 'Beta 1', {skillId: 'skill-beta', name: 'beta'}),
      b2 = f.build(2, 0, 'Beta 2', {skillId: 'skill-beta', name: 'beta'});
    const initial = f.plan([f.item(a1), f.item(b1)]); await engine.applyPlan(initial);
    f.options.crash = step => {if (step === 'staged') throw new Error('Injected crash');};
    await engine.applyPlan(f.plan([f.item(a2, {kind: 'update'})]));
    const pendingA = (await engine.locks.pending(entryKey(a2)))!;
    await rm(join(f.paths.data, 'staging', pendingA.stagedName!), {recursive: true});
    f.options.crash = step => {if (step === 'placed') throw new Error('Injected crash');};
    await engine.applyPlan(f.plan([f.item(a2, {kind: 'update'}), f.item(b2, {kind: 'update'})]));
    assert.equal((await engine.locks.allPending()).length, 2);
    assert.deepEqual(await engine.locks.pending(entryKey(a2)), pendingA);
    f.options.crash = undefined;
    await engine.applyPlan(f.plan([f.item(a2, {kind: 'update'}), f.item(b2, {kind: 'forced_remove', state: 'forced', reason: 'revoked'})],
      {degraded: true, revoked: [{skillId: b2.skillId, digest: b2.digest}]}));
    await missing(join(f.route, 'beta')); assert.equal(await readFile(join(f.route, 'example/SKILL.md'), 'utf8'), 'Version 1');
    assert.deepEqual(await engine.locks.pending(entryKey(a2)), pendingA);
    assert.equal((await engine.locks.allPending()).length, 1);
    assert.equal(JSON.parse(await readFile(join(f.paths.data, 'sync-meta.json'), 'utf8')).planRevision, initial.planRevision);
    assert.equal((await engine.inventory()).deliveryErrors.find(entry => entry.skillId === a1.skillId)?.code, 'RECOVERY_MISSING');
  } finally {await f.close();}
});

test('a dependency journal cannot be overwritten by a later item for the same entry', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile();
    const parent = f.item(f.build(1, 0, 'Parent', {skillId: 'skill-parent', name: 'parent'}));
    const d1 = f.item(f.build(1), {dependencyOf: parent.itemId}), d2 = f.item(f.build(2));
    f.options.crash = step => {if (step === 'staged') throw new Error('Injected crash');};
    await engine.applyPlan(f.plan([parent, d2, d1]));
    const pending = (await engine.locks.pending(entryKey(d1)))!;
    assert.equal(pending.itemId, d1.itemId); assert.equal(pending.entry.version, 1);
    assert.equal(f.calls.filter(call => new URL(call.path, 'http://x').pathname === '/api/helper/builds/' + d2.digest).length, 0);
    await missing(join(f.route, 'parent'));
  } finally {await f.close();}
});

test('placement failure after rename keeps the journal so recovery can commit the visible copy', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const v1 = f.build(), v2 = f.build(2);
    await engine.applyPlan(f.plan([f.item(v1)]));
    const target = f.options.targets[0], place = target.place.bind(target);
    target.place = async (build, staged) => {await place(build, staged); throw new HelperError('ADAPTER_FAILED', 'Failure after rename');};
    await engine.applyPlan(f.plan([f.item(v2, {kind: 'update'})]));
    assert.ok(await engine.locks.pending(entryKey(v2))); assert.equal(await readFile(join(f.route, 'example/SKILL.md'), 'utf8'), 'Version 2');
    const restarted = f.engine(); await restarted.reconcile();
    assert.equal(await restarted.locks.pending(entryKey(v2)), null); assert.equal((await restarted.inventory()).managed[0].state, 'ok');
    assert.equal((await listBackups(f.paths)).length, 1);
  } finally {await f.close();}
});

for (const unavailable of ['missing', 'symlink'] as const) test(`run keeps polling and removes a revoked skill on another route when one root is ${unavailable}`, async () => {
  const f = await fixture();
  try {
    const cline = join(f.home, '.cline/skills'); await mkdir(cline, {recursive: true});
    f.options.targets = [...f.options.targets, new FolderDeliveryTarget(f.paths, 'cline-folder', cline)];
    const installed = f.engine(); await installed.reconcile(); const build = f.build();
    await installed.applyPlan(f.plan([f.item(build, {route: 'cline-folder'})]));
    await rm(f.route, {recursive: true});
    if (unavailable === 'symlink') {const other = join(f.home, 'dotfiles'); await mkdir(other); await symlink(other, f.route);}
    const watched: string[] = [], closed: string[] = [], controller = new AbortController();
    f.options.watchRoute = root => {watched.push(root); return {close: () => {closed.push(root);}};};
    f.options.timing = {now: f.now, sleep: async () => {controller.abort();}};
    f.serverPlan(f.plan([f.item(build, {route: 'cline-folder', kind: 'forced_remove', state: 'forced', reason: 'revoked'})],
      {degraded: true, revoked: [{skillId: build.skillId, digest: build.digest}]}));
    const engine = f.engine(); await engine.run(controller.signal);
    assert.ok(f.calls.some(call => call.path === '/api/helper/inventory')); assert.ok(f.calls.some(call => call.path === '/api/helper/plan'));
    assert.deepEqual(watched, [cline]); assert.deepEqual(closed, [cline]); await missing(join(cline, 'example'));
    assert.equal((await engine.locks.read()).entries[0].removed, true); assert.equal((await listBackups(f.paths)).length, 1);
  } finally {await f.close();}
});

test('a missing route gets one watcher on the ten minute retry after its root appears', async () => {
  const f = await fixture();
  try {
    await rm(f.route, {recursive: true}); const controller = new AbortController(); let sleeps = 0, watched = 0, closed = 0;
    f.options.watchRoute = root => {assert.equal(root, f.route); watched++; return {close: () => {closed++;}};};
    f.options.timing = {now: f.now, sleep: async () => {
      if (++sleeps === 1) {await mkdir(f.route); f.advance(599_999);}
      else if (sleeps === 2) {assert.equal(watched, 0); f.advance(1);}
      else if (sleeps === 3) {assert.equal(watched, 1); f.advance(600_000);}
      else controller.abort();
    }};
    f.serverPlan(f.plan([])); await f.engine().run(controller.signal); assert.equal(watched, 1); assert.equal(closed, 1);
  } finally {await f.close();}
});

test('renew-required plan requests wait an hour and resume approved delivery', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(), build = f.build(); f.serverPlan(f.plan([f.item(build)]));
    f.fail({path: '/api/helper/plan', code: 'TOKEN_RENEW_REQUIRED', status: 401}); await engine.tick();
    const count = f.calls.length; assert.equal(engine.retryAt, f.now() + 3_600_000); f.fail();
    f.advance(3_599_999); await engine.tick(); assert.equal(f.calls.length, count); await missing(join(f.route, 'example'));
    f.advance(1); await engine.tick(); assert.equal(await readFile(join(f.route, 'example/SKILL.md'), 'utf8'), 'Version 1');
  } finally {await f.close();}
});

for (const code of ['TOKEN_RENEW_REQUIRED', 'TOKEN_ROTATED']) test(`${code} from inventory pauses all requests and run survives until renewal`, async () => {
  const f = await fixture();
  try {
    const controller = new AbortController(), build = f.build(); let sleeps = 0;
    f.options.watchRoute = () => ({close: () => {}});
    f.options.timing = {now: f.now, sleep: async ms => {
      sleeps++;
      if (sleeps <= 1800) {assert.equal(f.calls.length, 1); f.advance(ms); if (sleeps === 1200) f.fail();}
      else if (sleeps === 1801) {assert.equal(f.calls.length, 1); f.advance(1800_000);}
      else controller.abort();
    }};
    f.serverPlan(f.plan([f.item(build)])); f.fail({path: '*', code, status: 401});
    await f.engine().run(controller.signal);
    assert.equal(sleeps, 1802); assert.equal(await readFile(join(f.route, 'example/SKILL.md'), 'utf8'), 'Version 1');
    assert.equal(f.calls.filter(call => call.path === '/api/helper/inventory').length, 2);
  } finally {await f.close();}
});
test('re-pairing adopts route and agent locks without losing history or rollback checks', async () => {
  const f = await fixture();
  try {
    const first = new SyncEngine({...f.options, helperId: 'helper-a'}); await first.reconcile();
    const v1 = f.build(), v2 = f.build(2), v3 = f.build(3);
    await first.applyPlan(f.plan([f.item(v1), f.item(v1, {forAgentIds: ['agent-one']})]));
    await first.applyPlan(f.plan([f.item(v2, {kind: 'update'}), f.item(v2, {kind: 'update', forAgentIds: ['agent-one']})]));
    const before = await first.locks.read(), agentBefore = await first.agentLocks.read();
    for (const lock of [before, agentBefore]) {
      lock.previousHelperIds = ['helper-earlier'];
      lock.entries[0].allowedDigests = [v1.digest, v2.digest];
      lock.entries[0].keepLocal = {version: 2, localDigest: v2.digest};
      lock.replaced = [{sessionId: 'session-one', home: 'agents-folder', folderName: 'example', backupId: 'backup-one'}];
    }
    const original = JSON.stringify(before, null, 2) + '\n\n', agentOriginal = JSON.stringify(agentBefore, null, 2) + '\n\n';
    await atomicWrite(first.locks.file, original); await atomicWrite(first.agentLocks.file, agentOriginal);
    const repaired = new SyncEngine({...f.options, helperId: 'helper-b'});
    assert.equal((await repaired.verifiedBuild(v2.digest)).build.version, 2);
    assert.equal((await repaired.verifiedBuild(v2.digest, 'agent-one')).build.version, 2);
    assert.equal(await readFile(first.locks.file, 'utf8'), original);
    assert.equal(await readFile(first.agentLocks.file, 'utf8'), agentOriginal);
    await assert.rejects(repaired.locks.write(before), {code: 'LOCK_INVALID'});
    await repaired.reconcile();
    const adopted = await repaired.locks.read(), agentAdopted = await repaired.agentLocks.read();
    for (const [after, previous] of [[adopted, before], [agentAdopted, agentBefore]]) {
      assert.equal(after.helperId, 'helper-b');
      assert.deepEqual(after.previousHelperIds, ['helper-earlier', 'helper-a']);
      assert.deepEqual(after.entries, previous.entries); assert.deepEqual(after.replaced, previous.replaced);
      assert.equal(after.updatedAt, previous.updatedAt);
    }
    const archives = await readdir(f.paths.data);
    const routeArchive = archives.filter(name => name.startsWith('lock-adopted-'));
    const agentArchive = archives.filter(name => name.startsWith('agent-lock-adopted-'));
    assert.equal(routeArchive.length, 1); assert.equal(agentArchive.length, 1);
    assert.equal(await readFile(join(f.paths.data, routeArchive[0]), 'utf8'), original);
    assert.equal(await readFile(join(f.paths.data, agentArchive[0]), 'utf8'), agentOriginal);
    assert.equal((await repaired.inventory()).managed[0].state, 'ok');
    const backupCount = (await listBackups(f.paths)).length;
    await repaired.applyPlan(f.plan([f.item(v3, {kind: 'update'})]));
    assert.equal((await repaired.locks.read()).entries[0].version, 3);
    assert.equal((await listBackups(f.paths)).length, backupCount + 1);
    const folder = join(f.route, 'example');
    assert.equal((await readStamp(folder, f.verifier, ['helper-b'])).helperId, 'helper-b');
    await repaired.applyPlan(f.plan([f.item(v1)]));
    assert.equal((await repaired.inventory()).deliveryErrors[0].code, 'BUILD_ROLLBACK');
    assert.equal((await repaired.locks.read()).entries[0].version, 3);
    await repaired.applyPlan(f.plan([f.item(v2, {kind: 'forced_restore', state: 'forced', reason: 'security_fix'})]));
    const restored = (await repaired.locks.read()).entries[0];
    assert.equal(restored.digest, v2.digest); assert.equal(restored.previous, null);
    assert.equal(await readFile(join(folder, 'SKILL.md'), 'utf8'), 'Version 2');
    assert.equal((await repaired.inventory()).managed[0].state, 'ok');
  } finally {await f.close();}
});
for (const legacy of [false, true]) test(`re-pairing resumes a staged update with ${legacy ? 'legacy' : 'per-entry'} journal`, async () => {
  const f = await fixture();
  try {
    f.options.helperId = 'helper-a'; const first = f.engine(); await first.reconcile();
    const v1 = f.build(), v2 = f.build(2); await first.applyPlan(f.plan([f.item(v1)]));
    f.options.crash = step => {if (step === 'staged') throw new Error('Crash before re-pair');};
    await first.applyPlan(f.plan([f.item(v2, {kind: 'update'})])); f.options.crash = undefined;
    const key = entryKey(v2), journal = await first.locks.pending(key); assert.ok(journal);
    if (legacy) {
      await atomicWrite(first.locks.pendingFile, JSON.stringify(journal) + '\n');
      await first.locks.setPending(key, null);
      assert.deepEqual(await first.agentLocks.allPending(), []);
      assert.deepEqual(JSON.parse(await readFile(first.locks.pendingFile, 'utf8')), journal);
    }
    const repaired = new SyncEngine({...f.options, helperId: 'helper-b'}); await repaired.reconcile();
    assert.equal((await repaired.locks.read()).entries[0].digest, v2.digest);
    assert.equal((await repaired.inventory()).managed[0].state, 'ok');
    assert.equal(await repaired.locks.pending(key), null); assert.deepEqual(await repaired.locks.allPending(), []);
    assert.equal((await listBackups(f.paths)).length, 1);
    if (legacy) assert.equal(await readFile(repaired.locks.pendingFile, 'utf8'), 'null\n');
  } finally {await f.close();}
});
for (const legacy of [false, true]) test(`re-pairing resumes an interrupted ${legacy ? 'legacy' : 'per-entry'} first install and rejects stamps from another install`, async () => {
  const f = await fixture();
  try {
    f.options.helperId = 'helper-a'; f.options.crash = step => {if (step === 'staged') throw new Error('First-install crash');};
    const first = f.engine(); await first.reconcile(); const build = f.build();
    await first.applyPlan(f.plan([f.item(build)]));
    assert.equal((await first.locks.read()).helperId, 'helper-a');
    assert.equal((await first.locks.read()).entries.length, 0);
    const journal = await first.locks.pending(entryKey(build)); assert.ok(journal); f.options.crash = undefined;
    if (legacy) {
      await atomicWrite(first.locks.pendingFile, JSON.stringify(journal) + '\n');
      await first.locks.setPending(entryKey(build), null); await rm(first.locks.file);
    }
    const repaired = new SyncEngine({...f.options, helperId: 'helper-b'}); await repaired.reconcile();
    const lock = await repaired.locks.read(), folder = join(f.route, 'example');
    assert.deepEqual(lock.previousHelperIds, ['helper-a']);
    assert.equal((await repaired.inventory()).managed[0].state, 'ok');
    assert.equal(await repaired.locks.pending(entryKey(build)), null);
    if (legacy) assert.equal(await readFile(repaired.locks.pendingFile, 'utf8'), 'null\n');
    const stamp = await readStamp(folder, f.verifier, repaired.locks.knownIds(lock));
    assert.equal(stamp.helperId, 'helper-a');
    await atomicWrite(join(folder, '.maddots/skill.json'), JSON.stringify({...stamp, helperId: 'helper-other-install'}) + '\n');
    await assert.rejects(readStamp(folder, f.verifier, repaired.locks.knownIds(lock)), {code: 'STAMP_INVALID'});
    assert.equal((await repaired.inventory()).managed[0].state, 'edited');
  } finally {await f.close();}
});

test('legacy journal adoption refuses incomplete installs and cannot add a foreign identity to an existing lock', async () => {
  const f = await fixture();
  try {
    f.options.helperId = 'helper-a'; f.options.crash = step => {if (step === 'staged') throw new Error('First-install crash');};
    const first = f.engine(); await first.reconcile(); const build = f.build();
    await first.applyPlan(f.plan([f.item(build)])); f.options.crash = undefined;
    const journal = (await first.locks.pending(entryKey(build)))!;
    await first.locks.setPending(entryKey(build), null); await rm(first.locks.file);
    for (const invalid of [
      {...journal, helperId: '../foreign'},
      {...journal, entry: {...journal.entry, digest: 'invalid'}},
      {...journal, prior: journal.entry},
      {...journal, operation: 'remove', stagedName: null},
      {...journal, backupId: '../backup'},
    ]) {
      await atomicWrite(first.locks.pendingFile, JSON.stringify(invalid) + '\n');
      await assert.rejects(new SyncEngine({...f.options, helperId: 'helper-b'}).reconcile(), {code: 'JOURNAL_INVALID'});
      await missing(first.locks.file); await missing(join(f.route, 'example'));
    }
    await first.locks.write(await first.locks.read());
    await atomicWrite(first.locks.pendingFile, JSON.stringify({...journal, helperId: 'helper-foreign'}) + '\n');
    await assert.rejects(first.reconcile(), {code: 'JOURNAL_INVALID'});
    assert.equal((await first.locks.read()).previousHelperIds, undefined);
    await missing(join(f.route, 'example'));
  } finally {await f.close();}
});
