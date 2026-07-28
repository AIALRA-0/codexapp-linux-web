import { randomBytes, randomUUID } from 'node:crypto';

import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';

import type { AuthentikIdentity } from '@codexapp/contracts';

import type { GatewayConfig } from './config.js';
import {
  identitiesMatch,
  issueTicket,
  readIdentity,
  userKeyForIdentity,
  verifyTicket,
} from './identity.js';

function config(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    trustedProxy: '127.0.0.1',
    authSubjectHeader: 'X-Aialra-Sub',
    authUsernameHeader: 'X-Aialra-User',
    authEmailHeader: 'X-Aialra-Email',
    authNameHeader: 'X-Aialra-User',
    authGroupsHeader: 'X-Aialra-Groups',
    authVerifiedHeader: 'X-Aialra-Authenticated',
    authVerifiedValue: '1',
    authProxySecretHeader: 'X-Aialra-Proxy-Secret',
    sessionSigningKey: randomBytes(32),
    sessionTtlSeconds: 43_200,
    ...overrides,
  } as GatewayConfig;
}

function request(headers: Record<string, string>, remoteAddress = '127.0.0.1'): FastifyRequest {
  return {
    headers: Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
    ),
    socket: { remoteAddress },
  } as unknown as FastifyRequest;
}

const verifiedHeaders = {
  'X-Aialra-Authenticated': '1',
  'X-Aialra-Sub': 'authentik-subject-1',
  'X-Aialra-User': 'alice',
  'X-Aialra-Email': 'alice@example.com',
  'X-Aialra-Groups': 'aialra:access:codex,aialra:role:developer|extra',
};

describe('verified AIALRA identity', () => {
  it('accepts only the trusted loopback proxy and its explicit verified marker', () => {
    expect(() => readIdentity(request(verifiedHeaders, '203.0.113.10'), config())).toThrow(
      'trusted authentication proxy',
    );
    expect(() =>
      readIdentity(request({ ...verifiedHeaders, 'X-Aialra-Authenticated': '0' }), config()),
    ).toThrow('not verified');
    expect(() => readIdentity(request({ 'X-Aialra-Authenticated': '1' }), config())).toThrow(
      'missing verified',
    );
  });

  it('requires the private Nginx-to-gateway proof when production config enables it', () => {
    const secret = Buffer.from('0123456789abcdef0123456789abcdef');
    const settings = config({ authProxySecret: secret });
    expect(() => readIdentity(request(verifiedHeaders), settings)).toThrow('proxy proof');
    expect(() =>
      readIdentity(request({ ...verifiedHeaders, 'X-Aialra-Proxy-Secret': 'incorrect' }), settings),
    ).toThrow('proxy proof');
    expect(
      readIdentity(
        request({
          ...verifiedHeaders,
          'X-Aialra-Proxy-Secret': secret.toString(),
        }),
        settings,
      ),
    ).toMatchObject({ subject: 'authentik-subject-1', username: 'alice' });
  });

  it('reads immutable subject identity and both gateway and Authentik group delimiters', () => {
    expect(readIdentity(request(verifiedHeaders), config())).toEqual({
      subject: 'authentik-subject-1',
      username: 'alice',
      email: 'alice@example.com',
      name: 'alice',
      groups: ['aialra:access:codex', 'aialra:role:developer', 'extra'],
    });
  });

  it('allows a renamed username to retain the same runtime and signed session', () => {
    const before: AuthentikIdentity = {
      subject: 'authentik-subject-1',
      username: 'alice',
      groups: [],
    };
    const after: AuthentikIdentity = {
      subject: 'authentik-subject-1',
      username: 'alice-renamed',
      groups: [],
    };
    const settings = config();
    const ticket = issueTicket(before, randomUUID(), settings);

    expect(userKeyForIdentity(after)).toBe(userKeyForIdentity(before));
    expect(identitiesMatch(before, after)).toBe(true);
    expect(verifyTicket(ticket, after, settings).userKey).toBe(userKeyForIdentity(before));
  });

  it('rejects a different immutable subject even when the display username is identical', () => {
    const alice: AuthentikIdentity = {
      subject: 'authentik-subject-1',
      username: 'shared-name',
      groups: [],
    };
    const mallory: AuthentikIdentity = {
      subject: 'authentik-subject-2',
      username: 'shared-name',
      groups: [],
    };
    const settings = config();
    const ticket = issueTicket(alice, randomUUID(), settings);

    expect(identitiesMatch(alice, mallory)).toBe(false);
    expect(() => verifyTicket(ticket, mallory, settings)).toThrow('mismatched');
  });

  it('keeps the username fallback for direct Authentik and development configurations', () => {
    const direct = config({
      authSubjectHeader: 'X-authentik-uid',
      authUsernameHeader: 'X-authentik-username',
      authGroupsHeader: 'X-authentik-groups',
      authVerifiedHeader: undefined,
    });
    expect(
      readIdentity(
        request({
          'X-authentik-username': 'direct-user',
          'X-authentik-groups': 'one|two',
        }),
        direct,
      ),
    ).toMatchObject({ username: 'direct-user', groups: ['one', 'two'] });
  });
});
