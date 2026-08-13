import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  createReadStream,
  createWriteStream,
  realpathSync,
  statSync,
  watch,
  type FSWatcher,
} from 'node:fs';
import { copyFile, cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import nodePath from 'node:path';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MessageChannel, Worker, type MessagePort } from 'node:worker_threads';

import {
  officialGitExportNames,
  readQualifiedOfficialVersion,
} from './official-export-contract.js';
import { loadQualifiedLocalExecutionHostRpc } from './official-main-contract.js';
import { resolveOfficialSharedModulePath } from './official-shared-module.js';

interface OfficialRpcSession {
  [Symbol.dispose](): void;
}

interface OfficialSharedModule {
  At(port: MessagePort, target: unknown): OfficialRpcSession;
  D: new (
    gitManager: unknown,
    getAppServerClient: (hostId: string) => unknown,
  ) => OfficialGithubServiceTarget;
  F: new (appEvent: { subscribe: (listener: (event: unknown) => void) => () => void }) => unknown;
  I: new (getExecutionHost: (hostId: string) => LocalExecutionHost) => unknown;
}

interface OfficialGithubServiceTarget {
  request(kind: string, params: unknown, source: unknown): OfficialGithubRequestHandle;
}

export interface OfficialGithubRequestHandle {
  wait(): Promise<unknown>;
  [Symbol.dispose](): void;
}

export interface OfficialGitWorkerOptions {
  sourceRoot: string;
  userRoot: string;
  codexHome: string;
  workspaceRoot: string;
  appVersion: string;
  buildNumber: string;
  buildFlavor: string;
}

interface WorkerMainRpcRequest {
  type: 'worker-main-rpc-request';
  workerId: string;
  requestId: string;
  method: string;
  params: unknown;
}

interface WorkerResponse {
  id: string;
  method: string;
  result: { type: 'ok'; value: unknown } | { type: 'error'; error: unknown };
}

interface PendingInternalRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
  signal: AbortSignal | null;
  abortListener: (() => void) | null;
}

export interface OfficialGitWorkerRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Loads the official GitHub AppHost implementation unchanged and supplies only
 * the local process/path interfaces that Electron's app-server wrapper would
 * normally provide.
 */
export class OfficialGithubService {
  readonly #service: OfficialGithubServiceTarget;

  constructor(options: OfficialGitWorkerOptions) {
    const shared = loadOfficialGitModule(options.sourceRoot);
    if (typeof shared.D !== 'function' || typeof shared.F !== 'function') {
      throw new Error('qualified official GitHub service exports changed');
    }
    const executionHost = new LocalExecutionHost(options, () => undefined);
    const appServerClient = new LocalGithubAppServerClient(options, executionHost);
    const gitManager = new shared.F({
      subscribe: () => () => undefined,
    });
    this.#service = new shared.D(gitManager, (hostId) => {
      if (hostId !== 'local') throw new Error(`GitHub execution host is unavailable: ${hostId}`);
      return appServerClient;
    });
  }

  request(kind: string, params: unknown, source: unknown): OfficialGithubRequestHandle {
    if (kind.length === 0 || kind.length > 128) {
      throw new Error('invalid official GitHub request kind');
    }
    return this.#service.request(kind, params, source);
  }
}

interface FileWatchOptions {
  path: string;
  recursive?: boolean;
  renameEventHandling?: string;
  onChange: (event: { changedPaths: string[] }) => unknown;
}

interface GitProcessDiagnostic {
  command: string;
  subcommand: string | null;
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

const require = createRequire(import.meta.url);

export class OfficialGitWorker extends EventEmitter {
  readonly options: OfficialGitWorkerOptions;
  #worker: Worker | undefined;
  #rpcSession: OfficialRpcSession | undefined;
  #starting: Promise<void> | undefined;
  #stopping = false;
  #pendingInternalRequests = new Map<string, PendingInternalRequest>();

