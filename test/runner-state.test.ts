import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, {type TestContext} from 'node:test';
import { ProcessCleanupError, recoverProcess, verifyLegacyProcessAbsence, type ProcessGroup, type ProcessInspector } from '../src/runner/process.js';
import { RunnerState, type ActiveRun } from '../src/runner/state.js';

const boot = '11111111-2222-4333-8444-555555555555';
const kernelIdentity = `linux:${boot}:123456789`;

async function fixture() {
  const data = await mkdtemp(join(await realpath(tmpdir()), 'mdai-run-state-'));
  const state = new RunnerState(data);
  await state.init();
  const runId = randomUUID();
  const row: ActiveRun = {runId, agentId: randomUUID(), aiToolId: randomUUID(), pid: 900001, startedAt: kernelIdentity,
    runDir: join(data, 'workspace/.maddots/runs', runId), phase: 'running'};
  return {state, row, data, cleanup: () => rm(data, {recursive: true, force: true})};
}

test('runner state keeps Linux lifetime identity separate from claim time through posting and restart', async () => {
  const f = await fixture();
  try {
    const claimedAt = Date.parse('2026-10-24T10:00:00.000Z');
    await f.state.writeActive([{...f.row, claimedAt}]);
    assert.deepEqual(await f.state.active(), [{...f.row, claimedAt}]);
    await f.state.writeActive([{...f.row, pid: 0, phase: 'posting', claimedAt}]);
    const [posting] = await new RunnerState(f.data).active();
    assert.equal(posting.claimedAt, claimedAt);
    assert.equal(posting.startedAt, kernelIdentity);
    assert.equal(posting.legacyProcessIdentity, undefined);
  } finally { await f.cleanup(); }
});

for (const identity of ['Fri Oct 16 12:00:00 2026', '2026-10-16T12:00:00.000Z']) {
  test(`Linux legacy ${identity.includes('T12:') ? 'ISO' : 'ps'} migration preserves unresolved evidence without guessing ticks`, {skip: process.platform !== 'linux'}, async () => {
    const f = await fixture();
    try {
      const row = {...f.row, startedAt: identity, processGroups: [{pgid: f.row.pid, startedAt: identity,
        members: [{pid: f.row.pid + 1, startedAt: identity}], sessionLeader: {pid: f.row.pid, startedAt: identity}}]};
      await f.state.writeActive([row]);
      const [migrated] = await f.state.active();
      assert.equal(migrated.claimedAt, Date.parse('2026-10-16T12:00:00.000Z'));
      assert.equal(migrated.legacyProcessIdentity, true);
      assert.equal(migrated.startedAt, identity);
      assert.deepEqual(migrated.processGroups, row.processGroups);
      await f.state.writeActive([migrated]);
      assert.deepEqual(await f.state.active(), [migrated]);
      const persisted = JSON.parse(await readFile(join(f.state.directory, 'active.json'), 'utf8'));
      assert.equal(persisted[0].legacyProcessIdentity, true);
    } finally { await f.cleanup(); }
  });
}

test('opaque old state with no wall claim time stays unknown instead of aging from a process token', async () => {
  const f = await fixture();
  try {
    await f.state.writeActive([f.row]);
    const [restored] = await f.state.active();
    assert.equal(restored.claimedAt, undefined);
    assert.equal(restored.startedAt, kernelIdentity);
    assert.equal(restored.legacyProcessIdentity, undefined);
  } finally { await f.cleanup(); }
});

test('Linux migration marks an unresolved pre-proc spawn window with no saved root or leader identity', {skip: process.platform !== 'linux'}, async () => {
  const f = await fixture();
  try {
    const claimedAt = Date.parse('2026-10-16T12:00:00.000Z');
    await f.state.writeActive([{...f.row, pid: 0, startedAt: new Date(claimedAt).toISOString(),
      processGroups: [{pgid: 900001, startedAt: '', spawnedBy: claimedAt}]}]);
    const [migrated] = await f.state.active();
    assert.equal(migrated.legacyProcessIdentity, true);
    assert.equal(migrated.claimedAt, claimedAt);
    assert.equal(migrated.processGroups?.[0].startedAt, '');
  } finally { await f.cleanup(); }
});

