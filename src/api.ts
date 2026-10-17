import { HelperError } from './config.js';
import {HELPER_VALIDATION_PATHS_HEADER, helperRouteTemplate, safeHelperInstancePaths, type HelperHttpDiagnostic} from './shared/helper-http-diagnostics.js';

export type Scope = 'sync' | 'import_upload' | 'proposal_upload' | 'run_claim';
export type ApiRequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  token?: string;
  signal?: AbortSignal;
  headers?: HeadersInit;
};
export type ApiResponse<T> = { data: T; headers: Headers; status: number };

const messages: Record<string, string> = {
  TOKEN_REQUIRED: 'Run maddots-ai connect to connect this computer.',
  TOKEN_FOREIGN: 'This credential is not a MadDots AI skills token.',
  TOKEN_INVALID: 'The saved connection is no longer valid. Run maddots-ai connect.',
  TOKEN_ROTATED: 'The saved token was replaced. Retry with the saved connection.',
  TOKEN_REVOKED: 'This computer was disconnected. Run maddots-ai connect.',
  TOKEN_LAPSED: 'This connection lapsed after inactivity. Run maddots-ai connect.',
  TOKEN_RENEW_REQUIRED: 'Renew on ai.maddots.app before syncing resumes.',
  SCOPE_MISSING: 'This connection does not have permission for that operation.',
  INVALID_PAIRING: 'The approval code expired or was declined. Run maddots-ai connect for a new code.',
  PAIRING_RATE_LIMIT: 'Account connection requests are temporarily limited. Retry later.',
  READ_ONLY: 'MadDots AI is temporarily read only. Retry later.',
};

export class ApiError extends HelperError {
  constructor(code: string, readonly status: number, readonly headers: Headers = new Headers(), readonly http?: HelperHttpDiagnostic) {
    super(code, messages[code] ?? 'MadDots AI could not complete the request. Retry later.');
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isSkillsToken(value: unknown): value is string {
  return typeof value === 'string' && /^mdai_skill_[A-Za-z0-9_-]{43}$/.test(value);
}

/** Read the stream rather than trusting Content-Length or buffering an unbounded body. */
export async function boundedJson(response: Response, limit: number): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new HelperError('API_RESPONSE_INVALID', 'MadDots AI returned an invalid response.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    const declared = response.headers.get('content-length');
    if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
      throw new HelperError('API_RESPONSE_TOO_LARGE', 'MadDots AI returned a response above its size limit.');
    }
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > limit) throw new HelperError('API_RESPONSE_TOO_LARGE', 'MadDots AI returned a response above its size limit.');
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!isObject(parsed)) throw new Error();
    return parsed;
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof HelperError) throw error;
    throw new HelperError('API_RESPONSE_INVALID', 'MadDots AI returned an invalid response.');
  } finally { reader.releaseLock(); }
}

export class ApiClient {
  readonly endpoint: URL;
  constructor(endpoint: URL, private readonly fetcher: typeof fetch = fetch) {
    this.endpoint = new URL(endpoint.href);
  }

  async request<T>(path: string, options: ApiRequestOptions = {}): Promise<ApiResponse<T>> {
    // Only helper routes may receive the skills token. Never follow a supplied absolute URL.
    if (!path.startsWith('/api/helper/') || path.includes('\\') || path.includes('#') ||
        new URL(path, this.endpoint.origin).origin !== this.endpoint.origin) {
      throw new HelperError('API_ROUTE_INVALID', 'Use a MadDots AI helper route.');
    }
    const url = new URL(path, this.endpoint.origin);
    if (!url.pathname.startsWith('/api/helper/')) throw new HelperError('API_ROUTE_INVALID', 'Use a MadDots AI helper route.');
    if (options.token !== undefined && !isSkillsToken(options.token)) {
      throw new HelperError('TOKEN_FOREIGN', messages.TOKEN_FOREIGN);
    }
    const headers = new Headers(options.headers);
    // The caller cannot override authentication or smuggle a browser session into this client.
    headers.delete('authorization');
    headers.delete('cookie');
    headers.set('accept', 'application/json');
    if (options.token) headers.set('authorization', `Bearer ${options.token}`);
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    const timeout = AbortSignal.timeout(15_000);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        headers, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal,
      });
    } catch {
      if (options.signal?.aborted) throw new HelperError('API_CANCELLED', 'The MadDots AI request was cancelled.');
      if (timeout.aborted) throw new HelperError('API_TIMEOUT', 'The MadDots AI request timed out. Retry later.');
      throw new HelperError('API_CONNECTION_FAILED', 'Could not reach MadDots AI. Check the connection and retry.');
    }
    if (response.status === 304) return { data: undefined as T, headers: response.headers, status: response.status };
    const httpError = (code: string) => {
      const route = helperRouteTemplate(url.pathname);
      let instancePaths: string[] = [];
      if (code === 'VALIDATION') {
        const paths = response.headers.get(HELPER_VALIDATION_PATHS_HEADER);
        try {if (paths && paths.length <= 8192) instancePaths = safeHelperInstancePaths(JSON.parse(paths));} catch { /* Diagnostics cannot replace the original HTTP failure. */ }
      }
      return new ApiError(code, response.status, response.headers, route ? {
        method: options.method ?? (options.body === undefined ? 'GET' : 'POST'), route, status: response.status, code,
        ...(code === 'VALIDATION' ? {instancePaths} : {}),
      } : undefined);
    };
    const limit = url.pathname.startsWith('/api/helper/builds/') ? 16 * 1024 * 1024
      : url.pathname === '/api/helper/plan' ? 4 * 1024 * 1024 : 1024 * 1024;
    let envelope: Record<string, unknown>;
    try {envelope = await boundedJson(response, limit);}
    catch (error) {if (!response.ok && error instanceof HelperError) throw httpError(error.code); throw error;}
    if (!response.ok) {
      const error = isObject(envelope.error) ? envelope.error : undefined;
      const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'API_FAILED';
      throw httpError(code);
    }
    if (!Object.hasOwn(envelope, 'data')) throw new HelperError('API_RESPONSE_INVALID', 'MadDots AI returned an invalid response envelope.');
    return { data: envelope.data as T, headers: response.headers, status: response.status };
  }
}
