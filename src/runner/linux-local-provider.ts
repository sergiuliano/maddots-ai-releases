import {createHash} from 'node:crypto';
import {constants, type BigIntStats} from 'node:fs';
import {lstat, open, readdir, realpath, type FileHandle} from 'node:fs/promises';
import {dirname, isAbsolute, join, normalize} from 'node:path';
import {performance} from 'node:perf_hooks';
import {parseJsonWithoutDuplicateKeys} from '../shared/strict-json.js';
import {HelperError} from '../config.js';

export const LINUX_LOCAL_PROVIDER_VERSION = '0.40.14';
export const LINUX_LOCAL_PROVIDER_MODEL = 'mdai-qwen3:30b-a3b-ctx8192-cpu16';
export const LINUX_LOCAL_PROVIDER_UPSTREAM = 'qwen3:30b-a3b';
export const LINUX_LOCAL_PROVIDER_URL = 'http://127.0.0.1:11434/v1';
export const LINUX_LOCAL_PROVIDER_PREPARE_MS = 120_000;
export const LINUX_LOCAL_PROVIDER_INVENTORY = '/usr/local/share/mdai/ollama/provider.json';
const STORE_ROOT = '/usr/local/share/mdai/ollama';
const CLOSURE_ROOT = '/usr/local/lib/mdai/ollama';
const SHA = /^[a-f0-9]{64}$/;
const MAX_JSON = 1024 * 1024;
const MAX_FILES = 4096;
const PARAMETERS = Object.freeze({num_thread: 16, num_ctx: 8192, num_gpu: 0});
const RESOURCES = Object.freeze({cpuMax: '1600000 100000', memoryMax: 25_000_000_000, memorySwapMax: 0, memoryOomGroup: 1});
const UPSTREAM_MANIFEST = 'manifests/registry.ollama.ai/library/qwen3/30b-a3b';
const POLICY_MANIFEST = 'manifests/registry.ollama.ai/library/mdai-qwen3/30b-a3b-ctx8192-cpu16';
type Pin = Readonly<{path: string; sha256: string; size: number}>;
type ClosurePin = Pin & Readonly<{executable: boolean}>;
type ProviderCwdContract = Readonly<{path: 'lib/ollama'; contract: 'ollama-inherited-cwd-v1'}>;
export type LinuxLocalProviderInventory = Readonly<{format: 1; kind: 'ollama'; version: '0.40.14';
  closure: Readonly<{digest: string; executable: 'bin/ollama'; files: readonly ClosurePin[]; providerCwd: ProviderCwdContract}>;
  store: Readonly<{digest: string; upstreamManifest: Pin; policyManifest: Pin; blobs: readonly Pin[]}>}>;
type Identity = Readonly<{path: string; dev: string; ino: string; mtimeNs: string; ctimeNs: string}>;
export type LinuxLocalProviderSpec = Readonly<{format: 1; kind: 'ollama'; version: '0.40.14'; executable: string;
  providerCwd: Readonly<{path: string; contract: 'ollama-inherited-cwd-v1'; dev: string; ino: string}>;
  closureDigest: string; storeDigest: string; modelsPath: string; upstreamModel: string; model: string;
  modelDigest: string; upstreamDigest: string; upstreamManifest: string; policyManifest: string; baseURL: string;
  capabilities: readonly ['completion', 'tools']; parameters: typeof PARAMETERS; resources: typeof RESOURCES;
  env: Readonly<Record<string, string>>; files: readonly (Identity & Pin & Readonly<{executable: boolean}>)[];
  directories: readonly (Identity & Readonly<{immutable: boolean}>)[]}>;
