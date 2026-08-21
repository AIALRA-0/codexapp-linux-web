import { createHash } from 'node:crypto';

import { connectOfficialBridge, createIdentityHeaders } from './lib/official-bridge-client.mjs';

const baseUrl = requiredEnvironment('SMOKE_BASE_URL');
const publicOrigin = requiredEnvironment('SMOKE_PUBLIC_ORIGIN');
const proxySecret = requiredEnvironment('SMOKE_PROXY_SECRET');
const proxySecretHeader = process.env.SMOKE_PROXY_SECRET_HEADER ?? 'X-Aialra-Proxy-Secret';
const minimumSkillCount = Number(process.env.VERIFY_MINIMUM_SKILL_COUNT ?? '45');
const workspace = requiredEnvironment('VERIFY_WORKSPACE');
const identityHeaders = createIdentityHeaders({
  email: process.env.SMOKE_EMAIL ?? 'mcp-bridge-smoke@example.invalid',
  proxySecret,
  proxySecretHeader,
  subject: process.env.SMOKE_SUBJECT ?? 'mcp-bridge-smoke-subject',
  username: process.env.SMOKE_USERNAME ?? 'mcp-bridge-smoke',
});
const cases = [
  smokeCase('openaiDeveloperDocs', 'list_openai_docs', {}),
  smokeCase('aialra_google_email', 'manage_accounts', { operation: 'list' }),
  smokeCase('codex_apps', 'github.get_profile', {}),
  smokeCase('codex_apps', 'gmail.get_profile', {}),
  smokeCase('codex_apps', 'google_drive.get_profile', {}),
  smokeCase('codex_apps', 'microsoft_outlook_email.get_profile', {}),
];

const bridge = await connectOfficialBridge({ baseUrl, identityHeaders, publicOrigin });

