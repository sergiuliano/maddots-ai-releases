import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { backupUnmanaged, finishUnmanagedBackup, listBackups, readBackupManifest, restoreBackup, type BackupManifest } from '../src/backups.js';
import { readConfig } from '../src/config.js';
import { atomicWrite, createPaths, ensurePaths } from '../src/paths.js';
import { atomicSymlink, preserveSymlink } from '../src/safe-fs.js';

async function fixture(outer = false) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-import-backups-'));
  const home = join(root, 'home');
  await mkdir(home, {mode: 0o700});
  const paths = await createPaths(readConfig({}, home));
  await ensurePaths(paths);
  const codex = join(home, '.codex/skills'), other = join(home, '.codex-work/skills');
  await mkdir(codex, {recursive: true}); await mkdir(other, {recursive: true});
  const source = join(home, outer ? '.codex-client/skills/example' : '.codex/skills/example');
  await mkdir(source, {recursive: true}); await writeFile(join(source, 'SKILL.md'), 'Original');
  const ref = {home: '.codex', folderName: 'example'};
  const links = [{home: '.codex-work', folderName: 'alias', target: outer ? '../../.codex-client/skills/example' : '../../.codex/skills/example'}];
  if (outer) {
    links.unshift({...ref, target: '../../.codex-client/skills/example'});
    await symlink(links[0].target, join(codex, ref.folderName));
  }
  await symlink(links.at(-1)!.target, join(other, 'alias'));
  return {root, home, paths, source, ref, links, codex, other, close: () => rm(root, {recursive: true, force: true})};
}
const absent = (path: string) => assert.rejects(lstat(path), {code: 'ENOENT'});
const saved = (paths: {backups: string}, backup: BackupManifest) => join(paths.backups, backup.id, backup.route, backup.folderName);

async function gitWorktreeFixture() {
  const f = await fixture();
  const repo = join(f.home, 'Projects/georanker'), source = join(repo, 'skills/ai-discovery');
  await mkdir(join(repo, '.git'), {recursive: true});
  await mkdir(source, {recursive: true});
  await writeFile(join(source, 'SKILL.md'), 'Repository original');
  const ref = {home: '.codex', folderName: 'ai-discovery'};
  const links = [ref, {home: '.codex-work', folderName: 'ai-discovery'}]
    .map(link => ({...link, target: '../../Projects/georanker/skills/ai-discovery'}));
  const linkPaths = [join(f.codex, ref.folderName), join(f.other, ref.folderName)];
  for (const [index, path] of linkPaths.entries()) await symlink(links[index].target, path);
  return {...f, source, ref, links, linkPaths};
}

test('links into a Git work tree back up only tool-home link inodes and restore without moving the target', async () => {
  const f = await gitWorktreeFixture();
  try {
    const sourceInode = (await lstat(f.source)).ino;
    const linkInodes = await Promise.all(f.linkPaths.map(async path => (await lstat(path)).ino));
    const manifest = await backupUnmanaged(f.paths, f.source, f.ref, f.links);
    assert.deepEqual(manifest.unmanaged, {original: f.ref, links: f.links, keepOriginal: true});
    assert.equal((await lstat(f.source)).ino, sourceInode);
    assert.equal(await readFile(join(f.source, 'SKILL.md'), 'utf8'), 'Repository original');
    await absent(saved(f.paths, manifest));
    for (const [index, path] of f.linkPaths.entries()) {
      await absent(path);
      const link = join(f.paths.backups, manifest.id, 'links', String(index));
      assert.equal((await lstat(link)).ino, linkInodes[index]);
      assert.equal(await readlink(link), f.links[index].target);
    }
    assert.deepEqual((await listBackups(f.paths)).map(item => item.id), [manifest.id]);
    await restoreBackup(f.paths, manifest.id);
    assert.equal((await lstat(f.source)).ino, sourceInode);
    assert.equal(await readFile(join(f.source, 'SKILL.md'), 'utf8'), 'Repository original');
    for (const [index, path] of f.linkPaths.entries()) {
      assert.ok((await lstat(path)).isSymbolicLink());
      assert.equal(await readlink(path), f.links[index].target);
    }
    assert.deepEqual(await listBackups(f.paths), []);
  } finally {await f.close();}
});

test('link-only backups resume interrupted backup and restore while keeping the Git work tree intact', async () => {
  const f = await gitWorktreeFixture();
  try {
    const sourceInode = (await lstat(f.source)).ino;
    let manifest: BackupManifest | undefined;
    await assert.rejects(backupUnmanaged(f.paths, f.source, f.ref, f.links, Date.now(), async backup => {
      manifest = backup;
      assert.equal(backup.unmanaged?.keepOriginal, true);
      assert.deepEqual(JSON.parse(await readFile(join(f.paths.backups, backup.id, 'manifest.json'), 'utf8')), backup);
      throw new Error('Interrupted');
    }), /Interrupted/);
    assert.ok(manifest);
    assert.deepEqual(await listBackups(f.paths), []);
    await rename(f.linkPaths[0], join(f.paths.backups, manifest.id, 'links/0'));
    assert.deepEqual((await listBackups(f.paths)).map(item => item.id), [manifest.id]);
    await finishUnmanagedBackup(f.paths, manifest.id);
    await finishUnmanagedBackup(f.paths, manifest.id);
    for (const path of f.linkPaths) await absent(path);
    await rename(join(f.paths.backups, manifest.id, 'links/0'), f.linkPaths[0]);
    assert.deepEqual((await listBackups(f.paths)).map(item => item.id), [manifest.id]);
    await restoreBackup(f.paths, manifest.id);
    assert.equal((await lstat(f.source)).ino, sourceInode);
    assert.equal(await readFile(join(f.source, 'SKILL.md'), 'utf8'), 'Repository original');
    for (const [index, path] of f.linkPaths.entries()) assert.equal(await readlink(path), f.links[index].target);
    assert.deepEqual(await listBackups(f.paths), []);
  } finally {await f.close();}
});

