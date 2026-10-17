import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { treeDigest } from '../src/shared/build-format.js';
import { TOOL_MATRIX } from '../src/shared/tool-matrix.js';
import { ApiError, type ApiClient } from '../src/api.js';
import { listBackups, restoreBackup } from '../src/backups.js';
import { runCli } from '../src/cli.js';
import { readConfig } from '../src/config.js';
import { AgentsFolderDeliveryTarget, agentsFolderReloadHints } from '../src/delivery/agents-folder.js';
import type { DeliveryTarget } from '../src/delivery/index.js';
import { duplicateQuestions, grokDuplicateWarning, scanDuplicates } from '../src/duplicates.js';
import { atomicWrite, createPaths, ensurePaths } from '../src/paths.js';
import { RELEASE } from '../src/release-identity.js';
import { durableRename } from '../src/safe-fs.js';
import { makeStamp, readStamp } from '../src/stamp.js';
import { SyncEngine, type SyncOptions, type SyncPlan } from '../src/sync.js';
import { BuildVerifier, signedBuildString, type PlanItem, type SignedBuild } from '../src/verify.js';

const sharedTools = TOOL_MATRIX.tools.filter(tool => tool.route === 'agents-folder');
const tools = sharedTools.map(tool => ({tool: tool.key, variant: tool.variants[0].key, version: null, models: [], syncOnly: tool.variants[0].syncOnly}));
const skillText = (name = 'example', body = 'Fixture skill.') => `---\nname: ${name}\ndescription: A safe fixture skill.\n---\n\n${body}\n`;
// Byte-for-byte TLS-06 renderer output, including its single JSON-line frontmatter.
const renderedText = `---\n${JSON.stringify({name: 'example', description: 'A safe fixture skill.', metadata: {
  maddots_settings_revision: '0', maddots_skill_id: 'skill-test', maddots_version: '1',
}})}\n---\nFixture skill.\n`;
const missing = async (path: string) => assert.rejects(lstat(path), {code: 'ENOENT'});

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-agents-folder-'));
  const home = join(root, 'home'); await mkdir(home, {mode: 0o700});
  const paths = await createPaths(readConfig({}, home)); await ensurePaths(paths);
  const route = join(home, TOOL_MATRIX.routes['agents-folder'].path.slice(2));
  const signer = generateKeyPairSync('ed25519');
  const publicKey = signer.publicKey.export({type: 'spki', format: 'der'}).subarray(-32);
  const keyId = createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
  const verifier = new BuildVerifier({keys: [{keyId, publicKey: publicKey.toString('base64')}], env: {}});
  const builds = new Map<string, SignedBuild>(), calls: string[] = [];
  const client = {request: async (path: string) => {
    calls.push(path);
    if (path === '/api/helper/inventory') return {status: 200, headers: new Headers(), data: {ok: true}};
    const build = builds.get(new URL(path, 'http://x').pathname.slice('/api/helper/builds/'.length));
    if (!build) throw new ApiError('BUILD_NOT_IN_PLAN', 404);
    return {status: 200, headers: new Headers(), data: structuredClone(build)};
  }} as Pick<ApiClient, 'request'>;
  const target = new AgentsFolderDeliveryTarget(paths);
  const options: SyncOptions = {paths, helperId: 'helper-test', client, targets: [target], verifier, tools,
    timing: {now: () => 1_760_000_000_000, sleep: async () => {}}};
  function build(version = 1, name = 'example', text = skillText(name)): SignedBuild {
    const content = Buffer.from(text), files = [{path: 'SKILL.md', mode: '100644' as const, size: content.length,
      sha256: createHash('sha256').update(content).digest('hex'), content: content.toString('base64')}];
    const result: SignedBuild = {format: 1, keyId, skillId: 'skill-test', version, settingsRevision: 0, level: 'workspace', workspaceId: 'workspace-test', boardId: null,
      target: 'folder', name, hasCode: false, draft: false, files, report: {renamedFrom: null, unresolvedOptionalReferences: [], unsetSettings: []},
      digest: treeDigest([{path: 'SKILL.md', mode: '100644', content}]), signature: ''};
    result.signature = sign(null, Buffer.from(signedBuildString(result)), signer.privateKey).toString('base64');
    builds.set(result.digest, result); return result;
  }
  function item(build: SignedBuild, changes: Partial<PlanItem> = {}): PlanItem {
    return {itemId: createHash('sha256').update(JSON.stringify([build.digest, build.version, changes])).digest('hex'),
      kind: 'install', skillId: build.skillId, name: build.name, sourceName: build.name, level: build.level, workspaceId: build.workspaceId,
      workspaceIds: [build.workspaceId], boardIds: [], target: build.target, route: 'agents-folder', fromVersion: null,
      version: build.version, settingsRevision: build.settingsRevision, digest: build.digest, hasCode: build.hasCode, draft: build.draft,
      dependencyOf: null, missingDependencies: [], forAgentIds: [], state: 'approved', answer: 'update', reason: null, restartHints: [], ...changes};
  }
  const plan = (items: PlanItem[]): SyncPlan => ({planRevision: createHash('sha256').update(JSON.stringify(items)).digest('hex'),
    degraded: false, pollAfterSeconds: 60, items, revoked: [], instructions: []});
  async function local(path: string, name = 'example') {
    const folder = join(home, path); await mkdir(folder, {recursive: true});
    await writeFile(join(folder, 'SKILL.md'), skillText(name)); return folder;
  }
  async function stamped(path: string, value: SignedBuild) {
    const folder = await local(path, value.name); await mkdir(join(folder, '.maddots'), {mode: 0o700});
    await atomicWrite(join(folder, '.maddots/skill.json'), JSON.stringify(makeStamp(value, item(value), 'helper-test', options.timing!.now())));
    return folder;
  }
  return {root, home, paths, route, target, verifier, options, calls, build, item, plan, local, stamped,
    engine: () => new SyncEngine(options), close: () => rm(root, {recursive: true, force: true})};
}

test('TLS-15 shares one matrix path for all eleven tools and matches delivery evidence', async () => {
  assert.equal(sharedTools.length, 11);
  if (!RELEASE) {
    const evidence = JSON.parse(await readFile(new URL('../../data/tools-delivery.json', import.meta.url), 'utf8'));
    const evidenceIds = evidence.sharedTarget.toolsReadingUserFolder.map((key: string) => key === 'copilot' ? 'vscode-copilot' : key);
    assert.deepEqual(sharedTools.map(tool => tool.key).sort(), evidenceIds.sort());
  }
  const f = await fixture();
  try {
    await missing(f.route);
    const engine = f.engine(), build = f.build();
    await engine.reconcile(); await engine.applyPlan(f.plan([f.item(build), f.item(build, {itemId: 'a'.repeat(64)})]));
    assert.equal(await f.target.root(), f.route);
    assert.deepEqual(await readdir(f.route), ['example']);
    const canonical = await realpath(join(f.route, 'example'));
    for (const tool of sharedTools) {
      assert.ok(tool.reads.includes(TOOL_MATRIX.routes['agents-folder'].path), tool.key);
      assert.equal(await realpath(join(f.home, tool.reads[0].slice(2), 'example')), canonical, tool.key);
    }
    assert.equal(await readFile(join(canonical, 'SKILL.md'), 'utf8'), skillText(build.name));
    assert.equal((await engine.locks.read()).entries.length, 1);
    assert.equal((await readStamp(canonical, f.verifier, ['helper-test'])).name, 'example');
    const before = (await lstat(canonical)).ino;
    await engine.applyPlan(f.plan([f.item(build)]));
    assert.equal((await lstat(canonical)).ino, before); assert.equal((await listBackups(f.paths)).length, 0);
    assert.equal(f.calls.length, 1);
  } finally {await f.close();}
});

