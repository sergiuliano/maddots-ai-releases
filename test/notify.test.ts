import assert from 'node:assert/strict';
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CommandError, readConfig, type CommandOptions, type Runner, type Timing } from '../src/config.js';
import { createPaths, ensurePrivateDirectory, withWriteLock, type HelperPaths } from '../src/paths.js';
import { ALLOW_DIALOG_GIVE_UP_S, ALLOW_NOTIFICATION_INTERVAL_MS, interruptWaitingDialog, notifyWaiting, reserveWaitingDialog, showWaitingDialog, type WaitingNotification } from '../src/notify.js';

const waiting: WaitingNotification[] = [{ skillId: 'skill-one', version: 1, digests: ['a'.repeat(64)] }];
const newer: WaitingNotification[] = [{ skillId: 'skill-one', version: 2, digests: ['b'.repeat(64)] }];

async function fixture(t: { after(fn: () => Promise<void>): void }): Promise<HelperPaths> {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'maddots-notify-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = await createPaths(readConfig({}, home));
  await ensurePrivateDirectory(paths.data);
  return paths;
}

function fakeDesktop(button = 'Later', gaveUp = false) {
  const calls: { file: string; args: readonly string[]; options?: CommandOptions }[] = [];
  const runner: Runner = async (file, args, options) => {
    calls.push({ file, args, options });
    assert.ok(['/usr/bin/osascript', '/usr/bin/open'].includes(file));
    return { stdout: file.endsWith('/osascript') ? `button returned:${button}, gave up:${gaveUp}\n` : '', stderr: '' };
  };
  return { runner, calls };
}

function fakeClock() {
  let now = 0;
  const timing: Timing = { now: () => now, sleep: async () => { assert.fail('notification must not sleep'); } };
  return { timing, set: (value: number) => { now = value; } };
}

test('Later displays the specified dialog once, leaves code waiting and uses a clean runner environment', async t => {
  const paths = await fixture(t), fake = fakeDesktop(), time = fakeClock();
  const holding = join(paths.holding, 'retained');
  await mkdir(paths.holding, { mode: 0o700 });
  await writeFile(holding, 'code still waits');
  assert.equal(await notifyWaiting(paths, waiting, {
    runner: fake.runner, timing: time.timing,
    env: { HOME: paths.home, API_KEY: 'key-canary', AUTH_TOKEN: 'token-canary', ANOTHER_SECRET: 'secret-canary' },
  }), 'later');
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].file, '/usr/bin/osascript');
  assert.equal(fake.calls[0].args[0], '-e');
  assert.match(fake.calls[0].args[1], /1 skills with code wait for Allow on this computer/u);
  assert.match(fake.calls[0].args[1], /buttons \{"Later", "Open Allow list"\}/u);
  assert.deepEqual(fake.calls[0].options?.env, { HOME: paths.home });
  assert.equal(ALLOW_DIALOG_GIVE_UP_S, 14_340);
  assert.match(fake.calls[0].args[1], /giving up after 14340$/u);
  assert.ok(fake.calls[0].options!.timeout! > 14_340_000);
  assert.equal(fake.calls[0].options?.timeout, (ALLOW_DIALOG_GIVE_UP_S + 60) * 1000);
  assert.equal(await readFile(holding, 'utf8'), 'code still waits');
  const content = await readFile(join(paths.data, 'notification-state.json'), 'utf8');
  assert.doesNotMatch(content, /canary/u);
  assert.equal((await stat(join(paths.data, 'notification-state.json'))).mode & 0o777, 0o600);
});

