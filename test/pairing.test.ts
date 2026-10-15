import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api.js';
import { PairingFlow, helperOs, pairingScopes, type PairingReport } from '../src/pairing.js';
import type { Timing } from '../src/config.js';

const epoch = Date.parse('2026-10-14T12:00:00Z');
const deviceCode = 'D'.repeat(43);
const userCode = 'ABCD2345';
const token = `mdai_skill_${'T'.repeat(43)}`;
const report: PairingReport = { helperVersion: '0.1.0', computerName: 'work-mac', os: 'macos', tools: [{ tool: 'codex', variant: 'cli', version: '1.0', models: [], syncOnly: false }] };
const instructions = (extra: object = {}) => ({ deviceCode, userCode, connectUrl: 'https://ai.maddots.app/tools/connect', expiresIn: 300, expiresAt: new Date(epoch + 300_000).toISOString(), interval: 3, ...extra });
const connected = (extra: object = {}) => ({ status: 'connected', token, helperId: 'helper-1', account: { id: 'user-1', name: 'Ana' }, scopes: pairingScopes,
  renewBy: new Date(epoch + 90 * 86_400_000).toISOString(), idleLapseAt: new Date(epoch + 30 * 86_400_000).toISOString(), connections: [{ id: 'connection-1', tool: 'codex', variant: 'cli' }], ...extra });
function fakeClock() {
  let now = epoch;
  const delays: number[] = [];
  const timing: Timing = { now: () => now, sleep: async ms => { delays.push(ms); now += ms; } };
  return { timing, delays };
}

test('Node platforms map to the pairing protocol OS names', () => {
  assert.equal(helperOs('darwin'), 'macos');
  assert.equal(helperOs('win32'), 'windows');
  assert.equal(helperOs('linux'), 'linux');
  assert.equal(helperOs('freebsd'), 'linux');
  assert.equal(helperOs(), helperOs(process.platform));
});

test('pairing exposes a typed code and plain URL, polls at the server interval, and keeps the device code private', async () => {
  const { timing, delays } = fakeClock();
  const requests: { url: string; body: unknown }[] = [];
  const api = new ApiClient(new URL('https://ai.maddots.app'), (async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json({ data: requests.length === 1 ? instructions() : connected() });
  }) as typeof fetch);
  const flow = new PairingFlow(api, timing);
  const pending = await flow.start(report);
  assert.equal(pending.userCode, userCode);
  assert.equal(pending.connectUrl, 'https://ai.maddots.app/tools/connect');
  assert(!JSON.stringify(flow.snapshot()).includes(deviceCode));
  assert.equal((await flow.wait()).token, token);
  assert.deepEqual(delays, [3000]);
  assert(requests.every(request => !request.url.includes(userCode) && !request.url.includes(deviceCode)));
  assert.deepEqual(requests[1].body, { deviceCode });
  assert(!JSON.stringify(requests[0].body).includes(deviceCode));
  await assert.rejects(flow.start(report), { code: 'PAIRING_IN_PROGRESS' });
});

test('pairing honours both seconds and HTTP date Retry-After values', async () => {
  for (const retry of ['12', new Date(epoch + 15_000).toUTCString()]) {
    const { timing, delays } = fakeClock(); let requests = 0;
    const api = new ApiClient(new URL('https://ai.maddots.app'), (async () => {
      requests++;
      if (requests === 1) return Response.json({ data: instructions() });
      if (requests === 2) return Response.json({ error: { code: 'PAIRING_RATE_LIMIT' } }, { status: 429, headers: { 'retry-after': retry } });
      return Response.json({ data: connected() });
    }) as typeof fetch);
    const flow = new PairingFlow(api, timing); await flow.start(report); await flow.wait();
    assert.deepEqual(delays, [3000, 12_000]);
  }
});

test('the helper refuses a code-bearing URL, invalid approval scopes, and credentials embedded in account metadata', async () => {
  for (const value of [instructions({ connectUrl: `https://ai.maddots.app/tools/connect?code=${userCode}` }), instructions({ userCode: 'OOOOOOOO' })]) {
    const flow = new PairingFlow(new ApiClient(new URL('https://ai.maddots.app'), (async () => Response.json({ data: value })) as typeof fetch), fakeClock().timing);
    await assert.rejects(flow.start(report), { code: 'PAIRING_RESPONSE_INVALID' });
  }
  for (const extra of [{ scopes: [...pairingScopes, 'run_claim'] }, { account: { id: 'user-1', name: token } }, { account: { id: deviceCode, name: 'Ana' } }]) {
    let requests = 0;
    const flow = new PairingFlow(new ApiClient(new URL('https://ai.maddots.app'), (async () => Response.json({ data: ++requests === 1 ? instructions() : connected(extra) })) as typeof fetch), fakeClock().timing);
    await flow.start(report);
    await assert.rejects(flow.wait());
  }
});

test('an unapproved pairing stops at five minutes and never polls after expiry', async () => {
  const { timing, delays } = fakeClock(); let requests = 0;
  const flow = new PairingFlow(new ApiClient(new URL('https://ai.maddots.app'), (async () => Response.json({ data: ++requests === 1 ? instructions() : { status: 'pending' } })) as typeof fetch), timing);
  await flow.start(report);
  await assert.rejects(flow.wait(), { code: 'PAIRING_EXPIRED' });
  assert.equal(delays.reduce((total, ms) => total + ms, 0), 300_000);
  assert.equal(requests, 100);
});

test('cancellation interrupts the polling sleep', async () => {
  const timing: Timing = { now: () => epoch, sleep: (_ms, signal) => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error()), { once: true })) };
  const flow = new PairingFlow(new ApiClient(new URL('https://ai.maddots.app'), (async () => Response.json({ data: instructions() })) as typeof fetch), timing);
  await flow.start(report); flow.cancel();
  await assert.rejects(flow.wait(), { code: 'PAIRING_CANCELLED' });
});
