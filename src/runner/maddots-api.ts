import {inspect} from 'node:util';
import {RUN_TOKEN_POLICY, RUN_TOKEN_FINAL_REFUSAL_CODES, RUN_TOKEN_PREFIX} from '../shared/runner-protocol.js';
import {boundedJson, isObject} from '../api.js';
import {HelperError} from '../config.js';
import {MADDOTS_ORIGIN, RELEASE} from '../release-identity.js';

export type MadDotsFailureClass = 'final' | 'retry' | 'failed';
export type MadDotsOptions = {env?: NodeJS.ProcessEnv; fetcher?: typeof fetch};
export type RunTokenStatus = {live: true; runId: string; kind: 'assignment' | 'mention'; cardId: string; expiresAt: string};
type WriteRequest = {body: string | Uint8Array; contentType: string; idempotencyKey: string};
export {RUN_TOKEN_POLICY, RUN_TOKEN_FINAL_REFUSAL_CODES};

/** Status, rather than an untrusted error body, is authoritative. */
export function classifyMadDotsFailure(path: string, status?: number, code?: string): MadDotsFailureClass {
  if (status === 401 || status === 403 || path === '/api/run-token' && status !== undefined && status >= 400 && status < 500 && status !== 429 ||
    /^\/api\/cards\/[^/]+$/.test(path) && status === 404) return 'final';
  if (status === undefined || status >= 500 || status >= 300 && status < 400 || status === 429 || status === 409 && code === 'COMMENT_DELIVERY_BUSY') return 'retry';
  return 'failed';
}
export class MadDotsApiError extends HelperError {
  readonly classification: MadDotsFailureClass;
  constructor(code: string, readonly status: number | undefined, path: string) {
    super(code, 'MadDots could not complete the runner request.');
    this.classification = classifyMadDotsFailure(path, status, code);
  }
}
export function maddotsOrigin(env: NodeJS.ProcessEnv = process.env): URL {
  let url: URL;
  try {url = new URL(!RELEASE && env.MADDOTS_URL ? env.MADDOTS_URL : MADDOTS_ORIGIN);}
  catch {throw new HelperError('CONFIG_INVALID', 'The MadDots origin is invalid.');}
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
    url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && env.MADDOTS_AI_ALLOW_INSECURE_LOOPBACK === '1')) {
    throw new HelperError('CONFIG_INVALID', 'MadDots requires an HTTPS origin; HTTP loopback requires explicit opt-in.');
  }
  return url;
}
function id(value: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) throw new HelperError('API_ROUTE_INVALID', 'The MadDots resource id is invalid.');
  return value;
}
async function bytes(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new HelperError('API_RESPONSE_INVALID', 'MadDots returned an invalid attachment.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    const declared = response.headers.get('content-length');
    if (declared && /^\d+$/.test(declared) && Number(declared) > limit) throw new HelperError('API_RESPONSE_TOO_LARGE', 'The attachment exceeds its size limit.');
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new HelperError('API_RESPONSE_TOO_LARGE', 'The attachment exceeds its size limit.');
      chunks.push(chunk.value);
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {result.set(chunk, offset); offset += chunk.byteLength;}
    return result;
  } catch (error) {await reader.cancel().catch(() => {}); throw error;}
  finally {reader.releaseLock();}
}

