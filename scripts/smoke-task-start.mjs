import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';

import WebSocket from 'ws';

const baseUrl = process.env.SMOKE_BASE_URL;
const publicOrigin = process.env.SMOKE_PUBLIC_ORIGIN;
const proxySecret = process.env.SMOKE_PROXY_SECRET;
if (baseUrl === undefined || publicOrigin === undefined || proxySecret === undefined) {
  throw new Error('SMOKE_BASE_URL, SMOKE_PUBLIC_ORIGIN, and SMOKE_PROXY_SECRET are required');
}

const identityHeaders = {
  'X-Aialra-Authenticated': '1',
  'X-Aialra-Proxy-Secret': proxySecret,
  'X-Aialra-Sub': 'task-start-smoke-subject',
  'X-Aialra-User': 'task-start-smoke',
  'X-Aialra-Email': 'task-start-smoke@example.invalid',
  'X-Aialra-Groups': 'aialra:access:codexapp,aialra:role:developer',
};

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
let createdDirectory = null;
let workspaceRoot = null;

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

try {
  await withTimeout(ready.promise, 30_000, 'bridge ready');
  await command({ type: 'ready' });

  const projectless = await desktopFetch('projectless-thread-cwd', {});
  workspaceRoot = requiredString(projectless.workspaceRoot, 'projectless workspace root');
  const smokeId = randomUUID();
  createdDirectory = `${workspaceRoot}/.codexapp-smoke-${smokeId}`;
  await desktopFetch('ensure-directory', {
    hostId: 'local',
    path: createdDirectory,
  });
  const gitOrigins = await desktopFetch('git-origins', {
    dirs: [workspaceRoot],
    hostId: 'local',
  });
  if (!Array.isArray(gitOrigins.origins) || gitOrigins.homeDir !== workspaceRoot) {
    throw new Error('Git origins adapter returned an invalid response');
  }
  const mcpConfig = await desktopFetch('mcp-codex-config', { cwd: workspaceRoot });
  if (!Object.hasOwn(mcpConfig, 'config')) {
    throw new Error('MCP Codex config response is missing config');
  }
  const developerInstructions = await desktopFetch('developer-instructions', {
    cwd: workspaceRoot,
    hostId: 'local',
    threadId: null,
    threadToolsEnabled: false,
  });
  const instructions = requiredString(developerInstructions.instructions, 'developer instructions');

  const started = await mcpRequest('thread/start', {
    cwd: workspaceRoot,
    developerInstructions: instructions,
    ephemeral: true,
    experimentalRawEvents: false,
  });
  const threadId = requiredString(started?.thread?.id ?? started?.threadId, 'thread id');
  const turn = await mcpRequest('turn/start', {
    threadId,
    input: [
      {
        type: 'text',
        text: 'CodexApp official browser host task-start smoke.',
        text_elements: [],
      },
    ],
  });
  await mcpRequest('thread/read', { threadId, includeTurns: false });

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      rendererVersion: bootstrap.rendererVersion,
      adapters: [
        'projectless-thread-cwd',
        'ensure-directory',
        'git-origins',
        'mcp-codex-config',
        'developer-instructions',
      ],
      appServer: ['thread/start', 'turn/start', 'thread/read'],
      gitOriginCount: gitOrigins.origins.length,
      turnAccepted: turn !== null,
    })}\n`,
  );
} finally {
  socket.close(1000, 'smoke complete');
  if (
    workspaceRoot !== null &&
    createdDirectory !== null &&
    isPathWithin(workspaceRoot, createdDirectory)
  ) {
    await rm(createdDirectory, { force: true, recursive: true });
  }
}

async function command(message) {
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
}

async function desktopFetch(method, params) {
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
}

async function mcpRequest(method, params) {
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
}

function send(frame) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
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

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is missing`);
  return value;
}

function isPathWithin(root, candidate) {
  const difference = relative(root, candidate);
  return (
    difference === '' ||
    (difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference))
  );
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
