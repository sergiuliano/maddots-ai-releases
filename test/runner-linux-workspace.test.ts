import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile} from 'node:fs/promises';
import {createRequire, syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {LinuxWorkspace} from '../src/runner/linux-workspace.js';

async function fixture(t: TestContext, assertPublicContent?: (value: Buffer | string) => void) {
  const root = await mkdtemp(join(tmpdir(), 'mdai-s3-workspace-'));
  const source = join(root, 'project'), work = join(root, 'private-work'), data = join(root, 'controller');
  for (const path of [source, work, data]) await mkdir(path, {mode: 0o700});
  const workspace = new LinuxWorkspace(source, data, '/usr/bin/true', undefined, assertPublicContent);
  t.after(async () => {await workspace.close(); await rm(root, {recursive: true, force: true});});
  return {root, source, work, data, workspace};
}

test('S3 workspace copies ordinary files, maps source paths, and publishes only after CLEAN', async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'file.txt'), 'before', {mode: 0o600});
  await mkdir(join(f.source, 'nested'));
  await f.workspace.stage(f.work);
  assert.equal(f.workspace.map(join(f.source, 'nested/file.txt')), '/work/nested/file.txt');
  assert.equal(await readFile(join(f.work, 'file.txt'), 'utf8'), 'before');
  await writeFile(join(f.work, 'file.txt'), 'after');
  await writeFile(join(f.work, 'nested/result.txt'), 'result');
  await assert.rejects(f.workspace.publish(() => false));
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'before');
  await f.workspace.publish(() => true);
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'after');
  assert.equal(await readFile(join(f.source, 'nested/result.txt'), 'utf8'), 'result');
});

test('S3 workspace excludes ambient credential stores without reading or publishing them', async t => {
  const f = await fixture(t);
  for (const name of ['.env', '.npmrc', '.netrc', '.git-credentials', '.claude.json', 'oauth-token', 'selected-login.json', '.selected-login.json',
    '.selected-login-original', '.selected-login-candidate', '.selected-login-complete.json', '.mdai-selected-login-codex.json',
    '.mdai-selected-login-claude.json', '.mdai-selected-login-codex.source.tmp', '.mdai-selected-login-claude.recovery.tmp',
    '.selected-login-original.tmp', '.selected-login-candidate.tmp', '.selected-login-complete.json.tmp',
    '.mdai-login-synthetic.tmp']) await writeFile(join(f.source, name), 'fixture credential');
  for (const name of ['.aws', '.codex', '.claude', '.config', '.docker', '.ssh']) {
    await mkdir(join(f.source, name)); await writeFile(join(f.source, name, 'auth.json'), 'fixture credential');
  }
  await f.workspace.stage(f.work);
  assert.deepEqual(await readdir(f.work), []);
  await writeFile(join(f.work, '.env'), 'workload replacement');
  await writeFile(join(f.work, '.claude.json'), 'workload replacement');
  await mkdir(join(f.work, '.claude')); await writeFile(join(f.work, '.claude/settings.json'), 'workload replacement');
  await f.workspace.publish(() => true);
  assert.equal(await readFile(join(f.source, '.env'), 'utf8'), 'fixture credential');
  assert.equal(await readFile(join(f.source, '.claude.json'), 'utf8'), 'fixture credential');
  assert.deepEqual(await readdir(join(f.source, '.claude')), ['auth.json']);
});

test('S3 workspace refuses symlink inputs and workload-created output links', async t => {
  const input = await fixture(t);
  await symlink(input.data, join(input.source, 'escape'));
  await assert.rejects(input.workspace.stage(input.work));
  const output = await fixture(t);
  await output.workspace.stage(output.work);
  await symlink(output.data, join(output.work, 'escape'));
  await assert.rejects(output.workspace.publish(() => true));
  assert.deepEqual(await readdir(output.data), []);
  assert.deepEqual(await readdir(output.source), []);
});

