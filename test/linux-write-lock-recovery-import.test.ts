import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, randomUUID, sign} from 'node:crypto';
import {lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {treeDigest} from '../src/shared/build-format.js';
import type {HelperImportSession} from '../src/shared/helper-imports-protocol.js';
import {ApiClient} from '../src/api.js';
import {finishUnmanagedBackup, listBackups} from '../src/backups.js';
import {readConfig} from '../src/config.js';
import {FolderDeliveryTarget} from '../src/delivery/index.js';
import {ImportEngine, type ImportOptions, type ReplaceLocalInstruction} from '../src/imports.js';
import {createPaths, ensurePaths} from '../src/paths.js';
import {SyncEngine, type SyncPlan} from '../src/sync.js';
import {BuildVerifier, signedBuildString, type PlanItem, type SignedBuild} from '../src/verify.js';
import {reconcileLinuxRecovery} from '../src/write-lock-recovery.js';

test('recovery preserves a real interrupted import and leaves replacement recovery to the import engine', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-recovery-import-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const home = join(root, 'home'); await mkdir(home, {mode: 0o700});
  const paths = await createPaths(readConfig({}, home)); await ensurePaths(paths);
  const route = join(home, '.agents/skills'), original = join(home, '.codex/skills/example');
  await mkdir(route, {recursive: true}); await mkdir(original, {recursive: true});
  const originalContent = Buffer.from('Preserve the imported local skill.\n');
  await writeFile(join(original, 'SKILL.md'), originalContent);
  const originalDirectory = await lstat(original), originalFile = await lstat(join(original, 'SKILL.md'));
  const now = Date.parse('2026-10-14T12:00:00Z'), timing = {now: () => now, sleep: async () => {}};
  const session: HelperImportSession = {sessionId: randomUUID(), tool: 'codex',
    folders: [{home: '.codex', folderName: 'example'}], expiresAt: now + 1_800_000};
  const signer = generateKeyPairSync('ed25519'), publicKey = signer.publicKey.export({type: 'spki', format: 'der'}).subarray(-32);
  const keyId = createHash('sha256').update(publicKey).digest('hex').slice(0, 16), content = Buffer.from('Verified managed delivery.\n');
  const build: SignedBuild = {format: 1, keyId, skillId: 'recovery-import-skill', version: 1, settingsRevision: 0,
    level: 'workspace', workspaceId: 'recovery-workspace', boardId: null, target: 'folder', name: 'example', hasCode: false, draft: false,
    files: [{path: 'SKILL.md', mode: '100644', size: content.length, sha256: createHash('sha256').update(content).digest('hex'), content: content.toString('base64')}],
    report: {renamedFrom: null, unresolvedOptionalReferences: [], unsetSettings: []},
    digest: treeDigest([{path: 'SKILL.md', mode: '100644', content}]), signature: ''};
  build.signature = sign(null, Buffer.from(signedBuildString(build)), signer.privateKey).toString('base64');
  const item: PlanItem = {itemId: 'c'.repeat(64), kind: 'install', skillId: build.skillId, name: build.name, sourceName: build.name,
    level: build.level, workspaceId: build.workspaceId, workspaceIds: [build.workspaceId], boardIds: [], target: build.target,
    route: 'agents-folder', fromVersion: null, version: build.version, settingsRevision: 0, digest: build.digest,
    hasCode: false, draft: false, dependencyOf: null, missingDependencies: [], forAgentIds: [], state: 'approved', answer: 'update', reason: null, restartHints: []};
  const plan: SyncPlan = {planRevision: 'recovery-import-plan', degraded: false, pollAfterSeconds: 60, items: [item], revoked: [], instructions: []};
  let replacementsReported = 0;
  const client = new ApiClient(new URL('https://fixture.invalid'), async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/api/helper/imports') return Response.json({data: [session]});
    if (path === `/api/helper/imports/${session.sessionId}/uploads`) return Response.json({data: {sessionId: session.sessionId, state: 'done', resultVersionIds: [randomUUID()]}});
    if (path === `/api/helper/imports/${session.sessionId}/results`) {
      assert.equal(JSON.parse(String(init?.body)).status, 'replaced'); replacementsReported++;
      return Response.json({data: {sessionId: session.sessionId, state: 'done', resultVersionIds: []}});
    }
    if (path === '/api/helper/inventory') return Response.json({data: {ok: true}});
    if (path === '/api/helper/builds/' + build.digest) return Response.json({data: build});
    throw new Error('Unexpected fixture route: ' + path);
  });
  const targets = [new FolderDeliveryTarget(paths, 'agents-folder', route)];
  const verifier = new BuildVerifier({keys: [{keyId, publicKey: publicKey.toString('base64')}], env: {}});
  const options: ImportOptions = {paths, helperId: 'recovery-helper', client, targets, verifier, timing};
  const sync = new SyncEngine({paths, helperId: options.helperId, client, targets, verifier, timing, watchRoute: () => ({close() {}})});
  await sync.reconcile(); await sync.applyPlan(plan);
  await reconcileLinuxRecovery([paths.data], []);
  await new ImportEngine(options).poll();
  const instruction: ReplaceLocalInstruction = {type: 'replace_local', sessionId: session.sessionId, skillId: build.skillId,
    home: '.codex', folderName: 'example', alsoLinkedFrom: []};
  const journal = join(paths.data, 'imports.json');
  let interrupted = false;
  options.crash = async step => {
    assert.equal(step, 'backup_prepared');
    const pending = JSON.parse(await readFile(journal, 'utf8')).sessions[0].folders[0];
    // Run the real inode-journaled preservation and interrupt after its durable
    // rename, before the original path receives its managed forwarding link.
    await finishUnmanagedBackup(paths, pending.backupId, undefined, {symlink: path => path === original ? {
      afterPreserve: async () => {interrupted = true; throw Object.assign(new Error('Interrupted import preservation'), {code: 'EIO'});},
    } : {}});
  };
  await assert.rejects(new ImportEngine(options).applyInstructions([instruction]), {code: 'EIO'});
  assert.equal(interrupted, true, 'reach the production preservation crash checkpoint');
  await assert.rejects(lstat(original), {code: 'ENOENT'});
  const pending = JSON.parse(await readFile(journal, 'utf8')).sessions[0].folders[0];
  assert.ok(pending.backupId); assert.equal(pending.complete, undefined); assert.equal(pending.failed, undefined);
  const backup = join(paths.backups, pending.backupId, 'local-import/example'), inodeJournal = backup + '.json';
  const identity = JSON.parse(await readFile(inodeJournal, 'utf8'));
  assert.equal(identity.path, original); assert.equal(identity.preserved, backup);
  assert.deepEqual(identity.identity, {dev: originalDirectory.dev, ino: originalDirectory.ino, type: originalDirectory.mode & 0o170000});
  assert.equal((await lstat(backup)).ino, originalDirectory.ino);
  assert.equal((await lstat(join(backup, 'SKILL.md'))).ino, originalFile.ino);
  assert.deepEqual(await readFile(join(backup, 'SKILL.md')), originalContent);
  const lock = join(paths.data, 'lock.json');
  assert.deepEqual(JSON.parse(await readFile(lock, 'utf8')).replaced, []);
  const retained = await Promise.all([journal, inodeJournal, join(paths.backups, pending.backupId, 'manifest.json'), lock, join(backup, 'SKILL.md')]
    .map(async path => ({path, bytes: await readFile(path), info: await lstat(path)})));
  const assertRetained = async () => {
    for (const saved of retained) {
      assert.deepEqual(await readFile(saved.path), saved.bytes, 'recovery preserves retained transaction bytes');
      const info = await lstat(saved.path);
      assert.equal(info.dev, saved.info.dev); assert.equal(info.ino, saved.info.ino, 'recovery preserves retained transaction inodes');
    }
    assert.equal((await lstat(backup)).ino, originalDirectory.ino);
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(reconcileLinuxRecovery([paths.data], []), {code: 'LINUX_LOCK_RETIREMENT_UNVERIFIED'});
    await assertRetained();
    await assert.rejects(lstat(original), {code: 'ENOENT'}, 'root recovery cannot place the missing forwarding link');
    assert.equal(replacementsReported, 0, 'root recovery cannot report import completion');
  }
  options.crash = undefined;
  await new ImportEngine(options).applyInstructions([]);
  assert.equal(await readlink(original), '../../.agents/skills/example');
  assert.deepEqual(await readFile(join(original, 'SKILL.md')), content);
  assert.equal(replacementsReported, 1);
  const settled = JSON.parse(await readFile(journal, 'utf8'));
  assert.deepEqual(settled.sessions, []); assert.ok(settled.closed.includes(session.sessionId));
  assert.equal(JSON.parse(await readFile(lock, 'utf8')).replaced[0].backupId, pending.backupId);
  assert.deepEqual((await listBackups(paths)).map(value => value.id), [pending.backupId]);
  // Import completion does not give this migration authority to consume the
  // retained backup and inode journal or manufacture a settlement receipt.
  await assert.rejects(reconcileLinuxRecovery([paths.data], []), {code: 'LINUX_LOCK_RETIREMENT_UNVERIFIED'});
  assert.deepEqual(await readFile(join(backup, 'SKILL.md')), originalContent);
  assert.equal((await lstat(backup)).ino, originalDirectory.ino);
  assert.equal((await lstat(join(backup, 'SKILL.md'))).ino, originalFile.ino);
  const savedInodeJournal = retained.find(saved => saved.path === inodeJournal)!;
  assert.deepEqual(await readFile(inodeJournal), savedInodeJournal.bytes);
  assert.equal((await lstat(inodeJournal)).ino, savedInodeJournal.info.ino);
});