export type LinuxLocalProviderSelection = {tool: string; provider: string | null; model: string};
type Operation = {signal?: AbortSignal; deadline?: number; monotonicDeadline?: number};
export type LinuxLocalProviderPreparationOptions = {
  /** Synthetic fixtures only. Runtime callers use the fixed root-owned production inventory. */
  inventoryPath?: string; closureRoot?: string; storeRoot?: string; uid?: number; trustedAncestorUid?: number;
  ancestorRoot?: string;
  checkpoint?: (point: string, path: string) => void | Promise<void>;
};
type Receipt = {spec: LinuxLocalProviderSpec; uid: number; trustedAncestorUid: number; immutableDirectories: Set<string>};
const issued = new WeakMap<object, Receipt>();
let prepared: LinuxLocalProviderSpec | undefined;
let preparation: PreparationLease | undefined;
function refuse(message = 'The immutable local provider is unavailable.'): never {throw new HelperError('adapter_refused', message);}
function live(operation: Operation): void {
  if (operation.signal?.aborted) throw new HelperError('runner_stopped', 'Local provider preparation was cancelled.');
  if (operation.deadline !== undefined && (!Number.isFinite(operation.deadline) || Date.now() >= operation.deadline) ||
      operation.monotonicDeadline !== undefined && performance.now() >= operation.monotonicDeadline) refuse('Local provider preparation exceeded its deadline.');
}
async function bounded<T>(operation: Operation, work: () => Promise<T>): Promise<T> {
  live(operation);
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new HelperError('runner_stopped', 'Local provider preparation was cancelled.'));
    operation.signal?.addEventListener('abort', abort, {once: true});
    if (operation.deadline !== undefined || operation.monotonicDeadline !== undefined) timer = setTimeout(() => reject(new HelperError('adapter_refused', 'Local provider preparation exceeded its deadline.')),
      Math.max(0, Math.min(operation.deadline === undefined ? Infinity : operation.deadline - Date.now(), operation.monotonicDeadline === undefined ? Infinity : operation.monotonicDeadline - performance.now())));
  });
  try {const result = await Promise.race([work(), stopped]); live(operation); return result;}
  finally {if (timer) clearTimeout(timer); if (abort) operation.signal?.removeEventListener('abort', abort);}
}
/** A timed-out read cannot cancel libuv I/O. Retain its sole lease until close is confirmed. */
class PreparationLease {
  private openings = 0;
  private finished = false;
  private readonly handles = new Set<FileHandle>();
  private readonly closing = new Map<FileHandle, Promise<void>>();
  async open(path: string, operation: Operation): Promise<FileHandle> {
    this.openings++;
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      this.handles.add(file);
      try {live(operation); if (this.finished) refuse(); return file;}
      catch (error) {void this.close(file); throw error;}
    } finally {this.openings--; this.release();}
  }
  close(file: FileHandle): Promise<void> {
    const pending = this.closing.get(file); if (pending) return pending;
    const closed = Promise.resolve().then(() => file.close()).then(() => {
      this.handles.delete(file); this.closing.delete(file); this.release();
    });
    // A rejected close gives no proof of release. Keep the handle and lease,
    // and observe rejection even if cancellation has already returned to the caller.
    void closed.catch(() => {});
    this.closing.set(file, closed); return closed;
  }
  finish(): void {
    this.finished = true;
    // Also cover an open that won its race just before bounded() observed a
    // cancellation, before readPinned received the returned handle.
    for (const file of this.handles) void this.close(file);
    this.release();
  }
  private release(): void {
    if (this.finished && !this.openings && !this.handles.size && preparation === this) preparation = undefined;
  }
}
function record(value: unknown): value is Record<string, unknown> {return value !== null && typeof value === 'object' && !Array.isArray(value);}
function keys(value: unknown, expected: string): value is Record<string, unknown> {return record(value) && Object.keys(value).sort().join(',') === expected.split(',').sort().join(',');}
function hash(value: Buffer | string): string {return createHash('sha256').update(value).digest('hex');}
function relative(value: unknown): value is string {return typeof value === 'string' && value.length <= 512 && /^[A-Za-z0-9._/-]+$/.test(value) && !isAbsolute(value) && normalize(value) === value && !value.split('/').some(part => part === '.' || part === '..' || !part);}
function pin(value: unknown, executable = false): value is ClosurePin {
  return keys(value, executable ? 'path,sha256,size,executable' : 'path,sha256,size') && relative(value.path) &&
    typeof value.sha256 === 'string' && SHA.test(value.sha256) && Number.isSafeInteger(value.size) && Number(value.size) > 0 && Number(value.size) <= 32_000_000_000 &&
    (!executable || typeof value.executable === 'boolean');
}
function sorted(values: readonly Pin[]): boolean {return values.every((value, index) => index === 0 || values[index - 1].path < value.path);}
/** Reviewed root provisioning binds both inventory digests to exact sorted pins. */
export function parseLinuxLocalProviderInventory(value: unknown): LinuxLocalProviderInventory {
  if (!keys(value, 'format,kind,version,closure,store') || value.format !== 1 || value.kind !== 'ollama' || value.version !== LINUX_LOCAL_PROVIDER_VERSION ||
      !keys(value.closure, 'digest,executable,files,providerCwd') || typeof value.closure.digest !== 'string' || !SHA.test(value.closure.digest) || value.closure.executable !== 'bin/ollama' ||
      !keys(value.closure.providerCwd, 'path,contract') || value.closure.providerCwd.path !== 'lib/ollama' || value.closure.providerCwd.contract !== 'ollama-inherited-cwd-v1' ||
      !Array.isArray(value.closure.files) || !value.closure.files.length || value.closure.files.length > MAX_FILES || !value.closure.files.every(file => pin(file, true)) || !sorted(value.closure.files) ||
      !value.closure.files.some(file => file.path === 'bin/ollama' && file.executable) ||
      !value.closure.files.some(file => file.path.startsWith('lib/ollama/')) ||
      !keys(value.store, 'digest,upstreamManifest,policyManifest,blobs') || typeof value.store.digest !== 'string' || !SHA.test(value.store.digest) ||
      !pin(value.store.upstreamManifest) || value.store.upstreamManifest.path !== UPSTREAM_MANIFEST || value.store.upstreamManifest.size > MAX_JSON ||
      !pin(value.store.policyManifest) || value.store.policyManifest.path !== POLICY_MANIFEST || value.store.policyManifest.size > MAX_JSON ||
      !Array.isArray(value.store.blobs) || !value.store.blobs.length || value.store.blobs.length > MAX_FILES || !value.store.blobs.every(blob => pin(blob) && blob.path === `blobs/sha256-${blob.sha256}`) || !sorted(value.store.blobs)) refuse();
  const closure = {executable: value.closure.executable, files: value.closure.files.map(file => ({path: file.path, sha256: file.sha256, size: file.size, executable: file.executable})),
    providerCwd: {path: value.closure.providerCwd.path, contract: value.closure.providerCwd.contract}};
  const plainPin = (file: Pin) => ({path: file.path, sha256: file.sha256, size: file.size});
  const store = {upstreamManifest: plainPin(value.store.upstreamManifest), policyManifest: plainPin(value.store.policyManifest), blobs: value.store.blobs.map(plainPin)};
  if (hash(JSON.stringify(closure)) !== value.closure.digest || hash(JSON.stringify(store)) !== value.store.digest ||
      value.closure.files.length + value.store.blobs.length + 3 > MAX_FILES ||
      [...value.closure.files, value.store.upstreamManifest, value.store.policyManifest, ...value.store.blobs].reduce((sum, file) => sum + file.size, 0) > 96_000_000_000) refuse();
  return value as LinuxLocalProviderInventory;
}
export function linuxLocalProviderSelection(input: LinuxLocalProviderSelection): boolean {
  if (input.tool !== 'opencode') return false;
  return input.provider === 'ollama' && input.model === LINUX_LOCAL_PROVIDER_MODEL || input.provider === null && input.model === `ollama/${LINUX_LOCAL_PROVIDER_MODEL}`;
}
export function assertLinuxLocalProviderSpec(value: unknown): asserts value is LinuxLocalProviderSpec {
  if (!value || typeof value !== 'object' || !issued.has(value)) refuse('Local provider preparation is required before authorization.');
}
export function preparedLinuxLocalProvider(input: LinuxLocalProviderSelection): LinuxLocalProviderSpec | undefined {
  if (input.tool !== 'opencode') return undefined;
  if (!linuxLocalProviderSelection(input) || !prepared) refuse('Select the approved immutable Ollama policy model and prepare it before authorization.');
  assertLinuxLocalProviderSpec(prepared); return prepared;
}
function identity(path: string, info: BigIntStats): Identity {return {path, dev: String(info.dev), ino: String(info.ino), mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs)};}
function same(value: Identity, info: BigIntStats): boolean {return value.dev === String(info.dev) && value.ino === String(info.ino) && value.mtimeNs === String(info.mtimeNs) && value.ctimeNs === String(info.ctimeNs);}
function trusted(info: BigIntStats, uid: number, directory: boolean, exactMode?: number): void {
  if (info.uid !== BigInt(uid) || !(directory ? info.isDirectory() : info.isFile()) || info.mode & 0o6022n ||
      exactMode !== undefined && (info.mode & 0o7777n) !== BigInt(exactMode) || !directory && info.nlink !== 1n) refuse();
}
async function readPinned(path: string, expected: Omit<Pin, 'path'> | undefined, executable: boolean, operation: Operation,
  lease: PreparationLease, uid: number, checkpoint?: LinuxLocalProviderPreparationOptions['checkpoint'], captureBytes = false): Promise<{file: Identity & Pin & {executable: boolean}; bytes?: Buffer}> {
  let file: FileHandle | undefined;
  try {
    file = await bounded(operation, () => lease.open(path, operation));
    const before = await bounded(operation, () => file!.stat({bigint: true}));
    trusted(before, uid, false, executable ? 0o555 : 0o444);
    if (before.size <= 0n || before.size > 32_000_000_000n || expected && before.size !== BigInt(expected.size)) refuse();
    const id = identity(path, before), digest = createHash('sha256'), chunks: Buffer[] = [], buffer = Buffer.allocUnsafe(1024 * 1024);
    const capture = captureBytes && before.size <= BigInt(MAX_JSON);
    if (captureBytes && !capture) refuse();
    let count = 0;
    while (true) {
      live(operation);
      const {bytesRead} = await bounded(operation, () => file!.read(buffer, 0, buffer.length, null));
      if (!bytesRead) break;
      count += bytesRead;
      if (count > Number(before.size)) refuse();
      digest.update(buffer.subarray(0, bytesRead));
      if (capture) chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      if (checkpoint) await bounded(operation, async () => checkpoint('chunk', path)); live(operation);
    }
    const sha256 = digest.digest('hex');
    if (count !== Number(before.size) || expected && sha256 !== expected.sha256 || !same(id, await bounded(operation, () => file!.stat({bigint: true}))) ||
        !same(id, await bounded(operation, () => lstat(path, {bigint: true})))) refuse();
    return {file: {...id, sha256, size: count, executable}, ...(capture ? {bytes: Buffer.concat(chunks)} : {})};
  } finally {
    if (file) {
      // Start cleanup even after cancellation. FileHandle.close waits for a
      // pending read, so awaiting it must obey the same preparation deadline.
      const closing = lease.close(file);
      await bounded(operation, () => closing);
    }
  }
}
function deepFreeze<T>(value: T): T {if (value && typeof value === 'object') {for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value);} return value;}
type Manifest = {schemaVersion: 2; mediaType: string; config: {mediaType: string; digest: string; size: number}; layers: {mediaType: string; digest: string; size: number}[]};
function manifest(bytes: Buffer): Manifest {
  const value = parseJsonWithoutDuplicateKeys(bytes.toString('utf8'));
  const descriptor = (row: unknown) => keys(row, 'mediaType,digest,size') && typeof row.mediaType === 'string' && /^application\/vnd\.[a-z0-9.+-]+$/.test(row.mediaType) &&
    typeof row.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(row.digest) && Number.isSafeInteger(row.size) && Number(row.size) > 0;
  if (!keys(value, 'schemaVersion,mediaType,config,layers') || value.schemaVersion !== 2 || value.mediaType !== 'application/vnd.docker.distribution.manifest.v2+json' ||
      !descriptor(value.config) || !Array.isArray(value.layers) || !value.layers.length || value.layers.length > 128 || !value.layers.every(descriptor)) refuse();
  return value as unknown as Manifest;
}
function verifyManifests(inventory: LinuxLocalProviderInventory, bytes: Map<string, Buffer>): void {
  const upstream = manifest(bytes.get(UPSTREAM_MANIFEST)!), policy = manifest(bytes.get(POLICY_MANIFEST)!);
  const blobs = new Map(inventory.store.blobs.map(blob => [`sha256:${blob.sha256}`, blob]));
  const used = new Set<string>();
  for (const row of [upstream.config, ...upstream.layers, policy.config, ...policy.layers]) {
    const found = blobs.get(row.digest); if (!found || found.size !== row.size) refuse(); used.add(row.digest);
  }
  if (used.size !== blobs.size || JSON.stringify(upstream.config) !== JSON.stringify(policy.config)) refuse();
  const params = 'application/vnd.ollama.image.params';
  if (JSON.stringify(upstream.layers.filter(row => row.mediaType !== params)) !== JSON.stringify(policy.layers.filter(row => row.mediaType !== params))) refuse();
  const layers = policy.layers.filter(row => row.mediaType === params);
  if (layers.length !== 1 || !policy.layers.some(row => row.mediaType === 'application/vnd.ollama.image.model')) refuse();
  const content = bytes.get(`blobs/sha256-${layers[0].digest.slice(7)}`);
  if (!content) refuse();
  const options = parseJsonWithoutDuplicateKeys(content.toString('utf8'));
  if (!keys(options, 'num_thread,num_ctx,num_gpu') || options.num_thread !== PARAMETERS.num_thread || options.num_ctx !== PARAMETERS.num_ctx || options.num_gpu !== PARAMETERS.num_gpu) refuse();
}
/** Reads and hashes data only, never launches Ollama, a loader, or a shell. */
export async function prepareLinuxLocalProvider(input: LinuxLocalProviderSelection & Operation, options: LinuxLocalProviderPreparationOptions = {}): Promise<LinuxLocalProviderSpec | undefined> {
  if (input.tool !== 'opencode') return undefined;
  if (!linuxLocalProviderSelection(input)) refuse('Linux OpenCode requires the approved immutable Ollama policy model.');
  const operation = {signal: input.signal, deadline: Math.min(input.deadline ?? Infinity, Date.now() + LINUX_LOCAL_PROVIDER_PREPARE_MS),
    monotonicDeadline: performance.now() + Math.min(LINUX_LOCAL_PROVIDER_PREPARE_MS, input.deadline === undefined ? Infinity : Math.max(0, input.deadline - Date.now()))};
  live(operation);
  if (preparation) refuse('Local provider preparation is active or awaiting file cleanup.');
  const lease = new PreparationLease(); preparation = lease; prepared = undefined;
  const uid = options.uid ?? 0, trustedAncestorUid = options.trustedAncestorUid ?? 0;
  const inventoryPath = options.inventoryPath ?? LINUX_LOCAL_PROVIDER_INVENTORY;
  const directories = new Map<string, Identity>(), immutableDirectories = new Set<string>();
  const visit = async (path: string, immutable = false) => {
    if (!isAbsolute(path) || normalize(path) !== path) refuse();
    if (directories.has(path)) {if (immutable) immutableDirectories.add(path); return;}
    if (path !== (options.ancestorRoot ?? '/')) {if (path === '/') refuse(); await visit(dirname(path));}
    const info = await bounded(operation, () => lstat(path, {bigint: true}));
    trusted(info, immutable ? uid : trustedAncestorUid, true, immutable ? 0o555 : undefined);
    if (immutable) immutableDirectories.add(path);
    if (directories.size >= MAX_FILES) refuse();
    directories.set(path, identity(path, info));
  };
  try {
    await visit(dirname(inventoryPath));
    const inventoryRead = await readPinned(inventoryPath, undefined, false, operation, lease, uid, options.checkpoint, true);
    if (!inventoryRead.bytes) refuse();
    const inventory = parseLinuxLocalProviderInventory(parseJsonWithoutDuplicateKeys(inventoryRead.bytes.toString('utf8')));
    const closure = join(options.closureRoot ?? CLOSURE_ROOT, inventory.closure.digest);
    const modelsPath = join(options.storeRoot ?? STORE_ROOT, inventory.store.digest, 'models');
    const files = [inventoryRead.file], captured = new Map<string, Buffer>();
    const capturePins = new Set([UPSTREAM_MANIFEST, POLICY_MANIFEST]);
    const tree = async (root: string, pins: readonly (Pin & {executable?: boolean})[]) => {
      const expected = new Map<string, Set<string>>();
      const parent = (path: string) => {if (path === dirname(root)) return; immutableDirectories.add(path); if (!expected.has(path)) {if (expected.size >= MAX_FILES) refuse(); expected.set(path, new Set());} if (path !== root) {parent(dirname(path)); expected.get(dirname(path))!.add(path.slice(dirname(path).length + 1));}};
      parent(root);
      for (const row of pins) {const path = join(root, row.path); parent(dirname(path)); expected.get(dirname(path))!.add(path.slice(dirname(path).length + 1));}
      for (const [path, names] of expected) {
        await visit(path, true);
        const actual = await bounded(operation, () => readdir(path));
        if (actual.length !== names.size || actual.some(name => !names.has(name))) refuse();
      }
      for (const row of pins) {
        const found = await readPinned(join(root, row.path), row, row.executable === true, operation, lease, uid, options.checkpoint,
          root === modelsPath && capturePins.has(row.path));
        files.push(found.file); if (found.bytes) captured.set(row.path, found.bytes);
        if (root === modelsPath && row.path === POLICY_MANIFEST && found.bytes) {
          for (const layer of manifest(found.bytes).layers) if (layer.mediaType === 'application/vnd.ollama.image.params') capturePins.add(`blobs/sha256-${layer.digest.slice(7)}`);
        }
      }
    };
    await tree(closure, inventory.closure.files);
    const cwdPath = join(closure, inventory.closure.providerCwd.path), cwdIdentity = directories.get(cwdPath);
    if (!cwdIdentity || !immutableDirectories.has(cwdPath)) refuse();
    await visit(dirname(modelsPath), true);
    await tree(modelsPath, [inventory.store.upstreamManifest, inventory.store.policyManifest, ...inventory.store.blobs]);
    verifyManifests(inventory, captured);
    const spec: LinuxLocalProviderSpec = deepFreeze({format: 1, kind: 'ollama', version: LINUX_LOCAL_PROVIDER_VERSION,
      executable: join(closure, inventory.closure.executable), closureDigest: inventory.closure.digest, storeDigest: inventory.store.digest, modelsPath,
      providerCwd: {path: cwdPath, contract: inventory.closure.providerCwd.contract, dev: cwdIdentity.dev, ino: cwdIdentity.ino},
      upstreamModel: LINUX_LOCAL_PROVIDER_UPSTREAM, model: LINUX_LOCAL_PROVIDER_MODEL, modelDigest: `sha256:${inventory.store.policyManifest.sha256}`,
      upstreamDigest: `sha256:${inventory.store.upstreamManifest.sha256}`, upstreamManifest: join(modelsPath, UPSTREAM_MANIFEST), policyManifest: join(modelsPath, POLICY_MANIFEST),
      baseURL: LINUX_LOCAL_PROVIDER_URL, capabilities: ['completion', 'tools'], parameters: PARAMETERS, resources: RESOURCES,
      env: {HOME: '/tmp/mdai-provider/home', TMPDIR: '/tmp/mdai-provider/tmp', XDG_CACHE_HOME: '/tmp/mdai-provider/cache', PATH: '/usr/bin:/bin',
        LD_LIBRARY_PATH: join(closure, 'lib/ollama'), OLLAMA_HOST: '127.0.0.1:11434', OLLAMA_MODELS: modelsPath, OLLAMA_NOPRUNE: '1', OLLAMA_NO_CLOUD: '1',
        OLLAMA_NUM_PARALLEL: '1', OLLAMA_MAX_LOADED_MODELS: '1', OLLAMA_MAX_QUEUE: '1', OLLAMA_CONTEXT_LENGTH: '8192', OLLAMA_KEEP_ALIVE: '-1',
        CUDA_VISIBLE_DEVICES: '-1', ROCR_VISIBLE_DEVICES: '-1'}, files, directories: [...directories.values()].map(row => ({...row, immutable: immutableDirectories.has(row.path)}))});
    issued.set(spec, {spec, uid, trustedAncestorUid, immutableDirectories});
    if (options.checkpoint) await bounded(operation, async () => options.checkpoint!('prepared', inventoryPath));
    await revalidateLinuxLocalProvider(spec, operation); live(operation); prepared = spec; return spec;
  } catch (error) {
    prepared = undefined;
    if (error instanceof HelperError) throw error;
    refuse();
  } finally {lease.finish();}
}
/** Rechecks the streamed immutable inodes; it does not spend signed start time rehashing large weights. */
export async function revalidateLinuxLocalProvider(spec: LinuxLocalProviderSpec, operation: Operation = {}): Promise<void> {
  assertLinuxLocalProviderSpec(spec); live(operation);
  const receipt = issued.get(spec)!;
  for (const row of spec.directories) {
    const info = await bounded(operation, () => lstat(row.path, {bigint: true}));
    const immutable = receipt.immutableDirectories.has(row.path);
    trusted(info, immutable ? receipt.uid : receipt.trustedAncestorUid, true, immutable ? 0o555 : undefined);
    if (row.dev !== String(info.dev) || row.ino !== String(info.ino) || immutable && !same(row, info)) refuse();
  }
  for (const row of spec.files) {
    const info = await bounded(operation, () => lstat(row.path, {bigint: true}));
    trusted(info, receipt.uid, false, row.executable ? 0o555 : 0o444);
    if (!same(row, info) || info.size !== BigInt(row.size)) refuse();
  }
  const cwd = spec.providerCwd, directory = spec.directories.find(row => row.path === cwd.path);
  if (!directory?.immutable || cwd.path !== join(dirname(dirname(spec.executable)), 'lib/ollama') ||
      cwd.contract !== 'ollama-inherited-cwd-v1' || directory.dev !== cwd.dev || directory.ino !== cwd.ino ||
      await bounded(operation, () => realpath(cwd.path)) !== cwd.path) refuse();
  const expected = new Set([...spec.files, ...spec.directories].filter(row => dirname(row.path) === cwd.path).map(row => row.path.slice(cwd.path.length + 1)));
  const actual = await bounded(operation, () => readdir(cwd.path));
  if (actual.length !== expected.size || actual.some(name => !expected.has(name))) refuse();
  live(operation);
}
