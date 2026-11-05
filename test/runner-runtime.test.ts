import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, randomUUID, sign} from 'node:crypto';
import {access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {deviceKeyFingerprint, RUNNER_HEADERS, verifyRunnerRequest} from '../src/shared/runner-protocol.js';
import {treeDigest} from '../src/shared/build-format.js';
import {LockStore} from '../src/lock.js';
import {BuildVerifier, signedBuildString, type SignedBuild} from '../src/verify.js';
import {TOOL_MATRIX} from '../src/shared/tool-matrix.js';
import {LINUX_FOLDER_ONLY_REASON} from '../src/shared/tool-capabilities.js';
import {signedRunnerAuthorizationString, type RunnerAuthorizationFields} from '../src/shared/runner-acceptance.js';
import {ApiClient} from '../src/api.js';
import {HelperError, readConfig, type Timing} from '../src/config.js';
import {atomicWrite, createPaths, ensurePaths, ensurePrivateDirectory} from '../src/paths.js';
import {RunsRuntime} from '../src/runner/cli-runs.js';
import {RunnerAcceptanceVerifier} from '../src/runner/acceptance.js';
import type {ActiveRun} from '../src/runner/state.js';
import type {RunnerAgent, RunnerHeartbeat} from '../src/runner/protocol-client.js';
import type {RunsOnSnapshot} from '../src/runner/runs-on.js';
import type {SecretName, SecretStore} from '../src/secret-store.js';
import {StateStore} from '../src/state.js';
import {RELEASE} from '../src/release-identity.js';
import {TokenManager} from '../src/token.js';
import {qualifyLinuxFixtureWithoutWorkloads} from './support/linux-native-workloads.js';
import {initializeCleanRunnerJournal} from './support/runner-journal-fixture.js';
import {acquireRunnerControllerLease, type RunnerControllerStorage} from '../src/runner/storage-lock.js';

const platformRestorations = new WeakSet<TestContext>();
const linuxHostSkip = process.platform !== 'linux' ? 'Linux journal and storage fixtures require a native Linux host.' : false;
async function fixture(t: TestContext, activation?: RunsOnSnapshot['state'], platform: 'darwin' | 'linux' = 'darwin') {
  // Legacy numeric recovery and Folder only belong to the macOS pilot.
  // Explicit Linux scenarios keep its journal and pre-launch admission rules.
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  if (!platformRestorations.has(t)) {
    platformRestorations.add(t);
    t.after(() => {Object.defineProperty(process, 'platform', descriptor);});
  }
  Object.defineProperty(process, 'platform', {...descriptor, value: platform});
  if (platform === 'linux') qualifyLinuxFixtureWithoutWorkloads(t);
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-runtime-'));
  const home = join(root, 'home'); await mkdir(home, {mode: 0o700});
  const paths = await createPaths(readConfig({MADDOTS_AI_HOME: join(root, 'data')}, home, platform));
  await ensurePaths(paths); await ensurePrivateDirectory(join(paths.data, 'runner'));
  await initializeCleanRunnerJournal(paths.data);
  const endpoint = new URL('https://ai.maddots.app'), helperId = randomUUID(), aiToolId = randomUUID();
  const deviceKeyId = randomUUID(), agentId = randomUUID(), token = 'mdai_skill_' + 'R'.repeat(43);
  const jwk = generateKeyPairSync('ed25519').privateKey.export({format: 'jwk'});
  const keyDocument = JSON.stringify({format: 1, keys: {[aiToolId]: {deviceKeyId, d: jwk.d!, x: jwk.x!}}});
  const savedSecrets = new Map<SecretName, string>([['skills-token', token], ['device-key', keyDocument]]);
  const writes: SecretName[] = [], deletions: SecretName[] = [];
  const storage = platform === 'linux' ? 'file' : 'keychain';
  const secrets: SecretStore = {storage, platform, get: async name => savedSecrets.get(name),
    set: async (name, value) => {writes.push(name); savedSecrets.set(name, value);},
    delete: async name => {deletions.push(name); savedSecrets.delete(name);}};
  const bin = await realpath(process.execPath);
  const state = new StateStore(paths, endpoint);
  await state.write({format: 1, endpoint: endpoint.href, helperId, status: 'connected', scopes: ['sync', 'run_claim'],
    tokenStorage: storage, tools: [{tool: 'codex', variant: 'cli', version: '1.0.0', models: ['test-model'], syncOnly: false, path: bin, realpath: bin}],
    pendingTools: [], connections: [{id: aiToolId, tool: 'codex', variant: 'cli'}]});
  if (activation) await atomicWrite(join(paths.data, 'runner', 'runs.json'), JSON.stringify({format: 1, tools: [{
    aiToolId, state: activation, failureCode: activation === 'failed' ? 'mcp_started' : null,
    deviceKeyId, toolVersion: '1.0.0', grantExpiresAt: null,
  }]}));
  const agent: RunnerAgent = {agentId, name: 'Runtime Agent', handle: 'runtime-agent', status: 'active', model: 'test-model',
    provider: null, effort: null, accessWanted: 'full_access', maxRunMinutes: 5, skills: []};
  let response: RunnerHeartbeat = {heartbeatSeconds: 15, agents: [agent], claimable: [], stop: []};
  let statusGrants: unknown = [];
  let heartbeatError: {code: string; status: number} | undefined;
  const notifications: string[] = [];
  let now = Date.now();
  const calls: {path: string; body: Record<string, unknown>}[] = [];
  let signingPublicKey = jwk.x!;
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === '/api/helper/status') {
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token}`);
      return Response.json({data: {account: {id: 'owner-runtime', name: 'Runtime owner'}, scopes: ['sync', 'run_claim'],
        renewBy: new Date(now + 90 * 86_400_000).toISOString(), idleLapseAt: new Date(now + 30 * 86_400_000).toISOString(),
        pending: [], connections: [{id: aiToolId, tool: 'codex', variant: 'cli'}], runGrants: statusGrants}});
    }
    if (path === '/api/helper/runs/device-key') {
      const body = JSON.parse(String(init?.body)); signingPublicKey = body.publicKey; calls.push({path, body});
      return Response.json({data: {deviceKeyId, fingerprint: deviceKeyFingerprint(body.publicKey)}});
    }
    if (path === '/api/runner/test-result') {
      calls.push({path, body: JSON.parse(String(init?.body))}); return Response.json({data: {state: 'failed'}});
    }
    assert.equal(path, '/api/runner/heartbeat', 'Runtime restoration must not register or retest an existing key.');
    const headers = new Headers(init?.headers), body = Buffer.from(String(init?.body));
    assert.equal(headers.get('authorization'), `Bearer ${token}`);
    assert.equal(headers.get(RUNNER_HEADERS.deviceKey), deviceKeyId);
    assert(verifyRunnerRequest({method: 'POST', path, body, deviceKeyId,
      timestamp: headers.get(RUNNER_HEADERS.timestamp)!, nonce: headers.get(RUNNER_HEADERS.nonce)!},
    headers.get(RUNNER_HEADERS.signature)!, signingPublicKey));
    calls.push({path, body: JSON.parse(body.toString('utf8'))});
    if (heartbeatError) return Response.json({error: {code: heartbeatError.code}}, {status: heartbeatError.status});
    return Response.json({data: response});
  };
  const matrix = structuredClone(TOOL_MATRIX);
  Object.assign(matrix.tools.find(tool => tool.key === 'codex')!.run!, {offered: true, platforms: {darwin: {accepted: true}, linux: {accepted: true}}, folderOnly: 'os-sandbox'});
  const api = new ApiClient(endpoint, fetcher);
  const timing: Timing = {now: () => now, sleep: async () => {throw new Error('Unexpected runtime sleep.');}};
  const runtimeOptions = {paths, helperId, endpoint, secrets, state, api, request: fetcher, timing, matrix,
    notify: {entrypoint: join(paths.home, 'helper.js'), runner: async (_command: string, argv: readonly string[]) => {
      notifications.push(argv.join(' ')); return {stdout: 'button returned:Later, gave up:false', stderr: '', code: 0};
    }},
    processes: {table: async () => [], fencePids: async () => [], identity: async () => null}};
  const runtime = new RunsRuntime(runtimeOptions);
  t.after(async () => {await runtime.close(); await rm(root, {recursive: true, force: true});});
  const output: string[] = [];
  const io = {isTTY: true, output: (line: string) => output.push(line), prompt: async () => {throw new Error('Unexpected prompt.');}};
  return {paths, runtime, runtimeOptions, notifications, heartbeatError: (code: string, status: number) => {heartbeatError = {code, status};}, state, api, secrets, timing, helperId, aiToolId, agentId, agent, deviceKeyId, keyDocument, savedSecrets, writes, deletions, calls, io, output,
    statusGrants: (value: unknown) => {statusGrants = value;},
    response: (value: RunnerHeartbeat) => {response = value;}, advance: (ms = 15_000) => {now += ms;}};
}

test('production protocol factories bind signed claims to the configured helper and selected connection', {skip: RELEASE && 'Source-only signing fixture.'}, async t => {
  const f = await fixture(t), server = generateKeyPairSync('ed25519');
  const raw = server.publicKey.export({type: 'spki', format: 'der'}).subarray(-32);
  const key = {keyId: createHash('sha256').update(raw).digest('hex').slice(0, 16), publicKey: raw.toString('base64')};
  const verifier = new RunnerAcceptanceVerifier({keys: [key]}), verify = verifier.verify.bind(verifier);
  t.mock.method(RunnerAcceptanceVerifier.prototype, 'verify', verify);
  const runId = randomUUID(), generation = 'a'.repeat(64), now = f.timing.now();
  let identity = {helperId: f.helperId, aiToolId: f.aiToolId};
  const request: typeof fetch = async (_input, init) => {
    const fields: RunnerAuthorizationFields = {format: 1, keyId: key.keyId, purpose: 'claim', ...identity,
      runId, generation, deviceKeyId: f.deviceKeyId, requestNonce: new Headers(init?.headers).get(RUNNER_HEADERS.nonce)!,
      issuedAt: new Date(now).toISOString(), startBy: new Date(now + 30_000).toISOString(), workloadDeadline: new Date(now + 60_000).toISOString(),
      acceptanceGrant: {scopeId: randomUUID(), scopeVersion: 1, toolKey: 'codex', platform: 'linux', expiresAt: new Date(now + 60_000).toISOString()}};
    const authorization = {...fields, signature: sign(null, Buffer.from(signedRunnerAuthorizationString(fields)), server.privateKey).toString('base64')};
    return Response.json({data: {runId, generation, authorization, token: 'pm_run_FIXTURE', expiresAt: fields.workloadDeadline,
      kind: 'assignment', agentId: f.agentId, cardId: randomUUID(), boardId: randomUUID(), commentId: null,
      model: 'test-model', provider: null, effort: null, maxRunMinutes: 1, skills: []}});
  };
  const runtime = new RunsRuntime({...f.runtimeOptions, request}); t.after(() => runtime.close());
  const [connection] = await runtime.connections(); assert.ok(connection);
  const body = {runId, access: 'full_access', toolVersion: '1.0.0'} as const;
  for (const edit of [{helperId: randomUUID()}, {aiToolId: randomUUID()}]) {
    identity = {helperId: f.helperId, aiToolId: f.aiToolId, ...edit};
    await assert.rejects(connection.protocol.claim(body), {code: 'RUN_ACCEPTANCE_INVALID'});
  }
  identity = {helperId: f.helperId, aiToolId: f.aiToolId};
  const result = await connection.protocol.claim(body); assert.ok(Object.hasOwn(result, 'acceptance')); result.api.dispose();
});

for (const platform of ['darwin', 'linux'] as const) test(`TLS-25 runtime restores an already registered key and sends signed heartbeats without registration or secret writes (${platform})`, {skip: platform === 'linux' && linuxHostSkip}, async t => {
  const f = await fixture(t, undefined, platform), connections = await f.runtime.connections();
  assert.equal(connections.length, 1); assert.equal(connections[0].deviceKeyId, f.deviceKeyId);
  assert.equal(connections[0].runsOn, true);
  await f.runtime.core.tick(); await f.runtime.catalogSettled();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].body.agents, []);
  assert.deepEqual(f.writes, []); assert.deepEqual(f.deletions, []);
  assert.equal(f.savedSecrets.get('device-key'), f.keyDocument);
  assert.equal((await f.runtime.catalog())[0].agentId, f.agentId);
});

for (const queuedActivation of [false, true]) test(`Linux service preserves a pending bootstrap key during its connection read with queued activation ${queuedActivation}`, {skip: linuxHostSkip}, async t => {
  const f = await fixture(t, undefined, 'linux');
  f.savedSecrets.delete('device-key'); f.heartbeatError('RUNS_NOT_ENABLED', 403);
  assert.deepEqual(await f.runtime.activation.snapshot(), []);
  const read = f.secrets.get.bind(f.secrets);
  let registered = false;
  let bootstrapLease: RunnerControllerStorage | undefined;
  t.mock.method(f.secrets, 'get', async (name: SecretName) => {
    if (name === 'device-key' && !registered) {
      if (queuedActivation) {
        bootstrapLease = await acquireRunnerControllerLease(f.paths.data, 'activation');
        await f.runtime.activation.syncGrants([{aiToolId: f.aiToolId, expiresAt: new Date(f.timing.now() + 60_000).toISOString()}]);
        assert.equal(f.runtime.activation.busy, true);
      }
      await atomicWrite(join(f.paths.data, 'runner', 'runs.json'), JSON.stringify({format: 1, tools: [{
        aiToolId: f.aiToolId, state: 'waiting', failureCode: null, deviceKeyId: f.deviceKeyId,
        toolVersion: '1.0.0', grantExpiresAt: null, awaitingLocalSetup: true,
      }]}));
      f.savedSecrets.set('device-key', f.keyDocument); registered = true;
    }
    return read(name);
  });
  try {
    await f.runtime.core.tick();
    assert.equal(registered, true, 'The service cycle must reach the interleaved registration.');
    assert.deepEqual(f.calls, []); assert.deepEqual(f.deletions, []);
    assert.equal(f.savedSecrets.get('device-key'), f.keyDocument);
  } finally {
    const closing = f.runtime.activation.close();
    await bootstrapLease?.release(); await closing;
  }
  const [waiting] = await f.runtime.activation.snapshot();
  assert.equal(waiting.state, 'waiting'); assert.equal(waiting.awaitingLocalSetup, true);
});

test('TLS-25 Linux diagnostics cannot enter an initialized owner with retained unresolved evidence', {skip: linuxHostSkip}, async t => {
  const f = await fixture(t, 'on', 'linux'); await f.runtime.core.init();
  const owner = f.runtime.core['owner']!, generation = f.runtime.core['ownerGeneration'];
  const runId = randomUUID();
  // Seed only a synthetic status projection. No containment run or process was
  // created, and this row must never become authority for a diagnostic.
  const row: ActiveRun = {runId, agentId: f.agentId, aiToolId: f.aiToolId, pid: 0,
    startedAt: 'synthetic-unresolved-projection', runDir: join(f.paths.home, '.maddots', 'runs', runId), phase: 'posting'};
  owner.unrecovered.set(runId, row); await owner.save(generation);
  const file = join(f.paths.data, 'runner', 'active.json'), evidence = await readFile(file, 'utf8');
  const diagnostic = t.mock.fn(async () => {});
  try {
    await assert.rejects(f.runtime.core.withToolContext(diagnostic), {code: 'RUNNER_STATE_UNAVAILABLE'});
    assert.equal(diagnostic.mock.callCount(), 0);
    assert.equal(await readFile(file, 'utf8'), evidence);
    assert.deepEqual(owner.unrecovered.get(runId), row);
  } finally {
    // Teardown owns this synthetic row, with no process or containment object.
    owner.unrecovered.delete(runId); await owner.save(generation);
  }
});

test('TLS-25 Linux diagnostics cannot enter a closed core or reuse its retired generation', {skip: linuxHostSkip}, async t => {
  const f = await fixture(t, 'on', 'linux'); await f.runtime.core.init(); await f.runtime.core.close();
  const diagnostic = t.mock.fn(async () => {});
  await assert.rejects(f.runtime.core.withToolContext(diagnostic), {code: 'RUNNER_STATE_UNAVAILABLE'});
  assert.equal(diagnostic.mock.callCount(), 0);
});

test('TLS-25 authenticated status callback forwards grants into activation without persisting them as helper state', async t => {
  const f = await fixture(t);
  const unavailableTool = randomUUID();
  const grants = [{aiToolId: unavailableTool, expiresAt: new Date(f.timing.now() + 60_000).toISOString()}];
  f.statusGrants(grants);
  const tokens = new TokenManager(f.api, f.secrets, f.state, f.timing);
  let received: unknown;
  await tokens.refreshStatus(data => {received = data.runGrants;});
  assert.deepEqual(received, grants);
  await f.runtime.activation.syncGrants(received); await f.runtime.activation.idle();
  const [activation] = await f.runtime.activation.snapshot();
  assert.equal(activation.aiToolId, unavailableTool);
  assert.equal(activation.state, 'failed'); assert.equal(activation.failureCode, 'tool_not_found');
  assert.equal(activation.deviceKeyId, f.deviceKeyId, 'A current grant authorizes registration to report discovery failure.');
  assert.equal('runGrants' in await f.state.read(), false);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1].body, {ok: false, code: 'tool_not_found', toolVersion: null});
  assert.equal(f.writes.length, 2);
});

test('TLS-25 runtime does not heartbeat a testing, waiting or failed connection and preserves its registered key', async t => {
  for (const state of ['testing', 'waiting', 'failed'] as const) {
    const f = await fixture(t, state);
    assert.deepEqual(await f.runtime.connections(), []);
    await f.runtime.core.tick(); await f.runtime.catalogSettled();
    assert.deepEqual(f.calls, []); assert.deepEqual(f.writes, []); assert.deepEqual(f.deletions, []);
    assert.equal(f.savedSecrets.get('device-key'), f.keyDocument);
  }
});

test('TLS-25 runtime catalogs actual heartbeat agents while reporting only locally confirmed access and no folders', async t => {
  const f = await fixture(t);
  await atomicWrite(join(f.paths.data, 'runner', 'agents-catalog.json'), JSON.stringify([{...f.agent, aiToolId: randomUUID(), claimable: false}]));
  const [connection] = await f.runtime.connections();
  await connection.protocol.heartbeat({helperVersion: 'test', toolVersion: '1.0.0', agents: [], running: []}); await f.runtime.catalogSettled();
  assert.equal((await f.runtime.catalog()).length, 1, 'A rebound agent replaces its disconnected old catalog binding.');
  assert.deepEqual(await f.runtime.local.read(), {}, 'A server Full access request cannot create local authorization.');
  const answers = ['', ''];
  await f.runtime.command(['agent', 'setup', f.agent.handle], {...f.io, prompt: async () => {
    assert(answers.length, 'Only folder and access selection should be prompted.'); return answers.shift()!;
  }});
  const local = (await f.runtime.local.read())[f.agentId];
  assert.equal(local.access, 'folder_only'); assert.equal(local.setupDone, true);
  await f.runtime.command(['agent', 'access', f.agent.handle, 'folder-only'], {...f.io, isTTY: false});
  await f.runtime.core.tick(); await f.runtime.catalogSettled();
  assert.deepEqual(f.calls.at(-1)!.body.agents, [{agentId: f.agentId, access: 'folder_only'}]);
  const sent = JSON.stringify(f.calls);
  assert(!sent.includes(local.folder)); assert(!sent.includes(f.paths.data));
  assert(!sent.includes('accessWanted')); assert(!sent.includes('runtime-agent'));
  assert.equal((await f.runtime.local.read())[f.agentId].access, 'folder_only');
  const catalogFile = join(f.paths.data, 'runner', 'agents-catalog.json');
  const catalog = JSON.parse(await readFile(catalogFile, 'utf8'));
  assert.equal(catalog[0].aiToolId, f.aiToolId); assert.equal(catalog[0].accessWanted, 'full_access');
  assert(!JSON.stringify(catalog).includes(local.folder));
  assert.equal((await lstat(catalogFile)).mode & 0o777, 0o600);
  // A disposable catalog can be rebuilt by the next successful real heartbeat.
  await atomicWrite(catalogFile, 'broken JSON'); f.advance(); await f.runtime.core.tick(); await f.runtime.catalogSettled();
  assert.equal((await f.runtime.catalog())[0].agentId, f.agentId);
  assert(f.output.some(line => line.includes('maddots-ai allow')));
});

test('TLS-25 runtime CLI rejects unsafe command forms and displays persisted and immediate test failure codes', async t => {
  const f = await fixture(t, 'failed');
  for (const argv of [['runs', '--yes'], ['runs', 'test', 'codex', '--yes'], ['runs', 'test', 'codex', '--model'],
    ['agent', 'setup', '--yes'], ['agent', 'access', 'runtime-agent', 'full', '--yes']]) {
    await assert.rejects(f.runtime.command(argv, f.io), {code: 'USAGE'});
  }
  for (const argv of [['agent', 'setup'], ['agent', 'access', 'runtime-agent', 'full']]) {
    await assert.rejects(f.runtime.command(argv, {...f.io, isTTY: false}), {code: 'AGENT_TTY_REQUIRED'});
  }
  await f.runtime.command(['runs'], f.io);
  assert.equal(f.output.at(-1), 'codex: failed (mcp_started)');
  let called: {id: string; model?: string} | undefined;
  f.runtime.activation.testConnection = async (id, options) => {
    called = {id, model: options?.model}; return {ok: false, code: 'output_empty', toolVersion: '1.0.0'};
  };
  await f.runtime.command(['runs', 'test', 'codex', '--model', 'selected-model'], f.io);
  assert.deepEqual(called, {id: f.aiToolId, model: 'selected-model'});
  assert(f.output.includes('codex test: output_empty.'));
  assert.equal(f.output.at(-1), 'codex: failed (mcp_started)');
  assert.deepEqual(f.calls, []); assert.deepEqual(f.deletions, []);
});

test('TLS-25 runtime revisits test recovery after startup for a later crashed CLI diagnostic', async t => {
  const f = await fixture(t); await f.runtime.init();
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'maddots-ai-test-')));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  const ledger = join(f.paths.data, 'runner', 'test-processes', f.aiToolId + '.json');
  await atomicWrite(ledger, JSON.stringify({format: 1, aiToolId: f.aiToolId, cwd, fence: 'b'.repeat(32), pid: 0, startedAt: '', groups: []}));
  for (let index = 0; index < 3; index++) f.advance();
  await f.runtime.init(); await access(ledger);
  f.advance(); await f.runtime.init();
  await assert.rejects(access(ledger), {code: 'ENOENT'});
  await assert.rejects(access(cwd), {code: 'ENOENT'});
});

test('TLS-25 failed ledger recovery backs off for 60 seconds while signed heartbeats continue and evidence stays intact', async t => {
  const f = await fixture(t, 'on');
  const cwd = await mkdtemp(join(await realpath(tmpdir()), 'maddots-ai-test-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  assert.equal((await lstat(cwd)).mode & 0o777, 0o700);
  const marker = join(cwd, 'recovery-evidence'); await writeFile(marker, 'preserve this test folder', {mode: 0o600});
  const ledger = join(f.paths.data, 'runner', 'test-processes', f.aiToolId + '.json');
  const saved = JSON.stringify({format: 1, aiToolId: f.aiToolId, cwd, fence: 'c'.repeat(32), pid: 0, startedAt: '', groups: []}) + '\n';
  await ensurePrivateDirectory(join(f.paths.data, 'runner', 'test-processes')); await atomicWrite(ledger, saved);
  const started = f.timing.now(), cap = 20_000, errors: number[] = [], heartbeats: number[] = [];
  const inspections: {attempt: number; began: number; ended: number}[] = [];
  let cleanupNow = started;
  // Keep the service's existing clock for its backoff and signed heartbeats.
  // Each failed inspection consumes five seconds of the cleanup clock so its
  // retry cap is exercised without waiting twenty real seconds per attempt.
  t.mock.method(Date, 'now', () => cleanupNow);
  f.runtimeOptions.processes.table = async () => {
    const began = Date.now(); cleanupNow += 5000;
    inspections.push({attempt: f.timing.now() - started, began, ended: Date.now()});
    throw new Error('inspection denied');
  };
  for (let tick = 0; tick <= 60; tick++) {
    if (tick) f.advance(1000);
    const began = Date.now();
    try {await f.runtime.init();}
    catch (error) {
      assert.equal((error as HelperError).code, 'RUNNER_TEST_RECOVERY_UNAVAILABLE');
      assert.equal(Date.now() - began, cap, 'persistent inspection failures use the bounded cleanup attempt');
      errors.push(f.timing.now() - started);
    }
    const before = f.calls.length;
    await f.runtime.core.tick(); await f.runtime.catalogSettled();
    for (const call of f.calls.slice(before)) {
      assert.equal(call.path, '/api/runner/heartbeat'); heartbeats.push(f.timing.now() - started);
    }
  }
  assert.deepEqual(errors, [0, 60_000]);
  assert.deepEqual([...new Set(inspections.map(inspection => inspection.attempt))], [0, 60_000],
    'no recovery attempt starts before the 60 second backoff ends');
  for (const attempt of errors) {
    const scans = inspections.filter(inspection => inspection.attempt === attempt);
    assert(scans.length > 1, 'one recovery attempt retries failed inspections');
    assert(scans.every(scan => scan.ended - scans[0].began <= cap), 'all inspections finish within the cleanup cap');
  }
  assert.deepEqual(heartbeats, [0, 15_000, 30_000, 45_000, 60_000]);
  assert.equal(await readFile(ledger, 'utf8'), saved);
  assert.equal(await readFile(marker, 'utf8'), 'preserve this test folder');
});

test('TLS-25 Linux numeric diagnostic evidence stays intact without process scans while recovery backs off and signed heartbeats continue', {skip: linuxHostSkip}, async t => {
  const f = await fixture(t, 'on', 'linux');
  const cwd = await mkdtemp(join(await realpath(tmpdir()), 'maddots-ai-test-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  const marker = join(cwd, 'recovery-evidence'); await writeFile(marker, 'retained evidence', {mode: 0o600});
  const ledger = join(f.paths.data, 'runner', 'test-processes', f.aiToolId + '.json');
  const saved = JSON.stringify({format: 1, aiToolId: f.aiToolId, cwd, fence: 'd'.repeat(32), pid: 0, startedAt: '', groups: []}) + '\n';
  await ensurePrivateDirectory(join(f.paths.data, 'runner', 'test-processes')); await atomicWrite(ledger, saved);
  let inspections = 0;
  const refuseInspection = async (): Promise<never> => {inspections++; throw new Error('A numeric ledger cannot authorize process-derived retirement.');};
  f.runtimeOptions.processes.table = refuseInspection;
  f.runtimeOptions.processes.identity = refuseInspection;
  f.runtimeOptions.processes.fencePids = refuseInspection;
  const started = f.timing.now(), failures: number[] = [];
  for (let tick = 0; tick <= 60; tick++) {
    if (tick) f.advance(1000);
    try {await f.runtime.init();}
    catch (error) {
      assert.equal((error as HelperError).code, 'RUNNER_TEST_RECOVERY_UNAVAILABLE');
      failures.push(f.timing.now() - started);
    }
    await f.runtime.core.tick(); await f.runtime.catalogSettled();
  }
  assert.deepEqual(failures, [0, 60_000]);
  assert.equal(inspections, 0, 'Legacy numeric evidence must be refused before any process observation.');
  assert.equal(f.calls.filter(call => call.path === '/api/runner/heartbeat').length, 5);
  assert.equal(await readFile(ledger, 'utf8'), saved);
  assert.equal(await readFile(marker, 'utf8'), 'retained evidence');
});

for (const platform of ['darwin', 'linux'] as const) for (const [code, status] of [['RUNS_NOT_ENABLED', 403], ['DEVICE_KEY_REVOKED', 401], ['SCOPE_MISSING', 403]] as const) {
  test(`TLS-25 runs reports off durably after heartbeat ${code}, including restart (${platform})`, {skip: platform === 'linux' && linuxHostSkip}, async t => {
    const f = await fixture(t, 'on', platform); f.heartbeatError(code, status);
    await f.runtime.core.tick();
    assert.equal(f.savedSecrets.has('device-key'), false);
    assert.deepEqual(await f.runtime.connections(), []);
    await f.runtime.command(['runs'], f.io);
    assert.equal(f.output.at(-1), 'codex: off');
    assert.equal((await f.runtime.activation.snapshot()).some(row => row.state === 'on'), false);
    const restarted = new RunsRuntime(f.runtimeOptions);
    try {await restarted.command(['runs'], f.io); assert.equal(f.output.at(-1), 'codex: off');}
    finally {await restarted.close();}
  });
}

test('TLS-25 heartbeat key loss never waits for a held activation lease and still reports off', async t => {
  const f = await fixture(t, 'on'); f.heartbeatError('RUNS_NOT_ENABLED', 403);
  const lease = join(f.paths.data, 'runner', '.activation.lock');
  await writeFile(lease, String(process.pid), {mode: 0o600, flag: 'wx'});
  try {
    const started = Date.now(); await f.runtime.core.tick(); const elapsed = Date.now() - started;
    assert(elapsed < 1000, `Key loss waited ${elapsed} ms for the activation lease.`);
    assert.equal(f.savedSecrets.has('device-key'), false);
    assert.equal(await readFile(lease, 'utf8'), String(process.pid));
    const saved = JSON.parse(await readFile(join(f.paths.data, 'runner', 'runs.json'), 'utf8'));
    assert.equal(saved.tools[0].state, 'on', 'A held activation lease prevents the durable row update.');
  } finally {await rm(lease, {force: true});}
  await f.runtime.command(['runs'], f.io);
  assert.equal(f.output.at(-1), 'codex: off'); assert.deepEqual(await f.runtime.connections(), []);
});

test('TLS-25 missing or replaced key displays off, while unreadable keys and activation failures keep their state', async t => {
  for (const kind of ['missing', 'replaced', 'unreadable', 'failed'] as const) {
    const f = await fixture(t, kind === 'failed' ? 'failed' : 'on');
    if (kind === 'replaced') {
      const document = JSON.parse(f.keyDocument); document.keys[f.aiToolId].deviceKeyId = randomUUID();
      f.savedSecrets.set('device-key', JSON.stringify(document));
    } else f.savedSecrets.delete('device-key');
    if (kind === 'unreadable') f.secrets.get = async () => {throw new HelperError('SECRET_STORE_FAILED', 'fixture');};
    await f.runtime.command(['runs'], f.io);
    assert.equal(f.output.at(-1), kind === 'failed' ? 'codex: failed (mcp_started)' : kind === 'unreadable' ? 'codex: on' : 'codex: off');
  }
});

async function catalogAgents(f: Awaited<ReturnType<typeof fixture>>, agents: RunnerAgent[]) {
  f.response({heartbeatSeconds: 15, agents, claimable: [], stop: []});
  const [connection] = await f.runtime.connections();
  await connection.protocol.heartbeat({helperVersion: 'test', toolVersion: '1.0.0', agents: [], running: []});
  await f.runtime.catalogSettled();
}
async function fullSetup(f: Awaited<ReturnType<typeof fixture>>, handle: string) {
  const answers = ['', 'full', 'full', '', 'full', 'full'];
  await f.runtime.command(['agent', 'setup', handle], {...f.io, prompt: async () => answers.shift()!});
}
for (const scenario of ['duplicate workspaces', 'renamed agent', 'reused handle'] as const) {
  test(`TLS-25 access lowers by selected agent identity with ${scenario}, without confirmation`, async t => {
    const f = await fixture(t, 'on', 'darwin'), other = {...f.agent, agentId: randomUUID()};
    await catalogAgents(f, scenario === 'duplicate workspaces' ? [f.agent, other] : [f.agent]);
    await fullSetup(f, f.agent.handle);
    let selected = f.agent;
    if (scenario === 'renamed agent') {
      selected = {...f.agent, handle: 'renamed'}; await catalogAgents(f, [selected]);
    } else if (scenario === 'reused handle') {
      selected = other; await catalogAgents(f, [other]); await fullSetup(f, other.handle);
    }
    await f.runtime.command(['agent', 'access', selected.handle, 'folder-only'], {...f.io, isTTY: false});
    const rows = await f.runtime.local.read();
    assert.equal(rows[selected.agentId].access, 'folder_only');
    assert.equal(rows[selected.agentId].handle, selected.handle);
    if (scenario === 'duplicate workspaces') assert.equal(rows[other.agentId].access, 'folder_only');
    if (scenario === 'reused handle') assert.equal(rows[f.agentId].access, 'full_access', 'Stale local authorization is not pruned or modified.');
  });
}

test('TLS-25 Linux Codex access refuses Folder only and preserves confirmed Full access', {skip: linuxHostSkip}, async t => {
  const f = await fixture(t, 'on', 'linux');
  await catalogAgents(f, [f.agent]); await fullSetup(f, f.agent.handle);
  const saved = await readFile(f.runtime.local.file, 'utf8'), output = [...f.output];
  assert.equal((await f.runtime.local.read())[f.agentId].access, 'full_access');
  await assert.rejects(f.runtime.command(['agent', 'access', f.agent.handle, 'folder-only'], {...f.io, isTTY: false}),
    {code: 'ACCESS_UNAVAILABLE', message: LINUX_FOLDER_ONLY_REASON});
  assert.equal(await readFile(f.runtime.local.file, 'utf8'), saved);
  assert.deepEqual(f.output, output, 'Refused access must not report that local setup was saved.');
});

for (const platform of ['darwin', 'linux'] as const) test(`TLS-25 catalog contention never delays or drops heartbeat Stop and write failures preserve the answer (${platform})`, {skip: platform === 'linux' && linuxHostSkip}, async t => {
  const f = await fixture(t, 'on', platform), runId = randomUUID(), stopped: string[] = [];
  await writeFile(f.paths.lock, String(process.pid), {mode: 0o600, flag: 'wx'});
  f.response({heartbeatSeconds: 15, agents: [f.agent], claimable: [], stop: [{runId, reason: 'stop_requested'}]});
  let slept = 0;
  f.timing.sleep = async () => {slept++; f.advance(10_000);};
  f.runtime.core.stop = async (id, reason) => {stopped.push(`${id}:${reason}`);};
  await f.runtime.core.tick();
  assert.deepEqual(stopped, [`${runId}:heartbeat_stop`]);
  await f.runtime.catalogSettled();
  assert.equal(slept, 0, 'A disposable catalog must not wait for the main write lock.');
  await rm(f.paths.lock);
  await mkdir(join(f.paths.data, 'runner', 'agents-catalog.json'));
  f.advance(); await f.runtime.core.tick(); await f.runtime.catalogSettled();
  assert.equal(stopped.length, 2, 'A catalog write error must not discard Stop.');
});

for (const reason of ['setup', 'access', 'missing digest', 'missing accepted build', 'ready', 'paused'] as const) {
  test(`TLS-25 production notification counts ${reason} and reserves only actionable agents`, async t => {
    const f = await fixture(t, 'on', 'darwin');
    if (reason !== 'setup' && reason !== 'paused') {
      await catalogAgents(f, [f.agent]);
      const answers = ['', ''];
      await f.runtime.command(['agent', 'setup', f.agent.handle], {...f.io, prompt: async () => answers.shift()!});
    }
    const agent = {...f.agent, aiToolId: f.aiToolId, accessWanted: reason === 'access' ? 'full_access' : 'folder_only',
      status: reason === 'paused' ? 'paused' : 'active', claimable: reason.startsWith('missing'),
      skills: reason.startsWith('missing') ? [{skillId: randomUUID(), name: 'missing', version: 1, settingsRevision: 0,
        digest: reason === 'missing digest' ? null : 'a'.repeat(64), hasCode: false}] : []};
    await atomicWrite(join(f.paths.data, 'runner', 'agents-catalog.json'), JSON.stringify([agent]));
    await f.runtime.notifySetup();
    // close awaits the outstanding dialog without invoking real platform tools.
    await f.runtime.close();
    assert.equal(f.notifications.length, ['ready', 'paused'].includes(reason) ? 0 : 1);
    if (f.notifications.length) assert.match(f.notifications[0], /1 agents need setup/);
    if (reason === 'paused') {
      await assert.rejects(access(join(f.paths.data, 'agent-notification-state.json')), {code: 'ENOENT'});
      f.advance(4 * 60 * 60_000 + 1);
      await atomicWrite(join(f.paths.data, 'runner', 'agents-catalog.json'), JSON.stringify([{...agent, status: 'active'}]));
      const restarted = new RunsRuntime(f.runtimeOptions);
      try {await restarted.notifySetup();} finally {await restarted.close();}
      assert.equal(f.notifications.length, 1); assert.match(f.notifications[0], /1 agents need setup/);
    }
  });
}


test('TLS-25 production notification counts a claimable accepted code build still waiting for exact Allow', async t => {
  const f = await fixture(t, 'on', 'darwin'); await catalogAgents(f, [f.agent]);
  const answers = ['', ''];
  await f.runtime.command(['agent', 'setup', f.agent.handle], {...f.io, prompt: async () => answers.shift()!});
  const signer = generateKeyPairSync('ed25519'), publicKey = signer.publicKey.export({type: 'spki', format: 'der'}).subarray(-32);
  const keyId = createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
  const verifier = new BuildVerifier({keys: [{keyId, publicKey: publicKey.toString('base64')}], env: {}});
  const files = [
    {path: 'SKILL.md', mode: '100644' as const, content: Buffer.from('---\nname: code-skill\ndescription: Accepted code skill\n---\nUse its script.\n')},
    {path: 'scripts/run.sh', mode: '100755' as const, content: Buffer.from('#!/bin/sh\nprintf accepted\n')},
  ];
  const build: SignedBuild = {format: 1, keyId, skillId: randomUUID(), version: 1, settingsRevision: 0,
    digest: treeDigest(files), level: 'workspace', workspaceId: randomUUID(), boardId: null, target: 'folder', name: 'code-skill',
    hasCode: true, draft: false, signature: '', report: {renamedFrom: null, unresolvedOptionalReferences: [], unsetSettings: []},
    files: files.map(file => ({...file, size: file.content.length, sha256: createHash('sha256').update(file.content).digest('hex'), content: file.content.toString('base64')}))};
  build.signature = sign(null, Buffer.from(signedBuildString(build)), signer.privateKey).toString('base64');
  await ensurePrivateDirectory(join(f.paths.data, 'cache', 'builds'));
  await atomicWrite(join(f.paths.data, 'cache', 'builds', `${build.digest}-${createHash('sha256').update(build.signature).digest('hex')}.json`), JSON.stringify(build));
  const locks = new LockStore(f.paths, f.helperId, 'agent-lock.json'), lock = await locks.read();
  lock.entries.push({skillId: build.skillId, target: build.target, route: 'agents-folder', name: build.name, workspaceId: build.workspaceId,
    keyId, signature: build.signature, version: 1, settingsRevision: 0, digest: build.digest, hasCode: true, draft: false,
    acceptedAt: new Date().toISOString(), acceptedBy: 'install', previous: null, keepLocal: null, allowedDigests: [], agentId: f.agentId});
  await locks.write(lock);
  await atomicWrite(join(f.paths.data, 'runner', 'agents-catalog.json'), JSON.stringify([{...f.agent, accessWanted: 'folder_only',
    aiToolId: f.aiToolId, claimable: true, skills: [{skillId: build.skillId, name: build.name, version: 1, settingsRevision: 0, digest: build.digest, hasCode: true}]}]));
  const runtime = new RunsRuntime({...f.runtimeOptions, verifier});
  try {await runtime.notifySetup();} finally {await runtime.close();}
  assert.equal(f.notifications.length, 1); assert.match(f.notifications[0], /1 agents need setup/);
});


test('TLS-25 exact agent-id selector lowers only the chosen duplicate handle without confirmation', async t => {
  const f = await fixture(t, 'on', 'darwin'), other = {...f.agent, agentId: randomUUID()};
  await catalogAgents(f, [f.agent, other]); await fullSetup(f, f.agent.handle);
  await f.runtime.command(['agent', 'access', other.agentId, 'folder-only'], {...f.io, isTTY: false});
  const rows = await f.runtime.local.read();
  assert.equal(rows[other.agentId].access, 'folder_only'); assert.equal(rows[f.agentId].access, 'full_access');
});
