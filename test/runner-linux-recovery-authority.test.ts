import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {PROCESS_CLEANUP_CAP_MS, ProcessCleanupError, recoverProcess, type ProcessEntry, type ProcessGroup, type ProcessInspector} from '../src/runner/process.js';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
async function finishRecovery(t: TestContext): Promise<void> {
  for (let elapsed = 0; elapsed <= PROCESS_CLEANUP_CAP_MS; elapsed += 100) {
    t.mock.timers.tick(100);
    await flush();
  }
}

// R19's final signal snapshot deliberately matches the unrelated process.
// Rejecting only a reused PID at the sink cannot close this authority bug.
for (const scenario of ['ordinary-parent', 'saved-leaderless-witness', 'cached-session-witness'] as const) {
  for (const reverseLedger of [false, true]) for (const reverseRows of [false, true]) {
  test(`R19 Linux recovery refuses cached ${scenario} and matching unrelated final identity, ledger=${reverseLedger}, table=${reverseRows}`, async t => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', {...descriptor, value: 'linux'});
    t.after(() => Object.defineProperty(process, 'platform', descriptor));
    t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
    const root = 948100, stale = root + 1, unrelated = root + 2;
    const ownGroup = scenario === 'ordinary-parent' ? unrelated : root;
    const current: ProcessEntry[] = [
      {pid: stale, ppid: 1, pgid: root, sid: String(root), startedAt: 'replacement-parent-or-witness'},
      {pid: unrelated, ppid: scenario === 'ordinary-parent' ? stale : 1, pgid: ownGroup, sid: String(root), startedAt: 'unrelated-current-lifetime'},
    ];
    if (scenario === 'cached-session-witness') {
      current[0].pgid = stale;
      for (const row of current) row.sid = String(stale);
    }
    if (reverseRows) current.reverse();
    const signals: number[] = [];
    const snapshots: ProcessGroup[][] = [];
    let alive = true;
    const inspector: ProcessInspector = {
      table: async () => alive ? current.map(row => row.pid === stale ? {...row, startedAt: 'obsolete-owned-lifetime'} : {...row}) : [],
      identity: async pid => alive ? current.find(row => row.pid === pid)?.startedAt ?? null : null,
      inspectSync: pid => alive ? current.find(row => row.pid === pid) ?? null : null,
      fencePids: async () => [],
      signalGroup: pgid => {signals.push(-pgid); alive = false;},
    };
    t.mock.method(process, 'kill', (pid: number) => {signals.push(pid); alive = false; return true;});
    const saved: ProcessGroup[] = [{pgid: root, startedAt: 'departed-root', cleanupPending: true,
      members: [{pid: stale, startedAt: 'obsolete-owned-lifetime'}]}, {pgid: root + 90, startedAt: 'obsolete-other-group', cleanupPending: true}];
    if (scenario === 'cached-session-witness') saved[0] = {pgid: root, startedAt: 'departed-root', sid: String(stale),
      cleanupPending: true, sessionLeader: {pid: stale, startedAt: 'obsolete-owned-lifetime'}};
    if (reverseLedger) saved.reverse();
    const persisted = JSON.stringify(saved);
    const recovery = recoverProcess(root, 'departed-root', inspector, undefined, saved,
      groups => {snapshots.push(structuredClone(groups));}).then(value => ({value}), error => ({error}));
    await finishRecovery(t);
    const outcome = await recovery;
    assert.deepEqual(signals, [], 'a cached observation must never authorize the unrelated process');
    assert(!snapshots.some(groups => groups.some(group => group.members?.some(member => member.pid === unrelated))),
      'replacement descendants and peers must never become durable ownership evidence');
    assert('error' in outcome && outcome.error instanceof ProcessCleanupError,
      'historical process rows without a registered containment endpoint remain unresolved');
    await assert.rejects(recoverProcess(root, 'departed-root', inspector, undefined, JSON.parse(persisted)), ProcessCleanupError);
    assert.equal(JSON.stringify(saved), persisted, 'a restart cannot overwrite either original obligation');
  });
  }
}