test('claim age and migration marker are validated private state fields', async () => {
  const f = await fixture();
  try {
    for (const claimedAt of [-1, 0.5, Number.POSITIVE_INFINITY]) {
      await assert.rejects(f.state.writeActive([{...f.row, claimedAt}]), {code: 'RUNNER_STATE_INVALID'});
    }
    await assert.rejects(f.state.writeActive([{...f.row, legacyProcessIdentity: false} as unknown as ActiveRun]), {code: 'RUNNER_STATE_INVALID'});
  } finally { await f.cleanup(); }
});

test('cleanup obligations survive state projection and restart independently of moved members', async () => {
  const f = await fixture();
  try {
    const group: ProcessGroup = {pgid: f.row.pid, startedAt: kernelIdentity, cleanupPending: true,
      members: [{pid: f.row.pid + 1, startedAt: kernelIdentity}]};
    const row: ActiveRun = {...f.row, legacyProcessIdentity: true, processGroups: [group], legacyProcessGroups: [group]};
    await f.state.writeActive([row]);
    const [restored] = await new RunnerState(f.data).active();
    assert.deepEqual(restored.processGroups, [group]);
    assert.deepEqual(restored.legacyProcessGroups, [group]);
    const {cleanupPending: _pending, ...completedGroup} = group;
    await f.state.writeActive([{...restored, processGroups: [completedGroup]}]);
    const [completed] = await new RunnerState(f.data).active();
    assert.equal(completed.processGroups![0].cleanupPending, undefined);
    assert.deepEqual(completed.processGroups![0].members, group.members, 'retiring a group obligation preserves moved lifetime evidence');
  } finally {await f.cleanup();}
});

test('cleanup obligations accept only optional literal true in private state', async () => {
  const f = await fixture();
  try {
    for (const cleanupPending of [false, null, 1, 'true']) {
      const group = {pgid: f.row.pid, startedAt: kernelIdentity, cleanupPending} as unknown as ProcessGroup;
      await assert.rejects(f.state.writeActive([{...f.row, processGroups: [group]}]), {code: 'RUNNER_STATE_INVALID'});
      await assert.rejects(f.state.writeActive([{...f.row, legacyProcessIdentity: true, legacyProcessGroups: [group]}]), {code: 'RUNNER_STATE_INVALID'});
    }
  } finally {await f.cleanup();}
});

test('a rebooted Linux process identity cannot authorize an otherwise equal PID, PGID or session', async () => {
  const pid = 900001, signals: string[] = [];
  const currentIdentity = kernelIdentity.replace(boot, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  const inspector: ProcessInspector = {
    table: async () => [{pid, ppid: 1, pgid: pid, sid: String(pid), startedAt: currentIdentity}],
    identity: async () => currentIdentity,
    signalGroup: (_pid, signal) => { signals.push(signal); },
  };
  const recovering = recoverProcess(pid, kernelIdentity, inspector, undefined,
    [{pgid: pid, startedAt: kernelIdentity, sid: String(pid), members: [{pid, startedAt: kernelIdentity}], sessionLeader: {pid, startedAt: kernelIdentity}}]);
  if (process.platform === 'linux') await assert.rejects(recovering, ProcessCleanupError);
  else assert.equal(await recovering, false);
  assert.deepEqual(signals, []);
});

for (const platform of ['linux', 'darwin']) test(`${platform} legacy migration retains the cleanup barrier for live roots, leaderless groups and moved members`, async t => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', {...descriptor, value: platform});
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
  const pid = 900001, member = 900002;
  const groups = [{pgid: pid, startedAt: 'Fri Oct 16 12:00:00 2026', members: [{pid: member, startedAt: 'Fri Oct 16 12:00:00 2026'}]}];
  for (const row of [{pid, ppid: 1, pgid: pid}, {pid: member, ppid: 1, pgid: pid}, {pid: member, ppid: 1, pgid: member}]) {
    const inspector: ProcessInspector = {table: async () => [row], identity: async () => kernelIdentity};
    await assert.rejects(verifyLegacyProcessAbsence(pid, groups, inspector), {code: 'tool_failed'});
  }
  const empty = {table: async () => [], identity: async () => null};
  const unavailable = {table: async () => { throw new Error('proc unavailable'); }, identity: async () => null};
  if (platform === 'linux') {
    await assert.rejects(verifyLegacyProcessAbsence(pid, groups, empty), ProcessCleanupError);
    await assert.rejects(verifyLegacyProcessAbsence(pid, groups, unavailable), ProcessCleanupError);
  } else {
    await verifyLegacyProcessAbsence(pid, groups, empty);
    await assert.rejects(verifyLegacyProcessAbsence(pid, groups, unavailable), /proc unavailable/u);
  }
});

