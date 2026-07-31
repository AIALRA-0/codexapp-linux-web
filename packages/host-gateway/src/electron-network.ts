import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';

const PROTOCOL_MARKER = 'CODEX_ELECTRON_NET_V1 ';
const STARTUP_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_IN_FLIGHT = 32;
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const ALLOWED_METHODS = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);

interface ElectronNetworkReady {
  type: 'ready';
  electronVersion: string | null;
  chromiumVersion: string | null;
}

interface ElectronNetworkResponse {
  type: 'response-start';
  id: string;
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
}

interface ElectronNetworkResponseChunk {
  type: 'response-chunk';
  id: string;
  bodyBase64: string;
}

interface ElectronNetworkResponseEnd {
  type: 'response-end';
  id: string;
}

interface ElectronNetworkError {
  type: 'error';
  id: string;
  error: { name: string; message: string };
  aborted: boolean;
}

interface ElectronNetworkFatal {
  type: 'fatal';
  error: { name: string; message: string };
}

type ElectronNetworkMessage =
  | ElectronNetworkReady
  | ElectronNetworkResponse
  | ElectronNetworkResponseChunk
  | ElectronNetworkResponseEnd
  | ElectronNetworkError
  | ElectronNetworkFatal;

interface PendingRequest {
  resolveResponse: (response: Response) => void;
  rejectResponse: (error: Error) => void;
  streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  responseStarted: boolean;
  responseBytes: number;
  method: string;
  timeout: NodeJS.Timeout;
  resetTimeout: () => void;
  abort: () => void;
  signal: AbortSignal | undefined;
}

export interface OfficialElectronNetworkOptions {
  electronBin: string;
  workerPath: string;
  userDataDir: string;
  expectedElectronVersion: string;
  expectedChromiumVersion: string;
  onDiagnostic?: (message: string) => void;
}

export function buildElectronNetworkProcess(
  options: OfficialElectronNetworkOptions,
  temporaryDirectory = process.env.TMPDIR ?? '/tmp',
): { args: string[]; env: NodeJS.ProcessEnv } {
  return {
    args: [
      '--disable-setuid-sandbox',
      '--headless',
      '--disable-gpu',
      '--disable-software-rasterizer',
      options.workerPath,
    ],
    env: {
      HOME: options.userDataDir,
      TMPDIR: temporaryDirectory,
      LANG: 'C.UTF-8',
      CODEX_ELECTRON_NET_USER_DATA_DIR: options.userDataDir,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    },
  };
}

export class OfficialElectronNetwork {
  readonly options: OfficialElectronNetworkOptions;

  #child: ChildProcessWithoutNullStreams | undefined;
  #starting: Promise<void> | undefined;
  #pending = new Map<string, PendingRequest>();
  #stopping = false;

  constructor(options: OfficialElectronNetworkOptions) {
    this.options = options;
  }

