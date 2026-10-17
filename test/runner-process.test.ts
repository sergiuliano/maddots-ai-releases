import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { TOOL_MATRIX } from '../src/shared/tool-matrix.js';
import { RELEASE } from '../src/release-identity.js';
import type { Adapter, Invocation, RunSpec } from '../src/runner/adapter.js';
import { AdapterRegistry } from '../src/runner/adapters/index.js';
import { buildToolEnvironment, cleanupRunHomes, computeRunDeadline, enforceAdapter, processStartIdentity, ProcessRefusal, recoverProcess, startTool, timeoutSeconds, type ProcessInspector } from '../src/runner/process.js';
import { RunnerState } from '../src/runner/state.js';

const fake = fileURLToPath(new URL('./fixtures/fake-tool.mjs', import.meta.url));
const testInspector: ProcessInspector = { fencePids: async () => [], table: async () => [], identity: async (pid) => { try { process.kill(pid, 0); return `fixture-${pid}`; } catch { return null; } } };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const delay = (milliseconds: number) => new Promise(done => setTimeout(done, milliseconds));
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
  matrix.tools.find((item) => item.key === 'codex')!.run = { adapter: 'codex', card: 'TLS-26', offered: true, folderOnly: 'os-sandbox', mcpLevel: 'servers-off', reason: null, checkedAt: '2026-10-14' };
  let identityCalls = 0;
  let parseCalls = 0;
  const adapter: Adapter = {
    info: { tool: 'codex', harness: 'codex', card: 'TLS-26', folderOnly: 'os-sandbox', mcpLevel: 'servers-off', skillsDir: '{runDir}/skills', promptVia: 'stdin', runHome: false },
    identity: async () => { identityCalls++; return { ok: true, version: '1.0.0' }; },
    supports: () => ({ ok: true, reason: null }),
    build: (spec) => ({ argv: [spec.bin, fake, mode], env: {}, envUnset: [], stdinFile: spec.promptFile, files: [], projectFiles: [], spawnCwd: null, secretEnv: {} }),
    parse: (result) => { parseCalls++; return { ok: result.exitCode === 0, text: result.stdout.trim(), failureCode: result.exitCode === 0 ? null : 'tool_failed' }; },
  };
  const spec: RunSpec = { bin, cwd: root, runDir, promptFile, model: 'fixture', provider: null, effort: null, access: 'folder_only', skillsDir: join(runDir, 'skills'), maxTurns: 50, timeoutSeconds: 0, runHome: null };
  return { root, adapter, spec, matrix, counts: () => ({ identityCalls, parseCalls }), cleanup: () => rm(root, { recursive: true, force: true }) };
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
  assert(TOOL_MATRIX.tools.every((item) => item.run === null || item.run.folderOnly === 'none'));
});

