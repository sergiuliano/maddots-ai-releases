import {cleanupNativeFixtureRoot, linuxNativeFixtureTimeout, linuxNativeWorkloadSkip, observeNativeLinuxWorkloads, qualifyLinuxFixtureWithoutWorkloads} from './support/linux-native-workloads.js';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { readdirSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type {Duplex} from 'node:stream';
import { fileURLToPath } from 'node:url';
import { treeDigest } from '../src/shared/build-format.js';
import { TOOL_MATRIX } from '../src/shared/tool-matrix.js';
import type { ApiClient } from '../src/api.js';
import { withAgentDestinationLocks } from '../src/agent-fence.js';
import { readConfig, type Timing } from '../src/config.js';
import { FolderDeliveryTarget } from '../src/delivery/index.js';
import { createPaths, ensurePaths } from '../src/paths.js';
import type { Adapter } from '../src/runner/adapter.js';
import { AdapterRegistry } from '../src/runner/adapters/index.js';
import { MaddotsApi } from '../src/runner/maddots-api.js';
import type { RunnerClaim, RunnerSkill } from '../src/runner/protocol-client.js';
import type { ProcessInspector } from '../src/runner/process.js';
import { RunnerCore, type RunnerConnection, type RunnerOptions } from '../src/runner/runner.js';
import { createSkillStager } from '../src/runner/stage-skills.js';
import { RunnerState } from '../src/runner/state.js';
import {LINUX_GUARDIAN} from '../src/runner/linux-guardian.js';
import type {LinuxContainedRun} from '../src/runner/linux-containment.js';
import { SyncEngine, type SyncPlan } from '../src/sync.js';
import { BuildVerifier, signedBuildString, type PlanItem, type SignedBuild } from '../src/verify.js';
import { directFixtureProcesses, nativeFixtureProcesses } from './native-process-fixture.js';
import { initializeCleanRunnerJournal } from './support/runner-journal-fixture.js';
import {holdLinuxFixtureStart} from './support/linux-start-frame.js';
import {CODEX_FIXTURE_PROVIDER} from './support/codex-local-provider-fixture.js';

const fakeTool = fileURLToPath(new URL('./fixtures/fake-tool.mjs', import.meta.url));
const promisesModule = createRequire(import.meta.url)('node:fs/promises') as typeof fsp;
const childProcessModule = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
function nativeGuardianSpawn(args: Parameters<typeof childProcessModule.spawn>): boolean {
  return Array.isArray(args[1]) && args[1].includes(LINUX_GUARDIAN);
}
function adapterSpawn(args: Parameters<typeof childProcessModule.spawn>, cwd: string): boolean {
  return process.platform === 'linux' ? nativeGuardianSpawn(args) : Array.isArray(args[1]) && args[1].includes(join(cwd, 'fake-tool.mjs'));
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => {resolve = done;});
  return {promise, resolve};
}
function clock() {
  let now = Date.now();
  const sleeps: number[] = [];
  const timing: Timing = {now: () => now, sleep: async ms => {sleeps.push(ms); now += ms;}};
  return {timing, sleeps};
}
const posted = () => ({comments: 0, attachments: 0, filesSkipped: 0, moved: false, moveSkipped: null});

