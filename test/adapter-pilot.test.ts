import {cleanupNativeFixtureRoot, linuxNativeWorkloadSkip, qualifyLinuxFixtureWithoutWorkloads} from './support/linux-native-workloads.js';
import {directFixtureProcesses} from './native-process-fixture.js';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, {beforeEach, type TestContext} from 'node:test';
import { TOOL_MATRIX } from '../src/shared/tool-matrix.js';
import type { RunnerClaimBody } from '../src/shared/runner-protocol.js';
import type { Adapter, RunSpec } from '../src/runner/adapter.js';
import { adapters, AdapterRegistry } from '../src/runner/adapters/index.js';
import { claudeCodeAdapter } from '../src/runner/adapters/claude-code.js';
import { codexAdapter } from '../src/runner/adapters/codex.js';
import { MaddotsApi } from '../src/runner/maddots-api.js';
import type { RunnerAgent, RunnerClaim } from '../src/runner/protocol-client.js';
import { RunnerCore, type LocalAgent, type RunnerConnection } from '../src/runner/runner.js';
import { RunnerState } from '../src/runner/state.js';
import {LinuxSelectedLogin} from '../src/runner/linux-selected-login.js';
import { initializeCleanRunnerJournal } from './support/runner-journal-fixture.js';
import {CODEX_FIXTURE_PROVIDER} from './support/codex-local-provider-fixture.js';

const linuxNativeServiceSkip = process.platform === 'linux' && (process.getuid?.() !== 999 || userInfo().username !== 'mdai')
  ? 'Native Linux pilot requires the dedicated mdai UID 999 system service with delegated cgroup v2, namespaces and guardian.'
  : linuxNativeWorkloadSkip;

// This fixture worker must never import an inherited production profile path.
beforeEach(() => {
  delete process.env.MDAI_CODEX_LOGIN_PROFILE;
  delete process.env.MDAI_CLAUDE_LOGIN_PROFILE;
});

async function provisionClaudeLogin(t: TestContext, root: string) {
  const profile = join(root, 'synthetic-claude-profile'), token = 'synthetic-pilot-claude-setup-token';
  await mkdir(profile, {mode: 0o700});
  await writeFile(join(profile, 'oauth-token'), token, {mode: 0o600});
  await writeFile(join(profile, 'selected-login.json'), JSON.stringify({version: 1, tool: 'claude',
    profileId: 'synthetic-pilot-claude', accountBinding: '11111111-1111-4111-8111-111111111111',
    organizationBinding: '22222222-2222-4222-8222-222222222222', expiresAt: Date.now() + 3_600_000,
    files: {'oauth-token': createHash('sha256').update(token).digest('hex')},
  }), {mode: 0o600});
  process.env.MDAI_CLAUDE_LOGIN_PROFILE = profile;
  t.after(() => {delete process.env.MDAI_CLAUDE_LOGIN_PROFILE;});
  const openLogin = LinuxSelectedLogin.open, uid = process.getuid!(), trustedAncestorUid = (await lstat('/')).uid;
  t.mock.method(LinuxSelectedLogin, 'open', async (selection: Parameters<typeof openLogin>[0], options: Parameters<typeof openLogin>[1]) => {
    assert.deepEqual(selection, {tool: 'claude', profilePath: profile}, 'Only this synthetic profile may be opened.');
    return openLogin.call(LinuxSelectedLogin, selection, {...options, uid, trustedAncestorUid,
      fetch: async () => assert.fail('The synthetic pinned Claude fixture must never contact a provider.')});
  });
  return {profile, token};
}

