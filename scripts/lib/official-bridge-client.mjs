import { randomUUID } from 'node:crypto';

import WebSocket from 'ws';

export async function connectOfficialBridge({ baseUrl, identityHeaders, publicOrigin }) {
  const bootstrapResponse = await fetch(`${baseUrl}/__codex/bootstrap.js`, {
    headers: identityHeaders,
  });
  if (!bootstrapResponse.ok) {
    throw new Error(`bootstrap failed with ${String(bootstrapResponse.status)}`);
  }
  const bootstrapSource = await bootstrapResponse.text();
  const bootstrapPrefix = 'window.__CODEX_BROWSER_BOOTSTRAP__=';
  if (!bootstrapSource.startsWith(bootstrapPrefix) || !bootstrapSource.endsWith(';\n')) {
    throw new Error('bootstrap source shape changed');
  }
  const bootstrap = JSON.parse(bootstrapSource.slice(bootstrapPrefix.length, -2));

  const socketUrl = new URL('/api/bridge', baseUrl);
  socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(socketUrl, {
    origin: publicOrigin,
    headers: identityHeaders,
  });
  let clientSequence = 0;
  const commandResults = new Map();
  const fetchResults = new Map();
  const mcpResults = new Map();
  const ready = deferred();

  const send = (frame) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  };
  socket.on('open', () => {
    send({
      contractVersion: 1,
      type: 'hello',
      sequence: clientSequence++,
      ticket: bootstrap.ticket,
      rendererVersion: bootstrap.rendererVersion,
      lastHostSequence: 0,
    });
  });
  socket.on('message', (raw) => {
    const frame = JSON.parse(raw.toString());
    send({
      contractVersion: 1,
      type: 'ack',
      sequence: clientSequence++,
      hostSequence: frame.sequence,
    });
    if (frame.type === 'ready') {
      ready.resolve(frame);
      return;
    }
    if (frame.type === 'command-result') {
      commandResults.get(frame.commandId)?.resolve(frame);
      commandResults.delete(frame.commandId);
      return;
    }
    if (frame.type !== 'view-message') return;
    const message = frame.message;
    if (message?.type === 'fetch-response') {
      fetchResults.get(message.requestId)?.resolve(message);
      fetchResults.delete(message.requestId);
    } else if (message?.type === 'mcp-response') {
      mcpResults.get(message.message?.id)?.resolve(message.message);
      mcpResults.delete(message.message?.id);
    }
  });
  socket.on('error', (error) => ready.reject(error));
  socket.on('close', (code, reason) => {
    const error = new Error(`bridge closed (${String(code)}): ${reason.toString()}`);
    ready.reject(error);
    rejectPending(commandResults, error);
    rejectPending(fetchResults, error);
    rejectPending(mcpResults, error);
  });

  const command = async (message) => {
    const commandId = randomUUID();
    const pending = deferred();
    commandResults.set(commandId, pending);
    send({
      contractVersion: 1,
      type: 'command',
      sequence: clientSequence++,
      commandId,
      message,
    });
    const response = await withTimeout(pending.promise, 120_000, `host command ${message.type}`);
    if (response.ok !== true) throw new Error(response.error ?? 'host command failed');
    return response.result;
  };

  const desktopFetch = async (method, params) => {
    const requestId = randomUUID();
    const pending = deferred();
    fetchResults.set(requestId, pending);
    await command({
      type: 'fetch',
      requestId,
      method: 'POST',
      url: `vscode://codex/${method}`,
      body: JSON.stringify(params),
    });
    const response = await withTimeout(pending.promise, 120_000, `desktop fetch ${method}`);
    if (response.responseType !== 'success') {
      throw new Error(response.error ?? `desktop fetch failed: ${method}`);
    }
    return JSON.parse(response.bodyJsonString);
  };

  const mcpRequest = async (method, params) => {
    const id = randomUUID();
    const pending = deferred();
    mcpResults.set(id, pending);
    await command({
      type: 'mcp-request',
      request: { jsonrpc: '2.0', id, method, params },
    });
    const response = await withTimeout(pending.promise, 120_000, `app-server request ${method}`);
    if (response.error !== undefined) {
      throw new Error(response.error.message ?? `app-server request failed: ${method}`);
    }
    return response.result;
  };

  try {
    await withTimeout(ready.promise, 30_000, 'bridge ready');
    await command({ type: 'ready' });
  } catch (error) {
    socket.close();
    throw error;
  }

  return {
    bootstrap,
    command,
    desktopFetch,
    mcpRequest,
    close() {
      socket.close(1000, 'smoke complete');
    },
  };
}

export function createIdentityHeaders({ email, proxySecret, subject, username }) {
  return {
    'X-Aialra-Authenticated': '1',
    'X-Aialra-Proxy-Secret': proxySecret,
    'X-Aialra-Sub': subject,
    'X-Aialra-User': username,
    'X-Aialra-Email': email,
    'X-Aialra-Groups': 'aialra:access:codexapp,aialra:role:developer',
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function rejectPending(pending, error) {
  for (const value of pending.values()) value.reject(error);
  pending.clear();
}

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      timer.unref();
    }),
  ]);
}
