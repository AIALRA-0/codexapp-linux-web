const readline = require('node:readline');

const { app, net, session } = require('electron');

const PROTOCOL_MARKER = 'CODEX_ELECTRON_NET_V1 ';
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_CHUNK_BYTES = 64 * 1024;
const OFFICIAL_HOST = 'chatgpt.com';
const OFFICIAL_PATH_PREFIX = '/backend-api/';
const ALLOWED_METHODS = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
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
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body }),
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
    send({
      type: 'response-start',
      id: message.id,
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers.entries()],
    });
    let responseBytes = 0;
    if (response.body !== null) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done || value === undefined) break;
          responseBytes += value.byteLength;
          if (responseBytes > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new RangeError('official Electron response exceeded the configured limit');
          }
          for (let offset = 0; offset < value.byteLength; offset += MAX_CHUNK_BYTES) {
            const chunk = value.subarray(offset, offset + MAX_CHUNK_BYTES);
            await sendAsync({
              type: 'response-chunk',
              id: message.id,
              bodyBase64: Buffer.from(chunk).toString('base64'),
            });
          }
        }
      } finally {
        reader.releaseLock();
      }
    }
    send({ type: 'response-end', id: message.id });
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
  if (typeof message.method !== 'string' || !ALLOWED_METHODS.has(message.method)) {
    throw new TypeError('request method is not allowed');
  }
  const url = new URL(message.url);
  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.port.length > 0 ||
    url.hostname !== OFFICIAL_HOST ||
    !url.pathname.startsWith(OFFICIAL_PATH_PREFIX) ||
    url.hash.length > 0
  ) {
    throw new TypeError('request target is not an official ChatGPT backend API');
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
  let body;
  if (message.bodyBase64 !== undefined) {
    if (message.method === 'GET' || message.method === 'HEAD') {
      throw new TypeError('GET and HEAD requests cannot have a body');
    }
    if (typeof message.bodyBase64 !== 'string') throw new TypeError('invalid request body');
    body = Buffer.from(message.bodyBase64, 'base64');
    if (body.byteLength > MAX_REQUEST_BYTES) {
      throw new RangeError('official Electron request exceeded the configured limit');
    }
  }
  return { url: url.href, method: message.method, headers, body };
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

function sendAsync(message) {
  const frame = `${PROTOCOL_MARKER}${JSON.stringify(message)}\n`;
  if (process.stdout.write(frame)) return Promise.resolve();
  return new Promise((resolve) => process.stdout.once('drain', resolve));
}

function shutdown() {
  for (const controller of controllers.values()) controller.abort();
  controllers.clear();
  app.exit(0);
}
