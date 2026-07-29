import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';

import { connectOfficialBridge, createIdentityHeaders } from './lib/official-bridge-client.mjs';

const baseUrl = process.env.SMOKE_BASE_URL;
const publicOrigin = process.env.SMOKE_PUBLIC_ORIGIN;
const proxySecret = process.env.SMOKE_PROXY_SECRET;
if (baseUrl === undefined || publicOrigin === undefined || proxySecret === undefined) {
  throw new Error('SMOKE_BASE_URL, SMOKE_PUBLIC_ORIGIN, and SMOKE_PROXY_SECRET are required');
}

const identityHeaders = createIdentityHeaders({
  email: 'task-start-smoke@example.invalid',
  proxySecret,
  subject: 'task-start-smoke-subject',
  username: 'task-start-smoke',
});
const bridge = await connectOfficialBridge({
  baseUrl,
  identityHeaders,
  publicOrigin,
});
let createdDirectory = null;
let threadId = null;
let workspaceRoot = null;

try {
  const projectless = await bridge.desktopFetch('projectless-thread-cwd', {});
  workspaceRoot = requiredString(projectless.workspaceRoot, 'projectless workspace root');
  const smokeId = randomUUID();
  createdDirectory = `${workspaceRoot}/.codexapp-smoke-${smokeId}`;
  await bridge.desktopFetch('ensure-directory', {
    hostId: 'local',
    path: createdDirectory,
  });
  const gitOrigins = await bridge.desktopFetch('git-origins', {
    dirs: [workspaceRoot],
    hostId: 'local',
  });
  if (!Array.isArray(gitOrigins.origins) || gitOrigins.homeDir !== workspaceRoot) {
    throw new Error('Git origins adapter returned an invalid response');
  }
  const mcpConfig = await bridge.desktopFetch('mcp-codex-config', { cwd: workspaceRoot });
  if (!Object.hasOwn(mcpConfig, 'config')) {
    throw new Error('MCP Codex config response is missing config');
  }
  const developerInstructions = await bridge.desktopFetch('developer-instructions', {
    cwd: workspaceRoot,
    hostId: 'local',
    threadId: null,
    threadToolsEnabled: false,
  });
  const instructions = requiredString(developerInstructions.instructions, 'developer instructions');

  const started = await bridge.prewarmThreadStart({
    cwd: workspaceRoot,
    developerInstructions: instructions,
    ephemeral: true,
    experimentalRawEvents: false,
  });
  threadId = requiredString(started?.thread?.id ?? started?.threadId, 'thread id');
  const leakedBeforeTurnStart = await bridge
    .waitForViewMessage(
      (message) =>
        message?.type === 'mcp-notification' &&
        message.method === 'thread/started' &&
        message.params?.thread?.id === threadId,
      750,
    )
    .then(
      () => true,
      () => false,
    );
  if (leakedBeforeTurnStart) {
    throw new Error('prewarmed thread became visible before its first turn');
  }
  const visibleThreadStarted = bridge.waitForViewMessage(
    (message) =>
      message?.type === 'mcp-notification' &&
      message.method === 'thread/started' &&
      message.params?.thread?.id === threadId,
  );
  const turn = await bridge.mcpRequest('turn/start', {
    threadId,
    input: [
      {
        type: 'text',
        text: 'CodexApp official browser host task-start smoke.',
        text_elements: [],
      },
    ],
  });
  await visibleThreadStarted;
  await bridge.mcpRequest('thread/read', { threadId, includeTurns: false });

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      rendererVersion: bridge.bootstrap.rendererVersion,
      adapters: [
        'projectless-thread-cwd',
        'ensure-directory',
        'git-origins',
        'mcp-codex-config',
        'developer-instructions',
      ],
      appServer: ['thread-prewarm-start', 'turn/start', 'thread/read', 'thread/delete'],
      gitOriginCount: gitOrigins.origins.length,
      prewarmHiddenUntilTurnStart: true,
      turnAccepted: turn !== null,
    })}\n`,
  );
} finally {
  if (threadId !== null) {
    await bridge.mcpRequest('thread/delete', { threadId }).catch(() => undefined);
  }
  bridge.close();
  if (
    workspaceRoot !== null &&
    createdDirectory !== null &&
    isPathWithin(workspaceRoot, createdDirectory)
  ) {
    await rm(createdDirectory, { force: true, recursive: true });
  }
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is missing`);
  return value;
}

function isPathWithin(root, candidate) {
  const difference = relative(root, candidate);
  return (
    difference === '' ||
    (difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference))
  );
}
