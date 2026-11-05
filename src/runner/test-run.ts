import {constants} from 'node:fs';
import {randomBytes, randomUUID} from 'node:crypto';
import {lstat, mkdtemp, mkdir, open, readdir, realpath, rm, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, isAbsolute, join, resolve} from 'node:path';
import {TOOL_MATRIX, toolRunCapability, type ToolMatrix} from '../shared/tool-matrix.js';
import type {RunnerTestResultBody} from '../shared/runner-protocol.js';
import {HelperError} from '../config.js';
import {selectedLoginFailure} from './linux-login-provider.js';
import {assertNoSymlinks, atomicWrite, ensurePrivateDirectory, inside, readPrivateFile, withWriteLock, type HelperPaths} from '../paths.js';
import {currentLinuxRunIsRetired, currentLinuxToolLifecycle, withLinuxRunContext} from './linux-lifecycle.js';
import {listBound, readBound, writeBound} from './state.js';
import {acquireRunnerControllerLease, controllerStorageBusy, RunnerControllerLeaseRefusal, type RunnerControllerStorage, type RunnerStorageDirectory} from './storage-lock.js';
import type {Adapter} from './adapter.js';
import {AdapterRegistry} from './adapters/index.js';
import {beforeDeadline, cleanupRunHome, hasLegacyLinuxIdentity, PROCESS_CLEANUP_CAP_MS, ProcessCleanupError, processIsRunning, recoverProcess, startTool, timeoutSeconds, verifyLegacyProcessAbsence, type ProcessGroup, type ProcessInspector, type RunningTool} from './process.js';
import type {VerifiedAcceptance} from './acceptance.js';
import {hasAcceptanceOperation, type LinuxAcceptanceOperation} from './linux-authorization.js';

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
  purpose?: 'activation' | 'diagnostic'; acceptance?: VerifiedAcceptance; acceptanceOperation?: LinuxAcceptanceOperation;
  readProviderKey?: () => Promise<string | null | undefined>;
};
export function runTestCode(error: unknown): string {
  const loginFailure = selectedLoginFailure(error);
  if (loginFailure) return loginFailure.code;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && /^(?!.*(?:pm_|mdai_skill_))[A-Za-z0-9_]{1,60}$/.test(code) ? code : 'tool_failed';
}

type TestProcessRow = {format: 1; aiToolId: string; cwd: string; fence: string; pid: number; startedAt: string; groups: ProcessGroup[];
  claimedAt?: number; containmentRunId?: string; legacyProcessIdentity?: true; legacyProcessGroups?: ProcessGroup[]};
const testId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const recoveryError = () => new HelperError('RUNNER_TEST_RECOVERY_UNAVAILABLE', 'The previous test process could not be recovered safely.');
const printable = (value: unknown, empty = false): value is string => typeof value === 'string' && (empty || value.length > 0) && value.length <= 100 && !/[^\x20-\x7e]/.test(value);
function validGroup(value: unknown): value is ProcessGroup {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const group = value as ProcessGroup;
  const identity = (item: unknown) => !!item && typeof item === 'object' && !Array.isArray(item) &&
    Object.keys(item).sort().join(',') === 'pid,startedAt' && Number.isSafeInteger((item as {pid: number}).pid) && (item as {pid: number}).pid > 1 && printable((item as {startedAt: string}).startedAt);
  return Object.keys(group).every(key => ['pgid', 'startedAt', 'spawnedBy', 'sid', 'members', 'sessionLeader', 'cleanupPending'].includes(key)) &&
    Number.isSafeInteger(group.pgid) && group.pgid > 1 && printable(group.startedAt, true) &&
    (group.spawnedBy === undefined || Number.isSafeInteger(group.spawnedBy) && group.spawnedBy >= 0) &&
    (group.cleanupPending === undefined || group.cleanupPending === true) &&
    (group.sid === undefined || printable(group.sid)) &&
    (group.members === undefined || Array.isArray(group.members) && group.members.length <= 4096 && group.members.every(identity)) &&
    (group.sessionLeader === undefined || identity(group.sessionLeader));
}
type TestStorage = {storage: RunnerControllerStorage; ledger: RunnerStorageDirectory; homes: RunnerStorageDirectory;
  pending: Set<Promise<unknown>>; sealed: boolean; failed: boolean};