  constructor(options: OfficialGitWorkerOptions) {
    super();
    this.options = {
      ...options,
      sourceRoot: resolve(options.sourceRoot),
      userRoot: resolve(options.userRoot),
      codexHome: resolve(options.codexHome),
      workspaceRoot: resolve(options.workspaceRoot),
    };
  }

  async start(): Promise<void> {
    if (this.#worker !== undefined) return;
    if (this.#starting !== undefined) return this.#starting;
    this.#starting = this.#start();
    try {
      await this.#starting;
    } finally {
      this.#starting = undefined;
    }
  }

  async post(message: unknown): Promise<void> {
    if (!isOfficialGitWorkerInput(message)) {
      throw new Error('invalid official Git worker input');
    }
    await this.start();
    this.#worker?.postMessage(message);
  }

  async request(
    method: string,
    params: Record<string, unknown>,
    options: OfficialGitWorkerRequestOptions = {},
  ): Promise<unknown> {
    if (method.length === 0 || method.length > 128) {
      throw new Error('invalid official Git worker request method');
    }
    if (params === null || typeof params !== 'object' || Array.isArray(params)) {
      throw new Error('invalid official Git worker request parameters');
    }
    if (options.signal?.aborted === true) {
      throw new Error(`official Git worker request was canceled: ${method}`);
    }
    await this.start();
    const worker = this.#worker;
    if (worker === undefined) throw new Error('official Git worker did not start');
    const id = `host-${randomUUID()}`;
    const timeoutMs = options.timeoutMs ?? 120_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3_600_000) {
      throw new Error('invalid official Git worker request timeout');
    }
    return new Promise<unknown>((resolveRequest, rejectRequest) => {
      const pending: PendingInternalRequest = {
        method,
        resolve: resolveRequest,
        reject: rejectRequest,
        timer: null,
        signal: options.signal ?? null,
        abortListener: null,
      };
      const cancel = (reason: Error): void => {
        if (this.#pendingInternalRequests.get(id) !== pending) return;
        this.#pendingInternalRequests.delete(id);
        this.#disposePendingRequest(pending);
        worker.postMessage({ type: 'worker-request-cancel', workerId: 'git', id });
        pending.reject(reason);
      };
      pending.timer = setTimeout(() => {
        cancel(new Error(`official Git worker request timed out: ${method}`));
      }, timeoutMs);
      pending.timer.unref();
      if (pending.signal !== null) {
        pending.abortListener = () => {
          cancel(new Error(`official Git worker request was canceled: ${method}`));
        };
        pending.signal.addEventListener('abort', pending.abortListener, { once: true });
      }
      this.#pendingInternalRequests.set(id, pending);
      worker.postMessage({
        type: 'worker-request',
        workerId: 'git',
        request: {
          id,
          method,
          params,
          enqueuedAtMs: Date.now(),
        },
      });
    });
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#rejectInternalRequests(new Error('official Git worker stopped'));
    const worker = this.#worker;
    this.#worker = undefined;
    if (worker !== undefined) {
      const exited = new Promise<void>((resolveExit) => {
        worker.once('exit', () => resolveExit());
      });
      worker.postMessage({ type: 'worker-flush-and-exit' });
      const timeout = new Promise<void>((resolveTimeout) => {
        const timer = setTimeout(resolveTimeout, 11_000);
        timer.unref();
      });
      await Promise.race([exited, timeout]);
      await worker.terminate();
    }
    this.#rpcSession?.[Symbol.dispose]();
    this.#rpcSession = undefined;
  }

  async #start(): Promise<void> {
    await Promise.all([
      mkdir(this.options.codexHome, { recursive: true, mode: 0o700 }),
      mkdir(this.options.workspaceRoot, { recursive: true, mode: 0o700 }),
      mkdir(join(this.options.userRoot, 'home'), { recursive: true, mode: 0o700 }),
      mkdir(join(this.options.userRoot, 'tmp'), { recursive: true, mode: 0o700 }),
    ]);
    const workerPath = join(this.options.sourceRoot, '.vite', 'build', 'worker.js');
    const shared = loadOfficialGitModule(this.options.sourceRoot);
    if (typeof shared.At !== 'function' || typeof shared.I !== 'function') {
      throw new Error('qualified official worker RPC exports changed');
    }
    const executionHost = new LocalExecutionHost(this.options, (diagnostic) => {
      this.emit('process-diagnostic', diagnostic);
    });
    const rpcTarget = new shared.I((hostId) => {
      if (hostId !== 'local') throw new Error(`Git execution host is unavailable: ${hostId}`);
      return executionHost;
    });
    const channel = new MessageChannel();
    this.#rpcSession = shared.At(channel.port1, rpcTarget);
    this.#stopping = false;
    const worker = new Worker(workerPath, {
      name: 'git',
      env: executionHost.workerEnvironment,
      workerData: {
        analyticsEnabled: false,
        workerId: 'git',
        sentryInitOptions: {
          codexAppSessionId: randomUUID(),
          appVersion: this.options.appVersion,
          buildFlavor: this.options.buildFlavor,
          buildNumber: this.options.buildNumber,
          desktopTraceSampleRate: 0,
          initialDesktopTraceSampleRate: 0,
        },
        maxLogLevel: 'warn',
        sentryRewriteFramesRoot: this.options.sourceRoot,
        spawnInsideWsl: false,
        mainRpcPort: channel.port2,
      },
      transferList: [channel.port2],
    });
    worker.on('message', (message: unknown) => {
      if (isWorkerMainRpcRequest(message)) {
        this.#handleMainRpcRequest(worker, message);
        return;
      }
      const response = parseWorkerResponse(message);
      if (response !== null && this.#settleInternalRequest(response)) return;
      this.emit('message', message);
    });
    worker.on('error', (error) => {
      this.#rejectInternalRequests(error);
      this.emit('error', error);
    });
    worker.on('exit', (code) => {
      if (this.#worker === worker) this.#worker = undefined;
      this.#rejectInternalRequests(
        new Error(`official Git worker exited with code ${String(code)}`),
      );
      if (!this.#stopping && code !== 0) {
        this.emit('error', new Error(`official Git worker exited with code ${String(code)}`));
      }
      this.emit('exit', code);
    });
    worker.unref();
    this.#worker = worker;
  }

  #handleMainRpcRequest(worker: Worker, request: WorkerMainRpcRequest): void {
    const result =
      request.method === 'otel-export'
        ? { type: 'ok' as const, value: {} }
        : {
            type: 'error' as const,
            error: { message: `official Git worker main RPC is unavailable: ${request.method}` },
          };
    worker.postMessage({
      type: 'worker-main-rpc-response',
      workerId: 'git',
      requestId: request.requestId,
      method: request.method,
      result,
    });
  }

  #settleInternalRequest(response: WorkerResponse): boolean {
    const pending = this.#pendingInternalRequests.get(response.id);
    if (pending === undefined) return false;
    this.#pendingInternalRequests.delete(response.id);
    this.#disposePendingRequest(pending);
    if (response.method !== pending.method) {
      pending.reject(new Error('official Git worker response method changed'));
      return true;
    }
    if (response.result.type === 'ok') {
      pending.resolve(response.result.value);
    } else {
      pending.reject(officialWorkerError(response.result.error, pending.method));
    }
    return true;
  }

