import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {promisify} from 'node:util';
import test, {type TestContext} from 'node:test';
import type {ProcessGroup} from '../src/runner/process.js';

const fence = 'a'.repeat(32);
const child = 900_200;
const startedAt = 'Mon Oct 26 00:00:00 2026';
const cap = 20_000;
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const tableRow = (identity = startedAt, padding = '') => `  ${child}  1  ${child}  ${identity}${padding}\n`;
const fenceRow = () => `  ${child}  ${process.getuid!()}  /mock/tool MDAI_RUN_FENCE=${fence}\n`;

async function darwinBackend(t: TestContext, tag: string, stdout: (args: string[]) => string,
  onSignal?: () => void) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const originalExecFile = childProcess.execFile;
  const originalExecFileSync = childProcess.execFileSync;
  Object.defineProperty(process, 'platform', {...descriptor, value: 'darwin'});
  const signals: {pid: number; signal?: NodeJS.Signals | number}[] = [];
  const kill = t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
    signals.push({pid, signal}); onSignal?.(); return true;
  });
  const ps = async (file: string, args: string[], options: {env: Record<string, string>}) => {
    assert.equal(file, '/bin/ps');
    assert.deepEqual(options.env, {TZ: 'UTC0', LC_ALL: 'C', LC_TIME: 'C'});
    if (args[0] === '-p') assert.deepEqual(args, ['-p', args[1], '-o', 'lstart=']);
    else if (args[0] === '-axo') assert.deepEqual(args, ['-axo', 'pid=,ppid=,pgid=,lstart=']);
    else assert.deepEqual(args, ['-A', '-E', '-ww', '-o', 'pid=,uid=,command=']);
    return {stdout: stdout(args), stderr: ''};
  };
  childProcess.execFile = Object.assign(() => assert.fail('ps must use the promisified mock'),
    {[promisify.custom]: ps}) as unknown as typeof childProcess.execFile;
  childProcess.execFileSync = ((file: string, args: string[], options: {env: Record<string, string>}) => {
    assert.equal(file, '/bin/ps');
    assert.deepEqual(options.env, {TZ: 'UTC0', LC_ALL: 'C', LC_TIME: 'C'});
    assert.deepEqual(args, ['-p', args[1], '-o', 'pid=,ppid=,pgid=,lstart=']);
    try {
      const identity = stdout(['-p', args[1], '-o', 'lstart=']);
      const rows = stdout(['-axo', 'pid=,ppid=,pgid=,lstart=']);
      const row = rows.split('\n').find(line => Number(/^\s*(\d+)\s/u.exec(line)?.[1]) === Number(args[1]));
      const columns = row && /^\s*(\d+)\s+(\d+)\s+(\d+)\s/u.exec(row);
      if (!columns) throw new Error('Process snapshot is unavailable.');
      return `  ${columns[1]}  ${columns[2]}  ${columns[3]}  ${identity}`;
    } catch (error) {
      // execFileSync reports an exit status while the async fixture uses code.
      const failure = error as {code?: number; status?: number};
      if (typeof failure.code === 'number') failure.status = failure.code;
      throw error;
    }
  }) as typeof childProcess.execFileSync;
  syncBuiltinESMExports();
  t.after(() => {
    kill.mock.restore();
    childProcess.execFile = originalExecFile;
    childProcess.execFileSync = originalExecFileSync;
    Object.defineProperty(process, 'platform', descriptor);
    syncBuiltinESMExports();
  });
  const backend = await import(new URL(`../src/runner/process.js?darwin-parser-${tag}`, import.meta.url).href);
  return {backend, signals};
}

async function settle(t: TestContext, work: () => Promise<boolean>) {
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
  const began = Date.now();
  let result: {value?: boolean; error?: unknown; elapsed: number} | undefined;
  void work().then(value => {result = {value, elapsed: Date.now() - began};}, error => {result = {error, elapsed: Date.now() - began};});
  await flush();
  while (!result && Date.now() - began < cap) {
    t.mock.timers.tick(25);
    await flush();
  }
  assert(result, 'recovery must settle within its cleanup cap');
  return result;
}

const invalidIdentities = [
  ['empty-success', ''],
  ['whitespace-success', ' \t\n  '],
  ['placeholder', 'unavailable'],
  ['diagnostic', 'ps: process unavailable'],
  ['calendar-overflow', 'Mon Feb 30 00:00:00 2026'],
  ['non-leap-day', 'Sat Feb 29 00:00:00 2025'],
  ['weekday-mismatch', 'Tue Oct 26 00:00:00 2026'],
  ['invalid-hour', 'Mon Oct 26 24:00:00 2026'],
  ['invalid-second', 'Mon Oct 26 00:00:60 2026'],
  ['unpadded-day', 'Mon Oct 5 00:00:00 2026'],
  ['zero-padded-day', 'Mon Oct 05 00:00:00 2026'],
  ['british-locale', 'Mon 26 Oct 18:52:38 2026'],
  ['german-locale', 'Mo. 26 Okt. 18:52:38 2026'],
  ['romanian-locale', 'Lun 26 oct. 2026 18:52:24'],
  ['extra-field', `${startedAt} UTC`],
  ['multiple-lines', `${startedAt}\n${startedAt}`],
] as const;

