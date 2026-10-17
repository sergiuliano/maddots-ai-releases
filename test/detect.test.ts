import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { detectTools } from '../src/detect.js';
import type { Runner } from '../src/config.js';
import { loadToolMatrix, TOOL_MATRIX, validateToolMatrix, type ToolMatrix } from '../src/shared/tool-matrix.js';
import { HELPER_MAX_TOOLS } from '../src/shared/helper-protocol.js';

const exec = promisify(execFile);

async function fixture(): Promise<{ home: string; matrix: ToolMatrix; cleanup: () => Promise<void> }> {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'mdai-detect-'));
  const matrix = structuredClone(TOOL_MATRIX);
  for (const tool of matrix.tools) {
    for (const variant of tool.variants) {
      variant.detect.apps = variant.detect.apps.map((_path, index) => `~/Applications/missing-${tool.key}-${variant.key}-${index}.app`);
      variant.detect.configPaths = variant.detect.configPaths.map((_path, index) => `~/.extensions/missing-${tool.key}-${variant.key}-${index}/package.json`);
    }
  }
  return { home, matrix, cleanup: () => rm(home, { recursive: true, force: true }) };
}

async function executable(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '', { mode: 0o755 });
}

test('matrix covers sixteen tools, conservative routes, duplicate risks, and GUI sync only', () => {
  assert.equal(loadToolMatrix().tools.length, 16);
  assert.equal(TOOL_MATRIX.checkedAt, '2026-10-14');
  assert.equal(TOOL_MATRIX.tools.reduce((count, tool) => count + tool.variants.length, 0), 35);
  assert.equal(HELPER_MAX_TOOLS, 40);
  assert(TOOL_MATRIX.sources.filter((source) => source.url !== 'https://github.com/deepseek-ai/deepseek-harness')
    .every((source) => source.checkedAt === '2026-10-13'));
  assert.deepEqual(TOOL_MATRIX.sources.find((source) => source.url === 'https://github.com/deepseek-ai/deepseek-harness'),
    { url: 'https://github.com/deepseek-ai/deepseek-harness', checkedAt: '2026-10-14' });
  const deepseek = TOOL_MATRIX.tools.find((tool) => tool.key === 'deepseek-harness')!;
  assert.equal(deepseek.name, 'DeepSeek Harness');
  assert.equal(deepseek.vendor, 'DeepSeek');
  assert.equal(deepseek.variants.length, 1);
  assert.equal(deepseek.variants[0].key, 'cli');
  assert.equal(deepseek.variants[0].label, 'CLI (developer preview)');
  assert.deepEqual(deepseek.variants[0].detect.binaries, ['~/.local/bin/dsh', 'dsh']);
  assert.deepEqual(deepseek.variants[0].models, { args: null, pattern: null });
  assert.equal(deepseek.route, 'agents-folder');
  assert.deepEqual(deepseek.reads, ['~/.agents/skills']);
  assert.deepEqual(deepseek.legacyReads, ['~/.dsh/skills']);
  assert.deepEqual(deepseek.homes, [{ glob: '~/.dsh', skills: '~/.dsh/skills' }]);
  assert.equal(deepseek.duplicateRule, 'replace-local');
  assert.deepEqual(deepseek.reload, { kind: 'live', command: null });
  assert.equal(deepseek.deliveryCard, 'TLS-15');
  const codex = TOOL_MATRIX.tools.find((tool) => tool.key === 'codex')!;
  assert.equal(codex.duplicateRule, 'replace-local');
  assert.deepEqual(codex.legacyReads, ['~/.codex/skills']);
  assert.deepEqual(codex.homes, [{ glob: '~/.codex*', skills: '~/.codex*/skills' }]);
  const claude = TOOL_MATRIX.tools.find((tool) => tool.key === 'claude-code')!;
  assert.equal(claude.route, 'claude-plugin');
  assert(!claude.reads.includes('~/.agents/skills'));
  assert(!TOOL_MATRIX.routes['claude-plugin'].path.startsWith('~/.claude/skills'));
  assert.equal(TOOL_MATRIX.tools.find((tool) => tool.key === 'grok')!.duplicateRule, 'grok-ignore');
  const antigravity = TOOL_MATRIX.tools.find((tool) => tool.key === 'antigravity')!;
  assert.deepEqual(antigravity.reads, ['~/.gemini/antigravity-cli/skills', '~/.gemini/config/skills']);
  for (const tool of TOOL_MATRIX.tools) {
    assert(tool.run === null || tool.run.offered === false);
    for (const variant of tool.variants) {
      if (!variant.detect.binaries.length) assert.equal(variant.syncOnly, true);
    }
  }
});

