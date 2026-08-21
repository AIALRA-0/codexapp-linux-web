import { chromium } from 'playwright-core';

const baseUrl = process.env.SMOKE_BASE_URL;
const browserExecutable = process.env.BROWSER_EXECUTABLE;
const initialPath = process.env.SMOKE_INITIAL_PATH;
const expectedText = process.env.SMOKE_EXPECTED_TEXT;
const expectedRendererVersion = process.env.SMOKE_RENDERER_VERSION;
const attempts = Number(process.env.SMOKE_ATTEMPTS ?? '3');

if (
  baseUrl === undefined ||
  browserExecutable === undefined ||
  initialPath === undefined ||
  expectedText === undefined ||
  expectedRendererVersion === undefined
) {
  throw new Error(
    'SMOKE_BASE_URL, BROWSER_EXECUTABLE, SMOKE_INITIAL_PATH, SMOKE_EXPECTED_TEXT, and SMOKE_RENDERER_VERSION are required',
  );
}
if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
  throw new Error('SMOKE_ATTEMPTS must be an integer from 1 through 10');
}

const browser = await chromium.launch({
  executablePath: browserExecutable,
  headless: true,
  args: ['--disable-background-networking', '--disable-sync', '--no-sandbox'],
});
const results = [];

try {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const startedAtMs = Date.now();
    const first = await createViewer('first');
    await first.open();
    const firstVisibleAtMs = Date.now();
    const second = await createViewer('second');
    await second.open();
    const secondVisibleAtMs = Date.now();
    await Promise.all([first.page.waitForTimeout(3_000), second.page.waitForTimeout(3_000)]);
    await Promise.all([first.assertHealthy(), second.assertHealthy()]);
    results.push({
      attempt,
      firstVisibleMs: firstVisibleAtMs - startedAtMs,
      secondVisibleMs: secondVisibleAtMs - firstVisibleAtMs,
      totalMs: Date.now() - startedAtMs,
      firstBridgeReady: first.bridgeReady(),
      secondBridgeReady: second.bridgeReady(),
      firstErrors: first.errors(),
      secondErrors: second.errors(),
    });
    await Promise.all([first.close(), second.close()]);
  }
} finally {
  await browser.close();
}

process.stdout.write(`${JSON.stringify({ ok: true, attempts, results })}\n`);

async function createViewer(label) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  let bridgeReady = false;
  page.on('pageerror', (error) => errors.push(`${label}: page error: ${error.message}`));
  page.on('response', (response) => {
    if (response.url().startsWith(baseUrl) && response.status() >= 400) {
      errors.push(
        `${label}: HTTP ${String(response.status())} ${new URL(response.url()).pathname}`,
      );
    }
  });
  page.on('websocket', (socket) => {
    if (!socket.url().endsWith('/api/bridge')) return;
    socket.on('framereceived', (event) => {
      const frame =
        typeof event.payload === 'string'
          ? event.payload
          : Buffer.from(event.payload).toString('utf8');
      if (frame.includes('"type":"ready"')) bridgeReady = true;
    });
  });

  return {
    page,
    bridgeReady: () => bridgeReady,
    errors: () => [...errors],
    async open() {
      const response = await page.goto(new URL(initialPath, baseUrl).toString(), {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      });
      if (response === null || !response.ok()) {
        throw new Error(`${label} viewer navigation failed: ${String(response?.status())}`);
      }
      await page.waitForFunction(
        (version) =>
          window.__CODEX_BROWSER_BOOTSTRAP__?.rendererVersion === version &&
          document.body.childElementCount > 0,
        expectedRendererVersion,
        { timeout: 120_000 },
      );
      await page.waitForFunction((text) => document.body.innerText.includes(text), expectedText, {
        timeout: 120_000,
      });
      await page.waitForFunction(() => document.body.innerText.trim().length > 0, undefined, {
        timeout: 30_000,
      });
    },
    async assertHealthy() {
      const state = await page.evaluate((text) => {
        const bodyText = document.body.innerText;
        return {
          expectedTextVisible: bodyText.includes(text),
          conflictVisible:
            /already has an active writer|conversation opened in another app|另一个应用.*打开|已有.*写入/u.test(
              bodyText,
            ),
          bodyTextLength: bodyText.length,
        };
      }, expectedText);
      if (!state.expectedTextVisible || state.conflictVisible || state.bodyTextLength < 100) {
        throw new Error(`${label} viewer became unhealthy: ${JSON.stringify(state)}`);
      }
      if (!bridgeReady) throw new Error(`${label} viewer bridge never became ready`);
      if (errors.length > 0)
        throw new Error(`${label} viewer emitted errors: ${JSON.stringify(errors)}`);
    },
    async close() {
      await context.close();
    },
  };
}
