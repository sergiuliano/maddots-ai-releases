import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {LinuxProcError} from '../src/linux-proc.js';
import {PROCESS_CLEANUP_CAP_MS, ProcessCleanupError, recoverProcess, type ProcessGroup, type ProcessInspector} from '../src/runner/process.js';
import {directFixtureProcesses} from './native-process-fixture.js';

const supported = ['linux', 'darwin'].includes(process.platform);
const nativeLinuxHost = () => process.platform === 'linux';
const delay = () => new Promise<void>(resolve => setTimeout(resolve, 15));
async function until(check: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!await check()) {assert(Date.now() < deadline, message); await delay();}
}
async function nativeInspector(t: TestContext): Promise<ProcessInspector | undefined> {
  const inspector = directFixtureProcesses();
  try {
    await inspector.table();
    assert(await inspector.identity(process.pid));
    assert(inspector.inspectSync!(process.pid)?.startedAt);
    return inspector;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EACCES' &&
      !(error instanceof LinuxProcError && ['permission', 'unavailable'].includes(error.code)) &&
      !/operation not permitted|permission denied/iu.test(String(error))) throw error;
    t.skip(`Native process inspection unavailable or denied: ${String(error)}`);
    return undefined;
  }
}
async function absent(inspector: ProcessInspector, pid: number): Promise<boolean> {
  try {return !await inspector.identity(pid);}
  catch (error) {
    // Exit can interrupt a /proc snapshot. Retry rather than treating an
    // incomplete read as evidence that the process has gone.
    if (error instanceof LinuxProcError && ['malformed', 'race'].includes(error.code)) return false;
    throw error;
  }
}

