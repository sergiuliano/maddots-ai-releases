import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, realpath, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {PassThrough} from 'node:stream';
import test from 'node:test';
import {executeAdapterProbe, type Adapter} from '../src/runner/adapter.js';
import {RunnerJournal, type JournalToken} from '../src/runner/journal.js';
import {createLinuxToolLifecycle, runLinuxToolCommand, withLinuxOwnerContext} from '../src/runner/linux-lifecycle.js';
import {LinuxWorkspace} from '../src/runner/linux-workspace.js';
import {PROCESS_CLEANUP_CAP_MS, ProcessCleanupError, startTool} from '../src/runner/process.js';
import {TOOL_MATRIX} from '../src/shared/tool-matrix.js';
import type {ToolCommandOptions} from '../src/tool-command.js';
import {deferred, flush, linuxLifecycleFixture as fixture} from './support/linux-lifecycle-fixture.js';

// Arbitrary-output fixtures model a future accepted tool. Signed candidate
// admission is covered separately by the source-only acceptance suite.
const acceptedMatrix = structuredClone(TOOL_MATRIX);
acceptedMatrix.tools.find(tool => tool.key === 'codex')!.run!.platforms = {linux: {accepted: true}};
const acceptedUtility = (options: ToolCommandOptions = {}) =>
  runLinuxToolCommand('/usr/bin/true', [], {...options, tool: 'codex', matrix: acceptedMatrix});

test('S5 closed Linux identity probe tolerates healthy preparation beyond ten seconds', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  f.ready.resolve();
  f.holdSpawn(async () => {entered.resolve(); await release.promise;});
  f.onKill(() => {(f.child.stdout as PassThrough).end(); (f.child.stderr as PassThrough).end();});
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: Date.now()});
  let settled = false;
  const command = withLinuxOwnerContext(f.owner, f.generation, () =>
    executeAdapterProbe(runLinuxToolCommand, 'codex.version', '/usr/bin/true', undefined, {matrix: acceptedMatrix}))
    .finally(() => {settled = true;});
  void command.catch(() => {});
  try {
    await entered.promise;
    t.mock.timers.tick(12_000); await flush();
    assert.equal(settled, false, 'healthy preparation must have room beyond the old ten-second probe budget');
    assert.equal(f.starts, 0);
    release.resolve();
    while (!f.starts && !settled) await flush();
    assert.equal(f.starts, 1);
    (f.child.stdout as PassThrough).write('identity\n');
    f.child.emit('message', {type: 'tool-exit', code: 0, signal: null});
    assert.deepEqual(await command, {stdout: 'identity\n', stderr: ''});
    assert.equal(f.owner.busy, false);
    assert.equal((await f.stages()).at(-1), 'CLEAN');
  } finally {release.resolve(); await command.catch(() => {});}
});

test('S5 Linux probe allowance preserves an earlier deadline and retires late failed preparation', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  f.ready.resolve();
  f.holdSpawn(async () => {entered.resolve(); await release.promise;});
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: Date.now()});
  const command = withLinuxOwnerContext(f.owner, f.generation, () =>
    executeAdapterProbe(runLinuxToolCommand, 'codex.version', '/usr/bin/true', {deadline: Date.now() + 4000}, {matrix: acceptedMatrix}));
  const rejected = assert.rejects(command, ProcessCleanupError);
  try {
    await entered.promise;
    t.mock.timers.tick(4001); await rejected;
    assert.equal(f.owner.busy, true);
    assert.equal(f.starts, 0);
    release.resolve(); await flush(); await flush();
    assert.equal(f.admitted, false, 'late physical preparation cannot consume an expired launcher permission');
    assert.equal(f.starts, 0);
    await f.preparationSettled.promise;
    assert.equal(f.owner.busy, false);
    assert.deepEqual(await f.stages(), ['EPOCH', 'INTENT', 'CONTAINMENT_BOUND', 'LAUNCH_ALLOWED', 'STOPPING', 'CLEAN']);
  } finally {release.resolve(); await command.catch(() => {});}
});

