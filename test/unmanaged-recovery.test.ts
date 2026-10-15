import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { treeDigest } from '../src/shared/build-format.js';
import { ApiError, type ApiClient } from '../src/api.js';
import { listBackups, restoreBackup } from '../src/backups.js';
import { readConfig } from '../src/config.js';
import { AgentsFolderDeliveryTarget } from '../src/delivery/agents-folder.js';
import { atomicWrite, createPaths, ensurePaths } from '../src/paths.js';
import { SyncEngine, type SyncOptions, type SyncPlan } from '../src/sync.js';
import { completeUnmanagedSnapshot, readUnmanagedSnapshot } from '../src/unmanaged-replacement.js';
import { BuildVerifier, signedBuildString, type PlanItem, type SignedBuild } from '../src/verify.js';

const helperId = 'helper-original';
const skillText = (body: string) => `---\nname: example\ndescription: A safe fixture skill.\n---\n\n${body}\n`;
const originalText = skillText('Personal copy to preserve.');
const deliveredText = skillText('MadDots copy.');
type Checkpoint = 'staged' | 'backed_up' | 'placed' | 'locked';

async function snapshot(root: string): Promise<unknown[]> {
  const output: unknown[] = [];
  async function walk(path: string): Promise<void> {
    const info = await lstat(path);
    output.push({path: relative(root, path), mode: info.mode, ino: info.ino, mtime: info.mtimeMs,
      content: info.isSymbolicLink() ? await readlink(path) : info.isFile() ? (await readFile(path)).toString('base64') : null});
    if (info.isDirectory()) for (const name of (await readdir(path)).sort()) await walk(join(path, name));
  }
  await walk(root); return output;
}

async function interrupted(step: Checkpoint) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-unmanaged-recovery-'));
  try {
    const home = join(root, 'home'); await mkdir(home, {mode: 0o700});
    const paths = await createPaths(readConfig({}, home)); await ensurePaths(paths);
    const folder = join(home, '.agents/skills/example'); await mkdir(folder, {recursive: true});
    await writeFile(join(folder, 'SKILL.md'), originalText);
    await writeFile(join(folder, '.DS_Store'), 'personal metadata');
    const before = await snapshot(folder);
    const signer = generateKeyPairSync('ed25519');
    const publicKey = signer.publicKey.export({type: 'spki', format: 'der'}).subarray(-32);
    const keyId = createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
    const verifier = new BuildVerifier({keys: [{keyId, publicKey: publicKey.toString('base64')}], env: {}});
    const content = Buffer.from(deliveredText);
    const build: SignedBuild = {format: 1, keyId, skillId: 'skill-test', version: 1, settingsRevision: 0,
      level: 'workspace', workspaceId: 'workspace-test', boardId: null, target: 'folder', name: 'example', hasCode: false, draft: false,
      files: [{path: 'SKILL.md', mode: '100644', size: content.length, sha256: createHash('sha256').update(content).digest('hex'), content: content.toString('base64')}],
      report: {renamedFrom: null, unresolvedOptionalReferences: [], unsetSettings: []},
      digest: treeDigest([{path: 'SKILL.md', mode: '100644', content}]), signature: ''};
    build.signature = sign(null, Buffer.from(signedBuildString(build)), signer.privateKey).toString('base64');
    const item: PlanItem = {itemId: createHash('sha256').update(build.digest).digest('hex'), kind: 'install', skillId: build.skillId,
      name: build.name, sourceName: build.name, level: build.level, workspaceId: build.workspaceId, workspaceIds: [build.workspaceId],
      boardIds: [], target: build.target, route: 'agents-folder', fromVersion: null, version: build.version, settingsRevision: 0,
      digest: build.digest, hasCode: false, draft: false, dependencyOf: null, missingDependencies: [], forAgentIds: [],
      state: 'approved', answer: 'replace_unmanaged', reason: null, restartHints: []};
    const plan = (value: PlanItem): SyncPlan => ({planRevision: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
      degraded: false, pollAfterSeconds: 60, items: [value], revoked: [], instructions: []});
    const client = {request: async (path: string) => {
      if (path === '/api/helper/inventory') return {status: 200, headers: new Headers(), data: {ok: true}};
      if (new URL(path, 'http://x').pathname === '/api/helper/builds/' + build.digest) return {status: 200, headers: new Headers(), data: structuredClone(build)};
      throw new ApiError('BUILD_NOT_IN_PLAN', 404);
    }} as Pick<ApiClient, 'request'>;
    const options: SyncOptions = {paths, helperId, client, targets: [new AgentsFolderDeliveryTarget(paths)], verifier,
      tools: [{tool: 'codex', variant: 'cli', version: null, models: [], syncOnly: false}],
      timing: {now: () => 1_760_000_000_000, sleep: async () => {}}};
    const engine = new SyncEngine(options); await engine.reconcile();
    await engine.applyPlan(plan({...item, state: 'asking', answer: null})); await engine.reportInventory();
    options.crash = current => {if (current === step) throw new Error('Injected interruption');};
    await engine.applyPlan(plan(item)); options.crash = undefined;
    const pending = await engine.locks.allPending(); assert.equal(pending.length, 1, `interrupted at ${step}`);
    assert.equal(pending[0].helperId, helperId);
    assert.equal((await readUnmanagedSnapshot(paths, helperId, item)).completed, undefined);
    return {root, paths, folder, before, build, item, plan, pending: pending[0],
      restart: (nextHelperId = helperId) => new SyncEngine({...options, helperId: nextHelperId}),
      close: () => rm(root, {recursive: true, force: true})};
  } catch (error) { await rm(root, {recursive: true, force: true}); throw error; }
}

