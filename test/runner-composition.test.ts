import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, randomUUID, sign} from 'node:crypto';
import {lstat, mkdir, mkdtemp, readFile, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {TOOL_MATRIX} from '../src/shared/tool-matrix.js';
import {RUNNER_CONSTANTS, RUNNER_HEADERS, verifyRunnerRequest, type RunnerHeartbeatBody} from '../src/shared/runner-protocol.js';
import {treeDigest} from '../src/shared/build-format.js';
import {ApiClient} from '../src/api.js';
import {HelperError, readConfig, type Timing} from '../src/config.js';
import {atomicWrite, createPaths, ensurePaths, ensurePrivateDirectory} from '../src/paths.js';
import {LockStore, type LockEntry} from '../src/lock.js';
import {BuildVerifier, signedBuildString, type SignedBuild} from '../src/verify.js';
import type {SecretName, SecretStore} from '../src/secret-store.js';
import {StateStore} from '../src/state.js';
import type {Adapter} from '../src/runner/adapter.js';
import {AdapterRegistry} from '../src/runner/adapters/index.js';
import {RunsRuntime} from '../src/runner/cli-runs.js';
import type {RunnerClaim, RunnerHeartbeat} from '../src/runner/protocol-client.js';
import {RunnerState} from '../src/runner/state.js';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean) {
  for (let count = 0; count < 1000; count++) {if (check()) return; await new Promise(resolve => setTimeout(resolve, 5));}
  assert.fail('composed runner did not reach the expected state');
}

