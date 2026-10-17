import assert from 'node:assert/strict';
import {readFileSync, statSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {access, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test, type TestContext} from 'node:test';
import {TOOL_MATRIX} from '../src/shared/tool-matrix.js';
import {deviceKeyFingerprint, RUNNER_HEADERS, verifyDeviceKeyProof, verifyRunnerRequest} from '../src/shared/runner-protocol.js';
import {ApiClient} from '../src/api.js';
import {CommandError, readConfig, type Runner} from '../src/config.js';
import {atomicWrite, createPaths, ensurePaths, ensurePrivateDirectory} from '../src/paths.js';
import {KeychainSecretStore} from '../src/secret-store.js';
import type {Adapter, RunSpec} from '../src/runner/adapter.js';
import {AdapterRegistry} from '../src/runner/adapters/index.js';
import {DeviceKeyStore} from '../src/runner/device-key.js';
import {RunnerProtocolClient} from '../src/runner/protocol-client.js';
import type {ProcessInspector} from '../src/runner/process.js';
import {RunsOnController, parseRunGrants, type RunsOnOptions} from '../src/runner/runs-on.js';
import {RUN_TEST_PROMPT, recoverTestRuns, runToolTest, type RunTestConnection, type RunTestResult} from '../src/runner/test-run.js';

const token = 'mdai_skill_' + 'A'.repeat(43);
async function activationFixture(t: TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-runs-on-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const home = join(root, 'home'); await mkdir(home, {mode: 0o700});
  const paths = await createPaths(readConfig({}, home)); await ensurePaths(paths);
  const items = new Map<string, string>(), writes: string[] = [];
  const runner: Runner = async (_binary, args, options) => {
    assert(!args.some(arg => arg.includes(token) || arg.includes('"format"')));
    if (args[0] === '-i') {
      const match = / -a ("(?:[^"\\]|\\.)*") -w ("(?:[^"\\]|\\.)*")\n$/.exec(options?.input ?? '');
      assert(match); const value = JSON.parse(match[2]) as string; items.set(JSON.parse(match[1]), value); writes.push(value);
      return {stdout: '', stderr: ''};
    }
    const account = args[args.indexOf('-a') + 1];
    if (args[0] === 'delete-generic-password') {items.delete(account); return {stdout: '', stderr: ''};}
    if (!items.has(account)) throw new CommandError(44);
    return {stdout: items.get(account)! + '\n', stderr: ''};
  };
  const secrets = new KeychainSecretStore(new URL('https://ai.maddots.app'), paths.data, runner);
  await secrets.set('skills-token', token);
  const aiToolId = randomUUID(), helperId = randomUUID();
  const registeredKeys = new Map<string, {publicKey: string; revoked: boolean}>();
  let now = Date.now(), loseRegistration = false, loseResult = false, registered = false, enabled = false, tests = 0;
  let finalResult: string | undefined, revokedCode = 'DEVICE_KEY_REVOKED';
  let registrationRefusal: {code: string; status: number} | undefined;
  let testResult: RunTestResult = {ok: true, code: null, toolVersion: '1.0.0'};
  const publicKeys: string[] = [], bodies: unknown[] = [], sent: RunTestResult[] = [];
  const models: (string | undefined)[] = [], sleeps: number[] = [];
  const api = new ApiClient(new URL('https://ai.maddots.app'), async (_input, init) => {
    const body = JSON.parse(String(init?.body)); bodies.push(body);
    assert.deepEqual(Object.keys(body).sort(), ['aiToolId', 'proof', 'publicKey']);
    assert(verifyDeviceKeyProof(helperId, aiToolId, body.publicKey, body.proof));
    publicKeys.push(body.publicKey);
    if (registrationRefusal) return Response.json({error: {code: registrationRefusal.code}}, {status: registrationRefusal.status});
    const same = [...registeredKeys].find(([, key]) => key.publicKey === body.publicKey);
    if (same?.[1].revoked) return Response.json({error: {code: 'DEVICE_KEY_REVOKED'}}, {status: 409});
    if (!same && [...registeredKeys.values()].some(key => !key.revoked)) return Response.json({error: {code: 'DEVICE_KEY_EXISTS'}}, {status: 409});
    const deviceKeyId = same?.[0] ?? randomUUID();
    registeredKeys.set(deviceKeyId, {publicKey: body.publicKey, revoked: false}); registered = true;
    if (loseRegistration) {loseRegistration = false; throw new Error('lost registration');}
    return Response.json({data: {deviceKeyId, fingerprint: deviceKeyFingerprint(body.publicKey)}});
  });
  const keys = new DeviceKeyStore({paths, secrets, helperId, api});
  const connection: RunTestConnection = {aiToolId, tool: 'codex', toolVersion: '1.0.0', bin: '/test/tool', realpath: '/test/tool'};
  const options: RunsOnOptions = {paths, keys, connection: async id => id === aiToolId ? connection : undefined, now: () => now,
    sleep: async milliseconds => {sleeps.push(milliseconds); now += milliseconds;},
    test: async (_connection, testOptions) => {tests++; models.push(testOptions.model); return testResult;},
    protocol: key => new RunnerProtocolClient({endpoint: new URL('https://ai.maddots.app'), token: async () => token,
      deviceKey: key, now: () => now, fetcher: async (input, init) => {
        const path = new URL(String(input)).pathname, headers = new Headers(init?.headers);
        const device = registeredKeys.get(headers.get(RUNNER_HEADERS.deviceKey)!);
        if (!device) return Response.json({error: {code: 'DEVICE_KEY_UNKNOWN'}}, {status: 401});
        assert(verifyRunnerRequest({method: 'POST', path, body: Buffer.from(String(init?.body)),
          deviceKeyId: headers.get(RUNNER_HEADERS.deviceKey)!, timestamp: headers.get(RUNNER_HEADERS.timestamp)!, nonce: headers.get(RUNNER_HEADERS.nonce)!},
          headers.get(RUNNER_HEADERS.signature)!, device.publicKey));
        const body = JSON.parse(String(init?.body));
        if (path.endsWith('/test-result')) sent.push(body);
        if (device.revoked) return Response.json({error: {code: revokedCode}}, {status: revokedCode === 'SCOPE_MISSING' ? 403 : 401});
        if (finalResult) return Response.json({error: {code: finalResult}}, {status: finalResult === 'SCOPE_MISSING' ? 403 : 401});
        if (path.endsWith('/heartbeat')) {
          if (!enabled) return Response.json({error: {code: 'RUNS_NOT_ENABLED'}}, {status: 403});
          return Response.json({data: {heartbeatSeconds: 15, agents: [], claimable: [], stop: []}});
        }
        assert.deepEqual(Object.keys(body).sort(), ['code', 'ok', 'toolVersion']);
        if (enabled) return Response.json({error: {code: 'RUNS_NOT_TESTING'}}, {status: 409});
        enabled = body.ok; if (!body.ok) device.revoked = true;
        if (loseResult) {loseResult = false; throw new Error('lost result');}
        return Response.json({data: {state: body.ok ? 'on' : 'failed'}});
      }})};
  const controller = new RunsOnController(options);
  t.after(() => controller.close());
  const grant = () => [{aiToolId, expiresAt: new Date(now + 600_000).toISOString()}];
  return {controller, options, keys, paths, aiToolId, connection, grant, publicKeys, bodies, writes, sent, models, sleeps, registeredKeys,
    serverGrants: () => registered ? [] : grant(),
    keychainX: async () => JSON.parse((await secrets.get('device-key'))!).keys[aiToolId].x as string,
    pass: () => {testResult = {ok: true, code: null, toolVersion: '1.0.0'};},
    finalResult: (code: string) => {finalResult = code;}, revokedAnswer: (code: string) => {revokedCode = code;},
    refuseRegistration: (code: string, status: number) => {registrationRefusal = {code, status};},
    runsOff: () => {enabled = false; for (const key of registeredKeys.values()) key.revoked = true;},
    loseRegistration: () => {loseRegistration = true;}, loseResult: () => {loseResult = true;},
    fail: (code: string) => {testResult = {ok: false, code, toolVersion: '1.0.0'};},
    advance: (ms = 60_000) => {now += ms;}, counts: () => ({registered, enabled, tests})};
}

test('only a current grant creates its private key through Keychain stdin; lost registration reuses the key', async t => {
  const f = await activationFixture(t);
  await f.controller.syncGrants([]); await f.controller.idle();
  assert.equal(await f.keys.get(f.aiToolId), undefined);
  await assert.rejects(f.controller.testConnection(f.aiToolId), {code: 'RUNS_NOT_GRANTED'});
  await f.controller.syncGrants([{aiToolId: f.aiToolId, expiresAt: new Date(0).toISOString()}]); await f.controller.idle();
  assert.equal(f.counts().registered, false);
  f.loseRegistration(); const grant = f.grant();
  await f.controller.syncGrants(grant); await f.controller.idle();
  assert.equal(JSON.parse(f.writes.find(value => value.startsWith('{"format"'))!).keys[f.aiToolId].deviceKeyId, null);
  assert.deepEqual(f.serverGrants(), []);
  assert.deepEqual(f.sleeps, [1000]);
  await f.controller.syncGrants(f.serverGrants()); await f.controller.idle();
  assert.equal(f.publicKeys.length, 2); assert.equal(f.publicKeys[0], f.publicKeys[1]);
  assert.equal(f.counts().tests, 1); assert.equal(f.counts().enabled, true);
  assert.equal((await f.controller.snapshot())[0].state, 'on');
  const persisted = await readFile(join(f.paths.data, 'runner', 'runs.json'), 'utf8');
  assert(!persisted.includes(token)); assert(!persisted.includes('"d"')); assert(!persisted.includes('privateKey'));
  assert.equal((await lstat(join(f.paths.data, 'runner', 'runs.json'))).mode & 0o777, 0o600);
});

test('TLS-25 final registration refusal after runs off during lost-answer backoff retires the pending key once', async t => {
  const f = await activationFixture(t); f.loseRegistration();
  const sleep = f.options.sleep!, grant = f.grant();
  f.options.sleep = async (milliseconds, signal) => {f.runsOff(); await sleep(milliseconds, signal);};
  await f.controller.syncGrants(grant); await f.controller.idle();
  assert.equal(f.publicKeys.length, 2); assert.equal(f.publicKeys[0], f.publicKeys[1]);
  assert.deepEqual(f.sleeps, [1000]);
  for (let index = 0; index < 3; index++) {f.advance(); await f.controller.syncGrants([]); await f.controller.idle();}
  await f.controller.syncGrants(grant); await f.controller.idle();
  assert.equal(f.publicKeys.length, 2); assert.equal(f.counts().tests, 0); assert.deepEqual(f.sent, []);
  const [row] = await f.controller.snapshot();
  assert.deepEqual([row.state, row.failureCode, row.deviceKeyId], ['failed', 'DEVICE_KEY_REVOKED', null]);
  assert.equal(await f.keys.registerExisting(f.aiToolId), undefined);
  assert.equal(f.publicKeys.length, 2);
});

test('failure remains off with a visible durable code; the same grant never reruns a failed tool', async t => {
  const f = await activationFixture(t); f.fail('mcp_started'); const grant = f.grant();
  await f.controller.syncGrants(grant); await f.controller.idle();
  assert.equal(f.counts().enabled, false); assert.equal((await f.controller.snapshot())[0].failureCode, 'mcp_started');
  await f.controller.syncGrants(grant); await f.controller.idle(); assert.equal(f.counts().tests, 1);
  const recovered = new RunsOnController(f.options); t.after(() => recovered.close());
  assert.equal((await recovered.snapshot())[0].failureCode, 'mcp_started');
});

test('lost signed test acknowledgement resumes after restart without a second tool run', async t => {
  const f = await activationFixture(t); f.loseResult();
  await f.controller.syncGrants(f.grant()); await f.controller.idle();
  assert.equal(f.counts().tests, 1); assert((await f.controller.snapshot())[0].pendingResult);
  await f.controller.close();
  const recovered = new RunsOnController(f.options); t.after(() => recovered.close());
  await recovered.syncGrants([]); await recovered.idle();
  assert.equal(f.counts().tests, 1); assert.equal(f.sent.length, 2);
  assert.deepEqual(f.sent[0], f.sent[1]); assert.equal((await recovered.snapshot())[0].state, 'on');
  assert.equal((await recovered.snapshot())[0].pendingResult, undefined);
});

test('malformed grants are rejected before touching keys', async t => {
  const f = await activationFixture(t);
  assert.throws(() => parseRunGrants([{aiToolId: f.aiToolId, expiresAt: 'tomorrow'}]), {code: 'API_RESPONSE_INVALID'});
  assert.throws(() => parseRunGrants([...f.grant(), ...f.grant()]), {code: 'API_RESPONSE_INVALID'});
  assert.equal(await f.keys.get(f.aiToolId), undefined);
});

const fakeTool = fileURLToPath(new URL('./fixtures/fake-tool.mjs', import.meta.url));
const processes: ProcessInspector = {table: async () => [], fencePids: async () => [],
  identity: async pid => {try {process.kill(pid, 0); return `test-${pid}`;} catch {return null;}},
  // The echo fixture has no descendants. macOS rejects group signals to an unreaped zombie.
  signalGroup: (pid, signal) => {try {process.kill(pid, signal);} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;}}};
