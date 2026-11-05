import assert from 'node:assert/strict';
import test from 'node:test';
import { CommandError, HelperError, type Runner } from '../src/config.js';
import { captureRetirement, formatRetirementMessage, isStockNonHostImage, pendingRetirement, restartLegacyService,
  type ProcessIdentity, type Retirement, type RetirementOptions } from '../src/write-lock-retirement.js';

const BOOT = '12345678-1234-1234-1234-123456789abc';
const NEXT_BOOT = 'abcdef12-1234-1234-1234-123456789abc';
const START = 'Fri Oct 23 12:00:00 2026';
const NEXT_START = 'Fri Oct 23 12:00:01 2026';
const OWN = 700;
const identity = (pid: number, executable = '/unknown/renamed-host', started = START): ProcessIdentity => ({pid, started, executable});
const row = (pid: number, _executable: string, uid = 501, started = START, state = 'S') => `${pid} ${uid} ${state} ${started}\n`;
const own = () => row(OWN, 'maddots-ai');
const cohort = (...processes: ProcessIdentity[]): Retirement => ({boot: BOOT, processes});
const serviceTable = (pid: number | '-' = 800, status: number | '-' = 0) => `PID\tStatus\tLabel\n${pid}\t${status}\tapp.maddots.ai.helper\n`;

function fixture(table = own()) {
  const calls: {file: string; args: readonly string[]; env?: NodeJS.ProcessEnv; timeout?: number}[] = [];
  const fake = {table, tables: undefined as string[] | undefined, boot: BOOT, list: serviceTable(), manageruid: '501\n', managername: 'Aqua\n',
    inspectionStderr: '', serviceStderr: '', kickStderr: '',
    failure: undefined as Error | undefined, serviceFailure: undefined as Error | undefined,
    kickFailure: undefined as Error | undefined, imageFailure: undefined as Error | undefined,
    images: new Map<number, string>(), absentImages: new Set<number>(), imageRequests: [] as number[][]};
  const runner: Runner = async (file, args, options) => {
    calls.push({file, args, env: options?.env, timeout: options?.timeout});
    if (fake.failure) throw fake.failure;
    if (file === '/usr/sbin/sysctl') return {stdout: fake.boot + '\n', stderr: fake.inspectionStderr};
    if (file === '/bin/ps') return {stdout: fake.tables?.shift() ?? fake.table, stderr: fake.inspectionStderr};
    assert.equal(file, '/bin/launchctl');
    if (args[0] === 'manageruid' || args[0] === 'managername' || args[0] === 'list') {
      assert.equal(args.length, 1, 'labelled list would read arguments/environment');
      if (fake.serviceFailure) throw fake.serviceFailure;
      return {stdout: fake[args[0]], stderr: fake.serviceStderr};
    }
    assert.deepEqual(args.slice(0, 2), ['kickstart', '-k']);
    if (fake.kickFailure) throw fake.kickFailure;
    return {stdout: '', stderr: fake.kickStderr};
  };
  const options: RetirementOptions = {runner, uid: 501, pid: OWN, platform: 'darwin', images: async pids => {
    fake.imageRequests.push([...pids]);
    if (fake.imageFailure) throw fake.imageFailure;
    return new Map(pids.filter(pid => !fake.absentImages.has(pid)).map(pid => [pid, fake.images.get(pid) ?? '/unknown/renamed-host']));
  }};
  return {fake, options, calls};
}

