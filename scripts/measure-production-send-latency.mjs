import { performance } from 'node:perf_hooks';

import { connectOfficialBridge, createIdentityHeaders } from './lib/official-bridge-client.mjs';

const baseUrl = requiredEnvironment('SMOKE_BASE_URL');
const publicOrigin = requiredEnvironment('SMOKE_PUBLIC_ORIGIN');
const proxySecret = requiredEnvironment('SMOKE_PROXY_SECRET');
const proxySecretHeader = process.env.SMOKE_PROXY_SECRET_HEADER ?? 'X-Aialra-Proxy-Secret';
const subject = requiredEnvironment('SMOKE_SUBJECT');
const username = requiredEnvironment('SMOKE_USERNAME');
const email = requiredEnvironment('SMOKE_EMAIL');

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
let threadId = null;

try {
  const projectless = await bridge.desktopFetch('projectless-thread-cwd', {});
  const workspaceRoot = requiredString(projectless.workspaceRoot, 'projectless workspace root');
  const developerInstructions = await bridge.desktopFetch('developer-instructions', {
    cwd: workspaceRoot,
    hostId: 'local',
    threadId: null,
    threadToolsEnabled: false,
  });
  const prewarmStartedAt = performance.now();
  const started = await bridge.prewarmThreadStart({
    cwd: workspaceRoot,
    developerInstructions: requiredString(
      developerInstructions.instructions,
      'developer instructions',
    ),
    dynamicTools: [],
    ephemeral: true,
    experimentalRawEvents: false,
  });
  const prewarmMs = elapsed(prewarmStartedAt);
  threadId = requiredString(started?.thread?.id ?? started?.threadId, 'thread id');

  const turnStarted = bridge.waitForViewMessage(
    (message) =>
      message?.type === 'mcp-notification' &&
      message.method === 'turn/started' &&
      message.params?.threadId === threadId,
    300_000,
  );
  const firstVisibleOutput = bridge.waitForViewMessage(
    (message) =>
      message?.type === 'mcp-notification' &&
      message.params?.threadId === threadId &&
      (message.method === 'item/agentMessage/delta' ||
        (message.method === 'item/completed' && message.params?.item?.type === 'agentMessage')),
    300_000,
  );
  const turnCompleted = bridge.waitForViewMessage(
    (message) =>
      message?.type === 'mcp-notification' &&
      message.method === 'turn/completed' &&
      message.params?.threadId === threadId,
    300_000,
  );

  const sendStartedAt = performance.now();
  const turn = await bridge.mcpRequest('turn/start', {
    threadId,
    input: [
      {
        type: 'text',
        text: 'Reply with exactly: SEND_LATENCY_OK',
        text_elements: [],
      },
    ],
  });
  const acceptedMs = elapsed(sendStartedAt);
  await turnStarted;
  const turnStartedMs = elapsed(sendStartedAt);
  await firstVisibleOutput;
  const firstVisibleOutputMs = elapsed(sendStartedAt);
  await turnCompleted;
  const completedMs = elapsed(sendStartedAt);

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      accepted: turn !== null,
      timingsMs: {
        prewarm: prewarmMs,
        accepted: acceptedMs,
        turnStarted: turnStartedMs,
        firstVisibleOutput: firstVisibleOutputMs,
        completed: completedMs,
      },
    })}\n`,
  );
} finally {
  if (threadId !== null) {
    await bridge.mcpRequest('thread/delete', { threadId }).catch(() => undefined);
  }
  bridge.close();
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
