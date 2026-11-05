// The lock protocol is infrastructure: rolling application code back must not
// restore the stale-unlink implementation from a retained bootstrap.
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, opendir, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HelperError, clock, type Timing } from './config.js';
import { assertNoSymlinks, atomicWrite, ensurePrivateDirectory, inside, readPrivateFile, type HelperPaths } from './paths.js';
import { acquireWriteGuard, type WriteGuardRelease } from './write-lock.js';
import { RELEASE_IDENTITY } from './release-identity.js';
import { assertSystemRuntime, assertSystemRuntimeOperation, assertSystemRuntimeReady, prepareSystemRuntime, systemRuntimeMode } from './system-runtime.js';
import { captureRetirement, pendingRetirement, restartLegacyService, formatRetirementMessage, type Retirement } from './write-lock-retirement.js';
import { linuxLockRetirementUnverified, verifyLinuxRecoveryEntrypoints } from './write-lock-retirement.js';
import { assertLinuxUnitPublicationsSettled, beginLinuxLockRecovery, inventoryLinuxRecovery, recoveryBoot, reconcileLinuxRecovery, sealLinuxLockRecovery,
  validateLinuxLockRecovery, verifyLinuxLockRecovery, type LinuxLockRecovery } from './write-lock-recovery.js';

const protocol = '// maddots-write-lock-protocol: 3';
// A protocol can retain its on-disk lock ABI while its coordinator needs a
// repair. Adopt this infrastructure revision once, including from pre-fix
// protocol-3 records, and never downgrade a newer retained implementation.
// Linux revision 3 retains a durable pre-repair baseline and explicit recovery
// seal. Keep macOS on its existing coordinator revision in this slice.
const revision = process.platform === 'linux' ? 3 : 1;
// Only records created under the released-source policy carry this provenance.
// Older internal Linux records must not acquire it by registering today's paths.
const linuxSourcePolicy = 'released-only-v1';
const sourceUnverified = () => new HelperError('LINUX_LOCK_RETIREMENT_UNVERIFIED',
  'Linux retained state cannot be attributed to a supported released helper or this revision\'s coordinator. Retained state is preserved. The installation owner must follow the internal pre-release clean-reinstall procedure in docs/design/linux-write-lock-recovery.md.');
const sidecar = '.write-lock-upgrade.json';
// Keep every dependency importable throughout an interrupted protocol-2
// upgrade. write-lock.js publishes the protocol marker only after its entire
// migration dependency graph is installed. paths.js is retrofitted last.
const modules = ['linux-proc.js', 'process-image.js', 'write-lock-retirement.js', 'write-lock-recovery.js', 'write-lock-upgrade.js', 'write-lock.js'] as const;
// These application-owned ABIs keep the retained runtime's resolver and release
// identity. Their actual installed import graph is checked before publication.
const runtimeModules = new Set(['config.js', 'paths.js', 'release-identity.js']);
const sourceName = (name: string) => name.replaceAll('/', '%2F');
const validModuleName = (name: string) => /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.(?:js|json)$/u.test(name);
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
let coordinator: string | undefined;
interface UpgradeState {
  protocol: 2 | 3;
  linuxSourcePolicy?: typeof linuxSourcePolicy;
  revision?: number;
  bootstrap: string;
  data: string[];
  homes?: string[];
  storage?: {data: string; roots: string[]; states: string[]; units?: string[]}[];
  patching?: boolean;
  retirement?: Retirement;
  recovery?: LinuxLockRecovery;
  sources: Record<string, string>;
}
interface Runtime { bundledRoot: string; runningRoot: string }

const graphFailed = () => new HelperError('CANDIDATE_FAILED', 'The helper lock migration has an incomplete or unsupported module graph.');

/** Read emitted ESM imports without evaluating code or following loader hooks.
 * Comments, strings, regexps and template text cannot invent dependencies.
 * Template expressions are scanned too; computed dynamic imports fail closed. */
function moduleImports(text: string): string[] {
  const tokens: {value: string; literal?: boolean}[] = [];
  let index = 0;
  const scan = (expression = false): void => {
    let braces = 0, closedControl = false;
    const controls: boolean[] = [];
    while (index < text.length) {
      const char = text[index], next = text[index + 1];
      if (/\s/u.test(char)) {index++; continue;}
      if (char === '/' && next === '/') {while (index < text.length && text[index] !== '\n') index++; continue;}
      if (char === '/' && next === '*') {
        const end = text.indexOf('*/', index + 2); if (end < 0) throw graphFailed(); index = end + 2; continue;
      }
      if (char === '"' || char === "'") {
        const start = ++index; let escaped = false;
        while (index < text.length && text[index] !== char) {
          if (text[index] === '\\') {escaped = true; index++;} index++;
        }
        if (index === text.length) throw graphFailed();
        tokens.push({value: text.slice(start, index++), literal: !escaped}); continue;
      }
      if (char === '`') {
        tokens.push({value: '`'}); index++;
        while (index < text.length && text[index] !== '`') {
          if (text[index] === '\\') index += 2;
          else if (text[index] === '$' && text[index + 1] === '{') {index += 2; scan(true);}
          else index++;
        }
        if (index === text.length) throw graphFailed(); index++; continue;
      }
      // A regexp can start only where an expression is expected. Division
      // follows a value; its slash is an ordinary punctuation token below.
      const previous = tokens.at(-1)?.value;
      if (char === '/' && (closedControl || previous === undefined || ['=', '(', '[', '{', ',', ':', ';', '!', '?', 'return', '=>', '&&', '||'].includes(previous))) {
        index++; let bracket = false;
        while (index < text.length) {
          const current = text[index++];
          if (current === '\\') index++;
          else if (current === '[') bracket = true;
          else if (current === ']') bracket = false;
          else if (current === '/' && !bracket) break;
        }
        while (/[a-z]/iu.test(text[index] ?? '')) index++;
        tokens.push({value: '/regexp/'}); closedControl = false; continue;
      }
      if (/[A-Za-z_$]/u.test(char)) {
        const start = index++; while (/[A-Za-z0-9_$]/u.test(text[index] ?? '')) index++;
        tokens.push({value: text.slice(start, index)}); continue;
      }
      if (char === '}' && expression && braces === 0) {index++; return;}
      if (char === '{') braces++; else if (char === '}') braces--;
      if (char === '(') controls.push(['if', 'while', 'switch', 'for', 'with', 'catch'].includes(previous ?? ''));
      closedControl = char === ')' && controls.pop() === true;
      const pair = text.slice(index, index + 2);
      if (['=>', '&&', '||', '?.'].includes(pair)) {tokens.push({value: pair}); index += 2;}
      else {tokens.push({value: char}); index++;}
    }
    if (expression) throw graphFailed();
  };
  scan();
  const imports: string[] = [];
  for (let offset = 0; offset < tokens.length; offset++) {
    const token = tokens[offset];
    if (token.literal !== undefined || !['import', 'export'].includes(token.value) || ['.', '?.'].includes(tokens[offset - 1]?.value)) continue;
    let end = offset + 1;
    if (token.value === 'import' && tokens[end]?.value === '.') continue; // import.meta
    const dynamic = token.value === 'import' && tokens[end]?.value === '(';
    if (dynamic) end++;
    else if (token.value === 'export' && !['{', '*'].includes(tokens[end]?.value)) continue;
    else if (!tokens[end]?.literal) {
      while (end < tokens.length && !['from', ';'].includes(tokens[end].value)) end++;
      if (tokens[end]?.value !== 'from') {
        if (token.value === 'export') continue;
        throw graphFailed();
      }
      end++;
    }
    if (!tokens[end]?.literal) throw graphFailed();
    if (dynamic && tokens[end + 1]?.value !== ')') throw graphFailed();
    imports.push(tokens[end].value);
  }
  return imports;
}

