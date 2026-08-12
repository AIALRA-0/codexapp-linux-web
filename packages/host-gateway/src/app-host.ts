import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';

import { RpcSession, RpcTarget, type RpcTransport } from 'capnweb';
import { ArtifactDocumentsService } from './artifact-documents.js';
import {
  updateBrowserPermissionRules,
  type BrowserPermissionSnapshot,
} from './browser-use-permissions.js';
import { ChatGptProjectFilesService } from './chatgpt-project-files.js';
import type { OfficialGithubRequestHandle } from './official-git-worker.js';
import { LibraryFilesService } from './library-files.js';
import {
  RealtimeContinuityService,
  RealtimeMemoryService,
  RealtimeVoiceHistoryService,
  RealtimeVoiceMultiAgentActivityService,
  RealtimeVoicePresentationService,
  RealtimeVoiceRuntimeService,
  RealtimeVoiceStateService,
  RpcSubscription,
} from './realtime-voice.js';
import type { UserRuntime } from './runtime.js';
import type { BrowserSession } from './session.js';
import type { TerminalEvent } from './terminal.js';
import { parseReadOnlyAppToolAllowlist } from './thread-metadata-generation.js';
import { resolveRuntimePath } from './runtime-path.js';

export { ChatGptProjectFilesService } from './chatgpt-project-files.js';
export { ArtifactDocumentsService } from './artifact-documents.js';
export { LibraryFilesService } from './library-files.js';
export {
  RealtimeContinuityService,
  RealtimeMemoryService,
  RealtimeVoiceHistoryService,
  RealtimeVoiceMultiAgentActivityService,
  RealtimeVoicePresentationService,
  RealtimeVoiceRuntimeService,
  RealtimeVoiceStateService,
} from './realtime-voice.js';

interface WaitingReceiver {
  resolve: (message: string) => void;
  reject: (error: Error) => void;
}

export class BrowserPortTransport implements RpcTransport {
  readonly portId: string;
  readonly browserSession: BrowserSession;
  #messages: string[] = [];
  #waiting: WaitingReceiver | undefined;
  #aborted: Error | undefined;

  constructor(portId: string, browserSession: BrowserSession) {
    this.portId = portId;
    this.browserSession = browserSession;
  }

