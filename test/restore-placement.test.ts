import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { placeRestoredObject, restoredObjectState } from '../src/safe-fs.js';

type ObjectKind = 'file' | 'symlink' | 'directory';
const kinds: ObjectKind[] = ['file', 'symlink', 'directory'];
const absent = (path: string) => assert.rejects(lstat(path), {code: 'ENOENT'});

async function makeObject(path: string, kind: ObjectKind, contents: string): Promise<void> {
  if (kind === 'file') await writeFile(path, contents, {mode: 0o600, flag: 'wx'});
  else if (kind === 'symlink') await symlink(contents, path);
  else { await mkdir(path, {mode: 0o700}); await writeFile(join(path, 'SKILL.md'), contents); }
}

async function objectContents(path: string, kind: ObjectKind): Promise<string> {
  return kind === 'symlink' ? readlink(path) : readFile(kind === 'directory' ? join(path, 'SKILL.md') : path, 'utf8');
}

async function fixture(kind: ObjectKind) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-restore-placement-'));
  const home = join(root, 'home'), backups = join(root, 'backups');
  await mkdir(home, {mode: 0o700}); await mkdir(backups, {mode: 0o700});
  const source = join(backups, 'saved'), destination = join(home, 'restored');
  const contents = kind === 'symlink' ? '../missing-original-target' : 'Saved original';
  await makeObject(source, kind, contents);
  return {root, home, backups, source, destination, contents, close: () => rm(root, {recursive: true, force: true})};
}

for (const kind of kinds) test(`restore placement preserves ${kind} contents and journals success while retaining file and link evidence`, async t => {
  const f = await fixture(kind); t.after(f.close);
  const original = await lstat(f.source);
  await placeRestoredObject(f.source, f.destination);
  if (kind === 'directory') await absent(f.source);
  else assert.equal(await objectContents(f.source, kind), f.contents);
  assert.equal(await restoredObjectState(f.source, f.destination), 'restored');
  assert.equal(await objectContents(f.destination, kind), f.contents);
  const restored = await lstat(f.destination);
  if (kind === 'symlink') {
    assert.ok(restored.isSymbolicLink());
    assert.notEqual(restored.ino, original.ino, 'symbolic links are exclusively recreated while retaining the saved inode');
  } else {
    assert.equal(restored.dev, original.dev);
    assert.equal(restored.ino, original.ino, 'file hard links and directory renames retain the original inode');
  }
});

for (const kind of kinds) for (const step of ['beforePlace', 'afterIntent', 'afterPlace', 'beforeConsume', 'afterConsume'] as const) {
  test(`restore retries a ${kind} after interruption at ${step} without replacing its destination`, async t => {
    const f = await fixture(kind); t.after(f.close);
    await assert.rejects(placeRestoredObject(f.source, f.destination, {[step]: async () => {throw new Error('Interrupted restore');}}), /Interrupted restore/);
    const placed = await lstat(f.destination).catch(() => null);
    await placeRestoredObject(f.source, f.destination);
    const restored = await lstat(f.destination);
    if (placed) assert.equal(restored.ino, placed.ino);
    await placeRestoredObject(f.source, f.destination);
    assert.equal((await lstat(f.destination)).ino, restored.ino);
    assert.equal(await objectContents(f.destination, kind), f.contents);
    assert.equal(await restoredObjectState(f.source, f.destination), 'restored');
  });
}

for (const kind of kinds) for (const occupant of kinds) test(`restore refuses a raced-in ${occupant} while retaining the saved ${kind}`, async t => {
  const f = await fixture(kind); t.after(f.close);
  const original = await lstat(f.source);
  const userContents = occupant === 'symlink' ? '../user-target' : 'New user object';
  await writeFile(join(f.root, 'user-target'), 'Never overwrite this target');
  let occupantInode = 0;
  await assert.rejects(placeRestoredObject(f.source, f.destination, {beforePlace: async () => {
    await makeObject(f.destination, occupant, userContents);
    occupantInode = (await lstat(f.destination)).ino;
  }}), {code: 'DESTINATION_EXISTS'});
  assert.equal((await lstat(f.source)).ino, original.ino);
  assert.equal(await objectContents(f.source, kind), f.contents);
  assert.equal((await lstat(f.destination)).ino, occupantInode);
  assert.equal(await objectContents(f.destination, occupant), userContents);
  assert.equal(await readFile(join(f.root, 'user-target'), 'utf8'), 'Never overwrite this target');
});

test('directory restore catches an empty folder arriving before its final absence check', async t => {
  const f = await fixture('directory'); t.after(f.close);
  const original = await lstat(f.source);
  let occupantInode = 0;
  await assert.rejects(placeRestoredObject(f.source, f.destination, {beforePlace: async () => {
    await mkdir(f.destination); occupantInode = (await lstat(f.destination)).ino;
  }}), {code: 'DESTINATION_EXISTS'});
  assert.equal((await lstat(f.source)).ino, original.ino);
  assert.equal(await objectContents(f.source, 'directory'), f.contents);
  assert.equal((await lstat(f.destination)).ino, occupantInode);
});

for (const kind of kinds) test(`restore refuses a changed saved ${kind} without unlinking either source object`, async t => {
  const f = await fixture(kind); t.after(f.close);
  const original = await lstat(f.source), retained = join(f.backups, 'original-inode');
  await assert.rejects(placeRestoredObject(f.source, f.destination, {beforePlace: async () => {
    await rename(f.source, retained);
    await makeObject(f.source, kind, 'Replacement source');
  }}), {code: 'PATH_CHANGED'});
  await absent(f.destination);
  assert.equal((await lstat(retained)).ino, original.ino);
  assert.equal(await objectContents(retained, kind), f.contents);
  assert.equal(await objectContents(f.source, kind), 'Replacement source');
});

for (const side of ['source', 'destination'] as const) for (const replacement of ['symlink', 'directory'] as const) {
  test(`restore refuses a ${side} parent swapped for a ${replacement} before placement`, async t => {
    const f = await fixture('file'); t.after(f.close);
    const parent = dirname(f[side]), retained = join(f.root, 'retained-parent'), redirected = join(f.root, 'redirected-parent');
    await mkdir(redirected); await writeFile(join(redirected, 'saved'), 'Other saved file');
    await assert.rejects(placeRestoredObject(f.source, f.destination, {beforePlace: async () => {
      await rename(parent, retained);
      if (replacement === 'symlink') await symlink(redirected, parent);
      else await mkdir(parent);
    }}), {code: replacement === 'symlink' ? 'PATH_UNSAFE' : 'PATH_CHANGED'});
    assert.equal(await readFile(side === 'source' ? join(retained, 'saved') : f.source, 'utf8'), f.contents);
    assert.equal(await readFile(join(redirected, 'saved'), 'utf8'), 'Other saved file');
    await absent(join(redirected, 'restored'));
    await absent(side === 'destination' ? join(retained, 'restored') : f.destination);
  });
}
