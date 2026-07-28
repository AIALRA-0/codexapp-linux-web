import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { CodexAppServerClient } from '@codexapp/app-server-client';

import type { OfficialDesktopState } from './official-desktop-state.js';

const OFFICIAL_SCHEDULER_TICK_MS = 30_000;
const OFFICIAL_MAX_RUNS_PER_TICK = 3;
const HEARTBEAT_RENDERER_STATE_TTL_MS = 2 * 60_000;
const HEARTBEAT_RETRY_MS = 60_000;

const ARCHIVE_THREAD_TOOL = {
  type: 'namespace',
  name: 'codex_app',
  description: 'Tools provided by the Codex app.',
  tools: [
    {
      type: 'function',
      name: 'set_thread_archived',
      description: 'Archive or unarchive a Codex thread.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          threadId: {
            type: 'string',
            description: 'Thread id to archive or unarchive. Omit to target the calling thread.',
          },
          archived: {
            type: 'boolean',
            description: 'Whether the thread should be archived.',
          },
        },
        required: ['archived'],
      },
    },
  ],
} as const;

interface AutomationRecord {
  id: string;
  kind: 'cron' | 'heartbeat';
  name: string;
  prompt: string;
  rrule: string;
  status: string;
  target?: { type: 'projectless' } | { type: 'project'; projectId: string } | null;
  targetThreadId?: string;
  cwds?: string[];
  executionEnvironment?: string;
  localEnvironmentConfigPath?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  lastRunAt?: number | null;
  notificationPolicy?: string | null;
}

interface ModelListPage {
  data: unknown[];
  nextCursor: string | null;
}

interface PreparedAutomationRun {
  previousAutomation: AutomationRecord;
  automation: AutomationRecord;
  modelSettings: {
    model: string;
    reasoningEffort: string | null;
  };
}

interface PermissionResolution {
  approvalPolicy: string;
  approvalsReviewer: string;
  sandboxPolicy: Record<string, unknown>;
}

interface ThreadStartResult {
  thread: {
    id: string;
    sessionId: string;
    cwd?: string | null;
    path?: string | null;
    status?: unknown;
  };
  cwd: string;
  approvalPolicy: string;
  approvalsReviewer: string;
  sandbox: Record<string, unknown>;
}

interface HeartbeatRendererState {
  isEligible: boolean;
  reason: string | null;
  collaborationMode: unknown;
  permissions: unknown;
  updatedAtMs: number;
}

export interface OfficialAutomationControllerOptions {
  officialSourceRoot: string;
  userRoot: string;
  codexHome: string;
  workspaceRoot: string;
  desktopState: OfficialDesktopState;
  getAppServer: () => CodexAppServerClient;
  requestGitWorker: (
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<unknown>;
  getGlobalState: (key: string) => unknown;
  emitViewMessage: (message: unknown) => void;
  onError: (error: Error, context: Record<string, unknown>) => void;
  tickMs?: number;
  maxRunsPerTick?: number;
}

export class OfficialAutomationController {
  readonly options: OfficialAutomationControllerOptions;
  readonly automationInstructions: string;
  readonly heartbeatPromptTemplate: string;

  #timer: NodeJS.Timeout | undefined;
  #ticking = false;
  #heartbeatEnabled = false;
  #heartbeatStates = new Map<string, HeartbeatRendererState>();
  #automationPolicyByThread = new Map<string, string | null>();

  constructor(options: OfficialAutomationControllerOptions) {
    this.options = options;
    const templates = loadQualifiedAutomationTemplates(options.officialSourceRoot);
    this.automationInstructions = templates.automationInstructions;
    this.heartbeatPromptTemplate = templates.heartbeatPromptTemplate;
  }

  async start(): Promise<void> {
    const settled = (await this.options.desktopState.request(
      'automation-run.settle-interrupted',
    )) as { success?: boolean };
    if (settled.success === true) this.#notifyRunsUpdated();
    await this.tick();
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => {
      void this.tick();
    }, this.options.tickMs ?? OFFICIAL_SCHEDULER_TICK_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#heartbeatStates.clear();
    this.#automationPolicyByThread.clear();
  }

