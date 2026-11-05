import assert from 'node:assert/strict';
import {lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import test, {type TestContext} from 'node:test';
import type {HelperPaths} from '../src/paths.js';
import type {RunnerOptions} from '../src/runner/runner.js';
import {installLocalCliGraph} from './fixtures/local-installed-graph.js';

const helper = dirname(fileURLToPath(new URL('../src/paths.ts', import.meta.url)));
const identity = {repository: 'fixture/helper', workflowPath: '.github/workflows/helper-release.yml',
  allowedSigner: 'fixture-only signer', releasePrefix: 'helper-', assetName: 'helper.tgz'};

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-run-storage-admission-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const home = join(root, 'home'), installed = join(root, 'installed');
  await mkdir(home, {mode: 0o700});
  await installLocalCliGraph(helper, installed, (path, text) => path === join(helper, 'release-identity.ts') ?
    text.replace('export const RELEASE_IDENTITY: Readonly<ReleaseIdentity> | null = null;',
      'export const RELEASE_IDENTITY: Readonly<ReleaseIdentity> | null = ' + JSON.stringify(identity) + ';') : text);
  const load = (name: string) => import(pathToFileURL(join(installed, 'dist', name + '.js')).href);
  const pathsModule = await load('paths') as typeof import('../src/paths.js');
  const config = await load('config') as typeof import('../src/config.js');
  const paths = await pathsModule.createPaths(config.readConfig({}, home, 'linux'));
  return {root, home, installed, paths, load};
}

async function snapshot(root: string): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  async function visit(path: string) {
    const info = await lstat(path);
    result[path] = {dev: info.dev, ino: info.ino, mode: info.mode, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs,
      ...(info.isFile() ? {bytes: await readFile(path)} : {})};
    if (info.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(join(path, name));
  }
  await visit(root); return result;
}

async function operations(f: Awaited<ReturnType<typeof fixture>>, paths: HelperPaths) {
  const {writeServiceHeartbeat} = await f.load('service') as typeof import('../src/service.js');
  const {RunnerCore} = await f.load('runner/runner') as typeof import('../src/runner/runner.js');
  const {RunsOnController} = await f.load('runner/runs-on') as typeof import('../src/runner/runs-on.js');
  const {recoverTestRuns} = await f.load('runner/test-run') as typeof import('../src/runner/test-run.js');
  const {withAgentDestinationLocks} = await f.load('agent-fence') as typeof import('../src/agent-fence.js');
  const {reserveWaitingDialog, interruptWaitingDialog} = await f.load('notify') as typeof import('../src/notify.js');
  const {FileSecretStore} = await f.load('secret-store') as typeof import('../src/secret-store.js');
  const unreachable = () => assert.fail('coverage refusal must precede run callbacks');
  const runnerOptions = {data: paths.data, connections: unreachable, localAgents: unreachable,
    registry: {get: unreachable}, verifiedBuild: unreachable, allowedBuild: unreachable,
    stageSkills: unreachable, deliver: unreachable, removeDeviceKey: unreachable} as unknown as RunnerOptions;
  const activationOptions = {paths, keys: {ensure: unreachable, get: unreachable, remove: unreachable, registerExisting: unreachable},
    connection: unreachable, protocol: unreachable, test: unreachable};
  return [
    {name: 'heartbeat', fullPaths: true, run: () => writeServiceHeartbeat(paths)},
    {name: 'destination fence', fullPaths: true, run: () => withAgentDestinationLocks(paths,
      [{agentId: 'fixture-agent', skillId: 'fixture-skill', target: 'folder', name: 'fixture-skill'}], unreachable)},
    {name: 'notification reservation', fullPaths: true, run: () => reserveWaitingDialog(paths,
      [{skillId: 'fixture-skill', version: 1, digests: ['a'.repeat(64)]}])},
    {name: 'notification interruption', fullPaths: true, run: () => interruptWaitingDialog(paths,
      {count: 1, command: 'maddots-ai allow', fingerprint: 'a'.repeat(64), reservedAt: 1})},
    {name: 'credential directory', fullPaths: true, run: () => FileSecretStore.open(join(paths.home, 'token-store', 'credentials.json'),
      paths, {explicit: true, confirmed: true})},
    {name: 'core', run: async () => {
      const core = new RunnerCore(runnerOptions);
      try {await core.init();} finally {await core.close();}
    }},
    {name: 'activation', run: async () => {
      const controller = new RunsOnController(activationOptions);
      try {await controller.snapshot();} finally {await controller.close();}
    }},
    {name: 'diagnostic recovery', run: () => recoverTestRuns({data: paths.data})},
  ];
}

