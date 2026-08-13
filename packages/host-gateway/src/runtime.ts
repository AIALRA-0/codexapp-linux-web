import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { release as osRelease, version as osVersion } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  jsonRpcNotificationSchema,
  jsonRpcResponseSchema,
  type AuthentikIdentity,
  type JsonRpcId,
  type JsonRpcRequest,
} from '@codexapp/contracts';

import {
  toOfficialRendererNotification,
  toOfficialRendererRequest,
} from './official-renderer-messages.js';
import { CodexAppServerClient, type ServerRequestEvent } from '@codexapp/app-server-client';

import { deleteAllArchivedThreads, deleteArchivedThread } from './archived-thread-operations.js';
import { BackgroundWorkTracker, type BackgroundWorkSnapshot } from './background-work.js';
import { DiscoveryResponseCacheStore } from './discovery-response-cache.js';
import {
  readBrowserPermissionSnapshot,
  writeBrowserApprovalMode,
  writeBrowserFileTransferApprovalMode,
  writeBrowserFullCdpAccessEnabled,
  writeBrowserHistoryApprovalMode,
} from './browser-use-permissions.js';
import type { GatewayConfig } from './config.js';
import { identitiesMatch, userKeyForIdentity } from './identity.js';
import { prepareRendererRequest } from './login.js';
import { OfficialElectronNetwork } from './electron-network.js';
import {
  RendererFetchProxy,
  resolveRendererFetchUrl,
  type HostDownloadRequest,
} from './network.js';
import { OfficialAppDirectoryCache } from './official-app-directory.js';
import { OfficialAutomationController } from './official-automation.js';
import { OfficialBrowserRuntime } from './browser-runtime.js';
import { buildOfficialDeveloperInstructions } from './official-developer-instructions.js';
import { OfficialDesktopState } from './official-desktop-state.js';
import { OfficialGithubService, OfficialGitWorker } from './official-git-worker.js';
import {
  AppServerHistorySnapshotsService,
  AppServerHistorySnapshotStore,
  type HistorySnapshotPrincipal,
} from './history-snapshots.js';
import { OfficialPrewarmedThreads } from './prewarmed-threads.js';
import { RequestUserInputAutoResolution } from './request-user-input-auto-resolution.js';
import { ensureRuntimeDirectory, resolveRuntimeDirectory } from './runtime-directory.js';
import { DurableStateStore } from './state.js';
import {
  readOfficialDesktopFile,
  readOfficialDesktopFileBinary,
  readOfficialDesktopFileMetadata,
  readOfficialExistingPaths,
  readOfficialWorkspaceDirectoryEntries,
} from './desktop-files.js';
import { TurnLatencyTracker } from './turn-latency.js';
import { assertStorageAvailableForMethod } from './storage.js';
import { TerminalManager } from './terminal.js';
import { OfficialThreadCatalog } from './thread-catalog.js';
import { ThreadMetadataGenerator } from './thread-metadata-generation.js';

const execFileAsync = promisify(execFile);
const THREAD_CATALOG_STATE_KEY = '__browser-host-official-thread-catalog-v2';
const INITIAL_ROUTE_STATE_KEY = '__browser-host-initial-route-v1';
const PINNED_THREAD_IDS_KEY = 'pinned-thread-ids';
const INITIAL_SIDEBAR_GLOBAL_STATE_KEYS = [
  'desktop-first-seen-at-ms',
  'local-projects',
  'selected-project',
  'project-appearances',
  PINNED_THREAD_IDS_KEY,
  'pinned-project-ids',
  'sidebar-project-thread-orders',
  'sidebar-thread-metadata',
  'thread-project-assignments',
  'thread-workspace-root-hints',
  'projectless-thread-ids',
  'remote-projects',
  'project-order',
  'connection-group-order',
  'remote-cwds-by-host-and-workspace',
  'added-remote-control-env-ids',
] as const;

interface RendererRequestMetadata {
  browserSessionId?: string;
  method: string;
  prewarmThread?: boolean;
  rendererRequestId: JsonRpcId;
  responseCacheGeneration?: number;
  responseCacheKey?: string;
  responseCacheOverrideFingerprint?: string;
  responseCachePersistentKey?: string;
  responseCachePrincipalKey?: string;
  responseCacheTtlMs?: number;
  requestFingerprint?: string;
  requestShape?: Record<string, unknown>;
  startedAtMs: number;
  trace?: unknown;
}

interface RendererResponseCacheEntry {
  expiresAtMs: number;
  resumeOverrideFingerprint?: string;
  result: unknown;
}

interface RendererResponseInFlight {
  appServerRequestId: JsonRpcId;
  waiters: RendererRequestMetadata[];
}

export function rendererResponseCacheGenerationCanStore(
  requestGeneration: number | undefined,
  currentGeneration: number,
): boolean {
  return requestGeneration !== undefined && requestGeneration === currentGeneration;
}

export function rendererResponseCacheGenerationForKey(
  cacheKey: string,
  prefixGenerations: ReadonlyMap<string, number>,
): number {
  let generation = 0;
  for (const [prefix, prefixGeneration] of prefixGenerations) {
    if (cacheKey.startsWith(prefix)) generation = Math.max(generation, prefixGeneration);
  }
  return generation;
}

function rendererResponseInFlightKey(cacheKey: string, generation: number): string {
  return `${String(generation)}:${cacheKey}`;
}

const THREAD_RESUME_CACHE_PREFIX = 'thread/resume:';
const THREAD_TURNS_CACHE_PREFIX = 'thread/turns/list:';
const THREAD_ITEMS_CACHE_PREFIX = 'thread/items/list:';
const THREAD_CONTENT_CACHE_PREFIXES = [
  THREAD_RESUME_CACHE_PREFIX,
  THREAD_TURNS_CACHE_PREFIX,
  THREAD_ITEMS_CACHE_PREFIX,
] as const;
const THREAD_RESUME_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const THREAD_HISTORY_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_THREAD_RESUME_CACHE_ENTRIES = 32;
const MAX_THREAD_HISTORY_CACHE_ENTRIES = 64;
const MAX_THREAD_RESUME_CACHE_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_THREAD_HISTORY_CACHE_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_THREAD_HISTORY_CACHE_BYTES = 64 * 1024 * 1024;

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

interface RendererMessage {
  type?: unknown;
  [key: string]: unknown;
}

export interface BrowserDownload {
  path: string;
  fileName: string;
  browserSessionId: string;
}

export class CapabilityUnavailableError extends Error {
  readonly capability: string;

  constructor(capability: string) {
    super(`official desktop capability is not qualified for the browser host: ${capability}`);
    this.name = 'CapabilityUnavailableError';
    this.capability = capability;
  }
}

export function rendererRequestFingerprint(params: unknown): string {
  const canonical = canonicalizeRendererRequestValue(params);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 12);
}

const THREAD_RESUME_LOCATOR_KEYS = new Set([
  'cwd',
  'excludeTurns',
  'history',
  'initialTurnsPage',
  'path',
  'threadId',
]);

export function threadResumeHasMaterialOverrides(params: unknown): boolean {
  const request = recordOrNull(params);
  if (request === null) return false;
  return Object.entries(request).some(
    ([key, value]) => !THREAD_RESUME_LOCATOR_KEYS.has(key) && value !== null && value !== undefined,
  );
}

export function threadResumeOverrideFingerprint(params: unknown): string {
  const request = recordOrNull(params) ?? {};
  const overrides = Object.fromEntries(
    Object.entries(request).filter(([key]) => !THREAD_RESUME_LOCATOR_KEYS.has(key)),
  );
  return rendererRequestFingerprint(overrides);
}

export function rendererResponseCacheKey(method: string, params: unknown): string {
  if (method !== 'thread/resume') return `${method}:${rendererRequestFingerprint(params)}`;
  const request = recordOrNull(params) ?? {};
  const locator = Object.fromEntries(
    Object.entries(request).filter(([key]) => THREAD_RESUME_LOCATOR_KEYS.has(key)),
  );
  return `${THREAD_RESUME_CACHE_PREFIX}${rendererRequestFingerprint(locator)}`;
}

export function rendererPersistentResponseCacheKey(method: string, params: unknown): string {
  // A persisted entry survives the process which established its safety
  // context. Use every request field, including thread resume overrides, so a
  // later browser can never inherit a model, cwd, permission, or instruction
  // override from a different resume request.
  return `${method}:${rendererRequestFingerprint(params)}`;
}

export function rendererRequestShape(
  method: string,
  params: unknown,
): Record<string, unknown> | undefined {
  const record =
    params !== null && typeof params === 'object' && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};
  if (method === 'thread/resume') {
    return {
      parameterFingerprints: Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, rendererRequestFingerprint(record[key])]),
      ),
      parameterKeys: Object.keys(record).sort(),
    };
  }
  if (method !== 'plugin/list') return undefined;
  return {
    cwdCount: Array.isArray(record.cwds) ? record.cwds.length : null,
    cwdsProvided: Object.hasOwn(record, 'cwds'),
    marketplaceKindCount: Array.isArray(record.marketplaceKinds)
      ? record.marketplaceKinds.length
      : null,
    marketplaceKindsProvided: Object.hasOwn(record, 'marketplaceKinds'),
  };
}

export function rendererResponseCacheTtlMs(method: string, params?: unknown): number | null {
  // Match the unchanged official shell's own refresh windows. The browser host
  // persists these read-only results so a page refresh or host restart does not
  // repeat the same filesystem and MCP discovery work. Official mutations
  // invalidate the affected namespace immediately below.
  if (method === 'plugin/list' || method === 'plugin/installed') return 6 * 60 * 60 * 1_000;
  if (method === 'app/installed') return 5 * 60 * 1_000;
  if (method === 'mcpServerStatus/list') return 24 * 60 * 60 * 1_000;
  if (method === 'thread/turns/list' || method === 'thread/items/list') {
    return THREAD_HISTORY_CACHE_TTL_MS;
  }
  if (method === 'thread/resume') {
    const request = recordOrNull(params);
    const initialTurnsPage = recordOrNull(request?.initialTurnsPage);
    if (
      request?.excludeTurns === true &&
      initialTurnsPage?.limit === 5 &&
      initialTurnsPage.itemsView === 'full' &&
      initialTurnsPage.sortDirection === 'desc'
    ) {
      return THREAD_RESUME_CACHE_TTL_MS;
    }
  }
  return null;
}

export function rendererResponseCanBeCached(method: string, result: unknown): boolean {
  if (method === 'thread/turns/list' || method === 'thread/items/list') {
    const serialized = JSON.stringify(result);
    return (
      serialized !== undefined &&
      Buffer.byteLength(serialized) <= MAX_THREAD_HISTORY_CACHE_ENTRY_BYTES
    );
  }
  if (method !== 'thread/resume') return true;
  const response = recordOrNull(result);
  const thread = recordOrNull(response?.thread);
  const status = recordOrNull(thread?.status);
  if (status?.type !== 'idle') return false;
  const serialized = JSON.stringify(result);
  return (
    serialized !== undefined && Buffer.byteLength(serialized) <= MAX_THREAD_RESUME_CACHE_ENTRY_BYTES
  );
}

const THREAD_READ_ONLY_METHODS = new Set([
  'thread/backgroundTerminals/clean',
  'thread/goal/get',
  'thread/items/list',
  'thread/list',
  'thread/loaded/list',
  'thread/read',
  'thread/resume',
  'thread/search',
  'thread/searchOccurrences',
  'thread/settings/update',
  'thread/turns/list',
]);

export function rendererResponseCacheInvalidationPrefixes(method: string): string[] {
  if (
    method === 'plugin/install' ||
    method === 'plugin/uninstall' ||
    method.startsWith('plugin/marketplace/')
  ) {
    return ['plugin/', 'app/'];
  }
  if (
    method === 'config/value/write' ||
    method === 'config/batchWrite' ||
    method.startsWith('mcpServer/oauth/') ||
    method === 'mcpServer/reload' ||
    method === 'config/mcpServer/reload'
  ) {
    return ['mcpServerStatus/'];
  }
  if (method.startsWith('account/login') || method.startsWith('account/logout')) return [''];
  if (
    method.startsWith('turn/') ||
    (method.startsWith('thread/') && !THREAD_READ_ONLY_METHODS.has(method))
  ) {
    return [...THREAD_CONTENT_CACHE_PREFIXES];
  }
  return [];
}

export function rendererNotificationCacheInvalidationPrefixes(method: string): string[] {
  if (method.startsWith('mcpServer/')) return ['mcpServerStatus/'];
  if (method === 'turn/started' || method === 'turn/completed' || method === 'thread/deleted') {
    return [...THREAD_CONTENT_CACHE_PREFIXES];
  }
  return [];
}

function canonicalizeRendererRequestValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeRendererRequestValue);
  if (value === null || typeof value !== 'object') return value ?? null;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalizeRendererRequestValue(item)]),
  );
}

export class UserRuntime extends EventEmitter {
  readonly identity: AuthentikIdentity;
  readonly userKey: string;
  readonly root: string;
  readonly codexHome: string;
  readonly workspaceRoot: string;
  readonly uploadRoot: string;
  readonly config: GatewayConfig;
  readonly terminalManager: TerminalManager;
  readonly threadCatalog: OfficialThreadCatalog;
  readonly officialDesktopState: OfficialDesktopState;
  readonly automationController: OfficialAutomationController;
  readonly requestUserInputAutoResolution: RequestUserInputAutoResolution;
  readonly threadMetadataGenerator: ThreadMetadataGenerator;
  readonly browserRuntime: OfficialBrowserRuntime;
  readonly appServerHistorySnapshots: AppServerHistorySnapshotsService;

