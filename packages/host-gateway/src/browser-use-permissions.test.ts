import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  readBrowserPermissionSnapshot,
  updateBrowserPermissionRules,
  writeBrowserApprovalMode,
  writeBrowserFileTransferApprovalMode,
  writeBrowserFullCdpAccessEnabled,
  writeBrowserHistoryApprovalMode,
} from './browser-use-permissions.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (path) => rm(path, { force: true, recursive: true })),
  );
});

describe('official Browser Use permission persistence', () => {
  it('matches the official empty state and all direct setting mutations', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-browser-permissions-'));
    temporaryRoots.push(codexHome);

    await expect(readBrowserPermissionSnapshot(codexHome)).resolves.toEqual({
      fullCdpAccessEnabled: false,
      approvalMode: 'alwaysAsk',
      historyApprovalMode: 'alwaysAsk',
      downloadApprovalMode: 'alwaysAsk',
      uploadApprovalMode: 'alwaysAsk',
      allowedOrigins: [],
      deniedOrigins: [],
      allowedDownloadOrigins: [],
      deniedDownloadOrigins: [],
      allowedUploadOrigins: [],
      deniedUploadOrigins: [],
      allowedFullCdpOrigins: [],
      deniedFullCdpOrigins: [],
    });

    await writeBrowserApprovalMode(codexHome, 'neverAsk');
    await writeBrowserHistoryApprovalMode(codexHome, 'neverAsk');
    await writeBrowserFileTransferApprovalMode(codexHome, 'download', 'neverAsk');
    await writeBrowserFileTransferApprovalMode(codexHome, 'upload', 'neverAsk');
    await writeBrowserFullCdpAccessEnabled(codexHome, true);
    const snapshot = await updateBrowserPermissionRules(codexHome, [
      {
        action: 'add',
        kind: 'allowed',
        origin: 'example.com/path',
        resource: 'origin',
      },
    ]);

    expect(snapshot).toMatchObject({
      fullCdpAccessEnabled: true,
      approvalMode: 'neverAsk',
      historyApprovalMode: 'neverAsk',
      downloadApprovalMode: 'neverAsk',
      uploadApprovalMode: 'neverAsk',
      allowedOrigins: ['https://example.com'],
    });
    const config = await readFile(join(codexHome, 'browser', 'config.toml'), 'utf8');
    expect(config).toContain('approval_mode = "never_ask"');
    expect(config).toContain('history_approval_mode = "never_ask"');
    expect(config).toContain('download_approval_mode = "never_ask"');
    expect(config).toContain('upload_approval_mode = "never_ask"');
    expect(config).toContain('full_cdp_access_enabled = true');
  });

  it('rejects invalid approval and origin values without changing state', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-browser-permissions-'));
    temporaryRoots.push(codexHome);

    await expect(writeBrowserApprovalMode(codexHome, 'sometimes')).rejects.toThrow(
      'approval mode is invalid',
    );
    await expect(
      updateBrowserPermissionRules(codexHome, [
        {
          action: 'add',
          kind: 'allowed',
          origin: 'file:///etc/passwd',
          resource: 'origin',
        },
      ]),
    ).rejects.toThrow('Invalid Browser Use origin');
    await expect(readBrowserPermissionSnapshot(codexHome)).resolves.toMatchObject({
      approvalMode: 'alwaysAsk',
      allowedOrigins: [],
    });
  });
});
