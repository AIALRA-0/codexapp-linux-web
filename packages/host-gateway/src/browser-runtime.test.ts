import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { OfficialBrowserRuntime } from './browser-runtime.js';

const temporaryRoots: string[] = [];
const runtimes: OfficialBrowserRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe('OfficialBrowserRuntime', () => {
  it('registers the official renderer generation and publishes a new-tab snapshot', async () => {
    const { messages, runtime } = await createRuntime();
    expect(runtime.registerRendererSession('surface-1', 'renderer-1')).toBe(true);
    await expect(
      runtime.registerWebviewHost('surface-1', {
        browserTabId: 'tab-1',
        conversationId: 'thread-1',
        hostGeneration: 1,
        pagePersistence: {
          browserStorageId: 'browser:storage-1',
          restore: 'none',
        },
        rendererInstanceId: 'renderer-1',
      }),
    ).resolves.toBe(true);
    expect(messages.at(-1)).toMatchObject({
      type: 'browser-sidebar-state',
      browserTabId: 'tab-1',
      conversationId: 'thread-1',
      snapshot: {
        tabType: 'new-tab-page',
        title: 'New tab',
        url: '',
      },
    });
    expect(runtime.searchTabs('thread-1', '')).toEqual({ candidates: [] });
  });

  it('rejects stale hosts and required restores without matching durable ownership', async () => {
    const { runtime } = await createRuntime();
    runtime.registerRendererSession('surface-1', 'renderer-1');
    await expect(runtime.registerWebviewHost('surface-1', registration(3, 'none'))).resolves.toBe(
      true,
    );
    await expect(runtime.registerWebviewHost('surface-1', registration(2, 'none'))).resolves.toBe(
      false,
    );
    await expect(
      runtime.registerWebviewHost('surface-1', {
        ...registration(4, 'required'),
        pagePersistence: {
          browserStorageId: 'browser:does-not-exist',
          restore: 'required',
        },
      }),
    ).resolves.toBe(false);
  });

  it('persists official snapshot records and restores them in a new runtime', async () => {
    const first = await createRuntime();
    first.runtime.registerRendererSession('surface-1', 'renderer-1');
    await first.runtime.registerWebviewHost('surface-1', registration(1, 'none'));
    await first.runtime.handleRendererMessage('surface-1', {
      type: 'browser-sidebar-command',
      browserTabId: 'tab-1',
      conversationId: 'thread-1',
      command: { type: 'set-interaction-mode', interactionMode: 'comment' },
    });
    await first.runtime.stop();

    const raw = JSON.parse(await readFile(join(first.root, 'browser-state.json'), 'utf8')) as {
      pages: Array<{ snapshot: { interactionMode: string } }>;
    };
    expect(raw.pages[0]?.snapshot.interactionMode).toBe('comment');

    const messages: unknown[] = [];
    const second = runtimeAt(first.root, messages);
    await second.start();
    expect(second.registerRendererSession('surface-2', 'renderer-2')).toBe(true);
    const results = await second.getPageRestoreResults({
      pages: [
        {
          browserStorageId: 'browser:storage-1',
          browserTabId: 'tab-1',
          conversationId: 'thread-1',
        },
      ],
    });
    expect(results[0]).toMatchObject({
      status: 'snapshot-ready',
      snapshot: {
        interactionMode: 'comment',
        isSuspended: true,
      },
    });
    await second.stop();
  });

  it('applies the official annotation commands to durable browser state', async () => {
    const { messages, runtime } = await createRuntime();
    runtime.registerRendererSession('surface-1', 'renderer-1');
    await runtime.registerWebviewHost('surface-1', registration(1, 'none'));
    await runtime.handleRendererMessage('surface-1', {
      type: 'browser-sidebar-command',
      browserTabId: 'tab-1',
      conversationId: 'thread-1',
      command: { type: 'set-interaction-mode', interactionMode: 'comment' },
    });
    await runtime.handleRendererMessage('surface-1', {
      type: 'browser-sidebar-command',
      browserTabId: 'tab-1',
      conversationId: 'thread-1',
      command: { type: 'set-design-modifier-pressed', pressed: true },
    });
    expect(messages.at(-1)).toMatchObject({
      type: 'browser-sidebar-state',
      snapshot: {
        interactionMode: 'comment',
        isDesignModifierPressed: true,
      },
    });
    await runtime.handleRendererMessage('surface-1', {
      type: 'browser-sidebar-command',
      browserTabId: 'tab-1',
      conversationId: 'thread-1',
      command: { type: 'clear-comments' },
    });
    expect(messages.at(-1)).toMatchObject({
      type: 'browser-sidebar-state',
      snapshot: {
        interactionMode: 'browse',
        annotationEditorMode: 'comment',
        comments: [],
        isDesignModifierPressed: false,
        isOriginalViewEnabled: false,
        isTweaksEditorOpen: false,
      },
    });
  });

  it('searches only live tabs in the requested conversation using official mention fields', async () => {
    const { root, runtime } = await createRuntime();
    await runtime.stop();
    await writeFile(
      join(root, 'browser-state.json'),
      `${JSON.stringify({
        version: 1,
        pages: [
          {
            browserStorageId: 'browser:storage-1',
            browserTabId: 'tab-1',
            conversationId: 'thread-1',
            lastTabActivityTime: 42,
            snapshot: snapshot('OpenAI Docs', 'https://platform.openai.com/docs'),
          },
        ],
      })}\n`,
    );
    const restored = runtimeAt(root, []);
    await restored.start();
    restored.registerRendererSession('surface-1', 'renderer-1');
    await expect(
      restored.registerWebviewHost('surface-1', registration(1, 'required')),
    ).resolves.toBe(true);
    expect(restored.searchTabs('thread-1', 'openai docs')).toEqual({
      candidates: [
        expect.objectContaining({
          browserId: 'thread-1',
          pluginId: 'browser@openai-bundled',
          source: 'iab',
          tabId: 'tab-1',
          snapshot: {
            title: 'OpenAI Docs',
            url: 'https://platform.openai.com/docs',
          },
        }),
      ],
    });
    expect(restored.searchTabs('thread-2', '')).toEqual({ candidates: [] });
    await restored.stop();
  });

  it('removes durable browser state when the official conversation is deleted', async () => {
    const { root, runtime } = await createRuntime();
    runtime.registerRendererSession('surface-1', 'renderer-1');
    await runtime.registerWebviewHost('surface-1', registration(1, 'none'));
    await runtime.deleteConversation({
      browserConversationId: 'thread-1',
      conversationId: 'thread-1',
    });
    await runtime.stop();
    const raw = JSON.parse(await readFile(join(root, 'browser-state.json'), 'utf8')) as {
      pages: unknown[];
    };
    expect(raw.pages).toEqual([]);
  });
});

