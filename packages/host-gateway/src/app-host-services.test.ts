import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BrowserUsePermissionsService,
  CodexMicroService,
  ComputerUseSettingsService,
  ConversationalOnboardingService,
  CustomAvatarsService,
  DynamicToolCallsService,
  FileAttachmentsService,
  FileDragsService,
  OpenInService,
  PullRequestMessageGenerationOperation,
  PluginScheduledTasksService,
  RemoteControlEnvironmentsService,
  ThreadArchiveService,
  ThreadProjectAssignmentsService,
  VisualizationsService,
  WorkspaceFilesService,
} from './app-host.js';
import type { UserRuntime } from './runtime.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (path) => rm(path, { force: true, recursive: true })),
  );
});

interface RuntimeHarness {
  runtime: UserRuntime;
  messages: unknown[];
  archivedNotifications: unknown[];
  appServerRequests: unknown[];
  desktopStateRequests: unknown[];
  globalState: Record<string, unknown>;
}

async function createRuntimeHarness(): Promise<RuntimeHarness> {
  const root = await mkdtemp(join(tmpdir(), 'codex-app-host-services-'));
  temporaryRoots.push(root);
  const codexHome = join(root, 'codex-home');
  const workspaceRoot = join(root, 'workspace');
  const uploadRoot = join(root, 'uploads');
  await Promise.all([
    mkdir(codexHome, { recursive: true }),
    mkdir(workspaceRoot, { recursive: true }),
    mkdir(uploadRoot, { recursive: true }),
  ]);
  const messages: unknown[] = [];
  const archivedNotifications: unknown[] = [];
  const appServerRequests: unknown[] = [];
  const desktopStateRequests: unknown[] = [];
  const globalState: Record<string, unknown> = {};
  const runtime = {
    root,
    codexHome,
    workspaceRoot,
    uploadRoot,
    officialDesktopState: {
      request: (operation: string, params: Record<string, unknown>) => {
        desktopStateRequests.push({ operation, params });
        if (operation === 'file.detect-kind') {
          const bytes = params.bytes as Uint8Array;
          return Promise.resolve(bytes.includes(0) ? 'binary' : 'text');
        }
        if (operation === 'thread.archive-inactive') return Promise.resolve({ archived: true });
        if (operation === 'custom-avatars.load') {
          return Promise.resolve({
            avatarDirectory: join(codexHome, 'pets'),
            avatars: [{ id: 'custom:owl' }],
          });
        }
        if (operation === 'custom-avatars.load-avatar') {
          return Promise.resolve({ id: params.avatarId });
        }
        if (operation === 'plugin-scheduled-tasks.list') {
          return Promise.resolve({
            groups: [{ plugin: { id: 'plugin-1' }, templates: [{ name: 'Daily' }] }],
          });
        }
        return Promise.reject(
          new Error(`Unexpected official desktop state operation: ${operation}`),
        );
      },
    },
    threadCatalog: {
      handleNotification: (notification: unknown) => archivedNotifications.push(notification),
    },
    getGlobalState: (key: string) => globalState[key],
    setGlobalState: (key: string, value: unknown) => {
      globalState[key] = value;
      return Promise.resolve();
    },
    sendViewMessage: (message: unknown) => messages.push(message),
    registerBrowserDownload: () => '00000000-0000-4000-8000-000000000001',
    requestAppServer: (method: string, params: unknown) => {
      appServerRequests.push({ method, params });
      if (method === 'plugin/list') {
        return Promise.resolve({
          marketplaces: [{ name: 'public', plugins: [] }],
        });
      }
      return Promise.reject(new Error(`Unexpected app-server method: ${method}`));
    },
  } as unknown as UserRuntime;
  return {
    runtime,
    messages,
    archivedNotifications,
    appServerRequests,
    desktopStateRequests,
    globalState,
  };
}