test('S5 Linux probe execution shares the original thirty-second preparation budget', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  f.ready.resolve();
  f.holdSpawn(async () => {entered.resolve(); await release.promise;});
  f.onKill(() => {(f.child.stdout as PassThrough).end(); (f.child.stderr as PassThrough).end();});
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: Date.now()});
  let settled = false;
  const command = withLinuxOwnerContext(f.owner, f.generation, () =>
    executeAdapterProbe(runLinuxToolCommand, 'codex.version', '/usr/bin/true', undefined, {matrix: acceptedMatrix}))
    .finally(() => {settled = true;});
  const rejected = assert.rejects(command, {code: 'COMMAND_FAILED'});
  try {
    await entered.promise;
    t.mock.timers.tick(12_000); release.resolve();
    while (!f.starts && !settled) await flush();
    assert.equal(f.starts, 1);
    t.mock.timers.tick(17_999); await flush();
    assert.equal(settled, false);
    t.mock.timers.tick(1); await rejected;
    assert.equal(f.owner.busy, false, 'the timed-out command still needs verified cleanup before retirement');
    assert(f.actions.includes('kill'));
    assert.equal((await f.stages()).at(-1), 'CLEAN');
  } finally {release.resolve(); await command.catch(() => {});}
});

test('S3 owner binds readiness and durable launch permission before exactly one start, then CLEAN before retirement', async t => {
  const f = await fixture(t), run = await f.prepare();
  assert.equal(f.owner.busy, true);
  assert.equal(f.starts, 0);
  f.ready.resolve(); await run.ready;
  await f.lifecycle.launch(run);
  assert.deepEqual(await f.stages(), ['EPOCH', 'INTENT', 'CONTAINMENT_BOUND', 'LAUNCH_ALLOWED']);
  assert.equal(f.starts, 1);
  await assert.rejects(f.lifecycle.launch(run));
  await f.lifecycle.cleanup(run, Date.now() + 20_000);
  assert.deepEqual(await f.stages(), ['EPOCH', 'INTENT', 'CONTAINMENT_BOUND', 'LAUNCH_ALLOWED', 'STOPPING', 'CLEAN']);
  assert(f.actions.indexOf('term') < f.actions.indexOf('kill'));
  assert(f.actions.indexOf('kill') < f.actions.indexOf('retire'));
  assert.equal(f.owner.busy, false);
  assert.equal(f.owner.isRunRetired(f.runId), true);
});

test('S3 unsupported workload environment refuses before durable INTENT or containment reservation', async t => {
  const f = await fixture(t);
  let unexpected: Awaited<ReturnType<typeof f.prepare>> | undefined;
  try {
    await assert.rejects(f.lifecycle.prepare({argv: ['/usr/bin/true'], cwd: '/work',
      env: {HTTP_PROXY: 'http://unapproved.invalid'}, deadline: Date.now() + 60_000}).then(run => {unexpected = run; return run;}),
    {code: 'LINUX_CONTAINMENT_UNAVAILABLE'});
    assert.deepEqual(await f.stages(), ['EPOCH']);
    assert.equal(f.request, undefined, 'the backend must not reserve an object for rejected environment input');
    assert.equal(f.owner.busy, false);
    assert.equal(f.starts, 0);
  } finally {if (unexpected) await f.lifecycle.cleanup(unexpected, Date.now() + 20_000);}
});

test('S3 cancelled paused guardian is sealed, killed and durably retired without any start', async t => {
  const f = await fixture(t), run = await f.prepare();
  await f.lifecycle.cleanup(run, Date.now() + 20_000);
  f.ready.resolve(); await run.ready;
  await assert.rejects(f.lifecycle.launch(run));
  assert.equal(f.starts, 0);
  assert.equal(f.owner.isRunRetired(f.runId), true);
});

