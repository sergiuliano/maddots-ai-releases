import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, copyFile, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { clock, readConfig, type Timing } from '../src/config.js';
import { createPaths, type HelperPaths } from '../src/paths.js';
import { acquireWriteGuard } from '../src/write-lock.js';
import { assertSystemRuntime, assertSystemRuntimeReady, prepareSystemRuntime, systemRuntimeMode, type SystemRuntimePolicy } from '../src/system-runtime.js';
import { assertSystemInvocation, inspectSystemInstallation } from '../src/system-runtime-preflight.js';

const linux = process.platform === 'linux' && process.getuid?.() !== 0;
const emittedGraph = ['cli', 'cli-main', 'cli-validation', 'config', 'platform', 'release-identity', 'runtime', 'system-runtime', 'system-runtime-operation', 'system-runtime-preflight', 'paths',
  'write-lock', 'write-lock-upgrade', 'write-lock-retirement', 'write-lock-recovery'];
async function fixtureDirectoryModes(path: string, mode: number): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory()) return;
  await chmod(path, mode);
  for (const name of await readdir(path)) await fixtureDirectoryModes(join(path, name), mode);
}
async function inventory(root: string): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  async function visit(path: string): Promise<void> {
    const info = await lstat(path, {bigint: true});
    result[path] = {dev: String(info.dev), ino: String(info.ino), mode: String(info.mode), uid: String(info.uid),
      mtime: String(info.mtimeNs), ctime: String(info.ctimeNs), ...(info.isFile() ? {bytes: await readFile(path, 'base64')} : {})};
    if (info.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(join(path, name));
  }
  await visit(root); return result;
}
async function fixture(t: TestContext) {
  const base = await mkdtemp(join(await realpath(tmpdir()), 'mdai-fixed-runtime-'));
  const root = join(base, 'package'), home = join(base, 'home'), data = join(base, 'data');
  const policy: SystemRuntimePolicy = {root, home, data, config: join(base, 'config/maddots-ai'), state: join(base, 'state/maddots-ai'),
    runtime: join(base, 'runtime/mdai'), uid: process.getuid!(), username: userInfo().username, ownerUid: process.getuid!()};
  await mkdir(join(root, 'dist'), {recursive: true, mode: 0o700});
  await mkdir(home, {mode: 0o700}); await mkdir(data, {mode: 0o700});
  const paths = await createPaths(readConfig({MADDOTS_AI_HOME: data, XDG_CONFIG_HOME: dirname(policy.config),
    XDG_STATE_HOME: dirname(policy.state), XDG_RUNTIME_DIR: dirname(policy.runtime)}, home, 'linux'));
  await writeFile(join(root, 'package.json'), JSON.stringify({name: 'maddots-ai', type: 'module', bin: {'maddots-ai': 'dist/cli.js'}}), {mode: 0o400});
  for (const name of emittedGraph) {
    await writeFile(join(root, 'dist', name + '.js'), 'export const fixture = true;\n', {mode: 0o400});
  }
  await chmod(join(root, 'dist'), 0o500); await chmod(root, 0o500);
  t.after(async () => {await fixtureDirectoryModes(base, 0o700); await rm(base, {recursive: true, force: true});});
  const directory = join(data, '.write-lock-upgrade'), state = join(directory, 'state.json');
  const fresh = async (guarded: boolean) => {
    assert.deepEqual((await readdir(data)).sort(), guarded ? ['.write-lock-upgrade'] : []);
    if (guarded) assert.deepEqual(await readdir(directory), ['.guard']);
  };
  const prepare = (check = fresh, timing: Timing = clock) => prepareSystemRuntime(root, paths, timing, check, policy);
  const ready = (candidate = paths, timing: Timing = clock) => assertSystemRuntimeReady(candidate, timing, policy);
  return {base, root, paths, policy, directory, state, prepare, ready};
}

async function dependencyFixture(t: TestContext) {
  const f = await fixture(t), modules = join(f.root, 'node_modules'), target = join(modules, 'internal/index.js');
  await chmod(f.root, 0o700);
  await mkdir(dirname(target), {recursive: true, mode: 0o700});
  await writeFile(target, 'export const internal = true;\n', {mode: 0o400});
  const freeze = async () => {await fixtureDirectoryModes(modules, 0o500); await chmod(f.root, 0o500);};
  const inspect = () => inspectSystemInstallation(f.root, f.policy);
  return {...f, modules, target, freeze, inspect};
}