  #historySnapshotStore: AppServerHistorySnapshotStore;
  #discoveryResponseCacheStore: DiscoveryResponseCacheStore;

  #appServer: CodexAppServerClient | undefined;
  #appDirectoryCache: OfficialAppDirectoryCache;
  #fetchProxy: RendererFetchProxy;
  #state: DurableStateStore;
  #gitWorker: OfficialGitWorker | undefined;
  #githubService: OfficialGithubService | undefined;
  #pendingGitRequests = new Map<string, string>();
  #prewarmedThreads: OfficialPrewarmedThreads;
  #turnLatency: TurnLatencyTracker;
  #bootstrapPrepared = false;
  #preparingBootstrap: Promise<void> | undefined;
  #starting: Promise<void> | undefined;
  #appServerRestartTimer: NodeJS.Timeout | undefined;
  #appServerRestartAttempt = 0;
  #stopping = false;
  #rendererRequests = new Map<JsonRpcId, RendererRequestMetadata>();
  #rendererResponseCache = new Map<string, RendererResponseCacheEntry>();
  #rendererResponseInFlight = new Map<string, RendererResponseInFlight>();
  #rendererResponseCacheGeneration = 0;
  #rendererResponseCachePrefixGenerations = new Map<string, number>();
  #modelProviderCapabilities: unknown;
  #fetchControllers = new Map<string, AbortController>();
  #browserDownloads = new Map<string, BrowserDownload & { expiresAt: number }>();
  #backgroundWork: BackgroundWorkTracker;
  #pendingAppServerRequests = new Map<JsonRpcId, JsonRpcRequest>();