test('link-only restore preserves target edits and backs up an occupied tool-home destination', async () => {
  const f = await gitWorktreeFixture();
  try {
    const sourceInode = (await lstat(f.source)).ino;
    const manifest = await backupUnmanaged(f.paths, f.source, f.ref, f.links);
    await writeFile(join(f.source, 'SKILL.md'), 'Repository edits');
    await writeFile(f.linkPaths[0], 'New local file');
    await restoreBackup(f.paths, manifest.id);
    assert.equal((await lstat(f.source)).ino, sourceInode);
    assert.equal(await readFile(join(f.source, 'SKILL.md'), 'utf8'), 'Repository edits');
    for (const [index, path] of f.linkPaths.entries()) assert.equal(await readlink(path), f.links[index].target);
    const backups = await listBackups(f.paths);
    assert.equal(backups.length, 1);
    assert.equal(backups[0].reason, 'restore-replaced');
    assert.equal(backups[0].originalPath, '.codex/skills/ai-discovery');
    assert.equal(await readFile(saved(f.paths, backups[0]), 'utf8'), 'New local file');
  } finally {await f.close();}
});

for (const outer of [false, true]) test(`unmanaged backup restores source and cross-Codex links, outer source ${outer}`, async () => {
  const f = await fixture(outer);
  try {
    const sourceInode = (await lstat(f.source)).ino;
    const linkInode = (await lstat(join(f.other, 'alias'))).ino;
    const manifest = await backupUnmanaged(f.paths, f.source, f.ref, f.links);
    assert.deepEqual(manifest.unmanaged, {original: f.ref, links: f.links});
    await absent(f.source); await absent(join(f.other, 'alias'));
    assert.equal((await lstat(saved(f.paths, manifest))).ino, sourceInode);
    assert.equal((await lstat(join(f.paths.backups, manifest.id, 'links', String(f.links.length - 1)))).ino, linkInode);
    assert.deepEqual((await listBackups(f.paths)).map(item => item.id), [manifest.id]);
    await restoreBackup(f.paths, manifest.id);
    assert.equal(await readFile(join(f.source, 'SKILL.md'), 'utf8'), 'Original');
    assert.equal((await lstat(f.source)).ino, sourceInode);
    assert.ok((await lstat(join(f.other, 'alias'))).isSymbolicLink());
    assert.equal(await readlink(join(f.other, 'alias')), f.links.at(-1)!.target);
    if (outer) assert.equal(await readlink(join(f.codex, 'example')), f.links[0].target);
    assert.deepEqual(await listBackups(f.paths), []);
  } finally {await f.close();}
});

for (const outer of [false, true]) test(`restore preserves occupied original folder and occupied alias file, outer source ${outer}`, async () => {
  const f = await fixture(outer);
  try {
    const manifest = await backupUnmanaged(f.paths, f.source, f.ref, f.links);
    await mkdir(f.source); await writeFile(join(f.source, 'local.txt'), 'Current folder');
    await writeFile(join(f.other, 'alias'), 'Current file');
    await restoreBackup(f.paths, manifest.id);
    assert.equal(await readFile(join(f.source, 'SKILL.md'), 'utf8'), 'Original');
    const backups = await listBackups(f.paths);
    assert.equal(backups.length, 2);
    const folder = backups.find(backup => backup.folderName === 'example')!;
    const file = backups.find(backup => backup.folderName === 'alias')!;
    assert.equal(await readFile(join(saved(f.paths, folder), 'local.txt'), 'utf8'), 'Current folder');
    assert.equal(await readFile(saved(f.paths, file), 'utf8'), 'Current file');
    // Restoring the displaced regular file refuses the newly restored link.
    await assert.rejects(restoreBackup(f.paths, file.id));
    assert.equal(await readFile(saved(f.paths, file), 'utf8'), 'Current file');
  } finally {await f.close();}
});

test('restore prevalidates all destinations before moving any occupied folder', async () => {
  const f = await fixture();
  try {
    const manifest = await backupUnmanaged(f.paths, f.source, f.ref, f.links);
    await mkdir(f.source); await writeFile(join(f.source, 'current.txt'), 'Preserve me');
    await symlink(f.source, join(f.other, 'alias'));
    await assert.rejects(restoreBackup(f.paths, manifest.id));
    assert.equal(await readFile(join(f.source, 'current.txt'), 'utf8'), 'Preserve me');
    assert.equal(await readFile(join(saved(f.paths, manifest), 'SKILL.md'), 'utf8'), 'Original');
    assert.equal((await listBackups(f.paths)).length, 1);
  } finally {await f.close();}
});

