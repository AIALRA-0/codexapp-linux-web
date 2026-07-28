const DEFAULT_CHATGPT_API_BASE = 'https://chatgpt.com/backend-api/';
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 120_000;
const INTEGRITY_REQUEST_HEADER = 'X-OAI-IS';
const INTEGRITY_UPDATE_HEADER = 'X-OAI-IS-Update';
const INTEGRITY_STATE_PATTERN = /^ois1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const STREAM_RESPONSE_HEADERS = [
  's-cf-origin-ttfb-msec',
  's-cf-quic-rtt-msec',
  's-cf-tcp-rtt-msec',
  's-sa-server-ttfb-msec',
  'x-oai-request-id',
] as const;

const CONTROL_HEADERS = new Set([
  'x-codex-base64',
  'x-codex-binary-response',
  'x-openai-attach-auth',
  'x-openai-attach-desktop-surface',
  'x-openai-attach-devicecheck-token',
  'x-openai-attach-integrity-state',
]);

const FORBIDDEN_OUTBOUND_HEADERS = new Set([
  'connection',
  'content-length',
  'cookie',
  'host',
  'proxy-authenticate',
  'proxy-authorization',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const FORBIDDEN_RESPONSE_HEADERS = new Set(['set-cookie', 'set-cookie2']);

const ALLOWED_HOST_SUFFIXES = [
  'chatgpt.com',
  'openai.com',
  'oaiusercontent.com',
  'oaistatic.com',
  'statsig.com',
  'statsigapi.net',
  'mapbox.com',
] as const;

export interface RendererFetchRequest {
  requestId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  binaryResponse: boolean;
  bodyIsBase64: boolean;
  attachAuth: boolean;
  attachDesktopSurface: boolean;
  attachIntegrityState: boolean;
}

export interface RendererFetchProxyOptions {
  getAuthToken: (refreshToken: boolean) => Promise<string | null>;
  getIntegrityState?: () => string | null;
  storeIntegrityState?: (expected: string | null, value: string) => Promise<boolean>;
  appVersion: string;
  chatGptApiBase?: string;
  maxResponseBytes?: number;
  fetchImplementation?: typeof fetch;
}

export interface HostDownloadRequest {
  downloadUrl: string;
  requestHeaders?: Record<string, string>;
}

export type RendererFetchResponse =
  | {
      type: 'fetch-response';
      responseType: 'success';
      requestId: string;
      status: number;
      headers: Record<string, string>;
      bodyJsonString: string;
    }
  | {
      type: 'fetch-response';
      responseType: 'error';
      requestId: string;
      status: number;
      error: string;
      errorCode?: string;
    };

export type RendererFetchStreamMessage =
  | {
      type: 'fetch-stream-response';
      requestId: string;
      status: number;
      headers: Record<string, string>;
    }
  | {
      type: 'fetch-stream-event';
      requestId: string;
      event?: string;
      data: unknown;
    }
  | {
      type: 'fetch-stream-complete';
      requestId: string;
    }
  | {
      type: 'fetch-stream-error';
      requestId: string;
      error: string;
    };

export class RendererFetchError extends Error {
  readonly status: number;
  readonly errorCode: string | undefined;

  constructor(message: string, status = 500, errorCode?: string) {
    super(message);
    this.name = 'RendererFetchError';
    this.status = status;
    this.errorCode = errorCode;
  }
}

export class RendererFetchProxy {
  readonly options: RendererFetchProxyOptions;

  constructor(options: RendererFetchProxyOptions) {
    this.options = options;
  }

  async perform(message: unknown, signal?: AbortSignal): Promise<RendererFetchResponse> {
    let request: RendererFetchRequest;
    try {
      request = parseRendererFetchRequest(message);
      const resolvedUrl = resolveRendererFetchUrl(
        request.url,
        this.options.chatGptApiBase ?? DEFAULT_CHATGPT_API_BASE,
      );
      assertAllowedRendererFetchUrl(resolvedUrl);
      const response = await this.#performWithAuth(request, resolvedUrl, signal);
      const headers = responseHeaders(response.headers);
      const bytes = await readResponseBytes(
        response,
        this.options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      );
      if (!response.ok) {
        const text = new TextDecoder().decode(bytes);
        return {
          type: 'fetch-response',
          responseType: 'error',
          requestId: request.requestId,
          status: response.status,
          error:
            text || response.statusText || `Request failed with status ${String(response.status)}`,
        };
      }
      const contentType = response.headers.get('content-type') ?? '';
      let bodyJsonString = 'null';
      if (response.status !== 204) {
        if (contentType.toLowerCase().includes('application/json') && !request.binaryResponse) {
          bodyJsonString = new TextDecoder().decode(bytes);
        } else {
          bodyJsonString = JSON.stringify({
            base64: Buffer.from(bytes).toString('base64'),
            contentType,
          });
        }
      }
      return {
        type: 'fetch-response',
        responseType: 'success',
        requestId: request.requestId,
        status: response.status,
        headers,
        bodyJsonString,
      };
    } catch (error) {
      const status = error instanceof RendererFetchError ? error.status : 500;
      const errorCode = error instanceof RendererFetchError ? error.errorCode : undefined;
      return {
        type: 'fetch-response',
        responseType: 'error',
        requestId: requestIdFromUnknown(message),
        status,
        error: error instanceof Error ? error.message : 'Unknown fetch proxy error',
        ...(errorCode === undefined ? {} : { errorCode }),
      };
    }
  }

  async performStream(
    message: unknown,
    send: (message: RendererFetchStreamMessage) => void,
    signal: AbortSignal,
  ): Promise<void> {
    let requestId = requestIdFromUnknown(message);
    try {
      const request = parseRendererFetchRequest(message, 'fetch-stream');
      requestId = request.requestId;
      const format = streamFormatFromUnknown(message);
      const resolvedUrl = resolveRendererFetchUrl(
        request.url,
        this.options.chatGptApiBase ?? DEFAULT_CHATGPT_API_BASE,
      );
      assertAllowedRendererFetchUrl(resolvedUrl);
      const response = await this.#performWithAuth(request, resolvedUrl, signal);
      if (!response.ok) {
        await response.body?.cancel();
        send({
          type: 'fetch-stream-error',
          requestId,
          error:
            response.statusText.length > 0
              ? `${String(response.status)} ${response.statusText}`
              : `Request failed with status ${String(response.status)}`,
        });
        return;
      }
      if (response.body === null) {
        send({
          type: 'fetch-stream-error',
          requestId,
          error: 'Streaming response had no body.',
        });
        return;
      }
      send({
        type: 'fetch-stream-response',
        requestId,
        status: response.status,
        headers: streamResponseHeaders(response.headers),
      });
      if (format === 'ndjson') {
        for await (const data of parseNdjsonStream(response.body, signal)) {
          send({ type: 'fetch-stream-event', requestId, data });
        }
      } else {
        for await (const event of parseSseStream(response.body, signal)) {
          send({
            type: 'fetch-stream-event',
            requestId,
            ...(event.event === undefined ? {} : { event: event.event }),
            data: event.data,
          });
        }
      }
      send({ type: 'fetch-stream-complete', requestId });
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        send({ type: 'fetch-stream-complete', requestId });
      } else {
        send({
          type: 'fetch-stream-error',
          requestId,
          error: error instanceof Error ? error.message : 'Unknown fetch stream error',
        });
      }
    }
  }

  async getDownloadStream(
    request: HostDownloadRequest,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    const parsed = parseRendererFetchRequest({
      type: 'fetch',
      requestId: 'host-download',
      url: request.downloadUrl,
      method: 'GET',
      headers: request.requestHeaders,
    });
    const resolvedUrl = resolveRendererFetchUrl(
      parsed.url,
      this.options.chatGptApiBase ?? DEFAULT_CHATGPT_API_BASE,
    );
    assertAllowedRendererFetchUrl(resolvedUrl);
    const response = await this.#performWithAuth(parsed, resolvedUrl, signal);
    if (!response.ok) {
      await response.body?.cancel();
      throw new RendererFetchError(
        `File download failed with status ${String(response.status)}`,
        response.status,
      );
    }
    if (response.body === null) {
      throw new RendererFetchError('File download returned no response body');
    }
    return response.body;
  }

  async #performWithAuth(
    request: RendererFetchRequest,
    resolvedUrl: URL,
    signal?: AbortSignal,
  ): Promise<Response> {
    let token = request.attachAuth ? await this.options.getAuthToken(false) : null;
    let response = await this.#performOnce(request, resolvedUrl, token, signal);
    if (response.status === 401 && request.attachAuth && token !== null) {
      await response.body?.cancel();
      token = await this.options.getAuthToken(true);
      response = await this.#performOnce(request, resolvedUrl, token, signal);
    }
    return response;
  }

  async #performOnce(
    request: RendererFetchRequest,
    resolvedUrl: URL,
    token: string | null,
    signal?: AbortSignal,
  ): Promise<Response> {
    let url = resolvedUrl;
    let method = request.method;
    let body = requestBody(request);
    let integrityState = request.attachIntegrityState
      ? validIntegrityState(this.options.getIntegrityState?.())
      : null;
    let headers = createOutboundHeaders(
      request,
      url,
      token,
      this.options.appVersion,
      integrityState,
    );
    const fetchImplementation = this.options.fetchImplementation ?? fetch;
    const requestSignal = combineWithTimeout(signal);

    for (let redirectCount = 0; ; redirectCount += 1) {
      const response = await fetchImplementation(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: 'manual',
        signal: requestSignal,
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        if (request.attachIntegrityState) {
          const nextState = validIntegrityState(response.headers.get(INTEGRITY_UPDATE_HEADER));
          if (nextState !== null && this.options.storeIntegrityState !== undefined) {
            await this.options.storeIntegrityState(integrityState, nextState);
          }
        }
        return response;
      }
      if (redirectCount >= MAX_REDIRECTS) {
        await response.body?.cancel();
        throw new RendererFetchError('renderer fetch exceeded redirect limit', 508);
      }
      const location = response.headers.get('location');
      if (location === null) return response;
      const nextUrl = new URL(location, url);
      assertAllowedRendererFetchUrl(nextUrl);
      const crossedOrigin = nextUrl.origin !== url.origin;
      if (crossedOrigin && (request.attachAuth || headers.has('authorization'))) {
        await response.body?.cancel();
        throw new RendererFetchError(
          'authenticated renderer fetch cannot redirect cross-origin',
          400,
        );
      }
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && method === 'POST')
      ) {
        method = 'GET';
        body = undefined;
        headers.delete('content-type');
      }
      await response.body?.cancel();
      url = nextUrl;
      integrityState = request.attachIntegrityState
        ? validIntegrityState(this.options.getIntegrityState?.())
        : null;
      headers = createOutboundHeaders(request, url, token, this.options.appVersion, integrityState);
    }
  }
}

