import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { treeDigest } from '../src/shared/build-format.js';
import { planItemId } from '../src/shared/plan-item-id.js';
import { TOOL_MATRIX } from '../src/shared/tool-matrix.js';
import { runAllow } from '../src/allow.js';
import type { ApiClient } from '../src/api.js';
import { listBackups, restoreBackup, snapshotReadCopy } from '../src/backups.js';
import { readConfig, type Runner } from '../src/config.js';
import { ClaudePluginDeliveryTarget, ClaudePluginSyncEngine } from '../src/delivery/claude-plugin.js';
import { managedReadFolder, readLocalEdit } from '../src/local-edits.js';
import { createPaths, ensurePaths } from '../src/paths.js';
import { readSkillTree } from '../src/safe-fs.js';
import type { SyncPlan } from '../src/sync.js';
import { BuildVerifier, signedBuildString, type PlanItem, type SignedBuild } from '../src/verify.js';

const readRoot = '~/.claude/plugins/cache/maddots-ai';
const readTemplate = `${readRoot}/<plugin>/<version>/skills/<name>`;

async function fixture(t: {after(fn: () => Promise<void>): void}, readPath: string | null = readRoot) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-claude-local-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const home = join(root, 'home'); await mkdir(home, {mode: 0o700});
  const paths = await createPaths(readConfig({}, home)); await ensurePaths(paths);
  const binary = join(home, 'bin/claude'); await mkdir(dirname(binary));
  await writeFile(binary, 'fixture executable'); await chmod(binary, 0o700);
  const matrix = structuredClone(TOOL_MATRIX); matrix.routes['claude-plugin'].readPath = readPath;
  const commands: (readonly string[])[] = [];
  let copyFromCli = false, marketplace = false;
  const installed = new Set<string>();
  const runner: Runner = async (_binary, args) => {
    if (args[0] === '--version') return {stdout: '2.1.289 (Claude Code)', stderr: ''};
    commands.push([...args]);
    if (args.join(' ') === 'plugin marketplace list --json') return {stdout: JSON.stringify(marketplace ? [{name: 'maddots-ai', source: 'directory', path: await plugin.root()}] : []), stderr: ''};
    if (args.join(' ') === 'plugin list --json') return {stdout: JSON.stringify([...installed].map(id => ({id}))), stderr: ''};
    if (args[1] === 'marketplace' && args[2] === 'add') marketplace = true;
    if (args[1] === 'install' || args[1] === 'update') {
      installed.add(args[2]);
      if (copyFromCli) {
        const name = args[2].split('@')[0], source = join(await plugin.root(), name);
        const manifest = JSON.parse(await readFile(join(source, '.claude-plugin/plugin.json'), 'utf8'));
        const copy = join(home, '.claude/plugins/cache/maddots-ai', name, manifest.version);
        await mkdir(dirname(copy), {recursive: true}); await cp(source, copy, {recursive: true});
      }
    }
    return {stdout: '', stderr: ''};
  };
  const plugin = new ClaudePluginDeliveryTarget({paths, helperId: 'helper-claude-local', matrix, runner, claudePath: binary,
    workspaceSlugs: {workspaceA: 'alpha'}});
  const signer = generateKeyPairSync('ed25519');
  const publicKey = signer.publicKey.export({type: 'spki', format: 'der'}).subarray(-32);
  const keyId = createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
  const verifier = new BuildVerifier({keys: [{keyId, publicKey: publicKey.toString('base64')}], env: {}});
  const builds = new Map<string, SignedBuild>();
  const plan = (items: PlanItem[]): SyncPlan => ({planRevision: createHash('sha256').update(JSON.stringify(items)).digest('hex'),
    degraded: false, pollAfterSeconds: 60, items, revoked: [], instructions: []});
  let current = plan([]);
  const client = {request: async (path: string) => ({status: 200, headers: new Headers(), data: structuredClone(
    path === '/api/helper/plan' ? current : path.startsWith('/api/helper/builds/') ? builds.get(new URL(path, 'http://x').pathname.slice('/api/helper/builds/'.length)) : {ok: true})})} as Pick<ApiClient, 'request'>;
  let now = Date.now();
  const engine = new ClaudePluginSyncEngine({paths, helperId: 'helper-claude-local', targets: [], client, verifier,
    timing: {now: () => now, sleep: async ms => {now += ms;}}}, plugin);
  function build(hasCode = false): SignedBuild {
    const files = [{path: 'SKILL.md', mode: '100644' as const, content: Buffer.from('# Example\nOriginal instructions\n')},
      ...(hasCode ? [{path: 'scripts/run.sh', mode: '100755' as const, content: Buffer.from('printf example\n')}] : [])];
    const value: SignedBuild = {format: 1, keyId, skillId: 'skill-example', version: 1, settingsRevision: 0,
      level: 'workspace', workspaceId: 'workspaceA', boardId: null, target: 'claude-plugin', name: 'example', hasCode, draft: false,
      files: files.map(file => ({...file, size: file.content.length, sha256: createHash('sha256').update(file.content).digest('hex'), content: file.content.toString('base64')})),
      digest: treeDigest(files), signature: '', report: {renamedFrom: null, unresolvedOptionalReferences: [], unsetSettings: []}};
    value.signature = sign(null, Buffer.from(signedBuildString(value)), signer.privateKey).toString('base64');
    builds.set(value.digest, value); return value;
  }
  function item(build: SignedBuild, changes: Partial<PlanItem> = {}, localDigest: string | null = null): PlanItem {
    const value: PlanItem = {itemId: '', kind: 'install', skillId: build.skillId, name: build.name, sourceName: build.name,
      level: build.level, workspaceId: build.workspaceId, workspaceIds: [build.workspaceId], boardIds: [], target: build.target,
      route: 'claude-plugin', fromVersion: null, version: build.version, settingsRevision: build.settingsRevision, digest: build.digest,
      hasCode: build.hasCode, draft: false, dependencyOf: null, missingDependencies: [], forAgentIds: [], state: 'approved', answer: 'update',
      reason: null, restartHints: [], ...changes};
    value.itemId = planItemId({...value, helperId: 'helper-claude-local', agentId: null, localDigest}); return value;
  }
  await engine.reconcile();
  return {home, paths, engine, plugin, commands, client, build, item, plan, server: (plan: SyncPlan) => {current = plan;},
    copyFromCli: () => {copyFromCli = true;}};
}