async function settleFixtureWork(work: Promise<unknown>[], milliseconds = 50_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.allSettled(work), new Promise<never>((_done, reject) => {
      timer = setTimeout(() => reject(new Error('Destination fence fixture work did not settle; retaining its evidence.')), milliseconds);
    })]);
  } finally {clearTimeout(timer);}
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-agent-fence-'));
  const home = join(root, 'home'), cwd = join(root, 'project');
  await mkdir(home, {mode: 0o700}); await mkdir(cwd, {mode: 0o700});
  const fixtureTool = join(cwd, 'fake-tool.mjs'); await copyFile(fakeTool, fixtureTool);
  let captureNative: ((run: LinuxContainedRun) => void) | undefined, readyNative: ((run: LinuxContainedRun) => void) | undefined;
  const nativeRuns = observeNativeLinuxWorkloads(t, {captured: run => captureNative?.(run), ready: run => readyNative?.(run)});
  const paths = await createPaths(readConfig({MADDOTS_AI_HOME: join(root, 'data')}, home));
  await ensurePaths(paths);
  await initializeCleanRunnerJournal(paths.data);
  const route = join(home, '.agents', 'skills'); await mkdir(route, {recursive: true});
  const signer = generateKeyPairSync('ed25519');
  const publicKey = signer.publicKey.export({type: 'spki', format: 'der'}).subarray(-32);
  const keyId = createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
  const verifier = new BuildVerifier({keys: [{keyId, publicKey: publicKey.toString('base64')}], env: {}});
  const helperId = 'helper-fence', agentId = randomUUID(), skillId = randomUUID(), aiToolId = randomUUID();
  const syncClock = clock(), runClock = clock(), builds = new Map<string, SignedBuild>();
  const client = {request: async (path: string) => {
    const build = builds.get(new URL(path, 'https://fixture.invalid').pathname.slice('/api/helper/builds/'.length));
    assert.ok(build, `unexpected build request: ${path}`);
    return {status: 200, headers: new Headers(), data: structuredClone(build)};
  }} as Pick<ApiClient, 'request'>;
  const engine = new SyncEngine({paths, helperId, client, verifier, timing: syncClock.timing,
    targets: [new FolderDeliveryTarget(paths, 'agents-folder', route)], watchRoute: () => ({close() {}})});
  await engine.reconcile();
  const stager = createSkillStager({paths, helperId, verifier, timing: runClock.timing});
  function build(version: number): SignedBuild {
    const content = Buffer.from(`---\nname: example\ndescription: Claimed version ${version}\n---\nVersion ${version}\n`);
    const result: SignedBuild = {format: 1, keyId, skillId, version, settingsRevision: 0, level: 'workspace',
      workspaceId: 'workspace-fence', boardId: null, target: 'folder', name: 'example', hasCode: false, draft: false,
      digest: treeDigest([{path: 'SKILL.md', mode: '100644', content}]), signature: '',
      report: {renamedFrom: null, unresolvedOptionalReferences: [], unsetSettings: []},
      files: [{path: 'SKILL.md', mode: '100644', size: content.length,
        sha256: createHash('sha256').update(content).digest('hex'), content: content.toString('base64')}]};
    result.signature = sign(null, Buffer.from(signedBuildString(result)), signer.privateKey).toString('base64');
    builds.set(result.digest, result); return result;
  }
  function item(build: SignedBuild, changes: Partial<PlanItem> = {}): PlanItem {
    return {itemId: createHash('sha256').update(JSON.stringify([build.signature, changes])).digest('hex'),
      kind: 'install', skillId, name: build.name, sourceName: build.name, level: build.level, workspaceId: build.workspaceId,
      workspaceIds: [build.workspaceId], boardIds: [], target: build.target, route: 'agents-folder', fromVersion: null,
      version: build.version, settingsRevision: build.settingsRevision, digest: build.digest, hasCode: false, draft: false,
      dependencyOf: null, missingDependencies: [], forAgentIds: [agentId], state: 'approved', answer: 'update', reason: null,
      restartHints: [], ...changes};
  }
  function plan(items: PlanItem[], revoked: SyncPlan['revoked'] = []): SyncPlan {
    return {planRevision: createHash('sha256').update(JSON.stringify([items, revoked])).digest('hex'),
      degraded: false, pollAfterSeconds: 60, items, revoked, instructions: []};
  }
  const skill = (build: SignedBuild): RunnerSkill & {digest: string} => ({skillId, name: build.name,
    version: build.version, settingsRevision: build.settingsRevision, digest: build.digest, hasCode: false});
  const cores: RunnerCore[] = [], cleanup: (() => void)[] = [], outstanding: Promise<unknown>[] = [];
  const track = <T>(work: Promise<T>): Promise<T> => {
    outstanding.push(work); void work.catch(() => {}); return work;
  };
  const applyPlan = engine.applyPlan.bind(engine);
  engine.applyPlan = (...args) => track(applyPlan(...args));
  const settle = (milliseconds?: number) => settleFixtureWork(outstanding, milliseconds);
  t.after(() => cleanupNativeFixtureRoot(t, root, paths.data, async () => {
    for (const release of cleanup) release();
    const closing = Promise.allSettled(cores.map(core => core.close()));
    try {
      // Sync and explicit fence actions outlive their released gates. Join
      // their final filesystem work before journal replay or root removal.
      await settleFixtureWork([...outstanding, closing]);
      for (const result of await closing) if (result.status === 'rejected') throw result.reason;
    } finally {await nativeRuns.cleanup();}
  }));
  function gate() {
    const result = deferred(); cleanup.push(() => result.resolve()); return result;
  }
  async function runner(build: SignedBuild, sessionGuardian = false) {
    const runId = randomUUID(), cardId = randomUUID(), boardId = randomUUID(), bin = await realpath(process.execPath);
    const access = process.platform === 'linux' ? 'full_access' : 'folder_only';
    const claim: RunnerClaim = {runId, agentId, cardId, boardId, commentId: null, kind: 'assignment',
      expiresAt: new Date(Date.now() + 7_200_000).toISOString(), model: 'fixture', provider: CODEX_FIXTURE_PROVIDER, effort: null,
      maxRunMinutes: 1, skills: [skill(build)]};
    const hooks: {card?: () => Promise<void>; preparing?: () => Promise<void>; started?: () => Promise<void>;
      inspect?: (pid: number) => void} = {};
    let issued = false, spawns = 0;
    captureNative = () => {spawns++;};
    readyNative = run => {hooks.inspect?.(run.child.pid!);};
    const connection: RunnerConnection = {aiToolId, deviceKeyId: randomUUID(), tool: 'codex', toolVersion: '1.0.0',
      bin, realpath: bin, runsOn: true, protocol: {
        heartbeat: async () => ({heartbeatSeconds: 15, agents: [{agentId, name: 'Fixture', handle: 'fixture', status: 'active',
          model: claim.model, provider: claim.provider, effort: null, accessWanted: access, maxRunMinutes: 1, skills: claim.skills}],
        claimable: issued ? [] : [{runId, agentId, kind: 'assignment'}], stop: []}),
        claim: async () => {
          issued = true;
          const api = new MaddotsApi('pm_run_fixture', {fetcher: async () => {
            await hooks.card?.();
            return Response.json({data: {card: {title: 'Fence regression'}, comments: [], attachments: []}});
          }});
          return {claim, api};
        },
        outcome: async () => ({recorded: true}),
      }};
    const adapter: Adapter = {
      info: {tool: 'codex', harness: 'codex', card: 'TLS-26', folderOnly: 'os-sandbox', mcpLevel: 'servers-off',
        skillsDir: '{runDir}/skills', promptVia: 'stdin', runHome: false},
      identity: async () => ({ok: true, version: '1.0.0'}), supports: () => ({ok: true, reason: null}),
      preflight: async () => {if (process.platform === 'linux') await hooks.preparing?.(); return {ok: true, reason: null};},
      build: spec => ({argv: [spec.bin, fixtureTool, 'echo'], env: {}, envUnset: [], stdinFile: spec.promptFile,
        files: [], projectFiles: [], spawnCwd: null, secretEnv: {}}),
      parse: result => ({ok: result.exitCode === 0, text: result.stdout.trim(),
        failureCode: result.exitCode === 0 ? null : 'tool_failed'}),
    };
    const matrix = structuredClone(TOOL_MATRIX);
    matrix.tools.find(value => value.key === 'codex')!.run = {adapter: 'codex', card: 'TLS-26', offered: true, platforms: {darwin: {accepted: true}, linux: {accepted: true}},
      folderOnly: 'os-sandbox', mcpLevel: 'servers-off', reason: null, checkedAt: '2026-10-23'};
    const native = (sessionGuardian ? nativeFixtureProcesses(async () => []) : undefined) ?? directFixtureProcesses();
    const processes: ProcessInspector = {...native, fencePids: async () => {await hooks.preparing?.(); return [];},
      inspectSync: (pid, deadline) => {
        spawns++; hooks.inspect?.(pid);
        return native.inspectSync!(pid, deadline);
      }};
    const options: RunnerOptions = {data: paths.data, connections: async () => [connection],
      localAgents: async () => [{agentId, aiToolId, cwd, access}], registry: new AdapterRegistry([adapter]), matrix,
      processes, verifiedBuild: stager.verifiedBuild, allowedBuild: stager.allowedBuild, skillDescription: stager.skillDescription,
      claimSkills: stager.claimSkills, releaseSkills: stager.releaseSkills,
      withSkillsFence: (claim, connection, action) => stager.withSkillsFence(claim, connection, release => action(async () => {
        await release(); await hooks.started?.();
      })),
      stageSkills: stager.stageSkills, deliver: async () => ({posted: posted()}), removeDeviceKey: async () => {}};
    const core = new RunnerCore(options); cores.push(core);
    const runDir = join(cwd, '.maddots', 'runs', runId), staged = join(runDir, 'skills', build.name, 'SKILL.md');
    const outcome = async () => (await new RunnerState(paths.data).pending()).find(value => value.runId === runId)!.body;
    return {core, hooks, adapter, claim, connection, staged, runDir, outcome, spawns: () => spawns};
  }
  return {root, cwd, paths, agentId, engine, stager, build, item, plan, skill, runner, gate, syncClock, runClock, track, settle};
}