test('pilot Claude selected-login provisioning admits only its synthetic pinned profile [Linux]',
  {skip: process.platform !== 'linux' ? 'Platform-only Linux selected-login fixture.' : false}, async t => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-pilot-login-'));
    t.after(() => rm(root, {recursive: true, force: true}));
    const {profile, token} = await provisionClaudeLogin(t, root), data = join(root, 'run'), work = join(data, 'work');
    await mkdir(data, {mode: 0o700}); await mkdir(work, {mode: 0o700});
    assert.equal(process.env.MDAI_CODEX_LOGIN_PROFILE, undefined);
    const login = await LinuxSelectedLogin.open({tool: 'claude', profilePath: profile}, {deadline: Date.now() + 60_000});
    try {
      await login.stage(work);
      assert.equal(await readFile(join(work, '.mdai-home/claude/oauth-token'), 'utf8'), token);
      await login.complete(async () => {});
      login.assertPublicContent('Synthetic staged skill completed.');
      assert.equal(await readFile(join(profile, 'oauth-token'), 'utf8'), token);
    } finally {await login.close();}
    await assert.rejects(LinuxSelectedLogin.open({tool: 'claude', profilePath: join(root, 'unprovisioned')}, {deadline: Date.now() + 60_000}),
      /Only this synthetic profile may be opened/u);
  });

test('pilot registry resolves tool and harness while both tools remain unoffered', () => {
  assert.equal(adapters.get('codex'), codexAdapter);
  assert.equal(adapters.get('claude-code'), claudeCodeAdapter);
  assert.equal(adapters.get('claude_code'), claudeCodeAdapter);
  for (const adapter of [codexAdapter, claudeCodeAdapter]) {
    const entry = TOOL_MATRIX.tools.find(tool => tool.run?.adapter === adapter.info.tool)!.run!;
    assert.equal(entry.offered, false);
  }
});

