import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { backupFolder, listBackups, restoreBackup } from '../src/backups.js';
import { HelperError, readConfig } from '../src/config.js';
import { createPaths, ensurePaths } from '../src/paths.js';
import { assertRouteRoot, atomicWriteBuild, durableRename, readSkillTree, stageBuild } from '../src/safe-fs.js';

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-safe-fs-'));
  const home = join(root, 'home');
  await mkdir(home, { mode: 0o700 });
  const paths = await createPaths(readConfig({}, home));
  await ensurePaths(paths);
  const route = join(home, '.agents/skills');
  await mkdir(route, { recursive: true, mode: 0o700 });
  return { root, home, paths, route, close: () => rm(root, { recursive: true, force: true }) };
}

const files = [
  { path: 'SKILL.md', mode: '100644' as const, content: Buffer.from('# Safe skill\n') },
  { path: 'scripts/run.sh', mode: '100755' as const, content: Buffer.from('exit 0\n') },
];

test('serialized build writes replace private files larger than 4 MiB and retain the 16 MiB bound', async () => {
  const f = await fixture();
  try {
    const directory = join(f.paths.data, 'cache/builds'), path = join(directory, 'large.json');
    const first = JSON.stringify({ content: 'a'.repeat(5 * 1024 * 1024) });
    const second = JSON.stringify({ content: 'b'.repeat(6 * 1024 * 1024) });
    await atomicWriteBuild(path, first);
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    await atomicWriteBuild(path, second);
    assert.equal(await readFile(path, 'utf8'), second);
    await assert.rejects(atomicWriteBuild(path, 'c'.repeat(16 * 1024 * 1024 + 1)), { code: 'BUILD_TOO_LARGE' });
    assert.equal(await readFile(path, 'utf8'), second);
    assert.deepEqual(await readdir(directory), ['large.json']);
    await chmod(path, 0o644);
    await assert.rejects(atomicWriteBuild(path, '{}'), { code: 'FILE_UNSAFE' });
    await chmod(path, 0o600);
    const linked = join(directory, 'linked.json');
    await symlink(path, linked);
    await assert.rejects(atomicWriteBuild(linked, '{}'), /symlink/);
    assert.equal(await readFile(path, 'utf8'), second);
    const tooLarge = join(directory, 'oversize.json');
    await writeFile(tooLarge, 'x'.repeat(16 * 1024 * 1024 + 1), { mode: 0o600 });
    await assert.rejects(atomicWriteBuild(tooLarge, '{}'), { code: 'FILE_UNSAFE' });
    assert.equal((await lstat(tooLarge)).size, 16 * 1024 * 1024 + 1);
  } finally { await f.close(); }
});

test('stages exclusive private files, preserves executable modes, and reads a tree without local metadata', async () => {
  const f = await fixture();
  try {
    const staged = await stageBuild(f.paths, files, { format: 1, skillId: 'skill' });
    const next = await stageBuild(f.paths, files, { format: 1 });
    assert.notEqual(staged, next);
    assert.equal(dirname(staged), join(f.paths.data, 'staging'));
    assert.equal((await lstat(staged)).mode & 0o777, 0o700);
    assert.equal((await lstat(join(staged, 'SKILL.md'))).mode & 0o777, 0o644);
    assert.equal((await lstat(join(staged, 'scripts/run.sh'))).mode & 0o777, 0o755);
    assert.equal((await lstat(join(staged, '.maddots/skill.json'))).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(join(staged, '.maddots/skill.json'), 'utf8')), { format: 1, skillId: 'skill' });
    await durableRename(staged, join(f.route, 'sample'));
    await writeFile(join(f.route, 'sample/.DS_Store'), 'ignored');
    await writeFile(join(f.route, 'sample/scripts/.DS_Store'), 'ignored');
    assert.deepEqual(await readSkillTree(join(f.route, 'sample'), f.home), files);
  } finally { await f.close(); }
});

test('staging refuses traversals, metadata, collisions and size violations before creating files', async () => {
  const f = await fixture();
  try {
    const invalid = [
      [{ ...files[0], path: '../outside' }], [{ ...files[0], path: '/outside' }],
      [{ ...files[0], path: '.maddots/skill.json' }], [{ ...files[0], path: 'nested/.DS_Store' }],
      [{ ...files[0], path: 'e\u0301.md' }], [{ ...files[0], path: 'a\\b' }],
      [files[0], files[0]], [{ ...files[0], path: 'a' }, { ...files[0], path: 'a/b' }],
      [{ ...files[0], content: Buffer.alloc(1024 * 1024 + 1) }],
      [{ ...files[0], path: 'a/'.repeat(8) + 'file' }],
      Array.from({ length: 501 }, (_, index) => ({ ...files[0], path: `file-${index}` })),
    ];
    for (const value of invalid) await assert.rejects(stageBuild(f.paths, value, {}), HelperError);
    assert.deepEqual(await readdir(join(f.paths.data, 'staging')), []);
  } finally { await f.close(); }
});

