import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const LEGACY_CLIPBOARD_ATTACHMENT_NAME =
  /^codex-clipboard-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.png$/iu;
const LEGACY_MACOS_CLIPBOARD_PATH =
  /^\/?var\/folders\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/T\/(?<name>codex-clipboard-[0-9a-f-]+\.png)$/iu;
const LEGACY_SERVER_CLIPBOARD_PATH =
  /^\/?srv\/aialra\/state\/[^/]+\/users\/[0-9a-f]{64}\/tmp\/(?<name>codex-clipboard-[0-9a-f-]+\.png)$/iu;

export interface RuntimePathScope {
  root: string;
  workspaceRoot: string;
}

export function portableWorkspaceAttachmentPath(
  input: string,
  workspaceRoot: string,
): string | null {
  const normalized = input.replaceAll('\\', '/');
  const marker = '/workspace/.codex/attachments/';
  const markerPosition = normalized.indexOf(marker);
  if (markerPosition < 0) {
    const legacyClipboard =
      LEGACY_MACOS_CLIPBOARD_PATH.exec(normalized) ?? LEGACY_SERVER_CLIPBOARD_PATH.exec(normalized);
    const legacyName = legacyClipboard?.groups?.name;
    if (legacyName === undefined || !LEGACY_CLIPBOARD_ATTACHMENT_NAME.test(legacyName)) {
      return null;
    }
    return resolve(workspaceRoot, '.codex', 'attachments', 'legacy-imports', legacyName);
  }

  const suffix = normalized.slice(markerPosition + marker.length);
  if (
    suffix.length === 0 ||
    suffix.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    return null;
  }
  return resolve(workspaceRoot, '.codex', 'attachments', suffix);
}

export async function resolveRuntimePath(
  runtime: RuntimePathScope,
  input: string,
  forWrite: boolean,
): Promise<string> {
  const root = await realpath(runtime.root);
  const unresolvedRoot = resolve(runtime.root);
  const candidate = resolve(isAbsolute(input) ? input : join(runtime.workspaceRoot, input));
  if (!isPathWithin(unresolvedRoot, candidate) && !isPathWithin(root, candidate)) {
    throw new Error('Workspace file path is outside the user root');
  }
  if (!forWrite) {
    const canonical = await realpath(candidate);
    if (!isPathWithin(root, canonical)) {
      throw new Error('Workspace file path resolves outside the user root');
    }
    return canonical;
  }
  try {
    const canonical = await realpath(candidate);
    if (!isPathWithin(root, canonical)) {
      throw new Error('Workspace file path resolves outside the user root');
    }
    return canonical;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    const parent = await realpath(dirname(candidate));
    if (!isPathWithin(root, parent)) {
      throw new Error('Workspace file parent resolves outside the user root', { cause: error });
    }
    return join(parent, basename(candidate));
  }
}

function isPathWithin(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return (
    difference === '' ||
    (difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference))
  );
}

function errorCode(error: unknown): string | null {
  return error !== null &&
    typeof error === 'object' &&
    !Array.isArray(error) &&
    typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null;
}
