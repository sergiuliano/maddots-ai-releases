import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import type {Stats} from 'node:fs';
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {PassThrough} from 'node:stream';
import {type ChildProcessWithoutNullStreams} from 'node:child_process';
import test, {type TestContext} from 'node:test';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {TOOL_MATRIX} from '../src/shared/tool-matrix.js';
import type {Adapter} from '../src/runner/adapter.js';
import {containmentBackendForNamespace, createLinuxContainmentBackend, cleanLinuxToolEnvironment, linuxProviderOomCount, linuxSandboxArguments, qualifyLinuxRuntimeMounts, LINUX_CONTAINMENT_PATHS,
  type LinuxRuntimeTreeIO,
  type LinuxContainedRun, type LinuxContainmentContext, type LinuxContainmentNamespace, type LinuxContainmentObject, type LinuxContainmentRequest, type LinuxContainmentRelease} from '../src/runner/linux-containment.js';
import {LINUX_GUARDIAN, LINUX_INNER_LAUNCHER} from '../src/runner/linux-guardian.js';
import {startTool} from '../src/runner/process.js';

const namespaceId = '7b04c642-4674-44e3-8df3-1c6ff90b70f1';
const incarnation = '3d96eda7-95f4-4ca1-af2f-f3acfe9b5ccd';
const binding = 'a'.repeat(64);
const release = (): LinuxContainmentRelease => ({binding, incarnation, notAfterMonotonicNs: String(process.hrtime.bigint() + 5_000_000_000n)});
const request: LinuxContainmentRequest = {incarnation, releaseBinding: binding, file: '/usr/bin/true', args: [], cwd: '/work', env: {}, admitLauncher: () => true};
function fixture() {
  let owned = true, namespaceValid = true, populated = true, objectValid = true, admitted = false, sealedAck = false,
    childDead = false, starts = 0, seals = 0, kills = 0, retired = 0, spawned = 0, denied = false, ready = false,
    storageAvailable = true, terms = 0, prepared = 0, credentialFailure = false, closed = false, admissionAllowed = true;
  let resolveReady!: () => void;
  const readiness = new Promise<void>(resolve => {resolveReady = () => {ready = true; resolve();};});
  const child = Object.assign(new EventEmitter(), {stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough()}) as unknown as ChildProcessWithoutNullStreams;
  const registration = Object.freeze({backend: 'linux-cgroup-v2' as const, namespaceId, name: `run-${incarnation}`, objectIdentity: '12:34'});
  const object: LinuxContainmentObject = {
    registration, workPath: '/fixture/work',
    async assertCurrent() {if (!objectValid) throw new Error('object replaced');},
    async spawn() {spawned++; return {child, ready: readiness,
      start() {if (!ready || admitted || seals || childDead) return false; admitted = true; starts++; return true;},
      seal() {seals++;}, async term() {terms++;}, admissionClosed() {return sealedAck || childDead;}};},
    async forceKill() {if (!objectValid || !namespaceValid) throw new Error('retained object replaced'); kills++; if (denied) throw new Error('EPERM retained kill'); populated = false; childDead = true;},
    async empty() {return !populated;}, async retire() {retired++;},
    async prepareCompletion(assertExtinct) {
      await assertExtinct();
      if (credentialFailure) throw new Error('credential cleanup failed'); prepared++;
    },
    assertPublicContent(content) {
      assert.equal(prepared > 0, true, 'publication follows credential reconciliation');
      if (content.toString().includes('synthetic-login-secret')) throw new Error('protected output');
    },
  };
  let reserved = false;
  const completed = [] as typeof registration[];
  const namespace: LinuxContainmentNamespace = {namespaceId,
    async assertCurrent() {if (!storageAvailable) throw new Error('EIO protected receipt'); if (!namespaceValid) throw new Error('namespace replaced');},
    async qualifyAdmission() {if (!admissionAllowed) throw new Error('unsafe runtime mount');},
    async reserve() {if (reserved) throw new Error('EEXIST never reused'); reserved = true; return object;},
    async reopen(registration_) {if (!reserved || !objectValid || registration_.objectIdentity !== object.registration.objectIdentity) throw new Error('missing or replaced'); return object;},
    async retireCompleted(registration_) {if (!objectValid || registration_.objectIdentity !== object.registration.objectIdentity) throw new Error('replaced'); if (populated && reserved) throw new Error('still populated'); retired++;},
    async close() {closed = true;},
  };
  const context: LinuxContainmentContext = {directoryIdentity: '1:2', bootId: '337acde8-979a-402f-8982-f3f1d27a005c',
    ownerEpoch: '178360f2-2e10-4e10-8ff9-c0a48e279d29', isCurrent: () => owned, registrations: [registration], completedRegistrations: completed};
  return {backend: containmentBackendForNamespace(context, namespace), namespace, context, registration, resolveReady,
    markDurablyClean() {completed.push(registration);},
    failStorage() {storageAvailable = false;}, failCredentialCleanup() {credentialFailure = true;},
    denyAdmission() {admissionAllowed = false;},
    revoke() {owned = false;}, replaceNamespace() {namespaceValid = false;}, replaceObject() {objectValid = false;},
    acknowledgeSeal() {sealedAck = true;}, observeEmpty() {populated = false;}, denyKill() {denied = true;},
    get counts() {return {starts, seals, kills, retired, spawned};}, get terms() {return terms;},
    get prepared() {return prepared;}, get closed() {return closed;}};
}

/** Exercise the production channel handlers without launching a child or
 * opening privileged files. Keep the real release check and all handler state. */
