import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertOfficialElectronNetworkUrl,
  buildElectronNetworkProcess,
  OfficialElectronNetwork,
  parseElectronNetworkLine,
} from './electron-network.js';

const options = {
  electronBin: '/runtime/electron',
  workerPath: '/release/scripts/electron-net-worker.cjs',
  userDataDir: '/state/electron-network',
  expectedElectronVersion: '43.2.0',
  expectedChromiumVersion: '150.0.7871.129',
};

describe('official Electron network protocol', () => {
  it('accepts a versioned ready frame and ignores unrelated Chromium output', () => {
    expect(
      parseElectronNetworkLine(
        'CODEX_ELECTRON_NET_V1 ' +
          JSON.stringify({
            type: 'ready',
            electronVersion: '43.2.0',
            chromiumVersion: '150.0.7871.129',
          }),
      ),
    ).toEqual({
      type: 'ready',
      electronVersion: '43.2.0',
      chromiumVersion: '150.0.7871.129',
    });
    expect(parseElectronNetworkLine('[chromium diagnostic]')).toBeNull();
    expect(parseElectronNetworkLine('CODEX_ELECTRON_NET_V1 {"type":"ready"}')).toBeNull();
  });

  it('allows only the official ChatGPT backend API boundary', () => {
    for (const target of [
      'https://chatgpt.com/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=0&cursor=opaque',
      'https://chatgpt.com/backend-api/projects/project-id/files',
      'https://chatgpt.com/backend-api/subscriptions/auto_top_up/settings?include_payment_method=false',
    ]) {
      expect(() => assertOfficialElectronNetworkUrl(new URL(target))).not.toThrow();
    }
    for (const target of [
      'http://chatgpt.com/backend-api/gizmos/snorlax/sidebar',
      'https://chatgpt.com:8443/backend-api/gizmos/snorlax/sidebar',
      'https://openai.com/backend-api/gizmos/snorlax/sidebar',
      'https://chatgpt.com/backend-api',
      'https://chatgpt.com/public-api/projects',
      'https://user:password@chatgpt.com/backend-api/projects',
      'https://chatgpt.com/backend-api/gizmos/snorlax/sidebar#fragment',
    ]) {
      expect(() => assertOfficialElectronNetworkUrl(new URL(target))).toThrow();
    }
  });

  it('keeps the Chromium sandbox enabled and gives the worker a sealed environment', () => {
    const processConfig = buildElectronNetworkProcess(options, '/safe-tmp');
    expect(processConfig.args).not.toContain('--no-sandbox');
    expect(processConfig.args).toContain('--disable-setuid-sandbox');
    expect(processConfig.args.at(-1)).toBe(options.workerPath);
    expect(processConfig.env).toEqual({
      HOME: options.userDataDir,
      TMPDIR: '/safe-tmp',
      LANG: 'C.UTF-8',
      CODEX_ELECTRON_NET_USER_DATA_DIR: options.userDataDir,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    });
  });

  it('does not send authenticated requests before the child version is verified', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-electron-network-test-'));
    const fakeElectron = join(root, 'fake-electron');
    const fakeWorker = join(root, 'fake-worker.cjs');
    const nodePath = process.execPath.replaceAll('"', '\\"');
    await writeFile(fakeElectron, `#!/bin/sh\nexec "${nodePath}" "${fakeWorker}"\n`, {
      mode: 0o700,
    });
    await chmod(fakeElectron, 0o700);
    await writeFile(
      fakeWorker,
      [
        "const readline = require('node:readline');",
        "const marker = 'CODEX_ELECTRON_NET_V1 ';",
        'let ready = false;',
        'let requestsBeforeReady = 0;',
        'const buffered = [];',
        'const respond = (message) => {',
        '  process.stdout.write(marker + JSON.stringify({',
        "    type: 'response-start',",
        '    id: message.id,',
        '    status: 200,',
        "    statusText: 'OK',",
        "    headers: [['content-type', 'application/json']],",
        "  }) + '\\n');",
        "  if (message.method !== 'HEAD') {",
        '    process.stdout.write(marker + JSON.stringify({',
        "      type: 'response-chunk',",
        '      id: message.id,',
        '      bodyBase64: Buffer.from(JSON.stringify({',
        '        requestsBeforeReady,',
        '        method: message.method,',
        "        body: message.bodyBase64 === undefined ? null : Buffer.from(message.bodyBase64, 'base64').toString(),",
        "      })).toString('base64'),",
        "    }) + '\\n');",
        '  }',
        "  process.stdout.write(marker + JSON.stringify({ type: 'response-end', id: message.id }) + '\\n');",
        '};',
        'const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });',
        "input.on('line', (line) => {",
        '  const message = JSON.parse(line);',
        "  if (message.type !== 'fetch') return;",
        '  if (!ready) { requestsBeforeReady += 1; buffered.push(message); return; }',
        '  respond(message);',
        '});',
        'setTimeout(() => {',
        '  ready = true;',
        '  process.stdout.write(marker + JSON.stringify({',
        "    type: 'ready',",
        "    electronVersion: '43.2.0',",
        "    chromiumVersion: '150.0.7871.129',",
        "  }) + '\\n');",
        '  for (const message of buffered) respond(message);',
        '}, 100);',
      ].join('\n'),
      { mode: 0o600 },
    );
    const client = new OfficialElectronNetwork({
      ...options,
      electronBin: fakeElectron,
      workerPath: fakeWorker,
      userDataDir: join(root, 'state'),
    });
    try {
      const responses = await Promise.all([
        client.fetch('https://chatgpt.com/backend-api/gizmos/snorlax/sidebar?limit=1', {
          headers: { Authorization: 'Bearer test-one' },
        }),
        client.fetch('https://chatgpt.com/backend-api/projects', {
          method: 'POST',
          headers: { Authorization: 'Bearer test-two' },
          body: JSON.stringify({ name: 'test project' }),
        }),
      ]);
      await expect(Promise.all(responses.map((response) => response.json()))).resolves.toEqual([
        { requestsBeforeReady: 0, method: 'GET', body: null },
        {
          requestsBeforeReady: 0,
          method: 'POST',
          body: JSON.stringify({ name: 'test project' }),
        },
      ]);
      const headResponse = await client.fetch('https://chatgpt.com/backend-api/projects', {
        method: 'HEAD',
      });
      await expect(headResponse.text()).resolves.toBe('');

      const alreadyAborted = new AbortController();
      alreadyAborted.abort();
      await expect(
        client.fetch('https://chatgpt.com/backend-api/projects', {
          signal: alreadyAborted.signal,
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      await client.stop();
      await rm(root, { force: true, recursive: true });
    }
  });
});
