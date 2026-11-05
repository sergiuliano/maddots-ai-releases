import assert from 'node:assert/strict';
import childProcess, {type SpawnOptions} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import {promisify} from 'node:util';
import test, {type TestContext} from 'node:test';
import {TOOL_MATRIX} from '../src/shared/tool-matrix.js';
import type {Adapter, RunSpec} from '../src/runner/adapter.js';
import {ProcessCleanupError, recoverProcess, startTool, type ProcessEntry, type ProcessGroup, type ProcessInspector} from '../src/runner/process.js';

const fence = 'f'.repeat(32);
const cap = 20_000;
const sleep = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const timeout = () => Object.assign(new Error('process inspection timed out'), {code: 'ETIMEDOUT'});
const denied = () => Object.assign(new Error('process group disappeared during signalling'), {code: 'EPERM'});

interface Outcome {value?: boolean; error?: unknown; elapsed: number}

function legacyDarwin(t: TestContext): void {
  if (process.platform === 'darwin') return;
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', {...descriptor, value: 'darwin'});
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
}

/** Advance mocked time only after the current inspection's promises have run. */
async function settle(t: TestContext, work: () => Promise<boolean>): Promise<Outcome> {
  legacyDarwin(t);
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
  const began = Date.now();
  let outcome: Outcome | undefined;
  void work().then(value => {outcome = {value, elapsed: Date.now() - began};}, error => {outcome = {error, elapsed: Date.now() - began};});
  await flush();
  while (!outcome && Date.now() - began < cap) {
    t.mock.timers.tick(25);
    await flush();
  }
  assert(outcome, 'cleanup must settle within its 20 second bound even when an inspection never resolves');
  return outcome;
}

function recover(inspector: ProcessInspector, groups: ProcessGroup[] = []) {
  // No actual child or PID signal is needed. Saved identities authorize only
  // the fake group's injected signalGroup operation.
  return recoverProcess(0, '', inspector, fence, groups);
}

function emptyInspector(): ProcessInspector {
  return {table: async () => [], fencePids: async () => [], identity: async () => null,
    signalGroup: () => assert.fail('an empty process tree must not be signalled')};
}

test('TLS21-P1: Darwin ps backend rejects an unresolved leaderless group on every host', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', {...descriptor, value: 'darwin'});
  const originalExecFile = childProcess.execFile;
  const originalExecFileSync = childProcess.execFileSync;
  const pgid = 900001, member = 900002;
  let tables = 0, fences = 0;
  const ps = async (file: string, args: string[], options: {env: Record<string, string>}) => {
    assert.equal(file, '/bin/ps');
    assert.deepEqual(options.env, {TZ: 'UTC0', LC_ALL: 'C', LC_TIME: 'C'});
    if (args[0] === '-axo') {
      assert.deepEqual(args, ['-axo', 'pid=,ppid=,pgid=,lstart=']);
      tables++;
      return {stdout: `  ${member}  1  ${pgid}  Mon Oct 26 00:00:00 2026\n`, stderr: ''};
    }
    assert.deepEqual(args, ['-A', '-E', '-ww', '-o', 'pid=,uid=,command=']);
    fences++;
    return {stdout: '', stderr: ''};
  };
  // A fresh module captures this promisified ps mock instead of the host's ps.
  childProcess.execFile = Object.assign(() => assert.fail('ps must use the promisified mock'),
    {[promisify.custom]: ps}) as unknown as typeof childProcess.execFile;
  childProcess.execFileSync = ((file: string, args: string[], options: {env: Record<string, string>}) => {
    assert.equal(file, '/bin/ps');
    assert.deepEqual(options.env, {TZ: 'UTC0', LC_ALL: 'C', LC_TIME: 'C'});
    assert.deepEqual(args, ['-p', args[1], '-o', 'pid=,ppid=,pgid=,lstart=']);
    if (Number(args[1]) === member) return darwinTableRow(member, pgid);
    throw Object.assign(new Error('ps: PID is absent'), {status: 1, stdout: '', stderr: ''});
  }) as typeof childProcess.execFileSync;
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.execFile = originalExecFile;
    childProcess.execFileSync = originalExecFileSync;
    Object.defineProperty(process, 'platform', descriptor);
    syncBuiltinESMExports();
  });
  const signals: number[] = [];
  t.mock.method(process, 'kill', (pid: number) => {signals.push(pid); return true;});
  const darwin = await import(new URL('../src/runner/process.js?tls21-p1-ps', import.meta.url).href);
  const outcome = await settle(t, () => darwin.recoverProcess(0, '', undefined, fence, [{pgid, startedAt: ''}]));
  assert.equal((outcome.error as {code?: string} | undefined)?.code, 'tool_failed');
  assert.equal(outcome.elapsed, cap, 'unresolved ownership must keep recovery pending until the cleanup cap');
  assert.deepEqual(signals, [], 'unrelated processes must never receive a group or PID signal');
  assert(tables > 1 && fences > 1, 'recovery must retry complete ps and fence scans before rejecting');
});

let darwinImports = 0;
async function mockDarwinPs(t: TestContext, tag: string, stdout: (args: string[]) => string | Promise<string>,
  snapshot: () => string,
  onSignal?: (pid: number, signal?: NodeJS.Signals | number) => void) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const originalExecFile = childProcess.execFile;
  const originalExecFileSync = childProcess.execFileSync;
  Object.defineProperty(process, 'platform', {...descriptor, value: 'darwin'});
  const signals: {pid: number; signal?: NodeJS.Signals | number}[] = [];
  const kill = t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
    signals.push({pid, signal}); onSignal?.(pid, signal); return true;
  });
  const ps = async (file: string, args: string[], options: {env: Record<string, string>}) => {
    assert.equal(file, '/bin/ps');
    assert.deepEqual(options.env, {TZ: 'UTC0', LC_ALL: 'C', LC_TIME: 'C'});
    if (args[0] === '-p') assert.deepEqual(args, ['-p', args[1], '-o', 'lstart=']);
    else if (args[0] === '-axo') assert.deepEqual(args, ['-axo', 'pid=,ppid=,pgid=,lstart=']);
    else assert.deepEqual(args, ['-A', '-E', '-ww', '-o', 'pid=,uid=,command=']);
    const output = await stdout(args);
    // An absent PID is ps status 1, not a successful empty lstart response.
    if (args[0] === '-p' && !output) throw Object.assign(new Error('ps: PID is absent'), {code: 1, stdout: '', stderr: ''});
    return {stdout: output, stderr: ''};
  };
  childProcess.execFile = Object.assign(() => assert.fail('ps must use the promisified mock'),
    {[promisify.custom]: ps}) as unknown as typeof childProcess.execFile;
  childProcess.execFileSync = ((file: string, args: string[], options: {env: Record<string, string>}) => {
    assert.equal(file, '/bin/ps');
    assert.deepEqual(options.env, {TZ: 'UTC0', LC_ALL: 'C', LC_TIME: 'C'});
    assert.deepEqual(args, ['-p', args[1], '-o', 'pid=,ppid=,pgid=,lstart=']);
    const output = snapshot().split('\n').find(line => Number(/^\s*(\d+)\s/u.exec(line)?.[1]) === Number(args[1]));
    if (!output) throw Object.assign(new Error('ps: PID is absent'), {status: 1, stdout: '', stderr: ''});
    return `${output}\n`;
  }) as typeof childProcess.execFileSync;
  syncBuiltinESMExports();
  t.after(() => {
    kill.mock.restore();
    childProcess.execFile = originalExecFile;
    childProcess.execFileSync = originalExecFileSync;
    Object.defineProperty(process, 'platform', descriptor);
    syncBuiltinESMExports();
  });
  const fresh = () => import(new URL(`../src/runner/process.js?darwin-fix7-${tag}-${++darwinImports}`, import.meta.url).href);
  const darwin = await fresh();
  return {darwin, signals, fresh};
}

