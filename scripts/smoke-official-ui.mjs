import { chromium } from 'playwright-core';
import sharp from 'sharp';

const baseUrl = process.env.SMOKE_BASE_URL;
const browserExecutable = process.env.BROWSER_EXECUTABLE;
const proxySecret = process.env.SMOKE_PROXY_SECRET;
const proxySecretHeader = process.env.SMOKE_PROXY_SECRET_HEADER ?? 'X-Aialra-Proxy-Secret';
const screenshotPath = process.env.SMOKE_SCREENSHOT_PATH;
const initialPath = process.env.SMOKE_INITIAL_PATH ?? '/';
const expectedText = optionalEnvironmentValue('SMOKE_EXPECTED_TEXT');
const expectedConversationText = optionalEnvironmentValue('SMOKE_EXPECTED_CONVERSATION_TEXT');
const olderConversationText = optionalEnvironmentValue('SMOKE_OLDER_CONVERSATION_TEXT');
const clickText = optionalEnvironmentValue('SMOKE_CLICK_TEXT');
const afterClickText = optionalEnvironmentValue('SMOKE_AFTER_CLICK_TEXT');
const expectedLocale = optionalEnvironmentValue('SMOKE_EXPECTED_LOCALE');
const waitForTextGone = optionalEnvironmentValue('SMOKE_WAIT_FOR_TEXT_GONE');
const postAssertWaitMs = Number(process.env.SMOKE_POST_ASSERT_WAIT_MS ?? '0');
const contentTimeoutMs = Number(process.env.SMOKE_CONTENT_TIMEOUT_MS ?? '120000');
const olderHistoryTimeoutMs = Number(process.env.SMOKE_OLDER_HISTORY_TIMEOUT_MS ?? '180000');
const smokeSubject = process.env.SMOKE_SUBJECT ?? 'official-ui-smoke-subject';
const smokeUsername = process.env.SMOKE_USERNAME ?? 'official-ui-smoke';
const smokeEmail = process.env.SMOKE_EMAIL ?? 'official-ui-smoke@example.invalid';
const expectedRendererVersion = process.env.SMOKE_RENDERER_VERSION ?? '26.730.61639';
const smokeAttempt = Number(process.env.SMOKE_ATTEMPT ?? '1');
const inspectSettingsMenu = process.env.SMOKE_INSPECT_SETTINGS_MENU ?? '';
const switchLocaleLabel = optionalEnvironmentValue('SMOKE_SWITCH_LOCALE_LABEL');
const switchLocaleExpected = optionalEnvironmentValue('SMOKE_SWITCH_LOCALE_EXPECTED');
const switchLocaleSequence = parseLocaleSwitchSequence(
  optionalEnvironmentValue('SMOKE_SWITCH_LOCALES_JSON'),
  switchLocaleLabel,
  switchLocaleExpected,
);
const verifyLocaleAfterReload = process.env.SMOKE_VERIFY_LOCALE_AFTER_RELOAD === '1';
const requireCompressedMainAsset = process.env.SMOKE_REQUIRE_COMPRESSED_MAIN_ASSET === '1';
const reloadCount = Number(process.env.SMOKE_RELOAD_COUNT ?? '0');
if (baseUrl === undefined || browserExecutable === undefined) {
  throw new Error('SMOKE_BASE_URL and BROWSER_EXECUTABLE are required');
}
if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(proxySecretHeader)) {
  throw new Error('SMOKE_PROXY_SECRET_HEADER must be a valid HTTP header name');
}
if (!Number.isInteger(reloadCount) || reloadCount < 0 || reloadCount > 10) {
  throw new Error('SMOKE_RELOAD_COUNT must be an integer from 0 through 10');
}

