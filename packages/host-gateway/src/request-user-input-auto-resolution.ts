import type {
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from '@codexapp/contracts';

const OFFICIAL_DEFAULT_COUNTDOWN_MS = 90_000;
const OFFICIAL_FOREGROUND_INACTIVITY_MS = 60_000;
const OFFICIAL_MIN_MCP_AUTO_RESOLUTION_MS = 5_000;
const OFFICIAL_MAX_MCP_AUTO_RESOLUTION_MS = 300_000;

type ResponseKind = 'decline-mcp-elicitation' | 'empty-user-input';

export type AutoResolutionState =
  | { status: 'waiting-for-inactivity' }
  | { status: 'scheduled'; deadlineMs: number }
  | { status: 'snoozed' };

export type AutoResolutionChange =
  | {
      kind: 'updated';
      conversationId: string;
      requestId: JsonRpcId;
      resolutionState: AutoResolutionState;
    }
  | {
      kind: 'removed';
      conversationId: string;
      requestId: JsonRpcId;
    }
  | {
      kind: 'timed-out';
      conversationId: string;
      requestId: JsonRpcId;
      timeoutMs: number;
    };

interface PendingRequest {
  autoResolutionMs: number | null;
  requestId: JsonRpcId;
  responseKind: ResponseKind;
  resolutionState: AutoResolutionState;
  timeoutId: NodeJS.Timeout | null;
}

export interface RequestUserInputAutoResolutionOptions {
  onAutoResolve: (response: JsonRpcResponse) => void;
  onStateChanged: (change: AutoResolutionChange) => void;
  defaultCountdownMs?: number;
  foregroundInactivityMs?: number;
}

export class RequestUserInputAutoResolution {
  readonly options: RequestUserInputAutoResolutionOptions;

  #pendingRequestByConversationId = new Map<string, PendingRequest>();
  #conversationIdByRequestId = new Map<JsonRpcId, string>();
  #presentingSurfaceIdsByConversationId = new Map<string, Set<string>>();
  #foregroundedSurfaceIds = new Set<string>();
  #defaultCountdownMs: number;
  #foregroundInactivityMs: number;

  constructor(options: RequestUserInputAutoResolutionOptions) {
    this.options = options;
    this.#defaultCountdownMs = options.defaultCountdownMs ?? OFFICIAL_DEFAULT_COUNTDOWN_MS;
    this.#foregroundInactivityMs =
      options.foregroundInactivityMs ?? OFFICIAL_FOREGROUND_INACTIVITY_MS;
  }

  observeServerRequest(request: JsonRpcRequest): void {
    const params = requestRecord(request.params);
    if (request.method === 'item/tool/requestUserInput') {
      const conversationId = requestString(params.threadId);
      if (conversationId !== null) {
        this.#trackRequest(conversationId, request.id, 'empty-user-input');
      }
      return;
    }
    if (request.method !== 'mcpServer/elicitation/request') return;
    const conversationId = requestString(params.threadId);
    const metadata = requestRecord(params._meta);
    const autoResolutionMs = metadata.autoResolutionMs;
    if (
      conversationId === null ||
      !Number.isInteger(autoResolutionMs) ||
      (autoResolutionMs as number) < OFFICIAL_MIN_MCP_AUTO_RESOLUTION_MS ||
      (autoResolutionMs as number) > OFFICIAL_MAX_MCP_AUTO_RESOLUTION_MS
    ) {
      return;
    }
    this.#trackRequest(
      conversationId,
      request.id,
      'decline-mcp-elicitation',
      autoResolutionMs as number,
    );
  }

  observeServerNotification(notification: JsonRpcNotification): void {
    if (notification.method !== 'serverRequest/resolved') return;
    const requestId = requestRecord(notification.params).requestId;
    if (
      typeof requestId === 'string' ||
      (typeof requestId === 'number' && Number.isInteger(requestId))
    ) {
      this.stopTrackingRequest(requestId);
    }
  }

  setConversationPresented(surfaceId: string, conversationId: string, presented: boolean): void {
    const current = this.#presentingSurfaceIdsByConversationId.get(conversationId);
    if (presented) {
      const surfaceIds = current ?? new Set<string>();
      if (surfaceIds.has(surfaceId)) return;
      surfaceIds.add(surfaceId);
      this.#presentingSurfaceIdsByConversationId.set(conversationId, surfaceIds);
      if (this.#foregroundedSurfaceIds.has(surfaceId)) {
        this.#restartInactivityForConversation(conversationId);
      }
      return;
    }
    if (current?.delete(surfaceId) !== true) return;
    if (current.size === 0) this.#presentingSurfaceIdsByConversationId.delete(conversationId);
    if (
      this.#foregroundedSurfaceIds.has(surfaceId) &&
      !this.#isConversationForegrounded(conversationId)
    ) {
      this.#startCountdownForWaitingRequest(conversationId);
    }
  }

  setSurfaceForegrounded(surfaceId: string, foregrounded: boolean): void {
    if (foregrounded === this.#foregroundedSurfaceIds.has(surfaceId)) return;
    if (foregrounded) {
      this.#foregroundedSurfaceIds.add(surfaceId);
      for (const [conversationId, surfaceIds] of this.#presentingSurfaceIdsByConversationId) {
        if (surfaceIds.has(surfaceId)) this.#restartInactivityForConversation(conversationId);
      }
      return;
    }
    this.#foregroundedSurfaceIds.delete(surfaceId);
    for (const [conversationId, surfaceIds] of this.#presentingSurfaceIdsByConversationId) {
      if (surfaceIds.has(surfaceId) && !this.#isConversationForegrounded(conversationId)) {
        this.#startCountdownForWaitingRequest(conversationId);
      }
    }
  }

  removeSurface(surfaceId: string): void {
    const wasForegrounded = this.#foregroundedSurfaceIds.delete(surfaceId);
    for (const [conversationId, surfaceIds] of this.#presentingSurfaceIdsByConversationId) {
      if (!surfaceIds.delete(surfaceId)) continue;
      if (surfaceIds.size === 0) {
        this.#presentingSurfaceIdsByConversationId.delete(conversationId);
      }
      if (wasForegrounded && !this.#isConversationForegrounded(conversationId)) {
        this.#startCountdownForWaitingRequest(conversationId);
      }
    }
  }

  recordConversationActivity(surfaceId: string, conversationId: string): void {
    const pending = this.#pendingRequestByConversationId.get(conversationId);
    if (
      pending?.resolutionState.status === 'waiting-for-inactivity' &&
      this.#foregroundedSurfaceIds.has(surfaceId) &&
      this.#presentingSurfaceIdsByConversationId.get(conversationId)?.has(surfaceId) === true
    ) {
      this.#restartInactivityForConversation(conversationId);
    }
  }

  snoozeRequest(conversationId: string, requestId: JsonRpcId): void {
    const pending = this.#pendingRequestByConversationId.get(conversationId);
    if (pending === undefined || pending.requestId !== requestId) return;
    if (pending.autoResolutionMs !== null) {
      this.#startCountdown(conversationId, pending, pending.autoResolutionMs);
      return;
    }
    this.#cancelPendingRequestDeadline(pending);
    pending.resolutionState = { status: 'snoozed' };
    this.#publishState(conversationId, pending);
  }

  stopTrackingRequest(requestId: JsonRpcId): void {
    const conversationId = this.#conversationIdByRequestId.get(requestId);
    if (conversationId !== undefined) this.#removePendingRequest(conversationId);
  }

  getPendingRequestSnapshots(): Array<{
    conversationId: string;
    requestId: JsonRpcId;
    resolutionState: AutoResolutionState;
  }> {
    return Array.from(
      this.#pendingRequestByConversationId.entries(),
      ([conversationId, value]) => ({
        conversationId,
        requestId: value.requestId,
        resolutionState: value.resolutionState,
      }),
    );
  }

  clearPendingRequests(): void {
    for (const conversationId of this.#pendingRequestByConversationId.keys()) {
      this.#removePendingRequest(conversationId);
    }
  }

  dispose(): void {
    for (const pending of this.#pendingRequestByConversationId.values()) {
      this.#cancelPendingRequestDeadline(pending);
    }
    this.#pendingRequestByConversationId.clear();
    this.#conversationIdByRequestId.clear();
    this.#presentingSurfaceIdsByConversationId.clear();
    this.#foregroundedSurfaceIds.clear();
  }

  #trackRequest(
    conversationId: string,
    requestId: JsonRpcId,
    responseKind: ResponseKind,
    autoResolutionMs?: number,
  ): void {
    this.#removePendingRequest(conversationId);
    const pending: PendingRequest = {
      autoResolutionMs: autoResolutionMs ?? null,
      requestId,
      responseKind,
      resolutionState: { status: 'waiting-for-inactivity' },
      timeoutId: null,
    };
    this.#pendingRequestByConversationId.set(conversationId, pending);
    this.#conversationIdByRequestId.set(requestId, conversationId);
    if (autoResolutionMs !== undefined) {
      this.#startCountdown(conversationId, pending, autoResolutionMs);
    } else if (this.#isConversationForegrounded(conversationId)) {
      this.#waitForInactivity(conversationId, pending);
    } else {
      this.#startCountdown(conversationId, pending, this.#defaultCountdownMs);
    }
  }

  #restartInactivityForConversation(conversationId: string): void {
    const pending = this.#pendingRequestByConversationId.get(conversationId);
    if (pending !== undefined && pending.resolutionState.status !== 'snoozed') {
      this.#waitForInactivity(conversationId, pending);
    }
  }

  #waitForInactivity(conversationId: string, pending: PendingRequest): void {
    pending.resolutionState = { status: 'waiting-for-inactivity' };
    this.#setPendingRequestTimeout(pending, this.#foregroundInactivityMs, () => {
      if (this.#pendingRequestByConversationId.get(conversationId) === pending) {
        this.#startCountdown(conversationId, pending, this.#defaultCountdownMs);
      }
    });
    this.#publishState(conversationId, pending);
  }

  #startCountdownForWaitingRequest(conversationId: string): void {
    const pending = this.#pendingRequestByConversationId.get(conversationId);
    if (pending?.resolutionState.status === 'waiting-for-inactivity') {
      this.#startCountdown(conversationId, pending, this.#defaultCountdownMs);
    }
  }

  #startCountdown(conversationId: string, pending: PendingRequest, timeoutMs: number): void {
    pending.resolutionState = { status: 'scheduled', deadlineMs: Date.now() + timeoutMs };
    this.#setPendingRequestTimeout(pending, timeoutMs, () => {
      this.options.onStateChanged({
        kind: 'timed-out',
        conversationId,
        requestId: pending.requestId,
        timeoutMs,
      });
      this.#removePendingRequest(conversationId);
      this.options.onAutoResolve(
        pending.responseKind === 'decline-mcp-elicitation'
          ? {
              id: pending.requestId,
              result: { action: 'decline', content: null, _meta: null },
            }
          : { id: pending.requestId, result: { answers: {} } },
      );
    });
    this.#publishState(conversationId, pending);
  }

  #setPendingRequestTimeout(
    pending: PendingRequest,
    timeoutMs: number,
    callback: () => void,
  ): void {
    this.#cancelPendingRequestDeadline(pending);
    const timeoutId = setTimeout(() => {
      if (pending.timeoutId !== timeoutId) return;
      pending.timeoutId = null;
      callback();
    }, timeoutMs);
    pending.timeoutId = timeoutId;
  }

  #removePendingRequest(conversationId: string): void {
    const pending = this.#pendingRequestByConversationId.get(conversationId);
    if (pending === undefined) return;
    this.#cancelPendingRequestDeadline(pending);
    this.#pendingRequestByConversationId.delete(conversationId);
    this.#conversationIdByRequestId.delete(pending.requestId);
    this.options.onStateChanged({
      kind: 'removed',
      conversationId,
      requestId: pending.requestId,
    });
  }

  #cancelPendingRequestDeadline(pending: PendingRequest): void {
    if (pending.timeoutId === null) return;
    clearTimeout(pending.timeoutId);
    pending.timeoutId = null;
  }

  #publishState(conversationId: string, pending: PendingRequest): void {
    this.options.onStateChanged({
      kind: 'updated',
      conversationId,
      requestId: pending.requestId,
      resolutionState: pending.resolutionState,
    });
  }

  #isConversationForegrounded(conversationId: string): boolean {
    const surfaceIds = this.#presentingSurfaceIdsByConversationId.get(conversationId);
    if (surfaceIds === undefined) return false;
    for (const surfaceId of surfaceIds) {
      if (this.#foregroundedSurfaceIds.has(surfaceId)) return true;
    }
    return false;
  }
}

function requestRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requestString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
