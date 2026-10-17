import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';
import { TOOL_MATRIX } from '../src/shared/tool-matrix.js';
import type { Adapter, RunSpec } from '../src/runner/adapter.js';
import { claudeCodeAdapter as adapter } from '../src/runner/adapters/claude-code.js';
import { buildToolEnvironment, startTool, type ProcessInspector } from '../src/runner/process.js';
import { createRunFolder } from '../src/runner/run-folder.js';

const fixture = (name: string) => new URL(`./fixtures/adapters/claude-code/${name}`, import.meta.url);
const readFixture = (name: string) => readFile(fixture(name), 'utf8');
const init = { type: 'system', subtype: 'init', mcp_servers: [], tools: ['Read', 'Write', 'Bash', 'Skill'], plugins: [] };
const success = { type: 'result', subtype: 'success', is_error: false, result: 'Done.' };
const ndjson = (...rows: unknown[]) => `${rows.map(row => JSON.stringify(row)).join('\n')}\n`;
const parse = (stdout: string, overrides: Partial<Parameters<Adapter['parse']>[0]> = {}) => adapter.parse({
  stdout, stderr: '', exitCode: 0, signal: null, runDir: '/fixture/project/.maddots/runs/run-1', ...overrides,
});
const spec: RunSpec = {
  bin: '/fixture/home/.local/bin/claude', cwd: '/fixture/project with spaces',
  runDir: '/fixture/project with spaces/.maddots/runs/run-1',
  promptFile: '/fixture/project with spaces/.maddots/runs/run-1/prompt.md',
  model: 'claude-sonnet-4-6', provider: null, effort: 'high', access: 'folder_only',
  skillsDir: '/fixture/project with spaces/.maddots/runs/run-1/plugin/skills',
  maxTurns: 50, timeoutSeconds: 120, runHome: null,
};

const baseArgv = [spec.bin, '-p', '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none',
  '--no-session-persistence', '--plugin-dir', join(spec.runDir, 'plugin'), '--model', spec.model, '--effort', 'high'];
const tail = ['--strict-mcp-config', '--disallowedTools', 'mcp__*', '--no-chrome', `Follow the task in ${spec.promptFile}.`];
const processes: ProcessInspector = {
  table: async () => [], fencePids: async () => [],
  identity: async pid => { try { process.kill(pid, 0); return `fixture-${pid}`; } catch { return null; } },
};

