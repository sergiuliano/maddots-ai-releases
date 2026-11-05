// Isolated, unprivileged bootstrap/restart controller. Only real storage owners
// acquire the directory flock and supply generation-bound journal capabilities.
import assert from 'node:assert/strict';
import {constants} from 'node:fs';
import * as filesystem from 'node:fs/promises';
import {createRequire, syncBuiltinESMExports} from 'node:module';
import {basename} from 'node:path';
import {mock} from 'node:test';
import {AdapterRegistry} from '../../src/runner/adapters/index.js';
import {bootstrapRunnerJournal} from '../../src/runner/journal-bootstrap.js';
import {RunnerJournal} from '../../src/runner/journal.js';
import {PROCESS_CLEANUP_CAP_MS} from '../../src/runner/process.js';
import {RunnerCore} from '../../src/runner/runner.js';
import {RunnerState} from '../../src/runner/state.js';
import {acquireRunnerStorageLock, type RunnerStorageLock} from '../../src/runner/storage-lock.js';
import {RunnerStorageOwner, storageOwnerDiagnostics} from '../../src/runner/storage-owner.js';

type Configuration = {mode: 'bootstrap' | 'probe' | 'failure' | 'crash' | 'hold' | 'late'; data: string;
  evidencePath: string; evidenceSha256: string; boundary?: string; when?: 'before' | 'after'; error?: 'EIO' | 'ENOSPC';
  useDefaultEvidenceOwner?: boolean; foreignOwner?: 'data' | 'evidence' | 'ancestor'};
const configuration = JSON.parse(process.argv[2]) as Configuration;
const {mode, data, evidencePath, evidenceSha256} = configuration;
assert(data && ['bootstrap', 'probe', 'failure', 'crash', 'hold', 'late'].includes(mode));
const send = (value: object) => new Promise<void>((resolve, reject) => {
  process.send!(value, (error: Error | null) => error ? reject(error) : resolve());
});
let release!: () => void;
const held = new Promise<void>(resolve => {release = resolve;});
process.on('message', value => {if (value === 'release') release();});
let initCalls = 0, activeReads = 0, replays = 0, epochs = 0, physical = 0, maximumPhysical = 0;
let owner: RunnerStorageOwner | undefined, hits = 0, pendingBoundary: string | undefined;
const originalInit = RunnerState.prototype.init, originalActive = RunnerState.prototype.active;
const originalReplay = RunnerJournal.prototype.replay, originalEpoch = RunnerJournal.prototype.establishEpoch;
const originalOperation = RunnerStorageOwner.prototype.operation;
mock.method(RunnerState.prototype, 'init', async function(this: RunnerState) {initCalls++; await originalInit.call(this);});
mock.method(RunnerState.prototype, 'active', async function(this: RunnerState) {activeReads++; return originalActive.call(this);});
mock.method(RunnerJournal.prototype, 'replay', async function(this: RunnerJournal) {replays++; return originalReplay.call(this);});
mock.method(RunnerJournal.prototype, 'establishEpoch', async function(this: RunnerJournal) {epochs++; return originalEpoch.call(this);});
mock.method(RunnerStorageOwner.prototype, 'operation', async function(this: RunnerStorageOwner, generation: number,
  action: (state: RunnerState, lock: RunnerStorageLock) => Promise<unknown>,
  mutation: boolean | ((error: unknown) => boolean) = false, deadline?: number) {
  // eslint-disable-next-line @typescript-eslint/no-this-alias -- Inspect the actual production owner, never a replacement capability.
  owner = this;
  return originalOperation.call(this, generation, async (state, lock) => {
    physical++; maximumPhysical = Math.max(maximumPhysical, physical);
    try {return await action(state, lock);} finally {physical--;}
  }, mutation, deadline);
});

