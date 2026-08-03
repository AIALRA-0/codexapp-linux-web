import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { RawData } from 'ws';

import {
  clientFrameSchema,
  runtimeBootstrapSchema,
  type AuthentikIdentity,
  type ClientFrame,
} from '@codexapp/contracts';
import { verifyPreparedRelease } from '@codexapp/official-package';

import type { GatewayConfig } from './config.js';
import {
  identitiesMatch,
  issueTicket,
  readIdentity,
  userKeyForIdentity,
  verifyTicket,
} from './identity.js';
import { ConnectionRateLimiter } from './rate-limit.js';
import { RuntimeRegistry, type UserRuntime } from './runtime.js';
import { BrowserSession } from './session.js';
import { readStorageHealth } from './storage.js';

interface SessionEntry {
  session: BrowserSession;
  identity: AuthentikIdentity;
  runtime: UserRuntime;
  cleanupTimer?: NodeJS.Timeout;
}

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS: Record<string, string> = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy':
    'camera=(self), microphone=(self), display-capture=(self), clipboard-read=(self), clipboard-write=(self)',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

const WEBSOCKET_HEARTBEAT_INTERVAL_MS = 25_000;

interface WebSocketHeartbeatTarget {
  readyState: number;
  off(event: 'close', listener: () => void): unknown;
  once(event: 'close', listener: () => void): unknown;
  ping(): unknown;
}

const CSP = [
  "default-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' blob: data: https:",
  "child-src 'self' blob: https://*.web-sandbox.oaiusercontent.com https://web-sandbox.oaiusercontent.com",
  "frame-src 'self' blob: https://*.web-sandbox.oaiusercontent.com https://web-sandbox.oaiusercontent.com",
  "worker-src 'self' blob:",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "media-src 'self' blob: data:",
  "connect-src 'self' https://ab.chatgpt.com https://api.mapbox.com https://cdn.openai.com https://events.mapbox.com wss://chatgpt.com wss://ws.chatgpt-staging.com wss://ws.chatgpt.com",
].join('; ');

const BROWSER_BRIDGE_MODULES = [
  'browser-file-picker.js',
  'file-protocol.js',
  'index.js',
  'navigation.js',
  'ordered-buffer.js',
  'reconnect.js',
  'remote-webview.js',
] as const;

const MAX_CONCURRENT_BRIDGE_INVOCATIONS = 128;

