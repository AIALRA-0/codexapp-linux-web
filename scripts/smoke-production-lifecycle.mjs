import { createHash, randomUUID } from 'node:crypto';

import { connectOfficialBridge, createIdentityHeaders } from './lib/official-bridge-client.mjs';

const baseUrl = requiredEnvironment('SMOKE_BASE_URL');
const publicOrigin = requiredEnvironment('SMOKE_PUBLIC_ORIGIN');
const proxySecret = requiredEnvironment('SMOKE_PROXY_SECRET');
const subject = requiredEnvironment('SMOKE_SUBJECT');
const username = requiredEnvironment('SMOKE_USERNAME');
const email = requiredEnvironment('SMOKE_EMAIL');
const protectedThreadId = process.env.SMOKE_PROTECTED_THREAD_ID;
const timeoutMs = positiveEnvironment('SMOKE_LIFECYCLE_TIMEOUT_MS', 180_000);

const bridge = await connectOfficialBridge({
  baseUrl,
  publicOrigin,
  identityHeaders: createIdentityHeaders({ email, proxySecret, subject, username }),
});

let sourceThreadId;
let forkThreadId;
const measurements = {};
const marker = `CodexApp lifecycle ${randomUUID()}`;

try {
  const projectless = await bridge.desktopFetch('projectless-thread-cwd', {});
  const cwd = requiredString(projectless.workspaceRoot, 'projectless workspace root');
  const protectedBefore = await protectedDigest(bridge, protectedThreadId);

  const startAt = performance.now();
  const started = await bridge.mcpRequest('thread/start', {
    cwd,
    ephemeral: false,
    historyMode: 'paginated',
    experimentalRawEvents: false,
  });
  measurements.startMs = elapsed(startAt);
  sourceThreadId = threadIdFrom(started);

  const firstCompletion = waitForTurnCompleted(bridge, sourceThreadId);
  const firstTurnAt = performance.now();
  await bridge.mcpRequest('turn/start', {
    threadId: sourceThreadId,
    input: [{ type: 'text', text: `Reply with exactly: ${marker}`, text_elements: [] }],
  });
  await firstCompletion;
  measurements.firstTurnMs = elapsed(firstTurnAt);
  await waitForListedThread(bridge, sourceThreadId, { archived: false, expected: true });

  const nameAt = performance.now();
  await bridge.mcpRequest('thread/name/set', { threadId: sourceThreadId, name: marker });
  await waitForListedThread(bridge, sourceThreadId, {
    archived: false,
    expected: true,
    searchTerm: marker,
  });
  measurements.renameAndSearchMs = elapsed(nameAt);

  const archiveAt = performance.now();
  await bridge.mcpRequest('thread/archive', { threadId: sourceThreadId });
  await waitForListedThread(bridge, sourceThreadId, { archived: true, expected: true });
  await bridge.mcpRequest('thread/unarchive', { threadId: sourceThreadId });
  await waitForListedThread(bridge, sourceThreadId, { archived: false, expected: true });
  measurements.archiveRestoreMs = elapsed(archiveAt);

  const metadata = await bridge.mcpRequest('thread/read', {
    threadId: sourceThreadId,
    includeTurns: false,
  });
  const path = metadata?.thread?.path ?? metadata?.path ?? null;
  const forkAt = performance.now();
  const forked = await bridge.mcpRequest('thread/fork', {
    threadId: sourceThreadId,
    path,
    cwd,
    ephemeral: false,
    threadSource: 'user',
  });
  forkThreadId = threadIdFrom(forked);
  if (forkThreadId === sourceThreadId) throw new Error('fork returned the source thread id');
  await bridge.mcpRequest('thread/resume', {
    threadId: forkThreadId,
    history: null,
    path: forked?.thread?.path ?? forked?.path ?? null,
    model: null,
    modelProvider: null,
    cwd: forked?.thread?.cwd ?? forked?.cwd ?? cwd,
    approvalPolicy: null,
    sandbox: null,
    config: null,
    personality: null,
    excludeTurns: true,
  });
  measurements.forkMs = elapsed(forkAt);

  const forkCompletion = waitForTurnCompleted(bridge, forkThreadId);
  const forkTurnAt = performance.now();
  await bridge.mcpRequest('turn/start', {
    threadId: forkThreadId,
    input: [{ type: 'text', text: 'Reply with exactly: LIFECYCLE_FORK_OK', text_elements: [] }],
  });
  await forkCompletion;
  measurements.forkTurnMs = elapsed(forkTurnAt);
  await waitForListedThread(bridge, forkThreadId, { archived: false, expected: true });

  await bridge.mcpRequest('thread/delete', { threadId: forkThreadId });
  await waitForListedThread(bridge, forkThreadId, { archived: false, expected: false });
  forkThreadId = undefined;
  await bridge.mcpRequest('thread/delete', { threadId: sourceThreadId });
  await waitForListedThread(bridge, sourceThreadId, { archived: false, expected: false });
  sourceThreadId = undefined;

  const protectedAfter = await protectedDigest(bridge, protectedThreadId);
  if (protectedBefore !== protectedAfter) {
    throw new Error('protected production thread changed during lifecycle smoke');
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      rendererVersion: bridge.bootstrap.rendererVersion,
      measurements,
      protectedThreadUnchanged: protectedThreadId === undefined ? null : true,
      paths: ['create', 'send', 'rename', 'search', 'archive', 'restore', 'fork', 'delete'],
      temporaryThreadsDeleted: true,
    })}\n`,
  );
} finally {
  if (forkThreadId !== undefined) {
    await bridge.mcpRequest('thread/delete', { threadId: forkThreadId }).catch(() => undefined);
  }
  if (sourceThreadId !== undefined) {
    await bridge.mcpRequest('thread/delete', { threadId: sourceThreadId }).catch(() => undefined);
  }
  bridge.close();
}

function waitForTurnCompleted(client, threadId) {
  return client.waitForNextViewMessage(
    (message) =>
      message?.type === 'mcp-notification' &&
      message.method === 'turn/completed' &&
      message.params?.threadId === threadId,
    timeoutMs,
  );
}

async function waitForListedThread(client, threadId, { archived, expected, searchTerm }) {
  let lastIds = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = await client.mcpRequest('thread/list', {
      archived,
      cursor: null,
      limit: 100,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      ...(searchTerm === undefined ? {} : { searchTerm }),
    });
    const rows = page?.data ?? page?.threads;
    if (!Array.isArray(rows)) throw new Error('thread/list did not return an array');
    lastIds = rows
      .map((row) => row?.id ?? row?.threadId)
      .filter((value) => typeof value === 'string');
    if (lastIds.includes(threadId) === expected) return;
    await delay(100);
  }
  throw new Error(
    `thread ${threadId} list state did not become ${String(expected)}; observed ${String(lastIds.length)}`,
  );
}

async function protectedDigest(client, threadId) {
  if (threadId === undefined) return undefined;
  const response = await client.mcpRequest('thread/turns/list', {
    threadId,
    cursor: null,
    limit: 5,
    itemsView: 'full',
    sortDirection: 'desc',
  });
  return createHash('sha256').update(JSON.stringify(response)).digest('hex');
}

function threadIdFrom(value) {
  return requiredString(value?.thread?.id ?? value?.threadId, 'thread id');
}

function elapsed(startedAt) {
  return Math.round(performance.now() - startedAt);
}

function requiredEnvironment(name) {
  return requiredString(process.env[name], name);
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is missing`);
  return value;
}

function positiveEnvironment(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 600_000) {
    throw new Error(`${name} must be between 1000 and 600000`);
  }
  return value;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