test('capture keeps unknown and renamed hosts, all interpreters and the current helper', async () => {
  const f = fixture(row(900, '/bin/zsh') + row(200, 'ordinary-app') + row(300, '/usr/bin/osascript') +
    row(400, '/usr/bin/python3') + row(500, '/usr/bin/ruby') + own());
  for (const pid of [300, 400, 500]) f.fake.images.set(pid, pid === 300 ? '/usr/bin/osascript' : pid === 400 ? '/usr/bin/python3' : '/usr/bin/ruby');
  const result = await captureRetirement(f.options);
  assert.equal(result.boot, BOOT);
  assert.deepEqual(result.processes.map(process => process.pid), [200, 300, 400, 500, OWN, 900]);
  // Process titles are never queried; only the kernel image can exempt a host.
  assert.equal(result.processes.find(process => process.pid === 900)?.executable, '/unknown/renamed-host');
  assert.deepEqual(f.fake.imageRequests, [[900, 200, 300, 400, 500]]);
  assert.deepEqual(f.calls.map(call => [call.file, call.args]), [
    ['/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']], ['/bin/ps', ['-U', '501', '-o', 'pid=,ruid=,state=,lstart=']],
    ['/bin/ps', ['-U', '501', '-o', 'pid=,ruid=,state=,lstart=']],
    ['/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']],
  ]);
  for (const call of f.calls) {
    assert.deepEqual(call.env, {LC_ALL: 'C', TZ: 'UTC0'});
    assert.equal(call.timeout, 2000);
    assert.doesNotMatch(call.args.join(' '), /comm=|command=|args=|-E\b/u);
  }
});

test('kernel image classification exempts stock shells and keeps unknown external and runtime hosts', async () => {
  const f = fixture(own() + row(800, 'node') + row(801, 'node') + row(802, 'node') + row(803, 'node'));
  f.fake.images.set(800, '/bin/zsh');
  f.fake.images.set(801, '/usr/sbin/cfprefsd');
  f.fake.images.set(802, '/System/Library/Unknown/Node.app/Contents/MacOS/node');
  f.fake.images.set(803, '/tmp/bin/zsh');
  assert.deepEqual((await captureRetirement(f.options)).processes.map(process => process.pid), [OWN, 802, 803]);
});

test('persistent stock secd, trustd and Finder do not keep the saved migration barrier closed', async () => {
  const stock = ['/usr/libexec/secd', '/usr/libexec/trustd', '/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder'];
  const table = stock.map((path, index) => row(800 + index, path)).join('');
  const f = fixture(own() + table);
  stock.forEach((path, index) => f.fake.images.set(800 + index, path));
  const saved = await captureRetirement(f.options);
  assert.deepEqual(saved.processes.map(process => process.pid), [OWN]);
  f.fake.table = row(701, 'fresh helper') + table;
  assert.deepEqual(await pendingRetirement(saved, {...f.options, pid: 701}), []);
});

test('stock root boundaries never exempt similarly named external roots', async () => {
  const paths = ['/usr/libexec-old/host', '/System/Library-old/host', '/usr/bin/unknown-host', '/usr/bin/python3'];
  const f = fixture(own() + paths.map((path, index) => row(800 + index, path)).join(''));
  paths.forEach((path, index) => f.fake.images.set(800 + index, path));
  assert.deepEqual((await captureRetirement(f.options)).processes.map(process => process.pid), [OWN, 800, 801, 802, 803]);
  assert.equal(isStockNonHostImage('/usr/libexec/../bin/zsh'), false);
  assert.equal(isStockNonHostImage('/System/Library'), false);
  assert.equal(isStockNonHostImage('/usr/libexec'), false);
});

test('known interpreters and extension hosts remain candidates inside stock roots', async () => {
  const names = ['node', 'nodejs', 'node22', 'bun', 'deno', 'Electron', 'osascript', 'python3', 'ruby3.4', 'perl5.40',
    'java', 'jsc', 'js', 'Extension Host', 'Code Helper (Plugin)'];
  const paths = names.flatMap(name => [`/usr/libexec/${name}`, `/System/Library/Frameworks/Runtime/${name}`]);
  const f = fixture(own() + paths.map((path, index) => row(800 + index, path)).join(''));
  paths.forEach((path, index) => f.fake.images.set(800 + index, path));
  assert.deepEqual((await captureRetirement(f.options)).processes.map(process => process.pid), [OWN, ...paths.map((_, index) => 800 + index)]);
});

