// Exercise installed module bytes, including the released ef85906 resolver, rather
// than substituting a second copy of the new lock algorithm for an old runtime.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, rmdir, symlink, writeFile, type FileHandle } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import type { CliOptions } from '../src/cli.js';
import { clock, readConfig, type Timing } from '../src/config.js';
import { createPaths, ensurePaths, ensurePrivateDirectory, type HelperPaths } from '../src/paths.js';
import { RELEASE_IDENTITY, VERSION, type ReleaseIdentity } from '../src/release-identity.js';
import type { RuntimeContext } from '../src/runtime.js';
import type { UpdateBackend, UpdateOptions } from '../src/updater.js';
import type { LinuxRecoveryMask } from '../src/write-lock-retirement.js';
import { installLocalCliGraph } from './fixtures/local-installed-graph.js';

const require = createRequire(import.meta.url);
const filesystem = require('node:fs/promises') as typeof import('node:fs/promises');
const processes = require('node:child_process') as typeof import('node:child_process');
const helper = dirname(fileURLToPath(new URL('../src/paths.ts', import.meta.url)));
const bootA = '11111111-1111-4111-8111-111111111111';
const bootB = '22222222-2222-4222-8222-222222222222';
const linuxRefusal = {code: 'LINUX_LOCK_RETIREMENT_UNVERIFIED', message: 'Linux lock retirement cannot be verified. Keep runs disabled; have the installation owner stop old helper/update entrypoints and follow the S5-10 recovery procedure. Retained state is preserved.'};
const linuxSourceRefusal = {code: 'LINUX_LOCK_RETIREMENT_UNVERIFIED', message: 'Linux retained state cannot be attributed to a supported released helper or this revision\'s coordinator. Retained state is preserved. The installation owner must follow the internal pre-release clean-reinstall procedure in docs/design/linux-write-lock-recovery.md.'};
const crashedPid = 2_000_000_009;
const servicePid = 2_000_000_010, cliPid = 2_000_000_011, toolPid = 2_000_000_012;
// Installed releases already pin their selector identity. Keep the synthetic
// cache receipts bound to that identity when these tests run in an export.
const source: Readonly<ReleaseIdentity> = RELEASE_IDENTITY ?? {repository: 'fixture/helper', workflowPath: '.github/workflows/helper-release.yml',
  allowedSigner: 'fixture-only signer', releasePrefix: 'helper-', assetName: 'helper.tgz'};
const artifact = 'local fixture artifact';
const digest = createHash('sha256').update(artifact).digest('hex');
const commitA = 'a'.repeat(40), commitB = 'b'.repeat(40);
const migrationOrder = ['linux-proc', 'process-image', 'write-lock-retirement', 'write-lock-recovery', 'write-lock-upgrade', 'write-lock'] as const;
const protocolTwo = JSON.parse(await readFile(new URL('./fixtures/protocol-two-modules.json', import.meta.url), 'utf8')) as {
  commit: string; modules: Record<string, string>;
};
const protocolThree = JSON.parse(await readFile(new URL('./fixtures/protocol-three-modules.json', import.meta.url), 'utf8')) as typeof protocolTwo;
const retainedF908 = JSON.parse(await readFile(new URL('./fixtures/f908a8d-launch-modules.json', import.meta.url), 'utf8')) as typeof protocolTwo;
const releasedUpdater = JSON.parse(await readFile(new URL('./fixtures/released-updater-modules.json', import.meta.url), 'utf8')) as {
  sources: {version: string; commit: string}[]; blob: string; updater: string;
};
const releasedPaths = JSON.parse(await readFile(new URL('./fixtures/released-path-modules.json', import.meta.url), 'utf8')) as {
  sources: {version: string; commit: string; blob: string; paths: string}[];
};
const releasedWriters = JSON.parse(await readFile(new URL('./fixtures/released-writer-modules.json', import.meta.url), 'utf8')) as {
  sources: {version: string; commit: string; modules: Record<string, string>}[]; modules: Record<string, string>;
};
type Installation = boolean | 'protocol-2' | 'protocol-3' | 'f908a8d';
const errno = (code: string) => Object.assign(new Error(code), {code});
const candidate = (version: string) => ({name: 'maddots-ai', private: true, version, type: 'module', bin: {'maddots-ai': 'dist/cli.js'}});

async function expectedLinuxStorage(paths: HelperPaths, env: NodeJS.ProcessEnv = {}) {
  const data = join(env.XDG_DATA_HOME || join(paths.home, '.local/share'), 'maddots-ai');
  const config = join(env.XDG_CONFIG_HOME || join(paths.home, '.config'), 'maddots-ai');
  const state = join(env.XDG_STATE_HOME || join(paths.home, '.local/state'), 'maddots-ai');
  const defaultData = join(paths.home, '.local/share/maddots-ai');
  const defaultState = join(paths.home, '.local/state/maddots-ai');
  const legacy = join(paths.home, 'Library/Application Support/maddots-ai');
  const roots = new Set([paths.data, paths.config!, paths.stateDir!, paths.runtime!, data, config, state,
    join(state, 'runtime'), defaultData, join(paths.home, '.config/maddots-ai'), defaultState,
    join(defaultState, 'runtime'), legacy, join(paths.home, '.maddots-ai'), `/run/user/${process.getuid!()}/mdai`]);
  const states = new Set([paths.state, join(paths.data, 'state.json'), join(data, 'state.json'),
    join(state, 'state.json'), join(defaultData, 'state.json'), join(defaultState, 'state.json'), join(legacy, 'state.json')]);
  const units = new Set([paths.serviceUnit ?? paths.servicePlist,
    join(paths.home, '.config/systemd/user/app.maddots.ai.helper.service'),
    join(paths.home, 'Library/LaunchAgents/app.maddots.ai.helper.plist')]);
  for (const [parent, children, metadata] of [
    ['/var/lib/mdai', ['data', 'config/maddots-ai', 'state/maddots-ai', 'runs', 'home/.maddots-ai'], ['data', 'state/maddots-ai']],
    ['/run/mdai-helper', ['mdai'], []],
  ] as const) {
    let info;
    try {info = await lstat(parent);}
    catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error;}
    if (info.uid !== process.getuid!()) continue;
    for (const child of children) roots.add(join(parent, child));
    for (const child of metadata) states.add(join(parent, child, 'state.json'));
  }
  if (roots.has('/var/lib/mdai/home/.maddots-ai')) for (const unit of [
    '/var/lib/mdai/config/systemd/user/app.maddots.ai.helper.service',
    '/var/lib/mdai/home/.config/systemd/user/app.maddots.ai.helper.service',
    '/var/lib/mdai/home/Library/LaunchAgents/app.maddots.ai.helper.plist',
  ]) units.add(unit);
  return {roots: [...roots].sort(), states: [...states].sort(), units: [...units].sort()};
}

async function snapshotTree(root: string): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  async function visit(path: string) {
    const info = await lstat(path);
    result[path] = {ino: info.ino, mode: info.mode, uid: info.uid, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs,
      ...(info.isFile() ? {bytes: await readFile(path)} : {})};
    if (info.isDirectory()) for (const name of (await filesystem.readdir(path)).sort()) await visit(join(path, name));
  }
  await visit(root); return result;
}

type InstalledPaths = Pick<typeof import('../src/paths.js'), 'createPaths' | 'ensurePaths' | 'withWriteLock'>;
type Upgrade = typeof import('../src/write-lock-upgrade.js');
type Updater = typeof import('../src/updater.js');
type Cli = Pick<typeof import('../src/cli.js'), 'runCli'>;
type Runtime = Pick<typeof import('../src/runtime.js'), 'launchCli'>;
type Locks = Pick<typeof import('../src/write-lock.js'), 'acquireWriteGuard'>;
type ProcessFixture = {pid: number; started: string; executable: string; image?: string; uid?: number; state?: string; unreadableExe?: boolean};

async function fixture(t: TestContext, platform: 'darwin' | 'linux' = 'darwin', legacyBootstrap: Installation = true) {
  // Warm transitive modules using the host platform before emulating Darwin.
  // Every external command still goes through the explicit execFile fake below.
  await import('../src/cli.js');
  const home = await mkdtemp(join(await realpath(tmpdir()), 'mdai-lock-upgrade-'));
  // The installed-runtime fixture below emulates Darwin, even on a Linux host.
  // Use its matching layout before process.platform is temporarily replaced.
  const paths = await createPaths(readConfig({}, home, platform));
  await ensurePrivateDirectory(paths.data);
  const bundledRoot = join(home, 'bootstrap'), modernRoot = join(home, 'new-runtime');
  const originalOpen = filesystem.open, originalUnlink = filesystem.unlink, originalRename = filesystem.rename, originalLstat = filesystem.lstat;
  const originalExecFile = processes.execFile, originalKill = process.kill;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const guards = new Map<string, FileHandle | undefined>(), handles = new Set<FileHandle>();
  const pending: Promise<unknown>[] = [], resumes: (() => void)[] = [];
  const hooks: {beforeUnlink?: (path: string) => Promise<void>; beforeRename?: (to: string) => Promise<void>;
    beforeSync?: (path: string) => Promise<void>; beforeOpen?: (path: string, flags?: string | number) => Promise<void>} = {};
  let boot = bootA, closing = false, sysctlCalls = 0, generation = 0, service: number | undefined;
  let restartService = true;
  let recoveryEntrypointsDisabled = false, postBootActivation = false;
  const uid = process.getuid!();
  const table = new Map<number, ProcessFixture>();
  const commands: {file: string; args: string[]}[] = [];
  const linuxCalls: {kind: 'boot' | 'table' | 'mask'; exe?: boolean; scope?: 'system' | 'user'}[] = [];
  const recoveryMasks: Record<'system' | 'user', LinuxRecoveryMask> = {
    system: {path: '/etc/systemd/system/mdai-helper.service', dev: '1', ino: '10', ctimeNs: '100',
      parentDev: '1', parentIno: '11', parentMtimeNs: '101', parentCtimeNs: '102'},
    user: {path: join(userInfo().homedir, '.config/systemd/user/app.maddots.ai.helper.service'), dev: '2', ino: '20', ctimeNs: '200',
      parentDev: '2', parentIno: '21', parentMtimeNs: '201', parentCtimeNs: '202'},
  };
  function nextIdentity(pid: number) {
    const previous = table.get(pid);
    assert.ok(previous, `process ${pid} must exist before replacing its image`);
    table.set(pid, {...previous, started: `Fri Oct 23 12:00:${String(++generation).padStart(2, '0')} 2026`});
  }
  table.set(process.pid, {pid: process.pid, started: 'Fri Oct 23 12:00:00 2026', executable: process.execPath});
  function gate() {
    let resume!: () => void;
    const promise = new Promise<void>(done => {resume = done;});
    resumes.push(resume); if (closing) resume();
    return {promise, resolve: resume};
  }
  function track<T>(promise: Promise<T>) {pending.push(promise); void promise.catch(() => {}); return promise;}
  function clock() {
    let now = 0, changed = gate();
    const sleeps: (() => void)[] = [];
    const timing: Timing = {now: () => now, sleep: async ms => {
      const next = gate(); sleeps.push(next.resolve); changed.resolve(); changed = gate();
      await next.promise; now += ms;
    }};
    return {timing, sleeps, wait: async (n: number) => {while (sleeps.length <= n) await changed.promise;}};
  }
  Object.defineProperty(process, 'platform', {...originalPlatform, value: platform});
  const linuxFixture = globalThis as unknown as Record<string, unknown>;
  linuxFixture[home] = {
    mask: async (scope: 'system' | 'user') => {linuxCalls.push({kind: 'mask', scope}); return {...recoveryMasks[scope]};},
    boot: async () => {linuxCalls.push({kind: 'boot'}); return boot;},
    table: async (options: {exe?: boolean} = {}) => {
      linuxCalls.push({kind: 'table', exe: options.exe});
      const rows = [...table.values()].filter(row => (row.uid ?? uid) === uid);
      if (options.exe && rows.some(row => row.unreadableExe && !row.state?.startsWith('Z'))) throw errno('EACCES');
      return rows.map(row => ({
        pid: row.pid, uid: row.uid ?? uid, bootId: boot, startTicks: String(Date.parse(row.started + ' UTC')),
        startedAt: `linux:${boot}:${Date.parse(row.started + ' UTC')}`, zombie: row.state?.startsWith('Z') ?? false,
        exe: options.exe ? row.image ?? row.executable : undefined,
      }));
    },
  };
  processes.execFile = ((file: string, args: string[], options: {env: NodeJS.ProcessEnv}, done: (error: (Error & {code?: number}) | null, out: string, err: string) => void) => {
    commands.push({file, args: [...args]});
    let stdout = '';
    if (file === '/usr/sbin/sysctl') {
      assert.deepEqual(args, ['-n', 'kern.bootsessionuuid']);
      assert.deepEqual(options.env, {LC_ALL: 'C', TZ: 'UTC0'});
      sysctlCalls++; stdout = boot + '\n';
    } else if (file === '/bin/ps') {
      assert.deepEqual(args, ['-U', String(uid), '-o', 'pid=,ruid=,state=,lstart=']);
      assert.deepEqual(options.env, {LC_ALL: 'C', TZ: 'UTC0'});
      stdout = [...table.values()].filter(row => (row.uid ?? uid) === uid)
        .map(row => `${row.pid} ${row.uid ?? uid} ${row.state ?? 'S'} ${row.started}\n`).join('');
    } else if (file === '/usr/bin/osascript') {
      assert.deepEqual(args.slice(0, 3), ['-l', 'JavaScript', '-e']);
      assert.match(args[3], /proc_pidpath/); assert.deepEqual(options.env, {});
      stdout = JSON.stringify(args.slice(4).map(value => {
        const row = table.get(Number(value)); assert.ok(row, 'only live fixture processes may be inspected');
        if (row.state?.startsWith('Z')) return [row.pid, null, 'ESRCH'];
        return [row.pid, row.image ?? row.executable];
      }));
    } else if (file === '/bin/launchctl') {
      const target = `gui/${uid}/app.maddots.ai.helper`;
      assert.deepEqual(options.env, {LC_ALL: 'C', TZ: 'UTC0'});
      if (args[0] === 'manageruid') {
        assert.deepEqual(args, ['manageruid']); stdout = `${uid}\n`;
      } else if (args[0] === 'managername') {
        assert.deepEqual(args, ['managername']); stdout = 'Aqua\n';
      } else if (args[0] === 'list') {
        assert.deepEqual(args, ['list']);
        stdout = 'PID\tStatus\tLabel\n' + (service === undefined ? '' : `${service}\t0\tapp.maddots.ai.helper\n`);
      } else {
        assert.deepEqual(args, ['kickstart', '-k', target]);
        assert.notEqual(service, undefined, 'only the helper service may be restarted');
        if (restartService) nextIdentity(service!);
      }
    } else if (file === '/usr/bin/systemctl') {
      if (args.some(arg => arg.startsWith('--property=Id,LoadState,ActiveState,'))) {
        const system = args[0] === 'show', unit = system ? 'mdai-helper.service' : 'app.maddots.ai.helper.service';
        assert.deepEqual(args, [...(system ? [] : ['--user']), 'show', unit,
          '--property=Id,LoadState,ActiveState,SubState,UnitFileState,MainPID,ActiveEnterTimestampMonotonic,InactiveExitTimestampMonotonic',
          ...(system ? [] : ['--no-pager'])]);
        assert.deepEqual(options.env, {LC_ALL: 'C', TZ: 'UTC0', ...(system ? {} : {
          XDG_RUNTIME_DIR: `/run/user/${uid}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus`,
        })});
        stdout = `Id=${unit}\nLoadState=${recoveryEntrypointsDisabled ? 'masked' : 'loaded'}\nActiveState=inactive\nSubState=dead\n` +
          `UnitFileState=${recoveryEntrypointsDisabled ? 'masked' : 'enabled'}\nMainPID=0\n` +
          `ActiveEnterTimestampMonotonic=${postBootActivation ? 123 : 0}\nInactiveExitTimestampMonotonic=${postBootActivation ? 124 : 0}\n`;
      } else if (args[1] === 'show') stdout = `Id=app.maddots.ai.helper.service\nLoadState=loaded\nMainPID=${service ?? 0}\n`;
      else {
        assert.deepEqual(args, ['--user', 'restart', 'app.maddots.ai.helper.service']);
        if (restartService && service !== undefined) nextIdentity(service);
      }
    } else assert.fail(`no real command, installation or credential access is permitted: ${file}`);
    queueMicrotask(() => done(null, stdout, ''));
    return {stdin: {on() {}, end() {}}};
  }) as unknown as typeof originalExecFile;
  async function observedOpen(...args: Parameters<typeof originalOpen>) {
    await hooks.beforeOpen?.(String(args[0]), args[1]);
    const file = await originalOpen(...args), sync = file.sync.bind(file);
    file.sync = async () => {await hooks.beforeSync?.(String(args[0])); await sync();};
    return file;
  }
  filesystem.open = (async (...args: Parameters<typeof originalOpen>) => {
    const path = String(args[0]), flags = args[1];
    if (!path.endsWith('.guard') || platform === 'linux') return observedOpen(...args);
    assert.equal(typeof flags, 'number');
    const required = constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK | 0x20;
    assert.equal((flags as number) & required, required); assert.equal(args[2], 0o600);
    if (guards.has(path)) throw errno('EWOULDBLOCK');
    guards.set(path, undefined);
    let file: FileHandle;
    try {file = await observedOpen(args[0], (flags as number) & ~0x20, args[2]);}
    catch (error) {guards.delete(path); throw error;}
    handles.add(file); guards.set(path, file);
    const close = file.close.bind(file);
    file.close = async () => {await close(); handles.delete(file); if (guards.get(path) === file) guards.delete(path);};
    return file;
  }) as typeof originalOpen;
  filesystem.unlink = (async (...args: Parameters<typeof originalUnlink>) => {
    const path = String(args[0]);
    assert.ok(!path.endsWith('.guard'), 'the kernel guard must keep its stable inode');
    await hooks.beforeUnlink?.(path); await originalUnlink(...args);
  }) as typeof originalUnlink;
  filesystem.rename = (async (...args: Parameters<typeof originalRename>) => {
    await hooks.beforeRename?.(String(args[1])); return originalRename(...args);
  }) as typeof originalRename;
  // Model an installation outside a Git checkout. Some test hosts expose an
  // unrelated .git marker at the shared temporary-directory root. The exact
  // 0.1.5 resolver checks marker existence, so isolate only that external entry;
  // markers within this fixture HOME still reach the real filesystem.
  filesystem.lstat = (async (...args: Parameters<typeof originalLstat>) => {
    if (String(args[0]) === join(dirname(home), '.git')) throw errno('ENOENT');
    return originalLstat(...args);
  }) as typeof originalLstat;
  process.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
    assert.equal(signal, 0, 'migration may inspect a process but must not signal it');
    if (pid === crashedPid || !table.has(pid)) throw errno('ESRCH');
    return true;
  }) as typeof originalKill;
  syncBuiltinESMExports();
  t.after(async () => {
    closing = true; for (const resume of resumes) resume();
    await Promise.allSettled(pending);
    for (const handle of handles) await handle.close();
    filesystem.open = originalOpen; filesystem.unlink = originalUnlink; filesystem.rename = originalRename; filesystem.lstat = originalLstat;
    processes.execFile = originalExecFile; process.kill = originalKill;
    Object.defineProperty(process, 'platform', originalPlatform); syncBuiltinESMExports();
    delete linuxFixture[home];
    await rm(home, {recursive: true, force: true});
  });

  const migrationModules = new Set<string>(migrationOrder);
  const fixtureModules = new Set(['config', 'paths', ...migrationModules, 'updater', 'runtime', 'cli', 'release-identity']);
  const mockProc = (text: string) => text
    .replace('export async function linuxBootId(', 'async function fixtureActualLinuxBootId(')
    .replace('export async function linuxProcessTable(', 'async function fixtureActualLinuxProcessTable(') +
    `\nexport const linuxBootId = () => globalThis[${JSON.stringify(home)}].boot();\n` +
    `export const linuxProcessTable = options => globalThis[${JSON.stringify(home)}].table(options);\n`;
  async function install(root: string, legacy: Installation, version: string, updaterSource?: string, pathsSource?: string) {
    await installLocalCliGraph(helper, root, (path, text) => path === join(helper, 'linux-proc.ts') && platform === 'linux' ? mockProc(text) : text, home);
    await mkdir(join(root, 'dist'), {recursive: true, mode: 0o700});
    await writeFile(join(root, 'package.json'), JSON.stringify(candidate(version)), {mode: 0o600});
    if (legacy === 'protocol-2') await rm(join(root, 'dist/linux-proc.js'), {force: true});
    for (const name of fixtureModules) {
      if ((legacy === true && migrationModules.has(name)) || (legacy === 'protocol-2' && name === 'linux-proc')) continue;
      const retained = legacy === 'protocol-2' ? protocolTwo : legacy === 'protocol-3' ? protocolThree : legacy === 'f908a8d' ? retainedF908 : undefined;
      if ((retained && migrationModules.has(name) && !(name in retained.modules) && legacy !== 'f908a8d') ||
          (legacy === 'f908a8d' && name === 'write-lock-recovery')) continue;
      let text = name === 'updater' && (updaterSource !== undefined || legacy === true) ? updaterSource ?? releasedUpdater.updater :
        name === 'paths' && (pathsSource !== undefined || legacy === true) ? pathsSource ?? releasedPaths.sources[0].paths :
        retained?.modules[name] ?? await readFile(join(helper, name + '.ts'), 'utf8');
      if (name === 'linux-proc' && platform === 'linux') {
        // The same fixture process table used for Darwin ps supplies only the
        // environment-free /proc fields needed by installed migration code.
        text = mockProc(text);
      }
      if (name === 'write-lock-retirement' && platform === 'linux' && !retained) {
        const signature = 'export async function verifyLinuxRecoveryEntrypoints(postBoot: boolean, options: RetirementOptions = {})';
        assert.ok(text.includes(signature), 'only the explicit recovery mask function-argument seam may replace filesystem inspection');
        text = text.replace(signature, 'export async function verifyLinuxRecoveryEntrypoints(postBoot: boolean, options: RetirementOptions = ' +
          `{recoveryMask: scope => globalThis[${JSON.stringify(home)}].mask(scope)})`);
      }
      if (name === 'release-identity') {
        text = text.replace(`export const VERSION = '${VERSION}';`, `export const VERSION = '${version}';`)
          .replace('export const RELEASE_IDENTITY: Readonly<ReleaseIdentity> | null = null;',
            'export const RELEASE_IDENTITY: Readonly<ReleaseIdentity> | null = ' + JSON.stringify(source) + ';');
      }
      if (name === 'cli' && legacy !== false) {
        text = text.replace(', recoverLinuxLockUpgrade', '').replace(', createRecoveryPaths', '')
          .replace('(args.recovery ? createRecoveryPaths(config) : createPaths(config))', 'createPaths(config)')
          .replace(/^ {2}if \(args.recovery\) \{[\s\S]*?(?= {2}\/\/ home\/prepareLocks)/m, '');
        if (legacy === true) {
          text = text.replace(/^import \{ prepareLockUpgrade \}.*\n/m, '')
            .replace(/^ {2}\/\/ home\/prepareLocks[\s\S]*?(?= {2}await ensurePaths\(paths\);)/m, '');
        }
      }
      // Historical protocol-only fixtures retain their unrelated application
      // stubs. Released paths/updaters and every repaired module resolve the
      // installed dependency bytes, never TypeScript files in the checkout.
      if ((legacy === 'protocol-2' || legacy === 'protocol-3') && ['cli', 'runtime', 'updater'].includes(name)) {
        text = text.replace(/(^import[\s\S]*?\bfrom )'([^']+)'/gm, (match, prefix: string, specifier: string) => {
          if (specifier.startsWith('node:') || specifier.startsWith('./') && fixtureModules.has(specifier.slice(2, -3))) return match;
          const target = specifier.startsWith('.') ? resolve(helper, specifier.replace(/\.js$/, '.ts')) : require.resolve(specifier);
          return prefix + "'" + pathToFileURL(target).href + "'";
        });
      }
      const output = transpileModule(text, {fileName: name + '.ts', compilerOptions: {target: ScriptTarget.ES2022, module: ModuleKind.ESNext}}).outputText;
      await writeFile(join(root, 'dist', name + '.js'), output, {mode: 0o600});
    }
    if (legacy === true) for (const name of [...migrationOrder, 'runner/signal-gate']) await rm(join(root, 'dist', name + '.js'), {force: true});
    if (legacy === 'protocol-2' || legacy === 'protocol-3') {
      const retained = legacy === 'protocol-2' ? protocolTwo : protocolThree;
      for (const name of migrationOrder) if (!(name in retained.modules)) await rm(join(root, 'dist', name + '.js'), {force: true});
    }
    if (legacy === 'f908a8d') await rm(join(root, 'dist/write-lock-recovery.js'), {force: true});
  }
  await install(bundledRoot, legacyBootstrap, '0.1.5'); await install(modernRoot, false, '0.1.6');
  if (legacyBootstrap === 'protocol-2' || legacyBootstrap === 'protocol-3') {
    // Preserve the real migration record and actual modules at that revision.
    // Merely changing the protocol marker in modern bytes misses missing new
    // dependencies, which is the interruption this fixture must reproduce.
    const directory = join(bundledRoot, '.write-lock-upgrade');
    await ensurePrivateDirectory(directory);
    const sources: Record<string, string> = {};
    const retained = legacyBootstrap === 'protocol-2' ? protocolTwo : protocolThree;
    for (const name of Object.keys(retained.modules)) {
      const text = await readFile(join(bundledRoot, 'dist', name + '.js'), 'utf8');
      sources[name + '.js'] = createHash('sha256').update(text).digest('hex');
      await writeFile(join(directory, name + '.js'), text, {mode: 0o600});
    }
    await writeFile(join(directory, 'state.json'), JSON.stringify({protocol: legacyBootstrap === 'protocol-2' ? 2 : 3,
      bootstrap: bundledRoot, data: [paths.data], sources}) + '\n', {mode: 0o600});
    for (const root of [bundledRoot, modernRoot]) {
      await writeFile(join(root, 'dist/.write-lock-upgrade.json'), JSON.stringify({directory}) + '\n', {mode: 0o600});
    }
  }
  const runtime: RuntimeContext = {bundledRoot, runningRoot: modernRoot, bootstrapVersion: '0.1.5',
    bootstrapEntrypoint: join(bundledRoot, 'dist/cli.js')};
  const load = <T>(root: string, module: string, fresh = ''): Promise<T> => import(pathToFileURL(join(root, 'dist', module + '.js')).href + fresh);
  const upgrade = await load<Upgrade>(modernRoot, 'write-lock-upgrade');
  const guarded = await load<InstalledPaths>(modernRoot, 'paths');
  async function seed() {await writeFile(paths.lock, String(crashedPid), {mode: 0o600});}
  async function prepare() {await upgrade.prepareLockUpgrade(runtime, paths);}
  async function registerFreshLayout() {
    // Tests that exercise recovery of known storage first register a genuinely
    // empty installation. Restore the original installed bytes afterwards so
    // their real legacy repair and retirement behavior remains under test.
    const originals = new Map<string, Buffer | undefined>();
    for (const name of ['paths', ...migrationOrder]) {
      const path = join(bundledRoot, 'dist', name + '.js');
      try {originals.set(path, await readFile(path));}
      catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; originals.set(path, undefined);}
    }
    await install(bundledRoot, false, '0.1.5'); await prepare();
    for (const [path, bytes] of originals) {
      if (bytes === undefined) await rm(path, {force: true});
      else await writeFile(path, bytes, {mode: 0o600});
    }
  }
  async function recover(phase: 'seal' | 'complete', timing?: Timing) {await upgrade.recoverLinuxLockUpgrade(runtime, paths, phase, timing);}
  async function nextProcess() {nextIdentity(process.pid); await prepare();}
  async function preserveData(options: {passive?: boolean} = {}) {
    const originals = new Map<string, Buffer>();
    for (const [name, bytes] of [['state.json', '{"saved":"fixture-state"}\n'],
      [options.passive ? 'logs/original.bin' : 'holding/original.bin', '\u0000\u0001kept\n'],
      [options.passive ? 'cache/original.bin' : 'backups/original.bin', 'original backup\n']] as const) {
      const path = join(paths.data, name); await mkdir(resolve(path, '..'), {recursive: true, mode: 0o700});
      const buffer = Buffer.from(bytes); await writeFile(path, buffer, {mode: 0o600}); originals.set(path, buffer);
    }
    const packagePath = join(bundledRoot, 'package.json'); originals.set(packagePath, await readFile(packagePath));
    return async () => {for (const [path, bytes] of originals) assert.deepEqual(await readFile(path), bytes, path);};
  }
  function backend(commit: string, version: string): UpdateBackend {
    return {identity: source, latest: async () => ({commit, sha256: digest}), prepare: async (_release, target) => {
      // Stage old bytes deliberately. Publication must retrofit these too, so
      // later rollback cannot reintroduce an unsafe paths.js export.
      await install(target, true, version);
      await writeFile(join(target, '.artifact.tgz'), artifact, {mode: 0o600});
    }, validate: async () => {}};
  }
  const options: UpdateOptions = {paths, bundledRoot, version: '0.1.5', env: {}, force: true};
  return {home, paths, bundledRoot, modernRoot, runtime, upgrade, guarded, hooks, guards, gate, clock, track,
    load, install, seed, prepare, registerFreshLayout, recover, nextProcess, preserveData, backend, options, commands, table, linuxCalls, sysctlCalls: () => sysctlCalls,
    addProcess: (row: ProcessFixture) => {table.set(row.pid, row);}, retireProcess: (pid: number) => {table.delete(pid);}, nextIdentity,
    setService: (pid: number, automaticRestart = true) => {service = pid; restartService = automaticRestart;},
    setRecoveryEntrypoints: (disabled: boolean, activated = false) => {recoveryEntrypointsDisabled = disabled; postBootActivation = activated;},
    recoveryMasks: () => [structuredClone(recoveryMasks.system), structuredClone(recoveryMasks.user)],
    setRecoveryMask: (scope: 'system' | 'user', value: Partial<LinuxRecoveryMask>) => {Object.assign(recoveryMasks[scope], value);},
    setBoot: (value: string) => {boot = value;}};
}

