import assert from 'node:assert/strict';
import {mkdtemp, readdir, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {runCli} from '../src/cli.js';
import {validateCliLaunch} from '../src/cli-main.js';
import {launchCli, type RuntimeContext} from '../src/runtime.js';

const args = ['journal', 'bootstrap', '--evidence', '/etc/mdai/journal-bootstrap.json', '--sha256', 'a'.repeat(64)];
test('journal CLI requires the exact explicit Linux command and receipt pin', () => {
  assert.equal(validateCliLaunch(args, {platform: 'linux'}).command, 'journal');
  for (const argv of [args.slice(0, 1), args.slice(0, 2), args.slice(0, 4), [...args, '--force'],
    ['journal', 'repair', ...args.slice(2)], ['journal', 'bootstrap', '--evidence', 'relative', ...args.slice(4)],
    ['journal', 'bootstrap', '--evidence', '/etc/mdai/../proof.json', ...args.slice(4)],
    [...args.slice(0, 5), 'bad'], [...args.slice(0, 5), 'A'.repeat(64)]]) {
    assert.throws(() => validateCliLaunch(argv, {platform: 'linux'}), {code: 'USAGE'});
  }
  assert.throws(() => validateCliLaunch(args, {platform: 'darwin'}), {code: 'USAGE'});
});

test('journal command reaches the bundled CLI before any cached runtime selection or lock preparation', async () => {
  const runtime: RuntimeContext = {bundledRoot: '/usr/local/libexec/mdai/helper', runningRoot: '/usr/local/libexec/mdai/helper',
    bootstrapEntrypoint: '/usr/local/libexec/mdai/helper/dist/cli.js', bootstrapVersion: '0.1.6'};
  let calls = 0;
  await launchCli(args, async (actual, options) => {
    calls++; assert.deepEqual(actual, args); assert.deepEqual(options?.runtime, runtime);
  }, {platform: 'linux', runtime, prepareLocks: async () => {assert.fail('premature lock preparation');}}, {
    select: async () => {assert.fail('journal must not select cached code');},
    load: async () => {assert.fail('journal must not import cached code');},
  });
  assert.equal(calls, 1);
});

test('journal CLI refuses a nonproduction installation before creating helper paths or reading credentials', {
  skip: process.platform !== 'linux',
}, async t => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'mdai-journal-cli-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  await assert.rejects(runCli(args, {platform: 'linux', home, env: {},
    prepareLocks: async () => {assert.fail('premature lock preparation');},
    runner: async () => {assert.fail('unexpected external command');},
    request: async () => {assert.fail('unexpected network request');},
  }), {code: 'RUNNER_JOURNAL_BOOTSTRAP_REFUSED'});
  assert.deepEqual(await readdir(home), []);
});
