import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {TOOL_MATRIX} from '../src/shared/tool-matrix.js';
import {runToolCommand, withClaimedToolCommands} from '../src/tool-command.js';
import {executeAdapterProbe, type Adapter, type RunSpec} from '../src/runner/adapter.js';
import {withLinuxRunContext} from '../src/runner/linux-lifecycle.js';
import type {StartToolOptions} from '../src/runner/process.js';
import {initializeCleanRunnerJournal} from './support/runner-journal-fixture.js';
import {cleanupNativeFixtureRoot, linuxNativeWorkloadSkip, observeNativeLinuxWorkloads, startNativeFixtureTool, waitForNativeFixtureState} from './support/linux-native-workloads.js';
import {CODEX_FIXTURE_PROVIDER} from './support/codex-local-provider-fixture.js';

const nativeOptions = {skip: process.platform !== 'linux' ? 'Native Linux service fixture required' : linuxNativeWorkloadSkip, timeout: 120_000};
const wait = (milliseconds: number) => new Promise<void>(done => setTimeout(done, milliseconds));
async function within<T>(work: Promise<T>, milliseconds = 90_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {return await Promise.race([work, new Promise<never>((_done, reject) => {timer = setTimeout(() => reject(new Error('Native Linux startup exceeded its bound.')), milliseconds);})]);}
  finally {clearTimeout(timer);}
}

async function fixture(t: TestContext, source: string) {
  const workspace = await mkdtemp(join(await realpath(tmpdir()), 'mdai-s3-native-work-'));
  const data = await mkdtemp(join(await realpath(tmpdir()), 'mdai-s3-native-data-'));
  const runDir = join(workspace, '.maddots', 'runs', 'fixture');
  await mkdir(runDir, {recursive: true});
  const promptFile = join(runDir, 'prompt.md'), script = join(workspace, 'fixture.mjs');
  await writeFile(promptFile, 'isolated fixture task'); await writeFile(script, source);
  await initializeCleanRunnerJournal(data);
  const bin = await realpath(process.execPath);
  const matrix = structuredClone(TOOL_MATRIX);
  Object.assign(matrix.tools.find(tool => tool.key === 'codex')!.run!, {offered: true, platforms: {darwin: {accepted: true}, linux: {accepted: true}}, folderOnly: 'os-sandbox'});
  const adapter: Adapter = {
    info: {tool: 'codex', harness: 'codex', card: 'TLS-26', folderOnly: 'os-sandbox', mcpLevel: 'servers-off',
      skillsDir: '{runDir}/skills', promptVia: 'stdin', runHome: false},
    identity: async () => ({ok: true, version: 'isolated-native-fixture'}), supports: () => ({ok: true, reason: null}),
    build: spec => ({argv: [spec.bin, script], env: {CI: 'fixture'}, envUnset: [], stdinFile: spec.promptFile,
      files: [], projectFiles: [], spawnCwd: null, secretEnv: {}}),
    parse: output => ({ok: output.exitCode === 0, text: output.stdout.trim(), failureCode: output.exitCode === 0 ? null : 'tool_failed'}),
  };
  const spec: RunSpec = {bin, cwd: workspace, runDir, promptFile, model: 'fixture', provider: CODEX_FIXTURE_PROVIDER, effort: null,
    access: 'full_access', skillsDir: join(runDir, 'skills'), maxTurns: 50, timeoutSeconds: 0, runHome: null};
  const empty: boolean[] = [], proofs: unknown[] = [];
  const cancellation = new AbortController(), outstanding: Promise<unknown>[] = [];
  const track = <T>(work: Promise<T>): Promise<T> => {
    outstanding.push(work); void work.catch(() => {}); return work;
  };
  let retired = false;
  const observer = observeNativeLinuxWorkloads(t, {empty: (_run, value) => {empty.push(value);}, proof: (_run, proof) => {proofs.push(proof);}});
  t.after(async () => {
    cancellation.abort();
    try {
      await within((async () => {
        await observer.cleanup();
        await Promise.allSettled(outstanding);
      })(), 50_000);
      // Join startup, utility and outer owner completion before replay or
      // removal. A teardown KILL alone cannot retire an unresolved intent.
      if (retired) {
        await cleanupNativeFixtureRoot(t, workspace, data, async () => {});
        await rm(data, {recursive: true, force: true});
      } else t.diagnostic(`Retained unresolved native fixture evidence at ${workspace} (journal: ${data}).`);
    } catch (error) {
      t.diagnostic(`Retained unresolved native fixture evidence at ${workspace} (journal: ${data}).`);
      throw error;
    }
  });
  const launch = (extra: Partial<StartToolOptions> = {}) => {
    const signal = extra.signal ? AbortSignal.any([cancellation.signal, extra.signal]) : cancellation.signal;
    const starting = startNativeFixtureTool(data, {adapter, spec, matrix,
      claimedAt: Date.now(), expiresAt: Date.now() + 7_200_000, maxRunMinutes: 1, ...extra, signal}).then(running => {
      const finished = running.finished.then(result => {retired = true; return result;});
      return {...running, finished};
    });
    track(starting.then(running => running.finished));
    return starting;
  };
  const identity = () => track(withLinuxRunContext(data, () => withClaimedToolCommands({tool: 'codex', file: bin,
    contained: true, matrix, deadline: Date.now() + 30_000, signal: cancellation.signal},
  () => executeAdapterProbe(runToolCommand, 'codex.version', bin, {signal: cancellation.signal}, {cwd: workspace}))).then(result => {
    retired = true; return result;
  }));
  return {workspace, runDir, observer, empty, proofs, launch, identity};
}

