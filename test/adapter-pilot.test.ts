import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
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

test('pilot registry resolves tool and harness while both tools remain unoffered', () => {
  assert.equal(adapters.get('codex'), codexAdapter);
  assert.equal(adapters.get('claude-code'), claudeCodeAdapter);
  assert.equal(adapters.get('claude_code'), claudeCodeAdapter);
  for (const adapter of [codexAdapter, claudeCodeAdapter]) {
    const entry = TOOL_MATRIX.tools.find(tool => tool.run?.adapter === adapter.info.tool)!.run!;
    assert.equal(entry.offered, false);
    assert.equal(entry.folderOnly, 'none');
  }
});

for (const base of [codexAdapter, claudeCodeAdapter]) for (const access of ['folder_only', 'full_access'] as const) {
  test(`${base.info.tool} uses ${access} from local agents.json despite opposite server accessWanted`, async t => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'mdai-pilot-access-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const cwd = join(root, 'project with spaces'), data = join(root, 'helper-data');
    await mkdir(cwd); await mkdir(data, { mode: 0o700 });
    const source = base.info.tool === 'codex' ? './fixtures/adapters/codex/fake-codex.mjs' : './fixtures/adapters/claude-code/fake-cli.mjs';
    const bin = join(root, base.info.tool === 'codex' ? 'codex' : 'claude');
    await copyFile(fileURLToPath(new URL(source, import.meta.url)), bin); await chmod(bin, 0o700);
    const ids = { agent: randomUUID(), tool: randomUUID(), device: randomUUID(), run: randomUUID(), card: randomUUID(), board: randomUUID() };
    const agentsFile = join(data, 'agents.json');
    // TLS-25 owns the production reader and confirmation; exercise its existing localAgents hook.
    await writeFile(agentsFile, JSON.stringify([{ agentId: ids.agent, aiToolId: ids.tool, cwd, access }]), { mode: 0o600 });
    const claims: RunnerClaimBody[] = [], builds: RunSpec[] = [], delivered: string[] = [];
    const agent: RunnerAgent = { agentId: ids.agent, name: 'Fixture agent', handle: 'fixture-agent', status: 'active', model: 'fixture-model',
      provider: null, effort: null, accessWanted: access === 'folder_only' ? 'full_access' : 'folder_only', maxRunMinutes: 1, skills: [] };
    const claim: RunnerClaim = { runId: ids.run, agentId: ids.agent, kind: 'assignment', cardId: ids.card, boardId: ids.board, commentId: null,
      expiresAt: new Date(Date.now() + 7_200_000).toISOString(), model: agent.model, provider: null, effort: null, maxRunMinutes: 1, skills: [] };
    const api = new MaddotsApi('pm_run_fixtureOnlyNotARealToken', { fetcher: async input => {
      assert.equal(new URL(String(input)).pathname, `/api/cards/${ids.card}`);
      return Response.json({ data: { card: { title: 'Use the staged fixture skill', description: 'Fixture only' }, comments: [], attachments: [] } });
    } });
    const adapter: Adapter = { ...base, build: input => { builds.push(input); return base.build(input); } };
    const matrix = structuredClone(TOOL_MATRIX);
    Object.assign(matrix.tools.find(tool => tool.run?.adapter === base.info.tool)!.run!, { offered: true, folderOnly: 'os-sandbox' });
    const connection: RunnerConnection = { aiToolId: ids.tool, deviceKeyId: ids.device, tool: base.info.tool, toolVersion: 'fixture', bin, realpath: bin, runsOn: true,
      protocol: {
        heartbeat: async () => ({ heartbeatSeconds: 15, agents: [agent], claimable: [{ runId: ids.run, agentId: ids.agent, kind: 'assignment' }], stop: [] }),
        claim: async body => { claims.push(body); return { claim, api }; },
        outcome: async () => ({ recorded: true }),
      } };
    const core = new RunnerCore({ data, connections: async () => [connection], localAgents: async () => JSON.parse(await readFile(agentsFile, 'utf8')) as LocalAgent[],
      registry: new AdapterRegistry([adapter]), matrix, verifiedBuild: async () => true, allowedBuild: async () => true, removeDeviceKey: async () => {},
      processes: { table: async () => [], fencePids: async () => [], identity: async pid => {
        try { process.kill(pid, 0); return `fixture-${pid}`; } catch { return null; }
      } },
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
    t.after(() => core.close());
    await core.tick(); await core.idle();
    assert.equal(claims.length, 1); assert.equal(claims[0].access, access);
    assert.equal(builds.length, 1); assert.equal(builds[0].access, access);
    const invocation = base.build(builds[0]);
    assert.equal(invocation.argv.includes('--dangerously-bypass-approvals-and-sandbox') || invocation.argv.includes('bypassPermissions'), access === 'full_access');
    assert.equal(delivered.length, 1);
    const pending = await new RunnerState(data).pending();
    assert.equal(pending.length, 1); assert.equal(pending[0].body.outcome, 'done'); assert.equal(pending[0].body.access, access);
  });
}
