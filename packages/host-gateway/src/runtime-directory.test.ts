import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ensureRuntimeDirectory, resolveRuntimeDirectory } from './runtime-directory.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (path) => rm(path, { force: true, recursive: true })),
  );
});

async function createRuntimeScope(): Promise<{ root: string; workspaceRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), 'codex-runtime-directory-'));
  temporaryRoots.push(root);
  const workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot);
  return { root, workspaceRoot };
}

describe('official ensure-directory adapter', () => {
  it('creates nested relative directories under the user workspace', async () => {
    const runtime = await createRuntimeScope();

    await ensureRuntimeDirectory(runtime, 'local', 'outputs/one/two');

    await expect(realpath(join(runtime.workspaceRoot, 'outputs/one/two'))).resolves.toBe(
      join(await realpath(runtime.workspaceRoot), 'outputs/one/two'),
    );
  });

  it('accepts an absolute path inside the user root', async () => {
    const runtime = await createRuntimeScope();
    const target = join(runtime.root, 'codex-home', 'worktrees');

    await ensureRuntimeDirectory(runtime, 'local', target);

    await expect(realpath(target)).resolves.toBe(
      join(await realpath(runtime.root), 'codex-home/worktrees'),
    );
  });

  it('resolves an existing directory for official host operations', async () => {
    const runtime = await createRuntimeScope();
    const target = join(runtime.workspaceRoot, 'project');
    await mkdir(target);

    await expect(resolveRuntimeDirectory(runtime, 'local', target)).resolves.toBe(
      await realpath(target),
    );
  });

  it('expands the official home shorthand to the isolated workspace', async () => {
    const runtime = await createRuntimeScope();
    const target = join(runtime.workspaceRoot, 'project');
    await mkdir(target);

    await expect(resolveRuntimeDirectory(runtime, 'local', '~')).resolves.toBe(
      await realpath(runtime.workspaceRoot),
    );
    await expect(resolveRuntimeDirectory(runtime, 'local', '~/project')).resolves.toBe(
      await realpath(target),
    );
  });

  it('rejects non-local hosts and paths outside the user root', async () => {
    const runtime = await createRuntimeScope();

    await expect(ensureRuntimeDirectory(runtime, 'remote', 'outputs')).rejects.toThrow(
      'Only the local execution host is available',
    );
    await expect(
      ensureRuntimeDirectory(runtime, 'local', join(runtime.root, '..', 'escaped')),
    ).rejects.toThrow('Directory path is outside the user root');
  });

  it('rejects an existing symlink that escapes the user root', async () => {
    const runtime = await createRuntimeScope();
    const outside = await mkdtemp(join(tmpdir(), 'codex-runtime-directory-outside-'));
    temporaryRoots.push(outside);
    await symlink(outside, join(runtime.workspaceRoot, 'escape'));

    await expect(ensureRuntimeDirectory(runtime, 'local', 'escape/nested')).rejects.toThrow(
      'Directory path resolves outside the user root',
    );
  });

  it('rejects an existing file in the requested directory path', async () => {
    const runtime = await createRuntimeScope();
    await writeFile(join(runtime.workspaceRoot, 'file'), 'content');

    await expect(ensureRuntimeDirectory(runtime, 'local', 'file')).rejects.toThrow(
      'Directory path is not a directory',
    );
  });
});
