import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { readConfig } from '../src/config.js';
import { assertSecretPath, atomicWrite, createPaths, createRecoveryPaths, ensurePaths, readPrivateFile } from '../src/paths.js';
import { helperOs, helperPlatform } from '../src/platform.js';
import { validateAgentFolder } from '../src/runner/agents-local.js';
import { assertUnmanagedTarget, resolveToolFolder } from '../src/unmanaged.js';

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mdai-linux-paths-'))), home = join(root, 'home');
  await mkdir(home, {mode: 0o700});
  t.after(() => rm(root, {recursive: true, force: true}));
  return {root, home};
}

test('platform selection names Darwin and Linux explicitly and refuses other systems', () => {
  assert.equal(helperPlatform('darwin'), 'darwin'); assert.equal(helperOs('darwin'), 'macos');
  assert.equal(helperPlatform('linux'), 'linux'); assert.equal(helperOs('linux'), 'linux');
  for (const platform of ['win32', 'freebsd', 'aix'] as const) {
    assert.throws(() => helperPlatform(platform), {code: 'PLATFORM_UNSUPPORTED'});
    assert.throws(() => readConfig({}, '/unused/home', platform), {code: 'PLATFORM_UNSUPPORTED'});
  }
});

test('Linux defaults separate XDG credentials, data, state and runtime while retaining diagnostic logs', async t => {
  const {home} = await fixture(t), config = readConfig({}, home, 'linux'), paths = await createPaths(config);
  assert.equal(config.platform, 'linux'); assert.equal(paths.platform, 'linux');
  assert.equal(paths.config, join(home, '.config/maddots-ai'));
  assert.equal(paths.data, join(home, '.local/share/maddots-ai'));
  assert.equal(paths.stateDir, join(home, '.local/state/maddots-ai'));
  assert.equal(paths.state, join(paths.stateDir!, 'state.json'));
  assert.equal(paths.serviceHeartbeat, join(paths.stateDir!, 'service-heartbeat.json'));
  assert.equal(paths.runtime, join(paths.stateDir!, 'runtime'));
  assert.equal(paths.logs, join(paths.data, 'logs'));
  assert.equal(paths.serviceUnit, join(home, '.config/systemd/user/app.maddots.ai.helper.service'));
  assert.equal(paths.servicePlist, paths.serviceUnit);
  await ensurePaths(paths);
  for (const path of [paths.config!, paths.data, paths.stateDir!, paths.runtime!, paths.logs, paths.holding, paths.backups]) {
    assert.equal((await lstat(path)).mode & 0o777, 0o700, path);
  }
});

test('Linux honors absolute XDG overrides and keeps a data override independent from credentials', async t => {
  const {root, home} = await fixture(t);
  const env = {XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'), XDG_RUNTIME_DIR: join(root, 'runtime'), MADDOTS_AI_HOME: join(root, 'private-data')};
  const paths = await createPaths(readConfig(env, home, 'linux'));
  assert.equal(paths.config, join(root, 'config/maddots-ai')); assert.equal(paths.data, env.MADDOTS_AI_HOME);
  assert.equal(paths.stateDir, join(root, 'state/maddots-ai')); assert.equal(paths.runtime, join(root, 'runtime/mdai'));
  assert.equal(paths.serviceUnit, join(root, 'config/systemd/user/app.maddots.ai.helper.service'));
  assert.deepEqual(paths.linuxStorage, {
    roots: [paths.data, paths.config!, paths.stateDir!, paths.runtime!, join(paths.stateDir!, 'runtime'),
      join(root, 'data/maddots-ai'), join(home, '.local/share/maddots-ai'), join(home, '.config/maddots-ai'),
      join(home, '.local/state/maddots-ai'), join(home, '.local/state/maddots-ai/runtime'),
      join(home, 'Library/Application Support/maddots-ai'), `/run/user/${process.getuid?.()}/mdai`].sort(),
    states: [paths.state, join(paths.data, 'state.json'), join(root, 'data/maddots-ai/state.json'),
      join(home, '.local/share/maddots-ai/state.json'), join(home, '.local/state/maddots-ai/state.json'),
      join(home, 'Library/Application Support/maddots-ai/state.json')].sort(),
  }, 'registration retains hidden XDG data, defaults and fallback runtime without creating them');
  for (const candidate of paths.linuxStorage!.roots.filter(path => !path.startsWith('/run/'))) {
    await assert.rejects(lstat(candidate), {code: 'ENOENT'});
  }
  for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'MADDOTS_AI_HOME']) {
    assert.throws(() => readConfig({[key]: 'relative'}, home, 'linux'), {code: 'CONFIG_INVALID'}, key);
  }
});

