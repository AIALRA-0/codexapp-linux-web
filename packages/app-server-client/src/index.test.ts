import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { CodexAppServerClient } from './index.js';

function fakeChild(): {
  child: ChildProcessWithoutNullStreams;
  stdout: PassThrough;
} {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough();
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout,
    stderr: new PassThrough(),
    pid: 123,
    exitCode: null,
    signalCode: null,
    kill: () => true,
  });
  return { child, stdout };
}

describe('CodexAppServerClient', () => {
  it('initializes using newline-delimited JSON-RPC', async () => {
    const { child, stdout } = fakeChild();
    const writes: string[] = [];
    child.stdin.on('data', (chunk: Buffer) => {
      writes.push(chunk.toString());
      const request = JSON.parse(chunk.toString()) as { id?: number; method: string };
      if (request.id !== undefined) {
        stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
      }
    });
    const client = new CodexAppServerClient({
      codexBin: '/bin/codex',
      codexHome: '/tmp/codex-home',
      cwd: '/tmp',
      clientVersion: '0.1.0',
      spawnProcess: () => child,
    });

    await client.start();

    expect(client.ready).toBe(true);
    expect(writes).toHaveLength(2);
    expect(writes[0]).toContain('"method":"initialize"');
    expect(writes[1]).toContain('"method":"initialized"');
  });

  it('routes server notifications without swallowing them', async () => {
    const { child, stdout } = fakeChild();
    child.stdin.on('data', (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString()) as { id?: number };
      if (request.id !== undefined) {
        stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
      }
    });
    const client = new CodexAppServerClient({
      codexBin: '/bin/codex',
      codexHome: '/tmp/codex-home',
      cwd: '/tmp',
      clientVersion: '0.1.0',
      spawnProcess: () => child,
    });
    await client.start();

    const observed = new Promise((resolve) => client.once('notification', resolve));
    stdout.write(`${JSON.stringify({ method: 'thread/started', params: { id: 't1' } })}\n`);

    await expect(observed).resolves.toEqual({
      method: 'thread/started',
      params: { id: 't1' },
    });
  });

  it('can initialize a replacement process after an unexpected exit', async () => {
    const children = [fakeChild(), fakeChild()];
    for (const { child, stdout } of children) {
      child.stdin.on('data', (chunk: Buffer) => {
        const request = JSON.parse(chunk.toString()) as { id?: number };
        if (request.id !== undefined) {
          stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
        }
      });
    }
    let spawnIndex = 0;
    const client = new CodexAppServerClient({
      codexBin: '/bin/codex',
      codexHome: '/tmp/codex-home',
      cwd: '/tmp',
      clientVersion: '0.1.0',
      spawnProcess: () => {
        const child = children[spawnIndex]?.child;
        spawnIndex += 1;
        if (child === undefined) throw new Error('unexpected extra app-server spawn');
        return child;
      },
    });

    await client.start();
    children[0]?.child.emit('exit', 70, null);
    expect(client.ready).toBe(false);
    await client.start();

    expect(client.ready).toBe(true);
    expect(spawnIndex).toBe(2);
  });

  it('starts a dedicated process group and stops every descendant', async () => {
    const { child, stdout } = fakeChild();
    child.stdin.on('data', (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString()) as { id?: number };
      if (request.id !== undefined) {
        stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
      }
    });
    let spawnOptions: SpawnOptions | undefined;
    const signals: Array<NodeJS.Signals | 0> = [];
    let groupAlive = true;
    const client = new CodexAppServerClient({
      codexBin: '/bin/codex',
      codexHome: '/tmp/codex-home',
      cwd: '/tmp',
      clientVersion: '0.1.0',
      spawnProcess: (_command, _args, options) => {
        spawnOptions = options;
        return child;
      },
      signalProcessGroup: (_pid, signal) => {
        signals.push(signal);
        if (signal === 'SIGTERM') groupAlive = false;
        return groupAlive || signal === 'SIGTERM';
      },
    });

    await client.start();
    await client.stop(1);

    expect(spawnOptions?.detached).toBe(process.platform !== 'win32');
    expect(signals).toEqual(['SIGTERM', 0]);
    expect(client.ready).toBe(false);
  });

  it('cleans descendants when the app-server parent exits unexpectedly', async () => {
    const { child, stdout } = fakeChild();
    child.stdin.on('data', (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString()) as { id?: number };
      if (request.id !== undefined) {
        stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
      }
    });
    const signals: Array<NodeJS.Signals | 0> = [];
    let groupAlive = true;
    const client = new CodexAppServerClient({
      codexBin: '/bin/codex',
      codexHome: '/tmp/codex-home',
      cwd: '/tmp',
      clientVersion: '0.1.0',
      spawnProcess: () => child,
      signalProcessGroup: (_pid, signal) => {
        signals.push(signal);
        if (signal === 'SIGTERM') groupAlive = false;
        return groupAlive || signal === 'SIGTERM';
      },
    });

    await client.start();
    child.emit('exit', 70, null);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(signals).toEqual(['SIGTERM', 0]);
    expect(client.ready).toBe(false);
  });
});