test('S3 preparation timeout revokes launcher permission and retires late failed preparation', async t => {
  const f = await fixture(t), entered = deferred(), resume = deferred();
  f.holdSpawn(async () => {entered.resolve(); await resume.promise;});
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: Date.now()});
  const preparing = f.prepare();
  const refused = assert.rejects(preparing);
  await entered.promise;
  t.mock.timers.tick(20_001); await refused;
  assert.equal(f.owner.busy, true);
  assert.equal(f.admitted, false);
  resume.resolve(); await flush(); await flush();
  assert.equal(f.admitted, false, 'late physical preparation cannot execute even trusted bootstrap');
  assert.equal(f.starts, 0);
  await f.preparationSettled.promise;
  assert.equal(f.owner.busy, false);
  assert.deepEqual(await f.stages(), ['EPOCH', 'INTENT', 'CONTAINMENT_BOUND', 'LAUNCH_ALLOWED', 'STOPPING', 'CLEAN']);
});

test('S3 guardian TERM grace is bounded, then the original containment obligation kills unobserved descendants', async t => {
  const f = await fixture(t), run = await f.prepare();
  f.ready.resolve(); await run.ready; await f.lifecycle.launch(run); f.resistTerm();
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: Date.now()});
  const cleaning = f.lifecycle.cleanup(run, Date.now() + 20_000);
  await f.term.promise; await flush();
  assert.equal(f.actions.includes('kill'), false);
  t.mock.timers.tick(5001); await cleaning;
  assert.equal(f.actions.includes('kill'), true);
  assert.equal(f.owner.isRunRetired(f.runId), true);
});

test('S3 denied retained kill leaves the original journal obligation busy and never invokes numeric signals', async t => {
  const f = await fixture(t), run = await f.prepare();
  f.ready.resolve(); await run.ready; await f.lifecycle.launch(run); f.denyKill();
  t.mock.method(process, 'kill', () => {throw new Error('numeric signal sink reached');});
  await assert.rejects(f.lifecycle.cleanup(run, Date.now() + 20_000));
  assert.equal(f.owner.busy, true);
  assert.equal(f.owner.isRunRetired(f.runId), false);
  assert.equal(f.actions.includes('retire'), false);
});

test('S3 journal failure cannot disable an already registered run endpoint', async t => {
  const f = await fixture(t), run = await f.prepare();
  f.ready.resolve(); await run.ready; await f.lifecycle.launch(run);
  t.mock.method(f.owner, 'journalOperation', async () => {throw new Error('EIO physical journal failure');});
  await assert.rejects(f.lifecycle.cleanup(run, Date.now() + 20_000));
  assert.equal(f.actions.includes('kill'), true, 'the existing endpoint remains usable despite failed STOPPING');
  assert.equal(f.owner.busy, true);
  assert.equal(f.owner.isRunRetired(f.runId), false);
});

test('S3 readiness must precede durable binding even when a caller requests launch early', async t => {
  const f = await fixture(t), run = await f.prepare();
  const launching = f.lifecycle.launch(run);
  await flush();
  assert.deepEqual(await f.stages(), ['EPOCH', 'INTENT']);
  assert.equal(f.starts, 0);
  f.ready.resolve(); await launching;
  assert.equal(f.starts, 1);
  await f.lifecycle.cleanup(run, Date.now() + 20_000);
});

test('S3 failed events observation still attempts the retained kill and retains the unresolved obligation', async t => {
  const f = await fixture(t), run = await f.prepare();
  f.ready.resolve(); await f.lifecycle.launch(run); f.unreadableEvents();
  await assert.rejects(f.lifecycle.cleanup(run, Date.now() + 20_000));
  assert.equal(f.actions.includes('kill'), true);
  assert.equal(f.owner.busy, true);
  assert.equal(f.owner.isRunRetired(f.runId), false);
});

test('S3 utility output includes bytes drained after tool exit and before cleanup closes the pipes', async t => {
  const f = await fixture(t);
  f.ready.resolve();
  f.onKill(() => {(f.child.stdout as PassThrough).end('tail'); (f.child.stderr as PassThrough).end('last warning');});
  const command = withLinuxOwnerContext(f.owner, f.generation, () => acceptedUtility());
  while (!f.starts) await flush();
  (f.child.stdout as PassThrough).write('head');
  f.child.emit('message', {type: 'tool-exit', code: 0, signal: null});
  assert.deepEqual(await command, {stdout: 'headtail', stderr: 'last warning'});
  assert.equal(f.owner.busy, false);
});

