import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import filesystem, {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';
import type {RuntimeContext} from '../src/runtime.js';

const fixedRoot = '/usr/local/libexec/mdai/helper';

/** Exercise the shipped modules with a captured fixed invocation, without
 * creating the real installation or launching another process. */
async function fixture(t: TestContext, fixedInvocation: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'mdai-runtime-children-'));
  // Retain the cleanup function before the no-mutation spies are installed.
  const remove = rm;
  t.after(async () => {t.mock.restoreAll(); syncBuiltinESMExports(); await remove(root, {recursive: true, force: true});});
  await writeFile(join(root, 'package.json'), JSON.stringify({type: 'module'}));
  for (const [name, sourceUrl] of [
    ['config', new URL('../src/config.ts', import.meta.url)],
    ['platform', new URL('../src/platform.ts', import.meta.url)],
    ['linux-proc', new URL('../src/linux-proc.ts', import.meta.url)],
    ['system-runtime-preflight', new URL('../src/system-runtime-preflight.ts', import.meta.url)],
  ] as const) {
    const source = await readFile(sourceUrl, 'utf8');
    const emitted = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022}}).outputText;
    await writeFile(join(root, name + '.js'), emitted);
  }
  const invocation = process.argv[1];
  let preflight: typeof import('../src/system-runtime-preflight.js');
  try {
    process.argv[1] = fixedInvocation ? join(fixedRoot, 'dist/cli.js') : join(root, 'cli.js');
    preflight = await import(pathToFileURL(join(root, 'system-runtime-preflight.js')).href);
  } finally {
    if (invocation === undefined) delete process.argv[1];
    else process.argv[1] = invocation;
  }
  const config = await import(pathToFileURL(join(root, 'config.js')).href) as typeof import('../src/config.js');
  const proc = await import(pathToFileURL(join(root, 'linux-proc.js')).href) as typeof import('../src/linux-proc.js');
  const updater = pathToFileURL(join(root, 'updater.js')).href;
  const script = `import {verifyReleaseBundle} from ${JSON.stringify(updater)};let input='';for await(const chunk of process.stdin)input+=chunk;try{const d=JSON.parse(input);process.stdout.write(JSON.stringify(await verifyReleaseBundle(d.identity,d.bundle,d.cache)))}catch{process.exitCode=1}`;
  return {root, config, proc, preflight, args: ['--input-type=module', '-e', script]};
}

function observeEffects(t: TestContext) {
  const launches: string[] = [], mutations: string[] = [];
  t.mock.method(childProcess, 'execFile', ((file: string, _args: string[], _options: childProcess.ExecFileOptions,
    done: (error: null, stdout: string, stderr: string) => void) => {
    launches.push(file);
    queueMicrotask(() => done(null, 'utility result', ''));
    return {stdin: Object.assign(new EventEmitter(), {end() {}})};
  }) as typeof childProcess.execFile);
  t.mock.method(childProcess, 'spawn', (() => {launches.push('spawn'); throw new Error('unexpected child');}) as typeof childProcess.spawn);
  for (const name of ['mkdtemp', 'copyFile', 'chmod', 'open', 'rm'] as const) {
    t.mock.method(filesystem, name, async () => {mutations.push(name); throw new Error('unexpected filesystem mutation');});
  }
  syncBuiltinESMExports();
  return {launches, mutations};
}

test('fixed invocation refuses helper-created Node children before process or filesystem effects', {skip: process.platform !== 'linux'}, async t => {
  const f = await fixture(t, true), effects = observeEffects(t);
  await assert.rejects(f.config.runCommand(process.execPath, f.args), {code: 'SYSTEM_RUNTIME_FIXED'});
  const runtime: RuntimeContext = {bundledRoot: f.root, runningRoot: f.root, bootstrapVersion: '0.1.0', bootstrapEntrypoint: join(f.root, 'cli.js')};
  await assert.rejects(f.config.createRuntimeRunner(runtime)(process.execPath, f.args), {code: 'SYSTEM_RUNTIME_FIXED'});
  let inspected = false;
  await assert.rejects(f.proc.verifyLinuxProcExecutable(async () => {inspected = true; return undefined;}), {code: 'SYSTEM_RUNTIME_FIXED'});
  assert.equal(inspected, false);
  assert.deepEqual(effects, {launches: [], mutations: []});
  assert.deepEqual(await f.config.runCommand('/usr/bin/systemctl', ['show', 'mdai-helper.service', '--property=Id']),
    {stdout: 'utility result', stderr: ''});
  assert.deepEqual(effects, {launches: ['/usr/bin/systemctl'], mutations: []});
});

