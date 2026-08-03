import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  readOfficialDesktopFile,
  readOfficialDesktopFileBinary,
  readOfficialDesktopFileMetadata,
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
});

async function createRuntime(): Promise<{ root: string; workspaceRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), 'codexapp-desktop-files-'));
  roots.push(root);
  const workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot);
  return { root, workspaceRoot };
}