async function packageFixture(root: string, manifest: Record<string, unknown>, index = 'module.exports = {};\n'): Promise<void> {
  await mkdir(root, {recursive: true, mode: 0o700}); await chmod(root, 0o700);
  const path = join(root, 'package.json');
  try { await chmod(path, 0o600); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await writeFile(path, JSON.stringify(manifest), {mode: 0o400}); await chmod(path, 0o400);
  if (manifest.name !== 'maddots-ai') await writeFile(join(root, 'index.js'), index, {mode: 0o400});
}

const fixedManifest = (dependencies: Record<string, unknown> = {}) => ({name: 'maddots-ai', type: 'module',
  bin: {'maddots-ai': 'dist/cli.js'}, ...dependencies});

async function bootstrapFixture(t: TestContext) {
  const f = await fixture(t), canary = join(f.base, 'cli-main-imported');
  const policyDeclaration = /export const systemPolicy: Readonly<SystemRuntimePolicy> = Object\.freeze\(\{[\s\S]*?\n\}\);/u;
  await chmod(join(f.root, 'dist'), 0o700);
  for (const [name, sourceUrl] of [
    ['cli', new URL('../src/cli.ts', import.meta.url)],
    ['cli-validation', new URL('../src/cli-validation.ts', import.meta.url)],
    ['config', new URL('../src/config.ts', import.meta.url)],
    ['platform', new URL('../src/platform.ts', import.meta.url)],
    ['release-identity', new URL('../src/release-identity.ts', import.meta.url)],
    ['system-runtime-operation', new URL('../src/system-runtime-operation.ts', import.meta.url)],
    ['system-runtime-preflight', new URL('../src/system-runtime-preflight.ts', import.meta.url)],
  ] as const) {
    let source = await readFile(sourceUrl, 'utf8');
    if (name === 'system-runtime-preflight') {
      assert.match(source, policyDeclaration, 'the copied source must substitute only its argument-only fixture policy');
      source = source.replace(policyDeclaration,
        `export const systemPolicy: Readonly<SystemRuntimePolicy> = Object.freeze(${JSON.stringify(f.policy)});`);
    }
    const emitted = transpileModule(source, {compilerOptions: {target: ScriptTarget.ES2022, module: ModuleKind.ESNext}});
    const destination = join(f.root, 'dist', name + '.js');
    await chmod(destination, 0o600); await writeFile(destination, emitted.outputText); await chmod(destination, 0o400);
  }
  const implementation = join(f.root, 'dist/cli-main.js');
  const application = async (source = '') => {
    await chmod(join(f.root, 'dist'), 0o700); await chmod(implementation, 0o600);
    await writeFile(implementation, `import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(canary)}, 'imported');
${source}
export function runEntrypoint() { process.stdout.write('fixture ' + process.argv.slice(2).join(' ') + '\\n'); }
export function runCli() {}
export function validateCliLaunch() {}
export function computerName() {}
export function requireRunsPlatform() {}
`);
    await chmod(implementation, 0o400); await chmod(join(f.root, 'dist'), 0o500);
  };
  await application();
  const environment = (extra: NodeJS.ProcessEnv = {}) => {
    const clean: NodeJS.ProcessEnv = {...process.env, HOME: f.policy.home};
    delete clean.NODE_OPTIONS; delete clean.NODE_PATH;
    return {...clean, ...extra};
  };
  const launch = (argument: string, options: {env?: NodeJS.ProcessEnv; executable?: string; execArgv?: string[]} = {}) =>
    spawnSync(options.executable ?? process.execPath, [...options.execArgv ?? [], join(f.root, 'dist/cli.js'), argument],
      {encoding: 'utf8', timeout: 15_000, cwd: f.base, env: environment(options.env)});
  const native = (source: string, options: {env?: NodeJS.ProcessEnv; executable?: string} = {}) =>
    spawnSync(options.executable ?? process.execPath, ['--input-type=module', '--eval', source],
      {encoding: 'utf8', timeout: 15_000, cwd: f.base, env: environment(options.env)});
  const refusedBeforeImport = async (argument: string) => {
    const child = launch(argument);
    assert.ifError(child.error); assert.equal(child.status, 1, child.stderr);
    assert.match(child.stderr, /The fixed Linux system helper/u);
    assert.equal(child.stdout, '');
    await assert.rejects(lstat(canary), {code: 'ENOENT'});
  };
  return {...f, canary, application, environment, launch, native, refusedBeforeImport};
}

function successfulBootstrap(child: ReturnType<typeof spawnSync>): void {
  assert.ifError(child.error); assert.equal(child.status, 0, String(child.stderr));
  assert.equal(child.stdout, 'fixture --version\n');
}

const runtimeProbe = (source: string) => `import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
try { ${source} } catch (error) { console.error(error); throw error; }
`;

async function lockedDebugFixture(t: TestContext) {
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  if (!lock.packages?.['node_modules/debug'] || !lock.packages?.['node_modules/ms']) {
    t.skip('The synthetic export lock omits debug/ms entries; the real locked dependency regression runs in the source suite.');
    return undefined;
  }
  const f = await bootstrapFixture(t);
  await packageFixture(f.root, fixedManifest({dependencies: {debug: '4.4.3'}}));
  const installedRequire = createRequire(import.meta.url);
  for (const [name, version] of [['debug', '4.4.3'], ['ms', '2.1.3']]) {
    assert.equal(lock.packages[`node_modules/${name}`].version, version, 'runtime regression uses the helper lockfile versions');
    let manifest: string;
    try { manifest = installedRequire.resolve(`${name}/package.json`); }
    catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, 'MODULE_NOT_FOUND');
      manifest = fileURLToPath(new URL(`../../node_modules/.pnpm/${name}@${version}/node_modules/${name}/package.json`, import.meta.url));
    }
    assert.equal(JSON.parse(await readFile(manifest, 'utf8')).version, version, 'copy the real installed dependency at the locked version');
    const destination = join(f.root, 'node_modules', name);
    await cp(dirname(manifest), destination, {recursive: true, dereference: true});
    const readOnlyFiles = async (path: string): Promise<void> => {
      if ((await lstat(path)).isDirectory()) {
        await chmod(path, 0o700);
        for (const child of await readdir(path)) await readOnlyFiles(join(path, child));
      } else await chmod(path, 0o400);
    };
    await readOnlyFiles(destination);
  }
  return f;
}

test('fixed runtime enrolls and restarts from a genuinely read-only package with zero package writes', {skip: !linux}, async t => {
  const f = await fixture(t);
  assert.equal(systemRuntimeMode(f.root), false, 'ordinary user installations never select fixed mode');
  assert.equal(systemRuntimeMode(f.root, f.policy), true);
  await assert.rejects(access(f.root, constants.W_OK), {code: 'EACCES'});
  await assert.rejects(open(join(f.root, 'dist/cli.js'), constants.O_WRONLY), {code: 'EACCES'});
  const before = await inventory(f.root);
  await f.prepare(); await f.ready();
  await f.prepare(async () => assert.fail('restart must not re-enroll existing state'));
  await f.ready({data: join(f.paths.data, 'runner')} as HelperPaths);
  const state = JSON.parse(await readFile(f.state, 'utf8'));
  assert.equal(state.installation.root, f.root); assert.equal(state.storage.data, f.paths.data);
  assert.equal(state.revision, 3); assert.ok(state.graph['dist/write-lock-upgrade.js']);
  assert.deepEqual((await readdir(f.directory)).sort(), ['.guard', 'state.json']);
  assert.deepEqual(await inventory(f.root), before);
});

test('fixed runtime refuses hostile metadata pointers and coverage reduction without changing evidence', {skip: !linux}, async t => {
  const f = await fixture(t); await f.prepare(); const initial = await readFile(f.state, 'utf8'), before = await inventory(f.root);
  for (const change of [
    (value: Record<string, any>) => {value.directory = '/tmp/hostile';},
    (value: Record<string, any>) => {value.bootstrap = '/tmp/hostile';},
    (value: Record<string, any>) => {value.installation.root = '/tmp/hostile';},
    (value: Record<string, any>) => {value.graph['dist/cli.js'] = '0'.repeat(64);},
    (value: Record<string, any>) => {value.layout.roots = [f.paths.data];},
    (value: Record<string, any>) => {value.layout.states = [];},
    (value: Record<string, any>) => {value.revision = 2;},
  ]) {
    const value = JSON.parse(initial); change(value); const hostile = JSON.stringify(value);
    await writeFile(f.state, hostile);
    await assert.rejects(f.ready({data: f.paths.data} as HelperPaths), {code: 'SYSTEM_RUNTIME_FIXED'});
    await assert.rejects(f.prepare(), {code: 'SYSTEM_RUNTIME_FIXED'});
    assert.equal(await readFile(f.state, 'utf8'), hostile);
  }
  assert.deepEqual(await inventory(f.root), before);
});

