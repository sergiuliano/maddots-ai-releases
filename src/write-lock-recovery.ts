// S5-10 is a bounded installation recovery, not writer-generation fencing.
// All I/O is awaited to settlement. No timeout, operator boolean or free lock
// can discharge a retained writer or an uncertain publication.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { linuxBootId } from './linux-proc.js';
import { assertNoSymlinks, inside, readPrivateFile } from './paths.js';
import { linuxLockRetirementUnverified, validLinuxRecoveryMask, verifyLinuxRecoveryEntrypoints, type LinuxRecoveryMask } from './write-lock-retirement.js';

export interface RecoveryRoot {root: string; unpublished: boolean}
export interface RecoveryInventory {
  installation: string;
  data: string[];
  writable: string[];
  states: string[];
  units?: string[];
  roots: RecoveryRoot[];
  artifacts: {path: string; sha256: string | null}[];
}
export interface LinuxLockRecovery {
  schemaVersion: 1;
  revision: 3;
  id: string;
  baselineBoot: string;
  // A reboot during incomplete patching starts a new window, while retaining
  // the original baseline and every earlier window for audit/retry purposes.
  windows: string[];
  initial: RecoveryInventory;
  sealing?: {boot: string; inventory: RecoveryInventory; masks: LinuxRecoveryMask[]};
  seal?: {boot: string; inventory: RecoveryInventory; masks: LinuxRecoveryMask[]};
  completion?: {boot: string; method: 'cohort' | 'reboot'; inventory: RecoveryInventory};
}

const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value);
const path = (value: unknown): value is string => typeof value === 'string' && value.length <= 4096 && value.startsWith('/') &&
  resolve(value) === value && [...value].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const unique = (values: string[]) => new Set(values).size === values.length;