function pauseStaging(t: TestContext, target: string, reached: {promise: Promise<void>; resolve: () => void},
  resume: {promise: Promise<void>; resolve: () => void}) {
  const original = promisesModule.open;
  let paused = false;
  promisesModule.open = (async (...args: Parameters<typeof original>) => {
    if (!paused && String(args[0]) === target) {
      paused = true; reached.resolve(); await resume.promise;
    }
    return original(...args);
  }) as typeof original;
  syncBuiltinESMExports();
  t.after(() => {promisesModule.open = original; syncBuiltinESMExports();});
}

for (const [phase, mutation] of [
  ['staging filesystem await', 'revoke/restore'], ['process preparation', 'revoke/restore'],
  ['staging filesystem await', 'archived removal'],
]) {
  test(`agent destination fence delays ${mutation} during ${phase} until actual spawn`, {skip: linuxNativeWorkloadSkip, timeout: linuxNativeFixtureTimeout(15_000)}, async t => {
    const f = await fixture(t), v1 = f.build(1), v2 = f.build(2);
    await f.engine.applyPlan(f.plan([f.item(v1)]));
    await f.engine.applyPlan(f.plan([f.item(v2, {kind: 'update', fromVersion: 1})]));
    const r = await f.runner(v2), reached = f.gate(), resume = f.gate(), waited = f.gate(), retry = f.gate();
    const spawned = deferred<number>(), started = f.gate(), prompt = f.gate();
    const originalSpawn = childProcessModule.spawn;
    let observedSpawn = false;
    childProcessModule.spawn = ((...args: Parameters<typeof originalSpawn>) => {
      const isAdapter = adapterSpawn(args, f.cwd);
      if (isAdapter) {
        assert.ok(readdirSync(join(f.paths.data, 'agent-fences')).some(name => name.endsWith('.lock')),
          'the destination fence must remain held at the actual spawn boundary');
        observedSpawn = true;
      }
      const child = originalSpawn(...args);
      if (isAdapter) {assert.ok(child.pid); spawned.resolve(child.pid);}
      return child;
    }) as typeof originalSpawn;
    syncBuiltinESMExports();
    t.after(() => {childProcessModule.spawn = originalSpawn; syncBuiltinESMExports();});
    // Lifetime capture now precedes the release callback. Pause after release
    // so sync can finish while the actual child still awaits its prompt.
    r.hooks.started = async () => {started.resolve(); await prompt.promise;};
    if (phase === 'staging filesystem await') pauseStaging(t, r.staged, reached, resume);
    else {
      let paused = false;
      r.hooks.preparing = async () => {if (!paused) {paused = true; reached.resolve(); await resume.promise;}};
    }
    f.syncClock.timing.sleep = async () => {waited.resolve(); await retry.promise;};
    await r.core.tick();
    await Promise.race([reached.promise, r.core.idle().then(async () => {throw new Error(`run ended before pause: ${JSON.stringify(await r.outcome())}`);})]);
    const revoked = mutation === 'revoke/restore' ? [{skillId: v2.skillId, digest: v2.digest}] : [];
    const sync = f.engine.applyPlan(mutation === 'revoke/restore' ?
      f.plan([f.item(v1, {kind: 'forced_restore', state: 'forced', reason: 'revoked'})], revoked) :
      f.plan([f.item(v2, {kind: 'forced_remove', state: 'forced', reason: 'archived'})]));
    await Promise.race([waited.promise,
      sync.then(() => {throw new Error('sync ended before waiting for the destination fence');}),
      r.core.idle().then(async () => {throw new Error(`run ended before sync waited for the destination fence: ${JSON.stringify(await r.outcome())}`);})]);
    assert.equal((await f.engine.agentLocks.read()).entries[0].version, 2);
    assert.equal((await f.engine.agentLocks.read()).entries[0].removed, undefined);
    assert.deepEqual(JSON.parse(await readFile(join(f.paths.data, 'sync-meta.json'), 'utf8')).revoked, []);
    resume.resolve();
    const pid = await Promise.race([spawned.promise, r.core.idle().then(async () => {throw new Error(`run ended before spawn: ${JSON.stringify(await r.outcome())}`);})]);
    await Promise.race([started.promise, r.core.idle().then(async () => {throw new Error(`run ended before fence release: ${JSON.stringify(await r.outcome())}`);})]);
    assert.equal(observedSpawn, true);
    retry.resolve(); await sync;
    assert.equal((await f.engine.agentLocks.read()).entries[0].version, mutation === 'revoke/restore' ? 1 : 2);
    assert.equal((await f.engine.agentLocks.read()).entries[0].removed, mutation === 'archived removal' ? true : undefined);
    assert.deepEqual(JSON.parse(await readFile(join(f.paths.data, 'sync-meta.json'), 'utf8')).revoked, revoked);
    assert.match(await readFile(r.staged, 'utf8'), /Version 2/);
    process.kill(pid, 0);
    assert.equal(r.core.busy, true, 'sync completes while the spawned process still awaits its prompt');
    prompt.resolve(); await r.core.idle();
    assert.equal((await r.outcome()).outcome, 'done');
  });
}