for (const [tag, identity] of invalidIdentities) {
  test(`Darwin lstart parser rejects ${tag} as identity and keeps recovery evidence`, async t => {
    let identityReads = 0;
    const {backend, signals} = await darwinBackend(t, tag, args => {
      if (args[0] === '-p') {identityReads++; return identity;}
      if (args[0] === '-axo') return tableRow();
      return fenceRow();
    });
    assert.equal(await backend.processStartIdentity(child), null);
    const saved: ProcessGroup[] = [{pgid: child, startedAt, members: [{pid: child, startedAt}]}];
    let ledger = structuredClone(saved);
    const result = await settle(t, () => backend.recoverProcess(child, startedAt, undefined, fence, saved,
      (groups: ProcessGroup[]) => {ledger = structuredClone(groups);}));
    assert.equal((result.error as {code?: string} | undefined)?.code, 'tool_failed');
    assert.equal(result.elapsed, cap, 'malformed live identity cannot prove disappearance');
    assert(identityReads > 2, 'failed inspection must be retried');
    assert.deepEqual(ledger, saved, 'the saved ownership evidence must remain available for recovery');
    assert.deepEqual(signals, [], 'invalid process identity cannot authorize a signal');
  });
}

const malformedTables = [
  ['missing-lstart', `  ${child} 1 ${child}\n`],
  ['missing-numeric-column', `  ${child} ${child} ${startedAt}\n`],
  ['invalid-lstart', tableRow('unavailable')],
  ['invalid-calendar', tableRow('Mon Feb 30 00:00:00 2026')],
  ['unsafe-pid', `  9007199254740992 1 ${child} ${startedAt}\n`],
  ['unsafe-ppid', `  ${child} 9007199254740992 ${child} ${startedAt}\n`],
  ['unsafe-pgid', `  ${child} 1 9007199254740992 ${startedAt}\n`],
  ['unparseable-row', 'unavailable\n'],
] as const;

const malformedFences = [
  ['missing-uid', `  ${child} /mock/tool MDAI_RUN_FENCE=${fence}\n`],
  ['missing-command', `  ${child} ${process.getuid!()}\n`],
  ['blank-command', `  ${child} ${process.getuid!()}   \n`],
  ['unsafe-pid', `  9007199254740992 ${process.getuid!()} /mock/tool\n`],
  ['unsafe-uid', `  ${child} 9007199254740992 /mock/tool\n`],
  ['unparseable-row', 'unavailable\n'],
] as const;

for (const inspection of ['table', 'fence'] as const) {
  for (const [tag, malformed] of inspection === 'table' ? malformedTables : malformedFences) {
    test(`Darwin ${inspection} parser keeps ${tag} pending and retains the saved ledger`, async t => {
      let attempts = 0;
      const {backend, signals} = await darwinBackend(t, `${inspection}-${tag}`, args => {
        if (args[0] === '-p') return `${startedAt}\n`;
        if (args[0] === '-axo') {
          if (inspection === 'table') {attempts++; return `\n${tableRow()}  \n${malformed}`;}
          return '';
        }
        if (inspection === 'fence') {attempts++; return `\n${fenceRow()}  \n${malformed}`;}
        return '';
      });
      const saved: ProcessGroup[] = [{pgid: child, startedAt, members: [{pid: child, startedAt}]}];
      let ledger = structuredClone(saved);
      const result = await settle(t, () => backend.recoverProcess(0, '', undefined, fence, saved,
        (groups: ProcessGroup[]) => {ledger = structuredClone(groups);}));
      assert.equal((result.error as {code?: string} | undefined)?.code, 'tool_failed');
      assert.equal(result.elapsed, cap, 'a malformed row cannot prove the saved process absent');
      assert(attempts > 1, 'failed parsing requires a new complete inspection');
      assert.deepEqual(ledger, saved, 'failed parsing must not prune saved ownership evidence');
      assert.deepEqual(signals, [], 'no partial inspection may authorize a signal');
    });
  }
}

test('Darwin accepts UTC C-locale lstart with exact three/four trailing spaces and %e single-digit days', async t => {
  let identity = startedAt;
  let padding = '   ';
  const {backend, signals} = await darwinBackend(t, 'valid-dates', args => args[0] === '-p' ? `${identity}${padding}\n` : '');
  for (padding of ['   ', '    ']) {
    for (identity of [startedAt, 'Mon Oct  5 18:52:24 2026', 'Thu Jan  1 00:00:00 2026', 'Thu Feb 29 23:59:59 2024']) {
      assert.equal(await backend.processStartIdentity(child), identity);
    }
  }
  await backend.requireProcessInspection();
  assert.deepEqual(signals, []);
});

