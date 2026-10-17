import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { CommandError, readConfig, type Runner } from '../src/config.js';
import { createPaths, type HelperPaths } from '../src/paths.js';
import { installService, removeService, runService, SERVICE_INTERVAL_MS, SERVICE_LABEL } from '../src/service.js';

async function fixture(t: { after(fn: () => Promise<void>): void }): Promise<HelperPaths> {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'maddots-launchd-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return createPaths(readConfig({}, home));
}

function fakeLaunchctl() {
  let active = false;
  const calls: { file: string; args: readonly string[]; env?: NodeJS.ProcessEnv }[] = [];
  const runner: Runner = async (file, args, options) => {
    calls.push({ file, args, env: options?.env });
    assert.equal(file, '/bin/launchctl');
    if (args[0] === 'print' && !active) throw new CommandError(113);
    if (args[0] === 'bootstrap') active = true;
    if (args[0] === 'bootout') active = false;
    return { stdout: '', stderr: '' };
  };
  return { calls, runner, active: () => active };
}

test('installation uses the user launchd domain, failure-only KeepAlive and escaped absolute arguments', async t => {
  const paths = await fixture(t);
  const fake = fakeLaunchctl();
  const executable = join(paths.home, 'Node & tools/node');
  const entrypoint = join(paths.home, 'MadDots "AI" <helper>/cli.js');
  await installService(paths, {
    runner: fake.runner, uid: 501, execPath: executable, entrypoint,
    env: { PATH: '/Tools & Stuff/bin:/usr/bin', MADDOTS_AI_TOKEN: 'credential-canary',
      API_KEY: 'credential-canary', OTHER_SECRET: 'credential-canary',
      MADDOTS_AI_SECURITY_BIN: '/override/security', HTTP_PROXY: 'http://credential-canary' },
  });
  assert.deepEqual(fake.calls.map(call => call.args), [
    ['print', `gui/501/${SERVICE_LABEL}`], ['bootstrap', 'gui/501', paths.servicePlist],
  ]);
  const content = await readFile(paths.servicePlist, 'utf8');
  assert.match(content, /<key>RunAtLoad<\/key><true\/>/u);
  assert.match(content, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/u);
  assert.match(content, /<string>--disable-sigusr1<\/string>/u);
  assert.doesNotMatch(content, /--inspect[^<\s]*/u);
  assert.ok(content.includes(executable.replaceAll('&', '&amp;')));
  assert.ok(content.includes(entrypoint.replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')));
  assert.ok(content.includes(`<string>${paths.logs}/service.log</string>`));
  assert.ok(content.includes(`<string>${paths.logs}/service-error.log</string>`));
  assert.equal((await stat(paths.servicePlist)).mode & 0o777, 0o600);
  assert.doesNotMatch(content, /credential-canary|MADDOTS_AI_TOKEN|API_KEY|OTHER_SECRET|HTTP_PROXY|MADDOTS_AI_SECURITY_BIN/u);
  assert.deepEqual(Object.keys(fake.calls[0].env ?? {}).sort(), ['HOME', 'MADDOTS_AI_HOME', 'MADDOTS_AI_URL', 'PATH']);
  assert.equal(fake.calls[0].env?.HOME, paths.home);
  assert.equal(fake.calls[0].env?.MADDOTS_AI_HOME, paths.data);
});

test('replacement unloads only its own agent before bootstrapping the updated plist', async t => {
  const paths = await fixture(t);
  const fake = fakeLaunchctl();
  await mkdir(dirname(paths.servicePlist), { recursive: true, mode: 0o755 });
  const mode = (await stat(dirname(paths.servicePlist))).mode & 0o777;
  await installService(paths, { runner: fake.runner, uid: 501, env: {} });
  fake.calls.length = 0;
  await installService(paths, { runner: fake.runner, uid: 501, entrypoint: '/new location/cli.js', env: {} });
  assert.deepEqual(fake.calls.map(call => call.args), [
    ['print', `gui/501/${SERVICE_LABEL}`], ['bootout', `gui/501/${SERVICE_LABEL}`],
    ['bootstrap', 'gui/501', paths.servicePlist],
  ]);
  assert.ok((await readFile(paths.servicePlist, 'utf8')).includes('/new location/cli.js'));
  assert.equal((await stat(dirname(paths.servicePlist))).mode & 0o777, mode);
});

test('the service preserves automatic update opt-out without storing secret environment variables', async t => {
  const paths = await fixture(t), fake = fakeLaunchctl();
  await installService(paths, { runner: fake.runner, env: { MADDOTS_AI_AUTO_UPDATE: '0', PRIVATE_TOKEN: 'do-not-store' } });
  const content = await readFile(paths.servicePlist, 'utf8');
  assert.match(content, /<key>MADDOTS_AI_AUTO_UPDATE<\/key><string>0<\/string>/u);
  assert.doesNotMatch(content, /PRIVATE_TOKEN|do-not-store/u);
});

test('service removal keeps helper state, backups, delivered skills and unrelated launchd files', async t => {
  const paths = await fixture(t);
  const fake = fakeLaunchctl();
  await installService(paths, { runner: fake.runner, uid: 501, env: {} });
  const backup = join(paths.backups, 'keep-me');
  const skill = join(paths.home, '.agents/skills/retained/SKILL.md');
  const unrelated = join(dirname(paths.servicePlist), 'another.agent.plist');
  await mkdir(dirname(skill), { recursive: true });
  await Promise.all([writeFile(backup, 'backup'), writeFile(skill, 'skill'),
    writeFile(paths.state, '{"retained":true}'), writeFile(unrelated, 'unrelated')]);
  fake.calls.length = 0;
  await removeService(paths, { runner: fake.runner, uid: 501, env: {} });
  assert.equal(fake.active(), false);
  assert.deepEqual(fake.calls.map(call => call.args), [
    ['print', `gui/501/${SERVICE_LABEL}`], ['bootout', `gui/501/${SERVICE_LABEL}`],
  ]);
  await assert.rejects(stat(paths.servicePlist), { code: 'ENOENT' });
  assert.equal(await readFile(backup, 'utf8'), 'backup');
  assert.equal(await readFile(skill, 'utf8'), 'skill');
  assert.equal(await readFile(paths.state, 'utf8'), '{"retained":true}');
  assert.equal(await readFile(unrelated, 'utf8'), 'unrelated');
  fake.calls.length = 0;
  await removeService(paths, { runner: fake.runner, uid: 501, env: {} });
  assert.deepEqual(fake.calls.map(call => call.args), [['print', `gui/501/${SERVICE_LABEL}`]]);
});

test('launchctl permission and timeout failures are reported instead of treated as a missing service', async t => {
  const paths = await fixture(t);
  for (const exitCode of [77, undefined]) {
    const calls: string[][] = [];
    const runner: Runner = async (_file, args) => {
      calls.push([...args]);
      throw new CommandError(exitCode);
    };
    await assert.rejects(installService(paths, { runner, env: {} }), error => error instanceof CommandError && error.exitCode === exitCode);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'print');
    await assert.rejects(stat(paths.servicePlist), { code: 'ENOENT' });
  }
});

test('the helper refuses symlinked LaunchAgents and a substituted plist path', async t => {
  const paths = await fixture(t);
  const external = join(paths.home, 'external');
  await mkdir(external);
  await mkdir(join(paths.home, 'Library'), { recursive: true });
  await symlink(external, dirname(paths.servicePlist));
  const fake = fakeLaunchctl();
  await assert.rejects(installService(paths, { runner: fake.runner, env: {} }), { code: 'PATH_UNSAFE' });
  await assert.rejects(removeService(paths, { runner: fake.runner, env: {} }), { code: 'PATH_UNSAFE' });
  assert.equal(fake.calls.length, 0);
  await assert.rejects(installService({ ...paths, servicePlist: join(paths.home, 'other.plist') }, { runner: fake.runner, env: {} }), { code: 'PATH_UNSAFE' });
});

test('unsafe endpoint values cannot be persisted in the service environment', async t => {
  const paths = await fixture(t);
  const fake = fakeLaunchctl();
  await assert.rejects(installService(paths, { runner: fake.runner, env: { MADDOTS_AI_URL: 'https://ai.maddots.app?token=secret' } }), { code: 'CONFIG_INVALID' });
  assert.equal(fake.calls.length, 0);
  await assert.rejects(installService(paths, { runner: fake.runner, execPath: 'node', env: {} }), { code: 'SERVICE_CONFIG_INVALID' });
});

test('launchd log targets cannot be symlinks and existing logs are retained', async t => {
  const paths = await fixture(t);
  const fake = fakeLaunchctl();
  await installService(paths, { runner: fake.runner, env: {} });
  const output = join(paths.logs, 'service.log');
  await writeFile(output, 'retained diagnostic');
  await installService(paths, { runner: fake.runner, env: {} });
  assert.equal(await readFile(output, 'utf8'), 'retained diagnostic');
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  await rm(output);
  const outside = join(paths.home, 'outside-log');
  await writeFile(outside, 'untouched');
  await symlink(outside, output);
  fake.calls.length = 0;
  await assert.rejects(installService(paths, { runner: fake.runner, env: {} }), { code: 'PATH_UNSAFE' });
  assert.equal(fake.calls.length, 0);
  assert.equal(await readFile(outside, 'utf8'), 'untouched');
});

test('service ticks are sequential, occur immediately and stop cleanly on cancellation', async () => {
  const controller = new AbortController();
  const events: string[] = [];
  let ticks = 0;
  await runService(async () => {
    events.push(`tick-${++ticks}`);
    if (ticks === 3) controller.abort();
  }, {
    signal: controller.signal,
    sleep: async ms => { assert.equal(ms, SERVICE_INTERVAL_MS); events.push('sleep'); },
  });
  assert.deepEqual(events, ['tick-1', 'sleep', 'tick-2', 'sleep', 'tick-3']);
  await runService(async () => { assert.fail('already aborted service must not tick'); }, { signal: controller.signal });
});

test('a failing service tick exits so launchd can apply failure-only KeepAlive', async () => {
  await assert.rejects(runService(async () => { throw new Error('tick failed'); }), /tick failed/u);
});

test('an injected aborting sleep shuts the service down cleanly', async () => {
  const controller = new AbortController();
  let ticks = 0;
  await runService(async () => { ticks++; }, {
    signal: controller.signal,
    sleep: async () => { controller.abort(); throw new Error('aborted sleep'); },
  });
  assert.equal(ticks, 1);
  await assert.rejects(runService(async () => {}, { sleep: async () => { throw new Error('clock failed'); } }), /clock failed/u);
});
