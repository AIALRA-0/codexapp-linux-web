import { connectOfficialBridge, createIdentityHeaders } from './lib/official-bridge-client.mjs';

const baseUrl = process.env.SMOKE_BASE_URL;
const publicOrigin = process.env.SMOKE_PUBLIC_ORIGIN;
const proxySecret = process.env.SMOKE_PROXY_SECRET;
const subject = process.env.SMOKE_SUBJECT;
const threadId = process.env.SMOKE_THREAD_ID;
const includeTurns = process.env.SMOKE_INCLUDE_TURNS === '1';

if (
  baseUrl === undefined ||
  publicOrigin === undefined ||
  proxySecret === undefined ||
  subject === undefined ||
  threadId === undefined
) {
  throw new Error(
    'SMOKE_BASE_URL, SMOKE_PUBLIC_ORIGIN, SMOKE_PROXY_SECRET, SMOKE_SUBJECT, and SMOKE_THREAD_ID are required',
  );
}
if (!/^[0-9a-f-]{36}$/u.test(threadId)) throw new Error('SMOKE_THREAD_ID is invalid');

const identityHeaders = createIdentityHeaders({
  email: 'retention-validation@example.invalid',
  proxySecret,
  subject,
  username: 'retention-validation',
});
const connectStarted = performance.now();
const bridge = await connectOfficialBridge({ baseUrl, identityHeaders, publicOrigin });
const connectedAt = performance.now();

try {
  const readStarted = performance.now();
  const result = await bridge.mcpRequest('thread/read', { threadId, includeTurns });
  const readCompleted = performance.now();
  const returnedThreadId = result?.thread?.id ?? result?.id;
  if (returnedThreadId !== threadId) throw new Error('thread/read returned a different thread');
  const turns = Array.isArray(result?.thread?.turns)
    ? result.thread.turns
    : Array.isArray(result?.turns)
      ? result.turns
      : [];
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      rendererVersion: bridge.bootstrap.rendererVersion,
      threadId,
      includeTurns,
      bridgeConnectMs: Math.round(connectedAt - connectStarted),
      threadReadMs: Math.round(readCompleted - readStarted),
      resultBytes: Buffer.byteLength(JSON.stringify(result)),
      turnCount: turns.length,
    })}\n`,
  );
} finally {
  bridge.close();
}
