import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { treeDigest } from '../src/shared/build-format.js';
import { TOOL_MATRIX } from '../src/shared/tool-matrix.js';
import type { ApiClient } from '../src/api.js';
import { listBackups } from '../src/backups.js';
import { CommandError, HelperError, readConfig, type CommandOptions, type Runner } from '../src/config.js';
import { ClaudePluginDeliveryTarget, ClaudePluginSyncEngine } from '../src/delivery/claude-plugin.js';
import { FolderDeliveryTarget } from '../src/delivery/index.js';
import { entryKey } from '../src/lock.js';
import { createPaths, ensurePaths } from '../src/paths.js';
import { assertRouteRoot } from '../src/safe-fs.js';
import { readStamp } from '../src/stamp.js';
import type { SyncOptions, SyncPlan } from '../src/sync.js';
import { BuildVerifier, signedBuildString, type PlanItem, type SignedBuild } from '../src/verify.js';

async function fixture(readCopy = false, cli = true) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-claude-'));
  const home = join(root, 'home'); await mkdir(home, {mode: 0o700});
  const paths = await createPaths(readConfig({}, home)); await ensurePaths(paths);
  const binary = join(home, 'bin/claude'); await mkdir(join(home, 'bin'));
  if (cli) { await writeFile(binary, 'fixture executable'); await chmod(binary, 0o700); }
  const matrix = structuredClone(TOOL_MATRIX);
  if (readCopy) matrix.routes['claude-plugin'].readPath = '~/.claude/plugins/cache/maddots-ai';
  const calls: {file: string; args: readonly string[]; options?: CommandOptions}[] = [];
  let commandFailure = false, marketplaceList = '[]';
  let failCommand: (args: readonly string[]) => boolean = () => false;
  const installed = new Set<string>();
  const runner: Runner = async (file, args, options) => {
    calls.push({file, args: [...args], options});
    if (args[0] === '--version') return {stdout: '2.1.289 (Claude Code)', stderr: ''};
    if (commandFailure || failCommand(args)) throw new CommandError(1);
    if (args.join(' ') === 'plugin marketplace list --json') return {stdout: marketplaceList, stderr: ''};
    if (args.join(' ') === 'plugin list --json') return {stdout: JSON.stringify([...installed].map(id => ({id, enabled: true}))), stderr: ''};
    if (args[1] === 'install') installed.add(args[2]);
    if (args[1] === 'marketplace' && args[2] === 'add') marketplaceList = JSON.stringify([{name: 'maddots-ai', source: 'directory', path: args[3]}]);
    return {stdout: '', stderr: ''};
  };
  const adapterOptions = {paths, helperId: 'helper-test', matrix, runner,
    env: {PATH: join(home, 'bin'), TEST_TOKEN: 'redacted', TEST_KEY: 'redacted', TEST_SECRET: 'redacted'},
    workspaceSlugs: {workspaceA: 'alpha', workspaceB: 'beta'}};
  let plugin = new ClaudePluginDeliveryTarget(adapterOptions);
  const signer = generateKeyPairSync('ed25519'), publicKey = signer.publicKey.export({type: 'spki', format: 'der'}).subarray(-32);
  const keyId = createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
  const verifier = new BuildVerifier({keys: [{keyId, publicKey: publicKey.toString('base64')}], env: {}});
  const builds = new Map<string, SignedBuild>();
  const client = {request: async (path: string) => ({status: 200, headers: new Headers(), data: structuredClone(builds.get(new URL(path, 'http://x').pathname.slice('/api/helper/builds/'.length)))})} as Pick<ApiClient, 'request'>;
  let now = 1_760_000_000_000;
  const options: SyncOptions = {paths, helperId: 'helper-test', client, targets: [], verifier,
    watchRoute: () => ({close() {}}),
    timing: {now: () => now, sleep: async ms => { now += ms; }}};
  function build(version = 1, changes: Partial<SignedBuild> = {}): SignedBuild {
    const name = changes.name ?? 'example';
    const content = Buffer.from(`---\nname: ${name}\ndescription: Example\n---\nVersion ${version}\n`);
    const result: SignedBuild = {format: 1, keyId, skillId: 'skill-example', version, settingsRevision: 0, level: 'workspace', workspaceId: 'workspaceA', boardId: null,
      target: 'claude-plugin', name, hasCode: false, draft: false,
      files: [{path: 'SKILL.md', mode: '100644', size: content.length, sha256: createHash('sha256').update(content).digest('hex'), content: content.toString('base64')}],
      report: {renamedFrom: null, unresolvedOptionalReferences: [], unsetSettings: []}, digest: treeDigest([{path: 'SKILL.md', mode: '100644', content}]), signature: '', ...changes};
    result.signature = sign(null, Buffer.from(signedBuildString(result)), signer.privateKey).toString('base64');
    builds.set(result.digest, result); return result;
  }
  function item(build: SignedBuild, changes: Partial<PlanItem> = {}): PlanItem {
    return {itemId: createHash('sha256').update(JSON.stringify([build, changes])).digest('hex'), kind: 'install', skillId: build.skillId, name: build.name, sourceName: build.name,
      level: build.level, workspaceId: build.workspaceId, workspaceIds: [build.workspaceId], boardIds: [], target: build.target, route: 'claude-plugin', fromVersion: null,
      version: build.version, settingsRevision: build.settingsRevision, digest: build.digest, hasCode: build.hasCode, draft: false, dependencyOf: null,
      missingDependencies: [], forAgentIds: [], state: 'approved', answer: 'update', reason: null, restartHints: [], ...changes};
  }
  const plan = (items: PlanItem[]): SyncPlan => ({planRevision: createHash('sha256').update(JSON.stringify(items)).digest('hex'), degraded: false, pollAfterSeconds: 60, items, revoked: [], instructions: []});
  const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
  return {root, home, paths, binary, calls, matrix, options, adapterOptions, builds, verifier, build, item, plan, json, plugin: () => plugin,
    marketplaceList: (value: string) => {marketplaceList = value;},
    failCommand: (predicate: (args: readonly string[]) => boolean) => {failCommand = predicate;},
    uninstall: (id: string) => installed.delete(id),
    engine: () => new ClaudePluginSyncEngine(options, plugin), failCommands: (fail: boolean) => {commandFailure = fail;},
    restart: () => {plugin = new ClaudePluginDeliveryTarget(adapterOptions); return new ClaudePluginSyncEngine(options, plugin);},
    close: () => rm(root, {recursive: true, force: true})};
}
const missing = async (path: string) => assert.rejects(lstat(path), {code: 'ENOENT'});
const pluginCommands = (calls: Awaited<ReturnType<typeof fixture>>['calls']) => calls.filter(call => call.args[0] === 'plugin' && !call.args.includes('list'));

test('one plugin per workspace namespaces multiple skills, with a single marketplace and TLS-13 stamps/lock', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile();
    const a = f.build(), b = f.build(1, {skillId: 'skill-second', name: 'second'}), c = f.build(1, {workspaceId: 'workspaceB', skillId: 'skill-beta', name: 'beta-example'});
    await engine.applyPlan(f.plan([f.item(a), f.item(b), f.item(c)]));
    assert.deepEqual((await engine.inventory()).deliveryErrors, []);
    const root = await f.plugin().root(), market = await f.json(join(root, '.claude-plugin/marketplace.json'));
    assert.equal(market.name, 'maddots-ai');
    assert.deepEqual(market.plugins.map((plugin: {name: string}) => plugin.name), ['maddots-alpha', 'maddots-beta']);
    assert.deepEqual(await readdir(join(root, 'maddots-alpha/skills')), ['example', 'second']);
    assert.equal(f.plugin().namespacedName(a), 'maddots-alpha:example');
    assert.equal(f.plugin().namespacedName(c), 'maddots-beta:beta-example');
    assert.equal((await f.json(join(root, 'maddots-alpha/.claude-plugin/plugin.json'))).version, '1.0.1');
    assert.equal((await f.json(join(root, 'maddots-beta/.claude-plugin/plugin.json'))).version, '1.0.1');
    const entry = (await engine.locks.read()).entries.find(entry => entry.skillId === a.skillId)!;
    assert.equal((await readStamp(f.plugin().folderFor(a), f.verifier, ['helper-test'])).digest, entry.digest);
    assert.equal((await engine.inventory()).managed.filter(entry => entry.state === 'ok').length, 3);
    assert.deepEqual((await engine.inventory()).unmanaged, []);
    await missing(join(f.home, '.claude/skills'));
  } finally { await f.close(); }
});

