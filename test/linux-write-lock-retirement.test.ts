import assert from 'node:assert/strict';
import type {BigIntStats} from 'node:fs';
import fsPromises from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {userInfo} from 'node:os';
import {posix} from 'node:path';
import test from 'node:test';
import type {TestContext} from 'node:test';
import {HelperError, type Runner} from '../src/config.js';
import type { LinuxProcess } from '../src/linux-proc.js';
import {
  captureRetirement, linuxLockRetirementUnverified, LINUX_LOCK_RETIREMENT_UNVERIFIED_MESSAGE,
  pendingRetirement, restartLegacyService, validLinuxRecoveryMask, validateLinuxRecoveryMask,
  verifyLinuxRecoveryEntrypoints, type LinuxRecoveryMask, type RetirementOptions,
} from '../src/write-lock-retirement.js';

const BOOT = '11111111-1111-4111-8111-111111111111';
const OTHER_BOOT = '22222222-2222-4222-8222-222222222222';
const UID = 501, OWN = 700, OLD = 800;
const refusal = {code: 'LINUX_LOCK_RETIREMENT_UNVERIFIED', message: 'Linux lock retirement cannot be verified. Keep runs disabled; have the installation owner stop old helper/update entrypoints and follow the S5-10 recovery procedure. Retained state is preserved.'};
function row(pid: number, ticks = '123', exe = '/opt/tools/node'): LinuxProcess {
  return {pid, ppid: 1, pgid: pid, sid: String(pid), uid: UID, state: 'S', zombie: false,
    bootId: BOOT, startTicks: ticks, startedAt: `linux:${BOOT}:${ticks}`, exe};
}
function fixture() {
  const data = {boot: BOOT, rows: [row(OWN), row(OLD)], failure: false, calls: [] as {uid: number; exe?: boolean}[]};
  const options: RetirementOptions = {platform: 'linux', uid: UID, pid: OWN, linux: {
    boot: async () => data.boot,
    table: async args => {data.calls.push(args); if (data.failure) throw new Error('PRIVATE_DETAILS'); return data.rows;},
  }};
  return {data, options};
}

test('Linux retirement exports one stable recovery refusal without private inspection details', () => {
  const first = linuxLockRetirementUnverified(), second = linuxLockRetirementUnverified();
  assert.ok(first instanceof HelperError);
  assert.notEqual(first, second);
  assert.equal(first.code, refusal.code);
  assert.equal(first.message, refusal.message);
  assert.equal(LINUX_LOCK_RETIREMENT_UNVERIFIED_MESSAGE, refusal.message);
});

test('Linux retirement retains boot and start ticks, verified executable paths and unknown native hosts', async () => {
  const f = fixture();
  f.data.rows.push(row(801, '124', '/usr/bin/bash'), row(802, '125', '/usr/libexec/custom-host'));
  const retirement = await captureRetirement(f.options);
  assert.deepEqual(retirement, {boot: BOOT, processes: [
    {pid: OWN, started: `linux:${BOOT}:123`, executable: process.execPath},
    {pid: OLD, started: `linux:${BOOT}:123`, executable: '/opt/tools/node'},
    {pid: 802, started: `linux:${BOOT}:125`, executable: '/usr/libexec/custom-host'},
  ]});
  assert.deepEqual(f.data.calls, [{uid: UID, exe: true}]);
});

test('Linux retirement ignores zombies, reuses neither PID nor executable title as identity', async () => {
  const f = fixture(), saved = await captureRetirement(f.options);
  f.data.rows[1] = {...row(OLD), exe: '/a/new/title'};
  assert.deepEqual(await pendingRetirement(saved, f.options), saved.processes);
  f.data.rows[1] = row(OLD, '124');
  assert.deepEqual((await pendingRetirement(saved, f.options)).map(p => p.pid), [OWN]);
  f.data.rows[1] = {...row(OLD), zombie: true, state: 'Z', exe: undefined};
  assert.deepEqual((await pendingRetirement(saved, f.options)).map(p => p.pid), [OWN]);
  assert.deepEqual((await captureRetirement(f.options)).processes.map(p => p.pid), [OWN]);
  assert.equal(f.data.calls.slice(1, 4).every(call => call.exe === false), true, 'pending never requests executable or environment data');
});

