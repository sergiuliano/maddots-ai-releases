import {createHash, createPublicKey, verify, type JsonWebKey} from 'node:crypto';
import {parseJsonWithoutDuplicateKeys} from '../shared/strict-json.js';
import {HelperError} from '../config.js';

export type LinuxSelectedLoginTool = 'codex' | 'claude';
export type LinuxSelectedLoginBinding = Readonly<{
  version: 1; tool: LinuxSelectedLoginTool; profileId: string; accountBinding: string;
  subjectBinding?: string; userBinding?: string; organizationBinding?: string; expiresAt?: number;
  /** Founder-provisioned exact file-byte SHA-256 pins, never credential bytes. */
  files?: Readonly<Record<string, string>>;
}>;
export type ProviderLoginOptions = {
  /** Absolute epoch milliseconds, including the complete admitted workload. */
  deadline: number;
  /** Controller-owned test seams, never workload or user configuration. */
  fetch?: typeof globalThis.fetch; now?: () => number;
  /** Caller durably records refresh uncertainty before the provider can rotate. */
  beforeRefresh?: () => Promise<void>;
};
export type PreparedProviderLogin = {source: Buffer; staged: Buffer};

const MESSAGES = Object.freeze({
  LINUX_SELECTED_LOGIN_UNAVAILABLE: 'The selected login could not be transported or completed safely.',
  LINUX_SELECTED_LOGIN_CONFLICT: 'Selected login recovery is required before this profile can be reused.',
  LINUX_SELECTED_LOGIN_REFRESH_UNVERIFIED: 'Selected login refresh requires independently verified credentials; protected recovery is retained.',
  LINUX_SELECTED_LOGIN_CLAUDE_IDENTITY_UNAVAILABLE: 'The Claude setup token requires a founder-provisioned identity pin.',
  LINUX_SELECTED_LOGIN_JWKS_FAILED: 'The selected login signing keys could not be verified.',
  LINUX_SELECTED_LOGIN_REFRESH_FAILED: 'The selected login could not be refreshed by the controller.',
  LINUX_SELECTED_LOGIN_IDENTITY_INVALID: 'The selected login identity or signed token is invalid.',
  LINUX_SELECTED_LOGIN_EXPIRED: 'The selected login does not remain valid for the admitted workload.',
  LINUX_SELECTED_LOGIN_REFRESH_REQUIRED: 'The selected login requires a controller refresh credential.',
});
export type SelectedLoginErrorCode = keyof typeof MESSAGES;
export function selectedLoginError(code: SelectedLoginErrorCode = 'LINUX_SELECTED_LOGIN_UNAVAILABLE'): HelperError {
  return new HelperError(code, MESSAGES[code]);
}
export function safeSelectedLoginError(error: unknown): HelperError {
  return selectedLoginFailure(error) ?? selectedLoginError();
}
export function selectedLoginFailure(error: unknown): HelperError | undefined {
  return error instanceof HelperError && Object.hasOwn(MESSAGES, error.code)
    ? selectedLoginError(error.code as SelectedLoginErrorCode) : undefined;
}
function refuse(code: SelectedLoginErrorCode = 'LINUX_SELECTED_LOGIN_IDENTITY_INVALID'): never {throw selectedLoginError(code);}

// Pinned Codex rust-v0.162.1: login/src/auth/manager.rs (199, 1525-1545,
// 1611-1622), login/src/oauth/client.rs (71-102), token_data.rs (9-23).
// https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/login/src/auth/manager.rs
const ISSUER = 'https://auth.openai.com';
const JWKS = 'https://auth.openai.com/.well-known/jwks.json';
const TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const SKEW = 60_000;
// The staged CLI has no usable grant. Pinned manager.rs:192,2818-2832 refreshes
// at five minutes to access expiry, so keep that window beyond the whole run,
// in addition to the clock/admission margin.
const CLI_REFRESH_WINDOW = 5 * 60_000;
const MAX_BYTES = 64 * 1024;
type RecordValue = Record<string, unknown>;
type CodexTokens = {id_token: string; access_token: string; refresh_token: string; account_id: string};
type CodexDocument = {auth_mode?: 'chatgpt'; OPENAI_API_KEY?: null; tokens: CodexTokens; last_refresh?: string | null};

