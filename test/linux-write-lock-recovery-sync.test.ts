import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import {lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {treeDigest} from '../src/shared/build-format.js';
import {ApiError, type ApiClient} from '../src/api.js';
import {listBackups} from '../src/backups.js';
import {readConfig} from '../src/config.js';
import {FolderDeliveryTarget} from '../src/delivery/index.js';
import {createPaths, ensurePaths} from '../src/paths.js';
import {SyncEngine, type SyncOptions, type SyncPlan} from '../src/sync.js';
import {BuildVerifier, signedBuildString, type PlanItem, type SignedBuild} from '../src/verify.js';
import {reconcileLinuxRecovery} from '../src/write-lock-recovery.js';

test('recovery refuses a real forced-removal crash and preserves backups after sync settles its journal', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-recovery-forced-remove-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const home = join(root, 'home'); await mkdir(home, {mode: 0o700});
  const paths = await createPaths(readConfig({}, home)); await ensurePaths(paths);
  const route = join(home, '.agents/skills'); await mkdir(route, {recursive: true});
  const signer = generateKeyPairSync('ed25519'), publicKey = signer.publicKey.export({type: 'spki', format: 'der'}).subarray(-32);
  const keyId = createHash('sha256').update(publicKey).digest('hex').slice(0, 16), content = Buffer.from('Preserve the installed skill.\n');
  const build: SignedBuild = {format: 1, keyId, skillId: 'recovery-skill', version: 1, settingsRevision: 0,
    level: 'workspace', workspaceId: 'recovery-workspace', boardId: null, target: 'folder', name: 'example', hasCode: false, draft: false,
    files: [{path: 'SKILL.md', mode: '100644', size: content.length, sha256: createHash('sha256').update(content).digest('hex'), content: content.toString('base64')}],
    report: {renamedFrom: null, unresolvedOptionalReferences: [], unsetSettings: []},
    digest: treeDigest([{path: 'SKILL.md', mode: '100644', content}]), signature: ''};
  build.signature = sign(null, Buffer.from(signedBuildString(build)), signer.privateKey).toString('base64');
  const item: PlanItem = {itemId: 'a'.repeat(64), kind: 'install', skillId: build.skillId, name: build.name, sourceName: build.name,
    level: build.level, workspaceId: build.workspaceId, workspaceIds: [build.workspaceId], boardIds: [], target: build.target,
    route: 'agents-folder', fromVersion: null, version: build.version, settingsRevision: 0, digest: build.digest,
    hasCode: false, draft: false, dependencyOf: null, missingDependencies: [], forAgentIds: [], state: 'approved', answer: 'update', reason: null, restartHints: []};
  const plan = (value: PlanItem): SyncPlan => ({planRevision: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    degraded: false, pollAfterSeconds: 60, items: [value], revoked: [], instructions: []});
  const client = {request: async (path: string) => {
    if (path === '/api/helper/inventory') return {status: 200, headers: new Headers(), data: {ok: true}};
    if (new URL(path, 'http://fixture').pathname === '/api/helper/builds/' + build.digest) return {status: 200, headers: new Headers(), data: structuredClone(build)};
    throw new ApiError('BUILD_NOT_IN_PLAN', 404);
  }} as Pick<ApiClient, 'request'>;
  const options: SyncOptions = {paths, helperId: 'recovery-helper', client, targets: [new FolderDeliveryTarget(paths, 'agents-folder', route)],
    verifier: new BuildVerifier({keys: [{keyId, publicKey: publicKey.toString('base64')}], env: {}}),
    watchRoute: () => ({close() {}}), timing: {now: () => 1_760_000_000_000, sleep: async () => {}}};
  const engine = new SyncEngine(options); await engine.reconcile(); await engine.applyPlan(plan(item));
  assert.equal(await readFile(join(route, item.name, 'SKILL.md'), 'utf8'), content.toString());
  let interrupted = false;
  options.crash = step => {if (step === 'backed_up') {interrupted = true; throw new Error('forced removal interruption');}};
  await engine.applyPlan(plan({...item, itemId: 'b'.repeat(64), kind: 'forced_remove', state: 'forced', reason: 'revoked'}));
  assert.equal(interrupted, true, 'reach the actual forced-removal crash checkpoint');
  await assert.rejects(lstat(join(route, item.name)), {code: 'ENOENT'});
  const backups = await listBackups(paths); assert.equal(backups.length, 1);
  const backup = join(paths.backups, backups[0].id, item.route, item.name, 'SKILL.md');
  assert.equal(await readFile(backup, 'utf8'), content.toString());
  const journals = (await readdir(join(paths.data, 'sync-pending'))).filter(name => /^[a-f0-9]{64}\.json$/u.test(name));
  assert.equal(journals.length, 1);
  const journal = join(paths.data, 'sync-pending', journals[0]), retainedJournal = await readFile(journal, 'utf8');
  assert.equal(JSON.parse(retainedJournal).operation, 'remove');
  assert.equal((await engine.locks.read()).entries[0].removed, undefined, 'the durable removal has not committed');
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(reconcileLinuxRecovery([paths.data], []), {code: 'LINUX_LOCK_RETIREMENT_UNVERIFIED'});
    assert.equal(await readFile(journal, 'utf8'), retainedJournal, 'recovery preserves the pending intent');
    assert.equal(await readFile(backup, 'utf8'), content.toString(), 'recovery preserves the moved skill');
    assert.equal((await engine.locks.read()).entries[0].removed, undefined, 'recovery cannot manufacture transaction completion');
  }
  options.crash = undefined;
  const restarted = new SyncEngine(options); await restarted.reconcile();
  assert.equal(await readFile(journal, 'utf8'), 'null\n', 'only the sync engine settles its transaction');
  assert.equal((await restarted.locks.read()).entries[0].removed, true);
  assert.deepEqual(await restarted.locks.allPending(), []);
  await assert.rejects(reconcileLinuxRecovery([paths.data], []), {code: 'LINUX_LOCK_RETIREMENT_UNVERIFIED'},
    'a settled sync intent does not certify every retained backup or external restore obligation');
  assert.equal(await readFile(backup, 'utf8'), content.toString());
});