async function installWriterModules(f: Awaited<ReturnType<typeof fixture>>, names: string[], released: boolean): Promise<void> {
  for (const name of names) {
    const sourcePath = join(helper, name + '.ts');
    const keys = releasedWriters.sources.map(source => source.modules[name]).filter((key): key is string => typeof key === 'string');
    const key = keys[0];
    if (released) {
      assert.ok(key, `The released fixture must contain ${name}.`);
      assert.ok(keys.every(value => value === key), 'supported pins that contain this module have these exact bytes');
      assert.equal(createHash('sha256').update(releasedWriters.modules[key]).digest('hex'), key);
    }
    const text = released ? releasedWriters.modules[key] : await readFile(sourcePath, 'utf8');
    const output = transpileModule(text, {fileName: name + '.ts',
      compilerOptions: {target: ScriptTarget.ES2022, module: ModuleKind.ESNext}}).outputText;
    await ensurePrivateDirectory(dirname(join(f.bundledRoot, 'dist', name + '.js')));
    await writeFile(join(f.bundledRoot, 'dist', name + '.js'), output, {mode: 0o600});
  }
}

test('completed Darwin revision 1 without Linux recovery sources admits matching launches without another retirement', {timeout: 20_000}, async t => {
  const f = await fixture(t, 'darwin', 'protocol-3');
  const directory = join(f.bundledRoot, '.write-lock-upgrade'), statePath = join(directory, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.revision = 1;
  assert.equal(state.sources['write-lock-recovery.js'], undefined);
  const completed = JSON.stringify(state) + '\n';
  await writeFile(statePath, completed, {mode: 0o600});
  const originals = new Map<string, Buffer>();
  for (const name of Object.keys(state.sources)) for (const root of [directory, join(f.bundledRoot, 'dist')]) {
    const path = join(root, name); originals.set(path, await readFile(path));
  }
  f.addProcess({pid: servicePid, started: 'Fri Oct 23 11:40:00 2026', executable: process.execPath});
  f.setService(servicePid, false);
  await f.guarded.withWriteLock(f.paths, async () => {});
  await f.prepare(); await f.prepare();
  await f.guarded.withWriteLock(f.paths, async () => {});
  assert.equal(await readFile(statePath, 'utf8'), completed, 'matching launches preserve the completed revision-1 record');
  for (const [path, bytes] of originals) assert.deepEqual(await readFile(path), bytes, path);
  for (const root of [directory, join(f.bundledRoot, 'dist')]) await assert.rejects(lstat(join(root, 'write-lock-recovery.js')), {code: 'ENOENT'});
  assert.deepEqual(f.commands, [], 'completed Darwin launches do not inspect a new retirement cohort or restart its service');
  assert.deepEqual(f.linuxCalls, []);
  assert.equal(f.guards.size, 0);
});

test('a new Darwin candidate imports and runs after a revision-1 coordinator repairs its validated stage', {timeout: 20_000}, async t => {
  const {installLocalCliGraph} = await import('./fixtures/local-installed-graph.js');
  const f = await fixture(t, 'darwin', 'protocol-3');
  const directory = join(f.bundledRoot, '.write-lock-upgrade'), statePath = join(directory, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.revision = 1;
  await writeFile(statePath, JSON.stringify(state) + '\n', {mode: 0o600});
  const stage = join(f.paths.data, 'updates/staging-darwin-revision-one');
  await f.install(stage, false, '0.1.6');
  const files = await installLocalCliGraph(helper, stage, (path, text) => path === join(helper, 'release-identity.ts') ?
    text.replace(`export const VERSION = '${VERSION}';`, "export const VERSION = '0.1.6';")
      .replace('export const RELEASE_IDENTITY: Readonly<ReleaseIdentity> | null = null;',
        'export const RELEASE_IDENTITY: Readonly<ReleaseIdentity> | null = ' + JSON.stringify(source) + ';') : text);
  assert.ok(files.includes(join(stage, 'dist/runner/process.js')));
  assert.ok(files.some(path => path.endsWith('/shared/tool-matrix.js')));
  for (const path of files) assert.doesNotMatch(await readFile(path, 'utf8'), /file:\/\/.*\.(?:ts|js)['"]/,
    'the application graph must import its installed dependency bytes');
  // Candidate validation precedes publication, so import this exact candidate
  // once before repair and use a fresh URL afterwards to exercise ESM linking.
  const validated = await f.load<Cli>(stage, 'cli');
  await validated.runCli(['--self-test']);
  await writeFile(join(stage, '.ready.json'), '{}\n', {mode: 0o600});
  await f.prepare();
  assert.deepEqual(await readFile(join(stage, 'dist/write-lock-upgrade.js')), await readFile(join(directory, 'write-lock-upgrade.js')));
  assert.doesNotMatch(await readFile(join(stage, 'dist/write-lock-upgrade.js'), 'utf8'), /recoverLinuxLockUpgrade/);
  assert.deepEqual(await readFile(join(stage, 'dist/linux-proc.js')), await readFile(join(directory, 'linux-proc.js')));
  assert.doesNotMatch(await readFile(join(stage, 'dist/linux-proc.js'), 'utf8'), /export function inspectLinuxProcessSync/);
  assert.deepEqual(await readFile(join(stage, 'dist/write-lock.js')), await readFile(join(directory, 'write-lock.js')));
  assert.doesNotMatch(await readFile(join(stage, 'dist/write-lock.js'), 'utf8'), /acquireDirectoryWriteGuard/);
  // A distinct installed path also gives dependencies fresh module URLs. A
  // query on cli.js alone would reuse the pre-repair coordinator dependency.
  const installed = join(f.paths.data, 'updates/releases', commitA);
  await mkdir(dirname(installed), {recursive: true, mode: 0o700});
  await filesystem.rename(stage, installed);
  for (const path of files) assert.doesNotMatch(await readFile(join(installed, path.slice(stage.length + 1)), 'utf8'), /file:\/\/.*\.(?:ts|js)['"]/,
    'coordinator repair must preserve the local application dependency graph');
  const repaired = await f.load<Cli>(installed, 'cli');
  await repaired.runCli(['--self-test']);
  const output: string[] = [];
  await repaired.runCli(['--help'], {platform: 'darwin', output: line => output.push(line)});
  assert.doesNotMatch(output[0], /recovery/);
  await assert.rejects(repaired.runCli(['recovery', 'seal'], {platform: 'darwin'}), {code: 'USAGE'});
  await repaired.runCli(['backups'], {home: f.home, platform: 'darwin', env: {}, output: line => output.push(line),
    runtime: {...f.runtime, runningRoot: installed},
    runner: async () => assert.fail('Darwin backup listing must not call recovery or services'),
    request: async () => assert.fail('Darwin backup listing must not access the network')});
  assert.equal(output.at(-1), 'No backups.');
  assert.deepEqual(f.linuxCalls, []);
  // Missing Linux-only exports must refuse Linux activation before process
  // inspection or storage creation, while Darwin commands remain usable.
  const processModule = await f.load<Pick<typeof import('../src/runner/process.js'), 'requireProcessInspection'>>(installed, 'runner/process');
  const storageModule = await f.load<Pick<typeof import('../src/runner/storage-lock.js'), 'retainRunnerStorageDirectory'>>(installed, 'runner/storage-lock');
  const loginModule = await f.load<Pick<typeof import('../src/runner/linux-selected-login.js'), 'LinuxSelectedLogin'>>(installed, 'runner/linux-selected-login');
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const refusedStorage = join(f.home, 'missing-linux-lock-abi');
  try {
    Object.defineProperty(process, 'platform', {...descriptor, value: 'linux'});
    await assert.rejects(processModule.requireProcessInspection(), {code: 'adapter_refused', message: /Linux synchronous process inspection is unavailable/});
    await assert.rejects(storageModule.retainRunnerStorageDirectory(refusedStorage), {code: 'LOCK_UNSAFE', message: /Linux directory write locking is unavailable/});
    await assert.rejects(lstat(refusedStorage), {code: 'ENOENT'});
    let opened = 0;
    f.hooks.beforeOpen = () => {opened++; assert.fail('missing lock capability must refuse before opening a selected profile');};
    try {
      await assert.rejects(loginModule.LinuxSelectedLogin.open({tool: 'codex', profilePath: refusedStorage}, {
        uid: process.getuid!(), deadline: Date.now() + 60_000,
      }), {code: 'LINUX_SELECTED_LOGIN_UNAVAILABLE'});
      assert.equal(opened, 0);
    } finally {f.hooks.beforeOpen = undefined;}
  } finally {Object.defineProperty(process, 'platform', descriptor);}
  assert.deepEqual(f.linuxCalls, []);
});

test('Linux launcher refuses retained f908a8d before equal-version selection can recreate a missing coordinator', {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux', false);
  const cached = join(f.paths.data, 'updates/releases', commitA);
  await f.install(cached, 'f908a8d', '0.1.6');
  await writeFile(join(cached, '.artifact.tgz'), artifact, {mode: 0o600});
  await writeFile(join(cached, '.ready.json'), JSON.stringify({...source, commit: commitA, sha256: digest, version: '0.1.6'}), {mode: 0o600});
  await writeFile(join(f.paths.data, 'updates/current.json'), JSON.stringify({current: commitA}), {mode: 0o600});
  const runtime = {...f.runtime, runningRoot: f.bundledRoot, bootstrapVersion: '0.1.6'};
  const updater = await f.load<Updater>(f.bundledRoot, 'updater');
  const selected = await updater.selectRelease({...f.options, version: '0.1.6'}, source);
  assert.equal(selected.root, cached, 'the historical release really passes the unchanged equal-version selector');
  const launcher = await f.load<Runtime>(f.bundledRoot, 'runtime');
  const bootstrap = await f.load<Upgrade>(f.bundledRoot, 'write-lock-upgrade');
  const before = await snapshotTree(f.home);
  const output: string[] = [];
  // Do not inject selection/load: the real selector and f908a8d CLI must be
  // reachable if the current bootstrap fails to establish its barrier first.
  await assert.rejects(launcher.launchCli(['status'], async () => assert.fail('the refused launcher must not run a command'), {
    home: f.home, platform: 'linux', env: {}, runtime, prepareLocks: bootstrap.prepareLockUpgrade,
    output: line => output.push(line),
  }), linuxSourceRefusal);
  assert.deepEqual(output, [linuxSourceRefusal.message]);
  await assert.rejects(lstat(join(f.bundledRoot, '.write-lock-upgrade')), {code: 'ENOENT'});
  assert.deepEqual(await snapshotTree(f.home), before, 'no retained preparation or bootstrap repair ran');
  assert.deepEqual(f.commands, []); assert.deepEqual(f.linuxCalls, []);
  // Informational launches retain selected version behavior without preparing.
  await launcher.launchCli(['--version'], async () => assert.fail('the selected release should report its version'), {
    home: f.home, platform: 'linux', env: {}, runtime, prepareLocks: bootstrap.prepareLockUpgrade,
    output: line => output.push(line),
  });
  assert.equal(output.at(-1), '0.1.6');
  assert.deepEqual(await snapshotTree(f.home), before);
});

test('Linux launcher preserves non-writing argument and capability failures on a fresh installation', {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux', false), launch = await f.load<Runtime>(f.bundledRoot, 'runtime');
  const before = await snapshotTree(f.home);
  for (const [argv, code] of [
    [['nonsense'], 'USAGE'], [['status', '--unexpected'], 'USAGE'], [['keys', 'status'], 'PROVIDER_KEYS_UNSUPPORTED'],
    [['allow'], 'ALLOW_TTY_REQUIRED'], [['connect', '--token-file', 'relative'], 'FILE_UNSAFE'],
  ] as const) {
    await assert.rejects(launch.launchCli([...argv], async () => assert.fail('invalid arguments cannot run'), {
      home: f.home, env: {}, platform: 'linux', runtime: f.runtime, isTTY: false,
      prepareLocks: async () => assert.fail('invalid arguments cannot prepare or repair modules'),
    }), {code});
  }
  assert.deepEqual(await snapshotTree(f.home), before);
  assert.deepEqual(f.commands, []); assert.deepEqual(f.linuxCalls, []);
});

test('Linux first installation initializes migration without retiring unrelated processes', {timeout: 20_000, skip: process.platform !== 'linux'}, async t => {
  const f = await fixture(t, 'linux', false);
  f.addProcess({pid: toolPid, started: 'Fri Oct 23 11:50:00 2026', executable: '/opt/ai-tools/node'});
  const launcher = await f.load<Runtime>(f.bundledRoot, 'runtime');
  let entered = 0;
  for (let launch = 0; launch < 2; launch++) await launcher.launchCli(['status'], async () => {entered++;}, {
    home: f.home, platform: 'linux', env: {}, runtime: f.runtime, prepareLocks: f.upgrade.prepareLockUpgrade,
  });
  assert.equal(entered, 2, 'fresh and matching Linux launches both reach their command');
  const state = JSON.parse(await readFile(join(f.bundledRoot, '.write-lock-upgrade/state.json'), 'utf8'));
  assert.equal(state.protocol, 3); assert.equal(state.retirement, undefined); assert.equal(state.patching, undefined);
  assert.equal(state.revision, 3); assert.equal(state.recovery, undefined);
  assert.deepEqual(state.storage, [{data: f.paths.data, ...await expectedLinuxStorage(f.paths)}]);
  await f.guarded.withWriteLock(f.paths, async () => {
    const updates = join(f.paths.data, 'updates');
    await f.guarded.withWriteLock({...f.paths, data: updates, lock: join(updates, '.lock')}, async () => {});
  });
  assert.equal((await lstat(f.paths.lock + '.guard')).nlink, 1);
  assert.deepEqual(f.commands, [], 'first installation performs no service restart or retirement command');
  assert.deepEqual(f.linuxCalls, [], 'fresh and matching launches require no Linux retirement or recovery inspection');
});

test('Linux retained paths without candidate metadata admit only their already recorded concrete layout', {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux', false);
  await f.prepare();
  const statePath = join(f.bundledRoot, '.write-lock-upgrade/state.json');
  const registered = await readFile(statePath, 'utf8');
  const retained = {...f.paths, linuxStorage: undefined};
  await f.guarded.withWriteLock(retained, async () => {});
  for (const changed of [{...retained, config: join(f.home, 'unregistered-config')},
    {...retained, stateDir: join(f.home, 'unregistered-state'), state: join(f.home, 'unregistered-state/state.json')},
    {...retained, runtime: join(f.home, 'unregistered-runtime')},
    {...retained, serviceUnit: join(f.home, 'unregistered-unit/app.maddots.ai.helper.service')},
    {...retained, data: join(f.home, 'unregistered-data'), logs: join(f.home, 'unregistered-data/logs'),
      lock: join(f.home, 'unregistered-data/.lock')}]) {
    await assert.rejects(f.guarded.withWriteLock(changed, async () => assert.fail('legacy callers cannot register a changed layout')), linuxRefusal);
  }
  assert.equal(await readFile(statePath, 'utf8'), registered, 'legacy compatibility cannot extend or replace the registry');
});

test("Linux fresh installation records released defaults and this revision's private roots with every XDG override", {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux', false);
  const env = {MADDOTS_AI_HOME: join(f.home, 'selected-data'), XDG_DATA_HOME: join(f.home, 'xdg-data'),
    XDG_CONFIG_HOME: join(f.home, 'xdg-config'), XDG_STATE_HOME: join(f.home, 'xdg-state'), XDG_RUNTIME_DIR: join(f.home, 'xdg-runtime')};
  const selected = await createPaths(readConfig(env, f.home, 'linux'));
  const roots = (await expectedLinuxStorage(selected, env)).roots.filter(root => root.startsWith(f.home + '/'));
  for (const root of roots.filter(root => !roots.some(parent => root.startsWith(parent + '/')))) {
    await ensurePrivateDirectory(root);
  }
  await f.upgrade.prepareLockUpgrade(f.runtime, selected);
  const state = JSON.parse(await readFile(join(f.bundledRoot, '.write-lock-upgrade/state.json'), 'utf8'));
  assert.deepEqual(state.storage, [{data: selected.data, ...await expectedLinuxStorage(selected, env)}]);
  assert.equal(state.patching, undefined); assert.equal(state.retirement, undefined); assert.equal(state.recovery, undefined);
  assert.deepEqual(f.commands, []); assert.deepEqual(f.linuxCalls, []);
});

test('Linux absent coordinator preserves released marketplace evidence and an A-root publication across all overrides to B and C', {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux');
  const layout = (name: string) => ({MADDOTS_AI_HOME: join(f.home, name, 'selected-data'),
    XDG_DATA_HOME: join(f.home, name, 'xdg-data'), XDG_CONFIG_HOME: join(f.home, name, 'xdg-config'),
    XDG_STATE_HOME: join(f.home, name, 'xdg-state'), XDG_RUNTIME_DIR: join(f.home, name, 'xdg-runtime')});
  const old = await createPaths(readConfig(layout('A'), f.home, 'linux'));
  await ensurePaths(old);
  await writeFile(old.lock, String(crashedPid), {mode: 0o600});
  const temporary = join(old.stateDir!, '.state.json.11111111-1111-4111-8111-111111111111.tmp');
  const bytes = '{"retained":"unattributed-synced-before-rename"}\n';
  const file = await filesystem.open(temporary, 'wx', 0o600);
  try {await file.writeFile(bytes); await file.sync();} finally {await file.close();}
  // directory()/root() and this route are identical in published 0.1.5
  // (ef85906359fd9e9d71634477a6c531666670289b) and the reviewed origin/main
  // (b2f65cbb66510aad074332b3108a24f5af772f1a). Ordinary 0.1.5 Linux sync can
  // create the marketplace without registered plugins or a coordinator.
  const marketplaceSource = `
    import {mkdir} from 'node:fs/promises';
    import {join, resolve} from 'node:path';
    import {assertNoSymlinks, readPrivateFile} from ${JSON.stringify(pathToFileURL(join(helper, 'paths.ts')).href)};
    import {assertRouteRoot} from ${JSON.stringify(pathToFileURL(join(helper, 'safe-fs.ts')).href)};
    export class ReleasedMarketplace {
      constructor(paths) {this.paths = paths; this.route = 'claude-plugin';
        this.matrix = {routes: {'claude-plugin': {path: '~/.maddots-ai/claude-code'}}};}
      directory() {return resolve(this.paths.home, this.matrix.routes[this.route].path.slice(2));}
      async root() {
        const root = this.directory();
        await assertNoSymlinks(root, this.paths.home);
        await mkdir(root, {recursive: true, mode: 0o700});
        await assertRouteRoot(this.paths, root);
        await this.state().catch(() => { this.stateUnreadable = true; });
        return root;
      }
      // Only the historical absent-registration branch is needed here. Keep
      // its real private-file read; no writer or coordinator is substituted.
      async state() {try {return JSON.parse(await readPrivateFile(join(this.paths.data, 'claude-plugin-registration.json')));}
        catch (error) {if (error.code === 'ENOENT') return {format: 1, marketplaceAdded: false, plugins: []}; throw error;}}
    }
  `;
  await writeFile(join(f.bundledRoot, 'dist/released-marketplace.js'), marketplaceSource, {mode: 0o600});
  const historical = await f.load<{ReleasedMarketplace: new(paths: HelperPaths) => {root(): Promise<string>}}>(f.bundledRoot, 'released-marketplace');
  const marketplace = await new historical.ReleasedMarketplace(old).root();
  assert.equal(marketplace, join(f.home, '.maddots-ai/claude-code'));
  assert.deepEqual(await filesystem.readdir(marketplace), [], 'even an empty marketplace is evidence of old helper activity');
  // npm can replace all installed module bytes without ever having called the
  // fixed coordinator. This record is naturally absent, never deleted.
  await f.install(f.bundledRoot, false, '0.1.6');
  const changed = await Promise.all(['B', 'C'].map(name => createPaths(readConfig(layout(name), f.home, 'linux'))));
  for (const paths of changed) for (const key of ['data', 'config', 'stateDir', 'runtime'] as const) assert.notEqual(paths[key], old[key]);
  const directory = join(f.bundledRoot, '.write-lock-upgrade');
  await assert.rejects(lstat(directory), {code: 'ENOENT'});
  const before = await snapshotTree(f.home);
  f.setRecoveryEntrypoints(true);
  for (const boot of [bootA, bootB]) {
    f.setBoot(boot);
    for (const paths of changed) {
      await assert.rejects(f.upgrade.prepareLockUpgrade(f.runtime, paths), linuxSourceRefusal);
      for (const phase of ['seal', 'complete'] as const) {
        await assert.rejects(f.upgrade.recoverLinuxLockUpgrade(f.runtime, paths, phase), linuxSourceRefusal);
      }
      await assert.rejects(f.guarded.withWriteLock(paths, async () => assert.fail('an absent coordinator cannot admit a writer')),
        {code: 'HELPER_BUSY'});
    }
    await assert.rejects(lstat(directory), {code: 'ENOENT'}, 'refusal cannot create a coordinator record or guard');
    assert.deepEqual(await snapshotTree(f.home), before, 'pre-registration refusal preserves all installed and retained artifacts');
    assert.equal(await readFile(temporary, 'utf8'), bytes);
  }
  assert.deepEqual(f.commands, []); assert.deepEqual(f.linuxCalls, [], 'unknown historical storage refuses before retirement or proof inspection');
});

for (const evidence of ['empty logs child', 'empty cache descendants', 'empty run descendants', 'default data', 'default config',
  'default state', 'default runtime fallback', 'selected runtime fallback', 'selected XDG data', 'historic Darwin data',
  'empty released marketplace', 'released marketplace publication', 'selected service unit', 'default service unit',
  'historical Darwin plist', 'internal pre-release agent folder', 'nested dist temporary', 'nested dist coordinator sidecar'] as const) {
test(`Linux absent coordinator refuses retained ${evidence} hidden by current XDG selection`, {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux', false);
  const env = {MADDOTS_AI_HOME: join(f.home, 'selected-data'), XDG_DATA_HOME: join(f.home, 'xdg-data'),
    XDG_CONFIG_HOME: join(f.home, 'xdg-config'), XDG_STATE_HOME: join(f.home, 'xdg-state'), XDG_RUNTIME_DIR: join(f.home, 'xdg-runtime')};
  const selected = await createPaths(readConfig(env, f.home, 'linux'));
  const retained = {
    'empty logs child': join(selected.data, 'logs'),
    'empty cache descendants': join(selected.data, 'cache/builds'),
    'empty run descendants': join(selected.data, 'run-homes/retained-run'),
    'default data': join(f.home, '.local/share/maddots-ai/.retained.tmp'),
    'default config': join(f.home, '.config/maddots-ai/.retained.tmp'),
    'default state': join(f.home, '.local/state/maddots-ai/.retained.tmp'),
    'default runtime fallback': join(f.home, '.local/state/maddots-ai/runtime/.retained.tmp'),
    'selected runtime fallback': join(env.XDG_STATE_HOME, 'maddots-ai/runtime/.retained.tmp'),
    'selected XDG data': join(env.XDG_DATA_HOME, 'maddots-ai/.retained.tmp'),
    'historic Darwin data': join(f.home, 'Library/Application Support/maddots-ai/.retained.tmp'),
    'empty released marketplace': join(f.home, '.maddots-ai/claude-code'),
    'released marketplace publication': join(f.home, '.maddots-ai/claude-code/.claude-plugin/.marketplace.json.retained.tmp'),
    'selected service unit': join(env.XDG_CONFIG_HOME, 'systemd/user/app.maddots.ai.helper.service'),
    'default service unit': join(f.home, '.config/systemd/user/app.maddots.ai.helper.service'),
    'historical Darwin plist': join(f.home, 'Library/LaunchAgents/app.maddots.ai.helper.plist'),
    'internal pre-release agent folder': join(f.home, 'MadDots Agents/retained-agent'),
    'nested dist temporary': join(f.bundledRoot, 'dist/helper/.retained.tmp'),
    'nested dist coordinator sidecar': join(f.bundledRoot, 'dist/helper/.write-lock-upgrade.json'),
  }[evidence];
  if (evidence.startsWith('empty ')) await ensurePrivateDirectory(retained);
  else {await ensurePrivateDirectory(dirname(retained)); await writeFile(retained, 'retained-private-publication\n', {mode: 0o600});}
  const before = await snapshotTree(f.home);
  await assert.rejects(f.upgrade.prepareLockUpgrade(f.runtime, selected), linuxSourceRefusal);
  await assert.rejects(lstat(join(f.bundledRoot, '.write-lock-upgrade')), {code: 'ENOENT'});
  assert.deepEqual(await snapshotTree(f.home), before, 'retained evidence cannot be registered, copied, repaired or removed');
  assert.deepEqual(f.commands, []); assert.deepEqual(f.linuxCalls, []);
});
}

for (const evidence of ['same-account service runs', 'same-account service marketplace', 'current-account runtime', 'different-account service runs'] as const) {
test(`Linux absent coordinator ${evidence === 'different-account service runs' ? 'skips' : 'refuses'} retained ${evidence} by metadata and names alone`, {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux', false);
  const runtime = evidence === 'current-account runtime';
  const prefix = runtime ? `/run/user/${process.getuid!()}/mdai` : '/var/lib/mdai';
  const mapped = join(f.home, 'fixed-root-fixture');
  const retained = join(mapped, runtime ? '.retained.tmp' : evidence === 'same-account service marketplace' ?
    'home/.maddots-ai/claude-code/.retained.tmp' : 'runs/.retained.tmp');
  await ensurePrivateDirectory(dirname(retained));
  await writeFile(retained, 'retained-publication\n', {mode: 0o600});
  const before = await snapshotTree(f.home);
  const originalLstat = filesystem.lstat, originalOpendir = filesystem.opendir;
  const remap = (path: unknown) => {
    const name = String(path);
    return name === prefix || name.startsWith(prefix + '/') ? mapped + name.slice(prefix.length) : path;
  };
  let tokenOpens = 0;
  f.hooks.beforeOpen = async path => {
    if (path === prefix || path.startsWith(prefix + '/') || path === mapped || path.startsWith(mapped + '/')) {
      tokenOpens++; assert.fail('first-registration freshness must use metadata and names without opening retained contents');
    }
  };
  filesystem.lstat = (async (...args: Parameters<typeof originalLstat>) => {
    const info = await originalLstat(remap(args[0]) as string, args[1]);
    if (evidence === 'different-account service runs' && String(args[0]) === prefix) {
      return Object.assign(Object.create(Object.getPrototypeOf(info)), info,
        {uid: typeof info.uid === 'bigint' ? BigInt(process.getuid!() + 1) : process.getuid!() + 1});
    }
    return info;
  }) as typeof originalLstat;
  filesystem.opendir = ((...args: Parameters<typeof originalOpendir>) => originalOpendir(remap(args[0]) as string, args[1])) as typeof originalOpendir;
  syncBuiltinESMExports();
  try {
    if (evidence === 'different-account service runs') {
      await f.prepare();
      const state = JSON.parse(await readFile(join(f.bundledRoot, '.write-lock-upgrade/state.json'), 'utf8'));
      assert.equal(state.storage[0].roots.some((root: string) => root.startsWith('/var/lib/mdai/')), false,
        'another account owns its fixed service storage');
    } else {
      await assert.rejects(f.prepare(), linuxSourceRefusal);
      await assert.rejects(lstat(join(f.bundledRoot, '.write-lock-upgrade')), {code: 'ENOENT'});
      assert.deepEqual(await snapshotTree(f.home), before, 'virtual fixed-root evidence refuses before coordinator or artifact mutation');
    }
    assert.equal(tokenOpens, 0);
    assert.equal(await readFile(retained, 'utf8'), 'retained-publication\n');
    assert.deepEqual(f.commands, []); assert.deepEqual(f.linuxCalls, []);
  } finally {
    filesystem.lstat = originalLstat; filesystem.opendir = originalOpendir; syncBuiltinESMExports();
  }
});
}

for (const previous of ['protocol-2', 'protocol-3'] as const) {
test(`Linux refuses ${previous} without this revision's provenance even with synthetic storage coverage`, {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux', previous);
  const statePath = join(f.bundledRoot, '.write-lock-upgrade/state.json');
  const retained = JSON.parse(await readFile(statePath, 'utf8'));
  retained.storage = [{data: f.paths.data, ...await expectedLinuxStorage(f.paths)}];
  await writeFile(statePath, JSON.stringify(retained) + '\n', {mode: 0o600});
  const before = await snapshotTree(f.home);
  f.setRecoveryEntrypoints(true);
  for (const boot of [bootA, bootB]) {
    f.setBoot(boot);
    await assert.rejects(f.prepare(), linuxSourceRefusal);
    for (const phase of ['seal', 'complete'] as const) await assert.rejects(f.recover(phase), linuxSourceRefusal);
    assert.deepEqual(await snapshotTree(f.home), before, 'unsupported source refusal preserves every byte and inode');
  }
  assert.deepEqual(f.commands, []); assert.deepEqual(f.linuxCalls, []);
});
}

for (const step of [...migrationOrder, 'completion']) {
test(`actual protocol-2 migration interrupted before ${step} remains importable and resumes every module`, {timeout: 20_000}, async t => {
  const f = await fixture(t, 'darwin', 'protocol-2'), verifyData = await f.preserveData();
  const statePath = join(f.bundledRoot, '.write-lock-upgrade/state.json');
  const published: string[] = [], failure = errno('EIO'); let failed = false;
  f.hooks.beforeRename = async to => {
    const name = migrationOrder.find(name => to === join(f.bundledRoot, 'dist', name + '.js'));
    if (!failed && ((name === step) || (step === 'completion' && to === statePath && published.length === migrationOrder.length))) {
      failed = true; throw failure;
    }
    if (name) published.push(name);
  };
  await assert.rejects(f.prepare(), error => error === failure);
  assert.equal(failed, true);
  assert.deepEqual(published, step === 'completion' ? [...migrationOrder] : migrationOrder.slice(0, migrationOrder.indexOf(step as typeof migrationOrder[number])));
  const interrupted = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(interrupted.protocol, 3);
  assert.equal(interrupted.patching, true, 'completion is durable only after every module has been published and verified');
  assert.equal(interrupted.retirement, undefined);
  // A fresh bootstrap import must work at every intermediate publication,
  // including when its lock is still protocol 2 and linux-proc did not exist.
  const cli = await f.load<Cli>(f.bundledRoot, 'cli');
  assert.equal(typeof cli.runCli, 'function');
  await assert.rejects(f.prepare(), {code: 'HELPER_BUSY'});
  assert.deepEqual(published, [...migrationOrder], 'resume repairs every unfinished module in dependency order');
  for (const name of migrationOrder) {
    assert.deepEqual(await readFile(join(f.bundledRoot, 'dist', name + '.js')),
      await readFile(join(f.modernRoot, 'dist', name + '.js')), name);
  }
  await assert.rejects(f.guarded.withWriteLock(f.paths, async () => assert.fail('loaded old writers must retire after the repair')), {code: 'HELPER_BUSY'});
  await f.nextProcess();
  await f.guarded.withWriteLock(f.paths, async () => {});
  assert.equal(f.guards.size, 0); await verifyData();
});
}

for (const name of migrationOrder) {
for (const missing of [false, true]) {
test(`protocol-3 marker repairs ${missing ? 'missing' : 'old'} ${name} before admitting a writer`, {timeout: 20_000}, async t => {
  const f = await fixture(t, 'darwin', 'protocol-2');
  await assert.rejects(f.prepare(), {code: 'HELPER_BUSY'});
  await f.nextProcess();
  const path = join(f.bundledRoot, 'dist', name + '.js');
  if (missing) await rm(path);
  else {
    // Recreate the prior faulty publication order: the completion marker is
    // already protocol 3, but a dependency still has its actual protocol-2 bytes.
    const text = !(name in protocolTwo.modules) ? '// partial protocol-3 extraction\n' :
      transpileModule(protocolTwo.modules[name], {fileName: name + '.ts', compilerOptions: {target: ScriptTarget.ES2022, module: ModuleKind.ESNext}}).outputText;
    await writeFile(path, text, {mode: 0o600});
  }
  if (name !== 'write-lock') assert.match(await readFile(join(f.bundledRoot, 'dist/write-lock.js'), 'utf8'), /^\/\/ maddots-write-lock-protocol: 3/);
  // Exercise a guarded caller directly too: it must verify the installation,
  // rather than trusting a completed state record or the write-lock marker.
  await assert.rejects(f.guarded.withWriteLock(f.paths, async () => assert.fail('a repair starts a new retirement barrier')), {code: 'HELPER_BUSY'});
  for (const module of migrationOrder) {
    assert.deepEqual(await readFile(join(f.bundledRoot, 'dist', module + '.js')),
      await readFile(join(f.modernRoot, 'dist', module + '.js')), module);
  }
  await f.nextProcess();
  await f.guarded.withWriteLock(f.paths, async () => {});
  assert.equal(f.guards.size, 0);
});
}
}

for (const step of [...migrationOrder, 'snapshot']) {
test(`pre-fix protocol-3 retained sources interrupted before ${step} adopt the repaired coordinator`, {timeout: 20_000}, async t => {
  const f = await fixture(t, 'darwin', 'protocol-3');
  const directory = join(f.bundledRoot, '.write-lock-upgrade'), statePath = join(directory, 'state.json');
  const cached = join(f.paths.data, 'updates/releases', commitA);
  await f.install(cached, false, '0.1.6');
  // Reproduce the old interrupted order with real protocol-3 bytes: its lock
  // marker was published while linux-proc was still absent in the bootstrap.
  await rm(join(f.bundledRoot, 'dist/linux-proc.js'));
  const fixed = await readFile(join(cached, 'dist/write-lock-upgrade.js'));
  // A direct writer must not restore old retained coordinator bytes over a
  // selected fixed runtime before prepareLockUpgrade adopts the new snapshot.
  await assert.rejects(f.guarded.withWriteLock(f.paths, async () => assert.fail('pre-fix sources require preparation')), {code: 'HELPER_BUSY'});
  assert.deepEqual(await readFile(join(cached, 'dist/write-lock-upgrade.js')), fixed);
  const failure = errno('EIO'); let failed = false;
  f.hooks.beforeRename = async to => {
    if (!failed && to === (step === 'snapshot' ? statePath : join(directory, step + '.js'))) {
      failed = true; throw failure;
    }
  };
  await assert.rejects(f.prepare(), error => error === failure);
  assert.equal(failed, true);
  const interrupted = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(interrupted.protocol, 3); assert.equal(interrupted.revision, undefined);
  await assert.rejects(f.guarded.withWriteLock(f.paths, async () => assert.fail('an incomplete source snapshot cannot authorize a writer')), {code: 'HELPER_BUSY'});
  await assert.rejects(f.prepare(), {code: 'HELPER_BUSY'});
  const resumed = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(resumed.protocol, 3); assert.equal(resumed.revision, 1);
  for (const name of migrationOrder) {
    const expected = await readFile(join(f.modernRoot, 'dist', name + '.js'));
    assert.deepEqual(await readFile(join(directory, name + '.js')), expected, `retained ${name}`);
    assert.deepEqual(await readFile(join(f.bundledRoot, 'dist', name + '.js')), expected, `bootstrap ${name}`);
    assert.deepEqual(await readFile(join(cached, 'dist', name + '.js')), expected, `selected ${name}`);
  }
  const cli = await f.load<Cli>(f.bundledRoot, 'cli'); assert.equal(typeof cli.runCli, 'function');
  await f.nextProcess();
  await f.guarded.withWriteLock(f.paths, async () => {});
  assert.equal(f.guards.size, 0);
});
}

test('an older coordinator preserves a newer retained source revision', {timeout: 20_000}, async t => {
  const f = await fixture(t, 'darwin', 'protocol-2');
  await assert.rejects(f.prepare(), {code: 'HELPER_BUSY'}); await f.nextProcess();
  const directory = join(f.bundledRoot, '.write-lock-upgrade'), statePath = join(directory, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const text = await readFile(join(directory, 'write-lock-upgrade.js'), 'utf8') + '\n// newer retained coordinator revision\n';
  state.revision = 2; state.sources['write-lock-upgrade.js'] = createHash('sha256').update(text).digest('hex');
  await writeFile(join(directory, 'write-lock-upgrade.js'), text, {mode: 0o600});
  await writeFile(statePath, JSON.stringify(state) + '\n', {mode: 0o600});
  await assert.rejects(f.prepare(), {code: 'HELPER_BUSY'}); await f.nextProcess();
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).revision, 2);
  assert.equal(await readFile(join(f.bundledRoot, 'dist/write-lock-upgrade.js'), 'utf8'), text);
  await f.guarded.withWriteLock(f.paths, async () => {});
  assert.equal(f.guards.size, 0);
});

test('adopting fixed retained sources preserves an existing live retirement cohort', {timeout: 20_000}, async t => {
  const f = await fixture(t, 'darwin', 'protocol-3');
  const statePath = join(f.bundledRoot, '.write-lock-upgrade/state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8')), started = 'Fri Oct 23 11:30:00 2026';
  state.retirement = {boot: bootA, processes: [{pid: cliPid, started, executable: process.execPath}]};
  await writeFile(statePath, JSON.stringify(state) + '\n', {mode: 0o600});
  f.addProcess({pid: cliPid, started, executable: '/bin/sh'});
  await assert.rejects(f.prepare(), {code: 'HELPER_BUSY'});
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  assert.deepEqual(saved.retirement.processes.find((row: {pid: number}) => row.pid === cliPid), state.retirement.processes[0]);
  f.nextIdentity(process.pid);
  await assert.rejects(f.prepare(), {code: 'HELPER_BUSY'}, 'a fresh capture cannot remove a still-live saved identity');
  f.retireProcess(cliPid); await f.prepare();
  await f.guarded.withWriteLock(f.paths, async () => {});
  assert.equal(f.guards.size, 0);
});

test('Linux npm replacement with existing state cannot create its missing storage history', {timeout: 20_000, skip: process.platform !== 'linux'}, async t => {
  const f = await fixture(t, 'linux', false);
  await mkdir(dirname(f.paths.state), {recursive: true, mode: 0o700});
  await writeFile(f.paths.state, '{}', {mode: 0o600});
  const before = await snapshotTree(f.home);
  await assert.rejects(f.prepare(), linuxSourceRefusal);
  f.nextIdentity(process.pid);
  await assert.rejects(f.prepare(), linuxSourceRefusal);
  await assert.rejects(lstat(join(f.bundledRoot, '.write-lock-upgrade')), {code: 'ENOENT'});
  assert.deepEqual(await snapshotTree(f.home), before);
});

for (const oldRevision of [1, 2, 3]) {
test(`Linux refuses internal revision ${oldRevision} without current source-policy provenance before any repair`, {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux', false);
  await f.prepare();
  const directory = join(f.bundledRoot, '.write-lock-upgrade'), statePath = join(directory, 'state.json');
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  saved.revision = oldRevision;
  delete saved.linuxSourcePolicy;
  await writeFile(statePath, JSON.stringify(saved) + '\n', {mode: 0o600});
  const before = await snapshotTree(f.home);
  await assert.rejects(f.guarded.withWriteLock(f.paths, async () => assert.fail('old internal record cannot enter')), linuxSourceRefusal);
  await assert.rejects(f.prepare(), linuxSourceRefusal);
  for (const phase of ['seal', 'complete'] as const) await assert.rejects(f.recover(phase), linuxSourceRefusal);
  assert.deepEqual(await snapshotTree(f.home), before);
});
}

for (const trigger of ['retained-state reinstall', 'module repair'] as const) {
test(`Linux ${trigger} retains its original recovery baseline through retries and reinstall`, {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux', false);
  const statePath = join(f.bundledRoot, '.write-lock-upgrade/state.json');
  await f.prepare();
  if (trigger === 'retained-state reinstall') {
    await mkdir(dirname(f.paths.state), {recursive: true, mode: 0o700});
    await writeFile(f.paths.state, '{"saved":"before replacement"}\n', {mode: 0o600});
    await f.install(f.bundledRoot, false, '0.1.5');
    await rm(join(f.bundledRoot, 'dist/write-lock-recovery.js'));
  } else {
    await rm(join(f.bundledRoot, 'dist/write-lock-recovery.js'));
  }
  const original = await readFile(join(f.bundledRoot, 'dist/paths.js'));
  f.addProcess({pid: toolPid, started: 'Fri Oct 23 11:50:00 2026', executable: '/opt/private-host/node', unreadableExe: true});
  await assert.rejects(f.prepare(), linuxRefusal);
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(saved.revision, 3); assert.equal(saved.patching, true); assert.equal(saved.retirement, undefined);
  assert.equal(saved.recovery.schemaVersion, 1); assert.equal(saved.recovery.revision, 3);
  assert.equal(saved.recovery.baselineBoot, bootA); assert.deepEqual(saved.recovery.windows, [bootA]);
  assert.equal(saved.recovery.initial.installation, f.bundledRoot);
  assert.deepEqual(saved.recovery.initial.data, [f.paths.data]);
  assert.deepEqual(saved.recovery.initial.roots, [{root: f.bundledRoot, unpublished: false}]);
  assert.deepEqual(saved.recovery.initial.artifacts.find((row: {path: string}) => row.path === join(f.bundledRoot, 'dist/paths.js')),
    {path: join(f.bundledRoot, 'dist/paths.js'), sha256: createHash('sha256').update(original).digest('hex')});
  assert.equal(saved.recovery.seal, undefined); assert.equal(saved.recovery.completion, undefined);
  for (const retry of ['same process', 'new process', 'reinstall']) {
    if (retry === 'new process') f.nextIdentity(process.pid);
    if (retry === 'reinstall') await f.install(f.bundledRoot, false, '0.1.5');
    await assert.rejects(f.prepare(), linuxRefusal);
    await assert.rejects(f.guarded.withWriteLock(f.paths, async () => assert.fail('uncertain old hosts cannot admit new writers')), linuxRefusal);
    const retained = JSON.parse(await readFile(statePath, 'utf8'));
    assert.deepEqual(retained.recovery, saved.recovery, `${retry} must preserve the original boot and artifact evidence`);
    assert.equal(retained.patching, true);
  }
  assert.deepEqual(f.commands, [], 'retirement and reinstall never control Linux service entrypoints');
});
}

test('Linux persists the installation and actual boot before an interrupted module repair', {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux');
  await f.registerFreshLayout();
  const verifyData = await f.preserveData();
  const statePath = join(f.bundledRoot, '.write-lock-upgrade/state.json');
  const oldPaths = await readFile(join(f.bundledRoot, 'dist/paths.js'));
  const failure = errno('EIO'); let failed = false;
  f.hooks.beforeRename = async to => {
    if (!failed && to === join(f.bundledRoot, 'dist/linux-proc.js')) {
      failed = true;
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      assert.equal(state.patching, true); assert.equal(state.retirement, undefined);
      assert.equal(state.recovery.baselineBoot, bootA);
      assert.equal(state.recovery.initial.installation, f.bundledRoot);
      assert.deepEqual(state.recovery.initial.data, [f.paths.data]);
      assert.deepEqual(state.recovery.initial.artifacts.find((row: {path: string}) => row.path === join(f.bundledRoot, 'dist/paths.js')),
        {path: join(f.bundledRoot, 'dist/paths.js'), sha256: createHash('sha256').update(oldPaths).digest('hex')});
      throw failure;
    }
  };
  await assert.rejects(f.prepare(), error => error === failure);
  assert.equal(failed, true);
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(saved.patching, true); assert.equal(saved.recovery.seal, undefined);
  assert.deepEqual(await readFile(join(f.bundledRoot, 'dist/paths.js')), oldPaths);
  f.addProcess({pid: toolPid, started: 'Fri Oct 23 11:50:00 2026', executable: '/opt/private-host/node', unreadableExe: true});
  await assert.rejects(f.prepare(), linuxRefusal);
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')).recovery, saved.recovery);
  await assert.rejects(f.guarded.withWriteLock(f.paths, async () => assert.fail('failed repair preserves closed admission')), linuxRefusal);
  await verifyData();
});

test('Linux CLI presents the exact retained-state recovery instruction before any command runs', {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux');
  const cli = await f.load<Cli>(f.modernRoot, 'cli');
  const output: string[] = [];
  f.addProcess({pid: toolPid, started: 'Fri Oct 23 11:50:00 2026', executable: '/opt/private-host/node', unreadableExe: true});
  await assert.rejects(cli.runCli(['status'], {home: f.home, env: {}, runtime: f.runtime,
    prepareLocks: f.upgrade.prepareLockUpgrade, output: line => output.push(line),
    runner: async () => assert.fail('refusal precedes service or credential commands'),
    request: async () => assert.fail('refusal precedes service requests'),
  }), linuxRefusal);
  assert.deepEqual(output, [linuxRefusal.message]);
  assert.deepEqual(f.commands, []);
});

test('Linux CLI seal and complete accept the fixed null mask while rejecting other linked paths', {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux');
  f.addProcess({pid: toolPid, started: 'Fri Oct 23 11:50:00 2026', executable: '/opt/private-host/node', unreadableExe: true});
  await assert.rejects(f.prepare(), linuxRefusal);
  f.setRecoveryEntrypoints(true);
  const cli = await f.load<Cli>(f.modernRoot, 'cli'), output: string[] = [];
  const options: CliOptions = {home: f.home, env: {}, runtime: f.runtime, platform: 'linux', output: line => output.push(line),
    prepareLocks: async () => assert.fail('recovery must dispatch before ordinary writer preparation'),
    runner: async () => assert.fail('recovery cannot issue ordinary CLI service or credential commands'),
    request: async () => assert.fail('recovery cannot make network requests')};
  const unit = f.paths.serviceUnit!, parent = dirname(unit);
  await mkdir(parent, {recursive: true, mode: 0o700});
  for (const target of ['/dev/zero', '/dev/../dev/null']) {
    await symlink(target, unit);
    for (const phase of ['seal', 'complete']) await assert.rejects(cli.runCli(['recovery', phase], options), {code: 'PATH_UNSAFE'});
    await rm(unit);
  }
  await rmdir(parent);
  const linkedParent = join(f.home, 'linked-units'); await mkdir(linkedParent);
  await symlink('/dev/null', join(linkedParent, 'app.maddots.ai.helper.service')); await symlink(linkedParent, parent);
  await assert.rejects(cli.runCli(['recovery', 'seal'], options), {code: 'PATH_UNSAFE'});
  await rm(parent); await mkdir(parent); await symlink('/dev/null', unit);
  await assert.rejects(cli.runCli(['status'], options), {code: 'PATH_UNSAFE'}, 'ordinary dispatch keeps rejecting the mask');
  await cli.runCli(['recovery', 'seal'], options);
  const statePath = join(f.bundledRoot, '.write-lock-upgrade/state.json');
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).recovery.seal.boot, bootA);
  f.setBoot(bootB);
  await cli.runCli(['recovery', 'complete'], options);
  const completed = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(completed.recovery.completion.boot, bootB);
  assert.equal(completed.patching, undefined); assert.equal(completed.retirement, undefined);
  assert.equal(output.length, 2); assert.match(output[0], /recovery seal saved/); assert.match(output[1], /recovery committed/);
  assert.ok(f.commands.every(command => command.file === '/usr/bin/systemctl' && command.args.includes('show')));
});