async function toolFixture() {
  const bin = await realpath(process.execPath), seen: {spec?: RunSpec; argv?: string[]} = {};
  const matrix = structuredClone(TOOL_MATRIX);
  matrix.tools.find(tool => tool.key === 'codex')!.run = {adapter: 'codex', card: 'TLS-26', offered: true,
    folderOnly: 'os-sandbox', mcpLevel: 'servers-off', reason: null, checkedAt: '2026-10-14'};
  const adapter: Adapter = {info: {tool: 'codex', harness: 'codex', card: 'TLS-26', folderOnly: 'os-sandbox',
    mcpLevel: 'servers-off', skillsDir: '{cwd}/.agents/skills', promptVia: 'stdin', runHome: false},
    supports: () => ({ok: true, reason: null}), identity: async () => ({ok: true, version: '1.0.0'}),
    build(spec) {seen.spec = spec; const argv = [spec.bin, fakeTool, 'echo', '-m', spec.model]; seen.argv = argv;
      return {argv, env: {}, envUnset: [], files: [], projectFiles: [], stdinFile: spec.promptFile, spawnCwd: null, secretEnv: {}};},
    parse: result => ({ok: result.exitCode === 0, text: result.stdout, failureCode: result.exitCode === 0 ? null : 'tool_failed'})};
  const connection: RunTestConnection = {aiToolId: randomUUID(), tool: 'codex', toolVersion: '1.0.0', bin, realpath: bin};
  return {adapter, registry: new AdapterRegistry([adapter]), matrix, connection, seen, processes};
}

