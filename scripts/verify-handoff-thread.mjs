import { performance } from 'node:perf_hooks';

import { connectOfficialBridge, createIdentityHeaders } from './lib/official-bridge-client.mjs';

const baseUrl = requiredEnvironment('HANDOFF_BASE_URL');
const publicOrigin = requiredEnvironment('HANDOFF_PUBLIC_ORIGIN');
const proxySecret = requiredEnvironment('HANDOFF_PROXY_SECRET');
const proxySecretHeader = process.env.HANDOFF_PROXY_SECRET_HEADER ?? 'X-Aialra-Proxy-Secret';
const subject = requiredEnvironment('HANDOFF_SUBJECT');
const username = requiredEnvironment('HANDOFF_USERNAME');
const email = requiredEnvironment('HANDOFF_EMAIL');
const threadId = requiredEnvironment('HANDOFF_THREAD_ID');
const archivedThreadId = requiredEnvironment('HANDOFF_ARCHIVED_THREAD_ID');
const threadName = requiredEnvironment('HANDOFF_THREAD_NAME');

const identityHeaders = createIdentityHeaders({
  email,
  proxySecret,
  proxySecretHeader,
  subject,
  username,
});

const control = await connectOfficialBridge({ baseUrl, publicOrigin, identityHeaders });
try {
  await control.mcpRequest('thread/name/set', { threadId, name: threadName });
  await requireListed(control, threadId, false);
  await requireListed(control, archivedThreadId, true);
} finally {
  control.close();
}

const opens = [];
for (let iteration = 1; iteration <= 5; iteration += 1) {
  const connectStartedAt = performance.now();
  const bridge = await connectOfficialBridge({ baseUrl, publicOrigin, identityHeaders });
  const connectedAt = performance.now();
  try {
    const readStartedAt = performance.now();
    const result = await bridge.mcpRequest('thread/read', { threadId, includeTurns: true });
    const readCompletedAt = performance.now();
    const thread = result?.thread ?? result;
    const returnedThreadId = thread?.id ?? thread?.threadId;
    if (returnedThreadId !== threadId) throw new Error('thread/read returned a different thread');
    const serialized = JSON.stringify(result);
    if (!serialized.includes('WAIT_FOR_NEXT_PHASE')) {
      throw new Error('persisted handoff marker is missing');
    }
    const turns = Array.isArray(thread?.turns) ? thread.turns : [];
    opens.push({
      iteration,
      connectMs: Math.round(connectedAt - connectStartedAt),
      readMs: Math.round(readCompletedAt - readStartedAt),
      totalMs: Math.round(readCompletedAt - connectStartedAt),
      resultBytes: Buffer.byteLength(serialized),
      turnCount: turns.length,
    });
  } finally {
    bridge.close();
  }
}

process.stdout.write(
  `${JSON.stringify({ ok: true, threadId, archivedThreadId, threadName, opens })}\n`,
);

async function requireListed(bridge, targetThreadId, archived) {
  const page = await bridge.mcpRequest('thread/list', {
    archived,
    limit: 100,
    sortKey: 'updated_at',
    sortDirection: 'desc',
  });
  const rows = page?.data ?? page?.threads;
  if (!Array.isArray(rows)) throw new Error('thread/list did not return a thread array');
  if (!rows.some((row) => (row?.id ?? row?.threadId) === targetThreadId)) {
    throw new Error(`thread ${targetThreadId} is missing from archived=${String(archived)}`);
  }
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}