test('current process is retained using its own executable without querying a mutable title', async () => {
  const f = fixture(row(OWN, '/bin/zsh'));
  assert.deepEqual((await captureRetirement(f.options)).processes, [identity(OWN, process.execPath)]);
  assert.deepEqual(f.fake.imageRequests, [[]]);
});

test('capture retires identities that changed or disappeared during image inspection', async () => {
  for (const second of [own(), own() + row(800, 'replacement', 501, NEXT_START)]) {
    const f = fixture(own() + row(800, 'legacy-host'));
    f.fake.tables = [f.fake.table, second];
    f.fake.images.set(800, '/bin/zsh');
    const saved = await captureRetirement(f.options);
    assert.deepEqual(saved.processes, [identity(OWN, process.execPath)]);
  }
});

test('another user reusing a captured PID during lookup never contributes a saved executable', async () => {
  const f = fixture(own() + row(800, 'legacy-host'));
  const replacementImage = '/Applications/Other Tool.app/Contents/MacOS/node';
  f.options.images = async pids => {
    assert.deepEqual(pids, [800]);
    // The real-UID-filtered post-lookup scan omits the other user's replacement,
    // even when it reuses the same start-time second as the captured process.
    f.fake.table = own();
    return new Map([[800, replacementImage]]);
  };
  const saved = await captureRetirement(f.options);
  assert.deepEqual(saved, cohort(identity(OWN, process.execPath)));
  assert.equal(JSON.stringify(saved).includes(replacementImage), false);
  assert.equal(formatRetirementMessage(saved.processes, OWN).includes(replacementImage), false);
});

test('same-user PID reuse with a different start time discards the replacement executable', async () => {
  const f = fixture(own() + row(800, 'legacy-host'));
  const replacementImage = '/Applications/New Tool.app/Contents/MacOS/node';
  f.options.images = async pids => {
    assert.deepEqual(pids, [800]);
    f.fake.table = own() + row(800, 'replacement', 501, NEXT_START);
    return new Map([[800, replacementImage]]);
  };
  const saved = await captureRetirement(f.options);
  assert.deepEqual(saved, cohort(identity(OWN, process.execPath)));
  assert.equal(JSON.stringify(saved).includes(replacementImage), false);
  assert.equal(formatRetirementMessage(saved.processes, OWN).includes(replacementImage), false);
});

test('a stable owned process retains only its verified retirement fields and remains pending', async () => {
  const f = fixture(own() + row(800, 'stable-host'));
  const image = '/Applications/Stable Tool.app/Contents/MacOS/Stable Tool';
  f.fake.images.set(800, image);
  const saved = await captureRetirement(f.options);
  assert.deepEqual(saved, cohort(identity(OWN, process.execPath), identity(800, image)));
  assert.deepEqual(await pendingRetirement(saved, f.options), saved.processes);
  assert.ok(formatRetirementMessage(saved.processes, OWN).includes(image));
});

test('a boot change during lookup retires the captured cohort without saving any paths', async () => {
  const f = fixture(own() + row(800, 'legacy-host'));
  f.options.images = async () => {
    f.fake.boot = NEXT_BOOT;
    return new Map([[800, '/replacement-boot/bin/node']]);
  };
  assert.deepEqual(await captureRetirement(f.options), cohort());
});

test('post-lookup ownership and lifetime inspection errors fail closed', async () => {
  for (const table of ['', own().trimEnd(), own() + row(800, 'other-user', 502)]) {
    const f = fixture(own() + row(800, 'legacy-host'));
    f.fake.tables = [f.fake.table, table];
    await assert.rejects(captureRetirement(f.options), {code: 'HELPER_BUSY'});
    assert.deepEqual(f.fake.imageRequests, [[800]]);
  }
});

