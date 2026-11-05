// Fixed Linux installations never obtain executable bytes from mutable state.
// This coordinator enrolls only fresh storage. S5-10 records remain obligations,
// not a source of code or evidence that an installation is safe to enroll.
import { lstat, readdir, realpath } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { HelperError, clock, type Timing } from './config.js';
import { assertNoSymlinks, atomicWrite, ensurePrivateDirectory, inside, readPrivateFile, type HelperPaths } from './paths.js';
import { acquireWriteGuard } from './write-lock.js';
import { assertSystemInvocation, inspectSystemInstallation, systemPolicy, systemRuntimeMode, type SystemRuntimePolicy } from './system-runtime-preflight.js';
export { systemRuntimeMode, type SystemRuntimePolicy } from './system-runtime-preflight.js';
export { assertSystemRuntimeOperation } from './system-runtime-operation.js';

export interface SystemRuntimeBinding {
  schema: 'fixed-system-runtime-v1'; revision: 3;
  installation: {root: string; dev: string; ino: string};
  storage: {data: string; dev: string; ino: string};
  graph: Record<string, string>;
  layout: {home: string; config: string; state: string; runtime: string; roots: string[]; states: string[]};
}
const failure = (reason: string) => new HelperError('SYSTEM_RUNTIME_FIXED',
  `The fixed Linux system helper ${reason}. Automatic repair, cached runtimes, update and rollback are disabled; only the founder's root install may change executable code. Retained S5-10 recovery obligations must be resolved before enrollment.`);


async function absent(path: string): Promise<boolean> {
  try { await lstat(path); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
}
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function fixedStorage(policy: Readonly<SystemRuntimePolicy>): NonNullable<HelperPaths['linuxStorage']> {
  const data = [...new Set([policy.data, join(policy.home, '.local/share/maddots-ai'), join(policy.home, 'Library/Application Support/maddots-ai')])];
  const states = [...new Set([policy.state, join(policy.home, '.local/state/maddots-ai')])];
  return {roots: [...new Set([...data, policy.config, join(policy.home, '.config/maddots-ai'), ...states,
    ...states.map(root => join(root, 'runtime')), policy.runtime, `/run/user/${policy.uid}/mdai`])].sort(),
  states: [...new Set([...data, ...states].map(root => join(root, 'state.json')))].sort()};
}

/** Read and hash the physical package, including its dependency closure. Only
 * internal package symlinks are allowed, and their targets are independently
 * inventoried. There is no executable selector in the returned binding. */
export async function assertSystemRuntime(root: string, paths: HelperPaths,
  policy: Readonly<SystemRuntimePolicy> = systemPolicy): Promise<SystemRuntimeBinding | undefined> {
  await assertSystemInvocation(undefined, policy);
  if (!systemRuntimeMode(root, policy)) return;
  if (root !== policy.root || paths.platform !== 'linux' || process.getuid?.() !== policy.uid ||
      userInfo().uid !== policy.uid || userInfo().username !== policy.username || policy.uid === 0 || paths.data !== policy.data || paths.home !== policy.home ||
      paths.config !== policy.config || paths.stateDir !== policy.state || paths.runtime !== policy.runtime ||
      paths.state !== join(policy.state, 'state.json') || paths.logs !== join(policy.data, 'logs') ||
      !same(paths.linuxStorage, fixedStorage(policy)) ||
      paths.credentialFile !== undefined && paths.credentialFile !== join(policy.config, 'credentials.json')) throw failure('has an unreviewed path or account identity');
  await assertNoSymlinks(paths.data);
  const storage = await lstat(paths.data, {bigint: true});
  if (!storage.isDirectory() || storage.uid !== BigInt(policy.uid) || (storage.mode & 0o777n) !== 0o700n ||
      await realpath(paths.data) !== paths.data) throw failure('requires the existing private mdai data root');
  const {installation, graph} = await inspectSystemInstallation(root, policy);
  return {schema: 'fixed-system-runtime-v1', revision: 3,
    installation,
    storage: {data: paths.data, dev: String(storage.dev), ino: String(storage.ino)}, graph,
    layout: {home: paths.home, config: paths.config!, state: paths.stateDir!, runtime: paths.runtime!,
      roots: fixedStorage(policy).roots, states: fixedStorage(policy).states}};
}

async function coordinatorIdentity(directory: string): Promise<{dev: string; ino: string}> {
  await assertNoSymlinks(directory);
  const info = await lstat(directory, {bigint: true});
  if (!info.isDirectory() || info.uid !== BigInt(process.getuid!()) || (info.mode & 0o777n) !== 0o700n) throw failure('has unsafe coordinator storage');
  return {dev: String(info.dev), ino: String(info.ino)};
}
async function assertCoordinatorIdentity(directory: string, identity: {dev: string; ino: string}): Promise<void> {
  if (!same(await coordinatorIdentity(directory), identity)) throw failure('has replaced coordinator storage');
}
async function assertStorageIdentity(binding: SystemRuntimeBinding): Promise<void> {
  await assertNoSymlinks(binding.storage.data);
  const info = await lstat(binding.storage.data, {bigint: true});
  if (!info.isDirectory() || info.uid !== BigInt(process.getuid!()) || (info.mode & 0o777n) !== 0o700n ||
      String(info.dev) !== binding.storage.dev || String(info.ino) !== binding.storage.ino) throw failure('has replaced data storage');
}
async function guardIdentity(directory: string): Promise<{dev: string; ino: string}> {
  await assertNoSymlinks(directory);
  let info;
  try { info = await lstat(join(directory, '.guard'), {bigint: true}); }
  catch { throw failure('lost its retained coordinator guard'); }
  if (!info.isFile() || info.uid !== BigInt(process.getuid!()) || info.nlink !== 1n || (info.mode & 0o777n) !== 0o600n) {
    throw failure('has an unsafe coordinator guard');
  }
  return {dev: String(info.dev), ino: String(info.ino)};
}
async function inspectCoordinator(directory: string, empty = false): Promise<void> {
  await assertNoSymlinks(directory);
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) throw failure('has unsafe coordinator storage');
  for (const name of await readdir(directory)) {
    if (name !== '.guard' && (empty || name !== 'state.json')) throw failure('has unknown or incomplete coordinator publications');
    const file = await lstat(join(directory, name));
    if (!file.isFile() || file.uid !== process.getuid?.() || file.nlink !== 1 || (file.mode & 0o777) !== 0o600) throw failure('has unsafe coordinator metadata');
  }
}
async function readBinding(directory: string, binding: SystemRuntimeBinding): Promise<void> {
  await inspectCoordinator(directory);
  let record: unknown;
  try { record = JSON.parse(await readPrivateFile(join(directory, 'state.json'), 8 * 1024 * 1024, {singleLink: true})); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
    throw failure('has invalid coordinator metadata');
  }
  // Exact schema comparison rejects extra pointers, old repair phases and
  // recovery obligations. None can be normalized away during a restart.
  if (!same(record, {...binding, coordinator: await coordinatorIdentity(directory), guard: await guardIdentity(directory)})) {
    throw failure('has changed graph, storage identity, revision or retained recovery state');
  }
}