  setHeartbeatEnabled(enabled: boolean): void {
    this.#heartbeatEnabled = enabled;
    if (!enabled) this.#heartbeatStates.clear();
    else void this.tick();
  }

  setHeartbeatRendererState(message: Record<string, unknown>): void {
    const threadId = nonEmptyString(message.threadId, 'heartbeat thread id');
    if (typeof message.isEligible !== 'boolean') {
      throw new Error('heartbeat thread eligibility is invalid');
    }
    this.#heartbeatStates.set(threadId, {
      isEligible: message.isEligible,
      reason: optionalString(message.reason),
      collaborationMode: message.collaborationMode ?? null,
      permissions: message.permissions ?? null,
      updatedAtMs: Date.now(),
    });
  }

  async runNow(params: Record<string, unknown>): Promise<{ success: true }> {
    const id = nonEmptyString(params.id, 'automation id');
    const automation = (await this.options.desktopState.request('automations.get', {
      id,
    })) as AutomationRecord | null;
    if (automation === null) throw new Error('Automation not found.');
    if (automation.kind === 'heartbeat') {
      await this.#runHeartbeat(automation, {
        collaborationMode: params.collaborationMode ?? null,
        permissions: params.permissions ?? null,
      });
    } else {
      await this.#prepareAndRunCron(id);
    }
    return { success: true };
  }

  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      const due = (await this.options.desktopState.request('automations.due', {
        now: Date.now(),
        limit: this.options.maxRunsPerTick ?? OFFICIAL_MAX_RUNS_PER_TICK,
      })) as { items: AutomationRecord[] };
      await Promise.all(
        due.items.map(async (automation) => {
          try {
            if (automation.kind === 'heartbeat') {
              await this.#runScheduledHeartbeat(automation);
            } else {
              await this.#prepareAndRunCron(automation.id);
            }
          } catch (error) {
            this.options.onError(asError(error), {
              operation: 'scheduled-automation-run',
              automationId: automation.id,
            });
          }
        }),
      );
    } finally {
      this.#ticking = false;
    }
  }

  async handleNotification(notification: unknown): Promise<void> {
    if (notification === null || typeof notification !== 'object' || Array.isArray(notification)) {
      return;
    }
    const value = notification as Record<string, unknown>;
    if (value.method !== 'turn/completed') return;
    const params = recordOrNull(value.params);
    const threadId = optionalString(params?.threadId);
    if (threadId === null) return;
    const turn = recordOrNull(params?.turn);
    const status = optionalString(turn?.status);
    const notificationPolicy = this.#automationPolicyByThread.get(threadId);
    this.#automationPolicyByThread.delete(threadId);
    const completion = (await this.options.desktopState.request('automation-run.complete', {
      threadId,
      title: null,
      description: null,
      ...(notificationPolicy === 'failed_runs_only'
        ? { readAt: status === 'completed' ? Date.now() : null }
        : {}),
    })) as { success?: boolean };
    if (completion.success === true) {
      this.#notifyRunsUpdated();
      this.options.emitViewMessage({ type: 'inbox-items-changed' });
    }
  }

  async #prepareAndRunCron(automationId: string): Promise<void> {
    const models = await this.#listModels();
    const prepared = (await this.options.desktopState.request('automations.prepare-run', {
      id: automationId,
      models,
    })) as PreparedAutomationRun;
    const targets = this.#resolveCronTargets(prepared.previousAutomation);
    for (const target of targets) {
      await this.#runCronTarget(prepared, target);
    }
  }

  async #runCronTarget(
    prepared: PreparedAutomationRun,
    target: { cwd: string; projectless: boolean; sourceCwds: string[] },
  ): Promise<void> {
    const automation = prepared.previousAutomation;
    const appServer = this.options.getAppServer();
    const [configResponse, requirementsResponse, developerInstructions, constants] =
      await Promise.all([
        appServer.request('config/read', { includeLayers: false, cwd: target.cwd }),
        appServer.request('configRequirements/read'),
        this.options.desktopState.request('automations.developer-instructions', {
          baseInstructions: this.automationInstructions,
          projectless: target.projectless,
          cwd: target.cwd,
          outputDirectory: target.cwd,
          workspaceRoot: this.options.workspaceRoot,
        }),
        this.options.desktopState.request('automations.constants'),
      ]);
    const config = recordOrThrow(configResponse, 'automation configuration response').config;
    const requirements =
      recordOrNull(requirementsResponse)?.requirements ?? requirementsResponse ?? null;
    const permissions = (await this.options.desktopState.request(
      'automations.resolve-permissions',
      {
        config: recordOrThrow(config, 'automation configuration'),
        requirements,
        sourceCwds: target.sourceCwds,
        preferredMode: null,
      },
    )) as PermissionResolution;
    const instructions = nonEmptyString(
      recordOrThrow(developerInstructions, 'automation developer instructions').instructions,
      'automation developer instructions',
    );
    const summary = nonEmptyString(
      recordOrThrow(constants, 'automation constants').defaultSummary,
      'automation summary',
    );
    const pendingThreadId = `pending:${randomUUID()}`;
    await this.options.desktopState.request('automation-run.create', {
      automationId: automation.id,
      threadId: pendingThreadId,
      threadTitle: automation.name,
      sourceCwd: target.projectless ? null : target.cwd,
    });
    this.#notifyRunsUpdated();
    let worktree:
      | {
          gitRoot: string;
          workspaceRoot: string;
          sourceMetadata: { root: string; commonDir: string };
        }
      | undefined;
    let startedThreadId: string | undefined;
    try {
      if (automation.executionEnvironment === 'worktree' && !target.projectless) {
        worktree = await this.#createAutomationWorktree(automation, target.cwd);
      }
      const executionCwd = worktree?.workspaceRoot ?? target.cwd;
      const threadConfig =
        executionCwd === target.cwd
          ? config
          : recordOrThrow(
              recordOrThrow(
                await appServer.request('config/read', {
                  includeLayers: false,
                  cwd: executionCwd,
                }),
                'automation worktree configuration response',
              ).config,
              'automation worktree configuration',
            );
      const started = (await appServer.request('thread/start', {
        model: prepared.modelSettings.model,
        modelProvider: null,
        cwd: executionCwd,
        approvalPolicy: permissions.approvalPolicy,
        approvalsReviewer: permissions.approvalsReviewer,
        sandbox: sandboxMode(permissions.sandboxPolicy),
        config: threadConfig,
        developerInstructions: instructions,
        personality: null,
        ephemeral: null,
        threadSource: 'automation',
        dynamicTools: [ARCHIVE_THREAD_TOOL],
        mockExperimentalField: null,
        experimentalRawEvents: false,
        serviceTier: null,
      })) as ThreadStartResult;
      const threadId = nonEmptyString(started.thread.id, 'automation thread id');
      startedThreadId = threadId;
      await this.options.desktopState.request('automation-run.replace-pending', {
        pendingThreadId,
        threadId,
      });
      this.#automationPolicyByThread.set(threadId, automation.notificationPolicy ?? null);
      if (worktree !== undefined) {
        await this.#setWorktreeOwner(worktree.gitRoot, threadId, automation.id);
      }
      await appServer.request('thread/name/set', {
        threadId,
        name: automation.name,
      });
      const lastRun =
        automation.lastRunAt == null
          ? 'never'
          : `${new Date(automation.lastRunAt).toISOString()} (${String(automation.lastRunAt)})`;
      const prompt = [
        `Automation: ${automation.name}`,
        `Automation ID: ${automation.id}`,
        `Automation memory: $CODEX_HOME/automations/${automation.id}/memory.md`,
        `Last run: ${lastRun}`,
        '',
        automation.prompt,
      ].join('\n');
      const turnPermissions =
        worktree === undefined
          ? permissions
          : await this.#resolveWorktreePermissions({
              automationId: automation.id,
              config: recordOrThrow(config, 'automation configuration'),
              requirements,
              sourceCwd: target.cwd,
              sourceCwds: target.sourceCwds,
              worktree,
            });
      await appServer.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: prompt, text_elements: [] }],
        cwd: started.thread.cwd ?? started.cwd ?? executionCwd,
        approvalPolicy: turnPermissions.approvalPolicy,
        approvalsReviewer: turnPermissions.approvalsReviewer,
        sandboxPolicy: turnPermissions.sandboxPolicy,
        model: prepared.modelSettings.model,
        effort: prepared.modelSettings.reasoningEffort,
        serviceTier: null,
        summary,
        personality: null,
        outputSchema: null,
        collaborationMode: null,
      });
      this.#notifyRunsUpdated();
    } catch (error) {
      if (worktree !== undefined && startedThreadId === undefined) {
        await this.#deleteFailedWorktree(worktree.gitRoot, automation.id);
      }
      await this.options.desktopState.request('automation-run.archive', {
        threadId: pendingThreadId,
        archivedReason: 'auto',
      });
      this.#notifyRunsUpdated();
      throw error;
    }
  }

  async #createAutomationWorktree(
    automation: AutomationRecord,
    sourceCwd: string,
  ): Promise<
    | {
        gitRoot: string;
        workspaceRoot: string;
        sourceMetadata: { root: string; commonDir: string };
      }
    | undefined
  > {
    const operationSource = 'automation';
    const metadataValue = await this.options.requestGitWorker('stable-metadata', {
      cwd: sourceCwd,
      operationSource,
    });
    if (metadataValue === null) return undefined;
    const metadata = recordOrThrow(metadataValue, 'automation Git metadata');
    const root = nonEmptyString(metadata.root, 'automation Git root');
    const commonDir = nonEmptyString(metadata.commonDir, 'automation Git common directory');
    const snapshot = recordOrThrow(
      await this.options.requestGitWorker('current-branch-snapshot', {
        root,
        operationSource,
      }),
      'automation Git branch snapshot',
    );
    const created = recordOrThrow(
      await this.options.requestGitWorker(
        'create-worktree',
        {
          operationSource,
          cwd: sourceCwd,
          startingState: {
            type: 'branch',
            branchName: optionalString(snapshot.branch) ?? 'HEAD',
          },
          localEnvironmentConfigPath: optionalString(automation.localEnvironmentConfigPath) ?? null,
          streamId: randomUUID(),
          worktreesRoot: '',
        },
        600_000,
      ),
      'automation worktree result',
    );
    const setupError = optionalString(created.setupError);
    if (setupError !== null) throw new Error(setupError);
    return {
      gitRoot: nonEmptyString(created.worktreeGitRoot, 'automation worktree Git root'),
      workspaceRoot: this.#confinedCwd(
        nonEmptyString(created.worktreeWorkspaceRoot, 'automation worktree workspace root'),
      ),
      sourceMetadata: { root, commonDir },
    };
  }

  async #setWorktreeOwner(
    worktreeGitRoot: string,
    threadId: string,
    automationId: string,
  ): Promise<void> {
    try {
      await this.options.requestGitWorker('set-worktree-owner-thread', {
        worktree: worktreeGitRoot,
        conversationId: threadId,
        operationSource: 'worktree_set_owner_thread',
      });
    } catch (error) {
      this.options.onError(asError(error), {
        operation: 'automation-worktree-owner',
        automationId,
        threadId,
      });
    }
  }

  async #deleteFailedWorktree(worktreeGitRoot: string, automationId: string): Promise<void> {
    try {
      await this.options.requestGitWorker('delete-worktree', {
        worktree: worktreeGitRoot,
        force: true,
        reason: 'automation-start-failed',
        operationSource: 'automation',
      });
    } catch (error) {
      this.options.onError(asError(error), {
        operation: 'automation-worktree-cleanup',
        automationId,
      });
    }
  }

  async #resolveWorktreePermissions(params: {
    automationId: string;
    config: Record<string, unknown>;
    requirements: unknown;
    sourceCwd: string;
    sourceCwds: string[];
    worktree: {
      gitRoot: string;
      workspaceRoot: string;
      sourceMetadata: { root: string; commonDir: string };
    };
  }): Promise<PermissionResolution> {
    const [worktreeMetadataValue, extraSourceMetadataValues] = await Promise.all([
      this.options.requestGitWorker('stable-metadata', {
        cwd: params.worktree.workspaceRoot,
        operationSource: 'automation',
      }),
      Promise.all(
        params.sourceCwds
          .filter((cwd) => cwd !== params.sourceCwd)
          .map((cwd) =>
            this.options.requestGitWorker('stable-metadata', {
              cwd,
              operationSource: 'automation',
            }),
          ),
      ),
    ]);
    const worktreeMetadata = recordOrNull(worktreeMetadataValue);
    const extraSourceMetadata = extraSourceMetadataValues
      .map((value) => recordOrNull(value))
      .filter((value): value is Record<string, unknown> => value !== null);
    const sourceCwds = [
      ...params.sourceCwds,
      params.worktree.workspaceRoot,
      params.worktree.gitRoot,
      params.worktree.sourceMetadata.root,
      params.worktree.sourceMetadata.commonDir,
      resolve(this.options.codexHome, 'automations', params.automationId),
      optionalString(worktreeMetadata?.root),
      optionalString(worktreeMetadata?.commonDir),
      ...extraSourceMetadata.flatMap((metadata) => [
        optionalString(metadata.root),
        optionalString(metadata.commonDir),
      ]),
    ].filter((value): value is string => value !== null);
    return (await this.options.desktopState.request('automations.resolve-permissions', {
      config: params.config,
      requirements: params.requirements,
      sourceCwds: [...new Set(sourceCwds)],
      preferredMode: null,
    })) as PermissionResolution;
  }

  async #runScheduledHeartbeat(automation: AutomationRecord): Promise<void> {
    const threadId = nonEmptyString(automation.targetThreadId, 'heartbeat target thread id');
    const state = this.#readFreshHeartbeatState(threadId);
    if (!this.#heartbeatEnabled || state === null || !state.isEligible) {
      await this.options.desktopState.request('automations.defer-heartbeat', {
        id: automation.id,
        now: Date.now(),
      });
      return;
    }
    await this.#runHeartbeat(automation, {
      collaborationMode: state.collaborationMode,
      permissions: state.permissions,
    });
  }

  async #runHeartbeat(
    automation: AutomationRecord,
    rendererState: { collaborationMode: unknown; permissions: unknown },
  ): Promise<void> {
    const appServer = this.options.getAppServer();
    const threadId = nonEmptyString(automation.targetThreadId, 'heartbeat target thread id');
    const threadResult = recordOrThrow(
      await appServer.request('thread/read', { threadId, includeTurns: false }),
      'heartbeat thread response',
    );
    const thread = recordOrNull(threadResult.thread);
    if (thread === null) throw new Error('Heartbeat thread not found.');
    const status = recordOrNull(thread.status);
    if (status?.type === 'active') throw new Error('Heartbeat thread is busy right now.');
    await this.options.desktopState.request('automations.prepare-run', {
      id: automation.id,
      models: await this.#listModels(),
    });
    const resumed = recordOrThrow(
      await appServer.request('thread/resume', {
        threadId,
        history: null,
        path: optionalString(thread.path),
        model: null,
        modelProvider: null,
        cwd: optionalString(thread.cwd),
        approvalPolicy: null,
        sandbox: null,
        config: null,
        developerInstructions: undefined,
        personality: null,
        excludeTurns: true,
      }),
      'heartbeat thread resume response',
    );
    const resumedThread = recordOrThrow(resumed.thread, 'resumed heartbeat thread');
    const permissions =
      rendererState.permissions === null
        ? await this.#resolveHeartbeatPermissions(
            nonEmptyString(resumedThread.cwd ?? resumed.cwd, 'heartbeat working directory'),
          )
        : parseRendererPermissions(rendererState.permissions);
    const collaborationMode = normalizeCollaborationMode(rendererState.collaborationMode);
    const prompt = this.heartbeatPromptTemplate
      .replaceAll('{{AUTOMATION_ID}}', automation.id)
      .replaceAll('{{NOW_ISO}}', new Date().toISOString())
      .replaceAll('{{AUTOMATION_PROMPT}}', automation.prompt);
    await appServer.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
      cwd: nonEmptyString(resumedThread.cwd ?? resumed.cwd, 'heartbeat working directory'),
      approvalPolicy: permissions.approvalPolicy,
      approvalsReviewer: permissions.approvalsReviewer,
      sandboxPolicy: permissions.sandboxPolicy,
      model: null,
      effort: null,
      serviceTier: null,
      summary: 'none',
      personality: null,
      outputSchema: null,
      collaborationMode,
    });
  }

  async #resolveHeartbeatPermissions(cwd: string): Promise<PermissionResolution> {
    const appServer = this.options.getAppServer();
    const [configResponse, requirementsResponse] = await Promise.all([
      appServer.request('config/read', { includeLayers: false, cwd }),
      appServer.request('configRequirements/read').catch(() => ({ requirements: null })),
    ]);
    return (await this.options.desktopState.request('automations.resolve-permissions', {
      config: recordOrThrow(configResponse, 'heartbeat configuration response').config,
      requirements: recordOrNull(requirementsResponse)?.requirements ?? null,
      sourceCwds: [cwd],
      preferredMode: null,
    })) as PermissionResolution;
  }

  async #listModels(): Promise<unknown[]> {
    const models: unknown[] = [];
    let cursor: string | null = null;
    do {
      const page = (await this.options.getAppServer().request('model/list', {
        includeHidden: true,
        cursor,
        limit: 100,
      })) as ModelListPage;
      models.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return models;
  }

  #resolveCronTargets(automation: AutomationRecord): Array<{
    cwd: string;
    projectless: boolean;
    sourceCwds: string[];
  }> {
    if (automation.target === null || automation.target === undefined) {
      const cwds = automation.cwds ?? [];
      if (cwds.length === 0) throw new Error('Scheduled run skipped: no folders configured.');
      return cwds.map((cwd) => {
        const confined = this.#confinedCwd(cwd);
        return { cwd: confined, projectless: false, sourceCwds: [confined] };
      });
    }
    if (automation.target.type === 'projectless') {
      return [{ cwd: this.options.workspaceRoot, projectless: true, sourceCwds: [] }];
    }
    const projects = recordOrNull(this.options.getGlobalState('local-projects'));
    if (projects === null) return [];
    const project = recordOrNull(projects[automation.target.projectId]);
    if (project === null) return [];
    const rootPaths = project.rootPaths;
    if (!Array.isArray(rootPaths) || rootPaths.length === 0) return [];
    const sourceCwds = rootPaths.map((cwd) =>
      this.#confinedCwd(nonEmptyString(cwd, 'automation project root')),
    );
    const primary = sourceCwds[0];
    return primary === undefined ? [] : [{ cwd: primary, projectless: false, sourceCwds }];
  }

  #confinedCwd(value: string): string {
    if (!isAbsolute(value)) throw new Error('Automation working directory must be absolute.');
    const root = resolve(this.options.userRoot);
    const candidate = resolve(value);
    if (isPathWithin(root, candidate)) return candidate;
    try {
      if (isPathWithin(realpathSync(root), realpathSync(candidate))) return candidate;
    } catch {
      // The lexical check remains authoritative when either path does not exist yet.
    }
    throw new Error('Automation working directory is outside the isolated user runtime.');
  }

  #readFreshHeartbeatState(threadId: string): HeartbeatRendererState | null {
    const state = this.#heartbeatStates.get(threadId);
    if (state === undefined) return null;
    if (Date.now() - state.updatedAtMs <= HEARTBEAT_RENDERER_STATE_TTL_MS) return state;
    this.#heartbeatStates.delete(threadId);
    return null;
  }

  #notifyRunsUpdated(): void {
    this.options.emitViewMessage({ type: 'automation-runs-updated' });
  }
}

