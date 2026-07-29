import { chromium } from 'playwright-core';
import sharp from 'sharp';

const baseUrl = process.env.SMOKE_BASE_URL;
const browserExecutable = process.env.BROWSER_EXECUTABLE;
const proxySecret = process.env.SMOKE_PROXY_SECRET;
const screenshotPath = process.env.SMOKE_SCREENSHOT_PATH;
const expectedRendererVersion = process.env.SMOKE_RENDERER_VERSION ?? '26.721.31836';
if (baseUrl === undefined || browserExecutable === undefined) {
  throw new Error('SMOKE_BASE_URL and BROWSER_EXECUTABLE are required');
}

const browser = await chromium.launch({
  executablePath: browserExecutable,
  headless: true,
  args: ['--disable-background-networking', '--disable-sync', '--no-sandbox'],
});
const context = await browser.newContext({
  extraHTTPHeaders: {
    'X-Aialra-Authenticated': '1',
    ...(proxySecret === undefined ? {} : { 'X-Aialra-Proxy-Secret': proxySecret }),
    'X-Aialra-Sub': 'official-ui-smoke-subject',
    'X-Aialra-User': 'official-ui-smoke',
    'X-Aialra-Email': 'official-ui-smoke@example.invalid',
    'X-Aialra-Groups': 'aialra:access:codexapp,aialra:role:developer',
  },
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
const pageErrors = [];
const failedLocalRequests = [];
let bridgeConnected = false;
let bridgeReady = false;

page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('response', (response) => {
  if (response.url().startsWith(baseUrl) && response.status() >= 400) {
    failedLocalRequests.push({ status: response.status(), url: response.url() });
  }
});
page.on('websocket', (socket) => {
  if (!socket.url().endsWith('/api/bridge')) return;
  bridgeConnected = true;
  socket.on('framereceived', (event) => {
    const value =
      typeof event.payload === 'string'
        ? event.payload
        : Buffer.from(event.payload).toString('utf8');
    if (value.includes('"type":"ready"')) bridgeReady = true;
  });
});

try {
  const response = await page.goto(baseUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 45_000,
  });
  if (response === null || !response.ok()) {
    throw new Error(`official renderer navigation failed: ${String(response?.status())}`);
  }
  await page.waitForFunction(
    (version) =>
      window.__CODEX_BROWSER_BOOTSTRAP__?.rendererVersion === version &&
      document.body.childElementCount > 0,
    expectedRendererVersion,
    { timeout: 30_000 },
  );
  await waitFor(() => bridgeReady, 30_000);
  await page.waitForFunction(
    () => {
      const root = document.querySelector('#root');
      if (root === null || document.body.innerText.trim().length === 0) return false;
      return Array.from(root.querySelectorAll('*')).some((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0'
        );
      });
    },
    { timeout: 30_000 },
  );

  const renderer = await page.evaluate(() => ({
    bootstrapVersion: window.__CODEX_BROWSER_BOOTSTRAP__?.rendererVersion,
    bodyTextLength: document.body.innerText.length,
    elementCount: document.querySelectorAll('*').length,
    rootHtmlLength:
      document.querySelector('#root')?.innerHTML.length ??
      document.querySelector('[data-reactroot]')?.innerHTML.length ??
      0,
    hasOfficialRoot: document.querySelector('#root') !== null,
    bodyStyle: {
      backgroundColor: getComputedStyle(document.body).backgroundColor,
      color: getComputedStyle(document.body).color,
      display: getComputedStyle(document.body).display,
      opacity: getComputedStyle(document.body).opacity,
      visibility: getComputedStyle(document.body).visibility,
    },
    rootPreview: (document.querySelector('#root')?.innerHTML ?? '').slice(0, 2_000),
    visibleElements: Array.from(document.querySelectorAll('body *'))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          className: String(element.className).slice(0, 120),
          height: Math.round(rect.height),
          opacity: style.opacity,
          tagName: element.tagName,
          text: (element.textContent ?? '').trim().slice(0, 120),
          visibility: style.visibility,
          width: Math.round(rect.width),
        };
      })
      .filter(
        (element) =>
          element.width > 0 &&
          element.height > 0 &&
          element.visibility !== 'hidden' &&
          element.opacity !== '0',
      )
      .slice(0, 30),
  }));
  if (
    renderer.bootstrapVersion !== expectedRendererVersion ||
    !renderer.hasOfficialRoot ||
    renderer.elementCount < 25 ||
    renderer.rootHtmlLength < 10
  ) {
    throw new Error(`official renderer did not mount: ${JSON.stringify(renderer)}`);
  }
  if (pageErrors.length > 0 || failedLocalRequests.length > 0) {
    throw new Error(
      `official renderer emitted errors: ${JSON.stringify({ pageErrors, failedLocalRequests })}`,
    );
  }
  const screenshot = await page.screenshot({
    ...(screenshotPath === undefined ? {} : { path: screenshotPath }),
    type: 'png',
  });
  const screenshotStats = await sharp(screenshot).stats();
  const maximumChannelDeviation = Math.max(
    ...screenshotStats.channels.map((channel) => channel.stdev),
  );
  if (screenshot.length < 1_000 || maximumChannelDeviation < 1) {
    throw new Error(
      `official renderer screenshot was visually blank: ${JSON.stringify({
        bytes: screenshot.length,
        maximumChannelDeviation,
        renderer,
      })}`,
    );
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      rendererVersion: renderer.bootstrapVersion,
      bridgeConnected,
      bridgeReady,
      elementCount: renderer.elementCount,
      bodyTextLength: renderer.bodyTextLength,
      screenshotBytes: screenshot.length,
      screenshotMaximumChannelDeviation: Math.round(maximumChannelDeviation * 100) / 100,
      localAssetFailures: failedLocalRequests.length,
      pageErrors: pageErrors.length,
    })}\n`,
  );
} finally {
  await context.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out after ${String(timeoutMs)}ms`);
}
