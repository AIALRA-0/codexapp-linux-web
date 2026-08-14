import type { CodexAppServerClient } from '@codexapp/app-server-client';

interface StartupThreadCandidate {
  threadId: string;
  cwd: string;
}

interface StartupThreadCatalog {
  readBootstrapSnapshot(limit: number): { entries: StartupThreadCandidate[] };
}

interface StartupThreadPrewarmerOptions {
  count: number;
  catalog: StartupThreadCatalog;
  resume: (
    threadId: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ) => Promise<boolean>;
  onComplete?: (details: { durationMs: number; threadId: string }) => void;
  onError?: (error: Error, details: { method: string; threadId: string }) => void;
  timeoutMs?: number;
}

export class StartupThreadPrewarmer {
  #count: number;
  #catalog: StartupThreadCatalog;
  #resume: StartupThreadPrewarmerOptions['resume'];
  #onComplete: NonNullable<StartupThreadPrewarmerOptions['onComplete']>;
  #onError: NonNullable<StartupThreadPrewarmerOptions['onError']>;
  #timeoutMs: number;
  #generation = 0;
  #pending = new Map<string, Promise<void>>();

  constructor(options: StartupThreadPrewarmerOptions) {
    this.#count = options.count;
    this.#catalog = options.catalog;
    this.#resume = options.resume;
    this.#onComplete = options.onComplete ?? (() => undefined);
    this.#onError = options.onError ?? (() => undefined);
    this.#timeoutMs = options.timeoutMs ?? 120_000;
  }

  schedule(client: CodexAppServerClient): void {
    this.clear();
    if (this.#count === 0) return;
    const generation = this.#generation;
    let candidates: StartupThreadCandidate[];
    try {
      candidates = this.#catalog.readBootstrapSnapshot(this.#count).entries.slice(0, this.#count);
    } catch (error) {
      this.#onError(asError(error), { method: 'catalog/read', threadId: '' });
      return;
    }
    for (const candidate of candidates) {
      const pending = this.#prewarm(client, candidate, generation);
      this.#pending.set(candidate.threadId, pending);
      void pending.finally(() => {
        if (this.#generation !== generation) return;
        if (this.#pending.get(candidate.threadId) === pending) {
          this.#pending.delete(candidate.threadId);
        }
      });
    }
  }

  async waitForThread(threadId: string): Promise<void> {
    await this.#pending.get(threadId);
  }

  clear(): void {
    this.#generation += 1;
    this.#pending.clear();
  }

  async #prewarm(
    client: CodexAppServerClient,
    candidate: StartupThreadCandidate,
    generation: number,
  ): Promise<void> {
    const startedAtMs = Date.now();
    try {
      const response = await client.request(
        'thread/read',
        { threadId: candidate.threadId, includeTurns: false },
        30_000,
      );
      if (this.#generation !== generation) return;
      const thread = recordOrNull(recordOrNull(response)?.thread);
      if (thread === null) throw new Error('thread/read returned no thread');
      if (recordOrNull(thread.status)?.type === 'active') return;
      const params = {
        threadId: candidate.threadId,
        history: null,
        path: stringOrNull(thread.path),
        cwd: stringOrNull(thread.cwd) ?? candidate.cwd,
        excludeTurns: true,
        initialTurnsPage: {
          limit: 5,
          itemsView: 'full',
          sortDirection: 'desc',
        },
      };
      const cached = await this.#resume(candidate.threadId, params, this.#timeoutMs);
      if (this.#generation !== generation) return;
      if (!cached) throw new Error('thread/resume result was not cached');
      this.#onComplete({ durationMs: Date.now() - startedAtMs, threadId: candidate.threadId });
    } catch (error) {
      if (this.#generation !== generation) return;
      this.#onError(asError(error), { method: 'thread/resume', threadId: candidate.threadId });
    }
  }
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error('startup thread prewarm failed');
}
