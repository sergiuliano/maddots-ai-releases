import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {LinuxProcError} from '../src/linux-proc.js';
import {PROCESS_CLEANUP_CAP_MS, ProcessCleanupError, recoverProcess, type ProcessEntry, type ProcessGroup, type ProcessInspector} from '../src/runner/process.js';
import {directFixtureProcesses} from './native-process-fixture.js';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
async function advanceTime(t: TestContext, milliseconds = PROCESS_CLEANUP_CAP_MS): Promise<void> {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 25) {
    t.mock.timers.tick(Math.min(25, milliseconds - elapsed));
    await flush();
  }
}
function platform(t: TestContext, value: 'linux' | 'darwin'): void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', {...original, value});
  t.after(() => Object.defineProperty(process, 'platform', original));
}
const result = <T>(promise: Promise<T>) => promise.then(value => ({ok: true as const, value}), error => ({ok: false as const, error}));

// Linux historical rows remain unresolved in runner-linux-recovery-authority.test.ts.
for (const host of ['darwin'] as ('linux' | 'darwin')[]) {
  for (const transition of ['group', 'session'] as const) {
    test(`FIX17: an observed own ${transition} keeps late TERM descendants pending across restart on ${host}`, async t => {
      platform(t, host);
      t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
      const root = 930_100, tool = root + 1, orphan = root + 2;
      const sid = String(transition === 'session' ? tool : root);
      let rows: ProcessEntry[] = [{pid: tool, ppid: 1, pgid: tool, sid, startedAt: 'same-tool-lifetime'}];
      let saved: ProcessGroup[] = [{pgid: root, startedAt: 'departed-root',
        members: [{pid: tool, startedAt: 'same-tool-lifetime'}]}];
      const snapshots: ProcessGroup[][] = [];
      const signals: {target: number; signal: NodeJS.Signals | number | undefined; saved: ProcessGroup[]}[] = [];
      const send = (target: number, signal?: NodeJS.Signals | number) => {
        signals.push({target, signal, saved: structuredClone(saved)});
        if ((target === tool || target === -tool) && signal === 'SIGTERM') {
          // The handler forks after delivery, drops its inherited fence and
          // exits before the next scan can establish the child's ancestry.
          rows = [{pid: orphan, ppid: 1, pgid: tool, sid, startedAt: 'late-env-cleared-child'}];
        }
        return true;
      };
      t.mock.method(process, 'kill', send);
      const inspector: ProcessInspector = {
        table: async () => structuredClone(rows),
        identity: async pid => rows.find(row => row.pid === pid)?.startedAt ?? null,
        inspectSync: pid => rows.find(row => row.pid === pid) ?? null,
        fencePids: async () => [],
        signalGroup: (pgid, signal) => {send(-pgid, signal);},
      };
      const persist = (groups: ProcessGroup[]) => {saved = structuredClone(groups); snapshots.push(saved);};
      const recovery = result(recoverProcess(root, 'departed-root', inspector, 'a'.repeat(32), saved, persist));
      await advanceTime(t);
      const outcome = await recovery;
      assert.equal(outcome.ok, false, 'cleanup cannot claim success while the late child is alive');
      if (!outcome.ok) assert(outcome.error instanceof ProcessCleanupError);
      assert.deepEqual(signals.map(({target, signal}) => ({target, signal})), [{target: -tool, signal: 'SIGTERM'}],
        'the authenticated own group can receive TERM, but its unproven late child cannot authorize another signal');
      const observed = signals[0].saved.find(group => group.pgid === tool);
      assert(observed?.cleanupPending, 'the new group obligation is durable before TERM');
      assert.equal(observed.startedAt, 'same-tool-lifetime');
      assert(observed.members?.some(member => member.pid === tool && member.startedAt === 'same-tool-lifetime'));
      if (host === 'linux') {
        assert.equal(observed.sid, sid);
        if (transition === 'session') assert.deepEqual(observed.sessionLeader, {pid: tool, startedAt: 'same-tool-lifetime'});
      } else {
        assert.equal(observed.sid, undefined);
        assert.equal(observed.sessionLeader, undefined);
      }
      assert(snapshots.some(groups => groups.some(group => group.pgid === root) && groups.some(group => group.pgid === tool)),
        'observing the new group preserves the original ledger until absence is checked');
      assert(saved.some(group => group.pgid === tool && group.cleanupPending));
      assert.deepEqual(rows.map(row => row.pid), [orphan]);
      const signalCount = signals.length;
      const restarted = result(recoverProcess(root, 'departed-root', inspector, undefined, [...saved].reverse(), persist));
      await advanceTime(t);
      const restartedOutcome = await restarted;
      assert.equal(restartedOutcome.ok, false, 'saved cleanupPending survives a fresh recovery without a fence');
      if (!restartedOutcome.ok) assert(restartedOutcome.error instanceof ProcessCleanupError);
      assert.equal(signals.length, signalCount, 'durability alone never grants signalling authority');
      assert(saved.some(group => group.pgid === tool && group.cleanupPending));
      rows = [];
      assert.equal(await recoverProcess(root, 'departed-root', inspector, undefined, saved, persist), true);
      assert.deepEqual(saved, [], 'a complete absence scan retires both ledgers');
    });
  }

  test(`FIX17: an own group with still-identified members is cleaned on ${host}`, async t => {
    platform(t, host);
    t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
    const root = 930_200, tool = root + 1, peer = root + 2;
    let rows: ProcessEntry[] = [
      {pid: tool, ppid: 1, pgid: tool, sid: String(tool), startedAt: 'owned-tool'},
      {pid: peer, ppid: tool, pgid: tool, sid: String(tool), startedAt: 'owned-peer'},
    ];
    let saved: ProcessGroup[] = [{pgid: root, startedAt: 'departed-root', members: [{pid: tool, startedAt: 'owned-tool'}]}];
    const signals: number[] = [];
    const inspector: ProcessInspector = {
      table: async () => structuredClone(rows),
      identity: async pid => rows.find(row => row.pid === pid)?.startedAt ?? null,
      inspectSync: pid => rows.find(row => row.pid === pid) ?? null,
      fencePids: async () => [],
      signalGroup: pgid => {
        assert(saved.some(group => group.pgid === tool && group.cleanupPending && group.members?.some(member => member.pid === peer)),
          'observed peers are durable before the whole group is signalled');
        signals.push(pgid); rows = [];
      },
    };
    t.mock.method(process, 'kill', () => assert.fail('the verified own group covers both lifetimes'));
    const recovery = result(recoverProcess(root, 'departed-root', inspector, undefined, saved, groups => {saved = groups;}));
    await advanceTime(t, 500);
    assert.deepEqual(await recovery, {ok: true, value: true});
    assert.deepEqual(signals, [tool]);
    assert.deepEqual(saved, []);
  });

  test(`FIX17: ancestry plus a null current lifetime cannot adopt a tracked PID's new group on ${host}`, async t => {
    platform(t, host);
    t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
    const root = 930_300, tool = root + 1;
    let rootAlive = true;
    const snapshots: ProcessGroup[][] = [], signals: number[] = [];
    const rows = (): ProcessEntry[] => [
      ...(rootAlive ? [{pid: root, ppid: 1, pgid: root, startedAt: 'root-start'}] : []),
      {pid: tool, ppid: rootAlive ? root : 1, pgid: tool},
    ];
    const inspector: ProcessInspector = {
      table: async () => rows(),
      identity: async pid => pid === root && rootAlive ? 'root-start' : null,
      inspectSync: pid => rows().find(row => row.pid === pid) ?? null,
      fencePids: async () => [],
      signalGroup: pgid => {signals.push(pgid); if (pgid === root) rootAlive = false;},
    };
    t.mock.method(process, 'kill', () => assert.fail('an unresolved current lifetime cannot receive PID cleanup'));
    const recovery = result(recoverProcess(root, 'root-start', inspector, undefined,
      [{pgid: root, startedAt: 'root-start', members: [{pid: tool, startedAt: 'saved-tool'}]}], groups => {snapshots.push(groups);}));
    await advanceTime(t);
    const outcome = await recovery;
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert(outcome.error instanceof ProcessCleanupError);
    assert.deepEqual(signals, [root]);
    assert(snapshots.every(groups => groups.every(group => group.pgid !== tool)),
      'a changed PGID requires positively verified current identity even while ancestry is visible');
  });

  test(`FIX17: an observed own group reused during persistence receives no signal on ${host}`, async t => {
    platform(t, host);
    t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
    const root = 930_400, tool = root + 1, peer = root + 2;
    let reused = false;
    const rows = (): ProcessEntry[] => [
      {pid: tool, ppid: 1, pgid: tool, sid: String(tool), startedAt: reused ? 'replacement-tool' : 'saved-tool'},
      ...(reused ? [{pid: peer, ppid: tool, pgid: tool, sid: String(tool), startedAt: 'replacement-peer'}] : []),
    ];
    const snapshots: ProcessGroup[][] = [];
    const inspector: ProcessInspector = {
      table: async () => structuredClone(rows()),
      identity: async pid => rows().find(row => row.pid === pid)?.startedAt ?? null,
      inspectSync: pid => rows().find(row => row.pid === pid) ?? null,
      fencePids: async () => [],
      signalGroup: () => assert.fail('the final synchronous identity check must reject a reused group witness'),
    };
    t.mock.method(process, 'kill', () => assert.fail('a reused PID must not receive cleanup'));
    const recovery = result(recoverProcess(root, 'departed-root', inspector, undefined,
      [{pgid: root, startedAt: 'departed-root', members: [{pid: tool, startedAt: 'saved-tool'}]}], groups => {
        snapshots.push(groups);
        if (groups.some(group => group.pgid === tool && group.cleanupPending)) reused = true;
      }));
    await advanceTime(t, 500);
    assert.deepEqual(await recovery, {ok: true, value: true});
    assert(reused, 'the lifetime changes after the own group was observed and persisted');
    assert(snapshots.every(groups => groups.every(group => !group.members?.some(member => member.pid === peer))),
      'replacement peers never become durable ownership evidence');
  });
}

