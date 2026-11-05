import {generateKeyPairSync, sign} from 'node:crypto';
import type {LinuxSelectedLoginBinding, ProviderLoginOptions} from '../../src/runner/linux-login-provider.js';

// Every credential in this helper is synthetic. No installed CLI or user state
// is consulted; the RSA key exists only to exercise controller verification.
const pair = generateKeyPairSync('rsa', {modulusLength: 2048});
export const syntheticJwks = {keys: [{...pair.publicKey.export({format: 'jwk'}), kid: 'synthetic-provider-key', alg: 'RS256', use: 'sig'}]};
export const syntheticClientId = 'app_EMoamEEZ73f0CkXaXp7hrann';
export function signedProviderJwt(claims: Record<string, unknown>, header: Record<string, unknown> = {}): string {
  const data = `${Buffer.from(JSON.stringify({alg: 'RS256', kid: 'synthetic-provider-key', typ: 'JWT', ...header})).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), pair.privateKey).toString('base64url')}`;
}
export function codexProviderFixture(now = Date.now()) {
  const deadline = now + 60_000;
  const binding: LinuxSelectedLoginBinding = {version: 1, tool: 'codex', profileId: 'profile-fixture',
    accountBinding: 'account-fixture-1', subjectBinding: 'subject-fixture-1', userBinding: 'user-fixture-1'};
  const claims = {iss: 'https://auth.openai.com', aud: syntheticClientId, sub: binding.subjectBinding,
    exp: Math.floor((now + 24 * 3600_000) / 1000),
    'https://api.openai.com/auth': {chatgpt_account_id: binding.accountBinding, chatgpt_user_id: binding.userBinding}};
  const accessClaims = {exp: claims.exp, aud: 'https://api.openai.com/v1'};
  const tokens = {id_token: signedProviderJwt(claims), access_token: signedProviderJwt(accessClaims),
    refresh_token: 'synthetic-controller-refresh-token', account_id: binding.accountBinding};
  const document = {auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens, last_refresh: new Date(now).toISOString()};
  const requests: {url: string; init: RequestInit}[] = [];
  const fixture = {now, deadline, binding, claims, accessClaims, tokens, document, requests,
    source: Buffer.from(JSON.stringify(document) + '\n'),
    refreshResponse: {id_token: signedProviderJwt({...claims, iat: Math.floor(now / 1000)}),
      access_token: signedProviderJwt({...accessClaims, iat: Math.floor(now / 1000)}), refresh_token: 'synthetic-rotated-controller-token'} as Record<string, unknown>,
    fetch: undefined as unknown as typeof globalThis.fetch,
    options: undefined as unknown as ProviderLoginOptions};
  fixture.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const address = String(url); requests.push({url: address, init});
    if (address === 'https://auth.openai.com/.well-known/jwks.json') return Response.json(syntheticJwks);
    if (address === 'https://auth.openai.com/oauth/token') return Response.json(fixture.refreshResponse);
    throw new Error('Unexpected synthetic provider endpoint');
  }) as typeof globalThis.fetch;
  fixture.options = {deadline, now: () => now, fetch: fixture.fetch};
  return fixture;
}