function validInventory(value: unknown): value is RecoveryInventory {
  if (!object(value) || !keys(value, ['installation', 'data', 'writable', 'states', 'units', 'roots', 'artifacts']) || !path(value.installation) ||
      !Array.isArray(value.data) || !value.data.length || value.data.length > 64 || !value.data.every(path) || !unique(value.data) ||
      !Array.isArray(value.writable) || !value.writable.length || value.writable.length > 256 || !value.writable.every(path) ||
      !unique(value.writable) || !value.data.every(root => (value.writable as string[]).includes(root)) ||
      !Array.isArray(value.states) || !value.states.length || value.states.length > 256 || !value.states.every(path) || !unique(value.states) ||
      !value.states.every(file => file.endsWith('/state.json') && (value.writable as string[]).includes(dirname(file))) ||
      (value.units !== undefined && (!Array.isArray(value.units) || value.units.length > 256 || !value.units.every(path) || !unique(value.units) ||
        !value.units.every(unit => unit.endsWith('/app.maddots.ai.helper.service') || unit.endsWith('/app.maddots.ai.helper.plist')))) ||
      !Array.isArray(value.roots) || !value.roots.length || value.roots.length > 256 ||
      !value.roots.every(root => object(root) && keys(root, ['root', 'unpublished']) && path(root.root) && typeof root.unpublished === 'boolean') ||
      !unique(value.roots.map(root => root.root)) || !value.roots.some(root => root.root === value.installation && !root.unpublished) ||
      !Array.isArray(value.artifacts) || !value.artifacts.length || value.artifacts.length > 8192 ||
      !value.artifacts.every(artifact => object(artifact) && keys(artifact, ['path', 'sha256']) && path(artifact.path) &&
        (artifact.sha256 === null || typeof artifact.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(artifact.sha256))) ||
      !unique(value.artifacts.map(artifact => artifact.path))) return false;
  if (Buffer.byteLength(JSON.stringify(value)) > 128 * 1024) return false;
  const roots = value.roots as RecoveryRoot[];
  return value.artifacts.every(artifact => roots.some(root => artifact.path.startsWith(root.root + '/dist/') ||
    ['package.json', '.ready.json', '.artifact.tgz', 'dist'].some(name => artifact.path === join(root.root, name))));
}
export function validateLinuxLockRecovery(value: unknown): asserts value is LinuxLockRecovery {
  if (!object(value) || !keys(value, ['schemaVersion', 'revision', 'id', 'baselineBoot', 'windows', 'initial', 'sealing', 'seal', 'completion']) ||
      value.schemaVersion !== 1 || value.revision !== 3 || !uuid(value.id) || !uuid(value.baselineBoot) ||
      !Array.isArray(value.windows) || !value.windows.length || value.windows.length > 16 || !value.windows.every(uuid) ||
      value.windows[0] !== value.baselineBoot || !unique(value.windows) || !validInventory(value.initial)) throw linuxLockRetirementUnverified();
  for (const name of ['sealing', 'seal', 'completion'] as const) {
    const record = value[name];
    if (record === undefined) continue;
    if (!object(record) || !keys(record, name === 'completion' ? ['boot', 'method', 'inventory'] : ['boot', 'inventory', 'masks']) ||
        !uuid(record.boot) || !validInventory(record.inventory) ||
        record.inventory.installation !== value.initial.installation ||
        (name === 'sealing' && !value.windows.includes(record.boot)) ||
        (name === 'seal' && record.boot !== value.windows.at(-1)) ||
        (name === 'completion' && !['cohort', 'reboot'].includes(record.method as string))) throw linuxLockRetirementUnverified();
    if (name !== 'completion' && (!Array.isArray(record.masks) || record.masks.length !== 2 || !record.masks.every(validLinuxRecoveryMask) ||
        record.masks[0].path !== '/etc/systemd/system/mdai-helper.service' ||
        !record.masks[1].path.endsWith('/.config/systemd/user/app.maddots.ai.helper.service'))) throw linuxLockRetirementUnverified();
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 768 * 1024) throw linuxLockRetirementUnverified();
  const completion = value.completion;
  if (object(completion) && completion.method === 'reboot' &&
      (!object(value.seal) || completion.boot === value.seal.boot || !sameRecoveryInventory(completion.inventory as RecoveryInventory, value.seal.inventory as RecoveryInventory))) {
    throw linuxLockRetirementUnverified();
  }
}
export const sameRecoveryInventory = (a: RecoveryInventory, b: RecoveryInventory): boolean => JSON.stringify(a) === JSON.stringify(b);

export async function recoveryBoot(read: () => Promise<string> = linuxBootId): Promise<string> {
  try {
    const boot = await read();
    if (!uuid(boot)) throw linuxLockRetirementUnverified();
    return boot;
  } catch { throw linuxLockRetirementUnverified(); }
}

/** Record and sync this result BEFORE any installed module can be repaired.
 * Beginning retains evidence, not retirement proof. Read only the global boot
 * ID here: unreadable same-UID process images must not prevent a baseline from
 * being saved. Seal and completion retain their separate proof requirements. */
export async function beginLinuxLockRecovery(inventory: RecoveryInventory, previous?: LinuxLockRecovery,
  boot: () => Promise<string> = linuxBootId): Promise<LinuxLockRecovery> {
  if (!validInventory(inventory)) throw linuxLockRetirementUnverified();
  const current = await recoveryBoot(boot);
  if (previous) {
    validateLinuxLockRecovery(previous);
    if (previous.initial.installation !== inventory.installation) throw linuxLockRetirementUnverified();
    if (!previous.completion) {
      if (previous.seal || previous.windows.at(-1) === current) return previous;
      // A patching-only record cannot prove that a reboot occurred after seal.
      const next = {...previous, windows: [...previous.windows, current]};
      validateLinuxLockRecovery(next); return next;
    }
  }
  return {schemaVersion: 1, revision: 3, id: randomUUID(), baselineBoot: current, windows: [current], initial: structuredClone(inventory)};
}

