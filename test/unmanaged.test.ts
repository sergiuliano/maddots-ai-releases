import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readConfig } from '../src/config.js';
import { createPaths } from '../src/paths.js';
import { assertUnmanagedTarget, listUnmanaged, resolveToolFolder, toolHomeRoot, toolHomes, unmanagedInventory } from '../src/unmanaged.js';
import { BuildVerifier, signedBuildString } from '../src/verify.js';

async function fixture() {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'mdai-unmanaged-'));
  const paths = await createPaths(readConfig({}, home));
  async function folder(root: string, name: string, text = '# Ordinary instructions') {
    const path = join(home, root, name);
    await mkdir(path, {recursive: true}); await writeFile(join(path, 'SKILL.md'), text);
    return path;
  }
  return {home, paths, folder, close: () => rm(home, {recursive: true, force: true})};
}

test('all matrix Codex homes and nested tool homes are listed with stable keys', async () => {
  const f = await fixture();
  try {
    await f.folder('.codex/skills', 'default');
    await f.folder('.codex-work/skills', 'work');
    await f.folder('.codex-extra/skills', 'extra');
    await f.folder('.config/opencode/skills', 'open');
    await f.folder('.dsh/skills', 'deepseek');
    await f.folder('.agents/skills', 'shared');
    await f.folder('.unknown/skills', 'ignored');
    const homes = await toolHomes(f.paths);
    assert.deepEqual(homes.filter(home => home.home.startsWith('.codex')).map(home => home.home), ['.codex', '.codex-extra', '.codex-work']);
    assert.ok(homes.find(home => home.home === '.agents')!.tools.includes('codex'));
    const folders = await listUnmanaged(f.paths);
    assert.equal(folders.length, 6);
    assert.ok(folders.some(folder => folder.home === '.config:opencode'));
    assert.equal(await toolHomeRoot(f.paths, '.codex-unused'), join(f.home, '.codex-unused/skills'));
    assert.equal(await toolHomeRoot(f.paths, '.gemini:config'), join(f.home, '.gemini/config/skills'));
    for (const home of ['../bad', '.unknown', '.codex:..', '.config/opencode']) {
      await assert.rejects(toolHomeRoot(f.paths, home), {code: 'PATH_UNSAFE'});
    }
  } finally { await f.close(); }
});

test('one outer link resolves locally, aliases deduplicate and inventory contains names only', async () => {
  const f = await fixture();
  try {
    const source = await f.folder('.codex/skills', 'source');
    await mkdir(join(f.home, '.agents/skills'), {recursive: true});
    await mkdir(join(f.home, '.codex-work/skills'), {recursive: true});
    await symlink(source, join(f.home, '.agents/skills/alias'));
    await symlink('../../.codex/skills/source', join(f.home, '.codex-work/skills/second'));
    const resolved = await resolveToolFolder(f.paths, {home: '.agents', folderName: 'alias'});
    assert.deepEqual(resolved.link, {target: source, targetName: 'source', targetHome: '.codex'});
    const folders = await listUnmanaged(f.paths);
    assert.equal(folders.length, 1); assert.equal(folders[0].home, '.codex');
    assert.equal(folders[0].link, null);
    assert.deepEqual(folders[0].alsoLinkedFrom, [{home: '.agents', folderName: 'alias'}, {home: '.codex-work', folderName: 'second'}]);
    const inventory = unmanagedInventory(folders);
    assert.equal(inventory.length, 3);
    assert.equal(JSON.stringify(inventory).includes(f.home), false);
    assert.deepEqual(inventory.find(row => row.folderName === 'alias')!.link, {targetName: 'source', targetHome: '.codex'});
    const external = await f.folder('my-skills', 'outside-route');
    await symlink(external, join(f.home, '.agents/skills/external'));
    assert.deepEqual((await resolveToolFolder(f.paths, {home: '.agents', folderName: 'external'})).link,
      {target: external, targetName: 'outside-route', targetHome: null});
  } finally { await f.close(); }
});

test('unsafe roots, chained targets, interior links, protected storage and traversal are refused', async () => {
  const f = await fixture();
  try {
    const source = await f.folder('.codex/skills', 'source');
    await mkdir(join(f.home, '.agents/skills'), {recursive: true});
    await symlink(source, join(f.home, '.agents/skills/first'));
    await symlink(join(f.home, '.agents/skills/first'), join(f.home, '.agents/skills/chain'));
    await symlink(join(f.home, '.codex'), join(f.home, '.codex-link'));
    await symlink(join(f.home, '.codex/skills'), join(f.home, 'linked-parent'));
    await symlink(join(f.home, 'linked-parent/source'), join(f.home, '.agents/skills/interior'));
    const protectedTarget = await f.folder('.config/ibl-projects-mcp', 'private');
    await symlink(protectedTarget, join(f.home, '.agents/skills/protected'));
    await mkdir(join(f.paths.data, 'private'), {recursive: true});
    await symlink(join(f.paths.data, 'private'), join(f.home, '.agents/skills/data'));
    await symlink('/etc', join(f.home, '.agents/skills/outside'));
    for (const folderName of ['chain', 'interior', 'protected', 'data', 'outside', '../source']) {
      await assert.rejects(resolveToolFolder(f.paths, {home: '.agents', folderName}), {code: 'PATH_UNSAFE'});
    }
    assert.ok(!(await toolHomes(f.paths)).some(home => home.home === '.codex-link'));
    const unsafeFolder = await f.folder('.codex/skills', 'inner-link');
    await symlink(join(source, 'SKILL.md'), join(unsafeFolder, 'linked.md'));
    assert.equal((await listUnmanaged(f.paths)).find(folder => folder.folderName === 'inner-link')?.hasScripts, true);
    await assert.rejects(assertUnmanagedTarget(f.paths, join(f.home, '.claude/skills/something')), {code: 'PATH_UNSAFE'});
    await assert.doesNotReject(assertUnmanagedTarget(f.paths, join(f.home, 'my-skills/missing')));
  } finally { await f.close(); }
});

