import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  RealtimeContinuityService,
  RealtimeMemoryService,
  RealtimeVoiceHistoryService,
  RealtimeVoiceMultiAgentActivityService,
  RealtimeVoicePresentationService,
  RealtimeVoiceRuntimeService,
  RealtimeVoiceStateService,
} from './realtime-voice.js';
import type { UserRuntime } from './runtime.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

interface RealtimeHarness {
  runtime: UserRuntime;
  root: string;
  codexHome: string;
  globalState: Record<string, unknown>;
  appServerRequests: unknown[];
  messages: unknown[];
}

async function createHarness(): Promise<RealtimeHarness> {
  const root = await mkdtemp(join(tmpdir(), 'codex-realtime-voice-'));
  temporaryRoots.push(root);
  const codexHome = join(root, 'codex-home');
  await mkdir(codexHome, { recursive: true });
  const globalState: Record<string, unknown> = {};
  const appServerRequests: unknown[] = [];
  const messages: unknown[] = [];
  const emitter = new EventEmitter();
  const runtime = Object.assign(emitter, {
    root,
    codexHome,
    getGlobalState: (key: string) => globalState[key],
    setGlobalState: (key: string, value: unknown) => {
      globalState[key] = value;
      return Promise.resolve();
    },
    requestAppServer: (method: string, params: unknown) => {
      appServerRequests.push({ method, params });
      return Promise.resolve({});
    },
    sendViewMessage: (message: unknown) => messages.push(message),
  }) as unknown as UserRuntime;
  return {
    runtime,
    root,
    codexHome,
    globalState,
    appServerRequests,
    messages,
  };
}

function locator(conversationId = 'thread-1'): {
  hostId: string;
  conversationId: string;
} {
  return { hostId: 'local', conversationId };
}