test('test tool gets exact prompt, restricted offered mode, five minute deadline and disposable cwd', async () => {
  const f = await toolFixture();
  const parse = f.adapter.parse; let prompt = '';
  f.adapter.parse = result => {prompt = result.stdout.trim(); return parse(result);};
  assert.deepEqual(await runToolTest({...f, model: 'chosen-model'}), {ok: true, code: null, toolVersion: '1.0.0'});
  assert(f.seen.spec); assert.equal(f.seen.spec.model, 'chosen-model'); assert.equal(f.seen.spec.access, 'folder_only');
  assert(f.seen.spec.timeoutSeconds >= 269 && f.seen.spec.timeoutSeconds <= 270);
  assert.equal(f.seen.spec.maxTurns, 50); assert.match(f.seen.spec.cwd, /maddots-ai-test-/);
  await assert.rejects(access(f.seen.spec.cwd));
  // The child echoed stdin, so this also verifies the exact test prompt reached the parse path.
  assert.equal(prompt, RUN_TEST_PROMPT);
  assert.equal(RUN_TEST_PROMPT, 'Reply with exactly MADDOTS-RUNNER-OK and nothing else.');
});

test('saved tool default omits the model option, while explicit model is passed intact', async () => {
  const f = await toolFixture(); let output = '';
  const parse = f.adapter.parse;
  f.adapter.parse = result => {output = result.stdout; return parse(result);};
  const build = f.adapter.build;
  f.adapter.build = spec => {const invocation = build(spec); return {...invocation, stdinFile: null};};
  // With stdin omitted, the echo fixture prints argv. The default option must be absent.
  assert.equal((await runToolTest(f)).ok, false); assert.equal(output.trim(), '');
  assert.equal((await runToolTest({...f, model: 'named-model'})).ok, false); assert.equal(output.trim(), '-m named-model');
});

