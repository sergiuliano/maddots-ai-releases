#!/usr/bin/env node
import { hostname } from 'node:os';
import { realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { ApiClient, isSkillsToken } from './api.js';
import { listBackups, restoreBackup } from './backups.js';
import { HelperError, cleanEnvironment, clock, readConfig, runCommand, type Runner, type Timing } from './config.js';
import { detectTools } from './detect.js';
import { describeUnmanaged, ImportEngine } from './imports.js';
import { grokDuplicateWarning } from './duplicates.js';
import { TOOL_MATRIX } from './shared/tool-matrix.js';
import { LockStore } from './lock.js';
import { ClaudePluginDeliveryTarget } from './delivery/claude-plugin.js';
import { AgentsFolderDeliveryTarget } from './delivery/agents-folder.js';
import { PairingFlow, helperOs } from './pairing.js';
import { createPaths, ensurePaths, withWriteLock } from './paths.js';
import { RELEASE_IDENTITY, VERSION } from './release-identity.js';
import { bundledRuntime, launchCli, type RuntimeContext } from './runtime.js';
import { FILE_STORAGE_WARNING, FileSecretStore, KeychainSecretStore, type SecretStore } from './secret-store.js';
import { installService, removeService, runService } from './service.js';
import { StateStore } from './state.js';
import { TokenManager } from './token.js';
import { checkForUpdate, rollbackRelease, selectRelease, UPDATE_CHECK_INTERVAL_MS, type UpdateOptions, type UpdateResult } from './updater.js';
import { runAllow } from './allow.js';
import { FolderDeliveryTarget, type DeliveryTarget } from './delivery/index.js';
import { interruptWaitingDialog, reserveWaitingDialog, showWaitingDialog, type PendingDialog } from './notify.js';
import { SyncEngine, type SyncOptions } from './sync.js';
import { BuildVerifier } from './verify.js';
import type { HelperState } from './state.js';

export type CliOptions = {
  env?: NodeJS.ProcessEnv; home?: string; runner?: Runner; request?: typeof fetch; timing?: Timing;
  output?: (line: string) => void; confirm?: (warning: string) => Promise<string>; signal?: AbortSignal;
  runtime?: RuntimeContext;
  isTTY?: boolean; deliveryTargets?: readonly DeliveryTarget[]; verifier?: BuildVerifier; watchRoute?: SyncOptions['watchRoute'];
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
function argumentsFor(argv: string[]): { command: string; tokenFile?: string; restoreId?: string; rollback: boolean; all?: boolean } {
  const commands = ['connect', 'status', 'allow', 'backups', 'import', 'uninstall', 'update', 'service'];
  const command = argv[0] ?? 'help';
  if (['help', '--help', '-h', '--version', '--self-test'].includes(command)) {
    if (argv.length > 1) throw new HelperError('USAGE', 'Unexpected command arguments.');
    return { command, rollback: false };
  }
  if (!commands.includes(command)) throw new HelperError('USAGE', 'Unknown helper command. Run maddots-ai --help.');
  let tokenFile: string | undefined, restoreId: string | undefined, rollback = false, all = false;
  for (let index = 1; index < argv.length; index++) {
    if (argv[index] === '--token-file' && !tokenFile && argv[index + 1] && !argv[index + 1].startsWith('-')) tokenFile = argv[++index];
    else if (argv[index] === '--rollback' && command === 'update' && !rollback) rollback = true;
    else if (argv[index] === '--all' && command === 'allow' && !all) all = true;
    else if (command === 'backups' && argv[index] === 'restore' && index === 1 && argv[index + 1] && /^[A-Za-z0-9_-]+$/.test(argv[index + 1]) && index + 2 === argv.length) restoreId = argv[++index];
    else throw new HelperError('USAGE', 'Unexpected command arguments. Run maddots-ai --help.');
  }
  return { command, tokenFile, restoreId, rollback, all };
}
export async function computerName(runner: Runner = runCommand, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  let name = hostname();
  try { name = (await runner('/usr/sbin/scutil', ['--get', 'LocalHostName'], { env: cleanEnvironment(env) })).stdout.trim() || name; } catch { /* Hostname is the documented fallback. */ }
  return name.replace(/[^A-Za-z0-9 ._-]/g, '-').slice(0, 64) || 'Computer';
}
export async function runCli(argv: string[], options: CliOptions = {}): Promise<void> {
  const args = argumentsFor(argv), output = options.output ?? (line => process.stdout.write(line + '\n'));
  if (args.command === '--version') { output(VERSION); return; }
  // Importing this module loads and validates the matrix and runtime modules.
  // Candidate validation must never read credentials or pair with the server.
  if (args.command === '--self-test') return;
  if (['help', '--help', '-h'].includes(args.command)) {
    output('maddots-ai connect | status | allow [--all] | backups [restore <id>] | import | uninstall | update [--rollback] | service | --version'); return;
  }
  const isTTY = options.isTTY ?? !!(process.stdin.isTTY && process.stdout.isTTY);
  if (args.command === 'allow' && !isTTY) throw new HelperError('ALLOW_TTY_REQUIRED', 'Allow requires an interactive terminal on this computer.');
  if (args.command === 'update' && !RELEASE_IDENTITY && !options.updates) {
    throw new HelperError('RELEASE_UNCONFIGURED', 'The source helper has no pinned release channel. Export it with the approved release identity first.');
  }
  if (args.tokenFile && !isAbsolute(args.tokenFile)) throw new HelperError('FILE_UNSAFE', 'The token file flag must name an absolute path.');
  const config = readConfig(options.env, options.home), paths = await createPaths(config);
  await ensurePaths(paths);
  const timing = options.timing ?? clock;
  if (args.command === 'backups') {
    if (args.tokenFile) throw new HelperError('USAGE', 'The backups command does not take a token file.');
    await withWriteLock(paths, async () => {
      if (args.restoreId) {
        const backup = await restoreBackup(paths, args.restoreId);
        output(`Restored ${backup.originalPath}. Any current local copy was preserved in a new backup.`);
      } else {
        const backups = await listBackups(paths);
        for (const backup of backups) output(`${backup.id}  ${backup.originalPath}  ${backup.reason}`);
        if (!backups.length) output('No backups.');
      }
    }, timing);
    return;
  }
  const runtime = options.runtime ?? await bundledRuntime();
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
  if (args.tokenFile && saved.tokenStorage === 'file' && saved.tokenFile && resolve(args.tokenFile) !== saved.tokenFile) {
    throw new HelperError('FILE_UNSAFE', 'Use the token file already paired on this computer, or uninstall before changing it.');
  }
  if (args.tokenFile && saved.status === 'connected' && saved.tokenStorage === 'keychain') {
    throw new HelperError('FILE_UNSAFE', 'Uninstall before switching an existing connection to token file storage.');
  }
  let secrets: SecretStore;
  const tokenFile = args.tokenFile ?? (saved.tokenStorage === 'file' ? saved.tokenFile : undefined);
  if (tokenFile) {
    const previouslyConfirmed = saved.tokenStorage === 'file' && saved.tokenFile === resolve(tokenFile);
    let confirmed = previouslyConfirmed;
    if (!confirmed) {
      output(FILE_STORAGE_WARNING);
      confirmed = (await (options.confirm ?? prompt)(FILE_STORAGE_WARNING)).trim() === 'I understand';
    }
    secrets = await FileSecretStore.open(resolve(tokenFile), paths, { explicit: Boolean(args.tokenFile) || previouslyConfirmed, confirmed, scopes: saved.scopes });
  } else secrets = new KeychainSecretStore(config.endpoint, paths.data, runner, config.env);
  const api = new ApiClient(config.endpoint, options.request);
  const tokens = new TokenManager(api, secrets, stateStore, timing, async message => {
    output(message);
    // Supply dialog text as an argument to a fixed script, never AppleScript source.
    await runner('/usr/bin/osascript', ['-e', 'on run argv\ndisplay dialog (item 1 of argv) buttons {"OK"} default button "OK"\nend run', message], { env: cleanEnvironment(config.env) });
  });
  if (args.command === 'import') {
    if (!saved.helperId || saved.status !== 'connected' || !saved.scopes.includes('import_upload')) {
      throw new HelperError('TOKEN_REQUIRED', 'Connect this computer before importing the folders selected on ai.maddots.app.');
    }
    await withWriteLock(paths, async () => {
      for (const line of await describeUnmanaged(paths, saved.helperId!)) output(line);
      const receipts = await new ImportEngine({paths, helperId: saved.helperId!, client: tokens, timing}).uploadPending();
      for (const receipt of receipts) output(`Import ${receipt.sessionId}: ${receipt.state}.`);
      if (!receipts.length) output('Choose From my AI tool on ai.maddots.app and tick the folders to import.');
    }, timing);
    return;
  }
  const detect = () => detectTools({ home: paths.home, env: config.env, runner });
  let syncComputerName = 'Computer';
  const syncFor = (state: HelperState): SyncEngine => {
    if (!state.helperId) throw new HelperError('TOKEN_REQUIRED', 'Run maddots-ai connect to connect this computer.');
    // Pilot delivery only. Later route cards register their own adapters.
    const pilotRoutes: ReadonlySet<string> = new Set(['agents-folder']);
    const routes = new Set((state.connections ?? []).flatMap(connection => TOOL_MATRIX.tools
      .filter(tool => tool.key === connection.tool).map(tool => tool.route)));
    // Release 8 merge: the shared folder uses TLS-15's adapter. TLS-16's Claude Code plugin needs its
    // ClaudePluginSyncEngine and is wired by the pilot service card (FOLLOWUPS 44).
    const targets = options.deliveryTargets ?? [...routes].filter(route => pilotRoutes.has(route)).flatMap(route => {
      if (route === 'agents-folder') return [new AgentsFolderDeliveryTarget(paths)];
      const definition = TOOL_MATRIX.routes[route];
      return definition?.kind === 'folder' ? [new FolderDeliveryTarget(paths, route, join(paths.home, definition.path.slice(2)))] : [];
    });
    return new SyncEngine({paths, helperId: state.helperId, client: tokens, targets, verifier: options.verifier,
      timing, computerName: syncComputerName, tools: state.tools, tokenStorage: state.tokenStorage, watchRoute: options.watchRoute});
  };
  if (args.command === 'allow') {
    syncComputerName = await computerName(runner, config.env);
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
          const pending = await flow.start({ helperVersion: VERSION, computerName: await computerName(runner, config.env), os: helperOs(), tools });
          output(`Code: ${pending.userCode.slice(0, 4)}-${pending.userCode.slice(4)}`);
          output(`Open ${pending.connectUrl} and type the code. Expires at ${pending.expiresAt}.`);
          if (tokenFile) await stateStore.write({ ...await stateStore.read(), tokenStorage: 'file', tokenFile: resolve(tokenFile) });
          await tokens.acceptPairing(await flow.wait(), tools);
          output('Connected. Tools require approval on ai.maddots.app.');
        } finally { options.signal?.removeEventListener('abort', cancel); }
      }
      await installService(paths, { runner, env: config.env, entrypoint: runtime.bootstrapEntrypoint });
    }, timing);
  } else if (args.command === 'status') {
    await withWriteLock(paths, async () => {
      const state = await stateStore.read();
      if (state.status === 'connected' || state.status === 'renew_required') {
        try { await tokens.refreshStatus(); } catch (error) { if (error instanceof HelperError) output('The service is unavailable. Saved skills remain on this computer.'); else throw error; }
      }
      const status = await tokens.status();
      output(status.message);
      output(`Token storage: ${status.state.tokenStorage}. Skills and backups: ${paths.data}`);
      if (status.state.pendingTools.length) output(`${status.state.pendingTools.length} tool(s) waiting for approval on ai.maddots.app.`);
      let lockRoutes: string[] = [];
      if (status.state.helperId) {
        try {
          const lock = await new LockStore(paths, status.state.helperId).read();
          lockRoutes = lock.entries.filter(entry => !entry.removed).map(entry => entry.route);
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
        for (const line of await new ClaudePluginDeliveryTarget({paths, helperId: status.state.helperId, env: config.env}).statusLines()) output(line);
        const holding = syncFor(status.state).holding;
        output(`${await holding.count()} skill(s) with code wait for Allow on this computer.`);
        if (holding.invalid.size) output(`${holding.invalid.size} holding records could not be read and were kept in holding-records/`);
      }
    }, timing);
  } else if (args.command === 'uninstall') {
    await withWriteLock(paths, async () => {
      await removeService(paths, { runner, env: config.env });
      try { await tokens.revoke(); }
      catch { output('The server could not confirm token revocation. Revoke this computer on ai.maddots.app.'); }
      // Local credentials are removed even when the service cannot be reached.
      await tokens.clearCredentials();
      await stateStore.write({ format: 1, endpoint: config.endpoint.href, status: 'unpaired', scopes: [], tools: [], pendingTools: [], tokenStorage: 'keychain' });
      output(`Skills remain in their tool folders. The lock file and backups remain in ${paths.data}.`);
      output('Run npm uninstall -g maddots-ai to remove the helper package.');
    }, timing);
  } else if (args.command === 'service') {
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
          const refreshed = await tokens.refreshStatus();
          if (refreshed.status === 'connected' && tools) await tokens.proposeTools(tools);
          if (refreshed.status === 'connected' && refreshed.helperId && refreshed.scopes.includes('import_upload')) {
            await new ImportEngine({paths, helperId: refreshed.helperId, client: tokens, timing}).uploadPending();
          }
        } catch (error) {
          if (!(error instanceof HelperError)) throw error;
          output(error.message);
        }
        // Renewal and outages stop requests, not the launchd process. Its in-memory
        // retry timer survives between ticks, and saved skills stay untouched.
        await tokens.status();
      }, timing);
      }
      const state = await stateStore.read();
      syncActive = state.status === 'connected' && !!state.helperId;
      if (state.status === 'connected' && state.helperId) {
        const identity = JSON.stringify([state.helperId, state.connections, state.tools, state.tokenStorage]);
        if (!sync || syncIdentity !== identity) {
          sync?.close(); syncComputerName = await computerName(runner, config.env);
          sync = syncFor(state); syncIdentity = identity;
        }
        try {
          await sync.tick();
          if (!dialog && timing.now() >= nextNotifyCheck) {
            nextNotifyCheck = timing.now() + 60_000;
            const pending = await withWriteLock(paths, async () => reserveWaitingDialog(paths, await sync!.holding.waiting(),
              {runner, timing, env: config.env, entrypoint: runtime.bootstrapEntrypoint}), timing);
            if (typeof pending === 'object') {
              pendingDialog = pending;
              dialog = showWaitingDialog(pending, {runner, env: config.env, signal: dialogStop.signal})
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
      if (options.signal?.aborted || (!RELEASE_IDENTITY && !options.updates)) return;
      // Checking the pointer every minute also picks up a manual
      // update or rollback. Exiting with a failure status asks launchd to restart
      // the stable bootstrap without killing a sync that is still applying.
      if (timing.now() >= nextPointerCheck) {
        nextPointerCheck = timing.now() + 60_000;
        const selected = await (options.updates?.select ?? selectRelease)(updateOptions);
        if (selected.root !== runtime.runningRoot) {
          throw new HelperError('UPDATE_RESTART', 'Restarting into the selected verified helper after sync completed.');
        }
      }
      if (config.env.MADDOTS_AI_AUTO_UPDATE !== '0' && timing.now() >= nextUpdateCheck) {
        nextUpdateCheck = timing.now() + UPDATE_CHECK_INTERVAL_MS;
        const result = await (options.updates?.check ?? checkForUpdate)(updateOptions);
        if (result.status === 'prepared') {
          throw new HelperError('UPDATE_RESTART', 'Restarting into the verified helper update after sync completed.');
        }
      }
    }, { signal: options.signal, sleep: timing.sleep, intervalMs: () => syncActive ? 1000 : 60_000 });
    } finally {
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

function isEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
}
if (isEntrypoint()) {
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort()); process.once('SIGTERM', () => stop.abort());
  launchCli(process.argv.slice(2), runCli, { signal: stop.signal }).catch(error => {
    process.stderr.write((error instanceof HelperError ? error.message : 'The helper operation failed.') + '\n');
    process.exitCode = 1;
  });
}