test('Claude forwards the Allow callback under the write lock and real runAllow delivers held code', async t => {
  const f = await fixture(t, null), build = f.build(true);
  let called = false;
  await f.engine.applyPlan(f.plan([]), async () => {
    called = true; assert.equal(await readFile(f.paths.lock, 'utf8'), String(process.pid));
  });
  assert.equal(called, true);
  const plan = f.plan([f.item(build)]); f.server(plan); await f.engine.applyPlan(plan);
  assert.equal(await f.engine.holding.count(), 1);
  assert.equal(await runAllow(f.engine, f.client, {isTTY: true, output: () => {}, confirm: async () => 'yes'}), 1);
  assert.equal(await f.engine.holding.count(), 0);
  assert.equal((await f.engine.locks.read()).entries[0].digest, build.digest);
  assert.equal(await readFile(join(f.plugin.folderFor(build), 'scripts/run.sh'), 'utf8'), 'printf example\n');
  assert.deepEqual((await f.engine.inventory()).deliveryErrors, []);
});

for (const readPath of [readRoot, readTemplate]) test(`Claude local choices use its ${readPath === readRoot ? 'versioned root' : 'template'} read copy`, async t => {
  const f = await fixture(t, readPath), build = f.build();
  await f.engine.applyPlan(f.plan([f.item(build)]));
  assert.equal((await f.engine.inventory()).managed[0].state, 'missing');
  assert.deepEqual((await f.engine.inventory()).deliveryErrors, []);
  const source = f.plugin.folderFor(build), copy = await f.plugin.readFolderFor(build);
  await mkdir(dirname(copy), {recursive: true}); await cp(source, copy, {recursive: true});
  await writeFile(join(copy, 'SKILL.md'), '# Edited cache\n');
  const entry = (await f.engine.locks.read()).entries[0], localDigest = treeDigest(await readSkillTree(copy, f.home));
  assert.equal(await managedReadFolder(f.paths, entry, source, f.plugin), copy);
  assert.equal((await readLocalEdit(f.paths, entry, source, f.plugin)).localDigest, localDigest);
  assert.equal((await f.engine.inventory()).managed[0].localDigest, localDigest);
  await f.engine.applyPlan(f.plan([f.item(build, {kind: 'local_newer', fromVersion: 1, state: 'kept_local', answer: 'keep_local'}, localDigest)]));
  assert.deepEqual((await f.engine.locks.read()).entries[0].keepLocal, {version: 1, localDigest});
  assert.equal(await readFile(join(source, 'SKILL.md'), 'utf8'), '# Example\nOriginal instructions\n');
  assert.deepEqual((await f.engine.inventory()).deliveryErrors, []);
});

