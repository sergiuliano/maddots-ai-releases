import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {chmod, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {CommandError, readConfig, type Runner} from '../src/config.js';
import {createPaths, type HelperPaths} from '../src/paths.js';
import {installService, removeService, SERVICE_UNIT, serviceStatus, writeServiceHeartbeat,
  linuxSystemServiceUnit, LINUX_SERVICE_ENTRYPOINT, LINUX_SERVICE_FRAGMENT, LINUX_SERVICE_NODE} from '../src/service.js';

async function fixture(t: {after(fn: () => Promise<void>): void}): Promise<HelperPaths> {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'maddots-systemd-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  return createPaths(readConfig({}, home, 'linux'));
}
function manager() {
  const calls: {file: string; args: readonly string[]; env?: NodeJS.ProcessEnv}[] = [];
  const values: Record<string, string> = {LoadState: 'loaded', ActiveState: 'active', SubState: 'running', MainPID: '1234',
    FragmentPath: LINUX_SERVICE_FRAGMENT, DropInPaths: '', User: 'mdai', Group: 'mdai',
    ControlGroup: '/system.slice/mdai-helper.service', Delegate: 'yes', DelegateControllers: '', DelegateSubgroup: 'controller',
    TasksMax: '4096', NoNewPrivileges: 'yes', KillMode: 'control-group', Restart: 'no',
    ExecStart: `{ path=/usr/bin/env ; argv[]=/usr/bin/env -i HOME=/var/lib/mdai/home PATH=/usr/local/libexec/mdai:/usr/bin:/bin MADDOTS_AI_HOME=/var/lib/mdai/data MADDOTS_AI_URL=https://ai.maddots.app XDG_CONFIG_HOME=/var/lib/mdai/config XDG_STATE_HOME=/var/lib/mdai/state XDG_RUNTIME_DIR=/run/mdai-helper ${LINUX_SERVICE_NODE} --disable-sigusr1 ${LINUX_SERVICE_ENTRYPOINT} service ; ignore_errors=no ; }`};
  const runner: Runner = async (file, args, options) => {
    calls.push({file, args, env: options?.env});
    assert.equal(file, '/usr/bin/systemctl'); assert.equal(args[0], 'show'); assert.equal(args[1], SERVICE_UNIT);
    assert.ok(!args.includes('--user'));
    return {stdout: Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', stderr: ''};
  };
  return {calls, values, runner};
}

/** Parse the generated ExecStart subset using systemd.syntax(7) whole-item
 * quoting and C escapes, then systemd.service(5) literal %% / $$ expansion.
 * Quotes embedded in an unquoted word remain literal, unlike shell syntax. */
function systemdCommandWords(command: string): string[] {
  const words: string[] = [];
  const word = /(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+))(?:\s+|$)/guy;
  let offset = 0;
  while (offset < command.length) {
    word.lastIndex = offset;
    const match = word.exec(command);
    assert.ok(match, `Unsupported ExecStart syntax at ${offset}`);
    const value = (match[1] ?? match[2] ?? match[3]).replace(/\\(.)/gu, (_escape, character: string) => {
      assert.ok(['\\', '"', "'", 's'].includes(character), 'Only generated C escapes are supported');
      return character === 's' ? ' ' : character;
    });
    assert.doesNotMatch(value.replaceAll('%%', '').replaceAll('$$', ''), /[%$]/u, 'Unexpected systemd expansion');
    words.push(value.replaceAll('%%', '%').replaceAll('$$', '$'));
    offset = word.lastIndex;
  }
  return words;
}

test('systemd command parsing removes only whole-word quotes and decodes literal escapes', () => {
  assert.deepEqual(systemdCommandWords(String.raw`/usr/bin/env PLAIN=/home/mdai BROKEN="https://ai.maddots.app" "URL=https://ai.maddots.app" 'SPACED=two words' "ESCAPED=a\\b\"c" "LITERAL=%%n/$$HOME"`),
    ['/usr/bin/env', 'PLAIN=/home/mdai', 'BROKEN="https://ai.maddots.app"', 'URL=https://ai.maddots.app',
      'SPACED=two words', 'ESCAPED=a\\b"c', 'LITERAL=%n/$HOME']);
});

test('generated systemd argv preserves every environment value and fixed Node argument', () => {
  for (const [endpoint, origin] of [
    ['https://ai.maddots.app', 'https://ai.maddots.app'],
    ['https://EXAMPLE.com:8443/', 'https://example.com:8443'],
    ['https://[::1]:8443', 'https://[::1]:8443'],
    ['https://cash$money.example', 'https://cash$money.example'],
  ]) {
    const command = /^ExecStart=(.+)$/mu.exec(linuxSystemServiceUnit(LINUX_SERVICE_ENTRYPOINT, endpoint))![1];
    assert.deepEqual(systemdCommandWords(command), [
      '/usr/bin/env', '-i', 'HOME=/var/lib/mdai/home', 'PATH=/usr/local/libexec/mdai:/usr/bin:/bin',
      'MADDOTS_AI_HOME=/var/lib/mdai/data', `MADDOTS_AI_URL=${origin}`, 'XDG_CONFIG_HOME=/var/lib/mdai/config',
      'XDG_STATE_HOME=/var/lib/mdai/state', 'XDG_RUNTIME_DIR=/run/mdai-helper',
      LINUX_SERVICE_NODE, '--disable-sigusr1', LINUX_SERVICE_ENTRYPOINT, 'service',
    ]);
  }
});

test('Linux install verifies the founder system service and creates no competing user unit', async t => {
  const paths = await fixture(t), fake = manager();
  await installService(paths, {runner: fake.runner, env: {PRIVATE_TOKEN: 'do-not-pass', NODE_OPTIONS: '--inspect'}});
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0].env, {PATH: '/usr/bin:/bin', LC_ALL: 'C'});
  await assert.rejects(stat(paths.serviceUnit!), {code: 'ENOENT'});
});

