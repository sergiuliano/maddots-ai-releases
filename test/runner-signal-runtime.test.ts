import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {signalIfStillOwned} from '../src/runner/signal-gate.js';

const execute = promisify(execFile);
const guard = new URL('./support/runner-signal-runtime-guard.ts', import.meta.url).href;
const gate = new URL('../src/runner/signal-gate.ts', import.meta.url).href;
const helperBypass = fileURLToPath(new URL('../src/runner/runtime-guard-regression.ts', import.meta.url));

async function guardedFixture(t: TestContext, mode: 'mock-bypass' | 'assignment-bypass' | 'gate-ancestor-bypass' | 'gate') {
  const directory = await mkdtemp(join(tmpdir(), 'mdai-runtime-signal-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const path = join(directory, 'runner-runtime-check.test.ts');
  const report = join(directory, 'result.tap');
  await writeFile(path, `
    import assert from 'node:assert/strict';
    import test from 'node:test';
    import {runInThisContext} from 'node:vm';
    import {signalIfStillOwned} from ${JSON.stringify(gate)};
    import {installSignalRuntimeGuard} from ${JSON.stringify(guard)};
    installSignalRuntimeGuard();
    Object.defineProperty(process, 'platform', {value: 'darwin'});
    // A helper callsite plus a dynamically resolved/indirect signal primitive:
    // checking only process.kill spelling or any lower gate/test frame misses it.
    const bypass = runInThisContext('(function indirectHelperSignal() { const key = ["ki", "ll"].join(""); return Reflect.apply(Reflect.get(process, key), process, [910999, "SIGKILL"]); })',
      {filename: ${JSON.stringify(helperBypass)}});
    test(${JSON.stringify(mode)}, async t => {
      const sent = [];
      const sink = (...args) => {sent.push(args); return true;};
      if (${JSON.stringify(mode)} === 'assignment-bypass') process.kill = sink;
      else t.mock.method(process, 'kill', sink);
      if (${JSON.stringify(mode)} === 'gate') {
        assert.deepEqual(await signalIfStillOwned({kind: 'pid', pid: 910999}, 'SIGTERM',
          {startedAt: 'owned-lifetime', identity: () => 'owned-lifetime'}), {status: 'sent', cleanupPending: true});
        assert.deepEqual(sent, [[910999, 'SIGTERM']]);
      } else if (${JSON.stringify(mode)} === 'gate-ancestor-bypass') {
        await signalIfStillOwned({kind: 'pid', pid: 910999}, 'SIGTERM', {startedAt: 'owned-lifetime', read: bypass});
        assert.deepEqual(sent, [], 'the guard refuses the bypass before reaching even a mocked signal sink');
      } else {
        try {bypass();} catch { /* Production inspection paths can swallow errors. */ }
        assert.deepEqual(sent, [], 'the guard refuses the bypass before reaching even a mocked signal sink');
      }
    });
  `);
  // Execute directly so node:test reports the assertions and hooks from this
  // one fixture. Keep its TAP report in a file so the proof also works when a
  // containing sandbox captures child stdout separately from these pipes.
  try {
    await execute(process.execPath, ['--import', import.meta.resolve('tsx'), '--import', guard,
      '--test-reporter=tap', `--test-reporter-destination=${report}`, path], {
      timeout: 10_000,
      // This fixture is an independent node:test harness. Inheriting a parent
      // worker's IPC context suppresses its explicit TAP reporter destination.
      env: {...process.env, NODE_TEST_CONTEXT: undefined},
    });
    return {ok: true, output: await readFile(report, 'utf8')};
  } catch (error) {
    const result = error as {stdout?: string; stderr?: string; code?: unknown};
    assert.equal(result.code, 1, 'the fixture must fail through node:test rather than a process launch or timeout error');
    return {ok: false, output: await readFile(report, 'utf8')};
  }
}

for (const mode of ['mock-bypass', 'assignment-bypass', 'gate-ancestor-bypass'] as const) {
  test(`FIX10 runtime guard rejects a swallowed indirect helper signal with ${mode}`, async t => {
    const result = await guardedFixture(t, mode);
    assert.equal(result.ok, false, 'a swallowed runtime bypass must fail the test');
    assert.match(result.output, /Runner signal bypass: process\.kill must be issued by signalIfStillOwned/u);
    assert.match(result.output, /hookFailed/u);
  });
}

test('FIX10 runtime guard permits a signal issued by the ownership gate with a mocked sink', async t => {
  const result = await guardedFixture(t, 'gate');
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /# tests 1/u);
  assert.match(result.output, /# pass 1/u);
});

test('FIX10 runtime guard preserves fixture probes and node:test mock inspection and restoration', async t => {
  legacyDarwin(t);
  const replacement = t.mock.method(process, 'kill', () => true);
  assert.equal(process.kill(910998, 0), true, 'a direct runner fixture probe is allowed');
  assert.equal(replacement.mock.callCount(), 1);
  assert.equal((process.kill as typeof replacement).mock.callCount(), 1);
  replacement.mock.restore();
  assert.deepEqual(await signalIfStillOwned({kind: 'probe', pid: process.pid}, 0), {status: 'sent', cleanupPending: false});
});

test('FIX10 runtime guard permits ownership-gate probes through passthrough spies', async t => {
  legacyDarwin(t);
  const original = process.kill;
  const spy = t.mock.method(process, 'kill');
  assert.deepEqual(await signalIfStillOwned({kind: 'probe', pid: process.pid}, 0), {status: 'sent', cleanupPending: false});
  assert.equal(spy.mock.callCount(), 1);
  spy.mock.restore();
  assert.equal(process.kill, original, 'restoration retains the original guarded signal sink');
});

function legacyDarwin(t: TestContext): void {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', {...descriptor, value: 'darwin'});
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
}

async function guardedChildFixture(t: TestContext, mode: 'mock' | 'assignment' | 'external' | 'benign') {
  const directory = await mkdtemp(join(tmpdir(), 'mdai-runtime-child-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const path = join(directory, 'runner-child-check.test.ts');
  const report = join(directory, 'result.tap');
  await writeFile(path, `
    import assert from 'node:assert/strict';
    import cp, {execFile} from 'node:child_process';
    import test from 'node:test';
    import {promisify} from 'node:util';
    import {runInThisContext} from 'node:vm';
    import {installSignalRuntimeGuard} from ${JSON.stringify(guard)};
    installSignalRuntimeGuard();
    test(${JSON.stringify(mode)}, async t => {
      const mode = ${JSON.stringify(mode)};
      if (mode === 'benign') {
        const calls = [];
        t.mock.method(cp, 'execFileSync', (...args) => {calls.push(args); return 'kill';});
        t.mock.method(cp, 'execSync', (...args) => {calls.push(args); return 'kill';});
        t.mock.method(cp, 'spawnSync', (...args) => {calls.push(args); return {status: 0};});
        cp.execFile = Object.assign(() => {}, {[promisify.custom]: async (...args) => {calls.push(args); return {stdout: 'ok', stderr: ''};}});
        assert.equal(cp.execFileSync('/bin/echo', ['kill']), 'kill');
        assert.equal(cp.execSync('echo kill'), 'kill');
        assert.equal(cp.spawnSync('/bin/echo', ['kill']).status, 0);
        assert.equal((await promisify(execFile)('/bin/echo', ['ok'])).stdout, 'ok');
        assert.equal(calls.length, 4);

        return;
      }
      if (mode === 'external') {
        const execute = runInThisContext('(cp, pid) => { const args = ["/bin/kill", ["-0", String(pid)]]; return cp.execFileSync(...args); }',
          {filename: ${JSON.stringify(helperBypass)}});
        assert.throws(() => execute(cp, process.pid), {code: 'ERR_RUNNER_SIGNAL_BYPASS'});
        await assert.rejects(async () => promisify(execFile)('/bin/kill', ['-0', String(process.pid)]), {code: 'ERR_RUNNER_SIGNAL_BYPASS'});
        // Even a direct fixture command must not launch an external signal utility.
        assert.throws(() => cp.execFileSync('/bin/kill', ['-0', String(process.pid)]), {code: 'ERR_RUNNER_SIGNAL_BYPASS'});
        return;
      }
      const sent = [];
      for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
        const sink = (...args) => {sent.push([key, ...args]); return {};};
        if (mode === 'assignment') cp[key] = sink;
        else t.mock.method(cp, key, sink);
      }
      const sink = (...args) => {sent.push(['child.kill', ...args]); return true;};
      if (mode === 'assignment') cp.ChildProcess.prototype.kill = sink;
      else t.mock.method(cp.ChildProcess.prototype, 'kill', sink);
      const child = new cp.ChildProcess();
      const calls = [
        'let method = "kill"; child[method]("SIGKILL");',
        'const args = ["/bin/kill", ["-0", String(pid)]]; cp.execFile(...args);',
        'cp.spawn("/custom directory/kill", ["-0", String(pid)]);',
        'cp.spawnSync("/custom/path/pkill", ["fixture"]);',
        'cp.exec("/custom/path/killall fixture");',
        'cp.execSync("kill -0 " + pid);',
        'cp.execFileSync("/bin/kill", ["-0", String(pid)]);',
        'cp.fork("/custom/path/kill", ["-0", String(pid)]);',
        'cp.spawn("/bin/sh", ["-c", "kill -0 " + pid]);',
        'cp.execFile("/usr/bin/env", ["/bin/kill", "-0", String(pid)]);',
        'named("/bin/kill", ["-0", String(pid)]);',
      ];
      for (const source of calls) {
        const execute = runInThisContext('(cp, child, pid, named) => {' + source + '}',
          {filename: ${JSON.stringify(helperBypass)}});
        assert.throws(() => execute(cp, child, process.pid, execFile), {code: 'ERR_RUNNER_SIGNAL_BYPASS'}, source);
      }
      assert.deepEqual(sent, [], 'every bypass must be rejected before a mocked native sink');
    });
  `);
  try {
    await execute(process.execPath, ['--import', import.meta.resolve('tsx'), '--import', guard,
      '--test-reporter=tap', `--test-reporter-destination=${report}`, path], {
      timeout: 20_000, env: {...process.env, NODE_TEST_CONTEXT: undefined},
    });
    return {ok: true, output: await readFile(report, 'utf8')};
  } catch (error) {
    assert.equal((error as {code?: unknown}).code, 1, 'the fixture must fail through node:test');
    return {ok: false, output: await readFile(report, 'utf8')};
  }
}

for (const mode of ['mock', 'assignment', 'external'] as const) {
  test(`FIX11 runtime guard rejects child and external signal bypasses (${mode})`, async t => {
    const result = await guardedChildFixture(t, mode);
    assert.equal(result.ok, false, result.output);
    assert.match(result.output, /hookFailed/u, 'swallowed guard errors still fail the fixture');
    assert.doesNotMatch(result.output, /every bypass must|Missing expected exception/u);
    assert.match(result.output, /Runner signal bypass: (?:ChildProcess\.kill|child_process\.execFileSync)/u);
  });
}

test('FIX11 runtime guard permits ordinary commands and promisify with mocked sinks', async t => {
  const result = await guardedChildFixture(t, 'benign');
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /# pass 1/u);
});

for (const mode of ['sync', 'async', 'handle', 'assignment', 'vector', 'async-vector', 'handle-vector', 'stream', 'stream-fd', 'handle-stream', 'gate'] as const) {
  test(`S3 runtime guard ${mode === 'gate' ? 'permits the retained gate' : 'rejects a swallowed containment bypass'} (${mode})`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'mdai-runtime-containment-'));
    t.after(() => rm(directory, {recursive: true, force: true}));
    const path = join(directory, 'runner-containment-check.test.ts'), report = join(directory, 'result.tap');
    await writeFile(path, `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import fsp from 'node:fs/promises';
      import test from 'node:test';
      import {runInThisContext} from 'node:vm';
      import {signalIfStillOwned, registerContainmentSignalEndpoint} from ${JSON.stringify(gate)};
      import {installSignalRuntimeGuard} from ${JSON.stringify(guard)};
      installSignalRuntimeGuard();
      test(${JSON.stringify(mode)}, async t => {
        Object.defineProperty(process, 'platform', {value: 'linux'});
        const path = ${JSON.stringify(join(directory, 'cgroup.kill'))};
        const fd = fs.openSync(path, 'wx', 0o600);
        try {
          const mode = ${JSON.stringify(mode)};
          if (mode === 'gate') {
            const endpoint = registerContainmentSignalEndpoint(fd, () => true);
            assert.equal((await signalIfStillOwned({kind: 'containment', endpoint}, 'SIGKILL')).status, 'sent');
            assert.equal(fs.readFileSync(path, 'utf8'), '1\\n');
            return;
          }
          const sources = {
            sync: '(fs, fsp, fd, path) => fs.writeSync(fd, "1")',
            assignment: '(fs, fsp, fd, path) => Reflect.apply(Reflect.get(fs, ["write", "Sync"].join("")), fs, [fd, "1"])',
            async: '(fs, fsp, fd, path) => fsp.writeFile(path, "1")',
            handle: 'async (fs, fsp, fd, path) => { const h = await fsp.open(path, "r+"); try { await h.writeFile("1"); } finally { await h.close(); } }',
            vector: '(fs, fsp, fd, path) => fs.writevSync(fd, [Buffer.from("1")])',
            'async-vector': '(fs, fsp, fd, path) => fs.writev(fd, [Buffer.from("1")], () => {})',
            'handle-vector': 'async (fs, fsp, fd, path) => { const h = await fsp.open(path, "r+"); try { await h.writev([Buffer.from("1")]); } finally { await h.close(); } }',
            stream: '(fs, fsp, fd, path) => fs.createWriteStream(path).end("1")',
            'stream-fd': '(fs, fsp, fd, path) => fs.createWriteStream("ignored", {fd, autoClose: false}).end("1")',
            'handle-stream': 'async (fs, fsp, fd, path) => { const h = await fsp.open(path, "r+"); try { h.createWriteStream({autoClose: false}).end("1"); } finally { await h.close(); } }',
          };
          if (mode === 'sync') t.mock.method(fs, 'writeSync', () => 1);
          if (mode === 'assignment') fs.writeSync = () => 1;
          const bypass = runInThisContext(sources[mode], {filename: ${JSON.stringify(helperBypass)}});
          try {await bypass(fs, fsp, fd, path);} catch { /* A swallowed bypass still fails the owning test. */ }
          assert.equal(fs.readFileSync(path, 'utf8'), '', 'the rejected bypass never reaches even a mocked endpoint sink');
        } finally {fs.closeSync(fd);}
      });
    `);
    let succeeded = true;
    try {
      await execute(process.execPath, ['--import', import.meta.resolve('tsx'), '--import', guard,
        '--test-reporter=tap', `--test-reporter-destination=${report}`, path], {
        timeout: 10_000, env: {...process.env, NODE_TEST_CONTEXT: undefined},
      });
    } catch (error) {succeeded = false; assert.equal((error as {code?: unknown}).code, 1);}
    const output = await readFile(report, 'utf8');
    assert.equal(succeeded, mode === 'gate', output);
    if (mode === 'gate') assert.match(output, /# pass 1/u);
    else {
      assert.match(output, /Runner signal bypass: (?:fs\.|FileHandle\.)/u);
      assert.match(output, /hookFailed/u);
    }
  });
}
