import { describe, expect, it, vi } from 'vitest';

import {
  deleteAllArchivedThreads,
  deleteArchivedThread,
  type AppServerRequester,
} from './archived-thread-operations.js';

describe('archived thread desktop operations', () => {
  it('deletes one archived thread through the official app-server', async () => {
    const request = vi.fn().mockResolvedValue({});

    await expect(deleteArchivedThread({ request }, 'thread-1')).resolves.toEqual({
      deletedThreadIds: ['thread-1'],
    });
    expect(request).toHaveBeenCalledWith('thread/delete', { threadId: 'thread-1' });
  });

  it('lists every archived page and deletes each distinct thread', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ id: 'thread-1' }, { id: 'thread-2' }],
        nextCursor: 'page-2',
      })
      .mockResolvedValueOnce({
        data: [{ id: 'thread-2' }, { threadId: 'thread-3' }],
        nextCursor: null,
      })
      .mockResolvedValue({});

    await expect(deleteAllArchivedThreads({ request })).resolves.toEqual({
      deletedThreadIds: ['thread-1', 'thread-2', 'thread-3'],
    });
    expect(request).toHaveBeenNthCalledWith(1, 'thread/list', {
      archived: true,
      cursor: null,
      limit: 100,
      sortKey: 'updated_at',
      sortDirection: 'desc',
    });
    expect(request).toHaveBeenNthCalledWith(2, 'thread/list', {
      archived: true,
      cursor: 'page-2',
      limit: 100,
      sortKey: 'updated_at',
      sortDirection: 'desc',
    });
    expect(request.mock.calls.slice(2)).toEqual([
      ['thread/delete', { threadId: 'thread-1' }],
      ['thread/delete', { threadId: 'thread-2' }],
      ['thread/delete', { threadId: 'thread-3' }],
    ]);
  });

  it('fails closed on an invalid archived thread list', async () => {
    const client: AppServerRequester = {
      request: vi.fn().mockResolvedValue({ data: [{ title: 'missing id' }] }),
    };

    await expect(deleteAllArchivedThreads(client)).rejects.toThrow(
      'archived thread list entry is invalid',
    );
  });
});
