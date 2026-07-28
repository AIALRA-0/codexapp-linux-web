import { copyFile, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const STATE_VERSION = 1;

export type StateNamespace =
  'configuration' | 'globalState' | 'persistedAtoms' | 'settings' | 'sharedObjects';

interface StateDocument {
  version: typeof STATE_VERSION;
  configuration: Record<string, unknown>;
  globalState: Record<string, unknown>;
  persistedAtoms: Record<string, unknown>;
  settings: Record<string, unknown>;
  sharedObjects: Record<string, unknown>;
}

function emptyState(): StateDocument {
  return {
    version: STATE_VERSION,
    configuration: {},
    globalState: {},
    persistedAtoms: {},
    settings: {},
    sharedObjects: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseState(value: unknown): StateDocument {
  if (!isRecord(value) || value.version !== STATE_VERSION) {
    throw new Error('unsupported host state document');
  }
  const state = emptyState();
  for (const namespace of Object.keys(state).filter(
    (key): key is StateNamespace => key !== 'version',
  )) {
    const stored = value[namespace];
    if (!isRecord(stored)) throw new Error(`invalid host state namespace: ${namespace}`);
    state[namespace] = { ...stored };
  }
  return state;
}

export class DurableStateStore {
  readonly path: string;
  readonly backupPath: string;

  #state = emptyState();
  #loaded = false;
  #revision = 0;
  #persistedRevision = 0;
  #flushPromise: Promise<void> | undefined;

  constructor(path: string) {
    this.path = path;
    this.backupPath = `${path}.bak`;
  }

  async load(): Promise<void> {
    if (this.#loaded) return;
    try {
      this.#state = await this.#read(this.path);
    } catch (primaryError) {
      try {
        this.#state = await this.#read(this.backupPath);
        if (!hasErrorCode(primaryError, 'ENOENT')) {
          await rename(this.path, `${this.path}.corrupt-${String(Date.now())}`);
        }
        await this.#atomicWrite(`${JSON.stringify(this.#state)}\n`, true);
      } catch (backupError) {
        if (hasErrorCode(primaryError, 'ENOENT') && hasErrorCode(backupError, 'ENOENT')) {
          this.#state = emptyState();
        } else {
          throw new AggregateError(
            [primaryError, backupError],
            'host state and its backup are unreadable',
            { cause: backupError },
          );
        }
      }
    }
    this.#loaded = true;
  }

  snapshot(namespace: StateNamespace): Record<string, unknown> {
    this.#assertLoaded();
    return { ...this.#state[namespace] };
  }

  get(namespace: StateNamespace, key: string): unknown {
    this.#assertLoaded();
    return this.#state[namespace][key];
  }

  async set(namespace: StateNamespace, key: string, value: unknown): Promise<void> {
    this.#assertLoaded();
    if (value === undefined) delete this.#state[namespace][key];
    else this.#state[namespace][key] = value;
    this.#revision += 1;
    await this.flush();
  }

  async replace(namespace: StateNamespace, value: Record<string, unknown>): Promise<void> {
    this.#assertLoaded();
    this.#state[namespace] = { ...value };
    this.#revision += 1;
    await this.flush();
  }

  async clear(namespace: StateNamespace): Promise<void> {
    await this.replace(namespace, {});
  }

  async compareAndSet(
    namespace: StateNamespace,
    key: string,
    expected: unknown,
    value: unknown,
  ): Promise<boolean> {
    this.#assertLoaded();
    if (this.#state[namespace][key] !== expected) return false;
    if (value === undefined) delete this.#state[namespace][key];
    else this.#state[namespace][key] = value;
    this.#revision += 1;
    await this.flush();
    return true;
  }

  async flush(): Promise<void> {
    this.#assertLoaded();
    if (this.#persistedRevision === this.#revision) return;
    if (this.#flushPromise !== undefined) return this.#flushPromise;
    this.#flushPromise = this.#flushLoop();
    try {
      await this.#flushPromise;
    } finally {
      this.#flushPromise = undefined;
    }
  }

  async #flushLoop(): Promise<void> {
    for (;;) {
      const revision = this.#revision;
      const serialized = `${JSON.stringify(this.#state)}\n`;
      await this.#atomicWrite(serialized);
      this.#persistedRevision = revision;
      if (revision === this.#revision) return;
    }
  }

  async #atomicWrite(serialized: string, preserveBackup = false): Promise<void> {
    const directory = dirname(this.path);
    const temporaryPath = join(
      directory,
      `.${this.path.split('/').at(-1) ?? 'state'}.tmp-${process.pid}-${String(this.#revision)}`,
    );
    const temporary = await open(temporaryPath, 'w', 0o600);
    try {
      await temporary.writeFile(serialized, 'utf8');
      await temporary.sync();
    } finally {
      await temporary.close();
    }
    try {
      const backedUpCurrent = preserveBackup ? true : await this.#backupCurrent();
      await rename(temporaryPath, this.path);
      if (!preserveBackup && !backedUpCurrent) await this.#backupCurrent();
      const directoryHandle = await open(directory, 'r');
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  async #read(path: string): Promise<StateDocument> {
    return parseState(JSON.parse(await readFile(path, 'utf8')) as unknown);
  }

  async #backupCurrent(): Promise<boolean> {
    const temporaryBackupPath = `${this.backupPath}.tmp-${process.pid}-${String(this.#revision)}`;
    await unlink(temporaryBackupPath).catch(() => undefined);
    try {
      await copyFile(this.path, temporaryBackupPath);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return false;
      throw error;
    }
    try {
      await rename(temporaryBackupPath, this.backupPath);
    } catch (error) {
      await unlink(temporaryBackupPath).catch(() => undefined);
      throw error;
    }
    return true;
  }

  #assertLoaded(): void {
    if (!this.#loaded) throw new Error('host state store is not loaded');
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === code;
}