export async function createGateway(config: GatewayConfig): Promise<FastifyInstance> {
  const qualification = verifyPreparedRelease(config.sourceManifest);
  if (qualification.package.version !== config.expectedRendererVersion) {
    throw new Error(
      `renderer version mismatch: expected ${config.expectedRendererVersion}, got ${qualification.package.version}`,
    );
  }
  if (
    qualification.package.buildNumber !== config.expectedBuildNumber ||
    qualification.package.buildFlavor !== config.expectedBuildFlavor ||
    qualification.package.brand !== config.expectedAppBrand
  ) {
    throw new Error('official package build identity does not match the configured release');
  }
  if (resolve(qualification.renderer.root) !== resolve(config.officialRoot)) {
    throw new Error('OFFICIAL_ROOT does not match the verified source manifest');
  }
  if (resolve(qualification.host.root) !== resolve(config.officialSourceRoot)) {
    throw new Error('OFFICIAL_SOURCE_ROOT does not match the verified source manifest');
  }

  const bridgeModuleRoot = dirname(config.browserBridgeScript);
  const bridgeModules = new Map<string, Buffer>(
    BROWSER_BRIDGE_MODULES.map((filename) => [
      filename,
      readFileSync(join(bridgeModuleRoot, filename)),
    ]),
  );
  const missingBridgeImports = findMissingBrowserBridgeImports(bridgeModules);
  if (missingBridgeImports.length > 0) {
    throw new Error(`browser bridge imports are not served: ${missingBridgeImports.join(', ')}`);
  }
  const bridgeHash = createHash('sha256');
  for (const [filename, source] of bridgeModules) {
    bridgeHash.update(filename).update('\0').update(source).update('\0');
  }
  const bridgeBasePath = `/__codex/bridge-${bridgeHash.digest('hex').slice(0, 20)}`;
  const bridgePath = `${bridgeBasePath}/index.js`;
  const officialIndex = readFileSync(join(config.officialRoot, 'index.html'), 'utf8');
  const renderedIndex = injectBridgeScripts(officialIndex, bridgePath);
  const runtimes = new RuntimeRegistry(config);
  const sessions = new Map<string, SessionEntry>();
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers.x-authentik-email',
          'req.headers.x-authentik-username',
          'req.headers.x-aialra-email',
          'req.headers.x-aialra-sub',
          'req.headers.x-aialra-user',
          '*.ticket',
        ],
        censor: '[redacted]',
      },
    },
    bodyLimit: config.maxUploadBytes,
    trustProxy: false,
    requestTimeout: 130_000,
  });
  const observedRuntimes = new WeakSet<UserRuntime>();
  const observeRuntime = (runtime: UserRuntime): void => {
    if (observedRuntimes.has(runtime)) return;
    observedRuntimes.add(runtime);
    if (process.env.NODE_ENV === 'development') {
      runtime.on('app-host-send', (message: string) => {
        const details = { appHostFrame: message.slice(0, 4_000) };
        if (message.startsWith('["reject"')) {
          app.log.warn(details, 'AppHost call rejected');
        } else {
          app.log.debug(details, 'AppHost frame sent');
        }
      });
    }
    runtime.on('capability-error', (details: unknown) => {
      app.log.warn({ details }, 'renderer capability request failed');
    });
    runtime.on('performance', (details: unknown) => {
      const record =
        details !== null && typeof details === 'object' ? (details as Record<string, unknown>) : {};
      const durationMs = typeof record.durationMs === 'number' ? record.durationMs : 0;
      if (durationMs >= 250) {
        app.log.info({ details: record }, 'renderer request latency');
      } else {
        app.log.debug({ details: record }, 'renderer request latency');
      }
    });
  };

  await app.register(websocket, {
    options: {
      maxPayload: 16 * 1024 * 1024,
      perMessageDeflate: true,
    },
    preClose(done) {
      terminateWebsocketClients(this.websocketServer.clients);
      this.websocketServer.close(done);
    },
  });

  app.addHook('onSend', (_request, reply, payload, done) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
    reply.header('content-security-policy', CSP);
    done(null, payload);
  });

  app.get('/healthz', () => ({
    ok: true,
    rendererVersion: qualification.package.version,
  }));
  app.get('/readyz', (_request, reply) => {
    const storage = readStorageHealth(config.runtimeRoot, config.minimumFreeBytes);
    if (!storage.ok) reply.code(503);
    return {
      ok: storage.ok,
      rendererTreeSha256: qualification.renderer.treeSha256,
      storage,
    };
  });

  app.get<{ Params: { filename: string } }>(
    `${bridgeBasePath}/:filename`,
    async (request, reply) => {
      requireIdentity(request, config);
      const source = bridgeModules.get(request.params.filename);
      if (source === undefined) {
        return reply.code(404).type('text/plain; charset=utf-8').send('not found');
      }
      return reply
        .header('cache-control', 'public, max-age=31536000, immutable')
        .type('text/javascript; charset=utf-8')
        .send(source);
    },
  );

  app.get('/__codex/bootstrap.js', async (request, reply) => {
    const identity = requireIdentity(request, config);
    const runtime = await runtimes.acquire(identity);
    try {
      const sessionId = randomUUID();
      const ticket = issueTicket(identity, sessionId, config);
      const bootstrap = runtimeBootstrapSchema.parse({
        contractVersion: 1,
        rendererVersion: config.expectedRendererVersion,
        websocketUrl: new URL('/api/bridge', config.publicOrigin)
          .toString()
          .replace(/^http/u, 'ws'),
        ticket,
        appSessionId: sessionId,
        buildFlavor: qualification.package.buildFlavor,
        initialSidebarBootstrap: runtime.initialSidebarBootstrap,
        sentryInitOptions: {
          codexAppSessionId: sessionId,
          appVersion: config.expectedRendererVersion,
          buildFlavor: qualification.package.buildFlavor,
          buildNumber: qualification.package.buildNumber,
          desktopTraceSampleRate: 0,
          initialDesktopTraceSampleRate: 0,
        },
        sharedObjectSnapshot: runtime.sharedObjectSnapshot,
        systemThemeVariant: 'light',
        usesOwlAppShell: false,
        uploadPathPrefix: runtime.uploadPathPrefix,
      });
      const source = `window.__CODEX_BROWSER_BOOTSTRAP__=${escapeScriptJson(bootstrap)};\n`;
      return reply
        .header('cache-control', 'private, no-store')
        .type('text/javascript; charset=utf-8')
        .send(source);
    } finally {
      runtimes.release(runtime);
    }
  });

  app.addContentTypeParser('*', (_request, payload, done) => {
    done(null, payload);
  });

  app.put<{
    Params: { uploadId: string; filename: string };
  }>('/api/uploads/:uploadId/:filename', async (request, reply) => {
    const identity = requireIdentity(request, config);
    const runtime = await runtimes.acquire(identity);
    try {
      await storeUpload(
        runtime,
        request.params.uploadId,
        request.params.filename,
        request.body as Readable,
        config.maxUploadBytes,
      );
      return reply.code(201).send({ ok: true });
    } finally {
      runtimes.release(runtime);
    }
  });

  app.get<{
    Params: { token: string; filename: string };
  }>('/api/downloads/:token/:filename', async (request, reply) => {
    const identity = requireIdentity(request, config);
    const runtime = await runtimes.acquire(identity);
    try {
      const token = request.params.token;
      const filename = request.params.filename;
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(token) ||
        filename !== basename(filename)
      ) {
        return reply.code(404).type('text/plain; charset=utf-8').send('not found');
      }
      const download = runtime.claimBrowserDownload(token, filename);
      if (download === null) {
        return reply.code(404).type('text/plain; charset=utf-8').send('not found');
      }
      const fileStat = statSync(download.path);
      if (!fileStat.isFile()) {
        return reply.code(404).type('text/plain; charset=utf-8').send('not found');
      }
      return reply
        .header('cache-control', 'private, no-store')
        .header('content-length', String(fileStat.size))
        .header('content-disposition', browserDownloadDisposition(filename))
        .type('application/octet-stream')
        .send(createReadStream(download.path));
    } finally {
      runtimes.release(runtime);
    }
  });

  app.get<{ Params: { '*': string } }>('/@fs/*', async (request, reply) => {
    const identity = requireIdentity(request, config);
    const runtime = await runtimes.acquire(identity);
    try {
      const path = resolveBrowserFileAsset(request.params['*'], runtime.root);
      if (path === null) {
        return reply.code(404).type('text/plain; charset=utf-8').send('not found');
      }
      const fileStat = statSync(path);
      const contentType = CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
      return reply
        .header('accept-ranges', 'none')
        .header('cache-control', 'private, no-store')
        .header('content-length', String(fileStat.size))
        .type(contentType)
        .send(createReadStream(path));
    } finally {
      runtimes.release(runtime);
    }
  });

  app.get('/api/bridge', { websocket: true }, (socket, request) => {
    const identity = requireIdentity(request, config);
    const auditUserKey = userKeyForIdentity(identity);
    if (request.headers.origin !== config.publicOrigin) {
      app.log.warn({ auditUserKey }, 'bridge origin rejected');
      socket.close(4403, 'origin rejected');
      return;
    }
    installWebSocketHeartbeat(socket);
    let entry: SessionEntry | undefined;
    let helloReceived = false;
    let frameQueue = Promise.resolve();
    const concurrentInvocations = new Set<Promise<void>>();
    const rateLimiter = new ConnectionRateLimiter(
      config.maxBridgeMessagesPerSecond,
      config.maxBridgeMessagesPerSecond * 2,
    );
    const helloTimer = setTimeout(() => socket.close(4408, 'hello timeout'), 10_000);
    helloTimer.unref();

    socket.on('message', (raw: RawData) => {
      if (!rateLimiter.consume()) {
        app.log.warn({ auditUserKey }, 'bridge message rate limit exceeded');
        socket.close(4429, 'rate limit exceeded');
        return;
      }
      frameQueue = frameQueue
        .then(async () => {
          let frame: ClientFrame;
          try {
            frame = clientFrameSchema.parse(JSON.parse(rawDataToString(raw)));
          } catch {
            socket.close(4400, 'invalid protocol frame');
            return;
          }
          if (!helloReceived) {
            if (frame.type !== 'hello') {
              socket.close(4400, 'hello required');
              return;
            }
            if (frame.rendererVersion !== config.expectedRendererVersion) {
              socket.close(4409, 'renderer version mismatch');
              return;
            }
            let ticket;
            try {
              ticket = verifyTicket(frame.ticket, identity, config);
            } catch {
              clearTimeout(helloTimer);
              app.log.warn({ auditUserKey }, 'bridge ticket rejected');
              socket.close(4401, 'invalid or expired session ticket');
              return;
            }
            clearTimeout(helloTimer);
            helloReceived = true;
            entry = sessions.get(ticket.sessionId);
            const resumedSession = entry !== undefined;
            if (entry === undefined) {
              if (missingBridgeSessionRequiresReload(frame.lastHostSequence)) {
                app.log.info(
                  {
                    auditUserKey,
                    sessionId: ticket.sessionId,
                    lastHostSequence: frame.lastHostSequence,
                  },
                  'bridge session state unavailable; renderer reload requested',
                );
                socket.close(4410, 'browser session state unavailable');
                return;
              }
              if (
                sessions.size >= config.maxSessions ||
                countIdentitySessions(sessions.values(), identity) >= config.maxSessionsPerUser
              ) {
                app.log.warn({ auditUserKey }, 'bridge session capacity exceeded');
                socket.close(4429, 'session capacity exceeded');
                return;
              }
              const runtime = await runtimes.acquire(identity);
              observeRuntime(runtime);
              entry = {
                session: new BrowserSession(ticket.sessionId, runtime),
                identity,
                runtime,
              };
              sessions.set(ticket.sessionId, entry);
              app.log.info(
                {
                  auditUserKey,
                  sessionId: ticket.sessionId,
                  identitySessionCount: countIdentitySessions(sessions.values(), identity),
                  reconnectableSessionCount: countReconnectableIdentitySessions(
                    sessions.values(),
                    identity,
                  ),
                },
                'bridge session created',
              );
            } else if (!identitiesMatch(entry.identity, identity)) {
              app.log.warn(
                { auditUserKey, sessionId: ticket.sessionId },
                'bridge identity rejected',
              );
              socket.close(4403, 'session identity mismatch');
              return;
            }
            if (entry.cleanupTimer !== undefined) {
              clearTimeout(entry.cleanupTimer);
              delete entry.cleanupTimer;
            }
            entry.session.attach(socket, frame.lastHostSequence);
            if (resumedSession) {
              app.log.info(
                {
                  auditUserKey,
                  lastHostSequence: frame.lastHostSequence,
                  pendingHostFrames: entry.session.pendingHostFrames,
                  sessionId: entry.session.id,
                },
                'bridge session resumed',
              );
            }
            return;
          }
          if (frame.type === 'hello' || entry === undefined) {
            socket.close(4400, 'duplicate hello');
            return;
          }
          const commandMessageType =
            frame.type === 'command' && frame.message !== null && typeof frame.message === 'object'
              ? (frame.message as Record<string, unknown>).type
              : undefined;
          if (
            frame.type === 'host-port-message' ||
            (frame.type === 'command' &&
              ['fetch', 'fetch-stream'].includes(String(commandMessageType)))
          ) {
            app.log.debug(
              {
                frameType: frame.type,
                sequence: frame.sequence,
                commandMessageType,
                appHostFrame:
                  frame.type === 'host-port-message' && typeof frame.message === 'string'
                    ? frame.message.slice(0, 1_000)
                    : undefined,
                bridgeMessage:
                  process.env.NODE_ENV === 'development' &&
                  frame.type === 'command' &&
                  frame.message !== null &&
                  typeof frame.message === 'object' &&
                  ['fetch', 'fetch-stream'].includes(
                    String((frame.message as Record<string, unknown>).type),
                  )
                    ? JSON.stringify(frame.message).slice(0, 4_000)
                    : undefined,
              },
              'bridge frame received',
            );
          }
          if (isConcurrentBridgeInvocation(frame)) {
            if (concurrentInvocations.size >= MAX_CONCURRENT_BRIDGE_INVOCATIONS) {
              app.log.warn(
                {
                  auditUserKey,
                  sessionId: entry.session.id,
                  concurrentInvocationCount: concurrentInvocations.size,
                },
                'bridge concurrent invocation limit exceeded',
              );
              socket.close(4429, 'concurrent invocation limit exceeded');
              return;
            }
            const invocation = handleClientFrame(entry.session, frame)
              .catch((error: unknown) => {
                app.log.error({ err: error }, 'concurrent bridge frame failed');
                socket.close(4500, 'host command failed');
              })
              .finally(() => concurrentInvocations.delete(invocation));
            concurrentInvocations.add(invocation);
            return;
          }
          await handleClientFrame(entry.session, frame);
        })
        .catch((error: unknown) => {
          app.log.error({ err: error }, 'bridge frame failed');
          socket.close(4500, 'host command failed');
        });
    });
    socket.on('close', (code, reason) => {
      clearTimeout(helloTimer);
      if (entry === undefined) return;
      if (!entry.session.detach(socket)) return;
      app.log.info(
        {
          auditUserKey,
          closeCode: code,
          closeReason: reason.toString().slice(0, 160),
          sessionId: entry.session.id,
        },
        'bridge connection closed',
      );
      if (entry.cleanupTimer === undefined) {
        entry.cleanupTimer = setTimeout(() => {
          if (entry === undefined) return;
          const pendingHostFrames = entry.session.pendingHostFrames;
          entry.session.dispose();
          sessions.delete(entry.session.id);
          app.log.info(
            {
              auditUserKey,
              sessionId: entry.session.id,
              pendingHostFrames,
            },
            'bridge reconnect window expired',
          );
          runtimes.release(entry.runtime);
        }, 10 * 60_000);
        entry.cleanupTimer.unref();
      }
    });
  });

  app.get<{
    Querystring: {
      browserSessionId?: string;
      browserTabId?: string;
      conversationId?: string;
    };
  }>('/api/browser-surface', { websocket: true }, (socket, request) => {
    const identity = requireIdentity(request, config);
    const auditUserKey = userKeyForIdentity(identity);
    if (request.headers.origin !== config.publicOrigin) {
      app.log.warn({ auditUserKey }, 'browser surface origin rejected');
      socket.close(4403, 'origin rejected');
      return;
    }
    installWebSocketHeartbeat(socket);
    const { browserSessionId, browserTabId, conversationId } = request.query;
    if (
      typeof browserSessionId !== 'string' ||
      typeof browserTabId !== 'string' ||
      typeof conversationId !== 'string'
    ) {
      socket.close(4400, 'browser surface route is incomplete');
      return;
    }
    const entry = sessions.get(browserSessionId);
    if (entry === undefined || !identitiesMatch(entry.identity, identity)) {
      app.log.warn({ auditUserKey, browserSessionId }, 'browser surface identity rejected');
      socket.close(4403, 'browser surface session rejected');
      return;
    }
    let surface: Awaited<ReturnType<UserRuntime['browserRuntime']['attachSurface']>> | undefined;
    let closed = false;
    const pendingMessages: unknown[] = [];
    const rateLimiter = new ConnectionRateLimiter(
      config.maxBridgeMessagesPerSecond,
      config.maxBridgeMessagesPerSecond * 2,
    );
    void entry.runtime.browserRuntime
      .attachSurface(browserSessionId, conversationId, browserTabId, (message) => {
        if (socket.readyState === 1) socket.send(JSON.stringify(message));
      })
      .then((handle) => {
        if (closed) {
          handle.close();
          return;
        }
        surface = handle;
        for (const message of pendingMessages) handle.receive(message);
        pendingMessages.length = 0;
      })
      .catch((error: unknown) => {
        app.log.warn(
          {
            err: error,
            browserSessionId,
            browserTabId,
            conversationId,
          },
          'browser surface attach failed',
        );
        socket.close(4404, 'browser surface unavailable');
      });
    socket.on('message', (raw: RawData) => {
      if (!rateLimiter.consume()) {
        app.log.warn({ auditUserKey, browserSessionId }, 'browser surface rate limit exceeded');
        socket.close(4429, 'rate limit exceeded');
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(rawDataToString(raw)) as unknown;
      } catch {
        socket.close(4400, 'invalid browser surface frame');
        return;
      }
      if (surface === undefined) {
        if (pendingMessages.length >= 100) {
          socket.close(4409, 'browser surface input buffer exceeded');
          return;
        }
        pendingMessages.push(message);
        return;
      }
      surface.receive(message);
    });
    socket.on('close', () => {
      closed = true;
      pendingMessages.length = 0;
      surface?.close();
    });
  });

  app.get<{ Params: { '*': string } }>('/*', async (request, reply) => {
    const identity = requireIdentity(request, config);
    const requested = request.params['*'];
    if (requested === '' && !requestHasInitialRoute(request, config.publicOrigin)) {
      const runtime = await runtimes.acquire(identity);
      try {
        const initialRoute = await runtime.readInitialRoute();
        const location = officialInitialRouteLocation(initialRoute);
        if (location !== '/') return reply.redirect(location);
      } finally {
        runtimes.release(runtime);
      }
    }
    if (shouldServeRendererIndex(requested, request.headers.accept)) {
      return reply
        .header('cache-control', 'private, no-store')
        .type('text/html; charset=utf-8')
        .send(renderedIndex);
    }
    return sendOfficialAsset(requested, config.officialRoot, reply);
  });

  app.addHook('onClose', async () => {
    for (const entry of sessions.values()) entry.session.dispose();
    sessions.clear();
    await runtimes.stopAll();
  });
  return app;
}