const retainedDiagnosticStorage = new Set<TestStorage>();
// Reserve before acquiring the lease, then retain through preparation, reads
// and physical release. Acquisition alone cannot certify unread state clean.
const diagnosticLeases = new Map<symbol, string[]>();
const uncertainDiagnosticPaths = new Set<string>();
const uncertainDiagnosticAcquisitions = new Set<RunnerControllerLeaseRefusal>();
export function diagnosticStorageBusy(data?: string): boolean {
  return controllerStorageBusy(data) || [...retainedDiagnosticStorage].some(bound => data === undefined || bound.storage.data === resolve(data)) ||
    [...diagnosticLeases.values()].some(paths => data === undefined || paths.includes(resolve(data))) ||
    [...uncertainDiagnosticPaths].some(path => data === undefined || path === resolve(data)) ||
    [...uncertainDiagnosticAcquisitions].some(refusal => data === undefined || refusal.storagePaths.has(resolve(data)));
}
function physical<T>(bound: TestStorage | undefined, action: () => Promise<T>): Promise<T> {
  if (!bound) return action();
  if (bound.sealed) return Promise.reject(recoveryError());
  // Register before the first callback can start physical I/O or settle.
  const work = Promise.resolve().then(action);
  if (bound) {
    bound.pending.add(work);
    void work.then(() => {bound.pending.delete(work);}, () => {
      bound.failed = true; bound.pending.delete(work); retainedDiagnosticStorage.add(bound);
    });
  }
  return work;
}
async function testDirectory(data: string, bound?: TestStorage): Promise<string> {
  if (bound) {await bound.ledger.assertCurrent(); return bound.ledger.path;}
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
async function saveRecoveryRow(file: string, row: TestProcessRow, bound?: TestStorage): Promise<void> {
  const text = JSON.stringify(row) + '\n';
  if (Buffer.byteLength(text) > 1024 * 1024) throw recoveryError();
  await physical(bound, () => bound ? writeBound(bound.ledger, basename(file), text) : atomicWrite(file, text));
}
async function removeRecoveryRow(file: string, bound?: TestStorage): Promise<void> {
  if (!bound) return unlink(file);
  await physical(bound, async () => {
    await bound?.ledger.assertCurrent(); await unlink(file);
    if (bound) {await bound.ledger.sync(); await bound.ledger.assertCurrent();}
  });
}
async function recoverTestsUnlocked(data: string, processes?: ProcessInspector, bound?: TestStorage): Promise<void> {
  const directory = await testDirectory(data, bound);
  let names: string[];
  try {names = bound ? await listBound(bound.ledger, 4096) : await readdir(directory);}
  catch (error) {
    if (!bound) throw error;
    uncertainDiagnosticPaths.add(bound.storage.data); throw recoveryError();
  }
  await bound?.ledger.assertCurrent();
  for (const name of names) {
    await bound?.ledger.assertCurrent();
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
      const value: unknown = JSON.parse(bound ? await readBound(bound.ledger, name) : await readPrivateFile(file, 1024 * 1024));
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).filter(key => !['claimedAt', 'containmentRunId', 'legacyProcessIdentity', 'legacyProcessGroups'].includes(key)).sort().join(',') !== 'aiToolId,cwd,fence,format,groups,pid,startedAt') throw recoveryError();
      row = value as TestProcessRow;
      if (row.format !== 1 || row.aiToolId + '.json' !== name || typeof row.cwd !== 'string' || !/^[a-f0-9]{32}$/.test(row.fence) ||
          !Number.isSafeInteger(row.pid) || row.pid < 0 || row.pid === 1 || !printable(row.startedAt, true) ||
          row.claimedAt !== undefined && (!Number.isSafeInteger(row.claimedAt) || row.claimedAt < 0) ||
          row.containmentRunId !== undefined && !testId.test(row.containmentRunId) ||
          row.legacyProcessIdentity !== undefined && row.legacyProcessIdentity !== true ||
          row.legacyProcessGroups !== undefined && (row.legacyProcessIdentity !== true || !Array.isArray(row.legacyProcessGroups) || row.legacyProcessGroups.length > 4096 || !row.legacyProcessGroups.every(validGroup)) ||
          !Array.isArray(row.groups) || row.groups.length > 4096 || !row.groups.every(validGroup) || /pm_run_|mdai_skill_/.test(JSON.stringify(row))) throw recoveryError();
      await checkedTemp(row.cwd);
      const cleanupStarted = Date.now(), cleanupEnds = cleanupStarted + PROCESS_CLEANUP_CAP_MS;
      if (process.platform === 'linux') {
        // Numeric diagnostic rows are projections, never cleanup authority.
        // Only the matching durable containment retirement allows deletion.
        if (!row.containmentRunId || !await withLinuxRunContext(data,
          async () => currentLinuxRunIsRetired(row.containmentRunId!))) throw recoveryError();
      } else {
        if (hasLegacyLinuxIdentity(row.pid, row.startedAt, row.groups)) row.legacyProcessIdentity = true;
        if (row.legacyProcessIdentity && row.legacyProcessGroups === undefined) {
          row.legacyProcessGroups = structuredClone(row.groups);
          await beforeDeadline(cleanupEnds, () => saveRecoveryRow(file, row, bound));
        }
        await recoverProcess(row.pid, row.startedAt, processes, row.fence, row.groups, async groups => {
          row.groups = groups; await saveRecoveryRow(file, row, bound);
        }, cleanupStarted);
        if (row.legacyProcessIdentity) await verifyLegacyProcessAbsence(row.pid, row.legacyProcessGroups ?? [], processes, cleanupEnds);
      }
      await cleanupRunHome(data, `test-${row.fence}`, {directory: bound?.homes});
      await checkedTemp(row.cwd); await rm(row.cwd, {recursive: true, force: true}); await removeRecoveryRow(file, bound);
    } catch {throw recoveryError();}
  }
}
async function testLease<T>(data: string, work: (bound?: TestStorage) => Promise<T>, skipBusy = false): Promise<T | undefined> {
  if (process.platform === 'linux') {
    if (!isAbsolute(data) || resolve(data) !== data) throw recoveryError();
    const reservation = Symbol('diagnostic lease'), paths = [data];
    diagnosticLeases.set(reservation, paths);
    let storage: RunnerControllerStorage;
    try {storage = await acquireRunnerControllerLease(data, 'tests', undefined, Date.now() + (skipBusy ? 100 : 10_000));}
    catch (error) {
      if (error instanceof RunnerControllerLeaseRefusal && error.unresolved) {
        uncertainDiagnosticPaths.add(data); uncertainDiagnosticAcquisitions.add(error);
      }
      diagnosticLeases.delete(reservation);
      if (skipBusy && (error as {code?: string}).code === 'HELPER_BUSY') return;
      throw error;
    }
    paths.push(storage.data);
    const pending = new Set<Promise<unknown>>();
    let bound: TestStorage | undefined;
    try {
      if (skipBusy) {
        try {
          const text = await readBound(await storage.directory('runner'), '.test-process.lock', 32), pid = Number(text);
          if (!text || /^[0-9]+$/.test(text) && pid > 0 && Number.isSafeInteger(pid) && await processIsRunning(pid)) return;
        } catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
      }
      bound = {storage, ledger: await storage.directory('runner/test-processes'), homes: await storage.directory('run-homes'), pending, sealed: false, failed: false};
      return await work(bound);
    } catch (error) {
      // A failed initialization or settled read leaves the ledger unproved.
      // Pending publications already retain their bound obligation until real
      // settlement; preserve that existing physical handoff separately.
      if (!pending.size) for (const path of paths) uncertainDiagnosticPaths.add(path);
      throw error;
    } finally {
      // Seal before snapshotting pending work. Late process callbacks cannot
      // enqueue another operation against a descriptor that may be reused.
      if (bound) bound.sealed = true;
      const release = async () => {
        if (bound?.failed) {retainedDiagnosticStorage.add(bound); return;}
        await storage.release();
        if (bound) retainedDiagnosticStorage.delete(bound);
        diagnosticLeases.delete(reservation);
      };
      if (pending.size) {
        if (bound) retainedDiagnosticStorage.add(bound);
        void Promise.allSettled(pending).then(release).catch(() => {if (bound) retainedDiagnosticStorage.add(bound);});
      } else await release();
    }
  }
  await testDirectory(data);
  const directory = join(data, 'runner'), lock = join(directory, '.test-process.lock');
  if (skipBusy) {
    try {
      const text = await readPrivateFile(lock, 32), pid = Number(text);
      if (!text) return;
      if (/^[0-9]+$/.test(text) && pid > 0 && Number.isSafeInteger(pid)) {
        try {if (await processIsRunning(pid)) return;} catch {return;}
      }
    } catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
  }
  return withWriteLock({data: directory, lock} as HelperPaths, () => work());
}
/** Startup recovery and live tests share a lease, so one helper cannot kill another helper's active test. */
export async function recoverTestRuns(options: {data: string; processes?: ProcessInspector; skipBusy?: boolean}): Promise<boolean> {
  return await testLease(options.data, async bound => {await recoverTestsUnlocked(options.data, options.processes, bound); return true;}, options.skipBusy) ?? false;
}
export async function runToolTest(options: RunToolTestOptions): Promise<RunTestResult> {
  if (process.platform === 'linux') {
    try {
      // A diagnostic is a workload. It must own initialized durable storage
      // throughout actual process extinction and retirement, including when
      // no ordinary RunnerCore has been created by this CLI invocation.
      if (!options.data) throw new HelperError('LINUX_CONTAINMENT_UNAVAILABLE', 'Linux diagnostics require initialized containment storage.');
      return await withLinuxRunContext(options.data, () => runToolTestInContext(options));
    }
    catch (error) {return {ok: false, code: runTestCode(error), toolVersion: options.connection.toolVersion};}
  }
  return runToolTestInContext(options);
}
async function runToolTestInContext(options: RunToolTestOptions): Promise<RunTestResult> {
  // Linux storage and owner admission precede even metadata discovery. Once
  // admitted, refuse unsupported platforms before acquiring a diagnostic lease.
  if (process.platform === 'linux') {
    const capability = toolRunCapability((options.matrix ?? TOOL_MATRIX).tools.find(tool => tool.key === options.connection.tool), 'linux');
    if (capability && !capability.offered && !scopedTestOperation(options)) return {ok: false, code: 'adapter_refused', toolVersion: options.connection.toolVersion};
  }
  const adapter = options.registry.get(options.connection.tool);
  const capability = toolRunCapability((options.matrix ?? TOOL_MATRIX).tools.find(tool => tool.run?.adapter === adapter?.info.tool), process.platform);
  if (!adapter || !capability || !capability.offered && !scopedTestOperation(options)) return {ok: false, code: 'adapter_refused', toolVersion: options.connection.toolVersion};
  if (!options.data) return executeToolTest(options);
  try {
    const result = await testLease(options.data, async bound => {
      await recoverTestsUnlocked(options.data!, options.processes, bound);
      return executeToolTest(options, bound);
    });
    if (!result) throw recoveryError();
    return result;
  } catch (error) {return {ok: false, code: runTestCode(error), toolVersion: options.connection.toolVersion};}
}

