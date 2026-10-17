import assert from 'node:assert/strict';
import {generateKeyPairSync, randomUUID} from 'node:crypto';
import {chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {deviceKeyFingerprint, RUNNER_HEADERS, verifyRunnerRequest} from '../src/shared/runner-protocol.js';
import {runCli, type CliOptions} from '../src/cli.js';
import {CommandError, readConfig, type Runner, type Timing} from '../src/config.js';
import {atomicWrite, createPaths, ensurePaths, ensurePrivateDirectory} from '../src/paths.js';
import {RunsRuntime} from '../src/runner/cli-runs.js';
import {RunsOnController} from '../src/runner/runs-on.js';
import type {RuntimeContext} from '../src/runtime.js';
import {KeychainSecretStore} from '../src/secret-store.js';
import {StateStore} from '../src/state.js';

const wait = () => new Promise<void>(resolve => setTimeout(resolve, 5));
async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !predicate(); attempt++) await wait();
  assert(predicate(), 'Timed out waiting for the activation request.');
}
async function fixture(t: TestContext, active = false) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-service-runs-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const home = join(root, 'home'), binDir = join(root, 'bin');
  await mkdir(home, {mode: 0o700}); await mkdir(binDir, {mode: 0o700});
  const bin = join(binDir, 'codex'); await writeFile(bin, '#!/bin/sh\nexit 0\n'); await chmod(bin, 0o755);
  const env = {PATH: binDir}, config = readConfig(env, home), paths = await createPaths(config); await ensurePaths(paths);
  const token = 'mdai_skill_' + 'S'.repeat(43), helperId = randomUUID(), aiToolId = randomUUID(), deviceKeyId = randomUUID(), agentId = randomUUID();
  const items = new Map<string, string>(), keychainWrites: string[] = [], dialogs: string[] = [], output: string[] = [];
  const runner: Runner = async (file, args, options) => {
    if (file === '/usr/sbin/scutil') return {stdout: 'Service-Test-Mac\n', stderr: ''};
    if (file === '/usr/bin/osascript') {dialogs.push(args.join('\n')); return {stdout: 'button returned:Later, gave up:false', stderr: ''};}
    if (file === bin) return {stdout: args.includes('--version') ? 'codex-cli 1.0.0\n' : '', stderr: ''};
    assert.equal(file, '/usr/bin/security');
    assert(!args.some(value => value.includes(token) || value.includes('"format"')));
    if (args[0] === '-i') {
      const match = / -a ("(?:[^"\\]|\\.)*") -w ("(?:[^"\\]|\\.)*")\n$/.exec(options?.input ?? ''); assert(match);
      const value = JSON.parse(match[2]) as string;
      items.set(JSON.parse(match[1]), value); keychainWrites.push(value); return {stdout: '', stderr: ''};
    }
    const account = args[args.indexOf('-a') + 1];
    if (args[0] === 'delete-generic-password') {items.delete(account); return {stdout: '', stderr: ''};}
    if (!items.has(account)) throw new CommandError(44);
    return {stdout: items.get(account)! + '\n', stderr: ''};
  };
  const secrets = new KeychainSecretStore(config.endpoint, paths.data, runner, env);
  await secrets.set('skills-token', token);
  let now = Date.now();
  const startedAt = now, grantExpiresAt = new Date(now + 600_000).toISOString();
  const state = new StateStore(paths, config.endpoint);
  await state.write({format: 1, endpoint: config.endpoint.href, helperId, status: 'connected', scopes: ['sync', 'run_claim'],
    tokenStorage: 'keychain', pendingTools: [], connections: [{id: aiToolId, tool: 'codex', variant: 'cli'}],
    tools: [{tool: 'codex', variant: 'cli', version: '1.0.0', models: [], syncOnly: false, path: bin, realpath: bin}]});
  const registrations: Record<string, unknown>[] = [], results: Record<string, unknown>[] = [], statusTimes: number[] = [], heartbeats: unknown[] = [];
  let publicKey = '';
  const agent = {agentId, name: 'Service agent', handle: 'service-agent', status: 'active', model: 'test-model', provider: null,
    effort: null, accessWanted: 'folder_only', maxRunMinutes: 5, skills: []};
  if (active) {
    const jwk = generateKeyPairSync('ed25519').privateKey.export({format: 'jwk'}); publicKey = jwk.x!;
    await secrets.set('device-key', JSON.stringify({format: 1, keys: {[aiToolId]: {deviceKeyId, d: jwk.d!, x: jwk.x!}}}));
    await ensurePrivateDirectory(join(paths.data, 'runner'));
    await atomicWrite(join(paths.data, 'runner', 'runs.json'), JSON.stringify({format: 1, tools: [{
      aiToolId, state: 'on', failureCode: null, deviceKeyId, toolVersion: '1.0.0', grantExpiresAt: null,
    }]}));
    // A previous service heartbeat left this disposable catalog. Notification must use it.
    await atomicWrite(join(paths.data, 'runner', 'agents-catalog.json'), JSON.stringify([{...agent, aiToolId, claimable: false}]));
  }
  let releaseResult!: () => void;
  const held = new Promise<void>(resolve => {releaseResult = resolve;});
  // Keep failure and mutation paths bounded even if shutdown waits on the fake server.
  const resultDeadline = setTimeout(() => releaseResult(), 3000);
  t.after(() => clearTimeout(resultDeadline));
  let resultAnswered = false;
  const request: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === '/api/helper/status') {
      statusTimes.push(now);
      return Response.json({data: {account: {id: 'owner-service', name: 'Service owner'}, scopes: ['sync', 'run_claim'],
        renewBy: new Date(now + 90 * 86_400_000).toISOString(), idleLapseAt: new Date(now + 30 * 86_400_000).toISOString(), pending: [],
        connections: [{id: aiToolId, tool: 'codex', variant: 'cli'}], runGrants: active || registrations.length ? [] : [{aiToolId, expiresAt: grantExpiresAt}]}});
    }
    if (path === '/api/helper/runs/device-key') {
      const body = JSON.parse(String(init?.body)); registrations.push(body); publicKey = body.publicKey;
      return Response.json({data: {deviceKeyId, fingerprint: deviceKeyFingerprint(publicKey)}});
    }
    if (path === '/api/runner/test-result' || path === '/api/runner/heartbeat') {
      const headers = new Headers(init?.headers), raw = Buffer.from(String(init?.body));
      assert.equal(headers.get('authorization'), `Bearer ${token}`);
      assert.equal(headers.get(RUNNER_HEADERS.deviceKey), deviceKeyId);
      assert(verifyRunnerRequest({method: 'POST', path, body: raw, deviceKeyId,
        timestamp: headers.get(RUNNER_HEADERS.timestamp)!, nonce: headers.get(RUNNER_HEADERS.nonce)!}, headers.get(RUNNER_HEADERS.signature)!, publicKey));
      const body = JSON.parse(raw.toString('utf8'));
      if (path === '/api/runner/heartbeat') {
        heartbeats.push(body); return Response.json({data: {heartbeatSeconds: 15, agents: [agent], claimable: [], stop: []}});
      }
      results.push(body);
      let abort!: () => void;
      try {
        await Promise.race([held, new Promise<never>((_resolve, reject) => {
          abort = () => reject(new DOMException('Aborted', 'AbortError'));
          if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener('abort', abort, {once: true});
        })]);
      } finally {init?.signal?.removeEventListener('abort', abort);}
      resultAnswered = true; return Response.json({data: {state: body.ok ? 'on' : 'failed'}});
    }
    return Response.json({error: {code: 'NOT_FOUND'}}, {status: 404});
  };
  const runtime: RuntimeContext = {bundledRoot: join(home, 'bootstrap'), bootstrapVersion: '0.1.0',
    bootstrapEntrypoint: join(home, 'bootstrap/dist/cli.js'), runningRoot: join(home, 'bootstrap')};
  const stop = new AbortController(); let serviceSleeps = 0;
  let onSleep: (tick: number) => Promise<void> = async () => {stop.abort();};
  const timing: Timing = {now: () => now, sleep: async ms => {
    if (ms < 1000) {await wait(); return;}
    now += ms; await onSleep(++serviceSleeps);
  }};
  const run = (updates?: CliOptions['updates']) => runCli(['service'], {home, env, runner, request, timing, runtime,
    signal: stop.signal, output: line => output.push(line), isTTY: false, updates, watchRoute: () => ({close() {}})});
  return {paths, aiToolId, agentId, deviceKeyId, keychainWrites, dialogs, output, registrations, results, statusTimes, heartbeats,
    startedAt, runtime, stop, releaseResult, resultAnswered: () => resultAnswered, serviceSleeps: () => serviceSleeps,
    onSleep: (value: typeof onSleep) => {onSleep = value;}, run};
}

