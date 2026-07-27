import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Doc, encodeStateAsUpdateV2 } from 'yjs';
import { afterEach, describe, expect, it } from 'vitest';

import { ArtifactDocumentsService } from './artifact-documents.js';
import type { UserRuntime } from './runtime.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function createHarness(): Promise<{
  runtime: UserRuntime;
  workspaceRoot: string;
  root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'codex-artifact-documents-'));
  temporaryRoots.push(root);
  const workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  const runtime = {
    root,
    workspaceRoot,
    getGlobalState: () => undefined,
    threadCatalog: {
      readSnapshot: () => ({ entries: [] }),
    },
  } as unknown as UserRuntime;
  return { runtime, workspaceRoot, root };
}

function updateWithValue(key: string, value: string): Uint8Array {
  const document = new Doc();
  document.getMap('sheet').set(key, value);
  return encodeStateAsUpdateV2(document);
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('official artifact document service', () => {
  it('adopts, reads, appends, subscribes, and reloads the official durable record', async () => {
    const { runtime, workspaceRoot } = await createHarness();
    const publicFilePath = join(workspaceRoot, 'forecast.xlsx');
    await writeFile(publicFilePath, 'initial workbook');
    const checkpoint = encodeStateAsUpdateV2(new Doc());
    const service = new ArtifactDocumentsService(runtime);
    const base = { publicFilePath, workspaceRoot };

    await expect(
      service.adopt({
        ...base,
        checkpoint,
        documentId: 'document-1',
        kind: 'spreadsheet',
        publicFileHash: sha256('initial workbook'),
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      value: {
        checkpointStateVersion: 0,
        documentId: 'document-1',
        kind: 'spreadsheet',
        materializedStateVersion: 0,
        stateVersion: 0,
        updates: [],
      },
    });

    const events: unknown[] = [];
    const subscription = await service.subscribe({ ...base, documentId: 'document-1' }, (event) =>
      events.push(event),
    );
    expect(subscription.status).toBe('ok');

    const update = updateWithValue('A1', 'revenue');
    await expect(
      service.append({
        ...base,
        baseStateVersion: 0,
        bytes: update,
        documentId: 'document-1',
        originId: 'browser-tab-1',
        source: 'user',
        updateId: 'update-1',
      }),
    ).resolves.toEqual({
      status: 'ok',
      value: { applied: true, stateVersion: 1 },
    });
    await expect(
      service.append({
        ...base,
        baseStateVersion: 0,
        bytes: update,
        documentId: 'document-1',
        originId: 'browser-tab-1',
        source: 'user',
        updateId: 'update-1',
      }),
    ).resolves.toEqual({
      status: 'ok',
      value: { applied: false, stateVersion: 1 },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      checkpointStateVersion: 0,
      documentId: 'document-1',
      materializedStateVersion: 0,
      stateVersion: 1,
    });

    const reloaded = new ArtifactDocumentsService(runtime);
    await expect(reloaded.read({ ...base, documentId: 'document-1' })).resolves.toMatchObject({
      status: 'ok',
      value: {
        documentId: 'document-1',
        stateVersion: 1,
        updates: [
          {
            originId: 'browser-tab-1',
            source: 'user',
            stateVersion: 1,
            updateId: 'update-1',
          },
        ],
      },
    });
    if (subscription.status === 'ok') subscription.value.subscription.unsubscribe();
  });

  it('materializes with hash conflict protection and survives a server restart', async () => {
    const { runtime, workspaceRoot } = await createHarness();
    const publicFilePath = join(workspaceRoot, 'deck.pptx');
    await writeFile(publicFilePath, 'deck-v1');
    const checkpoint = updateWithValue('slide', 'one');
    const service = new ArtifactDocumentsService(runtime);
    const base = { publicFilePath, workspaceRoot };
    await service.adopt({
      ...base,
      checkpoint,
      documentId: 'deck-1',
      kind: 'presentation',
      publicFileHash: sha256('deck-v1'),
    });

    const nextBytes = new TextEncoder().encode('deck-v2');
    await expect(
      service.materialize({
        ...base,
        documentId: 'deck-1',
        expectedStateVersion: 0,
        materializationId: 'materialize-1',
        publicFileBytes: nextBytes,
      }),
    ).resolves.toEqual({
      status: 'ok',
      value: {
        applied: true,
        materializedStateVersion: 0,
        outcome: 'materialized',
        publicFileHash: sha256(nextBytes),
        stateVersion: 0,
      },
    });
    await expect(readFile(publicFilePath, 'utf8')).resolves.toBe('deck-v2');

    const reloaded = new ArtifactDocumentsService(runtime);
    await expect(reloaded.find(base)).resolves.toMatchObject({
      status: 'ok',
      value: {
        documentId: 'deck-1',
        publicFileHash: sha256(nextBytes),
      },
    });

    await writeFile(publicFilePath, 'changed outside Codex');
    await expect(reloaded.read({ ...base, documentId: 'deck-1' })).resolves.toEqual({
      status: 'conflict',
      actualPublicFileHash: sha256('changed outside Codex'),
      expectedPublicFileHash: sha256(nextBytes),
    });
  });

  it('rejects unauthorized roots, files outside the root, and invalid Yjs updates', async () => {
    const { runtime, workspaceRoot, root } = await createHarness();
    const publicFilePath = join(workspaceRoot, 'sheet.xlsx');
    const outsidePath = join(root, 'outside.xlsx');
    await Promise.all([writeFile(publicFilePath, 'sheet'), writeFile(outsidePath, 'outside')]);
    const service = new ArtifactDocumentsService(runtime);

    await expect(service.find({ publicFilePath, workspaceRoot: root })).rejects.toThrow(
      'Artifact workspace root is not authorized',
    );
    await expect(service.find({ publicFilePath: outsidePath, workspaceRoot })).rejects.toThrow(
      'Artifact file must stay within its workspace root',
    );
    await expect(
      service.adopt({
        checkpoint: new Uint8Array([1, 2, 3]),
        documentId: 'invalid',
        kind: 'spreadsheet',
        publicFileHash: sha256('sheet'),
        publicFilePath,
        workspaceRoot,
      }),
    ).rejects.toThrow('Artifact document checkpoint must be a valid Yjs v2 update');
  });
});