async function guardianChannelFixture(t: TestContext, provider = true, launch = true) {
  const text = await readFile(new URL('../src/runner/linux-containment.ts', import.meta.url), 'utf8');
  const source = ts.createSourceFile('linux-containment.ts', text, ts.ScriptTarget.Latest, true);
  const native = source.statements.find(statement => ts.isClassDeclaration(statement) && statement.name?.text === 'NativeObject');
  assert(native && ts.isClassDeclaration(native), 'cover the production NativeObject class');
  const spawn = native.members.find(member => ts.isMethodDeclaration(member) && member.name.getText(source) === 'spawn');
  assert(spawn && ts.isMethodDeclaration(spawn) && spawn.body, 'cover the production spawn method');
  const first = spawn.body.statements.findIndex(statement => ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === 'control'));
  assert(first >= 0, 'cover the entire production private channel lifecycle');
  const validRelease = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'validRelease');
  assert(validRelease, 'retain the production release check');
  const methodBody = (name: string) => {
    const method = native.members.find(member => ts.isMethodDeclaration(member) && member.name.getText(source) === name);
    assert(method && ts.isMethodDeclaration(method) && method.body, `cover production ${name}`);
    return method.body.getText(source);
  };
  const body = spawn.body.statements.slice(first).map(statement => statement.getText(source)).join('\n');
  const javascript = ts.transpileModule(`${validRelease.getText(source)}
    export async function providerOomCount() ${methodBody('providerOomCount')}
    export async function prepareCompletion(assertExtinct) ${methodBody('prepareCompletion')}
    export function installChannel(child, request, binding, incarnation) {${body}}`, {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
  }).outputText;
  const commands: string[] = [], messages: unknown[] = [];
  const control = Object.assign(new EventEmitter(), {
    destroyed: false, writable: true, write(command: string) {commands.push(command); return true;},
  });
  const child = Object.assign(new EventEmitter(), {pid: 910_100, exitCode: null, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    stdio: [null, null, null, null, control]}) as unknown as ChildProcessWithoutNullStreams;
  child.on('message', message => messages.push(structuredClone(message)));
  t.mock.timers.enable({apis: ['setTimeout', 'setInterval']});
  const exports: {installChannel?: (this: object, child: ChildProcessWithoutNullStreams, request: {provider: boolean}, binding: string,
    incarnation: string) => Awaited<ReturnType<LinuxContainmentObject['spawn']>>;
    providerOomCount?: (this: object) => Promise<bigint>;
    prepareCompletion?: (this: object, assertExtinct: () => Promise<void>) => Promise<void>;
  } = {};
  runInNewContext(javascript, {exports, Buffer, process, setTimeout, clearTimeout, setInterval, clearInterval,
    linuxProviderOomCount, requireThat: (ok: unknown, detail: string) => assert(ok, detail),
    cleanRunCredentials: async () => {},
  });
  assert(exports.installChannel && exports.providerOomCount && exports.prepareCompletion);
  let extinct = false, resolveExtinction!: () => void, nextMemoryRead: (() => Promise<string>) | undefined;
  const extinction = new Promise<void>(resolve => {resolveExtinction = resolve;});
  const memory = {oom: 2n, oom_kill: 3n, oom_group_kill: 5n, max: 7n};
  const memoryText = () => Object.entries(memory).map(([name, value]) => `${name} ${value}\n`).join('');
  const memoryRead = t.mock.fn(async (bytes: Buffer) => {
    const read = nextMemoryRead; nextMemoryRead = undefined;
    return {bytesRead: bytes.write(read ? await read() : memoryText())};
  });
  const owner = {memoryEvents: provider ? {read: memoryRead} : undefined, oomBaseline: 0n,
    providerOomCount: exports.providerOomCount,
    async assertCurrent() {}, async empty() {return extinct;},
    selectedLogin: {async complete(assertExtinct: () => Promise<void>) {await assertExtinct();}},
    data: '/fixture/run', namespace: {uid: process.getuid?.()},
  };
  if (provider) owner.oomBaseline = await owner.providerOomCount();
  const run = exports.installChannel.call(owner, child, {provider}, binding, incarnation);
  t.after(() => child.emit('exit', 0, null));
  const frame = (event: {event: string; code?: number | null; signal?: string | null}) =>
    control.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
  frame({event: 'ready'}); await run.ready;
  if (launch) {assert.equal(run.start(release()), true); frame({event: 'started'}); messages.length = 0;}
  return {frame, messages, commands, control, child, run, memory, memoryText, memoryRead,
    nextMemoryRead(read: () => Promise<string>) {nextMemoryRead = read;},
    observeEmpty() {extinct = true; resolveExtinction();},
    async prepareCompletion() {
      await exports.prepareCompletion!.call(owner, async () => {await extinction; assert(extinct);});
    },
  };
}

/** Feed the real native channel handlers into the public process runner. Only
 * the OS child and containment operations are fake; the final result is not. */
async function guardianProcessFixture(t: TestContext, provider: boolean) {
  const f = await guardianChannelFixture(t, provider, false);
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-guardian-channel-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const runDir = join(root, 'run'), promptFile = join(root, 'prompt.md');
  await mkdir(runDir); await writeFile(promptFile, 'Synthetic channel completion fixture.');
  const matrix = structuredClone(TOOL_MATRIX);
  matrix.tools.find(item => item.key === 'codex')!.run = {adapter: 'codex', card: 'TLS-26', offered: true,
    platforms: {linux: {accepted: true}}, folderOnly: 'os-sandbox', mcpLevel: 'servers-off', reason: null, checkedAt: '2026-10-14'};
  const parse = t.mock.fn(({stdout, exitCode, signal}: Parameters<Adapter['parse']>[0]) => ({
    ok: exitCode === 0 && signal === null, text: stdout, failureCode: exitCode === 0 && signal === null ? null : 'tool_failed',
  }));
  const adapter: Adapter = {
    info: {tool: 'codex', harness: 'codex', card: 'TLS-26', folderOnly: 'os-sandbox', mcpLevel: 'servers-off',
      skillsDir: '{runDir}/skills', promptVia: 'stdin', runHome: false},
    identity: async () => ({ok: true, version: 'fixture'}), supports: () => ({ok: true, reason: null}),
    build: spec => ({argv: [spec.bin, 'exec'], env: {}, envUnset: [], stdinFile: spec.promptFile,
      files: [], projectFiles: [], spawnCwd: null, secretEnv: {}}), parse,
  };
  const run: LinuxContainedRun = {...f.run, registration: {backend: 'linux-cgroup-v2', namespaceId,
    name: `run-${incarnation}`, objectIdentity: '12:34'},
    async forceKill() {}, async empty() {return true;},
    async completionProof() {await f.prepareCompletion(); return {};}, async retire() {}};
  const claimedAt = Date.now();
  const running = await startTool({adapter, matrix,
    spec: {bin: await realpath(process.execPath), cwd: root, runDir, promptFile, model: 'fixture', provider: 'ollama',
      effort: null, access: 'full_access', skillsDir: join(root, 'skills'), maxTurns: 1, timeoutSeconds: 0, runHome: null},
    claimedAt, expiresAt: claimedAt + 7_200_000, maxRunMinutes: 1,
    linuxLifecycle: {
      async prepare() {return run;},
      async launch() {assert.equal(run.start(release()), true); f.frame({event: 'started'});},
      async cleanup() {await run.term(); await run.completionProof();},
    },
  });
  let finished = false;
  void running.finished.then(() => {finished = true;}, () => {finished = true;});
  return {...f, parse, running, get finished() {return finished;},
    guardianExit(extinct = true) {
      Object.assign(f.child, {exitCode: 0}); f.child.emit('exit', 0, null);
      if (extinct) f.observeEmpty();
    },
    async close() {
      (f.child.stdout as PassThrough).end(); (f.child.stderr as PassThrough).end();
      await new Promise<void>(resolve => setImmediate(resolve));
      f.child.emit('close', 0, null);
      return running.finished;
    },
  };
}