const browser = await chromium.launch({
  executablePath: browserExecutable,
  headless: true,
  args: ['--disable-background-networking', '--disable-sync', '--no-sandbox'],
});
const context = await browser.newContext({
  extraHTTPHeaders: {
    'X-Aialra-Authenticated': '1',
    ...(proxySecret === undefined ? {} : { [proxySecretHeader]: proxySecret }),
    'X-Aialra-Sub': smokeSubject,
    'X-Aialra-User': smokeUsername,
    'X-Aialra-Email': smokeEmail,
    'X-Aialra-Groups': 'aialra:access:codexapp,aialra:role:developer',
  },
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
const pageErrors = [];
const failedLocalRequests = [];
const loadedLocaleAssets = [];
let mainAssetEncoding;
let mainAssetTransferBytes;
let bridgeConnected = false;
let bridgeReady = false;
let clickedHref;
const startedAtMs = Date.now();
let domContentLoadedAtMs;
let bridgeReadyAtMs;
let rendererMountedAtMs;
let expectedTextVisibleAtMs;
let clickTargetVisibleAtMs;
let clickedAtMs;
let afterClickTextVisibleAtMs;
let waitedTextGoneAtMs;
let settingsMenuInspection;
const reloadResults = [];
let olderTextVisibleAtMs;
let olderScrollAttempts = 0;

page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('response', (response) => {
  if (/\/assets\/app-initial-[^/]+\.js$/u.test(response.url())) {
    mainAssetEncoding = response.headers()['content-encoding'];
    const contentLength = Number(response.headers()['content-length']);
    mainAssetTransferBytes = Number.isFinite(contentLength) ? contentLength : undefined;
  }
  if (/\/assets\/[a-z]{2,3}(?:-[A-Z0-9]{2,4})*-?[^/]+\.js$/u.test(response.url())) {
    loadedLocaleAssets.push(response.url().split('/').pop());
  }
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
    if (value.includes('"type":"ready"') && bridgeReadyAtMs === undefined) {
      bridgeReadyAtMs = Date.now();
    }
  });
});

