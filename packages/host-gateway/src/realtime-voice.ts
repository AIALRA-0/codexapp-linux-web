import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { RpcTarget } from 'capnweb';

import type { UserRuntime } from './runtime.js';

type RemoteCallback = ((...args: unknown[]) => unknown) & {
  dup?: () => RemoteCallback;
  onRpcBroken?: (callback: () => void) => void;
  [Symbol.dispose]?: () => void;
};

interface RemoteVoiceController {
  control: (control: VoiceControl) => unknown;
  dup?: () => RemoteVoiceController;
  onRpcBroken?: (callback: () => void) => void;
  [Symbol.dispose]?: () => void;
}

interface RealtimeLocator {
  hostId: string;
  conversationId: string;
}

interface RealtimeVoiceSnapshot {
  activity: string;
  locator: RealtimeLocator | null;
  microphoneMuted: boolean;
  outputMuted: boolean;
  phase: 'inactive' | 'starting' | 'active' | 'stopping';
  preferredPresentationSurface: 'global-overlay' | 'main-thread' | null;
  sessionId: string | null;
}

interface VoiceClaim {
  claimId: string;
  cleanup: 'none' | 'orphaned' | 'terminating';
  controller: RemoteVoiceController;
  pendingMicrophoneMuteIntents: Array<{
    type: 'set-microphone-muted';
    muted: boolean;
  }>;
  pendingOutputMuteIntents: Array<{
    type: 'set-output-muted';
    muted: boolean;
  }>;
  published: boolean;
  snapshot: RealtimeVoiceSnapshot;
}

interface RealtimeStarter {
  canCreateNewThread: boolean;
  cancel: RemoteCallback;
  generation: number;
  start: RemoteCallback;
}

interface TranscriptItem {
  type: 'item';
  completed: boolean;
  id: string;
  role: 'assistant' | 'user';
  text: string;
}

interface TranscriptDivider {
  type: 'session-divider';
  id: string;
}

type TranscriptEntry = TranscriptItem | TranscriptDivider;

interface TranscriptSnapshot {
  entries: TranscriptEntry[];
  isLoaded: true;
  records: unknown[];
}

interface HistoryState {
  entries: TranscriptEntry[];
  records: Array<Record<string, unknown>>;
  sequence: number;
  sessionId: string | null;
}

const INACTIVE_VOICE_SNAPSHOT: RealtimeVoiceSnapshot = Object.freeze({
  activity: 'idle',
  locator: null,
  microphoneMuted: false,
  outputMuted: false,
  phase: 'inactive',
  preferredPresentationSurface: null,
  sessionId: null,
});
const CONTINUITY_FILE_NAME = 'realtime-voice-continuity.json';
const HISTORY_STATE_KEY = '__browser-host-realtime-voice-history-v1';
const runtimeBundles = new WeakMap<UserRuntime, RealtimeRuntimeBundle>();
const continuityQueues = new Map<string, Promise<void>>();

class RealtimeRuntimeBundle {
  readonly voice: RealtimeVoiceCoordinator;
  readonly history: RealtimeVoiceHistoryCoordinator;
  readonly multiAgentActivity: RealtimeVoiceMultiAgentActivityCoordinator;
  readonly presentation: RealtimeVoicePresentationCoordinator;
  readonly runtimes: RealtimeVoiceRuntimeCoordinator;

  constructor(runtime: UserRuntime) {
    this.voice = new RealtimeVoiceCoordinator(async (locator) => {
      if (locator.hostId !== 'local') return;
      await runtime.requestAppServer('thread/realtime/stop', {
        threadId: locator.conversationId,
      });
    });
    this.history = new RealtimeVoiceHistoryCoordinator(runtime);
    this.multiAgentActivity = new RealtimeVoiceMultiAgentActivityCoordinator();
    this.presentation = new RealtimeVoicePresentationCoordinator(this.voice);
    this.runtimes = new RealtimeVoiceRuntimeCoordinator(runtime);
    runtime.on('app-server-notification', this.#onNotification);
    runtime.on('app-server-exit', this.#onAppServerExit);
  }

  readonly #onNotification = (notification: unknown): void => {
    this.voice.observeNotification(notification);
    this.history.observeNotification(notification);
    this.multiAgentActivity.observeNotification(notification);
  };

  readonly #onAppServerExit = (): void => {
    this.voice.handleHostDisconnected('local');
    this.history.handleHostDisconnected('local');
    this.multiAgentActivity.handleHostDisconnected('local');
  };
}

function bundleFor(runtime: UserRuntime): RealtimeRuntimeBundle {
  let bundle = runtimeBundles.get(runtime);
  if (bundle === undefined) {
    bundle = new RealtimeRuntimeBundle(runtime);
    runtimeBundles.set(runtime, bundle);
  }
  return bundle;
}

export class RealtimeContinuityService extends RpcTarget {
  readonly #runtime: UserRuntime;

  constructor(runtime: UserRuntime) {
    super();
    this.#runtime = runtime;
  }

  async read(request: unknown): Promise<Array<{ role: 'assistant' | 'user'; text: string }>> {
    const params = requestRecord(request, 'realtime continuity read');
    const threadId = requestString(params.threadId, 'threadId');
    const maxItems = nonNegativeInteger(params.maxItems, 'maxItems');
    const state = await readContinuityState(this.#runtime.codexHome);
    return (state.threads[threadId]?.items ?? []).slice(-maxItems);
  }

  async record(request: unknown): Promise<void> {
    const params = requestRecord(request, 'realtime continuity record');
    const threadId = requestString(params.threadId, 'threadId');
    const maxItems = nonNegativeInteger(params.maxItems, 'maxItems');
    const maxTextLength = nonNegativeInteger(params.maxTextLength, 'maxTextLength');
    const itemValue = requestRecord(params.item, 'realtime continuity item');
    const role = transcriptRole(itemValue.role);
    const text = requestStringValue(itemValue.text, 'text').trim().slice(0, maxTextLength);
    if (text.length === 0) return;
    const path = continuityPath(this.#runtime.codexHome);
    const pending = (continuityQueues.get(path) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const state = await readContinuityState(this.#runtime.codexHome);
        const items = state.threads[threadId]?.items ?? [];
        state.threads[threadId] = {
          items: [...items, { role, text }].slice(-maxItems),
        };
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `${JSON.stringify(state)}\n`, 'utf8');
      });
    const settled = pending.then(
      () => undefined,
      () => undefined,
    );
    continuityQueues.set(path, settled);
    try {
      await pending;
    } finally {
      if (continuityQueues.get(path) === settled) continuityQueues.delete(path);
    }
  }
}

export class RealtimeMemoryService extends RpcTarget {
  readonly #runtime: UserRuntime;

  constructor(runtime: UserRuntime) {
    super();
    this.#runtime = runtime;
  }

