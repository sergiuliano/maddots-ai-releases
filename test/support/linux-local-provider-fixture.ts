import {createHash} from 'node:crypto';
import {chmod, mkdir, mkdtemp, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import type {TestContext} from 'node:test';
import {LINUX_LOCAL_PROVIDER_MODEL, prepareLinuxLocalProvider, type LinuxLocalProviderPreparationOptions} from '../../src/runner/linux-local-provider.js';

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => JSON.stringify(value);
/** Small immutable data files only, with no executable provider or host changes. */
export async function localProviderFixture(t: TestContext, policy: {parameters?: Record<string, number>; weightBytes?: number} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mdai-local-provider-'));
  const writable = async (path: string): Promise<void> => {
    await chmod(path, 0o700);
    for (const row of await readdir(path, {withFileTypes: true})) if (row.isDirectory()) await writable(join(path, row.name));
  };
  t.after(async () => {await writable(root); await rm(root, {recursive: true, force: true});});
  const upstreamPath = 'manifests/registry.ollama.ai/library/qwen3-coder/30b-a3b-q4_K_M';
  const policyPath = 'manifests/registry.ollama.ai/library/mdai-qwen3-coder/30b-a3b-q4_K_M-ctx8192-cpu16';
  const contents = new Map<string, Buffer>();
  const blob = (text: string | Buffer, mediaType: string) => {
    const bytes = Buffer.from(text), digest = sha(bytes);
    contents.set(`blobs/sha256-${digest}`, bytes);
    return {mediaType, digest: `sha256:${digest}`, size: bytes.length};
  };
  const config = blob(json({model_format: 'gguf', model_family: 'qwen3moe'}), 'application/vnd.docker.container.image.v1+json');
  const weight = blob(policy.weightBytes ? Buffer.alloc(policy.weightBytes, 83) : 'synthetic-model-weight-data', 'application/vnd.ollama.image.model');
  const upstreamParameters = blob(json({num_ctx: 65536}), 'application/vnd.ollama.image.params');
  const parameters = blob(json(policy.parameters ?? {num_thread: 16, num_ctx: 8192, num_gpu: 0}), 'application/vnd.ollama.image.params');
  const upstreamBytes = Buffer.from(json({schemaVersion: 2, mediaType: 'application/vnd.docker.distribution.manifest.v2+json', config, layers: [weight, upstreamParameters]}));
  const policyBytes = Buffer.from(json({schemaVersion: 2, mediaType: 'application/vnd.docker.distribution.manifest.v2+json', config, layers: [weight, parameters]}));
  const pin = (path: string, bytes: Buffer) => ({path, sha256: sha(bytes), size: bytes.length});
  const store = {upstreamManifest: pin(upstreamPath, upstreamBytes), policyManifest: pin(policyPath, policyBytes),
    blobs: [...contents].map(([path, bytes]) => pin(path, bytes)).sort((a, b) => a.path < b.path ? -1 : 1)};
  const binaries = new Map([['bin/ollama', Buffer.from('synthetic-nonexecutable-provider-image')], ['lib/ollama/libfixture.so', Buffer.from('synthetic-library')]]);
  const closure = {executable: 'bin/ollama' as const, files: [...binaries].map(([path, bytes]) => ({...pin(path, bytes), executable: path === 'bin/ollama'}))};
  const inventory = {format: 1 as const, kind: 'ollama' as const, version: '0.40.14' as const,
    closure: {digest: sha(json(closure)), ...closure}, store: {digest: sha(json(store)), ...store}};
  const closureRoot = join(root, 'closures'), storeRoot = join(root, 'stores');
  const closurePath = join(closureRoot, inventory.closure.digest), modelsPath = join(storeRoot, inventory.store.digest, 'models');
  contents.set(upstreamPath, upstreamBytes); contents.set(policyPath, policyBytes);
  const write = async (path: string, bytes: Buffer | string, mode: number) => {await mkdir(dirname(path), {recursive: true, mode: 0o700}); await writeFile(path, bytes, {mode});};
  for (const [path, bytes] of binaries) await write(join(closurePath, path), bytes, path === 'bin/ollama' ? 0o555 : 0o444);
  for (const [path, bytes] of contents) await write(join(modelsPath, path), bytes, 0o444);
  const inventoryPath = join(root, 'provider.json'); await write(inventoryPath, json(inventory), 0o444);
  const freeze = async (path: string): Promise<void> => {
    for (const row of await readdir(path, {withFileTypes: true})) if (row.isDirectory()) await freeze(join(path, row.name));
    await chmod(path, 0o555);
  };
  await freeze(closurePath); await freeze(join(storeRoot, inventory.store.digest));
  const options: LinuxLocalProviderPreparationOptions = {inventoryPath, closureRoot, storeRoot, ancestorRoot: root,
    uid: process.getuid!(), trustedAncestorUid: process.getuid!()};
  const input = {tool: 'opencode', provider: 'ollama', model: LINUX_LOCAL_PROVIDER_MODEL};
  return {root, inventory, inventoryPath, closurePath, modelsPath, options, input,
    weightPath: join(modelsPath, `blobs/sha256-${weight.digest.slice(7)}`), parametersPath: join(modelsPath, `blobs/sha256-${parameters.digest.slice(7)}`),
    prepare: (operation: {signal?: AbortSignal; deadline?: number} = {}, overrides: Partial<LinuxLocalProviderPreparationOptions> = {}) =>
      prepareLinuxLocalProvider({...input, ...operation}, {...options, ...overrides})};
}