/** Historical service installation used anonymous atomicWrite siblings. Their
 * names are ambiguous, so refuse pending UUID publications without opening
 * their contents or inspecting unrelated unit files, masks or subdirectories. */
export async function assertLinuxUnitPublicationsSettled(units: readonly string[]): Promise<void> {
  if (units.length > 256 || units.some(unit => !path(unit) ||
      !unit.endsWith('/app.maddots.ai.helper.service') && !unit.endsWith('/app.maddots.ai.helper.plist'))) throw linuxLockRetirementUnverified();
  let entries = 0;
  try {
    for (const directory of new Set(units.map(unit => dirname(unit)))) {
      await assertNoSymlinks(directory);
      let before;
      try { before = await lstat(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (!before.isDirectory() || before.uid !== process.getuid?.() || (before.mode & 0o022)) throw linuxLockRetirementUnverified();
      const handle = await opendir(directory);
      try {
        for (let entry = await handle.read(); entry; entry = await handle.read()) {
          if (++entries > 8192 || /^\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.tmp$/u.test(entry.name)) throw linuxLockRetirementUnverified();
        }
      } finally { await handle.close(); }
      const after = await lstat(directory);
      if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw linuxLockRetirementUnverified();
    }
  } catch { throw linuxLockRetirementUnverified(); }
}

/** Inventory only supported package artifacts, never credentials or environment. */
export async function inventoryLinuxRecovery(installation: string, data: string[], roots: RecoveryRoot[], writable: string[], states: string[], units?: string[]): Promise<RecoveryInventory> {
  await assertLinuxUnitPublicationsSettled(units ?? []);
  const artifacts: RecoveryInventory['artifacts'] = [];
  let bytes = 0;
  let entriesSeen = 0;
  const add = async (filePath: string) => {
    if (artifacts.length >= 8192) throw linuxLockRetirementUnverified();
    await assertNoSymlinks(filePath);
    let file;
    try { file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      artifacts.push({path: filePath, sha256: null}); return;
    }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o022) || info.size > 64 * 1024 * 1024) throw linuxLockRetirementUnverified();
      bytes += info.size;
      if (bytes > 128 * 1024 * 1024) throw linuxLockRetirementUnverified();
      const value = await file.readFile(), after = await file.stat(), named = await lstat(filePath);
      if (info.dev !== named.dev || info.ino !== named.ino || info.size !== value.length || info.size !== after.size ||
          info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs) throw linuxLockRetirementUnverified();
      artifacts.push({path: filePath, sha256: createHash('sha256').update(value).digest('hex')});
    } finally { await file.close(); }
  };
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 8 || artifacts.length >= 8192) throw linuxLockRetirementUnverified();
    await assertNoSymlinks(directory);
    let entries;
    try { entries = await readdir(directory, {withFileTypes: true}); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') {await add(directory); return;} throw error; }
    if (entries.length > 8192) throw linuxLockRetirementUnverified();
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++entriesSeen > 8192) throw linuxLockRetirementUnverified();
      // Include the coordinator sidecar too: it determines which barrier an
      // old CLI/module host consults. Its stable path has no inventory cycle.
      const name = join(directory, entry.name);
      if (entry.isDirectory()) await walk(name, depth + 1);
      else await add(name); // Refuses links, devices and other nonregular entries.
    }
  };
  for (const root of [...roots].sort((a, b) => a.root.localeCompare(b.root))) {
    await add(join(root.root, 'package.json'));
    await add(join(root.root, '.ready.json'));
    await add(join(root.root, '.artifact.tgz'));
    await walk(join(root.root, 'dist'), 0);
  }
  const value = {installation, data: [...data].sort(), writable: [...writable].sort(), states: [...states].sort(),
    ...(units ? {units: [...units].sort()} : {}),
    roots: [...roots].sort((a, b) => a.root.localeCompare(b.root)),
    artifacts: artifacts.sort((a, b) => a.path.localeCompare(b.path))};
  if (!validInventory(value)) throw linuxLockRetirementUnverified();
  await assertLinuxUnitPublicationsSettled(units ?? []);
  return value;
}

