import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

async function fixture() {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'helper-release-fixture-'));
  await mkdir(join(directory, 'scripts'));
  await mkdir(join(directory, 'dist/shared/skill-checks'), { recursive: true });
  await mkdir(join(directory, 'dist/delivery'), { recursive: true });
  for (const script of ['prepare-release.mjs', 'check-package.mjs']) await copyFile(new URL('../scripts/' + script, import.meta.url), join(directory, 'scripts', script));
  const pkg = { name: 'maddots-ai', version: '0.1.0', private: true, license: 'MIT', type: 'module', bin: { 'maddots-ai': 'dist/cli.js' }, repository: { type: 'git', url: 'git+https://github.com/fixture-owner/helper-release.git' }, dependencies: {}, devDependencies: {}, scripts: { install: 'node -e "process.exit(91)"' } };
  await writeFile(join(directory, 'package.json'), JSON.stringify(pkg));
  await writeFile(join(directory, 'package-lock.json'), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': { name: pkg.name, version: pkg.version, dependencies: {}, devDependencies: {} } } }));
  await writeFile(join(directory, 'LICENSE'), 'Synthetic MIT fixture');
  await writeFile(join(directory, '.env'), 'SYNTHETIC_SECRET=fixture-only');
  await writeFile(join(directory, 'private-source.ts'), 'export {};');
  for (const name of ['api', 'backups', 'build-keys', 'config', 'detect', 'imports', 'lock', 'npm', 'pairing', 'paths', 'release-identity', 'runtime', 'safe-fs', 'scan', 'secret-store', 'service', 'stamp', 'state', 'sync', 'token', 'unmanaged', 'updater', 'verify', 'duplicates', 'holding', 'allow', 'notify', 'code-reasons', 'local-edits', 'proposals', 'unmanaged-replacement']) await writeFile(join(directory, 'dist', name + '.js'), 'export {};\n');
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
if (process.argv[2] === '--version') process.stdout.write('0.1.0\\n');
else if (process.argv[2] === '--self-test') process.stdout.write('passed\\n');
else process.exit(92);
`);
  return { directory, pkg };
}
function prepare(directory: string, output = 'release') {
  // Install is a fixture backend operation only. npm pack and the exact-byte CLI
  // smoke tests are real; no npm ci or install subprocess is ever started.
  const code = `import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const {prepareRelease} = await import(${JSON.stringify(pathToFileURL(join(directory, 'scripts/prepare-release.mjs')).href)});
await prepareRelease(['--output', ${JSON.stringify(join(directory, output))}], {execFile(program,args,options) {
  if (program === 'npm' && args[0] === 'ci') {
    assert.deepEqual(args,['ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund']);
    return '';
  }
  return execFileSync(program,args,options);
}});`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: directory, encoding: 'utf8', timeout: 30_000, env: { ...process.env, MADDOTS_AI_TOKEN: 'fixture-only', OTHER_SECRET: 'fixture-only', npm_config_offline: 'true' } });
}

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
    assert.ok(entries.includes('package/dist/scan.js'));
    assert.ok(entries.includes('package/dist/unmanaged-replacement.js'));
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
