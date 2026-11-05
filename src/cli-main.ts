import { hostname } from 'node:os';
import { readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { ApiClient, isSkillsToken } from './api.js';
import { assertRunsPlatform, validateCliLaunch as validateOrdinaryCliLaunch } from './cli-validation.js';
import { listBackups, restoreBackup } from './backups.js';
import { HelperError, cleanEnvironment, clock, createRuntimeRunner, readConfig, runCommand, type Runner, type Timing } from './config.js';
import { detectTools } from './detect.js';
import {runToolCommand} from './tool-command.js';
import { describeUnmanaged, ImportEngine } from './imports.js';
import { grokDuplicateWarning } from './duplicates.js';
import { TOOL_MATRIX } from './shared/tool-matrix.js';
import { LockStore } from './lock.js';
import { discoverManagedLinks, linkedHomeRefs, linkedHomesWarning } from './linked-homes.js';
import { ClaudePluginDeliveryTarget, ClaudePluginSyncEngine } from './delivery/claude-plugin.js';
import { AgentsFolderDeliveryTarget } from './delivery/agents-folder.js';
import { helperPlatform } from './platform.js';
import { PairingFlow, helperOs } from './pairing.js';
import { createPaths, createRecoveryPaths, ensurePaths, withWriteLock } from './paths.js';
import { RELEASE_IDENTITY, VERSION } from './release-identity.js';
import { bundledRuntime, launchCli, type RuntimeContext } from './runtime.js';
import { assertSystemRuntime, systemRuntimeMode } from './system-runtime.js';
import { SystemRuntimeError } from './system-runtime-preflight.js';
import { prepareLockUpgrade } from './write-lock-upgrade.js';
import { FILE_STORAGE_WARNING, FileSecretStore, SecretServiceSecretStore, selectSecretStore, credentialCapabilities } from './secret-store.js';
import { KeychainProviderKeyStore, readProviderKey } from './provider-keys.js';
import { installService, removeService, runService, serviceStatus, writeServiceHeartbeat } from './service.js';
import { StateStore } from './state.js';
import { TokenManager } from './token.js';
import { checkForUpdate, rollbackRelease, selectRelease, UPDATE_CHECK_INTERVAL_MS, type UpdateOptions, type UpdateResult } from './updater.js';
import { runAllow } from './allow.js';
import { FolderDeliveryTarget, type DeliveryTarget } from './delivery/index.js';
import { interruptWaitingDialog, reserveWaitingDialog, showWaitingDialog, type PendingDialog } from './notify.js';
import { SyncEngine, type SyncOptions } from './sync.js';
import { BuildVerifier } from './verify.js';
import type { HelperState } from './state.js';
import { runnerBusy, stopRunners, tickRunners } from './runner/runner.js';
import { cleanupRunHomes, requireProcessInspection } from './runner/process.js';
import { RunsRuntime } from './runner/cli-runs.js';
import { RunnerState } from './runner/state.js';
import { recoverTestRuns } from './runner/test-run.js';
import {assertJournalBootstrapPaths, bootstrapRunnerJournal} from './runner/journal-bootstrap.js';

export type CliOptions = {
  env?: NodeJS.ProcessEnv; home?: string; runner?: Runner; request?: typeof fetch; timing?: Timing;
  output?: (line: string) => void; confirm?: (warning: string) => Promise<string>; signal?: AbortSignal;
  runtime?: RuntimeContext; platform?: NodeJS.Platform;
  /** Explicit fixture-home callers can exercise installed migration separately. Never set by CLI or env. */
  prepareLocks?: typeof prepareLockUpgrade;
  /** Explicit function-argument fixture seam. Never set by CLI or env. */
  assertRuntime?: typeof assertSystemRuntime;
  /** Explicit fixture-home callers isolate process preflight. Never set by CLI or env. */
  inspectRunProcesses?: typeof requireProcessInspection;
  isTTY?: boolean; readKey?: () => Promise<string>; deliveryTargets?: readonly DeliveryTarget[]; verifier?: BuildVerifier; watchRoute?: SyncOptions['watchRoute'];
  updates?: {
    check?: (options: UpdateOptions) => Promise<UpdateResult>;
    rollback?: (options: UpdateOptions) => Promise<UpdateResult>;
    select?: typeof selectRelease;
  };
};
async function prompt(_warning: string): Promise<string> {
  if (!process.stdin.isTTY) throw new HelperError('FILE_CONFIRMATION_REQUIRED', 'Token file storage requires an interactive typed confirmation.');
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try { return await input.question('> '); } finally { input.close(); }
}

type CliArguments = ReturnType<typeof validateOrdinaryCliLaunch> & {journalEvidence?: string; journalSha256?: string};

/** Journal parsing stays in the application loaded only after fixed preflight. */
export function validateCliLaunch(argv: string[], options: CliOptions = {}): CliArguments {
  if (argv[0] !== 'journal') return validateOrdinaryCliLaunch(argv, options);
  if ((options.platform ?? process.platform) !== 'linux' || argv.length !== 6 || argv[1] !== 'bootstrap' || argv[2] !== '--evidence' ||
      !isAbsolute(argv[3]) || resolve(argv[3]) !== argv[3] || argv[4] !== '--sha256' || !/^[a-f0-9]{64}$/u.test(argv[5])) {
    throw new HelperError('USAGE', 'Use maddots-ai journal bootstrap --evidence <absolute founder receipt> --sha256 <receipt SHA-256> on Linux.');
  }
  return {command: 'journal', rollback: false, journalEvidence: argv[3], journalSha256: argv[5]};
}

function runnerErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
  return /^[A-Za-z0-9_]{1,60}$/.test(code) ? code : 'runner_failed';
}

