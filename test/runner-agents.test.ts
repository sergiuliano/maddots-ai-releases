import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { TOOL_MATRIX } from '../src/shared/tool-matrix.js';
import { LINUX_FOLDER_ONLY_REASON } from '../src/shared/tool-capabilities.js';
import {enforceAdapter} from '../src/runner/process.js';
import { createPaths, ensurePaths, withWriteLock } from '../src/paths.js';
import type { Adapter } from '../src/runner/adapter.js';
import { AGENT_DIALOG_INTERVAL_MS, FULL_ACCESS_WARNING, LocalAgents, reserveAgentSetupDialog, showAgentSetupDialog, validateAgentFolder,
  type AgentSetupOptions } from '../src/runner/agents-local.js';
import type { StartToolOptions } from '../src/runner/process.js';
import { readConfig } from '../src/config.js';
import {initializeCleanRunnerJournal} from './support/runner-journal-fixture.js';

const agent = {agentId: '11111111-1111-4111-8111-111111111111', aiToolId: '22222222-2222-4222-8222-222222222222', handle: 'assistant'};
const anotherAgent = {agentId: '33333333-3333-4333-8333-333333333333'};
// Generic local-state tests need an accepted adapter with both access modes.
// The real Linux Codex/Claude policy is covered separately below.
function fixtureMatrix() {
  const matrix = structuredClone(TOOL_MATRIX), tool = matrix.tools.find(tool => tool.key === 'codex')!;
  tool.key = 'fixture-agent'; tool.run!.adapter = 'fixture-agent';
  Object.assign(tool.run!, {offered: true, platforms: {darwin: {accepted: true}, linux: {accepted: true}}, folderOnly: 'os-sandbox'});
  return matrix;
}
const adapter: Adapter = {
  info: {tool: 'fixture-agent', harness: 'fixture_agent', card: 'TLS-26', folderOnly: 'os-sandbox', mcpLevel: 'servers-off', skillsDir: '{cwd}/.agents/skills', promptVia: 'stdin', runHome: false},
  identity: async () => ({ok: true, version: '1.0'}), supports: () => ({ok: true, reason: null}),
  build: () => {throw new Error('The setup wrapper must replace the run invocation.');},
  parse: () => ({ok: true, text: '', failureCode: null}),
};
async function fixture(t: TestContext, initialized = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'runner-agents-'))), home = join(root, 'home');
  await mkdir(home, {mode: 0o700});
  const paths = await createPaths(readConfig({MADDOTS_AI_HOME: join(home, '.helper-data')}, home, 'darwin')); await ensurePaths(paths);
  if (initialized) await initializeCleanRunnerJournal(paths.data);
  t.after(() => rm(root, {recursive: true, force: true}));
  const output: string[] = [], questions: string[] = [];
  const matrix = fixtureMatrix();
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

test('setup admission refuses before creating the default working folder', async t => {
  const f = await fixture(t), retained = join(f.root, 'retained-guard');
  await writeFile(retained, 'retained guard evidence', {mode: 0o600});
  await symlink(retained, f.paths.lock + '.guard');
  const before = await lstat(retained);
  await assert.rejects(f.agents.setup(agent, f.options([''])), {code: 'PATH_UNSAFE'});
  await assert.rejects(lstat(join(f.home, 'MadDots Agents')), {code: 'ENOENT'});
  await assert.rejects(lstat(f.agents.file), {code: 'ENOENT'});
  assert.equal(await readFile(retained, 'utf8'), 'retained guard evidence');
  assert.equal((await lstat(retained)).ino, before.ino);
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
  const f = await fixture(t), matrix = fixtureMatrix();
  matrix.tools.find(tool => tool.key === 'fixture-agent')!.run!.folderOnly = 'none';
  await assert.rejects(f.agents.setup(agent, f.options(['', ''], {matrix})), {code: 'ACCESS_NOT_CONFIRMED'});
  assert.deepEqual(await f.agents.read(), {});
  assert.equal((await f.agents.setup(agent, f.options(['', 'full', 'full'], {matrix}))).access, 'full_access');
  await assert.rejects(f.agents.access(agent, 'folder-only', f.options([], {matrix})), {code: 'ACCESS_UNAVAILABLE'});
  assert.equal((await f.agents.ready())[0].access, 'full_access');
});

test('agent setup refuses absent and other-platform acceptance before prompting, tool code or folder creation', async t => {
  const f = await fixture(t), matrix = fixtureMatrix();
  const run = matrix.tools.find(tool => tool.key === 'fixture-agent')!.run!;
  run.offered = true;
  let prompts = 0, identity = 0, preflight = 0, setups = 0;
  const guarded: Adapter = {...adapter,
    identity: async () => {identity++; return {ok: true, version: 'fixture'};},
    preflight: async () => {preflight++; return {ok: true, reason: null};},
    agentSetup: () => {setups++; return ['/usr/bin/true'];},
  };
  const otherPlatform = process.platform === 'linux' ? {darwin: {accepted: true}} : {linux: {accepted: true}};
  for (const platforms of [undefined, {}, otherPlatform]) {
    run.platforms = platforms;
    await assert.rejects(f.agents.setup(agent, f.options([], {matrix, adapter: guarded,
      prompt: async () => {prompts++; return '';}})), {code: 'AGENT_SETUP_INVALID'});
    assert.deepEqual(await f.agents.read(), {});
    await assert.rejects(stat(join(f.home, 'MadDots Agents')), {code: 'ENOENT'});
  }
  assert.deepEqual({prompts, identity, preflight, setups}, {prompts: 0, identity: 0, preflight: 0, setups: 0});
  run.offered = false;
  run.platforms = {darwin: {accepted: true}, linux: {accepted: true}};
  assert.equal((await f.agents.setup(agent, f.options(['', ''], {matrix}))).access, 'folder_only');
});