test('sync questions defer updates until answered, then run exact provisional matrix commands with a scrubbed environment', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const v1 = f.build(), v2 = f.build(2);
    await engine.applyPlan(f.plan([f.item(v1)]));
    const firstCommands = pluginCommands(f.calls);
    assert.deepEqual(firstCommands.map(call => call.args), f.plugin().commands(v1.workspaceId).slice(0, 2));
    const before = await readFile(join(f.plugin().folderFor(v1), 'SKILL.md'), 'utf8');
    for (const state of ['asking', 'later', 'kept_local'] as const) await engine.applyPlan(f.plan([f.item(v2, {kind: 'update', state, answer: null})]));
    assert.equal(await readFile(join(f.plugin().folderFor(v1), 'SKILL.md'), 'utf8'), before);
    assert.equal(pluginCommands(f.calls).length, 2);
    await engine.applyPlan(f.plan([f.item(v2, {kind: 'update', answer: 'update'})]));
    assert.deepEqual(pluginCommands(f.calls).slice(2).map(call => call.args), f.plugin().commands(v1.workspaceId).slice(2));
    for (const call of f.calls) {
      assert.equal(call.file, f.binary); assert.equal(call.options?.timeout, call.args[0] === 'plugin' ? 120_000 : 10_000);
      assert.equal(Object.keys(call.options?.env ?? {}).some(key => /TOKEN|KEY|SECRET/iu.test(key)), false);
    }
    const skillBackups = (await listBackups(f.paths)).filter(backup => backup.folderName === 'example');
    assert.equal(skillBackups.length, 1);
    assert.equal(await readFile(join(f.paths.backups, skillBackups[0].id, 'claude-plugin/example/SKILL.md'), 'utf8'), before);
    const version = (await f.json(join(await f.plugin().root(), 'maddots-alpha/.claude-plugin/plugin.json'))).version;
    await f.restart().applyPlan(f.plan([f.item(v2, {kind: 'update'})]));
    assert.equal((await f.json(join(await f.plugin().root(), 'maddots-alpha/.claude-plugin/plugin.json'))).version, version);
    assert.equal(pluginCommands(f.calls).length, 4);
  } finally { await f.close(); }
});

test('missing CLI keeps the item waiting with command hints and no accepted or delivered skill', async () => {
  const f = await fixture(false, false);
  try {
    const engine = f.engine(); await engine.reconcile(); const build = f.build();
    await engine.applyPlan(f.plan([f.item(build)]));
    await missing(f.plugin().folderFor(build)); assert.equal((await engine.locks.read()).entries.length, 0);
    assert.equal((await engine.inventory()).deliveryErrors[0].code, 'CLAUDE_CLI_MISSING');
    const status = new ClaudePluginDeliveryTarget(f.adapterOptions);
    const lines = (await status.statusLines()).join('\n');
    assert.ok(lines.includes('claude plugin marketplace add ~/.maddots-ai/claude-code'));
    assert.ok(lines.includes('claude plugin install maddots-alpha\x40maddots-ai'));
    assert.equal(lines.includes(f.home), false);
    const inventory = JSON.stringify(await engine.inventory());
    assert.equal(inventory.includes('claude plugin'), false); assert.equal(inventory.includes(f.home), false);
    assert.equal(pluginCommands(f.calls).length, 0);
    await writeFile(f.binary, 'fixture executable'); await chmod(f.binary, 0o700);
    await engine.applyPlan(f.plan([f.item(build)]));
    assert.deepEqual((await engine.inventory()).deliveryErrors, []); assert.equal((await engine.locks.read()).entries.length, 1);
    assert.deepEqual(await status.statusLines(), []);
  } finally { await f.close(); }
});

test('registration failures survive a restart and retry the same plugin generation', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); f.failCommands(true); const build = f.build();
    await engine.applyPlan(f.plan([f.item(build)]));
    assert.equal((await engine.locks.read()).entries.length, 1);
    assert.ok((await engine.inventory()).deliveryErrors.some(error => error.code === 'COMMAND_FAILED'));
    f.failCommands(false); const restarted = f.restart(); await restarted.reconcile();
    assert.deepEqual((await restarted.inventory()).deliveryErrors, []);
    assert.equal((await f.json(join(await f.plugin().root(), 'maddots-alpha/.claude-plugin/plugin.json'))).version, '1.0.1');
    assert.equal((await f.json(join(f.paths.data, 'claude-plugin-registration.json'))).plugins[0].installed, 1);
  } finally { await f.close(); }
});

for (const step of ['staged', 'backed_up', 'placed', 'locked'] as const) test(`TLS-13 recovery at ${step} also repairs plugin registration without duplicating the skill`, async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const v1 = f.build(), v2 = f.build(2);
    await engine.applyPlan(f.plan([f.item(v1)]));
    f.options.crash = where => { if (where === step) throw new Error('Injected crash'); };
    const crashing = f.engine(); await crashing.applyPlan(f.plan([f.item(v2, {kind: 'update'})]));
    assert.ok(await crashing.locks.pending(entryKey(v2))); f.options.crash = undefined;
    const restarted = f.restart(); await restarted.reconcile();
    assert.equal((await restarted.locks.read()).entries[0].digest, v2.digest);
    assert.equal((await restarted.inventory()).managed[0].state, 'ok');
    assert.equal((await f.json(join(await f.plugin().root(), 'maddots-alpha/.claude-plugin/plugin.json'))).version, '1.0.2');
    assert.deepEqual(await readdir(join(await f.plugin().root(), 'maddots-alpha/skills')), ['example']);
    assert.equal((await listBackups(f.paths)).filter(backup => backup.folderName === 'example').length, 1);
  } finally { await f.close(); }
});

test('readPath cache edits are reported as edited and never written back to the source or cache', async () => {
  const f = await fixture(true);
  try {
    const engine = f.engine(); await engine.reconcile(); const build = f.build(); await engine.applyPlan(f.plan([f.item(build)]));
    const source = f.plugin().folderFor(build), copy = await f.plugin().readFolderFor(build);
    assert.equal((await engine.inventory()).managed[0].state, 'missing');
    await mkdir(join(copy, '..'), {recursive: true}); await cp(source, copy, {recursive: true});
    assert.equal((await engine.inventory()).managed[0].state, 'ok');
    await writeFile(join(copy, 'SKILL.md'), 'Local edit in the copy Claude actually reads');
    const inventory = await engine.inventory();
    assert.equal(inventory.managed[0].state, 'edited'); assert.notEqual(inventory.managed[0].localDigest, build.digest);
    assert.equal(inventory.managed[0].digest, build.digest);
    await engine.applyPlan(f.plan([f.item(build)]));
    assert.match(await readFile(join(source, 'SKILL.md'), 'utf8'), /Version 1/u);
    assert.equal(await readFile(join(copy, 'SKILL.md'), 'utf8'), 'Local edit in the copy Claude actually reads');
    assert.equal(JSON.stringify(inventory).includes(f.home), false); assert.equal(JSON.stringify(inventory).includes('Local edit'), false);
    await rm(copy, {recursive: true}); await symlink(source, copy);
    assert.equal((await engine.inventory()).managed[0].state, 'edited');
  } finally { await f.close(); }
});

test('readPath watcher forwards change notifications and closes with the sync loop', async () => {
  const f = await fixture(true);
  try {
    const readRoot = join(f.home, '.claude/plugins/cache/maddots-ai'); await mkdir(readRoot, {recursive: true});
    const watchers: {path: string; changed: () => void; closed: boolean}[] = [];
    f.options.watchRoute = (path, changed) => {const watcher = {path, changed, closed: false}; watchers.push(watcher); return {close: () => {watcher.closed = true;}};};
    const engine = f.engine(); let notifications = 0; engine.notifyChange = () => {notifications++;};
    await engine.run(AbortSignal.abort());
    assert.equal(watchers[0].path, readRoot); const initial = notifications; watchers[0].changed(); assert.equal(notifications, initial + 1); assert.equal(watchers[0].closed, true);
  } finally { await f.close(); }
});

