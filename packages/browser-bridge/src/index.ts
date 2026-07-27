import type { ClientFrame, HostFrame, RuntimeBootstrap } from '@codexapp/contracts';

import { browserFileResourceUrl, rewriteOfficialResourceAttribute } from './file-protocol.js';
import {
  isOfficialChatGptLoginCancellation,
  isOfficialChatGptLoginRequest,
  officialExternalNavigationUrl,
} from './navigation.js';
import { OrderedBuffer } from './ordered-buffer.js';
import { isTerminalBridgeCloseCode } from './reconnect.js';
import { installRemoteWebviewAdapter } from './remote-webview.js';

declare global {
  interface Window {
    __CODEX_BROWSER_BOOTSTRAP__?: RuntimeBootstrap;
    codexWindowType?: string;
    electronBridge?: ElectronBridge;
  }
}

type Unsubscribe = () => void;

interface ElectronBridge {
  windowType: 'electron';
  getPreloadStartedAtMs(): number;
  sendMessageFromView(message: unknown): Promise<void>;
  getPathForFile(file: File): string | null;
  startFileDrag(options: unknown): boolean;
  sendWorkerMessageFromView(worker: string, message: unknown): Promise<void>;
  subscribeToWorkerMessages(worker: string, listener: (message: unknown) => void): Unsubscribe;
  showContextMenu(options: unknown): Promise<unknown>;
  getFastModeRolloutMetrics(options: unknown): Promise<unknown>;
  getSharedObjectSnapshotValue(key: string): unknown;
  getInitialSidebarBootstrap(): unknown;
  getSystemThemeVariant(): 'dark' | 'light';
  subscribeToSystemThemeVariant(listener: () => void): Unsubscribe;
  triggerSentryTestError(): Promise<void>;
  getSentryInitOptions(): Record<string, unknown>;
  getAppSessionId(): string;
  getBuildFlavor(): string;
  isDeviceCheckSupported(): boolean;
  isIntelMacBuild(): boolean;
  usesOwlAppShell(): boolean;
}

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface HostPortRegistration {
  port: MessagePort;
  messages: OrderedBuffer<unknown>;
}

const REQUIRED_METHODS = [
  'getPreloadStartedAtMs',
  'sendMessageFromView',
  'getPathForFile',
  'startFileDrag',
  'sendWorkerMessageFromView',
  'subscribeToWorkerMessages',
  'showContextMenu',
  'getFastModeRolloutMetrics',
  'getSharedObjectSnapshotValue',
  'getInitialSidebarBootstrap',
  'getSystemThemeVariant',
  'subscribeToSystemThemeVariant',
  'triggerSentryTestError',
  'getSentryInitOptions',
  'getAppSessionId',
  'getBuildFlavor',
  'isDeviceCheckSupported',
  'isIntelMacBuild',
  'usesOwlAppShell',
] as const;

export class BrowserHostTransport extends EventTarget {
  readonly bootstrap: RuntimeBootstrap;
  #socket: WebSocket | undefined;
  #clientSequence = 0;
  #lastHostSequence = 0;
  #pendingCommands = new Map<string, PendingCommand>();
  #outbox = new Map<number, ClientFrame>();
  #workerListeners = new Map<string, Set<(message: unknown) => void>>();
  #portById = new Map<string, HostPortRegistration>();
  #closed = false;
  #reconnectAttempt = 0;

  constructor(bootstrap: RuntimeBootstrap) {
    super();
    this.bootstrap = bootstrap;
  }

