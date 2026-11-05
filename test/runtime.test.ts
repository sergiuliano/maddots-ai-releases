import assert from 'node:assert/strict';
import { lstat, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runCli, type CliOptions } from '../src/cli.js';
import { HelperError, type Timing } from '../src/config.js';
import { launchCli, type RuntimeContext } from '../src/runtime.js';
import { VERSION } from '../src/release-identity.js';

const systemRoot = '/usr/local/libexec/mdai/helper';
const systemContext: RuntimeContext = { bundledRoot: systemRoot, bootstrapVersion: VERSION,
  bootstrapEntrypoint: join(systemRoot, 'dist/cli.js'), runningRoot: systemRoot };

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'mdai-runtime-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const runtime: RuntimeContext = {
    bundledRoot: join(home, 'bootstrap'), bootstrapVersion: '0.1.0',
    bootstrapEntrypoint: join(home, 'bootstrap/dist/cli.js'), runningRoot: join(home, 'bootstrap'),
  };
  return { home, runtime, env: {}, platform: 'darwin' as const };
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

test('fixed Linux bootstrap validates the installation and retains lock admission without selecting cached code', {skip: process.platform !== 'linux'}, async t => {
  const options = await fixture(t), entered: string[] = [];
  await launchCli(['status'], async (_argv, context) => {
    entered.push('run');
    assert.deepEqual(context?.runtime, systemContext);
  }, {...options, platform: 'linux', runtime: systemContext,
    assertRuntime: async (root, paths) => {
      entered.push('validate'); assert.equal(root, systemRoot); assert.equal(paths.platform, 'linux');
      return undefined;
    },
    prepareLocks: async (context, paths) => {
      entered.push('prepare'); assert.deepEqual(context, systemContext); assert.equal(paths.platform, 'linux');
    },
  }, {
    select: async () => assert.fail('A fixed installation cannot select a cached runtime.'),
    load: async () => assert.fail('A fixed installation cannot load a cached CLI.'),
  });
  assert.deepEqual(entered, ['validate', 'prepare', 'run']);
});

test('fixed Linux bootstrap refuses identity or lock admission failure before executing its CLI', {skip: process.platform !== 'linux'}, async t => {
  for (const phase of ['identity', 'locks'] as const) await t.test(phase, async context => {
    const options = await fixture(context);
    let prepared = false;
    const refusal = new HelperError('PATH_UNSAFE', 'Synthetic fixed-install refusal.');
    await assert.rejects(launchCli(['service'], async () => assert.fail('An unvalidated fixed runtime cannot run.'),
      {...options, platform: 'linux', runtime: systemContext, output: () => {},
        assertRuntime: async () => {if (phase === 'identity') throw refusal; return undefined;},
        prepareLocks: async () => {prepared = true; throw refusal;},
      }, {
        select: async () => assert.fail('Fixed refusal cannot fall back to cached code.'),
        load: async () => assert.fail('Fixed refusal cannot import cached code.'),
      }), refusal);
    assert.equal(prepared, phase === 'locks');
  });
});

test('fixed Linux informational commands stay read-only and never consult updater metadata', {skip: process.platform !== 'linux'}, async () => {
  for (const argv of [[], ['--help'], ['--version'], ['--self-test']]) {
    let ran = false;
    await launchCli(argv, async () => {ran = true;}, {runtime: systemContext, home: 'invalid relative home',
      env: {MADDOTS_AI_URL: 'invalid'},
      assertRuntime: async () => assert.fail('Informational commands do not inspect mutable state.'),
      prepareLocks: async () => assert.fail('Informational commands do not prepare locks.'),
    }, {
      select: async () => assert.fail('Informational commands cannot select cached code.'),
      load: async () => assert.fail('Informational commands cannot load cached code.'),
    });
    assert.equal(ran, true);
  }
});

test('fixed Linux manual update and rollback refuse before runtime validation, lock preparation or cache use', {skip: process.platform !== 'linux'}, async () => {
  for (const argv of [['update'], ['update', '--rollback']]) {
    const options: CliOptions = {runtime: systemContext,
      assertRuntime: async () => assert.fail('Fixed update refusal precedes filesystem validation.'),
      prepareLocks: async () => assert.fail('Fixed update refusal does not prepare locks.'),
      updates: {
        check: async () => assert.fail('Fixed update cannot call an injected updater.'),
        rollback: async () => assert.fail('Fixed rollback cannot call an injected updater.'),
      },
    };
    await assert.rejects(launchCli(argv, runCli, options, {
      select: async () => assert.fail('Fixed updates cannot select cached code.'),
      load: async () => assert.fail('Fixed updates cannot load cached code.'),
    }), {code: 'SYSTEM_RUNTIME_FIXED'});
    await assert.rejects(runCli(argv, options), {code: 'SYSTEM_RUNTIME_FIXED'});
  }
});

test('fixed Linux CLI validates identity before preparing locks or creating private state', {skip: process.platform !== 'linux'}, async t => {
  const options = await fixture(t);
  await assert.rejects(runCli(['service'], {...options, runtime: systemContext,
    assertRuntime: async () => {throw new HelperError('PATH_UNSAFE', 'Synthetic identity mismatch.');},
    prepareLocks: async () => assert.fail('Identity refusal must precede lock preparation.'),
  }), {code: 'PATH_UNSAFE'});
  await assert.rejects(lstat(join(options.home, 'Library')), {code: 'ENOENT'});
});

test('fixed Linux service continues sync ticks without checking or activating mutable updates', {skip: process.platform !== 'linux'}, async t => {
  const options = await fixture(t), stop = new AbortController();
  const entered: string[] = [];
  let sleeps = 0;
  await runCli(['service'], {...options, runtime: systemContext, signal: stop.signal,
    assertRuntime: async root => {entered.push('validate'); assert.equal(root, systemRoot); return undefined;},
    prepareLocks: async context => {entered.push('prepare'); assert.deepEqual(context, systemContext);},
    timing: {now: () => sleeps * 3_600_000, sleep: async () => {if (++sleeps === 2) stop.abort();}},
    runner: async () => assert.fail('An unpaired service does not invoke credential tools.'),
    updates: {
      select: async () => assert.fail('Fixed service never reads a mutable executable pointer.'),
      check: async () => assert.fail('Fixed service never discovers updates.'),
      rollback: async () => assert.fail('Fixed service never rolls back.'),
    },
  });
  assert.deepEqual(entered, ['validate', 'prepare']);
  assert.equal(sleeps, 2, 'Skipping updater work must preserve the service loop.');
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

test('Linux recovery uses the current bootstrap parser and dispatcher independently of cached legacy CLIs', async t => {
  const options = await fixture(t);
  for (const phase of ['seal', 'complete']) {
    let entered = 0;
    await launchCli(['recovery', phase], async (args, context) => {
      entered++; assert.deepEqual(args, ['recovery', phase]);
      assert.equal(context?.runtime?.bundledRoot, options.runtime.bundledRoot);
    }, {...options, platform: 'linux'}, {
      select: async () => assert.fail('recovery cannot select an older CLI'),
      load: async () => assert.fail('recovery cannot import a broken cached runtime'),
    });
    assert.equal(entered, 1);
  }
});

test('the npm-style executable symlink dispatches the current helper CLI', async t => {
  const options = await fixture(t), executable = join(options.home, 'maddots-ai');
  await symlink(fileURLToPath(new URL('../src/cli.ts', import.meta.url)), executable);
  const result = spawnSync(process.execPath, ['--import', 'tsx', executable, '--version'], {
    encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH, HOME: options.home, MADDOTS_AI_HOME: join(options.home, 'data') },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), VERSION);
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