test('TLS-15 delivers byte-for-byte TLS-06 JSON-line renderer output', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const build = f.build(1, 'example', renderedText);
    await engine.applyPlan(f.plan([f.item(build)]));
    assert.deepEqual(await readdir(f.route), ['example']);
    assert.equal(await readFile(join(f.route, 'example/SKILL.md'), 'utf8'), renderedText);
    assert.equal((await engine.locks.read()).entries.length, 1);
    assert.deepEqual((await engine.inventory()).deliveryErrors, []);
  } finally {await f.close();}
});

test('TLS-49 delivers only to the shared folder, reports dsh copies and presents live reload', async () => {
  const f = await fixture();
  try {
    const dsh = TOOL_MATRIX.tools.find(tool => tool.key === 'deepseek-harness')!;
    assert.equal(dsh.route, 'agents-folder');
    assert.deepEqual(dsh.reads, ['~/.agents/skills']);
    assert.deepEqual(dsh.legacyReads, ['~/.dsh/skills']);
    assert.deepEqual(dsh.homes, [{glob: '~/.dsh', skills: '~/.dsh/skills'}]);
    assert.equal(dsh.duplicateRule, 'replace-local');
    f.options.tools = tools.filter(tool => tool.tool === dsh.key);
    const engine = f.engine(), first = f.build();
    await engine.reconcile(); await engine.applyPlan(f.plan([f.item(first)]));
    assert.deepEqual(await readdir(f.route), ['example']);
    await missing(join(f.home, '.dsh'));
    const local = await f.local('.dsh/skills/example');
    await writeFile(join(local, 'SKILL.md'), skillText('example', 'Local dsh copy.'));
    const before = await snapshot(local);
    const duplicate = {tool: dsh.key, home: '.dsh', folderName: 'example', skillId: first.skillId};
    assert.deepEqual((await engine.inventory()).duplicates, [duplicate]);
    assert.deepEqual(await engine.localCopyQuestions(), [{...duplicate, action: 'replace_local', message: 'Replace local copies'}]);
    const next = f.build(2, 'example', skillText('example', 'Updated shared copy.'));
    const asking = f.item(next, {kind: 'update', state: 'asking', answer: null,
      restartHints: [{tool: dsh.key, reload: 'restart', command: null}]});
    await engine.applyPlan(f.plan([asking]));
    const [question] = await engine.questions();
    assert.deepEqual(question.restartHints, [{tool: dsh.key, reload: 'live', command: null}]);
    assert.deepEqual(question.duplicates, [{...duplicate, action: 'replace_local', message: 'Replace local copies'}]);
    assert.deepEqual(await snapshot(local), before);
    assert.deepEqual(await listBackups(f.paths), []);
    await engine.applyPlan(f.plan([{...asking, state: 'approved', answer: 'update'}]));
    assert.equal(await readFile(join(f.route, 'example/SKILL.md'), 'utf8'), skillText('example', 'Updated shared copy.'));
    assert.deepEqual(await snapshot(local), before, 'A sync approval does not authorize replacing the local dsh copy.');
    assert.deepEqual(await readdir(f.route), ['example']);
    assert.equal((await engine.locks.read()).entries.length, 1);
    assert.deepEqual((await engine.inventory()).deliveryErrors, []);
  } finally {await f.close();}
});

for (const text of [skillText('other'), 'No frontmatter.', '---\nname: Example\ndescription: Fixture\n---\n', '---\nname: example\nname: other\n---\n', '---\nmetadata:\n  name: example\n---\n',
  ...['{"name":"other","name":"example"}', '{"metadata":{"name":"example"}}', '{"name":"Example"}', '["example"]', '{"name":"example"'].map(line => `---\n${line}\n---\nFixture skill.\n`)]) {
  test(`TLS-15 rejects a folder/frontmatter mismatch: ${JSON.stringify(text.split('\n').slice(0, 3))}`, async () => {
    const f = await fixture();
    try {
      const engine = f.engine(); await engine.reconcile(); const build = f.build(1, 'example', text);
      await engine.applyPlan(f.plan([f.item(build)]));
      await missing(join(f.route, 'example')); assert.equal((await engine.locks.read()).entries.length, 0);
      assert.ok((await engine.inventory()).deliveryErrors.some(error => error.code === 'NAME_FOLDER_MISMATCH'));
      assert.deepEqual(await engine.locks.allPending(), []);
      assert.deepEqual(await readdir(join(f.paths.data, 'staging')), []);
    } finally {await f.close();}
  });
}

test('TLS-15 rejects bad v1 without journaling and delivers good v2 across restart', async () => {
  const f = await fixture();
  try {
    let engine = f.engine(); await engine.reconcile(); const bad = f.build(1, 'example', skillText('other'));
    await engine.applyPlan(f.plan([f.item(bad)]));
    assert.deepEqual(await engine.locks.allPending(), []);
    assert.deepEqual(await readdir(join(f.paths.data, 'staging')), []);
    assert.deepEqual(await readdir(f.paths.backups), []);
    assert.ok((await engine.inventory()).deliveryErrors.some(error => error.code === 'NAME_FOLDER_MISMATCH'));
    const v2 = f.build(2, 'example', skillText('example', 'Version two.')), plan = f.plan([f.item(v2)]);
    await engine.applyPlan(plan);
    for (let restart = 0; restart < 2; restart++) {
      assert.equal(await readFile(join(f.route, 'example/SKILL.md'), 'utf8'), skillText('example', 'Version two.'));
      const entry = (await engine.locks.read()).entries[0]; assert.equal(entry.version, 2); assert.equal(entry.digest, v2.digest);
      assert.deepEqual(await engine.locks.allPending(), []);
      assert.deepEqual((await engine.inventory()).deliveryErrors, []);
      assert.equal(JSON.parse(await readFile(join(f.paths.data, 'sync-meta.json'), 'utf8')).planRevision, plan.planRevision);
      if (!restart) { engine = f.engine(); await engine.reconcile(); await engine.applyPlan(plan); }
    }
  } finally {await f.close();}
});