/** The caller supplies the existing Linux fresh-storage/provenance check. It
 * runs before coordinator creation and again under the real shared guard. */
export async function prepareSystemRuntime(root: string, paths: HelperPaths, timing: Timing = clock,
  fresh: (guarded: boolean) => Promise<void>, policy: Readonly<SystemRuntimePolicy> = systemPolicy): Promise<void> {
  const binding = await assertSystemRuntime(root, paths, policy);
  if (!binding) throw failure('is not the reviewed fixed installation');
  const directory = join(policy.data, '.write-lock-upgrade'), state = join(directory, 'state.json');
  const hadState = !await absent(state);
  if (!hadState) {
    if (!await absent(directory)) await inspectCoordinator(directory, true);
    await fresh(false);
  } else await readBinding(directory, binding);
  await ensurePrivateDirectory(directory);
  const identity = await coordinatorIdentity(directory);
  const guard = await acquireWriteGuard(join(directory, '.guard'), timing, timing.now() + 10_000);
  try {
    await assertCoordinatorIdentity(directory, identity);
    const current = await assertSystemRuntime(root, paths, policy);
    if (!same(binding, current)) throw failure('changed while waiting for coordinator ownership');
    if (await absent(state)) {
      if (hadState) throw failure('lost its retained coordinator record');
      await inspectCoordinator(directory, true);
      await fresh(true);
      await assertCoordinatorIdentity(directory, identity);
      if (!same(binding, await assertSystemRuntime(root, paths, policy))) throw failure('changed before enrollment');
      await guard.assertCurrent();
      await atomicWrite(state, JSON.stringify({...binding, coordinator: identity, guard: await guardIdentity(directory)}) + '\n', {singleLink: true});
    } else await readBinding(directory, binding);
    await assertCoordinatorIdentity(directory, identity);
    await guard.assertCurrent();
    await readBinding(directory, binding);
    await assertStorageIdentity(binding);
  } finally { await guard(); }
}

/** All writers, including data-only runner callers, derive their coordinator
 * from the compiled fixed contract. Package sidecars are never consulted. */
export async function assertSystemRuntimeReady(paths: HelperPaths, timing: Timing = clock,
  policy: Readonly<SystemRuntimePolicy> = systemPolicy): Promise<void> {
  if (!inside(policy.data, paths.data)) throw failure('refuses an unregistered writer data root');
  const directory = join(policy.data, '.write-lock-upgrade');
  // Partial runner callers have only data. Derive the entire layout from the
  // compiled contract, never from the mutable coordinator's coverage lists.
  const registered: HelperPaths = {...paths, platform: 'linux', home: policy.home, data: policy.data,
    config: policy.config, stateDir: policy.state, runtime: policy.runtime, state: join(policy.state, 'state.json'), logs: join(policy.data, 'logs'),
    linuxStorage: fixedStorage(policy)};
  if (typeof paths.state === 'string' && (paths.home !== policy.home || paths.config !== policy.config || paths.stateDir !== policy.state ||
      paths.runtime !== policy.runtime || paths.state !== registered.state || paths.logs !== registered.logs ||
      !same(paths.linuxStorage, registered.linuxStorage))) throw failure('refuses a changed writer storage layout');
  const binding = await assertSystemRuntime(policy.root, registered, policy);
  if (!binding) throw failure('is not the reviewed fixed installation');
  await readBinding(directory, binding);
  const identity = await coordinatorIdentity(directory);
  const guard = await acquireWriteGuard(join(directory, '.guard'), timing, timing.now() + 10_000);
  try {
    await assertCoordinatorIdentity(directory, identity);
    const current = await assertSystemRuntime(policy.root, registered, policy);
    if (!same(binding, current)) throw failure('changed while waiting for writer admission');
    await readBinding(directory, binding);
    await assertCoordinatorIdentity(directory, identity);
    await guard.assertCurrent();
    await assertStorageIdentity(binding);
  } finally { await guard(); }
}