async function createRuntime(): Promise<{
  root: string;
  runtime: OfficialBrowserRuntime;
  messages: unknown[];
}> {
  const root = await mkdtemp(join(tmpdir(), 'codex-browser-runtime-'));
  temporaryRoots.push(root);
  const messages: unknown[] = [];
  const runtime = runtimeAt(root, messages);
  await runtime.start();
  return { root, runtime, messages };
}

function runtimeAt(root: string, messages: unknown[]): OfficialBrowserRuntime {
  const runtime = new OfficialBrowserRuntime({
    root,
    emitViewMessage: (message) => messages.push(message),
    registerDownload: () => 'download-token',
  });
  runtimes.push(runtime);
  return runtime;
}

function registration(
  hostGeneration: number,
  restore: 'none' | 'required',
): Record<string, unknown> {
  return {
    browserTabId: 'tab-1',
    conversationId: 'thread-1',
    hostGeneration,
    pagePersistence: {
      browserStorageId: 'browser:storage-1',
      restore,
    },
    rendererInstanceId: 'renderer-1',
  };
}

function snapshot(title: string, url: string): Record<string, unknown> {
  return {
    annotationFlow: 'batch',
    annotationModeEntrySource: null,
    tabType: 'web',
    isSuspended: true,
    title,
    url,
    faviconUrl: null,
    securityState: null,
    isAudible: false,
    isCapturingUserMedia: false,
    isLoading: false,
    isWaitingForResponse: false,
    isAtDocumentBottom: false,
    canGoBack: false,
    canGoForward: false,
    zoomPercent: 100,
    commentModeDisabledReason: null,
    interactionMode: 'browse',
    comments: [],
  };
}