test('post-lookup boot inspection errors fail closed without exposing output', async () => {
  for (const failure of ['invalid boot', 'PRIVATE_BOOT_WARNING', new Error('PRIVATE_BOOT_DETAILS')]) {
    const f = fixture(own() + row(800, 'legacy-host')), runner = f.options.runner!;
    f.options.runner = async (file, args, options) => {
      if (file === '/usr/sbin/sysctl' && f.fake.imageRequests.length) {
        if (failure instanceof Error) throw failure;
        return {stdout: failure === 'invalid boot' ? failure : BOOT, stderr: failure === 'invalid boot' ? '' : failure};
      }
      return runner(file, args, options);
    };
    await assert.rejects(captureRetirement(f.options), error => error instanceof HelperError &&
      error.code === 'HELPER_BUSY' && !/PRIVATE_/u.test(error.message));
  }
});

test('missing kernel images require independent disappearance proof before retiring an identity', async () => {
  const f = fixture(own() + row(800, '/bin/ps'));
  f.fake.absentImages.add(800);
  await assert.rejects(captureRetirement(f.options), {code: 'HELPER_BUSY'}, 'a missing image alone is not retirement evidence');
  f.fake.tables = [f.fake.table, own()];
  assert.deepEqual((await captureRetirement(f.options)).processes, [identity(OWN, process.execPath)]);
});

test('zombies at capture are retired without requesting their unavailable executable paths', async () => {
  const f = fixture(own() + row(800, 'exited host', 501, START, 'Z') + row(801, 'exited host', 501, START, 'ZN+'));
  f.fake.absentImages = new Set([800, 801]);
  const saved = await captureRetirement(f.options);
  assert.deepEqual(saved.processes, [identity(OWN, process.execPath)]);
  assert.deepEqual(f.fake.imageRequests, [[]]);
  f.fake.table = own(); // Later reaping must not change the retirement result.
  assert.deepEqual(await pendingRetirement(saved, f.options), saved.processes);
});

test('a process becoming a zombie during image lookup is independently confirmed as retired', async () => {
  for (const absentImage of [true, false]) {
    const f = fixture(own() + row(800, 'live host'));
    f.fake.tables = [f.fake.table, own() + row(800, 'exited host', 501, START, 'Z')];
    if (absentImage) f.fake.absentImages.add(800);
    assert.deepEqual((await captureRetirement(f.options)).processes, [identity(OWN, process.execPath)]);
    assert.deepEqual(f.fake.imageRequests, [[800]]);
  }
});

test('a saved cohort member retires as a zombie before reaping without altering the cohort', async () => {
  const f = fixture(own() + row(800, 'live host'));
  const saved = await captureRetirement(f.options), persisted = JSON.stringify(saved);
  assert.deepEqual(await pendingRetirement(saved, f.options), saved.processes);
  f.fake.table = own() + row(800, 'exited host', 501, START, 'Zs');
  assert.deepEqual(await pendingRetirement(saved, f.options), [identity(OWN, process.execPath)]);
  f.fake.table = own();
  assert.deepEqual(await pendingRetirement(saved, f.options), [identity(OWN, process.execPath)]);
  assert.equal(JSON.stringify(saved), persisted);
  assert.deepEqual(f.fake.imageRequests, [[800]], 'pending never requests executable paths');
});

test('sleeping, stopped and exiting states are not mistaken for zombies', async () => {
  for (const state of ['I', 'R+', 'S', 'T', 'U', 'SE', 'Ss']) {
    const f = fixture(own() + row(800, 'live host', 501, START, state));
    assert.deepEqual(await pendingRetirement(cohort(identity(800)), f.options), [identity(800)]);
    f.fake.absentImages.add(800);
    await assert.rejects(captureRetirement(f.options), {code: 'HELPER_BUSY'});
  }
});

test('pending comparisons retain changed titles and images and conservatively retain same-second PID reuse', async () => {
  const f = fixture(own() + row(800, '/a/completely/different/image') + row(801, '/bin/zsh'));
  const old = cohort(identity(800, '/old/legacy-helper'), identity(801, '/old/tool'));
  assert.deepEqual(await pendingRetirement(old, f.options), old.processes);
  assert.deepEqual(f.fake.imageRequests, [], 'pending does not reclassify or trust a changed executable');
});