test('Claude skills and symlinked plugin routes are refused; unrelated folders stay untouched', async () => {
  const f = await fixture();
  try {
    const forbidden = join(f.home, '.claude/skills'); await mkdir(forbidden, {recursive: true});
    await writeFile(join(forbidden, 'keep'), 'unmanaged');
    await assert.rejects(assertRouteRoot(f.paths, forbidden), {code: 'PATH_UNSAFE'});
    const matrix = structuredClone(f.matrix); matrix.routes['claude-plugin'].path = '~/.claude/skills';
    assert.throws(() => new ClaudePluginDeliveryTarget({paths: f.paths, helperId: 'helper-test', matrix}), {code: 'ROUTE_INVALID'});
    const route = join(f.home, '.maddots-ai/claude-code'); await mkdir(join(f.home, '.maddots-ai')); await symlink(forbidden, route);
    await assert.rejects(f.plugin().root(), {code: 'PATH_UNSAFE'});
    assert.equal(await readFile(join(forbidden, 'keep'), 'utf8'), 'unmanaged');
    assert.throws(() => f.plugin().folderFor({...f.build(), name: '../escape'}), {code: 'PATH_UNSAFE'});
  } finally { await f.close(); }
});

test('code builds remain held and tampered builds never create plugin metadata or invoke install', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const code = f.build(1, {hasCode: true});
    await engine.applyPlan(f.plan([f.item(code)]));
    await missing(f.plugin().folderFor(code)); assert.equal((await engine.inventory()).holdingCount, 1);
    const bad = f.build(2); bad.signature = Buffer.alloc(64).toString('base64');
    await engine.applyPlan(f.plan([f.item(bad)]));
    assert.equal((await engine.inventory()).deliveryErrors[0].code, 'BUILD_SIGNATURE_INVALID');
    assert.equal(pluginCommands(f.calls).length, 0); await missing(join(await f.plugin().root(), '.claude-plugin/marketplace.json'));
  } finally { await f.close(); }
});

test('forced removal preserves content in backups and increases only that workspace plugin version', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const build = f.build(), beta = f.build(1, {workspaceId: 'workspaceB', skillId: 'skill-beta', name: 'beta-example'});
    await engine.applyPlan(f.plan([f.item(build), f.item(beta)]));
    await engine.applyPlan(f.plan([f.item(build, {kind: 'forced_remove', state: 'forced', answer: null, reason: 'revoked'}), f.item(beta)]));
    assert.equal((await f.json(join(await f.plugin().root(), 'maddots-beta/.claude-plugin/plugin.json'))).version, '1.0.1');
    await missing(f.plugin().folderFor(build)); assert.equal((await engine.locks.read()).entries[0].removed, true);
    assert.equal((await f.json(join(await f.plugin().root(), 'maddots-alpha/.claude-plugin/plugin.json'))).version, '1.0.2');
    assert.equal((await listBackups(f.paths)).filter(backup => backup.folderName === 'example').length, 1);
  } finally { await f.close(); }
});

test('slug collisions are rejected and changed workspace mappings preserve the saved slug', async () => {
  const f = await fixture();
  try {
    const plugin = new ClaudePluginDeliveryTarget({...f.adapterOptions, workspaceSlugs: {workspaceA: 'foo'}});
    const engine = new ClaudePluginSyncEngine(f.options, plugin); await engine.reconcile();
    const a = f.build(), b = f.build(2, {workspaceId: 'foo', skillId: 'skill-other', name: 'other'});
    await engine.applyPlan(f.plan([f.item(a), f.item(b)]));
    assert.equal((await engine.locks.read()).entries.length, 0); await missing(plugin.folderFor(a)); await missing(plugin.folderFor(b));
    assert.deepEqual((await engine.inventory()).deliveryErrors.map(error => [error.skillId, error.code]),
      [[a.skillId, 'PLUGIN_WORKSPACE_INVALID'], [b.skillId, 'PLUGIN_WORKSPACE_INVALID']]);
    await f.engine().applyPlan(f.plan([f.item(a)]));
    const changed = new ClaudePluginDeliveryTarget({...f.adapterOptions, workspaceSlugs: {workspaceA: 'changed'}});
    const changedEngine = new ClaudePluginSyncEngine(f.options, changed);
    await changedEngine.applyPlan(f.plan([f.item(f.build(2), {kind: 'update'})]));
    assert.equal(changed.folderFor(a), join(await changed.root(), 'maddots-alpha/skills/example'));
    assert.match(await readFile(join(changed.folderFor(a), 'SKILL.md'), 'utf8'), /Version 2/u);
    assert.equal((await changedEngine.locks.read()).entries[0].version, 2);
    assert.deepEqual((await changedEngine.inventory()).deliveryErrors, []);
  } finally { await f.close(); }
});

test('missing Claude dependency remains in the plan and blocks its parent route', async () => {
  const f = await fixture(false, false);
  try {
    const route = join(f.home, '.agents/skills'); await mkdir(route, {recursive: true});
    f.options.targets = [new FolderDeliveryTarget(f.paths, 'agents-folder', route)];
    const engine = f.engine(); await engine.reconcile();
    const dependency = f.build(), parent = f.build(2, {skillId: 'skill-parent', target: 'folder', name: 'parent'});
    const parentItem = f.item(parent, {route: 'agents-folder'}), dependencyItem = f.item(dependency, {dependencyOf: parentItem.itemId});
    await engine.applyPlan(f.plan([parentItem, dependencyItem]));
    assert.equal((await engine.locks.read()).entries.length, 0); await missing(join(route, 'parent'));
    assert.ok((await engine.inventory()).deliveryErrors.some(error => error.code === 'DEPENDENCY_HELD'));
  } finally { await f.close(); }
});

test('corrupt registration state is reported without invoking commands or changing delivered content', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const build = f.build(); await engine.applyPlan(f.plan([f.item(build)]));
    const commandCount = pluginCommands(f.calls).length, folder = f.plugin().folderFor(build);
    await writeFile(join(f.paths.data, 'claude-plugin-registration.json'), 'invalid JSON');
    const restarted = f.restart(); await restarted.reconcile();
    assert.equal((await restarted.inventory()).deliveryErrors[0].code, 'PLUGIN_STATE_INVALID');
    assert.equal(pluginCommands(f.calls).length, commandCount);
    assert.match(await readFile(join(folder, 'SKILL.md'), 'utf8'), /Version 1/u);
  } finally { await f.close(); }
});

test('CLI discovery accepts an executable symlink and runs its resolved absolute path', async () => {
  const f = await fixture();
  try {
    const target = join(f.home, 'bin/real-claude'); await writeFile(target, 'fixture executable'); await chmod(target, 0o700);
    await rm(f.binary); await symlink(target, f.binary);
    assert.equal(await f.plugin().requireCli(), target); assert.equal(f.calls[0].file, target);
  } finally { await f.close(); }
});

for (const step of ['backed_up', 'placed'] as const) test(`registration waits for a pending ${step} update before exposing its new generation`, async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const v1 = f.build(), v2 = f.build(2);
    f.failCommands(true); await engine.applyPlan(f.plan([f.item(v1)])); f.failCommands(false);
    const before = pluginCommands(f.calls).length;
    f.options.crash = where => {if (where === step) throw new Error('Injected crash');};
    await f.engine().applyPlan(f.plan([f.item(v2, {kind: 'update'})]));
    assert.equal(pluginCommands(f.calls).length, before);
    f.options.crash = undefined; const restarted = f.restart(); await restarted.reconcile();
    const registration = await f.json(join(f.paths.data, 'claude-plugin-registration.json'));
    assert.equal(registration.plugins[0].counter, 2); assert.equal(registration.plugins[0].installed, 2);
    assert.equal((await restarted.inventory()).managed[0].state, 'ok');
  } finally { await f.close(); }
});

