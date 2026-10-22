import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { treeDigest } from '../src/shared/build-format.js';
import type { ApiClient } from '../src/api.js';
import { runCli } from '../src/cli.js';
import { readConfig } from '../src/config.js';
import { AgentsFolderDeliveryTarget } from '../src/delivery/agents-folder.js';
import { scanDuplicates } from '../src/duplicates.js';
import { discoverManagedLinks, linkedHomeRefs } from '../src/linked-homes.js';
import { atomicWrite, createPaths, ensurePaths } from '../src/paths.js';
import { StateStore } from '../src/state.js';
import { SyncEngine, type SyncOptions, type SyncPlan } from '../src/sync.js';
import { BuildVerifier, signedBuildString, type PlanItem, type SignedBuild } from '../src/verify.js';

async function fixture() {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'mdai-linked-homes-'));
  const paths = await createPaths(readConfig({}, home)); await ensurePaths(paths);
  const signer = generateKeyPairSync('ed25519'), key = signer.publicKey.export({type: 'spki', format: 'der'}).subarray(-32);
  const keyId = createHash('sha256').update(key).digest('hex').slice(0, 16);
  const verifier = new BuildVerifier({keys: [{keyId, publicKey: key.toString('base64')}], env: {}});
  const builds = new Map<string, SignedBuild>(), output: string[] = [];
  const client = {request: async (path: string) => ({status: 200, headers: new Headers(),
    data: structuredClone(builds.get(new URL(path, 'https://example.test').pathname.slice('/api/helper/builds/'.length)))})} as Pick<ApiClient, 'request'>;
  const options: SyncOptions = {paths, helperId: 'helper-test', client, verifier, targets: [new AgentsFolderDeliveryTarget(paths)],
    tools: [{tool: 'codex', variant: 'cli', version: '1', models: [], syncOnly: true}], output: line => output.push(line),
    watchRoute: () => ({close() {}})};
  const engine = new SyncEngine(options);
  function build(version: number) {
    const content = Buffer.from(`---\nname: example\ndescription: Fixture.\n---\nVersion ${version}\n`);
    const value: SignedBuild = {format: 1, keyId, skillId: 'skill-test', version, settingsRevision: 0, level: 'workspace',
      workspaceId: 'workspace-test', boardId: null, target: 'folder', name: 'example', hasCode: false, draft: false,
      files: [{path: 'SKILL.md', mode: '100644', size: content.length, sha256: createHash('sha256').update(content).digest('hex'), content: content.toString('base64')}],
      report: {renamedFrom: null, unresolvedOptionalReferences: [], unsetSettings: []},
      digest: treeDigest([{path: 'SKILL.md', mode: '100644', content}]), signature: ''};
    value.signature = sign(null, Buffer.from(signedBuildString(value)), signer.privateKey).toString('base64');
    builds.set(value.digest, value); return value;
  }
  const item = (build: SignedBuild, changes: Partial<PlanItem> = {}): PlanItem => ({itemId: createHash('sha256').update(build.digest).digest('hex'),
    kind: 'install', skillId: build.skillId, name: build.name, sourceName: build.name, level: build.level, workspaceId: build.workspaceId,
    workspaceIds: [build.workspaceId], boardIds: [], target: build.target, route: 'agents-folder', fromVersion: null,
    version: build.version, settingsRevision: build.settingsRevision, digest: build.digest, hasCode: false, draft: false,
    dependencyOf: null, missingDependencies: [], forAgentIds: [], state: 'approved', answer: 'update', reason: null, restartHints: [], ...changes});
  const plan = (items: PlanItem[]): SyncPlan => ({planRevision: createHash('sha256').update(JSON.stringify(items)).digest('hex'),
    degraded: false, pollAfterSeconds: 60, items, revoked: [], instructions: []});
  const canonical = join(home, '.agents/skills/example');
  async function alias(toolHome: string, target = canonical) {
    const root = join(home, toolHome, 'skills'); await mkdir(root, {recursive: true});
    const path = join(root, 'example'); await symlink(relative(root, target), path); return path;
  }
  const discover = async () => discoverManagedLinks({paths, managed: (await engine.locks.read()).entries, verifier, helperIds: ['helper-test']});
  const duplicates = async () => scanDuplicates({paths, tools: options.tools!, managed: (await engine.locks.read()).entries, verifier, helperIds: ['helper-test']});
  await engine.reconcile();
  return {home, paths, options, output, verifier, engine, canonical, build, item, plan, alias, discover, duplicates,
    close: () => rm(home, {recursive: true, force: true})};
}