/** The run bearer has exactly one durable home and cannot be enumerated or serialized. */
export class MaddotsApi {
  #token: string;
  #finalError?: MadDotsApiError;
  #finalPending?: Promise<MadDotsApiError>;
  readonly #origin: URL;
  readonly #fetcher: typeof fetch;
  constructor(token: string, options: MadDotsOptions = {}) {
    if (!new RegExp('^' + RUN_TOKEN_PREFIX + '[A-Za-z0-9_-]+$').test(token)) throw new HelperError('TOKEN_INVALID', 'The runner credential is invalid.');
    this.#token = token;
    this.#origin = maddotsOrigin(options.env);
    this.#fetcher = options.fetcher ?? fetch;
  }
  toString(): string {return '[run token]';}
  toJSON(): string {return '[run token]';}
  [inspect.custom](): string {return '[run token]';}
  dispose(): void {this.#token = '';}
  #settled(pending: Promise<MadDotsApiError>, path: string, signal?: AbortSignal): Promise<MadDotsApiError> {
    if (!signal) return pending;
    const stopped = () => new MadDotsApiError('API_CONNECTION_FAILED', undefined, path);
    if (signal.aborted) return Promise.resolve(stopped());
    return new Promise(resolve => {
      const finish = (error: MadDotsApiError) => {signal.removeEventListener('abort', abort); resolve(error);};
      const abort = () => finish(stopped());
      signal.addEventListener('abort', abort, {once: true});
      void pending.then(finish);
    });
  }
  private async response(path: string, attachment = false, signal?: AbortSignal, write?: WriteRequest): Promise<Response> {
    if (this.#finalError) throw this.#finalError;
    // Final headers forbid further requests; wait for the parsed refusal code.
    if (this.#finalPending) throw await this.#settled(this.#finalPending, path, signal);
    if (!this.#token) throw new MadDotsApiError('TOKEN_REVOKED', 401, path);
    if (signal?.aborted) throw new MadDotsApiError('API_CONNECTION_FAILED', undefined, path);
    let response: Response;
    try {
      response = await this.#fetcher(new URL(path, this.#origin), {method: write ? 'POST' : 'GET',
        headers: {authorization: `Bearer ${this.#token}`, accept: attachment && !write ? '*/*' : 'application/json',
          ...(write ? {'content-type': write.contentType, 'idempotency-key': write.idempotencyKey} : {})},
        body: write?.body as BodyInit | undefined,
        redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(attachment ? 120_000 : 15_000)]) : AbortSignal.timeout(attachment ? 120_000 : 15_000)});
    } catch {throw new MadDotsApiError('API_CONNECTION_FAILED', undefined, path);}
    if (!response.ok) {
      let settle: ((error: MadDotsApiError) => void) | undefined;
      if (classifyMadDotsFailure(path, response.status) === 'final' && !this.#finalPending) {
        this.#finalPending = new Promise(resolve => {settle = resolve;});
      }
      let code = 'API_FAILED';
      try {
        const body = await boundedJson(response, 1024 * 1024);
        if (isObject(body.error) && typeof body.error.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(body.error.code)) code = body.error.code;
      } catch { /* HTML and malformed failures still classify by their status. */ }
      const error = new MadDotsApiError(code, response.status, path);
      if (error.classification === 'final') this.#finalError ??= error;
      settle?.(error);
      throw error;
    }
    return response;
  }
  private async json(path: string, limit: number, signal?: AbortSignal, expectedStatus?: number): Promise<Record<string, unknown>> {
    const response = await this.response(path, false, signal);
    let body: Uint8Array;
    try {body = await bytes(response, limit);}
    catch (error) {
      // A missing or oversized body is a complete answer.
      if (error instanceof HelperError) throw error;
      // An interrupted response body has not delivered an answer, even after 200 headers.
      throw new MadDotsApiError('API_RESPONSE_INVALID', undefined, path);
    }
    let parsed: unknown;
    try {parsed = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(body));} catch {parsed = undefined;}
    // Fully read invalid bodies are answers, not outages. Checks also require 200.
    if (expectedStatus !== undefined && response.status !== expectedStatus || !isObject(parsed)) {
      throw new HelperError('API_RESPONSE_INVALID', 'MadDots returned an invalid response.');
    }
    return parsed;
  }
  async readCard<T = Record<string, unknown>>(cardId: string, signal?: AbortSignal): Promise<T> {
    const path = `/api/cards/${id(cardId)}`;
    const body = await this.json(path, 4 * 1024 * 1024, signal);
    if (!Object.hasOwn(body, 'data')) throw new HelperError('API_RESPONSE_INVALID', 'MadDots returned an invalid card envelope.');
    return body.data as T;
  }
  async downloadAttachment(attachmentId: string, signal?: AbortSignal): Promise<Uint8Array> {
    const path = `/api/attachments/${id(attachmentId)}/file`, response = await this.response(path, true, signal);
    try {return await bytes(response, 10 * 1024 * 1024);}
    catch (error) {
      if (error instanceof HelperError) throw error;
      throw new MadDotsApiError('API_CONNECTION_FAILED', undefined, path);
    }
  }
  private async write(path: string, request: WriteRequest, attachment: boolean, signal?: AbortSignal): Promise<void> {
    if (!/^[\x21-\x7e]{16,128}$/.test(request.idempotencyKey)) throw new HelperError('IDEMPOTENCY_KEY', 'The runner write key is invalid.');
    if (!attachment && Buffer.byteLength(request.body as string, 'utf8') > 1024 * 1024) throw new HelperError('API_REQUEST_TOO_LARGE', 'The runner request exceeds its size limit.');
    const response = await this.response(path, attachment, signal, request);
    if (!response.body) return;
    try {await bytes(response, 1024 * 1024);}
    catch (error) {
      if (error instanceof HelperError && error.code === 'API_RESPONSE_TOO_LARGE') throw new HelperError('API_RESPONSE_TOO_LARGE', 'MadDots returned a response above its size limit.');
      // The server may already have written. Retry with the caller's identical key/body.
      throw new MadDotsApiError('API_RESPONSE_INVALID', undefined, path);
    }
  }
  async postComment(cardId: string, body: string, idempotencyKey: string, signal?: AbortSignal): Promise<void> {
    await this.write(`/api/cards/${id(cardId)}/comments`, {body: JSON.stringify({body}), contentType: 'application/json', idempotencyKey}, false, signal);
  }
  async uploadFile(cardId: string, body: Uint8Array, contentType: string, idempotencyKey: string, signal?: AbortSignal): Promise<void> {
    await this.write(`/api/cards/${id(cardId)}/attachments/file`, {body, contentType, idempotencyKey}, true, signal);
  }
  async move(idempotencyKey: string, signal?: AbortSignal): Promise<void> {
    await this.write('/api/run-token/move', {body: '{}', contentType: 'application/json', idempotencyKey}, false, signal);
  }
  async check(signal?: AbortSignal): Promise<RunTokenStatus> {
    const value = await this.json('/api/run-token', 1024 * 1024, signal, 200);
    if (value.live !== true || typeof value.runId !== 'string' || typeof value.cardId !== 'string' ||
      !['assignment', 'mention'].includes(value.kind as string) || typeof value.expiresAt !== 'string') throw new HelperError('API_RESPONSE_INVALID', 'MadDots returned an invalid runner status.');
    return value as RunTokenStatus;
  }
}
