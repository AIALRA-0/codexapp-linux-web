import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { RpcTarget } from 'capnweb';
import { decodeUpdateV2, mergeUpdatesV2 } from 'yjs';

import type { UserRuntime } from './runtime.js';

const OFFICIAL_MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const OFFICIAL_COMPACTION_BYTES_THRESHOLD = 8 * 1024 * 1024;
const OFFICIAL_COMPACTION_UPDATE_COUNT_THRESHOLD = 128;
const OFFICIAL_COMMIT_RETENTION = 512;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const STAGED_FILE_PATTERN = /^\.artifact-document-materialize-[a-f0-9-]{36}$/u;

type ArtifactKind = 'presentation' | 'spreadsheet';
type ArtifactUpdateSource = 'model' | 'user';

interface ArtifactFileContext {
  publicFileHash: string;
  publicFilePath: string;
}

interface ArtifactUpdate {
  bytes: Uint8Array;
  originId: string;
  source: ArtifactUpdateSource;
  stateVersion: number;
  updateId: string;
}

interface ArtifactDocumentSnapshot {
  checkpoint: Uint8Array;
  checkpointStateVersion: number;
  documentId: string;
  kind: ArtifactKind;
  materializedStateVersion: number;
  publicFileHash: string;
  publicFilePath: string;
  stateVersion: number;
  updates: ArtifactUpdate[];
}

interface StoredArtifactUpdate {
  bytesBase64: string;
  originId: string;
  source: ArtifactUpdateSource;
  stateVersion: number;
  updateId: string;
}

interface StoredArtifactCommit {
  bytesHash: string;
  originId: string;
  source: ArtifactUpdateSource;
  stateVersion: number;
  updateId: string;
}

interface StoredArtifactMaterialization {
  materializationId: string;
  publicFileHash: string;
  stateVersion: number;
}

interface StoredPendingMaterialization extends StoredArtifactMaterialization {
  stagedFileName: string;
}

interface StoredArtifactDocument {
  adoptedCheckpointHash: string;
  checkpointBase64: string;
  checkpointStateVersion: number;
  commits: StoredArtifactCommit[];
  documentId: string;
  kind: ArtifactKind;
  materializations?: StoredArtifactMaterialization[] | undefined;
  materializedStateVersion: number;
  pendingMaterialization?: StoredPendingMaterialization | null | undefined;
  publicFileHash: string;
  publicFilePath: string;
  recordHash: string;
  schemaVersion: 1;
  stateVersion: number;
  updates: StoredArtifactUpdate[];
}

type ArtifactFailureReason = 'corrupt' | 'persistence';

type StoreResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'failed'; reason: ArtifactFailureReason }
  | {
      status: 'conflict';
      actualPublicFileHash: string;
      expectedPublicFileHash: string;
    };

interface ArtifactListener {
  (event: unknown): unknown;
  dup?: () => ArtifactListener;
  onRpcBroken?: (callback: () => void) => void;
  [Symbol.dispose]?: () => void;
}

interface BaseArtifactRequest {
  publicFilePath: string;
  workspaceRoot: string;
}

interface IdentifiedArtifactRequest extends BaseArtifactRequest {
  documentId: string;
}

interface AdoptArtifactRequest extends IdentifiedArtifactRequest {
  checkpoint: Uint8Array;
  kind: ArtifactKind;
  publicFileHash: string;
}

interface AppendArtifactRequest extends IdentifiedArtifactRequest {
  baseStateVersion: number;
  bytes: Uint8Array;
  originId: string;
  source: ArtifactUpdateSource;
  updateId: string;
}

interface MaterializeArtifactRequest extends IdentifiedArtifactRequest {
  expectedStateVersion: number;
  materializationId: string;
  publicFileBytes: Uint8Array;
}

/**
 * The official artifact-document AppHost protocol. The renderer is unchanged;
 * this service preserves the desktop record format, optimistic versioning,
 * Yjs-v2 validation/compaction, conflict semantics, and atomic file commits.
 */
export class ArtifactDocumentsService extends RpcTarget {
  readonly #runtime: UserRuntime;
  readonly #store: ArtifactDocumentStore;
  readonly #listenersByPath = new Map<string, Set<ArtifactListener>>();
  readonly #operationsByPath = new Map<string, Promise<void>>();