for (const mutation of ['revoke/restore', 'archived removal']) {
  test(`Linux guardian holds the destination fence until adapter start during ${mutation}`, {skip: linuxNativeWorkloadSkip || process.platform !== 'linux', timeout: linuxNativeFixtureTimeout(15_000)}, async t => {
    const f = await fixture(t), v1 = f.build(1), v2 = f.build(2);
    await f.engine.applyPlan(f.plan([f.item(v1)]));
    await f.engine.applyPlan(f.plan([f.item(v2, {kind: 'update', fromVersion: 1})]));
    const r = await f.runner(v2, true), reached = f.gate(), resume = f.gate(), waited = f.gate(), retry = f.gate();
    const hasFence = () => readdirSync(join(f.paths.data, 'agent-fences')).some(name => name.endsWith('.lock'));
    const launchOrder: {phase: string; held: boolean}[] = [];
    const originalSpawn = childProcessModule.spawn;
    childProcessModule.spawn = ((...args: Parameters<typeof originalSpawn>) => {
      const child = originalSpawn(...args);
      if (nativeGuardianSpawn(args) && Array.isArray(args[1])) {
        if (process.platform === 'darwin') assert(args[1].includes('--input-type=module'), 'the fixture must exercise the Linux guardian');
        else assert(args[1].includes(LINUX_GUARDIAN), 'the fixture must exercise the packaged Linux guardian');
        launchOrder.push({phase: 'guardian spawn', held: hasFence()});
        const control = child.stdio[4] as Duplex;
        holdLinuxFixtureStart(control, () => {
          launchOrder.push({phase: 'start request', held: hasFence()}); reached.resolve();
        }, resume.promise);
        child.on('message', message => {
          if (message && typeof message === 'object' && 'type' in message && message.type === 'tool-start') {
            launchOrder.push({phase: 'adapter start', held: hasFence()});
          }
        });
      }
      return child;
    }) as typeof originalSpawn;
    syncBuiltinESMExports();
    t.after(() => {childProcessModule.spawn = originalSpawn; syncBuiltinESMExports();});
    f.syncClock.timing.sleep = async () => {waited.resolve(); await retry.promise;};
    let sync: Promise<unknown> | undefined;
    try {
      await r.core.tick();
      await Promise.race([reached.promise, r.core.idle().then(() => {throw new Error('run ended before guardian start request');})]);
      assert.deepEqual(launchOrder, [{phase: 'guardian spawn', held: true}, {phase: 'start request', held: true}]);
      assert.equal(hasFence(), true, 'guardian preparation must not release the skill fence before adapter start');
      const revoked = mutation === 'revoke/restore' ? [{skillId: v2.skillId, digest: v2.digest}] : [];
      sync = f.engine.applyPlan(mutation === 'revoke/restore' ?
        f.plan([f.item(v1, {kind: 'forced_restore', state: 'forced', reason: 'revoked'})], revoked) :
        f.plan([f.item(v2, {kind: 'forced_remove', state: 'forced', reason: 'archived'})]));
      await Promise.race([waited.promise,
        sync.then(() => {throw new Error('sync ended before waiting for the guardian destination fence');}),
        r.core.idle().then(async () => {throw new Error(`run ended before sync waited for the guardian destination fence: ${JSON.stringify(await r.outcome())}`);})]);
      assert.equal((await f.engine.agentLocks.read()).entries[0].version, 2);
      assert.equal((await f.engine.agentLocks.read()).entries[0].removed, undefined);
      assert.deepEqual(JSON.parse(await readFile(join(f.paths.data, 'sync-meta.json'), 'utf8')).revoked, []);
      resume.resolve(); await r.core.idle();
      assert.deepEqual(launchOrder, [
        {phase: 'guardian spawn', held: true}, {phase: 'start request', held: true}, {phase: 'adapter start', held: true},
      ]);
      assert.equal(hasFence(), false);
      assert.equal((await r.outcome()).outcome, 'done');
      retry.resolve(); await sync;
      assert.equal((await f.engine.agentLocks.read()).entries[0].version, mutation === 'revoke/restore' ? 1 : 2);
      assert.equal((await f.engine.agentLocks.read()).entries[0].removed, mutation === 'archived removal' ? true : undefined);
      assert.deepEqual(JSON.parse(await readFile(join(f.paths.data, 'sync-meta.json'), 'utf8')).revoked, revoked);
    } finally {
      resume.resolve(); retry.resolve();
      await r.core.idle(); await sync;
    }
  });
}

