import { fork, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface DesktopStateResponse {
  type: 'response';
  id: number;
  result?: unknown;
  error?: string;
}

export interface OfficialDesktopStateOptions {
  officialSourceRoot: string;
  codexHome: string;
  buildFlavor: string;
  requestTimeoutMs?: number;
}

export class OfficialDesktopState extends EventEmitter {
  readonly options: OfficialDesktopStateOptions;
  #child: ChildProcess | undefined;
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  #starting: Promise<void> | undefined;
  #stopping = false;

  constructor(options: OfficialDesktopStateOptions) {
    super();
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.#child?.connected === true) return;
    if (this.#starting !== undefined) return this.#starting;
    this.#starting = this.#start();
    try {
      await this.#starting;
    } finally {
      this.#starting = undefined;
    }
  }

  async request(operation: string, params?: unknown): Promise<unknown> {
    await this.start();
    const child = this.#child;
    if (child?.connected !== true) throw new Error('official desktop state worker is unavailable');
    const id = this.#nextId;
    this.#nextId += 1;
    const timeout = setTimeout(() => {
      const pending = this.#pending.get(id);
      if (pending === undefined) return;
      this.#pending.delete(id);
      pending.reject(new Error(`official desktop state request timed out: ${operation}`));
    }, this.options.requestTimeoutMs ?? 30_000);
    timeout.unref();
    const response = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, timeout });
    });
    child.send({ type: 'request', id, operation, params }, (error) => {
      if (error === null) return;
      const pending = this.#pending.get(id);
      if (pending === undefined) return;
      clearTimeout(pending.timeout);
      this.#pending.delete(id);
      pending.reject(error);
    });
    return response;
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    const child = this.#child;
    this.#child = undefined;
    if (child === undefined) return;
    if (child.connected) child.send({ type: 'shutdown' });
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        resolve();
      }, 3_000);
      timeout.unref();
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    this.#rejectAll(new Error('official desktop state worker stopped'));
    this.#stopping = false;
  }

  async #start(): Promise<void> {
    const adjacentWorkerPath = fileURLToPath(
      new URL('./official-desktop-state-worker.js', import.meta.url),
    );
    const workerPath = existsSync(adjacentWorkerPath)
      ? adjacentWorkerPath
      : join(
          dirname(fileURLToPath(import.meta.url)),
          '..',
          'dist',
          'official-desktop-state-worker.js',
        );
    const child = fork(workerPath, [], {
      env: {
        HOME: this.options.codexHome,
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        NODE_ENV: process.env.NODE_ENV ?? 'production',
        BUILD_FLAVOR: this.options.buildFlavor,
        CODEX_HOME: this.options.codexHome,
        OFFICIAL_SOURCE_ROOT: this.options.officialSourceRoot,
      },
      execArgv: [],
      serialization: 'advanced',
      silent: true,
    });
    this.#child = child;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => this.emit('stderr', chunk));
    child.on('message', (message: unknown) => this.#handleMessage(message));
    child.on('error', (error) => this.emit('error', error));
    child.on('exit', (code, signal) => {
      if (this.#child === child) this.#child = undefined;
      const error = new Error(
        `official desktop state worker exited (code=${String(code)}, signal=${String(signal)})`,
      );
      this.#rejectAll(error);
      if (!this.#stopping) this.emit('exit', { code, signal });
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('official desktop state worker did not become ready'));
      }, 15_000);
      timeout.unref();
      const onMessage = (message: unknown): void => {
        if (!isReadyMessage(message)) return;
        clearTimeout(timeout);
        child.off('error', onError);
        child.off('exit', onExit);
        child.off('message', onMessage);
        resolve();
      };
      const onError = (error: Error): void => {
        clearTimeout(timeout);
        child.off('message', onMessage);
        child.off('exit', onExit);
        reject(error);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        clearTimeout(timeout);
        child.off('message', onMessage);
        child.off('error', onError);
        reject(
          new Error(
            `official desktop state worker exited before ready (code=${String(code)}, signal=${String(signal)})`,
          ),
        );
      };
      child.on('message', onMessage);
      child.once('error', onError);
      child.once('exit', onExit);
    });
  }

  #handleMessage(value: unknown): void {
    if (!isResponse(value)) return;
    const pending = this.#pending.get(value.id);
    if (pending === undefined) return;
    clearTimeout(pending.timeout);
    this.#pending.delete(value.id);
    if (value.error !== undefined) pending.reject(new Error(value.error));
    else pending.resolve(value.result);
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function isReadyMessage(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).type === 'ready'
  );
}

function isResponse(value: unknown): value is DesktopStateResponse {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  return (
    response.type === 'response' &&
    Number.isInteger(response.id) &&
    (response.error === undefined || typeof response.error === 'string')
  );
}
