// The bootstrap must not import package code before this builtin-only check.
import { createHash } from 'node:crypto';
import { constants, lstatSync, realpathSync } from 'node:fs';
import { lstat, open, readdir, readlink, realpath } from 'node:fs/promises';
import { Module as NodeModule, isBuiltin, registerHooks } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface SystemRuntimePolicy {
  root: string; data: string; home: string; config: string; state: string; runtime: string;
  uid: number; username: string; ownerUid: number;
}
// An argument-only fixture seam. No environment, manifest, pointer or metadata
// can change the production installation, account or storage contract.
export const systemPolicy: Readonly<SystemRuntimePolicy> = Object.freeze({
  root: '/usr/local/libexec/mdai/helper', data: '/var/lib/mdai/data', home: '/var/lib/mdai/home',
  config: '/var/lib/mdai/config/maddots-ai', state: '/var/lib/mdai/state/maddots-ai', runtime: '/run/mdai-helper/mdai',
  uid: 999, username: 'mdai', ownerUid: 0,
});
export class SystemRuntimeError extends Error {
  readonly code = 'SYSTEM_RUNTIME_FIXED';
}
const failure = (reason: string) => new SystemRuntimeError(
  `The fixed Linux system helper ${reason}. Automatic repair, cached runtimes, update and rollback are disabled; only the founder's root install may change executable code. Retained S5-10 recovery obligations must be resolved before enrollment.`);
// Node retains the invocation in argv[1] even when it canonicalizes import.meta.
// Capture it before loading application code, and never infer it from realpath.
const lexicalInvocation = process.argv[1];
const moduleRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const claimsSystemInvocation = (invocation: string | undefined, policy: Readonly<SystemRuntimePolicy>) =>
  invocation !== undefined && resolve(invocation) === join(policy.root, 'dist/cli.js');
export function systemRuntimeMode(root: string, policy: Readonly<SystemRuntimePolicy> = systemPolicy): boolean {
  // An absent or relative caller root is never evidence of a fixed install.
  // In particular, resolve('') would incorrectly promote the working directory.
  return process.platform === 'linux' && (Boolean(root) && isAbsolute(root) && resolve(root) === policy.root ||
    moduleRoot === policy.root || claimsSystemInvocation(lexicalInvocation, policy));
}

function assertSystemStartupInputs(): void {
  for (const name of ['NODE_OPTIONS', 'NODE_PATH']) {
    if (process.env[name] !== undefined) throw failure(`refuses ${name} in its startup environment`);
  }
  if (process.execArgv.length && (process.execArgv.length !== 1 || process.execArgv[0] !== '--disable-sigusr1')) {
    throw failure('refuses process.execArgv other than exactly --disable-sigusr1');
  }
  if (process.argv[2] === 'service' && process.execArgv[0] !== '--disable-sigusr1') {
    throw failure('requires --disable-sigusr1 for service mode');
  }
  if (process.argv.slice(2).some(argument => /^--(?:import|require|loader|experimental-[^=]*)(?:=|$)/u.test(argument) ||
      /^-r/u.test(argument))) throw failure('refuses Node preload and loader flags in its command arguments');
}

async function assertCanonicalPath(path: string): Promise<void> {
  for (let current = path; ; current = dirname(current)) {
    if ((await lstat(current)).isSymbolicLink()) throw failure('requires its canonical installation and entrypoint paths');
    if (current === dirname(current)) break;
  }
}

/** Validate the original invocation before any ordinary-runtime fallback.
 * Arguments are test-only seams, never populated from environment or metadata. */
export async function assertSystemInvocation(invocation: string | undefined = lexicalInvocation,
  policy: Readonly<SystemRuntimePolicy> = systemPolicy): Promise<void> {
  if (process.platform !== 'linux' || !claimsSystemInvocation(invocation, policy)) return;
  const entrypoint = join(policy.root, 'dist/cli.js');
  await assertCanonicalPath(entrypoint);
  if (await realpath(entrypoint) !== entrypoint) throw failure('requires its canonical system invocation');
}

/** Resolve every raw component, including components canceled by a later '..'.
 * realpath alone loses external hops that return to an internal final target. */