test('S3 workspace preserves concurrent host changes and controller output logs', async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'file.txt'), 'before');
  await writeFile(join(f.source, 'stdout.log'), '');
  await f.workspace.stage(f.work);
  await writeFile(join(f.source, 'stdout.log'), 'controller output');
  await writeFile(join(f.work, 'file.txt'), 'workload result');
  await f.workspace.publish(() => true);
  assert.equal(await readFile(join(f.source, 'stdout.log'), 'utf8'), 'controller output');
  const conflict = await fixture(t);
  await writeFile(join(conflict.source, 'file.txt'), 'before');
  await conflict.workspace.stage(conflict.work);
  await writeFile(join(conflict.source, 'file.txt'), 'concurrent edit');
  await writeFile(join(conflict.work, 'file.txt'), 'workload result');
  await assert.rejects(conflict.workspace.publish(() => true));
  assert.equal(await readFile(join(conflict.source, 'file.txt'), 'utf8'), 'concurrent edit');
});

test('S5 selected login content is checked across the entire output before any workspace publication', async t => {
  const token = 'synthetic-selected-login-token';
  for (const leak of ['content', 'filename', 'directory']) {
    const f = await fixture(t, value => {
      if (value.includes(token)) throw new Error('protected output');
    });
    await writeFile(join(f.source, 'a-first.txt'), 'original');
    await f.workspace.stage(f.work);
    await writeFile(join(f.work, 'a-first.txt'), 'safe changed content');
    if (leak === 'content') await writeFile(join(f.work, 'z-last.txt'), 'copied ' + token);
    else if (leak === 'filename') await writeFile(join(f.work, 'z-' + token + '.txt'), 'ordinary content');
    else await mkdir(join(f.work, 'z-' + token));
    await assert.rejects(f.workspace.publish(() => true), {message: 'protected output'});
    assert.equal(await readFile(join(f.source, 'a-first.txt'), 'utf8'), 'original', leak);
    assert.deepEqual(await readdir(f.source), ['a-first.txt'], leak);
  }
});

test('S5 selected login publication rechecks file bytes and continues excluding private caches', async t => {
  let reads = 0;
  const f = await fixture(t, value => {
    if (Buffer.isBuffer(value) && value.toString() === 'safe output' && ++reads === 2) throw new Error('guard changed');
    assert.ok(!value.includes('synthetic-private-cache'), 'excluded caches must not enter the public scan');
  });
  await f.workspace.stage(f.work);
  await writeFile(join(f.work, 'output.txt'), 'safe output');
  await writeFile(join(f.work, 'auth.json'), 'synthetic-private-cache');
  await mkdir(join(f.work, '.mdai-home'));
  await writeFile(join(f.work, '.mdai-home/.credentials.json'), 'synthetic-private-cache');
  await assert.rejects(f.workspace.publish(() => true), {message: 'guard changed'});
  assert.equal(reads, 2, 'reread content is checked again before its temporary host file is written');
  assert.deepEqual(await readdir(f.source), []);
});

test('S5 selected login withholds an unscannable subtree without deleting its source or withholding clean siblings', async t => {
  const f = await fixture(t, () => {});
  await mkdir(join(f.source, 'nested'));
  await writeFile(join(f.source, 'nested/original.txt'), 'original host artifact');
  await f.workspace.stage(f.work);
  await rm(join(f.work, 'nested'), {recursive: true});
  await symlink('/nonexistent/synthetic-only', join(f.work, 'nested'));
  await writeFile(join(f.work, 'z-clean.txt'), 'fully scanned content');
  await f.workspace.publish(() => true);
  assert.equal(await readFile(join(f.source, 'nested/original.txt'), 'utf8'), 'original host artifact');
  assert.equal(await readFile(join(f.source, 'z-clean.txt'), 'utf8'), 'fully scanned content');
});

test('S3 selected generated run home is private and removed only after CLEAN without following hostile links', async t => {
  const f = await fixture(t), home = join(f.data, 'run-homes/fixture');
  await mkdir(home, {recursive: true, mode: 0o700});
  await writeFile(join(home, 'selected-config.json'), 'fixture per-run credential', {mode: 0o600});
  const workspace = new LinuxWorkspace(f.source, f.data, '/usr/bin/true', home);
  t.after(() => workspace.close());
  await workspace.stage(f.work);
  assert.equal(workspace.map(home), '/work/.mdai-home');
  await symlink(f.data, join(f.work, '.mdai-home/link'));
  await assert.rejects(workspace.removePrivateHome(() => false));
  await workspace.removePrivateHome(() => true);
  assert.deepEqual(await readdir(f.work), []);
  assert.equal(await readFile(join(home, 'selected-config.json'), 'utf8'), 'fixture per-run credential');
});