const identityFailures = [
  ['nonempty-stderr', {code: 1, stdout: '', stderr: 'ps: operation not permitted'}],
  ['nonempty-stdout', {code: 1, stdout: 'ps: process unavailable', stderr: ''}],
  ['different-exit-status', {code: 2, stdout: '', stderr: ''}],
  ['timeout', {code: 'ETIMEDOUT', stdout: '', stderr: ''}],
  ['missing-executable', {code: 'ENOENT', stdout: '', stderr: ''}],
  ['missing-output-fields', {code: 1}],
] as const;

for (const [tag, failure] of identityFailures) {
  test(`Darwin treats ${tag} ps failure as failed inspection, never a missing PID`, async t => {
    let identityReads = 0;
    const {backend, signals} = await darwinBackend(t, `identity-error-${tag}`, args => {
      if (args[0] === '-p') {
        identityReads++;
        throw Object.assign(new Error('Process inspection failed.'), failure);
      }
      return tableRow();
    });
    assert.equal(await backend.processStartIdentity(child), null);
    const saved: ProcessGroup[] = [{pgid: child, startedAt, members: [{pid: child, startedAt}]}];
    let ledger = structuredClone(saved);
    const result = await settle(t, () => backend.recoverProcess(child, startedAt, undefined, undefined, saved,
      (groups: ProcessGroup[]) => {ledger = structuredClone(groups);}));
    assert.equal((result.error as {code?: string} | undefined)?.code, 'tool_failed');
    assert.equal(result.elapsed, cap, 'an inspection failure must not prove the PID absent');
    assert(identityReads > 2, 'identity command failures must be retried');
    assert.deepEqual(ledger, saved, 'failed identity inspection retains the saved lifetime');
    assert.deepEqual(signals, []);
  });
}

test('Darwin accepts only the explicit missing-PID ps status as an absent identity', async t => {
  const {backend, signals} = await darwinBackend(t, 'missing-pid', args => {
    if (args[0] === '-p') throw Object.assign(new Error('No process found.'), {code: 1, stdout: '', stderr: ''});
    return '';
  });
  assert.equal(await backend.processStartIdentity(child), null);
  const result = await settle(t, () => backend.recoverProcess(child, startedAt));
  assert.equal(result.error, undefined);
  assert.equal(result.value, false);
  assert.deepEqual(signals, []);
});

for (const width of [3, 4]) {
  test(`Darwin parses complete %e table/identity rows with ${width} trailing spaces before signalling`, async t => {
    let alive = true;
    const identity = 'Thu Jan  1 00:00:00 2026';
    const padding = ' '.repeat(width);
    const {backend, signals} = await darwinBackend(t, `valid-recovery-${width}`, args => {
      if (!alive) {
        if (args[0] === '-p') throw Object.assign(new Error('No process found.'), {code: 1, stdout: '', stderr: ''});
        return '\n  \n';
      }
      if (args[0] === '-p') return `${identity}${padding}\n`;
      if (args[0] === '-axo') return `\n${tableRow(identity, padding)}  \n`;
      return `\n${fenceRow()}  \n`;
    }, () => {alive = false;});
    const result = await settle(t, () => backend.recoverProcess(0, '', undefined, fence));
    assert.equal(result.error, undefined);
    assert.equal(result.value, true);
    assert.deepEqual(signals, [{pid: child, signal: 'SIGTERM'}]);
  });
}

for (const variant of ['same second', 'later second'] as const) {
  test(`Darwin backend handles ${variant} lstart at the unresolved spawn cutoff`, async t => {
    const spawnedBy = Date.parse('2026-10-26T18:52:24.999Z');
    const identity = variant === 'same second' ? 'Mon Oct 26 18:52:24 2026' : 'Mon Oct 26 18:52:25 2026';
    let tableReads = 0;
    const {backend, signals} = await darwinBackend(t, `spawn-cutoff-${variant}`, args => {
      if (args[0] === '-p') return `${identity}    \n`;
      if (args[0] === '-axo') {tableReads++; return tableRow(identity, '   ');}
      return '';
    });
    const saved: ProcessGroup[] = [{pgid: child, startedAt: '', spawnedBy}];
    let ledger = structuredClone(saved);
    const result = await settle(t, () => backend.recoverProcess(0, '', undefined, fence, saved,
      (groups: ProcessGroup[]) => {ledger = structuredClone(groups);}));
    if (variant === 'same second') {
      assert.equal((result.error as {code?: string} | undefined)?.code, 'tool_failed');
      assert.equal(result.elapsed, cap, 'one-second lstart resolution cannot distinguish same-second reuse');
      assert(tableReads > 2, 'the unresolved group requires complete inspection retries');
      assert.deepEqual(ledger, saved, 'ambiguous same-second reuse retains the cleanup evidence');
    } else {
      assert.equal(result.error, undefined);
      assert.equal(result.value, true);
      assert.equal(result.elapsed, 0, 'the next lstart second proves reuse without waiting for the cap');
      assert(tableReads >= 2, 'reuse is established from complete backend table inspections');
    }
    assert.deepEqual(signals, [], 'an unresolved numeric PGID never authorizes signalling');
  });
}
