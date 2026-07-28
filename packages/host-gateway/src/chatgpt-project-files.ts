import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, parse } from 'node:path';

import { RpcTarget } from 'capnweb';

import type { HostDownloadRequest } from './network.js';
import type { UserRuntime } from './runtime.js';

const PROJECTS_DIRECTORY = '.chatgpt-projects';
const METADATA_DIRECTORY = '.metadata';
const SOURCES_DIRECTORY = 'sources';
const METADATA_VERSION = 1;
const INVALID_FILE_NAME_CHARACTERS = '<>:"/\\|?*';
const pendingSyncs = new Map<string, Promise<{ rootPath: string }>>();
const disposeSymbol = Symbol.for('dispose');

interface ProjectFile {
  fileId: string;
  name: string;
}

interface ProjectFileMetadata extends ProjectFile {
  sha256: string;
}

interface ProjectMetadata {
  files: ProjectFileMetadata[];
  version: 1;
}

type GetFileDownloadRequest = (fileId: string) => unknown;

interface SyncRequest {
  files: ProjectFile[];
  getFileDownloadRequest: GetFileDownloadRequest;
  instructions: string;
  projectId: string;
  projectName: string;
}

export class ChatGptProjectFilesService extends RpcTarget {
  #runtime: UserRuntime;

  constructor(runtime: UserRuntime) {
    super();
    this.#runtime = runtime;
  }

  async sync(request: unknown): Promise<{ rootPath: string }> {
    const parsed = parseSyncRequest(request);
    assertValidProjectId(parsed.projectId);
    const rootPath = join(this.#runtime.codexHome, PROJECTS_DIRECTORY, parsed.projectId);
    const previous = pendingSyncs.get(rootPath);
    const operation = (async () => {
      await previous?.catch(() => undefined);
      return syncProject({
        ...parsed,
        downloadFile: (downloadRequest) =>
          this.#runtime.downloadChatGptProjectFile(downloadRequest),
        rootPath,
      });
    })();
    pendingSyncs.set(rootPath, operation);
    try {
      return await operation;
    } finally {
      if (pendingSyncs.get(rootPath) === operation) pendingSyncs.delete(rootPath);
      disposeCallback(parsed.getFileDownloadRequest);
    }
  }
}

async function syncProject({
  downloadFile,
  files,
  getFileDownloadRequest,
  instructions,
  projectName,
  rootPath,
}: SyncRequest & {
  downloadFile: (request: HostDownloadRequest) => Promise<ReadableStream<Uint8Array>>;
  rootPath: string;
}): Promise<{ rootPath: string }> {
  const parentPath = dirname(rootPath);
  const projectDirectoryName = basename(rootPath);
  const stagingPath = join(parentPath, `.${projectDirectoryName}-staging-${randomUUID()}`);
  const previousPath = join(parentPath, `.${projectDirectoryName}-previous-${randomUUID()}`);
  const sourcesPath = join(stagingPath, SOURCES_DIRECTORY);
  const metadataPath = join(parentPath, METADATA_DIRECTORY, `${projectDirectoryName}.json`);
  const previousMetadata = await readMetadata(metadataPath);
  await mkdir(sourcesPath, { recursive: true });
  try {
    await writeFile(
      join(stagingPath, 'AGENTS.md'),
      projectInstructions(projectName, instructions),
      { encoding: 'utf8', mode: 0o444 },
    );
    const nextMetadataFiles: ProjectFileMetadata[] = [];
    for (const file of uniqueProjectFiles(files)) {
      const previousFile = previousMetadata?.files.find(
        (candidate) => candidate.fileId === file.fileId && isSafeMetadataFileName(candidate.name),
      );
      const targetPath = join(sourcesPath, file.name);
      if (
        previousFile !== undefined &&
        (await copyVerifiedFile(
          join(rootPath, SOURCES_DIRECTORY, previousFile.name),
          targetPath,
          previousFile.sha256,
        ))
      ) {
        nextMetadataFiles.push({ ...file, sha256: previousFile.sha256 });
        continue;
      }
      const sha256 = await downloadProjectFile(
        targetPath,
        file.fileId,
        getFileDownloadRequest,
        downloadFile,
      );
      nextMetadataFiles.push({ ...file, sha256 });
    }
    let movedPrevious = false;
    try {
      await rename(rootPath, previousPath);
      movedPrevious = true;
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) throw error;
    }
    try {
      await rename(stagingPath, rootPath);
    } catch (error) {
      if (movedPrevious) await rename(previousPath, rootPath).catch(() => undefined);
      throw error;
    }
    if (movedPrevious) {
      await rm(previousPath, { recursive: true, force: false }).catch(() => undefined);
    }
    await writeMetadata(metadataPath, {
      files: nextMetadataFiles,
      version: METADATA_VERSION,
    }).catch(() => undefined);
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: false });
    throw error;
  }
  return { rootPath };
}

async function downloadProjectFile(
  targetPath: string,
  fileId: string,
  getFileDownloadRequest: GetFileDownloadRequest,
  downloadFile: (request: HostDownloadRequest) => Promise<ReadableStream<Uint8Array>>,
): Promise<string> {
  const hash = createHash('sha256');
  const file = await open(targetPath, 'w', 0o444);
  try {
    const downloadRequest = parseDownloadRequest(await getFileDownloadRequest(fileId));
    const reader = (await downloadFile(downloadRequest)).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        await file.writeFile(value);
      }
    } finally {
      reader.releaseLock();
    }
  } finally {
    await file.close();
  }
  return hash.digest('hex');
}

