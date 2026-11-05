import assert from 'node:assert/strict';
import {generateKeyPairSync, sign} from 'node:crypto';
import {test} from 'node:test';
import {HelperError} from '../src/config.js';
import {prepareProviderLogin, safeSelectedLoginError} from '../src/runner/linux-login-provider.js';
import {codexProviderFixture, signedProviderJwt, syntheticJwks} from './support/linux-login-provider-fixture.js';

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
const nearExpiry = (f: ReturnType<typeof codexProviderFixture>) => bytes({...f.document,
  tokens: {...f.tokens, access_token: signedProviderJwt({...f.accessClaims, exp: Math.floor((f.now + 120_000) / 1000)})}});

test('controller authenticates every admission and stages an access-only Codex snapshot', async () => {
  const f = codexProviderFixture();
  for (let run = 0; run < 2; run++) {
    const result = await prepareProviderLogin('codex', f.binding, f.source, f.options);
    assert.deepEqual(result.source, f.source, 'unexpired controller bytes remain byte-for-byte unchanged');
    const staged = JSON.parse(result.staged.toString());
    assert.equal(staged.tokens.refresh_token, '');
    assert.equal(staged.tokens.access_token, f.tokens.access_token);
    assert(!result.staged.includes(f.tokens.refresh_token));
  }
  assert.equal(f.requests.length, 2);
  assert(f.requests.every(request => request.url.endsWith('/.well-known/jwks.json')));
});

