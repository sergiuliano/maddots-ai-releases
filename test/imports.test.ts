import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { treeDigest } from '../src/shared/build-format.js';
import type { HelperImportSession } from '../src/shared/helper-imports-protocol.js';
import { ApiClient } from '../src/api.js';
import { listBackups, restoreBackup } from '../src/backups.js';
import { runCli } from '../src/cli.js';
import { readConfig } from '../src/config.js';
import { FolderDeliveryTarget } from '../src/delivery/index.js';
import { ImportEngine, type ReplaceLocalInstruction, type ImportOptions } from '../src/imports.js';
import { atomicWrite, createPaths, ensurePaths } from '../src/paths.js';
import { durableRename } from '../src/safe-fs.js';
import { listUnmanaged, unmanagedInventory } from '../src/unmanaged.js';
import { FileSecretStore } from '../src/secret-store.js';
import { StateStore } from '../src/state.js';
import { SyncEngine, type SyncPlan } from '../src/sync.js';
import { BuildVerifier, signedBuildString, type PlanItem, type SignedBuild } from '../src/verify.js';

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-imports-')), home = join(root, 'home');
  await mkdir(home, {mode: 0o700});
  const paths = await createPaths(readConfig({}, home)); await ensurePaths(paths);
  for (const key of ['.codex', '.codex-work', '.codex-client', '.agents', '.continue']) await mkdir(join(home, key, 'skills'), {recursive: true});
  let now = Date.parse('2026-10-14T12:00:00Z'), sessions: HelperImportSession[] = [], conditional = false, failResults = false, denyResults = false, tokenResults = false;
  let servedPlan: SyncPlan | undefined;
  const timing = {now: () => now, sleep: async (ms: number) => {now += ms;}};
  const calls: {path: string; body?: any; revision: string | null}[] = [], builds = new Map<string, SignedBuild>();
  const request: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname, body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const revision = new Headers(init?.headers).get('if-none-match');
    calls.push({path, body, revision});
    if (path === '/api/helper/imports') return Response.json({data: sessions});
    if (path.endsWith('/uploads')) return Response.json({data: {sessionId: path.split('/')[4], state: 'done', resultVersionIds: [randomUUID()]}});
    if (path.endsWith('/results')) {
      if (failResults && body.status === 'replaced') throw new Error('fixture offline');
      if (tokenResults && body.status === 'replaced') return Response.json({error: {code: 'TOKEN_REVOKED'}}, {status: 401});
      if (denyResults && body.status === 'replaced') return Response.json({error: {code: 'IMPORT_SESSION_INVALID'}}, {status: 403});
      return Response.json({data: {sessionId: path.split('/')[4], state: 'blocked', resultVersionIds: []}});
    }
    if (path === '/api/helper/inventory') return Response.json({data: {ok: true}});
    if (path === '/api/helper/plan' && servedPlan) return revision === servedPlan.planRevision
      ? new Response(null, {status: 304}) : Response.json({data: servedPlan});
    if (path === '/api/helper/plan' && conditional) return new Response(null, {status: 304});
    if (path.startsWith('/api/helper/builds/')) return Response.json({data: builds.get(new URL(path, 'http://x').pathname.split('/').at(-1)!)});
    throw new Error('Unexpected fixture route');
  };
  const client = new ApiClient(new URL('https://ai.maddots.app'), request), signer = generateKeyPairSync('ed25519');
  const publicKey = signer.publicKey.export({type: 'spki', format: 'der'}).subarray(-32), keyId = createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
  const verifier = new BuildVerifier({keys: [{keyId, publicKey: publicKey.toString('base64')}], env: {}});
  const targets = [new FolderDeliveryTarget(paths, 'agents-folder', join(home, '.agents/skills')),
    new FolderDeliveryTarget(paths, 'continue-folder', join(home, '.continue/skills'))];
  const engine = (changes: Partial<ImportOptions> = {}) => new ImportEngine({paths, helperId: 'helper-test', client, targets, verifier, timing, ...changes});
  const sync = (allowed = false) => new SyncEngine({paths, helperId: 'helper-test', client, targets, verifier, timing,
    watchRoute: () => ({close() {}}), allowedBuild: async () => allowed});
  const session = (names: string[], changes: Partial<HelperImportSession> = {}): HelperImportSession => ({sessionId: randomUUID(), tool: 'codex',
    folders: names.map(folderName => ({home: '.codex', folderName})), expiresAt: now + 1_800_000, ...changes});
  const original = (name: string, key = '.codex') => join(home, key, 'skills', name);
  const skill = async (name: string, text = 'Original local content\n', key = '.codex') => {
    await mkdir(original(name, key), {recursive: true}); await writeFile(join(original(name, key), 'SKILL.md'), text);
  };
  function build(name = 'example', hasCode = false): SignedBuild {
    const content = Buffer.from(hasCode ? '! echo managed\n' : name === 'example' ? 'Managed delivery\n' : `Managed ${name}\n`);
    const build: SignedBuild = {format: 1, skillId: name === 'other' ? 'skill-other' : 'skill-test', version: 1, settingsRevision: 0, level: 'workspace', workspaceId: 'workspace-test', boardId: null,
      target: 'folder', name, keyId, signature: '', digest: treeDigest([{path: 'SKILL.md', mode: '100644', content}]), hasCode, draft: false,
      files: [{path: 'SKILL.md', mode: '100644', size: content.length, content: content.toString('base64'), sha256: createHash('sha256').update(content).digest('hex')}],
      report: {renamedFrom: null, unsetSettings: [], unresolvedOptionalReferences: []}};
    build.signature = sign(null, Buffer.from(signedBuildString(build)), signer.privateKey).toString('base64'); builds.set(build.digest, build); return build;
  }
  const item = (build: SignedBuild): PlanItem => ({...build, itemId: createHash('sha256').update(build.digest).digest('hex'), kind: 'install',
    sourceName: build.name, workspaceIds: [build.workspaceId], boardIds: [], route: 'agents-folder', fromVersion: null, dependencyOf: null,
    missingDependencies: [], forAgentIds: [], state: 'approved', answer: 'update', reason: null, restartHints: []});
  const plan = (items: PlanItem[] = [], instructions: unknown[] = [], degraded = false): SyncPlan => ({planRevision: randomUUID(), degraded, pollAfterSeconds: 60, items, instructions, revoked: []});
  const instruction = (session: HelperImportSession, name = 'example'): ReplaceLocalInstruction => ({type: 'replace_local', sessionId: session.sessionId,
    skillId: name === 'other' ? 'skill-other' : 'skill-test', home: '.codex', folderName: name, alsoLinkedFrom: []});
  return {root, home, paths, timing, calls, request, engine, sync, session, original, skill, build, item, plan, instruction,
    setSessions(value: HelperImportSession[]) {sessions = value;}, advance(ms: number) {now += ms;}, conditional() {conditional = true;},
    setPlan(value: SyncPlan) {servedPlan = value;},
    resultsFail(value: boolean) {failResults = value;}, resultsDeny(value: boolean) {denyResults = value;}, resultsToken(value: boolean) {tokenResults = value;}, close: () => rm(root, {recursive: true, force: true})};
}

test('every selected folder is scanned before one upload; blocked bytes and filenames never leave the helper', async () => {
  const f = await fixture();
  try {
    const secret = ['mdai', 'skill', 'SYNTHETIC_TEST_ONLY_'.repeat(2)].join('_');
    await f.skill('safe'); await f.skill('blocked', `Blocked-only text ${secret}`);
    await writeFile(join(f.original('blocked'), `${secret}.txt`), 'clean');
    await f.skill('safe-two'); await writeFile(join(f.original('safe-two'), '.DS_Store'), 'ignored');
    const session = f.session(['safe', 'blocked', 'safe-two']); f.setSessions([session]);
    await f.engine().poll();
    const mutations = f.calls.filter(call => call.body);
    assert.deepEqual(mutations.map(call => call.path.split('/').at(-1)), ['results', 'uploads']);
    assert.equal(mutations[0].body.status, 'blocked'); assert.ok(mutations[0].body.findings.some((item: any) => item.path === '[redacted]'));
    assert.deepEqual(mutations[1].body.folders.map((item: any) => item.folderName), ['safe', 'safe-two']);
    const sent = JSON.stringify(mutations);
    for (const value of [secret, Buffer.from(`Blocked-only text ${secret}`).toString('base64'), 'Blocked-only text', f.home, '.DS_Store']) assert.ok(!sent.includes(value));
    assert.ok(!await readFile(join(f.paths.data, 'imports.json'), 'utf8').then(value => value.includes(secret)));
  } finally {await f.close();}
});

test('all blocked, oversized files and inner links produce only metadata results, allowing clean siblings', async () => {
  const f = await fixture();
  try {
    await f.skill('large'); await writeFile(join(f.original('large'), 'too-large.txt'), Buffer.alloc(1024 * 1024 + 1));
    await f.skill('linked'); await symlink(join(f.original('large'), 'SKILL.md'), join(f.original('linked'), 'inner.txt'));
    await f.skill('clean');
    const listed = unmanagedInventory(await listUnmanaged(f.paths));
    assert.deepEqual(listed.map(ref => ref.folderName).sort(), ['clean', 'large', 'linked']);
    f.setSessions([f.session(listed.map(ref => ref.folderName))]); await f.engine().poll();
    assert.deepEqual(f.calls.filter(call => call.path.endsWith('/results')).map(call => [call.body.folderName, call.body.findings[0].rule]).sort(),
      [['large', 'file-size-limit'], ['linked', 'unsafe-path']]);
    assert.deepEqual(f.calls.find(call => call.path.endsWith('/uploads'))!.body.folders.map((folder: any) => folder.folderName), ['clean']);
    f.calls.length = 0; f.setSessions([f.session(['large', 'linked'])]); await f.engine().poll();
    assert.equal(f.calls.filter(call => call.path.endsWith('/uploads')).length, 0);
    assert.equal(f.calls.filter(call => call.path.endsWith('/results')).length, 2);
  } finally {await f.close();}
});