// Instrument the actual file descriptors and publication syscalls, preserving
// the normal flock, owner queue, retained paths, generation and fsync behavior.
const fsp = createRequire(import.meta.url)('node:fs/promises') as typeof filesystem;
const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
const originalMkdirSync = fs.mkdirSync, originalOpenSync = fs.openSync;
const originalLinkSync = fs.linkSync, originalRenameSync = fs.renameSync, originalUnlinkSync = fs.unlinkSync;
const originalOpen = fsp.open, originalMkdir = fsp.mkdir, originalLstat = fsp.lstat;
// This managed user namespace maps the host root's metadata to uid 65534.
// Normalize only those two system ancestors in this fixture, never the data,
// evidence or any private fixture ancestor. Production trust checks stay real.
fsp.lstat = (async (...args: Parameters<typeof originalLstat>) => {
  const path = String(args[0]), stage = temporaryStages.get(path);
  // Await at the real validation yield immediately before the final sync
  // publication checks, or at the first validation following that syscall.
  if (pendingAfter?.path === path) {
    const boundary = pendingAfter.boundary; pendingAfter = undefined;
    await hit(boundary, 'after');
  }
  if (stage && closedStages.has(stage) && !publishedStages.has(stage) && !publicationChecks.has(stage)) {
    publicationChecks.add(stage); await hit(`${stage}-publish`, 'before');
  } else if (stage && publishedStages.has(stage) && !unlinkedStages.has(stage) && !unlinkChecks.has(stage)) {
    unlinkChecks.add(stage); await hit(`${stage}-unlink`, 'before');
  }
  const info = await originalLstat(...args);
  const foreign = configuration.foreignOwner === 'data' && path === data ||
    configuration.foreignOwner === 'evidence' && path === evidencePath ||
    configuration.foreignOwner === 'ancestor' && path === evidencePath.slice(0, evidencePath.lastIndexOf('/'));
  if (foreign) return Object.assign(Object.create(Object.getPrototypeOf(info)), info,
    {uid: typeof info.uid === 'bigint' ? BigInt(process.getuid!() + 1) : process.getuid!() + 1});
  if (['/', '/tmp'].includes(String(args[0])) && Number(info.uid) === 65534) {
    return Object.assign(Object.create(Object.getPrototypeOf(info)), info, {uid: typeof info.uid === 'bigint' ? 0n : 0});
  }
  return info;
}) as typeof originalLstat;
let headOpens = 0, lastPublication: string | undefined;
const temporaryStages = new Map<string, string>(), directoryCreations = new Map<string, string>();
const createdDirectories = new Map<string, string>(), pinnedEntries = new Map<number, {stage: string; directory: boolean}>();
const closedStages = new Set<string>(), publishedStages = new Set<string>(), unlinkedStages = new Set<string>();
const publicationChecks = new Set<string>(), unlinkChecks = new Set<string>();
const publishedTargets = new Map<string, string>();
let pendingAfter: {path: string; boundary: string} | undefined;
const trace: string[] = [];
async function hit(boundary: string, when: 'before' | 'after'): Promise<void> {
  trace.push(`${when}:${boundary}`);
  if (hits || configuration.boundary !== boundary || (configuration.when ?? 'before') !== when) return;
  hits++;
  if (mode === 'crash') process.exit(86);
  if (mode === 'failure') throw Object.assign(new Error(`Injected ${configuration.error} at ${boundary}`), {code: configuration.error});
  if (mode === 'hold' || mode === 'late') {
    pendingBoundary = boundary;
    await send({kind: 'held', boundary, physical, diagnostics: storageOwnerDiagnostics(data)});
    await held;
    pendingBoundary = undefined;
  }
}
// Synchronous creation and publication cannot wait for an IPC release. Inject
// their failures at the call itself, separately from the asynchronous adoption
// and validation yields used by the replacement/deadline race tests above.
function syscallFailure(boundary: string): void {
  trace.push(`before:${boundary}`);
  if (hits || configuration.boundary !== boundary || (configuration.when ?? 'before') !== 'before') return;
  hits++;
  assert.equal(mode, 'failure', 'synchronous syscall boundaries support failure injection only');
  throw Object.assign(new Error(`Injected ${configuration.error} at ${boundary}`), {code: configuration.error});
}
function stageForTemporary(path: string): string | undefined {
  const name = basename(path);
  return /^\.journal-head\.json\./u.test(name) ? (++headOpens === 1 ? 'initial-head' : 'epoch-head') :
    /^\.journal-manifest\.json\./u.test(name) ? 'manifest' : /^\.journal-\d{10}\.json\./u.test(name) ? 'epoch-record' : undefined;
}
fsp.mkdir = (async (...args: Parameters<typeof originalMkdir>) => {
  const path = String(args[0]), name = basename(path);
  const result = await originalMkdir(...args);
  if (['runner', 'outcomes', 'logs'].includes(name)) {
    const parent = path.slice(0, path.lastIndexOf('/'));
    directoryCreations.set(parent, `${name}-create-directory-sync`);
  }
  return result;
}) as typeof originalMkdir;
fs.mkdirSync = ((...args: Parameters<typeof originalMkdirSync>) => {
  const path = String(args[0]), name = basename(path);
  if (['runner', 'outcomes', 'logs'].includes(name)) syscallFailure(`${name}-mkdirSync`);
  const result = originalMkdirSync(...args);
  if (['runner', 'outcomes', 'logs'].includes(name)) {
    directoryCreations.set(path.slice(0, path.lastIndexOf('/')), `${name}-create-directory-sync`);
    createdDirectories.set(path, name);
  }
  return result;
}) as typeof originalMkdirSync;
fs.openSync = ((...args: Parameters<typeof originalOpenSync>) => {
  const path = String(args[0]), flags = args[1];
  const exclusive = typeof flags === 'number' && (flags & constants.O_CREAT) && (flags & constants.O_EXCL);
  const stage = exclusive ? stageForTemporary(path) : undefined, directory = createdDirectories.get(path);
  if (stage) syscallFailure(`${stage}-openSync-exclusive`);
  else if (directory && typeof flags === 'number' && (flags & constants.O_DIRECTORY)) syscallFailure(`${directory}-openSync-directory`);
  const file = originalOpenSync(...args);
  if (stage) {temporaryStages.set(path, stage); pinnedEntries.set(file, {stage, directory: false});}
  else if (directory && typeof flags === 'number' && (flags & constants.O_DIRECTORY)) {
    pinnedEntries.set(file, {stage: `${directory}-create-directory`, directory: true});
    createdDirectories.delete(path);
  }
  return file;
}) as typeof originalOpenSync;
fsp.open = (async (...args: Parameters<typeof originalOpen>) => {
  const path = String(args[0]);
  const adopted = /^\/proc\/self\/fd\/(\d+)(?:\/\.)?$/u.exec(path);
  const pinned = adopted ? pinnedEntries.get(Number(adopted[1])) : undefined;
  if (adopted) pinnedEntries.delete(Number(adopted[1]));
  const stage = pinned?.directory ? undefined : pinned?.stage ??
    (typeof args[1] === 'number' && (args[1] & constants.O_CREAT) ? stageForTemporary(path) : undefined);
  const opening = pinned?.directory ? `${pinned.stage}-open` : stage ? `${stage}-open` : undefined;
  if (stage && !pinned) temporaryStages.set(path, stage);
  if (opening) await hit(opening, 'before');
  const file = await originalOpen(...args);
  if (opening) {
    try {await hit(opening, 'after');} catch (error) {await file.close(); throw error;}
  }
  if (configuration.foreignOwner === 'evidence' && path === evidencePath) {
    const stat = file.stat.bind(file);
    file.stat = (async (...values: Parameters<typeof stat>) => {
      const info = await stat(...values);
      return Object.assign(Object.create(Object.getPrototypeOf(info)), info,
        {uid: typeof info.uid === 'bigint' ? BigInt(process.getuid!() + 1) : process.getuid!() + 1});
    }) as typeof file.stat;
  }
  if (stage) {
    const write = file.writeFile.bind(file), sync = file.sync.bind(file), close = file.close.bind(file);
    file.writeFile = async (...values) => {
      await hit(`${stage}-write`, 'before'); const result = await write(...values); await hit(`${stage}-write`, 'after'); return result;
    };
    file.sync = async () => {await hit(`${stage}-sync`, 'before'); await sync(); await hit(`${stage}-sync`, 'after');};
    file.close = async () => {
      await hit(`${stage}-close`, 'before'); await close(); closedStages.add(stage); await hit(`${stage}-close`, 'after');
    };
  } else if (typeof args[1] === 'number' && (args[1] & constants.O_DIRECTORY)) {
    const sync = file.sync.bind(file);
    file.sync = async () => {
      const anchored = `/proc/self/fd/${file.fd}`;
      const boundary = directoryCreations.get(anchored) ?? (lastPublication ? `${lastPublication}-directory-sync` : undefined);
      directoryCreations.delete(anchored);
      if (boundary) await hit(boundary, 'before');
      await sync();
      if (boundary) await hit(boundary, 'after');
    };
  }
  return file;
}) as typeof originalOpen;
fs.linkSync = ((...args: Parameters<typeof originalLinkSync>) => {
  const stage = temporaryStages.get(String(args[0]));
  if (stage) syscallFailure(`${stage}-linkSync`);
  const result = originalLinkSync(...args);
  if (stage) {
    publishedStages.add(stage); publishedTargets.set(stage, String(args[1])); lastPublication = stage;
    pendingAfter = {path: String(args[1]), boundary: `${stage}-publish`};
  }
  return result;
}) as typeof originalLinkSync;
fs.renameSync = ((...args: Parameters<typeof originalRenameSync>) => {
  const stage = temporaryStages.get(String(args[0]));
  if (stage) syscallFailure(`${stage}-renameSync`);
  const result = originalRenameSync(...args);
  if (stage) {
    publishedStages.add(stage); publishedTargets.set(stage, String(args[1])); lastPublication = stage;
    pendingAfter = {path: String(args[1]), boundary: `${stage}-publish`};
  }
  return result;
}) as typeof originalRenameSync;
fs.unlinkSync = ((...args: Parameters<typeof originalUnlinkSync>) => {
  const path = String(args[0]), stage = temporaryStages.get(path);
  if (stage) syscallFailure(`${stage}-unlinkSync`);
  const result = originalUnlinkSync(...args);
  if (stage) {
    unlinkedStages.add(stage);
    pendingAfter = {path: publishedTargets.get(stage)!, boundary: `${stage}-unlink`};
  }
  return result;
}) as typeof originalUnlinkSync;
syncBuiltinESMExports();

