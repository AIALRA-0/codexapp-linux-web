import type { RuntimeBootstrap } from '@codexapp/contracts';

interface RemoteWebviewState {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  socket: WebSocket | null;
  reconnectTimer: number | null;
  reconnectAttempt: number;
  destroyed: boolean;
  connectedRoute: string | null;
  framePending: boolean;
  latestFrame: string | null;
  viewport: { width: number; height: number };
  resizeObserver: ResizeObserver;
  attributeObserver: MutationObserver;
}

interface BrowserSurfaceFrame {
  type: 'frame';
  data: string;
  width: number;
  height: number;
  sequence: number;
}

interface BrowserSurfaceReady {
  type: 'ready';
  snapshot: unknown;
}

interface BrowserSurfaceCopyImage {
  type: 'copy-image';
  data: string;
  mimeType: 'image/png';
  browserTabId: string;
  conversationId: string;
}

interface BrowserSurfaceFatal {
  type: 'fatal';
  message: string;
}

type BrowserSurfaceMessage =
  BrowserSurfaceFrame | BrowserSurfaceReady | BrowserSurfaceCopyImage | BrowserSurfaceFatal;

type SendOfficialMessage = (message: unknown) => Promise<void>;

const CONVERSATION_ATTRIBUTE = 'data-browser-sidebar-conversation-id';
const TAB_ATTRIBUTE = 'data-browser-sidebar-browser-tab-id';
const states = new WeakMap<RemoteWebviewElement, RemoteWebviewState>();
const installedElements = new Set<RemoteWebviewElement>();

class RemoteWebviewElement extends HTMLElement {
  destroy(): void {
    const state = states.get(this);
    if (state === undefined || state.destroyed) return;
    state.destroyed = true;
    state.resizeObserver.disconnect();
    state.attributeObserver.disconnect();
    if (state.reconnectTimer !== null) window.clearTimeout(state.reconnectTimer);
    state.socket?.close(1000, 'webview destroyed');
    state.socket = null;
    installedElements.delete(this);
    this.replaceChildren();
  }
}

export function installRemoteWebviewAdapter(
  bootstrap: RuntimeBootstrap,
  sendOfficialMessage: SendOfficialMessage,
): void {
  const documentPrototype = Document.prototype as Document & {
    createElement: typeof document.createElement;
  };
  // The native method is deliberately detached and then called with the actual Document.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalCreateElement = documentPrototype.createElement;
  documentPrototype.createElement = function createElement(
    this: Document,
    tagName: string,
    options?: ElementCreationOptions,
  ): HTMLElement {
    const element = originalCreateElement.call(this, tagName, options);
    if (tagName.toLowerCase() !== 'webview') return element;
    const remoteElement = Object.setPrototypeOf(
      element,
      RemoteWebviewElement.prototype,
    ) as RemoteWebviewElement;
    initializeRemoteWebview(remoteElement, bootstrap, sendOfficialMessage);
    return remoteElement;
  };

  const synchronizeElements = (): void => {
    for (const element of installedElements) synchronizeConnection(element, bootstrap);
  };
  const documentObserver = new MutationObserver(synchronizeElements);
  documentObserver.observe(document, { childList: true, subtree: true });
  window.addEventListener('pagehide', () => {
    documentObserver.disconnect();
    for (const element of [...installedElements]) element.destroy();
  });
}

function initializeRemoteWebview(
  element: RemoteWebviewElement,
  bootstrap: RuntimeBootstrap,
  sendOfficialMessage: SendOfficialMessage,
): void {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: false });
  if (context === null) throw new Error('official browser surface requires a 2D canvas');
  canvas.setAttribute('aria-hidden', 'true');
  Object.assign(canvas.style, {
    display: 'block',
    height: '100%',
    touchAction: 'none',
    userSelect: 'none',
    width: '100%',
  });
  element.tabIndex = 0;
  Object.assign(element.style, {
    display: 'block',
    outline: 'none',
    overflow: 'hidden',
  });
  element.append(canvas);
  const resizeObserver = new ResizeObserver(() => synchronizeViewport(element));
  const attributeObserver = new MutationObserver(() => synchronizeConnection(element, bootstrap));
  const state: RemoteWebviewState = {
    canvas,
    context,
    socket: null,
    reconnectTimer: null,
    reconnectAttempt: 0,
    destroyed: false,
    connectedRoute: null,
    framePending: false,
    latestFrame: null,
    viewport: { width: 1280, height: 720 },
    resizeObserver,
    attributeObserver,
  };
  states.set(element, state);
  installedElements.add(element);
  resizeObserver.observe(element);
  attributeObserver.observe(element, {
    attributes: true,
    attributeFilter: [CONVERSATION_ATTRIBUTE, TAB_ATTRIBUTE],
  });
  installInputHandlers(element, state, sendOfficialMessage);
  queueMicrotask(() => synchronizeConnection(element, bootstrap));
}