  async readSummary(): Promise<string | null> {
    try {
      const summary = await readFile(
        join(this.#runtime.codexHome, 'memories', 'memory_summary.md'),
        'utf8',
      );
      return summary.trim() || null;
    } catch {
      return null;
    }
  }
}

export class RealtimeVoiceStateService extends RpcTarget {
  readonly #coordinator: RealtimeVoiceCoordinator;

  constructor(runtime: UserRuntime) {
    super();
    this.#coordinator = bundleFor(runtime).voice;
  }

  claim(
    locatorValue: unknown,
    controllerValue: unknown,
    preferredPresentationSurfaceValue: unknown,
  ): string | null {
    return this.#coordinator.claim(
      parseLocator(locatorValue),
      remoteVoiceController(controllerValue),
      presentationSurface(preferredPresentationSurfaceValue),
    );
  }

  publish(claimId: unknown, snapshot: unknown): void {
    this.#coordinator.publish(
      requestStringValue(claimId, 'claimId'),
      parsePublishedVoiceSnapshot(snapshot),
    );
  }

  release(claimId: unknown): void {
    this.#coordinator.release(requestStringValue(claimId, 'claimId'));
  }

  control(locator: unknown, control: unknown): boolean {
    return this.#coordinator.control(parseLocator(locator), parseVoiceControl(control));
  }

  controlActive(control: unknown): boolean {
    return this.#coordinator.controlActive(parseVoiceControl(control));
  }

  recordRealDelegation(locator: unknown, delegation: unknown): void {
    this.#coordinator.recordRealDelegation(parseLocator(locator), delegation);
  }

  getSnapshot(): RealtimeVoiceSnapshot {
    return this.#coordinator.getSnapshot();
  }

  subscribe(listenerValue: unknown): RpcSubscription {
    return this.#coordinator.subscribe(remoteCallback(listenerValue, 'realtime voice listener'));
  }
}

export class RealtimeVoiceRuntimeService extends RpcTarget {
  readonly #coordinator: RealtimeVoiceRuntimeCoordinator;
  readonly #originId: string;

  constructor(runtime: UserRuntime, browserSessionId: string) {
    super();
    this.#coordinator = bundleFor(runtime).runtimes;
    this.#originId = browserSessionId;
  }

  registerRealtimeStarter(
    startValue: unknown,
    cancelValue: unknown,
    canCreateNewThreadValue: unknown,
  ): void {
    if (typeof canCreateNewThreadValue !== 'boolean') {
      throw new TypeError('Realtime starter capability must be boolean');
    }
    this.#coordinator.register(
      this.#originId,
      remoteCallback(startValue, 'realtime start callback'),
      remoteCallback(cancelValue, 'realtime cancel callback'),
      canCreateNewThreadValue,
    );
  }

  requestRealtimeStart(request: unknown, launchId: unknown): Promise<void> {
    return this.#coordinator.requestStart(
      this.#originId,
      requestRecord(request, 'realtime start'),
      launchId === undefined ? undefined : requestStringValue(launchId, 'launchId'),
    );
  }

  cancelRealtimeSessionStart(): Promise<void> {
    return this.#coordinator.cancel(this.#originId);
  }

  completeRealtimeSession(): void {
    this.#coordinator.complete(this.#originId);
  }

  unregisterRealtimeStarter(): void {
    this.#coordinator.unregister(this.#originId);
  }
}

export class RealtimeVoiceHistoryService extends RpcTarget {
  readonly #history: RealtimeVoiceHistoryCoordinator;

  constructor(runtime: UserRuntime) {
    super();
    this.#history = bundleFor(runtime).history;
  }

  subscribe(locator: unknown, listenerValue: unknown): RpcSubscription {
    return this.#history.subscribe(
      parseLocator(locator),
      remoteCallback(listenerValue, 'realtime voice history listener'),
    );
  }
}

export class RealtimeVoiceMultiAgentActivityService extends RpcTarget {
  readonly #coordinator: RealtimeVoiceMultiAgentActivityCoordinator;

  constructor(runtime: UserRuntime) {
    super();
    this.#coordinator = bundleFor(runtime).multiAgentActivity;
  }

  subscribe(locatorValue: unknown, listenerValue: unknown): RpcSubscription {
    return this.#coordinator.subscribe(
      parseLocator(locatorValue),
      remoteCallback(listenerValue, 'realtime multi-agent listener'),
    );
  }
}

export class RealtimeVoicePresentationService extends RpcTarget {
  readonly #coordinator: RealtimeVoicePresentationCoordinator;

  constructor(runtime: UserRuntime) {
    super();
    this.#coordinator = bundleFor(runtime).presentation;
  }

  getSnapshot(): { active: PresentationState | null } {
    return this.#coordinator.getSnapshot();
  }

  registerSurface(
    locatorValue: unknown,
    surfaceValue: unknown,
    eligibleValue: unknown,
    showToastValue: unknown,
  ): RealtimePresentationSurfaceHandle {
    if (typeof eligibleValue !== 'boolean') {
      throw new TypeError('Realtime presentation eligibility must be boolean');
    }
    return this.#coordinator.registerSurface(
      parseLocator(locatorValue),
      presentationSurface(surfaceValue),
      eligibleValue,
      remoteCallback(showToastValue, 'realtime presentation toast callback'),
    );
  }

  reportToast(locatorValue: unknown, toast: unknown): Promise<boolean> {
    return this.#coordinator.reportToast(parseLocator(locatorValue), toast);
  }

  requestSurface(locatorValue: unknown, surfaceValue: unknown, motion: unknown): void {
    this.#coordinator.requestSurface(
      parseLocator(locatorValue),
      presentationSurface(surfaceValue),
      motion,
    );
  }

  subscribe(listenerValue: unknown): RpcSubscription {
    return this.#coordinator.subscribe(
      remoteCallback(listenerValue, 'realtime presentation listener'),
    );
  }
}

export class RpcSubscription extends RpcTarget {
  #unsubscribe: (() => void) | null;

  constructor(unsubscribe: () => void) {
    super();
    this.#unsubscribe = unsubscribe;
  }

  unsubscribe(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  [Symbol.dispose](): void {
    this.unsubscribe();
  }
}

class RealtimeVoiceCoordinator {
  readonly #terminateBackendSession: (locator: RealtimeLocator) => Promise<void>;
  #claim: VoiceClaim | null = null;
  readonly #listeners = new Set<RemoteCallback>();

  constructor(terminateBackendSession: (locator: RealtimeLocator) => Promise<void>) {
    this.#terminateBackendSession = terminateBackendSession;
  }