async function assertRefused(f: Awaited<ReturnType<typeof interrupted>>, engine: SyncEngine) {
  assert.equal((await engine.locks.allPending()).length, 1, 'refused recovery retains its journal');
  assert.deepEqual((await engine.locks.read()).entries, [], 'refused recovery must not accept a build');
  assert.equal((await readUnmanagedSnapshot(f.paths, helperId, f.item)).completed, undefined, 'consent remains unfinished');
  assert.ok((await engine.inventory()).deliveryErrors.length > 0, 'refusal reports a per-item error');
}

for (const step of ['staged', 'backed_up', 'placed', 'locked'] as const) {
  test(`decision 25 re-pair recovers replacement interrupted at ${step} and restores the original`, async () => {
    const f = await interrupted(step);
    try {
      let engine = f.restart('helper-repaired'); await engine.reconcile();
      assert.deepEqual((await engine.inventory()).deliveryErrors, []);
      assert.deepEqual(await engine.locks.allPending(), []);
      engine = f.restart('helper-repaired'); await engine.reconcile();
      await engine.applyPlan({...f.plan(f.item), planRevision: 'repaired-empty-plan', items: []});
      assert.deepEqual((await engine.inventory()).deliveryErrors, []);
      assert.deepEqual(await engine.locks.allPending(), []);
      const lock = await engine.locks.read(); assert.equal(lock.helperId, 'helper-repaired');
      assert.ok(lock.previousHelperIds?.includes(helperId));
      assert.equal(lock.entries.length, 1); assert.equal(lock.entries[0].digest, f.build.digest);
      assert.equal((await readUnmanagedSnapshot(f.paths, helperId, f.item)).completed, true);
      assert.equal(await readFile(join(f.folder, 'SKILL.md'), 'utf8'), deliveredText);
      const backups = await listBackups(f.paths); assert.equal(backups.length, 1);
      assert.equal(backups[0].reason, 'unmanaged_replaced');
      assert.deepEqual(await snapshot(join(f.paths.backups, backups[0].id, 'agents-folder/example')), f.before);
      const delivered = await snapshot(f.folder);
      await restoreBackup(f.paths, backups[0].id); assert.deepEqual(await snapshot(f.folder), f.before);
      const preserved = await listBackups(f.paths); assert.equal(preserved.length, 1);
      assert.equal(preserved[0].reason, 'restore-replaced');
      assert.deepEqual(await snapshot(join(f.paths.backups, preserved[0].id, 'agents-folder/example')), delivered);
    } finally { await f.close(); }
  });
}

test('decision 25 recovery refuses a journal helper outside the adopted lock identities', async () => {
  const f = await interrupted('staged');
  try {
    const directory = join(f.paths.data, 'sync-pending');
    const names = await readdir(directory); assert.equal(names.length, 1);
    const file = join(directory, names[0]);
    await atomicWrite(file, JSON.stringify({...f.pending, helperId: 'helper-unknown'}) + '\n');
    const engine = f.restart('helper-repaired');
    await assert.rejects(engine.reconcile(), {code: 'JOURNAL_INVALID'});
    assert.deepEqual(await snapshot(f.folder), f.before);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).helperId, 'helper-unknown');
    assert.deepEqual((await engine.locks.read()).entries, []);
    assert.equal((await readUnmanagedSnapshot(f.paths, helperId, f.item)).completed, undefined);
    assert.deepEqual(await listBackups(f.paths), []);
  } finally { await f.close(); }
});