function synchronizeConnection(element: RemoteWebviewElement, bootstrap: RuntimeBootstrap): void {
  const state = states.get(element);
  if (state === undefined || state.destroyed) return;
  const conversationId = element.getAttribute(CONVERSATION_ATTRIBUTE);
  const browserTabId = element.getAttribute(TAB_ATTRIBUTE);
  const route =
    element.isConnected && conversationId !== null && browserTabId !== null
      ? `${conversationId}\0${browserTabId}`
      : null;
  if (route === state.connectedRoute && state.socket !== null) {
    synchronizeViewport(element);
    return;
  }
  state.connectedRoute = route;
  state.socket?.close(1000, 'browser route changed');
  state.socket = null;
  if (state.reconnectTimer !== null) {
    window.clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  if (route === null || conversationId === null || browserTabId === null) return;
  connectSurface(element, state, bootstrap, conversationId, browserTabId);
}

function connectSurface(
  element: RemoteWebviewElement,
  state: RemoteWebviewState,
  bootstrap: RuntimeBootstrap,
  conversationId: string,
  browserTabId: string,
): void {
  if (state.destroyed || !element.isConnected) return;
  const url = new URL('/api/browser-surface', window.location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('browserSessionId', bootstrap.appSessionId);
  url.searchParams.set('conversationId', conversationId);
  url.searchParams.set('browserTabId', browserTabId);
  const socket = new WebSocket(url);
  state.socket = socket;
  socket.addEventListener('open', () => {
    if (state.socket !== socket) return;
    state.reconnectAttempt = 0;
    synchronizeViewport(element, true);
  });
  socket.addEventListener('message', (event) => {
    if (state.socket !== socket || typeof event.data !== 'string') return;
    let message: BrowserSurfaceMessage;
    try {
      message = JSON.parse(event.data) as BrowserSurfaceMessage;
    } catch {
      socket.close(4400, 'invalid browser surface message');
      return;
    }
    switch (message.type) {
      case 'ready':
        return;
      case 'frame':
        state.latestFrame = message.data;
        if (!state.framePending) {
          state.framePending = true;
          requestAnimationFrame(() => {
            state.framePending = false;
            const frame = state.latestFrame;
            state.latestFrame = null;
            if (frame !== null) void paintFrame(state, frame);
          });
        }
        return;
      case 'copy-image':
        void copyImageToClipboard(message);
        return;
      case 'fatal':
        socket.close(4404, message.message.slice(0, 120));
        return;
    }
  });
  socket.addEventListener('close', (event) => {
    if (state.socket !== socket) return;
    state.socket = null;
    if (
      state.destroyed ||
      !element.isConnected ||
      state.connectedRoute !== `${conversationId}\0${browserTabId}` ||
      event.code === 1000
    ) {
      return;
    }
    const delay = Math.min(10_000, 250 * 2 ** state.reconnectAttempt);
    state.reconnectAttempt += 1;
    state.reconnectTimer = window.setTimeout(
      () => {
        state.reconnectTimer = null;
        connectSurface(element, state, bootstrap, conversationId, browserTabId);
      },
      delay + Math.random() * 200,
    );
  });
  socket.addEventListener('error', () => socket.close());
}

function synchronizeViewport(element: RemoteWebviewElement, force = false): void {
  const state = states.get(element);
  if (state === undefined || state.destroyed) return;
  const socket = state.socket;
  if (socket?.readyState !== WebSocket.OPEN) return;
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const visible =
    element.isConnected &&
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    Number.parseFloat(style.opacity || '1') > 0.01 &&
    rect.width >= 2 &&
    rect.height >= 2;
  if (!visible) {
    socket.send(
      JSON.stringify({
        type: 'resize',
        ...state.viewport,
        deviceScaleFactor: window.devicePixelRatio,
        visible: false,
      }),
    );
    return;
  }
  const width = Math.max(1, Math.min(4096, Math.round(rect.width)));
  const height = Math.max(1, Math.min(4096, Math.round(rect.height)));
  if (!force && state.viewport.width === width && state.viewport.height === height) return;
  state.viewport = { width, height };
  socket.send(
    JSON.stringify({
      type: 'resize',
      width,
      height,
      deviceScaleFactor: window.devicePixelRatio,
      visible: true,
    }),
  );
}

function installInputHandlers(
  element: RemoteWebviewElement,
  state: RemoteWebviewState,
  sendOfficialMessage: SendOfficialMessage,
): void {
  const send = (message: unknown): void => {
    if (state.socket?.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify(message));
    }
  };
  const point = (event: PointerEvent | WheelEvent): { x: number; y: number } => {
    const bounds = element.getBoundingClientRect();
    return {
      x: ((event.clientX - bounds.left) / Math.max(bounds.width, 1)) * state.viewport.width,
      y: ((event.clientY - bounds.top) / Math.max(bounds.height, 1)) * state.viewport.height,
    };
  };
  element.addEventListener('pointerdown', (event) => {
    element.focus();
    element.setPointerCapture?.(event.pointerId);
    const coordinates = point(event);
    send({
      type: 'pointer',
      event: 'down',
      ...coordinates,
      button: pointerButton(event.button),
      buttons: event.buttons,
      clickCount: event.detail || 1,
      modifiers: modifierBits(event),
    });
    event.preventDefault();
  });
  element.addEventListener('pointermove', (event) => {
    const coordinates = point(event);
    send({
      type: 'pointer',
      event: 'move',
      ...coordinates,
      button: 'none',
      buttons: event.buttons,
      modifiers: modifierBits(event),
    });
    event.preventDefault();
  });
  const pointerUp = (event: PointerEvent): void => {
    const coordinates = point(event);
    send({
      type: 'pointer',
      event: 'up',
      ...coordinates,
      button: pointerButton(event.button),
      buttons: event.buttons,
      clickCount: event.detail || 1,
      modifiers: modifierBits(event),
    });
    if (element.hasPointerCapture?.(event.pointerId)) {
      element.releasePointerCapture?.(event.pointerId);
    }
    event.preventDefault();
  };
  element.addEventListener('pointerup', pointerUp);
  element.addEventListener('pointercancel', pointerUp);
  element.addEventListener(
    'wheel',
    (event) => {
      const coordinates = point(event);
      send({
        type: 'wheel',
        ...coordinates,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        modifiers: modifierBits(event),
      });
      event.preventDefault();
    },
    { passive: false },
  );
  element.addEventListener('contextmenu', (event) => event.preventDefault());
  element.addEventListener('focus', () => send({ type: 'focus', focused: true }));
  element.addEventListener('blur', () => send({ type: 'focus', focused: false }));
  element.addEventListener('keydown', (event) => {
    const conversationId = element.getAttribute(CONVERSATION_ATTRIBUTE);
    const browserTabId = element.getAttribute(TAB_ATTRIBUTE);
    if (
      conversationId !== null &&
      browserTabId !== null &&
      handleOfficialShortcut(event, conversationId, browserTabId, sendOfficialMessage)
    ) {
      return;
    }
    send({
      type: 'key',
      event: 'down',
      key: event.key,
      code: event.code,
      text: event.key.length === 1 ? event.key : undefined,
      repeat: event.repeat,
      modifiers: modifierBits(event),
    });
    event.preventDefault();
  });
  element.addEventListener('keyup', (event) => {
    send({
      type: 'key',
      event: 'up',
      key: event.key,
      code: event.code,
      modifiers: modifierBits(event),
    });
    event.preventDefault();
  });
  element.addEventListener('paste', (event) => {
    const text = event.clipboardData?.getData('text/plain');
    if (text === undefined) return;
    send({ type: 'insert-text', text });
    event.preventDefault();
  });
  element.addEventListener('compositionend', (event) => {
    if (event.data.length > 0) send({ type: 'insert-text', text: event.data });
  });
}

function handleOfficialShortcut(
  event: KeyboardEvent,
  conversationId: string,
  browserTabId: string,
  sendOfficialMessage: SendOfficialMessage,
): boolean {
  const commandModifier = event.metaKey || event.ctrlKey;
  let command: Record<string, unknown> | null = null;
  if (commandModifier && event.key.toLowerCase() === 'l') command = { type: 'focus-address' };
  else if (commandModifier && event.key.toLowerCase() === 'f') command = { type: 'open-find' };
  else if (commandModifier && event.key.toLowerCase() === 'r') command = { type: 'reload' };
  else if (event.altKey && event.key === 'ArrowLeft') command = { type: 'go-back' };
  else if (event.altKey && event.key === 'ArrowRight') command = { type: 'go-forward' };
  if (command === null) return false;
  event.preventDefault();
  event.stopPropagation();
  const message = {
    type: 'browser-sidebar-command',
    conversationId,
    browserTabId,
    command,
  };
  if (command.type === 'focus-address' || command.type === 'open-find') {
    dispatchOfficialViewMessage(message);
  } else {
    void sendOfficialMessage(message);
  }
  return true;
}

async function paintFrame(state: RemoteWebviewState, base64: string): Promise<void> {
  const response = await fetch(`data:image/jpeg;base64,${base64}`);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  try {
    if (state.canvas.width !== bitmap.width) state.canvas.width = bitmap.width;
    if (state.canvas.height !== bitmap.height) state.canvas.height = bitmap.height;
    state.context.drawImage(bitmap, 0, 0);
  } finally {
    bitmap.close();
  }
}

async function copyImageToClipboard(message: BrowserSurfaceCopyImage): Promise<void> {
  try {
    const response = await fetch(`data:${message.mimeType};base64,${message.data}`);
    const blob = await response.blob();
    await navigator.clipboard.write([new ClipboardItem({ [message.mimeType]: blob })]);
    dispatchOfficialViewMessage({
      type: 'browser-sidebar-screenshot-copied',
      conversationId: message.conversationId,
      browserTabId: message.browserTabId,
    });
  } catch {
    dispatchOfficialViewMessage({
      type: 'browser-sidebar-screenshot-copy-failed',
      conversationId: message.conversationId,
      browserTabId: message.browserTabId,
    });
  }
}

function dispatchOfficialViewMessage(message: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data: message }));
}

function pointerButton(button: number): 'left' | 'middle' | 'right' | 'none' {
  switch (button) {
    case 0:
      return 'left';
    case 1:
      return 'middle';
    case 2:
      return 'right';
    default:
      return 'none';
  }
}

function modifierBits(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}