for (const failure of ['guardian identity', 'adapter spawn']) {
  test(`Linux ${failure} failure releases the destination fence for the next sync`, {skip: linuxNativeWorkloadSkip || process.platform !== 'linux', timeout: linuxNativeFixtureTimeout(10_000)}, async t => {
    const f = await fixture(t), v1 = f.build(1), v2 = f.build(2);
    await f.engine.applyPlan(f.plan([f.item(v1)]));
    const r = await f.runner(v1, true);
    const identity = t.mock.method(r.adapter, 'identity');
    const started = t.mock.fn(async () => {}); r.hooks.started = started;
    const guardians: ReturnType<typeof childProcessModule.spawn>[] = [];
    const messages: string[] = [];
    let startRequests = 0;
    const originalSpawn = childProcessModule.spawn;
    childProcessModule.spawn = ((...args: Parameters<typeof originalSpawn>) => {
      const child = originalSpawn(...args);
      if (nativeGuardianSpawn(args)) {
        guardians.push(child);
        holdLinuxFixtureStart(child.stdio[4] as Duplex, () => {
          startRequests++;
          assert(readdirSync(join(f.paths.data, 'agent-fences')).some(name => name.endsWith('.lock')),
            'the destination fence must remain held through workload dispatch');
        }, Promise.resolve());
        child.on('message', message => {
          if (message && typeof message === 'object' && 'type' in message) messages.push(String(message.type));
        });
      }
      return child;
    }) as typeof originalSpawn;
    syncBuiltinESMExports();
    t.after(() => {childProcessModule.spawn = originalSpawn; syncBuiltinESMExports();});
    if (failure === 'guardian identity') {
      let failed = false;
      r.hooks.inspect = () => {if (!failed) {failed = true; throw new Error('fixture guardian identity failed');}};
    } else {
      // This fixture's identity adapter admits the executable without probing
      // it. The missing interpreter fails only at the contained workload exec.
      const bin = join(f.root, 'missing-interpreter');
      await writeFile(bin, '#!/nonexistent/mdai-fixture-interpreter\n', {mode: 0o700});
      r.connection.bin = bin; r.connection.realpath = bin;
    }
    await r.core.tick(); await r.core.idle();
    assert.equal((await r.outcome()).code, failure === 'guardian identity' ? 'adapter_refused' : 'tool_not_found');
    assert.equal(identity.mock.callCount(), 1, 'adapter identity must pass before either native failure');
    assert.deepEqual(await identity.mock.calls[0].result, {ok: true, version: '1.0.0'});
    assert.equal(startRequests, failure === 'guardian identity' ? 0 : 1);
    assert.equal(messages.includes('exec-error'), failure === 'adapter spawn', 'only the workload exec failure has an explicit exec-error');
    assert.equal(messages.includes('tool-start'), false);
    assert.equal(started.mock.callCount(), 0, 'failed exec must not release the fence through the successful-start callback');
    assert.equal(guardians.length, 1);
    assert(guardians.every(child => child.exitCode !== null || child.signalCode !== null), 'the guardian must exit before failure completes');
    assert.equal(readdirSync(join(f.paths.data, 'agent-fences')).filter(name => name.endsWith('.lock')).length, 0);
    await f.engine.applyPlan(f.plan([f.item(v2, {kind: 'update', fromVersion: 1})]));
    assert.deepEqual(f.syncClock.sleeps, [], 'the next sync acquires the released destination immediately');
    assert.equal((await f.engine.agentLocks.read()).entries[0].version, 2);
  });
}

