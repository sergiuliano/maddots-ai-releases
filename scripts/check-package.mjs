import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const modules = ['api', 'backups', 'build-keys', 'cli', 'config', 'detect', 'imports', 'lock', 'npm', 'pairing', 'paths', 'release-identity', 'runtime', 'safe-fs', 'scan', 'secret-store', 'service', 'stamp', 'state', 'sync', 'token', 'unmanaged', 'updater', 'verify', 'duplicates', 'holding', 'allow', 'notify', 'code-reasons', 'local-edits', 'proposals', 'unmanaged-replacement'];
const shared = ['build-format', 'error-codes', 'helper-protocol', 'skill-errors', 'skill-limits', 'skill-types', 'tool-matrix', 'helper-imports-protocol', 'skill-code', 'plan-item-id'];
export function allowedRuntimePath(path) {
  if (['package.json', 'npm-shrinkwrap.json', 'LICENSE', 'dist/shared/tool-matrix.json'].includes(path)) return true;
  if (/^dist\/delivery\/(?:index|agents-folder|claude-plugin)\.(?:js|d\.ts)$/.test(path)) return true;
  if (/^dist\/shared\/skill-checks\/(?:secret-rules|risk-signs|injection)\.(?:js|d\.ts)$/.test(path)) return true;
  const match = /^dist\/(shared\/)?([a-z-]+)\.(?:js|d\.ts)$/.exec(path);
  return Boolean(match && (match[1] ? shared : modules).includes(match[2]));
}
export function checkManifest(pkg) {
  assert.equal(pkg.name, 'maddots-ai');
  assert.equal(pkg.private, true, 'npm publication must remain disabled.');
  assert.equal(pkg.license, 'MIT');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(pkg.bin, { 'maddots-ai': 'dist/cli.js' });
  assert.match(pkg.repository?.url || '', /^git\+https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\.git$/);
}
export async function runtimeFiles(root, directory = 'dist') {
  assert.ok((await lstat(join(root, directory))).isDirectory(), 'Runtime folder must be a real directory.');
  const paths = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = directory + '/' + entry.name;
    assert.ok(!entry.isSymbolicLink(), 'Compiled helper entries must not be symlinks.');
    if (entry.isDirectory()) { assert.ok(['dist/delivery', 'dist/shared', 'dist/shared/skill-checks'].includes(path), 'Unexpected compiled helper folder.'); paths.push(...await runtimeFiles(root, path)); }
    else { assert.ok(entry.isFile() && allowedRuntimePath(path), 'Unexpected compiled helper file: ' + path); paths.push(path); }
  }
  return paths;
}
export function cleanEnvironment(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|KEY|SECRET/i.test(key) && !/^MADDOTS_AI_/i.test(key)));
  return { ...env, PATH: dirname(process.execPath) + ':' + (process.env.PATH || ''), MADDOTS_AI_AUTO_UPDATE: '0', ...extra };
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const cache = await mkdtemp(join(await realpath(tmpdir()), 'maddots-ai-pack-'));
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    checkManifest(pkg);
    const compiled = await runtimeFiles(root);
    for (const module of modules) assert.ok(compiled.includes(`dist/${module}.js`), 'Missing helper module: ' + module);
    assert.ok(compiled.includes('dist/delivery/index.js'), 'Missing delivery interface.');
    assert.ok(compiled.includes('dist/shared/tool-matrix.json'), 'Missing tool matrix.');
    const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '--cache', cache], { cwd: root, env: cleanEnvironment(), encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] }))[0];
    for (const { path } of packed.files) {
      assert.ok(allowedRuntimePath(path) || ['README.md', 'docs/install.md'].includes(path), 'Unexpected package file: ' + path);
      assert.ok((await lstat(join(root, path))).isFile(), 'Package entries must be regular files.');
      if (path.endsWith('.js')) {
        const code = await readFile(join(root, path), 'utf8');
        const executableScan = path === 'dist/runtime.js' ? code.replace("import(pathToFileURL(join(root, 'dist/cli.js')).href)", 'VERIFIED_RUNTIME_IMPORT') : code;
        assert.doesNotMatch(executableScan, /\b(?:require\s*\(|import\s*\()/, 'Unreviewed dynamic module import: ' + path);
        for (const match of code.matchAll(/\bfrom\s+(['"])([^'"\n]+)\1|(?:^|\n)\s*import\s+(['"])([^'"\n]+)\3/g)) {
          const imported = match[2] || match[4];
          const local = imported.startsWith('.') && resolve('/', dirname(path), imported).slice(1);
          assert.ok(imported.startsWith('node:') || Object.hasOwn(pkg.dependencies || {}, imported) || (local && allowedRuntimePath(local) && compiled.includes(local)), 'Unreviewed compiled helper import: ' + path);
        }
      }
    }
    for (const path of [...compiled, 'LICENSE', 'package.json']) assert.ok(packed.files.some(file => file.path === path), 'Missing package file: ' + path);
    process.stdout.write(JSON.stringify({ package: pkg.name, files: packed.files.length, boundary: 'passed', npmPublication: false }) + '\n');
  } finally { await rm(cache, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