test('three linked Codex homes appear in inventory and Update questions, retain direct links and receive the new copy', async () => {
  const f = await fixture();
  try {
    await f.engine.applyPlan(f.plan([f.item(f.build(1))]));
    const aliases = await Promise.all(['.codex', '.codex-client', '.codex-work'].map(home => f.alias(home)));
    const originalTargets = await Promise.all(aliases.map(path => readlink(path)));
    const linkedHomes = ['.codex', '.codex-client', '.codex-work'].map(home => ({home, folderName: 'example'}));
    const report = await f.engine.inventory();
    assert.deepEqual(report.managed[0].linkedHomes, linkedHomes);
    assert.deepEqual(report.capabilities, {allow: true, 'linked-replacement': true}); assert.deepEqual(report.waitingForAllow, []);
    assert.ok(!JSON.stringify(report).includes(f.home)); assert.deepEqual(await f.duplicates(), []);
    const newer = f.build(2), asking = f.item(newer, {kind: 'update', state: 'asking', answer: null, fromVersion: 1});
    await f.engine.applyPlan(f.plan([asking]));
    assert.deepEqual((await f.engine.questions())[0].linkedHomes, linkedHomes);
    f.options.crash = step => {if (step === 'backed_up') assert.ok(f.output.some(line => line.includes('.codex-client/example')));};
    await f.engine.applyPlan(f.plan([{...asking, state: 'approved', answer: 'update'}]));
    for (const [index, path] of aliases.entries()) {
      assert.ok((await lstat(path)).isSymbolicLink()); assert.equal(await readlink(path), originalTargets[index]);
      assert.equal(await realpath(path), f.canonical); assert.match(await readFile(join(path, 'SKILL.md'), 'utf8'), /Version 2/);
    }
    assert.equal(f.output.length, 1); assert.match(f.output[0], /links are preserved/);
    assert.deepEqual(await f.duplicates(), []);
  } finally {await f.close();}
});

test('only direct links to an owned signed canonical destination are excluded from duplicate warnings', async () => {
  const f = await fixture();
  try {
    await f.engine.applyPlan(f.plan([f.item(f.build(1))]));
    const first = await f.alias('.codex'); await f.alias('.codex-work', first);
    assert.deepEqual((await f.discover()).map(link => link.home), ['.codex']);
    assert.deepEqual((await f.duplicates()).map(copy => copy.home), ['.codex-work']);
    const stampPath = join(f.canonical, '.maddots/skill.json'), stamp = JSON.parse(await readFile(stampPath, 'utf8'));
    for (const replacement of [{...stamp, helperId: 'foreign-helper'}, {...stamp, signature: Buffer.alloc(64).toString('base64')}]) {
      await atomicWrite(stampPath, JSON.stringify(replacement));
      assert.deepEqual(await f.discover(), []);
      assert.deepEqual((await f.duplicates()).map(copy => copy.home).sort(), ['.codex', '.codex-work']);
    }
    await atomicWrite(stampPath, JSON.stringify(stamp));
    const wrong = {...(await f.engine.locks.read()).entries[0], digest: 'f'.repeat(64)};
    assert.deepEqual(await discoverManagedLinks({paths: f.paths, managed: [wrong], verifier: f.verifier, helperIds: ['helper-test']}), []);
  } finally {await f.close();}
});

test('CLI status lists the affected linked homes without network calls or user-file changes', async () => {
  const f = await fixture();
  try {
    const build = f.build(1); await f.engine.applyPlan(f.plan([f.item(build)]));
    const alias = await f.alias('.codex-work'), before = await readlink(alias), output: string[] = [];
    const states = new StateStore(f.paths, readConfig({}, f.home).endpoint);
    await states.write({...await states.read(), status: 'pair_again', helperId: 'helper-test'});
    await runCli(['status'], {home: f.home, env: {PATH: join(f.home, 'empty-bin')}, verifier: f.verifier, output: line => output.push(line),
      runner: async () => {throw new Error('Status must not run external commands.');},
      request: async () => {throw new Error('Unpaired status must not make requests.');}});
    assert.ok(output.some(line => line.includes('.codex-work/example') && line.includes('links are preserved')));
    assert.equal(await readlink(alias), before);
    const refs = linkedHomeRefs(await f.discover(), build); assert.deepEqual(refs, [{home: '.codex-work', folderName: 'example'}]);
  } finally {await f.close();}
});

test('duplicate scanning excludes only Grok date backups and retains legitimate backup-named skills', async () => {
  const f = await fixture();
  try {
    await f.engine.applyPlan(f.plan([f.item(f.build(1))]));
    for (const path of ['.codex-backup-20261021/skills/example', '.codex/skills/example-backup-20261021',
      '.codex/skills/example.bak', '.codex/skills/database-backup', '.codex/skills/backups', '.codex/skills/example',
      '.grok/skills/example-backup-20261021']) {
      await mkdir(join(f.home, path), {recursive: true});
      await writeFile(join(f.home, path, 'SKILL.md'), '---\nname: example\n---\nLocal copy');
    }
    await mkdir(join(f.home, '.codex-linked/skills'), {recursive: true});
    await symlink(join(f.home, '.grok/skills/example-backup-20261021'), join(f.home, '.codex-linked/skills/example'));
    const duplicates = await scanDuplicates({paths: f.paths, tools: [...f.options.tools!, {tool: 'grok', variant: 'cli'}],
      managed: (await f.engine.locks.read()).entries, verifier: f.verifier, helperIds: ['helper-test']});
    assert.deepEqual(duplicates.map(copy => ({home: copy.home, folderName: copy.folderName})).sort((a, b) =>
      a.home.localeCompare(b.home) || a.folderName.localeCompare(b.folderName)), [
      {home: '.codex', folderName: 'backups'},
      {home: '.codex', folderName: 'database-backup'},
      {home: '.codex', folderName: 'example'},
      {home: '.codex', folderName: 'example-backup-20261021'},
      {home: '.codex', folderName: 'example.bak'},
      {home: '.codex-backup-20261021', folderName: 'example'},
    ]);
  } finally {await f.close();}
});