  send(message: string): void {
    if (this.#aborted !== undefined) throw this.#aborted;
    this.browserSession.runtime.emit('app-host-send', message);
    this.browserSession.send({
      type: 'host-port-message',
      portId: this.portId,
      message,
    });
  }

  receive(): Promise<string> {
    const queued = this.#messages.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.#aborted !== undefined) return Promise.reject(this.#aborted);
    if (this.#waiting !== undefined) {
      return Promise.reject(new Error('concurrent AppHost transport receive is not supported'));
    }
    return new Promise<string>((resolve, reject) => {
      this.#waiting = { resolve, reject };
    });
  }

  deliver(message: unknown): void {
    if (typeof message !== 'string') {
      this.abort(new TypeError('AppHost MessagePort accepts string frames only'));
      return;
    }
    const waiting = this.#waiting;
    if (waiting === undefined) this.#messages.push(message);
    else {
      this.#waiting = undefined;
      waiting.resolve(message);
    }
  }

  abort(reason: unknown): void {
    if (this.#aborted !== undefined) return;
    this.#aborted = reason instanceof Error ? reason : new Error(String(reason));
    const waiting = this.#waiting;
    this.#waiting = undefined;
    waiting?.reject(this.#aborted);
  }
}

export class AppHostConnection {
  readonly transport: BrowserPortTransport;
  readonly rpc: RpcSession;

  constructor(portId: string, browserSession: BrowserSession, runtime: UserRuntime) {
    this.transport = new BrowserPortTransport(portId, browserSession);
    this.rpc = new RpcSession(this.transport, new BrowserAppHost(runtime, browserSession.id), {
      onSendError: (error) => new Error(error.message),
    });
  }

  deliver(message: unknown): void {
    this.transport.deliver(message);
  }

  close(): void {
    this.transport.abort(new Error('browser AppHost connection closed'));
  }
}

class BrowserAppHost extends RpcTarget {
  #runtime: UserRuntime;
  #browserSessionId: string;
  #services: Record<string, unknown>;

  constructor(runtime: UserRuntime, browserSessionId: string) {
    super();
    this.#runtime = runtime;
    this.#browserSessionId = browserSessionId;
    this.#services = this.#createServices();
  }

  get services(): Record<string, unknown> {
    return this.#services;
  }

  #createServices(): Record<string, unknown> {
    return {
      ambientSuggestions: new AmbientSuggestionsService(),
      applicationMenu: new ApplicationMenuService(),
      appActions: new AppActionsService(),
      appInfo: new AppInfoService(this.#runtime),
      appServerHistorySnapshots: this.#runtime.appServerHistorySnapshots,
      appUpdates: new AppUpdatesService(),
      artifactDocuments: new ArtifactDocumentsService(this.#runtime),
      // The official Linux host does not construct the native macOS/Windows
      // browser-profile importer. Keep the service absent so the unchanged
      // renderer follows its existing unsupported-platform path.
      browserProfileImport: undefined,
      browserSidebar: new BrowserSidebarService(this.#runtime, this.#browserSessionId),
      browserTabMentions: new BrowserTabMentionsService(this.#runtime),
      browserUsePermissions: new BrowserUsePermissionsService(this.#runtime),
      chatGptProjectFiles: new ChatGptProjectFilesService(this.#runtime),
      // The browser build already has Chrome's extension APIs and therefore
      // must not offer installation of the desktop native-messaging helper.
      chromeNativeHost: undefined,
      clipboard: new ClipboardService(),
      codexMicro: new CodexMicroService(),
      computerUseSettings: new ComputerUseSettingsService(),
      conversationalOnboarding: new ConversationalOnboardingService(this.#runtime),
      customAvatars: new CustomAvatarsService(this.#runtime),
      downloads: new DownloadsService(),
      dynamicToolCalls: new DynamicToolCallsService(),
      fileAttachments: new FileAttachmentsService(this.#runtime),
      fileDrags: new FileDragsService(),
      github: new GithubService(this.#runtime),
      // Global shortcuts and the native popout window do not exist in a
      // browser. The renderer already treats an absent service as unsupported.
      hotkeyWindowHotkeys: undefined,
      keyboardModifiers: new KeyboardModifiersService(),
      libraryFiles: new LibraryFilesService(this.#runtime),
      localEnvironments: new LocalEnvironmentsService(this.#runtime),
      localProjects: new LocalProjectsService(this.#runtime),
      localThreadCatalog: new LocalThreadCatalogService(this.#runtime),
      notifications: new NotificationsService(),
      openIn: new OpenInService(),
      owlFeatures: new OwlFeaturesService(),
      performanceTelemetry: new PerformanceTelemetryService(),
      pluginScheduledTasks: new PluginScheduledTasksService(this.#runtime),
      primaryRuntime: new PrimaryRuntimeService(this.#runtime),
      pullRequestMessageGeneration: new PullRequestMessageGenerationService(this.#runtime),
      realtimeContinuity: new RealtimeContinuityService(this.#runtime),
      realtimeMemory: new RealtimeMemoryService(this.#runtime),
      realtimeVoice: new RealtimeVoiceStateService(this.#runtime),
      realtimeVoiceHistory: new RealtimeVoiceHistoryService(this.#runtime),
      realtimeVoiceMultiAgentActivity: new RealtimeVoiceMultiAgentActivityService(this.#runtime),
      realtimeVoicePresentation: new RealtimeVoicePresentationService(this.#runtime),
      realtimeVoiceRuntime: new RealtimeVoiceRuntimeService(this.#runtime, this.#browserSessionId),
      remoteControlEnvironments: new RemoteControlEnvironmentsService(),
      requestUserInputAutoResolution: new RequestUserInputAutoResolutionService(
        this.#runtime,
        this.#browserSessionId,
      ),
      terminal: new TerminalService(this.#runtime, this.#browserSessionId),
      threadArchive: new ThreadArchiveService(this.#runtime),
      threadMetadataGeneration: new ThreadMetadataGenerationService(this.#runtime),
      threadProjectAssignments: new ThreadProjectAssignmentsService(this.#runtime),
      tracing: new TracingService(),
      visualizations: new VisualizationsService(this.#runtime),
      windowNavigation: new WindowNavigationService(),
      workspaceFiles: new WorkspaceFilesService(this.#runtime, this.#browserSessionId),
    };
  }
}

interface RemoteBrowserInvalidationListener {
  (): unknown;
  dup?: () => RemoteBrowserInvalidationListener;
  onRpcBroken?: (callback: () => void) => void;
  [Symbol.dispose]?: () => void;
}

export class BrowserSidebarService extends RpcTarget {
  readonly #runtime: UserRuntime;
  readonly #browserSessionId: string;

  constructor(runtime: UserRuntime, browserSessionId: string) {
    super();
    this.#runtime = runtime;
    this.#browserSessionId = browserSessionId;
  }

  deleteConversation(request: unknown): Promise<void> {
    return this.#runtime.browserRuntime.deleteConversation(request);
  }

  getPageRestoreResults(request: unknown): Promise<unknown[]> {
    return this.#runtime.browserRuntime.getPageRestoreResults(request);
  }

  openSiteInfo(): boolean {
    return this.#runtime.browserRuntime.openSiteInfo();
  }

  registerWebviewHost(request: unknown): Promise<boolean> {
    return this.#runtime.browserRuntime.registerWebviewHost(this.#browserSessionId, request);
  }

  registerWebviewHostSession(requestValue: unknown): boolean {
    if (requestValue === null || typeof requestValue !== 'object' || Array.isArray(requestValue)) {
      throw new TypeError('browser webview host session must be an object');
    }
    return this.#runtime.browserRuntime.registerRendererSession(
      this.#browserSessionId,
      (requestValue as Record<string, unknown>).rendererInstanceId,
    );
  }
}

export class BrowserTabMentionsService extends RpcTarget {
  readonly #runtime: UserRuntime;

  constructor(runtime: UserRuntime) {
    super();
    this.#runtime = runtime;
  }

  search(requestValue: unknown): { candidates: unknown[] } {
    if (requestValue === null || typeof requestValue !== 'object' || Array.isArray(requestValue)) {
      throw new TypeError('browser tab mention search must be an object');
    }
    const request = requestValue as Record<string, unknown>;
    return this.#runtime.browserRuntime.searchTabs(request.conversationId, request.query);
  }

  subscribeInvalidations(listenerValue: unknown): RpcSubscription {
    if (typeof listenerValue !== 'function') {
      throw new TypeError('browser tab mention invalidation listener must be callable');
    }
    const listenerValueTyped = listenerValue as RemoteBrowserInvalidationListener;
    const listener = listenerValueTyped.dup?.() ?? listenerValueTyped;
    let unsubscribeRuntime = (): void => undefined;
    const subscription = new RpcSubscription(() => {
      unsubscribeRuntime();
      listener[Symbol.dispose]?.();
    });
    unsubscribeRuntime = this.#runtime.browserRuntime.subscribeInvalidations(() => {
      try {
        const result = listener();
        if (result instanceof Promise) void result.catch(() => subscription.unsubscribe());
      } catch {
        subscription.unsubscribe();
      }
    });
    listener.onRpcBroken?.(() => subscription.unsubscribe());
    return subscription;
  }
}

const CODEX_MICRO_NOT_DETECTED_STATE = Object.freeze({
  status: 'not-detected',
  transport: null,
  model: null,
  error: null,
  battery: null,
});

/**
 * Faithful Linux/browser behavior for the official native Computer Use
 * settings service. All host integrations except setSoundMode are unavailable
 * off macOS; setSoundMode still echoes the requested value in the official
 * implementation.
 */
export class ComputerUseSettingsService extends RpcTarget {
  getAppApprovals(): null {
    return null;
  }

  removeAppApproval(bundleIdentifier: unknown): null {
    void bundleIdentifier;
    return null;
  }

  getSoundMode(): null {
    return null;
  }

  setSoundMode(mode: unknown): unknown {
    return mode;
  }

  getLockedUseState(): {
    enabled: null;
    computerIconDataURL: null;
    lockIconDataURL: null;
  } {
    return {
      enabled: null,
      computerIconDataURL: null,
      lockIconDataURL: null,
    };
  }

  setLockedUseEnabled(enabled: unknown): null {
    void enabled;
    return null;
  }
}

/**
 * Codex Micro is a physical HID device. The server has no attached desktop
 * device or native Input Monitoring entitlement, so expose the same explicit
 * state the official service uses before a device is detected.
 */
export class CodexMicroService extends RpcTarget {
  getState(): typeof CODEX_MICRO_NOT_DETECTED_STATE {
    return CODEX_MICRO_NOT_DETECTED_STATE;
  }

  getInputMonitoringPermissionStatus(): 'unavailable' {
    return 'unavailable';
  }

  ownsPrimaryWindow(): true {
    return true;
  }

  openInputMonitoringSettings(): void {}

  updateAgentThreadKeys(threadKeys: unknown, actionSlots: unknown): true {
    void threadKeys;
    void actionSlots;
    return true;
  }

  updateLighting(state: unknown): false {
    void state;
    return false;
  }
}

/**
 * Electron's native file drag API cannot be represented by a remote browser.
 * Returning false is the official service's defined failure result and lets
 * the renderer keep its normal browser drag/download behavior.
 */
export class FileDragsService extends RpcTarget {
  prepareDrag(request: unknown): void {
    void request;
  }

  startDrag(request: unknown): false {
    void request;
    return false;
  }
}

/**
 * The official service only conditionally renames an already-enrolled remote
 * control environment. The browser host is itself the local execution
 * environment and has no remote-control enrollment catalog, so the official
 * no-match result is a validated no-op.
 */
export class RemoteControlEnvironmentsService extends RpcTarget {
  renameIfDefault(request: unknown): void {
    const params = recordRequest(request, 'remote control environment rename');
    nonEmptyRequestString(params.envId, 'remote control environment id');
    nonEmptyRequestString(params.name, 'remote control environment name');
  }
}

export class RequestUserInputAutoResolutionService extends RpcTarget {
  #runtime: UserRuntime;
  #surfaceId: string;

  constructor(runtime: UserRuntime, surfaceId: string) {
    super();
    this.#runtime = runtime;
    this.#surfaceId = surfaceId;
  }

  recordConversationActivity(request: unknown): void {
    const params = recordRequest(request, 'request user input conversation activity');
    requireLocalHost(params.hostId);
    this.#runtime.requestUserInputAutoResolution.recordConversationActivity(
      this.#surfaceId,
      nonEmptyRequestString(params.conversationId, 'request user input conversation id'),
    );
  }

  setConversationPresented(request: unknown): void {
    const params = recordRequest(request, 'request user input conversation presentation');
    requireLocalHost(params.hostId);
    if (typeof params.presented !== 'boolean') {
      throw new Error('Request user input presentation state is invalid');
    }
    this.#runtime.requestUserInputAutoResolution.setConversationPresented(
      this.#surfaceId,
      nonEmptyRequestString(params.conversationId, 'request user input conversation id'),
      params.presented,
    );
  }

  snooze(request: unknown): void {
    const params = recordRequest(request, 'request user input snooze');
    requireLocalHost(params.hostId);
    const requestId = params.requestId;
    if (
      typeof requestId !== 'string' &&
      !(typeof requestId === 'number' && Number.isInteger(requestId))
    ) {
      throw new Error('Request user input request id is invalid');
    }
    this.#runtime.requestUserInputAutoResolution.snoozeRequest(
      nonEmptyRequestString(params.conversationId, 'request user input conversation id'),
      requestId,
    );
  }
}

export class ThreadMetadataGenerationService extends RpcTarget {
  #runtime: UserRuntime;

  constructor(runtime: UserRuntime) {
    super();
    this.#runtime = runtime;
  }

  async generateTitle(request: unknown): Promise<{
    title: string;
    description: string | null;
  } | null> {
    const params = recordRequest(request, 'thread title generation');
    requireLocalHost(params.hostId);
    try {
      const serviceName = optionalString(params.serviceName, 'thread title service name');
      return await this.#runtime.threadMetadataGenerator.generateTitle({
        prompt: requestString(params.prompt, 'thread title prompt'),
        cwd: optionalNullableString(params.cwd, 'thread title cwd'),
        readOnlyAppToolAllowlist: parseReadOnlyAppToolAllowlist(params.readOnlyAppToolAllowlist),
        ...(serviceName === undefined ? {} : { serviceName }),
      });
    } catch {
      return null;
    }
  }

  generateDescription(request: unknown): Promise<string | null> {
    const params = recordRequest(request, 'thread description generation');
    requireLocalHost(params.hostId);
    const serviceName = optionalString(params.serviceName, 'thread description service name');
    return this.#runtime.threadMetadataGenerator.generateDescription({
      title: optionalNullableString(params.title, 'thread description title'),
      cwd: optionalNullableString(params.cwd, 'thread description cwd'),
      sourceThreadId: nonEmptyRequestString(params.threadId, 'thread description thread id'),
      ...(serviceName === undefined ? {} : { serviceName }),
    });
  }
}

export class PullRequestMessageGenerationService extends RpcTarget {
  #runtime: UserRuntime;

  constructor(runtime: UserRuntime) {
    super();
    this.#runtime = runtime;
  }

  generate(request: unknown): PullRequestMessageGenerationOperation {
    const params = recordRequest(request, 'pull request message generation');
    requireLocalHost(params.hostId);
    const appServerVersion =
      optionalNullableString(params.appServerVersion, 'pull request message app-server version') ??
      null;
    const prompt = requestString(params.prompt, 'pull request message prompt');
    return new PullRequestMessageGenerationOperation((signal) =>
      this.#runtime.threadMetadataGenerator.generatePullRequestMessage({
        appServerVersion,
        prompt,
        signal,
      }),
    );
  }
}

export class PullRequestMessageGenerationOperation extends RpcTarget {
  #abortController = new AbortController();
  #result: Promise<{ title: string; body: string } | null>;
  #settled = false;
  #disposed = false;

  constructor(generate: (signal: AbortSignal) => Promise<{ title: string; body: string } | null>) {
    super();
    this.#result = generate(this.#abortController.signal).finally(() => {
      this.#settled = true;
    });
    void this.#result.catch(() => undefined);
  }

  wait(): Promise<{ title: string; body: string } | null> {
    return this.#result;
  }

  [Symbol.dispose](): void {
    if (this.#disposed || this.#settled) return;
    this.#disposed = true;
    this.#abortController.abort();
  }
}

export class GithubService extends RpcTarget {
  #runtime: UserRuntime;

  constructor(runtime: UserRuntime) {
    super();
    this.#runtime = runtime;
  }

  request(kindValue: unknown, params: unknown, source: unknown): GithubRequestOperation {
    const kind = nonEmptyRequestString(kindValue, 'GitHub request kind');
    return new GithubRequestOperation(this.#runtime.githubService.request(kind, params, source));
  }
}

export class GithubRequestOperation extends RpcTarget {
  #request: OfficialGithubRequestHandle;

  constructor(request: OfficialGithubRequestHandle) {
    super();
    this.#request = request;
  }

  wait(): Promise<unknown> {
    return this.#request.wait();
  }

  [Symbol.dispose](): void {
    this.#request[Symbol.dispose]();
  }
}

class AppInfoService extends RpcTarget {
  #runtime: UserRuntime;

  constructor(runtime: UserRuntime) {
    super();
    this.#runtime = runtime;
  }

  get(): Record<string, unknown> {
    return {
      version: this.#runtime.config.expectedRendererVersion,
      buildNumber: this.#runtime.config.expectedBuildNumber,
      buildFlavor: this.#runtime.config.expectedBuildFlavor,
      osName: 'linux',
      systemVersion: null,
      appName: 'ChatGPT',
      appBrand: this.#runtime.config.expectedAppBrand,
      appIconMedium: null,
      dockIconPreviews: null,
    };
  }
}

export class CustomAvatarsService extends RpcTarget {
  #runtime: UserRuntime;

  constructor(runtime: UserRuntime) {
    super();
    this.#runtime = runtime;
  }

  load(): Promise<unknown> {
    return this.#runtime.officialDesktopState.request('custom-avatars.load');
  }

  loadAvatar(avatarId: unknown): Promise<unknown> {
    return this.#runtime.officialDesktopState.request('custom-avatars.load-avatar', {
      avatarId: nonEmptyRequestString(avatarId, 'custom avatar id'),
    });
  }
}

export class PluginScheduledTasksService extends RpcTarget {
  #runtime: UserRuntime;

  constructor(runtime: UserRuntime) {
    super();
    this.#runtime = runtime;
  }

  async list(request: unknown): Promise<unknown> {
    try {
      const params = recordRequest(request, 'plugin scheduled tasks');
      const buildFlavor = nonEmptyRequestString(
        params.buildFlavor,
        'plugin scheduled tasks build flavor',
      );
      const cwds = requestStringArray(params.cwds, 'plugin scheduled task directories');
      const hiddenMarketplaceNames = requestStringArray(
        params.hiddenMarketplaceNames,
        'hidden plugin marketplaces',
      );
      const marketplaceKinds =
        params.marketplaceKinds === null || params.marketplaceKinds === undefined
          ? null
          : requestStringArray(params.marketplaceKinds, 'plugin marketplace kinds');
      const response = recordRequest(
        await this.#runtime.requestAppServer('plugin/list', {
          ...(cwds.length === 0 ? {} : { cwds }),
          ...(marketplaceKinds === null ? {} : { marketplaceKinds }),
        }),
        'plugin list response',
      );
      const marketplaces = Array.isArray(response.marketplaces) ? response.marketplaces : [];
      return await this.#runtime.officialDesktopState.request('plugin-scheduled-tasks.list', {
        buildFlavor,
        hiddenMarketplaceNames,
        marketplaces,
      });
    } catch {
      return { groups: [] };
    }
  }
}

interface LocalProject {
  id: string;
  name: string;
  rootPaths: string[];
  createdAt: number;
  updatedAt: number;
}

export class LocalProjectsService extends RpcTarget {
  #runtime: UserRuntime;

  constructor(runtime: UserRuntime) {
    super();
    this.#runtime = runtime;
  }

  list(): Array<Record<string, unknown>> {
    return [
      {
        id: this.#runtime.workspaceRoot,
        label: 'Server workspace',
        path: this.#runtime.workspaceRoot,
        root: this.#runtime.workspaceRoot,
      },
    ];
  }

  getActive(): Record<string, unknown> {
    return {
      id: this.#runtime.workspaceRoot,
      label: 'Server workspace',
      path: this.#runtime.workspaceRoot,
      root: this.#runtime.workspaceRoot,
    };
  }

  getWorkspaceRootOptions(): Array<Record<string, unknown>> {
    return this.list();
  }

  async create(request: unknown): Promise<{ projectId: string; rootPaths: string[] }> {
    const params = recordRequest(request, 'local project create');
    const name = requestString(params.name, 'local project name').trim();
    const sources = requestStringArray(params.sources, 'local project sources');
    if (
      params.appearance !== undefined &&
      params.appearance !== null &&
      !isPlainRecord(params.appearance)
    ) {
      throw new TypeError('local project appearance is invalid');
    }

    const rootPaths =
      sources.length === 0
        ? [await createDefaultProjectRoot(this.#runtime, name)]
        : await Promise.all(
            [...new Set(sources)].map((source) => resolveProjectRoot(this.#runtime, source)),
          );
    const existingProjects = readLocalProjects(this.#runtime.getGlobalState('local-projects'));
    const now = Date.now();
    const projectId = randomUUID();
    const project: LocalProject = {
      id: projectId,
      name: name || basename(rootPaths[0] ?? '') || 'Project',
      rootPaths,
      createdAt: now,
      updatedAt: now,
    };
    const existingOrder = requestStoredStringArray(this.#runtime.getGlobalState('project-order'));

    await this.#runtime.setGlobalState('local-projects', {
      ...existingProjects,
      [projectId]: project,
    });
    await this.#runtime.setGlobalState('project-order', [
      projectId,
      ...existingOrder.filter((id) => id !== projectId),
    ]);
    if (params.appearance !== undefined && params.appearance !== null) {
      const storedAppearances = this.#runtime.getGlobalState('project-appearances');
      const appearances = isPlainRecord(storedAppearances) ? storedAppearances : {};
      await this.#runtime.setGlobalState('project-appearances', {
        ...appearances,
        [projectId]: params.appearance,
      });
    }
    await this.#runtime.setGlobalState('selected-project', {
      type: 'local',
      projectId,
    });

    this.#runtime.sendViewMessage({
      type: 'global-state-updated',
      keys: ['local-projects', 'project-order', 'project-appearances', 'selected-project'],
    });
    this.#runtime.sendViewMessage({ type: 'workspace-root-options-updated' });
    this.#runtime.sendViewMessage({ type: 'active-workspace-roots-updated' });
    return { projectId, rootPaths };
  }
}

class LocalEnvironmentsService extends RpcTarget {
  #runtime: UserRuntime;

  constructor(runtime: UserRuntime) {
    super();
    this.#runtime = runtime;
  }

  list(): Array<Record<string, unknown>> {
    return [
      {
        id: 'server',
        name: 'Server',
        cwd: this.#runtime.workspaceRoot,
        kind: 'local',
      },
    ];
  }
}

export class PrimaryRuntimeService extends RpcTarget {
  #runtime: UserRuntime;

  constructor(runtime: UserRuntime) {
    super();
    this.#runtime = runtime;
  }

  get(): Record<string, unknown> {
    return {
      hostId: 'local',
      kind: 'local',
      cwd: this.#runtime.workspaceRoot,
      codexHome: this.#runtime.codexHome,
    };
  }

  getInstalledBundleVersion(): string {
    return `server-${this.#runtime.config.expectedRendererVersion}`;
  }

  install(request: unknown): Record<string, unknown> {
    return this.#installedResult(request);
  }

  finishInstall(request: unknown): Record<string, unknown> {
    return this.#installedResult(request);
  }

  resetDependencies(request: unknown): Record<string, unknown> {
    return this.#installedResult(request);
  }

  cancelInstall(request: unknown): { canceled: boolean } {
    assertLocalRuntimeRequest(request);
    return { canceled: false };
  }

  diagnoseDependencies(request: unknown): Record<string, unknown> {
    assertLocalRuntimeRequest(request);
    return {
      artifactToolVersion: null,
      bundleVersion: this.getInstalledBundleVersion(),
      installed: true,
      libreOfficeVersion: null,
      problems: [],
    };
  }

  loadDependencies(request: unknown): Record<string, unknown> {
    assertLocalRuntimeRequest(request);
    return {
      bundleVersion: this.getInstalledBundleVersion(),
      installed: true,
      instructions: null,
    };
  }

  getUpdateStatus(): null {
    return null;
  }

  runUpdateNow(request: unknown): Record<string, unknown> {
    return this.#installedResult(request);
  }

  isWorkspaceDependenciesFeatureEnabled(request: unknown): boolean {
    assertLocalRuntimeRequest(request);
    return true;
  }

  startUpdatePolling(): () => void {
    return () => undefined;
  }

  #installedResult(request: unknown): Record<string, unknown> {
    assertLocalRuntimeRequest(request);
    return {
      bundleVersion: this.getInstalledBundleVersion(),
      status: 'installed',
    };
  }
}

interface RemoteThreadCatalogListener {
  (value: unknown): unknown;
  dup?: () => RemoteThreadCatalogListener;
  onRpcBroken?: (callback: () => void) => void;
  [Symbol.dispose]?: () => void;
}

class LocalThreadCatalogService extends RpcTarget {
  #runtime: UserRuntime;
  #listener: RemoteThreadCatalogListener | undefined;
  #statusListener: RemoteThreadCatalogListener | undefined;
  #unsubscribeCatalog: (() => void) | undefined;
  #unsubscribeStatus: (() => void) | undefined;

  constructor(runtime: UserRuntime) {
    super();
    this.#runtime = runtime;
  }

  readPage(request: unknown): Record<string, unknown> {
    return this.#runtime.threadCatalog.readPage(request);
  }

  readEntries(request: unknown): unknown[] {
    return this.#runtime.threadCatalog.readEntries(request);
  }

  removeMissingEntry(request: unknown): Promise<boolean> {
    return this.#runtime.threadCatalog.removeMissingEntry(request);
  }

  readSnapshot(): unknown {
    return this.#runtime.threadCatalog.readSnapshot();
  }

  readStatus(): unknown {
    return this.#runtime.threadCatalog.readStatus();
  }

  subscribe(listenerValue: unknown): void {
    this.unsubscribe();
    const listener = this.#prepareListener(listenerValue, 'Thread catalog');
    this.#listener = listener;
    listener.onRpcBroken?.(() => this.unsubscribe());
    this.#unsubscribeCatalog = this.#runtime.threadCatalog.subscribe((update) => {
      this.#deliver(listener, update, () => this.unsubscribe());
    });
  }

  unsubscribe(): void {
    this.#unsubscribeCatalog?.();
    this.#unsubscribeCatalog = undefined;
    this.#listener?.[Symbol.dispose]?.();
    this.#listener = undefined;
  }

  setPopulationEnabled(enabled: unknown, startupMode?: unknown): void {
    if (typeof enabled !== 'boolean') {
      throw new TypeError('Thread catalog population state must be a boolean');
    }
    if (startupMode !== undefined && startupMode !== 'idle' && startupMode !== 'manual') {
      throw new TypeError('Thread catalog startup mode is invalid');
    }
    this.#runtime.threadCatalog.setPopulationEnabled(enabled);
  }

  subscribeStatus(listenerValue: unknown): void {
    this.unsubscribeStatus();
    const listener = this.#prepareListener(listenerValue, 'Thread catalog status');
    this.#statusListener = listener;
    listener.onRpcBroken?.(() => this.unsubscribeStatus());
    this.#unsubscribeStatus = this.#runtime.threadCatalog.subscribeStatus((status) => {
      this.#deliver(listener, status, () => this.unsubscribeStatus());
    });
  }

  unsubscribeStatus(): void {
    this.#unsubscribeStatus?.();
    this.#unsubscribeStatus = undefined;
    this.#statusListener?.[Symbol.dispose]?.();
    this.#statusListener = undefined;
  }

  requestSync(hostIds?: unknown, priority?: unknown): Promise<unknown> {
    this.#validatePriority(priority);
    return this.#runtime.threadCatalog.requestSync(hostIds);
  }

  requestStartupSync(): Promise<void> {
    return this.#runtime.threadCatalog.requestStartupSync();
  }

  [Symbol.dispose](): void {
    this.unsubscribe();
    this.unsubscribeStatus();
  }

  #prepareListener(value: unknown, label: string): RemoteThreadCatalogListener {
    if (typeof value !== 'function') throw new TypeError(`${label} listener must be callable`);
    const listener = value as RemoteThreadCatalogListener;
    return listener.dup?.() ?? listener;
  }

  #deliver(listener: RemoteThreadCatalogListener, value: unknown, onFailure: () => void): void {
    try {
      const result = listener(value);
      if (result instanceof Promise) void result.catch(onFailure);
    } catch {
      onFailure();
    }
  }

  #validatePriority(priority: unknown): void {
    if (
      priority !== undefined &&
      priority !== 'normal' &&
      priority !== 'immediate' &&
      priority !== 'idle'
    ) {
      throw new TypeError('Thread catalog sync priority is invalid');
    }
  }
}

const OFFICIAL_WORKSPACE_FILE_MAX_BYTES = 256 * 1024 * 1024;
const OFFICIAL_FOLDER_FILE_LIMIT = 1_000;
const OFFICIAL_VISUALIZATION_MAX_BYTES = 5_000_000;
const THREAD_PROJECT_ASSIGNMENTS_KEY = 'thread-project-assignments';
const IMAGE_ATTACHMENT_EXTENSIONS = new Map([
  ['image/gif', 'gif'],
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);

export class WorkspaceFilesService extends RpcTarget {
  #runtime: UserRuntime;
  #browserSessionId: string | undefined;
  #temporaryFilePaths = new Set<string>();
  #disposed = false;

  constructor(runtime: UserRuntime, browserSessionId?: string) {
    super();
    this.#runtime = runtime;
    this.#browserSessionId = browserSessionId;
  }

  root(): string {
    return this.#runtime.workspaceRoot;
  }

  async createTemporaryFile(request: unknown): Promise<{ path: string }> {
    if (this.#disposed) throw new Error('Workspace file service is disposed');
    const params = recordRequest(request, 'workspace temporary file');
    const bytes = requestBytes(params.bytes, 'workspace temporary file');
    if (bytes.byteLength > OFFICIAL_WORKSPACE_FILE_MAX_BYTES) {
      throw new Error('Temporary file is too large');
    }
    const fileName = nonEmptyRequestString(params.fileName, 'workspace temporary file name');
    const temporaryRoot = join(this.#runtime.root, 'tmp');
    await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(temporaryRoot, 'codex-file-preview-'));
    const path = join(directory, previewFileName(fileName));
    try {
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
      if (this.#disposed) throw new Error('Workspace file service is disposed');
      this.#temporaryFilePaths.add(path);
      return { path };
    } catch (error) {
      await rm(directory, { force: true, recursive: true });
      throw error;
    }
  }

  async downloadCopy(request: unknown): Promise<void> {
    if (this.#browserSessionId === undefined) {
      throw new Error('Browser download session is unavailable');
    }
    const params = recordRequest(request, 'workspace file download');
    requireLocalHost(params.hostId);
    const path = await resolveRuntimePath(
      this.#runtime,
      nonEmptyRequestString(params.path, 'workspace file download path'),
      false,
    );
    if (!(await stat(path)).isFile()) throw new Error('Workspace download path is not a file');
    const fileName = basename(path);
    const token = this.#runtime.registerBrowserDownload(path, fileName, this.#browserSessionId);
    this.#runtime.sendViewMessage({
      type: '__browser-download',
      browserSessionId: this.#browserSessionId,
      fileName,
      token,
    });
  }

  getDownloadsFolderIcon(): never {
    throw new Error('Browser downloads folder icon is not qualified');
  }

  async read(request: unknown): Promise<Record<string, unknown>> {
    const params = recordRequest(request, 'workspace file read');
    requireLocalHost(params.hostId);
    const path = await resolveRuntimePath(
      this.#runtime,
      nonEmptyRequestString(params.path, 'workspace file path'),
      false,
    );
    const representation = params.representation;
    if (representation !== 'text' && representation !== 'auto' && representation !== 'blob') {
      throw new Error('Workspace file representation is invalid');
    }
    const [bytes, fileStat] = await Promise.all([readFile(path), stat(path)]);
    const etag = workspaceFileEtag(fileStat);
    if (representation === 'text') return { etag, text: bytes.toString('utf8') };
    if (representation === 'blob') return { blob: bytes.toString('base64'), etag };
    const kind = await this.#runtime.officialDesktopState.request('file.detect-kind', {
      bytes: bytes.subarray(0, 4_096),
    });
    return kind === 'text'
      ? { etag, text: bytes.toString('utf8') }
      : { blob: bytes.toString('base64'), etag };
  }

  async releaseTemporaryFile(request: unknown): Promise<void> {
    const params = recordRequest(request, 'workspace temporary file release');
    const path = nonEmptyRequestString(params.path, 'workspace temporary file path');
    if (!this.#temporaryFilePaths.delete(path)) return;
    await rm(dirname(path), { force: true, recursive: true });
  }

  async write(request: unknown): Promise<Record<string, unknown>> {
    const params = recordRequest(request, 'workspace file write');
    requireLocalHost(params.hostId);
    const bytes = requestBytes(params.bytes, 'workspace file write');
    if (bytes.byteLength > OFFICIAL_WORKSPACE_FILE_MAX_BYTES) {
      return { maxBytes: OFFICIAL_WORKSPACE_FILE_MAX_BYTES, outcome: 'too-large' };
    }
    const path = await resolveRuntimePath(
      this.#runtime,
      nonEmptyRequestString(params.path, 'workspace file path'),
      true,
    );
    if (params.ifMatch !== null && params.ifMatch !== undefined) {
      const ifMatch = nonEmptyRequestString(params.ifMatch, 'workspace file etag');
      const current = await stat(path).catch((error: unknown) => {
        if (errorCode(error) === 'ENOENT') return null;
        throw error;
      });
      const etag = workspaceFileEtag(current);
      if (ifMatch !== etag) return { etag, outcome: 'conflict' };
    }
    await writeFile(path, bytes);
    return { etag: workspaceFileEtag(await stat(path)), outcome: 'saved' };
  }

  [Symbol.dispose](): void {
    this.#disposed = true;
    const paths = [...this.#temporaryFilePaths];
    this.#temporaryFilePaths.clear();
    void Promise.allSettled(
      paths.map(async (path) => rm(dirname(path), { force: true, recursive: true })),
    );
  }
}

export class FileAttachmentsService extends RpcTarget {
  #runtime: UserRuntime;

  constructor(runtime: UserRuntime) {
    super();
    this.#runtime = runtime;
  }

  uploadRoot(): string {
    return this.#runtime.uploadRoot;
  }

  async countFolderFiles(request: unknown): Promise<number | null> {
    const params = recordRequest(request, 'folder file count');
    requireLocalHost(params.hostId);
    const folderPath = await resolveRuntimePath(
      this.#runtime,
      nonEmptyRequestString(params.folderPath, 'folder path'),
      false,
    );
    let remainingDepth = OFFICIAL_FOLDER_FILE_LIMIT;
    const count = async (directory: string, remainingFiles: number): Promise<number | null> => {
      const entries = await readdir(directory, { withFileTypes: true });
      let result = 0;
      for (const entry of entries) {
        if (entry.isFile()) {
          result += 1;
          if (result === remainingFiles) return result;
          continue;
        }
        if (!entry.isDirectory()) continue;
        if (remainingDepth === 0) return null;
        remainingDepth -= 1;
        const nested = join(directory, entry.name);
        if ((await lstat(nested)).isSymbolicLink()) continue;
        const nestedCount = await count(nested, remainingFiles - result);
        if (nestedCount === null) return null;
        result += nestedCount;
        if (result === remainingFiles) return result;
      }
      return result;
    };
    return count(folderPath, OFFICIAL_FOLDER_FILE_LIMIT);
  }

  async persistImageFileToTemp(request: unknown): Promise<string | null> {
    const params = recordRequest(request, 'image attachment');
    const mimeType = nonEmptyRequestString(params.mimeType, 'image attachment MIME type');
    const extension = IMAGE_ATTACHMENT_EXTENSIONS.get(mimeType);
    if (extension === undefined) return null;
    const bytes = requestBytes(params.bytes, 'image attachment');
    if (bytes.byteLength > OFFICIAL_WORKSPACE_FILE_MAX_BYTES) {
      throw new Error('Image attachment is too large');
    }
    const temporaryRoot = join(this.#runtime.root, 'tmp');
    await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
    const path = join(temporaryRoot, `codex-clipboard-${randomUUID()}.${extension}`);
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    return path;
  }
}

export class DynamicToolCallsService extends RpcTarget {
  #claimedCallKeys = new Set<string>();

  tryClaimExecution(request: unknown): boolean {
    const params = recordRequest(request, 'dynamic tool execution claim');
    const callId = nonEmptyRequestString(params.callId, 'dynamic tool call id');
    const hostId = nonEmptyRequestString(params.hostId, 'dynamic tool host id');
    const threadId = nonEmptyRequestString(params.threadId, 'dynamic tool thread id');
    const turnId = nonEmptyRequestString(params.turnId, 'dynamic tool turn id');
    const key = `${hostId}:${threadId}:${turnId}:${callId}`;
    if (this.#claimedCallKeys.has(key)) return false;
    this.#claimedCallKeys.add(key);
    if (this.#claimedCallKeys.size > 1_024) {
      const oldest = this.#claimedCallKeys.values().next().value;
      if (oldest !== undefined) this.#claimedCallKeys.delete(oldest);
    }
    return true;
  }
}

export class BrowserUsePermissionsService extends RpcTarget {
  #runtime: UserRuntime;
  #updateQueue = Promise.resolve();

  constructor(runtime: UserRuntime) {
    super();
    this.#runtime = runtime;
  }

  updateOriginRules(request: unknown): Promise<BrowserPermissionSnapshot> {
    const update = this.#updateQueue.then(async () => this.#apply(request));
    this.#updateQueue = update.then(
      () => undefined,
      () => undefined,
    );
    return update;
  }

  async #apply(request: unknown): Promise<BrowserPermissionSnapshot> {
    return updateBrowserPermissionRules(this.#runtime.codexHome, request);
  }
}

export class ConversationalOnboardingService extends RpcTarget {
  #runtime: UserRuntime;

  constructor(runtime: UserRuntime) {
    super();
    this.#runtime = runtime;
  }

  async createDesktopNote(request: unknown): Promise<{ path: string }> {
    const params = recordRequest(request, 'desktop note');
    const content = requestString(params.content, 'desktop note content');
    const fileStem = basename(nonEmptyRequestString(params.fileStem, 'desktop note file stem'));
    const parentPath = await resolveRuntimePath(
      this.#runtime,
      nonEmptyRequestString(params.parentPath, 'desktop note parent path'),
      false,
    );
    for (let index = 0; ; index += 1) {
      const path = join(parentPath, `${fileStem}${index === 0 ? '' : ` (${String(index)})`}.txt`);
      try {
        await writeFile(path, content, { flag: 'wx' });
        return { path };
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
      }
    }
  }

  async createSampleChart(request: unknown): Promise<{ path: string }> {
    const params = recordRequest(request, 'sample chart');
    const bytes = requestBytes(params.bytes, 'sample chart');
    const fileStem = basename(nonEmptyRequestString(params.fileStem, 'sample chart file stem'));
    const parentPath = await resolveRuntimePath(
      this.#runtime,
      nonEmptyRequestString(params.parentPath, 'sample chart parent path'),
      false,
    );
    const path = join(parentPath, `${fileStem}.png`);
    await writeFile(path, bytes);
    return { path };
  }

  async requestDesktopRoot(): Promise<string> {
    const directory = await opendir(this.#runtime.workspaceRoot);
    await directory.close();
    return this.#runtime.workspaceRoot;
  }
}

interface ThreadProjectAssignment {
  projectKind: 'local' | 'remote';
  projectId: string;
  path?: string;
  cwd?: string;
  hostId?: string;
  pendingCoreUpdate: boolean;
}

export class ThreadProjectAssignmentsService extends RpcTarget {
  #runtime: UserRuntime;

  constructor(runtime: UserRuntime) {
    super();
    this.#runtime = runtime;
  }

  async setAssignment(request: unknown): Promise<void> {
    const params = recordRequest(request, 'thread project assignment');
    const threadId = nonEmptyRequestString(params.threadId, 'thread project assignment id');
    const assignment = parseThreadProjectAssignment(params.assignment);
    const stored = this.#runtime.getGlobalState(THREAD_PROJECT_ASSIGNMENTS_KEY);
    const assignments = isPlainRecord(stored) ? stored : {};
    const previous = assignments[threadId];
    if (sameThreadProjectAssignment(previous, assignment)) return;
    const next = { ...assignments };
    if (assignment === null) delete next[threadId];
    else next[threadId] = assignment;
    await this.#runtime.setGlobalState(THREAD_PROJECT_ASSIGNMENTS_KEY, next);
    this.#runtime.sendViewMessage({
      type: 'thread-project-assignment-updated',
      threadId,
      assignment,
    });
  }
}

export class ThreadArchiveService extends RpcTarget {
  #runtime: UserRuntime;

  constructor(runtime: UserRuntime) {
    super();
    this.#runtime = runtime;
  }

  async archiveInactiveThread(request: unknown): Promise<{ success: boolean }> {
    const params = recordRequest(request, 'inactive thread archive');
    requireLocalHost(params.hostId);
    const threadId = nonEmptyRequestString(params.threadId, 'inactive thread id');
    if (
      params.removeCatalogEntryIfMissing !== undefined &&
      typeof params.removeCatalogEntryIfMissing !== 'boolean'
    ) {
      throw new Error('Inactive thread catalog cleanup state is invalid');
    }
    const result = (await this.#runtime.officialDesktopState.request('thread.archive-inactive', {
      codexHome: this.#runtime.codexHome,
      threadId,
    })) as { archived?: unknown };
    const archived =
      result.archived === true ||
      (result.archived === null && params.removeCatalogEntryIfMissing === true);
    if (archived) {
      this.#runtime.threadCatalog.handleNotification({
        method: 'thread/archived',
        params: { threadId },
      });
    }
    return { success: archived };
  }
}