test('first-install cache watching starts when registration creates the read-copy root', async () => {
  const f = await fixture(true);
  try {
    const controller = new AbortController(), watchers: {path: string; closed: boolean}[] = [];
    f.options.watchRoute = (path, _changed) => {const watcher = {path, closed: false}; watchers.push(watcher); return {close: () => {watcher.closed = true;}};};
    const engine = f.engine(), build = f.build(), readRoot = join(f.home, '.claude/plugins/cache/maddots-ai');
    engine.tick = async () => {
      await mkdir(readRoot, {recursive: true}); await engine.applyPlan(f.plan([f.item(build)])); controller.abort();
    };
    await mkdir(join(f.home, '.claude/projects/p'), {recursive: true});
    await engine.run(controller.signal);
    assert.deepEqual(watchers.filter(watcher => watcher.path.startsWith(join(f.home, '.claude'))).map(watcher => [watcher.path, watcher.closed]), [[readRoot, true]]);
  } finally { await f.close(); }
});

test('registration errors clear in the same process after a timed successful retry', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const build = f.build();
    f.failCommands(true); await engine.applyPlan(f.plan([f.item(build)]));
    assert.ok((await engine.inventory()).deliveryErrors.some(error => error.code === 'COMMAND_FAILED'));
    f.failCommands(false); await f.options.timing!.sleep(60_001); await engine.tick();
    assert.deepEqual((await engine.inventory()).deliveryErrors, []);
    assert.equal((await f.json(join(f.paths.data, 'claude-plugin-registration.json'))).plugins[0].installed, 1);
  } finally { await f.close(); }
});

test('a later successful item cannot register a plugin while another item has a pending journal', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const v1 = f.build(), v2 = f.build(2);
    f.failCommands(true); await engine.applyPlan(f.plan([f.item(v1)])); f.failCommands(false);
    const count = pluginCommands(f.calls).length; let crashed = false;
    f.options.crash = where => {if (where === 'backed_up' && !crashed) {crashed = true; throw new Error('Injected crash');}};
    const other = f.build(1, {skillId: 'skill-beta', workspaceId: 'workspaceB', name: 'other'});
    const mixed = f.engine(); await mixed.applyPlan(f.plan([f.item(v2, {kind: 'update'}), f.item(other)]));
    assert.ok(await mixed.locks.pending(entryKey(v2))); assert.equal(pluginCommands(f.calls).length, count);
    assert.ok((await mixed.inventory()).deliveryErrors.some(error => error.skillId === other.skillId && error.code === 'CLAUDE_PLUGIN_WAITING'));
    f.options.crash = undefined; const restarted = f.restart(); await restarted.reconcile();
    assert.equal((await restarted.inventory()).managed.filter(item => item.state === 'ok').length, 2);
    assert.equal((await f.json(join(f.paths.data, 'claude-plugin-registration.json'))).plugins.length, 2);
  } finally { await f.close(); }
});

test('retrying registration never installs locally edited source content', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const build = f.build();
    f.failCommands(true); await engine.applyPlan(f.plan([f.item(build)])); f.failCommands(false);
    const count = pluginCommands(f.calls).length;
    await writeFile(join(f.plugin().folderFor(build), 'SKILL.md'), 'Local source edit');
    await f.options.timing!.sleep(60_001); await engine.tick();
    const inventory = await engine.inventory();
    assert.equal(inventory.managed[0].state, 'edited');
    assert.ok(inventory.deliveryErrors.some(error => error.code === 'CLAUDE_PLUGIN_EDITED'));
    assert.equal(pluginCommands(f.calls).length, count);
  } finally { await f.close(); }
});

test('failed cache updates are delivery errors for removed skills and do not misreport an old generation as local edits', async () => {
  const f = await fixture(true);
  try {
    const engine = f.engine(); await engine.reconcile(); const v1 = f.build(), v2 = f.build(2);
    await engine.applyPlan(f.plan([f.item(v1)]));
    const copy = await f.plugin().readFolderFor(v1); await mkdir(join(copy, '..'), {recursive: true}); await cp(f.plugin().folderFor(v1), copy, {recursive: true});
    f.failCommands(true); await engine.applyPlan(f.plan([f.item(v2, {kind: 'update'})]));
    assert.equal((await engine.inventory()).managed[0].state, 'missing');
    await engine.applyPlan(f.plan([f.item(v2, {kind: 'forced_remove', state: 'forced', answer: null, reason: 'revoked'})]));
    await missing(f.plugin().folderFor(v2)); assert.equal((await engine.locks.read()).entries[0].removed, true);
    assert.ok((await engine.inventory()).deliveryErrors.some(error => error.code === 'COMMAND_FAILED'));
  } finally { await f.close(); }
});

test('a plan waiting for the CLI stays pollable through tick() and If-None-Match, then delivers', async () => {
  const f = await fixture(false, false);
  try {
    const build = f.build(), current = f.plan([f.item(build)]), sent: (string | undefined)[] = [];
    f.options.client = {request: async (path: string, init: {headers?: Record<string, string>} = {}) => {
      if (path === '/api/helper/plan') {
        sent.push(init.headers?.['If-None-Match']);
        return init.headers?.['If-None-Match'] === current.planRevision
          ? {status: 304, headers: new Headers(), data: undefined}
          : {status: 200, headers: new Headers(), data: structuredClone(current)};
      }
      if (path === '/api/helper/inventory') return {status: 200, headers: new Headers(), data: {}};
      return {status: 200, headers: new Headers(), data: structuredClone(f.builds.get(new URL(path, 'http://x').pathname.slice('/api/helper/builds/'.length)))};
    }} as unknown as Pick<ApiClient, 'request'>;
    const engine = f.engine(); await engine.reconcile();
    await engine.tick();
    assert.equal((await engine.locks.read()).entries.length, 0);
    assert.equal((await engine.inventory()).deliveryErrors[0].code, 'CLAUDE_CLI_MISSING');
    await writeFile(f.binary, 'fixture executable'); await chmod(f.binary, 0o700);
    await f.options.timing!.sleep(61_000); await engine.tick();
    assert.notEqual(sent[1], current.planRevision); // the waiting plan must not be cached as the server ETag
    assert.equal((await engine.locks.read()).entries.length, 1);
    assert.deepEqual((await engine.inventory()).deliveryErrors, []);
    await f.options.timing!.sleep(61_000); await engine.tick();
    assert.equal(sent[2], current.planRevision); // once delivered, the real ETag is cached and the next poll gets 304
  } finally { await f.close(); }
});


test('CLI discovery skips a claude binary whose --version does not match; no plugin command runs on it', async () => {
  const f = await fixture();
  try {
    const other = join(f.home, 'other'), impostor = join(other, 'claude'); await mkdir(other);
    await writeFile(impostor, 'fixture executable'); await chmod(impostor, 0o700);
    const calls: {file: string; args: readonly string[]}[] = [];
    const runner: Runner = async (file, args) => {
      calls.push({file, args: [...args]});
      if (args[0] === '--version') return {stdout: file === impostor ? 'usage: claude-tool [options]' : '2.1.289 (Claude Code)', stderr: ''};
      return {stdout: '', stderr: ''};
    };
    const first = new ClaudePluginDeliveryTarget({...f.adapterOptions, runner, env: {PATH: `${other}:${join(f.home, 'bin')}`}});
    assert.equal(await first.requireCli(), f.binary);
    const alone = new ClaudePluginDeliveryTarget({...f.adapterOptions, runner, env: {PATH: other}});
    const engine = new ClaudePluginSyncEngine(f.options, alone); await engine.reconcile(); const build = f.build();
    await engine.applyPlan(f.plan([f.item(build)]));
    assert.equal((await engine.inventory()).deliveryErrors[0].code, 'CLAUDE_CLI_MISSING');
    assert.equal((await engine.locks.read()).entries.length, 0); await missing(alone.folderFor(build));
    assert.equal(calls.some(call => call.file === impostor && call.args[0] === 'plugin'), false);
    assert.ok(calls.some(call => call.file === impostor && call.args[0] === '--version'));
  } finally { await f.close(); }
});

