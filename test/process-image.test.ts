import assert from 'node:assert/strict';
import test from 'node:test';
import { type Runner } from '../src/config.js';
import { processImages as nativeProcessImages } from '../src/process-image.js';

// Keep the Darwin bridge contract exercised on Linux CI as well.
const processImages = (pids: number[], runner: Runner) => nativeProcessImages(pids, runner, {platform: 'darwin'});

const result = (rows: unknown, stderr = ''): Runner => async () => ({stdout: JSON.stringify(rows), stderr});

test('process images use a fixed native-path bridge with numeric arguments and an empty environment', async () => {
  const image = '/Applications/AI Tool.app/Contents/MacOS/AI Tool';
  const runner: Runner = async (file, args, options) => {
    assert.equal(file, '/usr/bin/osascript');
    assert.deepEqual(args.slice(0, 3), ['-l', 'JavaScript', '-e']);
    assert.match(args[3], /ObjC\.bindFunction\('proc_pidpath'/u);
    assert.match(args[3], /NSMutableData\.dataWithLength\(4096\)/u);
    assert.match(args[3], /buffer\.mutableBytes/u);
    assert.doesNotMatch(args[3], /KERN_PROCARGS|NSProcessInfo|doShellScript|eval\(/u);
    assert.deepEqual(args.slice(4), ['410', '411']);
    assert.deepEqual(options, {env: {}, timeout: 10_000});
    return {stdout: JSON.stringify([[410, image], [411, '/bin/zsh']]), stderr: ''};
  };
  assert.deepEqual(await processImages([410, 411, 410], runner), new Map([[410, image], [411, '/bin/zsh']]));
});

test('an empty process inventory does not start native inspection', async () => {
  assert.deepEqual(await processImages([], async () => assert.fail('no native command needed')), new Map());
});

test('process image requests reject invalid PIDs before starting inspection', async () => {
  for (const pid of [0, -1, 1.5, NaN, Infinity, 2_147_483_648]) {
    await assert.rejects(processImages([pid], async () => assert.fail('invalid request must not run')), {code: 'HELPER_BUSY'});
  }
});

test('only explicit kernel ESRCH results omit a requested process image', async () => {
  assert.deepEqual(await processImages([1, 2], result([[1, '/bin/zsh'], [2, null, 'ESRCH']])), new Map([[1, '/bin/zsh']]));
  for (const row of [[1, null], [1, null, 'EPERM'], [1, '/bin/zsh', 'ESRCH'], [2, null, 'ESRCH']]) {
    await assert.rejects(processImages([1], result([row])), {code: 'HELPER_BUSY'});
  }
});

test('process images refuse incomplete, ambiguous, unexpected, or unsafe results', async () => {
  const bad = [null, {}, [], [[1, '/bin/zsh'], [2, '/bin/sh']], [[2, '/bin/zsh']],
    [[1, '/bin/zsh', 'extra']], [['1', '/bin/zsh']], [[1, null]], [[1, 'node']],
    [[1, '/']], [[1, '/bin/../bin/zsh']], [[1, '/bin//zsh']], [[1, '/bin/zsh\u0000']],
    [[1, '/bin/zsh\n']], [[1, '/' + 'a'.repeat(4095)]]];
  for (const rows of bad) await assert.rejects(processImages([1], result(rows)), {code: 'HELPER_BUSY'});
  await assert.rejects(processImages([1, 2], result([[1, '/bin/zsh'], [1, '/bin/sh']])), {code: 'HELPER_BUSY'});
  await assert.rejects(processImages([1], result([[1, '/bin/zsh']], 'inspection incomplete')), {code: 'HELPER_BUSY'});
});

test('native failure and truncated JSON preserve the barrier without exposing command output', async () => {
  for (const runner of [
    async () => { throw new Error('private-command-output'); },
    async () => ({stdout: '[[1,"/bin/', stderr: ''}),
  ] satisfies Runner[]) {
    await assert.rejects(processImages([1], runner), error => {
      assert.equal((error as {code: string}).code, 'HELPER_BUSY');
      assert.doesNotMatch((error as Error).message, /private-command-output/u);
      return true;
    });
  }
});

test('large inventories are bounded and a later missing image never returns a partial map', async () => {
  const pids = Array.from({length: 129}, (_, index) => index + 1), sizes: number[] = [];
  const runner: Runner = async (_file, args) => {
    const batch = args.slice(4).map(Number); sizes.push(batch.length);
    return {stdout: JSON.stringify(batch.map(pid => [pid, '/bin/zsh'])), stderr: ''};
  };
  assert.equal((await processImages(pids, runner)).size, pids.length);
  assert.deepEqual(sizes, [128, 1]);
  let calls = 0;
  await assert.rejects(processImages(pids, async (file, args, options) => {
    if (++calls === 2) return {stdout: '[]', stderr: ''};
    return runner(file, args, options);
  }), {code: 'HELPER_BUSY'});
});
