import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient, ApiError, boundedJson } from '../src/api.js';

const endpoint = new URL('https://ai.maddots.app');
const token = `mdai_skill_${'A'.repeat(43)}`;

test('helper requests omit cookies, refuse redirects, use a timeout, and attach only a skills token', async () => {
  const api = new ApiClient(endpoint, (async (input, init) => {
    assert.equal(String(input), 'https://ai.maddots.app/api/helper/status');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.referrerPolicy, 'no-referrer');
    assert(init?.signal instanceof AbortSignal);
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token}`);
    assert.equal(new Headers(init?.headers).get('cookie'), null);
    return Response.json({ data: { okay: true } });
  }) as typeof fetch);
  assert.deepEqual((await api.request('/api/helper/status', { token, headers: { cookie: 'session=bad', authorization: 'Bearer pm_bad' } })).data, { okay: true });
  await assert.rejects(api.request('/api/helper/status', { token: 'pm_foreign' }), { code: 'TOKEN_FOREIGN' });
});

test('authenticated requests cannot leave helper routes or the endpoint origin', async () => {
  let requests = 0;
  const api = new ApiClient(endpoint, (async () => { requests++; return Response.json({ data: {} }); }) as typeof fetch);
  for (const path of ['https://other.test/api/helper/status', '//other.test/api/helper/status', '/api/tools/status', '/api/helper/../../tools/status', '/api/helper/../tools/status', '/api/helper/status#secret', '/api/helper/\\other.test']) {
    await assert.rejects(api.request(path, { token }), { code: 'API_ROUTE_INVALID' });
  }
  assert.equal(requests, 0);
});

test('bounded JSON cancels oversized streams even when Content-Length lies', async () => {
  let cancelled = false;
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { if (!sent) { sent = true; controller.enqueue(new Uint8Array(1025)); } },
    cancel() { cancelled = true; },
  });
  await assert.rejects(boundedJson(new Response(stream, { headers: { 'content-length': '1' } }), 1024), { code: 'API_RESPONSE_TOO_LARGE' });
  assert(cancelled);
  await assert.rejects(boundedJson(Response.json({ data: 'x' }, { headers: { 'content-length': '100000' } }), 10), { code: 'API_RESPONSE_TOO_LARGE' });
});

test('response limits are one MiB normally, four for plans, sixteen for builds', async () => {
  const large = 'x'.repeat(1024 * 1024);
  const api = new ApiClient(endpoint, (async () => Response.json({ data: large })) as typeof fetch);
  await assert.rejects(api.request('/api/helper/status'), { code: 'API_RESPONSE_TOO_LARGE' });
  assert.equal((await api.request<string>('/api/helper/plan')).data.length, large.length);
  const buildSize = 'x'.repeat(4 * 1024 * 1024);
  const buildApi = new ApiClient(endpoint, (async () => Response.json({ data: buildSize })) as typeof fetch);
  await assert.rejects(buildApi.request('/api/helper/plan'), { code: 'API_RESPONSE_TOO_LARGE' });
  assert.equal((await buildApi.request<string>('/api/helper/builds/digest')).data.length, buildSize.length);
});

test('bad envelopes, malformed JSON, and raw error text cannot leak server secrets', async () => {
  for (const body of ['[]', 'not JSON', '{"other":{}}', '{"data":"\u0000"}']) {
    const api = new ApiClient(endpoint, (async () => new Response(body)) as typeof fetch);
    await assert.rejects(api.request('/api/helper/status'), { code: 'API_RESPONSE_INVALID' });
  }
  const api = new ApiClient(endpoint, (async () => Response.json({ error: { code: 'TOKEN_REVOKED', message: token } }, { status: 401 })) as typeof fetch);
  await assert.rejects(api.request('/api/helper/status'), (error: unknown) => error instanceof ApiError && error.code === 'TOKEN_REVOKED' && !error.message.includes(token));
  const network = new ApiClient(endpoint, (async () => { throw new Error(token); }) as typeof fetch);
  await assert.rejects(network.request('/api/helper/status'), (error: unknown) => error instanceof Error && !error.message.includes(token));
});

test('a 304 plan response has no JSON body, and caller cancellation is preserved', async () => {
  const api = new ApiClient(endpoint, (async () => new Response(null, { status: 304 })) as typeof fetch);
  assert.equal((await api.request('/api/helper/plan')).status, 304);
  const controller = new AbortController(); controller.abort();
  const cancelled = new ApiClient(endpoint, (async () => { throw new Error('private'); }) as typeof fetch);
  await assert.rejects(cancelled.request('/api/helper/status', { signal: controller.signal }), { code: 'API_CANCELLED' });
});