for (const key of ['codex', 'claude-code']) test(`Linux ${key} setup and access refuse Folder only without silently raising access`, {skip: process.platform !== 'linux'}, async t => {
  const f = await fixture(t), matrix = structuredClone(TOOL_MATRIX);
  matrix.tools.find(tool => tool.key === key)!.run!.platforms = {linux: {accepted: true}};
  const configured = {...adapter, info: {...adapter.info, tool: key}};
  const changes = {matrix, adapter: configured};
  for (const answer of ['', 'folder-only']) {
    await assert.rejects(f.agents.setup(agent, f.options(['', answer], changes)),
      {code: 'ACCESS_NOT_CONFIRMED', message: LINUX_FOLDER_ONLY_REASON});
    assert.deepEqual(await f.agents.read(), {});
  }
  const row = await f.agents.setup(agent, f.options(['', 'full', 'full'], changes));
  assert.equal(row.access, 'full_access');
  await assert.rejects(f.agents.access(agent, 'folder-only', f.options([], changes)),
    {code: 'ACCESS_UNAVAILABLE', message: LINUX_FOLDER_ONLY_REASON});
  assert.deepEqual(await f.agents.read(), {[agent.agentId]: row});
  assert.equal(f.questions.some(question => question.includes('or type folder-only')), false);
});

test('Linux candidate local definition grants no executable setup or runner permission', {skip: process.platform !== 'linux'}, async t => {
  const f = await fixture(t);
  let executable = 0;
  const candidate: Adapter = {...adapter, info: {...adapter.info, tool: 'codex'},
    identity: async () => {executable++; return {ok: true, version: 'fixture'};},
    preflight: async () => {executable++; return {ok: true, reason: null};}};
  const changes = {matrix: TOOL_MATRIX, adapter: candidate};
  const row = await f.agents.setup(agent, f.options(['', 'full', 'full'], changes));
  assert.equal(row.access, 'full_access');
  await assert.rejects(f.agents.access(agent, 'folder-only', f.options([], changes)), {code: 'ACCESS_UNAVAILABLE'});
  assert.equal((await enforceAdapter({adapter: candidate, model: 'gpt-5', provider: null, effort: null, access: 'full_access',
    bin: '/usr/bin/true', recordedRealpath: '/usr/bin/true', matrix: TOOL_MATRIX})).ok, true,
  'static candidate eligibility never grants executable permission');
  const setup: Adapter = {...candidate, agentSetup: () => {executable++; return ['/usr/bin/true'];}};
  await assert.rejects(f.agents.setup({...agent, agentId: anotherAgent.agentId}, f.options(['', 'full', 'full'], {...changes, adapter: setup})),
    {code: 'AGENT_SETUP_AUTHORIZATION_REQUIRED'});
  assert.equal((await f.agents.read())[anotherAgent.agentId].setupDone, false);
  assert.equal(executable, 0);
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

test('Linux one-time setup refuses uninitialized durable storage before invoking a launcher', {skip: process.platform !== 'linux'}, async t => {
  const f = await fixture(t, false);
  await assert.rejects(f.agents.setup(agent, f.options(['', '', 'yes'], {
    adapter: {...adapter, agentSetup: () => ['/usr/bin/true']},
    startTool: async () => assert.fail('No durable INTENT or containment backend exists for setup.'),
  })), {code: 'RUNNER_STATE_UNAVAILABLE'});
  assert.equal((await f.agents.read())[agent.agentId].setupDone, false);
  assert.deepEqual(await f.agents.ready(), []);
  assert.equal((await fsp.readdir(join(f.paths.data, 'runner'))).some(name => name.startsWith('agent-setup-')), false);
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
  assert.equal(await showAgentSetupDialog(second, {platform: 'darwin', env: {}, runner: async (file, args) => {
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
  assert.equal(await showAgentSetupDialog(dialog, {platform: 'darwin', env: {}, runner: async () => {calls++; return {stdout: 'button returned:Later, gave up:false', stderr: ''};}}), 'later');
  assert.equal(calls, 1);
  await rm(dialog.command); await symlink(join(f.home, 'other'), dialog.command);
  await assert.rejects(showAgentSetupDialog(dialog, {platform: 'darwin', env: {}, runner: async () => ({stdout: 'button returned:Set up, gave up:false', stderr: ''})}), {code: 'PATH_UNSAFE'});
});

test('Linux setup notification prints an interactive instruction without writing or opening a desktop launcher', async t => {
  const f = await fixture(t), output: string[] = [];
  const options = {platform: 'linux' as const, env: {}, output: (line: string) => output.push(line),
    runner: async () => {assert.fail('Headless setup must not invoke a desktop command.');}};
  const dialog = await reserveAgentSetupDialog(f.paths, [agent], options);
  assert.equal(typeof dialog, 'object'); if (typeof dialog === 'string') throw new Error();
  assert.equal(dialog.command, 'maddots-ai agent setup');
  assert.equal(await showAgentSetupDialog(dialog, options), 'later');
  assert.deepEqual(output, ['1 agents need setup or Allow on this computer. Run maddots-ai agent setup in an interactive terminal.']);
  await assert.rejects(lstat(join(f.paths.data, 'agent-setup.command')), {code: 'ENOENT'});
  assert.equal(await reserveAgentSetupDialog(f.paths, [agent], options), 'unchanged');
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
