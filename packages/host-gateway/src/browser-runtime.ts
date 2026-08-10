import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import {
  chromium,
  type BrowserContext,
  type CDPSession,
  type Download,
  type Page,
} from 'playwright-core';

const STATE_VERSION = 1;
const DEFAULT_VIEWPORT = Object.freeze({ width: 1280, height: 720 });
const MAX_VIEWPORT_EDGE = 4096;
const MAX_SEARCH_RESULTS = 100;
const BROWSER_PLUGIN_ID = 'browser@openai-bundled' as const;
const COMMENT_RUNTIME_VIEW_CHANNEL = 'codex_desktop:message-for-view';
const COMMENT_RUNTIME_HOST_CHANNEL = 'codex_desktop:browser-sidebar-runtime-message';
const COMMENT_RUNTIME_PAGE_EVENT_CHANNEL = 'codex_desktop:browser-page-event';
export const QUALIFIED_COMMENT_PRELOAD_ELECTRON_SHIM = String.raw`
(() => {
  const listeners = new Map();
  const binding = globalThis.__codexOfficialCommentRuntimeHost;
  if (typeof binding !== "function") {
    throw new Error("official comment runtime host binding is missing");
  }
  const ipcRenderer = {
    invoke(channel, message) {
      return binding(channel, message);
    },
    send(channel, message) {
      void binding(channel, message);
    },
    sendSync(channel) {
      if (channel === "codex_desktop:get-browser-webmcp-enabled") return false;
      throw new Error("Unsupported synchronous official preload channel: " + String(channel));
    },
    on(channel, listener) {
      let channelListeners = listeners.get(channel);
      if (channelListeners === undefined) {
        channelListeners = new Set();
        listeners.set(channel, channelListeners);
      }
      channelListeners.add(listener);
      return ipcRenderer;
    },
    removeListener(channel, listener) {
      listeners.get(channel)?.delete(listener);
      return ipcRenderer;
    },
  };
  const contextBridge = {
    exposeInMainWorld(name, value) {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        enumerable: false,
        value,
        writable: false,
      });
    },
    executeInMainWorld({ args = [], func }) {
      return func(...args);
    },
  };
  const webFrame = Object.freeze({
    setVisualZoomLevelLimits() {
      // Chromium already owns the zoom boundary in the hosted page.
    },
  });
  // Electron preload scripts receive a narrow process object even with
  // context isolation enabled. The official comment preload reads argv to
  // select its runtime mode and emits a preload error event. Reproduce only
  // those two observed capabilities instead of exposing Node.js to web pages.
  if (typeof globalThis.process === "undefined") {
    Object.defineProperty(globalThis, "process", {
      configurable: true,
      enumerable: false,
      value: Object.freeze({
        argv: Object.freeze([]),
        emit() {
          return false;
        },
      }),
      writable: false,
    });
  }
  Object.defineProperty(globalThis, "require", {
    configurable: true,
    enumerable: false,
    value(name) {
      if (name === "electron") return { contextBridge, ipcRenderer, webFrame };
      throw new Error("Unsupported module requested by official preload: " + String(name));
    },
    writable: false,
  });
  Object.defineProperty(globalThis, "__codexOfficialCommentRuntimeReceive", {
    configurable: true,
    enumerable: false,
    value(channel, message) {
      for (const listener of listeners.get(channel) ?? []) {
        listener(Object.freeze({ sender: null }), message);
      }
    },
    writable: false,
  });
})();
`;

export interface BrowserSnapshot {
  annotationFlow: 'batch';
  annotationModeEntrySource: null;
  tabType: 'new-tab-page' | 'web';
  isSuspended: boolean;
  title: string;
  url: string;
  faviconUrl: string | null;
  securityState: 'certificate-error' | null;
  isAudible: boolean;
  isCapturingUserMedia: boolean;
  isLoading: boolean;
  isWaitingForResponse: boolean;
  isAtDocumentBottom: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  zoomPercent: number;
  commentModeDisabledReason: string | null;
  interactionMode: 'browse' | 'comment';
  annotationEditorMode: 'comment' | 'design';
  isDesignModifierPressed: boolean;
  isOriginalViewEnabled: boolean;
  isTweaksEditorOpen: boolean;
  comments: unknown[];
}

interface PersistedBrowserPage {
  browserStorageId: string;
  browserTabId: string;
  conversationId: string;
  lastTabActivityTime: number;
  snapshot: BrowserSnapshot;
}

interface PersistedBrowserState {
  version: typeof STATE_VERSION;
  pages: PersistedBrowserPage[];
}

interface RendererRegistration {
  browserSessionId: string;
  browserStorageId: string;
  browserTabId: string;
  conversationId: string;
  hostGeneration: number;
  rendererInstanceId: string;
}

interface BrowserTab {
  browserStorageId: string;
  browserTabId: string;
  conversationId: string;
  lastTabActivityTime: number;
  hostGeneration: number;
  ownerBrowserSessionId: string;
  page: Page | null;
  cdp: CDPSession | null;
  snapshot: BrowserSnapshot;
  surfaces: Set<BrowserSurface>;
  inputQueue: Promise<void>;
  streamStarted: boolean;
  viewport: { width: number; height: number };
  findQuery: string;
  overlaySession: BrowserOverlaySession | null;
}

interface BrowserOverlaySession {
  sessionId: string;
  conversationId: string;
  target: Record<string, unknown>;
  anchorState: Record<string, unknown>;
  body: string;
  attachedImages?: unknown[];
  designChange?: Record<string, unknown>;
  designEditorState?: Record<string, unknown>;
  defaultDesignEditorOpen?: boolean;
  placementStrategy: 'anchored';
  previewAlignment: 'left' | 'right';
  surfaceMode: 'editor' | 'preview';
  screenshot?: Record<string, unknown>;
}

interface BrowserSurface {
  browserSessionId: string;
  send: (message: BrowserSurfaceServerMessage) => void;
}

export type BrowserSurfaceServerMessage =
  | {
      type: 'ready';
      snapshot: BrowserSnapshot;
    }
  | {
      type: 'frame';
      data: string;
      width: number;
      height: number;
      sequence: number;
    }
  | {
      type: 'copy-image';
      data: string;
      mimeType: 'image/png';
      browserTabId: string;
      conversationId: string;
    }
  | {
      type: 'fatal';
      message: string;
    };

export type BrowserSurfaceClientMessage =
  | {
      type: 'resize';
      width: number;
      height: number;
      deviceScaleFactor?: number;
      visible?: boolean;
    }
  | {
      type: 'pointer';
      event: 'down' | 'move' | 'up';
      x: number;
      y: number;
      button: 'left' | 'middle' | 'right' | 'none';
      buttons: number;
      clickCount?: number;
      modifiers?: number;
    }
  | {
      type: 'wheel';
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
      modifiers?: number;
    }
  | {
      type: 'key';
      event: 'down' | 'up';
      key: string;
      code: string;
      text?: string;
      repeat?: boolean;
      modifiers?: number;
    }
  | {
      type: 'insert-text';
      text: string;
    }
  | {
      type: 'focus';
      focused: boolean;
    };

export interface BrowserRuntimeOptions {
  root: string;
  executablePath?: string;
  commentPreloadPath?: string;
  emitViewMessage: (message: unknown) => void;
  registerDownload: (path: string, fileName: string, browserSessionId: string) => string;
  onError?: (error: Error, context: Record<string, unknown>) => void;
}

export interface BrowserTabMention {
  browserId: string;
  faviconUrl: string | null;
  pluginId: typeof BROWSER_PLUGIN_ID;
  recency: number;
  source: 'iab';
  tabId: string;
  snapshot: {
    title: string;
    url: string;
  };
}

export interface BrowserSurfaceHandle {
  receive(message: unknown): void;
  close(): void;
}

export class OfficialBrowserRuntime {
  readonly #options: BrowserRuntimeOptions;
  readonly #profileRoot: string;
  readonly #downloadRoot: string;
  readonly #browserHomeRoot: string;
  readonly #statePath: string;
  readonly #tabs = new Map<string, BrowserTab>();
  readonly #persisted = new Map<string, PersistedBrowserPage>();
  readonly #rendererInstances = new Map<string, string>();
  readonly #registrations = new Map<string, RendererRegistration>();
  readonly #invalidationListeners = new Set<() => void>();
  #context: BrowserContext | null = null;
  #contextStarting: Promise<BrowserContext> | null = null;
  #stateLoaded: Promise<void> | null = null;
  #persistQueue: Promise<void> = Promise.resolve();
  #frameSequence = 0;
  #canUseTweaks = true;
  #canUseAnnotationMultiSelect = true;
  #commentPreloadSource: string | null = null;

  constructor(options: BrowserRuntimeOptions) {
    this.#options = options;
    this.#profileRoot = join(options.root, 'browser-profile');
    this.#downloadRoot = join(options.root, 'browser-downloads');
    this.#browserHomeRoot = join(options.root, 'browser-home');
    this.#statePath = join(options.root, 'browser-state.json');
  }

  async start(): Promise<void> {
    await this.#loadState();
  }

