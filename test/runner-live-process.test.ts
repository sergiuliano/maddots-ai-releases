import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, {type TestContext} from 'node:test';
import { promisify } from 'node:util';
import { TOOL_MATRIX } from '../src/shared/tool-matrix.js';
import type { Adapter, RunSpec } from '../src/runner/adapter.js';
import { ProcessCleanupError, processStartIdentity, recoverProcess, startTool, type ProcessGroup, type ProcessInspector, type RunningTool } from '../src/runner/process.js';
import { nativeFixtureProcesses, requireNativeFixtureInspection } from './native-process-fixture.js';

import { linuxProcessTable } from '../src/linux-proc.js';
import {LINUX_CONTAINMENT_PATHS} from '../src/runner/linux-containment.js';
import {initializeCleanRunnerJournal} from './support/runner-journal-fixture.js';
import {cleanupNativeFixtureRoot, linuxNativeFixtureTimeout, linuxNativeWorkloadSkip, observeNativeLinuxWorkloads, startNativeFixtureTool, waitForNativeFixtureState} from './support/linux-native-workloads.js';
import {CODEX_FIXTURE_PROVIDER} from './support/codex-local-provider-fixture.js';

const exec = promisify(execFile);
const liveOptions = {timeout: linuxNativeFixtureTimeout(20_000), skip: process.platform === 'linux' ? linuxNativeWorkloadSkip :
  process.platform !== 'darwin' && 'POSIX process groups required'};
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
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

async function waitUntil(check: () => Promise<boolean> | boolean, timeout = 4000): Promise<void> {
  const until = Date.now() + timeout;
  while (!await check()) {
    assert(Date.now() < until, 'real process fixture did not reach its expected state');
    await delay(20);
  }
}

async function realPs(context: { skip(reason: string): void }): Promise<boolean> {
  try {
    if (process.platform === 'linux') await requireNativeFixtureInspection();
    else await exec('/bin/ps', ['-A', '-E', '-ww', '-o', 'pid=,uid=,command='], { maxBuffer: 32 * 1024 * 1024 });
    assert(await processStartIdentity(process.pid));
    return true;
  } catch (error) {
    if (process.platform === 'linux') throw error;
    if ((error as NodeJS.ErrnoException).code !== 'EPERM' && !/operation not permitted|permission denied/iu.test(String(error))) throw error;
    context.skip('/bin/ps EPERM in sandbox; rerun TLS21-R5 real process regressions outside the sandbox');
    return false;
  }
}

/** Legacy Linux rows remain migration evidence even when native observations
 * happen to match. Only journal-backed registered containment can retire them. */
async function refuseLegacyLinuxRecovery(context: TestContext, inspector: ProcessInspector, pid: number,
  startedAt: string, fence: string | undefined, groups: ProcessGroup[], file: string): Promise<void> {
  const durable = await readFile(file, 'utf8'), saved = structuredClone(groups);
  const snapshots: ProcessGroup[][] = [];
  let reads = 0;
  const read = <T>(action: () => T): T => {reads++; return action();};
  const observing: ProcessInspector = {...inspector,
    identity: value => read(() => inspector.identity(value)),
    table: () => read(() => inspector.table()),
    ...(inspector.inspect ? {inspect: (value: number, token?: string) => read(() => inspector.inspect!(value, token))} : {}),
    ...(inspector.inspectSync ? {inspectSync: (value: number, deadline?: number) => read(() => inspector.inspectSync!(value, deadline))} : {}),
    ...(inspector.fencePids ? {fencePids: (token: string, deadline?: number) => read(() => inspector.fencePids!(token, deadline))} : {}),
    ...(inspector.fenceEntries ? {fenceEntries: (token: string, deadline?: number) => read(() => inspector.fenceEntries!(token, deadline))} : {}),
  };
  const signals = context.mock.method(process, 'kill');
  try {
    await assert.rejects(recoverProcess(pid, startedAt, observing, fence, groups, async value => {
      snapshots.push(structuredClone(value)); await writeFile(file, JSON.stringify(value));
    }), error => error instanceof ProcessCleanupError && error.code === 'tool_failed');
    assert.equal(signals.mock.callCount(), 0, 'legacy metadata cannot authorize even one native signal');
    assert.equal(reads, 0, 'native process observations cannot become Linux recovery authority');
    assert.deepEqual(snapshots, [], 'refused legacy recovery cannot publish ownership or retirement');
    assert.deepEqual(groups, saved, 'caller migration evidence remains unchanged');
    assert.equal(await readFile(file, 'utf8'), durable, 'durable migration evidence remains unchanged');
  } finally {signals.mock.restore();}
}