test('unknown homes, expired sessions and ambiguous bare folder names send no content', async () => {
  const f = await fixture();
  try {
    await f.skill('example');
    for (const session of [f.session(['example'], {expiresAt: f.timing.now()}), f.session(['example'], {folders: [{home: '../outside', folderName: 'example'}]})]) {
      f.setSessions([session]); await assert.rejects(f.engine().poll()); assert.equal(f.calls.filter(call => call.body).length, 0);
    }
    await f.skill('example', 'Different home content', '.codex-work');
    f.setSessions([f.session(['example'])]); await f.engine().poll();
    assert.deepEqual(f.calls.filter(call => call.body).map(call => call.body), [{folderName: 'example', status: 'unavailable', reason: 'ambiguous'}]);
  } finally {await f.close();}
});

test('10 MiB folder cap blocks locally and combined clean folders honor the one HTTP upload cap', async () => {
  const f = await fixture();
  try {
    await f.skill('large');
    for (let index = 0; index < 11; index++) await writeFile(join(f.original('large'), `file-${index}.txt`), Buffer.alloc(1024 * 1024));
    const listed = unmanagedInventory(await listUnmanaged(f.paths));
    assert.ok(listed.some(ref => ref.folderName === 'large'));
    f.setSessions([f.session(listed.map(ref => ref.folderName))]); await f.engine().poll();
    assert.equal(f.calls.filter(call => call.path.endsWith('/uploads')).length, 0);
    assert.equal(f.calls.find(call => call.body)!.body.findings[0].rule, 'folder-size-limit');
    for (const name of ['first', 'second']) {
      await f.skill(name);
      for (let index = 0; index < 6; index++) await writeFile(join(f.original(name), `file-${index}.txt`), Buffer.alloc(1024 * 1024));
    }
    f.calls.length = 0; f.setSessions([f.session(['first', 'second'])]);
    await f.engine().poll();
    const upload = f.calls.find(call => call.path.endsWith('/uploads'))!;
    assert.deepEqual(upload.body.folders.map((folder: any) => folder.folderName), ['first']);
    assert.ok(Buffer.byteLength(JSON.stringify(upload.body)) <= 14 * 1024 * 1024);
    assert.deepEqual(f.calls.find(call => call.path.endsWith('/results'))!.body.findings.map((finding: any) => finding.rule), ['upload-size-limit']);
  } finally {await f.close();}
});

test('code held for Allow keeps local copies; replacement runs after that exact build is allowed and delivered', async () => {
  const f = await fixture();
  try {
    await f.skill('example'); const session = f.session(['example']); f.setSessions([session]); await f.engine().poll();
    const build = f.build('example', true), plan = f.plan([f.item(build)], [f.instruction(session)]);
    const held = f.sync(); await held.reconcile(); await held.applyPlan(plan);
    assert.equal((await listBackups(f.paths)).length, 0); await assert.rejects(lstat(join(f.home, '.agents/skills/example')), {code: 'ENOENT'});
    assert.equal(await readFile(join(f.original('example'), 'SKILL.md'), 'utf8'), 'Original local content\n');
    const allowed = f.sync(true); await allowed.reconcile(); await allowed.applyPlan(f.plan([f.item(build)], [f.instruction(session)]));
    assert.equal((await listBackups(f.paths)).length, 1); await assert.rejects(lstat(f.original('example')), {code: 'ENOENT'});
    assert.equal(await readFile(join(f.home, '.agents/skills/example/SKILL.md'), 'utf8'), '! echo managed\n');
  } finally {await f.close();}
});

test('replacement needs the instruction and verified delivered copy, preserves originals and removes linked aliases', async () => {
  const f = await fixture();
  try {
    await f.skill('example');
    for (const home of ['.codex-work', '.codex-client']) await symlink(f.original('example'), f.original('example', home));
    const session = f.session(['example']); f.setSessions([session]); await f.engine().poll();
    const sync = f.sync(); await sync.reconcile();
    await sync.applyPlan(f.plan([], [f.instruction(session)]));
    assert.equal(await readFile(join(f.original('example'), 'SKILL.md'), 'utf8'), 'Original local content\n');
    assert.equal((await listBackups(f.paths)).length, 0);
    const build = f.build(); await sync.applyPlan(f.plan([f.item(build)], [f.instruction(session)]));
    for (const home of ['.codex', '.codex-work', '.codex-client']) await assert.rejects(lstat(f.original('example', home)), {code: 'ENOENT'});
    const backups = await listBackups(f.paths); assert.equal(backups.length, 1); assert.equal(backups[0].unmanaged!.links.length, 2);
    assert.equal(await readFile(join(f.paths.backups, backups[0].id, 'local-import/example/SKILL.md'), 'utf8'), 'Original local content\n');
    assert.equal(await readFile(join(f.home, '.agents/skills/example/SKILL.md'), 'utf8'), 'Managed delivery\n');
    const lock = JSON.parse(await readFile(join(f.paths.data, 'lock.json'), 'utf8')); assert.equal(lock.replaced[0].backupId, backups[0].id);
    assert.ok(f.calls.some(call => call.body?.status === 'replaced' && call.body.backupId === backups[0].id));
    await restoreBackup(f.paths, backups[0].id); await sync.applyPlan(f.plan([], [f.instruction(session)]));
    assert.equal(await readFile(join(f.original('example'), 'SKILL.md'), 'utf8'), 'Original local content\n', 'replayed instructions cannot move a restored copy again');
  } finally {await f.close();}
});

test('TLS-49 replaces a dsh copy only after Replace local copies and preserves it in a restorable backup', async () => {
  const f = await fixture();
  try {
    const original = f.original('example', '.dsh'), text = 'Original dsh content\n';
    await f.skill('example', text, '.dsh');
    await mkdir(join(original, 'references')); await writeFile(join(original, 'references/context.md'), 'Local context\n');
    await f.skill('personal', 'Unrelated dsh skill\n', '.dsh');
    const session = f.session(['example'], {tool: 'deepseek-harness', folders: [{home: '.dsh', folderName: 'example'}]});
    f.setSessions([session]); await f.engine().poll();
    f.setSessions([]);
    const sync = f.sync(); await sync.reconcile();
    const build = f.build(); await sync.applyPlan(f.plan([f.item(build)]));
    assert.equal(await readFile(join(original, 'SKILL.md'), 'utf8'), text);
    assert.deepEqual(await listBackups(f.paths), [], 'Import and ordinary sync leave the local copy in place.');
    const instruction = {...f.instruction(session), home: '.dsh'};
    await sync.applyPlan(f.plan([], [instruction]));
    await assert.rejects(lstat(original), {code: 'ENOENT'});
    const [backup] = await listBackups(f.paths);
    assert.ok(backup); assert.equal((await listBackups(f.paths)).length, 1);
    assert.equal(backup.originalPath, '.dsh/skills/example');
    assert.equal(backup.reason, 'local-import');
    assert.deepEqual(backup.unmanaged!.original, {home: '.dsh', folderName: 'example'});
    const saved = join(f.paths.backups, backup.id, 'local-import/example');
    assert.equal(await readFile(join(saved, 'SKILL.md'), 'utf8'), text);
    assert.equal(await readFile(join(saved, 'references/context.md'), 'utf8'), 'Local context\n');
    assert.equal(await readFile(join(f.home, '.agents/skills/example/SKILL.md'), 'utf8'), 'Managed delivery\n');
    assert.equal(await readFile(join(f.original('personal', '.dsh'), 'SKILL.md'), 'utf8'), 'Unrelated dsh skill\n');
    assert.ok(f.calls.some(call => call.body?.home === '.dsh' && call.body.status === 'replaced' && call.body.backupId === backup.id));
    await restoreBackup(f.paths, backup.id);
    assert.equal(await readFile(join(original, 'SKILL.md'), 'utf8'), text);
    assert.equal(await readFile(join(original, 'references/context.md'), 'utf8'), 'Local context\n');
    await sync.applyPlan(f.plan([], [instruction]));
    assert.equal(await readFile(join(original, 'SKILL.md'), 'utf8'), text, 'Replaying the recorded click leaves a restored copy alone.');
  } finally {await f.close();}
});

