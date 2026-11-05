import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash, randomUUID} from 'node:crypto';
import {isAbsolute, resolve} from 'node:path';
import {StringDecoder} from 'node:string_decoder';
import {CommandError, HelperError, readConfig} from '../config.js';
import {assertToolCommandAllowed, currentClaimedToolOperation, type ToolCommandOptions} from '../tool-command.js';
import {beforeDeadline, PROCESS_CLEANUP_CAP_MS, ProcessCleanupError, type LinuxToolLifecycle, type LinuxToolLaunchRequest} from './process.js';
import {cleanLinuxToolEnvironment, type LinuxContainedRun, type LinuxRecoveredRun, type LinuxContainmentBackend, type LinuxContainmentRequest} from './linux-containment.js';
import {LinuxSelectedLogin} from './linux-selected-login.js';
import {selectedLoginError, selectedLoginFailure} from './linux-login-provider.js';
import {revalidateLinuxLocalProvider, type LinuxLocalProviderSpec} from './linux-local-provider.js';
import type {JournalToken} from './journal.js';
import {acquireStorageOwner, RunnerStorageError, type RunnerStorageOwner, type RunnerCleanupDiagnosticPhase} from './storage-owner.js';
import {RunnerState} from './state.js';
import {LinuxWorkspace} from './linux-workspace.js';
import {acceptanceOperationBudget, acceptanceOperationIdentity, acceptanceOperationWorkloadBudget, invalidateAcceptanceOperation,
  refreshAcceptanceOperation, type LinuxAcceptanceOperation} from './linux-authorization.js';

const contexts = new AsyncLocalStorage<{owner: RunnerStorageOwner; generation: number}>();
const wait = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const refused = () => new HelperError('LINUX_CONTAINMENT_UNAVAILABLE', 'Linux run containment is not available.');
const TERM_GRACE = 5000;

export function withLinuxOwnerContext<T>(owner: RunnerStorageOwner, generation: number, action: () => Promise<T>): Promise<T> {
  owner.assertGeneration(generation);
  return contexts.run({owner, generation}, action);
}

/** Diagnostic/activation/utility callers use the same exclusive owner and
 * journal as claimed runs. The action must await its tool's final cleanup. */
export async function withLinuxRunContext<T>(data: string, action: () => Promise<T>): Promise<T> {
  if (process.platform !== 'linux') return action();
  const current = contexts.getStore();
  if (current) {
    if (resolve(data) !== resolve(current.owner.state.data)) throw new RunnerStorageError();
    current.owner.assertGeneration(current.generation);
    return action();
  }
  const acquisition = await acquireStorageOwner(data, new RunnerState(data));
  let generation: number | undefined;
  try {
    const owner = acquisition.owner;
    generation = acquisition.attach();
    await owner.replayJournal(generation);
    if (!owner.stateLoaded) {
      await owner.operation(generation, state => state.init(), true);
      const rows = await owner.operation(generation, state => state.active());
      for (const row of rows) {
        if (row.phase !== 'posting' || row.pid > 0 || row.pgid || row.processGroups?.length || row.legacyProcessIdentity) {
          owner.unrecovered.set(row.runId, row);
        } else owner.active.set(row.runId, row);
      }
      owner.stateLoaded = true;
    }
    if (owner.unrecovered.size || owner.admissionBlocked) throw new RunnerStorageError();
    owner.initialized = true;
    return await withLinuxOwnerContext(owner, generation, action);
  } finally {
    if (generation === undefined) await acquisition.release();
    else await acquisition.owner.detach(generation);
  }
}

export function currentLinuxRunIsRetired(runId: string): boolean {
  const current = contexts.getStore();
  if (!current) return false;
  try {current.owner.assertGeneration(current.generation); return current.owner.isRunRetired(runId);} catch {return false;}
}
export function currentLinuxToolLifecycle(runId: string, operation?: LinuxAcceptanceOperation): LinuxToolLifecycle {
  const current = contexts.getStore();
  if (!current) throw refused();
  return createLinuxToolLifecycle(current.owner, current.generation, runId, operation);
}

/** All permission checks precede exactly one native action without yielding.
 * Storage timeout revokes admission, while the existing endpoint can still
 * terminate its run and retain unresolved journal responsibility. */
