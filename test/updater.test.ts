// Fixture backends exercise trust policy and activation without hosted signing or real installs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setImmediate as immediate } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import * as tar from 'tar';
import fetch from 'make-fetch-happen';
import { HelperError, readConfig, type Timing } from '../src/config.js';
import { createPaths, withWriteLock } from '../src/paths.js';
import { discoverNpm, installEnvironment, packageInfrastructure, PACKAGE_TIMEOUT_MS, type PackageInfrastructure } from '../src/npm.js';
import { RELEASE_IDENTITY, type ReleaseIdentity } from '../src/release-identity.js';
import { checkForUpdate, downloadRelease, prepareArchive, releaseFromStatement, rollbackRelease, selectRelease, startUpdateChecks,
  UPDATE_CHECK_INTERVAL_MS, updateDirectory, verifyArtifactDigest, verifyReleaseBundle, type UpdateBackend, type UpdateOptions } from '../src/updater.js';

const source: Readonly<ReleaseIdentity> = { repository: 'fixture/helper', workflowPath: '.github/workflows/helper-release.yml',
  allowedSigner: 'fixture-only signer', releasePrefix: 'helper-', assetName: 'helper.tgz' };
const digest = createHash('sha256').update('fixture artifact').digest('hex');
const commitA = 'a'.repeat(40), commitB = 'b'.repeat(40), commitC = 'c'.repeat(40);
async function fixture(t: TestContext) {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'maddots-updater-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = await createPaths(readConfig({}, home));
  const bundledRoot = join(home, 'bootstrap'); await mkdir(bundledRoot, { mode: 0o700 });
  let now = Date.parse('2026-10-14T00:00:00Z');
  const timing: Timing = { now: () => now, sleep: async () => { await immediate(); } };
  const options: UpdateOptions = { paths, bundledRoot, version: '0.5.0', env: {}, timing };
  return { options, home, advance: (ms: number) => { now += ms; } };
}
function candidate(version: string) { return { name: 'maddots-ai', private: true, version, bin: { 'maddots-ai': 'dist/cli.js' } }; }
function backend(commit = commitA, version = '0.6.0', hooks: Partial<UpdateBackend> = {}): UpdateBackend {
  return { identity: source, latest: async () => ({ commit, sha256: digest }), async prepare(_release, target) {
    await mkdir(join(target, 'dist'), { mode: 0o700 });
    await writeFile(join(target, '.artifact.tgz'), 'fixture artifact', { mode: 0o600 });
    await writeFile(join(target, 'package.json'), JSON.stringify(candidate(version)), { mode: 0o600 });
    await writeFile(join(target, 'dist/cli.js'), '// synthetic fixture, never executed', { mode: 0o600 });
  }, validate: async () => {}, ...hooks };
}
function statement() {
  return { _type: 'https://in-toto.io/Statement/v1', predicateType: 'https://slsa.dev/provenance/v1', subject: [{ name: source.assetName as string, digest: { sha256: digest } }],
    predicate: { buildDefinition: { buildType: 'https://actions.github.io/buildtypes/workflow/v1', externalParameters: { workflow: {
      repository: 'https://github.com/' + source.repository, ref: 'refs/heads/main', path: source.workflowPath,
    } }, resolvedDependencies: [{ uri: 'git+https://github.com/' + source.repository + '@refs/heads/main', digest: { gitCommit: commitA } }] } } };
}
function signedFixture() {
  return { verificationMaterial: { certificate: { rawBytes: 'synthetic certificate' } }, dsseEnvelope: {
    payloadType: 'application/vnd.in-toto+json', payload: Buffer.from(JSON.stringify(statement())).toString('base64'), signatures: [{ sig: 'synthetic signature' }],
  } };
}