test('Open Allow list opens Terminal with a private launcher using quoted absolute helper paths', async t => {
  const paths = await fixture(t), fake = fakeDesktop('Open Allow list');
  const executable = join(paths.home, "Node's $(unsafe) runtime/node");
  const entrypoint = join(paths.home, "Helper's `unsafe` folder/cli.js");
  assert.equal(await notifyWaiting(paths, waiting, {
    runner: fake.runner, timing: fakeClock().timing, execPath: executable, entrypoint,
    env: { MADDOTS_AI_URL: 'http://127.0.0.1:8123', MADDOTS_AI_ALLOW_INSECURE_LOOPBACK: '1',
      MADDOTS_AI_AUTO_UPDATE: '0', API_KEY: 'never-store', NODE_OPTIONS: '--require /unsafe.js' },
  }), 'opened');
  const command = join(paths.data, 'allow.command');
  assert.deepEqual(fake.calls.map(call => [call.file, call.args[0]]), [['/usr/bin/osascript', '-e'], ['/usr/bin/open', '-a']]);
  assert.deepEqual(fake.calls[1].args, ['-a', 'Terminal', command]);
  assert.equal(fake.calls[1].options?.timeout, 10_000);
  assert.equal((await stat(command)).mode & 0o777, 0o700);
  const content = await readFile(command, 'utf8');
  assert.ok(content.startsWith('#!/bin/sh\nexec /usr/bin/env -i '));
  assert.ok(content.includes("'" + executable.replaceAll("'", "'\\''") + "'"));
  assert.ok(content.includes("'" + entrypoint.replaceAll("'", "'\\''") + "' allow\n"));
  assert.ok(content.includes(`'MADDOTS_AI_HOME=${paths.data}'`));
  assert.match(content, /'MADDOTS_AI_URL=http:\/\/127\.0\.0\.1:8123'/u);
  assert.match(content, /'MADDOTS_AI_ALLOW_INSECURE_LOOPBACK=1'/u);
  assert.match(content, /'MADDOTS_AI_AUTO_UPDATE=0'/u);
  assert.doesNotMatch(content, /never-store|API_KEY|NODE_OPTIONS|unsafe\.js/u);
});

test('durable history suppresses an unchanged or previously shown set across subsequent calls', async t => {
  const paths = await fixture(t), fake = fakeDesktop(), time = fakeClock();
  const options = { runner: fake.runner, timing: time.timing, env: {} };
  assert.equal(await notifyWaiting(paths, waiting, options), 'later');
  time.set(ALLOW_NOTIFICATION_INTERVAL_MS * 10);
  const anotherRunner = fakeDesktop();
  assert.equal(await notifyWaiting(paths, waiting, { ...options, runner: anotherRunner.runner }), 'unchanged');
  assert.equal(anotherRunner.calls.length, 0);
  assert.equal(await notifyWaiting(paths, newer, options), 'later');
  time.set(ALLOW_NOTIFICATION_INTERVAL_MS * 20);
  assert.equal(await notifyWaiting(paths, waiting, options), 'unchanged');
  assert.equal(fake.calls.length, 2);
});

test('a new digest waits four hours and the suppressed set is still eligible at the boundary', async t => {
  const paths = await fixture(t), fake = fakeDesktop(), time = fakeClock();
  const options = { runner: fake.runner, timing: time.timing, env: {} };
  await notifyWaiting(paths, waiting, options);
  time.set(ALLOW_NOTIFICATION_INTERVAL_MS - 1);
  assert.equal(await notifyWaiting(paths, newer, options), 'throttled');
  assert.equal(fake.calls.length, 1);
  time.set(ALLOW_NOTIFICATION_INTERVAL_MS);
  assert.equal(await notifyWaiting(paths, newer, options), 'later');
  assert.equal(fake.calls.length, 2);
  time.set(0);
  assert.equal(await notifyWaiting(paths, [{ ...newer[0], digests: ['c'.repeat(64)] }], options), 'throttled');
});

