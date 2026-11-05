import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import * as filesystem from 'node:fs/promises';
import {createRequire, syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {AdapterRegistry} from '../src/runner/adapters/index.js';
import {PROCESS_CLEANUP_CAP_MS, type ProcessInspector} from '../src/runner/process.js';
import {RunnerCore, type RunnerOptions} from '../src/runner/runner.js';
import type {ActiveRun} from '../src/runner/state.js';
import type {RunnerStorageLock} from '../src/runner/storage-lock.js';
import {RunnerStorageOwner} from '../src/runner/storage-owner.js';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const delay = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

async function advanceUntil(t: TestContext, check: () => boolean, budget = PROCESS_CLEANUP_CAP_MS + 1000) {
  const began = Date.now();
  await flush();
  while (!check() && Date.now() - began < budget) {t.mock.timers.tick(1); await flush();}
  assert(check(), 'finite-latency recovery must settle within the fixture budget');
}

function fixture(t: TestContext, validationMs: number, publicationMs: number) {
  const data = '/finite-recovery/data', cwd = '/finite-recovery/work', runId = randomUUID();
  const root = 900050, member = 900051, tool = 900052;
  const anchor = {pid: root, ppid: 1, pgid: root, startedAt: 'guardian-start'};
  const row: ActiveRun = {runId, agentId: randomUUID(), aiToolId: randomUUID(), pid: root,
    startedAt: anchor.startedAt, runDir: join(cwd, '.maddots/runs', runId), phase: 'running',
    fence: 'd'.repeat(32), pgid: root, processGroups: [{pgid: root, startedAt: anchor.startedAt}]};
  let guardianAlive = true, toolAlive = true, memberAlive = false, outage = true;
  let lateScans = 0, inspectionFailures = 0, authoritativeReads = 0, releases = 0;
  let recoveryStarted: number | undefined, physicalPending = 0, maximumPhysical = 0;
  let durable = [structuredClone(row)];
  const signals: NodeJS.Signals[] = [];
  const saves: {started: number; deadline: number; settled?: number}[] = [];
  const publications: {started: number; settled?: number}[] = [];
  const current = () => [...(guardianAlive ? [anchor] : []),
    ...(toolAlive ? [{pid: tool, ppid: root, pgid: root, startedAt: 'tool-start'}] : []),
    ...(memberAlive ? [{pid: member, ppid: 1, pgid: root, startedAt: 'late-member-start'}] : [])];
  const inspector: ProcessInspector = {
    identity: async pid => {
      recoveryStarted ??= Date.now();
      return current().find(entry => entry.pid === pid)?.startedAt ?? null;
    },
    inspectSync: pid => current().find(entry => entry.pid === pid) ?? null,
    fencePids: async () => [],
    table: async () => {
      await delay(1);
      if (memberAlive && outage && ++lateScans > 2) {
        inspectionFailures++;
        throw Object.assign(new Error('inspection interrupted'), {code: 'EPERM'});
      }
      return current();
    },
    signalGroup: (pgid, signal) => {
      assert.equal(pgid, root); signals.push(signal);
      if (toolAlive) {toolAlive = false; memberAlive = true;}
      else {
        assert(durable[0].processGroups?.some(group => group.members?.some(value => value.pid === member)),
          'the late same-group member must be durable before signalling');
        memberAlive = false; guardianAlive = false;
      }
    },
  };
  const options: RunnerOptions = {data, registry: new AdapterRegistry([]), processes: inspector,
    connections: async () => [], localAgents: async () => [], verifiedBuild: async () => true,
    allowedBuild: async () => true, stageSkills: async () => {}, removeDeviceKey: async () => {},
    deliver: async () => {assert.fail('A recovery fixture must never deliver.');}};
  const core = new RunnerCore(options), state = core['state'];
  const lock: RunnerStorageLock = {data, identity: 'finite-recovery-directory',
    assertCurrent: async () => {await delay(validationMs);},
    directory: async name => {
      assert(['run-homes', 'runner/staged'].includes(name), 'cleanup uses only retained homes and staged journals');
      return {path: '/proc/self/fd/900099', assertCurrent: async () => {}, sync: async () => {}};
    },
    release: async () => {releases++;}};
  const owner = new RunnerStorageOwner(state, lock, () => {});
  core['owner'] = owner; core['ownerGeneration'] = owner.attach();
  core['active'] = owner.active; core['unrecovered'] = owner.unrecovered;
  core['recoveryFolders'] = owner.recoveryFolders; core['folders'] = owner.folders;
  t.mock.method(state, 'init', async () => {});
  t.mock.method(state, 'active', async () => {authoritativeReads++; return structuredClone(durable);});
  t.mock.method(state, 'pending', async () => []);
  const logs: {code: string | null}[] = [];
  t.mock.method(state, 'log', async (_runId: string, _phase: string, code: string | null) => {logs.push({code});});
  t.mock.method(state, 'writeActive', async (rows: ActiveRun[]) => {
    const publication = {started: Date.now(), settled: undefined as number | undefined}; publications.push(publication);
    physicalPending++; maximumPhysical = Math.max(maximumPhysical, physicalPending);
    try {await delay(publicationMs); durable = structuredClone(rows); publication.settled = Date.now();}
    finally {physicalPending--;}
  });
  const save = owner.save.bind(owner);
  t.mock.method(owner, 'save', async (generation: number, deadline = Date.now() + PROCESS_CLEANUP_CAP_MS) => {
    const attempt = {started: Date.now(), deadline, settled: undefined as number | undefined}; saves.push(attempt);
    try {await save(generation, deadline);} finally {attempt.settled = Date.now();}
  });
  t.mock.method(process, 'kill', (pid: number) => {
    assert([root, member, tool].includes(pid), 'only fixture processes can receive simulated individual signals');
    return true;
  });

  // The kernel-lock and filesystem seams are simulated; core initialization,
  // owner serialization/deadlines and all process recovery logic remain real.
  // Empty virtual folders let the successful retry finish actual cleanup.
  const fsp = createRequire(import.meta.url)('node:fs/promises') as typeof filesystem;
  const originalRealpath = fsp.realpath, originalLstat = fsp.lstat, originalMkdir = fsp.mkdir, originalReaddir = fsp.readdir;
  const directories = new Set(['/', '/finite-recovery', data, cwd]);
  fsp.realpath = (async path => {
    assert(directories.has(String(path)), `Unexpected virtual realpath: ${String(path)}`); return String(path);
  }) as typeof fsp.realpath;
  fsp.lstat = (async path => {
    if (!directories.has(String(path))) throw Object.assign(new Error('No fixture entry'), {code: 'ENOENT'});
    return {isDirectory: () => true, isSymbolicLink: () => false, uid: process.getuid?.(), mode: 0o40700};
  }) as typeof fsp.lstat;
  fsp.mkdir = (async path => {assert(directories.has(String(path)));}) as typeof fsp.mkdir;
  fsp.readdir = (async path => {
    assert.equal(String(path), '/proc/self/fd/900099'); return [];
  }) as typeof fsp.readdir;
  syncBuiltinESMExports();
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
  t.after(async () => {
    try {await advanceUntil(t, () => !owner.writes, 100); await core.close();}
    finally {
      t.mock.timers.reset();
      fsp.realpath = originalRealpath; fsp.lstat = originalLstat; fsp.mkdir = originalMkdir;
      fsp.readdir = originalReaddir; syncBuiltinESMExports();
    }
  });
  return {core, owner, saves, publications, signals, logs, durable: () => durable,
    recoveryStarted: () => recoveryStarted!, inspectionFailures: () => inspectionFailures,
    physicalPending: () => physicalPending, maximumPhysical: () => maximumPhysical,
    authoritativeReads: () => authoritativeReads, releases: () => releases,
    memberAlive: () => memberAlive, restoreInspection: () => {outage = false;}};
}

for (const latency of [1, 3]) test(`TLS21-R6 finite repeated EPERM with ${latency} ms validation and publication`, {
  skip: process.platform !== 'linux',
}, async t => {
  const f = fixture(t, latency, latency);
  // The core and finite publisher above retain their Linux owner lane. This
  // historical inspection schedule uses the Darwin process backend only.
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', {...descriptor, value: 'darwin'});
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
  let outcome: {error?: unknown; at: number} | undefined;
  const initial = f.core.init().then(() => {outcome = {at: Date.now()};}, error => {outcome = {error, at: Date.now()};});
  await advanceUntil(t, () => outcome !== undefined); await initial;
  const cleanupEnds = f.recoveryStarted() + PROCESS_CLEANUP_CAP_MS;
  assert(f.inspectionFailures() > 100, 'the original schedule must repeatedly fail inspections without holding I/O');
  assert.equal(f.memberAlive(), true); assert.equal(f.core.busy, true);
  assert.deepEqual(f.signals, ['SIGTERM']); assert.equal(f.authoritativeReads(), 1);
  const cleanupSaves = f.saves.filter(save => save.deadline === cleanupEnds);
  if (latency === 1) {
    assert.equal(outcome!.error, undefined, 'initialization succeeds when every cleanup publication settles within its budget');
    assert(cleanupSaves.every(save => save.started < cleanupEnds && save.settled! < cleanupEnds));
    assert.equal(f.physicalPending(), 0); assert.equal(f.owner.unavailable, false);
    assert.equal(outcome!.at, cleanupEnds + 4, 'only finite initialization bookkeeping follows process cleanup');
    assert.deepEqual(f.logs, [{code: 'tool_failed'}]);
  } else {
    assert.equal((outcome!.error as {code: string}).code, 'RUNNER_STATE_UNAVAILABLE');
    assert.equal(outcome!.at, cleanupEnds, 'the caller refuses at its cap while finite publication remains pending');
    const lastAttempt = cleanupSaves.filter(save => save.started < cleanupEnds).at(-1)!;
    assert.equal(lastAttempt.started, cleanupEnds - 3);
    assert.equal(lastAttempt.settled, cleanupEnds);
    assert.equal(f.publications.at(-1)!.started, cleanupEnds, 'lock validation consumes the final three milliseconds');
    assert.equal(f.physicalPending(), 1); assert.equal(f.owner.unavailable, true);
    assert(f.owner.writes); assert.equal(f.releases(), 0);
    await assert.rejects(f.core.init(), {code: 'RUNNER_STATE_UNAVAILABLE'});
    await f.core.tick();
    assert.equal(f.core['lastError'], 'RUNNER_STATE_UNAVAILABLE');
    assert.equal(Date.now(), cleanupEnds, 'unavailable retries never rejoin the physical publisher');
    assert.equal(f.physicalPending(), 1); assert.equal(f.authoritativeReads(), 1);
    await advanceUntil(t, () => !f.owner.writes && !f.owner.unavailable, 20);
    assert.equal(Date.now(), cleanupEnds + 9, 'both queued finite publications settle without intervention');
    assert.equal(f.owner.unmatchedWrites.length, 0);
    assert.equal(f.releases(), 0, 'physical settlement preserves the unresolved member and directory ownership');
    assert.equal(f.core.busy, true);
    assert.deepEqual(f.logs, []);
  }
  assert(f.durable()[0].processGroups?.some(group => group.members?.some(member => member.pid === 900051)),
    'the late-member evidence survives every physical publication');
  f.restoreInspection();
  let retryDone = false;
  const retry = (latency === 3 ? f.core.init() : f.core.tick()).then(() => {retryDone = true;});
  await advanceUntil(t, () => retryDone); await retry;
  assert.equal(f.memberAlive(), false); assert.equal(f.core.busy, false);
  assert.deepEqual(f.signals, ['SIGTERM', 'SIGTERM']);
  assert.deepEqual(f.durable(), []); assert.equal(f.owner.unmatchedWrites.length, 0);
  assert.equal(f.authoritativeReads(), 1, 'successful retry reuses the retained owner without loading stale disk state');
  assert.equal(f.maximumPhysical(), 1); assert.equal(f.physicalPending(), 0);
  t.diagnostic(JSON.stringify({validationMs: latency, publicationMs: latency, inspectionMs: 1,
    inspectionFailures: f.inspectionFailures(), initialElapsed: outcome!.at - f.recoveryStarted(),
    initial: outcome!.error ? 'bounded unavailable' : 'success', retry: 'success'}));
});
