import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {hostname, tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {TOOL_MATRIX} from '../src/shared/tool-matrix.js';
import {computerName, runCli} from '../src/cli.js';
import {readConfig, runCommand, type Runner} from '../src/config.js';
import {detectTools} from '../src/detect.js';
import {reserveWaitingDialog, showWaitingDialog} from '../src/notify.js';
import {createPaths, ensurePaths, type HelperPaths} from '../src/paths.js';
import {processImages} from '../src/process-image.js';
import {KeychainProviderKeyStore} from '../src/provider-keys.js';
import {reserveAgentSetupDialog, showAgentSetupDialog} from '../src/runner/agents-local.js';
import {KeychainSecretStore, SecretServiceSecretStore, selectSecretStore} from '../src/secret-store.js';
import {installService, removeService, serviceStatus} from '../src/service.js';
import {StateStore} from '../src/state.js';
import {captureRetirement, pendingRetirement, restartLegacyService} from '../src/write-lock-retirement.js';

type NativeCall = {file: string; args: string[]; options: childProcess.ExecFileOptions; input?: string};
type Reply = {stdout?: string; stderr?: string; code?: number};

/** Production callers keep their normal argv construction. Only native process
 * creation is replaced, after runCommand has checked the complete command. */
function dispatch(t: TestContext, reply: (call: NativeCall) => Reply = () => ({})) {
  const calls: NativeCall[] = [], original = childProcess.execFile;
  childProcess.execFile = ((file: string, args: string[], options: childProcess.ExecFileOptions,
    done: (error: Error | null, stdout: string, stderr: string) => void) => {
    const call: NativeCall = {file, args, options}; calls.push(call);
    queueMicrotask(() => {
      const result = reply(call);
      done(result.code === undefined ? null : Object.assign(new Error('Synthetic utility failure'), {code: result.code}), result.stdout ?? '', result.stderr ?? '');
    });
    return {stdin: Object.assign(new EventEmitter(), {end: (input?: string) => {call.input = input;}})};
  }) as typeof childProcess.execFile;
  syncBuiltinESMExports();
  t.after(() => {childProcess.execFile = original; syncBuiltinESMExports();});
  const runner: Runner = (file, args, options) => runCommand(file, args, options);
  return {calls, runner};
}

async function fixture(t: TestContext, platform: 'darwin' | 'linux' = 'darwin'): Promise<HelperPaths> {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'mdai-utility-callers-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const paths = await createPaths(readConfig({}, home, platform));
  await ensurePaths(paths);
  return paths;
}

function vectors(calls: NativeCall[]) {return calls.map(({file, args}) => [file, args]);}
function keychainReply(values = new Map<string, string>()) {
  return (call: NativeCall): Reply => {
    assert.equal(call.file, '/usr/bin/security');
    if (call.args[0] === '-i') {
      const fields = [...call.input!.matchAll(/-(?:s|a|w) ("(?:\\.|[^"\\])*")/gu)].map(match => JSON.parse(match[1]) as string);
      values.set(fields[0] + ':' + fields[1], fields[2]);
      return {};
    }
    const service = call.args[call.args.indexOf('-s') + 1], account = call.args[call.args.indexOf('-a') + 1], key = service + ':' + account;
    if (call.args[0] === 'delete-generic-password') {values.delete(key); return {};}
    return values.has(key) ? {stdout: values.get(key)! + '\n'} : {code: 44};
  };
}

for (const action of ['get', 'set', 'delete'] as const) {
  test(`Darwin helper Keychain ${action} reaches the dispatcher with its production vector`, async t => {
    const paths = await fixture(t), native = dispatch(t, keychainReply());
    const store = new KeychainSecretStore(new URL('https://ai.maddots.app'), paths.data, native.runner, {});
    const account = `skills-token:ai.maddots.app:${createHash('sha256').update(paths.data).digest('hex').slice(0, 12)}`;
    if (action === 'get') assert.equal(await store.get('skills-token'), undefined);
    else if (action === 'set') {await store.set('skills-token', 'synthetic-utility-value'); assert.equal(await store.get('skills-token'), 'synthetic-utility-value');}
    else await store.delete('skills-token');
    const command = action === 'set' ? ['-i'] : action === 'get'
      ? ['find-generic-password', '-w', '-s', 'app.maddots.ai', '-a', account]
      : ['delete-generic-password', '-s', 'app.maddots.ai', '-a', account];
    assert.ok(native.calls.some(call => call.file === '/usr/bin/security' && JSON.stringify(call.args) === JSON.stringify(command)));
    if (action === 'set') assert.equal(native.calls.find(call => call.args[0] === '-i')!.input,
      `add-generic-password -U -s "app.maddots.ai" -a "${account}" -w "synthetic-utility-value"\n`);
  });

  test(`Darwin provider Keychain ${action} reaches the dispatcher with its production vector`, async t => {
    const native = dispatch(t, keychainReply()), store = new KeychainProviderKeyStore(native.runner, {});
    const value = 'sk-' + 'SyntheticUtilityFixture'.repeat(2);
    if (action === 'get') assert.equal(await store.get('deepseek'), undefined);
    else if (action === 'set') {await store.set('deepseek', value); assert.equal(await store.get('deepseek'), value);}
    else await store.delete('deepseek');
    const command = action === 'set' ? ['-i'] : action === 'get'
      ? ['find-generic-password', '-w', '-s', 'app.maddots.ai.provider-key', '-a', 'deepseek']
      : ['delete-generic-password', '-s', 'app.maddots.ai.provider-key', '-a', 'deepseek'];
    assert.ok(native.calls.some(call => call.file === '/usr/bin/security' && JSON.stringify(call.args) === JSON.stringify(command)));
    if (action === 'set') assert.equal(native.calls.find(call => call.args[0] === '-i')!.input,
      `add-generic-password -U -s "app.maddots.ai.provider-key" -a "deepseek" -w "${value}"\n`);
  });
}

function secretServiceReply() {
  const values = new Map<string, string>();
  return (call: NativeCall): Reply => {
    const account = call.args.at(-1)!;
    if (call.args[0] === 'store') {values.set(account, call.input!); return {};}
    if (call.args[0] === 'clear') {values.delete(account); return {};}
    return values.has(account) ? {stdout: values.get(account)} : {code: 1};
  };
}

for (const action of ['verifyAvailable', 'get', 'set', 'delete'] as const) {
  test(`Linux Secret Service ${action} reaches the dispatcher with its production vector`, async t => {
    const paths = await fixture(t, 'linux'), native = dispatch(t, secretServiceReply());
    const store = new SecretServiceSecretStore(new URL('https://ai.maddots.app'), paths.data, '/usr/bin/secret-tool', native.runner,
      {DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus'});
    if (action === 'verifyAvailable') await store.verifyAvailable();
    else if (action === 'get') assert.equal(await store.get('skills-token'), undefined);
    else if (action === 'set') {await store.set('skills-token', 'synthetic-utility-value'); assert.equal(await store.get('skills-token'), 'synthetic-utility-value');}
    else await store.delete('skills-token');
    const command = action === 'set' || action === 'verifyAvailable' ? 'store' : action === 'get' ? 'lookup' : 'clear';
    assert.ok(native.calls.some(call => call.file === '/usr/bin/secret-tool' && call.args[0] === command));
    for (const call of native.calls) {
      assert.equal(call.file, '/usr/bin/secret-tool');
      const offset = call.args[0] === 'store' ? 2 : 1;
      assert.deepEqual(call.args.slice(offset, -1), ['service', 'app.maddots.ai', 'account']);
      assert.match(call.args.at(-1)!, /^(?:skills-token|availability-[a-f0-9-]+):ai\.maddots\.app:[a-f0-9]{12}$/u);
      if (call.args[0] === 'store') assert.equal(call.args[1], call.args.at(-1)!.startsWith('availability-') ? '--label=MadDots AI availability check' : '--label=MadDots AI helper');
    }
  });
}

for (const selection of ['PATH discovery', 'persisted canonical path'] as const) {
  test(`Linux Secret Service ${selection} retains the validated custom executable`, async t => {
    const paths = await fixture(t, 'linux'), directory = join(paths.home, 'custom-libsecret'), binary = join(directory, 'secret-tool');
    await mkdir(directory, {mode: 0o700});
    await writeFile(binary, 'Synthetic client fixture, never executed', {mode: 0o700});
    const native = dispatch(t, secretServiceReply());
    const store = await selectSecretStore({paths, endpoint: new URL('https://ai.maddots.app'),
      env: {PATH: selection === 'PATH discovery' ? directory : '/nonexistent-fixture-path', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus'},
      saved: selection === 'PATH discovery' ? {status: 'unpaired', tokenStorage: 'file'}
        : {status: 'connected', tokenStorage: 'secret-service', credentialBackendSelected: true, secretServiceBinary: binary}});
    assert.ok(store instanceof SecretServiceSecretStore);
    assert.equal(store.binary, binary);
    await store.set('skills-token', 'synthetic-utility-value');
    assert.equal(await store.get('skills-token'), 'synthetic-utility-value');
    await store.delete('skills-token');
    assert.ok(native.calls.length >= 4);
    assert.ok(native.calls.every(call => call.file === binary));
    assert.ok(native.calls.some(call => call.args[0] === 'store' && call.args[1] === '--label=MadDots AI helper'));
    assert.ok(native.calls.some(call => call.args[0] === 'lookup'));
    assert.ok(native.calls.some(call => call.args[0] === 'clear'));
    const count = native.calls.length;
    await assert.rejects(runCommand(binary, ['lookup', 'service', 'app.maddots.ai', 'account', 'fixture']), {code: 'HELPER_COMMAND_REFUSED'});
    assert.equal(native.calls.length, count);
  });
}

test('Darwin computerName uses the approved scutil vector and Linux uses the hostname API', async t => {
  const native = dispatch(t, () => ({stdout: 'Fixture-Mac\n'}));
  assert.equal(await computerName(native.runner, {}, 'darwin'), 'Fixture-Mac');
  assert.deepEqual(vectors(native.calls), [['/usr/sbin/scutil', ['--get', 'LocalHostName']]]);
  assert.equal(await computerName(native.runner, {}, 'linux'), hostname().replace(/[^A-Za-z0-9 ._-]/gu, '-').slice(0, 64) || 'Computer');
  assert.equal(native.calls.length, 1);
});

test('Darwin token renewal calls the production argument-only osascript dialog', async t => {
  const paths = await fixture(t), keychain = keychainReply(), native = dispatch(t, call => call.file === '/usr/bin/security' ? keychain(call) : {});
  const endpoint = new URL('https://ai.maddots.app'), state = new StateStore(paths, endpoint), now = Date.parse('2026-10-30T00:00:00Z');
  await state.write({...await state.read(), status: 'connected', credentialBackendSelected: true,
    renewBy: new Date(now + 86_400_000).toISOString(), idleLapseAt: new Date(now + 30 * 86_400_000).toISOString()});
  await runCli(['status'], {home: paths.home, platform: 'darwin', env: {}, runner: native.runner,
    timing: {now: () => now, sleep: async () => {}}, output: () => {}, request: async () => assert.fail('The empty synthetic Keychain must not make a network request')});
  const calls = native.calls.filter(call => call.file === '/usr/bin/osascript');
  assert.deepEqual(calls.map(call => call.args), [['-e', 'on run argv\ndisplay dialog (item 1 of argv) buttons {"OK"} default button "OK"\nend run', 'Renew on ai.maddots.app.']]);
});

test('Darwin waiting notification calls its fixed osascript dialog', async t => {
  const paths = await fixture(t), native = dispatch(t, () => ({stdout: 'button returned:Later, gave up:false'}));
  const pending = await reserveWaitingDialog(paths, [{skillId: 'fixture-skill', version: 1, digests: ['a'.repeat(64)]}], {platform: 'darwin', env: {}});
  assert.equal(typeof pending, 'object');
  if (typeof pending === 'string') assert.fail('The first dialog must be reserved');
  assert.equal(await showWaitingDialog(pending, {platform: 'darwin', env: {}, runner: native.runner}), 'later');
  assert.equal(native.calls.length, 1);
  assert.equal(native.calls[0].file, '/usr/bin/osascript');
  assert.match(native.calls[0].args[1], /^display dialog "1 skills with code wait for Allow on this computer"/u);
});

test('Darwin agent setup notification calls its fixed osascript dialog', async t => {
  const paths = await fixture(t), native = dispatch(t, () => ({stdout: 'button returned:Later, gave up:false'}));
  const pending = await reserveAgentSetupDialog(paths, [{agentId: '11111111-1111-1111-1111-111111111111'}], {platform: 'darwin', env: {}});
  assert.equal(typeof pending, 'object');
  if (typeof pending === 'string') assert.fail('The first setup dialog must be reserved');
  assert.equal(await showAgentSetupDialog(pending, {platform: 'darwin', env: {}, runner: native.runner}), 'later');
  assert.equal(native.calls.length, 1);
  assert.equal(native.calls[0].file, '/usr/bin/osascript');
  assert.match(native.calls[0].args[1], /^display dialog "1 agents need setup or Allow on this computer"/u);
});

test('Darwin application detection uses plutil on the discovered Info.plist', async t => {
  const paths = await fixture(t), matrix = structuredClone(TOOL_MATRIX), app = join(paths.home, 'Applications/Fixture.app');
  for (const tool of matrix.tools) for (const variant of tool.variants) {
    variant.detect.binaries = variant.detect.binaries.map(() => join(paths.home, 'missing-fixture-binary'));
    variant.detect.apps = variant.detect.apps.map(() => join(paths.home, 'MissingFixture.app'));
    variant.detect.configPaths = variant.detect.configPaths.map(() => join(paths.home, 'missing-fixture-config.json'));
  }
  const variant = matrix.tools[0].variants[0]; variant.detect.apps = [app];
  await mkdir(join(app, 'Contents'), {recursive: true});
  await writeFile(join(app, 'Contents/Info.plist'), 'Synthetic plist metadata');
  const native = dispatch(t, () => ({stdout: JSON.stringify({CFBundleIdentifier: 'fixture.helper', CFBundleShortVersionString: '1.2.3'})}));
  const tools = await detectTools({home: paths.home, platform: 'darwin', matrix, env: {}, runner: native.runner});
  assert.ok(tools.some(tool => tool.tool === matrix.tools[0].key && tool.variant === variant.key && tool.version === '1.2.3'));
  assert.deepEqual(vectors(native.calls), [['/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents/Info.plist')]]]);
});

test('Darwin service status, replacement and removal preserve launchctl print, bootout and bootstrap vectors', async t => {
  const paths = await fixture(t), native = dispatch(t), options = {platform: 'darwin' as const, uid: 501, env: {}, runner: native.runner};
  await installService(paths, options);
  assert.equal((await serviceStatus(paths, options)).running, true);
  await removeService(paths, options);
  assert.deepEqual(vectors(native.calls), [
    ['/bin/launchctl', ['print', 'gui/501/app.maddots.ai.helper']],
    ['/bin/launchctl', ['bootout', 'gui/501/app.maddots.ai.helper']],
    ['/bin/launchctl', ['bootstrap', 'gui/501', paths.servicePlist]],
    ['/bin/launchctl', ['print', 'gui/501/app.maddots.ai.helper']],
    ['/bin/launchctl', ['print', 'gui/501/app.maddots.ai.helper']],
    ['/bin/launchctl', ['bootout', 'gui/501/app.maddots.ai.helper']],
  ]);
});

test('Linux system service inspection reaches systemctl with the production property list', async t => {
  const paths = await fixture(t, 'linux'), native = dispatch(t, () => ({stdout: 'LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\n'}));
  assert.equal((await serviceStatus(paths, {platform: 'linux', env: {}, runner: native.runner})).installed, false);
  assert.equal(native.calls.length, 1);
  assert.deepEqual(native.calls[0].args, ['show', 'mdai-helper.service', '--property=LoadState,ActiveState,SubState,MainPID,FragmentPath,DropInPaths,User,Group,ControlGroup,Delegate,DelegateControllers,DelegateSubgroup,TasksMax,NoNewPrivileges,KillMode,Restart,ExecStart']);
  assert.equal(native.calls[0].file, '/usr/bin/systemctl');
});

const boot = '11111111-1111-1111-1111-111111111111', started = 'Fri Oct 30 00:00:00 2026';
test('Darwin retirement capture and pending inspection accept sysctl and real-UID ps vectors', async t => {
  const native = dispatch(t, call => ({stdout: call.file === '/usr/sbin/sysctl' ? boot + '\n' : `101 501 S ${started}\n`}));
  const options = {platform: 'darwin' as const, uid: 501, pid: 101, runner: native.runner};
  const retirement = await captureRetirement(options);
  assert.equal(retirement.processes.length, 1);
  assert.equal((await pendingRetirement(retirement, options)).length, 1);
  assert.deepEqual(vectors(native.calls), [
    ['/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']], ['/bin/ps', ['-U', '501', '-o', 'pid=,ruid=,state=,lstart=']],
    ['/bin/ps', ['-U', '501', '-o', 'pid=,ruid=,state=,lstart=']], ['/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']],
    ['/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']], ['/bin/ps', ['-U', '501', '-o', 'pid=,ruid=,state=,lstart=']],
  ]);
});