test('TLS-15 repeated bad updates create no staging or backups and later good v3 delivers', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const v1 = f.build();
    await engine.applyPlan(f.plan([f.item(v1)]));
    const bad = f.build(2, 'example', skillText('other'));
    for (let poll = 0; poll < 3; poll++) {
      await engine.applyPlan(f.plan([f.item(bad, {kind: 'update'})]));
      assert.deepEqual(await engine.locks.allPending(), []);
      assert.deepEqual(await readdir(join(f.paths.data, 'staging')), []);
      assert.deepEqual(await readdir(f.paths.backups), []);
      assert.equal(await readFile(join(f.route, 'example/SKILL.md'), 'utf8'), skillText());
      assert.equal((await engine.locks.read()).entries[0].version, 1);
      assert.ok((await engine.inventory()).deliveryErrors.some(error => error.code === 'NAME_FOLDER_MISMATCH'));
    }
    const v3 = f.build(3, 'example', skillText('example', 'Version three.'));
    await engine.applyPlan(f.plan([f.item(v3, {kind: 'update'})]));
    assert.equal((await engine.locks.read()).entries[0].version, 3);
    assert.equal(await readFile(join(f.route, 'example/SKILL.md'), 'utf8'), skillText('example', 'Version three.'));
    assert.deepEqual(await engine.locks.allPending(), []);
    assert.deepEqual((await engine.inventory()).deliveryErrors, []);
  } finally {await f.close();}
});

test('TLS-15 update preserves locally edited content in the engine backup and advances stamp and lock', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const v1 = f.build();
    await engine.applyPlan(f.plan([f.item(v1)]));
    const edited = skillText('example', 'Local changes that must survive.');
    await writeFile(join(f.route, 'example/SKILL.md'), edited);
    const v2 = f.build(2, 'example', skillText('example', 'Version two.'));
    await engine.applyPlan(f.plan([f.item(v2, {kind: 'update'})]));
    const backups = await listBackups(f.paths); assert.equal(backups.length, 1);
    assert.equal(await readFile(join(f.paths.backups, backups[0].id, 'agents-folder/example/SKILL.md'), 'utf8'), edited);
    assert.equal(await readFile(join(f.route, 'example/SKILL.md'), 'utf8'), skillText('example', 'Version two.'));
    const entry = (await engine.locks.read()).entries[0], stamp = await readStamp(join(f.route, 'example'), f.verifier, ['helper-test']);
    assert.equal(entry.digest, v2.digest); assert.equal(entry.previous?.digest, v1.digest);
    assert.equal(stamp.digest, v2.digest); assert.equal(stamp.version, 2);
    await engine.applyPlan(f.plan([f.item(v2, {kind: 'update'})])); assert.equal((await listBackups(f.paths)).length, 1);
  } finally {await f.close();}
});

test('TLS-15 root creation refuses symlink parents and never writes the linked destination', async () => {
  const f = await fixture();
  try {
    const outside = join(f.root, 'outside'); await mkdir(outside);
    await symlink(outside, join(f.home, '.agents'));
    await assert.rejects(f.target.root(), {code: 'PATH_UNSAFE'});
    assert.deepEqual(await readdir(outside), []);
  } finally {await f.close();}
});

test('TLS-15 detects all Codex homes, frontmatter aliases and only trusted renamed stamp ids', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const build = f.build(); await engine.applyPlan(f.plan([f.item(build)]));
    await f.local('.codex/skills/example'); await f.local('.codex-work/skills/example');
    const alias = await f.local('.codex-personal/skills/alias'); await writeFile(join(alias, 'SKILL.md'), renderedText);
    await f.local('.codex-work/skills/unrelated', 'unrelated');
    const renamed = f.build(2, 'renamed'); await f.stamped('.codex-work/skills/renamed', renamed);
    const forged = await f.stamped('.codex-work/skills/forged', f.build(2, 'forged'));
    const stampFile = join(forged, '.maddots/skill.json'), stamp = JSON.parse(await readFile(stampFile, 'utf8'));
    stamp.signature = Buffer.alloc(64).toString('base64'); await atomicWrite(stampFile, JSON.stringify(stamp));
    const duplicates = await scanDuplicates({paths: f.paths, tools: [{tool: 'codex', variant: 'cli'}], managed: (await engine.locks.read()).entries,
      verifier: f.verifier, helperIds: ['helper-test']});
    assert.deepEqual(duplicates.map(value => value.folderName).sort(), ['alias', 'example', 'example', 'renamed']);
    assert.equal(duplicates.filter(value => value.folderName === 'renamed')[0].skillId, build.skillId);
    assert.equal(new Set(duplicates.filter(value => value.folderName === 'example').map(value => value.home)).size, 2);
    assert.ok(duplicates.every(value => value.tool === 'codex'));
    for (const value of duplicates) {
      assert.deepEqual(Object.keys(value).sort(), ['folderName', 'home', 'skillId', 'tool']);
      assert.ok(!JSON.stringify(value).includes(f.home));
    }
    assert.deepEqual(duplicateQuestions(duplicates), duplicates.map(value => ({...value, action: 'replace_local', message: 'Replace local copies'})));
    const unverified = await scanDuplicates({paths: f.paths, tools: [{tool: 'codex', variant: 'cli'}], managed: (await engine.locks.read()).entries});
    assert.ok(!unverified.some(value => value.folderName === 'renamed'));
  } finally {await f.close();}
});

test('TLS-15 scans only matrix reads visible alongside a managed copy and applies duplicate rules', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const build = f.build(); await engine.applyPlan(f.plan([f.item(build)]));
    const allTools = TOOL_MATRIX.tools.map(tool => ({tool: tool.key, variant: tool.variants[0].key}));
    const allReads = new Set(TOOL_MATRIX.tools.flatMap(tool => [...tool.reads, ...tool.legacyReads, ...tool.homes.map(home => home.skills)]));
    for (const path of allReads) {
      if (path === '~/.agents/skills') continue;
      const concrete = path.slice(2).split('*').join('fixture'); await f.local(join(concrete, 'example'));
    }
    const duplicates = await scanDuplicates({paths: f.paths, tools: allTools, managed: (await engine.locks.read()).entries, verifier: f.verifier, helperIds: ['helper-test']});
    for (const tool of TOOL_MATRIX.tools) {
      const expected = new Set(tool.reads.includes('~/.agents/skills') ? [...tool.reads, ...tool.legacyReads,
        ...(tool.key === 'codex' ? tool.homes.map(home => home.skills) : [])].filter(path => path !== '~/.agents/skills' &&
          !(tool.duplicateRule === 'grok-ignore' && path.includes('/plugins/'))) : []);
      assert.equal(duplicates.filter(value => value.tool === tool.key).length, expected.size, tool.key);
    }
    assert.ok(duplicates.some(value => value.tool === 'deepseek-harness'));
    assert.ok(!duplicates.some(value => value.tool === 'grok' && value.home.includes('plugins')));
    assert.ok(duplicates.some(value => value.tool === 'grok' && value.home === '.grok'));
  } finally {await f.close();}
});

