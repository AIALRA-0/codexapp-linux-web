import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import { connectOfficialBridge, createIdentityHeaders } from './lib/official-bridge-client.mjs';

const baseUrl = requiredEnvironment('HANDOFF_BASE_URL');
const publicOrigin = requiredEnvironment('HANDOFF_PUBLIC_ORIGIN');
const proxySecret = requiredEnvironment('HANDOFF_PROXY_SECRET');
const proxySecretHeader = process.env.HANDOFF_PROXY_SECRET_HEADER ?? 'X-Aialra-Proxy-Secret';
const subject = requiredEnvironment('HANDOFF_SUBJECT');
const username = requiredEnvironment('HANDOFF_USERNAME');
const email = requiredEnvironment('HANDOFF_EMAIL');
const cwd = requiredEnvironment('HANDOFF_CWD');
const handoffPath = requiredEnvironment('HANDOFF_PATH');
const threadName = requiredEnvironment('HANDOFF_THREAD_NAME');
const archiveThreadId = process.env.HANDOFF_ARCHIVE_THREAD_ID;

await readFile(handoffPath, 'utf8');

const bridge = await connectOfficialBridge({
  baseUrl,
  publicOrigin,
  identityHeaders: createIdentityHeaders({
    email,
    proxySecret,
    proxySecretHeader,
    subject,
    username,
  }),
});

let threadId;
try {
  const developerInstructions = await bridge.desktopFetch('developer-instructions', {
    cwd,
    hostId: 'local',
    threadId: null,
    threadToolsEnabled: false,
  });
  const createdAt = performance.now();
  const started = await bridge.mcpRequest('thread/start', {
    cwd,
    developerInstructions: requiredString(
      developerInstructions.instructions,
      'developer instructions',
    ),
    ephemeral: false,
    experimentalRawEvents: false,
  });
  threadId = requiredString(started?.thread?.id ?? started?.threadId, 'thread id');
  const createMs = elapsed(createdAt);

  await bridge.mcpRequest('thread/name/set', { threadId, name: threadName });
  const turnCompleted = bridge.waitForViewMessage(
    (event) =>
      event?.type === 'mcp-notification' &&
      event.method === 'turn/completed' &&
      event.params?.threadId === threadId,
    1_800_000,
  );
  const firstOutput = bridge.waitForViewMessage(
    (event) =>
      event?.type === 'mcp-notification' &&
      event.params?.threadId === threadId &&
      (event.method === 'item/agentMessage/delta' ||
        (event.method === 'item/completed' && event.params?.item?.type === 'agentMessage')),
    1_800_000,
  );
  const acceptedAt = performance.now();
  await bridge.mcpRequest('turn/start', {
    threadId,
    cwd,
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'dangerFullAccess' },
    input: [
      {
        type: 'text',
        text: [
          '这是 CodexApp 的轻量续接主对话。',
          `请读取交接文件：${handoffPath}`,
          '本轮只完成接管核对，不实施升级，不修改 A、B，不读取整条旧对话。',
          '请核对服务器版本、旧对话大小与 SHA-256、Git 分支分叉状态和测试门禁。',
          '完成后用简短中文汇报，并在末行写：WAIT_FOR_NEXT_PHASE',
        ].join('\n'),
        text_elements: [],
      },
    ],
  });
  const acceptMs = elapsed(acceptedAt);
  await firstOutput;
  const firstOutputMs = elapsed(acceptedAt);
  await turnCompleted;
  const completedMs = elapsed(acceptedAt);

  // The official app-server derives a title from the first user message after
  // thread creation. Apply the operator-provided handoff title afterwards so
  // that automatic title generation cannot overwrite it.
  await bridge.mcpRequest('thread/name/set', { threadId, name: threadName });

  await waitForListedThread(bridge, threadId, false, true);
  if (archiveThreadId !== undefined && archiveThreadId.length > 0) {
    await bridge.mcpRequest('thread/archive', { threadId: archiveThreadId });
    await waitForListedThread(bridge, archiveThreadId, true, true);
  }

  const persisted = await bridge.mcpRequest('thread/read', {
    threadId,
    includeTurns: true,
  });
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      threadId,
      threadName,
      archivedThreadId: archiveThreadId ?? null,
      persisted: JSON.stringify(persisted).includes('WAIT_FOR_NEXT_PHASE'),
      timingsMs: {
        create: createMs,
        accept: acceptMs,
        firstOutput: firstOutputMs,
        completed: completedMs,
      },
    })}\n`,
  );
} finally {
  bridge.close();
}

async function waitForListedThread(client, targetThreadId, archived, expectedPresent) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const page = await client.mcpRequest('thread/list', {
      archived,
      limit: 100,
      sortKey: 'updated_at',
      sortDirection: 'desc',
    });
    const rows = page?.data ?? page?.threads;
    if (!Array.isArray(rows)) throw new Error('thread/list did not return a thread array');
    const present = rows.some((row) => (row?.id ?? row?.threadId) === targetThreadId);
    if (present === expectedPresent) return;
    await delay(100);
  }
  throw new Error(`thread list did not reach archived=${String(archived)}`);
}

function elapsed(startedAt) {
  return Math.round(performance.now() - startedAt);
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is missing`);
  return value;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