  #rejectInternalRequests(error: Error): void {
    for (const pending of this.#pendingInternalRequests.values()) {
      this.#disposePendingRequest(pending);
      pending.reject(error);
    }
    this.#pendingInternalRequests.clear();
  }

  #disposePendingRequest(pending: PendingInternalRequest): void {
    if (pending.timer !== null) clearTimeout(pending.timer);
    if (pending.signal !== null && pending.abortListener !== null) {
      pending.signal.removeEventListener('abort', pending.abortListener);
    }
  }
}

function loadOfficialGitModule(sourceRoot: string): Partial<OfficialSharedModule> {
  const sharedPath = resolveOfficialSharedModulePath(sourceRoot);
  const raw = require(sharedPath) as Record<string, unknown>;
  const version = readQualifiedOfficialVersion(sourceRoot);
  const names = officialGitExportNames(version);
  const localExecutionHostRpc =
    version === '26.810.41047'
      ? loadQualifiedLocalExecutionHostRpc(sourceRoot)
      : names.localExecutionHostRpc === null
        ? undefined
        : raw[names.localExecutionHostRpc];
  return {
    At: raw[names.attachRpc] as OfficialSharedModule['At'],
    D: raw[names.githubService] as OfficialSharedModule['D'],
    F: raw[names.gitManager] as OfficialSharedModule['F'],
    I: localExecutionHostRpc as OfficialSharedModule['I'],
  };
}