describe('official AppHost browser services', () => {
  it('reports exact unsupported Linux Computer Use settings state', () => {
    const service = new ComputerUseSettingsService();
    expect(service.getAppApprovals()).toBeNull();
    expect(service.removeAppApproval('com.example.App')).toBeNull();
    expect(service.getSoundMode()).toBeNull();
    expect(service.setSoundMode('off')).toBe('off');
    expect(service.getLockedUseState()).toEqual({
      enabled: null,
      computerIconDataURL: null,
      lockIconDataURL: null,
    });
    expect(service.setLockedUseEnabled(true)).toBeNull();
  });

  it('reports physical Codex Micro and native file drags as unavailable', () => {
    const micro = new CodexMicroService();
    expect(micro.getState()).toEqual({
      status: 'not-detected',
      transport: null,
      model: null,
      error: null,
      battery: null,
    });
    expect(micro.getInputMonitoringPermissionStatus()).toBe('unavailable');
    expect(micro.ownsPrimaryWindow()).toBe(true);
    expect(micro.updateAgentThreadKeys([], [])).toBe(true);
    expect(micro.updateLighting({})).toBe(false);

    const fileDrags = new FileDragsService();
    expect(fileDrags.prepareDrag({ hostId: 'local', path: '/tmp/file' })).toBeUndefined();
    expect(fileDrags.startDrag({ hostId: 'local', path: '/tmp/file' })).toBe(false);
  });

  it('matches the official no-op result for an unenrolled remote control environment', () => {
    const service = new RemoteControlEnvironmentsService();
    expect(
      service.renameIfDefault({
        envId: 'server-local-environment',
        name: 'Codex server',
      }),
    ).toBeUndefined();
    expect(() => service.renameIfDefault({ envId: '', name: 'Codex server' })).toThrow(
      'remote control environment id is invalid',
    );
  });

  it('reports exact empty OpenIn capability without exposing server-native applications', () => {
    const service = new OpenInService();
    expect(service.detectTarget({ target: 'vscode' })).toEqual({ available: false });
    expect(service.getTargets({ hostId: 'local', path: '/tmp/file' })).toEqual({
      preferredTarget: null,
      availableTargets: [],
      mode: 'editor',
      targets: [],
    });
    expect(service.loadTargetIcon({ target: 'vscode' })).toEqual({ icon: null });
    expect(service.open({ path: '/tmp/file', target: 'vscode' })).toEqual({ success: false });
    expect(service.setGlobalPreferredTarget({ target: 'vscode' })).toEqual({ success: true });
  });

  it('cancels an in-flight pull request generation when its RPC handle is disposed', async () => {
    const operation = new PullRequestMessageGenerationOperation(
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('The operation was aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    operation[Symbol.dispose]();
    await expect(operation.wait()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('uses the official dynamic tool execution claim key and eviction behavior', () => {
    const service = new DynamicToolCallsService();
    const request = { callId: 'call', hostId: 'local', threadId: 'thread', turnId: 'turn' };
    expect(service.tryClaimExecution(request)).toBe(true);
    expect(service.tryClaimExecution(request)).toBe(false);
    expect(service.tryClaimExecution({ ...request, turnId: 'turn-2' })).toBe(true);
  });

  it('delegates custom avatar loading to the qualified official package worker', async () => {
    const { runtime, desktopStateRequests } = await createRuntimeHarness();
    const service = new CustomAvatarsService(runtime);
    await expect(service.load()).resolves.toMatchObject({
      avatars: [{ id: 'custom:owl' }],
    });
    await expect(service.loadAvatar('custom:owl')).resolves.toEqual({ id: 'custom:owl' });
    expect(desktopStateRequests).toContainEqual({
      operation: 'custom-avatars.load-avatar',
      params: { avatarId: 'custom:owl' },
    });
  });

  it('uses app-server plugin discovery and the official scheduled-template parser', async () => {
    const { runtime, appServerRequests, desktopStateRequests } = await createRuntimeHarness();
    const service = new PluginScheduledTasksService(runtime);
    await expect(
      service.list({
        buildFlavor: 'prod',
        cwds: [runtime.workspaceRoot],
        hiddenMarketplaceNames: ['hidden'],
        marketplaceKinds: ['plugin'],
      }),
    ).resolves.toMatchObject({
      groups: [{ plugin: { id: 'plugin-1' }, templates: [{ name: 'Daily' }] }],
    });
    expect(appServerRequests).toEqual([
      {
        method: 'plugin/list',
        params: {
          cwds: [runtime.workspaceRoot],
          marketplaceKinds: ['plugin'],
        },
      },
    ]);
    expect(desktopStateRequests).toContainEqual({
      operation: 'plugin-scheduled-tasks.list',
      params: {
        buildFlavor: 'prod',
        hiddenMarketplaceNames: ['hidden'],
        marketplaces: [{ name: 'public', plugins: [] }],
      },
    });
  });

  it('normalizes and persists official Browser Use origin permission rules', async () => {
    const { runtime } = await createRuntimeHarness();
    const service = new BrowserUsePermissionsService(runtime);
    await expect(
      service.updateOriginRules([
        {
          action: 'add',
          kind: 'denied',
          origin: 'https://example.com/path',
          resource: 'origin',
        },
        {
          action: 'add',
          kind: 'allowed',
          origin: 'example.com',
          resource: 'origin',
        },
        {
          action: 'add',
          kind: 'allowed',
          origin: 'downloads.example.com/file',
          resource: 'download',
        },
      ]),
    ).resolves.toMatchObject({
      allowedOrigins: ['https://example.com'],
      deniedOrigins: [],
      allowedDownloadOrigins: ['https://downloads.example.com'],
      approvalMode: 'alwaysAsk',
    });
    const config = await readFile(join(runtime.codexHome, 'browser', 'config.toml'), 'utf8');
    expect(config).toContain('https://example.com');
    expect(config).toContain('https://downloads.example.com');
    await expect(
      service.updateOriginRules([
        {
          action: 'remove',
          kind: 'allowed',
          origin: 'https://example.com',
          resource: 'origin',
        },
      ]),
    ).resolves.toMatchObject({ allowedOrigins: [] });
  });

  it('counts folder files recursively while ignoring symbolic links', async () => {
    const { runtime } = await createRuntimeHarness();
    const folder = join(runtime.workspaceRoot, 'folder');
    await mkdir(join(folder, 'nested'), { recursive: true });
    await Promise.all([
      writeFile(join(folder, 'one.txt'), 'one'),
      writeFile(join(folder, 'nested', 'two.txt'), 'two'),
      symlink(join(folder, 'nested'), join(folder, 'linked')),
    ]);
    const service = new FileAttachmentsService(runtime);
    await expect(service.countFolderFiles({ folderPath: folder, hostId: 'local' })).resolves.toBe(
      2,
    );
  });

  it('persists supported clipboard images with private permissions', async () => {
    const { runtime } = await createRuntimeHarness();
    const service = new FileAttachmentsService(runtime);
    const path = await service.persistImageFileToTemp({
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'image/png',
    });
    expect(path).toMatch(/codex-clipboard-[0-9a-f-]+\.png$/u);
    expect((await stat(path as string)).mode & 0o777).toBe(0o600);
    await expect(
      service.persistImageFileToTemp({
        bytes: new Uint8Array([1]),
        mimeType: 'image/svg+xml',
      }),
    ).resolves.toBeNull();
  });

  it('reads, writes, detects conflicts, and confines workspace files', async () => {
    const { runtime } = await createRuntimeHarness();
    const service = new WorkspaceFilesService(runtime);
    const path = join(runtime.workspaceRoot, 'file.txt');
    await writeFile(path, 'first');
    const first = await service.read({ hostId: 'local', path, representation: 'auto' });
    expect(first).toMatchObject({ text: 'first' });
    expect(typeof first.etag).toBe('string');

    await expect(
      service.write({
        bytes: new TextEncoder().encode('second'),
        hostId: 'local',
        ifMatch: 'not-the-etag',
        path,
      }),
    ).resolves.toMatchObject({ outcome: 'conflict' });
    await expect(
      service.write({
        bytes: new TextEncoder().encode('second'),
        hostId: 'local',
        ifMatch: first.etag,
        path,
      }),
    ).resolves.toMatchObject({ outcome: 'saved' });
    expect(await readFile(path, 'utf8')).toBe('second');

    await expect(
      service.read({ hostId: 'local', path: '/etc/passwd', representation: 'text' }),
    ).rejects.toThrow('outside the user root');
  });

  it('creates and releases official-style temporary preview files', async () => {
    const { runtime } = await createRuntimeHarness();
    const service = new WorkspaceFilesService(runtime);
    const result = await service.createTemporaryFile({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: '../unsafe.PDF',
    });
    expect(result.path).toMatch(/codex-file-preview-[^/]+\/preview\.pdf$/u);
    await expect(stat(result.path)).resolves.toBeDefined();
    await service.releaseTemporaryFile(result);
    await expect(stat(result.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('delivers workspace copies through a one-time browser download message', async () => {
    const { runtime, messages } = await createRuntimeHarness();
    const path = join(runtime.workspaceRoot, 'download.txt');
    await writeFile(path, 'download');
    const service = new WorkspaceFilesService(runtime, 'browser-session');
    await service.downloadCopy({ hostId: 'local', path });
    expect(messages).toEqual([
      {
        type: '__browser-download',
        browserSessionId: 'browser-session',
        fileName: 'download.txt',
        token: '00000000-0000-4000-8000-000000000001',
      },
    ]);
  });

  it('persists exact thread project assignments and broadcasts changes once', async () => {
    const { runtime, globalState, messages } = await createRuntimeHarness();
    const service = new ThreadProjectAssignmentsService(runtime);
    const request = {
      threadId: 'thread-1',
      assignment: {
        projectKind: 'local',
        projectId: 'project-1',
        path: runtime.workspaceRoot,
        pendingCoreUpdate: false,
      },
    };
    await service.setAssignment(request);
    await service.setAssignment(request);
    expect(globalState['thread-project-assignments']).toEqual({
      'thread-1': request.assignment,
    });
    expect(messages).toHaveLength(1);
  });

  it('archives inactive threads through the qualified official state worker', async () => {
    const { runtime, archivedNotifications } = await createRuntimeHarness();
    const service = new ThreadArchiveService(runtime);
    await expect(
      service.archiveInactiveThread({
        hostId: 'local',
        threadId: 'thread-1',
        removeCatalogEntryIfMissing: true,
      }),
    ).resolves.toEqual({ success: true });
    expect(archivedNotifications).toEqual([
      { method: 'thread/archived', params: { threadId: 'thread-1' } },
    ]);
  });

  it('creates onboarding artifacts in the server workspace', async () => {
    const { runtime } = await createRuntimeHarness();
    const service = new ConversationalOnboardingService(runtime);
    await expect(service.requestDesktopRoot()).resolves.toBe(runtime.workspaceRoot);
    const note = await service.createDesktopNote({
      content: 'hello',
      fileStem: '../Welcome',
      parentPath: runtime.workspaceRoot,
    });
    expect(note.path).toMatch(/\/workspace\/Welcome\.txt$/u);
    expect(await readFile(note.path, 'utf8')).toBe('hello');
  });

  it('reads only the official UUIDv7 visualization location and size', async () => {
    const { runtime } = await createRuntimeHarness();
    const timestamp = Date.UTC(2026, 6, 26).toString(16).padStart(12, '0');
    const threadId = `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-000000000001`;
    const directory = join(runtime.codexHome, 'visualizations', '2026', '07', '26', threadId);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'result-view.html'), '<h1>result</h1>');
    const service = new VisualizationsService(runtime);
    await expect(
      service.read({ file: 'result-view.html', hostId: 'local', threadId }),
    ).resolves.toEqual({ contents: '<h1>result</h1>' });
    await expect(
      service.read({ file: '../escape.html', hostId: 'local', threadId }),
    ).rejects.toThrow('Invalid visualization read request');
  });
});