for (const counter of ['oom', 'oom_kill', 'oom_group_kill'] as const) {
  for (const timing of ['between-samples', 'during-teardown'] as const) {
    test(`final process result rejects ${counter} ${timing} despite status zero and complete EOF`,
      {skip: process.platform !== 'linux'}, async t => {
        const f = await guardianProcessFixture(t, true);
        f.frame({event: 'exit', code: 0, signal: null});
        f.frame({event: 'terminated'}); f.control.emit('end');
        if (timing === 'during-teardown') {
          // The guardian can exit before the last provider descendant. Its
          // exit stops polling but cannot authorize the final resource sample.
          f.guardianExit(false);
          await new Promise<void>(resolve => setImmediate(resolve));
          assert.equal(f.memoryRead.mock.callCount(), 1, 'only the baseline is read before extinction');
        }
        f.memory[counter]++;
        if (timing === 'between-samples') f.guardianExit(); else f.observeEmpty();
        const result = await f.close();
        assert.equal(result.ok, false); assert.equal(result.failureCode, 'adapter_refused');
        assert.equal(result.exitCode, 0); assert.equal(result.signal, null);
        assert.equal(f.parse.mock.callCount(), 0);
        assert.equal(f.memoryRead.mock.callCount(), 2, 'the final read detects the unsampled OOM');
        assert.equal(f.messages.filter(message => (message as {type: string}).type === 'tool-error').length, 1);
      });
  }
}

for (const failure of ['read-error', 'malformed-counters'] as const) {
  test(`final OOM accounting ${failure} cannot retain process success`, {skip: process.platform !== 'linux'}, async t => {
    const f = await guardianProcessFixture(t, true);
    f.nextMemoryRead(async () => {
      if (failure === 'read-error') throw new Error('EIO final memory.events read');
      return 'oom 2\noom_kill 3\n';
    });
    f.frame({event: 'exit', code: 0, signal: null});
    f.frame({event: 'terminated'}); f.control.emit('end'); f.guardianExit();
    const result = await f.close();
    assert.equal(result.ok, false); assert.equal(result.failureCode, 'adapter_refused');
    assert.equal(f.parse.mock.callCount(), 0);
    assert.equal(f.memoryRead.mock.callCount(), 2);
    assert.equal(f.messages.filter(message => (message as {type: string}).type === 'tool-error').length, 1);
  });
}

test('completion joins an outstanding memory sample before the final extinction read', {skip: process.platform !== 'linux'}, async t => {
  const f = await guardianProcessFixture(t, true);
  const sampledBeforeOOM = f.memoryText();
  let resolveSample!: (value: string) => void;
  f.nextMemoryRead(() => new Promise<string>(resolve => {resolveSample = resolve;}));
  t.mock.timers.tick(50);
  assert.equal(f.memoryRead.mock.callCount(), 2);
  f.frame({event: 'exit', code: 0, signal: null});
  f.frame({event: 'terminated'}); f.control.emit('end'); f.guardianExit();
  const closing = f.close();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.finished, false); assert.equal(f.parse.mock.callCount(), 0);
  assert.equal(f.memoryRead.mock.callCount(), 2, 'the final read must not race the in-flight sample');
  f.memory.oom++;
  resolveSample(sampledBeforeOOM);
  const result = await closing;
  assert.equal(result.ok, false); assert.equal(result.failureCode, 'adapter_refused');
  assert.equal(f.parse.mock.callCount(), 0); assert.equal(f.memoryRead.mock.callCount(), 3);
});

test('success waits for an unchanged final OOM baseline after complete EOF and guardian exit',
  {skip: process.platform !== 'linux'}, async t => {
    const f = await guardianProcessFixture(t, true);
    let resolveFinal!: (value: string) => void;
    f.nextMemoryRead(() => new Promise<string>(resolve => {resolveFinal = resolve;}));
    f.frame({event: 'exit', code: 0, signal: null});
    f.frame({event: 'terminated'}); f.control.emit('end'); f.guardianExit();
    const closing = f.close();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.finished, false); assert.equal(f.parse.mock.callCount(), 0);
    assert.equal(f.memoryRead.mock.callCount(), 2);
    resolveFinal(f.memoryText());
    const result = await closing;
    assert.equal(result.ok, true); assert.equal(result.failureCode, null);
    assert.equal(f.parse.mock.callCount(), 1);
  });

for (const status of [{code: 0, signal: null}, {code: 7, signal: null}, {code: null, signal: 'SIGTERM'}]) {
  for (const order of ['workload-first', 'status-first'] as const) {
    test(`provider ${order} preserves authoritative exit ${JSON.stringify(status)} throughout cleanup`, async t => {
      const f = await guardianChannelFixture(t);
      const exit = {event: 'exit', ...status}, workload = {event: 'workload-exited'};
      for (const event of order === 'workload-first' ? [workload, exit] : [exit, workload]) f.frame(event);
      t.mock.timers.tick(5000);
      assert.deepEqual(f.messages, [{type: 'tool-exit', ...status}]);
      assert.equal(f.run.admissionClosed(), true);
      assert.equal(f.commands.includes('SEAL\n'), false);
    });
  }
}

test('duplicate provider exit notifications preserve the first status without restarting cleanup timers', async t => {
  const f = await guardianChannelFixture(t);
  f.frame({event: 'workload-exited'}); t.mock.timers.tick(750);
  f.frame({event: 'workload-exited'}); t.mock.timers.tick(249);
  assert.deepEqual(f.messages, []);
  f.frame({event: 'exit', code: 0, signal: null});
  f.frame({event: 'workload-exited'}); f.frame({event: 'exit', code: 0, signal: null});
  f.frame({event: 'workload-exited'}); t.mock.timers.tick(5000);
  assert.deepEqual(f.messages, [{type: 'tool-exit', code: 0, signal: null}]);
  assert.equal(f.commands.includes('SEAL\n'), false);
});