test('S3 workspace refuses controller storage and enclosing directory sources', async t => {
  const f = await fixture(t);
  for (const source of [f.root, f.data]) {
    const workspace = new LinuxWorkspace(source, f.data, '/usr/bin/true');
    try {await assert.rejects(workspace.stage(f.work));} finally {await workspace.close();}
  }
});

test('S5 workspace refuses selected profile ancestors, descendants and aliases before copying files', async t => {
  const f = await fixture(t), profile = join(f.source, 'profile'), nested = join(profile, 'nested'), alias = join(f.root, 'profile-alias');
  await mkdir(profile, {mode: 0o700}); await mkdir(nested, {mode: 0o700});
  await writeFile(join(profile, 'ordinary-looking.txt'), 'synthetic private profile data');
  await symlink(profile, alias);
  for (const source of [f.source, profile, nested, alias]) {
    const workspace = new LinuxWorkspace(source, f.data, '/usr/bin/true', undefined, undefined, [profile]);
    try {
      await assert.rejects(workspace.stage(f.work), {code: 'LINUX_WORKSPACE_UNAVAILABLE'});
      assert.deepEqual(await readdir(f.work), [], source);
    } finally {await workspace.close();}
  }
});

test('S3 publication refuses an observed parent moved outside its original workspace and retains the result', async t => {
  const f = await fixture(t), nested = join(f.source, 'nested'), moved = join(f.data, 'moved');
  await mkdir(nested, {mode: 0o700}); await writeFile(join(nested, 'base.txt'), 'original');
  await f.workspace.stage(f.work);
  await writeFile(join(f.work, 'nested/result.txt'), 'workload output');
  const filesystem = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises');
  const original = filesystem.open;
  let parentOpens = 0, parentMoved = false;
  const interception = t.mock.method(filesystem, 'open', async (...args: Parameters<typeof original>) => {
    const file = await original(...args);
    // The first open is the source scan. Move the second opened parent before
    // publication receives its FD, without a link or a replacement inode race.
    if (String(args[0]).startsWith('/proc/self/fd/') && String(args[0]).endsWith('/nested') &&
        await realpath(`/proc/self/fd/${file.fd}`) === nested && ++parentOpens === 2) {
      await rename(nested, moved); await mkdir(nested, {mode: 0o700}); parentMoved = true;
    }
    return file;
  });
  syncBuiltinESMExports();
  try {await assert.rejects(f.workspace.publish(() => true), {code: 'LINUX_WORKSPACE_UNAVAILABLE'});}
  finally {interception.mock.restore(); syncBuiltinESMExports();}
  assert.equal(parentMoved, true);
  assert.deepEqual(await readdir(moved), ['base.txt']);
  assert.equal(await readFile(join(moved, 'base.txt'), 'utf8'), 'original');
  assert.deepEqual(await readdir(nested), []);
  assert.equal(await readFile(join(f.work, 'nested/result.txt'), 'utf8'), 'workload output');
});

test('S5 selected login withholds a file whose parent disappears after scanning and publishes clean siblings', async t => {
  const filesystem = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
  let workDirectory = '', pathChecks = 0;
  const f = await fixture(t, value => {
    if (typeof value === 'string' && value === 'a-dir/file.txt' && ++pathChecks === 2) {
      filesystem.rmSync(join(workDirectory, 'a-dir'), {recursive: true});
    }
  });
  workDirectory = f.work;
  await mkdir(join(f.source, 'a-dir'));
  await writeFile(join(f.source, 'a-dir/file.txt'), 'original host artifact');
  await f.workspace.stage(f.work);
  await writeFile(join(f.work, 'a-dir/file.txt'), 'changed clean artifact');
  await writeFile(join(f.work, 'z-clean.txt'), 'fully scanned clean sibling');
  await f.workspace.publish(() => true);
  assert.equal(pathChecks, 2, 'the parent disappears between the complete scan and publication reread');
  assert.equal(await readFile(join(f.source, 'a-dir/file.txt'), 'utf8'), 'original host artifact');
  assert.equal(await readFile(join(f.source, 'z-clean.txt'), 'utf8'), 'fully scanned clean sibling');
});