for (const existing of ['.claude-plugin/marketplace.json', 'maddots-alpha/.claude-plugin/plugin.json'] as const) test(`an existing ${existing} with no registration state is UNMANAGED_CONFLICT and left untouched`, async () => {
  const f = await fixture();
  try {
    const file = join(await f.plugin().root(), existing); await mkdir(join(file, '..'), {recursive: true});
    await writeFile(file, '{"name":"mine"}\n', {mode: 0o600});
    const engine = f.engine(); await engine.reconcile(); await engine.applyPlan(f.plan([f.item(f.build())]));
    assert.ok((await engine.inventory()).deliveryErrors.some(error => error.code === 'UNMANAGED_CONFLICT'));
    assert.equal(await readFile(file, 'utf8'), '{"name":"mine"}\n');
    assert.equal(pluginCommands(f.calls).length, 0);
    assert.equal((await listBackups(f.paths)).filter(backup => backup.reason === 'plugin_metadata').length, 0);
  } finally { await f.close(); }
});

test('an edited plugin.json or marketplace.json is backed up before it is rewritten', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); await engine.applyPlan(f.plan([f.item(f.build())]));
    const root = await f.plugin().root();
    const files = {'plugin.json': join(root, 'maddots-alpha/.claude-plugin/plugin.json'), 'marketplace.json': join(root, '.claude-plugin/marketplace.json')};
    const expected = {'plugin.json': await readFile(files['plugin.json'], 'utf8'), 'marketplace.json': await readFile(files['marketplace.json'], 'utf8')};
    for (const [name, file] of Object.entries(files)) await writeFile(file, `{"edited":"${name}"}\n`);
    await engine.reconcile();
    const saved: string[] = [];
    for (const backup of (await listBackups(f.paths)).filter(backup => backup.reason === 'plugin_metadata')) {
      for (const name of Object.keys(files)) saved.push(await readFile(join(f.paths.backups, backup.id, backup.route, backup.folderName, name), 'utf8').catch(() => ''));
    }
    for (const name of Object.keys(files) as (keyof typeof files)[]) {
      assert.ok(saved.includes(`{"edited":"${name}"}\n`), `${name} edit kept in a backup`);
      assert.equal(await readFile(files[name], 'utf8'), expected[name]);
    }
  } finally { await f.close(); }
});

test('a relative claudePath is refused as PATH_UNSAFE', async () => {
  const f = await fixture();
  try {
    assert.throws(() => new ClaudePluginDeliveryTarget({...f.adapterOptions, claudePath: 'bin/claude'}), {code: 'PATH_UNSAFE'});
  } finally { await f.close(); }
});


for (const source of ['directory', 'git'] as const) test(`a person-owned ${source} marketplace named maddots-ai is never repointed`, async () => {
  const f = await fixture();
  try {
    f.marketplaceList(JSON.stringify([{name: 'maddots-ai', source, path: '/elsewhere'}]));
    const engine = f.engine(); await engine.reconcile(); const build = f.build();
    await engine.applyPlan(f.plan([f.item(build)]));
    assert.deepEqual(pluginCommands(f.calls), []);
    assert.equal((await f.json(join(f.paths.data, 'claude-plugin-registration.json'))).marketplaceAdded, false);
    assert.deepEqual((await engine.inventory()).deliveryErrors.map(error => [error.skillId, error.code]), [[build.skillId, 'UNMANAGED_CONFLICT']]);
    f.marketplaceList('[]'); await engine.reconcile();
    assert.deepEqual(pluginCommands(f.calls).map(call => call.args), f.plugin().commands(build.workspaceId).slice(0, 2));
    assert.deepEqual((await engine.inventory()).deliveryErrors, []);
  } finally { await f.close(); }
});

test('an already registered helper marketplace skips add and still installs the workspace plugin', async () => {
  const f = await fixture();
  try {
    f.marketplaceList(JSON.stringify([{name: 'maddots-ai', source: 'directory', path: await f.plugin().root()}]));
    const engine = f.engine(); await engine.reconcile(); const build = f.build();
    await engine.applyPlan(f.plan([f.item(build)]));
    assert.deepEqual(pluginCommands(f.calls).map(call => call.args), [f.plugin().commands(build.workspaceId)[1]]);
    assert.equal((await f.json(join(f.paths.data, 'claude-plugin-registration.json'))).marketplaceAdded, true);
    assert.deepEqual((await engine.inventory()).deliveryErrors, []);
  } finally { await f.close(); }
});

for (const response of ['invalid JSON', '{}']) test(`an unreadable marketplace list (${response}) refuses mutations and can retry`, async () => {
  const f = await fixture();
  try {
    f.marketplaceList(response);
    const engine = f.engine(); await engine.reconcile(); const build = f.build();
    await engine.applyPlan(f.plan([f.item(build)]));
    assert.deepEqual(pluginCommands(f.calls), []);
    assert.equal((await f.json(join(f.paths.data, 'claude-plugin-registration.json'))).marketplaceAdded, false);
    assert.deepEqual((await engine.inventory()).deliveryErrors.map(error => error.code), ['CLAUDE_PLUGIN_COMMAND_FAILED']);
    f.marketplaceList('[]'); await engine.reconcile();
    assert.deepEqual((await engine.inventory()).deliveryErrors, []);
  } finally { await f.close(); }
});

test('a stuck agents-folder journal cannot prevent Claude marketplace registration', async () => {
  const f = await fixture();
  try {
    const route = join(f.home, '.agents/skills'); await mkdir(route, {recursive: true});
    f.options.targets = [new FolderDeliveryTarget(f.paths, 'agents-folder', route)];
    const folder = f.build(1, {target: 'folder', name: 'folder-example', skillId: 'skill-folder'});
    f.options.crash = where => {if (where === 'staged') throw new Error('Injected crash');};
    await f.engine().applyPlan(f.plan([f.item(folder, {route: 'agents-folder'})]));
    await mkdir(join(route, folder.name)); await writeFile(join(route, folder.name, 'SKILL.md'), 'Unmanaged conflict');
    f.options.crash = undefined; const engine = f.restart(); await engine.reconcile();
    const build = f.build(1, {workspaceId: 'workspaceB', name: 'beta-example', skillId: 'skill-beta'});
    await engine.applyPlan(f.plan([f.item(build)]));
    assert.ok(await engine.locks.pending(entryKey(folder)));
    assert.deepEqual(pluginCommands(f.calls).map(call => call.args), f.plugin().commands(build.workspaceId).slice(0, 2));
    assert.deepEqual((await f.json(join(await f.plugin().root(), '.claude-plugin/marketplace.json'))).plugins.map((plugin: {name: string}) => plugin.name), ['maddots-beta']);
    assert.deepEqual((await engine.inventory()).deliveryErrors.map(error => [error.skillId, error.code]), [[folder.skillId, 'RECOVERY_CONFLICT']]);
  } finally { await f.close(); }
});

for (const change of ['edited', 'missing'] as const) test(`${change === 'edited' ? 'An' : 'A'} ${change} source blocks only its workspace and reports only that entry until replaced`, async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile();
    const alpha = f.build(), sibling = f.build(1, {skillId: 'skill-sibling', name: 'sibling'});
    await engine.applyPlan(f.plan([f.item(alpha), f.item(sibling)]));
    if (change === 'edited') await writeFile(join(f.plugin().folderFor(alpha), 'SKILL.md'), 'Kept local edit');
    else await rm(f.plugin().folderFor(alpha), {recursive: true});
    const alpha2 = f.build(2), beta = f.build(1, {workspaceId: 'workspaceB', skillId: 'skill-beta', name: 'beta-example'});
    const count = pluginCommands(f.calls).length;
    await engine.applyPlan(f.plan([f.item(alpha2, {kind: 'update', state: 'kept_local', answer: 'keep_local'}), f.item(beta)]));
    assert.deepEqual(pluginCommands(f.calls).slice(count).map(call => call.args), [f.plugin().commands(beta.workspaceId)[1]]);
    const root = await f.plugin().root();
    assert.deepEqual((await f.json(join(root, '.claude-plugin/marketplace.json'))).plugins.map((plugin: {name: string; version: string}) => [plugin.name, plugin.version]), [['maddots-alpha', '1.0.1'], ['maddots-beta', '1.0.1']]);
    assert.deepEqual((await engine.inventory()).deliveryErrors.map(error => [error.skillId, error.code]), [[alpha.skillId, change === 'edited' ? 'CLAUDE_PLUGIN_EDITED' : 'CLAUDE_PLUGIN_SOURCE_MISSING']]);
    const beforeReplace = pluginCommands(f.calls).length;
    await engine.applyPlan(f.plan([f.item(alpha2, {kind: 'update', answer: 'replace'})]));
    assert.deepEqual(pluginCommands(f.calls).slice(beforeReplace).map(call => call.args), f.plugin().commands(alpha.workspaceId).slice(2));
    assert.deepEqual((await engine.inventory()).deliveryErrors, []);
  } finally { await f.close(); }
});