test('reviewable system unit has explicit delegation, private runtime and bounded service resources', () => {
  const unit = linuxSystemServiceUnit();
  for (const setting of ['User=mdai', 'Group=mdai', 'Delegate=\n', 'DelegateSubgroup=controller', 'TasksMax=4096',
    'MemoryMax=64G', 'CPUQuota=5120%', 'NoNewPrivileges=yes', 'KillMode=control-group', 'Restart=no',
    'RuntimeDirectory=mdai-helper', 'UMask=0077', 'LimitCORE=0']) assert.ok(unit.includes(setting), setting);
  assert.ok(unit.includes(LINUX_SERVICE_NODE)); assert.ok(unit.includes(LINUX_SERVICE_ENTRYPOINT));
  assert.ok(unit.includes(`"${LINUX_SERVICE_NODE}" --disable-sigusr1 "${LINUX_SERVICE_ENTRYPOINT}" service`));
  assert.doesNotMatch(unit, /WantedBy=|--user|SSH_AUTH_SOCK|DBUS_SESSION_BUS_ADDRESS|NODE_OPTIONS/u);
});

test('generated system unit starts Node with fixed arguments and no inherited preload environment', async t => {
  const paths = await fixture(t), entrypoint = join(paths.home, 'entrypoint.mjs');
  const marker = join(paths.home, 'preload-executed');
  const requirePreload = join(paths.home, 'preload.cjs'), importPreload = join(paths.home, 'preload.mjs');
  await writeFile(requirePreload, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'require'); throw Error('unexpected preload');\n`);
  await writeFile(importPreload, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'import'); throw Error('unexpected preload');\n`);
  await writeFile(entrypoint, 'console.log(JSON.stringify({env: process.env, execArgv: process.execArgv, args: process.argv.slice(2)}));\n');

  // Parse systemd's whole-word quoting, then execute the actual env prefix,
  // replacing only the two founder-installed files with this host's Node and
  // a harmless entrypoint.
  const command = /^ExecStart=(.+)$/mu.exec(linuxSystemServiceUnit())![1];
  const words = systemdCommandWords(command);
  const executable = words.shift()!, nodeIndex = words.indexOf(LINUX_SERVICE_NODE);
  assert.equal(executable, '/usr/bin/env');
  assert.ok(nodeIndex >= 0);
  assert.deepEqual(words.slice(nodeIndex), [LINUX_SERVICE_NODE, '--disable-sigusr1', LINUX_SERVICE_ENTRYPOINT, 'service']);
  words[nodeIndex] = process.execPath;
  words[nodeIndex + 2] = entrypoint;
  for (const nodeOptions of [`--require=${requirePreload}`, `--import=${pathToFileURL(importPreload).href}`]) {
    const {stdout, stderr}: {stdout: string; stderr: string} = await promisify(execFile)(executable, words, {
      cwd: paths.home,
      env: {NODE_OPTIONS: nodeOptions, NODE_PATH: paths.home, HOME: paths.home, PATH: paths.home,
        XDG_DATA_HOME: paths.home, MADDOTS_AI_HOME: paths.home},
      timeout: 5000, encoding: 'utf8',
    });
    assert.equal(stderr, '');
    assert.deepEqual(JSON.parse(stdout), {
      env: {HOME: '/var/lib/mdai/home', PATH: '/usr/local/libexec/mdai:/usr/bin:/bin',
        MADDOTS_AI_HOME: '/var/lib/mdai/data', MADDOTS_AI_URL: 'https://ai.maddots.app',
        XDG_CONFIG_HOME: '/var/lib/mdai/config', XDG_STATE_HOME: '/var/lib/mdai/state', XDG_RUNTIME_DIR: '/run/mdai-helper'},
      execArgv: ['--disable-sigusr1'], args: ['service'],
    });
    await assert.rejects(stat(marker), {code: 'ENOENT'});
  }
});

