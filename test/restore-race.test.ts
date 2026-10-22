import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { backupFolder, backupUnmanaged, listBackups, restoreBackup, type BackupManifest } from '../src/backups.js';
import { readConfig } from '../src/config.js';
import { createPaths, ensurePaths } from '../src/paths.js';
import { placeRestoredObject, restoreJournalPath } from '../src/safe-fs.js';

type SavedKind = 'file' | 'symlink';
const checkpoints = ['beforePlace', 'afterIntent', 'afterPlace', 'beforeConsume', 'afterConsume'] as const;
const recoveryCheckpoints = ['afterIntent', 'afterPlace', 'beforeConsume', 'afterConsume'] as const;
const aliasCheckpoints = ['beforeStage', 'beforePreserve', 'afterPreserve', 'beforePlace', 'afterIntent', 'afterPlace', 'beforeConsume', 'afterConsume'] as const;
const originalContents = (kind: SavedKind) => kind === 'file' ? 'Saved A' : 'saved-target';
const replacementContents = (kind: SavedKind) => kind === 'file' ? 'Saved B' : 'replacement-target';
const contents = (path: string, kind: SavedKind) => kind === 'file' ? readFile(path, 'utf8') : readlink(path);

async function privateFixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-restore-race-'));
  const home = join(root, 'home');
  await mkdir(home, {mode: 0o700});
  const paths = await createPaths(readConfig({}, home));
  await ensurePaths(paths);
  return {root, home, paths, close: () => rm(root, {recursive: true, force: true})};
}

async function directoryFixture(withAlias = false) {
  const f = await privateFixture();
  const original = join(f.home, '.codex/skills/original'), managed = join(f.home, '.agents/skills/managed');
  await mkdir(original, {recursive: true});
  await mkdir(managed, {recursive: true});
  await writeFile(join(original, 'SKILL.md'), 'Original directory');
  await writeFile(join(managed, 'SKILL.md'), 'Managed directory');
  const alias = join(f.home, '.codex-work/skills/alias'), target = relative(dirname(alias), original);
  if (withAlias) {
    await mkdir(dirname(alias), {recursive: true});
    await symlink(target, alias);
  }
  const primary = await backupUnmanaged(f.paths, original, {home: '.codex', folderName: 'original'},
    withAlias ? [{home: '.codex-work', folderName: 'alias', target}] : [], Date.now(), undefined, managed);
  return {...f, original, primary, alias, target};
}

async function displacedFixture(kind: SavedKind) {
  const f = await directoryFixture();
  await rename(f.original, join(f.root, 'forwarding-link'));
  await writeFile(f.original, originalContents('file'));
  await restoreBackup(f.paths, f.primary.id);
  let backup: BackupManifest = (await listBackups(f.paths)).find(item => item.reason === 'restore-replaced')!;
  assert.ok(backup?.displaced);
  await rename(f.original, join(f.root, 'returned-directory'));
  if (kind === 'symlink') {
    await symlink(originalContents(kind), f.original);
    await restoreBackup(f.paths, backup.id);
    backup = (await listBackups(f.paths)).find(item => item.id !== backup.id && item.reason === 'restore-replaced')!;
    assert.equal(backup?.displaced?.linkTarget, originalContents(kind));
    await rename(f.original, join(f.root, 'returned-file'));
  }
  const saved = join(f.paths.backups, backup.id, backup.route, backup.folderName);
  const identity = await lstat(saved), backupIds = (await readdir(f.paths.backups)).sort();
  return {...f, backup, saved, identity, backupIds};
}

async function swapSaved(f: Awaited<ReturnType<typeof displacedFixture>>, kind: SavedKind): Promise<Stats> {
  await rename(f.saved, join(f.root, 'retained-A'));
  if (kind === 'file') await writeFile(f.saved, replacementContents(kind));
  else await symlink(replacementContents(kind), f.saved);
  const replacement = await lstat(f.saved);
  assert.notEqual(replacement.ino, f.identity.ino);
  return replacement;
}

async function assertReplacementVisible(f: Awaited<ReturnType<typeof displacedFixture>>, kind: SavedKind, replacement: Stats) {
  assert.equal((await lstat(f.saved)).ino, replacement.ino, 'saved B must retain its own inode');
  assert.equal(await contents(f.saved, kind), replacementContents(kind));
  assert.deepEqual((await listBackups(f.paths)).map(item => item.id), [f.backup.id], 'only saved B remains listed');
  assert.deepEqual((await readdir(f.paths.backups)).sort(), f.backupIds, 'retry must not create a restore-replaced backup of live A');
  await assert.rejects(lstat(f.saved + '.restored'), {code: 'ENOENT'});
}