test('source checkout has no live default channel and fails closed before npm or network', async t => {
  const { options } = await fixture(t);
  if (RELEASE_IDENTITY === null) assert.equal((await checkForUpdate(options)).reason, 'RELEASE_UNCONFIGURED');
  assert.equal((await selectRelease(options)).root, options.bundledRoot);
});
test('provenance pins one artifact, exact repository, workflow, main branch and immutable source commit', () => {
  assert.deepEqual(releaseFromStatement(source, statement()), { commit: commitA, sha256: digest });
  const changes: ((value: ReturnType<typeof statement>) => void)[] = [
    value => { value.predicate.buildDefinition.externalParameters.workflow.repository = 'https://github.com/other/repo'; },
    value => { value.predicate.buildDefinition.externalParameters.workflow.path = '.github/workflows/other.yml'; },
    value => { value.predicate.buildDefinition.externalParameters.workflow.ref = 'refs/pull/4/merge'; },
    value => { value.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = 'main'; },
    value => { value.predicate.buildDefinition.resolvedDependencies.push(value.predicate.buildDefinition.resolvedDependencies[0]); },
    value => { value.subject[0].name = 'other.tgz'; }, value => { value.subject.push(value.subject[0]); },
    value => { value.subject[0].digest.sha256 = 'not-a-digest'; },
  ];
  for (const change of changes) { const value = statement(); change(value); assert.throws(() => releaseFromStatement(source, value), /INVALID_PROVENANCE/); }
});
test('unsigned bundles fail before verification and verifier enforces pinned certificate issuer and exact identity', async () => {
  let called = false;
  await assert.rejects(verifyReleaseBundle(source, { dsseEnvelope: signedFixture().dsseEnvelope }, undefined, async () => { called = true; }), /INVALID_PROVENANCE/);
  assert.equal(called, false);
  const result = await verifyReleaseBundle(source, signedFixture(), '/fixture/cache', async (_bundle, options) => {
    called = true; assert.equal(options?.certificateIssuer, 'https://token.actions.githubusercontent.com');
    const expression = new RegExp(options?.certificateIdentityURI as string);
    assert.ok(expression.test('https://github.com/fixture/helper/.github/workflows/helper-release.yml@refs/heads/main'));
    for (const wrong of ['https://github.com/other/helper/.github/workflows/helper-release.yml@refs/heads/main',
      'https://github.com/fixture/helper/.github/workflows/evil.yml@refs/heads/main',
      'https://github.com/fixture/helper/.github/workflows/helper-release.yml@refs/pull/3/merge']) assert.equal(expression.test(wrong), false);
    assert.equal(options?.ctLogThreshold, 1); assert.equal(options?.tlogThreshold, 1);
  });
  assert.ok(called); assert.deepEqual(result, { commit: commitA, sha256: digest });
  await assert.rejects(verifyReleaseBundle(source, signedFixture(), undefined, async () => { throw new Error('wrong certificate identity with credential-canary'); }), error => error instanceof HelperError && error.code === 'INVALID_PROVENANCE');
});
test('digest mismatch and mutation of an immutable cached source release are rejected', async t => {
  verifyArtifactDigest(Buffer.from('fixture artifact'), digest);
  assert.throws(() => verifyArtifactDigest(Buffer.from('modified'), digest), /INVALID_CHECKSUM/);
  const { options } = await fixture(t);
  await checkForUpdate(options, backend());
  const result = await checkForUpdate({ ...options, force: true }, backend(commitA, '0.6.0', { latest: async () => ({ commit: commitA, sha256: 'f'.repeat(64) }) }));
  assert.equal(result.reason, 'INVALID_CHECKSUM'); assert.equal((await selectRelease(options, source)).commit, commitA);
});
test('local fixture update preserves bootstrap and credentials, then rolls back to previous or bundled runtime', async t => {
  const { options } = await fixture(t);
  await mkdir(options.paths.data, { recursive: true, mode: 0o700 });
  await writeFile(options.paths.state, 'saved credential state', { mode: 0o600 });
  await writeFile(join(options.bundledRoot, 'package.json'), 'bundled package', { mode: 0o600 });
  assert.deepEqual(await checkForUpdate(options, backend()), { status: 'prepared', commit: commitA, version: '0.6.0' });
  assert.equal((await selectRelease(options, source)).commit, commitA);
  assert.equal((await checkForUpdate({ ...options, force: true }, backend(commitB, '0.7.0'))).status, 'prepared');
  assert.equal((await rollbackRelease({ ...options, runningVersion: '0.7.0' }, undefined, source)).status, 'rolled-back');
  assert.equal((await selectRelease(options, source)).commit, commitA);
  assert.equal((await checkForUpdate(options, backend(commitB, '0.7.0'))).reason, 'RELEASE_ROLLED_BACK');
  assert.equal((await rollbackRelease(options, undefined, source)).status, 'rolled-back');
  assert.equal((await selectRelease(options, source)).root, options.bundledRoot);
  assert.equal(await readFile(options.paths.state, 'utf8'), 'saved credential state');
  assert.equal(await readFile(join(options.bundledRoot, 'package.json'), 'utf8'), 'bundled package');
});
test('downgrades below either selected or running versions are refused, including cached candidates', async t => {
  const { options } = await fixture(t); await checkForUpdate(options, backend());
  for (const version of ['0.4.0', '0.5.5']) assert.equal((await checkForUpdate({ ...options, force: true }, backend(commitB, version))).reason, 'DOWNGRADE_REFUSED');
  assert.equal((await checkForUpdate({ ...options, runningVersion: '0.8.0', force: true }, backend(commitB, '0.7.0'))).reason, 'DOWNGRADE_REFUSED');
  await checkForUpdate({ ...options, force: true }, backend(commitB, '0.7.0'));
  assert.equal((await checkForUpdate({ ...options, force: true }, backend())).reason, 'DOWNGRADE_REFUSED');
  assert.equal((await selectRelease(options, source)).commit, commitB);
});
test('unsigned, failed network, bad install and failed candidate leave working runtime intact with redacted errors', async t => {
  const { options } = await fixture(t); await checkForUpdate(options, backend());
  for (const phase of ['latest', 'prepare', 'validate'] as const) {
    const result = await checkForUpdate({ ...options, force: true }, backend(commitB, '0.7.0', { [phase]: async () => { throw new Error('https://credential-canary@example.test'); } }));
    assert.equal(result.status, 'failed'); assert.doesNotMatch(JSON.stringify(result), /credential-canary/);
    assert.equal((await selectRelease(options, source)).commit, commitA);
  }
  assert.equal((await checkForUpdate({ ...options, force: true }, backend(commitB, '0.7.0', { latest: async () => { throw new HelperError('INVALID_PROVENANCE', 'unsigned'); } }))).reason, 'INVALID_PROVENANCE');
});
test('one hour cooldown persists across calls, disabled automatic checks allow explicit manual updates', async t => {
  const { options, advance } = await fixture(t); await checkForUpdate(options, backend());
  advance(UPDATE_CHECK_INTERVAL_MS - 1); assert.equal((await checkForUpdate(options, backend(commitB, '0.7.0'))).status, 'deferred');
  advance(1); assert.equal((await checkForUpdate(options, backend(commitB, '0.7.0'))).status, 'prepared');
  const disabled = { ...options, env: { MADDOTS_AI_AUTO_UPDATE: '0' } };
  assert.equal((await checkForUpdate(disabled, backend(commitC, '0.8.0'))).status, 'disabled');
  assert.equal((await selectRelease(disabled, source)).commit, commitB);
  assert.equal((await checkForUpdate({ ...disabled, force: true }, backend(commitC, '0.8.0'))).status, 'prepared');
});
test('activation and rollback wait for the sync write lock while candidate preparation happens outside it', async t => {
  const { options } = await fixture(t);
  await mkdir(options.paths.data, { recursive: true, mode: 0o700 });
  let releaseSync!: () => void, entered!: () => void, validated!: () => void;
  const locked = new Promise<void>(resolve => { entered = resolve; });
  const unlock = new Promise<void>(resolve => { releaseSync = resolve; });
  const validation = new Promise<void>(resolve => { validated = resolve; });
  const sync = withWriteLock(options.paths, async () => { entered(); await unlock; });
  await locked;
  let activated = false;
  const update = checkForUpdate({ ...options, activate: async () => { activated = true; } }, backend(commitA, '0.6.0', { validate: async () => { validated(); } }));
  await validation; await immediate(); assert.equal(activated, false);
  assert.equal((await selectRelease(options, source)).root, options.bundledRoot);
  releaseSync(); await sync; assert.equal((await update).status, 'prepared'); assert.ok(activated);
  let releaseSecond!: () => void, enteredSecond!: () => void;
  const second = new Promise<void>(resolve => { enteredSecond = resolve; });
  const secondUnlock = new Promise<void>(resolve => { releaseSecond = resolve; });
  const secondSync = withWriteLock(options.paths, async () => { enteredSecond(); await secondUnlock; }); await second;
  let rolledBack = false;
  const rollback = rollbackRelease({ ...options, activate: async () => { rolledBack = true; } }, undefined, source);
  await immediate(); assert.equal(rolledBack, false); releaseSecond(); await secondSync;
  assert.equal((await rollback).status, 'rolled-back'); assert.ok(rolledBack);
});
test('concurrent preparation is busy and a failed activation restores the old pointer', async t => {
  const { options } = await fixture(t); await checkForUpdate(options, backend());
  let finish!: () => void, start!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; }), entered = new Promise<void>(resolve => { start = resolve; });
  const update = checkForUpdate({ ...options, force: true, activate: async () => { throw new Error('credential-canary'); } },
    backend(commitB, '0.7.0', { latest: async () => { start(); await gate; return { commit: commitB, sha256: digest }; } }));
  await entered; assert.equal((await checkForUpdate({ ...options, force: true }, backend(commitC, '0.8.0'))).status, 'busy');
  finish(); assert.equal((await update).status, 'failed'); assert.equal((await selectRelease(options, source)).commit, commitA);
});
test('manual rollback does not reject a different independently verified future release', async t => {
  const { options, advance } = await fixture(t); await checkForUpdate(options, backend());
  await checkForUpdate({ ...options, force: true }, backend(commitB, '0.7.0'));
  let finish!: () => void, start!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; }), entered = new Promise<void>(resolve => { start = resolve; });
  await rollbackRelease(options, undefined, source);
  // Explicit retry may proceed. A later concurrent manual rollback must win over automatic activation.
  await checkForUpdate({ ...options, force: true }, backend(commitB, '0.7.0'));
  advance(UPDATE_CHECK_INTERVAL_MS);
  const update = checkForUpdate(options, backend(commitC, '0.8.0', { validate: async () => { start(); await gate; } }));
  await entered; await rollbackRelease(options, undefined, source);
  // A rollback rejects the version rolled back, not a future independently signed release.
  finish(); assert.equal((await update).status, 'prepared'); assert.equal((await selectRelease(options, source)).commit, commitC);
});
test('symlink parents, pointers and entrypoints are never followed; unsafe cached release falls back safely', async t => {
  const { options, home } = await fixture(t); await checkForUpdate(options, backend());
  await checkForUpdate({ ...options, force: true }, backend(commitB, '0.7.0'));
  const selected = await selectRelease(options, source), executable = join(selected.root, 'dist/cli.js');
  await rm(executable); await symlink(join(home, 'outside.js'), executable);
  assert.equal((await selectRelease(options, source)).commit, commitA);
  const alias = join(home, 'alias'); await symlink(options.paths.data, alias);
  const unsafe = { ...options, paths: { ...options.paths, data: alias } };
  assert.equal((await checkForUpdate({ ...unsafe, force: true }, backend())).reason, 'PATH_UNSAFE');
  assert.equal((await rollbackRelease(unsafe, undefined, source)).status, 'failed');
  await writeFile(join(updateDirectory(options), 'releases', commitA, '.artifact.tgz'), 'damaged archive');
  assert.equal((await selectRelease(options, source)).root, options.bundledRoot);
  const pointer = join(updateDirectory(options), 'current.json'); await rm(pointer);
  const outside = join(home, 'outside.json'); await writeFile(outside, '{"untouched":true}', { mode: 0o600 }); await symlink(outside, pointer);
  assert.equal((await checkForUpdate({ ...options, force: true }, backend())).reason, 'PATH_UNSAFE');
  assert.equal(await readFile(outside, 'utf8'), '{"untouched":true}');
});
test('automatic checks start once, run hourly and stop, with disabled checks creating no timer', async t => {
  const { options } = await fixture(t);
  // Prevent npm/network use even when this test runs in an exported release package.
  options.paths = { ...options.paths, data: options.bundledRoot };
  t.mock.timers.enable({ apis: ['setInterval'] }); let checks = 0;
  const stop = startUpdateChecks(options, () => { checks++; }, backend());
  for (let n = 0; n < 100 && checks < 1; n++) await immediate(); assert.equal(checks, 1);
  t.mock.timers.tick(UPDATE_CHECK_INTERVAL_MS - 1); await immediate(); assert.equal(checks, 1);
  t.mock.timers.tick(1); for (let n = 0; n < 100 && checks < 2; n++) await immediate(); assert.equal(checks, 2);
  stop(); t.mock.timers.tick(UPDATE_CHECK_INTERVAL_MS); await immediate(); assert.equal(checks, 2);
  const disabledStop = startUpdateChecks({ ...options, env: { MADDOTS_AI_AUTO_UPDATE: '0' } }, () => { checks++; }, backend());
  t.mock.timers.tick(UPDATE_CHECK_INTERVAL_MS); await immediate(); disabledStop(); assert.equal(checks, 2);
});