for (const platform of ['linux', 'darwin']) for (const change of ['lifetime', 'group']) {
  test(`${platform} ${platform === 'linux' ? 'legacy cleanup refuses' : 'cleanup rechecks'} ${change} evidence before signalling a process group`, async t => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', {...descriptor, value: platform});
    t.after(() => Object.defineProperty(process, 'platform', descriptor));
    const identity = platform === 'linux' ? kernelIdentity : 'Fri Oct 16 12:00:00 2026';
    const pgid = 900001, member = 900002, signals: number[] = [];
    const originalKill = process.kill;
    let changed = false, alive = true, memberSignals = 0, snapshots = 0;
    const row = () => ({pid: member, ppid: 1, pgid: changed && change === 'group' ? member : pgid,
      startedAt: changed && change === 'lifetime' ? 'reused-member' : identity});
    const inspector: ProcessInspector = {table: async () => {snapshots++; return alive ? [row()] : [];}, identity: async pid => alive && pid === member ? row().startedAt : null,
      inspect: async pid => alive && pid === member ? row() : null, fencePids: async () => [],
      signalGroup: pid => {signals.push(pid);}};
    process.kill = ((target: number) => {assert.equal(target, member); memberSignals++; alive = false; return true;}) as typeof process.kill;
    try {
      const recovering = recoverProcess(0, '', inspector, 'e'.repeat(32),
        [{pgid, startedAt: 'exited-leader', members: [{pid: member, startedAt: identity}]}], async () => {
          // Keep discovery stable; change the witness only while the final
          // authenticated group snapshot is being persisted for signalling.
          if (snapshots < 2) return;
          await Promise.resolve();
          changed = true;
        });
      if (platform === 'linux') await assert.rejects(recovering, ProcessCleanupError);
      else assert.equal(await recovering, true);
      assert.equal(changed, platform !== 'linux');
      assert.deepEqual(signals, [], 'a moved member does not authorize either its old or new group');
      assert.equal(memberSignals, platform !== 'linux' && change === 'group' ? 1 : 0, 'only Darwin retains the released member-signaling contract');
      assert.equal(alive, platform === 'linux' || change !== 'group');
    } finally {process.kill = originalKill;}
  });
}

async function cleanupWithinCap(t: TestContext, work: () => Promise<unknown>): Promise<unknown> {
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
  let done = false, failure: unknown;
  void work().then(() => {done = true;}, error => {done = true; failure = error;});
  for (let elapsed = 0; !done && elapsed <= 20_000; elapsed += 25) {
    await new Promise<void>(resolve => setImmediate(resolve));
    if (!done) t.mock.timers.tick(25);
  }
  assert(done, 'cleanup remains bounded');
  return failure;
}