// Linux historical rows remain unresolved in runner-linux-recovery-authority.test.ts.
for (const host of ['darwin'] as ('linux' | 'darwin')[]) {
  test(`FIX18: newly discovered ancestry replaces an obsolete own-group ledger on ${host}`, async t => {
    platform(t, host);
    t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
    const root = 931_001, tool = root + 1, orphan = root + 2;
    let rows: ProcessEntry[] = [
      {pid: root, ppid: 1, pgid: root, startedAt: 'owned-root'},
      {pid: tool, ppid: root, pgid: tool, sid: String(tool), startedAt: 'new-child'},
    ];
    let saved: ProcessGroup[] = [{pgid: root, startedAt: 'owned-root'}, {pgid: tool, startedAt: 'obsolete-child'}];
    const signals: number[] = [];
    const inspector: ProcessInspector = {
      table: async () => structuredClone(rows), identity: async pid => rows.find(row => row.pid === pid)?.startedAt ?? null,
      inspectSync: pid => rows.find(row => row.pid === pid) ?? null, fencePids: async () => [],
      signalGroup: pgid => {
        signals.push(pgid);
        assert(saved.some(group => group.pgid === tool && group.startedAt === 'new-child' && group.cleanupPending));
        rows = pgid === root ? rows.filter(row => row.pid !== root).map(row => ({...row, ppid: 1})) :
          [{pid: orphan, ppid: 1, pgid: tool, sid: String(tool), startedAt: 'late-child'}];
      },
    };
    t.mock.method(process, 'kill', () => assert.fail('new ancestry must establish its own-group obligation before TERM'));
    const recovering = result(recoverProcess(root, 'owned-root', inspector, undefined, saved, groups => {saved = groups;}));
    await advanceTime(t);
    const outcome = await recovering;
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert(outcome.error instanceof ProcessCleanupError);
    assert.deepEqual(signals, [root, tool]);
    assert(saved.some(group => group.pgid === tool && group.startedAt === 'new-child' && group.cleanupPending));
  });

  test(`FIX18: a stale newly discovered own leader cannot authenticate replacement descendants on ${host}`, async t => {
    platform(t, host);
    t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
    const root = 931_005, tool = root + 1, peer = root + 2;
    const live: ProcessEntry[] = [
      {pid: root, ppid: 1, pgid: root, startedAt: 'owned-root'},
      {pid: tool, ppid: 1, pgid: tool, startedAt: 'replacement-leader'},
      {pid: peer, ppid: tool, pgid: tool, startedAt: 'unrelated-peer'},
    ];
    const snapshots: ProcessGroup[][] = [];
    const inspector: ProcessInspector = {
      table: async () => live.map(row => row.pid === tool ? {...row, ppid: root, startedAt: 'departed-child'} : {...row}),
      identity: async pid => live.find(row => row.pid === pid)?.startedAt ?? null,
      inspectSync: pid => live.find(row => row.pid === pid) ?? null, fencePids: async () => [],
      signalGroup: () => assert.fail('contradicted ancestry must abandon the partial scan'),
    };
    t.mock.method(process, 'kill', () => assert.fail('a replacement descendant is unrelated'));
    const recovering = result(recoverProcess(root, 'owned-root', inspector, undefined, [], groups => {snapshots.push(groups);}));
    await advanceTime(t);
    const outcome = await recovering;
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert(outcome.error instanceof ProcessCleanupError);
    assert(snapshots.every(groups => groups.every(group => !group.members?.some(member => member.pid === peer || member.pid === tool))));
  });

  for (const interruption of ['exit', 'later inspection failure'] as const) {
  test(`FIX18: ${interruption} cannot erase a verified own-group observation before persistence on ${host}`, async t => {
    platform(t, host);
    t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
    const root = 931_020, tool = root + 1, orphan = root + 2, other = root + 3;
    let rows: ProcessEntry[] = [{pid: tool, ppid: 1, pgid: tool, sid: String(tool), startedAt: 'owned-tool'}];
    let saved: ProcessGroup[] = [{pgid: root, startedAt: 'old-root', members: [{pid: tool, startedAt: 'owned-tool'}]}];
    let failed = false;
    if (interruption === 'later inspection failure') {
      rows.push({pid: other, ppid: 1, pgid: other, startedAt: 'owned-other'});
      saved[0].members!.push({pid: other, startedAt: 'owned-other'});
    }
    const inspector: ProcessInspector = {
      table: async () => structuredClone(rows), identity: async pid => rows.find(row => row.pid === pid)?.startedAt ?? null,
      inspectSync: pid => {
        const observed = rows.find(row => row.pid === pid) ?? null;
        if (observed?.pid === tool) rows = [...rows.filter(row => row.pid !== tool), {pid: orphan, ppid: 1, pgid: tool, sid: String(tool), startedAt: 'late-child'}];
        if (pid === other && !failed) {failed = true; throw new Error('later process inspection failed');}
        return observed;
      },
      fencePids: async () => [], signalGroup: pgid => {
        assert.equal(pgid, other, 'the first observed leader has already exited');
        rows = rows.filter(row => row.pid !== other);
      },
    };
    t.mock.method(process, 'kill', () => assert.fail('the observed leader has already exited'));
    const recovering = result(recoverProcess(root, 'old-root', inspector, undefined, saved, groups => {saved = groups;}));
    await advanceTime(t);
    const outcome = await recovering;
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert(outcome.error instanceof ProcessCleanupError);
    assert(saved.some(group => group.pgid === tool && group.startedAt === 'owned-tool' && group.cleanupPending));
    if (interruption === 'later inspection failure') assert(failed);
  });
  }

  for (const reader of ['table', 'inspect'] as const) {
    test(`FIX18: incomplete ${reader} leader evidence cannot lose the own-group obligation on ${host}`, async t => {
      platform(t, host);
      t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
      const root = 931_010, tool = root + 1;
      const row: ProcessEntry = {pid: tool, ppid: 1, pgid: tool, sid: String(tool)};
      let saved: ProcessGroup[] = [{pgid: root, startedAt: 'departed-root', members: [{pid: tool, startedAt: 'owned-tool'}]}];
      const inspector: ProcessInspector = {
        table: async () => [row], identity: async pid => pid === tool ? 'owned-tool' : null,
        ...(reader === 'inspect' ? {inspect: async () => row} : {}),
        fencePids: async () => [], signalGroup: () => assert.fail('incomplete evidence cannot authorize group TERM'),
      };
      t.mock.method(process, 'kill', () => assert.fail('PID-only TERM could lose late children from this observed group'));
      const recovering = result(recoverProcess(root, 'departed-root', inspector, undefined, saved, groups => {saved = groups;}));
      await advanceTime(t);
      const outcome = await recovering;
      assert.equal(outcome.ok, false);
      if (!outcome.ok) assert(outcome.error instanceof ProcessCleanupError);
      assert(saved.some(group => group.members?.some(member => member.pid === tool && member.startedAt === 'owned-tool')));
    });
  }

  test(`FIX18: a tracked leader's new session refreshes its same-lifetime group obligation on ${host}`, async t => {
    platform(t, host);
    t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
    const root = 931_050, tool = root + 1, orphan = root + 2;
    let rows: ProcessEntry[] = [{pid: tool, ppid: 1, pgid: tool, sid: String(tool), startedAt: 'same-tool'}];
    let saved: ProcessGroup[] = [
      {pgid: root, startedAt: 'old-root', members: [{pid: tool, startedAt: 'same-tool'}]},
      {pgid: tool, startedAt: 'same-tool', sid: String(root), cleanupPending: true},
    ];
    const signals: number[] = [];
    const inspector: ProcessInspector = {
      table: async () => structuredClone(rows),
      identity: async pid => rows.find(row => row.pid === pid)?.startedAt ?? null,
      inspectSync: pid => rows.find(row => row.pid === pid) ?? null,
      fencePids: async () => [],
      signalGroup: pgid => {
        signals.push(pgid);
        const observed = saved.find(group => group.pgid === tool)!;
        assert(observed.cleanupPending);
        if (host === 'linux') {
          assert.equal(observed.sid, String(tool));
          assert.deepEqual(observed.sessionLeader, {pid: tool, startedAt: 'same-tool'});
        }
        rows = [{pid: orphan, ppid: 1, pgid: tool, sid: String(tool), startedAt: 'late-child'}];
      },
    };
    t.mock.method(process, 'kill', () => assert.fail('the new session must receive group cleanup'));
    const recovering = result(recoverProcess(root, 'old-root', inspector, undefined, saved, groups => {saved = groups;}));
    await advanceTime(t);
    const outcome = await recovering;
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert(outcome.error instanceof ProcessCleanupError);
    assert.deepEqual(signals, [tool]);
    assert(saved.some(group => group.pgid === tool && group.cleanupPending));
  });

  for (const lineage of ['moved', 'own', 'root'] as const) for (const reparented of [true, false]) {
  test(`FIX18: a non-atomic reused ${lineage} group table cannot adopt unrelated ${reparented ? 'orphan' : 'child'} peers on ${host}`, async t => {
    platform(t, host);
    t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
    const root = 931_100, tool = root + 1, peer = root + 2;
    // Linux can enumerate a PID before it exits, then read its replacement
    // after the old group/session and the leader's number have been reused.
    const current: ProcessEntry[] = [
      {pid: tool, ppid: 1, pgid: tool, sid: String(tool), startedAt: 'replacement-leader'},
      {pid: peer, ppid: reparented ? 1 : tool, pgid: tool, sid: String(tool), startedAt: 'unrelated-reused-peer'},
    ];
    let tables = 0;
    const snapshots: ProcessGroup[][] = [], signals: number[] = [];
    const inspector: ProcessInspector = {
      table: async () => {
        const rows = structuredClone(current);
        if (++tables <= 2) rows[0].startedAt = 'tracked-tool';
        return rows;
      },
      identity: async pid => current.find(row => row.pid === pid)?.startedAt ?? null,
      inspectSync: pid => current.find(row => row.pid === pid) ?? null,
      fencePids: async () => [],
      signalGroup: pgid => {signals.push(-pgid);},
    };
    t.mock.method(process, 'kill', (pid: number) => {signals.push(pid); return true;});
    const saved: ProcessGroup[] = lineage === 'moved' ?
      [{pgid: root, startedAt: 'departed-root', members: [{pid: tool, startedAt: 'tracked-tool'}]}] :
      [{pgid: tool, startedAt: 'tracked-tool', cleanupPending: true}];
    const recovering = result(recoverProcess(lineage === 'root' ? tool : root, lineage === 'root' ? 'tracked-tool' : 'departed-root',
      inspector, undefined, saved, groups => {snapshots.push(groups);}));
    await advanceTime(t);
    await recovering;
    assert(snapshots.every(groups => groups.every(group => !group.members?.some(member => member.pid === peer))),
      'a later peer row cannot gain durable authority from a stale own-leader row');
    assert.deepEqual(signals, [], 'matching a wrongly adopted identity at the signal gate would be too late');
  });
  }

  for (const order of ['original-first', 'obsolete-first', 'direct-root'] as const) {
    test(`FIX18: an obsolete PGID ledger cannot hide a new own-group obligation (${order}) on ${host}`, async t => {
      platform(t, host);
      t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
      const root = 931_200, tool = root + 1, orphan = root + 2;
      let rows: ProcessEntry[] = [{pid: tool, ppid: 1, pgid: tool, sid: String(tool), startedAt: 'new-owned-leader'}];
      let saved: ProcessGroup[] = [
        {pgid: root, startedAt: 'departed-root', members: [{pid: tool, startedAt: 'new-owned-leader'}]},
        {pgid: tool, startedAt: 'obsolete-leader', sid: String(tool), sessionLeader: {pid: tool, startedAt: 'obsolete-leader'}},
      ];
      if (order === 'obsolete-first') saved.reverse();
      if (order === 'direct-root') saved = [saved[1]];
      const recoveredPid = order === 'direct-root' ? tool : root;
      const recoveredStart = order === 'direct-root' ? 'new-owned-leader' : 'departed-root';
      const signals: number[] = [];
      const send = (target: number, signal?: NodeJS.Signals | number) => {
        signals.push(target);
        if ((target === tool || target === -tool) && signal === 'SIGTERM') {
          rows = [{pid: orphan, ppid: 1, pgid: tool, sid: String(tool), startedAt: 'late-cleared-child'}];
        }
        return true;
      };
      t.mock.method(process, 'kill', send);
      const inspector: ProcessInspector = {
        table: async () => structuredClone(rows),
        identity: async pid => rows.find(row => row.pid === pid)?.startedAt ?? null,
        inspectSync: pid => rows.find(row => row.pid === pid) ?? null,
        fencePids: async () => [],
        signalGroup: (pgid, signal) => {send(-pgid, signal);},
      };
      let crash: ProcessGroup[] | undefined;
      const interrupted = result(recoverProcess(recoveredPid, recoveredStart, inspector, undefined, saved, groups => {
        saved = structuredClone(groups);
        if (groups.some(group => group.pgid === tool && group.cleanupPending && group.members?.some(member => member.pid === tool && member.startedAt === 'new-owned-leader'))) {
          crash ??= structuredClone(groups);
          throw new Error('fixture crash after persisting observed group');
        }
      }));
      await advanceTime(t, 500);
      const interruptedResult = await interrupted;
      assert.equal(interruptedResult.ok, false);
      assert(crash, 'recovery must persist the new obligation before sending a signal');
      assert.deepEqual(signals, []);
      const observed = crash.find(group => group.pgid === tool)!;
      assert.equal(observed.startedAt, 'new-owned-leader', 'numeric reuse creates a new leader-bound obligation');
      assert(observed.members?.some(member => member.pid === tool && member.startedAt === 'new-owned-leader'));
      if (host === 'linux') assert.deepEqual(observed.sessionLeader, {pid: tool, startedAt: 'new-owned-leader'});
      else assert.equal(observed.sessionLeader, undefined);
      const resumed = result(recoverProcess(recoveredPid, recoveredStart, inspector, undefined, crash, groups => {saved = groups;}));
      await advanceTime(t);
      const outcome = await resumed;
      assert.equal(outcome.ok, false, 'the newly observed group cannot be retired as an obsolete replacement');
      if (!outcome.ok) assert(outcome.error instanceof ProcessCleanupError);
      assert.deepEqual(signals, [-tool]);
      assert(saved.some(group => group.pgid === tool && group.startedAt === 'new-owned-leader' && group.cleanupPending));
      const restarted = result(recoverProcess(recoveredPid, recoveredStart, inspector, undefined, saved, groups => {saved = groups;}));
      await advanceTime(t);
      const restartOutcome = await restarted;
      assert.equal(restartOutcome.ok, false, 'the orphan keeps the new obligation pending across a second restart');
      if (!restartOutcome.ok) assert(restartOutcome.error instanceof ProcessCleanupError);
      assert.deepEqual(signals, [-tool], 'an obligation does not authorize its unproven orphan');
      rows = [];
      assert.equal(await recoverProcess(recoveredPid, recoveredStart, inspector, undefined, saved, groups => {saved = groups;}), true);
      assert.deepEqual(saved, []);
    });
  }
}

