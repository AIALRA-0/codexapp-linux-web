import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CodexAppServerClient } from '../packages/app-server-client/dist/index.js';

const codexBin = requiredEnvironment('SMOKE_CODEX_BIN');
const codexHome = requiredEnvironment('SMOKE_CODEX_HOME');
const workspace = process.env.SMOKE_WORKSPACE ?? process.cwd();
const rendererVersion = process.env.SMOKE_RENDERER_VERSION ?? '26.721.81911';
const proxyUrl =
  process.env.SMOKE_EGRESS_PROXY_URL === undefined
    ? null
    : validatedLoopbackProxy(process.env.SMOKE_EGRESS_PROXY_URL);
const electronBin = process.env.SMOKE_ELECTRON_BIN;
const electronWorker = process.env.SMOKE_ELECTRON_WORKER;
const xvfbRun = process.env.SMOKE_XVFB_RUN;
const projectsUrl = new URL(
  'https://chatgpt.com/backend-api/gizmos/snorlax/sidebar' +
    '?conversations_per_gizmo=0&limit=20&owned_only=true',
);

const client = new CodexAppServerClient({
  codexBin,
  codexHome,
  cwd: workspace,
  clientVersion: rendererVersion,
  extraArgs: ['-c', 'features.code_mode_host=true'],
  requestTimeoutMs: 180_000,
});
client.on('request', (event) => {
  void event.respond({
    error: {
      code: -32_600,
      message: `unexpected server request during projects egress smoke: ${event.request.method}`,
    },
  });
});
client.on('error', () => undefined);