test('Linux requires exactly the signal-disabling Node flag and refuses inherited environment or extra flags', async t => {
  const paths = await fixture(t);
  for (const change of [
    (command: string) => command.replace('/usr/bin/env -i ', '/usr/bin/env '),
    (command: string) => command.replace(' -i ', ' -i NODE_OPTIONS=--require=/tmp/preload.cjs '),
    (command: string) => command.replace(' -i ', ' -i NODE_PATH=/tmp/modules '),
    (command: string) => command.replace(`${LINUX_SERVICE_NODE} `, `${LINUX_SERVICE_NODE} --require=/tmp/preload.cjs `),
    (command: string) => command.replace(`${LINUX_SERVICE_NODE} `, `${LINUX_SERVICE_NODE} --import=file:///tmp/preload.mjs `),
    (command: string) => command.replace(' --disable-sigusr1 ', ' '),
    (command: string) => command.replace(`${LINUX_SERVICE_NODE} `, `${LINUX_SERVICE_NODE} --disable-sigusr1 `),
    (command: string) => command.replace(`${LINUX_SERVICE_NODE} `, `${LINUX_SERVICE_NODE} --inspect `),
    (command: string) => command.replace(`${LINUX_SERVICE_NODE} `, `${LINUX_SERVICE_NODE} --inspect=127.0.0.1:9229 `),
    (command: string) => command.replace(`${LINUX_SERVICE_NODE} `, `${LINUX_SERVICE_NODE} --inspect-brk `),
    (command: string) => command.replace(`${LINUX_SERVICE_NODE} `, `${LINUX_SERVICE_NODE} --inspect-port=0 `),
    (command: string) => command.replace(' --disable-sigusr1 ', ' --inspect '),
    (command: string) => command.replace(`${LINUX_SERVICE_NODE} `, `${LINUX_SERVICE_NODE} --no-warnings `),
  ]) {
    const fake = manager();
    fake.values.ExecStart = change(fake.values.ExecStart);
    await assert.rejects(installService(paths, {runner: fake.runner}), {code: 'SERVICE_PROVISIONING_REQUIRED'});
    assert.equal(fake.calls.length, 1);
  }
});

test('Linux refuses missing or incompatible system contracts with no host mutation', async t => {
  const paths = await fixture(t);
  for (const [key, value] of Object.entries({LoadState: 'not-found', User: 'sd', Group: 'sd', Delegate: 'no',
    DelegateControllers: 'cpu', DelegateSubgroup: '', TasksMax: '512', NoNewPrivileges: 'no', KillMode: 'mixed',
    Restart: 'on-failure', FragmentPath: '/tmp/fixture-unit', DropInPaths: '/tmp/fixture-override',
    ControlGroup: '/user.slice/unit', ExecStart: '/usr/bin/node helper.js'})) {
    const fake = manager(); fake.values[key] = value;
    await assert.rejects(installService(paths, {runner: fake.runner}), {code: 'SERVICE_PROVISIONING_REQUIRED'});
    assert.equal(fake.calls.length, 1);
  }
});

test('Linux refuses arbitrary runtime overrides and malformed review paths', async t => {
  const paths = await fixture(t), fake = manager();
  for (const options of [{execPath: '/usr/bin/node'}, {entrypoint: '/tmp/helper.js'}, {toolDirectories: ['/home/tools']}]) {
    await assert.rejects(installService(paths, {runner: fake.runner, ...options}), {code: 'SERVICE_CONFIG_INVALID'});
  }
  for (const path of ['relative.js', '/tmp/helper.js', '/usr/local/libexec/mdai/../helper.js', '/usr/local/libexec/mdai/helper\nExecStart=/bin/sh']) {
    assert.throws(() => linuxSystemServiceUnit(path), {code: 'SERVICE_CONFIG_INVALID'});
  }
});

