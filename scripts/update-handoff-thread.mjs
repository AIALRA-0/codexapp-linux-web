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
const threadId = requiredEnvironment('HANDOFF_THREAD_ID');
const threadName = requiredEnvironment('HANDOFF_THREAD_NAME');
const expectedCommit = requiredEnvironment('HANDOFF_EXPECTED_COMMIT');
const completionMarker = `HANDOFF_SYNCED_${expectedCommit}`;

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

try {
  const before = await bridge.mcpRequest('thread/read', { threadId, includeTurns: false });
  const returnedThreadId = before?.thread?.id ?? before?.threadId ?? before?.id;
  if (returnedThreadId !== threadId) throw new Error('thread/read returned a different thread');

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
          '这是 CodexApp 轻量续接主对话的交接同步轮次。',
          `请重新读取交接文件：${handoffPath}`,
          `请确认项目当前 Git HEAD 是 ${expectedCommit}。`,
          '只更新本对话的工作上下文并核对现状；不要升级 A 或 B，不要修改生产服务，不要读取整条 349MB 旧对话。',
          '请用简短中文说明：当前三套环境、已通过项目、仍阻断 B 升级的问题、下一步唯一允许的工作。',
          `最后一行必须写：${completionMarker}`,
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

  await bridge.mcpRequest('thread/name/set', { threadId, name: threadName });
  const persisted = await bridge.mcpRequest('thread/read', { threadId, includeTurns: true });
  const markerPersisted = JSON.stringify(persisted).includes(completionMarker);
  if (!markerPersisted)
    throw new Error('handoff completion marker is missing after turn completion');

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      expectedCommit,
      markerPersisted,
      timingsMs: {
        accept: acceptMs,
        firstOutput: firstOutputMs,
        completed: completedMs,
      },
    })}\n`,
  );
} finally {
  bridge.close();
}

function elapsed(startedAt) {
  return Math.round(performance.now() - startedAt);
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required`);
  return value;
}
