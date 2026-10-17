import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { TOOL_MATRIX } from '../src/shared/tool-matrix.js';
import { createPaths, ensurePaths, withWriteLock } from '../src/paths.js';
import type { Adapter } from '../src/runner/adapter.js';
import { AGENT_DIALOG_INTERVAL_MS, FULL_ACCESS_WARNING, LocalAgents, reserveAgentSetupDialog, showAgentSetupDialog, validateAgentFolder,
  type AgentSetupOptions } from '../src/runner/agents-local.js';
import type { StartToolOptions } from '../src/runner/process.js';
import { readConfig } from '../src/config.js';

const agent = {agentId: '11111111-1111-4111-8111-111111111111', aiToolId: '22222222-2222-4222-8222-222222222222', handle: 'assistant'};
const anotherAgent = {agentId: '33333333-3333-4333-8333-333333333333'};
const adapter: Adapter = {
  info: {tool: 'codex', harness: 'codex', card: 'TLS-26', folderOnly: 'os-sandbox', mcpLevel: 'servers-off', skillsDir: '{cwd}/.agents/skills', promptVia: 'stdin', runHome: false},
  identity: async () => ({ok: true, version: '1.0'}), supports: () => ({ok: true, reason: null}),
  build: () => {throw new Error('The setup wrapper must replace the run invocation.');},
  parse: () => ({ok: true, text: '', failureCode: null}),
};
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'runner-agents-'))), home = join(root, 'home');
  await mkdir(home, {mode: 0o700});
  const paths = await createPaths(readConfig({MADDOTS_AI_HOME: join(home, '.helper-data')}, home)); await ensurePaths(paths);
  t.after(() => rm(root, {recursive: true, force: true}));
  const output: string[] = [], questions: string[] = [];
  const matrix = structuredClone(TOOL_MATRIX);
  Object.assign(matrix.tools.find(tool => tool.key === 'codex')!.run!, {offered: true, folderOnly: 'os-sandbox'});
  const options = (answers: string[], changes: Partial<AgentSetupOptions> = {}): AgentSetupOptions => ({
    isTTY: true, prompt: async question => {questions.push(question); assert.ok(answers.length, 'Unexpected prompt: ' + question); return answers.shift()!;},
    output: line => output.push(line), now: () => 1234, adapter, bin: '/usr/bin/true', model: 'gpt-5', matrix, ...changes,
  });
  const agents = new LocalAgents(paths);
  return {root, home, paths, agents, options, output, questions};
}

test('setup creates the private default folder and writes a private atomic local record', async t => {
  const f = await fixture(t), row = await f.agents.setup(agent, f.options(['', '']));
  assert.equal(row.folder, join(f.home, 'MadDots Agents', 'assistant-11111111'));
  assert.equal(row.folderCreated, true); assert.equal(row.access, 'folder_only'); assert.equal(row.setupDone, true);
  assert.equal((await lstat(row.folder)).mode & 0o777, 0o700);
  assert.equal((await lstat(f.agents.file)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(f.agents.file, 'utf8')), {[agent.agentId]: row});
  assert.deepEqual(await f.agents.ready(), [{agentId: agent.agentId, aiToolId: agent.aiToolId, cwd: row.folder, access: 'folder_only'}]);
  assert.equal('folder' in (await f.agents.ready())[0], false, 'Heartbeat-facing identity contains no folder field.');
});

test('typed folders resolve to owned physical folders; unsafe roots and excluded aliases are refused', async t => {
  const f = await fixture(t), folder = join(f.home, 'project'), alias = join(f.home, 'alias');
  await mkdir(folder); await symlink(folder, alias);
  assert.equal(await validateAgentFolder(f.paths, alias), folder);
  const row = await f.agents.setup(agent, f.options([alias, '']));
  assert.equal(row.folder, folder); assert.equal(row.folderCreated, false);
  const library = join(f.home, 'Library'), ownData = join(f.home, '.maddots-ai'), route = join(f.home, '.agents/skills');
  await mkdir(library); await mkdir(ownData); await mkdir(route, {recursive: true});
  const blockedAlias = join(f.home, 'blocked'); await symlink(f.paths.data, blockedAlias);
  for (const path of ['/', f.home, f.paths.data, f.paths.backups, library, ownData, route, blockedAlias, 'relative']) {
    await assert.rejects(validateAgentFolder(f.paths, path), path);
  }
  await assert.rejects(validateAgentFolder(f.paths, join(f.home, 'missing')));
  await writeFile(join(f.home, 'file'), 'x'); await assert.rejects(validateAgentFolder(f.paths, join(f.home, 'file')));
});