export class VisualizationsService extends RpcTarget {
  #runtime: UserRuntime;

  constructor(runtime: UserRuntime) {
    super();
    this.#runtime = runtime;
  }

  copyImage(): never {
    throw new Error('Visualization clipboard copy requires a browser clipboard gesture');
  }

  async read(request: unknown): Promise<{ contents: string } | null> {
    const params = recordRequest(request, 'visualization read');
    if (params.hostId !== undefined) requireLocalHost(params.hostId);
    const file = nonEmptyRequestString(params.file, 'visualization file');
    const threadId = nonEmptyRequestString(params.threadId, 'visualization thread id');
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\.html$/u.test(file)) {
      throw new Error('Invalid visualization read request');
    }
    if (!/^[a-zA-Z0-9_-]+$/u.test(threadId)) {
      throw new Error('Invalid visualization read request');
    }
    const datePath = visualizationDatePath(threadId);
    if (datePath === null) throw new Error('Invalid visualization read request');
    const path = join(this.#runtime.codexHome, 'visualizations', ...datePath, threadId, file);
    if ((await lstat(path)).isSymbolicLink()) {
      throw new Error('Invalid visualization read request');
    }
    const bytes = await readFile(path);
    return bytes.byteLength <= OFFICIAL_VISUALIZATION_MAX_BYTES
      ? { contents: bytes.toString('utf8') }
      : null;
  }
}

