import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { backupUnmanaged, finishUnmanagedBackup, listBackups, restoreBackup, type BackupManifest } from '../src/backups.js';
import { readConfig } from '../src/config.js';
import { createPaths, ensurePaths } from '../src/paths.js';
import { restoreJournalPath } from '../src/safe-fs.js';

async function directoryFixture(withAlias = false, linked = true) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-restore-consumed-'));
  const home = join(root, 'home');
  await mkdir(home, {mode: 0o700});
  const paths = await createPaths(readConfig({}, home));
  await ensurePaths(paths);
  const original = join(home, '.codex/skills/original'), managed = join(home, '.agents/skills/managed');
  await mkdir(original, {recursive: true}); await mkdir(managed, {recursive: true});
  await writeFile(join(original, 'SKILL.md'), 'Original directory');
  await writeFile(join(managed, 'SKILL.md'), 'Managed directory');
  const alias = join(home, '.codex-work/skills/alias'), target = relative(dirname(alias), original);
  if (withAlias) {
    await mkdir(dirname(alias), {recursive: true});
    await symlink(target, alias);
  }
  const primary = await backupUnmanaged(paths, original, {home: '.codex', folderName: 'original'},
    withAlias ? [{home: '.codex-work', folderName: 'alias', target}] : [], Date.now(), undefined, linked ? managed : undefined);
  return {root, home, paths, original, primary, alias, target, close: () => rm(root, {recursive: true, force: true})};
}

async function fixture(kind: 'file' | 'symlink' = 'file') {
  const f = await directoryFixture();
  const {root, paths, original, primary} = f;
  await rename(original, join(root, 'forwarding-link'));
  await writeFile(original, 'Saved A');
  await restoreBackup(paths, primary.id);
  let backup: BackupManifest = (await listBackups(paths)).find(item => item.reason === 'restore-replaced')!;
  assert.ok(backup?.displaced);
  await rename(original, join(root, 'returned-directory'));
  if (kind === 'symlink') {
    await symlink('saved-target', original);
    await restoreBackup(paths, backup.id);
    backup = (await listBackups(paths)).find(item => item.id !== backup.id && item.reason === 'restore-replaced')!;
    assert.equal(backup?.displaced?.linkTarget, 'saved-target');
    await rename(original, join(root, 'returned-file'));
  }
  const saved = join(paths.backups, backup.id, backup.route, backup.folderName);
  return {...f, backup, saved};
}

for (const kind of ['file', 'symlink'] as const) test(`restore retains a replacement ${kind} arriving after the last source check`, async () => {
  const f = await fixture(kind);
  try {
    const identity = await lstat(f.saved);
    let replacementInode = 0;
    await restoreBackup(f.paths, f.backup.id, {path: path => path === f.original ? {
      beforeConsume: async () => {
        await rename(f.saved, join(f.root, 'saved-before-swap'));
        if (kind === 'file') await writeFile(f.saved, 'Saved B');
        else await symlink('other-target', f.saved);
        replacementInode = (await lstat(f.saved)).ino;
      },
    } : {}});
    assert.notEqual(replacementInode, identity.ino);
    assert.equal((await lstat(f.saved)).ino, replacementInode);
    if (kind === 'file') {
      assert.equal(await readFile(f.original, 'utf8'), 'Saved A');
      assert.equal(await readFile(f.saved, 'utf8'), 'Saved B');
    } else {
      assert.equal(await readlink(f.original), 'saved-target');
      assert.equal(await readlink(f.saved), 'other-target');
    }
    const listed = (await listBackups(f.paths)).find(item => item.id === f.backup.id);
    assert.ok(listed, 'the different saved object must remain visible');
    assert.equal((await lstat(f.saved)).ino, replacementInode, 'listing must preserve the replacement inode');
    const journal = JSON.parse(await readFile(restoreJournalPath(f.saved), 'utf8'));
    assert.equal(journal.state, 'consumed');
    assert.equal(journal.identity.dev, identity.dev);
    assert.equal(journal.identity.ino, identity.ino);
    assert.equal(journal.identity.size, identity.size);
    assert.equal(journal.identity.digest, createHash('sha256').update(kind === 'file' ? 'Saved A' : 'saved-target').digest('hex'));
  } finally {await f.close();}
});

