import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';

import { connectOfficialBridge, createIdentityHeaders } from './lib/official-bridge-client.mjs';

const action = process.env.SMOKE_PERSISTENCE_ACTION;
const baseUrl = process.env.SMOKE_BASE_URL;
const publicOrigin = process.env.SMOKE_PUBLIC_ORIGIN;
const proxySecret = process.env.SMOKE_PROXY_SECRET;
const stateFile = process.env.SMOKE_PERSISTENCE_STATE_FILE;
if (
  (action !== 'create' && action !== 'verify') ||
  baseUrl === undefined ||
  publicOrigin === undefined ||
  proxySecret === undefined ||
  stateFile === undefined
) {
  throw new Error(
    'SMOKE_PERSISTENCE_ACTION=create|verify, SMOKE_BASE_URL, SMOKE_PUBLIC_ORIGIN, SMOKE_PROXY_SECRET, and SMOKE_PERSISTENCE_STATE_FILE are required',
  );
}

const identityHeaders = createIdentityHeaders({
  email: 'host-persistence-smoke@example.invalid',
  proxySecret,
  subject: 'host-persistence-smoke-subject',
  username: 'host-persistence-smoke',
});
const bridge = await connectOfficialBridge({
  baseUrl,
  identityHeaders,
  publicOrigin,
});
let state;
let cleanupThreadId;

try {
  if (action === 'create') {
    const projectless = await bridge.desktopFetch('projectless-thread-cwd', {});
    const workspaceRoot = requiredString(projectless.workspaceRoot, 'projectless workspace root');
    const developerInstructions = await bridge.desktopFetch('developer-instructions', {
      cwd: workspaceRoot,
      hostId: 'local',
      threadId: null,
      threadToolsEnabled: false,
    });
    const marker = `CodexApp host persistence smoke ${randomUUID()}`;
    const started = await bridge.mcpRequest('thread/start', {
      cwd: workspaceRoot,
      developerInstructions: requiredString(
        developerInstructions.instructions,
        'developer instructions',
      ),
      ephemeral: false,
      experimentalRawEvents: false,
    });
    const threadId = requiredString(started?.thread?.id ?? started?.threadId, 'thread id');
    cleanupThreadId = threadId;
    await bridge.mcpRequest('turn/start', {
      threadId,
      input: [{ type: 'text', text: marker, text_elements: [] }],
    });
    await waitForThreadMarker(bridge, threadId, marker);
    await waitForListedThread(bridge, threadId, true);

    state = { marker, threadId };
    const temporaryStateFile = `${stateFile}.${process.pid}.tmp`;
    await writeFile(temporaryStateFile, `${JSON.stringify(state)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporaryStateFile, stateFile);
    cleanupThreadId = undefined;
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        action,
        threadCommitted: true,
        rendererVersion: bridge.bootstrap.rendererVersion,
      })}\n`,
    );
  } else {
    state = JSON.parse(await readFile(stateFile, 'utf8'));
    const threadId = requiredString(state.threadId, 'persisted thread id');
    const marker = requiredString(state.marker, 'persisted thread marker');
    cleanupThreadId = threadId;
    await waitForThreadMarker(bridge, threadId, marker);
    await waitForListedThread(bridge, threadId, true);
    await bridge.mcpRequest('thread/delete', { threadId });
    cleanupThreadId = undefined;
    await waitForListedThread(bridge, threadId, false);
    await rm(stateFile, { force: true });
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        action,
        browserReconnected: true,
        hostRestartRecovery: true,
        persistedTurnRecovered: true,
        syntheticThreadDeleted: true,
        rendererVersion: bridge.bootstrap.rendererVersion,
      })}\n`,
    );
  }
} finally {
  if (cleanupThreadId !== undefined) {
    await bridge.mcpRequest('thread/delete', { threadId: cleanupThreadId }).catch(() => undefined);
  }
  bridge.close();
}

async function waitForThreadMarker(client, threadId, marker) {
  let lastRead;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      lastRead = await client.mcpRequest('thread/read', { threadId, includeTurns: true });
      if (JSON.stringify(lastRead).includes(marker)) return lastRead;
    } catch {
      // A newly created thread can briefly precede its persisted rollout file.
    }
    await delay(100);
  }
  throw new Error(
    `persisted thread marker was not readable; last response bytes ${String(JSON.stringify(lastRead).length)}`,
  );
}

async function waitForListedThread(client, threadId, expectedPresent) {
  let lastIds = [];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const page = await client.mcpRequest('thread/list', {
      archived: false,
      limit: 100,
      sortKey: 'updated_at',
      sortDirection: 'desc',
    });
    const rows = page?.data ?? page?.threads;
    if (!Array.isArray(rows)) throw new Error('thread/list did not return a thread array');
    lastIds = rows.map((row) => row?.id ?? row?.threadId).filter((id) => typeof id === 'string');
    if (lastIds.includes(threadId) === expectedPresent) return;
    await delay(100);
  }
  throw new Error(
    `thread list presence did not become ${String(expectedPresent)}; observed ${String(lastIds.length)} thread ids`,
  );
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is missing`);
  return value;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