test('delivery without a click and forged or edited managed stamps preserve the local original', async () => {
  const f = await fixture();
  try {
    await f.skill('example'); const session = f.session(['example']); f.setSessions([session]); await f.engine().poll();
    const sync = f.sync(); await sync.reconcile(); const build = f.build(); await sync.applyPlan(f.plan([f.item(build)]));
    assert.equal((await listBackups(f.paths)).length, 0);
    await writeFile(join(f.home, '.agents/skills/example/SKILL.md'), 'Edited delivered copy');
    await f.engine().applyInstructions([f.instruction(session)]); assert.equal((await listBackups(f.paths)).length, 0);
    await writeFile(join(f.home, '.agents/skills/example/SKILL.md'), 'Managed delivery\n');
    const stampFile = join(f.home, '.agents/skills/example/.maddots/skill.json'), genuine = await readFile(stampFile, 'utf8');
    await writeFile(stampFile, JSON.stringify({...JSON.parse(genuine), signature: Buffer.alloc(64).toString('base64')}), {mode: 0o600});
    await f.engine().applyInstructions(); assert.equal((await listBackups(f.paths)).length, 0, 'forged stamp');
    await writeFile(stampFile, genuine, {mode: 0o600});
    const forged = {...f.instruction(session), sessionId: randomUUID()};
    // The previously recorded genuine click is still pending; defer it while checking forged input.
    await writeFile(join(f.home, '.agents/skills/example/SKILL.md'), 'Edited delivered copy');
    await f.engine().applyInstructions([forged]);
    assert.equal((await listBackups(f.paths)).length, 0);
    assert.equal(await readFile(join(f.original('example'), 'SKILL.md'), 'utf8'), 'Original local content\n');
  } finally {await f.close();}
});

test('an outer selected alias and its canonical folder are preserved once before replacement', async () => {
  const f = await fixture();
  try {
    await f.skill('example', 'Canonical original\n', '.codex-work');
    await symlink(f.original('example', '.codex-work'), f.original('example'));
    const session = f.session(['example']); f.setSessions([session]); await f.engine().poll();
    const instruction = {...f.instruction(session), home: '.codex-work', alsoLinkedFrom: [{home: '.codex-work', folderName: 'example'}]};
    const sync = f.sync(); await sync.reconcile(); await sync.applyPlan(f.plan([f.item(f.build())], [instruction]));
    const backup = (await listBackups(f.paths))[0]; assert.equal(backup.unmanaged!.links.length, 1);
    assert.equal(backup.originalPath, '.codex-work/skills/example');
    await assert.rejects(lstat(f.original('example')), {code: 'ENOENT'});
    await assert.rejects(lstat(f.original('example', '.codex-work')), {code: 'ENOENT'});
    assert.equal(await readFile(join(f.paths.backups, backup.id, 'local-import/example/SKILL.md'), 'utf8'), 'Canonical original\n');
  } finally {await f.close();}
});

test('deferred replacement survives restart and 304, and retries a lost receipt without another backup', async () => {
  const f = await fixture();
  try {
    await f.skill('example'); const session = f.session(['example']); f.setSessions([session]); await f.engine().poll();
    const sync = f.sync(); await sync.reconcile(); const build = f.build();
    await sync.applyPlan(f.plan([f.item(build)]));
    const managed = join(f.home, '.agents/skills/example/SKILL.md');
    await writeFile(managed, 'Edited delivered copy\n');
    await sync.applyPlan(f.plan([], [f.instruction(session)]));
    assert.equal((await listBackups(f.paths)).length, 0, 'an unverifiable managed copy defers the recorded click');
    await writeFile(managed, 'Managed delivery\n');
    await sync.applyPlan(f.plan([], [], true));
    assert.equal((await listBackups(f.paths)).length, 0, 'a degraded plan runs no replacement');
    f.conditional(); f.advance(60_000); await f.sync().tick();
    assert.equal((await listBackups(f.paths)).length, 0, '304 must retain degraded restriction');
    f.resultsFail(true);
    await assert.rejects(sync.applyPlan(f.plan([f.item(build)], [f.instruction(session)], false)), {code: 'API_CONNECTION_FAILED'});
    assert.equal((await listBackups(f.paths)).length, 1);
    const withdrawn = f.plan(); f.setPlan(withdrawn);
    await assert.rejects(sync.applyPlan(withdrawn), {code: 'API_CONNECTION_FAILED'});
    f.resultsFail(false); await f.sync().tick();
    assert.equal((await listBackups(f.paths)).length, 1);
    const results = f.calls.filter(call => call.body?.status === 'replaced'); assert.equal(results.length, 3);
    assert(results.every(result => result.body.backupId === results[0].body.backupId));
  } finally {await f.close();}
});

test('an authorized deferred replacement survives restart and recovers on 304 without a new full plan', async () => {
  const f = await fixture();
  try {
    await f.skill('example'); const session = f.session(['example']); f.setSessions([session]); await f.engine().poll();
    const sync = f.sync(); await sync.reconcile(); await sync.applyPlan(f.plan([f.item(f.build())]));
    const managed = join(f.home, '.agents/skills/example/SKILL.md');
    await writeFile(managed, 'Edited\n');
    const authorized = f.plan([], [f.instruction(session)]); await sync.applyPlan(authorized); f.setPlan(authorized);
    sync.close();
    const restarted = f.sync(); await restarted.tick();
    assert.equal(f.calls.filter(call => call.path === '/api/helper/plan').at(-1)!.revision, authorized.planRevision);
    assert.equal((await listBackups(f.paths)).length, 0);
    await writeFile(managed, 'Managed delivery\n');
    f.advance(60_000); await restarted.tick(); restarted.close();
    await assert.rejects(lstat(f.original('example')), {code: 'ENOENT'});
    assert.equal((await listBackups(f.paths)).length, 1);
    assert.equal(f.calls.filter(call => call.body?.status === 'replaced').length, 1);
  } finally {await f.close();}
});

for (const mismatch of ['omitted', 'sessionId', 'skillId', 'home', 'folderName'] as const)
  test(`a full plan with ${mismatch} replacement authorization suspends the original across restart and 304 until reauthorized`, async () => {
    const f = await fixture();
    try {
      await f.skill('example'); const session = f.session(['example']); f.setSessions([session]); await f.engine().poll();
      const sync = f.sync(); await sync.reconcile(); await sync.applyPlan(f.plan([f.item(f.build())]));
      const managed = join(f.home, '.agents/skills/example/SKILL.md');
      await writeFile(managed, 'Edited\n');
      const instruction = f.instruction(session);
      await sync.applyPlan(f.plan([], [instruction]));
      await writeFile(managed, 'Managed delivery\n');
      const withdrawn = f.plan([], mismatch === 'omitted' ? [] : [{...instruction, [mismatch]: 'different'}]);
      await sync.applyPlan(withdrawn); f.setPlan(withdrawn); sync.close();
      const restarted = f.sync(); await restarted.tick(); restarted.close();
      assert.equal(f.calls.filter(call => call.path === '/api/helper/plan').at(-1)!.revision, withdrawn.planRevision);
      assert.equal(await readFile(join(f.original('example'), 'SKILL.md'), 'utf8'), 'Original local content\n');
      assert.equal((await listBackups(f.paths)).length, 0);
      assert.equal(f.calls.filter(call => call.body?.status === 'replaced').length, 0);
      const folder = JSON.parse(await readFile(join(f.paths.data, 'imports.json'), 'utf8')).sessions[0].folders[0];
      assert.equal(folder.authorized, false); assert.equal(folder.failed, undefined);
      await sync.applyPlan(f.plan([], [instruction]));
      await assert.rejects(lstat(f.original('example')), {code: 'ENOENT'});
      assert.equal((await listBackups(f.paths)).length, 1);
    } finally {await f.close();}
  });

test('an older journal without retained full-plan authorization cannot start a replacement on 304', async () => {
  const f = await fixture();
  try {
    await f.skill('example'); const session = f.session(['example']); f.setSessions([session]); await f.engine().poll();
    const sync = f.sync(); await sync.reconcile(); await sync.applyPlan(f.plan([f.item(f.build())]));
    const file = join(f.paths.data, 'imports.json'), journal = JSON.parse(await readFile(file, 'utf8'));
    journal.sessions[0].folders[0].instruction = f.instruction(session);
    await atomicWrite(file, JSON.stringify(journal));
    f.conditional(); await f.sync().tick();
    assert.equal(f.calls.filter(call => call.path === '/api/helper/plan').at(-1)!.revision, null,
      'an older journal must request a fresh full plan instead of remaining suspended behind its old ETag');
    assert.equal((await listBackups(f.paths)).length, 0);
    assert.equal(await readFile(join(f.original('example'), 'SKILL.md'), 'utf8'), 'Original local content\n');
    await sync.applyPlan(f.plan([], [f.instruction(session)]));
    await assert.rejects(lstat(f.original('example')), {code: 'ENOENT'});
  } finally {await f.close();}
});

test('an older queued replacement requests a full plan on restart and resumes when authorization is still present', async () => {
  const f = await fixture();
  try {
    await f.skill('example'); const session = f.session(['example']); f.setSessions([session]); await f.engine().poll();
    const sync = f.sync(); await sync.reconcile();
    const plan = f.plan([f.item(f.build())], [f.instruction(session)]);
    await sync.applyPlan({...plan, instructions: []});
    const file = join(f.paths.data, 'imports.json'), journal = JSON.parse(await readFile(file, 'utf8'));
    journal.sessions[0].folders[0].instruction = f.instruction(session);
    await atomicWrite(file, JSON.stringify(journal)); f.setPlan(plan);
    sync.close(); const restarted = f.sync(); await restarted.tick(); restarted.close();
    assert.equal(f.calls.filter(call => call.path === '/api/helper/plan').at(-1)!.revision, null);
    await assert.rejects(lstat(f.original('example')), {code: 'ENOENT'});
    assert.equal((await listBackups(f.paths)).length, 1);
  } finally {await f.close();}
});