test('fixed runtime preserves retained retirement and recovery obligations across restart', {skip: !linux}, async t => {
  const f = await fixture(t); await f.prepare(); const original = await readFile(f.state, 'utf8');
  for (const obligation of [{patching: true}, {retirement: {boot: 'old', processes: [{pid: 123}]}},
    {recovery: {seal: {boot: 'old'}}}, {recovery: {completion: {method: 'cohort'}}},
    {protocol: 3, linuxSourcePolicy: 'released-only-v1', sources: {}}]) {
    const retained = JSON.stringify({...JSON.parse(original), ...obligation}); await writeFile(f.state, retained);
    await assert.rejects(f.prepare(), /Retained S5-10 recovery obligations/u);
    await assert.rejects(f.ready(), {code: 'SYSTEM_RUNTIME_FIXED'});
    assert.equal(await readFile(f.state, 'utf8'), retained);
  }
});

test('fixed runtime refuses graph drift, writable artifacts, canonical-entrypoint aliases and package sidecars', {skip: !linux}, async t => {
  const f = await fixture(t); await f.prepare(); const retained = await readFile(f.state, 'utf8');
  const cli = join(f.root, 'dist/cli.js');
  await chmod(cli, 0o600);
  await assert.rejects(f.ready(), {code: 'SYSTEM_RUNTIME_FIXED'});
  await writeFile(cli, 'export const changed = true;\n'); await chmod(cli, 0o400);
  const drifted = await inventory(f.root);
  await assert.rejects(f.ready(), {code: 'SYSTEM_RUNTIME_FIXED'});
  await assert.rejects(f.prepare(), {code: 'SYSTEM_RUNTIME_FIXED'});
  assert.deepEqual(await inventory(f.root), drifted); assert.equal(await readFile(f.state, 'utf8'), retained);
  await chmod(join(f.root, 'dist'), 0o700); await rename(cli, join(f.root, 'dist/other.js'));
  await symlink('other.js', cli); await chmod(join(f.root, 'dist'), 0o500);
  await assert.rejects(assertSystemRuntime(f.root, f.paths, f.policy), {code: 'SYSTEM_RUNTIME_FIXED'});
  await chmod(join(f.root, 'dist'), 0o700); await rm(cli); await rename(join(f.root, 'dist/other.js'), cli);
  await writeFile(join(f.root, 'dist/.write-lock-upgrade.json'), '{"directory":"/tmp/hostile"}', {mode: 0o400});
  await chmod(join(f.root, 'dist'), 0o500);
  await assert.rejects(f.prepare(), {code: 'SYSTEM_RUNTIME_FIXED'});
});

test('fixed runtime rejects an external dependency hop that returns to internal package bytes', {skip: !linux}, async t => {
  const f = await dependencyFixture(t), link = join(f.modules, 'a-dependency'), bridge = join(f.base, 'external-bridge');
  await symlink(f.target, bridge); await symlink(bridge, link); await f.freeze();
  assert.equal(await realpath(link), f.target, 'the final canonical target hides the external hop');
  await assert.rejects(f.inspect(), {code: 'SYSTEM_RUNTIME_FIXED', message: /dependency link outside its installation/u});
});

test('fixed runtime checks writable dependency components before normalizing later parent components', {skip: !linux}, async t => {
  for (const target of ['writable/index.js', 'writable/../internal/index.js']) await t.test(target, async t => {
    const f = await dependencyFixture(t), writable = join(f.modules, 'writable'), link = join(f.modules, 'a-dependency');
    await mkdir(writable, {mode: 0o700});
    await writeFile(join(writable, 'index.js'), 'export const writableParent = true;\n', {mode: 0o400});
    await symlink(target, link); await f.freeze(); await chmod(writable, 0o700);
    assert.equal(await realpath(link), target.includes('..') ? f.target : join(writable, 'index.js'));
    // The link sorts before the writable directory, so this proves that the
    // raw target traversal rejects it before the ordinary inventory finds it.
    await assert.rejects(f.inspect(), {code: 'SYSTEM_RUNTIME_FIXED', message: /writable or incorrectly owned dependency path/u});
  });
});

test('fixed runtime rejects relative dependency hops that escape and then reenter the package', {skip: !linux}, async t => {
  const f = await dependencyFixture(t), link = join(f.modules, 'a-dependency');
  await symlink('../../package/node_modules/internal/index.js', link); await f.freeze();
  assert.equal(await realpath(link), f.target);
  await assert.rejects(f.inspect(), {code: 'SYSTEM_RUNTIME_FIXED', message: /dependency link outside its installation/u});
});

test('fixed runtime accepts internal multiple-hop dependency chains, component links and bin parent hops', {skip: !linux}, async t => {
  const f = await dependencyFixture(t);
  for (const name of ['.bin', 'aliases', 'pkg', 'shared-bin']) await mkdir(join(f.modules, name), {mode: 0o700});
  const command = join(f.modules, 'shared-bin/command.js');
  await writeFile(command, 'export const command = true;\n', {mode: 0o400});
  await symlink('../shared-bin', join(f.modules, 'pkg/bin'));
  await symlink('../pkg/bin', join(f.modules, 'aliases/current'));
  await symlink('aliases/current/command.js', join(f.modules, 'a-dependency'));
  await symlink(join(f.modules, 'a-dependency'), join(f.modules, 'b-absolute'));
  await symlink('../pkg/bin/command.js', join(f.modules, '.bin/command'));
  await f.freeze();
  assert.equal(await realpath(join(f.modules, 'a-dependency')), command);
  assert.equal(await realpath(join(f.modules, '.bin/command')), command);
  const inspected = await f.inspect();
  for (const name of ['a-dependency', 'b-absolute', 'aliases/current', 'pkg/bin', '.bin/command']) {
    assert.ok(inspected.graph[`node_modules/${name}`]);
  }
  await f.prepare(); await f.ready();
});

test('fixed runtime fails closed on cyclic and excessive dependency link chains', {skip: !linux}, async t => {
  for (const cyclic of [true, false]) await t.test(cyclic ? 'cycle' : '41 link chain', async t => {
    const f = await dependencyFixture(t);
    if (cyclic) {
      await symlink('b-cycle', join(f.modules, 'a-cycle')); await symlink('a-cycle', join(f.modules, 'b-cycle'));
    } else {
      for (let index = 0; index < 41; index++) {
        await symlink(index === 40 ? 'internal/index.js' : `chain-${String(index + 1).padStart(2, '0')}`,
          join(f.modules, `chain-${String(index).padStart(2, '0')}`));
      }
    }
    await f.freeze();
    await assert.rejects(f.inspect(), {code: 'SYSTEM_RUNTIME_FIXED', message: /cyclic or excessive dependency link chain/u});
  });
});