test('Claude Replace snapshots the installed cache, requests a CLI refresh, and waits for observation before completion', async t => {
  const f = await fixture(t, readTemplate), build = f.build();
  await f.engine.applyPlan(f.plan([f.item(build)]));
  const source = f.plugin.folderFor(build), copy = await f.plugin.readFolderFor(build);
  await mkdir(dirname(copy), {recursive: true}); await cp(source, copy, {recursive: true});
  await writeFile(join(copy, 'SKILL.md'), '# Edited cache\n');
  const localDigest = treeDigest(await readSkillTree(copy, f.home));
  const replacement = f.item(build, {kind: 'local_newer', fromVersion: 1, answer: 'replace'}, localDigest), plan = f.plan([replacement]);
  const commandsBefore = f.commands.length;
  await f.engine.applyPlan(plan);
  assert.equal(await readFile(join(copy, 'SKILL.md'), 'utf8'), '# Edited cache\n');
  assert.ok(f.commands.slice(commandsBefore).some(args => args[1] === 'install'));
  const snapshot = (await listBackups(f.paths)).find(backup => backup.reason === 'local_read_copy')!;
  assert.ok(snapshot); assert.equal(snapshot.originalPath, relative(f.home, copy));
  assert.equal(snapshot.restorePath, relative(f.home, source));
  assert.equal(await readFile(join(f.paths.backups, snapshot.id, snapshot.route, snapshot.folderName, 'SKILL.md'), 'utf8'), '# Edited cache\n');
  const receiptPath = join(f.paths.data, 'local-choices', replacement.itemId + '.replace.json');
  assert.notEqual(JSON.parse(await readFile(receiptPath, 'utf8')).completed, true);
  f.copyFromCli(); await f.engine.applyPlan(plan);
  assert.equal(treeDigest(await readSkillTree(copy, f.home)), build.digest);
  assert.notEqual(JSON.parse(await readFile(receiptPath, 'utf8')).completed, true);
  await f.engine.applyPlan(plan);
  assert.equal(JSON.parse(await readFile(receiptPath, 'utf8')).completed, true);
  assert.deepEqual((await f.engine.inventory()).deliveryErrors, []);
  assert.equal((await f.engine.inventory()).managed[0].state, 'ok');
});

test('Claude snapshot adapter checks reject another generation and symlinks, while snapshots restore only into the source', async t => {
  const f = await fixture(t, readTemplate), build = f.build();
  await f.engine.applyPlan(f.plan([f.item(build)]));
  const source = f.plugin.folderFor(build), copy = await f.plugin.readFolderFor(build), entry = (await f.engine.locks.read()).entries[0];
  await mkdir(dirname(copy), {recursive: true}); await cp(source, copy, {recursive: true});
  await writeFile(join(copy, 'SKILL.md'), '# Edited cache\n');
  const digest = treeDigest(await readSkillTree(copy, f.home)), wrong = copy.replace('/1.0.1/', '/1.0.2/');
  await mkdir(dirname(wrong), {recursive: true}); await cp(copy, wrong, {recursive: true});
  await assert.rejects(snapshotReadCopy(f.paths, wrong, source, entry.route, digest, Date.now(), {entry, target: f.plugin}), {code: 'BACKUP_INVALID'});
  const snapshot = await snapshotReadCopy(f.paths, copy, source, entry.route, digest, Date.now(), {entry, target: f.plugin});
  await rm(copy, {recursive: true}); await symlink(wrong, copy);
  await assert.rejects(snapshotReadCopy(f.paths, copy, source, entry.route, digest, Date.now(), {entry, target: f.plugin}), {code: 'PATH_UNSAFE'});
  await rm(copy); await restoreBackup(f.paths, snapshot.id);
  assert.equal(await readFile(join(source, 'SKILL.md'), 'utf8'), '# Edited cache\n');
  await assert.rejects(lstat(copy), {code: 'ENOENT'});
});

test('Claude code cache replacement waits for a fresh runAllow before refreshing the read copy', async t => {
  const f = await fixture(t, readTemplate), build = f.build(true), allow = {isTTY: true, output: () => {}, confirm: async () => 'yes'};
  f.copyFromCli(); f.server(f.plan([f.item(build)]));
  assert.equal(await runAllow(f.engine, f.client, allow), 1);
  const source = f.plugin.folderFor(build), copy = await f.plugin.readFolderFor(build);
  await writeFile(join(copy, 'SKILL.md'), '# Edited code cache\n');
  const localDigest = treeDigest(await readSkillTree(copy, f.home));
  const replacement = f.item(build, {kind: 'local_newer', fromVersion: 1, answer: 'replace'}, localDigest), plan = f.plan([replacement]);
  f.server(plan); await f.engine.applyPlan(plan);
  assert.equal(await f.engine.holding.count(), 1);
  await assert.rejects(lstat(source), {code: 'ENOENT'});
  assert.equal(await readFile(join(copy, 'SKILL.md'), 'utf8'), '# Edited code cache\n');
  assert.equal(await runAllow(f.engine, f.client, allow), 1);
  assert.equal(await f.engine.holding.count(), 0);
  assert.equal(treeDigest(await readSkillTree(source, f.home)), build.digest);
  assert.equal(treeDigest(await readSkillTree(copy, f.home)), build.digest);
  await f.engine.applyPlan(plan);
  assert.deepEqual((await f.engine.inventory()).deliveryErrors, []);
  assert.equal(JSON.parse(await readFile(join(f.paths.data, 'local-choices', replacement.itemId + '.replace.json'), 'utf8')).completed, true);
});

test('Claude cache observation preserves source edit detection', async t => {
  const f = await fixture(t), build = f.build(); f.copyFromCli();
  await f.engine.applyPlan(f.plan([f.item(build)]));
  await writeFile(join(f.plugin.folderFor(build), 'SKILL.md'), '# Source edited independently\n');
  const inventory = await f.engine.inventory();
  assert.equal(inventory.managed[0].localDigest, build.digest);
  assert.equal(inventory.managed[0].state, 'edited');
});
