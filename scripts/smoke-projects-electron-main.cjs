const { app, net, session } = require('electron');

const PROJECTS_URL =
  'https://chatgpt.com/backend-api/gizmos/snorlax/sidebar' +
  '?conversations_per_gizmo=0&limit=20&owned_only=true';
const INTEGRITY_STATE_PATTERN = /^ois1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;

app.setName('Codex');
const userDataDir = process.env.CODEX_ELECTRON_NET_USER_DATA_DIR;
if (typeof userDataDir === 'string' && userDataDir.length > 0) {
  app.setPath('userData', userDataDir);
}

void main();

async function main() {
  let stage = 'input';
  try {
    const input = await readInput();
    stage = 'app-ready';
    await app.whenReady();
    stage = 'direct-request';
    const direct = await requestSummary(input, null);
    const proxied =
      input.proxyUrl === null
        ? null
        : await (async () => {
            stage = 'proxied-request';
            return requestSummary(input, input.proxyUrl);
          })();
    process.stdout.write(`${JSON.stringify({ direct, proxied })}\n`);
    app.exit(0);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.name : 'UnknownError',
        stage,
        code:
          error !== null && typeof error === 'object' && typeof error.code === 'string'
            ? error.code
            : null,
        message: safeErrorMessage(error),
      })}\n`,
    );
    app.exit(1);
  }
}

async function requestSummary(input, proxyUrl) {
  await session.defaultSession.setProxy(
    proxyUrl === null
      ? { mode: 'direct' }
      : {
          mode: 'fixed_servers',
          proxyRules: chromiumProxyRules(proxyUrl),
          proxyBypassRules: '<-loopback>',
        },
  );
  await session.defaultSession.closeAllConnections();
  const headers = {
    Authorization: `Bearer ${input.token}`,
    'OAI-Language': 'en',
    originator: 'Codex Desktop',
    'X-OpenAI-Codex-Client-Version': input.rendererVersion,
  };
  if (input.accountId !== null) headers['ChatGPT-Account-Id'] = input.accountId;
  const response = await net.fetch(PROJECTS_URL, {
    method: 'GET',
    headers,
    redirect: 'manual',
    credentials: 'omit',
    cache: 'no-store',
    signal: AbortSignal.timeout(120_000),
  });
  const integrityUpdate = response.headers.get('x-oai-is-update');
  const summary = {
    status: response.status,
    contentType: response.headers.get('content-type')?.split(';', 1)[0] ?? null,
    cfMitigated: response.headers.get('cf-mitigated') === 'challenge',
    integrityUpdatePresent:
      typeof integrityUpdate === 'string' && INTEGRITY_STATE_PATTERN.test(integrityUpdate),
  };
  await response.body?.cancel().catch(() => undefined);
  return summary;
}

function chromiumProxyRules(proxyUrl) {
  const url = new URL(proxyUrl);
  const authority = `${url.hostname}:${url.port}`;
  return `http=${authority};https=${authority}`;
}

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof value.token !== 'string' ||
    value.token.length === 0 ||
    (value.accountId !== null && typeof value.accountId !== 'string') ||
    typeof value.rendererVersion !== 'string' ||
    (value.proxyUrl !== null && typeof value.proxyUrl !== 'string')
  ) {
    throw new TypeError('invalid smoke input');
  }
  return value;
}

function safeErrorMessage(error) {
  if (!(error instanceof Error)) return 'Unknown error';
  return error.message
    .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/gu, '[redacted]')
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .slice(0, 300);
}
