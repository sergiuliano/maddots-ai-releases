import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import childProcess, { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import fsPromises from 'node:fs/promises';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile, symlink } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { TOOL_MATRIX } from '../src/shared/tool-matrix.js';
import { RELEASE } from '../src/release-identity.js';
import { LinuxProcError, parseLinuxProcStat, type LinuxProcScope } from '../src/linux-proc.js';
import type { Adapter, Invocation, RunSpec } from '../src/runner/adapter.js';
import { adapters, AdapterRegistry } from '../src/runner/adapters/index.js';
import { buildToolEnvironment, cleanupRunHomes, computeRunDeadline, enforceAdapter, enforceExecutableAdapter, processStartIdentity, PROCESS_CLEANUP_CAP_MS, ProcessCleanupError, ProcessRefusal, recoverProcess, startTool, timeoutSeconds, type ProcessGroup, type ProcessInspector } from '../src/runner/process.js';
import { RunnerState } from '../src/runner/state.js';
import { nativeFixtureProcesses, requireNativeFixtureInspection } from './native-process-fixture.js';

const fake = fileURLToPath(new URL('./fixtures/fake-tool.mjs', import.meta.url));
const fixturePlatform = process.platform;
const testInspector: ProcessInspector = {
  fencePids: async () => [], table: async () => [],
  identity: async (pid) => { try { process.kill(pid, 0); return `fixture-${pid}`; } catch { return null; } },
  inspect: async pid => {
    if (fixturePlatform === 'linux') {
      try {
        const row = parseLinuxProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'), pid);
        return row.zombie ? null : {...row, startedAt: `fixture-${pid}`};
      } catch (error) {
        if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
        throw error;
      }
    }
    try {
      const {stdout} = await promisify(execFile)('/bin/ps', ['-p', String(pid), '-o', 'pid=,ppid=,pgid='], {env: {LC_ALL: 'C'}, timeout: 2000});
      const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/u.exec(stdout);
      assert(row && Number(row[1]) === pid, 'fixture snapshot must describe the requested current child');
      return {pid, ppid: Number(row[2]), pgid: Number(row[3]), startedAt: `fixture-${pid}`};
    } catch (error) {
      const result = error as {code?: number; stdout?: string; stderr?: string};
      if (result.code === 1 && result.stdout === '' && result.stderr === '') return null;
      throw error;
    }
  },
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[0]);
    }
    return true;
  } catch { return false; }
};
const delay = (milliseconds: number) => new Promise(done => setTimeout(done, milliseconds));
const flush = () => new Promise<void>(done => setImmediate(done));
async function advanceTime(t: TestContext, milliseconds: number): Promise<void> {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 25) {
    t.mock.timers.tick(Math.min(25, milliseconds - elapsed));
    await flush();
  }
}
function mockPlatform(t: TestContext, platform: NodeJS.Platform): void {
  if (process.platform === platform) return;
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', {...descriptor, value: platform});
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
}
/** Current Darwin cleanup contract. Linux migrated scenarios remain explicit
 * unresolved obligations in runner-linux-recovery-authority, and admitted Linux
 * workloads use the native containment suite rather than host-PID test cleanup. */
const darwinTest: typeof test = ((name: string, optionsOrBody: any, maybeBody?: any) => {
  const options = typeof optionsOrBody === 'function' ? {} : optionsOrBody;
  const body = typeof optionsOrBody === 'function' ? optionsOrBody : maybeBody;
  return test(name + ' (Darwin backend)', options, async t => {mockPlatform(t, 'darwin'); await body(t);});
}) as typeof test;

/** Actual legacy workload I/O requires its native Darwin host. */
const darwinNativeTest: typeof test = ((name: string, optionsOrBody: any, maybeBody?: any) => {
  const options = typeof optionsOrBody === 'function' ? {} : optionsOrBody;
  const body = typeof optionsOrBody === 'function' ? optionsOrBody : maybeBody;
  return test(name + ' (native Darwin)', {...options, skip: fixturePlatform !== 'darwin' ?
    'Native Darwin workload fixture required; Linux uses retained containment fixtures.' : options.skip}, body);
}) as typeof test;

async function waitUntil(check: () => boolean | Promise<boolean>, milliseconds = 2000): Promise<void> {
  const until = Date.now() + milliseconds;
  while (!await check()) {
    if (Date.now() >= until) assert.fail('fixture did not reach expected process state');
    await delay(20);
  }
}
async function settledWithin<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('process pipes did not settle within the bound')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
async function killFixture(pid: number): Promise<void> {
  if (pid <= 1) return;
  try { process.kill(pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  await waitUntil(() => !alive(pid));
}

async function fixture(mode = 'echo') {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-process-'));
  const runDir = join(root, '.maddots', 'runs', 'fixture');
  await mkdir(runDir, { recursive: true });
  const bin = await realpath(process.execPath);
  const promptFile = join(runDir, 'prompt.md');
  await writeFile(promptFile, 'Do the work');
  const matrix = structuredClone(TOOL_MATRIX);
  matrix.tools.find((item) => item.key === 'codex')!.run = { adapter: 'codex', card: 'TLS-26', offered: true, platforms: {darwin: {accepted: true}, linux: {accepted: true}}, folderOnly: 'os-sandbox', mcpLevel: 'servers-off', reason: null, checkedAt: '2026-10-14' };
  let identityCalls = 0;
  let parseCalls = 0;
  const adapter: Adapter = {
    info: { tool: 'codex', harness: 'codex', card: 'TLS-26', folderOnly: 'os-sandbox', mcpLevel: 'servers-off', skillsDir: '{runDir}/skills', promptVia: 'stdin', runHome: false },
    identity: async () => { identityCalls++; return { ok: true, version: '1.0.0' }; },
    supports: () => ({ ok: true, reason: null }),
    build: (spec) => ({ argv: [spec.bin, fake, mode], env: {}, envUnset: [], stdinFile: spec.promptFile, files: [], projectFiles: [], spawnCwd: null, secretEnv: {} }),
    parse: (result) => { parseCalls++; return { ok: result.exitCode === 0, text: result.stdout.trim(), failureCode: result.exitCode === 0 ? null : 'tool_failed' }; },
  };
  const spec: RunSpec = { bin, cwd: root, runDir, promptFile, model: 'fixture', provider: null, effort: null, access: process.platform === 'linux' ? 'full_access' : 'folder_only', skillsDir: join(runDir, 'skills'), maxTurns: 50, timeoutSeconds: 0, runHome: null };
  // These private files are written by the fixture itself before its root exits.
  // They keep detached children visible to native fence inspection as well as
  // to each test's independent final liveness assertion.
  const nativeProcesses = nativeFixtureProcesses(async () => Promise.all((await readdir(root))
    .filter(name => name.endsWith('.pid')).map(name => readFile(join(root, name), 'utf8').then(Number))));
  return { root, adapter, spec, matrix, nativeProcesses, counts: () => ({ identityCalls, parseCalls }), cleanup: () => rm(root, { recursive: true, force: true }) };
}

function launch(f: Awaited<ReturnType<typeof fixture>>, extra: Partial<Parameters<typeof startTool>[0]> = {}) {
  return startTool({ adapter: f.adapter, spec: f.spec, matrix: f.matrix, claimedAt: Date.now(), expiresAt: Date.now() + 7_200_000, maxRunMinutes: 1, processes: testInspector, ...extra });
}

test('registry resolves both tool and harness and rejects duplicates', async () => {
  const f = await fixture();
  try {
    const registry = new AdapterRegistry([f.adapter]);
    assert.equal(registry.get('codex'), f.adapter);
    assert.throws(() => registry.register(f.adapter), /ADAPTER_ALREADY_REGISTERED/u);
  } finally { await f.cleanup(); }
});

test('run seeds remain unoffered pending real-tool canary checks', () => {
  assert.equal(TOOL_MATRIX.tools.filter((item) => item.run !== null).length, 15);
  assert(TOOL_MATRIX.tools.every((item) => item.run === null || item.run.offered === false));
  assert(TOOL_MATRIX.tools.filter(item => !['codex', 'claude-code'].includes(item.key))
    .every(item => item.run === null || item.run.folderOnly === 'none'));
});

test('Linux real adapter static eligibility never grants executable admission without an authentic operation', {skip: process.platform !== 'linux'}, async () => {
  const bin = await realpath(process.execPath);
  let executableChecks = 0;
  for (const registered of adapters.list()) for (const access of ['folder_only', 'full_access'] as const) {
    const adapter: Adapter = {...registered,
      preflight: async () => {executableChecks++; throw new Error('unclaimed preflight');},
      identity: async () => {executableChecks++; throw new Error('unclaimed identity');}};
    const input = {adapter, bin, model: 'fixture', provider: null, effort: null, access};
    // OpenCode still requires an explicit supported local provider selection.
    const eligible = access === 'full_access' && ['codex', 'claude-code'].includes(adapter.info.tool);
    assert.deepEqual(await enforceAdapter(input),
      {ok: eligible, code: eligible ? null : 'adapter_refused', version: null}, adapter.info.tool);
    assert.equal((await enforceExecutableAdapter(input)).ok, false, adapter.info.tool);
  }
  assert.equal(executableChecks, 0);
});

darwinTest('native fixture admission cannot be reached through production configuration', async () => {
  const f = await fixture();
  try {
    assert.equal((await enforceAdapter({adapter: f.adapter, ...f.spec, matrix: f.matrix})).ok, true,
      'the explicit test matrix admits the same verified fixture on both platforms');
    for (const matrix of [undefined, TOOL_MATRIX]) {
      let spawned = false;
      await assert.rejects(launch(f, {matrix, processes: f.nativeProcesses, onSpawn: () => {spawned = true;}}), {code: 'adapter_refused'});
      assert.equal(spawned, false);
    }
    assert(TOOL_MATRIX.tools.every(tool => tool.run === null || !tool.run.offered));
  } finally { await f.cleanup(); }
});

test('Linux native fixture inspection fails closed when its own child fence is unreadable', {skip: process.platform !== 'linux'}, async t => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {env: {}, stdio: 'ignore'});
  const exited = new Promise<void>(done => {child.once('exit', () => done()); child.once('error', () => done());});
  const originalOpen = fsPromises.open;
  const denied = t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof originalOpen>) => {
    if (String(args[0]) === `/proc/${child.pid}/environ`) throw Object.assign(new Error('fixture-owned fence denied'), {code: 'EACCES'});
    return originalOpen(...args);
  });
  syncBuiltinESMExports();
  try {
    await new Promise<void>((done, reject) => {child.once('spawn', done); child.once('error', reject);});
    assert(child.pid && child.pid > 1);
    const inspector = nativeFixtureProcesses(async () => [child.pid!])!;
    await assert.rejects(inspector.fencePids!('a'.repeat(32)), {code: 'permission'});
  } finally {
    denied.mock.restore(); syncBuiltinESMExports();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
});

darwinNativeTest('offering, supports, executable identity, capabilities and exact forbidden tokens are enforced', async () => {
  const f = await fixture();
  try {
    const input = { adapter: f.adapter, ...f.spec, matrix: f.matrix };
    assert.equal((await enforceAdapter({ ...input, bin: 'node' })).code, 'adapter_refused');
    const agent = join(f.root, 'agent');
    await symlink(f.spec.bin, agent);
    assert.equal((await enforceAdapter({ ...input, bin: agent })).code, 'adapter_refused');
    assert.equal((await enforceAdapter({ ...input, recordedRealpath: join(f.root, 'missing') })).code, 'tool_identity');
    f.matrix.tools.find((item) => item.key === 'codex')!.run!.platforms = {darwin: {accepted: false}, linux: {accepted: false}};
    assert.equal((await enforceAdapter(input)).code, 'adapter_refused');
    assert.equal((await enforceAdapter({ ...input, allowNotOffered: true })).ok, !RELEASE);
    f.matrix.tools.find((item) => item.key === 'codex')!.run!.platforms = {darwin: {accepted: true}, linux: {accepted: true}};
    assert.equal((await enforceAdapter({ ...input, allowNotOffered: true })).ok, !RELEASE);
    f.adapter.supports = () => ({ ok: false, reason: 'unsupported model' });
    assert.equal((await enforceAdapter(input)).code, 'adapter_refused');
    f.adapter.supports = () => ({ ok: true, reason: null });
    f.adapter.info.mcpLevel = 'tools-denied';
    assert.equal((await enforceAdapter(input)).code, 'adapter_refused');
    f.adapter.info.mcpLevel = 'servers-off';
    const build = f.adapter.build;
    for (const flag of ['--bare', '--mcp-config', '--approve-mcps', '--allow-all-paths', '--allow-all-urls', '-k', '--key', '--api-key', '--mcp']) {
      f.adapter.build = (spec) => ({ ...build(spec), argv: [spec.bin, fake, 'echo', flag] });
      await assert.rejects(launch(f), (error: unknown) => error instanceof ProcessRefusal && error.code === 'adapter_refused');
    }
    f.adapter.build = (spec) => ({ ...build(spec), argv: [spec.bin, fake, 'echo', 'text mentions --mcp-config here'] });
    assert.equal((await (await launch(f)).finished).ok, true);
  } finally { await f.cleanup(); }
});

darwinTest('identity cache invalidates on binary replacement or update', async () => {
  const f = await fixture();
  try {
    const bin = join(f.root, 'binary');
    await writeFile(bin, 'first', { mode: 0o700 });
    const input = { adapter: f.adapter, ...f.spec, bin, matrix: f.matrix };
    assert.equal((await enforceExecutableAdapter(input)).ok, true);
    assert.equal((await enforceExecutableAdapter(input)).ok, true);
    assert.equal(f.counts().identityCalls, 1);
    await writeFile(bin, 'second content');
    assert.equal((await enforceExecutableAdapter(input)).ok, true);
    assert.equal(f.counts().identityCalls, 2);
  } finally { await f.cleanup(); }
});

for (const platform of ['linux', 'darwin'] as const) test(`${platform} static eligibility never executes identity or preflight`, async t => {
  mockPlatform(t, platform);
  const f = await fixture();
  try {
    let probes = 0;
    f.adapter.preflight = async () => { probes++; throw new Error('must not execute before claim'); };
    const input = {adapter: f.adapter, ...f.spec, matrix: f.matrix};
    assert.deepEqual(await enforceAdapter(input), {ok: true, code: null, version: null});
    assert.equal(probes, 0);
    assert.equal(f.counts().identityCalls, 0);
    const run = f.matrix.tools.find(tool => tool.key === 'codex')!.run!;
    run.offered = true;
    run.platforms = {[platform === 'linux' ? 'darwin' : 'linux']: {accepted: true}};
    assert.equal((await enforceAdapter(input)).code, platform === 'linux' ? null : 'adapter_refused');
    assert.equal((await enforceExecutableAdapter(input)).code, 'adapter_refused');
    if (platform === 'linux') assert.equal((await enforceExecutableAdapter({...input, allowNotOffered: true})).code, 'adapter_refused');
    assert.equal(probes, 0);
    assert.equal(f.counts().identityCalls, 0);
  } finally { await f.cleanup(); }
});