  constructor(
    identity: AuthentikIdentity,
    config: GatewayConfig,
    electronNetwork?: OfficialElectronNetwork,
  ) {
    super();
    this.identity = identity;
    this.config = config;
    this.userKey = userKeyForIdentity(identity);
    this.root = join(config.runtimeRoot, 'users', this.userKey);
    this.codexHome = join(this.root, 'codex-home');
    this.workspaceRoot = join(this.root, 'workspace');
    this.uploadRoot = join(this.root, 'uploads');
    this.#historySnapshotStore = new AppServerHistorySnapshotStore(
      join(this.root, 'codex-history-snapshots.db'),
    );
    this.#discoveryResponseCacheStore = new DiscoveryResponseCacheStore(
      join(this.root, 'codex-discovery-responses.db'),
    );
    this.appServerHistorySnapshots = new AppServerHistorySnapshotsService({
      getPrincipal: () => this.#readHistorySnapshotPrincipal(),
      onOperation: (method, durationMs) => {
        this.emit('performance', {
          durationMs,
          kind: 'app-server-history-snapshot',
          method,
        });
      },
      store: this.#historySnapshotStore,
    });
    this.terminalManager = new TerminalManager({
      userRoot: this.root,
      codexHome: this.codexHome,
      workspaceRoot: this.workspaceRoot,
      username: identity.username,
    });
    this.#state = new DurableStateStore(join(this.root, 'host-state.json'));
    this.#backgroundWork = new BackgroundWorkTracker((snapshot) => {
      this.emit('background-work-changed', snapshot);
    });
    this.#appDirectoryCache = new OfficialAppDirectoryCache(this.codexHome);
    this.#prewarmedThreads = new OfficialPrewarmedThreads({
      deleteExpiredThread: (threadId) => {
        void this.#appServer?.request('thread/delete', { threadId }).catch((error: unknown) => {
          this.emit('capability-error', {
            requestType: 'prewarmed-thread-delete',
            threadId,
            error: error instanceof Error ? error.message : 'prewarmed thread delete failed',
          });
        });
      },
      publishThreadStarted: (notification) => {
        this.#deliverAppServerNotification(notification, false);
      },
    });
    this.#turnLatency = new TurnLatencyTracker((measurement) => {
      this.emit('performance', measurement);
    });
    this.threadCatalog = new OfficialThreadCatalog({
      sourceRoot: config.officialSourceRoot,
      loadPersisted: () => this.#state.get('globalState', THREAD_CATALOG_STATE_KEY),
      persist: async (value) => {
        await this.#state.set('globalState', THREAD_CATALOG_STATE_KEY, value);
      },
      onError: (error) => {
        this.emit('capability-error', {
          requestType: 'thread-catalog',
          error: error.message,
        });
      },
    });
    this.officialDesktopState = new OfficialDesktopState({
      officialSourceRoot: config.officialSourceRoot,
      codexHome: this.codexHome,
      buildFlavor: config.expectedBuildFlavor,
    });
    this.officialDesktopState.on('stderr', (chunk: string) => {
      this.emit('app-server-stderr', `[official-desktop-state] ${chunk}`);
    });
    this.officialDesktopState.on('error', (error: Error) => {
      this.emit('capability-error', {
        requestType: 'official-desktop-state',
        error: error.message,
      });
    });
    this.officialDesktopState.on('exit', (details: unknown) => {
      this.emit('capability-error', {
        requestType: 'official-desktop-state-exit',
        details,
      });
    });
    this.requestUserInputAutoResolution = new RequestUserInputAutoResolution({
      onAutoResolve: (response) => {
        const appServer = this.#appServer;
        if (appServer === undefined) return;
        void appServer
          .forwardResponse(response)
          .then(() => {
            this.#pendingAppServerRequests.delete(response.id);
            this.#backgroundWork.observeClientResponse(response);
          })
          .catch((error: unknown) => {
            this.emit('capability-error', {
              requestType: 'request-user-input-auto-resolution',
              error: error instanceof Error ? error.message : 'automatic response failed',
            });
          });
      },
      onStateChanged: (change) => {
        this.emit('view-message', {
          type: 'request-user-input-auto-resolution-changed',
          hostId: 'local',
          change,
        });
      },
    });
    this.threadMetadataGenerator = new ThreadMetadataGenerator({
      getAppServer: () => this.#requireAppServer(),
    });
    this.browserRuntime = new OfficialBrowserRuntime({
      root: this.root,
      commentPreloadPath: join(config.officialSourceRoot, '.vite', 'build', 'comment-preload.js'),
      ...(config.browserExecutable === undefined
        ? {}
        : { executablePath: config.browserExecutable }),
      emitViewMessage: (message) => this.emit('view-message', message),
      registerDownload: (path, fileName, browserSessionId) =>
        this.registerBrowserDownload(path, fileName, browserSessionId),
      onError: (error, context) => {
        this.emit('capability-error', {
          requestType: 'official-browser',
          error: error.message,
          ...context,
        });
      },
    });
    this.automationController = new OfficialAutomationController({
      officialSourceRoot: config.officialSourceRoot,
      userRoot: this.root,
      codexHome: this.codexHome,
      workspaceRoot: this.workspaceRoot,
      desktopState: this.officialDesktopState,
      getAppServer: () => this.#requireAppServer(),
      requestGitWorker: (method, params, timeoutMs) =>
        this.#requireGitWorker().request(method, params, {
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      getGlobalState: (key) => this.#state.get('globalState', key),
      emitViewMessage: (message) => this.emit('view-message', message),
      onError: (error, context) => {
        this.emit('capability-error', {
          requestType: 'official-automation',
          error: error.message,
          ...context,
        });
      },
    });
    this.#fetchProxy = new RendererFetchProxy({
      appVersion: config.expectedRendererVersion,
      ...(electronNetwork === undefined
        ? {}
        : { electronFetchImplementation: electronNetwork.fetch.bind(electronNetwork) }),
      ...(config.openAiEgressProxyUrl === undefined
        ? {}
        : { egressProxyUrl: config.openAiEgressProxyUrl }),
      getAuthToken: async (refreshToken) => this.#getAuthToken(refreshToken),
      getIntegrityState: () => {
        const value = this.#state.get('globalState', 'openai-integrity-state');
        return typeof value === 'string' ? value : null;
      },
      storeIntegrityState: async (expected, value) => {
        return this.#state.compareAndSet('globalState', 'openai-integrity-state', expected, value);
      },
    });
  }

  get uploadPathPrefix(): string {
    return this.uploadRoot;
  }

  get githubService(): OfficialGithubService {
    this.#githubService ??= new OfficialGithubService({
      sourceRoot: this.config.officialSourceRoot,
      userRoot: this.root,
      codexHome: this.codexHome,
      workspaceRoot: this.workspaceRoot,
      appVersion: this.config.expectedRendererVersion,
      buildNumber: this.config.expectedBuildNumber,
      buildFlavor: this.config.expectedBuildFlavor,
    });
    return this.#githubService;
  }

  get sharedObjectSnapshot(): Record<string, unknown> {
    return this.#state.snapshot('sharedObjects');
  }

  get hasBackgroundWork(): boolean {
    return this.#backgroundWork.active;
  }

  get backgroundWorkSnapshot(): BackgroundWorkSnapshot {
    return this.#backgroundWork.snapshot;
  }

  get cachedInitialRoute(): '/' | '/login' | null {
    const value = this.#state.get('globalState', INITIAL_ROUTE_STATE_KEY);
    return value === '/' || value === '/login' ? value : null;
  }

  get initialSidebarBootstrap(): Record<string, unknown> {
    return {
      // The unchanged official renderer understands an incomplete bootstrap
      // snapshot and then pages through localThreadCatalog on demand. Keeping
      // this first payload bounded avoids serializing a user's entire history
      // into every fresh browser load.
      catalogSnapshot: this.threadCatalog.readBootstrapSnapshot(),
      globalStateEntries: INITIAL_SIDEBAR_GLOBAL_STATE_KEYS.map((key) => ({
        key,
        value: this.#state.get('globalState', key),
      })),
      workspaceRootOptions: this.workspaceRootOptions,
      projectlessWorkspaceRoot: { workspaceRoot: this.workspaceRoot },
    };
  }

  get workspaceRootOptions(): {
    roots: string[];
    labels: Record<string, string>;
  } {
    return workspaceRootOptionsFromGlobalState(
      this.getGlobalState('local-projects'),
      this.getGlobalState('project-order'),
      this.workspaceRoot,
    );
  }

  get activeWorkspaceRoots(): string[] {
    const projects = localProjectRecords(this.getGlobalState('local-projects'));
    const selected = this.getGlobalState('selected-project');
    if (
      selected !== null &&
      typeof selected === 'object' &&
      !Array.isArray(selected) &&
      (selected as Record<string, unknown>).type === 'local'
    ) {
      const projectId = (selected as Record<string, unknown>).projectId;
      if (typeof projectId === 'string') {
        const roots = localProjectRootPaths(projects[projectId]);
        if (roots.length > 0) return roots;
      }
    }
    return [this.workspaceRoot];
  }

  getGlobalState(key: string): unknown {
    return this.#state.get('globalState', key);
  }

  async setGlobalState(key: string, value: unknown): Promise<void> {
    await this.#state.set('globalState', key, value);
  }

  sendViewMessage(message: unknown): void {
    this.emit('view-message', message);
  }

  async requestAppServer(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    await this.start();
    return this.#requireAppServer().request(method, params, timeoutMs);
  }

  async downloadChatGptProjectFile(
    request: HostDownloadRequest,
  ): Promise<ReadableStream<Uint8Array>> {
    await this.start();
    return this.#fetchProxy.getDownloadStream(request);
  }

  registerBrowserDownload(path: string, fileName: string, browserSessionId: string): string {
    this.#removeExpiredBrowserDownloads();
    const token = randomUUID();
    this.#browserDownloads.set(token, {
      path,
      fileName,
      browserSessionId,
      expiresAt: Date.now() + 60_000,
    });
    return token;
  }

  claimBrowserDownload(token: string, fileName: string): BrowserDownload | null {
    this.#removeExpiredBrowserDownloads();
    const download = this.#browserDownloads.get(token);
    if (download === undefined || download.fileName !== fileName) return null;
    this.#browserDownloads.delete(token);
    return {
      path: download.path,
      fileName: download.fileName,
      browserSessionId: download.browserSessionId,
    };
  }

  async readInitialRoute(): Promise<'/' | '/login'> {
    await this.start();
    const response = (await this.#requireAppServer().request('getAuthStatus', {
      includeToken: false,
      refreshToken: false,
    })) as { authMethod?: unknown } | null;
    const route = initialRouteForAuthMethod(response?.authMethod);
    await this.#state.set('globalState', INITIAL_ROUTE_STATE_KEY, route);
    return route;
  }

  async prepareBootstrap(): Promise<void> {
    if (this.#bootstrapPrepared) return;
    if (this.#preparingBootstrap !== undefined) return this.#preparingBootstrap;
    this.#preparingBootstrap = this.#prepareBootstrap();
    try {
      await this.#preparingBootstrap;
    } finally {
      this.#preparingBootstrap = undefined;
    }
  }

  async start(): Promise<void> {
    if (this.#stopping) throw new Error('user runtime is stopping');
    if (this.#appServer?.ready === true) return;
    if (this.#starting !== undefined) return this.#starting;
    this.#clearAppServerRestartTimer();
    this.#starting =
      this.#appServer === undefined ? this.#start() : this.#restartAppServer(this.#appServer);
    try {
      await this.#starting;
    } catch (error) {
      this.#scheduleAppServerRestart();
      throw error;
    } finally {
      this.#starting = undefined;
    }
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#clearAppServerRestartTimer();
    for (const controller of this.#fetchControllers.values()) controller.abort();
    this.#fetchControllers.clear();
    this.#browserDownloads.clear();
    this.requestUserInputAutoResolution.clearPendingRequests();
    this.#backgroundWork.clear();
    this.#pendingAppServerRequests.clear();
    this.#rendererResponseCache.clear();
    this.#rendererResponseInFlight.clear();
    await this.#gitWorker?.stop();
    this.#gitWorker = undefined;
    this.#pendingGitRequests.clear();
    this.terminalManager.stop();
    this.threadCatalog.stop();
    this.automationController.stop();
    await this.officialDesktopState.stop();
    await this.browserRuntime.stop();
    this.#prewarmedThreads.clear();
    this.#turnLatency.clear();
    await this.#appServer?.stop();
    this.#appServer = undefined;
    this.#modelProviderCapabilities = undefined;
    this.appServerHistorySnapshots.invalidate();
    this.#historySnapshotStore.close();
    this.#discoveryResponseCacheStore.close();
  }

  async #readHistorySnapshotPrincipal(): Promise<HistorySnapshotPrincipal | null> {
    try {
      const persistedAuth = JSON.parse(
        await readFile(join(this.codexHome, 'auth.json'), 'utf8'),
      ) as unknown;
      const persistedPrincipal = historySnapshotPrincipalFromCodexAuth(persistedAuth);
      if (persistedPrincipal !== null) return persistedPrincipal;
    } catch {
      // A first-time login may not have written auth.json yet. In that case,
      // fall back to the authoritative running app-server response below.
    }
    await this.start();
    const token = await this.#getAuthToken(false);
    if (token === null) return null;
    return historySnapshotPrincipalFromAccessToken(token);
  }

  async handleViewMessage(messageValue: unknown, browserSessionId?: string): Promise<unknown> {
    await this.start();
    if (messageValue === null || typeof messageValue !== 'object') {
      throw new Error('renderer sent a non-object host message');
    }
    const message = messageValue as RendererMessage;
    if (typeof message.type !== 'string') {
      throw new Error('renderer host message is missing its type');
    }
    if (message.type.startsWith('browser-sidebar-')) {
      if (browserSessionId === undefined) throw new Error('browser session id is required');
      await this.browserRuntime.handleRendererMessage(browserSessionId, message);
      return undefined;
    }
    switch (message.type) {
      case '__browser-bridge-request':
        return this.#handleBridgeRequest(message);
      case 'mcp-request': {
        const prepared = prepareRendererRequest(message.request);
        const startedAtMs = Date.now();
        assertStorageAvailableForMethod(
          this.config.runtimeRoot,
          this.config.minimumFreeBytes,
          prepared.request.method,
        );
        if (prepared.request.method === 'app/list') {
          const cached = await this.#appDirectoryCache.list(prepared.request.params);
          if (cached !== null) {
            const receivedAtMs = Date.now();
            this.emit('performance', {
              kind: 'official-cache',
              method: prepared.request.method,
              durationMs: receivedAtMs - startedAtMs,
            });
            this.#emitRendererMessage(
              {
                type: 'mcp-response',
                hostId: 'local',
                message: { id: prepared.request.id, result: cached },
                ...(prepared.request.trace === undefined
                  ? {}
                  : {
                      receivedAtMs,
                      requestMethod: prepared.request.method,
                      trace: prepared.request.trace,
                    }),
              },
              browserSessionId,
            );
            return undefined;
          }
        }
        if (
          prepared.request.method === 'modelProvider/capabilities/read' &&
          this.#modelProviderCapabilities !== undefined
        ) {
          const receivedAtMs = Date.now();
          this.emit('performance', {
            kind: 'official-cache',
            method: prepared.request.method,
            durationMs: receivedAtMs - startedAtMs,
          });
          this.#emitRendererMessage(
            {
              type: 'mcp-response',
              hostId: 'local',
              message: {
                id: prepared.request.id,
                result: this.#modelProviderCapabilities,
              },
              ...(prepared.request.trace === undefined
                ? {}
                : {
                    receivedAtMs,
                    requestMethod: prepared.request.method,
                    trace: prepared.request.trace,
                  }),
            },
            browserSessionId,
          );
          return undefined;
        }
        const rendererRequestId = prepared.request.id;
        const appServerRequestId =
          browserSessionId === undefined ? rendererRequestId : randomUUID();
        const requestFingerprint = rendererRequestFingerprint(prepared.request.params);
        const responseCacheTtlMs = rendererResponseCacheTtlMs(
          prepared.request.method,
          prepared.request.params,
        );
        const responseCacheKey =
          responseCacheTtlMs === null
            ? undefined
            : rendererResponseCacheKey(prepared.request.method, prepared.request.params);
        const responseCacheGeneration =
          responseCacheKey === undefined
            ? undefined
            : this.#rendererResponseCacheGenerationForKey(responseCacheKey);
        const responseCacheOverrideFingerprint =
          prepared.request.method === 'thread/resume'
            ? threadResumeOverrideFingerprint(prepared.request.params)
            : undefined;
        let responseCacheReadEligible = responseCacheKey !== undefined;
        let responseCachePersistentKey: string | undefined;
        let responseCachePrincipalKey: string | undefined;
        if (responseCacheKey !== undefined) {
          let cached = this.#rendererResponseCache.get(responseCacheKey);
          if (cached !== undefined && cached.expiresAtMs <= Date.now()) {
            this.#rendererResponseCache.delete(responseCacheKey);
            cached = undefined;
          }
          responseCacheReadEligible =
            prepared.request.method !== 'thread/resume' ||
            !threadResumeHasMaterialOverrides(prepared.request.params) ||
            cached?.resumeOverrideFingerprint === responseCacheOverrideFingerprint;
          if (cached !== undefined && cached.expiresAtMs > Date.now()) {
            if (responseCacheReadEligible) {
              const receivedAtMs = Date.now();
              this.emit('performance', {
                kind: 'official-cache',
                method: prepared.request.method,
                durationMs: receivedAtMs - startedAtMs,
              });
              this.#emitRendererMessage(
                {
                  type: 'mcp-response',
                  hostId: 'local',
                  message: { id: rendererRequestId, result: cached.result },
                  ...(prepared.request.trace === undefined
                    ? {}
                    : {
                        receivedAtMs,
                        requestMethod: prepared.request.method,
                        trace: prepared.request.trace,
                      }),
                },
                browserSessionId,
              );
              return undefined;
            }
            this.#rendererResponseCache.delete(responseCacheKey);
          }
          responseCachePrincipalKey = await this.#readDiscoveryResponseCachePrincipalKey();
          if (responseCachePrincipalKey !== undefined) {
            try {
              const persistentCacheKey = rendererPersistentResponseCacheKey(
                prepared.request.method,
                prepared.request.params,
              );
              const persisted = this.#discoveryResponseCacheStore.read(
                responseCachePrincipalKey,
                persistentCacheKey,
              );
              if (persisted !== null) {
                const receivedAtMs = Date.now();
                this.#rendererResponseCache.set(responseCacheKey, {
                  ...persisted,
                  ...(responseCacheOverrideFingerprint === undefined
                    ? {}
                    : { resumeOverrideFingerprint: responseCacheOverrideFingerprint }),
                });
                this.emit('performance', {
                  kind: 'official-persistent-cache',
                  method: prepared.request.method,
                  durationMs: receivedAtMs - startedAtMs,
                });
                this.#emitRendererMessage(
                  {
                    type: 'mcp-response',
                    hostId: 'local',
                    message: { id: rendererRequestId, result: persisted.result },
                    ...(prepared.request.trace === undefined
                      ? {}
                      : {
                          receivedAtMs,
                          requestMethod: prepared.request.method,
                          trace: prepared.request.trace,
                        }),
                  },
                  browserSessionId,
                );
                return undefined;
              }
              responseCachePersistentKey = persistentCacheKey;
            } catch (error) {
              this.emit('capability-error', {
                requestType: 'discovery-response-cache-read',
                method: prepared.request.method,
                error: error instanceof Error ? error.message : 'discovery cache read failed',
              });
            }
          }
        }
        const requestShape = rendererRequestShape(prepared.request.method, prepared.request.params);
        const metadata: RendererRequestMetadata = {
          ...(browserSessionId === undefined ? {} : { browserSessionId }),
          method: prepared.request.method,
          rendererRequestId,
          requestFingerprint,
          ...(responseCacheKey === undefined ? {} : { responseCacheKey }),
          ...(responseCacheGeneration === undefined ? {} : { responseCacheGeneration }),
          ...(responseCacheOverrideFingerprint === undefined
            ? {}
            : { responseCacheOverrideFingerprint }),
          ...(responseCachePersistentKey === undefined ? {} : { responseCachePersistentKey }),
          ...(responseCachePrincipalKey === undefined ? {} : { responseCachePrincipalKey }),
          ...(responseCacheTtlMs === null ? {} : { responseCacheTtlMs }),
          ...(requestShape === undefined ? {} : { requestShape }),
          startedAtMs,
          ...(prepared.request.trace === undefined ? {} : { trace: prepared.request.trace }),
        };
        this.#invalidateRendererResponseCache(prepared.request.method);
        if (
          prepared.request.method.startsWith('account/login') ||
          prepared.request.method.startsWith('account/logout')
        ) {
          this.#fetchProxy.invalidateResponseCache();
        }
        if (responseCacheKey !== undefined && responseCacheReadEligible) {
          const inFlightKey = rendererResponseInFlightKey(
            responseCacheKey,
            responseCacheGeneration as number,
          );
          const inFlight = this.#rendererResponseInFlight.get(inFlightKey);
          if (inFlight !== undefined) {
            inFlight.waiters.push(metadata);
            return undefined;
          }
          this.#rendererResponseInFlight.set(inFlightKey, {
            appServerRequestId,
            waiters: [],
          });
        }
        this.#rendererRequests.set(appServerRequestId, metadata);
        if (prepared.request.method === 'turn/start') {
          this.#turnLatency.start(prepared.request.params, startedAtMs);
        }
        try {
          await this.#requireAppServer().forwardRequest({
            ...prepared.request,
            id: appServerRequestId,
          });
        } catch (error) {
          this.#rendererRequests.delete(appServerRequestId);
          this.#releaseRendererResponseInFlight(appServerRequestId, metadata, error);
          if (prepared.request.method === 'turn/start') {
            this.#turnLatency.stop(prepared.request.params);
          }
          throw error;
        }
        if (prepared.request.method === 'turn/start') {
          const durationMs = this.#prewarmedThreads.publishForTurnStart(
            prepared.request.params,
            Date.now(),
          );
          if (durationMs !== null) {
            this.emit('performance', {
              kind: 'prewarm-to-turn-start',
              durationMs,
            });
          }
        }
        return undefined;
      }
      case 'thread-prewarm-start': {
        const prepared = prepareRendererRequest(message.request);
        if (prepared.request.method !== 'thread/start') {
          throw new Error('thread prewarm must use thread/start');
        }
        const startedAtMs = Date.now();
        assertStorageAvailableForMethod(
          this.config.runtimeRoot,
          this.config.minimumFreeBytes,
          prepared.request.method,
        );
        const rendererRequestId = prepared.request.id;
        const appServerRequestId =
          browserSessionId === undefined ? rendererRequestId : randomUUID();
        const requestShape = rendererRequestShape(prepared.request.method, prepared.request.params);
        this.#rendererRequests.set(appServerRequestId, {
          ...(browserSessionId === undefined ? {} : { browserSessionId }),
          method: prepared.request.method,
          prewarmThread: true,
          rendererRequestId,
          requestFingerprint: rendererRequestFingerprint(prepared.request.params),
          ...(requestShape === undefined ? {} : { requestShape }),
          startedAtMs,
          ...(prepared.request.trace === undefined ? {} : { trace: prepared.request.trace }),
        });
        await this.#requireAppServer().forwardRequest({
          ...prepared.request,
          id: appServerRequestId,
        });
        return undefined;
      }
      case 'mcp-notification':
        await this.#requireAppServer().forwardNotification(
          jsonRpcNotificationSchema.parse(message.request),
        );
        return undefined;
      case 'mcp-response':
        {
          const response = jsonRpcResponseSchema.parse(message.response);
          await this.#requireAppServer().forwardResponse(response);
          this.#pendingAppServerRequests.delete(response.id);
          this.#backgroundWork.observeClientResponse(response);
        }
        return undefined;
      case 'mcp-request-abandon':
        await this.#requireAppServer().notify('$/cancelRequest', {
          id: this.#appServerRequestIdForRenderer(message.requestId, browserSessionId),
        });
        return undefined;
      case 'shared-object-set': {
        if (typeof message.key !== 'string') throw new Error('invalid shared-object key');
        await this.#state.set('sharedObjects', message.key, message.value);
        this.emit('view-message', {
          type: 'shared-object-updated',
          key: message.key,
          value: message.value,
        });
        return undefined;
      }
      case 'shared-object-subscribe': {
        if (typeof message.key !== 'string') throw new Error('invalid shared-object key');
        this.#emitRendererMessage(
          {
            type: 'shared-object-updated',
            key: message.key,
            value: this.#state.get('sharedObjects', message.key),
          },
          browserSessionId,
        );
        return undefined;
      }
      case 'shared-object-unsubscribe':
      case 'log-message':
        return undefined;
      case '__browser-surface-focus-changed':
        if (typeof message.browserSessionId !== 'string' || typeof message.focused !== 'boolean') {
          throw new Error('browser surface focus state is invalid');
        }
        this.requestUserInputAutoResolution.setSurfaceForegrounded(
          message.browserSessionId,
          message.focused,
        );
        return undefined;
      case 'ready':
        for (const pendingRequest of this.#pendingAppServerRequests.values()) {
          this.#emitRendererMessage(toOfficialRendererRequest(pendingRequest), browserSessionId);
        }
        this.#emitRendererMessage(
          {
            type: 'request-user-input-auto-resolution-snapshot',
            hostId: 'local',
            pendingRequests: this.requestUserInputAutoResolution.getPendingRequestSnapshots(),
          },
          browserSessionId,
        );
        return undefined;
      case 'fetch':
        await this.#handleFetch(message, browserSessionId);
        return undefined;
      case 'cancel-fetch':
      case 'cancel-fetch-stream':
        this.#cancelFetch(message, browserSessionId);
        return undefined;
      case 'fetch-stream':
        this.#handleFetchStream(message, browserSessionId);
        return undefined;
      case 'persisted-atom-sync-request':
        this.#emitRendererMessage(
          {
            type: 'persisted-atom-sync',
            state: this.#state.snapshot('persistedAtoms'),
          },
          browserSessionId,
        );
        return undefined;
      case 'persisted-atom-update': {
        if (typeof message.key !== 'string') throw new Error('invalid persisted atom key');
        await this.#state.set(
          'persistedAtoms',
          message.key,
          message.deleted === true ? undefined : message.value,
        );
        this.emit('view-message', {
          type: 'persisted-atom-updated',
          key: message.key,
          value: message.value ?? null,
          deleted: message.deleted === true || message.value === undefined,
        });
        return undefined;
      }
      case 'persisted-atom-reset':
        await this.#state.clear('persistedAtoms');
        this.emit('view-message', { type: 'persisted-atom-sync', state: {} });
        return undefined;
      case 'electron-desktop-features-changed':
        await this.#state.set('sharedObjects', 'desktop_features', message);
        return undefined;
      case 'codex-runtimes-config-changed':
        await this.#state.set('sharedObjects', 'codex_runtimes_config', message.config);
        return undefined;
      case 'electron-window-focus-request':
        this.#emitRendererMessage(
          {
            type: 'electron-window-focus-changed',
            isFocused: true,
          },
          browserSessionId,
        );
        return undefined;
      case 'avatar-overlay-open-state-request':
        this.#emitRendererMessage(
          {
            type: 'avatar-overlay-open-state-changed',
            isOpen: false,
          },
          browserSessionId,
        );
        return undefined;
      case 'electron-window-zoom-changed':
      case 'electron-app-state-snapshot-trigger':
      case 'electron-set-window-mode':
      case 'electron-set-badge-count':
      case 'electron-avatar-overlay-restore-ready':
      case 'electron-avatar-overlay-feedback-diagnostics-changed':
      case 'electron-sparkle-gates-changed':
      case 'mac-menu-bar-enabled-changed':
      case 'global-dictation-enabled-changed':
      case 'local-thread-activity-changed':
      case 'set-telemetry-user':
      case 'power-save-blocker-set':
      case 'checkout-webview-presentation-changed':
      case 'workspace-settings-webview-presentation-changed':
      case 'keyboard-layout-map-changed':
      case 'app-shell-shortcut-state-changed':
      case 'view-focused':
        // These update native windows, docks, trays, power management, or
        // Electron-owned webview partitions. The browser already owns those
        // surfaces, so accepting the notification is the exact Linux/web
        // fallback and must not become a renderer error.
        return undefined;
      case 'browser-use-session-route-capture':
        if (
          typeof message.browserConversationId !== 'string' ||
          typeof message.conversationId !== 'string'
        ) {
          throw new Error('browser use session route is invalid');
        }
        // The web browser runtime already routes every surface by conversation
        // id and persists each registered page. The Electron message only
        // informs its native webContents lifecycle manager, so acknowledging it
        // is the exact browser-host equivalent.
        return undefined;
      case 'electron-pick-workspace-root-option':
        this.#emitRendererMessage(
          {
            type: 'workspace-root-option-picked',
            root: this.workspaceRoot,
          },
          browserSessionId,
        );
        return undefined;
      case 'remote-hosted-pip-hidden-thread-ids-changed':
        await this.#state.set(
          'sharedObjects',
          'remote_hosted_pip_hidden_thread_ids',
          message.threadIds,
        );
        return undefined;
      case 'remote-hosted-pip-active-thread-changed':
        await this.#state.set('sharedObjects', 'remote_hosted_pip_active_thread', message.threadId);
        return undefined;
      case 'remote-hosted-pip-host-layout-changed':
        await this.#state.set('sharedObjects', 'remote_hosted_pip_host_layout', message.layout);
        return undefined;
      case 'tray-menu-threads-changed':
        // Browser sessions have no operating-system tray. Retain the official
        // renderer snapshot so reconnects do not turn this native-only update
        // into a capability failure.
        await this.#state.set('sharedObjects', 'tray_menu_threads', message.trayMenuThreads);
        return undefined;
      case 'inbox-item-set-read-state':
        await this.officialDesktopState.request('inbox.set-read', {
          id: message.id,
          isRead: message.isRead,
        });
        this.emit('view-message', { type: 'inbox-items-changed' });
        return undefined;
      case 'inbox-automation-runs-mark-all-read':
        await this.officialDesktopState.request('inbox.mark-all-read', {
          readAt: message.readAt,
        });
        this.emit('view-message', { type: 'inbox-items-changed' });
        return undefined;
      case 'inbox-items-create': {
        const items = parseInboxCreateItems(message.items);
        const seed =
          optionalDesktopId(message.conversationId) ??
          optionalDesktopId(message.turnId) ??
          randomUUID();
        const createdAt = Date.now();
        const persisted = (await this.officialDesktopState.request('inbox.persist', {
          items: items.map((item, index) => ({
            id:
              items.length > 1 && item.id === null
                ? `${seed}-${String(index + 1)}`
                : (item.id ?? seed),
            automationId: null,
            automationName: null,
            title: item.title,
            description: item.description,
            archivedAssistantMessage: null,
            archivedUserMessage: null,
            archivedReason: null,
            sourceCwd: null,
            threadId: optionalDesktopId(message.conversationId),
            readAt: null,
            createdAt,
            status: null,
          })),
        })) as { items?: unknown[] };
        if ((persisted.items?.length ?? 0) > 0) {
          this.emit('view-message', { type: 'inbox-items-changed' });
        }
        return undefined;
      }
      case 'heartbeat-automations-enabled-changed':
        if (typeof message.enabled !== 'boolean') {
          throw new Error('heartbeat automation state is invalid');
        }
        this.automationController.setHeartbeatEnabled(message.enabled);
        return undefined;
      case 'heartbeat-automation-thread-state-changed':
        this.automationController.setHeartbeatRendererState(message);
        return undefined;
      default:
        this.emit('capability-error', {
          requestType: 'renderer-message',
          type: message.type,
          error: `${message.type} is not implemented`,
        });
        throw new CapabilityUnavailableError(message.type);
    }
  }

  async handleWorkerMessage(worker: string, message: unknown): Promise<void> {
    if (worker !== 'git') {
      throw new CapabilityUnavailableError(`official worker channel: ${worker}`);
    }
    if (message !== null && typeof message === 'object' && !Array.isArray(message)) {
      const envelope = message as Record<string, unknown>;
      if (
        envelope.type === 'worker-request' &&
        envelope.request !== null &&
        typeof envelope.request === 'object' &&
        !Array.isArray(envelope.request)
      ) {
        const request = envelope.request as Record<string, unknown>;
        if (typeof request.id === 'string' && typeof request.method === 'string') {
          this.#pendingGitRequests.set(request.id, request.method);
        }
      } else if (envelope.type === 'worker-request-cancel' && typeof envelope.id === 'string') {
        this.#pendingGitRequests.delete(envelope.id);
      }
    }
    const gitWorker = this.#requireGitWorker();
    try {
      await gitWorker.post(message);
    } catch (error) {
      this.#failPendingGitRequests(error);
      throw error;
    }
  }

  async #start(): Promise<void> {
    await this.prepareBootstrap();
    await this.browserRuntime.start();
    await this.officialDesktopState.start();
    const { stdout, stderr } = await execFileAsync(this.config.codexBin, ['--version'], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    const actualVersion = codexVersionFromOutput(stdout, stderr);
    if (actualVersion !== this.config.expectedCodexVersion) {
      throw new Error(
        `Codex version mismatch: expected ${this.config.expectedCodexVersion}, got ${
          actualVersion ?? 'unrecognized output'
        }`,
      );
    }
    const client = new CodexAppServerClient({
      codexBin: this.config.codexBin,
      codexHome: this.codexHome,
      cwd: this.workspaceRoot,
      clientVersion: this.config.expectedRendererVersion,
      extraArgs: ['-c', 'features.code_mode_host=true'],
      requestTimeoutMs: 120_000,
    });
    client.on('response', (response: unknown) => {
      const parsed = jsonRpcResponseSchema.parse(response);
      const metadata = this.#rendererRequests.get(parsed.id);
      this.#rendererRequests.delete(parsed.id);
      const receivedAtMs = Date.now();
      const waiters = this.#takeRendererResponseWaiters(parsed.id, metadata);
      if (metadata !== undefined) {
        this.emit('performance', {
          kind: 'app-server',
          method: metadata.method,
          durationMs: receivedAtMs - metadata.startedAtMs,
          error: parsed.error !== undefined,
          requestFingerprint: metadata.requestFingerprint,
          requestShape: metadata.requestShape,
        });
      }
      if (metadata?.prewarmThread === true) {
        this.#prewarmedThreads.trackResponse(parsed, metadata.startedAtMs);
      }
      if (metadata?.method === 'thread/resume' && parsed.error === undefined) {
        const responseRecord = recordOrNull(parsed.result);
        const threadRecord = recordOrNull(responseRecord?.thread);
        const statusRecord = recordOrNull(threadRecord?.status);
        this.emit('performance', {
          kind: 'official-cache-decision',
          method: metadata.method,
          durationMs: receivedAtMs - metadata.startedAtMs,
          requestFingerprint: metadata.requestFingerprint,
          cacheable: rendererResponseCanBeCached(metadata.method, parsed.result),
          resultBytes: Buffer.byteLength(JSON.stringify(parsed.result)),
          statusType: typeof statusRecord?.type === 'string' ? statusRecord.type : null,
        });
      }
      if (
        metadata?.responseCacheKey !== undefined &&
        metadata.responseCacheTtlMs !== undefined &&
        rendererResponseCacheGenerationCanStore(
          metadata.responseCacheGeneration,
          this.#rendererResponseCacheGenerationForKey(metadata.responseCacheKey),
        ) &&
        parsed.error === undefined &&
        rendererResponseCanBeCached(metadata.method, parsed.result)
      ) {
        this.#rendererResponseCache.set(metadata.responseCacheKey, {
          expiresAtMs: receivedAtMs + metadata.responseCacheTtlMs,
          ...(metadata.responseCacheOverrideFingerprint === undefined
            ? {}
            : { resumeOverrideFingerprint: metadata.responseCacheOverrideFingerprint }),
          result: parsed.result,
        });
        if (
          metadata.responseCachePrincipalKey !== undefined &&
          metadata.responseCachePersistentKey !== undefined
        ) {
          try {
            this.#discoveryResponseCacheStore.write(
              metadata.responseCachePrincipalKey,
              metadata.responseCachePersistentKey,
              metadata.method,
              metadata.responseCacheTtlMs,
              parsed.result,
            );
          } catch (error) {
            this.emit('capability-error', {
              requestType: 'discovery-response-cache-write',
              method: metadata.method,
              error: error instanceof Error ? error.message : 'discovery cache write failed',
            });
          }
        }
        this.#pruneRendererResponseCache(receivedAtMs);
      }
      if (metadata !== undefined && parsed.error === undefined) {
        this.#invalidateRendererResponseCache(metadata.method);
      }
      if (metadata?.method === 'getAuthStatus' && parsed.error === undefined) {
        const result =
          parsed.result !== null &&
          typeof parsed.result === 'object' &&
          !Array.isArray(parsed.result)
            ? (parsed.result as Record<string, unknown>)
            : {};
        void this.#state
          .set('globalState', INITIAL_ROUTE_STATE_KEY, initialRouteForAuthMethod(result.authMethod))
          .catch((error: unknown) => {
            this.emit('capability-error', {
              requestType: 'initial-route-cache',
              error: error instanceof Error ? error.message : 'initial route cache failed',
            });
          });
      }
      if (
        parsed.error !== undefined &&
        !isExpectedAppServerResponseError(metadata?.method, parsed.error.code, parsed.error.message)
      ) {
        this.emit('capability-error', {
          requestType: 'app-server-response',
          method: metadata?.method ?? 'unknown',
          code: parsed.error.code,
          error: parsed.error.message,
        });
      }
      const rendererResponse =
        metadata === undefined ? parsed : { ...parsed, id: metadata.rendererRequestId };
      this.#emitRendererMessage(
        {
          type: 'mcp-response',
          hostId: 'local',
          message: rendererResponse,
          ...(metadata?.trace === undefined
            ? {}
            : {
                receivedAtMs,
                requestMethod: metadata.method,
                trace: metadata.trace,
              }),
        },
        metadata?.browserSessionId,
      );
      for (const waiter of waiters) {
        this.emit('performance', {
          kind: 'official-cache-coalesced',
          method: waiter.method,
          durationMs: receivedAtMs - waiter.startedAtMs,
          requestFingerprint: waiter.requestFingerprint,
          requestShape: waiter.requestShape,
        });
        this.#emitRendererMessage(
          {
            type: 'mcp-response',
            hostId: 'local',
            message: { ...parsed, id: waiter.rendererRequestId },
            ...(waiter.trace === undefined
              ? {}
              : {
                  receivedAtMs,
                  requestMethod: waiter.method,
                  trace: waiter.trace,
                }),
          },
          waiter.browserSessionId,
        );
      }
    });
    client.on('notification', (notification: unknown) => {
      const parsedNotification = jsonRpcNotificationSchema.parse(notification);
      this.#deliverAppServerNotification(parsedNotification);
    });
    client.on('request', (event: ServerRequestEvent) => {
      this.#pendingAppServerRequests.set(event.request.id, event.request);
      this.#backgroundWork.observeServerRequest(event.request);
      this.requestUserInputAutoResolution.observeServerRequest(event.request);
      this.emit('view-message', toOfficialRendererRequest(event.request));
    });
    client.on('stderr', (line: string) => this.emit('app-server-stderr', line));
    client.on('protocol-error', (error: Error) => this.emit('error', error));
    client.on('process-cleanup-error', (error: unknown) => {
      this.emit('capability-error', {
        requestType: 'app-server-process-cleanup',
        error: error instanceof Error ? error.message : 'app-server process cleanup failed',
      });
    });
    client.on('exit', (details: unknown) => {
      this.emit('app-server-exit', details);
      if (this.#appServer !== client || this.#stopping) return;
      const error = new Error('official app-server exited unexpectedly');
      this.#failRendererRequests(error);
      this.#backgroundWork.clear();
      this.#pendingAppServerRequests.clear();
      this.#scheduleAppServerRestart();
    });
    this.#appServer = client;
    await client.start();
    await this.#refreshModelProviderCapabilities(client);
    this.#appServerRestartAttempt = 0;
    await this.threadCatalog.start(client);
    await this.automationController.start();
  }

  async #prepareBootstrap(): Promise<void> {
    mkdirSync(this.codexHome, { recursive: true, mode: 0o700 });
    mkdirSync(this.workspaceRoot, { recursive: true, mode: 0o700 });
    mkdirSync(this.uploadRoot, { recursive: true, mode: 0o700 });
    await this.#state.load();
    await this.#pruneRemovedLocalProjectMetadata(this.#state.get('globalState', 'local-projects'));
    this.threadCatalog.load();
    this.#bootstrapPrepared = true;
  }

  async #restartAppServer(client: CodexAppServerClient): Promise<void> {
    await client.start();
    await this.#refreshModelProviderCapabilities(client);
    this.#appServerRestartAttempt = 0;
    await this.threadCatalog.requestStartupSync().catch((error: unknown) => {
      this.emit('capability-error', {
        requestType: 'thread-catalog-recovery',
        error: error instanceof Error ? error.message : 'thread catalog recovery failed',
      });
    });
  }

  async #refreshModelProviderCapabilities(client: CodexAppServerClient): Promise<void> {
    try {
      this.#modelProviderCapabilities = await client.request(
        'modelProvider/capabilities/read',
        {},
        15_000,
      );
    } catch (error) {
      this.#modelProviderCapabilities = undefined;
      this.emit('capability-error', {
        requestType: 'model-provider-capabilities-cache',
        error: error instanceof Error ? error.message : 'capabilities request failed',
      });
    }
  }

  #scheduleAppServerRestart(): void {
    if (
      this.#stopping ||
      this.#appServer?.ready === true ||
      this.#appServerRestartTimer !== undefined
    ) {
      return;
    }
    const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(this.#appServerRestartAttempt, 5));
    this.#appServerRestartAttempt += 1;
    this.#appServerRestartTimer = setTimeout(() => {
      this.#appServerRestartTimer = undefined;
      void this.start().catch((error: unknown) => {
        this.emit('capability-error', {
          requestType: 'app-server-restart',
          error: error instanceof Error ? error.message : 'app-server restart failed',
          retryDelayMs: delayMs,
        });
      });
    }, delayMs);
    this.#appServerRestartTimer.unref();
  }

  #clearAppServerRestartTimer(): void {
    if (this.#appServerRestartTimer !== undefined) clearTimeout(this.#appServerRestartTimer);
    this.#appServerRestartTimer = undefined;
  }

  #failRendererRequests(error: Error): void {
    const metadataValues = [...this.#rendererRequests.entries()].flatMap(
      ([appServerRequestId, metadata]) => [
        metadata,
        ...this.#takeRendererResponseWaiters(appServerRequestId, metadata),
      ],
    );
    for (const metadata of metadataValues) {
      this.#emitRendererMessage(
        {
          type: 'mcp-response',
          hostId: 'local',
          message: {
            id: metadata.rendererRequestId,
            error: {
              code: -32_098,
              message: error.message,
            },
          },
        },
        metadata.browserSessionId,
      );
    }
    this.#rendererRequests.clear();
    this.#rendererResponseInFlight.clear();
    this.#invalidateRendererResponseCachePrefixes(THREAD_CONTENT_CACHE_PREFIXES);
    this.#prewarmedThreads.clear();
    this.#turnLatency.clear();
  }

  #deliverAppServerNotification(
    parsedNotification: { method: string; params?: unknown },
    suppressPrewarmedThread = true,
  ): void {
    this.#invalidateRendererResponseCacheForNotification(parsedNotification.method);
    this.#turnLatency.observeNotification(parsedNotification);
    this.#backgroundWork.observeNotification(parsedNotification);
    this.#observePendingRequestNotification(parsedNotification);
    if (parsedNotification.method === 'thread/deleted') {
      const params =
        parsedNotification.params !== null &&
        typeof parsedNotification.params === 'object' &&
        !Array.isArray(parsedNotification.params)
          ? (parsedNotification.params as Record<string, unknown>)
          : {};
      if (typeof params.threadId === 'string') {
        this.#prewarmedThreads.stopTracking(params.threadId);
      }
    }
    if (
      suppressPrewarmedThread &&
      this.#prewarmedThreads.suppressThreadStarted(parsedNotification)
    ) {
      return;
    }
    this.requestUserInputAutoResolution.observeServerNotification(parsedNotification);
    this.threadCatalog.handleNotification(parsedNotification);
    this.emit('app-server-notification', parsedNotification);
    void this.automationController
      .handleNotification(parsedNotification)
      .catch((error: unknown) => {
        this.emit('capability-error', {
          requestType: 'official-automation-notification',
          error: error instanceof Error ? error.message : 'automation notification failed',
        });
      });
    const message = toOfficialRendererNotification(parsedNotification);
    this.emit('view-message', message);
  }

  #emitRendererMessage(message: unknown, browserSessionId?: string): void {
    if (browserSessionId === undefined) {
      this.emit('view-message', message);
      return;
    }
    this.emit('view-message-for-session', { browserSessionId, message });
  }

  #pruneRendererResponseCache(nowMs: number): void {
    for (const [key, cached] of this.#rendererResponseCache) {
      if (cached.expiresAtMs <= nowMs) this.#rendererResponseCache.delete(key);
    }
    while (this.#rendererResponseCache.size > 1_000) {
      const first = this.#rendererResponseCache.keys().next().value;
      if (first === undefined) break;
      this.#rendererResponseCache.delete(first);
    }
    const threadResumeKeys = [...this.#rendererResponseCache.keys()].filter((key) =>
      key.startsWith(THREAD_RESUME_CACHE_PREFIX),
    );
    for (const key of threadResumeKeys.slice(0, -MAX_THREAD_RESUME_CACHE_ENTRIES)) {
      this.#rendererResponseCache.delete(key);
    }
    const threadHistoryKeys = [...this.#rendererResponseCache.keys()].filter(
      (key) =>
        key.startsWith(THREAD_TURNS_CACHE_PREFIX) || key.startsWith(THREAD_ITEMS_CACHE_PREFIX),
    );
    let threadHistoryBytes = threadHistoryKeys.reduce((total, key) => {
      const cached = this.#rendererResponseCache.get(key);
      if (cached === undefined) return total;
      const serialized = JSON.stringify(cached.result);
      return total + (serialized === undefined ? 0 : Buffer.byteLength(serialized));
    }, 0);
    for (const [index, key] of threadHistoryKeys.entries()) {
      const overEntryLimit = threadHistoryKeys.length - index > MAX_THREAD_HISTORY_CACHE_ENTRIES;
      if (!overEntryLimit && threadHistoryBytes <= MAX_THREAD_HISTORY_CACHE_BYTES) break;
      const cached = this.#rendererResponseCache.get(key);
      const serialized = cached === undefined ? undefined : JSON.stringify(cached.result);
      threadHistoryBytes -= serialized === undefined ? 0 : Buffer.byteLength(serialized);
      this.#rendererResponseCache.delete(key);
    }
  }

  #invalidateRendererResponseCache(method: string): void {
    const prefixes = rendererResponseCacheInvalidationPrefixes(method);
    this.#invalidateRendererResponseCachePrefixes(prefixes);
    if (prefixes.length === 0) return;
    try {
      this.#discoveryResponseCacheStore.invalidate(prefixes);
    } catch (error) {
      this.emit('capability-error', {
        requestType: 'discovery-response-cache-invalidate',
        method,
        error: error instanceof Error ? error.message : 'discovery cache invalidation failed',
      });
    }
  }

  #invalidateRendererResponseCacheForNotification(method: string): void {
    const prefixes = rendererNotificationCacheInvalidationPrefixes(method);
    this.#invalidateRendererResponseCachePrefixes(prefixes);
    if (prefixes.length === 0) return;
    try {
      this.#discoveryResponseCacheStore.invalidate(prefixes);
    } catch (error) {
      this.emit('capability-error', {
        requestType: 'discovery-response-cache-invalidate',
        method,
        error: error instanceof Error ? error.message : 'discovery cache invalidation failed',
      });
    }
  }

  #deleteRendererResponseCachePrefixes(prefixes: readonly string[]): void {
    for (const prefix of prefixes) {
      for (const key of this.#rendererResponseCache.keys()) {
        if (key.startsWith(prefix)) this.#rendererResponseCache.delete(key);
      }
    }
  }

  #invalidateRendererResponseCachePrefixes(prefixes: readonly string[]): void {
    if (prefixes.length === 0) return;
    this.#rendererResponseCacheGeneration += 1;
    for (const prefix of prefixes) {
      this.#rendererResponseCachePrefixGenerations.set(
        prefix,
        this.#rendererResponseCacheGeneration,
      );
    }
    this.#deleteRendererResponseCachePrefixes(prefixes);
  }

  #rendererResponseCacheGenerationForKey(cacheKey: string): number {
    return rendererResponseCacheGenerationForKey(
      cacheKey,
      this.#rendererResponseCachePrefixGenerations,
    );
  }

  async #readDiscoveryResponseCachePrincipalKey(): Promise<string | undefined> {
    try {
      const persistedAuth = JSON.parse(
        await readFile(join(this.codexHome, 'auth.json'), 'utf8'),
      ) as unknown;
      const principal = historySnapshotPrincipalFromCodexAuth(persistedAuth);
      if (principal === null) return undefined;
      return createHash('sha256')
        .update(`${principal.userId}\0${principal.accountId}`)
        .digest('hex');
    } catch {
      return undefined;
    }
  }

  #takeRendererResponseWaiters(
    appServerRequestId: JsonRpcId,
    metadata: RendererRequestMetadata | undefined,
  ): RendererRequestMetadata[] {
    if (metadata === undefined) return [];
    const key = metadata.responseCacheKey;
    if (key === undefined) return [];
    const generation = metadata.responseCacheGeneration;
    if (generation === undefined) return [];
    const inFlightKey = rendererResponseInFlightKey(key, generation);
    const inFlight = this.#rendererResponseInFlight.get(inFlightKey);
    if (inFlight?.appServerRequestId !== appServerRequestId) return [];
    this.#rendererResponseInFlight.delete(inFlightKey);
    return inFlight.waiters;
  }

  #releaseRendererResponseInFlight(
    appServerRequestId: JsonRpcId,
    metadata: RendererRequestMetadata,
    error: unknown,
  ): void {
    const waiters = this.#takeRendererResponseWaiters(appServerRequestId, metadata);
    const message = error instanceof Error ? error.message : 'app-server request failed';
    for (const waiter of waiters) {
      this.#emitRendererMessage(
        {
          type: 'mcp-response',
          hostId: 'local',
          message: {
            id: waiter.rendererRequestId,
            error: { code: -32_098, message },
          },
        },
        waiter.browserSessionId,
      );
    }
  }

  #appServerRequestIdForRenderer(rendererRequestId: unknown, browserSessionId?: string): unknown {
    for (const [appServerRequestId, metadata] of this.#rendererRequests) {
      if (
        metadata.rendererRequestId === rendererRequestId &&
        metadata.browserSessionId === browserSessionId
      ) {
        return appServerRequestId;
      }
    }
    return rendererRequestId;
  }

  #observePendingRequestNotification(notification: { method: string; params?: unknown }): void {
    const params =
      notification.params !== null &&
      typeof notification.params === 'object' &&
      !Array.isArray(notification.params)
        ? (notification.params as Record<string, unknown>)
        : {};
    if (notification.method === 'serverRequest/resolved') {
      const requestId = params.requestId;
      if (
        typeof requestId === 'string' ||
        (typeof requestId === 'number' && Number.isInteger(requestId))
      ) {
        this.#pendingAppServerRequests.delete(requestId);
      }
      return;
    }
    if (notification.method !== 'turn/completed' && notification.method !== 'thread/deleted') {
      return;
    }
    const turn =
      params.turn !== null && typeof params.turn === 'object' && !Array.isArray(params.turn)
        ? (params.turn as Record<string, unknown>)
        : {};
    const threadId = typeof params.threadId === 'string' ? params.threadId : null;
    const turnId = typeof turn.id === 'string' ? turn.id : null;
    for (const [requestId, request] of this.#pendingAppServerRequests) {
      const requestParams =
        request.params !== null &&
        typeof request.params === 'object' &&
        !Array.isArray(request.params)
          ? (request.params as Record<string, unknown>)
          : {};
      if (
        (threadId !== null && requestParams.threadId === threadId) ||
        (turnId !== null && requestParams.turnId === turnId)
      ) {
        this.#pendingAppServerRequests.delete(requestId);
      }
    }
  }

  #requireGitWorker(): OfficialGitWorker {
    if (this.#gitWorker !== undefined) return this.#gitWorker;
    const worker = new OfficialGitWorker({
      sourceRoot: this.config.officialSourceRoot,
      userRoot: this.root,
      codexHome: this.codexHome,
      workspaceRoot: this.workspaceRoot,
      appVersion: this.config.expectedRendererVersion,
      buildNumber: this.config.expectedBuildNumber,
      buildFlavor: this.config.expectedBuildFlavor,
    });
    worker.on('message', (message: unknown) => {
      if (message !== null && typeof message === 'object' && !Array.isArray(message)) {
        const envelope = message as Record<string, unknown>;
        if (
          envelope.type === 'worker-response' &&
          envelope.response !== null &&
          typeof envelope.response === 'object' &&
          !Array.isArray(envelope.response)
        ) {
          const id = (envelope.response as Record<string, unknown>).id;
          if (typeof id === 'string') this.#pendingGitRequests.delete(id);
        }
      }
      this.emit('worker-message', { worker: 'git', message });
    });
    worker.on('error', (error: Error) => {
      this.emit('capability-error', {
        requestType: 'worker',
        worker: 'git',
        error: error.message,
      });
      this.#failPendingGitRequests(error);
    });
    this.#gitWorker = worker;
    return worker;
  }

  #failPendingGitRequests(error: unknown): void {
    const message = error instanceof Error ? error.message : 'official Git worker failed';
    for (const [id, method] of this.#pendingGitRequests) {
      this.emit('worker-message', {
        worker: 'git',
        message: {
          type: 'worker-response',
          workerId: 'git',
          response: {
            emittedAtMs: Date.now(),
            id,
            method,
            result: { type: 'error', error: { message } },
          },
        },
      });
    }
    this.#pendingGitRequests.clear();
  }

  #handleBridgeRequest(message: RendererMessage): unknown {
    if (typeof message.method !== 'string') throw new Error('bridge request method is missing');
    switch (message.method) {
      case 'trigger-sentry-test':
        throw new Error('requested browser host Sentry test error');
      case 'connect-app-host':
      case 'show-context-menu':
      case 'fast-mode-rollout-metrics':
        throw new CapabilityUnavailableError(message.method);
      default:
        this.emit('capability-error', {
          requestType: 'bridge-request',
          method: message.method,
          error: `${message.method} is not implemented`,
        });
        throw new CapabilityUnavailableError(message.method);
    }
  }

  #requireAppServer(): CodexAppServerClient {
    if (this.#appServer === undefined) throw new Error('app-server is not started');
    return this.#appServer;
  }

  async #handleFetch(message: RendererMessage, browserSessionId?: string): Promise<void> {
    const requestId = message.requestId;
    const url = message.url;
    if (typeof requestId !== 'string' || typeof url !== 'string') {
      throw new Error('invalid renderer fetch request');
    }
    if (!url.startsWith('vscode://codex/')) {
      const controllerKey = this.#fetchControllerKey(requestId, browserSessionId);
      const controller = this.#createFetchController(controllerKey);
      const startedAtMs = Date.now();
      try {
        const response = await this.#fetchProxy.perform(message, controller.signal);
        this.emit('performance', {
          kind: 'renderer-fetch',
          method:
            typeof message.method === 'string' ? message.method.toUpperCase().slice(0, 16) : 'GET',
          ...rendererFetchTargetForDiagnostic(url),
          status: response.status,
          responseType: response.responseType,
          durationMs: Date.now() - startedAtMs,
        });
        this.#emitRendererMessage(response, browserSessionId);
      } finally {
        if (this.#fetchControllers.get(controllerKey) === controller) {
          this.#fetchControllers.delete(controllerKey);
        }
      }
      return;
    }
    const method = url.slice('vscode://codex/'.length);
    let params: Record<string, unknown> = {};
    if (typeof message.body === 'string' && message.body.length > 0) {
      const parsed = JSON.parse(message.body) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        params = parsed as Record<string, unknown>;
      }
    }
    try {
      const result = await this.#handleDesktopRequest(method, params);
      this.#emitRendererMessage(
        {
          type: 'fetch-response',
          responseType: 'success',
          requestId,
          status: 200,
          headers: { 'content-type': 'application/json' },
          bodyJsonString: JSON.stringify(result ?? null),
        },
        browserSessionId,
      );
    } catch (error) {
      this.emit('capability-error', {
        requestType: 'fetch',
        method,
        error: error instanceof Error ? error.message : 'desktop request failed',
      });
      this.#emitRendererMessage(
        {
          type: 'fetch-response',
          responseType: 'error',
          requestId,
          status: 432,
          error: error instanceof Error ? error.message : 'desktop request failed',
        },
        browserSessionId,
      );
    }
  }

  #handleFetchStream(message: RendererMessage, browserSessionId?: string): void {
    const requestId = message.requestId;
    if (typeof requestId !== 'string' || requestId.length === 0) {
      throw new Error('invalid renderer fetch stream request');
    }
    const controllerKey = this.#fetchControllerKey(requestId, browserSessionId);
    const controller = this.#createFetchController(controllerKey);
    void this.#fetchProxy
      .performStream(
        message,
        (response) => {
          this.#emitRendererMessage(response, browserSessionId);
        },
        controller.signal,
      )
      .finally(() => {
        if (this.#fetchControllers.get(controllerKey) === controller) {
          this.#fetchControllers.delete(controllerKey);
        }
      });
  }

  #cancelFetch(message: RendererMessage, browserSessionId?: string): void {
    const requestId = message.requestId;
    if (typeof requestId !== 'string' || requestId.length === 0) {
      throw new Error('invalid renderer fetch cancellation');
    }
    const controllerKey = this.#fetchControllerKey(requestId, browserSessionId);
    this.#fetchControllers.get(controllerKey)?.abort();
    this.#fetchControllers.delete(controllerKey);
  }

  #fetchControllerKey(requestId: string, browserSessionId?: string): string {
    return `${browserSessionId ?? 'runtime'}:${requestId}`;
  }

  #createFetchController(controllerKey: string): AbortController {
    this.#fetchControllers.get(controllerKey)?.abort();
    const controller = new AbortController();
    this.#fetchControllers.set(controllerKey, controller);
    return controller;
  }

  async #getAuthToken(refreshToken: boolean): Promise<string | null> {
    const response = (await this.#requireAppServer().request('getAuthStatus', {
      includeToken: true,
      refreshToken,
    })) as {
      authMethod?: unknown;
      authToken?: unknown;
    } | null;
    if (
      response?.authMethod !== 'chatgpt' ||
      (response.authToken !== null && typeof response.authToken !== 'string')
    ) {
      return null;
    }
    return response.authToken ?? null;
  }

  async #handleDesktopRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const staticWebResponse = officialWebStaticDesktopResponse(method);
    if (staticWebResponse !== undefined) return staticWebResponse;
    switch (method) {
      case 'get-settings':
        return {
          configuredValues: this.#state.snapshot('settings'),
          values: this.#state.snapshot('settings'),
        };
      case 'get-setting':
        return {
          value:
            typeof params.key === 'string' ? this.#state.get('settings', params.key) : undefined,
        };
      case 'set-setting':
        if (typeof params.key !== 'string') throw new Error('setting key is required');
        await this.#state.set('settings', params.key, params.value);
        return { success: true };
      case 'get-configuration':
        return {
          value:
            typeof params.key === 'string'
              ? this.#state.get('configuration', params.key)
              : undefined,
        };
      case 'set-configuration':
        if (typeof params.key !== 'string') throw new Error('configuration key is required');
        await this.#state.set('configuration', params.key, params.value);
        return { success: true };
      case 'get-global-state':
        return {
          value:
            typeof params.key === 'string' ? this.#state.get('globalState', params.key) : undefined,
        };
      case 'read-model-provider-capabilities-for-host':
        if (params.hostId !== undefined && params.hostId !== 'local') {
          throw new Error('Only the local execution host is available');
        }
        if (this.#modelProviderCapabilities === undefined) {
          await this.#refreshModelProviderCapabilities(this.#requireAppServer());
        }
        if (this.#modelProviderCapabilities === undefined) {
          throw new Error('Model provider capabilities are unavailable');
        }
        return this.#modelProviderCapabilities;
      case 'read-file':
        return readOfficialDesktopFile(this, params);
      case 'read-file-metadata':
        return readOfficialDesktopFileMetadata(
          {
            root: this.root,
            workspaceRoot: this.workspaceRoot,
            detectContentKind: (sample) =>
              this.officialDesktopState.request('file.detect-kind', { bytes: sample }),
          },
          params,
        );
      case 'read-file-binary':
        return readOfficialDesktopFileBinary(this, params);
      case 'paths-exist':
        return readOfficialExistingPaths(this, params);
      case 'workspace-directory-entries':
        return readOfficialWorkspaceDirectoryEntries(this, params);
      case 'remote-workspace-directory-entries':
        throw new Error('Remote execution hosts are not configured');
      case 'auto-deny-some-permissions':
        if (params.hostId !== undefined && params.hostId !== 'local') {
          throw new Error('Only the local execution host is available');
        }
        return this.officialDesktopState.request('permissions.auto-deny', {
          permissions: params.permissions,
          threadDetailLevel: params.threadDetailLevel,
        });
      case 'set-global-state':
        if (typeof params.key !== 'string') throw new Error('global state key is required');
        await this.#state.set('globalState', params.key, params.value);
        if (params.key === 'local-projects') {
          await this.#pruneRemovedLocalProjectMetadata(params.value);
        }
        return { success: true };
      case 'is-copilot-api-available':
        return { available: false };
      case 'get-copilot-api-proxy-info':
        return null;
      case 'list-automations':
        return this.officialDesktopState.request('automations.list');
      case 'automation-create':
        return this.officialDesktopState.request('automations.create', {
          input: params,
          compatibilityCwds: [],
        });
      case 'automation-update':
        return this.officialDesktopState.request('automations.update', {
          input: params,
          compatibilityCwds: [],
        });
      case 'automation-delete':
        return this.#deleteAutomation(params);
      case 'automation-run-now':
        return this.automationController.runNow(params);
      case 'automation-run-archive':
        return this.#archiveAutomationRun(params);
      case 'automation-run-delete':
        return this.#deleteAutomationRun(params);
      case 'delete-archived-thread':
        return deleteArchivedThread(
          this.#requireAppServer(),
          parseDesktopThreadId(params.threadId, 'archived thread id'),
        );
      case 'delete-all-archived-threads':
        return deleteAllArchivedThreads(this.#requireAppServer());
      case 'list-pinned-threads':
        return { threadIds: this.#getPinnedThreadIds() };
      case 'set-thread-pinned': {
        const threadId = parseDesktopThreadId(params.threadId);
        if (typeof params.pinned !== 'boolean') {
          throw new Error('pinned thread state must be a boolean');
        }
        const current = this.#getPinnedThreadIds();
        let next: string[];
        if (params.pinned && params.beforeThreadId !== undefined) {
          const beforeThreadId =
            params.beforeThreadId === null
              ? null
              : parseDesktopThreadId(params.beforeThreadId, 'pinned thread position');
          const withoutThread = current.filter((candidate) => candidate !== threadId);
          const beforeIndex = beforeThreadId === null ? -1 : withoutThread.indexOf(beforeThreadId);
          next =
            beforeIndex === -1
              ? [...withoutThread, threadId]
              : [
                  ...withoutThread.slice(0, beforeIndex),
                  threadId,
                  ...withoutThread.slice(beforeIndex),
                ];
        } else {
          next = params.pinned
            ? [...current.filter((candidate) => candidate !== threadId), threadId]
            : current.filter((candidate) => candidate !== threadId);
        }
        const success = !sameStringArray(current, next);
        if (success) await this.#state.set('globalState', PINNED_THREAD_IDS_KEY, next);
        this.emit('view-message', { type: 'pinned-threads-updated' });
        return { success };
      }
      case 'set-pinned-threads-order': {
        const next = parseDesktopThreadIds(params.threadIds);
        const current = this.#getPinnedThreadIds();
        const success = !sameStringArray(current, next);
        if (success) await this.#state.set('globalState', PINNED_THREAD_IDS_KEY, next);
        this.emit('view-message', { type: 'pinned-threads-updated' });
        return { success };
      }
      case 'inbox-items':
        return this.officialDesktopState.request('inbox.list', params);
      case 'codex-command-keymap-state':
        return this.officialDesktopState.request('keymap.get');
      case 'set-codex-command-keybinding':
        return this.officialDesktopState.request('keymap.set', params);
      case 'reset-codex-command-keybindings':
        return this.officialDesktopState.request('keymap.reset');
      case 'set-remote-control-connections-enabled': {
        const remoteControlConnections: unknown[] = [];
        await this.#state.set(
          'sharedObjects',
          'remote_control_connections',
          remoteControlConnections,
        );
        return { remoteControlConnections };
      }
      case 'set-remote-wsl-connections-enabled': {
        const remoteWslConnections: unknown[] = [];
        await this.#state.set('sharedObjects', 'remote_wsl_connections', remoteWslConnections);
        return { remoteWslConnections };
      }
      case 'active-workspace-roots':
        return { roots: this.activeWorkspaceRoots };
      case 'workspace-root-options':
        return this.workspaceRootOptions;
      case 'home-directory':
        return { homeDirectory: this.workspaceRoot };
      case 'projectless-workspace-root':
        return { workspaceRoot: this.workspaceRoot };
      case 'projectless-thread-cwd':
        return {
          cwd: this.workspaceRoot,
          outputDirectory: this.workspaceRoot,
          workspaceRoot: this.workspaceRoot,
        };
      case 'worktree-shell-environment-config':
        // Native Electron captures additions from the user's login shell. The
        // server process already starts Codex and terminals with the qualified
        // service environment, so there is no extra shell delta to merge.
        return { shellEnvironment: null };
      case 'codex-home':
        return {
          codexHome: this.codexHome,
          worktreesSegment: `${this.codexHome}/worktrees`,
        };
      case 'locale-info':
        return { ideLocale: 'en-US', systemLocale: 'en-US' };
      case 'os-info':
        return {
          platform: process.platform,
          osVersion: osVersion(),
          osRelease: osRelease(),
          isSystemBackdropSupported: false,
          isVsCodeRunningInsideWsl: false,
          windowsAccountType: null,
        };
      case 'wsl-bash-availability':
        return { available: false, distro: null };
      case 'external-agent-import-detect':
        return { items: [], unsupportedProjects: [] };
      case 'external-agent-import-status':
        return { importedSessionCount: 0, latestImportedAtMs: null };
      case 'external-agent-import-import':
        return { projectRoots: [] };
      case 'codex-agents-md':
        return this.#readCodexAgentsMd();
      case 'codex-agents-md-save':
        return this.#writeCodexAgentsMd(params.contents);
      case 'global-dictation-hotkey-state':
        return {
          supported: false,
          configuredHotkey: null,
          configuredToggleHotkey: null,
          keepVisible: false,
        };
      case 'global-dictation-history':
        return { items: [] };
      case 'global-dictation-set-hotkey':
      case 'global-dictation-set-toggle-hotkey':
        return {
          success: false,
          error: 'Not supported.',
          state: {
            supported: false,
            configuredHotkey: null,
            configuredToggleHotkey: null,
            keepVisible: false,
          },
        };
      case 'global-dictation-set-keep-visible':
        return {
          supported: false,
          configuredHotkey: null,
          configuredToggleHotkey: null,
          keepVisible: false,
        };
      case 'global-dictation-copy-history-item':
        return { success: false };
      case 'chronicle-permissions':
        return {
          accessibility: 'unknown',
          screenRecording: 'unknown',
          chronicleSidecarPresent: false,
          chronicleSidecarProcessState: 'disabled',
        };
      case 'browser-browsing-data-clear':
        await this.browserRuntime.clearBrowsingData(params.dataTypes);
        return null;
      case 'browser-use-origin-state-read':
        return readBrowserPermissionSnapshot(this.codexHome);
      case 'browser-use-approval-mode-write':
        return writeBrowserApprovalMode(this.codexHome, params.approvalMode);
      case 'browser-use-history-approval-mode-write':
        return writeBrowserHistoryApprovalMode(this.codexHome, params.approvalMode);
      case 'browser-use-file-transfer-approval-mode-write':
        return writeBrowserFileTransferApprovalMode(
          this.codexHome,
          params.kind,
          params.approvalMode,
        );
      case 'browser-use-full-cdp-access-enabled-write':
        return writeBrowserFullCdpAccessEnabled(this.codexHome, params.enabled);
      case 'chrome-extension-installed-read':
        return { installed: false };
      case 'chrome-extension-settings-open':
        return null;
      case 'has-custom-cli-executable':
        return { hasCustomCliExecutable: false };
      case 'ensure-directory':
        await ensureRuntimeDirectory(this, params.hostId, params.path);
        return {};
      case 'git-origins': {
        const requestedDirs =
          params.dirs === undefined || (Array.isArray(params.dirs) && params.dirs.length === 0)
            ? [this.workspaceRoot]
            : params.dirs;
        if (
          !Array.isArray(requestedDirs) ||
          requestedDirs.length > 1_000 ||
          requestedDirs.some((path) => typeof path !== 'string')
        ) {
          throw new Error('Git origin directories are invalid');
        }
        const dirs = await Promise.all(
          requestedDirs.map(async (path) =>
            resolveRuntimeDirectory(this, params.hostId ?? 'local', path),
          ),
        );
        const response = await this.#requireGitWorker().request('git-origins', {
          dirs,
          operationSource: 'apphost_git_origins',
        });
        if (
          response === null ||
          typeof response !== 'object' ||
          Array.isArray(response) ||
          !Array.isArray((response as { origins?: unknown }).origins)
        ) {
          throw new Error('Official Git origins response is invalid');
        }
        return {
          origins: (response as { origins: unknown[] }).origins,
          homeDir: this.workspaceRoot,
        };
      }
      case 'mcp-codex-config':
        // The official desktop builder returns null when no qualified
        // Browser/Computer Use node_repl runtime is available. A null
        // per-thread overlay preserves the user's normal Codex MCP
        // configuration while satisfying the renderer's required contract.
        return { config: null };
      case 'developer-instructions':
        return this.#buildDeveloperInstructions(params);
      case 'account-info': {
        const token = await this.#getAuthToken(false);
        if (token === null) {
          return {
            accountId: null,
            userId: null,
            plan: null,
            email: null,
            computeResidency: null,
            hasChatGptToken: false,
          };
        }
        const claims = decodeJwtClaims(token);
        const auth = recordValue(claims, 'https://api.openai.com/auth');
        const profile = recordValue(claims, 'https://api.openai.com/profile');
        return {
          accountId: stringValue(auth, 'chatgpt_account_id'),
          userId: stringValue(auth, 'chatgpt_user_id'),
          plan: stringValue(auth, 'chatgpt_plan_type'),
          email: stringValue(profile, 'email'),
          computeResidency: stringValue(auth, 'chatgpt_compute_residency'),
          hasChatGptToken: true,
        };
      }
      default:
        this.emit('capability-error', {
          requestType: 'desktop-fetch',
          method,
          error: `vscode://codex/${method} is not implemented`,
        });
        throw new CapabilityUnavailableError(`vscode://codex/${method}`);
    }
  }

  async #pruneRemovedLocalProjectMetadata(localProjectsValue: unknown): Promise<void> {
    const pruned = pruneRemovedLocalProjectMetadata(
      localProjectsValue,
      this.#state.get('globalState', 'thread-project-assignments'),
      this.#state.get('globalState', 'project-appearances'),
    );
    if (pruned.assignmentsChanged) {
      await this.#state.set('globalState', 'thread-project-assignments', pruned.assignments);
    }
    if (pruned.appearancesChanged) {
      await this.#state.set('globalState', 'project-appearances', pruned.appearances);
    }
  }

  async #readCodexAgentsMd(): Promise<{ path: string; contents: string }> {
    const path = join(this.codexHome, 'AGENTS.md');
    await mkdir(this.codexHome, { recursive: true, mode: 0o700 });
    try {
      return { path, contents: await readFile(path, 'utf8') };
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
      await writeFile(path, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 }).catch(
        (writeError: unknown) => {
          if (!isNodeError(writeError) || writeError.code !== 'EEXIST') throw writeError;
        },
      );
      return { path, contents: await readFile(path, 'utf8') };
    }
  }

  async #writeCodexAgentsMd(contents: unknown): Promise<{ path: string }> {
    if (typeof contents !== 'string') throw new Error('agents.md contents must be a string');
    const path = join(this.codexHome, 'AGENTS.md');
    await mkdir(this.codexHome, { recursive: true, mode: 0o700 });
    await writeFile(path, contents, { encoding: 'utf8', mode: 0o600 });
    return { path };
  }

  #getPinnedThreadIds(): string[] {
    const value = this.#state.get('globalState', PINNED_THREAD_IDS_KEY);
    return Array.isArray(value)
      ? value.filter((threadId): threadId is string => typeof threadId === 'string')
      : [];
  }

  async #buildDeveloperInstructions(
    params: Record<string, unknown>,
  ): Promise<{ instructions: string }> {
    const cwd =
      typeof params.cwd === 'string' && params.cwd.trim().length > 0
        ? params.cwd
        : this.workspaceRoot;
    const [workspaceDependenciesEnabled, isNonGitWorkspace] = await Promise.all([
      this.#isWorkspaceDependenciesFeatureEnabled(),
      this.#isNonGitWorkspace(cwd),
    ]);
    const branchPrefix = this.#state.get('settings', 'git-branch-prefix');
    const commitInstructions = this.#state.get('settings', 'git-commit-instructions');
    const pullRequestInstructions = this.#state.get('settings', 'git-pr-instructions');
    const conversationDetailMode = this.#state.get('configuration', 'conversationDetailMode');
    return {
      instructions: buildOfficialDeveloperInstructions(this.config.officialSourceRoot, {
        baseInstructions: params.baseInstructions,
        gitSettings: {
          branchPrefix: typeof branchPrefix === 'string' ? branchPrefix : 'codex/',
          commitInstructions: typeof commitInstructions === 'string' ? commitInstructions : '',
          pullRequestInstructions:
            typeof pullRequestInstructions === 'string' ? pullRequestInstructions : '',
        },
        isNonGitWorkspace,
        instructionOverrides: params.instructionOverrides,
        threadToolsEnabled: params.threadToolsEnabled === true,
        workspaceDependenciesEnabled,
        includeProseDetailLevelInstructions: conversationDetailMode === 'STEPS_PROSE',
        threadId: typeof params.threadId === 'string' ? params.threadId : null,
      }),
    };
  }

  async #isWorkspaceDependenciesFeatureEnabled(cursor: string | null = null): Promise<boolean> {
    try {
      const response = (await this.#requireAppServer().request('experimentalFeature/list', {
        cursor,
        limit: 100,
      })) as { data?: unknown; nextCursor?: unknown } | null;
      if (
        Array.isArray(response?.data) &&
        response.data.some(
          (entry) =>
            entry !== null &&
            typeof entry === 'object' &&
            !Array.isArray(entry) &&
            (entry as Record<string, unknown>).name === 'workspace_dependencies' &&
            (entry as Record<string, unknown>).enabled === true,
        )
      ) {
        return true;
      }
      return typeof response?.nextCursor === 'string'
        ? this.#isWorkspaceDependenciesFeatureEnabled(response.nextCursor)
        : false;
    } catch {
      return false;
    }
  }

  async #isNonGitWorkspace(cwd: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('git', [
        '-C',
        cwd,
        'rev-parse',
        '--is-inside-work-tree',
      ]);
      return stdout.trim() !== 'true';
    } catch {
      return true;
    }
  }

  async #deleteAutomation(params: Record<string, unknown>): Promise<unknown> {
    const result = (await this.officialDesktopState.request(
      'automations.delete',
      params,
    )) as Record<string, unknown>;
    if (result.success === true) this.emit('view-message', { type: 'automation-runs-updated' });
    return result;
  }

  async #archiveAutomationRun(params: Record<string, unknown>): Promise<unknown> {
    const result = (await this.officialDesktopState.request(
      'automation-run.archive',
      params,
    )) as Record<string, unknown>;
    if (result.success === true) this.emit('view-message', { type: 'automation-runs-updated' });
    return result;
  }

  async #deleteAutomationRun(params: Record<string, unknown>): Promise<unknown> {
    const result = (await this.officialDesktopState.request(
      'automation-run.delete',
      params,
    )) as Record<string, unknown>;
    if (result.success === true) this.emit('view-message', { type: 'automation-runs-updated' });
    return result;
  }

  #removeExpiredBrowserDownloads(): void {
    const now = Date.now();
    for (const [token, download] of this.#browserDownloads) {
      if (download.expiresAt <= now) this.#browserDownloads.delete(token);
    }
  }
}