async function resolveDependencyLink(path: string, policy: Readonly<SystemRuntimePolicy>): Promise<void> {
  const root = policy.root, writable = policy.ownerUid === policy.uid ? 0o222n : 0o022n;
  let current = root, pending = relative(root, path).split('/'), hops = 0, steps = 0;
  while (pending.length) {
    if (++steps > 4096) throw failure('exceeded the bounded dependency link traversal');
    const component = pending.shift()!;
    if (!component || component === '.') continue;
    if (component === '..') {
      if (current === root) throw failure('contains a dependency link outside its installation');
      current = dirname(current);
      continue;
    }
    const next = join(current, component), before = await lstat(next, {bigint: true});
    if (before.uid !== BigInt(policy.ownerUid) || !before.isSymbolicLink() && (before.mode & writable)) {
      throw failure('contains a writable or incorrectly owned dependency path');
    }
    if (before.isSymbolicLink()) {
      if (++hops > 40) throw failure('contains a cyclic or excessive dependency link chain');
      const target = await readlink(next);
      const after = await lstat(next, {bigint: true});
      if (before.dev !== after.dev || before.ino !== after.ino || before.uid !== after.uid || before.mode !== after.mode ||
          before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw failure('changed during dependency link inspection');
      if (isAbsolute(target)) {
        if (target !== root && !target.startsWith(root + '/')) throw failure('contains a dependency link outside its installation');
        current = root;
        pending = [...target.slice(root.length).split('/'), ...pending];
      } else pending = [...target.split('/'), ...pending];
    } else {
      if (!before.isDirectory() && (!before.isFile() || pending.length)) throw failure('contains an unsafe dependency path');
      current = next;
    }
  }
  if (current === root || await realpath(path) !== current) throw failure('contains an unsafe dependency link target');
}

type PackageManifest = Record<string, unknown>;
const packageName = /^(?:@[a-zA-Z0-9_-][a-zA-Z0-9._-]*\/)?[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/u;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Resolve package directories without acquiring a module loader or executing
 * package code. Every lookup stops at the inventoried installation boundary.
 * Optional dependencies (including optional peers) must also be installed:
 * absence today cannot exclude a later mutable ancestor or global fallback.
 * Development dependencies are not part of the installed runtime contract. */
async function inspectDependencyClosure(root: string, manifests: Map<string, Buffer>, graph: Record<string, string>, moduleDirectories: string[], links: string[]): Promise<PackageManifest> {
  const visited = new Set<string>(), pending = [root];
  const inside = (base: string, path: string) => path === base || path.startsWith(base + '/');
  const manifestAt = (path: string): PackageManifest => {
    const bytes = manifests.get(join(path, 'package.json'));
    if (!bytes) throw failure('is missing an inventoried dependency manifest');
    let value: unknown;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { throw failure('contains an invalid dependency manifest'); }
    if (!object(value)) throw failure('contains an invalid dependency manifest');
    return value;
  };
  const present = async (path: string): Promise<boolean> => {
    try { await lstat(path); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  };
  const file = async (path: string): Promise<boolean> => {
    if (!await present(path)) return false;
    const canonical = await realpath(path);
    return inside(root, canonical) && Object.hasOwn(graph, relative(root, canonical)) && (await lstat(canonical)).isFile();
  };
  const loadFile = async (path: string): Promise<boolean> => {
    for (const extension of ['', '.js', '.json', '.node']) if (await file(path + extension)) return true;
    return false;
  };
  const loadIndex = async (path: string): Promise<boolean> => {
    for (const extension of ['.js', '.json', '.node']) if (await file(join(path, 'index' + extension))) return true;
    return false;
  };
  const dependencyAt = async (from: string, name: string, kind: string): Promise<string> => {
    for (let current = from; inside(root, current); current = dirname(current)) {
      if (basename(current) === 'node_modules') continue;
      const candidate = join(current, 'node_modules', name);
      // CommonJS can prefer these files to the directory package. Refuse this
      // unsupported layout instead of validating a different resolution.
      for (const extension of ['.js', '.json', '.node']) {
        if (await present(candidate + extension)) throw failure('contains a dependency file shadow');
      }
      if (!await present(candidate)) continue;
      const canonical = await realpath(candidate);
      if (!inside(root, canonical) || !(await lstat(canonical)).isDirectory() || !manifests.has(join(canonical, 'package.json'))) {
        throw failure('contains a dependency outside the inventoried package graph');
      }
      return canonical;
    }
    throw failure(`is missing an internal ${kind} dependency (${name}); ancestor and global fallback are refused`);
  };
  const rootManifest = manifestAt(root);
  while (pending.length) {
    const directory = pending.pop()!;
    if (visited.has(directory)) continue;
    visited.add(directory);
    const manifest = directory === root ? rootManifest : manifestAt(directory), dependencies = new Map<string, string>();
    // Imports issued by lib/ or dist/ must see the same package search chain.
    // Nested packages at package/node_modules are supported; hidden search
    // roots in package content are not part of that resolution contract.
    if (moduleDirectories.some(path => inside(directory, path) && !inside(join(directory, 'node_modules'), path))) {
      throw failure('contains a dependency search directory inside package content');
    }
    // Whole-package node_modules aliases were canonicalized by dependencyAt.
    // Content links could give individual modules a different physical search
    // scope than the manifest whose closure we validate here.
    if (links.some(path => inside(directory, path) && !inside(join(directory, 'node_modules'), path))) {
      throw failure('requires canonical dependency package contents');
    }
    // A nested package.json can change #imports or self-reference resolution
    // for lib/dist code without introducing another node_modules directory.
    // Type-only scopes are common in dual ESM/CJS packages and remain valid.
    for (const path of manifests.keys()) {
      const scope = dirname(path);
      if (scope === directory || !inside(directory, scope) || inside(join(directory, 'node_modules'), scope)) continue;
      const nested = manifestAt(scope);
      if (['dependencies', 'optionalDependencies', 'peerDependencies', 'imports', 'exports', 'main'].some(field => nested[field] !== undefined)) {
        throw failure('contains an unsupported nested dependency scope');
      }
    }
    for (const [field, kind] of [['dependencies', 'required'], ['optionalDependencies', 'optional'], ['peerDependencies', 'peer']] as const) {
      const declared = manifest[field];
      if (declared === undefined) continue;
      if (!object(declared)) throw failure('contains an invalid dependency declaration');
      for (const [name, version] of Object.entries(declared)) {
        if (!packageName.test(name) || typeof version !== 'string' || !version) throw failure('contains an invalid dependency declaration');
        dependencies.set(name, kind);
      }
    }
    if (manifest.peerDependenciesMeta !== undefined) {
      if (!object(manifest.peerDependenciesMeta)) throw failure('contains invalid peer dependency metadata');
      for (const [name, meta] of Object.entries(manifest.peerDependenciesMeta)) {
        if (!packageName.test(name) || !object(meta) || meta.optional !== undefined && typeof meta.optional !== 'boolean') {
          throw failure('contains invalid peer dependency metadata');
        }
        if (meta.optional === true && dependencies.get(name) === 'peer') dependencies.set(name, 'optional peer');
      }
    }
    // Node confines exports targets to their package. Check all conditions,
    // including import/require variants, and close bare package imports aliases.
    const targets = async (value: unknown, imports: boolean): Promise<void> => {
      if (value === null) return;
      if (typeof value === 'string') {
        if (value.startsWith('./') && !value.includes('*') && inside(directory, resolve(directory, value)) && await file(resolve(directory, value))) return;
        if (imports && value.startsWith('node:')) return;
        // Bare aliases support complete package names only. Subpath aliases
        // and patterns need their own resolution proof before admission.
        if (imports && packageName.test(value)) { dependencies.set(value, 'imports'); return; }
        throw failure('contains an unsupported dependency resolution target');
      }
      if (!Array.isArray(value) && !object(value)) throw failure('contains invalid dependency resolution metadata');
      for (const target of Object.values(value)) await targets(target, imports);
    };
    if (manifest.exports !== undefined) await targets(manifest.exports, false);
    if (manifest.imports !== undefined) {
      if (!object(manifest.imports)) throw failure('contains invalid package imports');
      await targets(manifest.imports, true);
    }
    if (manifest.main !== undefined && (typeof manifest.main !== 'string' || !inside(directory, resolve(directory, manifest.main)))) {
      throw failure('contains an unsafe dependency entrypoint');
    }
    if (directory !== root && manifest.exports == null) {
      const main = typeof manifest.main === 'string' && manifest.main ? resolve(directory, manifest.main) : undefined;
      // An existing directory with no loadable main/index does not stop CJS
      // from falling through to an ancestor package with the same name.
      if (!(main && (await loadFile(main) || await loadIndex(main))) && !await loadIndex(directory)) {
        throw failure('contains a dependency without an inventoried entrypoint');
      }
    }
    for (const [name, kind] of dependencies) {
      if (name === manifest.name && manifest.exports != null) continue; // Node package self-reference.
      pending.push(await dependencyAt(directory, name, kind));
    }
  }
  return rootManifest;
}

export async function inspectSystemInstallation(root: string, policy: Readonly<SystemRuntimePolicy> = systemPolicy): Promise<{
  installation: {root: string; dev: string; ino: string}; graph: Record<string, string>;
}> {
  if (root !== policy.root) throw failure('has an unreviewed installation path');
  await assertCanonicalPath(root);
  if (await realpath(root) !== root) throw failure('requires its canonical installation path');
  const writable = policy.ownerUid === policy.uid ? 0o222 : 0o022;
  for (let ancestor = root; ; ancestor = dirname(ancestor)) {
    const info = await lstat(ancestor);
    // Fixtures may live under the system temporary directory; only production
    // ancestors must be root-owned. Fixture package bytes still must be read-only.
    if (!info.isDirectory() || (ancestor === root || policy.ownerUid === 0) &&
        (info.uid !== policy.ownerUid || (info.mode & writable))) throw failure('has a writable installation ancestor');
    if (ancestor === dirname(ancestor)) break;
  }
  const installation = await lstat(root, {bigint: true}), graph: Record<string, string> = {}, manifests = new Map<string, Buffer>();
  const moduleDirectories: string[] = [], links: string[] = [];
  let entries = 0, bytes = 0;
  const walk = async (path: string, depth: number): Promise<void> => {
    if (depth > 32 || ++entries > 65536) throw failure('exceeded the bounded package inventory');
    const name = relative(root, path), before = await lstat(path, {bigint: true});
    if (before.uid !== BigInt(policy.ownerUid) || (before.mode & BigInt(writable)) && !before.isSymbolicLink()) {
      throw failure('contains writable or incorrectly owned package bytes');
    }
    if (name.split('/').some(part => part === '.write-lock-upgrade' || part === '.write-lock-upgrade.json' ||
        part.endsWith('.tmp') || part.startsWith('.refused-cli-'))) throw failure('contains retained package repair state');
    if (before.isSymbolicLink()) {
      if (!name.startsWith('node_modules/')) throw failure('requires a canonical emitted entrypoint graph');
      await resolveDependencyLink(path, policy);
      links.push(path);
      if (basename(path) === 'node_modules') moduleDirectories.push(path);
      graph[name] = createHash('sha256').update('symlink:' + await readlink(path)).digest('hex');
    } else if (before.isDirectory()) {
      if (basename(path) === 'node_modules') moduleDirectories.push(path);
      for (const child of (await readdir(path)).sort()) await walk(join(path, child), depth + 1);
    } else {
      if (!before.isFile() || before.nlink !== 1n || before.size > 128n * 1024n * 1024n) throw failure('contains an unsafe package artifact');
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = await file.stat({bigint: true});
        if (opened.dev !== before.dev || opened.ino !== before.ino) throw failure('changed during package inspection');
        const value = await file.readFile();
        bytes += value.length;
        if (bytes > 512 * 1024 * 1024 || BigInt(value.length) !== before.size) throw failure('exceeded the bounded package inventory');
        graph[name] = createHash('sha256').update(value).digest('hex');
        if (basename(path) === 'package.json') manifests.set(path, value);
      } finally { await file.close(); }
    }
    const after = await lstat(path, {bigint: true});
    if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode || before.uid !== after.uid ||
        before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw failure('changed during package inspection');
  };
  await walk(root, 0);
  // Resolve the complete declared runtime closure from the bytes just hashed.
  const manifest = await inspectDependencyClosure(root, manifests, graph, moduleDirectories, links);
  // Manifest and the complete emitted runtime are hashed before enrollment.
  // The entrypoint is fixed here, never taken from the coordinator record.
  if (manifest.name !== 'maddots-ai' || !object(manifest.bin) || manifest.bin['maddots-ai'] !== 'dist/cli.js' ||
      !['cli', 'cli-main', 'cli-validation', 'runtime', 'system-runtime', 'system-runtime-operation', 'system-runtime-preflight', 'paths', 'write-lock', 'write-lock-upgrade', 'write-lock-retirement', 'write-lock-recovery']
        .every(name => graph[`dist/${name}.js`])) throw failure('has an incomplete fixed entrypoint graph');
  return {installation: {root, dev: String(installation.dev), ino: String(installation.ino)}, graph};
}

type CommonJsResolver = {
  _resolveLookupPaths(request: string, parent: unknown): string[] | null;
  _resolveFilename(request: string, parent: unknown, isMain?: boolean, options?: unknown): string;
};
let resolutionGuardGraph: string | undefined;

/** Node resolves the request; this guard admits only its inventoried result.
 * Keep this capability private to the builtin-only bootstrap. The hooks have
 * process lifetime: their deregistration handle is deliberately never exposed.
 * registerHooks was added in 22.15 / 23.5. The two CJS wrappers are necessary
 * on private Node 22.23: require.resolve bypasses hooks, and globalPaths is only
 * a copy of the search list, not a switch disabling global directory lookups. */
function installSystemResolutionGuard(graph: Record<string, string>): void {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (!(major === 22 && minor >= 15 || major === 23 && minor >= 5 || major >= 24) || typeof registerHooks !== 'function') {
    throw failure('requires Node with synchronous module.registerHooks support');
  }
  const signature = createHash('sha256').update(JSON.stringify(Object.keys(graph).sort().map(name => [name, graph[name]]))).digest('hex');
  if (resolutionGuardGraph !== undefined) {
    if (resolutionGuardGraph !== signature) throw failure('changed its guarded installation; restart with the reviewed package');
    return;
  }
  const nodeResolver = NodeModule as unknown as CommonJsResolver;
  if (typeof nodeResolver._resolveLookupPaths !== 'function' || typeof nodeResolver._resolveFilename !== 'function') {
    throw failure('cannot guard the private Node CommonJS resolver');
  }
  const root = systemPolicy.root, writable = systemPolicy.ownerUid === systemPolicy.uid ? 0o222 : 0o022;
  const files = new Set<string>(), directories = new Set<string>([root]);
  const inside = (path: string) => path === root || path.startsWith(root + '/');
  for (const name of Object.keys(graph)) {
    const path = join(root, name);
    // Graph symlink entries are proof of links, never executable file grants.
    if (lstatSync(path).isFile()) files.add(path);
    for (let parent = dirname(path); inside(parent); parent = dirname(parent)) directories.add(parent);
  }
  const missing = (name: string, code: string) => Object.assign(new Error(`Cannot find module '${name}' in the fixed installation`), {code});
  const canonicalFile = (path: string, code: string): string => {
    try {
      if (!isAbsolute(path) || !inside(path) || !inside(resolve(path))) throw missing(path, code);
      const canonical = realpathSync(path);
      if (!files.has(canonical)) throw missing(path, code);
      for (let current = canonical; inside(current); current = dirname(current)) {
        const info = lstatSync(current);
        if (info.uid !== systemPolicy.ownerUid || info.mode & writable ||
            (current === canonical ? !info.isFile() || info.nlink !== 1 : !info.isDirectory())) throw missing(path, code);
      }
      return canonical;
    } catch { throw missing(path, code); }
  };
  const canonicalUrl = (url: string, code: string): string => {
    if (url.startsWith('node:') && isBuiltin(url)) return url;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'file:') throw missing(url, code);
      const canonical = pathToFileURL(canonicalFile(fileURLToPath(parsed), code));
      canonical.search = parsed.search; canonical.hash = parsed.hash;
      return canonical.href;
    } catch { throw missing(url, code); }
  };
  const lookupPaths = nodeResolver._resolveLookupPaths, resolveFilename = nodeResolver._resolveFilename;
  delete process.env.NODE_PATH;
  // Filter before Node probes paths. In particular, never even stat a global
  // folder. Reinitializing Node's global list later cannot undo this filter.
  Object.defineProperty(nodeResolver, '_resolveLookupPaths', {configurable: false, writable: false,
    value(request: string, parent: unknown): string[] | null {
      const paths = lookupPaths(request, parent);
      return paths?.filter(path => {
        if (!inside(path) || !inside(resolve(path))) return false;
        try { return directories.has(realpathSync(path)); } catch { return false; }
      }) ?? null;
    },
  });
  Object.defineProperty(nodeResolver, '_resolveFilename', {configurable: false, writable: false,
    value(request: string, parent: unknown, isMain?: boolean, options?: unknown): string {
      const filename = resolveFilename(request, parent, isMain, options);
      return isBuiltin(filename) ? filename : canonicalFile(filename, 'MODULE_NOT_FOUND');
    },
  });
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      return {...result, url: canonicalUrl(result.url, context.conditions.includes('require') ? 'MODULE_NOT_FOUND' : 'ERR_MODULE_NOT_FOUND')};
    },
    load(url, context, nextLoad) {
      // Recheck at load as well as resolution, including deferred ESM loads.
      return nextLoad(canonicalUrl(url, 'ERR_MODULE_NOT_FOUND'), context);
    },
  });
  resolutionGuardGraph = signature;
}

/** No configuration, lock, updater or third-party import may precede this call.
 * The full storage/coordinator check follows after the immutable graph passes. */
export async function preflightSystemRuntime(): Promise<void> {
  const fixed = systemRuntimeMode(moduleRoot);
  // The unit strips its environment before Node starts. A direct CLI launch
  // may already have run a preload; this refusal is hygiene, not a boundary
  // against code deliberately executed by the invoking account.
  if (fixed) assertSystemStartupInputs();
  await assertSystemInvocation();
  if (fixed) {
    const {graph} = await inspectSystemInstallation(systemPolicy.root);
    installSystemResolutionGuard(graph);
  }
}