test('Linux candidates without authentic operations and forbidden tools refuse before every executable check', async t => {
  mockPlatform(t, 'linux');
  const f = await fixture();
  try {
    let executableChecks = 0;
    for (const tool of ['codex', 'claude-code', 'opencode', 'devin', 'cursor', 'deepseek-harness']) {
      f.adapter.info.tool = tool;
      f.adapter.preflight = async () => {executableChecks++; return {ok: true, reason: null};};
      f.adapter.identity = async () => {executableChecks++; return {ok: true, version: 'fixture'};};
      for (const allowNotOffered of [undefined, true]) for (const acceptanceOperation of [undefined, {kind: 'linux-acceptance-operation'} as const]) {
        assert.equal((await enforceExecutableAdapter({...f.spec, adapter: f.adapter, allowNotOffered, acceptanceOperation})).code,
          'adapter_refused', tool);
      }
    }
    assert.equal(executableChecks, 0);
  } finally { await f.cleanup(); }
});

test('Linux accepted Codex and Claude refuse Folder only before all executable checks without fallback', async t => {
  mockPlatform(t, 'linux');
  const f = await fixture();
  try {
    for (const tool of ['codex', 'claude-code']) {
      f.adapter.info.tool = tool;
      f.matrix.tools.find(entry => entry.key === tool)!.run!.platforms = {linux: {accepted: true}};
      const input = {...f.spec, access: 'folder_only' as const, adapter: f.adapter, matrix: f.matrix};
      f.adapter.preflight = async () => assert.fail('Folder only must refuse before executable preflight.');
      f.adapter.identity = async () => assert.fail('Folder only must refuse before executable identity.');
      assert.equal((await enforceAdapter(input)).code, 'adapter_refused');
      assert.equal((await enforceExecutableAdapter(input)).code, 'adapter_refused');
      assert.equal(input.access, 'folder_only');
      assert.equal((await enforceAdapter({...input, access: 'full_access'})).ok, true);
    }
  } finally {await f.cleanup();}
});

for (const platform of ['linux', 'darwin'] as const) test(`${platform} accepted noncandidate retains ordinary executable eligibility`, async t => {
  mockPlatform(t, platform);
  const f = await fixture();
  try {
    f.adapter.info.tool = 'continue';
    const run = f.matrix.tools.find(tool => tool.key === 'continue')!.run!;
    run.offered = false;
    run.platforms = {[platform]: {accepted: true}};
    const input = {...f.spec, access: 'full_access' as const, adapter: f.adapter, matrix: f.matrix};
    assert.equal((await enforceAdapter(input)).ok, true);
    assert.equal(f.counts().identityCalls, 0);
    assert.equal((await enforceExecutableAdapter(input)).ok, true);
    assert.equal(f.counts().identityCalls, 1);
    run.platforms = {};
    assert.equal((await enforceExecutableAdapter(input)).code, 'adapter_refused');
    assert.equal(f.counts().identityCalls, 1);
  } finally { await f.cleanup(); }
});

for (const platform of ['linux', 'darwin'] as const) test(`${platform} executable checks repeat preflight before cached identity and respect operation bounds`, async t => {
  mockPlatform(t, platform);
  const f = await fixture();
  try {
    const controller = new AbortController();
    const operation = {signal: controller.signal, deadline: Date.now() + 60_000};
    const input = {adapter: f.adapter, ...f.spec, matrix: f.matrix, operation};
    let calls = 0, accepted = true;
    f.adapter.preflight = async spec => {
      calls++;
      assert.equal(spec?.bin, f.spec.bin);
      assert.equal(spec?.operation, operation);
      return {ok: accepted, reason: null};
    };
    assert.equal((await enforceExecutableAdapter(input)).ok, true);
    assert.equal((await enforceExecutableAdapter(input)).ok, true);
    assert.equal(f.counts().identityCalls, 1);
    assert.equal(calls, 2);
    accepted = false;
    assert.equal((await enforceExecutableAdapter(input)).code, 'adapter_refused');
    f.adapter.preflight = async () => { throw new Error('inspection unavailable'); };
    assert.equal((await enforceExecutableAdapter(input)).code, 'adapter_refused');
    f.adapter.preflight = async () => { assert.fail('expired probe'); };
    assert.equal((await enforceExecutableAdapter({...input, operation: {deadline: Date.now() - 1}})).code, 'adapter_refused');
    controller.abort();
    assert.equal((await enforceExecutableAdapter(input)).code, 'adapter_refused');
    assert.equal(f.counts().identityCalls, 1);
  } finally { await f.cleanup(); }
});

test('a binary changed during preflight is refused before identity', async () => {
  const f = await fixture();
  try {
    const bin = join(f.root, 'changing-preflight'); await writeFile(bin, 'before', {mode: 0o700});
    f.adapter.preflight = async () => { await writeFile(bin, 'changed'); return {ok: true, reason: null}; };
    assert.equal((await enforceExecutableAdapter({...f.spec, adapter: f.adapter, matrix: f.matrix, bin})).code, 'tool_identity');
    assert.equal(f.counts().identityCalls, 0);
  } finally { await f.cleanup(); }
});

darwinTest('verified adapter rejects prohibited subcommands after global options and with versioned canonical binaries before spawning', async () => {
  for (const [tool, canonical, command, globalOption] of [
    ['codex', 'codex', 'app', '--model'],
    ['cursor', 'cursor', 'agent', '--profile'],
    ['copilot', 'gh', 'copilot', '--hostname'],
    ['devin', 'devin', '.', '--model'],
  ]) {
    for (const version of ['', '-0.1.3']) {
      const f = await fixture();
      try {
        f.adapter.info.tool = tool;
        const run = f.matrix.tools.find(item => item.key === 'codex')!.run!;
        const target = f.matrix.tools.find(item => item.run?.adapter === tool)!;
        target.run = { ...run, adapter: tool };
        // This synthetic accepted CLI must reach the command guard, including
        // when the production tool remains sync-only pending acceptance.
        target.variants = target.variants.map(variant => variant.key === 'cli' ? {...variant, syncOnly: false} : variant);
        f.spec.bin = join(f.root, `${canonical}${version}`);
        await writeFile(f.spec.bin, '#!/bin/sh\nprintf "launched\\n"\n', { mode: 0o700 });
        const original = f.adapter.build;
        let spawns = 0;
        for (const args of [[command], [globalOption, 'fixture', command], [`${globalOption}=fixture`, command], [globalOption, 'fixture', '--', command]]) {
          f.adapter.build = spec => ({ ...original(spec), argv: [spec.bin, ...args] });
          await assert.rejects(launch(f, { onSpawn: () => { spawns++; } }), { code: 'adapter_refused' });
        }
        assert.equal(f.counts().identityCalls, tool === 'devin' ? 0 : 1, 'forbidden tools refuse before identity; eligible tools verify before command enforcement');
        assert.equal(spawns, 0);
        await assert.rejects(stat(join(f.spec.runDir, 'stdout.log')), { code: 'ENOENT' });
      } finally { await f.cleanup(); }
    }
  }
});

darwinNativeTest('subcommand parsing consumes option values and does not treat prompt material as commands', async () => {
  const f = await fixture();
  try {
    const original = f.adapter.build;
    f.adapter.build = spec => ({ ...original(spec), argv: [spec.bin, '--model', 'app', fake, 'echo'] });
    // Node rejects --model, but the core must allow the non-command value.
    const result = await (await launch(f)).finished;
    assert.equal(result.failureCode, 'tool_failed');
    assert.equal(f.counts().parseCalls, 1);
  } finally { await f.cleanup(); }
});

test('environment is constructed fresh and strips helper tokens and ambient credentials', async () => {
  const env = await buildToolEnvironment(process.execPath, { MADDOTS_X: 'value', KEEP: 'yes', BAD: 'pm_run_secret', OTHER: 'mdai_skill_secret', API_KEY: 'provider-secret' }, ['LANG'], { HOME: tmpdir(), USER: 'fixture', LANG: 'en_US', OPENAI_API_KEY: 'secret', MADDOTS_TOKEN: 'mdai_secret', EVIL: 'bad', SHELL: '/bin/zsh' });
  assert.equal(env.KEEP, 'yes');
  assert.equal(env.USER, process.platform === 'linux' ? undefined : 'fixture');
  if (process.platform === 'linux') {assert.equal(env.HOME, undefined); assert.equal(env.SHELL, undefined); assert.equal(env.SSH_AUTH_SOCK, undefined);}
  assert.equal(env.TERM, 'dumb');
  assert.equal(env.NO_COLOR, '1');
  assert(!Object.keys(env).some((name) => /MADDOTS|API_KEY|EVIL/u.test(name)));
  assert(!Object.values(env).some((value) => /^(?:pm_|mdai_)/u.test(value ?? '')));
  assert.equal(env.LANG, undefined);
});

darwinNativeTest('fake tool gets stdin and clean env; output logs remain private', async () => {
  const f = await fixture('dump');
  try {
    const original = f.adapter.build;
    f.adapter.build = (spec) => ({ ...original(spec), env: { KEEP: 'yes', MADDOTS_SECRET: 'secret', BAD_VALUE: 'pm_run_secret', MDAI_RUN_FENCE: 'adapter-controlled' }, envUnset: ['MDAI_RUN_FENCE'] });
    let persisted = false;
    const running = await launch(f, { onSpawn: async (pid, startedAt) => { assert(pid > 1); assert(startedAt); persisted = true; } });
    const result = await running.finished;
    assert(result.ok);
    assert(persisted);
    const output = JSON.parse(result.text) as { env: Record<string, string>; argv: string[] };
    assert.equal(output.env.KEEP, 'yes');
    assert.match(running.fence, /^[a-f0-9]{32}$/u);
    assert.equal(output.env.MDAI_RUN_FENCE, running.fence);
    assert.equal(process.env.MDAI_RUN_FENCE, undefined);
    assert.equal(output.env.MADDOTS_SECRET, undefined);
    assert.equal(output.env.BAD_VALUE, undefined);
    assert.equal((await stat(join(f.spec.runDir, 'stdout.log'))).mode & 0o777, 0o600);
    assert.equal(f.counts().parseCalls, 1);
  } finally { await f.cleanup(); }
});

darwinNativeTest('config files are constrained to config, are private, and reject symlink traversal', async () => {
  for (const bad of [false, true]) {
    const f = await fixture();
    try {
      const original = f.adapter.build;
      f.adapter.build = (spec) => ({ ...original(spec), files: [{ path: join(spec.runDir, bad ? '../escape' : 'config/settings.json'), content: '{}', mode: 0o777 }] });
      if (bad) await assert.rejects(launch(f), /adapter_refused/u);
      else {
        await (await launch(f)).finished;
        assert.equal((await stat(join(f.spec.runDir, 'config/settings.json'))).mode & 0o777, 0o600);
      }
    } finally { await f.cleanup(); }
  }
  const f = await fixture();
  try {
    await symlink(f.root, join(f.spec.runDir, 'config'));
    await assert.rejects(launch(f), /adapter_refused/u);
  } finally { await f.cleanup(); }
});

darwinNativeTest('large arg prompts are replaced with the prompt-file instruction', async () => {
  const f = await fixture();
  try {
    const prompt = 'x'.repeat(65537);
    await writeFile(f.spec.promptFile, prompt);
    f.adapter.info.promptVia = 'arg';
    f.adapter.build = (spec): Invocation => ({ argv: [spec.bin, fake, 'dump', prompt], env: {}, envUnset: [], files: [], projectFiles: [], stdinFile: null, spawnCwd: null, secretEnv: {} });
    const result = await (await launch(f)).finished;
    assert.deepEqual(JSON.parse(result.text).argv, ['dump', `Follow the task in ${f.spec.promptFile}.`]);
  } finally { await f.cleanup(); }
});

darwinTest('run-home and secret-env behavior stays unavailable to other tools', async () => {
  const f = await fixture();
  try {
    f.adapter.info.runHome = true;
    await assert.rejects(launch(f), /adapter_refused/u);
    f.adapter.info.runHome = false;
    const original = f.adapter.build;
    f.adapter.build = (spec) => ({ ...original(spec), secretEnv: { DEEPSEEK_API_KEY: 'provider-key:deepseek' } });
    await assert.rejects(launch(f), /adapter_refused/u);
  } finally { await f.cleanup(); }
});

test('deadline takes every bound and tool-side timeout retains its safety margin', () => {
  assert.equal(computeRunDeadline(0, 9_000_000, 5), 300_000);
  assert.equal(computeRunDeadline(0, 600_000, 120), 300_000);
  assert.equal(computeRunDeadline(0, 10_000_000, 200), 7_200_000);
  assert.equal(timeoutSeconds(90_000, 0), 60);
});

darwinNativeTest('stop reason wins over exit-zero output and parse is never called', async () => {
  const f = await fixture('sleep');
  try {
    const running = await launch(f);
    await running.stop('heartbeat_stop');
    const result = await running.finished;
    assert.equal(result.failureCode, 'heartbeat_stop');
    assert.equal(result.stopped, true);
    assert.equal(f.counts().parseCalls, 0);
  } finally { await f.cleanup(); }
});

darwinNativeTest('self-check kills MCP or browser tools before parsing', async () => {
  const f = await fixture('mcp');
  try {
    f.adapter.selfCheck = (stdout) => stdout.includes('maddots-canary') ? { mcpServers: ['maddots-canary'], browserTools: [] } : null;
    const result = await (await launch(f)).finished;
    assert.equal(result.failureCode, 'mcp_started');
    assert.equal(f.counts().parseCalls, 0);
  } finally { await f.cleanup(); }
});

darwinTest('recovery refuses stale PID identities without signalling', async () => {
  assert.equal(await recoverProcess(process.pid, 'different', testInspector), false);
  assert.equal(await recoverProcess(process.pid, '', testInspector), false);
  for (const pid of [-1, 0, 1, 1.5]) assert.equal(await recoverProcess(pid, `fixture-${pid}`, testInspector), false);
});