for (const stale of ['leader', 'session'] as const) {
test(process.platform === 'linux' ? `S3 native Linux: stale same-PGID ${stale} metadata cannot authorize cleanup before or after a real late TERM birth` :
  `FIX18 native: stale same-PGID ${stale} ownership is refreshed before a crash and a real late TERM child stays pending`,
  {skip: !supported, timeout: 20_000}, async t => {
    const inspector = await nativeInspector(t);
    if (!inspector) return;
    const directory = await mkdtemp(join(tmpdir(), 'mdai-fix18-observed-'));
    const file = (name: string) => join(directory, name);
    const read = (name: string) => readFile(file(name), 'utf8').catch(() => '');
    const script = `
import os, signal, sys, time
directory = sys.argv[1]
same_lifetime_session = sys.argv[2] == 'session'
def put(name, value):
    with open(os.path.join(directory, name), 'w') as output: output.write(str(value))
def wait(name):
    while not os.path.exists(os.path.join(directory, name)): time.sleep(0.01)
tool = os.fork()
if tool:
    put('tool.pid', tool)
    wait('release-root')
    os._exit(0)
original_group = os.getpgrp()
if same_lifetime_session: os.setpgid(0, 0)
put('initial.sid', os.getsid(0))
put('initial', os.getpgrp())
wait('move')
if same_lifetime_session: os.setpgid(0, original_group)
os.setsid()
def term(_signal, _frame):
    orphan = os.fork()
    if orphan == 0:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        os.execve('/bin/sleep', ['sleep', '120'], {})
    put('orphan.pid', orphan)
    os._exit(0)
signal.signal(signal.SIGTERM, term)
put('moved', os.getsid(0))
while True: time.sleep(1)
`;
    const child = spawn('/usr/bin/python3', ['-c', script, directory, stale],
      {detached: true, stdio: 'ignore', env: {MDAI_RUN_FENCE: 'e'.repeat(32)}});
    let spawnError: unknown, tool = 0, orphan = 0;
    child.once('error', error => {spawnError = error;});
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    const signals = t.mock.method(process, 'kill');
    try {
      await until(async () => Boolean(await read('initial')) || Boolean(spawnError), 'Python fixture did not start');
      if (spawnError) {
        if ((spawnError as NodeJS.ErrnoException).code === 'ENOENT') {t.skip('Native fixture requires /usr/bin/python3'); return;}
        throw spawnError;
      }
      assert(child.pid);
      tool = Number(await read('tool.pid'));
      const original = await inspector.identity(child.pid), tracked = inspector.inspectSync!(tool);
      assert(original && tracked?.startedAt);
      assert.equal(tracked.pgid, stale === 'session' ? tool : child.pid);
      assert.equal(Number(await read('initial.sid')), child.pid);
      // The leader variant seeds an obsolete identity on the future PGID.
      // The session variant records the real own-group lifetime before it
      // rejoins the root's group and creates a new session under the same PID.
      // Neither requires native PID reuse.
      const obsolete = `${tracked.startedAt}:obsolete-group-leader`;
      const seeded: ProcessGroup[] = stale === 'leader' ? [
        {pgid: tool, startedAt: obsolete, cleanupPending: true},
        {pgid: child.pid, startedAt: original, members: [{pid: tool, startedAt: tracked.startedAt}]},
      ] : [
        {pgid: child.pid, startedAt: original},
        {pgid: tool, startedAt: tracked.startedAt, cleanupPending: true,
          members: [{pid: tool, startedAt: tracked.startedAt}],
          ...(process.platform === 'linux' ? {sid: String(child.pid), sessionLeader: {pid: child.pid, startedAt: original}} : {})},
      ];
      await writeFile(file('seeded.json'), JSON.stringify(seeded));
      await writeFile(file('move'), 'move');
      await until(async () => Number(await read('moved')) === tool, 'Tracked child did not create its own session');
      assert.equal(await inspector.identity(tool), tracked.startedAt, 'setsid preserves the native lifetime');
      await writeFile(file('release-root'), 'exit');
      await closed;

      if (nativeLinuxHost()) {
        const durableBytes = await read('seeded.json');
        const snapshots: ProcessGroup[][] = [];
        let recoveryReads = 0;
        const observing: ProcessInspector = {...inspector,
          table: async () => {recoveryReads++; return inspector.table();},
          identity: async pid => {recoveryReads++; return inspector.identity(pid);},
          inspectSync: (pid, deadline) => {recoveryReads++; return inspector.inspectSync!(pid, deadline);},
          inspect: async (pid, fence) => {recoveryReads++; return inspector.inspect!(pid, fence);}};
        const refuseRecovery = async () => {
          for (const reversed of [false, true]) {
            const restored: ProcessGroup[] = JSON.parse(durableBytes);
            if (reversed) restored.reverse();
            const before = JSON.stringify(restored);
            await assert.rejects(recoverProcess(child.pid!, original, observing, undefined, restored,
              groups => {snapshots.push(structuredClone(groups));}), ProcessCleanupError);
            assert.equal(JSON.stringify(restored), before, 'a crash replay cannot rewrite either original obligation');
          }
          assert.deepEqual(snapshots, [], 'native observations cannot publish Linux ownership or retirement');
          assert.equal(recoveryReads, 0, 'legacy recovery cannot consult any native observation as Linux authority');
          assert.equal(await read('seeded.json'), durableBytes, 'the historical durable bytes remain unchanged');
        };
        await refuseRecovery();
        assert.equal(signals.mock.callCount(), 0, 'legacy rows cannot reach any native cleanup signal');
        assert.equal(await inspector.identity(tool), tracked.startedAt);
        // The fixture, rather than production recovery, triggers the actual
        // TERM-handler fork. This preserves the native birth/exit scenario
        // while historical metadata remains powerless on Linux.
        process.kill(tool, 'SIGTERM');
        await until(async () => Boolean(await read('orphan.pid')), 'Fixture TERM handler did not publish its child');
        orphan = Number(await read('orphan.pid'));
        assert(orphan > 1 && await inspector.identity(orphan), 'the real env-cleared TERM child remains alive');
        await until(async () => (await readFile(`/proc/${orphan}/environ`)).length === 0,
          'Fixture TERM child did not exec with an empty environment');
        const afterFixtureTerm = signals.mock.callCount();
        await refuseRecovery();
        assert.equal(signals.mock.callCount(), afterFixtureTerm, 'restart cannot acquire authority over the live survivor');
        assert(await inspector.identity(orphan));
        process.kill(orphan, 'SIGKILL');
        await until(() => absent(inspector, orphan), 'Fixture child did not exit after teardown');
        const afterFixtureKill = signals.mock.callCount();
        await refuseRecovery();
        assert.equal(signals.mock.callCount(), afterFixtureKill, 'an empty native observation cannot retire legacy Linux responsibility');
        return;
      }

      let crashSnapshot: ProcessGroup[] | undefined;
      const persistedSeed: ProcessGroup[] = JSON.parse(await read('seeded.json'));
      await assert.rejects(recoverProcess(child.pid, original, inspector, undefined, persistedSeed, async groups => {
        if (crashSnapshot) throw new Error('Fixture crash after durable discovery');
        const observed = groups.find(group => group.pgid === tool);
        if (observed?.cleanupPending && observed.members?.some(member => member.pid === tool && member.startedAt === tracked.startedAt)) {
          crashSnapshot = structuredClone(groups);
          await writeFile(file('groups.json'), JSON.stringify(crashSnapshot));
          throw new Error('Fixture crash after durable discovery');
        }
      }), ProcessCleanupError);
      assert(crashSnapshot, 'the actual persistence callback captures observed ownership before the injected crash');
      assert.equal(signals.mock.callCount(), 0, 'a failed discovery save cannot send any native signal');
      const durable: ProcessGroup[] = JSON.parse(await read('groups.json'));
      const observed = durable.find(group => group.pgid === tool);
      assert.equal(observed?.startedAt, tracked.startedAt, 'the current verified own leader replaces stale same-PGID authority');
      assert(observed?.cleanupPending);
      if (process.platform === 'linux') {
        assert.equal(observed.sid, String(tool));
        assert.deepEqual(observed.sessionLeader, {pid: tool, startedAt: tracked.startedAt});
      }

      let saved = durable;
      const persist = async (groups: ProcessGroup[]) => {
        saved = structuredClone(groups);
        await writeFile(file('groups.json'), JSON.stringify(saved));
      };
      await assert.rejects(recoverProcess(child.pid, original, inspector, undefined, durable, persist,
        Date.now() - PROCESS_CLEANUP_CAP_MS + 2500), ProcessCleanupError);
      orphan = Number(await read('orphan.pid'));
      assert(orphan > 1 && await inspector.identity(orphan), 'the real env-cleared TERM child remains alive');
      assert(signals.mock.calls.some(call => call.arguments[0] === -tool && call.arguments[1] === 'SIGTERM'),
        'recovery authorizes native TERM for the freshly persisted own group');
      assert(saved.some(group => group.pgid === tool && group.cleanupPending), 'the live unproven child retains the cleanup obligation');
      const pending: ProcessGroup[] = JSON.parse(await read('groups.json'));
      const signalCount = signals.mock.callCount();
      await assert.rejects(recoverProcess(child.pid, original, inspector, undefined, pending, persist,
        Date.now() - PROCESS_CLEANUP_CAP_MS + 1200), ProcessCleanupError);
      assert.equal(signals.mock.callCount(), signalCount, 'restart does not turn cleanupPending into native signal authority');
      assert(saved.some(group => group.pgid === tool && group.cleanupPending));
      process.kill(orphan, 'SIGKILL');
      await until(() => absent(inspector, orphan), 'Fixture child did not exit after teardown');
      assert.equal(await recoverProcess(child.pid, original, inspector, undefined, saved, persist), true);
      assert.deepEqual(saved, [], 'a complete absence scan retires the durable obligation');
    } finally {
      signals.mock.restore();
      tool ||= Number(await read('tool.pid'));
      orphan ||= Number(await read('orphan.pid'));
      for (const pid of [child.pid, tool, orphan]) if (pid && pid > 1) {
        try {process.kill(pid, 'SIGKILL');} catch (error) {assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH');}
      }
      await closed;
      await rm(directory, {recursive: true, force: true});
    }
  });
}

test('FIX18 hybrid native: a cached owned-leader row cannot adopt a real unrelated group peer',
  {skip: !supported, timeout: 10_000}, async t => {
    const native = await nativeInspector(t);
    if (!native) return;
    const directory = await mkdtemp(join(tmpdir(), 'mdai-fix18-cached-'));
    const read = (name: string) => readFile(join(directory, name), 'utf8').catch(() => '');
    const script = `
import os, sys, time
directory = sys.argv[1]
intermediate = os.fork()
if intermediate == 0:
    peer = os.fork()
    if peer == 0: os.execve('/bin/sleep', ['sleep', '120'], {})
    with open(os.path.join(directory, 'peer.pid'), 'w') as output: output.write(str(peer))
    os._exit(0)
os.waitpid(intermediate, 0)
with open(os.path.join(directory, 'ready'), 'w') as output: output.write(str(os.getpid()))
while True: time.sleep(1)
`;
    const child = spawn('/usr/bin/python3', ['-c', script, directory], {detached: true, stdio: 'ignore', env: {}});
    let spawnError: unknown, peer = 0;
    child.once('error', error => {spawnError = error;});
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    let signals: ReturnType<typeof t.mock.method<typeof process, 'kill'>> | undefined;
    try {
      await until(async () => Boolean(await read('ready')) || Boolean(spawnError), 'Python cached-table fixture did not start');
      if (spawnError) {
        if ((spawnError as NodeJS.ErrnoException).code === 'ENOENT') {t.skip('Native fixture requires /usr/bin/python3'); return;}
        throw spawnError;
      }
      assert(child.pid);
      const leader = child.pid;
      peer = Number(await read('peer.pid'));
      const actualLeader = native.inspectSync!(leader), actualPeer = native.inspectSync!(peer);
      assert(actualLeader?.startedAt && actualPeer?.startedAt);
      assert.equal(actualLeader.pgid, leader);
      assert.equal(actualPeer.pgid, leader);
      assert.notEqual(actualPeer.ppid, leader, 'the real unrelated peer is already reparented');
      const cachedOwnedStart = `${actualLeader.startedAt}:earlier-owned-lifetime`;
      let synchronousChecks = 0, cachedReads = 0;
      const inspector: ProcessInspector = {
        ...native,
        // Portable tests cannot force numeric PID/PGID reuse. Only this cached
        // leader field is synthetic; peer identity and every final inspection
        // still come from the real running processes.
        table: async () => {cachedReads++; return (await native.table()).filter(row => row.pid === leader || row.pid === peer)
          .map(row => row.pid === leader ? {...row, startedAt: cachedOwnedStart} : row);},
        inspectSync: (pid, deadline) => {synchronousChecks++; return native.inspectSync!(pid, deadline);},
      };
      const snapshots: ProcessGroup[][] = [];
      signals = t.mock.method(process, 'kill', () => {assert.fail('A cached table row must not authorize a native signal');});
      const saved: ProcessGroup[] = [{pgid: 2_147_000_000, startedAt: 'departed-original-group',
        members: [{pid: leader, startedAt: cachedOwnedStart}]}];
      if (process.platform === 'linux') {
        const persisted = JSON.stringify(saved);
        await assert.rejects(recoverProcess(0, '', inspector, undefined, saved,
          groups => {snapshots.push(structuredClone(groups));}), ProcessCleanupError);
        assert.equal(synchronousChecks, 0, 'Linux cannot derive signal authority from a final identity read');
        assert.equal(cachedReads, 0, 'Linux cannot adopt a real unrelated peer from a cached table');
        assert.deepEqual(snapshots, [], 'a real unrelated peer cannot become durable Linux ownership evidence');
        assert.equal(JSON.stringify(saved), persisted);
        await assert.rejects(recoverProcess(0, '', inspector, undefined, JSON.parse(persisted)), ProcessCleanupError);
      } else {
        try {
          await recoverProcess(0, '', inspector, undefined, saved, groups => {snapshots.push(structuredClone(groups));},
            Date.now() - PROCESS_CLEANUP_CAP_MS + 1000);
        } catch (error) {assert(error instanceof ProcessCleanupError);}
        assert(synchronousChecks > 0, 'the regression keeps native synchronous lifetime checks active');
        assert(snapshots.length > 0);
      }
      assert.equal(signals.mock.callCount(), 0);
      assert(snapshots.every(groups => groups.every(group => !group.members?.some(member => member.pid === peer))),
        'the real unrelated peer never becomes durable ownership evidence');
      assert.equal(await native.identity(leader), actualLeader.startedAt);
      assert.equal(await native.identity(peer), actualPeer.startedAt);
    } finally {
      signals?.mock.restore();
      peer ||= Number(await read('peer.pid'));
      for (const pid of [child.pid, peer]) if (pid && pid > 1) {
        try {process.kill(pid, 'SIGKILL');} catch (error) {assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH');}
      }
      await closed;
      await rm(directory, {recursive: true, force: true});
    }
  });
