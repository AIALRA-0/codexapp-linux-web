import { constants, createWriteStream, type Stats } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from 'node:fs/promises';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from 'node:path';
import { pipeline } from 'node:stream/promises';

import { RpcTarget } from 'capnweb';
import sharp from 'sharp';

import type { UserRuntime } from './runtime.js';

const IMAGE_EXTENSIONS = new Set(['.gif', '.jpeg', '.jpg', '.png', '.webp']);
const THUMBNAIL_SIZES = { compact: 96, large: 320 } as const;
const OUTPUT_DIRECTORIES_STATE_KEY = 'thread-projectless-output-directories';

interface LibraryFile {
  modifiedAt: string;
  name: string;
  path: string;
  relativePath: string;
  sizeBytes: number;
  threadId: string | null;
}

interface GeneratedImage extends LibraryFile {
  desktopPath: string;
}

interface ThreadRecord {
  cwd: string;
  id: string;
}

export class LibraryFilesService extends RpcTarget {
  #runtime: UserRuntime;
  #previewPaths = new Set<string>();
  #thumbnailQueue = Promise.resolve();

  constructor(runtime: UserRuntime) {
    super();
    this.#runtime = runtime;
  }

  listGeneratedImages(): Promise<GeneratedImage[]> {
    return listGeneratedImages(join(this.#runtime.codexHome, 'generated_images'));
  }

  async listOutputFiles(): Promise<LibraryFile[]> {
    const directories = await this.#loadOutputDirectories();
    return listOutputFiles(this.#runtime.workspaceRoot, directories);
  }

  getThumbnailDataUrl(request: unknown): Promise<{ dataUrl: string | null }> {
    const params = requestRecord(request, 'Library thumbnail');
    const sourcePath = requestString(params.sourcePath, 'Library thumbnail source path');
    if (params.size !== 'compact' && params.size !== 'large') {
      throw new TypeError('Library thumbnail size is invalid');
    }
    const size = THUMBNAIL_SIZES[params.size];
    const operation = this.#thumbnailQueue.then(async () => {
      const file = await this.#openAllowedFile(sourcePath);
      try {
        const bytes = await file.readFile();
        try {
          const thumbnail = await sharp(bytes)
            .rotate()
            .resize(size, size, { fit: 'inside', withoutEnlargement: true })
            .png()
            .toBuffer();
          return { dataUrl: `data:image/png;base64,${thumbnail.toString('base64')}` };
        } catch {
          return { dataUrl: null };
        }
      } finally {
        await file.close();
      }
    });
    this.#thumbnailQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async prepareFilePreview(request: unknown): Promise<{ previewPath: string }> {
    const params = requestRecord(request, 'Library file preview');
    const sourcePath = requestString(params.sourcePath, 'Library file preview source path');
    const source = await this.#openAllowedFile(sourcePath);
    let previewDirectory: string | null = null;
    try {
      const previewRoot = join(this.#runtime.root, 'library-previews');
      await mkdir(previewRoot, { recursive: true, mode: 0o700 });
      previewDirectory = await mkdtemp(join(previewRoot, 'codex-library-preview-'));
      const previewPath = join(previewDirectory, basename(sourcePath.replaceAll('\\', '/')));
      await pipeline(
        source.createReadStream({ autoClose: false }),
        createWriteStream(previewPath, { flags: 'wx', mode: 0o600 }),
      );
      this.#previewPaths.add(previewPath);
      return { previewPath };
    } catch {
      if (previewDirectory !== null) {
        await rm(previewDirectory, { force: false, recursive: true });
      }
      throw new Error('Library file is unavailable');
    } finally {
      await source.close();
    }
  }

  async releaseFilePreview(request: unknown): Promise<void> {
    const params = requestRecord(request, 'Library file preview release');
    const previewPath = requestString(params.previewPath, 'Library file preview path');
    if (this.#previewPaths.delete(previewPath)) {
      await rm(dirname(previewPath), { force: false, recursive: true });
    }
  }

  async #openAllowedFile(sourcePath: string) {
    let sourceStats: Stats;
    let canonicalPath: string;
    try {
      const [entryStats, resolvedPath] = await Promise.all([
        lstat(sourcePath),
        realpath(sourcePath),
      ]);
      if (!entryStats.isFile() || entryStats.isSymbolicLink()) {
        throw new Error('Invalid Library file');
      }
      sourceStats = entryStats;
      canonicalPath = resolvedPath;
    } catch {
      throw new Error('Library file is unavailable');
    }
    const allowedDirectories = await this.#allowedLibraryRealPaths();
    if (!allowedDirectories.some((directory) => isStrictlyInside(canonicalPath, directory))) {
      throw new Error('Library file is unavailable');
    }
    try {
      const file = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const [openedStats, finalStats, finalPath] = await Promise.all([
          file.stat(),
          lstat(canonicalPath),
          realpath(canonicalPath),
        ]);
        if (
          !openedStats.isFile() ||
          openedStats.dev !== sourceStats.dev ||
          openedStats.ino !== sourceStats.ino ||
          finalStats.isSymbolicLink() ||
          openedStats.dev !== finalStats.dev ||
          openedStats.ino !== finalStats.ino ||
          finalPath !== canonicalPath
        ) {
          throw new Error('Invalid Library file');
        }
        return file;
      } catch {
        await file.close();
        throw new Error('Library file is unavailable');
      }
    } catch {
      throw new Error('Library file is unavailable');
    }
  }