for (const outage of [false, true]) darwinNativeTest(`a throwing first identity inspection kills the spawned child with ${outage ? 'unavailable' : 'working'} cleanup inspection`, async () => {
  const f = await fixture('sleep');
  let root = 0, saved = false, inspecting = false;
  try {
    const inspector: ProcessInspector = {...testInspector,
      table: async () => {if (outage && inspecting) throw new Error('proc unavailable'); return [];},
      identity: async pid => {root = pid; inspecting = true; throw new Error('proc unavailable');}};
    await assert.rejects(launch(f, {processes: inspector, onGroups: groups => {saved ||= groups.some(group => group.pgid > 1 && !group.startedAt);}}), {code: outage ? 'tool_failed' : 'adapter_refused'});
    assert(root > 1);
    assert(saved, 'the spawn-window group remains durable for restart recovery');
    await waitUntil(() => !alive(root));
  } finally {
    if (root > 1 && alive(root)) await killFixture(root);
    await f.cleanup();
  }
});

darwinNativeTest('deadline removes an escaped grandchild with real ps', {skip: !['darwin', 'linux'].includes(process.platform) && 'POSIX process groups required'}, async (context) => {
  if (!await processStartIdentity(process.pid)) { assert.notEqual(process.platform, 'linux', 'Linux native identity inspection is required'); context.skip('/bin/ps denied by sandbox; Claude must rerun process-group recovery check'); return; }
  const f = await fixture('grandchild');
  if (process.platform === 'linux') {
    const pidFile = join(f.root, 'grandchild.pid');
    const build = f.adapter.build;
    f.adapter.build = spec => ({...build(spec), argv: [...build(spec).argv, pidFile]});
  }
  let grandchild = 0;
  const readGrandchild = async () => { try { grandchild ||= (JSON.parse((await readFile(join(f.spec.runDir, 'stdout.log'), 'utf8')).trim()) as { grandchild: number }).grandchild; } catch { /* fixture never started */ } return grandchild; };
  try {
    const result = await (await startTool({ adapter: f.adapter, spec: f.spec, matrix: f.matrix, claimedAt: Date.now(), expiresAt: Date.now() + 7_200_000, maxRunMinutes: 0.02, processes: f.nativeProcesses })).finished;
    assert.equal(result.failureCode, 'run_time_limit');
    assert.ok(await readGrandchild() > 1);
    assert.equal(await processStartIdentity(grandchild), null);
  } finally {
    if (await readGrandchild() > 1 && await processStartIdentity(grandchild)) await killFixture(grandchild);
    await f.cleanup();
  }
});

for (const mode of ['orphan-group-exit', 'orphan-group-stop']) {
  darwinNativeTest(`reparented same-group child is gone after ${mode} with real ps`, {skip: !['darwin', 'linux'].includes(process.platform) && 'POSIX process groups required'}, async context => {
    if (!await processStartIdentity(process.pid)) { assert.notEqual(process.platform, 'linux', 'Linux native identity inspection is required'); context.skip('/bin/ps denied by sandbox; Claude must rerun process-group recovery check'); return; }
    const f = await fixture(mode);
    let grandchild = 0;
    let running: Awaited<ReturnType<typeof startTool>> | undefined;
    const readGrandchild = async () => { try { grandchild ||= JSON.parse((await readFile(join(f.spec.runDir, 'stdout.log'), 'utf8')).trim()).grandchild as number; } catch { /* fixture not ready */ } return grandchild > 1; };
    try {
      running = await launch(f, { processes: f.nativeProcesses });
      await waitUntil(readGrandchild);
      if (mode === 'orphan-group-stop') await running.stop('heartbeat_stop');
      const result = await running.finished;
      assert.equal(result.ok, mode === 'orphan-group-exit');
      assert.equal(result.stopped, mode === 'orphan-group-stop');
      assert.equal(result.failureCode, mode === 'orphan-group-stop' ? 'heartbeat_stop' : null);
      assert.equal(await processStartIdentity(grandchild), null);
    } finally {
      await readGrandchild();
      if (grandchild > 1 && alive(grandchild)) await killFixture(grandchild);
      if (running && alive(running.pid)) await running.stop('runner_stopped');
      await f.cleanup();
    }
  });
}

darwinNativeTest('retained guardian removes an environment-cleared child forked during TERM with real processes',
  {skip: !['darwin', 'linux'].includes(process.platform) && 'POSIX process groups required'}, async () => {
  const f = await fixture();
  const pidFile = join(f.root, 'late-child.pid');
  const readyFile = join(f.root, 'term-ready');
  const program = `
    const {spawn} = require('node:child_process');
    const {writeFileSync} = require('node:fs');
    process.on('SIGTERM', () => {
      const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); process.send("ready"); setInterval(() => {}, 1000);'],
        {env: {}, stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
      child.once('message', () => {writeFileSync(process.argv[2], String(child.pid)); process.exit(0);});
    });
    writeFileSync(process.argv[3], 'ready');
    setInterval(() => {}, 1000);
  `;
  const programFile = join(f.root, 'term-fork.cjs');
  await writeFile(programFile, program);
  const original = f.adapter.build;
  f.adapter.build = spec => ({...original(spec), argv: [spec.bin, programFile, pidFile, readyFile]});
  const snapshots: ProcessGroup[][] = [];
  let running: Awaited<ReturnType<typeof launch>> | undefined, childPid = 0, toolPid = 0;
  const readChild = async () => {
    try {childPid ||= Number(await readFile(pidFile, 'utf8'));} catch { /* TERM has not forked the child yet. */ }
    return childPid > 1;
  };
  try {
    running = await launch(f, {processes: f.nativeProcesses,
      onGroups: groups => {snapshots.push(structuredClone(groups));},
      onSpawn: (_pid, _start, _group, toolRoot) => {toolPid = toolRoot?.pid ?? 0;}});
    assert.ok(toolPid > 1 && toolPid !== running.pid, 'the tool runs below the retained guardian');
    await waitUntil(async () => readFile(readyFile, 'utf8').then(value => value === 'ready', () => false)).catch(async () => {
      assert.fail(`TERM-fork fixture did not become ready: ${await readFile(join(f.spec.runDir, 'stderr.log'), 'utf8')}`);
    });
    await running.stop('heartbeat_stop');
    assert.equal((await running.finished).failureCode, 'heartbeat_stop');
    assert.equal(await readChild(), true, 'the TERM handler forked its late child');
    assert.equal(alive(toolPid), false);
    assert.equal(alive(childPid), false, 'the late child is gone despite clearing its inherited fence');
    assert.equal(alive(running.pid), false);
    assert.ok(snapshots.some(groups => groups.some(group => group.pgid === running!.pid &&
      group.members?.some(member => member.pid === childPid))), 'the guardian authenticates and persists the late child');
  } finally {
    await readChild();
    if (childPid > 1 && alive(childPid)) await killFixture(childPid);
    if (toolPid > 1 && alive(toolPid)) await killFixture(toolPid);
    if (running && alive(running.pid)) await running.stop('runner_stopped').catch(() => undefined);
    if (running) await running.finished.catch(() => undefined);
    await f.cleanup();
  }
});

for (const operation of ['normal exit', 'stop', 'recovery']) {
  darwinNativeTest(`unknown reparented process-group members are swept on ${operation}`, async () => {
    const f = await fixture(operation === 'normal exit' ? 'orphan-group-exit' : 'orphan-group-stop');
    const pidFile = join(f.root, 'grandchild.pid');
    let rootPid = 0, grandchildPid = 0;
    const signals: NodeJS.Signals[] = [];
    const readGrandchild = async () => {
      try { grandchildPid ||= Number(await readFile(pidFile, 'utf8')); } catch { /* fixture not ready */ }
      return grandchildPid > 1;
    };
    const inspector: ProcessInspector = {
      fencePids: async () => [],
      signalGroup: (pid, signal) => {
        assert.equal(pid, rootPid);
        signals.push(signal);
        // Deliver the group request to both real fixture PIDs: this sandbox
        // denies kill(-pgid) once the leader has been reaped, independently of ps.
        for (const target of [rootPid, grandchildPid]) if (target > 1 && alive(target)) {
          try { process.kill(target, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        }
      },
      identity: async pid => { rootPid ||= pid; return alive(pid) ? `fixture-${pid}` : null; },
      table: async () => {
        await readGrandchild();
        const root = rootPid > 1 && alive(rootPid) ? [{ pid: rootPid, ppid: process.pid, pgid: rootPid, startedAt: `fixture-${rootPid}` }] : [];
        // The intermediate shell has already exited. This process has no ppid
        // link to the tool and was never recorded by a descendant snapshot.
        return grandchildPid > 1 && alive(grandchildPid) ? [...root, { pid: grandchildPid, ppid: 1, pgid: rootPid, startedAt: `fixture-${grandchildPid}` }] : root;
      },
    };
    let running: Awaited<ReturnType<typeof startTool>> | undefined;
    try {
      if (operation === 'recovery') {
        const child = spawn(f.spec.bin, [fake, 'orphan-group-stop', pidFile], { detached: true, stdio: 'ignore' });
        rootPid = child.pid ?? 0;
        await waitUntil(readGrandchild);
        assert.equal(await recoverProcess(rootPid, `fixture-${rootPid}`, inspector), true);
      } else {
        const original = f.adapter.build;
        f.adapter.build = spec => ({ ...original(spec), argv: [...original(spec).argv, pidFile] });
        running = await launch(f, { processes: inspector });
        await waitUntil(readGrandchild);
        if (operation === 'stop') await running.stop('heartbeat_stop');
        const result = await running.finished;
        assert.equal(result.ok, operation === 'normal exit');
        assert.equal(result.failureCode, operation === 'stop' ? 'heartbeat_stop' : null);
      }
      assert.equal(alive(rootPid), false);
      assert.equal(alive(grandchildPid), false);
      assert.ok(signals.includes('SIGKILL'));
      if (operation !== 'normal exit') assert.equal(signals[0], 'SIGTERM');
    } finally {
      await readGrandchild();
      if (grandchildPid > 1 && alive(grandchildPid)) await killFixture(grandchildPid);
      if (rootPid > 1 && alive(rootPid)) await killFixture(rootPid);
      if (running) await running.finished;
      await f.cleanup();
    }
  });
}

darwinNativeTest('process identity and recovery survive parent time-zone and locale changes', {skip: !['darwin', 'linux'].includes(process.platform) && 'POSIX process identity required'}, async context => {
  if (!await processStartIdentity(process.pid)) { assert.notEqual(process.platform, 'linux', 'Linux native identity inspection is required'); context.skip('/bin/ps denied by sandbox; Claude must rerun identity recovery check'); return; }
  const previous = { TZ: process.env.TZ, LC_ALL: process.env.LC_ALL };
  const child = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
  try {
    assert.ok(child.pid && child.pid > 1);
    const identity = await processStartIdentity(child.pid);
    assert.ok(identity);
    process.env.TZ = 'Asia/Tokyo';
    process.env.LC_ALL = 'fr_FR.UTF-8';
    assert.equal(await processStartIdentity(child.pid), identity);
    assert.equal(await recoverProcess(child.pid, identity), true);
    assert.equal(await processStartIdentity(child.pid), null);
  } finally {
    for (const name of ['TZ', 'LC_ALL'] as const) {
      if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    }
    if (child.pid && alive(child.pid)) await killFixture(child.pid);
  }
});

for (const mode of ['detached-exit', 'recovery-detached-on-term']) {
  darwinNativeTest(`TLS21-R1-B: ${mode} is swept by its fence without ancestry`, async () => {
    const f = await fixture(mode), fence = randomBytes(16).toString('hex');
    const pidFile = join(f.root, 'detached.pid'), readyFile = join(f.root, 'ready');
    let childPid = 0, rootPid = 0;
    const readChild = async () => {
      try { childPid ||= Number(await readFile(pidFile, 'utf8')); } catch { /* not spawned yet */ }
      return childPid > 1;
    };
    const inspector: ProcessInspector = {
      ...testInspector,
      // Both backends recheck the current group at the signal boundary. Keep
      // this row consistent with the live identity so TERM creates the child.
      // The detached child has no ancestry row and is found only by its fence.
      table: async () => rootPid > 1 && alive(rootPid) ? [{pid: rootPid, ppid: process.pid, pgid: rootPid, startedAt: `fixture-${rootPid}`}] : [],
      fencePids: async value => { assert.equal(value, fence); await readChild(); return childPid > 1 && alive(childPid) ? [childPid] : []; },
    };
    try {
      if (mode === 'detached-exit') {
        const original = f.adapter.build;
        f.adapter.build = spec => ({ ...original(spec), argv: [spec.bin, fake, mode, pidFile] });
        const running = await launch(f, { fence, processes: inspector });
        rootPid = running.pid;
        assert.equal((await running.finished).ok, true);
      } else {
        const child = spawn(f.spec.bin, [fake, mode, pidFile, readyFile], {detached: true, stdio: 'ignore', env: {MDAI_RUN_FENCE: fence}});
        rootPid = child.pid!;
        await waitUntil(async () => await readFile(readyFile, 'utf8').catch(() => '') === 'ready', 4000);
        assert.equal(await recoverProcess(rootPid, `fixture-${rootPid}`, inspector, fence), true);
      }
      assert.equal(await readChild(), true);
      assert.equal(alive(rootPid), false); assert.equal(alive(childPid), false);
    } finally {
      if (childPid > 1 && alive(childPid)) await killFixture(childPid);
      if (rootPid > 1 && alive(rootPid)) await killFixture(rootPid);
      await f.cleanup();
    }
  });
}

async function realFenceInspection(context: { skip(message: string): void }): Promise<boolean> {
  try {
    if (process.platform === 'linux') await requireNativeFixtureInspection();
    else await promisify(execFile)('/bin/ps', ['-A', '-E', '-ww', '-o', 'pid=,uid=,command='], { maxBuffer: 32 * 1024 * 1024 });
    assert.ok(await processStartIdentity(process.pid));
    return true;
  } catch (error) {
    if (process.platform === 'linux') throw error;
    if ((error as NodeJS.ErrnoException).code !== 'EPERM' && !/operation not permitted|permission denied/iu.test(String(error))) throw error;
    context.skip('/bin/ps EPERM in sandbox; Claude must rerun real fence regression');
    return false;
  }
}

for (const mode of ['detached-exit', 'recovery-detached-on-term', 'shell-detached-exit']) {
  darwinNativeTest(`TLS21-R1-B: ${mode} leaves no descendant with real ps`, {skip: !['darwin', 'linux'].includes(process.platform) && 'POSIX process groups required'}, async context => {
    if (!await realFenceInspection(context)) return;
    const f = await fixture(mode);
    const pidFile = join(f.root, 'grandchild.pid'), readyFile = join(f.root, 'ready');
    const fence = randomBytes(16).toString('hex');
    let rootPid = 0, grandchildPid = 0;
    const readGrandchild = async () => {
      try { grandchildPid ||= Number(await readFile(pidFile, 'utf8')); } catch { /* child has not been started */ }
      return grandchildPid > 1;
    };
    let running: Awaited<ReturnType<typeof startTool>> | undefined;
    try {
      if (mode !== 'recovery-detached-on-term') {
        const original = f.adapter.build;
        f.adapter.build = spec => ({ ...original(spec), argv: [spec.bin, fake, mode, pidFile] });
        running = await launch(f, { processes: f.nativeProcesses, fence });
        rootPid = running.pid;
        assert.equal((await running.finished).ok, true);
      } else {
        const child = spawn(f.spec.bin, [fake, mode, pidFile, readyFile], { detached: true, stdio: 'ignore', env: { MDAI_RUN_FENCE: fence } });
        rootPid = child.pid ?? 0;
        await waitUntil(async () => await readFile(readyFile, 'utf8').catch(() => '') === 'ready');
        const identity = await processStartIdentity(rootPid);
        assert.ok(identity);
        assert.equal(await recoverProcess(rootPid, identity, f.nativeProcesses, fence), true);
      }
      assert.ok(await readGrandchild());
      assert.equal(alive(rootPid), false, 'tool leader exited');
      assert.equal(alive(grandchildPid), false, 'detached child must exit before cleanup reports completion');
    } finally {
      await readGrandchild();
      if (grandchildPid > 1 && alive(grandchildPid)) await killFixture(grandchildPid);
      if (rootPid > 1 && alive(rootPid)) await killFixture(rootPid);
      if (running) await running.finished;
      await f.cleanup();
    }
  });
}

darwinNativeTest('TLS21-R1-B: recovery with no leader kills only its exact fence with real ps', {skip: !['darwin', 'linux'].includes(process.platform) && 'POSIX process groups required'}, async context => {
  if (!await realFenceInspection(context)) return;
  const fence = randomBytes(16).toString('hex');
  const children = [
    { MDAI_RUN_FENCE: fence },
    { MDAI_RUN_FENCE: randomBytes(16).toString('hex') },
    { MDAI_RUN_FENCE: fence + 'f' },
    { OTHER_MDAI_RUN_FENCE: fence },
  ].map(env => spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env }));
  const processes = nativeFixtureProcesses(async () => children.flatMap(child => child.pid ? [child.pid] : []));
  try {
    await settledWithin(Promise.all(children.map(child => new Promise<void>(done => child.stdout.once('data', () => done())))), 4000);
    assert.equal(await recoverProcess(0, '', processes, fence), true);
    assert.equal(alive(children[0].pid!), false);
    for (const child of children.slice(1)) assert.equal(alive(child.pid!), true, 'unrelated same-user fence was untouched');
    // A stale/reused leader also grants no authority over that unrelated process.
    assert.equal(await recoverProcess(children[1].pid!, 'stale-identity', processes, fence), true);
    assert.equal(alive(children[1].pid!), true);
  } finally {
    for (const child of children) if (child.pid && alive(child.pid)) await killFixture(child.pid);
  }
});