test('one failed workspace update does not block another removal, retries back off, and recovery clears only its error', async () => {
  const f = await fixture();
  try {
    const client = f.options.client;
    f.options.client = {request: async (path: string, init: unknown) => path === '/api/helper/plan'
      ? {status: 304, headers: new Headers(), data: undefined} : client.request(path, init as never)} as Pick<ApiClient, 'request'>;
    const engine = f.engine(); await engine.reconcile();
    const alpha = f.build(), beta = f.build(1, {workspaceId: 'workspaceB', skillId: 'skill-beta', name: 'beta-example'});
    await engine.applyPlan(f.plan([f.item(alpha), f.item(beta)]));
    f.failCommand(args => args.join(' ') === 'plugin update maddots-alpha\x40maddots-ai');
    const count = pluginCommands(f.calls).length;
    await engine.applyPlan(f.plan([f.item(f.build(2), {kind: 'update'}), f.item(beta, {kind: 'forced_remove', state: 'forced', answer: null, reason: 'revoked'})]));
    const commands = pluginCommands(f.calls).slice(count).map(call => call.args.join(' '));
    assert.deepEqual(commands, ['plugin marketplace update maddots-ai', 'plugin update maddots-alpha\x40maddots-ai', 'plugin update maddots-beta\x40maddots-ai']);
    const state = await f.json(join(f.paths.data, 'claude-plugin-registration.json'));
    assert.equal(state.plugins[1].installed, state.plugins[1].counter);
    assert.deepEqual((await engine.inventory()).deliveryErrors.map(error => [error.skillId, error.code]), [[alpha.skillId, 'COMMAND_FAILED']]);
    const start = pluginCommands(f.calls).length;
    for (let minute = 0; minute < 10; minute++) { await f.options.timing!.sleep(60_000); await engine.tick(); }
    assert.ok(pluginCommands(f.calls).length - start <= 8, 'failed registrations back off over ten simulated minutes');
    f.failCommand(() => false); await engine.reconcile();
    assert.deepEqual((await engine.inventory()).deliveryErrors, []);
    const recovered = await f.json(join(f.paths.data, 'claude-plugin-registration.json'));
    assert.equal(recovered.plugins[0].installed, recovered.plugins[0].counter);
  } finally { await f.close(); }
});

test('a deliberately uninstalled plugin is reported without update or automatic reinstall on retries', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const alpha = f.build();
    await engine.applyPlan(f.plan([f.item(alpha)])); f.uninstall('maddots-alpha\x40maddots-ai');
    const count = pluginCommands(f.calls).length;
    await engine.applyPlan(f.plan([f.item(f.build(2), {kind: 'update'})]));
    assert.equal(pluginCommands(f.calls).slice(count).some(call => call.args[1] === 'update' || call.args[1] === 'install'), false);
    assert.deepEqual((await engine.inventory()).deliveryErrors.map(error => [error.skillId, error.code]), [[alpha.skillId, 'CLAUDE_PLUGIN_NOT_INSTALLED']]);
    await f.options.timing!.sleep(60_001); await engine.tick();
    assert.equal(pluginCommands(f.calls).slice(count).some(call => call.args[1] === 'install'), false);
  } finally { await f.close(); }
});

test('approved equal-build redelivery repairs a missing read copy once and clears the per-entry error when it returns', async () => {
  const f = await fixture(true);
  try {
    const engine = f.engine(); await engine.reconcile(); const build = f.build(), sibling = f.build(1, {skillId: 'skill-sibling', name: 'sibling'});
    await engine.applyPlan(f.plan([f.item(build), f.item(sibling)]));
    const source = f.plugin().folderFor(build), copy = await f.plugin().readFolderFor(build), siblingCopy = await f.plugin().readFolderFor(sibling);
    await mkdir(join(copy, '..'), {recursive: true}); await cp(source, copy, {recursive: true});
    await cp(f.plugin().folderFor(sibling), siblingCopy, {recursive: true});
    assert.ok((await engine.inventory()).managed.every(item => item.state === 'ok'));
    await rm(copy, {recursive: true}); assert.equal((await engine.inventory()).managed.find(item => item.skillId === build.skillId)!.state, 'missing');
    const count = pluginCommands(f.calls).length;
    await engine.applyPlan(f.plan([f.item(build)]));
    assert.deepEqual(pluginCommands(f.calls).slice(count).map(call => call.args), [f.plugin().commands(build.workspaceId)[1]]);
    assert.deepEqual((await engine.inventory()).deliveryErrors.map(error => [error.skillId, error.code]), [[build.skillId, 'CLAUDE_PLUGIN_READ_COPY_MISSING']]);
    await cp(source, copy, {recursive: true});
    assert.ok((await engine.inventory()).managed.every(item => item.state === 'ok'));
    assert.deepEqual((await engine.inventory()).deliveryErrors, []);
    await engine.applyPlan(f.plan([f.item(build)]));
    assert.equal(pluginCommands(f.calls).length, count + 1);
  } finally { await f.close(); }
});

test('a merged skill changing workspace leaves one live copy, backs up the old workspace, and revokes both copies', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const first = f.build();
    await engine.applyPlan(f.plan([f.item(first, {workspaceIds: ['workspaceA', 'workspaceB']})]));
    const second = f.build(2, {workspaceId: 'workspaceB'}), root = await f.plugin().root();
    await engine.applyPlan(f.plan([f.item(second, {kind: 'update'})]));
    assert.deepEqual(await readdir(join(root, 'maddots-alpha/skills')), []);
    assert.deepEqual(await readdir(join(root, 'maddots-beta/skills')), ['example']);
    const backups = (await listBackups(f.paths)).filter(backup => backup.reason === 'workspace_moved');
    assert.equal(backups.length, 1);
    assert.match(await readFile(join(f.paths.backups, backups[0].id, backups[0].route, backups[0].folderName, 'SKILL.md'), 'utf8'), /Version 1/u);
    assert.equal((await f.json(join(root, 'maddots-alpha/.claude-plugin/plugin.json'))).version, '1.0.2');
    assert.deepEqual((await engine.inventory()).unmanaged, []); assert.deepEqual((await engine.inventory()).deliveryErrors, []);
    await engine.applyPlan(f.plan([f.item(second, {kind: 'forced_remove', state: 'forced', answer: null, reason: 'revoked'})]));
    assert.deepEqual(await readdir(join(root, 'maddots-alpha/skills')), []); assert.deepEqual(await readdir(join(root, 'maddots-beta/skills')), []);
  } finally { await f.close(); }
});

for (const blocked of [false, true]) test(`saved workspace slugs survive restart and revoke the original folder${blocked ? ' after a source-blocked first registration' : ''}`, async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const build = f.build();
    if (blocked) f.options.crash = where => {if (where === 'locked') throw new Error('Injected crash');};
    await (blocked ? f.engine() : engine).applyPlan(f.plan([f.item(build)]));
    f.options.crash = undefined;
    if (blocked) {
      await writeFile(join(f.plugin().folderFor(build), 'SKILL.md'), 'Edited before first registration');
      await engine.reconcile();
      assert.equal((await f.json(join(f.paths.data, 'claude-plugin-registration.json'))).plugins[0].installed, 0);
    }
    const original = f.plugin().folderFor(build);
    const plugin = new ClaudePluginDeliveryTarget({...f.adapterOptions, workspaceSlugs: {workspaceA: 'renamed'}});
    const restarted = new ClaudePluginSyncEngine(f.options, plugin);
    await restarted.applyPlan(f.plan([f.item(build, {kind: 'forced_remove', state: 'forced', answer: null, reason: 'revoked'})]));
    await missing(original); assert.equal((await restarted.locks.read()).entries[0].removed, true);
    assert.equal((await listBackups(f.paths)).filter(backup => backup.folderName === 'example').length, 1);
    const registration = await f.json(join(f.paths.data, 'claude-plugin-registration.json'));
    assert.equal(registration.plugins[0].slug, 'alpha');
    assert.equal((await f.json(join(await plugin.root(), 'maddots-alpha/.claude-plugin/plugin.json'))).version, blocked ? '1.0.1' : '1.0.2');
    assert.deepEqual((await restarted.inventory()).deliveryErrors, []);
  } finally { await f.close(); }
});