for (const update of ['prepared', 'selected'] as const) test(`service forwards status grants and postpones a ${update} update while activation is busy`, async t => {
  const f = await fixture(t); let checks = 0;
  f.onSleep(async () => {
    assert.equal(checks, 1, 'The available update was checked during the first tick.');
    await until(() => f.results.length === 1);
    assert.equal(f.registrations.length, 1);
    f.releaseResult(); await until(f.resultAnswered); f.stop.abort();
  });
  await f.run({
    select: async () => {if (update === 'selected') checks++; return {root: update === 'selected' ? join(f.runtime.runningRoot, 'next') : f.runtime.runningRoot, version: '0.1.0'};},
    check: async () => {if (update === 'prepared') checks++; return {status: update === 'prepared' ? 'prepared' : 'current', version: '0.2.0'};},
  });
  assert.equal(f.serviceSleeps(), 1);
  assert.deepEqual(Object.keys(f.registrations[0]).sort(), ['aiToolId', 'proof', 'publicKey']);
  assert.equal(JSON.parse(f.keychainWrites.find(value => value.startsWith('{"format"'))!).keys[f.aiToolId].deviceKeyId, null);
  assert.deepEqual(f.results, [{ok: false, code: 'adapter_refused', toolVersion: '1.0.0'}]);
  const saved = JSON.parse(await readFile(join(f.paths.data, 'runner', 'runs.json'), 'utf8'));
  assert.equal(saved.tools[0].state, 'failed'); assert.equal(saved.tools[0].deviceKeyId, f.deviceKeyId);
});