test('fixed runtime rejects lexical system-root and entrypoint aliases into an external package', {skip: !linux}, async t => {
  for (const alias of ['root', 'entrypoint']) await t.test(alias, async t => {
    const f = await fixture(t), outside = join(f.base, 'external-package'), entrypoint = join(f.root, 'dist/cli.js');
    await rename(f.root, outside);
    if (alias === 'root') await symlink(outside, f.root);
    else {
      await mkdir(join(f.root, 'dist'), {recursive: true, mode: 0o700});
      await symlink(join(outside, 'dist/cli.js'), entrypoint);
      await chmod(join(f.root, 'dist'), 0o500); await chmod(f.root, 0o500);
    }
    assert.equal(await realpath(entrypoint), join(outside, 'dist/cli.js'));
    await assert.rejects(assertSystemInvocation(entrypoint, f.policy), {code: 'SYSTEM_RUNTIME_FIXED'});
  });
});

test('CLI preflight rejects hostile dependencies before application imports, including help and version', {skip: !linux}, async t => {
  const f = await bootstrapFixture(t), healthy = f.launch('--version');
  assert.ifError(healthy.error); assert.equal(healthy.status, 0, healthy.stderr);
  assert.equal(healthy.stdout, 'fixture --version\n'); assert.equal(await readFile(f.canary, 'utf8'), 'imported');
  await rm(f.canary); await chmod(f.root, 0o700);
  await mkdir(join(f.root, 'node_modules'), {mode: 0o700});
  const bridge = join(f.base, 'external-bridge');
  await symlink(join(f.root, 'dist/cli-main.js'), bridge);
  await symlink(bridge, join(f.root, 'node_modules/a-dependency'));
  await chmod(join(f.root, 'node_modules'), 0o500); await chmod(f.root, 0o500);
  await f.refusedBeforeImport('--help'); await f.refusedBeforeImport('--version');
});

test('fixed CLI refuses startup environment and Node arguments before application imports', {skip: !linux}, async t => {
  const f = await bootstrapFixture(t), preload = join(f.base, 'noop.cjs');
  await writeFile(preload, 'module.exports = {};\n');
  const cases = [
    ...['NODE_OPTIONS', 'NODE_PATH'].flatMap(name => ['', name === 'NODE_OPTIONS' ? '--no-warnings' : f.base]
      .map(value => ({name: `${name}=${value}`, argument: '--version', options: {env: {[name]: value}}, reason: new RegExp(`refuses ${name}`, 'u')}))),
    ...[['--no-warnings'], ['--inspect'], ['--inspect-port=0'], ['--import=data:text/javascript,export{}'], ['--require', preload],
      ['--disable-sigusr1', '--no-warnings'], ['--disable-sigusr1', '--inspect'], ['--disable-sigusr1', '--inspect-port=0'],
      ['--disable-sigusr1', '--disable-sigusr1']]
      .map(execArgv => ({name: execArgv.join(' '), argument: '--help', options: {execArgv}, reason: /refuses process.execArgv other than exactly --disable-sigusr1/u})),
    {name: 'service without --disable-sigusr1', argument: 'service', options: {}, reason: /requires --disable-sigusr1 for service mode/u},
    ...['--import', '--import=outside.mjs', '--require', '--require=outside.cjs', '-r', '-routside.cjs', '--loader',
      '--loader=outside.mjs', '--experimental-loader=outside.mjs', '--experimental-import-meta-resolve']
      .map(argument => ({name: `CLI ${argument}`, argument, options: {}, reason: /refuses Node preload and loader flags/u})),
  ];
  for (const vector of cases) await t.test(vector.name, async () => {
    const child = f.launch(vector.argument, vector.options);
    assert.ifError(child.error); assert.equal(child.status, 1, child.stderr);
    assert.match(child.stderr, vector.reason); assert.equal(child.stdout, '');
    await assert.rejects(lstat(f.canary), {code: 'ENOENT'});
  });
});

test('fixed preflight accepts exactly --disable-sigusr1, including service mode', {skip: !linux}, async t => {
  const f = await bootstrapFixture(t);
  for (const argument of ['--version', 'service']) {
    const child = f.launch(argument, {execArgv: ['--disable-sigusr1']});
    assert.ifError(child.error); assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, `fixture ${argument}\n`);
    assert.equal(await readFile(f.canary, 'utf8'), 'imported');
    await rm(f.canary);
  }
});

test('ordinary CLI stays non-fixed from the fixed directory, including help and version', {skip: !linux}, async t => {
  const f = await bootstrapFixture(t), ordinary = join(f.base, 'ordinary');
  const originalDirectory = process.cwd();
  try {
    process.chdir(f.root);
    for (const root of ['', '.', './']) assert.equal(systemRuntimeMode(root, f.policy), false,
      'fixed selection requires a non-empty absolute caller root');
    assert.equal(systemRuntimeMode(f.root, f.policy), true);
  } finally { process.chdir(originalDirectory); }
  await cp(f.root, ordinary, {recursive: true});
  for (const argument of ['--help', '--version']) {
    const child = spawnSync(process.execPath, [join(ordinary, 'dist/cli.js'), argument],
      {cwd: f.root, env: f.environment(), encoding: 'utf8', timeout: 15_000});
    assert.ifError(child.error); assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, `fixture ${argument}\n`);
    assert.equal(await readFile(f.canary, 'utf8'), 'imported'); await rm(f.canary);
  }
});

test('fixed resolver lets real locked debug catch absent supports-color without running an ancestor package', {skip: !linux}, async t => {
  const f = await lockedDebugFixture(t);
  if (!f) return;
  const outsideCanary = join(f.base, 'supports-color-imported');
  const outside = join(f.base, 'node_modules/supports-color');
  await packageFixture(outside, {name: 'supports-color'},
    `require('node:fs').writeFileSync(${JSON.stringify(outsideCanary)}, 'executed'); module.exports = {stderr: {level: 3}};\n`);
  const control = f.native(`import {createRequire} from 'node:module';
const require = createRequire(${JSON.stringify(join(f.root, 'node_modules/debug/src/node.js'))});
process.stdout.write(require.resolve('supports-color'));`);
  assert.ifError(control.error); assert.equal(control.status, 0, control.stderr);
  assert.equal(control.stdout, join(outside, 'index.js'));
  await assert.rejects(lstat(join(f.root, 'node_modules/supports-color')), {code: 'ENOENT'});
  await f.application(runtimeProbe(`
    assert.equal(process.env.NODE_PATH, undefined);
    const debug = require('debug');
    assert.equal(debug.humanize(1500), '2s');
    debug.enable('fixed-runtime');
    const logger = debug('fixed-runtime'); let logged = '';
    logger.log = (...args) => { logged = args.join(' '); };
    logger('working'); assert.match(logged, /working/u);
    assert.throws(() => require('supports-color'), {code: 'MODULE_NOT_FOUND'});
    assert.throws(() => require.resolve('supports-color'), {code: 'MODULE_NOT_FOUND'});
  `));
  await fixtureDirectoryModes(f.root, 0o500);
  successfulBootstrap(f.launch('--version'));
  await assert.rejects(lstat(outsideCanary), {code: 'ENOENT'});
});

