import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {LINUX_FOLDER_ONLY_REASON} from '../src/shared/tool-capabilities.js';
import {TOOL_MATRIX} from '../src/shared/tool-matrix.js';
import {executeAdapterProbe, isAdapterProbeProfile, type AdapterProbeId, type AdapterProbeProfile, type RunSpec} from '../src/runner/adapter.js';
import {createCodexAdapter} from '../src/runner/adapters/codex.js';
import {cleanLinuxToolEnvironment, LINUX_CONTAINMENT_PATHS, linuxSandboxArguments} from '../src/runner/linux-containment.js';
import {enforceExecutableAdapter} from '../src/runner/process.js';
import {runToolCommand, withClaimedToolCommands, type ToolCommandOptions} from '../src/tool-command.js';

const bin = '/tools/codex/bin/codex';
const spec: RunSpec = {bin, cwd: '/work', runDir: '/work/.maddots/runs/fake', promptFile: '/work/prompt.md',
  model: 'model', provider: null, effort: null, access: 'full_access', skillsDir: '/work/.agents/skills',
  maxTurns: 1, timeoutSeconds: 30, runHome: null};

test('Codex Linux Full access requires no bundled bubblewrap, dummy interface or host socket metadata', async t => {
  const unexpected = async () => assert.fail('Linux Full access preflight must not inspect host paths or execute probes.');
  t.mock.method(fs, 'lstat', unexpected);
  t.mock.method(fs, 'access', unexpected);
  t.mock.method(fs, 'realpath', unexpected);
  syncBuiltinESMExports();
  t.after(() => {t.mock.restoreAll(); syncBuiltinESMExports();});
  const linux = createCodexAdapter(unexpected, {platform: 'linux'});
  assert.deepEqual(await linux.preflight!(spec), {ok: true, reason: null});
  assert.deepEqual(linux.supports(spec), {ok: true, reason: null});
  const invocation = linux.build(spec);
  assert(invocation.argv.includes('--dangerously-bypass-approvals-and-sandbox'));
  for (const nested of ['workspace-write', '--sandbox', '--unshare-user', 'isolated-run', 'bwrap']) {
    assert(!invocation.argv.includes(nested), nested);
  }
  assert.deepEqual(invocation.env, {TMPDIR: '/tmp', CODEX_HOME: '/work/.mdai-home/codex'});
});

test('Codex Linux socket temporary path follows S3 private /tmp regardless of hostile host runtime paths', async t => {
  const previous = {TMPDIR: process.env.TMPDIR, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR};
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const hostile of ['relative/runtime', '/missing/' + 'x'.repeat(200), '/public/shared/runtime']) {
    process.env.TMPDIR = hostile;
    process.env.XDG_RUNTIME_DIR = hostile;
    const linux = createCodexAdapter(async () => assert.fail('No host runtime probe may execute.'), {platform: 'linux'});
    assert.deepEqual(await linux.preflight!(spec), {ok: true, reason: null});
    const invocation = linux.build(spec);
    assert.deepEqual(invocation.env, {TMPDIR: '/tmp', CODEX_HOME: '/work/.mdai-home/codex'});
    const contained = cleanLinuxToolEnvironment({...invocation.env, TMPDIR: hostile}, '/fixture/run/work');
    assert.equal(contained.TMPDIR, '/tmp');
    assert(Buffer.byteLength(contained.TMPDIR) < 40, 'the S3 path leaves room for generated Unix socket names');
    assert(!JSON.stringify(invocation).includes(hostile));
  }
  const dataPath = `${LINUX_CONTAINMENT_PATHS.runs}/11111111-1111-4111-8111-111111111111`;
  const sandbox = linuxSandboxArguments(join(dataPath, 'work'), dataPath);
  assert.equal(sandbox[sandbox.indexOf('--tmpfs') + 1], '/tmp');
  assert(sandbox.includes('--disable-userns'));
  assert(sandbox.includes('--assert-userns-disabled'));
});

