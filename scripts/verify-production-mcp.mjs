import { createHash } from 'node:crypto';

const { CodexAppServerClient } = await import(
  process.env.VERIFY_CLIENT_MODULE ?? '../packages/app-server-client/dist/index.js'
);

const codexBin = requiredEnvironment('VERIFY_CODEX_BIN');
const codexHome = requiredEnvironment('VERIFY_CODEX_HOME');
const workspace = requiredEnvironment('VERIFY_WORKSPACE');
const rendererVersion = process.env.VERIFY_RENDERER_VERSION ?? '26.730.61639';
const configuredGoogleAccounts = csvEnvironment('VERIFY_GOOGLE_ACCOUNTS');
const refreshGoogleAccounts = process.env.VERIFY_REFRESH_GOOGLE_ACCOUNTS === '1';
const cases = [
  smokeCase('openaiDeveloperDocs', 'list_openai_docs', {}),
  smokeCase('aialra_google_email', 'manage_accounts', { operation: 'list' }),
  smokeCase('codex_apps', 'github.get_profile', {}),
  smokeCase('codex_apps', 'gmail.get_profile', {}),
  smokeCase('codex_apps', 'google_drive.get_profile', {}),
  smokeCase('codex_apps', 'microsoft_outlook_email.get_profile', {}),
];

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
  const status = await waitForMcpStatus(client, threadId, cases);

  const results = [];
  for (const testCase of cases) {
    results.push(await runCase(client, threadId, status, testCase));
  }
  const discoveredGoogleAccounts = await discoverGoogleAccounts(client, threadId);
  const googleAccounts = unique([...configuredGoogleAccounts, ...discoveredGoogleAccounts]);
  const repairs = [];
  if (googleAccounts.length === 0) {
    results.push({
      label: 'aialra_google_email/account-discovery',
      server: 'aialra_google_email',
      tool: 'manage_accounts',
      ok: false,
      discovered: true,
      called: true,
      reason: 'no-configured-accounts',
      milliseconds: 0,
    });
  }
  for (const account of googleAccounts) {
    if (refreshGoogleAccounts) {
      repairs.push(await refreshGoogleAccount(client, threadId, account));
    }
    results.push(
      await runCase(
        client,
        threadId,
        status,
        smokeCase(
          'aialra_google_email',
          'manage_accounts',
          { operation: 'status', email: account },
          {
            label: `google-account:${hashIdentifier(account)}`,
            expected: /(?:tokenValid["']?\s*:\s*true|\[x\]\s*Token valid)/i,
          },
        ),
      ),
    );
  }
  const failures = results.filter((result) => !result.ok);
  process.stdout.write(
    `${JSON.stringify({
      ok: failures.length === 0,
      rendererVersion,
      tested: results.length,
      results,
      repairs,
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
  const startedAt = performance.now();
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
      milliseconds: Math.round(performance.now() - startedAt),
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
      diagnostic:
        explicitError || authProblem || !expected ? sanitizeDiagnostic(serialized) : undefined,
      milliseconds: Math.round(performance.now() - startedAt),
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
      milliseconds: Math.round(performance.now() - startedAt),
    };
  }
}

function containsExplicitError(value) {
  if (value === null || typeof value !== 'object') return false;
  if (value.isError === true) return true;
  if (Array.isArray(value)) return value.some(containsExplicitError);
  return Object.values(value).some(containsExplicitError);
}

function sanitizeDiagnostic(value) {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[email-redacted]')
    .replace(/(?:bearer\s+)?[A-Za-z0-9_-]{32,}\.[A-Za-z0-9._-]{16,}/giu, '[token-redacted]')
    .replace(
      /((?:access|refresh|id)[_-]?token["']?\s*[:=]\s*)["'][^"']+["']/giu,
      '$1"[token-redacted]"',
    )
    .slice(0, 800);
}

async function discoverGoogleAccounts(appServer, threadId) {
  const response = await appServer.request('mcpServer/tool/call', {
    threadId,
    server: 'aialra_google_email',
    tool: 'manage_accounts',
    arguments: { operation: 'list' },
  });
  if (containsExplicitError(response)) return [];
  const serialized = JSON.stringify(response);
  return unique(
    serialized
      .match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu)
      ?.map((email) => email.toLowerCase()) ?? [],
  );
}

async function refreshGoogleAccount(appServer, threadId, account) {
  const startedAt = performance.now();
  const label = `google-account:${hashIdentifier(account)}`;
  try {
    const status = await appServer.request('mcpServer/tool/call', {
      threadId,
      server: 'aialra_google_email',
      tool: 'manage_accounts',
      arguments: { operation: 'status', email: account },
    });
    const statusSerialized = JSON.stringify(status);
    if (/(?:tokenValid["']?\s*:\s*true|\[x\]\s*Token valid)/iu.test(statusSerialized)) {
      return {
        label,
        attempted: false,
        ok: true,
        reason: 'already-valid',
        milliseconds: Math.round(performance.now() - startedAt),
      };
    }
    const response = await appServer.request('mcpServer/tool/call', {
      threadId,
      server: 'aialra_google_email',
      tool: 'manage_accounts',
      arguments: { operation: 'refresh', email: account },
    });
    const serialized = JSON.stringify(response);
    const explicitError = containsExplicitError(response);
    const authProblem =
      /(?:not authenticated|authentication required|login required|unauthorized|token invalid|no refresh token)/iu.test(
        serialized,
      );
    return {
      label,
      attempted: true,
      ok: !explicitError && !authProblem,
      explicitError,
      authProblem,
      diagnostic: explicitError || authProblem ? sanitizeDiagnostic(serialized) : undefined,
      milliseconds: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    return {
      label,
      attempted: true,
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      milliseconds: Math.round(performance.now() - startedAt),
    };
  }
}

function hashIdentifier(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function unique(values) {
  return [...new Set(values)];
}

async function waitForMcpStatus(appServer, threadId, requiredCases) {
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
    const allToolsReady = requiredCases.every((testCase) =>
      rows.some(
        (row) =>
          row?.name === testCase.server && row?.tools?.[testCase.tool]?.name === testCase.tool,
      ),
    );
    if (allToolsReady) {
      return rows;
    }
    await delay(500);
  }
  throw new Error(
    `required MCP tools did not become ready: ${JSON.stringify(
      lastStatus?.map((row) => ({
        name: row?.name,
        tools: Object.keys(row?.tools ?? {}).sort(),
      })),
    )}`,
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