test('durable manifest and callback precede moves, interrupted source and alias moves resume', async () => {
  const f = await fixture(true);
  try {
    let manifest: BackupManifest | undefined;
    await assert.rejects(backupUnmanaged(f.paths, f.source, f.ref, f.links, Date.now(), async backup => {
      manifest = backup;
      assert.deepEqual(JSON.parse(await readFile(join(f.paths.backups, backup.id, 'manifest.json'), 'utf8')), backup);
      assert.equal(await readFile(join(f.source, 'SKILL.md'), 'utf8'), 'Original');
      throw new Error('Interrupted');
    }), /Interrupted/);
    assert.ok(manifest);
    assert.deepEqual(await listBackups(f.paths), []);
    // Reproduce a crash after the real source and first link have moved.
    await rename(f.source, saved(f.paths, manifest));
    await rename(join(f.codex, 'example'), join(f.paths.backups, manifest.id, 'links/0'));
    await finishUnmanagedBackup(f.paths, manifest.id);
    await finishUnmanagedBackup(f.paths, manifest.id);
    await absent(join(f.other, 'alias'));
    await restoreBackup(f.paths, manifest.id);
    assert.equal(await readFile(join(f.source, 'SKILL.md'), 'utf8'), 'Original');
  } finally {await f.close();}
});

test('changed links prevent resuming a prepared backup without moving the original', async () => {
  const f = await fixture();
  try {
    let manifest: BackupManifest | undefined;
    await assert.rejects(backupUnmanaged(f.paths, f.source, f.ref, f.links, Date.now(), async backup => {
      manifest = backup; throw new Error('Interrupted');
    }), /Interrupted/);
    await rename(join(f.other, 'alias'), join(f.other, 'previous'));
    await symlink('../../elsewhere', join(f.other, 'alias'));
    await assert.rejects(finishUnmanagedBackup(f.paths, manifest!.id));
    assert.equal(await readFile(join(f.source, 'SKILL.md'), 'utf8'), 'Original');
  } finally {await f.close();}
});

test('backup recovery rejects forged journal provenance before moving the source or aliases', async () => {
  const f = await fixture(true);
  try {
    let manifest: BackupManifest | undefined;
    await assert.rejects(backupUnmanaged(f.paths, f.source, f.ref, f.links, Date.now(), async backup => {
      manifest = backup; throw new Error('Interrupted');
    }), /Interrupted/);
    assert.ok(manifest?.unmanaged);
    const expected = {originalPath: manifest.originalPath, ...manifest.unmanaged};
    for (const forged of [
      {...expected, originalPath: 'elsewhere/example'},
      {...expected, original: {...expected.original, folderName: 'other'}},
      {...expected, links: expected.links.slice(1)},
      {...expected, links: expected.links.map(link => ({...link, target: '../../other'}))},
    ]) {
      await assert.rejects(finishUnmanagedBackup(f.paths, manifest.id, forged), {code: 'BACKUP_INVALID'});
      assert.equal(await readFile(join(f.source, 'SKILL.md'), 'utf8'), 'Original');
      assert.equal(await readlink(join(f.codex, 'example')), f.links[0].target);
      assert.equal(await readlink(join(f.other, 'alias')), f.links[1].target);
      await absent(saved(f.paths, manifest));
    }
    // Link ordering does not change provenance.
    await finishUnmanagedBackup(f.paths, manifest.id, {...expected, links: [...expected.links].reverse()});
    await absent(f.source);
    assert.equal(await readFile(join(saved(f.paths, manifest), 'SKILL.md'), 'utf8'), 'Original');
  } finally {await f.close();}
});

for (const kind of ['folder', 'symlink'] as const) test(`backup recovery refuses a newly occupied physical source (${kind}) without removing aliases`, async () => {
  const f = await fixture(true);
  try {
    let manifest: BackupManifest | undefined;
    await assert.rejects(backupUnmanaged(f.paths, f.source, f.ref, f.links, Date.now(), async backup => {
      manifest = backup; throw new Error('Interrupted');
    }), /Interrupted/);
    assert.ok(manifest);
    await rename(f.source, saved(f.paths, manifest));
    if (kind === 'folder') {
      await mkdir(f.source); await writeFile(join(f.source, 'current.txt'), 'New contents');
    } else await symlink(f.other, f.source);
    await assert.rejects(finishUnmanagedBackup(f.paths, manifest.id), {code: 'BACKUP_INVALID'});
    assert.equal(await readlink(join(f.codex, 'example')), f.links[0].target);
    assert.equal(await readlink(join(f.other, 'alias')), f.links[1].target);
    assert.equal(await readFile(join(saved(f.paths, manifest), 'SKILL.md'), 'utf8'), 'Original');
    if (kind === 'folder') assert.equal(await readFile(join(f.source, 'current.txt'), 'utf8'), 'New contents');
    else assert.equal(await readlink(f.source), f.other);
  } finally {await f.close();}
});

test('malicious backup paths, matrix refs and stored link targets are refused', async () => {
  const f = await fixture();
  try {
    const manifest = await backupUnmanaged(f.paths, f.source, f.ref, f.links);
    const manifestPath = join(f.paths.backups, manifest.id, 'manifest.json');
    for (const modified of [
      {...manifest, originalPath: '../outside/example'},
      {...manifest, originalPath: '.claude/skills/example'},
      {...manifest, originalPath: '.cache/maddots-mcp/example'},
      {...manifest, unmanaged: {...manifest.unmanaged!, original: {home: '.unknown', folderName: 'example'}}},
      {...manifest, unmanaged: {...manifest.unmanaged!, links: [{...f.links[0], target: '../../../outside'}]}},
      {...manifest, unmanaged: {...manifest.unmanaged!, links: [{...f.links[0], folderName: '../elsewhere'}]}},
      {...manifest, unmanaged: {...manifest.unmanaged!, keepOriginal: false}},
      {...manifest, unmanaged: {...manifest.unmanaged!, keepOriginal: 'true'}},
      {...manifest, unmanaged: {...manifest.unmanaged!, keepOriginal: true, links: []}},
    ]) {
      await atomicWrite(manifestPath, JSON.stringify(modified));
      await assert.rejects(restoreBackup(f.paths, manifest.id));
      await absent(f.source);
    }
    await atomicWrite(manifestPath, JSON.stringify(manifest));
    const link = join(f.paths.backups, manifest.id, 'links/0');
    await rename(link, join(f.paths.backups, manifest.id, 'links/original'));
    await symlink('/tmp/other', link);
    await assert.rejects(restoreBackup(f.paths, manifest.id));
    await absent(f.source);
    assert.equal(await readFile(join(saved(f.paths, manifest), 'SKILL.md'), 'utf8'), 'Original');
  } finally {await f.close();}
});