test('Linux reopens an installed service unit while still rejecting linked units and Git work trees', async t => {
  const {home} = await fixture(t), config = readConfig({}, home, 'linux'), paths = await createPaths(config);
  const directory = dirname(paths.serviceUnit!);
  await mkdir(directory, {recursive: true, mode: 0o700});
  await writeFile(paths.serviceUnit!, '[Service]\nExecStart=/fixture/helper\n', {mode: 0o600});
  assert.deepEqual(await createPaths(config), paths);
  const original = await readFile(paths.serviceUnit!, 'utf8');
  await mkdir(join(directory, '.git/objects'), {recursive: true});
  await mkdir(join(directory, '.git/refs'));
  await writeFile(join(directory, '.git/HEAD'), 'ref: refs/heads/main\n');
  await assert.rejects(createPaths(config), {code: 'PATH_UNSAFE'});
  assert.equal(await readFile(paths.serviceUnit!, 'utf8'), original);
  await rm(join(directory, '.git'), {recursive: true});
  await rm(paths.serviceUnit!);
  const target = join(home, 'outside.service');
  await writeFile(target, original);
  await symlink(target, paths.serviceUnit!);
  await assert.rejects(createPaths(config), {code: 'PATH_UNSAFE'});
  assert.equal(await readFile(target, 'utf8'), original);
});

test('Linux recovery accepts only the fixed user-unit null mask and retains all other path checks', async t => {
  const {home} = await fixture(t), config = readConfig({}, home, 'linux'), paths = await createPaths(config);
  const unit = paths.serviceUnit!, directory = dirname(unit);
  await mkdir(directory, {recursive: true, mode: 0o700});
  await symlink('/dev/null', unit);
  assert.deepEqual(await createRecoveryPaths(config), paths);
  await assert.rejects(createPaths(config), {code: 'PATH_UNSAFE'}, 'ordinary commands cannot use the recovery exception');
  await rm(unit);
  for (const target of ['/dev/zero', '/dev/../dev/null', join(home, 'missing.service')]) {
    await symlink(target, unit);
    await assert.rejects(createRecoveryPaths(config), {code: 'PATH_UNSAFE'}, target);
    await rm(unit);
  }
  const alias = join(home, 'null-alias'); await symlink('/dev/null', alias); await symlink(alias, unit);
  await assert.rejects(createRecoveryPaths(config), {code: 'PATH_UNSAFE'}, 'indirect masks are not the fixed mask');
  await rm(unit);
  await rmdir(directory);
  const other = join(home, 'other-units'); await mkdir(other); await symlink('/dev/null', join(other, 'app.maddots.ai.helper.service'));
  await symlink(other, directory);
  await assert.rejects(createRecoveryPaths(config), {code: 'PATH_UNSAFE'}, 'the unit parent cannot be linked');
  await rm(directory); await mkdir(directory); await symlink('/dev/null', unit);
  await mkdir(dirname(paths.stateDir!), {recursive: true}); await symlink('/dev/null', paths.stateDir!);
  await assert.rejects(createRecoveryPaths(config), {code: 'PATH_UNSAFE'}, 'private roots cannot use the mask exception');
  await rm(paths.stateDir!);
  const overridden = join(home, 'custom-config');
  const customUnit = join(overridden, 'systemd/user/app.maddots.ai.helper.service');
  await mkdir(dirname(customUnit), {recursive: true}); await symlink('/dev/null', customUnit);
  await assert.rejects(createRecoveryPaths(readConfig({XDG_CONFIG_HOME: overridden}, home, 'linux')), {code: 'PATH_UNSAFE'},
    'a mask outside the fixed recovery entrypoint is not accepted');
});

test('Darwin paths retain Library storage and ignore Linux XDG settings', async t => {
  const {home} = await fixture(t);
  const paths = await createPaths(readConfig({XDG_CONFIG_HOME: 'relative', XDG_DATA_HOME: 'relative'}, home, 'darwin'));
  assert.equal(paths.data, join(home, 'Library/Application Support/maddots-ai'));
  assert.equal(paths.state, join(paths.data, 'state.json')); assert.equal(paths.logs, join(paths.data, 'logs'));
  assert.equal(paths.servicePlist, join(home, 'Library/LaunchAgents/app.maddots.ai.helper.plist'));
  const library = join(home, 'Library/project'); await mkdir(library, {recursive: true});
  await assert.rejects(validateAgentFolder(paths, library), {code: 'FOLDER_UNSAFE'});
});

test('Linux rejects overlapping private storage, tool homes and linked XDG components', async t => {
  const {root, home} = await fixture(t);
  const cases = [{XDG_CONFIG_HOME: join(home, '.local/share')}, {XDG_STATE_HOME: join(home, '.local/share')},
    {XDG_RUNTIME_DIR: join(home, '.local/share/maddots-ai')}, {XDG_CONFIG_HOME: join(home, '.codex-other/config')},
    {XDG_STATE_HOME: join(home, '.config/opencode/state')}, {XDG_RUNTIME_DIR: join(home, '.claude/runtime')},
    {XDG_DATA_HOME: join(home, '.dsh/data')}, {MADDOTS_AI_HOME: join(home, '.config/systemd/user')}];
  for (const env of cases) await assert.rejects(createPaths(readConfig(env, home, 'linux')), {code: 'PATH_UNSAFE'}, JSON.stringify(env));
  const target = join(root, 'target'); await mkdir(target); await symlink(target, join(home, 'linked'));
  await assert.rejects(createPaths(readConfig({XDG_CONFIG_HOME: join(home, 'linked')}, home, 'linux')), {code: 'PATH_UNSAFE'});
  const vendor = join(root, 'vendor'); await mkdir(vendor); await symlink(vendor, join(home, '.codex-work'));
  await assert.rejects(createPaths(readConfig({XDG_CONFIG_HOME: join(vendor, 'config')}, home, 'linux')), /physical targets of tool homes/);
  const repository = join(root, 'repository');
  await mkdir(join(repository, '.git/objects'), {recursive: true}); await mkdir(join(repository, '.git/refs'));
  await writeFile(join(repository, '.git/HEAD'), 'ref: refs/heads/main\n');
  await assert.rejects(createPaths(readConfig({XDG_STATE_HOME: repository}, home, 'linux')), /Git work tree/);
});

