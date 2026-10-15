import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient, type Scope } from '../src/api.js';
import type { Timing } from '../src/config.js';
import type { DetectedTool } from '../src/detect.js';
import { pairingScopes } from '../src/pairing.js';
import type { SecretName, SecretStore } from '../src/secret-store.js';
import type { HelperState } from '../src/state.js';
import { TokenManager } from '../src/token.js';

const day = 86_400_000;
const epoch = Date.parse('2026-01-01T00:00:00Z');
const oldToken = `mdai_skill_${'A'.repeat(43)}`;
const newToken = `mdai_skill_${'B'.repeat(43)}`;
const tool: DetectedTool = { tool: 'codex', variant: 'cli', version: '1.0', models: [], syncOnly: false };
const added: DetectedTool = { tool: 'grok', variant: 'cli', version: '2.0', models: ['grok-model'], syncOnly: false };
const date = (now: number) => new Date(now).toISOString();
function fixture(fetcher: typeof fetch, start = epoch, storage: 'keychain' | 'file' = 'keychain') {
  let now = start;
  let state: HelperState = { format: 1, endpoint: 'https://ai.maddots.app/', status: 'connected', helperId: 'helper-1', account: { id: 'user-1', name: 'Ana' }, scopes: [...pairingScopes],
    issuedAt: date(epoch), renewBy: date(epoch + 90 * day), idleLapseAt: date(start + 30 * day), tools: [tool], pendingTools: [], tokenStorage: storage };
  const secrets = new Map<SecretName, string>([['skills-token', oldToken], ['device-key', 'private-device-key']]);
  const operations: string[] = [];
  let failWrite = false;
  let reads = 0;
  const secretStore: SecretStore = {
    storage,
    get: async name => { operations.push(`get:${name}`); reads++; return secrets.get(name); },
    set: async (name, secret, _scopes?: Scope[]) => { operations.push(`set:${name}`); if (failWrite) throw new Error('write failed'); secrets.set(name, secret); },
    delete: async name => { operations.push(`delete:${name}`); secrets.delete(name); },
  };
  const stateStore = { read: async () => structuredClone(state), write: async (next: HelperState) => { assert(!JSON.stringify(next).includes(oldToken)); assert(!JSON.stringify(next).includes(newToken)); operations.push('state'); state = structuredClone(next); } };
  const reminders: string[] = [];
  const timing: Timing = { now: () => now, sleep: async ms => { now += ms; } };
  const manager = new TokenManager(new ApiClient(new URL(state.endpoint), fetcher), secretStore, stateStore, timing, async message => { reminders.push(message); });
  return { manager, state: () => state, secrets, operations, reminders, reads: () => reads, advance: (ms: number) => { now += ms; }, failWrites: (value: boolean) => { failWrite = value; } };
}
const statusData = (extra: object = {}) => ({ account: { id: 'user-1', name: 'Ana' }, scopes: pairingScopes,
  renewBy: date(epoch + 90 * day), idleLapseAt: date(epoch + 30 * day), connections: [], pending: [], ...extra });

test('rotation saves and verifies the successor before any request switches to it', async () => {
  const usedTokens: string[] = []; let requests = 0;
  const f = fixture((async (url, init) => {
    usedTokens.push(new Headers(init?.headers).get('authorization')!);
    if (String(url).endsWith('/rotate')) return Response.json({ data: { token: newToken, renewBy: date(epoch + 90 * day), idleLapseAt: date(epoch + 30 * day) } });
    return Response.json({ data: { okay: true } }, ++requests === 1 ? { headers: { 'x-mdai-rotate': '1' } } : undefined);
  }) as typeof fetch);
  await f.manager.request('/api/helper/plan');
  assert.equal(f.secrets.get('skills-token'), newToken);
  assert(f.operations.indexOf('set:skills-token') < f.operations.lastIndexOf('get:skills-token'));
  await f.manager.request('/api/helper/plan');
  assert.deepEqual(usedTokens, [`Bearer ${oldToken}`, `Bearer ${oldToken}`, `Bearer ${newToken}`]);
});

test('a failed rotation write retains the predecessor and retries on the next rotation header', async () => {
  const usedTokens: string[] = [];
  const f = fixture((async (url, init) => {
    usedTokens.push(new Headers(init?.headers).get('authorization')!);
    return String(url).endsWith('/rotate') ? Response.json({ data: { token: newToken, renewBy: date(epoch + 90 * day), idleLapseAt: date(epoch + 30 * day) } })
      : Response.json({ data: {} }, { headers: { 'x-mdai-rotate': '1' } });
  }) as typeof fetch);
  f.failWrites(true); await f.manager.request('/api/helper/plan');
  assert.equal(f.secrets.get('skills-token'), oldToken);
  f.failWrites(false); await f.manager.request('/api/helper/plan');
  assert.deepEqual(usedTokens, Array(4).fill(`Bearer ${oldToken}`));
  assert.equal(f.secrets.get('skills-token'), newToken);
});