for (const interruption of ['directory sync failure', 'boot change', 'artifact change'] as const) {
test(`Linux seal candidate ${interruption} cannot publish completed proof or admit a writer`, {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux');
  const statePath = join(f.bundledRoot, '.write-lock-upgrade/state.json');
  f.addProcess({pid: toolPid, started: 'Fri Oct 23 11:50:00 2026', executable: '/opt/private-host/node', unreadableExe: true});
  await assert.rejects(f.prepare(), linuxRefusal);
  const original = JSON.parse(await readFile(statePath, 'utf8')).recovery;
  f.setRecoveryEntrypoints(true);
  const failure = errno('EIO'); let interrupted = false;
  f.hooks.beforeSync = async path => {
    if (path !== dirname(statePath) || interrupted) return;
    const saved = JSON.parse(await readFile(statePath, 'utf8'));
    if (!saved.recovery.sealing) return;
    interrupted = true;
    assert.equal(saved.recovery.sealing.boot, bootA);
    assert.equal(saved.recovery.seal, undefined, 'the candidate must be synced before completed seal publication');
    assert.deepEqual(saved.recovery.initial, original.initial);
    if (interruption === 'directory sync failure') throw failure;
    if (interruption === 'boot change') f.setBoot(bootB);
    if (interruption === 'artifact change') await writeFile(join(f.bundledRoot, 'package.json'),
      JSON.stringify(candidate('0.1.7')), {mode: 0o600});
  };
  if (interruption === 'directory sync failure') await assert.rejects(f.recover('seal'), error => error === failure);
  else await assert.rejects(f.recover('seal'), linuxRefusal);
  assert.equal(interrupted, true, 'sealing persists a candidate before its final boot and inventory checks');
  const retained = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(retained.patching, true); assert.equal(retained.recovery.seal, undefined);
  assert.equal(retained.recovery.completion, undefined);
  assert.equal(retained.recovery.id, original.id); assert.equal(retained.recovery.baselineBoot, bootA);
  assert.deepEqual(retained.recovery.initial, original.initial);
  let entered = 0;
  await assert.rejects(f.recover('complete'), linuxRefusal);
  await assert.rejects(f.guarded.withWriteLock(f.paths, async () => {entered++;}), linuxRefusal);
  assert.equal(entered, 0);
});
}