test('setup requires TTY; Full access needs exact typed full after the full warning', async t => {
  const f = await fixture(t);
  await assert.rejects(f.agents.setup(agent, f.options([], {isTTY: false})), {code: 'TTY_REQUIRED'});
  await assert.rejects(f.agents.setup(agent, f.options(['', 'full', 'yes'])), {code: 'ACCESS_NOT_CONFIRMED'});
  assert.equal(f.output.at(-1), FULL_ACCESS_WARNING); assert.deepEqual(await f.agents.read(), {});
  const row = await f.agents.setup(agent, f.options(['', 'full', 'full']));
  assert.equal(row.access, 'full_access'); assert.equal(row.accessConfirmedAt, 1234);
  assert.equal((await f.agents.ready())[0].access, 'full_access');
  const warningCount = f.output.filter(line => line === FULL_ACCESS_WARNING).length;
  assert.equal((await f.agents.setup(agent, f.options([row.folder, '']))).access, 'full_access');
  assert.equal(f.output.filter(line => line === FULL_ACCESS_WARNING).length, warningCount, 'Repeated setup retains the locally confirmed access.');
  assert.equal((await f.agents.access(agent, 'folder-only', f.options([], {isTTY: false}))).access, 'folder_only');
  await assert.rejects(f.agents.access(agent, 'full', f.options([], {isTTY: false})), {code: 'TTY_REQUIRED'});
  await assert.rejects(f.agents.access(agent, 'full', f.options(['FULL'])), {code: 'ACCESS_NOT_CONFIRMED'});
  assert.equal((await f.agents.ready())[0].access, 'folder_only');
  assert.equal((await f.agents.access(agent, 'full', f.options(['full']))).access, 'full_access');
});

test('server accessWanted alone cannot raise the local access reported for claims', async t => {
  const f = await fixture(t);
  const server = {...agent, accessWanted: 'full_access' as const};
  await f.agents.setup(server, f.options(['', '']));
  assert.equal((await f.agents.ready())[0].access, 'folder_only');
  assert.equal((await f.agents.read())[agent.agentId].access, 'folder_only');
  assert.equal((await readFile(f.agents.file, 'utf8')).includes('accessWanted'), false);
});

test('matrix none never silently grants Full access or accepts Folder only', async t => {
  const f = await fixture(t), matrix = structuredClone(TOOL_MATRIX);
  matrix.tools.find(tool => tool.key === 'codex')!.run!.folderOnly = 'none';
  await assert.rejects(f.agents.setup(agent, f.options(['', ''], {matrix})), {code: 'ACCESS_NOT_CONFIRMED'});
  assert.deepEqual(await f.agents.read(), {});
  assert.equal((await f.agents.setup(agent, f.options(['', 'full', 'full'], {matrix}))).access, 'full_access');
  await assert.rejects(f.agents.access(agent, 'folder-only', f.options([], {matrix})), {code: 'ACCESS_UNAVAILABLE'});
  assert.equal((await f.agents.ready())[0].access, 'full_access');
});

test('one-time setup displays argv and needs exact yes; core spawn is used once per tool and folder', async t => {
  const f = await fixture(t), argv = ['/usr/bin/true', 'skills', 'trust', 'workspace'];
  let calls = 0, runDirectory = '';
  const start: NonNullable<AgentSetupOptions['startTool']> = async (input: StartToolOptions) => {
    calls++; runDirectory = input.spec.runDir;
    assert.deepEqual(input.adapter.build(input.spec).argv, argv);
    assert.equal(input.recordedRealpath, '/usr/bin/true'); assert.equal(input.spec.access, 'folder_only');
    assert.deepEqual(input.adapter.build(input.spec).env, {}); assert.equal(input.maxRunMinutes, 5);
    return {pid: 100, startedAt: 'test', fence: '0'.repeat(32), stop: async () => {},
      finished: Promise.resolve({ok: true, text: '', failureCode: null, exitCode: 0, signal: null, stopped: false})};
  };
  const configured = {...adapter, agentSetup: () => argv};
  await assert.rejects(f.agents.setup(agent, f.options(['', '', 'YES'], {adapter: configured, startTool: start})), {code: 'SETUP_NOT_CONFIRMED'});
  assert.equal(calls, 0); assert.deepEqual(await f.agents.ready(), []);
  const row = await f.agents.setup(agent, f.options(['', '', 'yes'], {adapter: configured, startTool: start}));
  assert.equal(row.setupDone, true); assert.equal(calls, 1); assert.ok(f.output.some(line => line.includes('"skills" "trust"')));
  await assert.rejects(lstat(runDirectory), {code: 'ENOENT'});
  await f.agents.setup({...agent, ...anotherAgent, handle: 'other'}, f.options([row.folder, ''], {adapter: configured, startTool: start}));
  assert.equal(calls, 1);
});