test('TOKEN_ROTATED and TOKEN_INVALID re-read the saved token once before retrying', async () => {
  for (const code of ['TOKEN_ROTATED', 'TOKEN_INVALID']) {
    let requests = 0;
    const f = fixture((async (_url, init) => {
      requests++;
      if (requests === 1) { f.secrets.set('skills-token', newToken); return Response.json({ error: { code } }, { status: 401 }); }
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${newToken}`);
      return Response.json({ data: {} });
    }) as typeof fetch);
    await f.manager.request('/api/helper/plan');
    assert.equal(f.reads(), 2);
    assert.equal(f.state().status, 'connected');
  }
});

test('only revoke, lapse and invalid after one re-read erase both credentials and enter pair again', async () => {
  for (const code of ['TOKEN_REVOKED', 'TOKEN_LAPSED', 'TOKEN_INVALID', 'TOKEN_ROTATED', 'SCOPE_MISSING']) {
    let requests = 0;
    const f = fixture((async () => { requests++; return Response.json({ error: { code, message: oldToken } }, { status: 401 }); }) as typeof fetch);
    await assert.rejects(f.manager.request('/api/helper/plan'), { code });
    const final = ['TOKEN_REVOKED', 'TOKEN_LAPSED', 'TOKEN_INVALID'].includes(code);
    assert.equal(f.state().status, final ? 'pair_again' : 'connected');
    assert.equal(f.secrets.size, final ? 0 : 2);
    assert.equal(f.state().tools[0].tool, 'codex');
    assert.equal(requests, code === 'TOKEN_INVALID' || code === 'TOKEN_ROTATED' ? 2 : 1);
  }
});

test('local idle lapse also stops before sending a token and clears only credential items', async () => {
  let requests = 0;
  const f = fixture((async () => { requests++; return Response.json({ data: {} }); }) as typeof fetch);
  f.advance(30 * day);
  await assert.rejects(f.manager.request('/api/helper/plan'), { code: 'TOKEN_LAPSED' });
  assert.equal(requests, 0); assert.equal(f.state().status, 'pair_again'); assert.equal(f.secrets.size, 0);
});

test('Renew reminder begins on day 76 and produces at most one dialog a day', async () => {
  const f = fixture((async () => Response.json({ data: {} })) as typeof fetch, epoch + 75 * day);
  assert.equal((await f.manager.status()).renewReminder, false); assert.equal(f.reminders.length, 0);
  f.advance(day);
  assert.equal((await f.manager.status()).renewReminder, true);
  await f.manager.status(); assert.equal(f.reminders.length, 1);
  f.advance(day); await f.manager.status(); assert.equal(f.reminders.length, 2);
});

test('Renew after day 90 resumes syncing with the same token, checking at most hourly while waiting', async () => {
  let requests = 0; const usedTokens: string[] = [];
  const f = fixture((async (url, init) => {
    requests++; usedTokens.push(new Headers(init?.headers).get('authorization')!);
    if (requests === 1) return Response.json({ error: { code: 'TOKEN_RENEW_REQUIRED' } }, { status: 401 });
    return String(url).endsWith('/status') ? Response.json({ data: statusData({ renewBy: date(epoch + 181 * day), idleLapseAt: date(epoch + 121 * day) }) }) : Response.json({ data: {} });
  }) as typeof fetch, epoch + 91 * day);
  await assert.rejects(f.manager.request('/api/helper/plan'), { code: 'TOKEN_RENEW_REQUIRED' });
  assert.equal(f.state().status, 'renew_required'); assert.equal(f.secrets.get('skills-token'), oldToken);
  await assert.rejects(f.manager.refreshStatus(), { code: 'TOKEN_RENEW_REQUIRED' }); assert.equal(requests, 1);
  f.advance(3_600_000);
  await f.manager.request('/api/helper/plan');
  assert.equal(requests, 3); assert.equal(f.state().status, 'connected');
  assert(usedTokens.every(value => value === `Bearer ${oldToken}`));
});

test('later tools are reported as pending and no browser approval route is called', async () => {
  const calls: string[] = [];
  const f = fixture((async (url, init) => {
    calls.push(String(url));
    assert.deepEqual(JSON.parse(String(init?.body)), { tools: [added] });
    return Response.json({ data: { pending: [{ id: 'pending-1', tool: 'grok', variant: 'cli' }], connected: [] } });
  }) as typeof fetch);
  const state = await f.manager.proposeTools([tool, added]);
  assert.deepEqual(state.pendingTools, [added]);
  assert.equal((await f.manager.status()).message, 'Waiting for approval on ai.maddots.app.');
  await f.manager.proposeTools([tool, added]);
  assert.deepEqual(calls, ['https://ai.maddots.app/api/helper/tools']);
});

test('a server run_claim grant is refused with file storage without clearing the credential', async () => {
  const f = fixture((async () => Response.json({ data: statusData({ scopes: [...pairingScopes, 'run_claim'] }) })) as typeof fetch, epoch, 'file');
  await assert.rejects(f.manager.refreshStatus(), { code: 'FILE_RUNS_REFUSED' });
  assert.equal(f.state().status, 'connected'); assert.equal(f.secrets.get('skills-token'), oldToken);
});

test('pairing verifies persistence and stores metadata without secrets', async () => {
  const f = fixture((async () => Response.json({ data: {} })) as typeof fetch);
  await f.manager.acceptPairing({ token: newToken, helperId: 'helper-2', account: { id: 'user-1', name: 'Ana' }, scopes: pairingScopes,
    renewBy: date(epoch + 90 * day), idleLapseAt: date(epoch + 30 * day), connections: [{ id: 'connection-1', tool: 'codex', variant: 'cli' }] }, [tool]);
  assert.equal(f.state().helperId, 'helper-2'); assert.equal(f.secrets.get('skills-token'), newToken);
  assert(!JSON.stringify(f.state()).includes(newToken));
});

test('a failed rotation never repeats the successful POST that triggered it', async () => {
  let mutations = 0; let rotations = 0;
  const f = fixture((async url => {
    if (String(url).endsWith('/rotate')) {
      rotations++;
      return Response.json({ error: { code: 'TOKEN_INVALID' } }, { status: 401 });
    }
    mutations++;
    return Response.json({ data: { accepted: true } }, { headers: { 'x-mdai-rotate': '1' } });
  }) as typeof fetch);
  await assert.rejects(f.manager.request('/api/helper/proposals', { method: 'POST', body: { proposal: 'once' } }), { code: 'TOKEN_INVALID' });
  assert.equal(mutations, 1); assert.equal(rotations, 2); assert.equal(f.state().status, 'pair_again');
});

test('hourly detection records its time and refreshes versions even when there are no new tools', async () => {
  let requests = 0;
  const f = fixture((async () => { requests++; return Response.json({ data: {} }); }) as typeof fetch);
  const updatedTool = { ...tool, version: '3.0', models: ['new-model'] };
  const state = await f.manager.proposeTools([updatedTool]);
  assert.equal(requests, 0); assert.deepEqual(state.tools, [updatedTool]); assert.equal(state.lastDetectionAt, date(epoch));
  f.advance(3_600_000); await f.manager.proposeTools([updatedTool]);
  assert.equal(f.state().lastDetectionAt, date(epoch + 3_600_000));
});

test('pending tools disappear only after server status says the approval is no longer pending', async () => {
  let requests = 0;
  const f = fixture((async () => Response.json({ data: ++requests === 1 ? { pending: [{ tool: 'grok', variant: 'cli' }], connected: [] } : statusData() })) as typeof fetch);
  await f.manager.proposeTools([tool, added]); assert.deepEqual(f.state().pendingTools, [added]);
  await f.manager.refreshStatus(); assert.deepEqual(f.state().pendingTools, []);
});

test('a later tool whose seven-day approval expired is proposed again, while initial unticked tools stay untouched', async () => {
  const initialUnticked: DetectedTool = { tool: 'claude-code', variant: 'cli', version: '1.0', models: [], syncOnly: false };
  let proposals = 0;
  const f = fixture((async (url, init) => {
    if (String(url).endsWith('/status')) return Response.json({ data: statusData({
      idleLapseAt: date(epoch + 37 * day), connections: [{ id: 'connection-1', tool: 'codex', variant: 'cli' }],
    }) });
    proposals++;
    assert.deepEqual(JSON.parse(String(init?.body)), { tools: [added] });
    return Response.json({ data: { pending: [{ tool: 'grok', variant: 'cli' }], connected: [] } });
  }) as typeof fetch);
  await f.manager.acceptPairing({ token: oldToken, helperId: 'helper-1', account: { id: 'user-1', name: 'Ana' }, scopes: pairingScopes,
    renewBy: date(epoch + 90 * day), idleLapseAt: date(epoch + 30 * day), connections: [{ id: 'connection-1', tool: 'codex', variant: 'cli' }] }, [tool, initialUnticked]);
  await f.manager.proposeTools([tool, initialUnticked, added]);
  assert.deepEqual(f.state().proposedTools, [{ tool: 'grok', variant: 'cli' }]);
  f.advance(7 * day);
  await f.manager.refreshStatus();
  assert.deepEqual(f.state().pendingTools, []);
  await f.manager.proposeTools([tool, initialUnticked, added]);
  assert.equal(proposals, 2); assert.deepEqual(f.state().pendingTools, [added]);
  assert.deepEqual(f.state().connections, [{ id: 'connection-1', tool: 'codex', variant: 'cli' }]);
});

test('a cooldown-suppressed later tool remains tracked for a future server-controlled retry', async () => {
  let proposals = 0;
  const f = fixture((async () => {
    proposals++;
    return Response.json({ data: { pending: [], connected: [] } });
  }) as typeof fetch);
  await f.manager.proposeTools([tool, added]);
  assert.deepEqual(f.state().pendingTools, []);
  assert.deepEqual(f.state().proposedTools, [{ tool: 'grok', variant: 'cli' }]);
  f.advance(3_600_000);
  await f.manager.proposeTools([tool, added]);
  assert.equal(proposals, 2);
});