test('TLS-15 nested collection matches are omitted because replacement cannot address their leaf paths', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const build = f.build(); await engine.applyPlan(f.plan([f.item(build)]));
    await f.local('.claude/skills/one/example'); await f.local('.claude/skills/two/example');
    const duplicates = await scanDuplicates({paths: f.paths, tools: tools.filter(tool => tool.tool === 'cursor'),
      managed: (await engine.locks.read()).entries, verifier: f.verifier, helperIds: ['helper-test']});
    assert.deepEqual(duplicates, []);
  } finally {await f.close();}
});

test('TLS-15 duplicate home keys match TLS-18 root encoding', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const build = f.build(); await engine.applyPlan(f.plan([f.item(build)]));
    await f.local('.codex/skills/example'); await f.local('.config/opencode/skills/example');
    await f.local('.codex-work:%/skills/example');
    const duplicates = await scanDuplicates({paths: f.paths, tools: [{tool: 'codex', variant: 'cli'}, {tool: 'opencode', variant: 'cli'}],
      managed: (await engine.locks.read()).entries});
    assert.ok(duplicates.some(value => value.tool === 'codex' && value.home === '.codex' && value.folderName === 'example'));
    assert.ok(duplicates.some(value => value.tool === 'opencode' && value.home === '.config:opencode' && value.folderName === 'example'));
    assert.ok(duplicates.some(value => value.tool === 'codex' && value.home === '.codex-work%3A%25' && value.folderName === 'example'));
    assert.ok(!JSON.stringify(duplicates).includes(f.home));
  } finally {await f.close();}
});

test('TLS-15 a tool must see the managed route before its local copy is a duplicate', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const build = f.build(); await engine.applyPlan(f.plan([f.item(build)]));
    await f.local('.claude/skills/example'); await f.local('.hermes/skills/example');
    const duplicates = await scanDuplicates({paths: f.paths,
      tools: ['codex', 'claude-code', 'hermes', 'cursor'].map(tool => ({tool, variant: 'cli'})), managed: (await engine.locks.read()).entries});
    assert.deepEqual(duplicates, [{tool: 'cursor', home: '.claude', folderName: 'example', skillId: build.skillId}]);
  } finally {await f.close();}
});

test('TLS-15 own folders across routes are excluded in both managed orders', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const build = f.build(); await engine.applyPlan(f.plan([f.item(build)]));
    const agents = (await engine.locks.read()).entries[0];
    const plugin = {...agents, route: 'claude-plugin', target: 'claude-plugin' as const, workspaceId: 'ws'};
    const pluginRoot = join(f.home, TOOL_MATRIX.routes['claude-plugin'].path.slice(2));
    const pluginTarget: DeliveryTarget = {route: 'claude-plugin', target: 'claude-plugin', root: () => pluginRoot,
      folderFor: entry => join(pluginRoot, 'maddots-' + entry.workspaceId, 'skills', entry.name),
      place: async () => {throw new Error('This scanner fixture never places a plugin.');}, remove: async () => {}};
    await f.local(relative(f.home, pluginTarget.folderFor(plugin)));
    await f.local('.claude/plugins/cache/maddots-ai/maddots-ws/1.0.1/skills/example');
    const found = ['codex', 'claude-code', 'grok'].map(tool => ({tool, variant: 'cli'}));
    const scan = (managed: typeof agents[]) => scanDuplicates({paths: f.paths, tools: found, managed,
      managedFolders: managed.map(entry => entry.route === 'agents-folder' ? f.target.folderFor(entry) : pluginTarget.folderFor(entry)),
      verifier: f.verifier, helperIds: ['helper-test']});
    for (const managed of [[plugin, agents], [agents, plugin]]) assert.deepEqual(await scan(managed), []);
    await f.local('.codex/skills/example'); await f.local('.claude/skills/example');
    for (const managed of [[plugin, agents], [agents, plugin]]) {
      const duplicates = await scan(managed);
      assert.ok(duplicates.some(value => value.tool === 'codex' && value.home === '.codex'));
      assert.ok(duplicates.some(value => value.tool === 'claude-code' && value.home === '.claude'));
      assert.ok(duplicates.every(value => ['.codex', '.claude'].includes(value.home)));
      assert.ok(duplicateQuestions(duplicates).every(value => value.action === 'replace_local'));
    }
  } finally {await f.close();}
});

test('TLS-15 multiple delivered names for one skill are never offered for replacement', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile();
    const first = f.build(1, 'ws1-example'), second = f.build(1, 'ws2-example');
    await engine.applyPlan(f.plan([f.item(first), f.item(second)]));
    assert.equal((await engine.locks.read()).entries.length, 2);
    assert.deepEqual((await engine.inventory()).duplicates, []);
    assert.deepEqual(await engine.localCopyQuestions(), []);
    await f.stamped('.codex/skills/example', f.build());
    assert.ok((await engine.inventory()).duplicates.some(value => (value as {home: string}).home === '.codex'));
    assert.ok((await engine.localCopyQuestions()).some(value => value.tool === 'codex' && value.home === '.codex' && value.action === 'replace_local'));
  } finally {await f.close();}
});

test('TLS-15 inventory and local questions resolve every managed destination through its adapter', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const installed = f.build();
    await engine.applyPlan(f.plan([f.item(installed)]));
    const asking = f.build(1, 'workspace-example');
    await engine.applyPlan(f.plan([f.item(asking, {state: 'asking', answer: null})]));
    const names: string[] = [], folderFor = f.target.folderFor.bind(f.target);
    f.target.folderFor = entry => {names.push(entry.name); return folderFor(entry);};
    await engine.inventory();
    // One resolution inspects the accepted tree; the other supplies its exact path to the scanner.
    assert.deepEqual(names, ['example', 'example']);
    names.length = 0;
    await engine.localCopyQuestions();
    assert.deepEqual(names, ['example', 'workspace-example']);
  } finally {await f.close();}
});

test('TLS-15 large package and VCS trees cannot hide root-level Codex duplicates', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const build = f.build(); await engine.applyPlan(f.plan([f.item(build)]));
    await f.local('.codex/skills/example');
    const scan = () => scanDuplicates({paths: f.paths, tools: [{tool: 'codex', variant: 'cli'}], managed: [
      {skillId: build.skillId, name: build.name, route: 'agents-folder', target: build.target, workspaceId: build.workspaceId},
    ]});
    for (const large of ['.agents/skills/my-tools/node_modules', '.agents/skills/collection/.git']) {
      const folder = join(f.home, large); await mkdir(folder, {recursive: true});
      // Sequential chunks keep this regression below the host's open-file limit.
      for (let offset = 0; offset < 8100; offset += 100) {
        await Promise.all(Array.from({length: 100}, (_, index) => writeFile(join(folder, String(offset + index)), 'fixture')));
      }
      assert.deepEqual(await scan(), [{tool: 'codex', home: '.codex', folderName: 'example', skillId: build.skillId}]);
      await rm(folder, {recursive: true});
    }
  } finally {await f.close();}
});

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

