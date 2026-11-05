import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

test('package enumeration preserves denied spawns and refuses empty or incomplete npm output', async () => {
  const {packageContents} = await import(new URL('../scripts/check-package.mjs', import.meta.url).href);
  const denied = Object.assign(new Error('spawnSync npm EPERM'), {code: 'EPERM'});
  assert.throws(() => packageContents('/unused', '/unused', () => ({status: 0, stdout: '', stderr: '', error: denied})), error => error === denied);
  assert.throws(() => packageContents('/unused', '/unused', () => ({status: 1, stdout: '', stderr: 'fixture pack failure'})), /fixture pack failure/u);
  assert.throws(() => packageContents('/unused', '/unused', () => ({status: 0, stdout: '', stderr: ''})), /no package JSON/u);
  for (const value of ['[]', '[{}]', '[{"files":[]}]', '[{"files":[]},{"files":[]}]']) {
    assert.throws(() => packageContents('/unused', '/unused', () => ({status: 0, stdout: value, stderr: ''})), /exactly one non-empty package/u);
  }
  const packed = {files: [{path: 'package.json'}]};
  assert.deepEqual(packageContents('/unused', '/unused', () => ({status: 0, stdout: JSON.stringify([packed]), stderr: ''})), packed);
});

test('package import boundary permits only reviewed fixed lazy Linux modules that are present in the artifact', async () => {
  const {checkCompiledImports} = await import(new URL('../scripts/check-package.mjs', import.meta.url).href);
  for (const [file, target, compiled] of [
    ['dist/tool-command.js', './runner/linux-lifecycle.js', 'dist/runner/linux-lifecycle.js'],
    ['dist/runner/storage-owner.js', './linux-containment.js', 'dist/runner/linux-containment.js'],
    ['dist/runner/process.js', './storage-lock.js', 'dist/runner/storage-lock.js'],
  ]) {
    checkCompiledImports(file, `await import('${target}');`, [file, compiled], {});
    assert.throws(() => checkCompiledImports(file, `await import('${target}');`, [file], {}), /Missing reviewed dynamic/u);
    assert.throws(() => checkCompiledImports('dist/config.js', `await import('${target}');`, [file, compiled], {}), /Unreviewed dynamic/u);
    assert.throws(() => checkCompiledImports(file, `const target = '${target}'; await import(target);`, [file, compiled], {}), /Unreviewed dynamic/u);
  }
  assert.throws(() => checkCompiledImports('dist/runner/storage-owner.js', "await import('../../server/db.js');", [], {}), /Unreviewed dynamic/u);
  assert.throws(() => checkCompiledImports('dist/runner/storage-owner.js', "require('./linux-containment.js');", [], {}), /Unreviewed dynamic/u);
});

test('journal bootstrap storage dependencies are allowed and required in the runtime package', async () => {
  const {allowedRuntimePath, checkCompiledImports, checkRequiredRunnerRuntime, linuxTrustedRuntime, acceptanceRuntime} =
    await import(new URL('../scripts/check-package.mjs', import.meta.url).href);
  const compiled = [...linuxTrustedRuntime, ...acceptanceRuntime];
  for (const name of ['journal', 'journal-bootstrap', 'storage-creation', 'storage-lock', 'storage-owner']) {
    for (const extension of ['js', 'd.ts']) assert.equal(allowedRuntimePath(`dist/runner/${name}.${extension}`), true, name);
    const path = `dist/runner/${name}.js`;
    assert.ok(compiled.includes(path), path);
    assert.throws(() => checkRequiredRunnerRuntime(compiled.filter(entry => entry !== path)),
      {message: 'Missing required runner runtime: ' + path});
  }
  checkRequiredRunnerRuntime(compiled);
  for (const file of ['state', 'storage-lock']) {
    const source = `import {createPinnedStorageEntry} from './storage-creation.js';`;
    checkCompiledImports(`dist/runner/${file}.js`, source, compiled, {});
    assert.throws(() => checkCompiledImports(`dist/runner/${file}.js`, source,
      compiled.filter(path => path !== 'dist/runner/storage-creation.js'), {}), /Unreviewed compiled helper import/u);
  }
});