test('explicit fixed runtime roots refuse Node utilities while ordinary mode preserves the reviewed verifier', {skip: process.platform !== 'linux'}, async t => {
  const f = await fixture(t, false), effects = observeEffects(t);
  for (const roots of [{bundledRoot: fixedRoot, runningRoot: f.root}, {bundledRoot: f.root, runningRoot: fixedRoot}]) {
    const runtime: RuntimeContext = {...roots, bootstrapVersion: '0.1.0', bootstrapEntrypoint: join(roots.bundledRoot, 'dist/cli.js')};
    await assert.rejects(f.config.createRuntimeRunner(runtime)(process.execPath, f.args), {code: 'SYSTEM_RUNTIME_FIXED'});
  }
  assert.deepEqual(effects, {launches: [], mutations: []});
  assert.deepEqual(await f.config.runCommand(process.execPath, f.args), {stdout: 'utility result', stderr: ''});
  assert.deepEqual(effects, {launches: [process.execPath], mutations: []});
});

test('fixed startup input refusals report their reason before any installation filesystem work', {skip: process.platform !== 'linux'}, async t => {
  const f = await fixture(t, true), effects = observeEffects(t), inspected: string[] = [];
  for (const name of ['lstat', 'readdir', 'readlink', 'realpath'] as const) {
    t.mock.method(filesystem, name, async () => {inspected.push(name); throw new Error('unexpected installation inspection');});
  }
  for (const name of ['lstatSync', 'realpathSync'] as const) {
    t.mock.method(fs, name, () => {inspected.push(name); throw new Error('unexpected installation inspection');});
  }
  syncBuiltinESMExports();
  const original = {argv: process.argv, execArgv: process.execArgv, NODE_OPTIONS: process.env.NODE_OPTIONS, NODE_PATH: process.env.NODE_PATH};
  const vectors: {env?: NodeJS.ProcessEnv; execArgv?: string[]; args?: string[]; reason: RegExp}[] = [
    ...['NODE_OPTIONS', 'NODE_PATH'].flatMap(name => ['', name === 'NODE_OPTIONS' ? '--no-warnings' : '/untrusted/modules']
      .map(value => ({env: {[name]: value}, reason: new RegExp(`refuses ${name} in its startup environment`, 'u')}))),
    ...[['--no-warnings'], ['--inspect'], ['--inspect-port=0'], ['--import=data:text/javascript,export{}'], ['--require', '/untrusted/preload.cjs'],
      ['--disable-sigusr1', '--no-warnings'], ['--disable-sigusr1', '--inspect'], ['--disable-sigusr1', '--inspect-port=0'],
      ['--disable-sigusr1', '--disable-sigusr1']]
      .map(execArgv => ({execArgv, reason: /refuses process.execArgv other than exactly --disable-sigusr1/u})),
    {args: ['service'], reason: /requires --disable-sigusr1 for service mode/u},
    ...['--import', '--import=outside.mjs', '--require', '--require=outside.cjs', '-r', '-routside.cjs', '--loader',
      '--loader=outside.mjs', '--experimental-loader=outside.mjs', '--experimental-import-meta-resolve']
      .map(argument => ({args: ['--help', argument], reason: /refuses Node preload and loader flags in its command arguments/u})),
  ];
  try {
    for (const vector of vectors) {
      delete process.env.NODE_OPTIONS; delete process.env.NODE_PATH;
      Object.assign(process.env, vector.env);
      process.execArgv = vector.execArgv ?? [];
      process.argv = [original.argv[0], join(fixedRoot, 'dist/cli.js'), ...vector.args ?? ['--version']];
      await assert.rejects(f.preflight.preflightSystemRuntime(), {code: 'SYSTEM_RUNTIME_FIXED', message: vector.reason});
      assert.deepEqual(inspected, []);
      assert.deepEqual(effects, {launches: [], mutations: []});
    }
  } finally {
    process.argv = original.argv; process.execArgv = original.execArgv;
    for (const name of ['NODE_OPTIONS', 'NODE_PATH'] as const) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  }
});

test('fixed preflight accepts the single signal-disabling flag before inspecting the installation', {skip: process.platform !== 'linux'}, async t => {
  const f = await fixture(t, true), inspected: string[] = [], inspection = new Error('accepted startup reached installation inspection');
  t.mock.method(filesystem, 'lstat', async (path: unknown) => {inspected.push(String(path)); throw inspection;});
  syncBuiltinESMExports();
  const original = {argv: process.argv, execArgv: process.execArgv, NODE_OPTIONS: process.env.NODE_OPTIONS, NODE_PATH: process.env.NODE_PATH};
  try {
    delete process.env.NODE_OPTIONS; delete process.env.NODE_PATH;
    process.execArgv = ['--disable-sigusr1'];
    for (const command of ['--version', 'service']) {
      process.argv = [original.argv[0], join(fixedRoot, 'dist/cli.js'), command];
      await assert.rejects(f.preflight.preflightSystemRuntime(), error => error === inspection);
      assert.deepEqual(inspected.splice(0), [join(fixedRoot, 'dist/cli.js')]);
    }
  } finally {
    process.argv = original.argv; process.execArgv = original.execArgv;
    for (const name of ['NODE_OPTIONS', 'NODE_PATH'] as const) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  }
});