test('installed public run and heartbeat entrypoints refuse an unfinished upgrade before creating private storage', {
  skip: process.platform !== 'linux', timeout: 20_000,
}, async t => {
  const f = await fixture(t), calls = await operations(f, f.paths);
  const before = await snapshot(f.root);
  for (const call of calls) for (let retry = 0; retry < 2; retry++) {
    await assert.rejects(call.run(), {code: call.name === 'core' ? 'RUNNER_STATE_UNAVAILABLE' : 'HELPER_BUSY'}, call.name);
    assert.deepEqual(await snapshot(f.root), before, call.name + ' preserves missing storage and installed bytes');
  }
});

test('installed data-only run owners cannot register a new data root or populate it before refusal', {
  skip: process.platform !== 'linux', timeout: 20_000,
}, async t => {
  const f = await fixture(t), directory = join(f.installed, '.write-lock-upgrade'), known = join(f.home, 'registered-data');
  await mkdir(directory, {mode: 0o700});
  const state = {protocol: 3, revision: 3, linuxSourcePolicy: 'released-only-v1', bootstrap: f.installed,
    homes: [f.home], data: [known], storage: [{data: known, roots: [known], states: [join(known, 'state.json')],
      units: [join(f.home, '.config/systemd/user/app.maddots.ai.helper.service')]}],
    sources: Object.fromEntries(['linux-proc.js', 'process-image.js', 'write-lock-retirement.js', 'write-lock-recovery.js',
      'write-lock-upgrade.js', 'write-lock.js'].map(name => [name, 'a'.repeat(64)]))};
  await writeFile(join(directory, 'state.json'), JSON.stringify(state) + '\n', {mode: 0o600});
  await writeFile(join(f.installed, 'dist/.write-lock-upgrade.json'), JSON.stringify({directory}) + '\n', {mode: 0o600});
  const calls = (await operations(f, f.paths)).filter(call => !call.fullPaths);
  const before = await snapshot(f.root);
  for (const call of calls) for (let retry = 0; retry < 2; retry++) {
    await assert.rejects(call.run(), {code: call.name === 'core' ? 'RUNNER_STATE_UNAVAILABLE' : 'PATH_UNSAFE'}, call.name);
    assert.deepEqual(await snapshot(f.root), before, call.name + ' cannot extend coverage or contaminate an unregistered root');
  }
  const {canonicalRunnerStorageDirectory} = await f.load('runner/storage-lock') as typeof import('../src/runner/storage-lock.js');
  let discovered = 0;
  await assert.rejects(canonicalRunnerStorageDirectory(f.paths.data, () => {discovered++;}), {code: 'PATH_UNSAFE'});
  assert.equal(discovered, 0, 'an unregistered canonical directory is not recorded as discovered');
  assert.deepEqual(await snapshot(f.root), before, 'refused discovery cannot recreate even a missing coordinator guard');
  const retained = join(f.paths.stateDir!, 'retained.json');
  await mkdir(f.paths.stateDir!, {recursive: true, mode: 0o700});
  await writeFile(retained, 'retained publication\n', {mode: 0o600});
  const withRetained = await snapshot(f.root), fullPaths = (await operations(f, f.paths)).filter(call => call.fullPaths);
  for (const call of fullPaths) for (let retry = 0; retry < 2; retry++) {
    await assert.rejects(call.run(), {code: 'LINUX_LOCK_RETIREMENT_UNVERIFIED'}, call.name);
    assert.deepEqual(await snapshot(f.root), withRetained, call.name + ' cannot bless a nonempty unregistered state root');
  }
});