test('Linux removal remains founder-owned and never stops a live containment namespace', async t => {
  const paths = await fixture(t), fake = manager();
  await assert.rejects(removeService(paths, {runner: fake.runner}), {code: 'SERVICE_FOUNDER_ACTION_REQUIRED'});
  assert.equal(fake.calls.length, 0);
});

test('Linux system health requires validated containment service and matching fresh heartbeat', async t => {
  const paths = await fixture(t), fake = manager(), now = 10_000_000;
  assert.equal((await serviceStatus(paths, {runner: fake.runner, now: () => now})).healthy, false);
  await writeServiceHeartbeat(paths, {pid: 1234, now: () => now});
  assert.deepEqual(await serviceStatus(paths, {runner: fake.runner, now: () => now}), {
    platform: 'linux', manager: 'systemd', installed: true, running: true, healthy: true,
    loadState: 'loaded', activeState: 'active', subState: 'running', mainPid: 1234,
    heartbeat: {pid: 1234, updatedAt: now, fresh: true},
  });
  for (const timestamp of [now - 180_001, now + 30_001]) {
    await writeServiceHeartbeat(paths, {pid: 1234, now: () => timestamp});
    assert.equal((await serviceStatus(paths, {runner: fake.runner, now: () => now})).healthy, false);
  }
  await writeServiceHeartbeat(paths, {pid: 9999, now: () => now});
  assert.equal((await serviceStatus(paths, {runner: fake.runner, now: () => now})).healthy, false);
  fake.values.Delegate = 'no';
  await assert.rejects(serviceStatus(paths, {runner: fake.runner}), {code: 'SERVICE_PROVISIONING_REQUIRED'});
});

test('Linux status reports absent system service without guessing that a user service is healthy', async t => {
  const paths = await fixture(t), fake = manager();
  Object.assign(fake.values, {LoadState: 'not-found', ActiveState: 'inactive', SubState: 'dead', MainPID: '0'});
  const status = await serviceStatus(paths, {runner: fake.runner});
  assert.equal(status.installed, false); assert.equal(status.running, false); assert.equal(status.healthy, false);
  assert.equal(status.linger, undefined);
});

test('Linux preserves exact system manager failure and rejects incomplete responses', async t => {
  const paths = await fixture(t);
  const unavailable: Runner = async () => {throw new CommandError(77);};
  await assert.rejects(serviceStatus(paths, {runner: unavailable}), error => {
    assert.equal((error as {code: string}).code, 'SERVICE_MANAGER_UNAVAILABLE');
    assert.match((error as Error).message, /systemctl show mdai-helper\.service failed \(exit 77\)/u); return true;
  });
  const incomplete: Runner = async () => ({stdout: 'ActiveState=active\nMainPID=1\n', stderr: ''});
  await assert.rejects(serviceStatus(paths, {runner: incomplete}), {code: 'SERVICE_STATUS_INVALID'});
});

test('Linux heartbeat protections still reject unsafe or substituted files', async t => {
  const paths = await fixture(t), fake = manager();
  await writeServiceHeartbeat(paths, {pid: 1234});
  assert.equal((await stat(paths.serviceHeartbeat!)).mode & 0o777, 0o600);
  await writeFile(paths.serviceHeartbeat!, 'invalid-json');
  assert.equal((await serviceStatus(paths, {runner: fake.runner})).healthy, false);
  await chmod(paths.serviceHeartbeat!, 0o644);
  await assert.rejects(serviceStatus(paths, {runner: fake.runner}), {code: 'FILE_UNSAFE'});
  await rm(paths.serviceHeartbeat!); await symlink(join(paths.home, 'outside'), paths.serviceHeartbeat!);
  await assert.rejects(writeServiceHeartbeat(paths), {code: 'PATH_UNSAFE'});
  await assert.rejects(writeServiceHeartbeat({...paths, serviceHeartbeat: join(paths.home, 'other')}), {code: 'PATH_UNSAFE'});
});

test('Linux dispatch refuses unsupported platforms and retains private user data', async t => {
  const paths = await fixture(t), fake = manager();
  await writeServiceHeartbeat(paths, {pid: 1234});
  const original = await readFile(paths.serviceHeartbeat!, 'utf8');
  for (const operation of [installService, removeService, serviceStatus]) {
    await assert.rejects(operation(paths, {runner: fake.runner, platform: 'win32'}), {code: 'PLATFORM_UNSUPPORTED'});
  }
  assert.equal(await readFile(paths.serviceHeartbeat!, 'utf8'), original); assert.equal(fake.calls.length, 0);
});