test('Linux verified saved cohorts retire on boot change while incomplete scans explicitly refuse', async () => {
  const f = fixture(), saved = await captureRetirement(f.options);
  const retained = JSON.stringify(saved);
  f.data.boot = OTHER_BOOT; f.data.failure = true;
  assert.deepEqual(await pendingRetirement(saved, f.options), []);
  f.data.boot = BOOT;
  await assert.rejects(pendingRetirement(saved, f.options), refusal);
  await assert.rejects(captureRetirement(f.options), refusal);
  f.data.failure = false;
  for (const rows of [[], [row(OLD)], [row(OWN), row(OWN)], [row(OWN), {...row(OLD), uid: UID + 1}],
    [row(OWN), {...row(OLD), startedAt: 'invalid'}], [row(OWN), {...row(OLD), exe: undefined}],
    [row(OWN), {...row(OLD), bootId: OTHER_BOOT, startedAt: `linux:${OTHER_BOOT}:123`}]]) {
    f.data.rows = rows;
    await assert.rejects(captureRetirement(f.options), refusal);
  }
  assert.equal(JSON.stringify(saved), retained, 'inspection failures preserve the saved cohort');
});

test('Linux capture refuses a boot change during inspection instead of publishing an empty cohort', async () => {
  const f = fixture(), table = f.options.linux!.table;
  f.options.linux!.table = async args => {
    const rows = await table(args);
    f.data.boot = OTHER_BOOT;
    return rows;
  };
  await assert.rejects(captureRetirement(f.options), refusal);
  assert.deepEqual(f.data.calls, [{uid: UID, exe: true}], 'retirement never borrows contained outsider exclusions');
});

test('Linux inspection failures and invalid settings use the recovery refusal', async () => {
  for (const boot of ['invalid', '', `${BOOT}\n`]) {
    const f = fixture(); f.data.boot = boot;
    await assert.rejects(captureRetirement(f.options), refusal);
    await assert.rejects(pendingRetirement({boot: BOOT, processes: []}, f.options), refusal);
  }
  const failedBoot = fixture();
  failedBoot.options.linux!.boot = async () => {throw new Error('PRIVATE_BOOT_DETAILS');};
  await assert.rejects(captureRetirement(failedBoot.options), refusal);
  for (const options of [{uid: -1}, {pid: 0}, {uid: NaN}, {pid: Infinity}]) {
    await assert.rejects(captureRetirement({...fixture().options, ...options}), refusal);
  }
});

test('Linux persisted legacy wall-clock identities cannot clear a retirement barrier', async () => {
  const f = fixture(), saved = await captureRetirement(f.options);
  saved.processes[0].started = 'Fri Oct 23 12:00:00 2026';
  await assert.rejects(pendingRetirement(saved, f.options), refusal);
});

test('Linux valid cohort proof uses only metadata even when executable paths become unreadable', async () => {
  const f = fixture(), saved = await captureRetirement(f.options), retained = JSON.stringify(saved);
  f.data.rows = f.data.rows.map(value => ({...value, exe: undefined}));
  f.options.linux!.table = async args => {
    f.data.calls.push(args);
    assert.equal(args.exe, false, 'saved lifetime checks must not request ptrace-gated executable reads');
    return f.data.rows;
  };
  assert.deepEqual(await pendingRetirement(saved, f.options), saved.processes);
  f.data.rows = [row(OWN)];
  assert.deepEqual((await pendingRetirement(saved, f.options)).map(value => value.pid), [OWN]);
  assert.equal(JSON.stringify(saved), retained);
  assert.deepEqual(f.data.calls, [{uid: UID, exe: true}, {uid: UID, exe: false}, {uid: UID, exe: false}]);
});

const recoveryProperties = 'Id,LoadState,ActiveState,SubState,UnitFileState,MainPID,ActiveEnterTimestampMonotonic,InactiveExitTimestampMonotonic';
const systemUnit = 'mdai-helper.service', legacyUnit = 'app.maddots.ai.helper.service';
const maskPath = (scope: 'system' | 'user') => scope === 'system' ? `/etc/systemd/system/${systemUnit}` :
  posix.join(userInfo().homedir, '.config/systemd/user', legacyUnit);