test('failed one-time setup remains unavailable and cleans its private temporary output', async t => {
  const f = await fixture(t);
  const start: NonNullable<AgentSetupOptions['startTool']> = async () => ({pid: 100, startedAt: 'test', fence: '0'.repeat(32), stop: async () => {},
    finished: Promise.resolve({ok: false, text: '', failureCode: 'tool_failed', exitCode: 1, signal: null, stopped: false})});
  await assert.rejects(f.agents.setup(agent, f.options(['', '', 'yes'], {adapter: {...adapter, agentSetup: () => ['/usr/bin/true']}, startTool: start})), {code: 'AGENT_SETUP_FAILED'});
  assert.equal((await f.agents.read())[agent.agentId].setupDone, false); assert.deepEqual(await f.agents.ready(), []);
});

test('one-time setup completion preserves access lowered while its process was running', async t => {
  const f = await fixture(t);
  const start: NonNullable<AgentSetupOptions['startTool']> = async () => {
    await f.agents.access(agent, 'folder-only', f.options([]));
    return {pid: 100, startedAt: 'test', fence: '0'.repeat(32), stop: async () => {},
      finished: Promise.resolve({ok: true, text: '', failureCode: null, exitCode: 0, signal: null, stopped: false})};
  };
  const row = await f.agents.setup(agent, f.options(['', 'full', 'full', 'yes'], {adapter: {...adapter, agentSetup: () => ['/usr/bin/true']}, startTool: start}));
  assert.equal(row.setupDone, true); assert.equal(row.access, 'folder_only');
  assert.equal((await f.agents.ready())[0].access, 'folder_only');
});

test('unsafe state permissions, unknown access fields and replaced working folder are refused', async t => {
  const f = await fixture(t), row = await f.agents.setup(agent, f.options(['', '']));
  await chmod(f.agents.file, 0o644); await assert.rejects(f.agents.read(), {code: 'FILE_UNSAFE'}); await chmod(f.agents.file, 0o600);
  await writeFile(f.agents.file, JSON.stringify({[agent.agentId]: {...row, accessWanted: 'full_access'}}));
  await assert.rejects(f.agents.read(), {code: 'AGENTS_LOCAL_INVALID'});
  await writeFile(f.agents.file, JSON.stringify({[agent.agentId]: row}));
  await rm(row.folder, {recursive: true}); await symlink(f.paths.data, row.folder);
  assert.deepEqual(await f.agents.ready(), []);
});

test('setup dialog reserves one prompt per new agent and enforces the four-hour gap', async t => {
  const f = await fixture(t); let now = 10_000;
  const options = {execPath: '/absolute/runtime', entrypoint: "/absolute/helper's-cli.js", env: {}, timing: {now: () => now, sleep: async () => {}}};
  const reserve = (waiting: {agentId: string}[]) => withWriteLock(f.paths, () => reserveAgentSetupDialog(f.paths, waiting, options));
  assert.equal(await reserve([]), 'empty');
  const first = await reserve([agent]); assert.equal(typeof first, 'object'); if (typeof first === 'string') throw new Error();
  assert.equal((await lstat(first.command)).mode & 0o777, 0o700);
  const launcher = await readFile(first.command, 'utf8');
  assert.ok(launcher.includes("'/absolute/runtime'")); assert.ok(launcher.includes("'/absolute/helper'\\''s-cli.js' agent setup"));
  assert.equal(await reserve([agent]), 'unchanged'); assert.equal(await reserve([agent, anotherAgent]), 'throttled');
  now += AGENT_DIALOG_INTERVAL_MS;
  const second = await reserve([agent, anotherAgent]); assert.equal(typeof second, 'object'); if (typeof second === 'string') throw new Error();
  assert.equal(second.count, 2); now += AGENT_DIALOG_INTERVAL_MS; assert.equal(await reserve([agent, anotherAgent]), 'unchanged');
  const calls: {file: string; args: readonly string[]}[] = [];
  assert.equal(await showAgentSetupDialog(second, {env: {}, runner: async (file, args) => {
    calls.push({file, args}); return {stdout: file === '/usr/bin/osascript' ? 'button returned:Set up, gave up:false' : '', stderr: ''};
  }}), 'opened');
  assert.ok(calls[0].args[1].includes('2 agents need setup or Allow on this computer'));
  assert.deepEqual(calls[1], {file: '/usr/bin/open', args: ['-a', 'Terminal', second.command]});
});