export function parseRendererFetchRequest(
  message: unknown,
  expectedType: 'fetch' | 'fetch-stream' = 'fetch',
): RendererFetchRequest {
  if (message === null || typeof message !== 'object') {
    throw new RendererFetchError('invalid renderer fetch request', 400);
  }
  const value = message as Record<string, unknown>;
  if (
    value.type !== expectedType ||
    typeof value.requestId !== 'string' ||
    value.requestId.length === 0 ||
    typeof value.url !== 'string' ||
    value.url.length === 0
  ) {
    throw new RendererFetchError('invalid renderer fetch request', 400);
  }
  const method = typeof value.method === 'string' ? value.method.toUpperCase() : 'GET';
  if (!['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'].includes(method)) {
    throw new RendererFetchError(`renderer fetch method is not allowed: ${method}`, 405);
  }
  const headers = parseHeaders(value.headers);
  const bodyIsBase64 = takeBooleanControlHeader(headers, 'x-codex-base64');
  const binaryResponse = takeBooleanControlHeader(headers, 'x-codex-binary-response');
  const explicitAttachAuth = takeBooleanControlHeader(headers, 'x-openai-attach-auth');
  const attachDesktopSurface = takeBooleanControlHeader(headers, 'x-openai-attach-desktop-surface');
  const attachDeviceCheck = takeBooleanControlHeader(headers, 'x-openai-attach-devicecheck-token');
  const attachIntegrityState = takeBooleanControlHeader(headers, 'x-openai-attach-integrity-state');
  if (attachDeviceCheck) {
    throw new RendererFetchError('DeviceCheck is unavailable in the browser host', 432);
  }
  const url = value.url;
  const attachAuth =
    !hasHeader(headers, 'authorization') && (explicitAttachAuth || shouldInferCodexApiAuth(url));
  if (value.body !== undefined && typeof value.body !== 'string') {
    throw new RendererFetchError('renderer fetch body must be a string', 400);
  }
  return {
    requestId: value.requestId,
    url,
    method,
    headers,
    ...(typeof value.body === 'string' ? { body: value.body } : {}),
    binaryResponse,
    bodyIsBase64,
    attachAuth,
    attachDesktopSurface,
    attachIntegrityState,
  };
}