test('S3 utility caller deadline survives denied KILL and held physical workspace closure', async t => {
  const f = await fixture(t), closing = deferred(), releaseClose = deferred(), physicallyClosed = deferred();
  const close = LinuxWorkspace.prototype.close;
  t.mock.method(LinuxWorkspace.prototype, 'close', async function (this: LinuxWorkspace) {
    closing.resolve(); await releaseClose.promise; await close.call(this); physicallyClosed.resolve();
  });
  f.ready.resolve(); f.denyKill();
  const numeric = t.mock.method(process, 'kill', () => {throw new Error('numeric signal sink reached');});
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: Date.now()});
  let settled = false, refusal: unknown;
  const command = withLinuxOwnerContext(f.owner, f.generation, () => acceptedUtility({timeout: 10_000}))
    .then(() => {settled = true;}, error => {settled = true; refusal = error;});
  try {
    while (!f.starts) await flush();
    f.child.emit('message', {type: 'tool-exit', code: 0, signal: null});
    await closing.promise;
    await f.owner.operation(f.generation, async () => {});
    t.mock.timers.tick(PROCESS_CLEANUP_CAP_MS - 1); await flush();
    assert.equal(settled, false, 'the cleanup wait remains live before its cap');
    t.mock.timers.tick(1); await flush();
    assert.equal(settled, true, 'the utility caller must settle at its cleanup deadline even while close is held');
    assert(refusal instanceof ProcessCleanupError);
    assert.equal(f.owner.busy, true);
    assert.equal(f.owner.isRunRetired(f.runId), false);
    assert.equal(f.actions.includes('kill'), true);
    assert.equal(f.actions.includes('retire'), false);
    assert.equal(numeric.mock.callCount(), 0);
    let closed = false; void physicallyClosed.promise.then(() => {closed = true;});
    await flush(); assert.equal(closed, false, 'bounded waiting must not fake physical descriptor closure');
    releaseClose.resolve(); await physicallyClosed.promise; await flush();
    assert.equal(f.owner.busy, true, 'late close cannot discharge the unresolved journal obligation');
  } finally {releaseClose.resolve(); await command;}
});

test('S3 utility output limit begins contained cleanup without waiting for the tool deadline', async t => {
  const f = await fixture(t);
  f.ready.resolve();
  f.onKill(() => {(f.child.stdout as PassThrough).end(); (f.child.stderr as PassThrough).end();});
  const command = withLinuxOwnerContext(f.owner, f.generation, () => acceptedUtility({maxBuffer: 2}));
  const rejected = assert.rejects(command, {code: 'COMMAND_FAILED'});
  while (!f.starts) await flush();
  (f.child.stdout as PassThrough).write('overflow');
  await rejected;
  assert.equal(f.actions.includes('kill'), true);
  assert.equal(f.owner.busy, false);
});

test('S3 utility output limit remains enforced on buffered bytes drained after a successful tool exit', async t => {
  const f = await fixture(t);
  f.ready.resolve();
  f.onKill(() => {(f.child.stdout as PassThrough).end('overflow'); (f.child.stderr as PassThrough).end();});
  const command = withLinuxOwnerContext(f.owner, f.generation, () => acceptedUtility({maxBuffer: 2}));
  const rejected = assert.rejects(command, {code: 'COMMAND_FAILED'});
  while (!f.starts) await flush();
  f.child.emit('message', {type: 'tool-exit', code: 0, signal: null});
  await rejected;
  assert.equal(f.owner.busy, false);
});

