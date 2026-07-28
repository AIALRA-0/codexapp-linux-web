import { z } from 'zod';

export const CONTRACT_VERSION = 1 as const;

export const jsonRpcIdSchema = z.union([z.string(), z.number().int()]);

export const jsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0').optional(),
  id: jsonRpcIdSchema,
  method: z.string().min(1),
  params: z.unknown().optional(),
  trace: z.unknown().optional(),
});

export const jsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal('2.0').optional(),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

export const jsonRpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});

export const jsonRpcResponseSchema = z
  .object({
    jsonrpc: z.literal('2.0').optional(),
    id: jsonRpcIdSchema,
    result: z.unknown().optional(),
    error: jsonRpcErrorSchema.optional(),
  })
  .refine((value) => (value.result === undefined) !== (value.error === undefined), {
    message: 'JSON-RPC response must contain exactly one of result or error',
  });

export type JsonRpcId = z.infer<typeof jsonRpcIdSchema>;
export type JsonRpcRequest = z.infer<typeof jsonRpcRequestSchema>;
export type JsonRpcNotification = z.infer<typeof jsonRpcNotificationSchema>;
export type JsonRpcResponse = z.infer<typeof jsonRpcResponseSchema>;

const baseFrameSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  sequence: z.number().int().nonnegative(),
});

export const clientHelloFrameSchema = baseFrameSchema.extend({
  type: z.literal('hello'),
  ticket: z.string().min(32),
  rendererVersion: z.string().min(1),
  lastHostSequence: z.number().int().nonnegative(),
});

export const clientCommandFrameSchema = baseFrameSchema.extend({
  type: z.literal('command'),
  commandId: z.string().uuid(),
  message: z.unknown(),
});

export const clientWorkerCommandFrameSchema = baseFrameSchema.extend({
  type: z.literal('worker-command'),
  commandId: z.string().uuid(),
  worker: z.string().min(1).max(64),
  message: z.unknown(),
});

export const clientHostPortFrameSchema = baseFrameSchema.extend({
  type: z.literal('host-port-message'),
  portId: z.string().uuid(),
  message: z.unknown(),
});

export const clientAckFrameSchema = baseFrameSchema.extend({
  type: z.literal('ack'),
  hostSequence: z.number().int().nonnegative(),
});

export const clientFrameSchema = z.discriminatedUnion('type', [
  clientHelloFrameSchema,
  clientCommandFrameSchema,
  clientWorkerCommandFrameSchema,
  clientHostPortFrameSchema,
  clientAckFrameSchema,
]);

export const hostReadyFrameSchema = baseFrameSchema.extend({
  type: z.literal('ready'),
  sessionId: z.string().uuid(),
  rendererVersion: z.string(),
  replayedThrough: z.number().int().nonnegative(),
});

export const hostCommandResultFrameSchema = baseFrameSchema.extend({
  type: z.literal('command-result'),
  commandId: z.string().uuid(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});

export const hostViewMessageFrameSchema = baseFrameSchema.extend({
  type: z.literal('view-message'),
  message: z.unknown(),
});

export const hostWorkerMessageFrameSchema = baseFrameSchema.extend({
  type: z.literal('worker-message'),
  worker: z.string(),
  message: z.unknown(),
});

export const hostPortMessageFrameSchema = baseFrameSchema.extend({
  type: z.literal('host-port-message'),
  portId: z.string().uuid(),
  message: z.unknown(),
});

export const hostFatalFrameSchema = baseFrameSchema.extend({
  type: z.literal('fatal'),
  code: z.string(),
  message: z.string(),
});

export const hostFrameSchema = z.discriminatedUnion('type', [
  hostReadyFrameSchema,
  hostCommandResultFrameSchema,
  hostViewMessageFrameSchema,
  hostWorkerMessageFrameSchema,
  hostPortMessageFrameSchema,
  hostFatalFrameSchema,
]);

export type ClientFrame = z.infer<typeof clientFrameSchema>;
export type HostFrame = z.infer<typeof hostFrameSchema>;

export const preloadContractSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  rendererVersion: z.string(),
  appBuildNumber: z.string(),
  windowType: z.literal('electron'),
  methods: z.array(z.string()).min(1),
  channels: z.array(z.string()),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export type PreloadContract = z.infer<typeof preloadContractSchema>;

export const runtimeBootstrapSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  rendererVersion: z.string(),
  websocketUrl: z.string().url(),
  ticket: z.string().min(32),
  appSessionId: z.string().uuid(),
  buildFlavor: z.string(),
  initialSidebarBootstrap: z.unknown().nullable(),
  sentryInitOptions: z.record(z.string(), z.unknown()),
  sharedObjectSnapshot: z.record(z.string(), z.unknown()),
  systemThemeVariant: z.enum(['dark', 'light']),
  usesOwlAppShell: z.boolean(),
  uploadPathPrefix: z.string().startsWith('/'),
});

export type RuntimeBootstrap = z.infer<typeof runtimeBootstrapSchema>;

export const authentikIdentitySchema = z.object({
  subject: z.string().min(1).max(256).optional(),
  username: z.string().min(1).max(256),
  email: z.string().email().optional(),
  name: z.string().max(256).optional(),
  groups: z.array(z.string()).default([]),
});

export type AuthentikIdentity = z.infer<typeof authentikIdentitySchema>;