async function assertConsumedA(source: string, identity: Stats, value: string) {
  const journal = JSON.parse(await readFile(restoreJournalPath(source), 'utf8'));
  assert.equal(journal.state, 'consumed');
  assert.equal(journal.identity.dev, identity.dev);
  assert.equal(journal.identity.ino, identity.ino);
  assert.equal(journal.identity.size, identity.size);
  assert.equal(journal.identity.digest, createHash('sha256').update(value).digest('hex'));
}

for (const kind of ['file', 'symlink'] as const) for (const checkpoint of checkpoints) {
  test(`a saved ${kind} replacement survives an interrupted restore at ${checkpoint}`, async t => {
    const f = await displacedFixture(kind);
    t.after(f.close);
    let replacement: Stats | undefined, calls = 0;
    await assert.rejects(restoreBackup(f.paths, f.backup.id, {path: path => path === f.original ? {
      [checkpoint]: async () => {
        calls++;
        replacement = await swapSaved(f, kind);
        throw new Error('Interrupted after replacing saved A');
      },
    } : {}}), /Interrupted after replacing saved A/);
    assert.equal(calls, 1);
    assert.ok(replacement);
    await assertReplacementVisible(f, kind, replacement);
    if (checkpoint === 'beforePlace' || checkpoint === 'afterIntent') {
      // A was not placed, so B must not be mistaken for the interrupted source.
      await assert.rejects(restoreBackup(f.paths, f.backup.id), {code: 'PATH_CHANGED'});
      await assert.rejects(restoreBackup(f.paths, f.backup.id), {code: 'PATH_CHANGED'});
      await assert.rejects(lstat(f.original), {code: 'ENOENT'});
    } else {
      const placed = await lstat(f.original);
      await restoreBackup(f.paths, f.backup.id);
      await restoreBackup(f.paths, f.backup.id);
      assert.equal((await lstat(f.original)).ino, placed.ino, 'retry must preserve live A instead of replacing it with B');
      assert.equal(await contents(f.original, kind), originalContents(kind));
      await assertConsumedA(f.saved, f.identity, originalContents(kind));
    }
    await assertReplacementVisible(f, kind, replacement);
  });
}

for (const kind of ['file', 'symlink'] as const) for (const checkpoint of recoveryCheckpoints) {
  test(`recovery of placed ${kind} A preserves B when recovery itself stops at ${checkpoint}`, async t => {
    const f = await displacedFixture(kind);
    t.after(f.close);
    await assert.rejects(restoreBackup(f.paths, f.backup.id, {path: path => path === f.original ? {
      afterPlace: async () => {throw new Error('Interrupted after placing A');},
    } : {}}), /Interrupted after placing A/);
    const placed = await lstat(f.original), replacement = await swapSaved(f, kind);
    let calls = 0;
    await assert.rejects(restoreBackup(f.paths, f.backup.id, {path: path => path === f.original ? {
      beforePlace: async () => {assert.fail('recovery must recognize the already placed A');},
      [checkpoint]: async () => {calls++; throw new Error('Interrupted recovery');},
    } : {}}), /Interrupted recovery/);
    assert.equal(calls, 1);
    await assertReplacementVisible(f, kind, replacement);
    assert.equal((await lstat(f.original)).ino, placed.ino);
    await restoreBackup(f.paths, f.backup.id);
    await restoreBackup(f.paths, f.backup.id);
    assert.equal((await lstat(f.original)).ino, placed.ino, 'a second recovery must preserve the original live inode');
    assert.equal(await contents(f.original, kind), originalContents(kind));
    await assertConsumedA(f.saved, f.identity, originalContents(kind));
    await assertReplacementVisible(f, kind, replacement);
  });
}

for (const kind of ['file', 'symlink'] as const) for (const checkpoint of ['afterPlace', 'beforeConsume'] as const) {
  test(`a placed ${kind} A recovers after its saved slot becomes a ${kind === 'file' ? 'symlink' : 'file'} at ${checkpoint}`, async t => {
    const f = await displacedFixture(kind);
    t.after(f.close);
    const replacementKind = kind === 'file' ? 'symlink' : 'file';
    let replacement: Stats | undefined;
    await assert.rejects(restoreBackup(f.paths, f.backup.id, {path: path => path === f.original ? {
      [checkpoint]: async () => {
        replacement = await swapSaved(f, replacementKind);
        throw new Error('Interrupted after changing the saved object type');
      },
    } : {}}), /Interrupted after changing the saved object type/);
    assert.ok(replacement);
    const placed = await lstat(f.original);
    await restoreBackup(f.paths, f.backup.id);
    await restoreBackup(f.paths, f.backup.id);
    assert.equal((await lstat(f.original)).ino, placed.ino);
    assert.equal(await contents(f.original, kind), originalContents(kind));
    await assertConsumedA(f.saved, f.identity, originalContents(kind));
    await assertReplacementVisible(f, replacementKind, replacement);
  });
}

