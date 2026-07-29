import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import { CodexAppServerClient } from '../packages/app-server-client/dist/index.js';

const codexBin = requiredEnvironment('SMOKE_CODEX_BIN');
const codexHome = requiredEnvironment('SMOKE_CODEX_HOME');
const threadId = requiredEnvironment('SMOKE_THREAD_ID');
const rolloutPath = process.env.SMOKE_ROLLOUT_PATH;
const workspace = process.env.SMOKE_WORKSPACE ?? process.cwd();
const includeFullRead = process.env.SMOKE_INCLUDE_FULL_READ === '1';
const rendererVersion = process.env.SMOKE_RENDERER_VERSION ?? '26.721.31836';

const client = new CodexAppServerClient({
  codexBin,
  codexHome,
  cwd: workspace,
  clientVersion: rendererVersion,
  extraArgs: ['-c', 'features.code_mode_host=true'],
  requestTimeoutMs: 180_000,
});
client.on('request', (event) => {
  void event.respond({
    error: {
      code: -32_600,
      message: `unexpected server request during large-thread smoke: ${event.request.method}`,
    },
  });
});

const measurements = {};
try {
  await measure('startup', () => client.start());
  await measure('listRecent20', () =>
    client.request('thread/list', {
      archived: false,
      limit: 20,
      sortKey: 'updated_at',
      sortDirection: 'desc',
    }),
  );
  await measure('readMetadataOnly', () =>
    client.request('thread/read', { threadId, includeTurns: false }),
  );
  await measure('resumeRecent10Summary', () =>
    client.request('thread/resume', {
      threadId,
      ...(rolloutPath === undefined ? {} : { path: rolloutPath }),
      excludeTurns: true,
      initialTurnsPage: {
        limit: 10,
        sortDirection: 'desc',
        itemsView: 'summary',
      },
    }),
  );
  const recentPage = await measure('turnsRecent10Summary', () =>
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
    await measure('turnsPrevious10Summary', () =>
      client.request('thread/turns/list', {
        threadId,
        cursor,
        limit: 10,
        sortDirection: 'desc',
        itemsView: 'summary',
      }),
    );
  }
  if (includeFullRead) {
    await measure('readAllTurns', () =>
      client.request('thread/read', { threadId, includeTurns: true }, 300_000),
    );
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      threadId,
      includeFullRead,
      measurements,
    })}\n`,
  );
} finally {
  await client.stop().catch(() => undefined);
}

async function measure(name, operation) {
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