test('fixed resolver excludes ancestor, NODE_PATH, home and executable-prefix CommonJS lookup paths', {skip: !linux}, async t => {
  for (const location of ['ancestor', 'NODE_PATH', 'NODE_PATH traversal', '.node_modules', '.node_libraries', 'prefix']) await t.test(location, async t => {
    const f = await bootstrapFixture(t), outsideCanary = join(f.base, 'outside-imported');
    const name = 'fixed-runtime-outside';
    const searchRoot = location === 'ancestor' ? join(f.base, 'node_modules')
      : location.startsWith('NODE_PATH') ? join(f.base, 'node-path')
      : location === 'prefix' ? join(f.base, 'private-prefix/lib/node') : join(f.policy.home, location);
    const outside = join(searchRoot, name);
    await packageFixture(outside, {name},
      `require('node:fs').writeFileSync(${JSON.stringify(outsideCanary)}, 'executed'); module.exports = 'outside';\n`);
    let executable = process.execPath;
    if (location === 'prefix') {
      executable = join(f.base, 'private-prefix/bin/node');
      await mkdir(dirname(executable), {recursive: true, mode: 0o700});
      await copyFile(process.execPath, executable); await chmod(executable, 0o500);
    }
    const options = {executable, env: location.startsWith('NODE_PATH') ? {NODE_PATH: location === 'NODE_PATH traversal'
      ? f.root + '/../node-path' : searchRoot} : {}};
    const control = f.native(`import {createRequire} from 'node:module';
const require = createRequire(${JSON.stringify(join(f.root, 'dist/cli-main.js'))});
process.stdout.write(require.resolve(${JSON.stringify(name)}));`, options);
    assert.ifError(control.error); assert.equal(control.status, 0, control.stderr);
    assert.equal(control.stdout, join(outside, 'index.js'), 'the unguarded native Node process sees the canary');
    await f.application(runtimeProbe(`
      assert.equal(process.env.NODE_PATH, undefined);
      assert.throws(() => require(${JSON.stringify(name)}), {code: 'MODULE_NOT_FOUND'});
      assert.throws(() => require.resolve(${JSON.stringify(name)}), {code: 'MODULE_NOT_FOUND'});
      assert.throws(() => require.resolve(${JSON.stringify(name)}, {paths: [${JSON.stringify(dirname(searchRoot))}, ${JSON.stringify(searchRoot)}]}), {code: 'MODULE_NOT_FOUND'});
      for (const path of require.resolve.paths(${JSON.stringify(name)})) {
        assert.ok(path.startsWith(${JSON.stringify(f.root + '/')}), 'actual CommonJS lookup path escaped the inventory: ' + path);
      }
      assert.equal(require('node:path').basename('/fixed/internal'), 'internal');
    `));
    if (location.startsWith('NODE_PATH')) {
      const refused = f.launch('--version', options);
      assert.ifError(refused.error); assert.equal(refused.status, 1, refused.stderr);
      assert.match(refused.stderr, /refuses NODE_PATH/u);
      await assert.rejects(lstat(f.canary), {code: 'ENOENT'});
      // Even if trusted application code later reinitializes Node's search
      // list, the installed guard still refuses this global fallback.
      await f.application(runtimeProbe(`
        process.env.NODE_PATH = ${JSON.stringify(options.env.NODE_PATH)};
        require('node:module')._initPaths();
        assert.throws(() => require(${JSON.stringify(name)}), {code: 'MODULE_NOT_FOUND'});
        assert.throws(() => require.resolve(${JSON.stringify(name)}), {code: 'MODULE_NOT_FOUND'});
      `));
      successfulBootstrap(f.launch('--version', {executable}));
    } else successfulBootstrap(f.launch('--version', options));
    await assert.rejects(lstat(outsideCanary), {code: 'ENOENT'});
  });
});

test('fixed resolver rejects static outside imports before any application body executes', {skip: !linux}, async t => {
  for (const kind of ['commonjs', 'module']) await t.test(kind, async t => {
    const f = await bootstrapFixture(t), outsideCanary = join(f.base, 'outside-imported');
    const outside = join(f.base, kind === 'commonjs' ? 'outside.cjs' : 'outside.mjs');
    await writeFile(outside, `importer();\n${kind === 'commonjs'
      ? `function importer() { require('node:fs').writeFileSync(${JSON.stringify(outsideCanary)}, 'executed'); }`
      : `import {writeFileSync} from 'node:fs'; function importer() { writeFileSync(${JSON.stringify(outsideCanary)}, 'executed'); }`}\n`);
    await f.application(`import ${JSON.stringify(outside)};`);
    const child = f.launch('--version');
    assert.ifError(child.error); assert.equal(child.status, 1, child.stderr); assert.equal(child.stdout, '');
    await assert.rejects(lstat(f.canary), {code: 'ENOENT'});
    await assert.rejects(lstat(outsideCanary), {code: 'ENOENT'});
  });
});