function object(value: unknown): value is RecordValue {return value !== null && typeof value === 'object' && !Array.isArray(value);}
function string(value: unknown, max = 16_384): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/\p{Cc}/u.test(value);
}
function keys(value: RecordValue, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) refuse();
}
function json(bytes: Buffer): RecordValue {
  if (!bytes.length || bytes.length > MAX_BYTES) refuse();
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) refuse();
  const value: unknown = parseJsonWithoutDuplicateKeys(text);
  if (!object(value)) refuse();
  return value;
}
function binding(selected: LinuxSelectedLoginBinding, tool: LinuxSelectedLoginTool): void {
  if (selected.version !== 1 || selected.tool !== tool || !string(selected.profileId, 256) || !string(selected.accountBinding, 256)) refuse();
  if (tool === 'codex' && !string(selected.subjectBinding, 256)) refuse();
  for (const field of ['userBinding', 'organizationBinding'] as const) {
    if (selected[field] !== undefined && !string(selected[field], 256)) refuse();
  }
}
function claudeLogin(source: Buffer, selected: LinuxSelectedLoginBinding, deadline: number): PreparedProviderLogin {
  if (!object(selected.files) || Object.keys(selected.files).length !== 1 ||
      typeof selected.files['oauth-token'] !== 'string' || !/^[a-f0-9]{64}$/u.test(selected.files['oauth-token'])) {
    refuse('LINUX_SELECTED_LOGIN_CLAUDE_IDENTITY_UNAVAILABLE');
  }
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
  if (!uuid.test(selected.accountBinding) || !selected.organizationBinding || !uuid.test(selected.organizationBinding)) refuse();
  const horizon = deadline + SKEW;
  if (!Number.isSafeInteger(horizon) || !Number.isSafeInteger(selected.expiresAt) || selected.expiresAt! <= horizon) {
    refuse('LINUX_SELECTED_LOGIN_EXPIRED');
  }
  const token = source.toString('utf8');
  if (source.length > 16_384 || !string(token) || /\s/u.test(token) || !Buffer.from(token).equals(source) ||
      createHash('sha256').update(source).digest('hex') !== selected.files['oauth-token']) refuse();
  // This proves continuity with the founder's attribution, not an independent
  // provider identity. Never repin on admission or infer identity from the token.
  return {source: Buffer.from(source), staged: Buffer.from(source)};
}
function codexDocument(bytes: Buffer, selected: LinuxSelectedLoginBinding): CodexDocument {
  const value = json(bytes); keys(value, ['auth_mode', 'OPENAI_API_KEY', 'tokens', 'last_refresh']);
  if ((value.auth_mode !== undefined && value.auth_mode !== 'chatgpt') ||
      (value.OPENAI_API_KEY !== undefined && value.OPENAI_API_KEY !== null)) refuse();
  if (value.last_refresh !== undefined && value.last_refresh !== null &&
      (typeof value.last_refresh !== 'string' || !Number.isFinite(Date.parse(value.last_refresh)))) refuse();
  if (!object(value.tokens)) refuse();
  keys(value.tokens, ['id_token', 'access_token', 'refresh_token', 'account_id']);
  const tokens = value.tokens;
  if (!string(tokens.id_token) || !string(tokens.access_token) ||
      !(tokens.refresh_token === '' || string(tokens.refresh_token)) || tokens.account_id !== selected.accountBinding) refuse();
  return value as CodexDocument;
}
function segment(value: string): Buffer {
  if (!value || value.length > MAX_BYTES || !/^[A-Za-z0-9_-]+$/u.test(value)) refuse();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) refuse();
  return bytes;
}
function jwt(value: string): {header: RecordValue; claims: RecordValue; data: string; signature: Buffer} {
  const parts = value.split('.');
  if (parts.length !== 3) refuse();
  return {header: json(segment(parts[0])), claims: json(segment(parts[1])),
    data: `${parts[0]}.${parts[1]}`, signature: segment(parts[2])};
}
function expiration(claims: RecordValue): number {
  if (!Number.isSafeInteger(claims.exp) || Number(claims.exp) <= 0 || Number(claims.exp) > Number.MAX_SAFE_INTEGER / 1000) refuse();
  return Number(claims.exp) * 1000;
}

