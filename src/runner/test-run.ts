import {constants} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {lstat, mkdtemp, mkdir, open, readdir, realpath, rm, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, isAbsolute, join, resolve} from 'node:path';
import {TOOL_MATRIX, type ToolMatrix} from '../shared/tool-matrix.js';
import type {RunnerTestResultBody} from '../shared/runner-protocol.js';
import {HelperError} from '../config.js';
import {assertNoSymlinks, atomicWrite, ensurePrivateDirectory, inside, readPrivateFile, withWriteLock, type HelperPaths} from '../paths.js';
import type {Adapter} from './adapter.js';
import {AdapterRegistry} from './adapters/index.js';
import {ProcessCleanupError, recoverProcess, startTool, timeoutSeconds, type ProcessGroup, type ProcessInspector, type RunningTool} from './process.js';

export const RUN_TEST_PROMPT = 'Reply with exactly MADDOTS-RUNNER-OK and nothing else.';
export const RUN_TEST_DEADLINE_MS = 300_000;
export type RunTestConnection = {
  aiToolId: string; tool: string; toolVersion: string | null; bin: string; realpath: string;
  model?: string; provider?: string | null; effort?: string | null;
};
export type RunTestResult = RunnerTestResultBody;
export type RunToolTestOptions = {
  data?: string; connection: RunTestConnection; registry: AdapterRegistry; matrix?: ToolMatrix; model?: string;
  processes?: ProcessInspector; now?: () => number; signal?: AbortSignal;
};
export function runTestCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && /^(?!.*(?:pm_|mdai_skill_))[A-Za-z0-9_]{1,60}$/.test(code) ? code : 'tool_failed';
}

type TestProcessRow = {format: 1; aiToolId: string; cwd: string; fence: string; pid: number; startedAt: string; groups: ProcessGroup[]};
const testId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const recoveryError = () => new HelperError('RUNNER_TEST_RECOVERY_UNAVAILABLE', 'The previous test process could not be recovered safely.');
const printable = (value: unknown, empty = false): value is string => typeof value === 'string' && (empty || value.length > 0) && value.length <= 100 && !/[^\x20-\x7e]/.test(value);
function validGroup(value: unknown): value is ProcessGroup {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const group = value as ProcessGroup;
  const identity = (item: unknown) => !!item && typeof item === 'object' && !Array.isArray(item) &&
    Object.keys(item).sort().join(',') === 'pid,startedAt' && Number.isSafeInteger((item as {pid: number}).pid) && (item as {pid: number}).pid > 1 && printable((item as {startedAt: string}).startedAt);
  return Object.keys(group).every(key => ['pgid', 'startedAt', 'spawnedBy', 'sid', 'members', 'sessionLeader'].includes(key)) &&
    Number.isSafeInteger(group.pgid) && group.pgid > 1 && printable(group.startedAt, true) &&
    (group.spawnedBy === undefined || Number.isSafeInteger(group.spawnedBy) && group.spawnedBy >= 0) &&
    (group.sid === undefined || printable(group.sid)) &&
    (group.members === undefined || Array.isArray(group.members) && group.members.length <= 4096 && group.members.every(identity)) &&
    (group.sessionLeader === undefined || identity(group.sessionLeader));
}
async function testDirectory(data: string): Promise<string> {
  if (!isAbsolute(data) || resolve(data) !== data) throw recoveryError();
  const directory = join(data, 'runner', 'test-processes'); await ensurePrivateDirectory(directory); return directory;
}
async function checkedTemp(cwd: string): Promise<void> {
  const temporaryRoot = await realpath(tmpdir());
  if (!isAbsolute(cwd) || resolve(cwd) !== cwd || dirname(cwd) !== temporaryRoot || !/^maddots-ai-test-[A-Za-z0-9]+$/.test(basename(cwd))) throw recoveryError();
  await assertNoSymlinks(cwd, temporaryRoot);
  try {const info = await lstat(cwd); if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) throw recoveryError();}
  catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
}
async function recoverTestsUnlocked(data: string, processes?: ProcessInspector): Promise<void> {
  const directory = await testDirectory(data);
  for (const name of await readdir(directory)) {
    const file = join(directory, name);
    if (name.startsWith('.') && name.endsWith('.tmp') && testId.test(name.slice(1, -4))) {
      // A crash can interrupt atomicWrite before its rename. This is evidence, never process authority.
      const info = await lstat(file);
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.nlink !== 1) throw recoveryError();
      continue;
    }
    if (!testId.test(name.replace(/\.json$/, '')) || !name.endsWith('.json')) throw recoveryError();
    let row: TestProcessRow;
    try {
      const value: unknown = JSON.parse(await readPrivateFile(file, 1024 * 1024));
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'aiToolId,cwd,fence,format,groups,pid,startedAt') throw recoveryError();
      row = value as TestProcessRow;
      if (row.format !== 1 || row.aiToolId + '.json' !== name || typeof row.cwd !== 'string' || !/^[a-f0-9]{32}$/.test(row.fence) ||
          !Number.isSafeInteger(row.pid) || row.pid < 0 || row.pid === 1 || !printable(row.startedAt, true) ||
          !Array.isArray(row.groups) || row.groups.length > 4096 || !row.groups.every(validGroup) || /pm_run_|mdai_skill_/.test(JSON.stringify(row))) throw recoveryError();
      await checkedTemp(row.cwd);
      await recoverProcess(row.pid, row.startedAt, processes, row.fence, row.groups, async groups => {
        row.groups = groups; await atomicWrite(file, JSON.stringify(row) + '\n');
      });
      await checkedTemp(row.cwd); await rm(row.cwd, {recursive: true, force: true}); await unlink(file);
    } catch {throw recoveryError();}
  }
}
async function testLease<T>(data: string, work: () => Promise<T>, skipBusy = false): Promise<T | undefined> {
  await testDirectory(data);
  const directory = join(data, 'runner'), lock = join(directory, '.test-process.lock');
  if (skipBusy) {
    try {
      const text = await readPrivateFile(lock, 32), pid = Number(text);
      if (!text) return;
      if (/^[0-9]+$/.test(text) && pid > 0 && Number.isSafeInteger(pid)) {
        try {process.kill(pid, 0); return;} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return;}
      }
    } catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
  }
  return withWriteLock({data: directory, lock} as HelperPaths, work);
}
/** Startup recovery and live tests share a lease, so one helper cannot kill another helper's active test. */
export async function recoverTestRuns(options: {data: string; processes?: ProcessInspector; skipBusy?: boolean}): Promise<boolean> {
  return await testLease(options.data, async () => {await recoverTestsUnlocked(options.data, options.processes); return true;}, options.skipBusy) ?? false;
}
export async function runToolTest(options: RunToolTestOptions): Promise<RunTestResult> {
  if (!options.data) return executeToolTest(options);
  try {
    const result = await testLease(options.data, async () => {
      await recoverTestsUnlocked(options.data!, options.processes);
      return executeToolTest(options);
    });
    if (!result) throw recoveryError();
    return result;
  } catch (error) {return {ok: false, code: runTestCode(error), toolVersion: options.connection.toolVersion};}
}