for (const platform of ['darwin', 'linux']) for (const witness of ['root', 'saved member']) {
  test(`${platform} preflight ${platform === 'linux' ? 'retains a historical' : 'persists a'} ${witness} obligation before its final witness disappears`, async t => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', {...descriptor, value: platform});
    t.after(() => Object.defineProperty(process, 'platform', descriptor));
    const root = 900010, member = 900011, unseen = 900012;
    let tables = 0, lookups = 0, absent = false;
    let ledger: ProcessGroup[] = [{pgid: root, startedAt: 'root-start',
      ...(witness === 'saved member' ? {members: [{pid: member, startedAt: 'member-start'}]} : {})}];
    const historical = structuredClone(ledger);
    const inspector: ProcessInspector = {
      identity: async pid => witness === 'root' && pid === root && ++lookups === 1 ? 'root-start' : null,
      table: async () => {
        tables++;
        if (absent) return [];
        if (witness === 'saved member' && tables === 1) return [{pid: member, ppid: 1, pgid: root, startedAt: 'member-start'}];
        return [{pid: unseen, ppid: 1, pgid: root, startedAt: 'unseen-start'}];
      },
      signalGroup: () => assert.fail('a lost preflight witness cannot authorize an unseen member'),
    };
    t.mock.method(process, 'kill', () => assert.fail('no unseen member can receive a PID signal'));
    for (let attempt = 0; attempt < 2; attempt++) {
      const failure = await cleanupWithinCap(t, () => recoverProcess(witness === 'root' ? root : 0,
        witness === 'root' ? 'root-start' : '', inspector, undefined, ledger, groups => {ledger = groups;}));
      assert(failure instanceof ProcessCleanupError);
      if (platform === 'linux') assert.deepEqual(ledger, historical, 'refusal preserves the original migration evidence without rewriting authority');
      else assert(ledger.some(group => group.pgid === root && group.cleanupPending), 'the obligation survives both recovery attempts');
      assert(ledger.every(group => !group.members?.some(value => value.pid === unseen)), 'the obligation never becomes signal authority');
      t.mock.timers.reset();
    }
    absent = true;
    if (platform === 'linux') {
      await assert.rejects(recoverProcess(0, '', inspector, undefined, ledger, groups => {ledger = groups;}), ProcessCleanupError);
      assert.deepEqual(ledger, historical, 'empty process observations cannot retire a Linux obligation');
    } else {
      assert.equal(await recoverProcess(0, '', inspector, undefined, ledger, groups => {ledger = groups;}), true);
      assert.deepEqual(ledger, [], 'a successful complete absence scan finally retires the obligation');
    }
  });
}

test('Linux legacy moved saved member stays pending across retries and after its lifetime exits', {skip: process.platform !== 'linux'}, async t => {
  const pgid = 900001, member = 900002, newGroup = 900003, originalKill = process.kill;
  let alive = true, ledger: ProcessGroup[] = [{pgid, startedAt: 'departed-leader', members: [{pid: member, startedAt: kernelIdentity}]}];
  const signals: number[] = [];
  const inspector: ProcessInspector = {
    table: async () => alive ? [{pid: member, ppid: 1, pgid: newGroup, startedAt: kernelIdentity}] : [],
    identity: async pid => alive && pid === member ? kernelIdentity : null,
    fencePids: async () => [],
    signalGroup: () => assert.fail('moving a member does not authorize its new group'),
  };
  process.kill = ((target: number) => {signals.push(target); return true;}) as typeof process.kill;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const failure = await cleanupWithinCap(t, () => recoverProcess(0, '', inspector, undefined, ledger, groups => {ledger = groups;}));
      assert(failure instanceof ProcessCleanupError);
      assert(ledger.some(group => group.members?.some(value => value.pid === member && value.startedAt === kernelIdentity)));
      t.mock.timers.reset();
    }
    assert.deepEqual(signals, [], 'saved Linux lifetimes are not PID signal capabilities');
    alive = false;
    await assert.rejects(recoverProcess(0, '', inspector, 'e'.repeat(32), ledger), ProcessCleanupError);
  } finally {process.kill = originalKill;}
});

test('Linux moved member and its descendants never authenticate an unrelated group leader', {skip: process.platform !== 'linux'}, async () => {
  const pgid = 900001, member = 900002, child = 900003, unrelated = 900004, grandchild = 900005, originalKill = process.kill;
  const live = new Set([member, child, unrelated, grandchild]);
  const rows = [
    {pid: member, ppid: 1, pgid: unrelated, startedAt: kernelIdentity},
    {pid: child, ppid: member, pgid: unrelated, startedAt: 'owned-child'},
    {pid: grandchild, ppid: child, pgid: unrelated, startedAt: 'owned-grandchild'},
    {pid: unrelated, ppid: 1, pgid: unrelated, startedAt: 'unrelated-leader'},
  ];
  const persisted = new Set<number>();
  const inspector: ProcessInspector = {
    table: async () => rows.filter(row => live.has(row.pid)),
    identity: async pid => live.has(pid) ? rows.find(row => row.pid === pid)?.startedAt ?? null : null,
    fencePids: async () => [],
    signalGroup: () => assert.fail('a moved member and its child cannot authorize unrelated peers'),
  };
  process.kill = ((target: number) => {
    assert.notEqual(target, unrelated);
    assert(persisted.has(target), 'each discovered lifetime must be durable before signalling');
    live.delete(target);
    return true;
  }) as typeof process.kill;
  try {
    await assert.rejects(recoverProcess(0, '', inspector, undefined,
      [{pgid, startedAt: 'departed-leader', members: [{pid: member, startedAt: kernelIdentity}]}], groups => {
        for (const group of groups) for (const value of group.members ?? []) persisted.add(value.pid);
        assert(groups.every(group => group.pgid !== unrelated), 'the unrelated leader must never enter the ownership ledger');
      }), ProcessCleanupError);
    assert.deepEqual([...live], [member, child, unrelated, grandchild], 'Linux requires the registered run endpoint for any cleanup');
    assert.equal(persisted.size, 0, 'discovery never adopts descendants or unrelated peers');
  } finally {process.kill = originalKill;}
});