class LocalGithubAppServerClient {
  readonly id = 'local';
  readonly isLocal = true;
  readonly hostConfig = {
    id: 'local',
    display_name: 'Local',
    kind: 'local',
  };
  readonly #options: OfficialGitWorkerOptions;
  readonly #executionHost: LocalExecutionHost;

  constructor(options: OfficialGitWorkerOptions, executionHost: LocalExecutionHost) {
    this.#options = options;
    this.#executionHost = executionHost;
  }

  spawn(optionsValue: unknown): LocalSpawnResult {
    if (optionsValue === null || typeof optionsValue !== 'object' || Array.isArray(optionsValue)) {
      throw new TypeError('invalid official GitHub spawn options');
    }
    const options = optionsValue as Record<string, unknown>;
    const requestedCwd = typeof options.cwd === 'string' ? resolve(options.cwd) : null;
    const cwd =
      requestedCwd !== null && isWithin(this.#options.userRoot, requestedCwd)
        ? requestedCwd
        : this.#options.workspaceRoot;
    return this.#executionHost.spawn({ ...options, cwd });
  }

  platformPath(): Promise<typeof nodePath> {
    return Promise.resolve(nodePath);
  }
}

class LocalExecutionHost {
  readonly #options: OfficialGitWorkerOptions;
  readonly #root: string;
  readonly #canonicalRoot: string;
  readonly #onDiagnostic: (diagnostic: GitProcessDiagnostic) => void;
  readonly workerEnvironment: NodeJS.ProcessEnv;