test('package manifest accepts Linux candidate versions only with explicit attest-only mode', async () => {
  const {checkManifest} = await import(new URL('../scripts/check-package.mjs', import.meta.url).href);
  const pkg = {name: 'maddots-ai', private: true, license: 'MIT', bin: {'maddots-ai': 'dist/cli.js'},
    repository: {url: 'git+https://github.com/fixture-owner/helper-release.git'}};
  for (const options of [undefined, {attestOnly: false}, {attestOnly: true}]) checkManifest({...pkg, version: '0.1.6'}, options);
  for (const version of ['0.1.6-linux.s5.7.1', '0.1.6-linux.rc-1']) {
    checkManifest({...pkg, version}, {attestOnly: true});
    assert.throws(() => checkManifest({...pkg, version}), /Only attest-only mode/u);
    assert.throws(() => checkManifest({...pkg, version}, {attestOnly: false}), /Only attest-only mode/u);
  }
  for (const version of ['0.1.6-linux', '0.1.6-linux.', '0.1.6-linux..s5', '0.1.6-linux.s5.', '0.1.6-rc.1', '0.1.6-macos.s5.7.1', '0.1.6+linux.s5', '0.1.6-linux.s5+build']) {
    assert.throws(() => checkManifest({...pkg, version}, {attestOnly: true}), /Only attest-only mode/u);
  }
});

async function fixture(version = '0.1.0') {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'helper-release-fixture-'));
  await mkdir(join(directory, 'scripts'));
  await mkdir(join(directory, 'dist/shared/skill-checks'), { recursive: true });
  await mkdir(join(directory, 'dist/delivery'), { recursive: true });
  for (const script of ['prepare-release.mjs', 'check-package.mjs']) await copyFile(new URL('../scripts/' + script, import.meta.url), join(directory, 'scripts', script));
  const pkg = { name: 'maddots-ai', version, private: true, license: 'MIT', type: 'module', bin: { 'maddots-ai': 'dist/cli.js' }, repository: { type: 'git', url: 'git+https://github.com/fixture-owner/helper-release.git' }, dependencies: {}, devDependencies: {}, files: ['dist', 'LICENSE'], scripts: { install: 'node -e "process.exit(91)"' } };
  await writeFile(join(directory, 'package.json'), JSON.stringify(pkg));
  await writeFile(join(directory, 'package-lock.json'), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': { name: pkg.name, version: pkg.version, dependencies: {}, devDependencies: {} } } }));
  await writeFile(join(directory, 'LICENSE'), 'Synthetic MIT fixture');
  await writeFile(join(directory, '.env'), 'SYNTHETIC_SECRET=fixture-only');
  await writeFile(join(directory, 'private-source.ts'), 'export {};');
  const {modules, linuxTrustedRuntime, acceptanceRuntime} = await import(new URL('../scripts/check-package.mjs', import.meta.url).href);
  for (const name of modules) await writeFile(join(directory, 'dist', name + '.js'), 'export {};\n');
  await mkdir(join(directory, 'dist/runner'));
  for (const path of [...linuxTrustedRuntime, ...acceptanceRuntime]) await writeFile(join(directory, path), 'export {};\n');
  await writeFile(join(directory, 'dist/shared/skill-folder-names.js'), 'export {};\n');
  for (const extension of ['js', 'd.ts']) await writeFile(join(directory, 'dist/delivery/index.' + extension), 'export {};\n');
  for (const extension of ['js', 'd.ts']) await writeFile(join(directory, 'dist/shared/skill-checks/secret-rules.' + extension), 'export {};\n');
  await writeFile(join(directory, 'dist/shared/tool-matrix.json'), '{}');
  await writeFile(join(directory, 'dist/cli.js'), `import assert from 'node:assert/strict';
import {realpathSync} from 'node:fs';
import {dirname} from 'node:path';
assert.equal(process.env.MADDOTS_AI_AUTO_UPDATE, '0');
assert.equal(process.env.MADDOTS_AI_TOKEN, undefined);
assert.equal(process.env.OTHER_SECRET, undefined);
assert.equal(realpathSync(dirname(process.env.MADDOTS_AI_HOME)), dirname(process.env.MADDOTS_AI_HOME));
if (process.argv[2] === '--version') process.stdout.write(${JSON.stringify(version + '\n')});
else if (process.argv[2] === '--self-test') process.stdout.write('passed\\n');
else process.exit(92);
`);
  return { directory, pkg };
}
function prepare(directory: string, output = 'release', flags: string[] = []) {
  // Install is a fixture backend operation only. npm pack and the exact-byte CLI
  // smoke tests are real; no npm ci or install subprocess is ever started.
  const code = `import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const {prepareRelease} = await import(${JSON.stringify(pathToFileURL(join(directory, 'scripts/prepare-release.mjs')).href)});
await prepareRelease(${JSON.stringify([...flags, '--output', join(directory, output)])}, {execFile(program,args,options) {
  if (program === 'npm' && args[0] === 'ci') {
    assert.deepEqual(args,['ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund']);
    return '';
  }
  return execFileSync(program,args,options);
}});`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: directory, encoding: 'utf8', timeout: 30_000, env: { ...process.env, MADDOTS_AI_TOKEN: 'fixture-only', OTHER_SECRET: 'fixture-only', npm_config_offline: 'true' } });
}