for (const scenario of ['stale-own-leader', 'cached-session-witness', 'fence-pid-reuse', 'unrelated-group-adoption',
  'moved-saved-member', 'root-exit-reuse', 'recent-numeric-pgid', 'own-group-TERM-handler-group-transition',
  'own-group-TERM-handler-session-transition', 'own-group-with-identified-members', 'ancestry-null-current-lifetime',
  'own-group-reused-during-persistence', 'new-ancestry-obsolete-own-ledger', 'verified-leader-exit-before-persistence',
  'verified-leader-inspection-failure-before-persistence', 'incomplete-inspect-leader', 'incomplete-identity-leader',
  'tracked-leader-new-session', 'non-atomic-reused-root-child', 'non-atomic-reused-root-orphan',
  'non-atomic-reused-descendant-child', 'non-atomic-reused-descendant-orphan', 'obsolete-own-ledger-direct-root',
  'spawn-window-without-lifetime', 'legacy-genuine-leaderless-session', 'legacy-fence-environment-cleared-survivor',
  'unusable-session-zero', 'unusable-session-malformed'] as const) {
  for (const reverseLedger of [false, true]) for (const reverseRows of [false, true]) {
    test(`S3 Linux ${scenario} stays pending after crash replay, ledger=${reverseLedger}, table=${reverseRows}`, async t => {
      const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', {...descriptor, value: 'linux'});
      t.after(() => Object.defineProperty(process, 'platform', descriptor));
      const root = 949100, member = root + 1, replacement = root + 2;
      const rows: ProcessEntry[] = [
        {pid: root, ppid: 1, pgid: root, sid: String(root), startedAt: 'obsolete-root'},
        {pid: member, ppid: root, pgid: scenario === 'moved-saved-member' ? replacement : root, sid: String(root), startedAt: 'obsolete-member'},
        {pid: replacement, ppid: member, pgid: replacement, sid: String(root), startedAt: 'matching-unrelated-final-lifetime'},
      ];
      if (reverseRows) rows.reverse();
      const ledger: ProcessGroup[] = [
        {pgid: root, startedAt: 'obsolete-root', sid: String(root), cleanupPending: true,
          members: [{pid: member, startedAt: 'obsolete-member'}], sessionLeader: {pid: root, startedAt: 'obsolete-root'}},
        {pgid: replacement, startedAt: 'obsolete-saved-leader', spawnedBy: Date.now(), cleanupPending: true},
      ];
      if (scenario === 'cached-session-witness' || scenario === 'legacy-genuine-leaderless-session') {
        rows.splice(0, rows.length,
          {pid: member, ppid: 1, pgid: root, sid: String(replacement), startedAt: 'unrelated-peer'},
          {pid: replacement, ppid: 1, pgid: replacement, sid: String(replacement), startedAt: 'obsolete-session-witness'});
        ledger[0] = {pgid: root, startedAt: '', sid: String(replacement), cleanupPending: true,
          sessionLeader: {pid: replacement, startedAt: 'obsolete-session-witness'}};
      } else if (scenario === 'recent-numeric-pgid' || scenario === 'spawn-window-without-lifetime') {
        rows.splice(0, 1); ledger[0].startedAt = ''; ledger[0].spawnedBy = Date.now();
        delete ledger[0].members; delete ledger[0].sessionLeader;
      } else if (scenario.startsWith('own-group-TERM-handler') || scenario === 'own-group-with-identified-members' ||
        scenario === 'tracked-leader-new-session' || scenario === 'new-ancestry-obsolete-own-ledger' || scenario === 'obsolete-own-ledger-direct-root') {
        rows.splice(0, 1); rows[0].pgid = member; rows[0].startedAt = 'obsolete-member';
        rows[0].sid = scenario.includes('session') ? String(member) : String(root);
        ledger[1] = {pgid: member, startedAt: 'obsolete-previous-leader', cleanupPending: true};
      } else if (scenario === 'verified-leader-exit-before-persistence' || scenario === 'legacy-fence-environment-cleared-survivor') {
        rows.splice(0, rows.length, {pid: replacement, ppid: 1, pgid: member, sid: String(member), startedAt: 'environment-cleared-orphan'});
        ledger[1] = {pgid: member, startedAt: 'exited-verified-leader', cleanupPending: true};
      } else if (scenario === 'unusable-session-zero' || scenario === 'unusable-session-malformed') {
        ledger[0].sid = scenario.endsWith('zero') ? '0' : 'not-a-session';
        for (const row of rows) row.sid = ledger[0].sid;
      }
      if (reverseLedger) ledger.reverse();
      // Persisted bytes are the crash snapshot before the first possible signal.
      const persisted = JSON.stringify(ledger);
      const finalRows = rows.map(row => row.pid === replacement ? row : {...row, startedAt: 'replacement-lifetime'});
      let inspections = 0, publications = 0;
      const inspector: ProcessInspector = {
        table: async () => {inspections++; return structuredClone(rows);},
        identity: async pid => {inspections++; return finalRows.find(row => row.pid === pid)?.startedAt ?? null;},
        inspectSync: pid => {inspections++; return finalRows.find(row => row.pid === pid) ?? null;},
        fenceEntries: async () => {inspections++; return finalRows;},
        fencePids: async () => {inspections++; return finalRows.map(row => row.pid);},
        signalGroup: () => assert.fail('observations cannot become Linux group authority'),
      };
      t.mock.method(process, 'kill', () => assert.fail('replayed numeric metadata cannot reach a Linux signal sink'));
      for (let restart = 0; restart < 2; restart++) {
        const restored: ProcessGroup[] = JSON.parse(persisted);
        await assert.rejects(recoverProcess(root, 'obsolete-root', inspector,
          scenario === 'fence-pid-reuse' ? 'a'.repeat(32) : undefined, restored, () => {publications++;}), ProcessCleanupError);
        assert.equal(JSON.stringify(restored), persisted, 'no retirement or adoption may rewrite historical evidence');
      }
      assert.equal(inspections, 0, 'Linux recovery cannot consult observations as authority or absence proof');
      assert.equal(publications, 0, 'a process-table permutation cannot publish a fabricated owner');
    });
  }
}