function localModule(root: string, importer: string, specifier: string): string | undefined {
  if (specifier.startsWith('node:')) return;
  // Retrofitted callers keep their existing packaged third-party imports.
  // Infrastructure itself is restricted to builtins and retained local files.
  if (/^(?:@[A-Za-z0-9_-]+\/)?[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(specifier)) return;
  if (!/^\.{1,2}\//u.test(specifier) || !/\.(?:js|json)$/u.test(specifier) || /[^A-Za-z0-9_./-]/u.test(specifier)) throw graphFailed();
  const path = resolve(dirname(importer), specifier);
  if (!inside(root, path)) throw graphFailed();
  return path;
}

/** Complete the retained infrastructure graph, stopping only at target ABIs. */
async function infrastructureSources(read: (name: string) => Promise<string>, seeds: readonly string[] = modules): Promise<Map<string, string>> {
  const sources = new Map<string, string>(), seen = new Set<string>(), root = dirname(fileURLToPath(import.meta.url));
  const visit = async (name: string): Promise<void> => {
    if (runtimeModules.has(name) || seen.has(name)) return;
    if (!validModuleName(name) || seen.size >= 256) throw graphFailed(); seen.add(name);
    const text = await read(name);
    if (name.endsWith('.json')) {JSON.parse(text); sources.set(name, text); return;}
    for (const specifier of moduleImports(text)) {
      if (!specifier.startsWith('node:') && !specifier.startsWith('.')) throw graphFailed();
      const path = localModule(root, join(root, name), specifier);
      if (path) await visit(relative(root, path));
    }
    sources.set(name, text);
  };
  for (const name of seeds) await visit(name);
  return sources;
}

async function verifyRuntimeGraph(root: string, sources: Map<string, string>, overlay = new Map<string, string>(), entrypoints: Iterable<string> = []): Promise<void> {
  const seen = new Set<string>(), dist = join(root, 'dist');
  const visit = async (path: string): Promise<void> => {
    if (seen.has(path)) return;
    if (seen.size >= 2048) throw graphFailed(); seen.add(path);
    const text = overlay.get(path) ?? await moduleText(path);
    if (path.endsWith('.json')) {JSON.parse(text); return;}
    for (const specifier of moduleImports(text)) {
      const dependency = localModule(root, path, specifier);
      if (dependency) await visit(dependency);
    }
  };
  try {
    for (const name of sources.keys()) await visit(join(dist, name));
    for (const path of overlay.keys()) await visit(path);
    for (const path of entrypoints) await visit(path);
  }
  catch {throw graphFailed();}
}

async function moduleText(path: string): Promise<string> {
  await assertNoSymlinks(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o022) || info.size > 4 * 1024 * 1024) {
      throw new HelperError('FILE_UNSAFE', 'The installed helper module must be an owned, regular file that other users cannot write.');
    }
    return await file.readFile('utf8');
  } finally { await file.close(); }
}

