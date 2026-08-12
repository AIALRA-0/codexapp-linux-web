import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { connectOfficialBridge, createIdentityHeaders } from './lib/official-bridge-client.mjs';

const baseUrl = requiredEnvironment('SMOKE_BASE_URL');
const publicOrigin = requiredEnvironment('SMOKE_PUBLIC_ORIGIN');
const proxySecret = requiredEnvironment('SMOKE_PROXY_SECRET');
const proxySecretHeader = process.env.SMOKE_PROXY_SECRET_HEADER ?? 'X-Aialra-Proxy-Secret';
const subject = requiredEnvironment('SMOKE_SUBJECT');
const username = requiredEnvironment('SMOKE_USERNAME');
const email = requiredEnvironment('SMOKE_EMAIL');
const threadId = requiredEnvironment('SMOKE_THREAD_ID');
const maximumWarmMs = positiveNumberEnvironment('SMOKE_MAXIMUM_WARM_MS', 2_000);
const verifyInvalidation = process.env.SMOKE_VERIFY_CACHE_INVALIDATION === '1';

const bridge = await connectOfficialBridge({
  baseUrl,
  publicOrigin,
  identityHeaders: createIdentityHeaders({
    email,
    proxySecret,
    proxySecretHeader,
    subject,
    username,
  }),
});

try {
  const params = {
    threadId,
    cursor: null,
    limit: 5,
    itemsView: 'full',
    sortDirection: 'desc',
  };
  const cold = await measuredRequest(bridge, params);
  const warm = await measuredRequest(bridge, params);
  if (cold.sha256 !== warm.sha256)
    throw new Error('warm history response differs from cold result');
  if (warm.durationMs > maximumWarmMs) {
    throw new Error(`warm history response exceeded ${String(maximumWarmMs)} ms`);
  }

  let afterInvalidation;
  if (verifyInvalidation) {
    const projectless = await bridge.desktopFetch('projectless-thread-cwd', {});
    const workspaceRoot = requiredString(projectless.workspaceRoot, 'projectless workspace root');
    const developerInstructions = await bridge.desktopFetch('developer-instructions', {
      cwd: workspaceRoot,
      hostId: 'local',
      threadId: null,
      threadToolsEnabled: false,
    });
    const started = await bridge.prewarmThreadStart({
      cwd: workspaceRoot,
      developerInstructions: requiredString(
        developerInstructions.instructions,
        'developer instructions',
      ),
      dynamicTools: [],
      ephemeral: true,
      experimentalRawEvents: false,
    });
    const ephemeralThreadId = requiredString(
      started?.thread?.id ?? started?.threadId,
      'ephemeral thread id',
    );
    // Starting the ephemeral thread is itself a thread mutation and therefore
    // exercises invalidation. Some official app-server builds correctly reject
    // deleting it because an ephemeral thread was never persisted.
    await bridge
      .mcpRequest('thread/delete', { threadId: ephemeralThreadId })
      .catch(() => undefined);
    const coldAgain = await measuredRequest(bridge, params);
    const warmAgain = await measuredRequest(bridge, params);
    if (coldAgain.sha256 !== cold.sha256 || warmAgain.sha256 !== cold.sha256) {
      throw new Error('history changed during cache invalidation test');
    }
    if (warmAgain.durationMs > maximumWarmMs) {
      throw new Error(`post-invalidation warm response exceeded ${String(maximumWarmMs)} ms`);
    }
    if (coldAgain.durationMs <= warmAgain.durationMs * 5) {
      throw new Error('thread mutation did not invalidate the prior history cache');
    }
    afterInvalidation = { cold: publicMeasurement(coldAgain), warm: publicMeasurement(warmAgain) };
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      threadId,
      initial: { cold: publicMeasurement(cold), warm: publicMeasurement(warm) },
      afterInvalidation,
    })}\n`,
  );
} finally {
  bridge.close();
}

async function measuredRequest(client, params) {
  const startedAt = performance.now();
  const result = await client.mcpRequest('thread/turns/list', params, 300_000);
  const serialized = JSON.stringify(result);
  return {
    bytes: Buffer.byteLength(serialized),
    dataCount: Array.isArray(result?.data) ? result.data.length : null,
    durationMs: Math.round(performance.now() - startedAt),
    hasNextCursor: typeof result?.nextCursor === 'string',
    sha256: createHash('sha256').update(serialized).digest('hex'),
  };
}

function publicMeasurement(measurement) {
  return {
    bytes: measurement.bytes,
    dataCount: measurement.dataCount,
    durationMs: measurement.durationMs,
    hasNextCursor: measurement.hasNextCursor,
    sha256: measurement.sha256,
  };
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function positiveNumberEnvironment(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is missing`);
  return value;
}