const darwinStart = 'Mon Oct 26 00:00:00 2026';
const darwinReplacement = 'Mon Oct 26 00:00:01 2026';
const darwinFenceRow = (pid: number) => `  ${pid}  ${process.getuid!()}  /mock/tool MDAI_RUN_FENCE=${fence}\n`;
const darwinTableRow = (pid: number, pgid: number, startedAt = darwinStart, ppid = 1) => `  ${pid}  ${ppid}  ${pgid}  ${startedAt}    \n`;

test('Darwin ps backend binds a stable fence to its lstart before signalling', async t => {
  const child = 900_010;
  let alive = true, identities = 0, fences = 0;
  const {darwin, signals} = await mockDarwinPs(t, 'stable-fence', args => {
    if (args[0] === '-p') {identities++; return alive ? `${darwinStart}\n` : '';}
    if (args[0] === '-axo') return alive ? darwinTableRow(child, child) : '';
    fences++; return alive ? darwinFenceRow(child) : '';
  }, () => {identities++; return alive ? darwinTableRow(child, child) : '';}, () => {alive = false;});
  const outcome = await settle(t, () => darwin.recoverProcess(0, '', undefined, fence));
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.value, true);
  assert.deepEqual(signals, [{pid: child, signal: 'SIGTERM'}]);
  assert(identities >= 2, 'the real Darwin backend must read and revalidate the fenced PID lifetime');
  assert(fences >= 4, 'fence scans must bracket lifetime acquisition and signal revalidation');
});

for (const change of ['replacement', 'disappearance'] as const) {
  test(`Darwin ps backend rejects a fenced PID ${change} during persistence`, async t => {
    const child = 900_020;
    let changed = false, fenceVisible = true, replacementRechecked = false;
    let identities = 0, identitiesBeforeSave = 0, saves = 0;
    const {darwin, signals} = await mockDarwinPs(t, `fence-${change}`, args => {
      if (args[0] === '-p') {
        identities++;
        if (changed && change === 'replacement') replacementRechecked = true;
        return !changed ? `${darwinStart}\n` : change === 'replacement' ? `${darwinReplacement}\n` : '';
      }
      if (args[0] === '-axo') return !changed ? darwinTableRow(child, child) :
        change === 'replacement' ? darwinTableRow(child, child, darwinReplacement) : '';
      return fenceVisible ? darwinFenceRow(child) : '';
    }, () => {
      identities++;
      if (changed && change === 'replacement') replacementRechecked = true;
      return !changed ? darwinTableRow(child, child) :
        change === 'replacement' ? darwinTableRow(child, child, darwinReplacement) : '';
    });
    const outcome = await settle(t, () => darwin.recoverProcess(0, '', undefined, fence, [], async () => {
      saves++;
      if (!changed) {
        identitiesBeforeSave = identities;
        await Promise.resolve();
        changed = true;
        if (change === 'disappearance') fenceVisible = false;
      } else if (replacementRechecked) {
        // Keep the token visible throughout the first signal-boundary check.
        // Only a later scan may observe the replacement clearing its fence.
        fenceVisible = false;
      }
    }));
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.value, true);
    assert(saves > 0 && changed, 'the PID changes while the persistence callback is pending');
    assert(identitiesBeforeSave > 0, 'ps must bind the initial fence to lstart before awaiting persistence');
    if (change === 'replacement') assert(replacementRechecked, 'the replacement lifetime must be rejected while its fence is still visible');
    assert.deepEqual(signals, [], 'persisted fence evidence cannot signal an absent or replacement lifetime');
  });
}

test('Darwin ps backend keeps an unavailable fenced lstart pending through the cleanup cap', async t => {
  const child = 900_030;
  let identities = 0, fences = 0;
  const {darwin, signals} = await mockDarwinPs(t, 'unavailable-fence-lifetime', args => {
    if (args[0] === '-p') {identities++; return '';}
    if (args[0] === '-axo') return darwinTableRow(child, child);
    fences++; return darwinFenceRow(child);
  }, () => {throw timeout();});
  const outcome = await settle(t, () => darwin.recoverProcess(0, '', undefined, fence));
  assert.equal((outcome.error as {code?: string} | undefined)?.code, 'tool_failed');
  assert.equal(outcome.elapsed, cap, 'a visible fence without its lifetime cannot prove ownership or disappearance');
  assert(identities > 1 && fences > 1, 'unavailable lstart evidence requires repeated complete fence checks');
  assert.deepEqual(signals, [], 'a numeric fence PID cannot authorize any signal');
});

test('Darwin ps backend revalidates a saved group witness after persistence', async t => {
  const pgid = 900_040, member = 900_041;
  let replaced = false, tables = 0, persisted = false;
  const {darwin, signals} = await mockDarwinPs(t, 'group-witness-replacement', args => {
    if (args[0] === '-p') return Number(args[1]) === member ? `${replaced ? darwinReplacement : darwinStart}\n` : '';
    if (args[0] === '-axo') {
      tables++;
      return darwinTableRow(member, pgid, replaced ? darwinReplacement : darwinStart);
    }
    return '';
  }, () => darwinTableRow(member, pgid, replaced ? darwinReplacement : darwinStart));
  const group: ProcessGroup = {pgid, startedAt: '', members: [{pid: member, startedAt: darwinStart}]};
  const outcome = await settle(t, () => darwin.recoverProcess(0, '', undefined, undefined, [group], async (groups: ProcessGroup[]) => {
    if (!replaced && tables >= 3 && groups.some(saved => saved.members?.some(witness => witness.pid === member && witness.startedAt === darwinStart))) {
      persisted = true;
      await Promise.resolve();
      replaced = true;
    }
  }));
  assert(persisted, 'the saved group is selected before its witness is replaced during persistence');
  assert.deepEqual(signals, [], 'a stale group witness cannot signal the reused group or PID');
  assert.equal((outcome.error as {code?: string} | undefined)?.code, 'tool_failed');
  assert.equal(outcome.elapsed, cap, 'the unresolved leaderless numeric group remains pending without a live witness');
});

// Each label maps to one of the 16 native failure reports. These drive the real
// Darwin ps backend on Linux without spawning or signalling a host process.
const darwinOrphanCases = [
  {id: 1232, label: 'full 5.6 second live-scan outage', outage: 5_600},
  {id: 1233, label: 'immediate Apple /bin/sleep'},
  {id: 1234, label: 'immediate environment-cleared node'},
  {id: 1235, label: 'sleep born after one second', delay: 1_000},
  {id: 1236, label: 'TERM-ignoring shell, immediate root exit'},
  {id: 1237, label: 'TERM-ignoring shell, root exits after 150 ms', delay: 150},
  {id: 1238, label: 'TERM-ignoring shell born after one second', delay: 1_000},
  {id: 1239, label: 'non-detached shell loop'},
  {id: 1240, label: 'stop creates an orphan on TERM', termBirth: true},
  {id: 1241, label: 'deadline creates an orphan on TERM', termBirth: true},
  {id: 1365, label: 'orphan-group stop before a periodic snapshot', termBirth: true},
  {id: 1242, label: 'direct recovery creates an unfenced orphan on TERM', termBirth: true},
] as const;

