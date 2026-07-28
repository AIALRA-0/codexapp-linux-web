import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import type { FastifyRequest } from 'fastify';

import { authentikIdentitySchema, type AuthentikIdentity } from '@codexapp/contracts';

import type { GatewayConfig } from './config.js';

interface TicketPayload {
  version: 1;
  sessionId: string;
  userKey: string;
  expiresAt: number;
}

export interface VerifiedTicket extends TicketPayload {
  username: string;
}

export function userKeyFor(username: string): string {
  return createHash('sha256').update(username.normalize('NFKC').toLowerCase()).digest('hex');
}

export function identityPrincipal(identity: AuthentikIdentity): string {
  return identity.subject ?? identity.username;
}

export function userKeyForIdentity(identity: AuthentikIdentity): string {
  return userKeyFor(identityPrincipal(identity));
}

export function identitiesMatch(left: AuthentikIdentity, right: AuthentikIdentity): boolean {
  return userKeyForIdentity(left) === userKeyForIdentity(right);
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export function readIdentity(request: FastifyRequest, config: GatewayConfig): AuthentikIdentity {
  const remoteAddress = request.socket.remoteAddress;
  const proxyIsTrusted =
    remoteAddress === config.trustedProxy ||
    (config.trustedProxy === '127.0.0.1' && remoteAddress === '::ffff:127.0.0.1');
  if (!proxyIsTrusted) {
    throw new Error('request did not arrive from the trusted authentication proxy');
  }
  if (
    config.authVerifiedHeader !== undefined &&
    headerValue(request, config.authVerifiedHeader) !== config.authVerifiedValue
  ) {
    throw new Error('request was not verified by the authentication proxy');
  }
  if (config.authProxySecret !== undefined) {
    const supplied = Buffer.from(headerValue(request, config.authProxySecretHeader) ?? '');
    if (
      supplied.length !== config.authProxySecret.length ||
      !timingSafeEqual(supplied, config.authProxySecret)
    ) {
      throw new Error('authentication proxy proof is invalid');
    }
  }
  const username = headerValue(request, config.authUsernameHeader);
  if (username === undefined || username.trim() === '') {
    if (
      config.devIdentity !== undefined &&
      (remoteAddress === '127.0.0.1' || remoteAddress === '::ffff:127.0.0.1')
    ) {
      return authentikIdentitySchema.parse({ username: config.devIdentity, groups: [] });
    }
    throw new Error('missing verified Authentik identity');
  }
  const groups = (headerValue(request, config.authGroupsHeader) ?? '')
    .split(/[|,]/u)
    .map((group) => group.trim())
    .filter(Boolean);
  return authentikIdentitySchema.parse({
    subject: headerValue(request, config.authSubjectHeader),
    username,
    email: headerValue(request, config.authEmailHeader),
    name: headerValue(request, config.authNameHeader),
    groups,
  });
}

export function issueTicket(
  identity: AuthentikIdentity,
  sessionId: string,
  config: GatewayConfig,
): string {
  const payload: TicketPayload & { username: string } = {
    version: 1,
    sessionId,
    userKey: userKeyForIdentity(identity),
    username: identity.username,
    expiresAt: Math.floor(Date.now() / 1000) + config.sessionTtlSeconds,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', config.sessionSigningKey)
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${signature}`;
}

export function verifyTicket(
  token: string,
  identity: AuthentikIdentity,
  config: GatewayConfig,
): VerifiedTicket {
  const [encoded, suppliedSignature, extra] = token.split('.');
  if (encoded === undefined || suppliedSignature === undefined || extra !== undefined) {
    throw new Error('invalid session ticket shape');
  }
  const expectedSignature = createHmac('sha256', config.sessionSigningKey).update(encoded).digest();
  let observedSignature: Buffer;
  try {
    observedSignature = Buffer.from(suppliedSignature, 'base64url');
  } catch {
    throw new Error('invalid session ticket signature');
  }
  if (
    observedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(observedSignature, expectedSignature)
  ) {
    throw new Error('invalid session ticket signature');
  }
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as VerifiedTicket;
  if (
    payload.version !== 1 ||
    payload.expiresAt < Math.floor(Date.now() / 1000) ||
    payload.userKey !== userKeyForIdentity(identity) ||
    (identity.subject === undefined && payload.username !== identity.username)
  ) {
    throw new Error('expired or mismatched session ticket');
  }
  return payload;
}
