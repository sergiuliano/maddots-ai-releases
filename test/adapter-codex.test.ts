import {directFixtureProcesses} from './native-process-fixture.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { beforeEach, type TestContext } from 'node:test';
import { TOOL_MATRIX } from '../src/shared/tool-matrix.js';
import type { Runner } from '../src/config.js';
import type { RunSpec } from '../src/runner/adapter.js';
import { codexAdapter, createCodexAdapter } from '../src/runner/adapters/codex.js';
import { buildToolEnvironment, enforceAdapter, enforceExecutableAdapter, startTool, type ProcessInspector } from '../src/runner/process.js';
import {refusalLinuxLifecycle, scopedAdapterPlatform} from './support/adapter-platform-fixture.js';
import {linuxNativeWorkloadSkip, observeNativeLinuxWorkloads, startNativeFixtureTool} from './support/linux-native-workloads.js';
import {initializeCleanRunnerJournal} from './support/runner-journal-fixture.js';
import {CODEX_FIXTURE_PROVIDER} from './support/codex-local-provider-fixture.js';

// Never retain or restore inherited production profile selections in this fixture worker.
beforeEach(() => {
  delete process.env.MDAI_CODEX_LOGIN_PROFILE;
  delete process.env.MDAI_CLAUDE_LOGIN_PROFILE;
});

const fixtures = fileURLToPath(new URL('./fixtures/adapters/codex/', import.meta.url));
const fixtureText = (name: string) => readFileSync(join(fixtures, name), 'utf8');
const matrix = JSON.parse(fixtureText('golden.json'));
const spec: RunSpec = { bin: '/recorded path/codex', cwd: '/work path/project', runDir: '/work path/project/.maddots/runs/fixture',
  promptFile: '/work path/project/.maddots/runs/fixture/prompt.md', model: 'gpt-6.1', provider: null, effort: null, access: 'folder_only',
  skillsDir: '/work path/project/.agents/skills', maxTurns: 50, timeoutSeconds: 120, runHome: null };
const darwinAdapter = createCodexAdapter(undefined, {platform: 'darwin'});
const failed = { ok: false, text: '', failureCode: 'tool_failed' };
const linuxNativeServiceSkip = process.platform === 'linux' && (process.getuid?.() !== 999 || userInfo().username !== 'mdai')
  ? 'Native Linux launch requires the dedicated mdai UID 999 system service with delegated cgroup v2, namespaces and guardian.'
  : linuxNativeWorkloadSkip;