test('fixed resolver rejects dynamic imports, createRequire and require.resolve outside the inventoried package', {skip: !linux}, async t => {
  const f = await bootstrapFixture(t), outsideCanary = join(f.base, 'outside-imported');
  const outsideCjs = join(f.base, 'outside.cjs'), outsideEsm = join(f.base, 'outside.mjs');
  await writeFile(outsideCjs, `require('node:fs').writeFileSync(${JSON.stringify(outsideCanary)}, 'executed'); module.exports = true;\n`);
  await writeFile(outsideEsm, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(outsideCanary)}, 'executed'); export default true;\n`);
  const internalPackage = join(f.root, 'node_modules/fixed-internal');
  await chmod(f.root, 0o700);
  await packageFixture(internalPackage, {name: 'fixed-internal'}, `const {createRequire} = require('node:module');
const internalRequire = createRequire(__filename);
exports.requireOutside = () => internalRequire(${JSON.stringify(outsideCjs)});
exports.resolveOutside = () => internalRequire.resolve(${JSON.stringify(outsideCjs)});
exports.internal = require('node:path').basename('/fixed/internal');\n`);
  await chmod(join(f.root, 'dist'), 0o700);
  const internalEsm = join(f.root, 'dist/internal.mjs');
  await writeFile(internalEsm, 'export const internal = true;\n', {mode: 0o400});
  await f.application(runtimeProbe(`
    for (const outside of ${JSON.stringify([outsideCjs, outsideEsm])}) {
      await assert.rejects(import(outside), {code: 'ERR_MODULE_NOT_FOUND'});
      await assert.rejects(import(new URL('file://' + outside)), {code: 'ERR_MODULE_NOT_FOUND'});
      assert.throws(() => require(outside), {code: 'MODULE_NOT_FOUND'});
      assert.throws(() => require.resolve(outside), {code: 'MODULE_NOT_FOUND'});
    }
    assert.throws(() => require('../../outside.cjs'), {code: 'MODULE_NOT_FOUND'});
    assert.throws(() => require.resolve('../../outside.cjs'), {code: 'MODULE_NOT_FOUND'});
    const outsideRequire = createRequire(${JSON.stringify(join(f.base, 'outside-parent.cjs'))});
    assert.throws(() => outsideRequire('./outside.cjs'), {code: 'MODULE_NOT_FOUND'});
    assert.throws(() => outsideRequire.resolve('./outside.cjs'), {code: 'MODULE_NOT_FOUND'});
    const internal = require('fixed-internal'); assert.equal(internal.internal, 'internal');
    assert.throws(() => internal.requireOutside(), {code: 'MODULE_NOT_FOUND'});
    assert.throws(() => internal.resolveOutside(), {code: 'MODULE_NOT_FOUND'});
    assert.equal(require.resolve('fixed-internal'), ${JSON.stringify(join(internalPackage, 'index.js'))});
    assert.equal((await import('fixed-internal')).default.internal, 'internal');
    assert.equal((await import(${JSON.stringify(internalEsm + '?turn=1#internal')})).internal, true);
    assert.equal(await import('node:fs').then(module => typeof module.readFileSync), 'function');
    assert.equal(require('fs').readFileSync, require('node:fs').readFileSync);
    assert.equal(require.resolve('fs'), 'fs');
    assert.equal((await import('path')).basename('/fixed/internal'), 'internal');
  `));
  await fixtureDirectoryModes(f.root, 0o500);
  successfulBootstrap(f.launch('--version'));
  await assert.rejects(lstat(outsideCanary), {code: 'ENOENT'});
});

test('fixed resolver remains active through asynchronous work and rejects paths changed after preflight', {skip: !linux}, async t => {
  const f = await bootstrapFixture(t), outsideCanary = join(f.base, 'outside-imported');
  const outside = join(f.base, 'late-node-path/fixed-late'), replaced = join(f.root, 'dist/replaced.cjs');
  const added = join(f.root, 'dist/added.mjs'), internal = join(f.root, 'dist/internal.cjs');
  await chmod(join(f.root, 'dist'), 0o700);
  await writeFile(replaced, 'module.exports = "original";\n', {mode: 0o400});
  await writeFile(internal, 'module.exports = "internal";\n', {mode: 0o400});
  await f.application(runtimeProbe(`
    const fs = require('node:fs');
    const {preflightSystemRuntime} = await import('./system-runtime-preflight.js');
    await preflightSystemRuntime();
    await preflightSystemRuntime();
    await new Promise(resolve => setTimeout(resolve, 10));
    fs.mkdirSync(${JSON.stringify(outside)}, {recursive: true});
    fs.writeFileSync(${JSON.stringify(join(outside, 'index.js'))}, ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(outsideCanary)}, 'executed'); module.exports = true;\n`)});
    process.env.NODE_PATH = ${JSON.stringify(dirname(outside))};
    require('node:module')._initPaths();
    fs.chmodSync(${JSON.stringify(join(f.root, 'dist'))}, 0o700);
    fs.writeFileSync(${JSON.stringify(added)}, ${JSON.stringify(`import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(outsideCanary)}, 'executed');\n`)});
    fs.chmodSync(${JSON.stringify(added)}, 0o400);
    fs.chmodSync(${JSON.stringify(join(f.root, 'dist'))}, 0o500);
    await assert.rejects(preflightSystemRuntime(), {code: 'SYSTEM_RUNTIME_FIXED'});
    fs.chmodSync(${JSON.stringify(join(f.root, 'dist'))}, 0o700);
    fs.unlinkSync(${JSON.stringify(replaced)}); fs.symlinkSync(${JSON.stringify(join(outside, 'index.js'))}, ${JSON.stringify(replaced)});
    fs.chmodSync(${JSON.stringify(join(f.root, 'dist'))}, 0o500);
    for (let turn = 0; turn < 3; turn++) {
      await new Promise(resolve => setImmediate(resolve));
      assert.throws(() => require('fixed-late'), {code: 'MODULE_NOT_FOUND'});
      assert.throws(() => require.resolve('fixed-late'), {code: 'MODULE_NOT_FOUND'});
      assert.throws(() => require.resolve('fixed-late', {paths: [${JSON.stringify(dirname(outside))}]}), {code: 'MODULE_NOT_FOUND'});
      assert.throws(() => require(${JSON.stringify(replaced)}), {code: 'MODULE_NOT_FOUND'});
      assert.throws(() => require.resolve(${JSON.stringify(replaced)}), {code: 'MODULE_NOT_FOUND'});
      await assert.rejects(import(${JSON.stringify(replaced)}), {code: 'ERR_MODULE_NOT_FOUND'});
      await assert.rejects(import(${JSON.stringify(added)}), {code: 'ERR_MODULE_NOT_FOUND'});
      assert.throws(() => require(${JSON.stringify(added)}), {code: 'MODULE_NOT_FOUND'});
      assert.throws(() => require.resolve(${JSON.stringify(added)}), {code: 'MODULE_NOT_FOUND'});
      assert.equal(require(${JSON.stringify(internal)}), 'internal');
      assert.equal((await import(${JSON.stringify(internal)})).default, 'internal');
      assert.equal(require('node:os').platform(), 'linux');
    }
  `));
  successfulBootstrap(f.launch('--version'));
  await assert.rejects(lstat(outsideCanary), {code: 'ENOENT'});
});

test('fixed preflight fails closed when synchronous hooks or the supported Node version are unavailable', {skip: !linux}, async t => {
  for (const unavailable of ['registerHooks', 'node-version']) await t.test(unavailable, async t => {
    const f = await bootstrapFixture(t);
    const child = f.native(`import assert from 'node:assert/strict';
import Module, {syncBuiltinESMExports} from 'node:module';
${unavailable === 'registerHooks' ? 'Module.registerHooks = undefined; syncBuiltinESMExports();'
  : "Object.defineProperty(process.versions, 'node', {value: '22.14.0'});"}
process.execArgv.length = 0; // This fixture isolates hook support from the startup-flag refusal.
const preflight = await import(${JSON.stringify(join(f.root, 'dist/system-runtime-preflight.js'))});
await assert.rejects(preflight.preflightSystemRuntime(), {code: 'SYSTEM_RUNTIME_FIXED'});
process.stdout.write('refused');`);
    assert.ifError(child.error); assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, 'refused');
    await assert.rejects(lstat(f.canary), {code: 'ENOENT'});
  });
});