test('offering, supports, executable identity, capabilities and exact forbidden tokens are enforced', async () => {
  const f = await fixture();
  try {
    const input = { adapter: f.adapter, ...f.spec, matrix: f.matrix };
    assert.equal((await enforceAdapter({ ...input, bin: 'node' })).code, 'adapter_refused');
    const agent = join(f.root, 'agent');
    await symlink(f.spec.bin, agent);
    assert.equal((await enforceAdapter({ ...input, bin: agent })).code, 'adapter_refused');
    assert.equal((await enforceAdapter({ ...input, recordedRealpath: join(f.root, 'missing') })).code, 'tool_identity');
    f.matrix.tools.find((item) => item.key === 'codex')!.run!.offered = false;
    assert.equal((await enforceAdapter(input)).code, 'adapter_refused');
    assert.equal((await enforceAdapter({ ...input, allowNotOffered: true })).ok, !RELEASE);
    f.matrix.tools.find((item) => item.key === 'codex')!.run!.offered = true;
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

test('identity cache invalidates on binary replacement or update', async () => {
  const f = await fixture();
  try {
    const bin = join(f.root, 'binary');
    await writeFile(bin, 'first', { mode: 0o700 });
    const input = { adapter: f.adapter, ...f.spec, bin, matrix: f.matrix };
    assert.equal((await enforceAdapter(input)).ok, true);
    assert.equal((await enforceAdapter(input)).ok, true);
    assert.equal(f.counts().identityCalls, 1);
    await writeFile(bin, 'second content');
    assert.equal((await enforceAdapter(input)).ok, true);
    assert.equal(f.counts().identityCalls, 2);
  } finally { await f.cleanup(); }
});

test('verified adapter rejects prohibited subcommands after global options and with versioned canonical binaries before spawning', async () => {
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
        f.spec.bin = join(f.root, `${canonical}${version}`);
        await writeFile(f.spec.bin, '#!/bin/sh\nprintf "launched\\n"\n', { mode: 0o700 });
        const original = f.adapter.build;
        let spawns = 0;
        for (const args of [[command], [globalOption, 'fixture', command], [`${globalOption}=fixture`, command], [globalOption, 'fixture', '--', command]]) {
          f.adapter.build = spec => ({ ...original(spec), argv: [spec.bin, ...args] });
          await assert.rejects(launch(f, { onSpawn: () => { spawns++; } }), { code: 'adapter_refused' });
        }
        assert.equal(f.counts().identityCalls, 1, 'identity was verified and cached before command enforcement');
        assert.equal(spawns, 0);
        await assert.rejects(stat(join(f.spec.runDir, 'stdout.log')), { code: 'ENOENT' });
      } finally { await f.cleanup(); }
    }
  }
});

test('subcommand parsing consumes option values and does not treat prompt material as commands', async () => {
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
  assert.equal(env.USER, 'fixture');
  assert.equal(env.TERM, 'dumb');
  assert.equal(env.NO_COLOR, '1');
  assert(!Object.keys(env).some((name) => /MADDOTS|API_KEY|EVIL/u.test(name)));
  assert(!Object.values(env).some((value) => /^(?:pm_|mdai_)/u.test(value ?? '')));
  assert.equal(env.LANG, undefined);
});