test('Linux protects private storage and physical aliases without excluding ordinary Library projects', async t => {
  const {home} = await fixture(t), paths = await createPaths(readConfig({}, home, 'linux')); await ensurePaths(paths);
  const routes = join(home, '.agents/skills'); await mkdir(routes, {recursive: true});
  const protectedRoots = [paths.data, paths.config!, paths.stateDir!, paths.runtime!, dirname(paths.serviceUnit!)];
  for (const [index, root] of protectedRoots.entries()) {
    await mkdir(root, {recursive: true, mode: 0o700});
    const alias = join(home, `private-alias-${index}`); await symlink(root, alias);
    await assert.rejects(validateAgentFolder(paths, root), {code: 'FOLDER_UNSAFE'});
    await assert.rejects(validateAgentFolder(paths, alias), {code: 'FOLDER_UNSAFE'});
    await assert.rejects(assertUnmanagedTarget(paths, join(root, 'imported-skill')), {code: 'PATH_UNSAFE'});
    await symlink(root, join(routes, `private-${index}`));
    await assert.rejects(resolveToolFolder(paths, {home: '.agents', folderName: `private-${index}`}), {code: 'PATH_UNSAFE'});
  }
  await assert.rejects(validateAgentFolder(paths, join(home, '.config')), {code: 'FOLDER_UNSAFE'});
  const project = join(home, 'Library/project'); await mkdir(project, {recursive: true});
  assert.equal(await validateAgentFolder(paths, project), project);
  await assert.doesNotReject(assertUnmanagedTarget(paths, join(project, 'ordinary-skill')));
});

test('Linux credential file alone is allowed inside private config and refuses linked files', async t => {
  const {home} = await fixture(t), paths = await createPaths(readConfig({}, home, 'linux')); await ensurePaths(paths);
  const credential = join(paths.config!, 'credentials.json');
  await assert.doesNotReject(assertSecretPath(credential, paths));
  for (const path of [join(paths.config!, 'other.json'), join(paths.data, 'token.json'), join(paths.stateDir!, 'token.json'),
    join(paths.runtime!, 'token.json'), paths.serviceUnit!]) await assert.rejects(assertSecretPath(path, paths), {code: 'FILE_UNSAFE'});
  await atomicWrite(credential, 'fixture-value'); assert.equal(await readPrivateFile(credential), 'fixture-value');
  assert.equal((await lstat(credential)).mode & 0o777, 0o600);
  await link(credential, join(paths.config!, 'hard-link'));
  await assert.rejects(readPrivateFile(credential, 1024, {singleLink: true}), {code: 'FILE_UNSAFE'});
  await assert.rejects(atomicWrite(credential, 'replacement', {singleLink: true}), {code: 'FILE_UNSAFE'});
  assert.equal(await readFile(credential, 'utf8'), 'fixture-value');
  await rm(join(paths.config!, 'hard-link')); await chmod(credential, 0o644);
  await assert.rejects(readPrivateFile(credential), {code: 'FILE_UNSAFE'});
});

test('Linux protects the selected custom credential directory and refuses credentials in repositories', async t => {
  const {root, home} = await fixture(t), paths = await createPaths(readConfig({}, home, 'linux')); await ensurePaths(paths);
  const directory = join(home, 'private-credentials'), credential = join(directory, 'custom.json');
  await mkdir(directory, {mode: 0o700}); await assert.doesNotReject(assertSecretPath(credential, paths));
  paths.credentialFile = credential;
  await assert.doesNotReject(assertSecretPath(credential, paths));
  await assert.rejects(assertSecretPath(join(directory, 'other.json'), paths), {code: 'FILE_UNSAFE'});
  await assert.rejects(validateAgentFolder(paths, directory), {code: 'FOLDER_UNSAFE'});
  await assert.rejects(assertUnmanagedTarget(paths, join(directory, 'skill')), {code: 'PATH_UNSAFE'});
  const repository = join(root, 'repository');
  await mkdir(join(repository, '.git/objects'), {recursive: true}); await mkdir(join(repository, '.git/refs'));
  await writeFile(join(repository, '.git/HEAD'), 'ref: refs/heads/main\n');
  await assert.rejects(assertSecretPath(join(repository, 'credential.json'), paths), {code: 'FILE_UNSAFE'});
});