for (const revoked of ['stop', 'deadline'] as const) {
  test(`S3 ${revoked} during durable ALLOW cannot release a late START`, async t => {
    const f = await fixture(t), run = await f.prepare(), held = deferred(), reached = deferred();
    f.ready.resolve();
    const allow = RunnerJournal.prototype.allow;
    t.mock.method(RunnerJournal.prototype, 'allow', async function (this: RunnerJournal, token: JournalToken) {
      const value = await allow.call(this, token); reached.resolve(); await held.promise; return value;
    });
    let stopped = false;
    const launching = f.lifecycle.launch(run, () => {if (stopped) throw new Error('stopped while ALLOW was pending');});
    const refused = assert.rejects(launching);
    await reached.promise;
    if (revoked === 'stop') stopped = true;
    else {
      t.mock.timers.enable({apis: ['Date'], now: Date.now()});
      t.mock.timers.tick(60_001);
    }
    held.resolve(); await refused;
    assert.equal(f.starts, 0);
    assert.equal(f.owner.busy, true);
    await f.lifecycle.cleanup(run, Date.now() + 20_000);
    assert.equal(f.owner.isRunRetired(f.runId), true);
    assert.equal(f.starts, 0);
  });
}

for (const failure of ['timeout', 'cancel', 'native-refusal'] as const) {
  test(`S4 utility ${failure} before native admission sends no stdin, including after late acknowledgment`, async t => {
    const f = await fixture(t), abort = new AbortController(); f.ready.resolve(); f.holdAcknowledgment();
    f.onKill(() => {(f.child.stdout as PassThrough).end(); (f.child.stderr as PassThrough).end();});
    t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: Date.now()});
    const command = withLinuxOwnerContext(f.owner, f.generation, () => acceptedUtility({timeout: 1000, input: 'forbidden', signal: abort.signal}));
    const rejected = assert.rejects(command);
    while (!f.sends) await flush();
    assert.equal(f.child.stdin.writableEnded, false);
    if (failure === 'timeout') t.mock.timers.tick(1001);
    else if (failure === 'cancel') abort.abort();
    else f.child.emit('message', {type: 'tool-error'});
    await rejected;
    f.child.emit('message', {type: 'tool-start', pid: f.child.pid}); await flush();
    assert.equal(f.child.stdin.writableEnded, false); assert.equal(f.sends, 1);
    assert.equal(f.actions.includes('kill'), true); assert.equal(f.owner.busy, false);
  });
}

