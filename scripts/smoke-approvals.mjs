import { access, readFile } from 'node:fs/promises';

import { connectOfficialBridge, createIdentityHeaders } from './lib/official-bridge-client.mjs';

const baseUrl = process.env.SMOKE_BASE_URL;
const publicOrigin = process.env.SMOKE_PUBLIC_ORIGIN;
const proxySecret = process.env.SMOKE_PROXY_SECRET;
const fixtureUrl = process.env.APPROVAL_FIXTURE_URL;
if (
  baseUrl === undefined ||
  publicOrigin === undefined ||
  proxySecret === undefined ||
  fixtureUrl === undefined
) {
  throw new Error(
    'SMOKE_BASE_URL, SMOKE_PUBLIC_ORIGIN, SMOKE_PROXY_SECRET, and APPROVAL_FIXTURE_URL are required',
  );
}

const identityHeaders = createIdentityHeaders({
  email: 'approval-smoke@example.invalid',
  proxySecret,
  subject: 'approval-smoke-subject',
  username: 'approval-smoke',
});
const bridge = await connectOfficialBridge({
  baseUrl,
  identityHeaders,
  publicOrigin,
});
let appHostConnection;

try {
  appHostConnection = await bridge.connectAppHost();
  const services = appHostConnection.appHost.services;
  const workspaceRoot = requiredString(
    (await services.primaryRuntime.get())?.cwd,
    'primary runtime workspace',
  );
  const acceptedPath = `${workspaceRoot}/approval-accepted.txt`;
  const declinedPath = `${workspaceRoot}/approval-declined.txt`;

  const started = await bridge.mcpRequest('thread/start', {
    approvalPolicy: 'untrusted',
    approvalsReviewer: 'user',
    cwd: workspaceRoot,
    ephemeral: true,
    experimentalRawEvents: false,
    model: 'gpt-5.4',
    sandbox: 'workspace-write',
  });
  const threadId = requiredString(started?.thread?.id ?? started?.threadId, 'thread id');

  const accepted = await runApprovalTurn({
    bridge,
    decision: 'accept',
    expectedItemId: 'approval-accept-command',
    prompt: 'Run the first qualification command.',
    threadId,
  });
  if ((await readFile(acceptedPath, 'utf8')) !== 'accepted\n') {
    throw new Error('approved command did not write the exact marker');
  }

  const declined = await runApprovalTurn({
    bridge,
    decision: 'decline',
    expectedItemId: 'approval-decline-command',
    prompt: 'Run the second qualification command.',
    threadId,
  });
  await expectMissing(declinedPath);

  const fixtureState = await fetch(`${fixtureUrl}/requests`).then(async (response) => {
    if (!response.ok) throw new Error(`approval fixture state failed: ${String(response.status)}`);
    return response.json();
  });
  if (
    fixtureState.remainingResponses !== 0 ||
    !Array.isArray(fixtureState.requests) ||
    fixtureState.requests.length !== 4
  ) {
    throw new Error(`approval fixture sequence changed: ${JSON.stringify(fixtureState)}`);
  }
  const approvedOutputReturned = hasFunctionCallOutput(fixtureState.requests[1], 'accepted');
  const declinedOutputReturned = hasFunctionCallOutput(
    fixtureState.requests[3],
    'rejected by user',
  );
  if (!approvedOutputReturned || !declinedOutputReturned) {
    throw new Error('approved output or declined result was not returned to the model');
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      rendererVersion: bridge.bootstrap.rendererVersion,
      approvalRequests: ['accept', 'decline'],
      serverRequestResolved: accepted.resolved && declined.resolved,
      approvedCommandExecuted: true,
      declinedCommandBlocked: true,
      turnCompleted: accepted.turnCompleted && declined.turnCompleted,
      bridgeRoundTrip: true,
    })}\n`,
  );
} finally {
  appHostConnection?.close();
  bridge.close();
}

async function runApprovalTurn({ bridge, decision, expectedItemId, prompt, threadId }) {
  const approvalRequestPromise = bridge.waitForViewMessage(
    (message) =>
      message?.type === 'mcp-request' &&
      message.request?.method === 'item/commandExecution/requestApproval' &&
      message.request?.params?.itemId === expectedItemId,
  );
  await bridge.mcpRequest('turn/start', {
    approvalPolicy: 'untrusted',
    approvalsReviewer: 'user',
    input: [{ type: 'text', text: prompt, text_elements: [] }],
    model: 'gpt-5.4',
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: [] },
    threadId,
  });
  const approvalMessage = await approvalRequestPromise;
  const requestId = approvalMessage.request?.id;
  if (requestId === undefined || requestId === null) {
    throw new Error('approval request id is missing');
  }
  const resolvedPromise = bridge.waitForViewMessage(
    (message) =>
      message?.type === 'mcp-notification' &&
      message.method === 'serverRequest/resolved' &&
      message.params?.requestId === requestId,
  );
  const commandCompletedPromise = bridge.waitForViewMessage(
    (message) =>
      message?.type === 'mcp-notification' &&
      message.method === 'item/completed' &&
      message.params?.item?.id === expectedItemId,
  );
  const turnCompletedPromise = bridge.waitForViewMessage(
    (message) =>
      message?.type === 'mcp-notification' &&
      message.method === 'turn/completed' &&
      message.params?.turn?.id === approvalMessage.request?.params?.turnId,
  );
  await bridge.respondMcpRequest(requestId, { decision });
  const [resolvedMessage, commandCompleted, turnCompleted] = await Promise.all([
    resolvedPromise,
    commandCompletedPromise,
    turnCompletedPromise,
  ]);
  const expectedStatus = decision === 'accept' ? 'completed' : 'declined';
  if (commandCompleted.params?.item?.status !== expectedStatus) {
    throw new Error(
      `command approval status changed: ${JSON.stringify(commandCompleted.params?.item)}`,
    );
  }
  return {
    resolved: resolvedMessage !== undefined,
    turnCompleted: turnCompleted !== undefined,
  };
}

async function expectMissing(path) {
  try {
    await access(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('declined command unexpectedly created its marker');
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is missing`);
  return value;
}

function hasFunctionCallOutput(value, expectedText) {
  if (Array.isArray(value)) {
    return value.some((entry) => hasFunctionCallOutput(entry, expectedText));
  }
  if (value === null || typeof value !== 'object') return false;
  if (
    value.type === 'function_call_output' &&
    JSON.stringify(value.output).includes(expectedText)
  ) {
    return true;
  }
  return Object.values(value).some((entry) => hasFunctionCallOutput(entry, expectedText));
}