async function folder(t: TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-adapter-codex-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function nativeMatrix() {
  const offered = structuredClone(TOOL_MATRIX);
  Object.assign(offered.tools.find(tool => tool.key === 'codex')!.run!, { offered: true,
    platforms: {darwin: {accepted: true}, linux: {accepted: true}}, folderOnly: 'os-sandbox' });
  return offered;
}
const expand = (args: string[], input: RunSpec) => args.map(arg => arg.replaceAll('{bin}', input.bin).replaceAll('{cwd}', input.cwd)
  .replaceAll('{runDir}', input.runDir).replaceAll('{model}', input.model).replaceAll('{effort}', input.effort ?? ''));

for (const access of ['folder_only', 'full_access'] as const) {
  test(`Codex golden argv: ${access}, model, stdin, no MCP or browser`, () => {
    const input = { ...spec, access };
    const invocation = createCodexAdapter(undefined, {platform: 'darwin'}).build(input);
    const base = expand(matrix.headlessCommand.argv, input);
    assert.equal(base.pop(), '-');
    assert.deepEqual(invocation, {
      argv: [...base, ...expand(matrix.modelFlag.args, input), ...(access === 'folder_only' ? matrix.folderOnlyFlags.args : matrix.fullAccessFlags.args),
        ...matrix.noMcpMethod.args, ...matrix.noBrowserMethod.args, '-'],
      env: matrix.headlessCommand.env, envUnset: matrix.headlessCommand.envUnset, stdinFile: input.promptFile,
      files: [], projectFiles: [], spawnCwd: null, secretEnv: {},
    });
    for (const flag of ['-p', '--bare', '--mcp-config', '--approve-mcps', '--allow-all-paths', '--allow-all-urls', '-k', '--key', '--api-key', '--mcp']) assert(!invocation.argv.includes(flag), flag);
    assert.equal(invocation.argv.includes('--dangerously-bypass-approvals-and-sandbox'), access === 'full_access');
    assert.equal(invocation.argv.includes('workspace-write'), access === 'folder_only');
  });
}

test('Codex provider and effort composition keeps arguments separate and saved login by default', () => {
  for (const provider of [null, 'ollama', 'lmstudio']) for (const effort of [null, 'high']) {
    const argv = darwinAdapter.build({ ...spec, provider, effort }).argv;
    assert.equal(argv.includes('--oss'), provider !== null);
    assert.equal(argv.includes('--local-provider'), provider !== null);
    if (provider) assert.equal(argv[argv.indexOf('--local-provider') + 1], provider);
    assert.equal(argv.includes('-c'), effort !== null);
    if (effort) assert.equal(argv[argv.indexOf('-c') + 1], 'model_reasoning_effort=high');
    assert.equal(argv.at(-1), '-');
  }
});

test('Codex supports only the matrix providers, explicit access and safe model/effort values', () => {
  for (const provider of [null, 'ollama', 'lmstudio']) for (const access of ['folder_only', 'full_access'] as const) {
    assert.deepEqual(darwinAdapter.supports({ ...spec, provider, access, model: 'qwen3-coder:30b' }), { ok: true, reason: null });
  }
  for (const provider of ['openai', 'openrouter', 'custom', '']) assert.equal(darwinAdapter.supports({ ...spec, provider }).ok, false);
  for (const model of ['', ' ', '-m', 'model\n--search', 'model\0']) assert.equal(darwinAdapter.supports({ ...spec, model }).ok, false);
  for (const effort of ['', 'high\n', 'high --search']) assert.equal(darwinAdapter.supports({ ...spec, effort }).ok, false);
  for (const access of ['default', undefined, null]) {
    const input = { ...spec, access } as unknown as RunSpec;
    assert.equal(darwinAdapter.supports(input).ok, false);
    assert.throws(() => darwinAdapter.build(input), /adapter_refused/u);
  }
  assert.throws(() => darwinAdapter.build({ ...spec, provider: 'custom' }), /adapter_refused/u);
});

test('Codex metadata routes verified staged skills to the project without changing personal skills', () => {
  assert.deepEqual(codexAdapter.info, { tool: 'codex', harness: 'codex', card: 'TLS-26', folderOnly: 'os-sandbox', mcpLevel: 'servers-off',
    skillsDir: '{cwd}/.agents/skills', promptVia: 'stdin', runHome: false });
  assert.equal(TOOL_MATRIX.tools.find(tool => tool.key === 'codex')!.run!.folderOnly, 'os-sandbox');
  const invocation = darwinAdapter.build(spec);
  assert.deepEqual(invocation.files, []);
  assert.deepEqual(invocation.projectFiles, []);
  assert(!invocation.argv.some(arg => arg.includes('~')));
});

test('Codex identity checks the canonical executable and exact version output, refusing launchers', async t => {
  scopedAdapterPlatform(t, 'darwin');
  const root = await folder(t), bin = join(root, 'codex-0.162.1');
  await writeFile(bin, 'fixture', { mode: 0o700 });
  const link = join(root, 'codex'); await symlink(bin, link);
  const calls: { file: string; args: readonly string[]; timeout?: number }[] = [];
  let output = 'codex-cli 0.162.1\n';
  const runner: Runner = async (file, args, options) => { calls.push({ file, args, timeout: options?.timeout }); return { stdout: output, stderr: '' }; };
  const adapter = createCodexAdapter(runner);
  assert.deepEqual(await adapter.identity(link), { ok: true, version: '0.162.1' });
  assert.deepEqual(calls, [{ file: bin, args: ['--version'], timeout: 10_000 }]);
  for (const stdout of ['', '0.162.1', 'other-cli 0.162.1', 'codex-cli nope', 'codex-cli 0.162.1\nextra']) {
    output = stdout; assert.deepEqual(await adapter.identity(bin), { ok: false, version: null });
  }
  for (const name of ['agent', 'codex-pool', 'codex-security', 'codex-code-mode-host']) {
    const alias = join(root, name); await symlink(bin, alias);
    assert.deepEqual(await adapter.identity(alias), { ok: false, version: null });
    const target = join(root, `${name}-0.162.1`); await writeFile(target, 'fixture');
    const hidden = join(root, `link-${name}`); await symlink(target, hidden);
    assert.deepEqual(await adapter.identity(hidden), { ok: false, version: null });
  }
  assert.deepEqual(await adapter.identity('codex'), { ok: false, version: null });
  assert.deepEqual(await adapter.identity(join(root, 'missing')), { ok: false, version: null });
  const unavailable = createCodexAdapter(async () => { throw new Error('private command output must not escape'); });
  assert.deepEqual(await unavailable.identity(bin), { ok: false, version: null });
});

test('Codex parses NDJSON and reads final text only from last-message.txt', async t => {
  const runDir = await folder(t);
  await copyFile(join(fixtures, 'last-message.txt'), join(runDir, 'last-message.txt'));
  assert.deepEqual(codexAdapter.parse({ stdout: fixtureText('success.jsonl'), stderr: 'harmless warning', exitCode: 0, signal: null, runDir }),
    { ok: true, text: fixtureText('last-message.txt').trim(), failureCode: null });
});

for (const fixture of ['failure.jsonl', 'error.jsonl']) {
  test(`Codex ${fixture} fails even with exit 0 and a plausible final file`, async t => {
    const runDir = await folder(t); await writeFile(join(runDir, 'last-message.txt'), 'Do not post this');
    assert.deepEqual(codexAdapter.parse({ stdout: fixtureText(fixture), stderr: '', exitCode: 0, signal: null, runDir }), failed);
  });
}

test('Codex refuses unsuccessful exits, signals, malformed or incomplete streams', async t => {
  const runDir = await folder(t); await writeFile(join(runDir, 'last-message.txt'), 'Do not post this');
  for (const [exitCode, signal] of [[1, null], [null, null], [0, 'SIGTERM'], [130, 'SIGINT']] as const) {
    assert.deepEqual(codexAdapter.parse({ stdout: fixtureText('success.jsonl'), stderr: '', exitCode, signal, runDir }), failed);
  }
  for (const stdout of ['', 'not JSON', '{}', 'null', '[]', '{"type":42}', '{"type":"turn.started"}', `${fixtureText('success.jsonl')}{"type":`]) {
    assert.deepEqual(codexAdapter.parse({ stdout, stderr: '', exitCode: 0, signal: null, runDir }), failed);
  }
});

test('Codex reports empty or missing final output without posting intermediate event text', async t => {
  const runDir = await folder(t);
  for (const contents of [null, '', ' \n\t ']) {
    if (contents !== null) await writeFile(join(runDir, 'last-message.txt'), contents);
    assert.deepEqual(codexAdapter.parse({ stdout: fixtureText('empty.jsonl'), stderr: '', exitCode: 0, signal: null, runDir }),
      { ok: false, text: '', failureCode: 'output_empty' });
  }
});

test('Codex refuses symlinked, non-regular and oversized final output files', async t => {
  const root = await folder(t), runDir = join(root, 'run'); await mkdir(runDir);
  const path = join(runDir, 'last-message.txt'), other = join(root, 'private.txt');
  await writeFile(other, 'outside result'); await symlink(other, path);
  const parse = () => codexAdapter.parse({ stdout: fixtureText('success.jsonl'), stderr: '', exitCode: 0, signal: null, runDir });
  assert.deepEqual(parse(), failed);
  await rm(path); await mkdir(path); assert.deepEqual(parse(), failed);
  await rm(path, { recursive: true }); await writeFile(path, ''); await truncate(path, 50 * 1024 * 1024 + 1);
  assert.deepEqual(parse(), { ok: false, text: '', failureCode: 'output_too_large' });
});

test('Codex default matrix remains unoffered until real canary and Folder only acceptance', async t => {
  const root = await folder(t), bin = join(root, 'codex'); await writeFile(bin, 'fixture', { mode: 0o700 });
  const adapter = createCodexAdapter(async () => ({ stdout: 'codex-cli 0.162.1\n', stderr: '' }));
  const input = { ...spec, bin, adapter };
  assert.equal(TOOL_MATRIX.tools.find(tool => tool.key === 'codex')!.run!.offered, false);
  assert.equal((await enforceAdapter(input)).code, 'adapter_refused');
  await assert.rejects(startTool({adapter, spec: input, linuxLifecycle: refusalLinuxLifecycle(t),
    claimedAt: Date.now(), expiresAt: Date.now() + 7_200_000, maxRunMinutes: 1}), {code: 'adapter_refused'});
});

test('Codex Darwin environment uses the core allowlist with no credentials or MadDots values', async t => {
  scopedAdapterPlatform(t, 'darwin');
  const invocation = darwinAdapter.build(spec);
  const env = await buildToolEnvironment(process.execPath, invocation.env, invocation.envUnset, {
    HOME: '/fixture-home', PATH: '/untrusted-bin', OPENAI_API_KEY: 'sentinel-key', MADDOTS_URL: 'https://private.invalid',
    USER: 'pm_run_sentinel', LANG: 'C', CODEX_HOME: '/private-sentinel',
  });
  assert.equal(env.HOME, '/fixture-home'); assert.equal(env.LANG, 'C');
  for (const name of ['OPENAI_API_KEY', 'MADDOTS_URL', 'USER', 'CODEX_HOME']) assert.equal(env[name], undefined);
  assert.equal(env.TERM, 'dumb'); assert.equal(env.NO_COLOR, '1');
});

test('Codex Linux environment excludes host HOME, user configuration and ambient credentials', async t => {
  scopedAdapterPlatform(t, 'linux');
  const invocation = createCodexAdapter(undefined, {platform: 'linux'}).build({...spec, access: 'full_access'});
  const env = await buildToolEnvironment(process.execPath, invocation.env, invocation.envUnset,
    {HOME: '/host/home', SSH_AUTH_SOCK: '/host/agent', OPENAI_API_KEY: 'synthetic', CODEX_HOME: '/host/config'});
  for (const key of ['HOME', 'SSH_AUTH_SOCK', 'OPENAI_API_KEY']) assert.equal(env[key], undefined);
  assert.equal(env.CODEX_HOME, '/work/.mdai-home/codex');
  assert.equal(env.TERM, 'dumb'); assert.equal(env.NO_COLOR, '1');
});

for (const platform of ['darwin', 'linux'] as const) {
  test(`Codex ${platform} static eligibility precedes executable authorization`, async t => {
    scopedAdapterPlatform(t, platform);
    const root = await folder(t), bin = join(root, 'codex'); await writeFile(bin, 'fixture', {mode: 0o700});
    const identity = t.mock.fn(async () => assert.fail('Admission without operation authority must not execute identity.'));
    const preflight = t.mock.fn(async () => assert.fail('Admission without operation authority must not execute preflight.'));
    const adapter = {...createCodexAdapter(undefined, {platform}), identity, preflight};
    for (const access of ['folder_only', 'full_access'] as const) {
      const input = {...spec, bin, access, adapter};
      if (platform === 'linux' && access === 'folder_only') {
        assert.equal((await enforceAdapter(input)).code, 'adapter_refused');
        continue;
      }
      // Linux candidate eligibility is deliberately available before a claim.
      // Executable admission still requires an authentic operation handle.
      assert.deepEqual(await enforceAdapter(input), platform === 'linux' ? {ok: true, code: null, version: null} :
        {ok: false, code: 'adapter_refused', version: null});
      if (platform === 'linux') {
        for (const acceptanceOperation of [undefined, Object.freeze({kind: 'linux-acceptance-operation' as const})]) {
          assert.deepEqual(await enforceExecutableAdapter({...input, acceptanceOperation}), {ok: false, code: 'adapter_refused', version: null});
        }
      }
      assert.deepEqual(await enforceAdapter({...input, matrix: nativeMatrix()}), {ok: true, code: null, version: null});
    }
    assert.equal(identity.mock.callCount(), 0);
    assert.equal(preflight.mock.callCount(), 0);
  });
}

for (const platform of ['darwin', 'linux'] as const) for (const access of platform === 'linux' ? ['full_access'] as const : ['folder_only', 'full_access'] as const) {
  const skip = process.platform !== platform ? `Platform-only native ${platform} launch fixture.` : platform === 'linux' ? linuxNativeServiceSkip : false;
  test(`Codex launches through the real core with staged project skills and ${access} [native ${platform}]`, {skip, timeout: 45_000}, async t => {
    const root = await folder(t), cwd = join(root, 'project with spaces'), runDir = join(cwd, '.maddots/runs/fixture');
    await mkdir(runDir, { recursive: true });
    const skillsDir = join(cwd, '.agents/skills'); await mkdir(join(skillsDir, 'fixture-skill'), { recursive: true });
    await writeFile(join(skillsDir, 'fixture-skill/SKILL.md'), '---\nname: fixture-skill\n---\nstaged-fixture-skill');
    const promptFile = join(runDir, 'prompt.md'); await writeFile(promptFile, '# Task from MadDots\nUse fixture-skill\n' + 'material\n'.repeat(10_000));
    const bin = join(root, 'codex'); await copyFile(join(fixtures, 'fake-codex.mjs'), bin); await chmod(bin, 0o700);
    // Authentication is outside this staged-skill launch contract. The fake CLI
    // uses a local provider and cannot open any selected saved-login profile.
    const input = { ...spec, bin, cwd, runDir, promptFile, skillsDir, access, provider: CODEX_FIXTURE_PROVIDER };
    const offered = nativeMatrix();
    const processes: ProcessInspector = directFixtureProcesses();
    const options = { adapter: createCodexAdapter(undefined, {platform}), spec: input, matrix: offered, processes, claimedAt: Date.now(), expiresAt: Date.now() + 7_200_000, maxRunMinutes: 1 };
    let clean = false;
    const data = platform === 'linux' ? await mkdtemp(join(await realpath(tmpdir()), 'mdai-native-codex-data-')) : undefined;
    if (data) {
      await initializeCleanRunnerJournal(data);
      const observer = observeNativeLinuxWorkloads(t);
      t.after(async () => {await observer.cleanup(); if (clean) await rm(data, {recursive: true, force: true});});
    }
    const child = data ? await startNativeFixtureTool(data, options) : await startTool(options);
    assert.deepEqual(await child.finished, { ok: true, text: 'Fixture completed with staged-fixture-skill.', failureCode: null, exitCode: 0, signal: null, stopped: false },
      await readFile(join(runDir, 'stderr.log'), 'utf8'));
    assert.match(await readFile(join(runDir, 'stdout.log'), 'utf8'), /turn.completed/u);
    clean = true;
  });
}