for (const kind of ['file', 'symlink'] as const) test(`a different saved ${kind} with identical content is not hidden as consumed`, async () => {
  const f = await fixture(kind);
  try {
    await restoreBackup(f.paths, f.backup.id);
    assert.deepEqual(await listBackups(f.paths), []);
    const consumed = await lstat(f.saved);
    await rename(f.saved, join(f.root, 'consumed-source'));
    if (kind === 'file') await writeFile(f.saved, 'Saved A');
    else await symlink('saved-target', f.saved);
    assert.notEqual((await lstat(f.saved)).ino, consumed.ino);
    assert.ok((await listBackups(f.paths)).some(item => item.id === f.backup.id));
    assert.equal(kind === 'file' ? await readFile(f.original, 'utf8') : await readlink(f.original), kind === 'file' ? 'Saved A' : 'saved-target');
  } finally {await f.close();}
});

test('a same-inode same-size edit to a consumed saved file is visible through its content digest', async () => {
  const f = await fixture();
  try {
    await restoreBackup(f.paths, f.backup.id);
    assert.deepEqual(await listBackups(f.paths), []);
    const before = await lstat(f.saved);
    await writeFile(f.saved, 'Saved B');
    const after = await lstat(f.saved);
    assert.equal(after.ino, before.ino); assert.equal(after.size, before.size);
    assert.ok((await listBackups(f.paths)).some(item => item.id === f.backup.id));
    assert.equal(await readFile(f.saved, 'utf8'), 'Saved B');
  } finally {await f.close();}
});

for (const kind of ['file', 'symlink'] as const)
  for (const checkpoint of ['afterIntent', 'beforePlace', 'afterPlace', 'beforeConsume', 'afterConsume'] as const)
    test(`a ${kind} restore retries idempotently after interruption at ${checkpoint}`, async () => {
      const f = await fixture(kind);
      try {
        let calls = 0;
        await assert.rejects(restoreBackup(f.paths, f.backup.id, {path: path => path === f.original ? {
          [checkpoint]: async () => {calls++; throw new Error('Interrupted restore');},
        } : {}}), /Interrupted restore/);
        assert.equal(calls, 1);
        const before = await lstat(f.original).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw error;
        });
        await restoreBackup(f.paths, f.backup.id);
        const placed = await lstat(f.original);
        if (before) assert.equal(placed.ino, before.ino, 'retry must keep the already placed destination');
        await restoreBackup(f.paths, f.backup.id);
        assert.equal((await lstat(f.original)).ino, placed.ino);
        assert.equal(kind === 'file' ? await readFile(f.original, 'utf8') : await readlink(f.original), kind === 'file' ? 'Saved A' : 'saved-target');
        assert.deepEqual(await listBackups(f.paths), [], 'retry must not create additional backups');
        assert.ok(await lstat(f.saved), 'the consumed source remains retained');
      } finally {await f.close();}
    });

for (const change of ['removed source', 'removed destination', 'new destination'] as const)
  test(`a completed restore retry preserves later changes: ${change}`, async () => {
    const f = await fixture();
    try {
      await restoreBackup(f.paths, f.backup.id);
      if (change === 'removed source') await rm(f.saved);
      else {
        await rm(f.original);
        if (change === 'new destination') await writeFile(f.original, 'Later user file');
      }
      await restoreBackup(f.paths, f.backup.id);
      await restoreBackup(f.paths, f.backup.id);
      if (change === 'removed destination') await assert.rejects(lstat(f.original), {code: 'ENOENT'});
      else assert.equal(await readFile(f.original, 'utf8'), change === 'new destination' ? 'Later user file' : 'Saved A');
      assert.deepEqual(await listBackups(f.paths), []);
    } finally {await f.close();}
  });

for (const kind of ['file', 'symlink'] as const) test(`an interrupted ${kind} placement resumes after the saved source disappears`, async () => {
  const f = await fixture(kind);
  try {
    await assert.rejects(restoreBackup(f.paths, f.backup.id, {path: path => path === f.original ? {
      afterPlace: async () => {await rm(f.saved); throw new Error('Interrupted after source removal');},
    } : {}}), /Interrupted after source removal/);
    const placed = await lstat(f.original);
    await restoreBackup(f.paths, f.backup.id);
    await restoreBackup(f.paths, f.backup.id);
    assert.equal((await lstat(f.original)).ino, placed.ino);
    assert.equal(kind === 'file' ? await readFile(f.original, 'utf8') : await readlink(f.original), kind === 'file' ? 'Saved A' : 'saved-target');
    assert.deepEqual(await listBackups(f.paths), []);
    assert.equal(JSON.parse(await readFile(restoreJournalPath(f.saved), 'utf8')).state, 'consumed');
  } finally {await f.close();}
});

