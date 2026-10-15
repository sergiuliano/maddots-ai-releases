import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { treeDigest } from '../src/shared/build-format.js';
import { TOOL_MATRIX } from '../src/shared/tool-matrix.js';
import { backupFolder, listBackups, restoreBackup, snapshotReadCopy } from '../src/backups.js';
import { readConfig } from '../src/config.js';
import { atomicWrite, createPaths, ensurePaths } from '../src/paths.js';
import { readSkillTree } from '../src/safe-fs.js';

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-read-copy-backups-'));
  const home = join(root, 'home');
  await mkdir(home, {mode: 0o700});
  const paths = await createPaths(readConfig({}, home));
  await ensurePaths(paths);
  const destination = join(home, '.maddots-ai/claude-code/example');
  const source = join(home, '.claude/plugins/cache/maddots-ai/example');
  const unrelated = join(home, '.agents/skills/unrelated');
  for (const path of [destination, source, unrelated]) await mkdir(path, {recursive: true});
  await writeFile(join(destination, 'SKILL.md'), 'Current managed source');
  await writeFile(join(source, 'SKILL.md'), 'Edited tool cache');
  await writeFile(join(unrelated, 'SKILL.md'), 'Unrelated backup');
  const digest = treeDigest(await readSkillTree(source, home));
  return {root, home, paths, destination, source, unrelated, digest, close: () => rm(root, {recursive: true, force: true})};
}

for (const readPath of ['~/.claude/plugins/cache/maddots-ai-v2', null]) {
  test(`TLS-19 read-copy snapshots list and restore into their managed source after readPath is ${readPath === null ? 'removed' : 'changed'}`, async () => {
    const f = await fixture(), route = TOOL_MATRIX.routes['claude-plugin'], previous = route.readPath;
    try {
      route.readPath = '~/.claude/plugins/cache/maddots-ai';
      const unrelated = await backupFolder(f.paths, f.unrelated, 'agents-folder', 'update', null);
      const snapshot = await snapshotReadCopy(f.paths, f.source, f.destination, 'claude-plugin', f.digest);
      assert.equal(snapshot.originalPath, '.claude/plugins/cache/maddots-ai/example');
      assert.equal(snapshot.restorePath, '.maddots-ai/claude-code/example');
      route.readPath = readPath;
      await rm(f.source, {recursive: true});
      assert.deepEqual(new Set((await listBackups(f.paths)).map(backup => backup.id)), new Set([unrelated.id, snapshot.id]));
      assert.deepEqual(await restoreBackup(f.paths, snapshot.id), snapshot);
      assert.equal(await readFile(join(f.destination, 'SKILL.md'), 'utf8'), 'Edited tool cache');
      await assert.rejects(lstat(f.source), {code: 'ENOENT'});
      const retained = await listBackups(f.paths);
      assert.equal(retained.length, 2);
      assert.ok(retained.some(backup => backup.id === unrelated.id));
      const displaced = retained.find(backup => backup.reason === 'restore-replaced')!;
      assert.ok(displaced);
      assert.equal(await readFile(join(f.paths.backups, displaced.id, displaced.route, displaced.folderName, 'SKILL.md'), 'utf8'), 'Current managed source');
      await restoreBackup(f.paths, unrelated.id);
      assert.equal(await readFile(join(f.unrelated, 'SKILL.md'), 'utf8'), 'Unrelated backup');
    } finally {route.readPath = previous; await f.close();}
  });
}

test('TLS-19 read-copy snapshot manifests refuse unsafe origins, restore paths, reasons and routes', async () => {
  const f = await fixture(), route = TOOL_MATRIX.routes['claude-plugin'], previous = route.readPath;
  try {
    route.readPath = '~/.claude/plugins/cache/maddots-ai';
    const snapshot = await snapshotReadCopy(f.paths, f.source, f.destination, 'claude-plugin', f.digest);
    const manifestPath = join(f.paths.backups, snapshot.id, 'manifest.json');
    route.readPath = null;
    for (const fields of [
      {originalPath: '../outside/example'},
      {originalPath: relative(f.home, join(f.paths.data, 'example'))},
      {originalPath: '.claude/plugins/cache/maddots-ai/other'},
      {restorePath: '.agents/skills/example'},
      {reason: 'update'},
      {route: 'agents-folder', restorePath: '.agents/skills/example'},
    ]) {
      await atomicWrite(manifestPath, JSON.stringify({...snapshot, ...fields}));
      await assert.rejects(restoreBackup(f.paths, snapshot.id), {code: 'BACKUP_INVALID'});
      assert.equal(await readFile(join(f.destination, 'SKILL.md'), 'utf8'), 'Current managed source');
      assert.equal(await readFile(join(f.paths.backups, snapshot.id, snapshot.route, snapshot.folderName, 'SKILL.md'), 'utf8'), 'Edited tool cache');
    }
    await atomicWrite(manifestPath, JSON.stringify(snapshot));
    assert.deepEqual(await listBackups(f.paths), [snapshot]);
  } finally {route.readPath = previous; await f.close();}
});

test('TLS-19 snapshot creation still requires the currently configured readPath', async () => {
  const f = await fixture(), route = TOOL_MATRIX.routes['claude-plugin'], previous = route.readPath;
  try {
    const changedRoot = join(f.home, '.claude/plugins/cache/maddots-ai-v2');
    await mkdir(changedRoot);
    for (const readPath of ['~/.claude/plugins/cache/maddots-ai-v2', null]) {
      route.readPath = readPath;
      await assert.rejects(snapshotReadCopy(f.paths, f.source, f.destination, 'claude-plugin', f.digest), {code: 'BACKUP_INVALID'});
    }
    assert.deepEqual(await listBackups(f.paths), []);
    assert.equal(await readFile(join(f.source, 'SKILL.md'), 'utf8'), 'Edited tool cache');
    assert.equal(await readFile(join(f.destination, 'SKILL.md'), 'utf8'), 'Current managed source');
  } finally {route.readPath = previous; await f.close();}
});
