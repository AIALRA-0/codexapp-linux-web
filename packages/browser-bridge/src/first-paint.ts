import type { RuntimeBootstrap } from '@codexapp/contracts';

const FIRST_PAINT_ID = '__codex-atomic-first-paint';
const RENDER_STABILITY_MS = 600;
const SLOW_LOAD_NOTICE_MS = 8_000;
const VERY_SLOW_LOAD_NOTICE_MS = 45_000;

interface RendererRequest {
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

interface RendererViewMessage {
  message?: unknown;
  request?: RendererRequest;
  type?: unknown;
}

interface PendingResume {
  threadId: string;
}

interface AtomicFirstPaintCoordinator {
  markTransportReady(): void;
  observeRendererRequest(message: unknown): void;
  observeRendererMessage(message: unknown): void;
  fail(reason: string): void;
}

export function installAtomicFirstPaint(bootstrap: RuntimeBootstrap): AtomicFirstPaintCoordinator {
  const overlay = createOverlay();
  const status = overlay.querySelector<HTMLElement>('[data-codex-first-paint-status]');
  const retry = overlay.querySelector<HTMLButtonElement>('[data-codex-first-paint-retry]');
  const startedAtMs = performance.now();
  const pendingResumes = new Map<string | number, PendingResume>();
  const projectNames = initialProjectNames(bootstrap.initialSidebarBootstrap);
  let targetThreadId = threadIdFromInitialLocation();
  let transportReady = false;
  let resumeCompleted = targetThreadId === null;
  let resumeReturnedTurns = false;
  let failed = false;
  let readyConditionsStartedAtMs: number | null = null;
  let lastLocation = window.location.href;
  let released = false;
  let releaseScheduled = false;

  const setPhase = (phase: string, label: string): void => {
    overlay.dataset.phase = phase;
    if (status !== null) status.textContent = label;
  };

  const routeChanged = (): void => {
    if (lastLocation === window.location.href) return;
    lastLocation = window.location.href;
    const nextThreadId = threadIdFromInitialLocation();
    if (nextThreadId === targetThreadId) return;
    targetThreadId = nextThreadId;
    resumeCompleted = nextThreadId === null;
    resumeReturnedTurns = false;
    readyConditionsStartedAtMs = null;
    if (nextThreadId !== null) setPhase('conversation', '正在加载当前对话…');
  };

  const releaseIfReady = (): void => {
    if (released || failed) return;
    routeChanged();
    if (!transportReady || !officialRendererMounted()) {
      readyConditionsStartedAtMs = null;
      return;
    }
    if (!standaloneFullScreenViewVisible() && !initialProjectsVisible(projectNames)) {
      readyConditionsStartedAtMs = null;
      return;
    }
    if (targetThreadId !== null) {
      if (!resumeCompleted || !composerVisible()) {
        readyConditionsStartedAtMs = null;
        return;
      }
      if (resumeReturnedTurns && !conversationContentVisible()) {
        readyConditionsStartedAtMs = null;
        return;
      }
    }
    readyConditionsStartedAtMs ??= performance.now();
    if (performance.now() - readyConditionsStartedAtMs < RENDER_STABILITY_MS) return;
    if (releaseScheduled) return;
    releaseScheduled = true;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (released || failed) return;
        released = true;
        const detail = {
          durationMs: Math.round(performance.now() - startedAtMs),
          routeKind: targetThreadId === null ? 'shell' : 'thread',
        };
        window.dispatchEvent(new CustomEvent('codex:first-paint-ready', { detail }));
        overlay.remove();
        window.clearInterval(readinessTimer);
        window.clearTimeout(slowTimer);
        window.clearTimeout(verySlowTimer);
      });
    });
  };

  document.body.append(overlay);
  setPhase('bootstrap', '正在加载 Codex…');

  const readinessTimer = window.setInterval(releaseIfReady, 100);
  const slowTimer = window.setTimeout(() => {
    if (!released && !failed) {
      setPhase(
        overlay.dataset.phase ?? 'loading',
        targetThreadId === null ? '正在同步项目和任务…' : '正在读取当前对话，请稍候…',
      );
    }
  }, SLOW_LOAD_NOTICE_MS);
  const verySlowTimer = window.setTimeout(() => {
    if (!released && !failed) {
      setPhase('slow', '加载时间超过预期，服务器仍在处理；对话没有消失');
    }
  }, VERY_SLOW_LOAD_NOTICE_MS);

  retry?.addEventListener('click', () => window.location.reload());

  return {
    markTransportReady() {
      transportReady = true;
      setPhase(
        targetThreadId === null ? 'projects' : 'conversation',
        targetThreadId === null ? '正在同步项目和任务…' : '正在加载当前对话…',
      );
      releaseIfReady();
    },
    observeRendererRequest(message) {
      const value = recordOrNull(message) as RendererViewMessage | null;
      const request = value?.type === 'mcp-request' ? value.request : undefined;
      if (request?.method !== 'thread/resume') return;
      const params = recordOrNull(request.params);
      const threadId = typeof params?.threadId === 'string' ? params.threadId : null;
      if (threadId === null || (typeof request.id !== 'string' && typeof request.id !== 'number')) {
        return;
      }
      pendingResumes.set(request.id, { threadId });
      if (targetThreadId === null || targetThreadId === threadId) {
        targetThreadId = threadId;
        resumeCompleted = false;
        resumeReturnedTurns = false;
        readyConditionsStartedAtMs = null;
        setPhase('conversation', '正在加载当前对话…');
      }
    },
    observeRendererMessage(message) {
      const value = recordOrNull(message) as RendererViewMessage | null;
      if (value?.type !== 'mcp-response') return;
      const response = recordOrNull(value.message);
      const id = response?.id;
      if (typeof id !== 'string' && typeof id !== 'number') return;
      const pending = pendingResumes.get(id);
      if (pending === undefined) return;
      pendingResumes.delete(id);
      if (pending.threadId !== targetThreadId) return;
      if (response?.error !== undefined) {
        this.fail('当前对话加载失败');
        return;
      }
      resumeReturnedTurns = resumeResponseContainsTurns(response?.result);
      resumeCompleted = true;
      readyConditionsStartedAtMs = null;
      setPhase('render', '正在完成页面渲染…');
    },
    fail(reason) {
      if (released || failed) return;
      failed = true;
      setPhase('error', `${reason}，请重试`);
      if (retry !== null) retry.hidden = false;
      window.clearInterval(readinessTimer);
      window.clearTimeout(slowTimer);
      window.clearTimeout(verySlowTimer);
    },
  };
}