test('archived removal after the acceptance snapshot refuses the claimed run before staging or spawn', {timeout: 10_000}, async t => {
  qualifyLinuxFixtureWithoutWorkloads(t);
  const f = await fixture(t), v1 = f.build(1); await f.engine.applyPlan(f.plan([f.item(v1)]));
  const r = await f.runner(v1), reached = f.gate(), resume = f.gate();
  r.hooks.card = async () => {reached.resolve(); await resume.promise;};
  await r.core.tick();
  await Promise.race([reached.promise, r.core.idle().then(async () => {throw new Error(`run ended before card read: ${JSON.stringify(await r.outcome())}`);})]);
  await f.engine.applyPlan(f.plan([f.item(v1, {kind: 'forced_remove', state: 'forced', reason: 'archived'})]));
  assert.equal((await f.engine.agentLocks.read()).entries[0].removed, true);
  resume.resolve(); await r.core.idle();
  assert.equal((await r.outcome()).code, 'skills_not_ready'); assert.equal(r.spawns(), 0);
  await assert.rejects(lstat(r.staged), {code: 'ENOENT'});
});

test('a healthy accepted update before final fencing still stages the claimed v1 envelope', {skip: linuxNativeWorkloadSkip, timeout: linuxNativeFixtureTimeout(10_000)}, async t => {
  const f = await fixture(t), v1 = f.build(1), v2 = f.build(2); await f.engine.applyPlan(f.plan([f.item(v1)]));
  const r = await f.runner(v1), reached = f.gate(), resume = f.gate();
  r.hooks.card = async () => {reached.resolve(); await resume.promise;};
  await r.core.tick();
  await Promise.race([reached.promise, r.core.idle().then(async () => {throw new Error(`run ended before card read: ${JSON.stringify(await r.outcome())}`);})]);
  await f.engine.applyPlan(f.plan([f.item(v2, {kind: 'update', fromVersion: 1})]));
  resume.resolve(); await r.core.idle();
  assert.equal((await r.outcome()).outcome, 'done');
  assert.equal((await f.engine.agentLocks.read()).entries[0].version, 2);
  assert.match(await readFile(r.staged, 'utf8'), /Version 1/);
  assert.doesNotMatch(await readFile(r.staged, 'utf8'), /Version 2/);
});