async function temporary(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-claude-adapter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function executable(path: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await copyFile(fixture('fake-cli.mjs'), path);
  await chmod(path, 0o700);
  return path;
}

test('TLS-26 Claude metadata pins the file prompt and run-only skill route without run-home access', () => {
  assert.deepEqual(adapter.info, {
    tool: 'claude-code', harness: 'claude_code', card: 'TLS-26', folderOnly: 'os-sandbox', mcpLevel: 'servers-off',
    skillsDir: '{runDir}/plugin/skills', promptVia: 'file', runHome: false,
  });
  const run = TOOL_MATRIX.tools.find(tool => tool.key === adapter.info.tool)!.run!;
  assert.equal(run.offered, false);
  const rank = { none: 0, 'no-shell': 1, 'os-sandbox': 2 };
  assert(rank[adapter.info.folderOnly] >= rank[run.folderOnly]);
  assert.equal(adapter.info.mcpLevel, run.mcpLevel);
});

test('TLS-26 Claude Folder only golden command requires the sandbox and the model', () => {
  const invocation = adapter.build(spec);
  assert.deepEqual(invocation, {
    argv: [...baseArgv, '--permission-mode', 'acceptEdits', '--settings',
      '{"sandbox":{"enabled":true,"autoAllowBashIfSandboxed":true,"allowUnsandboxedCommands":false,"failIfUnavailable":true}}', ...tail],
    env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' }, envUnset: ['ANTHROPIC_API_KEY'], stdinFile: null,
    files: [], projectFiles: [], spawnCwd: null, secretEnv: {},
  });
  assert(!invocation.argv.includes('bypassPermissions'));
});

test('TLS-26 Claude Full access golden command requires an explicit full_access setting', () => {
  assert.deepEqual(adapter.build({ ...spec, access: 'full_access' }).argv,
    [...baseArgv, '--permission-mode', 'bypassPermissions', ...tail]);
  for (const access of [undefined, null, '', 'FULL_ACCESS', 'invalid']) {
    assert.throws(() => adapter.build({ ...spec, access } as unknown as RunSpec), /adapter_refused/u);
  }
});

test('TLS-26 Claude optional effort is omitted and all forbidden flags stay absent in both modes', () => {
  const forbidden = ['--bare', '--mcp-config', '--approve-mcps', '--allow-all-paths', '--allow-all-urls', '-k', '--key', '--api-key', '--mcp'];
  for (const access of ['folder_only', 'full_access'] as const) {
    const invocation = adapter.build({ ...spec, access, effort: null });
    assert(!invocation.argv.includes('--effort'));
    for (const flag of forbidden) assert(!invocation.argv.includes(flag), flag);
    for (const value of ['--strict-mcp-config', '--disallowedTools', 'mcp__*', '--no-chrome']) assert(invocation.argv.includes(value), value);
    for (const value of ['--setting-sources', '--ide', '--safe-mode', '--restricted', '--dangerously-skip-permissions']) assert(!invocation.argv.includes(value), value);
    assert.equal(invocation.argv.at(-1), `Follow the task in ${spec.promptFile}.`);
  }
});

test('TLS-26 Claude build is deterministic and reads no prompt or skill files', () => {
  const frozen = Object.freeze({ ...spec });
  const first = adapter.build(frozen);
  assert.deepEqual(adapter.build(frozen), first);
  first.argv.push('mutation'); first.env.ENABLE_CLAUDEAI_MCP_SERVERS = 'true';
  assert.deepEqual(adapter.build(frozen).argv, [...baseArgv, '--permission-mode', 'acceptEdits', '--settings',
    '{"sandbox":{"enabled":true,"autoAllowBashIfSandboxed":true,"allowUnsandboxedCommands":false,"failIfUnavailable":true}}', ...tail]);
  assert.equal(adapter.build(frozen).env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
});

test('TLS-26 Claude supports saved login only and refuses unsafe model, effort and access values', () => {
  for (const model of ['sonnet', 'opus', 'claude-sonnet-4-6', 'claude-opus-4-6']) {
    for (const access of ['folder_only', 'full_access'] as const) {
      assert.deepEqual(adapter.supports({ provider: null, model, effort: null, access }), { ok: true, reason: null });
      assert.equal(adapter.supports({ provider: null, model, effort: 'high', access }).ok, true);
    }
  }
  for (const provider of ['', 'anthropic', 'ollama', 'lmstudio', 'bedrock', 'vertex', 'openrouter']) {
    assert.equal(adapter.supports({ ...spec, provider }).ok, false);
    assert.throws(() => adapter.build({ ...spec, provider }), /adapter_refused/u);
  }
  for (const value of ['', ' ', '--no-chrome', 'model\u0000name', 'model\nname', 'model name', 'x'.repeat(257)]) {
    assert.equal(adapter.supports({ ...spec, model: value }).ok, false, `model ${JSON.stringify(value)}`);
    assert.equal(adapter.supports({ ...spec, effort: value }).ok, false, `effort ${JSON.stringify(value)}`);
  }
});

test('TLS-26 Claude identity accepts a standalone executable and its symlink', async t => {
  const root = await temporary(t);
  const bin = await executable(join(root, '.local/share/claude/versions/2.1.296/claude'));
  const link = join(root, '.local/bin/claude'); await mkdir(dirname(link), { recursive: true }); await symlink(bin, link);
  assert.deepEqual(await adapter.identity(bin), { ok: true, version: '2.1.296' });
  assert.deepEqual(await adapter.identity(link), { ok: true, version: '2.1.296' });
});

test('TLS-26 Claude identity refuses wrong tools, multiline output, errors and missing executables', async t => {
  const root = await temporary(t);
  for (const name of ['wrong', 'multiline', 'stderr', 'nonzero', 'overflow', 'agent']) {
    assert.deepEqual(await adapter.identity(await executable(join(root, name))), { ok: false, version: null }, name);
  }
  for (const bin of ['claude', join(root, 'missing'), root]) assert.deepEqual(await adapter.identity(bin), { ok: false, version: null });
});

test('TLS-26 Claude identity refuses Desktop binaries and resolved symlinks before running them', async t => {
  const root = await temporary(t), marker = join(root, 'was-run');
  for (const [index, relative] of [
    'Library/Application Support/Claude/claude-code/2.1.293/hash/claude',
    'Applications/Claude.app/Contents/MacOS/claude',
  ].entries()) {
    const bin = join(root, relative); await mkdir(dirname(bin), { recursive: true });
    await writeFile(bin, `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran'); console.log('2.1.296 (Claude Code)');\n`, { mode: 0o700 });
    const alias = join(root, `standalone-${index}`); await symlink(bin, alias);
    assert.deepEqual(await adapter.identity(bin), { ok: false, version: null });
    assert.deepEqual(await adapter.identity(alias), { ok: false, version: null });
  }
  await assert.rejects(stat(marker), { code: 'ENOENT' });
});

test('TLS-26 Claude environment disables cloud MCP and discards ambient API credentials', async () => {
  const invocation = adapter.build(spec);
  const env = await buildToolEnvironment(process.execPath, invocation.env, invocation.envUnset, {
    HOME: '/fixture/home', ANTHROPIC_API_KEY: 'synthetic-test-value', ENABLE_CLAUDEAI_MCP_SERVERS: 'true',
    CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BASE_URL: 'https://invalid.example',
  });
  assert.equal(env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
});

test('TLS-26 Claude success fixture returns only the final result text', async () => {
  const output = await readFixture('success.ndjson');
  const expected = { ok: true, text: 'Finished the fixture task.\nSecond paragraph.', failureCode: null };
  assert.deepEqual(parse(output), expected);
  assert.deepEqual(parse(output.trimEnd()), expected);
  assert.deepEqual(parse(output.replaceAll('\n', '\r\n')), expected);
});

test('TLS-26 Claude error, nonzero exit and signal cannot be masked by a successful result', async () => {
  assert.deepEqual(parse(await readFixture('failure.ndjson')), { ok: false, text: '', failureCode: 'tool_failed' });
  const output = await readFixture('success.ndjson');
  for (const overrides of [{ exitCode: 1 }, { exitCode: 143 }, { exitCode: null }, { signal: 'SIGTERM' }]) {
    assert.deepEqual(parse(output, overrides), { ok: false, text: '', failureCode: 'tool_failed' });
  }
  for (const row of [{ type: 'error', message: 'failure' }, { type: 'assistant', error: 'api_error' }, { type: 'assistant', is_error: true }]) {
    assert.equal(parse(ndjson(init, row, success)).failureCode, 'tool_failed');
  }
});

test('TLS-26 Claude blank output and empty final results are output_empty', async () => {
  for (const output of ['', ' \n\t', await readFixture('empty.ndjson')]) {
    assert.deepEqual(parse(output), { ok: false, text: '', failureCode: 'output_empty' });
  }
  assert.equal(parse('', { exitCode: 1 }).failureCode, 'tool_failed');
});

test('TLS-26 Claude incomplete, malformed or ambiguous streams fail closed', () => {
  const malformed = [
    'not json', '[]', 'null', '42', '{}', '{"type":42}', ndjson(init), ndjson(success),
    `${ndjson(init, success)}{"type":`, `${ndjson(init, success)}garbage\n`,
    ndjson(init, success, success), ndjson(init, success, { type: 'assistant' }),
    ndjson({ type: 'system', subtype: 'init', tools: [] }, success),
    ndjson({ ...init, tools: {} }, success), ndjson({ ...init, tools: [null] }, success),
    ndjson(init, { ...success, subtype: 'error_max_turns' }),
    ndjson(init, { ...success, is_error: undefined }), ndjson(init, { ...success, is_error: 'false' }),
    ndjson(init, { ...success, result: null }), ndjson(init, { ...success, result: { text: 'wrong' } }),
  ];
  for (const output of malformed) assert.deepEqual(parse(output), { ok: false, text: '', failureCode: 'tool_failed' }, output);
});

test('TLS-26 Claude selfCheck accepts a clean init and handles every accumulated fragment boundary', async () => {
  const output = await readFixture('success.ndjson'), firstLine = output.slice(0, output.indexOf('\n'));
  assert.equal(adapter.selfCheck!(''), null);
  for (let end = 1; end < firstLine.length; end++) assert.equal(adapter.selfCheck!(firstLine.slice(0, end)), null);
  assert.deepEqual(adapter.selfCheck!(firstLine), { mcpServers: [], browserTools: [] });
  assert.deepEqual(adapter.selfCheck!(output), { mcpServers: [], browserTools: [] });
  assert.deepEqual(adapter.selfCheck!(`${firstLine}\n{"type":"assistant`), { mcpServers: [], browserTools: [] });
  assert.equal(adapter.selfCheck!(ndjson({ type: 'assistant' })), null);
});

test('TLS-26 Claude selfCheck detects MCP servers, MCP tools and Chrome tools', async () => {
  assert.deepEqual(adapter.selfCheck!(await readFixture('mcp.ndjson')), {
    mcpServers: ['maddots-canary'], browserTools: ['mcp__maddots-canary__maddots_canary_ping', 'mcp__claude-in-chrome__tabs_context_mcp'],
  });
  assert.deepEqual(adapter.selfCheck!(ndjson({ ...init, tools: ['Read', 'mcp__hidden__run', 'ChromeTabs', 'browser_chrome'] })), {
    mcpServers: [], browserTools: ['mcp__hidden__run', 'ChromeTabs', 'browser_chrome'],
  });
  for (const server of ['canary', { name: 'canary', status: 'failed' }, {}, null, '']) {
    assert.equal(adapter.selfCheck!(ndjson({ ...init, mcp_servers: [server] }))!.mcpServers.length, 1);
  }
  assert.equal(parse(await readFixture('mcp.ndjson')).failureCode, 'mcp_started');
});

test('TLS-26 Claude selfCheck never loses a previous unsafe init when a later one is clean', () => {
  const output = ndjson({ ...init, mcp_servers: [{ name: 'canary' }], tools: ['chrome'] }, init);
  assert.deepEqual(adapter.selfCheck!(output), { mcpServers: ['canary'], browserTools: ['chrome'] });
  assert.equal(parse(`${output}${ndjson(success)}`).failureCode, 'mcp_started');
});

test('TLS-26 Claude selfCheck throws on completed malformed events for core fail-closed handling', () => {
  for (const output of ['bad json\n', 'null\n', '[]\n', '{}\n', ndjson({ type: 'system', subtype: 'init' }),
    ndjson({ ...init, mcp_servers: {} }), ndjson({ ...init, tools: [{}] })]) {
    assert.throws(() => adapter.selfCheck!(output));
  }
});

test('TLS-26 Claude core launch handles a prompt above 64 KiB and the staged maddots-run plugin', async t => {
  const root = await temporary(t), cwd = join(root, 'project with spaces'), dataDir = join(root, 'data');
  await mkdir(cwd); await mkdir(dataDir, { mode: 0o700 });
  const folder = await createRunFolder({ cwd, dataDir, runId: 'claude-test' });
  t.after(() => folder.release());
  const bin = await executable(join(root, 'standalone', 'claude'));
  const plugin = join(folder.runDir, 'plugin'), skillsDir = join(plugin, 'skills');
  // This is TLS-25's pre-start stageSkills contract, not adapter build I/O.
  await mkdir(join(plugin, '.claude-plugin'), { recursive: true, mode: 0o700 });
  await writeFile(join(plugin, '.claude-plugin/plugin.json'), '{"name":"maddots-run"}\n', { mode: 0o600 });
  await mkdir(join(skillsDir, 'fixture'), { recursive: true, mode: 0o700 });
  const skill = '---\nname: fixture\ndescription: Local test skill\n---\nComplete the fixture task.\n';
  await writeFile(join(skillsDir, 'fixture/SKILL.md'), skill, { mode: 0o600 });
  const prompt = '# Task from MadDots\n' + 'Fixture task. '.repeat(6000);
  assert(Buffer.byteLength(prompt) > 64 * 1024);
  await writeFile(folder.promptFile, prompt, { mode: 0o600 });
  const matrix = structuredClone(TOOL_MATRIX);
  Object.assign(matrix.tools.find(tool => tool.key === 'claude-code')!.run!, { offered: true, folderOnly: 'os-sandbox', reason: null });
  const running = await startTool({
    adapter, spec: { ...spec, bin, cwd, runDir: folder.runDir, promptFile: folder.promptFile, skillsDir }, matrix,
    claimedAt: Date.now(), expiresAt: Date.now() + 7_200_000, maxRunMinutes: 1, processes,
    stageProjectFile: async () => assert.fail('The adapter must leave run plugin staging to stageSkills.'),
  });
  const result = await running.finished;
  assert.equal(result.ok, true); assert.equal(result.stopped, false); assert.equal(result.exitCode, 0);
  const observed = JSON.parse(result.text);
  assert.equal(observed.promptBytes, Buffer.byteLength(prompt));
  assert.equal(observed.pluginName, 'maddots-run'); assert.equal(observed.skill, skill);
  assert.equal(observed.promptArg, `Follow the task in ${folder.promptFile}.`);
  assert.equal(observed.argv.at(-1), observed.promptArg);
  assert.equal(observed.apiKeyPresent, false); assert.equal(observed.connectors, 'false');
  assert.equal((await readFile(join(folder.runDir, 'stdout.log'), 'utf8')).split('\n').filter(Boolean).length, 2);
  assert.equal(await readFile(join(folder.runDir, 'stderr.log'), 'utf8'), '');
});

test('TLS-26 Claude core stops a fragmented MCP init even when followed by a successful result', async t => {
  const root = await temporary(t), bin = await realpath(process.execPath);
  const matrix = structuredClone(TOOL_MATRIX);
  Object.assign(matrix.tools.find(tool => tool.key === 'claude-code')!.run!, { offered: true, folderOnly: 'os-sandbox', reason: null });
  const unsafeInit = ndjson({ ...init, mcp_servers: [{ name: 'fixture-canary' }], tools: ['Read', 'mcp__fixture_canary__ping'] });
  const final = ndjson({ ...success, result: 'This successful result must not bypass the MCP stop.' });
  const deliveries: { name: string; chunks: string[] }[] = [
    { name: 'coalesced init and success', chunks: [unsafeInit + final] },
    { name: 'one byte at a time', chunks: [...unsafeInit + final] },
  ];
  for (let split = 1; split < unsafeInit.length; split++) {
    const prefix = unsafeInit.slice(0, split), suffix = unsafeInit.slice(split);
    deliveries.push(
      { name: `split ${split}, coalesced success`, chunks: [prefix, suffix + final] },
      { name: `split ${split}, separate success`, chunks: [prefix, suffix, final] },
    );
  }

  const controlledChild = () => Object.assign(new EventEmitter(), {
    pid: 424242, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => assert.fail('The test drives child exit explicitly.'),
  });
  let child: ReturnType<typeof controlledChild>;
  const spawned = t.mock.method(childProcess, 'spawn', () => child);
  syncBuiltinESMExports();
  try {
    for (const [index, delivery] of deliveries.entries()) {
      child = controlledChild();
      const runDir = join(root, '.maddots/runs', String(index)), promptFile = join(runDir, 'prompt.md');
      await mkdir(runDir, { recursive: true }); await writeFile(promptFile, 'Fixture task.');
      const check = t.mock.fn((stdout: string) => adapter.selfCheck!(stdout));
      const parse = t.mock.fn(adapter.parse);
      const controlledAdapter: Adapter = { ...adapter, identity: async () => ({ ok: true, version: 'fixture' }), selfCheck: check, parse };
      const now = () => 1_000_000;
      const running = await startTool({
        adapter: controlledAdapter, spec: { ...spec, bin, cwd: root, runDir, promptFile, skillsDir: join(runDir, 'plugin/skills') }, matrix,
        claimedAt: now(), expiresAt: now() + 7_200_000, maxRunMinutes: 1, now,
        processes: {
          table: async () => [], fencePids: async () => [],
          identity: async () => child.exitCode === null ? 'fixture-process' : null,
          signalGroup: () => assert.fail('The child has already exited before asynchronous cleanup.'),
        },
      });
      try {
        let accumulated = '';
        for (const [step, chunk] of delivery.chunks.entries()) {
          accumulated += chunk;
          child.stdout.write(Buffer.from(chunk));
          assert.equal(check.mock.callCount(), step + 1, delivery.name);
          assert.equal(check.mock.calls.at(-1)!.arguments[0], accumulated, delivery.name);
          assert.deepEqual(check.mock.calls.at(-1)!.result, accumulated.includes(unsafeInit.trimEnd())
            ? { mcpServers: ['fixture-canary'], browserTools: ['mcp__fixture_canary__ping'] } : null, delivery.name);
        }
      } finally {
        // Exit successfully before asynchronous cleanup. The synchronous MCP stop
        // must already be final, even when the result and exit arrive immediately.
        child.exitCode = 0;
        child.stdout.end(); child.stderr.end(); child.stdin.destroy();
        child.emit('exit', 0, null); child.emit('close', 0, null);
        await running.finished;
      }
      const result = await running.finished;
      assert.deepEqual(result, { ok: false, stopped: true, failureCode: 'mcp_started', text: '', exitCode: 0, signal: null }, delivery.name);
      assert.equal(parse.mock.callCount(), 0, delivery.name);
      assert.equal(await readFile(join(runDir, 'stdout.log'), 'utf8'), unsafeInit + final, delivery.name);
    }
    assert.equal(spawned.mock.callCount(), deliveries.length);
  } finally {
    spawned.mock.restore(); syncBuiltinESMExports();
  }
});