  constructor(
    options: OfficialGitWorkerOptions,
    onDiagnostic: (diagnostic: GitProcessDiagnostic) => void,
  ) {
    this.#options = options;
    this.#root = resolve(options.userRoot);
    this.#canonicalRoot = realpathSync(this.#root);
    this.#onDiagnostic = onDiagnostic;
    this.workerEnvironment = safeEnvironment(this.#root);
  }

  spawn(optionsValue: unknown): LocalSpawnResult {
    const options = parseSpawnOptions(optionsValue);
    const [command, ...args] = options.args;
    if (command === undefined) throw new Error('Git worker command is missing');
    const commandName = basename(command);
    const subcommand = commandName === 'git' ? (args[0] ?? null) : null;
    try {
      this.#assertSpawn(options.args, options.cwd);
    } catch (error) {
      this.#onDiagnostic({
        command: commandName,
        subcommand,
        code: null,
        signal: null,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    const explicitRepository = normalizeExplicitGitDirectory(
      options.args,
      options.cwd,
      options.env,
    );
    const child = spawn(command, args, {
      cwd: explicitRepository.cwd,
      env: mergeSpawnEnvironment(this.workerEnvironment, explicitRepository.env),
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return new LocalSpawnResult(child, {
      command: commandName,
      subcommand,
      onDiagnostic: this.#onDiagnostic,
    });
  }

  readFile(path: string): ReadableStream<Uint8Array> {
    this.#assertAllowedPath(path, 'readFile');
    return Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
  }

  async writeFile(path: string, value: unknown): Promise<void> {
    this.#assertAllowedPath(path, 'writeFile');
    if (typeof value === 'string' || value instanceof Uint8Array) {
      await writeFile(path, value);
      return;
    }
    if (value instanceof ArrayBuffer) {
      await writeFile(path, Buffer.from(value));
      return;
    }
    if (isReadableStream(value)) {
      await pipeline(nodeReadableFromWeb(value), createWriteStream(path, { mode: 0o600 }));
      return;
    }
    throw new TypeError('unsupported Git worker file body');
  }

  async createDirectory(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    this.#assertAllowedPath(path, 'createDirectory');
    await mkdir(path, { recursive: options.recursive === true, mode: 0o700 });
  }

  async stat(path: string): Promise<Awaited<ReturnType<typeof stat>>> {
    this.#assertAllowedPathOrAncestor(path);
    return stat(path);
  }

  async readDirectory(path: string): Promise<
    Array<{
      name: string;
      isDirectory(): boolean;
      isFile(): boolean;
      isSymbolicLink(): boolean;
    }>
  > {
    this.#assertAllowedPath(path, 'readDirectory');
    return readdir(path, { withFileTypes: true });
  }

  async remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } = {},
  ): Promise<void> {
    this.#assertAllowedPath(path, 'remove');
    await rm(path, { recursive: options.recursive === true, force: options.force === true });
  }

  async copyFile(source: string, destination: string): Promise<void> {
    this.#assertAllowedPath(source, 'copyFile-source');
    this.#assertAllowedPath(destination, 'copyFile-destination');
    await copyFile(source, destination);
  }

  async copy(
    source: string,
    destination: string,
    options: { recursive?: boolean; force?: boolean } = {},
  ): Promise<void> {
    this.#assertAllowedPath(source, 'copy-source');
    this.#assertAllowedPath(destination, 'copy-destination');
    await cp(source, destination, {
      recursive: options.recursive === true,
      force: options.force !== false,
      errorOnExist: options.force === false,
    });
  }

  codexHome(): string {
    return this.#options.codexHome;
  }

  platformFamily(): 'windows' | 'unix' {
    return process.platform === 'win32' ? 'windows' : 'unix';
  }

  platformOs(): 'windows' | 'macos' | 'linux' {
    if (process.platform === 'win32') return 'windows';
    if (process.platform === 'darwin') return 'macos';
    return 'linux';
  }

  startFileWatch(optionsValue: unknown): LocalFileWatchSession {
    const options = parseFileWatchOptions(optionsValue);
    this.#assertAllowedPath(options.path, 'startFileWatch');
    return new LocalFileWatchSession(options);
  }

  #assertSpawn(args: string[], cwd: string): void {
    const command = args[0];
    const commandName = command === undefined ? '' : basename(command);
    if (commandName !== 'git' && commandName !== 'gh' && commandName !== 'sh') {
      throw new Error(`official Git worker command is not allowed: ${commandName}`);
    }
    if (
      resolve(cwd) === '/' &&
      (isGitVersionProbe(args) || isScopedTemporaryDirectoryCommand(args))
    ) {
      return;
    }
    if (resolve(cwd) === '/') {
      throw new Error(
        `official Git worker root command is not allowed: ${commandName} ${args[1] ?? ''}`.trim(),
      );
    }
    this.#assertAllowedPath(cwd, 'spawn');
  }

  #assertAllowedPath(path: string, operation = 'path'): void {
    if (typeof path !== 'string' || !isAbsolute(path)) {
      throw new Error('Git worker paths must be absolute');
    }
    const absolute = resolve(path);
    const lexicalRoot = isWithin(this.#root, absolute)
      ? this.#root
      : isWithin(this.#canonicalRoot, absolute)
        ? this.#canonicalRoot
        : null;
    if (lexicalRoot === null) {
      throw new Error(`Git worker ${operation} path escaped the user runtime: ${absolute}`);
    }
    let existing = absolute;
    while (existing !== lexicalRoot) {
      try {
        statSync(existing);
        const canonical = realpathSync(existing);
        if (!isWithin(this.#canonicalRoot, canonical)) {
          throw new Error('Git worker path crossed a symbolic link outside the user runtime');
        }
        return;
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          (error.code === 'ENOENT' || error.code === 'ENOTDIR')
        ) {
          existing = dirname(existing);
          continue;
        }
        throw error;
      }
    }
  }

  #assertAllowedPathOrAncestor(path: string): void {
    if (typeof path !== 'string' || !isAbsolute(path)) {
      throw new Error('Git worker paths must be absolute');
    }
    const absolute = resolve(path);
    if (isWithin(absolute, this.#root) || isWithin(absolute, this.#canonicalRoot)) return;
    this.#assertAllowedPath(absolute, 'stat');
  }
}

/**
 * Git 2.43 treats running from a repository's `.git` directory as implicit
 * bare-repository discovery when `safe.bareRepository=explicit` is enabled.
 * The current official desktop Git module intentionally enables that guard and
 * reads repository-scoped configuration from the common Git directory. Make
 * the same repository explicit through Git's standard environment boundary;
 * the official command and its safety setting remain unchanged.
 */
function normalizeExplicitGitDirectory(
  args: string[],
  cwd: string,
  env: Record<string, string>,
): { cwd: string; env: Record<string, string> } {
  if (
    process.platform !== 'linux' ||
    basename(args[0] ?? '') !== 'git' ||
    gitSubcommand(args) !== 'config' ||
    !args.includes('safe.bareRepository=explicit') ||
    basename(cwd) !== '.git' ||
    env.GIT_DIR !== undefined ||
    env.GIT_WORK_TREE !== undefined
  ) {
    return { cwd, env };
  }
  try {
    if (!statSync(join(cwd, 'config')).isFile()) return { cwd, env };
  } catch {
    return { cwd, env };
  }
  return {
    cwd: dirname(cwd),
    env: {
      ...env,
      GIT_DIR: cwd,
      GIT_WORK_TREE: dirname(cwd),
    },
  };
}

function gitSubcommand(args: string[]): string | null {
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '-c') {
      index += 1;
      continue;
    }
    if (argument?.startsWith('-') === true) continue;
    return argument ?? null;
  }
  return null;
}

class LocalSpawnResult {
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #result: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  #exited = false;