test('sync destination timeout fails HELPER_BUSY before publishing revocation or changing acceptance', {skip: linuxNativeWorkloadSkip, timeout: linuxNativeFixtureTimeout(10_000)}, async t => {
  const f = await fixture(t), v1 = f.build(1); await f.engine.applyPlan(f.plan([f.item(v1)]));
  const r = await f.runner(v1), reached = f.gate(), resume = f.gate();
  pauseStaging(t, r.staged, reached, resume);
  await r.core.tick();
  await Promise.race([reached.promise, r.core.idle().then(async () => {throw new Error(`run ended before staging: ${JSON.stringify(await r.outcome())}`);})]);
  const before = await readFile(join(f.paths.data, 'sync-meta.json'), 'utf8');
  await assert.rejects(f.engine.applyPlan(f.plan([], [{skillId: v1.skillId, digest: v1.digest}])), {code: 'HELPER_BUSY'});
  assert.equal(await readFile(join(f.paths.data, 'sync-meta.json'), 'utf8'), before);
  assert.equal((await f.engine.agentLocks.read()).entries[0].version, 1);
  assert.equal(f.syncClock.sleeps.reduce((sum, value) => sum + value, 0), 10_000);
  resume.resolve(); await r.core.idle();
  assert.equal((await r.outcome()).outcome, 'done');
});

test('runner destination timeout while sync holds the fence fails skills_not_ready without staging or spawning', {timeout: 10_000}, async t => {
  qualifyLinuxFixtureWithoutWorkloads(t);
  const f = await fixture(t), v1 = f.build(1), v2 = f.build(2); await f.engine.applyPlan(f.plan([f.item(v1)]));
  const r = await f.runner(v1), card = f.gate(), resumeCard = f.gate(), syncing = f.gate(), resumeSync = f.gate();
  r.hooks.card = async () => {card.resolve(); await resumeCard.promise;};
  await r.core.tick();
  await Promise.race([card.promise, r.core.idle().then(async () => {throw new Error(`run ended before card read: ${JSON.stringify(await r.outcome())}`);})]);
  const sync = f.engine.applyPlan(f.plan([f.item(v2, {kind: 'update', fromVersion: 1})]), async () => {
    syncing.resolve(); await resumeSync.promise;
  });
  await Promise.race([syncing.promise,
    sync.then(() => {throw new Error('sync ended before entering the held destination fence');}),
    r.core.idle().then(async () => {throw new Error(`run ended before sync entered the destination fence: ${JSON.stringify(await r.outcome())}`);})]);
  resumeCard.resolve(); await r.core.idle();
  assert.equal((await r.outcome()).code, 'skills_not_ready'); assert.equal(r.spawns(), 0);
  await assert.rejects(lstat(r.staged), {code: 'ENOENT'});
  assert.equal(f.runClock.sleeps.reduce((sum, value) => sum + value, 0), 10_000);
  resumeSync.resolve(); await sync;
  assert.equal((await f.engine.agentLocks.read()).entries[0].version, 2);
});