  claim(
    locator: RealtimeLocator,
    controllerValue: RemoteVoiceController,
    preferredPresentationSurface: 'global-overlay' | 'main-thread',
  ): string | null {
    if (this.#claim !== null) return null;
    const claimId = randomUUID();
    const controller = retainVoiceController(controllerValue);
    this.#claim = {
      claimId,
      cleanup: 'none',
      controller,
      pendingMicrophoneMuteIntents: [],
      pendingOutputMuteIntents: [],
      published: false,
      snapshot: {
        activity: 'idle',
        locator,
        microphoneMuted: false,
        outputMuted: false,
        phase: 'starting',
        preferredPresentationSurface,
        sessionId: null,
      },
    };
    controller.onRpcBroken?.(() => this.#orphan(claimId));
    return claimId;
  }

  publish(claimId: string, snapshot: Omit<RealtimeVoiceSnapshot, 'locator' | 'sessionId'>): void {
    const claim = this.#claim;
    if (claim?.claimId !== claimId || claim.cleanup !== 'none') return;
    claim.snapshot = {
      ...snapshot,
      locator: claim.snapshot.locator,
      preferredPresentationSurface: claim.snapshot.preferredPresentationSurface,
      sessionId: claim.snapshot.sessionId,
    };
    if (claim.pendingMicrophoneMuteIntents[0]?.muted === snapshot.microphoneMuted) {
      claim.pendingMicrophoneMuteIntents.shift();
    }
    if (claim.pendingOutputMuteIntents[0]?.muted === snapshot.outputMuted) {
      claim.pendingOutputMuteIntents.shift();
    }
    claim.published = true;
    this.#emit();
  }

  release(claimId: string): void {
    const claim = this.#claim;
    if (claim?.claimId !== claimId || claim.cleanup === 'orphaned') return;
    this.#clear();
  }

  control(locator: RealtimeLocator, control: VoiceControl): boolean {
    const claim = this.#claim;
    if (
      claim === null ||
      claim.cleanup !== 'none' ||
      claim.snapshot.phase === 'stopping' ||
      !sameLocator(claim.snapshot.locator, locator)
    ) {
      return false;
    }
    switch (control.type) {
      case 'stop':
        claim.snapshot = { ...claim.snapshot, phase: 'stopping' };
        this.#emit();
        invokeVoiceControl(claim.controller, control);
        return true;
      case 'simulate-usage-limit-approaching-for-debug':
        invokeVoiceControl(claim.controller, control);
        return true;
      case 'set-microphone-muted':
        this.#queueMuteControl(
          claim,
          claim.pendingMicrophoneMuteIntents,
          claim.snapshot.microphoneMuted,
          control,
        );
        return true;
      case 'set-output-muted':
        this.#queueMuteControl(
          claim,
          claim.pendingOutputMuteIntents,
          claim.snapshot.outputMuted,
          control,
        );
        return true;
      case 'terminate':
      case 'toggle-microphone-mute':
      case 'toggle-output-mute':
      case 'record-real-delegation':
        return false;
    }
  }

  controlActive(control: VoiceControl): boolean {
    const claim = this.#claim;
    if (claim === null) return false;
    if (claim.cleanup !== 'none' || claim.snapshot.phase === 'stopping') return true;
    if (control.type === 'toggle-microphone-mute') {
      return this.control(claim.snapshot.locator!, {
        type: 'set-microphone-muted',
        muted: !(
          claim.pendingMicrophoneMuteIntents.at(-1)?.muted ?? claim.snapshot.microphoneMuted
        ),
      });
    }
    if (control.type === 'toggle-output-mute') {
      return this.control(claim.snapshot.locator!, {
        type: 'set-output-muted',
        muted: !(claim.pendingOutputMuteIntents.at(-1)?.muted ?? claim.snapshot.outputMuted),
      });
    }
    if (control.type === 'stop' || control.type === 'simulate-usage-limit-approaching-for-debug') {
      return this.control(claim.snapshot.locator!, control);
    }
    return false;
  }

  recordRealDelegation(locator: RealtimeLocator, delegation: unknown): void {
    const claim = this.#claim;
    if (
      claim === null ||
      claim.cleanup !== 'none' ||
      !sameLocator(claim.snapshot.locator, locator)
    ) {
      return;
    }
    invokeVoiceControl(claim.controller, {
      type: 'record-real-delegation',
      delegation,
    });
  }