function rendererFetchTargetForDiagnostic(url: string): {
  host: string;
  route: string;
  queryKeys: string[];
} {
  try {
    const parsed = resolveRendererFetchUrl(url, 'https://chatgpt.com/backend-api/');
    const parts = parsed.pathname.split('/').filter((part) => part.length > 0);
    const route =
      parsed.pathname === '/backend-api/gizmos/snorlax/sidebar'
        ? parsed.pathname
        : parts[0] === 'backend-api' && parts[1] !== undefined
          ? `/backend-api/${parts[1]}/[...]`
          : '/[other]';
    return {
      host: parsed.hostname,
      route,
      queryKeys: [...new Set(parsed.searchParams.keys())].sort().slice(0, 20),
    };
  } catch {
    return { host: '[invalid]', route: '[invalid]', queryKeys: [] };
  }
}

interface InboxCreateItem {
  id: string | null;
  title: string | null;
  description: string | null;
}

function parseInboxCreateItems(value: unknown): InboxCreateItem[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1_000) {
    throw new Error('inbox items are invalid');
  }
  return value.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('inbox item is invalid');
    }
    const item = entry as Record<string, unknown>;
    return {
      id: optionalDesktopId(item.id),
      title: optionalDesktopString(item.title, 'inbox item title'),
      description: optionalDesktopString(item.description, 'inbox item description'),
    };
  });
}

