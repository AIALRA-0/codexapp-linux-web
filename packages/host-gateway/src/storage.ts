import { statfsSync } from 'node:fs';

export interface StorageHealth {
  ok: boolean;
  availableBytes: number;
  totalBytes: number;
  minimumFreeBytes: number;
}

export type ReadFilesystemStats = (
  path: string,
) => Pick<ReturnType<typeof statfsSync>, 'bavail' | 'blocks' | 'bsize'>;

export function readStorageHealth(
  path: string,
  minimumFreeBytes: number,
  readStats: ReadFilesystemStats = (target) => statfsSync(target),
): StorageHealth {
  const stats = readStats(path);
  const availableBytes = Number(stats.bavail) * Number(stats.bsize);
  const totalBytes = Number(stats.blocks) * Number(stats.bsize);
  return {
    ok: availableBytes >= minimumFreeBytes,
    availableBytes,
    totalBytes,
    minimumFreeBytes,
  };
}

export function methodCanGrowConversationState(method: string): boolean {
  return (
    method === 'turn/start' ||
    method === 'thread/start' ||
    method === 'thread/fork' ||
    method === 'thread/archive' ||
    method === 'thread/unarchive' ||
    method === 'thread/compact/start' ||
    method === 'thread/rollback' ||
    method === 'review/start'
  );
}

export function assertStorageAvailableForMethod(
  path: string,
  minimumFreeBytes: number,
  method: string,
): void {
  if (!methodCanGrowConversationState(method)) return;
  const health = readStorageHealth(path, minimumFreeBytes);
  if (!health.ok) {
    throw new Error(
      `server storage safety threshold reached; ${method} is temporarily blocked to protect conversation data`,
    );
  }
}