  connect(): void {
    if (this.#closed) throw new Error('browser host transport is closed');
    const socket = new WebSocket(this.bootstrap.websocketUrl);
    this.#socket = socket;
    socket.addEventListener('open', () => {
      this.#reconnectAttempt = 0;
      this.#send({
        contractVersion: 1,
        type: 'hello',
        sequence: this.#clientSequence++,
        ticket: this.bootstrap.ticket,
        rendererVersion: this.bootstrap.rendererVersion,
        lastHostSequence: this.#lastHostSequence,
      });
      for (const frame of this.#outbox.values()) this.#send(frame, false);
    });
    socket.addEventListener('message', (event) => {
      this.#receive(event.data);
    });
    socket.addEventListener('close', (event) => {
      if (isTerminalBridgeCloseCode(event.code)) {
        this.#closed = true;
        const error = new Error(`browser host session was rejected (${String(event.code)})`);
        for (const pending of this.#pendingCommands.values()) pending.reject(error);
        this.#pendingCommands.clear();
        this.dispatchEvent(
          new CustomEvent('fatal', {
            detail: {
              code: `WEBSOCKET_${String(event.code)}`,
              message: event.reason || error.message,
            },
          }),
        );
        return;
      }
      if (!this.#closed) this.#scheduleReconnect();
    });
    socket.addEventListener('error', () => {
      socket.close();
    });
  }

  close(): void {
    this.#closed = true;
    this.#socket?.close();
    for (const pending of this.#pendingCommands.values()) {
      pending.reject(new Error('browser host transport closed'));
    }
    this.#pendingCommands.clear();
    for (const registration of this.#portById.values()) {
      registration.messages.clear();
      registration.port.close();
    }
    this.#portById.clear();
  }

  async sendViewMessage(message: unknown): Promise<void> {
    await this.command(message);
  }

  async sendWorkerMessage(worker: string, message: unknown): Promise<void> {
    const commandId = crypto.randomUUID();
    const frame: ClientFrame = {
      contractVersion: 1,
      type: 'worker-command',
      sequence: this.#clientSequence++,
      commandId,
      worker,
      message,
    };
    await this.#sendCommand(commandId, frame);
  }

  async invoke(method: string, params?: unknown): Promise<unknown> {
    return this.command({
      type: '__browser-bridge-request',
      method,
      params,
    });
  }

  async command(message: unknown): Promise<unknown> {
    const commandId = crypto.randomUUID();
    const frame: ClientFrame = {
      contractVersion: 1,
      type: 'command',
      sequence: this.#clientSequence++,
      commandId,
      message,
    };
    return this.#sendCommand(commandId, frame);
  }

  subscribeWorker(worker: string, listener: (message: unknown) => void): Unsubscribe {
    let listeners = this.#workerListeners.get(worker);
    if (listeners === undefined) {
      listeners = new Set();
      this.#workerListeners.set(worker, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.#workerListeners.delete(worker);
    };
  }

  connectHostPort(port: MessagePort): void {
    const portId = crypto.randomUUID();
    const registration: HostPortRegistration = {
      port,
      messages: new OrderedBuffer(10_000),
    };
    this.#portById.set(portId, registration);
    const deliver = (message: unknown): void => {
      const frame: ClientFrame = {
        contractVersion: 1,
        type: 'host-port-message',
        sequence: this.#clientSequence++,
        portId,
        message,
      };
      this.#send(frame);
    };
    port.addEventListener('message', (event) => {
      try {
        registration.messages.push(event.data, deliver);
      } catch (error) {
        registration.messages.clear();
        this.#portById.delete(portId);
        port.close();
        this.dispatchEvent(
          new CustomEvent('protocol-error', {
            detail: error instanceof Error ? error.message : 'AppHost port buffer failed',
          }),
        );
      }
    });
    port.addEventListener('messageerror', () => {
      registration.messages.clear();
      this.#portById.delete(portId);
      port.close();
    });
    const registered = this.invoke('connect-app-host', { portId });
    port.start();
    void registered.then(
      () => {
        if (this.#portById.get(portId) !== registration) return;
        registration.messages.activate(deliver);
      },
      (error: unknown) => {
        registration.messages.clear();
        this.#portById.delete(portId);
        port.close();
        this.dispatchEvent(
          new CustomEvent('protocol-error', {
            detail: error instanceof Error ? error.message : 'AppHost port registration failed',
          }),
        );
      },
    );
  }

  #sendCommand(commandId: string, frame: ClientFrame): Promise<unknown> {
    const promise = new Promise<unknown>((resolve, reject) => {
      this.#pendingCommands.set(commandId, { resolve, reject });
    });
    this.#outbox.set(frame.sequence, frame);
    this.#send(frame);
    return promise;
  }

  #send(frame: ClientFrame, retain = true): void {
    if (retain && frame.type !== 'ack' && frame.type !== 'hello') {
      this.#outbox.set(frame.sequence, frame);
    }
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify(frame));
    }
  }

  #receive(raw: unknown): void {
    if (typeof raw !== 'string') {
      this.dispatchEvent(new CustomEvent('protocol-error', { detail: 'non-text host frame' }));
      return;
    }
    let frame: HostFrame;
    try {
      frame = JSON.parse(raw) as HostFrame;
    } catch {
      this.dispatchEvent(new CustomEvent('protocol-error', { detail: 'invalid host JSON' }));
      return;
    }
    if (frame.contractVersion !== 1 || frame.sequence <= this.#lastHostSequence) return;
    this.#lastHostSequence = frame.sequence;
    this.#send({
      contractVersion: 1,
      type: 'ack',
      sequence: this.#clientSequence++,
      hostSequence: frame.sequence,
    });
    switch (frame.type) {
      case 'ready':
        this.dispatchEvent(new Event('ready'));
        break;
      case 'command-result': {
        const pending = this.#pendingCommands.get(frame.commandId);
        if (pending !== undefined) {
          this.#pendingCommands.delete(frame.commandId);
          for (const [sequence, value] of this.#outbox) {
            if ('commandId' in value && value.commandId === frame.commandId) {
              this.#outbox.delete(sequence);
            }
          }
          if (frame.ok) pending.resolve(frame.result);
          else pending.reject(new Error(frame.error ?? 'host command failed'));
        }
        break;
      }
      case 'view-message':
        if (isBrowserDownloadMessage(frame.message)) {
          if (frame.message.browserSessionId !== this.bootstrap.appSessionId) break;
          const link = document.createElement('a');
          link.href = `/api/downloads/${encodeURIComponent(frame.message.token)}/${encodeURIComponent(frame.message.fileName)}`;
          link.download = frame.message.fileName;
          link.hidden = true;
          document.body.append(link);
          link.click();
          link.remove();
          break;
        }
        window.dispatchEvent(new MessageEvent('message', { data: frame.message }));
        break;
      case 'worker-message':
        for (const listener of this.#workerListeners.get(frame.worker) ?? []) {
          listener(frame.message);
        }
        break;
      case 'host-port-message':
        this.#portById.get(frame.portId)?.port.postMessage(frame.message);
        break;
      case 'fatal':
        this.dispatchEvent(new CustomEvent('fatal', { detail: frame }));
        break;
    }
  }

  #scheduleReconnect(): void {
    const delay = Math.min(10_000, 250 * 2 ** this.#reconnectAttempt);
    this.#reconnectAttempt += 1;
    window.setTimeout(() => this.connect(), delay + Math.random() * 250);
  }
}