function optionalDesktopId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return parseDesktopThreadId(value, 'desktop identifier');
}

function optionalDesktopString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 1_000_000) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function parseDesktopThreadId(value: unknown, label = 'pinned thread id'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8_192) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function parseDesktopThreadIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 50_000) {
    throw new Error('pinned thread order is invalid');
  }
  return value.map((threadId) => parseDesktopThreadId(threadId));
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}

function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const payload = token.split('.')[1];
  if (payload === undefined) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function historySnapshotPrincipalFromAccessToken(token: string): HistorySnapshotPrincipal | null {
  const claims = decodeJwtClaims(token);
  const auth = recordValue(claims, 'https://api.openai.com/auth');
  const accountId = stringValue(auth, 'chatgpt_account_id');
  const userId = stringValue(auth, 'chatgpt_user_id');
  return accountId === null || userId === null ? null : { accountId, userId };
}

export function historySnapshotPrincipalFromCodexAuth(
  value: unknown,
): HistorySnapshotPrincipal | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const auth = value as Record<string, unknown>;
  if (auth.auth_mode !== 'chatgpt') return null;
  const tokens = recordValue(auth, 'tokens');
  const accessToken = stringValue(tokens, 'access_token');
  return accessToken === null ? null : historySnapshotPrincipalFromAccessToken(accessToken);
}

