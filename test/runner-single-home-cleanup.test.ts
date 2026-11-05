import assert from 'node:assert/strict';
import * as filesystem from 'node:fs/promises';
import {mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import {createRequire, syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {cleanupRunHome} from '../src/runner/process.js';
import {acquireRunnerStorageLock} from '../src/runner/storage-lock.js';

const fsp = createRequire(import.meta.url)('node:fs/promises') as typeof filesystem;
const linux = {skip: process.platform !== 'linux', timeout: 10_000};
async function fixture(t: TestContext) {
  const data = await mkdtemp(join(await realpath(tmpdir()), 'mdai-single-home-'));
  const lock = await acquireRunnerStorageLock(data), directory = await lock.directory('run-homes');
  t.after(async () => {await lock.release(); await rm(data, {recursive: true, force: true});});
  const runId = 'test-owned', home = join(data, 'run-homes', runId);
  await mkdir(home, {mode: 0o700});
  await writeFile(join(home, 'sentinel'), 'retained evidence');
  await mkdir(join(home, 'vanishing'), {mode: 0o700});
  return {data, directory, runId, home};
}

for (const operation of ['lstat', 'open', 'readdir'] as const) {
  test(`S2 fix1 single-home cleanup refuses nested ENOENT from ${operation} and preserves the home`, linux, async t => {
    const {data, directory, runId, home} = await fixture(t);
    const originalLstat = fsp.lstat, originalOpen = fsp.open, originalReaddir = fsp.readdir;
    let intercepted = false, nestedFd: number | undefined;
    const missing = () => {intercepted = true; return Object.assign(new Error('nested entry vanished'), {code: 'ENOENT'});};
    t.after(() => {fsp.lstat = originalLstat; fsp.open = originalOpen; fsp.readdir = originalReaddir; syncBuiltinESMExports();});
    if (operation === 'lstat') {
      fsp.lstat = (async (...args: Parameters<typeof originalLstat>) => {
        if (String(args[0]).startsWith('/proc/self/fd/') && String(args[0]).endsWith('/vanishing')) throw missing();
        return originalLstat(...args);
      }) as typeof originalLstat;
    } else {
      fsp.open = (async (...args: Parameters<typeof originalOpen>) => {
        if (String(args[0]).startsWith('/proc/self/fd/') && String(args[0]).endsWith('/vanishing')) {
          if (operation === 'open') throw missing();
          const file = await originalOpen(...args); nestedFd = file.fd; return file;
        }
        return originalOpen(...args);
      }) as typeof originalOpen;
      fsp.readdir = (async (...args: Parameters<typeof originalReaddir>) => {
        if (nestedFd !== undefined && String(args[0]) === `/proc/self/fd/${nestedFd}`) throw missing();
        return originalReaddir(...args);
      }) as typeof originalReaddir;
    }
    syncBuiltinESMExports();
    const before = (await readdir('/proc/self/fd')).length;
    await assert.rejects(cleanupRunHome(data, runId, {directory}), {code: 'ENOENT'});
    assert.equal(intercepted, true);
    assert.equal(await readFile(join(home, 'sentinel'), 'utf8'), 'retained evidence');
    assert.deepEqual((await readdir(home)).sort(), ['sentinel', 'vanishing']);
    assert.equal((await readdir('/proc/self/fd')).length, before, 'failed traversal closes every child descriptor');
  });
}

test('S2 fix1 single-home cleanup accepts only a missing top-level home', linux, async t => {
  const {data, directory, home} = await fixture(t);
  await cleanupRunHome(data, 'missing-home', {directory});
  assert.equal(await readFile(join(home, 'sentinel'), 'utf8'), 'retained evidence');
});
