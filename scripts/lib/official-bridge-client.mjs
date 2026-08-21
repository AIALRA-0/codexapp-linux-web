import { randomUUID } from 'node:crypto';

import { RpcSession } from 'capnweb';
import WebSocket from 'ws';

export async function connectOfficialBridge({ baseUrl, identityHeaders, publicOrigin }) {
  const requestTimeoutMs = requestTimeoutFromEnvironment();
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
  const recentViewMessages = [];
  const chunkedMessages = new OfficialChunkedMessageAssembler();
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
    const received = chunkedMessages.receive(frame.message);
    if (received.pending) return;
    const message = received.message;
    recentViewMessages.push(message);
    if (recentViewMessages.length > 1_000) recentViewMessages.shift();
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
    const response = await withTimeout(
      pending.promise,
      requestTimeoutMs,
      `host command ${message.type}`,
    );
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
    const response = await withTimeout(
      pending.promise,
      requestTimeoutMs,
      `desktop fetch ${method}`,
    );
    if (response.responseType !== 'success') {
      throw new Error(response.error ?? `desktop fetch failed: ${method}`);
    }
    return JSON.parse(response.bodyJsonString);
  };

  const appServerRequest = async (messageType, method, params, extra = {}) => {
    const id = randomUUID();
    const pending = deferred();
    mcpResults.set(id, pending);
    await command({
      ...extra,
      type: messageType,
      request: { jsonrpc: '2.0', id, method, params },
    });
    const response = await withTimeout(
      pending.promise,
      requestTimeoutMs,
      `app-server request ${method}`,
    );
    if (response.error !== undefined) {
      throw new Error(response.error.message ?? `app-server request failed: ${method}`);
    }
    return response.result;
  };

  const mcpRequest = async (method, params) => appServerRequest('mcp-request', method, params);

  const prewarmThreadStart = async (params) =>
    appServerRequest('thread-prewarm-start', 'thread/start', params, {
      expiresAtMs: Date.now() + requestTimeoutMs,
      hostId: 'local',
      priority: 'normal',
      source: 'official-bridge-smoke',
      timeoutMs: requestTimeoutMs,
    });

  const respondMcpRequest = async (id, result) =>
    command({
      type: 'mcp-response',
      response: { id, result },
    });

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
      requestTimeoutMs,
      `worker command ${worker}/${method}`,
    );
    if (accepted.ok !== true) {
      workerResults.delete(id);
      throw new Error(accepted.error ?? `worker command failed: ${worker}/${method}`);
    }
    const response = await withTimeout(
      workerPending.promise,
      requestTimeoutMs,
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
    const recent = recentViewMessages.findLast(predicate);
    if (recent !== undefined) return Promise.resolve(recent);
    return waitForNextViewMessage(predicate, timeoutMs);
  };

  const waitForNextViewMessage = (predicate, timeoutMs = 30_000) => {
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
    prewarmThreadStart,
    respondMcpRequest,
    waitForViewMessage,
    waitForNextViewMessage,
    workerRequest,
    close() {
      for (const transport of portTransports.values()) {
        transport.abort(new Error('bridge smoke connection closed'));
      }
      socket.close(1000, 'smoke complete');
    },
  };
}

class OfficialChunkedMessageAssembler {
  transfers = new Map();

  receive(message) {
    if (!isOfficialChunkedMessage(message)) return { pending: false, message };
    if (message.kind === 'start') {
      this.transfers.clear();
      this.transfers.set(message.transferId, {
        assembler: new OfficialTokenAssembler(),
        nextSequence: message.sequence + 1,
      });
      return { pending: true };
    }
    const transfer = this.transfers.get(message.transferId);
    if (transfer === undefined || message.sequence !== transfer.nextSequence) {
      this.transfers.delete(message.transferId);
      return { pending: true };
    }
    transfer.nextSequence += 1;
    if (message.kind === 'chunk') {
      transfer.assembler.consume(message.tokens);
      return { pending: true };
    }
    this.transfers.delete(message.transferId);
    return { pending: false, message: transfer.assembler.finish() };
  }
}

class OfficialTokenAssembler {
  root = UNSET;
  stack = [];
  stringChunks = null;
  stringTarget = null;

  consume(tokens) {
    for (const token of tokens) {
      switch (token.type) {
        case 'array-start': {
          const value = [];
          this.saveValue(value);
          this.stack.push({ type: 'array', value });
          break;
        }
        case 'object-start': {
          const value = {};
          this.saveValue(value);
          this.stack.push({ type: 'object', value, key: null });
          break;
        }
        case 'container-end':
          if (this.stack.pop() === undefined) throw new Error('unmatched chunk container end');
          break;
        case 'key':
          this.setKey(token.value);
          break;
        case 'value':
          this.saveValue(token.value);
          break;
        case 'string-start':
          if (this.stringChunks !== null) throw new Error('nested chunk string');
          this.stringChunks = [];
          this.stringTarget = token.target;
          break;
        case 'string-chunk':
          if (this.stringChunks === null) throw new Error('chunk string has no start');
          this.stringChunks.push(token.value);
          break;
        case 'string-end': {
          if (this.stringChunks === null || this.stringTarget === null) {
            throw new Error('chunk string has no target');
          }
          const value = this.stringChunks.join('');
          const target = this.stringTarget;
          this.stringChunks = null;
          this.stringTarget = null;
          if (target === 'key') this.setKey(value);
          else this.saveValue(value);
          break;
        }
      }
    }
  }

  finish() {
    if (this.root === UNSET || this.stack.length > 0 || this.stringChunks !== null) {
      throw new Error('chunked message ended before completion');
    }
    return this.root;
  }

  setKey(key) {
    const container = this.stack.at(-1);
    if (container?.type !== 'object' || container.key !== null) {
      throw new Error('chunk key is outside an object');
    }
    container.key = key;
  }

  saveValue(value) {
    const container = this.stack.at(-1);
    if (container === undefined) {
      if (this.root !== UNSET) throw new Error('chunked message has multiple roots');
      this.root = value;
    } else if (container.type === 'array') {
      container.value.push(value);
    } else {
      if (container.key === null) throw new Error('chunked object value has no key');
      Object.defineProperty(container.value, container.key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
      container.key = null;
    }
  }
}

const UNSET = Symbol('unset');

function isOfficialChunkedMessage(message) {
  return (
    message !== null &&
    typeof message === 'object' &&
    message.marker === 'codex-host-chunked-message-v1' &&
    typeof message.transferId === 'string' &&
    Number.isSafeInteger(message.sequence) &&
    (message.kind === 'start' ||
      message.kind === 'end' ||
      (message.kind === 'chunk' && Array.isArray(message.tokens)))
  );
}

function requestTimeoutFromEnvironment() {
  const raw = process.env.SMOKE_REQUEST_TIMEOUT_MS;
  if (raw === undefined) return 120_000;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 600_000) {
    throw new Error('SMOKE_REQUEST_TIMEOUT_MS must be an integer between 1000 and 600000');
  }
  return parsed;
}

export function createIdentityHeaders({
  email,
  proxySecret,
  proxySecretHeader = 'X-Aialra-Proxy-Secret',
  subject,
  username,
}) {
  return {
    'X-Aialra-Authenticated': '1',
    [proxySecretHeader]: proxySecret,
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
