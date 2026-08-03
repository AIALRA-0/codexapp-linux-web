import { open, readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveRuntimePath, type RuntimePathScope } from './runtime-path.js';

const OFFICIAL_DESKTOP_FILE_MAX_BYTES = 256 * 1024 * 1024;
const OFFICIAL_CONTENT_SAMPLE_MAX_BYTES = 1024 * 1024;

interface DesktopFileScope extends RuntimePathScope {
  detectContentKind(sample: Uint8Array): Promise<unknown>;
}

export async function readOfficialDesktopFile(
  runtime: RuntimePathScope,
  params: Record<string, unknown>,
): Promise<{ contents: string }> {
  requireLocalHost(params.hostId);
  const path = await resolveDesktopPath(runtime, params.path);
  const fileStat = await stat(path);
  requireReadableFile(fileStat.isFile(), fileStat.size);
  return { contents: await readFile(path, 'utf8') };
}

export async function readOfficialDesktopFileMetadata(
  runtime: DesktopFileScope,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  requireLocalHost(params.hostId);
  const path = await resolveDesktopPath(runtime, params.path);
  const fileStat = await stat(path);
  const isFile = fileStat.isFile();
  const response: Record<string, unknown> = {
    isFile,
    mtimeMs: Number.isFinite(fileStat.mtimeMs) ? fileStat.mtimeMs : null,
    sizeBytes: Number.isFinite(fileStat.size) ? fileStat.size : null,
  };
  const requestedSampleBytes = optionalByteLimit(
    params.contentSampleByteLimit,
    'content sample byte limit',
  );
  const sampleMaxFileBytes = optionalByteLimit(
    params.contentSampleMaxFileBytes,
    'content sample maximum file size',
  );
  if (
    isFile &&
    requestedSampleBytes !== null &&
    (sampleMaxFileBytes === null || fileStat.size <= sampleMaxFileBytes)
  ) {
    const sample = await readFileSample(
      path,
      Math.min(requestedSampleBytes, OFFICIAL_CONTENT_SAMPLE_MAX_BYTES),
    );
    const contentKind = await runtime.detectContentKind(sample);
    if (contentKind !== null && contentKind !== undefined) response.contentKind = contentKind;
  }
  return response;
}

export async function readOfficialDesktopFileBinary(
  runtime: RuntimePathScope,
  params: Record<string, unknown>,
): Promise<{ contentsBase64: string | null; mimeType?: string }> {
  requireLocalHost(params.hostId);
  const input = requiredString(params.path, 'binary file path');
  if (input.startsWith('https://')) return { contentsBase64: null };
  const requestedMaxBytes = optionalByteLimit(params.maxBytes, 'binary file byte limit');
  const path = await resolveDesktopPath(runtime, input);
  const fileStat = await stat(path);
  if (!fileStat.isFile()) throw new Error('Desktop file path is not a file');
  const effectiveMaxBytes = Math.min(
    requestedMaxBytes ?? OFFICIAL_DESKTOP_FILE_MAX_BYTES,
    OFFICIAL_DESKTOP_FILE_MAX_BYTES,
  );
  if (fileStat.size > effectiveMaxBytes) return { contentsBase64: null };
  const bytes = await readFile(path);
  if (bytes.byteLength > effectiveMaxBytes) return { contentsBase64: null };
  const mimeType = detectMimeType(bytes, path);
  return {
    contentsBase64: bytes.toString('base64'),
    ...(mimeType === null ? {} : { mimeType }),
  };
}

async function resolveDesktopPath(runtime: RuntimePathScope, input: unknown): Promise<string> {
  const value = requiredString(input, 'desktop file path');
  let path = value;
  if (value.startsWith('file://')) {
    try {
      path = fileURLToPath(value);
    } catch (error) {
      throw new Error('Desktop file URL is invalid', { cause: error });
    }
  }
  return resolveRuntimePath(runtime, path, false);
}

async function readFileSample(path: string, maxBytes: number): Promise<Uint8Array> {
  if (maxBytes === 0) return new Uint8Array();
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function requireReadableFile(isFile: boolean, size: number): void {
  if (!isFile) throw new Error('Desktop file path is not a file');
  if (size > OFFICIAL_DESKTOP_FILE_MAX_BYTES) throw new Error('Desktop file is too large');
}

function requireLocalHost(value: unknown): void {
  if (value !== undefined && value !== null && value !== 'local') {
    throw new Error('Only the local execution host is available');
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} is required`);
  }
  return value;
}

function optionalByteLimit(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return value as number;
}

function detectMimeType(bytes: Uint8Array, path: string): string | null {
  if (hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  if (hasPrefix(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (asciiPrefix(bytes, 'GIF87a') || asciiPrefix(bytes, 'GIF89a')) return 'image/gif';
  if (asciiPrefix(bytes, 'RIFF') && asciiAt(bytes, 8, 'WEBP')) return 'image/webp';
  if (hasPrefix(bytes, [0x00, 0x00, 0x01, 0x00])) return 'image/x-icon';
  if (asciiPrefix(bytes, '%PDF-')) return 'application/pdf';
  const extension = extname(path).toLowerCase();
  const byExtension: Record<string, string> = {
    '.css': 'text/css',
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.md': 'text/markdown',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain',
    '.webm': 'video/webm',
  };
  return byExtension[extension] ?? null;
}

function hasPrefix(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function asciiPrefix(bytes: Uint8Array, value: string): boolean {
  return asciiAt(bytes, 0, value);
}

function asciiAt(bytes: Uint8Array, offset: number, value: string): boolean {
  if (bytes.byteLength < offset + value.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}