describe('official realtime voice AppHost services', () => {
  it('persists bounded continuity and reads the memory summary', async () => {
    const { runtime, codexHome } = await createHarness();
    const continuity = new RealtimeContinuityService(runtime);
    await continuity.record({
      threadId: 'thread-1',
      item: { role: 'user', text: '  first message  ' },
      maxItems: 2,
      maxTextLength: 100,
    });
    await continuity.record({
      threadId: 'thread-1',
      item: { role: 'assistant', text: 'second message' },
      maxItems: 2,
      maxTextLength: 100,
    });
    await continuity.record({
      threadId: 'thread-1',
      item: { role: 'user', text: 'third message is truncated' },
      maxItems: 2,
      maxTextLength: 13,
    });
    await expect(
      new RealtimeContinuityService(runtime).read({
        threadId: 'thread-1',
        maxItems: 10,
      }),
    ).resolves.toEqual([
      { role: 'assistant', text: 'second message' },
      { role: 'user', text: 'third message' },
    ]);

    const memory = new RealtimeMemoryService(runtime);
    await expect(memory.readSummary()).resolves.toBeNull();
    await mkdir(join(codexHome, 'memories'), { recursive: true });
    await writeFile(join(codexHome, 'memories', 'memory_summary.md'), '  durable memory  ');
    await expect(memory.readSummary()).resolves.toBe('durable memory');
  });

  it('coordinates one voice owner, remote controls, presentation, and release', async () => {
    const { runtime } = await createHarness();
    const voice = new RealtimeVoiceStateService(runtime);
    const presentation = new RealtimeVoicePresentationService(runtime);
    const controls: unknown[] = [];
    const snapshots: unknown[] = [];
    const presentations: unknown[] = [];
    const controller = {
      control: (control: unknown) => {
        controls.push(control);
        return Promise.resolve();
      },
    };
    const surface = presentation.registerSurface(locator(), 'main-thread', true, () =>
      Promise.resolve(),
    );
    presentation.subscribe((snapshot: unknown) => presentations.push(snapshot));
    voice.subscribe((snapshot: unknown) => snapshots.push(snapshot));

    const claimId = voice.claim(locator(), controller, 'main-thread');
    expect(claimId).toEqual(expect.any(String));
    expect(voice.claim(locator('thread-2'), controller, 'main-thread')).toBeNull();
    voice.publish(claimId, {
      activity: 'listening',
      microphoneMuted: false,
      outputMuted: false,
      phase: 'active',
    });
    expect(voice.getSnapshot()).toMatchObject({
      activity: 'listening',
      locator: locator(),
      phase: 'active',
    });
    expect(presentation.getSnapshot()).toEqual({
      active: { handoff: null, locator: locator(), surface: 'main-thread' },
    });

    expect(voice.controlActive({ type: 'toggle-microphone-mute' })).toBe(true);
    await Promise.resolve();
    expect(controls).toContainEqual({ type: 'set-microphone-muted', muted: true });
    runtime.emit('app-server-notification', {
      method: 'thread/realtime/started',
      params: { threadId: 'thread-1', realtimeSessionId: 'session-1', version: 'v3' },
    });
    expect(voice.getSnapshot()).toMatchObject({ sessionId: 'session-1' });

    voice.release(claimId);
    expect(voice.getSnapshot()).toMatchObject({ phase: 'inactive', locator: null });
    expect(presentation.getSnapshot()).toEqual({ active: null });
    expect(snapshots.length).toBeGreaterThanOrEqual(3);
    expect(presentations.length).toBeGreaterThanOrEqual(2);
    surface.unregister();
  });

  it('routes realtime startup through the owning browser tab and reports launch state', async () => {
    const { runtime, messages } = await createHarness();
    const service = new RealtimeVoiceRuntimeService(runtime, 'browser-tab-1');
    const starts: unknown[] = [];
    let cancelCount = 0;
    service.registerRealtimeStarter(
      (request: unknown) => {
        starts.push(request);
        return Promise.resolve();
      },
      () => {
        cancelCount += 1;
        return Promise.resolve();
      },
      true,
    );
    await service.requestRealtimeStart({ source: 'composer_button_new_thread' }, 'launch-1');
    expect(starts).toEqual([
      {
        source: 'composer_button_new_thread',
        preferredPresentationSurface: 'main-thread',
      },
    ]);
    expect(messages).toEqual([
      {
        type: 'realtime-voice-launch-state-changed',
        launchId: 'launch-1',
        phase: 'starting',
      },
      {
        type: 'realtime-voice-launch-state-changed',
        launchId: 'launch-1',
        phase: 'connected',
      },
    ]);
    await service.cancelRealtimeSessionStart();
    expect(cancelCount).toBe(1);
    service.unregisterRealtimeStarter();
  });

  it('projects and persists transcript history across service reconstruction', async () => {
    const { runtime, globalState } = await createHarness();
    const snapshots: Array<{
      entries: unknown[];
      isLoaded: boolean;
      records: unknown[];
    }> = [];
    const history = new RealtimeVoiceHistoryService(runtime);
    history.subscribe(locator(), (snapshot: unknown) => {
      snapshots.push(snapshot as { entries: unknown[]; isLoaded: boolean; records: unknown[] });
    });
    runtime.emit('app-server-notification', {
      method: 'thread/realtime/started',
      params: { threadId: 'thread-1', sessionId: 'session-1', version: 'v3' },
    });
    runtime.emit('app-server-notification', {
      method: 'thread/realtime/transcript/delta',
      params: { threadId: 'thread-1', role: 'user', delta: 'hello ' },
    });
    runtime.emit('app-server-notification', {
      method: 'thread/realtime/transcript/done',
      params: { threadId: 'thread-1', role: 'user', text: 'hello world' },
    });
    runtime.emit('app-server-notification', {
      method: 'thread/realtime/closed',
      params: { threadId: 'thread-1', reason: null },
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(snapshots.at(-1)).toMatchObject({
      isLoaded: true,
      entries: [
        {
          type: 'item',
          completed: true,
          role: 'user',
          text: 'hello world',
        },
      ],
      records: [
        { sequence: 1, sessionId: 'session-1', type: 'session-started' },
        {
          sequence: 2,
          sessionId: 'session-1',
          type: 'transcript-item',
          item: { completed: true, role: 'user', text: 'hello world' },
        },
        { sequence: 3, sessionId: 'session-1', type: 'session-ended' },
      ],
    });
    expect(globalState['__browser-host-realtime-voice-history-v1']).toBeDefined();

    const restartedRuntime = Object.assign(new EventEmitter(), {
      codexHome: runtime.codexHome,
      getGlobalState: (key: string) => globalState[key],
      setGlobalState: (key: string, value: unknown) => {
        globalState[key] = value;
        return Promise.resolve();
      },
      requestAppServer: () => Promise.resolve({}),
      sendViewMessage: () => undefined,
    }) as unknown as UserRuntime;
    const reloadedSnapshots: unknown[] = [];
    new RealtimeVoiceHistoryService(restartedRuntime).subscribe(locator(), (snapshot: unknown) =>
      reloadedSnapshots.push(snapshot),
    );
    expect(reloadedSnapshots.at(-1)).toMatchObject({
      entries: [{ completed: true, role: 'user', text: 'hello world' }],
      records: [
        { sequence: 1, type: 'session-started' },
        { sequence: 2, type: 'transcript-item' },
        { sequence: 3, type: 'session-ended' },
      ],
    });
  });

  it('publishes bounded multi-agent activity for an active voice task', async () => {
    const { runtime } = await createHarness();
    const service = new RealtimeVoiceMultiAgentActivityService(runtime);
    const snapshots: Array<{ activities: unknown[] }> = [];
    service.subscribe(locator(), (snapshot: unknown) =>
      snapshots.push(snapshot as { activities: unknown[] }),
    );
    runtime.emit('app-server-notification', {
      method: 'thread/realtime/started',
      params: { threadId: 'thread-1', sessionId: 'session-1', version: 'v3' },
    });
    runtime.emit('app-server-notification', {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          agentsStates: {},
          id: 'item-1',
          prompt: 'investigate',
          receiverThreadIds: ['thread-2'],
          senderThreadId: 'thread-1',
          status: 'completed',
          tool: 'spawnAgent',
          type: 'collabAgentToolCall',
        },
      },
    });
    expect(snapshots.at(-1)).toMatchObject({
      activities: [
        {
          id: 'thread-created:local:thread-2',
          kind: 'thread-created',
          prompt: 'investigate',
          realtimeThread: locator(),
          task: { hostId: 'local', threadId: 'thread-2' },
        },
      ],
    });
  });
});