test('unoffered tools never launch, and MCP or parse failures stay failures with removed temporary folders', async () => {
  const f = await toolFixture();
  assert.equal((await runToolTest({...f, matrix: TOOL_MATRIX})).code, 'adapter_refused'); assert.equal(f.seen.spec, undefined);
  f.adapter.selfCheck = () => ({mcpServers: ['canary'], browserTools: []});
  assert.equal((await runToolTest({...f, model: 'fixture'})).code, 'mcp_started'); await assert.rejects(access(f.seen.spec!.cwd));
  delete f.adapter.selfCheck;
  f.adapter.parse = () => ({ok: false, text: 'MADDOTS-RUNNER-OK', failureCode: 'output_empty'});
  assert.equal((await runToolTest({...f, model: 'fixture'})).code, 'output_empty'); await assert.rejects(access(f.seen.spec!.cwd));
});

test('an already-on diagnostic test leaves live server state and its heartbeat untouched', async t => {
  const f = await activationFixture(t);
  await f.controller.syncGrants(f.grant()); await f.controller.idle();
  const before = await f.controller.snapshot(); f.fail('output_empty');
  const result = await f.controller.testConnection(f.aiToolId, {model: 'diagnostic-model'});
  assert.equal(result.code, 'output_empty'); assert.equal(f.sent.length, 1);
  assert.equal(f.counts().enabled, true); assert.deepEqual(await f.controller.snapshot(), before);
});

test('separate controllers serialize activation and the second process reloads the completed test', async t => {
  const f = await activationFixture(t), second = new RunsOnController(f.options); t.after(() => second.close());
  const grant = f.grant();
  await Promise.all([f.controller.syncGrants(grant), second.syncGrants(grant)]);
  await Promise.all([f.controller.idle(), second.idle()]);
  assert.equal(f.counts().tests, 1); assert.equal(f.publicKeys.length, 1);
  assert.equal((await second.snapshot())[0].state, 'on');
});

test('only-full-access offered tool tests use full access without changing any agent grant', async () => {
  const f = await toolFixture(); f.matrix.tools.find(tool => tool.key === 'codex')!.run!.folderOnly = 'none';
  assert.equal((await runToolTest({...f, model: 'fixture'})).ok, true);
  assert.equal(f.seen.spec!.access, 'full_access'); await assert.rejects(access(f.seen.spec!.cwd));
});