  constructor(runtime: UserRuntime) {
    super();
    this.#runtime = runtime;
    this.#store = new ArtifactDocumentStore({
      directory: join(runtime.root, 'artifact-documents'),
    });
  }

  async find(request: unknown): Promise<StoreResult<ArtifactDocumentSnapshot | null>> {
    const params = parseBaseRequest(request);
    const context = await this.#resolveContext(params);
    return this.#runOperation(params, context.publicFilePath, (current) =>
      this.#store.find(current),
    );
  }

  async adopt(request: unknown): Promise<StoreResult<ArtifactDocumentSnapshot>> {
    const params = parseAdoptRequest(request);
    const context = await this.#resolveContext(params);
    return this.#runOperation(params, context.publicFilePath, async (current) => {
      if (params.publicFileHash !== current.publicFileHash) {
        throw new Error('Public artifact file hash does not match');
      }
      return this.#store.adopt({
        ...current,
        checkpoint: params.checkpoint,
        documentId: params.documentId,
        kind: params.kind,
      });
    });
  }

  async read(request: unknown): Promise<StoreResult<ArtifactDocumentSnapshot>> {
    const params = parseIdentifiedRequest(request);
    const context = await this.#resolveContext(params);
    return this.#runOperation(params, context.publicFilePath, (current) =>
      this.#store.read({ ...current, documentId: params.documentId }),
    );
  }

  async append(
    request: unknown,
  ): Promise<
    StoreResult<
      | { applied: boolean; stateVersion: number }
      | { outcome: 'expired-retry'; earliestRetainedStateVersion: number; stateVersion: number }
    >
  > {
    const params = parseAppendRequest(request);
    const path = await this.#resolvePath(params);
    return this.#runOperation(params, path, async (current) => {
      const result = await this.#store.append({
        ...current,
        baseStateVersion: params.baseStateVersion,
        bytes: params.bytes,
        documentId: params.documentId,
        originId: params.originId,
        source: params.source,
        updateId: params.updateId,
      });
      if (result.status !== 'ok' || 'outcome' in result.value) return result;
      if (result.value.applied) {
        this.#notify(current.publicFilePath, {
          checkpointStateVersion: result.value.record.checkpointStateVersion,
          committedUpdate: result.value.committedUpdate,
          documentId: result.value.record.documentId,
          materializedStateVersion: result.value.record.materializedStateVersion,
          stateVersion: result.value.record.stateVersion,
        });
      }
      return {
        status: 'ok',
        value: {
          applied: result.value.applied,
          stateVersion: result.value.stateVersion,
        },
      };
    });
  }

  async materialize(request: unknown): Promise<
    StoreResult<
      | {
          applied: boolean;
          materializedStateVersion: number;
          outcome: 'materialized';
          publicFileHash: string;
          stateVersion: number;
        }
      | { outcome: 'stale'; stateVersion: number }
      | { outcome: 'too-large'; maxBytes: number }
    >
  > {
    const params = parseMaterializeRequest(request);
    const context = await this.#resolveContext(params);
    if (params.publicFileBytes.byteLength > OFFICIAL_MAX_ARTIFACT_BYTES) {
      return {
        status: 'ok',
        value: { maxBytes: OFFICIAL_MAX_ARTIFACT_BYTES, outcome: 'too-large' },
      };
    }
    const bytes = new Uint8Array(params.publicFileBytes);
    const intendedPublicFileHash = sha256(bytes);
    return this.#runOperation(params, context.publicFilePath, async (current) => {
      const stagedFileName = `.artifact-document-materialize-${randomUUID()}`;
      const prepared = await this.#store.beginMaterialization({
        ...current,
        documentId: params.documentId,
        expectedStateVersion: params.expectedStateVersion,
        intendedPublicFileHash,
        materializationId: params.materializationId,
        stagedFileName,
      });
      if (prepared.status !== 'ok') return prepared;
      if (prepared.value.outcome === 'materialized') {
        return {
          status: 'ok',
          value: materializedOutcome(prepared.value.record, prepared.value.applied),
        };
      }
      if (prepared.value.outcome === 'stale') {
        return {
          status: 'ok',
          value: { outcome: 'stale', stateVersion: prepared.value.record.stateVersion },
        };
      }
      const committed = await commitPublicFile({
        bytes,
        expectedPublicFileHash: current.publicFileHash,
        publicFilePath: current.publicFilePath,
        stagedFileName,
      });
      if (committed.status === 'conflict') {
        return {
          status: 'conflict',
          actualPublicFileHash: committed.actualPublicFileHash,
          expectedPublicFileHash: current.publicFileHash,
        };
      }
      if (committed.status === 'failed') {
        return { status: 'failed', reason: 'persistence' };
      }
      let actualHash: string;
      try {
        actualHash = await hashFile(current.publicFilePath);
      } catch {
        return { status: 'failed', reason: 'persistence' };
      }
      if (actualHash !== intendedPublicFileHash) {
        return {
          status: 'conflict',
          actualPublicFileHash: actualHash,
          expectedPublicFileHash: intendedPublicFileHash,
        };
      }
      const finished = await this.#store.finishMaterialization({
        documentId: params.documentId,
        materializationId: params.materializationId,
        publicFileHash: intendedPublicFileHash,
        publicFilePath: current.publicFilePath,
      });
      return finished.status === 'ok'
        ? {
            status: 'ok',
            value: materializedOutcome(finished.value.record, finished.value.applied),
          }
        : finished;
    });
  }

  async subscribe(
    request: unknown,
    listener: ArtifactListener,
  ): Promise<
    StoreResult<{ record: ArtifactDocumentSnapshot; subscription: ArtifactSubscription }>
  > {
    const params = parseIdentifiedRequest(request);
    const context = await this.#resolveContext(params);
    return this.#runOperation(params, context.publicFilePath, async (current) => {
      const result = await this.#store.read({ ...current, documentId: params.documentId });
      if (result.status !== 'ok') return result;
      return {
        status: 'ok',
        value: {
          record: result.value,
          subscription: this.#addListener(current.publicFilePath, listener),
        },
      };
    });
  }

  async #runOperation<T>(
    request: BaseArtifactRequest,
    expectedPath: string,
    operation: (context: ArtifactFileContext) => Promise<T>,
  ): Promise<T> {
    return this.#serialize(expectedPath, async () => {
      const current = await this.#resolveContext(request);
      if (current.publicFilePath !== expectedPath) {
        throw new Error('Artifact file path changed during the operation');
      }
      await this.#cleanupPendingMaterialization(current);
      return operation(current);
    });
  }

  async #cleanupPendingMaterialization(context: ArtifactFileContext): Promise<void> {
    const pending = await this.#store.getPendingMaterialization(context);
    if (pending.status !== 'ok' || pending.value === null) return;
    await unlink(join(dirname(context.publicFilePath), pending.value.stagedFileName)).catch(
      (error: unknown) => {
        if (errorCode(error) !== 'ENOENT') throw error;
      },
    );
  }

  async #resolveContext(request: BaseArtifactRequest): Promise<ArtifactFileContext> {
    const path = await this.#resolvePath(request);
    return { publicFileHash: await hashFile(path), publicFilePath: path };
  }

  async #resolvePath(request: BaseArtifactRequest): Promise<string> {
    const workspaceRoot = await realpath(request.workspaceRoot);
    const allowedRoots = await Promise.all(
      this.#allowedWorkspaceRoots().map(async (root) => {
        try {
          return await realpath(root);
        } catch {
          return null;
        }
      }),
    );
    if (!allowedRoots.includes(workspaceRoot)) {
      throw new Error('Artifact workspace root is not authorized');
    }
    if (!(await stat(workspaceRoot)).isDirectory()) {
      throw new Error('Artifact workspace root must be a directory');
    }
    const path = await realpath(request.publicFilePath);
    if (!pathIsWithin(path, workspaceRoot)) {
      throw new Error('Artifact file must stay within its workspace root');
    }
    if (!(await stat(path)).isFile()) {
      throw new Error('Artifact path must identify a regular file');
    }
    return path;
  }

  #allowedWorkspaceRoots(): string[] {
    const roots = new Set([this.#runtime.workspaceRoot]);
    const localProjects = this.#runtime.getGlobalState('local-projects');
    if (Array.isArray(localProjects)) {
      for (const project of localProjects) {
        if (!isRecord(project)) continue;
        for (const key of ['root', 'path', 'cwd']) {
          const candidate = project[key];
          if (typeof candidate === 'string' && isAbsolute(candidate)) roots.add(candidate);
        }
      }
    }
    const snapshot = this.#runtime.threadCatalog.readSnapshot() as unknown;
    if (isRecord(snapshot) && Array.isArray(snapshot.entries)) {
      for (const entry of snapshot.entries) {
        if (
          isRecord(entry) &&
          (entry.hostId === undefined || entry.hostId === 'local') &&
          typeof entry.cwd === 'string' &&
          isAbsolute(entry.cwd)
        ) {
          roots.add(entry.cwd);
        }
      }
    }
    return [...roots];
  }

  #addListener(path: string, listener: ArtifactListener): ArtifactSubscription {
    const retained = listener.dup?.() ?? listener;
    const listeners = this.#listenersByPath.get(path) ?? new Set<ArtifactListener>();
    listeners.add(retained);
    this.#listenersByPath.set(path, listeners);
    let subscribed = true;
    const unsubscribe = () => {
      if (!subscribed) return;
      subscribed = false;
      listeners.delete(retained);
      retained[Symbol.dispose]?.();
      if (listeners.size === 0) this.#listenersByPath.delete(path);
    };
    retained.onRpcBroken?.(unsubscribe);
    return new ArtifactSubscription(unsubscribe);
  }

  #notify(path: string, event: unknown): void {
    for (const listener of this.#listenersByPath.get(path) ?? []) {
      try {
        const result = listener(structuredClone(event));
        if (isDisposable(result)) result[Symbol.dispose]();
      } catch {
        // The official service treats listener failures as isolated RPC failures.
      }
    }
  }

  async #serialize<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const pending = (this.#operationsByPath.get(path) ?? Promise.resolve()).then(operation);
    const settled = pending.then(
      () => undefined,
      () => undefined,
    );
    this.#operationsByPath.set(path, settled);
    try {
      return await pending;
    } finally {
      if (this.#operationsByPath.get(path) === settled) this.#operationsByPath.delete(path);
    }
  }
}