  async #allowedLibraryRealPaths(): Promise<string[]> {
    const directories = [
      ...(await this.#loadOutputDirectories()).allowedOutputDirectories,
      join(this.#runtime.codexHome, 'generated_images'),
    ];
    const resolved = await Promise.all(
      directories.map(async (directory) => {
        try {
          const [stats, path] = await Promise.all([lstat(directory), realpath(directory)]);
          return stats.isDirectory() && !stats.isSymbolicLink() ? path : null;
        } catch {
          return null;
        }
      }),
    );
    return resolved.filter((path): path is string => path !== null);
  }

  async #loadOutputDirectories(): Promise<OutputDirectories> {
    const configured = configuredOutputDirectories(
      this.#runtime.getGlobalState(OUTPUT_DIRECTORIES_STATE_KEY),
    );
    const threads = await listLocalThreads(this.#runtime);
    return resolveOutputDirectories(configured, threads, this.#runtime.workspaceRoot);
  }
}

interface OutputDirectories {
  allowedOutputDirectories: string[];
  outputDirectories: Record<string, string>;
}

async function listGeneratedImages(directory: string): Promise<GeneratedImage[]> {
  try {
    const stats = await lstat(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return [];
    const canonicalRoot = await realpath(directory);
    return (await readGeneratedImages(canonicalRoot, canonicalRoot)).sort((left, right) =>
      left.path.localeCompare(right.path),
    );
  } catch {
    return [];
  }
}

async function readGeneratedImages(directory: string, root: string): Promise<GeneratedImage[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return (
      await Promise.all(
        entries.map(async (entry): Promise<GeneratedImage[]> => {
          const entryPath = join(directory, entry.name);
          try {
            const stats = await lstat(entryPath);
            if (stats.isSymbolicLink()) return [];
            const canonicalPath = await realpath(entryPath);
            if (!isStrictlyInside(canonicalPath, root)) return [];
            if (stats.isDirectory()) return readGeneratedImages(canonicalPath, root);
            if (!stats.isFile() || !IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
              return [];
            }
            const relativePath = relative(root, canonicalPath);
            const separatorIndex = relativePath.indexOf(sep);
            return [
              {
                desktopPath: canonicalPath,
                modifiedAt: stats.mtime.toISOString(),
                name: entry.name,
                path: canonicalPath,
                relativePath,
                sizeBytes: stats.size,
                threadId: separatorIndex === -1 ? null : relativePath.slice(0, separatorIndex),
              },
            ];
          } catch {
            return [];
          }
        }),
      )
    ).flat();
  } catch {
    return [];
  }
}

function resolveOutputDirectories(
  configured: Record<string, string>,
  threads: ThreadRecord[],
  workspaceRoot: string,
): OutputDirectories {
  const outputDirectories: Record<string, string> = { ...configured };
  for (const thread of threads) {
    const configuredDirectory = configured[thread.id];
    outputDirectories[thread.id] =
      configuredDirectory === undefined ? join(thread.cwd, 'outputs') : configuredDirectory;
  }
  const allowedOutputDirectories = Object.values(outputDirectories).filter((directory) =>
    isStrictlyInside(resolve(directory), resolve(workspaceRoot)),
  );
  return {
    allowedOutputDirectories: [...new Set(allowedOutputDirectories)],
    outputDirectories,
  };
}

async function listOutputFiles(
  workspaceRoot: string,
  directories: OutputDirectories,
): Promise<LibraryFile[]> {
  const byPath = new Map<string, LibraryFile>();
  const allowed = new Set(directories.allowedOutputDirectories.map(normalizePathKey));
  let canonicalWorkspaceRoot: string;
  try {
    const workspaceStats = await lstat(resolve(workspaceRoot));
    if (!workspaceStats.isDirectory() || workspaceStats.isSymbolicLink()) return [];
    canonicalWorkspaceRoot = await realpath(resolve(workspaceRoot));
  } catch {
    return [];
  }
  const grouped = new Map<string, { outputDirectory: string; threadId: string | null }>();
  for (const [threadId, outputDirectory] of Object.entries(directories.outputDirectories)) {
    const key = normalizePathKey(outputDirectory);
    const existing = grouped.get(key);
    grouped.set(key, {
      outputDirectory,
      threadId: existing === undefined || existing.threadId === threadId ? threadId : null,
    });
  }
  for (const outputDirectory of directories.allowedOutputDirectories) {
    const key = normalizePathKey(outputDirectory);
    if (!grouped.has(key)) grouped.set(key, { outputDirectory, threadId: null });
  }
  const files = await Promise.all(
    [...grouped.values()]
      .filter(({ outputDirectory }) => allowed.has(normalizePathKey(outputDirectory)))
      .map(({ outputDirectory, threadId }) =>
        inspectOutputDirectory(outputDirectory, canonicalWorkspaceRoot, threadId),
      ),
  );
  for (const directoryFiles of files) {
    for (const file of directoryFiles) {
      const key = normalizePathKey(file.path);
      if (!byPath.has(key)) byPath.set(key, file);
    }
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

async function inspectOutputDirectory(
  outputDirectory: string,
  canonicalWorkspaceRoot: string,
  threadId: string | null,
): Promise<LibraryFile[]> {
  try {
    const stats = await lstat(outputDirectory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return [];
    const resolvedDirectory = resolve(outputDirectory);
    const canonicalDirectory = await realpath(resolvedDirectory);
    if (!isStrictlyInside(canonicalDirectory, canonicalWorkspaceRoot)) return [];
    return inspectOutputEntries(resolvedDirectory, resolvedDirectory, canonicalDirectory, threadId);
  } catch {
    return [];
  }
}

async function inspectOutputEntries(
  directory: string,
  outputDirectory: string,
  canonicalOutputDirectory: string,
  threadId: string | null,
): Promise<LibraryFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry): Promise<LibraryFile[]> => {
        const entryPath = join(directory, entry.name);
        try {
          const stats = await lstat(entryPath);
          if (
            stats.isSymbolicLink() ||
            !isStrictlyInside(await realpath(entryPath), canonicalOutputDirectory)
          ) {
            return [];
          }
          if (stats.isDirectory()) {
            return inspectOutputEntries(
              entryPath,
              outputDirectory,
              canonicalOutputDirectory,
              threadId,
            );
          }
          if (!stats.isFile()) return [];
          return [
            {
              modifiedAt: stats.mtime.toISOString(),
              name: entry.name,
              path: entryPath,
              relativePath: relative(outputDirectory, entryPath),
              sizeBytes: stats.size,
              threadId,
            },
          ];
        } catch {
          return [];
        }
      }),
    )
  ).flat();
}

