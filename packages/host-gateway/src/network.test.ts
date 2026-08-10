import { describe, expect, it, vi } from 'vitest';

import {
  assertAllowedRendererFetchUrl,
  parseRendererFetchRequest,
  RendererFetchProxy,
  resolveRendererFetchUrl,
  shouldUseOfficialElectronNetwork,
  shouldUseRendererEgressProxy,
} from './network.js';

describe('renderer fetch security', () => {
  it('resolves relative official API paths under backend-api', () => {
    expect(resolveRendererFetchUrl('/wham/models', 'https://chatgpt.com/backend-api/').href).toBe(
      'https://chatgpt.com/backend-api/wham/models',
    );
  });

  it.each([
    [
      '/conversations?offset=0&limit=28&order=updated',
      'https://chatgpt.com/backend-api/conversations?offset=0&limit=28&order=updated',
    ],
    ['pins?include_unpinned=false', 'https://chatgpt.com/backend-api/pins?include_unpinned=false'],
    [
      '/models?history_and_training_disabled=false#ignored-by-http',
      'https://chatgpt.com/backend-api/models?history_and_training_disabled=false#ignored-by-http',
    ],
  ])('preserves the query while resolving relative URL %s', (target, expected) => {
    expect(resolveRendererFetchUrl(target, 'https://chatgpt.com/backend-api/').href).toBe(expected);
  });

  it('does not duplicate a non-trailing backend API base path', () => {
    expect(resolveRendererFetchUrl('/projects', 'https://chatgpt.com/backend-api').href).toBe(
      'https://chatgpt.com/backend-api/projects',
    );
  });

  it('leaves absolute official URLs unchanged', () => {
    expect(
      resolveRendererFetchUrl(
        'https://chatgpt.com/backend-api/conversations?limit=1',
        'https://chatgpt.com/backend-api/',
      ).href,
    ).toBe('https://chatgpt.com/backend-api/conversations?limit=1');
  });

  it.each([
    'http://chatgpt.com/backend-api/test',
    'https://chatgpt.com.evil.example/test',
    'https://127.0.0.1/test',
    'https://user:pass@chatgpt.com/test',
  ])('blocks unsafe target %s', (target) => {
    expect(() => assertAllowedRendererFetchUrl(new URL(target))).toThrow();
  });

  it('allows the official OpenAI user-content download domain', () => {
    expect(() =>
      assertAllowedRendererFetchUrl(
        new URL('https://files.oaiusercontent.com/file-abcd?signature=signed'),
      ),
    ).not.toThrow();
  });

  it('removes official control headers and infers wham authentication', () => {
    const request = parseRendererFetchRequest({
      type: 'fetch',
      requestId: 'request-1',
      url: '/wham/models',
      method: 'post',
      headers: {
        'X-OpenAI-Attach-Desktop-Surface': '1',
        'X-Codex-Binary-Response': '1',
      },
      body: '{}',
    });
    expect(request).toMatchObject({
      method: 'POST',
      attachAuth: true,
      attachDesktopSurface: true,
      binaryResponse: true,
      headers: {},
    });
  });
});