// Fixtures use real process tables, including when a test injects a scan outage.
// Synthetic fence or process rows must not make a child identifiable.
async function fixture(mode: string, before = 0, after = 0, context?: TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-live-ps-'));
  const native = process.platform === 'linux' && !!context;
  const data = native ? await mkdtemp(join(await realpath(tmpdir()), 'mdai-live-ps-data-')) : undefined;
  if (data) await initializeCleanRunnerJournal(data);
  const empty: boolean[] = [], proofs: unknown[] = [];
  const observer = native ? observeNativeLinuxWorkloads(context!, {
    empty: (_run, value) => {empty.push(value);}, proof: (_run, proof) => {proofs.push(proof);},
  }) : undefined;
  const runDir = join(root, '.maddots', 'runs', 'fixture');
  await mkdir(runDir, { recursive: true });
  const bin = await realpath(process.execPath);
  const script = join(root, 'tool.mjs');
  const pidFile = join(root, 'orphan.pid');
  const rootFile = join(root, 'root.pid');
  const readyFile = join(root, 'ready');
  const signalFile = join(root, 'orphan-signalled');
  await writeFile(script, `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const [mode, pidFile, rootFile, readyFile, before, after, signalFile] = process.argv.slice(2);
writeFileSync(rootFile, String(process.pid));
const finish = () => Number(after) ? setTimeout(() => process.exit(0), Number(after)) : process.exit(0);
function orphan() {
  if (mode.startsWith('shell') || mode === 'term') {
    const shell = spawn('/bin/sh', ['-c', '(trap "" TERM; exec /bin/sleep 120) </dev/null >/dev/null 2>&1 & echo $! > "$1"', 'fixture', pidFile], { stdio: 'ignore' });
    shell.on('exit', finish);
    return;
  }
  const node = mode === 'node-empty' || mode === 'detached' || mode === 'fenced';
  const command = node ? process.execPath : mode === 'loop' ? '/bin/sh' : '/bin/sleep';
  const args = node ? ['-e', 'const {writeFileSync} = require("node:fs"); const signalFile = ' + JSON.stringify(signalFile) + '; process.on("SIGTERM", () => writeFileSync(signalFile, "TERM")); writeFileSync(signalFile + ".ready", "ready"); setInterval(() => {}, 1000)'] : mode === 'loop' ? ['-c', 'trap "" TERM; while :; do /bin/sleep 120; done'] : ['120'];
  const child = spawn(command, args, { stdio: 'ignore', detached: mode === 'detached', ...(mode === 'node-empty' || mode === 'detached' ? { env: {} } : {}) });
  child.unref();
  writeFileSync(pidFile, String(child.pid));
  if (mode !== 'detached') finish();
}
if (mode === 'term') process.on('SIGTERM', orphan);
else if (mode !== 'hold') Number(before) ? setTimeout(orphan, Number(before)) : orphan();
writeFileSync(readyFile, 'ready');
if (['term', 'hold', 'detached'].includes(mode)) setInterval(() => {}, 1000);
`);
  const promptFile = join(runDir, 'prompt.md');
  await writeFile(promptFile, 'Real process regression');
  const args = [script, mode, pidFile, rootFile, readyFile, String(before), String(after), signalFile];
  const adapter: Adapter = {
    info: { tool: 'codex', harness: 'codex', card: 'TLS-26', folderOnly: 'os-sandbox', mcpLevel: 'servers-off', skillsDir: '{runDir}/skills', promptVia: 'stdin', runHome: false },
    identity: async () => ({ ok: true, version: '1.0.0' }),
    supports: () => ({ ok: true, reason: null }),
    build: spec => ({ argv: [spec.bin, ...args], env: {}, envUnset: [], stdinFile: spec.promptFile, files: [], projectFiles: [], spawnCwd: null, secretEnv: {} }),
    parse: result => ({ ok: result.exitCode === 0, text: '', failureCode: result.exitCode === 0 ? null : 'tool_failed' }),
  };
  const spec: RunSpec = { bin, cwd: root, runDir, promptFile, model: 'fixture', provider: CODEX_FIXTURE_PROVIDER, effort: null,
    access: process.platform === 'linux' ? 'full_access' : 'folder_only', skillsDir: join(runDir, 'skills'), maxTurns: 50, timeoutSeconds: 0, runHome: null };
  const matrix = structuredClone(TOOL_MATRIX);
  matrix.tools.find(tool => tool.key === 'codex')!.run = { adapter: 'codex', card: 'TLS-26', offered: true, platforms: {darwin: {accepted: true}, linux: {accepted: true}}, folderOnly: 'os-sandbox', mcpLevel: 'servers-off', reason: null, checkedAt: '2026-10-14' };
  const snapshots: ProcessGroup[][] = [];
  const toolRoots: {pid: number; startedAt: string}[] = [];
  let running: RunningTool | undefined;
  let direct: ChildProcess | undefined;
  const readFixture = async (file: string) => {
    const run = observer?.latest();
    if (run) {
      const live = join(LINUX_CONTAINMENT_PATHS.runs, run.registration.name.slice(4), 'work', file.slice(root.length + 1));
      try {return await readFile(live, 'utf8');}
      catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
    }
    return readFile(file, 'utf8');
  };
  const readPid = async (file: string) => Number(await readFixture(file).catch(() => '0'));
  const ready = (check: () => boolean | Promise<boolean>, label: string) => waitForNativeFixtureState(check,
    {label, finished: running?.finished, timeout: 4000, interval: 20});
  const nativeProcesses = nativeFixtureProcesses(async () => [running?.pid ?? 0, direct?.pid ?? 0,
    await readPid(rootFile), await readPid(pidFile)]);
  return {
    snapshots, toolRoots, nativeProcesses, groupsFile: join(root, 'saved-groups.json'),
    async launch(maxRunMinutes = 1, processes: ProcessInspector | undefined = nativeProcesses) {
      const start = data ? (options: Parameters<typeof startTool>[0]) => startNativeFixtureTool(data, options) : startTool;
      running = await start({ adapter, spec, matrix, claimedAt: Date.now(), expiresAt: Date.now() + 7_200_000, maxRunMinutes,
        processes, onGroups: groups => { snapshots.push(structuredClone(groups)); },
        onSpawn: (_pid, _startedAt, _pgid, toolRoot) => {if (toolRoot) toolRoots.push({...toolRoot});} });
      return running;
    },
    async direct(fence?: string, options: {guardian?: boolean} = {}) {
      const guardian = `import {spawn} from 'node:child_process';
        process.on('SIGTERM', () => {});
        const tool = spawn(process.argv[1], process.argv.slice(2), {stdio: 'ignore'});
        tool.on('error', () => process.exit(1));
        setInterval(() => {}, 1000);`;
      const argv = options.guardian ? ['--input-type=module', '-e', guardian, bin, ...args] : args;
      direct = spawn(bin, argv, { detached: true, stdio: 'ignore', env: fence ? { MDAI_RUN_FENCE: fence } : {} });
      direct.unref();
      await waitUntil(async () => (await readPid(rootFile)) > 1);
      assert(direct.pid);
      return direct.pid;
    },
    async orphan() {
      await ready(async () => (await readPid(pidFile)) > 1, 'real process fixture orphan readiness');
      return readPid(pidFile);
    },
    async toolRoot() {
      await ready(async () => (await readPid(rootFile)) > 1, 'real process fixture tool root readiness');
      return readPid(rootFile);
    },
    async ready() { await ready(async () => (await readFixture(readyFile).catch(() => '')) === 'ready', 'real process fixture readiness'); },
    async orphanReady() { await waitUntil(async () => (await readFile(`${signalFile}.ready`, 'utf8').catch(() => '')) === 'ready'); },
    async wasSignalled() { return (await readFile(signalFile, 'utf8').catch(() => '')) !== ''; },
    assertNativeClean() {
      assert(native, 'retained containment proof is a native Linux fixture assertion');
      assert(empty.includes(true), 'finished requires a real registered empty observation');
      assert.equal(proofs.length, 1, 'only the original retained backend can produce the retirement proof');
      assert.deepEqual(snapshots, [], 'Linux never persists PID observations as cleanup authority');
    },
    async cleanup() {
      if (native) {
        await cleanupNativeFixtureRoot(context!, root, data!, async () => {
          if (running) {await running.stop('fixture_teardown'); await running.finished;}
          await observer!.cleanup();
        });
        await rm(data!, {recursive: true, force: true});
        return;
      }
      // Kill the supervised group first so the tool cannot create another
      // orphan, including when Linux retains a separate session guardian.
      const rootPid = await readPid(rootFile) || running?.pid || direct?.pid || 0;
      const orphanPid = await readPid(pidFile);
      const candidates = new Set([running?.pid ?? 0, direct?.pid ?? 0, rootPid, orphanPid]);
      for (const pid of candidates) if (pid > 1) {
        for (const target of [-pid, pid]) try { process.kill(target, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
      if (running) await running.finished.catch(() => undefined);
      for (const pid of candidates) if (pid > 1) await waitUntil(() => !alive(pid));
      await rm(root, { recursive: true, force: true });
    },
  };
}

test(process.platform === 'linux' ? 'S3 Linux startTool cleans a late child through retained containment without process-table access' :
  'TLS21-R5: startTool rootVerified sweeps a late same-group orphan after a full live scan outage with real ps', liveOptions, async context => {
  if (process.platform !== 'linux' && !await realPs(context)) return;
  // No detach or environment change: this sleep inherits the root's group.
  // On Darwin, 5600 ms also expires the historical liveGroups authority.
  const f = await fixture('sleep', 5600, 0, context);
  let root = 0;
  let tableCalls = 0;
  let blockedScans = 0;
  const processes: ProcessInspector = {
    sessionGuardian: true,
    identity: processStartIdentity,
    fencePids: async () => [],
    table: async () => {
      // Only the pre-spawn capability check may succeed while the root lives.
      // Also reject before startTool returns its PID, so a slow identity lookup
      // cannot accidentally permit a successful interval scan.
      if (++tableCalls > 1 && (!root || alive(root))) {
        blockedScans++;
        throw new Error('injected process-table outage while the root is alive');
      }
      if (process.platform === 'linux') return (await linuxProcessTable()).filter(row => !row.zombie);
      const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], {
        env: { TZ: 'UTC0', LC_ALL: 'C' }, timeout: 2000, maxBuffer: 8 * 1024 * 1024,
      });
      return stdout.split('\n').flatMap(line => {
        const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
        return row ? [{ pid: Number(row[1]), ppid: Number(row[2]), pgid: Number(row[3]), startedAt: row[4] }] : [];
      });
    },
  };
  try {
    const running = await f.launch(1, processes);
    // Keep the Darwin scan outage across the actual tool's complete life.
    // Linux does not consult this process-table seam at all.
    root = await f.toolRoot();
    if (process.platform === 'linux') {
      assert.equal(running.startedAt, 'linux-contained', 'the public PID is diagnostic only');
      assert.deepEqual(f.toolRoots, [], 'namespaced process IDs are not host ownership witnesses');
    }
    assert.equal((await running.finished).ok, true);
    if (process.platform === 'linux') {
      assert.equal(tableCalls, 0, 'contained cleanup must succeed independently of host process table access');
      assert(await f.orphan() > 1, 'the late child was actually created inside the namespace');
      f.assertNativeClean();
    } else {
      assert(blockedScans > 0, 'the live root must experience the injected scan outage');
      assert.equal(alive(await f.orphan()), false, 'authenticated ownership must sweep the orphan after liveGroups authority expires');
    }
  } finally { await f.cleanup(); }
});

for (const [label, mode, before, after] of [
  ['immediate /bin/sleep', 'sleep', 0, 0],
  ['immediate environment-cleared node', 'node-empty', 0, 0],
  ['/bin/sleep spawned after 1 s of prior scans', 'sleep', 1000, 0],
  ['TERM-ignoring shell sleep, immediate exit', 'shell', 0, 0],
  ['TERM-ignoring shell sleep, exit after 150 ms', 'shell', 0, 150],
  ['TERM-ignoring shell sleep after 1 s of prior scans', 'shell', 1000, 0],
  ['non-detached shell loop', 'loop', 0, 0],
] as const) {
  test(`TLS21-R5: ${label} is gone when finished resolves with ${process.platform === 'linux' ? 'retained containment' : 'real ps'}`, liveOptions, async context => {
    if (process.platform !== 'linux' && !await realPs(context)) return;
    const f = await fixture(mode, before, after, context);
    try {
      const running = await f.launch();
      const result = await running.finished;
      const orphan = await f.orphan();
      assert.equal(result.ok, true);
      if (process.platform === 'linux') {
        assert(orphan > 1, 'the child was actually created inside the namespace');
        f.assertNativeClean();
      } else {
        assert.equal(alive(orphan), false, 'same-group orphan must be dead before reporting success');
        assert(f.snapshots.some(groups => groups.some(group => group.pgid === running.pid && group.members?.some(member => member.pid === orphan && member.startedAt))), 'persist positive member evidence before signalling a newly observed orphan');
      }
    } finally { await f.cleanup(); }
  });
}

for (const action of ['stop', 'deadline'] as const) {
  test(`TLS21-R5: ${action} sweeps the same-group orphan created by a TERM handler with ${process.platform === 'linux' ? 'retained containment' : 'real ps'}`, liveOptions, async context => {
    if (process.platform !== 'linux' && !await realPs(context)) return;
    const f = await fixture('term', 0, 0, context);
    try {
      const running = await f.launch(action === 'deadline' ? process.platform === 'linux' ? 0.5 : 0.04 : 1);
      await f.ready();
      if (action === 'stop') await running.stop('heartbeat_stop');
      const result = await running.finished;
      assert.equal(result.failureCode, action === 'stop' ? 'heartbeat_stop' : 'run_time_limit');
      if (process.platform === 'linux') {
        assert(await f.orphan() > 1, 'the TERM handler actually created its late child');
        f.assertNativeClean();
      } else assert.equal(alive(await f.orphan()), false, 'TERM handler orphan survives neither stop nor deadline');
    } finally { await f.cleanup(); }
  });
}

test(process.platform === 'linux' ? 'S3 Linux legacy recovery refuses a real retained guardian and its late TERM-handler orphan' :
  'TLS21-R5: recovery of a persisted retained guardian sweeps its tool TERM-handler orphan with real ps', { timeout: 20_000, skip: !['darwin', 'linux'].includes(process.platform) && 'POSIX process groups required' }, async context => {
  if (!await realPs(context)) return;
  const f = await fixture('term');
  try {
    const fence = randomBytes(16).toString('hex');
    const root = await f.direct(fence, {guardian: true});
    await f.ready();
    assert.notEqual(await f.toolRoot(), root, 'the tool can exit without ending its same-group guardian');
    const startedAt = await processStartIdentity(root);
    assert(startedAt);
    await writeFile(f.groupsFile, JSON.stringify([{ pgid: root, startedAt }]));
    const persisted = JSON.parse(await readFile(f.groupsFile, 'utf8')) as ProcessGroup[];
    if (process.platform === 'linux') {
      await refuseLegacyLinuxRecovery(context, f.nativeProcesses!, root, startedAt, fence, persisted, f.groupsFile);
      assert.equal(alive(root), true, 'matching guardian metadata cannot authorize Linux cleanup');
      // Only the test fixture sends TERM, creating the same real late child
      // that old process-table recovery once tried to sweep.
      process.kill(-root, 'SIGTERM');
      const orphan = await f.orphan();
      assert.equal(alive(orphan), true);
      await refuseLegacyLinuxRecovery(context, f.nativeProcesses!, root, startedAt, fence, persisted, f.groupsFile);
      assert.equal(alive(root), true);
      assert.equal(alive(orphan), true, 'a real new descendant cannot become legacy cleanup authority');
      return;
    }
    const snapshots: ProcessGroup[][] = [];
    assert.equal(await recoverProcess(root, startedAt, f.nativeProcesses, fence, persisted, async groups => {
      await writeFile(f.groupsFile, JSON.stringify(groups));
      snapshots.push(structuredClone(groups));
    }), true);
    assert.equal(alive(root), false);
    const orphan = await f.orphan();
    assert(snapshots.some(groups => groups.some(group => group.pgid === root && group.members?.some(member => member.pid === orphan && member.startedAt))),
      'the retained guardian authenticates the child lifetime before the group is killed');
    assert.equal(alive(orphan), false);
  } finally { await f.cleanup(); }
});

test('TLS21-R5: Darwin onGroups never persists sid or root sessionLeader for a detached child with real ps', { timeout: 20_000, skip: process.platform !== 'darwin' && 'macOS process semantics: Darwin sess=0 regression (TLS-35 adds Linux)' }, async context => {
  if (!await realPs(context)) return;
  const f = await fixture('detached');
  try {
    const running = await f.launch();
    const child = await f.orphan();
    await waitUntil(() => f.snapshots.some(groups => groups.some(group => group.pgid === child && group.members?.some(member => member.pid === child))));
    for (const groups of f.snapshots) for (const group of groups) {
      assert.equal(group.sid, undefined, 'Darwin sess is unavailable, including for detached sessions');
      assert.equal(group.sessionLeader, undefined, 'the tool root cannot prove a detached child session');
    }
    await running.stop('heartbeat_stop');
    await running.finished;
    assert.equal(alive(child), false);
  } finally { await f.cleanup(); }
});

test('TLS21-R5: Darwin stale sid=0 and live root do not authorize an unrelated leaderless group with real ps', { timeout: 20_000, skip: process.platform !== 'darwin' && 'macOS process semantics: Darwin sess=0 regression (TLS-35 adds Linux)' }, async context => {
  if (!await realPs(context)) return;
  const rootFixture = await fixture('hold');
  const unrelatedFixture = await fixture('node-empty');
  try {
    const root = await rootFixture.direct();
    await rootFixture.ready();
    const unrelatedGroup = await unrelatedFixture.direct();
    const unrelatedMember = await unrelatedFixture.orphan();
    await unrelatedFixture.orphanReady();
    await waitUntil(() => !alive(unrelatedGroup));
    const startedAt = await processStartIdentity(root);
    assert(startedAt);
    const { stdout } = await exec('/bin/ps', ['-p', String(unrelatedMember), '-o', 'pgid=,sess=']);
    assert.deepEqual(stdout.trim().split(/\s+/u), [String(unrelatedGroup), '0']);
    const rootGroup: ProcessGroup = { pgid: root, startedAt, sid: '0', sessionLeader: { pid: root, startedAt } };
    const staleGroup: ProcessGroup = { pgid: unrelatedGroup, startedAt: 'previous leader', sid: '0', members: [{ pid: unrelatedMember, startedAt: 'previous member' }], sessionLeader: { pid: root, startedAt } };
    assert.equal(await recoverProcess(root, startedAt, undefined, randomBytes(16).toString('hex'), [rootGroup, staleGroup]), true);
    assert.equal(alive(root), false);
    assert.equal(alive(unrelatedMember), true, 'persisted sess=0 must not turn a live root into authority over an unrelated group');
    assert.equal(await unrelatedFixture.wasSignalled(), false, 'the unrelated group must never receive even SIGTERM');
  } finally {
    const cleanups = await Promise.allSettled([rootFixture.cleanup(), unrelatedFixture.cleanup()]);
    assert.deepEqual(cleanups.filter(cleanup => cleanup.status === 'rejected'), [], 'all real process fixtures must be cleaned');
  }
});

for (const evidence of ['member', 'fence'] as const) {
  test(process.platform === 'linux' ? `S3 Linux legacy recovery refuses a real leaderless group with exact ${evidence} evidence` :
    `TLS21-P1: real leaderless group remains recoverable through its exact ${evidence}`, { timeout: 20_000, skip: !['darwin', 'linux'].includes(process.platform) && 'POSIX process groups required' }, async context => {
    if (!await realPs(context)) return;
    const f = await fixture(evidence === 'member' ? 'node-empty' : 'fenced');
    try {
      const fence = randomBytes(16).toString('hex');
      const group = await f.direct(fence);
      const member = await f.orphan();
      await waitUntil(() => !alive(group));
      const startedAt = await processStartIdentity(member);
      assert(startedAt);
      const saved: ProcessGroup = { pgid: group, startedAt: 'departed leader', ...(evidence === 'member' ? { members: [{ pid: member, startedAt }] } : {}) };
      if (process.platform === 'linux') {
        await f.orphanReady();
        await writeFile(f.groupsFile, JSON.stringify([saved]));
        const persisted = JSON.parse(await readFile(f.groupsFile, 'utf8')) as ProcessGroup[];
        await refuseLegacyLinuxRecovery(context, f.nativeProcesses!, 0, '', evidence === 'fence' ? fence : undefined, persisted, f.groupsFile);
        assert.equal(alive(member), true);
        assert.equal(await f.wasSignalled(), false, 'the exact real member must never receive even SIGTERM');
        // Actual fixture exit is still insufficient to retire the historical
        // obligation without registered containment and its sealed-empty proof.
        process.kill(member, 'SIGKILL');
        await waitUntil(() => !alive(member));
        await refuseLegacyLinuxRecovery(context, f.nativeProcesses!, 0, '', evidence === 'fence' ? fence : undefined, persisted, f.groupsFile);
        return;
      }
      assert.equal(await recoverProcess(0, '', f.nativeProcesses, evidence === 'fence' ? fence : undefined, [saved]), true);
      assert.equal(alive(member), false);
    } finally { await f.cleanup(); }
  });
}