test('restore resumes after returning a link but before returning the real source', async () => {
  const f = await fixture(true);
  try {
    const manifest = await backupUnmanaged(f.paths, f.source, f.ref, f.links);
    await rename(join(f.paths.backups, manifest.id, 'links/0'), join(f.codex, 'example'));
    await restoreBackup(f.paths, manifest.id);
    assert.equal(await readFile(join(f.source, 'SKILL.md'), 'utf8'), 'Original');
    assert.equal(await readlink(join(f.other, 'alias')), f.links.at(-1)!.target);
  } finally {await f.close();}
});

async function managedFixture() {
  const f = await fixture();
  const managed = join(f.home, '.agents/skills/managed');
  await mkdir(managed, {recursive: true}); await writeFile(join(managed, 'SKILL.md'), 'Managed');
  return {...f, managed, alias: join(f.other, 'alias')};
}

test('linked replacement preserves original content and exact alias text, keeps all homes live and restores both', async () => {
  const f = await managedFixture();
  try {
    const inode = (await lstat(f.source)).ino;
    const backup = await backupUnmanaged(f.paths, f.source, f.ref, f.links, Date.now(), undefined, f.managed);
    for (const path of [f.source, f.alias]) {
      assert.equal(await readlink(path), relative(dirname(path), f.managed));
      assert.equal(await readFile(join(path, 'SKILL.md'), 'utf8'), 'Managed');
    }
    assert.equal((await lstat(saved(f.paths, backup))).ino, inode);
    assert.equal(await readlink(join(f.paths.backups, backup.id, 'links/0')), f.links[0].target);
    await finishUnmanagedBackup(f.paths, backup.id);
    await restoreBackup(f.paths, backup.id);
    assert.equal((await lstat(f.source)).ino, inode);
    assert.equal(await readlink(f.alias), f.links[0].target);
    assert.equal(await readFile(join(f.alias, 'SKILL.md'), 'utf8'), 'Original');
    assert.deepEqual(await listBackups(f.paths), []);
  } finally {await f.close();}
});

test('an interrupted atomic repoint resumes from its saved alias without ever moving the original early', async () => {
  const f = await managedFixture();
  try {
    let backup!: BackupManifest;
    await assert.rejects(backupUnmanaged(f.paths, f.source, f.ref, f.links, Date.now(), async manifest => {
      backup = manifest;
      await preserveSymlink(f.alias, join(f.paths.backups, manifest.id, 'links/0'), f.links[0].target);
      await atomicSymlink(f.alias, relative(dirname(f.alias), f.managed), f.links[0].target, {preserved: join(f.paths.backups, manifest.id, 'links/0.displaced')});
      assert.equal(await readFile(join(f.source, 'SKILL.md'), 'utf8'), 'Original');
      assert.equal(await readFile(join(f.alias, 'SKILL.md'), 'utf8'), 'Managed');
      throw new Error('Interrupted after repoint');
    }, f.managed), /Interrupted after repoint/);
    await finishUnmanagedBackup(f.paths, backup.id);
    await restoreBackup(f.paths, backup.id);
    assert.equal(await readFile(join(f.alias, 'SKILL.md'), 'utf8'), 'Original');
  } finally {await f.close();}
});

test('linked replacement recovery refuses a changed alias before touching the original', async () => {
  const f = await managedFixture();
  try {
    let backup!: BackupManifest;
    await assert.rejects(backupUnmanaged(f.paths, f.source, f.ref, f.links, Date.now(), async manifest => {
      backup = manifest; throw new Error('Interrupted');
    }, f.managed), /Interrupted/);
    await rename(f.alias, join(f.other, 'saved-alias')); await symlink('../../user-choice', f.alias);
    await assert.rejects(finishUnmanagedBackup(f.paths, backup.id));
    assert.equal(await readFile(join(f.source, 'SKILL.md'), 'utf8'), 'Original');
    assert.equal(await readlink(f.alias), '../../user-choice');
    await absent(saved(f.paths, backup));
  } finally {await f.close();}
});

test('linked restore prevalidates every alias and keeps unrelated user links untouched', async () => {
  const f = await managedFixture();
  try {
    const backup = await backupUnmanaged(f.paths, f.source, f.ref, f.links, Date.now(), undefined, f.managed);
    await rename(f.alias, join(f.other, 'managed-alias')); await symlink('../../user-choice', f.alias);
    await assert.rejects(restoreBackup(f.paths, backup.id));
    assert.equal(await readFile(join(f.source, 'SKILL.md'), 'utf8'), 'Managed');
    assert.equal(await readFile(join(saved(f.paths, backup), 'SKILL.md'), 'utf8'), 'Original');
    assert.equal(await readlink(f.alias), '../../user-choice');
  } finally {await f.close();}
});