function mask(scope: 'system' | 'user'): LinuxRecoveryMask {
  return {path: maskPath(scope), dev: '1', ino: scope === 'system' ? '100' : '200', ctimeNs: '123456789',
    parentDev: '1', parentIno: scope === 'system' ? '90' : '190', parentMtimeNs: '123456780', parentCtimeNs: '123456780'};
}
function recoveryUnit(unit: string, fields: Record<string, string> = {}): string {
  return Object.entries({Id: unit, LoadState: 'masked', ActiveState: 'inactive', SubState: 'dead', UnitFileState: 'masked',
    MainPID: '0', ActiveEnterTimestampMonotonic: '0', InactiveExitTimestampMonotonic: '0', ...fields})
    .map(([key, value]) => `${key}=${value}\n`).join('');
}
function recoveryFixture() {
  const calls: {file: string; args: readonly string[]; env?: NodeJS.ProcessEnv; timeout?: number}[] = [];
  const data = {system: recoveryUnit(systemUnit), user: recoveryUnit(legacyUnit), stderr: '', failure: false,
    masks: {system: mask('system'), user: mask('user')}, maskCalls: [] as ('system' | 'user')[]};
  const options: RetirementOptions = {...fixture().options, recoveryMask: async scope => {
    data.maskCalls.push(scope); return {...data.masks[scope]};
  }, runner: async (file, args, settings) => {
    calls.push({file, args: [...args], env: settings?.env, timeout: settings?.timeout});
    if (data.failure) throw new Error('PRIVATE_SERVICE_DETAILS');
    return {stdout: args[0] === '--user' ? data.user : data.system, stderr: data.stderr};
  }};
  return {calls, data, options};
}