test('Darwin process image inspection sends the unchanged production JXA script and PID data', async t => {
  const native = dispatch(t, () => ({stdout: JSON.stringify([[202, '/usr/local/bin/node']])}));
  assert.equal((await processImages([202], native.runner, {platform: 'darwin'})).get(202), '/usr/local/bin/node');
  assert.equal(native.calls.length, 1);
  assert.equal(native.calls[0].file, '/usr/bin/osascript');
  assert.deepEqual(native.calls[0].args.slice(0, 3), ['-l', 'JavaScript', '-e']);
  assert.deepEqual(native.calls[0].args.slice(4), ['202']);
  assert.match(native.calls[0].args[3], /ObjC\.bindFunction\('proc_pidpath'/u);
});

test('Darwin retirement restart accepts manageruid, managername, list and kickstart vectors', async t => {
  const native = dispatch(t, call => ({stdout: call.args[0] === 'manageruid' ? '501\n' : call.args[0] === 'managername' ? 'Aqua\n'
    : call.args[0] === 'list' ? 'PID\tStatus\tLabel\n202\t0\tapp.maddots.ai.helper\n' : ''}));
  await restartLegacyService([{pid: 202, started, executable: '/usr/local/bin/node'}], {platform: 'darwin', uid: 501, pid: 101, runner: native.runner});
  assert.deepEqual(vectors(native.calls), [
    ['/bin/launchctl', ['manageruid']], ['/bin/launchctl', ['managername']], ['/bin/launchctl', ['list']],
    ['/bin/launchctl', ['kickstart', '-k', 'gui/501/app.maddots.ai.helper']],
  ]);
});

test('Linux legacy retirement restart accepts user-service systemctl show and restart vectors', async t => {
  const native = dispatch(t, call => ({stdout: call.args[1] === 'show' ? 'Id=app.maddots.ai.helper.service\nLoadState=loaded\nMainPID=202\n' : ''}));
  await restartLegacyService([{pid: 202, started: `linux:${boot}:123`, executable: '/usr/local/bin/node'}], {platform: 'linux', uid: 1000, pid: 101, runner: native.runner});
  assert.deepEqual(vectors(native.calls), [
    ['/usr/bin/systemctl', ['--user', 'show', 'app.maddots.ai.helper.service', '--property=Id,LoadState,MainPID', '--no-pager']],
    ['/usr/bin/systemctl', ['--user', 'restart', 'app.maddots.ai.helper.service']],
  ]);
});

test('the release-only updater verifier retains its exact production program and script vector', async t => {
  const native = dispatch(t, () => ({stdout: '{}'})), source = await readFile(new URL('../src/updater.ts', import.meta.url), 'utf8');
  // Source checkouts intentionally have no signed release channel. Bind the
  // extracted script to the exact production dispatch instead of hand-copying it.
  const match = /const script = `([^`]+)`;\s*try \{\s*const result = await runCommand\(process\.execPath, \['--input-type=module', '-e', script\], \{/u.exec(source);
  assert.ok(match, 'The caller changed: review the release verifier argv and update this extraction.');
  const updater = new URL('../src/updater.ts', import.meta.url).href;
  const script = match[1].replace('${JSON.stringify(import.meta.url)}', JSON.stringify(updater));
  assert.ok(!script.includes('${'), 'Every updater script substitution must be reviewed.');
  await native.runner(process.execPath, ['--input-type=module', '-e', script], {input: JSON.stringify({identity: {}, bundle: {}, cache: '/fixture/cache'})});
  assert.deepEqual(vectors(native.calls), [[process.execPath, ['--input-type=module', '-e', script]]]);
});

test('Linux persisted Secret Service shell and interpreter aliases refuse before native dispatch', async t => {
  const paths = await fixture(t, 'linux'), native = dispatch(t);
  const binaries = ['/bin/sh'];
  for (const [name, target] of [['shell', '/bin/sh'], ['node', process.execPath]]) {
    const directory = join(paths.home, name), binary = join(directory, 'secret-tool');
    await mkdir(directory, {mode: 0o700});
    await symlink(target, binary);
    binaries.push(binary);
  }
  for (const binary of binaries) {
    await assert.rejects(selectSecretStore({paths, endpoint: new URL('https://ai.maddots.app'),
      env: {PATH: join(paths.home, 'shell') + ':' + join(paths.home, 'node'), DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus'},
      saved: {status: 'connected', tokenStorage: 'secret-service', credentialBackendSelected: true, secretServiceBinary: binary}}),
    {code: 'SECRET_STORE_UNAVAILABLE'});
    assert.equal(native.calls.length, 0, `The saved executable ${binary} must never reach execFile.`);
  }
});