try {
  const response = await page.goto(new URL(initialPath, baseUrl).toString(), {
    waitUntil: 'domcontentloaded',
    timeout: 45_000,
  });
  if (response === null || !response.ok()) {
    throw new Error(`official renderer navigation failed: ${String(response?.status())}`);
  }
  domContentLoadedAtMs = Date.now();
  reportProgress('dom-content-loaded');
  await page.waitForFunction(
    (version) =>
      window.__CODEX_BROWSER_BOOTSTRAP__?.rendererVersion === version &&
      document.body.childElementCount > 0,
    expectedRendererVersion,
    { timeout: 120_000 },
  );
  rendererMountedAtMs = Date.now();
  reportProgress('renderer-mounted');
  await waitFor(() => bridgeReady, 30_000);
  reportProgress('bridge-ready');
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
    undefined,
    { timeout: 120_000 },
  );
  reportProgress('visible-shell');
  if (expectedText !== undefined) {
    await page.waitForFunction((text) => document.body.innerText.includes(text), expectedText, {
      timeout: contentTimeoutMs,
    });
    expectedTextVisibleAtMs = Date.now();
    reportProgress('expected-text-visible');
  }
  if (expectedConversationText !== undefined) {
    await page.waitForFunction(
      (text) =>
        Array.from(document.querySelectorAll('body *')).some((element) => {
          if (!(element instanceof HTMLElement)) return false;
          const ownText = (element.innerText ?? '').trim();
          if (!ownText.includes(text)) return false;
          if (
            Array.from(element.children).some((child) => (child.textContent ?? '').includes(text))
          ) {
            return false;
          }
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            rect.left >= 275 &&
            rect.bottom > 100 &&
            rect.top < innerHeight &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0'
          );
        }),
      expectedConversationText,
      { timeout: contentTimeoutMs },
    );
    reportProgress('conversation-text-visible');
  }
  if (olderConversationText !== undefined) {
    const olderHistoryDeadline = Date.now() + olderHistoryTimeoutMs;
    while (Date.now() < olderHistoryDeadline) {
      const olderTextVisible = await page.evaluate(
        (text) =>
          Array.from(document.querySelectorAll('body *')).some((element) => {
            if (!(element instanceof HTMLElement)) return false;
            if (!(element.innerText ?? '').includes(text)) return false;
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              rect.left >= 275 &&
              rect.bottom > 100 &&
              rect.top < innerHeight &&
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              style.opacity !== '0'
            );
          }),
        olderConversationText,
      );
      if (olderTextVisible) {
        olderTextVisibleAtMs = Date.now();
        reportProgress('older-conversation-text-visible');
        break;
      }
      olderScrollAttempts += 1;
      await page.mouse.move(850, 420);
      await page.mouse.wheel(0, -1_200);
      await page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll('body *'))
          .filter((element) => {
            if (!(element instanceof HTMLElement)) return false;
            const style = getComputedStyle(element);
            return (
              element.scrollHeight > element.clientHeight + 100 &&
              (style.overflowY === 'auto' || style.overflowY === 'scroll')
            );
          })
          .sort(
            (left, right) =>
              right.scrollHeight - right.clientHeight - (left.scrollHeight - left.clientHeight),
          );
        const scroller = candidates[0];
        if (scroller instanceof HTMLElement && scroller.scrollTop > 0) {
          scroller.scrollTop = Math.max(
            0,
            scroller.scrollTop - Math.max(scroller.clientHeight, 800),
          );
          scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        }
      });
      await page.waitForTimeout(250);
    }
    if (olderTextVisibleAtMs === undefined) {
      throw new Error(
        `older conversation text did not load after ${String(olderScrollAttempts)} upward scroll attempts`,
      );
    }
  }

  if (expectedLocale !== undefined) {
    await page.waitForFunction(
      (locale) => document.documentElement.lang === locale,
      expectedLocale,
      { timeout: 30_000 },
    );
    await waitFor(
      () => loadedLocaleAssets.some((asset) => asset?.startsWith(`${expectedLocale}-`)),
      30_000,
    );
    reportProgress('locale-ready');
  }

  if (waitForTextGone !== undefined) {
    await page.waitForFunction((text) => !document.body.innerText.includes(text), waitForTextGone, {
      timeout: 180_000,
    });
    waitedTextGoneAtMs = Date.now();
    reportProgress('waited-text-gone');
  }
  if (Number.isFinite(postAssertWaitMs) && postAssertWaitMs > 0) {
    await page.waitForTimeout(Math.min(postAssertWaitMs, 180_000));
    reportProgress('post-assert-wait-completed');
  }
  for (let reloadAttempt = 1; reloadAttempt <= reloadCount; reloadAttempt += 1) {
    const reloadStartedAtMs = Date.now();
    bridgeReady = false;
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 });
    const reloadDomContentLoadedAtMs = Date.now();
    await page.waitForFunction(
      (version) =>
        window.__CODEX_BROWSER_BOOTSTRAP__?.rendererVersion === version &&
        document.body.childElementCount > 0,
      expectedRendererVersion,
      { timeout: 120_000 },
    );
    await waitFor(() => bridgeReady, 30_000);
    if (expectedText !== undefined) {
      await page.waitForFunction((text) => document.body.innerText.includes(text), expectedText, {
        timeout: contentTimeoutMs,
      });
    }
    if (expectedConversationText !== undefined) {
      await page.waitForFunction(
        (text) => document.body.innerText.includes(text),
        expectedConversationText,
        { timeout: contentTimeoutMs },
      );
    }
    const bodyText = await page.locator('body').innerText();
    const failureMarkers = [
      '当前对话加载失败',
      'Conversation opened in another app',
      'Conversation ouverte dans une autre application',
      '与服务器的连接已断开',
    ].filter((marker) => bodyText.includes(marker));
    if (failureMarkers.length > 0) {
      throw new Error(
        `official renderer failed after reload: ${JSON.stringify({ reloadAttempt, failureMarkers })}`,
      );
    }
    reloadResults.push({
      attempt: reloadAttempt,
      domContentLoadedMs: reloadDomContentLoadedAtMs - reloadStartedAtMs,
      contentVisibleMs: Date.now() - reloadStartedAtMs,
      bodyTextLength: bodyText.length,
      documentLocale: await page.evaluate(() => document.documentElement.lang),
    });
    reportProgress(`reload-${String(reloadAttempt)}-complete`);
  }

  const renderer = await page.evaluate(() => ({
    bootstrapVersion: window.__CODEX_BROWSER_BOOTSTRAP__?.rendererVersion,
    documentLocale: document.documentElement.lang,
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
    historySnapshotGate: (() => {
      const statsig = window.__STATSIG__;
      if (statsig === null || typeof statsig !== 'object') {
        return { available: false, type: typeof statsig };
      }
      const instances = statsig.instances;
      const clients = [
        statsig.firstInstance,
        ...(instances instanceof Map
          ? Array.from(instances.values())
          : instances !== null && typeof instances === 'object'
            ? Object.values(instances)
            : []),
      ].filter((client) => client !== null && typeof client === 'object');
      return {
        available: true,
        globalKeys: Reflect.ownKeys(statsig).map(String).sort(),
        instancesType: instances?.constructor?.name ?? typeof instances,
        clients: clients.map((client) => ({
          keys: Reflect.ownKeys(client).map(String).sort(),
          overrideKeys:
            client.overrideAdapter !== null && typeof client.overrideAdapter === 'object'
              ? Reflect.ownKeys(client.overrideAdapter).map(String).sort()
              : [],
          overrideMarker: client.overrideAdapter?.__codexLinuxHistorySnapshotOverride === true,
          checkedValue:
            typeof client.checkGate === 'function' ? client.checkGate('416252813') : null,
          internationalizationOverride:
            typeof client.overrideAdapter?.getLayerOverride === 'function'
              ? client.overrideAdapter.getLayerOverride({
                  name: '72216192',
                  __value: { enable_i18n: false },
                })?.__value?.enable_i18n
              : null,
        })),
      };
    })(),
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
  if (requireCompressedMainAsset && mainAssetEncoding !== 'gzip') {
    throw new Error(
      `official renderer main asset was not compressed: ${JSON.stringify({
        mainAssetEncoding,
        mainAssetTransferBytes,
      })}`,
    );
  }
  if (clickText !== undefined) {
    const target = page.getByText(clickText, { exact: false }).first();
    await target.waitFor({ state: 'visible', timeout: 120_000 });
    clickTargetVisibleAtMs = Date.now();
    reportProgress('click-target-visible');
    clickedHref = await target.evaluate(
      (element) => element.closest('a')?.getAttribute('href') ?? undefined,
    );
    await target.click();
    clickedAtMs = Date.now();
    reportProgress('click-completed');
  }
  if (afterClickText !== undefined) {
    await page.waitForFunction((text) => document.body.innerText.includes(text), afterClickText, {
      timeout: Math.max(contentTimeoutMs, 180_000),
    });
    afterClickTextVisibleAtMs = Date.now();
    reportProgress('after-click-text-visible');
  }
  if (inspectSettingsMenu.length > 0) {
    const inspectInteractiveElements = () =>
      page.evaluate(() => ({
        bodyText: document.body.innerText.slice(-4_000),
        interactiveElements: Array.from(
          document.querySelectorAll(
            'button, input, select, [role="button"], [role="combobox"], [role="menuitem"], [role="option"], [role="tab"], [role="dialog"]',
          ),
        )
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return {
              ariaLabel: element.getAttribute('aria-label'),
              role: element.getAttribute('role'),
              tagName: element.tagName,
              text: (element.textContent ?? '').trim().slice(0, 300),
              visible:
                rect.width > 0 &&
                rect.height > 0 &&
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                style.opacity !== '0',
            };
          })
          .filter((element) => element.visible),
      }));
    const beforeOpen = await inspectInteractiveElements();
    let afterOpen;
    if (
      inspectSettingsMenu === 'open' ||
      inspectSettingsMenu === 'settings' ||
      inspectSettingsMenu === 'language'
    ) {
      const visibleButtons = page.locator('button');
      const profileButtonIndex = await visibleButtons.evaluateAll((elements) =>
        elements.findIndex((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return (
            rect.left < 300 &&
            rect.top > window.innerHeight * 0.7 &&
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            (element.textContent ?? '').trim().length > 0
          );
        }),
      );
      if (profileButtonIndex === -1) throw new Error('profile menu button not found');
      const profileButton = visibleButtons.nth(profileButtonIndex);
      await profileButton.waitFor({ state: 'visible', timeout: 60_000 });
      await profileButton.click();
      await page.waitForTimeout(500);
      afterOpen = await inspectInteractiveElements();
      if (inspectSettingsMenu === 'settings' || inspectSettingsMenu === 'language') {
        const settingsItem = page
          .locator('[role="menuitem"]')
          .filter({ hasText: /Ctrl\+,/u })
          .last();
        await settingsItem.waitFor({ state: 'visible', timeout: 20_000 });
        await settingsItem.click();
        await page.locator('[role="switch"]').first().waitFor({
          state: 'visible',
          timeout: 120_000,
        });
        const settingsDialog = await inspectInteractiveElements();
        let languageMenu;
        let switchedLocale;
        if (inspectSettingsMenu === 'language') {
          const currentLanguageLabel = await page.evaluate(() => {
            const locale = document.documentElement.lang;
            const specialLabels = {
              'ms-MY': 'Bahasa Melayu',
              'zh-CN': '简体中文',
              'zh-HK': '繁體中文（香港）',
              'zh-TW': '繁體中文（台灣）',
            };
            if (locale in specialLabels) return specialLabels[locale];
            return new Intl.DisplayNames([locale], {
              languageDisplay: 'standard',
              type: 'language',
            }).of(locale);
          });
          const settingsButtons = page.locator('button');
          const languageButtonIndex = await settingsButtons.evaluateAll(
            (elements, label) =>
              elements.findIndex((element) => (element.textContent ?? '').trim() === label),
            currentLanguageLabel,
          );
          if (languageButtonIndex === -1) {
            throw new Error(`language button not found for ${currentLanguageLabel}`);
          }
          const languageButton = settingsButtons.nth(languageButtonIndex);
          await languageButton.waitFor({ state: 'visible', timeout: 20_000 });
          await languageButton.click();
          await page.waitForTimeout(300);
          languageMenu = await inspectInteractiveElements();
          const switchedLocales = [];
          for (let index = 0; index < switchLocaleSequence.length; index += 1) {
            const localeSwitch = switchLocaleSequence[index];
            if (index > 0) {
              await languageButton.waitFor({ state: 'visible', timeout: 20_000 });
              await languageButton.click();
            }
            const localeOption = page
              .locator('[role="option"], [role="menuitem"], button')
              .filter({ hasText: new RegExp(`^${escapeRegExp(localeSwitch.label)}$`, 'u') })
              .last();
            await localeOption.waitFor({ state: 'visible', timeout: 20_000 });
            await localeOption.click();
            await page.waitForFunction(
              (locale) => document.documentElement.lang === locale,
              localeSwitch.expected,
              { timeout: 30_000 },
            );
            const assetLocale = localeSwitch.assetLocale ?? localeSwitch.expected;
            if (localeSwitch.expected !== 'en-US') {
              await waitFor(
                () => loadedLocaleAssets.some((asset) => asset?.startsWith(`${assetLocale}-`)),
                30_000,
              );
            }
            switchedLocales.push({
              label: localeSwitch.label,
              documentLocale: await page.evaluate(() => document.documentElement.lang),
              localeAsset: loadedLocaleAssets.find((asset) => asset?.startsWith(`${assetLocale}-`)),
            });
            reportProgress(`locale-${localeSwitch.expected}`);
          }
          if (switchLocaleSequence.length > 0) {
            switchedLocale = { sequence: switchedLocales };
            if (verifyLocaleAfterReload) {
              const finalLocale = switchLocaleSequence.at(-1).expected;
              await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 });
              await page.waitForFunction(
                (locale) => document.documentElement.lang === locale,
                finalLocale,
                { timeout: 120_000 },
              );
              switchedLocale.persistedAfterReload =
                (await page.evaluate(() => document.documentElement.lang)) === finalLocale;
            }
          }
        }
        afterOpen = {
          profileMenu: afterOpen,
          settingsDialog,
          languageMenu,
          switchedLocale,
        };
      }
    }
    settingsMenuInspection = { beforeOpen, afterOpen };
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
      smokeAttempt,
      rendererVersion: renderer.bootstrapVersion,
      historySnapshotGate: renderer.historySnapshotGate,
      documentLocale: renderer.documentLocale,
      loadedLocaleAssets,
      mainAssetEncoding,
      mainAssetTransferBytes,
      bridgeConnected,
      bridgeReady,
      clickedHref,
      currentUrl: page.url(),
      elementCount: renderer.elementCount,
      bodyTextLength: renderer.bodyTextLength,
      expectedTextAsserted: expectedText !== undefined,
      expectedConversationTextAsserted: expectedConversationText !== undefined,
      olderConversationTextAsserted: olderConversationText !== undefined,
      olderScrollAttempts,
      afterClickTextAsserted: afterClickText !== undefined,
      waitedTextGone: waitForTextGone === undefined ? null : true,
      settingsMenuInspection,
      reloadResults,
      screenshotBytes: screenshot.length,
      screenshotMaximumChannelDeviation: Math.round(maximumChannelDeviation * 100) / 100,
      localAssetFailures: failedLocalRequests.length,
      pageErrors: pageErrors.length,
      timingsMs: {
        domContentLoaded: elapsed(domContentLoadedAtMs),
        bridgeReady: elapsed(bridgeReadyAtMs),
        rendererMounted: elapsed(rendererMountedAtMs),
        expectedTextVisible: elapsed(expectedTextVisibleAtMs),
        olderTextVisible: elapsed(olderTextVisibleAtMs),
        clickTargetVisible: elapsed(clickTargetVisibleAtMs),
        clicked: elapsed(clickedAtMs),
        afterClickTextVisible: elapsed(afterClickTextVisibleAtMs),
        waitedTextGone: elapsed(waitedTextGoneAtMs),
        clickToContent:
          clickedAtMs === undefined || afterClickTextVisibleAtMs === undefined
            ? null
            : afterClickTextVisibleAtMs - clickedAtMs,
      },
    })}\n`,
  );
} catch (error) {
  const failureScreenshotPath =
    screenshotPath === undefined ? undefined : screenshotPath.replace(/\.png$/u, '-failure.png');
  const failureState = await page
    .evaluate(() => ({
      bodyTextLength: document.body.innerText.length,
      bodyTextTail: document.body.innerText.slice(-4_000),
      documentLocale: document.documentElement.lang,
      elementCount: document.querySelectorAll('*').length,
      title: document.title,
      url: location.href,
    }))
    .catch(() => undefined);
  if (failureScreenshotPath !== undefined) {
    await page.screenshot({ path: failureScreenshotPath, type: 'png' }).catch(() => undefined);
  }
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      smokeAttempt,
      stage: 'failure-diagnostics',
      error: error instanceof Error ? error.message : String(error),
      failureScreenshotPath,
      failureState,
      localAssetFailures: failedLocalRequests,
      pageErrors,
      timingsMs: {
        domContentLoaded: elapsed(domContentLoadedAtMs),
        bridgeReady: elapsed(bridgeReadyAtMs),
        rendererMounted: elapsed(rendererMountedAtMs),
        expectedTextVisible: elapsed(expectedTextVisibleAtMs),
        waitedTextGone: elapsed(waitedTextGoneAtMs),
      },
    })}\n`,
  );
  throw error;
} finally {
  await context.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
}

