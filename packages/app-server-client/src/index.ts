import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';

import {
  jsonRpcNotificationSchema,
  jsonRpcRequestSchema,
  jsonRpcResponseSchema,
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from '@codexapp/contracts';

export interface AppServerClientOptions {
  codexBin: string;
  codexHome: string;
  cwd: string;
  clientVersion: string;
  extraArgs?: string[];
  environment?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  spawnProcess?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcessWithoutNullStreams;
}

export interface ServerRequestEvent {
  request: JsonRpcRequest;
  respond: (response: Omit<JsonRpcResponse, 'id'>) => Promise<void>;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class CodexAppServerClient extends EventEmitter {
  readonly options: AppServerClientOptions;

  #child: ChildProcessWithoutNullStreams | undefined;
  #nextRequestId = 1;
  #pending = new Map<JsonRpcId, PendingRequest>();
  #ready = false;
  #stopping = false;

  constructor(options: AppServerClientOptions) {
    super();
    this.options = options;
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  get ready(): boolean {
    return this.#ready;
  }

  async start(): Promise<void> {
    if (this.#child !== undefined) {
      throw new Error('app-server client has already been started');
    }
    this.#stopping = false;

    const spawnImplementation =
      this.options.spawnProcess ??
      ((command: string, args: readonly string[], options: SpawnOptions) =>
        spawn(command, args, options) as ChildProcessWithoutNullStreams);
    const spawnOptions: SpawnOptions = {
      cwd: this.options.cwd,
      env: {
        ...process.env,
        ...this.options.environment,
        CODEX_HOME: this.options.codexHome,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    };
    const child = spawnImplementation(
      this.options.codexBin,
      [...(this.options.extraArgs ?? []), 'app-server', '--analytics-default-enabled'],
      spawnOptions,
    );
    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      child.kill();
      throw new Error('app-server did not expose all stdio streams');
    }
    this.#child = child;
    this.#wireProcess(this.#child);

    await this.request('initialize', {
      clientInfo: {
        name: 'codexapp-official-web-host',
        title: 'CodexApp Official Web Host',
        version: this.options.clientVersion,
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    await this.notify('initialized');
    this.#ready = true;
    this.emit('ready');
  }

  async stop(graceMs = 5_000): Promise<void> {
    const child = this.#child;
    if (child === undefined) return;
    this.#stopping = true;
    child.stdin.end();

    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
      });
      const timeout = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, graceMs);
        timer.unref();
      });
      await Promise.race([exited, timeout]);
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }
    this.#ready = false;
    this.#child = undefined;
  }

  async request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    const id = this.#nextRequestId++;
    const request: JsonRpcRequest = {
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };
    const timeoutDuration = timeoutMs ?? this.options.requestTimeoutMs ?? 60_000;
    const result = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`app-server request timed out: ${method}`));
      }, timeoutDuration);
      timeout.unref();
      this.#pending.set(id, { method, resolve, reject, timeout });
    });
    await this.#write(request);
    return result;
  }

  async forwardRequest(request: JsonRpcRequest): Promise<void> {
    await this.#write(jsonRpcRequestSchema.parse(request));
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const notification: JsonRpcNotification = {
      method,
      ...(params === undefined ? {} : { params }),
    };
    await this.#write(notification);
  }

  async forwardNotification(notification: JsonRpcNotification): Promise<void> {
    await this.#write(jsonRpcNotificationSchema.parse(notification));
  }

  async forwardResponse(response: JsonRpcResponse): Promise<void> {
    await this.#write(jsonRpcResponseSchema.parse(response));
  }

  #wireProcess(child: ChildProcessWithoutNullStreams): void {
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      this.#handleLine(line);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      this.emit('stderr', chunk.toString('utf8'));
    });
    child.on('error', (error) => {
      this.emit('error', error);
    });
    child.on('exit', (code, signal) => {
      if (this.#child !== child) return;
      this.#child = undefined;
      this.#ready = false;
      const error = new Error(
        `app-server exited${code === null ? '' : ` with code ${String(code)}`}${
          signal === null ? '' : ` from ${signal}`
        }`,
      );
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      this.#pending.clear();
      if (!this.#stopping) this.emit('exit', { code, signal });
    });
  }

  #handleLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.emit('protocol-error', new Error('app-server emitted invalid JSON'));
      return;
    }

    const response = jsonRpcResponseSchema.safeParse(value);
    if (response.success) {
      const pending = this.#pending.get(response.data.id);
      if (pending !== undefined) {
        clearTimeout(pending.timeout);
        this.#pending.delete(response.data.id);
        if (response.data.error !== undefined) {
          const error = new Error(
            `${pending.method}: ${response.data.error.message} (${String(response.data.error.code)})`,
          );
          Object.assign(error, { rpcError: response.data.error });
          pending.reject(error);
        } else {
          pending.resolve(response.data.result);
        }
      } else {
        this.emit('response', response.data);
      }
      return;
    }

    const request = jsonRpcRequestSchema.safeParse(value);
    if (request.success) {
      const event: ServerRequestEvent = {
        request: request.data,
        respond: async (reply) => {
          await this.forwardResponse({ ...reply, id: request.data.id });
        },
      };
      this.emit('request', event);
      return;
    }

    const notification = jsonRpcNotificationSchema.safeParse(value);
    if (notification.success) {
      this.emit('notification', notification.data);
      return;
    }

    this.emit('protocol-error', new Error('app-server emitted an unknown JSON-RPC message'));
  }

  async #write(message: object): Promise<void> {
    const child = this.#child;
    if (child === undefined || !child.stdin.writable) {
      throw new Error('app-server stdin is not writable');
    }
    const data = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(data, (error) => {
        if (error === null || error === undefined) resolve();
        else reject(error);
      });
    });
  }
}
