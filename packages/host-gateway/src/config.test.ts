import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function environment() {
  const root = await mkdtemp(join(tmpdir(), 'codex-gateway-config-'));
  temporaryDirectories.push(root);
  const sessionKey = join(root, 'session.key');
  const proxySecret = join(root, 'proxy.secret');
  await Promise.all([
    writeFile(sessionKey, Buffer.alloc(32, 7)),
    writeFile(proxySecret, '0123456789abcdef0123456789abcdef0123456789abcdef\n'),
  ]);
  return {
    root,
    proxySecret,
    values: {
      NODE_ENV: 'production',
      DEV_IDENTITY: 'must-not-be-enabled',
      PUBLIC_ORIGIN: 'https://codexapp.example.com',
      OFFICIAL_ROOT: join(root, 'official', 'webview'),
      OFFICIAL_SOURCE_ROOT: join(root, 'official'),
      RUNTIME_ROOT: join(root, 'runtime'),
      CODEX_BIN: join(root, 'codex'),
      EXPECTED_RENDERER_VERSION: '26.721.31836',
      EXPECTED_CODEX_VERSION: 'codex-cli 0.146.0-alpha.3.1',
      EXPECTED_BUILD_NUMBER: '5828',
      EXPECTED_BUILD_FLAVOR: 'prod',
      EXPECTED_APP_BRAND: 'chatgpt',
      SOURCE_MANIFEST: join(root, 'source-manifest.json'),
      BROWSER_BRIDGE_SCRIPT: join(root, 'bridge.js'),
      SESSION_SIGNING_KEY_FILE: sessionKey,
      AUTH_PROXY_SECRET_FILE: proxySecret,
    },
  };
}

describe('gateway production configuration', () => {
  it('ignores development identity bypass and trims the private proxy proof file', async () => {
    const fixture = await environment();
    const config = loadConfig(fixture.values);
    expect(config.devIdentity).toBeUndefined();
    expect(config.authProxySecret?.toString()).toBe(
      '0123456789abcdef0123456789abcdef0123456789abcdef',
    );
    expect(config.authProxySecretFile).toBe(fixture.proxySecret);
  });

  it('rejects a proxy proof that is too short', async () => {
    const fixture = await environment();
    await writeFile(fixture.proxySecret, 'short\n');
    expect(() => loadConfig(fixture.values)).toThrow('proxy secret');
  });

  it('accepts only a credential-free loopback OpenAI egress proxy', async () => {
    const fixture = await environment();
    expect(
      loadConfig({
        ...fixture.values,
        OPENAI_EGRESS_PROXY_URL: 'http://127.0.0.1:40000',
      }).openAiEgressProxyUrl,
    ).toBe('http://127.0.0.1:40000');
    expect(() =>
      loadConfig({
        ...fixture.values,
        OPENAI_EGRESS_PROXY_URL: 'http://proxy.example.com:40000',
      }),
    ).toThrow('loopback');
    expect(() =>
      loadConfig({
        ...fixture.values,
        OPENAI_EGRESS_PROXY_URL: 'http://user:secret@127.0.0.1:40000',
      }),
    ).toThrow('credentials');
  });

  it('requires the complete version-locked Electron network configuration', async () => {
    const fixture = await environment();
    expect(() =>
      loadConfig({
        ...fixture.values,
        ELECTRON_NET_BIN: join(fixture.root, 'electron'),
      }),
    ).toThrow('Electron network requires');
    const config = loadConfig({
      ...fixture.values,
      ELECTRON_NET_BIN: join(fixture.root, 'electron'),
      ELECTRON_NET_WORKER: join(fixture.root, 'electron-worker.cjs'),
      ELECTRON_NET_USER_DATA_DIR: join(fixture.root, 'electron-data'),
      ELECTRON_NET_EXPECTED_VERSION: '43.2.0',
      ELECTRON_NET_EXPECTED_CHROMIUM_VERSION: '150.0.7871.129',
    });
    expect(config.expectedElectronNetVersion).toBe('43.2.0');
    expect(config.expectedElectronNetChromiumVersion).toBe('150.0.7871.129');
  });
});
