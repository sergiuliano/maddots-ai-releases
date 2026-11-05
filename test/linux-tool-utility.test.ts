import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {HelperError} from '../src/config.js';
import {detectTools} from '../src/detect.js';
import {TOOL_MATRIX} from '../src/shared/tool-matrix.js';
import {runPackageCommand} from '../src/npm.js';
import {withLinuxRunContext} from '../src/runner/linux-lifecycle.js';
import {cleanLinuxToolEnvironment} from '../src/runner/linux-containment.js';
import {RunnerStorageOwner} from '../src/runner/storage-owner.js';
import {runToolCommand} from '../src/tool-command.js';
import {executeAdapterProbe} from '../src/runner/adapter.js';
import {withClaimedToolCommands} from '../src/tool-command.js';
import {initializeCleanRunnerJournal} from './support/runner-journal-fixture.js';

test('Linux tool utilities refuse before any child launch, including package commands', {skip: process.platform !== 'linux'}, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-utility-refusal-')), data = join(root, 'data');
  await mkdir(data, {mode: 0o700}); await initializeCleanRunnerJournal(data);
  t.after(() => rm(root, {recursive: true, force: true}));
  // Fault the retained backend acquisition itself. The real owner, journal
  // replay and wrapper remain in use; no availability flag enables execution.
  const backend = t.mock.method(RunnerStorageOwner.prototype, 'getLinuxContainment', async () => {
    throw new HelperError('LINUX_CONTAINMENT_UNAVAILABLE', 'The fixture backend is unavailable.');
  });
  const execution = t.mock.method(childProcess, 'execFile', () => {throw new Error('utility launched outside containment');});
  syncBuiltinESMExports();
  t.after(() => {execution.mock.restore(); syncBuiltinESMExports();});
  await withLinuxRunContext(data, async () => {
    await assert.rejects(runToolCommand('/not-executed/tool', ['--version']), {code: 'TOOL_PLATFORM_NOT_ACCEPTED'});
    await assert.rejects(runToolCommand('/not-executed/tool', ['--help'], {timeout: 1000, env: {HOME: '/not-mounted'}}),
      {code: 'TOOL_PLATFORM_NOT_ACCEPTED'});
    await assert.rejects(runPackageCommand('/not-executed/npm', ['config', 'list', '--json'], {cwd: '/tmp', env: {}, timeout: 1000}),
      {code: 'TOOL_PLATFORM_NOT_ACCEPTED'});
    // A claimed context and closed profile alone cannot reach containment.
    // Job4 also requires the opaque, authenticated operation handle.
    await assert.rejects(withClaimedToolCommands({tool: 'codex', file: '/not-executed/tool', contained: true,
      deadline: Date.now() + 10_000}, () => executeAdapterProbe(runToolCommand, 'codex.version', '/not-executed/tool')),
    {code: 'TOOL_PLATFORM_NOT_ACCEPTED'});
    assert.equal(backend.mock.callCount(), 0);
    // Accepted fixture metadata exercises the separate containment boundary
    // without manufacturing candidate authority or trusting a release test key.
    const matrix = structuredClone(TOOL_MATRIX);
    matrix.tools.find(tool => tool.key === 'codex')!.run!.platforms = {linux: {accepted: true}};
    await assert.rejects(executeAdapterProbe(runToolCommand, 'codex.version', '/not-executed/tool', undefined, {matrix}),
    {code: 'LINUX_CONTAINMENT_UNAVAILABLE'});
    assert.equal(backend.mock.callCount(), 1);
  });
  assert.equal(execution.mock.callCount(), 0);
});

test('accepted Linux detection surfaces containment refusal instead of reporting an installed tool absent', async t => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'mdai-detection-refusal-')), bin = join(home, 'dsh');
  t.after(() => rm(home, {recursive: true, force: true}));
  await writeFile(bin, '#!/not-executed/interpreter\n', {mode: 0o700});
  const matrix = structuredClone(TOOL_MATRIX), tool = matrix.tools.find(tool => tool.key === 'deepseek-harness')!;
  matrix.tools = [tool]; tool.variants = [tool.variants.find(variant => variant.key === 'cli')!];
  tool.run!.platforms = {linux: {accepted: true}};
  tool.variants[0].detect.binaries = [bin];
  const unavailable = new HelperError('LINUX_CONTAINMENT_UNAVAILABLE', 'The dedicated controller service is unavailable.');
  await assert.rejects(detectTools({home, matrix, env: {}, platform: 'linux', runner: async () => {throw unavailable;}}),
    error => error === unavailable);
});

test('accepted Linux detection builds a utility environment without controller service settings', async t => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'mdai-detection-service-env-')), bin = join(home, 'dsh');
  t.after(() => rm(home, {recursive: true, force: true}));
  await writeFile(bin, '#!/not-executed/interpreter\n', {mode: 0o700});
  const matrix = structuredClone(TOOL_MATRIX), tool = matrix.tools.find(tool => tool.key === 'deepseek-harness')!;
  matrix.tools = [tool]; tool.variants = [tool.variants.find(variant => variant.key === 'cli')!];
  tool.run!.platforms = {linux: {accepted: true}};
  tool.variants[0].detect.binaries = [bin];
  const serviceEnvironment = {HOME: '/var/lib/mdai/home', PATH: '/usr/local/libexec/mdai:/usr/bin:/bin',
    MADDOTS_AI_HOME: '/var/lib/mdai/data', MADDOTS_AI_URL: 'https://ai.maddots.app', XDG_CONFIG_HOME: '/var/lib/mdai/config',
    XDG_STATE_HOME: '/var/lib/mdai/state', XDG_RUNTIME_DIR: '/run/mdai-helper', LANG: 'C.UTF-8', TERM: 'dumb'};
  let received: NodeJS.ProcessEnv | undefined;
  const detected = await detectTools({home, matrix, env: serviceEnvironment, platform: 'linux', runner: async (_file, _args, options) => {
    received = options?.env;
    cleanLinuxToolEnvironment(received ?? {}, '/work');
    return {stdout: '1.2.3\n', stderr: ''};
  }});
  assert.equal(detected[0]?.version, '1.2.3');
  for (const name of ['MADDOTS_AI_HOME', 'MADDOTS_AI_URL', 'XDG_RUNTIME_DIR', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME']) {
    assert.equal(Object.hasOwn(received!, name), false, `${name} must stay in the controller`);
  }
  assert.equal(received?.PATH, serviceEnvironment.PATH, 'host PATH is still available for executable discovery');
  assert.equal(received?.HOME, home);
  assert.equal(received?.LANG, 'C.UTF-8');
  assert.equal(serviceEnvironment.MADDOTS_AI_HOME, '/var/lib/mdai/data', 'constructing utility input must not mutate the service environment');
});