for (const obligation of ['runner record', 'temporary publication'] as const) {
test(`Linux cohort completion preserves a retained ${obligation} and closes writer admission`, {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux', false);
  const statePath = join(f.bundledRoot, '.write-lock-upgrade/state.json');
  await f.prepare(); await rm(join(f.bundledRoot, 'dist/write-lock-recovery.js'));
  await mkdir(dirname(f.paths.state), {recursive: true, mode: 0o700});
  await writeFile(f.paths.state, '{}\n', {mode: 0o600});
  await ensurePrivateDirectory(join(f.paths.data, 'updates'));
  const retainedPath = obligation === 'runner record' ? join(f.paths.data, 'runner/unresolved.json') : join(f.paths.data, 'publication.tmp');
  await ensurePrivateDirectory(dirname(retainedPath));
  const retainedBytes = '{"state":"uncertain"}\n';
  await writeFile(retainedPath, retainedBytes, {mode: 0o600});
  await assert.rejects(f.prepare(), linuxRefusal);
  const initial = JSON.parse(await readFile(statePath, 'utf8'));
  assert.ok(initial.retirement.processes.some((row: {pid: number}) => row.pid === process.pid));
  f.nextIdentity(process.pid);
  const locks = await f.load<Locks>(f.modernRoot, 'write-lock');
  const release = await locks.acquireWriteGuard(join(f.paths.data, 'updates/.lock.guard'), clock, clock.now() + 10_000);
  try {
    let now = 0;
    await assert.rejects(f.upgrade.prepareLockUpgrade(f.runtime, f.paths, {now: () => now, sleep: async () => {now += 10_001;}}),
      {code: 'HELPER_BUSY'}, 'all application/update ownership is acquired before retained obligations are reconciled');
  } finally {await release();}
  await assert.rejects(f.prepare(), linuxRefusal);
  let entered = 0;
  await assert.rejects(f.guarded.withWriteLock(f.paths, async () => {entered++;}), linuxRefusal);
  assert.equal(entered, 0);
  const retained = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(retained.recovery.completion, undefined);
  assert.deepEqual(retained.recovery.initial, initial.recovery.initial);
  assert.deepEqual(retained.retirement, initial.retirement);
  assert.equal(await readFile(retainedPath, 'utf8'), retainedBytes);
  assert.deepEqual(f.commands, []);
});
}

test('Linux sealed recovery admits a writer only after a new boot, inactive entrypoints and exclusive application/update ownership', {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux');
  const statePath = join(f.bundledRoot, '.write-lock-upgrade/state.json');
  f.addProcess({pid: toolPid, started: 'Fri Oct 23 11:50:00 2026', executable: '/opt/private-host/node', unreadableExe: true});
  await assert.rejects(f.prepare(), linuxRefusal);
  const initial = JSON.parse(await readFile(statePath, 'utf8')).recovery;
  await assert.rejects(f.recover('complete'), linuxRefusal, 'a baseline alone cannot prove a completed seal');
  await assert.rejects(f.recover('seal'), linuxRefusal, 'loaded or enabled old entrypoints cannot be sealed');
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).recovery.seal, undefined);
  f.setRecoveryEntrypoints(true);
  await f.recover('seal');
  const sealed = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(sealed.patching, true); assert.equal(sealed.recovery.seal.boot, bootA);
  assert.deepEqual(sealed.recovery.initial, initial.initial);
  assert.equal(sealed.recovery.baselineBoot, initial.baselineBoot);
  assert.equal(sealed.recovery.id, initial.id);
  assert.equal(sealed.recovery.completion, undefined);
  assert.deepEqual(sealed.recovery.seal.masks, f.recoveryMasks(), 'the completed seal binds both persistent mask identities');
  for (const name of migrationOrder) {
    assert.deepEqual(sealed.recovery.seal.inventory.artifacts.find((row: {path: string}) => row.path === join(f.bundledRoot, 'dist', name + '.js')),
      {path: join(f.bundledRoot, 'dist', name + '.js'), sha256: createHash('sha256').update(await readFile(join(f.modernRoot, 'dist', name + '.js'))).digest('hex')});
  }
  f.nextIdentity(process.pid);
  await assert.rejects(f.recover('complete'), linuxRefusal, 'same-boot CLI or service restart supplies no recovery proof');
  await assert.rejects(f.prepare(), linuxRefusal);
  let entered = 0;
  await assert.rejects(f.guarded.withWriteLock(f.paths, async () => {entered++;}), linuxRefusal);
  assert.equal(entered, 0);

  f.setBoot(bootB);
  const masks = f.recoveryMasks();
  for (const [index, scope] of (['system', 'user'] as const).entries()) {
    f.setRecoveryMask(scope, {ctimeNs: '999', parentCtimeNs: '999'});
    await assert.rejects(f.recover('complete'), linuxRefusal, `${scope} mask replacement remains unverified even with zero systemd timestamps`);
    await assert.rejects(f.guarded.withWriteLock(f.paths, async () => {entered++;}), linuxRefusal);
    assert.equal(entered, 0);
    assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')).recovery.seal.masks, masks);
    f.setRecoveryMask(scope, masks[index]);
  }
  f.setRecoveryEntrypoints(true, true);
  await assert.rejects(f.recover('complete'), linuxRefusal, 'a postboot legacy activation remains uncertain even after it exits');
  f.setRecoveryEntrypoints(true);
  const locks = await f.load<Locks>(f.modernRoot, 'write-lock');
  await ensurePrivateDirectory(join(f.paths.data, 'updates'));
  for (const guard of [f.paths.lock + '.guard', join(f.paths.data, 'updates/.lock.guard')]) {
    const release = await locks.acquireWriteGuard(guard, clock, clock.now() + 10_000);
    try {
      let now = 0;
      await assert.rejects(f.recover('complete', {now: () => now, sleep: async () => {now += 10_001;}}), {code: 'HELPER_BUSY'},
        'completion requires exclusive ownership of every registered application and update lock');
      assert.equal(JSON.parse(await readFile(statePath, 'utf8')).recovery.completion, undefined);
      await assert.rejects(f.guarded.withWriteLock(f.paths, async () => {entered++;}), linuxRefusal);
    } finally { await release(); }
  }
  const obligations = join(f.paths.data, 'runner');
  await ensurePrivateDirectory(obligations);
  await writeFile(join(obligations, 'unresolved.json'), '{"state":"uncertain"}\n', {mode: 0o600});
  await assert.rejects(f.recover('complete'), linuxRefusal, 'a boot change cannot settle retained runner or external work');
  assert.equal(await readFile(join(obligations, 'unresolved.json'), 'utf8'), '{"state":"uncertain"}\n');
  await rm(obligations, {recursive: true});
  const failure = errno('EIO'); let failed = false;
  f.hooks.beforeRename = async to => {if (!failed && to === statePath) {failed = true; throw failure;}};
  await assert.rejects(f.recover('complete'), error => error === failure);
  assert.equal(failed, true);
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).recovery.completion, undefined);
  await assert.rejects(f.guarded.withWriteLock(f.paths, async () => {entered++;}), linuxRefusal);
  assert.equal(entered, 0, 'failed completion persistence cannot admit a writer');
  const syncFailure = errno('EIO'); let syncFailed = false;
  f.hooks.beforeSync = async path => {
    if (path === dirname(statePath) && JSON.parse(await readFile(statePath, 'utf8')).recovery.completion) {
      syncFailed = true; throw syncFailure;
    }
  };
  await assert.rejects(f.recover('complete'), error => error === syncFailure);
  assert.equal(syncFailed, true);
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).recovery.completion.method, 'reboot',
    'rename visibility alone does not prove directory sync completed');
  await assert.rejects(f.guarded.withWriteLock(f.paths, async () => {entered++;}), error => error === syncFailure);
  assert.equal(entered, 0, 'an unsynced visible completion cannot authorize a writer');
  f.hooks.beforeSync = undefined;
  await f.prepare();
  const completed = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(completed.patching, undefined); assert.equal(completed.retirement, undefined);
  assert.equal(completed.recovery.completion.method, 'reboot'); assert.equal(completed.recovery.completion.boot, bootB);
  assert.deepEqual(completed.recovery.initial, initial.initial);
  assert.deepEqual(completed.recovery.completion.inventory, sealed.recovery.seal.inventory);
  await f.guarded.withWriteLock(f.paths, async () => {entered++;});
  assert.equal(entered, 1);
  assert.ok(f.commands.every(command => command.file === '/usr/bin/systemctl' && command.args.includes('show')),
    'recovery observes service entrypoints without controlling them');
});

test('Linux a reboot during incomplete patching retains the original baseline and requires a later sealed boot', {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux');
  const statePath = join(f.bundledRoot, '.write-lock-upgrade/state.json');
  f.addProcess({pid: toolPid, started: 'Fri Oct 23 11:50:00 2026', executable: '/opt/private-host/node', unreadableExe: true});
  await assert.rejects(f.prepare(), linuxRefusal);
  const initial = JSON.parse(await readFile(statePath, 'utf8')).recovery;
  f.setBoot(bootB); f.setRecoveryEntrypoints(true);
  await assert.rejects(f.recover('complete'), linuxRefusal);
  await f.recover('seal');
  const sealed = JSON.parse(await readFile(statePath, 'utf8')).recovery;
  assert.equal(sealed.baselineBoot, bootA); assert.deepEqual(sealed.windows, [bootA, bootB]);
  assert.equal(sealed.seal.boot, bootB); assert.deepEqual(sealed.initial, initial.initial); assert.equal(sealed.id, initial.id);
  await assert.rejects(f.recover('complete'), linuxRefusal, 'an earlier pre-seal reboot cannot authorize recovery');
  await assert.rejects(f.guarded.withWriteLock(f.paths, async () => assert.fail('an incomplete patching reboot never admits work')), linuxRefusal);
});

test('Linux recovery rejects missing, mismatched and stale sealed proof without writer admission', {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux');
  const statePath = join(f.bundledRoot, '.write-lock-upgrade/state.json');
  f.addProcess({pid: toolPid, started: 'Fri Oct 23 11:50:00 2026', executable: '/opt/private-host/node', unreadableExe: true});
  await assert.rejects(f.prepare(), linuxRefusal);
  f.setRecoveryEntrypoints(true); await f.recover('seal');
  const original = await readFile(statePath, 'utf8');
  f.setBoot(bootB);
  for (const proof of ['missing recovery', 'other installation', 'wrong sealed boot', 'stale artifact inventory']) {
    const changed = JSON.parse(original);
    if (proof === 'missing recovery') delete changed.recovery;
    if (proof === 'other installation') changed.recovery.initial.installation = join(f.home, 'another-installation');
    if (proof === 'wrong sealed boot') changed.recovery.seal.boot = bootB;
    if (proof === 'stale artifact inventory') changed.recovery.seal.inventory.artifacts[0].sha256 = 'f'.repeat(64);
    await writeFile(statePath, JSON.stringify(changed) + '\n', {mode: 0o600});
    await assert.rejects(f.recover('complete'), linuxRefusal, proof);
    await assert.rejects(f.guarded.withWriteLock(f.paths, async () => assert.fail(`${proof} cannot admit a writer`)), linuxRefusal);
  }
  await writeFile(statePath, original, {mode: 0o600});
  const packagePath = join(f.bundledRoot, 'package.json'), packageBytes = await readFile(packagePath);
  await writeFile(packagePath, JSON.stringify(candidate('0.1.7')), {mode: 0o600});
  await assert.rejects(f.recover('complete'), linuxRefusal, 'changed installed artifacts invalidate the completed seal');
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).recovery.completion, undefined);
  await writeFile(packagePath, packageBytes, {mode: 0o600});
  await f.recover('complete');
  await f.guarded.withWriteLock(f.paths, async () => {});
});

for (const platform of ['darwin', 'linux'] as const) {
for (const replacedOnDisk of [false, true]) {
test(`${platform}: a paused legacy CLI stale reaper cannot overlap a new holder after ${replacedOnDisk ? 'guarded npm replacement' : 'installed lock migration'}`, {
  timeout: 20_000, skip: platform === 'linux' && process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, platform);
  if (platform === 'linux') await f.registerFreshLayout();
  const verifyData = await f.preserveData({passive: platform === 'linux'});
  const refusal = platform === 'linux' ? linuxRefusal : {code: 'HELPER_BUSY'};
  f.addProcess({pid: cliPid, started: 'Fri Oct 23 11:50:00 2026', executable: process.execPath});
  const legacy = await f.load<InstalledPaths>(f.bundledRoot, 'paths');
  await f.seed(); const stale = await lstat(f.paths.lock), checked = f.gate(), resume = f.gate();
  let paused = false, inside = 0, maximum = 0, upgradedEntered = false;
  f.hooks.beforeUnlink = async path => {
    if (path === f.paths.lock && !paused) {paused = true; checked.resolve(); await resume.promise;}
  };
  const old = f.track(legacy.withWriteLock(f.paths, async () => {inside++; maximum = Math.max(maximum, inside); inside--;}));
  await Promise.race([checked.promise, old.then(() => assert.fail('the actual legacy writer must pause before stale unlink'))]);
  if (platform === 'linux' && replacedOnDisk) {
    // This layout already has recorded history. Start its real legacy repair
    // while the loaded old caller is paused, then prove npm replacement cannot
    // erase the pending retirement barrier by publishing matching new bytes.
    await assert.rejects(f.prepare(), refusal);
    const pending = JSON.parse(await readFile(join(f.bundledRoot, '.write-lock-upgrade/state.json'), 'utf8'));
    assert.ok(pending.retirement.processes.some((row: {pid: number}) => row.pid === cliPid));
  }
  if (replacedOnDisk) await f.install(f.bundledRoot, false, '0.1.5');
  await assert.rejects(f.prepare(), refusal);
  assert.equal((await lstat(f.paths.lock)).ino, stale.ino);
  await assert.rejects(f.guarded.withWriteLock(f.paths, async () => {upgradedEntered = true;}), refusal);
  const migrated = await f.load<InstalledPaths>(f.bundledRoot, 'paths', '?migrated');
  await assert.rejects(migrated.withWriteLock(f.paths, async () => {upgradedEntered = true;}), refusal);
  assert.equal(upgradedEntered, false, 'new writers fail before replacing the crashed inode');
  const state = JSON.parse(await readFile(join(f.bundledRoot, '.write-lock-upgrade/state.json'), 'utf8'));
  assert.ok(state.retirement.processes.some((row: {pid: number}) => row.pid === cliPid));
  f.nextIdentity(process.pid);
  await assert.rejects(f.prepare(), refusal, 'the old CLI remains live after the migration caller exits');
  resume.resolve(); await old;
  f.retireProcess(cliPid);
  assert.equal(maximum, 1); assert.equal(f.guards.size, 0);
  await verifyData();

  // The paused legacy caller has finished. A new CLI process on the SAME boot
  // proves that the captured caller cannot resume its old loaded modules.
  await f.nextProcess(); await f.seed();
  const holderEntered = f.gate(), finish = f.gate(), contenderClock = f.clock();
  const first = f.track(migrated.withWriteLock(f.paths, async () => {
    inside++; maximum = Math.max(maximum, inside); holderEntered.resolve(); await finish.promise; inside--;
  }));
  await holderEntered.promise;
  const live = await lstat(f.paths.lock);
  const second = f.track(f.guarded.withWriteLock(f.paths, async () => {
    inside++; maximum = Math.max(maximum, inside); upgradedEntered = true; inside--;
  }, contenderClock.timing));
  await contenderClock.wait(0);
  assert.equal(upgradedEntered, false); assert.equal((await lstat(f.paths.lock)).ino, live.ino);
  finish.resolve(); await first; contenderClock.sleeps[0](); await second;
  assert.equal(upgradedEntered, true); assert.equal(maximum, 1); assert.equal(f.guards.size, 0);
  if (platform === 'linux') assert.deepEqual(f.commands, [], 'paused writer retirement never restarts Linux service entrypoints');
  await verifyData();
});
}
}

test('an installed exported writer refuses entry before lock migration is initialized', {timeout: 20_000}, async t => {
  const f = await fixture(t), verifyData = await f.preserveData();
  let entered = false;
  await assert.rejects(f.guarded.withWriteLock(f.paths, async () => {entered = true;}), {
    code: 'HELPER_BUSY', message: 'Run maddots-ai status to finish the helper lock upgrade, then retry.',
  });
  assert.equal(entered, false); assert.equal(f.guards.size, 0);
  await assert.rejects(lstat(f.paths.lock), {code: 'ENOENT'});
  await verifyData();
});

test('only the helper LaunchAgent is restarted and its old process must retire before entry', {timeout: 20_000}, async t => {
  const f = await fixture(t), verifyData = await f.preserveData();
  f.addProcess({pid: servicePid, started: 'Fri Oct 23 11:40:00 2026', executable: process.execPath});
  f.setService(servicePid, false);
  await assert.rejects(f.prepare(), {code: 'HELPER_BUSY'});
  const kicks = () => f.commands.filter(command => command.file === '/bin/launchctl' && command.args[0] === 'kickstart');
  assert.equal(kicks().length, 1);
  assert.deepEqual(kicks()[0].args, ['kickstart', '-k', `gui/${process.getuid!()}/app.maddots.ai.helper`]);
  f.nextIdentity(process.pid);
  await assert.rejects(f.guarded.withWriteLock(f.paths, async () => assert.fail('kickstart alone is not proof of retirement')), {code: 'HELPER_BUSY'});
  f.nextIdentity(servicePid); // launchd has now replaced the old service process.
  await f.prepare();
  await f.guarded.withWriteLock(f.paths, async () => {});
  assert.equal(f.guards.size, 0); await verifyData();
});

test('an AI tool holding old helper code stays blocked until its captured process exits', {timeout: 20_000}, async t => {
  const f = await fixture(t), verifyData = await f.preserveData();
  const started = 'Fri Oct 23 11:30:00 2026';
  const image = '/Applications/Cursor.app/Contents/MacOS/Cursor';
  // A process title can resemble an excluded shell. Only the kernel image is
  // allowed to decide whether a host might contain imported helper code.
  f.addProcess({pid: toolPid, started, executable: '/bin/zsh', image});
  await assert.rejects(f.prepare(), error => {
    assert.equal((error as {code: string}).code, 'HELPER_BUSY');
    assert.match((error as Error).message, new RegExp(`Cursor \\(PID ${toolPid}\\)`));
    assert.match((error as Error).message, /Quit and reopen/);
    assert.doesNotMatch((error as Error).message, /restart the Mac|reboot/i); return true;
  });
  const statePath = join(f.bundledRoot, '.write-lock-upgrade/state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.deepEqual(state.retirement.processes.find((row: {pid: number}) => row.pid === toolPid), {pid: toolPid, started, executable: image});
  f.nextIdentity(process.pid);
  await assert.rejects(f.prepare(), {code: 'HELPER_BUSY'});
  f.addProcess({pid: toolPid, started, executable: '/bin/sh', image: '/bin/sh'});
  await assert.rejects(f.guarded.withWriteLock(f.paths, async () => assert.fail('changing an image/title does not prove old code is gone')), {code: 'HELPER_BUSY'});
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')).retirement, state.retirement, 'a repeat cannot discard the saved cohort');
  f.retireProcess(toolPid); await f.prepare();
  await f.guarded.withWriteLock(f.paths, async () => {});
  assert.equal(f.commands.some(command => command.file === '/bin/launchctl' && command.args[0] === 'kickstart'), false);
  assert.equal(f.guards.size, 0); await verifyData();
});

test('zombies retire at capture and later without replacing the durable cohort or barrier', {timeout: 20_000}, async t => {
  const f = await fixture(t), verifyData = await f.preserveData();
  const started = 'Fri Oct 23 11:30:00 2026', image = '/Applications/Cursor.app/Contents/MacOS/Cursor';
  const foreignPid = toolPid + 1;
  f.addProcess({pid: cliPid, started, executable: process.execPath, state: 'Z'});
  f.addProcess({pid: toolPid, started, executable: image});
  f.addProcess({pid: servicePid, started: 'Fri Oct 23 11:40:00 2026', executable: process.execPath});
  // The ps fixture selects by real UID before rendering. This invalid start
  // value must never enter inspection or durable migration records.
  f.addProcess({pid: foreignPid, uid: process.getuid!() + 1, started: 'OTHER_USER_PRIVATE_START', executable: '/private/OTHER_USER_IMAGE'});
  await assert.rejects(f.prepare(), {code: 'HELPER_BUSY'});
  const statePath = join(f.bundledRoot, '.write-lock-upgrade/state.json');
  const savedText = await readFile(statePath, 'utf8'), saved = JSON.parse(savedText);
  assert.equal(saved.patching, undefined);
  assert.deepEqual(saved.retirement.processes.map((row: {pid: number}) => row.pid).sort((a: number, b: number) => a - b),
    [process.pid, servicePid, toolPid].sort((a, b) => a - b));
  assert.deepEqual(saved.retirement.processes.find((row: {pid: number}) => row.pid === toolPid), {pid: toolPid, started, executable: image});
  assert.doesNotMatch(savedText, /OTHER_USER/u);
  const inspected = f.commands.filter(command => command.file === '/usr/bin/osascript').flatMap(command => command.args.slice(4));
  assert.equal(inspected.includes(String(cliPid)), false, 'an identified capture zombie needs no kernel image');
  assert.equal(inspected.includes(String(foreignPid)), false, 'other-user processes are never inspected');

  f.nextIdentity(process.pid);
  await assert.rejects(f.prepare(), {code: 'HELPER_BUSY'});
  assert.equal(await readFile(statePath, 'utf8'), savedText, 'a retry preserves the exact captured cohort');
  f.addProcess({pid: toolPid, started, executable: image, state: 'Z'});
  await assert.rejects(f.guarded.withWriteLock(f.paths, async () => assert.fail('the other live cohort member still blocks entry')), {code: 'HELPER_BUSY'});
  assert.equal(await readFile(statePath, 'utf8'), savedText, 'a zombie retires without rewriting saved identities or clearing a live barrier');

  f.retireProcess(servicePid);
  await f.prepare();
  await f.guarded.withWriteLock(f.paths, async () => {});
  const retiredText = await readFile(statePath, 'utf8'), retired = JSON.parse(retiredText);
  const {retirement: _retirement, ...withoutRetirement} = saved;
  assert.deepEqual(retired, withoutRetirement, 'only the completed retirement barrier is removed');
  f.retireProcess(cliPid); f.retireProcess(toolPid);
  await f.prepare();
  await f.guarded.withWriteLock(f.paths, async () => {});
  assert.equal(await readFile(statePath, 'utf8'), retiredText, 'later reaping cannot recapture or change a completed migration');
  assert.equal(f.guards.size, 0); await verifyData();
});

for (const platform of ['darwin', 'linux'] as const) {
test(`${platform}: a legacy updater publishing after the first inventory starts a new retirement cohort`, {
  timeout: 20_000, skip: platform === 'linux' && process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, platform);
  if (platform === 'linux') await f.registerFreshLayout();
  const verifyData = await f.preserveData({passive: platform === 'linux'});
  const refusal = platform === 'linux' ? linuxRefusal : {code: 'HELPER_BUSY'};
  f.addProcess({pid: cliPid, started: 'Fri Oct 23 11:20:00 2026', executable: process.execPath});
  await assert.rejects(f.prepare(), refusal);
  const late = join(f.paths.data, 'updates/releases', commitA);
  await f.install(late, true, '0.1.5');
  f.retireProcess(cliPid); f.nextIdentity(process.pid);
  await assert.rejects(f.prepare(), refusal, 'a root published by the retiring updater must also be retrofitted and retired');
  assert.match(await readFile(join(late, 'dist/paths.js'), 'utf8'), /export \{ withWriteLock \} from '\.\/write-lock\.js';/);
  await f.nextProcess();
  const retained = await f.load<InstalledPaths>(late, 'paths');
  await retained.withWriteLock(f.paths, async () => {});
  if (platform === 'linux') assert.deepEqual(f.commands, [], 'late updater retirement never restarts Linux service entrypoints');
  assert.equal(f.guards.size, 0); await verifyData();
});
}

