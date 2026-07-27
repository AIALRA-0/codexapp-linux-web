import { EventEmitter } from 'node:events';

import type { CodexAppServerClient } from '@codexapp/app-server-client';
import { describe, expect, it } from 'vitest';

import { ThreadMetadataGenerator } from './thread-metadata-generation.js';

class FakeAppServer extends EventEmitter {
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  structuredResult: Record<string, unknown> = {
    title: '"修复登录速度。"',
    description: 'codexapp  登录  历史对话',
  };
  failFork = false;

  request(method: string, paramsValue?: unknown): Promise<unknown> {
    const params = (paramsValue ?? {}) as Record<string, unknown>;
    this.requests.push({ method, params });
    if (method === 'thread/start') {
      return Promise.resolve({ thread: { id: 'ephemeral-title' } });
    }
    if (method === 'thread/fork') {
      if (this.failFork) return Promise.reject(new Error('fork failed'));
      return Promise.resolve({ thread: { id: 'ephemeral-description' } });
    }
    if (method === 'turn/start') {
      const threadId = params.threadId as string;
      queueMicrotask(() => {
        this.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: { id: 'turn-1' } },
        });
        this.emit('notification', {
          method: 'item/completed',
          params: {
            threadId,
            turnId: 'turn-1',
            item: { type: 'agentMessage', text: JSON.stringify(this.structuredResult) },
          },
        });
        this.emit('notification', {
          method: 'turn/completed',
          params: { threadId, turn: { id: 'turn-1', status: 'completed' } },
        });
      });
      return Promise.resolve({ turn: { id: 'turn-1' } });
    }
    if (method === 'thread/unsubscribe') return Promise.resolve({});
    return Promise.reject(new Error(`Unexpected app-server request: ${method}`));
  }
}

function createGenerator(fake: FakeAppServer): ThreadMetadataGenerator {
  return new ThreadMetadataGenerator({
    getAppServer: () => fake as unknown as CodexAppServerClient,
  });
}

describe('official thread metadata generation', () => {
  it('uses the official title model, isolation config, prompt, and output schema', async () => {
    const fake = new FakeAppServer();
    const generator = createGenerator(fake);
    await expect(
      generator.generateTitle({
        prompt: '修复登录速度',
        cwd: '/workspace',
        readOnlyAppToolAllowlist: [{ appId: 'github', toolNames: ['read_issue'] }],
        serviceName: 'codex',
      }),
    ).resolves.toEqual({
      title: '修复登录速度。',
      description: 'codexapp 登录 历史对话',
    });

    const threadStart = fake.requests.find((request) => request.method === 'thread/start');
    expect(threadStart?.params).toMatchObject({
      model: 'gpt-5.6-luna',
      allowProviderModelFallback: true,
      approvalPolicy: 'never',
      permissions: ':read-only',
      ephemeral: true,
      threadSource: 'system',
      serviceName: 'codex',
      config: {
        'features.enable_fanout': false,
        'features.hooks': false,
        'features.multi_agent': false,
        'features.multi_agent_v2': false,
        'features.plugins': false,
        'features.tool_suggest': false,
        'features.apps': true,
        model_reasoning_effort: 'low',
        web_search: 'disabled',
        apps: {
          github: {
            enabled: true,
            destructive_enabled: false,
            open_world_enabled: false,
            default_tools_enabled: false,
            tools: { read_issue: { enabled: true } },
          },
          _default: {
            enabled: false,
            destructive_enabled: false,
            open_world_enabled: false,
          },
        },
      },
    });
    const turnStart = fake.requests.find((request) => request.method === 'turn/start');
    expect(turnStart?.params).toMatchObject({
      permissions: ':read-only',
      summary: 'none',
      outputSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        required: ['title', 'description'],
        additionalProperties: false,
      },
    });
    expect(
      (turnStart?.params.input as Array<Record<string, unknown>>)[0]?.text as string,
    ).toContain('User prompt:\n修复登录速度');
    expect(fake.requests.at(-1)).toEqual({
      method: 'thread/unsubscribe',
      params: { threadId: 'ephemeral-title' },
    });
  });

  it('forks the source thread for the official search description', async () => {
    const fake = new FakeAppServer();
    fake.structuredResult = {
      description: 'codexapp  VPS  Authentik  历史对话',
    };
    const generator = createGenerator(fake);
    await expect(
      generator.generateDescription({
        title: '修复 CodexApp',
        cwd: '/workspace',
        sourceThreadId: 'source-thread',
      }),
    ).resolves.toBe('codexapp VPS Authentik 历史对话');
    expect(fake.requests[0]).toMatchObject({
      method: 'thread/fork',
      params: {
        threadId: 'source-thread',
        model: 'gpt-5.6-luna',
        ephemeral: true,
        threadSource: 'system',
      },
    });
    const turn = fake.requests.find((request) => request.method === 'turn/start');
    expect((turn?.params.input as Array<Record<string, unknown>>)[0]?.text as string).toContain(
      'Current title: 修复 CodexApp',
    );
    expect(turn?.params.outputSchema).toMatchObject({
      required: ['description'],
      additionalProperties: false,
    });
  });

  it('does not create a fresh description thread when the official fork fails', async () => {
    const fake = new FakeAppServer();
    fake.failFork = true;
    const generator = createGenerator(fake);
    await expect(
      generator.generateDescription({
        title: null,
        cwd: '/workspace',
        sourceThreadId: 'missing-thread',
      }),
    ).resolves.toBeNull();
    expect(fake.requests.map((request) => request.method)).toEqual(['thread/fork']);
  });

  it('generates pull request copy with the official model, schema, and version gate', async () => {
    const fake = new FakeAppServer();
    fake.structuredResult = {
      title: 'Add official PR generation',
      body: '## Summary\n- Add exact generation\n\n## Testing\n- Unit tests passed',
    };
    const generator = createGenerator(fake);
    await expect(
      generator.generatePullRequestMessage({
        appServerVersion: '0.146.0-alpha.3.1',
        prompt: 'git status and diff context',
      }),
    ).resolves.toEqual(fake.structuredResult);
    const threadStart = fake.requests.find((request) => request.method === 'thread/start');
    expect(threadStart?.params).toMatchObject({
      model: 'gpt-5.6-luna',
      allowProviderModelFallback: true,
      cwd: null,
      ephemeral: true,
      threadSource: 'system',
      config: {
        'features.enable_fanout': false,
        'features.multi_agent': false,
        'features.multi_agent_v2': false,
        model_reasoning_effort: 'low',
        web_search: 'disabled',
      },
    });
    const turnStart = fake.requests.find((request) => request.method === 'turn/start');
    expect(turnStart?.params.outputSchema).toMatchObject({
      required: ['title', 'body'],
      properties: {
        title: { minLength: 8, maxLength: 120 },
        body: { minLength: 12, maxLength: 30_000 },
      },
    });
    const prompt = (turnStart?.params.input as Array<Record<string, unknown>>)[0]?.text;
    expect(prompt).toContain('Make 0 tool calls.');
    expect(prompt).toContain('Context:\ngit status and diff context');
  });

  it('disables provider fallback for app-server versions below the official gate', async () => {
    const fake = new FakeAppServer();
    fake.structuredResult = {
      title: 'Generate pull request copy',
      body: '## Summary\n- Generate it\n\n## Testing\n- Tests passed',
    };
    await createGenerator(fake).generatePullRequestMessage({
      appServerVersion: '0.142.9',
      prompt: 'context',
    });
    expect(
      fake.requests.find((request) => request.method === 'thread/start')?.params
        .allowProviderModelFallback,
    ).toBe(false);
  });
});
