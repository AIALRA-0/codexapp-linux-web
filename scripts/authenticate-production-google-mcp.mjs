import { createHash } from 'node:crypto';

const sdkRoot = requiredEnvironment('GOOGLE_MCP_SDK_ROOT').replace(/\/$/u, '');
const [{ Client }, { StdioClientTransport }] = await Promise.all([
  import(`file://${sdkRoot}/dist/esm/client/index.js`),
  import(`file://${sdkRoot}/dist/esm/client/stdio.js`),
]);
const transport = new StdioClientTransport({
  command: process.env.GOOGLE_MCP_COMMAND ?? '/usr/bin/node',
  args: [requiredEnvironment('GOOGLE_MCP_ENTRY')],
  cwd: requiredEnvironment('GOOGLE_MCP_CWD'),
  env: process.env,
  stderr: 'pipe',
});
const client = new Client({ name: 'codexapp-google-authentication', version: '1.0.0' });

let authUrlEmitted = false;
transport.stderr?.on('data', (chunk) => {
  const match = String(chunk).match(/https:\/\/accounts\.google\.com\/[^\s]+/u);
  if (match && !authUrlEmitted) {
    authUrlEmitted = true;
    process.stdout.write(`${JSON.stringify({ event: 'authorization_url', url: match[0] })}\n`);
  }
});

try {
  await client.connect(transport);
  const response = await client.callTool(
    {
      name: 'manage_accounts',
      arguments: {
        operation: 'authenticate',
        category: process.env.GOOGLE_MCP_CATEGORY ?? 'personal',
        description: process.env.GOOGLE_MCP_DESCRIPTION ?? 'Personal',
      },
    },
    undefined,
    { timeout: 6 * 60_000, maxTotalTimeout: 6 * 60_000 },
  );
  const serialized = JSON.stringify(response);
  const email = serialized.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu)?.[0];
  const ok =
    !containsExplicitError(response) && !/(?:authentication failed|error:)/iu.test(serialized);
  process.stdout.write(
    `${JSON.stringify({
      event: 'complete',
      ok,
      account: email
        ? createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 12)
        : undefined,
      authUrlEmitted,
      diagnostic: ok ? undefined : sanitizeDiagnostic(serialized),
    })}\n`,
  );
  if (!ok) process.exitCode = 1;
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      event: 'complete',
      ok: false,
      authUrlEmitted,
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
} finally {
  await transport.close().catch(() => undefined);
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
    .replace(/https:\/\/accounts\.google\.com\/[^\s"']+/giu, '[authorization-url-redacted]')
    .slice(0, 800);
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required`);
  return value;
}