test('normal upgrade, repeated upgrade and retained-bootstrap rollback preserve data and version floor', {timeout: 30_000}, async t => {
  const f = await fixture(t), verifyData = await f.preserveData();
  const updater = await f.load<Updater>(f.modernRoot, 'updater');
  const cli = await f.load<Cli>(f.modernRoot, 'cli');
  const launch = await f.load<Runtime>(f.modernRoot, 'runtime');
  const output: string[] = [];
  const cliOptions: CliOptions = {home: f.home, env: {}, runtime: f.runtime, prepareLocks: f.upgrade.prepareLockUpgrade, output: line => output.push(line),
    runner: async () => assert.fail('updates must not access credentials or launchd'),
    request: async () => assert.fail('fixture updates must not contact a service'),
    updates: {check: options => updater.checkForUpdate(options, f.backend(commitA, '0.1.6'))}};
  // The installed 0.1.5 bootstrap receives a selected runtime through the real
  // dispatcher. The first selected command installs the barrier, then asks for
  // a new invocation before any state-changing operation can proceed.
  await assert.rejects(launch.launchCli(['update'], async () => assert.fail('selected runtime must run'), cliOptions, {
    select: async () => ({root: f.modernRoot, version: '0.1.6'}), load: async () => cli,
  }), {code: 'HELPER_BUSY'});
  assert.equal(output.length, 1); assert.match(output[0], /retry it in a new process/);
  assert.doesNotMatch(output[0], /restart the Mac|reboot/i);
  output.length = 0; await verifyData();
  await f.nextProcess();
  await launch.launchCli(['update'], async () => assert.fail('selected runtime must run'), cliOptions, {
    select: async () => ({root: f.modernRoot, version: '0.1.6'}), load: async () => cli,
  });
  assert.equal((await updater.selectRelease(f.options, source)).commit, commitA);
  const firstRoot = join(f.paths.data, 'updates/releases', commitA);
  assert.match(await readFile(join(firstRoot, 'dist/paths.js'), 'utf8'), /export \{ withWriteLock \} from '\.\/write-lock\.js';/);
  await f.prepare(); // Repeated preparation does not retire already guarded callers again.
  await cli.runCli(['update'], {...cliOptions, updates: {check: options => updater.checkForUpdate(options, f.backend(commitB, '0.1.7'))}});
  assert.equal((await updater.selectRelease(f.options, source)).commit, commitB);
  await f.prepare();

  // The current dispatcher exercises the retained updater after the captured
  // caller exits. That updater uses the exact released paths.js ABI locally.
  const bootstrapUpdater = await f.load<Updater>(f.bundledRoot, 'updater');
  let rollbacks = 0;
  const rollbackOptions: CliOptions = {...cliOptions, runtime: {...f.runtime, runningRoot: f.bundledRoot}, updates: {
    rollback: async options => {rollbacks++; return bootstrapUpdater.rollbackRelease(options, undefined, source);},
  }};
  const blocked = f.gate(), release = f.gate();
  const holder = f.track(f.guarded.withWriteLock(f.paths, async () => {blocked.resolve(); await release.promise;}));
  await blocked.promise;
  const rollbackClock = f.clock();
  const rollback = f.track(launch.launchCli(['update', '--rollback'], cli.runCli,
    {...rollbackOptions, timing: rollbackClock.timing}, {
      select: async () => assert.fail('rollback must use the retained bootstrap'),
      load: async () => assert.fail('rollback must work without importing the selected CLI'),
    }));
  await rollbackClock.wait(0);
  assert.equal((await updater.selectRelease(f.options, source)).commit, commitB);
  release.resolve(); await holder; rollbackClock.sleeps[0](); await rollback;
  assert.equal((await updater.selectRelease(f.options, source)).commit, commitA); assert.equal(rollbacks, 1);
  await launch.launchCli(['update', '--rollback'], cli.runCli, rollbackOptions);
  assert.deepEqual(await updater.selectRelease(f.options, source), {root: f.bundledRoot, version: '0.1.5'});
  assert.equal(rollbacks, 2); assert.equal(f.guards.size, 0);
  assert.equal(output.length, 4); assert.ok(output.every(line => line.includes('Verified helper')));
  await verifyData();
});

test('Linux current updater rejects a changed data root retaining another root\'s logs before cache creation', {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux', false); await f.prepare();
  const updater = await f.load<Updater>(f.modernRoot, 'updater');
  const data = join(f.home, 'unregistered-data');
  const paths = {...f.paths, data, lock: join(data, '.lock')};
  const before = await snapshotTree(f.home);
  assert.deepEqual(await updater.checkForUpdate({...f.options, paths}, {...f.backend(commitA, '0.1.7'),
    latest: async () => assert.fail('mismatched data/logs cannot reach discovery')}), {status: 'busy'});
  assert.deepEqual(await snapshotTree(f.home), before);
  await assert.rejects(lstat(data), {code: 'ENOENT'});
});

test('exact released 0.1.5 and main paths/updater import and run the complete local repair graph', {
  timeout: 60_000, skip: process.platform !== 'linux',
}, async t => {
  for (const released of releasedUpdater.sources) await t.test(`${released.version} ${released.commit}`, async context => {
    const f = await fixture(context, 'linux', false);
    const resolver = releasedPaths.sources.find(row => row.commit === released.commit)!;
    await f.install(f.bundledRoot, true, released.version, releasedUpdater.updater, resolver.paths);
    for (const name of [...migrationOrder, 'runner/signal-gate']) await assert.rejects(lstat(join(f.bundledRoot, 'dist', name + '.js')), {code: 'ENOENT'});
    assert.equal(await readFile(join(f.bundledRoot, 'dist/paths.js'), 'utf8'), transpileModule(resolver.paths,
      {compilerOptions: {target: ScriptTarget.ES2022, module: ModuleKind.ESNext}}).outputText);
    const lock = join(f.modernRoot, 'dist/write-lock.js');
    await writeFile(lock, await readFile(lock, 'utf8') + "\nimport './repair-closure-fixture.js';\n", {mode: 0o600});
    await writeFile(join(f.modernRoot, 'dist/repair-closure-fixture.js'), [
      "export {probe} from './runner/repair-closure-leaf.js';",
      "export const lazy = () => import('./repair-closure-lazy.js');",
      "const decoy = \"import './never-copy-string.js'\";",
      'if (decoy) /import("never-copy-regexp.js")/.test(decoy);',
      "// import './never-copy-comment.js';",
      "const template = `import './never-copy-template.js'`; void template;",
    ].join('\n'), {mode: 0o600});
    await writeFile(join(f.modernRoot, 'dist/runner/repair-closure-leaf.js'),
      "import '../repair-closure-fixture.js'; export const probe = 'local repaired closure';\n", {mode: 0o600});
    await writeFile(join(f.modernRoot, 'dist/repair-closure-lazy.js'), "export const value = 'local lazy closure';\n", {mode: 0o600});
    await assert.rejects(f.prepare(), linuxRefusal);
    await f.nextProcess();
    const state = JSON.parse(await readFile(join(f.bundledRoot, '.write-lock-upgrade/state.json'), 'utf8'));
    for (const name of ['runner/signal-gate.js', 'repair-closure-fixture.js', 'runner/repair-closure-leaf.js', 'repair-closure-lazy.js']) {
      const bytes = await readFile(join(f.bundledRoot, 'dist', name));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), state.sources[name]);
      assert.deepEqual(bytes, await readFile(join(f.bundledRoot, '.write-lock-upgrade', name.replaceAll('/', '%2F'))));
    }
    async function assertLocal(directory: string): Promise<void> {
      for (const entry of await readdir(directory, {withFileTypes: true})) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await assertLocal(path);
        else if (entry.name.endsWith('.js')) assert.doesNotMatch(await readFile(path, 'utf8'), /file:\/\/.*\.(?:ts|js)['"]/u, path);
      }
    }
    await assertLocal(f.bundledRoot);
    const identity = await f.load<typeof import('../src/release-identity.js')>(f.bundledRoot, 'release-identity');
    assert.equal(identity.VERSION, released.version);
    const installedUpgrade = await f.load<Upgrade>(f.bundledRoot, 'write-lock-upgrade');
    await installedUpgrade.assertLockUpgradeReady(f.paths);
    const installedLocks = await f.load<Locks>(f.bundledRoot, 'write-lock');
    assert.equal(typeof installedLocks.acquireWriteGuard, 'function');
    const installedUpdater = await f.load<Updater>(f.bundledRoot, 'updater');
    assert.deepEqual(await installedUpdater.selectRelease({...f.options, version: released.version}, source),
      {root: f.bundledRoot, version: released.version});
    const closure = await f.load<{probe: string; lazy: () => Promise<{value: string}>}>(f.bundledRoot, 'repair-closure-fixture');
    assert.equal(closure.probe, 'local repaired closure');
    assert.equal((await closure.lazy()).value, 'local lazy closure');
    const repaired = await f.load<InstalledPaths>(f.bundledRoot, 'paths');
    let writes = 0; await repaired.withWriteLock(f.paths, async () => {writes++;}); assert.equal(writes, 1);
  });
});

test('repair rejects a missing preserved ABI dependency before publishing its write-lock marker', {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux', true);
  const config = join(f.bundledRoot, 'dist/config.js');
  await writeFile(config, await readFile(config, 'utf8') + "\nimport './absent-runtime-dependency.js';\n", {mode: 0o600});
  await assert.rejects(f.prepare(), {code: 'CANDIDATE_FAILED'});
  for (const name of migrationOrder) await assert.rejects(lstat(join(f.bundledRoot, 'dist', name + '.js')), {code: 'ENOENT'});
});

test('repair verifies copied transitive modules before publishing the protocol marker or paths export', {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux', true);
  const target = join(f.bundledRoot, 'dist/paths.js'), original = await readFile(target);
  let interrupted = false;
  f.hooks.beforeRename = async path => {
    if (!interrupted && path === join(f.bundledRoot, 'dist/write-lock-upgrade.js')) {
      interrupted = true; await rm(join(f.bundledRoot, 'dist/runner/signal-gate.js'));
    }
  };
  await assert.rejects(f.prepare(), {code: 'CANDIDATE_FAILED'});
  assert.equal(interrupted, true);
  await assert.rejects(lstat(join(f.bundledRoot, 'dist/write-lock.js')), {code: 'ENOENT'});
  assert.deepEqual(await readFile(target), original);
  const state = JSON.parse(await readFile(join(f.bundledRoot, '.write-lock-upgrade/state.json'), 'utf8'));
  assert.equal(state.patching, true);
  f.hooks.beforeRename = undefined;
  await assert.rejects(f.prepare(), linuxRefusal); await f.nextProcess();
  const paths = await f.load<InstalledPaths>(f.bundledRoot, 'paths');
  let writes = 0; await paths.withWriteLock(f.paths, async () => {writes++;}); assert.equal(writes, 1);
});

test('a same-revision coordinator retains a missing import closure without replacing its existing source implementations', {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux', false); await f.prepare();
  const directory = join(f.bundledRoot, '.write-lock-upgrade'), statePath = join(directory, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  delete state.sources['runner/signal-gate.js'];
  const previous = {...state.sources};
  await rm(join(directory, 'runner%2Fsignal-gate.js'));
  await rm(join(f.bundledRoot, 'dist/runner/signal-gate.js'));
  await writeFile(statePath, JSON.stringify(state) + '\n', {mode: 0o600});
  await assert.rejects(f.prepare(), linuxRefusal); await f.nextProcess();
  const repaired = JSON.parse(await readFile(statePath, 'utf8'));
  for (const [name, hash] of Object.entries(previous)) assert.equal(repaired.sources[name], hash, name);
  assert.equal(createHash('sha256').update(await readFile(join(f.bundledRoot, 'dist/runner/signal-gate.js'))).digest('hex'),
    repaired.sources['runner/signal-gate.js']);
  const paths = await f.load<InstalledPaths>(f.bundledRoot, 'paths');
  let writes = 0; await paths.withWriteLock(f.paths, async () => {writes++;}); assert.equal(writes, 1);
});

test('a missing cached-runtime dependency preserves bootstrap rollback and disables only the broken cached launcher', {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux', false);
  await f.prepare();
  const cached = join(f.paths.data, 'updates/releases', commitA);
  await f.install(cached, true, '0.1.5');
  const config = join(cached, 'dist/config.js');
  await writeFile(config, await readFile(config, 'utf8') + "\nimport './absent-cached-dependency.js';\n", {mode: 0o600});
  await assert.rejects(f.prepare(), linuxRefusal);
  await f.nextProcess();
  await assert.rejects(lstat(join(cached, 'dist/cli.js')), {code: 'ENOENT'});
  assert.equal((await readdir(join(cached, 'dist'))).filter(name => name.startsWith('.refused-cli-')).length, 1);
  let writes = 0; await f.guarded.withWriteLock(f.paths, async () => {writes++;}); assert.equal(writes, 1);
});

for (const expression of ["'./ignored.js' + suffix", '`./${suffix}.js`', "'./escaped\\u002ejs'"]) {
test(`repair refuses a nonliteral or escaped dynamic dependency: ${expression}`, {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux', true);
  const lock = join(f.modernRoot, 'dist/write-lock.js');
  await writeFile(lock, await readFile(lock, 'utf8') + `\nconst suffix = 'fixture'; export const fixtureImport = () => import(${expression});\n`, {mode: 0o600});
  await assert.rejects(f.prepare(), {code: 'CANDIDATE_FAILED'});
  await assert.rejects(lstat(join(f.bundledRoot, 'dist/write-lock.js')), {code: 'ENOENT'});
});
}

test('Linux exact released resolvers admit registered initialization, nested writers and retained-bootstrap rollback', {
  timeout: 60_000, skip: process.platform !== 'linux',
}, async t => {
  for (const released of releasedUpdater.sources) await t.test(`${released.version} ${released.commit}`, async context => {
    const resolverSource = releasedPaths.sources.find(source => source.commit === released.commit)!;
    assert.equal(createHash('sha1').update(`blob ${Buffer.byteLength(resolverSource.paths)}\0`).update(resolverSource.paths).digest('hex'), resolverSource.blob);
    const f = await fixture(context, 'linux', false);
    // Register the old default directory using today's complete resolver.
    // The retained resolver itself has no authority to register any layout.
    const data = join(f.home, 'Library/Application Support/maddots-ai');
    const current = await createPaths(readConfig({MADDOTS_AI_HOME: data}, f.home, 'linux'));
    await f.upgrade.prepareLockUpgrade(f.runtime, current);
    await f.install(f.bundledRoot, false, released.version, releasedUpdater.updater, resolverSource.paths);
    await assert.rejects(f.upgrade.prepareLockUpgrade(f.runtime, current), linuxRefusal);
    f.nextIdentity(process.pid);
    await f.upgrade.prepareLockUpgrade(f.runtime, current);
    const resolver = await f.load<InstalledPaths>(f.bundledRoot, 'paths');
    const retained = await resolver.createPaths(readConfig({MADDOTS_AI_HOME: data}, f.home, 'linux'));
    for (const field of ['linuxStorage', 'stateDir', 'config', 'runtime'] as const) assert.equal(field in retained, false);
    assert.equal(retained.state, join(data, 'state.json'));
    const statePath = join(f.bundledRoot, '.write-lock-upgrade/state.json');
    const registered = await readFile(statePath, 'utf8');
    await resolver.ensurePaths(retained);
    let entered = 0;
    await resolver.withWriteLock(retained, async () => {
      await resolver.withWriteLock({...retained, data: join(data, 'updates'), lock: join(data, 'updates/.lock')}, async () => {entered++;});
    });
    assert.equal(entered, 1);
    assert.equal(await readFile(statePath, 'utf8'), registered, 'released admission only reuses recorded coverage');
    const updater = await f.load<Updater>(f.bundledRoot, 'updater');
    const options = {...f.options, paths: retained, version: released.version};
    assert.equal((await updater.checkForUpdate(options, f.backend(commitA, '0.1.7'))).status, 'prepared');
    assert.equal((await updater.checkForUpdate(options, f.backend(commitB, '0.1.8'))).status, 'prepared');
    assert.equal((await updater.rollbackRelease(options, undefined, source)).status, 'rolled-back');
    assert.equal((await updater.selectRelease(options, source)).commit, commitA);
    assert.equal((await updater.rollbackRelease(options, undefined, source)).status, 'rolled-back');
    assert.deepEqual(await updater.selectRelease(options, source), {root: f.bundledRoot, version: released.version});

    const otherHome = join(f.home, 'unregistered-home');
    await ensurePrivateDirectory(otherHome);
    const unknownHome = await resolver.createPaths(readConfig({MADDOTS_AI_HOME: data}, otherHome, 'linux'));
    const before = await snapshotTree(f.home);
    await assert.rejects(resolver.ensurePaths(unknownHome), linuxRefusal);
    await assert.rejects(resolver.withWriteLock(unknownHome, async () => assert.fail('registered data cannot attribute another HOME')), linuxRefusal);
    assert.equal((await updater.rollbackRelease({...options, paths: unknownHome}, undefined, source)).status, 'busy');
    assert.deepEqual(await snapshotTree(f.home), before, 'unregistered released HOME refuses without publications');
  });
});

test('released Linux updaters reject attest-only prerelease manifests before candidate execution or activation', {
  timeout: 60_000, skip: process.platform !== 'linux',
}, async t => {
  assert.equal(createHash('sha1').update(`blob ${Buffer.byteLength(releasedUpdater.updater)}\0`).update(releasedUpdater.updater).digest('hex'), releasedUpdater.blob);
  for (const released of releasedUpdater.sources) await t.test(`${released.version} ${released.commit}`, async context => {
    const f = await fixture(context, 'linux', false);
    await f.install(f.bundledRoot, false, released.version, releasedUpdater.updater,
      releasedPaths.sources.find(source => source.commit === released.commit)!.paths);
    await assert.rejects(f.prepare(), linuxRefusal); await f.nextProcess();
    const updater = await f.load<Updater>(f.bundledRoot, 'updater');
    const options = {...f.options, version: released.version};
    assert.deepEqual(await updater.checkForUpdate(options, f.backend(commitA, '0.1.6')),
      {status: 'prepared', commit: commitA, version: '0.1.6'});
    const selected = await updater.selectRelease(options, source);
    const directory = join(f.paths.data, 'updates'), pointer = await readFile(join(directory, 'current.json'), 'utf8');
    const runtimeDigests = async () => Object.fromEntries(Object.entries(await snapshotTree(selected.root)).map(([path, value]) => {
      const entry = value as {mode: number; bytes?: Buffer};
      return [path, {mode: entry.mode, ...(entry.bytes ? {sha256: createHash('sha256').update(entry.bytes).digest('hex')} : {})}];
    }));
    const active = await runtimeDigests(), commands = [...f.commands];
    let prepared = false;
    const candidateBackend = f.backend(commitB, '0.1.6-linux.s5.7.2');
    const result = await updater.checkForUpdate({...options, activate: async () => assert.fail('an attest-only candidate must not activate')}, {
      ...candidateBackend,
      prepare: async (release, target) => {prepared = true; await candidateBackend.prepare(release, target);},
      validate: async () => assert.fail('an attest-only candidate must not execute'),
    });
    assert.equal(prepared, true, 'The prerelease package must reach the released manifest guard.');
    assert.deepEqual(result, {status: 'failed', reason: 'INVALID_MANIFEST'});
    assert.deepEqual(await updater.selectRelease(options, source), selected);
    assert.equal(await readFile(join(directory, 'current.json'), 'utf8'), pointer);
    assert.deepEqual(await readdir(join(directory, 'releases')), [commitA]);
    assert.deepEqual(await runtimeDigests(), active, 'Every active runtime file keeps its bytes and permissions.');
    assert.deepEqual(f.commands, commands, 'A rejected manifest must not run candidate or service commands.');
  });
});

test('released Linux updaters refuse unregistered roots without creating history that poisons later registration', {
  timeout: 60_000, skip: process.platform !== 'linux',
}, async t => {
  assert.equal(createHash('sha1').update(`blob ${Buffer.byteLength(releasedUpdater.updater)}\0`).update(releasedUpdater.updater).digest('hex'), releasedUpdater.blob);
  for (const released of releasedUpdater.sources) await t.test(`${released.version} ${released.commit}`, async context => {
    const f = await fixture(context, 'linux', false);
    await f.install(f.bundledRoot, false, released.version, releasedUpdater.updater,
      releasedPaths.sources.find(source => source.commit === released.commit)!.paths);
    await assert.rejects(f.prepare(), linuxRefusal); await f.nextProcess();
    const retained = await f.load<Updater>(f.bundledRoot, 'updater');
    const resolver = await f.load<InstalledPaths>(f.bundledRoot, 'paths');
    const alternate = await createPaths(readConfig({MADDOTS_AI_HOME: join(f.home, 'unregistered-data')}, f.home, 'linux'));
    const legacyPaths = await resolver.createPaths(readConfig({MADDOTS_AI_HOME: alternate.data}, f.home, 'linux'));
    const options = {...f.options, version: released.version, paths: legacyPaths};
    const before = await snapshotTree(f.home);
    await assert.rejects(resolver.ensurePaths(legacyPaths), linuxRefusal);
    await assert.rejects(resolver.withWriteLock(legacyPaths, async () => assert.fail('unregistered roots cannot enter a writer')), linuxRefusal);
    assert.deepEqual(await retained.checkForUpdate(options, {...f.backend(commitA, '0.1.7'),
      latest: async () => assert.fail('unregistered roots cannot reach update discovery')}), {status: 'busy'});
    const staleLogs = {...f.paths, data: alternate.data, lock: alternate.lock};
    assert.deepEqual(await retained.checkForUpdate({...options, paths: staleLogs}, {...f.backend(commitA, '0.1.7'),
      latest: async () => assert.fail('the old logs location cannot attribute another data root')}), {status: 'busy'});
    assert.deepEqual(await snapshotTree(f.home), before);
    await assert.rejects(lstat(alternate.data), {code: 'ENOENT'});
    // A later supported resolver can still register B because the rejected
    // optional update did not create B/updates/releases first.
    await assert.rejects(f.upgrade.prepareLockUpgrade(f.runtime, alternate), linuxRefusal);
    await f.nextProcess();
    await resolver.ensurePaths(legacyPaths);
    assert.equal((await retained.checkForUpdate(options, f.backend(commitA, '0.1.7'))).status, 'prepared');
    assert.equal((await retained.selectRelease(options, source)).commit, commitA);
  });
});

test('retrofitted released Linux updaters preserve status and stages after discovery, publication and rollback refusal', {
  timeout: 90_000, skip: process.platform !== 'linux',
}, async t => {
  for (const released of releasedUpdater.sources) for (const phase of ['discovery', 'publication', 'rollback'] as const) {
    await t.test(`${released.version} ${phase}`, async context => {
      const f = await fixture(context, 'linux', false);
      await f.install(f.bundledRoot, false, released.version, releasedUpdater.updater,
        releasedPaths.sources.find(source => source.commit === released.commit)!.paths);
      await assert.rejects(f.prepare(), linuxRefusal); await f.nextProcess();
      const retained = await f.load<Updater>(f.bundledRoot, 'updater');
      const resolver = await f.load<InstalledPaths>(f.bundledRoot, 'paths');
      const {HelperError} = await f.load<typeof import('../src/config.js')>(f.bundledRoot, 'config');
      const options = {...f.options, version: released.version,
        paths: await resolver.createPaths(readConfig({MADDOTS_AI_HOME: f.paths.data}, f.home, 'linux'))};
      assert.equal((await retained.checkForUpdate(options, f.backend(commitA, '0.1.7'))).status, 'prepared');
      const directory = join(f.paths.data, 'updates'), pointer = await readFile(join(directory, 'current.json'), 'utf8');
      const guard = phase === 'discovery' ? join(directory, '.lock.guard') : f.paths.lock + '.guard';
      let refused = false, status = '', entries: string[] = [], discoveries = 0, preparations = 0, activations = 0;
      const writes: string[] = [];
      f.hooks.beforeOpen = async (path, flags) => {
        if (path === guard) {
          status = await readFile(join(directory, 'last-check.json'), 'utf8');
          entries = (await readdir(directory)).sort(); refused = true;
          throw new HelperError(linuxRefusal.code, linuxRefusal.message);
        }
        const writing = typeof flags === 'number' ? !!(flags & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND)) : /[wa+]/u.test(flags ?? 'r');
        if (refused && writing) writes.push(path);
      };
      f.hooks.beforeRename = async path => {if (refused) writes.push(`rename:${path}`);};
      const optionsWithActivation = {...options, activate: async () => {activations++;}};
      const candidate = f.backend(commitB, '0.1.8');
      const result = phase === 'rollback' ? await retained.rollbackRelease(optionsWithActivation, undefined, source) :
        await retained.checkForUpdate(optionsWithActivation, {...candidate,
          latest: async () => {discoveries++; return candidate.latest();},
          prepare: async (release, target) => {preparations++; await candidate.prepare(release, target);},
        });
      f.hooks.beforeOpen = undefined; f.hooks.beforeRename = undefined;
      assert.equal(refused, true); assert.equal(result.status, 'busy');
      assert.deepEqual(writes, [], 'The released updater catch/finally must not publish status or relocate a prepared stage.');
      assert.equal(activations, 0); assert.equal(discoveries, phase === 'publication' ? 1 : 0);
      assert.equal(preparations, phase === 'publication' ? 1 : 0);
      assert.equal(await readFile(join(directory, 'last-check.json'), 'utf8'), status);
      assert.equal(await readFile(join(directory, 'current.json'), 'utf8'), pointer);
      assert.deepEqual((await readdir(directory)).sort(), entries.filter(name => name !== '.lock'));
      assert.equal((await retained.selectRelease(options, source)).commit, commitA);
    });
  }
});

test('Linux installed updaters preserve diagnostics after arbitrary interrupted repair admission failures', {
  timeout: 120_000, skip: process.platform !== 'linux',
}, async t => {
  for (const released of [undefined, ...releasedUpdater.sources]) for (const code of ['EIO', 'CANDIDATE_FAILED', 'INVALID_CHECKSUM']) {
    await t.test(`${released?.version ?? 'current'} ${code}`, async context => {
      const f = await fixture(context, 'linux', false);
      if (released) {
        await f.install(f.bundledRoot, false, released.version, releasedUpdater.updater,
          releasedPaths.sources.find(source => source.commit === released.commit)!.paths);
        await assert.rejects(f.prepare(), linuxRefusal); await f.nextProcess();
      } else await f.prepare();
      const updater = await f.load<Updater>(f.bundledRoot, 'updater');
      const {HelperError} = await f.load<typeof import('../src/config.js')>(f.bundledRoot, 'config');
      const options = {...f.options, version: released?.version ?? f.options.version};
      assert.equal((await updater.checkForUpdate(options, f.backend(commitA, '0.1.7'))).status, 'prepared');
      const directory = join(f.paths.data, 'updates'), statePath = join(f.bundledRoot, '.write-lock-upgrade/state.json');
      const status = await readFile(join(directory, 'last-check.json'), 'utf8');
      const diagnostic = (await updater.diagnosticStatus(options)).lastCheck;
      const pointer = await readFile(join(directory, 'current.json'), 'utf8');
      const rejected = await readFile(join(directory, 'rejected.json'), 'utf8');
      const stage = join(directory, 'staging-retained');
      await mkdir(stage, {mode: 0o700}); await writeFile(join(stage, 'retained.bin'), 'retained stage\n', {mode: 0o600});
      const retained = await snapshotTree(stage);
      const repair = join(f.bundledRoot, 'dist/write-lock-recovery.js'); await rm(repair);
      const failure = code === 'EIO' ? errno(code) : new HelperError(code, code);
      let refused = false, saved = '', discoveries = 0, activations = 0;
      const writes: string[] = [];
      f.hooks.beforeOpen = async (path, flags) => {
        const writing = typeof flags === 'number' ? !!(flags & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND)) : /[wa+]/u.test(flags ?? 'r');
        if (refused && writing) writes.push(path);
      };
      f.hooks.beforeRename = async path => {
        if (path === repair && !refused) {
          saved = await readFile(statePath, 'utf8');
          assert.equal(JSON.parse(saved).patching, true, 'the real repair must persist its barrier before failing admission');
          refused = true; throw failure;
        }
        if (refused) writes.push(`rename:${path}`);
      };
      const result = await updater.checkForUpdate({...options, activate: async () => {activations++;}}, {
        ...f.backend(commitB, '0.1.8'), latest: async () => {discoveries++; assert.fail('failed admission cannot reach discovery');},
      });
      f.hooks.beforeOpen = undefined; f.hooks.beforeRename = undefined;
      assert.equal(refused, true); assert.equal(result.status, 'failed');
      assert.deepEqual(writes, [], 'all admission error codes exclude failure-status publication');
      assert.equal(discoveries, 0); assert.equal(activations, 0);
      assert.equal(await readFile(statePath, 'utf8'), saved);
      assert.equal(await readFile(join(directory, 'last-check.json'), 'utf8'), status);
      assert.deepEqual((await updater.diagnosticStatus(options)).lastCheck, diagnostic, 'failed admission must not update in-memory diagnostics');
      assert.equal(await readFile(join(directory, 'current.json'), 'utf8'), pointer);
      assert.equal(await readFile(join(directory, 'rejected.json'), 'utf8'), rejected);
      assert.deepEqual(await snapshotTree(stage), retained);
      assert.deepEqual(f.commands, [], 'fixture repair never controls Linux services');
    });
  }
});