for (const scenario of darwinOrphanCases) for (const guardian of [false, true]) {
  test(`Darwin fix7 ${scenario.id}: ${scenario.label}, ${guardian ? 'retained guardian captures the member' : 'missing witness refuses the survivor'}`, async t => {
    const root = 901_000, tool = 901_001, member = 901_002;
    const termBirth = 'termBirth' in scenario;
    const outage = 'outage' in scenario ? scenario.outage : 0;
    const delay = 'delay' in scenario ? scenario.delay : 0;
    let rootAlive = true, toolAlive = guardian, memberAlive = false, firstTable = true;
    let ledger: ProcessGroup[] = [], capturedBeforeSignal = false, tables = 0;
    const {darwin, signals} = await mockDarwinPs(t, `orphan-${scenario.id}-${guardian}`, async args => {
      if (args[0] === '-p') {
        const pid = Number(args[1]);
        return (pid === root && rootAlive || pid === tool && toolAlive || pid === member && memberAlive) ? `${darwinStart}    \n` : '';
      }
      if (args[0] !== '-axo') return ''; // Apple binaries and cleared environments expose no fence.
      tables++;
      if (firstTable) {
        firstTable = false;
        if (delay) await sleep(delay);
        if (!termBirth) {rootAlive = guardian; toolAlive = false; memberAlive = true;}
      }
      if (Date.now() - 1_000_000 < outage) {
        await sleep(Math.min(2_000, outage - (Date.now() - 1_000_000)));
        throw timeout();
      }
      return (rootAlive ? darwinTableRow(root, root) : '') +
        (toolAlive ? darwinTableRow(tool, root, darwinStart, root) : '') +
        (memberAlive ? darwinTableRow(member, root) : '');
    }, () => {
      if (Date.now() - 1_000_000 < outage) throw timeout();
      return (rootAlive ? darwinTableRow(root, root) : '') +
        (toolAlive ? darwinTableRow(tool, root, darwinStart, root) : '') +
        (memberAlive ? darwinTableRow(member, root) : '');
    }, (pid, signal) => {
      assert(pid === -root || guardian && [root, tool, member].includes(pid), 'only the authenticated group or its saved lifetimes may receive a signal');
      assert(ledger.some(group => group.pgid === root && group.cleanupPending), 'the cleanup obligation is durable before the first signal');
      if (guardian && memberAlive) {
        assert(ledger.some(group => group.members?.some(saved => saved.pid === member && saved.startedAt === darwinStart)),
          'the guardian makes the orphan lifetime durable before signalling it');
        capturedBeforeSignal = true;
      }
      if (termBirth && signal === 'SIGTERM') {
        // The retained guardian and its TERM-ignoring descendants may also be
        // revalidated and targeted individually after the initial group TERM.
        if (pid === -root) {rootAlive = guardian; toolAlive = false; memberAlive = true;}
      } else {rootAlive = false; toolAlive = false; memberAlive = false;}
    });
    const outcome = await settle(t, () => darwin.recoverProcess(root, darwinStart, undefined, fence,
      [{pgid: root, startedAt: darwinStart}], (groups: ProcessGroup[]) => {ledger = structuredClone(groups);}));
    assert(tables > 1, 'cleanup requires repeated complete inspection, including after signalling');
    if (guardian) {
      assert.equal(outcome.error, undefined);
      assert.equal(outcome.value, true);
      assert.equal(memberAlive, false);
      assert(capturedBeforeSignal, 'the unfenced member is observed and persisted through its retained guardian');
      assert(ledger.every(group => !group.cleanupPending), 'successful absence discharges the cleanup obligation');
      if (outage) assert(outcome.elapsed >= outage, 'the 5.6 second outage cannot be mistaken for disappearance');
      if (termBirth) assert.deepEqual(signals.filter(value => value.pid < 0), [{pid: -root, signal: 'SIGTERM'}, {pid: -root, signal: 'SIGKILL'}]);
      else assert.deepEqual(signals, [{pid: -root, signal: 'SIGTERM'}]);
    } else {
      assert.equal((outcome.error as {code?: string} | undefined)?.code, 'tool_failed');
      assert.equal(outcome.elapsed, cap, 'the indistinguishable unseen survivor remains unresolved within the cleanup bound');
      assert.equal(memberAlive, true);
      assert.deepEqual(signals, termBirth ? [{pid: -root, signal: 'SIGTERM'}] : [], 'numeric PGID continuity cannot authorize a later signal');
      if (termBirth) assert(ledger.some(group => group.cleanupPending), 'TERM followed by witness loss retains the durable obligation');
    }
  });
}

for (const truthful of [false, true]) {
  test(`Darwin fix7 1371: ${truthful ? 'truthful root row discovers a detached fenced PID' : 'contradictory live identity and empty table send no initial TERM'}`, async t => {
    const root = 902_000, child = 902_001;
    let rootAlive = true, childAlive = false;
    const {darwin, signals} = await mockDarwinPs(t, `detached-term-${truthful}`, args => {
      if (args[0] === '-p') return (Number(args[1]) === root && rootAlive || Number(args[1]) === child && childAlive) ? `${darwinStart}    \n` : '';
      if (args[0] === '-axo') return (truthful && rootAlive ? darwinTableRow(root, root) : '') +
        (childAlive ? darwinTableRow(child, child) : ''); // ppid=1 never supplies ancestry.
      return childAlive ? darwinFenceRow(child) : '';
    }, () => (truthful && rootAlive ? darwinTableRow(root, root) : '') +
      (childAlive ? darwinTableRow(child, child) : ''), (pid, signal) => {
      assert.equal(signal, 'SIGTERM');
      if (pid === -root) {rootAlive = false; childAlive = true;}
      else {assert.equal(pid, child, 'the detached child is targeted by its fenced lifetime, not an adopted group'); childAlive = false;}
    });
    const outcome = await settle(t, () => darwin.recoverProcess(root, darwinStart, undefined, fence));
    if (truthful) {
      assert.equal(outcome.error, undefined); assert.equal(outcome.value, true);
      assert.equal(childAlive, false);
      assert.deepEqual(signals, [{pid: -root, signal: 'SIGTERM'}, {pid: child, signal: 'SIGTERM'}]);
    } else {
      assert.equal((outcome.error as {code?: string} | undefined)?.code, 'tool_failed');
      assert.equal(outcome.elapsed, cap);
      assert.deepEqual(signals, [], 'identity alone cannot replace the group witness at the signal boundary');
      assert.equal(childAlive, false, 'without initial TERM the fixture has never created its detached child');
    }
  });
}