test('Later never opens Terminal; relative launcher paths and symbolic launcher replacement fail safely', async t => {
  const f = await fixture(t), options = {execPath: '/absolute/runtime', entrypoint: '/absolute/helper.js', env: {}};
  await assert.rejects(reserveAgentSetupDialog(f.paths, [agent], {...options, entrypoint: 'relative'}), {code: 'NOTIFY_INVALID'});
  const dialog = await reserveAgentSetupDialog(f.paths, [agent], options); if (typeof dialog === 'string') throw new Error();
  let calls = 0;
  assert.equal(await showAgentSetupDialog(dialog, {env: {}, runner: async () => {calls++; return {stdout: 'button returned:Later, gave up:false', stderr: ''};}}), 'later');
  assert.equal(calls, 1);
  await rm(dialog.command); await symlink(join(f.home, 'other'), dialog.command);
  await assert.rejects(showAgentSetupDialog(dialog, {env: {}, runner: async () => ({stdout: 'button returned:Set up, gave up:false', stderr: ''})}), {code: 'PATH_UNSAFE'});
});

test('interrupted agent-state replacement leaves the previous complete access record intact', async t => {
  const f = await fixture(t);
  await f.agents.setup(agent, f.options(['', 'full', 'full']));
  const previous = await readFile(f.agents.file, 'utf8'), identity = await lstat(f.agents.file);
  const promises = createRequire(import.meta.url)('node:fs/promises') as typeof fsp;
  const original = promises.open;
  let interrupted = false;
  promises.open = async (...args: Parameters<typeof original>) => {
    const file = await original(...args), path = String(args[0]);
    if (dirname(path) === dirname(f.agents.file) && (path.endsWith('.tmp') || path === f.agents.file)) {
      const write = file.writeFile.bind(file);
      file.writeFile = async (...input: Parameters<typeof file.writeFile>) => {
        // Simulate a disk failure after only part of the new document reached disk.
        await write(String(input[0]).slice(0, 17)); interrupted = true;
        assert.equal(await readFile(f.agents.file, 'utf8'), previous, 'Readers must still see the complete old document during replacement.');
        throw Object.assign(new Error('Injected partial write'), {code: 'EIO'});
      };
    }
    return file;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.agents.access(agent, 'folder-only', f.options([], {isTTY: false})), {code: 'EIO'});
    assert.equal(interrupted, true, 'The write fault must be exercised.');
  } finally { promises.open = original; syncBuiltinESMExports(); }
  assert.equal(await readFile(f.agents.file, 'utf8'), previous);
  assert.equal((await f.agents.read())[agent.agentId].access, 'full_access');
  assert.equal((await lstat(f.agents.file)).ino, identity.ino);
  await f.agents.access(agent, 'folder-only', f.options([], {isTTY: false}));
  assert.equal((await f.agents.read())[agent.agentId].access, 'folder_only');
  assert.notEqual((await lstat(f.agents.file)).ino, identity.ino, 'A successful write must replace the original file.');
});

test('access changes preserve the selected agent and tool binding', async t => {
  const f = await fixture(t);
  await f.agents.setup(agent, f.options(['', 'full', 'full']));
  await assert.rejects(f.agents.access({...agent, aiToolId: anotherAgent.agentId}, 'folder-only', f.options([])), {code: 'AGENT_NOT_FOUND'});
  assert.equal((await f.agents.read())[agent.agentId].access, 'full_access');
  await f.agents.access({...agent, handle: 'renamed'}, 'folder-only', f.options([], {isTTY: false}));
  const row = (await f.agents.read())[agent.agentId];
  assert.equal(row.access, 'folder_only'); assert.equal(row.handle, 'renamed');
});