/** The ordinary core spawn boundary also owns test environment, identity, MCP and process cleanup. */
async function executeToolTest(options: RunToolTestOptions): Promise<RunTestResult> {
  const {connection, signal} = options;
  const result = (code: string | null): RunTestResult => ({ok: code === null, code, toolVersion: connection.toolVersion});
  const sourceAdapter = options.registry.get(connection.tool);
  const model = options.model ?? connection.model;
  let adapter = sourceAdapter;
  if (sourceAdapter && model === undefined) {
    const flag = sourceAdapter.info.tool === 'codex' ? '-m' : sourceAdapter.info.tool === 'claude-code' ? '--model' : null;
    if (!flag) return result('adapter_refused');
    // These pilot CLIs select their saved default when the model option is absent.
    adapter = {...sourceAdapter, build(spec) {
      const invocation = sourceAdapter.build(spec);
      const position = invocation.argv.indexOf(flag);
      if (position < 1 || invocation.argv[position + 1] !== spec.model || invocation.argv.lastIndexOf(flag) !== position) throw new HelperError('adapter_refused', 'The default-model option is invalid.');
      return {...invocation, argv: [...invocation.argv.slice(0, position), ...invocation.argv.slice(position + 2)]};
    }} satisfies Adapter;
  }
  const run = (options.matrix ?? TOOL_MATRIX).tools.find(tool => tool.run?.adapter === adapter?.info.tool)?.run;
  if (!adapter || !run?.offered) return result('adapter_refused');
  // Matrix capabilities are the offered modes, independent of what an adapter can build.
  const access = run.folderOnly === 'none' ? 'full_access' : 'folder_only';
  const selected = {model: model ?? 'maddots-runner-default', provider: connection.provider ?? null,
    effort: connection.effort ?? null, access} as const;
  if (!adapter.supports(selected).ok) return result('adapter_refused');
  if (signal?.aborted) return result('runner_stopped');
  let cwd: string | undefined, tool: RunningTool | undefined;
  let cleanupVerified = true;
  let ledger: string | undefined, row: TestProcessRow | undefined;
  let ledgerWrites = Promise.resolve();
  const saveProcess = async () => {
    ledgerWrites = ledgerWrites.then(async () => {if (row && ledger) await atomicWrite(ledger, JSON.stringify(row) + '\n');});
    await ledgerWrites;
  };
  const abort = () => {void tool?.stop('runner_stopped').catch(() => {});};
  try {
    cwd = await realpath(await mkdtemp(join(tmpdir(), 'maddots-ai-test-')));
    await ensurePrivateDirectory(cwd);
    const runDir = join(cwd, 'run'); await mkdir(runDir, {mode: 0o700});
    const promptFile = join(runDir, 'prompt.md');
    await writeFile(promptFile, RUN_TEST_PROMPT, {flag: 'wx', mode: 0o600});
    const skillsDir = adapter.info.skillsDir.replaceAll('{cwd}', cwd).replaceAll('{runDir}', runDir);
    if (!inside(cwd, resolve(skillsDir))) throw new HelperError('adapter_refused', 'The test skill folder is outside its temporary folder.');
    await mkdir(skillsDir, {recursive: true, mode: 0o700});
    if (adapter.info.tool === 'claude-code') {
      const manifestDir = join(runDir, 'plugin', '.claude-plugin');
      await mkdir(manifestDir, {recursive: true, mode: 0o700});
      await writeFile(join(manifestDir, 'plugin.json'), JSON.stringify({name: 'maddots-run', version: '1.0.0'}), {flag: 'wx', mode: 0o600});
    }
    const claimedAt = (options.now ?? Date.now)(), deadline = claimedAt + RUN_TEST_DEADLINE_MS;
    const fence = randomBytes(16).toString('hex');
    if (options.data) {
      if (!testId.test(connection.aiToolId)) throw new HelperError('adapter_refused', 'The test connection id is invalid.');
      ledger = join(await testDirectory(options.data), connection.aiToolId + '.json');
      row = {format: 1, aiToolId: connection.aiToolId, cwd, fence, pid: 0, startedAt: '', groups: []};
      await saveProcess();
    }
    signal?.addEventListener('abort', abort, {once: true});
    tool = await startTool({adapter, spec: {bin: connection.bin, cwd, runDir, promptFile, ...selected,
      skillsDir, maxTurns: 50, timeoutSeconds: timeoutSeconds(deadline, claimedAt), runHome: null},
      recordedRealpath: connection.realpath, matrix: options.matrix, processes: options.processes, now: options.now,
      claimedAt, expiresAt: deadline + 300_000, maxRunMinutes: 5, fence,
      onSpawn: async (pid, startedAt) => {if (row && ledger) {row.pid = pid; row.startedAt = startedAt; await saveProcess();}},
      onGroups: async groups => {if (row && ledger) {row.groups = groups; await saveProcess();}},
      stageProjectFile: async file => {
        // Test configuration is disposable, but has the same no-clobber boundary as project files.
        if (isAbsolute(file.path) || !inside(cwd!, resolve(cwd!, file.path)) || resolve(cwd!, file.path) === cwd) throw new HelperError('adapter_refused', 'The test configuration path is invalid.');
        const target = resolve(cwd!, file.path);
        await assertNoSymlinks(target, cwd);
        await mkdir(dirname(target), {recursive: true, mode: 0o700});
        await assertNoSymlinks(target, cwd);
        const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {await handle.writeFile(file.content);} finally {await handle.close();}
      }});
    if (signal?.aborted) await tool.stop('runner_stopped');
    const parsed = await tool.finished;
    return result(parsed.ok && parsed.text.includes('MADDOTS-RUNNER-OK') ? null : parsed.failureCode ?? 'tool_failed');
  } catch (error) {
    cleanupVerified = !(error instanceof ProcessCleanupError);
    return result(runTestCode(error));
  } finally {
    signal?.removeEventListener('abort', abort);
    // Never remove evidence while escaped descendants could still hold this directory.
    if (cwd && cleanupVerified) {await checkedTemp(cwd); await rm(cwd, {recursive: true, force: true}); if (ledger) await unlink(ledger);}
  }
}
