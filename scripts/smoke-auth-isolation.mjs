import WebSocket from 'ws';

const baseUrl = process.env.SMOKE_BASE_URL;
const publicOrigin = process.env.SMOKE_PUBLIC_ORIGIN;
const proxySecret = process.env.SMOKE_PROXY_SECRET;
if (baseUrl === undefined || publicOrigin === undefined) {
  throw new Error('SMOKE_BASE_URL and SMOKE_PUBLIC_ORIGIN are required');
}

function identityHeaders(subject, username, verified = true) {
  return {
    ...(verified ? { 'X-Aialra-Authenticated': '1' } : {}),
    ...(proxySecret === undefined ? {} : { 'X-Aialra-Proxy-Secret': proxySecret }),
    'X-Aialra-Sub': subject,
    'X-Aialra-User': username,
    'X-Aialra-Email': `${username}@example.invalid`,
    'X-Aialra-Groups': 'aialra:access:codexapp,aialra:role:developer',
  };
}

async function responseStatus(headers) {
  return (await fetch(`${baseUrl}/`, { headers, redirect: 'manual' })).status;
}

async function bootstrap(subject, username) {
  const response = await fetch(`${baseUrl}/__codex/bootstrap.js`, {
    headers: identityHeaders(subject, username),
  });
  if (!response.ok) throw new Error(`bootstrap failed with ${response.status}`);
  const source = await response.text();
  const prefix = 'window.__CODEX_BROWSER_BOOTSTRAP__=';
  if (!source.startsWith(prefix) || !source.endsWith(';\n')) {
    throw new Error('bootstrap source shape changed');
  }
  return JSON.parse(source.slice(prefix.length, -2));
}

function connect(ticket, subject, username) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/bridge', baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url, {
      origin: publicOrigin,
      headers: identityHeaders(subject, username),
    });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('websocket result timeout'));
    }, 10_000);
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ type: 'close', code, reason: reason.toString() });
    });
    socket.once('open', () => {
      socket.send(
        JSON.stringify({
          contractVersion: 1,
          sequence: 0,
          type: 'hello',
          ticket: ticket.ticket,
          rendererVersion: ticket.rendererVersion,
          lastHostSequence: 0,
        }),
      );
    });
    socket.once('message', (raw) => {
      clearTimeout(timer);
      const frame = JSON.parse(raw.toString());
      socket.close(1000, 'smoke complete');
      resolve({ type: 'message', frame });
    });
  });
}

const anonymousStatus = await responseStatus({});
const spoofStatus = await responseStatus(identityHeaders('shadow-subject-a', 'shared-name', false));
const missingProxyProofStatus =
  proxySecret === undefined
    ? null
    : await responseStatus({
        'X-Aialra-Authenticated': '1',
        'X-Aialra-Sub': 'shadow-subject-a',
        'X-Aialra-User': 'shared-name',
      });
const ticket = await bootstrap('shadow-subject-a', 'shared-name');
const crossIdentity = await connect(ticket, 'shadow-subject-b', 'shared-name');
const renamedIdentity = await connect(ticket, 'shadow-subject-a', 'renamed-user');

if (anonymousStatus !== 401 || spoofStatus !== 401) {
  throw new Error(`HTTP authentication failed closed: ${anonymousStatus}/${spoofStatus}`);
}
if (missingProxyProofStatus !== null && missingProxyProofStatus !== 401) {
  throw new Error(`missing proxy proof was not rejected: ${String(missingProxyProofStatus)}`);
}
if (crossIdentity.type !== 'close' || crossIdentity.code !== 4401) {
  throw new Error(`cross-identity ticket was not rejected: ${JSON.stringify(crossIdentity)}`);
}
if (renamedIdentity.type !== 'message' || renamedIdentity.frame?.type !== 'ready') {
  throw new Error(`stable-subject reconnect failed: ${JSON.stringify(renamedIdentity)}`);
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    anonymousStatus,
    spoofStatus,
    missingProxyProofStatus,
    crossIdentityTicket: 'rejected',
    renamedStableSubject: 'accepted',
  })}\n`,
);