  async fetch(url: URL | RequestInfo, init?: RequestInit): Promise<Response> {
    if (this.#stopping) throw new Error('official Electron network is stopping');
    const parsedUrl = url instanceof URL ? url : new URL(requestUrl(url));
    assertOfficialElectronNetworkUrl(parsedUrl);
    const method = init?.method?.toUpperCase() ?? 'GET';
    if (!ALLOWED_METHODS.has(method)) {
      throw new TypeError('official Electron network method is not allowed');
    }
    const bodyBase64 = encodeRequestBody(init?.body, method);
    if (this.#pending.size >= MAX_IN_FLIGHT) {
      throw new Error('official Electron network is at capacity');
    }
    await this.#ensureStarted();
    if (this.#pending.size >= MAX_IN_FLIGHT) {
      throw new Error('official Electron network is at capacity');
    }
    const child = this.#child;
    if (child === undefined) throw new Error('official Electron network is unavailable');
    const id = randomUUID();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    return new Promise<Response>((resolve, reject) => {
      const abort = (): void => {
        this.#sendCancel(id);
        this.#failPending(id, new DOMException('The operation was aborted', 'AbortError'));
      };
      const signal = init?.signal ?? undefined;
      const onTimeout = (): void => {
        this.#sendCancel(id);
        this.#failPending(id, new Error('official Electron network request timed out'));
      };
      const pending: PendingRequest = {
        resolveResponse: resolve,
        rejectResponse: reject,
        streamController: undefined,
        responseStarted: false,
        responseBytes: 0,
        method,
        timeout: setTimeout(onTimeout, REQUEST_TIMEOUT_MS),
        resetTimeout: () => {
          clearTimeout(pending.timeout);
          pending.timeout = setTimeout(onTimeout, REQUEST_TIMEOUT_MS);
          pending.timeout.unref();
        },
        abort,
        signal,
      };
      pending.timeout.unref();
      this.#pending.set(id, pending);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted === true) {
        abort();
        return;
      }
      try {
        this.#write({
          type: 'fetch',
          id,
          url: parsedUrl.href,
          method,
          headers,
          ...(bodyBase64 === undefined ? {} : { bodyBase64 }),
        });
      } catch (error) {
        this.#failPending(
          id,
          error instanceof Error ? error : new Error('Electron network write failed'),
        );
      }
    });
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#rejectPending(new Error('official Electron network stopped'));
    const child = this.#child;
    this.#child = undefined;
    this.#starting = undefined;
    if (child === undefined) return;
    child.stdin.end();
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const timeout = setTimeout(() => child.kill('SIGTERM'), 3_000);
    timeout.unref();
    await exited;
    clearTimeout(timeout);
  }

  async #ensureStarted(): Promise<void> {
    if (this.#starting !== undefined) {
      await this.#starting;
      return;
    }
    if (this.#child !== undefined) return;
    const starting = this.#start();
    this.#starting = starting;
    try {
      await starting;
    } catch (error) {
      this.#terminateChild();
      throw error;
    } finally {
      if (this.#starting === starting) this.#starting = undefined;
    }
  }

  async #start(): Promise<void> {
    mkdirSync(this.options.userDataDir, { recursive: true, mode: 0o700 });
    const processConfig = buildElectronNetworkProcess(this.options);
    const child = spawn(this.options.electronBin, processConfig.args, {
      env: processConfig.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child = child;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const message = safeDiagnostic(chunk);
      if (message.length > 0) this.options.onDiagnostic?.(message);
    });
    child.once('exit', (code, signal) => {
      if (this.#child === child) this.#child = undefined;
      this.#rejectPending(
        new Error(
          `official Electron network exited (${code === null ? (signal ?? 'unknown') : String(code)})`,
        ),
      );
    });
    child.once('error', (error) => {
      if (this.#child === child) this.#child = undefined;
      this.#rejectPending(error);
    });

    await new Promise<void>((resolve, reject) => {
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      const timeout = setTimeout(() => {
        reject(new Error('official Electron network startup timed out'));
        child.kill('SIGTERM');
      }, STARTUP_TIMEOUT_MS);
      timeout.unref();
      let ready = false;
      lines.on('line', (line) => {
        const message = parseElectronNetworkLine(line);
        if (message === null) {
          const diagnostic = safeDiagnostic(line);
          if (diagnostic.length > 0) this.options.onDiagnostic?.(diagnostic);
          return;
        }
        if (!ready) {
          if (message.type !== 'ready') {
            if (message.type === 'fatal') reject(new Error(message.error.message));
            return;
          }
          try {
            this.#assertVersion(message);
          } catch (error) {
            reject(error instanceof Error ? error : new Error('Electron version check failed'));
            child.kill('SIGTERM');
            return;
          }
          ready = true;
          clearTimeout(timeout);
          resolve();
          return;
        }
        this.#handleMessage(message);
      });
      child.once('exit', () => {
        if (ready) return;
        clearTimeout(timeout);
        reject(new Error('official Electron network exited before readiness'));
      });
      child.once('error', (error) => {
        if (ready) return;
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  #assertVersion(message: ElectronNetworkReady): void {
    if (
      message.electronVersion !== this.options.expectedElectronVersion ||
      message.chromiumVersion !== this.options.expectedChromiumVersion
    ) {
      throw new Error(
        `official Electron network version mismatch: expected Electron ${this.options.expectedElectronVersion} / Chromium ${this.options.expectedChromiumVersion}`,
      );
    }
  }

  #handleMessage(message: ElectronNetworkMessage): void {
    if (message.type === 'fatal') {
      this.#rejectPending(new Error(message.error.message));
      this.#child?.kill('SIGTERM');
      return;
    }
    if (message.type === 'ready') return;
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    pending.resetTimeout();
    if (message.type === 'error') {
      this.#failPending(
        message.id,
        message.aborted
          ? new DOMException('The operation was aborted', 'AbortError')
          : new Error(message.error.message),
      );
      return;
    }
    if (message.type === 'response-start') {
      if (pending.responseStarted) {
        this.#failPending(message.id, new Error('duplicate official Electron response start'));
        return;
      }
      pending.responseStarted = true;
      try {
        const bodyAllowed = pending.method !== 'HEAD' && ![204, 205, 304].includes(message.status);
        const body = bodyAllowed
          ? new ReadableStream<Uint8Array>({
              start: (controller) => {
                pending.streamController = controller;
              },
              cancel: () => {
                this.#sendCancel(message.id);
                this.#finishPending(message.id);
              },
            })
          : null;
        pending.resolveResponse(
          new Response(body, {
            status: message.status,
            statusText: message.statusText,
            headers: new Headers(message.headers),
          }),
        );
      } catch (error) {
        this.#failPending(
          message.id,
          error instanceof Error ? error : new Error('invalid official Electron response'),
        );
      }
      return;
    }
    if (!pending.responseStarted) {
      this.#failPending(message.id, new Error('invalid official Electron response sequence'));
      return;
    }
    if (message.type === 'response-chunk') {
      if (pending.streamController === undefined) {
        this.#failPending(message.id, new Error('official Electron response body is not allowed'));
        return;
      }
      const chunk = Buffer.from(message.bodyBase64, 'base64');
      pending.responseBytes += chunk.byteLength;
      if (pending.responseBytes > MAX_RESPONSE_BYTES) {
        this.#sendCancel(message.id);
        this.#failPending(
          message.id,
          new RangeError('official Electron response exceeded the configured limit'),
        );
        return;
      }
      pending.streamController.enqueue(chunk);
      return;
    }
    pending.streamController?.close();
    this.#finishPending(message.id);
  }

  #finishPending(id: string): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    clearTimeout(pending.timeout);
    pending.signal?.removeEventListener('abort', pending.abort);
    this.#pending.delete(id);
  }

  #failPending(id: string, error: Error): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    if (pending.responseStarted) pending.streamController?.error(error);
    else pending.rejectResponse(error);
    this.#finishPending(id);
  }

  #write(message: unknown): void {
    const child = this.#child;
    if (child === undefined || child.stdin.destroyed) {
      throw new Error('official Electron network is unavailable');
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #sendCancel(id: string): void {
    try {
      this.#write({ type: 'cancel', id });
    } catch {
      // The request still needs to settle when the worker exits between frames.
    }
  }

  #rejectPending(error: Error): void {
    for (const id of [...this.#pending.keys()]) this.#failPending(id, error);
  }

  #terminateChild(): void {
    const child = this.#child;
    this.#child = undefined;
    child?.kill('SIGTERM');
  }
}