for (const witness of [false, true]) {
  test(`Darwin fix7 1408: observed detached leader exits, ${witness ? 'a saved same-group member authenticates its replacement child' : 'an unseen unfenced child supplies no authority'}`, async t => {
    const root = 903_000, leader = 903_001, peer = 903_002, child = 903_003;
    let transitioned = false, childAlive = false, peerAlive = witness;
    let ledger: ProcessGroup[] = [], captured = false;
    const {darwin, signals} = await mockDarwinPs(t, `observed-detached-${witness}`, args => {
      if (args[0] === '-p') {
        const pid = Number(args[1]);
        return (!transitioned && [root, leader].includes(pid) || peerAlive && pid === peer || childAlive && pid === child) ? `${darwinStart}    \n` : '';
      }
      if (args[0] !== '-axo') return '';
      return (!transitioned ? darwinTableRow(root, root) + darwinTableRow(leader, leader, darwinStart, root) : '') +
        (peerAlive ? darwinTableRow(peer, leader) : '') + (childAlive ? darwinTableRow(child, leader) : '');
    }, () => (!transitioned ? darwinTableRow(root, root) + darwinTableRow(leader, leader, darwinStart, root) : '') +
      (peerAlive ? darwinTableRow(peer, leader) : '') + (childAlive ? darwinTableRow(child, leader) : ''), (pid, signal) => {
      assert.equal(pid, -leader); assert.equal(signal, 'SIGTERM');
      assert(ledger.some(group => group.pgid === leader && group.cleanupPending &&
        group.members?.some(member => member.pid === child && member.startedAt === darwinStart)), 'a surviving member captures the late child before group signalling');
      captured = true; childAlive = false; peerAlive = false;
    });
    const outcome = await settle(t, () => darwin.recoverProcess(root, darwinStart, undefined, fence, [], (groups: ProcessGroup[]) => {
      ledger = structuredClone(groups);
      const detached = groups.find(group => group.pgid === leader);
      if (!transitioned && detached?.members?.some(member => member.pid === leader) &&
        (!witness || detached.members.some(member => member.pid === peer))) {
        transitioned = true; childAlive = true;
      }
    }));
    assert(transitioned, 'the detached leader lifetime is saved before its unseen child replaces it');
    if (witness) {
      assert.equal(outcome.error, undefined); assert.equal(outcome.value, true);
      assert(captured); assert.equal(childAlive, false);
      assert.deepEqual(signals, [{pid: -leader, signal: 'SIGTERM'}]);
    } else {
      assert.equal((outcome.error as {code?: string} | undefined)?.code, 'tool_failed');
      assert.equal(outcome.elapsed, cap); assert.equal(childAlive, true);
      assert.deepEqual(signals, [], 'a historical detached leader cannot authenticate an unobserved survivor');
      assert(ledger.some(group => group.pgid === leader && group.cleanupPending));
    }
  });
}

for (const restart of [false, true]) {
  test(`Darwin fix7 ${restart ? 1016 : 1015}: durable late member survives inspection failure and ${restart ? 'a fresh backend restart' : 'same backend retry'}`, async t => {
    const guardian = 904_000, tool = 904_001, child = 904_002;
    let guardianAlive = true, toolAlive = true, childAlive = false, outage = false, retrying = false;
    let ledger: ProcessGroup[] = [], durableBeforeOutage = false;
    const harness = await mockDarwinPs(t, `persist-retry-${restart}`, args => {
      if (outage) throw timeout();
      if (args[0] === '-p') {
        const pid = Number(args[1]);
        return (pid === guardian && guardianAlive || pid === tool && toolAlive || pid === child && childAlive) ? `${darwinStart}    \n` : '';
      }
      if (args[0] !== '-axo') return '';
      return (guardianAlive ? darwinTableRow(guardian, guardian) : '') +
        (toolAlive ? darwinTableRow(tool, guardian, darwinStart, guardian) : '') +
        (childAlive ? darwinTableRow(child, guardian) : '');
    }, () => {
      if (outage) throw timeout();
      return (guardianAlive ? darwinTableRow(guardian, guardian) : '') +
        (toolAlive ? darwinTableRow(tool, guardian, darwinStart, guardian) : '') +
        (childAlive ? darwinTableRow(child, guardian) : '');
    }, (pid, signal) => {
      assert.equal(pid, -guardian); assert.equal(signal, 'SIGTERM');
      assert(ledger.some(group => group.cleanupPending), 'ownership is durable before TERM can remove the tool');
      if (!retrying) {toolAlive = false; childAlive = true;}
      else {
        assert(ledger.some(group => group.members?.some(member => member.pid === child && member.startedAt === darwinStart)));
        childAlive = false;
      }
    });
    const save = (groups: ProcessGroup[]) => {
      ledger = structuredClone(groups);
      if (!retrying && childAlive && groups.some(group => group.members?.some(member => member.pid === child && member.startedAt === darwinStart))) {
        durableBeforeOutage = true; guardianAlive = false; outage = true;
      }
    };
    const interrupted = await settle(t, () => harness.darwin.recoverProcess(guardian, darwinStart, undefined, undefined, [], save));
    assert.equal((interrupted.error as {code?: string} | undefined)?.code, 'tool_failed');
    assert.equal(interrupted.elapsed, cap); assert(durableBeforeOutage); assert.equal(childAlive, true);
    assert.deepEqual(harness.signals, [{pid: -guardian, signal: 'SIGTERM'}]);
    assert(ledger.some(group => group.cleanupPending && group.members?.some(member => member.pid === child)), 'the saved member and obligation survive the failed attempt');
    t.mock.timers.reset(); outage = false; retrying = true;
    const recoveredBackend = restart ? await harness.fresh() : harness.darwin;
    const recovered = await settle(t, () => recoveredBackend.recoverProcess(guardian, darwinStart, undefined, undefined, ledger, save));
    assert.equal(recovered.error, undefined); assert.equal(recovered.value, true);
    assert.equal(guardianAlive, false, 'the retry cannot rely on its old guardian');
    assert.equal(childAlive, false);
    assert.deepEqual(harness.signals, [{pid: -guardian, signal: 'SIGTERM'}, {pid: -guardian, signal: 'SIGTERM'}]);
    assert(ledger.every(group => !group.cleanupPending));
  });
}

for (const restart of [false, true]) {
  test(`Darwin fix7 ${restart ? 1016 : 1015} original R6 negative: another group's session anchor cannot authenticate the unseen child on ${restart ? 'fresh backend restart' : 'same backend retry'}`, async t => {
    const root = 904_100, child = 904_101, anchor = 904_102;
    let rootAlive = true, childAlive = false, outage = false, ledger: ProcessGroup[] = [];
    const anchorAlive = true;
    const harness = await mockDarwinPs(t, `original-r6-unrelated-anchor-${restart}`, args => {
      if (args[0] === '-p') {
        const pid = Number(args[1]);
        return (pid === root && rootAlive || pid === child && childAlive || pid === anchor && anchorAlive) ? `${darwinStart}    \n` : '';
      }
      if (args[0] !== '-axo') return ''; // The orphan cleared its inherited fence.
      if (outage) throw timeout();
      return darwinTableRow(anchor, anchor) + (rootAlive ? darwinTableRow(root, root) : '') +
        (childAlive ? darwinTableRow(child, root) : '');
    }, () => {
      if (outage) throw timeout();
      return darwinTableRow(anchor, anchor) + (rootAlive ? darwinTableRow(root, root) : '') +
        (childAlive ? darwinTableRow(child, root) : '');
    }, (pid, signal) => {
      assert.equal(pid, -root, 'the unrelated anchor and its process group are never targets');
      assert.equal(signal, 'SIGTERM');
      assert(ledger.some(group => group.pgid === root && group.cleanupPending), 'the obligation is durable before TERM removes the final group witness');
      rootAlive = false; childAlive = true; outage = true;
    });
    const save = (groups: ProcessGroup[]) => {ledger = structuredClone(groups);};
    // This is the original R6 evidence: its live anchor belongs to a different
    // group. Darwin cannot use the legacy saved numeric SID as authority.
    const original: ProcessGroup = {pgid: root, startedAt: darwinStart, sid: String(anchor),
      sessionLeader: {pid: anchor, startedAt: darwinStart}};
    const interrupted = await settle(t, () => harness.darwin.recoverProcess(root, darwinStart, undefined, undefined, [original], save));
    assert.equal((interrupted.error as {code?: string} | undefined)?.code, 'tool_failed');
    assert.equal(interrupted.elapsed, cap); assert.equal(childAlive, true);
    assert(ledger.some(group => group.cleanupPending));
    assert(ledger.every(group => !group.members?.some(member => [child, anchor].includes(member.pid))), 'neither the unseen child nor the unrelated anchor becomes saved group evidence');
    assert.deepEqual(harness.signals, [{pid: -root, signal: 'SIGTERM'}]);
    t.mock.timers.reset(); outage = false;
    const backend = restart ? await harness.fresh() : harness.darwin;
    const retried = await settle(t, () => backend.recoverProcess(root, darwinStart, undefined, undefined, ledger, save));
    assert.equal((retried.error as {code?: string} | undefined)?.code, 'tool_failed');
    assert.equal(retried.elapsed, cap); assert.equal(childAlive, true);
    assert(ledger.some(group => group.cleanupPending), 'the surviving anchor cannot discharge the unresolved cleanup obligation');
    assert.deepEqual(harness.signals, [{pid: -root, signal: 'SIGTERM'}], 'the retry cannot signal an unseen member using a different group as a witness');
    t.mock.timers.reset(); childAlive = false;
    const absent = await settle(t, () => backend.recoverProcess(root, darwinStart, undefined, undefined, ledger, save));
    assert.equal(absent.error, undefined); assert.equal(absent.value, true);
    assert(ledger.every(group => !group.cleanupPending), 'successful absence retires only the original group obligation');
    assert.equal(anchorAlive, true, 'the unrelated live anchor survives verification and cleanup');
    assert.deepEqual(harness.signals, [{pid: -root, signal: 'SIGTERM'}]);
  });
}