test('candidate package check and exact-byte preparation require attest-only and retain all package and lock versions', async () => {
  const version = '0.1.6-linux.s5.7.1';
  const f = await fixture(version);
  const check = (...flags: string[]) => spawnSync(process.execPath, [join(f.directory, 'scripts/check-package.mjs'), ...flags],
    {cwd: f.directory, encoding: 'utf8', timeout: 30_000, env: {...process.env, npm_config_offline: 'true'}});
  try {
    assert.match(check().stderr, /Only attest-only mode/u);
    const checked = check('--attest-only');
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    assert.equal(JSON.parse(checked.stdout).boundary, 'passed');
    assert.match(prepare(f.directory).stderr, /Only attest-only mode/u);
    const prepared = prepare(f.directory, 'candidate', ['--attest-only']);
    assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
    assert.equal(JSON.parse(prepared.stdout).version, version);
    const artifact = join(f.directory, 'candidate/helper.tgz');
    const packed = JSON.parse(execFileSync('tar', ['-xOzf', artifact, 'package/package.json'], {encoding: 'utf8'}));
    const lock = JSON.parse(execFileSync('tar', ['-xOzf', artifact, 'package/npm-shrinkwrap.json'], {encoding: 'utf8'}));
    assert.equal(packed.version, version);
    assert.equal(lock.version, version);
    assert.equal(lock.packages[''].version, version);
    for (const flags of [['--release'], ['--attest-only', '--attest-only']]) {
      assert.match(check(...flags).stderr, /Usage:/u);
      assert.match(prepare(f.directory, 'invalid', flags).stderr, /Usage:/u);
    }
    for (const mismatch of ['version', 'root']) {
      const changed = structuredClone(lock);
      if (mismatch === 'version') changed.version = '0.1.6';
      else changed.packages[''].version = '0.1.6';
      await writeFile(join(f.directory, 'package-lock.json'), JSON.stringify(changed));
      const rejected = prepare(f.directory, 'mismatch', ['--attest-only']);
      assert.notEqual(rejected.status, 0, 'Candidate preparation must reject mismatched lock versions.');
    }
  } finally { await rm(f.directory, {recursive: true, force: true}); }
});

