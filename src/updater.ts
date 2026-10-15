// Release discovery is untrusted until Sigstore binds it to the exported identity.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import fetch, { type FetchOptions } from 'make-fetch-happen';
import { verify, type VerifyOptions } from 'sigstore';
import * as tar from 'tar';
import { HelperError, clock, runCommand, type Timing } from './config.js';
import { assertNoSymlinks, atomicWrite, ensurePrivateDirectory, inside, readPrivateFile, withWriteLock, type HelperPaths } from './paths.js';
import { packageInfrastructure, PACKAGE_TIMEOUT_MS, runPackageCommand, type PackageInfrastructure } from './npm.js';
import { RELEASE_IDENTITY, type ReleaseIdentity } from './release-identity.js';

export const UPDATE_CHECK_INTERVAL_MS = 3_600_000;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
export interface UpdateOptions {
  paths: HelperPaths; bundledRoot: string; version: string; runningVersion?: string;
  env: NodeJS.ProcessEnv; timing?: Timing; force?: boolean; signal?: AbortSignal;
  /** Runs under the same write lock as sync. The stable launchd launcher needs no callback. */
  activate?: (selected: SelectedRelease) => Promise<void>;
}
export interface SelectedRelease { root: string; version: string; commit?: string }
export interface SignedRelease { commit: string; sha256: string }
export interface UpdateResult {
  status: 'disabled' | 'busy' | 'current' | 'prepared' | 'failed' | 'deferred' | 'rolled-back';
  commit?: string; version?: string; reason?: string;
}
interface Pointer { current?: string; previous?: string }
interface Ready extends SignedRelease { repository: string; workflowPath: string; version: string }
interface CheckStatus extends UpdateResult { checkedAt?: number; finishedAt?: number }
/** An explicit fixture seam, never selected through CLI flags or the environment. */
export interface UpdateBackend {
  identity: Readonly<ReleaseIdentity>;
  latest(): Promise<SignedRelease>;
  prepare(release: SignedRelease, target: string): Promise<void>;
  validate(target: string): Promise<void>;
}
const active = new Set<string>();
const lastStatuses = new Map<string, CheckStatus>();
const record = (value: unknown): Record<string, any> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined;
function fail(code: string): never { throw new HelperError(code, code); }
function identity(fixture?: Readonly<ReleaseIdentity>): Readonly<ReleaseIdentity> {
  const value = fixture ?? RELEASE_IDENTITY;
  if (!value) fail('RELEASE_UNCONFIGURED');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value.repository) ||
      value.workflowPath !== '.github/workflows/helper-release.yml' || value.releasePrefix !== 'helper-' || value.assetName !== 'helper.tgz' || !value.allowedSigner.trim()) fail('RELEASE_UNCONFIGURED');
  return value;
}
export function updateDirectory(options: UpdateOptions): string { return join(options.paths.data, 'updates'); }
function timing(options: UpdateOptions): Timing { return options.timing ?? clock; }
function compare(a: string, b: string): number {
  const parse = (value: string): bigint[] => {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) fail('INVALID_MANIFEST');
    return value.split('.').map(BigInt);
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
async function privateFolder(path: string, create = false): Promise<void> {
  if (create) return ensurePrivateDirectory(path);
  await assertNoSymlinks(path);
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) fail('PATH_UNSAFE');
}
async function validateLocation(options: UpdateOptions, create = false): Promise<string> {
  const directory = updateDirectory(options), root = resolve(options.bundledRoot);
  if (inside(directory, root) || inside(root, directory)) fail('PATH_UNSAFE');
  await privateFolder(options.paths.data, create);
  await privateFolder(directory, create);
  await privateFolder(join(directory, 'releases'), create);
  return directory;
}
async function regular(path: string, limit = 4 * 1024 * 1024): Promise<Buffer> {
  await assertNoSymlinks(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o022) !== 0 || info.size > limit) fail('FILE_UNSAFE');
    const bytes = Buffer.alloc(Math.min(info.size + 1, limit + 1)), result = await file.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead > limit) fail('FILE_UNSAFE');
    return bytes.subarray(0, result.bytesRead);
  } finally { await file.close(); }
}
async function privateJson(path: string): Promise<Record<string, any>> {
  const value = record(JSON.parse(await readPrivateFile(path, 64 * 1024)));
  if (!value) fail('FILE_UNSAFE');
  return value;
}
async function atomicJson(path: string, value: unknown): Promise<void> { await atomicWrite(path, JSON.stringify(value) + '\n'); }
async function pointer(directory: string): Promise<Pointer | undefined> {
  try {
    const value = await privateJson(join(directory, 'current.json'));
    if ((value.current !== undefined && !SHA.test(value.current)) || (value.previous !== undefined && !SHA.test(value.previous))) fail('FILE_UNSAFE');
    return { current: value.current, previous: value.previous };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
}
async function manifest(root: string): Promise<{ version: string }> {
  const value = record(JSON.parse((await regular(join(root, 'package.json'), 64 * 1024)).toString('utf8')));
  if (value?.name !== 'maddots-ai' || value.private !== true || typeof value.version !== 'string' || value.bin?.['maddots-ai'] !== 'dist/cli.js') fail('INVALID_MANIFEST');
  compare(value.version, value.version);
  return { version: value.version };
}
async function ready(options: UpdateOptions, source: Readonly<ReleaseIdentity>, commit?: string): Promise<Ready | undefined> {
  if (!commit || !SHA.test(commit)) return;
  try {
    const root = join(updateDirectory(options), 'releases', commit);
    await privateFolder(root);
    const value = await privateJson(join(root, '.ready.json')) as unknown as Ready;
    const metadata = await manifest(root);
    if (value.repository !== source.repository || value.workflowPath !== source.workflowPath || value.commit !== commit ||
        !DIGEST.test(value.sha256) || value.version !== metadata.version || compare(value.version, options.version) < 0) return;
    await regular(join(root, 'dist/cli.js'));
    verifyArtifactDigest(await regular(join(root, '.artifact.tgz'), 24 * 1024 * 1024), value.sha256);
    return value;
  } catch { return; }
}
export async function selectRelease(options: UpdateOptions, fixtureIdentity?: Readonly<ReleaseIdentity>): Promise<SelectedRelease> {
  try {
    const source = identity(fixtureIdentity), directory = await validateLocation(options), selected = await pointer(directory);
    for (const commit of [selected?.current, selected?.previous]) {
      const release = await ready(options, source, commit);
      if (release) return { root: join(directory, 'releases', release.commit), version: release.version, commit: release.commit };
    }
  } catch { /* An optional update cannot prevent the bundled helper from launching. */ }
  return { root: options.bundledRoot, version: options.version };
}

/** Call only after verifying the DSSE signature and Fulcio certificate identity. */
export function releaseFromStatement(source: Readonly<ReleaseIdentity>, statement: unknown): SignedRelease {
  identity(source);
  const value = record(statement), definition = value?.predicate?.buildDefinition, workflow = definition?.externalParameters?.workflow;
  const url = 'https://github.com/' + source.repository, subject = value?.subject;
  if (value?._type !== 'https://in-toto.io/Statement/v1' || value?.predicateType !== 'https://slsa.dev/provenance/v1' ||
      definition?.buildType !== 'https://actions.github.io/buildtypes/workflow/v1' || workflow?.repository !== url ||
      workflow?.ref !== 'refs/heads/main' || workflow?.path !== source.workflowPath || !Array.isArray(subject) || subject.length !== 1 ||
      subject[0]?.name !== source.assetName || !DIGEST.test(subject[0]?.digest?.sha256)) fail('INVALID_PROVENANCE');
  const dependencies = definition?.resolvedDependencies;
  const matches = Array.isArray(dependencies) ? dependencies.filter(item => item?.uri === 'git+' + url + '@refs/heads/main') : [];
  if (matches.length !== 1 || !SHA.test(matches[0]?.digest?.gitCommit)) fail('INVALID_PROVENANCE');
  return { commit: matches[0].digest.gitCommit, sha256: subject[0].digest.sha256 };
}
export async function verifyReleaseBundle(source: Readonly<ReleaseIdentity>, bundle: any, tufCachePath?: string,
  verifier: (bundle: any, options?: VerifyOptions) => Promise<unknown> = verify): Promise<SignedRelease> {
  identity(source);
  if ((!bundle?.verificationMaterial?.certificate && !bundle?.verificationMaterial?.x509CertificateChain) ||
      bundle?.dsseEnvelope?.payloadType !== 'application/vnd.in-toto+json' || typeof bundle.dsseEnvelope.payload !== 'string' ||
      !Array.isArray(bundle.dsseEnvelope.signatures) || bundle.dsseEnvelope.signatures.length === 0) fail('INVALID_PROVENANCE');
  const certificateIdentity = 'https://github.com/' + source.repository + '/' + source.workflowPath + '@refs/heads/main';
  try {
    await verifier(bundle, { certificateIssuer: 'https://token.actions.githubusercontent.com',
      certificateIdentityURI: '^' + certificateIdentity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$',
      tlogThreshold: 1, ctLogThreshold: 1, tufCachePath, retry: 0, timeout: 20_000 });
    return releaseFromStatement(source, JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, 'base64').toString('utf8')));
  } catch { fail('INVALID_PROVENANCE'); }
}
export function verifyArtifactDigest(bytes: Buffer, sha256: string): void {
  if (!DIGEST.test(sha256) || createHash('sha256').update(bytes).digest('hex') !== sha256) fail('INVALID_CHECKSUM');
}
interface DownloadFixture { fetch: typeof fetch; timeoutMs?: number }
export async function downloadRelease(url: string, limit: number, infrastructure: PackageInfrastructure, signal?: AbortSignal, fixture?: DownloadFixture): Promise<Buffer> {
  if (infrastructure.offline) fail('NETWORK_OFFLINE');
  const secure = (value: string): boolean => { try { const parsed = new URL(value); return parsed.protocol === 'https:' && !parsed.username && !parsed.password; } catch { return false; } };
  if (!secure(url)) fail('NETWORK_UNAVAILABLE');
  const controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let body: (AsyncIterable<Uint8Array> & { destroy(error?: Error): unknown }) | undefined;
  const abort = () => { body?.destroy(); };
  combined.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), fixture?.timeoutMs ?? 30_000);
  try {
    if (combined.aborted) fail('NETWORK_UNAVAILABLE');
    const fetchOptions: FetchOptions & { signal?: AbortSignal } = { signal: combined, timeout: 30_000, retry: 0,
      proxy: infrastructure.proxy, noProxy: infrastructure.noProxy, ca: infrastructure.ca, strictSSL: true,
      redirect: 'follow', follow: 5, headers: { 'user-agent': 'MadDots-AI-updater' } };
    const response = await (fixture?.fetch ?? fetch)(url, fetchOptions);
    body = response.body as unknown as typeof body;
    if (combined.aborted || !response.ok || !secure(response.url) || !body) fail('NETWORK_UNAVAILABLE');
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of body) { length += chunk.length; if (length > limit) fail('ARTIFACT_TOO_LARGE'); chunks.push(Buffer.from(chunk)); }
    if (combined.aborted) fail('NETWORK_UNAVAILABLE');
    return Buffer.concat(chunks, length);
  } catch (error) {
    controller.abort();
    return fail(error instanceof HelperError && error.code === 'ARTIFACT_TOO_LARGE' ? error.code : 'NETWORK_UNAVAILABLE');
  } finally { clearTimeout(timer); combined.removeEventListener('abort', abort); body?.destroy(); }
}
async function signedLatest(options: UpdateOptions, source: Readonly<ReleaseIdentity>, infrastructure: PackageInfrastructure): Promise<SignedRelease> {
  const bytes = await downloadRelease('https://github.com/' + source.repository + '/releases/latest/download/helper.sigstore.json', 1024 * 1024, infrastructure, options.signal);
  const cache = join(updateDirectory(options), 'sigstore-cache'); await privateFolder(cache, true);
  const env = Object.fromEntries(Object.entries(infrastructure.env).filter(([key]) => /^(PATH|HOME|TMPDIR|TEMP|TMP|NODE_EXTRA_CA_CERTS|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i.test(key)));
  if (infrastructure.ca && !env.NODE_EXTRA_CA_CERTS) {
    const path = join(updateDirectory(options), 'configured-ca.pem'); await atomicWrite(path, infrastructure.ca); env.NODE_EXTRA_CA_CERTS = path;
  }
  // Verification runs in a clean child, so configured CA/proxy options never mutate the service process.
  const script = `import {verifyReleaseBundle} from ${JSON.stringify(import.meta.url)};let input='';for await(const chunk of process.stdin)input+=chunk;try{const d=JSON.parse(input);process.stdout.write(JSON.stringify(await verifyReleaseBundle(d.identity,d.bundle,d.cache)))}catch{process.exitCode=1}`;
  try {
    const result = await runCommand(process.execPath, ['--input-type=module', '-e', script], {
      env, timeout: 60_000, input: JSON.stringify({ identity: source, bundle: JSON.parse(bytes.toString('utf8')), cache }) });
    const release = JSON.parse(result.stdout) as SignedRelease;
    if (!SHA.test(release.commit) || !DIGEST.test(release.sha256)) fail('INVALID_PROVENANCE');
    return release;
  } catch { fail('INVALID_PROVENANCE'); }
}
/** The complete archive is inspected before extraction. Links and archive-controlled npm config are forbidden. */
export async function prepareArchive(bytes: Buffer, release: SignedRelease, target: string): Promise<void> {
  verifyArtifactDigest(bytes, release.sha256);
  await privateFolder(target);
  const file = join(target, '.artifact.tgz');
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  let safe = true, total = 0, count = 0; const names = new Set<string>();
  await tar.t({ file, strict: true, onReadEntry: entry => {
    const path = entry.path.replace(/\/$/, ''); total += entry.size; count++;
    if (!['File', 'Directory'].includes(entry.type) || (!path.startsWith('package/') && !(path === 'package' && entry.type === 'Directory')) || path.includes('\\') ||
        path.split('/').some(part => part === '..' || part === '.' || part === '') || names.has(path) || total > 80 * 1024 * 1024 || count > 10_000 ||
        /^package\/(?:node_modules|\.npmrc|\.ready\.json|\.artifact\.tgz)(?:\/|$)/.test(path)) safe = false;
    names.add(path);
  } });
  if (!safe) fail('UNSAFE_ARCHIVE');
  await tar.x({ file, cwd: target, strip: 1, strict: true, preservePaths: false, noChmod: true, noMtime: true });
  await regular(join(target, 'npm-shrinkwrap.json'));
}
async function prepareSigned(options: UpdateOptions, source: Readonly<ReleaseIdentity>, release: SignedRelease, target: string, infrastructure: PackageInfrastructure): Promise<void> {
  const bytes = await downloadRelease('https://github.com/' + source.repository + '/releases/download/' + source.releasePrefix + release.commit + '/' + source.assetName,
    24 * 1024 * 1024, infrastructure, options.signal);
  await prepareArchive(bytes, release, target);
}
async function validateInstalled(options: UpdateOptions, target: string, infrastructure: PackageInfrastructure): Promise<void> {
  const cache = join(updateDirectory(options), 'npm-cache'); await privateFolder(cache, true);
  try {
    await runPackageCommand(infrastructure.npm.command, [...infrastructure.npm.args, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--bin-links=false', '--cache', cache],
      { cwd: target, env: infrastructure.env, timeout: PACKAGE_TIMEOUT_MS, signal: options.signal });
  } catch { fail('INSTALL_FAILED'); }
  await validateConnection(options, target, infrastructure);
}
async function validateConnection(options: UpdateOptions, target: string, infrastructure: PackageInfrastructure): Promise<void> {
  try {
    await runPackageCommand(process.execPath, [join(target, 'dist/cli.js'), '--self-test'], {
      cwd: target, env: { ...infrastructure.env, MADDOTS_AI_AUTO_UPDATE: '0' }, timeout: PACKAGE_TIMEOUT_MS, signal: options.signal });
  } catch { fail('CANDIDATE_FAILED'); }
}
const knownReasons = new Set(['RELEASE_UNCONFIGURED', 'PATH_UNSAFE', 'FILE_UNSAFE', 'NPM_UNAVAILABLE', 'NPM_CONFIGURATION_UNAVAILABLE', 'NETWORK_OFFLINE', 'NETWORK_UNAVAILABLE', 'INVALID_PROVENANCE', 'INVALID_CHECKSUM', 'UNSAFE_ARCHIVE', 'INVALID_MANIFEST', 'INSTALL_FAILED', 'CANDIDATE_FAILED', 'DOWNGRADE_REFUSED', 'ARTIFACT_TOO_LARGE', 'CANCELLED']);
function safeReason(error: unknown, phase: string): string {
  const reason = error instanceof HelperError ? error.code : error instanceof Error ? error.message : '';
  return knownReasons.has(reason) ? reason : phase;
}
function cancelled(options: UpdateOptions): void { if (options.signal?.aborted) fail('CANCELLED'); }
async function remember(options: UpdateOptions, status: CheckStatus): Promise<void> {
  lastStatuses.set(options.paths.data, status);
  try { const directory = await validateLocation(options); await atomicJson(join(directory, 'last-check.json'), status); } catch { /* Read-only startup remains available. */ }
}
async function preserveStage(options: UpdateOptions, path: string): Promise<void> {
  // Failed or superseded candidates are retained outside the active release directory.
  await privateFolder(options.paths.backups, true); await assertNoSymlinks(path);
  await rename(path, join(options.paths.backups, 'helper-update-' + randomUUID()));
}
async function savePointer(options: UpdateOptions, next: Pointer, selected: SelectedRelease): Promise<void> {
  const path = join(updateDirectory(options), 'current.json'), previous = await pointer(updateDirectory(options));
  await atomicJson(path, next);
  try { await options.activate?.(selected); }
  catch (error) { await atomicJson(path, previous ?? {}); throw error; }
}
export async function checkForUpdate(options: UpdateOptions, fixture?: UpdateBackend): Promise<UpdateResult> {
  if (options.env.MADDOTS_AI_AUTO_UPDATE === '0' && !options.force) return { status: 'disabled' };
  const key = updateDirectory(options); if (active.has(key)) return { status: 'busy' };
  active.add(key);
  let phase = 'CACHE_UNAVAILABLE', stage: string | undefined, checkedAt: number | undefined;
  const finish = async (result: UpdateResult) => { await remember(options, { ...result, checkedAt, finishedAt: timing(options).now() }); return result; };
  try {
    const source = identity(fixture?.identity), directory = await validateLocation(options, true);
    const updatePaths = { ...options.paths, data: directory, lock: join(directory, '.lock') };
    return await withWriteLock(updatePaths, async () => {
      if (!options.force) {
        try { const previous = await privateJson(join(directory, 'last-check.json')); const elapsed = timing(options).now() - previous.checkedAt;
          if (Number.isFinite(previous.checkedAt) && elapsed >= 0 && elapsed < UPDATE_CHECK_INTERVAL_MS) return { status: 'deferred' }; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      cancelled(options); checkedAt = timing(options).now(); await remember(options, { checkedAt, status: 'busy' });
      phase = 'NPM_CONFIGURATION_UNAVAILABLE';
      const infrastructure = fixture ? undefined : await packageInfrastructure(options.env, options.bundledRoot, options.signal);
      const backend = fixture ?? { latest: () => signedLatest(options, source, infrastructure!),
        prepare: (release: SignedRelease, target: string) => prepareSigned(options, source, release, target, infrastructure!),
        validate: (target: string) => validateInstalled(options, target, infrastructure!) };
      phase = 'NETWORK_UNAVAILABLE'; const release = await backend.latest(); cancelled(options);
      if (!SHA.test(release.commit) || !DIGEST.test(release.sha256)) fail('INVALID_PROVENANCE');
      const before = await pointer(directory), existing = await ready(options, source, release.commit);
      if (existing && existing.sha256 !== release.sha256) fail('INVALID_CHECKSUM');
      if (before?.current === release.commit && existing) return finish({ status: 'current', commit: release.commit, version: existing.version });
      try {
        const rejected = await privateJson(join(directory, 'rejected.json'));
        if (!options.force && rejected.commit === release.commit) return finish({ status: 'deferred', commit: release.commit, reason: 'RELEASE_ROLLED_BACK' });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      let selected = existing;
      if (!selected) {
        stage = await mkdtemp(join(directory, 'staging-')); phase = 'ARTIFACT_UNAVAILABLE';
        await backend.prepare(release, stage); cancelled(options);
        phase = 'INVALID_MANIFEST'; const metadata = await manifest(stage);
        const current = await selectRelease(options, source);
        const floor = options.runningVersion && compare(options.runningVersion, current.version) > 0 ? options.runningVersion : current.version;
        if (compare(metadata.version, floor) < 0) fail('DOWNGRADE_REFUSED');
        phase = 'CANDIDATE_FAILED'; await backend.validate(stage); cancelled(options); await regular(join(stage, 'dist/cli.js'));
        selected = { repository: source.repository, workflowPath: source.workflowPath, ...release, ...metadata };
        await atomicJson(join(stage, '.ready.json'), selected);
      } else {
        phase = 'CANDIDATE_FAILED';
        const target = join(directory, 'releases', release.commit);
        // A cached candidate may still be running after rollback. Never reinstall its dependencies in place.
        if (fixture) await fixture.validate(target); else await validateConnection(options, target, infrastructure!);
      }
      const candidate = selected;
      return withWriteLock(options.paths, async () => {
        cancelled(options); const current = await selectRelease(options, source);
        try {
          const rejected = await privateJson(join(directory, 'rejected.json'));
          if (!options.force && rejected.commit === release.commit) return finish({ status: 'deferred', commit: release.commit, reason: 'RELEASE_ROLLED_BACK' });
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        const floor = options.runningVersion && compare(options.runningVersion, current.version) > 0 ? options.runningVersion : current.version;
        if (compare(candidate.version, floor) < 0) fail('DOWNGRADE_REFUSED');
        if (stage) {
          const destination = join(directory, 'releases', release.commit); await assertNoSymlinks(destination);
          try { await lstat(destination); fail('INVALID_CHECKSUM'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          await rename(stage, destination); stage = undefined;
        }
        const next = { current: release.commit, ...(current.commit && current.commit !== release.commit ? { previous: current.commit } : {}) };
        await savePointer(options, next, { root: join(directory, 'releases', release.commit), commit: release.commit, version: candidate.version });
        await atomicJson(join(directory, 'rejected.json'), {});
        return finish({ status: 'prepared', commit: release.commit, version: candidate.version });
      }, timing(options));
    }, timing(options));
  } catch (error) {
    if (error instanceof HelperError && error.code === 'HELPER_BUSY') return { status: 'busy' };
    return finish({ status: 'failed', reason: safeReason(error, phase) });
  } finally { if (stage) await preserveStage(options, stage).catch(() => {}); active.delete(key); }
}
export async function rollbackRelease(options: UpdateOptions, failedCommit?: string, fixtureIdentity?: Readonly<ReleaseIdentity>): Promise<UpdateResult> {
  try {
    const source = identity(fixtureIdentity), directory = await validateLocation(options);
    return await withWriteLock(options.paths, async () => {
      const selected = await pointer(directory);
      if (!selected?.current || (failedCommit && selected.current !== failedCommit)) return { status: 'current' };
      const previous = await ready(options, source, selected.previous);
      const next: SelectedRelease = previous ? { root: join(directory, 'releases', previous.commit), version: previous.version, commit: previous.commit } : { root: options.bundledRoot, version: options.version };
      await atomicJson(join(directory, 'rejected.json'), { commit: selected.current });
      await savePointer(options, previous ? { current: previous.commit } : {}, next);
      const result: UpdateResult = { status: 'rolled-back', version: next.version, ...(next.commit ? { commit: next.commit } : {}), reason: failedCommit ? 'CANDIDATE_FAILED' : 'MANUAL_ROLLBACK' };
      await remember(options, { ...result, finishedAt: timing(options).now() }); return result;
    }, timing(options));
  } catch (error) { return { status: error instanceof HelperError && error.code === 'HELPER_BUSY' ? 'busy' : 'failed', reason: safeReason(error, 'ROLLBACK_UNAVAILABLE') }; }
}
export async function diagnosticStatus(options: UpdateOptions): Promise<{ automaticUpdates: boolean; checkIntervalMs: number; lastCheck: CheckStatus | null; selectedRuntime: SelectedRelease }> {
  let status = lastStatuses.get(options.paths.data);
  try { status ??= await privateJson(join(await validateLocation(options), 'last-check.json')) as CheckStatus; } catch { /* Optional diagnostics. */ }
  return { automaticUpdates: options.env.MADDOTS_AI_AUTO_UPDATE !== '0', checkIntervalMs: UPDATE_CHECK_INTERVAL_MS, lastCheck: status ?? null, selectedRuntime: await selectRelease(options) };
}
export function startUpdateChecks(options: UpdateOptions, onChecked?: (result: UpdateResult) => void | Promise<void>, fixture?: UpdateBackend): () => void {
  if (options.env.MADDOTS_AI_AUTO_UPDATE === '0') return () => {};
  const controller = new AbortController(), signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let running = false;
  const check = async () => {
    if (running || signal.aborted) return; running = true;
    try { const result = await checkForUpdate({ ...options, signal, force: false }, fixture); if (!signal.aborted) await onChecked?.(result); }
    catch { /* Optional update checks cannot interrupt the helper. */ }
    finally { running = false; }
  };
  void check(); const timer = setInterval(() => { void check(); }, UPDATE_CHECK_INTERVAL_MS); timer.unref();
  return () => { clearInterval(timer); controller.abort(); };
}