function isBrowserDownloadMessage(value: unknown): value is {
  type: '__browser-download';
  browserSessionId: string;
  fileName: string;
  token: string;
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return (
    message.type === '__browser-download' &&
    typeof message.browserSessionId === 'string' &&
    typeof message.fileName === 'string' &&
    typeof message.token === 'string'
  );
}

function installOfficialFileProtocolAdapter(): void {
  const rewrite = (value: string): string => browserFileResourceUrl(value, window.location.origin);
  const originalSetAttribute = Object.getOwnPropertyDescriptor(Element.prototype, 'setAttribute')
    ?.value as (this: Element, name: string, value: string) => void;
  Element.prototype.setAttribute = function setAttribute(name: string, value: string): void {
    const normalized = name.toLowerCase();
    originalSetAttribute.call(
      this,
      name,
      normalized === 'href' ||
        normalized === 'poster' ||
        normalized === 'src' ||
        normalized === 'srcset'
        ? rewriteOfficialResourceAttribute(value, rewrite)
        : value,
    );
  };
  wrapUrlProperty(HTMLAnchorElement.prototype, 'href', rewrite);
  wrapUrlProperty(HTMLImageElement.prototype, 'src', rewrite);
  wrapUrlProperty(HTMLIFrameElement.prototype, 'src', rewrite);
  wrapUrlProperty(HTMLMediaElement.prototype, 'src', rewrite);
  wrapUrlProperty(HTMLSourceElement.prototype, 'src', rewrite);
  wrapUrlProperty(HTMLVideoElement.prototype, 'poster', rewrite);
  const originalOpen = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'open')?.value as (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async: boolean,
    username?: string | null,
    password?: string | null,
  ) => void;
  XMLHttpRequest.prototype.open = function open(
    method: string,
    url: string | URL,
    async: boolean = true,
    username?: string | null,
    password?: string | null,
  ): void {
    originalOpen.call(
      this,
      method,
      typeof url === 'string' ? rewrite(url) : rewrite(url.href),
      async,
      username,
      password,
    );
  };
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (typeof input === 'string') return originalFetch(rewrite(input), init);
    if (input instanceof URL) return originalFetch(rewrite(input.href), init);
    const rewritten = rewrite(input.url);
    return originalFetch(rewritten === input.url ? input : new Request(rewritten, input), init);
  };
}