test('fixed runtime refuses missing direct and transitive dependencies', {skip: !linux}, async t => {
  for (const transitive of [false, true]) await t.test(transitive ? 'transitive' : 'direct', async t => {
    const f = await fixture(t);
    await packageFixture(f.root, fixedManifest({dependencies: {'fixed-dependency': '1.0.0'}}));
    if (transitive) await packageFixture(join(f.root, 'node_modules/fixed-dependency'),
      {name: 'fixed-dependency', dependencies: {'fixed-missing-leaf': '1.0.0'}});
    await fixtureDirectoryModes(f.root, 0o500);
    await assert.rejects(inspectSystemInstallation(f.root, f.policy), {code: 'SYSTEM_RUNTIME_FIXED',
      message: transitive ? /missing an internal required dependency \(fixed-missing-leaf\)/u : /missing an internal required dependency \(fixed-dependency\)/u});
  });
});

test('fixed runtime refuses ancestor dependency fallback, including mutable symlink targets and outside optionals', {skip: !linux}, async t => {
  for (const kind of ['dependencies', 'optionalDependencies', 'peerDependencies', 'optional-peer']) await t.test(kind, async t => {
    const f = await fixture(t), name = 'fixed-outside-dependency', external = join(f.base, 'mutable-package');
    const outsideCanary = join(f.base, 'outside-imported');
    await packageFixture(f.root, fixedManifest(kind === 'optional-peer'
      ? {peerDependencies: {[name]: '1.0.0'}, peerDependenciesMeta: {[name]: {optional: true}}}
      : {[kind]: {[name]: '1.0.0'}}));
    await packageFixture(external, {name}, `require('node:fs').writeFileSync(${JSON.stringify(outsideCanary)}, 'imported');\n`);
    await chmod(join(external, 'index.js'), 0o600);
    await mkdir(join(f.base, 'node_modules'), {mode: 0o700});
    await symlink(external, join(f.base, 'node_modules', name));
    // Demonstrate the same ancestor resolution available to cli-main without
    // executing the dependency or its import canary.
    assert.equal(createRequire(join(f.root, 'dist/cli-main.js')).resolve(name), join(external, 'index.js'));
    await fixtureDirectoryModes(f.root, 0o500);
    await assert.rejects(inspectSystemInstallation(f.root, f.policy), {code: 'SYSTEM_RUNTIME_FIXED', message: /ancestor and global fallback are refused/u});
    await assert.rejects(lstat(outsideCanary), {code: 'ENOENT'});
  });
});

test('fixed runtime requires absent optionals and peers locally, including optional peers', {skip: !linux}, async t => {
  for (const declaration of [
    {optionalDependencies: {'fixed-optional': '1.0.0'}},
    {peerDependencies: {'fixed-peer': '1.0.0'}},
    {peerDependencies: {'fixed-peer': '1.0.0'}, peerDependenciesMeta: {'fixed-peer': {optional: true}}},
  ]) await t.test(JSON.stringify(declaration), async t => {
    const f = await fixture(t);
    await packageFixture(f.root, fixedManifest(declaration)); await fixtureDirectoryModes(f.root, 0o500);
    await assert.rejects(inspectSystemInstallation(f.root, f.policy), {code: 'SYSTEM_RUNTIME_FIXED', message: /missing an internal (optional|peer|optional peer) dependency/u});
  });
});

test('fixed runtime inventories nested, hoisted, scoped and linked dependency closure with peers, optionals and cycles', {skip: !linux}, async t => {
  const f = await fixture(t), modules = join(f.root, 'node_modules');
  await packageFixture(f.root, fixedManifest({dependencies: {'fixed-parent': '1.0.0', '@fixed/alias': '1.0.0'},
    optionalDependencies: {'fixed-optional': '1.0.0'}, devDependencies: {'fixed-development-only': '1.0.0'}}));
  await packageFixture(join(modules, 'fixed-parent'), {name: 'fixed-parent', dependencies: {'fixed-leaf': '1.0.0'},
    peerDependencies: {'fixed-peer': '1.0.0'}, peerDependenciesMeta: {'fixed-peer': {optional: true}},
    exports: {'.': {import: './index.js', require: './index.js', types: './index.d.ts'}}});
  await writeFile(join(modules, 'fixed-parent/index.d.ts'), 'export {};\n', {mode: 0o400});
  await packageFixture(join(modules, 'fixed-parent/lib'), {type: 'module'});
  await packageFixture(join(modules, 'fixed-parent/node_modules/fixed-leaf'), {name: 'fixed-leaf', dependencies: {'fixed-parent': '1.0.0'}});
  await packageFixture(join(modules, 'fixed-peer'), {name: 'fixed-peer'});
  await packageFixture(join(modules, 'fixed-optional'), {name: 'fixed-optional'});
  const physical = join(modules, '.store/linked/node_modules/linked');
  await packageFixture(physical, {name: 'linked', dependencies: {'fixed-peer': '1.0.0'}});
  await mkdir(join(modules, '@fixed'), {mode: 0o700});
  await symlink('../.store/linked/node_modules/linked', join(modules, '@fixed/alias'));
  await fixtureDirectoryModes(f.root, 0o500);
  const before = await inventory(f.root), inspected = await inspectSystemInstallation(f.root, f.policy);
  assert.ok(inspected.graph['node_modules/fixed-parent/node_modules/fixed-leaf/package.json']);
  assert.ok(inspected.graph['node_modules/.store/linked/node_modules/linked/package.json']);
  assert.deepEqual(await inventory(f.root), before);
});

test('CLI preflight rejects incomplete dependency closure before application imports', {skip: !linux}, async t => {
  for (const scenario of ['missing', 'transitive', 'ancestor', 'outside-optional']) await t.test(scenario, async t => {
    const f = await bootstrapFixture(t), name = 'fixed-closure-dependency';
    await packageFixture(f.root, fixedManifest({[scenario === 'outside-optional' ? 'optionalDependencies' : 'dependencies']: {[name]: '1.0.0'}}));
    if (scenario === 'transitive') await packageFixture(join(f.root, 'node_modules', name),
      {name, dependencies: {'fixed-missing-leaf': '1.0.0'}});
    if (scenario === 'ancestor' || scenario === 'outside-optional') {
      const external = join(f.base, 'mutable-package');
      await packageFixture(external, {name}); await chmod(join(external, 'index.js'), 0o600);
      await mkdir(join(f.base, 'node_modules'), {mode: 0o700});
      await symlink(external, join(f.base, 'node_modules', name));
    }
    await fixtureDirectoryModes(f.root, 0o500);
    await f.refusedBeforeImport('--help'); await f.refusedBeforeImport('--version');
  });
});