test('detection records matched CLI paths locally and reports no executable locations', async () => {
  const f = await fixture();
  try {
    const tool = f.matrix.tools.find(tool => tool.key === 'codex')!;
    f.matrix.tools = [tool];
    tool.variants = [tool.variants.find(variant => variant.key === 'cli')!];
    const bin = join(f.home, 'bin', 'codex');
    await executable(bin);
    tool.variants[0].detect.binaries = [bin];
    const found = await detectTools({home: f.home, env: {}, matrix: f.matrix,
      runner: async () => ({stdout: 'codex-cli 1.2.3\n', stderr: ''})});
    assert.equal(found.length, 1);
    assert.equal(found[0].path, bin);
    assert.equal(found[0].realpath, await realpath(bin));
    const {reportedTools} = await import('../src/pairing.js');
    const report = reportedTools(found)[0];
    assert.equal(Object.hasOwn(report, 'path'), false);
    assert.equal(Object.hasOwn(report, 'realpath'), false);
  } finally { await f.cleanup(); }
});

test('loader validates paths, dates, regexes, identities, model pairs and route references', () => {
  const changes: ((matrix: ToolMatrix) => void)[] = [
    (matrix) => { matrix.format = 2 as 1; },
    (matrix) => { matrix.checkedAt = '2026-02-31'; },
    (matrix) => { matrix.sources[0].url = 'http://example.com'; },
    (matrix) => { matrix.routes['agents-folder'].path = '~/../skills'; },
    (matrix) => { matrix.tools[0].route = 'unknown'; },
    (matrix) => { matrix.tools[0].route = 'constructor'; },
    (matrix) => { matrix.tools[1].key = matrix.tools[0].key; },
    (matrix) => { matrix.tools[0].key = 'k' + 'a'.repeat(40); }, // ai_tools.harness holds at most 40 characters
    (matrix) => { matrix.tools[0].variants[0].detect.versionPattern = '('; },
    (matrix) => { matrix.tools[0].variants[0].detect.versionArgs = []; },
    (matrix) => { matrix.tools[0].variants[1].syncOnly = false; },
    (matrix) => { matrix.tools[0].variants[0].models = { args: null, pattern: 'model' }; },
    (matrix) => { Object.assign(matrix.tools[0], { unexpected: true }); },
  ];
  for (const change of changes) {
    const matrix = structuredClone(TOOL_MATRIX);
    change(matrix);
    assert.throws(() => validateToolMatrix(matrix), /TOOL_MATRIX_INVALID/u);
  }
});

test('matrix accepts forty variants and refuses the forty-first', () => {
  const matrix = structuredClone(TOOL_MATRIX);
  const tool = matrix.tools[0];
  const count = matrix.tools.reduce((total, entry) => total + entry.variants.length, 0);
  for (let index = count; index < HELPER_MAX_TOOLS; index++) {
    tool.variants.push({ ...structuredClone(tool.variants[0]), key: `fixture-${index}` });
  }
  assert.doesNotThrow(() => validateToolMatrix(matrix));
  tool.variants.push({ ...structuredClone(tool.variants[0]), key: 'fixture-overflow' });
  assert.throws(() => validateToolMatrix(matrix), /TOOL_MATRIX_INVALID: tools\.variants/u);
});

