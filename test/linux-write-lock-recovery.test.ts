import assert from 'node:assert/strict';
import fsPromises, { cp, lstat, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { beginLinuxLockRecovery, inventoryLinuxRecovery, reconcileLinuxRecovery, sealLinuxLockRecovery,
  validateLinuxLockRecovery, verifyLinuxLockRecovery, type LinuxLockRecovery, type RecoveryInventory } from '../src/write-lock-recovery.js';
import type { LinuxRecoveryMask } from '../src/write-lock-retirement.js';

// Boot replacement is strictly a component control. Native acceptance must
// observe distinct kernel boot UUIDs across the founder-approved reboot.
const before = '11111111-1111-4111-8111-111111111111', after = '22222222-2222-4222-8222-222222222222';
const refusal = {code: 'LINUX_LOCK_RETIREMENT_UNVERIFIED'};
const inventory = (): RecoveryInventory => ({installation: '/fixture/helper', data: ['/fixture/data'], writable: ['/fixture/data'], states: ['/fixture/data/state.json'],
  roots: [{root: '/fixture/helper', unpublished: false}], artifacts: [{path: '/fixture/helper/dist/cli.js', sha256: 'a'.repeat(64)}]});
async function component() {
  const masks: LinuxRecoveryMask[] = ['/etc/systemd/system/mdai-helper.service', '/fixture/home/.config/systemd/user/app.maddots.ai.helper.service']
    .map(path => ({path, dev: '1', ino: '2', ctimeNs: '3', parentDev: '4', parentIno: '5', parentMtimeNs: '6', parentCtimeNs: '7'}));
  const state = {boot: before, artifacts: inventory(), masks, entrypoints: [] as boolean[], refuseEntrypoints: false};
  const checks = {boot: async () => state.boot, inventory: async () => structuredClone(state.artifacts), entrypoints: async (postBoot: boolean) => {
    state.entrypoints.push(postBoot); if (state.refuseEntrypoints) throw Object.assign(new Error('old autostart'), refusal);
    return state.masks.map(mask => ({mask: structuredClone(mask)}));
  }};
  const record = await beginLinuxLockRecovery(state.artifacts, undefined, checks.boot);
  return {state, checks, record};
}

test('versioned recovery binds installation, all data roots, artifacts and actual baseline before repair', async () => {
  const f = await component();
  assert.equal(f.record.schemaVersion, 1); assert.equal(f.record.revision, 3);
  assert.equal(f.record.baselineBoot, before); assert.deepEqual(f.record.initial, inventory());
  assert.equal(f.record.seal, undefined); assert.equal(f.record.completion, undefined);
  f.state.artifacts.data.push('/fixture/alternate');
  f.state.artifacts.writable.push('/fixture/alternate');
  f.state.artifacts.states.push('/fixture/alternate/state.json');
  f.state.artifacts.artifacts[0].sha256 = 'b'.repeat(64);
  const saved = structuredClone(f.record);
  assert.deepEqual(await beginLinuxLockRecovery(f.state.artifacts, saved, f.checks.boot), saved, 'retry cannot replace the outstanding baseline');
  f.state.boot = after;
  const restarted = await beginLinuxLockRecovery(f.state.artifacts, saved, f.checks.boot);
  assert.equal(restarted.baselineBoot, before); assert.deepEqual(restarted.initial, saved.initial);
  assert.deepEqual(restarted.windows, [before, after]);
  await assert.rejects(verifyLinuxLockRecovery(restarted, f.checks), refusal, 'patching-only reboot is not a completed seal');
  const sealed = await sealLinuxLockRecovery(restarted, f.checks);
  assert.equal(sealed.seal?.boot, after);
  await assert.rejects(verifyLinuxLockRecovery(sealed, f.checks), refusal, 'new window needs another real reboot');
});

test('begin requires every current data and state root to be registered even when retaining a previous baseline', async () => {
  const f = await component(), saved = structuredClone(f.record);
  for (const current of [
    {...inventory(), data: ['/fixture/data', '/fixture/unregistered']},
    {...inventory(), states: ['/fixture/unregistered/state.json']},
  ]) {
    for (const previous of [undefined, f.record]) {
      await assert.rejects(beginLinuxLockRecovery(current, previous, f.checks.boot), refusal);
    }
  }
  assert.deepEqual(f.record, saved, 'invalid current storage cannot replace or mutate the retained baseline');
});

test('begin records only the global boot ID when same-UID process inspection is unreadable, without granting completion', async t => {
  const bootPath = '/proc/sys/kernel/random/boot_id', opens: string[] = [];
  let inspections = 0, unreadableBoot = false;
  t.mock.method(fsPromises, 'open', (async (path: Parameters<typeof fsPromises.open>[0]) => {
    opens.push(String(path));
    assert.equal(String(path), bootPath, 'begin must not read per-process metadata or images');
    if (unreadableBoot) throw Object.assign(new Error('fixture boot unavailable'), {code: 'EACCES'});
    const bytes = Buffer.from(before + '\n'); let cursor = 0;
    return {
      async read(buffer: Buffer, offset: number, length: number) {
        const bytesRead = bytes.copy(buffer, offset, cursor, cursor + length); cursor += bytesRead;
        return {bytesRead, buffer};
      },
      async close() {},
    };
  }) as typeof fsPromises.open);
  const deniedInspection = async () => {
    inspections++;
    throw Object.assign(new Error('fixture process inspection denied'), {code: 'EACCES'});
  };
  t.mock.method(fsPromises, 'opendir', deniedInspection);
  t.mock.method(fsPromises, 'readlink', deniedInspection);
  syncBuiltinESMExports();
  try {
    const record = await beginLinuxLockRecovery(inventory()), saved = structuredClone(record);
    assert.equal(record.baselineBoot, before); assert.deepEqual(record.windows, [before]);
    assert.deepEqual(record.initial, inventory());
    assert.equal(record.seal, undefined); assert.equal(record.completion, undefined);
    assert.deepEqual(await beginLinuxLockRecovery(inventory(), record), saved);
    await assert.rejects(verifyLinuxLockRecovery(record, {inventory: async () => inventory(),
      entrypoints: async () => assert.fail('an unsealed baseline cannot reach entrypoint verification')}), refusal);
    assert.deepEqual(opens, [bootPath, bootPath, bootPath]);
    assert.equal(inspections, 0, 'begin and an unsealed completion never inspect other same-UID processes');
    unreadableBoot = true;
    await assert.rejects(beginLinuxLockRecovery(inventory()), refusal, 'the global boot ID is still mandatory');
    await assert.rejects(beginLinuxLockRecovery(inventory(), record), refusal, 'retry cannot substitute the saved boot ID');
    assert.deepEqual(record, saved);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('recovery refuses wrong, missing, stale and unversioned proof without admission', async () => {
  const f = await component(); let admitted = 0;
  for (const value of [null, {}, {...f.record, schemaVersion: 2}, {...f.record, revision: 2}, {...f.record, drained: true},
    {...f.record, baselineBoot: 'unknown'}, {...f.record, windows: []}, {...f.record, windows: [before, before]},
    {...f.record, initial: {...f.record.initial, data: ['/relative/../data']}},
    {...f.record, seal: {boot: after, inventory: inventory()}},
    {...f.record, completion: {boot: after, method: 'reboot', inventory: inventory()}}]) {
    assert.throws(() => {validateLinuxLockRecovery(value); admitted++;}, refusal);
  }
  await assert.rejects(verifyLinuxLockRecovery(f.record, f.checks).then(() => {admitted++;}), refusal);
  assert.equal(admitted, 0);
});

test('seal requires matching final hashes, disabled entrypoints and unchanged boot', async () => {
  const f = await component();
  f.state.refuseEntrypoints = true;
  await assert.rejects(sealLinuxLockRecovery(f.record, f.checks), refusal);
  f.state.refuseEntrypoints = false;
  let calls = 0;
  await assert.rejects(sealLinuxLockRecovery(f.record, {...f.checks, inventory: async () => {
    const result = inventory(); if (++calls === 2) result.artifacts[0].sha256 = 'b'.repeat(64); return result;
  }}), refusal);
  await assert.rejects(sealLinuxLockRecovery(f.record, {...f.checks, inventory: async () => {
    f.state.boot = after; return inventory();
  }}), refusal);
  assert.equal(f.record.seal, undefined, 'a candidate or interrupted seal never mutates the saved baseline');
  f.state.boot = before;
  const staged = inventory(); staged.roots.push({root: '/fixture/data/updates/staging-late', unpublished: true});
  await assert.rejects(sealLinuxLockRecovery(f.record, {...f.checks, inventory: async () => staged}), refusal);
});

test('same boot restart, late publication and postboot autostart remain closed; valid proof avoids process image scans', async () => {
  const f = await component(), sealed = await sealLinuxLockRecovery(f.record, f.checks);
  assert.deepEqual(f.state.entrypoints, [false]);
  await assert.rejects(verifyLinuxLockRecovery(sealed, f.checks), refusal);
  f.state.boot = after;
  assert.equal(await verifyLinuxLockRecovery(sealed, f.checks), after);
  assert.deepEqual(f.state.entrypoints, [false, true]);
  f.state.artifacts.artifacts[0].sha256 = 'c'.repeat(64);
  await assert.rejects(verifyLinuxLockRecovery(sealed, f.checks), refusal);
  f.state.artifacts = inventory(); f.state.artifacts.data.push('/fixture/unsealed-root');
  await assert.rejects(verifyLinuxLockRecovery(sealed, f.checks), refusal);
  f.state.artifacts = inventory(); f.state.refuseEntrypoints = true;
  await assert.rejects(verifyLinuxLockRecovery(sealed, f.checks), refusal);
  f.state.refuseEntrypoints = false;
  f.state.masks[0].ctimeNs = '8';
  await assert.rejects(verifyLinuxLockRecovery(sealed, f.checks), refusal, 'unmask/remask cannot hide behind reset systemd timestamps');
  f.state.masks[0].ctimeNs = '3';
  const complete: LinuxLockRecovery = {...sealed, completion: {boot: after, method: 'reboot', inventory: inventory()}};
  validateLinuxLockRecovery(complete);
  await assert.rejects(verifyLinuxLockRecovery(complete, f.checks), refusal, 'completed proof is not replayable as a new recovery');
});

test('inventory checks final package/module bytes and refuses linked or ambiguous storage without deleting retained data', async t => {
  const home = await mkdtemp(join(tmpdir(), 'mdai-recovery-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const root = join(home, 'helper'), data = join(home, 'data');
  await mkdir(join(root, 'dist'), {recursive: true, mode: 0o700}); await mkdir(data, {mode: 0o700});
  await writeFile(join(root, 'package.json'), '{}', {mode: 0o600});
  await writeFile(join(root, 'dist/cli.js'), 'export {};', {mode: 0o600});
  const original = await inventoryLinuxRecovery(root, [data], [{root, unpublished: false}], [data], [join(data, 'state.json')]);
  await writeFile(join(root, 'dist/cli.js'), 'export const late = true;', {mode: 0o600});
  assert.notDeepEqual(await inventoryLinuxRecovery(root, [data], [{root, unpublished: false}], [data], [join(data, 'state.json')]), original);
  const retained = join(data, 'state.json'); await writeFile(retained, '{"retained":true}', {mode: 0o600});
  await reconcileLinuxRecovery([data], [retained]);
  for (const name of ['.publication.tmp', 'staging-late', 'refused-stage-late']) {
    await writeFile(join(data, name), 'uncertain', {mode: 0o600});
    await assert.rejects(reconcileLinuxRecovery([data], [retained]), refusal);
    assert.equal(await readFile(join(data, name), 'utf8'), 'uncertain');
    await rm(join(data, name)); // Isolated fixture cleanup only.
  }
  await mkdir(join(data, 'runner')); await writeFile(join(data, 'runner/active.json'), '[]', {mode: 0o600});
  await assert.rejects(reconcileLinuxRecovery([data], [retained]), refusal, 'a runner snapshot is not journal or external-work proof');
  assert.equal(await readFile(retained, 'utf8'), '{"retained":true}');
  await symlink(join(root, 'dist/cli.js'), join(root, 'dist/alias.js'));
  await assert.rejects(inventoryLinuxRecovery(root, [data], [{root, unpublished: false}], [data], [retained]));
});

test('reconciliation distinguishes only inventoried runtime runner modules from retained runner transactions', async t => {
  const data = await mkdtemp(join(tmpdir(), 'mdai-recovery-module-'));
  t.after(() => rm(data, {recursive: true, force: true}));
  const root = join(data, 'updates/releases', 'a'.repeat(40)), modules = join(root, 'dist/runner');
  await mkdir(modules, {recursive: true, mode: 0o700});
  await writeFile(join(modules, 'signal-gate.js'), 'export {};', {mode: 0o600});
  await writeFile(join(modules, 'signal-gate.d.ts'), 'export {};', {mode: 0o600});
  const roots = [{root, unpublished: false}];
  await assert.rejects(reconcileLinuxRecovery([data], []), refusal, 'a dist suffix alone cannot authorize a module namespace');
  await assert.rejects(reconcileLinuxRecovery([data], [], [{root, unpublished: true}]), refusal);
  await reconcileLinuxRecovery([data], [], roots);
  for (const relative of ['runner/active.json', 'cache/dist/runner/active.json',
    'updates/releases/' + 'b'.repeat(40) + '/dist/runner/active.json',
    'updates/releases/' + 'a'.repeat(40) + '/dist/runner/holding/pending.json']) {
    const file = join(data, relative);
    await mkdir(dirname(file), {recursive: true, mode: 0o700});
    await writeFile(file, 'retained', {mode: 0o600});
    await assert.rejects(reconcileLinuxRecovery([data], [], roots), refusal, relative);
    assert.equal(await readFile(file, 'utf8'), 'retained');
    await rm(file); // Fixture cleanup preserves the now-empty directories.
  }
  const temporary = join(modules, '.publication.tmp');
  await writeFile(temporary, 'unsettled', {mode: 0o600});
  await assert.rejects(reconcileLinuxRecovery([data], [], roots), refusal);
  assert.equal(await readFile(temporary, 'utf8'), 'unsettled'); await rm(temporary);
  const alias = join(modules, 'alias.js'); await symlink(join(modules, 'signal-gate.js'), alias);
  await assert.rejects(reconcileLinuxRecovery([data], [], roots), refusal);
  assert.ok((await lstat(alias)).isSymbolicLink()); await rm(alias);
  await reconcileLinuxRecovery([data], [], roots);
});

test('reconciliation refuses a synced publication before rename in every registered private storage root', async t => {
  const home = await mkdtemp(join(tmpdir(), 'mdai-recovery-storage-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const writable = ['data', 'config', 'state', 'runtime', 'data/cache/builds'].map(name => join(home, name));
  for (const root of writable) await mkdir(root, {recursive: true, mode: 0o700});
  const published = join(writable[2], 'state.json'), contents = '{"retained":"published"}\n';
  await writeFile(published, contents, {mode: 0o600});
  for (const root of writable) {
    const temporary = join(root, '.state.json.11111111-1111-4111-8111-111111111111.tmp');
    const file = await open(temporary, 'wx', 0o600);
    try {await file.writeFile('{"retained":"synced-before-rename"}\n'); await file.sync();}
    finally {await file.close();}
    await assert.rejects(reconcileLinuxRecovery(writable, [published]), refusal);
    assert.equal(await readFile(temporary, 'utf8'), '{"retained":"synced-before-rename"}\n');
    assert.equal(await readFile(published, 'utf8'), contents);
    await rm(temporary); // Isolated crash-cut fixture cleanup only.
  }
  await writeFile(join(writable[1], 'state.json'), 'unrelated private file, never parse as application metadata', {mode: 0o600});
  await reconcileLinuxRecovery(writable, [published]);
});

test('reconciliation admits a real installed production dependency graph in a cached release and still inspects its deepest files', async t => {
  const home = await mkdtemp(join(tmpdir(), 'mdai-recovery-release-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const release = join(home, 'updates/releases', 'a'.repeat(40));
  await mkdir(release, {recursive: true, mode: 0o700});
  const dependencies = {sigstore: '5.0.0', tar: '7.5.22', 'make-fetch-happen': '16.0.1'};
  type Package = {name: string; version: string; dependencies?: Record<string, string>};
  const packageAt = async (name: string, context: string): Promise<{source: string; pkg: Package}> => {
    const require = createRequire(context);
    let source: string;
    try { source = dirname(require.resolve(name + '/package.json')); }
    catch { source = dirname(require.resolve(name)); }
    for (;;) {
      let pkg: Package | undefined;
      try { pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as Package; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (pkg?.name === name) return {source, pkg};
      assert.notEqual(source, dirname(source), `installed package manifest missing for ${name}`);
      source = dirname(source);
    }
  };
  // Copy the actual installed packages, including every runtime dependency,
  // into npm's regular-file layout. Do not substitute empty dependency paths or
  // pnpm symlinks, and do not depend on network/package-manager cache state.
  const versions = new Map<string, string>(Object.entries(dependencies)), copied = new Set<string>();
  const queue: {source: string; target: string; pkg: Package}[] = [];
  const add = async (name: string, context: string, parent: string): Promise<void> => {
    const {source, pkg} = await packageAt(name, context), version = versions.get(name);
    const target = join(version === undefined || version === pkg.version ? release : parent, 'node_modules', name);
    if (copied.has(target)) return;
    if (version === undefined) versions.set(name, pkg.version);
    copied.add(target);
    await cp(source, target, {recursive: true, filter: file => basename(file) !== 'node_modules'});
    queue.push({source, target, pkg});
  };
  for (const [name, version] of Object.entries(dependencies)) {
    assert.equal((await packageAt(name, import.meta.url)).pkg.version, version, 'exercise the pinned release dependency');
    await add(name, import.meta.url, release);
  }
  for (let index = 0; index < queue.length; index++) {
    const {source, target, pkg} = queue[index];
    for (const name of Object.keys(pkg.dependencies ?? {})) await add(name, join(source, 'package.json'), target);
  }
  await writeFile(join(release, 'package.json'), JSON.stringify({name: 'maddots-ai', type: 'module', dependencies}), {mode: 0o600});
  const installed = await import(pathToFileURL(join(release, 'node_modules/sigstore/dist/index.js')).href);
  assert.equal(typeof installed.verify, 'function', 'the copied installed dependency graph freshly imports');
  const generated = join(release, 'node_modules/@sigstore/protobuf-specs/dist/__generated__/google');
  assert.equal((await lstat(generated)).isDirectory(), true);
  assert.ok(queue.length > 50, 'exercise the complete installed runtime graph');
  await reconcileLinuxRecovery([home], []);
  // Crossing the old depth limit must never skip incomplete publications.
  const temporary = join(generated, '.publication.tmp');
  await writeFile(temporary, 'synced before rename', {mode: 0o600});
  await assert.rejects(reconcileLinuxRecovery([home], []), refusal);
  assert.equal(await readFile(temporary, 'utf8'), 'synced before rename');
});

test('reconciliation remains bounded by directory depth and a shared entry budget', async t => {
  const home = await mkdtemp(join(tmpdir(), 'mdai-recovery-budget-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  await mkdir(join(home, ...Array.from({length: 33}, () => 'nested')), {recursive: true, mode: 0o700});
  await assert.rejects(reconcileLinuxRecovery([home], []), refusal);
  let reads = 0, closed = 0;
  t.mock.method(fsPromises, 'opendir', (async () => ({
    async read() { reads++; return {name: `retained-${reads}.json`, isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true}; },
    async close() { closed++; },
  })) as unknown as typeof fsPromises.opendir);
  syncBuiltinESMExports();
  try {
    await assert.rejects(reconcileLinuxRecovery([home], []), refusal);
    assert.equal(reads, 65_537, 'stop without buffering or reading the rest of an oversized directory');
    assert.equal(closed, 1, 'settle the open directory before returning refusal');
  } finally {t.mock.restoreAll(); syncBuiltinESMExports();}
});

test('reconciliation accepts only settled null sync journals in every registered storage root', async t => {
  const home = await mkdtemp(join(tmpdir(), 'mdai-recovery-journals-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const roots = ['data', 'alternate-data'].map(name => join(home, name));
  for (const root of roots) {
    await mkdir(join(root, 'sync-pending'), {recursive: true, mode: 0o700});
    for (const file of [join(root, 'sync-pending.json'), join(root, 'sync-pending', 'a'.repeat(64) + '.json')]) {
      for (const contents of ['{"format":1,"operation":"remove"}', '{invalid', 'false', '{}']) {
        await writeFile(file, contents, {mode: 0o600});
        await assert.rejects(reconcileLinuxRecovery(roots, []), refusal);
        assert.equal(await readFile(file, 'utf8'), contents, 'refusal preserves unresolved or invalid journals');
      }
      await writeFile(file, 'null\n', {mode: 0o600});
      await reconcileLinuxRecovery(roots, []);
    }
  }
});

// Writer inventory: imports/backups/safe-fs, sync/unmanaged-replacement,
// holding, delivery/claude-plugin, notify/agents-local, runner and updater.
// Exercise each independently so a parent intent cannot mask an orphan journal.
const transactionMembers = [
  'imports.json',
  'backups/id/manifest.json', 'backups/id/preserve.json', 'backups/id/restore.json',
  'backups/id/local-import/example.json', 'backups/id/links/0.json',
  'backups/id/managed-original-link.json', 'backups/id/managed-original-link.backup.json',
  'backups/id/links/0.backup.json', 'backups/id/local-import/.restore-' + 'a'.repeat(64) + '.json',
  'backups/id/agents-folder/example/SKILL.md', 'backups/helper-update-id/package.json', 'backups/run-stage/id/skill.md',
  'local-choices/item.replace.json', 'local-choices/item.proposal.json', 'unmanaged-conflicts/item.json',
  'holding/item.json', 'holding/skill/digest/item.json', 'holding-records/archive.json', 'allows/receipt.json',
  'claude-plugin-registration.json', 'claude-plugin-waiting.json',
  'claude-code/.claude-plugin/marketplace.json', 'claude-code/maddots-workspace/.claude-plugin/plugin.json',
  'notification-state.json', 'agent-notification-state.json',
  'staging/id/.maddots/skill.json', 'staging/id/SKILL.md',
  'runner/active.json', 'runner/outcomes/id.json', 'runner/staged/id.json', 'runner/excludes/repository.json',
  'runner/journal-manifest.json', 'runner/journal-head.json', 'runner/journal-0000000001.json',
  'runner/agents.json', 'runner/runs.json', 'runner/agents-catalog.json', 'runner/agent-setup-id/prompt.md',
  'run-homes/id/fixture.txt',
  'updates/current.json', 'updates/rejected.json', 'updates/last-check.json', 'updates/configured-ca.pem',
  'updates/.lock/current.json', 'updates/.lock.guard/current.json', 'updates/releases/current.json',
  'updates/releases/unknown/package.json', 'updates/releases/' + 'a'.repeat(40),
  'updates/staging-id/.artifact.tgz', 'updates/refused-stage-id/package.json',
  '.allow-11111111-1111-4111-8111-111111111111.command',
  '.agent-setup-11111111-1111-4111-8111-111111111111.command',
  '.mdai-publish-11111111-1111-4111-8111-111111111111',
  '.restore-' + 'a'.repeat(64) + '.json',
];
for (const member of transactionMembers) test(`reconciliation refuses retained transaction member ${member} without mutation`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'mdai-recovery-member-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const file = join(root, member), bytes = '{"format":1,"state":"restored","reported":true,"completed":true}\n';
  await mkdir(dirname(file), {recursive: true, mode: 0o700}); await writeFile(file, bytes, {mode: 0o600});
  const before = await lstat(file);
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(reconcileLinuxRecovery([root], []), refusal);
    const after = await lstat(file);
    assert.deepEqual([after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs],
      [before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs]);
    assert.equal(await readFile(file, 'utf8'), bytes, 'terminal-looking or invalid records never certify their external obligations');
  }
});

for (const member of ['backups', 'staging', 'local-choices', 'unmanaged-conflicts', 'holding', 'holding-records', 'allows', 'runner', 'run-homes', 'claude-code', '.claude-plugin', 'updates', 'sync-pending']) {
  test(`reconciliation refuses regular-file replacement of ${member}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'mdai-recovery-type-'));
    t.after(() => rm(root, {recursive: true, force: true}));
    await writeFile(join(root, member), 'null\n', {mode: 0o600});
    await assert.rejects(reconcileLinuxRecovery([root], []), refusal);
  });
}

test('orphan native run receipts refuse without traversing or reading launch and credential material', async t => {
  // Map only the opendir seam to a private fixture. No production run storage
  // is opened and no service identity, root privilege or namespace is needed.
  const root = await mkdtemp(join(tmpdir(), 'mdai-recovery-native-intents-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const native = '/var/lib/mdai/runs', original = fsPromises.opendir, originalStat = fsPromises.lstat;
  t.mock.method(fsPromises, 'lstat', (async (...args: Parameters<typeof originalStat>) => {
    if (String(args[0]) === '/var/lib/mdai' || String(args[0]) === native) throw Object.assign(new Error('isolated service root'), {code: 'ENOENT'});
    return originalStat(...args);
  }) as typeof originalStat);
  t.mock.method(fsPromises, 'opendir', (async (path: Parameters<typeof original>[0]) => {
    assert.equal(path, native, 'refuse at the run root before descending');
    return original(root);
  }) as typeof original);
  syncBuiltinESMExports();
  try {
    for (const member of ['.namespace-' + 'a'.repeat(64) + '.json', '.namespace-' + 'a'.repeat(64) + '.json.complete',
      'incarnation.json', 'launch.json', 'work']) {
      const file = join(root, member); await writeFile(file, 'retained native obligation', {mode: 0o600});
      await assert.rejects(reconcileLinuxRecovery([native], []), refusal);
      assert.equal(await readFile(file, 'utf8'), 'retained native obligation');
      await rm(file); // Only the isolated fixture is reset between cases.
    }
  } finally {t.mock.restoreAll(); syncBuiltinESMExports();}
});
