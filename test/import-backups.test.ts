import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { backupUnmanaged, finishUnmanagedBackup, listBackups, restoreBackup, type BackupManifest } from '../src/backups.js';
import { readConfig } from '../src/config.js';
import { atomicWrite, createPaths, ensurePaths } from '../src/paths.js';

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
      assert.equal((await lstat(path)).ino, linkInodes[index]);
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
    assert.equal((await lstat(join(f.other, 'alias'))).ino, linkInode);
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