test('only an interrupted dialog is shown again after restart, preserving completed-set history and later throttling', async t => {
  const paths = await fixture(t), fake = fakeDesktop(), time = fakeClock();
  const options = { runner: fake.runner, timing: time.timing, env: {} };
  assert.equal(await notifyWaiting(paths, waiting, options), 'later');
  time.set(ALLOW_NOTIFICATION_INTERVAL_MS);
  const pending = await withWriteLock(paths, () => reserveWaitingDialog(paths, newer, options), time.timing);
  if (typeof pending === 'string') assert.fail('the new set must reserve a dialog');
  await withWriteLock(paths, () => interruptWaitingDialog(paths, pending), time.timing);
  const interrupted = JSON.parse(await readFile(join(paths.data, 'notification-state.json'), 'utf8'));
  assert.equal(interrupted.interruptedSet, pending.fingerprint);
  assert.equal(interrupted.notifiedSets.length, 2);
  assert.equal(await notifyWaiting(paths, waiting, options), 'unchanged');
  assert.equal(await notifyWaiting(paths, newer, options), 'later');
  assert.equal(fake.calls.length, 2);
  assert.equal(await notifyWaiting(paths, newer, options), 'unchanged');
  assert.equal(await notifyWaiting(paths, [{ ...newer[0], version: 3, digests: ['c'.repeat(64)] }], options), 'throttled');
  const completed = JSON.parse(await readFile(join(paths.data, 'notification-state.json'), 'utf8'));
  assert.equal(completed.interruptedSet, undefined);
  assert.equal(completed.notifiedSets.length, 2);
  // A stale service's cleanup must not reopen a completed set from an older reservation.
  time.set(ALLOW_NOTIFICATION_INTERVAL_MS * 2);
  const latest = await reserveWaitingDialog(paths, [{ ...newer[0], version: 3, digests: ['c'.repeat(64)] }], options);
  assert.equal(typeof latest, 'object');
  await withWriteLock(paths, () => interruptWaitingDialog(paths, pending), time.timing);
  assert.equal(JSON.parse(await readFile(join(paths.data, 'notification-state.json'), 'utf8')).interruptedSet, undefined);
});

test('ordering and duplicate route digests do not create a new waiting set or inflate its count', async t => {
  const paths = await fixture(t), fake = fakeDesktop(), time = fakeClock();
  const first = [waiting[0], { skillId: 'skill-two', version: 1, digests: ['c'.repeat(64), 'b'.repeat(64)] }];
  const options = { runner: fake.runner, timing: time.timing, env: {} };
  await notifyWaiting(paths, first, options);
  assert.match(fake.calls[0].args[1], /2 skills with code wait/u);
  time.set(ALLOW_NOTIFICATION_INTERVAL_MS);
  assert.equal(await notifyWaiting(paths, [
    { ...first[1], digests: ['b'.repeat(64)] }, first[0], { ...first[1], digests: ['c'.repeat(64)] }, first[0],
  ], options), 'unchanged');
  assert.equal(fake.calls.length, 1);
});

test('empty sets have no side effects and unknown dialog output never opens Terminal', async t => {
  const paths = await fixture(t), fake = fakeDesktop('Open Allow list, malicious output');
  assert.equal(await notifyWaiting(paths, [], { runner: fake.runner }), 'empty');
  await assert.rejects(stat(join(paths.data, 'notification-state.json')), { code: 'ENOENT' });
  await assert.rejects(stat(join(paths.data, 'allow.command')), { code: 'ENOENT' });
  assert.equal(await notifyWaiting(paths, waiting, { runner: fake.runner, env: {} }), 'later');
  assert.equal(fake.calls.length, 1);
});

test('dialog failures are surfaced and their attempted set cannot repeatedly interrupt the person', async t => {
  const paths = await fixture(t), time = fakeClock();
  let attempts = 0;
  const runner: Runner = async () => { attempts++; throw new CommandError(undefined); };
  const options = { runner, timing: time.timing, env: {} };
  await assert.rejects(notifyWaiting(paths, waiting, options), { code: 'COMMAND_FAILED' });
  time.set(ALLOW_NOTIFICATION_INTERVAL_MS);
  assert.equal(await notifyWaiting(paths, waiting, options), 'unchanged');
  assert.equal(attempts, 1);
});

test('a dialog give-up counts as Later, never opens Terminal and leaves the set unchanged afterwards', async t => {
  const paths = await fixture(t), fake = fakeDesktop('', true), time = fakeClock();
  const options = { runner: fake.runner, timing: time.timing, env: {} };
  assert.equal(await notifyWaiting(paths, waiting, options), 'later');
  assert.deepEqual(fake.calls.map(call => call.file), ['/usr/bin/osascript']);
  time.set(ALLOW_NOTIFICATION_INTERVAL_MS);
  assert.equal(await notifyWaiting(paths, waiting, options), 'unchanged');
  assert.equal(fake.calls.length, 1);
});

