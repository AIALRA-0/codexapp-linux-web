import { connectOfficialBridge, createIdentityHeaders } from './lib/official-bridge-client.mjs';
import { readFile } from 'node:fs/promises';

const baseUrl = process.env.SMOKE_BASE_URL;
const publicOrigin = process.env.SMOKE_PUBLIC_ORIGIN;
const proxySecretFile = process.env.SMOKE_PROXY_SECRET_FILE;
const proxySecret =
  process.env.SMOKE_PROXY_SECRET ??
  (proxySecretFile === undefined ? undefined : (await readFile(proxySecretFile, 'utf8')).trim());
const sampleCount = Number.parseInt(process.env.BRIDGE_LATENCY_SAMPLES ?? '40', 10);

if (baseUrl === undefined || publicOrigin === undefined || proxySecret === undefined) {
  throw new Error(
    'SMOKE_BASE_URL, SMOKE_PUBLIC_ORIGIN, and SMOKE_PROXY_SECRET or SMOKE_PROXY_SECRET_FILE are required',
  );
}
if (!Number.isSafeInteger(sampleCount) || sampleCount < 1 || sampleCount > 1_000) {
  throw new Error('BRIDGE_LATENCY_SAMPLES must be an integer from 1 to 1000');
}

const bridge = await connectOfficialBridge({
  baseUrl,
  publicOrigin,
  identityHeaders: createIdentityHeaders({
    email: 'bridge-latency@example.invalid',
    proxySecret,
    subject: 'bridge-latency',
    username: 'bridge-latency',
  }),
});

const samples = [];
try {
  for (let index = 0; index < sampleCount; index += 1) {
    const startedAt = performance.now();
    await bridge.command({ type: 'ready' });
    samples.push(performance.now() - startedAt);
  }
} finally {
  bridge.close();
}

samples.sort((left, right) => left - right);
const percentile = (value) =>
  samples[Math.min(samples.length - 1, Math.floor((samples.length - 1) * value))];

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    sampleCount: samples.length,
    minMs: samples[0],
    p50Ms: percentile(0.5),
    p90Ms: percentile(0.9),
    p95Ms: percentile(0.95),
    maxMs: samples.at(-1),
  })}\n`,
);
