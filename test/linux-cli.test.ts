import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {hostname, tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {computerName, runCli, type CliOptions} from '../src/cli.js';
import {readConfig, type Runner, type Timing} from '../src/config.js';
import {createPaths, ensurePaths} from '../src/paths.js';
import {StateStore} from '../src/state.js';
import {SyncEngine} from '../src/sync.js';
import {notifyWaiting} from '../src/notify.js';
import {detectTools} from '../src/detect.js';
import {TOOL_MATRIX} from '../src/shared/tool-matrix.js';
import {RunsRuntime} from '../src/runner/cli-runs.js';
import {ClaudePluginDeliveryTarget} from '../src/delivery/claude-plugin.js';
import {LINUX_SERVICE_ENTRYPOINT, LINUX_SERVICE_FRAGMENT, LINUX_SERVICE_NODE, SERVICE_UNIT, linuxSystemServiceUnit} from '../src/service.js';

function installedSystemProperties(pid = process.pid): string {
  const values = {LoadState: 'loaded', ActiveState: 'active', SubState: 'running', MainPID: String(pid),
    FragmentPath: LINUX_SERVICE_FRAGMENT, DropInPaths: '', User: 'mdai', Group: 'mdai',
    ControlGroup: '/system.slice/mdai-helper.service', Delegate: 'yes', DelegateControllers: '', DelegateSubgroup: 'controller',
    TasksMax: '4096', NoNewPrivileges: 'yes', KillMode: 'control-group', Restart: 'no',
    ExecStart: `{ path=/usr/bin/env ; argv[]=/usr/bin/env -i HOME=/var/lib/mdai/home PATH=/usr/local/libexec/mdai:/usr/bin:/bin MADDOTS_AI_HOME=/var/lib/mdai/data MADDOTS_AI_URL=https://ai.maddots.app XDG_CONFIG_HOME=/var/lib/mdai/config XDG_STATE_HOME=/var/lib/mdai/state XDG_RUNTIME_DIR=/run/mdai-helper ${LINUX_SERVICE_NODE} --disable-sigusr1 ${LINUX_SERVICE_ENTRYPOINT} service ; ignore_errors=no ; }`};
  return Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
}

test('Linux SSH pairing and status use private credentials while service mutation remains founder-owned', async t => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'mdai-linux-cli-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const env = {PATH: join(home, 'empty-bin')};
  const paths = await createPaths(readConfig(env, home, 'linux'));
  const credential = 'mdai_skill_' + 'L'.repeat(43);
  const output: string[] = [], commands: string[][] = [], inventories: unknown[] = [];
  const loaded = true;
  let revoked = false, pairings = 0, now = Date.parse('2026-10-24T12:00:00Z');
  const timing: Timing = {now: () => now, sleep: async ms => {now += ms;}};
  const runner: Runner = async (file, args) => {
    commands.push([file, ...args]);
    assert.equal(file, '/usr/bin/systemctl', 'Linux must not invoke Apple commands or secret-tool without a bus.');
    assert.equal(args[0], 'show'); assert.equal(args[1], SERVICE_UNIT); assert(!args.includes('--user'));
    return {stdout: installedSystemProperties(), stderr: ''};
  };
  const connection = {account: {id: 'owner', name: 'Owner'}, scopes: ['sync', 'import_upload', 'proposal_upload'],
    renewBy: new Date(now + 90 * 86400_000).toISOString(), idleLapseAt: new Date(now + 30 * 86400_000).toISOString(), connections: []};
  const request: typeof fetch = async (input, init) => {
    const route = new URL(String(input)).pathname;
    let data: object = {};
    if (route === '/api/helper/pairings') {
      pairings++;
      const report = JSON.parse(String(init?.body));
      assert.equal(report.os, 'linux'); assert.equal(report.computerName, await computerName(runner, env, 'linux'));
      assert.deepEqual(report.credentialStorage, {version: 1, backend: 'file'});
      data = {deviceCode: 'D'.repeat(43), userCode: 'ABCDEFGH', connectUrl: 'https://ai.maddots.app/tools/connect',
        expiresIn: 300, expiresAt: new Date(now + 300_000).toISOString(), interval: 3};
    } else if (route === '/api/helper/pairings/poll') data = {status: 'connected', token: credential, helperId: 'helper', ...connection};
    else {
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${credential}`);
      if (route === '/api/helper/status') data = {...connection, pending: [], runGrants: []};
      else if (route === '/api/helper/token/revoke') revoked = true;
      else if (route === '/api/helper/inventory') inventories.push(JSON.parse(String(init?.body)));
      else if (route === '/api/helper/plan') data = {planRevision: 'fixture', degraded: false, pollAfterSeconds: 60, items: [], revoked: [], instructions: []};
      else if (route.startsWith('/api/helper/imports')) data = [];
      else assert.fail(`Unexpected helper route: ${route}`);
    }
    return new Response(JSON.stringify({data}), {status: 200});
  };
  let inspections = 0;
  const options: CliOptions = {platform: 'linux', home, env, runner, request, timing, output: line => output.push(line),
    // Process inspection has native coverage. This fixture owns credentials and service wiring only.
    inspectRunProcesses: async () => {inspections++;},
    isTTY: true, confirm: async () => {assert.fail('The default headless backend does not need a file override prompt.');}};
  await runCli(['connect'], options);
  assert.equal(loaded, true); assert(output.includes('Code: ABCD-EFGH'));
  const saved = await new StateStore(paths, new URL('https://ai.maddots.app')).read();
  assert.equal(saved.tokenStorage, 'file'); assert.equal(saved.credentialBackendSelected, true);
  assert.equal(saved.tokenFile, join(paths.config!, 'credentials.json'));
  assert.equal((await lstat(saved.tokenFile!)).mode & 0o777, 0o600);
  assert.equal((await lstat(paths.config!)).mode & 0o777, 0o700);
  assert.equal((await readFile(paths.state, 'utf8')).includes(credential), false);
  let recoveries = 0;
  t.mock.method(RunsRuntime.prototype, 'init', async () => {recoveries++;});
  const stop = new AbortController();
  await runCli(['service'], {...options, signal: stop.signal,
    timing: {...timing, sleep: async () => {stop.abort();}}});
  await runCli(['status'], options);
  assert(output.some(line => line.includes('OS: linux. Token storage: file')));
  assert(output.some(line => line.includes('Service: healthy')));
  assert.equal(recoveries, 1, 'Linux service initializes runner recovery with its selected private backend.');
  assert.equal(inspections, 1);
  await runCli(['runs'], options);
  await assert.rejects(runCli(['runs', 'test', 'codex'], options), {code: 'tool_not_found'});
  assert.equal(pairings, 1, 'Service and status reuse the selected credentials.');
  assert(inventories.length > 0);
  for (const value of inventories) assert.equal((value as {os: string}).os, 'linux');
  await mkdir(join(paths.backups, 'retained'), {mode: 0o700});
  await writeFile(join(paths.backups, 'retained/proof'), 'backup');
  await assert.rejects(runCli(['uninstall'], options), {code: 'SERVICE_FOUNDER_ACTION_REQUIRED'});
  assert.equal(loaded, true); assert.equal(revoked, false);
  assert.equal((await lstat(saved.tokenFile!)).mode & 0o777, 0o600);
  await assert.rejects(lstat(paths.serviceUnit!), {code: 'ENOENT'});
  assert.equal(await readFile(join(paths.backups, 'retained/proof'), 'utf8'), 'backup');
  assert.equal(commands.some(call => call.some(arg => arg.includes(credential))), false);
  assert.equal(output.some(line => line.includes(credential)), false);
});

test('production Linux commands retain native process preflight and ignore fixture hooks without a fixture home', {skip: process.platform !== 'linux'}, async t => {
  const nativeOpendir = fs.opendir;
  const denied = t.mock.method(fs, 'opendir', async (...args: Parameters<typeof fs.opendir>) => {
    if (args[0] === '/proc') throw Object.assign(new Error('synthetic inspection denial'), {code: 'EACCES'});
    return nativeOpendir(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {denied.mock.restore(); syncBuiltinESMExports();});
  let injected = 0;
  for (const command of [['runs'], ['agent', 'setup']]) {
    await assert.rejects(runCli(command, {platform: 'linux', inspectRunProcesses: async () => {injected++;},
      request: async () => {assert.fail('Native preflight must refuse before network or credentials.');}}), {code: 'adapter_refused'});
  }
  assert.equal(injected, 0);
});

for (const prefix of ['bin', 'opt/custom tools/bin']) test(`Linux connect statically discovers ~/${prefix} tools without changing the founder service PATH`, async t => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'mdai-linux-cli-path-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const directory = join(home, prefix), rejectedDirectory = join(home, 'wrong-cli'), sshDirectory = join(home, 'ssh-session-bin');
  const binary = join(directory, 'claude'), rejectedBinary = join(rejectedDirectory, 'claude');
  for (const path of [directory, rejectedDirectory]) await mkdir(path, {recursive: true});
  await writeFile(binary, '#!/bin/sh\nexit 1\n', {mode: 0o700});
  // Static discovery can reject a non-executable file without running an identity probe.
  await writeFile(rejectedBinary, '#!/bin/sh\nexit 1\n', {mode: 0o600});
  const env = {PATH: [rejectedDirectory, directory, sshDirectory].join(':'), SSH_AUTH_SOCK: '/ssh-agent-canary',
    SSH_CONNECTION: 'ssh-connection-canary', NODE_OPTIONS: '--inspect', PRIVATE_TOKEN: 'private-token-canary'};
  const paths = await createPaths(readConfig(env, home, 'linux'));
  const commands: string[][] = [], pairingReports: {tools: unknown[]}[] = [];
  const runner: Runner = async (file, args) => {
    commands.push([file, ...args]);
    assert.equal(file, '/usr/bin/systemctl');
    assert.equal(args[0], 'show'); assert.equal(args[1], SERVICE_UNIT); assert(!args.includes('--user'));
    return {stdout: installedSystemProperties(), stderr: ''};
  };
  let now = Date.parse('2026-10-24T12:00:00Z');
  const timing: Timing = {now: () => now, sleep: async ms => {now += ms;}};
  const request: typeof fetch = async (input, init) => {
    const route = new URL(String(input)).pathname;
    let data: object;
    if (route === '/api/helper/pairings') {
      pairingReports.push(JSON.parse(String(init?.body)));
      data = {deviceCode: 'D'.repeat(43), userCode: 'ABCDEFGH', connectUrl: 'https://ai.maddots.app/tools/connect',
        expiresIn: 300, expiresAt: new Date(now + 300_000).toISOString(), interval: 3};
    } else {
      assert.equal(route, '/api/helper/pairings/poll');
      data = {status: 'connected', token: 'mdai_skill_' + 'P'.repeat(43), helperId: 'helper',
        account: {id: 'owner', name: 'Owner'}, scopes: ['sync', 'import_upload', 'proposal_upload'], connections: [],
        renewBy: new Date(now + 90 * 86400_000).toISOString(), idleLapseAt: new Date(now + 30 * 86400_000).toISOString()};
    }
    return new Response(JSON.stringify({data}), {status: 200});
  };
  await runCli(['connect'], {platform: 'linux', home, env, runner, request, timing, output: () => {}});
  assert.equal(pairingReports.length, 1);
  assert.deepEqual(pairingReports[0].tools, [{tool: 'claude-code', variant: 'cli', version: null, models: [], syncOnly: false}]);
  const saved = await new StateStore(paths, new URL('https://ai.maddots.app')).read();
  assert.equal(saved.tools.length, 1);
  assert.equal(saved.tools[0].path, binary);
  assert.equal(saved.tools[0].realpath, await realpath(binary));
  assert.equal(saved.tools[0].version, null);
  assert.equal(saved.tools[0].versionVerified, false);
  assert.match(saved.tools[0].fingerprint!, /^\d+:\d+:\d+:\d+:\d+$/u);
  await assert.rejects(lstat(paths.serviceUnit!), {code: 'ENOENT'});
  const unit = linuxSystemServiceUnit();
  const servicePath = /\bPATH=(\S+)/u.exec(unit)?.[1];
  assert.ok(servicePath);
  assert.equal(servicePath, '/usr/local/libexec/mdai:/usr/bin:/bin');
  assert.ok(!servicePath.split(':').includes(directory));
  assert.ok(!servicePath.split(':').includes(rejectedDirectory));
  assert.ok(!servicePath.split(':').includes(sshDirectory));
  assert.doesNotMatch(unit, /SSH_AUTH_SOCK|SSH_CONNECTION|NODE_OPTIONS|PRIVATE_TOKEN|ssh-agent-canary|ssh-connection-canary|private-token-canary/u);
  const delivery = new ClaudePluginDeliveryTarget({paths, helperId: 'helper', env: {PATH: directory}, runner, platform: 'linux'});
  await assert.rejects(delivery.requireCli(), {code: 'TOOL_PLATFORM_NOT_ACCEPTED'});
  assert.equal(commands.some(([file]) => file === binary || file === rejectedBinary), false,
    'Pairing and unaccepted plugin registration must not execute a discovered tool.');
});

test('Linux inventory and notifications report terminal instructions, and app detection never invokes plutil', async t => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'mdai-linux-report-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const paths = await createPaths(readConfig({}, home, 'linux')); await ensurePaths(paths);
  const engine = new SyncEngine({paths, helperId: 'helper', targets: [], tokenStorage: 'secret-service',
    client: {request: async () => {throw new Error('Inventory is local.');}}});
  const inventory = await engine.inventory();
  assert.equal(inventory.os, 'linux'); assert.equal(inventory.tokenStorage, 'secret-service'); engine.close();
  const output: string[] = [];
  const runner: Runner = async () => {assert.fail('Linux must not invoke Apple applications.');};
  await notifyWaiting(paths, [{skillId: 'skill', version: 1, digests: ['a'.repeat(64)]}], {platform: 'linux', runner, output: line => output.push(line)});
  assert(output.some(line => line.includes('maddots-ai allow')));
  await assert.rejects(lstat(join(paths.data, 'allow.command')), {code: 'ENOENT'});
  assert.equal(await computerName(runner, {}, 'linux'), hostname().replace(/[^A-Za-z0-9 ._-]/g, '-').slice(0, 64) || 'Computer');
  const matrix = structuredClone(TOOL_MATRIX);
  for (const tool of matrix.tools) {
    tool.run = null;
    for (const variant of tool.variants) {
      variant.syncOnly = true;
      variant.models = {args: null, pattern: null};
      variant.detect.binaries = []; variant.detect.configPaths = []; variant.detect.apps = ['~/Applications/Fixture.app'];
    }
  }
  await mkdir(join(home, 'Applications/Fixture.app/Contents'), {recursive: true});
  await writeFile(join(home, 'Applications/Fixture.app/Contents/Info.plist'), '{}');
  assert.deepEqual(await detectTools({home, env: {}, matrix, runner, platform: 'linux'}), []);
});

test('unsupported platforms are refused before path, credential or network work', async () => {
  for (const platform of ['win32', 'freebsd'] as const) for (const command of ['connect', 'status', 'service', 'uninstall', 'import']) {
    await assert.rejects(runCli([command], {platform, home: 'relative', env: {MADDOTS_AI_URL: 'invalid'},
      runner: async () => {assert.fail('No command may run.');}, request: async () => {assert.fail('No request may run.');}}), {code: 'PLATFORM_UNSUPPORTED'});
  }
});
