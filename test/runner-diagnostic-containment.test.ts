import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {diagnosticStorageBusy, recoverTestRuns, runToolTest} from '../src/runner/test-run.js';
import {AdapterRegistry} from '../src/runner/adapters/index.js';
import {initializeCleanRunnerJournal} from './support/runner-journal-fixture.js';

for (const evidence of ['legacy numeric projection', 'unmatched containment run ID'] as const) {
  test(`Linux diagnostic recovery retains ${evidence} without process-derived authority`, {skip: process.platform !== 'linux'}, async t => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-diagnostic-authority-'));
    const data = join(root, 'data'), cwd = await mkdtemp(join(await realpath(tmpdir()), 'maddots-ai-test-'));
    await mkdir(data, {mode: 0o700}); await initializeCleanRunnerJournal(data);
    const directory = join(data, 'runner', 'test-processes'); await mkdir(directory, {mode: 0o700});
    const aiToolId = randomUUID(), file = join(directory, aiToolId + '.json');
    const row = {format: 1, aiToolId, cwd, fence: 'a'.repeat(32), pid: 876543, startedAt: 'fixture-old-process', groups: [],
      ...(evidence === 'unmatched containment run ID' ? {containmentRunId: randomUUID()} : {})};
    const content = JSON.stringify(row) + '\n'; await writeFile(file, content, {mode: 0o600});
    t.after(async () => {await rm(root, {recursive: true, force: true}); await rm(cwd, {recursive: true, force: true});});
    const inspection = t.mock.fn(() => {throw new Error('Process observations cannot authorize diagnostic retirement.');});
    await assert.rejects(recoverTestRuns({data, processes: {
      table: async () => {inspection(); return [];}, identity: async () => {inspection(); return null;},
      fencePids: async () => {inspection(); return [];}, signalGroup: () => {inspection();},
    }}), {code: 'RUNNER_TEST_RECOVERY_UNAVAILABLE'});
    assert.equal(inspection.mock.callCount(), 0);
    assert.equal(await readFile(file, 'utf8'), content);
    assert.equal((await stat(cwd)).isDirectory(), true);
    assert.equal(diagnosticStorageBusy(data), true);
  });
}

test('Linux diagnostic without durable storage refuses before adapter inspection', {skip: process.platform !== 'linux'}, async () => {
  const result = await runToolTest({connection: {aiToolId: randomUUID(), tool: 'codex', toolVersion: 'fixture',
    bin: '/not-executed/tool', realpath: '/not-executed/tool'}, registry: new AdapterRegistry([])});
  assert.deepEqual(result, {ok: false, code: 'LINUX_CONTAINMENT_UNAVAILABLE', toolVersion: 'fixture'});
});
