import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BROWSER_BRIDGE_MODULES,
  countIdentitySessions,
  countReconnectableIdentitySessions,
  findMissingBrowserBridgeImports,
  injectBridgeScripts,
  injectInitialRouteMeta,
  installWebSocketHeartbeat,
  isConcurrentBridgeInvocation,
  missingBridgeSessionRequiresReload,
  officialInitialRouteLocation,
  reconnectableIdentityEntries,
  rendererInitialRouteForRequest,
  resolveBrowserFileAsset,
  shouldServeRendererIndex,
  terminateWebsocketClients,
} from './server.js';

describe('browser bridge module boundary', () => {
  it('fails closed when a local module import is not served', () => {
    expect(
      findMissingBrowserBridgeImports(
        new Map([
          ['index.js', "import { pick } from './browser-file-picker.js';"],
          ['reconnect.js', 'export const reconnect = true;'],
        ]),
      ),
    ).toEqual(['browser-file-picker.js']);
    expect(
      findMissingBrowserBridgeImports(
        new Map([
          ['index.js', "import { pick } from './browser-file-picker.js';"],
          ['browser-file-picker.js', 'export const pick = true;'],
        ]),
      ),
    ).toEqual([]);
  });

  it('serves every local module imported by the production browser bridge', () => {
    expect(BROWSER_BRIDGE_MODULES).toContain('official-feature-gates.js');
    expect(
      findMissingBrowserBridgeImports(
        new Map([
          ['index.js', "import './browser-file-picker.js'; import './official-feature-gates.js';"],
          ['browser-file-picker.js', 'export const picker = true;'],
          ['official-feature-gates.js', 'export const historySnapshots = true;'],
        ]),
      ),
    ).toEqual([]);
  });
});

describe('official renderer HTML adapter', () => {
  it('anchors every relative official asset to the site root before the first asset is parsed', () => {
    const rendered = injectBridgeScripts(
      '<html><head><link rel="stylesheet" href="./assets/app.css"></head><body><script type="module" crossorigin src="./assets/app.js"></script></body></html>',
      '/__codex/bridge-test/index.js',
    );

    expect(rendered).toContain('<head>\n    <base href="/">');
    expect(rendered.indexOf('<base href="/">')).toBeLessThan(rendered.indexOf('./assets/app.css'));
    expect(rendered).toContain('<script src="/__codex/bootstrap.js"></script>');
    expect(rendered).toContain(
      '<script type="module" src="/__codex/bridge-test/index.js"></script>',
    );
  });

  it('fails closed if the official package introduces its own base URL', () => {
    expect(() =>
      injectBridgeScripts(
        '<html><head><base href="./"><script type="module" crossorigin src="./assets/app.js"></script></head></html>',
        '/__codex/bridge-test/index.js',
      ),
    ).toThrow('official index head marker changed');
  });
});

describe('authenticated session capacity accounting', () => {
  it('counts immutable subjects instead of mutable or colliding display usernames', () => {
    const entries = [
      { identity: { subject: 'subject-a', username: 'shared', groups: [] } },
      { identity: { subject: 'subject-a', username: 'renamed', groups: [] } },
      { identity: { subject: 'subject-b', username: 'shared', groups: [] } },
    ];
    expect(
      countIdentitySessions(entries, {
        subject: 'subject-a',
        username: 'another-name',
        groups: [],
      }),
    ).toBe(2);
  });

  it('counts only disconnected sessions that are still inside the reconnect window', () => {
    const reconnectTimer = setTimeout(() => undefined, 60_000);
    try {
      const entries = [
        {
          identity: { subject: 'subject-a', username: 'shared', groups: [] },
          cleanupTimer: reconnectTimer,
        },
        {
          identity: { subject: 'subject-a', username: 'shared', groups: [] },
        },
        {
          identity: { subject: 'subject-b', username: 'shared', groups: [] },
          cleanupTimer: reconnectTimer,
        },
      ];
      expect(
        countReconnectableIdentitySessions(entries, {
          subject: 'subject-a',
          username: 'renamed',
          groups: [],
        }),
      ).toBe(1);
    } finally {
      clearTimeout(reconnectTimer);
    }
  });

  it('selects only stale disconnected sessions for same-identity supersession', () => {
    const reconnectTimer = setTimeout(() => undefined, 60_000);
    try {
      const entries = new Map([
        [
          'stale-same-user',
          {
            identity: { subject: 'subject-a', username: 'old-name', groups: [] },
            cleanupTimer: reconnectTimer,
          },
        ],
        [
          'active-same-user',
          {
            identity: { subject: 'subject-a', username: 'old-name', groups: [] },
          },
        ],
        [
          'stale-other-user',
          {
            identity: { subject: 'subject-b', username: 'old-name', groups: [] },
            cleanupTimer: reconnectTimer,
          },
        ],
      ]);
      expect(
        reconnectableIdentityEntries(entries, {
          subject: 'subject-a',
          username: 'new-name',
          groups: [],
        }).map(([sessionId]) => sessionId),
      ).toEqual(['stale-same-user']);
    } finally {
      clearTimeout(reconnectTimer);
    }
  });
});

