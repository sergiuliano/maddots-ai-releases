/** The native Python syscall tests share the service controller's lifetime.
 * Keep process acquisition in this test module, never in the installed driver. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, readdir, rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {LINUX_CONTAINMENT_PATHS} from '../src/runner/linux-containment.js';

test('S5-04/08 native guardian protocol, SCM_RIGHTS, stdin and pre-exec syscall cases', {
  skip: process.platform !== 'linux' || process.env.MDAI_LINUX_NATIVE_CONTAINMENT !== '1'
    ? 'Native guardian transport requires the reviewed service driver.' : false,
  timeout: 70_000,
}, async t => {
  assert.equal((await readFile('/proc/self/cgroup', 'utf8')).trim(), '0::/system.slice/mdai-helper.service/controller');
  // Python reads the reviewed guardian source, not an installed replacement.
  // Its subprocesses inherit this controller leaf. No node --test worker runs.
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'mdai-native-guardian-'));
  let output = '';
  let timedOut = false;
  let timers: ReturnType<typeof setTimeout>[] = [];
  try {
    const child = spawn(LINUX_CONTAINMENT_PATHS.python,
      ['-I', '-B', fileURLToPath(new URL('./linux-guardian.test.py', import.meta.url)), '-v'],
      {cwd: '/', env: {MDAI_LINUX_NATIVE_CONTAINMENT: '1', TMPDIR: fixtureRoot}, stdio: ['ignore', 'pipe', 'pipe']});
    child.stdout.on('data', bytes => {output += String(bytes);});
    child.stderr.on('data', bytes => {output += String(bytes);});
    const result = await new Promise<{code: number | null; signal: string | null}>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({code, signal}));
      timers = [
        setTimeout(() => {
          timedOut = true;
          t.diagnostic('Native guardian exceeded 45s; sending SIGINT to unwind Python fixtures.');
          child.kill('SIGINT');
        }, 45_000),
        // native_inner_fixture allows 8s to exit and 5s after its owned-child kill.
        setTimeout(() => {
          t.diagnostic('Native guardian did not close after SIGINT; sending SIGTERM.');
          child.kill('SIGTERM');
        }, 59_000),
        setTimeout(() => {
          t.diagnostic('Native guardian did not close after SIGTERM; sending SIGKILL.');
          child.kill('SIGKILL');
        }, 61_000),
        setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          reject(new Error('Native guardian did not close within 63s after bounded signal escalation.'));
        }, 63_000),
      ];
    });
    assert.equal(timedOut, false, 'native guardian exceeded its 45s execution deadline');
    assert.deepEqual(result, {code: 0, signal: null}, output);
    assert.match(output, /Ran \d+ tests/u);
    assert.match(output, /\nOK\s*$/u, 'the service lane must not silently skip a native Python case');
  } finally {
    timers.forEach(clearTimeout);
    t.diagnostic(output);
    try {
      const leftovers = (await readdir(fixtureRoot)).map(name => join(fixtureRoot, name));
      if (leftovers.length > 0) {
        t.diagnostic(`Native guardian fixture leftovers: ${leftovers.join(', ')}`);
      } else {
        await rmdir(fixtureRoot);
      }
    } catch (error) {
      t.diagnostic(`Could not inspect or remove native guardian fixture root ${fixtureRoot}: ${String(error)}`);
    }
  }
});
