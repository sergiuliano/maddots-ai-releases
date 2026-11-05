import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chmod, mkdtemp, readFile, rm, unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

// Native gate-linux command, run as mdai on the intended local filesystem:
// TMPDIR=<dedicated-fixture-root> node --import tsx helper/test/runner-journal-native.test.ts
// This only qualifies real file publication/restart behavior. S3 cgroup and
// host-reboot qualification remains a separate required acceptance step.
const worker = fileURLToPath(new URL('./fixtures/runner-journal-crash.ts', import.meta.url));
const stages = ['EPOCH', 'INTENT', 'CONTAINMENT_BOUND', 'LAUNCH_ALLOWED', 'STOPPING', 'CLEAN'];
const boundaries = ['record-sync', 'record-publish', 'record-directory-sync', 'head-sync', 'head-rename', 'head-directory-sync'];

function controller(args: string[]): Promise<{code: number | null; signal: string | null; stdout: string; stderr: string}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', worker, ...args], {stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => {stdout += chunk;}); child.stderr.on('data', chunk => {stderr += chunk;});
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({code, signal, stdout, stderr}));
  });
}

for (const stage of stages) for (const boundary of boundaries) for (const when of ['before', 'after']) {
  test(`native journal process exit ${when} ${boundary} during ${stage}, two fresh controllers replay safely`, {
    skip: process.platform !== 'linux', timeout: 15_000,
  }, async t => {
    const data = await mkdtemp(join(tmpdir(), 'mdai-journal-crash-')); await chmod(data, 0o700);
    t.after(() => rm(data, {recursive: true, force: true}));
    const crashed = await controller(['crash', data, stage, boundary, when]);
    assert.equal(crashed.code, 86, crashed.stderr); assert.equal(crashed.signal, null);
    const headPublished = boundary === 'head-directory-sync' || boundary === 'head-rename' && when === 'after';
    const cleanPrefix = (stage === 'EPOCH' || stage === 'CLEAN') && headPublished;
    for (let restart = 0; restart < 2; restart++) {
      const successor = await controller(['replay', data]);
      assert.equal(successor.code, 0, successor.stderr); assert.equal(successor.signal, null);
      const report = join(data, 'replay-report.json'), replay = JSON.parse(await readFile(report, 'utf8'));
      await unlink(report);
      assert.equal(replay.busy, !cleanPrefix);
      assert.equal(replay.isClean, stage === 'CLEAN' && cleanPrefix);
      if (stage !== 'EPOCH' && stage !== 'INTENT' && !cleanPrefix && !replay.reason) assert.ok(replay.obligations.length > 0);
    }
  });
}