test('service polls status every 60 seconds and shows the real setup notification only once per agent', async t => {
  const f = await fixture(t, true);
  f.onSleep(async tick => {if (tick === 61) f.stop.abort();});
  await f.run();
  assert.deepEqual(f.statusTimes, [f.startedAt, f.startedAt + 60_000]);
  assert.equal(f.heartbeats.length, 5);
  assert.equal(f.dialogs.length, 1);
  assert.match(f.dialogs[0], /1 agents need setup or Allow on this computer/);
  const notice = JSON.parse(await readFile(join(f.paths.data, 'agent-notification-state.json'), 'utf8'));
  assert.deepEqual(notice.notifiedAgents, [f.agentId]);
});

test('TLS-25 service backs off real .DS_Store recovery failures for 60 seconds while heartbeats continue', async t => {
  const f = await fixture(t, true);
  const directory = join(f.paths.data, 'runner', 'test-processes');
  await ensurePrivateDirectory(directory);
  const evidence = join(directory, '.DS_Store');
  await writeFile(evidence, 'kept recovery evidence', {mode: 0o600});
  const recoveryLines = () => f.output.filter(line => line === 'Test recovery unavailable this cycle (RUNNER_TEST_RECOVERY_UNAVAILABLE).');
  f.onSleep(async tick => {
    assert.equal(recoveryLines().length, tick <= 60 ? 1 : 2);
    assert.equal(f.heartbeats.length, Math.floor((tick - 1) / 15) + 1, 'Every due heartbeat survives recovery failures.');
    if (tick === 61) f.stop.abort();
  });
  await f.run();
  assert.equal(f.serviceSleeps(), 61);
  assert.equal(recoveryLines().length, 2);
  assert.equal(f.heartbeats.length, 5);
  assert.equal(await readFile(evidence, 'utf8'), 'kept recovery evidence');
});

for (const failure of ['init', 'syncGrants'] as const) test(`service still ticks the real runner when ${failure} throws, and logs codes only`, async t => {
  const f = await fixture(t, true);
  let initCalls = 0, syncCalls = 0;
  const init = RunsRuntime.prototype.init, sync = RunsOnController.prototype.syncGrants;
  const secretMessage = 'SYNTHETIC_PRIVATE_ERROR_TEXT';
  t.mock.method(RunsRuntime.prototype, 'init', async function(this: RunsRuntime) {
    initCalls++;
    if (failure === 'init') throw Object.assign(new Error(secretMessage), {code: 'RUNNER_TEST_RECOVERY_UNAVAILABLE'});
    await init.call(this);
  });
  t.mock.method(RunsOnController.prototype, 'syncGrants', async function(this: RunsOnController, grants: unknown) {
    syncCalls++;
    if (failure === 'syncGrants') throw Object.assign(new Error(secretMessage), {code: secretMessage + '\nunsafe'});
    await sync.call(this, grants);
  });
  await f.run();
  assert.equal(initCalls, 1); assert.equal(syncCalls, 1, 'Recovery failure must not skip grant synchronization.');
  assert.equal(f.heartbeats.length, 1, 'Activation failure must not skip tickRunners or its signed heartbeat.');
  assert.equal(f.output.some(line => line.includes(secretMessage)), false);
  assert(f.output.includes(failure === 'init' ? 'Test recovery unavailable this cycle (RUNNER_TEST_RECOVERY_UNAVAILABLE).' : 'Run activation unavailable this cycle (runner_failed).'));
});
