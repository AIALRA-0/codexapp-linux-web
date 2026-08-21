import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  readOfficialDesktopFile,
  readOfficialDesktopFileBinary,
  readOfficialDesktopFileMetadata,
  readOfficialExistingPaths,
  readOfficialWorkspaceDirectoryEntries,
} from './desktop-files.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('official desktop file requests', () => {
  it('returns the native binary response shape and MIME type', async () => {
    const runtime = await createRuntime();
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    const path = join(runtime.workspaceRoot, 'pixel.png');
    await writeFile(path, bytes);

    await expect(
      readOfficialDesktopFileBinary(runtime, { hostId: 'local', path }),
    ).resolves.toEqual({ contentsBase64: bytes.toString('base64'), mimeType: 'image/png' });
    await expect(
      readOfficialDesktopFileBinary(runtime, { hostId: 'local', maxBytes: 8, path }),
    ).resolves.toEqual({ contentsBase64: null });
  });

  it('reads text and metadata using the official content-kind detector', async () => {
    const runtime = await createRuntime();
    const path = join(runtime.workspaceRoot, 'note.txt');
    await writeFile(path, 'hello official renderer\n');
    const samples: Uint8Array[] = [];

    await expect(
      readOfficialDesktopFile(runtime, { hostId: 'local', path: pathToFileURL(path).href }),
    ).resolves.toEqual({ contents: 'hello official renderer\n' });
    const metadata = await readOfficialDesktopFileMetadata(
      {
        ...runtime,
        detectContentKind: (sample) => {
          samples.push(sample);
          return Promise.resolve('text');
        },
      },
      {
        contentSampleByteLimit: 5,
        contentSampleMaxFileBytes: 100,
        hostId: 'local',
        path,
      },
    );
    expect(metadata).toMatchObject({ contentKind: 'text', isFile: true, sizeBytes: 24 });
    expect(Buffer.from(samples[0] ?? []).toString('utf8')).toBe('hello');
  });

  it('returns null for remote HTTPS images without fetching them from the host process', async () => {
    const runtime = await createRuntime();
    await expect(
      readOfficialDesktopFileBinary(runtime, {
        hostId: 'local',
        path: 'https://example.invalid/image.png',
      }),
    ).resolves.toEqual({ contentsBase64: null });
  });

  it('reads a migrated attachment from the current workspace without exposing the old root', async () => {
    const runtime = await createRuntime();
    const attachment = join(
      runtime.workspaceRoot,
      '.codex',
      'attachments',
      'thread-1',
      'pixel.png',
    );
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    await mkdir(join(runtime.workspaceRoot, '.codex', 'attachments', 'thread-1'), {
      recursive: true,
    });
    await mkdir(join(runtime.workspaceRoot, '.codex', 'attachments', 'legacy-imports'), {
      recursive: true,
    });
    await writeFile(attachment, bytes);
    const legacyClipboardName = 'codex-clipboard-04ddab70-23c0-455d-8a2f-307f37995f62.png';
    await writeFile(
      join(runtime.workspaceRoot, '.codex', 'attachments', 'legacy-imports', legacyClipboardName),
      bytes,
    );
    const outsideRoot = await mkdtemp(join(tmpdir(), 'codexapp-portable-attachment-outside-'));
    roots.push(outsideRoot);
    const outsidePath = join(outsideRoot, 'outside.png');
    await writeFile(outsidePath, bytes);
    await symlink(
      outsidePath,
      join(runtime.workspaceRoot, '.codex', 'attachments', 'thread-1', 'linked.png'),
    );

    const legacyPath = '/srv/legacy/users/old-user/workspace/.codex/attachments/thread-1/pixel.png';
    await expect(
      readOfficialDesktopFileBinary(runtime, { hostId: 'local', path: legacyPath }),
    ).resolves.toEqual({ contentsBase64: bytes.toString('base64'), mimeType: 'image/png' });
    await expect(
      readOfficialDesktopFileBinary(runtime, {
        hostId: 'local',
        path: `/var/folders/3p/legacy-session/T/${legacyClipboardName}`,
      }),
    ).resolves.toEqual({ contentsBase64: bytes.toString('base64'), mimeType: 'image/png' });
    await expect(
      readOfficialDesktopFileBinary(runtime, {
        hostId: 'local',
        path: `/srv/aialra/state/old-host/users/${'a'.repeat(64)}/tmp/${legacyClipboardName}`,
      }),
    ).resolves.toEqual({ contentsBase64: bytes.toString('base64'), mimeType: 'image/png' });
    await expect(
      readOfficialDesktopFileBinary(runtime, {
        hostId: 'local',
        path: '/srv/legacy/users/old-user/workspace/private.txt',
      }),
    ).rejects.toThrow('outside the user root');
    await expect(
      readOfficialDesktopFileBinary(runtime, {
        hostId: 'local',
        path: '/srv/legacy/users/old-user/workspace/.codex/attachments/thread-1/linked.png',
      }),
    ).rejects.toThrow('resolves outside the user root');
    await expect(
      readOfficialDesktopFileBinary(runtime, {
        hostId: 'local',
        path: '/srv/legacy/users/old-user/workspace/.codex/attachments/thread-1/../../secret.txt',
      }),
    ).rejects.toThrow('outside the user root');
    await expect(
      readOfficialDesktopFileBinary(runtime, {
        hostId: 'local',
        path: '/var/folders/3p/legacy-session/T/private.png',
      }),
    ).rejects.toThrow('outside the user root');
  });

  it('returns only root-confined paths that currently exist', async () => {
    const runtime = await createRuntime();
    const existingPath = join(runtime.workspaceRoot, 'existing.txt');
    const missingPath = join(runtime.workspaceRoot, 'missing.txt');
    await writeFile(existingPath, 'exists');
    const outsideRoot = await mkdtemp(join(tmpdir(), 'codexapp-paths-outside-'));
    roots.push(outsideRoot);
    const outsidePath = join(outsideRoot, 'outside.txt');
    await writeFile(outsidePath, 'outside');
    const outsideLink = join(runtime.workspaceRoot, 'outside-link.txt');
    await symlink(outsidePath, outsideLink);

    await expect(
      readOfficialExistingPaths(runtime, {
        hostId: 'local',
        paths: [existingPath, missingPath, outsidePath, outsideLink],
      }),
    ).resolves.toEqual({ existingPaths: [existingPath] });
  });

  it('rejects other hosts, outside paths, and symlink escapes', async () => {
    const runtime = await createRuntime();
    const outsideRoot = await mkdtemp(join(tmpdir(), 'codexapp-outside-'));
    roots.push(outsideRoot);
    const outsidePath = join(outsideRoot, 'secret.txt');
    await writeFile(outsidePath, 'not accessible');
    const linkPath = join(runtime.workspaceRoot, 'outside-link.txt');
    await symlink(outsidePath, linkPath);

    await expect(
      readOfficialDesktopFileBinary(runtime, { hostId: 'remote', path: outsidePath }),
    ).rejects.toThrow('Only the local execution host');
    await expect(
      readOfficialDesktopFileBinary(runtime, { hostId: 'local', path: outsidePath }),
    ).rejects.toThrow('outside the user root');
    await expect(
      readOfficialDesktopFileBinary(runtime, { hostId: 'local', path: linkPath }),
    ).rejects.toThrow('resolves outside the user root');
  });

  it('lists the official workspace browser shape without hidden files or symlink escapes', async () => {
    const runtime = await createRuntime();
    const project = join(runtime.workspaceRoot, 'project');
    const folder = join(project, 'folder');
    await mkdir(folder, { recursive: true });
    await Promise.all([
      writeFile(join(project, 'visible.txt'), 'visible'),
      writeFile(join(project, '.hidden.txt'), 'hidden'),
    ]);
    const outsideRoot = await mkdtemp(join(tmpdir(), 'codexapp-directory-outside-'));
    roots.push(outsideRoot);
    await symlink(outsideRoot, join(project, 'outside-folder'));

    await expect(
      readOfficialWorkspaceDirectoryEntries(runtime, {
        hostId: 'local',
        workspaceRoot: project,
        directoryPath: '',
      }),
    ).resolves.toEqual({
      workspaceRoot: project,
      directoryPath: '',
      parentPath: null,
      entries: [
        { isSymlink: false, name: 'folder', path: 'folder', type: 'directory' },
        { isSymlink: false, name: 'visible.txt', path: 'visible.txt', type: 'file' },
      ],
    });
    await expect(
      readOfficialWorkspaceDirectoryEntries(runtime, {
        hostId: 'local',
        workspaceRoot: project,
        directoryPath: '../',
      }),
    ).rejects.toThrow('must be relative');
  });
});

async function createRuntime(): Promise<{ root: string; workspaceRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), 'codexapp-desktop-files-'));
  roots.push(root);
  const workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot);
  return { root, workspaceRoot };
}