  constructor(
    child: ChildProcessWithoutNullStreams,
    diagnostic: {
      command: string;
      subcommand: string | null;
      onDiagnostic: (diagnostic: GitProcessDiagnostic) => void;
    },
  ) {
    this.#child = child;
    this.stdin = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    this.stdout = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    this.stderr = Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>;
    this.#result = new Promise((resolveResult, rejectResult) => {
      child.once('error', (error) => {
        diagnostic.onDiagnostic({
          command: diagnostic.command,
          subcommand: diagnostic.subcommand,
          code: null,
          signal: null,
          error: error.message,
        });
        rejectResult(error);
      });
      child.once('exit', (code, signal) => {
        this.#exited = true;
        diagnostic.onDiagnostic({
          command: diagnostic.command,
          subcommand: diagnostic.subcommand,
          code,
          signal,
        });
        resolveResult({ code, signal });
      });
    });
  }

  wait(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return this.#result;
  }

  kill(): void {
    if (this.#exited) return;
    if (process.platform !== 'win32' && this.#child.pid !== undefined) {
      try {
        process.kill(-this.#child.pid, 'SIGTERM');
      } catch {
        this.#child.kill('SIGTERM');
      }
    } else {
      this.#child.kill('SIGTERM');
    }
  }

  resize(): void {}
}

class LocalFileWatchSession {
  readonly path: string;
  readonly coverage: { recursive: boolean };
  readonly closed: Promise<{ reason: string; error?: string }>;
  readonly #watcher: FSWatcher;
  readonly #resolveClosed: (value: { reason: string; error?: string }) => void;
  #disposed = false;

  constructor(options: FileWatchOptions) {
    this.path = options.path;
    this.coverage = { recursive: options.recursive === true };
    let resolveClosed: (value: { reason: string; error?: string }) => void = () => undefined;
    this.closed = new Promise((resolveValue) => {
      resolveClosed = resolveValue;
    });
    this.#resolveClosed = resolveClosed;
    this.#watcher = watch(
      options.path,
      { recursive: options.recursive === true },
      (_eventType, filename) => {
        const changedPath = filename === null ? null : join(options.path, filename.toString());
        const changedPaths =
          changedPath === null
            ? []
            : options.renameEventHandling === 'changed-path-with-parent-directory'
              ? [changedPath, dirname(changedPath)]
              : [changedPath];
        Promise.resolve(options.onChange({ changedPaths })).catch(() => undefined);
      },
    );
    this.#watcher.once('error', (error) => {
      if (this.#disposed) return;
      this.#disposed = true;
      this.#watcher.close();
      this.#resolveClosed({ reason: 'watch-error', error: error.message });
    });
    this.#watcher.once('close', () => {
      if (this.#disposed) return;
      this.#disposed = true;
      this.#resolveClosed({ reason: 'connection-closed' });
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#watcher.close();
    this.#resolveClosed({ reason: 'disposed' });
  }
}

export function isOfficialGitWorkerInput(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (message.workerId !== 'git') return false;
  if (message.type === 'worker-request-cancel') {
    return typeof message.id === 'string' && message.id.length > 0 && message.id.length <= 256;
  }
  if (
    message.type !== 'worker-request' ||
    message.request === null ||
    typeof message.request !== 'object' ||
    Array.isArray(message.request)
  ) {
    return false;
  }
  const request = message.request as Record<string, unknown>;
  return (
    typeof request.id === 'string' &&
    request.id.length > 0 &&
    request.id.length <= 256 &&
    typeof request.method === 'string' &&
    request.method.length > 0 &&
    request.method.length <= 128 &&
    request.params !== null &&
    typeof request.params === 'object' &&
    !Array.isArray(request.params)
  );
}

function isWorkerMainRpcRequest(value: unknown): value is WorkerMainRpcRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return (
    message.type === 'worker-main-rpc-request' &&
    message.workerId === 'git' &&
    typeof message.requestId === 'string' &&
    typeof message.method === 'string'
  );
}

