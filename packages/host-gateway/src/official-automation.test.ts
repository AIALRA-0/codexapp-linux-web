import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { CodexAppServerClient } from '@codexapp/app-server-client';
import { afterEach, describe, expect, it } from 'vitest';

import {
  loadQualifiedAutomationTemplates,
  OfficialAutomationController,
} from './official-automation.js';
import { OfficialDesktopState } from './official-desktop-state.js';

const sourceRoot =
  process.env.OFFICIAL_TEST_SOURCE_ROOT ??
  resolve(process.cwd(), '.official', 'releases', '26.721.81911', 'source');
const describeQualified = existsSync(join(sourceRoot, '.vite', 'build', 'worker.js'))
  ? describe
  : describe.skip;
const temporaryRoots: string[] = [];
const desktopStates: OfficialDesktopState[] = [];
const controllers: OfficialAutomationController[] = [];

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.stop();
  for (const desktopState of desktopStates.splice(0)) await desktopState.stop();
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

describeQualified('OfficialAutomationController', () => {
  it('loads the version-qualified official automation prompts from the package', () => {
    const templates = loadQualifiedAutomationTemplates(sourceRoot);
    expect(templates.automationInstructions).toContain(
      '$CODEX_HOME/automations/<automation_id>/memory.md',
    );
    expect(templates.automationInstructions).toContain('::inbox-item{title=');
    expect(templates.heartbeatPromptTemplate).toContain('{{AUTOMATION_ID}}');
    expect(templates.heartbeatPromptTemplate).toContain('{{AUTOMATION_PROMPT}}');
  });

  it('runs a projectless automation through official thread and inbox state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codexapp-official-automation-'));
    temporaryRoots.push(root);
    const codexHome = join(root, 'codex-home');
    const workspaceRoot = join(root, 'workspace');
    await mkdir(workspaceRoot, { recursive: true });
    const desktopState = new OfficialDesktopState({
      officialSourceRoot: sourceRoot,
      codexHome,
      buildFlavor: 'prod',
    });
    desktopStates.push(desktopState);
    const created = (await desktopState.request('automations.create', {
      input: {
        kind: 'cron',
        name: 'Qualification automation',
        prompt: 'Run the qualification suite',
        rrule: 'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
        executionEnvironment: 'local',
        projectId: null,
        model: null,
        reasoningEffort: null,
      },
      compatibilityCwds: [],
    })) as { item: { id: string } };

    const calls: Array<{ method: string; params: unknown }> = [];
    const threadId = '019fa27f-3dd9-7412-b965-53e810a672bb';
    const fakeAppServer = {
      request: (method: string, params?: unknown): Promise<unknown> => {
        calls.push({ method, params });
        switch (method) {
          case 'model/list':
            return Promise.resolve({ data: [], nextCursor: null });
          case 'config/read':
            return Promise.resolve({ config: {} });
          case 'configRequirements/read':
            return Promise.resolve({ requirements: null });
          case 'thread/start':
            return Promise.resolve({
              thread: { id: threadId, sessionId: threadId, cwd: workspaceRoot },
              cwd: workspaceRoot,
              approvalPolicy: 'on-request',
              approvalsReviewer: 'user',
              sandbox: {
                type: 'workspaceWrite',
                writableRoots: [],
                networkAccess: false,
                excludeTmpdirEnvVar: false,
                excludeSlashTmp: false,
              },
            });
          case 'thread/name/set':
            return Promise.resolve({});
          case 'turn/start':
            return Promise.resolve({ turn: { id: 'turn-1', status: 'inProgress' } });
          default:
            return Promise.reject(new Error(`unexpected fake app-server method: ${method}`));
        }
      },
    } as unknown as CodexAppServerClient;
    const viewMessages: unknown[] = [];
    const controller = new OfficialAutomationController({
      officialSourceRoot: sourceRoot,
      userRoot: root,
      codexHome,
      workspaceRoot,
      desktopState,
      getAppServer: () => fakeAppServer,
      requestGitWorker: (method) =>
        Promise.reject(new Error(`unexpected fake Git worker method: ${method}`)),
      getGlobalState: () => undefined,
      emitViewMessage: (message) => viewMessages.push(message),
      onError: (error) => {
        throw error;
      },
    });
    controllers.push(controller);

    await expect(controller.runNow({ id: created.item.id })).resolves.toEqual({
      success: true,
    });
    expect(calls.map((call) => call.method)).toEqual([
      'model/list',
      'config/read',
      'configRequirements/read',
      'thread/start',
      'thread/name/set',
      'turn/start',
    ]);
    const turnStart = calls.find((call) => call.method === 'turn/start');
    expect(JSON.stringify(turnStart?.params)).toContain(`Automation ID: ${created.item.id}`);

    await controller.handleNotification({
      method: 'turn/completed',
      params: {
        threadId,
        turn: { id: 'turn-1', status: 'completed' },
      },
    });
    const inbox = (await desktopState.request('inbox.list', { limit: 200 })) as {
      items: Array<{ threadId: string; status: string }>;
    };
    expect(inbox.items).toEqual([
      expect.objectContaining({
        threadId,
        status: 'PENDING_REVIEW',
      }),
    ]);
    expect(viewMessages).toContainEqual({ type: 'automation-runs-updated' });
    expect(viewMessages).toContainEqual({ type: 'inbox-items-changed' });
  });

  it('runs a repository automation in an official managed worktree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codexapp-official-worktree-automation-'));
    temporaryRoots.push(root);
    const codexHome = join(root, 'codex-home');
    const workspaceRoot = join(root, 'workspace');
    const sourceCwd = join(workspaceRoot, 'source-repository');
    const sourceGitRoot = sourceCwd;
    const sourceCommonDir = join(sourceCwd, '.git');
    const worktreeGitRoot = join(codexHome, 'worktrees', 'abcd', 'source-repository');
    const worktreeWorkspaceRoot = worktreeGitRoot;
    await Promise.all([
      mkdir(sourceCwd, { recursive: true }),
      mkdir(worktreeWorkspaceRoot, { recursive: true }),
    ]);
    const desktopState = new OfficialDesktopState({
      officialSourceRoot: sourceRoot,
      codexHome,
      buildFlavor: 'prod',
    });
    desktopStates.push(desktopState);
    const created = (await desktopState.request('automations.create', {
      input: {
        kind: 'cron',
        name: 'Worktree qualification automation',
        prompt: 'Run in the managed worktree',
        rrule: 'RRULE:FREQ=DAILY;BYHOUR=10;BYMINUTE=0',
        executionEnvironment: 'worktree',
        localEnvironmentConfigPath: null,
        projectId: null,
        cwds: [sourceCwd],
        model: null,
        reasoningEffort: null,
      },
      compatibilityCwds: [],
    })) as { item: { id: string } };

    const appServerCalls: Array<{ method: string; params: unknown }> = [];
    const threadId = '019fa27f-3dd9-7412-b965-53e810a672bc';
    const fakeAppServer = {
      request: (method: string, params?: unknown): Promise<unknown> => {
        appServerCalls.push({ method, params });
        switch (method) {
          case 'model/list':
            return Promise.resolve({ data: [], nextCursor: null });
          case 'config/read':
            return Promise.resolve({
              config: {
                qualificationCwd: (params as { cwd: string }).cwd,
              },
            });
          case 'configRequirements/read':
            return Promise.resolve({ requirements: null });
          case 'thread/start':
            return Promise.resolve({
              thread: { id: threadId, sessionId: threadId, cwd: worktreeWorkspaceRoot },
              cwd: worktreeWorkspaceRoot,
              approvalPolicy: 'on-request',
              approvalsReviewer: 'user',
              sandbox: {
                type: 'workspaceWrite',
                writableRoots: [],
                networkAccess: false,
                excludeTmpdirEnvVar: false,
                excludeSlashTmp: false,
              },
            });
          case 'thread/name/set':
            return Promise.resolve({});
          case 'turn/start':
            return Promise.resolve({ turn: { id: 'turn-worktree', status: 'inProgress' } });
          default:
            return Promise.reject(new Error(`unexpected fake app-server method: ${method}`));
        }
      },
    } as unknown as CodexAppServerClient;
    const gitCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const requestGitWorker = (
      method: string,
      params: Record<string, unknown>,
    ): Promise<unknown> => {
      gitCalls.push({ method, params });
      switch (method) {
        case 'stable-metadata':
          return Promise.resolve(
            params.cwd === sourceCwd
              ? { root: sourceGitRoot, commonDir: sourceCommonDir }
              : { root: worktreeGitRoot, commonDir: sourceCommonDir },
          );
        case 'current-branch-snapshot':
          return Promise.resolve({ branch: 'main' });
        case 'create-worktree':
          return Promise.resolve({
            worktreeGitRoot,
            worktreeWorkspaceRoot,
            setupError: null,
          });
        case 'set-worktree-owner-thread':
          return Promise.resolve({ success: true });
        default:
          return Promise.reject(new Error(`unexpected fake Git worker method: ${method}`));
      }
    };
    const controller = new OfficialAutomationController({
      officialSourceRoot: sourceRoot,
      userRoot: root,
      codexHome,
      workspaceRoot,
      desktopState,
      getAppServer: () => fakeAppServer,
      requestGitWorker,
      getGlobalState: () => undefined,
      emitViewMessage: () => undefined,
      onError: (error) => {
        throw error;
      },
    });
    controllers.push(controller);

    await expect(controller.runNow({ id: created.item.id })).resolves.toEqual({
      success: true,
    });
    expect(gitCalls.map((call) => call.method)).toEqual([
      'stable-metadata',
      'current-branch-snapshot',
      'create-worktree',
      'set-worktree-owner-thread',
      'stable-metadata',
    ]);
    expect(gitCalls.find((call) => call.method === 'create-worktree')?.params).toMatchObject({
      cwd: sourceCwd,
      startingState: { type: 'branch', branchName: 'main' },
      worktreesRoot: '',
    });
    expect(
      gitCalls.find((call) => call.method === 'set-worktree-owner-thread')?.params,
    ).toMatchObject({
      worktree: worktreeGitRoot,
      conversationId: threadId,
    });
    const threadStart = appServerCalls.find((call) => call.method === 'thread/start');
    expect(threadStart?.params).toMatchObject({
      cwd: worktreeWorkspaceRoot,
      config: { qualificationCwd: worktreeWorkspaceRoot },
    });
    const turnStart = appServerCalls.find((call) => call.method === 'turn/start');
    const turnStartParams = turnStart?.params as
      | {
          cwd?: unknown;
          sandboxPolicy?: { type?: unknown; writableRoots?: unknown };
        }
      | undefined;
    expect(turnStartParams?.cwd).toBe(worktreeWorkspaceRoot);
    expect(turnStartParams?.sandboxPolicy?.type).toBe('workspaceWrite');
    const writableRoots = turnStartParams?.sandboxPolicy?.writableRoots;
    expect(Array.isArray(writableRoots)).toBe(true);
    for (const expectedRoot of [
      sourceCwd,
      sourceCommonDir,
      worktreeWorkspaceRoot,
      join(codexHome, 'automations', created.item.id),
    ]) {
      expect(writableRoots).toContain(expectedRoot);
    }
  });
});