test('several skills register once per plan with one generation and one failing attempt', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile();
    const builds = Array.from({length: 5}, (_, index) => f.build(1, {name: `skill-${index}`, skillId: `id-${index}`}));
    await engine.applyPlan(f.plan(builds.map(build => f.item(build))));
    assert.deepEqual(pluginCommands(f.calls).map(call => call.args), f.plugin().commands('workspaceA').slice(0, 2));
    assert.equal((await f.json(join(await f.plugin().root(), 'maddots-alpha/.claude-plugin/plugin.json'))).version, '1.0.1');
    assert.equal((await listBackups(f.paths)).filter(backup => backup.reason === 'plugin_metadata').length, 0);
    f.failCommands(true); const count = f.calls.length;
    await engine.applyPlan(f.plan(builds.map(build => f.item(f.build(2, {name: build.name, skillId: build.skillId}), {kind: 'update'}))));
    assert.equal(f.calls.slice(count).filter(call => call.args[0] === 'plugin').length, 1);
  } finally { await f.close(); }
});

test('a committed first item is registered even when a later build request aborts the plan', async () => {
  const f = await fixture();
  try {
    const first = f.build(), second = f.build(2, {name: 'second', skillId: 'skill-second'}), client = f.options.client;
    f.options.client = {request: async (path: string, init: unknown) => {
      if (new URL(path, 'http://x').pathname === `/api/helper/builds/${second.digest}`) throw new HelperError('TOKEN_REVOKED', 'Injected token failure');
      return client.request(path, init as never);
    }} as Pick<ApiClient, 'request'>;
    const engine = f.engine(); await engine.reconcile();
    await assert.rejects(engine.applyPlan(f.plan([f.item(first), f.item(second)])), {code: 'TOKEN_REVOKED'});
    assert.deepEqual((await engine.locks.read()).entries.map(entry => entry.skillId), [first.skillId]);
    assert.deepEqual(pluginCommands(f.calls).map(call => call.args), f.plugin().commands(first.workspaceId).slice(0, 2));
  } finally { await f.close(); }
});

for (const late of [false, true]) test(`an unsafe read-path ancestor ${late ? 'appearing during sync' : 'at startup'} does not stop other routes`, async () => {
  const f = await fixture(true);
  try {
    const route = join(f.home, '.agents/skills'), dotfiles = join(f.home, 'dotfiles/claude');
    await mkdir(route, {recursive: true}); await mkdir(dotfiles, {recursive: true});
    if (!late) await symlink(dotfiles, join(f.home, '.claude'));
    f.options.targets = [new FolderDeliveryTarget(f.paths, 'agents-folder', route)];
    const watched: string[] = [];
    f.options.watchRoute = path => {watched.push(path); return {close: () => {}};};
    const folder = f.build(1, {target: 'folder', skillId: 'skill-folder', name: 'folder-example'}), plugin = f.build();
    const plan = f.plan([f.item(folder, {route: 'agents-folder'}), f.item(plugin)]);
    f.options.client = {request: async (path: string, init: {headers?: Record<string, string>} = {}) => {
      if (path === '/api/helper/plan') return init.headers?.['If-None-Match'] === plan.planRevision
        ? {status: 304, headers: new Headers(), data: undefined}
        : {status: 200, headers: new Headers(), data: structuredClone(plan)};
      if (path === '/api/helper/inventory') return {status: 200, headers: new Headers(), data: {}};
      return {status: 200, headers: new Headers(), data: structuredClone(f.builds.get(new URL(path, 'http://x').pathname.slice('/api/helper/builds/'.length)))};
    }} as unknown as Pick<ApiClient, 'request'>;
    const controller = new AbortController(), sleep = f.options.timing!.sleep; let ticks = 0;
    f.options.timing!.sleep = async () => {
      if (++ticks === 1 && late) await symlink(dotfiles, join(f.home, '.claude'));
      await sleep(61_000); if (ticks === 3) controller.abort();
    };
    const engine = f.engine(); await engine.run(controller.signal);
    assert.equal(watched.some(path => path.startsWith(join(f.home, '.claude'))), false);
    assert.equal(ticks, 3); assert.match(await readFile(join(route, folder.name, 'SKILL.md'), 'utf8'), /Version 1/u);
    assert.equal((await engine.inventory()).managed.find(item => item.skillId === plugin.skillId)!.state, 'edited');
  } finally { await f.close(); }
});

test('read-copy watcher failures are retried without rejecting registration or the sync loop', async () => {
  const f = await fixture(true);
  try {
    const readRoot = join(f.home, '.claude/plugins/cache/maddots-ai'); await mkdir(readRoot, {recursive: true});
    let attempts = 0, closed = 0;
    f.options.watchRoute = path => {
      if (path === readRoot && ++attempts < 3) throw Object.assign(new Error('Injected watcher limit'), {code: 'ENOSPC'});
      return {close: () => {closed++;}};
    };
    const engine = f.engine(), controller = new AbortController();
    // Release 8 merge: TLS-14 moved the first reconcile from run() into the first tick(); this stand-in tick does the same.
    engine.tick = async () => { await engine.reconcile(); await engine.applyPlan(f.plan([f.item(f.build())])); controller.abort(); };
    await engine.run(controller.signal);
    assert.ok(attempts >= 3); assert.ok(closed >= 1);
    assert.equal((await engine.locks.read()).entries.length, 1);
  } finally { await f.close(); }
});

test('a new workspace slug remains usable for revocation after another workspace blocks registration', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const alpha = f.build();
    await engine.applyPlan(f.plan([f.item(alpha)]));
    await writeFile(join(f.plugin().folderFor(alpha), 'SKILL.md'), 'Sibling workspace edit');
    const beta = f.build(1, {workspaceId: 'workspaceB', skillId: 'skill-beta', name: 'beta-example'});
    await engine.applyPlan(f.plan([f.item(beta)]));
    assert.equal((await engine.locks.read()).entries.length, 2);
    const original = f.plugin().folderFor(beta);
    const plugin = new ClaudePluginDeliveryTarget({...f.adapterOptions, workspaceSlugs: {workspaceA: 'alpha-renamed', workspaceB: 'beta-renamed'}});
    const restarted = new ClaudePluginSyncEngine(f.options, plugin);
    await restarted.applyPlan(f.plan([f.item(beta, {kind: 'forced_remove', state: 'forced', answer: null, reason: 'revoked'})]));
    await missing(original);
    assert.equal((await listBackups(f.paths)).filter(backup => backup.folderName === beta.name).length, 1);
    assert.equal((await f.json(join(await plugin.root(), 'maddots-beta/.claude-plugin/plugin.json'))).version, '1.0.2');
    assert.equal((await restarted.inventory()).deliveryErrors.some(error => error.skillId === beta.skillId), false);
    assert.equal((await restarted.locks.read()).entries.find(entry => entry.skillId === beta.skillId)!.removed, true);
  } finally { await f.close(); }
});