test('replacement refuses a linked managed destination before moving originals or aliases', async () => {
  const f = await managedFixture();
  try {
    await rename(f.managed, f.managed + '-real'); await symlink(f.managed + '-real', f.managed);
    await assert.rejects(backupUnmanaged(f.paths, f.source, f.ref, f.links, Date.now(), undefined, f.managed));
    assert.equal(await readFile(join(f.source, 'SKILL.md'), 'utf8'), 'Original');
    assert.equal(await readlink(f.alias), f.links[0].target);
    assert.deepEqual(await listBackups(f.paths), []);
  } finally {await f.close();}
});

const noSpace = () => Object.assign(new Error('Injected full disk'), {code: 'ENOSPC'});

test('a file swapped into a checked alias is preserved by inode before replacement refuses it', async () => {
  const f = await managedFixture();
  try {
    let backup!: BackupManifest;
    let changedInode = 0;
    await assert.rejects(backupUnmanaged(f.paths, f.source, f.ref, f.links, Date.now(), async manifest => {backup = manifest;}, f.managed, {
      symlink: path => path === f.alias ? {beforePreserve: async () => {
        await rename(f.alias, join(f.other, 'user-saved-link'));
        await writeFile(f.alias, 'Concurrent user file');
        changedInode = (await lstat(f.alias)).ino;
      }} : {},
    }), {code: 'PATH_CHANGED'});
    const displaced = join(f.paths.backups, backup.id, 'links/0.displaced');
    assert.equal((await lstat(displaced)).ino, changedInode);
    assert.equal(await readFile(displaced, 'utf8'), 'Concurrent user file');
    assert.equal(await readlink(join(f.paths.backups, backup.id, 'links/0')), f.links[0].target);
    assert.equal(await readFile(join(f.source, 'SKILL.md'), 'utf8'), 'Original');
    await assert.rejects(finishUnmanagedBackup(f.paths, backup.id));
    const recovery = (await listBackups(f.paths)).find(item => item.reason === 'replacement-displaced')!;
    assert.ok(recovery);
    assert.equal(recovery.originalPath, '.codex-work/skills/alias');
    assert.equal((await lstat(saved(f.paths, recovery))).ino, changedInode);
    await restoreBackup(f.paths, backup.id);
    assert.equal(await readlink(f.alias), f.links[0].target);
    assert.deepEqual((await listBackups(f.paths)).map(item => item.id), [recovery.id]);
    await restoreBackup(f.paths, recovery.id);
    assert.equal((await lstat(f.alias)).ino, changedInode);
    assert.equal(await readFile(f.alias, 'utf8'), 'Concurrent user file');
    const restoredLink = (await listBackups(f.paths)).find(item => item.reason === 'restore-replaced')!;
    assert.equal(restoredLink.originalPath, recovery.originalPath);
    assert.equal(await readlink(saved(f.paths, restoredLink)), f.links[0].target);
    // Restoring the saved link also preserves the file again, never its target.
    await restoreBackup(f.paths, restoredLink.id);
    assert.equal(await readlink(f.alias), f.links[0].target);
    assert.equal(await readFile(join(f.source, 'SKILL.md'), 'utf8'), 'Original');
    assert.equal((await lstat(saved(f.paths, (await listBackups(f.paths))[0]))).ino, changedInode);
  } finally {await f.close();}
});

for (const kind of ['file', 'directory', 'symlink'] as const) for (const childFirst of [false, true]) test(`a raced-in primary ${kind} restores at its real path (${childFirst ? 'object' : 'snapshot'} first)`, async () => {
  const f = await managedFixture();
  try {
    let backup!: BackupManifest, inode = 0;
    const userOriginal = join(f.codex, 'user-original');
    await assert.rejects(backupUnmanaged(f.paths, f.source, f.ref, f.links, Date.now(), async manifest => {backup = manifest;}, f.managed, {
      symlink: path => path === f.source ? {beforePreserve: async () => {
        await rename(f.source, userOriginal);
        if (kind === 'file') await writeFile(f.source, 'Concurrent primary file');
        else if (kind === 'directory') {await mkdir(f.source); await writeFile(join(f.source, 'note.txt'), 'Concurrent directory');}
        else await symlink('user-original', f.source);
        inode = (await lstat(f.source)).ino;
      }} : {},
    }), {code: 'PATH_CHANGED'});
    const backups = await listBackups(f.paths);
    assert.equal(backups.length, 2);
    const recovery = backups.find(item => item.reason === 'replacement-displaced')!;
    assert.equal(recovery.originalPath, '.codex/skills/example');
    assert.equal((await lstat(saved(f.paths, recovery))).ino, inode);
    assert.deepEqual(await listBackups(f.paths), backups);
    await assert.rejects(finishUnmanagedBackup(f.paths, backup.id), {code: 'PATH_CHANGED'});
    if (childFirst) await restoreBackup(f.paths, recovery.id);
    await restoreBackup(f.paths, backup.id);
    assert.equal(await readlink(f.alias), f.links[0].target);
    assert.deepEqual((await listBackups(f.paths)).map(item => item.id), childFirst ? [] : [recovery.id]);
    if (!childFirst) await restoreBackup(f.paths, recovery.id);
    if (kind !== 'symlink') assert.equal((await lstat(f.source)).ino, inode);
    if (kind === 'file') assert.equal(await readFile(f.source, 'utf8'), 'Concurrent primary file');
    else if (kind === 'directory') assert.equal(await readFile(join(f.source, 'note.txt'), 'utf8'), 'Concurrent directory');
    else assert.equal(await readlink(f.source), 'user-original');
    assert.equal(await readFile(join(userOriginal, 'SKILL.md'), 'utf8'), 'Original');
    assert.deepEqual(await listBackups(f.paths), []);
  } finally {await f.close();}
});