const longNames = [
  ...Array.from({length: 13}, (_, index) => ({label: `${243 + index}-byte ASCII`, name: 'a'.repeat(243 + index)})),
  {label: '255-byte multibyte', name: '界'.repeat(85)},
];

for (const {label, name} of longNames) test(`ordinary backups list and restore a valid ${label} basename`, async t => {
  const f = await privateFixture();
  t.after(f.close);
  const original = join(f.home, '.agents/skills', name);
  await mkdir(original, {recursive: true});
  await writeFile(join(original, 'SKILL.md'), 'Long-name original');
  const identity = await lstat(original);
  const backup = await backupFolder(f.paths, original, 'agents-folder', 'update', null);
  const saved = join(f.paths.backups, backup.id, backup.route, name);
  assert.equal(backup.folderName, name);
  assert.equal(Buffer.byteLength(name), label.startsWith('255') ? 255 : Number.parseInt(label, 10));
  const listed = await listBackups(f.paths);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, backup.id);
  assert.equal(listed[0].attention, undefined, 'a valid backup name must not need attention');
  await restoreBackup(f.paths, backup.id);
  await restoreBackup(f.paths, backup.id);
  assert.equal((await lstat(original)).ino, identity.ino);
  assert.equal(await readFile(join(original, 'SKILL.md'), 'utf8'), 'Long-name original');
  assert.deepEqual(await listBackups(f.paths), []);
  assert.ok(Buffer.byteLength(basename(restoreJournalPath(saved))) <= 255);
  assert.equal(JSON.parse(await readFile(restoreJournalPath(saved), 'utf8')).state, 'consumed');
});

for (const kind of ['file', 'symlink'] as const) for (const name of ['a'.repeat(255), '界'.repeat(85)]) {
  test(`direct ${kind} placement journals a 255-byte ${name.startsWith('a') ? 'ASCII' : 'multibyte'} source basename`, async t => {
    const f = await privateFixture();
    t.after(f.close);
    const source = join(f.paths.backups, name), destination = join(f.home, 'restored');
    if (kind === 'file') await writeFile(source, originalContents(kind));
    else await symlink(originalContents(kind), source);
    const identity = await lstat(source);
    await placeRestoredObject(source, destination);
    const placed = await lstat(destination);
    await placeRestoredObject(source, destination);
    assert.equal((await lstat(destination)).ino, placed.ino);
    assert.equal(await contents(destination, kind), originalContents(kind));
    assert.equal((await lstat(source)).ino, identity.ino);
    await assertConsumedA(source, identity, originalContents(kind));
  });
}

test('a first linked alias restore journals A before atomicSymlink can replace its saved slot with same-target B', async t => {
  const f = await directoryFixture(true);
  t.after(f.close);
  const saved = join(f.paths.backups, f.primary.id, 'links/0'), identity = await lstat(saved);
  const backupIds = (await readdir(f.paths.backups)).sort();
  let replacement: Stats | undefined, calls = 0;
  await restoreBackup(f.paths, f.primary.id, {path: path => path === f.alias ? {
    beforePlace: async () => {
      calls++;
      assert.equal(calls, 1, 'the hook must run during the first exclusive alias placement');
      await rename(saved, join(f.root, 'retained-alias-A'));
      await symlink(f.target, saved);
      replacement = await lstat(saved);
    },
  } : {}});
  assert.equal(calls, 1);
  assert.ok(replacement);
  assert.notEqual(replacement.ino, identity.ino);
  const placed = await lstat(f.alias);
  await restoreBackup(f.paths, f.primary.id);
  await restoreBackup(f.paths, f.primary.id);
  assert.equal((await lstat(f.alias)).ino, placed.ino);
  assert.equal(await readlink(f.alias), f.target);
  assert.equal((await lstat(saved)).ino, replacement.ino);
  assert.equal(await readlink(saved), f.target);
  assert.deepEqual((await listBackups(f.paths)).map(item => item.id), [f.primary.id], 'same-target saved B must remain visible');
  assert.deepEqual((await readdir(f.paths.backups)).sort(), backupIds);
  await assertConsumedA(saved, identity, f.target);
  await assert.rejects(lstat(saved + '.restored'), {code: 'ENOENT'});
});

