import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {inspectLinuxProcess, LinuxProcError, linuxFencePids, linuxProcessIdentity, linuxProcessIdentityFrom,
  linuxProcessTable, type LinuxProcOptions} from '../src/linux-proc.js';
import {atomicWrite} from '../src/paths.js';
import {ProcessCleanupError, recoverProcess, type ProcessGroup, type ProcessInspector} from '../src/runner/process.js';

const boot = '12345678-1234-1234-1234-123456789abc';
const fence = 'b'.repeat(32), rootPid = 900_240, memberPid = 900_241, uid = 1000;
const startedAt = linuxProcessIdentityFrom(boot, '12345');

function statText(pid: number, ticks = '12345'): string {
  const fields = Array<string>(49).fill('0');
  fields[0] = String(pid === rootPid ? 1 : rootPid);
  fields[1] = fields[2] = String(rootPid); fields[18] = ticks;
  return `${pid} (fixture) S ${fields.join(' ')}\n`;
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-linux-parser-recovery-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, 'sys/kernel/random'), {recursive: true});
  await writeFile(join(root, 'sys/kernel/random/boot_id'), `${boot}\n`);
  for (const pid of [rootPid, memberPid]) {
    await mkdir(join(root, String(pid)));
    await writeFile(join(root, String(pid), 'stat'), statText(pid));
    await writeFile(join(root, String(pid), 'status'), `Pid:\t${pid}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
    await writeFile(join(root, String(pid), 'environ'), Buffer.from(`MDAI_RUN_FENCE=${fence}\u0000`));
  }
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', {...descriptor, value: 'linux'});
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
  const signals: {pid: number; signal?: NodeJS.Signals | number}[] = [];
  t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {signals.push({pid, signal}); return true;});
  const malformed = {identity: 0, table: 0, fence: 0};
  let inspectionCalls = 0;
  const observe = async <T>(kind: keyof typeof malformed, action: () => Promise<T>): Promise<T> => {
    inspectionCalls++;
    try {return await action();}
    catch (error) {if (error instanceof LinuxProcError && error.code === 'malformed') malformed[kind]++; throw error;}
  };
  const options: LinuxProcOptions = {root, uid};
  const inspector: ProcessInspector = {
    identity: pid => observe('identity', () => linuxProcessIdentity(pid, options)),
    table: () => observe('table', async () => (await linuxProcessTable(options)).filter(row => !row.zombie)),
    fencePids: (value, deadline) => observe('fence', () => linuxFencePids(value, deadline, options)),
    fenceEntries: (value, deadline) => observe('fence', async () =>
      (await linuxProcessTable({...options, fence: value, deadline})).filter(row => !row.zombie && row.fenceMatch)),
    inspect: async (pid, value) => {
      inspectionCalls++;
      try {const row = await inspectLinuxProcess(pid, {...options, fence: value}); return row.zombie ? null : row;}
      catch (error) {if (error instanceof LinuxProcError && error.code === 'gone') return null; throw error;}
    },
    signalGroup: (pid, signal) => {signals.push({pid: -pid, signal});},
  };
  return {root, inspector, signals, malformed, inspectionCalls: () => inspectionCalls};
}

const malformedLifetimes = [
  ['missing-start-ticks', ''],
  ['unavailable-start-ticks', 'unavailable'],
  ['overflow-start-ticks', '18446744073709551616'],
] as const;

for (const inspection of ['identity', 'table', 'fence'] as const) {
  for (const [tag, ticks] of malformedLifetimes) {
    test(`Linux ${inspection} rejects ${tag} without signalling or pruning legacy ownership`, async t => {
      const f = await fixture(t), target = inspection === 'identity' ? rootPid : memberPid;
      await writeFile(join(f.root, String(target), 'stat'), statText(target, ticks));
      const saved: ProcessGroup[] = [{pgid: rootPid, startedAt, sid: String(rootPid),
        members: [{pid: memberPid, startedAt}]}];
      const ledger = join(f.root, 'saved-groups.json');
      await atomicWrite(ledger, JSON.stringify(saved));
      const before = await readFile(ledger, 'utf8');
      const parse = () => inspection === 'identity' ? f.inspector.identity(rootPid) :
        inspection === 'table' ? f.inspector.table() : f.inspector.fencePids!(fence);
      // The diagnostic readers still reject incomplete lifetimes, including
      // repeated observations. S3 never promotes those readers to authority.
      for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(parse(), error => error instanceof LinuxProcError && error.code === 'malformed');
      }
      assert.equal(f.malformed[inspection], 2);
      const reads = f.inspectionCalls();
      const persisted: ProcessGroup[][] = [];
      await assert.rejects(recoverProcess(rootPid, startedAt, f.inspector,
        inspection === 'fence' ? fence : undefined, saved, async groups => {
          persisted.push(structuredClone(groups)); await atomicWrite(ledger, JSON.stringify(groups));
        }), error => error instanceof ProcessCleanupError && error.code === 'tool_failed');
      assert.equal(f.inspectionCalls(), reads, 'legacy recovery cannot consult a diagnostic snapshot as Linux authority');
      assert.deepEqual(persisted, [], 'legacy recovery cannot publish retirement or replace saved ownership');
      assert.equal(await readFile(ledger, 'utf8'), before, 'saved ownership remains durable after rejection');
      assert.deepEqual(saved[0].members, [{pid: memberPid, startedAt}], 'caller ownership evidence is unchanged');
      assert.deepEqual(f.signals, [], 'a malformed snapshot cannot authorize group or individual PID signals');
    });
  }
}

test('Linux complete and empty process snapshots cannot authorize legacy recovery or clear saved ownership', async t => {
  const f = await fixture(t);
  const saved: ProcessGroup[] = [{pgid: rootPid, startedAt, sid: String(rootPid), members: [{pid: memberPid, startedAt}]}];
  const ledger = join(f.root, 'saved-groups.json');
  await atomicWrite(ledger, JSON.stringify(saved));
  const before = await readFile(ledger, 'utf8');
  assert.equal(await f.inspector.identity(rootPid), startedAt);
  assert.deepEqual((await f.inspector.table()).map(row => row.pid).sort(), [rootPid, memberPid]);
  assert.deepEqual((await f.inspector.fencePids!(fence)).sort(), [rootPid, memberPid]);
  for (const exited of [false, true]) {
    if (exited) {
      for (const pid of [rootPid, memberPid]) await rm(join(f.root, String(pid)), {recursive: true});
      assert.equal(await f.inspector.identity(rootPid), null);
      assert.deepEqual(await f.inspector.table(), []);
      assert.deepEqual(await f.inspector.fencePids!(fence), []);
    }
    const reads = f.inspectionCalls();
    let publications = 0;
    await assert.rejects(recoverProcess(rootPid, startedAt, f.inspector, fence, saved, async groups => {
      publications++; await atomicWrite(ledger, JSON.stringify(groups));
    }), error => error instanceof ProcessCleanupError && error.code === 'tool_failed');
    assert.equal(f.inspectionCalls(), reads, 'complete or empty diagnostic scans cannot retire a Linux migration obligation');
    assert.equal(publications, 0);
    assert.equal(await readFile(ledger, 'utf8'), before);
    assert.deepEqual(saved, JSON.parse(before));
    assert.deepEqual(f.signals, [], 'legacy ownership cannot authorize a signal before or after native exit');
  }
  assert.deepEqual(f.malformed, {identity: 0, table: 0, fence: 0});
});