test('Linux installed updaters preserve status and stages after arbitrary later lock admission failures', {
  timeout: 120_000, skip: process.platform !== 'linux',
}, async t => {
  for (const released of [undefined, ...releasedUpdater.sources]) await t.test(released?.version ?? 'current', async context => {
    const f = await fixture(context, 'linux', false);
    if (released) {
      await f.install(f.bundledRoot, false, released.version, releasedUpdater.updater,
        releasedPaths.sources.find(source => source.commit === released.commit)!.paths);
      await assert.rejects(f.prepare(), linuxRefusal); await f.nextProcess();
    } else await f.prepare();
    const updater = await f.load<Updater>(f.bundledRoot, 'updater');
    const {HelperError} = await f.load<typeof import('../src/config.js')>(f.bundledRoot, 'config');
    const options = {...f.options, version: released?.version ?? f.options.version};
    assert.equal((await updater.checkForUpdate(options, f.backend(commitA, '0.1.7'))).status, 'prepared');
    const directory = join(f.paths.data, 'updates'), statePath = join(f.bundledRoot, '.write-lock-upgrade/state.json');
    const pointer = await readFile(join(directory, 'current.json'), 'utf8');
    const rejected = await readFile(join(directory, 'rejected.json'), 'utf8');
    for (const phase of ['discovery', 'publication', 'rollback'] as const) for (const code of ['EIO', 'CANDIDATE_FAILED', 'INVALID_CHECKSUM', 'HELPER_BUSY']) {
      await context.test(`${phase} ${code}`, async () => {
        const guard = phase === 'discovery' ? join(directory, '.lock.guard') : f.paths.lock + '.guard';
        const failure = code === 'EIO' ? errno(code) : new HelperError(code, code);
        let refused = false, status = '', saved = '', entries: string[] = [], activations = 0, discoveries = 0;
        let diagnostic: Awaited<ReturnType<Updater['diagnosticStatus']>>['lastCheck'] = null;
        const writes: string[] = [], stages = new Map<string, Record<string, unknown>>();
        f.hooks.beforeOpen = async (path, flags) => {
          if (path === guard) {
            status = await readFile(join(directory, 'last-check.json'), 'utf8');
            saved = await readFile(statePath, 'utf8'); entries = (await readdir(directory)).sort();
            diagnostic = (await updater.diagnosticStatus(options)).lastCheck;
            for (const name of entries.filter(name => name.startsWith('staging-'))) {
              const stage = join(directory, name); stages.set(stage, await snapshotTree(stage));
            }
            refused = true; throw failure;
          }
          const writing = typeof flags === 'number' ? !!(flags & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND)) : /[wa+]/u.test(flags ?? 'r');
          if (refused && writing) writes.push(path);
        };
        f.hooks.beforeRename = async path => {if (refused) writes.push(`rename:${path}`);};
        let result;
        try {
          const activated = {...options, activate: async () => {activations++;}};
          const backend = f.backend(commitB, '0.1.8');
          result = phase === 'rollback' ? await updater.rollbackRelease(activated, undefined, source) :
            await updater.checkForUpdate(activated, {...backend, latest: async () => {discoveries++; return backend.latest();}});
        } finally {f.hooks.beforeOpen = undefined; f.hooks.beforeRename = undefined;}
        assert.equal(refused, true); assert.equal(result.status, code === 'HELPER_BUSY' ? 'busy' : 'failed');
        assert.deepEqual(writes, [], 'an earlier admission cannot authorize catch/finally writes after a later acquisition fails');
        assert.equal(activations, 0); assert.equal(discoveries, phase === 'publication' ? 1 : 0);
        assert.equal(await readFile(statePath, 'utf8'), saved);
        assert.equal(await readFile(join(directory, 'last-check.json'), 'utf8'), status);
        assert.deepEqual((await updater.diagnosticStatus(options)).lastCheck, diagnostic);
        assert.equal(await readFile(join(directory, 'current.json'), 'utf8'), pointer);
        assert.equal(await readFile(join(directory, 'rejected.json'), 'utf8'), rejected);
        assert.deepEqual((await readdir(directory)).sort(), entries.filter(name => name !== '.lock'));
        for (const [stage, retained] of stages) assert.deepEqual(await snapshotTree(stage), retained);
      });
    }
    assert.deepEqual(f.commands, [], 'lock admission failures never control Linux services');
  });
});

test('a retained updater registers an alternate data root before using its nested update lock', {timeout: 20_000}, async t => {
  const f = await fixture(t), verifyData = await f.preserveData();
  await assert.rejects(f.prepare(), {code: 'HELPER_BUSY'}); await f.nextProcess();
  const alternate = await createPaths(readConfig({MADDOTS_AI_HOME: join(f.home, 'other-data')}, f.home));
  await ensurePrivateDirectory(alternate.data);
  const original = Buffer.from('{"alternate":"saved state"}\n');
  await writeFile(alternate.state, original, {mode: 0o600});
  const cached = join(alternate.data, 'updates/releases', 'c'.repeat(40));
  await f.install(cached, true, '0.1.6');
  const retained = await f.load<Updater>(f.bundledRoot, 'updater');
  const options = {...f.options, paths: alternate};
  // checkForUpdate overrides paths.data with <actual root>/updates, retaining
  // paths.state. Its patched bootstrap must register the actual root first and
  // discover legacy cached writers there before any backend operation runs.
  const blocked = await retained.checkForUpdate(options, {...f.backend(commitA, '0.1.6'),
    latest: async () => assert.fail('alternate legacy writers require retirement before discovery')});
  assert.equal(blocked.status, 'busy');
  const statePath = join(f.bundledRoot, '.write-lock-upgrade/state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.ok(state.data.includes(alternate.data));
  assert.ok(!state.data.includes(join(alternate.data, 'updates')));
  assert.equal(state.retirement.boot, bootA);
  assert.ok(state.retirement.processes.some((row: {pid: number}) => row.pid === process.pid));
  assert.match(await readFile(join(cached, 'dist/paths.js'), 'utf8'), /export \{ withWriteLock \} from '\.\/write-lock\.js';/);
  await f.nextProcess();
  assert.equal((await retained.checkForUpdate(options, f.backend(commitA, '0.1.6'))).status, 'prepared');
  assert.equal((await retained.selectRelease(options, source)).commit, commitA);

  const bootstrapPaths = await f.load<InstalledPaths>(f.bundledRoot, 'paths');
  const nested = {data: join(alternate.data, 'agent-fences'), lock: join(alternate.data, 'agent-fences/one.lock')} as HelperPaths;
  await bootstrapPaths.withWriteLock(nested, async () => {});
  const unregistered = {data: join(f.home, 'unregistered-data'), lock: join(f.home, 'unregistered-data/.lock')} as HelperPaths;
  await assert.rejects(bootstrapPaths.withWriteLock(unregistered, async () => assert.fail('nested locks require a registered root')), {code: 'PATH_UNSAFE'});
  await assert.rejects(lstat(unregistered.data), {code: 'ENOENT'});
  assert.deepEqual(await readFile(alternate.state), original); await verifyData();
});

test('a broken current paths module and abandoned extraction do not strand retained-bootstrap rollback', {timeout: 20_000}, async t => {
  const f = await fixture(t), verifyData = await f.preserveData();
  await assert.rejects(f.prepare(), {code: 'HELPER_BUSY'}); await f.nextProcess();
  const updater = await f.load<Updater>(f.modernRoot, 'updater');
  assert.equal((await updater.checkForUpdate(f.options, f.backend(commitA, '0.1.6'))).status, 'prepared');
  assert.equal((await updater.checkForUpdate(f.options, f.backend(commitB, '0.1.7'))).status, 'prepared');
  const broken = join(f.paths.data, 'updates/releases', commitB, 'dist/paths.js');
  const brokenBytes = '// interrupted or corrupt installed module\n';
  await writeFile(broken, brokenBytes, {mode: 0o600});
  const partial = join(f.paths.data, 'updates/staging-interrupted/dist/paths.js');
  await mkdir(dirname(partial), {recursive: true, mode: 0o700});
  await writeFile(partial, '// extraction stopped before validation\n', {mode: 0o600});
  const partialBytes = await readFile(partial);
  await assert.rejects(f.prepare(), {code: 'HELPER_BUSY'});
  await assert.rejects(lstat(join(dirname(broken), 'cli.js')), {code: 'ENOENT'});
  assert.equal(await readFile(broken, 'utf8'), brokenBytes, 'preserve the broken module for inspection');
  assert.deepEqual(await readFile(partial), partialBytes, 'an unvalidated partial stage is left intact');
  await assert.rejects(f.guarded.withWriteLock(f.paths, async () => assert.fail('loaded broken release requires retirement')), {code: 'HELPER_BUSY'});
  await f.nextProcess();
  const currentCli = await f.load<Cli>(f.modernRoot, 'cli');
  const bootstrapUpdater = await f.load<Updater>(f.bundledRoot, 'updater');
  const currentRuntime = await f.load<Runtime>(f.modernRoot, 'runtime');
  const output: string[] = [];
  await currentRuntime.launchCli(['update', '--rollback'], currentCli.runCli, {
    home: f.home, env: {}, runtime: {...f.runtime, runningRoot: f.bundledRoot}, output: line => output.push(line),
    updates: {rollback: options => bootstrapUpdater.rollbackRelease(options, undefined, source)},
  }, {select: async () => assert.fail('rollback must not load the broken selected release'),
    load: async () => assert.fail('rollback must remain in the retained bootstrap')});
  assert.equal((await updater.selectRelease(f.options, source)).commit, commitA);
  assert.deepEqual(JSON.parse(await readFile(join(f.paths.data, 'updates/current.json'), 'utf8')), {current: commitA});
  assert.equal(output.length, 1); assert.match(output[0], /Verified helper 0\.1\.6 selected/);
  assert.deepEqual(await readFile(partial), partialBytes); assert.equal(f.guards.size, 0); await verifyData();
});

test('an interrupted atomic retrofit keeps the retirement barrier and resumes without lost data', {timeout: 20_000}, async t => {
  const f = await fixture(t), verifyData = await f.preserveData();
  const original = await readFile(join(f.bundledRoot, 'dist/paths.js'));
  const failure = errno('EIO'); let failed = false;
  f.hooks.beforeRename = async to => {
    if (!failed && to === join(f.bundledRoot, 'dist/paths.js')) {failed = true; throw failure;}
  };
  await assert.rejects(f.prepare(), error => error === failure);
  assert.deepEqual(await readFile(join(f.bundledRoot, 'dist/paths.js')), original);
  const state = JSON.parse(await readFile(join(f.bundledRoot, '.write-lock-upgrade/state.json'), 'utf8'));
  assert.equal(state.patching, true);
  assert.equal(state.retirement, undefined, 'the cohort is captured only after the last module replacement');
  await assert.rejects(f.guarded.withWriteLock(f.paths, async () => assert.fail('an interrupted migration must fail closed')), {code: 'HELPER_BUSY'});
  await assert.rejects(f.prepare(), {code: 'HELPER_BUSY'});
  assert.equal(f.guards.size, 0); await verifyData();
  await f.nextProcess();
  const retained = await f.load<InstalledPaths>(f.bundledRoot, 'paths');
  await retained.withWriteLock(f.paths, async () => {});
  await f.prepare(); assert.equal(f.guards.size, 0); await verifyData();
});

test('interrupted cohort persistence keeps the patching barrier and recaptures newly loaded legacy hosts', {timeout: 20_000}, async t => {
  const f = await fixture(t), verifyData = await f.preserveData();
  const statePath = join(f.bundledRoot, '.write-lock-upgrade/state.json');
  const failure = errno('EIO'); let retrofitted = false, failed = false;
  f.addProcess({pid: cliPid, started: 'Fri Oct 23 11:20:00 2026', executable: process.execPath});
  f.hooks.beforeRename = async to => {
    if (to === join(f.bundledRoot, 'dist/paths.js')) retrofitted = true;
    if (retrofitted && !failed && to === statePath) {
      failed = true;
      const saved = JSON.parse(await readFile(statePath, 'utf8'));
      assert.equal(saved.patching, true);
      assert.equal(saved.retirement, undefined);
      // The first snapshot has already been captured. This host loaded legacy
      // code just before the interruption and must appear in the retry cohort.
      f.addProcess({pid: toolPid, started: 'Fri Oct 23 11:30:00 2026', executable: '/Applications/Cursor.app/Contents/MacOS/Cursor'});
      throw failure;
    }
  };
  await assert.rejects(f.prepare(), error => error === failure);
  assert.equal(failed, true);
  const interrupted = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(interrupted.patching, true);
  assert.equal(interrupted.retirement, undefined, 'a failed snapshot commit cannot replace the durable patching barrier');
  await assert.rejects(f.prepare(), {code: 'HELPER_BUSY'});
  const resumed = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(resumed.patching, undefined);
  assert.equal(resumed.retirement.boot, bootA);
  assert.deepEqual(resumed.retirement.processes.map((row: {pid: number}) => row.pid).sort((a: number, b: number) => a - b),
    [process.pid, cliPid, toolPid].sort((a, b) => a - b));
  f.nextIdentity(process.pid);
  await assert.rejects(f.guarded.withWriteLock(f.paths, async () => assert.fail('both captured legacy hosts remain live')), {code: 'HELPER_BUSY'});
  f.retireProcess(cliPid);
  await assert.rejects(f.guarded.withWriteLock(f.paths, async () => assert.fail('the newly captured tool still holds old code')), {code: 'HELPER_BUSY'});
  f.retireProcess(toolPid);
  await f.prepare();
  await f.guarded.withWriteLock(f.paths, async () => {});
  assert.equal(f.guards.size, 0); await verifyData();
});

test('malformed persisted migration records cannot admit an installed writer', {timeout: 20_000}, async t => {
  const f = await fixture(t), verifyData = await f.preserveData();
  await assert.rejects(f.prepare(), {code: 'HELPER_BUSY'});
  const statePath = join(f.bundledRoot, '.write-lock-upgrade/state.json');
  const original = await readFile(statePath, 'utf8'), valid = JSON.parse(original);
  for (const text of ['{', 'null', JSON.stringify({...valid, retirement: null}),
    JSON.stringify({...valid, retirement: {...valid.retirement, processes: [null]}})]) {
    await writeFile(statePath, text, {mode: 0o600});
    await assert.rejects(f.prepare(), {code: 'FILE_UNSAFE'});
    await assert.rejects(f.guarded.withWriteLock(f.paths, async () => assert.fail('a corrupt barrier cannot authorize a writer')), {code: 'FILE_UNSAFE'});
  }
  await writeFile(statePath, original, {mode: 0o600});
  await f.nextProcess();
  await f.guarded.withWriteLock(f.paths, async () => {});
  assert.equal(f.guards.size, 0); await verifyData();
});

test('tampered retained migration sources and an unknown boot session fail closed', {timeout: 20_000}, async t => {
  const f = await fixture(t), verifyData = await f.preserveData();
  f.setBoot('not-a-boot-session');
  await assert.rejects(f.prepare(), {code: 'HELPER_BUSY'});
  f.setBoot(bootA); await assert.rejects(f.prepare(), {code: 'HELPER_BUSY'});
  const saved = join(f.bundledRoot, '.write-lock-upgrade/write-lock.js');
  await writeFile(saved, '// changed retained source', {mode: 0o600});
  await assert.rejects(f.guarded.withWriteLock(f.paths, async () => assert.fail('unverified source must not run')), {code: 'INVALID_CHECKSUM'});
  assert.equal(f.guards.size, 0); await verifyData();
});

test('Linux recovery preserves a synced state publication before rename and reconciles all registered writable roots', {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux');
  await f.registerFreshLayout();
  const statePath = join(f.bundledRoot, '.write-lock-upgrade/state.json');
  const verifyData = await f.preserveData({passive: true});
  await ensurePrivateDirectory(f.paths.stateDir!);
  const published = '{"retained":"published-state"}\n';
  await writeFile(f.paths.state, published, {mode: 0o600});
  f.addProcess({pid: toolPid, started: 'Fri Oct 23 11:50:00 2026', executable: '/opt/private-host/node', unreadableExe: true});
  await assert.rejects(f.prepare(), linuxRefusal);
  const registered = JSON.parse(await readFile(statePath, 'utf8'));
  assert.deepEqual(registered.storage, [{data: f.paths.data, ...await expectedLinuxStorage(f.paths)}]);
  f.setRecoveryEntrypoints(true); await f.recover('seal'); f.setBoot(bootB);
  const sealed = await readFile(statePath, 'utf8');
  assert.deepEqual(JSON.parse(sealed).recovery.seal.inventory.writable, registered.storage[0].roots);
  let entered = 0;
  for (const root of [f.paths.stateDir!, f.paths.config!, f.paths.runtime!, join(f.paths.data, 'cache/builds'),
    join(f.home, '.maddots-ai/claude-code/.claude-plugin')]) {
    await ensurePrivateDirectory(root);
    const temporary = join(root, '.state.json.11111111-1111-4111-8111-111111111111.tmp');
    // Retain the physical crash cut after file sync and before atomic rename.
    const file = await filesystem.open(temporary, 'wx', 0o600);
    try {await file.writeFile('{"retained":"synced-before-rename"}\n'); await file.sync();}
    finally {await file.close();}
    await assert.rejects(f.recover('complete'), linuxRefusal);
    assert.equal(await readFile(statePath, 'utf8'), sealed, 'refusal preserves the sealed barrier without completion');
    assert.equal(await readFile(temporary, 'utf8'), '{"retained":"synced-before-rename"}\n');
    assert.equal(await readFile(f.paths.state, 'utf8'), published); await verifyData();
    await assert.rejects(f.guarded.withWriteLock(f.paths, async () => {entered++;}), linuxRefusal);
    assert.equal(entered, 0);
    await rm(temporary); // Isolated fixture cleanup supplies no production recovery authority.
  }
  await assert.rejects(f.recover('complete'), linuxRefusal, 'the retained marketplace subtree remains an unresolved transaction');
  assert.equal(await readFile(statePath, 'utf8'), sealed);
  // Restore only this isolated fixture's empty child, not production obligations.
  await rmdir(join(f.home, '.maddots-ai/claude-code/.claude-plugin'));
  await f.recover('complete');
  await f.guarded.withWriteLock(f.paths, async () => {entered++;});
  assert.equal(entered, 1);
});

for (const coverage of ['missing', 'partial'] as const) {
test(`Linux revision 2 with ${coverage} historical storage refuses XDG changes before first registration`, {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux', 'protocol-3');
  const directory = join(f.bundledRoot, '.write-lock-upgrade'), statePath = join(directory, 'state.json');
  const previous = JSON.parse(await readFile(statePath, 'utf8'));
  previous.revision = 2; previous.patching = true;
  previous.retirement = {boot: bootA, processes: [{pid: toolPid, started: `linux:${bootA}:1`, executable: '/fixture/old-host'}]};
  assert.equal(previous.storage, undefined, 'the first fixed launch has never registered the legacy layout');
  if (coverage === 'partial') {
    const other = join(f.home, 'recorded-data');
    previous.data.push(other);
    previous.storage = [{data: other, roots: [other], states: [join(other, 'state.json')]}];
  }
  const retained = JSON.stringify(previous) + '\n';
  await writeFile(statePath, retained, {mode: 0o600});
  await ensurePrivateDirectory(f.paths.stateDir!);
  const temporary = join(f.paths.stateDir!, '.state.json.11111111-1111-4111-8111-111111111111.tmp');
  const bytes = '{"retained":"revision-2-synced-before-rename"}\n';
  const file = await filesystem.open(temporary, 'wx', 0o600);
  try {await file.writeFile(bytes); await file.sync();} finally {await file.close();}
  const originals = new Map<string, Buffer>();
  for (const name of Object.keys(previous.sources)) {
    for (const root of [directory, join(f.bundledRoot, 'dist')]) {
      const path = join(root, name); originals.set(path, await readFile(path));
    }
  }
  // Change the actual resolver input before the FIRST fixed prepare, keeping
  // data unchanged. Registering A first would miss the legacy bootstrap hole.
  const changed = await createPaths(readConfig({XDG_STATE_HOME: join(f.home, 'next-state-home')}, f.home, 'linux'));
  assert.equal(changed.data, f.paths.data); assert.notEqual(changed.stateDir, f.paths.stateDir);
  f.addProcess({pid: toolPid, started: 'Fri Oct 23 11:50:00 2026', executable: '/fixture/old-host', unreadableExe: true});
  f.setRecoveryEntrypoints(true);
  for (const boot of [bootA, bootB]) {
    f.setBoot(boot);
    await assert.rejects(f.upgrade.prepareLockUpgrade(f.runtime, changed), linuxSourceRefusal);
    for (const phase of ['seal', 'complete'] as const) {
      await assert.rejects(f.upgrade.recoverLinuxLockUpgrade(f.runtime, changed, phase), linuxSourceRefusal);
    }
    await assert.rejects(f.guarded.withWriteLock(changed, async () => assert.fail('unknown historical roots cannot admit a writer')), linuxSourceRefusal);
    assert.equal(await readFile(statePath, 'utf8'), retained, 'refusal cannot backfill storage, replace barriers or publish proof');
    assert.equal(await readFile(temporary, 'utf8'), bytes, 'the old state-root publication remains intact');
    for (const [path, original] of originals) assert.deepEqual(await readFile(path), original, path);
  }
  assert.deepEqual(f.commands, []); assert.deepEqual(f.linuxCalls, [], 'unknown layout refuses before repair or retirement');
});
}

test('Linux recovery retains prior XDG layouts and refuses unknown or newly selected sealed storage roots', {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux');
  const statePath = join(f.bundledRoot, '.write-lock-upgrade/state.json');
  f.addProcess({pid: toolPid, started: 'Fri Oct 23 11:50:00 2026', executable: '/opt/private-host/node', unreadableExe: true});
  await assert.rejects(f.prepare(), linuxRefusal);
  const changed: HelperPaths = {...f.paths, config: join(f.home, 'next-config'), stateDir: join(f.home, 'next-state'),
    state: join(f.home, 'next-state/state.json'), runtime: join(f.home, 'next-runtime')};
  await assert.rejects(f.upgrade.prepareLockUpgrade(f.runtime, changed), linuxRefusal);
  const registered = JSON.parse(await readFile(statePath, 'utf8'));
  const expected = await expectedLinuxStorage(f.paths);
  const roots = [...new Set([...expected.roots, changed.config!, changed.stateDir!, changed.runtime!])].sort();
  assert.deepEqual(registered.storage, [{data: f.paths.data, roots, states: [...new Set([...expected.states, changed.state])].sort(),
    units: expected.units}]);
  f.setRecoveryEntrypoints(true); await f.recover('seal'); f.setBoot(bootB);
  const sealed = await readFile(statePath, 'utf8');
  const unregistered = {...changed, config: join(f.home, 'unregistered-config')};
  await assert.rejects(f.upgrade.prepareLockUpgrade(f.runtime, unregistered), linuxRefusal);
  await assert.rejects(f.upgrade.recoverLinuxLockUpgrade(f.runtime, unregistered, 'complete'), linuxRefusal);
  const unregisteredState = {...changed, stateDir: f.paths.config!, state: join(f.paths.config!, 'state.json')};
  await assert.rejects(f.upgrade.prepareLockUpgrade(f.runtime, unregisteredState), linuxRefusal);
  await assert.rejects(f.upgrade.recoverLinuxLockUpgrade(f.runtime, unregisteredState, 'complete'), linuxRefusal,
    'matching root sets cannot hide a newly selected unregistered application metadata path');
  assert.equal(await readFile(statePath, 'utf8'), sealed, 'a sealed storage inventory cannot be silently extended');
  const unknown = JSON.parse(sealed);
  unknown.data.push(join(f.home, 'historic-data-with-unknown-XDG'));
  await writeFile(statePath, JSON.stringify(unknown) + '\n', {mode: 0o600});
  await assert.rejects(f.recover('complete'), linuxRefusal, 'historical data cannot imply an unrecorded storage layout');
  await writeFile(statePath, sealed, {mode: 0o600});
  await ensurePrivateDirectory(f.paths.stateDir!);
  const temporary = join(f.paths.stateDir!, '.retained-old-state.tmp');
  await writeFile(temporary, 'old-layout-publication', {mode: 0o600});
  await assert.rejects(f.upgrade.recoverLinuxLockUpgrade(f.runtime, changed, 'complete'), linuxRefusal,
    'the newly selected XDG layout cannot hide an earlier root');
  assert.equal(await readFile(temporary, 'utf8'), 'old-layout-publication');
  assert.equal(await readFile(statePath, 'utf8'), sealed);
});

test('Linux recovery refuses an external custom token publication from historical state without opening token contents', {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux');
  await f.registerFreshLayout();
  const statePath = join(f.bundledRoot, '.write-lock-upgrade/state.json');
  // A directory stands in for the external token file. Recovery must decide
  // from non-secret metadata alone, before opening this selected path.
  const tokenFile = join(f.home, 'external-token.json');
  await ensurePrivateDirectory(tokenFile); await ensurePrivateDirectory(f.paths.stateDir!);
  const metadata = JSON.stringify({format: 1, tokenStorage: 'file', tokenFile}) + '\n';
  await writeFile(f.paths.state, metadata, {mode: 0o600});
  f.addProcess({pid: toolPid, started: 'Fri Oct 23 11:50:00 2026', executable: '/opt/private-host/node', unreadableExe: true});
  await assert.rejects(f.prepare(), linuxRefusal);
  const changed: HelperPaths = {...f.paths, config: join(f.home, 'new-config'), stateDir: join(f.home, 'new-state'),
    state: join(f.home, 'new-state/state.json'), runtime: join(f.home, 'new-runtime-storage')};
  await assert.rejects(f.upgrade.prepareLockUpgrade(f.runtime, changed), linuxRefusal);
  f.setRecoveryEntrypoints(true); await f.recover('seal'); f.setBoot(bootB);
  const sealed = await readFile(statePath, 'utf8');
  assert.deepEqual(JSON.parse(sealed).recovery.seal.inventory.states,
    [...new Set([...(await expectedLinuxStorage(f.paths)).states, changed.state])].sort());
  let tokenOpens = 0, entered = 0;
  f.hooks.beforeOpen = async path => {
    if (path === tokenFile || path.startsWith(tokenFile + '/')) {
      tokenOpens++; assert.fail('recovery must never open selected token contents');
    }
  };
  await assert.rejects(f.upgrade.recoverLinuxLockUpgrade(f.runtime, changed, 'complete'), linuxRefusal);
  assert.equal(tokenOpens, 0);
  assert.equal(await readFile(statePath, 'utf8'), sealed, 'external publication uncertainty preserves the sealed barrier');
  assert.equal(await readFile(f.paths.state, 'utf8'), metadata, 'historical application metadata stays unchanged');
  assert.equal((await lstat(tokenFile)).isDirectory(), true);
  await assert.rejects(f.guarded.withWriteLock(changed, async () => {entered++;}), linuxRefusal);
  assert.equal(entered, 0);
});

for (const phase of ['baseline', 'seal', 'complete', 'cohort'] as const) {
test(`Linux ${phase} refuses a synced coordinator publication without opening or changing retained bytes`, {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux', false);
  await f.prepare();
  await rm(join(f.bundledRoot, 'dist/write-lock-recovery.js'));
  if (phase !== 'baseline') await assert.rejects(f.prepare(), linuxRefusal);
  if (phase === 'complete') {
    f.setRecoveryEntrypoints(true);
    await f.recover('seal');
  }
  const directory = join(f.bundledRoot, '.write-lock-upgrade');
  const temporary = join(directory, '.11111111-1111-4111-8111-111111111111.tmp');
  const bytes = '{"retained":"synced-before-coordinator-rename"}\n';
  const file = await filesystem.open(temporary, 'wx', 0o600);
  try {await file.writeFile(bytes); await file.sync();} finally {await file.close();}
  const before = await lstat(temporary);
  const record = await readFile(join(directory, 'state.json'), 'utf8');
  let opens = 0, entered = 0;
  f.hooks.beforeOpen = async path => {
    if (path === temporary) {opens++; assert.fail('coordinator publication inspection must use metadata and names alone');}
  };
  if (phase === 'seal') f.setRecoveryEntrypoints(true);
  if (phase === 'complete') f.setBoot(bootB);
  if (phase === 'cohort') f.nextIdentity(process.pid);
  await assert.rejects(phase === 'seal' || phase === 'complete' ? f.recover(phase) : f.prepare(), linuxRefusal);
  await assert.rejects(f.guarded.withWriteLock(f.paths, async () => {entered++;}), linuxRefusal);
  assert.equal(entered, 0); assert.equal(opens, 0);
  assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), record, 'uncertain coordinator publication preserves the original barrier');
  f.hooks.beforeOpen = undefined;
  const after = await lstat(temporary);
  assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(await readFile(temporary, 'utf8'), bytes);
});
}