test('Claude test plugin has the run-only manifest required by the real adapter', async () => {
  const f = await toolFixture();
  f.adapter.info = {...f.adapter.info, tool: 'claude-code', harness: 'claude_code', skillsDir: '{runDir}/plugin/skills'};
  f.matrix.tools.find(tool => tool.key === 'claude-code')!.run = {...f.matrix.tools.find(tool => tool.key === 'codex')!.run!, adapter: 'claude-code'};
  const build = f.adapter.build;
  f.adapter.build = spec => {
    const path = join(spec.runDir, 'plugin', '.claude-plugin', 'plugin.json');
    assert.equal(readFileSync(path, 'utf8'), '{"name":"maddots-run","version":"1.0.0"}');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(spec.skillsDir, join(spec.runDir, 'plugin', 'skills'));
    return build(spec);
  };
  const connection = {...f.connection, tool: 'claude-code'};
  assert.equal((await runToolTest({...f, connection, registry: new AdapterRegistry([f.adapter]), model: 'fixture'})).ok, true);
  await assert.rejects(access(f.seen.spec!.cwd));
});

test('a legacy registered key without activation state runs only a diagnostic and never sends an empty heartbeat', async t => {
  const f = await activationFixture(t);
  await f.controller.syncGrants(f.grant()); await f.controller.idle(); await f.controller.close();
  await rm(join(f.paths.data, 'runner', 'runs.json'));
  const controller = new RunsOnController(f.options); t.after(() => controller.close());
  assert.equal((await controller.testConnection(f.aiToolId)).ok, true);
  assert.equal(f.sent.length, 1); assert.deepEqual(await controller.snapshot(), []);
});

test('an older approval response cannot remove a key belonging to a later completed activation', async t => {
  const f = await activationFixture(t); const old = f.grant(); f.advance();
  await f.controller.syncGrants(f.grant()); await f.controller.idle();
  const key = await f.keys.get(f.aiToolId);
  await f.controller.syncGrants(old); await f.controller.idle();
  assert.equal((await f.keys.get(f.aiToolId))!.deviceKeyId, key!.deviceKeyId);
  assert.equal(f.publicKeys.length, 1); assert.equal(f.counts().tests, 1);
});


async function recoveryFixture(t: TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-test-recovery-'));
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'maddots-ai-test-')));
  t.after(async () => {await rm(root, {recursive: true, force: true}); await rm(cwd, {recursive: true, force: true});});
  const data = join(root, 'data'), directory = join(data, 'runner', 'test-processes');
  await mkdir(directory, {recursive: true, mode: 0o700});
  const aiToolId = randomUUID(), file = join(directory, aiToolId + '.json');
  await writeFile(file, JSON.stringify({format: 1, aiToolId, cwd, fence: 'a'.repeat(32), pid: 0, startedAt: '', groups: []}), {mode: 0o600});
  return {root, cwd, data, file};
}

test('test recovery fails closed on denied process inspection and never launches another tool', async t => {
  const saved = await recoveryFixture(t), f = await toolFixture(); let scans = 0;
  const denied: ProcessInspector = {...processes, table: async () => {scans++; throw new Error('inspection denied');}};
  const result = await runToolTest({...f, data: saved.data, processes: denied, model: 'fixture'});
  assert.equal(result.code, 'RUNNER_TEST_RECOVERY_UNAVAILABLE'); assert.equal(f.seen.spec, undefined);
  assert(scans > 0); await access(saved.cwd); await access(saved.file);
  assert.equal(await recoverTestRuns({data: saved.data, processes}), true);
  await assert.rejects(access(saved.cwd)); await assert.rejects(access(saved.file));
});

test('startup recovery skips a cooperating live test lease without inspecting or deleting its folder', async t => {
  const saved = await recoveryFixture(t), lock = join(saved.data, 'runner', '.test-process.lock');
  await writeFile(lock, String(process.pid), {mode: 0o600});
  const denied: ProcessInspector = {...processes, table: async () => {assert.fail('live test must not be inspected');}};
  assert.equal(await recoverTestRuns({data: saved.data, processes: denied, skipBusy: true}), false);
  await access(saved.cwd); await access(saved.file);
});

test('successful test execution writes spawn recovery metadata and removes its ledger after cleanup', async t => {
  const saved = await recoveryFixture(t); await recoverTestRuns({data: saved.data, processes});
  const f = await toolFixture(), parse = f.adapter.parse;
  f.adapter.parse = result => {
    const file = join(saved.data, 'runner', 'test-processes', f.connection.aiToolId + '.json');
    const ledger = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(ledger.cwd, f.seen.spec!.cwd); assert.match(ledger.fence, /^[a-f0-9]{32}$/);
    assert(ledger.pid > 1); assert.match(ledger.startedAt, /^test-/); assert(Array.isArray(ledger.groups));
    return parse(result);
  };
  assert.equal((await runToolTest({...f, data: saved.data, model: 'fixture'})).ok, true);
  await assert.rejects(access(join(saved.data, 'runner', 'test-processes', f.connection.aiToolId + '.json')));
});


