import assert from 'node:assert/strict';
import { lstat, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runCli, type CliOptions } from '../src/cli.js';
import type { Timing } from '../src/config.js';
import { launchCli, type RuntimeContext } from '../src/runtime.js';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'mdai-runtime-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const runtime: RuntimeContext = {
    bundledRoot: join(home, 'bootstrap'), bootstrapVersion: '0.1.0',
    bootstrapEntrypoint: join(home, 'bootstrap/dist/cli.js'), runningRoot: join(home, 'bootstrap'),
  };
  return { home, runtime, env: {} };
}

test('candidate self-test loads locally without state, credentials, network or runtime selection', async () => {
  await runCli(['--self-test'], {
    home: 'invalid relative home', env: { MADDOTS_AI_URL: 'invalid' },
    runner: async () => { assert.fail('candidate validation must not run tools'); },
    request: async () => { assert.fail('candidate validation must not pair'); },
  });
  let ran = false;
  const runtime = { bundledRoot: '/bootstrap', bootstrapVersion: '0.1.0', bootstrapEntrypoint: '/bootstrap/dist/cli.js', runningRoot: '/bootstrap' };
  await launchCli(['--self-test'], async () => { ran = true; }, { runtime }, {
    select: async () => { assert.fail('self-test must not select a cached runtime'); },
  });
  assert.equal(ran, true);
});

test('bootstrap loads the selected CLI and keeps the original launcher and version floor', async t => {
  const options = await fixture(t);
  const selectedRoot = join(options.home, 'selected');
  const selectedArgs = ['status'];
  let selectedOptions: CliOptions | undefined;
  await launchCli(selectedArgs, async () => { assert.fail('bundled CLI must yield to the selected release'); }, options, {
    select: async updater => {
      assert.equal(updater.bundledRoot, options.runtime.bundledRoot);
      assert.equal(updater.version, '0.1.0');
      return { root: selectedRoot, version: '0.2.0', commit: 'a'.repeat(40) };
    },
    load: async root => {
      assert.equal(root, selectedRoot);
      return { runCli: async (args, context) => { assert.equal(args, selectedArgs); selectedOptions = context; } };
    },
  });
  assert.deepEqual(selectedOptions?.runtime, { ...options.runtime, runningRoot: selectedRoot });
});

test('bootstrap fallback runs locally without loading another module', async t => {
  const options = await fixture(t);
  let ran = false;
  await launchCli(['status'], async (_args, context) => {
    ran = true;
    assert.deepEqual(context?.runtime, options.runtime);
  }, options, {
    select: async () => ({ root: options.runtime.bundledRoot, version: '0.1.0' }),
    load: async () => { assert.fail('fallback must not import another CLI'); },
  });
  assert.equal(ran, true);
});

test('rollback always uses the stable bootstrap even if the selected CLI cannot load', async t => {
  const options = await fixture(t);
  let ran = false;
  await launchCli(['update', '--rollback'], async (args, context) => {
    ran = true;
    assert.deepEqual(args, ['update', '--rollback']);
    assert.equal(context?.runtime?.bundledRoot, options.runtime.bundledRoot);
  }, options, {
    select: async () => { assert.fail('recovery must not depend on the selected runtime'); },
    load: async () => { throw new Error('broken selected runtime'); },
  });
  assert.equal(ran, true);
});

test('the npm-style executable symlink dispatches the CLI', async t => {
  const options = await fixture(t), executable = join(options.home, 'maddots-ai');
  await symlink(fileURLToPath(new URL('../src/cli.ts', import.meta.url)), executable);
  const result = spawnSync(process.execPath, ['--import', 'tsx', executable, '--version'], {
    encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH, HOME: options.home, MADDOTS_AI_HOME: join(options.home, 'data') },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '0.1.2');
  await assert.rejects(lstat(join(options.home, 'data')), { code: 'ENOENT' });
});