for (const selection of ['default XDG', 'legacy launchd', 'custom XDG'] as const) {
test(`Linux absent coordinator refuses anonymous UUID service publication in ${selection} parent without opening it`, {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux', false);
  const env = {XDG_CONFIG_HOME: join(f.home, 'selected-unit-config')};
  const selected = await createPaths(readConfig(env, f.home, 'linux'));
  const parent = selection === 'default XDG' ? join(f.home, '.config/systemd/user') :
    selection === 'legacy launchd' ? join(f.home, 'Library/LaunchAgents') : dirname(selected.serviceUnit!);
  await ensurePrivateDirectory(parent);
  // Historical atomicWrite used an anonymous sibling, including for units.
  const temporary = join(parent, '.11111111-1111-4111-8111-111111111111.tmp');
  const bytes = '[Service]\nExecStart=/fixture/retained-helper\n';
  const file = await filesystem.open(temporary, 'wx', 0o600);
  try {await file.writeFile(bytes); await file.sync();} finally {await file.close();}
  const before = await lstat(temporary, {bigint: true}), tree = await snapshotTree(f.home);
  let opens = 0;
  f.hooks.beforeOpen = async path => {
    if (path === temporary) {opens++; assert.fail('anonymous service publications must be inspected by names and metadata alone');}
  };
  await assert.rejects(f.upgrade.prepareLockUpgrade(f.runtime, selected), linuxSourceRefusal);
  for (const phase of ['seal', 'complete'] as const) await assert.rejects(
    f.upgrade.recoverLinuxLockUpgrade(f.runtime, selected, phase), linuxSourceRefusal);
  await assert.rejects(lstat(join(f.bundledRoot, '.write-lock-upgrade')), {code: 'ENOENT'});
  assert.equal(opens, 0); assert.deepEqual(await snapshotTree(f.home), tree);
  f.hooks.beforeOpen = undefined;
  const after = await lstat(temporary, {bigint: true});
  for (const key of ['dev', 'ino', 'size', 'mode', 'uid', 'nlink', 'mtimeNs', 'ctimeNs'] as const) assert.equal(after[key], before[key], key);
  assert.equal(await readFile(temporary, 'utf8'), bytes);
  assert.deepEqual(f.commands, []); assert.deepEqual(f.linuxCalls, []);
});
}

for (const phase of ['seal', 'complete'] as const) {
test(`Linux ${phase} retains historical unit paths across XDG changes and refuses their synced UUID publication`, {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux', false);
  const envA = {XDG_CONFIG_HOME: join(f.home, 'unit-config-A')};
  const envB = {XDG_CONFIG_HOME: join(f.home, 'unit-config-B')};
  const old = await createPaths(readConfig(envA, f.home, 'linux'));
  const changed = await createPaths(readConfig(envB, f.home, 'linux'));
  await f.upgrade.prepareLockUpgrade(f.runtime, old);
  f.addProcess({pid: toolPid, started: 'Fri Oct 23 11:50:00 2026', executable: '/fixture/old-host', unreadableExe: true});
  await assert.rejects(f.upgrade.prepareLockUpgrade(f.runtime, changed), linuxRefusal);
  const statePath = join(f.bundledRoot, '.write-lock-upgrade/state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const expectedUnits = [...new Set([...(await expectedLinuxStorage(old, envA)).units,
    ...(await expectedLinuxStorage(changed, envB)).units])].sort();
  assert.deepEqual(state.storage[0].units, expectedUnits);
  assert.ok(state.storage[0].units.includes(old.serviceUnit));
  assert.ok(state.storage[0].units.includes(changed.serviceUnit));
  f.setRecoveryEntrypoints(true);
  if (phase === 'complete') {
    await f.upgrade.recoverLinuxLockUpgrade(f.runtime, changed, 'seal');
    const sealed = JSON.parse(await readFile(statePath, 'utf8'));
    assert.deepEqual(sealed.recovery.seal.inventory.units, expectedUnits, 'the completed seal binds every observed unit parent');
    f.setBoot(bootB);
    const unregistered = {...changed, serviceUnit: join(f.home, 'unregistered-unit/app.maddots.ai.helper.service')};
    await assert.rejects(f.upgrade.prepareLockUpgrade(f.runtime, unregistered), linuxRefusal);
    await assert.rejects(f.upgrade.recoverLinuxLockUpgrade(f.runtime, unregistered, 'complete'), linuxRefusal,
      'equal writable/state roots cannot hide a newly selected unit path');
  }
  await ensurePrivateDirectory(dirname(old.serviceUnit!));
  const temporary = join(dirname(old.serviceUnit!), '.11111111-1111-4111-8111-111111111111.tmp');
  const bytes = '[Service]\nExecStart=/fixture/synced-old-XDG-unit\n';
  const file = await filesystem.open(temporary, 'wx', 0o600);
  try {await file.writeFile(bytes); await file.sync();} finally {await file.close();}
  const before = await lstat(temporary, {bigint: true});
  const record = await readFile(statePath, 'utf8');
  let opens = 0, entered = 0;
  f.hooks.beforeOpen = async path => {
    if (path === temporary) {opens++; assert.fail('recovery must not open retained service publication contents');}
  };
  await assert.rejects(f.upgrade.recoverLinuxLockUpgrade(f.runtime, changed, phase), linuxRefusal);
  await assert.rejects(f.guarded.withWriteLock(changed, async () => {entered++;}), linuxRefusal);
  assert.equal(opens, 0); assert.equal(entered, 0);
  assert.equal(await readFile(statePath, 'utf8'), record, 'unit uncertainty cannot replace the durable barrier or publish proof');
  f.hooks.beforeOpen = undefined;
  const after = await lstat(temporary, {bigint: true});
  for (const key of ['dev', 'ino', 'size', 'mode', 'uid', 'nlink', 'mtimeNs', 'ctimeNs'] as const) assert.equal(after[key], before[key], key);
  assert.equal(await readFile(temporary, 'utf8'), bytes);
});
}

test('Linux unit publication checks leave unrelated files, symlinks and non-UUID temporary names untouched', {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux', false);
  const selected = await createPaths(readConfig({XDG_CONFIG_HOME: join(f.home, 'selected-unit-config')}, f.home, 'linux'));
  const parents = [dirname(selected.serviceUnit!), join(f.home, '.config/systemd/user'), join(f.home, 'Library/LaunchAgents')];
  const unrelated: string[] = [];
  for (const parent of parents) {
    await ensurePrivateDirectory(parent);
    for (const name of ['unrelated.service', '.unrelated.tmp', '.app.maddots.ai.helper.service.retained.tmp']) {
      const path = join(parent, name); await writeFile(path, 'unrelated fixture bytes\n', {mode: 0o600}); unrelated.push(path);
    }
    const link = join(parent, 'unrelated-mask.service'); await symlink('/dev/null', link); unrelated.push(link);
    const nested = join(parent, 'unrelated.service.d'); await ensurePrivateDirectory(nested);
    const path = join(nested, '.11111111-1111-4111-8111-111111111111.tmp');
    await writeFile(path, 'unrelated nested publication\n', {mode: 0o600}); unrelated.push(path);
  }
  const originals = new Map(await Promise.all(parents.map(async parent => [parent, await snapshotTree(parent)] as const)));
  let opens = 0, entered = 0;
  f.hooks.beforeOpen = async path => {
    if (unrelated.includes(path)) {opens++; assert.fail('unit checks cannot open unrelated files or follow unrelated symlinks');}
  };
  await f.upgrade.prepareLockUpgrade(f.runtime, selected);
  await f.guarded.withWriteLock(selected, async () => {entered++;});
  await rm(join(f.bundledRoot, 'dist/write-lock-recovery.js'));
  await assert.rejects(f.upgrade.prepareLockUpgrade(f.runtime, selected), linuxRefusal);
  f.setRecoveryEntrypoints(true);
  await f.upgrade.recoverLinuxLockUpgrade(f.runtime, selected, 'seal');
  f.setBoot(bootB);
  await f.upgrade.recoverLinuxLockUpgrade(f.runtime, selected, 'complete');
  await f.guarded.withWriteLock(selected, async () => {entered++;});
  assert.equal(entered, 2); assert.equal(opens, 0);
  for (const [parent, before] of originals) assert.deepEqual(await snapshotTree(parent), before, parent);
});

test('Linux recorded storage lacking historical unit metadata refuses before current paths can backfill it', {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux', false);
  await f.prepare();
  const statePath = join(f.bundledRoot, '.write-lock-upgrade/state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  delete state.storage[0].units;
  const unknown = JSON.stringify(state) + '\n';
  await writeFile(statePath, unknown, {mode: 0o600});
  const changed = await createPaths(readConfig({XDG_CONFIG_HOME: join(f.home, 'unknown-history-config')}, f.home, 'linux'));
  await assert.rejects(f.upgrade.prepareLockUpgrade(f.runtime, changed), linuxRefusal);
  for (const phase of ['seal', 'complete'] as const) await assert.rejects(
    f.upgrade.recoverLinuxLockUpgrade(f.runtime, changed, phase), linuxRefusal);
  await assert.rejects(f.guarded.withWriteLock(changed, async () => assert.fail('missing unit provenance cannot admit a writer')), linuxRefusal);
  assert.equal(await readFile(statePath, 'utf8'), unknown);
  assert.deepEqual(f.commands, []); assert.deepEqual(f.linuxCalls, []);
});

test('Linux matching preparation and guarded admission refuse a synced unit publication before any action or proof change', {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux', false);
  await f.prepare();
  const statePath = join(f.bundledRoot, '.write-lock-upgrade/state.json');
  const completed = await readFile(statePath, 'utf8');
  assert.equal(JSON.parse(completed).patching, undefined);
  assert.equal(JSON.parse(completed).retirement, undefined);
  await ensurePrivateDirectory(dirname(f.paths.serviceUnit!));
  const temporary = join(dirname(f.paths.serviceUnit!), '.11111111-1111-4111-8111-111111111111.tmp');
  const bytes = '[Service]\nExecStart=/fixture/synced-before-unit-rename\n';
  const file = await filesystem.open(temporary, 'wx', 0o600);
  try {await file.writeFile(bytes); await file.sync();} finally {await file.close();}
  const before = await lstat(temporary, {bigint: true});
  let opens = 0, entered = 0;
  f.hooks.beforeOpen = async path => {
    if (path === temporary) {opens++; assert.fail('matching admission must inspect retained unit publications without opening their contents');}
  };
  await assert.rejects(f.prepare(), linuxRefusal);
  await assert.rejects(f.guarded.withWriteLock(f.paths, async () => {entered++;}), linuxRefusal);
  assert.equal(entered, 0); assert.equal(opens, 0);
  assert.equal(await readFile(statePath, 'utf8'), completed, 'pending publication cannot rewrite a completed matching record');
  f.hooks.beforeOpen = undefined;
  const after = await lstat(temporary, {bigint: true});
  for (const key of ['dev', 'ino', 'size', 'mode', 'uid', 'nlink', 'mtimeNs', 'ctimeNs'] as const) assert.equal(after[key], before[key], key);
  assert.equal(await readFile(temporary, 'utf8'), bytes);
  assert.deepEqual(f.commands, []); assert.deepEqual(f.linuxCalls, []);
});

for (const selection of ['XDG config', 'XDG config empty child', 'XDG data hidden by MADDOTS_AI_HOME', 'XDG state', 'XDG state runtime fallback',
  'XDG runtime', 'MADDOTS_AI_HOME', 'released-version-only data', 'HOME default data', 'HOME default config',
  'HOME default state', 'HOME runtime fallback', 'HOME released data', 'HOME marketplace', 'HOME internal agent folder',
  'HOME default service unit', 'HOME legacy plist', 'state metadata in a recorded root', 'service unit',
  'service UUID publication', 'additional resolver root'] as const) {
test(`Linux coverage extension refuses unattributed ${selection} before coordinator or writer mutation`, {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux', false);
  await f.prepare();
  const changedHome = selection.startsWith('HOME ') ? join(f.home, 'changed-home') : f.home;
  await ensurePrivateDirectory(changedHome);
  const env: NodeJS.ProcessEnv = selection === 'XDG data hidden by MADDOTS_AI_HOME' ?
    {MADDOTS_AI_HOME: f.paths.data, XDG_DATA_HOME: join(f.home, 'changed-data')} :
    selection.startsWith('XDG config') || selection.startsWith('service ') ? {XDG_CONFIG_HOME: join(f.home, 'changed-config')} :
    selection.startsWith('XDG state') ? {XDG_STATE_HOME: join(f.home, 'changed-state')} :
    selection === 'XDG runtime' ? {XDG_RUNTIME_DIR: join(f.home, 'changed-runtime')} :
    selection === 'MADDOTS_AI_HOME' || selection === 'released-version-only data' ? {MADDOTS_AI_HOME: join(f.home, 'changed-override')} : {};
  let changed = await createPaths(readConfig(env, changedHome, 'linux'));
  if (selection === 'state metadata in a recorded root') changed = {...changed,
    stateDir: f.paths.config!, state: join(f.paths.config!, 'state.json')};
  if (selection === 'additional resolver root') changed = {...changed, linuxStorage: {
    roots: [...changed.linuxStorage!.roots, join(f.home, 'extra-resolver-root')], states: changed.linuxStorage!.states,
  }};
  const root = selection.startsWith('XDG config') ? changed.config! :
    selection === 'XDG data hidden by MADDOTS_AI_HOME' ? join(env.XDG_DATA_HOME!, 'maddots-ai') :
    selection === 'XDG state' ? changed.stateDir! :
    selection === 'XDG state runtime fallback' ? join(changed.stateDir!, 'runtime') :
    selection === 'XDG runtime' ? changed.runtime! :
    selection === 'MADDOTS_AI_HOME' || selection === 'released-version-only data' || selection === 'HOME default data' ? changed.data :
    selection === 'HOME default config' ? changed.config! :
    selection === 'HOME default state' ? changed.stateDir! :
    selection === 'HOME runtime fallback' ? join(changed.stateDir!, 'runtime') :
    selection === 'HOME released data' ? join(changedHome, 'Library/Application Support/maddots-ai') :
    selection === 'HOME marketplace' ? join(changedHome, '.maddots-ai') :
    selection === 'HOME internal agent folder' ? join(changedHome, 'MadDots Agents') :
    selection === 'HOME default service unit' ? dirname(changed.serviceUnit!) :
    selection === 'HOME legacy plist' ? join(changedHome, 'Library/LaunchAgents') :
    selection === 'state metadata in a recorded root' ? changed.stateDir! :
    selection.startsWith('service ') ? dirname(changed.serviceUnit!) : join(f.home, 'extra-resolver-root');
  await ensurePrivateDirectory(root);
  const retained = selection === 'state metadata in a recorded root' ? changed.state :
    selection === 'service unit' || selection === 'HOME default service unit' ? changed.serviceUnit! :
    selection === 'HOME legacy plist' ? join(root, 'app.maddots.ai.helper.plist') :
    selection === 'service UUID publication' ? join(root, '.11111111-1111-4111-8111-111111111111.tmp') :
    selection === 'released-version-only data' ? join(root, 'package.json') : join(root, '.retained-publication.tmp');
  if (selection === 'XDG config empty child') await ensurePrivateDirectory(retained);
  else await writeFile(retained, selection === 'released-version-only data' ? '{"version":"0.1.5"}\n' : 'retained-private-publication\n', {mode: 0o600});
  const directory = join(f.bundledRoot, '.write-lock-upgrade');
  // Even a missing guard cannot be recreated by a rejected registration.
  await rm(join(directory, '.guard'));
  const before = await snapshotTree(f.home), record = await readFile(join(directory, 'state.json'), 'utf8');
  let opens = 0;
  f.hooks.beforeOpen = async path => {
    if (path === retained) {opens++; assert.fail('coverage extension must inspect retained names and metadata without opening contents');}
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) f.nextIdentity(process.pid);
    await assert.rejects(f.upgrade.prepareLockUpgrade(f.runtime, changed), linuxSourceRefusal);
    await assert.rejects(f.guarded.withWriteLock(changed, async () => assert.fail('unattributed coverage cannot admit a writer')), linuxSourceRefusal);
    if (selection === 'MADDOTS_AI_HOME') {
      const nested = {...changed, data: join(changed.data, 'updates'), lock: join(changed.data, 'updates/.lock')};
      await assert.rejects(f.guarded.withWriteLock(nested, async () => assert.fail('nested updater registration cannot attribute retained data')), linuxSourceRefusal);
    }
    for (const phase of ['seal', 'complete'] as const) await assert.rejects(
      f.upgrade.recoverLinuxLockUpgrade(f.runtime, changed, phase), linuxRefusal);
    assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), record);
    assert.deepEqual(await snapshotTree(f.home), before, 'retries and fresh callers preserve every coordinator, module and retained inode');
  }
  assert.equal(opens, 0); assert.deepEqual(f.commands, []); assert.deepEqual(f.linuxCalls, []);
});
}

test('Linux coordinator refuses an unrecognized regular journal without opening or mutating it', {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux', false);
  await f.prepare();
  const directory = join(f.bundledRoot, '.write-lock-upgrade');
  const retained = join(directory, 'unresolved-journal.json');
  await writeFile(retained, '{"pending":true}\n', {mode: 0o600});
  await rm(join(directory, '.guard'));
  const before = await snapshotTree(f.home);
  let opens = 0;
  f.hooks.beforeOpen = async path => {
    if (path === retained) {opens++; assert.fail('unknown coordinator records must refuse by name without opening their contents');}
  };
  await assert.rejects(f.prepare(), linuxRefusal);
  await assert.rejects(f.guarded.withWriteLock(f.paths, async () => assert.fail('unknown coordinator journals cannot admit a writer')), linuxRefusal);
  for (const phase of ['seal', 'complete'] as const) await assert.rejects(f.recover(phase), linuxRefusal);
  assert.deepEqual(await snapshotTree(f.home), before);
  assert.equal(opens, 0); assert.deepEqual(f.commands, []); assert.deepEqual(f.linuxCalls, []);
});

for (const child of ['data', 'config/maddots-ai', 'state/maddots-ai', 'runs', 'home/.maddots-ai', 'runtime',
  'config systemd unit', 'home systemd unit', 'home legacy plist'] as const) {
test(`Linux coverage extension refuses newly discovered fixed service ${child} without mutation`, {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux', false);
  const prefix = child === 'runtime' ? '/run/mdai-helper' : '/var/lib/mdai';
  const mapped = join(f.home, 'fixed-service-after-install');
  const originalLstat = filesystem.lstat, originalOpendir = filesystem.opendir;
  let available = false;
  const remap = (path: unknown) => {
    const name = String(path);
    if (name === prefix || name.startsWith(prefix + '/')) {
      if (!available) throw errno('ENOENT');
      return mapped + name.slice(prefix.length);
    }
    return path;
  };
  filesystem.lstat = ((...args: Parameters<typeof originalLstat>) => originalLstat(remap(args[0]) as string, args[1])) as typeof originalLstat;
  filesystem.opendir = ((...args: Parameters<typeof originalOpendir>) => originalOpendir(remap(args[0]) as string, args[1])) as typeof originalOpendir;
  syncBuiltinESMExports();
  try {
    await f.prepare();
    const target = child === 'runtime' ? 'mdai' : child;
    const retained = child === 'config systemd unit' ? join(mapped, 'config/systemd/user/app.maddots.ai.helper.service') :
      child === 'home systemd unit' ? join(mapped, 'home/.config/systemd/user/app.maddots.ai.helper.service') :
      child === 'home legacy plist' ? join(mapped, 'home/Library/LaunchAgents/app.maddots.ai.helper.plist') :
      join(mapped, target, child === 'runs' ? `.namespace-${'a'.repeat(64)}.json.complete` : '.retained-publication.tmp');
    await ensurePrivateDirectory(dirname(retained)); await writeFile(retained, 'retained-service-publication\n', {mode: 0o600});
    available = true;
    const before = await snapshotTree(f.home);
    let opens = 0;
    f.hooks.beforeOpen = async path => {
      if (path === prefix || path.startsWith(prefix + '/')) {opens++; assert.fail('new service roots cannot open retained contents');}
    };
    await assert.rejects(f.prepare(), linuxSourceRefusal);
    await assert.rejects(f.guarded.withWriteLock(f.paths, async () => assert.fail('new service coverage cannot admit a writer')), linuxSourceRefusal);
    assert.deepEqual(await snapshotTree(f.home), before);
    assert.equal(opens, 0); assert.deepEqual(f.commands, []); assert.deepEqual(f.linuxCalls, []);
  } finally {
    filesystem.lstat = originalLstat; filesystem.opendir = originalOpendir; syncBuiltinESMExports();
  }
});
}

test('Linux coverage extension rechecks a new root after coordinator guard acquisition before registration', {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux', false);
  await f.prepare();
  const changed = await createPaths(readConfig({XDG_CONFIG_HOME: join(f.home, 'raced-config')}, f.home, 'linux'));
  await ensurePrivateDirectory(changed.config!);
  const directory = join(f.bundledRoot, '.write-lock-upgrade');
  const retained = join(changed.config!, '.published-after-preflight.tmp');
  const record = await readFile(join(directory, 'state.json'), 'utf8');
  let before: Record<string, unknown> | undefined;
  f.hooks.beforeOpen = async path => {
    if (path === join(directory, '.guard') && !before) {
      await writeFile(retained, 'raced-private-publication\n', {mode: 0o600});
      before = await snapshotTree(f.home);
    }
    if (path === retained) assert.fail('the second coverage check cannot open retained contents');
  };
  await assert.rejects(f.upgrade.prepareLockUpgrade(f.runtime, changed), linuxSourceRefusal);
  assert.ok(before, 'the root was empty during preflight and populated only before guard acquisition');
  assert.deepEqual(await snapshotTree(f.home), before);
  assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), record);
  assert.deepEqual(f.commands, []); assert.deepEqual(f.linuxCalls, []);
});