test('pending retires only disappeared or differently started PIDs', async () => {
  const f = fixture(own() + row(800, 'reused', 501, NEXT_START));
  assert.deepEqual(await pendingRetirement(cohort(identity(800), identity(801), identity(OWN)), f.options), [identity(OWN)]);
});

test('a changed boot retires the cohort without requiring a process scan', async () => {
  const f = fixture('never parsed'); f.fake.boot = NEXT_BOOT;
  assert.deepEqual(await pendingRetirement(cohort(identity(800)), f.options), []);
  assert.equal(f.calls.length, 1);
});

test('process scans fail closed for missing, malformed, truncated, duplicate and incomplete tables', async () => {
  for (const table of ['', own().trimEnd(), own() + 'truncated', own() + '\n', own() + own(),
    row(800, 'unknown'), own() + row(801, 'unknown').replace('Oct 23', 'Feb 31'),
    own() + row(802, 'unknown').replace('Fri', 'Tue'), own() + row(803, 'unknown').replace('2026', '2026\u0001'),
    own() + row(804, 'other-user', 502), row(OWN, 'impossible own zombie', 501, START, 'Z'),
    ...['?', '', 'SZ', 'z', 'Zunknown'].map(state => own() + row(805, 'unknown state', 501, START, state))]) {
    const f = fixture(table);
    await assert.rejects(captureRetirement(f.options), {code: 'HELPER_BUSY'});
    await assert.rejects(pendingRetirement(cohort(identity(800)), f.options), {code: 'HELPER_BUSY'});
  }
});

test('command, image inspection and boot failures report an actionable safe error', async () => {
  const failed = fixture(); failed.fake.failure = new Error('PRIVATE_COMMAND_DETAILS');
  const image = fixture(own() + row(800, 'unknown')); image.fake.imageFailure = new Error('PRIVATE_IMAGE_DETAILS');
  const boot = fixture(); boot.fake.boot = 'invalid boot identity';
  const warning = fixture(); warning.fake.inspectionStderr = 'PRIVATE_INSPECTION_WARNING';
  for (const f of [failed, image, boot, warning]) {
    await assert.rejects(captureRetirement(f.options), error => error instanceof HelperError &&
      error.code === 'HELPER_BUSY' && /Retry the command/u.test(error.message) && !/PRIVATE_/u.test(error.message));
  }
  await assert.rejects(pendingRetirement(cohort(identity(800)), failed.options), {code: 'HELPER_BUSY'});
  await assert.rejects(captureRetirement({...fixture().options, platform: 'linux'}), {code: 'LINUX_LOCK_RETIREMENT_UNVERIFIED'});
});

test('invalid persisted identities cannot be mistaken for retired processes', async () => {
  for (const retirement of [cohort(identity(0)), cohort(identity(800, '')), cohort(identity(800, 'host', 'invalid')),
    cohort(identity(800), identity(800)), {...cohort(identity(800)), boot: 'invalid'}]) {
    await assert.rejects(pendingRetirement(retirement, fixture().options), {code: 'HELPER_BUSY'});
  }
});

test('service retirement restarts only the own label when launchd identifies a pending PID', async () => {
  const f = fixture();
  await restartLegacyService([identity(800), identity(OWN)], f.options);
  assert.deepEqual(f.calls.map(call => [call.file, call.args]), [
    ['/bin/launchctl', ['manageruid']], ['/bin/launchctl', ['managername']], ['/bin/launchctl', ['list']],
    ['/bin/launchctl', ['kickstart', '-k', 'gui/501/app.maddots.ai.helper']],
  ]);
});

test('service retirement never restarts itself, unrelated PIDs or an idle agent', async () => {
  for (const list of [serviceTable(OWN), serviceTable(999), serviceTable('-'), 'PID\tStatus\tLabel\n']) {
    const f = fixture(); f.fake.list = list;
    await restartLegacyService([identity(800), identity(OWN)], f.options);
    assert.equal(f.calls.length, 3);
    assert.deepEqual(f.calls.at(-1)?.args, ['list']);
  }
  const f = fixture();
  await restartLegacyService([identity(OWN)], f.options);
  await restartLegacyService([], f.options);
  assert.deepEqual(f.calls, []);
});

