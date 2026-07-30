import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';

const PROTOCOL_MARKER = 'CODEX_ELECTRON_NET_V1 ';
const STARTUP_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_IN_FLIGHT = 32;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const PROJECTS_QUERY_KEYS = new Set(['conversations_per_gizmo', 'limit', 'owned_only']);

interface ElectronNetworkReady {
  type: 'ready';
  electronVersion: string | null;
  chromiumVersion: string | null;
}

interface ElectronNetworkResponse {
  type: 'response';
  id: string;
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  bodyBase64: string;
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
  ElectronNetworkReady | ElectronNetworkResponse | ElectronNetworkError | ElectronNetworkFatal;

interface PendingRequest {
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  removeAbortListener: () => void;
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
    if (method !== 'GET' || init?.body !== undefined) {
      throw new TypeError('official Electron network only accepts GET requests');
    }
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
      let settled = false;
      const finishReject = (error: Error): void => {
        if (settled) return;
        settled = true;
        const pending = this.#pending.get(id);
        if (pending !== undefined) {
          clearTimeout(pending.timeout);
          pending.removeAbortListener();
          this.#pending.delete(id);
        }
        reject(error);
      };
      const abort = (): void => {
        this.#write({ type: 'cancel', id });
        finishReject(new DOMException('The operation was aborted', 'AbortError'));
      };
      const signal = init?.signal;
      if (signal?.aborted === true) {
        abort();
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(() => {
        this.#write({ type: 'cancel', id });
        finishReject(new Error('official Electron network request timed out'));
      }, REQUEST_TIMEOUT_MS);
      timeout.unref();
      this.#pending.set(id, {
        resolve: (response) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          signal?.removeEventListener('abort', abort);
          this.#pending.delete(id);
          resolve(response);
        },
        reject: finishReject,
        timeout,
        removeAbortListener: () => signal?.removeEventListener('abort', abort),
      });
      try {
        this.#write({
          type: 'fetch',
          id,
          url: parsedUrl.href,
          method,
          headers,
        });
      } catch (error) {
        finishReject(error instanceof Error ? error : new Error('Electron network write failed'));
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
    if (message.type === 'error') {
      pending.reject(
        message.aborted
          ? new DOMException('The operation was aborted', 'AbortError')
          : new Error(message.error.message),
      );
      return;
    }
    if (Buffer.byteLength(message.bodyBase64, 'base64') > MAX_RESPONSE_BYTES) {
      pending.reject(new RangeError('official Electron response exceeded the configured limit'));
      this.#child?.kill('SIGTERM');
      return;
    }
    const headers = new Headers(message.headers);
    pending.resolve(
      new Response(Buffer.from(message.bodyBase64, 'base64'), {
        status: message.status,
        statusText: message.statusText,
        headers,
      }),
    );
  }

  #write(message: unknown): void {
    const child = this.#child;
    if (child === undefined || child.stdin.destroyed) {
      throw new Error('official Electron network is unavailable');
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #rejectPending(error: Error): void {
    for (const pending of [...this.#pending.values()]) pending.reject(error);
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
    url.pathname !== '/backend-api/gizmos/snorlax/sidebar' ||
    url.hash.length > 0
  ) {
    throw new TypeError('official Electron network target is not allowed');
  }
  const seen = new Set<string>();
  for (const [name, value] of url.searchParams) {
    if (!PROJECTS_QUERY_KEYS.has(name) || seen.has(name)) {
      throw new TypeError('official Electron network query is not allowed');
    }
    seen.add(name);
    if (
      (name === 'owned_only' && !['true', 'false'].includes(value)) ||
      (name !== 'owned_only' && !/^[0-9]{1,3}$/u.test(value))
    ) {
      throw new TypeError('official Electron network query is not allowed');
    }
  }
}

function requestUrl(request: RequestInfo): string {
  return typeof request === 'string' ? request : request.url;
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
  if ((record.type === 'response' || record.type === 'error') && typeof record.id !== 'string') {
    return false;
  }
  if (record.type === 'error') {
    return typeof record.aborted === 'boolean' && isSafeError(record.error);
  }
  return (
    record.type === 'response' &&
    typeof record.status === 'number' &&
    typeof record.statusText === 'string' &&
    Array.isArray(record.headers) &&
    record.headers.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        entry.every((part) => typeof part === 'string'),
    ) &&
    typeof record.bodyBase64 === 'string'
  );
}

function isSafeError(value: unknown): value is { name: string; message: string } {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.name === 'string' && typeof record.message === 'string';
}
