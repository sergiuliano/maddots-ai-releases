// Build one reviewed runtime archive and exercise those exact installed bytes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { allowedRuntimePath, checkManifest, cleanEnvironment, modules, runtimeFiles } from './check-package.mjs';

export async function prepareRelease(args = process.argv.slice(2), dependencies = {}) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--output' && args[1]), 'Usage: prepare-release.mjs [--output DIRECTORY]');
  const output = resolve(args[1] || join(root, 'release'));
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  checkManifest(pkg);
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  assert.equal(lock.lockfileVersion, 3, 'A reviewed npm v3 lockfile is required.');
  assert.equal(lock.name, pkg.name); assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages?.['']?.name, pkg.name); assert.equal(lock.packages?.['']?.version, pkg.version);
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies, 'Runtime dependencies must match the lockfile.');
  assert.deepEqual(lock.packages[''].devDependencies, pkg.devDependencies, 'Development dependencies must match the lockfile.');
  for (const [path, dependency] of Object.entries(lock.packages)) {
    if (!path) continue;
    assert.ok(path.startsWith('node_modules/') && !path.split('/').includes('..'), 'Invalid locked dependency path.');
    assert.match(dependency.resolved || '', /^https:\/\/registry\.npmjs\.org\//, 'Dependencies must come from the reviewed registry lock.');
    assert.match(dependency.integrity || '', /^sha512-[A-Za-z0-9+/]+=*$/, 'Every dependency needs a locked integrity digest.');
  }
  const work = await mkdtemp(join(await realpath(tmpdir()), 'maddots-ai-release-'));
  const stage = join(work, 'package');
  const clean = join(work, 'clean');
  const env = cleanEnvironment({ MADDOTS_AI_HOME: join(work, 'unused-state'), npm_config_cache: join(work, 'npm-cache') });
  const command = (program, commandArgs, cwd, timeout = 120_000) => (dependencies.execFile ?? execFileSync)(program, commandArgs, { cwd, env, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const exists = async path => { try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
  try {
    const compiled = await runtimeFiles(root);
    for (const module of modules) assert.ok(compiled.includes(`dist/${module}.js`), 'Missing helper module: ' + module);
    assert.ok(compiled.includes('dist/shared/tool-matrix.json'), 'Missing tool matrix.');
    for (const path of ['LICENSE', ...compiled]) {
      assert.ok((await lstat(join(root, path))).isFile(), 'Runtime entries must be regular files.');
      await mkdir(dirname(join(stage, path)), { recursive: true });
      await copyFile(join(root, path), join(stage, path));
    }
    // The tarball has no lifecycle scripts, development tools, source, or credentials.
    const runtimePackage = { name: pkg.name, version: pkg.version, private: true, license: pkg.license, type: 'module', description: pkg.description, repository: pkg.repository, engines: pkg.engines, bin: pkg.bin, files: ['dist', 'npm-shrinkwrap.json', 'LICENSE'], dependencies: pkg.dependencies };
    await writeFile(join(stage, 'package.json'), JSON.stringify(runtimePackage, null, 2) + '\n');
    await writeFile(join(stage, 'npm-shrinkwrap.json'), JSON.stringify(lock, null, 2) + '\n');
    const packed = JSON.parse(command('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', work], stage));
    assert.equal(packed.length, 1);
    const artifact = join(work, packed[0].filename);
    for (const { path } of packed[0].files) assert.ok(allowedRuntimePath(path), 'Unexpected runtime package file: ' + path);
    for (const path of ['package.json', 'npm-shrinkwrap.json', 'LICENSE', ...compiled]) assert.ok(packed[0].files.some(file => file.path === path), 'Missing runtime package file: ' + path);
    const entries = command('tar', ['-tzf', artifact], work).trim().split('\n');
    assert.equal(new Set(entries).size, entries.length, 'Duplicate archive entries are forbidden.');
    for (const path of entries) assert.ok(path.startsWith('package/') && allowedRuntimePath(path.slice(8)), 'Unexpected archive entry.');
    await mkdir(clean);
    command('tar', ['-xzf', artifact, '-C', clean], work);
    const installed = join(clean, 'package');
    command('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], installed);
    for (const [path, info] of Object.entries(lock.packages)) if (info.dev === true) assert.equal(await exists(join(installed, path)), false, 'Development dependency in runtime: ' + path);
    assert.equal(command(process.execPath, [join(installed, 'dist/cli.js'), '--version'], installed, 10_000).trim(), pkg.version, 'Clean-installed helper must report the release version.');
    command(process.execPath, [join(installed, 'dist/cli.js'), '--self-test'], installed, 10_000);
    assert.equal(await exists(env.MADDOTS_AI_HOME), false, 'Release checks must not create helper state.');
    const sha256 = createHash('sha256').update(await readFile(artifact)).digest('hex');
    await mkdir(output, { recursive: true });
    const temporary = join(output, `.helper-${process.pid}.tgz`);
    await copyFile(artifact, temporary);
    await rename(temporary, join(output, 'helper.tgz'));
    await writeFile(join(output, 'helper.tgz.sha256'), sha256 + '  helper.tgz\n');
    process.stdout.write(JSON.stringify({ artifact: join(output, 'helper.tgz'), sha256, package: pkg.name, version: pkg.version, files: packed[0].files.length, cleanInstall: 'passed', selfTest: 'passed', npmPublication: false }) + '\n');
  } finally { await rm(work, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareRelease();