test('Darwin fix7 retry hole: final witness loss retains the obligation across same and fresh retries until successful absence', async t => {
  const root = 905_000, child = 905_001;
  let rootAlive = true, childAlive = false, outage = false, ledger: ProcessGroup[] = [];
  const harness = await mockDarwinPs(t, 'final-witness-retry-hole', args => {
    if (args[0] === '-p') return Number(args[1]) === root && rootAlive ? `${darwinStart}    \n` : '';
    if (args[0] !== '-axo') return '';
    if (outage) throw timeout();
    return (rootAlive ? darwinTableRow(root, root) : '') + (childAlive ? darwinTableRow(child, root) : '');
  }, () => {
    if (outage) throw timeout();
    return (rootAlive ? darwinTableRow(root, root) : '') + (childAlive ? darwinTableRow(child, root) : '');
  }, (pid, signal) => {
    assert.equal(pid, -root); assert.equal(signal, 'SIGTERM');
    rootAlive = false; childAlive = true; outage = true;
  });
  const save = (groups: ProcessGroup[]) => {ledger = structuredClone(groups);};
  const interrupted = await settle(t, () => harness.darwin.recoverProcess(root, darwinStart, undefined, undefined, [], save));
  assert.equal((interrupted.error as {code?: string} | undefined)?.code, 'tool_failed');
  assert.equal(interrupted.elapsed, cap);
  assert(ledger.every(group => !group.members?.some(member => member.pid === child)), 'the inspection outage begins before the orphan lifetime is observed');
  outage = false;
  for (const fresh of [false, true]) {
    t.mock.timers.reset();
    const backend = fresh ? await harness.fresh() : harness.darwin;
    const retried = await settle(t, () => backend.recoverProcess(root, darwinStart, undefined, undefined, ledger, save));
    assert.equal(childAlive, true);
    assert.deepEqual(harness.signals, [{pid: -root, signal: 'SIGTERM'}], 'a pending obligation cannot authorize a signal to the unseen member');
    assert.equal((retried.error as {code?: string} | undefined)?.code, 'tool_failed', `${fresh ? 'fresh' : 'same'} backend retry must not report completion while the unfenced child survives`);
    assert.equal(retried.elapsed, cap);
    assert(ledger.some(group => group.cleanupPending), 'a failed retry must preserve the pending verification obligation');
  }
  // Even apparent exit while ps is unavailable supplies no negative evidence.
  t.mock.timers.reset(); childAlive = false; outage = true;
  const unavailable = await settle(t, () => harness.darwin.recoverProcess(root, darwinStart, undefined, undefined, ledger, save));
  assert.equal((unavailable.error as {code?: string} | undefined)?.code, 'tool_failed');
  assert(ledger.some(group => group.cleanupPending));
  t.mock.timers.reset(); outage = false;
  const absent = await settle(t, () => harness.darwin.recoverProcess(root, darwinStart, undefined, undefined, ledger, save));
  assert.equal(absent.error, undefined); assert.equal(absent.value, true);
  assert(ledger.every(group => !group.cleanupPending), 'only successful complete absence discharges the persisted obligation');
  assert.deepEqual(harness.signals, [{pid: -root, signal: 'SIGTERM'}]);
});

for (const inspection of ['table', 'fence'] as const) {
  test(`runner cleanup retries a ${inspection} timeout and verifies an empty tree`, async t => {
    const inspector = emptyInspector();
    let attempts = 0;
    const inspect = async () => {
      if (++attempts === 1) {await sleep(2_000); throw timeout();}
      return [];
    };
    if (inspection === 'table') inspector.table = inspect;
    else inspector.fencePids = inspect;
    const outcome = await settle(t, () => recover(inspector));
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.value, true);
    assert(attempts > 1, 'a failed inspection requires a later successful inspection');
    assert(outcome.elapsed >= 2_000 && outcome.elapsed < cap);
  });

  test(`runner cleanup keeps retrying ${inspection} failures until the verification cap`, async t => {
    const inspector = emptyInspector();
    let attempts = 0;
    const inspect = async () => {attempts++; await sleep(2_000); throw timeout();};
    if (inspection === 'table') inspector.table = inspect;
    else inspector.fencePids = inspect;
    const outcome = await settle(t, () => recover(inspector));
    assert(outcome.error instanceof ProcessCleanupError);
    assert.equal(outcome.elapsed, cap);
    assert(attempts > 1, 'an inspection failure must not abort cleanup early');
  });

  test(`runner cleanup bounds a ${inspection} inspection that never resolves`, async t => {
    const inspector = emptyInspector();
    const inspect = async () => new Promise<never>(() => undefined);
    if (inspection === 'table') inspector.table = inspect;
    else inspector.fencePids = inspect;
    const outcome = await settle(t, () => recover(inspector));
    assert(outcome.error instanceof ProcessCleanupError);
    assert.equal(outcome.elapsed, cap);
  });
}

test('runner cleanup succeeds after slow complete inspections prove the tree empty', async t => {
  const inspector = emptyInspector();
  inspector.fencePids = async () => {await sleep(1_200); return [];};
  inspector.table = async () => {await sleep(1_200); return [];};
  const outcome = await settle(t, () => recover(inspector));
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.value, true);
  assert(outcome.elapsed >= 3_600 && outcome.elapsed < cap);
});

