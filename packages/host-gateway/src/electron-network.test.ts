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

  it('allows only the exact official projects endpoint', () => {
    expect(() =>
      assertOfficialElectronNetworkUrl(
        new URL('https://chatgpt.com/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=0'),
      ),
    ).not.toThrow();
    for (const target of [
      'http://chatgpt.com/backend-api/gizmos/snorlax/sidebar',
      'https://chatgpt.com:8443/backend-api/gizmos/snorlax/sidebar',
      'https://chatgpt.com/backend-api/conversation',
      'https://openai.com/backend-api/gizmos/snorlax/sidebar',
      'https://chatgpt.com/backend-api/gizmos/snorlax/sidebar?unexpected=value',
      'https://chatgpt.com/backend-api/gizmos/snorlax/sidebar?limit=10&limit=20',
      'https://chatgpt.com/backend-api/gizmos/snorlax/sidebar?owned_only=maybe',
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
        "    type: 'response',",
        '    id: message.id,',
        '    status: 200,',
        "    statusText: 'OK',",
        "    headers: [['content-type', 'application/json']],",
        "    bodyBase64: Buffer.from(JSON.stringify({ requestsBeforeReady })).toString('base64'),",
        "  }) + '\\n');",
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
        client.fetch('https://chatgpt.com/backend-api/gizmos/snorlax/sidebar?limit=2', {
          headers: { Authorization: 'Bearer test-two' },
        }),
      ]);
      await expect(Promise.all(responses.map((response) => response.json()))).resolves.toEqual([
        { requestsBeforeReady: 0 },
        { requestsBeforeReady: 0 },
      ]);
    } finally {
      await client.stop();
      await rm(root, { force: true, recursive: true });
    }
  });
});