async function copyVerifiedFile(
  sourcePath: string,
  targetPath: string,
  expectedSha256: string,
): Promise<boolean> {
  try {
    await copyFile(sourcePath, targetPath);
    if ((await sha256File(targetPath)) === expectedSha256) {
      await chmod(targetPath, 0o444);
      return true;
    }
    await rm(targetPath, { force: false });
    return false;
  } catch {
    await rm(targetPath, { force: false }).catch(() => undefined);
    return false;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

async function readMetadata(path: string): Promise<ProjectMetadata | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return isProjectMetadata(value) ? value : null;
  } catch {
    return null;
  }
}

async function writeMetadata(path: string, metadata: ProjectMetadata): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(metadata)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function assertValidProjectId(value: string): void {
  if (
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.toLowerCase() === METADATA_DIRECTORY ||
    !/^[A-Za-z0-9._-]+$/u.test(value)
  ) {
    throw new Error('Invalid ChatGPT project ID');
  }
}

function uniqueProjectFiles(files: ProjectFile[]): ProjectFile[] {
  const used = new Set<string>();
  return files.map((file) => {
    const sanitized = sanitizeProjectFileName(file.name);
    const parsed = parse(
      sanitized === '' || sanitized === '.' || sanitized === '..' ? 'file' : sanitized,
    );
    let stem = isInstructionsFile(sanitized)
      ? `${parsed.name} (project file)`
      : parsed.name || 'file';
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(stem.split('.')[0] ?? '')) {
      stem = `_${stem}`;
    }
    let name = `${stem}${parsed.ext}`;
    for (let suffix = 2; used.has(name.toLowerCase()); suffix += 1) {
      name = `${stem} (${String(suffix)})${parsed.ext}`;
    }
    used.add(name.toLowerCase());
    return { ...file, name };
  });
}

function sanitizeProjectFileName(value: string): string {
  return Array.from(basename(value.trim()), (character) =>
    character.charCodeAt(0) < 32 || INVALID_FILE_NAME_CHARACTERS.includes(character)
      ? '_'
      : character,
  )
    .join('')
    .replace(/[ .]+$/gu, '');
}

function isSafeMetadataFileName(value: string): boolean {
  return (
    value !== '' &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    basename(value) === value
  );
}

function isInstructionsFile(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized === 'agents.md' || normalized === 'agents.override.md';
}

function projectInstructions(projectName: string, instructions: string): string {
  return `# ChatGPT project context

This directory is a local mirror of the ChatGPT project “${projectName}”.

- Treat every file under \`${SOURCES_DIRECTORY}/\` as read-only reference material.
- Do not edit, rename, move, or delete synced project files.
- These files may be replaced the next time a task is created from this ChatGPT project.

## Project instructions

${instructions.trim() || 'This project has no custom instructions.'}
`;
}

function parseSyncRequest(value: unknown): SyncRequest {
  const request = requireRecord(value, 'ChatGPT project sync');
  if (!Array.isArray(request.files)) {
    throw new TypeError('ChatGPT project files are invalid');
  }
  const files = request.files.map((entry) => {
    const file = requireRecord(entry, 'ChatGPT project file');
    return {
      fileId: requireString(file.fileId, 'ChatGPT project file ID'),
      name: requireString(file.name, 'ChatGPT project file name'),
    };
  });
  if (typeof request.getFileDownloadRequest !== 'function') {
    throw new TypeError('ChatGPT project file download callback is invalid');
  }
  return {
    files,
    getFileDownloadRequest: request.getFileDownloadRequest as GetFileDownloadRequest,
    instructions: requireString(request.instructions, 'ChatGPT project instructions'),
    projectId: requireString(request.projectId, 'ChatGPT project ID'),
    projectName: requireString(request.projectName, 'ChatGPT project name'),
  };
}

function parseDownloadRequest(value: unknown): HostDownloadRequest {
  const request = requireRecord(value, 'ChatGPT project file download');
  const downloadUrl = requireString(request.downloadUrl, 'ChatGPT project file download URL');
  if (
    request.requestHeaders !== undefined &&
    (request.requestHeaders === null ||
      typeof request.requestHeaders !== 'object' ||
      Array.isArray(request.requestHeaders))
  ) {
    throw new TypeError('ChatGPT project file download headers are invalid');
  }
  return {
    downloadUrl,
    ...(request.requestHeaders === undefined
      ? {}
      : { requestHeaders: request.requestHeaders as Record<string, string> }),
  };
}

function isProjectMetadata(value: unknown): value is ProjectMetadata {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value as { version?: unknown }).version !== METADATA_VERSION ||
    !Array.isArray((value as { files?: unknown }).files)
  ) {
    return false;
  }
  return (value as { files: unknown[] }).files.every((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const file = entry as Record<string, unknown>;
    return (
      typeof file.fileId === 'string' &&
      typeof file.name === 'string' &&
      typeof file.sha256 === 'string' &&
      /^[a-f0-9]{64}$/u.test(file.sha256)
    );
  });
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} request is invalid`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} is invalid`);
  return value;
}

function disposeCallback(callback: GetFileDownloadRequest): void {
  const dispose = Reflect.get(callback, disposeSymbol) as unknown;
  if (typeof dispose === 'function') dispose.call(callback);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