export function findMissingBrowserBridgeImports(
  modules: ReadonlyMap<string, Buffer | string>,
): string[] {
  const missing = new Set<string>();
  const localImport = /(?:from\s*|import\s*)['"]\.\/([A-Za-z0-9._-]+\.js)['"]/gu;
  for (const source of modules.values()) {
    for (const match of source.toString().matchAll(localImport)) {
      const filename = match[1];
      if (filename !== undefined && !modules.has(filename)) missing.add(filename);
    }
  }
  return [...missing].sort();
}

export function countIdentitySessions(
  entries: Iterable<Pick<SessionEntry, 'identity'>>,
  identity: AuthentikIdentity,
): number {
  let count = 0;
  for (const entry of entries) {
    if (identitiesMatch(entry.identity, identity)) count += 1;
  }
  return count;
}

export function countReconnectableIdentitySessions(
  entries: Iterable<Pick<SessionEntry, 'identity' | 'cleanupTimer'>>,
  identity: AuthentikIdentity,
): number {
  let count = 0;
  for (const entry of entries) {
    if (entry.cleanupTimer !== undefined && identitiesMatch(entry.identity, identity)) count += 1;
  }
  return count;
}

export function officialInitialRouteLocation(initialRoute: '/' | '/login'): string {
  if (initialRoute === '/') return '/';
  const url = new URL('http://official-renderer.invalid/');
  url.searchParams.set('initialRoute', initialRoute);
  return `${url.pathname}${url.search}`;
}

export function missingBridgeSessionRequiresReload(lastHostSequence: number): boolean {
  return lastHostSequence > 0;
}

export function isConcurrentBridgeInvocation(frame: ClientFrame): boolean {
  return frame.type === 'command' || frame.type === 'worker-command';
}

export function shouldServeRendererIndex(
  requested: string,
  acceptHeader: string | undefined,
): boolean {
  return (
    requested === '' ||
    requested === 'index.html' ||
    acceptHeader
      ?.split(',')
      .some((value) => value.trim().split(';', 1)[0]?.toLowerCase() === 'text/html') === true
  );
}

export function terminateWebsocketClients(clients: Iterable<{ terminate: () => void }>): void {
  for (const client of clients) client.terminate();
}

export function installWebSocketHeartbeat(
  socket: WebSocketHeartbeatTarget,
  intervalMs = WEBSOCKET_HEARTBEAT_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    if (socket.readyState === 1) socket.ping();
  }, intervalMs);
  timer.unref();
  const stop = (): void => {
    clearInterval(timer);
    socket.off('close', stop);
  };
  socket.once('close', stop);
  return stop;
}