test('CLI backups lists and restores offline, preserving an occupied current copy', async () => {
  const f = await fixture();
  try {
    await f.skill('example'); const session = f.session(['example']); f.setSessions([session]); await f.engine().poll();
    const sync = f.sync(); await sync.reconcile(); await sync.applyPlan(f.plan([f.item(f.build())], [f.instruction(session)]));
    const backup = (await listBackups(f.paths))[0], output: string[] = [];
    const options = {home: f.home, env: {}, output: (line: string) => output.push(line),
      runner: async () => {assert.fail('Offline backups must not use credentials or external commands');},
      request: async () => {assert.fail('Offline backups must not call the server');}};
    await runCli(['backups'], options); assert.ok(output.some(line => line.includes(backup.id)));
    await f.skill('example', 'Current local edit\n'); await runCli(['backups', 'restore', backup.id], options);
    assert.equal(await readFile(join(f.original('example'), 'SKILL.md'), 'utf8'), 'Original local content\n');
    assert.equal((await listBackups(f.paths))[0].reason, 'restore-replaced');
    await assert.rejects(runCli(['backups', 'restore', '../escape'], options), {code: 'USAGE'});
    await assert.rejects(runCli(['backups', 'restore'], options), {code: 'USAGE'});
  } finally {await f.close();}
});