test('TLS-15 scanning is read only and refuses links in roots, wildcard homes, folders and SKILL.md', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const build = f.build(); await engine.applyPlan(f.plan([f.item(build)]));
    const outside = join(f.root, 'outside'); await mkdir(join(outside, 'skills/secret'), {recursive: true});
    await writeFile(join(outside, 'skills/secret/SKILL.md'), skillText());
    await symlink(outside, join(f.home, '.codex-linked'));
    await symlink(outside, join(f.home, '.cursor'));
    const linkedSkill = await f.local('.codex/skills/linked-file', 'unrelated');
    await rm(join(linkedSkill, 'SKILL.md')); await symlink(join(outside, 'skills/secret/SKILL.md'), join(linkedSkill, 'SKILL.md'));
    await symlink(join(outside, 'skills/secret'), join(f.home, '.codex/skills/linked-folder'));
    await f.local('.codex/skills/example');
    const before = await snapshot(f.root);
    const duplicates = await scanDuplicates({paths: f.paths, tools, managed: (await engine.locks.read()).entries, verifier: f.verifier, helperIds: ['helper-test']});
    assert.ok(duplicates.some(value => value.tool === 'codex' && value.folderName === 'example'));
    assert.ok(!duplicates.some(value => ['linked-file', 'linked-folder', 'secret'].includes(value.folderName)));
    assert.deepEqual(await snapshot(f.root), before);
  } finally {await f.close();}
});

test('TLS-15 default inventory adds duplicates while preserving unmanaged folders', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const build = f.build(); await engine.applyPlan(f.plan([f.item(build)]));
    await f.local('.codex/skills/example'); await f.local('.agents/skills/unmanaged', 'unmanaged');
    const inventory = await engine.inventory();
    assert.ok(inventory.duplicates.some(value => (value as {tool: string; folderName: string}).tool === 'codex' && (value as {folderName: string}).folderName === 'example'));
    assert.ok(inventory.unmanaged.some(value => (value as {folderName: string}).folderName === 'unmanaged'));
    assert.equal(inventory.managed.length, 1);
  } finally {await f.close();}
});

test('TLS-15 inventory reports a canonical unmanaged conflict without moving the folder', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const build = f.build();
    await f.local('.agents/skills/example');
    const before = await snapshot(join(f.route, 'example'));
    for (const state of ['asking', 'approved'] as const) {
      await engine.applyPlan(f.plan([f.item(build, {state, answer: state === 'asking' ? null : 'update'})]));
      const inventory = await engine.inventory();
      // Release 7 merge: TLS-18's inventory names the home by its folder key ('.agents'), not the route.
      assert.deepEqual(inventory.unmanaged, [{home: '.agents', folderName: 'example', link: null, hasScripts: false,
        canonicalConflict: {skillId: build.skillId, target: build.target, name: build.name}}]);
      assert.deepEqual(inventory.duplicates, []);
      assert.deepEqual(await engine.localCopyQuestions(), []);
      assert.deepEqual(await snapshot(join(f.route, 'example')), before);
      assert.deepEqual(await engine.locks.allPending(), []);
      assert.deepEqual(await readdir(f.paths.backups), []);
      assert.deepEqual(await readdir(join(f.paths.data, 'staging')), []);
      if (state === 'approved') assert.ok(inventory.deliveryErrors.some(error => error.code === 'UNMANAGED_CONFLICT'));
    }
    await f.local('.agents/skills/unrelated', 'unrelated');
    assert.ok((await engine.inventory()).unmanaged.some(value => (value as {folderName: string; canonicalConflict?: unknown}).folderName === 'unrelated' &&
      !Object.hasOwn(value as object, 'canonicalConflict')));
  } finally {await f.close();}
});

async function reportedUnmanaged(f: Awaited<ReturnType<typeof fixture>>, engine: SyncEngine, build = f.build()) {
  const item = f.item(build, {state: 'asking', answer: null});
  await engine.applyPlan(f.plan([item]));
  await engine.reportInventory();
  return {...item, state: 'approved' as const, answer: 'replace_unmanaged' as const};
}

test('decision 25 backs up the entire unmanaged folder before delivery and restore preserves both copies', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile();
    const folder = await f.local('.agents/skills/example');
    await mkdir(join(folder, '.maddots/empty'), {recursive: true});
    await writeFile(join(folder, '.maddots/notes'), 'personal metadata');
    await writeFile(join(folder, '.DS_Store'), 'finder metadata');
    await writeFile(join(folder, 'run.sh'), '#!/bin/sh\nprintf kept\n', {mode: 0o755});
    await symlink('run.sh', join(folder, 'shortcut'));
    const before = await snapshot(folder);
    const build = f.build(1, 'example', skillText('example', 'MadDots copy.'));
    const item = await reportedUnmanaged(f, engine, build);
    const place = f.target.place.bind(f.target);
    f.target.place = async (value, staged) => {
      await missing(folder);
      const backups = await listBackups(f.paths);
      assert.equal(backups.length, 1); assert.equal(backups[0].reason, 'unmanaged_replaced');
      assert.deepEqual(await snapshot(join(f.paths.backups, backups[0].id, 'agents-folder/example')), before);
      await place(value, staged);
    };
    await engine.applyPlan(f.plan([item]));
    assert.deepEqual((await engine.inventory()).deliveryErrors, []);
    assert.equal(await readFile(join(folder, 'SKILL.md'), 'utf8'), skillText('example', 'MadDots copy.'));
    const delivered = await snapshot(folder), backups = await listBackups(f.paths);
    assert.equal(backups.length, 1);
    await engine.applyPlan(f.plan([item])); assert.equal((await listBackups(f.paths)).length, 1);
    await runCli(['backups', 'restore', backups[0].id], {home: f.home, env: {}, output() {}});
    assert.deepEqual(await snapshot(folder), before);
    const preserved = await listBackups(f.paths);
    assert.equal(preserved.length, 1); assert.equal(preserved[0].reason, 'restore-replaced');
    assert.deepEqual(await snapshot(join(f.paths.backups, preserved[0].id, 'agents-folder/example')), delivered);
    await engine.applyPlan(f.plan([item]));
    assert.deepEqual(await snapshot(folder), before); assert.equal((await listBackups(f.paths)).length, 1);
  } finally {await f.close();}
});

for (const edit of ['content', 'metadata', 'empty directory', 'permissions'] as const) {
  test(`decision 25 refuses a changed ${edit} after the reported inventory, including a later approved report`, async () => {
    const f = await fixture();
    try {
      const engine = f.engine(); await engine.reconcile(); const folder = await f.local('.agents/skills/example');
      const item = await reportedUnmanaged(f, engine);
      if (edit === 'content') await writeFile(join(folder, 'SKILL.md'), skillText('example', 'Changed after inventory.'));
      else if (edit === 'metadata') await writeFile(join(folder, '.DS_Store'), 'changed');
      else if (edit === 'empty directory') await mkdir(join(folder, 'new-empty'));
      else await chmod(join(folder, 'SKILL.md'), 0o755);
      const before = await snapshot(folder);
      // This reports the changed tree before fetching the already approved plan.
      await engine.reportInventory();
      const restarted = f.engine(); await restarted.reconcile(); await restarted.applyPlan(f.plan([item]));
      assert.ok((await restarted.inventory()).deliveryErrors.some(error => error.code === 'UNMANAGED_CHANGED'));
      assert.deepEqual(await snapshot(folder), before); assert.deepEqual(await listBackups(f.paths), []);
      assert.deepEqual(await restarted.locks.allPending(), []); assert.deepEqual((await restarted.locks.read()).entries, []);
    } finally {await f.close();}
  });
}