test('controller refresh uses the pinned grant and retains rotated refresh only in controller source', async () => {
  const f = codexProviderFixture();
  const result = await prepareProviderLogin('codex', f.binding, nearExpiry(f), f.options);
  const source = JSON.parse(result.source.toString()), staged = JSON.parse(result.staged.toString());
  assert.equal(source.tokens.refresh_token, f.refreshResponse.refresh_token);
  assert.equal(source.tokens.id_token, f.refreshResponse.id_token);
  assert.equal(staged.tokens.refresh_token, '');
  assert.equal(staged.tokens.access_token, f.refreshResponse.access_token);
  const request = f.requests.find(request => request.url.endsWith('/oauth/token'))!;
  assert.equal(request.url, 'https://auth.openai.com/oauth/token');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.redirect, 'error');
  assert.equal(request.init.credentials, 'omit');
  assert.deepEqual(JSON.parse(String(request.init.body)), {grant_type: 'refresh_token',
    client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', refresh_token: f.tokens.refresh_token});
});

test('expired signed baseline can refresh, but expired refreshed identity cannot be admitted', async () => {
  const f = codexProviderFixture();
  const expired = signedProviderJwt({...f.claims, exp: Math.floor(f.now / 1000) - 1});
  const source = bytes({...f.document, tokens: {...f.tokens, id_token: expired}});
  assert((await prepareProviderLogin('codex', f.binding, source, f.options)).source.includes(String(f.refreshResponse.id_token)));
  f.refreshResponse.id_token = expired;
  await assert.rejects(prepareProviderLogin('codex', f.binding, source, f.options), {code: 'LINUX_SELECTED_LOGIN_IDENTITY_INVALID'});
});

test('controller refresh recovers after the old ID signing key has left current JWKS', async () => {
  const f = codexProviderFixture();
  const retiredId = signedProviderJwt({...f.claims, exp: Math.floor(f.now / 1000) - 1}, {kid: 'synthetic-retired-key'});
  const source = bytes({...f.document, tokens: {...f.tokens, id_token: retiredId}});
  const result = await prepareProviderLogin('codex', f.binding, source, f.options);
  assert.equal(f.requests[0].url, 'https://auth.openai.com/oauth/token', 'the old ID signature is not a prerequisite to refresh');
  assert.equal(f.requests.filter(request => request.url.endsWith('/.well-known/jwks.json')).length, 1);
  assert.equal(JSON.parse(result.source.toString()).tokens.id_token, f.refreshResponse.id_token);
  assert.equal(JSON.parse(result.staged.toString()).tokens.refresh_token, '');
});

test('retired old signing key cannot admit a refreshed identity that differs from the founder baseline', async () => {
  const f = codexProviderFixture();
  const retiredId = signedProviderJwt({...f.claims, exp: Math.floor(f.now / 1000) - 1}, {kid: 'synthetic-retired-key'});
  const source = bytes({...f.document, tokens: {...f.tokens, id_token: retiredId}});
  f.refreshResponse.id_token = signedProviderJwt({...f.claims, sub: 'different-subject'});
  await assert.rejects(prepareProviderLogin('codex', f.binding, source, f.options), {code: 'LINUX_SELECTED_LOGIN_IDENTITY_INVALID'});
  assert.equal(f.requests[0].url, 'https://auth.openai.com/oauth/token');
  assert.equal(f.requests.filter(request => request.url.endsWith('/.well-known/jwks.json')).length, 1);
});

for (const fault of ['signature', 'issuer', 'audience', 'subject', 'account', 'user', 'algorithm', 'future'] as const) {
  test(`controller rejects ${fault} identity before any refresh`, async () => {
    const f = codexProviderFixture();
    let token = f.tokens.id_token;
    if (fault === 'signature') {
      const parts = token.split('.'); parts[2] = Buffer.alloc(256).toString('base64url'); token = parts.join('.');
    } else {
      const claims: Record<string, unknown> = {...f.claims};
      if (fault === 'issuer') claims.iss = 'https://attacker.invalid';
      if (fault === 'audience') claims.aud = 'different-client';
      if (fault === 'subject') claims.sub = 'different-subject';
      if (fault === 'account') claims['https://api.openai.com/auth'] = {chatgpt_account_id: 'different-account'};
      if (fault === 'user') claims['https://api.openai.com/auth'] = {...f.claims['https://api.openai.com/auth'], chatgpt_user_id: 'different-user'};
      if (fault === 'future') claims.nbf = Math.floor(f.now / 1000) + 120;
      token = signedProviderJwt(claims, fault === 'algorithm' ? {alg: 'HS256'} : {});
    }
    await assert.rejects(prepareProviderLogin('codex', f.binding,
      bytes({...f.document, tokens: {...f.tokens, id_token: token}}), f.options), {code: 'LINUX_SELECTED_LOGIN_IDENTITY_INVALID'});
    assert(!f.requests.some(request => request.url.endsWith('/oauth/token')));
  });
}

for (const fault of ['missing-id', 'signature', 'issuer', 'audience', 'expired-id', 'wrong-subject', 'wrong-account', 'short-access', 'empty-refresh'] as const) {
  test(`controller rejects refreshed tuple with ${fault}`, async () => {
    const f = codexProviderFixture();
    if (fault === 'missing-id') delete f.refreshResponse.id_token;
    if (fault === 'signature') {
      const parts = String(f.refreshResponse.id_token).split('.');
      parts[2] = Buffer.alloc(256).toString('base64url'); f.refreshResponse.id_token = parts.join('.');
    }
    if (fault === 'issuer') f.refreshResponse.id_token = signedProviderJwt({...f.claims, iss: 'https://attacker.invalid'});
    if (fault === 'audience') f.refreshResponse.id_token = signedProviderJwt({...f.claims, aud: 'different-client'});
    if (fault === 'expired-id') f.refreshResponse.id_token = signedProviderJwt({...f.claims, exp: Math.floor(f.now / 1000) - 1});
    if (fault === 'wrong-subject') f.refreshResponse.id_token = signedProviderJwt({...f.claims, sub: 'other'});
    if (fault === 'wrong-account') f.refreshResponse.id_token = signedProviderJwt({...f.claims, 'https://api.openai.com/auth': {chatgpt_account_id: 'other'}});
    if (fault === 'short-access') f.refreshResponse.access_token = signedProviderJwt({...f.accessClaims, exp: Math.floor((f.now + 1000) / 1000)});
    if (fault === 'empty-refresh') f.refreshResponse.refresh_token = '';
    await assert.rejects(prepareProviderLogin('codex', f.binding, nearExpiry(f), f.options), (error: unknown) => {
      assert(error instanceof HelperError); assert(!error.message.includes(f.tokens.refresh_token)); return true;
    });
  });
}

test('refresh response may omit refresh_token but must prove a fresh valid identity', async () => {
  const f = codexProviderFixture(); delete f.refreshResponse.refresh_token;
  const result = await prepareProviderLogin('codex', f.binding, nearExpiry(f), f.options);
  assert.equal(JSON.parse(result.source.toString()).tokens.refresh_token, f.tokens.refresh_token);
});

test('fresh provider identity permits one JWKS reload for a rotated signing key', async () => {
  const f = codexProviderFixture(), rotated = generateKeyPairSync('rsa', {modulusLength: 2048});
  const header = Buffer.from(JSON.stringify({alg: 'RS256', kid: 'synthetic-rotated-key', typ: 'JWT'})).toString('base64url');
  const payload = Buffer.from(JSON.stringify(f.claims)).toString('base64url');
  const data = `${header}.${payload}`;
  f.refreshResponse.id_token = `${data}.${sign('RSA-SHA256', Buffer.from(data), rotated.privateKey).toString('base64url')}`;
  let jwksRequests = 0, grants = 0;
  const fetch = (async (url: string | URL | Request) => {
    if (String(url).endsWith('/oauth/token')) {grants++; return Response.json(f.refreshResponse);}
    jwksRequests++;
    return Response.json(jwksRequests === 1 ? syntheticJwks : {keys: [{
      ...rotated.publicKey.export({format: 'jwk'}), kid: 'synthetic-rotated-key', alg: 'RS256', use: 'sig',
    }]});
  }) as typeof globalThis.fetch;
  const result = await prepareProviderLogin('codex', f.binding, nearExpiry(f), {...f.options, fetch});
  assert.equal(JSON.parse(result.source.toString()).tokens.id_token, f.refreshResponse.id_token);
  assert.equal(jwksRequests, 2); assert.equal(grants, 1);
});

for (const ambiguous of [false, true]) test(`fresh unknown key ${ambiguous ? 'ambiguity is never retried' : 'reload stops after one attempt'}`, async () => {
  const f = codexProviderFixture();
  f.refreshResponse.id_token = signedProviderJwt(f.claims, {kid: 'unavailable-key'});
  let jwksRequests = 0;
  const fetch = (async (url: string | URL | Request) => {
    if (String(url).endsWith('/oauth/token')) return Response.json(f.refreshResponse);
    jwksRequests++;
    const duplicate = {...syntheticJwks.keys[0], kid: 'unavailable-key'};
    return Response.json(ambiguous ? {keys: [...syntheticJwks.keys, duplicate, duplicate]} : syntheticJwks);
  }) as typeof globalThis.fetch;
  await assert.rejects(prepareProviderLogin('codex', f.binding, nearExpiry(f), {...f.options, fetch}),
    {code: 'LINUX_SELECTED_LOGIN_JWKS_FAILED'});
  assert.equal(jwksRequests, ambiguous ? 1 : 2);
});

test('access-only source is accepted while fresh and refused when refresh becomes necessary', async () => {
  const f = codexProviderFixture();
  const source = {...f.document, tokens: {...f.tokens, refresh_token: ''}};
  await prepareProviderLogin('codex', f.binding, bytes(source), f.options);
  source.tokens.access_token = signedProviderJwt({...f.accessClaims, exp: Math.floor((f.now + 10_000) / 1000)});
  await assert.rejects(prepareProviderLogin('codex', f.binding, bytes(source), f.options), {code: 'LINUX_SELECTED_LOGIN_REFRESH_REQUIRED'});
});

test('job deadline triggers refresh even outside the CLI five-minute refresh window', async () => {
  const f = codexProviderFixture();
  const source = bytes({...f.document, tokens: {...f.tokens,
    access_token: signedProviderJwt({...f.accessClaims, exp: Math.floor((f.now + 20 * 60_000) / 1000)})}});
  await prepareProviderLogin('codex', f.binding, source, {...f.options, deadline: f.now + 30 * 60_000});
  assert(f.requests.some(request => request.url.endsWith('/oauth/token')));
});

for (const offset of [-1000, 0, 1000]) {
  test(`long-run access admission requires expiry strictly beyond deadline plus CLI window and margin (${offset}ms)`, async () => {
    const f = codexProviderFixture(1_800_000_000_000), deadline = f.now + 3 * 3600_000;
    const expiresAt = deadline + 5 * 60_000 + 60_000 + offset;
    const source = bytes({...f.document, tokens: {...f.tokens,
      access_token: signedProviderJwt({...f.accessClaims, exp: expiresAt / 1000})}});
    const result = await prepareProviderLogin('codex', f.binding, source, {...f.options, deadline});
    assert.equal(f.requests.some(request => request.url.endsWith('/oauth/token')), offset <= 0);
    assert.equal(JSON.parse(result.staged.toString()).tokens.access_token,
      offset <= 0 ? f.refreshResponse.access_token : JSON.parse(source.toString()).tokens.access_token);
  });

  test(`refreshed access must clear the full long-run deadline plus CLI window and margin (${offset}ms)`, async () => {
    const f = codexProviderFixture(1_800_000_000_000), deadline = f.now + 3 * 3600_000;
    f.refreshResponse.access_token = signedProviderJwt({...f.accessClaims,
      exp: (deadline + 5 * 60_000 + 60_000 + offset) / 1000});
    const prepared = prepareProviderLogin('codex', f.binding, nearExpiry(f), {...f.options, deadline});
    if (offset <= 0) await assert.rejects(prepared, {code: 'LINUX_SELECTED_LOGIN_EXPIRED'});
    else assert.equal(JSON.parse((await prepared).staged.toString()).tokens.access_token, f.refreshResponse.access_token);
  });
}

test('bounded provider wait aborts and returns a canonical error without hanging admission', async () => {
  const f = codexProviderFixture(); let signal: AbortSignal | undefined;
  const fetch = ((_url: unknown, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>(() => {});
  }) as typeof globalThis.fetch;
  await assert.rejects(prepareProviderLogin('codex', f.binding, f.source,
    {...f.options, deadline: f.now + 15, fetch}), {code: 'LINUX_SELECTED_LOGIN_JWKS_FAILED'});
  assert.equal(signal?.aborted, true);
});

test('source rejects missing refresh field, duplicate keys and credentials hidden in unknown fields', async () => {
  const f = codexProviderFixture();
  const missing = {...f.tokens} as Record<string, unknown>; delete missing.refresh_token;
  for (const source of [bytes({...f.document, tokens: missing}),
    Buffer.from('{"tokens":{},"tokens":{}}'), bytes({...f.document, providerOverride: f.tokens.refresh_token})]) {
    await assert.rejects(prepareProviderLogin('codex', f.binding, source, f.options));
  }
  assert.equal(f.requests.length, 0);
  assert.equal(safeSelectedLoginError(new Error(f.tokens.refresh_token)).cause, undefined);
});

for (const failure of ['reject', 'redirect', 'oversize', 'malformed', 'duplicate-key', 'ambiguous-kid'] as const) {
  test(`JWKS ${failure} fails closed without leaking provider text`, async () => {
    const f = codexProviderFixture();
    const fetch = (async () => {
      if (failure === 'reject') throw new Error(f.tokens.refresh_token);
      if (failure === 'redirect') return new Response(f.tokens.refresh_token, {status: 302, headers: {Location: 'https://attacker.invalid'}});
      if (failure === 'oversize') return new Response(' '.repeat(65537));
      if (failure === 'malformed') return new Response(f.tokens.refresh_token);
      if (failure === 'duplicate-key') return new Response('{"keys":[],"keys":[]}');
      return Response.json({keys: [...syntheticJwks.keys, ...syntheticJwks.keys]});
    }) as typeof globalThis.fetch;
    await assert.rejects(prepareProviderLogin('codex', f.binding, f.source, {...f.options, fetch}), (error: unknown) => {
      assert(error instanceof HelperError); assert.equal(error.code, 'LINUX_SELECTED_LOGIN_JWKS_FAILED');
      assert(!String(error).includes(f.tokens.refresh_token)); assert.equal(error.cause, undefined); return true;
    });
  });
}

test('provider failure sanitizes even trusted error codes containing credentials', async () => {
  const f = codexProviderFixture();
  const malicious = new HelperError('LINUX_SELECTED_LOGIN_REFRESH_FAILED', f.tokens.refresh_token);
  assert(!safeSelectedLoginError(malicious).message.includes(f.tokens.refresh_token));
  const fetch = (async (url: string | URL | Request) => String(url).endsWith('jwks.json')
    ? Response.json(syntheticJwks) : Promise.reject(malicious)) as typeof globalThis.fetch;
  await assert.rejects(prepareProviderLogin('codex', f.binding, nearExpiry(f), {...f.options, fetch}),
    {code: 'LINUX_SELECTED_LOGIN_REFRESH_FAILED', message: 'The selected login could not be refreshed by the controller.'});
});

test('Claude refuses before network access because its pinned profile identity is unqualified', async () => {
  const f = codexProviderFixture();
  await assert.rejects(prepareProviderLogin('claude', {...f.binding, tool: 'claude'}, Buffer.from('synthetic-token'), f.options),
    {code: 'LINUX_SELECTED_LOGIN_CLAUDE_IDENTITY_UNAVAILABLE'});
  assert.equal(f.requests.length, 0);
});

test('durable refresh preparation precedes the provider grant and its failure prevents rotation', async () => {
  const f = codexProviderFixture();
  await assert.rejects(prepareProviderLogin('codex', f.binding, nearExpiry(f), {...f.options,
    beforeRefresh: async () => {throw new Error(f.tokens.refresh_token);}}), error => {
    assert(!String(error).includes(f.tokens.refresh_token)); return true;
  });
  assert(!f.requests.some(request => request.url.endsWith('/oauth/token')));
});
