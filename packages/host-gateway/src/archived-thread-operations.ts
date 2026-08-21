export interface AppServerRequester {
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
}

interface ThreadListPage {
  ids: string[];
  nextCursor: string | null;
}

const ARCHIVED_THREAD_PAGE_SIZE = 100;
const MAX_ARCHIVED_THREADS = 50_000;

export async function deleteArchivedThread(
  client: AppServerRequester,
  threadId: string,
): Promise<{ deletedThreadIds: string[] }> {
  await client.request('thread/delete', { threadId });
  return { deletedThreadIds: [threadId] };
}

export async function deleteAllArchivedThreads(
  client: AppServerRequester,
): Promise<{ deletedThreadIds: string[] }> {
  const threadIds: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;

  do {
    const page = parseThreadListPage(
      await client.request('thread/list', {
        archived: true,
        cursor,
        limit: ARCHIVED_THREAD_PAGE_SIZE,
        sortKey: 'updated_at',
        sortDirection: 'desc',
      }),
    );
    for (const threadId of page.ids) {
      if (seen.has(threadId)) continue;
      seen.add(threadId);
      threadIds.push(threadId);
      if (threadIds.length > MAX_ARCHIVED_THREADS) {
        throw new Error('archived thread delete limit exceeded');
      }
    }
    cursor = page.nextCursor;
  } while (cursor !== null);

  const deletedThreadIds: string[] = [];
  for (const threadId of threadIds) {
    await client.request('thread/delete', { threadId });
    deletedThreadIds.push(threadId);
  }
  return { deletedThreadIds };
}

function parseThreadListPage(value: unknown): ThreadListPage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('archived thread list response is invalid');
  }
  const response = value as Record<string, unknown>;
  const rows = response.data ?? response.threads;
  if (!Array.isArray(rows)) throw new Error('archived thread list response is invalid');
  const ids = rows.map((row) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error('archived thread list entry is invalid');
    }
    const record = row as Record<string, unknown>;
    const threadId = record.id ?? record.threadId;
    if (typeof threadId !== 'string' || threadId.length === 0) {
      throw new Error('archived thread list entry is invalid');
    }
    return threadId;
  });
  const nextCursor = response.nextCursor;
  if (nextCursor !== undefined && nextCursor !== null && typeof nextCursor !== 'string') {
    throw new Error('archived thread list cursor is invalid');
  }
  return { ids, nextCursor: nextCursor ?? null };
}