test('duplicate workload exit notifications cannot extend the missing authoritative status deadline', async t => {
  const f = await guardianChannelFixture(t);
  f.frame({event: 'workload-exited'}); t.mock.timers.tick(750);
  f.frame({event: 'workload-exited'}); t.mock.timers.tick(249);
  assert.deepEqual(f.messages, []);
  t.mock.timers.tick(1);
  assert.deepEqual(f.messages, [{type: 'tool-error'}]);
  assert.equal(f.commands.filter(command => command === 'SEAL\n').length, 1);
  f.frame({event: 'workload-exited'}); t.mock.timers.tick(5000);
  assert.deepEqual(f.messages, [{type: 'tool-error'}]);
});

// TERM acknowledgement and EOF share one ordered socket, while Node can
// observe the guardian's exit before, between, or after those two events.
for (const provider of [false, true]) {
  for (const order of ['ack-eof-exit', 'ack-exit-eof', 'exit-ack-eof'] as const) {
    for (const status of [{code: 0, signal: null}, {code: 7, signal: null}, {code: null, signal: 'SIGTERM'}]) {
      test(`${provider ? 'provider' : 'ordinary'} cleanup ${order} preserves authoritative exit ${JSON.stringify(status)}`, async t => {
        const f = await guardianChannelFixture(t, provider);
        f.frame({event: 'exit', ...status});
        await f.run.term();
        assert.equal(f.commands.at(-1), 'TERM\n');
        for (const event of order.split('-')) {
          if (event === 'ack') f.frame({event: 'terminated'});
          else if (event === 'eof') f.control.emit('end');
          else f.child.emit('exit', null, 'SIGKILL');
        }
        t.mock.timers.tick(5000);
        assert.deepEqual(f.messages, [{type: 'tool-exit', ...status}, {type: 'guardian-terminated'}]);
        assert.equal(f.run.admissionClosed(), true);
        assert.equal(f.commands.includes('SEAL\n'), false);
      });
    }
  }
  for (const state of ['running', 'sealed', 'term-requested', 'exit-received'] as const) {
    test(`${provider ? 'provider' : 'ordinary'} unacknowledged channel EOF remains terminal after ${state}`, async t => {
      const f = await guardianChannelFixture(t, provider);
      if (state === 'sealed') {f.run.seal(); f.frame({event: 'sealed'});}
      if (state === 'term-requested') await f.run.term();
      if (state === 'exit-received') f.frame({event: 'exit', code: 0, signal: null});
      f.control.emit('end');
      // A later acknowledgement or process-exit event cannot erase failure.
      f.frame({event: 'terminated'}); f.child.emit('exit', null, 'SIGKILL');
      t.mock.timers.tick(5000);
      assert.deepEqual(f.messages, [
        ...(state === 'exit-received' ? [{type: 'tool-exit', code: 0, signal: null}] : []),
        {type: 'tool-error'}, {type: 'guardian-terminated'},
      ]);
    });
  }
}

for (const failure of ['provider-failed', 'provider-monitor-failed', 'channel-error', 'truncated-frame'] as const) {
  test(`acknowledged provider teardown does not suppress terminal ${failure}`, async t => {
    const f = await guardianChannelFixture(t);
    f.frame({event: 'exit', code: 0, signal: null}); f.frame({event: 'workload-exited'});
    await f.run.term(); f.frame({event: 'terminated'});
    if (failure === 'channel-error') f.control.emit('error', new Error('synthetic channel failure'));
    else if (failure === 'truncated-frame') {
      f.control.emit('data', Buffer.from('{"event":')); f.control.emit('end');
    }
    else f.frame({event: failure});
    t.mock.timers.tick(5000);
    assert.deepEqual(f.messages, [{type: 'tool-exit', code: 0, signal: null}, {type: 'guardian-terminated'}, {type: 'tool-error'}]);
    assert.equal(f.commands.filter(command => command === 'SEAL\n').length, 1);
  });
}

const channelOrders = ['status-exit-eof', 'status-eof-exit', 'exit-status-eof',
  'exit-eof-status', 'eof-status-exit', 'eof-exit-status'] as const;
for (const provider of [false, true]) for (const order of channelOrders) {
  const statusBeforeEOF = order.indexOf('status') < order.indexOf('eof');
  for (const status of [{code: 0, signal: null}, {code: 7, signal: null}, {code: null, signal: 'SIGTERM'}]) {
    test(`${provider ? 'provider' : 'ordinary'} final process result requires complete channel in ${order} for ${JSON.stringify(status)}`,
      {skip: process.platform !== 'linux'}, async t => {
        const f = await guardianProcessFixture(t, provider);
        for (const event of order.split('-')) {
          if (event === 'status') f.frame({event: 'exit', ...status});
          else if (event === 'exit') f.guardianExit();
          else {f.frame({event: 'terminated'}); f.control.emit('end');}
          await new Promise<void>(resolve => setImmediate(resolve));
          assert.equal(f.finished, false, 'the result must wait for all child channels to close');
        }
        const result = await f.close();
        // Status and acknowledgement precede EOF on a real socket. Injecting
        // status after EOF proves that a late frame cannot repair invalid EOF.
        assert.equal(result.ok, statusBeforeEOF && status.code === 0);
        assert.equal(result.failureCode, !statusBeforeEOF ? 'adapter_refused' : status.code === 0 ? null : 'tool_failed');
        assert.equal(result.exitCode, status.code); assert.equal(result.signal, status.signal);
        assert.equal(f.parse.mock.callCount(), statusBeforeEOF ? 1 : 0);
      });
  }
  for (const ending of ['unacknowledged', 'truncated-ack', 'truncated-tail'] as const) {
    test(`${provider ? 'provider' : 'ordinary'} ${ending} in ${order} cannot retain final process success`,
      {skip: process.platform !== 'linux'}, async t => {
        const f = await guardianProcessFixture(t, provider);
        for (const event of order.split('-')) {
          if (event === 'status') f.frame({event: 'exit', code: 0, signal: null});
          else if (event === 'exit') f.guardianExit();
          else {
            if (ending === 'truncated-tail') f.frame({event: 'terminated'});
            if (ending !== 'unacknowledged') f.control.emit('data', Buffer.from('{"event":"terminated"}'));
            f.control.emit('end');
          }
          await new Promise<void>(resolve => setImmediate(resolve));
          assert.equal(f.finished, false);
        }
        const result = await f.close();
        assert.equal(result.ok, false); assert.equal(result.failureCode, 'adapter_refused');
        assert.equal(f.parse.mock.callCount(), 0, 'failed final channel must never reach the success parser');
        assert.equal(f.messages.filter(message => (message as {type: string}).type === 'tool-error').length, 1);
      });
  }
}

