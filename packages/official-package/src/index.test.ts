import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  extractElectronBridgeMethods,
  extractPreloadChannels,
  sha256Buffer,
  sha256File,
  verifyPreparedRelease,
} from './index.js';

describe('official package verification', () => {
  it('derives the exposed bridge methods from the actual preload object', () => {
    const source = `
      const readTheme = () => 'dark';
      const bridge = {
        windowType: 'electron',
        sendMessageFromView: async message => message,
        getSystemThemeVariant: readTheme,
        "showContextMenu": async (menu) => menu,
      };
      contextBridge.exposeInMainWorld('electronBridge', bridge);
    `;

    expect(extractElectronBridgeMethods(source)).toEqual([
      'getSystemThemeVariant',
      'sendMessageFromView',
      'showContextMenu',
    ]);
  });

  it('rejects a preload that does not expose the official bridge', () => {
    expect(() => extractElectronBridgeMethods('const bridge = {};')).toThrow(
      'official preload did not expose electronBridge',
    );
  });

  it('extracts and sorts official IPC channel names', () => {
    expect(
      extractPreloadChannels('`codex_desktop:z`; `codex_desktop:a`; `codex_desktop:z`;'),
    ).toEqual(['codex_desktop:a', 'codex_desktop:z']);
  });

  it('uses stable SHA-256 bytes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'official-package-test-'));
    mkdirSync(join(root, 'nested'));
    const path = join(root, 'nested', 'asset.js');
    writeFileSync(path, 'official bytes');
    const expected = createHash('sha256').update('official bytes').digest('hex');

    expect(sha256Buffer(Buffer.from('official bytes'))).toBe(expected);
    await expect(sha256File(path)).resolves.toBe(expected);
  });

  it('verifies a release after its directory is moved', () => {
    const release = join(mkdtempSync(join(tmpdir(), 'official-release-test-')), 'release');
    const rendererRoot = join(release, 'source', 'webview');
    const hostRoot = join(release, 'source');
    const qualificationRoot = join(release, 'qualification');
    mkdirSync(rendererRoot, { recursive: true });
    mkdirSync(join(hostRoot, '.vite', 'build'), { recursive: true });
    mkdirSync(qualificationRoot, { recursive: true });
    const rendererPath = join(rendererRoot, 'index.html');
    const hostPath = join(hostRoot, '.vite', 'build', 'worker.js');
    const rendererBytes = Buffer.from('official renderer');
    const hostBytes = Buffer.from('official host');
    writeFileSync(rendererPath, rendererBytes);
    writeFileSync(hostPath, hostBytes);
    const rendererDigest = sha256Buffer(rendererBytes);
    const hostDigest = sha256Buffer(hostBytes);
    const rendererTree = createHash('sha256')
      .update(`index.html\0${String(rendererBytes.length)}\0${rendererDigest}\n`)
      .digest('hex');
    const hostTree = createHash('sha256')
      .update(`.vite/build/worker.js\0${String(hostBytes.length)}\0${hostDigest}\n`)
      .digest('hex');
    const manifestPath = join(qualificationRoot, 'source-manifest.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        formatVersion: 3,
        package: {
          asarPath: '/source/app.asar',
          asarSize: 1,
          asarSha256: '0'.repeat(64),
          fileCount: 2,
          version: 'test',
          buildNumber: '1',
          buildFlavor: 'prod',
          brand: 'chatgpt',
        },
        renderer: {
          root: '../source/webview',
          fileCount: 1,
          totalBytes: rendererBytes.length,
          treeSha256: rendererTree,
          files: {
            'index.html': { bytes: rendererBytes.length, sha256: rendererDigest },
          },
        },
        host: {
          root: '../source',
          fileCount: 1,
          totalBytes: hostBytes.length,
          treeSha256: hostTree,
        },
        preload: {
          contractVersion: 1,
          rendererVersion: 'test',
          appBuildNumber: '1',
          windowType: 'electron',
          methods: ['sendMessageFromView'],
          channels: [],
          sourceSha256: '0'.repeat(64),
        },
      }),
    );

    const verified = verifyPreparedRelease(manifestPath);
    expect(verified.renderer.root).toBe(rendererRoot);
    expect(verified.host.root).toBe(hostRoot);
  });

  it('verifies host trees in global path order instead of recursive directory order', () => {
    const release = join(mkdtempSync(join(tmpdir(), 'official-order-test-')), 'release');
    const rendererRoot = join(release, 'source', 'webview');
    const hostRoot = join(release, 'source');
    const qualificationRoot = join(release, 'qualification');
    mkdirSync(rendererRoot, { recursive: true });
    mkdirSync(join(hostRoot, 'node_modules', '@parcel', 'watcher-linux'), { recursive: true });
    mkdirSync(join(hostRoot, 'node_modules', '@parcel', 'watcher'), { recursive: true });
    mkdirSync(qualificationRoot, { recursive: true });

    const rendererBytes = Buffer.from('official renderer');
    writeFileSync(join(rendererRoot, 'index.html'), rendererBytes);
    const hostFiles: Record<string, Buffer> = {
      'node_modules/@parcel/watcher-linux/LICENSE': Buffer.from('linux license'),
      'node_modules/@parcel/watcher/LICENSE': Buffer.from('watcher license'),
    };
    for (const [path, value] of Object.entries(hostFiles)) {
      writeFileSync(join(hostRoot, path), value);
    }

    const rendererDigest = sha256Buffer(rendererBytes);
    const rendererTree = createHash('sha256')
      .update(`index.html\0${String(rendererBytes.length)}\0${rendererDigest}\n`)
      .digest('hex');
    const hostTreeHash = createHash('sha256');
    for (const path of Object.keys(hostFiles).sort()) {
      const value = hostFiles[path];
      if (value === undefined) throw new Error(`missing host fixture: ${path}`);
      hostTreeHash.update(`${path}\0${String(value.length)}\0${sha256Buffer(value)}\n`);
    }
    const manifestPath = join(qualificationRoot, 'source-manifest.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        formatVersion: 3,
        package: {
          asarPath: '/source/app.asar',
          asarSize: 1,
          asarSha256: '0'.repeat(64),
          fileCount: 3,
          version: 'test',
          buildNumber: '1',
          buildFlavor: 'prod',
          brand: 'chatgpt',
        },
        renderer: {
          root: '../source/webview',
          fileCount: 1,
          totalBytes: rendererBytes.length,
          treeSha256: rendererTree,
          files: {
            'index.html': { bytes: rendererBytes.length, sha256: rendererDigest },
          },
        },
        host: {
          root: '../source',
          fileCount: Object.keys(hostFiles).length,
          totalBytes: Object.values(hostFiles).reduce((total, value) => total + value.length, 0),
          treeSha256: hostTreeHash.digest('hex'),
        },
        preload: {
          contractVersion: 1,
          rendererVersion: 'test',
          appBuildNumber: '1',
          windowType: 'electron',
          methods: ['sendMessageFromView'],
          channels: [],
          sourceSha256: '0'.repeat(64),
        },
      }),
    );

    expect(() => verifyPreparedRelease(manifestPath)).not.toThrow();
  });
});
