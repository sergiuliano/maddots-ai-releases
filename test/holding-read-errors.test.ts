import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import fsPromises, { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { treeDigest } from '../src/shared/build-format.js';
import { readConfig } from '../src/config.js';
import { HoldingStore } from '../src/holding.js';
import { createPaths, ensurePaths } from '../src/paths.js';
import { BuildVerifier, signedBuildString, type PlanItem, type SignedBuild } from '../src/verify.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-holding-read-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await mkdir(home, { mode: 0o700 });
  const paths = await createPaths(readConfig({ MADDOTS_AI_HOME: join(root, 'data') }, home));
  await ensurePaths(paths);
  const signer = generateKeyPairSync('ed25519');
  const publicKey = signer.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const keyId = createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
  const verifier = new BuildVerifier({ keys: [{ keyId, publicKey: publicKey.toString('base64') }], env: {} });
  const holding = new HoldingStore(paths, 'helper-holding-read', verifier);
  const items: PlanItem[] = [];
  for (const skillId of ['affected-skill', 'healthy-skill']) {
    const content = Buffer.from('!printf held-code\n');
    const files = [{ path: 'SKILL.md', mode: '100644' as const, content }];
    const build: SignedBuild = {
      format: 1, keyId, skillId, version: 1, settingsRevision: 0, level: 'workspace',
      workspaceId: 'workspace-one', boardId: null, target: 'folder', name: skillId,
      hasCode: true, draft: false, digest: treeDigest(files), signature: '',
      report: { renamedFrom: null, unresolvedOptionalReferences: [], unsetSettings: [] },
      files: files.map(file => ({ path: file.path, mode: file.mode, size: file.content.length,
        sha256: createHash('sha256').update(file.content).digest('hex'), content: file.content.toString('base64') })),
    };
    build.signature = sign(null, Buffer.from(signedBuildString(build)), signer.privateKey).toString('base64');
    const item: PlanItem = {
      itemId: createHash('sha256').update(skillId).digest('hex'), kind: 'install', skillId,
      name: skillId, sourceName: skillId, level: 'workspace', workspaceId: build.workspaceId,
      workspaceIds: [build.workspaceId], boardIds: [], target: 'folder', route: 'agents-folder',
      fromVersion: null, version: 1, settingsRevision: 0, digest: build.digest, hasCode: true,
      draft: false, dependencyOf: null, missingDependencies: [], forAgentIds: [], state: 'approved',
      answer: 'update', reason: null, restartHints: [],
    };
    await holding.hold(verifier.verify(build, item, { target: item.target }), item);
    items.push(item);
  }
  const affected = (await holding.entries()).find(entry => entry.build.skillId === 'affected-skill')!;
  return { holding, items, affected, archive: join(paths.data, 'holding-records') };
}

for (const code of ['EMFILE', 'EACCES', 'EIO']) {
  test(`${code} leaves unreadable holding records in place and retries them on the next pass`, async t => {
    const f = await fixture(t);
    const original = await readFile(f.affected.file, 'utf8'), before = await lstat(f.affected.file);
    const originalOpen = fsPromises.open;
    let failures = 0;
    fsPromises.open = async (path, flags, mode) => {
      if (String(path) === f.affected.file) {
        failures++;
        throw Object.assign(new Error('Injected holding read failure.'), { code });
      }
      return originalOpen(path, flags, mode);
    };
    syncBuiltinESMExports();
    try {
      assert.deepEqual((await f.holding.entries()).map(entry => entry.build.skillId), ['healthy-skill']);
      assert.deepEqual([...f.holding.invalid], [f.affected.file]);
      await f.holding.reconcile(f.items, []);
      assert.equal(failures, 2, 'reconciliation retries the same unreadable record');
      assert.deepEqual([...f.holding.invalid], [f.affected.file]);
      assert.equal((await lstat(f.affected.file)).ino, before.ino, 'the held record is not moved or recreated');
      assert.equal(await readFile(f.affected.file, 'utf8'), original);
      await assert.rejects(lstat(f.archive), { code: 'ENOENT' });
    } finally {
      fsPromises.open = originalOpen;
      syncBuiltinESMExports();
    }
    await f.holding.reconcile(f.items, []);
    assert.equal(f.holding.invalid.size, 0);
    assert.deepEqual((await f.holding.entries()).map(entry => entry.build.skillId).sort(), ['affected-skill', 'healthy-skill']);
    assert.equal(await readFile(f.affected.file, 'utf8'), original);
    await assert.rejects(lstat(f.archive), { code: 'ENOENT' });
  });
}

for (const corruption of ['SyntaxError', 'HelperError']) {
  test(`${corruption} holding records are archived once with their original bytes preserved`, async t => {
    const f = await fixture(t);
    const original = await readFile(f.affected.file, 'utf8');
    const corrupt = corruption === 'SyntaxError' ? '{invalid-json\n' : JSON.stringify({ ...JSON.parse(original), format: 0 }) + '\n';
    await writeFile(f.affected.file, corrupt);
    await f.holding.reconcile(f.items, []);
    assert.deepEqual([...f.holding.invalid], [f.affected.file]);
    await assert.rejects(lstat(f.affected.file), { code: 'ENOENT' });
    const archived = await readdir(f.archive);
    assert.equal(archived.length, 1);
    assert.match(archived[0], /^unverifiable-/u);
    assert.equal(await readFile(join(f.archive, archived[0]), 'utf8'), corrupt);
    assert.deepEqual((await f.holding.entries()).map(entry => entry.build.skillId), ['healthy-skill']);
    assert.equal(f.holding.invalid.size, 0);
    await f.holding.reconcile(f.items, []);
    assert.deepEqual(await readdir(f.archive), archived);
    assert.equal(await readFile(join(f.archive, archived[0]), 'utf8'), corrupt);
  });
}
