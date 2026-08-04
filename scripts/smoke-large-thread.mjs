import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import { CodexAppServerClient } from '../packages/app-server-client/dist/index.js';

const codexBin = requiredEnvironment('SMOKE_CODEX_BIN');
const codexHome = requiredEnvironment('SMOKE_CODEX_HOME');
const threadId = requiredEnvironment('SMOKE_THREAD_ID');
const threadLabel = process.env.SMOKE_THREAD_LABEL ?? 'private-large-thread';
const rolloutPath = process.env.SMOKE_ROLLOUT_PATH;
const workspace = process.env.SMOKE_WORKSPACE ?? process.cwd();
const includeFullRead = process.env.SMOKE_INCLUDE_FULL_READ === '1';
const includeLegacyComparison = process.env.SMOKE_INCLUDE_LEGACY_COMPARISON === '1';
const rendererVersion = process.env.SMOKE_RENDERER_VERSION ?? '26.727.51351';

const client = new CodexAppServerClient({
  codexBin,
  codexHome,
  cwd: workspace,
  clientVersion: rendererVersion,
  extraArgs: ['-c', 'features.code_mode_host=true'],
  requestTimeoutMs: 180_000,
});
const appServerStderr = [];
let appServerError;
let activeMeasurement = 'startup';
client.on('request', (event) => {
  void event.respond({
    error: {
      code: -32_600,
      message: `unexpected server request during large-thread smoke: ${event.request.method}`,
    },
  });
});
client.on('stderr', (line) => {
  appServerStderr.push(safeDiagnostic(line));
  if (appServerStderr.length > 20) appServerStderr.shift();
});
client.on('error', (error) => {
  appServerError = error;
});

const measurements = {};
try {
  await measure('startup', () => client.start());
  const listed = await measure('listRecent20', () =>
    client.request('thread/list', {
      archived: false,
      limit: 20,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      useStateDbOnly: true,
    }),
  );
  const metadata = await measure('readMetadataOnly', () =>
    client.request('thread/read', { threadId, includeTurns: false }),
  );
  const listedThread = threadRowsFrom(listed).find((thread) => thread?.id === threadId);
  const historyMode =
    stringValue(listedThread?.historyMode) ??
    stringValue(metadata?.thread?.historyMode) ??
    'legacy';
  const paginatedHistory = historyMode === 'paginated';
  const resumed = await measure('latestRendererResume', () =>
    client.request('thread/resume', {
      threadId,
      ...(rolloutPath === undefined ? {} : { path: rolloutPath }),
      excludeTurns: true,
      ...(paginatedHistory
        ? {}
        : {
            initialTurnsPage: {
              limit: 5,
              sortDirection: 'desc',
              itemsView: 'full',
            },
          }),
    }),
  );
  const rendererHistory =
    paginatedHistory && stringValue(resumed?.turnsBackwardsCursor) !== null
      ? await measure('latestRendererTurnsAndItems', () =>
          hydrateLatestPaginatedHistory(client, threadId, resumed),
        )
      : summarizeInitialPage(resumed?.initialTurnsPage);
  if (includeLegacyComparison) {
    const recentPage = await measure('legacyTurnsRecent10Summary', () =>
      client.request('thread/turns/list', {
        threadId,
        cursor: null,
        limit: 10,
        sortDirection: 'desc',
        itemsView: 'summary',
      }),
    );
    const cursor = nextCursorFrom(recentPage);
    if (cursor !== null) {
      await measure('legacyTurnsPrevious10Summary', () =>
        client.request('thread/turns/list', {
          threadId,
          cursor,
          limit: 10,
          sortDirection: 'desc',
          itemsView: 'summary',
        }),
      );
    }
  }
  if (includeFullRead) {
    await measure('readAllTurns', () =>
      client.request('thread/read', { threadId, includeTurns: true }, 300_000),
    );
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      threadLabel,
      rendererVersion,
      historyMode,
      rendererHistory,
      includeFullRead,
      includeLegacyComparison,
      measurements,
    })}\n`,
  );
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      failedMeasurement: activeMeasurement,
      error: error instanceof Error ? error.message : String(error),
      appServerError: appServerError instanceof Error ? appServerError.message : undefined,
      appServerStderr,
    })}\n`,
  );
  process.exitCode = 1;
} finally {
  await client.stop().catch(() => undefined);
}

