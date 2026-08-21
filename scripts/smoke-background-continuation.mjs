import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';

import { connectOfficialBridge, createIdentityHeaders } from './lib/official-bridge-client.mjs';

const action = requiredEnvironment('SMOKE_BACKGROUND_ACTION');
const baseUrl = requiredEnvironment('SMOKE_BASE_URL');
const publicOrigin = requiredEnvironment('SMOKE_PUBLIC_ORIGIN');
const proxySecret = requiredEnvironment('SMOKE_PROXY_SECRET');
const subject = requiredEnvironment('SMOKE_SUBJECT');
const username = requiredEnvironment('SMOKE_USERNAME');
const email = requiredEnvironment('SMOKE_EMAIL');
const stateFile = requiredEnvironment('SMOKE_BACKGROUND_STATE_FILE');
const timeoutMs = Number(process.env.SMOKE_BACKGROUND_TIMEOUT_MS ?? '300000');

if (action !== 'create' && action !== 'verify') {
  throw new Error('SMOKE_BACKGROUND_ACTION must be create or verify');
}
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 600_000) {
  throw new Error('SMOKE_BACKGROUND_TIMEOUT_MS must be between 10000 and 600000');
}

const identityHeaders = createIdentityHeaders({
  email,
  proxySecret,
  subject,
  username,
});
const bridge = await connectOfficialBridge({ baseUrl, identityHeaders, publicOrigin });
let cleanupThreadId;

try {
  if (action === 'create') {
    const projectless = await bridge.desktopFetch('projectless-thread-cwd', {});
    const cwd = requiredString(projectless.workspaceRoot, 'projectless workspace root');
    const marker = `BACKGROUND_CONTINUATION_OK_${randomUUID()}`;
    const started = await bridge.mcpRequest('thread/start', {
      approvalPolicy: 'never',
      cwd,
      ephemeral: false,
      experimentalRawEvents: false,
      sandbox: 'danger-full-access',
    });
    const threadId = requiredString(started?.thread?.id ?? started?.threadId, 'thread id');
    cleanupThreadId = threadId;
    const acceptedAt = Date.now();
    await bridge.mcpRequest('turn/start', {
      approvalPolicy: 'never',
      input: [
        {
          type: 'text',
          text: [
            'This is an isolated qualification test.',
            'First use the shell tool to run: sleep 12',
            `After that command finishes, reply with exactly: ${marker}`,
          ].join('\n'),
          text_elements: [],
        },
      ],
      sandboxPolicy: { type: 'dangerFullAccess' },
      threadId,
    });
    const active = await waitForBackgroundWork(baseUrl, true, 10_000);
    const temporaryStateFile = `${stateFile}.${process.pid}.tmp`;
    await writeFile(temporaryStateFile, `${JSON.stringify({ acceptedAt, marker, threadId })}\n`, {
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
        activeBeforeDisconnect: active.active,
        activeTurnCount: active.activeTurnCount,
        rendererVersion: bridge.bootstrap.rendererVersion,
      })}\n`,
    );
  } else {
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    const threadId = requiredString(state.threadId, 'persisted thread id');
    const marker = requiredString(state.marker, 'persisted marker');
    cleanupThreadId = threadId;
    const deadline = Date.now() + timeoutMs;
    let completed = false;
    let lastRead;
    while (Date.now() < deadline) {
      lastRead = await bridge.mcpRequest('thread/read', { threadId, includeTurns: true });
      if (hasCompletedAssistantMarker(lastRead, marker)) {
        completed = true;
        break;
      }
      await delay(500);
    }
    if (!completed) {
      throw new Error(
        `background turn did not complete after browser disconnect; last response bytes ${String(JSON.stringify(lastRead).length)}`,
      );
    }
    const inactive = await waitForBackgroundWork(baseUrl, false, 10_000);
    await bridge.mcpRequest('thread/delete', { threadId });
    cleanupThreadId = undefined;
    await rm(stateFile, { force: true });
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        action,
        assistantResultRecovered: true,
        backgroundInactiveAfterCompletion: inactive.active === false,
        completedAfterDisconnectMs: Date.now() - Number(state.acceptedAt),
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

function hasCompletedAssistantMarker(value, marker) {
  if (Array.isArray(value)) {
    return value.some((entry) => hasCompletedAssistantMarker(entry, marker));
  }
  if (value === null || typeof value !== 'object') return false;
  const type = typeof value.type === 'string' ? value.type.toLowerCase() : '';
  if (
    (type.includes('agentmessage') || type.includes('assistant')) &&
    JSON.stringify(value).includes(marker)
  ) {
    return true;
  }
  return Object.values(value).some((entry) => hasCompletedAssistantMarker(entry, marker));
}

async function waitForBackgroundWork(url, expectedActive, maximumWaitMs) {
  const deadline = Date.now() + maximumWaitMs;
  let lastSnapshot;
  while (Date.now() < deadline) {
    const response = await fetch(`${url}/ops/background-work`);
    if (!response.ok) throw new Error(`background work status failed: ${String(response.status)}`);
    lastSnapshot = await response.json();
    if (lastSnapshot.active === expectedActive) return lastSnapshot;
    await delay(100);
  }
  throw new Error(
    `background work did not become ${String(expectedActive)}: ${JSON.stringify(lastSnapshot)}`,
  );
}

function requiredEnvironment(name) {
  return requiredString(process.env[name], name);
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is missing`);
  return value;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
