import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TOOL_MATRIX } from '../src/shared/tool-matrix.js';
import type { Adapter, RunSpec } from '../src/runner/adapter.js';
import { createOpenCodeAdapter, inspectOpenCodeOutput, openCodeAdapter as adapter, openCodeManagedPaths, openCodeRunPaths } from '../src/runner/adapters/opencode.js';
import { buildToolEnvironment, enforceAdapter, startTool, type ProcessInspector } from '../src/runner/process.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/adapters/opencode/${name}`, import.meta.url));
const spec: RunSpec = {
  bin: '/fixture/home/.local/bin/opencode', cwd: '/fixture/project with spaces',
  runDir: '/fixture/project with spaces/.maddots/runs/run-1', promptFile: '/fixture/project with spaces/.maddots/runs/run-1/prompt.md',
  model: 'qwen3:8b', provider: 'ollama', effort: 'high', access: 'full_access',
  skillsDir: '/fixture/project with spaces/.maddots/runs/run-1/skills', maxTurns: 50, timeoutSeconds: 120, runHome: null,
};
const permission = { '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow', edit: 'allow', bash: 'allow',
  skill: 'allow', todowrite: 'allow', todoread: 'allow', external_directory: 'allow', task: 'deny', question: 'deny',
  webfetch: 'deny', websearch: 'deny', codesearch: 'deny', 'mcp*': 'deny', 'browser*': 'deny' };
const sessionID = 'ses_fixture';
const part = (type: string, properties: Record<string, unknown> = {}) => ({
  id: `prt_${type}`, sessionID, messageID: 'msg_fixture', type, ...properties,
});
const row = (type: string, value: Record<string, unknown>) => ({ type, timestamp: 123, sessionID, part: value });
const start = row('step_start', part('step-start'));
const text = row('text', part('text', { text: 'Done.', time: { start: 1, end: 2 } }));
const finish = row('step_finish', part('step-finish', { reason: 'stop' }));
const jsonl = (...rows: unknown[]) => `${rows.map(value => JSON.stringify(value)).join('\n')}\n`;
const parse = (stdout: string, overrides: Partial<Parameters<Adapter['parse']>[0]> = {}) => adapter.parse({
  stdout, stderr: '', exitCode: 0, signal: null, runDir: spec.runDir, ...overrides,
});
const processes: ProcessInspector = { table: async () => [], fencePids: async () => [], identity: async pid => {
  try { process.kill(pid, 0); return `fixture-${pid}`; } catch { return null; }
} };