async function request(url: string, init: RequestInit, options: ProviderLoginOptions, code: SelectedLoginErrorCode): Promise<RecordValue> {
  const now = options.now ?? Date.now;
  const remaining = Math.min(10_000, options.deadline - now());
  if (remaining <= 0) refuse('LINUX_SELECTED_LOGIN_EXPIRED');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {controller.abort(); reject(selectedLoginError(code));}, remaining);
    });
    const result = (async () => {
      const response = await (options.fetch ?? fetch)(url, {...init, signal: controller.signal,
        redirect: 'error', credentials: 'omit', cache: 'no-store'});
      if (response.status !== 200 || (response.url && response.url !== url) || response.redirected) refuse(code);
      const declared = response.headers.get('content-length');
      if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BYTES)) refuse(code);
      if (!response.body) refuse(code);
      const reader = response.body.getReader(), chunks: Buffer[] = [];
      let length = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.length;
          if (length > MAX_BYTES) refuse(code);
          chunks.push(Buffer.from(chunk.value));
        }
      } finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
      return json(Buffer.concat(chunks));
    })();
    return await Promise.race([result, timeout]);
  } catch {throw selectedLoginError(code);} finally {if (timer) clearTimeout(timer); controller.abort();}
}

async function idIdentity(token: string, selected: LinuxSelectedLoginBinding,
  options: ProviderLoginOptions): Promise<{expiresAt: number}> {
  const decoded = jwt(token), {header, claims} = decoded;
  if (header.alg !== 'RS256' || !string(header.kid, 256)) refuse();
  keys(header, ['alg', 'kid', 'typ']);
  if (header.typ !== undefined && header.typ !== 'JWT') refuse();
  let keySet = await request(JWKS, {method: 'GET', headers: {Accept: 'application/json'}}, options, 'LINUX_SELECTED_LOGIN_JWKS_FAILED');
  if (!Array.isArray(keySet.keys) || !keySet.keys.length || keySet.keys.length > 64) refuse('LINUX_SELECTED_LOGIN_JWKS_FAILED');
  let matches = keySet.keys.filter(key => object(key) && key.kid === header.kid);
  // A grant can rotate its signing key before JWKS publication reaches us.
  // Reload the same pinned issuer endpoint at most once, never retry ambiguity.
  if (matches.length === 0) {
    keySet = await request(JWKS, {method: 'GET', headers: {Accept: 'application/json'}}, options, 'LINUX_SELECTED_LOGIN_JWKS_FAILED');
    if (!Array.isArray(keySet.keys) || !keySet.keys.length || keySet.keys.length > 64) refuse('LINUX_SELECTED_LOGIN_JWKS_FAILED');
    matches = keySet.keys.filter(key => object(key) && key.kid === header.kid);
  }
  if (matches.length !== 1) refuse('LINUX_SELECTED_LOGIN_JWKS_FAILED');
  const key = matches[0] as RecordValue;
  if (key.kty !== 'RSA' || (key.alg !== undefined && key.alg !== 'RS256') || (key.use !== undefined && key.use !== 'sig') ||
      (key.key_ops !== undefined && (!Array.isArray(key.key_ops) || !key.key_ops.includes('verify'))) ||
      !string(key.n) || !string(key.e)) refuse('LINUX_SELECTED_LOGIN_JWKS_FAILED');
  try {
    const publicKey = createPublicKey({key: key as JsonWebKey, format: 'jwk'});
    const modulus = publicKey.asymmetricKeyDetails?.modulusLength;
    if (!modulus || modulus < 2048 || modulus > 8192 || !verify('RSA-SHA256', Buffer.from(decoded.data), publicKey, decoded.signature)) refuse();
  } catch {refuse();}
  const audience = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
  if (claims.iss !== ISSUER || claims.sub !== selected.subjectBinding || !Array.isArray(audience) ||
      audience.length < 1 || audience.length > 16 || !audience.every(value => string(value, 256)) || !audience.includes(CLIENT_ID) ||
      (claims.azp !== undefined && claims.azp !== CLIENT_ID) || (audience.length > 1 && claims.azp !== CLIENT_ID)) refuse();
  const now = (options.now ?? Date.now)();
  for (const name of ['nbf', 'iat']) if (claims[name] !== undefined &&
    (!Number.isSafeInteger(claims[name]) || Number(claims[name]) * 1000 > now + SKEW)) refuse();
  const auth = claims['https://api.openai.com/auth'];
  if (!object(auth) || auth.chatgpt_account_id !== selected.accountBinding) refuse();
  if (selected.userBinding !== undefined && (auth.chatgpt_user_id ?? auth.user_id) !== selected.userBinding) refuse();
  return {expiresAt: expiration(claims)};
}