export interface RecoveryChecks {
  inventory(): Promise<RecoveryInventory>;
  boot?(): Promise<string>;
  // Function seams for isolated components, never parsed proof/argv/env values.
  entrypoints?(postBoot: boolean): Promise<readonly {mask: LinuxRecoveryMask}[]>;
}
export async function sealLinuxLockRecovery(record: LinuxLockRecovery, checks: RecoveryChecks): Promise<LinuxLockRecovery> {
  validateLinuxLockRecovery(record);
  if (record.completion) throw linuxLockRetirementUnverified();
  const boot = await recoveryBoot(checks.boot);
  if (boot !== record.windows.at(-1)) throw linuxLockRetirementUnverified();
  const masks = (await (checks.entrypoints ?? verifyLinuxRecoveryEntrypoints)(false)).map(entry => entry.mask);
  const inventory = await checks.inventory();
  if (!validInventory(inventory) || inventory.installation !== record.initial.installation || inventory.roots.some(root => root.unpublished) ||
      inventory.artifacts.some(artifact => artifact.path.endsWith('.tmp')) ||
      record.seal && !sameRecoveryInventory(record.seal.inventory, inventory) ||
      record.seal && JSON.stringify(record.seal.masks) !== JSON.stringify(masks) ||
      !sameRecoveryInventory(inventory, await checks.inventory()) || await recoveryBoot(checks.boot) !== boot) throw linuxLockRetirementUnverified();
  const result = {...record, seal: {boot, inventory, masks}};
  validateLinuxLockRecovery(result); return result;
}

/** Caller holds exclusive coordinator AND all registered data/update guards. */
export async function verifyLinuxLockRecovery(record: LinuxLockRecovery, checks: RecoveryChecks): Promise<string> {
  validateLinuxLockRecovery(record);
  const boot = await recoveryBoot(checks.boot);
  if (!record.seal || record.completion || record.windows.includes(boot)) throw linuxLockRetirementUnverified();
  const masks = (await (checks.entrypoints ?? verifyLinuxRecoveryEntrypoints)(true)).map(entry => entry.mask);
  if (JSON.stringify(masks) !== JSON.stringify(record.seal.masks)) throw linuxLockRetirementUnverified();
  if (!sameRecoveryInventory(record.seal.inventory, await checks.inventory()) || await recoveryBoot(checks.boot) !== boot) throw linuxLockRetirementUnverified();
  return boot;
}

/** Bounded reconciliation: preserve all state and refuse obligations needing
 * the runner's journal/containment or external-work recovery authority. This
 * migration must never manufacture CLEAN records or resume interrupted tools. */
