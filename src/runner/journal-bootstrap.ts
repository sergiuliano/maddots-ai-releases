// An explicit fresh-install operation, never a startup repair or migration.
// The root-owned receipt authenticates founder-established prerequisites. It
// is not a process scan, a containment completion proof or a CLEAN record.
import {createHash} from 'node:crypto';
import {constants, type BigIntStats} from 'node:fs';
import {lstat, open, readdir, realpath} from 'node:fs/promises';
import {userInfo} from 'node:os';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {parseJsonWithoutDuplicateKeys} from '../shared/strict-json.js';
import {HelperError} from '../config.js';
import {linuxBootId} from '../linux-proc.js';
import {assertNoSymlinks, inside, type HelperPaths} from '../paths.js';
import type {RuntimeContext} from '../runtime.js';
import {PROCESS_CLEANUP_CAP_MS} from './process.js';
import {JOURNAL_HEAD, JOURNAL_MANIFEST} from './journal.js';
import {listBound, RunnerState} from './state.js';
import {acquireStorageOwner} from './storage-owner.js';
import type {RunnerStorageLock} from './storage-lock.js';

const LIMIT = 8192;
const MAX_AGE_MS = 15 * 60_000;
const CLOSE_ON_EXEC = 0x80000;
const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const refuse = () => new HelperError('RUNNER_JOURNAL_BOOTSTRAP_REFUSED',
  'Fresh journal bootstrap refused. Preserve all evidence; verify founder prerequisites or obtain a separately reviewed migration.');
type Evidence = {
  format: 'mdai-journal-bootstrap-v1'; uid: number; data: string; directoryIdentity: string; bootId: string;
  issuedAt: number; expiresAt: number; launchEntrypointsFenced: true; updateEntrypointsFenced: true;
  oldWritersExtinct: true; workloadsExtinct: true; prerequisiteSha256: string;
};
type Snapshot = {evidence: Evidence; stat: BigIntStats; ancestors: Map<string, BigIntStats>};
const fields = ['format', 'uid', 'data', 'directoryIdentity', 'bootId', 'issuedAt', 'expiresAt',
  'launchEntrypointsFenced', 'updateEntrypointsFenced', 'oldWritersExtinct', 'workloadsExtinct', 'prerequisiteSha256'];
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid &&
  a.gid === b.gid && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size &&
  a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/** Native CLI contract matches the fixed installation in slice 1. No flag or
 * environment value selects another account, storage root or executable tree.
 */
export function assertJournalBootstrapPaths(paths: HelperPaths, runtime: RuntimeContext): void {
  if (process.platform !== 'linux' || paths.platform !== 'linux' || process.getuid?.() !== 999 || process.geteuid?.() !== 999 ||
      userInfo().username !== 'mdai' || paths.home !== '/var/lib/mdai/home' || paths.data !== '/var/lib/mdai/data' ||
      paths.config !== '/var/lib/mdai/config/maddots-ai' || paths.stateDir !== '/var/lib/mdai/state/maddots-ai' ||
      paths.state !== '/var/lib/mdai/state/maddots-ai/state.json' || paths.runtime !== '/run/mdai-helper/mdai' ||
      paths.logs !== '/var/lib/mdai/data/logs' || runtime.bundledRoot !== '/usr/local/libexec/mdai/helper' ||
      runtime.runningRoot !== runtime.bundledRoot || runtime.bootstrapEntrypoint !== '/usr/local/libexec/mdai/helper/dist/cli.js') throw refuse();
}