for (const death of [
  {cause: 'SIGKILL', code: null, signal: 'SIGKILL'},
  {cause: 'SIGINT', code: null, signal: 'SIGINT'},
  {cause: 'KeyboardInterrupt', code: 127, signal: null},
  {cause: 'MemoryError', code: 127, signal: null},
  {cause: 'arbitrary exception', code: 127, signal: null},
  {cause: 'execve ENOENT', code: 127, signal: null},
] as const) for (const delivery of ['combined', 'separate'] as const) for (const deniedCleanup of [false, true]) {
  test(`S4 abrupt pre-exec bootstrap death from ${death.cause} with ${delivery} notifications ${deniedCleanup ? 'retains denied cleanup' : 'waits for S3 cleanup'} without startup callbacks or stdin`, async t => {
    const f = await fixture(t), cleanupEntered = deferred(), releaseCleanup = deferred();
    const source = join(dirname(f.owner.state.data), 'source'), runDir = join(source, 'run');
    await mkdir(runDir, {recursive: true, mode: 0o700});
    const promptFile = join(runDir, 'prompt.md'), bin = await realpath('/usr/bin/true');
    await writeFile(promptFile, 'This task must never reach the bootstrap.', {mode: 0o600});
    const parse = t.mock.fn(() => ({ok: true, text: 'Unexpected success.', failureCode: null}));
    const identity = t.mock.fn(async () => ({ok: true, version: 'fixture'}));
    const execFailure = death.cause === 'execve ENOENT';
    const adapter: Adapter = {
      info: {tool: 'codex', harness: 'codex', card: 'TLS-26', folderOnly: 'os-sandbox', mcpLevel: 'servers-off',
        skillsDir: '{runDir}/skills', promptVia: 'stdin', runHome: false},
      identity, supports: () => ({ok: true, reason: null}),
      build: spec => ({argv: [spec.bin, 'exec'], env: {}, envUnset: [], stdinFile: spec.promptFile,
        files: [], projectFiles: [], spawnCwd: null, secretEnv: {}}),
      parse,
    };
    f.ready.resolve(); f.holdAcknowledgment();
    if (deniedCleanup) f.denyKill();
    f.onKill(() => {
      Object.assign(f.child, {exitCode: 0});
      (f.child.stdout as PassThrough).end(); (f.child.stderr as PassThrough).end(); f.child.stdin.destroy();
      f.child.emit('exit', 0, null); f.child.emit('close', 0, null);
    });
    const cleanup = f.lifecycle.cleanup;
    t.mock.method(f.lifecycle, 'cleanup', async (...[run, deadline]: Parameters<typeof cleanup>) => {
      cleanupEntered.resolve(); await releaseCleanup.promise;
      return cleanup.call(f.lifecycle, run, deadline);
    });
    const started = t.mock.fn(async () => {}), spawned = t.mock.fn(), input: Buffer[] = [];
    f.child.stdin.on('data', chunk => input.push(Buffer.from(chunk)));
    const numeric = t.mock.method(process, 'kill', () => {throw new Error('numeric signal sink reached');});
    const claimedAt = Date.now();
    let startupSettled = false;
    const starting = startTool({adapter, matrix: acceptedMatrix, linuxLifecycle: f.lifecycle,
      spec: {bin, cwd: source, runDir, promptFile, model: 'fixture', provider: 'ollama', effort: null,
        access: 'full_access', skillsDir: join(runDir, 'skills'), maxTurns: 50, timeoutSeconds: 0, runHome: null},
      claimedAt, expiresAt: claimedAt + 7_200_000, maxRunMinutes: 1, onStarted: started, onSpawn: spawned})
      .finally(() => {startupSettled = true;});
    const rejected = assert.rejects(starting, deniedCleanup ? ProcessCleanupError : {code: execFailure ? 'tool_not_found' : 'adapter_refused'});
    try {
      const until = Date.now() + 2000;
      while (!f.sends && !startupSettled && Date.now() < until) await flush();
      assert.equal(f.sends, 1, 'the durable launch permission must reach exactly one native dispatch');
      assert.equal(identity.mock.callCount(), 1, 'identity admission precedes native dispatch');
      assert.deepEqual(await f.stages(), ['EPOCH', 'INTENT', 'CONTAINMENT_BOUND', 'LAUNCH_ALLOWED']);
      assert.equal(f.owner.busy, true);
      // The guardian reports pre-exec failure before the inner death notice.
      // Deliver both frames together or allow the controller to handle the
      // failure separately, matching both real transport schedules.
      f.child.emit('message', {type: execFailure ? 'exec-error' : 'tool-error'});
      if (delivery === 'separate') {await cleanupEntered.promise; await flush();}
      f.child.emit('message', {type: 'tool-exit', code: death.code, signal: death.signal});
      await cleanupEntered.promise; await flush();
      assert.equal(startupSettled, false, 'bootstrap death cannot settle before retained S3 cleanup');
      assert.equal(started.mock.callCount(), 0); assert.equal(spawned.mock.callCount(), 0);
      assert.deepEqual(input, []); assert.equal(f.child.stdin.writableEnded, false);
      assert.deepEqual(await f.stages(), ['EPOCH', 'INTENT', 'CONTAINMENT_BOUND', 'LAUNCH_ALLOWED']);
      assert.equal(f.owner.busy, true); assert.equal(f.owner.isRunRetired(f.runId), false);
      assert.equal(f.actions.includes('retire'), false);
      releaseCleanup.resolve(); await rejected;
      // A denied kill can reject before the queued STOPPING publication has
      // physically settled. Join it before checking the retained evidence.
      await f.owner.operation(f.generation, async () => {});
      assert.equal(f.actions.includes('kill'), true, 'cleanup must use the original retained containment endpoint');
      assert.equal(numeric.mock.callCount(), 0); assert.equal(parse.mock.callCount(), 0);
      assert.equal(f.owner.busy, deniedCleanup);
      assert.equal(f.owner.isRunRetired(f.runId), !deniedCleanup);
      assert.equal(f.actions.includes('retire'), !deniedCleanup);
      assert.deepEqual(await f.stages(), ['EPOCH', 'INTENT', 'CONTAINMENT_BOUND', 'LAUNCH_ALLOWED', 'STOPPING',
        ...(deniedCleanup ? [] : ['CLEAN'])]);
      f.child.emit('message', {type: 'tool-start', pid: f.child.pid}); await flush();
      assert.equal(started.mock.callCount(), 0); assert.equal(spawned.mock.callCount(), 0);
      assert.deepEqual(input, [], 'a late acknowledgment must never deliver task stdin');
    } finally {releaseCleanup.resolve(); await rejected;}
  });
}