test('run metadata remains disabled until an adapter is offered and only applies to CLI tools', () => {
  assert(TOOL_MATRIX.tools.every((tool) => tool.run?.offered !== true));
  const matrix = structuredClone(TOOL_MATRIX);
  const codex = matrix.tools.find((tool) => tool.key === 'codex')!;
  codex.run = {adapter: 'codex', card: 'TLS-26', offered: false, folderOnly: 'os-sandbox',
    mcpLevel: 'servers-off', reason: 'Awaiting real-run acceptance', checkedAt: '2026-10-14'};
  assert.equal(validateToolMatrix(matrix).tools.find((tool) => tool.key === 'codex')!.run?.offered, false);
  for (const folderOnly of ['os-sandbox', 'no-shell', 'none'] as const) {
    for (const mcpLevel of ['servers-off', 'tools-denied'] as const) {
      codex.run = {...codex.run, folderOnly, mcpLevel, reason: null};
      assert.doesNotThrow(() => validateToolMatrix(matrix));
    }
  }
  matrix.tools.find((tool) => tool.key === 'claude-desktop')!.run = {...codex.run};
  assert.throws(() => validateToolMatrix(matrix), /TOOL_MATRIX_INVALID: tools\[\d+\]\.run/u);
});

test('run metadata rejects missing and unknown fields, invalid flags, capabilities, identifiers and dates', () => {
  const run = {adapter: 'codex', card: 'TLS-26', offered: false, folderOnly: 'os-sandbox',
    mcpLevel: 'servers-off', reason: null, checkedAt: '2026-10-14'};
  const invalidRuns: unknown[] = [false, [], {}, {...run, unexpected: true},
    {...run, adapter: ''}, {...run, adapter: '../codex'}, {...run, adapter: 'a'.repeat(41)},
    {...run, card: ''}, {...run, card: 'TLS-26\n'},
    {...run, offered: 'true'}, {...run, offered: 1}, {...run, offered: null},
    {...run, folderOnly: 'sandbox'}, {...run, mcpLevel: 'enabled'},
    {...run, reason: ''}, {...run, reason: false}, {...run, reason: 'bad\nreason'},
    {...run, checkedAt: '2026-02-30'}, {...run, checkedAt: '2026-10-14T00:00:00Z'}];
  for (const key of Object.keys(run)) {
    const incomplete: Record<string, unknown> = {...run};
    delete incomplete[key];
    invalidRuns.push(incomplete);
  }
  for (const invalidRun of invalidRuns) {
    const matrix = structuredClone(TOOL_MATRIX);
    Object.assign(matrix.tools.find((tool) => tool.key === 'codex')!, {run: invalidRun});
    assert.throws(() => validateToolMatrix(matrix), /TOOL_MATRIX_INVALID: tools\[\d+\]\.run/u);
  }
});

