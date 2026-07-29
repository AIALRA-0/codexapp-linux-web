import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  countIdentitySessions,
  countReconnectableIdentitySessions,
  findMissingBrowserBridgeImports,
  isConcurrentBridgeInvocation,
  missingBridgeSessionRequiresReload,
  officialInitialRouteLocation,
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