test('recovery retains a private interrupted-write tempfile while recovering the authoritative process row', async t => {
  const saved = await recoveryFixture(t);
  const temporary = join(saved.data, 'runner', 'test-processes', '.' + randomUUID() + '.tmp');
  await writeFile(temporary, '{"interrupted":', {mode: 0o600});
  let scans = 0;
  await recoverTestRuns({data: saved.data, processes: {...processes, fencePids: async fence => {
    assert.equal(fence, 'a'.repeat(32)); scans++; return [];
  }}});
  assert(scans > 0); await assert.rejects(access(saved.file)); await assert.rejects(access(saved.cwd));
  assert.equal(await readFile(temporary, 'utf8'), '{"interrupted":');
});

test('an interrupted initial ledger write cannot block the next test or acquire process authority', async t => {
  const saved = await recoveryFixture(t), f = await toolFixture();
  const temporary = join(saved.data, 'runner', 'test-processes', '.' + randomUUID() + '.tmp');
  await writeFile(temporary, await readFile(saved.file), {mode: 0o600}); await rm(saved.file);
  assert.equal((await runToolTest({...f, data: saved.data, model: 'fixture'})).ok, true);
  await access(saved.cwd); await access(temporary);
  await assert.rejects(access(f.seen.spec!.cwd));
});

test('an atomic-write tempfile name never permits a symlink to be followed or ignored as private evidence', async t => {
  const saved = await recoveryFixture(t); await rm(saved.file);
  const temporary = join(saved.data, 'runner', 'test-processes', '.' + randomUUID() + '.tmp');
  const target = join(saved.root, 'unrelated'); await writeFile(target, 'preserve', {mode: 0o600}); await symlink(target, temporary);
  const denied: ProcessInspector = {...processes, table: async () => {assert.fail('tempfile cannot authorize process inspection');}};
  await assert.rejects(recoverTestRuns({data: saved.data, processes: denied}), {code: 'RUNNER_TEST_RECOVERY_UNAVAILABLE'});
  assert.equal(await readFile(target, 'utf8'), 'preserve'); assert.equal((await lstat(temporary)).isSymbolicLink(), true);
});

async function savedActivation(f: Awaited<ReturnType<typeof activationFixture>>, state: 'waiting' | 'testing', deviceKeyId: string | null) {
  await ensurePrivateDirectory(join(f.paths.data, 'runner'));
  await atomicWrite(join(f.paths.data, 'runner', 'runs.json'), JSON.stringify({format: 1, tools: [{aiToolId: f.aiToolId, state,
    failureCode: null, deviceKeyId, toolVersion: state === 'waiting' ? null : '1.0.0', grantExpiresAt: f.grant()[0].expiresAt}]}) + '\n');
}

test('consumed-grant restart retries only the persisted pending key and keeps its server id', async t => {
  const f = await activationFixture(t); f.loseRegistration();
  await assert.rejects(f.keys.ensure(f.aiToolId), {code: 'API_CONNECTION_FAILED'});
  const serverId = [...f.registeredKeys.keys()][0];
  await savedActivation(f, 'waiting', null);
  await f.controller.close();
  const recovered = new RunsOnController(f.options); t.after(() => recovered.close());
  assert.deepEqual(f.serverGrants(), []);
  await recovered.syncGrants(f.serverGrants()); await recovered.idle();
  assert.equal((await recovered.snapshot())[0].state, 'on');
  assert.equal((await f.keys.get(f.aiToolId))!.deviceKeyId, serverId);
  assert.equal(f.registeredKeys.size, 1); assert.deepEqual(f.publicKeys, [f.publicKeys[0], f.publicKeys[0]]);
  assert.equal(f.counts().tests, 1);
});

for (const [code, status] of [['DEVICE_KEY_REVOKED', 409], ['DEVICE_KEY_EXISTS', 409], ['SCOPE_MISSING', 403],
  ['RUNS_NOT_GRANTED', 403], ['DEVICE_PROOF_INVALID', 400], ['TOKEN_IN_FILE', 403]] as const) {
  test(`TLS-25 restarted pending registration treats ${code} as final for its grant`, async t => {
    const f = await activationFixture(t); f.loseRegistration();
    const grant = f.grant();
    await assert.rejects(f.keys.ensure(f.aiToolId), {code: 'API_CONNECTION_FAILED'});
    await savedActivation(f, 'waiting', null); await f.controller.close();
    f.runsOff();
    if (code !== 'DEVICE_KEY_REVOKED') f.refuseRegistration(code, status);
    const recovered = new RunsOnController(f.options); t.after(() => recovered.close());
    for (let index = 0; index < 5; index++) {f.advance(); await recovered.syncGrants([]); await recovered.idle();}
    await recovered.syncGrants(grant); await recovered.idle();
    assert.equal(f.publicKeys.length, 2, 'Only the first recovery poll may resend the pending proof.');
    assert.equal(f.publicKeys[0], f.publicKeys[1]); assert.equal(f.counts().tests, 0);
    assert.deepEqual(f.sent, []); assert.deepEqual(f.sleeps, []);
    const [row] = await recovered.snapshot();
    assert.deepEqual([row.state, row.failureCode, row.deviceKeyId], ['failed', code, null]);
    assert.equal(row.pendingResult, undefined);
    assert.equal(await f.keys.registerExisting(f.aiToolId), undefined, 'The refused pending key must leave Keychain.');
    f.advance(600_001);
    for (let index = 0; index < 3; index++) {f.advance(); await recovered.syncGrants([]); await recovered.idle();}
    assert.equal(f.publicKeys.length, 2); assert.deepEqual(await recovered.snapshot(), [row]);
  });
}