export function threadIdFromInitialLocation(
  pathname = window.location.pathname,
  initialRoute = document.querySelector<HTMLMetaElement>('meta[name="initial-route"]')?.content,
): string | null {
  for (const route of [initialRoute, pathname]) {
    if (route === undefined) continue;
    const match = /^\/local\/([0-9a-f-]{36})(?:[/?#]|$)/iu.exec(route);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

export function resumeResponseContainsTurns(result: unknown): boolean {
  const response = recordOrNull(result);
  const initialPage = recordOrNull(response?.initialTurnsPage);
  if (Array.isArray(initialPage?.data) && initialPage.data.length > 0) return true;
  const thread = recordOrNull(response?.thread);
  return Array.isArray(thread?.turns) && thread.turns.length > 0;
}

export function initialProjectNames(sidebarBootstrap: unknown): string[] {
  const bootstrap = recordOrNull(sidebarBootstrap);
  const entries = Array.isArray(bootstrap?.globalStateEntries) ? bootstrap.globalStateEntries : [];
  const localProjectsEntry = entries
    .map(recordOrNull)
    .find((entry) => entry?.key === 'local-projects');
  const projects = recordOrNull(localProjectsEntry?.value) ?? {};
  return Object.values(projects)
    .map(recordOrNull)
    .map((project) => project?.name)
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
}

function createOverlay(): HTMLElement {
  const overlay = document.createElement('div');
  overlay.id = FIRST_PAINT_ID;
  overlay.setAttribute('aria-live', 'polite');
  overlay.setAttribute('aria-busy', 'true');
  Object.assign(overlay.style, {
    alignItems: 'center',
    background: 'Canvas',
    color: 'CanvasText',
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    inset: '0',
    justifyContent: 'center',
    position: 'fixed',
    zIndex: '2147483647',
  });
  const officialLogo = document.querySelector<HTMLElement>('.startup-loader__logo');
  if (officialLogo !== null) overlay.append(officialLogo.cloneNode(true));
  const status = document.createElement('div');
  status.dataset.codexFirstPaintStatus = 'true';
  Object.assign(status.style, {
    font: '13px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    opacity: '0.68',
  });
  overlay.append(status);
  const retry = document.createElement('button');
  retry.dataset.codexFirstPaintRetry = 'true';
  retry.hidden = true;
  retry.type = 'button';
  retry.textContent = '重新加载';
  Object.assign(retry.style, {
    background: 'CanvasText',
    border: '0',
    borderRadius: '999px',
    color: 'Canvas',
    cursor: 'pointer',
    font: '13px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    padding: '8px 14px',
  });
  overlay.append(retry);
  return overlay;
}

function officialRendererMounted(): boolean {
  const root = document.querySelector<HTMLElement>('#root');
  if (root === null) return false;

  const startupLoader = root.querySelector<HTMLElement>('.startup-loader');
  const startupLoaderVisible = startupLoader !== null && isVisible(startupLoader);
  const visibleControl = Array.from(
    root.querySelectorAll<HTMLElement>(
      'button, input, textarea, select, [contenteditable="true"], [role="button"], a[href]',
    ),
  ).some(isVisible);
  const meaningfulText = normalizedText(root.innerText).length >= 20;

  // A retained startup-loader is only safe once the renderer has also produced
  // a real interactive recovery view.  Otherwise wait for visible application
  // content instead of relying on an arbitrary DOM-node count.
  if (startupLoaderVisible) return visibleControl && meaningfulText;
  return visibleControl || meaningfulText;
}

function standaloneFullScreenViewVisible(): boolean {
  const root = document.querySelector<HTMLElement>('#root');
  if (root === null) return false;
  return Array.from(root.children).some((child) => {
    if (!(child instanceof HTMLElement) || !isVisible(child)) return false;
    const rectangle = child.getBoundingClientRect();
    const style = getComputedStyle(child);
    return (
      style.position === 'fixed' &&
      rectangle.width >= window.innerWidth * 0.9 &&
      rectangle.height >= window.innerHeight * 0.9
    );
  });
}

function initialProjectsVisible(projectNames: string[]): boolean {
  if (projectNames.length === 0) return true;
  const text = normalizedText(document.body.innerText);
  return projectNames.every((name) => text.includes(normalizedText(name)));
}

function composerVisible(): boolean {
  return Array.from(
    document.querySelectorAll<HTMLElement>('textarea, [contenteditable="true"]'),
  ).some(isVisible);
}

function conversationContentVisible(): boolean {
  const root = document.querySelector<HTMLElement>('#root');
  if (root === null) return false;
  const text = normalizedText(root.innerText);
  return text.length >= 160 && Array.from(root.querySelectorAll<HTMLElement>('*')).some(isVisible);
}

function isVisible(element: HTMLElement): boolean {
  const rectangle = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return (
    rectangle.width > 0 &&
    rectangle.height > 0 &&
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    style.opacity !== '0'
  );
}

function normalizedText(value: string): string {
  return value.replaceAll(/\s+/gu, ' ').trim();
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