export class ArtifactSubscription extends RpcTarget {
  #unsubscribeOnce: (() => void) | null;

  constructor(unsubscribe: () => void) {
    super();
    this.#unsubscribeOnce = unsubscribe;
  }

  unsubscribe(): void {
    this.#unsubscribeOnce?.();
    this.#unsubscribeOnce = null;
  }

  [Symbol.dispose](): void {
    this.unsubscribe();
  }
}

class ArtifactDocumentStore {
  static readonly #operations = new Map<string, Promise<void>>();
  static readonly #syncedDirectories = new Set<string>();
  static readonly #failedPaths = new Set<string>();

  readonly #directory: string;
  readonly #compactionUpdateBytesThreshold: number;
  readonly #compactionUpdateCountThreshold: number;

  constructor(options: {
    directory: string;
    compactionUpdateBytesThreshold?: number;
    compactionUpdateCountThreshold?: number;
  }) {
    this.#directory = options.directory;
    this.#compactionUpdateBytesThreshold =
      options.compactionUpdateBytesThreshold ?? OFFICIAL_COMPACTION_BYTES_THRESHOLD;
    this.#compactionUpdateCountThreshold =
      options.compactionUpdateCountThreshold ?? OFFICIAL_COMPACTION_UPDATE_COUNT_THRESHOLD;
    if (
      !Number.isFinite(this.#compactionUpdateBytesThreshold) ||
      this.#compactionUpdateBytesThreshold <= 0 ||
      !Number.isInteger(this.#compactionUpdateCountThreshold) ||
      this.#compactionUpdateCountThreshold <= 0
    ) {
      throw new Error('Artifact document compaction thresholds must be positive');
    }
  }

  find(context: ArtifactFileContext): Promise<StoreResult<ArtifactDocumentSnapshot | null>> {
    const recordPath = this.#recordPath(context.publicFilePath);
    return this.#serialize(recordPath, async () => {
      const loaded = await this.#load(recordPath);
      if (loaded.status === 'missing') return { status: 'ok', value: null };
      if (loaded.status !== 'ok') return { status: 'failed', reason: loaded.status };
      const reconciled = await this.#reconcilePending(
        recordPath,
        loaded.value,
        context.publicFileHash,
      );
      if (reconciled.status !== 'ok') return reconciled;
      if (reconciled.value.publicFilePath !== context.publicFilePath) {
        return { status: 'failed', reason: 'corrupt' };
      }
      if (reconciled.value.publicFileHash !== context.publicFileHash) {
        return conflict(reconciled.value, context.publicFileHash);
      }
      return { status: 'ok', value: toSnapshot(reconciled.value) };
    });
  }

  adopt(
    request: ArtifactFileContext & {
      checkpoint: Uint8Array;
      documentId: string;
      kind: ArtifactKind;
    },
  ): Promise<StoreResult<ArtifactDocumentSnapshot>> {
    const checkpoint = new Uint8Array(request.checkpoint);
    const checkpointHash = sha256(checkpoint);
    const recordPath = this.#recordPath(request.publicFilePath);
    return this.#serialize(recordPath, async () => {
      const loaded = await this.#load(recordPath);
      if (loaded.status === 'corrupt' || loaded.status === 'persistence') {
        return { status: 'failed', reason: loaded.status };
      }
      if (loaded.status === 'ok') {
        const reconciled = await this.#reconcilePending(
          recordPath,
          loaded.value,
          request.publicFileHash,
        );
        if (reconciled.status !== 'ok') return reconciled;
        if (reconciled.value.publicFilePath !== request.publicFilePath) {
          return { status: 'failed', reason: 'corrupt' };
        }
        if (reconciled.value.publicFileHash !== request.publicFileHash) {
          return conflict(reconciled.value, request.publicFileHash);
        }
        if (reconciled.value.documentId !== request.documentId) {
          throw new Error('Artifact document ID collision');
        }
        if (reconciled.value.kind !== request.kind) {
          throw new Error('Artifact document kind collision');
        }
        if (reconciled.value.adoptedCheckpointHash !== checkpointHash) {
          throw new Error('Artifact document checkpoint collision');
        }
        return { status: 'ok', value: toSnapshot(reconciled.value) };
      }
      validateYjsUpdate(checkpoint, 'checkpoint');
      const record = withRecordHash({
        adoptedCheckpointHash: checkpointHash,
        checkpointBase64: bytesToBase64(checkpoint),
        checkpointStateVersion: 0,
        commits: [],
        documentId: request.documentId,
        kind: request.kind,
        materializations: [],
        materializedStateVersion: 0,
        pendingMaterialization: null,
        publicFileHash: request.publicFileHash,
        publicFilePath: request.publicFilePath,
        recordHash: '',
        schemaVersion: 1,
        stateVersion: 0,
        updates: [],
      });
      return (await this.#persist(recordPath, record))
        ? { status: 'ok', value: toSnapshot(record) }
        : { status: 'failed', reason: 'persistence' };
    });
  }

  read(
    request: ArtifactFileContext & { documentId: string },
  ): Promise<StoreResult<ArtifactDocumentSnapshot>> {
    const recordPath = this.#recordPath(request.publicFilePath);
    return this.#serialize(recordPath, async () => {
      const loaded = await this.#load(recordPath);
      if (loaded.status === 'missing') throw new Error('Artifact document does not exist');
      if (loaded.status !== 'ok') return { status: 'failed', reason: loaded.status };
      const reconciled = await this.#reconcilePending(
        recordPath,
        loaded.value,
        request.publicFileHash,
      );
      if (reconciled.status !== 'ok') return reconciled;
      if (reconciled.value.publicFilePath !== request.publicFilePath) {
        return { status: 'failed', reason: 'corrupt' };
      }
      if (reconciled.value.publicFileHash !== request.publicFileHash) {
        return conflict(reconciled.value, request.publicFileHash);
      }
      requireDocumentId(reconciled.value, request.documentId);
      return { status: 'ok', value: toSnapshot(reconciled.value) };
    });
  }

  append(
    request: ArtifactFileContext & {
      baseStateVersion: number;
      bytes: Uint8Array;
      documentId: string;
      originId: string;
      source: ArtifactUpdateSource;
      updateId: string;
    },
  ): Promise<
    StoreResult<
      | {
          applied: boolean;
          committedUpdate?: ArtifactUpdate;
          record: ArtifactDocumentSnapshot;
          stateVersion: number;
        }
      | { earliestRetainedStateVersion: number; outcome: 'expired-retry'; stateVersion: number }
    >
  > {
    const bytes = new Uint8Array(request.bytes);
    const bytesHash = sha256(bytes);
    const recordPath = this.#recordPath(request.publicFilePath);
    return this.#serialize(recordPath, async () => {
      const loaded = await this.#load(recordPath);
      if (loaded.status === 'missing') throw new Error('Artifact document does not exist');
      if (loaded.status !== 'ok') return { status: 'failed', reason: loaded.status };
      const reconciled = await this.#reconcilePending(
        recordPath,
        loaded.value,
        request.publicFileHash,
      );
      if (reconciled.status !== 'ok') return reconciled;
      const record = reconciled.value;
      if (record.publicFilePath !== request.publicFilePath) {
        return { status: 'failed', reason: 'corrupt' };
      }
      if (record.publicFileHash !== request.publicFileHash) {
        return conflict(record, request.publicFileHash);
      }
      requireDocumentId(record, request.documentId);
      const existing = record.commits.find((commit) => commit.updateId === request.updateId);
      if (existing !== undefined) {
        if (
          existing.bytesHash !== bytesHash ||
          existing.originId !== request.originId ||
          existing.source !== request.source
        ) {
          throw new Error('Artifact document update ID collision');
        }
        return {
          status: 'ok',
          value: {
            applied: false,
            record: toSnapshot(record),
            stateVersion: existing.stateVersion,
          },
        };
      }
      const earliestRetainedStateVersion =
        record.commits[0]?.stateVersion ?? record.stateVersion + 1;
      if (request.baseStateVersion < earliestRetainedStateVersion - 1) {
        return {
          status: 'ok',
          value: {
            earliestRetainedStateVersion,
            outcome: 'expired-retry',
            stateVersion: record.stateVersion,
          },
        };
      }
      validateYjsUpdate(bytes, 'update');
      const stateVersion = record.stateVersion + 1;
      const committedUpdate: ArtifactUpdate = {
        bytes,
        originId: request.originId,
        source: request.source,
        stateVersion,
        updateId: request.updateId,
      };
      let next = {
        ...record,
        commits: [
          ...record.commits,
          {
            bytesHash,
            originId: request.originId,
            source: request.source,
            stateVersion,
            updateId: request.updateId,
          },
        ].slice(-OFFICIAL_COMMIT_RETENTION),
        stateVersion,
        updates: [
          ...record.updates,
          {
            bytesBase64: bytesToBase64(bytes),
            originId: request.originId,
            source: request.source,
            stateVersion,
            updateId: request.updateId,
          },
        ],
      };
      if (this.#shouldCompact(next.updates)) {
        const merged = mergeUpdatesV2([
          base64ToBytes(next.checkpointBase64),
          ...next.updates.map((update) => base64ToBytes(update.bytesBase64)),
        ]);
        next = {
          ...next,
          checkpointBase64: bytesToBase64(merged),
          checkpointStateVersion: stateVersion,
          updates: [],
        };
      }
      const persisted = withRecordHash(next);
      return (await this.#persist(recordPath, persisted))
        ? {
            status: 'ok',
            value: {
              applied: true,
              committedUpdate,
              record: toSnapshot(persisted),
              stateVersion,
            },
          }
        : { status: 'failed', reason: 'persistence' };
    });
  }

  getPendingMaterialization(
    request: ArtifactFileContext,
  ): Promise<StoreResult<{ stagedFileName: string } | null>> {
    const recordPath = this.#recordPath(request.publicFilePath);
    return this.#serialize(recordPath, async () => {
      const loaded = await this.#load(recordPath);
      if (loaded.status === 'missing') return { status: 'ok', value: null };
      if (loaded.status !== 'ok') return { status: 'failed', reason: loaded.status };
      if (loaded.value.publicFilePath !== request.publicFilePath) {
        return { status: 'failed', reason: 'corrupt' };
      }
      const pending = loaded.value.pendingMaterialization;
      return {
        status: 'ok',
        value:
          pending === null || pending === undefined
            ? null
            : {
                stagedFileName: pending.stagedFileName,
              },
      };
    });
  }

  beginMaterialization(
    request: ArtifactFileContext & {
      documentId: string;
      expectedStateVersion: number;
      intendedPublicFileHash: string;
      materializationId: string;
      stagedFileName: string;
    },
  ): Promise<
    StoreResult<
      | { applied: boolean; outcome: 'materialized'; record: ArtifactDocumentSnapshot }
      | { outcome: 'stale'; record: ArtifactDocumentSnapshot }
      | { outcome: 'prepared' }
    >
  > {
    const recordPath = this.#recordPath(request.publicFilePath);
    return this.#serialize(recordPath, async () => {
      const loaded = await this.#load(recordPath);
      if (loaded.status === 'missing') throw new Error('Artifact document does not exist');
      if (loaded.status !== 'ok') return { status: 'failed', reason: loaded.status };
      const reconciled = await this.#reconcilePending(
        recordPath,
        loaded.value,
        request.publicFileHash,
      );
      if (reconciled.status !== 'ok') return reconciled;
      const record = reconciled.value;
      if (record.publicFilePath !== request.publicFilePath) {
        return { status: 'failed', reason: 'corrupt' };
      }
      if (record.publicFileHash !== request.publicFileHash) {
        return conflict(record, request.publicFileHash);
      }
      requireDocumentId(record, request.documentId);
      const materializations = record.materializations ?? [];
      const existing = materializations.find(
        (entry) => entry.materializationId === request.materializationId,
      );
      if (existing !== undefined) {
        if (
          existing.publicFileHash !== request.intendedPublicFileHash ||
          existing.stateVersion !== request.expectedStateVersion
        ) {
          throw new Error('Artifact document materialization ID collision');
        }
        return {
          status: 'ok',
          value: { applied: false, outcome: 'materialized', record: toSnapshot(record) },
        };
      }
      if (
        record.stateVersion !== request.expectedStateVersion ||
        materializations.some((entry) => entry.stateVersion === request.expectedStateVersion)
      ) {
        return {
          status: 'ok',
          value: { outcome: 'stale', record: toSnapshot(record) },
        };
      }
      const materialization: StoredArtifactMaterialization = {
        materializationId: request.materializationId,
        publicFileHash: request.intendedPublicFileHash,
        stateVersion: request.expectedStateVersion,
      };
      if (request.intendedPublicFileHash === record.publicFileHash) {
        const materialized = applyMaterialization(record, materialization);
        return (await this.#persist(recordPath, materialized))
          ? {
              status: 'ok',
              value: {
                applied: true,
                outcome: 'materialized',
                record: toSnapshot(materialized),
              },
            }
          : { status: 'failed', reason: 'persistence' };
      }
      const prepared = withRecordHash({
        ...record,
        pendingMaterialization: {
          ...materialization,
          stagedFileName: request.stagedFileName,
        },
      });
      return (await this.#persist(recordPath, prepared))
        ? { status: 'ok', value: { outcome: 'prepared' } }
        : { status: 'failed', reason: 'persistence' };
    });
  }

  finishMaterialization(
    request: ArtifactFileContext & { documentId: string; materializationId: string },
  ): Promise<
    StoreResult<{ applied: boolean; outcome: 'materialized'; record: ArtifactDocumentSnapshot }>
  > {
    const recordPath = this.#recordPath(request.publicFilePath);
    return this.#serialize(recordPath, async () => {
      const loaded = await this.#load(recordPath);
      if (loaded.status === 'missing') throw new Error('Artifact document does not exist');
      if (loaded.status !== 'ok') return { status: 'failed', reason: loaded.status };
      const reconciled = await this.#reconcilePending(
        recordPath,
        loaded.value,
        request.publicFileHash,
      );
      if (reconciled.status !== 'ok') return reconciled;
      const record = reconciled.value;
      if (record.publicFilePath !== request.publicFilePath) {
        return { status: 'failed', reason: 'corrupt' };
      }
      if (record.publicFileHash !== request.publicFileHash) {
        return conflict(record, request.publicFileHash);
      }
      requireDocumentId(record, request.documentId);
      if (
        !(record.materializations ?? []).some(
          (entry) => entry.materializationId === request.materializationId,
        )
      ) {
        throw new Error('Artifact document materialization does not exist');
      }
      return {
        status: 'ok',
        value: { applied: true, outcome: 'materialized', record: toSnapshot(record) },
      };
    });
  }

  #recordPath(publicFilePath: string): string {
    return join(this.#directory, `${sha256(publicFilePath)}.json`);
  }

  #shouldCompact(updates: StoredArtifactUpdate[]): boolean {
    return (
      updates.length >= this.#compactionUpdateCountThreshold ||
      updates.reduce((total, update) => total + base64ToBytes(update.bytesBase64).byteLength, 0) >=
        this.#compactionUpdateBytesThreshold
    );
  }

  async #serialize<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const pending = (ArtifactDocumentStore.#operations.get(path) ?? Promise.resolve()).then(
      operation,
    );
    const settled = pending.then(
      () => undefined,
      () => undefined,
    );
    ArtifactDocumentStore.#operations.set(path, settled);
    try {
      return await pending;
    } finally {
      if (ArtifactDocumentStore.#operations.get(path) === settled) {
        ArtifactDocumentStore.#operations.delete(path);
      }
    }
  }

  async #load(
    path: string,
  ): Promise<
    | { status: 'ok'; value: StoredArtifactDocument }
    | { status: 'missing' | 'corrupt' | 'persistence' }
  > {
    if (ArtifactDocumentStore.#failedPaths.has(path)) return { status: 'persistence' };
    let contents: string;
    try {
      contents = await readFile(path, 'utf8');
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') return { status: 'persistence' };
      return (await hasTemporaryRecord(path)) ? { status: 'persistence' } : { status: 'missing' };
    }
    try {
      const record = parseStoredRecord(JSON.parse(contents));
      return recordIntegrityIsValid(record)
        ? { status: 'ok', value: record }
        : { status: 'corrupt' };
    } catch {
      return { status: 'corrupt' };
    }
  }

  async #reconcilePending(
    path: string,
    record: StoredArtifactDocument,
    publicFileHash: string,
  ): Promise<StoreResult<StoredArtifactDocument>> {
    const pending = record.pendingMaterialization;
    if (pending === null || pending === undefined) return { status: 'ok', value: record };
    if (publicFileHash === pending.publicFileHash) {
      const materialized = applyMaterialization(record, pending);
      return (await this.#persist(path, materialized))
        ? { status: 'ok', value: materialized }
        : { status: 'failed', reason: 'persistence' };
    }
    if (publicFileHash === record.publicFileHash) {
      const cleared = withRecordHash({ ...record, pendingMaterialization: null });
      return (await this.#persist(path, cleared))
        ? { status: 'ok', value: cleared }
        : { status: 'failed', reason: 'persistence' };
    }
    return conflict(record, publicFileHash);
  }

  async #persist(path: string, record: StoredArtifactDocument): Promise<boolean> {
    const directory = dirname(path);
    const temporaryPath = join(directory, `.${basename(path)}.tmp-${randomUUID()}`);
    let directoryHandle: Awaited<ReturnType<typeof open>> | undefined;
    let temporaryHandle: Awaited<ReturnType<typeof open>> | undefined;
    let renamed = false;
    try {
      let created = false;
      try {
        await mkdir(directory, { mode: 0o700 });
        created = true;
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
      }
      if (created) ArtifactDocumentStore.#syncedDirectories.delete(directory);
      if (
        process.platform !== 'win32' &&
        !ArtifactDocumentStore.#syncedDirectories.has(directory)
      ) {
        directoryHandle = await open(dirname(directory), 'r');
        await directoryHandle.sync();
        await directoryHandle.close();
        directoryHandle = undefined;
        ArtifactDocumentStore.#syncedDirectories.add(directory);
      }
      temporaryHandle = await open(temporaryPath, 'wx', 0o600);
      await temporaryHandle.writeFile(JSON.stringify(record));
      await temporaryHandle.sync();
      await temporaryHandle.close();
      temporaryHandle = undefined;
      if (process.platform !== 'win32') directoryHandle = await open(directory, 'r');
      await rename(temporaryPath, path);
      renamed = true;
      await directoryHandle?.sync();
      return true;
    } catch {
      if (renamed) ArtifactDocumentStore.#failedPaths.add(path);
      return false;
    } finally {
      await temporaryHandle?.close().catch(() => undefined);
      await directoryHandle?.close().catch(() => undefined);
      if (!renamed) await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

function parseBaseRequest(value: unknown): BaseArtifactRequest {
  const request = strictRecord(value, ['publicFilePath', 'workspaceRoot'], 'artifact document');
  return {
    publicFilePath: absolutePath(request.publicFilePath, 'publicFilePath'),
    workspaceRoot: absolutePath(request.workspaceRoot, 'workspaceRoot'),
  };
}

function parseIdentifiedRequest(value: unknown): IdentifiedArtifactRequest {
  const request = strictRecord(
    value,
    ['documentId', 'publicFilePath', 'workspaceRoot'],
    'artifact document',
  );
  return {
    documentId: nonEmptyString(request.documentId, 'documentId'),
    publicFilePath: absolutePath(request.publicFilePath, 'publicFilePath'),
    workspaceRoot: absolutePath(request.workspaceRoot, 'workspaceRoot'),
  };
}

function parseAdoptRequest(value: unknown): AdoptArtifactRequest {
  const request = strictRecord(
    value,
    ['checkpoint', 'documentId', 'kind', 'publicFileHash', 'publicFilePath', 'workspaceRoot'],
    'artifact adoption',
  );
  const publicFileHash = nonEmptyString(request.publicFileHash, 'publicFileHash');
  if (!SHA256_PATTERN.test(publicFileHash)) throw new Error('Invalid publicFileHash');
  return {
    checkpoint: requestBytes(request.checkpoint, 'checkpoint'),
    documentId: nonEmptyString(request.documentId, 'documentId'),
    kind: artifactKind(request.kind),
    publicFileHash,
    publicFilePath: absolutePath(request.publicFilePath, 'publicFilePath'),
    workspaceRoot: absolutePath(request.workspaceRoot, 'workspaceRoot'),
  };
}

function parseAppendRequest(value: unknown): AppendArtifactRequest {
  const request = strictRecord(
    value,
    [
      'baseStateVersion',
      'bytes',
      'documentId',
      'originId',
      'publicFilePath',
      'source',
      'updateId',
      'workspaceRoot',
    ],
    'artifact append',
  );
  return {
    baseStateVersion: nonNegativeInteger(request.baseStateVersion, 'baseStateVersion'),
    bytes: requestBytes(request.bytes, 'bytes'),
    documentId: nonEmptyString(request.documentId, 'documentId'),
    originId: nonEmptyString(request.originId, 'originId'),
    publicFilePath: absolutePath(request.publicFilePath, 'publicFilePath'),
    source: updateSource(request.source),
    updateId: nonEmptyString(request.updateId, 'updateId'),
    workspaceRoot: absolutePath(request.workspaceRoot, 'workspaceRoot'),
  };
}

function parseMaterializeRequest(value: unknown): MaterializeArtifactRequest {
  const request = strictRecord(
    value,
    [
      'documentId',
      'expectedStateVersion',
      'materializationId',
      'publicFileBytes',
      'publicFilePath',
      'workspaceRoot',
    ],
    'artifact materialization',
  );
  return {
    documentId: nonEmptyString(request.documentId, 'documentId'),
    expectedStateVersion: nonNegativeInteger(request.expectedStateVersion, 'expectedStateVersion'),
    materializationId: nonEmptyString(request.materializationId, 'materializationId'),
    publicFileBytes: requestBytes(request.publicFileBytes, 'publicFileBytes'),
    publicFilePath: absolutePath(request.publicFilePath, 'publicFilePath'),
    workspaceRoot: absolutePath(request.workspaceRoot, 'workspaceRoot'),
  };
}

function strictRecord(
  value: unknown,
  allowedKeys: string[],
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Invalid ${label} request`);
  const allowed = new Set(allowedKeys);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    allowedKeys.some((key) => !(key in value))
  ) {
    throw new Error(`Invalid ${label} request`);
  }
  return value;
}

function parseStoredRecord(value: unknown): StoredArtifactDocument {
  if (!isRecord(value)) throw new Error('Invalid artifact record');
  const requiredKeys = [
    'adoptedCheckpointHash',
    'checkpointBase64',
    'checkpointStateVersion',
    'commits',
    'documentId',
    'kind',
    'materializedStateVersion',
    'publicFileHash',
    'publicFilePath',
    'recordHash',
    'schemaVersion',
    'stateVersion',
    'updates',
  ];
  const allowedKeys = new Set([...requiredKeys, 'materializations', 'pendingMaterialization']);
  if (
    requiredKeys.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !allowedKeys.has(key))
  ) {
    throw new Error('Invalid artifact record');
  }
  const commits = arrayValue(value.commits, 'commits').map(parseStoredCommit);
  const updates = arrayValue(value.updates, 'updates').map(parseStoredUpdate);
  const materializations =
    value.materializations === undefined
      ? undefined
      : arrayValue(value.materializations, 'materializations').map(parseStoredMaterialization);
  const pendingMaterialization =
    value.pendingMaterialization === undefined
      ? undefined
      : value.pendingMaterialization === null
        ? null
        : parseStoredPendingMaterialization(value.pendingMaterialization);
  const checkpointBase64 = nonEmptyOrEmptyString(value.checkpointBase64, 'checkpointBase64');
  if (!BASE64_PATTERN.test(checkpointBase64)) throw new Error('Invalid checkpointBase64');
  const record: StoredArtifactDocument = {
    adoptedCheckpointHash: hashString(value.adoptedCheckpointHash, 'adoptedCheckpointHash'),
    checkpointBase64,
    checkpointStateVersion: nonNegativeInteger(
      value.checkpointStateVersion,
      'checkpointStateVersion',
    ),
    commits,
    documentId: nonEmptyString(value.documentId, 'documentId'),
    kind: artifactKind(value.kind),
    ...(materializations === undefined ? {} : { materializations }),
    materializedStateVersion: nonNegativeInteger(
      value.materializedStateVersion,
      'materializedStateVersion',
    ),
    ...(pendingMaterialization === undefined ? {} : { pendingMaterialization }),
    publicFileHash: hashString(value.publicFileHash, 'publicFileHash'),
    publicFilePath: nonEmptyString(value.publicFilePath, 'publicFilePath'),
    recordHash: hashString(value.recordHash, 'recordHash'),
    schemaVersion: literalOne(value.schemaVersion),
    stateVersion: nonNegativeInteger(value.stateVersion, 'stateVersion'),
    updates,
  };
  return record;
}

function parseStoredCommit(value: unknown): StoredArtifactCommit {
  const entry = strictRecord(
    value,
    ['bytesHash', 'originId', 'source', 'stateVersion', 'updateId'],
    'artifact commit',
  );
  return {
    bytesHash: hashString(entry.bytesHash, 'bytesHash'),
    originId: nonEmptyString(entry.originId, 'originId'),
    source: updateSource(entry.source),
    stateVersion: positiveInteger(entry.stateVersion, 'stateVersion'),
    updateId: nonEmptyString(entry.updateId, 'updateId'),
  };
}

function parseStoredUpdate(value: unknown): StoredArtifactUpdate {
  const entry = strictRecord(
    value,
    ['bytesBase64', 'originId', 'source', 'stateVersion', 'updateId'],
    'artifact update',
  );
  const bytesBase64 = nonEmptyOrEmptyString(entry.bytesBase64, 'bytesBase64');
  if (!BASE64_PATTERN.test(bytesBase64)) throw new Error('Invalid bytesBase64');
  return {
    bytesBase64,
    originId: nonEmptyString(entry.originId, 'originId'),
    source: updateSource(entry.source),
    stateVersion: positiveInteger(entry.stateVersion, 'stateVersion'),
    updateId: nonEmptyString(entry.updateId, 'updateId'),
  };
}

function parseStoredMaterialization(value: unknown): StoredArtifactMaterialization {
  const entry = strictRecord(
    value,
    ['materializationId', 'publicFileHash', 'stateVersion'],
    'artifact materialization',
  );
  return {
    materializationId: nonEmptyString(entry.materializationId, 'materializationId'),
    publicFileHash: hashString(entry.publicFileHash, 'publicFileHash'),
    stateVersion: nonNegativeInteger(entry.stateVersion, 'stateVersion'),
  };
}

function parseStoredPendingMaterialization(value: unknown): StoredPendingMaterialization {
  const entry = strictRecord(
    value,
    ['materializationId', 'publicFileHash', 'stagedFileName', 'stateVersion'],
    'pending artifact materialization',
  );
  const parsed = parseStoredMaterialization({
    materializationId: entry.materializationId,
    publicFileHash: entry.publicFileHash,
    stateVersion: entry.stateVersion,
  });
  const stagedFileName = nonEmptyString(entry.stagedFileName, 'stagedFileName');
  if (!STAGED_FILE_PATTERN.test(stagedFileName)) throw new Error('Invalid stagedFileName');
  return { ...parsed, stagedFileName };
}

function recordIntegrityIsValid(record: StoredArtifactDocument): boolean {
  if (
    record.recordHash !== recordHash(record) ||
    record.checkpointStateVersion > record.stateVersion ||
    record.materializedStateVersion > record.stateVersion ||
    record.commits.length > record.stateVersion ||
    (record.stateVersion > 0 && record.commits.length === 0) ||
    record.updates.length !== record.stateVersion - record.checkpointStateVersion
  ) {
    return false;
  }
  const firstCommitVersion = record.stateVersion - record.commits.length + 1;
  const updateIds = new Set<string>();
  for (const [index, commit] of record.commits.entries()) {
    if (commit.stateVersion !== firstCommitVersion + index || updateIds.has(commit.updateId)) {
      return false;
    }
    updateIds.add(commit.updateId);
  }
  const materializationIds = new Set<string>();
  let lastMaterializedVersion = -1;
  for (const materialization of record.materializations ?? []) {
    if (
      materialization.stateVersion <= lastMaterializedVersion ||
      materialization.stateVersion > record.stateVersion ||
      materializationIds.has(materialization.materializationId)
    ) {
      return false;
    }
    materializationIds.add(materialization.materializationId);
    lastMaterializedVersion = materialization.stateVersion;
  }
  if (
    record.materializedStateVersion !== Math.max(lastMaterializedVersion, 0) ||
    (record.pendingMaterialization !== null &&
      record.pendingMaterialization !== undefined &&
      (record.pendingMaterialization.stateVersion !== record.stateVersion ||
        record.pendingMaterialization.stateVersion < record.materializedStateVersion ||
        record.pendingMaterialization.publicFileHash === record.publicFileHash ||
        materializationIds.has(record.pendingMaterialization.materializationId)))
  ) {
    return false;
  }
  return record.updates.every((update, index) => {
    const commit =
      update.stateVersion < firstCommitVersion
        ? undefined
        : record.commits[update.stateVersion - firstCommitVersion];
    return (
      update.stateVersion === record.checkpointStateVersion + index + 1 &&
      (commit === undefined ||
        (commit.bytesHash === sha256(base64ToBytes(update.bytesBase64)) &&
          commit.originId === update.originId &&
          commit.source === update.source &&
          commit.updateId === update.updateId))
    );
  });
}

function withRecordHash(record: StoredArtifactDocument): StoredArtifactDocument {
  const canonical = canonicalRecord(record);
  return { ...canonical, recordHash: recordHash(canonical) };
}

function canonicalRecord(record: StoredArtifactDocument): StoredArtifactDocument {
  return {
    adoptedCheckpointHash: record.adoptedCheckpointHash,
    checkpointBase64: record.checkpointBase64,
    checkpointStateVersion: record.checkpointStateVersion,
    commits: record.commits,
    documentId: record.documentId,
    kind: record.kind,
    materializations: record.materializations,
    materializedStateVersion: record.materializedStateVersion,
    pendingMaterialization: record.pendingMaterialization,
    publicFileHash: record.publicFileHash,
    publicFilePath: record.publicFilePath,
    recordHash: record.recordHash,
    schemaVersion: record.schemaVersion,
    stateVersion: record.stateVersion,
    updates: record.updates,
  };
}

function recordHash(record: StoredArtifactDocument): string {
  return sha256(JSON.stringify({ ...canonicalRecord(record), recordHash: '' }));
}

function applyMaterialization(
  record: StoredArtifactDocument,
  materialization: StoredArtifactMaterialization,
): StoredArtifactDocument {
  const entry = {
    materializationId: materialization.materializationId,
    publicFileHash: materialization.publicFileHash,
    stateVersion: materialization.stateVersion,
  };
  return withRecordHash({
    ...record,
    materializations: [...(record.materializations ?? []), entry],
    materializedStateVersion: entry.stateVersion,
    pendingMaterialization: null,
    publicFileHash: entry.publicFileHash,
  });
}

function toSnapshot(record: StoredArtifactDocument): ArtifactDocumentSnapshot {
  return {
    checkpoint: base64ToBytes(record.checkpointBase64),
    checkpointStateVersion: record.checkpointStateVersion,
    documentId: record.documentId,
    kind: record.kind,
    materializedStateVersion: record.materializedStateVersion,
    publicFileHash: record.publicFileHash,
    publicFilePath: record.publicFilePath,
    stateVersion: record.stateVersion,
    updates: record.updates.map((update) => ({
      bytes: base64ToBytes(update.bytesBase64),
      originId: update.originId,
      source: update.source,
      stateVersion: update.stateVersion,
      updateId: update.updateId,
    })),
  };
}

function materializedOutcome(
  record: ArtifactDocumentSnapshot,
  applied: boolean,
): {
  applied: boolean;
  materializedStateVersion: number;
  outcome: 'materialized';
  publicFileHash: string;
  stateVersion: number;
} {
  return {
    applied,
    materializedStateVersion: record.materializedStateVersion,
    outcome: 'materialized',
    publicFileHash: record.publicFileHash,
    stateVersion: record.stateVersion,
  };
}

async function commitPublicFile(options: {
  bytes: Uint8Array;
  expectedPublicFileHash: string;
  publicFilePath: string;
  stagedFileName: string;
}): Promise<
  | { status: 'committed' }
  | { status: 'conflict'; actualPublicFileHash: string }
  | { status: 'failed' }
> {
  const fileStats = await stat(options.publicFilePath);
  if (!fileStats.isFile()) throw new Error('Artifact path must identify a regular file');
  const mode = fileStats.mode % 4096;
  const stagedPath = join(dirname(options.publicFilePath), options.stagedFileName);
  let stagedHandle: Awaited<ReturnType<typeof open>> | undefined;
  let directoryHandle: Awaited<ReturnType<typeof open>> | undefined;
  let committed = false;
  try {
    stagedHandle = await open(stagedPath, 'wx', mode);
    await stagedHandle.writeFile(options.bytes);
    if (process.platform !== 'win32') await stagedHandle.chmod(mode);
    await stagedHandle.sync();
    await stagedHandle.close();
    stagedHandle = undefined;
    if (!(await stat(options.publicFilePath)).isFile()) {
      throw new Error('Artifact path must identify a regular file');
    }
    const actualPublicFileHash = await hashFile(options.publicFilePath);
    if (actualPublicFileHash !== options.expectedPublicFileHash) {
      return { status: 'conflict', actualPublicFileHash };
    }
    if (process.platform !== 'win32') {
      directoryHandle = await open(dirname(options.publicFilePath), 'r');
    }
    await rename(stagedPath, options.publicFilePath);
    committed = true;
    await directoryHandle?.sync();
    return { status: 'committed' };
  } catch {
    return { status: 'failed' };
  } finally {
    await stagedHandle?.close().catch(() => undefined);
    await directoryHandle?.close().catch(() => undefined);
    if (!committed) await unlink(stagedPath).catch(() => undefined);
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function hasTemporaryRecord(path: string): Promise<boolean> {
  try {
    const prefix = `.${basename(path)}.tmp-`;
    return (await readdir(dirname(path))).some((entry) => entry.startsWith(prefix));
  } catch (error) {
    return errorCode(error) !== 'ENOENT';
  }
}

function conflict(
  record: StoredArtifactDocument,
  actualPublicFileHash: string,
): {
  status: 'conflict';
  actualPublicFileHash: string;
  expectedPublicFileHash: string;
} {
  return {
    actualPublicFileHash,
    expectedPublicFileHash: record.publicFileHash,
    status: 'conflict',
  };
}

function validateYjsUpdate(bytes: Uint8Array, label: string): void {
  try {
    decodeUpdateV2(bytes);
  } catch {
    throw new Error(`Artifact document ${label} must be a valid Yjs v2 update`);
  }
}

function requireDocumentId(record: StoredArtifactDocument, documentId: string): void {
  if (record.documentId !== documentId) throw new Error('Artifact document ID mismatch');
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function base64ToBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function pathIsWithin(path: string, root: string): boolean {
  const candidate = relative(root, path);
  return (
    candidate !== '..' && !candidate.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  );
}

function requestBytes(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error(`Invalid ${label}`);
  return new Uint8Array(value);
}

function absolutePath(value: unknown, label: string): string {
  const path = nonEmptyString(value, label);
  if (!isAbsolute(path)) throw new Error(`Expected an absolute local path`);
  return path;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid ${label}`);
  return value;
}

function nonEmptyOrEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid ${label}`);
  return value;
}

function hashString(value: unknown, label: string): string {
  const hash = nonEmptyString(value, label);
  if (!SHA256_PATTERN.test(hash)) throw new Error(`Invalid ${label}`);
  return hash;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const integer = nonNegativeInteger(value, label);
  if (integer === 0) throw new Error(`Invalid ${label}`);
  return integer;
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function artifactKind(value: unknown): ArtifactKind {
  if (value !== 'presentation' && value !== 'spreadsheet') {
    throw new Error('Invalid artifact kind');
  }
  return value;
}

function updateSource(value: unknown): ArtifactUpdateSource {
  if (value !== 'model' && value !== 'user') throw new Error('Invalid artifact update source');
  return value;
}

function literalOne(value: unknown): 1 {
  if (value !== 1) throw new Error('Invalid artifact schema version');
  return 1;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? String((error as Error & { code?: unknown }).code)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDisposable(value: unknown): value is { [Symbol.dispose](): void } {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    Symbol.dispose in value &&
    typeof (value as { [Symbol.dispose]?: unknown })[Symbol.dispose] === 'function'
  );
}