function wrapUrlProperty(
  prototype: object,
  property: string,
  rewrite: (value: string) => string,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
  if (descriptor?.get === undefined || descriptor.set === undefined) return;
  // The native setter is deliberately detached and then invoked with the actual element.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalSet = descriptor.set as (this: object, value: string) => void;
  Object.defineProperty(prototype, property, {
    ...descriptor,
    set(this: object, value: string) {
      originalSet.call(this, rewrite(value));
    },
  });
}

function installBridge(): void {
  const bootstrap = window.__CODEX_BROWSER_BOOTSTRAP__;
  if (bootstrap === undefined) {
    throw new Error('official renderer browser bootstrap is missing');
  }

  installOfficialFileProtocolAdapter();
  const preloadStartedAt = performance.timeOrigin;
  const transport = new BrowserHostTransport(bootstrap);
  installRemoteWebviewAdapter(bootstrap, (message) => transport.sendViewMessage(message));
  const themeListeners = new Set<() => void>();
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let theme: 'dark' | 'light' = bootstrap.systemThemeVariant;
  let lastSurfaceFocused: boolean | undefined;
  let pendingLoginWindow: Window | null = null;
  let pendingLoginWindowTimer: number | undefined;
  const pendingUploads = new Map<string, Promise<void>>();

  const clearPendingLoginWindow = (close: boolean): void => {
    if (pendingLoginWindowTimer !== undefined) {
      window.clearTimeout(pendingLoginWindowTimer);
      pendingLoginWindowTimer = undefined;
    }
    if (close && pendingLoginWindow !== null && !pendingLoginWindow.closed) {
      pendingLoginWindow.close();
    }
    pendingLoginWindow = null;
  };

  const reserveLoginWindow = (): void => {
    clearPendingLoginWindow(true);
    pendingLoginWindow = window.open('about:blank', '_blank');
    if (pendingLoginWindow !== null) pendingLoginWindow.opener = null;
    pendingLoginWindowTimer = window.setTimeout(() => {
      clearPendingLoginWindow(true);
    }, 60_000);
  };

  const openExternalUrl = (url: string): void => {
    const reserved = pendingLoginWindow;
    clearPendingLoginWindow(false);
    if (reserved !== null && !reserved.closed) {
      reserved.location.replace(url);
      return;
    }
    const opened = window.open(url, '_blank');
    if (opened !== null) {
      opened.opener = null;
      return;
    }
    window.location.assign(url);
  };

  const onTheme = (): void => {
    theme = media.matches ? 'dark' : 'light';
    for (const listener of themeListeners) listener();
  };
  media.addEventListener('change', onTheme);
  document.documentElement?.classList.add(theme === 'dark' ? 'electron-dark' : 'electron-light');

  const syncSurfaceFocus = (force = false): void => {
    const focused = document.visibilityState === 'visible' && document.hasFocus();
    if (!force && focused === lastSurfaceFocused) return;
    lastSurfaceFocused = focused;
    void transport
      .sendViewMessage({
        type: '__browser-surface-focus-changed',
        browserSessionId: bootstrap.appSessionId,
        focused,
      })
      .catch(() => undefined);
  };
  window.addEventListener('focus', () => syncSurfaceFocus());
  window.addEventListener('blur', () => syncSurfaceFocus());
  document.addEventListener('visibilitychange', () => syncSurfaceFocus());
  transport.addEventListener('ready', () => syncSurfaceFocus(true));

  const waitForUploads = async (value: unknown): Promise<void> => {
    const paths = new Set<string>();
    const visit = (entry: unknown): void => {
      if (typeof entry === 'string') {
        if (pendingUploads.has(entry)) paths.add(entry);
      } else if (Array.isArray(entry)) {
        for (const child of entry) visit(child);
      } else if (entry !== null && typeof entry === 'object') {
        for (const child of Object.values(entry)) visit(child);
      }
    };
    visit(value);
    await Promise.all([...paths].map(async (path) => pendingUploads.get(path)));
  };

  const bridge: ElectronBridge = {
    windowType: 'electron',
    getPreloadStartedAtMs: () => preloadStartedAt,
    sendMessageFromView: async (message) => {
      if (isOfficialChatGptLoginRequest(message)) reserveLoginWindow();
      if (isOfficialChatGptLoginCancellation(message)) clearPendingLoginWindow(true);
      const externalUrl = officialExternalNavigationUrl(message);
      if (externalUrl !== null) {
        openExternalUrl(externalUrl);
        return;
      }
      await waitForUploads(message);
      await transport.sendViewMessage(message);
    },
    getPathForFile: (file) => {
      if (!(file instanceof File)) return null;
      const id = crypto.randomUUID();
      const safeName = file.name.replaceAll(/[^A-Za-z0-9._-]/gu, '_').slice(0, 180) || 'upload';
      const remotePath = `${bootstrap.uploadPathPrefix}/${id}/${safeName}`;
      const upload = fetch(`/api/uploads/${id}/${encodeURIComponent(safeName)}`, {
        method: 'PUT',
        body: file,
        credentials: 'same-origin',
        headers: { 'content-type': file.type || 'application/octet-stream' },
      }).then((response) => {
        if (!response.ok) throw new Error(`upload failed (${String(response.status)})`);
      });
      pendingUploads.set(remotePath, upload);
      void upload.finally(() => pendingUploads.delete(remotePath));
      return remotePath;
    },
    startFileDrag: () => false,
    sendWorkerMessageFromView: (worker, message) => transport.sendWorkerMessage(worker, message),
    subscribeToWorkerMessages: (worker, listener) => transport.subscribeWorker(worker, listener),
    showContextMenu: (options) => transport.invoke('show-context-menu', options),
    getFastModeRolloutMetrics: (options) => transport.invoke('fast-mode-rollout-metrics', options),
    getSharedObjectSnapshotValue: (key) => bootstrap.sharedObjectSnapshot[key],
    getInitialSidebarBootstrap: () => bootstrap.initialSidebarBootstrap,
    getSystemThemeVariant: () => theme,
    subscribeToSystemThemeVariant: (listener) => {
      themeListeners.add(listener);
      return () => themeListeners.delete(listener);
    },
    triggerSentryTestError: async () => {
      await transport.invoke('trigger-sentry-test');
    },
    getSentryInitOptions: () => bootstrap.sentryInitOptions,
    getAppSessionId: () => bootstrap.appSessionId,
    getBuildFlavor: () => bootstrap.buildFlavor,
    isDeviceCheckSupported: () => false,
    isIntelMacBuild: () => false,
    usesOwlAppShell: () => bootstrap.usesOwlAppShell,
  };

  for (const method of REQUIRED_METHODS) {
    if (typeof bridge[method] !== 'function') {
      throw new Error(`official preload contract method is missing: ${method}`);
    }
  }

  Object.defineProperty(window, 'codexWindowType', {
    configurable: false,
    enumerable: true,
    writable: false,
    value: 'electron',
  });
  Object.defineProperty(window, 'electronBridge', {
    configurable: false,
    enumerable: true,
    writable: false,
    value: Object.freeze(bridge),
  });
  window.addEventListener('message', (event) => {
    if (
      event.source === window &&
      event.data !== null &&
      typeof event.data === 'object' &&
      (event.data as { type?: unknown }).type === 'connect-app-host'
    ) {
      const port = (event.data as { port?: unknown }).port;
      if (port instanceof MessagePort) transport.connectHostPort(port);
    }
  });
  transport.connect();
  syncSurfaceFocus(true);
}

installBridge();