for (const checkpoint of aliasCheckpoints) test(`an interrupted linked alias restore preserves same-target B at ${checkpoint}`, async t => {
  const f = await directoryFixture(true);
  t.after(f.close);
  const saved = join(f.paths.backups, f.primary.id, 'links/0'), identity = await lstat(saved);
  const backupIds = (await readdir(f.paths.backups)).sort();
  let replacement: Stats | undefined, calls = 0;
  await assert.rejects(restoreBackup(f.paths, f.primary.id, {path: path => path === f.alias ? {
    [checkpoint]: async () => {
      calls++;
      await rename(saved, join(f.root, 'retained-alias-A'));
      await symlink(f.target, saved);
      replacement = await lstat(saved);
      throw new Error('Interrupted after replacing saved alias A');
    },
  } : {}}), /Interrupted after replacing saved alias A/);
  assert.equal(calls, 1);
  assert.ok(replacement);
  assert.notEqual(replacement.ino, identity.ino);
  const placed = await lstat(f.alias).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (checkpoint === 'afterPlace' || checkpoint === 'beforeConsume' || checkpoint === 'afterConsume') {
    assert.ok(placed);
    await restoreBackup(f.paths, f.primary.id);
    await restoreBackup(f.paths, f.primary.id);
    assert.equal((await lstat(f.alias)).ino, placed.ino, 'recovery must keep the already restored alias inode');
    assert.equal(await readlink(f.alias), f.target);
    await assertConsumedA(saved, identity, f.target);
  } else {
    await assert.rejects(restoreBackup(f.paths, f.primary.id), {code: 'PATH_CHANGED'});
    await assert.rejects(restoreBackup(f.paths, f.primary.id), {code: 'PATH_CHANGED'});
    if (placed) assert.equal((await lstat(f.alias)).ino, placed.ino, 'rejected recovery must preserve the live occupant');
    else await assert.rejects(lstat(f.alias), {code: 'ENOENT'});
    const journal = JSON.parse(await readFile(restoreJournalPath(saved), 'utf8'));
    assert.equal(journal.state, 'placing');
    assert.equal(journal.identity.ino, identity.ino, 'recovery must not journal B as the original alias');
  }
  assert.equal((await lstat(saved)).ino, replacement.ino);
  assert.equal(await readlink(saved), f.target);
  assert.deepEqual((await listBackups(f.paths)).map(item => item.id), [f.primary.id]);
  assert.deepEqual((await readdir(f.paths.backups)).sort(), backupIds, 'alias recovery must not create backups of restored A');
  await assert.rejects(lstat(saved + '.restored'), {code: 'ENOENT'});
});

for (const checkpoint of aliasCheckpoints) test(`an unchanged linked alias resumes idempotently after ${checkpoint}`, async t => {
  const f = await directoryFixture(true);
  t.after(f.close);
  const saved = join(f.paths.backups, f.primary.id, 'links/0'), identity = await lstat(saved);
  const originalDirectory = await lstat(join(f.paths.backups, f.primary.id, f.primary.route, f.primary.folderName));
  const backupIds = (await readdir(f.paths.backups)).sort();
  let calls = 0;
  await assert.rejects(restoreBackup(f.paths, f.primary.id, {path: path => path === f.alias ? {
    [checkpoint]: async () => {calls++; throw new Error('Interrupted unchanged alias');},
  } : {}}), /Interrupted unchanged alias/);
  assert.equal(calls, 1);
  const placed = checkpoint === 'afterPlace' || checkpoint === 'beforeConsume' || checkpoint === 'afterConsume'
    ? await lstat(f.alias) : undefined;
  await restoreBackup(f.paths, f.primary.id);
  const restored = await lstat(f.alias);
  if (placed) assert.equal(restored.ino, placed.ino);
  await restoreBackup(f.paths, f.primary.id);
  assert.equal((await lstat(f.alias)).ino, restored.ino);
  assert.equal(await readlink(f.alias), f.target);
  assert.equal((await lstat(f.original)).ino, originalDirectory.ino);
  assert.equal(await readFile(join(f.original, 'SKILL.md'), 'utf8'), 'Original directory');
  assert.equal((await lstat(saved)).ino, identity.ino);
  await assertConsumedA(saved, identity, f.target);
  assert.deepEqual(await listBackups(f.paths), []);
  assert.deepEqual((await readdir(f.paths.backups)).sort(), backupIds);
});