export function createLinuxToolLifecycle(owner: RunnerStorageOwner, generation: number, runId: string,
  operation?: LinuxAcceptanceOperation): LinuxToolLifecycle {
  const incarnation = randomUUID();
  let token: JournalToken | undefined, run: LinuxRecoveredRun | undefined;
  let preparedLogin: LinuxSelectedLogin | undefined, backend: LinuxContainmentBackend | undefined;
  let localProvider: LinuxLocalProviderSpec | undefined;
  let intentAttempted = false, releasePreparation: (() => void) | undefined;
  let prepared = false, sealed = false, started = false;
  let workloadDeadline = 0, startDeadline = 0, startNotAfter = 0n, releaseBinding = '';
  let signal: AbortSignal | undefined, launchPending = false;
  let cleanup: Promise<void> | undefined, workspace: LinuxWorkspace | undefined;
  let physicalPreparation: Promise<LinuxContainedRun> | undefined, physicalSettled = false;
  const seal = () => {
    if (!started) invalidateAcceptanceOperation(operation);
    sealed = true; run?.seal();
    try {if (token) owner.sealJournalAdmission(generation, token);} catch { /* Cleanup authority is retained. */ }
  };
  const abort = () => {invalidateAcceptanceOperation(operation); seal();};
  const current = () => {
    owner.assertGeneration(generation);
    if (sealed || signal?.aborted) throw new ProcessCleanupError();
  };
  const admissionCurrent = () => {
    current();
    if (Date.now() >= startDeadline || process.hrtime.bigint() >= startNotAfter) throw new ProcessCleanupError();
  };
  const admissionDeadline = () => {
    admissionCurrent();
    // Bound every new asynchronous wait by the original monotonic budget even
    // when the host clock rolls back between durable transitions.
    return Date.now() + Math.min(startDeadline - Date.now(), Number(startNotAfter - process.hrtime.bigint()) / 1e6);
  };
  const retire = (value: LinuxRecoveredRun, deadline: number, publish: boolean): Promise<void> => {
    if (value !== run || !token) return Promise.reject(new ProcessCleanupError());
    seal();
    signal?.removeEventListener('abort', abort);
    // Seal in the journal synchronously even if its writer is stalled.
    try {owner.sealJournalAdmission(generation, token);} catch { /* Physical cleanup remains authorized. */ }
    return cleanup ??= (async () => {
      let phase: RunnerCleanupDiagnosticPhase = 'stopping';
      const at = (next: RunnerCleanupDiagnosticPhase) => {phase = next; owner.setCleanupDiagnostic(runId, phase);};
      at(phase);
      const stopping = token!.stage === 'LAUNCH_ALLOWED' ? owner.journalOperation(generation,
        journal => journal.stopping(token!), deadline).then(next => {token = next;}) : undefined;
      void stopping?.catch(() => {});
      let publicationOwnsWorkspace = false;
      try {
        // A lost/denied guardian channel does not authorize a numeric
        // fallback and does not disable the registered cgroup endpoint.
        at('term');
        await beforeDeadline(Math.min(deadline, Date.now() + 1000), () => value.term()).catch(() => {});
        const graceEnds = Math.min(deadline, Date.now() + TERM_GRACE);
        at('grace');
        while (Date.now() < graceEnds) {
          // Observation failure cannot disable the already retained kill
          // endpoint. Bound an individual read so it cannot consume the
          // entire cleanup budget before the kill is even attempted.
          try {
            if (await beforeDeadline(Math.min(graceEnds, Date.now() + 1000), () => value.empty())) break;
          } catch {break;}
          await wait(Math.min(25, Math.max(1, graceEnds - Date.now())));
        }
        at('kill');
        await beforeDeadline(deadline, () => value.forceKill());
        at('verify-empty');
        while (!await beforeDeadline(deadline, () => value.empty())) await beforeDeadline(deadline, () => wait(25));
        at('completion-proof');
        const proof = await beforeDeadline(deadline, () => value.completionProof());
        at('journal-clean');
        if (stopping) await beforeDeadline(deadline, () => stopping);
        token = await owner.journalOperation(generation, journal => token!.stage === 'STOPPING' ? journal.clean(token!, proof) :
          journal.retireSealed(token!, value.registration, proof), deadline);
        const clean = () => owner.isRunRetired(runId);
        publicationOwnsWorkspace = true;
        at('publication');
        await owner.operation(generation, async () => {
          try {
            await value.retire(clean);
            // Publication scans each retained artifact after extinction. The
            // selected-login workspace withholds anything it cannot fully scan,
            // including copies cut short by TERM/KILL or the workload deadline.
            if (publish) {await workspace!.removePrivateHome(clean); await workspace!.publish(clean);}
          } finally {await workspace?.close();}
        }, true, deadline);
        owner.clearCleanupDiagnostic(runId);
      } catch (error) {
        owner.setCleanupDiagnostic(runId, phase, true);
        throw (owner.isRunRetired(runId) ? selectedLoginFailure(error) : undefined) ?? new ProcessCleanupError();
      }
      finally {if (!publicationOwnsWorkspace) await workspace?.close();}
    })();
  };
  const lifecycle: LinuxToolLifecycle = {
    async prepare(request: LinuxToolLaunchRequest) {
      current(); if (prepared) throw new ProcessCleanupError(); prepared = true;
      request = {...request, argv: [...request.argv], env: {...request.env},
        ...(request.credentials ? {credentials: {...request.credentials}} : {})};
      workloadDeadline = request.deadline;
      if (operation && request.acceptanceOperation && operation !== request.acceptanceOperation) throw refused();
      operation ??= request.acceptanceOperation;
      signal = request.signal;
      const wall = Date.now(), monotonic = process.hrtime.bigint();
      const budget = Math.min(request.deadline - wall, PROCESS_CLEANUP_CAP_MS, operation ? acceptanceOperationBudget(operation) : Infinity);
      if (!Number.isFinite(budget) || budget <= 0) {seal(); throw new ProcessCleanupError();}
      const deadline = startDeadline = wall + budget;
      startNotAfter = monotonic + BigInt(Math.floor(budget * 1e6));
      signal?.addEventListener('abort', abort, {once: true});
      try {
        admissionCurrent();
        if (request.selectedLogin !== undefined && !['codex', 'claude'].includes(request.selectedLogin)) throw refused();
        const selectedLogin = request.selectedLogin ? Object.freeze({
          tool: request.selectedLogin,
          profilePath: process.env[request.selectedLogin === 'codex' ? 'MDAI_CODEX_LOGIN_PROFILE' : 'MDAI_CLAUDE_LOGIN_PROFILE'] ?? '',
        }) : undefined;
        localProvider = request.localProvider;
        if (localProvider) {
          if (selectedLogin || request.operationProfile !== 'workload' || request.credentials || request.runHome) throw refused();
          await beforeDeadline(admissionDeadline(), () => revalidateLinuxLocalProvider(localProvider!, {signal, deadline: admissionDeadline()}));
          admissionCurrent();
        }
        releaseBinding = createHash('sha256').update(JSON.stringify({version: 1, localRunId: runId, incarnation,
          ownerGeneration: generation, operation: operation ? acceptanceOperationIdentity(operation) : null,
          profile: request.operationProfile ?? 'workload', argv: request.argv, cwd: request.cwd,
          workspace: request.workspace ?? request.cwd, selectedLogin: selectedLogin ?? null,
          localProvider: localProvider ?? null})).digest('hex');
        // Reject unsupported input before publishing an obligation or reserving
        // a containment object. Keep a validated snapshot across preparation.
        const env = cleanLinuxToolEnvironment(request.env, '/work');
        if (selectedLogin && !isAbsolute(selectedLogin.profilePath)) throw selectedLoginError();
        if (selectedLogin && (request.operationProfile !== 'workload' || request.runHome || request.credentials ||
            env[selectedLogin.tool === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] !== `/work/.mdai-home/${selectedLogin.tool}`)) throw refused();
        // Validate provisioning without executing any workload. No silent
        // manifest initialization or unsandboxed fallback exists.
        backend = await beforeDeadline(admissionDeadline(), () => owner.getLinuxContainment(generation));
        await beforeDeadline(admissionDeadline(), async () => {await backend!.qualifyAdmission?.();});
        admissionCurrent();
        if (selectedLogin) {
          const opening = LinuxSelectedLogin.open(selectedLogin, {deadline: Math.floor(workloadDeadline), lockDeadline: admissionDeadline()});
          // A caller timeout cannot close a lease while the physical open still
          // owns it. Late validation releases its lease without publishing INTENT.
          void opening.then(value => {if (sealed) void value.close().catch(() => {});}, () => {});
          preparedLogin = await beforeDeadline(admissionDeadline(), () => opening);
          admissionCurrent();
        }
        workspace = new LinuxWorkspace(request.workspace ?? request.cwd, owner.state.data, request.argv[0], request.runHome,
          selectedLogin ? content => {
            if (!run?.assertPublicContent) throw refused();
            run.assertPublicContent(content);
          } : undefined, selectedLogin ? [selectedLogin.profilePath] : []);
        const native: LinuxContainmentRequest = {incarnation, releaseBinding, file: request.argv[0], args: request.argv.slice(1),
          cwd: '/work', env, credentials: request.credentials, selectedLogin, preparedLogin, provider: localProvider,
          onReserved: async retained => {
            run = retained;
            admissionCurrent();
            intentAttempted = true;
            token = await owner.journalOperation(generation, journal => journal.intent({runId, incarnation}), admissionDeadline());
            admissionCurrent();
          },
          admitLauncher: () => !sealed && !signal?.aborted && Date.now() < deadline && process.hrtime.bigint() < startNotAfter &&
            !!token && owner.consumeJournalPermission(generation, token, 'launcher'),
          prepareWork: async work => {
            current(); await workspace!.stage(work); current();
            native.file = workspace!.hostExecutable();
            native.args = request.argv.slice(1).map(argument => workspace!.map(argument));
            native.cwd = workspace!.map(request.cwd);
            native.env = Object.fromEntries(Object.entries(env).map(([key, value]) => [key, workspace!.map(value)]));
          }};
        releasePreparation = owner.retainPreparation(generation);
        const preparing = physicalPreparation = backend.reserve(native);
        void preparing.then(value => {
          run = value; physicalSettled = true;
          // The backend checks admitLauncher after its last asynchronous
          // preparation. A late already-created handle still gets sealed.
          if (sealed) {value.seal(); void value.forceKill().catch(() => {});}
        }, () => {physicalSettled = true;});
        const contained = await beforeDeadline(admissionDeadline(), () => preparing);
        run = contained; admissionCurrent(); releasePreparation(); return contained;
      } catch (error) {
        seal();
        signal?.removeEventListener('abort', abort);
        if (run) void run.forceKill().catch(() => {});
        try {if (token) owner.sealJournalAdmission(generation, token);} catch { /* Keep the unresolved durable intent. */ }
        // Wait for physical preparation before proving extinction. A timed-out
        // spawn may still be using descriptors or returning its live endpoint.
        const failedPreparation = async () => {
          await physicalPreparation?.catch(() => {});
          try {
            if (token && run) await retire(run, Date.now() + PROCESS_CLEANUP_CAP_MS, false);
            else if (run && !intentAttempted) {
              if (!backend?.discardUnlaunched) throw new ProcessCleanupError();
              await backend.discardUnlaunched(run);
            }
          } finally {
            try {await workspace?.close();}
            finally {try {await preparedLogin?.close();} finally {releasePreparation?.();}}
          }
        };
        const finishing = failedPreparation();
        void finishing.catch(() => {});
        if (!physicalPreparation || physicalSettled) {
          try {await beforeDeadline(Date.now() + PROCESS_CLEANUP_CAP_MS, () => finishing);}
          catch {throw new ProcessCleanupError();}
        }
        throw selectedLoginFailure(error) ?? (token && !owner.isRunRetired(runId) ? new ProcessCleanupError() : error);
      }
    },
    async launch(value, assertLaunchAllowed) {
      current(); if (value !== run || !token || started || launchPending) throw new ProcessCleanupError();
      launchPending = true;
      let disposeExecWait: (() => void) | undefined;
      try {
        admissionCurrent();
        await beforeDeadline(admissionDeadline(), () => value.ready);
        admissionCurrent();
        token = await owner.journalOperation(generation, journal => journal.bind(token!, value.registration), admissionDeadline());
        admissionCurrent();
        token = await owner.journalOperation(generation, journal => journal.allow(token!), admissionDeadline());
        admissionCurrent();
        if (localProvider) {
          await beforeDeadline(admissionDeadline(), () => revalidateLinuxLocalProvider(localProvider!, {signal, deadline: admissionDeadline()}));
          admissionCurrent();
        }
        // Server authorization linearizes in this fresh signed reply, after all
        // durable admission writes. A late reply cannot resume this continuation.
        const authorization = operation ? await beforeDeadline(admissionDeadline(), () => refreshAcceptanceOperation(operation!)) : undefined;
        admissionCurrent();
        const checkedAt = process.hrtime.bigint();
        const remaining = Math.min(workloadDeadline - Date.now(), startDeadline - Date.now(),
          operation ? acceptanceOperationBudget(operation, authorization) : Infinity);
        if (!Number.isFinite(remaining) || remaining <= 0) throw new ProcessCleanupError();
        const refreshedBound = checkedAt + BigInt(Math.floor(remaining * 1e6));
        startNotAfter = refreshedBound < startNotAfter ? refreshedBound : startNotAfter;
        const release = Object.freeze({binding: releaseBinding, incarnation,
          notAfterMonotonicNs: startNotAfter.toString()});
        // Readiness is not exec proof. Subscribe before START so a fast exec or
        // terminal monitor event cannot be lost, and keep the original budget.
        const executed = localProvider ? new Promise<void>((resolve, reject) => {
          let providerReady = false, toolExecuted = false;
          const message = (event: unknown) => {
            const type = (event as {type?: string} | null)?.type;
            if (type === 'tool-start') toolExecuted = true;
            else if (type === 'provider-ready') providerReady = true;
            else if (type === 'tool-error' || type === 'exec-error' || type === 'tool-exit') reject(new ProcessCleanupError());
            if (providerReady && toolExecuted) resolve();
          };
          const failed = () => reject(new ProcessCleanupError());
          value.child.on('message', message); value.child.once('exit', failed); value.child.once('error', failed);
          signal?.addEventListener('abort', failed, {once: true});
          disposeExecWait = () => {
            value.child.off('message', message); value.child.off('exit', failed); value.child.off('error', failed);
            signal?.removeEventListener('abort', failed);
          };
        }) : undefined;
        void executed?.catch(() => {});
        // Stop/abort can arrive while either durable transition is pending.
        // Revalidate synchronously in the same turn as the one START message.
        assertLaunchAllowed?.();
        admissionCurrent();
        // Controller linearization: one consumption and one dispatch in this
        // turn. A failed/ambiguous send is terminal, never retryable.
        if (!owner.consumeJournalPermission(generation, token, 'workload')) throw new ProcessCleanupError();
        started = true;
        if (!value.start(release)) throw new ProcessCleanupError();
        if (executed) {
          await beforeDeadline(admissionDeadline(), () => executed);
          assertLaunchAllowed?.(); admissionCurrent();
        }
      } catch (error) {
        invalidateAcceptanceOperation(operation);
        seal();
        try {owner.sealJournalAdmission(generation, token);} catch { /* Keep the original recovery duty. */ }
        throw error;
      } finally {disposeExecWait?.();}
    },
    cleanup(value, deadline) {return retire(value, deadline, true);}
  };
  return lifecycle;
}