function scopedTestOperation(options: RunToolTestOptions): boolean {
  const receipt = options.acceptance;
  return process.platform === 'linux' && !!receipt && hasAcceptanceOperation(options.acceptanceOperation, {
    toolKey: options.connection.tool, platform: 'linux', aiToolId: options.connection.aiToolId,
    runId: receipt.runId, generation: receipt.generation, purpose: options.purpose ?? 'diagnostic',
  });
}

/** The ordinary core spawn boundary also owns test environment, identity, MCP and process cleanup. */
async function executeToolTest(options: RunToolTestOptions, bound?: TestStorage): Promise<RunTestResult> {
  const {connection, signal} = options;
  const result = (code: string | null): RunTestResult => ({ok: code === null, code, toolVersion: connection.toolVersion});
  const sourceAdapter = options.registry.get(connection.tool);
  const model = options.model ?? connection.model ?? (sourceAdapter?.info.tool === 'deepseek-harness' ? 'deepseek-flash' : undefined);
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
  const run = toolRunCapability((options.matrix ?? TOOL_MATRIX).tools.find(tool => tool.run?.adapter === adapter?.info.tool), process.platform);
  if (!adapter || !run || !run.offered && !scopedTestOperation(options)) return result('adapter_refused');
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
    ledgerWrites = ledgerWrites.then(async () => {if (row && ledger) await (bound ? saveRecoveryRow(ledger, row, bound) : atomicWrite(ledger, JSON.stringify(row) + '\n'));});
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
    const fence = randomBytes(16).toString('hex'), containmentRunId = process.platform === 'linux' ? randomUUID() : undefined;
    if (options.data) {
      if (!testId.test(connection.aiToolId)) throw new HelperError('adapter_refused', 'The test connection id is invalid.');
      ledger = join(await testDirectory(options.data, bound), connection.aiToolId + '.json');
      row = {format: 1, aiToolId: connection.aiToolId, cwd, fence, pid: 0, startedAt: '', groups: [], claimedAt,
        ...(containmentRunId ? {containmentRunId} : {})};
      await saveProcess();
    }
    signal?.addEventListener('abort', abort, {once: true});
    tool = await startTool({adapter, spec: {bin: connection.bin, cwd, runDir, promptFile, ...selected,
      skillsDir, skillNames: [], maxTurns: 50, timeoutSeconds: timeoutSeconds(deadline, claimedAt), runHome: null},
      recordedRealpath: connection.realpath, matrix: options.matrix, processes: options.processes, now: options.now,
      dataDir: options.data, runHomesDirectory: bound?.homes, runId: `test-${fence}`, readProviderKey: options.readProviderKey,
      linuxLifecycle: containmentRunId ? currentLinuxToolLifecycle(containmentRunId, options.acceptanceOperation) : undefined,
      acceptanceOperation: options.acceptanceOperation,
      operationPurpose: options.purpose ?? 'diagnostic',
      claimedAt, expiresAt: deadline + 300_000, maxRunMinutes: 5, fence, signal,
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
    if (cwd && cleanupVerified) {await checkedTemp(cwd); await rm(cwd, {recursive: true, force: true}); if (ledger) await removeRecoveryRow(ledger, bound);}
  }
}
