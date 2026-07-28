import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTerminalEnvironment, TerminalManager, type TerminalEvent } from './terminal.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('TerminalManager', () => {
  it('runs the system shell, replays output, and exposes the thread snapshot', async () => {
    const fixture = await createFixture();
    const manager = fixture.manager;
    const events: TerminalEvent[] = [];
    manager.subscribe('browser-session', (event) => events.push(event));

    await expect(
      manager.createOrAttach('browser-session', 'create', {
        sessionId: 'terminal-smoke',
        conversationId: 'thread-smoke',
        hostId: 'local',
        cwd: fixture.workspace,
        cols: 100,
        rows: 30,
      }),
    ).resolves.toBe('terminal-smoke');

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'attached',
        sessionId: 'terminal-smoke',
        cwd: fixture.workspace,
      }),
    );

    manager.write('browser-session', 'terminal-smoke', "printf '__terminal_smoke__\\n'\n");
    await waitFor(() =>
      events.some((event) => event.type === 'data' && event.data.includes('__terminal_smoke__')),
    );

    const snapshot = manager.getSnapshotForConversationId('browser-session', 'thread-smoke');
    expect(snapshot).toMatchObject({
      cwd: fixture.workspace,
      truncated: false,
    });
    expect(snapshot?.buffer).toContain('__terminal_smoke__');

    const eventCount = events.length;
    await manager.createOrAttach('browser-session', 'attach', {
      sessionId: 'terminal-smoke',
      conversationId: 'thread-smoke',
      hostId: 'local',
    });
    expect(
      events
        .slice(eventCount)
        .some((event) => event.type === 'init-log' && event.log.includes('__terminal_smoke__')),
    ).toBe(true);

    manager.close('browser-session', 'terminal-smoke');
    expect(events.at(-1)).toEqual({
      type: 'exit',
      sessionId: 'terminal-smoke',
      code: null,
      signal: null,
    });
    manager.stop();
  });

  it('restarts the terminal for an official run action', async () => {
    const fixture = await createFixture();
    const manager = fixture.manager;
    const events: TerminalEvent[] = [];
    manager.subscribe('browser-session', (event) => events.push(event));
    await manager.createOrAttach('browser-session', 'create', {
      sessionId: 'action-smoke',
      conversationId: 'action-thread',
      cwd: fixture.workspace,
    });

    manager.runAction(
      'browser-session',
      'action-smoke',
      fixture.workspace,
      "printf '__action_smoke__\\n'",
    );
    await waitFor(() =>
      events.some((event) => event.type === 'data' && event.data.includes('__action_smoke__')),
    );

    expect(events).toContainEqual({
      type: 'init-log',
      sessionId: 'action-smoke',
      log: '',
    });
    expect(
      manager.getSnapshotForConversationId('browser-session', 'action-thread')?.buffer,
    ).toContain('__action_smoke__');
    manager.stop();
  });

  it('refuses lexical and symlink escapes from the per-user root', async () => {
    const fixture = await createFixture();
    const outside = await mkdtemp(join(tmpdir(), 'codexapp-terminal-outside-'));
    temporaryRoots.push(outside);
    const linkedOutside = join(fixture.root, 'workspace', 'outside-link');
    await symlink(outside, linkedOutside);

    await expect(
      fixture.manager.createOrAttach('browser-session', 'create', {
        sessionId: 'lexical-escape',
        cwd: outside,
      }),
    ).rejects.toThrow('escapes the user root');
    await expect(
      fixture.manager.createOrAttach('browser-session', 'create', {
        sessionId: 'symlink-escape',
        cwd: linkedOutside,
      }),
    ).rejects.toThrow('resolves outside the user root');
    fixture.manager.stop();
  });

  it('does not expose a terminal owned by another browser session', async () => {
    const fixture = await createFixture();
    const secondOwnerEvents: TerminalEvent[] = [];
    fixture.manager.subscribe('second-browser', (event) => secondOwnerEvents.push(event));
    await fixture.manager.createOrAttach('first-browser', 'create', {
      sessionId: 'private-terminal',
      conversationId: 'private-thread',
      cwd: fixture.workspace,
    });

    fixture.manager.write('second-browser', 'private-terminal', 'echo forbidden\n');
    expect(secondOwnerEvents).toEqual([
      {
        type: 'error',
        sessionId: 'private-terminal',
        message: 'Session owned by another browser session',
      },
    ]);
    expect(
      fixture.manager.getSnapshotForConversationId('second-browser', 'private-thread'),
    ).toBeNull();
    fixture.manager.stop();
  });

  it('falls back to an interactive shell for a login-disabled service account', async () => {
    const originalShell = process.env.SHELL;
    process.env.SHELL = '/usr/bin/false';
    try {
      const fixture = await createFixture();
      const events: TerminalEvent[] = [];
      fixture.manager.subscribe('browser-session', (event) => events.push(event));
      await expect(
        fixture.manager.createOrAttach('browser-session', 'create', {
          sessionId: 'service-account-terminal',
          conversationId: 'service-account-thread',
          cwd: fixture.workspace,
        }),
      ).resolves.toBe('service-account-terminal');

      fixture.manager.write(
        'browser-session',
        'service-account-terminal',
        "printf '__service_account_shell__\\n'\n",
      );
      await waitFor(() =>
        events.some(
          (event) => event.type === 'data' && event.data.includes('__service_account_shell__'),
        ),
      );
      expect(
        fixture.manager.getSnapshotForConversationId('browser-session', 'service-account-thread'),
      ).toMatchObject({ shell: 'bash' });
      fixture.manager.stop();
    } finally {
      if (originalShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = originalShell;
    }
  });

  it('does not serialize an unset locale override as the string undefined', async () => {
    const originalLcAll = process.env.LC_ALL;
    delete process.env.LC_ALL;
    try {
      const fixture = await createFixture();
      const environment = createTerminalEnvironment(fixture.manager.options, undefined);
      expect(environment.LC_ALL).toBeUndefined();
      expect(Object.hasOwn(environment, 'LC_ALL')).toBe(false);
    } finally {
      if (originalLcAll === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = originalLcAll;
    }
  });
});

async function createFixture(): Promise<{
  root: string;
  workspace: string;
  manager: TerminalManager;
}> {
  const parent = await mkdtemp(join(tmpdir(), 'codexapp-terminal-'));
  temporaryRoots.push(parent);
  const root = join(parent, 'user');
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  return {
    root,
    workspace,
    manager: new TerminalManager({
      userRoot: root,
      codexHome: join(root, 'codex-home'),
      workspaceRoot: workspace,
      username: 'terminal-test',
    }),
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}