/** Executable version/help/probe commands are complete journaled runs. */
export async function runLinuxToolCommand(file: string, args: readonly string[],
  options: ToolCommandOptions = {}): Promise<{stdout: string; stderr: string}> {
  assertToolCommandAllowed(file, args, options, 'linux');
  const data = contexts.getStore()?.owner.state.data ?? readConfig().dataDir;
  return withLinuxRunContext(data, async () => {
    const operation = currentClaimedToolOperation(file, args, options);
    const lifecycle = currentLinuxToolLifecycle(randomUUID(), operation);
    const clock = process.hrtime.bigint(), wall = Date.now();
    const budget = Math.min(options.timeout ?? 10_000, operation ? acceptanceOperationWorkloadBudget(operation) : Infinity);
    if (!Number.isFinite(budget) || budget <= 0) throw new CommandError(undefined);
    const deadline = wall + budget, notAfter = clock + BigInt(Math.floor(budget * 1e6));
    const waitDeadline = () => Date.now() + Math.max(0, Math.min(deadline - Date.now(), Number(notAfter - process.hrtime.bigint()) / 1e6));
    if (options.signal?.aborted) throw new CommandError(undefined);
    const run = await lifecycle.prepare({argv: [file, ...args], cwd: options.cwd ?? '/work', env: options.env ?? {}, deadline,
      acceptanceOperation: operation, operationProfile: options.probe?.id ?? 'accepted-utility', signal: options.signal});
    let stdout = '', stderr = '', bytes = 0, failed = false;
    const decoders = {stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8')};
    let resolveExit!: (result: {code: number | null; signal: string | null}) => void;
    const exited = new Promise<{code: number | null; signal: string | null}>(done => {resolveExit = done;});
    let resolveStarted!: (started: boolean) => void;
    const admitted = new Promise<boolean>(done => {resolveStarted = done;});
    const collect = (chunk: Buffer, channel: 'stdout' | 'stderr') => {
      bytes += chunk.length;
      if (bytes > (options.maxBuffer ?? 1024 * 1024)) {
        failed = true; run.seal(); resolveExit({code: null, signal: null}); return;
      }
      if (channel === 'stdout') stdout += decoders.stdout.write(chunk); else stderr += decoders.stderr.write(chunk);
    };
    run.child.stdout.on('data', chunk => collect(chunk, 'stdout'));
    run.child.stderr.on('data', chunk => collect(chunk, 'stderr'));
    run.child.stdin.on('error', () => {});
    run.child.on('error', () => {failed = true; resolveStarted(false); resolveExit({code: null, signal: null});});
    run.child.on('exit', (code, signal) => {resolveStarted(false); resolveExit({code, signal});});
    run.child.on('message', value => {
      if (value && typeof value === 'object' && 'type' in value) {
        if (value.type === 'tool-start' && 'pid' in value && Number.isSafeInteger(value.pid) && Number(value.pid) > 1) resolveStarted(true);
        if (value.type === 'tool-error') {failed = true; resolveStarted(false); resolveExit({code: null, signal: null});}
      }
      if (value && typeof value === 'object' && 'type' in value && value.type === 'tool-exit' && 'code' in value && 'signal' in value) {
        resolveStarted(false);
        resolveExit({code: typeof value.code === 'number' ? value.code : null, signal: typeof value.signal === 'string' ? value.signal : null});
      }
    });
    const abort = () => {failed = true; run.seal(); resolveStarted(false); resolveExit({code: null, signal: null});};
    options.signal?.addEventListener('abort', abort, {once: true});
    const outputClosed = Promise.all([run.child.stdout, run.child.stderr].map(stream =>
      new Promise<void>(done => {if (stream.readableEnded || stream.destroyed) done(); else {
        stream.once('end', done); stream.once('close', done);
      }})));
    try {
      await beforeDeadline(waitDeadline(), () => run.ready);
      if (options.signal?.aborted) throw new CommandError(undefined);
      await beforeDeadline(waitDeadline(), () => lifecycle.launch(run, () => {
        assertToolCommandAllowed(file, args, options, 'linux');
        if (options.signal?.aborted || failed || Date.now() >= deadline || process.hrtime.bigint() >= notAfter) throw new CommandError(undefined);
      }));
      if (!await beforeDeadline(waitDeadline(), () => admitted) || failed || options.signal?.aborted ||
        Date.now() >= deadline || process.hrtime.bigint() >= notAfter) throw new CommandError(undefined);
      run.child.stdin.end(options.input);
      const result = await beforeDeadline(waitDeadline(), () => exited);
      if (failed || result.code !== 0 || result.signal !== null) throw new CommandError(result.code ?? undefined);
    } catch (error) {
      invalidateAcceptanceOperation(operation);
      throw error instanceof HelperError ? error : new CommandError(undefined);
    }
    finally {
      options.signal?.removeEventListener('abort', abort);
      run.seal();
      const cleanupDeadline = Date.now() + PROCESS_CLEANUP_CAP_MS;
      try {
        // Expiry bounds this caller only. The lifecycle retains its physical
        // cleanup promise, descriptors and unresolved journal responsibility.
        await beforeDeadline(cleanupDeadline, () => lifecycle.cleanup(run, cleanupDeadline));
        await beforeDeadline(cleanupDeadline, () => outputClosed);
      }
      finally {run.child.stdin.destroy(); run.child.stdout.destroy(); run.child.stderr.destroy(); run.child.unref();}
    }
    if (failed) throw new CommandError(undefined);
    return {stdout: stdout + decoders.stdout.end(), stderr: stderr + decoders.stderr.end()};
  });
}