test('failed or malformed service inspection stays busy without disclosing output', async () => {
  const absentDomain = fixture(); absentDomain.fake.serviceFailure = new CommandError(113);
  const denied = fixture(); denied.fake.serviceFailure = new CommandError(77);
  const failed = fixture(); failed.fake.kickFailure = new Error('PRIVATE_SERVICE_DETAILS');
  const warning = fixture(); warning.fake.serviceStderr = 'PRIVATE_SERVICE_WARNING';
  const kickWarning = fixture(); kickWarning.fake.kickStderr = 'PRIVATE_KICK_WARNING';
  const malformed = fixture(); malformed.fake.list = 'PRIVATE_SERVICE_DETAILS\n';
  const multiple = fixture(); multiple.fake.list += '801\t0\tapp.maddots.ai.helper\n';
  for (const f of [absentDomain, denied, failed, warning, kickWarning, malformed, multiple]) {
    await assert.rejects(restartLegacyService([identity(800)], f.options), error => error instanceof HelperError &&
      error.code === 'HELPER_BUSY' && /launchctl kickstart -k gui\/501\/app\.maddots\.ai\.helper/u.test(error.message) &&
      !/PRIVATE_/u.test(error.message));
  }
});

test('service metadata accepts signed or absent exit status and matches only the exact label', async () => {
  for (const status of [0, -9, '-'] as const) {
    const f = fixture(); f.fake.list = serviceTable(800, status);
    await restartLegacyService([identity(800)], f.options);
    assert.equal(f.calls.at(-1)?.args[0], 'kickstart');
  }
  const f = fixture();
  f.fake.list = 'PID\tStatus\tLabel\n800\t0\tapp.maddots.ai.helper.extra\n801\t0\tuser label with spaces\n';
  await restartLegacyService([identity(800), identity(801)], f.options);
  assert.equal(f.calls.length, 3);
});

test('service lookup refuses unverified domains before reading any service table', async () => {
  for (const manageruid of ['0\n', '502\n', '', '501', '501\n502\n', '501\nPRIVATE_CONTEXT']) {
    const f = fixture(); f.fake.manageruid = manageruid;
    await assert.rejects(restartLegacyService([identity(800)], f.options), {code: 'HELPER_BUSY'});
    assert.deepEqual(f.calls.map(call => call.args), [['manageruid']]);
  }
  for (const managername of ['System\n', 'Background\n', 'LoginWindow\n', '', 'Aqua', 'Aqua\nPRIVATE_CONTEXT']) {
    const f = fixture(); f.fake.managername = managername;
    await assert.rejects(restartLegacyService([identity(800)], f.options), {code: 'HELPER_BUSY'});
    assert.deepEqual(f.calls.map(call => call.args), [['manageruid'], ['managername']]);
  }
  const root = fixture();
  await assert.rejects(restartLegacyService([identity(800)], {...root.options, uid: 0}), {code: 'HELPER_BUSY'});
  assert.deepEqual(root.calls, [], 'root legacy list must never collect the system service table');
});

test('all service inspection failures and warnings fail closed, including an unavailable domain', async () => {
  for (const command of ['manageruid', 'managername', 'list']) {
    for (const failure of [new CommandError(113), new CommandError(77), new Error('PRIVATE_DETAILS'), 'PRIVATE_WARNING']) {
      const f = fixture(), original = f.options.runner!;
      f.options.runner = async (file, args, options) => {
        if (args[0] === command) {
          if (typeof failure !== 'string') throw failure;
          return {stdout: f.fake[command as 'manageruid' | 'managername' | 'list'], stderr: failure};
        }
        return original(file, args, options);
      };
      await assert.rejects(restartLegacyService([identity(800)], f.options), error => error instanceof HelperError &&
        error.code === 'HELPER_BUSY' && !/PRIVATE_/u.test(error.message));
      assert.equal(f.calls.some(call => call.args[0] === 'kickstart'), false);
    }
  }
});