test('displaced recovery resumes the journaled child backup and survives consumed alias snapshots', async () => {
  const f = await managedFixture();
  try {
    let backup!: BackupManifest;
    await assert.rejects(backupUnmanaged(f.paths, f.source, f.ref, f.links, Date.now(), async manifest => {backup = manifest;}, f.managed, {
      symlink: path => path === f.alias ? {beforePreserve: async () => {
        await rename(f.alias, join(f.other, 'user-saved-link')); await writeFile(f.alias, 'Recover after interruption');
      }} : {},
    }), {code: 'PATH_CHANGED'});
    const recovery = (await listBackups(f.paths)).find(item => item.reason === 'replacement-displaced')!;
    const slot = join(f.paths.backups, backup.id, 'links/0.displaced');
    // Reproduce an interruption after journaling the child id but before moving its object.
    await rename(saved(f.paths, recovery), slot);
    assert.deepEqual(new Set((await listBackups(f.paths)).map(item => item.id)), new Set([backup.id, recovery.id]));
    await restoreBackup(f.paths, backup.id);
    assert.deepEqual((await listBackups(f.paths)).map(item => item.id), [recovery.id]);
    await restoreBackup(f.paths, recovery.id);
    assert.equal(await readFile(f.alias, 'utf8'), 'Recover after interruption');
  } finally {await f.close();}
});

test('a file arriving after preservation is never overwritten by link placement', async () => {
  const f = await managedFixture();
  try {
    let backup!: BackupManifest;
    const originalInode = (await lstat(f.alias)).ino;
    await assert.rejects(backupUnmanaged(f.paths, f.source, f.ref, f.links, Date.now(), async manifest => {backup = manifest;}, f.managed, {
      symlink: path => path === f.alias ? {beforePlace: async () => {await writeFile(f.alias, 'New occupant');}} : {},
    }), {code: 'EEXIST'});
    assert.equal(await readFile(f.alias, 'utf8'), 'New occupant');
    assert.equal((await lstat(join(f.paths.backups, backup.id, 'links/0.displaced'))).ino, originalInode);
    await restoreBackup(f.paths, backup.id);
    assert.equal(await readlink(f.alias), f.links[0].target);
    const displaced = (await listBackups(f.paths)).find(item => item.reason === 'restore-replaced')!;
    assert.equal(await readFile(saved(f.paths, displaced), 'utf8'), 'New occupant');
    assert.equal(displaced.originalPath, '.codex-work/skills/alias');
    await restoreBackup(f.paths, displaced.id);
    assert.equal(await readFile(f.alias, 'utf8'), 'New occupant');
    const preservedLink = (await listBackups(f.paths))[0];
    assert.equal(await readlink(saved(f.paths, preservedLink)), f.links[0].target);
    assert.equal(await readFile(join(f.source, 'SKILL.md'), 'utf8'), 'Original');
  } finally {await f.close();}
});

test('full disk while staging the primary forwarding link leaves its original directory live and permits partial restore', async () => {
  const f = await managedFixture();
  try {
    let backup!: BackupManifest;
    const inode = (await lstat(f.source)).ino;
    await assert.rejects(backupUnmanaged(f.paths, f.source, f.ref, f.links, Date.now(), async manifest => {backup = manifest;}, f.managed, {
      symlink: path => path === f.source ? {beforeStage: async () => {throw noSpace();}} : {},
    }), {code: 'ENOSPC'});
    assert.equal((await lstat(f.source)).ino, inode);
    assert.equal(await readFile(join(f.source, 'SKILL.md'), 'utf8'), 'Original');
    assert.equal(await readFile(join(f.alias, 'SKILL.md'), 'utf8'), 'Managed');
    await absent(saved(f.paths, backup));
    assert.deepEqual((await listBackups(f.paths)).map(item => item.id), [backup.id]);
    await restoreBackup(f.paths, backup.id);
    assert.equal((await lstat(f.source)).ino, inode);
    assert.equal(await readFile(join(f.alias, 'SKILL.md'), 'utf8'), 'Original');
    assert.deepEqual(await listBackups(f.paths), []);
  } finally {await f.close();}
});

for (const failure of ['interruption', 'full disk'] as const) test(`primary conversion recovers its journaled directory after ${failure} between preservation and placement`, async () => {
  const f = await managedFixture();
  try {
    let backup!: BackupManifest;
    const identity = await lstat(f.source);
    await assert.rejects(backupUnmanaged(f.paths, f.source, f.ref, f.links, Date.now(), async manifest => {backup = manifest;}, f.managed, {
      symlink: path => path === f.source ? {afterPreserve: async () => {
        const journal = JSON.parse(await readFile(saved(f.paths, backup) + '.json', 'utf8'));
        assert.deepEqual(journal.identity, {dev: identity.dev, ino: identity.ino, type: identity.mode & 0o170000});
        assert.equal((await lstat(saved(f.paths, backup))).ino, identity.ino);
        throw failure === 'full disk' ? noSpace() : new Error('Injected interruption');
      }} : {},
    }), failure === 'full disk' ? {code: 'ENOSPC'} : /Injected interruption/);
    assert.equal(await readFile(join(saved(f.paths, backup), 'SKILL.md'), 'utf8'), 'Original');
    assert.deepEqual((await listBackups(f.paths)).map(item => item.id), [backup.id]);
    await finishUnmanagedBackup(f.paths, backup.id);
    assert.equal(await readFile(join(f.source, 'SKILL.md'), 'utf8'), 'Managed');
    await restoreBackup(f.paths, backup.id);
    assert.equal((await lstat(f.source)).ino, identity.ino);
    assert.equal(await readFile(join(f.alias, 'SKILL.md'), 'utf8'), 'Original');
  } finally {await f.close();}
});