  getSnapshot(): RealtimeVoiceSnapshot {
    return this.#claim?.published === true
      ? structuredClone(this.#claim.snapshot)
      : { ...INACTIVE_VOICE_SNAPSHOT };
  }

  subscribe(listenerValue: RemoteCallback): RpcSubscription {
    const listener = retainCallback(listenerValue);
    this.#listeners.add(listener);
    listener.onRpcBroken?.(() => this.#removeListener(listener));
    if (this.#listeners.has(listener)) invokeRemote(listener, this.getSnapshot());
    return new RpcSubscription(() => this.#removeListener(listener));
  }

  observeNotification(notification: unknown): void {
    const parsed = notificationParts(notification);
    if (parsed === null || this.#claim === null) return;
    if (parsed.params.threadId !== this.#claim.snapshot.locator?.conversationId) {
      return;
    }
    if (parsed.method === 'thread/realtime/started') {
      const sessionId =
        optionalString(parsed.params.realtimeSessionId) ?? optionalString(parsed.params.sessionId);
      if (sessionId !== null) {
        this.#claim.snapshot = { ...this.#claim.snapshot, sessionId };
        this.#emit();
      }
    }
  }

  handleHostDisconnected(hostId: string): void {
    const claim = this.#claim;
    if (claim === null || claim.snapshot.locator?.hostId !== hostId) return;
    if (claim.cleanup === 'orphaned') {
      this.#clear();
      return;
    }
    if (claim.cleanup === 'terminating') return;
    claim.cleanup = 'terminating';
    claim.snapshot = { ...claim.snapshot, activity: 'idle', phase: 'stopping' };
    this.#emit();
    const claimId = claim.claimId;
    Promise.resolve(callVoiceControl(claim.controller, { type: 'terminate' }))
      .catch(() => undefined)
      .finally(() => {
        if (this.#claim?.claimId === claimId && this.#claim.cleanup === 'terminating') {
          this.#clear();
        }
      });
  }

  #orphan(claimId: string): void {
    const claim = this.#claim;
    if (claim?.claimId !== claimId || claim.cleanup !== 'none') return;
    claim.cleanup = 'orphaned';
    claim.snapshot = { ...claim.snapshot, activity: 'idle', phase: 'stopping' };
    this.#emit();
    const locator = claim.snapshot.locator;
    Promise.resolve(locator === null ? undefined : this.#terminateBackendSession(locator))
      .catch(() => undefined)
      .finally(() => {
        if (this.#claim?.claimId === claimId) this.#clear();
      });
  }

  #queueMuteControl(
    claim: VoiceClaim,
    pending: SetMuteControl[],
    publishedMuted: boolean,
    control: SetMuteControl,
  ): void {
    if ((pending.at(-1)?.muted ?? publishedMuted) === control.muted) return;
    const intent = { ...control };
    pending.push(intent);
    callVoiceControl(claim.controller, intent).catch(() => {
      if (this.#claim !== claim || claim.cleanup !== 'none') return;
      const index = pending.indexOf(intent);
      if (index !== -1) pending.splice(index, 1);
    });
  }

  #clear(): void {
    const claim = this.#claim;
    if (claim === null) return;
    this.#claim = null;
    claim.controller[Symbol.dispose]?.();
    this.#emit();
  }

  #emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.#listeners) invokeRemote(listener, snapshot);
  }

  #removeListener(listener: RemoteCallback): void {
    if (!this.#listeners.delete(listener)) return;
    listener[Symbol.dispose]?.();
  }
}

type VoiceControl =
  | { type: 'stop' | 'terminate' | 'simulate-usage-limit-approaching-for-debug' }
  | { type: 'toggle-microphone-mute' | 'toggle-output-mute' }
  | { type: 'set-microphone-muted' | 'set-output-muted'; muted: boolean }
  | { type: 'record-real-delegation'; delegation: unknown };

type SetMuteControl = Extract<VoiceControl, { type: 'set-microphone-muted' | 'set-output-muted' }>;

class RealtimeVoiceRuntimeCoordinator {
  readonly #runtime: UserRuntime;
  readonly #starters = new Map<string, RealtimeStarter>();
  readonly #activeOrigins = new Set<string>();
  #generation = 0;

  constructor(runtime: UserRuntime) {
    this.#runtime = runtime;
  }

  register(
    originId: string,
    startValue: RemoteCallback,
    cancelValue: RemoteCallback,
    canCreateNewThread: boolean,
  ): void {
    this.unregister(originId);
    const generation = ++this.#generation;
    const start = retainCallback(startValue);
    const cancel = retainCallback(cancelValue);
    this.#starters.set(originId, { canCreateNewThread, cancel, generation, start });
    const broken = () => {
      if (this.#starters.get(originId)?.generation === generation) this.unregister(originId);
    };
    start.onRpcBroken?.(broken);
    cancel.onRpcBroken?.(broken);
  }

  async requestStart(
    originId: string,
    request: Record<string, unknown>,
    launchId?: string,
  ): Promise<void> {
    const source = requestStringValue(request.source, 'realtime start source');
    const isMainThreadLaunch =
      source === 'composer_button_new_thread' || source === 'composer_button_existing_thread';
    if (isMainThreadLaunch && launchId === undefined) {
      throw new Error('Main-window voice launches require a launch ID');
    }
    const starter = this.#starters.get(originId);
    if (starter === undefined) throw new Error('Voice chat is unavailable in this browser tab');
    if (source !== 'composer_button_existing_thread' && !starter.canCreateNewThread) {
      throw new Error('Voice chat cannot create a new task while the workspace is loading');
    }
    if (this.#activeOrigins.size > 0) {
      const error = 'Voice chat is already starting';
      if (launchId !== undefined) this.#publishLaunch(launchId, 'failed', error);
      return;
    }
    const generation = ++this.#generation;
    const preferredPresentationSurface = isMainThreadLaunch ? 'main-thread' : 'global-overlay';
    this.#activeOrigins.add(originId);
    if (launchId !== undefined) this.#publishLaunch(launchId, 'starting');
    try {
      await starter.start({ ...request, preferredPresentationSurface });
      if (generation !== this.#generation) return;
      if (launchId !== undefined) this.#publishLaunch(launchId, 'connected');
    } catch (error) {
      this.#activeOrigins.delete(originId);
      if (launchId !== undefined) {
        this.#publishLaunch(
          launchId,
          'failed',
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    }
  }

  async cancel(originId: string): Promise<void> {
    ++this.#generation;
    this.#activeOrigins.delete(originId);
    const starter = this.#starters.get(originId);
    if (starter !== undefined) await starter.cancel();
  }

  complete(originId: string): void {
    this.#activeOrigins.delete(originId);
  }

  unregister(originId: string): void {
    const starter = this.#starters.get(originId);
    if (starter === undefined) return;
    this.#starters.delete(originId);
    this.#activeOrigins.delete(originId);
    starter.start[Symbol.dispose]?.();
    starter.cancel[Symbol.dispose]?.();
  }

  #publishLaunch(
    launchId: string,
    phase: 'connected' | 'failed' | 'starting',
    error?: string,
  ): void {
    this.#runtime.sendViewMessage({
      type: 'realtime-voice-launch-state-changed',
      launchId,
      phase,
      ...(error === undefined ? {} : { error }),
    });
  }
}

class RealtimeVoiceHistoryCoordinator {
  readonly #runtime: UserRuntime;
  readonly #states = new Map<string, HistoryState>();
  readonly #listeners = new Set<{
    key: string;
    listener: RemoteCallback;
  }>();
  #persistQueue = Promise.resolve();

  constructor(runtime: UserRuntime) {
    this.#runtime = runtime;
    this.#restore();
  }

  subscribe(locator: RealtimeLocator, listenerValue: RemoteCallback): RpcSubscription {
    const listener = retainCallback(listenerValue);
    const key = locatorKey(locator);
    const entry = { key, listener };
    this.#listeners.add(entry);
    listener.onRpcBroken?.(() => this.#remove(entry));
    invokeRemote(listener, this.#snapshot(key));
    return new RpcSubscription(() => this.#remove(entry));
  }

  observeNotification(notification: unknown): void {
    const parsed = notificationParts(notification);
    if (parsed === null) return;
    const threadId = optionalString(parsed.params.threadId);
    if (threadId === null) return;
    const key = locatorKey({ hostId: 'local', conversationId: threadId });
    const state = this.#states.get(key) ?? {
      entries: [],
      records: [],
      sequence: 0,
      sessionId: null,
    };
    let changed = false;
    switch (parsed.method) {
      case 'thread/realtime/started': {
        const sessionId =
          optionalString(parsed.params.realtimeSessionId) ??
          optionalString(parsed.params.sessionId) ??
          randomUUID();
        if (state.sessionId !== null && state.sessionId !== sessionId && state.entries.length > 0) {
          state.entries.push({ type: 'session-divider', id: sessionId });
        }
        state.sessionId = sessionId;
        this.#appendRecord(state, {
          eventId: `session:${sessionId}:started`,
          occurredAtMs: Date.now(),
          sessionId,
          type: 'session-started',
        });
        changed = true;
        break;
      }
      case 'thread/realtime/transcript/delta': {
        const delta = optionalString(parsed.params.delta);
        const role = optionalTranscriptRole(parsed.params.role);
        if (delta === null || role === null) break;
        const sessionId = this.#ensureSession(state);
        const last = state.entries.at(-1);
        if (last?.type === 'item' && !last.completed && last.role === role) {
          last.text += delta;
        } else {
          state.entries.push({
            type: 'item',
            completed: false,
            id: randomUUID(),
            role,
            text: delta,
          });
        }
        void sessionId;
        changed = true;
        break;
      }
      case 'thread/realtime/transcript/done': {
        const text = optionalString(parsed.params.text);
        const role = optionalTranscriptRole(parsed.params.role);
        if (text === null || role === null) break;
        const sessionId = this.#ensureSession(state);
        const last = state.entries.at(-1);
        let item: TranscriptItem;
        if (last?.type === 'item' && !last.completed && last.role === role) {
          last.text = text;
          last.completed = true;
          item = last;
        } else {
          item = {
            type: 'item',
            completed: true,
            id: randomUUID(),
            role,
            text,
          };
          state.entries.push(item);
        }
        const baseEventId = `transcript:${sessionId}:${item.id}`;
        const eventId = state.records.some((record) => record.eventId === baseEventId)
          ? `${baseEventId}:final`
          : baseEventId;
        this.#appendRecord(state, {
          eventId,
          item: structuredClone(item),
          occurredAtMs: Date.now(),
          sessionId,
          type: 'transcript-item',
        });
        changed = true;
        break;
      }
      case 'thread/realtime/closed':
      case 'thread/realtime/error': {
        const sessionId = state.sessionId;
        if (sessionId !== null) {
          this.#appendRecord(state, {
            eventId: `session:${sessionId}:ended`,
            occurredAtMs: Date.now(),
            sessionId,
            type: parsed.method === 'thread/realtime/error' ? 'session-failed' : 'session-ended',
          });
        }
        state.sessionId = null;
        changed = true;
        break;
      }
      default:
        break;
    }
    if (!changed) return;
    state.entries = state.entries.slice(-1_000);
    this.#states.set(key, state);
    const snapshot = this.#snapshot(key);
    for (const entry of this.#listeners) {
      if (entry.key === key) invokeRemote(entry.listener, snapshot);
    }
    this.#persist();
  }

  handleHostDisconnected(hostId: string): void {
    for (const [key, state] of this.#states) {
      const locator = locatorFromKey(key);
      if (locator?.hostId !== hostId || state.sessionId === null) continue;
      const sessionId = state.sessionId;
      this.#appendRecord(state, {
        eventId: `session:${sessionId}:ended`,
        occurredAtMs: Date.now(),
        sessionId,
        type: 'session-failed',
      });
      state.sessionId = null;
      const snapshot = this.#snapshot(key);
      for (const entry of this.#listeners) {
        if (entry.key === key) invokeRemote(entry.listener, snapshot);
      }
    }
    this.#persist();
  }

  #snapshot(key: string): TranscriptSnapshot {
    const state = this.#states.get(key);
    const liveRecords = (state?.entries ?? []).flatMap((entry, index) => {
      if (entry.type !== 'item' || entry.completed) return [];
      return [
        {
          eventId: `live-transcript:${entry.id}`,
          item: structuredClone(entry),
          occurredAtMs: Date.now(),
          sequence: Number.MAX_SAFE_INTEGER - 1_000 + index,
          sessionId: state?.sessionId ?? 'live',
          type: 'transcript-item',
        },
      ];
    });
    return {
      entries: structuredClone(state?.entries ?? []),
      isLoaded: true,
      records: structuredClone([...(state?.records ?? []), ...liveRecords]),
    };
  }

  #restore(): void {
    const stored = this.#runtime.getGlobalState(HISTORY_STATE_KEY);
    if (!isRecord(stored)) return;
    for (const [key, value] of Object.entries(stored)) {
      if (!isRecord(value) || !Array.isArray(value.entries)) continue;
      const entries = value.entries.flatMap((entry): TranscriptEntry[] => {
        if (!isRecord(entry) || typeof entry.type !== 'string') return [];
        if (entry.type === 'session-divider' && typeof entry.id === 'string') {
          return [{ type: 'session-divider', id: entry.id }];
        }
        if (
          entry.type === 'item' &&
          typeof entry.completed === 'boolean' &&
          typeof entry.id === 'string' &&
          (entry.role === 'assistant' || entry.role === 'user') &&
          typeof entry.text === 'string'
        ) {
          return [
            {
              type: 'item',
              completed: entry.completed,
              id: entry.id,
              role: entry.role,
              text: entry.text,
            },
          ];
        }
        return [];
      });
      const records = Array.isArray(value.records)
        ? value.records.filter(isRecord).map((record) => structuredClone(record))
        : [];
      this.#states.set(key, {
        entries,
        records,
        sequence: finiteNonNegativeIntegerOr(
          value.sequence,
          records.reduce(
            (maximum, record) => Math.max(maximum, finiteNonNegativeIntegerOr(record.sequence, 0)),
            0,
          ),
        ),
        sessionId: optionalString(value.sessionId),
      });
    }
  }

  #persist(): void {
    const serialized = Object.fromEntries(
      [...this.#states].map(([key, state]) => [
        key,
        {
          entries: state.entries,
          records: state.records,
          sequence: state.sequence,
          sessionId: state.sessionId,
        },
      ]),
    );
    this.#persistQueue = this.#persistQueue
      .catch(() => undefined)
      .then(() => this.#runtime.setGlobalState(HISTORY_STATE_KEY, serialized));
  }

  #ensureSession(state: HistoryState): string {
    if (state.sessionId !== null) return state.sessionId;
    const sessionId = randomUUID();
    state.sessionId = sessionId;
    this.#appendRecord(state, {
      eventId: `session:${sessionId}:started`,
      occurredAtMs: Date.now(),
      sessionId,
      type: 'session-started',
    });
    return sessionId;
  }

  #appendRecord(state: HistoryState, record: Record<string, unknown>): void {
    if (
      typeof record.eventId !== 'string' ||
      state.records.some((existing) => existing.eventId === record.eventId)
    ) {
      return;
    }
    state.sequence += 1;
    state.records.push({ ...record, sequence: state.sequence });
  }

  #remove(entry: { key: string; listener: RemoteCallback }): void {
    if (!this.#listeners.delete(entry)) return;
    entry.listener[Symbol.dispose]?.();
  }
}