try {
  const skills = await bridge.mcpRequest('skills/list', {
    cwds: [workspace],
    forceReload: true,
  });
  const skillNames = [...collectNamedValues(skills)].sort();
  const started = await bridge.mcpRequest('thread/start', {
    cwd: workspace,
    ephemeral: true,
    experimentalRawEvents: false,
  });
  const threadId = requiredString(started?.thread?.id ?? started?.threadId, 'thread id');
  const status = await waitForMcpStatus(bridge, threadId);
  const results = [];
  for (const testCase of cases) results.push(await runCase(bridge, threadId, status, testCase));

  const accountList = results.find(
    (result) => result.label === 'aialra_google_email/manage_accounts',
  );
  const accounts = unique(accountList?.emails ?? []);
  for (const account of accounts) {
    results.push(
      await runCase(
        bridge,
        threadId,
        status,
        smokeCase(
          'aialra_google_email',
          'manage_accounts',
          { operation: 'status', email: account },
          {
            label: `google-account:${hashIdentifier(account)}`,
            expected: /(?:tokenValid["']?\s*:\s*true|\[x\]\s*Token valid)/iu,
          },
        ),
      ),
    );
  }

  const shopping = await runShoppingCase(bridge, threadId, status);
  results.push(shopping);
  const failures = results.filter((result) => !result.ok);
  const skillCountSatisfied = skillNames.length >= minimumSkillCount;
  process.stdout.write(
    `${JSON.stringify({
      ok: skillCountSatisfied && failures.length === 0,
      skillCount: skillNames.length,
      minimumSkillCount,
      skillCountSatisfied,
      skillNames,
      mcpServers: status.map((row) => ({
        name: row?.name,
        status: row?.status ?? null,
        authStatus: row?.authStatus ?? null,
        toolCount: Object.keys(row?.tools ?? {}).length,
      })),
      tested: results.length,
      results: results.map(({ emails: _emails, ...result }) => result),
      failures: failures.map((result) => result.label),
    })}\n`,
  );
  if (!skillCountSatisfied || failures.length > 0) process.exitCode = 1;
} finally {
  bridge.close();
}

function smokeCase(server, tool, args, options = {}) {
  return {
    server,
    tool,
    args,
    label: options.label ?? `${server}/${tool}`,
    expected: options.expected,
  };
}

async function runCase(client, threadId, status, testCase) {
  const startedAt = performance.now();
  const discovered = status.some(
    (row) => row?.name === testCase.server && row?.tools?.[testCase.tool]?.name === testCase.tool,
  );
  if (!discovered) {
    return {
      label: testCase.label,
      ok: false,
      discovered: false,
      called: false,
      reason: 'tool-not-discovered',
      milliseconds: elapsed(startedAt),
    };
  }
  try {
    const response = await client.mcpRequest('mcpServer/tool/call', {
      threadId,
      server: testCase.server,
      tool: testCase.tool,
      arguments: testCase.args,
    });
    const serialized = JSON.stringify(response);
    const explicitError = containsExplicitError(response);
    const authProblem =
      /(?:not connected|not authenticated|authentication required|login required|unauthorized|token invalid|no refresh token)/iu.test(
        serialized,
      );
    const expectedMatched = testCase.expected === undefined || testCase.expected.test(serialized);
    return {
      label: testCase.label,
      ok: !explicitError && !authProblem && expectedMatched,
      discovered: true,
      called: true,
      explicitError,
      authProblem,
      expectedMatched,
      responseBytes: Buffer.byteLength(serialized),
      emails:
        testCase.server === 'aialra_google_email' && testCase.args.operation === 'list'
          ? extractEmails(serialized)
          : undefined,
      diagnostic:
        explicitError || authProblem || !expectedMatched
          ? sanitizeDiagnostic(serialized)
          : undefined,
      milliseconds: elapsed(startedAt),
    };
  } catch (error) {
    return {
      label: testCase.label,
      ok: false,
      discovered: true,
      called: false,
      reason: error instanceof Error ? error.message : String(error),
      milliseconds: elapsed(startedAt),
    };
  }
}

async function runShoppingCase(client, threadId, status) {
  const label = 'aialra-shopping-browser/navigate-and-snapshot';
  const startedAt = performance.now();
  const tools = status.find((row) => row?.name === 'aialra-shopping-browser')?.tools ?? {};
  if (
    tools.browser_navigate?.name !== 'browser_navigate' ||
    tools.browser_snapshot?.name !== 'browser_snapshot'
  ) {
    return {
      label,
      ok: false,
      discovered: false,
      called: false,
      reason: 'tool-not-discovered',
      milliseconds: elapsed(startedAt),
    };
  }
  try {
    const navigation = await client.mcpRequest('mcpServer/tool/call', {
      threadId,
      server: 'aialra-shopping-browser',
      tool: 'browser_navigate',
      arguments: { url: 'https://example.com/' },
    });
    const snapshot = await client.mcpRequest('mcpServer/tool/call', {
      threadId,
      server: 'aialra-shopping-browser',
      tool: 'browser_snapshot',
      arguments: {},
    });
    const serialized = JSON.stringify(snapshot);
    const explicitError = containsExplicitError(navigation) || containsExplicitError(snapshot);
    const exactContent = serialized.includes('Example Domain');
    return {
      label,
      ok: !explicitError && exactContent,
      discovered: true,
      called: true,
      explicitError,
      exactContent,
      responseBytes: Buffer.byteLength(serialized),
      milliseconds: elapsed(startedAt),
    };
  } catch (error) {
    return {
      label,
      ok: false,
      discovered: true,
      called: false,
      reason: error instanceof Error ? error.message : String(error),
      milliseconds: elapsed(startedAt),
    };
  }
}

async function waitForMcpStatus(client, threadId) {
  let rows = [];
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await client.mcpRequest('mcpServerStatus/list', {
      threadId,
      cursor: null,
      limit: 100,
      detail: 'toolsAndAuthOnly',
    });
    rows = Array.isArray(response?.data) ? response.data : [];
    if (
      cases.every((testCase) =>
        rows.some(
          (row) =>
            row?.name === testCase.server && row?.tools?.[testCase.tool]?.name === testCase.tool,
        ),
      ) &&
      rows.some(
        (row) =>
          row?.name === 'aialra-shopping-browser' &&
          row?.tools?.browser_navigate?.name === 'browser_navigate' &&
          row?.tools?.browser_snapshot?.name === 'browser_snapshot',
      )
    ) {
      return rows;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return rows;
}

function collectNamedValues(value, output = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectNamedValues(item, output);
    return output;
  }
  if (value === null || typeof value !== 'object') return output;
  if (typeof value.name === 'string' && value.name.length > 0) output.add(value.name);
  for (const child of Object.values(value)) collectNamedValues(child, output);
  return output;
}

function containsExplicitError(value) {
  if (value === null || typeof value !== 'object') return false;
  if (value.isError === true) return true;
  if (Array.isArray(value)) return value.some(containsExplicitError);
  return Object.values(value).some(containsExplicitError);
}

function extractEmails(value) {
  return unique(value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu) ?? []);
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

function hashIdentifier(value) {
  return createHash('sha256').update(value.toLowerCase()).digest('hex').slice(0, 12);
}

function unique(values) {
  return [...new Set(values.map((value) => value.toLowerCase()))];
}

function elapsed(startedAt) {
  return Math.round(performance.now() - startedAt);
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