class AmbientSuggestionsService extends RpcTarget {
  hasAccessibleAndEnabledApp(): boolean {
    return false;
  }
}

class ApplicationMenuService extends RpcTarget {
  getSnapshot(): null {
    return null;
  }
}

class AppActionsService extends RpcTarget {
  run(action: unknown): never {
    throw new Error(`official app action is not qualified: ${JSON.stringify(action)}`);
  }
}

class AppUpdatesService extends RpcTarget {
  checkForUpdates(): void {}

  installUpdate(): never {
    throw new Error('desktop application update is managed by the server release controller');
  }

  setSparkleQueryParams(): void {}
}

class ClipboardService extends RpcTarget {
  readText(): never {
    throw new Error('clipboard reads require an explicit browser clipboard gesture');
  }

  writeText(): never {
    throw new Error('clipboard writes require an explicit browser clipboard gesture');
  }
}

class DownloadsService extends RpcTarget {
  list(): unknown[] {
    return [];
  }
}

/**
 * The server has no native graphical applications attached to the user's
 * browser. Return the official OpenIn response shapes with no qualified
 * targets, so the unchanged renderer suppresses native-only actions.
 */
export class OpenInService extends RpcTarget {
  detectTarget(request: unknown): { available: false } {
    void request;
    return { available: false };
  }