test('fake tool gets stdin and clean env; output logs remain private', async () => {
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

test('config files are constrained to config, are private, and reject symlink traversal', async () => {
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

test('large arg prompts are replaced with the prompt-file instruction', async () => {
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

test('unsupported run-home and secret-env behavior fails closed until TLS-50', async () => {
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

test('stop reason wins over exit-zero output and parse is never called', async () => {
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

test('self-check kills MCP or browser tools before parsing', async () => {
  const f = await fixture('mcp');
  try {
    f.adapter.selfCheck = (stdout) => stdout.includes('maddots-canary') ? { mcpServers: ['maddots-canary'], browserTools: [] } : null;
    const result = await (await launch(f)).finished;
    assert.equal(result.failureCode, 'mcp_started');
    assert.equal(f.counts().parseCalls, 0);
  } finally { await f.cleanup(); }
});

test('recovery refuses stale PID identities without signalling', async () => {
  assert.equal(await recoverProcess(process.pid, 'different', testInspector), false);
  assert.equal(await recoverProcess(process.pid, '', testInspector), false);
  for (const pid of [-1, 0, 1, 1.5]) assert.equal(await recoverProcess(pid, `fixture-${pid}`, testInspector), false);
});

test('deadline removes an escaped grandchild with real ps', {skip: process.platform !== 'darwin' && 'macOS process semantics (TLS-35 adds Linux)'}, async (context) => {
  if (!await processStartIdentity(process.pid)) { context.skip('/bin/ps denied by sandbox; Claude must rerun process-group recovery check'); return; }
  const f = await fixture('grandchild');
  let grandchild = 0;
  const readGrandchild = async () => { try { grandchild ||= (JSON.parse((await readFile(join(f.spec.runDir, 'stdout.log'), 'utf8')).trim()) as { grandchild: number }).grandchild; } catch { /* fixture never started */ } return grandchild; };
  try {
    const result = await (await startTool({ adapter: f.adapter, spec: f.spec, matrix: f.matrix, claimedAt: Date.now(), expiresAt: Date.now() + 7_200_000, maxRunMinutes: 0.02 })).finished;
    assert.equal(result.failureCode, 'run_time_limit');
    assert.ok(await readGrandchild() > 1);
    assert.equal(await processStartIdentity(grandchild), null);
  } finally {
    if (await readGrandchild() > 1 && await processStartIdentity(grandchild)) await killFixture(grandchild);
    await f.cleanup();
  }
});

for (const mode of ['orphan-group-exit', 'orphan-group-stop']) {
  test(`reparented same-group child is gone after ${mode} with real ps`, {skip: process.platform !== 'darwin' && 'macOS process semantics (TLS-35 adds Linux)'}, async context => {
    if (!await processStartIdentity(process.pid)) { context.skip('/bin/ps denied by sandbox; Claude must rerun process-group recovery check'); return; }
    const f = await fixture(mode);
    let grandchild = 0;
    let running: Awaited<ReturnType<typeof startTool>> | undefined;
    const readGrandchild = async () => { try { grandchild ||= JSON.parse((await readFile(join(f.spec.runDir, 'stdout.log'), 'utf8')).trim()).grandchild as number; } catch { /* fixture not ready */ } return grandchild > 1; };
    try {
      running = await launch(f, { processes: undefined });
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

for (const operation of ['normal exit', 'stop', 'recovery']) {
  test(`unknown reparented process-group members are swept on ${operation}`, async () => {
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
        const root = rootPid > 1 && alive(rootPid) ? [{ pid: rootPid, ppid: process.pid, pgid: rootPid }] : [];
        // The intermediate shell has already exited. This process has no ppid
        // link to the tool and was never recorded by a descendant snapshot.
        return grandchildPid > 1 && alive(grandchildPid) ? [...root, { pid: grandchildPid, ppid: 1, pgid: rootPid }] : root;
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

test('process identity and recovery survive parent time-zone and locale changes', {skip: process.platform !== 'darwin' && 'macOS process identity and /bin/ps semantics (TLS-35 adds Linux)'}, async context => {
  if (!await processStartIdentity(process.pid)) { context.skip('/bin/ps denied by sandbox; Claude must rerun identity recovery check'); return; }
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
  test(`TLS21-R1-B: ${mode} is swept by its fence without ancestry`, async () => {
    const f = await fixture(mode), fence = randomBytes(16).toString('hex');
    const pidFile = join(f.root, 'detached.pid');
    let childPid = 0, rootPid = 0;
    const readChild = async () => {
      try { childPid ||= Number(await readFile(pidFile, 'utf8')); } catch { /* not spawned yet */ }
      return childPid > 1;
    };
    const inspector: ProcessInspector = {
      ...testInspector,
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
        const child = spawn(f.spec.bin, [fake, mode, pidFile], {detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: {MDAI_RUN_FENCE: fence}});
        rootPid = child.pid!;
        await new Promise<void>(done => child.stdout.once('data', () => done()));
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
    await promisify(execFile)('/bin/ps', ['-A', '-E', '-ww', '-o', 'pid=,uid=,command='], { maxBuffer: 32 * 1024 * 1024 });
    assert.ok(await processStartIdentity(process.pid));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM' && !/operation not permitted|permission denied/iu.test(String(error))) throw error;
    context.skip('/bin/ps EPERM in sandbox; Claude must rerun real fence regression');
    return false;
  }
}

for (const mode of ['detached-exit', 'recovery-detached-on-term', 'shell-detached-exit']) {
  test(`TLS21-R1-B: ${mode} leaves no descendant with real ps`, {skip: process.platform !== 'darwin' && 'macOS process semantics (TLS-35 adds Linux)'}, async context => {
    if (!await realFenceInspection(context)) return;
    const f = await fixture(mode);
    const pidFile = join(f.root, 'grandchild.pid');
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
        running = await launch(f, { processes: undefined, fence });
        rootPid = running.pid;
        assert.equal((await running.finished).ok, true);
      } else {
        const child = spawn(f.spec.bin, [fake, mode, pidFile], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: { MDAI_RUN_FENCE: fence } });
        rootPid = child.pid ?? 0;
        let ready = false;
        child.stdout.on('data', chunk => { if (String(chunk).includes('ready')) ready = true; });
        await waitUntil(() => ready);
        const identity = await processStartIdentity(rootPid);
        assert.ok(identity);
        assert.equal(await recoverProcess(rootPid, identity, undefined, fence), true);
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

test('TLS21-R1-B: recovery with no leader kills only its exact fence with real ps', {skip: process.platform !== 'darwin' && 'macOS process semantics (TLS-35 adds Linux)'}, async context => {
  if (!await realFenceInspection(context)) return;
  const fence = randomBytes(16).toString('hex');
  const children = [
    { MDAI_RUN_FENCE: fence },
    { MDAI_RUN_FENCE: randomBytes(16).toString('hex') },
    { MDAI_RUN_FENCE: fence + 'f' },
    { OTHER_MDAI_RUN_FENCE: fence },
  ].map(env => spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env }));
  try {
    await Promise.all(children.map(child => new Promise<void>(done => child.stdout.once('data', () => done()))));
    assert.equal(await recoverProcess(0, '', undefined, fence), true);
    assert.equal(alive(children[0].pid!), false);
    for (const child of children.slice(1)) assert.equal(alive(child.pid!), true, 'unrelated same-user fence was untouched');
    // A stale/reused leader also grants no authority over that unrelated process.
    assert.equal(await recoverProcess(children[1].pid!, 'stale-identity', undefined, fence), true);
    assert.equal(alive(children[1].pid!), true);
  } finally {
    for (const child of children) if (child.pid && alive(child.pid)) await killFixture(child.pid);
  }
});

test('output caps independently bound stdout and stderr and bypass parsing', async () => {
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

test('tool-specific forbidden flags are enforced exactly and only for their tool', async () => {
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
      assert.equal((await (await launch(f)).finished).ok, true);
    } finally { await f.cleanup(); }
  }
  const f = await fixture();
  try {
    const original = f.adapter.build;
    f.adapter.build = spec => ({...original(spec), argv: [spec.bin, fake, 'echo', '--agent', '--dump-config']});
    assert.equal((await (await launch(f)).finished).ok, true);
  } finally { await f.cleanup(); }
});

test('matrix claims cannot exceed adapter folder isolation or MCP isolation', async () => {
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

test('an executable changed during identity checking is refused and never cached', async () => {
  const f = await fixture();
  try {
    const bin = join(f.root, 'changing-binary'); await writeFile(bin, 'before', {mode: 0o700});
    f.adapter.identity = async () => { await writeFile(bin, 'changed during identity'); return {ok: true, version: 'fixture'}; };
    assert.equal((await enforceAdapter({...f.spec, adapter: f.adapter, matrix: f.matrix, bin})).code, 'tool_identity');
  } finally { await f.cleanup(); }
});

test('project configs require staging callback instead of a direct project write', async () => {
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

test('unavailable process inspection refuses spawn without running the tool', async () => {
  const f = await fixture();
  try {
    await assert.rejects(launch(f, {processes: {table: async () => { throw Object.assign(new Error('operation denied'), {code: 'EPERM'}); }, identity: async () => null}}), {code: 'adapter_refused'});
    assert.equal(f.counts().parseCalls, 0); await assert.rejects(stat(join(f.spec.runDir, 'stdout.log')), {code: 'ENOENT'});
  } finally { await f.cleanup(); }
});

test('live deadline uses the injected inspector and preserves its reason over tool output', async () => {
  const f = await fixture('sleep');
  try {
    const result = await (await launch(f, {maxRunMinutes: 0.003})).finished;
    assert.equal(result.failureCode, 'run_time_limit'); assert.equal(result.stopped, true); assert.equal(f.counts().parseCalls, 0);
  } finally { await f.cleanup(); }
});

test('browser self-check discovery kills the tool without parsing', async () => {
  const f = await fixture('mcp');
  try {
    f.adapter.selfCheck = stdout => stdout.includes('maddots-canary') ? {mcpServers: [], browserTools: ['browser_open']} : null;
    const result = await (await launch(f)).finished;
    assert.equal(result.failureCode, 'mcp_started'); assert.equal(f.counts().parseCalls, 0);
  } finally { await f.cleanup(); }
});

test('TERM tracks an escaped grandchild before its parent exits with an injected process table', async () => {
  const f = await fixture('grandchild');
  let rootPid = 0, grandchildPid = 0;
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const inspector: ProcessInspector = {
    fencePids: async () => [],
    identity: async pid => { rootPid ||= pid; return alive(pid) ? `fixture-${pid}` : null; },
    table: async () => {
      if (!rootPid) return [];
      const root = alive(rootPid) ? [{pid: rootPid, ppid: process.pid, pgid: rootPid}] : [];
      return grandchildPid && alive(grandchildPid) ? [...root, {pid: grandchildPid, ppid: root.length ? rootPid : 1, pgid: grandchildPid}] : root;
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

test('argv and config token smuggling are refused before any output or staged file is created', async () => {
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

test('argv executable substitution and missing live process identity fail closed', async () => {
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
    await mkdir(join(valid, 'dsh-home'), { recursive: true });
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

test('config paths reject dot traversal before a symlink can redirect the write', async () => {
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
  test(`TLS21-R1-C / Codex N1: exited leader retains ${saved ? 'persisted descendant' : 'original'} group ownership`, async () => {
    const leader = 900001, member = 900002;
    let present = true;
    const signals: NodeJS.Signals[] = [];
    const inspector: ProcessInspector = {
      identity: async () => null,
      table: async () => present ? [{pid: member, ppid: 1, pgid: leader, sid: '900003'}] : [],
      fencePids: async fence => { assert.equal(fence, 'b'.repeat(32)); return present ? [member] : []; },
      signalGroup: (pid, signal) => { assert.equal(pid, leader); signals.push(signal); present = false; },
    };
    assert.equal(await recoverProcess(saved ? 0 : leader, 'original-start', inspector, 'b'.repeat(32), saved ? [{pgid: leader, startedAt: 'original-start', sid: '900003'}] : []), true);
    assert.equal(present, false);
    assert.deepEqual(signals, ['SIGTERM']);
  });
}

test('TLS21-R1-C: persisted group rejects a reused leader or different session', async () => {
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

for (const reuse of ['no session', 'unresolved initial group', 'same session', 'leader identity', 'member identity', 'session leader identity']) {
  test(`TLS21-P1: reused group with ${reuse} is never signalled`, async () => {
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
    assert.equal(await recoverProcess(0, '', inspector, 'd'.repeat(32), [group]), true);
    assert.deepEqual(signals, []);
    assert.ok(table.length, 'unrelated processes remain alive');
    assert.ok(fenceScans > 0, 'unverified groups still require the fence scan');
  });
}

test('TLS21-P1: persisted session leader identity authorizes only its original session', {skip: process.platform !== 'linux' && 'Only Linux exposes a numeric sid; Darwin sess is unavailable'}, async () => {
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
      assert.equal(await recoverProcess(0, '', inspector, 'f'.repeat(32), saved), true);
      assert.deepEqual(signals, reused ? [] : [pgid]);
      assert.equal(present, reused);
    }
  } finally { await f.cleanup(); }
});

for (const proof of ['fence', 'member identity', 'session identity']) {
  test(`TLS21-P1: genuine leaderless group with ${proof} is swept`, {skip: proof === 'session identity' && process.platform !== 'linux' && 'Only Linux exposes a numeric sid; Darwin sess is unavailable'}, async () => {
    const pgid = 900001, member = 900002, session = 900003, fence = 'e'.repeat(32);
    let present = true;
    const signals: NodeJS.Signals[] = [];
    const group = {pgid, startedAt: 'saved-leader', sid: String(session),
      ...(proof === 'member identity' ? {members: [{pid: member, startedAt: 'saved-member'}]} : {}),
      ...(proof === 'session identity' ? {sessionLeader: {pid: session, startedAt: 'saved-session-leader'}} : {})};
    const inspector: ProcessInspector = {
      identity: async () => null,
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

test('TLS21-R1-C: ancestry remembers group/session after its observed leader exits', async () => {
  const f = await fixture('tracked-group-exit');
  const leaderFile = join(f.root, 'leader.pid'), memberFile = join(f.root, 'member.pid');
  let root = 0, leader = 0, member = 0;
  const snapshots: Array<Array<{pgid: number; startedAt: string; sid?: string}>> = [];
  const read = async () => {
    try { leader ||= Number(await readFile(leaderFile, 'utf8')); } catch { /* not ready */ }
    try { member ||= Number(await readFile(memberFile, 'utf8')); } catch { /* not ready */ }
  };
  const inspector: ProcessInspector = {
    ...testInspector,
    table: async () => {
      await read();
      return [
        ...(root && alive(root) ? [{pid: root, ppid: process.pid, pgid: root, sid: String(root)}] : []),
        ...(leader && alive(leader) ? [{pid: leader, ppid: root, pgid: leader, sid: String(leader)}] : []),
        ...(member && alive(member) ? [{pid: member, ppid: 1, pgid: leader, sid: String(leader)}] : []),
      ];
    },
    signalGroup: (pgid, signal) => {
      for (const pid of pgid === root ? [root] : [leader, member]) if (pid && alive(pid)) process.kill(pid, signal);
    },
  };
  try {
    const original = f.adapter.build;
    f.adapter.build = spec => ({...original(spec), argv: [spec.bin, fake, 'tracked-group-exit', leaderFile, memberFile]});
    const running = await launch(f, {processes: inspector, onSpawn: pid => { root = pid; }, onGroups: groups => { snapshots.push(structuredClone(groups)); }});
    assert.equal((await running.finished).ok, true);
    await read();
    assert.ok(snapshots.some(groups => groups.some(group => group.pgid === root && group.sid === (process.platform === 'linux' ? String(root) : undefined))), 'the root group and any available session are persisted');
    assert.ok(snapshots.some(groups => groups.some(group => group.pgid === leader && group.sid === (process.platform === 'linux' ? String(leader) : undefined))));
    assert.ok(member > 1);
    assert.equal(alive(member), false, 'unseen orphan from observed group is swept');
  } finally {
    await read();
    for (const pid of [root, leader, member]) if (pid && alive(pid)) await killFixture(pid);
    await f.cleanup();
  }
});

test('R2-NEW-TLS21-FIX-C2: transient null identity keeps a listed descendant tracked', async () => {
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
        ...(root && alive(root) ? [{pid: root, ppid: process.pid, pgid: root}] : []),
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
  test(`R2-NEW-TLS21-FIX-C2: ${total} sleep children in batches of ${batch} finish normally with real ps`, {skip: process.platform !== 'darwin' && 'macOS process semantics (TLS-35 adds Linux)'}, async context => {
    if (!await realFenceInspection(context)) return;
    const f = await fixture('sleep-batches');
    try {
      const original = f.adapter.build;
      f.adapter.build = spec => ({...original(spec), argv: [spec.bin, fake, 'sleep-batches', String(total), String(batch), String(seconds)]});
      const began = Date.now();
      assert.equal((await (await launch(f, {processes: undefined})).finished).ok, true);
      if (total === 20) assert.ok(Date.now() - began < 2000, 'empty normal exit has no 5-second TERM grace');
    } finally { await f.cleanup(); }
  });
}

for (const deadline of [false, true]) {
  test(`R2-NEW-SEC-TLS21-FENCE-PLATFORM-BINARIES: inherited pipes settle after ${deadline ? 'deadline' : 'exit cleanup'}`, async () => {
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
  test(`TLS21-R1-C: Apple sleep setsid accepted escape limit on ${mode} with real ps`, {skip: process.platform !== 'darwin' && 'macOS Apple binary visibility semantics (TLS-35 adds Linux)'}, async context => {
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
        await new Promise<void>(done => child.stdout.once('data', () => done()));
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

test('R2-NEW-SEC-TLS21-FENCE-PLATFORM-BINARIES: detached Apple shell inherited pipes settle with real ps', {skip: process.platform !== 'darwin' && 'macOS Apple binary visibility and process semantics (TLS-35 adds Linux)'}, async context => {
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

test('R2-NEW-TLS21-FIX-C2: dead tracked entries are pruned before normal exit grace', async () => {
  const f = await fixture('sleep-batches');
  let root = 0, observed = false;
  const inspector: ProcessInspector = {
    fencePids: async () => [],
    table: async () => root && alive(root) ? [{pid: root, ppid: process.pid, pgid: root}, {pid: 900003, ppid: root, pgid: root}] : [],
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

test('Codex N1: recovery sweeps the original group after the leader exited with real ps', {skip: process.platform !== 'darwin' && 'macOS process semantics (TLS-35 adds Linux)'}, async context => {
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
    assert.equal(await recoverProcess(root, identity, undefined, 'e'.repeat(32), [{pgid: root, startedAt: identity, members: [{pid: orphan, startedAt: orphanStart}]}]), true);
    assert.equal(alive(orphan), false, 'environment-cleared original-group child must be gone');
  } finally {
    for (const pid of [root, orphan]) if (pid && alive(pid)) await killFixture(pid);
    await f.cleanup();
  }
});

test('TLS21-R1-C: fast exit during initial identity lookup retains the original group', async () => {
  const f = await fixture('orphan-group-exit'), pidFile = join(f.root, 'orphan.pid');
  let root = 0, orphan = 0, savedPgid = 0;
  const readOrphan = async () => {
    try { orphan ||= Number(await readFile(pidFile, 'utf8')); } catch { /* not ready */ }
  };
  const inspector: ProcessInspector = {
    fencePids: async () => [],
    identity: async pid => {
      root ||= pid;
      if (pid === root) { await waitUntil(() => !alive(root), 4000); return null; }
      return alive(pid) ? `fixture-${pid}` : null;
    },
    table: async () => {
      await readOrphan();
      return [
        ...(root && alive(root) ? [{pid: root, ppid: process.pid, pgid: root}] : []),
        ...(orphan && alive(orphan) ? [{pid: orphan, ppid: 1, pgid: root}] : []),
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

test('TLS21-R1-C: deadline during initial identity lookup stops the owned live child', async () => {
  const f = await fixture('sleep');
  let root = 0, initial = true, persistedBeforeIdentity = false;
  const inspector: ProcessInspector = {
    fencePids: async () => [],
    table: async () => root && alive(root) ? [{pid: root, ppid: process.pid, pgid: root}] : [],
    identity: async pid => {
      root ||= pid;
      if (initial) { assert.equal(persistedBeforeIdentity, true, 'group is durable before waiting for identity'); initial = false; await delay(900); }
      return alive(pid) ? `fixture-${pid}` : null;
    },
  };
  try {
    const running = await launch(f, {processes: inspector, maxRunMinutes: 0.005, onGroups: groups => { if (groups.some(group => group.pgid > 1 && !group.startedAt)) persistedBeforeIdentity = true; }});
    const result = await settledWithin(running.finished, 2500);
    assert.equal(result.failureCode, 'run_time_limit');
    assert.equal(alive(root), false, 'unreaped direct child authority survives missing initial identity');
  } finally {
    if (root && alive(root)) await killFixture(root);
    await f.cleanup();
  }
});

test('TLS21-R1-C: persisted group with unknown live-leader identity cannot report verified cleanup', async () => {
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
  test(`TLS21-R5: saved unusable sid ${JSON.stringify(sid)} never authorizes an unrelated leaderless group`, async () => {
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

test('TLS21-R5: ancestry never persists Darwin sess zero as session evidence', async () => {
  const f = await fixture('grandchild');
  let root = 0, child = 0;
  const groups: import('../src/runner/process.js').ProcessGroup[][] = [];
  const inspector: ProcessInspector = {
    ...testInspector,
    table: async () => {
      try { child ||= JSON.parse((await readFile(join(f.spec.runDir, 'stdout.log'), 'utf8')).trim()).grandchild; } catch { /* not yet started */ }
      return [
        ...(root && alive(root) ? [{pid: root, ppid: process.pid, pgid: root, sid: '0'}] : []),
        ...(child && alive(child) ? [{pid: child, ppid: root, pgid: child, sid: '0'}] : []),
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
    for (const pid of [root, child]) if (pid && alive(pid)) await killFixture(pid);
    await f.cleanup();
  }
});

for (const variant of ['later second', 'same second', 'earlier second', 'unreadable start', 'missing bound']) {
  test(`R4-NEW-NP2: unresolved spawn-window group with ${variant} keeps only justified uncertainty`, async () => {
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

test('R4-NEW-NP2: spawn timestamp is persisted before identity lookup and survives identity resolution', async () => {
  const f = await fixture();
  const before = Date.now();
  let savedBeforeIdentity = false;
  const groups: import('../src/runner/process.js').ProcessGroup[][] = [];
  const inspector: ProcessInspector = {
    ...testInspector,
    identity: async pid => {
      savedBeforeIdentity ||= groups[0]?.some(group => group.pgid === pid && group.startedAt === '' && Number.isSafeInteger(group.spawnedBy)) ?? false;
      return testInspector.identity(pid);
    },
  };
  try {
    const running = await launch(f, {processes: inspector, onGroups: values => { groups.push(structuredClone(values)); }});
    assert.equal((await running.finished).ok, true);
    assert.equal(savedBeforeIdentity, true);
    const initial = groups[0].find(group => group.pgid === running.pid)!;
    assert.ok(initial.spawnedBy! >= before && initial.spawnedBy! <= Date.now());
    assert.ok(groups.some(values => values.some(group => group.pgid === running.pid && group.startedAt === running.startedAt && group.spawnedBy === initial.spawnedBy)));
  } finally { await f.cleanup(); }
});

test('TLS21-R5: verified live-root recovery sweeps a late same-group child without fence evidence', async () => {
  const root = 900030, member = 900031;
  let rootAlive = true, memberAlive = false;
  const signals: NodeJS.Signals[] = [];
  const inspector: ProcessInspector = {
    identity: async pid => pid === root && rootAlive ? 'root-start' : null,
    table: async () => [
      ...(rootAlive ? [{pid: root, ppid: 1, pgid: root, startedAt: 'root-start'}] : []),
      ...(memberAlive ? [{pid: member, ppid: 1, pgid: root, startedAt: 'late-member-start'}] : []),
    ],
    fencePids: async () => [],
    signalGroup: (pgid, signal) => {
      assert.equal(pgid, root); signals.push(signal);
      if (signal === 'SIGTERM') { rootAlive = false; memberAlive = true; }
      if (signal === 'SIGKILL') memberAlive = false;
    },
  };
  assert.equal(await recoverProcess(root, 'root-start', inspector, 'c'.repeat(32), [{pgid: root, startedAt: 'root-start'}]), true);
  assert.equal(rootAlive, false); assert.equal(memberAlive, false);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('R5-NEW-SEC-TLS21-R5-NEW-LIVE-REUSE-GUARDS-UNTESTED: a reused root pid never authorizes its unrelated group', async () => {
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

test('R5-NEW-SEC-TLS21-R5-NEW-LIVE-REUSE-GUARDS-UNTESTED: an inspection outage expires live group authority before pgid reuse', async () => {
  const f = await fixture('sleep');
  const group = 900050, unrelated = 900051;
  let root = 0, outageScans = 0;
  let phase: 'observe' | 'outage' | 'reused' = 'observe';
  const snapshots: import('../src/runner/process.js').ProcessGroup[][] = [];
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
    await delay(5600);
    assert.ok(outageScans > 0, 'inspection remains unavailable beyond the live ownership freshness bound');
    assert.equal(alive(root), true);
    process.kill(root, 'SIGKILL');
    phase = 'reused';
    assert.equal((await running.finished).failureCode, 'tool_failed');
    assert.ok(signals.every(value => value.pgid !== group), 'an expired observation cannot authorize the reused leaderless group');
  } finally {
    phase = 'reused';
    if (root && alive(root)) await killFixture(root);
    if (running) await running.finished.catch(() => undefined);
    await f.cleanup();
  }
});