test('Codex Linux selects only the staged saved-login home and preserves silent local-provider invocations', () => {
  const linux = createCodexAdapter(undefined, {platform: 'linux'});
  const invocation = linux.build(spec);
  const contained = cleanLinuxToolEnvironment(invocation.env, '/fixture/run/work');
  assert.equal(contained.CODEX_HOME, '/work/.mdai-home/codex');
  assert.equal(contained.HOME, '/tmp/home');
  assert.deepEqual(invocation.files, []);
  assert.deepEqual(invocation.projectFiles, []);
  for (const flag of ['--ignore-user-config', 'apps', 'plugins', 'skill_mcp_dependency_install',
    'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'in_app_browser', 'computer_use']) {
    assert(invocation.argv.includes(flag), flag);
  }
  for (const provider of ['ollama', 'lmstudio']) {
    const local = linux.build({...spec, provider});
    assert.deepEqual(local.env, {TMPDIR: '/tmp'});
    assert.deepEqual(local.files, []);
    assert.deepEqual(local.projectFiles, []);
    assert(local.argv.includes('--oss'));
  }
});

test('Codex Linux statically refuses Folder only without runtime fallback', async () => {
  let calls = 0;
  const linux = createCodexAdapter(async () => {
    calls++;
    throw new Error('A refused access mode must not execute a probe.');
  }, {platform: 'linux'});
  const folder = {...spec, access: 'folder_only' as const};
  const refusal = {ok: false, reason: LINUX_FOLDER_ONLY_REASON};
  assert.deepEqual(linux.supports(folder), refusal);
  assert.deepEqual(await linux.preflight!(folder), refusal);
  assert.throws(() => linux.build(folder), /adapter_refused/u);
  assert.deepEqual(await linux.preflight!(folder), refusal);
  assert.equal(calls, 0);
});

test('Codex Linux Folder only refusal precedes identity and runtime checks even with accepted fixture metadata', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'mdai-codex-static-refusal-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const executable = join(root, 'codex'); await fs.writeFile(executable, 'fixture', {mode: 0o700});
  const linux = createCodexAdapter(undefined, {platform: 'linux'});
  const identity = t.mock.method(linux, 'identity', async () => assert.fail('Static refusal must precede identity.'));
  const preflight = t.mock.fn(async () => assert.fail('Static refusal must precede runtime checks.'));
  linux.preflight = preflight;
  const matrix = structuredClone(TOOL_MATRIX);
  Object.assign(matrix.tools.find(tool => tool.key === 'codex')!.run!, {
    offered: true, platforms: {darwin: {accepted: true}, linux: {accepted: true}},
  });
  assert.deepEqual(await enforceExecutableAdapter({...spec, bin: executable, access: 'folder_only', adapter: linux, matrix}),
    {ok: false, code: 'adapter_refused', version: null});
  assert.equal(identity.mock.callCount(), 0);
  assert.equal(preflight.mock.callCount(), 0);
});

test('Codex platform dispatch preserves Darwin and rejects unsupported or invalid Linux inputs', async () => {
  const unexpected = async () => assert.fail('Platform and access checks must not execute a probe.');
  const linux = createCodexAdapter(unexpected, {platform: 'linux'});
  assert.equal((await linux.preflight!()).ok, false);
  assert.equal((await linux.preflight!({...spec, bin: 'codex'})).ok, false);
  for (const access of [undefined, null, '', 'invalid']) {
    const input = {...spec, access} as unknown as RunSpec;
    assert.equal(linux.supports(input).ok, false);
    assert.equal((await linux.preflight!(input)).ok, false);
    assert.throws(() => linux.build(input), /adapter_refused/u);
  }
  const darwin = createCodexAdapter(unexpected, {platform: 'darwin'});
  assert.deepEqual(await darwin.preflight!(), {ok: true, reason: null});
  assert.deepEqual(darwin.supports({...spec, access: 'folder_only'}), {ok: true, reason: null});
  assert(darwin.build({...spec, access: 'folder_only'}).argv.includes('workspace-write'));
  assert.deepEqual(darwin.build(spec).env, {});
  for (const platform of ['win32', 'freebsd'] as const) {
    const unsupported = createCodexAdapter(unexpected, {platform});
    assert.equal(unsupported.supports(spec).ok, false);
    assert.equal((await unsupported.preflight!(spec)).ok, false);
    assert.throws(() => unsupported.build(spec), /adapter_refused/u);
  }
});