test('decision 25 recovery finishes journal cleanup after consent was completed', async () => {
  const f = await interrupted('locked');
  try {
    await completeUnmanagedSnapshot(f.paths, helperId, f.item, f.pending.unmanagedDigest!);
    const engine = f.restart(); await engine.reconcile();
    assert.deepEqual(await engine.locks.allPending(), []);
    assert.deepEqual((await engine.inventory()).deliveryErrors, []);
    assert.equal((await engine.locks.read()).entries[0].digest, f.build.digest);
    assert.equal((await readUnmanagedSnapshot(f.paths, helperId, f.item)).completed, true);
    assert.equal(await readFile(join(f.folder, 'SKILL.md'), 'utf8'), deliveredText);
    const backups = await listBackups(f.paths); assert.equal(backups.length, 1);
    assert.deepEqual(await snapshot(join(f.paths.backups, backups[0].id, 'agents-folder/example')), f.before);
    await restoreBackup(f.paths, backups[0].id); assert.deepEqual(await snapshot(f.folder), f.before);
  } finally { await f.close(); }
});

for (const matchesBuild of [false, true]) {
  test(`decision 25 recovery refuses a copied valid stamp with ${matchesBuild ? 'matching' : 'changed'} content and no original backup`, async () => {
    const f = await interrupted('staged');
    try {
      const staged = join(f.paths.data, 'staging', f.pending.stagedName!);
      await mkdir(join(f.folder, '.maddots'), {mode: 0o700});
      await atomicWrite(join(f.folder, '.maddots/skill.json'), await readFile(join(staged, '.maddots/skill.json'), 'utf8'));
      await writeFile(join(f.folder, 'SKILL.md'), matchesBuild ? deliveredText : skillText('Personal edit after staging.'));
      const changed = await snapshot(f.folder);
      const engine = f.restart(); await engine.reconcile(); await engine.applyPlan(f.plan(f.item));
      await assertRefused(f, engine);
      assert.deepEqual(await snapshot(f.folder), changed, 'the changed original stays in place');
      assert.deepEqual(await listBackups(f.paths), []);
      assert.ok((await engine.inventory()).deliveryErrors.some(error => error.code === 'UNMANAGED_CHANGED' || error.code === 'RECOVERY_CONFLICT'));
    } finally { await f.close(); }
  });
}

test('decision 25 recovery refuses edited placed content with its valid stamp and intact original backup', async () => {
  const f = await interrupted('placed');
  try {
    const backup = join(f.paths.backups, f.pending.backupId!, 'agents-folder/example');
    const backups = await listBackups(f.paths); assert.equal(backups.length, 1);
    assert.equal(backups[0].reason, 'unmanaged_replaced');
    assert.deepEqual(await snapshot(backup), f.before, 'the original replacement backup is intact');
    const stamp = await readFile(join(f.folder, '.maddots/skill.json'), 'utf8');
    await writeFile(join(f.folder, 'SKILL.md'), skillText('Person edited the placed copy during interruption.'));
    const edited = await snapshot(f.folder);
    const engine = f.restart();
    for (const recover of [() => engine.reconcile(), () => engine.applyPlan(f.plan(f.item))]) {
      await recover();
      await assertRefused(f, engine);
      assert.deepEqual(await engine.locks.allPending(), [f.pending], 'the original journal remains pending');
      assert.deepEqual((await engine.inventory()).deliveryErrors, [{skillId: f.item.skillId, target: f.item.target,
        name: f.item.name, code: 'UNMANAGED_CHANGED'}]);
      assert.equal(await readFile(join(f.folder, '.maddots/skill.json'), 'utf8'), stamp, 'the valid placement stamp is unchanged');
      assert.deepEqual(await snapshot(f.folder), edited, 'the edited destination stays in place');
      assert.deepEqual(await snapshot(backup), f.before, 'the original backup stays unchanged');
      assert.deepEqual(await listBackups(f.paths), backups);
    }
  } finally { await f.close(); }
});

for (const change of ['missing', 'changed'] as const) {
  test(`decision 25 matching placed content cannot complete with a ${change} replacement backup`, async () => {
    const f = await interrupted('placed');
    try {
      const backup = join(f.paths.backups, f.pending.backupId!, 'agents-folder/example');
      const saved = change === 'missing' ? join(f.root, 'person-moved-backup') : backup;
      if (change === 'missing') await rename(backup, saved);
      else await writeFile(join(backup, 'SKILL.md'), skillText('Person edited the backup during interruption.'));
      const preserved = await snapshot(saved), delivered = await snapshot(f.folder);
      const engine = f.restart(); await engine.reconcile(); await engine.applyPlan(f.plan(f.item));
      await assertRefused(f, engine);
      assert.deepEqual(await snapshot(f.folder), delivered);
      assert.deepEqual(await snapshot(saved), preserved, 'refusing completion never discards the preserved folder');
      assert.ok((await engine.inventory()).deliveryErrors.some(error => error.code === 'UNMANAGED_CHANGED' || error.code === 'RECOVERY_CONFLICT'));
    } finally { await f.close(); }
  });
}