class RealtimeVoiceMultiAgentActivityCoordinator {
  readonly #activities = new Map<string, unknown[]>();
  readonly #sessions = new Map<string, string>();
  readonly #listeners = new Set<{
    hostId: string;
    key: string;
    listener: RemoteCallback;
  }>();

  subscribe(locator: RealtimeLocator, listenerValue: RemoteCallback): RpcSubscription {
    const listener = retainCallback(listenerValue);
    const key = locatorKey(locator);
    const entry = { hostId: locator.hostId, key, listener };
    this.#listeners.add(entry);
    listener.onRpcBroken?.(() => this.#remove(entry));
    invokeRemote(listener, {
      activities: structuredClone(this.#activities.get(key) ?? []),
    });
    return new RpcSubscription(() => this.#remove(entry));
  }

  observeNotification(notification: unknown): void {
    const parsed = notificationParts(notification);
    if (parsed === null) return;
    const threadId = optionalString(parsed.params.threadId);
    if (threadId === null) return;
    const locator = { hostId: 'local', conversationId: threadId };
    const key = locatorKey(locator);
    if (parsed.method === 'thread/realtime/started') {
      const sessionId =
        optionalString(parsed.params.realtimeSessionId) ??
        optionalString(parsed.params.sessionId) ??
        randomUUID();
      if (this.#sessions.get(key) !== sessionId) {
        this.#sessions.set(key, sessionId);
        this.#clear(locator);
      }
      return;
    }
    if (parsed.method === 'thread/realtime/closed' || parsed.method === 'thread/realtime/error') {
      this.#sessions.delete(key);
      this.#clear(locator);
      return;
    }
    if (parsed.method !== 'item/completed') return;
    const item = isRecord(parsed.params.item) ? parsed.params.item : null;
    if (item === null) return;
    const realtimeThread = this.#findRealtimeThread('local', threadId, item);
    if (realtimeThread === null) return;
    for (const activity of multiAgentActivitiesForItem(
      'local',
      item,
      realtimeThread,
      finiteNumberOr(parsed.params.completedAtMs, Date.now()),
    )) {
      this.#publish(activity);
    }
  }

  handleHostDisconnected(hostId: string): void {
    for (const key of this.#activities.keys()) {
      if (locatorFromKey(key)?.hostId === hostId) this.#activities.delete(key);
    }
    for (const key of this.#sessions.keys()) {
      if (locatorFromKey(key)?.hostId === hostId) this.#sessions.delete(key);
    }
    for (const entry of this.#listeners) {
      if (entry.hostId === hostId) invokeRemote(entry.listener, { activities: [] });
    }
  }

  #findRealtimeThread(
    hostId: string,
    currentThreadId: string,
    item: Record<string, unknown>,
  ): RealtimeLocator | null {
    const candidateThreadIds =
      item.type === 'subAgentActivity'
        ? [currentThreadId]
        : item.type === 'collabAgentToolCall'
          ? [
              currentThreadId,
              optionalString(item.senderThreadId),
              ...(Array.isArray(item.receiverThreadIds)
                ? item.receiverThreadIds.filter(
                    (value): value is string => typeof value === 'string',
                  )
                : []),
            ]
          : [];
    for (const candidate of candidateThreadIds) {
      if (candidate === null) continue;
      const locator = { hostId, conversationId: candidate };
      if (this.#sessions.has(locatorKey(locator))) return locator;
    }
    return null;
  }

  #publish(activity: Record<string, unknown>): void {
    const realtimeThread = activity.realtimeThread;
    if (!isRecord(realtimeThread)) return;
    const locator = parseLocator(realtimeThread);
    const key = locatorKey(locator);
    const existing = this.#activities.get(key) ?? [];
    const id = activity.id;
    if (typeof id !== 'string' || existing.some((value) => isRecord(value) && value.id === id)) {
      return;
    }
    const activities = [activity, ...existing].slice(0, 100);
    this.#activities.set(key, activities);
    const snapshot = { activities: structuredClone(activities) };
    for (const entry of this.#listeners) {
      if (entry.key === key) invokeRemote(entry.listener, snapshot);
    }
  }

  #clear(locator: RealtimeLocator): void {
    const key = locatorKey(locator);
    this.#activities.delete(key);
    for (const entry of this.#listeners) {
      if (entry.key === key) invokeRemote(entry.listener, { activities: [] });
    }
  }

  #remove(entry: { hostId: string; key: string; listener: RemoteCallback }): void {
    if (!this.#listeners.delete(entry)) return;
    entry.listener[Symbol.dispose]?.();
  }
}