test('manual update and rollback run without credentials and do not nest the sync lock', async t => {
  const options = await fixture(t);
  const output: string[] = [];
  let checks = 0, rollbacks = 0;
  const args: CliOptions = {
    ...options, env: { MADDOTS_AI_AUTO_UPDATE: '0' }, output: line => output.push(line),
    runner: async () => { assert.fail('update must not read credentials or stop launchd'); },
    updates: {
      check: async update => {
        checks++;
        assert.equal(update.force, true);
        await assert.rejects(lstat(update.paths.lock), { code: 'ENOENT' });
        return { status: 'prepared', version: '0.2.0', commit: 'a'.repeat(40) };
      },
      rollback: async update => {
        rollbacks++;
        await assert.rejects(lstat(update.paths.lock), { code: 'ENOENT' });
        return { status: 'rolled-back', version: '0.1.0' };
      },
    },
  };
  await runCli(['update'], args);
  await runCli(['update', '--rollback'], args);
  assert.equal(checks, 1); assert.equal(rollbacks, 1);
  assert.ok(output.every(line => line.includes('after its current sync finishes')));
  await assert.rejects(lstat(join(options.home, 'Library/Application Support/maddots-ai/state.json')), { code: 'ENOENT' });
});

test('manual update exposes a bounded verification failure', async t => {
  const options = await fixture(t);
  await assert.rejects(runCli(['update'], {
    ...options, updates: { check: async () => ({ status: 'failed', reason: 'INVALID_PROVENANCE' }) },
  }), { code: 'INVALID_PROVENANCE' });
});

test('service checks hourly after sequential sync ticks without holding the sync lock', async t => {
  const options = await fixture(t), stop = new AbortController();
  let now = 0, sleeps = 0;
  const checked: number[] = [];
  const timing: Timing = {
    now: () => now,
    sleep: async ms => { now += ms; if (++sleeps === 62) stop.abort(); },
  };
  await runCli(['service'], {
    ...options, signal: stop.signal, timing,
    runner: async () => { assert.fail('an unpaired service must not query credentials'); },
    updates: {
      select: async update => {
        await assert.rejects(lstat(update.paths.lock), { code: 'ENOENT' });
        return { root: options.runtime.runningRoot, version: '0.1.0' };
      },
      check: async update => {
        await assert.rejects(lstat(update.paths.lock), { code: 'ENOENT' });
        checked.push(now);
        return { status: 'current' };
      },
    },
  });
  assert.deepEqual(checked, [0, 3_600_000]);
});

test('automatic opt-out skips checks while still activating manual updates safely', async t => {
  const options = await fixture(t), stop = new AbortController();
  let selects = 0;
  await runCli(['service'], {
    ...options, env: { MADDOTS_AI_AUTO_UPDATE: '0' }, signal: stop.signal,
    timing: { now: () => 0, sleep: async () => { stop.abort(); } },
    updates: {
      check: async () => { assert.fail('automatic checks were disabled'); },
      select: async () => { selects++; return { root: options.runtime.runningRoot, version: '0.1.0' }; },
    },
  });
  assert.equal(selects, 1);
  await assert.rejects(runCli(['service'], {
    ...options, env: { MADDOTS_AI_AUTO_UPDATE: '0' },
    updates: {
      select: async update => {
        await assert.rejects(lstat(update.paths.lock), { code: 'ENOENT' });
        return { root: join(options.home, 'verified-update'), version: '0.2.0' };
      },
      check: async () => { assert.fail('manual activation does not need discovery'); },
    },
  }), { code: 'UPDATE_RESTART' });
});

test('a prepared update exits only after releasing the completed sync tick lock', async t => {
  const options = await fixture(t);
  const data = join(options.home, 'Library/Application Support/maddots-ai');
  await assert.rejects(runCli(['service'], {
    ...options, runner: async () => { assert.fail('restart must not kill or unload launchd'); },
    updates: {
      select: async () => ({ root: options.runtime.runningRoot, version: '0.1.0' }),
      check: async update => {
        await assert.rejects(lstat(update.paths.lock), { code: 'ENOENT' });
        return { status: 'prepared', version: '0.2.0' };
      },
    },
  }), { code: 'UPDATE_RESTART' });
  await assert.rejects(lstat(join(data, '.lock')), { code: 'ENOENT' });
});