test('fixed runtime refuses dependency file shadows, incomplete entrypoints and unsafe manifests', {skip: !linux}, async t => {
  for (const scenario of ['file-shadow', 'missing-entrypoint', 'escaping-main', 'invalid-name', 'invalid-map', 'imports-fallback',
    'imports-traversal', 'missing-export', 'content-search-directory', 'nested-scope-imports', 'content-link']) {
    await t.test(scenario, async t => {
      const f = await fixture(t), dependency = join(f.root, 'node_modules/fixed-package');
      await packageFixture(f.root, fixedManifest({dependencies: scenario === 'invalid-name' ? {'../outside': '1.0.0'}
        : scenario === 'invalid-map' ? [] : {'fixed-package': '1.0.0'}}));
      await packageFixture(dependency, {name: 'fixed-package', ...(scenario === 'escaping-main' ? {main: '../../../external.js'} : {}),
        ...(scenario === 'imports-fallback' ? {imports: {'#alias': 'fixed-missing-import'}} : {}),
        ...(scenario === 'imports-traversal' ? {imports: {'#alias': 'fixed-package/../../../external.js'}} : {}),
        ...(scenario === 'missing-export' ? {exports: {'.': './missing.js'}} : {})});
      if (scenario === 'file-shadow') await writeFile(dependency + '.js', 'module.exports = {};\n', {mode: 0o400});
      if (scenario === 'missing-entrypoint') await rm(join(dependency, 'index.js'));
      if (scenario === 'content-search-directory') await packageFixture(join(dependency, 'lib/node_modules/fixed-shadow'),
        {name: 'fixed-shadow', dependencies: {'fixed-missing-leaf': '1.0.0'}});
      if (scenario === 'nested-scope-imports') await packageFixture(join(dependency, 'lib'),
        {type: 'module', imports: {'#leaf': 'fixed-missing-leaf'}}, "import '#leaf';\n");
      if (scenario === 'content-link') {
        await packageFixture(join(f.root, 'node_modules/fixed-unvisited'), {name: 'fixed-unvisited', dependencies: {'fixed-missing-leaf': '1.0.0'}});
        await rm(join(dependency, 'index.js')); await symlink('../fixed-unvisited/index.js', join(dependency, 'index.js'));
      }
      await fixtureDirectoryModes(f.root, 0o500);
      await assert.rejects(inspectSystemInstallation(f.root, f.policy), {code: 'SYSTEM_RUNTIME_FIXED'});
    });
  }
});

test('CLI preflight rejects lexical aliases before application imports or ordinary-runtime fallback', {skip: !linux}, async t => {
  for (const alias of ['root', 'entrypoint']) await t.test(alias, async t => {
    const f = await bootstrapFixture(t), outside = join(f.base, 'external-package');
    await rename(f.root, outside);
    if (alias === 'root') await symlink(outside, f.root);
    else {
      await mkdir(join(f.root, 'dist'), {recursive: true, mode: 0o700});
      await symlink(join(outside, 'dist/cli.js'), join(f.root, 'dist/cli.js'));
      await chmod(join(f.root, 'dist'), 0o500); await chmod(f.root, 0o500);
    }
    await f.refusedBeforeImport('--help'); await f.refusedBeforeImport('--version');
  });
});

test('fixed runtime serializes competing enrollment and rejects late metadata writers under ownership', {skip: !linux}, async t => {
  const f = await fixture(t); let firstFresh!: () => void, resume!: () => void;
  const entered = new Promise<void>(resolve => {firstFresh = resolve;});
  const blocked = new Promise<void>(resolve => {resume = resolve;});
  const first = f.prepare(async guarded => {if (guarded) {firstFresh(); await blocked;}});
  await entered;
  let secondAdmitted = false;
  const second = f.prepare(async () => {}).then(() => {secondAdmitted = true;});
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(secondAdmitted, false);
  resume(); await Promise.all([first, second]); assert.equal(secondAdmitted, true);
  const held = await acquireWriteGuard(join(f.directory, '.guard'), clock, clock.now() + 10_000);
  const waiting = f.ready();
  // A writer holding the actual shared lock publishes its final obligation
  // before release. Admission must reread, not use its earlier snapshot.
  await new Promise(resolve => setTimeout(resolve, 30));
  const retained = JSON.stringify({...JSON.parse(await readFile(f.state, 'utf8')), patching: true});
  await writeFile(f.state, retained); await held();
  await assert.rejects(waiting, {code: 'SYSTEM_RUNTIME_FIXED'});
  assert.equal(await readFile(f.state, 'utf8'), retained);
});

test('fixed runtime rejects replaced coordinator and data identities, external storage and credential paths', {skip: !linux}, async t => {
  const f = await fixture(t); await f.prepare();
  const bytes = await readFile(f.state, 'utf8');
  await rename(f.directory, join(f.paths.data, 'retained-coordinator'));
  await mkdir(f.directory, {mode: 0o700}); await writeFile(f.state, bytes, {mode: 0o600});
  await assert.rejects(f.ready(), {code: 'SYSTEM_RUNTIME_FIXED'});
  await assert.rejects(f.prepare(), {code: 'SYSTEM_RUNTIME_FIXED'});
  await assert.rejects(f.ready({data: f.base} as HelperPaths), {code: 'SYSTEM_RUNTIME_FIXED'});
  await assert.rejects(assertSystemRuntime(f.root, {...f.paths, credentialFile: join(f.base, 'credentials.json')}, f.policy), {code: 'SYSTEM_RUNTIME_FIXED'});
  await rename(f.paths.data, join(f.base, 'old-data')); await mkdir(f.paths.data, {mode: 0o700});
  await mkdir(f.directory, {mode: 0o700}); await writeFile(f.state, bytes, {mode: 0o600});
  await assert.rejects(f.ready(), {code: 'SYSTEM_RUNTIME_FIXED'});
});

test('fixed runtime never replaces a missing guard or admits on a substituted inode while its old lock is held', {skip: !linux}, async t => {
  const f = await fixture(t); await f.prepare();
  const guard = join(f.directory, '.guard'), retained = join(f.paths.data, 'retained-guard');
  const state = await readFile(f.state, 'utf8'), before = await inventory(f.root);
  const held = await acquireWriteGuard(guard, clock, clock.now() + 10_000);
  try {
    await rename(guard, retained);
    await assert.rejects(f.ready(), {code: 'SYSTEM_RUNTIME_FIXED'});
    await assert.rejects(f.prepare(), {code: 'SYSTEM_RUNTIME_FIXED'});
    await assert.rejects(lstat(guard), {code: 'ENOENT'});
    await writeFile(guard, '', {mode: 0o600});
    await assert.rejects(f.ready(), {code: 'SYSTEM_RUNTIME_FIXED'});
    await assert.rejects(f.prepare(), {code: 'SYSTEM_RUNTIME_FIXED'});
    assert.equal(await readFile(f.state, 'utf8'), state);
    assert.deepEqual(await inventory(f.root), before);
  } finally {await held();}
});