  getTargets(request: unknown): {
    preferredTarget: null;
    availableTargets: [];
    mode: 'editor';
    targets: [];
  } {
    void request;
    return {
      preferredTarget: null,
      availableTargets: [],
      mode: 'editor',
      targets: [],
    };
  }

  loadTargetIcon(request: unknown): { icon: null } {
    void request;
    return { icon: null };
  }

  open(request: unknown): { success: false } {
    void request;
    return { success: false };
  }

  setGlobalPreferredTarget(request: unknown): { success: true } {
    void request;
    return { success: true };
  }
}

class KeyboardModifiersService extends RpcTarget {
  get(): Record<string, boolean> {
    return { alt: false, control: false, meta: false, shift: false };
  }
}

class NotificationsService extends RpcTarget {
  permission(): 'default' {
    return 'default';
  }
}

class OwlFeaturesService extends RpcTarget {
  getState(): Record<string, unknown> {
    return {
      activeFeatureNames: [],
      activeDisabledFeatureNames: [],
      pendingFeatureNames: [],
      pendingDisabledFeatureNames: [],
      restartRequired: false,
    };
  }

  isOwlFeatureEnabled(): boolean {
    return false;
  }

  setFeatureNames(): Record<string, unknown> {
    return this.getState();
  }
}

class PerformanceTelemetryService extends RpcTarget {
  #samples = new Map<string, { wallStartedAt: number; cpuStartedAt: NodeJS.CpuUsage }>();