interface PresentationState {
  locator: RealtimeLocator;
  surface: 'global-overlay' | 'main-thread';
  handoff: null;
}

interface PresentationSurface {
  eligible: boolean;
  locator: RealtimeLocator;
  showToast: RemoteCallback;
  surface: 'global-overlay' | 'main-thread';
}

class RealtimeVoicePresentationCoordinator {
  readonly #voice: RealtimeVoiceCoordinator;
  readonly #surfaces: PresentationSurface[] = [];
  readonly #listeners = new Set<RemoteCallback>();
  #active: PresentationState | null = null;
  #preferred: 'global-overlay' | 'main-thread' | null = null;

  constructor(voice: RealtimeVoiceCoordinator) {
    this.#voice = voice;
    voice.subscribe(((snapshot: RealtimeVoiceSnapshot) => {
      this.#reconcile(snapshot);
    }) as RemoteCallback);
  }

  getSnapshot(): { active: PresentationState | null } {
    return { active: this.#active === null ? null : structuredClone(this.#active) };
  }

  registerSurface(
    locator: RealtimeLocator,
    surface: 'global-overlay' | 'main-thread',
    eligible: boolean,
    showToastValue: RemoteCallback,
  ): RealtimePresentationSurfaceHandle {
    const showToast = retainCallback(showToastValue);
    const entry: PresentationSurface = { eligible, locator, showToast, surface };
    this.#surfaces.push(entry);
    showToast.onRpcBroken?.(() => this.#removeSurface(entry));
    this.#reconcile(this.#voice.getSnapshot());
    return new RealtimePresentationSurfaceHandle(
      () => undefined,
      (nextEligible) => {
        if (!this.#surfaces.includes(entry)) return;
        entry.eligible = nextEligible;
        this.#reconcile(this.#voice.getSnapshot());
      },
      () => undefined,
      () => this.#removeSurface(entry),
    );
  }

  async reportToast(locator: RealtimeLocator, toast: unknown): Promise<boolean> {
    const surface = findLastMatching(
      this.#surfaces,
      (entry) =>
        entry.eligible &&
        sameLocator(entry.locator, locator) &&
        entry.surface === this.#active?.surface,
    );
    if (surface === undefined) return false;
    try {
      await surface.showToast(toast);
      return true;
    } catch {
      return false;
    }
  }

  requestSurface(
    locator: RealtimeLocator,
    surface: 'global-overlay' | 'main-thread',
    motion: unknown,
  ): void {
    void motion;
    const voice = this.#voice.getSnapshot();
    if (voice.phase === 'inactive' || !sameLocator(voice.locator, locator)) return;
    this.#preferred = surface;
    this.#reconcile(voice);
  }

  subscribe(listenerValue: RemoteCallback): RpcSubscription {
    const listener = retainCallback(listenerValue);
    this.#listeners.add(listener);
    listener.onRpcBroken?.(() => this.#removeListener(listener));
    invokeRemote(listener, this.getSnapshot());
    return new RpcSubscription(() => this.#removeListener(listener));
  }

  #reconcile(voice: RealtimeVoiceSnapshot): void {
    if (voice.phase === 'inactive' || voice.locator === null) {
      this.#preferred = null;
      this.#setActive(null);
      return;
    }
    const preferred = this.#preferred ?? voice.preferredPresentationSurface ?? 'main-thread';
    const surface =
      findLastMatching(
        this.#surfaces,
        (entry) =>
          entry.eligible &&
          entry.surface === preferred &&
          sameLocator(entry.locator, voice.locator),
      ) ??
      findLastMatching(
        this.#surfaces,
        (entry) => entry.eligible && sameLocator(entry.locator, voice.locator),
      );
    if (surface === undefined) {
      this.#setActive(null);
      return;
    }
    this.#setActive({
      handoff: null,
      locator: surface.locator,
      surface: surface.surface,
    });
  }

  #setActive(active: PresentationState | null): void {
    if (
      (active === null && this.#active === null) ||
      (active !== null &&
        this.#active !== null &&
        active.surface === this.#active.surface &&
        sameLocator(active.locator, this.#active.locator))
    ) {
      return;
    }
    this.#active = active;
    const snapshot = this.getSnapshot();
    for (const listener of this.#listeners) invokeRemote(listener, snapshot);
  }

  #removeSurface(surface: PresentationSurface): void {
    const index = this.#surfaces.indexOf(surface);
    if (index === -1) return;
    this.#surfaces.splice(index, 1);
    surface.showToast[Symbol.dispose]?.();
    this.#reconcile(this.#voice.getSnapshot());
  }

  #removeListener(listener: RemoteCallback): void {
    if (!this.#listeners.delete(listener)) return;
    listener[Symbol.dispose]?.();
  }
}

export class RealtimePresentationSurfaceHandle extends RpcTarget {
  #updateAnchor: ((anchor: unknown) => void) | null;
  #updateEligibility: ((eligible: boolean) => void) | null;
  #updatePresentationOffset: ((offset: unknown) => void) | null;
  #unregister: (() => void) | null;

  constructor(
    updateAnchor: (anchor: unknown) => void,
    updateEligibility: (eligible: boolean) => void,
    updatePresentationOffset: (offset: unknown) => void,
    unregister: () => void,
  ) {
    super();
    this.#updateAnchor = updateAnchor;
    this.#updateEligibility = updateEligibility;
    this.#updatePresentationOffset = updatePresentationOffset;
    this.#unregister = unregister;
  }

  updateAnchor(anchor: unknown): void {
    this.#updateAnchor?.(anchor);
  }

  updateEligibility(eligible: unknown): void {
    if (typeof eligible !== 'boolean') {
      throw new TypeError('Realtime presentation eligibility must be boolean');
    }
    this.#updateEligibility?.(eligible);
  }

  updatePresentationOffset(offset: unknown): void {
    this.#updatePresentationOffset?.(offset);
  }

  unregister(): void {
    this.#unregister?.();
    this.#updateAnchor = null;
    this.#updateEligibility = null;
    this.#updatePresentationOffset = null;
    this.#unregister = null;
  }

  [Symbol.dispose](): void {
    this.unregister();
  }
}

async function readContinuityState(codexHome: string): Promise<{
  version: 1;
  threads: Record<string, { items: Array<{ role: 'assistant' | 'user'; text: string }> }>;
}> {
  try {
    const value = JSON.parse(await readFile(continuityPath(codexHome), 'utf8')) as unknown;
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.threads)) {
      throw new Error('Invalid continuity state');
    }
    const threads: Record<string, { items: Array<{ role: 'assistant' | 'user'; text: string }> }> =
      {};
    for (const [threadId, threadValue] of Object.entries(value.threads)) {
      if (!isRecord(threadValue) || !Array.isArray(threadValue.items)) continue;
      threads[threadId] = {
        items: threadValue.items.flatMap((item) => {
          if (
            !isRecord(item) ||
            (item.role !== 'assistant' && item.role !== 'user') ||
            typeof item.text !== 'string'
          ) {
            return [];
          }
          return [{ role: item.role, text: item.text }];
        }),
      };
    }
    return { version: 1, threads };
  } catch {
    return { version: 1, threads: {} };
  }
}

function continuityPath(codexHome: string): string {
  return join(codexHome, CONTINUITY_FILE_NAME);
}

function parsePublishedVoiceSnapshot(
  value: unknown,
): Omit<RealtimeVoiceSnapshot, 'locator' | 'sessionId'> {
  const snapshot = requestRecord(value, 'realtime voice snapshot');
  const phase = snapshot.phase;
  if (phase !== 'inactive' && phase !== 'starting' && phase !== 'active' && phase !== 'stopping') {
    throw new TypeError('Invalid realtime voice phase');
  }
  if (
    typeof snapshot.activity !== 'string' ||
    typeof snapshot.microphoneMuted !== 'boolean' ||
    typeof snapshot.outputMuted !== 'boolean'
  ) {
    throw new TypeError('Invalid realtime voice snapshot');
  }
  return {
    activity: snapshot.activity,
    microphoneMuted: snapshot.microphoneMuted,
    outputMuted: snapshot.outputMuted,
    phase,
    preferredPresentationSurface:
      snapshot.preferredPresentationSurface === null ||
      snapshot.preferredPresentationSurface === undefined
        ? null
        : presentationSurface(snapshot.preferredPresentationSurface),
  };
}

function parseVoiceControl(value: unknown): VoiceControl {
  const control = requestRecord(value, 'realtime voice control');
  switch (control.type) {
    case 'stop':
    case 'terminate':
    case 'simulate-usage-limit-approaching-for-debug':
    case 'toggle-microphone-mute':
    case 'toggle-output-mute':
      return { type: control.type };
    case 'set-microphone-muted':
    case 'set-output-muted':
      if (typeof control.muted !== 'boolean') throw new TypeError('Invalid mute control');
      return { type: control.type, muted: control.muted };
    case 'record-real-delegation':
      return { type: control.type, delegation: control.delegation };
    default:
      throw new TypeError('Invalid realtime voice control');
  }
}

function parseLocator(value: unknown): RealtimeLocator {
  const locator = requestRecord(value, 'realtime locator');
  return {
    hostId: requestStringValue(locator.hostId, 'hostId'),
    conversationId: requestStringValue(locator.conversationId, 'conversationId'),
  };
}

function presentationSurface(value: unknown): 'global-overlay' | 'main-thread' {
  if (value !== 'global-overlay' && value !== 'main-thread') {
    throw new TypeError('Invalid realtime presentation surface');
  }
  return value;
}

function transcriptRole(value: unknown): 'assistant' | 'user' {
  const role = optionalTranscriptRole(value);
  if (role === null) throw new TypeError('Invalid realtime transcript role');
  return role;
}

function optionalTranscriptRole(value: unknown): 'assistant' | 'user' | null {
  return value === 'user'
    ? 'user'
    : value === 'assistant' || value === 'model'
      ? 'assistant'
      : null;
}

function notificationParts(
  value: unknown,
): { method: string; params: Record<string, unknown> } | null {
  if (!isRecord(value) || typeof value.method !== 'string' || !isRecord(value.params)) {
    return null;
  }
  return { method: value.method, params: value.params };
}

function remoteCallback(value: unknown, label: string): RemoteCallback {
  if (typeof value !== 'function') throw new TypeError(`${label} must be callable`);
  return value as RemoteCallback;
}

function remoteVoiceController(value: unknown): RemoteVoiceController {
  if (
    (typeof value !== 'object' && typeof value !== 'function') ||
    value === null ||
    typeof (value as { control?: unknown }).control !== 'function'
  ) {
    throw new TypeError('realtime voice controller must expose control');
  }
  return value as RemoteVoiceController;
}

function retainCallback(callback: RemoteCallback): RemoteCallback {
  return callback.dup?.() ?? callback;
}

function retainVoiceController(controller: RemoteVoiceController): RemoteVoiceController {
  return controller.dup?.() ?? controller;
}

function invokeRemote(callback: RemoteCallback, ...args: unknown[]): unknown {
  try {
    return callback(...args);
  } catch {
    return undefined;
  }
}

function invokeVoiceControl(controller: RemoteVoiceController, control: VoiceControl): void {
  void callVoiceControl(controller, control).catch(() => undefined);
}

function callVoiceControl(
  controller: RemoteVoiceController,
  control: VoiceControl,
): Promise<unknown> {
  try {
    return Promise.resolve(controller.control(control));
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

function requestRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} request is invalid`);
  return value;
}

function requestString(value: unknown, label: string): string {
  const result = requestStringValue(value, label);
  if (result.length === 0) throw new TypeError(`${label} is invalid`);
  return result;
}

function requestStringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} is invalid`);
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function locatorKey(locator: RealtimeLocator): string {
  return JSON.stringify([locator.hostId, locator.conversationId]);
}

function locatorFromKey(key: string): RealtimeLocator | null {
  try {
    const value = JSON.parse(key) as unknown;
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === 'string' &&
      typeof value[1] === 'string'
    ) {
      return { hostId: value[0], conversationId: value[1] };
    }
  } catch {
    return null;
  }
  return null;
}

function multiAgentActivitiesForItem(
  hostId: string,
  item: Record<string, unknown>,
  realtimeThread: RealtimeLocator,
  occurredAtMs: number,
): Array<Record<string, unknown>> {
  if (item.type === 'subAgentActivity') {
    const id = optionalString(item.id);
    const agentThreadId = optionalString(item.agentThreadId);
    const kind = optionalString(item.kind);
    if (
      id === null ||
      agentThreadId === null ||
      (kind !== 'started' && kind !== 'interacted' && kind !== 'interrupted')
    ) {
      return [];
    }
    const task = { hostId, threadId: agentThreadId };
    return kind === 'started'
      ? [
          {
            id: `thread-created:${hostId}:${agentThreadId}`,
            kind: 'thread-created',
            occurredAtMs,
            prompt: null,
            realtimeThread,
            task,
            taskTitle: null,
          },
        ]
      : [
          {
            direction: 'from-task',
            id: `thread-message:${hostId}:${agentThreadId}:${id}`,
            kind: 'thread-message',
            message: null,
            occurredAtMs,
            realtimeThread,
            task,
            taskStatus: kind === 'interacted' ? 'running' : 'interrupted',
            taskTitle: null,
          },
        ];
  }
  if (item.type !== 'collabAgentToolCall') return [];
  const id = optionalString(item.id);
  const senderThreadId = optionalString(item.senderThreadId);
  const tool = optionalString(item.tool);
  const status = optionalString(item.status);
  const receivers = Array.isArray(item.receiverThreadIds)
    ? item.receiverThreadIds.filter((value): value is string => typeof value === 'string')
    : [];
  if (id === null || senderThreadId === null || tool === null || status === null) {
    return [];
  }
  const prompt = optionalString(item.prompt);
  const agentsStates = isRecord(item.agentsStates) ? item.agentsStates : {};
  const realtimeThreadId = realtimeThread.conversationId;
  if (tool === 'spawnAgent' && status === 'completed' && senderThreadId === realtimeThreadId) {
    return receivers.map((threadId) => ({
      id: `thread-created:${hostId}:${threadId}`,
      kind: 'thread-created',
      occurredAtMs,
      prompt,
      realtimeThread,
      task: { hostId, threadId },
      taskTitle: null,
    }));
  }
  if (tool === 'wait' && senderThreadId === realtimeThreadId) {
    return receivers.map((threadId) => {
      const agentState = isRecord(agentsStates[threadId]) ? agentsStates[threadId] : {};
      return {
        direction: 'from-task',
        id: `thread-message:${hostId}:${threadId}:${id}`,
        kind: 'thread-message',
        message: optionalString(agentState.message),
        occurredAtMs,
        realtimeThread,
        task: { hostId, threadId },
        taskStatus:
          multiAgentTaskStatus(agentState.status) ?? (status === 'failed' ? 'failed' : null),
        taskTitle: null,
      };
    });
  }
  if (status !== 'completed' || tool !== 'sendInput') return [];
  if (senderThreadId === realtimeThreadId) {
    return receivers.map((threadId) => {
      const agentState = isRecord(agentsStates[threadId]) ? agentsStates[threadId] : {};
      return {
        direction: 'to-task',
        id: `thread-message:${hostId}:${threadId}:${id}`,
        kind: 'thread-message',
        message: prompt,
        occurredAtMs,
        realtimeThread,
        task: { hostId, threadId },
        taskStatus: multiAgentTaskStatus(agentState.status),
        taskTitle: null,
      };
    });
  }
  return receivers.includes(realtimeThreadId)
    ? [
        {
          direction: 'from-task',
          id: `thread-message:${hostId}:${senderThreadId}:${id}`,
          kind: 'thread-message',
          message: prompt,
          occurredAtMs,
          realtimeThread,
          task: { hostId, threadId: senderThreadId },
          taskStatus: null,
          taskTitle: null,
        },
      ]
    : [];
}

function multiAgentTaskStatus(value: unknown): string | null {
  switch (value) {
    case 'pendingInit':
      return 'pending';
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'interrupted':
      return 'interrupted';
    case 'errored':
      return 'failed';
    case 'shutdown':
      return 'stopped';
    case 'notFound':
      return 'not-found';
    default:
      return null;
  }
}

function finiteNumberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function finiteNonNegativeIntegerOr(value: unknown, fallback: number): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    Number.isFinite(value) &&
    value >= 0
    ? value
    : fallback;
}

function findLastMatching<T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
): T | undefined {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value !== undefined && predicate(value)) return value;
  }
  return undefined;
}

function sameLocator(left: RealtimeLocator | null, right: RealtimeLocator | null): boolean {
  return (
    left !== null &&
    right !== null &&
    left.hostId === right.hostId &&
    left.conversationId === right.conversationId
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