test('S3 native tool identity command keeps network bridge diagnostics out of collected stderr', nativeOptions, async t => {
  const f = await fixture(t, '');
  const result = await within(f.identity());
  assert.deepEqual(result, {stdout: `${process.version}\n`, stderr: ''});
  assert(f.empty.includes(true)); assert.equal(f.proofs.length, 1);
});

test('S3 native startTool receives stdin, publishes output only after retained empty proof and keeps credentials private', nativeOptions, async t => {
  const f = await fixture(t, `
    import {writeFileSync} from 'node:fs';
    let input = '';
    process.stdin.on('data', chunk => {input += chunk;});
    process.stdin.on('end', () => {
      writeFileSync('result.txt', 'published after CLEAN');
      console.log(JSON.stringify({input, cwd: process.cwd(), ci: process.env.CI,
        ssh: process.env.SSH_AUTH_SOCK ?? null, token: process.env.MADDOTS_TOKEN ?? null}));
    });
  `);
  const running = await f.launch(), result = await within(running.finished);
  assert.equal(result.ok, true); assert.equal(result.stopped, false);
  assert.deepEqual(JSON.parse(result.text), {input: 'isolated fixture task', cwd: '/work', ci: 'fixture', ssh: null, token: null});
  assert.equal(await readFile(join(f.workspace, 'result.txt'), 'utf8'), 'published after CLEAN');
  assert(f.empty.includes(true)); assert.equal(f.proofs.length, 1, 'the actual registered backend produced the retirement proof');
  assert.equal((await stat(join(f.runDir, 'stdout.log'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.runDir, 'stderr.log'))).mode & 0o777, 0o600);
  assert.equal(await readFile(join(f.runDir, 'stderr.log'), 'utf8'), '', 'network bridge diagnostics must not enter the tool stderr log');
});

test('S3 native startTool stop uses its original containment and returns only after registered empty proof', nativeOptions, async t => {
  const f = await fixture(t, `process.stdin.resume(); setInterval(() => {}, 1000);`);
  const running = await f.launch();
  await waitForNativeFixtureState(async () => Boolean(await f.observer.processNamed('node')),
    {label: 'native fixture process readiness', finished: running.finished, timeout: 10_000, interval: 25});
  await within(running.stop('fixture_stop'));
  const result = await within(running.finished);
  assert.equal(result.failureCode, 'fixture_stop'); assert.equal(result.stopped, true);
  assert(f.empty.includes(true)); assert.equal(f.proofs.length, 1);
});

for (const callback of ['onStarted', 'onSpawn'] as const) {
  test(`S3 native natural exit completes Linux startup while ${callback} remains held`, nativeOptions, async t => {
    const f = await fixture(t, `
      import {existsSync, writeFileSync} from 'node:fs';
      process.stdin.on('data', chunk => writeFileSync('unexpected-input', chunk));
      const timer = setInterval(() => {
        if (!existsSync('.native-fixture-finish')) return;
        clearInterval(timer); console.log('native natural completion'); process.stdin.destroy();
      }, 10);
    `);
    let entered!: () => void, release!: () => void;
    const holding = new Promise<void>(done => {release = done;});
    const pending = new Promise<void>(done => {entered = done;});
    const started = t.mock.fn(async () => {if (callback === 'onStarted') {entered(); await holding;}});
    const spawned = t.mock.fn(async () => {if (callback === 'onSpawn') {entered(); await holding;}});
    const starting = f.launch({onStarted: started, onSpawn: spawned});
    try {
      await within(Promise.race([pending, starting.then(() => {throw new Error('Tool completed before the held callback.');})]));
      await f.observer.finish();
      const running = await within(starting);
      const result = await within(running.finished);
      assert.equal(result.stopped, false); assert.equal(result.ok, true); assert.equal(result.text, 'native natural completion');
      assert(f.empty.includes(true)); assert.equal(f.proofs.length, 1);
      release(); await wait(100);
      assert.equal(started.mock.callCount(), 1); assert.equal(spawned.mock.callCount(), callback === 'onSpawn' ? 1 : 0);
      await assert.rejects(readFile(join(f.workspace, 'unexpected-input')), {code: 'ENOENT'});
    } finally {release();}
  });
}