function requestHasInitialRoute(request: FastifyRequest, publicOrigin: string): boolean {
  const rawUrl = request.raw.url;
  if (rawUrl === undefined) return false;
  return new URL(rawUrl, publicOrigin).searchParams.has('initialRoute');
}

async function handleClientFrame(session: BrowserSession, frame: ClientFrame): Promise<void> {
  if ('commandId' in frame && session.previousCommandResult(frame.commandId) !== undefined) {
    session.replayCommandResult(frame.commandId);
    return;
  }
  if (!session.shouldAcceptClientSequence(frame.sequence)) return;
  switch (frame.type) {
    case 'ack':
      session.acknowledge(frame.hostSequence);
      return;
    case 'command': {
      try {
        let result: unknown;
        if (isConnectAppHostMessage(frame.message)) {
          session.connectAppHost(frame.message.params.portId);
        } else {
          result = await session.runtime.handleViewMessage(frame.message, session.id);
        }
        const response = session.send({
          type: 'command-result',
          commandId: frame.commandId,
          ok: true,
          ...(result === undefined ? {} : { result }),
        });
        session.rememberCommandResult(frame.commandId, response);
      } catch (error) {
        const response = session.send({
          type: 'command-result',
          commandId: frame.commandId,
          ok: false,
          error: error instanceof Error ? error.message : 'unknown host command failure',
        });
        session.rememberCommandResult(frame.commandId, response);
      }
      return;
    }
    case 'worker-command': {
      let response;
      try {
        await session.runtime.handleWorkerMessage(frame.worker, frame.message);
        response = session.send({
          type: 'command-result',
          commandId: frame.commandId,
          ok: true,
        });
      } catch (error) {
        response = session.send({
          type: 'command-result',
          commandId: frame.commandId,
          ok: false,
          error: error instanceof Error ? error.message : 'official worker request failed',
        });
      }
      session.rememberCommandResult(frame.commandId, response);
      return;
    }
    case 'host-port-message':
      session.deliverAppHostMessage(frame.portId, frame.message);
      return;
    case 'hello':
      return;
  }
}