test('colocated matrix loader works in the repository and a copied exported src/shared tree', async () => {
  const temp = await mkdtemp(join(await realpath(tmpdir()), 'mdai-matrix-export-'));
  try {
    const shared = join(temp, 'src/shared');
    await mkdir(shared, { recursive: true });
    await writeFile(join(temp, 'package.json'), '{"type":"module"}');
    await copyFile(fileURLToPath(new URL('../src/shared/tool-matrix.ts', import.meta.url)), join(shared, 'tool-matrix.ts'));
    await copyFile(fileURLToPath(new URL('../src/shared/tool-matrix.json', import.meta.url)), join(shared, 'tool-matrix.json'));
    await copyFile(fileURLToPath(new URL('../src/shared/helper-protocol.ts', import.meta.url)), join(shared, 'helper-protocol.ts'));
    await copyFile(fileURLToPath(new URL('../src/shared/skill-limits.ts', import.meta.url)), join(shared, 'skill-limits.ts'));
    const loader = pathToFileURL(join(shared, 'tool-matrix.ts')).href;
    const tsx = import.meta.resolve('tsx');
    const code = `const { TOOL_MATRIX, loadToolMatrix } = await import(${JSON.stringify(loader)}); console.log(JSON.stringify([TOOL_MATRIX.format, loadToolMatrix().tools.length, TOOL_MATRIX.checkedAt]));`;
    const { stdout } = await exec(process.execPath, ['--import', tsx, '--input-type=module', '-e', code], { cwd: temp });
    assert.deepEqual(JSON.parse(stdout), [1, 16, '2026-10-14']);
    await rm(join(shared, 'tool-matrix.json'));
    await assert.rejects(exec(process.execPath, ['--import', tsx, '--input-type=module', '-e', code], { cwd: temp }), /ENOENT/u);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('fixture homes detect every tool, versions, PATH binaries, absolute Grok and dsh, and matrix models', async () => {
  const { home, matrix, cleanup } = await fixture();
  const binaries = new Map<string, string>();
  try {
    for (const tool of matrix.tools) {
      const variant = tool.variants.find((variant) => variant.detect.binaries.length);
      if (!variant) continue;
      const path = tool.key === 'grok' ? join(home, '.grok/bin/grok') : tool.key === 'cursor' ? join(home, '.cursor/bin/agent') :
        tool.key === 'deepseek-harness' ? join(home, '.local/bin/dsh') : join(home, 'bin', variant.detect.binaries[0]);
      await executable(path);
      binaries.set(path, tool.key);
      // Exercise the generic matrix mechanism without guessing unconfirmed vendor commands.
      variant.models = { args: ['fixture-models'], pattern: '^([a-zA-Z0-9][a-zA-Z0-9._:/+-]*)$' };
    }
    const desktop = matrix.tools.find((tool) => tool.key === 'claude-desktop')!.variants[0];
    desktop.detect.apps = ['~/Applications/Claude.app'];
    const info = join(home, 'Applications/Claude.app/Contents/Info.plist');
    await mkdir(dirname(info), { recursive: true });
    await writeFile(info, 'fixture');
    const calls: { file: string; args: readonly string[]; env?: NodeJS.ProcessEnv }[] = [];
    const runner: Runner = async (file, args, options) => {
      calls.push({ file, args, env: options?.env });
      if (file === '/usr/bin/plutil') return { stdout: JSON.stringify({ CFBundleIdentifier: 'com.anthropic.claude', CFBundleShortVersionString: '4.5.6' }), stderr: '' };
      const tool = binaries.get(file);
      assert(tool, `unexpected binary ${file}`);
      if (args[0] === 'fixture-models') return { stdout: `provider/${tool}-model\nlocal/${tool}-model\n`, stderr: '' };
      assert.deepEqual(args, ['--version']);
      return { stdout: tool === 'cursor' ? 'Cursor Agent 1.2.3' : '1.2.3', stderr: '' };
    };
    const found = await detectTools({ home, env: { PATH: join(home, 'bin'), SOME_TOKEN: 'never-forward', API_KEY: 'never-forward', SECRET: 'never-forward' }, matrix, runner });
    assert.equal(found.length, 16);
    assert.deepEqual(new Set(found.map((tool) => tool.tool)), new Set(matrix.tools.map((tool) => tool.key)));
    for (const tool of found) {
      assert.equal(tool.version, tool.tool === 'claude-desktop' ? '4.5.6' : '1.2.3');
      assert.equal(tool.syncOnly, tool.tool === 'claude-desktop');
      assert.deepEqual(tool.models, tool.tool === 'claude-desktop' ? [] : [`provider/${tool.tool}-model`, `local/${tool.tool}-model`]);
    }
    assert(calls.every((call) => call.file.startsWith('/')));
    assert(calls.every((call) => call.env?.HOME === home && !call.env?.SOME_TOKEN && !call.env?.API_KEY && !call.env?.SECRET));
    assert(calls.some((call) => call.file === join(home, '.grok/bin/grok')));
    assert(calls.some((call) => call.file === join(home, '.local/bin/dsh')));
  } finally { await cleanup(); }
});

test('DeepSeek Harness accepts only one bare stdout version line and never probes models', async () => {
  const { home, matrix, cleanup } = await fixture();
  try {
    const binary = join(home, '.local/bin/dsh');
    await executable(binary);
    const detected = (value: string) => [{ tool: 'deepseek-harness', variant: 'cli', version: value, models: [], syncOnly: false,
      path: binary, realpath: binary }];
    for (const stdout of ['0.2.0-rc.2', '0.2.0-rc.2\n', '0.2.0-rc.2\r\n', '0.2.0+fixture\n']) {
      const calls: string[] = [];
      const runner: Runner = async (file, args, options) => {
        assert.equal(file, binary);
        assert.deepEqual(args, ['--version']);
        assert.equal(options?.timeout, 10_000);
        calls.push(file);
        return { stdout, stderr: '' };
      };
      assert.deepEqual(await detectTools({ home, matrix, runner, env: { PATH: '' } }), detected(stdout.trim()));
      assert.deepEqual(calls, [binary]);
    }
    for (const stdout of ['', 'dsh 0.2.0-rc.2\n', "Dancer's shell version 0.25.10\n", 'v0.2.0-rc.2\n',
      '0.2\n', ' 0.2.0-rc.2\n', '0.2.0-rc.2 \n', 'banner\n0.2.0-rc.2\n', '0.2.0-rc.2\nwarning\n',
      '0.2.0-rc.2\n0.2.0-rc.2\n', '0.2.0-rc.2\n\n', '\n0.2.0-rc.2\n', '0.2.0-rc.2\u0000\n']) {
      const runner: Runner = async () => ({ stdout, stderr: '' });
      assert.deepEqual(await detectTools({ home, matrix, runner, env: { PATH: '' } }), [], JSON.stringify(stdout));
    }
    for (const output of [{ stdout: '', stderr: '0.2.0-rc.2\n' }, { stdout: '0.2.0-rc.2\n', stderr: 'warning\n' }]) {
      const runner: Runner = async () => output;
      assert.deepEqual(await detectTools({ home, matrix, runner, env: { PATH: '' } }), []);
    }
    const broken: Runner = async () => { throw new Error('version command failed'); };
    assert.deepEqual(await detectTools({ home, matrix, runner: broken, env: { PATH: '' } }), []);
  } finally { await cleanup(); }
});

test('DeepSeek Harness prefers its home binary, falls back to PATH, and detects one CLI variant', async () => {
  const { home, matrix, cleanup } = await fixture();
  try {
    const local = join(home, '.local/bin/dsh'), path = join(home, 'bin/dsh');
    await executable(path);
    const calls: string[] = [];
    const runner: Runner = async (file) => {
      calls.push(file);
      return { stdout: file === local ? '0.2.0-rc.2\n' : '0.2.0-rc.1\n', stderr: '' };
    };
    const env = { PATH: join(home, 'bin') };
    assert.equal((await detectTools({ home, matrix, runner, env }))[0].version, '0.2.0-rc.1');
    assert.deepEqual(calls.splice(0), [path]);
    await executable(local);
    const found = await detectTools({ home, matrix, runner, env });
    assert.equal(found.length, 1);
    assert.equal(found[0].version, '0.2.0-rc.2');
    assert.deepEqual(calls.splice(0), [local]);
    const wrongLocal: Runner = async (file) => {
      calls.push(file);
      return { stdout: file === local ? 'distributed shell 0.25.10\n' : '0.2.0-rc.2\n', stderr: '' };
    };
    assert.equal((await detectTools({ home, matrix, runner: wrongLocal, env }))[0].version, '0.2.0-rc.2');
    assert.deepEqual(calls, [local, path]);
  } finally { await cleanup(); }
});

test('apps use plutil, IDE installation manifests report versions, and stale settings do not count as CLIs', async () => {
  const { home, matrix, cleanup } = await fixture();
  try {
    const codex = matrix.tools.find((tool) => tool.key === 'codex')!;
    codex.variants[1].detect.apps = ['~/Applications/ChatGPT.app'];
    codex.variants[2].detect.configPaths = ['~/.vscode/extensions/openai.chatgpt-*/package.json'];
    const info = join(home, 'Applications/ChatGPT.app/Contents/Info.plist');
    await mkdir(dirname(info), { recursive: true });
    await writeFile(info, 'fixture');
    const manifest = join(home, '.vscode/extensions/openai.chatgpt-1.0.0/package.json');
    await mkdir(dirname(manifest), { recursive: true });
    await writeFile(manifest, JSON.stringify({ name: 'chatgpt', version: '1.0.0' }));
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude/settings.json'), '{}');
    const runner: Runner = async (file, args) => {
      assert.equal(file, '/usr/bin/plutil');
      assert.deepEqual(args, ['-convert', 'json', '-o', '-', info]);
      return { stdout: JSON.stringify({ CFBundleIdentifier: 'com.openai.chat', CFBundleShortVersionString: '3.2.1' }), stderr: '' };
    };
    assert.deepEqual(await detectTools({ home, matrix, runner, env: { PATH: '' } }), [
      { tool: 'codex', variant: 'desktop', version: '3.2.1', models: [], syncOnly: true },
      { tool: 'codex', variant: 'ide', version: '1.0.0', models: [], syncOnly: true },
    ]);
    assert.equal(JSON.parse(await readFile(manifest, 'utf8')).version, '1.0.0');
  } finally { await cleanup(); }
});

test('Cursor never runs Grok agent directly or through realpath aliases and rejects wrong identity', async () => {
  const { home, matrix, cleanup } = await fixture();
  try {
    const grokAgent = join(home, '.grok/bin/agent');
    await executable(grokAgent);
    await mkdir(join(home, 'bin'), { recursive: true });
    await symlink(grokAgent, join(home, 'bin/agent'));
    const calls: string[] = [];
    const runner: Runner = async (file) => { calls.push(file); return { stdout: 'Cursor Agent 1.2.3', stderr: '' }; };
    assert.deepEqual(await detectTools({ home, matrix, runner, env: { PATH: `${join(home, '.grok/bin')}:${join(home, 'bin')}` } }), []);
    assert.deepEqual(calls, []);
    await executable(join(home, '.cursor/bin/agent'));
    const wrongIdentity: Runner = async () => ({ stdout: 'Grok Agent 0.2.20', stderr: '' });
    assert.deepEqual(await detectTools({ home, matrix, runner: wrongIdentity, env: { PATH: '' } }), []);
    const found = await detectTools({ home, matrix, runner, env: { PATH: '' } });
    assert.equal(found.length, 1);
    assert.equal(found[0].tool, 'cursor');
    assert.deepEqual(calls, [join(home, '.cursor/bin/agent')]);
  } finally { await cleanup(); }
});

test('model discovery is unique, bounded at fifty, and command failure keeps the detected tool', async () => {
  const { home, matrix, cleanup } = await fixture();
  try {
    const binary = join(home, '.grok/bin/grok');
    await executable(binary);
    const output = ['header with spaces', 'first/model', 'first/model', 'bad\u0000model', ...Array.from({ length: 70 }, (_, index) => `local/model-${index}`)].join('\n');
    const runner: Runner = async (_file, args) => ({ stdout: args[0] === '--version' ? 'Grok CLI 1.0.52' : output, stderr: '' });
    const found = await detectTools({ home, matrix, runner, env: { PATH: '' } });
    assert.equal(found[0].models.length, 50);
    assert.equal(found[0].models[0], 'first/model');
    assert.equal(new Set(found[0].models).size, 50);
    const failModels: Runner = async (_file, args) => {
      if (args[0] !== '--version') throw new Error('not logged in');
      return { stdout: 'Grok CLI 1.0.52', stderr: '' };
    };
    const failed = await detectTools({ home, matrix, runner: failModels, env: { PATH: '' } });
    assert.equal(failed[0].version, '1.0.52');
    assert.deepEqual(failed[0].models, []);
  } finally { await cleanup(); }
});