async function evidenceAncestors(path: string, evidenceOwner: number): Promise<Map<string, BigIntStats>> {
  const ancestors = new Map<string, BigIntStats>();
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const info = await lstat(parent, {bigint: true});
    // Only an explicit function-argument fixture owner admits private fixture
    // parents and the system temporary directory. The CLI always uses uid 0.
    const fixtureTmp = evidenceOwner !== 0 && info.uid === 0n && (info.mode & 0o1000n) !== 0n;
    if (!info.isDirectory() || info.isSymbolicLink() ||
        (info.uid !== 0n && info.uid !== BigInt(evidenceOwner)) || (info.mode & 0o022n) !== 0n && !fixtureTmp ||
        evidenceOwner === 0 && info.uid !== 0n) throw refuse();
    ancestors.set(parent, info);
    if (parent === dirname(parent)) break;
  }
  return ancestors;
}

async function readEvidence(path: string, expectedSha256: string, evidenceOwner: number, previous?: Snapshot): Promise<Snapshot> {
  if (!isAbsolute(path) || resolve(path) !== path || !HASH.test(expectedSha256)) throw refuse();
  await assertNoSymlinks(path);
  const ancestors = await evidenceAncestors(path, evidenceOwner);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | CLOSE_ON_EXEC);
  try {
    const before = await file.stat({bigint: true});
    if (!before.isFile() || before.uid !== BigInt(evidenceOwner) || before.nlink !== 1n ||
        ![0o444n, 0o644n].includes(before.mode & 0o7777n) || before.size < 1n || before.size > BigInt(LIMIT) ||
        previous && !same(before, previous.stat)) throw refuse();
    const buffer = Buffer.alloc(LIMIT + 1);
    const {bytesRead} = await file.read(buffer, 0, buffer.length, 0);
    if (BigInt(bytesRead) !== before.size || createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex') !== expectedSha256) throw refuse();
    const value = parseJsonWithoutDuplicateKeys(buffer.subarray(0, bytesRead).toString('utf8')) as Evidence;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...fields].sort().join(',') ||
        value.format !== 'mdai-journal-bootstrap-v1' || value.uid !== process.getuid?.() ||
        typeof value.data !== 'string' || !isAbsolute(value.data) || resolve(value.data) !== value.data ||
        typeof value.directoryIdentity !== 'string' || !/^[0-9]{1,24}:[0-9]{1,24}$/u.test(value.directoryIdentity) ||
        typeof value.bootId !== 'string' || !UUID.test(value.bootId) ||
        !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt) || value.issuedAt > Date.now() ||
        value.issuedAt < 0 || value.expiresAt <= Date.now() || value.expiresAt <= value.issuedAt ||
        value.expiresAt - value.issuedAt > MAX_AGE_MS || value.launchEntrypointsFenced !== true ||
        value.updateEntrypointsFenced !== true || value.oldWritersExtinct !== true || value.workloadsExtinct !== true ||
        typeof value.prerequisiteSha256 !== 'string' || !HASH.test(value.prerequisiteSha256)) throw refuse();
    if (!same(before, await file.stat({bigint: true})) || !same(before, await lstat(path, {bigint: true}))) throw refuse();
    for (const [parent, info] of ancestors) {
      const after = await lstat(parent, {bigint: true});
      const original = previous?.ancestors.get(parent) ?? info;
      // Directory contents may change independently; its identity and access
      // policy must remain unchanged across this retained-file inspection.
      if (!after.isDirectory() || after.dev !== info.dev || after.ino !== info.ino || after.uid !== info.uid ||
          after.gid !== info.gid || after.mode !== info.mode || original.dev !== info.dev || original.ino !== info.ino ||
          original.uid !== info.uid || original.gid !== info.gid || original.mode !== info.mode) throw refuse();
    }
    return {evidence: value, stat: before, ancestors};
  } finally {await file.close();}
}

