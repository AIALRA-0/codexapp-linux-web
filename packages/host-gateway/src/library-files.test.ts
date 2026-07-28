import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LibraryFilesService } from './library-files.js';
import type { UserRuntime } from './runtime.js';

const temporaryRoots: string[] = [];
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (path) => rm(path, { force: true, recursive: true })),
  );
});

async function createHarness(options?: {
  configured?: Record<string, string>;
  threads?: { cwd: string; id: string }[];
}): Promise<{
  codexHome: string;
  root: string;
  runtime: UserRuntime;
  workspaceRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'codex-library-files-'));
  temporaryRoots.push(root);
  const codexHome = join(root, 'codex-home');
  const workspaceRoot = join(root, 'workspace');
  await Promise.all([
    mkdir(codexHome, { recursive: true }),
    mkdir(workspaceRoot, { recursive: true }),
  ]);
  const threads = options?.threads ?? [];
  const runtime = {
    codexHome,
    root,
    workspaceRoot,
    getGlobalState: (key: string) =>
      key === 'thread-projectless-output-directories' ? options?.configured : undefined,
    requestAppServer: (method: string, params: unknown) => {
      if (method !== 'thread/list') throw new Error(`Unexpected app-server method: ${method}`);
      const request = params as { cursor?: unknown };
      if (request.cursor !== null) throw new Error('Unexpected pagination cursor');
      return Promise.resolve({ data: threads, nextCursor: null });
    },
  } as unknown as UserRuntime;
  return { codexHome, root, runtime, workspaceRoot };
}

describe('official generated file Library service', () => {
  it('lists only supported generated images and preserves official thread grouping', async () => {
    const { codexHome, runtime } = await createHarness();
    const generated = join(codexHome, 'generated_images');
    await mkdir(join(generated, 'thread-1'), { recursive: true });
    await Promise.all([
      writeFile(join(generated, 'thread-1', 'image.png'), ONE_PIXEL_PNG),
      writeFile(join(generated, 'thread-1', 'notes.txt'), 'not an image'),
    ]);
    await symlink(join(generated, 'thread-1', 'image.png'), join(generated, 'linked.png'));

    const images = await new LibraryFilesService(runtime).listGeneratedImages();
    expect(images).toHaveLength(1);
    const imagePath = await realpath(join(generated, 'thread-1', 'image.png'));
    expect(images[0]).toMatchObject({
      desktopPath: imagePath,
      name: 'image.png',
      path: imagePath,
      relativePath: join('thread-1', 'image.png'),
      sizeBytes: ONE_PIXEL_PNG.byteLength,
      threadId: 'thread-1',
    });
  });

  it('lists thread output files inside the server workspace and rejects external paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-library-layout-'));
    temporaryRoots.push(root);
    const workspaceRoot = join(root, 'workspace');
    const project = join(workspaceRoot, 'project');
    const sharedOutputs = join(project, 'outputs');
    const customOutputs = join(workspaceRoot, 'custom');
    const externalOutputs = join(root, 'external');
    await Promise.all([
      mkdir(sharedOutputs, { recursive: true }),
      mkdir(join(customOutputs, 'nested'), { recursive: true }),
      mkdir(externalOutputs, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(sharedOutputs, 'shared.txt'), 'shared'),
      writeFile(join(customOutputs, 'nested', 'custom.txt'), 'custom'),
      writeFile(join(externalOutputs, 'secret.txt'), 'secret'),
    ]);
    const { runtime } = await createHarness({
      configured: {
        'thread-3': customOutputs,
        'thread-external': externalOutputs,
      },
      threads: [
        { cwd: project, id: 'thread-1' },
        { cwd: project, id: 'thread-2' },
        { cwd: project, id: 'thread-3' },
        { cwd: project, id: 'thread-external' },
      ],
    });
    Object.assign(runtime, { workspaceRoot });

    const files = await new LibraryFilesService(runtime).listOutputFiles();
    expect(files).toHaveLength(2);
    expect(files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'shared.txt',
          path: join(sharedOutputs, 'shared.txt'),
          threadId: null,
        }),
        expect.objectContaining({
          name: 'custom.txt',
          path: join(customOutputs, 'nested', 'custom.txt'),
          relativePath: join('nested', 'custom.txt'),
          threadId: 'thread-3',
        }),
      ]),
    );
  });

  it('generates bounded PNG thumbnails and securely prepares and releases previews', async () => {
    const { root, runtime, workspaceRoot } = await createHarness();
    const project = join(workspaceRoot, 'project');
    const outputs = join(project, 'outputs');
    await mkdir(outputs, { recursive: true });
    const sourcePath = join(outputs, 'image.png');
    await writeFile(sourcePath, ONE_PIXEL_PNG);
    Object.assign(runtime, {
      requestAppServer: () =>
        Promise.resolve({
          data: [{ cwd: project, id: 'thread-1' }],
          nextCursor: null,
        }),
    });
    const service = new LibraryFilesService(runtime);

    const thumbnail = await service.getThumbnailDataUrl({
      size: 'compact',
      sourcePath,
    });
    expect(thumbnail.dataUrl).toMatch(/^data:image\/png;base64,/u);
    const { previewPath } = await service.prepareFilePreview({ sourcePath });
    expect(previewPath.startsWith(join(root, 'library-previews'))).toBe(true);
    await expect(readFile(previewPath)).resolves.toEqual(ONE_PIXEL_PNG);
    await service.releaseFilePreview({ previewPath });
    await expect(stat(previewPath)).rejects.toThrow();
  });

  it('refuses symbolic-link previews even when their target is allowed', async () => {
    const { runtime, workspaceRoot } = await createHarness();
    const outputs = join(workspaceRoot, 'project', 'outputs');
    await mkdir(outputs, { recursive: true });
    const sourcePath = join(outputs, 'source.txt');
    const linkedPath = join(outputs, 'linked.txt');
    await writeFile(sourcePath, 'safe');
    await symlink(sourcePath, linkedPath);
    Object.assign(runtime, {
      requestAppServer: () =>
        Promise.resolve({
          data: [{ cwd: join(workspaceRoot, 'project'), id: 'thread-1' }],
          nextCursor: null,
        }),
    });

    await expect(
      new LibraryFilesService(runtime).prepareFilePreview({ sourcePath: linkedPath }),
    ).rejects.toThrow('Library file is unavailable');
  });
});