async function listLocalThreads(runtime: UserRuntime): Promise<ThreadRecord[]> {
  const threads: ThreadRecord[] = [];
  let cursor: string | null = null;
  do {
    const response = requestRecord(
      await runtime.requestAppServer('thread/list', {
        archived: false,
        cursor,
        limit: 200,
        modelProviders: null,
        sortKey: 'updated_at',
        useStateDbOnly: true,
      }),
      'thread list',
    );
    if (!Array.isArray(response.data)) throw new Error('thread list data is invalid');
    for (const entry of response.data) {
      const thread = requestRecord(entry, 'thread list entry');
      if (typeof thread.id === 'string' && typeof thread.cwd === 'string') {
        threads.push({ cwd: thread.cwd, id: thread.id });
      }
    }
    if (response.nextCursor !== null && typeof response.nextCursor !== 'string') {
      throw new Error('thread list cursor is invalid');
    }
    cursor = response.nextCursor;
  } while (cursor !== null);
  return threads;
}

function configuredOutputDirectories(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] =>
        entry[0].length > 0 && typeof entry[1] === 'string' && entry[1].length > 0,
    ),
  );
}

function isStrictlyInside(path: string, root: string): boolean {
  const relation = relative(root, path);
  return (
    relation !== '' &&
    relation !== '..' &&
    !relation.startsWith(`..${sep}`) &&
    !isAbsolute(relation)
  );
}

function normalizePathKey(path: string): string {
  const normalized = normalize(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function requestRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} request is invalid`);
  }
  return value as Record<string, unknown>;
}

function requestString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}
