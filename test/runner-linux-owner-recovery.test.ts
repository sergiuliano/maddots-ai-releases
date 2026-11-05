import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {initializeCleanJournal, RunnerJournal, type JournalContext} from '../src/runner/journal.js';
import {containmentBackendForNamespace, type LinuxContainmentNamespace, type LinuxContainmentObject} from '../src/runner/linux-containment.js';
import {RunnerState} from '../src/runner/state.js';
import {acquireRunnerStorageLock} from '../src/runner/storage-lock.js';
import {RunnerStorageOwner} from '../src/runner/storage-owner.js';

for (const stage of ['CONTAINMENT_BOUND', 'LAUNCH_ALLOWED', 'STOPPING'] as const) {
  test(`S3 production owner replays ${stage} through the original registered object and survives a second restart`, {skip: process.platform !== 'linux'}, async t => {
    const data = await mkdtemp(join(tmpdir(), 'mdai-s3-owner-recovery-'));
    let lock = await acquireRunnerStorageLock(data);
    t.after(async () => {await lock.release(); await rm(data, {recursive: true, force: true});});
    const directory = await lock.directory('runner'), bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    const namespaceId = randomUUID(), runId = randomUUID(), incarnation = randomUUID();
    const registration = Object.freeze({backend: 'linux-cgroup-v2' as const, namespaceId, name: `run-${incarnation}`, objectIdentity: '10:20'});
    const seed: JournalContext = {directoryIdentity: lock.identity, bootId, ownerEpoch: randomUUID(), generation: 1,
      isCurrent: () => true, completionScope: 'full-run', contractVersion: 1,
      backend: {verifyRegistration: async value => value.backend === registration.backend && value.namespaceId === registration.namespaceId &&
        value.name === registration.name && value.objectIdentity === registration.objectIdentity, verifyCompletion: async () => false}};
    await initializeCleanJournal(directory, seed);
    const previous = new RunnerJournal(directory, seed); await previous.replay(); await previous.establishEpoch();
    let token = await previous.intent({runId, incarnation});
    token = await previous.bind(token, registration);
    if (stage !== 'CONTAINMENT_BOUND') token = await previous.allow(token);
    if (stage === 'STOPPING') token = await previous.stopping(token);
    assert.deepEqual(previous.containmentRegistrations, [registration]);
    assert.deepEqual(previous.completedContainmentRegistrations, []);
    // Simulated controller death relinquishes only the real storage lock.
    // No status projection or handoff file supplies the replacement's authority.
    await lock.release(); lock = await acquireRunnerStorageLock(data);
    const actions: string[] = [];
    let populated = true;
    const object: LinuxContainmentObject = {registration, workPath: '/work',
      async assertCurrent() {actions.push('verify-object');},
      async spawn() {throw new Error('restart must never spawn');},
      async forceKill() {actions.push('kill-original'); populated = false;},
      async empty() {actions.push('registered-events'); return !populated;},
      async retire() {actions.push('retire');}};
    const namespace: LinuxContainmentNamespace = {namespaceId, async assertCurrent() {},
      async reserve() {throw new Error('restart must never reserve');},
      async reopen(value) {assert.deepEqual(value, registration); actions.push('reopen-original'); return object;}};
    const state = new RunnerState(data); state.bindDirectory(lock);
    const owner = new RunnerStorageOwner(state, lock, () => {}, () => false, true);
    const generation = owner.attach();
    const backend = containmentBackendForNamespace({directoryIdentity: lock.identity, bootId, ownerEpoch: randomUUID(),
      isCurrent: () => {try {owner.assertGeneration(generation); return true;} catch {return false;}}}, namespace);
    t.mock.method(owner, 'getLinuxContainment', async () => backend);
    await owner.replayJournal(generation);
    owner.stateLoaded = true; owner.initialized = true;
    assert.equal(owner.isRunRetired(runId), true);
    assert.equal(owner.busy, false);
    assert.equal(owner.consumeJournalPermission(generation, token, 'workload'), false);
    assert(actions.indexOf('reopen-original') < actions.indexOf('kill-original'));
    assert(actions.indexOf('kill-original') < actions.indexOf('retire'));
    await owner.detach(generation);
    lock = await acquireRunnerStorageLock(data);
    const nextState = new RunnerState(data); nextState.bindDirectory(lock);
    const next = new RunnerStorageOwner(nextState, lock, () => {}, () => false, true);
    const nextGeneration = next.attach();
    t.mock.method(next, 'getLinuxContainment', async () => {throw new Error('clean replay cannot manufacture a cleanup endpoint');});
    await next.replayJournal(nextGeneration);
    next.stateLoaded = true; next.initialized = true;
    assert.equal(next.isRunRetired(runId), true);
    assert.equal(next.busy, false);
    assert.equal(next.consumeJournalPermission(nextGeneration, token, 'workload'), false);
    const inspected = new RunnerJournal(await lock.directory('runner'), {...seed, ownerEpoch: randomUUID(), generation: 2});
    assert.equal((await inspected.replay()).busy, false);
    assert.deepEqual(inspected.containmentRegistrations, [registration]);
    assert.deepEqual(inspected.completedContainmentRegistrations, [registration]);
    await next.detach(nextGeneration);
  });
}