darwinNativeTest('output caps independently bound stdout and stderr and bypass parsing', async () => {
  for (const stream of ['stdout', 'stderr']) {
    const f = await fixture('flood');
    try {
      const original = f.adapter.build;
      f.adapter.build = (spec) => ({ ...original(spec), argv: [spec.bin, fake, 'flood', stream] });
      const result = await (await launch(f)).finished;
      assert.equal(result.failureCode, 'output_too_large');
      assert.equal(result.stopped, true);
      assert.equal(f.counts().parseCalls, 0);
      assert.equal((await stat(join(f.spec.runDir, `${stream}.log`))).size, 50 * 1024 * 1024);
      assert.equal((await stat(join(f.spec.runDir, `${stream === 'stdout' ? 'stderr' : 'stdout'}.log`))).size, 0);
    } finally { await f.cleanup(); }
  }
});

darwinTest('tool-specific forbidden flags are enforced exactly and only for their tool', async () => {
  for (const tool of ['continue', 'deepseek-harness']) {
    const f = await fixture();
    try {
      f.adapter.info.tool = tool;
      f.adapter.info.harness = tool;
      f.matrix.tools.find(item => item.run?.adapter === tool)!.run = {...f.matrix.tools.find(item => item.key === 'codex')!.run!, adapter: tool};
      const original = f.adapter.build;
      const flags = tool === 'continue' ? ['--agent'] : ['--session-id', '--from-default-profile', '--dump-config', '--dump-default-config', '--dump-config-schema'];
      for (const flag of flags) {
        f.adapter.build = spec => ({...original(spec), argv: [spec.bin, fake, 'echo', flag]});
        await assert.rejects(launch(f), {code: 'adapter_refused'});
      }
      f.adapter.build = spec => ({...original(spec), argv: [spec.bin, fake, 'echo', `quoted ${flags[0]} is material`]});
      // dsh accepts only its closed launcher vector; all prompt material uses stdin.
      if (tool === 'continue') assert.equal((await (await launch(f)).finished).ok, true);
      else await assert.rejects(launch(f), {code: 'adapter_refused'});
    } finally { await f.cleanup(); }
  }
  const f = await fixture();
  try {
    const original = f.adapter.build;
    f.adapter.build = spec => ({...original(spec), argv: [spec.bin, fake, 'echo', '--agent', '--dump-config']});
    assert.equal((await (await launch(f)).finished).ok, true);
  } finally { await f.cleanup(); }
});

darwinTest('matrix claims cannot exceed adapter folder isolation or MCP isolation', async () => {
  const f = await fixture();
  try {
    const input = {...f.spec, adapter: f.adapter, matrix: f.matrix};
    f.adapter.info.folderOnly = 'no-shell';
    assert.equal((await enforceAdapter(input)).code, 'adapter_refused');
    f.adapter.info.folderOnly = 'os-sandbox';
    f.matrix.tools.find(item => item.key === 'codex')!.run!.folderOnly = 'none';
    assert.equal((await enforceAdapter(input)).code, 'adapter_refused');
    assert.equal((await enforceAdapter({...input, access: 'full_access'})).ok, true);
    f.matrix.tools.find(item => item.key === 'codex')!.run!.mcpLevel = 'tools-denied';
    f.adapter.info.mcpLevel = 'tools-denied';
    assert.equal((await enforceAdapter({...input, access: 'full_access'})).ok, true);
  } finally { await f.cleanup(); }
});

darwinTest('an executable changed during identity checking is refused and never cached', async () => {
  const f = await fixture();
  try {
    const bin = join(f.root, 'changing-binary'); await writeFile(bin, 'before', {mode: 0o700});
    f.adapter.identity = async () => { await writeFile(bin, 'changed during identity'); return {ok: true, version: 'fixture'}; };
    assert.equal((await enforceExecutableAdapter({...f.spec, adapter: f.adapter, matrix: f.matrix, bin})).code, 'tool_identity');
  } finally { await f.cleanup(); }
});

darwinNativeTest('project configs require staging callback instead of a direct project write', async () => {
  const f = await fixture();
  try {
    const original = f.adapter.build, staged: string[] = [];
    const projectFile = {path: join(f.root, 'project-settings.json'), content: '{}', mode: 0o600};
    f.adapter.build = spec => ({...original(spec), projectFiles: [projectFile]});
    await assert.rejects(launch(f), {code: 'adapter_refused'});
    const result = await (await launch(f, {stageProjectFile: async file => { assert.deepEqual(file, projectFile); staged.push(file.path); }})).finished;
    assert.equal(result.ok, true); assert.deepEqual(staged, [projectFile.path]);
    await assert.rejects(stat(projectFile.path), {code: 'ENOENT'});
  } finally { await f.cleanup(); }
});

darwinTest('unavailable process inspection refuses spawn without running the tool', async () => {
  const f = await fixture();
  try {
    await assert.rejects(launch(f, {processes: {table: async () => { throw Object.assign(new Error('operation denied'), {code: 'EPERM'}); }, identity: async () => null}}), {code: 'adapter_refused'});
    assert.equal(f.counts().parseCalls, 0); await assert.rejects(stat(join(f.spec.runDir, 'stdout.log')), {code: 'ENOENT'});
  } finally { await f.cleanup(); }
});

darwinNativeTest('live deadline uses the injected inspector and preserves its reason over tool output', async () => {
  const f = await fixture('sleep');
  try {
    const result = await (await launch(f, {maxRunMinutes: 0.003})).finished;
    assert.equal(result.failureCode, 'run_time_limit'); assert.equal(result.stopped, true); assert.equal(f.counts().parseCalls, 0);
  } finally { await f.cleanup(); }
});

darwinNativeTest('browser self-check discovery kills the tool without parsing', async () => {
  const f = await fixture('mcp');
  try {
    f.adapter.selfCheck = stdout => stdout.includes('maddots-canary') ? {mcpServers: [], browserTools: ['browser_open']} : null;
    const result = await (await launch(f)).finished;
    assert.equal(result.failureCode, 'mcp_started'); assert.equal(f.counts().parseCalls, 0);
  } finally { await f.cleanup(); }
});

darwinNativeTest('TERM tracks an escaped grandchild before its parent exits with an injected process table', async () => {
  const f = await fixture('grandchild');
  let rootPid = 0, grandchildPid = 0;
  const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[0]);
    }
    return true;
  } catch { return false; }
};
  const inspector: ProcessInspector = {
    fencePids: async () => [],
    identity: async pid => { rootPid ||= pid; return alive(pid) ? `fixture-${pid}` : null; },
    table: async () => {
      if (!rootPid) return [];
      const root = alive(rootPid) ? [{pid: rootPid, ppid: process.pid, pgid: rootPid, startedAt: `fixture-${rootPid}`}] : [];
      return grandchildPid && alive(grandchildPid) ? [...root, {pid: grandchildPid, ppid: root.length ? rootPid : 1, pgid: grandchildPid, startedAt: `fixture-${grandchildPid}`}] : root;
    },
  };
  let running: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    running = await launch(f, {processes: inspector});
    const until = Date.now() + 2000;
    while (!grandchildPid && Date.now() < until) {
      try { grandchildPid = (JSON.parse((await readFile(join(f.spec.runDir, 'stdout.log'), 'utf8')).trim()) as {grandchild: number}).grandchild; } catch { /* wait for fixture startup */ }
      if (!grandchildPid) await new Promise(done => setTimeout(done, 20));
    }
    assert.ok(grandchildPid > 1);
    await running.stop('heartbeat_stop');
    assert.equal((await running.finished).failureCode, 'heartbeat_stop');
    const reapedBy = Date.now() + 2000;
    while (alive(grandchildPid) && Date.now() < reapedBy) await new Promise(done => setTimeout(done, 20));
    assert.equal(alive(grandchildPid), false);
    assert.equal(f.counts().parseCalls, 0);
  } finally {
    if (grandchildPid && alive(grandchildPid)) process.kill(grandchildPid, 'SIGKILL');
    if (running && alive(running.pid)) await running.stop('runner_stopped');
    await f.cleanup();
  }
});

darwinTest('argv and config token smuggling are refused before any output or staged file is created', async () => {
  const f = await fixture();
  try {
    const original = f.adapter.build;
    for (const value of ['pm_run_fixture_secret', '--token=pm_run_fixture_secret', 'prefix mdai_skill_fixture_secret']) {
      f.adapter.build = spec => ({...original(spec), argv: [spec.bin, fake, 'dump', value]});
      await assert.rejects(launch(f), {code: 'adapter_refused'});
    }
    for (const field of ['files', 'projectFiles'] as const) {
      f.adapter.build = spec => ({...original(spec), [field]: [{path: join(spec.runDir, 'config', 'secret.json'), content: '{"token":"pm_run_fixture_secret"}', mode: 0o600}]});
      await assert.rejects(launch(f), {code: 'adapter_refused'});
    }
    await assert.rejects(stat(join(f.spec.runDir, 'stdout.log')), {code: 'ENOENT'});
    await assert.rejects(stat(join(f.spec.runDir, 'config/secret.json')), {code: 'ENOENT'});
  } finally { await f.cleanup(); }
});

darwinNativeTest('argv executable substitution and missing live process identity fail closed', async () => {
  const f = await fixture('sleep');
  try {
    const original = f.adapter.build;
    f.adapter.build = spec => ({...original(spec), argv: ['/usr/bin/false']});
    await assert.rejects(launch(f), {code: 'adapter_refused'});
    f.adapter.build = original;
    await assert.rejects(launch(f, {processes: {fencePids: async () => [], table: async () => [], identity: async () => null}}), {code: 'adapter_refused'});
    assert.equal(f.counts().parseCalls, 0);
  } finally { await f.cleanup(); }
});

test('run-home cleanup deletes only validated children and preserves unsafe symlinks and outside data', async () => {
  const f = await fixture();
  try {
    const data = join(f.root, 'data');
    const root = join(data, 'run-homes');
    const valid = join(root, 'test-valid');
    const outside = join(f.root, 'outside');
    await mkdir(join(valid, 'dsh-home'), { recursive: true, mode: 0o700 });
    await mkdir(join(valid, 'launch'));
    await writeFile(join(valid, 'dsh-home', 'state'), 'private');
    await mkdir(outside);
    await writeFile(join(outside, 'preserve'), 'outside');
    await symlink(outside, join(root, 'test-unsafe'));
    await assert.rejects(cleanupRunHomes(data));
    assert.equal(await readFile(join(outside, 'preserve'), 'utf8'), 'outside');
    assert.equal(await readFile(join(valid, 'dsh-home', 'state'), 'utf8'), 'private');
    await rm(join(root, 'test-unsafe'));
    await assert.rejects(cleanupRunHomes(`${data}/../outside`), { code: 'adapter_refused' });
    await cleanupRunHomes(data);
    await assert.rejects(stat(valid), { code: 'ENOENT' });
    assert((await stat(root)).isDirectory());
    assert.equal(await readFile(join(outside, 'preserve'), 'utf8'), 'outside');
    await rm(root, { recursive: true });
    await symlink(outside, root);
    await assert.rejects(cleanupRunHomes(data));
    assert.equal(await readFile(join(outside, 'preserve'), 'utf8'), 'outside');
    await cleanupRunHomes(join(f.root, 'missing-data'));
  } finally { await f.cleanup(); }
});