async function hydrateLatestPaginatedHistory(appServer, id, resumed) {
  const turnsCursor = stringValue(resumed?.turnsBackwardsCursor);
  const itemsCursor = stringValue(resumed?.itemsBackwardsCursor);
  if (turnsCursor === null) {
    return { turns: 0, items: 0, nextCursor: null, fullyHydratedTurns: 0 };
  }
  const page = await appServer.request('thread/turns/list', {
    threadId: id,
    cursor: turnsCursor,
    limit: 5,
    itemsView: 'notLoaded',
    sortDirection: 'desc',
  });
  const turns = threadRowsFrom(page);
  let remainingItems = 500;
  let items = 0;
  let fullyHydratedTurns = 0;
  for (const turn of turns) {
    const turnId = stringValue(turn?.id);
    if (turnId === null || remainingItems === 0) continue;
    let cursor = itemsCursor;
    const seenCursors = new Set();
    const seenItems = new Set();
    let requestedPage = false;
    while ((!requestedPage || cursor !== null) && remainingItems > 0) {
      if (seenCursors.has(cursor)) {
        throw new Error(`thread/items/list repeated a cursor for turn ${turnId}`);
      }
      seenCursors.add(cursor);
      requestedPage = true;
      const itemPage = await appServer.request('thread/items/list', {
        threadId: id,
        turnId,
        cursor,
        limit: Math.min(100, remainingItems),
        sortDirection: 'desc',
      });
      const rows = threadRowsFrom(itemPage);
      for (const row of rows) {
        const itemId = stringValue(row?.item?.id);
        if (itemId !== null && seenItems.has(itemId)) continue;
        if (itemId !== null) seenItems.add(itemId);
        items += 1;
        remainingItems -= 1;
      }
      cursor = nextCursorFrom(itemPage);
    }
    if (cursor === null) fullyHydratedTurns += 1;
  }
  return {
    turns: turns.length,
    items,
    nextCursor: nextCursorFrom(page),
    fullyHydratedTurns,
  };
}

function summarizeInitialPage(value) {
  const turns = threadRowsFrom(value);
  return {
    turns: turns.length,
    items: turns.reduce(
      (count, turn) => count + (Array.isArray(turn?.items) ? turn.items.length : 0),
      0,
    ),
    nextCursor: nextCursorFrom(value),
    fullyHydratedTurns: turns.filter((turn) => turn?.itemsView === 'full').length,
  };
}

function threadRowsFrom(value) {
  const rows = value?.data ?? value?.threads;
  return Array.isArray(rows) ? rows : [];
}

function stringValue(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function measure(name, operation) {
  activeMeasurement = name;
  let sampling = true;
  let appServerTreePeakRssBytes = 0;
  const sampler = (async () => {
    while (sampling) {
      appServerTreePeakRssBytes = Math.max(
        appServerTreePeakRssBytes,
        await processTreeRssBytes(client.pid),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();
  const startedAt = performance.now();
  try {
    const result = await operation();
    const milliseconds = Math.round(performance.now() - startedAt);
    const encodedBytes = Buffer.byteLength(JSON.stringify(result ?? null));
    sampling = false;
    await sampler;
    const appServerTreeRssBytes = await processTreeRssBytes(client.pid);
    measurements[name] = {
      milliseconds,
      encodedBytes,
      appServerTreeRssBytes,
      appServerTreePeakRssBytes: Math.max(appServerTreePeakRssBytes, appServerTreeRssBytes),
      hostRssBytes: process.memoryUsage().rss,
    };
    return result;
  } finally {
    sampling = false;
    await sampler;
  }
}

async function processTreeRssBytes(rootPid) {
  if (rootPid === undefined) return 0;
  const pending = [rootPid];
  const visited = new Set();
  let total = 0;
  while (pending.length > 0) {
    const pid = pending.pop();
    if (pid === undefined || visited.has(pid)) continue;
    visited.add(pid);
    total += await processRssBytes(pid);
    try {
      const children = await readFile(`/proc/${String(pid)}/task/${String(pid)}/children`, 'utf8');
      for (const child of children.trim().split(/\s+/u)) {
        const childPid = Number.parseInt(child, 10);
        if (Number.isSafeInteger(childPid)) pending.push(childPid);
      }
    } catch {
      // A short-lived process may exit between samples.
    }
  }
  return total;
}

async function processRssBytes(pid) {
  try {
    const status = await readFile(`/proc/${String(pid)}/status`, 'utf8');
    const match = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(status);
    return match === null ? 0 : Number.parseInt(match[1], 10) * 1024;
  } catch {
    return 0;
  }
}

function nextCursorFrom(value) {
  const cursor = value?.nextCursor ?? value?.next_cursor;
  return typeof cursor === 'string' && cursor.length > 0 ? cursor : null;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function safeDiagnostic(value) {
  return String(value)
    .replaceAll(/\/srv\/aialra\/state\/codexapp-official\/(?:users\/)?[^/\s:]+/gu, '[state-path]')
    .replaceAll(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/giu, '[thread-id]')
    .replaceAll(/\b[0-9a-f]{40,}\b/giu, '[secret-redacted]')
    .replaceAll(
      /\b(authorization|cookie|token|secret|password)\b(\s*[:=]\s*)\S+/giu,
      '$1$2[secret-redacted]',
    )
    .slice(0, 500);
}