function liveGroup() {
  const pgid = 900_100;
  const group: ProcessGroup = {pgid, startedAt: 'original-group-start'};
  const row: ProcessEntry = {pid: pgid, ppid: 1, pgid, startedAt: group.startedAt};
  let alive = true;
  const signals: {signal: NodeJS.Signals; at: number}[] = [];
  const inspector: ProcessInspector = {
    table: async () => alive ? [row] : [],
    identity: async pid => alive && pid === pgid ? group.startedAt : null,
    fencePids: async () => [],
    signalGroup: (pid, signal) => {assert.equal(pid, pgid); signals.push({signal, at: Date.now()});},
  };
  return {group, row, inspector, signals, gone: () => {alive = false;}};
}

test('runner cleanup preserves TERM grace and fails closed when a process survives SIGKILL', async t => {
  const f = liveGroup();
  let killed = false, tables = 0, completePostKillScans = 0;
  f.inspector.fencePids = async () => {tables = 0; return [];};
  f.inspector.table = async () => {
    if (++tables === 2 && killed) completePostKillScans++;
    return [f.row];
  };
  const signalGroup = f.inspector.signalGroup!;
  f.inspector.signalGroup = (pid, signal) => {signalGroup(pid, signal); if (signal === 'SIGKILL') killed = true;};
  const outcome = await settle(t, () => recover(f.inspector, [f.group]));
  assert(outcome.error instanceof ProcessCleanupError);
  assert.equal(outcome.elapsed, cap);
  assert.equal(f.signals[0].signal, 'SIGTERM');
  assert.equal(f.signals.find(value => value.signal === 'SIGKILL')!.at - f.signals[0].at, 5_000);
  assert(completePostKillScans >= 3, 'a survivor requires complete post-SIGKILL scans until the cap');
});

test('runner recovery gives a verified group full TERM grace after a slow initial scan', async t => {
  const f = liveGroup();
  let fences = 0, tables = 0;
  f.inspector.fencePids = async () => {if (++fences === 1) await sleep(1_200); return [];};
  f.inspector.table = async () => {if (++tables <= 2) await sleep(1_200); return [f.row];};
  const outcome = await settle(t, () => recover(f.inspector, [f.group]));
  assert(outcome.error instanceof ProcessCleanupError);
  assert.equal(outcome.elapsed, cap);
  const term = f.signals.find(value => value.signal === 'SIGTERM')!;
  const kill = f.signals.find(value => value.signal === 'SIGKILL')!;
  assert.equal(term.at, 1_003_600, 'TERM follows a complete initial inspection');
  assert(kill.at - term.at >= 5_000, 'slow inspection cannot consume a recovered group\'s TERM grace');
});

test('runner recovery preserves TERM grace when a late first scan leaves less than five seconds', async t => {
  const f = liveGroup();
  let fences = 0;
  f.inspector.fencePids = async () => {if (++fences === 1) await sleep(16_000); return [];};
  const outcome = await settle(t, () => recover(f.inspector, [f.group]));
  assert(outcome.error instanceof ProcessCleanupError);
  assert.equal(outcome.elapsed, cap);
  assert.deepEqual(f.signals, [{signal: 'SIGTERM', at: 1_016_000}], 'the hard cap fails closed without shortening TERM grace');
});

test('runner cleanup verifies disappearance after a transient process-group EPERM', async t => {
  const f = liveGroup();
  let attempts = 0;
  f.inspector.signalGroup = pid => {assert.equal(pid, f.group.pgid); attempts++; f.gone(); throw denied();};
  const outcome = await settle(t, () => recover(f.inspector, [f.group]));
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.value, true);
  assert.equal(attempts, 1);
  assert(outcome.elapsed < cap);
});

test('runner cleanup fails at the cap when EPERM leaves a verified process alive', async t => {
  const f = liveGroup();
  let attempts = 0;
  f.inspector.signalGroup = pid => {assert.equal(pid, f.group.pgid); attempts++; throw denied();};
  const outcome = await settle(t, () => recover(f.inspector, [f.group]));
  assert(outcome.error instanceof ProcessCleanupError);
  assert.equal(outcome.elapsed, cap);
  assert(attempts > 1);
});

test('runner cleanup allows three complete post-SIGKILL inspections to establish disappearance', async t => {
  const f = liveGroup();
  let killed = false, tables = 0, completed = 0;
  const signalGroup = f.inspector.signalGroup!;
  f.inspector.signalGroup = (pid, signal) => {signalGroup(pid, signal); if (signal === 'SIGKILL') killed = true;};
  f.inspector.fencePids = async () => {tables = 0; return [];};
  f.inspector.table = async () => {
    const gone = killed && completed >= 2;
    if (++tables === 2 && killed) completed++;
    return gone ? [] : [f.row];
  };
  // Absence must be consistent with identity checks within descendants().
  f.inspector.identity = async () => killed && completed >= 2 ? null : f.group.startedAt;
  // Discovery now validates a leader independently of a full table scan.
  f.inspector.inspectSync = () => killed && completed >= 2 ? null : f.row;
  const outcome = await settle(t, () => recover(f.inspector, [f.group]));
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.value, true);
  assert.equal(completed, 3);
  assert(outcome.elapsed >= 5_000 && outcome.elapsed < cap);
});

test('runner recovery retries a failed initial identity inspection before cleanup', async t => {
  const inspector = emptyInspector();
  let attempts = 0;
  inspector.identity = async () => {
    if (++attempts === 1) {await sleep(2_000); throw timeout();}
    return null;
  };
  const outcome = await settle(t, () => recoverProcess(900_200, 'saved-root-start', inspector, fence));
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.value, true);
  assert(attempts > 1);
  assert(outcome.elapsed >= 2_000 && outcome.elapsed < cap);
});

for (const failure of ['timeout', 'never resolves'] as const) {
  test(`runner recovery bounds an initial identity inspection that ${failure === 'timeout' ? 'keeps failing' : failure}`, async t => {
    const inspector = emptyInspector();
    inspector.identity = async () => {
      if (failure === 'never resolves') return new Promise<never>(() => undefined);
      await sleep(2_000); throw timeout();
    };
    const outcome = await settle(t, () => recoverProcess(900_200, 'saved-root-start', inspector, fence));
    assert(outcome.error instanceof ProcessCleanupError);
    assert.equal(outcome.elapsed, cap);
  });
}

test('runner recovery retries saved-group inspection before deciding no ownership exists', async t => {
  const inspector = emptyInspector();
  let attempts = 0;
  inspector.table = async () => {
    if (++attempts === 1) {await sleep(2_000); throw timeout();}
    return [];
  };
  const outcome = await settle(t, () => recoverProcess(0, '', inspector, undefined, [{pgid: 900_200, startedAt: 'saved-group-start'}]));
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.value, false);
  assert(attempts > 1);
  assert(outcome.elapsed >= 2_000 && outcome.elapsed < cap);
});

test('runner cleanup retries an incomplete scan without signalling from its partial evidence', async t => {
  const f = liveGroup();
  const table = f.inspector.table;
  let tables = 0;
  f.inspector.table = async () => {
    if (++tables === 2) {await sleep(2_000); throw timeout();}
    return table();
  };
  const signalGroup = f.inspector.signalGroup!;
  f.inspector.signalGroup = (pid, signal) => {signalGroup(pid, signal); f.gone();};
  const outcome = await settle(t, () => recover(f.inspector, [f.group]));
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.value, true);
  assert.equal(f.signals.length, 1);
  assert(f.signals[0].at >= 1_002_000, 'signalling waits for a later complete successful scan');
});