test('oversized files and trees remain listed conservatively for upload checks', async () => {
  const f = await fixture();
  try {
    await f.folder('.codex/skills', 'plain');
    const large = await f.folder('.codex/skills', 'large-file');
    await writeFile(join(large, 'reference.bin'), Buffer.alloc(1024 * 1024 + 1));
    const heavy = await f.folder('.codex/skills', 'large-tree');
    for (let index = 0; index < 11; index++) {
      await writeFile(join(heavy, `reference-${index}.bin`), Buffer.alloc(1024 * 1024));
    }
    assert.deepEqual(unmanagedInventory(await listUnmanaged(f.paths)), [
      {home: '.codex', folderName: 'large-file', hasScripts: true, link: null},
      {home: '.codex', folderName: 'large-tree', hasScripts: true, link: null},
      {home: '.codex', folderName: 'plain', hasScripts: false, link: null}
    ]);
  } finally { await f.close(); }
});

test('an unreadable leaf skills directory does not hide folders in other tool homes', {skip: process.getuid?.() === 0}, async () => {
  const f = await fixture(), deniedRoot = join(f.home, '.omp/skills');
  try {
    await f.folder('.codex/skills', 'mine');
    await mkdir(deniedRoot, {recursive: true});
    await chmod(deniedRoot, 0o000);
    assert.deepEqual((await listUnmanaged(f.paths)).map(({home, folderName}) => ({home, folderName})), [
      {home: '.codex', folderName: 'mine'}
    ]);
  } finally {
    await chmod(deniedRoot, 0o700);
    await f.close();
  }
});

test('only signature checked stamps from a known helper suppress unmanaged entries', async () => {
  const f = await fixture();
  try {
    const signer = generateKeyPairSync('ed25519');
    const publicKey = signer.publicKey.export({type: 'spki', format: 'der'}).subarray(-32);
    const keyId = createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
    const verifier = new BuildVerifier({keys: [{keyId, publicKey: publicKey.toString('base64')}], env: {}});
    const stamp = {format: 1 as const, keyId, skillId: 'test', version: 1, settingsRevision: 0, digest: 'a'.repeat(64), level: 'workspace' as const,
      workspaceId: 'workspace', target: 'folder' as const, name: 'managed', sourceName: 'managed', workspaceIds: ['workspace'],
      helperId: 'helper', deliveredAt: new Date().toISOString(), signature: ''};
    stamp.signature = sign(null, Buffer.from(signedBuildString(stamp)), signer.privateKey).toString('base64');
    for (const [name, changes] of [['managed', {}], ['forged', {signature: Buffer.alloc(64).toString('base64')}], ['foreign', {helperId: 'other'}]] as const) {
      const path = await f.folder('.codex/skills', name);
      await mkdir(join(path, '.maddots'));
      await writeFile(join(path, '.maddots/skill.json'), JSON.stringify({...stamp, ...changes}), {mode: 0o600});
    }
    assert.deepEqual((await listUnmanaged(f.paths, {verifier, helperIds: ['helper']})).map(folder => folder.folderName), ['foreign', 'forged']);
    assert.equal((await listUnmanaged(f.paths, {verifier, helperIds: []})).length, 3);
  } finally { await f.close(); }
});

test('code metadata detects script files, executable files and command instructions', async () => {
  const f = await fixture();
  try {
    await f.folder('.codex/skills', 'plain');
    const scripts = await f.folder('.codex/skills', 'scripts');
    await mkdir(join(scripts, 'scripts')); await writeFile(join(scripts, 'scripts/run.py'), 'pass');
    const executable = await f.folder('.codex/skills', 'executable');
    await writeFile(join(executable, 'run'), 'true', {mode: 0o755});
    const nestedExecutable = await f.folder('.codex/skills', 'nested-executable');
    await mkdir(join(nestedExecutable, 'tools'));
    await writeFile(join(nestedExecutable, 'tools/run'), 'true', {mode: 0o755});
    await f.folder('.codex/skills', 'commands', '!echo test');
    await f.folder('.codex/skills', 'allowed', '---\nallowed-tools: Read\n---\nInstructions');
    const folders = await listUnmanaged(f.paths);
    assert.deepEqual(folders.filter(folder => folder.hasScripts).map(folder => folder.folderName), ['allowed', 'commands', 'executable', 'nested-executable', 'scripts']);
  } finally { await f.close(); }
});

test('inventory omits credential-bearing refs and redacts credential-bearing link targets', async () => {
  const f = await fixture();
  try {
    const secret = 'mdai_skill_' + 'synthetic'.repeat(4);
    await f.folder('.codex/skills', secret);
    await f.folder(`.codex-${secret}/skills`, 'secret-home');
    const target = await f.folder('local-skills', secret);
    await mkdir(join(f.home, '.agents/skills'), {recursive: true});
    await symlink(target, join(f.home, '.agents/skills/safe-alias'));
    await symlink(target, join(f.home, '.agents/skills', secret));
    const inventory = unmanagedInventory(await listUnmanaged(f.paths));
    assert.deepEqual(inventory, [{home: '.agents', folderName: 'safe-alias', hasScripts: false,
      link: {targetName: '[redacted]', targetHome: null}}]);
    assert.equal(JSON.stringify(inventory).includes(secret), false);
    assert.equal(JSON.stringify(inventory).includes(f.home), false);
  } finally { await f.close(); }
});
