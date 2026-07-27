import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';

import {
  assertStorageAvailableForMethod,
  methodCanGrowConversationState,
  readStorageHealth,
} from './storage.js';

describe('conversation storage safety threshold', () => {
  it('computes readiness from filesystem blocks without writing probe data', () => {
    const healthy = readStorageHealth('/state', 4_096, () => ({
      bavail: 2,
      blocks: 100,
      bsize: 4_096,
    }));
    expect(healthy).toEqual({
      ok: true,
      availableBytes: 8_192,
      totalBytes: 409_600,
      minimumFreeBytes: 4_096,
    });
    expect(
      readStorageHealth('/state', 8_193, () => ({ bavail: 2, blocks: 100, bsize: 4_096 })).ok,
    ).toBe(false);
  });

  it('classifies conversation-growing operations while keeping history reads available', () => {
    expect(methodCanGrowConversationState('turn/start')).toBe(true);
    expect(methodCanGrowConversationState('thread/fork')).toBe(true);
    expect(methodCanGrowConversationState('thread/archive')).toBe(true);
    expect(methodCanGrowConversationState('thread/list')).toBe(false);
    expect(methodCanGrowConversationState('thread/read')).toBe(false);
    expect(methodCanGrowConversationState('model/list')).toBe(false);
  });

  it('blocks a new turn below the threshold and does not block a history read', () => {
    expect(() =>
      assertStorageAvailableForMethod(tmpdir(), Number.MAX_SAFE_INTEGER, 'turn/start'),
    ).toThrow('storage safety threshold');
    expect(() =>
      assertStorageAvailableForMethod(tmpdir(), Number.MAX_SAFE_INTEGER, 'thread/read'),
    ).not.toThrow();
  });
});
