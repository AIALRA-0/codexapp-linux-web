import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface RuntimePathScope {
  root: string;
  workspaceRoot: string;
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