test('decision 25 read-only inventory and rejected or interrupted reports never authorize replacement', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const folder = await f.local('.agents/skills/example');
    const asking = f.item(f.build(), {state: 'asking', answer: null});
    const approved = {...asking, state: 'approved' as const, answer: 'replace_unmanaged' as const};
    await engine.applyPlan(f.plan([asking])); await engine.inventory(); await engine.applyPlan(f.plan([approved]));
    assert.equal((await engine.inventory()).deliveryErrors[0].code, 'UNMANAGED_NOT_REPORTED');
    const request = f.options.client.request.bind(f.options.client);
    f.options.client.request = async () => {throw new ApiError('API_FAILED', 503);};
    await assert.rejects(engine.reportInventory(), {code: 'API_FAILED'});
    f.options.client.request = request;
    // The pending baseline survives a failed request, or a crash after POST but before promotion.
    await writeFile(join(folder, 'SKILL.md'), skillText('example', 'Later edit.'));
    const before = await snapshot(folder), restarted = f.engine(); await restarted.reconcile();
    await restarted.applyPlan(f.plan([approved])); await restarted.reportInventory(); await restarted.applyPlan(f.plan([approved]));
    assert.equal((await restarted.inventory()).deliveryErrors[0].code, 'UNMANAGED_NOT_REPORTED');
    assert.deepEqual(await snapshot(folder), before); assert.deepEqual(await listBackups(f.paths), []);
  } finally {await f.close();}
});

test('decision 25 code remains held without moving the original until local Allow', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const folder = await f.local('.agents/skills/example');
    const before = await snapshot(folder), build = f.build(1, 'example', skillText('example', '! printf code'));
    const item = {...await reportedUnmanaged(f, engine, build), hasCode: true};
    await engine.applyPlan(f.plan([item]));
    assert.equal(await engine.holding.count(), 1); assert.deepEqual(await snapshot(folder), before);
    assert.deepEqual(await listBackups(f.paths), []); assert.deepEqual((await engine.locks.read()).entries, []);
    const held = (await engine.holding.entries())[0]; await engine.holding.approve(held, ['Codex']);
    await engine.applyPlan(f.plan([{...item, state: 'held'}]));
    assert.equal(await engine.holding.count(), 0); assert.equal((await engine.locks.read()).entries.length, 1);
    assert.equal((await listBackups(f.paths))[0].reason, 'unmanaged_replaced');
    assert.deepEqual((await engine.inventory()).deliveryErrors, []);
  } finally {await f.close();}
});

for (const step of ['staged', 'backed_up', 'placed', 'locked'] as const) {
  test(`decision 25 replacement recovers after ${step} without losing the original`, async () => {
    const f = await fixture();
    try {
      const engine = f.engine(); await engine.reconcile(); const folder = await f.local('.agents/skills/example');
      const before = await snapshot(folder), build = f.build(1, 'example', skillText('example', 'MadDots copy.'));
      const item = await reportedUnmanaged(f, engine, build);
      f.options.crash = current => {if (current === step) throw new Error('Injected interruption');};
      await engine.applyPlan(f.plan([item])); f.options.crash = undefined;
      const restarted = f.engine(); await restarted.reconcile(); await restarted.applyPlan(f.plan([item]));
      const backups = await listBackups(f.paths); assert.equal(backups.length, 1);
      assert.equal(backups[0].reason, 'unmanaged_replaced');
      assert.deepEqual(await snapshot(join(f.paths.backups, backups[0].id, 'agents-folder/example')), before);
      assert.deepEqual(await restarted.locks.allPending(), []);
      assert.deepEqual((await restarted.inventory()).deliveryErrors, []);
      await restoreBackup(f.paths, backups[0].id); assert.deepEqual(await snapshot(folder), before);
    } finally {await f.close();}
  });
}

test('decision 25 refuses edits during staging or backup, preserving every copy', async () => {
  for (const step of ['staged', 'backed_up'] as const) {
    const f = await fixture();
    try {
      const engine = f.engine(); await engine.reconcile(); const folder = await f.local('.agents/skills/example');
      const item = await reportedUnmanaged(f, engine);
      f.options.crash = async current => {
        if (current !== step) return;
        const path = step === 'staged' ? folder : join(f.paths.backups, (await listBackups(f.paths))[0].id, 'agents-folder/example');
        await writeFile(join(path, 'SKILL.md'), 'Edited during transaction');
      };
      await engine.applyPlan(f.plan([item]));
      assert.ok((await engine.inventory()).deliveryErrors.some(error => error.code === 'UNMANAGED_CHANGED'));
      assert.equal(await readFile(join(folder, 'SKILL.md'), 'utf8'), 'Edited during transaction');
      assert.deepEqual((await engine.locks.read()).entries, []);
    } finally {await f.close();}
  }
});

test('decision 25 refuses a source moved during staging while an independent item still delivers', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const folder = await f.local('.agents/skills/example');
    const before = await snapshot(folder), item = await reportedUnmanaged(f, engine);
    const moved = join(f.route, 'moved-by-person');
    f.options.crash = async step => {if (step === 'staged' && await lstat(folder).catch(() => null)) await durableRename(folder, moved);};
    const other = f.item(f.build(1, 'other', skillText('other', 'Independent copy.')));
    await engine.applyPlan(f.plan([item, other]));
    assert.ok((await engine.inventory()).deliveryErrors.some(error => error.name === item.name && error.code === 'UNMANAGED_CHANGED'));
    assert.deepEqual(await snapshot(moved), before); await missing(folder);
    assert.equal(await readFile(join(f.route, 'other/SKILL.md'), 'utf8'), skillText('other', 'Independent copy.'));
    assert.deepEqual(await listBackups(f.paths), []);
  } finally {await f.close();}
});

test('TLS-15 reload hints come from matrix once per detected shared tool', () => {
  const hints = agentsFolderReloadHints([...tools, ...tools, {tool: 'unknown', variant: 'cli'}, {tool: 'claude-desktop', variant: 'desktop'}, {tool: 'grok', variant: 'nonexistent'}]);
  assert.deepEqual(hints, sharedTools.map(tool => ({tool: tool.key, reload: tool.reload.kind, command: tool.reload.command})));
  assert.equal(hints.filter(hint => hint.tool === 'codex')[0].reload, 'live');
  assert.equal(hints.filter(hint => hint.tool === 'gemini-cli')[0].command, '/skills reload');
  assert.equal(hints.filter(hint => hint.tool === 'cursor')[0].reload, 'restart');
  const matrix = structuredClone(TOOL_MATRIX), codex = matrix.tools.find(tool => tool.key === 'codex')!;
  codex.reload = {kind: 'command', command: '/fixture reload'};
  assert.deepEqual(agentsFolderReloadHints([{tool: 'codex', variant: codex.variants[0].key}], matrix), [{tool: 'codex', reload: 'command', command: '/fixture reload'}]);
});