for (const order of ['exit-eof', 'eof-exit'] as const) {
  test(`acknowledged channel without workload status cannot inherit guardian success in ${order}`,
    {skip: process.platform !== 'linux'}, async t => {
      const f = await guardianProcessFixture(t, true);
      for (const event of order.split('-')) {
        if (event === 'exit') f.guardianExit();
        else {f.frame({event: 'terminated'}); f.control.emit('end');}
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      const result = await f.close();
      assert.equal(result.ok, false); assert.equal(result.failureCode, 'adapter_refused');
      assert.equal(f.parse.mock.callCount(), 0);
    });
}

for (const provider of [false, true]) for (const order of ['exit-channel', 'channel-exit'] as const) {
  for (const completed of [false, true]) {
    test(`${provider ? 'provider' : 'ordinary'} child close with ${completed ? 'complete' : 'aborted'} private channel in ${order} requires validated EOF`,
      {skip: process.platform !== 'linux'}, async t => {
        const f = await guardianProcessFixture(t, provider);
        f.frame({event: 'exit', code: 0, signal: null}); f.frame({event: 'terminated'});
        for (const event of order.split('-')) {
          if (event === 'exit') f.guardianExit();
          else {
            if (completed) f.control.emit('end');
            Object.assign(f.control, {destroyed: true, writable: false});
            f.control.emit('close');
          }
          await new Promise<void>(resolve => setImmediate(resolve));
          assert.equal(f.finished, false);
        }
        const result = await f.close();
        assert.equal(result.ok, completed);
        assert.equal(result.failureCode, completed ? null : 'adapter_refused');
        assert.equal(f.parse.mock.callCount(), completed ? 1 : 0);
        assert.equal(f.messages.filter(message => (message as {type: string}).type === 'tool-error').length, completed ? 0 : 1);
      });
  }
}

for (const status of [{}, {code: 0}, {signal: null}, {code: '0', signal: null}, {code: 0.5, signal: null},
  {code: -1, signal: null}, {code: null, signal: null}, {code: null, signal: ''}, {code: 0, signal: 'SIGTERM'}]) {
  for (const order of ['status-exit-eof', 'status-eof-exit', 'exit-status-eof'] as const) {
    test(`malformed workload status ${JSON.stringify(status)} cannot authorize final process success in ${order}`,
      {skip: process.platform !== 'linux'}, async t => {
        const f = await guardianProcessFixture(t, true);
        for (const event of order.split('-')) {
          if (event === 'status') f.control.emit('data', Buffer.from(JSON.stringify({event: 'exit', ...status}) + '\n'));
          else if (event === 'exit') f.guardianExit();
          else {f.frame({event: 'terminated'}); f.control.emit('end');}
          await new Promise<void>(resolve => setImmediate(resolve));
        }
        const result = await f.close();
        assert.equal(result.ok, false); assert.equal(result.failureCode, 'adapter_refused');
        assert.equal(f.parse.mock.callCount(), 0);
      });
  }
}

test('paused guardian permits exactly one start after readiness', async () => {
  const f = fixture(), run = await f.backend.reserve(request);
  assert.equal(run.start(release()), false);
  assert.equal(f.counts.starts, 0);
  f.resolveReady(); await run.ready;
  assert.equal(await f.backend.verifyRegistration(run.registration), true);
  assert.equal(run.start(release()), true); assert.equal(run.start(release()), false);
  assert.equal(f.counts.starts, 1); assert.equal(f.counts.spawned, 1);
});

test('selected-login publication requires completed sealed extinction and rejects protected bytes after retirement', async () => {
  const f = fixture(), run = await f.backend.reserve(request);
  assert.throws(() => run.assertPublicContent!('safe'), /not proven/u);
  run.seal(); f.observeEmpty();
  await assert.rejects(run.completionProof(), /not empty/u);
  assert.equal(f.prepared, 0);
  f.acknowledgeSeal();
  await run.completionProof();
  assert.equal(f.prepared, 1);
  run.assertPublicContent!('safe');
  assert.throws(() => run.assertPublicContent!('synthetic-login-secret'), /protected output/u);
  await run.retire(() => true);
  assert.throws(() => run.assertPublicContent!('synthetic-login-secret'), /protected output/u);
});

test('malformed, expired and mismatched releases permanently seal the retained run without starting', async () => {
  const invalid = [undefined, {}, {...release(), binding: 'b'.repeat(64)},
    {...release(), incarnation: '3d96eda7-95f4-4ca1-af2f-f3acfe9b5cce'},
    {...release(), notAfterMonotonicNs: '1'}, {...release(), notAfterMonotonicNs: '0001'},
    {...release(), notAfterMonotonicNs: 1000}, {...release(), notAfterMonotonicNs: '9223372036854775808'},
    {...release(), extra: true}];
  for (const value of invalid) {
    const f = fixture(), run = await f.backend.reserve(request);
    f.resolveReady(); await run.ready;
    assert.equal(run.start(value as LinuxContainmentRelease), false);
    assert.equal(run.start(release()), false, 'a rejected release cannot be repaired or retried');
    assert.equal(f.counts.starts, 0); assert.equal(f.counts.seals, 1);
    await run.forceKill();
    assert.equal(f.counts.kills, 1, 'release failure preserves the cleanup capability');
  }
});

test('reservation rejects missing or malformed operation bindings before spawn', async () => {
  for (const releaseBinding of [undefined, '', 'a'.repeat(63), 'A'.repeat(64), '../run']) {
    const f = fixture();
    await assert.rejects(f.backend.reserve({...request, releaseBinding: releaseBinding as string}), /release binding/u);
    assert.equal(f.counts.spawned, 0);
  }
});

test('sealing invalidates a delayed start and requires guardian acknowledgement before an empty proof', async () => {
  const f = fixture(), run = await f.backend.reserve(request);
  run.seal(); f.observeEmpty(); f.resolveReady(); await run.ready;
  assert.equal(run.start(release()), false);
  assert.equal(await run.empty(), false);
  await assert.rejects(run.completionProof(), /not empty/u);
  f.acknowledgeSeal(); assert.equal(await run.empty(), true);
  assert.equal(await f.backend.verifyCompletion(run.registration, await run.completionProof()), true);
});

test('only retained sealed empty proof authorizes completion and durable CLEAN precedes retirement', async () => {
  const f = fixture(), run = await f.backend.reserve(request);
  f.resolveReady(); await run.ready; run.start(release());
  const forged = {admissionSealed: true, populated: 0, objectIdentity: run.registration.objectIdentity};
  assert.equal(await f.backend.verifyCompletion(run.registration, forged), false);
  await run.forceKill();
  assert.equal(f.counts.kills, 1);
  const proof = await run.completionProof();
  assert.equal(await f.backend.verifyCompletion(run.registration, {...proof as object}), false);
  assert.equal(await f.backend.verifyCompletion(run.registration, proof), true);
  await assert.rejects(run.retire(() => false), /durable CLEAN/u);
  assert.equal(f.counts.retired, 0);
  await run.retire(() => true); assert.equal(f.counts.retired, 1);
  assert.equal(await f.backend.verifyCompletion(run.registration, proof), false);
  await assert.rejects(run.forceKill(), /retired capability/u);
});

test('denied cgroup kill does not establish emptiness or retire the obligation', async () => {
  const f = fixture(), run = await f.backend.reserve(request);
  f.denyKill(); await assert.rejects(run.forceKill(), /EPERM/u);
  assert.equal(await run.empty(), false);
  await assert.rejects(run.completionProof(), /not empty/u);
  assert.equal(f.counts.retired, 0);
});

test('revoked generation cannot release a delayed start or signal the retained endpoint', async () => {
  const f = fixture(), run = await f.backend.reserve(request);
  f.resolveReady(); await run.ready; f.revoke();
  assert.equal(run.start(release()), false);
  await assert.rejects(run.forceKill(), /owner was revoked/u);
  assert.equal(f.counts.kills, 0);
  assert.equal(await f.backend.verifyRegistration(run.registration), false);
});

test('namespace and run replacement invalidate registration and completion even with matching serialized fields', async () => {
  for (const replace of ['replaceObject', 'replaceNamespace'] as const) {
    const f = fixture(), run = await f.backend.reserve(request);
    await run.forceKill(); const proof = await run.completionProof(); f[replace]();
    assert.equal(await f.backend.verifyRegistration({...run.registration}), false);
    assert.equal(await f.backend.verifyCompletion(run.registration, proof), false);
    await assert.rejects(run.retire(() => true));
    assert.equal(f.counts.retired, 0);
  }
});

test('restart reopens original registration for cleanup with no child or start authority', async () => {
  const f = fixture(), initial = await f.backend.reserve(request);
  f.resolveReady(); await initial.ready; initial.start(release());
  const restarted = containmentBackendForNamespace(f.context, f.namespace), run = await restarted.reopen({...initial.registration});
  assert.equal('child' in run, false); assert.equal('start' in run, false);
  assert.equal(await restarted.verifyRegistration(run.registration), true);
  await run.forceKill(); const proof = await run.completionProof();
  assert.equal(await restarted.verifyCompletion(run.registration, proof), true);
  await run.retire(() => true);
  assert.equal(f.counts.starts, 1); assert.equal(f.counts.spawned, 1);
});

test('missing or replaced restart object is never recreated and namespace mismatch is refused', async () => {
  const f = fixture();
  await assert.rejects(f.backend.reopen(f.registration), /missing or replaced/u);
  assert.equal(f.counts.spawned, 0);
  await f.backend.reserve(request); f.replaceObject();
  const restarted = containmentBackendForNamespace(f.context, f.namespace);
  await assert.rejects(restarted.reopen(f.registration), /missing or replaced/u);
  await assert.rejects(restarted.reopen({...f.registration, namespaceId: 'e2d9cda5-c5c0-4076-a02c-948d26e84062'}), /continuity/u);
});

test('retired names remain reserved across backend restarts', async () => {
  const f = fixture(), run = await f.backend.reserve(request);
  await run.forceKill(); await run.completionProof(); await run.retire(() => true);
  const restarted = containmentBackendForNamespace(f.context, f.namespace);
  await assert.rejects(restarted.reserve(request), /EEXIST/u);
  assert.equal(f.counts.spawned, 1);
});

test('sandbox mounts only the approved runtime, generated configuration, work and private tmp', () => {
  const work = `/var/lib/mdai/runs/${incarnation}/work`, data = `/var/lib/mdai/runs/${incarnation}`;
  const args = linuxSandboxArguments(work, data);
  assert.equal(args.filter(argument => argument === '--bind').length, 1);
  assert.deepEqual(args.slice(args.indexOf('--bind'), args.indexOf('--bind') + 3), ['--bind', work, '/work']);
  for (const flag of ['--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-cgroup', '--disable-userns', '--assert-userns-disabled']) assert.ok(args.includes(flag));
  assert.ok(!args.includes('--preserve-fds'), 'bubblewrap 0.9.0 transports the private bootstrap channel through stdin');
  assert.match(LINUX_GUARDIAN, /stdin=peer, close_fds=True/u);
  assert.match(LINUX_INNER_LAUNCHER, /os\.dup2\(0, 3, inheritable=False\)/u);
  assert.deepEqual(args.slice(args.indexOf('--') + 1, args.indexOf('--') + 5), [LINUX_CONTAINMENT_PATHS.python, '-I', '-S', '-c']);
  assert.ok(!args.includes('--new-session'), 'guardian original process group is retained');
  for (const forbidden of ['/home', '/run/user', '/sys/fs/cgroup', '/etc', '/proc', '/var/lib/mdai']) {
    const mounts = args.flatMap((value, index) => ['--bind', '--ro-bind'].includes(value) ? [args[index + 1]] : []);
    assert.ok(!mounts.includes(forbidden), forbidden);
  }
  assert.equal(LINUX_CONTAINMENT_PATHS.node, '/usr/local/libexec/mdai/node');
});

test('pasta DNS argv retains the native verified forwarding without an explicit upstream', () => {
  const prefix = LINUX_GUARDIAN.match(/subprocess\.Popen\(\[pasta,([\s\S]*?)\s*'--netns',/u);
  assert.ok(prefix, 'inspect the production pasta argv before its retained namespace descriptors');
  assert.deepEqual([...prefix[1].matchAll(/'([^']*)'/gu)].map(match => match[1]), [
    '--foreground', '--config-net', '--no-map-gw',
    '-t', 'none', '-u', 'none', '-T', 'none', '-U', 'none',
    '--dns-forward', [169, 254, 1, 1].join('.'),
  ]);
  assert.doesNotMatch(LINUX_GUARDIAN, /'--dns'/u, 'explicit stub DNS failed native public-name resolution');
});

test('sandbox argument construction rejects arbitrary host mounts and noncanonical or mismatched run paths', () => {
  const data = `/var/lib/mdai/runs/${incarnation}`;
  for (const [work, path] of [
    ['/home/mdai', data], ['/tmp/work', data], [data + '/work', '/tmp/run'],
    [data + '/work', '/home/mdai'], [data + '/../' + incarnation + '/work', data],
    [data + '/work', data + '/.'], [data + '/work\0', data],
    [data + '/work', '/var/lib/mdai/runs/3d96eda7-95f4-4ca1-af2f-f3acfe9b5cce'],
  ]) assert.throws(() => linuxSandboxArguments(work, path), /mount source/u);
});

test('packaged guardian authority shape has only self-group TERM and retained namespace transport', () => {
  assert.equal((LINUX_GUARDIAN.match(/os\.kill\(/gu) ?? []).length, 1);
  assert.match(LINUX_GUARDIAN, /os\.kill\(0, signal\.SIGTERM\)/u);
  assert.match(LINUX_GUARDIAN, /os\.write\(3, b'0\\n'\)/u);
  assert.match(LINUX_GUARDIAN, /\(4, 0\)/u, 'guardian is nondumpable');
  assert.match(LINUX_GUARDIAN, /SCM_RIGHTS/u);
  assert.match(LINUX_GUARDIAN, /'--no-map-gw'/u);
  assert.match(LINUX_GUARDIAN, /'-t', 'none', '-u', 'none', '-T', 'none', '-U', 'none'/u);
  assert.equal((LINUX_INNER_LAUNCHER.match(/os\.execve\(/gu) ?? []).length, 2, 'only the provider and original workload task may exec');
  const provider = LINUX_INNER_LAUNCHER.match(/def provider_exec\([^\n]+\):\n([\s\S]*?)\ndef provider_http/u)?.[1];
  assert.ok(provider, 'review the separate provider exec boundary');
  assert.match(provider, /final_admission\(status, release, expected\)\n {4}os\.execve\(spec\['executable'\]/u,
    'provider expiry and queued cancellation are checked immediately before provider exec');
  assert.ok(provider.indexOf('close_except({status.fileno()})') < provider.indexOf('final_admission(status, release, expected)'));
  assert.ok(provider.indexOf('os.set_inheritable(status.fileno(), False)') < provider.indexOf('os.execve'));
  assert.ok(provider.indexOf('os.chdir') < provider.indexOf('final_admission(status, release, expected)'));
  const workload = LINUX_INNER_LAUNCHER.slice(LINUX_INNER_LAUNCHER.lastIndexOf("os.chdir(launch['cwd'])"));
  assert.match(workload, /provider_final_admission\(provider_descriptors\)\n {4}final_admission\(channel, release_line, expected_release\)\n {4}try:\n {8}os\.execve\(launch\['file'\]/u,
    'OpenCode rechecks provider status, expiry and queued cancellation immediately before its own exec');
  assert.ok(workload.indexOf('os.chdir') < workload.lastIndexOf('final_admission(channel, release_line, expected_release)'));
  assert.ok(LINUX_INNER_LAUNCHER.indexOf('os.set_inheritable(3, False)') < LINUX_INNER_LAUNCHER.indexOf("os.chdir(launch['cwd'])"));
});

test('native production backend fails closed outside the provisioned mdai unit', async t => {
  if (process.getuid?.() !== 0 && process.env.USER === 'mdai') {t.skip('dedicated fixture host requires explicit native acceptance'); return;}
  const f = fixture(); await assert.rejects(createLinuxContainmentBackend(f.context), {code: 'LINUX_CONTAINMENT_UNAVAILABLE'});
});


test('CLEAN crash housekeeping requires exact completed provenance and never opens a signal capability', async () => {
  const f = fixture();
  await assert.rejects(f.backend.retireCompleted(f.registration), /durable CLEAN provenance/u);
  f.markDurablyClean();
  await f.backend.retireCompleted(f.registration); // The completed cgroup is already absent.
  assert.deepEqual(f.counts, {starts: 0, seals: 0, kills: 0, retired: 1, spawned: 0});
  await assert.rejects(f.backend.retireCompleted({...f.registration, objectIdentity: '12:99'}), /durable CLEAN provenance/u);
});

test('CLEAN housekeeping refuses a replaced or repopulated object without signaling it', async () => {
  const f = fixture(); await f.backend.reserve(request); f.markDurablyClean();
  await assert.rejects(f.backend.retireCompleted(f.registration), /still populated/u);
  f.observeEmpty(); f.replaceObject();
  await assert.rejects(f.backend.retireCompleted(f.registration), /replaced/u);
  assert.equal(f.counts.kills, 0); assert.equal(f.counts.retired, 0);
});

test('receipt storage failure preserves the original TERM and retained KILL capability but refuses completion', async () => {
  const f = fixture(), run = await f.backend.reserve(request); f.resolveReady(); await run.ready;
  f.failStorage(); await run.term(); await run.forceKill();
  assert.equal(f.terms, 1); assert.equal(f.counts.kills, 1);
  await assert.rejects(run.completionProof(), /EIO protected receipt/u);
  assert.equal(await f.backend.verifyRegistration(run.registration), false);
  assert.equal(f.counts.retired, 0);
});

test('credential removal precedes completion proof and failure prevents CLEAN authority', async () => {
  const f = fixture(), run = await f.backend.reserve(request); await run.forceKill();
  f.failCredentialCleanup(); await assert.rejects(run.completionProof(), /credential cleanup failed/u);
  assert.equal(f.prepared, 0); assert.equal(f.counts.retired, 0);
  await assert.rejects(run.retire(() => true), /durable CLEAN/u);
});

test('namespace close refuses unresolved capabilities and revokes all admission after clean retirement', async () => {
  const f = fixture(), run = await f.backend.reserve(request);
  await assert.rejects(f.backend.close(), /unresolved run capabilities/u); assert.equal(f.closed, false);
  await run.forceKill(); await run.completionProof(); assert.equal(f.prepared, 1);
  await run.retire(() => true); await f.backend.close(); assert.equal(f.closed, true);
  await assert.rejects(f.backend.reserve(request), /capability is closed/u);
});

test('unsafe runtime qualification blocks all new launches without disabling registered recovery cleanup', async () => {
  const absent = fixture(); absent.denyAdmission();
  await assert.rejects(absent.backend.qualifyAdmission!(), /unsafe runtime mount/u);
  await assert.rejects(absent.backend.reserve(request), /unsafe runtime mount/u);
  assert.equal(absent.counts.spawned, 0);
  const f = fixture(), live = await f.backend.reserve(request); f.denyAdmission();
  const restarted = containmentBackendForNamespace(f.context, f.namespace);
  const recovery = await restarted.reopen(live.registration);
  await recovery.forceKill(); await recovery.completionProof(); await recovery.retire(() => true);
  assert.equal(f.counts.kills, 1); assert.equal(f.counts.retired, 1); assert.equal(f.counts.spawned, 1);
});

function runtimeFixture() {
  type Entry = {kind: 'directory' | 'file' | 'link' | 'socket' | 'fifo' | 'device'; uid?: number; mode?: number; target?: string};
  const entries = new Map<string, Entry>([
    ['/usr', {kind: 'directory'}], ['/usr/bin', {kind: 'directory'}], ['/usr/bin/node', {kind: 'file'}],
    ['/etc/ssl/certs', {kind: 'directory'}], ['/etc/ssl/certs/ca.pem', {kind: 'file'}],
    ['/usr/cert.pem', {kind: 'link', target: '/etc/ssl/certs/ca.pem'}],
  ]);
  let mountInfo = '1 0 8:1 / / rw - ext4 /dev/root rw\n';
  const io: LinuxRuntimeTreeIO = {
    async lstat(path) {
      const entry = entries.get(path); assert.ok(entry, path);
      return {dev: 1, ino: [...entries.keys()].indexOf(path) + 1, uid: entry.uid ?? 0, mode: entry.mode ?? 0o755,
        size: 1, mtimeMs: 1, ctimeMs: 1, isDirectory: () => entry.kind === 'directory', isFile: () => entry.kind === 'file',
        isSymbolicLink: () => entry.kind === 'link'} as Stats;
    },
    async readdir(path) {return [...entries.keys()].filter(name => dirname(name) === path).map(name => name.slice(path.length + 1));},
    async realpath(path) {return entries.get(path)?.target ?? path;},
    async mountInfo() {return mountInfo;},
  };
  return {io, entries, mount(value: string) {mountInfo = value;}};
}

test('runtime qualification accepts only protected regular runtime objects and internal certificate aliases', async () => {
  const fixture = runtimeFixture(); await qualifyLinuxRuntimeMounts(fixture.io);
});

test('read-only runtime qualification rejects management sockets, devices, FIFOs and writable or foreign-owned descendants', async () => {
  for (const hostile of [{kind: 'socket'}, {kind: 'fifo'}, {kind: 'device'}, {kind: 'file', mode: 0o666},
    {kind: 'directory', mode: 0o777}, {kind: 'file', uid: 999}] as const) {
    const fixture = runtimeFixture(); fixture.entries.set('/usr/bin/management', hostile);
    await assert.rejects(qualifyLinuxRuntimeMounts(fixture.io), /runtime contains/u);
  }
});

for (const {path, entry, reason} of [
  {path: '/usr/local/share/fonts', entry: {kind: 'directory', mode: 0o2775}, reason: 'a writable or special object'},
  {path: '/usr/local/bin/dib-init-system', entry: {kind: 'file', mode: 0o775}, reason: 'a writable or special object'},
  {path: '/usr/bin/foreign-owner', entry: {kind: 'file', uid: 999}, reason: 'an untrusted owner'},
  {path: '/usr/bin/control.sock', entry: {kind: 'socket'}, reason: 'a writable or special object'},
  {path: '/usr/bin/control.fifo', entry: {kind: 'fifo'}, reason: 'a writable or special object'},
  {path: '/usr/bin/control.device', entry: {kind: 'device'}, reason: 'a writable or special object'},
] as const) {
  test(`runtime refusal identifies the offending path ${path}`, async () => {
    const fixture = runtimeFixture();
    for (let parent = dirname(path); parent !== '/usr'; parent = dirname(parent)) {
      fixture.entries.set(parent, {kind: 'directory'});
    }
    fixture.entries.set(path, entry);
    await assert.rejects(qualifyLinuxRuntimeMounts(fixture.io), {
      code: 'LINUX_CONTAINMENT_UNAVAILABLE',
      message: `Linux run containment is unavailable: runtime contains ${reason} at ${path}.`,
    });
  });
}

test('runtime links resolve inside the sandbox and do not traverse absent host management paths', async () => {
  const fixture = runtimeFixture(); fixture.entries.set('/usr/bin/management', {kind: 'link', target: '/run/user/999/control.sock'});
  fixture.io.realpath = async path => {assert.ok(['/usr', '/etc/ssl/certs'].includes(path), 'never follow a host link target'); return path;};
  await qualifyLinuxRuntimeMounts(fixture.io);
  fixture.entries.set('/usr/bin/management', {kind: 'link', target: '/run/user/999/control.sock', uid: 999});
  await assert.rejects(qualifyLinuxRuntimeMounts(fixture.io), /untrusted owner/u);
});

test('runtime qualification rejects nested mounts and management filesystems', async () => {
  const fixture = runtimeFixture();
  fixture.mount('1 0 8:1 / / rw - ext4 /dev/root rw\n2 1 0:1 / /usr/bin/mgmt rw - tmpfs tmpfs rw\n');
  await assert.rejects(qualifyLinuxRuntimeMounts(fixture.io), /nested mount/u);
  fixture.mount('1 0 8:1 / / rw - ext4 /dev/root rw\n2 1 0:1 / /usr rw - cgroup2 cgroup rw\n');
  await assert.rejects(qualifyLinuxRuntimeMounts(fixture.io), /management filesystem/u);
});

test('runtime qualification rejects a mount inventory changed while the tree was being inspected', async () => {
  const fixture = runtimeFixture(), original = fixture.io.readdir;
  fixture.io.readdir = async path => {const names = await original(path); fixture.mount('1 0 8:1 / / ro - ext4 /dev/root ro\n'); return names;};
  await assert.rejects(qualifyLinuxRuntimeMounts(fixture.io), /inventory changed/u);
});

test('isolated environment accepts only the exact disabled Grok import switches and never ambient secrets', () => {
  const keys = [
    ...['CLAUDE', 'CURSOR', 'CODEX'].flatMap(source => ['MCPS', 'SKILLS', 'RULES', 'AGENTS', 'HOOKS', 'SESSIONS'].map(kind => `GROK_${source}_${kind}_ENABLED`)),
    'GROK_MANAGED_MCPS_ENABLED', 'GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED',
  ];
  const env = Object.fromEntries(keys.map(key => [key, 'false']));
  assert.equal(Object.keys(env).length, 20);
  const cleaned = cleanLinuxToolEnvironment(env, '/fixture/work');
  for (const key of keys) {assert.equal(cleaned[key], 'false'); assert.throws(() => cleanLinuxToolEnvironment({[key]: 'true'}, '/fixture/work'), /not approved/u);}
  for (const key of ['GROK_OTHER_ENABLED', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'NODE_OPTIONS', 'SSH_AUTH_SOCK']) {
    assert.throws(() => cleanLinuxToolEnvironment({[key]: 'false'}, '/fixture/work'), /not approved/u);
  }
});
