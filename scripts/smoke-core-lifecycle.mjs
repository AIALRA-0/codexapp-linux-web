import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { CodexAppServerClient } from '../packages/app-server-client/dist/index.js';

const codexBin = process.env.SMOKE_CODEX_BIN;
if (codexBin === undefined) throw new Error('SMOKE_CODEX_BIN is required');

const rendererVersion = process.env.SMOKE_RENDERER_VERSION ?? '26.730.61639';
const root = await mkdtemp(join(tmpdir(), 'codex-core-lifecycle-'));
const codexHome = join(root, 'codex-home');
const workspace = join(root, 'workspace');
await Promise.all([
  mkdir(codexHome, { recursive: true, mode: 0o700 }),
  mkdir(workspace, { recursive: true, mode: 0o700 }),
]);

function createClient() {
  const client = new CodexAppServerClient({
    codexBin,
    codexHome,
    cwd: workspace,
    clientVersion: rendererVersion,
    extraArgs: ['-c', 'features.code_mode_host=true'],
    requestTimeoutMs: 30_000,
  });
  client.on('request', (event) => {
    void event.respond({
      error: {
        code: -32_600,
        message: `unexpected server request during lifecycle smoke: ${event.request.method}`,
      },
    });
  });
  return client;
}

function waitForTurnCompleted(client, threadId, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      client.off('notification', onNotification);
      reject(new Error(`turn/completed timed out for ${threadId}`));
    }, timeoutMs);
    const onNotification = (notification) => {
      if (
        notification?.method !== 'turn/completed' ||
        notification?.params?.threadId !== threadId
      ) {
        return;
      }
      clearTimeout(timeout);
      client.off('notification', onNotification);
      resolve(notification.params);
    };
    client.on('notification', onNotification);
  });
}

function threadIdFrom(value) {
  const threadId = value?.thread?.id ?? value?.threadId;
  if (typeof threadId !== 'string' || threadId.length === 0) {
    throw new Error('thread/start did not return a thread id');
  }
  return threadId;
}

function listedThreadIds(value) {
  const rows = value?.data ?? value?.threads;
  if (!Array.isArray(rows)) throw new Error('thread/list did not return a thread array');
  return rows.map((row) => row?.id ?? row?.threadId).filter((id) => typeof id === 'string');
}

async function readPaginatedThread(client, threadId) {
  const metadata = await client.request('thread/read', { threadId, includeTurns: false });
  const resumed = await client.request('thread/resume', {
    threadId,
    excludeTurns: true,
  });
  const cursor = resumed?.turnsBackwardsCursor;
  if (typeof cursor !== 'string' || cursor.length === 0) {
    throw new Error('paginated thread resume did not return a turns cursor');
  }
  const page = await client.request('thread/turns/list', {
    threadId,
    cursor,
    limit: 5,
    itemsView: 'notLoaded',
    sortDirection: 'desc',
  });
  const turns = page?.data ?? page?.turns;
  if (!Array.isArray(turns) || turns.length === 0) {
    throw new Error('paginated thread did not return its first turn');
  }
  return metadata;
}

async function waitForListedThread(client, threadId, { archived, expected = true, searchTerm }) {
  let lastIds = [];
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const page = await client.request('thread/list', {
      archived,
      limit: 20,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      ...(searchTerm === undefined ? {} : { searchTerm }),
    });
    lastIds = listedThreadIds(page);
    if (lastIds.includes(threadId) === expected) return page;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `${archived ? 'archived' : 'active'} thread list presence did not become ${String(expected)}; observed ${String(lastIds.length)} thread ids`,
  );
}

