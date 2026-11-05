// Local file-backed IPC fixture. No workload or containment backend is enabled.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import * as filesystem from 'node:fs/promises';
import {realpath} from 'node:fs/promises';
import {createRequire, syncBuiltinESMExports} from 'node:module';
import {mock} from 'node:test';
import {AdapterRegistry} from '../../src/runner/adapters/index.js';
import {RunnerJournal} from '../../src/runner/journal.js';
import {RunnerCore} from '../../src/runner/runner.js';
import {RunnerState} from '../../src/runner/state.js';

const [mode, data] = process.argv.slice(2);
assert(['hold-epoch', 'probe', 'intent'].includes(mode) && data);
const canonical = await realpath(data);
const send = (value: object) => new Promise<void>((resolve, reject) => {
  process.send!(value, (error: Error | null) => {if (error) reject(error); else resolve();});
});
let release!: () => void;
const held = new Promise<void>(resolve => {release = resolve;});
process.on('message', value => {if (value === 'release') release();});
let replays = 0, journalReads = 0, activeReads = 0, epochs = 0, physical = 0, maximumPhysical = 0;
const originalReplay = RunnerJournal.prototype.replay, originalEpoch = RunnerJournal.prototype.establishEpoch;
const originalActive = RunnerState.prototype.active;
mock.method(RunnerJournal.prototype, 'replay', async function(this: RunnerJournal) {replays++; return originalReplay.call(this);});
mock.method(RunnerState.prototype, 'active', async function(this: RunnerState) {activeReads++; return originalActive.call(this);});
mock.method(RunnerJournal.prototype, 'establishEpoch', async function(this: RunnerJournal) {
  epochs++; physical++; maximumPhysical = Math.max(maximumPhysical, physical);
  await send({kind: 'publication-start', data: canonical});
  try {
    await originalEpoch.call(this);
    if (mode === 'hold-epoch') {await send({kind: 'held', data: canonical, physical}); await held;}
  } finally {physical--; await send({kind: 'publication-end', data: canonical});}
});
const fsp = createRequire(import.meta.url)('node:fs/promises') as typeof filesystem, originalOpen = fsp.open;
mock.method(fsp, 'open', async (...args: Parameters<typeof originalOpen>) => {
  if (/\/journal-(?:manifest|head|\d{10})\.json$/u.test(String(args[0])) &&
      typeof args[1] === 'number' && (args[1] & 3) === 0) journalReads++;
  return originalOpen(...args);
});
syncBuiltinESMExports();
const core = new RunnerCore({data, registry: new AdapterRegistry([]), connections: async () => [], localAgents: async () => [],
  verifiedBuild: async () => true, allowedBuild: async () => true, stageSkills: async () => {}, removeDeviceKey: async () => {},
  deliver: async (): Promise<never> => {assert.fail('This fixture must never execute or deliver a workload.');}});
try {
  let error: unknown;
  await core.init().catch(value => {error = value;});
  let runId: string | undefined;
  if (mode === 'intent') {
    assert.equal(error, undefined);
    runId = randomUUID();
    await core['owner']!.journalOperation(core['ownerGeneration'], journal => journal.intent({runId: runId!, incarnation: randomUUID()}));
  }
  const journal = core['owner']?.['journal'];
  await send({kind: 'result', mode, data: canonical, error: (error as {code?: string} | undefined)?.code ?? null,
    busy: core.busy, replays, journalReads, activeReads, epochs, maximumPhysical, runId,
    obligations: [...journal?.obligations.values() ?? []].map(row => ({runId: row.runId, stage: row.stage}))});
  await core.close();
  await send({kind: 'closed', busy: core.busy, physical});
  process.exit(0);
} catch (error) {
  await send({kind: 'fixture-error', error: error instanceof Error ? error.stack : String(error)});
  process.exit(1);
}
