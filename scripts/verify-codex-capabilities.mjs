import { readFileSync } from 'node:fs';
import { CodexAppServerClient } from '../packages/app-server-client/dist/index.js';

const codexBin = requiredEnvironment('VERIFY_CODEX_BIN');
const codexHome = requiredEnvironment('VERIFY_CODEX_HOME');
const workspace = requiredEnvironment('VERIFY_WORKSPACE');
const rendererVersion = process.env.VERIFY_RENDERER_VERSION ?? '26.727.51351';
const manifest = readCapabilitiesManifest(process.env.VERIFY_CAPABILITIES_MANIFEST);
const minimumSkillCount = manifest.minimumSkillCount ?? 0;
const requiredSkills = unique([
  ...manifest.requiredSkills,
  ...csvEnvironment('VERIFY_REQUIRED_SKILLS'),
]);
const requiredMcpServers = unique([
  ...manifest.requiredMcpServers,
  ...csvEnvironment('VERIFY_REQUIRED_MCP_SERVERS'),
]);
const requiredMcpTools = unique([
  ...manifest.requiredMcpTools,
  ...csvEnvironment('VERIFY_REQUIRED_MCP_TOOLS'),
]).map(parseRequiredMcpTool);

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
      message: `unexpected server request during capability verification: ${event.request.method}`,
    },
  });
});
client.on('stderr', (line) => {
  stderr.push(line);
  if (stderr.length > 30) stderr.shift();
});

try {
  await client.start();
  const skillsResponse = await client.request('skills/list', {
    cwds: [workspace],
    forceReload: true,
  });
  const skillNames = [...collectNamedValues(skillsResponse)].sort();
  const missingSkills = requiredSkills.filter((name) => !skillNames.includes(name));

  const started = await client.request('thread/start', {
    cwd: workspace,
    ephemeral: true,
    experimentalRawEvents: false,
  });
  const threadId = requiredString(started?.thread?.id ?? started?.threadId, 'ephemeral thread id');
  const mcpResponse = await waitForRequiredMcpCapabilities(client, threadId);
  const mcpServers = Array.isArray(mcpResponse?.data)
    ? mcpResponse.data.map((row) => ({
        name: row?.name,
        fields: row !== null && typeof row === 'object' ? Object.keys(row).sort() : [],
        status: row?.status ?? null,
        authStatus: row?.authStatus,
        errorPresent: row?.error !== null && row?.error !== undefined,
        toolNames: Object.keys(row?.tools ?? {}).sort(),
      }))
    : [];
  const mcpNames = mcpServers.map((row) => row.name);
  const missingMcpServers = requiredMcpServers.filter((name) => !mcpNames.includes(name));
  const missingMcpTools = requiredMcpTools
    .filter(
      ({ server, tool }) =>
        !mcpServers.some((row) => row.name === server && row.toolNames.includes(tool)),
    )
    .map(({ server, tool }) => `${server}/${tool}`);
  const skillCountSatisfied = skillNames.length >= minimumSkillCount;
  const ok =
    skillCountSatisfied &&
    missingSkills.length === 0 &&
    missingMcpServers.length === 0 &&
    missingMcpTools.length === 0;
  const result = {
    ok,
    rendererVersion,
    skillCount: skillNames.length,
    minimumSkillCount,
    skillCountSatisfied,
    skillNames,
    missingSkills,
    mcpServers,
    missingMcpServers,
    missingMcpTools,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
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

async function waitForRequiredMcpCapabilities(appServer, threadId) {
  let response;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    response = await appServer.request('mcpServerStatus/list', {
      threadId,
      cursor: null,
      limit: 100,
      detail: 'toolsAndAuthOnly',
    });
    const rows = Array.isArray(response?.data) ? response.data : [];
    const serversReady = requiredMcpServers.every((name) => rows.some((row) => row?.name === name));
    const toolsReady = requiredMcpTools.every(({ server, tool }) =>
      rows.some((row) => row?.name === server && row?.tools?.[tool]?.name === tool),
    );
    if (serversReady && toolsReady) return response;
    await delay(500);
  }
  return response;
}

function parseRequiredMcpTool(value) {
  const separator = value.indexOf('/');
  if (separator < 1 || separator === value.length - 1) {
    throw new Error(`invalid VERIFY_REQUIRED_MCP_TOOLS value: ${value}`);
  }
  return { server: value.slice(0, separator), tool: value.slice(separator + 1) };
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

function csvEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim().length === 0) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function readCapabilitiesManifest(path) {
  if (typeof path !== 'string' || path.length === 0) {
    return {
      minimumSkillCount: 0,
      requiredSkills: [],
      requiredMcpServers: [],
      requiredMcpTools: [],
    };
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('capabilities manifest must be a JSON object');
  }
  const minimumSkillCount = parsed.minimumSkillCount ?? 0;
  if (!Number.isSafeInteger(minimumSkillCount) || minimumSkillCount < 0) {
    throw new Error('capabilities manifest minimumSkillCount must be a non-negative integer');
  }
  return {
    minimumSkillCount,
    requiredSkills: stringArray(parsed.requiredSkills, 'requiredSkills'),
    requiredMcpServers: stringArray(parsed.requiredMcpServers, 'requiredMcpServers'),
    requiredMcpTools: stringArray(parsed.requiredMcpTools, 'requiredMcpTools'),
  };
}

function stringArray(value, label) {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item.length === 0)
  ) {
    throw new Error(`capabilities manifest ${label} must be an array of non-empty strings`);
  }
  return value;
}

function unique(values) {
  return [...new Set(values)];
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