test('partially repointed aliases restore directly while preserving the still-live original directory', async () => {
  const f = await managedFixture();
  try {
    const third = join(f.home, '.codex-client/skills');
    await mkdir(third, {recursive: true});
    const alias = join(third, 'third');
    const links = [...f.links, {home: '.codex-client', folderName: 'third', target: relative(third, f.source)}];
    await symlink(links[1].target, alias);
    let backup!: BackupManifest;
    const inode = (await lstat(f.source)).ino;
    await assert.rejects(backupUnmanaged(f.paths, f.source, f.ref, links, Date.now(), async manifest => {backup = manifest;}, f.managed, {
      symlink: path => path === alias ? {beforePreserve: async () => {throw new Error('Interrupted before second alias');}} : {},
    }), /Interrupted before second alias/);
    assert.equal(await readFile(join(f.alias, 'SKILL.md'), 'utf8'), 'Managed');
    assert.equal(await readlink(alias), links[1].target);
    assert.equal((await lstat(f.source)).ino, inode);
    assert.deepEqual((await listBackups(f.paths)).map(item => item.id), [backup.id]);
    await restoreBackup(f.paths, backup.id);
    assert.equal((await lstat(f.source)).ino, inode);
    assert.equal(await readlink(f.alias), links[0].target);
    assert.equal(await readlink(alias), links[1].target);
    assert.deepEqual(await listBackups(f.paths), []);
    await assert.rejects(finishUnmanagedBackup(f.paths, backup.id), {code: 'BACKUP_RESTORED'});
    assert.equal((await lstat(f.source)).ino, inode);
    assert.equal(await readlink(f.alias), links[0].target);
    assert.equal(await readlink(alias), links[1].target);
    assert.deepEqual(await listBackups(f.paths), []);
  } finally {await f.close();}
});

for (const action of ['resume', 'restore'] as const) test(`an interruption after preserving an alias supports ${action} with its primary still live`, async () => {
  const f = await managedFixture();
  try {
    let backup!: BackupManifest;
    await assert.rejects(backupUnmanaged(f.paths, f.source, f.ref, f.links, Date.now(), async manifest => {backup = manifest;}, f.managed, {
      symlink: path => path === f.alias ? {afterPreserve: async () => {throw new Error('Interrupted alias');}} : {},
    }), /Interrupted alias/);
    assert.equal(await readFile(join(f.source, 'SKILL.md'), 'utf8'), 'Original');
    assert.deepEqual((await listBackups(f.paths)).map(item => item.id), [backup.id]);
    if (action === 'resume') await finishUnmanagedBackup(f.paths, backup.id);
    await restoreBackup(f.paths, backup.id);
    assert.equal(await readFile(join(f.alias, 'SKILL.md'), 'utf8'), 'Original');
    assert.deepEqual(await listBackups(f.paths), []);
  } finally {await f.close();}
});

async function displacedFileFixture() {
  const f = await managedFixture();
  const backup = await backupUnmanaged(f.paths, f.source, f.ref, f.links, Date.now(), undefined, f.managed);
  await rename(f.alias, f.alias + '-managed');
  await writeFile(f.alias, 'Preserved user file');
  await restoreBackup(f.paths, backup.id);
  const displaced = (await listBackups(f.paths)).find(item => item.reason === 'restore-replaced')!;
  assert.ok(displaced);
  return {...f, backup, displaced};
}

for (const kind of ['file', 'symlink'] as const) test(`restoring a displaced ${kind} refuses a file arriving at placement`, async () => {
  const f = await displacedFileFixture();
  try {
    let backup = f.displaced;
    if (kind === 'symlink') {
      await restoreBackup(f.paths, backup.id);
      backup = (await listBackups(f.paths)).find(item => item.reason === 'restore-replaced')!;
    }
    await rename(f.alias, f.alias + '-before-restore');
    const before = await lstat(saved(f.paths, backup));
    await assert.rejects(restoreBackup(f.paths, backup.id, {path: path => path === f.alias ? {
      beforePlace: async () => {await writeFile(f.alias, 'Arrived during restore');},
    } : {}}), {code: 'DESTINATION_EXISTS'});
    assert.equal(await readFile(f.alias, 'utf8'), 'Arrived during restore');
    assert.equal((await lstat(saved(f.paths, backup))).ino, before.ino);
    if (kind === 'file') assert.equal(await readFile(saved(f.paths, backup), 'utf8'), 'Preserved user file');
    else assert.equal(await readlink(saved(f.paths, backup)), f.links[0].target);
    assert.ok((await listBackups(f.paths)).some(item => item.id === backup.id && !item.attention));
  } finally {await f.close();}
});