describe('official renderer navigation fallback', () => {
  it('uses the exact initialRoute query parameter understood by the official renderer', () => {
    expect(officialInitialRouteLocation('/login')).toBe('/?initialRoute=%2Flogin');
    expect(officialInitialRouteLocation('/')).toBe('/');
  });

  it('serves the renderer entry for root, explicit index, and browser route navigations', () => {
    expect(shouldServeRendererIndex('', undefined)).toBe(true);
    expect(shouldServeRendererIndex('index.html', undefined)).toBe(true);
    expect(shouldServeRendererIndex('login', 'text/html,application/xhtml+xml')).toBe(true);
    expect(shouldServeRendererIndex('local/thread-1', 'text/html')).toBe(true);
  });

  it('passes a refreshed browser route through the official initial-route contract', () => {
    expect(
      rendererInitialRouteForRequest(
        'local/thread-1',
        '/local/thread-1?hostId=local',
        'https://codex.example.test',
      ),
    ).toBe('/local/thread-1?hostId=local');
    expect(rendererInitialRouteForRequest('', '/', 'https://codex.example.test')).toBeNull();
    expect(
      rendererInitialRouteForRequest(
        'local/thread-1',
        '/local/thread-1?initialRoute=%2Flogin',
        'https://codex.example.test',
      ),
    ).toBeNull();

    const rendered = injectInitialRouteMeta(
      '<html><head><base href="/"></head><body></body></html>',
      '/local/thread-1?label=a&view="full"',
    );
    expect(rendered).toContain(
      '<meta name="initial-route" content="/local/thread-1?label=a&amp;view=&quot;full&quot;">',
    );
  });

  it('does not turn missing static module requests into HTML', () => {
    expect(shouldServeRendererIndex('assets/missing.js', '*/*')).toBe(false);
    expect(shouldServeRendererIndex('assets/missing.css', 'text/css,*/*;q=0.1')).toBe(false);
  });

  it('terminates every live websocket during shutdown instead of waiting for close handshakes', () => {
    const terminations: string[] = [];
    terminateWebsocketClients([
      { terminate: () => terminations.push('first') },
      { terminate: () => terminations.push('second') },
    ]);
    expect(terminations).toEqual(['first', 'second']);
  });

  it('keeps idle proxy connections alive with protocol pings and stops after close', () => {
    vi.useFakeTimers();
    try {
      const events = new EventEmitter();
      let pings = 0;
      const socket = {
        readyState: 1,
        ping: () => {
          pings += 1;
        },
        once: events.once.bind(events),
        off: events.off.bind(events),
      };
      installWebSocketHeartbeat(socket, 25_000);
      vi.advanceTimersByTime(75_000);
      expect(pings).toBe(3);
      events.emit('close');
      vi.advanceTimersByTime(75_000);
      expect(pings).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('requests a renderer reload only when reconnecting session state was lost', () => {
    expect(missingBridgeSessionRequiresReload(0)).toBe(false);
    expect(missingBridgeSessionRequiresReload(1)).toBe(true);
    expect(missingBridgeSessionRequiresReload(50_000)).toBe(true);
  });
});

describe('authenticated official file protocol route', () => {
  it('serves only regular files canonically contained by the current user root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'codex-browser-file-route-'));
    try {
      const root = join(parent, 'user');
      const inside = join(root, 'generated_images', 'thread-1', 'image.png');
      const outside = join(parent, 'outside.txt');
      const linked = join(root, 'generated_images', 'linked.png');
      await mkdir(join(root, 'generated_images', 'thread-1'), { recursive: true });
      await Promise.all([writeFile(inside, 'image'), writeFile(outside, 'outside')]);
      await symlink(outside, linked);

      expect(resolveBrowserFileAsset(inside.replace(/^[/\\]+/u, ''), root)).not.toBeNull();
      expect(resolveBrowserFileAsset(outside.replace(/^[/\\]+/u, ''), root)).toBeNull();
      expect(resolveBrowserFileAsset(linked.replace(/^[/\\]+/u, ''), root)).toBeNull();
      expect(resolveBrowserFileAsset('../outside.txt', root)).toBeNull();
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });
});

describe('official Electron invocation concurrency', () => {
  it('does not serialize independent invoke handlers behind a slow command', () => {
    expect(
      isConcurrentBridgeInvocation({
        contractVersion: 1,
        type: 'command',
        sequence: 1,
        commandId: 'command-1',
        message: { type: 'fetch' },
      }),
    ).toBe(true);
    expect(
      isConcurrentBridgeInvocation({
        contractVersion: 1,
        type: 'worker-command',
        sequence: 2,
        commandId: 'command-2',
        worker: 'official-worker',
        message: {},
      }),
    ).toBe(true);
    expect(
      isConcurrentBridgeInvocation({
        contractVersion: 1,
        type: 'ack',
        sequence: 3,
        hostSequence: 1,
      }),
    ).toBe(false);
    expect(
      isConcurrentBridgeInvocation({
        contractVersion: 1,
        type: 'host-port-message',
        sequence: 4,
        portId: 'port-1',
        message: 'frame',
      }),
    ).toBe(false);
  });
});