test('runner cleanup never treats failed verification after signalling as proof the tree is gone', async t => {
  const f = liveGroup();
  let signalled = false;
  f.inspector.signalGroup = () => {signalled = true; f.gone();};
  f.inspector.fencePids = async () => {
    if (signalled) {await sleep(2_000); throw timeout();}
    return [];
  };
  const outcome = await settle(t, () => recover(f.inspector, [f.group]));
  assert(outcome.error instanceof ProcessCleanupError);
  assert.equal(outcome.elapsed, cap);
});

for (const blockedInspection of ['verification table', 'descendant identity', 'group leader identity', 'peer identity', 'expired deadline'] as const) {
  test(`runner cleanup persists a discovered group before ${blockedInspection} and recovers it later`, async t => {
    const root = 900_400, child = 900_401, peer = 900_402, leader = 900_403;
    const pgid = blockedInspection === 'group leader identity' ? leader : child;
    const survivor = blockedInspection === 'peer identity' ? peer : child;
    const survivorStart = survivor === peer ? 'peer-start' : 'child-start';
    let ledger: ProcessGroup[] = [], tables = 0, durableBeforeHang = false;
    const savedAt: number[] = [];
    const discovered = () => ledger.some(group => group.pgid === pgid &&
      group.members?.some(member => member.pid === survivor && member.startedAt === survivorStart));
    const hang = () => {
      durableBeforeHang = discovered();
      return new Promise<never>(() => undefined);
    };
    const rows: ProcessEntry[] = [
      {pid: root, ppid: 1, pgid: root, startedAt: 'root-start'},
      {pid: child, ppid: root, pgid, startedAt: 'child-start'},
    ];
    if (blockedInspection === 'descendant identity') rows.push({pid: peer, ppid: root, pgid: peer});
    if (blockedInspection === 'group leader identity') rows.push({pid: leader, ppid: 1, pgid});
    if (blockedInspection === 'peer identity') rows.push({pid: peer, ppid: 1, pgid, startedAt: 'peer-start'}, {pid: leader, ppid: 1, pgid});
    const inspector: ProcessInspector = {
      table: async () => ++tables === 1 ? rows : hang(),
      inspectSync: pid => rows.find(row => row.pid === pid) ?? null,
      identity: async pid => pid === root ? 'root-start' : hang(),
      fencePids: async () => [],
      signalGroup: () => assert.fail('an incomplete scan must not signal any group'),
    };
    let expired = false;
    const outcome = await settle(t, () => recoverProcess(root, 'root-start', inspector, fence, [], groups => {
      ledger = structuredClone(groups);
      savedAt.push(Date.now());
      if (blockedInspection === 'expired deadline' && discovered() && !expired) {
        expired = true;
        t.mock.timers.tick(cap);
      }
    }));
    assert(outcome.error instanceof ProcessCleanupError);
    assert.equal(outcome.elapsed, cap);
    assert(discovered(), 'the discovered group must reach the ledger even when cleanup expires');
    assert(savedAt.includes(1_000_000 + cap), 'deadline expiry must not skip the persistence hook');
    if (blockedInspection === 'expired deadline') assert.equal(tables, 1, 'the next inspection is rejected before it starts');
    else assert(durableBeforeHang, 'the discovered group must be durable before the next inspection consumes the cap');

    // The original root is gone and the survivor cleared its environment.
    // Only its saved identity can authorize this recovery.
    let alive = true;
    const signals: {pgid: number; signal: NodeJS.Signals}[] = [];
    const later: ProcessInspector = {
      table: async () => alive ? [{pid: survivor, ppid: 1, pgid, startedAt: survivorStart}] : [],
      identity: async pid => alive && pid === survivor ? survivorStart : null,
      fencePids: async () => [],
      signalGroup: (group, signal) => {signals.push({pgid: group, signal}); alive = false;},
    };
    t.mock.timers.reset();
    const recovered = await settle(t, () => recoverProcess(root, 'root-start', later, undefined, ledger));
    assert.equal(recovered.error, undefined);
    assert.equal(recovered.value, true);
    assert.equal(alive, false);
    assert.deepEqual(signals, [{pgid, signal: 'SIGTERM'}]);
  });
}

test('runner cleanup fails closed within the cap when persistence never resolves', async t => {
  const f = liveGroup();
  let saves = 0;
  const outcome = await settle(t, () => recoverProcess(0, '', f.inspector, fence, [f.group], () => {
    saves++;
    return new Promise<never>(() => undefined);
  }));
  assert(outcome.error instanceof ProcessCleanupError);
  assert.equal(outcome.elapsed, cap);
  assert(saves > 1, 'finalization invokes persistence even after the cap');
  assert.deepEqual(f.signals, [], 'unpersisted evidence cannot authorize a signal');
});

for (const waitingOn of ['inspection', 'persistence'] as const) test(`runner stop signals its owned child before joining slow periodic ${waitingOn}`, async t => {
  legacyDarwin(t);
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-cleanup-clock-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const runDir = join(root, 'run');
  await mkdir(runDir);
  const promptFile = join(runDir, 'prompt.md');
  await writeFile(promptFile, 'Fixture task.');
  const bin = await realpath(process.execPath);
  const spec: RunSpec = {bin, cwd: root, runDir, promptFile, model: 'fixture', provider: null,
    effort: null, access: 'folder_only', skillsDir: join(runDir, 'skills'), maxTurns: 1, timeoutSeconds: 0, runHome: null};
  const adapter: Adapter = {
    info: {tool: 'codex', harness: 'codex', card: 'TLS-26', folderOnly: 'os-sandbox', mcpLevel: 'servers-off',
      skillsDir: '{runDir}/skills', promptVia: 'stdin', runHome: false},
    identity: async () => ({ok: true, version: 'fixture'}), supports: () => ({ok: true, reason: null}),
    build: input => ({argv: [input.bin], env: {}, envUnset: [], stdinFile: input.promptFile, files: [],
      projectFiles: [], spawnCwd: null, secretEnv: {}}),
    parse: () => ({ok: true, text: '', failureCode: null}),
  };
  const matrix = structuredClone(TOOL_MATRIX);
  Object.assign(matrix.tools.find(tool => tool.key === 'codex')!.run!, {offered: true, platforms: {darwin: {accepted: true}, linux: {accepted: true}}, folderOnly: 'os-sandbox'});
  const child = Object.assign(new EventEmitter(), {
    pid: 900_300, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  });
  const spawned = t.mock.method(childProcess, 'spawn', () => child);
  syncBuiltinESMExports();
  t.mock.timers.enable({apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000});
  let release!: () => void;
  const blocked = new Promise<void>(resolve => {release = resolve;});
  let tables = 0;
  const signals: {signal: NodeJS.Signals; at: number}[] = [];
  const inspector: ProcessInspector = {
    inspectSync: pid => pid === child.pid && child.exitCode === null && child.signalCode === null ?
      {pid, ppid: process.pid, pgid: pid, startedAt: 'owned-child-start'} : null,
    table: async () => {
      if (++tables === 2) {
        if (waitingOn === 'inspection') await blocked;
        else return [{pid: child.pid, ppid: 1, pgid: child.pid, startedAt: 'owned-child-start'}];
      }
      return [];
    },
    fencePids: async () => [],
    identity: async () => child.exitCode === null ? 'owned-child-start' : null,
    signalGroup: (pid, signal) => {assert.equal(pid, child.pid); signals.push({signal, at: Date.now()});},
  };
  let running: Awaited<ReturnType<typeof startTool>> | undefined;
  let stopping: Promise<void> | undefined;
  try {
    running = await startTool({adapter, spec, matrix, processes: inspector,
      onGroups: async groups => {if (waitingOn === 'persistence' && groups.some(group => group.members?.length)) await blocked;},
      claimedAt: Date.now(), expiresAt: Date.now() + 7_200_000, maxRunMinutes: 1});
    t.mock.timers.tick(250); await flush();
    assert.equal(tables, 2, 'the periodic snapshot is pending');
    for (let tick = 0; tick < 3; tick++) {t.mock.timers.tick(250); await flush();}
    assert.equal(tables, 2, 'periodic ticks coalesce while a snapshot is pending');
    const stoppedAt = Date.now();
    stopping = running.stop('runner_stopped');
    void stopping.catch(() => undefined);
    await flush();
    assert.deepEqual(signals, [{signal: 'SIGTERM', at: stoppedAt}], 'the owned child receives TERM before slow inspection finishes');
    // Storage may outlast the periodic inspection budget without releasing the
    // snapshot or allowing another scan to overwrite its pending save.
    for (let tick = 0; tick < (waitingOn === 'persistence' ? 7 : 3); tick++) {t.mock.timers.tick(250); await flush();}
    assert.equal(tables, 2, 'cleanup joins the existing scan without starting a competing inspection');
    assert.equal(signals.length, 1, 'the initial TERM is not repeated while cleanup joins inspection');
    release(); await flush();
    assert(tables > 2, 'cleanup inspects after the periodic scan finishes');
    assert.equal(signals.length, 1, 'a complete live scan does not repeat the prompt TERM');
  } finally {
    child.exitCode = 0;
    child.stdout.end(); child.stderr.end(); child.stdin.destroy();
    child.emit('exit', 0, null); child.emit('close', 0, null);
    release();
    await flush(); t.mock.timers.tick(250); await flush();
    try {await stopping; await running?.finished;}
    finally {spawned.mock.restore(); syncBuiltinESMExports();}
  }
});