test('destination fences serialize the same agent copy and allow independent agents and destinations', {timeout: 10_000}, async t => {
  const f = await fixture(t), v1 = f.build(1), destination = {agentId: f.agentId, skillId: v1.skillId, target: v1.target, name: v1.name};
  const held = f.gate(), release = f.gate();
  const first = f.track(withAgentDestinationLocks(f.paths, [destination], async () => {held.resolve(); await release.promise;}));
  await held.promise;
  for (const changed of [{agentId: randomUUID()}, {name: 'other'}, {target: 'claude-plugin' as const}]) {
    let entered = false;
    await withAgentDestinationLocks(f.paths, [{...destination, ...changed}], async () => {entered = true;}, f.runClock.timing);
    assert.equal(entered, true);
  }
  let entered = false;
  await assert.rejects(withAgentDestinationLocks(f.paths, [destination], async () => {entered = true;}, f.runClock.timing), {code: 'HELPER_BUSY'});
  assert.equal(entered, false);
  release.resolve(); await first;
  await withAgentDestinationLocks(f.paths, [destination], async release => {await release(); await release(); entered = true;});
  assert.equal(entered, true);
});

test('pre-spawn process refusal releases the destination fence for the next sync', {timeout: 10_000}, async t => {
  qualifyLinuxFixtureWithoutWorkloads(t);
  const f = await fixture(t), v1 = f.build(1), v2 = f.build(2); await f.engine.applyPlan(f.plan([f.item(v1)]));
  const r = await f.runner(v1);
  let refused = false;
  r.adapter.preflight = async () => {
    assert(readdirSync(join(f.paths.data, 'agent-fences')).some(name => name.endsWith('.lock')),
      'executable preflight must run only after the claimed destination fence is held');
    refused = true;
    return {ok: false, reason: 'fixture refusal before spawn'};
  };
  await r.core.tick(); await r.core.idle();
  assert.equal(refused, true);
  assert.equal((await r.outcome()).code, 'adapter_refused'); assert.equal(r.spawns(), 0);
  assert.equal(readdirSync(join(f.paths.data, 'agent-fences')).filter(name => name.endsWith('.lock')).length, 0);
  await f.engine.applyPlan(f.plan([f.item(v2, {kind: 'update', fromVersion: 1})]));
  assert.equal((await f.engine.agentLocks.read()).entries[0].version, 2);
  assert.deepEqual(f.syncClock.sleeps, []);
});

test('late fence cleanup after early spawn release preserves the replacement owner', {timeout: 10_000}, async t => {
  const f = await fixture(t), v1 = f.build(1), destination = {agentId: f.agentId, skillId: v1.skillId, target: v1.target, name: v1.name};
  const released = f.gate(), finishFirst = f.gate(), replacementHeld = f.gate(), finishReplacement = f.gate();
  const first = f.track(withAgentDestinationLocks(f.paths, [destination], async release => {
    await release(); released.resolve(); await finishFirst.promise;
  }));
  await released.promise;
  const replacement = f.track(withAgentDestinationLocks(f.paths, [destination], async () => {
    replacementHeld.resolve(); await finishReplacement.promise;
  }));
  await replacementHeld.promise; finishFirst.resolve(); await first;
  let entered = false;
  await assert.rejects(withAgentDestinationLocks(f.paths, [destination], async () => {entered = true;}, f.runClock.timing), {code: 'HELPER_BUSY'});
  assert.equal(entered, false, 'the original finally must not unlink the replacement lock');
  finishReplacement.resolve(); await replacement;
  await withAgentDestinationLocks(f.paths, [destination], async () => {entered = true;});
  assert.equal(entered, true);
});

test('destination fence fixture joins released actions before their final lock cleanup', {timeout: 10_000}, async t => {
  const f = await fixture(t), v1 = f.build(1), destination = {agentId: f.agentId, skillId: v1.skillId, target: v1.target, name: v1.name};
  const released = f.gate(), finish = f.gate();
  f.track(withAgentDestinationLocks(f.paths, [destination], async release => {
    await release(); released.resolve(); await finish.promise;
  }));
  await released.promise;
  // An early release is not completion of the action or its outer finally.
  await assert.rejects(f.settle(10), /fixture work did not settle/u);
  assert.equal((await lstat(f.root)).isDirectory(), true);
  finish.resolve(); await f.settle();
  assert.equal(readdirSync(join(f.paths.data, 'agent-fences')).filter(name => name.endsWith('.lock')).length, 0);
});
