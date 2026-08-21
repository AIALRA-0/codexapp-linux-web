import { chmod, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatGptProjectFilesService } from './chatgpt-project-files.js';
import type { HostDownloadRequest } from './network.js';
import type { UserRuntime } from './runtime.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (path) => rm(path, { force: true, recursive: true })),
  );
});

async function createHarness(files: Record<string, Uint8Array>): Promise<{
  codexHome: string;
  downloadRequests: HostDownloadRequest[];
  runtime: UserRuntime;
}> {
  const codexHome = await mkdtemp(join(tmpdir(), 'codex-chatgpt-projects-'));
  temporaryRoots.push(codexHome);
  const downloadRequests: HostDownloadRequest[] = [];
  const runtime = {
    codexHome,
    downloadChatGptProjectFile: (request: HostDownloadRequest) => {
      downloadRequests.push(request);
      const fileId = new URL(request.downloadUrl).searchParams.get('fileId') ?? '';
      const bytes = files[fileId];
      if (bytes === undefined) throw new Error(`No test file for ${fileId}`);
      return Promise.resolve(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      );
    },
  } as unknown as UserRuntime;
  return { codexHome, downloadRequests, runtime };
}

function syncRequest(
  files: { fileId: string; name: string }[],
  callback: (fileId: string) => unknown,
): Record<string, unknown> {
  return {
    files,
    getFileDownloadRequest: callback,
    instructions: 'Use the supplied reference files.',
    projectId: 'project-1',
    projectName: 'Official project',
  };
}

describe('official ChatGPT project file synchronization', () => {
  it('matches official sanitization, read-only layout, metadata, and callback disposal', async () => {
    const { codexHome, downloadRequests, runtime } = await createHarness({
      one: new TextEncoder().encode('one'),
      two: new TextEncoder().encode('two'),
      three: new TextEncoder().encode('three'),
      four: new TextEncoder().encode('four'),
    });
    const callback = vi.fn((fileId: string) => ({
      downloadUrl: `https://files.oaiusercontent.com/file?fileId=${fileId}`,
      requestHeaders: { Accept: 'application/octet-stream' },
    }));
    const dispose = vi.fn();
    Reflect.set(callback, Symbol.for('dispose'), dispose);
    const service = new ChatGptProjectFilesService(runtime);
    const result = await service.sync(
      syncRequest(
        [
          { fileId: 'one', name: '../AGENTS.md' },
          { fileId: 'two', name: 'bad:name.txt' },
          { fileId: 'three', name: 'BAD:NAME.txt' },
          { fileId: 'four', name: 'con.txt' },
        ],
        callback,
      ),
    );

    expect(result.rootPath).toBe(join(codexHome, '.chatgpt-projects', 'project-1'));
    const sourcesPath = join(result.rootPath, 'sources');
    await expect(readdir(sourcesPath)).resolves.toEqual([
      'AGENTS (project file).md',
      'BAD_NAME (2).txt',
      '_con.txt',
      'bad_name.txt',
    ]);
    await expect(readFile(join(sourcesPath, 'bad_name.txt'), 'utf8')).resolves.toBe('two');
    await expect(readFile(join(result.rootPath, 'AGENTS.md'), 'utf8')).resolves.toContain(
      'Use the supplied reference files.',
    );
    expect((await stat(join(result.rootPath, 'AGENTS.md'))).mode & 0o777).toBe(0o444);
    expect((await stat(join(sourcesPath, 'bad_name.txt'))).mode & 0o777).toBe(0o444);
    const metadataPath = join(codexHome, '.chatgpt-projects', '.metadata', 'project-1.json');
    expect((await stat(metadataPath)).mode & 0o777).toBe(0o600);
    const metadata = await readFile(metadataPath, 'utf8');
    expect(metadata).toContain('"version":1');
    expect(metadata).toContain('"fileId":"one","name":"AGENTS (project file).md"');
    expect(metadata).toMatch(/"sha256":"[a-f0-9]{64}"/u);
    expect(downloadRequests).toHaveLength(4);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('reuses verified files and re-downloads a locally changed source', async () => {
    const bytes = { one: new TextEncoder().encode('original') };
    const { codexHome, runtime } = await createHarness(bytes);
    const service = new ChatGptProjectFilesService(runtime);
    const firstCallback = vi.fn((fileId: string) => ({
      downloadUrl: `https://files.oaiusercontent.com/file?fileId=${fileId}`,
    }));
    await service.sync(syncRequest([{ fileId: 'one', name: 'one.txt' }], firstCallback));

    const cachedCallback = vi.fn(() => {
      throw new Error('verified file should be reused');
    });
    await service.sync(syncRequest([{ fileId: 'one', name: 'renamed.txt' }], cachedCallback));
    expect(cachedCallback).not.toHaveBeenCalled();
    const sourcePath = join(codexHome, '.chatgpt-projects', 'project-1', 'sources', 'renamed.txt');
    await chmod(sourcePath, 0o644);
    await writeFile(sourcePath, 'changed');

    const repairCallback = vi.fn((fileId: string) => ({
      downloadUrl: `https://files.oaiusercontent.com/file?fileId=${fileId}`,
    }));
    await service.sync(syncRequest([{ fileId: 'one', name: 'one.txt' }], repairCallback));
    expect(repairCallback).toHaveBeenCalledOnce();
    await expect(
      readFile(join(codexHome, '.chatgpt-projects', 'project-1', 'sources', 'one.txt'), 'utf8'),
    ).resolves.toBe('original');
  });

  it('keeps the previous project intact when a replacement download fails', async () => {
    const { codexHome, runtime } = await createHarness({
      one: new TextEncoder().encode('stable'),
    });
    const service = new ChatGptProjectFilesService(runtime);
    await service.sync(
      syncRequest([{ fileId: 'one', name: 'stable.txt' }], (fileId) => ({
        downloadUrl: `https://files.oaiusercontent.com/file?fileId=${fileId}`,
      })),
    );
    await expect(
      service.sync(
        syncRequest([{ fileId: 'missing', name: 'replacement.txt' }], (fileId) => ({
          downloadUrl: `https://files.oaiusercontent.com/file?fileId=${fileId}`,
        })),
      ),
    ).rejects.toThrow('No test file for missing');
    await expect(
      readFile(join(codexHome, '.chatgpt-projects', 'project-1', 'sources', 'stable.txt'), 'utf8'),
    ).resolves.toBe('stable');
    expect(
      (await readdir(join(codexHome, '.chatgpt-projects'))).filter((name) =>
        name.includes('-staging-'),
      ),
    ).toEqual([]);
  });

  it('rejects project IDs that could escape the official project root', async () => {
    const { runtime } = await createHarness({});
    const service = new ChatGptProjectFilesService(runtime);
    await expect(
      service.sync({
        ...syncRequest([], () => ({})),
        projectId: '../outside',
      }),
    ).rejects.toThrow('Invalid ChatGPT project ID');
  });
});