test('Linux root disappearance cannot authenticate an unrelated replacement group after a scan gap', {skip: process.platform !== 'linux'}, async t => {
  const root = 900001, replacement = 900002, originalKill = process.kill;
  let identities = 0, ledger: ProcessGroup[] = [{pgid: root, startedAt: kernelIdentity, sid: String(root)}];
  const inspector: ProcessInspector = {
    identity: async pid => pid === root && ++identities === 1 ? kernelIdentity : null,
    table: async () => [{pid: replacement, ppid: 1, pgid: root, sid: String(root), startedAt: 'replacement-lifetime'}],
    fencePids: async () => [],
    signalGroup: () => assert.fail('numeric PGID/SID reuse is not ownership'),
  };
  process.kill = (() => assert.fail('replacement member must receive no signal')) as typeof process.kill;
  try {
    const failure = await cleanupWithinCap(t, () => recoverProcess(root, kernelIdentity, inspector, 'e'.repeat(32),
      [{pgid: root, startedAt: kernelIdentity, sid: String(root)}], groups => {ledger = groups;}));
    assert(failure instanceof ProcessCleanupError);
    assert(ledger.some(group => group.pgid === root));
    assert(ledger.every(group => !group.members?.some(member => member.pid === replacement)), 'replacement lifetime never becomes saved ownership evidence');
  } finally {process.kill = originalKill;}
});

test('Linux cleanup never treats a still-fenced PID with unavailable lifetime as verified exit', {skip: process.platform !== 'linux'}, async t => {
  const inspector: ProcessInspector = {table: async () => [], identity: async () => null, fencePids: async () => [900001],
    signalGroup: () => assert.fail('an unresolved lifetime cannot authorize a signal')};
  const failure = await cleanupWithinCap(t, () => recoverProcess(0, '', inspector, 'f'.repeat(32)));
  assert(failure instanceof ProcessCleanupError);
});

for (const platform of ['linux', 'darwin']) for (const change of ['fence', 'lifetime']) {
  test(`${platform} ${platform === 'linux' ? 'legacy cleanup refuses' : 'cleanup rechecks'} ${change} evidence before signalling a fence-only PID`, async t => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', {...descriptor, value: platform});
    t.after(() => Object.defineProperty(process, 'platform', descriptor));
    const identity = platform === 'linux' ? kernelIdentity : 'Fri Oct 16 12:00:00 2026';
    const pid = 900001, originalKill = process.kill, signals: number[] = [];
    let changed = false;
    const currentIdentity = () => changed && change === 'lifetime' ? 'reused' : identity;
    const inspector: ProcessInspector = {table: async () => [], identity: async () => currentIdentity(),
      fencePids: async () => changed ? [] : [pid],
      fenceEntries: async () => changed ? [] : [{pid, ppid: 1, pgid: pid, startedAt: identity, fenceMatch: true}],
      inspect: async () => ({pid, ppid: 1, pgid: pid, startedAt: currentIdentity(), fenceMatch: !changed || change !== 'fence'})};
    process.kill = ((target: number) => {signals.push(target); return true;}) as typeof process.kill;
    try {
      const recovering = recoverProcess(0, '', inspector, 'f'.repeat(32), [], async () => {
        await Promise.resolve();
        changed = true;
      });
      if (platform === 'linux') await assert.rejects(recovering, ProcessCleanupError);
      else assert.equal(await recovering, true);
      assert.equal(changed, platform !== 'linux');
      assert.deepEqual(signals, []);
    } finally {process.kill = originalKill;}
  });
}