const guardianHostPlatform = process.platform;
// Linux cleanup uses the journaled containment lifecycle, never these process-table witnesses.
for (const platform of ['darwin'] as ('linux' | 'darwin')[]) test(`Session guardian release cannot outlive the cleanup cap or report success while alive on ${platform}`,
  {skip: platform === 'linux' && guardianHostPlatform !== 'linux' && 'Native Linux startup inspection requires procfs'}, async t => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', {...descriptor, value: platform});
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-guardian-clock-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const runDir = join(root, 'run'); await mkdir(runDir);
  const promptFile = join(runDir, 'prompt.md'); await writeFile(promptFile, 'Fixture task.');
  const bin = await realpath(process.execPath);
  const spec: RunSpec = {bin, cwd: root, runDir, promptFile, model: 'fixture', provider: null,
    effort: null, access: 'folder_only', skillsDir: join(runDir, 'skills'), maxTurns: 1, timeoutSeconds: 0, runHome: null};
  const adapter: Adapter = {
    info: {tool: 'codex', harness: 'codex', card: 'TLS-26', folderOnly: 'os-sandbox', mcpLevel: 'servers-off',
      skillsDir: '{runDir}/skills', promptVia: 'stdin', runHome: false},
    identity: async () => ({ok: true, version: 'fixture'}), supports: () => ({ok: true, reason: null}),
    build: input => ({argv: [input.bin], env: {}, envUnset: [], stdinFile: input.promptFile, files: [], projectFiles: [], spawnCwd: null, secretEnv: {}}),
    parse: () => {assert.fail('A live guardian cannot produce a successful result.');},
  };
  const matrix = structuredClone(TOOL_MATRIX);
  Object.assign(matrix.tools.find(tool => tool.key === 'codex')!.run!, {offered: true, platforms: {darwin: {accepted: true}, linux: {accepted: true}}, folderOnly: 'os-sandbox'});
  const messages: unknown[] = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 900_500, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, connected: true,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    send: (message: unknown, callback?: () => void): boolean => {
      messages.push(message);
      // Inspect the test process itself rather than an arbitrary host PID. Its
      // real parent cannot be this synthetic guardian, so it is never owned.
      if (message === 'start') child.emit('message', {type: 'tool-start', pid: process.pid});
      callback?.(); return true;
    },
  });
  const spawned = t.mock.method(childProcess, 'spawn', (_file: string, argv?: readonly string[], options?: SpawnOptions) => {
    assert(argv?.includes('--input-type=module'), 'Both platforms launch the retained guardian.');
    assert.equal(options?.detached, true);
    assert.deepEqual(options?.stdio, ['pipe', 'pipe', 'pipe', 'ipc']);
    return child;
  }); syncBuiltinESMExports();
  t.after(() => {spawned.mock.restore(); syncBuiltinESMExports();});
  t.mock.timers.enable({apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000});
  const signals: NodeJS.Signals[] = [];
  const inspector: ProcessInspector = {
    sessionGuardian: true,
    table: async () => child.signalCode === null ? [{pid: child.pid, ppid: 1, pgid: child.pid,
      ...(platform === 'linux' ? {sid: String(child.pid)} : {}), startedAt: 'guardian-start'}] : [],
    identity: async () => child.signalCode === null ? 'guardian-start' : null,
    fencePids: async () => [],
    signalGroup: (pid, signal) => {
      assert.equal(pid, child.pid); signals.push(signal);
      if (signal === 'SIGKILL') {
        child.signalCode = signal; child.connected = false;
        child.stdin.destroy(); child.stdout.end(); child.stderr.end();
        child.emit('exit', null, signal); child.emit('close', null, signal);
      }
    },
  };
  t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
    assert.equal(pid, child.pid, 'the cleanup-cap fallback can target only the unreaped guardian PID');
    assert.equal(signal, 'SIGKILL');
    inspector.signalGroup!(pid, 'SIGKILL'); return true;
  });
  const snapshots: ProcessGroup[][] = [];
  const running = await startTool({adapter, spec, matrix, processes: inspector,
    onSpawn: (_pid, _startedAt, _pgid, toolRoot) => {assert.equal(toolRoot, undefined, 'An unrelated startup PID cannot become an owned tool root.');},
    onGroups: groups => {snapshots.push(structuredClone(groups));},
    claimedAt: Date.now(), expiresAt: Date.now() + 7_200_000, maxRunMinutes: 1});
  assert(messages.includes('start'), 'The guardian receives its startup handshake.');
  if (platform === 'darwin') assert(snapshots.flat().every(group => group.sid === undefined && group.sessionLeader === undefined),
    'Darwin keeps the live group witness without persisting unsupported numeric session evidence.');
  const began = Date.now();
  let outcome: unknown, finished = false;
  const stopped = running.stop('runner_stopped').then(() => {outcome = 'success';}, error => {outcome = error;});
  const result = running.finished.then(() => {assert.fail('Cleanup must fail closed.');}, error => {assert(error instanceof ProcessCleanupError); finished = true;});
  await flush();
  assert(messages.includes('release'), 'The helper asks the empty session guardian to exit.');
  assert.equal(signals.length, 0, 'The retained guardian alone does not start a TERM grace period.');
  assert.equal(outcome, undefined, 'Sending release is not evidence of exit.');
  while (outcome === undefined && Date.now() - began < cap) {t.mock.timers.tick(25); await flush();}
  assert((outcome as unknown) instanceof ProcessCleanupError);
  assert.equal(Date.now() - began, cap);
  assert(signals.includes('SIGKILL'), 'The exact unreaped guardian is killed at the original cap.');
  await stopped; await result; assert.equal(finished, true);
});
