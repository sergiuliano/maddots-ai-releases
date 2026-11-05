import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const modules = ['agent-fence', 'api', 'backups', 'build-keys', 'cli', 'cli-main', 'cli-validation', 'config', 'detect', 'git-repository', 'imports', 'linked-homes', 'lock', 'npm', 'pairing', 'platform', 'paths', 'provider-keys', 'release-identity', 'runtime', 'system-runtime', 'system-runtime-operation', 'system-runtime-preflight', 'safe-fs', 'scan', 'secret-store', 'service', 'stamp', 'state', 'sync', 'token', 'unmanaged', 'updater', 'verify', 'duplicates', 'holding', 'allow', 'notify', 'code-reasons', 'local-edits', 'proposals', 'unmanaged-replacement', 'write-lock', 'write-lock-upgrade', 'write-lock-retirement', 'write-lock-recovery', 'process-image', 'linux-proc', 'linux-tool-closures', 'tool-command'];
const shared = ['agent-name', 'build-format', 'error-codes', 'helper-protocol', 'skill-errors', 'skill-limits', 'skill-types', 'tool-capabilities', 'tool-matrix', 'helper-imports-protocol', 'skill-code', 'skill-folder-names', 'plan-item-id', 'runner-acceptance', 'runner-protocol', 'helper-http-diagnostics', 'strict-json', 'sync-protocol'];
const runner = ['acceptance', 'adapter', 'adapters/index', 'adapters/codex', 'adapters/claude-code', 'adapters/opencode', 'card-prompt', 'device-key', 'maddots-api', 'process', 'signal-gate', 'protocol-client', 'run-folder', 'runner', 'state', 'token-check', 'post', 'runs-on', 'test-run', 'agents-local', 'stage-skills', 'cli-runs', 'journal', 'journal-bootstrap', 'storage-creation', 'storage-lock', 'storage-owner', 'linux-authorization', 'linux-containment', 'linux-guardian', 'linux-lifecycle', 'linux-local-provider', 'linux-login-provider', 'linux-selected-login', 'linux-workspace'];
export function allowedRuntimePath(path) {
  if (['package.json', 'npm-shrinkwrap.json', 'LICENSE', 'dist/shared/tool-matrix.json', 'dist/shared/runner-contract.json'].includes(path)) return true;
  const runnerPath = /^dist\/runner\/([a-z/-]+)\.(?:js|d\.ts)$/.exec(path);
  if (runnerPath) return runner.includes(runnerPath[1]);
  if (/^dist\/delivery\/(?:index|agents-folder|claude-plugin)\.(?:js|d\.ts)$/.test(path)) return true;
  if (/^dist\/shared\/skill-checks\/(?:secret-rules|risk-signs|injection)\.(?:js|d\.ts)$/.test(path)) return true;
  const match = /^dist\/(shared\/)?([a-z-]+)\.(?:js|d\.ts)$/.exec(path);
  return Boolean(match && (match[1] ? shared : modules).includes(match[2]));
}
export const linuxTrustedRuntime = Object.freeze(['dist/system-runtime.js', 'dist/system-runtime-preflight.js', 'dist/linux-tool-closures.js', 'dist/runner/linux-authorization.js', 'dist/runner/linux-containment.js', 'dist/runner/linux-guardian.js', 'dist/runner/linux-lifecycle.js', 'dist/runner/linux-local-provider.js', 'dist/runner/linux-login-provider.js', 'dist/runner/linux-selected-login.js', 'dist/runner/linux-workspace.js', 'dist/runner/journal.js', 'dist/runner/journal-bootstrap.js', 'dist/runner/storage-creation.js', 'dist/runner/storage-owner.js', 'dist/runner/storage-lock.js', 'dist/runner/signal-gate.js']);
export const acceptanceRuntime = Object.freeze(['dist/runner/acceptance.js', 'dist/shared/runner-acceptance.js', 'dist/shared/tool-capabilities.js']);
export function checkRequiredRunnerRuntime(compiled) {
  for (const path of [...linuxTrustedRuntime, ...acceptanceRuntime]) assert.ok(compiled.includes(path), 'Missing required runner runtime: ' + path);
}
const reviewedLocalDynamicImports = Object.freeze({
  'dist/cli.js': ['./cli-main.js', './cli-validation.js'],
  'dist/cli-main.js': ['./write-lock-upgrade.js'],
  'dist/config.js': ['./system-runtime-preflight.js'],
  'dist/linux-proc.js': ['./system-runtime-preflight.js'],
  'dist/runtime.js': ['./write-lock-upgrade.js'],
  'dist/tool-command.js': ['./runner/linux-lifecycle.js'],
  'dist/runner/storage-owner.js': ['./linux-containment.js'],
  'dist/runner/process.js': ['./storage-lock.js'],
});
export function checkCompiledImports(path, code, compiled, pkg) {
  const runtimeScan = path === 'dist/runtime.js' ? code.replace("import(pathToFileURL(join(root, 'dist/cli.js')).href)", 'VERIFIED_RUNTIME_IMPORT') : code;
  // Exactly the reviewed native Foundation binding in the fixed JXA script.
  const executableScan = path === 'dist/process-image.js' ? runtimeScan.replace("ObjC.import('Foundation');", 'REVIEWED_FOUNDATION_BRIDGE;') : runtimeScan;
  const dynamicScan = executableScan.replace(/\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g, (expression, _quote, target) => {
    if (!reviewedLocalDynamicImports[path]?.includes(target)) return expression;
    const local = resolve('/', dirname(path), target).slice(1);
    assert.ok(allowedRuntimePath(local) && compiled.includes(local), 'Missing reviewed dynamic helper import: ' + path);
    return 'REVIEWED_LOCAL_RUNTIME_IMPORT';
  });
  assert.doesNotMatch(dynamicScan, /\b(?:require\s*\(|import\s*\()/, 'Unreviewed dynamic module import: ' + path);
  for (const match of code.matchAll(/\bfrom\s+(['"])([^'"\n]+)\1|(?:^|\n)\s*import\s+(['"])([^'"\n]+)\3/g)) {
    const imported = match[2] || match[4];
    if (path === 'dist/system-runtime-preflight.js') {
      assert.ok(imported.startsWith('node:'), 'The system runtime preflight may import only Node builtins.');
    }
    const local = imported.startsWith('.') && resolve('/', dirname(path), imported).slice(1);
    const dependency = Object.hasOwn(pkg.dependencies || {}, imported) && imported !== 'yaml';
    assert.ok(imported.startsWith('node:') || dependency || (local && allowedRuntimePath(local) && compiled.includes(local)), 'Unreviewed compiled helper import: ' + path);
  }
}
// Candidate versions never enter the normal release or updater version policy.
export function checkVersion(version, { attestOnly = false } = {}) {
  assert.match(version, attestOnly === true
    ? /^\d+\.\d+\.\d+(?:-linux\.[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/
    : /^\d+\.\d+\.\d+$/, 'Only attest-only mode accepts a -linux.* candidate version.');
}
export function checkManifest(pkg, options = {}) {
  assert.equal(pkg.name, 'maddots-ai');
  assert.equal(pkg.private, true, 'npm publication must remain disabled.');
  assert.equal(pkg.license, 'MIT');
  assert.ok(!Object.hasOwn(pkg.dependencies || {}, 'yaml'), 'YAML is only used by source-only adapters.');
  checkVersion(pkg.version, options);
  assert.deepEqual(pkg.bin, { 'maddots-ai': 'dist/cli.js' });
  assert.match(pkg.repository?.url || '', /^git\+https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\.git$/);
}
export async function runtimeFiles(root, directory = 'dist') {
  assert.ok((await lstat(join(root, directory))).isDirectory(), 'Runtime folder must be a real directory.');
  const paths = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = directory + '/' + entry.name;
    assert.ok(!entry.isSymbolicLink(), 'Compiled helper entries must not be symlinks.');
    if (entry.isDirectory()) { assert.ok(['dist/delivery', 'dist/shared', 'dist/shared/skill-checks', 'dist/runner', 'dist/runner/adapters'].includes(path), 'Unexpected compiled helper folder.'); paths.push(...await runtimeFiles(root, path)); }
    else { assert.ok(entry.isFile() && allowedRuntimePath(path), 'Unexpected compiled helper file: ' + path); paths.push(path); }
  }
  return paths;
}
export function cleanEnvironment(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|KEY|SECRET/i.test(key) && !/^MADDOTS_AI_/i.test(key)));
  return { ...env, PATH: dirname(process.execPath) + ':' + (process.env.PATH || ''), MADDOTS_AI_AUTO_UPDATE: '0', ...extra };
}

export function packageContents(root, cache, spawn = spawnSync) {
  const result = spawn('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '--cache', cache], {
    cwd: root, env: cleanEnvironment(), encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  // A denied nested spawn can return empty stdout even alongside status zero.
  // Preserve the operating-system error before treating output as package JSON.
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `npm pack failed (${result.signal ?? result.status}): ${result.stderr ?? ''}`);
  assert.ok(typeof result.stdout === 'string' && result.stdout.trim(), 'npm pack returned no package JSON.');
  const packages = JSON.parse(result.stdout);
  assert.ok(Array.isArray(packages) && packages.length === 1 && Array.isArray(packages[0]?.files) && packages[0].files.length > 0,
    'npm pack must enumerate exactly one non-empty package.');
  return packages[0];
}

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 1 && args[0] === '--attest-only'), 'Usage: check-package.mjs [--attest-only]');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const cache = await mkdtemp(join(await realpath(tmpdir()), 'maddots-ai-pack-'));
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    checkManifest(pkg, { attestOnly: args[0] === '--attest-only' });
    const compiled = await runtimeFiles(root);
    for (const module of modules) assert.ok(compiled.includes(`dist/${module}.js`), 'Missing helper module: ' + module);
    checkRequiredRunnerRuntime(compiled);
    assert.ok(compiled.includes('dist/delivery/index.js'), 'Missing delivery interface.');
    assert.ok(compiled.includes('dist/shared/tool-matrix.json'), 'Missing tool matrix.');
    const packed = packageContents(root, cache);
    for (const { path } of packed.files) {
      assert.ok(allowedRuntimePath(path) || ['README.md', 'docs/install.md'].includes(path), 'Unexpected package file: ' + path);
      assert.ok((await lstat(join(root, path))).isFile(), 'Package entries must be regular files.');
      if (path.endsWith('.js')) {
        const code = await readFile(join(root, path), 'utf8');
        checkCompiledImports(path, code, compiled, pkg);
      }
    }
    for (const path of [...compiled, 'LICENSE', 'package.json']) assert.ok(packed.files.some(file => file.path === path), 'Missing package file: ' + path);
    process.stdout.write(JSON.stringify({ package: pkg.name, files: packed.files.length, boundary: 'passed', npmPublication: false }) + '\n');
  } finally { await rm(cache, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