async function assertData(data: string, identity: string): Promise<void> {
  await assertNoSymlinks(data);
  for (let parent = dirname(data); ; parent = dirname(parent)) {
    const info = await lstat(parent);
    const fixtureTmp = data !== '/var/lib/mdai/data' && info.uid === 0 && (info.mode & 0o1000) !== 0;
    if (!info.isDirectory() || info.uid !== 0 && info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0 && !fixtureTmp) throw refuse();
    if (parent === dirname(parent)) break;
  }
  const info = await lstat(data, {bigint: true});
  if (!info.isDirectory() || info.uid !== BigInt(process.getuid!()) || (info.mode & 0o7777n) !== 0o700n ||
      `${info.dev}:${info.ino}` !== identity || await realpath(data) !== data) throw refuse();
}
async function assertAbsent(path: string): Promise<void> {
  try {await lstat(path);}
  catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error;}
  throw refuse();
}
async function assertFreshStorage(data: string, fresh: boolean, lock: RunnerStorageLock): Promise<void> {
  if (fresh) {
    if (!lock.inventoryFresh) throw refuse();
    lock.inventoryFresh();
  }
  // The production owner creates runner itself with mkdir's exclusive result.
  // Its final contents must be exactly the acknowledged initial journal and
  // an empty outcomes directory. Companion state and all temporaries refuse.
  for (const name of await readdir(data)) {
    if ((fresh || name !== 'runner') && /^(?:\.?runner(?:$|[.-])|\.?run-)/u.test(name)) throw refuse();
  }
  await assertNoSymlinks(join(data, 'backups/run-stage'));
  await assertAbsent(join(data, 'backups/run-stage'));
  if (!fresh) {
    const runner = await lock.directory('runner');
    const expected = [JOURNAL_HEAD, JOURNAL_MANIFEST, 'journal-0000000001.json', 'outcomes'].sort();
    const names = await listBound(runner, expected.length + 1);
    if (names.length !== expected.length || names.some((name, index) => name !== expected[index]) ||
        !runner.assertCreatedFiles) throw refuse();
    await runner.assertCreatedFiles();
    for (const name of ['runner/outcomes', 'logs'] as const) {
      if ((await listBound(await lock.directory(name), 1)).length) throw refuse();
    }
    await runner.assertCreatedFiles();
  }
}

/** Fixture options are trusted function arguments only, never CLI/env inputs.
 * The returned success means ordinary replay and EPOCH finished. It does not
 * activate runs, reopen entrypoints or assert containment completion.
 */
export async function bootstrapRunnerJournal(data: string, evidencePath: string, evidenceSha256: string,
  options: {deadline?: number; evidenceOwner?: number} = {}): Promise<void> {
  if (process.platform !== 'linux' || !process.getuid?.() || process.geteuid?.() !== process.getuid?.() ||
      !isAbsolute(data) || resolve(data) !== data || inside(data, evidencePath)) throw refuse();
  const deadline = options.deadline ?? Date.now() + PROCESS_CLEANUP_CAP_MS;
  const evidenceOwner = options.evidenceOwner ?? 0;
  const snapshot = await readEvidence(evidencePath, evidenceSha256, evidenceOwner);
  if (snapshot.evidence.data !== data || await linuxBootId() !== snapshot.evidence.bootId) throw refuse();
  await assertData(data, snapshot.evidence.directoryIdentity);
  const acquisition = await acquireStorageOwner(data, new RunnerState(data));
  let generation: number | undefined;
  try {
    generation = acquisition.attach();
    await acquisition.owner.bootstrapJournal(generation, async (lock: RunnerStorageLock, fresh: boolean) => {
      await lock.assertCurrent();
      const current = await readEvidence(evidencePath, evidenceSha256, evidenceOwner, snapshot);
      if (lock.data !== data || lock.identity !== current.evidence.directoryIdentity ||
          await linuxBootId() !== current.evidence.bootId) throw refuse();
      await assertData(data, lock.identity);
      await assertFreshStorage(data, fresh, lock);
      if (!fresh) await (await lock.directory('runner')).assertCurrent();
      await lock.assertCurrent();
      return current.evidence.bootId;
    }, deadline);
  } finally {
    if (generation !== undefined) await acquisition.owner.detach(generation);
    await acquisition.release();
  }
}
