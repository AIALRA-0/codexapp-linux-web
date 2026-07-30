const readline = require('node:readline');

const { app, net, session } = require('electron');

const PROTOCOL_MARKER = 'CODEX_ELECTRON_NET_V1 ';
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const PROJECTS_HOST = 'chatgpt.com';
const PROJECTS_PATH = '/backend-api/gizmos/snorlax/sidebar';
const PROJECTS_QUERY_KEYS = new Set(['conversations_per_gizmo', 'limit', 'owned_only']);
const controllers = new Map();

app.setName('Codex');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('headless');

const userDataDir = process.env.CODEX_ELECTRON_NET_USER_DATA_DIR;
if (typeof userDataDir === 'string' && userDataDir.length > 0) {
  app.setPath('userData', userDataDir);
}

void main();

async function main() {
  try {
    await app.whenReady();
    await session.defaultSession.setProxy({ mode: 'direct' });
    await session.defaultSession.closeAllConnections();
    send({
      type: 'ready',
      electronVersion: process.versions.electron ?? null,
      chromiumVersion: process.versions.chrome ?? null,
    });
    const input = readline.createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
      terminal: false,
    });
    input.on('line', (line) => {
      void handleLine(line);
    });
    input.once('close', () => {
      shutdown();
    });
  } catch (error) {
    send({
      type: 'fatal',
      error: safeError(error),
    });
    app.exit(1);
  }
}

async function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message?.type === 'cancel' && typeof message.id === 'string') {
    controllers.get(message.id)?.abort();
    return;
  }
  if (message?.type !== 'fetch' || typeof message.id !== 'string') return;
  const controller = new AbortController();
  controllers.set(message.id, controller);
  try {
    const request = parseRequest(message);
    const response = await net.fetch(request.url, {
      method: 'GET',
      headers: request.headers,
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
    });
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw new RangeError('official Electron response exceeded the configured limit');
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > MAX_RESPONSE_BYTES) {
      throw new RangeError('official Electron response exceeded the configured limit');
    }
    send({
      type: 'response',
      id: message.id,
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers.entries()],
      bodyBase64: body.toString('base64'),
    });
  } catch (error) {
    send({
      type: 'error',
      id: message.id,
      error: safeError(error),
      aborted: controller.signal.aborted,
    });
  } finally {
    controllers.delete(message.id);
  }
}

function parseRequest(message) {
  if (message.method !== 'GET') throw new TypeError('only GET is supported');
  const url = new URL(message.url);
  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.port.length > 0 ||
    url.hostname !== PROJECTS_HOST ||
    url.pathname !== PROJECTS_PATH ||
    url.hash.length > 0
  ) {
    throw new TypeError('request target is not the official projects endpoint');
  }
  const seenQueryKeys = new Set();
  for (const [name, value] of url.searchParams) {
    if (!PROJECTS_QUERY_KEYS.has(name) || seenQueryKeys.has(name)) {
      throw new TypeError('request query is not allowed');
    }
    seenQueryKeys.add(name);
    if (
      (name === 'owned_only' && !['true', 'false'].includes(value)) ||
      (name !== 'owned_only' && !/^[0-9]{1,3}$/u.test(value))
    ) {
      throw new TypeError('request query is not allowed');
    }
  }
  if (
    message.headers === null ||
    typeof message.headers !== 'object' ||
    Array.isArray(message.headers)
  ) {
    throw new TypeError('invalid request headers');
  }
  const headers = {};
  const headerEntries = Object.entries(message.headers);
  if (headerEntries.length > 100) throw new TypeError('too many request headers');
  let headerBytes = 0;
  for (const [name, value] of headerEntries) {
    if (typeof value !== 'string') throw new TypeError('invalid request header');
    headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (headerBytes > 64 * 1024) throw new TypeError('request headers are too large');
    const normalized = name.toLowerCase();
    if (
      [
        'connection',
        'content-length',
        'cookie',
        'host',
        'proxy-authorization',
        'proxy-authenticate',
        'set-cookie',
        'transfer-encoding',
      ].includes(normalized)
    ) {
      throw new TypeError('forbidden request header');
    }
    headers[name] = value;
  }
  return { url: url.href, headers };
}

function safeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message
        .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/gu, '[redacted]')
        .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
        .slice(0, 300),
    };
  }
  return { name: 'UnknownError', message: 'Unknown Electron network error' };
}

function send(message) {
  process.stdout.write(`${PROTOCOL_MARKER}${JSON.stringify(message)}\n`);
}

function shutdown() {
  for (const controller of controllers.values()) controller.abort();
  controllers.clear();
  app.exit(0);
}