test('malformed, truncated, oversized or expanded service output never proves absence', async () => {
  const header = 'PID\tStatus\tLabel\n';
  for (const list of ['', 'PID\tStatus\tLabel', serviceTable().trimEnd(), serviceTable() + '\n',
    header + '0\t0\tapp.maddots.ai.helper\n', header + '-1\t0\tapp.maddots.ai.helper\n',
    header + '9007199254740992\t0\tapp.maddots.ai.helper\n', header + '800\t9007199254740992\tapp.maddots.ai.helper\n',
    header + '800\tunknown\tapp.maddots.ai.helper\n', header + '800\t0\t\n', header + '800\t0\tbad\tlabel\n',
    header + '800\t0\tbad\u0001label\n', header + '800\t0\tlabel\n801\t0\tlabel\n',
    header + 'PRIVATE_ARGUMENTS = {\nPRIVATE_ENVIRONMENT = {\n', header + 'a'.repeat(1024 * 1024) + '\n']) {
    const f = fixture(); f.fake.list = list;
    await assert.rejects(restartLegacyService([identity(800)], f.options), error => error instanceof HelperError &&
      error.code === 'HELPER_BUSY' && !/PRIVATE_/u.test(error.message));
    assert.equal(f.calls.length, 3);
  }
});

test('capture, pending and service commands request only current-user metadata and retain only identities', async () => {
  const f = fixture(own() + row(800, 'host'));
  const saved = await captureRetirement(f.options);
  await pendingRetirement(saved, f.options);
  await restartLegacyService(saved.processes, f.options);
  for (const call of f.calls) {
    if (call.file === '/bin/ps') assert.deepEqual(call.args, ['-U', '501', '-o', 'pid=,ruid=,state=,lstart=']);
    else if (call.file === '/bin/launchctl') assert.ok([
      ['manageruid'], ['managername'], ['list'], ['kickstart', '-k', 'gui/501/app.maddots.ai.helper'],
    ].some(args => JSON.stringify(args) === JSON.stringify(call.args)));
    else assert.deepEqual([call.file, call.args], ['/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']]);
    assert.deepEqual(call.env, {LC_ALL: 'C', TZ: 'UTC0'});
    assert.equal(call.timeout, call.args[0] === 'kickstart' ? 10_000 : 2000);
  }
  assert.deepEqual(saved, cohort(identity(OWN, process.execPath), identity(800)));
  assert.deepEqual(f.fake.imageRequests, [[800]]);
  const foreign = fixture(own() + row(900, 'other-user', 502));
  await assert.rejects(captureRetirement(foreign.options), {code: 'HELPER_BUSY'});
  assert.deepEqual(foreign.fake.imageRequests, [], 'unexpected other-user rows are never inspected or saved');
});

test('instructions identify exact process labels and request a fresh helper retry without a Mac restart', () => {
  const message = formatRetirementMessage([identity(OWN), identity(800, '/Applications/Old Tool.app/Contents/MacOS/Old Tool'),
    identity(801, '/renamed/cli-host')], OWN);
  assert.match(message, /Wait for running helper commands, then retry/u);
  assert.match(message, /Quit and reopen.*Old Tool \(PID 800\).*cli-host \(PID 801\)/u);
  assert.match(message, /wait for them to finish or close their owning command terminal/u);
  assert.match(message, /Let this helper command finish, then retry it in a new process/u);
  assert.doesNotMatch(message, /Mac restart|Restart the Mac|kill\b/u);
  assert.doesNotMatch(message, new RegExp(`PID ${OWN}`, 'u'));
  const nodes = formatRetirementMessage([identity(800, '/opt/tools-a/bin/node'), identity(801, '/opt/tools-b/bin/node')], OWN);
  assert.match(nodes, /node \(PID 800\) at \/opt\/tools-a\/bin\/node/u);
  assert.match(nodes, /node \(PID 801\) at \/opt\/tools-b\/bin\/node/u);
});
