import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {registerContainmentSignalEndpoint, revokeContainmentSignalEndpoint, signalIfStillOwned, type ContainmentSignalEndpoint} from '../src/runner/signal-gate.js';

function linux(t: TestContext): void {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', {...descriptor, value: 'linux'});
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
}

test('S3 Linux accepts only guardian self-group TERM and a registered retained containment endpoint', async t => {
  linux(t);
  const sent: (number | NodeJS.Signals | undefined)[][] = [];
  t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {sent.push([pid, signal as NodeJS.Signals]); return true;});
  let reads = 0;
  for (const kind of ['pid', 'group', 'probe'] as const) for (const signal of [0, 'SIGTERM', 'SIGKILL'] as const) {
    assert.equal((await signalIfStillOwned({kind, pid: 950100}, signal, {startedAt: 'matching',
      child: {pid: 950100, exitCode: null, signalCode: null}, allowChildPidFallback: true,
      read: () => {reads++; return {pid: 950100, pgid: 950100, startedAt: 'matching'};},
    })).status, 'unproven');
  }
  assert.equal(reads, 0); assert.deepEqual(sent, []);
  assert.equal((await signalIfStillOwned({kind: 'self-group', pid: process.pid}, 'SIGKILL',
    {read: () => ({pid: process.pid, pgid: process.pid})})).status, 'unproven');
  assert.equal((await signalIfStillOwned({kind: 'self-group', pid: process.pid}, 'SIGTERM',
    {read: () => ({pid: process.pid, pgid: process.pid + 1})})).status, 'unproven');
  assert.equal((await signalIfStillOwned({kind: 'self-group', pid: process.pid}, 'SIGTERM',
    {read: () => ({pid: process.pid, pgid: process.pid})})).status, 'sent');
  assert.deepEqual(sent, [[0, 'SIGTERM']], 'the guardian addresses its invariant current group through kill(0)');

  const directory = await mkdtemp(join(tmpdir(), 'mdai-cgroup-endpoint-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const path = join(directory, 'cgroup.kill');
  const fd = fs.openSync(path, 'wx', 0o600);
  t.after(() => fs.closeSync(fd));
  const endpoint = registerContainmentSignalEndpoint(fd, () => true);
  assert.equal((await signalIfStillOwned({kind: 'containment', endpoint}, 'SIGTERM')).status, 'unproven');
  assert.deepEqual(await signalIfStillOwned({kind: 'containment', endpoint}, 'SIGKILL'), {status: 'sent', cleanupPending: true});
  assert.equal(await readFile(path, 'utf8'), '1\n', 'only the registered retained FD receives the kernel command');
  assert.equal((await signalIfStillOwned({kind: 'containment', endpoint: {} as ContainmentSignalEndpoint}, 'SIGKILL')).status, 'unproven');
});

test('S3 containment generation loss, explicit revocation and deadline permanently refuse stale handles', async t => {
  linux(t);
  const fd = fs.openSync('/dev/null', 'w'); t.after(() => fs.closeSync(fd));
  let current = false, checks = 0;
  const endpoint = registerContainmentSignalEndpoint(fd, () => {checks++; return current;});
  assert.equal((await signalIfStillOwned({kind: 'containment', endpoint}, 'SIGKILL')).status, 'unproven');
  current = true;
  assert.equal((await signalIfStillOwned({kind: 'containment', endpoint}, 'SIGKILL')).status, 'unproven');
  assert.equal(checks, 1, 'a revoked generation never revives if an FD or epoch number is reused');
  const other = registerContainmentSignalEndpoint(fd, () => true);
  revokeContainmentSignalEndpoint(other);
  assert.equal((await signalIfStillOwned({kind: 'containment', endpoint: other}, 'SIGKILL')).status, 'unproven');
  const expired = registerContainmentSignalEndpoint(fd, () => assert.fail('expired operations never inspect authority'));
  assert.equal((await signalIfStillOwned({kind: 'containment', endpoint: expired}, 'SIGKILL', {deadline: Date.now()})).status, 'unproven');
  t.mock.timers.enable({apis: ['Date'], now: 1_000_000});
  const delayed = registerContainmentSignalEndpoint(fd, () => {t.mock.timers.tick(100); return true;});
  assert.equal((await signalIfStillOwned({kind: 'containment', endpoint: delayed}, 'SIGKILL', {deadline: Date.now() + 50})).status, 'unproven',
    'the synchronous final validity check cannot extend the signal deadline');
});

test('S3 denied retained-endpoint writes propagate failure and never fall back to a numeric signal', async t => {
  linux(t);
  const fd = fs.openSync('/dev/null', 'w'); t.after(() => fs.closeSync(fd));
  const endpoint = registerContainmentSignalEndpoint(fd, () => true);
  const denied = Object.assign(new Error('fixture endpoint denied'), {code: 'EACCES'});
  t.mock.method(fs, 'writeSync', () => {throw denied;}); syncBuiltinESMExports();
  t.after(syncBuiltinESMExports);
  t.mock.method(process, 'kill', () => assert.fail('a denied cgroup endpoint never creates numeric fallback authority'));
  await assert.rejects(signalIfStillOwned({kind: 'containment', endpoint}, 'SIGKILL'), error => error === denied);
});
