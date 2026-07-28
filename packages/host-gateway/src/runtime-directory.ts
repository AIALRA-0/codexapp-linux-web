import { mkdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface RuntimeDirectoryScope {
  root: string;
  workspaceRoot: string;
}

export async function ensureRuntimeDirectory(
  runtime: RuntimeDirectoryScope,
  hostId: unknown,
  input: unknown,
): Promise<void> {
  if (hostId !== 'local') throw new Error('Only the local execution host is available');
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new Error('Directory path is required');
  }

  const unresolvedRoot = resolve(runtime.root);
  const root = await realpath(unresolvedRoot);
  const candidate = resolve(isAbsolute(input) ? input : join(runtime.workspaceRoot, input));
  const candidateBase = isPathWithin(unresolvedRoot, candidate)
    ? unresolvedRoot
    : isPathWithin(root, candidate)
      ? root
      : null;
  if (candidateBase === null) {
    throw new Error('Directory path is outside the user root');
  }

  const segments = relative(candidateBase, candidate).split(sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    const next = join(current, segment);
    await mkdir(next).catch((error: unknown) => {
      if (errorCode(error) !== 'EEXIST') throw error;
    });
    const canonical = await realpath(next);
    if (!isPathWithin(root, canonical)) {
      throw new Error('Directory path resolves outside the user root');
    }
    if (!(await stat(canonical)).isDirectory()) {
      throw new Error('Directory path is not a directory');
    }
    current = canonical;
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