/** No filesystem access and no CLI invocation. The caller retains the exclusive
 * profile lock and atomically persists source before making staged bytes visible.
 * Only trusted source bytes or the fixed authenticated grant enter this function. */
export async function prepareProviderLogin(tool: LinuxSelectedLoginTool, selected: LinuxSelectedLoginBinding,
  source: Buffer, options: ProviderLoginOptions): Promise<PreparedProviderLogin> {
  try {
    binding(selected, tool);
    const now = options.now ?? Date.now;
    if (!Number.isSafeInteger(options.deadline) || options.deadline <= now()) refuse('LINUX_SELECTED_LOGIN_EXPIRED');
    if (tool === 'claude') return claudeLogin(source, selected, options.deadline);
    let document = codexDocument(source, selected);
    const accessExpiry = expiration(jwt(document.tokens.access_token).claims);
    const identityExpiry = expiration(jwt(document.tokens.id_token).claims);
    const horizon = options.deadline + CLI_REFRESH_WINDOW + SKEW;
    if (!Number.isSafeInteger(horizon)) refuse('LINUX_SELECTED_LOGIN_EXPIRED');
    let result = Buffer.from(source);
    // Source expiries select the grant path only. Its independently signed fresh
    // identity is the admission authority, so a retired old ID signing key
    // cannot prevent an otherwise valid stored grant from recovering the login.
    if (accessExpiry <= horizon || identityExpiry <= now() + SKEW) {
      if (!document.tokens.refresh_token) refuse('LINUX_SELECTED_LOGIN_REFRESH_REQUIRED');
      await options.beforeRefresh?.();
      const fresh = await request(TOKEN_ENDPOINT, {method: 'POST', headers: {'Content-Type': 'application/json', Accept: 'application/json'},
        body: JSON.stringify({grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: document.tokens.refresh_token})},
      options, 'LINUX_SELECTED_LOGIN_REFRESH_FAILED');
      // Unlike the CLI's optional ID response, this controller needs a fresh,
      // independently verified identity from the very same authenticated grant.
      if (!string(fresh.id_token) || !string(fresh.access_token) ||
          (fresh.refresh_token !== undefined && !string(fresh.refresh_token))) refuse('LINUX_SELECTED_LOGIN_REFRESH_UNVERIFIED');
      const identity = await idIdentity(fresh.id_token, selected, options);
      if (identity.expiresAt <= now() + SKEW) refuse('LINUX_SELECTED_LOGIN_IDENTITY_INVALID');
      if (expiration(jwt(fresh.access_token).claims) <= horizon) refuse('LINUX_SELECTED_LOGIN_EXPIRED');
      document = {auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: {
        id_token: fresh.id_token, access_token: fresh.access_token,
        refresh_token: typeof fresh.refresh_token === 'string' ? fresh.refresh_token : document.tokens.refresh_token,
        account_id: selected.accountBinding,
      }, last_refresh: new Date(now()).toISOString()};
      result = Buffer.from(JSON.stringify(document) + '\n');
    } else {
      const identity = await idIdentity(document.tokens.id_token, selected, options);
      if (identity.expiresAt <= now() + SKEW) refuse('LINUX_SELECTED_LOGIN_IDENTITY_INVALID');
    }
    if (now() >= options.deadline) refuse('LINUX_SELECTED_LOGIN_EXPIRED');
    // refresh_token has no serde default in the pinned CLI: absent/null rejects,
    // while an empty string deserializes and gives the workload no refresh grant.
    const staged = Buffer.from(JSON.stringify({auth_mode: 'chatgpt', OPENAI_API_KEY: null,
      tokens: {...document.tokens, refresh_token: ''}, last_refresh: new Date(now()).toISOString()}) + '\n');
    return {source: result, staged};
  } catch (error) {throw safeSelectedLoginError(error);}
}