  async clearBrowsingData(dataTypesValue: unknown): Promise<void> {
    const dataTypes = parseBrowsingDataTypes(dataTypesValue);
    const context =
      this.#context ??
      (this.#contextStarting === null ? null : await this.#contextStarting.catch(() => null));
    if (dataTypes.has('cookies')) await context?.clearCookies();
    if (context !== null && (dataTypes.has('cache') || dataTypes.has('siteData'))) {
      const pages = context.pages();
      const temporaryPage = pages.length === 0 ? await context.newPage() : null;
      const page = pages[0] ?? temporaryPage;
      if (page !== null) {
        const session = await context.newCDPSession(page).catch(() => null);
        if (session !== null) {
          try {
            if (dataTypes.has('cache')) {
              await session.send('Network.clearBrowserCache').catch(() => undefined);
            }
            if (dataTypes.has('siteData')) {
              const origins = new Set(
                (
                  await context.storageState({ indexedDB: true }).catch(() => ({ origins: [] }))
                ).origins.map(({ origin }) => origin),
              );
              for (const current of context.pages()) {
                const origin = browserPageOrigin(current.url());
                if (origin !== null) origins.add(origin);
              }
              for (const origin of origins) {
                await session
                  .send('Storage.clearDataForOrigin', {
                    origin,
                    storageTypes: 'all',
                  })
                  .catch(() => undefined);
              }
            }
          } finally {
            await session.detach().catch(() => undefined);
          }
        }
      }
      await temporaryPage?.close().catch(() => undefined);
    }
    if (context === null) {
      await clearClosedBrowserProfileData(this.#profileRoot, dataTypes);
    } else if (dataTypes.has('history')) {
      await context.close();
      await clearClosedBrowserProfileData(this.#profileRoot, new Set(['history']));
    }
    if (dataTypes.has('downloads')) {
      await rm(this.#downloadRoot, { force: true, recursive: true });
      await mkdir(this.#downloadRoot, { recursive: true, mode: 0o700 });
    }
  }

  async stop(): Promise<void> {
    await this.#persistQueue.catch(() => undefined);
    const context = this.#context;
    this.#context = null;
    this.#contextStarting = null;
    for (const tab of this.#tabs.values()) {
      tab.cdp = null;
      tab.page = null;
      tab.streamStarted = false;
      for (const surface of tab.surfaces) {
        safeSurfaceSend(surface, {
          type: 'fatal',
          message: 'server browser stopped',
        });
      }
      tab.surfaces.clear();
    }
    await context?.close().catch(() => undefined);
    await this.#persistNow();
  }

  registerRendererSession(browserSessionId: string, rendererInstanceId: unknown): boolean {
    const renderer = requiredString(rendererInstanceId, 'rendererInstanceId');
    const current = this.#rendererInstances.get(browserSessionId);
    if (current === renderer) return true;
    this.#rendererInstances.set(browserSessionId, renderer);
    for (const [key, registration] of this.#registrations) {
      if (registration.browserSessionId === browserSessionId) this.#registrations.delete(key);
    }
    return true;
  }

  async registerWebviewHost(browserSessionId: string, requestValue: unknown): Promise<boolean> {
    await this.#loadState();
    const request = record(requestValue, 'browser webview registration');
    const browserTabId = requiredString(request.browserTabId, 'browserTabId');
    const conversationId = requiredString(request.conversationId, 'conversationId');
    const rendererInstanceId = requiredString(request.rendererInstanceId, 'rendererInstanceId');
    const hostGeneration = nonNegativeInteger(request.hostGeneration, 'hostGeneration');
    if (this.#rendererInstances.get(browserSessionId) !== rendererInstanceId) return false;
    const persistence = optionalPersistence(request.pagePersistence);
    const browserStorageId =
      persistence?.browserStorageId ?? defaultBrowserStorageId(conversationId, browserTabId);
    const key = routeKey(conversationId, browserTabId);
    const previous = this.#registrations.get(key);
    if (
      previous !== undefined &&
      previous.rendererInstanceId === rendererInstanceId &&
      previous.hostGeneration > hostGeneration
    ) {
      return false;
    }
    const durable = this.#persisted.get(browserStorageId);
    if (
      persistence?.restore === 'required' &&
      (durable === undefined ||
        durable.conversationId !== conversationId ||
        durable.browserTabId !== browserTabId)
    ) {
      return false;
    }
    this.#registrations.set(key, {
      browserSessionId,
      browserStorageId,
      browserTabId,
      conversationId,
      hostGeneration,
      rendererInstanceId,
    });
    let tab = this.#tabs.get(key);
    if (tab === undefined) {
      const persisted =
        durable !== undefined &&
        durable.conversationId === conversationId &&
        durable.browserTabId === browserTabId
          ? durable
          : undefined;
      tab = createBrowserTab({
        browserSessionId,
        browserStorageId,
        browserTabId,
        conversationId,
        hostGeneration,
        persisted,
      });
      this.#tabs.set(key, tab);
    } else {
      tab.browserStorageId = browserStorageId;
      tab.hostGeneration = hostGeneration;
      tab.ownerBrowserSessionId = browserSessionId;
    }
    this.#emitSnapshot(tab);
    return true;
  }

  async getPageRestoreResults(requestValue: unknown): Promise<unknown[]> {
    await this.#loadState();
    const request = record(requestValue, 'browser page restore');
    if (!Array.isArray(request.pages))
      throw new TypeError('browser restore pages must be an array');
    return request.pages.map((pageValue) => {
      const page = record(pageValue, 'browser restore page');
      const browserStorageId = requiredString(page.browserStorageId, 'browserStorageId');
      const browserTabId = requiredString(page.browserTabId, 'browserTabId');
      const conversationId = requiredString(page.conversationId, 'conversationId');
      const live = this.#tabs.get(routeKey(conversationId, browserTabId));
      if (live !== undefined && live.browserStorageId === browserStorageId) {
        return {
          browserStorageId,
          snapshot: live.snapshot,
          status: 'already-live',
        };
      }
      const persisted = this.#persisted.get(browserStorageId);
      if (
        persisted === undefined ||
        persisted.browserTabId !== browserTabId ||
        persisted.conversationId !== conversationId
      ) {
        return { status: 'missing' };
      }
      return {
        snapshot: {
          ...persisted.snapshot,
          isLoading: false,
          isSuspended: true,
          isWaitingForResponse: false,
        },
        status: 'snapshot-ready',
      };
    });
  }

  async deleteConversation(requestValue: unknown): Promise<void> {
    await this.#loadState();
    const request = record(requestValue, 'browser conversation delete');
    const conversationId = requiredString(request.conversationId, 'conversationId');
    for (const [key, tab] of [...this.#tabs]) {
      if (tab.conversationId !== conversationId) continue;
      this.#tabs.delete(key);
      this.#registrations.delete(key);
      await tab.page?.close().catch(() => undefined);
    }
    for (const [storageId, page] of [...this.#persisted]) {
      if (page.conversationId === conversationId) this.#persisted.delete(storageId);
    }
    await this.#queuePersist();
    this.#notifyInvalidated();
  }

  openSiteInfo(): boolean {
    // The official service returns false when the native site-info bubble cannot be opened.
    return false;
  }

  searchTabs(
    conversationIdValue: unknown,
    queryValue: unknown,
  ): { candidates: BrowserTabMention[] } {
    const conversationId =
      conversationIdValue === null ? null : requiredString(conversationIdValue, 'conversationId');
    if (conversationId === null) return { candidates: [] };
    const query = requiredStringValue(queryValue, 'query').trim().toLowerCase();
    const candidates = [...this.#tabs.values()]
      .filter(
        (tab) =>
          tab.conversationId === conversationId &&
          !(tab.snapshot.tabType === 'new-tab-page' && tab.snapshot.url.length === 0) &&
          query
            .split(/\s+/u)
            .filter(Boolean)
            .every((part) =>
              `${tab.snapshot.title}\n${tab.snapshot.url}`.toLowerCase().includes(part),
            ),
      )
      .sort(
        (left, right) =>
          right.lastTabActivityTime - left.lastTabActivityTime ||
          left.browserTabId.localeCompare(right.browserTabId),
      )
      .slice(0, MAX_SEARCH_RESULTS)
      .map((tab) => ({
        browserId: tab.conversationId,
        faviconUrl: tab.snapshot.faviconUrl,
        pluginId: BROWSER_PLUGIN_ID,
        recency: tab.lastTabActivityTime,
        source: 'iab' as const,
        tabId: tab.browserTabId,
        snapshot: {
          title: tab.snapshot.title,
          url: tab.snapshot.url,
        },
      }));
    return { candidates };
  }

  subscribeInvalidations(listener: () => void): () => void {
    this.#invalidationListeners.add(listener);
    return () => this.#invalidationListeners.delete(listener);
  }

  async handleRendererMessage(browserSessionId: string, messageValue: unknown): Promise<void> {
    const message = record(messageValue, 'browser renderer message');
    const type = requiredString(message.type, 'type');
    switch (type) {
      case 'browser-sidebar-command':
        await this.#handleCommand(browserSessionId, message);
        return;
      case 'browser-sidebar-tweaks-enabled-changed':
        this.#canUseTweaks = message.enabled === true;
        await this.#syncAllCommentRuntimes();
        return;
      case 'browser-sidebar-annotation-multi-select-enabled-changed':
        this.#canUseAnnotationMultiSelect = message.enabled === true;
        await this.#syncAllCommentRuntimes();
        return;
      case 'browser-sidebar-comment-overlay-submit':
        await this.#handleOverlaySubmit(message);
        return;
      case 'browser-sidebar-comment-overlay-delete':
        await this.#handleOverlayDelete(message);
        return;
      case 'browser-sidebar-comment-overlay-close':
        await this.#handleOverlayClose(message);
        return;
      case 'browser-sidebar-design-overlay-update':
        this.#handleDesignOverlayUpdate(message);
        return;
      case 'browser-sidebar-design-overlay-delete':
        await this.#handleDesignOverlayDelete(message);
        return;
      case 'browser-sidebar-comment-overlay-tweaks-open-changed': {
        const tab = this.#tabForOverlayMessage(message);
        if (tab === null) return;
        tab.snapshot = { ...tab.snapshot, isTweaksEditorOpen: message.open === true };
        this.#emitSnapshot(tab);
        await this.#sendCommentRuntimeSync(tab);
        return;
      }
      case 'browser-sidebar-comment-overlay-design-scrub-changed': {
        const tab = this.#tabForOverlayMessage(message);
        if (tab === null) return;
        await this.#sendCommentRuntime(tab, {
          type: 'browser-sidebar-runtime-design-scrub-changed',
          property: message.property,
        });
        return;
      }
      case 'browser-sidebar-comment-overlay-remove-annotation-selection': {
        const tab = this.#tabForOverlayMessage(message);
        if (tab === null) return;
        await this.#sendCommentRuntime(tab, {
          type: 'browser-sidebar-runtime-remove-annotation-selection',
          selectionIndex: nonNegativeInteger(message.selectionIndex, 'selectionIndex'),
        });
        return;
      }
      case 'browser-sidebar-comment-overlay-annotation-selection-modifier-state':
      case 'browser-sidebar-comment-overlay-annotation-selection-pointer-state': {
        const tab = this.#tabForOverlayMessage(message);
        if (tab === null) return;
        await this.#sendCommentRuntime(tab, {
          type: 'browser-sidebar-runtime-annotation-selection-modifier-state',
          pressed: message.pressed === true || message.insideEditor === true,
        });
        return;
      }
      case 'browser-sidebar-runtime-create-comment-at-point':
      case 'browser-sidebar-runtime-open-design-editor-at-point':
      case 'browser-sidebar-runtime-create-comment-from-selection':
      case 'browser-sidebar-runtime-annotation-selection-modifier-state':
      case 'browser-sidebar-runtime-clear-comment-screenshot':
      case 'browser-sidebar-runtime-close-editor':
      case 'browser-sidebar-runtime-prepare-comment-screenshot':
      case 'browser-sidebar-runtime-remove-annotation-selection':
      case 'browser-sidebar-runtime-restore-editor':
      case 'browser-sidebar-runtime-select-comment': {
        const tab = this.#tabForRendererMessage(message);
        if (tab === null) return;
        await this.#sendCommentRuntime(tab, message);
        return;
      }
      case 'browser-sidebar-webview-destroyed':
      case 'browser-sidebar-owner-sync':
      case 'browser-sidebar-web-contents-pointer-down':
      case 'browser-sidebar-comment-overlay-mounted':
      case 'browser-sidebar-comment-overlay-preview-open-changed':
      case 'browser-sidebar-runtime-comment-screenshot-ready':
      case 'browser-sidebar-runtime-design-modifier-state':
      case 'browser-sidebar-runtime-document-bottom-state':
      case 'browser-sidebar-runtime-exit-comment-mode':
      case 'browser-sidebar-runtime-focus-editor':
      case 'browser-sidebar-runtime-image-drag-ended':
      case 'browser-sidebar-runtime-image-drag-started':
      case 'browser-sidebar-runtime-mouse-navigation':
      case 'browser-sidebar-runtime-open-comment-preview':
      case 'browser-sidebar-runtime-close-comment-preview':
      case 'browser-sidebar-runtime-sync':
      case 'browser-sidebar-screenshot-copied':
      case 'browser-sidebar-screenshot-copy-failed':
      case 'browser-sidebar-usage':
      case 'browser-sidebar-url-copied':
        return;
      default:
        throw new Error(`unsupported official browser renderer message: ${type}`);
    }
  }

  async attachSurface(
    browserSessionId: string,
    conversationIdValue: unknown,
    browserTabIdValue: unknown,
    send: (message: BrowserSurfaceServerMessage) => void,
  ): Promise<BrowserSurfaceHandle> {
    await this.#loadState();
    const conversationId = requiredString(conversationIdValue, 'conversationId');
    const browserTabId = requiredString(browserTabIdValue, 'browserTabId');
    const key = routeKey(conversationId, browserTabId);
    const registration = this.#registrations.get(key);
    if (registration?.browserSessionId !== browserSessionId) {
      throw new Error('browser surface has no matching official webview registration');
    }
    const tab = this.#tabs.get(key);
    if (tab === undefined) throw new Error('browser surface tab is missing');
    const surface: BrowserSurface = { browserSessionId, send };
    tab.surfaces.add(surface);
    safeSurfaceSend(surface, { type: 'ready', snapshot: tab.snapshot });
    try {
      await this.#ensurePage(tab);
      await this.#startScreencast(tab);
    } catch (error) {
      const normalized = asError(error);
      safeSurfaceSend(surface, { type: 'fatal', message: normalized.message });
      this.#report(normalized, {
        operation: 'attach-surface',
        browserTabId,
        conversationId,
      });
    }
    let closed = false;
    return {
      receive: (value) => {
        if (closed) return;
        let parsed: BrowserSurfaceClientMessage;
        try {
          parsed = parseSurfaceMessage(value);
        } catch (error) {
          safeSurfaceSend(surface, {
            type: 'fatal',
            message: asError(error).message,
          });
          return;
        }
        tab.inputQueue = tab.inputQueue
          .then(() => this.#handleSurfaceMessage(tab, parsed))
          .catch((error: unknown) => {
            this.#report(asError(error), {
              operation: 'surface-input',
              browserTabId,
              conversationId,
            });
          });
      },
      close: () => {
        if (closed) return;
        closed = true;
        tab.surfaces.delete(surface);
        if (tab.surfaces.size === 0) void this.#stopScreencast(tab);
      },
    };
  }

  async #handleCommand(browserSessionId: string, message: Record<string, unknown>): Promise<void> {
    const conversationId = requiredString(message.conversationId, 'conversationId');
    const browserTabId =
      typeof message.browserTabId === 'string'
        ? message.browserTabId
        : defaultBrowserTabId(conversationId);
    const command = record(message.command, 'browser command');
    const commandType = requiredString(command.type, 'browser command type');
    const key = routeKey(conversationId, browserTabId);
    let tab = this.#tabs.get(key);
    if (tab === undefined) {
      const persistence = optionalPersistence(message.pagePersistence);
      tab = createBrowserTab({
        browserSessionId,
        browserStorageId:
          persistence?.browserStorageId ?? defaultBrowserStorageId(conversationId, browserTabId),
        browserTabId,
        conversationId,
        hostGeneration: 0,
        persisted: undefined,
      });
      this.#tabs.set(key, tab);
    }
    tab.ownerBrowserSessionId = browserSessionId;
    tab.lastTabActivityTime = Date.now();
    switch (commandType) {
      case 'navigate': {
        const url = navigableUrl(requiredString(command.url, 'url'));
        const page = await this.#ensurePage(tab);
        tab.snapshot = {
          ...tab.snapshot,
          tabType: 'web',
          isLoading: true,
          isSuspended: false,
          isWaitingForResponse: true,
          url,
        };
        this.#emitSnapshot(tab);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch((error) => {
          tab.snapshot = {
            ...tab.snapshot,
            isLoading: false,
            isWaitingForResponse: false,
            securityState: asError(error).message.includes('CERT_') ? 'certificate-error' : null,
          };
          this.#emitSnapshot(tab);
        });
        await this.#syncSnapshotFromPage(tab);
        return;
      }
      case 'go-back':
        await (await this.#ensurePage(tab)).goBack({ waitUntil: 'domcontentloaded' });
        await this.#syncSnapshotFromPage(tab);
        return;
      case 'go-forward':
        await (await this.#ensurePage(tab)).goForward({ waitUntil: 'domcontentloaded' });
        await this.#syncSnapshotFromPage(tab);
        return;
      case 'reload':
        await (await this.#ensurePage(tab)).reload({ waitUntil: 'domcontentloaded' });
        await this.#syncSnapshotFromPage(tab);
        return;
      case 'stop':
        await (await this.#ensurePage(tab)).evaluate(() => window.stop());
        await this.#syncSnapshotFromPage(tab);
        return;
      case 'reset':
        await (await this.#ensurePage(tab)).goto('about:blank');
        tab.snapshot = newTabSnapshot();
        this.#emitSnapshot(tab);
        return;
      case 'scroll': {
        const scroll = record(command.scroll, 'browser scroll command');
        const deltaX = finiteNumber(scroll.deltaX ?? scroll.x ?? 0, 'scroll deltaX');
        const deltaY = finiteNumber(scroll.deltaY ?? scroll.y ?? 0, 'scroll deltaY');
        await (await this.#ensurePage(tab)).mouse.wheel(deltaX, deltaY);
        return;
      }
      case 'set-find-query':
        tab.findQuery = requiredStringValue(command.query, 'query');
        await this.#setFind(tab, tab.findQuery);
        return;
      case 'find-next':
      case 'find-previous':
        await this.#setFind(tab, tab.findQuery, commandType === 'find-previous');
        return;
      case 'open-find':
      case 'close-find':
      case 'focus-address':
      case 'refresh-cursor':
        return;
      case 'step-zoom':
        await this.#setZoom(
          tab,
          steppedZoom(tab.snapshot.zoomPercent, finiteNumber(command.delta, 'delta')),
        );
        return;
      case 'set-zoom-percent':
        await this.#setZoom(tab, finiteNumber(command.zoomPercent, 'zoomPercent'));
        return;
      case 'reset-zoom':
        await this.#setZoom(tab, 100);
        return;
      case 'capture-screenshot': {
        const image = await (await this.#ensurePage(tab)).screenshot({ type: 'png' });
        for (const surface of tab.surfaces) {
          safeSurfaceSend(surface, {
            type: 'copy-image',
            data: image.toString('base64'),
            mimeType: 'image/png',
            browserTabId,
            conversationId,
          });
        }
        return;
      }
      case 'print': {
        const page = await this.#ensurePage(tab);
        const pdf = await page.pdf({ printBackground: true });
        await mkdir(this.#downloadRoot, { recursive: true, mode: 0o700 });
        const fileName = `${safeFileStem(tab.snapshot.title || 'page')}.pdf`;
        const path = join(this.#downloadRoot, `${randomUUID()}-${fileName}`);
        await writeFile(path, pdf);
        this.#emitDownload(path, fileName, tab.ownerBrowserSessionId);
        return;
      }
      case 'close-tab':
        await this.#closeTab(tab, key);
        return;
      case 'transfer-conversation': {
        const targetConversationId = requiredString(
          command.targetConversationId,
          'targetConversationId',
        );
        const targetBrowserTabId =
          typeof command.targetBrowserTabId === 'string'
            ? command.targetBrowserTabId
            : defaultBrowserTabId(targetConversationId);
        this.#tabs.delete(key);
        this.#registrations.delete(key);
        tab.conversationId = targetConversationId;
        tab.browserTabId = targetBrowserTabId;
        this.#tabs.set(routeKey(targetConversationId, targetBrowserTabId), tab);
        await this.#queuePersist();
        this.#notifyInvalidated();
        return;
      }
      case 'set-interaction-mode':
        tab.snapshot = {
          ...tab.snapshot,
          interactionMode: command.interactionMode === 'comment' ? 'comment' : 'browse',
          annotationEditorMode: 'comment',
          isDesignModifierPressed: false,
          isOriginalViewEnabled: false,
          isTweaksEditorOpen: false,
        };
        if (tab.snapshot.interactionMode === 'browse') await this.#dismissOverlay(tab);
        this.#emitSnapshot(tab);
        await this.#sendCommentRuntimeSync(tab);
        return;
      case 'add-annotations-to-composer':
        tab.snapshot = resetAnnotationMode(tab.snapshot, 'browse');
        await this.#dismissOverlay(tab);
        this.#emitSnapshot(tab);
        await this.#sendCommentRuntimeSync(tab);
        return;
      case 'clear-comments':
        tab.snapshot = { ...resetAnnotationMode(tab.snapshot, 'browse'), comments: [] };
        await this.#dismissOverlay(tab);
        this.#emitSnapshot(tab);
        await this.#sendCommentRuntimeSync(tab);
        return;
      case 'discard-pending-annotations':
        tab.snapshot = { ...resetAnnotationMode(tab.snapshot), comments: [] };
        this.#emitSnapshot(tab);
        await this.#sendCommentRuntimeSync(tab);
        return;
      case 'select-comment':
        await this.#sendCommentRuntime(tab, {
          type: 'browser-sidebar-runtime-select-comment',
          commentId: requiredString(command.commentId, 'commentId'),
        });
        return;
      case 'set-design-modifier-pressed':
        tab.snapshot = {
          ...tab.snapshot,
          isDesignModifierPressed:
            tab.snapshot.interactionMode === 'comment' && command.pressed === true,
        };
        this.#emitSnapshot(tab);
        await this.#sendCommentRuntimeSync(tab);
        return;
      case 'set-original-view-enabled':
        tab.snapshot = {
          ...tab.snapshot,
          isOriginalViewEnabled:
            tab.snapshot.interactionMode === 'comment' &&
            tab.snapshot.comments.some(commentHasDesignChange) &&
            command.enabled === true,
        };
        this.#emitSnapshot(tab);
        await this.#sendCommentRuntimeSync(tab);
        return;
      default:
        throw new Error(`unsupported official browser command: ${commandType}`);
    }
  }

  async #ensurePage(tab: BrowserTab): Promise<Page> {
    if (tab.page !== null && !tab.page.isClosed()) return tab.page;
    const context = await this.#ensureContext();
    const page = await context.newPage();
    tab.page = page;
    tab.snapshot = { ...tab.snapshot, isSuspended: false };
    page.on('domcontentloaded', () => {
      void this.#syncSnapshotFromPage(tab);
      void this.#sendCommentRuntimeSync(tab);
    });
    page.on('load', () => {
      void this.#syncSnapshotFromPage(tab);
      this.#options.emitViewMessage({ type: 'browser-sidebar-page-loaded' });
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) void this.#syncSnapshotFromPage(tab);
    });
    page.on('download', (download) => {
      void this.#handleDownload(tab, download);
    });
    page.on('pageerror', (error) => {
      this.#report(asError(error), {
        operation: 'browser-page-runtime',
        browserTabId: tab.browserTabId,
        conversationId: tab.conversationId,
      });
    });
    page.on('close', () => {
      if (tab.page !== page) return;
      tab.page = null;
      tab.cdp = null;
      tab.streamStarted = false;
      tab.snapshot = {
        ...tab.snapshot,
        isLoading: false,
        isSuspended: true,
        isWaitingForResponse: false,
      };
      this.#emitSnapshot(tab);
    });
    await page.setViewportSize(tab.viewport);
    await this.#sendCommentRuntimeSync(tab);
    if (tab.snapshot.url.length > 0) {
      tab.snapshot = {
        ...tab.snapshot,
        isLoading: true,
        isSuspended: false,
        isWaitingForResponse: true,
      };
      this.#emitSnapshot(tab);
      await page
        .goto(tab.snapshot.url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
        .catch((error: unknown) => {
          this.#report(asError(error), {
            operation: 'restore-page',
            browserTabId: tab.browserTabId,
            conversationId: tab.conversationId,
          });
        });
      await this.#syncSnapshotFromPage(tab);
    }
    return page;
  }

  async #ensureContext(): Promise<BrowserContext> {
    if (this.#context !== null) return this.#context;
    if (this.#contextStarting !== null) return this.#contextStarting;
    this.#contextStarting = (async () => {
      const executablePath = this.#options.executablePath;
      if (executablePath === undefined) {
        throw new Error('BROWSER_EXECUTABLE is required for the official in-app browser');
      }
      await mkdir(this.#profileRoot, { recursive: true, mode: 0o700 });
      await mkdir(this.#downloadRoot, { recursive: true, mode: 0o700 });
      const browserCacheRoot = join(this.#browserHomeRoot, '.cache');
      const browserConfigRoot = join(this.#browserHomeRoot, '.config');
      const browserDataRoot = join(this.#browserHomeRoot, '.local', 'share');
      const browserRuntimeRoot = join(this.#browserHomeRoot, '.runtime');
      await Promise.all(
        [browserCacheRoot, browserConfigRoot, browserDataRoot, browserRuntimeRoot].map((path) =>
          mkdir(path, { recursive: true, mode: 0o700 }),
        ),
      );
      const commentPreloadSource = await this.#loadCommentPreloadSource();
      const context = await chromium.launchPersistentContext(this.#profileRoot, {
        acceptDownloads: true,
        args: ['--disable-background-networking', '--disable-sync'],
        downloadsPath: this.#downloadRoot,
        env: {
          ...definedProcessEnvironment(),
          HOME: this.#browserHomeRoot,
          XDG_CACHE_HOME: browserCacheRoot,
          XDG_CONFIG_HOME: browserConfigRoot,
          XDG_DATA_HOME: browserDataRoot,
          XDG_RUNTIME_DIR: browserRuntimeRoot,
        },
        executablePath,
        headless: true,
        viewport: DEFAULT_VIEWPORT,
      });
      if (commentPreloadSource !== null) {
        await context.exposeBinding(
          '__codexOfficialCommentRuntimeHost',
          async ({ page }, channel: unknown, message: unknown) =>
            this.#handleCommentRuntimeBridgeMessage(page, channel, message),
        );
        await context.addInitScript({
          content: `${QUALIFIED_COMMENT_PRELOAD_ELECTRON_SHIM}\n${commentPreloadSource}`,
        });
      }
      for (const page of context.pages()) {
        await page.close().catch(() => undefined);
      }
      context.on('close', () => {
        if (this.#context === context) this.#context = null;
        for (const tab of this.#tabs.values()) {
          tab.page = null;
          tab.cdp = null;
          tab.streamStarted = false;
        }
      });
      this.#context = context;
      return context;
    })();
    try {
      return await this.#contextStarting;
    } finally {
      this.#contextStarting = null;
    }
  }

  async #startScreencast(tab: BrowserTab): Promise<void> {
    if (tab.streamStarted || tab.surfaces.size === 0) return;
    const page = await this.#ensurePage(tab);
    const cdp = tab.cdp ?? (await page.context().newCDPSession(page));
    tab.cdp = cdp;
    if (!(cdp as unknown as { __codexFrameListener?: boolean }).__codexFrameListener) {
      (cdp as unknown as { __codexFrameListener?: boolean }).__codexFrameListener = true;
      cdp.on('Page.screencastFrame', (event) => {
        void cdp
          .send('Page.screencastFrameAck', { sessionId: event.sessionId })
          .catch(() => undefined);
        if (tab.surfaces.size === 0) return;
        const message: BrowserSurfaceServerMessage = {
          type: 'frame',
          data: event.data,
          width: tab.viewport.width,
          height: tab.viewport.height,
          sequence: ++this.#frameSequence,
        };
        for (const surface of tab.surfaces) safeSurfaceSend(surface, message);
      });
    }
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 78,
      maxWidth: tab.viewport.width,
      maxHeight: tab.viewport.height,
      everyNthFrame: 1,
    });
    tab.streamStarted = true;
  }

  async #stopScreencast(tab: BrowserTab): Promise<void> {
    if (!tab.streamStarted) return;
    tab.streamStarted = false;
    await tab.cdp?.send('Page.stopScreencast').catch(() => undefined);
  }

  async #handleSurfaceMessage(
    tab: BrowserTab,
    message: BrowserSurfaceClientMessage,
  ): Promise<void> {
    const page = await this.#ensurePage(tab);
    switch (message.type) {
      case 'resize': {
        if (message.visible === false) {
          await this.#stopScreencast(tab);
          return;
        }
        const width = viewportEdge(message.width);
        const height = viewportEdge(message.height);
        if (tab.viewport.width === width && tab.viewport.height === height) {
          if (!tab.streamStarted && tab.surfaces.size > 0) await this.#startScreencast(tab);
          return;
        }
        tab.viewport = { width, height };
        await this.#stopScreencast(tab);
        await page.setViewportSize(tab.viewport);
        await this.#sendCommentRuntimeSync(tab);
        if (tab.surfaces.size > 0) await this.#startScreencast(tab);
        return;
      }
      case 'pointer':
        await page.mouse.move(message.x, message.y);
        if (message.event === 'down' && message.button !== 'none') {
          await page.mouse.down({
            button: message.button,
            clickCount: message.clickCount ?? 1,
          });
        } else if (message.event === 'up' && message.button !== 'none') {
          await page.mouse.up({
            button: message.button,
            clickCount: message.clickCount ?? 1,
          });
        }
        return;
      case 'wheel':
        await page.mouse.move(message.x, message.y);
        await page.mouse.wheel(message.deltaX, message.deltaY);
        return;
      case 'key': {
        const key = playwrightKey(message);
        if (message.event === 'down') await page.keyboard.down(key);
        else await page.keyboard.up(key);
        return;
      }
      case 'insert-text':
        await page.keyboard.insertText(message.text);
        return;
      case 'focus':
        if (message.focused) await page.bringToFront();
        return;
    }
  }

  async #loadCommentPreloadSource(): Promise<string | null> {
    if (this.#options.commentPreloadPath === undefined) return null;
    if (this.#commentPreloadSource !== null) return this.#commentPreloadSource;
    const source = await readFile(this.#options.commentPreloadPath, 'utf8');
    if (
      !source.includes(COMMENT_RUNTIME_HOST_CHANNEL) ||
      !source.includes(COMMENT_RUNTIME_VIEW_CHANNEL)
    ) {
      throw new Error('the qualified official browser comment preload is invalid');
    }
    this.#commentPreloadSource = source;
    return source;
  }

  async #handleCommentRuntimeBridgeMessage(
    page: Page,
    channelValue: unknown,
    messageValue: unknown,
  ): Promise<unknown> {
    const channel = requiredString(channelValue, 'official comment runtime channel');
    const tab = [...this.#tabs.values()].find((candidate) => candidate.page === page);
    if (tab === undefined) return undefined;
    if (channel === COMMENT_RUNTIME_PAGE_EVENT_CHANNEL) {
      this.#options.emitViewMessage({
        type: 'browser-sidebar-page-event',
        browserTabId: tab.browserTabId,
        conversationId: tab.conversationId,
        event: messageValue,
      });
      return undefined;
    }
    if (channel !== COMMENT_RUNTIME_HOST_CHANNEL) {
      throw new Error(`unsupported official comment runtime channel: ${channel}`);
    }
    await this.#handleCommentRuntimeMessage(tab, messageValue);
    return undefined;
  }

  async #handleCommentRuntimeMessage(tab: BrowserTab, messageValue: unknown): Promise<void> {
    const message = record(messageValue, 'official comment runtime message');
    const type = requiredString(message.type, 'official comment runtime message type');
    switch (type) {
      case 'browser-sidebar-runtime-open-editor':
        await this.#openOverlayFromRuntime(tab, message, 'editor');
        return;
      case 'browser-sidebar-runtime-open-design-editor':
        await this.#openOverlayFromRuntime(tab, message, 'editor', true);
        return;
      case 'browser-sidebar-runtime-open-comment-preview':
        await this.#openOverlayFromRuntime(tab, message, 'preview');
        return;
      case 'browser-sidebar-runtime-close-comment-preview':
        if (tab.overlaySession?.surfaceMode === 'preview') await this.#dismissOverlay(tab);
        return;
      case 'browser-sidebar-runtime-update-anchor':
        if (
          tab.overlaySession !== null &&
          sameAnnotationTarget(
            tab.overlaySession.target,
            record(message.target, 'annotation target'),
          )
        ) {
          if (message.anchorState === null) {
            await this.#dismissOverlay(tab);
          } else {
            tab.overlaySession = {
              ...tab.overlaySession,
              anchorState: record(message.anchorState, 'annotation anchor state'),
            };
            this.#emitOverlaySession(tab, true);
          }
        }
        return;
      case 'browser-sidebar-runtime-cancel-editor':
        await this.#dismissOverlay(tab);
        return;
      case 'browser-sidebar-runtime-document-bottom-state':
        if (typeof message.isAtDocumentBottom === 'boolean') {
          tab.snapshot = {
            ...tab.snapshot,
            isAtDocumentBottom: message.isAtDocumentBottom,
          };
          this.#emitSnapshot(tab);
        }
        return;
      case 'browser-sidebar-runtime-exit-comment-mode':
        tab.snapshot = resetAnnotationMode(tab.snapshot, 'browse');
        await this.#dismissOverlay(tab);
        this.#emitSnapshot(tab);
        await this.#sendCommentRuntimeSync(tab);
        return;
      case 'browser-sidebar-runtime-design-modifier-state':
        tab.snapshot = {
          ...tab.snapshot,
          isDesignModifierPressed:
            tab.snapshot.interactionMode === 'comment' && message.pressed === true,
        };
        this.#emitSnapshot(tab);
        await this.#sendCommentRuntimeSync(tab);
        return;
      case 'browser-sidebar-runtime-mouse-navigation':
        if (message.direction === 'back') {
          await tab.page?.goBack({ waitUntil: 'domcontentloaded' });
        } else if (message.direction === 'forward') {
          await tab.page?.goForward({ waitUntil: 'domcontentloaded' });
        }
        await this.#syncSnapshotFromPage(tab);
        return;
      case 'browser-sidebar-runtime-image-drag-started':
        this.#options.emitViewMessage({
          type: 'browser-sidebar-image-drag-state',
          browserTabId: tab.browserTabId,
          conversationId: tab.conversationId,
          isActive: true,
          sourceUrl: message.sourceUrl,
        });
        return;
      case 'browser-sidebar-runtime-image-drag-ended':
        this.#options.emitViewMessage({
          type: 'browser-sidebar-image-drag-state',
          browserTabId: tab.browserTabId,
          conversationId: tab.conversationId,
          isActive: false,
        });
        return;
      case 'browser-sidebar-runtime-comment-screenshot-ready':
      case 'browser-sidebar-runtime-annotation-selection-modifier-state':
      case 'browser-sidebar-runtime-focus-editor':
        return;
      default:
        throw new Error(`unsupported official comment runtime message: ${type}`);
    }
  }

  async #openOverlayFromRuntime(
    tab: BrowserTab,
    message: Record<string, unknown>,
    surfaceMode: 'editor' | 'preview',
    designMode = false,
  ): Promise<void> {
    if (tab.snapshot.interactionMode !== 'comment') {
      await this.#sendCommentRuntime(tab, {
        type: 'browser-sidebar-runtime-close-editor',
        target: message.target,
      });
      return;
    }
    const anchorState = record(message.anchorState, 'annotation anchor state');
    let target: Record<string, unknown>;
    if (designMode) {
      const designEditorState = record(message.designEditorState, 'design editor state');
      target = {
        mode: 'design',
        groupId: requiredString(designEditorState.id, 'design group id'),
      };
      tab.snapshot = {
        ...tab.snapshot,
        annotationEditorMode: 'design',
        isTweaksEditorOpen: true,
      };
    } else if (surfaceMode === 'preview') {
      const commentId = requiredString(message.commentId, 'commentId');
      target = { mode: 'edit', commentId };
    } else {
      target = record(message.target, 'annotation target');
    }
    const existingComment =
      target.mode === 'edit'
        ? findBrowserComment(tab.snapshot.comments, requiredString(target.commentId, 'commentId'))
        : null;
    const designEditorState =
      message.designEditorState === undefined
        ? undefined
        : record(message.designEditorState, 'design editor state');
    const designChange =
      message.designChange === undefined
        ? existingComment === null
          ? undefined
          : (optionalRecord(existingComment.designChange) ?? undefined)
        : record(message.designChange, 'design change');
    tab.overlaySession = {
      sessionId: randomUUID(),
      conversationId: tab.conversationId,
      target,
      anchorState,
      body:
        existingComment !== null && typeof existingComment.body === 'string'
          ? existingComment.body
          : designChange !== undefined && typeof designChange.comment === 'string'
            ? designChange.comment
            : '',
      ...(existingComment !== null && Array.isArray(existingComment.attachedImages)
        ? { attachedImages: existingComment.attachedImages }
        : {}),
      ...(designChange === undefined ? {} : { designChange }),
      ...(designEditorState === undefined ? {} : { designEditorState }),
      ...(target.mode === 'create' && designEditorState !== undefined
        ? { defaultDesignEditorOpen: true }
        : {}),
      placementStrategy: 'anchored',
      previewAlignment: overlayPreviewAlignment(anchorState, tab.viewport),
      surfaceMode,
    };
    this.#emitSnapshot(tab);
    this.#emitOverlaySession(tab, true);
  }

  async #handleOverlaySubmit(message: Record<string, unknown>): Promise<void> {
    const tab = this.#tabForOverlayMessage(message);
    if (tab === null || tab.overlaySession === null) return;
    const session = tab.overlaySession;
    if (requiredString(message.sessionId, 'sessionId') !== session.sessionId) return;
    const body = typeof message.body === 'string' ? message.body.trim() : '';
    const attachedImages = Array.isArray(message.attachedImages)
      ? message.attachedImages
      : undefined;
    const submittedDesignChange =
      message.designChange === undefined
        ? session.designChange
        : message.designChange === null
          ? undefined
          : record(message.designChange, 'design change');
    const designChange =
      submittedDesignChange === undefined
        ? undefined
        : normalizeDesignChange(submittedDesignChange, body);
    if (body.length === 0 && designChange === undefined && (attachedImages?.length ?? 0) === 0) {
      await this.#dismissOverlay(tab);
      return;
    }
    const screenshot =
      message.captureScreenshot === false ? undefined : await this.#captureCommentScreenshot(tab);
    if (message.submitDirectly === true && designChange === undefined) {
      const comment = createBrowserComment({
        anchorState: session.anchorState,
        body,
        browserTabId: tab.browserTabId,
        ...(attachedImages === undefined ? {} : { attachedImages }),
        ...(screenshot === undefined ? {} : { screenshot }),
      });
      await this.#dismissOverlay(tab);
      this.#options.emitViewMessage({
        type: 'browser-sidebar-direct-comment',
        browserTabId: tab.browserTabId,
        conversationId: tab.conversationId,
        sessionId: session.sessionId,
        body,
        comment: serializeBrowserComment(comment, tab.browserTabId, 1),
      });
      return;
    }
    const targetMode = requiredString(session.target.mode, 'annotation target mode');
    if (targetMode === 'edit') {
      const commentId = requiredString(session.target.commentId, 'commentId');
      tab.snapshot = {
        ...tab.snapshot,
        annotationEditorMode: 'comment',
        isOriginalViewEnabled: false,
        comments: tab.snapshot.comments.map((value) => {
          const comment = optionalRecord(value);
          if (comment?.id !== commentId) return value;
          const updated: Record<string, unknown> = {
            ...comment,
            ...(body.length === 0 ? {} : { body }),
            ...(attachedImages === undefined ? {} : { attachedImages }),
            ...(designChange === undefined ? {} : { designChange }),
            ...(screenshot === undefined ? {} : { screenshot }),
          };
          if (body.length === 0) delete updated.body;
          if (submittedDesignChange === undefined && session.designChange === undefined) {
            delete updated.designChange;
          }
          return updated;
        }),
      };
    } else {
      const comment = createBrowserComment({
        anchorState: session.anchorState,
        body,
        browserTabId: tab.browserTabId,
        ...(attachedImages === undefined ? {} : { attachedImages }),
        ...(designChange === undefined ? {} : { designChange }),
        ...(screenshot === undefined ? {} : { screenshot }),
      });
      tab.snapshot = {
        ...tab.snapshot,
        annotationEditorMode: 'comment',
        isOriginalViewEnabled: false,
        comments: upsertBrowserComment(tab.snapshot.comments, comment),
      };
    }
    await this.#dismissOverlay(tab);
    this.#emitSnapshot(tab);
    await this.#sendCommentRuntimeSync(tab);
  }

  async #handleOverlayDelete(message: Record<string, unknown>): Promise<void> {
    const tab = this.#tabForOverlayMessage(message);
    if (tab === null || tab.overlaySession === null) return;
    if (requiredString(message.sessionId, 'sessionId') !== tab.overlaySession.sessionId) return;
    const commentId = requiredString(message.commentId, 'commentId');
    tab.snapshot = {
      ...tab.snapshot,
      annotationEditorMode: 'comment',
      comments: tab.snapshot.comments.filter(
        (comment) => optionalRecord(comment)?.id !== commentId,
      ),
    };
    await this.#dismissOverlay(tab);
    this.#emitSnapshot(tab);
    await this.#sendCommentRuntimeSync(tab);
  }

  async #handleOverlayClose(message: Record<string, unknown>): Promise<void> {
    const tab = this.#tabForOverlayMessage(message);
    if (tab === null || tab.overlaySession === null) return;
    if (requiredString(message.sessionId, 'sessionId') !== tab.overlaySession.sessionId) return;
    await this.#dismissOverlay(tab);
  }

  #handleDesignOverlayUpdate(message: Record<string, unknown>): void {
    const tab = this.#tabForOverlayMessage(message);
    if (tab === null || tab.overlaySession === null) return;
    if (requiredString(message.sessionId, 'sessionId') !== tab.overlaySession.sessionId) return;
    tab.overlaySession = {
      ...tab.overlaySession,
      designChange: normalizeDesignChange(record(message.group, 'design change'), ''),
    };
    this.#emitOverlaySession(tab, true);
  }

  async #handleDesignOverlayDelete(message: Record<string, unknown>): Promise<void> {
    const tab = this.#tabForOverlayMessage(message);
    if (tab === null || tab.overlaySession === null) return;
    if (requiredString(message.sessionId, 'sessionId') !== tab.overlaySession.sessionId) return;
    const groupId = requiredString(message.groupId, 'design group id');
    tab.snapshot = {
      ...tab.snapshot,
      annotationEditorMode: 'comment',
      isTweaksEditorOpen: false,
      comments: tab.snapshot.comments.flatMap((value) => {
        const comment = optionalRecord(value);
        const designChange = optionalRecord(comment?.designChange);
        if (comment === null || designChange?.id !== groupId) return [value];
        if (
          (typeof comment.body === 'string' && comment.body.trim().length > 0) ||
          (Array.isArray(comment.attachedImages) && comment.attachedImages.length > 0)
        ) {
          const updated = { ...comment };
          delete updated.designChange;
          return [updated];
        }
        return [];
      }),
    };
    await this.#dismissOverlay(tab);
    this.#emitSnapshot(tab);
    await this.#sendCommentRuntimeSync(tab);
  }

  async #dismissOverlay(tab: BrowserTab): Promise<void> {
    const session = tab.overlaySession;
    if (session === null) return;
    tab.overlaySession = null;
    tab.snapshot = {
      ...tab.snapshot,
      annotationEditorMode: 'comment',
      isTweaksEditorOpen: false,
    };
    this.#options.emitViewMessage({
      type: 'browser-sidebar-comment-overlay-session',
      browserTabId: tab.browserTabId,
      conversationId: tab.conversationId,
      session,
      ...overlayGeometry(tab, session.anchorState),
      visible: false,
      shouldPrewarm: false,
      dismissRequestSequence: 0,
    });
    await this.#sendCommentRuntime(tab, {
      type: 'browser-sidebar-runtime-close-editor',
      target: session.target,
    });
  }

  #emitOverlaySession(tab: BrowserTab, visible: boolean): void {
    const session = tab.overlaySession;
    if (session === null) return;
    this.#options.emitViewMessage({
      type: 'browser-sidebar-comment-overlay-session',
      browserTabId: tab.browserTabId,
      conversationId: tab.conversationId,
      session,
      ...overlayGeometry(tab, session.anchorState),
      visible,
      shouldPrewarm: !visible,
      dismissRequestSequence: 0,
    });
  }

  async #captureCommentScreenshot(tab: BrowserTab): Promise<Record<string, unknown> | undefined> {
    const page = tab.page;
    if (page === null || page.isClosed()) return undefined;
    const image = await page.screenshot({ type: 'png' });
    return {
      dataUrl: `data:image/png;base64,${image.toString('base64')}`,
      width: tab.viewport.width,
      height: tab.viewport.height,
    };
  }

  #tabForRendererMessage(message: Record<string, unknown>): BrowserTab | null {
    const conversationId = requiredString(message.conversationId, 'conversationId');
    const browserTabId =
      typeof message.browserTabId === 'string'
        ? message.browserTabId
        : defaultBrowserTabId(conversationId);
    return this.#tabs.get(routeKey(conversationId, browserTabId)) ?? null;
  }

  #tabForOverlayMessage(message: Record<string, unknown>): BrowserTab | null {
    const conversationId = requiredString(message.conversationId, 'conversationId');
    if (typeof message.browserTabId === 'string') {
      return this.#tabs.get(routeKey(conversationId, message.browserTabId)) ?? null;
    }
    const sessionId = typeof message.sessionId === 'string' ? message.sessionId : null;
    return (
      [...this.#tabs.values()].find(
        (tab) =>
          tab.conversationId === conversationId &&
          (sessionId === null || tab.overlaySession?.sessionId === sessionId),
      ) ?? null
    );
  }

  async #syncAllCommentRuntimes(): Promise<void> {
    await Promise.all([...this.#tabs.values()].map((tab) => this.#sendCommentRuntimeSync(tab)));
  }

  async #sendCommentRuntimeSync(tab: BrowserTab): Promise<void> {
    await this.#sendCommentRuntime(tab, {
      type: 'browser-sidebar-runtime-sync',
      interactionMode: tab.snapshot.interactionMode,
      documentBottomStateReportingEnabled: true,
      annotationEditorMode: tab.snapshot.annotationEditorMode,
      isAgentControllingBrowser: false,
      canUseAnnotationMultiSelect: this.#canUseAnnotationMultiSelect,
      canUseTweaks: this.#canUseTweaks,
      isDesignModifierPressed: tab.snapshot.isDesignModifierPressed,
      isOriginalViewEnabled: tab.snapshot.isOriginalViewEnabled,
      isTweaksEditorOpen: tab.snapshot.isTweaksEditorOpen,
      intlConfig: {
        defaultLocale: 'en-US',
        locale: 'en-US',
        messages: {},
      },
      comments: tab.snapshot.comments,
      viewportScale: 1,
      zoomPercent: tab.snapshot.zoomPercent,
    });
  }

  async #sendCommentRuntime(tab: BrowserTab, message: unknown): Promise<void> {
    const page = tab.page;
    if (page === null || page.isClosed() || this.#commentPreloadSource === null) return;
    await page
      .evaluate(
        ({ channel, message }) => {
          const receiver = (
            globalThis as typeof globalThis & {
              __codexOfficialCommentRuntimeReceive?: (channel: string, message: unknown) => void;
            }
          ).__codexOfficialCommentRuntimeReceive;
          receiver?.(channel, message);
        },
        { channel: COMMENT_RUNTIME_VIEW_CHANNEL, message },
      )
      .catch((error: unknown) => {
        this.#report(asError(error), {
          operation: 'send-comment-runtime-message',
          browserTabId: tab.browserTabId,
          conversationId: tab.conversationId,
        });
      });
  }

  async #syncSnapshotFromPage(tab: BrowserTab): Promise<void> {
    const page = tab.page;
    if (page === null || page.isClosed()) return;
    const url = page.url() === 'about:blank' ? '' : page.url();
    const [title, faviconUrl, isAtDocumentBottom] = await Promise.all([
      page.title(),
      page.evaluate(() => {
        const icon = document.querySelector<HTMLLinkElement>(
          'link[rel~="icon"], link[rel="shortcut icon"]',
        );
        return icon?.href ?? null;
      }),
      page.evaluate(
        () =>
          Math.ceil(window.scrollY + window.innerHeight) >=
          Math.floor(document.documentElement.scrollHeight),
      ),
    ]).catch(
      () => [tab.snapshot.title, tab.snapshot.faviconUrl, tab.snapshot.isAtDocumentBottom] as const,
    );
    const history = await this.#navigationState(tab).catch(() => ({
      canGoBack: tab.snapshot.canGoBack,
      canGoForward: tab.snapshot.canGoForward,
    }));
    tab.lastTabActivityTime = Date.now();
    tab.snapshot = {
      ...tab.snapshot,
      tabType: url.length === 0 ? 'new-tab-page' : 'web',
      title: title.trim() || (url.length === 0 ? 'New tab' : url),
      url,
      faviconUrl,
      isAtDocumentBottom,
      isLoading: false,
      isSuspended: false,
      isWaitingForResponse: false,
      securityState: null,
      ...history,
    };
    this.#emitSnapshot(tab);
    await this.#sendCommentRuntimeSync(tab);
  }

  async #navigationState(tab: BrowserTab): Promise<{ canGoBack: boolean; canGoForward: boolean }> {
    const page = tab.page;
    if (page === null) return { canGoBack: false, canGoForward: false };
    const cdp = tab.cdp ?? (await page.context().newCDPSession(page));
    tab.cdp = cdp;
    const history = await cdp.send('Page.getNavigationHistory');
    return {
      canGoBack: history.currentIndex > 0,
      canGoForward: history.currentIndex < history.entries.length - 1,
    };
  }

  async #setFind(tab: BrowserTab, query: string, backwards = false): Promise<void> {
    const page = await this.#ensurePage(tab);
    const found =
      query.length > 0 &&
      (await page.evaluate(
        ({ backwards, query }) =>
          (
            window as unknown as Window & {
              find: (
                value: string,
                caseSensitive: boolean,
                backwards: boolean,
                wrap: boolean,
                wholeWord: boolean,
                searchInFrames: boolean,
                showDialog: boolean,
              ) => boolean;
            }
          ).find(query, false, backwards, true, false, true, false),
        { backwards, query },
      ));
    this.#options.emitViewMessage({
      type: 'browser-sidebar-find-state',
      conversationId: tab.conversationId,
      browserTabId: tab.browserTabId,
      state: {
        activeMatchOrdinal: found ? 1 : 0,
        matches: found ? 1 : 0,
        query,
      },
    });
  }

  async #setZoom(tab: BrowserTab, requested: number): Promise<void> {
    const zoomPercent = Math.max(25, Math.min(500, Math.round(requested)));
    const page = await this.#ensurePage(tab);
    await page.evaluate((zoom) => {
      document.documentElement.style.zoom = `${String(zoom)}%`;
    }, zoomPercent);
    tab.snapshot = { ...tab.snapshot, zoomPercent };
    this.#emitSnapshot(tab);
    this.#options.emitViewMessage({
      type: 'browser-sidebar-zoom-banner',
      conversationId: tab.conversationId,
      browserTabId: tab.browserTabId,
      zoomPercent,
    });
  }

  async #closeTab(tab: BrowserTab, key: string): Promise<void> {
    this.#tabs.delete(key);
    this.#registrations.delete(key);
    this.#persisted.delete(tab.browserStorageId);
    for (const surface of tab.surfaces) {
      safeSurfaceSend(surface, { type: 'fatal', message: 'browser tab closed' });
    }
    tab.surfaces.clear();
    await tab.page?.close().catch(() => undefined);
    await this.#queuePersist();
    this.#notifyInvalidated();
  }

  async #handleDownload(tab: BrowserTab, download: Download): Promise<void> {
    try {
      await mkdir(this.#downloadRoot, { recursive: true, mode: 0o700 });
      const fileName = safeDownloadName(download.suggestedFilename());
      const path = join(this.#downloadRoot, `${randomUUID()}-${fileName}`);
      await download.saveAs(path);
      this.#emitDownload(path, fileName, tab.ownerBrowserSessionId);
    } catch (error) {
      this.#report(asError(error), {
        operation: 'download',
        browserTabId: tab.browserTabId,
        conversationId: tab.conversationId,
      });
    }
  }

  #emitDownload(path: string, fileName: string, browserSessionId: string): void {
    const token = this.#options.registerDownload(path, fileName, browserSessionId);
    this.#options.emitViewMessage({
      type: '__browser-download',
      browserSessionId,
      fileName,
      token,
    });
  }

  #emitSnapshot(tab: BrowserTab): void {
    this.#options.emitViewMessage({
      type: 'browser-sidebar-state',
      conversationId: tab.conversationId,
      browserTabId: tab.browserTabId,
      snapshot: tab.snapshot,
    });
    this.#persisted.set(tab.browserStorageId, persistedPage(tab));
    void this.#queuePersist().catch((error: unknown) => {
      this.#report(asError(error), {
        operation: 'persist-snapshot',
        browserTabId: tab.browserTabId,
        conversationId: tab.conversationId,
      });
    });
    this.#notifyInvalidated();
  }

  #notifyInvalidated(): void {
    for (const listener of this.#invalidationListeners) {
      try {
        listener();
      } catch {
        // A broken remote listener is removed by its AppHost subscription.
      }
    }
  }

  async #loadState(): Promise<void> {
    this.#stateLoaded ??= (async () => {
      try {
        const parsed = JSON.parse(await readFile(this.#statePath, 'utf8')) as unknown;
        if (!isPersistedBrowserState(parsed)) return;
        for (const page of parsed.pages) this.#persisted.set(page.browserStorageId, page);
      } catch {
        // A missing or malformed browser snapshot must not prevent Codex from starting.
      }
    })();
    await this.#stateLoaded;
  }

  async #queuePersist(): Promise<void> {
    this.#persistQueue = this.#persistQueue.catch(() => undefined).then(() => this.#persistNow());
    await this.#persistQueue;
  }

  async #persistNow(): Promise<void> {
    await mkdir(this.#options.root, { recursive: true, mode: 0o700 });
    const state: PersistedBrowserState = {
      version: STATE_VERSION,
      pages: [...this.#persisted.values()],
    };
    const temporary = `${this.#statePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      await rename(temporary, this.#statePath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  #report(error: Error, context: Record<string, unknown>): void {
    this.#options.onError?.(error, context);
  }
}

function definedProcessEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function createBrowserTab({
  browserSessionId,
  browserStorageId,
  browserTabId,
  conversationId,
  hostGeneration,
  persisted,
}: {
  browserSessionId: string;
  browserStorageId: string;
  browserTabId: string;
  conversationId: string;
  hostGeneration: number;
  persisted: PersistedBrowserPage | undefined;
}): BrowserTab {
  return {
    browserStorageId,
    browserTabId,
    conversationId,
    hostGeneration,
    lastTabActivityTime: persisted?.lastTabActivityTime ?? Date.now(),
    ownerBrowserSessionId: browserSessionId,
    page: null,
    cdp: null,
    snapshot:
      persisted === undefined
        ? newTabSnapshot()
        : {
            ...newTabSnapshot(),
            ...persisted.snapshot,
            isLoading: false,
            isSuspended: true,
            isWaitingForResponse: false,
          },
    surfaces: new Set(),
    inputQueue: Promise.resolve(),
    streamStarted: false,
    viewport: { ...DEFAULT_VIEWPORT },
    findQuery: '',
    overlaySession: null,
  };
}

function newTabSnapshot(): BrowserSnapshot {
  return {
    annotationFlow: 'batch',
    annotationModeEntrySource: null,
    tabType: 'new-tab-page',
    isSuspended: false,
    title: 'New tab',
    url: '',
    faviconUrl: null,
    securityState: null,
    isAudible: false,
    isCapturingUserMedia: false,
    isLoading: false,
    isWaitingForResponse: false,
    isAtDocumentBottom: false,
    canGoBack: false,
    canGoForward: false,
    zoomPercent: 100,
    commentModeDisabledReason: null,
    interactionMode: 'browse',
    annotationEditorMode: 'comment',
    isDesignModifierPressed: false,
    isOriginalViewEnabled: false,
    isTweaksEditorOpen: false,
    comments: [],
  };
}

function persistedPage(tab: BrowserTab): PersistedBrowserPage {
  return {
    browserStorageId: tab.browserStorageId,
    browserTabId: tab.browserTabId,
    conversationId: tab.conversationId,
    lastTabActivityTime: tab.lastTabActivityTime,
    snapshot: {
      ...tab.snapshot,
      isLoading: false,
      isSuspended: true,
      isWaitingForResponse: false,
    },
  };
}

function resetAnnotationMode(
  snapshot: BrowserSnapshot,
  interactionMode?: 'browse' | 'comment',
): BrowserSnapshot {
  return {
    ...snapshot,
    ...(interactionMode === undefined ? {} : { interactionMode }),
    annotationEditorMode: 'comment',
    annotationFlow: 'batch',
    annotationModeEntrySource:
      interactionMode === 'comment' ? snapshot.annotationModeEntrySource : null,
    isDesignModifierPressed: false,
    isOriginalViewEnabled: false,
    isTweaksEditorOpen: false,
  };
}

function commentHasDesignChange(value: unknown): boolean {
  return optionalRecord(optionalRecord(value)?.designChange) !== null;
}

function findBrowserComment(
  comments: unknown[],
  commentId: string,
): Record<string, unknown> | null {
  for (const value of comments) {
    const comment = optionalRecord(value);
    if (comment?.id === commentId) return comment;
  }
  return null;
}

function upsertBrowserComment(comments: unknown[], comment: Record<string, unknown>): unknown[] {
  const commentId = requiredString(comment.id, 'comment id');
  return comments.some((value) => optionalRecord(value)?.id === commentId)
    ? comments.map((value) => (optionalRecord(value)?.id === commentId ? comment : value))
    : [...comments, comment];
}

function createBrowserComment({
  anchorState,
  attachedImages,
  body,
  browserTabId,
  designChange,
  screenshot,
}: {
  anchorState: Record<string, unknown>;
  attachedImages?: unknown[];
  body: string;
  browserTabId: string;
  designChange?: Record<string, unknown>;
  screenshot?: Record<string, unknown>;
}): Record<string, unknown> {
  void browserTabId;
  const anchor = record(anchorState.anchor, 'annotation anchor');
  const commentId =
    designChange === undefined ? randomUUID() : requiredString(designChange.id, 'id');
  return {
    id: commentId,
    createdAt: new Date().toISOString(),
    anchor,
    ...(Array.isArray(anchorState.additionalAnchors) && anchorState.additionalAnchors.length > 0
      ? { additionalAnchors: anchorState.additionalAnchors }
      : {}),
    color: 'blue',
    ...(anchor.kind === 'element' && optionalRecord(anchorState.viewportPoint) !== null
      ? { markerViewportPoint: anchorState.viewportPoint }
      : {}),
    ...(attachedImages === undefined ? {} : { attachedImages }),
    ...(body.length === 0 ? {} : { body }),
    ...(designChange === undefined ? {} : { designChange }),
    ...(screenshot === undefined ? {} : { screenshot }),
    ...(typeof anchorState.themeVariant === 'string'
      ? { themeVariant: anchorState.themeVariant }
      : {}),
    ...(optionalRecord(anchorState.viewportSize) === null
      ? {}
      : { viewportSize: anchorState.viewportSize }),
  };
}

function normalizeDesignChange(
  value: Record<string, unknown>,
  body: string,
): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    ...value,
    id: typeof value.id === 'string' && value.id.length > 0 ? value.id : randomUUID(),
    createdAt:
      typeof value.createdAt === 'string' && value.createdAt.length > 0 ? value.createdAt : now,
    updatedAt: now,
    status: 'queued',
    ...(body.length === 0 ? {} : { comment: body }),
  };
}

function serializeBrowserComment(
  comment: Record<string, unknown>,
  browserTabId: string,
  line: number,
): Record<string, unknown> {
  const anchor = record(comment.anchor, 'browser comment anchor');
  const pageUrl = typeof anchor.pageUrl === 'string' ? anchor.pageUrl : '';
  const title = typeof anchor.title === 'string' ? anchor.title.trim() : '';
  const path = title.length > 0 ? `browser:${title}` : `browser:${browserCommentUrlLabel(pageUrl)}`;
  const body = typeof comment.body === 'string' ? comment.body : '';
  const additionalSelections = Array.isArray(comment.additionalAnchors)
    ? comment.additionalAnchors.map(serializeAdditionalBrowserSelection)
    : undefined;
  const localBrowserContext: Record<string, unknown> = {
    pageUrl,
    ...(typeof anchor.framePath === 'string' ? { framePath: anchor.framePath } : {}),
    ...(typeof anchor.frameUrl === 'string' ? { frameUrl: anchor.frameUrl } : {}),
    ...(additionalSelections === undefined || additionalSelections.length === 0
      ? {}
      : { additionalSelections }),
    ...(anchor.kind === 'text'
      ? { selectedText: anchor.selectedText }
      : {
          targetDescription: anchor.title,
          ...(anchor.immediateText === undefined
            ? {}
            : { targetImmediateText: anchor.immediateText }),
          ...(anchor.role === undefined ? {} : { targetRole: anchor.role }),
          ...(anchor.name === undefined ? {} : { targetName: anchor.name }),
          ...(anchor.selector === undefined ? {} : { targetSelector: anchor.selector }),
          ...(anchor.elementPath === undefined ? {} : { targetPath: anchor.elementPath }),
          ...(anchor.kind === 'region' && anchor.rect !== undefined
            ? { targetRect: anchor.rect }
            : {}),
          ...(anchor.nearbyText === undefined ? {} : { nearbyText: anchor.nearbyText }),
        }),
    ...(anchor.documentContext === undefined ? {} : { documentContext: anchor.documentContext }),
  };
  const screenshot = optionalRecord(comment.screenshot);
  const designChange = optionalRecord(comment.designChange);
  return {
    type: 'comment',
    content: [{ content_type: 'text', text: body }],
    position: { side: 'right', path, line },
    localBrowserContext,
    localBrowserCommentMetadata: {
      browserTabId,
      kind: anchor.kind,
      ...(comment.markerViewportPoint === undefined
        ? {}
        : { markerViewportPoint: comment.markerViewportPoint }),
      ...(comment.themeVariant === undefined ? {} : { themeVariant: comment.themeVariant }),
      ...(comment.viewportSize === undefined ? {} : { viewportSize: comment.viewportSize }),
    },
    ...(Array.isArray(comment.attachedImages)
      ? { localBrowserAttachedImages: comment.attachedImages }
      : {}),
    ...(designChange === null ? {} : { localBrowserDesignChange: { group: designChange } }),
    ...(screenshot === null
      ? {}
      : { localBrowserScreenshot: { ...screenshot, commentId: comment.id } }),
    origin: 'browser',
  };
}

function serializeAdditionalBrowserSelection(value: unknown): Record<string, unknown> {
  const anchor = record(value, 'additional browser selection');
  return {
    kind: anchor.kind,
    pageUrl: anchor.pageUrl,
    ...(anchor.framePath === undefined ? {} : { framePath: anchor.framePath }),
    ...(anchor.frameUrl === undefined ? {} : { frameUrl: anchor.frameUrl }),
    ...(anchor.kind === 'region' && anchor.rect !== undefined ? { rect: anchor.rect } : {}),
    targetDescription: anchor.title,
    ...(anchor.immediateText === undefined ? {} : { targetImmediateText: anchor.immediateText }),
    ...(anchor.role === undefined ? {} : { targetRole: anchor.role }),
    ...(anchor.name === undefined ? {} : { targetName: anchor.name }),
    ...(anchor.selector === undefined ? {} : { targetSelector: anchor.selector }),
    ...(anchor.elementPath === undefined ? {} : { targetPath: anchor.elementPath }),
    ...(anchor.nearbyText === undefined ? {} : { nearbyText: anchor.nearbyText }),
    ...(anchor.documentContext === undefined ? {} : { documentContext: anchor.documentContext }),
  };
}

function browserCommentUrlLabel(value: string): string {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return value;
  }
}

function sameAnnotationTarget(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  if (left.mode !== right.mode) return false;
  if (left.mode === 'edit') return left.commentId === right.commentId;
  if (left.mode === 'design') return left.groupId === right.groupId;
  return left.mode === 'create';
}

function overlayPreviewAlignment(
  anchorState: Record<string, unknown>,
  viewport: { width: number; height: number },
): 'left' | 'right' {
  const point = annotationViewportPoint(anchorState);
  return point.x > viewport.width / 2 ? 'left' : 'right';
}

function overlayGeometry(
  tab: BrowserTab,
  anchorState: Record<string, unknown>,
): {
  overlayWindowBounds: { x: number; y: number; width: number; height: number };
  editorFrame: { x: number; y: number; width: number; height: number };
} {
  const point = annotationViewportPoint(anchorState);
  const width = Math.min(400, Math.max(280, tab.viewport.width - 32));
  const height = Math.min(520, Math.max(260, tab.viewport.height - 32));
  const preferLeft = point.x + width + 24 > tab.viewport.width;
  const x = Math.max(
    8,
    Math.min(tab.viewport.width - width - 8, preferLeft ? point.x - width - 16 : point.x + 16),
  );
  const y = Math.max(8, Math.min(tab.viewport.height - height - 8, point.y - 24));
  return {
    overlayWindowBounds: {
      x: 0,
      y: 0,
      width: tab.viewport.width,
      height: tab.viewport.height,
    },
    editorFrame: { x, y, width, height },
  };
}

function annotationViewportPoint(anchorState: Record<string, unknown>): { x: number; y: number } {
  const point = optionalRecord(anchorState.viewportPoint);
  if (point !== null && typeof point.x === 'number' && typeof point.y === 'number') {
    return { x: point.x, y: point.y };
  }
  const rect = optionalRecord(anchorState.viewportRect);
  if (
    rect !== null &&
    typeof rect.x === 'number' &&
    typeof rect.y === 'number' &&
    typeof rect.width === 'number' &&
    typeof rect.height === 'number'
  ) {
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }
  return { x: 32, y: 32 };
}

function parseSurfaceMessage(value: unknown): BrowserSurfaceClientMessage {
  const message = record(value, 'browser surface message');
  const type = requiredString(message.type, 'browser surface message type');
  switch (type) {
    case 'resize':
      return {
        type,
        width: finiteNumber(message.width, 'width'),
        height: finiteNumber(message.height, 'height'),
        ...(message.deviceScaleFactor === undefined
          ? {}
          : {
              deviceScaleFactor: finiteNumber(message.deviceScaleFactor, 'deviceScaleFactor'),
            }),
        ...(typeof message.visible === 'boolean' ? { visible: message.visible } : {}),
      };
    case 'pointer': {
      const event = requiredString(message.event, 'pointer event');
      if (!['down', 'move', 'up'].includes(event)) throw new TypeError('invalid pointer event');
      const button = requiredString(message.button, 'pointer button');
      if (!['left', 'middle', 'right', 'none'].includes(button)) {
        throw new TypeError('invalid pointer button');
      }
      return {
        type,
        event: event as 'down' | 'move' | 'up',
        x: finiteNumber(message.x, 'x'),
        y: finiteNumber(message.y, 'y'),
        button: button as 'left' | 'middle' | 'right' | 'none',
        buttons: nonNegativeInteger(message.buttons, 'buttons'),
        ...(message.clickCount === undefined
          ? {}
          : { clickCount: nonNegativeInteger(message.clickCount, 'clickCount') }),
        ...(message.modifiers === undefined
          ? {}
          : { modifiers: nonNegativeInteger(message.modifiers, 'modifiers') }),
      };
    }
    case 'wheel':
      return {
        type,
        x: finiteNumber(message.x, 'x'),
        y: finiteNumber(message.y, 'y'),
        deltaX: finiteNumber(message.deltaX, 'deltaX'),
        deltaY: finiteNumber(message.deltaY, 'deltaY'),
        ...(message.modifiers === undefined
          ? {}
          : { modifiers: nonNegativeInteger(message.modifiers, 'modifiers') }),
      };
    case 'key': {
      const event = requiredString(message.event, 'key event');
      if (event !== 'down' && event !== 'up') throw new TypeError('invalid key event');
      return {
        type,
        event,
        key: requiredStringValue(message.key, 'key'),
        code: requiredStringValue(message.code, 'code'),
        ...(typeof message.text === 'string' ? { text: message.text } : {}),
        ...(typeof message.repeat === 'boolean' ? { repeat: message.repeat } : {}),
        ...(message.modifiers === undefined
          ? {}
          : { modifiers: nonNegativeInteger(message.modifiers, 'modifiers') }),
      };
    }
    case 'insert-text':
      return { type, text: requiredStringValue(message.text, 'text') };
    case 'focus':
      if (typeof message.focused !== 'boolean') throw new TypeError('invalid focus state');
      return { type, focused: message.focused };
    default:
      throw new TypeError(`unknown browser surface message: ${type}`);
  }
}

const BROWSING_DATA_TYPES = new Set(['cookies', 'siteData', 'cache', 'downloads', 'history']);

function parseBrowsingDataTypes(value: unknown): Set<string> {
  if (
    !Array.isArray(value) ||
    value.length > BROWSING_DATA_TYPES.size ||
    value.some((entry) => typeof entry !== 'string' || !BROWSING_DATA_TYPES.has(entry))
  ) {
    throw new TypeError('Browser browsing data types are invalid');
  }
  return new Set(value.filter((entry): entry is string => typeof entry === 'string'));
}

function browserPageOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

async function clearClosedBrowserProfileData(
  profileRoot: string,
  dataTypes: ReadonlySet<string>,
): Promise<void> {
  const paths = new Set<string>();
  const addDefault = (...segments: string[]) =>
    paths.add(join(profileRoot, 'Default', ...segments));
  if (dataTypes.has('cookies')) {
    addDefault('Cookies');
    addDefault('Cookies-journal');
    addDefault('Network', 'Cookies');
    addDefault('Network', 'Cookies-journal');
  }
  if (dataTypes.has('siteData')) {
    for (const path of [
      'File System',
      'IndexedDB',
      'Local Storage',
      'QuotaManager',
      'QuotaManager-journal',
      'Service Worker',
      'Session Storage',
      'Shared Dictionary',
      'Storage',
      'WebStorage',
    ]) {
      addDefault(path);
    }
  }
  if (dataTypes.has('cache')) {
    for (const path of ['Cache', 'Code Cache', 'GPUCache']) addDefault(path);
    for (const path of ['DawnGraphiteCache', 'DawnWebGPUCache', 'GrShaderCache', 'ShaderCache']) {
      paths.add(join(profileRoot, path));
    }
  }
  if (dataTypes.has('history')) {
    for (const path of [
      'History',
      'History-journal',
      'Top Sites',
      'Top Sites-journal',
      'Visited Links',
    ]) {
      addDefault(path);
    }
  }
  await Promise.all([...paths].map(async (path) => rm(path, { force: true, recursive: true })));
}

function playwrightKey(message: Extract<BrowserSurfaceClientMessage, { type: 'key' }>): string {
  const modifiers: string[] = [];
  const bits = message.modifiers ?? 0;
  if ((bits & 1) !== 0) modifiers.push('Alt');
  if ((bits & 2) !== 0) modifiers.push('Control');
  if ((bits & 4) !== 0) modifiers.push('Meta');
  if ((bits & 8) !== 0) modifiers.push('Shift');
  const key = normalizedPlaywrightKey(message.key, message.code);
  return [...modifiers, key].join('+');
}

function normalizedPlaywrightKey(key: string, code: string): string {
  if (key === ' ') return 'Space';
  if (key === 'Esc') return 'Escape';
  if (key === 'Del') return 'Delete';
  if (key.length === 1) return key;
  if (
    /^(?:Arrow(?:Down|Left|Right|Up)|Backspace|Delete|End|Enter|Escape|Home|Insert|PageDown|PageUp|Tab)$/u.test(
      key,
    )
  ) {
    return key;
  }
  if (/^F(?:[1-9]|1[0-2])$/u.test(key)) return key;
  if (/^(?:Key[A-Z]|Digit[0-9])$/u.test(code)) return code;
  return key;
}

function optionalPersistence(
  value: unknown,
): { browserStorageId: string; restore: 'none' | 'required' } | null {
  if (value === undefined || value === null) return null;
  const persistence = record(value, 'browser page persistence');
  const restore = requiredString(persistence.restore, 'restore');
  if (restore !== 'none' && restore !== 'required') {
    throw new TypeError('invalid browser page restore mode');
  }
  return {
    browserStorageId: requiredString(persistence.browserStorageId, 'browserStorageId'),
    restore,
  };
}

function isPersistedBrowserState(value: unknown): value is PersistedBrowserState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (state.version !== STATE_VERSION || !Array.isArray(state.pages)) return false;
  return state.pages.every((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const page = entry as Record<string, unknown>;
    return (
      typeof page.browserStorageId === 'string' &&
      typeof page.browserTabId === 'string' &&
      typeof page.conversationId === 'string' &&
      typeof page.lastTabActivityTime === 'number' &&
      page.snapshot !== null &&
      typeof page.snapshot === 'object' &&
      !Array.isArray(page.snapshot)
    );
  });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  const string = requiredStringValue(value, label);
  if (string.length === 0 || string.length > 16_384) {
    throw new TypeError(`${label} is invalid`);
  }
  return string;
}

function requiredStringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
}

function viewportEdge(value: number): number {
  return Math.max(1, Math.min(MAX_VIEWPORT_EDGE, Math.round(value)));
}

function steppedZoom(current: number, delta: number): number {
  const levels = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500];
  if (delta === 0) return current;
  const direction = delta > 0 ? 1 : -1;
  const index =
    direction > 0
      ? levels.findIndex((level) => level > current)
      : lastIndexMatching(levels, (level) => level < current);
  if (index === -1) return direction > 0 ? (levels.at(-1) ?? 500) : (levels[0] ?? 25);
  return levels[index] ?? current;
}

function lastIndexMatching(values: number[], predicate: (value: number) => boolean): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index] ?? Number.NaN)) return index;
  }
  return -1;
}

function defaultBrowserTabId(conversationId: string): string {
  return `browser:${conversationId}`;
}

function defaultBrowserStorageId(conversationId: string, browserTabId: string): string {
  return `browser:${conversationId}:${browserTabId}`;
}

function routeKey(conversationId: string, browserTabId: string): string {
  return `${conversationId}\0${browserTabId}`;
}

function navigableUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('browser navigation only supports HTTP and HTTPS');
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('browser navigation credentials are not allowed in the URL');
  }
  return url.toString();
}

function safeDownloadName(value: string): string {
  const name = safeFileComponent(basename(value));
  return name.slice(0, 180) || 'download';
}

function safeFileStem(value: string): string {
  return safeFileComponent(value).slice(0, 120) || 'page';
}

function safeFileComponent(value: string): string {
  return Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || '/\\:*?"<>|'.includes(character) ? '_' : character;
  })
    .join('')
    .trim();
}

function safeSurfaceSend(surface: BrowserSurface, message: BrowserSurfaceServerMessage): void {
  try {
    surface.send(message);
  } catch {
    // The websocket close handler removes the surface.
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