test('reserving shows nothing and a pending dialog leaves the helper write lock available', async t => {
  const paths = await fixture(t), time = fakeClock();
  let calls = 0;
  let finish!: (result: Awaited<ReturnType<Runner>>) => void;
  const runner: Runner = async file => {
    calls++;
    assert.equal(file, '/usr/bin/osascript');
    return new Promise(resolve => { finish = resolve; });
  };
  const options = { runner, timing: time.timing, env: {} };
  const pending = await withWriteLock(paths, () => reserveWaitingDialog(paths, waiting, options), time.timing);
  assert.equal(typeof pending, 'object');
  assert.equal(calls, 0);
  if (typeof pending === 'string') assert.fail('a new waiting set must reserve a dialog');
  let completed = false;
  const display = showWaitingDialog(pending, options).then(result => { completed = true; return result; });
  try {
    assert.equal(calls, 1);
    let acquired = false;
    await withWriteLock(paths, async () => {
      acquired = true;
      assert.equal(await reserveWaitingDialog(paths, waiting, options), 'unchanged');
    }, time.timing);
    assert.equal(acquired, true);
    assert.equal(completed, false);
    assert.equal(calls, 1);
  } finally {
    finish({ stdout: 'button returned:Later, gave up:false\n', stderr: '' });
    assert.equal(await display, 'later');
  }
});

test('symlinked data, state or launcher paths are refused without running commands or touching their targets', async t => {
  for (const target of ['data', 'state', 'launcher']) {
    const paths = await fixture(t), fake = fakeDesktop();
    const outside = join(paths.home, `outside-${target}`);
    if (target === 'data') {
      await mkdir(outside, { mode: 0o700 });
      const alias = join(paths.home, 'data-link');
      await symlink(outside, alias);
      await assert.rejects(notifyWaiting({ ...paths, data: alias }, waiting, { runner: fake.runner, env: {} }), { code: 'PATH_UNSAFE' });
    } else {
      await writeFile(outside, 'untouched', { mode: 0o600 });
      await symlink(outside, join(paths.data, target === 'state' ? 'notification-state.json' : 'allow.command'));
      await assert.rejects(notifyWaiting(paths, waiting, { runner: fake.runner, env: {} }), { code: 'PATH_UNSAFE' });
      assert.equal(await readFile(outside, 'utf8'), 'untouched');
    }
    assert.equal(fake.calls.length, 0);
  }
});

test('unsafe launcher permissions and hardlinks are refused while existing files are preserved', async t => {
  const paths = await fixture(t), fake = fakeDesktop();
  const command = join(paths.data, 'allow.command');
  await writeFile(command, 'retained', { mode: 0o600 });
  await assert.rejects(notifyWaiting(paths, waiting, { runner: fake.runner, env: {} }), { code: 'PATH_UNSAFE' });
  await chmod(command, 0o700);
  await link(command, join(paths.home, 'launcher-link'));
  await assert.rejects(notifyWaiting(paths, waiting, { runner: fake.runner, env: {} }), { code: 'PATH_UNSAFE' });
  assert.equal(await readFile(command, 'utf8'), 'retained');
  assert.equal(fake.calls.length, 0);
});

test('invalid state, relative helper paths, hidden characters, unsafe origins and invalid clock values fail closed', async t => {
  const paths = await fixture(t), fake = fakeDesktop();
  const options = { runner: fake.runner, env: {} };
  for (const input of [
    { execPath: 'node' }, { entrypoint: 'cli.js' }, { entrypoint: '/helper/cli\n.js' },
    { env: { MADDOTS_AI_URL: 'https://ai.maddots.app?token=secret' } },
    { timing: { now: () => Number.NaN, sleep: async () => {} } },
  ]) {
    await assert.rejects(notifyWaiting(paths, waiting, { ...options, ...input }), { code: input.env ? 'CONFIG_INVALID' : 'NOTIFY_INVALID' });
  }
  await assert.rejects(notifyWaiting(paths, [{ ...waiting[0], skillId: 'hidden\u200b' }], options), { code: 'NOTIFY_INVALID' });
  await assert.rejects(notifyWaiting(paths, [{ ...waiting[0], digests: ['invalid'] }], options), { code: 'NOTIFY_INVALID' });
  await writeFile(join(paths.data, 'notification-state.json'), '{"format":1,"notifiedSets":["invalid"],"lastDialogAt":0}', { mode: 0o600 });
  await assert.rejects(notifyWaiting(paths, waiting, options), { code: 'NOTIFY_STATE_INVALID' });
  assert.equal(fake.calls.length, 0);
});
