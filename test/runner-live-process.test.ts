import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { TOOL_MATRIX } from '../src/shared/tool-matrix.js';
import type { Adapter, RunSpec } from '../src/runner/adapter.js';
import { processStartIdentity, recoverProcess, startTool, type ProcessGroup, type ProcessInspector, type RunningTool } from '../src/runner/process.js';

const exec = promisify(execFile);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function waitUntil(check: () => Promise<boolean> | boolean, timeout = 4000): Promise<void> {
  const until = Date.now() + timeout;
  while (!await check()) {
    assert(Date.now() < until, 'real process fixture did not reach its expected state');
    await delay(20);
  }
}

async function realPs(context: { skip(reason: string): void }): Promise<boolean> {
  try {
    await exec('/bin/ps', ['-A', '-E', '-ww', '-o', 'pid=,uid=,command='], { maxBuffer: 32 * 1024 * 1024 });
    assert(await processStartIdentity(process.pid));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM' && !/operation not permitted|permission denied/iu.test(String(error))) throw error;
    context.skip('/bin/ps EPERM in sandbox; rerun TLS21-R5 real process regressions outside the sandbox');
    return false;
  }
}

// Fixtures use real process tables, including when a test injects a scan outage.
// Synthetic fence or process rows must not make a child identifiable.
async function fixture(mode: string, before = 0, after = 0) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-live-ps-'));
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
  const spec: RunSpec = { bin, cwd: root, runDir, promptFile, model: 'fixture', provider: null, effort: null, access: 'folder_only', skillsDir: join(runDir, 'skills'), maxTurns: 50, timeoutSeconds: 0, runHome: null };
  const matrix = structuredClone(TOOL_MATRIX);
  matrix.tools.find(tool => tool.key === 'codex')!.run = { adapter: 'codex', card: 'TLS-26', offered: true, folderOnly: 'os-sandbox', mcpLevel: 'servers-off', reason: null, checkedAt: '2026-10-14' };
  const snapshots: ProcessGroup[][] = [];
  let running: RunningTool | undefined;
  let direct: ChildProcess | undefined;
  const readPid = async (file: string) => Number(await readFile(file, 'utf8').catch(() => '0'));
  return {
    snapshots,
    async launch(maxRunMinutes = 1, processes?: ProcessInspector) {
      running = await startTool({ adapter, spec, matrix, claimedAt: Date.now(), expiresAt: Date.now() + 7_200_000, maxRunMinutes,
        processes, onGroups: groups => { snapshots.push(structuredClone(groups)); } });
      return running;
    },
    async direct(fence?: string) {
      direct = spawn(bin, args, { detached: true, stdio: 'ignore', env: fence ? { MDAI_RUN_FENCE: fence } : {} });
      direct.unref();
      await waitUntil(async () => (await readPid(rootFile)) > 1);
      assert(direct.pid);
      return direct.pid;
    },
    async orphan() {
      await waitUntil(async () => (await readPid(pidFile)) > 1);
      return readPid(pidFile);
    },
    async ready() { await waitUntil(async () => (await readFile(readyFile, 'utf8').catch(() => '')) === 'ready'); },
    async orphanReady() { await waitUntil(async () => (await readFile(`${signalFile}.ready`, 'utf8').catch(() => '')) === 'ready'); },
    async wasSignalled() { return (await readFile(signalFile, 'utf8').catch(() => '')) !== ''; },
    async cleanup() {
      // Kill the root first so it cannot create another orphan during teardown.
      // Its group also catches unrecorded /bin/sleep iterations in the shell loop.
      const rootPid = await readPid(rootFile) || running?.pid || direct?.pid || 0;
      const orphanPid = await readPid(pidFile);
      for (const pid of [rootPid, orphanPid]) if (pid > 1) {
        for (const target of [-pid, pid]) try { process.kill(target, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
      if (running) await running.finished.catch(() => undefined);
      for (const pid of [rootPid, orphanPid]) if (pid > 1) await waitUntil(() => !alive(pid));
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('TLS21-R5: startTool rootVerified sweeps a late same-group orphan after a full live scan outage with real ps', { timeout: 20_000 }, async context => {
  if (!await realPs(context)) return;
  // No detach or environment change: this sleep inherits the root's group.
  // Waiting 5600 ms expires liveGroups authority before the root exits.
  const f = await fixture('sleep', 5600);
  let root = 0;
  let tableCalls = 0;
  let blockedScans = 0;
  const processes: ProcessInspector = {
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
    root = running.pid;
    assert.equal((await running.finished).ok, true);
    assert(blockedScans > 0, 'the live root must experience the injected scan outage');
    assert.equal(alive(await f.orphan()), false, 'rootVerified must sweep the orphan after liveGroups authority expires');
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
  test(`TLS21-R5: ${label} is gone when finished resolves with real ps`, { timeout: 20_000 }, async context => {
    if (!await realPs(context)) return;
    const f = await fixture(mode, before, after);
    try {
      const running = await f.launch();
      const result = await running.finished;
      const orphan = await f.orphan();
      assert.equal(result.ok, true);
      assert.equal(alive(orphan), false, 'same-group orphan must be dead before reporting success');
      assert(f.snapshots.some(groups => groups.some(group => group.pgid === running.pid && group.members?.some(member => member.pid === orphan && member.startedAt))), 'persist positive member evidence before signalling a newly observed orphan');
    } finally { await f.cleanup(); }
  });
}

for (const action of ['stop', 'deadline'] as const) {
  test(`TLS21-R5: ${action} sweeps the same-group orphan created by a TERM handler with real ps`, { timeout: 20_000 }, async context => {
    if (!await realPs(context)) return;
    const f = await fixture('term');
    try {
      const running = await f.launch(action === 'deadline' ? 0.04 : 1);
      await f.ready();
      if (action === 'stop') await running.stop('heartbeat_stop');
      const result = await running.finished;
      assert.equal(result.failureCode, action === 'stop' ? 'heartbeat_stop' : 'run_time_limit');
      assert.equal(alive(await f.orphan()), false, 'TERM handler orphan survives neither stop nor deadline');
    } finally { await f.cleanup(); }
  });
}

test('TLS21-R5: recovery of an identity-matched live root sweeps its TERM-handler orphan with real ps', { timeout: 20_000 }, async context => {
  if (!await realPs(context)) return;
  const f = await fixture('term');
  try {
    const fence = randomBytes(16).toString('hex');
    const root = await f.direct(fence);
    await f.ready();
    const startedAt = await processStartIdentity(root);
    assert(startedAt);
    assert.equal(await recoverProcess(root, startedAt, undefined, fence, [{ pgid: root, startedAt }]), true);
    assert.equal(alive(root), false);
    assert.equal(alive(await f.orphan()), false);
  } finally { await f.cleanup(); }
});

test('TLS21-R5: Darwin onGroups never persists sid or root sessionLeader for a detached child with real ps', { timeout: 20_000 }, async context => {
  if (process.platform !== 'darwin') { context.skip('Darwin sess=0 regression'); return; }
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

test('TLS21-R5: Darwin stale sid=0 and live root do not authorize an unrelated leaderless group with real ps', { timeout: 20_000 }, async context => {
  if (process.platform !== 'darwin') { context.skip('Darwin sess=0 regression'); return; }
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
  test(`TLS21-P1: real leaderless group remains recoverable through its exact ${evidence}`, { timeout: 20_000 }, async context => {
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
      assert.equal(await recoverProcess(0, '', undefined, evidence === 'fence' ? fence : undefined, [saved]), true);
      assert.equal(alive(member), false);
    } finally { await f.cleanup(); }
  });
}
