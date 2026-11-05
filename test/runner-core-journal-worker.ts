import assert from 'node:assert/strict';
import {mock} from 'node:test';
import {AdapterRegistry} from '../src/runner/adapters/index.js';
import {PROCESS_CLEANUP_CAP_MS} from '../src/runner/process.js';
import {RunnerCore} from '../src/runner/runner.js';
import {RunnerState, type ActiveRun} from '../src/runner/state.js';
import {acquireRunnerStorageLock} from '../src/runner/storage-lock.js';
import {RunnerStorageOwner} from '../src/runner/storage-owner.js';
import {directFixtureProcesses} from './native-process-fixture.js';
import {inspectLinuxProcess, inspectLinuxProcessSync, linuxProcessIdentity, linuxProcessTable, LinuxProcError} from '../src/linux-proc.js';

const [mode, data, leaderText] = process.argv.slice(2);
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean) {
  const deadline = performance.now() + 5000;
  while (!check() && performance.now() < deadline) await flush();
  assert(check(), 'the isolated helper must make bounded fixture progress');
}
const code = (error: unknown) => (error as {code?: string} | undefined)?.code ?? null;
const send = (value: unknown) => process.send!(value);
const messages: string[] = [];
process.on('message', value => {messages.push(String(value));});
async function command(expected: string) {
  await until(() => messages.length > 0);
  assert.equal(messages.shift(), expected);
}
const processes = directFixtureProcesses();
processes.signalGroup = () => {assert.fail('The durability fixture must not signal any process group.');};
mock.method(process, 'kill', () => {assert.fail('The durability fixture must not signal numeric PIDs.');});
const options = {data, registry: new AdapterRegistry([]), processes,
  connections: async () => [], localAgents: async () => [], verifiedBuild: async () => true,
  allowedBuild: async () => true, stageSkills: async () => {}, removeDeviceKey: async () => {},
  deliver: async (): Promise<never> => {assert.fail('The durability fixture cannot deliver.');}};

try {
  const core = new RunnerCore(options);
  if (mode === 'replay') {
    let reads = 0, error: unknown;
    const read = RunnerState.prototype.active;
    mock.method(RunnerState.prototype, 'active', async function(this: RunnerState) {reads++; return read.call(this);});
    await core.init().catch(value => {error = value;});
    const journal = core['owner']?.['journal'];
    send({kind: 'replayed', busy: core.busy, error: code(error), reads,
      journalReason: journal?.reason, obligations: [...journal?.obligations.values() ?? []].map(row => ({runId: row.runId, stage: row.stage}))});
    await core.close();
    process.exit(0);
  }
  assert.equal(mode, 'observe');
  // Production now refuses this legacy recovery before scanning. Preserve the
  // historical diagnostic schedule in a raw S1 owner fixture, under the real
  // directory lock and an already durable S2 intent. This seam cannot retire
  // that intent. Fresh-process replay below uses normal production acquisition.
  const state = core['state'], lock = await acquireRunnerStorageLock(data);
  state.bindDirectory(lock);
  const owner = new RunnerStorageOwner(state, lock, () => {});
  core['owner'] = owner; core['ownerGeneration'] = owner.attach();
  core['active'] = owner.active; core['unrecovered'] = owner.unrecovered;
  core['recoveryFolders'] = owner.recoveryFolders; core['folders'] = owner.folders;
  const oldRows = await state.active();
  // The durable INTENT, Linux lock and retained owner above remain real. Only
  // the old observational process algorithm is evaluated as a Darwin seam;
  // explicitly retained Linux inspectors preserve the actual native lifetime
  // strings. A fresh replay worker below never installs this seam.
  Object.assign(processes, {
    table: async () => (await linuxProcessTable()).filter(row => !row.zombie),
    identity: (pid: number) => pid > 0 ? linuxProcessIdentity(pid) : Promise.resolve(null),
    inspectSync: (pid: number, deadline?: number) => {
      // This native reader deliberately checks its host platform. Evaluate
      // that synchronous observation on the actual host, then restore the
      // legacy algorithm seam before its continuation can run.
      Object.defineProperty(process, 'platform', {value: 'linux'});
      try {return inspectLinuxProcessSync(pid, deadline);}
      finally {Object.defineProperty(process, 'platform', {value: 'darwin'});}
    },
    inspect: async (pid: number) => {
      try {const row = await inspectLinuxProcess(pid); return row.zombie ? null : row;}
      catch (error) {if (error instanceof LinuxProcError && error.code === 'gone') return null; throw error;}
    },
  });
  Object.defineProperty(process, 'platform', {value: 'darwin'});
  const write = core['state'].writeActive.bind(core['state']);
  let reject!: (error: Error) => void;
  const held = new Promise<void>((_resolve, fail) => {reject = fail;});
  const snapshots: ActiveRun[][] = [];
  let physical = 0, maximumPhysical = 0;
  mock.method(core['state'], 'writeActive', async (rows: ActiveRun[]) => {
    snapshots.push(rows); physical++; maximumPhysical = Math.max(maximumPhysical, physical);
    try {if (snapshots.length === 1) await held; await write(rows);} finally {physical--;}
  });
  mock.timers.enable({apis: ['Date', 'setTimeout'], now: Date.now()});
  let initError: unknown, disconnected: unknown, tickDone = false;
  const initial = core.init().catch(error => {initError = error;});
  await until(() => snapshots.length === 1);
  const leader = Number(leaderText);
  assert(snapshots[0][0].processGroups?.some(group => group.pgid === leader && group.cleanupPending),
    'real native recovery must observe the new own-group before its publication is held');
  assert(!oldRows[0].processGroups?.some(group => group.pgid === leader), 'old disk must lack the observed group');
  const disconnect = core.disconnect().catch(error => {disconnected = error;});
  const tick = core.tick().then(() => {tickDone = true;});
  mock.timers.tick(PROCESS_CLEANUP_CAP_MS);
  await until(() => initError !== undefined && disconnected !== undefined && tickDone);
  await Promise.all([initial, disconnect, tick]);
  assert.equal(code(initError), 'RUNNER_STATE_UNAVAILABLE');
  assert.equal(code(disconnected), 'RUNNER_STATE_UNAVAILABLE');
  send({kind: 'observed', busy: core.busy, physical, maximumPhysical,
    observedGroup: leader, oldDiskHasGroup: false, initError: code(initError), disconnectError: code(disconnected)});
  await command('close-and-fail');
  await core.close();
  const completion = core['writes']!;
  const failed = assert.rejects(completion, {code: 'EIO'});
  reject(Object.assign(new Error('late observation publication EIO'), {code: 'EIO'}));
  await failed;
  assert.deepEqual(await state.active(), oldRows, 'the late EIO must leave the old durable bytes unchanged');
  assert.equal(core.busy, true, 'S1 must retain the failed observation in predecessor memory');
  send({kind: 'failed', busy: core.busy, physical, maximumPhysical, oldRowsUnchanged: true});
  await command('exit');
  // A new OS process is essential: merely constructing a new core would reuse
  // S1's retained owner and cannot demonstrate restart durability.
  process.exit(0);
} catch (error) {
  const failure = error instanceof Error ? error.stack : String(error);
  process.stderr.write(`${failure}\n`);
  // Some enclosing sandboxes capture child stderr independently. Preserve the
  // fixture assertion on its existing private channel before exiting.
  if (process.connected) process.send!({kind: 'fixture-error', failure}, () => process.exit(1));
  else process.exit(1);
}