export function loadQualifiedAutomationTemplates(sourceRoot: string): {
  automationInstructions: string;
  heartbeatPromptTemplate: string;
} {
  const buildRoot = resolve(sourceRoot, '.vite', 'build');
  const candidates = readdirSync(buildRoot)
    .filter((name) => /^main-[A-Za-z0-9_-]+\.js$/u.test(name))
    .sort();
  if (candidates.length !== 1) {
    throw new Error('qualified official main process module changed');
  }
  const source = readFileSync(resolve(buildRoot, candidates[0] as string), 'utf8');
  const automationInstructions = extractTemplateLiteral(
    source,
    'var gi=`Response MUST end with a remark-directive block.',
  );
  const heartbeatPromptTemplate = extractTemplateLiteral(source, '_i=`<heartbeat>');
  if (
    !automationInstructions.includes('::inbox-item{title=') ||
    !automationInstructions.includes('$CODEX_HOME/automations/<automation_id>/memory.md') ||
    !heartbeatPromptTemplate.includes('{{AUTOMATION_ID}}') ||
    !heartbeatPromptTemplate.includes('{{AUTOMATION_PROMPT}}')
  ) {
    throw new Error('qualified official automation templates changed');
  }
  return { automationInstructions, heartbeatPromptTemplate };
}