function localProjectRecords(value: unknown): Record<string, Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, Record<string, unknown>] =>
        entry[1] !== null && typeof entry[1] === 'object' && !Array.isArray(entry[1]),
    ),
  );
}

export function pruneRemovedLocalProjectMetadata(
  localProjectsValue: unknown,
  assignmentsValue: unknown,
  appearancesValue: unknown,
): {
  assignments: Record<string, unknown>;
  appearances: Record<string, unknown>;
  assignmentsChanged: boolean;
  appearancesChanged: boolean;
} {
  const activeProjectIds = new Set(Object.keys(localProjectRecords(localProjectsValue)));
  const assignments =
    assignmentsValue !== null &&
    typeof assignmentsValue === 'object' &&
    !Array.isArray(assignmentsValue)
      ? (assignmentsValue as Record<string, unknown>)
      : {};
  const appearances =
    appearancesValue !== null &&
    typeof appearancesValue === 'object' &&
    !Array.isArray(appearancesValue)
      ? (appearancesValue as Record<string, unknown>)
      : {};
  const nextAssignments = Object.fromEntries(
    Object.entries(assignments).filter(([, value]) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return true;
      const assignment = value as Record<string, unknown>;
      return (
        assignment.projectKind !== 'local' ||
        typeof assignment.projectId !== 'string' ||
        activeProjectIds.has(assignment.projectId)
      );
    }),
  );
  const nextAppearances = Object.fromEntries(
    Object.entries(appearances).filter(([projectId]) => activeProjectIds.has(projectId)),
  );
  return {
    assignments: nextAssignments,
    appearances: nextAppearances,
    assignmentsChanged: Object.keys(nextAssignments).length !== Object.keys(assignments).length,
    appearancesChanged: Object.keys(nextAppearances).length !== Object.keys(appearances).length,
  };
}