test('Linux recovery verifies persistent masks for both fixed entrypoints with bounded read-only commands', async () => {
  const f = recoveryFixture();
  assert.deepEqual(await verifyLinuxRecoveryEntrypoints(true, f.options), [
    {scope: 'system', unit: systemUnit, loadState: 'masked', activeState: 'inactive', subState: 'dead', unitFileState: 'masked',
      mainPid: 0, activeEnterTimestampMonotonic: '0', inactiveExitTimestampMonotonic: '0', mask: mask('system')},
    {scope: 'user', unit: legacyUnit, loadState: 'masked', activeState: 'inactive', subState: 'dead', unitFileState: 'masked',
      mainPid: 0, activeEnterTimestampMonotonic: '0', inactiveExitTimestampMonotonic: '0', mask: mask('user')},
  ]);
  assert.deepEqual(f.calls, [
    {file: '/usr/bin/systemctl', args: ['show', systemUnit, `--property=${recoveryProperties}`],
      env: {LC_ALL: 'C', TZ: 'UTC0'}, timeout: 2000},
    {file: '/usr/bin/systemctl', args: ['--user', 'show', legacyUnit, `--property=${recoveryProperties}`, '--no-pager'],
      env: {LC_ALL: 'C', TZ: 'UTC0', XDG_RUNTIME_DIR: '/run/user/501', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/501/bus'}, timeout: 2000},
  ]);
  assert.deepEqual(f.data.maskCalls, ['system', 'user', 'system', 'user'], 'Both masks bracket the complete live service observation.');
});

test('Linux recovery mask schema rejects missing, expanded, noncanonical and nonpositive identity metadata', () => {
  assert.equal(validLinuxRecoveryMask(mask('system')), true);
  assert.equal(validLinuxRecoveryMask(mask('user')), true);
  for (const invalid of [null, [], {}, {...mask('system'), extra: 'ignored'}, {...mask('system'), path: '/etc/systemd/../system/x'},
    {...mask('system'), path: '/etc/systemd/system/bad\n'}, ...['dev', 'ino', 'ctimeNs', 'parentDev', 'parentIno', 'parentMtimeNs', 'parentCtimeNs']
      .flatMap(key => ['0', '-1', '01', '1.0', '', '1\n', '1'.repeat(33), 1].map(value => ({...mask('system'), [key]: value})))]) {
    assert.equal(validLinuxRecoveryMask(invalid), false);
    assert.throws(() => validateLinuxRecoveryMask(invalid), refusal);
  }
  assert.throws(() => validateLinuxRecoveryMask({...mask('system'), path: '/arbitrary/masked.service'}, 'system'), refusal);
  assert.throws(() => validateLinuxRecoveryMask({...mask('user'), path: '/arbitrary/user/masked.service'}, 'user'), refusal);
});

test('Linux recovery refuses absent units and mask replacement or parent changes even when activation timestamps reset to zero', async () => {
  for (const scope of ['system', 'user'] as const) {
    const absent = recoveryFixture();
    absent.data[scope] = recoveryUnit(scope === 'system' ? systemUnit : legacyUnit, {LoadState: 'not-found', UnitFileState: ''});
    await assert.rejects(verifyLinuxRecoveryEntrypoints(true, absent.options), refusal);
    for (const field of ['dev', 'ino', 'ctimeNs', 'parentDev', 'parentIno', 'parentMtimeNs', 'parentCtimeNs'] as const) {
      const f = recoveryFixture(), runner = f.options.runner!;
      f.options.runner = async (...args) => {
        const result = await runner(...args);
        f.data.masks[scope] = {...f.data.masks[scope], [field]: '999999999'};
        return result;
      };
      await assert.rejects(verifyLinuxRecoveryEntrypoints(true, f.options), refusal);
    }
  }
  const failed = recoveryFixture();
  failed.options.recoveryMask = async () => {throw new Error('PRIVATE_MASK_INSPECTION');};
  await assert.rejects(verifyLinuxRecoveryEntrypoints(true, failed.options), refusal);
  assert.equal(failed.calls.length, 0);
});

/** All mask filesystem calls are synthetic; this never inspects installed units. */
function maskFilesystem(t: TestContext) {
  const entries = new Map<string, BigIntStats>(), targets = new Map<string, string>();
  let inode = 10n;
  const stat = (link: boolean, uid: bigint): BigIntStats => ({dev: 1n, ino: inode++, uid, gid: uid,
    mode: link ? 0o120777n : 0o40755n, nlink: 1n, ctimeNs: 123456789n, mtimeNs: 123456780n,
    isDirectory: () => !link, isSymbolicLink: () => link}) as BigIntStats;
  for (const scope of ['system', 'user'] as const) {
    const path = maskPath(scope), parent = posix.dirname(path);
    const ancestors = ['/', ...parent.split('/').filter(Boolean).map((_part, index, parts) => '/' + parts.slice(0, index + 1).join('/'))];
    for (const directory of ancestors) if (!entries.has(directory)) entries.set(directory, stat(false, 0n));
    if (scope === 'user') entries.set(parent, stat(false, BigInt(UID)));
    entries.set(path, stat(true, scope === 'system' ? 0n : BigInt(UID)));
    targets.set(path, '/dev/null');
  }
  const data: {stat?: (path: string, info: BigIntStats) => BigIntStats; link?: (path: string, target: string) => string} = {};
  const reads: string[] = [];
  t.mock.method(fsPromises, 'lstat', (async (path, options) => {
    assert.deepEqual(options, {bigint: true});
    const info = entries.get(String(path));
    if (!info) throw new Error('PRIVATE_MISSING_MASK_METADATA');
    return {...(data.stat?.(String(path), info) ?? info)};
  }) as typeof fsPromises.lstat);
  t.mock.method(fsPromises, 'readlink', (async path => {
    const target = targets.get(String(path));
    if (target === undefined) throw new Error('PRIVATE_UNEXPECTED_LINK_REQUEST');
    reads.push(String(path));
    return data.link?.(String(path), target) ?? target;
  }) as typeof fsPromises.readlink);
  syncBuiltinESMExports();
  t.after(() => {t.mock.restoreAll(); syncBuiltinESMExports();});
  return {entries, targets, data, reads};
}

test('Linux recovery reads both mask link targets before and after stable owner-checked metadata', async t => {
  const files = maskFilesystem(t), f = recoveryFixture();
  delete f.options.recoveryMask;
  const observed = await verifyLinuxRecoveryEntrypoints(true, f.options);
  for (const entry of observed) {
    const path = maskPath(entry.scope), info = files.entries.get(path)!;
    assert.equal(entry.mask.path, path);
    assert.equal(entry.mask.ino, info.ino.toString());
    assert.equal(entry.mask.ctimeNs, info.ctimeNs.toString());
    assert.equal(files.reads.filter(value => value === path).length, 4, 'Each observation brackets the target, and each mask brackets both service queries.');
  }
});

test('Linux recovery refuses wrong targets, owners, unsafe parents, symlink ancestors and changing mask metadata', async t => {
  const variants = ['target', 'regular-mask', 'mask-owner', 'hardlinked-mask', 'parent-owner', 'parent-writable',
    'parent-symlink', 'ancestor-symlink', 'missing-mask', 'link-race', 'mask-race', 'parent-race'] as const;
  for (const variant of variants) await t.test(variant, async context => {
    const files = maskFilesystem(context), f = recoveryFixture();
    delete f.options.recoveryMask;
    const path = maskPath('system'), parent = posix.dirname(path);
    const link = files.entries.get(path)!, directory = files.entries.get(parent)!;
    if (variant === 'target') files.targets.set(path, '/dev/zero');
    if (variant === 'regular-mask') files.entries.set(path, {...link, isSymbolicLink: () => false});
    if (variant === 'mask-owner') files.entries.set(path, {...link, uid: 1n});
    if (variant === 'hardlinked-mask') files.entries.set(path, {...link, nlink: 2n});
    if (variant === 'parent-owner') files.entries.set(parent, {...directory, uid: 1n});
    if (variant === 'parent-writable') files.entries.set(parent, {...directory, mode: 0o40777n});
    if (variant === 'parent-symlink') files.entries.set(parent, {...directory, isSymbolicLink: () => true});
    if (variant === 'ancestor-symlink') files.entries.set('/etc', {...files.entries.get('/etc')!, isSymbolicLink: () => true});
    if (variant === 'missing-mask') files.entries.delete(path);
    let seen = 0;
    if (variant === 'link-race') files.data.link = (name, target) => name === path && ++seen > 1 ? '/dev/zero' : target;
    if (variant === 'mask-race') files.data.stat = (name, info) => name === path && ++seen > 1 ? {...info, ctimeNs: info.ctimeNs + 1n} : info;
    if (variant === 'parent-race') files.data.stat = (name, info) => name === parent && ++seen > 1 ? {...info, mtimeNs: info.mtimeNs + 1n} : info;
    await assert.rejects(verifyLinuxRecoveryEntrypoints(true, f.options), refusal);
    assert.equal(f.calls.length, 0, 'Unsafe mask evidence cannot proceed to a service query.');
  });
});

test('Linux preboot entrypoint sealing tolerates old stop timestamps but postboot checks reject any old autostart evidence', async () => {
  for (const scope of ['system', 'user'] as const) {
    for (const key of ['ActiveEnterTimestampMonotonic', 'InactiveExitTimestampMonotonic']) {
      const f = recoveryFixture(), unit = scope === 'system' ? systemUnit : legacyUnit;
      f.data[scope] = recoveryUnit(unit, {[key]: '123456789'});
      const observed = await verifyLinuxRecoveryEntrypoints(false, f.options);
      const entry = observed.find(value => value.scope === scope)!;
      assert.equal(key === 'ActiveEnterTimestampMonotonic' ? entry.activeEnterTimestampMonotonic : entry.inactiveExitTimestampMonotonic, '123456789');
      await assert.rejects(verifyLinuxRecoveryEntrypoints(true, f.options), refusal);
    }
  }
});

test('Linux recovery refuses running, aliased, enabled, runtime-masked and uncertain entrypoint states', async () => {
  const invalid: Record<string, string>[] = [
    {Id: 'another.service'}, {LoadState: 'loaded'}, {LoadState: 'error'}, {ActiveState: 'active'}, {ActiveState: 'failed'},
    {SubState: 'running'}, {MainPID: '800'}, {MainPID: '00'}, {UnitFileState: 'enabled'}, {UnitFileState: 'disabled'},
    {UnitFileState: 'masked-runtime'}, {LoadState: 'not-found'}, {LoadState: 'not-found', UnitFileState: '', MainPID: '800'},
    {ActiveEnterTimestampMonotonic: ''}, {InactiveExitTimestampMonotonic: '-1'}, {ActiveEnterTimestampMonotonic: '00'},
    {InactiveExitTimestampMonotonic: '1\r'}, {ActiveEnterTimestampMonotonic: '1.0'},
  ];
  for (const scope of ['system', 'user'] as const) for (const fields of invalid) {
    const f = recoveryFixture(), unit = scope === 'system' ? systemUnit : legacyUnit;
    f.data[scope] = recoveryUnit(unit, fields);
    await assert.rejects(verifyLinuxRecoveryEntrypoints(false, f.options), refusal);
    assert.equal(f.calls.length, scope === 'system' ? 1 : 2);
  }
});

test('Linux recovery refuses incomplete, duplicate, expanded or failed entrypoint inspection without disclosing output', async () => {
  for (const scope of ['system', 'user'] as const) {
    const valid = recoveryUnit(scope === 'system' ? systemUnit : legacyUnit);
    for (const stdout of ['', valid.trimEnd(), valid.replace('MainPID=0\n', ''), `${valid}\n`, `${valid}MainPID=0\n`,
      `${valid}Environment=PRIVATE_SERVICE_ENVIRONMENT\n`, `${valid}${'x'.repeat(4096)}\n`]) {
      const f = recoveryFixture(); f.data[scope] = stdout;
      await assert.rejects(verifyLinuxRecoveryEntrypoints(false, f.options), refusal);
    }
  }
  const failed = recoveryFixture(); failed.data.failure = true;
  const warned = recoveryFixture(); warned.data.stderr = 'PRIVATE_SERVICE_WARNING';
  await assert.rejects(verifyLinuxRecoveryEntrypoints(false, failed.options), refusal);
  await assert.rejects(verifyLinuxRecoveryEntrypoints(false, warned.options), refusal);
  const darwin = recoveryFixture();
  await assert.rejects(verifyLinuxRecoveryEntrypoints(false, {...darwin.options, platform: 'darwin'}), refusal);
  assert.equal(darwin.calls.length, 0);
});

test('Linux restarts only its exact helper unit when its MainPID is in the saved cohort', async () => {
  const f = fixture(), saved = await captureRetirement(f.options), calls: {file: string; args: readonly string[]}[] = [];
  const runner: Runner = async (file, args) => {
    calls.push({file, args});
    return {stdout: args[1] === 'show' ? `Id=app.maddots.ai.helper.service\nLoadState=loaded\nMainPID=${OLD}\n` : '', stderr: ''};
  };
  await restartLegacyService(saved.processes, {...f.options, runner});
  assert.deepEqual(calls, [
    {file: '/usr/bin/systemctl', args: ['--user', 'show', 'app.maddots.ai.helper.service', '--property=Id,LoadState,MainPID', '--no-pager']},
    {file: '/usr/bin/systemctl', args: ['--user', 'restart', 'app.maddots.ai.helper.service']},
  ]);
  for (const pid of [0, OWN, 999]) {
    calls.length = 0;
    await restartLegacyService(saved.processes, {...f.options, runner: async (file, args) => {
      calls.push({file, args: [...args]});
      return {stdout: `Id=app.maddots.ai.helper.service\nLoadState=loaded\nMainPID=${pid}\n`, stderr: ''};
    }});
    assert.equal(calls.length, 1);
  }
});

test('Linux malformed, aliased or failed service metadata cannot restart another service', async () => {
  const f = fixture(), pending = (await captureRetirement(f.options)).processes;
  for (const stdout of ['', 'Id=another.service\nLoadState=loaded\nMainPID=800\n',
    'Id=app.maddots.ai.helper.service\nLoadState=loaded\nMainPID=800',
    'Id=app.maddots.ai.helper.service\nLoadState=loaded\nMainPID=800\nMainPID=801\n',
    'Id=app.maddots.ai.helper.service\nLoadState=not-found\nMainPID=800\n',
    'Id=app.maddots.ai.helper.service\nLoadState=loaded\nMainPID=800\nEnvironment=PRIVATE\n']) {
    let calls = 0;
    await assert.rejects(restartLegacyService(pending, {...f.options, runner: async () => {
      calls++; return {stdout, stderr: ''};
    }}), {code: 'HELPER_BUSY'});
    assert.equal(calls, 1);
  }
  await assert.rejects(restartLegacyService(pending, {...f.options, runner: async () => {throw new Error('PRIVATE');}}),
    error => error instanceof Error && error.message.includes('systemctl --user restart app.maddots.ai.helper.service') && !error.message.includes('PRIVATE'));
});