function elapsed(timestampMs) {
  return timestampMs === undefined ? null : timestampMs - startedAtMs;
}

function optionalEnvironmentValue(name) {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function parseLocaleSwitchSequence(json, label, expected) {
  if (json !== undefined) {
    const parsed = JSON.parse(json);
    if (
      !Array.isArray(parsed) ||
      parsed.some(
        (entry) =>
          entry === null ||
          typeof entry !== 'object' ||
          typeof entry.label !== 'string' ||
          entry.label.length === 0 ||
          typeof entry.expected !== 'string' ||
          entry.expected.length === 0 ||
          (entry.assetLocale !== undefined &&
            (typeof entry.assetLocale !== 'string' || entry.assetLocale.length === 0)),
      )
    ) {
      throw new Error('SMOKE_SWITCH_LOCALES_JSON must be a locale switch array');
    }
    return parsed;
  }
  if (label === undefined) return [];
  if (expected === undefined) {
    throw new Error('SMOKE_SWITCH_LOCALE_EXPECTED is required with a locale label');
  }
  return [{ label, expected }];
}

function reportProgress(stage) {
  process.stdout.write(
    `${JSON.stringify({ progress: true, smokeAttempt, stage, elapsedMs: Date.now() - startedAtMs })}\n`,
  );
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out after ${String(timeoutMs)}ms`);
}