test('registration recovery cannot mint missing material or retry after its original grant expires', async t => {
  const absent = await activationFixture(t); await savedActivation(absent, 'waiting', null);
  await absent.controller.syncGrants([]); await absent.controller.idle();
  assert.equal(absent.publicKeys.length, 0); assert.equal(await absent.keys.get(absent.aiToolId), undefined);
  assert.equal(await absent.keys.registerExisting(absent.aiToolId), undefined);
  const expired = await activationFixture(t); expired.loseRegistration();
  await assert.rejects(expired.keys.ensure(expired.aiToolId)); await savedActivation(expired, 'waiting', null);
  expired.advance(600_001);
  await expired.controller.syncGrants([]); await expired.controller.idle();
  assert.equal(expired.publicKeys.length, 1); assert.equal(expired.counts().tests, 0);
});

for (const previous of ['failed', 'off', 'pending'] as const) test(`a new grant replaces the ${previous} key before registering again`, async t => {
  const f = await activationFixture(t);
  if (previous === 'pending') {
    f.loseRegistration(); await assert.rejects(f.keys.ensure(f.aiToolId)); await savedActivation(f, 'waiting', null);
  } else {
    if (previous === 'failed') f.fail('output_empty');
    await f.controller.syncGrants(f.grant()); await f.controller.idle();
    assert.equal((await f.controller.snapshot())[0].state, previous === 'failed' ? 'failed' : 'on');
  }
  const oldX = f.publicKeys[0]; f.runsOff(); f.pass(); f.advance();
  await f.controller.syncGrants(f.grant()); await f.controller.idle();
  assert.equal((await f.controller.snapshot())[0].state, 'on');
  assert.equal(f.publicKeys.length, 2); assert.notEqual(f.publicKeys[1], oldX);
  assert.notEqual(await f.keychainX(), oldX);
  assert.equal([...f.registeredKeys.values()].filter(key => !key.revoked).length, 1);
});

test('an acknowledged failed activation retests locally without changing its durable failure or sending again', async t => {
  const f = await activationFixture(t); f.fail('mcp_started');
  await f.controller.syncGrants(f.grant()); await f.controller.idle();
  const before = await readFile(join(f.paths.data, 'runner', 'runs.json'), 'utf8');
  f.pass(); assert.equal((await f.controller.testConnection(f.aiToolId, {model: 'fixed-model'})).ok, true);
  assert.deepEqual(f.models, [undefined, 'fixed-model']);
  for (let i = 0; i < 3; i++) {await f.controller.syncGrants([]); await f.controller.idle();}
  assert.equal(f.sent.length, 1); assert.equal(await readFile(join(f.paths.data, 'runner', 'runs.json'), 'utf8'), before);
  const [row] = await f.controller.snapshot(); assert.equal(row.state, 'failed'); assert.equal(row.failureCode, 'mcp_started');
  assert.equal(row.pendingResult, undefined);
});

for (const code of ['DEVICE_KEY_REVOKED', 'SCOPE_MISSING']) test(`a passing activation treats ${code} as final and never resends`, async t => {
  const f = await activationFixture(t); f.finalResult(code);
  await f.controller.syncGrants(f.grant()); await f.controller.idle();
  const [row] = await f.controller.snapshot();
  assert.equal(row.state, 'failed'); assert.equal(row.failureCode, code); assert.equal(row.pendingResult, undefined);
  await f.controller.close();
  const recovered = new RunsOnController(f.options); t.after(() => recovered.close());
  for (let i = 0; i < 3; i++) {await recovered.syncGrants([]); await recovered.idle();}
  assert.equal(f.sent.length, 1); assert.equal(f.counts().tests, 1);
  assert.equal((await recovered.snapshot())[0].failureCode, code);
});

for (const state of ['waiting', 'testing'] as const) test(`a crash in ${state} after registration resumes one test without a grant`, async t => {
  const f = await activationFixture(t), key = await f.keys.ensure(f.aiToolId);
  await savedActivation(f, state, state === 'waiting' ? null : key.deviceKeyId);
  await f.controller.close();
  const recovered = new RunsOnController(f.options); t.after(() => recovered.close());
  await recovered.syncGrants(f.serverGrants()); await recovered.idle();
  assert.equal(f.counts().tests, 1); assert.equal(f.sent.length, 1);
  assert.equal((await recovered.snapshot())[0].state, 'on');
  assert.equal((await recovered.snapshot())[0].pendingResult, undefined);
});