test('S5 post-INTENT bootstrap failure retains an endpoint and CLEAN permits the next admission', async t => {
  const f = await fixture(t);
  f.holdSpawn(async () => {throw new Error('synthetic bootstrap failure');});
  await assert.rejects(f.prepare(), /synthetic bootstrap failure/u);
  assert.deepEqual(await f.stages(), ['EPOCH', 'INTENT', 'CONTAINMENT_BOUND', 'LAUNCH_ALLOWED', 'STOPPING', 'CLEAN']);
  assert.equal(f.owner.busy, false);
  assert.equal(f.actions.includes('kill'), true);
  f.holdSpawn(async () => {});
  const lifecycle = createLinuxToolLifecycle(f.owner, f.generation, randomUUID());
  const run = await lifecycle.prepare({argv: ['/usr/bin/true'], cwd: '/work', env: {}, deadline: Date.now() + 60_000});
  f.ready.resolve(); await lifecycle.launch(run); await lifecycle.cleanup(run, Date.now() + 20_000);
  assert.equal(f.starts, 1); assert.equal(f.owner.busy, false);
  assert.deepEqual((await f.stages()).slice(-5), ['INTENT', 'CONTAINMENT_BOUND', 'LAUNCH_ALLOWED', 'STOPPING', 'CLEAN']);
});


test('S5 failed namespace reservation publishes no INTENT and the next admission succeeds', async t => {
  const f = await fixture(t);
  f.holdReserve(async () => {throw new Error('synthetic reservation failure');});
  await assert.rejects(f.prepare(), /synthetic reservation failure/u);
  assert.deepEqual(await f.stages(), ['EPOCH']); assert.equal(f.owner.busy, false);
  f.holdReserve(async () => {});
  const lifecycle = createLinuxToolLifecycle(f.owner, f.generation, randomUUID());
  const run = await lifecycle.prepare({argv: ['/usr/bin/true'], cwd: '/work', env: {}, deadline: Date.now() + 60_000});
  f.ready.resolve(); await lifecycle.launch(run); await lifecycle.cleanup(run, Date.now() + 20_000);
  assert.equal(f.starts, 1); assert.equal(f.owner.busy, false);
});

test('S5 timed-out reservation is discarded without INTENT when its empty handle arrives late', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  f.holdReserve(async () => {entered.resolve(); await release.promise;});
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: Date.now()});
  const preparing = f.prepare(), rejected = assert.rejects(preparing, ProcessCleanupError);
  await entered.promise; t.mock.timers.tick(20_001); await rejected;
  assert.deepEqual(await f.stages(), ['EPOCH']); assert.equal(f.owner.busy, true);
  await f.owner.detach(f.generation);
  assert.doesNotThrow(() => f.owner.assertGeneration(f.generation), 'late cleanup keeps its original owner generation');
  assert.throws(() => f.owner.attach(), 'another caller cannot reuse a pending reservation');
  release.resolve();
  await f.preparationSettled.promise; await flush();
  assert.equal(f.actions.includes('retire'), true); assert.equal(f.admitted, false);
  assert.equal(f.owner.diagnosticSnapshot().attached, false, 'physical retirement completes the deferred detach');
  assert.deepEqual(await f.stages(), ['EPOCH']); assert.equal(f.owner.busy, false);
});