for (const kind of ['assignment', 'mention'] as const) test(`TLS-25 RunsRuntime composition: accepted code skills, real 30-second token check and postResult ${kind} delivery`, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-composition-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const home = join(root, 'home'); await mkdir(home, {mode: 0o700});
  const paths = await createPaths(readConfig({MADDOTS_AI_HOME: join(root, 'data')}, home)); await ensurePaths(paths);
  const bin = await realpath('/bin/echo'), aiToolId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), cardId = randomUUID();
  const helperId = randomUUID(), deviceKeyId = randomUUID(), endpoint = new URL('https://ai.maddots.app');
  const device = generateKeyPairSync('ed25519').privateKey.export({format: 'jwk'});
  const token = 'mdai_skill_' + 'R'.repeat(43), runToken = 'pm_run_' + 'x'.repeat(43);
  const savedSecrets = new Map<SecretName, string>([['skills-token', token], ['device-key', JSON.stringify({format: 1,
    keys: {[aiToolId]: {deviceKeyId, d: device.d!, x: device.x!}}})]]);
  const secrets: SecretStore = {storage: 'keychain', get: async name => savedSecrets.get(name),
    set: async (name, value) => {savedSecrets.set(name, value);}, delete: async name => {savedSecrets.delete(name);}};
  const state = new StateStore(paths, endpoint);
  await state.write({format: 1, endpoint: endpoint.href, helperId, status: 'connected', scopes: ['sync', 'run_claim'],
    tokenStorage: 'keychain', tools: [{tool: 'codex', variant: 'cli', version: '1.0.0', models: ['fixture-model'], syncOnly: false, path: bin, realpath: bin}],
    pendingTools: [], connections: [{id: aiToolId, tool: 'codex', variant: 'cli'}]});
  const signer = generateKeyPairSync('ed25519'), publicKey = signer.publicKey.export({type: 'spki', format: 'der'}).subarray(-32);
  const keyId = createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
  const verifier = new BuildVerifier({keys: [{keyId, publicKey: publicKey.toString('base64')}], env: {}});
  const markdown = '---\nname: composition-skill\ndescription: |\n  First description line.\n  Second description line.\n---\nOnly accepted instructions.\n';
  const script = '#!/bin/sh\nprintf accepted\n';
  const files = [{path: 'SKILL.md', mode: '100644' as const, content: Buffer.from(markdown)},
    {path: 'scripts/run.sh', mode: '100755' as const, content: Buffer.from(script)}];
  const build: SignedBuild = {format: 1, keyId, skillId: randomUUID(), version: 1, settingsRevision: 0,
    digest: treeDigest(files), level: 'workspace', workspaceId: randomUUID(), boardId: null,
    target: 'folder', name: 'composition-skill', hasCode: true, draft: false, signature: '',
    report: {renamedFrom: null, unresolvedOptionalReferences: [], unsetSettings: []},
    files: files.map(file => ({...file, size: file.content.length, sha256: createHash('sha256').update(file.content).digest('hex'),
      content: file.content.toString('base64')}))};
  build.signature = sign(null, Buffer.from(signedBuildString(build)), signer.privateKey).toString('base64');
  const locks = new LockStore(paths, helperId, 'agent-lock.json');
  const entry: LockEntry = {skillId: build.skillId, target: build.target, route: 'agents-folder', name: build.name,
    workspaceId: build.workspaceId, keyId, signature: build.signature, version: build.version, settingsRevision: build.settingsRevision,
    digest: build.digest, hasCode: true, draft: false, acceptedAt: new Date().toISOString(), acceptedBy: 'install',
    previous: null, keepLocal: null, allowedDigests: [], agentId};
  const accept = async (allowedDigests: string[]) => {
    await ensurePrivateDirectory(join(paths.data, 'cache', 'builds'));
    await atomicWrite(join(paths.data, 'cache', 'builds', `${build.digest}-${createHash('sha256').update(build.signature).digest('hex')}.json`), JSON.stringify(build));
    const lock = await locks.read(); lock.entries = [{...entry, allowedDigests}]; await locks.write(lock);
  };
  let now = Date.now(), claimed = false, cardRead = false, releaseCard!: () => void;
  const holdCard = new Promise<void>(resolve => {releaseCard = resolve;});
  const sleeps = new Set<{at: number; wake: () => void}>();
  const timing: Timing = {now: () => now, sleep: (ms, signal) => new Promise((resolve, reject) => {
    const abort = () => {sleeps.delete(row); reject(new HelperError('CANCELLED', 'cancelled'));};
    const row = {at: now + ms, wake: () => {sleeps.delete(row); signal?.removeEventListener('abort', abort); resolve();}};
    if (signal?.aborted) {abort(); return;}
    sleeps.add(row); signal?.addEventListener('abort', abort, {once: true});
  })};
  const advance = async (ms: number) => {now += ms; for (const row of [...sleeps]) if (row.at <= now) row.wake(); await turn();};
  const claim: RunnerClaim = {runId, agentId, cardId, boardId: randomUUID(), commentId: kind === 'mention' ? randomUUID() : null,
    kind, expiresAt: new Date(now + 7200_000).toISOString(), model: 'fixture-model', provider: null, effort: null, maxRunMinutes: 120, skills: [{skillId: build.skillId, name: build.name, version: build.version, settingsRevision: build.settingsRevision,
      digest: build.digest, hasCode: false}]};
  const heartbeats: RunnerHeartbeatBody[] = [], calls: {path: string; at: number; body?: string}[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname; calls.push({path, at: now, body: typeof init?.body === 'string' ? init.body : undefined});
    const headers = new Headers(init?.headers);
    if (path.startsWith('/api/runner/')) {
      assert.equal(headers.get('authorization'), `Bearer ${token}`);
      assert.equal(headers.get(RUNNER_HEADERS.deviceKey), deviceKeyId);
      assert(verifyRunnerRequest({method: 'POST', path, body: Buffer.from(String(init?.body)), deviceKeyId,
        timestamp: headers.get(RUNNER_HEADERS.timestamp)!, nonce: headers.get(RUNNER_HEADERS.nonce)!},
      headers.get(RUNNER_HEADERS.signature)!, device.x!));
      if (path === '/api/runner/heartbeat') {
        heartbeats.push(JSON.parse(String(init?.body)));
        return Response.json({data: {...heartbeat, claimable: claimed ? [] : heartbeat.claimable}});
      }
      if (path === '/api/runner/claims') {
        assert.equal(JSON.parse(String(init?.body)).access, 'folder_only'); claimed = true;
        return Response.json({data: {...claim, token: runToken}});
      }
      if (path.endsWith('/outcome')) return Response.json({data: {recorded: true}});
      assert.fail(`unexpected runner request: ${path}`);
    }
    assert.equal(headers.get('authorization'), `Bearer ${runToken}`);
    if (path === '/api/run-token') return Response.json({live: true, runId, kind, cardId, expiresAt: claim.expiresAt});
    if (path === `/api/cards/${cardId}`) {
      cardRead = true; await holdCard;
      return Response.json({data: {card: {id: cardId, title: 'Composition task'}, comments: kind === 'mention' ? [{id: claim.commentId,
        body: 'Please answer this question.', createdAt: new Date(now).toISOString(), isQuestion: true, postedByAgentRun: false, authorCanEdit: true}] : [], attachments: []}});
    }
    if (path.endsWith('/comments')) return Response.json({data: {id: randomUUID()}});
    if (path === '/api/run-token/move') return Response.json({data: {id: cardId}});
    assert.fail(`unexpected MadDots request: ${path}`);
  };
  const adapter: Adapter = {
    info: {tool: 'codex', harness: 'codex', card: 'TLS-26', folderOnly: 'os-sandbox', mcpLevel: 'servers-off',
      skillsDir: '{runDir}/skills', promptVia: 'stdin', runHome: false},
    identity: async () => ({ok: true, version: '1.0.0'}), supports: () => ({ok: true, reason: null}),
    build: () => ({argv: [bin, 'Composition result'], env: {}, envUnset: [], stdinFile: null, files: [], projectFiles: [], spawnCwd: null, secretEnv: {}}),
    parse: result => ({ok: result.exitCode === 0, text: result.stdout.trim(), failureCode: null}),
  };
  const matrix = structuredClone(TOOL_MATRIX); matrix.tools.find(tool => tool.key === 'codex')!.run = {
    adapter: 'codex', card: 'TLS-26', offered: true, folderOnly: 'os-sandbox', mcpLevel: 'servers-off', reason: null, checkedAt: '2026-10-16'};
  const heartbeat: RunnerHeartbeat = {heartbeatSeconds: 15, stop: [], claimable: [{runId, agentId, kind}], agents: [{agentId, name: 'Composed', handle: 'composed',
    status: 'active', model: claim.model, provider: null, effort: null, accessWanted: 'full_access', maxRunMinutes: 120, skills: claim.skills}]};
  const runtime = new RunsRuntime({paths, helperId, endpoint, secrets, state, api: new ApiClient(endpoint, fetcher), request: fetcher,
    timing, verifier, registry: new AdapterRegistry([adapter]), matrix,
    processes: {table: async () => [], fencePids: async () => [], identity: async pid => {try {process.kill(pid, 0); return `fixture-${pid}`;} catch {return null;}}}});
  const core = runtime.core, answers = ['', ''];
  const setup = await runtime.local.setup({agentId, aiToolId, handle: 'composed'}, {isTTY: true, prompt: async () => answers.shift()!, output: () => {}, adapter, bin,
    model: claim.model, matrix});
  t.after(async () => {releaseCard(); await runtime.close();});
  await core.tick(); await runtime.catalogSettled();
  assert.equal(heartbeats.length, 1);
  assert.equal(claimed, false, 'production readiness must refuse a nonempty unaccepted skill list');
  await accept([]); await advance(15_000); await core.tick(); await runtime.catalogSettled();
  assert.equal(heartbeats.length, 2);
  assert.equal(claimed, false, 'accepted executable bytes need local Allow even when the server omits hasCode');
  await accept(['a'.repeat(64)]); await advance(15_000); await core.tick(); await runtime.catalogSettled();
  assert.equal(heartbeats.length, 3);
  assert.equal(claimed, false, 'Allow for another digest cannot authorize this build');
  await accept([build.digest]); await advance(15_000); await core.tick(); await runtime.catalogSettled();
  assert.equal(heartbeats.length, 4); assert.equal(claimed, true, 'the accepted and allowed build must be claimed');
  assert.equal((await new RunnerState(paths.data).pending()).length, 1, 'the real claim must persist a contract-valid crash outcome before reading the card');
  await until(() => cardRead);
  const claimedAt = now, period = RUNNER_CONSTANTS.runnerCheckSeconds * 1000;
  assert.equal(sleeps.size, 1, 'the production composition must install startTokenCheck');
  await advance(period - 1); assert.equal(calls.filter(call => call.path === '/api/run-token').length, 0);
  await advance(1); await until(() => calls.some(call => call.path === '/api/run-token'));
  assert.equal(calls.find(call => call.path === '/api/run-token')!.at - claimedAt, 30_000);
  releaseCard(); await core.idle();
  const pending = (await new RunnerState(paths.data).pending())[0];
  const runDir = join(setup.folder, '.maddots', 'runs', runId), staged = join(runDir, 'skills', build.name);
  assert.equal(await readFile(join(staged, 'SKILL.md'), 'utf8'), markdown, 'production composition must stage the verified skill bytes');
  assert.equal(await readFile(join(staged, 'scripts', 'run.sh'), 'utf8'), script);
  assert.equal((await lstat(join(staged, 'scripts', 'run.sh'))).mode & 0o777, 0o755);
  assert.match(await readFile(join(runDir, 'prompt.md'), 'utf8'), /composition-skill: First description line\.\nSecond description line\./);
  assert.equal(pending.body.outcome, 'done'); assert.equal(pending.body.posted.comments, 1);
  assert.equal(pending.body.posted.moved, kind === 'assignment');
  const comment = calls.filter(call => call.path.endsWith('/comments'));
  assert.equal(comment.length, 1, 'the production composition must call postResult');
  assert.match(JSON.parse(comment[0].body!).body, /Composition result/);
  assert.match(await readFile(join(setup.folder, '.maddots', 'runs', runId, 'stdout.log'), 'utf8'), /Composition result/);
  assert.equal(calls.filter(call => call.path === '/api/run-token/move').length, kind === 'assignment' ? 1 : 0);
  assert.equal(sleeps.size, 0); assert.equal(JSON.stringify(heartbeats).includes(setup.folder), false);
  assert.deepEqual(heartbeats[0].agents, [{agentId, access: 'folder_only'}]);
});
