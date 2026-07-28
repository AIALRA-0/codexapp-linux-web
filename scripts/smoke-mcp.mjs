import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CodexAppServerClient } from '../packages/app-server-client/dist/index.js';

const codexBin = process.env.SMOKE_CODEX_BIN;
if (codexBin === undefined) throw new Error('SMOKE_CODEX_BIN is required');

const rendererVersion = process.env.SMOKE_RENDERER_VERSION ?? '26.721.31836';
const root = await mkdtemp(join(tmpdir(), 'codex-mcp-smoke-'));
const codexHome = join(root, 'codex-home');
const workspace = join(root, 'workspace');
const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcp-smoke-server.mjs');
await Promise.all([
  mkdir(codexHome, { recursive: true, mode: 0o700 }),
  mkdir(workspace, { recursive: true, mode: 0o700 }),
]);
await writeFile(
  join(codexHome, 'config.toml'),
  [
    '[mcp_servers.codexapp_smoke]',
    `command = ${tomlString(process.execPath)}`,
    `args = [${tomlString(fixture)}]`,
    'startup_timeout_sec = 15',
    'tool_timeout_sec = 15',
    'required = true',
    'enabled = true',
    'default_tools_approval_mode = "auto"',
    '',
  ].join('\n'),
  { encoding: 'utf8', flag: 'wx', mode: 0o600 },
);

const client = new CodexAppServerClient({
  codexBin,
  codexHome,
  cwd: workspace,
  clientVersion: rendererVersion,
  extraArgs: ['-c', 'features.code_mode_host=true'],
  requestTimeoutMs: 30_000,
});
client.on('request', (event) => {
  void event.respond({
    error: {
      code: -32_600,
      message: `unexpected server request during MCP smoke: ${event.request.method}`,
    },
  });
});

try {
  await client.start();
  const started = await client.request('thread/start', {
    cwd: workspace,
    ephemeral: true,
    experimentalRawEvents: false,
  });
  const threadId = requiredString(started?.thread?.id ?? started?.threadId, 'thread id');
  const status = await waitForMcpServer(client, threadId);
  const marker = `codexapp-mcp-ok-${randomUUID()}`;
  const result = await client.request('mcpServer/tool/call', {
    threadId,
    server: 'codexapp_smoke',
    tool: 'echo',
    arguments: { value: marker },
  });
  if (!JSON.stringify(result).includes(marker)) {
    throw new Error('MCP tool response did not contain the exact marker');
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      server: status.name,
      tool: 'echo',
      discovered: true,
      called: true,
      exactResult: true,
      authStatus: status.authStatus,
    })}\n`,
  );
} finally {
  await client.stop().catch(() => undefined);
  await rm(root, { force: true, recursive: true });
}

async function waitForMcpServer(appServer, threadId) {
  let lastStatus;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await appServer.request('mcpServerStatus/list', {
      threadId,
      cursor: null,
      limit: 100,
      detail: 'toolsAndAuthOnly',
    });
    const rows = response?.data;
    if (!Array.isArray(rows)) throw new Error('MCP status did not return a data array');
    lastStatus = rows.find((row) => row?.name === 'codexapp_smoke');
    if (lastStatus?.tools?.echo?.name === 'echo') return lastStatus;
    await delay(250);
  }
  throw new Error(`MCP smoke server did not become ready: ${JSON.stringify(lastStatus)}`);
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is missing`);
  return value;
}

function tomlString(value) {
  return JSON.stringify(value);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
