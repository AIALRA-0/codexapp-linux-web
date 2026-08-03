import { CodexAppServerClient } from '../packages/app-server-client/dist/index.js';

const codexBin = requiredEnvironment('VERIFY_CODEX_BIN');
const codexHome = requiredEnvironment('VERIFY_CODEX_HOME');
const workspace = requiredEnvironment('VERIFY_WORKSPACE');
const rendererVersion = process.env.VERIFY_RENDERER_VERSION ?? '26.721.81911';
const googleAccounts = csvEnvironment('VERIFY_GOOGLE_ACCOUNTS');

const client = new CodexAppServerClient({
  codexBin,
  codexHome,
  cwd: workspace,
  clientVersion: rendererVersion,
  extraArgs: ['-c', 'features.code_mode_host=true'],
  requestTimeoutMs: 180_000,
});
const stderr = [];
client.on('request', (event) => {
  void event.respond({
    error: {
      code: -32_600,
      message: `unexpected server request during production MCP verification: ${event.request.method}`,
    },
  });
});
client.on('stderr', (line) => {
  stderr.push(line);
  if (stderr.length > 30) stderr.shift();
});

try {
  await client.start();
  const started = await client.request('thread/start', {
    cwd: workspace,
    ephemeral: true,
    experimentalRawEvents: false,
  });
  const threadId = requiredString(started?.thread?.id ?? started?.threadId, 'thread id');
  const status = await waitForMcpStatus(client, threadId);
  const cases = [
    smokeCase('openaiDeveloperDocs', 'list_openai_docs', {}),
    smokeCase('aialra_google_email', 'manage_accounts', { operation: 'list' }),
    smokeCase('aialra_microsoft_email', 'list-accounts', {}, { authRequired: false }),
    smokeCase('codex_apps', 'github.get_profile', {}),
    smokeCase('codex_apps', 'gmail.get_profile', {}),
    smokeCase('codex_apps', 'google_drive.get_profile', {}),
    smokeCase('codex_apps', 'microsoft_outlook_email.get_profile', {}),
  ];
  for (const account of googleAccounts) {
    cases.push(
      smokeCase(
        'aialra_google_email',
        'manage_accounts',
        { operation: 'status', email: account },
        {
          label: `google-account:${account}`,
          expected: /(?:tokenValid["']?\s*:\s*true|\[x\]\s*Token valid)/i,
        },
      ),
    );
  }

  const results = [];
  for (const testCase of cases) {
    results.push(await runCase(client, threadId, status, testCase));
  }
  const failures = results.filter((result) => !result.ok);
  process.stdout.write(
    `${JSON.stringify({
      ok: failures.length === 0,
      rendererVersion,
      tested: results.length,
      results,
      failures: failures.map((result) => result.label),
    })}\n`,
  );
  if (failures.length > 0) process.exitCode = 1;
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

function smokeCase(server, tool, args, options = {}) {
  return {
    server,
    tool,
    args,
    label: options.label ?? `${server}/${tool}`,
    expected: options.expected,
    authRequired: options.authRequired ?? true,
  };
}

async function runCase(appServer, threadId, status, testCase) {
  const serverStatus = status.find((row) => row?.name === testCase.server);
  const discovered = serverStatus?.tools?.[testCase.tool]?.name === testCase.tool;
  if (!discovered) {
    return {
      label: testCase.label,
      server: testCase.server,
      tool: testCase.tool,
      ok: false,
      discovered: false,
      called: false,
      reason: 'tool-not-discovered',
    };
  }
  try {
    const response = await appServer.request('mcpServer/tool/call', {
      threadId,
      server: testCase.server,
      tool: testCase.tool,
      arguments: testCase.args,
    });
    const serialized = JSON.stringify(response);
    const explicitError = containsExplicitError(response);
    const expected = testCase.expected === undefined || testCase.expected.test(serialized);
    const authProblem =
      testCase.authRequired &&
      /(?:not authenticated|authentication required|login required|unauthorized|token invalid|no refresh token)/i.test(
        serialized,
      );
    return {
      label: testCase.label,
      server: testCase.server,
      tool: testCase.tool,
      ok: !explicitError && !authProblem && expected,
      discovered: true,
      called: true,
      responseBytes: Buffer.byteLength(serialized),
      expectedMatched: expected,
      authProblem,
      explicitError,
    };
  } catch (error) {
    return {
      label: testCase.label,
      server: testCase.server,
      tool: testCase.tool,
      ok: false,
      discovered: true,
      called: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function containsExplicitError(value) {
  if (value === null || typeof value !== 'object') return false;
  if (value.isError === true) return true;
  if (Array.isArray(value)) return value.some(containsExplicitError);
  return Object.values(value).some(containsExplicitError);
}

async function waitForMcpStatus(appServer, threadId) {
  let lastStatus;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await appServer.request('mcpServerStatus/list', {
      threadId,
      cursor: null,
      limit: 100,
      detail: 'toolsAndAuthOnly',
    });
    const rows = response?.data;
    if (!Array.isArray(rows)) throw new Error('MCP status did not return a data array');
    lastStatus = rows;
    const names = new Set(rows.map((row) => row?.name));
    if (
      names.has('openaiDeveloperDocs') &&
      names.has('aialra_google_email') &&
      names.has('aialra_microsoft_email') &&
      names.has('codex_apps')
    ) {
      return rows;
    }
    await delay(500);
  }
  throw new Error(
    `required MCP servers did not become ready: ${JSON.stringify(lastStatus?.map((row) => row?.name))}`,
  );
}

function csvEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim().length === 0) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