async function temporary(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-opencode-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function executable(root: string, mode = 'normal'): Promise<string> {
  const bin = join(root, mode, 'opencode');
  await mkdir(dirname(bin), { recursive: true }); await copyFile(fixture('fake-cli.mjs'), bin); await chmod(bin, 0o700);
  return bin;
}
async function runSpec(t: TestContext, prompt = 'Complete the fixture task.'): Promise<RunSpec> {
  const root = await temporary(t), cwd = join(root, 'project with spaces'), runDir = join(cwd, '.maddots/runs/fixture');
  await mkdir(runDir, { recursive: true });
  const bin = await executable(root), promptFile = join(runDir, 'prompt.md'), skillsDir = join(runDir, 'skills');
  await writeFile(promptFile, prompt); await mkdir(join(skillsDir, 'fixture'), { recursive: true });
  await writeFile(join(skillsDir, 'fixture/SKILL.md'), '---\nname: fixture\ndescription: A fixture skill\n---\nSKILL_SEEN');
  return { ...spec, bin, cwd, runDir, promptFile, skillsDir };
}
function matrix() {
  const result = structuredClone(TOOL_MATRIX);
  Object.assign(result.tools.find(tool => tool.key === 'opencode')!.run!, { offered: true, folderOnly: 'none', reason: null });
  return result;
}
const launch = (input: RunSpec, maxRunMinutes = 1) => startTool({ adapter, spec: input, matrix: matrix(), processes,
  claimedAt: Date.now(), expiresAt: Date.now() + 7_200_000, maxRunMinutes });

test('TLS-28 OpenCode metadata keeps real acceptance and Folder only closed', () => {
  assert.deepEqual(adapter.info, { tool: 'opencode', harness: 'opencode', card: 'TLS-28', folderOnly: 'none', mcpLevel: 'servers-off',
    skillsDir: '{runDir}/skills', promptVia: 'stdin', runHome: false });
  const run = TOOL_MATRIX.tools.find(tool => tool.key === 'opencode')!.run!;
  assert.equal(run.offered, false); assert.equal(run.folderOnly, 'none'); assert.equal(run.mcpLevel, 'servers-off');
});

test('TLS-28 OpenCode Full access golden argv, environment and run config', () => {
  const paths = openCodeRunPaths(spec.runDir), config = paths.config, configPath = join(config, 'opencode.json');
  const overlay = { $schema: 'https://opencode.ai/config.json', model: 'ollama/qwen3:8b', small_model: 'ollama/qwen3:8b', enabled_providers: ['ollama'],
    autoupdate: false, share: 'disabled', snapshot: false, plugin: [], mcp: {}, formatter: false, lsp: false, instructions: [],
    skills: { paths: [spec.skillsDir], urls: [] }, permission, agent: { build: { steps: 50 } },
    provider: { ollama: { npm: '@ai-sdk/openai-compatible', name: 'ollama', options: { baseURL: 'http://127.0.0.1:11434/v1' },
      models: { 'qwen3:8b': { name: 'qwen3:8b', tool_call: true } } } } };
  assert.deepEqual(adapter.build(spec), {
    argv: [spec.bin, '--pure', 'run', '--dir', spec.cwd, '--format', 'json', '--auto', '-m', 'ollama/qwen3:8b', '--variant', 'high'],
    env: { XDG_CONFIG_HOME: dirname(config), XDG_DATA_HOME: paths.data, XDG_CACHE_HOME: paths.cache,
      XDG_STATE_HOME: paths.state, OPENCODE_DB: paths.database, OPENCODE_CONFIG: configPath, OPENCODE_CONFIG_DIR: config,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(overlay), OPENCODE_PERMISSION: JSON.stringify(permission), OPENCODE_PURE: '1',
      OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_SHARE: '1', OPENCODE_DISABLE_EMBEDDED_WEB_UI: '1' },
    envUnset: ['SSH_AUTH_SOCK'], stdinFile: spec.promptFile, files: [{ path: configPath, content: '{}\n', mode: 0o600 }],
    projectFiles: [], spawnCwd: null, secretEnv: {},
  });
});

test('TLS-28 OpenCode Folder only golden behavior is an explicit refusal before spawn', async t => {
  assert.match(adapter.supports({ ...spec, access: 'folder_only' }).reason!, /confinement.*R-02/u);
  assert.throws(() => adapter.build({ ...spec, access: 'folder_only' }), /adapter_refused/u);
  const input = await runSpec(t);
  assert.deepEqual(await enforceAdapter({ ...input, access: 'folder_only', adapter, matrix: matrix() }), { ok: false, code: 'adapter_refused', version: null });
  await assert.rejects(stat(join(input.runDir, 'config')), { code: 'ENOENT' });
});

test('TLS-28 OpenCode local provider selection remains in argv and generated config', () => {
  for (const [selected, provider, model, baseURL] of [
    [adapter, 'ollama', 'qwen3:8b', 'http://127.0.0.1:11434/v1'],
    [adapter, 'lmstudio', 'qwen3-coder', 'http://127.0.0.1:1234/v1'],
  ] as const) {
    const result = selected.build({ ...spec, provider, model, effort: null });
    assert.equal(result.argv.at(-1), `${provider}/${model}`); assert(!result.argv.includes('--variant'));
    const config = JSON.parse(result.env.OPENCODE_CONFIG_CONTENT);
    assert.equal(config.model, `${provider}/${model}`); assert.deepEqual(config.enabled_providers, [provider]);
    assert.deepEqual(config.skills.paths, [spec.skillsDir]); assert.equal(config.provider?.[provider].options.baseURL, baseURL);
    assert.equal(result.secretEnv && Object.keys(result.secretEnv).length, 0);
  }
  assert.equal(adapter.build({ ...spec, provider: null, model: 'ollama/qwen3:8b' }).argv[9], 'ollama/qwen3:8b');
});

test('TLS-28 OpenCode hosted and custom providers stay sync only without a supported secret path', () => {
  const custom = createOpenCodeAdapter({ providers: { team: { baseURL: 'https://models.example.test/v1' } } });
  for (const provider of ['openrouter', 'anthropic', 'team']) {
    const selected = { ...spec, provider, model: 'organization/model' };
    assert.equal(custom.supports(selected).ok, false);
    assert.match(custom.supports(selected).reason!, /secret path.*only for local Ollama and LM Studio/u);
    assert.throws(() => custom.build(selected), /adapter_refused/u);
  }
});

test('TLS-28 OpenCode custom endpoint settings reject credentials, substitutions and extra provider options', () => {
  for (const baseURL of ['file:///tmp/model', 'https://user:password@example.test/v1', 'https://example.test/v1?api_key=synthetic',
    'https://example.test/v1#fragment', 'https://example.test/{env:KEY}', 'https://example.test/{file:/tmp/auth}', 'invalid']) {
    assert.throws(() => createOpenCodeAdapter({ providers: { team: { baseURL } } }), /adapter_refused/u);
  }
  for (const settings of [{ baseURL: 'http://127.0.0.1/v1', apiKey: 'synthetic-test-value' }, { baseURL: 'http://127.0.0.1/v1', npm: 'plugin' }]) {
    assert.throws(() => createOpenCodeAdapter({ providers: { team: settings } }), /adapter_refused/u);
  }
  for (const id of ['ollama', 'lmstudio', 'openrouter', '--plugin', 'team/name', '__proto__']) {
    assert.throws(() => createOpenCodeAdapter({ providers: { [id]: { baseURL: 'https://models.example.test/v1' } } }), /adapter_refused/u);
  }
});

test('TLS-28 OpenCode unsafe model, provider, variant and access settings fail closed', () => {
  for (const model of ['', 'qwen model', '--plugin', 'qwen\nmodel', 'qwen\u0000model', 'x'.repeat(257)]) assert.equal(adapter.supports({ ...spec, model }).ok, false);
  for (const provider of ['', 'unknown', '--pure', 'ollama/other', 'OLLAMA']) assert.equal(adapter.supports({ ...spec, provider }).ok, false);
  for (const effort of ['', '--plugin', 'hi gh', 'x'.repeat(65)]) assert.equal(adapter.supports({ ...spec, effort }).ok, false);
  for (const access of [undefined, null, '', 'FULL_ACCESS']) assert.throws(() => adapter.build({ ...spec, access } as unknown as RunSpec), /adapter_refused/u);
  for (const maxTurns of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => adapter.build({ ...spec, maxTurns }), /adapter_refused/u);
  assert.equal(adapter.supports({ ...spec, provider: null, model: 'qwen3' }).ok, false);
});

test('TLS-28 OpenCode build is deterministic without reading prompt, skills or normal configuration', () => {
  const frozen = Object.freeze({ ...spec }), first = adapter.build(frozen);
  first.argv.push('mutation'); first.env.HOME = '/mutation'; first.files[0].content = 'mutation';
  const second = adapter.build(frozen);
  assert(!second.argv.includes('mutation')); assert.notEqual(second.env.HOME, '/mutation'); assert.equal(second.files[0].content, '{}\n');
  assert.equal(second.projectFiles.length, 0);
  for (const flag of ['--bare', '--mcp-config', '--approve-mcps', '--allow-all-paths', '--allow-all-urls', '-k', '--key', '--api-key', '--mcp']) assert(!second.argv.includes(flag));
});

test('TLS-28 OpenCode managed configuration paths cover higher-priority system and macOS policies', () => {
  assert.deepEqual(openCodeManagedPaths('darwin', 'tester'), [
    '/Library/Application Support/opencode/opencode.json', '/Library/Application Support/opencode/opencode.jsonc',
    '/Library/Managed Preferences/tester/ai.opencode.managed.plist', '/Library/Managed Preferences/ai.opencode.managed.plist',
  ]);
  assert.deepEqual(openCodeManagedPaths('linux', 'tester'), [join('/', 'etc', 'opencode/opencode.json'), join('/', 'etc', 'opencode/opencode.jsonc')]);
});

test('TLS-28 OpenCode identity accepts pinned v1 and a resolved install symlink', async t => {
  const root = await temporary(t), bin = await executable(root), alias = join(root, 'opencode.exe'); await symlink(bin, alias);
  assert.deepEqual(await adapter.identity(bin), { ok: true, version: '1.19.0' });
  assert.deepEqual(await adapter.identity(alias), { ok: true, version: '1.19.0' });
});

test('TLS-28 OpenCode refuses personal native configuration without reading or redirecting HOME', async t => {
  const root = await temporary(t), ambientHome = join(root, 'normal-home'), config = join(ambientHome, '.opencode');
  await mkdir(config, { recursive: true });
  const originalHome = process.env.HOME;
  process.env.HOME = ambientHome;
  try {
    assert.match(adapter.supports(spec).reason!, /personal ~\/.opencode.*preserving HOME/u);
    assert.throws(() => adapter.build(spec), /adapter_refused/u);
    assert.deepEqual(await adapter.identity(await executable(root)), { ok: false, version: null });
    assert.equal((await stat(config)).isDirectory(), true);
  } finally { if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome; }
});

test('TLS-28 OpenCode identity rejects v2, wrong output, wrappers, errors and unrelated binaries', async t => {
  const root = await temporary(t);
  for (const mode of ['v2', 'wrong', 'wrong-help', 'multiline', 'stderr', 'nonzero', 'overflow']) assert.deepEqual(await adapter.identity(await executable(root, mode)), { ok: false, version: null });
  for (const bin of ['opencode', root, join(root, 'missing/opencode'), process.execPath]) assert.deepEqual(await adapter.identity(bin), { ok: false, version: null });
  const bin = await executable(root), disguised = join(root, 'agent'); await symlink(bin, disguised);
  assert.deepEqual(await adapter.identity(disguised), { ok: false, version: null });
  const wrongTarget = join(root, 'real-agent'); await copyFile(bin, wrongTarget); await chmod(wrongTarget, 0o700);
  const alias = join(root, 'alias/opencode'); await mkdir(dirname(alias)); await symlink(wrongTarget, alias);
  assert.deepEqual(await adapter.identity(alias), { ok: false, version: null });
});

test('TLS-28 OpenCode environment preserves HOME, isolates XDG and strips inherited auth/config', async () => {
  const invocation = adapter.build(spec), env = await buildToolEnvironment(spec.bin, invocation.env, invocation.envUnset, {
    HOME: '/ambient/home', XDG_CONFIG_HOME: '/ambient/config', OPENCODE_CONFIG: '/ambient/config/opencode.json',
    OPENCODE_AUTH_CONTENT: 'synthetic-auth', OPENCODE_PERMISSION: '{"*":"allow"}', OPENROUTER_API_KEY: 'synthetic-key',
    SSH_AUTH_SOCK: '/ambient/ssh', MADDOTS_TOKEN: 'synthetic-token', HTTP_PROXY: 'https://proxy.invalid',
  });
  assert.equal(invocation.env.HOME, undefined); assert.equal(env.HOME, '/ambient/home'); assert.equal(env.XDG_CONFIG_HOME, invocation.env.XDG_CONFIG_HOME);
  assert.equal(env.OPENCODE_CONFIG, invocation.env.OPENCODE_CONFIG); assert.equal(env.OPENCODE_PERMISSION, invocation.env.OPENCODE_PERMISSION);
  for (const key of ['OPENCODE_AUTH_CONTENT', 'OPENROUTER_API_KEY', 'SSH_AUTH_SOCK', 'MADDOTS_TOKEN', 'HTTP_PROXY']) assert.equal(env[key], undefined);
});

test('TLS-28 OpenCode parses final assistant text parts, replacing repeated part updates', () => {
  const initial = [start, text, row('step_finish', part('step-finish', { reason: 'tool-calls' }))];
  const finalMessage = 'msg_final';
  const output = jsonl(...initial, row('step_start', part('step-start', { messageID: finalMessage })),
    row('text', part('text', { id: 'one', messageID: finalMessage, text: 'old text' })),
    row('reasoning', part('reasoning', { messageID: finalMessage, text: 'private reasoning' })),
    row('text', part('text', { id: 'one', messageID: finalMessage, text: 'Final response.' })),
    row('text', part('text', { id: 'two', messageID: finalMessage, text: 'Second paragraph.' })),
    row('step_finish', part('step-finish', { messageID: finalMessage, reason: 'stop' })));
  for (const value of [output, output.trimEnd(), output.replaceAll('\n', '\r\n')]) assert.deepEqual(parse(value), { ok: true, text: 'Final response.\nSecond paragraph.', failureCode: null });
});

test('TLS-28 OpenCode nonzero exits, signals, session errors and tool failures cannot become success', () => {
  for (const override of [{ exitCode: 1 }, { exitCode: null }, { signal: 'SIGTERM' }]) assert.equal(parse(jsonl(start, text, finish), override).failureCode, 'tool_failed');
  for (const output of [jsonl(start, { type: 'error', error: { name: 'APIError' } }, text, finish),
    jsonl(start, row('tool_use', part('tool', { tool: 'read', state: { status: 'error' } })), text, finish)]) assert.equal(parse(output).failureCode, 'tool_failed');
  for (const reason of ['length', 'error', 'content-filter', 'unknown', 'tool-calls']) assert.equal(parse(jsonl(start, text, row('step_finish', part('step-finish', { reason })))).failureCode, 'tool_failed');
});

test('TLS-28 OpenCode empty and malformed output fail closed', () => {
  assert.equal(parse('').failureCode, 'output_empty');
  assert.equal(parse(jsonl(start, row('text', part('text', { text: ' \n' })), finish)).failureCode, 'output_empty');
  for (const output of ['bad json\n', 'null\n', '[]\n', '{}\n', jsonl(start, text), jsonl(start, finish, text),
    jsonl(start, { ...text, sessionID: 'ses_other' }, finish), jsonl(start, row('text', part('text', { text: 42 })), finish),
    jsonl(start, row('text', { text: 'no part identity' }), finish), `${jsonl(start, text, finish)}{bad`,
    jsonl(start, { type: 'unrecognized' }, text, finish)]) assert.equal(parse(output).failureCode, 'tool_failed', output);
});

test('TLS-28 OpenCode selfCheck catches every MCP/browser/custom tool and accumulated fragments', () => {
  const clean = jsonl(start), unsafe = jsonl(row('tool_use', part('tool', { tool: 'canary_maddots_canary_ping', state: { status: 'completed' } })));
  assert.equal(adapter.selfCheck!(''), null);
  for (let end = 1; end < clean.trimEnd().length; end++) assert.equal(adapter.selfCheck!(clean.slice(0, end)), null);
  assert.deepEqual(adapter.selfCheck!(clean), { mcpServers: [], browserTools: [] });
  for (const tool of ['canary_maddots_canary_ping', 'mcp__canary__ping', 'browser', 'chrome', 'unknown-plugin']) {
    const output = jsonl(start, row('tool_use', part('tool', { tool, state: { status: 'completed' } })), text, finish);
    assert.deepEqual(adapter.selfCheck!(output), { mcpServers: [], browserTools: [tool] }); assert.equal(parse(output).failureCode, 'mcp_started');
  }
  for (let split = 1; split < unsafe.trimEnd().length; split++) {
    assert.deepEqual(adapter.selfCheck!(`${clean}${unsafe.slice(0, split)}`), { mcpServers: [], browserTools: [] });
    assert.deepEqual(adapter.selfCheck!(`${clean}${unsafe}`), { mcpServers: [], browserTools: ['canary_maddots_canary_ping'] });
  }
  assert.throws(() => adapter.selfCheck!('bad json\n'));
  assert.throws(() => adapter.selfCheck!(jsonl({ type: 'tool_use', part: { tool: 'read' } })));
});

test('TLS-28 OpenCode selfCheck refuses reported MCP inventory before any tool call', () => {
  for (const metadata of [
    { mcp_servers: ['personal-server'] }, { mcpServers: [{ name: 'personal-server', status: 'connected' }] },
    { metadata: { mcpServers: { 'personal-server': { status: 'connected' } } } },
    { system: { mcp_servers: ['personal-server'] } },
  ]) {
    const output = jsonl({ ...start, ...metadata }, text, finish);
    assert.deepEqual(adapter.selfCheck!(output), { mcpServers: ['personal-server'], browserTools: [] });
    assert.equal(parse(output).failureCode, 'mcp_started');
  }
  const output = jsonl(start, row('tool_use', part('tool', { tool: 'skill', state: {
    status: 'completed', metadata: { mcp_servers: [{ status: 'unknown' }] },
  } })), text, finish);
  assert.equal(parse(output).failureCode, 'mcp_started');
  assert.deepEqual(adapter.selfCheck!(jsonl({ ...start, mcp_servers: [], mcpServers: {} })), { mcpServers: [], browserTools: [] });
});

test('TLS-28 OpenCode skill proof uses completed tool metadata and staged location', () => {
  const skill = { skillName: 'fixture', skillMarker: 'SKILL_SEEN', skillsDir: spec.skillsDir };
  const state = { status: 'completed', input: { name: 'fixture' }, metadata: { name: 'fixture', dir: join(spec.skillsDir, 'fixture') },
    output: '<skill_content name="fixture">\nSKILL_SEEN\n</skill_content>' };
  const output = (value: Record<string, unknown>) => jsonl(start, row('tool_use', part('tool', { tool: 'skill', state: value })), text, finish);
  assert.deepEqual(inspectOpenCodeOutput(output(state), skill), { sessionID, skillLoaded: true, skillMarkerSeen: true, mcpServers: [], browserTools: [] });
  assert.equal(inspectOpenCodeOutput(output({ ...state, output: 'loaded' }), skill).skillLoaded, true);
  assert.equal(inspectOpenCodeOutput(output({ ...state, output: 'loaded' }), skill).skillMarkerSeen, false);
  for (const change of [{ status: 'error' }, { status: 'running' }, { input: { name: 'other' } }, { metadata: { name: 'other', dir: join(spec.skillsDir, 'fixture') } },
    { metadata: { name: 'fixture', dir: '/ambient/skills/fixture' } }, { metadata: undefined }]) {
    assert.equal(inspectOpenCodeOutput(output({ ...state, ...change }), skill).skillLoaded, false);
  }
  assert.equal(inspectOpenCodeOutput(jsonl(start, { ...text, part: { ...text.part, text: 'Simulated SKILL_SEEN' } }, finish), skill).skillLoaded, false);
  for (const value of ['malformed', jsonl(start, { ...text, sessionID: 'ses_other' }, finish)]) assert.equal(inspectOpenCodeOutput(value, skill).sessionID, null);
});

test('TLS-28 OpenCode succeeds through core with a large stdin prompt and staged skill', async t => {
  const prompt = 'Complete the task. '.repeat(6000), input = await runSpec(t, prompt), result = await (await launch(input)).finished;
  assert.equal(result.ok, true, await readFile(join(input.runDir, 'stderr.log'), 'utf8'));
  assert.equal(result.stopped, false); assert.equal(result.exitCode, 0);
  const observed = JSON.parse(result.text);
  assert.equal(observed.promptBytes, Buffer.byteLength(prompt)); assert.match(observed.skill, /SKILL_SEEN/u);
  assert.equal(observed.model, 'ollama/qwen3:8b'); assert.equal(observed.home, process.env.HOME);
  assert.equal(observed.authPresent, false); assert.equal(observed.sshAuthPresent, false);
  assert.equal((await stat(join(openCodeRunPaths(input.runDir).config, 'opencode.json'))).mode & 0o777, 0o600);
});

for (const [prompt, code] of [['FAIL synthetic', 'tool_failed'], ['MALFORMED synthetic', 'tool_failed'], ['MCP synthetic', 'mcp_started']] as const) {
  test(`TLS-28 OpenCode core rejects fake ${prompt.split(' ')[0].toLowerCase()} output`, async t => {
    const input = await runSpec(t, prompt), result = await (await launch(input)).finished;
    assert.equal(result.ok, false); assert.equal(result.text, ''); assert.equal(result.failureCode, code);
  });
}

test('TLS-28 OpenCode core deadline terminates a hanging CLI', async t => {
  const input = await runSpec(t, 'HANG synthetic'), running = await launch(input, 0.02), result = await running.finished;
  assert.equal(result.ok, false); assert.equal(result.stopped, true); assert.equal(result.failureCode, 'run_time_limit');
  assert.throws(() => process.kill(running.pid, 0), { code: 'ESRCH' });
});

test('TLS-28 OpenCode core stop terminates a hanging CLI', async t => {
  const input = await runSpec(t, 'HANG synthetic'), running = await launch(input);
  await running.stop('runner_stopped'); const result = await running.finished;
  assert.equal(result.ok, false); assert.equal(result.stopped, true); assert.equal(result.failureCode, 'runner_stopped');
  assert.throws(() => process.kill(running.pid, 0), { code: 'ESRCH' });
});

test('TLS-28 OpenCode fake canary positive control starts normal MCP and plugin children', async t => {
  const input = await runSpec(t), home = join(input.cwd, 'normal-home'), config = join(home, '.config/opencode');
  const mcpMarker = join(input.cwd, 'mcp-started'), pluginMarker = join(input.cwd, 'plugin-started');
  const plugin = join(input.cwd, 'fixture-plugin.mjs');
  await writeFile(plugin, `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(pluginMarker)}, 'started');`);
  await mkdir(config, { recursive: true }); await writeFile(join(config, 'opencode.json'), JSON.stringify({
    mcp: { canary: { type: 'local', command: [process.execPath, fixture('canary.mjs'), mcpMarker], enabled: true } }, plugin: [plugin],
  }));
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = execFile(input.bin, ['run', '--format', 'json', '-m', 'ollama/qwen3:8b'], { cwd: input.cwd,
      env: { HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` }, timeout: 10_000 },
    (error, stdout) => { if (error) reject(error); else resolve(stdout); });
    child.stdin!.end('Positive control.');
  });
  assert.match(stdout, /step_finish/u);
  assert.equal(await readFile(mcpMarker, 'utf8'), 'started\n'); assert.equal(await readFile(pluginMarker, 'utf8'), 'started');
});

test('TLS-28 OpenCode fake canary negative control isolates global and project config without mutation', async t => {
  const input = await runSpec(t), marker = join(input.cwd, 'canary-started'), pluginMarker = join(input.cwd, 'plugin-started');
  const plugin = join(input.cwd, 'fixture-plugin.mjs'); await writeFile(plugin, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(pluginMarker)},'started');`);
  const config = JSON.stringify({ mcp: { canary: { type: 'local', command: [process.execPath, fixture('canary.mjs'), marker], enabled: true } }, plugin: [plugin] });
  const projectConfig = join(input.cwd, 'opencode.json'); await writeFile(projectConfig, config);
  const ambientHome = join(input.cwd, 'ambient-home'), normalConfig = join(ambientHome, '.config/opencode/opencode.json');
  await mkdir(dirname(normalConfig), { recursive: true }); await writeFile(normalConfig, config);
  const originalHome = process.env.HOME;
  process.env.HOME = ambientHome;
  let result;
  try { result = await (await launch(input)).finished; }
  finally { if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome; }
  assert.equal(result.ok, true); assert.match(JSON.parse(result.text).skill, /SKILL_SEEN/u);
  for (const path of [marker, pluginMarker]) await assert.rejects(stat(path), { code: 'ENOENT' });
  assert.equal(await readFile(normalConfig, 'utf8'), config); assert.equal(await readFile(projectConfig, 'utf8'), config);
});