test('Linux coverage extension accepts empty new override roots and retains their attribution across callers', {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux', false);
  await f.prepare();
  const env = {MADDOTS_AI_HOME: join(f.home, 'new-empty-override'), XDG_DATA_HOME: join(f.home, 'new-empty-data'),
    XDG_CONFIG_HOME: join(f.home, 'new-empty-config'), XDG_STATE_HOME: join(f.home, 'new-empty-state'),
    XDG_RUNTIME_DIR: join(f.home, 'new-empty-runtime')};
  const changed = await createPaths(readConfig(env, f.home, 'linux'));
  const known = await expectedLinuxStorage(f.paths), selected = await expectedLinuxStorage(changed, env);
  const added = selected.roots.filter(root => !known.roots.includes(root));
  for (const root of added.filter(root => !added.some(parent => parent !== root && root.startsWith(parent + '/')))) await ensurePrivateDirectory(root);
  await assert.rejects(f.upgrade.prepareLockUpgrade(f.runtime, changed), linuxRefusal, 'a valid new layout still requires the existing writer cohort barrier');
  const statePath = join(f.bundledRoot, '.write-lock-upgrade/state.json');
  const registered = JSON.parse(await readFile(statePath, 'utf8'));
  assert.ok(registered.data.includes(changed.data));
  assert.deepEqual(registered.storage.find((layout: {data: string}) => layout.data === changed.data), {data: changed.data, ...selected});
  f.nextIdentity(process.pid);
  await f.upgrade.prepareLockUpgrade(f.runtime, changed);
  await f.guarded.withWriteLock(changed, async () => {});
  // This revision's durable registration now attributes ordinary retained data.
  await writeFile(join(changed.config!, 'retained-after-registration.json'), '{}\n', {mode: 0o600});
  f.nextIdentity(process.pid);
  await f.upgrade.prepareLockUpgrade(f.runtime, changed);
  await f.guarded.withWriteLock({...changed, data: join(changed.data, 'updates'), lock: join(changed.data, 'updates/.lock')}, async () => {});
  const completed = JSON.parse(await readFile(statePath, 'utf8'));
  assert.ok(completed.recovery.completion); assert.equal(completed.data.includes(join(changed.data, 'updates')), false);
  assert.deepEqual(completed.storage, registered.storage);
});

test('Linux a registered data root cannot stand in for a newly observed HOME boundary', {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux', false);
  const secondHome = join(f.home, 'second-home');
  await ensurePrivateDirectory(secondHome);
  const initial = await createPaths(readConfig({MADDOTS_AI_HOME: join(secondHome, '.maddots-ai')}, f.home, 'linux'));
  await f.upgrade.prepareLockUpgrade(f.runtime, initial);
  const statePath = join(f.bundledRoot, '.write-lock-upgrade/state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.deepEqual(state.homes, [f.home]);
  assert.ok(state.storage[0].roots.includes(join(secondHome, '.maddots-ai')));
  const changed = await createPaths(readConfig({}, secondHome, 'linux'));
  const retained = join(secondHome, 'MadDots Agents/other-agent/retained.json');
  await ensurePrivateDirectory(dirname(retained));
  await writeFile(retained, '{"anotherInstallation":true}\n', {mode: 0o600});
  await rm(join(dirname(statePath), '.guard'));
  const before = await snapshotTree(f.home);
  f.hooks.beforeOpen = async path => {
    if (path === retained) assert.fail('a new HOME must refuse without reading its agent contents');
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) f.nextIdentity(process.pid);
    await assert.rejects(f.upgrade.prepareLockUpgrade(f.runtime, changed), linuxSourceRefusal);
    await assert.rejects(f.guarded.withWriteLock(changed, async () => assert.fail('data provenance cannot authorize HOME')), linuxSourceRefusal);
    const {linuxStorage: _linuxStorage, ...legacy} = changed;
    await assert.rejects(f.guarded.withWriteLock(legacy, async () => assert.fail('retained resolvers cannot infer HOME')), linuxRefusal);
    for (const phase of ['seal', 'complete'] as const) await assert.rejects(
      f.upgrade.recoverLinuxLockUpgrade(f.runtime, changed, phase), linuxRefusal);
    assert.deepEqual(await snapshotTree(f.home), before);
  }
  assert.deepEqual(f.commands, []); assert.deepEqual(f.linuxCalls, []);
});

test('Linux HOME registration repeats its independent boundary check under coordinator ownership', {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux', false);
  const secondHome = join(f.home, 'second-home');
  await ensurePrivateDirectory(secondHome);
  const initial = await createPaths(readConfig({MADDOTS_AI_HOME: join(secondHome, '.maddots-ai')}, f.home, 'linux'));
  await f.upgrade.prepareLockUpgrade(f.runtime, initial);
  const changed = await createPaths(readConfig({}, secondHome, 'linux'));
  const directory = join(f.bundledRoot, '.write-lock-upgrade');
  const record = await readFile(join(directory, 'state.json'), 'utf8');
  let before: Record<string, unknown> | undefined;
  f.hooks.beforeOpen = async path => {
    if (path === join(directory, '.guard') && !before) {
      await ensurePrivateDirectory(join(secondHome, 'MadDots Agents'));
      before = await snapshotTree(f.home);
    }
  };
  await assert.rejects(f.upgrade.prepareLockUpgrade(f.runtime, changed), linuxSourceRefusal);
  assert.ok(before);
  assert.deepEqual(await snapshotTree(f.home), before);
  assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), record);
});

test('Linux an empty new HOME is recorded independently and matching callers retain that provenance', {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux', false);
  const secondHome = join(f.home, 'second-home');
  await ensurePrivateDirectory(secondHome);
  const initial = await createPaths(readConfig({MADDOTS_AI_HOME: join(secondHome, '.maddots-ai')}, f.home, 'linux'));
  await f.upgrade.prepareLockUpgrade(f.runtime, initial);
  const changed = await createPaths(readConfig({}, secondHome, 'linux'));
  await assert.rejects(f.upgrade.prepareLockUpgrade(f.runtime, changed), linuxRefusal);
  const statePath = join(f.bundledRoot, '.write-lock-upgrade/state.json');
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')).homes, [f.home, secondHome].sort());
  f.nextIdentity(process.pid);
  await f.upgrade.prepareLockUpgrade(f.runtime, changed);
  await ensurePrivateDirectory(join(secondHome, 'MadDots Agents'));
  await f.upgrade.prepareLockUpgrade(f.runtime, changed);
  const {linuxStorage: _linuxStorage, ...legacy} = changed;
  await f.guarded.withWriteLock(legacy, async () => {});
  await f.upgrade.prepareLockUpgrade(f.runtime, initial);
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')).homes, [f.home, secondHome].sort());
});

test('Linux a record without explicit HOME provenance cannot backfill it from recorded data', {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux', false);
  await f.prepare();
  const statePath = join(f.bundledRoot, '.write-lock-upgrade/state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  for (const homes of [undefined, [], [f.home, f.home], ['relative-home']]) {
    await writeFile(statePath, JSON.stringify({...state, homes}) + '\n', {mode: 0o600});
    const before = await snapshotTree(f.home);
    await assert.rejects(f.prepare(), linuxSourceRefusal);
    await assert.rejects(f.guarded.withWriteLock(f.paths, async () => assert.fail('missing HOME provenance refuses')), linuxSourceRefusal);
    for (const phase of ['seal', 'complete'] as const) await assert.rejects(f.recover(phase), linuxSourceRefusal);
    assert.deepEqual(await snapshotTree(f.home), before);
  }
});

test('Linux retained storage initialization refuses unregistered roots before sync or CLI can create children', {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux', false);
  await f.prepare();
  const installed = join(f.bundledRoot, 'dist/paths.js');
  // Model an already lock-retrofitted retained initializer. Its existing lock
  // export must not make maintain skip the missing pre-creation admission.
  const current = await readFile(installed, 'utf8');
  const old = current.replace('    await assertLockUpgradeReady(paths);\n', '');
  assert.notEqual(old, current);
  await writeFile(installed, old, {mode: 0o600});
  await assert.rejects(f.prepare(), linuxRefusal);
  await f.nextProcess();
  const repaired = await f.load<Pick<typeof import('../src/paths.js'), 'ensurePaths'>>(f.bundledRoot, 'paths');
  const changed = await createPaths(readConfig({MADDOTS_AI_HOME: join(f.home, 'sync-new-data')}, f.home, 'linux'));
  const {linuxStorage: _linuxStorage, ...legacy} = changed;
  const before = await snapshotTree(f.home);
  await assert.rejects(repaired.ensurePaths(legacy), linuxRefusal);
  assert.deepEqual(await snapshotTree(f.home), before);
  await assert.rejects(lstat(changed.data), {code: 'ENOENT'});
  await assert.rejects(f.upgrade.prepareLockUpgrade(f.runtime, changed), linuxRefusal);
  const statePath = join(f.bundledRoot, '.write-lock-upgrade/state.json');
  assert.ok(JSON.parse(await readFile(statePath, 'utf8')).data.includes(changed.data), 'the refused initializer did not poison later full registration');
  f.nextIdentity(process.pid);
  await f.upgrade.prepareLockUpgrade(f.runtime, changed);
  await repaired.ensurePaths(changed);
  assert.equal((await lstat(changed.logs)).isDirectory(), true);
});

test('Linux both released marketplace and agent module entrypoints refuse before early publications', {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux', false);
  await f.prepare();
  const retained = JSON.parse(await readFile(new URL('./fixtures/released-writer-modules.json', import.meta.url), 'utf8')) as {
    sources: {version: string; commit: string; modules: Record<string, string>}[]; modules: Record<string, string>;
  };
  assert.deepEqual(retained.sources.map(row => row.commit), ['ef85906359fd9e9d71634477a6c531666670289b', 'b2f65cbb66510aad074332b3108a24f5af772f1a']);
  // These two complete modules are byte-identical at both supported pins.
  // Install their real code and preserve its source digest before repair.
  for (const name of ['delivery/claude-plugin', 'runner/agents-local']) {
    const key = retained.sources[0].modules[name];
    assert.equal(retained.sources[1].modules[name], key);
    const text = retained.modules[key];
    assert.equal(createHash('sha256').update(text).digest('hex'), key);
    const output = transpileModule(text, {fileName: name + '.ts', compilerOptions: {target: ScriptTarget.ES2022, module: ModuleKind.ESNext}}).outputText;
    assert.doesNotMatch(output, /assertLockUpgradeReady\(this.paths\)|await assertLinuxWriterAdmission/u);
    await ensurePrivateDirectory(dirname(join(f.bundledRoot, 'dist', name + '.js')));
    await writeFile(join(f.bundledRoot, 'dist', name + '.js'), output, {mode: 0o600});
  }
  await assert.rejects(f.prepare(), linuxRefusal);
  await f.nextProcess();
  const pluginModule = await f.load<typeof import('../src/delivery/claude-plugin.js')>(f.bundledRoot, 'delivery/claude-plugin');
  const agentModule = await f.load<typeof import('../src/runner/agents-local.js')>(f.bundledRoot, 'runner/agents-local');
  const changed = await createPaths(readConfig({MADDOTS_AI_HOME: join(f.home, 'caller-new-data')}, f.home, 'linux'));
  await ensurePrivateDirectory(changed.data);
  const {linuxStorage: _linuxStorage, ...legacy} = changed;
  let probes = 0, prompts = 0;
  const plugin = new pluginModule.ClaudePluginDeliveryTarget({paths: legacy, helperId: 'helper-test', platform: 'linux',
    env: {}, runner: async () => {probes++; return {stdout: '', stderr: ''};}});
  const engine = new pluginModule.ClaudePluginSyncEngine({paths: legacy, helperId: 'helper-test', client: {} as never, targets: []}, plugin);
  const before = await snapshotTree(f.home);
  for (const action of [() => plugin.root(), () => engine.applyPlan({planRevision: 'retained', degraded: false,
    pollAfterSeconds: 60, items: [], revoked: [], instructions: []}), () => new agentModule.LocalAgents(legacy).setup(
    {agentId: '11111111-1111-4111-8111-111111111111', aiToolId: '22222222-2222-4222-8222-222222222222', handle: 'assistant'},
    {isTTY: true, prompt: async () => {prompts++; return '';}, output() {}, adapter: {} as never, bin: '/usr/bin/true', model: 'fixture'})]) {
    await assert.rejects(action(), linuxRefusal);
    assert.deepEqual(await snapshotTree(f.home), before, 'refused retained caller preserves every storage and coordinator inode/byte');
  }
  assert.equal(probes, 0); assert.equal(prompts, 0);
  await assert.rejects(lstat(join(f.home, 'MadDots Agents')), {code: 'ENOENT'});
  await assert.rejects(lstat(join(f.home, '.maddots-ai/claude-code')), {code: 'ENOENT'});
  await assert.rejects(lstat(join(changed.data, 'claude-plugin-waiting.json')), {code: 'ENOENT'});
});

for (const released of [false, true]) test(`Linux ${released ? 'released' : 'current'} agents-folder inventory refuses an unregistered HOME before creating skills`, {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux', false);
  await f.prepare();
  await installWriterModules(f, ['delivery/agents-folder'], released);
  if (released) await assert.rejects(f.prepare(), linuxRefusal);
  await f.nextProcess();
  const module = await f.load<typeof import('../src/delivery/agents-folder.js')>(f.bundledRoot, 'delivery/agents-folder');
  const {SyncEngine} = await import('../src/sync.js');
  const home = join(f.home, 'unregistered-home');
  await ensurePrivateDirectory(home);
  const changed = await createPaths(readConfig({MADDOTS_AI_HOME: f.paths.data}, home, 'linux'));
  await ensurePrivateDirectory(join(home, 'MadDots Agents'));
  await rm(join(f.bundledRoot, '.write-lock-upgrade/.guard'));
  f.commands.length = 0; f.linuxCalls.length = 0;
  const before = await snapshotTree(f.home);
  const layouts: HelperPaths[] = [changed, (({linuxStorage: _linuxStorage, ...legacy}) => legacy)(changed)];
  for (const paths of layouts) {
    const target = new module.AgentsFolderDeliveryTarget(paths);
    const engine = new SyncEngine({paths, helperId: 'helper-test', client: {} as never, targets: [target]});
    await assert.rejects(target.root(), paths.linuxStorage ? linuxSourceRefusal : linuxRefusal);
    await assert.rejects(engine.inventory(), {code: linuxRefusal.code});
    assert.deepEqual(await snapshotTree(f.home), before);
    await assert.rejects(lstat(join(home, '.agents')), {code: 'ENOENT'});
  }
  assert.deepEqual(f.commands, []); assert.deepEqual(f.linuxCalls, []);
});

test('Linux released activation entrypoints refuse before runner mkdir, including an earlier v1 repair', {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux', false);
  await f.prepare();
  await installWriterModules(f, ['runner/runs-on'], true);
  const path = join(f.bundledRoot, 'dist/runner/runs-on.js');
  let old = await readFile(path, 'utf8');
  old = '// maddots-linux-writer-admission: 1\n' +
    'import { assertLockUpgradeReady as assertLinuxWriterAdmission } from "../write-lock-upgrade.js";\n' +
    old.replace('    async init() {\n', '    async init() {\n        await assertLinuxWriterAdmission(this.options.paths);\n');
  await writeFile(path, old, {mode: 0o600});
  await assert.rejects(f.prepare(), linuxRefusal);
  await f.nextProcess();
  const repaired = await readFile(path, 'utf8');
  assert.ok(repaired.startsWith('// maddots-linux-writer-admission: 2\n'));
  assert.equal(repaired.match(/import \{ assertLockUpgradeReady as assertLinuxWriterAdmission \}/g)?.length, 1);
  const {RunsOnController} = await f.load<typeof import('../src/runner/runs-on.js')>(f.bundledRoot, 'runner/runs-on');
  const changed = await createPaths(readConfig({MADDOTS_AI_HOME: join(f.home, 'activation-new-data')}, f.home, 'linux'));
  const {linuxStorage: _linuxStorage, ...legacy} = changed;
  const id = '11111111-1111-4111-8111-111111111111';
  let probes = 0;
  const controller = new RunsOnController({paths: legacy, keys: {} as never, protocol: () => {probes++; throw new Error('unexpected protocol');},
    connection: async () => {probes++; return undefined;}, test: async () => {probes++; throw new Error('unexpected test');}});
  const before = await snapshotTree(f.home);
  for (const action of [() => controller.forget(id, null), () => controller.testConnection(id)]) {
    await assert.rejects(action(), {code: linuxRefusal.code});
    assert.deepEqual(await snapshotTree(f.home), before);
    await assert.rejects(lstat(changed.data), {code: 'ENOENT'});
  }
  assert.equal(probes, 0);
  // The denied call left the new data root genuinely empty and registerable.
  await assert.rejects(f.upgrade.prepareLockUpgrade(f.runtime, changed), linuxRefusal);
  f.nextIdentity(process.pid);
  await f.upgrade.prepareLockUpgrade(f.runtime, changed);
  await controller.forget(id, null);
  assert.equal((await lstat(join(changed.data, 'runner'))).isDirectory(), true);
  await controller.close();
});

test('Linux released fence, notification and token entrypoints refuse before publishing into an unregistered layout', {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux', false);
  await f.prepare();
  await installWriterModules(f, ['agent-fence', 'notify', 'secret-store'], true);
  await assert.rejects(f.prepare(), linuxRefusal);
  await f.nextProcess();
  const notify = await f.load<typeof import('../src/notify.js')>(f.bundledRoot, 'notify');
  const {withAgentDestinationLocks} = await f.load<typeof import('../src/agent-fence.js')>(f.bundledRoot, 'agent-fence');
  const {FileSecretStore} = await f.load<typeof import('../src/secret-store.js')>(f.bundledRoot, 'secret-store');
  const changed = await createPaths(readConfig({MADDOTS_AI_HOME: join(f.home, 'notify-new-data')}, f.home, 'linux'));
  const {linuxStorage: _linuxStorage, ...legacy} = changed;
  const waiting = [{skillId: 'fixture-skill', version: 1, digests: ['a'.repeat(64)]}];
  const token = join(f.home, 'unregistered-credentials/token.json');
  const admittedPaths = {...f.paths};
  const store = await FileSecretStore.open(join(f.paths.config!, 'credentials.json'), admittedPaths, {explicit: true, confirmed: true});
  // Exercise values through a store opened before its caller switches layout.
  // Both later mutation methods must recheck the retained instance's paths.
  Object.assign(admittedPaths, legacy); delete admittedPaths.linuxStorage;
  const before = await snapshotTree(f.home);
  for (const action of [() => withAgentDestinationLocks(legacy, [{agentId: 'fixture-agent', skillId: 'fixture-skill', target: 'folder', name: 'fixture'}],
    async () => assert.fail('a refused fence cannot enter its action')),
    () => notify.reserveWaitingDialog(legacy, waiting),
    () => notify.interruptWaitingDialog(legacy, {count: 1, command: '/unused', fingerprint: 'a'.repeat(64), reservedAt: 1}),
    () => FileSecretStore.open(token, legacy, {explicit: true, confirmed: true}),
    () => store.set('skills-token', 'synthetic-fixture-token'), () => store.delete('skills-token')]) {
    await assert.rejects(action(), {code: linuxRefusal.code});
    assert.deepEqual(await snapshotTree(f.home), before);
    await assert.rejects(lstat(changed.data), {code: 'ENOENT'});
  }
  assert.equal(await notify.reserveWaitingDialog(legacy, []), 'empty');
  assert.deepEqual(await snapshotTree(f.home), before);
});

for (const platform of ['linux', 'darwin'] as const) test(`${platform} admitted agents-folder creation works on fresh and matching layouts`, {
  timeout: 20_000, skip: platform === 'linux' && process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, platform, false);
  await installWriterModules(f, ['delivery/agents-folder'], false);
  await f.prepare();
  const {AgentsFolderDeliveryTarget} = await f.load<typeof import('../src/delivery/agents-folder.js')>(f.bundledRoot, 'delivery/agents-folder');
  const target = new AgentsFolderDeliveryTarget(f.paths);
  assert.equal(await target.root(), join(f.home, '.agents/skills'));
  const root = await lstat(join(f.home, '.agents/skills'));
  await f.prepare();
  assert.equal(await target.root(), join(f.home, '.agents/skills'));
  assert.equal((await lstat(join(f.home, '.agents/skills'))).ino, root.ino);
  assert.deepEqual(f.commands, []);
});

test('Linux selected credential directories require their own storage provenance before any publication', {
  timeout: 20_000, skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t, 'linux', false);
  await f.prepare();
  const selected = {...f.paths, credentialFile: join(f.home, 'selected-credentials/token.json')};
  const {linuxStorage: _linuxStorage, ...legacy} = selected;
  await rm(join(f.bundledRoot, '.write-lock-upgrade/.guard'));
  const before = await snapshotTree(f.home);
  await assert.rejects(f.guarded.withWriteLock(legacy, async () => assert.fail('legacy coverage cannot infer credential storage')), linuxRefusal);
  for (const paths of [{...selected, credentialFile: 'relative'}, {...legacy, credentialFile: 'relative'}]) {
    await assert.rejects(f.guarded.withWriteLock(paths, async () => assert.fail('relative credential selection refuses')), linuxRefusal);
  }
  assert.deepEqual(await snapshotTree(f.home), before);
  const retained = {...f.paths, credentialFile: join(f.home, 'retained-credentials/token.json')};
  await ensurePrivateDirectory(dirname(retained.credentialFile));
  await writeFile(join(dirname(retained.credentialFile), 'unattributed.bin'), 'private retained fixture\n', {mode: 0o600});
  const retainedBefore = await snapshotTree(f.home);
  await assert.rejects(f.upgrade.prepareLockUpgrade(f.runtime, retained), linuxSourceRefusal);
  await assert.rejects(f.guarded.withWriteLock(retained, async () => assert.fail('unknown credential bytes refuse')), linuxSourceRefusal);
  assert.deepEqual(await snapshotTree(f.home), retainedBefore);
  await assert.rejects(f.upgrade.prepareLockUpgrade(f.runtime, selected), linuxRefusal);
  f.nextIdentity(process.pid);
  await f.upgrade.prepareLockUpgrade(f.runtime, selected);
  await f.guarded.withWriteLock(legacy, async () => {});
  const state = JSON.parse(await readFile(join(f.bundledRoot, '.write-lock-upgrade/state.json'), 'utf8'));
  assert.ok(state.storage.find((layout: {data: string; roots: string[]}) => layout.data === selected.data).roots.includes(dirname(selected.credentialFile)));
  await assert.rejects(lstat(dirname(selected.credentialFile)), {code: 'ENOENT'});
});

test('win32 installed CLI refuses folder and activation work before admission or storage writes', {timeout: 20_000}, async t => {
  const f = await fixture(t, 'darwin', false);
  await f.prepare();
  const cli = await f.load<Cli>(f.modernRoot, 'cli');
  const before = await snapshotTree(f.home);
  let effects = 0;
  const options: CliOptions = {platform: 'win32', home: join(f.home, 'unsupported-home'), env: {}, runtime: f.runtime,
    prepareLocks: async () => {effects++; throw new Error('unsupported platforms cannot reach admission');},
    runner: async () => {effects++; throw new Error('unsupported platforms cannot run commands');},
    request: async () => {effects++; throw new Error('unsupported platforms cannot request credentials');}, output() {}};
  for (const [argv, code] of [[['status'], 'PLATFORM_UNSUPPORTED'], [['runs', 'status'], 'RUNS_PLATFORM_UNSUPPORTED'],
    [['agent', 'setup'], 'RUNS_PLATFORM_UNSUPPORTED']] as const) {
    await assert.rejects(cli.runCli([...argv], options), {code});
    assert.deepEqual(await snapshotTree(f.home), before);
  }
  assert.equal(effects, 0);
});

test('installed Darwin folder, fence, notification and file-token entrypoints retain their behavior without a coordinator sidecar', {
  timeout: 20_000,
}, async t => {
  const f = await fixture(t, 'darwin', false);
  await installWriterModules(f, ['delivery/agents-folder', 'agent-fence', 'notify', 'secret-store'], false);
  const identity = await f.load<typeof import('../src/release-identity.js')>(f.bundledRoot, 'release-identity');
  assert.ok(identity.RELEASE_IDENTITY, 'this is an installed release, so an unconditional admission would fail');
  const {AgentsFolderDeliveryTarget} = await f.load<typeof import('../src/delivery/agents-folder.js')>(f.bundledRoot, 'delivery/agents-folder');
  assert.equal(await new AgentsFolderDeliveryTarget(f.paths).root(), join(f.home, '.agents/skills'));
  const {withAgentDestinationLocks} = await f.load<typeof import('../src/agent-fence.js')>(f.bundledRoot, 'agent-fence');
  let entered = false;
  await withAgentDestinationLocks(f.paths, [], async () => {entered = true;});
  assert.equal(entered, true);
  await assert.rejects(lstat(join(f.paths.data, 'agent-fences')), {code: 'ENOENT'});
  const notify = await f.load<typeof import('../src/notify.js')>(f.bundledRoot, 'notify');
  const pending = await notify.reserveWaitingDialog(f.paths, [{skillId: 'darwin-fixture', version: 1, digests: ['a'.repeat(64)]}], {
    platform: 'darwin', env: {}, execPath: process.execPath, entrypoint: f.runtime.bootstrapEntrypoint,
  });
  assert.equal(typeof pending, 'object');
  if (typeof pending === 'string') assert.fail('the Darwin notification was not reserved');
  await notify.interruptWaitingDialog(f.paths, pending);
  assert.equal(JSON.parse(await readFile(join(f.paths.data, 'notification-state.json'), 'utf8')).interruptedSet, pending.fingerprint);
  const {FileSecretStore} = await f.load<typeof import('../src/secret-store.js')>(f.bundledRoot, 'secret-store');
  const store = await FileSecretStore.open(join(f.home, 'darwin-private/token.json'), f.paths, {explicit: true, confirmed: true});
  await store.set('skills-token', 'synthetic-darwin-fixture');
  assert.equal(await store.get('skills-token'), 'synthetic-darwin-fixture');
  await store.delete('skills-token');
  await assert.rejects(lstat(store.path), {code: 'ENOENT'});
  await assert.rejects(lstat(join(f.bundledRoot, 'dist/.write-lock-upgrade.json')), {code: 'ENOENT'});
  await assert.rejects(lstat(join(f.bundledRoot, '.write-lock-upgrade')), {code: 'ENOENT'});
  assert.deepEqual(f.commands, []); assert.deepEqual(f.linuxCalls, []);
});