for (const kind of ['file', 'same-target symlink'] as const) for (const interrupted of [false, true])
  test(`primary restore journals and exposes a raced-in ${kind}, interruption ${interrupted}`, async () => {
    const f = await managedFixture();
    try {
      const backup = await backupUnmanaged(f.paths, f.source, f.ref, f.links, Date.now(), undefined, f.managed);
      const initial = await lstat(f.source), target = await readlink(f.source);
      let inode = 0;
      await assert.rejects(restoreBackup(f.paths, backup.id, {path: path => path === f.source ? {
        beforePreserve: async () => {
          await rename(f.source, f.source + '-managed');
          if (kind === 'file') await writeFile(f.source, 'Raced primary restore');
          else await symlink(target, f.source);
          inode = (await lstat(f.source)).ino;
        },
        ...(interrupted ? {afterPreserve: async () => {throw new Error('Interrupted primary preservation');}} : {}),
      } : {}}), interrupted ? /Interrupted primary preservation/ : {code: 'PATH_CHANGED'});
      const slot = join(f.paths.backups, backup.id, 'managed-original-link');
      const journal = JSON.parse(await readFile(slot + '.json', 'utf8'));
      assert.equal(journal.identity.ino, initial.ino);
      assert.equal((await lstat(slot)).ino, inode);
      const child = (await listBackups(f.paths)).find(item => item.reason === 'replacement-displaced')!;
      assert.ok(child);
      assert.equal(child.originalPath, backup.originalPath);
      assert.equal((await lstat(saved(f.paths, child))).ino, inode);
      assert.equal(child.displaced?.linkTarget, kind === 'file' ? null : target);
      await restoreBackup(f.paths, backup.id);
      assert.equal(await readFile(join(f.source, 'SKILL.md'), 'utf8'), 'Original');
      await restoreBackup(f.paths, child.id);
      if (kind === 'file') assert.equal(await readFile(f.source, 'utf8'), 'Raced primary restore');
      else assert.equal(await readlink(f.source), target);
    } finally {await f.close();}
  });

for (const change of ['file-to-link', 'link-to-file', 'link-to-link'] as const) for (const interrupted of [false, true])
  test(`restore preservation reconciles ${change} metadata, interruption ${interrupted}`, async () => {
    const f = await displacedFileFixture();
    try {
      await rename(f.alias, f.alias + '-original-link');
      if (change === 'file-to-link') await writeFile(f.alias, 'Before race');
      else await symlink('before-race', f.alias);
      let inode = 0;
      await assert.rejects(restoreBackup(f.paths, f.displaced.id, {path: path => path === f.alias ? {
        beforePreserve: async () => {
          await rename(f.alias, f.alias + '-before-race');
          if (change === 'link-to-file') await writeFile(f.alias, 'Actual preserved file');
          else await symlink('actual-preserved-target', f.alias);
          inode = (await lstat(f.alias)).ino;
        },
        ...(interrupted ? {afterPreserve: async () => {throw new Error('Interrupted metadata update');}} : {}),
      } : {}}), interrupted ? /Interrupted metadata update/ : {code: 'PATH_CHANGED'});
      // Listing must repair the manifest from the journaled move after a crash.
      const backups = await listBackups(f.paths);
      const child = backups.find(item => item.id !== f.displaced.id)!;
      assert.equal(backups.length, 2);
      assert.ok(backups.every(item => !item.attention));
      assert.equal((await lstat(saved(f.paths, child))).ino, inode);
      const expectedTarget = change === 'link-to-file' ? null : 'actual-preserved-target';
      assert.equal(child.displaced?.linkTarget, expectedTarget);
      assert.equal((await readBackupManifest(f.paths, child.id)).displaced?.linkTarget, expectedTarget);
      await restoreBackup(f.paths, child.id);
      if (change === 'link-to-file') assert.equal(await readFile(f.alias, 'utf8'), 'Actual preserved file');
      else assert.equal(await readlink(f.alias), expectedTarget);
      assert.equal(await readFile(saved(f.paths, f.displaced), 'utf8'), 'Preserved user file');
    } finally {await f.close();}
  });

test('one malformed manifest or mismatched saved object is listed for attention without hiding good backups', async () => {
  const f = await displacedFileFixture();
  try {
    const healthy = f.displaced;
    const badId = '20261021T000000000Z-00000000-0000-0000-0000-000000000000';
    await mkdir(join(f.paths.backups, badId));
    await writeFile(join(f.paths.backups, badId, 'manifest.json'), '{broken json', {mode: 0o600});
    let listed = await listBackups(f.paths);
    assert.ok(listed.some(item => item.id === healthy.id && !item.attention));
    assert.ok(listed.some(item => item.id === badId && item.attention));
    await rename(saved(f.paths, healthy), saved(f.paths, healthy) + '.user');
    await symlink('changed-after-preservation', saved(f.paths, healthy));
    // The durable preservation journal repairs even a later type mismatch.
    listed = await listBackups(f.paths);
    assert.equal(listed.find(item => item.id === healthy.id)?.displaced?.linkTarget, 'changed-after-preservation');
    // Without a preservation journal, a mismatched entry is reported, not trusted.
    await rm(join(f.paths.backups, healthy.id, 'preserve.json'));
    await atomicWrite(join(f.paths.backups, healthy.id, 'manifest.json'), JSON.stringify(healthy) + '\n');
    listed = await listBackups(f.paths);
    assert.ok(listed.find(item => item.id === healthy.id)?.attention);
    assert.ok(listed.find(item => item.id === badId)?.attention);
  } finally {await f.close();}
});

for (const keepOriginal of [false, true]) test(`restore resumes symlink placement before saved-source removal, keepOriginal ${keepOriginal}`, async () => {
  const f = keepOriginal ? await gitWorktreeFixture() : await fixture();
  try {
    const backup = await backupUnmanaged(f.paths, f.source, f.ref, f.links);
    const first = f.links[0], path = join(f.home, first.home, 'skills', first.folderName);
    // Simulate interruption after exclusive symlink creation and before unlink.
    await symlink(first.target, path);
    const placed = await lstat(path);
    await restoreBackup(f.paths, backup.id);
    assert.equal((await lstat(path)).ino, placed.ino);
    assert.equal(await readlink(path), first.target);
    assert.equal(await readFile(join(f.source, 'SKILL.md'), 'utf8'), keepOriginal ? 'Repository original' : 'Original');
    assert.deepEqual(await listBackups(f.paths), []);
  } finally {await f.close();}
});