  startSpanCpuSampling(id: string): void {
    this.#samples.set(id, {
      wallStartedAt: performance.now(),
      cpuStartedAt: process.cpuUsage(),
    });
  }

  cancelSpanCpuSampling(id: string): void {
    this.#samples.delete(id);
  }

  finishSpanCpuSampling(id: string): Record<string, unknown> | null {
    const sample = this.#samples.get(id);
    if (sample === undefined) return null;
    this.#samples.delete(id);
    const samplingWindowDurationMs = Math.max(0, performance.now() - sample.wallStartedAt);
    const cpu = process.cpuUsage(sample.cpuStartedAt);
    const cpuMs = (cpu.user + cpu.system) / 1_000;
    return {
      samplingWindowDurationMs,
      mainProcessCpuPercentAvg:
        samplingWindowDurationMs === 0 ? null : (cpuMs / samplingWindowDurationMs) * 100,
      rendererProcessCpuPercentAvg: null,
    };
  }
}

class TracingService extends RpcTarget {
  setSampleRate(): void {}
}

class WindowNavigationService extends RpcTarget {
  openExternal(): never {
    throw new Error('external navigation must be performed by the browser');
  }
}

function recordRequest(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} request is invalid`);
  }
  return value as Record<string, unknown>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyRequestString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_000_000) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function requestString(value: unknown, label: string): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > OFFICIAL_WORKSPACE_FILE_MAX_BYTES) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function requestStringArray(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 1_000 ||
    value.some((entry) => typeof entry !== 'string' || entry.length === 0)
  ) {
    throw new TypeError(`${label} are invalid`);
  }
  return value as string[];
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requestString(value, label);
}

function optionalNullableString(value: unknown, label: string): string | null {
  return value === undefined || value === null ? null : requestString(value, label);
}

function requestBytes(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${label} bytes are invalid`);
  return value;
}

