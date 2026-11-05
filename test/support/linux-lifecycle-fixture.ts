import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {mkdtemp, mkdir, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import type {TestContext} from 'node:test';
import {initializeCleanJournal} from '../../src/runner/journal.js';
import {containmentBackendForNamespace, type LinuxContainmentNamespace, type LinuxContainmentObject, type LinuxContainmentRequest, type LinuxContainmentRelease} from '../../src/runner/linux-containment.js';
import {createLinuxToolLifecycle} from '../../src/runner/linux-lifecycle.js';
import type {LinuxToolLaunchRequest} from '../../src/runner/process.js';
import {RunnerState} from '../../src/runner/state.js';
import {acquireRunnerStorageLock} from '../../src/runner/storage-lock.js';
import {RunnerStorageOwner} from '../../src/runner/storage-owner.js';

export const flush = () => new Promise<void>(done => setImmediate(done));
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {resolve = done;});
  return {promise, resolve};
}
export async function linuxLifecycleFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'mdai-s3-lifecycle-')), data = join(root, 'controller'), work = join(root, 'work');
  await mkdir(data, {mode: 0o700}); await mkdir(work, {mode: 0o700});
  const lock = await acquireRunnerStorageLock(data), state = new RunnerState(data), directory = await lock.directory('runner');
  state.bindDirectory(lock);
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(), ownerEpoch = randomUUID(), namespaceId = randomUUID();
  const context = {directoryIdentity: lock.identity, bootId, ownerEpoch, generation: 1, isCurrent: () => true,
    completionScope: 'full-run' as const, contractVersion: 1 as const};
  await initializeCleanJournal(directory, context);
  const actions: string[] = [], term = deferred(), ready = deferred(), preparationSettled = deferred();
  let populated = false, sealed = false, admitted = false, starts = 0, denyKill = false, extinguishOnTerm = true, unreadableEvents = false;
  let onKill: (() => void) | undefined;
  let beforeSpawn: (() => Promise<void>) | undefined, beforeReserve: (() => Promise<void>) | undefined;
  let nativeRequest: LinuxContainmentRequest | undefined;
  let release: LinuxContainmentRelease | undefined, sendFails = false, sends = 0, acknowledgeStart = true;
  const stages = async () => {
    const names = (await readdir(join(data, 'runner'))).filter(name => /^journal-\d/u.test(name)).sort();
    return Promise.all(names.map(async name => JSON.parse(await readFile(join(data, 'runner', name), 'utf8')).payload.stage as string));
  };
  const child = Object.assign(new EventEmitter(), {pid: 987654, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, signalCode: null, unref() {}}) as unknown as ChildProcessWithoutNullStreams;
  const namespace: LinuxContainmentNamespace = {namespaceId, async assertCurrent() {},
    async reserve(request) {
      nativeRequest = request; sealed = false;
      await beforeReserve?.();
      const object: LinuxContainmentObject = {registration: {backend: 'linux-cgroup-v2', namespaceId,
        name: `run-${request.incarnation}`, objectIdentity: '10:20'}, workPath: work,
      async assertCurrent() {},
      async spawn(request) {
        assert.equal((await stages()).at(-1), 'INTENT', 'durable intent must precede even trusted bootstrap spawn');
        await request.prepareWork?.(work);
        await beforeSpawn?.();
        if (!request.admitLauncher()) throw new Error('launcher permission revoked');
        admitted = true; populated = true; actions.push('spawn');
        return {child, ready: ready.promise,
          start(value) {
            sends++; release = value; if (sealed || starts || sendFails) return false;
            starts++; actions.push('start');
            if (acknowledgeStart) child.emit('message', {type: 'tool-start', pid: child.pid});
            return true;
          },
          seal() {sealed = true; actions.push('seal');},
          async term() {actions.push('term'); term.resolve(); if (extinguishOnTerm) populated = false;},
          admissionClosed() {return sealed;}};
      }, async forceKill() {actions.push('kill'); if (denyKill) throw Object.assign(new Error('denied'), {code: 'EPERM'}); populated = false; onKill?.();},
      async empty() {if (unreadableEvents) throw new Error('EIO cgroup.events'); return !populated;},
      async retire() {assert(['EPOCH', 'CLEAN'].includes((await stages()).at(-1)!)); actions.push('retire');}};
      return object;
    }, async reopen() {throw new Error('fixture does not infer recovery from paths');}};
  const backend = containmentBackendForNamespace(context, namespace);
  const owner = new RunnerStorageOwner(state, lock, () => {}, () => false, true, backend);
  const generation = owner.attach(); await owner.replayJournal(generation);
  owner.stateLoaded = true; owner.initialized = true;
  t.mock.method(owner, 'getLinuxContainment', async () => backend);
  const retainPreparation = owner.retainPreparation;
  t.mock.method(owner, 'retainPreparation', (requestedGeneration: number) => {
    const release = retainPreparation.call(owner, requestedGeneration);
    return () => {release(); preparationSettled.resolve();};
  });
  const runId = randomUUID(), lifecycle = createLinuxToolLifecycle(owner, generation, runId);
  t.after(async () => {t.mock.timers.reset(); await owner.detach(generation); await lock.release(); await rm(root, {recursive: true, force: true});});
  return {owner, generation, runId, lifecycle, actions, stages, ready, term, preparationSettled, work, child,
    prepare: (options: Partial<LinuxToolLaunchRequest> = {}) => lifecycle.prepare({argv: ['/usr/bin/true'], cwd: '/work', env: {}, deadline: Date.now() + 60_000, ...options}),
    failSend: () => {sendFails = true;}, get sends() {return sends;}, get release() {return release;},
    holdAcknowledgment: () => {acknowledgeStart = false;},
    acknowledgeStarted: () => {child.emit('message', {type: 'tool-start', pid: child.pid});},
    providerReady: () => {child.emit('message', {type: 'provider-ready'});},
    providerFailed: (monitor = false) => {child.emit('message', {type: 'tool-error', code: monitor ? 'provider-monitor-failed' : 'provider-failed'});},
    holdSpawn: (hold: () => Promise<void>) => {beforeSpawn = hold;},
    holdReserve: (hold: () => Promise<void>) => {beforeReserve = hold;},
    denyKill: () => {denyKill = true;}, resistTerm: () => {extinguishOnTerm = false;},
    unreadableEvents: () => {unreadableEvents = true;}, onKill: (action: () => void) => {onKill = action;},
    get admitted() {return admitted;}, get starts() {return starts;}, get request() {return nativeRequest;}};
}