test('local tree reads bound zero-byte file counts and path depth as well as bytes', async () => {
  const f = await fixture();
  try {
    const many = join(f.route, 'many');
    await mkdir(many);
    await Promise.all(Array.from({ length: 501 }, (_, index) => writeFile(join(many, `file-${index}`), '')));
    await assert.rejects(readSkillTree(many, f.home), { code: 'BUILD_TOO_LARGE' });
    const deep = join(f.route, 'deep'), directory = join(deep, ...Array.from({ length: 8 }, () => 'nested'));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'file'), '');
    await assert.rejects(readSkillTree(deep, f.home), { code: 'BUILD_INVALID' });
  } finally { await f.close(); }
});

test('routes must be real HOME folders outside helper data, maddots-mcp and Claude skills', async () => {
  const f = await fixture();
  try {
    await assertRouteRoot(f.paths, f.route);
    for (const path of [f.home, f.root, f.paths.data, join(f.paths.data, 'staging'), join(f.home, '.claude/skills'), join(f.home, '.config/ibl-projects-mcp'), join(f.home, '.cache/maddots-mcp')]) {
      await assert.rejects(assertRouteRoot(f.paths, path), { code: 'PATH_UNSAFE' });
    }
    const missing = join(f.home, 'missing');
    await assert.rejects(assertRouteRoot(f.paths, missing), { code: 'ENOENT' });
    const linked = join(f.home, 'linked');
    await symlink(dirname(f.route), linked);
    await assert.rejects(assertRouteRoot(f.paths, join(linked, 'skills')), /symlink/);
    const direct = join(f.home, 'direct');
    await symlink(f.route, direct);
    await assert.rejects(assertRouteRoot(f.paths, direct), /symlink/);
  } finally { await f.close(); }
});

test('tree reads and renames refuse symlinks without reading or replacing their targets', async () => {
  const f = await fixture();
  try {
    const target = join(f.root, 'outside');
    await mkdir(target);
    await writeFile(join(target, 'SKILL.md'), 'outside');
    const skill = join(f.route, 'skill');
    await mkdir(skill);
    await symlink(join(target, 'SKILL.md'), join(skill, 'SKILL.md'));
    await assert.rejects(readSkillTree(skill, f.home), /symlink/);
    await symlink(target, join(f.route, 'linked'));
    await assert.rejects(readSkillTree(join(f.route, 'linked'), f.home), /symlink/);
    const staged = await stageBuild(f.paths, files, {});
    await assert.rejects(durableRename(staged, join(f.route, 'linked')), /symlink/);
    await assert.rejects(backupFolder(f.paths, join(f.route, 'linked'), 'agents-folder', 'update', null), /symlink/);
    assert.equal(await readFile(join(target, 'SKILL.md'), 'utf8'), 'outside');
    assert.ok((await lstat(staged)).isDirectory());
  } finally { await f.close(); }
});

test('EXDEV is reported without copying or removing the source and occupied destinations are preserved', async () => {
  const f = await fixture();
  try {
    const staged = await stageBuild(f.paths, files, {}), destination = join(f.route, 'skill');
    let calls = 0;
    await assert.rejects(durableRename(staged, destination, { rename: async () => {
      calls++;
      throw Object.assign(new Error('different device'), { code: 'EXDEV' });
    } }), { code: 'EXDEV' });
    assert.equal(calls, 1);
    assert.equal(await readFile(join(staged, 'SKILL.md'), 'utf8'), files[0].content.toString());
    await assert.rejects(lstat(destination), { code: 'ENOENT' });
    await mkdir(destination);
    await writeFile(join(destination, 'keep'), 'existing');
    await assert.rejects(durableRename(staged, destination), { code: 'DESTINATION_EXISTS' });
    assert.equal(await readFile(join(destination, 'keep'), 'utf8'), 'existing');
  } finally { await f.close(); }
});