test('TLS-15 sync questions include local matrix reload hints and Replace local copies without writing', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); assert.deepEqual(await engine.questions(), []);
    const build = f.build(); await engine.applyPlan(f.plan([f.item(build)]));
    await f.local('.codex/skills/example');
    const asking = f.item(build, {kind: 'update', state: 'asking', answer: null, restartHints: [{tool: 'fake', reload: 'restart', command: null}]});
    await engine.applyPlan(f.plan([asking]));
    const before = await snapshot(f.root), calls = f.calls.length;
    const questions = await engine.questions();
    assert.equal(questions.length, 1); assert.equal(questions[0].itemId, asking.itemId);
    assert.deepEqual(questions[0].restartHints, agentsFolderReloadHints(tools));
    assert.ok(questions[0].duplicates.some(value => value.tool === 'codex' && value.action === 'replace_local' && value.message === 'Replace local copies'));
    assert.equal(f.calls.length, calls); assert.deepEqual(await snapshot(f.root), before);
    await engine.applyPlan(f.plan([f.item(build, {state: 'later', answer: 'later'})])); assert.deepEqual(await engine.questions(), []);
  } finally {await f.close();}
});

test('TLS-15 local-copy questions remain available for installed skills after an empty plan', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const build = f.build(); await engine.applyPlan(f.plan([f.item(build)]));
    await f.local('.codex/skills/example');
    await engine.applyPlan(f.plan([])); assert.deepEqual(await engine.questions(), []);
    const duplicates = await scanDuplicates({paths: f.paths, tools, managed: (await engine.locks.read()).entries,
      verifier: f.verifier, helperIds: ['helper-test']});
    const before = await snapshot(f.root), calls = f.calls.length;
    const questions = await engine.localCopyQuestions();
    assert.deepEqual(questions, duplicateQuestions(duplicates));
    assert.ok(questions.some(value => value.tool === 'codex' && value.folderName === 'example' && value.action === 'replace_local'));
    assert.equal(f.calls.length, calls); assert.deepEqual(await snapshot(f.root), before);
  } finally {await f.close();}
});

test('TLS-15 Grok warns only with an active Claude plugin route and a missing relevant ignore', async () => {
  const f = await fixture();
  try {
    const warning = () => grokDuplicateWarning({paths: f.paths, tools: [{tool: 'grok', variant: 'cli'}], activeRoutes: ['agents-folder', 'claude-plugin']});
    assert.equal(await warning(), 'Grok may list MadDots skills twice');
    assert.equal(await grokDuplicateWarning({paths: f.paths, tools: [], activeRoutes: ['claude-plugin']}), null);
    assert.equal(await grokDuplicateWarning({paths: f.paths, tools, activeRoutes: ['agents-folder']}), null);
    const config = join(f.home, '.grok/config.toml'); await mkdir(dirname(config), {recursive: true});
    assert.equal(TOOL_MATRIX.routes['claude-plugin'].readPath, null);
    for (const text of [
      '# [skills]\n# ignore = ["~/.claude/plugins/cache/*/*/*/skills"]\n',
      '[skills]\nignore = ["~/.other/plugins/**"]\n',
      '[other]\nignore = ["~/.claude/plugins/cache/*/*/*/skills"]\n',
      '[skills]\nignore = ["~/.maddots-ai/claude-code"]\n',
      `[skills]\nignore = ["${join(f.home, '.maddots-ai/claude-code')}"]\n`,
      'description="""\n[skills]\nignore=["~/.claude/plugins/cache/*/*/*/skills"]\n"""\n',
    ]) {
      await writeFile(config, text); assert.equal(await warning(), 'Grok may list MadDots skills twice');
    }
    await writeFile(config, '[skills]\nignore = ["~/.claude/plugins/cache/*/*/*/skills"]\n');
    const before = await snapshot(f.root); assert.equal(await warning(), null); assert.deepEqual(await snapshot(f.root), before);
    await writeFile(config, `[skills]\nignore = ["${join(f.home, '.claude/plugins/cache/*/*/*/skills')}"]\n`); assert.equal(await warning(), null);
    await rm(config); const outside = join(f.root, 'outside.toml');
    await writeFile(outside, '[skills]\nignore = ["~/.claude/plugins/cache/*/*/*/skills"]\n'); await symlink(outside, config);
    assert.equal(await warning(), 'Grok may list MadDots skills twice');
    await rm(config); await writeFile(config, '[skills]\nignore = ["~/.claude/plugins/cache/*/*/*/skills"]\n' + '#'.repeat(2 * 1024 * 1024));
    assert.equal(await warning(), 'Grok may list MadDots skills twice');
  } finally {await f.close();}
});

test('TLS-15 Grok plugin copies never become replace-local questions before or after ignore', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const build = f.build(); await engine.applyPlan(f.plan([f.item(build)]));
    await f.local('.claude/plugins/cache/other-market/other-plugin/1.2.0/skills/example');
    await f.local('.claude/plugins/cache/maddots-ai/maddots-workspace/1.0.3/skills/example');
    await f.local('.grok/skills/example');
    const tools = [{tool: 'grok', variant: 'cli'}], managed = (await engine.locks.read()).entries;
    const expected = [{tool: 'grok', home: '.grok', folderName: 'example', skillId: build.skillId,
      action: 'replace_local', message: 'Replace local copies'}];
    const questions = async () => duplicateQuestions(await scanDuplicates({paths: f.paths, tools, managed}));
    const warning = () => grokDuplicateWarning({paths: f.paths, tools, activeRoutes: ['agents-folder', 'claude-plugin']});
    assert.deepEqual(await questions(), expected);
    assert.equal(await warning(), 'Grok may list MadDots skills twice');
    await writeFile(join(f.home, '.grok/config.toml'), '[skills]\nignore = ["~/.claude/plugins/cache/*/*/*/skills"]\n');
    assert.deepEqual(await questions(), expected);
    assert.equal(await warning(), null);
  } finally {await f.close();}
});