function isConnectAppHostMessage(message: unknown): message is {
  type: '__browser-bridge-request';
  method: 'connect-app-host';
  params: { portId: string };
} {
  if (message === null || typeof message !== 'object') return false;
  const value = message as Record<string, unknown>;
  if (value.type !== '__browser-bridge-request' || value.method !== 'connect-app-host') {
    return false;
  }
  if (value.params === null || typeof value.params !== 'object') return false;
  const portId = (value.params as Record<string, unknown>).portId;
  return typeof portId === 'string' && /^[0-9a-f-]{36}$/iu.test(portId);
}

function requireIdentity(request: FastifyRequest, config: GatewayConfig): AuthentikIdentity {
  try {
    return readIdentity(request, config);
  } catch (error) {
    const wrapped = new Error(error instanceof Error ? error.message : 'authentication failed');
    Object.assign(wrapped, { statusCode: 401 });
    throw wrapped;
  }
}

function injectBridgeScripts(index: string, bridgePath: string): string {
  const needle = '<script type="module" crossorigin';
  const position = index.indexOf(needle);
  if (position < 0 || index.indexOf(needle, position + needle.length) >= 0) {
    throw new Error('official index entry script marker changed');
  }
  const insertion =
    '<script src="/__codex/bootstrap.js"></script>\n' +
    `    <script type="module" src="${bridgePath}"></script>\n    `;
  return `${index.slice(0, position)}${insertion}${index.slice(position)}`;
}

function escapeScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function rawDataToString(raw: RawData): string {
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  return Buffer.concat(raw).toString('utf8');
}

function browserDownloadDisposition(filename: string): string {
  const fallback = filename.replaceAll(/[^A-Za-z0-9._-]/gu, '_').slice(0, 180) || 'download';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function resolveBrowserFileAsset(requested: string, userRoot: string): string | null {
  try {
    const decoded = decodeURIComponent(requested);
    const candidate = resolve('/', decoded.replace(/^[/\\]+/u, ''));
    const entryStats = lstatSync(candidate);
    if (!entryStats.isFile() || entryStats.isSymbolicLink()) return null;
    const canonicalRoot = realpathSync(userRoot);
    const canonicalPath = realpathSync(candidate);
    const relation = relative(canonicalRoot, canonicalPath);
    if (
      relation === '' ||
      relation === '..' ||
      relation.startsWith(`..${sep}`) ||
      isAbsolute(relation)
    ) {
      return null;
    }
    return canonicalPath;
  } catch {
    return null;
  }
}

function sendOfficialAsset(requested: string, root: string, reply: FastifyReply): FastifyReply {
  const decoded = decodeURIComponent(requested);
  const normalized = normalize(decoded).replace(/^([/\\])+/, '');
  const path = resolve(root, normalized);
  const rootPrefix = `${resolve(root)}${sep}`;
  if (!path.startsWith(rootPrefix) || relative(root, path).startsWith('..')) {
    return reply.code(404).type('text/plain; charset=utf-8').send('not found');
  }
  try {
    if (!statSync(path).isFile()) {
      return reply.code(404).type('text/plain; charset=utf-8').send('not found');
    }
  } catch {
    return reply.code(404).type('text/plain; charset=utf-8').send('not found');
  }
  const input = createReadStream(path);
  const contentType = CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
  return reply
    .header(
      'cache-control',
      /[-.][A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/u.test(path)
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600',
    )
    .type(contentType)
    .send(input);
}

async function storeUpload(
  runtime: UserRuntime,
  uploadId: string,
  requestedFilename: string,
  source: Readable,
  maxBytes: number,
): Promise<void> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(uploadId)) {
    throw new Error('invalid upload identifier');
  }
  const filename = requestedFilename.replaceAll(/[^A-Za-z0-9._-]/gu, '_').slice(0, 180) || 'upload';
  if (filename !== requestedFilename) throw new Error('invalid upload filename');
  const directory = join(runtime.uploadRoot, uploadId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const finalPath = join(directory, filename);
  const temporaryPath = join(directory, `.${filename}.part-${randomUUID()}`);
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) callback(new Error('upload exceeds configured byte limit'));
      else callback(null, chunk);
    },
  });
  try {
    await pipeline(source, limiter, createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }));
    renameSync(temporaryPath, finalPath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}