test('backups retain the original folder and home-relative manifest, and restore backs up current local edits', async () => {
  const f = await fixture();
  try {
    const destination = join(f.route, 'skill');
    await mkdir(destination);
    await writeFile(join(destination, 'SKILL.md'), 'original');
    const backup = await backupFolder(f.paths, destination, 'agents-folder', 'update', 'a'.repeat(64), Date.UTC(2026, 9, 14));
    assert.equal(backup.originalPath, '.agents/skills/skill');
    assert.equal(backup.createdAt, '2026-10-14T00:00:00.000Z');
    const saved = join(f.paths.backups, backup.id, 'agents-folder/skill');
    assert.equal(await readFile(join(saved, 'SKILL.md'), 'utf8'), 'original');
    assert.equal((await lstat(join(f.paths.backups, backup.id, 'manifest.json'))).mode & 0o777, 0o600);
    await assert.rejects(lstat(destination), { code: 'ENOENT' });
    assert.deepEqual(await listBackups(f.paths), [backup]);
    await mkdir(destination);
    await writeFile(join(destination, 'SKILL.md'), 'local edits');
    assert.deepEqual(await restoreBackup(f.paths, backup.id), backup);
    assert.equal(await readFile(join(destination, 'SKILL.md'), 'utf8'), 'original');
    const retained = await listBackups(f.paths);
    assert.equal(retained.length, 1);
    assert.equal(retained[0].reason, 'restore-replaced');
    assert.equal(await readFile(join(f.paths.backups, retained[0].id, 'agents-folder/skill/SKILL.md'), 'utf8'), 'local edits');
    assert.equal(JSON.parse(await readFile(join(f.paths.backups, backup.id, 'manifest.json'), 'utf8')).id, backup.id);
  } finally { await f.close(); }
});

test('backups refuse forged original paths, wrong routes, and symlinked storage', async () => {
  const f = await fixture();
  try {
    const destination = join(f.route, 'skill');
    await mkdir(destination);
    await writeFile(join(destination, 'SKILL.md'), 'original');
    await assert.rejects(backupFolder(f.paths, destination, 'cline-folder', 'update', null), { code: 'ENOENT' });
    const manifest = await backupFolder(f.paths, destination, 'agents-folder', 'update', null);
    const path = join(f.paths.backups, manifest.id, 'manifest.json');
    await writeFile(path, JSON.stringify({ ...manifest, originalPath: '../escaped' }));
    await assert.rejects(restoreBackup(f.paths, manifest.id), { code: 'BACKUP_INVALID' });
    await writeFile(path, JSON.stringify(manifest));
    await symlink(f.root, destination);
    await assert.rejects(restoreBackup(f.paths, manifest.id), /symlink/);
    assert.equal(await readFile(join(f.paths.backups, manifest.id, 'agents-folder/skill/SKILL.md'), 'utf8'), 'original');
    const linked = join(f.paths.data, 'linked-backups');
    await symlink(f.paths.backups, linked);
    await assert.rejects(listBackups({ ...f.paths, backups: linked }), { code: 'BACKUP_INVALID' });
  } finally { await f.close(); }
});

test('nested route backups preserve the full original path and refuse route roots and symlink ancestors', async () => {
  const f = await fixture();
  try {
    const route = join(f.home, '.maddots-ai/claude-code'), original = join(route, 'plugins/workspace/skill');
    await mkdir(original, { recursive: true, mode: 0o700 });
    await writeFile(join(original, 'SKILL.md'), 'nested original');
    await assert.rejects(backupFolder(f.paths, route, 'claude-plugin', 'update', null), { code: 'BACKUP_INVALID' });
    const manifest = await backupFolder(f.paths, original, 'claude-plugin', 'update', null);
    assert.equal(manifest.originalPath, '.maddots-ai/claude-code/plugins/workspace/skill');
    assert.equal(manifest.folderName, 'skill');
    assert.equal(await readFile(join(f.paths.backups, manifest.id, 'claude-plugin/skill/SKILL.md'), 'utf8'), 'nested original');
    assert.deepEqual(await listBackups(f.paths), [manifest]);
    await restoreBackup(f.paths, manifest.id);
    assert.equal(await readFile(join(original, 'SKILL.md'), 'utf8'), 'nested original');
    const linked = join(route, 'linked');
    await symlink(join(route, 'plugins'), linked);
    await assert.rejects(backupFolder(f.paths, join(linked, 'workspace/skill'), 'claude-plugin', 'update', null), /symlink/);
    assert.equal(await readFile(join(original, 'SKILL.md'), 'utf8'), 'nested original');
  } finally { await f.close(); }
});
