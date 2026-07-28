import { randomUUID } from 'node:crypto';

import { RpcSession } from 'capnweb';
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
  const portTransports = new Map();
  const workerResults = new Map();
  const viewMessageWaiters = new Set();
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
    if (frame.type === 'host-port-message') {
      portTransports.get(frame.portId)?.deliver(frame.message);
      return;
    }
    if (frame.type === 'worker-message') {
      const message = frame.message;
      const response =
        message?.type === 'worker-response' && message.response !== undefined
          ? message.response
          : message;
      workerResults.get(response?.id)?.resolve(response);
      workerResults.delete(response?.id);
      return;
    }
    if (frame.type !== 'view-message') return;
    const message = frame.message;
    for (const waiter of [...viewMessageWaiters]) {
      if (!waiter.predicate(message)) continue;
      viewMessageWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
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
    rejectPending(workerResults, error);
    for (const transport of portTransports.values()) transport.abort(error);
    for (const waiter of viewMessageWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    viewMessageWaiters.clear();
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

  const workerRequest = async (worker, method, params) => {
    const id = randomUUID();
    const commandId = randomUUID();
    const commandPending = deferred();
    const workerPending = deferred();
    commandResults.set(commandId, commandPending);
    workerResults.set(id, workerPending);
    send({
      contractVersion: 1,
      type: 'worker-command',
      sequence: clientSequence++,
      commandId,
      worker,
      message: {
        type: 'worker-request',
        workerId: worker,
        request: {
          id,
          method,
          params,
          enqueuedAtMs: Date.now(),
        },
      },
    });
    const accepted = await withTimeout(
      commandPending.promise,
      120_000,
      `worker command ${worker}/${method}`,
    );
    if (accepted.ok !== true) {
      workerResults.delete(id);
      throw new Error(accepted.error ?? `worker command failed: ${worker}/${method}`);
    }
    const response = await withTimeout(
      workerPending.promise,
      120_000,
      `worker response ${worker}/${method}`,
    );
    if (response.method !== method) {
      throw new Error(`worker response method changed: ${worker}/${method}`);
    }
    if (response.result?.type !== 'ok') {
      throw new Error(
        response.result?.error?.message ?? `worker request failed: ${worker}/${method}`,
      );
    }
    return response.result.value;
  };

  const connectAppHost = async () => {
    const portId = randomUUID();
    const transport = new BridgePortTransport({
      onAbort: () => portTransports.delete(portId),
      sendMessage: (message) => {
        send({
          contractVersion: 1,
          type: 'host-port-message',
          sequence: clientSequence++,
          portId,
          message,
        });
      },
    });
    portTransports.set(portId, transport);
    const session = new RpcSession(transport);
    try {
      await command({
        type: '__browser-bridge-request',
        method: 'connect-app-host',
        params: { portId },
      });
    } catch (error) {
      transport.abort(error);
      throw error;
    }
    return {
      appHost: session.getRemoteMain(),
      close() {
        transport.abort(new Error('AppHost smoke connection closed'));
      },
    };
  };

  const waitForViewMessage = (predicate, timeoutMs = 30_000) => {
    const pending = deferred();
    const waiter = {
      predicate,
      reject: pending.reject,
      resolve: pending.resolve,
      timer: setTimeout(() => {
        viewMessageWaiters.delete(waiter);
        pending.reject(new Error('view message timed out'));
      }, timeoutMs),
    };
    waiter.timer.unref();
    viewMessageWaiters.add(waiter);
    return pending.promise;
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
    connectAppHost,
    desktopFetch,
    mcpRequest,
    waitForViewMessage,
    workerRequest,
    close() {
      for (const transport of portTransports.values()) {
        transport.abort(new Error('bridge smoke connection closed'));
      }
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

class BridgePortTransport {
  #aborted;
  #messages = [];
  #onAbort;
  #sendMessage;
  #waiting;

  constructor({ onAbort, sendMessage }) {
    this.#onAbort = onAbort;
    this.#sendMessage = sendMessage;
  }

  send(message) {
    if (this.#aborted !== undefined) throw this.#aborted;
    this.#sendMessage(message);
  }

  receive() {
    const queued = this.#messages.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.#aborted !== undefined) return Promise.reject(this.#aborted);
    if (this.#waiting !== undefined) {
      return Promise.reject(new Error('concurrent AppHost smoke receive is not supported'));
    }
    const pending = deferred();
    this.#waiting = pending;
    return pending.promise;
  }

  deliver(message) {
    if (typeof message !== 'string') {
      this.abort(new TypeError('AppHost smoke accepts string frames only'));
      return;
    }
    const waiting = this.#waiting;
    if (waiting === undefined) this.#messages.push(message);
    else {
      this.#waiting = undefined;
      waiting.resolve(message);
    }
  }

  abort(reason) {
    if (this.#aborted !== undefined) return;
    this.#aborted = reason instanceof Error ? reason : new Error(String(reason));
    this.#waiting?.reject(this.#aborted);
    this.#waiting = undefined;
    this.#onAbort();
  }
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