export async function requireRunsPlatform(platform: NodeJS.Platform = process.platform, inspect = requireProcessInspection): Promise<void> {
  assertRunsPlatform(platform);
  if (platform === 'linux') await inspect();
}
export async function computerName(runner: Runner = runCommand, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<string> {
  let name = hostname();
  if (helperPlatform(platform) === 'darwin') try { name = (await runner('/usr/sbin/scutil', ['--get', 'LocalHostName'], { env: cleanEnvironment(env) })).stdout.trim() || name; } catch { /* Hostname is the documented fallback. */ }
  return name.replace(/[^A-Za-z0-9 ._-]/g, '-').slice(0, 64) || 'Computer';
}

export async function runCli(argv: string[], options: CliOptions = {}): Promise<void> {
  const args = validateCliLaunch(argv, options), output = options.output ?? (line => process.stdout.write(line + '\n'));
  if (args.command === '--version') { output(VERSION); return; }
  // Importing this module loads and validates the matrix and runtime modules.
  // Candidate validation must never read credentials or pair with the server.
  if (args.command === '--self-test') return;
  if (['help', '--help', '-h'].includes(args.command)) {
    output('maddots-ai connect | status | allow [--all] | runs [test <tool> [--model <model>]] | agent setup [handle|agent-id] | agent access <handle|agent-id> folder-only|full | keys set deepseek | keys status | keys delete deepseek | backups [restore <id>] | import | uninstall | update [--rollback] | service' +
      ((options.platform ?? process.platform) === 'linux' ? ' | recovery seal|complete | journal bootstrap --evidence <path> --sha256 <sha256>' : '') + ' | --version'); return;
  }
  const inspectRunProcesses = options.home === undefined ? undefined : options.inspectRunProcesses;
  if (args.command === 'runs' || args.command === 'agent') await requireRunsPlatform(options.platform, inspectRunProcesses);
  const platform = helperPlatform(options.platform);
  const isTTY = options.isTTY ?? !!(process.stdin.isTTY && process.stdout.isTTY);
  const config = readConfig(options.env, options.home, platform);
  const paths = await (args.recovery ? createRecoveryPaths(config) : createPaths(config));
  if (args.command === 'journal') assertJournalBootstrapPaths(paths, options.runtime ?? await bundledRuntime());
  const fixedRuntime = systemRuntimeMode(options.runtime?.bundledRoot ?? '');
  const fixedContext = fixedRuntime ? options.runtime ?? await bundledRuntime() : undefined;
  if (fixedContext) await (options.assertRuntime ?? assertSystemRuntime)(fixedContext.bundledRoot, paths);
  if (args.recovery) {
    try {
      // Completed Darwin revision-1 snapshots retain the original module ABI.
      // Only Linux recovery may resolve this newer export.
      const { recoverLinuxLockUpgrade } = await import('./write-lock-upgrade.js');
      await recoverLinuxLockUpgrade(options.runtime ?? await bundledRuntime(), paths, args.recovery, options.timing);
      output(args.recovery === 'seal' ? 'Linux recovery seal saved. Keep runs disabled and follow the approved reboot procedure.' :
        'Linux lock recovery committed. Retained state is preserved. The installation owner must approve reopening runs.');
    } catch (error) {
      if (error instanceof HelperError) output(error.message);
      throw error;
    }
    return;
  }
  // home/prepareLocks are trusted function-argument fixture seams. The native
  // entrypoint and the legacy bootstrap never populate them from argv or env.
  if (fixedRuntime || RELEASE_IDENTITY && (options.home === undefined || options.prepareLocks)) {
    try { await (options.prepareLocks ?? prepareLockUpgrade)(options.runtime ?? fixedContext ?? await bundledRuntime(), paths, options.timing); }
    catch (error) {
      // A retained bootstrap has a different HelperError class and otherwise
      // hides the retirement instruction behind its generic top-level message.
      if (error instanceof HelperError && ['HELPER_BUSY', 'PATH_UNSAFE', 'LINUX_LOCK_RETIREMENT_UNVERIFIED'].includes(error.code)) output(error.message);
      throw error;
    }
  }
  if (args.command === 'journal') {
    await bootstrapRunnerJournal(paths.data, args.journalEvidence!, args.journalSha256!);
    output('Fresh runner journal bootstrapped; ordinary replay and EPOCH completed. Keep launch/update fences in place until the founder approves activation.');
    return;
  }
  await ensurePaths(paths);
  const timing = options.timing ?? clock;
  if (args.command === 'backups') {
    if (args.tokenFile) throw new HelperError('USAGE', 'The backups command does not take a token file.');
    if (platform === 'linux') paths.credentialFile = (await new StateStore(paths, config.endpoint).read()).tokenFile;
    await withWriteLock(paths, async () => {
      if (args.restoreId) {
        const backup = await restoreBackup(paths, args.restoreId);
        output(`Restored ${backup.originalPath}. Any current local copy was preserved in a new backup.`);
      } else {
        const backups = await listBackups(paths);
        for (const backup of backups) output(`${backup.id}  ${backup.originalPath}  ${backup.reason}${backup.attention ? `  needs attention (${backup.attention})` : ''}`);
        if (!backups.length) output('No backups.');
      }
    }, timing);
    return;
  }
  if (args.command === 'keys') {
    const saved = await new StateStore(paths, config.endpoint).read();
    if (args.keyAction === 'set' && !credentialCapabilities(saved.tokenStorage, platform).providerKeys) throw new HelperError('FILE_RUNS_REFUSED', 'Agent runs need the Keychain.');
    const keys = new KeychainProviderKeyStore(options.runner ?? runCommand, config.env);
    if (args.keyAction === 'status') output(`deepseek: ${await keys.get('deepseek') === undefined ? 'not set' : 'set'}`);
    else if (args.keyAction === 'delete') {
      await withWriteLock(paths, () => keys.delete('deepseek'), timing);
      output('deepseek: not set');
    } else {
      const key = await (options.readKey ?? readProviderKey)();
      await withWriteLock(paths, () => keys.set('deepseek', key), timing);
      output('deepseek: set');
    }
    return;
  }
  const runtime = options.runtime ?? fixedContext ?? await bundledRuntime();
  const updateOptions: UpdateOptions = {
    paths, bundledRoot: runtime.bundledRoot, version: runtime.bootstrapVersion,
    runningVersion: VERSION, env: config.env, timing, signal: options.signal,
  };
  if (args.command === 'update') {
    if (args.tokenFile) throw new HelperError('USAGE', 'The update command does not take a token file.');
    const result = args.rollback
      ? await (options.updates?.rollback ?? rollbackRelease)(updateOptions)
      : await (options.updates?.check ?? checkForUpdate)({ ...updateOptions, force: true });
    if (result.status === 'failed') throw new HelperError(result.reason ?? 'UPDATE_FAILED', 'The helper update could not be verified or prepared. ' + (result.reason ?? 'UPDATE_FAILED'));
    if (result.status === 'prepared' || result.status === 'rolled-back') {
      output(`Verified helper ${result.version ?? ''} selected. The service restarts after its current sync finishes. New commands use the selected version.`);
    } else output(`Helper update: ${result.status}.`);
    return;
  }
  const stateStore = new StateStore(paths, config.endpoint), saved = await stateStore.read();
  const runner = options.runner ?? runCommand;
  const notificationRunner = options.runner ?? createRuntimeRunner(runtime);
  if (args.tokenFile && saved.tokenStorage === 'file' && saved.tokenFile && resolve(args.tokenFile) !== saved.tokenFile) {
    throw new HelperError('FILE_UNSAFE', 'Use the token file already paired on this computer, or uninstall before changing it.');
  }
  if (args.tokenFile && saved.status === 'connected' && saved.tokenStorage !== 'file') {
    throw new HelperError('FILE_UNSAFE', 'Uninstall before switching an existing connection to token file storage.');
  }
  let confirmed = false;
  if (args.tokenFile && !(saved.tokenStorage === 'file' && saved.tokenFile === resolve(args.tokenFile))) {
    output(FILE_STORAGE_WARNING);
    confirmed = (await (options.confirm ?? prompt)(FILE_STORAGE_WARNING)).trim() === 'I understand';
  }
  const secrets = await selectSecretStore({paths, endpoint: config.endpoint, env: config.env, runner, saved,
    tokenFile: args.tokenFile ? resolve(args.tokenFile) : undefined, confirmed});
  const tokenFile = secrets instanceof FileSecretStore ? secrets.path : undefined;
  const api = new ApiClient(config.endpoint, options.request);
  const tokens = new TokenManager(api, secrets, stateStore, timing, async message => {
    output(message);
    if (platform !== 'darwin') return;
    // Supply dialog text as an argument to a fixed script, never AppleScript source.
    await runner('/usr/bin/osascript', ['-e', 'on run argv\ndisplay dialog (item 1 of argv) buttons {"OK"} default button "OK"\nend run', message], { env: cleanEnvironment(config.env) });
  });
  const runsFor = async (helperId: string) => {
    // The service shares this production entry point with the interactive commands.
    await requireRunsPlatform(platform, inspectRunProcesses);
    return new RunsRuntime({paths, helperId, api, secrets, state: stateStore,
      endpoint: config.endpoint, env: config.env, request: options.request, timing, verifier: options.verifier,
      notify: {runner: notificationRunner, entrypoint: runtime.bootstrapEntrypoint, platform, output}});
  };
  if (args.command === 'runs' || args.command === 'agent') {
    if (!saved.helperId || saved.status !== 'connected') throw new HelperError('TOKEN_REQUIRED', 'Connect this computer before setting up runs.');
    if (!credentialCapabilities(secrets.storage, platform).runClaims) throw new HelperError('FILE_RUNS_REFUSED', 'Agent runs require Keychain storage.');
    const runs = await runsFor(saved.helperId);
    try { await runs.command(argv, {isTTY, output, prompt: options.confirm ?? (async question => {
      const input = createInterface({input: process.stdin, output: process.stdout});
      try {return await input.question(question + ' ');} finally {input.close();}
    })}); } finally {await runs.close();}
    return;
  }
  if (args.command === 'import') {
    if (!saved.helperId || saved.status !== 'connected' || !saved.scopes.includes('import_upload')) {
      throw new HelperError('TOKEN_REQUIRED', 'Connect this computer before importing the folders selected on ai.maddots.app.');
    }
    await withWriteLock(paths, async () => {
      for (const line of await describeUnmanaged(paths, saved.helperId!)) output(line);
      const receipts = await new ImportEngine({paths, helperId: saved.helperId!, client: tokens, timing, output}).uploadPending();
      for (const receipt of receipts) output(`Import ${receipt.sessionId}: ${receipt.state}.`);
      if (!receipts.length) output('Choose From my AI tool on ai.maddots.app and tick the folders to import.');
    }, timing);
    return;
  }
  const detect = () => detectTools({ home: paths.home, env: config.env, runner: options.runner ?? runToolCommand, platform });
  let syncComputerName = 'Computer';
  const syncFor = (state: HelperState): SyncEngine => {
    if (!state.helperId) throw new HelperError('TOKEN_REQUIRED', 'Run maddots-ai connect to connect this computer.');
    const pilotRoutes: ReadonlySet<string> = new Set(['agents-folder', 'claude-plugin']);
    const routes = new Set((state.connections ?? []).flatMap(connection => TOOL_MATRIX.tools
      .filter(tool => tool.key === connection.tool).map(tool => tool.route)));
    const targets = options.deliveryTargets ?? [...routes].filter(route => pilotRoutes.has(route)).flatMap(route => {
      if (route === 'agents-folder') return [new AgentsFolderDeliveryTarget(paths)] as DeliveryTarget[];
      if (route === 'claude-plugin') return [new ClaudePluginDeliveryTarget({paths, helperId: state.helperId!, runner: options.runner ?? runToolCommand, env: config.env, platform})];
      const definition = TOOL_MATRIX.routes[route];
      return definition?.kind === 'folder' ? [new FolderDeliveryTarget(paths, route, join(paths.home, definition.path.slice(2)))] : [];
    });
    const syncOptions = {paths, helperId: state.helperId, client: tokens, targets, verifier: options.verifier,
      timing, computerName: syncComputerName, tools: state.tools, tokenStorage: state.tokenStorage, watchRoute: options.watchRoute, output};
    const plugin = targets.find((target): target is ClaudePluginDeliveryTarget => target instanceof ClaudePluginDeliveryTarget);
    return plugin ? new ClaudePluginSyncEngine(syncOptions, plugin) : new SyncEngine(syncOptions);
  };
  if (args.command === 'allow') {
    syncComputerName = await computerName(runner, config.env, platform);
    const engine = syncFor(saved);
    await engine.reconcile();
    await runAllow(engine, tokens, {all: args.all, isTTY, output, tools: saved.connections ?? [],
      confirm: options.confirm ?? (async question => {
        const input = createInterface({input: process.stdin, output: process.stdout});
        try {return await input.question(question + ' ');} finally {input.close();}
      })});
    return;
  }
  if (args.command === 'connect') {
    await withWriteLock(paths, async () => {
      const tools = await detect(); let state = await stateStore.read();
      if ((state.status === 'connected' || state.status === 'renew_required') && !isSkillsToken(await secrets.get('skills-token'))) {
        // Explicit connect can recover a lost local credential. A Keychain read
        // failure still propagates, and service polls never silently re-pair.
        await secrets.delete('skills-token'); await secrets.delete('device-key');
        state = { ...state, status: 'unpaired', scopes: [] };
        await stateStore.write(state);
      }
      if (state.status === 'connected' || state.status === 'renew_required') {
        await tokens.refreshStatus();
        if ((await stateStore.read()).status === 'connected') await tokens.proposeTools(tools);
        output((await tokens.status()).message);
      } else {
        const flow = new PairingFlow(api, timing);
        const cancel = () => flow.cancel();
        options.signal?.addEventListener('abort', cancel, { once: true });
        try {
          if (options.signal?.aborted) throw new HelperError('CANCELLED', 'The helper operation was cancelled.');
          await stateStore.write({...await stateStore.read(), tokenStorage: secrets.storage, credentialBackendSelected: true,
            ...(tokenFile ? {tokenFile} : {}),
            ...(secrets instanceof SecretServiceSecretStore ? {secretServiceBinary: secrets.binary} : {})});
          const pending = await flow.start({ helperVersion: VERSION, computerName: await computerName(runner, config.env, platform),
            os: helperOs(platform), tools, credentialStorage: {version: 1, backend: secrets.storage} });
          output(`Code: ${pending.userCode.slice(0, 4)}-${pending.userCode.slice(4)}`);
          output(`Open ${pending.connectUrl} and type the code. Expires at ${pending.expiresAt}.`);
          await tokens.acceptPairing(await flow.wait(), tools);
          output('Connected. Tools require approval on ai.maddots.app.');
        } finally { options.signal?.removeEventListener('abort', cancel); }
      }
      await installService(paths, {runner, env: config.env, platform,
        ...(platform === 'darwin' ? {entrypoint: runtime.bootstrapEntrypoint,
          toolDirectories: tools.flatMap(tool => tool.path ? [dirname(tool.path)] : [])} : {})});
    }, timing);
  } else if (args.command === 'status') {
    await withWriteLock(paths, async () => {
      const state = await stateStore.read();
      if (state.status === 'connected' || state.status === 'renew_required') {
        try { await tokens.refreshStatus(); } catch (error) { if (error instanceof HelperError) output(platform === 'linux' ? error.message : 'The service is unavailable. Saved skills remain on this computer.'); else throw error; }
      }
      const status = await tokens.status();
      output(status.message);
      output(`OS: ${helperOs(platform)}. Token storage: ${secrets.storage}. Skills and backups: ${paths.data}`);
      if (platform === 'linux') {
        try {
          const health = await serviceStatus(paths, {runner, env: config.env, platform, now: timing.now});
          output(`Service: ${health.healthy ? 'healthy' : health.running ? 'running, heartbeat unavailable or stale' : 'not running'}.`);
          if (health.platform === 'linux') output(`systemd: ${health.loadState}/${health.activeState}/${health.subState}; PID ${health.mainPid}. Linger: ${health.linger}${health.linger === 'no' ? ' (required for operation after logout; ask the host administrator)' : ''}.`);
        } catch (error) { output(error instanceof HelperError ? error.message : 'User service health could not be checked.'); }
      }
      if (status.state.pendingTools.length) output(`${status.state.pendingTools.length} tool(s) waiting for approval on ai.maddots.app.`);
      let lockRoutes: string[] = [];
      if (status.state.helperId) {
        try {
          const lock = await new LockStore(paths, status.state.helperId).read();
          lockRoutes = lock.entries.filter(entry => !entry.removed).map(entry => entry.route);
          const links = await discoverManagedLinks({paths, managed: lock.entries.filter(entry => !entry.removed),
            verifier: options.verifier ?? new BuildVerifier(), helperIds: [lock.helperId, ...lock.previousHelperIds ?? []]});
          for (const entry of lock.entries.filter(entry => !entry.removed)) {
            const warning = linkedHomesWarning(entry.name, linkedHomeRefs(links, entry));
            if (warning) output(warning);
          }
        } catch (error) {
          // Status is diagnostic and read-only: report the unreadable lock, never fail on the advisory lookup.
          output(`The skill lock in ${paths.data} could not be read${error instanceof HelperError ? `: ${error.message}` : '.'}`);
        }
      }
      const activeRoutes = [...lockRoutes,
        ...(status.state.connections ?? []).flatMap(connection => TOOL_MATRIX.tools.filter(tool => tool.key === connection.tool).map(tool => tool.route))];
      const warning = await grokDuplicateWarning({paths, tools: status.state.tools, activeRoutes});
      if (warning) output(warning);
      if (status.state.helperId) {
        for (const line of await new ClaudePluginDeliveryTarget({paths, helperId: status.state.helperId, env: config.env, platform}).statusLines()) output(line);
        const holding = syncFor(status.state).holding;
        output(`${await holding.count()} skill(s) with code wait for Allow on this computer.`);
        if (holding.invalid.size) output(`${holding.invalid.size} holding records could not be read and were kept in holding-records/`);
      }
    }, timing);
  } else if (args.command === 'uninstall') {
    await stopRunners();
    await withWriteLock(paths, async () => {
      await removeService(paths, { runner, env: config.env, platform });
      let homesCleaned = false;
      try {
        if (platform === 'linux') {
          // Linux process ownership and recovery arrive in round 2. Preserve any
          // unexpected run homes without invoking Darwin process inspection.
          homesCleaned = await readdir(join(paths.data, 'run-homes')).then(names => names.length === 0,
            (error: NodeJS.ErrnoException) => {if (error.code === 'ENOENT') return true; throw error;});
        } else {
          // The service runs in another process. Its saved authority must be
          // recovered by the runner before uninstall can discard any run home.
          const active = await new RunnerState(paths.data).active();
          const unverified = active.some(row => row.phase !== 'posting' || row.pid > 0 || row.fence || row.pgid || row.processGroups?.length);
          const testsRecovered = await recoverTestRuns({data: paths.data, skipBusy: true});
          if (!unverified && testsRecovered) {
            // A new diagnostic can acquire its own lease after recovery returns.
            // Only that lease's owner may remove a test home, never this sweep.
            await cleanupRunHomes(paths.data, {skipTests: true});
            homesCleaned = await readdir(join(paths.data, 'run-homes')).then(names => names.length === 0,
              (error: NodeJS.ErrnoException) => {if (error.code === 'ENOENT') return true; throw error;});
          }
        }
      } catch { /* Preserve homes whenever process evidence cannot be verified. */ }
      try { await tokens.revoke(); }
      catch { output('The server could not confirm token revocation. Revoke this computer on ai.maddots.app.'); }
      // Local credentials are removed even when the service cannot be reached.
      await tokens.clearCredentials();
      if (credentialCapabilities('keychain', platform).providerKeys) await new KeychainProviderKeyStore(runner, config.env).delete('deepseek');
      if (!homesCleaned) output(`Some run homes were kept for safety in ${join(paths.data, 'run-homes')}. Process cleanup could not be verified, or a diagnostic is still active.`);
      await stateStore.write({ format: 1, endpoint: config.endpoint.href, status: 'unpaired', scopes: [], tools: [], pendingTools: [], tokenStorage: platform === 'darwin' ? 'keychain' : 'file' });
      output(`Skills remain in their tool folders. The lock file and backups remain in ${paths.data}.`);
      output(platform === 'linux' ? 'Run npm uninstall --global --prefix "$HOME/.local" maddots-ai to remove a user-prefix helper package.' : 'Run npm uninstall -g maddots-ai to remove the helper package.');
    }, timing);
  } else if (args.command === 'service') {
    let runs: RunsRuntime | undefined, runsIdentity: string | undefined;
    let grants: unknown;
    let nextAgentNotify = 0;
    let initialDetection = true;
    let nextUpdateCheck = 0;
    let nextPointerCheck = 0;
    let sync: SyncEngine | undefined, syncIdentity: string | undefined;
    let nextConnectionCheck = 0, nextNotifyCheck = 0, syncActive = false;
    let dialog: Promise<void> | undefined;
    let pendingDialog: PendingDialog | undefined;
    const dialogStop = new AbortController();
    const cancelDialog = () => dialogStop.abort();
    options.signal?.addEventListener('abort', cancelDialog, { once: true });
    try { await runService(async () => {
      if (timing.now() >= nextConnectionCheck) {
      nextConnectionCheck = timing.now() + 60_000;
      await withWriteLock(paths, async () => {
        const state = await stateStore.read();
        if (state.status !== 'connected' && state.status !== 'renew_required') return;
        let tools;
        if (initialDetection || !state.lastDetectionAt || timing.now() - Date.parse(state.lastDetectionAt) >= 3_600_000) tools = await detect();
        initialDetection = false;
        try {
          const refreshed = await tokens.refreshStatus(data => {grants = data.runGrants ?? [];});
          if (refreshed.status === 'connected' && tools) await tokens.proposeTools(tools);
          if (refreshed.status === 'connected' && refreshed.helperId && refreshed.scopes.includes('import_upload')) {
            await new ImportEngine({paths, helperId: refreshed.helperId, client: tokens, timing, output}).uploadPending();
          }
        } catch (error) {
          if (!(error instanceof HelperError)) throw error;
          output(error.message);
        }
        // Renewal and outages stop requests, not the service process. Its in-memory
        // retry timer survives between ticks, and saved skills stay untouched.
        await tokens.status();
      }, timing);
      }
      const state = await stateStore.read();
      syncActive = state.status === 'connected' && !!state.helperId;
      try {
      if (runs && (state.status === 'pair_again' || state.status === 'unpaired')) {
        await runs.close(); runs = undefined; runsIdentity = undefined; grants = undefined;
      }
      if (state.status === 'connected' && state.helperId && credentialCapabilities(secrets.storage, platform).runClaims) {
        if (!runs || runsIdentity !== state.helperId) {
          await runs?.close(); runs = await runsFor(state.helperId); runsIdentity = state.helperId;
        }
        try { await runs.init(); }
        catch (error) { output(`Test recovery unavailable this cycle (${runnerErrorCode(error)}).`); }
        if (grants !== undefined) {
          const pendingGrants = grants; grants = undefined;
          try { await runs.activation.syncGrants(pendingGrants); }
          catch (error) { output(`Run activation unavailable this cycle (${runnerErrorCode(error)}).`); }
        }
      }
      } catch (error) { output(`Runs paused this cycle (${runnerErrorCode(error)}).`); }
      try { await tickRunners(); }
      catch (error) { output(`Runs paused this cycle (${runnerErrorCode(error)}).`); }
      if (runs && state.status === 'connected' && timing.now() >= nextAgentNotify) {
        nextAgentNotify = timing.now() + 60_000;
        try {await runs.notifySetup();} catch {output('Agent setup notification is unavailable this cycle.');}
      }
      if (state.status === 'connected' && state.helperId) {
        const identity = JSON.stringify([state.helperId, state.connections, state.tools, state.tokenStorage]);
        if (!sync || syncIdentity !== identity) {
          sync?.close(); syncComputerName = await computerName(runner, config.env, platform);
          sync = syncFor(state); syncIdentity = identity;
        }
        try {
          await sync.tick();
          if (!dialog && timing.now() >= nextNotifyCheck) {
            nextNotifyCheck = timing.now() + 60_000;
            const pending = await withWriteLock(paths, async () => reserveWaitingDialog(paths, await sync!.holding.waiting(),
              {runner: notificationRunner, timing, env: config.env, entrypoint: runtime.bootstrapEntrypoint, platform, output}), timing);
            if (typeof pending === 'object') {
              pendingDialog = pending;
              dialog = showWaitingDialog(pending, {runner: notificationRunner, env: config.env, signal: dialogStop.signal, platform, output})
                .then(() => undefined, error => {
                  if (!dialogStop.signal.aborted) output(error instanceof HelperError ? error.message : 'The Allow dialog failed.');
                })
                .finally(() => { dialog = undefined; if (!dialogStop.signal.aborted) pendingDialog = undefined; });
            }
          }
        } catch (error) {
          if (!(error instanceof HelperError)) throw error;
          output(error.message);
        }
      }
      if (platform === 'linux') await writeServiceHeartbeat(paths, {now: timing.now});
      if (options.signal?.aborted || fixedRuntime || (!RELEASE_IDENTITY && !options.updates)) return;
      // Checking the pointer every minute also picks up a manual
      // update or rollback. Exiting with a failure status asks the user service manager to restart
      // the stable bootstrap without killing a sync that is still applying.
      if (timing.now() >= nextPointerCheck) {
        nextPointerCheck = timing.now() + 60_000;
        const selected = await (options.updates?.select ?? selectRelease)(updateOptions);
        if (selected.root !== runtime.runningRoot && !runnerBusy() && !runs?.activation.busy) {
          throw new HelperError('UPDATE_RESTART', 'Restarting into the selected verified helper after sync completed.');
        }
      }
      if (config.env.MADDOTS_AI_AUTO_UPDATE !== '0' && timing.now() >= nextUpdateCheck) {
        nextUpdateCheck = timing.now() + UPDATE_CHECK_INTERVAL_MS;
        const result = await (options.updates?.check ?? checkForUpdate)(updateOptions);
        if (result.status === 'prepared' && !runnerBusy() && !runs?.activation.busy) {
          throw new HelperError('UPDATE_RESTART', 'Restarting into the verified helper update after sync completed.');
        }
      }
    }, { signal: options.signal, sleep: timing.sleep, intervalMs: () => syncActive ? 1000 : 60_000 });
    } finally {
      await runs?.close();
      await stopRunners();
      options.signal?.removeEventListener('abort', cancelDialog);
      dialogStop.abort();
      try { sync?.close(); }
      finally {
        const interrupted = pendingDialog;
        if (interrupted) await withWriteLock(paths, () => interruptWaitingDialog(paths, interrupted), timing);
      }
    }
  }
}

/** Called only by the dependency-free CLI facade after installation preflight. */
export function runEntrypoint(): void {
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort()); process.once('SIGTERM', () => stop.abort());
  launchCli(process.argv.slice(2), runCli, { signal: stop.signal }).catch(error => {
    process.stderr.write((error instanceof HelperError || error instanceof SystemRuntimeError ? error.message : 'The helper operation failed.') + '\n');
    process.exitCode = 1;
  });
}