function localProjectRootPaths(project: Record<string, unknown> | undefined): string[] {
  if (!Array.isArray(project?.rootPaths)) return [];
  return project.rootPaths.filter(
    (root): root is string => typeof root === 'string' && root.length > 0,
  );
}

function workspaceRootOptionsFromGlobalState(
  localProjectsValue: unknown,
  projectOrderValue: unknown,
  fallbackRoot: string,
): { roots: string[]; labels: Record<string, string> } {
  const projects = localProjectRecords(localProjectsValue);
  const storedOrder = Array.isArray(projectOrderValue)
    ? projectOrderValue.filter((id): id is string => typeof id === 'string')
    : [];
  const orderedIds = [
    ...storedOrder,
    ...Object.keys(projects).filter((id) => !storedOrder.includes(id)),
  ];
  const roots: string[] = [];
  const labels: Record<string, string> = {};
  for (const id of orderedIds) {
    const project = projects[id];
    const projectRoots = localProjectRootPaths(project);
    for (const root of projectRoots) {
      if (!roots.includes(root)) roots.push(root);
    }
    if (
      projectRoots.length === 1 &&
      typeof project?.name === 'string' &&
      project.name.trim().length > 0
    ) {
      labels[projectRoots[0]!] = project.name;
    }
  }
  if (roots.length === 0) roots.push(fallbackRoot);
  return { roots, labels };
}