const proxyAgent = proxyUrl === null ? null : new ProxyAgent(proxyUrl);
try {
  await client.start();
  const authStatus = await client.request('getAuthStatus', {
    includeToken: true,
    refreshToken: false,
  });
  const token =
    authStatus?.authMethod === 'chatgpt' && typeof authStatus.authToken === 'string'
      ? authStatus.authToken
      : null;
  if (token === null) throw new Error('ChatGPT token is unavailable');
  const accountId = chatGptAccountIdFromToken(token);
  const baseHeaders = new Headers({
    Authorization: `Bearer ${token}`,
    'OAI-Language': 'en',
    originator: 'Codex Desktop',
    'X-OpenAI-Codex-Client-Version': rendererVersion,
  });
  if (accountId !== null) baseHeaders.set('ChatGPT-Account-Id', accountId);

  const direct = await requestSummary(baseHeaders);
  const proxied = proxyAgent === null ? null : await requestSummary(baseHeaders, proxyAgent);
  const integrityUpdate = proxied?.integrityUpdate ?? null;
  const proxiedWithIntegrity =
    integrityUpdate === null || proxyAgent === null
      ? null
      : await requestSummary(
          new Headers([...baseHeaders.entries(), ['X-OAI-IS', integrityUpdate]]),
          proxyAgent,
        );
  const electron =
    electronBin === undefined
      ? null
      : await electronRequestSummary({
          accountId,
          electronBin,
          proxyUrl,
          rendererVersion,
          token,
          xvfbRun,
        });
  const electronPersistent =
    electronBin === undefined || electronWorker === undefined
      ? null
      : await persistentElectronRequestSummary({
          baseHeaders,
          electronBin,
          electronWorker,
          rendererVersion,
          token,
        });

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      authenticated: true,
      accountIdAttached: accountId !== null,
      direct: publicSummary(direct),
      proxied: proxied === null ? null : publicSummary(proxied),
      proxiedWithIntegrity:
        proxiedWithIntegrity === null ? null : publicSummary(proxiedWithIntegrity),
      electron,
      electronPersistent,
    })}\n`,
  );
} finally {
  await proxyAgent?.close().catch(() => undefined);
  await client.stop().catch(() => undefined);
}

async function persistentElectronRequestSummary({
  baseHeaders,
  electronBin,
  electronWorker,
  rendererVersion,
  token,
}) {
  const { OfficialElectronNetwork } =
    await import('../packages/host-gateway/dist/electron-network.js');
  const { RendererFetchProxy } = await import('../packages/host-gateway/dist/network.js');
  const client = new OfficialElectronNetwork({
    electronBin,
    workerPath: electronWorker,
    userDataDir: requiredEnvironment('SMOKE_ELECTRON_USER_DATA_DIR'),
    expectedElectronVersion: '43.2.0',
    expectedChromiumVersion: '150.0.7871.129',
  });
  try {
    const coldStartedAt = performance.now();
    const cold = await client.fetch(projectsUrl, {
      method: 'GET',
      headers: baseHeaders,
    });
    const coldMs = Math.round(performance.now() - coldStartedAt);
    const coldSummary = await summarizeResponse(cold);
    const warmStartedAt = performance.now();
    const warm = await client.fetch(projectsUrl, {
      method: 'GET',
      headers: baseHeaders,
    });
    const warmMs = Math.round(performance.now() - warmStartedAt);
    const warmSummary = await summarizeResponse(warm);
    const gateway = new RendererFetchProxy({
      appVersion: rendererVersion,
      electronFetchImplementation: client.fetch.bind(client),
      getAuthToken: async () => token,
    });
    const gatewayStartedAt = performance.now();
    const gatewayResult = await gateway.perform({
      type: 'fetch',
      requestId: 'projects-gateway-smoke',
      url: projectsUrl.href,
      method: 'GET',
      headers: {
        'X-OpenAI-Attach-Auth': '1',
        'X-OpenAI-Attach-Desktop-Surface': '1',
      },
    });
    const gatewayMs = Math.round(performance.now() - gatewayStartedAt);
    if (
      gatewayResult.responseType !== 'success' ||
      gatewayResult.status !== 200 ||
      typeof gatewayResult.bodyJsonString !== 'string'
    ) {
      throw new Error('production renderer Projects route did not return a successful response');
    }
    const gatewayJson = JSON.parse(gatewayResult.bodyJsonString);
    if (gatewayJson === null || typeof gatewayJson !== 'object') {
      throw new Error('production renderer Projects route returned invalid JSON');
    }
    return {
      ok: true,
      cold: coldSummary,
      coldMs,
      warm: warmSummary,
      warmMs,
      gatewayRoute: {
        status: gatewayResult.status,
        responseType: gatewayResult.responseType,
        validJson: true,
        milliseconds: gatewayMs,
      },
    };
  } finally {
    await client.stop();
  }
}

async function electronRequestSummary({
  accountId,
  electronBin,
  proxyUrl,
  rendererVersion,
  token,
  xvfbRun,
}) {
  const helperPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    'smoke-projects-electron-main.cjs',
  );
  const userDataDir = requiredEnvironment('SMOKE_ELECTRON_USER_DATA_DIR');
  const electronArgs = ['--disable-setuid-sandbox', '--headless', '--disable-gpu', helperPath];
  const command = xvfbRun ?? electronBin;
  const args = xvfbRun === undefined ? electronArgs : ['-a', electronBin, ...electronArgs];
  const child = spawn(command, args, {
    env: {
      HOME: userDataDir,
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      LANG: 'C.UTF-8',
      CODEX_ELECTRON_NET_USER_DATA_DIR: userDataDir,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.stdin.end(
    JSON.stringify({
      token,
      accountId,
      rendererVersion,
      proxyUrl,
    }),
  );
  const exit = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  const stdoutText = Buffer.concat(stdout).toString('utf8');
  const parsedOutput = parseElectronOutput(stdoutText);
  if (parsedOutput !== null) {
    return {
      ok: true,
      direct: parsedOutput.direct,
      proxied: parsedOutput.proxied,
    };
  }
  if (exit.code !== 0) {
    const stderrText = Buffer.concat(stderr).toString('utf8');
    const safeError = safeElectronError(stderrText);
    return {
      ok: false,
      error: safeError,
      exitCode: exit.code,
      signal: exit.signal,
      diagnostics: safeElectronDiagnostics(stderrText),
      stdoutDiagnostics: safeElectronDiagnostics(stdoutText),
    };
  }
  throw new Error('Electron smoke returned no sealed result');
}

function parseElectronOutput(stdout) {
  const lines = stdout.trim().split(/\r?\n/u);
  for (const line of lines.reverse()) {
    try {
      const parsed = JSON.parse(line);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        parsed.direct !== undefined &&
        parsed.proxied !== undefined
      ) {
        return parsed;
      }
    } catch {
      // Chromium may add diagnostics around the sealed JSON result.
    }
  }
  return null;
}

function safeElectronError(stderr) {
  const lines = stderr
    .trim()
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0);
  for (const line of lines.reverse()) {
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed.error === 'string') return parsed.error;
    } catch {
      // Chromium may add diagnostics around the sealed JSON error.
    }
  }
  return 'ElectronSmokeFailed';
}

function safeElectronDiagnostics(stderr) {
  return stderr
    .trim()
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .slice(-5)
    .map((line) =>
      line
        .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/gu, '[redacted]')
        .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
        .slice(0, 300),
    );
}

async function requestSummary(headers, dispatcher) {
  try {
    const response = await undiciFetch(projectsUrl, {
      method: 'GET',
      headers,
      redirect: 'manual',
      ...(dispatcher === undefined ? {} : { dispatcher }),
    });
    return await summarizeResponse(response, true);
  } catch (error) {
    return {
      status: null,
      contentType: null,
      cfMitigated: false,
      integrityUpdate: null,
      networkError: error instanceof Error ? error.name : 'UnknownError',
    };
  }
}

async function summarizeResponse(response, includeIntegrityValue = false) {
  const integrityUpdate = validIntegrityState(response.headers.get('x-oai-is-update'));
  const summary = {
    status: response.status,
    contentType: response.headers.get('content-type')?.split(';', 1)[0] ?? null,
    cfMitigated: response.headers.get('cf-mitigated') === 'challenge',
    ...(includeIntegrityValue
      ? { integrityUpdate }
      : { integrityUpdatePresent: integrityUpdate !== null }),
  };
  await response.body?.cancel().catch(() => undefined);
  return summary;
}

function publicSummary(summary) {
  return {
    status: summary.status,
    contentType: summary.contentType,
    cfMitigated: summary.cfMitigated,
    integrityUpdatePresent: summary.integrityUpdate !== null,
    ...(summary.networkError === undefined ? {} : { networkError: summary.networkError }),
  };
}

function chatGptAccountIdFromToken(token) {
  const payload = token.split('.')[1];
  if (payload === undefined) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const auth = claims?.['https://api.openai.com/auth'];
    return typeof auth?.chatgpt_account_id === 'string' ? auth.chatgpt_account_id : null;
  } catch {
    return null;
  }
}

function validIntegrityState(value) {
  return typeof value === 'string' &&
    /^ois1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value)
    ? value
    : null;
}

function validatedLoopbackProxy(value) {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error('SMOKE_EGRESS_PROXY_URL must be a credential-free loopback proxy');
  }
  return url.href;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}