const transport: PackageInfrastructure = { env: {}, npm: { command: 'unused', args: [] }, strictSSL: true, offline: false };
function downloadAdapter(chunks: Buffer[], extra: Record<string, unknown> = {}) {
  return { fetch: (async (url: string, options: any) => {
    assert.equal(options.size, undefined); assert.equal(options.headers.authorization, undefined); assert.equal(options.strictSSL, true);
    return { ok: true, url, body: Readable.from(chunks), ...extra };
  }) as unknown as typeof fetch };
}
test('downloads stream bounded HTTPS bytes without credentials and enforce size, offline and cancellation', async () => {
  const bytes = Buffer.from('fixture body');
  assert.deepEqual(await downloadRelease('https://fixture.test/artifact', bytes.length, transport, undefined, downloadAdapter([bytes])), bytes);
  await assert.rejects(downloadRelease('https://fixture.test/artifact', 2, transport, undefined, downloadAdapter([bytes])), /ARTIFACT_TOO_LARGE/);
  for (const url of ['http://fixture.test/artifact', 'https://user:secret@fixture.test/artifact']) await assert.rejects(downloadRelease(url, 100, transport, undefined, downloadAdapter([bytes])), /NETWORK_UNAVAILABLE/);
  await assert.rejects(downloadRelease('https://fixture.test/artifact', 100, { ...transport, offline: true }, undefined, downloadAdapter([bytes])), /NETWORK_OFFLINE/);
  const signal = AbortSignal.abort(); await assert.rejects(downloadRelease('https://fixture.test/artifact', 100, transport, signal, downloadAdapter([bytes])), /NETWORK_UNAVAILABLE/);
  await assert.rejects(downloadRelease('https://fixture.test/artifact', 100, transport, undefined, downloadAdapter([bytes], { url: 'http://fixture.test/artifact' })), /NETWORK_UNAVAILABLE/);
});
test('download full-body deadline and caller cancellation close stalled streams without exposing transport details', async () => {
  for (const callerAbort of [false, true]) {
    const body = new Readable({ read() {} }); body.push('begin');
    const controller = new AbortController();
    const adapter = { timeoutMs: 15, fetch: (async (url: string) => ({ ok: true, url, body })) as unknown as typeof fetch };
    const pending = downloadRelease('https://fixture.test/artifact', 100, transport, controller.signal, adapter);
    if (callerAbort) { await immediate(); controller.abort(); }
    await assert.rejects(pending, /NETWORK_UNAVAILABLE/); assert.ok(body.destroyed);
  }
});
async function archive(t: TestContext, link = false): Promise<Buffer> {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'maddots-tar-')); t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, 'package'); await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify(candidate('0.6.0')));
  await writeFile(join(root, 'npm-shrinkwrap.json'), '{}');
  if (link) await symlink('/tmp/outside', join(root, 'dist/cli.js')); else await writeFile(join(root, 'dist/cli.js'), '// fixture');
  const stream = tar.c({ cwd: home, gzip: true }, ['package']);
  const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks);
}
test('verified local release archive passes fixture backend end to end and rejects archive links before extraction', async t => {
  const { options } = await fixture(t), bytes = await archive(t), sha256 = createHash('sha256').update(bytes).digest('hex');
  const release = { commit: commitA, sha256 };
  const result = await checkForUpdate(options, backend(commitA, '0.6.0', { latest: async () => release, prepare: (value, target) => prepareArchive(bytes, value, target) }));
  assert.equal(result.status, 'prepared'); assert.equal((await selectRelease(options, source)).commit, commitA);
  const evil = await archive(t, true), target = join(options.paths.data, 'bad-archive'); await mkdir(target, { mode: 0o700 });
  await assert.rejects(prepareArchive(evil, { commit: commitB, sha256: createHash('sha256').update(evil).digest('hex') }, target), /UNSAFE_ARCHIVE/);
  await assert.rejects(readFile(join(target, 'package.json')), { code: 'ENOENT' });
});
test('npm discovery supports a separate manager prefix and all command environments scrub token, key and secret variables', async t => {
  const { home } = await fixture(t), node = join(home, 'node/bin/node'), cli = join(home, 'npm-cli.js'), bin = join(home, 'bin');
  await mkdir(bin); await writeFile(cli, '// fixture'); await symlink(cli, join(bin, 'npm'));
  assert.deepEqual(await discoverNpm({ PATH: bin }, node), { command: node, args: [cli] });
  const environment = { npm_execpath: cli, PATH: bin, HOME: home, NPM_TOKEN: 'canary', NODE_AUTH_TOKEN: 'canary', MADDOTS_AI_TOKEN: 'canary',
    API_KEY: 'canary', PROVIDER_SECRET: 'canary', npm_config_registry: 'https://registry.fixture.test', npm_config_authToken: 'canary', NODE_OPTIONS: '--require evil',
    npm_config_ignore_scripts: 'false' };
  const env = installEnvironment(environment);
  assert.doesNotMatch(JSON.stringify(env), /canary|--require/); assert.equal(env.npm_config_ignore_scripts, 'true');
  const ca = join(home, 'ca.pem'); await writeFile(ca, 'fixture CA');
  let calls = 0;
  const infrastructure = await packageInfrastructure(environment, home, undefined, async (_file, args, options) => {
    calls++; assert.equal(options.timeout, PACKAGE_TIMEOUT_MS); assert.deepEqual(args.slice(-3), ['config', 'list', '--json']);
    assert.doesNotMatch(JSON.stringify(options.env), /canary/);
    return { stdout: JSON.stringify({ 'https-proxy': 'https://proxy.fixture.test', cafile: ca, 'strict-ssl': false, offline: true }), stderr: '' };
  });
  assert.equal(calls, 1); assert.equal(infrastructure.ca, 'fixture CA'); assert.equal(infrastructure.strictSSL, true); assert.equal(infrastructure.offline, true);
  await chmod(cli, 0o700);
});