export function resolveRendererFetchUrl(value: string, chatGptApiBase: string): URL {
  if (/^https?:\/\//iu.test(value)) return new URL(value);
  if (value.startsWith('data:')) {
    throw new RendererFetchError('data URL fetches are not proxied by the browser host', 400);
  }
  const base = new URL(chatGptApiBase);
  const basePath = base.pathname.replace(/\/+$/u, '');
  const relativePath = value.replace(/^\/+/u, '');
  base.pathname = `${basePath}/${relativePath}`;
  base.search = '';
  base.hash = '';
  return base;
}

export function assertAllowedRendererFetchUrl(url: URL): void {
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new RendererFetchError('renderer fetch requires a credential-free HTTPS URL', 403);
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '');
  const allowed = ALLOWED_HOST_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
  if (!allowed || hostname === 'ab.openai.com') {
    throw new RendererFetchError(`browser host fetch URL is not allowed: ${url.origin}`, 403);
  }
}

function parseHeaders(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RendererFetchError('renderer fetch headers must be an object', 400);
  }
  const entries = Object.entries(value);
  if (entries.length > 100)
    throw new RendererFetchError('renderer fetch has too many headers', 400);
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of entries) {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(name) || typeof headerValue !== 'string') {
      throw new RendererFetchError('renderer fetch contains an invalid header', 400);
    }
    if (headerValue.length > 16_384 || /[\r\n]/u.test(headerValue)) {
      throw new RendererFetchError('renderer fetch contains an invalid header value', 400);
    }
    headers[name] = headerValue;
  }
  return headers;
}