async function replaceModule(path: string, text: string): Promise<void> {
  await assertNoSymlinks(path);
  const folder = await lstat(dirname(path));
  if (!folder.isDirectory() || folder.uid !== process.getuid?.() || (folder.mode & 0o022)) {
    throw new HelperError('PATH_UNSAFE', 'Reinstall the helper in a user-owned location before upgrading its lock implementation.');
  }
  try { await moduleText(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = join(dirname(path), '.' + randomUUID() + '.tmp');
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(text); await file.sync(); await file.close();
    await assertNoSymlinks(path); await rename(temporary, path);
    const directory = await open(dirname(path), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
    if (digest(await moduleText(path)) !== digest(text)) throw new HelperError('CANDIDATE_FAILED', 'The helper lock migration could not be verified.');
  } finally { await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
}

function retrofit(text: string): string | undefined {
  let next = text;
  // Released sync and CLI callers initialize storage before taking their first
  // write lock. Protect that initialization too, including already-retrofitted
  // paths modules, so a refused new layout remains empty and registerable.
  const initialization = 'export async function ensurePaths(paths) {';
  if (process.platform === 'linux' && !text.includes(initialization + '\n    await assertLockUpgradeReady(paths);')) {
    if (text.split(initialization).length !== 2) throw new HelperError('CANDIDATE_FAILED', 'This bootstrap has an unsupported storage initializer.');
    next = next.replace(initialization, initialization + '\n    await assertLockUpgradeReady(paths);');
    if (!next.includes("import { assertLockUpgradeReady } from './write-lock-upgrade.js';")) {
      next = "import { assertLockUpgradeReady } from './write-lock-upgrade.js';\n" + next;
    }
  }
  if (text.includes("export { withWriteLock } from './write-lock.js';")) return next === text ? undefined : next;
  // Only the known bootstrap ABI is retrofitted. Preserve all path helpers and
  // the original application version. The old function becomes unreachable
  // through module exports; all existing importers receive the guarded one.
  const declaration = /export async function withWriteLock\(paths, action, timing = clock, alive = processAlive(?:, deadline = timing\.now\(\) \+ 10_000)?\) \{/g;
  if ([...text.matchAll(declaration)].length !== 1 || text.includes('legacyWithWriteLock')) {
    throw new HelperError('CANDIDATE_FAILED', 'This bootstrap has an unsupported write-lock implementation.');
  }
  return next.replace(declaration, match => match.replace('export async function withWriteLock', 'async function legacyWithWriteLock')) +
    "\nexport { withWriteLock } from './write-lock.js';\n";
}

/** Released updaters also write before and after their guarded lock calls. */
function retrofitUpdater(text: string): string | undefined {
  if (process.platform !== 'linux') return;
  let next = text;
  const replace = (before: string, after: string) => {
    if (next.split(before).length !== 2) throw new HelperError('CANDIDATE_FAILED', 'This bootstrap has an unsupported updater implementation.');
    next = next.replace(before, after);
  };
  if (!next.includes('await assertLockUpgradeReady(options.paths, timing(options));')) {
    replace('const source = identity(fixture?.identity), directory = await validateLocation(options, true);',
      'const source = identity(fixture?.identity);\n        await assertLockUpgradeReady(options.paths, timing(options));\n' +
      '        const directory = await validateLocation(options, true);');
    next = "import { assertLockUpgradeReady } from './write-lock-upgrade.js';\n" + next;
  }
  if (!next.includes('retirementRefused')) {
    // These are the identical catch/finally ABIs in published 0.1.5 and main.
    // A Linux refusal excludes failure-status publication and stage relocation,
    // as well as pointer activation inside the action which did not enter.
    replace("let phase = 'CACHE_UNAVAILABLE', stage, checkedAt;", "let phase = 'CACHE_UNAVAILABLE', stage, checkedAt, retirementRefused = false;");
    replace("if (error instanceof HelperError && error.code === 'HELPER_BUSY')",
      "retirementRefused = error instanceof HelperError && error.code === 'LINUX_LOCK_RETIREMENT_UNVERIFIED';\n" +
      "        if (error instanceof HelperError && ['HELPER_BUSY', 'LINUX_LOCK_RETIREMENT_UNVERIFIED'].includes(error.code))");
    replace('if (stage)\n            await preserveStage(options, stage)', 'if (stage && !retirementRefused)\n            await preserveStage(options, stage)');
    replace("status: error instanceof HelperError && error.code === 'HELPER_BUSY' ? 'busy' : 'failed'",
      "status: error instanceof HelperError && ['HELPER_BUSY', 'LINUX_LOCK_RETIREMENT_UNVERIFIED'].includes(error.code) ? 'busy' : 'failed'");
  }
  if (!next.includes('admitted = false')) {
    // Upgrade both pristine releases and an interrupted earlier retrofit.
    // Error codes cannot prove whether repair admitted the calling writer.
    replace('retirementRefused = false;', 'retirementRefused = false, admitted = false;');
    replace('await remember(options, { ...result, checkedAt, finishedAt: timing(options).now() });',
      'if (admitted && !retirementRefused) await remember(options, { ...result, checkedAt, finishedAt: timing(options).now() });');
    replace('return await withWriteLock(updatePaths, async () => {',
      'return await withWriteLock(updatePaths, async () => {\n            admitted = true;');
    replace('return withWriteLock(options.paths, async () => {',
      'admitted = false;\n            return withWriteLock(options.paths, async () => {\n                admitted = true;');
    replace('if (stage && !retirementRefused)', 'if (stage && admitted && !retirementRefused)');
  }
  if (!next.includes("'LINUX_LOCK_RETIREMENT_UNVERIFIED'") || !next.includes('if (stage && admitted && !retirementRefused)')) {
    throw new HelperError('CANDIDATE_FAILED', 'This bootstrap has an unsupported updater implementation.');
  }
  return next === text ? undefined : next;
}

async function inventory(state: UpgradeState): Promise<{root: string; unpublished: boolean}[]> {
  const result = [{root: state.bootstrap, unpublished: false}];
  for (const data of state.data) {
    const updates = join(data, 'updates');
    for (const [directory, staged] of [[updates, true], [join(updates, 'releases'), false]] as const) {
      await assertNoSymlinks(directory);
      let entries;
      try { entries = await readdir(directory, {withFileTypes: true}); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      for (const entry of entries) {
        if (!(staged ? /^staging-/.test(entry.name) : /^[a-f0-9]{40}$/.test(entry.name))) continue;
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue; // The release selector rejects these too.
        result.push({root: join(directory, entry.name), unpublished: staged});
      }
    }
  }
  return result;
}

const validStoragePath = (root: unknown): root is string => typeof root === 'string' && root.length > 1 && root.length <= 4096 &&
  root.startsWith('/') && resolve(root) === root && [...root].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);

async function readState(directory: string): Promise<UpgradeState> {
  const text = await readPrivateFile(join(directory, 'state.json'));
  let state: UpgradeState;
  try { state = JSON.parse(text) as UpgradeState; }
  catch { throw new HelperError('FILE_UNSAFE', 'The helper lock migration record is invalid.'); }
  if (process.platform === 'linux' && (!state || state.protocol !== 3 || state.revision !== revision ||
      state.linuxSourcePolicy !== linuxSourcePolicy)) throw sourceUnverified();
  // A data root can coincide with another HOME's marketplace. It proves
  // nothing about that HOME's independent agent folders or launch boundaries.
  if (process.platform === 'linux' && (!Array.isArray(state.homes) || !state.homes.length || state.homes.length > 256 ||
      !state.homes.every(validStoragePath) || new Set(state.homes).size !== state.homes.length)) throw sourceUnverified();
  if (!state || typeof state !== 'object' || ![2, 3].includes(state.protocol) || typeof state.bootstrap !== 'string' || !Array.isArray(state.data) ||
      state.data.some(path => typeof path !== 'string' || resolve(path) !== path) || resolve(state.bootstrap) !== state.bootstrap ||
      (state.storage !== undefined && (!Array.isArray(state.storage) || state.storage.length > 64 ||
        state.storage.some(layout => !layout || typeof layout !== 'object' || typeof layout.data !== 'string' ||
          !state.data.includes(layout.data) || !Array.isArray(layout.roots) || !layout.roots.length || layout.roots.length > 256 ||
          !layout.roots.includes(layout.data) || !layout.roots.every(validStoragePath) ||
          !Array.isArray(layout.states) || !layout.states.length || layout.states.length > 256 || !layout.states.every(validStoragePath) ||
          (layout.units !== undefined && (!Array.isArray(layout.units) || !layout.units.length || layout.units.length > 256 ||
            !layout.units.every(validStoragePath) || layout.units.some(unit => !unit.endsWith('/app.maddots.ai.helper.service') &&
              !unit.endsWith('/app.maddots.ai.helper.plist')) || new Set(layout.units).size !== layout.units.length)) ||
          layout.states.some(file => !file.endsWith('/state.json') || !layout.roots.includes(dirname(file))) || new Set(layout.states).size !== layout.states.length ||
          new Set(layout.roots).size !== layout.roots.length) || new Set(state.storage.map(layout => layout.data)).size !== state.storage.length ||
        new Set(state.storage.flatMap(layout => layout.roots)).size > 256 || new Set(state.storage.flatMap(layout => layout.states)).size > 256)) ||
      (state.revision !== undefined && (!Number.isSafeInteger(state.revision) || state.revision < 1)) ||
      (state.patching !== undefined && state.patching !== true) ||
      (state.retirement !== undefined && (!state.retirement || typeof state.retirement !== 'object' || !/^[0-9a-f-]{36}$/.test(state.retirement.boot) || !Array.isArray(state.retirement.processes) ||
        state.retirement.processes.some(p => !p || !Number.isSafeInteger(p.pid) || p.pid <= 0 || typeof p.started !== 'string' || !p.started ||
          typeof p.executable !== 'string' || !p.executable))) ||
      !state.sources || typeof state.sources !== 'object' || Array.isArray(state.sources) || Object.keys(state.sources).length > 256 ||
      Object.entries(state.sources).some(([name, hash]) => !validModuleName(name) || runtimeModules.has(name) || !/^[a-f0-9]{64}$/.test(hash)) ||
      modules.filter(name => (state.protocol !== 2 || name !== 'linux-proc.js') &&
        (name !== 'write-lock-recovery.js' || (state.revision ?? 0) >= 3)).some(name => !/^[a-f0-9]{64}$/.test(state.sources[name]))) {
    throw new HelperError('FILE_UNSAFE', 'The helper lock migration record is invalid.');
  }
  // Persisted data roots already have a history. Verify their storage coverage
  // before registration can add today's XDG paths and erase that uncertainty.
  // Only a genuinely new record may start with the current layout alone.
  if (process.platform === 'linux') {
    recoveryWritableRoots(state);
    await assertLinuxUnitPublicationsSettled(recoveryUnitFiles(state));
    await assertLinuxCoordinatorSettled(state);
  }
  if (state.recovery !== undefined) {
    validateLinuxLockRecovery(state.recovery);
    if (state.recovery.initial.installation !== state.bootstrap) throw linuxLockRetirementUnverified();
    if (!state.recovery.completion && !state.patching && !state.retirement) throw linuxLockRetirementUnverified();
  }
  return state;
}
const saveState = (directory: string, state: UpgradeState) => atomicWrite(join(directory, 'state.json'), JSON.stringify(state) + '\n');

function currentUnitFiles(paths: HelperPaths, roots: string[]): string[] {
  const units = [paths.serviceUnit ?? paths.servicePlist, join(paths.home, '.config/systemd/user/app.maddots.ai.helper.service'),
    join(paths.home, 'Library/LaunchAgents/app.maddots.ai.helper.plist')];
  if (roots.includes('/var/lib/mdai/home/.maddots-ai')) units.push(
    '/var/lib/mdai/config/systemd/user/app.maddots.ai.helper.service',
    '/var/lib/mdai/home/.config/systemd/user/app.maddots.ai.helper.service',
    '/var/lib/mdai/home/Library/LaunchAgents/app.maddots.ai.helper.plist');
  if (units.some(unit => !validStoragePath(unit))) throw linuxLockRetirementUnverified();
  return [...new Set(units)].sort();
}

async function serviceStorageRoots(paths: HelperPaths): Promise<string[]> {
  const roots: string[] = [];
  for (const [parent, children] of [
    ['/var/lib/mdai', ['data', 'config/maddots-ai', 'state/maddots-ai', 'runs', 'home/.maddots-ai']],
    ['/run/mdai-helper', ['mdai']],
  ] as const) {
    let info;
    try { await assertNoSymlinks(parent); info = await lstat(parent); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw linuxLockRetirementUnverified(); }
    // The fixed service belongs to its installation owner. Do not traverse a
    // different account's storage when preparing an ordinary user's helper.
    if (info.uid !== process.getuid?.()) {
      if ([paths.home, paths.data, paths.config!, paths.stateDir!, paths.runtime!].some(path => inside(parent, path))) throw linuxLockRetirementUnverified();
      continue;
    }
    if (!info.isDirectory() || (info.mode & 0o777) !== 0o700) throw linuxLockRetirementUnverified();
    roots.push(...children.map(child => join(parent, child)));
  }
  return roots;
}
async function currentStorageRoots(paths: HelperPaths, data = paths.data): Promise<string[]> {
  // Use the resolver's supplied configuration, never this process's environment.
  // Older callers lacking the full candidate list cannot establish coverage.
  if (!paths.config || !paths.stateDir || !paths.runtime || paths.state !== join(paths.stateDir, 'state.json') ||
      !paths.linuxStorage?.roots.length || !paths.linuxStorage.states.length) throw linuxLockRetirementUnverified();
  if (paths.credentialFile !== undefined && !validStoragePath(paths.credentialFile)) throw linuxLockRetirementUnverified();
  // Published 0.1.5 and origin/main use ~/.maddots-ai/claude-code independently
  // of the data override. Its dedicated parent also exposes an empty marketplace.
  // XDG and fixed service roots describe this revision's own storage contract.
  const roots = [...new Set([data, paths.config, paths.stateDir, paths.runtime, join(paths.home, '.maddots-ai'), ...paths.linuxStorage.roots,
    ...(paths.credentialFile ? [dirname(paths.credentialFile)] : []),
    ...await serviceStorageRoots(paths)])].sort();
  if (roots.some(root => !validStoragePath(root) || inside(root, paths.home))) throw linuxLockRetirementUnverified();
  return roots;
}
function currentStateFiles(paths: HelperPaths, roots: string[], data = paths.data): string[] {
  const states = [...new Set([paths.state, join(data, 'state.json'), ...paths.linuxStorage!.states,
    ...['/var/lib/mdai/data', '/var/lib/mdai/state/maddots-ai'].filter(root => roots.includes(root)).map(root => join(root, 'state.json'))])].sort();
  if (states.some(file => !validStoragePath(file) || !file.endsWith('/state.json') || !roots.includes(dirname(file)))) throw linuxLockRetirementUnverified();
  return states;
}
async function storageRegistration(state: UpgradeState, paths: HelperPaths, data = paths.data) {
  if (process.platform !== 'linux') return;
  if (!validStoragePath(paths.home)) throw linuxLockRetirementUnverified();
  const knownHome = state.homes?.includes(paths.home) ?? false;
  if (!paths.linuxStorage) {
    // Retrofitted rollback paths.js keeps its original resolver ABI. It may
    // reuse complete recorded coverage, but may never discover/register roots.
    // ef85906 (0.1.5) and b2f65cb (0.1.6 source) put state.json and every
    // data-relative publication under data; neither returns these newer roots.
    // Nested updater locks change paths.data while retaining the actual data
    // root in logs, so use the validated parent passed by guardedDataRoot.
    const retained = {...paths, config: paths.config ?? data, stateDir: paths.stateDir ?? data, runtime: paths.runtime ?? data};
    const previous = state.storage?.find(layout => layout.data === data);
    if (paths.credentialFile !== undefined && !validStoragePath(paths.credentialFile)) throw linuxLockRetirementUnverified();
    if (!knownHome || !previous || paths.state !== join(retained.stateDir, 'state.json') ||
        [data, retained.config, retained.stateDir, retained.runtime, join(paths.home, '.maddots-ai'),
          ...(paths.credentialFile ? [dirname(paths.credentialFile)] : []), ...await serviceStorageRoots(retained)]
          .some(root => !root || !previous.roots.includes(root)) ||
        currentUnitFiles(paths, previous.roots).some(unit => !previous.units?.includes(unit)) ||
        !previous.states.includes(paths.state)) throw linuxLockRetirementUnverified();
    return;
  }
  const roots = await currentStorageRoots(paths, data), states = currentStateFiles(paths, roots, data), units = currentUnitFiles(paths, roots);
  const previous = state.storage?.find(layout => layout.data === data);
  if (knownHome && previous && roots.every(root => previous.roots.includes(root)) && states.every(file => previous.states.includes(file)) &&
      units.every(unit => previous.units?.includes(unit))) return;
  if (state.recovery?.seal && !state.recovery.completion) throw linuxLockRetirementUnverified();
  if ((!knownHome && (state.homes?.length ?? 0) >= 256) || (!previous && (state.storage?.length ?? 0) >= 64) ||
      new Set([...(state.storage ?? []).flatMap(layout => layout.roots), ...roots]).size > 256 ||
      new Set([...(state.storage ?? []).flatMap(layout => layout.states), ...states]).size > 256 ||
      new Set([...(state.storage ?? []).flatMap(layout => layout.units ?? []), ...units]).size > 256) throw linuxLockRetirementUnverified();
  // A matching coordinator attributes only its recorded paths. Validate every
  // extension before changing data/storage, including guarded legacy callers,
  // hidden XDG candidates and fixed service storage discovered after install.
  // Released package/version metadata alone cannot attribute retained bytes.
  const knownRoots = new Set(state.storage?.flatMap(layout => layout.roots));
  const knownStates = new Set(state.storage?.flatMap(layout => layout.states));
  const knownUnits = new Set(state.storage?.flatMap(layout => layout.units ?? []));
  try {
    for (const root of roots) if (!knownRoots.has(root)) await assertEmptyLinuxRoot(root);
    for (const file of states) if (!knownStates.has(file)) {
      await assertNoSymlinks(file);
      if (await exists(file)) throw sourceUnverified();
    }
    const addedUnits = units.filter(unit => !knownUnits.has(unit));
    await assertLinuxUnitPublicationsSettled(addedUnits);
    for (const unit of addedUnits) if (await exists(unit)) throw sourceUnverified();
    if (!knownHome) {
      await assertNoSymlinks(paths.home);
      if (await exists(join(paths.home, 'MadDots Agents'))) throw sourceUnverified();
    }
  } catch {throw sourceUnverified();}
  return {previous, roots, states, units};
}
async function registerStorage(state: UpgradeState, paths: HelperPaths, data = paths.data): Promise<boolean> {
  const registration = await storageRegistration(state, paths, data);
  if (!registration) return false;
  const {previous, roots, states, units} = registration;
  // Retain every observed layout: changing XDG paths cannot hide an earlier
  // state/config/runtime publication from later reconciliation.
  if (previous) {
    previous.roots = [...new Set([...previous.roots, ...roots])].sort();
    previous.states = [...new Set([...previous.states, ...states])].sort();
    previous.units = [...new Set([...(previous.units ?? []), ...units])].sort();
  } else (state.storage ??= []).push({data, roots, states, units});
  state.homes = [...new Set([...(state.homes ?? []), paths.home])].sort();
  return true;
}
function retrofitLinuxWriterCaller(name: string, text: string): string | undefined {
  if (process.platform !== 'linux' || !['delivery/agents-folder.js', 'delivery/claude-plugin.js', 'runner/agents-local.js', 'runner/runner.js',
    'runner/runs-on.js', 'runner/test-run.js', 'runner/run-folder.js', 'agent-fence.js', 'notify.js', 'secret-store.js'].includes(name)) return;
  const marker = '// maddots-linux-writer-admission: 2';
  if (text.startsWith(marker + '\n')) return;
  let next = text;
  const insert = (declaration: string, guarded: (body: string) => boolean, paths: string, after = ''): void => {
    const matches = [...next.matchAll(new RegExp('^( +)' + declaration.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\n', 'gm'))];
    if (matches.length !== 1) throw new HelperError('CANDIDATE_FAILED', 'This runtime has an unsupported Linux writer entrypoint.');
    const match = matches[0];
    let start = match.index! + match[0].length;
    // The next method closes the inspected body. These known class methods
    // have no sibling method at a deeper indentation level.
    const end = next.indexOf('\n' + match[1] + '}', start);
    if (end < 0) throw new HelperError('CANDIDATE_FAILED', 'This runtime has an unsupported Linux writer entrypoint.');
    const body = next.slice(start, end);
    if (guarded(body) || body.includes('await assertLinuxWriterAdmission(' + paths + ');')) return;
    if (after) {
      if (body.split(after).length !== 2) throw new HelperError('CANDIDATE_FAILED', 'This runtime has an unsupported Linux writer entrypoint.');
      start += body.indexOf(after) + after.length;
    }
    next = next.slice(0, start) + match[1] + '    await assertLinuxWriterAdmission(' + paths + ');\n' + next.slice(start);
  };
  const insertFunction = (declaration: string, guard: string, paths: string, after = ''): void => {
    const matches = [...next.matchAll(new RegExp('^' + (declaration + '\n').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gm'))];
    if (matches.length !== 1) throw new HelperError('CANDIDATE_FAILED', 'This runtime has an unsupported Linux writer entrypoint.');
    let start = matches[0].index! + declaration.length + 1;
    const end = next.indexOf('\n}', start);
    if (end < 0) throw new HelperError('CANDIDATE_FAILED', 'This runtime has an unsupported Linux writer entrypoint.');
    const body = next.slice(start, end);
    if (body.includes(guard) || body.includes('await assertLinuxWriterAdmission(' + paths + ');')) return;
    if (after) {
      if (body.split(after).length !== 2) throw new HelperError('CANDIDATE_FAILED', 'This runtime has an unsupported Linux writer entrypoint.');
      start += body.indexOf(after) + after.length;
    }
    next = next.slice(0, start) + '    await assertLinuxWriterAdmission(' + paths + ');\n' + next.slice(start);
  };
  if (name === 'delivery/agents-folder.js') {
    insert('async root() {', body => body.includes('await assertLockUpgradeReady(this.paths);'), 'this.paths');
  } else if (name === 'delivery/claude-plugin.js') {
    insert('async root() {', body => body.includes('await assertLockUpgradeReady(this.paths);'), 'this.paths');
    insert('async applyPlan(plan, beforeApply) {', body => /let ready = true, code;\s+await withWriteLock\(this\.syncOptions\.paths, async \(\) => \{/u.test(body),
      'this.syncOptions.paths, this.syncOptions.timing');
  } else if (name === 'runner/agents-local.js') {
    insert('async setup(agent, options) {', body => /if \(!typed\) \{\s+await withWriteLock\(this\.paths, async \(\) => \{/u.test(body), 'this.paths');
  } else if (name === 'runner/runner.js') {
    insert('async init() {', body => body.includes('acquireStorageOwner(this.options.data, this.state)'), '{data: this.options.data}');
  } else if (name === 'runner/runs-on.js') {
    insert('async init() {', body => body.includes('this.boundRead('), 'this.options.paths');
    // forget/testConnection enter exclusive directly, before init. Admission
    // must precede its runner-directory creation even in a v1 repaired copy.
    insert('async exclusive(work, timing) {', body => body.includes('acquireRunnerControllerLease('), 'this.options.paths');
  } else if (name === 'runner/test-run.js') {
    insertFunction('async function testLease(data, work, skipBusy = false) {', 'acquireRunnerControllerLease(', '{data}');
  } else if (name === 'agent-fence.js') {
    insertFunction('export async function withAgentDestinationLocks(paths, destinations, action, timing = clock) {',
      'await assertLockUpgradeReady(paths, timing);', 'paths, timing');
  } else if (name === 'notify.js') {
    insertFunction('export async function reserveWaitingDialog(paths, waiting, options = {}) {',
      'await assertLockUpgradeReady(paths, options.timing);', 'paths, options.timing',
      "    const set = waitingSet(waiting);\n    if (!set.count)\n        return 'empty';\n");
    insertFunction('export async function interruptWaitingDialog(paths, dialog) {', 'await assertLockUpgradeReady(paths);', 'paths');
  } else if (name === 'secret-store.js') {
    const beforeOpen = next;
    insert('static async open(path, paths, options) {', body => body.includes('await assertLockUpgradeReady('),
      '{...paths, credentialFile: path}', '        await assertSecretPath(path, paths);\n');
    if (next !== beforeOpen) {
      const store = '        const store = new FileSecretStore(path, paths);';
      if (next.split(store).length !== 2) throw new HelperError('CANDIDATE_FAILED', 'This runtime has an unsupported Linux writer entrypoint.');
      next = next.replace(store, '        paths.credentialFile = path;\n' + store);
    }
    insert('async values() {', body => body.includes('await assertLockUpgradeReady(this.paths);'),
      'this.paths', '        await assertSecretPath(this.path, this.paths);\n');
  } else {
    insertFunction('export async function reserveRunFolder(options) {', 'withControllerStorage(', '{data: options.dataDir}');
    insertFunction('export async function recoverStagedFiles(options) {', 'withControllerStorage(', '{data: options.dataDir}');
  }
  if (next === text) return;
  next = next.replace(/^\/\/ maddots-linux-writer-admission: 1\n/u, '');
  if (!next.includes('import { assertLockUpgradeReady as assertLinuxWriterAdmission }')) {
    next = 'import { assertLockUpgradeReady as assertLinuxWriterAdmission } from ' +
      JSON.stringify(name.includes('/') ? '../write-lock-upgrade.js' : './write-lock-upgrade.js') + ';\n' + next;
  }
  return marker + '\n' + next;
}

function guardedDataRoot(paths: HelperPaths): string {
  // Nested updater locks retain logs under the actual application data root.
  if (process.platform !== 'linux') return dirname(paths.state);
  if (typeof paths.logs !== 'string' || !validStoragePath(paths.logs)) throw linuxLockRetirementUnverified();
  const data = dirname(paths.logs);
  if (paths.logs !== join(data, 'logs') || paths.data !== data && paths.data !== join(data, 'updates')) throw linuxLockRetirementUnverified();
  return data;
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw linuxLockRetirementUnverified(); }
}
async function assertEmptyLinuxRoot(root: string, allowedName?: string): Promise<void> {
  await assertNoSymlinks(root);
  if (!await exists(root)) return;
  const before = await lstat(root, {bigint: true});
  if (!before.isDirectory() || before.uid !== BigInt(process.getuid!()) || (before.mode & 0o777n) !== 0o700n) throw sourceUnverified();
  const handle = await opendir(root);
  try {
    for (let entry = await handle.read(); entry; entry = await handle.read()) {
      if (entry.name !== allowedName) throw sourceUnverified();
    }
  } finally {await handle.close();}
  const after = await lstat(root, {bigint: true});
  if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw sourceUnverified();
}
async function assertFreshLinuxStorage(runtime: Runtime, paths: HelperPaths, guarded = false,
  directory = join(runtime.bundledRoot, '.write-lock-upgrade')): Promise<void> {
  const roots = await currentStorageRoots(paths);
  currentStateFiles(paths, roots);
  // Retained content without provenance cannot be registered as today's layout.
  // The released sources and this revision are the only supported sources;
  // unknown internal installs require the owner's separate clean reinstall.
  // Even an empty child directory is evidence of ensurePaths/runner activity.
  try {
    await assertLinuxUnitPublicationsSettled(currentUnitFiles(paths, roots));
    // Released CLI/service paths reject Linux agent setup before it writes.
    // This dedicated folder is therefore unattributed evidence, not a root to
    // register, traverse or automatically recover as a released installation.
    if (await exists(join(paths.home, 'MadDots Agents'))) throw sourceUnverified();
    for (const root of [...roots, directory]) {
      await assertEmptyLinuxRoot(root, guarded && root === directory ? '.guard' :
        guarded && root === paths.data && directory === join(paths.data, '.write-lock-upgrade') ? '.write-lock-upgrade' : undefined);
    }
    // Released service installation can publish the plist only after its first
    // launchctl probe succeeds or returns the expected absent-service status.
    // Keep conservative inspection even though ordinary Linux fails that probe.
    for (const unit of currentUnitFiles(paths, roots)) {
      await assertNoSymlinks(dirname(unit));
      if (await exists(unit)) throw linuxLockRetirementUnverified();
    }
    let inspected = 0;
    const inspectModules = async (dist: string, depth: number): Promise<void> => {
      if (depth > 8) throw linuxLockRetirementUnverified();
      await assertNoSymlinks(dist);
      for (const entry of await readdir(dist, {withFileTypes: true})) {
        if (++inspected > 8192 || entry.isSymbolicLink() || entry.name === sidecar || entry.name.endsWith('.tmp') ||
            entry.name.startsWith('.refused-cli-')) throw linuxLockRetirementUnverified();
        if (entry.isDirectory()) await inspectModules(join(dist, entry.name), depth + 1);
        else if (!entry.isFile()) throw linuxLockRetirementUnverified();
      }
    };
    for (const root of new Set([runtime.bundledRoot, runtime.runningRoot])) await inspectModules(join(root, 'dist'), 0);
  } catch { throw sourceUnverified(); }
}
function recoveryWritableRoots(state: UpgradeState): string[] {
  if (!state.storage?.length || state.data.some(data => !state.storage?.some(layout => layout.data === data))) throw linuxLockRetirementUnverified();
  const roots = [...new Set(state.storage!.flatMap(layout => layout.roots))].sort();
  if (roots.length > 256) throw linuxLockRetirementUnverified();
  return roots;
}
const recoveryStateFiles = (state: UpgradeState): string[] => [...new Set(state.storage!.flatMap(layout => layout.states))].sort();
function recoveryUnitFiles(state: UpgradeState): string[] {
  if (!state.storage?.length || state.storage.some(layout => !layout.units?.length)) throw linuxLockRetirementUnverified();
  const units = [...new Set(state.storage.flatMap(layout => layout.units!))].sort();
  if (units.length > 256) throw linuxLockRetirementUnverified();
  return units;
}
async function assertLinuxCoordinatorSettled(state: UpgradeState): Promise<void> {
  // Coordinator state/source publications use the same atomic temporary files
  // as application storage. Preserve incomplete publications without hashing
  // state.json into its own recovery inventory or opening retained contents.
  const directory = join(state.bootstrap, '.write-lock-upgrade');
  try {
    await assertNoSymlinks(directory);
    const before = await lstat(directory, {bigint: true});
    if (!before.isDirectory() || before.uid !== BigInt(process.getuid!()) || (before.mode & 0o777n) !== 0o700n) throw linuxLockRetirementUnverified();
    let inspected = 0;
    const known = new Set<string>(['state.json', '.guard', ...modules, ...Object.keys(state.sources).map(sourceName)]);
    const handle = await opendir(directory);
    try {
      for (let entry = await handle.read(); entry; entry = await handle.read()) {
        if (++inspected > 8192 || !entry.isFile() || entry.isSymbolicLink() ||
            !known.has(entry.name) && !/^[a-f0-9]{64}\.(?:paths|updater|agents-folder|claude-plugin|agents-local|runner|runs-on|test-run|run-folder|agent-fence|notify|secret-store)-backup\.js$/u.test(entry.name)) throw linuxLockRetirementUnverified();
      }
    } finally {await handle.close();}
    const after = await lstat(directory, {bigint: true});
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw linuxLockRetirementUnverified();
  } catch {throw linuxLockRetirementUnverified();}
}
const recoveryInventory = async (state: UpgradeState) => {
  await assertLinuxCoordinatorSettled(state);
  const snapshot = await inventoryLinuxRecovery(state.bootstrap, state.data, await inventory(state),
    recoveryWritableRoots(state), recoveryStateFiles(state), recoveryUnitFiles(state));
  await assertLinuxCoordinatorSettled(state);
  return snapshot;
};
async function recoveryOwnership(state: UpgradeState, timing: Timing = clock): Promise<WriteGuardRelease> {
  const guards: Awaited<ReturnType<typeof acquireWriteGuard>>[] = [];
  try {
    for (const data of [...state.data].sort()) {
      await ensurePrivateDirectory(data);
      for (const folder of [data, join(data, 'updates')]) {
        try { await lstat(folder); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        guards.push(await acquireWriteGuard(join(folder, '.lock.guard'), timing, timing.now() + 10_000));
      }
    }
    await assertLinuxCoordinatorSettled(state);
    await reconcileLinuxRecovery(recoveryWritableRoots(state), recoveryStateFiles(state), await inventory(state));
    await assertLinuxCoordinatorSettled(state);
    for (const guard of guards) await guard.assertCurrent();
    return Object.assign(async () => {for (const guard of [...guards].reverse()) await guard();},
      {assertCurrent: async () => {for (const guard of guards) await guard.assertCurrent();}});
  } catch (error) {
    for (const guard of guards.reverse()) await guard();
    throw error;
  }
}
async function retainRecoveryBaseline(directory: string, state: UpgradeState): Promise<void> {
  if (process.platform !== 'linux') return;
  const boot = await recoveryBoot(), snapshot = await recoveryInventory(state);
  if (await recoveryBoot() !== boot) throw linuxLockRetirementUnverified();
  state.recovery = await beginLinuxLockRecovery(snapshot, state.recovery);
  state.patching = true;
  await saveState(directory, state);
}

async function retainInfrastructure(directory: string, state?: UpgradeState): Promise<Record<string, string>> {
  const missing = new Set<string>();
  const sources = await infrastructureSources(async name => {
    const expected = state?.sources[name];
    let text: string;
    if (expected) {
      try {text = await readPrivateFile(join(directory, sourceName(name)), 4 * 1024 * 1024);}
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        text = await moduleText(fileURLToPath(new URL('./' + name, import.meta.url))); missing.add(name);
      }
      if (digest(text) !== expected) throw new HelperError('INVALID_CHECKSUM', 'The retained lock migration source changed.');
    } else {text = await moduleText(fileURLToPath(new URL('./' + name, import.meta.url))); missing.add(name);}
    return text;
  }, state ? Object.keys(state.sources) : modules);
  const hashes = Object.fromEntries([...sources].map(([name, text]) => [name, digest(text)]));
  if (state && missing.size) {
    // Extend an old same-revision snapshot only with its missing imports. Keep
    // its infrastructure bytes and record the barrier before retaining files.
    await retainRecoveryBaseline(directory, state);
    state.sources = hashes; state.patching = true; await saveState(directory, state);
  }
  for (const name of missing) await atomicWrite(join(directory, sourceName(name)), sources.get(name)!);
  return hashes;
}

async function maintain(directory: string, state: UpgradeState, sealing = false): Promise<void> {
  if (process.platform === 'linux' && state.recovery?.seal && !state.recovery.completion) throw linuxLockRetirementUnverified();
  if (state.patching) await retainRecoveryBaseline(directory, state);
  // Completed macOS revision-1 snapshots predate the Linux recovery module.
  // Keep their matching dependency graph without starting another retirement.
  const sources = await infrastructureSources(async name => {
    const text = await readPrivateFile(join(directory, sourceName(name)), 4 * 1024 * 1024);
    if (digest(text) !== state.sources[name]) throw new HelperError('INVALID_CHECKSUM', 'The retained lock migration source changed.');
    return text;
  }, Object.keys(state.sources));
  // Dependencies precede the protocol marker. The target paths export is
  // retrofitted last, after the full graph has been installed and verified.
  const retainedModules = [...sources.keys()].filter(name => name !== 'write-lock.js').concat('write-lock.js');
  for (const {root, unpublished} of await inventory(state)) {
    if (unpublished) {
      // Extraction may still be running, or may have crashed halfway through.
      // Only a validated stage can reach the updater's activation callback.
      try { await readPrivateFile(join(root, '.ready.json'), 64 * 1024); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    }
    if (root !== state.bootstrap && !unpublished) {
      try { await moduleText(join(root, 'dist', 'cli.js')); }
      catch { continue; } // The existing selector cannot launch this release.
    }
    const target = join(root, 'dist', 'paths.js'), updater = join(root, 'dist', 'updater.js');
    let old: string, next: string | undefined, oldUpdater: string | undefined, nextUpdater: string | undefined;
    const callerRepairs: {path: string; old: string; next: string; backup: string}[] = [];
    const planned = new Map([...sources].map(([name, text]) => [join(root, 'dist', name), text]));
    try {
      old = await moduleText(target); next = retrofit(old);
      if (process.platform === 'linux') {
        try {oldUpdater = await moduleText(updater); nextUpdater = retrofitUpdater(oldUpdater);}
        catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
      }
      for (const name of process.platform === 'linux' ? ['delivery/agents-folder.js', 'delivery/claude-plugin.js', 'runner/agents-local.js',
        'runner/runner.js', 'runner/runs-on.js', 'runner/test-run.js', 'runner/run-folder.js', 'agent-fence.js', 'notify.js', 'secret-store.js'] : []) {
        const path = join(root, 'dist', name);
        let oldCaller: string;
        try {oldCaller = await moduleText(path);}
        catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error;}
        const nextCaller = retrofitLinuxWriterCaller(name, oldCaller);
        if (nextCaller) callerRepairs.push({path, old: oldCaller, next: nextCaller, backup: name.slice(name.lastIndexOf('/') + 1, -3)});
      }
      if (!next) {
        let lock: string | undefined;
        try { lock = await moduleText(join(root, 'dist', 'write-lock.js')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (lock !== undefined && !lock.startsWith(protocol) && !lock.startsWith('// maddots-write-lock-protocol: 2')) {
          throw new HelperError('CANDIDATE_FAILED', 'The selected runtime does not implement the guarded lock protocol.');
        }
      }
      if (next) planned.set(target, next);
      if (nextUpdater) planned.set(updater, nextUpdater);
      for (const caller of callerRepairs) planned.set(caller.path, caller.next);
      await verifyRuntimeGraph(root, sources, planned);
    }
    catch (error) {
      if (root === state.bootstrap) throw error;
      if (unpublished) {
        // Preserve a refused candidate outside the activation namespace. Its
        // updater cannot rename the old stage path and publish unsafe code.
        await rename(root, join(dirname(root), 'refused-stage-' + randomUUID()));
        throw new HelperError('CANDIDATE_FAILED', 'The candidate has an unsupported write-lock implementation.');
      }
      // A broken cached release must not strand bootstrap rollback. Preserve
      // its launcher outside the executable path, which also makes the legacy
      // selector reject it. Retire any already-loaded copy before admitting a
      // writer; repeated launches then skip the disabled cached release.
      await retainRecoveryBaseline(directory, state);
      state.patching = true; await saveState(directory, state);
      await rename(join(root, 'dist', 'cli.js'), join(root, 'dist', '.refused-cli-' + randomUUID() + '.js'));
      continue;
    }
    // A protocol marker proves only that one module was published. Compare
    // every retained module even after the marker appears, so old interrupted
    // migrations and later missing modules can never skip the repair barrier.
    const repairs: string[] = [];
    for (const name of retainedModules) {
      let text: string | undefined;
      try { text = await moduleText(join(root, 'dist', name)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (text === undefined || digest(text) !== state.sources[name]) repairs.push(name);
    }
    if (next || nextUpdater || callerRepairs.length || repairs.length) {
      // Persist the barrier BEFORE the first replacement. An interrupted
      // migration is resumable, but no partially migrated writer may enter.
      // Stages are not executable supported runtimes yet: the updater's inner
      // main lock checks their final bytes before rename and pointer activation.
      if (!unpublished) { await retainRecoveryBaseline(directory, state); state.patching = true; await saveState(directory, state); }
      if (next) await atomicWrite(join(directory, digest(old) + '.paths-backup.js'), old);
      if (nextUpdater) await atomicWrite(join(directory, digest(oldUpdater!) + '.updater-backup.js'), oldUpdater!);
      for (const caller of callerRepairs) await atomicWrite(join(directory, digest(caller.old) + '.' + caller.backup + '-backup.js'), caller.old);
      await atomicWrite(join(root, 'dist', sidecar), JSON.stringify({directory}) + '\n');
      for (const name of repairs) {
        try {await lstat(dirname(join(root, 'dist', name)));}
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          await ensurePrivateDirectory(dirname(join(root, 'dist', name)));
        }
        if (name === 'write-lock.js') {
          const pending = new Map(planned);
          for (const installed of sources.keys()) if (installed !== name) pending.delete(join(root, 'dist', installed));
          await verifyRuntimeGraph(root, sources, pending);
        }
        await replaceModule(join(root, 'dist', name), sources.get(name)!);
      }
      if (nextUpdater) await replaceModule(updater, nextUpdater);
      for (const caller of callerRepairs) await replaceModule(caller.path, caller.next);
      if (next) {
        await verifyRuntimeGraph(root, sources, new Map([[target, next]]), planned.keys());
        await replaceModule(target, next);
      }
    } else {
      await atomicWrite(join(root, 'dist', sidecar), JSON.stringify({directory}) + '\n');
    }
    await verifyRuntimeGraph(root, sources, new Map(), planned.keys());
  }
  // Explicit sealing never treats a failed process scan as cohort proof. It
  // leaves patching/cohorts intact until the separate postboot commit succeeds.
  if (sealing) return;
  if (state.patching) {
    // Capture AFTER the last replacement. Processes that imported old code
    // during the retrofit are included, as is this caller's old bootstrap.
    // If inspection or persistence fails, the on-disk patching barrier stays.
    const previous = state.retirement ? await pendingRetirement(state.retirement) : [];
    const retirement = await captureRetirement();
    if (state.retirement?.boot === retirement.boot) {
      const processes = new Map(retirement.processes.map(row => [row.pid, row]));
      // Refreshing infrastructure must not forget a saved, still-live host
      // merely because its current image is exempt from a fresh capture.
      for (const row of previous) if (!processes.has(row.pid)) processes.set(row.pid, row);
      retirement.processes = [...processes.values()].sort((a, b) => a.pid - b.pid);
    }
    state.retirement = retirement;
    delete state.patching;
    await saveState(directory, state);
  }
  if (state.retirement) {
    let pending = await pendingRetirement(state.retirement);
    if (pending.length) {
      // Only our named background service may be restarted. Its own process
      // exits with HELPER_BUSY and the service manager starts a fresh process.
      if (process.platform !== 'linux') await restartLegacyService(pending);
      pending = await pendingRetirement(state.retirement);
    }
    if (pending.length) throw process.platform === 'linux' ? linuxLockRetirementUnverified() : new HelperError('HELPER_BUSY', formatRetirementMessage(pending));
    // A legacy updater may have published one last runtime after our inventory
    // but before its process exited. With that cohort gone, inventory once more
    // before admitting any writer. A newly found legacy root starts a new barrier.
    delete state.retirement;
    await maintain(directory, state);
    if (process.platform === 'linux' && state.recovery && !state.patching && !state.retirement) {
      const release = await recoveryOwnership(state);
      try {
        const boot = await recoveryBoot();
        const final = await recoveryInventory(state);
        if (final.roots.some(root => root.unpublished) || final.artifacts.some(artifact => artifact.path.endsWith('.tmp'))) throw linuxLockRetirementUnverified();
        state.recovery.completion = {boot, method: 'cohort', inventory: final};
        if (await recoveryBoot() !== boot) throw linuxLockRetirementUnverified();
        await release.assertCurrent();
        await saveState(directory, state);
      } finally {await release();}
    }
    await saveState(directory, state);
  }
  // A previous rename may have become visible before a failed directory fsync.
  // Re-sync the completion under the guard before any subsequent admission.
  if (process.platform === 'linux' && state.recovery?.completion) await saveState(directory, state);
}

/** Called by the selected CLI before any state-changing command. */
export async function prepareLockUpgrade(runtime: Runtime, paths: HelperPaths, timing: Timing = clock): Promise<void> {
  if (systemRuntimeMode(runtime.bundledRoot)) {
    if (runtime.runningRoot !== runtime.bundledRoot) assertSystemRuntimeOperation(runtime.bundledRoot, 'cached-runtime selection');
    await assertSystemRuntime(runtime.bundledRoot, paths);
    return prepareSystemRuntime(runtime.bundledRoot, paths, timing,
      guarded => assertFreshLinuxStorage(runtime, paths, guarded, join(paths.data, '.write-lock-upgrade')));
  }
  const directory = join(runtime.bundledRoot, '.write-lock-upgrade');
  // Refuse unknown history without even creating a coordinator directory or
  // guard. Repeat under ownership before the first registration is published.
  if (process.platform === 'linux') {
    if (await exists(join(directory, 'state.json'))) await storageRegistration(await readState(directory), paths);
    else await assertFreshLinuxStorage(runtime, paths);
  }
  try { await ensurePrivateDirectory(directory); }
  catch (error) {
    if (['EACCES', 'EPERM', 'EROFS'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      throw new HelperError('PATH_UNSAFE', 'Reinstall the helper in a user-owned location before upgrading its lock implementation.');
    }
    throw error;
  }
  const unlock = await acquireWriteGuard(join(directory, '.guard'), timing, timing.now() + 10_000);
  try {
    let state: UpgradeState;
    try { state = await readState(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (process.platform === 'linux') await assertFreshLinuxStorage(runtime, paths, true);
      const sources = await retainInfrastructure(directory);
      // Darwin retains its existing cohort migration. Linux's missing-record
      // candidates were empty above; retained evidence must never reach here.
      let existing = false;
      for (const path of process.platform === 'linux' ? [] : [paths.state, paths.lock, paths.lock + '.guard']) {
        try { await lstat(path); existing = true; }
        catch (inspection) { if ((inspection as NodeJS.ErrnoException).code !== 'ENOENT') throw inspection; }
      }
      state = {protocol: 3, revision, ...(process.platform === 'linux' ? {linuxSourcePolicy} : {}),
        bootstrap: resolve(runtime.bundledRoot), data: [paths.data], sources, ...(existing ? {patching: true} : {})};
      await registerStorage(state, paths);
      await saveState(directory, state);
    }
    if (state.bootstrap !== resolve(runtime.bundledRoot)) throw new HelperError('PATH_UNSAFE', 'The lock migration belongs to another bootstrap.');
    const addedData = !state.data.includes(paths.data);
    const addedStorage = await registerStorage(state, paths);
    if (addedData) state.data.push(paths.data);
    if (addedStorage || addedData) {state.patching = true; await saveState(directory, state);}
    if (state.protocol === 2 || (state.revision ?? 0) < revision || (process.platform === 'linux' && !state.sources['write-lock-recovery.js'])) {
      // Retain the old record's barrier and cohort while upgrading migration
      // infrastructure. The revision also replaces pre-fix protocol-3 sources;
      // a partially copied snapshot is retried until this state save commits.
      await retainRecoveryBaseline(directory, state);
      const sources = await retainInfrastructure(directory);
      state.sources = sources; state.protocol = 3; state.revision = revision; state.patching = true;
      await saveState(directory, state);
    }
    await retainInfrastructure(directory, state);
    coordinator = directory;
    await maintain(directory, state);
  } finally { await unlock(); }
}

/** Every retrofitted bootstrap, rollback runtime and nested updater uses this. */
export async function assertLockUpgradeReady(paths: HelperPaths, timing: Timing = clock): Promise<void> {
  if (systemRuntimeMode(dirname(dirname(fileURLToPath(import.meta.url))))) return assertSystemRuntimeReady(paths, timing);
  let directory = coordinator;
  if (!directory) {
    try {
      const value = JSON.parse(await readPrivateFile(fileURLToPath(new URL('./' + sidecar, import.meta.url))));
      if (typeof value.directory !== 'string' || resolve(value.directory) !== value.directory) throw new HelperError('FILE_UNSAFE', 'Invalid lock migration location.');
      directory = value.directory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (RELEASE_IDENTITY && fileURLToPath(import.meta.url).endsWith('.js')) throw new HelperError('HELPER_BUSY', 'Run maddots-ai status to finish the helper lock upgrade, then retry.');
      return; // Uninstalled source fixtures have no retained runtime to migrate.
    }
  }
  if (process.platform === 'linux') {
    const state = await readState(directory!);
    if (typeof paths.state === 'string') await storageRegistration(state, paths, guardedDataRoot(paths));
    else if (!state.data.some(data => inside(data, paths.data))) {
      throw new HelperError('PATH_UNSAFE', 'The helper data root must be registered before acquiring a nested lock.');
    }
  }
  const unlock = await acquireWriteGuard(join(directory!, '.guard'), timing, timing.now() + 10_000);
  try {
    const state = await readState(directory!);
    // Only prepareLockUpgrade has selected an intact runtime as the source of
    // a newer coordinator revision. A guarded caller must not restore retained
    // pre-fix modules over that runtime before its source snapshot is adopted.
    if (state.protocol === 2 || (state.revision ?? 0) < revision || (process.platform === 'linux' && !state.sources['write-lock-recovery.js'])) {
      throw new HelperError('HELPER_BUSY', 'Run maddots-ai status to finish the helper lock upgrade, then retry.');
    }
    // Old CLIs do not call prepareLockUpgrade. Their full paths still identify
    // the real data root even when the updater overrides data for its own lock.
    if (typeof paths.state === 'string') {
      // Linux puts state in XDG_STATE_HOME. The updater changes data/lock for
      // its nested lock but retains logs under the real application data root.
      const data = guardedDataRoot(paths);
      const added = !state.data.includes(data);
      const addedStorage = await registerStorage(state, paths, data);
      if (added) state.data.push(data);
      if (addedStorage || added) {state.patching = true; await saveState(directory!, state);}
    } else if (!state.data.some(data => inside(data, paths.data))) {
      throw new HelperError('PATH_UNSAFE', 'The helper data root must be registered before acquiring a nested lock.');
    }
    await maintain(directory!, state);
  }
  finally { await unlock(); }
  // Never keep the migration guard across the caller's action: updater and
  // agent operations legitimately nest distinct application locks.
}

async function assertRecoveryStorage(state: UpgradeState, runtime: Runtime, paths: HelperPaths): Promise<void> {
  if (state.bootstrap !== resolve(runtime.bundledRoot) || state.protocol !== 3 || state.revision !== revision ||
      !state.data.includes(paths.data) || !state.homes?.includes(paths.home) || !state.recovery || state.recovery.completion) throw linuxLockRetirementUnverified();
  const registered = state.storage?.find(layout => layout.data === paths.data);
  const roots = await currentStorageRoots(paths);
  if (!registered || currentStateFiles(paths, roots).some(file => !registered.states.includes(file)) || roots.some(root => !registered.roots.includes(root)) ||
      currentUnitFiles(paths, roots).some(unit => !registered.units?.includes(unit))) throw linuxLockRetirementUnverified();
}

/** Explicit operator recovery. It never stops services, reboots, deletes state,
 * forces a lock, or accepts an operator-supplied drained/boot proof. */
export async function recoverLinuxLockUpgrade(runtime: Runtime, paths: HelperPaths, phase: 'seal' | 'complete', timing: Timing = clock): Promise<void> {
  assertSystemRuntimeOperation(runtime.bundledRoot, 'automatic adoption of retained lock recovery state');
  if (process.platform !== 'linux' || !['seal', 'complete'].includes(phase)) throw linuxLockRetirementUnverified();
  const directory = join(runtime.bundledRoot, '.write-lock-upgrade');
  if (!await exists(join(directory, 'state.json'))) throw sourceUnverified();
  // Explicit recovery never extends provenance, including before guard creation.
  await assertRecoveryStorage(await readState(directory), runtime, paths);
  const unlock = await acquireWriteGuard(join(directory, '.guard'), timing, timing.now() + 10_000);
  let releaseOwnership: WriteGuardRelease | undefined;
  try {
    const state = await readState(directory);
    await assertRecoveryStorage(state, runtime, paths);
    if (!state.recovery) throw linuxLockRetirementUnverified();
    const checks = {inventory: () => recoveryInventory(state)};
    if (phase === 'seal') {
      await verifyLinuxRecoveryEntrypoints(false);
      if (!state.recovery.seal) {
        // Reboot mid-patch requires a newly persisted window and another boot
        // after its completed seal. The original baseline remains in the record.
        await retainRecoveryBaseline(directory, state);
        await maintain(directory, state, true);
      }
      const candidate = await sealLinuxLockRecovery(state.recovery, checks);
      // A candidate is not a completed seal. Persist/sync it first, then read
      // the final hashes and actual boot again across that physical write.
      // Reboot or EIO here leaves only the original barrier and an inert attempt.
      if (!state.recovery.seal) {
        state.recovery = {...state.recovery, sealing: candidate.seal};
        await saveState(directory, state);
      }
      const recovery = await sealLinuxLockRecovery(state.recovery, checks);
      if (JSON.stringify(candidate.seal) !== JSON.stringify(recovery.seal)) throw linuxLockRetirementUnverified();
      await unlock.assertCurrent();
      await saveState(directory, {...state, recovery});
      return;
    }
    // Revalidate before acquiring, and again under every exclusive ownership
    // guard. Failure preserves the sealed barrier for inspection/retry.
    const boot = await verifyLinuxLockRecovery(state.recovery, checks);
    releaseOwnership = await recoveryOwnership(state, timing);
    if (await verifyLinuxLockRecovery(state.recovery, checks) !== boot) throw linuxLockRetirementUnverified();
    await reconcileLinuxRecovery(recoveryWritableRoots(state), recoveryStateFiles(state), await inventory(state));
    await unlock.assertCurrent();
    if (await verifyLinuxLockRecovery(state.recovery, checks) !== boot) throw linuxLockRetirementUnverified();
    await releaseOwnership.assertCurrent();
    const completed: UpgradeState = {...state, recovery: {...state.recovery,
      completion: {boot, method: 'reboot', inventory: state.recovery.seal!.inventory}}};
    delete completed.patching; delete completed.retirement;
    // atomicWrite awaits file sync, rename and directory sync. No admission is
    // reached in this command, including if any part of that commit fails.
    await saveState(directory, completed);
  } finally {
    await releaseOwnership?.();
    await unlock();
  }
}