darwinTest('config paths reject dot traversal before a symlink can redirect the write', async () => {
  const f = await fixture();
  try {
    const outside = join(f.root, 'outside-config');
    await mkdir(join(outside, 'child'), { recursive: true });
    await mkdir(join(f.spec.runDir, 'config'));
    await symlink(join(outside, 'child'), join(f.spec.runDir, 'config/jump'));
    const original = f.adapter.build;
    f.adapter.build = spec => ({ ...original(spec), files: [{ path: `${spec.runDir}/config/jump/../stolen`, content: 'unsafe', mode: 0o600 }] });
    await assert.rejects(launch(f), { code: 'adapter_refused' });
    await assert.rejects(stat(join(outside, 'stolen')), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

for (const saved of [false, true]) {
  darwinTest(`TLS21-R1-C / Codex N1: exited leader retains ${saved ? 'persisted descendant' : 'original'} group ownership`, async () => {
    const leader = 900001, member = 900002;
    let present = true;
    const signals: NodeJS.Signals[] = [];
    const inspector: ProcessInspector = {
      identity: async pid => present && pid === member ? 'member-start' : null,
      table: async () => present ? [{pid: member, ppid: 1, pgid: leader, sid: '900003', startedAt: 'member-start'}] : [],
      fencePids: async fence => { assert.equal(fence, 'b'.repeat(32)); return present ? [member] : []; },
      signalGroup: (pid, signal) => { assert.equal(pid, leader); signals.push(signal); present = false; },
    };
    assert.equal(await recoverProcess(saved ? 0 : leader, 'original-start', inspector, 'b'.repeat(32), saved ? [{pgid: leader, startedAt: 'original-start', sid: '900003'}] : []), true);
    assert.equal(present, false);
    assert.deepEqual(signals, ['SIGTERM']);
  });
}

darwinTest('TLS21-R1-C: persisted group rejects a reused leader or different session', async () => {
  for (const reuse of ['leader', 'session']) {
    const group = {pgid: 900001, startedAt: 'original-start', sid: '900003'};
    const inspector: ProcessInspector = {
      identity: async () => 'new-start',
      table: async () => [{pid: reuse === 'leader' ? group.pgid : 900002, ppid: 1, pgid: group.pgid, sid: reuse === 'session' ? '900004' : group.sid}],
      fencePids: async () => [],
      signalGroup: () => assert.fail('must not signal a reused group'),
    };
    assert.equal(await recoverProcess(0, '', inspector, 'c'.repeat(32), [group]), true);
  }
});

for (const api of ['fenceEntries', 'fencePids'] as const) for (const identityAvailable of api === 'fencePids' ? [true, false] : [true]) {
  darwinTest(`cleanup observation scope retains ${api} orphans after later denial${identityAvailable ? '' : ' with an unresolved lifetime'}`, async t => {
    const root = 900071, fence = 'a'.repeat(32);
    const orphan = {pid: 900072, ppid: 1, pgid: 900073, sid: '900074', startedAt: 'orphan-start'};
    const scopes: LinuxProcScope[] = [], deadlines: (number | undefined)[] = [], signals: number[] = [];
    const cleanupStarted = Date.now() - PROCESS_CLEANUP_CAP_MS + 500;
    t.mock.method(process, 'kill', (target: number) => {signals.push(target); return true;});
    const scan = (value: string, deadline?: number, observed?: LinuxProcScope): boolean => {
      assert.equal(value, fence);
      scopes.push(structuredClone(observed ?? {})); deadlines.push(deadline);
      if (scopes.length === 1) return true;
      // Model a kernel-restricted task outside the original ancestry. Once a
      // fence observed it, its denial must fail, never become silent absence.
      if (observed?.pids?.includes(orphan.pid)) throw new LinuxProcError('permission');
      return false;
    };
    const inspector: ProcessInspector = {
      table: async () => [orphan],
      identity: async pid => identityAvailable && pid === orphan.pid ? orphan.startedAt : null,
      signalGroup: target => {signals.push(target);},
      ...(api === 'fenceEntries' ? {fenceEntries: async (value: string, deadline?: number, observed?: LinuxProcScope) =>
        scan(value, deadline, observed) ? [orphan] : []} :
        {fencePids: async (value: string, deadline?: number, observed?: LinuxProcScope) =>
          scan(value, deadline, observed) ? [orphan.pid] : []}),
    };
    await assert.rejects(recoverProcess(root, '', inspector, fence, [], undefined, cleanupStarted), ProcessCleanupError);
    assert(scopes.length >= 2, 'the discovery is followed by a confirmation or subsequent cleanup scan');
    assert(!scopes[0].pids?.includes(orphan.pid), 'the orphan begins outside the known run scope');
    for (const scope of scopes.slice(1)) {
      assert(scope.pids?.includes(orphan.pid), 'every later scan retains the observed orphan');
      if (identityAvailable) assert(scope.pgids?.includes(orphan.pgid), 'verified entry observations retain the orphan group');
      assert(!scope.sids?.includes(orphan.sid), 'Darwin session fields do not become usable Linux session evidence');
    }
    assert(deadlines.every(deadline => deadline === cleanupStarted + PROCESS_CLEANUP_CAP_MS), 'bounded inspection forwards the original cleanup deadline');
    assert.deepEqual(signals, [], 'observation scope grants no signal authority');
  });
}

for (const platform of ['darwin'] as ('darwin' | 'linux')[]) for (const reuse of ['no session', 'unresolved initial group', 'same session', 'leader identity', 'member identity', 'session leader identity']) {
  darwinTest(`TLS21-P1: reused group with ${reuse} is never signalled on ${platform}`, async t => {
    mockPlatform(t, platform);
    const pgid = 900001, member = 900002, session = 900003;
    const group = {pgid, startedAt: reuse === 'unresolved initial group' ? '' : 'saved-leader',
      ...(['no session', 'unresolved initial group'].includes(reuse) ? {} : {sid: String(session)}),
      ...(reuse === 'member identity' ? {members: [{pid: member, startedAt: 'saved-member'}]} : {}),
      ...(reuse === 'session leader identity' ? {sessionLeader: {pid: session, startedAt: 'saved-session-leader'}} : {})};
    const signals: number[] = [];
    let fenceScans = 0;
    const table = [
      {pid: reuse === 'leader identity' ? pgid : member, ppid: 1, pgid, sid: String(session), startedAt: 'unrelated-start'},
      ...(reuse === 'session leader identity' ? [{pid: session, ppid: 1, pgid: session, sid: String(session), startedAt: 'unrelated-session-start'}] : []),
    ];
    const inspector: ProcessInspector = {
      table: async () => table, identity: async pid => table.find(row => row.pid === pid)?.startedAt ?? null,
      fencePids: async () => { fenceScans++; return []; },
      signalGroup: pid => { signals.push(pid); table.length = 0; },
    };
    const recovery = recoverProcess(0, '', inspector, 'd'.repeat(32), [group]);
    if (reuse === 'unresolved initial group') await assert.rejects(recovery, {code: 'tool_failed'});
    else assert.equal(await recovery, true);
    assert.deepEqual(signals, []);
    assert.ok(table.length, 'unrelated processes remain alive');
    assert.ok(fenceScans > 0, 'unverified groups still require the fence scan');
  });
}

test('S3 Linux legacy persisted session identity stays pending for original and reused sessions', {skip: fixturePlatform !== 'linux'}, async () => {
  const f = await fixture();
  try {
    const state = new RunnerState(join(f.root, 'data')); await state.init();
    const runId = randomUUID(), pgid = 900001, member = 900002, session = 900003;
    const group = {pgid, startedAt: 'saved-group-leader', sid: String(session), sessionLeader: {pid: session, startedAt: 'saved-session-leader'}};
    await state.writeActive([{runId, agentId: randomUUID(), aiToolId: randomUUID(), pid: 0, startedAt: 'saved-root', phase: 'running',
      runDir: join(f.root, '.maddots', 'runs', runId), processGroups: [group]}]);
    const saved = (await state.active())[0].processGroups!;
    assert.deepEqual(saved, [group]);
    for (const reused of [false, true]) {
      let present = true;
      const signals: number[] = [];
      const inspector: ProcessInspector = {
        identity: async () => null, fencePids: async () => [],
        table: async () => [
          ...(present ? [{pid: member, ppid: 1, pgid, sid: group.sid, startedAt: 'member-start'}] : []),
          {pid: session, ppid: 1, pgid: session, sid: group.sid, startedAt: reused ? 'reused-session-leader' : group.sessionLeader.startedAt},
        ],
        signalGroup: pid => { signals.push(pid); present = false; },
      };
      await assert.rejects(recoverProcess(0, '', inspector, 'f'.repeat(32), saved), ProcessCleanupError);
      assert.deepEqual(signals, []);
      assert.equal(present, true, 'historical session witnesses cannot retire or signal a Linux run');
    }
  } finally { await f.cleanup(); }
});

for (const proof of ['fence', 'member identity']) {
  darwinTest(`TLS21-P1: genuine leaderless group with ${proof} is swept`, async () => {
    const pgid = 900001, member = 900002, session = 900003, fence = 'e'.repeat(32);
    let present = true;
    const signals: NodeJS.Signals[] = [];
    const group = {pgid, startedAt: 'saved-leader', sid: String(session),
      ...(proof === 'member identity' ? {members: [{pid: member, startedAt: 'saved-member'}]} : {}),
      ...(proof === 'session identity' ? {sessionLeader: {pid: session, startedAt: 'saved-session-leader'}} : {})};
    const inspector: ProcessInspector = {
      identity: async pid => present && pid === member ? 'saved-member' : null,
      table: async () => [
        ...(present ? [{pid: member, ppid: 1, pgid, sid: group.sid, startedAt: 'saved-member'}] : []),
        ...(proof === 'session identity' ? [{pid: session, ppid: 1, pgid: session, sid: group.sid, startedAt: 'saved-session-leader'}] : []),
      ],
      fencePids: async value => { assert.equal(value, fence); return proof === 'fence' && present ? [member] : []; },
      signalGroup: (pid, signal) => { assert.equal(pid, pgid); signals.push(signal); present = false; },
    };
    assert.equal(await recoverProcess(0, '', inspector, fence, [group]), true);
    assert.equal(present, false);
    assert.deepEqual(signals, ['SIGTERM']);
  });
}

darwinNativeTest('TLS21-R1-C: a persisted detached member remains owned after its observed leader exits', async () => {
  const f = await fixture('tracked-group-exit');
  const leaderFile = join(f.root, 'leader.pid'), memberFile = join(f.root, 'member.pid'), releaseFile = join(f.root, 'member-durable');
  const groupsFile = join(f.root, 'process-groups.json');
  let root = 0, leader = 0, member = 0;
  let released = false;
  const snapshots: ProcessGroup[][] = [];
  const read = async () => {
    try { leader ||= Number(await readFile(leaderFile, 'utf8')); } catch { /* not ready */ }
    try { member ||= Number(await readFile(memberFile, 'utf8')); } catch { /* not ready */ }
  };
  const inspector: ProcessInspector = {
    ...testInspector,
    table: async () => {
      await read();
      return [
        ...(root && alive(root) ? [{pid: root, ppid: process.pid, pgid: root, sid: String(root), startedAt: `fixture-${root}`}] : []),
        ...(leader && alive(leader) ? [{pid: leader, ppid: root, pgid: leader, sid: String(leader), startedAt: `fixture-${leader}`}] : []),
        ...(member && alive(member) ? [{pid: member, ppid: alive(leader) ? leader : 1, pgid: leader, sid: String(leader), startedAt: `fixture-${member}`}] : []),
      ];
    },
    signalGroup: (pgid, signal) => {
      for (const pid of pgid === root ? [root] : [leader, member]) if (pid && alive(pid)) process.kill(pid, signal);
    },
  };
  try {
    const original = f.adapter.build;
    f.adapter.build = spec => ({...original(spec), argv: [spec.bin, fake, 'tracked-group-exit', leaderFile, memberFile, releaseFile]});
    const running = await launch(f, {processes: inspector, onSpawn: pid => { root = pid; }, onGroups: async groups => {
      await writeFile(groupsFile, JSON.stringify(groups));
      snapshots.push(structuredClone(groups));
      if (!released && member > 1 && groups.some(group => group.pgid === leader && group.members?.some(value => value.pid === member && value.startedAt === `fixture-${member}`))) {
        assert.equal(alive(leader), true, 'the leader remains a witness until the member lifetime is durable');
        released = true;
        await writeFile(releaseFile, 'member lifetime persisted');
      }
    }});
    assert.equal((await running.finished).ok, true);
    await read();
    assert.ok(snapshots.some(groups => groups.some(group => group.pgid === root && group.sid === (process.platform === 'linux' ? String(root) : undefined))), 'the root group and any available session are persisted');
    assert.ok(snapshots.some(groups => groups.some(group => group.pgid === leader && group.sid === (process.platform === 'linux' ? String(leader) : undefined))));
    assert.ok(member > 1);
    assert.equal(released, true, 'member persistence releases the detached leader');
    assert.equal(alive(member), false, 'the saved orphan lifetime remains recoverable without a live leader');
  } finally {
    await read();
    for (const pid of [root, leader, member]) if (pid && alive(pid)) await killFixture(pid);
    await f.cleanup();
  }
});

for (const platform of ['darwin'] as ('darwin' | 'linux')[]) {
  darwinTest(`TLS21-R5 missing evidence: a direct TERM root cannot authorize its unseen unfenced orphan on ${platform}`, async t => {
    mockPlatform(t, platform);
    t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
    const root = 900083, member = 900084;
    let rootAlive = true, memberAlive = false;
    let saved: ProcessGroup[] = [{pgid: root, startedAt: 'root-start'}];
    const signals: {pgid: number; signal: NodeJS.Signals}[] = [];
    t.mock.method(process, 'kill', () => assert.fail('an unseen unfenced child must never receive a PID signal'));
    const inspector: ProcessInspector = {
      identity: async pid => pid === root && rootAlive ? 'root-start' : pid === member && memberAlive ? 'unseen-child-start' : null,
      table: async () => [
        ...(rootAlive ? [{pid: root, ppid: 1, pgid: root, startedAt: 'root-start'}] : []),
        ...(memberAlive ? [{pid: member, ppid: 1, pgid: root, startedAt: 'unseen-child-start'}] : []),
      ],
      fencePids: async () => [],
      signalGroup: (pgid, signal) => {
        assert.equal(rootAlive, true, 'only the live root authorizes the initial TERM');
        assert.equal(pgid, root); assert.equal(signal, 'SIGTERM');
        assert(saved.some(group => group.pgid === root && group.cleanupPending), 'the cleanup obligation is durable before TERM');
        signals.push({pgid, signal}); rootAlive = false; memberAlive = true;
      },
    };
    const persist = (groups: ProcessGroup[]) => { saved = structuredClone(groups); };
    for (const attempt of ['initial cleanup', 'retry without a witness']) {
      const began = Date.now();
      const recovery = recoverProcess(root, 'root-start', inspector, undefined, saved, persist);
      void recovery.catch(() => undefined);
      await flush(); await advanceTime(t, 20_000);
      await assert.rejects(recovery, ProcessCleanupError, attempt);
      assert.equal(Date.now() - began, 20_000, 'missing evidence fails within the cleanup cap');
      assert(saved.some(group => group.pgid === root && group.cleanupPending), 'failed cleanup retains its durable obligation');
      assert(saved.every(group => !group.members?.some(value => value.pid === member)), 'numeric PGID continuity cannot adopt the unseen child');
      assert.equal(memberAlive, true);
    }
    assert.deepEqual(signals, [{pgid: root, signal: 'SIGTERM'}], 'the original root TERM grants no later signal authority');
    memberAlive = false;
    assert.equal(await recoverProcess(root, 'root-start', inspector, undefined, saved, persist), true);
    assert.deepEqual(saved, [], 'a complete absence scan resolves the retained obligation');
  });

  darwinTest(`TLS21-R1-C missing evidence: an observed detached leader cannot authorize its unseen unfenced successor on ${platform}`, async t => {
    mockPlatform(t, platform);
    const f = await fixture();
    const root = 900085, leader = 900086, member = 900087;
    const child = Object.assign(new EventEmitter(), {
      pid: root, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    });
    let spawned = false;
    let phase: 'observe' | 'unseen orphan' | 'absent' = 'observe';
    let saved: ProcessGroup[] = [];
    const snapshots: ProcessGroup[][] = [], signals: number[] = [];
    t.mock.method(process, 'kill', (pid: number) => { signals.push(pid); return true; });
    const spawning = t.mock.method(childProcess, 'spawn', () => { spawned = true; return child; });
    syncBuiltinESMExports();
    t.mock.timers.enable({apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000});
    const inspector: ProcessInspector = {
      identity: async pid => phase === 'observe' && (pid === root || pid === leader) ? `${pid}-start` :
        phase === 'unseen orphan' && pid === member ? 'unseen-child-start' : null,
      table: async () => phase === 'absent' || !spawned ? [] : phase === 'unseen orphan' ?
        [{pid: member, ppid: 1, pgid: leader, startedAt: 'unseen-child-start'}] : [
          {pid: root, ppid: process.pid, pgid: root, startedAt: `${root}-start`},
          {pid: leader, ppid: root, pgid: leader, startedAt: `${leader}-start`},
        ],
      fencePids: async () => [],
      signalGroup: pgid => { signals.push(-pgid); },
    };
    const persist = (groups: ProcessGroup[]) => { saved = structuredClone(groups); snapshots.push(saved); };
    try {
      const running = await launch(f, {processes: inspector, onGroups: persist});
      await advanceTime(t, 250);
      assert(saved.some(group => group.pgid === leader && group.members?.some(value => value.pid === leader)), 'ancestry persisted the exact detached leader lifetime');
      phase = 'unseen orphan';
      child.exitCode = 0;
      child.stdout.end(); child.stderr.end(); child.stdin.destroy();
      child.emit('exit', 0, null); child.emit('close', 0, null);
      await flush(); await advanceTime(t, 20_000);
      await assert.rejects(running.finished, ProcessCleanupError);
      assert(saved.some(group => group.pgid === leader && group.cleanupPending), 'the observed group retains its cleanup obligation after leader exit');
      const retry = recoverProcess(0, '', inspector, undefined, saved, persist);
      void retry.catch(() => undefined);
      await flush(); await advanceTime(t, 20_000);
      await assert.rejects(retry, ProcessCleanupError);
      assert(saved.some(group => group.pgid === leader && group.cleanupPending), 'a retry cannot discard the missing-evidence obligation');
      assert(snapshots.every(groups => groups.every(group => !group.members?.some(value => value.pid === member))), 'the unseen unfenced child never enters the ownership ledger');
      assert.deepEqual(signals, [], 'neither historical leader identity nor numeric PGID continuity permits any signal');
      phase = 'absent';
      assert.equal(await recoverProcess(0, '', inspector, undefined, saved, persist), true);
      assert.deepEqual(saved, [], 'only a complete absence scan resolves the original transition');
    } finally {
      spawning.mock.restore(); syncBuiltinESMExports();
      await f.cleanup();
    }
  });
}

darwinNativeTest('R2-NEW-TLS21-FIX-C2: transient null identity keeps a listed descendant tracked', async () => {
  const f = await fixture('grandchild');
  let root = 0, descendant = 0, sawIdentity = false, nullSeen = false, releaseIdentity = false;
  const inspector: ProcessInspector = {
    fencePids: async () => [],
    identity: async pid => {
      if (!alive(pid)) return null;
      if (pid === descendant) {
        if (sawIdentity && !releaseIdentity) { nullSeen = true; return null; }
        sawIdentity = true;
      }
      return `fixture-${pid}`;
    },
    table: async () => {
      try { descendant ||= JSON.parse((await readFile(join(f.spec.runDir, 'stdout.log'), 'utf8')).trim()).grandchild; } catch { /* not ready */ }
      return [
        ...(root && alive(root) ? [{pid: root, ppid: process.pid, pgid: root, startedAt: `fixture-${root}`}] : []),
        ...(descendant && alive(descendant) ? [{pid: descendant, ppid: sawIdentity ? 1 : root, pgid: 0}] : []),
      ];
    },
  };
  let running: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    running = await launch(f, {processes: inspector, onSpawn: pid => { root = pid; }});
    await waitUntil(() => nullSeen);
    // The child is now reparented in the inspector, so only its retained identity
    // can authorize its later SIGKILL; neither ancestry, group nor fence can.
    releaseIdentity = true;
    await running.stop('heartbeat_stop');
    assert.equal((await running.finished).failureCode, 'heartbeat_stop');
    assert.equal(alive(descendant), false);
  } finally {
    for (const pid of [root, descendant]) if (pid && alive(pid)) await killFixture(pid);
    if (running) await running.finished.catch(() => undefined);
    await f.cleanup();
  }
});

for (const [total, batch, seconds] of [[500, 100, 1.5], [20, 20, 0.6]]) {
  darwinNativeTest(`R2-NEW-TLS21-FIX-C2: ${total} sleep children in batches of ${batch} finish normally with real ps`, {skip: !['darwin', 'linux'].includes(process.platform) && 'POSIX process groups required'}, async context => {
    if (!await realFenceInspection(context)) return;
    const f = await fixture('sleep-batches');
    try {
      const original = f.adapter.build;
      f.adapter.build = spec => ({...original(spec), argv: [spec.bin, fake, 'sleep-batches', String(total), String(batch), String(seconds)]});
      const began = Date.now();
      assert.equal((await (await launch(f, {processes: f.nativeProcesses})).finished).ok, true);
      if (total === 20) assert.ok(Date.now() - began < 2000, 'empty normal exit has no 5-second TERM grace');
    } finally { await f.cleanup(); }
  });
}

for (const deadline of [false, true]) {
  darwinNativeTest(`R2-NEW-SEC-TLS21-FENCE-PLATFORM-BINARIES: inherited pipes settle after ${deadline ? 'deadline' : 'exit cleanup'}`, async () => {
    const f = await fixture('platform-detached-exit'), pidFile = join(f.root, 'escaped.pid');
    let escaped = 0;
    try {
      const original = f.adapter.build;
      f.adapter.build = spec => ({...original(spec), argv: [spec.bin, fake, 'platform-detached-exit', pidFile, 'sh', 'pipes']});
      const running = await launch(f, {maxRunMinutes: deadline ? 0.01 : 1});
      const began = Date.now();
      const result = await settledWithin(running.finished, 2500);
      escaped = Number(await readFile(pidFile, 'utf8'));
      assert.ok(Date.now() - began < 2500, 'escaped inherited pipes cannot hold finished indefinitely');
      assert.equal(result.failureCode, deadline ? 'run_time_limit' : null);
      assert.equal(result.stopped, deadline);
      assert.equal(alive(escaped), true, 'injected invisible process documents accepted containment limit');
    } finally {
      if (!escaped) escaped = Number(await readFile(pidFile, 'utf8').catch(() => '0'));
      if (escaped && alive(escaped)) await killFixture(escaped);
      await f.cleanup();
    }
  });
}

for (const mode of ['platform-detached-exit', 'platform-detached-on-term']) {
  darwinNativeTest(`TLS21-R1-C: Apple sleep setsid accepted escape limit on ${mode} with real ps`, {skip: process.platform !== 'darwin' && 'macOS Apple binary visibility semantics (TLS-35 adds Linux)'}, async context => {
    if (!await realFenceInspection(context)) return;
    const f = await fixture(mode), pidFile = join(f.root, 'escaped.pid'), fence = randomBytes(16).toString('hex');
    let root = 0, escaped = 0;
    try {
      if (mode === 'platform-detached-exit') {
        const original = f.adapter.build;
        f.adapter.build = spec => ({...original(spec), argv: [spec.bin, fake, mode, pidFile, 'sleep']});
        const running = await launch(f, {processes: undefined, fence});
        root = running.pid;
        assert.equal((await running.finished).ok, true);
      } else {
        const child = spawn(f.spec.bin, [fake, mode, pidFile, 'sleep'], {detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: {MDAI_RUN_FENCE: fence}});
        root = child.pid!;
        await settledWithin(new Promise<void>(done => child.stdout.once('data', () => done())), 4000);
        const identity = await processStartIdentity(root);
        assert.ok(identity);
        assert.equal(await recoverProcess(root, identity, undefined, fence), true);
      }
      escaped = Number(await readFile(pidFile, 'utf8'));
      assert.equal(alive(escaped), true, 'platform binary detached before observation is the accepted limit');
      assert.equal(await recoverProcess(0, '', undefined, fence), true);
      assert.equal(alive(escaped), true, 'platform binary environment is hidden from the fence');
    } finally {
      if (!escaped) escaped = Number(await readFile(pidFile, 'utf8').catch(() => '0'));
      for (const pid of [root, escaped]) if (pid && alive(pid)) await killFixture(pid);
      await f.cleanup();
    }
  });
}

darwinNativeTest('R2-NEW-SEC-TLS21-FENCE-PLATFORM-BINARIES: detached Apple shell inherited pipes settle with real ps', {skip: process.platform !== 'darwin' && 'macOS Apple binary visibility and process semantics (TLS-35 adds Linux)'}, async context => {
  if (!await realFenceInspection(context)) return;
  const f = await fixture('platform-detached-exit'), pidFile = join(f.root, 'escaped.pid');
  let escaped = 0;
  try {
    const original = f.adapter.build;
    f.adapter.build = spec => ({...original(spec), argv: [spec.bin, fake, 'platform-detached-exit', pidFile, 'sh', 'pipes']});
    const result = await settledWithin((await launch(f, {processes: undefined, maxRunMinutes: 0.01})).finished, 9000);
    escaped = Number(await readFile(pidFile, 'utf8'));
    assert.ok(result.ok || result.failureCode === 'run_time_limit');
  } finally {
    if (!escaped) escaped = Number(await readFile(pidFile, 'utf8').catch(() => '0'));
    if (escaped && alive(escaped)) await killFixture(escaped);
    await f.cleanup();
  }
});

darwinNativeTest('Linux inherited pipes: detached shell is swept before finished settles with native proc inspection', {skip: process.platform !== 'linux', timeout: 12_000}, async context => {
  assert.equal(await realFenceInspection(context), true);
  const f = await fixture('platform-detached-exit'), pidFile = join(f.root, 'escaped.pid');
  let escaped = 0;
  try {
    const original = f.adapter.build;
    f.adapter.build = spec => ({...original(spec), argv: [spec.bin, fake, 'platform-detached-exit', pidFile, 'sh', 'pipes']});
    const result = await settledWithin((await launch(f, {processes: f.nativeProcesses})).finished, 9000);
    escaped = Number(await readFile(pidFile, 'utf8'));
    assert.equal(result.ok, true);
    assert(escaped > 1);
    assert.equal(await processStartIdentity(escaped), null, 'inherited-pipe holder must exit before completion');
    assert.equal(alive(escaped), false);
  } finally {
    if (!escaped) escaped = Number(await readFile(pidFile, 'utf8').catch(() => '0'));
    if (escaped && alive(escaped)) await killFixture(escaped);
    await f.cleanup();
  }
});

darwinNativeTest('R2-NEW-TLS21-FIX-C2: dead tracked entries are pruned before normal exit grace', async () => {
  const f = await fixture('sleep-batches');
  let root = 0, observed = false;
  const inspector: ProcessInspector = {
    fencePids: async () => [],
    table: async () => root && alive(root) ? [{pid: root, ppid: process.pid, pgid: root, startedAt: `fixture-${root}`}, {pid: 900003, ppid: root, pgid: root}] : [],
    identity: async pid => {
      if (pid === 900003) { observed = true; return root && alive(root) ? 'short-child' : null; }
      return alive(pid) ? `fixture-${pid}` : null;
    },
  };
  try {
    const original = f.adapter.build;
    f.adapter.build = spec => ({...original(spec), argv: [spec.bin, fake, 'sleep-batches', '20', '20', '0.6']});
    const began = Date.now();
    const running = await launch(f, {processes: inspector, onSpawn: pid => { root = pid; }});
    assert.equal((await running.finished).ok, true);
    assert.equal(observed, true, 'the ancestry scan recorded a child before it exited');
    assert.ok(Date.now() - began < 2000, 'dead tracked children must not add a 5-second TERM grace');
  } finally {
    if (root && alive(root)) await killFixture(root);
    await f.cleanup();
  }
});

darwinNativeTest('Codex N1: recovery sweeps the original group after the leader exited with real ps', {skip: !['darwin', 'linux'].includes(process.platform) && 'POSIX process groups required'}, async context => {
  if (!await realFenceInspection(context)) return;
  const f = await fixture('orphan-group-exit'), pidFile = join(f.root, 'orphan.pid');
  let root = 0, orphan = 0;
  try {
    const child = spawn(f.spec.bin, [fake, 'orphan-group-exit', pidFile], {detached: true, stdio: 'ignore', env: {}});
    root = child.pid!;
    const identity = await processStartIdentity(root);
    assert.ok(identity);
    await waitUntil(async () => {
      try { orphan = Number(await readFile(pidFile, 'utf8')); } catch { return false; }
      return orphan > 1;
    });
    const orphanStart = await processStartIdentity(orphan);
    assert.ok(orphanStart);
    await waitUntil(() => !alive(root));
    assert.equal(alive(orphan), true);
    assert.equal(await recoverProcess(root, identity, f.nativeProcesses, 'e'.repeat(32), [{pgid: root, startedAt: identity, members: [{pid: orphan, startedAt: orphanStart}]}]), true);
    assert.equal(alive(orphan), false, 'environment-cleared original-group child must be gone');
  } finally {
    for (const pid of [root, orphan]) if (pid && alive(pid)) await killFixture(pid);
    await f.cleanup();
  }
});

darwinNativeTest('TLS21-R1-C: fast exit during initial identity lookup retains the original group', async () => {
  const f = await fixture('orphan-group-exit'), pidFile = join(f.root, 'orphan.pid');
  let root = 0, orphan = 0, savedPgid = 0;
  const readOrphan = async () => {
    try { orphan ||= Number(await readFile(pidFile, 'utf8')); } catch { /* not ready */ }
  };
  const inspector: ProcessInspector = {
    fencePids: async () => {await readOrphan(); return orphan && alive(orphan) ? [orphan] : [];},
    identity: async pid => {
      root ||= pid;
      if (pid === root) { await waitUntil(() => !alive(root), 4000); return null; }
      return alive(pid) ? `fixture-${pid}` : null;
    },
    table: async () => {
      await readOrphan();
      return [
        ...(root && alive(root) ? [{pid: root, ppid: process.pid, pgid: root}] : []),
        ...(orphan && alive(orphan) ? [{pid: orphan, ppid: 1, pgid: root, startedAt: `fixture-${orphan}`}] : []),
      ];
    },
    signalGroup: (pgid, signal) => {
      assert.equal(pgid, root);
      for (const pid of [root, orphan]) if (pid && alive(pid)) process.kill(pid, signal);
    },
  };
  try {
    const original = f.adapter.build;
    f.adapter.build = spec => ({...original(spec), argv: [spec.bin, fake, 'orphan-group-exit', pidFile]});
    const running = await launch(f, {processes: inspector, onSpawn: (_pid, _identity, pgid) => { savedPgid = pgid; }});
    assert.equal((await running.finished).ok, true);
    assert.equal(savedPgid, root);
    assert.ok(orphan > 1);
    assert.equal(alive(orphan), false);
  } finally {
    await readOrphan();
    for (const pid of [root, orphan]) if (pid && alive(pid)) await killFixture(pid);
    await f.cleanup();
  }
});

darwinNativeTest('TLS21-R1-C: deadline during initial identity lookup stops the owned live child', async () => {
  const f = await fixture('sleep');
  let root = 0, initial = true, persistedDuringIdentity = false;
  const inspector: ProcessInspector = {
    fencePids: async () => [],
    table: async () => root && alive(root) ? [{pid: root, ppid: process.pid, pgid: root}] : [],
    identity: async pid => {
      root ||= pid;
      if (initial) { assert.equal(persistedDuringIdentity, false, 'identity capture begins before the first save'); initial = false; await delay(900); }
      return alive(pid) ? `fixture-${pid}` : null;
    },
  };
  try {
    const running = await launch(f, {processes: inspector, maxRunMinutes: 0.005, onGroups: groups => { if (groups.some(group => group.pgid > 1 && !group.startedAt)) persistedDuringIdentity = true; }});
    const result = await settledWithin(running.finished, 2500);
    assert.equal(result.failureCode, 'run_time_limit');
    assert.equal(persistedDuringIdentity, true, 'deadline cleanup persists the unresolved group while the initial lookup is pending');
    assert.equal(alive(root), false, 'unreaped direct child authority survives missing initial identity');
  } finally {
    if (root && alive(root)) await killFixture(root);
    await f.cleanup();
  }
});

darwinTest('TLS21-R1-C: persisted group with unknown live-leader identity cannot report verified cleanup', async () => {
  const leader = 900004;
  const inspector: ProcessInspector = {
    identity: async () => null,
    table: async () => [{pid: leader, ppid: 1, pgid: leader, sid: '900005'}],
    fencePids: async () => [],
    signalGroup: () => assert.fail('unknown live leader cannot authorize a group signal'),
  };
  await assert.rejects(recoverProcess(0, '', inspector, 'f'.repeat(32), [{pgid: leader, startedAt: '', sid: '900005'}]), {code: 'tool_failed'});
});

for (const sid of ['0', '', 'not-a-session', ...(process.platform === 'darwin' ? ['900010'] : [])]) {
  darwinTest(`TLS21-R5: saved unusable sid ${JSON.stringify(sid)} never authorizes an unrelated leaderless group`, async () => {
    const root = 900010, pgid = 900011, member = 900012;
    let rootAlive = true;
    const signals: number[] = [];
    const inspector: ProcessInspector = {
      identity: async pid => pid === root && rootAlive ? 'root-start' : null,
      fencePids: async () => [],
      table: async () => [
        ...(rootAlive ? [{pid: root, ppid: 1, pgid: root, sid, startedAt: 'root-start'}] : []),
        {pid: member, ppid: 1, pgid, sid, startedAt: 'unrelated-start'},
      ],
      signalGroup: target => { signals.push(target); assert.equal(target, root); rootAlive = false; },
    };
    const groups = [
      {pgid: root, startedAt: 'root-start'},
      {pgid, startedAt: 'old-group-start', sid, members: [{pid: member, startedAt: 'old-member-start'}], sessionLeader: {pid: root, startedAt: 'root-start'}},
    ];
    assert.equal(await recoverProcess(root, 'root-start', inspector, 'a'.repeat(32), groups), true);
    assert.deepEqual(signals, [root]);
    assert.ok((await inspector.table()).some(row => row.pid === member), 'unrelated group survives recovery of the live root');
  });
}

darwinNativeTest('TLS21-R5: ancestry never persists Darwin sess zero as session evidence', async () => {
  const f = await fixture('grandchild');
  const childFile = join(f.root, 'grandchild.pid');
  const build = f.adapter.build;
  f.adapter.build = spec => ({...build(spec), argv: [spec.bin, fake, 'grandchild', childFile]});
  let root = 0, child = 0;
  const groups: ProcessGroup[][] = [];
  const inspector: ProcessInspector = {
    ...testInspector,
    // Fresh leader checks must see the same unusable session as the table,
    // rather than inheriting the host's real Linux SID from testInspector.
    inspect: async pid => {
      const row = await testInspector.inspect!(pid);
      return row ? {...row, sid: '0'} : null;
    },
    table: async () => {
      try { child ||= Number(await readFile(childFile, 'utf8')); } catch { /* not yet started */ }
      return [
        ...(root && alive(root) ? [{pid: root, ppid: process.pid, pgid: root, sid: '0', startedAt: `fixture-${root}`}] : []),
        ...(child && alive(child) ? [{pid: child, ppid: root, pgid: child, sid: '0', startedAt: `fixture-${child}`}] : []),
      ];
    },
    signalGroup: (pgid, signal) => { for (const pid of [root, child]) if (pid === pgid && alive(pid)) process.kill(pid, signal); },
  };
  let running: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    running = await launch(f, {processes: inspector, onSpawn: pid => { root = pid; }, onGroups: values => { groups.push(structuredClone(values)); }});
    await waitUntil(() => groups.some(values => values.some(group => group.pgid === child && child > 1)));
    assert.ok(groups.flat().every(group => group.sid === undefined && group.sessionLeader === undefined));
    await running.stop('runner_stopped');
    assert.equal((await running.finished).failureCode, 'runner_stopped');
  } finally {
    if (running) await running.stop('runner_stopped').catch(() => undefined);
    try { child ||= Number(await readFile(childFile, 'utf8')); } catch { /* fixture did not publish a child */ }
    for (const pid of [root, child]) if (pid && alive(pid)) await killFixture(pid);
    await f.cleanup();
  }
});

for (const variant of ['later second', 'same second', 'earlier second', 'unreadable start', 'missing bound']) {
  darwinTest(`R4-NEW-NP2: unresolved spawn-window group with ${variant} keeps only justified uncertainty`, async () => {
    const pgid = 900020;
    const spawnedBy = Date.parse('2026-10-16T05:00:00.100Z');
    const start = variant === 'later second' ? 'Fri Oct 16 05:00:01 2026' : variant === 'earlier second' ? 'Fri Oct 16 04:59:59 2026' : variant === 'unreadable start' ? 'unparseable' : 'Fri Oct 16 05:00:00 2026';
    let fenceScans = 0;
    const inspector: ProcessInspector = {
      identity: async () => start,
      table: async () => [{pid: pgid, ppid: 1, pgid, startedAt: start}],
      fencePids: async () => { fenceScans++; return []; },
      signalGroup: () => assert.fail('unverified crash-window group must never be signalled'),
    };
    const recovery = recoverProcess(0, '', inspector, 'b'.repeat(32), [{pgid, startedAt: '', ...(variant === 'missing bound' ? {} : {spawnedBy})}]);
    if (variant === 'later second') assert.equal(await recovery, true);
    else await assert.rejects(recovery, {code: 'tool_failed'});
    assert.ok(fenceScans > 0, 'the run fence is scanned even when the saved group is unverified');
  });
}

darwinNativeTest('R4-NEW-NP2: spawned lifetime is captured before the first save and compared afterward', async () => {
  const f = await fixture();
  const before = Date.now();
  const identities: {pid: number; startedAt: string | null; saves: number}[] = [];
  const groups: ProcessGroup[][] = [];
  const inspector: ProcessInspector = {
    ...testInspector,
    identity: async pid => {
      const startedAt = await testInspector.identity(pid);
      identities.push({pid, startedAt, saves: groups.length});
      return startedAt;
    },
  };
  try {
    const running = await launch(f, {processes: inspector, onGroups: values => { groups.push(structuredClone(values)); }});
    assert.equal((await running.finished).ok, true);
    assert.equal(identities[0]?.saves, 0, 'the original lifetime is captured before persistence can yield');
    const initial = groups[0].find(group => group.pgid === running.pid)!;
    assert.equal(initial.startedAt, identities[0].startedAt, 'the first save contains the captured lifetime');
    assert.ok(identities.some(value => value.pid === running.pid && value.saves > 0 && value.startedAt === initial.startedAt),
      'a later comparison confirms the original lifetime after persistence');
    assert.ok(initial.spawnedBy! >= before && initial.spawnedBy! <= Date.now());
    assert.ok(groups.some(values => values.some(group => group.pgid === running.pid && group.startedAt === running.startedAt && group.spawnedBy === initial.spawnedBy)));
  } finally { await f.cleanup(); }
});

for (const platform of ['darwin'] as ('darwin' | 'linux')[]) darwinTest(`TLS21-R5: a retained guardian cleans late same-group children after TERM on ${platform}`, async t => {
  mockPlatform(t, platform);
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
  const root = 900030, member = 900031, guardian = 900032;
  t.mock.method(process, 'kill', (target: number, signal: NodeJS.Signals) => {
    assert.equal(target, guardian, 'only the independently reverified guardian can receive a PID signal');
    assert.equal(signal, 'SIGTERM');
    return true;
  });
  let rootAlive = true, memberAlive = false, guardianAlive = true;
  const signals: NodeJS.Signals[] = [];
  const snapshots: ProcessGroup[][] = [];
  const inspector: ProcessInspector = {
    identity: async pid => pid === guardian && guardianAlive ? 'guardian-start' : pid === root && rootAlive ? 'root-start' : null,
    table: async () => [
      ...(guardianAlive ? [{pid: guardian, ppid: 1, pgid: guardian, sid: String(guardian), startedAt: 'guardian-start'}] : []),
      ...(rootAlive ? [{pid: root, ppid: guardian, pgid: guardian, sid: String(guardian), startedAt: 'root-start'}] : []),
      ...(memberAlive ? [{pid: member, ppid: 1, pgid: guardian, sid: String(guardian), startedAt: 'late-member-start'}] : []),
    ],
    fencePids: async () => [],
    signalGroup: (pgid, signal) => {
      assert.equal(pgid, guardian); signals.push(signal);
      if (signal === 'SIGTERM') { rootAlive = false; memberAlive = true; }
      if (signal === 'SIGKILL') {
        assert.ok(snapshots.some(groups => groups.some(group => group.members?.some(value => value.pid === member && value.startedAt === 'late-member-start'))),
          'the late child lifetime is durable before the final group signal');
        memberAlive = guardianAlive = false;
      }
    },
  };
  const recovery = recoverProcess(guardian, 'guardian-start', inspector, 'c'.repeat(32),
    [{pgid: guardian, startedAt: 'guardian-start'}], groups => {snapshots.push(structuredClone(groups));});
  void recovery.catch(() => undefined);
  await flush();
  await advanceTime(t, 20_000);
  assert.equal(rootAlive, false);
  assert.equal(await recovery, true);
  assert.equal(memberAlive, false);
  assert.equal(guardianAlive, false);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

for (const platform of ['darwin'] as ('darwin' | 'linux')[]) darwinTest(`TLS21-R5: a reused root pid never authorizes its unrelated group on ${platform}`, async t => {
  mockPlatform(t, platform);
  t.mock.method(process, 'kill', () => assert.fail('a reused process must not receive a PID signal'));
  const root = 900040;
  let rootLookups = 0;
  const signals: {pgid: number; signal: NodeJS.Signals}[] = [];
  const inspector: ProcessInspector = {
    identity: async pid => pid === root && ++rootLookups === 1 ? 'root-start' : 'unrelated-start',
    table: async () => [
      {pid: root, ppid: 1, pgid: root, startedAt: 'unrelated-start'},
      {pid: 900041, ppid: root, pgid: root, startedAt: 'unrelated-member'},
    ],
    fencePids: async () => [],
    signalGroup: (pgid, signal) => { signals.push({pgid, signal}); },
  };
  assert.equal(await recoverProcess(root, 'root-start', inspector, 'c'.repeat(32), [{pgid: root, startedAt: 'root-start'}]), true);
  assert.deepEqual(signals, [], 'the unrelated live leader excludes verified-root authority');
});

for (const platform of ['darwin'] as ('darwin' | 'linux')[]) {
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) for (const change of ['unchanged', 'exit', 'reused PID', 'missing process', 'moved group', 'moved session', 'exit during inspection'] as const) {
    if (change === 'moved session' && (platform !== 'linux' || signal !== 'SIGKILL')) continue;
    darwinTest(`ownership parity: ${signal} rechecks child authority after delayed persistence with ${change} on ${platform}`, async t => {
      mockPlatform(t, platform);
      const f = await fixture();
      const root = 900090;
      const child = Object.assign(new EventEmitter(), {
        pid: root, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      });
      let spawned = false;
      const spawning = t.mock.method(childProcess, 'spawn', () => {spawned = true; return child;});
      syncBuiltinESMExports();
      t.mock.timers.enable({apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000});
      let reused = false, writes = 0;
      let releaseSave!: () => void, saving!: () => void;
      const delayedSave = new Promise<void>(resolve => {releaseSave = resolve;});
      const saveStarted = new Promise<void>(resolve => {saving = resolve;});
      const signals: {signal: NodeJS.Signals; exitCode: number | null}[] = [];
      const pidSignals: number[] = [];
      t.mock.method(process, 'kill', (pid: number) => {pidSignals.push(pid); return true;});
      let saved: ProcessGroup[] = [];
      const inspector: ProcessInspector = {
        sessionGuardian: signal === 'SIGKILL',
        identity: async () => reused ? 'replacement-start' : 'root-start',
        inspect: async () => {
          if (reused && change === 'missing process') return null;
          const row = {pid: root, ppid: process.pid,
            pgid: reused && change === 'moved group' ? root + 1 : root,
            sid: String(reused && change === 'moved session' ? root + 1 : root),
            startedAt: reused && ['exit', 'reused PID'].includes(change) ? 'replacement-start' : 'root-start'};
          if (reused && change === 'exit during inspection') {await flush(); exit();}
          return row;
        },
        table: async () => {if (spawned) throw new Error('injected process inspection outage'); return [];},
        fencePids: async () => [],
        signalGroup: (_pgid, kind) => {
          signals.push({signal: kind, exitCode: child.exitCode});
          if (change === 'unchanged') exit();
        },
      };
      const starting = launch(f, {processes: inspector, onGroups: async groups => {
        writes++;
        // Startup cannot establish a durable obligation. For KILL, also fail
        // cleanup's first retry so the emergency fallback owns the delayed save.
        if (writes < (signal === 'SIGTERM' ? 2 : 3)) throw new Error('injected persistence failure');
        saving();
        await delayedSave;
        saved = structuredClone(groups);
      }});
      void starting.catch(() => undefined);
      const exit = () => {
        if (child.exitCode !== null) return;
        child.exitCode = 0;
        child.stdout.end(); child.stderr.end(); child.stdin.destroy();
        child.emit('exit', 0, null); child.emit('close', 0, null);
      };
      try {
        await saveStarted;
        assert.deepEqual(signals, [], 'no signal precedes durable persistence');
        reused = change !== 'unchanged';
        if (change === 'exit') exit();
        await flush();
        releaseSave();
        await flush();
        await advanceTime(t, 20_000);
        await assert.rejects(starting, ProcessCleanupError);
        assert.deepEqual(signals, change === 'unchanged' ? [{signal, exitCode: null}] : [],
          'only unchanged authority permits a group signal');
        assert.deepEqual(pidSignals, [], 'changed authority must never permit a PID fallback');
        assert(saved.some(group => group.pgid === root && group.cleanupPending), 'failed cleanup keeps its durable obligation');
      } finally {
        exit(); releaseSave();
        await flush(); await advanceTime(t, 20_000);
        await starting.catch(() => undefined);
        spawning.mock.restore(); syncBuiltinESMExports();
        await f.cleanup();
      }
    });
  }

  darwinTest(`ownership parity: group witness lifetime is rechecked after persistence on ${platform}`, async t => {
    mockPlatform(t, platform);
    const pgid = 900060, member = 900061;
    let tables = 0, changed = false, present = true;
    const signals: number[] = [];
    t.mock.method(process, 'kill', (target: number) => { signals.push(target); return true; });
    const row = () => ({pid: member, ppid: 1, pgid, startedAt: changed ? 'reused-member' : 'original-member'});
    const inspector: ProcessInspector = {
      table: async () => { tables++; return present ? [row()] : []; },
      identity: async pid => present && pid === member ? row().startedAt : null,
      inspect: async pid => present && pid === member ? row() : null,
      fencePids: async () => [],
      signalGroup: target => { signals.push(target); present = false; },
    };
    assert.equal(await recoverProcess(0, '', inspector, 'd'.repeat(32),
      [{pgid, startedAt: 'exited-leader', members: [{pid: member, startedAt: 'original-member'}]}],
      () => { if (tables >= 2) changed = true; }), true);
    assert.equal(changed, true, 'the witness is reused after the ownership scan is persisted');
    assert.deepEqual(signals, [], 'neither a group nor PID signal may use the previous lifetime');
    assert.equal(present, true);
  });

  darwinTest(`ownership parity: fenced PID lifetime is rechecked after persistence on ${platform}`, async t => {
    mockPlatform(t, platform);
    const pid = 900062, signals: number[] = [];
    let changed = false;
    t.mock.method(process, 'kill', (target: number) => { signals.push(target); return true; });
    const inspector: ProcessInspector = {
      table: async () => [],
      identity: async () => changed ? 'reused-lifetime' : 'original-lifetime',
      fencePids: async () => changed ? [] : [pid],
      signalGroup: target => { signals.push(target); },
    };
    assert.equal(await recoverProcess(0, '', inspector, 'd'.repeat(32), [], () => { changed = true; }), true);
    assert.equal(changed, true);
    assert.deepEqual(signals, [], 'a PID discovered before persistence is no authority after reuse');
  });

  darwinTest(`ownership parity: a moved member and its child cannot adopt unrelated peers on ${platform}`, async t => {
    mockPlatform(t, platform);
    const root = 900063, member = 900064, child = 900065, unrelated = 900066;
    const live = new Set([root, member, child, unrelated]);
    const rows = [
      {pid: root, ppid: process.pid, pgid: root, startedAt: 'root-start'},
      {pid: member, ppid: root, pgid: unrelated, startedAt: 'owned-member'},
      {pid: child, ppid: member, pgid: unrelated, startedAt: 'owned-child'},
      {pid: unrelated, ppid: 1, pgid: unrelated, startedAt: 'unrelated-leader'},
    ];
    const snapshots: ProcessGroup[][] = [], groupSignals: number[] = [], pidSignals: number[] = [];
    t.mock.method(process, 'kill', (target: number) => { pidSignals.push(target); live.delete(target); return true; });
    const inspector: ProcessInspector = {
      table: async () => rows.filter(row => live.has(row.pid)),
      identity: async pid => live.has(pid) ? rows.find(row => row.pid === pid)?.startedAt ?? null : null,
      inspect: async pid => live.has(pid) ? rows.find(row => row.pid === pid) ?? null : null,
      fencePids: async () => [],
      signalGroup: pgid => {
        groupSignals.push(pgid);
        for (const row of rows) if (row.pgid === pgid) live.delete(row.pid);
      },
    };
    assert.equal(await recoverProcess(root, 'root-start', inspector, 'd'.repeat(32),
      [{pgid: root, startedAt: 'root-start', members: [{pid: member, startedAt: 'owned-member'}]}],
      groups => { snapshots.push(structuredClone(groups)); }), true);
    assert.ok(snapshots.every(groups => groups.every(group => group.pgid !== unrelated)), 'the new group is never saved as owned');
    assert.ok(!groupSignals.includes(unrelated), 'the new group never receives a signal');
    assert.ok(pidSignals.includes(member) && pidSignals.includes(child), 'owned lifetimes are still cleaned up individually');
    assert.deepEqual([...live], [unrelated]);
  });

  for (const fenced of [false, true]) darwinTest(`ownership parity: a surviving moved saved member keeps its lifetime ledger ${fenced ? 'with' : 'without'} a fence on ${platform}`, async t => {
    mockPlatform(t, platform);
    const pgid = 900067, member = 900068, newGroup = 900069;
    let now = 1_000_000;
    t.mock.method(Date, 'now', () => now);
    const snapshots: ProcessGroup[][] = [], signals: number[] = [];
    t.mock.method(process, 'kill', (target: number) => { signals.push(target); return true; });
    const inspector: ProcessInspector = {
      table: async () => { now += 3000; return [{pid: member, ppid: 1, pgid: newGroup, startedAt: 'owned-member'}]; },
      identity: async pid => pid === member ? 'owned-member' : null,
      fencePids: async () => [],
      signalGroup: () => assert.fail('a moved member cannot authorize its original or new group'),
    };
    await assert.rejects(recoverProcess(0, '', inspector, fenced ? 'd'.repeat(32) : undefined,
      [{pgid, startedAt: 'departed-leader', members: [{pid: member, startedAt: 'owned-member'}]}],
      groups => { snapshots.push(structuredClone(groups)); }), ProcessCleanupError);
    assert.ok(signals.includes(member), 'the moved lifetime receives a PID signal');
    assert.ok(snapshots.at(-1)?.some(group => group.members?.some(value => value.pid === member && value.startedAt === 'owned-member')),
      'failed cleanup retains the surviving lifetime for restart recovery');
    assert.ok(snapshots.every(groups => groups.every(group => group.pgid !== newGroup)));
  });

  darwinTest(`ownership parity: an exited verified root cannot authenticate replacement members on ${platform}`, async t => {
    mockPlatform(t, platform);
    const root = 900070, replacement = 900071;
    let now = 1_000_000, lookups = 0, present = true;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(process, 'kill', () => assert.fail('the replacement process must not receive a PID signal'));
    const snapshots: ProcessGroup[][] = [], signals: number[] = [];
    const inspector: ProcessInspector = {
      identity: async pid => pid === root && ++lookups === 1 ? 'root-start' : null,
      table: async () => {
        now += 3000;
        return present ? [{pid: replacement, ppid: 1, pgid: root, startedAt: 'unrelated-lifetime'}] : [];
      },
      fencePids: async () => [],
      signalGroup: pgid => { signals.push(pgid); present = false; },
    };
    await assert.rejects(recoverProcess(root, 'root-start', inspector, 'd'.repeat(32),
      [{pgid: root, startedAt: 'root-start'}], groups => { snapshots.push(structuredClone(groups)); }), ProcessCleanupError);
    assert.deepEqual(signals, []);
    assert.equal(present, true);
    assert.ok(snapshots.every(groups => groups.every(group => !group.members?.some(value => value.pid === replacement))),
      'a historical root identity cannot turn replacements into saved ownership evidence');
  });
}

for (const platform of ['darwin'] as ('darwin' | 'linux')[]) darwinTest(`ownership parity: recent live-group observations never authorize replacement members after root exit on ${platform}`, async t => {
  mockPlatform(t, platform);
  t.mock.method(process, 'kill', () => assert.fail('the replacement must not receive a PID signal'));
  const f = await fixture();
  const root = 900080, group = 900081, unrelated = 900082;
  const child = Object.assign(new EventEmitter(), {
    pid: root, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  });
  let spawned = false, outageScans = 0;
  const spawning = t.mock.method(childProcess, 'spawn', () => { spawned = true; return child; });
  syncBuiltinESMExports();
  t.mock.timers.enable({apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000});
  let phase: 'observe' | 'outage' | 'reused' = 'observe';
  const snapshots: ProcessGroup[][] = [], signals: number[] = [];
  const inspector: ProcessInspector = {
    identity: async pid => phase === 'observe' && (pid === root || pid === group) ? `${pid}-start` : null,
    fencePids: async () => [],
    table: async () => {
      if (phase === 'outage') { outageScans++; throw new Error('injected process inspection outage'); }
      if (phase === 'reused') return [{pid: unrelated, ppid: 1, pgid: group, startedAt: 'unrelated-start'}];
      return spawned ? [
        {pid: root, ppid: process.pid, pgid: root, startedAt: `${root}-start`},
        {pid: group, ppid: root, pgid: group, startedAt: `${group}-start`},
      ] : [];
    },
    signalGroup: pgid => { signals.push(pgid); },
  };
  const exit = () => {
    if (child.signalCode !== null) return;
    child.signalCode = 'SIGKILL';
    child.stdout.end(); child.stderr.end(); child.stdin.destroy();
    child.emit('exit', null, 'SIGKILL'); child.emit('close', null, 'SIGKILL');
  };
  let running: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    running = await launch(f, {processes: inspector, onGroups: groups => { snapshots.push(structuredClone(groups)); }});
    await advanceTime(t, 250);
    assert.ok(snapshots.some(groups => groups.some(value => value.pgid === group)), 'ancestry records the descendant group');
    phase = 'outage';
    await advanceTime(t, 600);
    assert.ok(outageScans > 0, 'inspection fails before the replacement group appears');
    phase = 'reused'; exit();
    await flush();
    await advanceTime(t, 20_000);
    await assert.rejects(running.finished, ProcessCleanupError);
    assert.deepEqual(signals, [], 'an observation from 600 ms ago cannot authorize the replacement group');
    assert.ok(snapshots.every(groups => groups.every(value => !value.members?.some(member => member.pid === unrelated))),
      'replacement members never become saved ownership evidence');
  } finally {
    phase = 'reused'; exit();
    await flush();
    if (running) { await advanceTime(t, 20_000); await running.finished.catch(() => undefined); }
    spawning.mock.restore(); syncBuiltinESMExports();
    await f.cleanup();
  }
});

darwinNativeTest('TLS21-R5: an inspection outage expires live group authority before pgid reuse', async () => {
  const outageMs = 5600;
  const f = await fixture('sleep');
  const group = 900050, unrelated = 900051;
  let root = 0, outageScans = 0;
  let phase: 'observe' | 'outage' | 'reused' = 'observe';
  const snapshots: ProcessGroup[][] = [];
  const signals: {pgid: number; signal: NodeJS.Signals}[] = [];
  const inspector: ProcessInspector = {
    identity: async pid => pid === group ? phase === 'observe' ? 'g-start' : null : alive(pid) ? `fixture-${pid}` : null,
    fencePids: async () => [],
    table: async () => {
      if (phase === 'outage') { outageScans++; throw new Error('injected process inspection outage'); }
      if (phase === 'reused') return [{pid: unrelated, ppid: 1, pgid: group, startedAt: 'unrelated-start'}];
      return root && alive(root) ? [
        {pid: root, ppid: process.pid, pgid: root, startedAt: `fixture-${root}`},
        {pid: group, ppid: root, pgid: group, startedAt: 'g-start'},
      ] : [];
    },
    signalGroup: (pgid, signal) => {
      signals.push({pgid, signal});
      if (pgid === root && alive(root)) process.kill(root, signal);
    },
  };
  let running: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    running = await launch(f, {processes: inspector, onSpawn: pid => { root = pid; }, onGroups: groups => { snapshots.push(structuredClone(groups)); }});
    await delay(800);
    assert.ok(snapshots.some(groups => groups.some(value => value.pgid === group)), 'ancestry records the descendant group before the outage');
    phase = 'outage';
    await delay(outageMs);
    assert.ok(outageScans > 0, 'inspection is unavailable before the replacement group appears');
    assert.equal(alive(root), true);
    process.kill(root, 'SIGKILL');
    phase = 'reused';
    await assert.rejects(running.finished, {code: 'tool_failed'});
    assert.ok(signals.every(value => value.pgid !== group), 'an expired observation cannot authorize the reused leaderless group');
    assert.ok(snapshots.every(groups => groups.every(value => !value.members?.some(member => member.pid === unrelated))), 'replacement members never become saved ownership evidence');
  } finally {
    phase = 'reused';
    if (root && alive(root)) await killFixture(root);
    if (running) await running.finished.catch(() => undefined);
    await f.cleanup();
  }
});
