import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import { CodexAppServerClient } from '../packages/app-server-client/dist/index.js';
import { resolveOfficialSharedModulePath } from '../packages/host-gateway/dist/official-shared-module.js';

const codexBin = requiredEnvironment('VERIFY_CODEX_BIN');
const codexHome = requiredEnvironment('VERIFY_CODEX_HOME');
const workspace = requiredEnvironment('VERIFY_WORKSPACE');
const officialSourceRoot = requiredEnvironment('VERIFY_OFFICIAL_SOURCE_ROOT');
const rendererVersion = process.env.VERIFY_RENDERER_VERSION ?? '26.721.81911';
const recordPaths = requiredEnvironment('VERIFY_RECORDS')
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value.length > 0);
if (recordPaths.length === 0) throw new Error('VERIFY_RECORDS must contain at least one path');

const expected = new Map();
for (const recordPath of recordPaths) {
  const migration = JSON.parse(await readFile(recordPath, 'utf8'));
  if (!Array.isArray(migration?.records))
    throw new Error(`migration records are missing: ${recordPath}`);
  for (const record of migration.records) {
    const threadId = requiredString(record?.threadId, 'migration thread id');
    const label = requiredString(record?.label, 'migration thread label');
    if (expected.has(threadId)) throw new Error(`duplicate migration thread: ${label}`);
    expected.set(threadId, label);
  }
}

const require = createRequire(import.meta.url);
const shared = require(resolveOfficialSharedModulePath(officialSourceRoot));
if (!Array.isArray(shared?.Fi)) throw new Error('official thread source filters are unavailable');

const client = new CodexAppServerClient({
  codexBin,
  codexHome,
  cwd: workspace,
  clientVersion: rendererVersion,
  extraArgs: ['-c', 'features.code_mode_host=true'],
  requestTimeoutMs: 60_000,
});
client.on('request', (event) => {
  void event.respond({
    error: {
      code: -32_600,
      message: `unexpected server request during thread catalog verification: ${event.request.method}`,
    },
  });
});

const startedAt = performance.now();
try {
  await client.start();
  const listed = new Set();
  let cursor = null;
  const observedCursors = new Set();
  do {
    const response = await client.request('thread/list', {
      archived: false,
      cursor,
      limit: 100,
      parentThreadId: null,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      sourceKinds: shared.Fi,
      useStateDbOnly: true,
    });
    const rows = response?.data ?? response?.threads;
    if (!Array.isArray(rows)) throw new Error('thread/list did not return an array');
    for (const row of rows) {
      const threadId = row?.id ?? row?.threadId;
      if (typeof threadId === 'string') listed.add(threadId);
    }
    cursor = response?.nextCursor ?? response?.next_cursor ?? null;
    if (cursor !== null && typeof cursor !== 'string')
      throw new Error('thread/list returned an invalid cursor');
    if (cursor !== null && observedCursors.has(cursor))
      throw new Error('thread/list repeated a cursor');
    if (cursor !== null) observedCursors.add(cursor);
  } while (cursor !== null);

  const missingLabels = [...expected]
    .filter(([threadId]) => !listed.has(threadId))
    .map(([, label]) => label)
    .sort();
  const unexpectedCount = [...listed].filter((threadId) => !expected.has(threadId)).length;
  if (missingLabels.length > 0 || unexpectedCount > 0 || listed.size !== expected.size) {
    throw new Error(
      `official thread catalog mismatch: missing=${missingLabels.join(',') || 'none'}, unexpected=${String(unexpectedCount)}, listed=${String(listed.size)}, expected=${String(expected.size)}`,
    );
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      rendererVersion,
      expected: expected.size,
      listed: listed.size,
      officialSourceFilters: shared.Fi.length,
      elapsedMs: Math.round(performance.now() - startedAt),
    })}\n`,
  );
} finally {
  await client.stop().catch(() => undefined);
}

function requiredEnvironment(name) {
  return requiredString(process.env[name], name);
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}
