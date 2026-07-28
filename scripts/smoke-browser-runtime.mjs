import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OfficialBrowserRuntime } from '../packages/host-gateway/dist/browser-runtime.js';

const executablePath = process.env.BROWSER_EXECUTABLE;
if (executablePath === undefined || executablePath.length === 0) {
  throw new Error('BROWSER_EXECUTABLE is required');
}
const officialSourceRoot =
  process.env.OFFICIAL_SOURCE_ROOT ??
  join(process.cwd(), '.official', 'releases', '26.721.31836', 'source');

const temporaryRoot = await mkdtemp(join(tmpdir(), 'codex-browser-smoke-'));
const viewMessages = [];
const surfaceMessages = [];
const downloads = [];
const errors = [];
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/download') {
    response.writeHead(200, {
      'content-disposition': 'attachment; filename="proof.txt"',
      'content-type': 'text/plain; charset=utf-8',
    });
    response.end('official-browser-download-proof\n');
    return;
  }
  const submitted = url.searchParams.get('q');
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html>
    <meta charset="utf-8">
    <title>${submitted === null ? 'Browser smoke' : `Submitted ${submitted}`}</title>
    <form method="get">
      <label>Smoke input <input name="q" autofocus></label>
    </form>
    <a href="/download">Download proof</a>`);
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
if (address === null || typeof address === 'string')
  throw new Error('smoke server address missing');
const origin = `http://127.0.0.1:${String(address.port)}`;

const runtime = new OfficialBrowserRuntime({
  root: temporaryRoot,
  executablePath,
  commentPreloadPath: join(officialSourceRoot, '.vite', 'build', 'comment-preload.js'),
  emitViewMessage: (message) => viewMessages.push(message),
  registerDownload: (path, fileName, browserSessionId) => {
    downloads.push({ path, fileName, browserSessionId });
    return 'browser-smoke-download-token';
  },
  onError: (error, context) => errors.push({ message: error.message, context }),
});

let surface;
try {
  await runtime.start();
  const registration = runtime.registerRendererSession('smoke-session', 'smoke-renderer');
  if (!registration) throw new Error('renderer registration failed');
  const hostRegistered = await runtime.registerWebviewHost('smoke-session', {
    browserTabId: 'smoke-tab',
    conversationId: 'smoke-thread',
    hostGeneration: 1,
    pagePersistence: {
      browserStorageId: 'browser:smoke-storage',
      restore: 'none',
    },
    rendererInstanceId: 'smoke-renderer',
  });
  if (!hostRegistered) throw new Error('webview host registration failed');

  surface = await runtime.attachSurface('smoke-session', 'smoke-thread', 'smoke-tab', (message) =>
    surfaceMessages.push(message),
  );
  await runtime.handleRendererMessage('smoke-session', {
    type: 'browser-sidebar-command',
    browserTabId: 'smoke-tab',
    conversationId: 'smoke-thread',
    command: { type: 'navigate', url: origin },
  });
  await waitFor(() => surfaceMessages.some((message) => message.type === 'frame'));

  surface.receive({ type: 'focus', focused: true });
  surface.receive({ type: 'insert-text', text: 'typed-on-vps' });
  surface.receive({
    type: 'key',
    event: 'down',
    key: 'Enter',
    code: 'Enter',
    text: '\r',
  });
  surface.receive({
    type: 'key',
    event: 'up',
    key: 'Enter',
    code: 'Enter',
  });
  await waitFor(() =>
    viewMessages.some(
      (message) =>
        message.type === 'browser-sidebar-state' &&
        typeof message.snapshot?.url === 'string' &&
        message.snapshot.url.includes('q=typed-on-vps'),
    ),
  );

  await runtime.handleRendererMessage('smoke-session', {
    type: 'browser-sidebar-command',
    browserTabId: 'smoke-tab',
    conversationId: 'smoke-thread',
    command: { type: 'set-interaction-mode', interactionMode: 'comment' },
  });
  await runtime.handleRendererMessage('smoke-session', {
    type: 'browser-sidebar-runtime-create-comment-at-point',
    browserTabId: 'smoke-tab',
    conversationId: 'smoke-thread',
    viewportPoint: { x: 120, y: 30 },
  });
  await waitFor(() =>
    viewMessages.some(
      (message) =>
        message.type === 'browser-sidebar-comment-overlay-session' && message.visible === true,
    ),
  );
  const overlay = viewMessages.findLast(
    (message) =>
      message.type === 'browser-sidebar-comment-overlay-session' && message.visible === true,
  );
  if (overlay === undefined) throw new Error('official annotation overlay did not open');
  await runtime.handleRendererMessage('smoke-session', {
    type: 'browser-sidebar-comment-overlay-submit',
    browserTabId: 'smoke-tab',
    conversationId: 'smoke-thread',
    sessionId: overlay.session.sessionId,
    body: 'official annotation proof',
    submitDirectly: true,
    captureScreenshot: false,
  });
  await waitFor(() =>
    viewMessages.some((message) => message.type === 'browser-sidebar-direct-comment'),
  );
  const directComment = viewMessages.findLast(
    (message) => message.type === 'browser-sidebar-direct-comment',
  );
  if (
    directComment?.body !== 'official annotation proof' ||
    directComment.comment?.origin !== 'browser'
  ) {
    throw new Error('official annotation was not serialized for the composer');
  }

  await runtime.handleRendererMessage('smoke-session', {
    type: 'browser-sidebar-command',
    browserTabId: 'smoke-tab',
    conversationId: 'smoke-thread',
    command: { type: 'capture-screenshot' },
  });
  const screenshot = surfaceMessages.find((message) => message.type === 'copy-image');
  if (screenshot === undefined || screenshot.data.length < 100) {
    throw new Error('browser screenshot was not delivered');
  }

  await runtime.handleRendererMessage('smoke-session', {
    type: 'browser-sidebar-command',
    browserTabId: 'smoke-tab',
    conversationId: 'smoke-thread',
    command: { type: 'navigate', url: `${origin}/download` },
  });
  await waitFor(() => downloads.length === 1);
  const download = downloads[0];
  if (download === undefined) throw new Error('browser download was not registered');
  const downloadBody = await readFile(download.path, 'utf8');
  if (download.fileName !== 'proof.txt' || downloadBody !== 'official-browser-download-proof\n') {
    throw new Error('browser download content mismatch');
  }
  if (errors.length > 0)
    throw new Error(`browser runtime reported errors: ${JSON.stringify(errors)}`);

  const frame = surfaceMessages.find((message) => message.type === 'frame');
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      chrome: executablePath,
      rendererRegistration: registration,
      webviewRegistration: hostRegistered,
      frameBytes: frame?.data.length ?? 0,
      screenshotBytes: screenshot.data.length,
      typedNavigation: true,
      officialAnnotation: true,
      download: download.fileName,
    })}\n`,
  );
} finally {
  surface?.close();
  await runtime.stop().catch(() => undefined);
  await new Promise((resolve) => server.close(resolve));
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function waitFor(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out after ${String(timeoutMs)}ms`);
}