function parseWorkerResponse(value: unknown): WorkerResponse | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  if (
    envelope.type !== 'worker-response' ||
    envelope.workerId !== 'git' ||
    envelope.response === null ||
    typeof envelope.response !== 'object' ||
    Array.isArray(envelope.response)
  ) {
    return null;
  }
  const response = envelope.response as Record<string, unknown>;
  if (
    typeof response.id !== 'string' ||
    typeof response.method !== 'string' ||
    response.result === null ||
    typeof response.result !== 'object' ||
    Array.isArray(response.result)
  ) {
    return null;
  }
  const result = response.result as Record<string, unknown>;
  if (result.type === 'ok') {
    return {
      id: response.id,
      method: response.method,
      result: { type: 'ok', value: result.value },
    };
  }
  if (result.type === 'error') {
    return {
      id: response.id,
      method: response.method,
      result: { type: 'error', error: result.error },
    };
  }
  return null;
}

function officialWorkerError(value: unknown, method: string): Error {
  if (typeof value === 'string' && value.length > 0) return new Error(value);
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const message = (value as Record<string, unknown>).message;
    if (typeof message === 'string' && message.length > 0) return new Error(message);
  }
  return new Error(`official Git worker request failed: ${method}`);
}

function parseSpawnOptions(value: unknown): {
  args: string[];
  cwd: string;
  env: Record<string, string>;
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('invalid Git worker spawn options');
  }
  const options = value as Record<string, unknown>;
  if (
    !Array.isArray(options.args) ||
    options.args.length === 0 ||
    options.args.length > 256 ||
    !options.args.every((entry) => typeof entry === 'string' && entry.length <= 32_768) ||
    typeof options.cwd !== 'string'
  ) {
    throw new TypeError('invalid Git worker process command');
  }
  const env: Record<string, string> = {};
  if (options.env !== undefined) {
    if (options.env === null || typeof options.env !== 'object' || Array.isArray(options.env)) {
      throw new TypeError('invalid Git worker process environment');
    }
    for (const [key, entry] of Object.entries(options.env)) {
      if (typeof entry === 'string') env[key] = entry;
    }
  }
  return { args: options.args as string[], cwd: options.cwd, env };
}