function requireLocalHost(value: unknown): void {
  if (value !== 'local') throw new Error('Only the local execution host is available');
}

function isPathWithin(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return (
    difference === '' ||
    (difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference))
  );
}

function readLocalProjects(value: unknown): Record<string, LocalProject> {
  if (!isPlainRecord(value)) return {};
  const projects: Record<string, LocalProject> = {};
  for (const [id, candidate] of Object.entries(value)) {
    if (
      !isPlainRecord(candidate) ||
      candidate.id !== id ||
      typeof candidate.name !== 'string' ||
      !Array.isArray(candidate.rootPaths) ||
      candidate.rootPaths.some((root) => typeof root !== 'string') ||
      typeof candidate.createdAt !== 'number' ||
      typeof candidate.updatedAt !== 'number'
    ) {
      continue;
    }
    projects[id] = candidate as unknown as LocalProject;
  }
  return projects;
}

function requestStoredStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

async function resolveProjectRoot(runtime: UserRuntime, input: string): Promise<string> {
  const workspaceRoot = await realpath(runtime.workspaceRoot);
  const path = await resolveRuntimePath(runtime, input, false);
  if (!isPathWithin(workspaceRoot, path)) {
    throw new Error('Project source is outside the server workspace');
  }
  if (!(await stat(path)).isDirectory()) {
    throw new Error('Project source must be a directory');
  }
  return path;
}