for (const checkpoint of ['afterIntent', 'beforePlace', 'afterPlace', 'beforeConsume', 'afterConsume'] as const)
  test(`a linked primary directory restore completes its journal after interruption at ${checkpoint}`, async () => {
    const f = await directoryFixture();
    try {
      const saved = join(f.paths.backups, f.primary.id, f.primary.route, f.primary.folderName), before = await lstat(saved);
      await assert.rejects(restoreBackup(f.paths, f.primary.id, {path: path => path === f.original ? {
        [checkpoint]: async () => {throw new Error('Interrupted primary restore');},
      } : {}}), /Interrupted primary restore/);
      await restoreBackup(f.paths, f.primary.id);
      await restoreBackup(f.paths, f.primary.id);
      assert.equal((await lstat(f.original)).ino, before.ino);
      assert.equal(await readFile(join(f.original, 'SKILL.md'), 'utf8'), 'Original directory');
      assert.equal(JSON.parse(await readFile(restoreJournalPath(saved), 'utf8')).state, 'consumed');
      assert.deepEqual(await listBackups(f.paths), []);
    } finally {await f.close();}
  });

for (const kind of ['file', 'same-target symlink'] as const)
  test(`a restored alias retains and exposes a ${kind} replacing its saved snapshot`, async () => {
    const f = await directoryFixture(true);
    try {
      const saved = join(f.paths.backups, f.primary.id, 'links/0'), before = await lstat(saved);
      let replacementInode = 0;
      await restoreBackup(f.paths, f.primary.id, {path: path => path === f.alias ? {
        beforeConsume: async () => {
          await rename(saved, join(f.root, 'alias-before-swap'));
          if (kind === 'file') await writeFile(saved, 'New saved-slot file');
          else await symlink(f.target, saved);
          replacementInode = (await lstat(saved)).ino;
        },
      } : {}});
      assert.notEqual(replacementInode, before.ino);
      assert.equal((await lstat(saved)).ino, replacementInode);
      assert.equal(await readlink(f.alias), f.target);
      const listed = (await listBackups(f.paths)).find(item => item.id === f.primary.id);
      assert.ok(listed, 'a different object in the consumed alias slot remains visible');
      if (kind === 'file') {
        assert.ok(listed.attention, 'the incompatible saved alias needs attention');
        assert.equal(await readFile(saved, 'utf8'), 'New saved-slot file');
      } else assert.equal(await readlink(saved), f.target);
      assert.equal((await lstat(saved)).ino, replacementInode);
      await assert.rejects(lstat(saved + '.restored'), {code: 'ENOENT'});
    } finally {await f.close();}
  });

test('a legacy unmanaged backup cannot replay completed restore snapshots', async () => {
  const f = await directoryFixture(true, false);
  try {
    await restoreBackup(f.paths, f.primary.id);
    const original = await lstat(f.original), alias = await lstat(f.alias);
    await assert.rejects(finishUnmanagedBackup(f.paths, f.primary.id), {code: 'BACKUP_RESTORED'});
    assert.equal((await lstat(f.original)).ino, original.ino);
    assert.equal((await lstat(f.alias)).ino, alias.ino);
    assert.equal(await readFile(join(f.original, 'SKILL.md'), 'utf8'), 'Original directory');
    assert.deepEqual(await listBackups(f.paths), []);
  } finally {await f.close();}
});

for (const linked of [false, true]) test(`a ${linked ? 'linked' : 'legacy'} alias finishes its placing journal when its saved snapshot disappeared after placement`, async () => {
  const f = await directoryFixture(true, linked);
  try {
    const saved = join(f.paths.backups, f.primary.id, 'links/0');
    await assert.rejects(restoreBackup(f.paths, f.primary.id, {path: path => path === f.alias ? {
      afterPlace: async () => {await rm(saved); throw new Error('Interrupted alias after source removal');},
    } : {}}), /Interrupted alias after source removal/);
    const placed = await lstat(f.alias);
    await restoreBackup(f.paths, f.primary.id);
    await restoreBackup(f.paths, f.primary.id);
    assert.equal((await lstat(f.alias)).ino, placed.ino);
    assert.equal(await readlink(f.alias), f.target);
    assert.equal(JSON.parse(await readFile(restoreJournalPath(saved), 'utf8')).state, 'consumed');
    assert.deepEqual(await listBackups(f.paths), []);
  } finally {await f.close();}
});