function createOutboundHeaders(
  request: RendererFetchRequest,
  url: URL,
  token: string | null,
  appVersion: string,
  integrityState: string | null,
): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    const normalized = name.toLowerCase();
    if (CONTROL_HEADERS.has(normalized) || FORBIDDEN_OUTBOUND_HEADERS.has(normalized)) continue;
    if (normalized === 'authorization' && !isOpenAiAuthAllowedUrl(url)) {
      throw new RendererFetchError('authentication cannot be sent to a non-OpenAI URL', 400);
    }
    headers.set(name, value);
  }
  if (request.attachAuth) {
    if (!isOpenAiAuthAllowedUrl(url)) {
      throw new RendererFetchError('authentication cannot be attached to a non-OpenAI URL', 400);
    }
    if (token !== null) {
      headers.set('authorization', `Bearer ${token}`);
      const accountId = chatGptAccountIdFromToken(token);
      if (accountId !== null) headers.set('ChatGPT-Account-Id', accountId);
    }
  }
  if (request.attachAuth || request.attachDesktopSurface) {
    if (!isOpenAiAuthAllowedUrl(url)) {
      throw new RendererFetchError('desktop surface headers require an OpenAI URL', 400);
    }
    headers.set('originator', 'Codex Desktop');
    headers.set('X-OpenAI-Codex-Client-Version', appVersion);
  }
  headers.delete(INTEGRITY_REQUEST_HEADER);
  if (request.attachIntegrityState) {
    if (!isOpenAiAuthAllowedUrl(url)) {
      throw new RendererFetchError('integrity state requires an OpenAI URL', 400);
    }
    if (integrityState !== null) headers.set(INTEGRITY_REQUEST_HEADER, integrityState);
  }
  if (request.body !== undefined && !request.bodyIsBase64 && !headers.has('content-type')) {
    const trimmed = request.body.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        JSON.parse(request.body);
        headers.set('content-type', 'application/json');
      } catch {
        // The official wrapper forwards non-JSON strings without inferring a content type.
      }
    }
  }
  return headers;
}

export async function* parseNdjsonStream(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const cancel = (): void => {
    void reader.cancel();
  };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done || value === undefined) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/u, '');
        buffer = buffer.slice(newline + 1);
        if (line.trim().length > 0) yield JSON.parse(line) as unknown;
        newline = buffer.indexOf('\n');
      }
    }
    if (!signal.aborted) {
      const line = buffer + decoder.decode();
      if (line.trim().length > 0) yield JSON.parse(line) as unknown;
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

interface ParsedSseEvent {
  event?: string;
  data: unknown;
}

export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<ParsedSseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const cancel = (): void => {
    void reader.cancel();
  };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done || value === undefined) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const boundary = sseBoundary(buffer);
        if (boundary.index < 0) break;
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const event = parseSseBlock(block);
        if (event !== null && event.event !== 'heartbeat') yield event;
      }
    }
    if (!signal.aborted) {
      const event = parseSseBlock(buffer + decoder.decode());
      if (event !== null && event.event !== 'heartbeat') yield event;
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

function parseSseBlock(block: string): ParsedSseEvent | null {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split(/\r?\n/u)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trim());
  }
  if (data.length === 0) return null;
  try {
    return {
      ...(event === undefined ? {} : { event }),
      data: JSON.parse(data.join('\n')) as unknown,
    };
  } catch {
    return null;
  }
}

