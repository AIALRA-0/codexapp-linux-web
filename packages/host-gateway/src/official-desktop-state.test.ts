import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { OfficialDesktopState } from './official-desktop-state.js';

const sourceRoot =
  process.env.OFFICIAL_TEST_SOURCE_ROOT ??
  resolve(process.cwd(), '.official', 'releases', '26.721.81911', 'source');
const describeQualified = existsSync(join(sourceRoot, '.vite', 'build', 'worker.js'))
  ? describe
  : describe.skip;
const temporaryRoots: string[] = [];
const clients: OfficialDesktopState[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.stop();
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

describeQualified('OfficialDesktopState', () => {
  it('uses the qualified official keymap implementation with an isolated Codex home', async () => {
    const codexHome = await createCodexHome();
    const client = createClient(codexHome);

    await expect(client.request('keymap.get')).resolves.toEqual({
      supported: true,
      keymapPath: join(codexHome, 'keybindings.json'),
      bindings: [],
    });
    await expect(
      client.request('keymap.set', {
        commandId: 'toggleSidebar',
        update: { type: 'clear' },
      }),
    ).resolves.toMatchObject({
      supported: true,
      keymapPath: join(codexHome, 'keybindings.json'),
    });
    await expect(client.request('keymap.reset')).resolves.toMatchObject({
      bindings: [],
    });
  });

  it('uses the official automation and inbox SQLite schema without fake empty results', async () => {
    const codexHome = await createCodexHome();
    const client = createClient(codexHome);
    const automationInput = {
      kind: 'cron',
      name: 'Daily qualification',
      prompt: 'Run the qualification suite',
      rrule: 'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      executionEnvironment: 'local',
      projectId: null,
      cwds: [join(codexHome, 'workspace')],
      model: null,
      reasoningEffort: null,
    };

    const created = (await client.request('automations.create', {
      input: automationInput,
      compatibilityCwds: [],
    })) as { item: { id: string; name: string; nextRunAt: number } };
    expect(created.item).toMatchObject({
      name: automationInput.name,
    });
    expect(created.item.nextRunAt).toEqual(expect.any(Number));
    await expect(client.request('automations.list')).resolves.toMatchObject({
      items: [{ id: created.item.id, name: automationInput.name }],
    });
    await expect(client.request('automations.get', { id: created.item.id })).resolves.toMatchObject(
      {
        id: created.item.id,
        name: automationInput.name,
      },
    );
    const preparedRun = (await client.request('automations.prepare-run', {
      id: created.item.id,
      models: [],
    })) as {
      automation: { id: string; lastRunAt: number };
      modelSettings: { model: string; reasoningEffort: string };
    };
    expect(preparedRun.automation.id).toBe(created.item.id);
    expect(preparedRun.automation.lastRunAt).toEqual(expect.any(Number));
    expect(preparedRun.modelSettings.model).toEqual(expect.any(String));
    expect(preparedRun.modelSettings.reasoningEffort).toEqual(expect.any(String));
    await expect(
      client.request('automations.resolve-permissions', {
        config: {},
        requirements: null,
        sourceCwds: automationInput.cwds,
        preferredMode: null,
      }),
    ).resolves.toMatchObject({
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandboxPolicy: {
        type: 'workspaceWrite',
      },
    });
    const developerInstructions = (await client.request('automations.developer-instructions', {
      baseInstructions: 'Official automation instructions',
      projectless: false,
    })) as { instructions: string };
    expect(developerInstructions.instructions).toContain('Official automation instructions');

    const pendingThreadId = `pending:${randomUUID()}`;
    const threadId = randomUUID();
    await expect(
      client.request('automation-run.create', {
        automationId: created.item.id,
        threadId: pendingThreadId,
        threadTitle: automationInput.name,
        sourceCwd: automationInput.cwds[0],
      }),
    ).resolves.toEqual({ success: true });
    await expect(
      client.request('automation-run.replace-pending', {
        pendingThreadId,
        threadId,
      }),
    ).resolves.toEqual({ success: true });
    await expect(
      client.request('automation-run.complete', {
        threadId,
        title: 'Qualification completed',
        description: 'Review the result',
      }),
    ).resolves.toMatchObject({
      success: true,
      unreadRunCounts: {
        total: 1,
        automationIds: [created.item.id],
        unreadRuns: [{ automationId: created.item.id, threadId }],
      },
    });
    await expect(client.request('inbox.list', { limit: 200 })).resolves.toEqual({
      items: [
        expect.objectContaining({
          id: threadId,
          automationId: created.item.id,
          title: automationInput.name,
          description: 'Review the result',
          status: 'PENDING_REVIEW',
        }),
      ],
      unreadRunCounts: {
        total: 1,
        automationIds: [created.item.id],
        unreadRuns: [{ automationId: created.item.id, threadId }],
      },
    });
    await expect(
      client.request('automations.delete', { id: created.item.id }),
    ).resolves.toMatchObject({
      success: true,
      status: 'deleted',
    });
    await expect(client.request('automations.list')).resolves.toEqual({ items: [] });
  });

  it('uses the official custom avatar parser inside the isolated worker', async () => {
    const codexHome = await createCodexHome();
    const avatarRoot = join(codexHome, 'pets', 'owl');
    await mkdir(avatarRoot, { recursive: true });
    const spritesheet = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(spritesheet, 0);
    Buffer.from('IHDR').copy(spritesheet, 12);
    spritesheet.writeUInt32BE(1536, 16);
    spritesheet.writeUInt32BE(1872, 20);
    await Promise.all([
      writeFile(
        join(avatarRoot, 'pet.json'),
        JSON.stringify({
          displayName: 'Owl',
          description: 'Official test avatar',
          spriteVersionNumber: 1,
          spritesheetPath: 'spritesheet.png',
        }),
      ),
      writeFile(join(avatarRoot, 'spritesheet.png'), spritesheet),
    ]);
    const client = createClient(codexHome);

    await expect(client.request('custom-avatars.load')).resolves.toMatchObject({
      avatarDirectory: join(codexHome, 'pets'),
      avatars: [
        {
          id: 'custom:owl',
          displayName: 'Owl',
          description: 'Official test avatar',
          spriteVersionNumber: 1,
        },
      ],
    });
    await expect(
      client.request('custom-avatars.load-avatar', { avatarId: 'custom:owl' }),
    ).resolves.toMatchObject({
      id: 'custom:owl',
      displayName: 'Owl',
    });
  });

  it('uses the official plugin scheduled-task parser and recurrence conversion', async () => {
    const codexHome = await createCodexHome();
    const pluginRoot = join(dirname(codexHome), 'workspace', 'plugin');
    await mkdir(join(pluginRoot, 'scheduled'), { recursive: true });
    await writeFile(
      join(pluginRoot, 'scheduled', 'daily-review.json'),
      JSON.stringify({
        name: 'Daily review',
        prompt: 'Review the project',
        schedule: { type: 'daily', time: '09:30' },
      }),
    );
    const client = createClient(codexHome);

    await expect(
      client.request('plugin-scheduled-tasks.list', {
        buildFlavor: 'prod',
        hiddenMarketplaceNames: [],
        marketplaces: [
          {
            name: 'public',
            plugins: [
              {
                id: 'plugin-1',
                name: 'sample-plugin',
                enabled: true,
                installed: true,
                availability: 'AVAILABLE',
                localVersion: null,
                source: { type: 'local', path: pluginRoot },
                interface: { displayName: 'Sample plugin' },
              },
            ],
          },
        ],
      }),
    ).resolves.toEqual({
      groups: [
        {
          plugin: {
            id: 'plugin-1',
            name: 'sample-plugin',
            displayName: 'Sample plugin',
          },
          templates: [
            {
              key: 'daily-review',
              name: 'Daily review',
              prompt: 'Review the project',
              rrule: 'RRULE:FREQ=WEEKLY;BYHOUR=9;BYMINUTE=30;BYDAY=MO,TU,WE,TH,FR,SA,SU',
            },
          ],
        },
      ],
    });
  });
});

async function createCodexHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'codexapp-official-state-'));
  temporaryRoots.push(root);
  const codexHome = join(root, 'codex-home');
  await mkdir(codexHome, { recursive: true });
  return codexHome;
}

function createClient(codexHome: string): OfficialDesktopState {
  const client = new OfficialDesktopState({
    officialSourceRoot: sourceRoot,
    codexHome,
    buildFlavor: 'prod',
  });
  clients.push(client);
  return client;
}
