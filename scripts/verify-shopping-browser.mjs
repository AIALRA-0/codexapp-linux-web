import { CodexAppServerClient } from '../packages/app-server-client/dist/index.js';

const codexBin = requiredEnvironment('VERIFY_CODEX_BIN');
const codexHome = requiredEnvironment('VERIFY_CODEX_HOME');
const workspace = requiredEnvironment('VERIFY_WORKSPACE');
const rendererVersion = process.env.VERIFY_RENDERER_VERSION ?? '26.730.61639';
const testUrl = process.env.VERIFY_BROWSER_URL ?? 'https://example.com/';
const expectedText = process.env.VERIFY_BROWSER_EXPECTED_TEXT ?? 'Example Domain';

const client = new CodexAppServerClient({
  codexBin,
  codexHome,
  cwd: workspace,
  clientVersion: rendererVersion,
  extraArgs: ['-c', 'features.code_mode_host=true'],
  requestTimeoutMs: 60_000,
});
const stderr = [];
client.on('request', (event) => {
  void event.respond({
    error: {
      code: -32_600,
      message: `unexpected server request during shopping-browser verification: ${event.request.method}`,
    },
  });
});
client.on('stderr', (line) => {
  stderr.push(line);
  if (stderr.length > 30) stderr.shift();
});

try {
  phase('app-server-start');
  await client.start();
  phase('app-server-ready');
  const started = await client.request('thread/start', {
    cwd: workspace,
    ephemeral: true,
    experimentalRawEvents: false,
  });
  const threadId = requiredString(started?.thread?.id ?? started?.threadId, 'thread id');
  phase('thread-ready');
  phase('navigation-start');
  const navigation = await client.request(
    'mcpServer/tool/call',
    {
      threadId,
      server: 'aialra-shopping-browser',
      tool: 'browser_navigate',
      arguments: { url: testUrl },
    },
    90_000,
  );
  phase('navigation-complete');
  const snapshot = await client.request(
    'mcpServer/tool/call',
    {
      threadId,
      server: 'aialra-shopping-browser',
      tool: 'browser_snapshot',
      arguments: {},
    },
    60_000,
  );
  phase('snapshot-complete');
  const navigationText = JSON.stringify(navigation);
  const snapshotText = JSON.stringify(snapshot);
  const exactContent = snapshotText.includes(expectedText);
  const ok = !containsExplicitError(navigation) && !containsExplicitError(snapshot) && exactContent;
  process.stdout.write(
    `${JSON.stringify({
      ok,
      server: 'aialra-shopping-browser',
      navigateCalled: true,
      snapshotCalled: true,
      exactContent,
      navigationBytes: Buffer.byteLength(navigationText),
      snapshotBytes: Buffer.byteLength(snapshotText),
    })}\n`,
  );
  if (!ok) process.exitCode = 1;
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      stderr,
    })}\n`,
  );
  process.exitCode = 1;
} finally {
  await client.stop().catch(() => undefined);
}

function phase(name, details = {}) {
  process.stderr.write(
    `[shopping-browser-verifier] ${JSON.stringify({ phase: name, ...details })}\n`,
  );
}

function containsExplicitError(value) {
  if (value === null || typeof value !== 'object') return false;
  if (value.isError === true) return true;
  if (Array.isArray(value)) return value.some(containsExplicitError);
  return Object.values(value).some(containsExplicitError);
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is missing`);
  return value;
}