function sseBoundary(value: string): { index: number; length: number } {
  const crlf = value.indexOf('\r\n\r\n');
  const lf = value.indexOf('\n\n');
  if (crlf < 0 && lf < 0) return { index: -1, length: 0 };
  if (crlf < 0) return { index: lf, length: 2 };
  if (lf < 0 || crlf < lf) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function streamFormatFromUnknown(message: unknown): 'ndjson' | 'sse' {
  if (message !== null && typeof message === 'object') {
    const format = (message as Record<string, unknown>).format;
    if (format === undefined || format === 'sse') return 'sse';
    if (format === 'ndjson') return 'ndjson';
  }
  throw new RendererFetchError('renderer fetch stream format is invalid', 400);
}

function streamResponseHeaders(headers: Headers): Record<string, string> {
  const output: Record<string, string> = {};
  for (const name of STREAM_RESPONSE_HEADERS) {
    const value = headers.get(name);
    if (value !== null) output[name] = value;
  }
  return output;
}

function validIntegrityState(value: string | null | undefined): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 2_048 ||
    value.trim() !== value ||
    !INTEGRITY_STATE_PATTERN.test(value)
  ) {
    return null;
  }
  return value;
}

function combineWithTimeout(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

function isAbortError(error: unknown): boolean {
  return (
    error !== null && typeof error === 'object' && 'name' in error && error.name === 'AbortError'
  );
}

function requestBody(request: RendererFetchRequest): BodyInit | undefined {
  if (request.body === undefined || request.method === 'GET' || request.method === 'HEAD') {
    return undefined;
  }
  return request.bodyIsBase64 ? Buffer.from(request.body, 'base64') : request.body;
}

function takeBooleanControlHeader(headers: Record<string, string>, name: string): boolean {
  const key = findHeader(headers, name);
  if (key === undefined) return false;
  const value = headers[key];
  delete headers[key];
  return value !== '0' && value?.toLowerCase() !== 'false';
}

function findHeader(headers: Record<string, string>, name: string): string | undefined {
  const normalized = name.toLowerCase();
  return Object.keys(headers).find((key) => key.toLowerCase() === normalized);
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return findHeader(headers, name) !== undefined;
}

function shouldInferCodexApiAuth(value: string): boolean {
  let pathname: string;
  try {
    pathname = /^https?:\/\//iu.test(value)
      ? new URL(value).pathname
      : `/${value.replace(/^\/+/u, '')}`;
  } catch {
    return false;
  }
  const normalized = pathname.replace(/\/+$/u, '');
  return (
    normalized === '/wham' ||
    normalized.startsWith('/wham/') ||
    normalized === '/api/wham' ||
    normalized.startsWith('/api/wham/') ||
    normalized === '/backend-api/wham' ||
    normalized.startsWith('/backend-api/wham/')
  );
}

function isOpenAiAuthAllowedUrl(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  return (
    hostname === 'openai.com' ||
    hostname.endsWith('.openai.com') ||
    ((hostname === 'chatgpt.com' || hostname.endsWith('.chatgpt.com')) &&
      !hostname.startsWith('ab.'))
  );
}

function chatGptAccountIdFromToken(token: string): string | null {
  const payload = token.split('.')[1];
  if (payload === undefined) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const auth = claims['https://api.openai.com/auth'];
    if (auth === null || typeof auth !== 'object') return null;
    const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
    return typeof accountId === 'string' && accountId.length > 0 ? accountId : null;
  } catch {
    return null;
  }
}

async function readResponseBytes(response: Response, maximumBytes: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new RendererFetchError('renderer fetch response exceeds byte limit', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function responseHeaders(headers: Headers): Record<string, string> {
  const output: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (!FORBIDDEN_RESPONSE_HEADERS.has(name.toLowerCase())) output[name] = value;
  });
  return output;
}

function requestIdFromUnknown(message: unknown): string {
  if (message !== null && typeof message === 'object') {
    const requestId = (message as Record<string, unknown>).requestId;
    if (typeof requestId === 'string' && requestId.length > 0) return requestId;
  }
  return 'invalid-request';
}
