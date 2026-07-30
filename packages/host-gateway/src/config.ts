import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { z } from 'zod';

const loopbackProxyUrlSchema = z
  .string()
  .url()
  .superRefine((value, context) => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) {
      context.addIssue({
        code: 'custom',
        message: 'OpenAI egress proxy must use HTTP or HTTPS',
      });
    }
    if (!['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) {
      context.addIssue({
        code: 'custom',
        message: 'OpenAI egress proxy must listen on loopback',
      });
    }
    if (url.username.length > 0 || url.password.length > 0) {
      context.addIssue({
        code: 'custom',
        message: 'OpenAI egress proxy URL must not contain credentials',
      });
    }
  });

const configSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.coerce.number().int().min(1).max(65535).default(13010),
  publicOrigin: z.string().url(),
  trustedProxy: z.string().min(1).default('127.0.0.1'),
  officialRoot: z.string().min(1),
  officialSourceRoot: z.string().min(1),
  runtimeRoot: z.string().min(1),
  codexBin: z.string().min(1),
  browserExecutable: z.string().min(1).optional(),
  expectedRendererVersion: z.string().min(1),
  expectedCodexVersion: z.string().min(1),
  expectedBuildNumber: z.string().min(1),
  expectedBuildFlavor: z.string().min(1).default('prod'),
  expectedAppBrand: z.string().min(1).default('chatgpt'),
  sourceManifest: z.string().min(1),
  browserBridgeScript: z.string().min(1),
  openAiEgressProxyUrl: loopbackProxyUrlSchema.optional(),
  sessionSigningKeyFile: z.string().min(1),
  authSubjectHeader: z.string().min(1).default('x-authentik-uid'),
  authUsernameHeader: z.string().min(1).default('x-authentik-username'),
  authEmailHeader: z.string().min(1).default('x-authentik-email'),
  authNameHeader: z.string().min(1).default('x-authentik-name'),
  authGroupsHeader: z.string().min(1).default('x-authentik-groups'),
  authVerifiedHeader: z.string().min(1).optional(),
  authVerifiedValue: z.string().min(1).default('1'),
  authProxySecretHeader: z.string().min(1).default('x-aialra-proxy-secret'),
  authProxySecretFile: z.string().min(1).optional(),
  maxUploadBytes: z.coerce
    .number()
    .int()
    .positive()
    .default(100 * 1024 * 1024),
  sessionTtlSeconds: z.coerce.number().int().min(300).max(86_400).default(43_200),
  idleRuntimeSeconds: z.coerce.number().int().min(60).default(900),
  maxSessions: z.coerce.number().int().min(10).max(10_000).default(1_000),
  maxSessionsPerUser: z.coerce.number().int().min(2).max(100).default(20),
  maxBridgeMessagesPerSecond: z.coerce.number().int().min(50).max(5_000).default(500),
  minimumFreeBytes: z.coerce
    .number()
    .int()
    .min(256 * 1024 * 1024)
    .default(5 * 1024 * 1024 * 1024),
  devIdentity: z.string().optional(),
});

export type GatewayConfig = z.infer<typeof configSchema> & {
  sessionSigningKey: Buffer;
  authProxySecret?: Buffer;
};

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const values = configSchema.parse({
    host: environment.HOST,
    port: environment.PORT,
    publicOrigin: environment.PUBLIC_ORIGIN,
    trustedProxy: environment.TRUSTED_PROXY,
    officialRoot: environment.OFFICIAL_ROOT,
    officialSourceRoot: environment.OFFICIAL_SOURCE_ROOT,
    runtimeRoot: environment.RUNTIME_ROOT,
    codexBin: environment.CODEX_BIN,
    browserExecutable: environment.BROWSER_EXECUTABLE,
    expectedRendererVersion: environment.EXPECTED_RENDERER_VERSION,
    expectedCodexVersion: environment.EXPECTED_CODEX_VERSION,
    expectedBuildNumber: environment.EXPECTED_BUILD_NUMBER,
    expectedBuildFlavor: environment.EXPECTED_BUILD_FLAVOR,
    expectedAppBrand: environment.EXPECTED_APP_BRAND,
    sourceManifest: environment.SOURCE_MANIFEST,
    browserBridgeScript: environment.BROWSER_BRIDGE_SCRIPT,
    openAiEgressProxyUrl: environment.OPENAI_EGRESS_PROXY_URL,
    sessionSigningKeyFile: environment.SESSION_SIGNING_KEY_FILE,
    authSubjectHeader: environment.AUTH_SUBJECT_HEADER,
    authUsernameHeader: environment.AUTH_HEADER,
    authEmailHeader: environment.AUTH_EMAIL_HEADER,
    authNameHeader: environment.AUTH_NAME_HEADER,
    authGroupsHeader: environment.AUTH_GROUPS_HEADER,
    authVerifiedHeader: environment.AUTH_VERIFIED_HEADER,
    authVerifiedValue: environment.AUTH_VERIFIED_VALUE,
    authProxySecretHeader: environment.AUTH_PROXY_SECRET_HEADER,
    authProxySecretFile: environment.AUTH_PROXY_SECRET_FILE,
    maxUploadBytes: environment.MAX_UPLOAD_BYTES,
    sessionTtlSeconds: environment.SESSION_TTL_SECONDS,
    idleRuntimeSeconds: environment.IDLE_RUNTIME_SECONDS,
    maxSessions: environment.MAX_SESSIONS,
    maxSessionsPerUser: environment.MAX_SESSIONS_PER_USER,
    maxBridgeMessagesPerSecond: environment.MAX_BRIDGE_MESSAGES_PER_SECOND,
    minimumFreeBytes: environment.MINIMUM_FREE_BYTES,
    devIdentity: environment.NODE_ENV === 'development' ? environment.DEV_IDENTITY : undefined,
  });
  const sessionSigningKey = readFileSync(resolve(values.sessionSigningKeyFile));
  if (sessionSigningKey.length < 32) {
    throw new Error('session signing key must contain at least 32 bytes');
  }
  const authProxySecret =
    values.authProxySecretFile === undefined
      ? undefined
      : Buffer.from(readFileSync(resolve(values.authProxySecretFile), 'utf8').trim());
  if (authProxySecret !== undefined && authProxySecret.length < 32) {
    throw new Error('authentication proxy secret must contain at least 32 bytes');
  }
  return {
    ...values,
    officialRoot: resolve(values.officialRoot),
    officialSourceRoot: resolve(values.officialSourceRoot),
    runtimeRoot: resolve(values.runtimeRoot),
    codexBin: resolve(values.codexBin),
    ...(values.browserExecutable === undefined
      ? {}
      : { browserExecutable: resolve(values.browserExecutable) }),
    sourceManifest: resolve(values.sourceManifest),
    browserBridgeScript: resolve(values.browserBridgeScript),
    sessionSigningKeyFile: resolve(values.sessionSigningKeyFile),
    sessionSigningKey,
    ...(values.authProxySecretFile === undefined
      ? {}
      : { authProxySecretFile: resolve(values.authProxySecretFile) }),
    ...(authProxySecret === undefined ? {} : { authProxySecret }),
  };
}