async function createDefaultProjectRoot(runtime: UserRuntime, name: string): Promise<string> {
  const workspaceRoot = await realpath(runtime.workspaceRoot);
  const safeName =
    name
      .normalize('NFKC')
      .replaceAll(/[^\p{Letter}\p{Number}._ -]+/gu, '-')
      .replaceAll(/^[ .]+|[ .]+$/gu, '')
      .slice(0, 120) || 'Project';
  for (let index = 0; ; index += 1) {
    const path = join(workspaceRoot, index === 0 ? safeName : `${safeName} (${String(index)})`);
    try {
      await mkdir(path);
      return path;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
  }
}

function previewFileName(fileName: string): string {
  const normalized = fileName.replaceAll('\\', '/');
  const extension = extname(basename(normalized)).toLowerCase();
  return `preview${/^\.[a-z0-9]{1,16}$/u.test(extension) ? extension : ''}`;
}

function workspaceFileEtag(value: Stats | null): string {
  if (value === null) return 'missing';
  return `stat:${createHash('sha256')
    .update(`${String(value.mtimeMs)}:${String(value.ctimeMs)}:${String(value.size)}`)
    .digest('base64url')}`;
}

function errorCode(error: unknown): string | null {
  return isPlainRecord(error) && typeof error.code === 'string' ? error.code : null;
}

function parseThreadProjectAssignment(value: unknown): ThreadProjectAssignment | null {
  if (value === null) return null;
  const assignment = recordRequest(value, 'thread project assignment value');
  const projectKind = assignment.projectKind;
  if (projectKind !== 'local' && projectKind !== 'remote') {
    throw new TypeError('Thread project assignment kind is invalid');
  }
  const projectId = nonEmptyRequestString(
    assignment.projectId,
    'thread project assignment project id',
  );
  if (typeof assignment.pendingCoreUpdate !== 'boolean') {
    throw new TypeError('Thread project assignment update state is invalid');
  }
  const path = optionalRequestString(assignment.path, 'thread project assignment path');
  const cwd = optionalRequestString(assignment.cwd, 'thread project assignment cwd');
  const hostId = optionalRequestString(assignment.hostId, 'thread project assignment host id');
  if (projectKind === 'remote' && path === undefined) {
    throw new TypeError('Remote thread project assignment path is required');
  }
  return {
    projectKind,
    projectId,
    ...(path === undefined ? {} : { path }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(hostId === undefined ? {} : { hostId }),
    pendingCoreUpdate: assignment.pendingCoreUpdate,
  };
}

function optionalRequestString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : nonEmptyRequestString(value, label);
}

function sameThreadProjectAssignment(
  left: unknown,
  right: ThreadProjectAssignment | null,
): boolean {
  if (left === null || left === undefined || right === null) {
    return (left === null || left === undefined) && right === null;
  }
  if (!isPlainRecord(left)) return false;
  return (
    left.projectKind === right.projectKind &&
    left.projectId === right.projectId &&
    (left.path ?? undefined) === right.path &&
    (left.cwd ?? undefined) === right.cwd &&
    (left.hostId ?? undefined) === right.hostId &&
    left.pendingCoreUpdate === right.pendingCoreUpdate
  );
}

function assertLocalRuntimeRequest(value: unknown): Record<string, unknown> {
  const request = recordRequest(value, 'primary runtime request');
  if (request.hostId !== undefined && request.hostId !== 'local') {
    throw new TypeError('Codex runtime installation only supports the local host');
  }
  return request;
}

function visualizationDatePath(threadId: string): string[] | null {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(threadId)) {
    return null;
  }
  const milliseconds = Number.parseInt(`${threadId.slice(0, 8)}${threadId.slice(9, 13)}`, 16);
  const date = new Date(milliseconds);
  return [
    String(date.getUTCFullYear()),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ];
}

interface RemoteTerminalListener {
  (event: TerminalEvent): unknown;
  dup?: () => RemoteTerminalListener;
  onRpcBroken?: (callback: () => void) => void;
  [Symbol.dispose]?: () => void;
}

class TerminalService extends RpcTarget {
  #runtime: UserRuntime;
  #ownerId: string;
  #listener: RemoteTerminalListener | undefined;
  #unsubscribeManager: (() => void) | undefined;

  constructor(runtime: UserRuntime, ownerId: string) {
    super();
    this.#runtime = runtime;
    this.#ownerId = ownerId;
  }

  async attach(options: unknown): Promise<void> {
    await this.#runtime.terminalManager.createOrAttach(this.#ownerId, 'attach', options);
  }

  close(sessionId: unknown): void {
    this.#runtime.terminalManager.close(this.#ownerId, sessionId);
  }

  async create(options: unknown): Promise<void> {
    await this.#runtime.terminalManager.createOrAttach(this.#ownerId, 'create', options);
  }

  getAvailableShells(): unknown[] {
    return process.platform === 'win32' ? ['powershell', 'commandPrompt'] : [];
  }

  getThreadSnapshot(threadId: unknown): unknown {
    return this.#runtime.terminalManager.getSnapshotForConversationId(this.#ownerId, threadId);
  }

  resize(sessionId: unknown, cols: unknown, rows: unknown): void {
    this.#runtime.terminalManager.resize(this.#ownerId, sessionId, cols, rows);
  }

  runAction(sessionId: unknown, cwd: unknown, command: unknown): void {
    this.#runtime.terminalManager.runAction(this.#ownerId, sessionId, cwd, command);
  }

  subscribe(listenerValue: unknown): void {
    this.unsubscribe();
    if (typeof listenerValue !== 'function') {
      throw new TypeError('Terminal subscription listener must be callable');
    }
    const listener = listenerValue as RemoteTerminalListener;
    this.#listener = listener.dup?.() ?? listener;
    this.#listener.onRpcBroken?.(() => this.unsubscribe());
    this.#unsubscribeManager = this.#runtime.terminalManager.subscribe(this.#ownerId, (event) => {
      try {
        const result = this.#listener?.(event);
        if (result instanceof Promise) {
          void result.catch(() => this.unsubscribe());
        }
      } catch {
        this.unsubscribe();
      }
    });
  }

  unsubscribe(): void {
    this.#unsubscribeManager?.();
    this.#unsubscribeManager = undefined;
    this.#listener?.[Symbol.dispose]?.();
    this.#listener = undefined;
  }

  write(sessionId: unknown, data: unknown): void {
    this.#runtime.terminalManager.write(this.#ownerId, sessionId, data);
  }

  [Symbol.dispose](): void {
    this.unsubscribe();
  }
}