test('FIX17 native: an observed setsid transition keeps a real late env-cleared child pending',
  {skip: !['linux', 'darwin'].includes(process.platform), timeout: 15_000}, async t => {
    const inspector = directFixtureProcesses();
    try {await inspector.table(); assert(await inspector.identity(process.pid));}
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM' && !/operation not permitted|permission denied/iu.test(String(error))) throw error;
      t.skip(`Native process inspection denied: ${String(error)}`); return;
    }
    const directory = await mkdtemp(join(tmpdir(), 'mdai-observed-group-'));
    const file = (name: string) => join(directory, name);
    const read = (name: string) => readFile(file(name), 'utf8').catch(() => '');
    const until = async (check: () => Promise<boolean>, timeout = 3000) => {
      const deadline = Date.now() + timeout;
      while (!await check()) {
        assert(Date.now() < deadline, 'native own-session fixture did not reach its expected state');
        await new Promise(resolve => setTimeout(resolve, 15));
      }
    };
    const script = `
import os, signal, sys, time
directory = sys.argv[1]
def put(name, value):
    with open(os.path.join(directory, name), 'w') as output: output.write(str(value))
def wait(name):
    while not os.path.exists(os.path.join(directory, name)): time.sleep(0.01)
tool = os.fork()
if tool:
    put('tool.pid', tool)
    wait('release-root')
    os._exit(0)
put('initial', os.getpgrp())
wait('move')
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
    const child = spawn('/usr/bin/python3', ['-c', script, directory], {detached: true, stdio: 'ignore', env: {MDAI_RUN_FENCE: 'b'.repeat(32)}});
    let spawnError: unknown;
    child.once('error', error => {spawnError = error;});
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    let tool = 0, orphan = 0;
    try {
      await until(async () => Boolean(await read('initial')) || Boolean(spawnError));
      if (spawnError) {
        if ((spawnError as NodeJS.ErrnoException).code === 'ENOENT') {
          t.skip('Native setsid fixture requires /usr/bin/python3'); return;
        }
        throw spawnError;
      }
      assert(child.pid);
      tool = Number(await read('tool.pid'));
      const original = await inspector.identity(child.pid);
      const tracked = inspector.inspectSync!(tool);
      assert(original && tracked?.startedAt);
      assert.equal(tracked.pgid, child.pid);
      let saved: ProcessGroup[] = [{pgid: child.pid, startedAt: original, members: [{pid: tool, startedAt: tracked.startedAt}]}];
      await writeFile(file('move'), 'move');
      await until(async () => Number(await read('moved')) === tool);
      assert.equal((await inspector.identity(tool)), tracked.startedAt, 'setsid preserves the native process lifetime');
      await writeFile(file('release-root'), 'exit');
      await closed;
      const snapshots: ProcessGroup[][] = [];
      if (process.platform === 'linux') {
        // Manufacture the historical TERM-handler birth as a fixture action.
        // Production Linux recovery must refuse these rows without signaling.
        await writeFile(file('groups.json'), JSON.stringify(saved));
        process.kill(tool, 'SIGTERM');
        await until(async () => Number(await read('orphan.pid')) > 1);
      }
      await assert.rejects(recoverProcess(child.pid, original, inspector, undefined, saved, async groups => {
        saved = groups; snapshots.push(groups);
        await writeFile(file('groups.json'), JSON.stringify(groups));
      }, Date.now() - PROCESS_CLEANUP_CAP_MS + 2500), ProcessCleanupError);
      orphan = Number(await read('orphan.pid'));
      assert(orphan > 1 && await inspector.identity(orphan), 'the real TERM-created child remains alive');
      const durable: ProcessGroup[] = JSON.parse(await read('groups.json'));
      if (process.platform === 'linux') {
        assert.deepEqual(durable, saved, 'historical evidence remains unchanged and unresolved');
        assert.deepEqual(snapshots, [], 'a Linux process observation cannot mint a durable signal capability');
      } else {
        assert(durable.some(group => group.pgid === tool && group.cleanupPending), 'the own-session obligation survives in durable storage');
        assert(snapshots.some(groups => groups.some(group => group.pgid === tool && group.startedAt === tracked.startedAt)));
      }
      process.kill(orphan, 'SIGKILL');
      await until(async () => {
        try {return !await inspector.identity(orphan);}
        catch (error) {
          // /proc can change mid-read as SIGKILL takes effect. An incomplete
          // snapshot is not absence; keep polling within the existing bound.
          if (error instanceof LinuxProcError && ['malformed', 'race'].includes(error.code)) return false;
          throw error;
        }
      });
      if (process.platform === 'linux') await assert.rejects(recoverProcess(child.pid, original, inspector, undefined, durable), ProcessCleanupError);
      else assert.equal(await recoverProcess(child.pid, original, inspector, undefined, durable), true);
    } finally {
      tool ||= Number(await read('tool.pid'));
      orphan ||= Number(await read('orphan.pid'));
      for (const pid of [child.pid, tool, orphan]) if (pid && pid > 1) {
        try {process.kill(pid, 'SIGKILL');} catch (error) {assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH');}
      }
      await closed;
      await rm(directory, {recursive: true, force: true});
    }
  });