test('Codex Full access preflight refuses cancelled or expired operations without executable probes', async () => {
  const linux = createCodexAdapter(async () => assert.fail('Invalid operations must not execute.'), {platform: 'linux'});
  const controller = new AbortController(); controller.abort();
  assert.equal((await linux.preflight!({...spec, operation: {signal: controller.signal}})).ok, false);
  for (const deadline of [0, Date.now() - 1, NaN, Infinity]) {
    assert.equal((await linux.preflight!({...spec, operation: {deadline}})).ok, false);
  }
});

test('Codex identity bounds closed profiles and Linux claims require authentic operation authority', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'mdai-codex-identity-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const executable = join(root, 'codex'); await fs.writeFile(executable, 'fixture');
  const controller = new AbortController(), deadline = Date.now() + 1000;
  let calls = 0;
  const runner = async (file: string, argv: readonly string[], input?: ToolCommandOptions) => {
    calls++;
    const options = input as ToolCommandOptions;
    assert.equal(file, executable); assert.deepEqual(argv, ['--version']);
    assert.equal(options.probe?.id, 'codex.version');
    assert.equal(options.probe?.purpose, 'identity');
    assert.equal(isAdapterProbeProfile(options.probe, file, argv), true);
    assert.equal(options.signal, controller.signal);
    assert(options.timeout! > 0 && options.timeout! <= 1000);
    return {stdout: 'codex-cli 0.162.1', stderr: ''};
  };
  const linux = createCodexAdapter(runner, {platform: 'linux'});
  for (const operation of [undefined, Object.freeze({kind: 'linux-acceptance-operation' as const})]) {
    assert.deepEqual(await withClaimedToolCommands({tool: 'codex', file: executable, deadline,
      signal: controller.signal, contained: true, operation}, () => linux.identity(executable, {signal: controller.signal, deadline})),
    {ok: false, version: null});
  }
  assert.equal(calls, 0, 'a contained claim or fabricated operation must not dispatch a Linux identity probe');
  // The shared profile transport can be exercised without release signing keys.
  const darwin = createCodexAdapter(runner, {platform: 'darwin'});
  assert.deepEqual(await darwin.identity(executable, {signal: controller.signal, deadline}), {ok: true, version: '0.162.1'});
  controller.abort();
  assert.equal((await darwin.identity(executable, {signal: controller.signal})).ok, false);
  assert.equal((await darwin.identity(executable, {deadline: Date.now() - 1})).ok, false);
  assert.equal(calls, 1);
});

test('Closed adapter probe profiles refuse fabricated, changed and removed nested-sandbox commands', async () => {
  let captured: AdapterProbeProfile | undefined;
  await executeAdapterProbe(async (file, argv, options) => {
    captured = options?.probe;
    assert.equal(isAdapterProbeProfile(captured, file, argv), true);
    return {stdout: '', stderr: ''};
  }, 'codex.version', bin, undefined, {platform: 'darwin'});
  assert(captured);
  assert(Object.isFrozen(captured)); assert(Object.isFrozen(captured.argv));
  assert.equal(isAdapterProbeProfile({...captured}, bin, ['--version']), false);
  assert.equal(isAdapterProbeProfile(captured, '/other/codex', ['--version']), false);
  assert.equal(isAdapterProbeProfile(captured, bin, ['exec']), false);
  await assert.rejects(runToolCommand(bin, ['exec'], {probe: captured}), {code: 'COMMAND_FAILED'});
  await assert.rejects(runToolCommand(bin, ['--version'], {probe: {...captured}}), {code: 'COMMAND_FAILED'});
  for (const id of ['codex.interface', 'codex.bubblewrap']) {
    await assert.rejects(executeAdapterProbe(async () => assert.fail('Removed profiles must not execute.'),
      id as AdapterProbeId, '/usr/bin/tool'));
  }
});