for (const corruption of ['foreign-helper', 'invalid-signature', 'malformed-fields', 'unstamped'] as const) test(`workspace retirement preserves a folder marked ${corruption} with the same skill name`, async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const first = f.build();
    await engine.applyPlan(f.plan([f.item(first)]));
    const root = await f.plugin().root(), foreign = join(root, 'maddots-foreign/skills/example');
    await mkdir(join(foreign, '..'), {recursive: true}); await cp(f.plugin().folderFor(first), foreign, {recursive: true});
    const stampFile = join(foreign, '.maddots/skill.json');
    if (corruption === 'unstamped') await rm(join(foreign, '.maddots'), {recursive: true});
    else {
      const stamp = await f.json(stampFile);
      if (corruption === 'foreign-helper') stamp.helperId = 'another-helper';
      else if (corruption === 'malformed-fields') stamp.workspaceId = null;
      else stamp.signature = Buffer.alloc(64).toString('base64');
      await writeFile(stampFile, JSON.stringify(stamp));
    }
    const before = await readFile(join(foreign, 'SKILL.md'), 'utf8');
    await engine.applyPlan(f.plan([f.item(f.build(2, {workspaceId: 'workspaceB'}), {kind: 'update'})]));
    assert.equal(await readFile(join(foreign, 'SKILL.md'), 'utf8'), before);
    assert.equal((await listBackups(f.paths)).filter(backup => backup.reason === 'workspace_moved').length, 1);
    assert.deepEqual((await engine.inventory()).deliveryErrors, []);
  } finally { await f.close(); }
});

test('a marketplace repointed after installation is checked again before update and recovers without overwriting it', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const first = f.build();
    await engine.applyPlan(f.plan([f.item(first)])); const count = pluginCommands(f.calls).length;
    f.marketplaceList(JSON.stringify([{name: 'maddots-ai', source: 'directory', path: '/elsewhere'}]));
    await engine.applyPlan(f.plan([f.item(f.build(2), {kind: 'update'})]));
    assert.equal(pluginCommands(f.calls).length, count);
    assert.deepEqual((await engine.inventory()).deliveryErrors.map(error => error.code), ['UNMANAGED_CONFLICT']);
    f.marketplaceList(JSON.stringify([{name: 'maddots-ai', source: 'directory', path: await f.plugin().root()}]));
    await engine.reconcile();
    assert.deepEqual(pluginCommands(f.calls).slice(count).map(call => call.args), f.plugin().commands(first.workspaceId).slice(2));
    assert.deepEqual((await engine.inventory()).deliveryErrors, []);
  } finally { await f.close(); }
});

test('a failed shared marketplace update runs once, preserves workspace failures, and permits a new workspace install', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const alpha = f.build(), beta = f.build(1, {workspaceId: 'workspaceB', skillId: 'skill-beta', name: 'beta-example'});
    await engine.applyPlan(f.plan([f.item(alpha), f.item(beta)]));
    f.failCommand(args => args.join(' ') === 'plugin marketplace update maddots-ai');
    const count = pluginCommands(f.calls).length;
    const gamma = f.build(1, {workspaceId: 'gamma', skillId: 'skill-gamma', name: 'gamma-example'});
    await engine.applyPlan(f.plan([f.item(f.build(2), {kind: 'update'}), f.item(beta, {kind: 'forced_remove', state: 'forced', answer: null, reason: 'revoked'}), f.item(gamma)]));
    assert.deepEqual(pluginCommands(f.calls).slice(count).map(call => call.args.join(' ')), ['plugin marketplace update maddots-ai', 'plugin install maddots-gamma\x40maddots-ai']);
    assert.deepEqual((await engine.inventory()).deliveryErrors.map(error => [error.skillId, error.code]).sort(), [[alpha.skillId, 'COMMAND_FAILED'], [beta.skillId, 'COMMAND_FAILED']].sort());
    f.failCommand(() => false); await engine.reconcile();
    assert.deepEqual((await engine.inventory()).deliveryErrors, []);
    assert.ok((await f.json(join(f.paths.data, 'claude-plugin-registration.json'))).plugins.every((plugin: {counter: number; installed: number}) => plugin.counter === plugin.installed));
  } finally { await f.close(); }
});

for (const rejection of ['local-newer-answer', 'invalid-plan', 'held-dependency'] as const) test(`the ${rejection} rejection cannot repair a missing read copy`, async () => {
  const f = await fixture(true);
  try {
    const engine = f.engine(); await engine.reconcile(); const build = f.build();
    await engine.applyPlan(f.plan([f.item(build)]));
    const source = f.plugin().folderFor(build), copy = await f.plugin().readFolderFor(build);
    await mkdir(join(copy, '..'), {recursive: true}); await cp(source, copy, {recursive: true});
    assert.equal((await engine.inventory()).managed[0].state, 'ok');
    await rm(copy, {recursive: true});
    const count = pluginCommands(f.calls).length;
    const item = f.item(build, rejection === 'local-newer-answer' ? {kind: 'local_newer', answer: 'update'} : {});
    const plan = f.plan([item]);
    if (rejection === 'invalid-plan') {
      plan.planRevision = ''; await assert.rejects(engine.applyPlan(plan), {code: 'PLAN_INVALID'});
    } else {
      if (rejection === 'held-dependency') plan.items.push(f.item(f.build(1, {skillId: 'skill-code', name: 'code-dependency', hasCode: true}), {dependencyOf: item.itemId}));
      await engine.applyPlan(plan);
      assert.ok((await engine.inventory()).deliveryErrors.some(error => error.skillId === build.skillId && error.code === (rejection === 'local-newer-answer' ? 'BUILD_ACTION_INVALID' : 'DEPENDENCY_HELD')));
    }
    assert.equal(pluginCommands(f.calls).length, count);
    assert.equal((await engine.inventory()).managed.find(item => item.skillId === build.skillId)!.state, 'missing');
    assert.equal((await f.json(join(f.paths.data, 'claude-plugin-registration.json'))).plugins[0].installed, 1);
  } finally { await f.close(); }
});

test('a missing read-copy repair error survives restart and clears after the copy is restored', async () => {
  const f = await fixture(true);
  try {
    const engine = f.engine(); await engine.reconcile(); const build = f.build();
    await engine.applyPlan(f.plan([f.item(build)]));
    const source = f.plugin().folderFor(build), copy = await f.plugin().readFolderFor(build);
    await mkdir(join(copy, '..'), {recursive: true}); await cp(source, copy, {recursive: true});
    await rm(copy, {recursive: true}); await engine.applyPlan(f.plan([f.item(build)]));
    assert.deepEqual((await engine.inventory()).deliveryErrors.map(error => error.code), ['CLAUDE_PLUGIN_READ_COPY_MISSING']);
    const restarted = f.restart(); await restarted.reconcile();
    assert.deepEqual((await restarted.inventory()).deliveryErrors.map(error => error.code), ['CLAUDE_PLUGIN_READ_COPY_MISSING']);
    await cp(source, copy, {recursive: true});
    assert.equal((await restarted.inventory()).managed[0].state, 'ok');
    assert.deepEqual((await restarted.inventory()).deliveryErrors, []);
    const final = f.restart(); await final.reconcile();
    assert.deepEqual((await final.inventory()).deliveryErrors, []);
  } finally { await f.close(); }
});

test('corrupt slug state prevents forced removal from backing up a guessed workspace folder', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(); await engine.reconcile(); const build = f.build();
    await engine.applyPlan(f.plan([f.item(build)]));
    const original = f.plugin().folderFor(build), guessed = join(await f.plugin().root(), 'maddots-renamed/skills/example');
    await mkdir(guessed, {recursive: true}); await writeFile(join(guessed, 'SKILL.md'), 'Person-owned content');
    await writeFile(join(f.paths.data, 'claude-plugin-registration.json'), 'invalid JSON');
    const plugin = new ClaudePluginDeliveryTarget({...f.adapterOptions, workspaceSlugs: {workspaceA: 'renamed'}});
    const restarted = new ClaudePluginSyncEngine(f.options, plugin);
    await restarted.applyPlan(f.plan([f.item(build, {kind: 'forced_remove', state: 'forced', answer: null, reason: 'revoked'})]));
    assert.match(await readFile(join(original, 'SKILL.md'), 'utf8'), /Version 1/u);
    assert.equal(await readFile(join(guessed, 'SKILL.md'), 'utf8'), 'Person-owned content');
    assert.equal((await listBackups(f.paths)).filter(backup => backup.folderName === build.name).length, 0);
    assert.notEqual((await restarted.locks.read()).entries[0].removed, true);
    assert.ok((await restarted.inventory()).deliveryErrors.some(error => error.code === 'PLUGIN_STATE_INVALID'));
  } finally { await f.close(); }
});