test('TLS-15 CLI status displays the Grok warning and removes it when the relevant ignore exists', async () => {
  const f = await fixture();
  try {
    const now = f.options.timing!.now(), renewBy = new Date(now + 90 * 86400_000).toISOString(), idleLapseAt = new Date(now + 30 * 86400_000).toISOString();
    let connections = [{id: 'claude-connection', tool: 'claude-code', variant: 'cli'}];
    const credential = 'mdai_skill_' + 'A'.repeat(43), output: string[] = [], calls: string[] = [];
    await atomicWrite(f.paths.state, JSON.stringify({format: 1, endpoint: readConfig({}, f.home).endpoint.href,
      status: 'connected', helperId: 'helper-test', scopes: ['sync'], tools: tools.filter(tool => tool.tool === 'grok'),
      pendingTools: [], tokenStorage: 'keychain', renewBy, idleLapseAt, connections}));
    const cliOptions = {home: f.home, env: {}, timing: f.options.timing, output: (line: string) => output.push(line),
      runner: async (file: string, args: readonly string[]) => {
        assert.equal(file, '/usr/bin/security'); assert.equal(args[0], 'find-generic-password');
        return {stdout: credential, stderr: ''};
      }, request: (async (input: string | URL | Request) => {
        const path = new URL(String(input)).pathname; calls.push(path); assert.equal(path, '/api/helper/status');
        return new Response(JSON.stringify({data: {account: {id: 'owner-test', name: 'Fixture owner'}, scopes: ['sync'], renewBy, idleLapseAt, pending: [], connections}}));
      }) as typeof fetch};
    await runCli(['status'], cliOptions);
    assert.ok(output.includes('Grok may list MadDots skills twice'));
    await mkdir(join(f.home, '.grok'), {recursive: true});
    await writeFile(join(f.home, '.grok/config.toml'), '[skills]\nignore = ["~/.claude/plugins/cache/*/*/*/skills"]\n');
    output.length = 0; await runCli(['status'], cliOptions);
    assert.ok(!output.includes('Grok may list MadDots skills twice'));
    await rm(join(f.home, '.grok/config.toml')); connections = [];
    output.length = 0; await runCli(['status'], cliOptions);
    assert.ok(!output.includes('Grok may list MadDots skills twice'));
    assert.equal(calls.length, 3); assert.ok(output.every(line => !line.includes(credential)));
  } finally {await f.close();}
});

test('TLS-15 CLI status survives an unreadable lock and still warns from connections', async () => {
  const f = await fixture();
  try {
    const now = f.options.timing!.now(), renewBy = new Date(now + 90 * 86400_000).toISOString(), idleLapseAt = new Date(now + 30 * 86400_000).toISOString();
    const connections = [{id: 'claude-connection', tool: 'claude-code', variant: 'cli'}], output: string[] = [];
    await atomicWrite(f.paths.state, JSON.stringify({format: 1, endpoint: readConfig({}, f.home).endpoint.href,
      status: 'connected', helperId: 'helper-test', scopes: ['sync'], tools: tools.filter(tool => tool.tool === 'grok'),
      pendingTools: [], tokenStorage: 'keychain', renewBy, idleLapseAt, connections}));
    const cliOptions = {home: f.home, env: {}, timing: f.options.timing, output: (line: string) => output.push(line),
      runner: async (file: string, args: readonly string[]) => {
        assert.equal(file, '/usr/bin/security'); assert.equal(args[0], 'find-generic-password');
        return {stdout: 'mdai_skill_' + 'A'.repeat(43), stderr: ''};
      }, request: (async () => new Response(JSON.stringify({data: {account: {id: 'owner-test', name: 'Fixture owner'}, scopes: ['sync'],
        renewBy, idleLapseAt, pending: [], connections}}))) as typeof fetch};
    const lockFile = join(f.paths.data, 'lock.json');
    for (const invalid of ['{"format":1}', 'not json']) {
      await atomicWrite(lockFile, invalid); output.length = 0;
      await runCli(['status'], cliOptions);
      assert.ok(output.includes('Grok may list MadDots skills twice'));
      assert.ok(output.some(line => line.includes('could not be read: The skill lock is invalid.')));
    }
    await atomicWrite(lockFile, JSON.stringify({format: 1, helperId: 'helper-test', updatedAt: new Date(0).toISOString(), entries: [], replaced: []}));
    await chmod(lockFile, 0o644); output.length = 0;
    await runCli(['status'], cliOptions);
    assert.ok(output.includes('Grok may list MadDots skills twice'));
    assert.ok(output.some(line => line.includes('could not be read: The helper file must be private')));
  } finally {await f.close();}
});

for (const step of [null, 'staged', 'backed_up', 'placed', 'locked'] as const) {
  test(`decision 25 replaces a fresh unmanaged folder after a removed lock entry${step ? ` across ${step} recovery` : ''}`, async () => {
    const f = await fixture();
    try {
      const engine = f.engine(); await engine.reconcile();
      const v1 = f.build(), folder = join(f.route, 'example');
      await engine.applyPlan(f.plan([f.item(v1)]));
      await engine.applyPlan(f.plan([f.item(v1, {kind: 'forced_remove', state: 'forced', answer: null, reason: 'revoked'})]));
      await missing(folder);
      const removed = (await engine.locks.read()).entries[0]; assert.equal(removed.removed, true);
      await f.local('.agents/skills/example');
      await writeFile(join(folder, 'personal.txt'), 'New unmanaged content after removal.');
      const before = await snapshot(folder), removalBackups = await listBackups(f.paths);
      const v2 = f.build(2, 'example', skillText('example', 'MadDots version two.'));
      const asking = f.item(v2, {kind: 'update', fromVersion: 1, state: 'asking', answer: null});
      await engine.applyPlan(f.plan([asking])); await engine.reportInventory();
      const approved = {...asking, state: 'approved' as const, answer: 'replace_unmanaged' as const};
      if (step) f.options.crash = current => {if (current === step) throw new Error('Injected interruption');};
      await engine.applyPlan(f.plan([approved])); f.options.crash = undefined;
      if (step) {
        const pending = await engine.locks.allPending(); assert.equal(pending.length, 1);
        assert.deepEqual(pending[0].prior, removed, 'The journal must preserve removed acceptance history.');
        assert.ok(pending[0].unmanagedDigest);
      } else assert.deepEqual((await engine.inventory()).deliveryErrors, []);
      const restarted = f.engine(); await restarted.reconcile(); await restarted.applyPlan(f.plan([approved]));
      assert.deepEqual((await restarted.inventory()).deliveryErrors, []);
      assert.equal(await readFile(join(folder, 'SKILL.md'), 'utf8'), skillText('example', 'MadDots version two.'));
      const entry = (await restarted.locks.read()).entries[0];
      assert.equal(entry.version, 2); assert.equal(entry.digest, v2.digest); assert.equal(entry.removed, undefined);
      assert.equal(entry.acceptedBy, 'update'); assert.deepEqual(entry.previous, {version: 1, settingsRevision: 0, digest: v1.digest});
      assert.deepEqual(await restarted.locks.allPending(), []);
      const backups = await listBackups(f.paths), replacement = backups.find(value => value.reason === 'unmanaged_replaced');
      assert.ok(replacement); assert.equal(backups.length, removalBackups.length + 1);
      assert.deepEqual(await snapshot(join(f.paths.backups, replacement.id, 'agents-folder/example')), before);
      for (const backup of removalBackups) assert.ok(backups.some(value => value.id === backup.id));
      await restoreBackup(f.paths, replacement.id); assert.deepEqual(await snapshot(folder), before);
    } finally {await f.close();}
  });
}