for (const base of [codexAdapter, claudeCodeAdapter]) for (const access of ['folder_only', 'full_access'] as const) {
  const staticallyRefused = process.platform === 'linux' && access === 'folder_only';
  const skip = process.platform !== 'linux' && process.platform !== 'darwin' ? 'Platform-only Linux or Darwin pilot fixture.' :
    process.platform === 'linux' && !staticallyRefused ? linuxNativeServiceSkip : false;
  test(staticallyRefused ? `${base.info.tool} refuses Linux folder_only before claiming despite opposite server accessWanted` :
    `${base.info.tool} uses ${access} from local agents.json despite opposite server accessWanted`,
    {skip}, async t => {
    if (staticallyRefused) qualifyLinuxFixtureWithoutWorkloads(t);
    const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-pilot-access-'));
    const cwd = join(root, 'project with spaces'), data = join(root, 'helper-data');
    await mkdir(cwd); await mkdir(data, { mode: 0o700 });
    if (process.platform === 'linux' && base.info.tool === 'claude-code' && !staticallyRefused) await provisionClaudeLogin(t, root);
    await initializeCleanRunnerJournal(data);
    const source = base.info.tool === 'codex' ? './fixtures/adapters/codex/fake-codex.mjs' : './fixtures/adapters/claude-code/fake-cli.mjs';
    const bin = join(root, base.info.tool === 'codex' ? 'codex' : 'claude');
    await copyFile(fileURLToPath(new URL(source, import.meta.url)), bin); await chmod(bin, 0o700);
    const ids = { agent: randomUUID(), tool: randomUUID(), device: randomUUID(), run: randomUUID(), card: randomUUID(), board: randomUUID() };
    const agentsFile = join(data, 'agents.json');
    // TLS-25 owns the production reader and confirmation; exercise its existing localAgents hook.
    await writeFile(agentsFile, JSON.stringify([{ agentId: ids.agent, aiToolId: ids.tool, cwd, access }]), { mode: 0o600 });
    const claims: RunnerClaimBody[] = [], builds: RunSpec[] = [], delivered: string[] = [];
    const agent: RunnerAgent = { agentId: ids.agent, name: 'Fixture agent', handle: 'fixture-agent', status: 'active', model: 'fixture-model',
      provider: base.info.tool === 'codex' ? CODEX_FIXTURE_PROVIDER : null, effort: null, accessWanted: access === 'folder_only' ? 'full_access' : 'folder_only', maxRunMinutes: 1, skills: [] };
    const claim: RunnerClaim = { runId: ids.run, agentId: ids.agent, kind: 'assignment', cardId: ids.card, boardId: ids.board, commentId: null,
      expiresAt: new Date(Date.now() + 7_200_000).toISOString(), model: agent.model, provider: agent.provider, effort: null, maxRunMinutes: 1, skills: [] };
    const api = new MaddotsApi('pm_run_fixtureOnlyNotARealToken', { fetcher: async input => {
      assert.equal(new URL(String(input)).pathname, `/api/cards/${ids.card}`);
      return Response.json({ data: { card: { title: 'Use the staged fixture skill', description: 'Fixture only' }, comments: [], attachments: [] } });
    } });
    const adapter: Adapter = { ...base, preflight: async () => ({ok: true, reason: null}), build: input => { builds.push(input); return base.build(input); } };
    const matrix = structuredClone(TOOL_MATRIX);
    Object.assign(matrix.tools.find(tool => tool.run?.adapter === base.info.tool)!.run!, { offered: true, platforms: {darwin: {accepted: true}, linux: {accepted: true}}, folderOnly: 'os-sandbox' });
    const connection: RunnerConnection = { aiToolId: ids.tool, deviceKeyId: ids.device, tool: base.info.tool, toolVersion: 'fixture', bin, realpath: bin, runsOn: true,
      protocol: {
        heartbeat: async () => ({ heartbeatSeconds: 15, agents: [agent], claimable: [{ runId: ids.run, agentId: ids.agent, kind: 'assignment' }], stop: [] }),
        claim: async body => { claims.push(body); return { claim, api }; },
        outcome: async () => ({ recorded: true }),
      } };
    const core = new RunnerCore({ data, connections: async () => [connection], localAgents: async () => JSON.parse(await readFile(agentsFile, 'utf8')) as LocalAgent[],
      registry: new AdapterRegistry([adapter]), matrix, verifiedBuild: async () => true, allowedBuild: async () => true, removeDeviceKey: async () => {},
      processes: directFixtureProcesses(),
      stageSkills: async ({ skillsDir, folder }) => {
        const name = base.info.tool === 'codex' ? 'fixture-skill' : 'fixture';
        await mkdir(join(skillsDir, name), { recursive: true });
        await writeFile(join(skillsDir, name, 'SKILL.md'), '---\nname: fixture\n---\nstaged-fixture-skill');
        if (base.info.tool === 'claude-code') {
          const metadata = join(folder.runDir, 'plugin/.claude-plugin'); await mkdir(metadata);
          await writeFile(join(metadata, 'plugin.json'), JSON.stringify({ name: 'maddots-run' }));
        }
      },
      deliver: async ({ text }) => { delivered.push(text); return { posted: { comments: 1, attachments: 0, filesSkipped: 0, moved: false, moveSkipped: null } }; },
    });
    t.after(() => cleanupNativeFixtureRoot(t, root, data, () => core.close()));
    await core.tick(); await core.idle();
    if (staticallyRefused) {
      // S4 deliberately refuses Linux Codex and Claude Code Folder only at
      // static eligibility, before executable admission or a server claim.
      assert.deepEqual(claims, []); assert.deepEqual(builds, []); assert.deepEqual(delivered, []);
      assert.deepEqual(await new RunnerState(data).pending(), []);
      return;
    }
    assert.equal(claims.length, 1); assert.equal(claims[0].access, access);
    assert.equal(builds.length, 1); assert.equal(builds[0].access, access);
    const invocation = base.build(builds[0]);
    assert.equal(invocation.argv.includes('--dangerously-bypass-approvals-and-sandbox') || invocation.argv.includes('bypassPermissions'), access === 'full_access');
    assert.equal(delivered.length, 1);
    const pending = await new RunnerState(data).pending();
    assert.equal(pending.length, 1); assert.equal(pending[0].body.outcome, 'done'); assert.equal(pending[0].body.access, access);
  });
}