describe('renderer fetch proxy', () => {
  it('keeps the fallback narrow while routing every official backend API request through Electron', () => {
    expect(
      shouldUseRendererEgressProxy(
        new URL('https://chatgpt.com/backend-api/gizmos/snorlax/sidebar?limit=10'),
      ),
    ).toBe(true);
    expect(
      shouldUseRendererEgressProxy(new URL('https://chatgpt.com/backend-api/conversation')),
    ).toBe(false);
    expect(
      shouldUseRendererEgressProxy(
        new URL('https://openai.com/backend-api/gizmos/snorlax/sidebar'),
      ),
    ).toBe(false);
    expect(
      shouldUseOfficialElectronNetwork(
        new URL('https://chatgpt.com/backend-api/gizmos/snorlax/sidebar?limit=10'),
      ),
    ).toBe(true);
    expect(
      shouldUseOfficialElectronNetwork(
        new URL('https://chatgpt.com/backend-api/projects/project-id/files'),
      ),
    ).toBe(true);
    expect(
      shouldUseOfficialElectronNetwork(new URL('https://chatgpt.com/backend-api/conversation')),
    ).toBe(true);
    expect(
      shouldUseOfficialElectronNetwork(
        new URL('https://chatgpt.com:8443/backend-api/gizmos/snorlax/sidebar'),
      ),
    ).toBe(false);
    expect(
      shouldUseOfficialElectronNetwork(new URL('https://chatgpt.com/public-api/projects')),
    ).toBe(false);
  });

  it('prefers the pinned official Electron network for backend API requests', async () => {
    const electronFetchImplementation = vi.fn((_url: URL | RequestInfo, init?: RequestInit) => {
      expect(
        (init as (RequestInit & { dispatcher?: unknown }) | undefined)?.dispatcher,
      ).toBeUndefined();
      return Promise.resolve(
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof fetch;
    const proxy = new RendererFetchProxy({
      appVersion: '26.721.31836',
      egressProxyUrl: 'http://127.0.0.1:40000',
      electronFetchImplementation,
      getAuthToken: () => Promise.resolve(null),
    });
    const result = await proxy.perform({
      type: 'fetch',
      requestId: 'request-projects-electron',
      url: 'https://chatgpt.com/backend-api/projects',
      method: 'POST',
      headers: {},
      body: JSON.stringify({ name: 'test' }),
    });
    expect(result).toMatchObject({ responseType: 'success', status: 200 });
    expect(electronFetchImplementation).toHaveBeenCalledTimes(1);
  });

  it('adds a proxy dispatcher only to the official projects request', async () => {
    const fetchImplementation = vi.fn((url: URL | RequestInfo, init?: RequestInit) => {
      void url;
      void init;
      return Promise.resolve(
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    const proxy = new RendererFetchProxy({
      appVersion: '26.721.31836',
      egressProxyUrl: 'http://127.0.0.1:40000',
      fetchImplementation,
      getAuthToken: () => Promise.resolve(null),
    });
    await proxy.perform({
      type: 'fetch',
      requestId: 'request-projects',
      url: 'https://chatgpt.com/backend-api/gizmos/snorlax/sidebar',
      method: 'GET',
      headers: {},
    });
    const projectRequest = fetchImplementation.mock.calls[0]?.[1] as
      (RequestInit & { dispatcher?: unknown }) | undefined;
    expect(projectRequest?.dispatcher).toBeDefined();
    fetchImplementation.mockClear();
    await proxy.perform({
      type: 'fetch',
      requestId: 'request-conversation',
      url: 'https://chatgpt.com/backend-api/conversation',
      method: 'GET',
      headers: {},
    });
    const conversationRequest = fetchImplementation.mock.calls[0]?.[1] as
      (RequestInit & { dispatcher?: unknown }) | undefined;
    expect(conversationRequest?.dispatcher).toBeUndefined();
  });

  it('acknowledges blocked official event ingestion without retrying upstream', async () => {
    const fetchImplementation = vi.fn(() => Promise.reject(new Error('must not fetch')));
    const getAuthToken = vi.fn(() => Promise.resolve('must-not-read'));
    const proxy = new RendererFetchProxy({
      appVersion: '26.721.31836',
      fetchImplementation,
      getAuthToken,
    });
    const result = await proxy.perform({
      type: 'fetch',
      requestId: 'request-telemetry',
      url: 'https://chatgpt.com/ces/v1/rgstr?batch=1',
      method: 'POST',
      headers: {},
      body: '[]',
    });
    expect(result).toEqual({
      type: 'fetch-response',
      responseType: 'success',
      requestId: 'request-telemetry',
      status: 204,
      headers: {},
      bodyJsonString: 'null',
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(getAuthToken).not.toHaveBeenCalled();
  });

  it('attaches an app-server token only to qualified OpenAI requests', async () => {
    const tokenPayload = Buffer.from(
      JSON.stringify({
        'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' },
      }),
    ).toString('base64url');
    const token = `header.${tokenPayload}.signature`;
    const fetchImplementation: typeof fetch = vi.fn(
      (_url: URL | RequestInfo, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        expect(headers.get('authorization')).toBe(`Bearer ${token}`);
        expect(headers.get('chatgpt-account-id')).toBe('account-1');
        expect(headers.get('originator')).toBe('Codex Desktop');
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      },
    );
    const getAuthToken = vi.fn(() => Promise.resolve(token));
    const proxy = new RendererFetchProxy({
      appVersion: '26.721.31836',
      fetchImplementation,
      getAuthToken,
    });
    const result = await proxy.perform({
      type: 'fetch',
      requestId: 'request-1',
      url: '/wham/models',
      method: 'GET',
      headers: {},
    });
    expect(result).toMatchObject({
      responseType: 'success',
      status: 200,
      bodyJsonString: JSON.stringify({ ok: true }),
    });
    expect(getAuthToken).toHaveBeenCalledWith(false);
  });

  it('returns official binary wrapping for non-JSON responses', async () => {
    const proxy = new RendererFetchProxy({
      appVersion: '26.721.31836',
      fetchImplementation: vi.fn(() =>
        Promise.resolve(
          new Response(Uint8Array.from([1, 2, 3]), {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
          }),
        ),
      ),
      getAuthToken: () => Promise.resolve(null),
    });
    const result = await proxy.perform({
      type: 'fetch',
      requestId: 'request-2',
      url: 'https://cdn.openai.com/example.bin',
      method: 'GET',
      headers: {},
    });
    expect(result).toMatchObject({
      responseType: 'success',
      bodyJsonString: JSON.stringify({
        base64: 'AQID',
        contentType: 'application/octet-stream',
      }),
    });
  });

  it('retries once with a refreshed token after an authenticated 401', async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ) as typeof fetch;
    const getAuthToken = vi
      .fn()
      .mockResolvedValueOnce('old-token')
      .mockResolvedValueOnce('new-token');
    const proxy = new RendererFetchProxy({
      appVersion: '26.721.31836',
      fetchImplementation,
      getAuthToken,
    });
    const result = await proxy.perform({
      type: 'fetch',
      requestId: 'request-3',
      url: '/wham/models',
      method: 'GET',
      headers: {},
    });
    expect(result.responseType).toBe('success');
    expect(getAuthToken).toHaveBeenNthCalledWith(1, false);
    expect(getAuthToken).toHaveBeenNthCalledWith(2, true);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it('returns a qualified file download body without buffering it', async () => {
    const fetchImplementation = vi.fn(() =>
      Promise.resolve(
        new Response(Uint8Array.from([4, 5, 6]), {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        }),
      ),
    ) as typeof fetch;
    const proxy = new RendererFetchProxy({
      appVersion: '26.721.31836',
      fetchImplementation,
      getAuthToken: () => Promise.resolve(null),
    });
    const stream = await proxy.getDownloadStream({
      downloadUrl: 'https://files.oaiusercontent.com/file-abcd?signature=signed',
      requestHeaders: { Accept: 'application/octet-stream' },
    });
    await expect(new Response(stream).arrayBuffer()).resolves.toEqual(
      Uint8Array.from([4, 5, 6]).buffer,
    );
    expect(fetchImplementation).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        method: 'GET',
        redirect: 'manual',
      }),
    );
  });

  it('streams official NDJSON events and a completion message', async () => {
    const encoder = new TextEncoder();
    const proxy = new RendererFetchProxy({
      appVersion: '26.721.31836',
      fetchImplementation: vi.fn(() =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(encoder.encode('{"step":1}\n{"step"'));
                controller.enqueue(encoder.encode(':2}\n'));
                controller.close();
              },
            }),
            {
              status: 200,
              headers: { 'x-oai-request-id': 'request-from-server' },
            },
          ),
        ),
      ),
      getAuthToken: () => Promise.resolve(null),
    });
    const messages: unknown[] = [];
    await proxy.performStream(
      {
        type: 'fetch-stream',
        requestId: 'stream-1',
        url: 'https://chatgpt.com/backend-api/files/process_upload_stream',
        method: 'POST',
        headers: {},
        body: '{}',
        format: 'ndjson',
      },
      (message) => messages.push(message),
      new AbortController().signal,
    );
    expect(messages).toEqual([
      {
        type: 'fetch-stream-response',
        requestId: 'stream-1',
        status: 200,
        headers: { 'x-oai-request-id': 'request-from-server' },
      },
      { type: 'fetch-stream-event', requestId: 'stream-1', data: { step: 1 } },
      { type: 'fetch-stream-event', requestId: 'stream-1', data: { step: 2 } },
      { type: 'fetch-stream-complete', requestId: 'stream-1' },
    ]);
  });

  it('parses SSE JSON events and drops heartbeat frames', async () => {
    const encoder = new TextEncoder();
    const proxy = new RendererFetchProxy({
      appVersion: '26.721.31836',
      fetchImplementation: vi.fn(() =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    'event: heartbeat\ndata: {"ignored":true}\n\n' +
                      'event: message\ndata: {"text":"hello"}\r\n\r\n',
                  ),
                );
                controller.close();
              },
            }),
            { status: 200 },
          ),
        ),
      ),
      getAuthToken: () => Promise.resolve(null),
    });
    const messages: unknown[] = [];
    await proxy.performStream(
      {
        type: 'fetch-stream',
        requestId: 'stream-2',
        url: 'https://chatgpt.com/backend-api/conversation',
        method: 'POST',
        headers: {},
      },
      (message) => messages.push(message),
      new AbortController().signal,
    );
    expect(messages).toContainEqual({
      type: 'fetch-stream-event',
      requestId: 'stream-2',
      event: 'message',
      data: { text: 'hello' },
    });
    expect(messages).not.toContainEqual(
      expect.objectContaining({ type: 'fetch-stream-event', event: 'heartbeat' }),
    );
  });

  it('attaches and advances a valid official integrity state', async () => {
    const current = 'ois1.first.second.third';
    const next = 'ois1.next.second.third';
    const storeIntegrityState = vi.fn(() => Promise.resolve(true));
    const proxy = new RendererFetchProxy({
      appVersion: '26.721.31836',
      fetchImplementation: vi.fn((_url: URL | RequestInfo, init?: RequestInit) => {
        expect(new Headers(init?.headers).get('x-oai-is')).toBe(current);
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'x-oai-is-update': next,
            },
          }),
        );
      }),
      getAuthToken: () => Promise.resolve(null),
      getIntegrityState: () => current,
      storeIntegrityState,
    });
    await proxy.perform({
      type: 'fetch',
      requestId: 'request-integrity',
      url: 'https://chatgpt.com/backend-api/conversation',
      method: 'POST',
      headers: { 'X-OpenAI-Attach-Integrity-State': '1' },
      body: '{}',
    });
    expect(storeIntegrityState).toHaveBeenCalledWith(current, next);
  });
});