export function initialRouteForAuthMethod(authMethod: unknown): '/' | '/login' {
  return typeof authMethod === 'string' && authMethod.length > 0 ? '/' : '/login';
}

export function officialWebStaticDesktopResponse(
  method: string,
): Record<string, unknown> | null | undefined {
  switch (method) {
    case 'recommended-skills':
      return { skills: [] };
    case 'external-agent-imported-connectors':
      return { connectors: [] };
    case 'email-domain-mail-provider':
      return { provider: 'other' };
    case 'ambient-suggestions':
      return {
        file: {
          currentSuggestionIds: [],
          suggestions: [],
        },
      };
    case 'fast-mode-rollout-metrics':
      return {
        estimatedSavedMs: 0,
        rolloutCountWithCompletedTurns: 0,
      };
    case 'native-desktop-apps':
      return { apps: [] };
    case 'native-desktop-app-by-bundle-id':
      return { app: null };
    case 'native-desktop-app-icon':
    case 'computer-use-native-desktop-app-icon':
      return { iconSmall: null };
    case 'computer-use-frontmost-window':
    case 'computer-use-start-capture':
      return null;
    default:
      return undefined;
  }
}

export function isExpectedAppServerResponseError(
  method: string | undefined,
  code: number,
  message: string,
): boolean {
  return (
    method === 'fs/readFile' &&
    code === -32_603 &&
    message.includes('No such file or directory (os error 2)')
  );
}

export function codexVersionFromOutput(stdout: string, stderr: string): string | null {
  for (const line of `${stdout}\n${stderr}`.split(/\r?\n/gu)) {
    const value = line.trim();
    if (/^codex-cli [0-9A-Za-z][0-9A-Za-z.+-]*$/u.test(value)) return value;
  }
  return null;
}

function recordValue(
  value: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  const nested = value?.[key];
  return nested !== null && typeof nested === 'object' && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : null;
}

function stringValue(value: Record<string, unknown> | null, key: string): string | null {
  const nested = value?.[key];
  return typeof nested === 'string' ? nested : null;
}

interface RuntimeEntry {
  runtime: UserRuntime;
  references: number;
  backgroundWorkListener: () => void;
  stopTimer?: NodeJS.Timeout;
}

export interface RuntimeRegistryBackgroundWorkSnapshot {
  active: boolean;
  runtimeCount: number;
  activeRuntimeCount: number;
  activeTurnCount: number;
  pendingServerRequestCount: number;
  oldestStartedAtMs: number | null;
}

export interface RuntimeRegistryOptions {
  createRuntime?: (
    identity: AuthentikIdentity,
    config: GatewayConfig,
    electronNetwork: OfficialElectronNetwork | undefined,
  ) => UserRuntime;
}

export class RuntimeRegistry {
  readonly config: GatewayConfig;
  #entries = new Map<string, RuntimeEntry>();
  #electronNetwork: OfficialElectronNetwork | undefined;
  #createRuntime: NonNullable<RuntimeRegistryOptions['createRuntime']>;

  constructor(config: GatewayConfig, options: RuntimeRegistryOptions = {}) {
    this.config = config;
    this.#createRuntime =
      options.createRuntime ??
      ((identity, runtimeConfig, electronNetwork) =>
        new UserRuntime(identity, runtimeConfig, electronNetwork));
    if (config.electronNetBin !== undefined) {
      this.#electronNetwork = new OfficialElectronNetwork({
        electronBin: config.electronNetBin,
        workerPath: config.electronNetWorker as string,
        userDataDir: config.electronNetUserDataDir as string,
        expectedElectronVersion: config.expectedElectronNetVersion as string,
        expectedChromiumVersion: config.expectedElectronNetChromiumVersion as string,
      });
    }
  }

  async acquire(identity: AuthentikIdentity): Promise<UserRuntime> {
    return this.#acquire(identity, true);
  }

  async acquireBootstrap(identity: AuthentikIdentity): Promise<UserRuntime> {
    return this.#acquire(identity, false);
  }

  async #acquire(identity: AuthentikIdentity, startRuntime: boolean): Promise<UserRuntime> {
    const key = userKeyForIdentity(identity);
    let entry = this.#entries.get(key);
    if (entry === undefined) {
      const runtime = this.#createRuntime(identity, this.config, this.#electronNetwork);
      entry = {
        runtime,
        references: 0,
        backgroundWorkListener: () => this.#reconcileIdleStop(runtime),
      };
      runtime.on('background-work-changed', entry.backgroundWorkListener);
      this.#entries.set(key, entry);
    }
    if (!identitiesMatch(entry.runtime.identity, identity)) {
      throw new Error('identity hash collision');
    }
    if (entry.stopTimer !== undefined) {
      clearTimeout(entry.stopTimer);
      delete entry.stopTimer;
    }
    entry.references += 1;
    try {
      if (startRuntime) await entry.runtime.start();
      else await entry.runtime.prepareBootstrap();
      return entry.runtime;
    } catch (error) {
      entry.references = Math.max(0, entry.references - 1);
      this.#reconcileIdleStop(entry.runtime);
      throw error;
    }
  }

  release(runtime: UserRuntime): void {
    const entry = this.#entries.get(runtime.userKey);
    if (entry === undefined || entry.runtime !== runtime) return;
    entry.references = Math.max(0, entry.references - 1);
    this.#reconcileIdleStop(runtime);
  }

  get backgroundWorkSnapshot(): RuntimeRegistryBackgroundWorkSnapshot {
    let activeRuntimeCount = 0;
    let activeTurnCount = 0;
    let pendingServerRequestCount = 0;
    let oldestStartedAtMs: number | null = null;
    for (const entry of this.#entries.values()) {
      const snapshot = entry.runtime.backgroundWorkSnapshot;
      if (snapshot.active) activeRuntimeCount += 1;
      activeTurnCount += snapshot.activeTurnCount;
      pendingServerRequestCount += snapshot.pendingServerRequestCount;
      if (
        snapshot.oldestStartedAtMs !== null &&
        (oldestStartedAtMs === null || snapshot.oldestStartedAtMs < oldestStartedAtMs)
      ) {
        oldestStartedAtMs = snapshot.oldestStartedAtMs;
      }
    }
    return {
      active: activeRuntimeCount > 0,
      runtimeCount: this.#entries.size,
      activeRuntimeCount,
      activeTurnCount,
      pendingServerRequestCount,
      oldestStartedAtMs,
    };
  }

  async stopAll(): Promise<void> {
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    for (const entry of entries) {
      if (entry.stopTimer !== undefined) clearTimeout(entry.stopTimer);
      entry.runtime.off('background-work-changed', entry.backgroundWorkListener);
      await entry.runtime.stop();
    }
    await this.#electronNetwork?.stop();
  }

  #reconcileIdleStop(runtime: UserRuntime): void {
    const entry = this.#entries.get(runtime.userKey);
    if (entry === undefined || entry.runtime !== runtime) return;
    if (entry.references > 0 || runtime.hasBackgroundWork) {
      if (entry.stopTimer !== undefined) {
        clearTimeout(entry.stopTimer);
        delete entry.stopTimer;
      }
      return;
    }
    if (entry.stopTimer !== undefined) return;
    entry.stopTimer = setTimeout(() => {
      delete entry?.stopTimer;
      if (entry === undefined || entry.references > 0 || runtime.hasBackgroundWork) return;
      if (this.#entries.get(runtime.userKey) !== entry) return;
      this.#entries.delete(runtime.userKey);
      runtime.off('background-work-changed', entry.backgroundWorkListener);
      void runtime.stop();
    }, this.config.idleRuntimeSeconds * 1_000);
    entry.stopTimer.unref();
  }
}