const report = async (kind: string, error: unknown) => send({kind, error: (error as {code?: string} | undefined)?.code ?? null,
  reason: (error as {reason?: string} | undefined)?.reason ?? null, initCalls, activeReads, replays, epochs,
  physical, maximumPhysical, hits, pendingBoundary, trace, diagnostics: storageOwnerDiagnostics(data),
  owner: owner?.diagnosticSnapshot()});
try {
  if (mode === 'probe') {
    const core = new RunnerCore({data, registry: new AdapterRegistry([]), connections: async () => [], localAgents: async () => [],
      verifiedBuild: async () => true, allowedBuild: async () => true, stageSkills: async () => {}, removeDeviceKey: async () => {},
      deliver: async (): Promise<never> => {assert.fail('No bootstrap fixture may deliver or execute a workload.');}});
    let error: unknown;
    await core.init().catch(value => {error = value;});
    await report('result', error);
    await core.close();
  } else if (mode === 'late') {
    mock.timers.enable({apis: ['Date', 'setTimeout'], now: Date.now()});
    let error: unknown;
    const bootstrap = bootstrapRunnerJournal(data, evidencePath, evidenceSha256,
      configuration.useDefaultEvidenceOwner ? {} : {evidenceOwner: process.getuid!()}).catch(value => {error = value;});
    const waitingUntil = performance.now() + 5000;
    while (!hits && error === undefined && performance.now() < waitingUntil) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(hits, 1, 'the requested physical boundary must be reached before advancing the deadline');
    mock.timers.tick(PROCESS_CLEANUP_CAP_MS + 1);
    await bootstrap;
    await report('timed-out', error);
    // A second real kernel acquisition must remain excluded while the first
    // controller's physical write has not settled, despite caller timeout.
    mock.timers.reset();
    await assert.rejects(acquireRunnerStorageLock(data, undefined, Date.now() + 100), {code: 'HELPER_BUSY'});
    release();
    while (physical) await new Promise<void>(resolve => setImmediate(resolve));
    await report('result', error);
  } else {
    let error: unknown;
    await bootstrapRunnerJournal(data, evidencePath, evidenceSha256,
      configuration.useDefaultEvidenceOwner ? {} : {evidenceOwner: process.getuid!()}).catch(value => {error = value;});
    await report('result', error);
    if (mode === 'crash') assert.fail('The requested process crash boundary was not reached.');
  }
  process.exit(0);
} catch (error) {
  await send({kind: 'fixture-error', error: error instanceof Error ? error.stack : String(error)});
  process.exit(1);
}