export function parseElectronNetworkLine(line: string): ElectronNetworkMessage | null {
  if (!line.startsWith(PROTOCOL_MARKER)) return null;
  try {
    const value = JSON.parse(line.slice(PROTOCOL_MARKER.length)) as unknown;
    return isElectronNetworkMessage(value) ? value : null;
  } catch {
    return null;
  }
}

export function assertOfficialElectronNetworkUrl(url: URL): void {
  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.port.length > 0 ||
    url.hostname !== 'chatgpt.com' ||
    !url.pathname.startsWith('/backend-api/') ||
    url.hash.length > 0
  ) {
    throw new TypeError('official Electron network target is not allowed');
  }
}

function requestUrl(request: RequestInfo): string {
  return typeof request === 'string' ? request : request.url;
}

function encodeRequestBody(body: BodyInit | null | undefined, method: string): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (method === 'GET' || method === 'HEAD') {
    throw new TypeError('official Electron GET and HEAD requests cannot have a body');
  }
  let bytes: Uint8Array;
  if (typeof body === 'string') bytes = Buffer.from(body);
  else if (body instanceof ArrayBuffer) bytes = new Uint8Array(body);
  else if (ArrayBuffer.isView(body)) {
    bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  } else {
    throw new TypeError('official Electron network request body type is not supported');
  }
  if (bytes.byteLength > MAX_REQUEST_BYTES) {
    throw new RangeError('official Electron request exceeded the configured limit');
  }
  return Buffer.from(bytes).toString('base64');
}

function safeDiagnostic(value: string): string {
  return value
    .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/gu, '[redacted]')
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .trim()
    .slice(0, 1_000);
}

function isElectronNetworkMessage(value: unknown): value is ElectronNetworkMessage {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.type === 'ready') {
    return (
      (typeof record.electronVersion === 'string' || record.electronVersion === null) &&
      (typeof record.chromiumVersion === 'string' || record.chromiumVersion === null)
    );
  }
  if (record.type === 'fatal') return isSafeError(record.error);
  if (
    (record.type === 'response-start' ||
      record.type === 'response-chunk' ||
      record.type === 'response-end' ||
      record.type === 'error') &&
    typeof record.id !== 'string'
  ) {
    return false;
  }
  if (record.type === 'error') {
    return typeof record.aborted === 'boolean' && isSafeError(record.error);
  }
  if (record.type === 'response-chunk') return typeof record.bodyBase64 === 'string';
  if (record.type === 'response-end') return true;
  return (
    record.type === 'response-start' &&
    typeof record.status === 'number' &&
    typeof record.statusText === 'string' &&
    Array.isArray(record.headers) &&
    record.headers.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        entry.every((part) => typeof part === 'string'),
    )
  );
}

function isSafeError(value: unknown): value is { name: string; message: string } {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.name === 'string' && typeof record.message === 'string';
}