for (const code of ['DEVICE_KEY_REVOKED', 'SCOPE_MISSING']) test(`a lost failed acknowledgement preserves the original code after ${code}`, async t => {
  const f = await activationFixture(t); f.fail('mcp_started'); f.loseResult(); f.revokedAnswer(code);
  await f.controller.syncGrants(f.grant()); await f.controller.idle(); await f.controller.close();
  const recovered = new RunsOnController(f.options); t.after(() => recovered.close());
  await recovered.syncGrants([]); await recovered.idle();
  const [row] = await recovered.snapshot();
  assert.equal(row.state, 'failed'); assert.equal(row.failureCode, 'mcp_started'); assert.equal(row.pendingResult, undefined);
  await recovered.syncGrants([]); await recovered.idle();
  assert.equal(f.sent.length, 2); assert.equal(f.counts().tests, 1);
});

test('model options reach both the activation test and the live diagnostic; grants keep the tool default', async t => {
  const f = await activationFixture(t), key = await f.keys.ensure(f.aiToolId);
  await savedActivation(f, 'testing', key.deviceKeyId);
  await f.controller.testConnection(f.aiToolId, {model: 'activation-model'});
  await f.controller.testConnection(f.aiToolId, {model: 'diagnostic-model'});
  assert.deepEqual(f.models, ['activation-model', 'diagnostic-model']);
  const g = await activationFixture(t); await g.controller.syncGrants(g.grant()); await g.controller.idle();
  assert.deepEqual(g.models, [undefined]);
});

for (const code of ['tool_not_found', 'tool_identity']) test(`discovery failure ${code} registers and reports the durable failed result`, async t => {
  const f = await activationFixture(t);
  f.options.connection = async () => code === 'tool_not_found' ? undefined : {...f.connection, toolVersion: '\ninvalid'};
  await f.controller.syncGrants(f.grant()); await f.controller.idle();
  assert.equal(f.publicKeys.length, 1); assert.equal(f.counts().tests, 0);
  assert.deepEqual(f.sent, [{ok: false, code, toolVersion: null}]);
  const [row] = await f.controller.snapshot();
  assert.equal(row.state, 'failed'); assert.equal(row.failureCode, code); assert.equal(row.pendingResult, undefined);
  assert.equal([...f.registeredKeys.values()][0].revoked, true);
});

test('restart sends a saved discovery refusal even while the tool remains absent', async t => {
  const f = await activationFixture(t); f.options.connection = async () => undefined;
  // Simulate a crash immediately after saving the result, before transport can send it.
  const protocol = f.options.protocol;
  f.options.protocol = () => {throw new Error('crashed before send');};
  await f.controller.syncGrants(f.grant()); await f.controller.idle(); await f.controller.close();
  assert.equal(f.sent.length, 0); assert((await f.controller.snapshot())[0].pendingResult);
  f.options.protocol = protocol;
  const recovered = new RunsOnController(f.options); t.after(() => recovered.close());
  await recovered.syncGrants([]); await recovered.idle();
  assert.deepEqual(f.sent, [{ok: false, code: 'tool_not_found', toolVersion: null}]);
  assert.equal((await recovered.snapshot())[0].state, 'failed'); assert.equal((await recovered.snapshot())[0].pendingResult, undefined);
});

test('a missing tool after registered-key crash recovery sends its failure instead of waiting forever', async t => {
  const f = await activationFixture(t), key = await f.keys.ensure(f.aiToolId);
  await savedActivation(f, 'testing', key.deviceKeyId); f.options.connection = async () => undefined;
  await f.controller.syncGrants([]); await f.controller.idle();
  assert.deepEqual(f.sent, [{ok: false, code: 'tool_not_found', toolVersion: null}]);
  assert.equal((await f.controller.snapshot())[0].state, 'failed');
});

test('forget durably clears only the matching live activation and preserves genuine failures', async t => {
  const f = await activationFixture(t); await f.controller.syncGrants(f.grant()); await f.controller.idle();
  const key = (await f.keys.get(f.aiToolId))!;
  await f.controller.forget(f.aiToolId, randomUUID()); assert.equal((await f.controller.snapshot())[0].state, 'on');
  await f.controller.forget(f.aiToolId, key.deviceKeyId); assert.deepEqual(await f.controller.snapshot(), []);
  const recovered = new RunsOnController(f.options); t.after(() => recovered.close()); assert.deepEqual(await recovered.snapshot(), []);
  const failed = await activationFixture(t); failed.fail('mcp_started');
  await failed.controller.syncGrants(failed.grant()); await failed.controller.idle();
  await failed.controller.forget(failed.aiToolId, null);
  assert.equal((await failed.controller.snapshot())[0].failureCode, 'mcp_started');
});