function parseFileWatchOptions(value: unknown): FileWatchOptions {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('invalid Git worker file watch');
  }
  const options = value as Record<string, unknown>;
  if (typeof options.path !== 'string' || typeof options.onChange !== 'function') {
    throw new TypeError('invalid Git worker file watch options');
  }
  return {
    path: options.path,
    recursive: options.recursive === true,
    ...(typeof options.renameEventHandling === 'string'
      ? { renameEventHandling: options.renameEventHandling }
      : {}),
    onChange: options.onChange as FileWatchOptions['onChange'],
  };
}

function safeEnvironment(userRoot: string): NodeJS.ProcessEnv {
  const path = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
  return {
    HOME: join(userRoot, 'home'),
    LANG: process.env.LANG ?? 'C.UTF-8',
    LC_ALL: process.env.LC_ALL ?? 'C.UTF-8',
    PATH: path,
    TMPDIR: join(userRoot, 'tmp'),
    USER: `codex-${basename(userRoot).slice(0, 32)}`,
  };
}

function mergeSpawnEnvironment(
  base: NodeJS.ProcessEnv,
  requested: Record<string, string>,
): NodeJS.ProcessEnv {
  const output = { ...base };
  for (const [key, value] of Object.entries(requested)) {
    if (
      key === 'PATH' ||
      key === 'HOME' ||
      key === 'TMPDIR' ||
      key === 'NODE_OPTIONS' ||
      key === 'BASH_ENV' ||
      key === 'ENV' ||
      key === 'GIT_SSH_COMMAND' ||
      key === 'GIT_EXTERNAL_DIFF' ||
      key.startsWith('LD_') ||
      key.startsWith('DYLD_')
    ) {
      continue;
    }
    if (
      key === 'LANG' ||
      key === 'LC_ALL' ||
      key.startsWith('LC_') ||
      key.startsWith('GIT_') ||
      key === 'GH_BROWSER' ||
      key === 'GH_PROMPT_DISABLED' ||
      key === 'SSH_AUTH_SOCK' ||
      key === 'TERM'
    ) {
      output[key] = value;
    }
  }
  return output;
}

function isGitVersionProbe(args: string[]): boolean {
  return (
    basename(args[0] ?? '') === 'sh' &&
    args[1] === '-c' &&
    typeof args[2] === 'string' &&
    args[2].includes('command -v git') &&
    args[2].includes('--version')
  );
}

function isScopedTemporaryDirectoryCommand(args: string[]): boolean {
  return (
    basename(args[0] ?? '') === 'sh' &&
    args[1] === '-c' &&
    args[2] === 'mktemp -d "${TMPDIR:-/tmp}/$1XXXXXX"' &&
    args[3] === 'sh' &&
    typeof args[4] === 'string' &&
    /^codex-[a-z0-9-]{1,64}$/u.test(args[4])
  );
}

function isWithin(root: string, path: string): boolean {
  const value = relative(root, path);
  return value === '' || (!value.startsWith('..') && !isAbsolute(value));
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return (
    value !== null &&
    typeof value === 'object' &&
    'getReader' in value &&
    typeof (value as { getReader?: unknown }).getReader === 'function'
  );
}

function nodeReadableFromWeb(stream: ReadableStream<Uint8Array>): Readable {
  const reader = stream.getReader();
  return Readable.from(
    (async function* () {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          yield value;
        }
      } finally {
        reader.releaseLock();
      }
    })(),
  );
}
