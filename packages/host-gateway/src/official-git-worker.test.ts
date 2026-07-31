import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  isOfficialGitWorkerInput,
  OfficialGithubService,
  OfficialGitWorker,
} from './official-git-worker.js';

const execFileAsync = promisify(execFile);
const sourceRoot =
  process.env.OFFICIAL_TEST_SOURCE_ROOT ??
  resolve(process.cwd(), '.official', 'releases', '26.721.81911', 'source');
const describeQualified = existsSync(join(sourceRoot, '.vite', 'build', 'worker.js'))
  ? describe
  : describe.skip;
const temporaryRoots: string[] = [];
const workers: OfficialGitWorker[] = [];

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.stop();
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

describe('official Git worker input boundary', () => {
  it('accepts official request and cancellation envelopes', () => {
    expect(
      isOfficialGitWorkerInput({
        type: 'worker-request',
        workerId: 'git',
        request: { id: 'one', method: 'status-summary', params: { cwd: '/workspace' } },
      }),
    ).toBe(true);
    expect(
      isOfficialGitWorkerInput({
        type: 'worker-request-cancel',
        workerId: 'git',
        id: 'one',
      }),
    ).toBe(true);
  });

  it('rejects other workers and malformed requests', () => {
    expect(
      isOfficialGitWorkerInput({
        type: 'worker-request',
        workerId: 'open-in',
        request: { id: 'one', method: 'status-summary', params: {} },
      }),
    ).toBe(false);
    expect(
      isOfficialGitWorkerInput({
        type: 'worker-request',
        workerId: 'git',
        request: { id: 'one', method: 'status-summary', params: null },
      }),
    ).toBe(false);
  });
});

describeQualified('official Git worker runtime', () => {
  it('runs GitHub CLI qualification through the unchanged official service', async () => {
    const userRoot = await mkdtemp(join(tmpdir(), 'codexapp-official-github-'));
    temporaryRoots.push(userRoot);
    const codexHome = join(userRoot, 'codex-home');
    const workspaceRoot = join(userRoot, 'workspace');
    await Promise.all([
      mkdir(codexHome, { recursive: true }),
      mkdir(workspaceRoot, { recursive: true }),
      mkdir(join(userRoot, 'home'), { recursive: true }),
      mkdir(join(userRoot, 'tmp'), { recursive: true }),
    ]);
    const service = new OfficialGithubService({
      sourceRoot,
      userRoot,
      codexHome,
      workspaceRoot,
      appVersion: '26.721.31836',
      buildNumber: '5828',
      buildFlavor: 'prod',
    });
    const request = service.request(
      'gh-cli-status',
      { hostId: 'local', hostname: 'github.com' },
      'qualification',
    );
    const status = await request.wait();
    expect(status).not.toBeNull();
    expect(typeof (status as Record<string, unknown>).isInstalled).toBe('boolean');
    expect(typeof (status as Record<string, unknown>).isAuthenticated).toBe('boolean');
  });

  it('creates, owns, and deletes a real managed worktree through the official worker', async () => {
    const userRoot = await mkdtemp(join(tmpdir(), 'codexapp-official-git-worker-'));
    temporaryRoots.push(userRoot);
    const codexHome = join(userRoot, 'codex-home');
    const workspaceRoot = join(userRoot, 'workspace');
    const repository = join(workspaceRoot, 'qualification-repository');
    await mkdir(repository, { recursive: true });
    await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: repository });
    await execFileAsync('git', ['config', 'user.name', 'Codex Qualification'], {
      cwd: repository,
    });
    await execFileAsync('git', ['config', 'user.email', 'qualification@example.invalid'], {
      cwd: repository,
    });
    await writeFile(join(repository, 'qualification.txt'), 'official worktree qualification\n');
    await execFileAsync('git', ['add', 'qualification.txt'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'qualification'], { cwd: repository });
    await execFileAsync(
      'git',
      ['remote', 'add', 'origin', 'https://example.invalid/qualification.git'],
      { cwd: repository },
    );
    const canonicalRepository = await realpath(repository);

    const worker = new OfficialGitWorker({
      sourceRoot,
      userRoot,
      codexHome,
      workspaceRoot,
      appVersion: '26.721.31836',
      buildNumber: '5828',
      buildFlavor: 'prod',
    });
    worker.on('error', () => undefined);
    workers.push(worker);

    await expect(
      worker.request('stable-metadata', {
        cwd: repository,
        operationSource: 'qualification',
      }),
    ).resolves.toMatchObject({ root: canonicalRepository });
    await expect(
      worker.request('current-branch-snapshot', {
        root: repository,
        operationSource: 'qualification',
      }),
    ).resolves.toEqual({ branch: 'main' });
    await expect(
      worker.request('git-origins', {
        dirs: [repository],
        operationSource: 'qualification',
      }),
    ).resolves.toMatchObject({
      origins: [
        {
          dir: repository,
          root: canonicalRepository,
          originUrl: 'https://example.invalid/qualification.git',
        },
      ],
    });

    const created = (await worker.request(
      'create-worktree',
      {
        operationSource: 'automation',
        cwd: repository,
        startingState: { type: 'branch', branchName: 'main' },
        localEnvironmentConfigPath: null,
        streamId: 'qualification-worktree',
        worktreesRoot: '',
      },
      { timeoutMs: 120_000 },
    )) as {
      worktreeGitRoot: string;
      worktreeWorkspaceRoot: string;
      setupError: string | null;
    };
    expect(created.setupError).toBeNull();
    expect(relative(join(codexHome, 'worktrees'), created.worktreeGitRoot)).not.toMatch(
      /^\.\.(?:[/\\]|$)/u,
    );
    const qualificationFile = await stat(join(created.worktreeWorkspaceRoot, 'qualification.txt'));
    expect(qualificationFile.size).toBeGreaterThan(0);
    await expect(
      worker.request('set-worktree-owner-thread', {
        worktree: created.worktreeGitRoot,
        conversationId: '019fa27f-3dd9-7412-b965-53e810a672bb',
        operationSource: 'worktree_set_owner_thread',
      }),
    ).resolves.toEqual({ success: true });
    await expect(
      worker.request('delete-worktree', {
        worktree: created.worktreeGitRoot,
        force: true,
        reason: 'archive-cleanup',
        operationSource: 'worktree_archive_cleanup',
      }),
    ).resolves.toMatchObject({ success: true });
    expect(existsSync(created.worktreeGitRoot)).toBe(false);
  }, 30_000);
});