export async function reconcileLinuxRecovery(writable: readonly string[], states: readonly string[], roots: readonly RecoveryRoot[] = []): Promise<void> {
  // Only fresh inventoried runtime roots can identify this source namespace.
  // A source runner directory is not retained runner state. Its descendants
  // still receive every ordinary publication/transaction and file check below.
  if (roots.length > 256 || roots.some(root => !root || !path(root.root) || typeof root.unpublished !== 'boolean')) throw linuxLockRetirementUnverified();
  const runnerModules = new Set(roots.filter(root => !root.unpublished).map(root => join(root.root, 'dist', 'runner')));
  // npm's pinned production graph includes generated protobuf subtrees at
  // depth 9 beneath updates/releases/<commit>. Allow dependency nesting and
  // retained backup prefixes, while bounding the whole traversal, including
  // repeated registered roots, to 65,536 entries and 32 directory levels.
  const maxDepth = 32, maxEntries = 65_536;
  // These namespaces contain multi-step transactions, external obligations or
  // their recovery evidence. A terminal-looking receipt alone is not proof
  // that its other files or external effects settled. Leave them to their
  // owning subsystem, including orphaned records without their parent intent.
  const transactions = new Set(['backups', 'staging', 'local-choices', 'unmanaged-conflicts', 'holding', 'holding-records',
    'allows', 'runner', 'run-homes', 'claude-code', '.claude-plugin']);
  const transactionFiles = new Set(['imports.json', 'claude-plugin-registration.json', 'claude-plugin-waiting.json',
    'notification-state.json', 'agent-notification-state.json']);
  let count = 0;
  for (const state of states) {
    // Read only registered application metadata, including earlier layouts.
    // Never open a selected token file or scan its parent.
    if (!path(state) || !state.endsWith('/state.json') || !writable.includes(dirname(state))) throw linuxLockRetirementUnverified();
    let metadata: unknown;
    try { metadata = JSON.parse(await readPrivateFile(state, 1024 * 1024, {singleLink: true})); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw linuxLockRetirementUnverified(); }
    if (!object(metadata)) throw linuxLockRetirementUnverified();
    if (metadata.tokenFile !== undefined && (!path(metadata.tokenFile) ||
        !writable.some(registered => inside(registered, dirname(metadata.tokenFile as string))))) throw linuxLockRetirementUnverified();
  }
  const pendingSettled = async (file: string): Promise<void> => {
    try {
      // Both the legacy single journal and current per-entry journals retain
      // literal null after settlement. Every other value, including invalid
      // JSON, needs the sync engine's recovery authority before completion.
      if (JSON.parse(await readPrivateFile(file, 1024 * 1024, {singleLink: true})) !== null) throw linuxLockRetirementUnverified();
    } catch { throw linuxLockRetirementUnverified(); }
  };
  const inspect = async (directory: string, depth: number, kind: 'ordinary' | 'pending' | 'transaction' | 'updates' | 'releases' = 'ordinary'): Promise<void> => {
    if (depth > maxDepth) throw linuxLockRetirementUnverified();
    await assertNoSymlinks(directory);
    let handle;
    try { handle = await opendir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    try {
      for (let entry = await handle.read(); entry; entry = await handle.read()) {
        if (++count > maxEntries || entry.isSymbolicLink() || entry.name.endsWith('.tmp') || entry.name.startsWith('staging-') ||
            entry.name.startsWith('refused-stage-') || kind === 'transaction' ||
            /^\.(?:allow|agent-setup)-.*\.command$/u.test(entry.name) || entry.name.startsWith('.mdai-publish-') ||
            /^\.restore-.*\.json$/u.test(entry.name) || transactionFiles.has(entry.name) ||
            kind === 'pending' && (!entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) ||
            kind === 'updates' && (entry.name === 'releases' ? !entry.isDirectory() : !['.lock', '.lock.guard'].includes(entry.name) || !entry.isFile()) ||
            kind === 'releases' && (!entry.isDirectory() || !/^[a-f0-9]{40}$/u.test(entry.name))) throw linuxLockRetirementUnverified();
        const name = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (depth === 0 && entry.name === 'sync-pending.json') throw linuxLockRetirementUnverified();
          // Cached releases still need a bounded walk: a directory named
          // releases cannot hide an incomplete physical publication.
          await inspect(name, depth + 1, transactions.has(entry.name) && !runnerModules.has(name) ? 'transaction' :
            kind === 'updates' ? 'releases' : depth === 0 && entry.name === 'sync-pending' ? 'pending' :
              depth === 0 && entry.name === 'updates' ? 'updates' : 'ordinary');
        } else {
          if (!entry.isFile() || transactions.has(entry.name) || depth === 0 && ['sync-pending', 'updates'].includes(entry.name) ||
              kind === 'updates' && entry.name === 'releases') throw linuxLockRetirementUnverified();
          if (kind === 'pending' || depth === 0 && entry.name === 'sync-pending.json') await pendingSettled(name);
        }
      }
    } finally { await handle.close(); }
  };
  for (const root of writable) await inspect(root, 0, root === '/var/lib/mdai/runs' ? 'transaction' : 'ordinary');
}