let firstClient;
let secondClient;
let completed = false;
try {
  firstClient = createClient();
  const firstStartupAt = performance.now();
  await firstClient.start();
  const firstStartupMs = performance.now() - firstStartupAt;

  const startAt = performance.now();
  const started = await firstClient.request('thread/start', {
    cwd: workspace,
    ephemeral: false,
    historyMode: 'paginated',
    experimentalRawEvents: false,
  });
  const startMs = performance.now() - startAt;
  const threadId = threadIdFrom(started);
  if (started?.thread?.historyMode !== 'paginated') {
    throw new Error('new durable thread did not use official paginated history');
  }

  let turnStartOutcome = 'accepted';
  const firstTurnCompleted = waitForTurnCompleted(firstClient, threadId);
  try {
    await firstClient.request('turn/start', {
      threadId,
      input: [
        {
          type: 'text',
          text: 'CodexApp official host lifecycle persistence smoke.',
          text_elements: [],
        },
      ],
    });
    await firstTurnCompleted;
  } catch (error) {
    turnStartOutcome = error instanceof Error ? `rejected: ${error.message}` : 'rejected';
  }

  const readAt = performance.now();
  let read;
  let lastReadError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      read = await readPaginatedThread(firstClient, threadId);
      break;
    } catch (error) {
      lastReadError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const readMs = performance.now() - readAt;
  if (read === undefined) {
    throw lastReadError ?? new Error('thread was not materialized by the first user message');
  }
  if ((read?.thread?.id ?? read?.id) !== threadId) {
    throw new Error('thread/read returned another thread');
  }

  const listAt = performance.now();
  const activeList = await waitForListedThread(firstClient, threadId, { archived: false });
  const listMs = performance.now() - listAt;
  if (!listedThreadIds(activeList).includes(threadId)) {
    throw new Error('new thread is absent from the active thread list');
  }

  await firstClient.request('thread/archive', { threadId });
  const archivedList = await waitForListedThread(firstClient, threadId, { archived: true });
  if (!listedThreadIds(archivedList).includes(threadId)) {
    throw new Error('archived thread is absent from the archive');
  }
  await firstClient.stop();
  firstClient = undefined;

  secondClient = createClient();
  const restartAt = performance.now();
  await secondClient.start();
  const restartMs = performance.now() - restartAt;
  const recovered = await secondClient.request('thread/read', {
    threadId,
    includeTurns: false,
  });
  if ((recovered?.thread?.id ?? recovered?.id) !== threadId) {
    throw new Error('thread did not survive an app-server restart');
  }
  if (recovered?.thread?.historyMode !== 'paginated') {
    throw new Error('paginated history mode did not survive an app-server restart');
  }
  await secondClient.request('thread/unarchive', { threadId });
  const restoredList = await waitForListedThread(secondClient, threadId, { archived: false });
  if (!listedThreadIds(restoredList).includes(threadId)) {
    throw new Error('unarchived thread did not return to the active list');
  }
  await readPaginatedThread(secondClient, threadId);
  const searchMarker = `CodexApp lifecycle ${randomUUID()}`;
  await secondClient.request('thread/name/set', { threadId, name: searchMarker });
  const searchAt = performance.now();
  const searchList = await waitForListedThread(secondClient, threadId, {
    archived: false,
    searchTerm: searchMarker,
  });
  const searchMs = performance.now() - searchAt;
  if (!listedThreadIds(searchList).includes(threadId)) {
    throw new Error('named thread was absent from exact history search');
  }

  const forkAt = performance.now();
  const forked = await secondClient.request('thread/fork', {
    threadId,
    path: null,
    cwd: workspace,
    ephemeral: false,
    threadSource: 'user',
  });
  const forkMs = performance.now() - forkAt;
  const forkedThreadId = threadIdFrom(forked);
  if (forkedThreadId === threadId) {
    throw new Error('thread/fork returned the source thread id');
  }
  const forkedRead = await readPaginatedThread(secondClient, forkedThreadId);
  if ((forkedRead?.thread?.id ?? forkedRead?.id) !== forkedThreadId) {
    throw new Error('forked thread could not be read back');
  }
  if (forkedRead?.thread?.historyMode !== 'paginated') {
    throw new Error('forked thread did not preserve official paginated history');
  }
  const forkTurnCompleted = waitForTurnCompleted(secondClient, forkedThreadId);
  await secondClient.request('turn/start', {
    threadId: forkedThreadId,
    input: [
      {
        type: 'text',
        text: 'CodexApp official host paginated fork smoke.',
        text_elements: [],
      },
    ],
  });
  await forkTurnCompleted;
  await secondClient.request('thread/name/set', {
    threadId: forkedThreadId,
    name: `${searchMarker} fork`,
  });
  await waitForListedThread(secondClient, forkedThreadId, { archived: false });
  await secondClient.request('thread/delete', { threadId: forkedThreadId });
  await waitForListedThread(secondClient, forkedThreadId, {
    archived: false,
    expected: false,
  });

  await secondClient.request('thread/delete', { threadId });
  await waitForListedThread(secondClient, threadId, {
    archived: false,
    expected: false,
  });

  const budgets = {
    firstStartupMs: 15_000,
    restartMs: 15_000,
    startMs: 5_000,
    readMs: 2_000,
    listMs: 2_000,
    searchMs: 2_000,
    forkMs: 5_000,
  };
  const observed = { firstStartupMs, restartMs, startMs, readMs, listMs, searchMs, forkMs };
  for (const [metric, budget] of Object.entries(budgets)) {
    if (observed[metric] > budget) {
      throw new Error(`${metric} exceeded ${String(budget)}ms: ${String(observed[metric])}ms`);
    }
  }

  completed = true;
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      lifecycle: [
        'start',
        'read',
        'list',
        'archive',
        'restart',
        'read',
        'unarchive',
        'name',
        'search',
        'fork',
        'read-fork',
        'list-fork',
        'delete-fork',
        'delete',
      ],
      turnStartOutcome,
      historyMode: 'paginated',
      milliseconds: Object.fromEntries(
        Object.entries(observed).map(([key, value]) => [key, Math.round(value)]),
      ),
    })}\n`,
  );
} finally {
  await firstClient?.stop().catch(() => undefined);
  await secondClient?.stop().catch(() => undefined);
  if (completed || process.env.SMOKE_KEEP_ROOT !== '1') {
    await rm(root, { force: true, recursive: true });
  } else {
    process.stderr.write(`smoke root retained at ${root}\n`);
  }
}