test('release preparation packs only runtime bytes reproducibly and exercises them through a fixture install backend', async () => {
  const f = await fixture();
  try {
    const first = prepare(f.directory, 'one');
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const result = JSON.parse(first.stdout);
    assert.equal(result.cleanInstall, 'passed');
    assert.equal(result.selfTest, 'passed');
    const artifact = join(f.directory, 'one/helper.tgz');
    const entries = execFileSync('tar', ['-tzf', artifact], { encoding: 'utf8' }).trim().split('\n');
    assert.ok(entries.includes('package/npm-shrinkwrap.json'));
    assert.ok(entries.includes('package/dist/cli.js'));
    assert.ok(entries.includes('package/dist/platform.js'));
    assert.ok(entries.includes('package/dist/agent-fence.js'));
    assert.ok(entries.includes('package/dist/runner/linux-containment.js'));
    assert.ok(entries.includes('package/dist/runner/linux-guardian.js'));
    assert.ok(entries.includes('package/dist/runner/linux-lifecycle.js'));
    assert.ok(entries.includes('package/dist/runner/journal-bootstrap.js'));
    assert.ok(entries.includes('package/dist/runner/storage-creation.js'));
    assert.ok(entries.includes('package/dist/git-repository.js'));
    assert.ok(entries.includes('package/dist/scan.js'));
    assert.ok(entries.includes('package/dist/unmanaged-replacement.js'));
    assert.ok(entries.includes('package/dist/linked-homes.js'));
    assert.ok(entries.includes('package/dist/shared/skill-folder-names.js'));
    assert.ok(entries.includes('package/dist/shared/skill-checks/secret-rules.js'));
    assert.ok(entries.includes('package/dist/shared/skill-checks/secret-rules.d.ts'));
    assert.ok(!entries.some(path => /private-source|\.env|node_modules|scripts|package-lock/.test(path)));
    const pkg = JSON.parse(execFileSync('tar', ['-xOzf', artifact, 'package/package.json'], { encoding: 'utf8' }));
    assert.equal(pkg.scripts, undefined);
    assert.equal(pkg.devDependencies, undefined);
    assert.equal(pkg.private, true);
    const second = prepare(f.directory, 'two');
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.equal(JSON.parse(second.stdout).sha256, result.sha256);
    assert.deepEqual(await readFile(artifact), await readFile(join(f.directory, 'two/helper.tgz')));
    assert.equal(await readFile(join(f.directory, 'one/helper.tgz.sha256'), 'utf8'), result.sha256 + '  helper.tgz\n');
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('release preparation rejects symlinks, extra compiled files, unsafe locks and publishable packages', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, 'dist/private.js'), 'export {};');
    assert.match(prepare(f.directory).stderr, /Unexpected compiled helper file/);
    await rm(join(f.directory, 'dist/private.js'));
    for (const name of ['index.js', 'secret-rules.ts', 'secret-rules.json']) {
      const path = join(f.directory, 'dist/shared/skill-checks', name);
      await writeFile(path, 'export {};');
      assert.match(prepare(f.directory).stderr, /Unexpected compiled helper file/);
      await rm(path);
    }
    const extraDirectory = join(f.directory, 'dist/shared/skill-checks/private');
    await mkdir(extraDirectory);
    assert.match(prepare(f.directory).stderr, /Unexpected compiled helper folder/);
    await rm(extraDirectory, { recursive: true });
    await symlink(join(f.directory, 'dist/config.js'), join(f.directory, 'dist/alias.js'));
    assert.match(prepare(f.directory).stderr, /must not be symlinks/);
    await rm(join(f.directory, 'dist/alias.js'));
    const lockPath = join(f.directory, 'package-lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    lock.packages['node_modules/fixture'] = { resolved: 'https://untrusted.test/fixture.tgz', integrity: 'sha512-Zml4dHVyZQ==' };
    await writeFile(lockPath, JSON.stringify(lock));
    assert.match(prepare(f.directory).stderr, /reviewed registry lock/);
    await writeFile(join(f.directory, 'package.json'), JSON.stringify({ ...f.pkg, private: false }));
    assert.match(prepare(f.directory).stderr, /npm publication must remain disabled/);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