test('CLI import calls only the browser-selected upload using the saved skills token', async () => {
  const f = await fixture();
  try {
    await f.skill('example'); f.setSessions([f.session(['example'])]);
    await symlink(f.original('example'), f.original('example', '.codex-work'));
    const outside = join(f.home, 'my-skills/outside'); await mkdir(outside, {recursive: true}); await writeFile(join(outside, 'SKILL.md'), 'Outside\n');
    await symlink(outside, f.original('external', '.agents'));
    const tokenFile = join(f.home, '.tokens/skills-token.json'), credential = 'mdai_skill_' + 'A'.repeat(43);
    await mkdir(join(f.home, '.tokens'), {mode: 0o700});
    const secrets = await FileSecretStore.open(tokenFile, f.paths, {explicit: true, confirmed: true, scopes: ['sync', 'import_upload']});
    await secrets.set('skills-token', credential, ['sync', 'import_upload']);
    const state = new StateStore(f.paths, new URL('https://ai.maddots.app'));
    await state.write({...await state.read(), status: 'connected', helperId: 'helper-test', scopes: ['sync', 'import_upload'], tokenStorage: 'file', tokenFile});
    const output: string[] = [];
    await runCli(['import'], {home: f.home, env: {}, timing: f.timing, output: line => output.push(line), request: async (url, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${credential}`); return f.request(url, init);
    }});
    assert.equal(f.calls.filter(call => call.path.endsWith('/uploads')).length, 1);
    assert.ok(output.some(line => line.includes('done')));
    assert.ok(output.includes('.codex/example (also linked from .codex-work/example)'), output.join('\n'));
    assert.ok(output.includes(`.agents/external -> ${outside}`), output.join('\n'));
    assert.ok(!output.join('\n').includes(credential));
    f.setSessions([]); f.calls.length = 0;
    await runCli(['import'], {home: f.home, env: {}, timing: f.timing, output: line => output.push(line), request: f.request});
    assert.ok(output.some(line => line.includes('tick the folders'))); assert.equal(f.calls.filter(call => call.body).length, 0);
    await atomicWrite(f.paths.state, JSON.stringify({...await state.read(), status: 'unpaired'}));
    await assert.rejects(runCli(['import'], {home: f.home, env: {}}), {code: 'TOKEN_REQUIRED'});
  } finally {await f.close();}
});

for (const action of ['deleted', 'renamed'] as const) test(`a ${action} original fails independently and never stalls plans or 304 sync`, async () => {
  const f = await fixture();
  try {
    await f.skill('example'); await f.skill('other');
    const session = f.session(['example', 'other']); f.setSessions([session]); await f.engine().poll();
    const sync = f.sync(); await sync.reconcile();
    await sync.applyPlan(f.plan([f.item(f.build()), f.item(f.build('other'))]));
    // Record the click while delivery is temporarily unverifiable, then remove the original.
    await writeFile(join(f.home, '.agents/skills/example/SKILL.md'), 'Edited\n');
    await sync.applyPlan(f.plan([], [f.instruction(session)]));
    if (action === 'deleted') await rm(f.original('example'), {recursive: true});
    else await rename(f.original('example'), f.original('example-old'));
    await writeFile(join(f.home, '.agents/skills/example/SKILL.md'), 'Managed delivery\n');
    const next = f.plan([], [f.instruction(session), f.instruction(session, 'other')]); await sync.applyPlan(next);
    const journal = JSON.parse(await readFile(join(f.paths.data, 'imports.json'), 'utf8'));
    assert.equal(journal.sessions[0].folders.find((folder: any) => folder.folderName === 'example').failed, 'ORIGINAL_MISSING');
    assert.equal((await listBackups(f.paths)).length, 1, 'only the second folder is backed up');
    assert.ok(f.calls.some(call => call.body?.folderName === 'other' && call.body.status === 'replaced'));
    assert.equal(f.calls.filter(call => call.body?.folderName === 'example' && call.body.status === 'replaced').length, 0);
    assert.equal(JSON.parse(await readFile(join(f.paths.data, 'sync-meta.json'), 'utf8')).planRevision, next.planRevision);
    const empty = f.plan(); await sync.applyPlan(empty);
    f.conditional(); f.advance(60_000); await sync.tick();
    assert.equal((sync as any).failures, 0);
    assert.equal(JSON.parse(await readFile(join(f.paths.data, 'sync-meta.json'), 'utf8')).planRevision, empty.planRevision);
    if (action === 'renamed') assert.equal(await readFile(join(f.original('example-old'), 'SKILL.md'), 'utf8'), 'Original local content\n');
  } finally {await f.close();}
});

test('a removed alias stops only its replacement while a later instruction still completes', async () => {
  const f = await fixture();
  try {
    await f.skill('example'); await f.skill('other');
    await symlink(f.original('example'), f.original('example', '.codex-work'));
    const session = f.session(['example', 'other']); f.setSessions([session]); await f.engine().poll();
    const sync = f.sync(); await sync.reconcile();
    await sync.applyPlan(f.plan([f.item(f.build()), f.item(f.build('other'))]));
    await rm(f.original('example', '.codex-work'));
    const next = f.plan([], [f.instruction(session), f.instruction(session, 'other')]); await sync.applyPlan(next);
    assert.equal(await readFile(join(f.original('example'), 'SKILL.md'), 'utf8'), 'Original local content\n');
    const backups = await listBackups(f.paths); assert.equal(backups.length, 1); assert.equal(backups[0].folderName, 'other');
    const empty = f.plan(); await sync.applyPlan(empty);
    f.conditional(); f.advance(60_000); await sync.tick(); assert.equal((sync as any).failures, 0);
    assert.equal(JSON.parse(await readFile(join(f.paths.data, 'sync-meta.json'), 'utf8')).planRevision, empty.planRevision);
  } finally {await f.close();}
});

test('an absent alsoLinkedFrom alias is skipped and the original is replaced with one backup', async () => {
  const f = await fixture();
  try {
    await f.skill('example');
    const session = f.session(['example']); f.setSessions([session]); await f.engine().poll();
    const sync = f.sync(); await sync.reconcile(); await sync.applyPlan(f.plan([f.item(f.build())]));
    const instruction = {...f.instruction(session), alsoLinkedFrom: [{home: '.codex-client', folderName: 'gone'}]};
    await symlink(f.original('example'), f.original('gone', '.codex-client'));
    await rm(f.original('gone', '.codex-client'));
    await sync.applyPlan(f.plan([], [instruction]));
    const backups = await listBackups(f.paths); assert.equal(backups.length, 1);
    assert.deepEqual(backups[0].unmanaged!.links, []);
    await assert.rejects(lstat(f.original('example')), {code: 'ENOENT'});
    assert.equal(await readFile(join(f.paths.backups, backups[0].id, 'local-import/example/SKILL.md'), 'utf8'), 'Original local content\n');
    assert.deepEqual(f.calls.filter(call => call.body?.status === 'replaced').map(call => call.body.backupId), [backups[0].id]);
  } finally {await f.close();}
});

test('a refused replacement receipt is terminal, preserves its one backup and permits forced removal', async () => {
  const f = await fixture();
  try {
    await f.skill('example'); const session = f.session(['example']); f.setSessions([session]); await f.engine().poll();
    const sync = f.sync(); await sync.reconcile(); const build = f.build();
    await sync.applyPlan(f.plan([f.item(build)])); f.resultsDeny(true);
    await sync.applyPlan(f.plan([], [f.instruction(session)]));
    const journal = JSON.parse(await readFile(join(f.paths.data, 'imports.json'), 'utf8'));
    assert.equal(journal.sessions[0].folders[0].failed, 'IMPORT_SESSION_INVALID');
    assert.equal(journal.sessions[0].folders[0].complete, true);
    const backup = (await listBackups(f.paths))[0]; assert.ok(backup);
    await sync.applyPlan(f.plan()); f.conditional(); f.advance(60_000); await sync.tick();
    assert.equal((sync as any).failures, 0); assert.equal((await listBackups(f.paths)).length, 1);
    assert.equal(f.calls.filter(call => call.body?.status === 'replaced').length, 1);
    const remove = {...f.item(build), kind: 'forced_remove' as const, state: 'forced' as const, reason: 'revoked' as const, answer: null};
    await sync.applyPlan({...f.plan([remove]), revoked: [{skillId: build.skillId, digest: build.digest}]});
    await assert.rejects(lstat(join(f.home, '.agents/skills/example')), {code: 'ENOENT'});
    await restoreBackup(f.paths, backup.id);
    assert.equal(await readFile(join(f.original('example'), 'SKILL.md'), 'utf8'), 'Original local content\n');
  } finally {await f.close();}
});

test('unknown malformed and conflicting instructions never authorize a local move', async () => {
  const f = await fixture();
  try {
    await f.skill('example'); const session = f.session(['example']); f.setSessions([session]); await f.engine().poll();
    const sync = f.sync(); await sync.reconcile(); await sync.applyPlan(f.plan([f.item(f.build())]));
    await f.engine().applyInstructions([{...f.instruction(session), sessionId: randomUUID()}, {...f.instruction(session), home: '../outside'}]);
    assert.equal((await listBackups(f.paths)).length, 0);
    await writeFile(join(f.home, '.agents/skills/example/SKILL.md'), 'Edited\n');
    await f.engine().applyInstructions([f.instruction(session)]);
    await f.engine().applyInstructions([{...f.instruction(session), skillId: 'different-skill', alsoLinkedFrom: [{home: '.agents', folderName: 'example'}]}]);
    const journal = JSON.parse(await readFile(join(f.paths.data, 'imports.json'), 'utf8'));
    assert.equal(journal.sessions[0].folders[0].instruction.skillId, 'skill-test');
    assert.equal((await listBackups(f.paths)).length, 0);
    assert.equal(await readFile(join(f.original('example'), 'SKILL.md'), 'utf8'), 'Original local content\n');
  } finally {await f.close();}
});

test('replacement of a selected repository link preserves the target inode and unticked originals', async () => {
  const f = await fixture();
  try {
    const repo = join(f.home, 'Projects/georanker'), original = join(repo, 'skills/ai-discovery');
    await mkdir(join(repo, '.git'), {recursive: true}); await mkdir(original, {recursive: true});
    await writeFile(join(original, 'SKILL.md'), 'Repository original\n'); const inode = (await lstat(original)).ino;
    await symlink(original, f.original('ai-discovery')); await symlink(original, f.original('ai-discovery', '.codex-work'));
    await f.skill('unticked'); const session = f.session(['ai-discovery']); f.setSessions([session]); await f.engine().poll();
    const sync = f.sync(); await sync.reconcile();
    await sync.applyPlan(f.plan([f.item(f.build('ai-discovery'))], [f.instruction(session, 'ai-discovery')]));
    assert.equal((await lstat(original)).ino, inode); assert.equal(await readFile(join(original, 'SKILL.md'), 'utf8'), 'Repository original\n');
    for (const home of ['.codex', '.codex-work']) await assert.rejects(lstat(f.original('ai-discovery', home)), {code: 'ENOENT'});
    const backups = await listBackups(f.paths); assert.equal(backups.length, 1); assert.equal(backups[0].unmanaged!.keepOriginal, true);
    assert.equal(await readFile(join(f.original('unticked'), 'SKILL.md'), 'utf8'), 'Original local content\n');
    assert.ok(f.calls.some(call => call.body?.status === 'replaced'));
  } finally {await f.close();}
});

for (const layout of ['original', 'outer-link', 'alias'] as const) test(`protected Claude ${layout} is kept and reported once without stalling sync`, async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.home, '.claude/skills'), {recursive: true});
    if (layout === 'original') await f.skill('example', 'Claude original\n', '.claude');
    else {
      await f.skill('example');
      await symlink(f.original('example'), f.original('example', '.claude'));
    }
    const session = f.session(['example'], {tool: layout === 'alias' ? 'codex' : 'claude-code'});
    f.setSessions([session]); await f.engine().poll();
    const instruction = {...f.instruction(session), home: layout === 'alias' ? '.codex' : '.claude'};
    const sync = f.sync(); await sync.reconcile(); const plan = f.plan([], [instruction]); await sync.applyPlan(plan);
    assert.equal((await listBackups(f.paths)).length, 0);
    await lstat(f.original('example', '.claude'));
    assert.equal(await readFile(join(f.original('example', layout === 'original' ? '.claude' : '.codex'), 'SKILL.md'), 'utf8'),
      layout === 'original' ? 'Claude original\n' : 'Original local content\n');
    await sync.applyPlan(f.plan([], [instruction])); f.conditional(); f.advance(60_000); await sync.tick();
    assert.equal((sync as any).failures, 0);
    const results = f.calls.filter(call => call.body?.status === 'kept'); assert.equal(results.length, 1); assert.equal(results[0].body.reason, 'protected_home');
  } finally {await f.close();}
});

test('a managed copy on an unrelated route cannot replace the importing tool original', async () => {
  const f = await fixture();
  try {
    await f.skill('example'); const session = f.session(['example']); f.setSessions([session]); await f.engine().poll();
    const sync = f.sync(); await sync.reconcile(); const build = f.build();
    const unrelated = {...f.item(build), route: 'continue-folder'};
    const waiting = {...f.item(build), state: 'asking' as const, answer: null};
    await sync.applyPlan(f.plan([unrelated, waiting], [f.instruction(session)]));
    assert.equal(await readFile(join(f.home, '.continue/skills/example/SKILL.md'), 'utf8'), 'Managed delivery\n');
    assert.ok((await sync.locks.read()).entries.some(entry => entry.route === 'continue-folder' && entry.digest === build.digest));
    assert.deepEqual((await sync.inventory()).deliveryErrors, []);
    assert.equal(await readFile(join(f.original('example'), 'SKILL.md'), 'utf8'), 'Original local content\n');
    assert.equal((await listBackups(f.paths)).length, 0); assert.equal(f.calls.filter(call => call.body?.status === 'replaced').length, 0);
    // Distinct names keep the lock entries independent while testing route coverage for the same skill.
    await sync.applyPlan(f.plan([f.item(f.build('managed-codex'))], [f.instruction(session)]));
    assert.equal((await listBackups(f.paths)).length, 1); await assert.rejects(lstat(f.original('example')), {code: 'ENOENT'});
  } finally {await f.close();}
});

test('an outer alias cannot remove another tool owner sole physical copy', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.home, '.continue/skills'), {recursive: true}); await f.skill('source');
    await symlink(f.original('source'), f.original('example', '.continue'));
    const session = f.session(['example'], {tool: 'continue'}); f.setSessions([session]); await f.engine().poll();
    const sync = f.sync(); await sync.reconcile();
    const build = f.build('managed-continue');
    await sync.applyPlan(f.plan([{...f.item(build), route: 'continue-folder'}], [{...f.instruction(session), home: '.continue'}]));
    assert.equal(await readFile(join(f.home, '.continue/skills/managed-continue/SKILL.md'), 'utf8'), 'Managed managed-continue\n');
    assert.ok((await sync.locks.read()).entries.some(entry => entry.route === 'continue-folder' && entry.digest === build.digest));
    assert.deepEqual((await sync.inventory()).deliveryErrors, []);
    assert.equal((await listBackups(f.paths)).length, 0);
    assert.equal(await readFile(join(f.original('source'), 'SKILL.md'), 'utf8'), 'Original local content\n');
    assert.equal(f.calls.filter(call => call.body?.status === 'replaced').length, 0);
  } finally {await f.close();}
});

test('a revoked delivered copy never authorizes Replace local copies even when forced removal fails', async () => {
  const f = await fixture();
  try {
    await f.skill('example'); const session = f.session(['example']); f.setSessions([session]); await f.engine().poll();
    const sync = f.sync(); await sync.reconcile(); const build = f.build(); await sync.applyPlan(f.plan([f.item(build)]));
    const revoked = [{skillId: 'skill-test', digest: build.digest}];
    await sync.applyPlan({...f.plan([], [f.instruction(session)]), revoked});
    const remove = {...f.item(build), itemId: 'a'.repeat(64), kind: 'forced_remove' as const, state: 'forced' as const, reason: 'revoked' as const, answer: null, version: 99};
    await sync.applyPlan({...f.plan([remove], [f.instruction(session)]), revoked});
    assert.equal(await readFile(join(f.home, '.agents/skills/example/SKILL.md'), 'utf8'), 'Managed delivery\n');
    assert.equal((await listBackups(f.paths)).length, 0);
    assert.equal(await readFile(join(f.original('example'), 'SKILL.md'), 'utf8'), 'Original local content\n');
  } finally {await f.close();}
});

test('a delivered code build without its Allow record never authorizes Replace local copies', async () => {
  const f = await fixture();
  try {
    await f.skill('example'); const session = f.session(['example']); f.setSessions([session]); await f.engine().poll();
    const build = f.build('example', true), allowed = f.sync(true); await allowed.reconcile(); await allowed.applyPlan(f.plan([f.item(build)]));
    const lockFile = join(f.paths.data, 'lock.json'), lock = JSON.parse(await readFile(lockFile, 'utf8'));
    lock.entries = lock.entries.map((entry: any) => ({...entry, allowedDigests: []})); await atomicWrite(lockFile, JSON.stringify(lock));
    await f.engine().applyInstructions([f.instruction(session)]);
    assert.equal((await listBackups(f.paths)).length, 0);
    assert.equal(await readFile(join(f.original('example'), 'SKILL.md'), 'utf8'), 'Original local content\n');
  } finally {await f.close();}
});

test('a ticked name found only as a managed folder reports one unsafe-path result without uploading', async () => {
  const f = await fixture();
  try {
    const sync = f.sync(); await sync.reconcile(); await sync.applyPlan(f.plan([f.item(f.build())]));
    const managed = join(f.home, '.agents/skills/example');
    const stamp = await readFile(join(managed, '.maddots/skill.json'), 'utf8'), info = await lstat(managed);
    f.calls.length = 0; const session = f.session(['example']); f.setSessions([session]);
    assert.deepEqual(await f.engine().poll(), [{sessionId: session.sessionId, state: 'blocked', resultVersionIds: []}]);
    assert.equal(f.calls.filter(call => call.path.endsWith('/uploads')).length, 0);
    assert.deepEqual(f.calls.filter(call => call.path.endsWith('/results')).map(call => call.body), [{
      home: '.agents', folderName: 'example', status: 'blocked', findings: [{rule: 'unsafe-path', path: '[redacted]', line: 1}],
    }]);
    assert.equal(await readFile(join(f.home, '.agents/skills/example/SKILL.md'), 'utf8'), 'Managed delivery\n');
    assert.equal(await readFile(join(managed, '.maddots/skill.json'), 'utf8'), stamp);
    assert.equal((await lstat(managed)).ino, info.ino);
    assert.equal((await listBackups(f.paths)).length, 0);
  } finally {await f.close();}
});

test('an existing managed sibling never prevents importing the selected unmanaged original', async () => {
  const f = await fixture();
  try {
    await f.skill('example'); const sync = f.sync(); await sync.reconcile(); await sync.applyPlan(f.plan([f.item(f.build())]));
    f.calls.length = 0; f.setSessions([f.session(['example'])]); await f.engine().poll();
    const upload = f.calls.find(call => call.path.endsWith('/uploads'))!;
    assert.equal(upload.body.folders[0].home, '.codex');
    assert.equal(Buffer.from(upload.body.folders[0].files[0].content, 'base64').toString(), 'Original local content\n');
  } finally {await f.close();}
});

for (const home of ['.agents', '.codex-work']) test(`a clean skill in ${home} is uploaded with its resolved home`, async () => {
  const f = await fixture();
  try {
    await f.skill('example', 'Alternate home\n', home);
    f.setSessions([f.session(['example'], {folders: [{folderName: 'example'}]})]); await f.engine().poll();
    const upload = f.calls.find(call => call.path.endsWith('/uploads'))!;
    assert.equal(upload.body.folders[0].home, home); assert.equal(upload.body.folders[0].folderName, 'example');
  } finally {await f.close();}
});

test('ambiguous and missing names are non-security results and never starve a clean session', async () => {
  const f = await fixture();
  try {
    await f.skill('dup'); await f.skill('dup', 'Different\n', '.codex-work'); await f.skill('good');
    const ambiguous = f.session(['dup', 'missing']), clean = f.session(['good']);
    f.setSessions([ambiguous, clean]); await f.engine().poll();
    assert.deepEqual(f.calls.filter(call => call.path.endsWith('/uploads')).map(call => call.path.split('/')[4]), [clean.sessionId]);
    assert.deepEqual(f.calls.filter(call => call.path.endsWith('/results')).map(call => [call.body.status, call.body.reason]),
      [['unavailable', 'ambiguous'], ['unavailable', 'not_found']]);
    assert.ok(f.calls.filter(call => call.path.endsWith('/results')).every(call => !call.body.findings));
  } finally {await f.close();}
});

test('a same name in an unrelated home is ignored when resolving a selected Codex folder', async () => {
  const f = await fixture();
  try {
    await f.skill('example'); await f.skill('example', 'Unrelated Cursor\n', '.cursor');
    f.setSessions([f.session(['example'])]); await f.engine().poll();
    assert.equal(f.calls.filter(call => call.path.endsWith('/uploads')).length, 1);
    assert.equal(f.calls.find(call => call.path.endsWith('/uploads'))!.body.folders[0].home, '.codex');
  } finally {await f.close();}
});

test('an oversized first session reports the excess and a small second session uploads on the first poll', async () => {
  const f = await fixture();
  try {
    for (const name of ['first', 'second']) {
      await f.skill(name);
      for (let index = 0; index < 6; index++) await writeFile(join(f.original(name), `file-${index}.txt`), Buffer.alloc(1024 * 1024));
    }
    await f.skill('good'); const big = f.session(['first', 'second']), small = f.session(['good']);
    f.setSessions([big, small]); await f.engine().poll();
    assert.deepEqual(f.calls.filter(call => call.path.endsWith('/uploads')).map(call => call.path.split('/')[4]), [big.sessionId, small.sessionId]);
    assert.equal(f.calls.find(call => call.path.endsWith('/results'))!.body.findings[0].rule, 'upload-size-limit');
  } finally {await f.close();}
});

test('a session-local refusal is recorded as failed and does not prevent a later clean upload', async () => {
  const f = await fixture();
  try {
    await f.skill('good'); const bad = f.session(['missing'], {expiresAt: f.timing.now()}), good = f.session(['good']);
    f.setSessions([bad, good]); const receipts = await f.engine().poll();
    assert.deepEqual(receipts.map(receipt => [receipt.sessionId, receipt.state]), [[bad.sessionId, 'failed'], [good.sessionId, 'done']]);
    assert.deepEqual(f.calls.filter(call => call.path.endsWith('/uploads')).map(call => call.path.split('/')[4]), [good.sessionId]);
  } finally {await f.close();}
});

for (const outer of [false, true]) test(`engine restart resumes ${outer ? 'outer alias' : 'canonical original'} backup after the original moved`, async () => {
  const f = await fixture();
  try {
    const canonicalHome = outer ? '.codex-work' : '.codex';
    await f.skill('example', 'Original local content\n', canonicalHome);
    for (const home of ['.codex', '.codex-work', '.codex-client'].filter(home => home !== canonicalHome))
      await symlink(f.original('example', canonicalHome), f.original('example', home));
    const session = f.session(['example']); f.setSessions([session]); await f.engine().poll();
    const sync = f.sync(); await sync.reconcile(); await sync.applyPlan(f.plan([f.item(f.build())]));
    const instruction = {...f.instruction(session), home: canonicalHome, alsoLinkedFrom: outer ? [{home: canonicalHome, folderName: 'example'}] : []};
    const crashing = f.engine({crash: async () => {
      const journal = JSON.parse(await readFile(join(f.paths.data, 'imports.json'), 'utf8')), id = journal.sessions[0].folders[0].backupId;
      // Simulate the durable original move followed by interruption before alias moves and the lock commit.
      await durableRename(f.original('example', canonicalHome), join(f.paths.backups, id, 'local-import/example'));
      throw Object.assign(new Error('Injected I/O interruption'), {code: 'EIO'});
    }});
    await assert.rejects(crashing.applyInstructions([instruction]), {code: 'EIO'});
    const before = JSON.parse(await readFile(join(f.paths.data, 'imports.json'), 'utf8')).sessions[0].folders[0];
    assert.ok(before.backupId); assert.equal(before.complete, undefined);
    await f.engine().applyInstructions([]);
    for (const home of ['.codex', '.codex-work', '.codex-client']) await assert.rejects(lstat(f.original('example', home)), {code: 'ENOENT'});
    assert.equal((await listBackups(f.paths)).length, 1);
    assert.equal(JSON.parse(await readFile(join(f.paths.data, 'lock.json'), 'utf8')).replaced.length, 1);
    assert.equal(f.calls.filter(call => call.body?.status === 'replaced').length, 1);
  } finally {await f.close();}
});

test('journal bounds evict oldest idle imports while preserving pending instructions and backups', async () => {
  const f = await fixture();
  try {
    await f.skill('example');
    const sessions = Array.from({length: 1000}, () => ({sessionId: randomUUID(), folders: [{home: '.codex', folderName: 'example', originalPath: '.codex/skills/example', links: []} as any]}));
    sessions[0].folders[0].backupId = 'existing-backup';
    sessions[1].folders[0].instruction = {...f.instruction(f.session(['example'])), sessionId: sessions[1].sessionId};
    const evicted = sessions[2].sessionId;
    await atomicWrite(join(f.paths.data, 'imports.json'), JSON.stringify({format: 1, sessions}));
    const next = f.session(['example']); f.setSessions([next]); await f.engine().poll();
    const journal = JSON.parse(await readFile(join(f.paths.data, 'imports.json'), 'utf8'));
    assert.equal(journal.sessions.length, 1000); assert.ok(journal.closed.includes(evicted));
    for (const id of [sessions[0].sessionId, sessions[1].sessionId, next.sessionId]) assert.ok(journal.sessions.some((session: any) => session.sessionId === id));
    await f.engine().applyInstructions([]);
  } finally {await f.close();}
});

test('a full journal of pending replacements refuses a new upload before any result or content POST', async () => {
  const f = await fixture();
  try {
    await f.skill('example'); await f.skill('large'); await writeFile(join(f.original('large'), 'large.txt'), Buffer.alloc(1024 * 1024 + 1));
    const sessions = Array.from({length: 1000}, () => ({sessionId: randomUUID(), folders: [{home: '.codex', folderName: 'example', originalPath: '.codex/skills/example', links: [], backupId: 'pending-backup'}]}));
    const file = join(f.paths.data, 'imports.json'), text = JSON.stringify({format: 1, sessions}); await atomicWrite(file, text);
    f.setSessions([f.session(['example', 'large'])]);
    await assert.rejects(f.engine().poll(), {code: 'IMPORT_JOURNAL_FULL'});
    assert.equal(f.calls.filter(call => call.body).length, 0); assert.equal(await readFile(file, 'utf8'), text);
  } finally {await f.close();}
});

test('reported replacements leave the live journal and replay never moves a restored original', async () => {
  const f = await fixture();
  try {
    await f.skill('example'); const session = f.session(['example']); f.setSessions([session]); await f.engine().poll();
    const sync = f.sync(); await sync.reconcile(); await sync.applyPlan(f.plan([f.item(f.build())], [f.instruction(session)]));
    const journal = JSON.parse(await readFile(join(f.paths.data, 'imports.json'), 'utf8'));
    assert.equal(journal.sessions.length, 0); assert.ok(journal.closed.includes(session.sessionId));
    const backup = (await listBackups(f.paths))[0]; await restoreBackup(f.paths, backup.id);
    await f.engine().applyInstructions([f.instruction(session)]);
    assert.equal((await listBackups(f.paths)).length, 0);
    assert.equal(await readFile(join(f.original('example'), 'SKILL.md'), 'utf8'), 'Original local content\n');
  } finally {await f.close();}
});

test('an unreadable selected leaf home reports read failure while another session still uploads', async t => {
  if (process.getuid?.() === 0) {t.skip('Root bypasses leaf directory permissions'); return;}
  const f = await fixture(), root = join(f.home, '.codex/skills');
  try {
    await f.skill('example'); await f.skill('good', 'Good alternate home\n', '.codex-work');
    await chmod(root, 0o000);
    const denied = f.session(['example']), clean = f.session(['good']); f.setSessions([denied, clean]); await f.engine().poll();
    assert.equal(f.calls.find(call => call.path.endsWith('/results'))!.body.findings[0].rule, 'read-failed');
    assert.deepEqual(f.calls.filter(call => call.path.endsWith('/uploads')).map(call => call.path.split('/')[4]), [clean.sessionId]);
  } finally {await chmod(root, 0o755); await f.close();}
});

test('shared lock and sync metadata corruption never mark a pending replacement terminal', async () => {
  const f = await fixture();
  try {
    await f.skill('example'); const session = f.session(['example']); f.setSessions([session]); await f.engine().poll();
    const sync = f.sync(); await sync.reconcile(); await sync.applyPlan(f.plan([f.item(f.build())]));
    await writeFile(join(f.home, '.agents/skills/example/SKILL.md'), 'Edited\n'); await f.engine().applyInstructions([f.instruction(session)]);
    await writeFile(join(f.home, '.agents/skills/example/SKILL.md'), 'Managed delivery\n');
    for (const [name, code] of [['lock.json', 'LOCK_INVALID'], ['sync-meta.json', 'SYNC_META_INVALID']]) {
      const file = join(f.paths.data, name), genuine = await readFile(file, 'utf8');
      await atomicWrite(file, '{}'); await assert.rejects(f.engine().applyInstructions(), {code}); await atomicWrite(file, genuine);
      const journal = JSON.parse(await readFile(join(f.paths.data, 'imports.json'), 'utf8'));
      assert.equal(journal.sessions[0].folders[0].failed, undefined);
    }
    await f.engine().applyInstructions(); assert.equal((await listBackups(f.paths)).length, 1);
  } finally {await f.close();}
});

for (const code of ['IMPORT_JOURNAL_INVALID', 'IMPORT_JOURNAL_FULL', 'FILE_UNSAFE', 'EACCES', 'invalid-json']) test(`a new replacement click survives ${code} until the journal is repaired`, async t => {
  if (code === 'EACCES' && process.getuid?.() === 0) {t.skip('Root bypasses journal permissions'); return;}
  const f = await fixture();
  try {
    await f.skill('example');
    const session = f.session(['example']); f.setSessions([session]); await f.engine().poll();
    const sync = f.sync(); await sync.reconcile();
    const prior = f.plan(); await sync.applyPlan(prior); f.setPlan(prior);
    const next = f.plan([f.item(f.build()), f.item(f.build('other'))], [f.instruction(session)]);
    const file = join(f.paths.data, 'imports.json'), repaired = await readFile(file, 'utf8'), journal = JSON.parse(repaired);
    assert.equal(journal.sessions[0].folders[0].instruction, undefined, 'the new click is not journaled yet');
    if (code === 'IMPORT_JOURNAL_FULL') {
      const link = {home: '.codex', folderName: 'retired-alias', target: ''};
      journal.sessions[0].folders[0].links.push(link);
      link.target = 'x'.repeat(4 * 1024 * 1024 - 2 - Buffer.byteLength(JSON.stringify(journal)));
    }
    const damaged = code === 'IMPORT_JOURNAL_INVALID' ? '{}' : code === 'invalid-json' ? '{' : JSON.stringify(journal);
    await atomicWrite(file, damaged);
    if (code === 'FILE_UNSAFE' || code === 'EACCES') await chmod(file, code === 'FILE_UNSAFE' ? 0o644 : 0o000);
    await assert.rejects(f.engine().applyInstructions(next.instructions), code === 'invalid-json' ? SyntaxError : {code},
      'the fixture must fail before recording the incoming instruction');
    const log = t.mock.method(console, 'error', () => {}); f.calls.length = 0;
    await sync.tick(); // The old revision still gets a 304 while the journal is damaged.
    assert.equal((sync as any).failures, 0);
    f.setPlan(next);
    for (let attempt = 0; attempt < 2; attempt++) {
      f.advance(60_000); await sync.tick();
      assert.equal((sync as any).failures, 0);
      assert.equal(sync.retryAt, f.timing.now() + next.pollAfterSeconds * 1000);
      assert.equal(JSON.parse(await readFile(join(f.paths.data, 'sync-meta.json'), 'utf8')).planRevision, prior.planRevision,
        'the unjournaled click must be fetched in the next full plan');
      assert.equal(await readFile(join(f.original('example'), 'SKILL.md'), 'utf8'), 'Original local content\n');
      assert.equal((await listBackups(f.paths)).length, 0);
      assert.equal(f.calls.filter(call => call.body?.status === 'replaced').length, 0);
    }
    assert.ok(log.mock.callCount() >= (code === 'IMPORT_JOURNAL_FULL' ? 2 : 3),
      'full-plan journal failures are logged locally; a full journal without a pending click needs no write on 304');
    assert.equal(await readFile(join(f.home, '.agents/skills/example/SKILL.md'), 'utf8'), 'Managed delivery\n');
    assert.equal(await readFile(join(f.home, '.agents/skills/other/SKILL.md'), 'utf8'), 'Managed other\n', 'ordinary delivery keeps working');
    assert.deepEqual((await sync.inventory()).deliveryErrors, []);
    if (code === 'FILE_UNSAFE' || code === 'EACCES') await chmod(file, 0o600);
    assert.equal(await readFile(file, 'utf8'), damaged, 'the failed journal is preserved for repair');
    await atomicWrite(file, repaired);
    f.advance(60_000); await sync.tick();
    assert.equal((sync as any).failures, 0);
    assert.equal(JSON.parse(await readFile(join(f.paths.data, 'sync-meta.json'), 'utf8')).planRevision, next.planRevision);
    const backups = await listBackups(f.paths); assert.equal(backups.length, 1);
    assert.equal(await readFile(join(f.paths.backups, backups[0].id, 'local-import/example/SKILL.md'), 'utf8'), 'Original local content\n');
    await assert.rejects(lstat(f.original('example')), {code: 'ENOENT'});
    f.advance(60_000); await sync.tick(); // The accepted revision now gets a 304, with no duplicate move or receipt.
    assert.equal((sync as any).failures, 0); assert.equal((await listBackups(f.paths)).length, 1);
    assert.deepEqual(f.calls.filter(call => call.body?.status === 'replaced').map(call => call.body.backupId), [backups[0].id]);
    assert.deepEqual(f.calls.filter(call => call.path === '/api/helper/plan').map(call => call.revision),
      [prior.planRevision, prior.planRevision, prior.planRevision, prior.planRevision, next.planRevision]);
  } finally {await f.close();}
});

for (const code of ['IMPORT_JOURNAL_INVALID', 'IMPORT_JOURNAL_FULL', 'FILE_UNSAFE']) test(`${code} is logged locally without stalling delivery or full-plan retries`, async t => {
  const f = await fixture();
  try {
    await f.skill('example', 'Claude original\n', '.claude');
    const session = f.session(['example'], {tool: 'claude-code'}); f.setSessions([session]); await f.engine().poll();
    const sync = f.sync(); await sync.reconcile();
    const file = join(f.paths.data, 'imports.json'), journal = JSON.parse(await readFile(file, 'utf8'));
    journal.sessions[0].folders[0].instruction = {...f.instruction(session), home: '.claude'};
    journal.sessions[0].folders[0].authorized = true;
    const repaired = JSON.stringify(journal);
    if (code === 'IMPORT_JOURNAL_FULL') {
      // A pending protected-home result needs a journal write that exceeds the byte cap.
      const link = {home: '.claude', folderName: 'retired-alias', target: ''};
      journal.sessions[0].folders[0].links.push(link);
      link.target = 'x'.repeat(4 * 1024 * 1024 - 2 - Buffer.byteLength(JSON.stringify(journal)));
    }
    await atomicWrite(file, code === 'IMPORT_JOURNAL_INVALID' ? '{}' : JSON.stringify(journal));
    if (code === 'FILE_UNSAFE') await chmod(file, 0o644);
    await assert.rejects(f.engine().applyInstructions(), {code}, 'the fixture must trigger the actual journal failure');
    const damaged = await readFile(file, 'utf8'), log = t.mock.method(console, 'error', () => {});
    const plan = f.plan([], [journal.sessions[0].folders[0].instruction]); f.setPlan(plan); await sync.applyPlan(plan);
    assert.equal(JSON.parse(await readFile(join(f.paths.data, 'sync-meta.json'), 'utf8')).planRevision, null);
    assert.ok(log.mock.calls.some(call => String(call.arguments[0]).includes(code)));
    assert.deepEqual((await sync.inventory()).deliveryErrors, []);
    const logged = log.mock.callCount();
    f.conditional(); f.advance(60_000); await sync.tick();
    assert.equal((sync as any).failures, 0); assert.equal(sync.retryAt, f.timing.now() + plan.pollAfterSeconds * 1000);
    assert.ok(log.mock.callCount() > logged, 'full-plan retries record the journal error too');
    assert.ok(f.calls.filter(call => call.path === '/api/helper/inventory').every(call => call.body.deliveryErrors.length === 0));
    assert.equal(await readFile(file, 'utf8'), damaged, 'a damaged journal is retained for repair');
    assert.equal(await readFile(join(f.original('example', '.claude'), 'SKILL.md'), 'utf8'), 'Claude original\n');
    assert.equal((await listBackups(f.paths)).length, 0);
    if (code === 'FILE_UNSAFE') await chmod(file, 0o600);
    await atomicWrite(file, repaired); f.advance(60_000); await sync.tick();
    assert.equal((sync as any).failures, 0);
    assert.equal(f.calls.filter(call => call.body?.status === 'kept' && call.body.reason === 'protected_home').length, 1);
  } finally {await f.close();}
});

test('permission interruption after an original move stays local and keeps a journaled backup retryable', async t => {
  if (process.getuid?.() === 0) {t.skip('Root bypasses alias directory permissions'); return;}
  const f = await fixture(), aliasRoot = join(f.home, '.codex-work/skills');
  try {
    await f.skill('example'); await symlink(f.original('example'), f.original('example', '.codex-work'));
    const session = f.session(['example']); f.setSessions([session]); await f.engine().poll();
    const sync = f.sync(); await sync.reconcile(); await sync.applyPlan(f.plan([f.item(f.build())]));
    await chmod(aliasRoot, 0o555); await assert.rejects(f.engine().applyInstructions([f.instruction(session)]), {code: 'EACCES'});
    const journal = JSON.parse(await readFile(join(f.paths.data, 'imports.json'), 'utf8')), folder = journal.sessions[0].folders[0];
    assert.ok(folder.backupId); assert.equal(folder.failed, undefined); assert.equal(folder.complete, undefined);
    const log = t.mock.method(console, 'error', () => {});
    const retryPlan = f.plan(); await sync.applyPlan(retryPlan);
    assert.deepEqual((await sync.inventory()).deliveryErrors, []);
    assert.ok(log.mock.calls.some(call => String(call.arguments[0]).includes('EACCES')));
    assert.equal(JSON.parse(await readFile(join(f.paths.data, 'sync-meta.json'), 'utf8')).planRevision, retryPlan.planRevision);
    f.conditional(); f.advance(60_000); await sync.tick(); assert.equal((sync as any).failures, 0);
    assert.ok(f.calls.filter(call => call.path === '/api/helper/inventory').every(call => call.body.deliveryErrors.length === 0));
    await chmod(aliasRoot, 0o755); await f.engine().applyInstructions([]);
    assert.equal((await listBackups(f.paths)).length, 1); await assert.rejects(lstat(f.original('example', '.codex-work')), {code: 'ENOENT'});
    assert.equal(f.calls.filter(call => call.body?.status === 'replaced').length, 1);
  } finally {await chmod(aliasRoot, 0o755); await f.close();}
});

for (const failure of ['network', 'token'] as const) test(`a later ${failure} receipt failure cannot be hidden by an earlier local backup retry`, async t => {
  if (process.getuid?.() === 0) {t.skip('Root bypasses alias directory permissions'); return;}
  const f = await fixture(), aliasRoot = join(f.home, '.codex-work/skills');
  try {
    await f.skill('example'); await f.skill('other'); await symlink(f.original('example'), f.original('example', '.codex-work'));
    const session = f.session(['example', 'other']); f.setSessions([session]); await f.engine().poll();
    const sync = f.sync(); await sync.reconcile(); await sync.applyPlan(f.plan([f.item(f.build()), f.item(f.build('other'))]));
    await chmod(aliasRoot, 0o555);
    if (failure === 'network') f.resultsFail(true); else f.resultsToken(true);
    const code = failure === 'network' ? 'API_CONNECTION_FAILED' : 'TOKEN_REVOKED';
    await assert.rejects(sync.applyPlan(f.plan([], [f.instruction(session), f.instruction(session, 'other')])), {code});
    f.conditional(); f.advance(60_000);
    if (failure === 'token') {
      await assert.rejects(sync.tick(), {code}); assert.equal((sync as any).stoppedForToken, true);
    } else {await sync.tick(); assert.equal((sync as any).failures, 1);}
    const folders = JSON.parse(await readFile(join(f.paths.data, 'imports.json'), 'utf8')).sessions[0].folders;
    assert.ok(folders.every((folder: any) => !folder.failed));
  } finally {await chmod(aliasRoot, 0o755); await f.close();}
});

test('journal byte bounds refuse an upload before posting metadata or content', async () => {
  const f = await fixture();
  try {
    await f.skill('example');
    const sessions = [{sessionId: randomUUID(), folders: [{home: '.codex', folderName: 'old', originalPath: '.codex/skills/old', links: [] as any[], backupId: 'pending-backup'}]}];
    const folder = sessions[0].folders[0], cap = 4 * 1024 * 1024;
    const link = {home: '.codex', folderName: 'old-link', target: 'x'.repeat(4000)};
    const count = Math.floor((cap - 4500 - Buffer.byteLength(JSON.stringify({format: 1, sessions}))) / (Buffer.byteLength(JSON.stringify(link)) + 1));
    folder.links = Array.from({length: count}, () => ({...link}));
    const initial = JSON.stringify({format: 1, sessions}), padding = cap - 20 - Buffer.byteLength(initial);
    folder.links.at(-1).target += 'x'.repeat(padding);
    const file = join(f.paths.data, 'imports.json'), text = JSON.stringify({format: 1, sessions});
    assert.ok(Buffer.byteLength(text) < cap); await atomicWrite(file, text);
    f.setSessions([f.session(['example'])]); await assert.rejects(f.engine().poll(), {code: 'IMPORT_JOURNAL_FULL'});
    assert.equal(f.calls.filter(call => call.body).length, 0); assert.equal(await readFile(file, 'utf8'), text);
  } finally {await f.close();}
});

test('an unmanaged folder stamped after listing reports unsafe-path without throwing or uploading', async t => {
  const {writeFileSync} = await import('node:fs');
  const {LockStore} = await import('../src/lock.js');
  const {makeStamp} = await import('../src/stamp.js');
  const f = await fixture();
  try {
    const build = f.build(), content = Buffer.from(build.files[0].content, 'base64').toString('utf8');
    await f.skill('example', content);
    const metadata = join(f.original('example'), '.maddots'), stampFile = join(metadata, 'skill.json');
    await mkdir(metadata, {mode: 0o700});
    await assert.rejects(lstat(stampFile), {code: 'ENOENT'});
    const stamp = JSON.stringify(makeStamp(build, f.item(build), 'helper-test', f.timing.now()));
    const knownIds = LockStore.prototype.knownIds;
    let stampChecks = 0;
    t.mock.method(LockStore.prototype, 'knownIds', function (this: InstanceType<typeof LockStore>, lock: Parameters<typeof knownIds>[0]) {
      // The first call supplies listUnmanaged; the next supplies upload's second stamp check.
      if (++stampChecks === 2) writeFileSync(stampFile, stamp, {mode: 0o600});
      return knownIds.call(this, lock);
    });
    const session = f.session(['example']); f.setSessions([session]);
    assert.deepEqual(await f.engine().poll(), [{sessionId: session.sessionId, state: 'blocked', resultVersionIds: []}]);
    assert.equal(stampChecks, 2, 'the folder must be stamped between listing and reading');
    assert.deepEqual(f.calls.filter(call => call.body).map(call => ({path: call.path, body: call.body})), [{
      path: `/api/helper/imports/${session.sessionId}/results`,
      body: {home: '.codex', folderName: 'example', status: 'blocked', findings: [{rule: 'unsafe-path', path: '[redacted]', line: 1}]},
    }]);
    await assert.rejects(lstat(join(f.paths.data, 'imports.json')), {code: 'ENOENT'});
    assert.equal(await readFile(stampFile, 'utf8'), stamp);
    assert.equal(await readFile(join(f.original('example'), 'SKILL.md'), 'utf8'), content);
    assert.equal((await listBackups(f.paths)).length, 0);
  } finally {t.mock.restoreAll(); await f.close();}
});