function extractTemplateLiteral(source: string, marker: string): string {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0 || source.indexOf(marker, markerIndex + marker.length) >= 0) {
    throw new Error(`qualified official template marker changed: ${marker.slice(0, 32)}`);
  }
  const start = source.indexOf('`', markerIndex);
  if (start < 0) throw new Error('qualified official template start is missing');
  let output = '';
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index] as string;
    if (escaped) {
      if (character === '`' || character === '\\' || character === '$') output += character;
      else output += `\\${character}`;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '`') return output;
    output += character;
    if (output.length > 100_000) throw new Error('qualified official template is too large');
  }
  throw new Error('qualified official template end is missing');
}

function normalizeCollaborationMode(value: unknown): unknown {
  if (value === null || value === undefined) {
    throw new Error('Heartbeat thread mode is still loading.');
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Heartbeat collaboration mode is invalid.');
  }
  return value;
}

function parseRendererPermissions(value: unknown): PermissionResolution {
  const record = recordOrThrow(value, 'heartbeat permissions');
  return {
    approvalPolicy: nonEmptyString(record.approvalPolicy, 'heartbeat approval policy'),
    approvalsReviewer: nonEmptyString(record.approvalsReviewer, 'heartbeat approvals reviewer'),
    sandboxPolicy: recordOrThrow(record.sandboxPolicy, 'heartbeat sandbox policy'),
  };
}

function sandboxMode(policy: Record<string, unknown>): string {
  switch (policy.type) {
    case 'dangerFullAccess':
      return 'danger-full-access';
    case 'readOnly':
      return 'read-only';
    case 'workspaceWrite':
      return 'workspace-write';
    default:
      throw new Error('qualified official sandbox policy changed');
  }
}

function recordOrThrow(value: unknown, label: string): Record<string, unknown> {
  const record = recordOrNull(value);
  if (record === null) throw new Error(`${label} is invalid`);
  return record;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_000_000) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function isPathWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child));
}

export const OFFICIAL_AUTOMATION_TIMING = {
  schedulerTickMs: OFFICIAL_SCHEDULER_TICK_MS,
  maxRunsPerTick: OFFICIAL_MAX_RUNS_PER_TICK,
  heartbeatRendererStateTtlMs: HEARTBEAT_RENDERER_STATE_TTL_MS,
  heartbeatRetryMs: HEARTBEAT_RETRY_MS,
} as const;
