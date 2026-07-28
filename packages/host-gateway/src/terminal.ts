import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, statSync, type Stats } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

import { spawn, type IDisposable, type IPty } from 'node-pty';

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_DIMENSION = 1_000;
const MAX_SESSIONS = 32;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_CONVERSATION_ID_LENGTH = 512;
const MAX_INPUT_LENGTH = 1_048_576;
const MAX_COMMAND_LENGTH = 1_048_576;
const MAX_BUFFER_LENGTH = 16_000;

export interface TerminalManagerOptions {
  userRoot: string;
  codexHome: string;
  workspaceRoot: string;
  username: string;
}

export function createTerminalEnvironment(
  options: TerminalManagerOptions,
  conversationTitle: string | undefined,
): NodeJS.ProcessEnv {
  const home = join(options.userRoot, 'home');
  const temporary = join(options.userRoot, 'tmp');
  const lcAll = process.env.LC_ALL;
  return {
    HOME: home,
    CODEX_HOME: options.codexHome,
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    LANG: process.env.LANG ?? 'C.UTF-8',
    ...(lcAll === undefined || lcAll.length === 0 ? {} : { LC_ALL: lcAll }),
    SHELL: resolveShellPath(),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    USER: process.env.USER ?? options.username,
    LOGNAME: process.env.LOGNAME ?? options.username,
    ...(conversationTitle === undefined ? {} : { CODEX_APP_TITLE: conversationTitle }),
  };
}

export type TerminalEvent =
  | { type: 'data'; sessionId: string; data: string }
  | { type: 'exit'; sessionId: string; code: number | null; signal: string | null }
  | { type: 'error'; sessionId: string; message: string }
  | { type: 'init-log'; sessionId: string; log: string }
  | { type: 'attached'; sessionId: string; cwd: string; shell: string };

export interface TerminalThreadSnapshot {
  cwd: string;
  shell: string;
  buffer: string;
  truncated: boolean;
}

interface TerminalRequest {
  sessionId?: string;
  conversationId?: string;
  conversationTitle?: string;
  hostId: 'local' | null;
  cwd?: string;
  cols?: number;
  rows?: number;
  forceCwdSync: boolean;
}

interface TerminalSession {
  id: string;
  ownerId: string;
  pty: IPty | undefined;
  dataDisposable: IDisposable | undefined;
  exitDisposable: IDisposable | undefined;
  buffer: string;
  cwd: string;
  shellPath: string;
  shell: string;
  cols: number;
  rows: number;
  conversationId?: string;
  conversationTitle?: string;
}

export class TerminalManager {
  readonly options: TerminalManagerOptions;
  #sessions = new Map<string, TerminalSession>();
  #sessionByOwnerConversation = new Map<string, string>();
  #listenersByOwner = new Map<string, Set<(event: TerminalEvent) => void>>();
  #actionChains = new Map<string, Promise<void>>();
  #stopped = false;

  constructor(options: TerminalManagerOptions) {
    this.options = {
      ...options,
      userRoot: resolve(options.userRoot),
      codexHome: resolve(options.codexHome),
      workspaceRoot: resolve(options.workspaceRoot),
    };
  }

  subscribe(ownerId: string, listener: (event: TerminalEvent) => void): () => void {
    if (typeof listener !== 'function') {
      throw new TypeError('Terminal subscription listener must be callable');
    }
    const listeners = this.#listenersByOwner.get(ownerId) ?? new Set();
    listeners.add(listener);
    this.#listenersByOwner.set(ownerId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listenersByOwner.delete(ownerId);
    };
  }

  createOrAttach(
    ownerId: string,
    type: 'create' | 'attach',
    value: unknown,
  ): Promise<string | null> {
    try {
      if (this.#stopped) throw new Error('Terminal manager is stopped');
      const request = parseTerminalRequest(value);
      const existing = this.#findExisting(ownerId, request, type === 'attach');
      if (existing !== undefined) {
        return Promise.resolve(this.#attach(ownerId, existing, request));
      }
      return Promise.resolve(this.#create(ownerId, request));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(errorMessage(error)));
    }
  }

  write(ownerId: string, sessionIdValue: unknown, dataValue: unknown): void {
    const sessionId = parseIdentifier(sessionIdValue, 'terminal session id', MAX_SESSION_ID_LENGTH);
    const data = parseBoundedString(dataValue, 'terminal input', MAX_INPUT_LENGTH);
    const session = this.#ownedSession(ownerId, sessionId);
    if (session === undefined) return;
    try {
      session.pty?.write(data);
    } catch (error) {
      this.#failSession(session, error);
    }
  }

  resize(ownerId: string, sessionIdValue: unknown, colsValue: unknown, rowsValue: unknown): void {
    const sessionId = parseIdentifier(sessionIdValue, 'terminal session id', MAX_SESSION_ID_LENGTH);
    const cols = parseDimension(colsValue, 'terminal columns');
    const rows = parseDimension(rowsValue, 'terminal rows');
    const session = this.#ownedSession(ownerId, sessionId);
    if (session === undefined || (session.cols === cols && session.rows === rows)) return;
    session.cols = cols;
    session.rows = rows;
    try {
      session.pty?.resize(cols, rows);
    } catch (error) {
      this.#failSession(session, error);
    }
  }

  runAction(
    ownerId: string,
    sessionIdValue: unknown,
    cwdValue: unknown,
    commandValue: unknown,
  ): void {
    const sessionId = parseIdentifier(sessionIdValue, 'terminal session id', MAX_SESSION_ID_LENGTH);
    const cwd = this.#resolveCwd(cwdValue);
    const command = parseBoundedString(commandValue, 'terminal command', MAX_COMMAND_LENGTH);
    const session = this.#ownedSession(ownerId, sessionId);
    if (session === undefined) return;
    const prior = this.#actionChains.get(sessionId) ?? Promise.resolve();
    const next = prior
      .catch(() => undefined)
      .then(() => {
        if (this.#sessions.get(sessionId) !== session) return;
        this.#restartForAction(session, cwd, command);
      });
    this.#actionChains.set(sessionId, next);
    void next
      .catch((error: unknown) => this.#failSession(session, error))
      .finally(() => {
        if (this.#actionChains.get(sessionId) === next) this.#actionChains.delete(sessionId);
      });
  }

  close(ownerId: string, sessionIdValue: unknown): void {
    const sessionId = parseIdentifier(sessionIdValue, 'terminal session id', MAX_SESSION_ID_LENGTH);
    const session = this.#ownedSession(ownerId, sessionId);
    if (session !== undefined) this.#destroySession(session, null, null, true);
  }

  getSnapshotForConversationId(
    ownerId: string,
    conversationIdValue: unknown,
  ): TerminalThreadSnapshot | null {
    const conversationId = parseIdentifier(
      conversationIdValue,
      'conversation id',
      MAX_CONVERSATION_ID_LENGTH,
    );
    const sessionId = this.#sessionByOwnerConversation.get(
      conversationKey(ownerId, conversationId),
    );
    if (sessionId === undefined) return null;
    const session = this.#sessions.get(sessionId);
    if (session === undefined || session.ownerId !== ownerId) return null;
    return {
      cwd: session.cwd,
      shell: session.shell,
      buffer: session.buffer,
      truncated: session.buffer.length >= MAX_BUFFER_LENGTH,
    };
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const session of [...this.#sessions.values()]) {
      this.#destroySession(session, null, null, true, false);
    }
    this.#listenersByOwner.clear();
    this.#actionChains.clear();
  }

  #create(ownerId: string, request: TerminalRequest): string | null {
    if (this.#sessions.size >= MAX_SESSIONS) {
      const sessionId = request.sessionId ?? randomUUID();
      this.#sendError(ownerId, sessionId, `Terminal session limit (${MAX_SESSIONS}) reached`);
      return null;
    }
    this.#prepareDirectories();
    const id = request.sessionId ?? randomUUID();
    const cwd = this.#resolveCwd(request.cwd);
    const shellPath = resolveShellPath();
    const session: TerminalSession = {
      id,
      ownerId,
      pty: undefined,
      dataDisposable: undefined,
      exitDisposable: undefined,
      buffer: '',
      cwd,
      shellPath,
      shell: shellName(shellPath),
      cols: request.cols ?? DEFAULT_COLS,
      rows: request.rows ?? DEFAULT_ROWS,
      ...(request.conversationId === undefined ? {} : { conversationId: request.conversationId }),
      ...(request.conversationTitle === undefined
        ? {}
        : { conversationTitle: request.conversationTitle }),
    };
    this.#sessions.set(id, session);
    this.#setConversationMapping(session);
    try {
      this.#spawnSession(session);
      if (session.buffer.length > 0) {
        this.#send(ownerId, {
          type: 'init-log',
          sessionId: id,
          log: filterInitLog(session.buffer),
        });
      }
      this.#sendAttached(session);
      return id;
    } catch (error) {
      this.#sendError(ownerId, id, errorMessage(error));
      this.#destroySession(session, null, null, false);
      return null;
    }
  }

  #attach(ownerId: string, session: TerminalSession, request: TerminalRequest): string | null {
    if (session.ownerId !== ownerId) {
      this.#sendError(ownerId, session.id, 'Session owned by another browser session');
      return null;
    }
    if (request.conversationId !== undefined) {
      this.#deleteConversationMapping(session);
      session.conversationId = request.conversationId;
      this.#setConversationMapping(session);
    }
    if (request.conversationTitle !== undefined) {
      session.conversationTitle = request.conversationTitle;
    }
    if (request.cols !== undefined && request.rows !== undefined) {
      this.resize(ownerId, session.id, request.cols, request.rows);
    }
    if (request.forceCwdSync && request.cwd !== undefined) {
      const cwd = this.#resolveCwd(request.cwd);
      session.cwd = cwd;
      session.pty?.write(`cd ${JSON.stringify(cwd)}\n`);
    }
    if (request.sessionId !== undefined && request.sessionId !== session.id) {
      if (this.#sessions.has(request.sessionId)) {
        this.#sendError(ownerId, request.sessionId, 'Terminal session id is already in use');
        return null;
      }
      this.#sessions.delete(session.id);
      this.#actionChains.delete(session.id);
      session.id = request.sessionId;
      this.#sessions.set(session.id, session);
      this.#setConversationMapping(session);
    }
    if (session.buffer.length > 0) {
      this.#send(ownerId, {
        type: 'init-log',
        sessionId: session.id,
        log: filterInitLog(session.buffer),
      });
    }
    this.#sendAttached(session);
    return session.id;
  }

  #restartForAction(session: TerminalSession, cwd: string, command: string): void {
    this.#disposePty(session, true);
    session.cwd = cwd;
    session.buffer = '';
    this.#spawnSession(session);
    this.#send(session.ownerId, { type: 'init-log', sessionId: session.id, log: '' });
    this.#sendAttached(session);
    session.pty?.write(`cd ${JSON.stringify(cwd)} && ${normalizeNewlines(command)}\n`);
  }

  #spawnSession(session: TerminalSession): void {
    const pty = spawn(session.shellPath, [], {
      name: 'xterm-256color',
      cols: session.cols,
      rows: session.rows,
      cwd: session.cwd,
      env: this.#terminalEnvironment(session.conversationTitle),
      encoding: 'utf8',
    });
    session.pty = pty;
    session.dataDisposable = pty.onData((data) => {
      if (this.#sessions.get(session.id) !== session || session.pty !== pty) return;
      session.buffer = `${session.buffer}${data}`.slice(-MAX_BUFFER_LENGTH);
      this.#send(session.ownerId, { type: 'data', sessionId: session.id, data });
    });
    session.exitDisposable = pty.onExit(({ exitCode, signal }) => {
      if (this.#sessions.get(session.id) !== session || session.pty !== pty) return;
      this.#destroySession(
        session,
        Number.isInteger(exitCode) ? exitCode : null,
        signal === undefined ? null : String(signal),
        false,
      );
    });
  }

  #terminalEnvironment(conversationTitle: string | undefined): NodeJS.ProcessEnv {
    return createTerminalEnvironment(this.options, conversationTitle);
  }

  #prepareDirectories(): void {
    mkdirSync(this.options.userRoot, { recursive: true, mode: 0o700 });
    mkdirSync(this.options.codexHome, { recursive: true, mode: 0o700 });
    mkdirSync(this.options.workspaceRoot, { recursive: true, mode: 0o700 });
    mkdirSync(join(this.options.userRoot, 'home'), { recursive: true, mode: 0o700 });
    mkdirSync(join(this.options.userRoot, 'tmp'), { recursive: true, mode: 0o700 });
  }

  #resolveCwd(value: unknown): string {
    const requested =
      value === undefined || value === null
        ? this.options.workspaceRoot
        : parseBoundedString(value, 'terminal working directory', 4_096);
    if (!isAbsolute(requested)) {
      throw new Error('Terminal working directory must be absolute');
    }
    this.#prepareDirectories();
    const lexicalRoot = this.options.userRoot;
    const lexicalCandidate = resolve(requested);
    assertInside(lexicalRoot, lexicalCandidate, 'Terminal working directory escapes the user root');
    const canonicalRoot = realpathSync(lexicalRoot);
    const canonicalCandidate = realpathSync(lexicalCandidate);
    assertInside(
      canonicalRoot,
      canonicalCandidate,
      'Terminal working directory resolves outside the user root',
    );
    const details: Stats = statSync(canonicalCandidate);
    if (!details.isDirectory()) throw new Error('Terminal working directory is not a directory');
    return lexicalCandidate;
  }

  #findExisting(
    ownerId: string,
    request: TerminalRequest,
    allowConversationFallback: boolean,
  ): TerminalSession | undefined {
    if (request.sessionId !== undefined) {
      const byId = this.#sessions.get(request.sessionId);
      if (byId !== undefined) return byId;
    }
    if (allowConversationFallback && request.conversationId !== undefined) {
      const sessionId = this.#sessionByOwnerConversation.get(
        conversationKey(ownerId, request.conversationId),
      );
      if (sessionId !== undefined) return this.#sessions.get(sessionId);
    }
    return undefined;
  }

  #ownedSession(ownerId: string, sessionId: string): TerminalSession | undefined {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      this.#sendError(ownerId, sessionId, 'Session missing');
      return undefined;
    }
    if (session.ownerId !== ownerId) {
      this.#sendError(ownerId, sessionId, 'Session owned by another browser session');
      return undefined;
    }
    return session;
  }

  #failSession(session: TerminalSession, error: unknown): void {
    if (this.#sessions.get(session.id) !== session) return;
    this.#sendError(session.ownerId, session.id, errorMessage(error));
    this.#destroySession(session, null, null, true);
  }

  #destroySession(
    session: TerminalSession,
    code: number | null,
    signal: string | null,
    kill: boolean,
    sendExit = true,
  ): void {
    if (this.#sessions.get(session.id) !== session) return;
    this.#sessions.delete(session.id);
    this.#actionChains.delete(session.id);
    this.#deleteConversationMapping(session);
    this.#disposePty(session, kill);
    if (sendExit) {
      this.#send(session.ownerId, {
        type: 'exit',
        sessionId: session.id,
        code,
        signal,
      });
    }
  }

  #disposePty(session: TerminalSession, kill: boolean): void {
    session.dataDisposable?.dispose();
    session.exitDisposable?.dispose();
    session.dataDisposable = undefined;
    session.exitDisposable = undefined;
    const pty = session.pty;
    session.pty = undefined;
    if (kill && pty !== undefined) {
      try {
        pty.kill();
      } catch {
        // The terminal may have exited between the state check and the kill.
      }
    }
  }

  #setConversationMapping(session: TerminalSession): void {
    if (session.conversationId !== undefined) {
      this.#sessionByOwnerConversation.set(
        conversationKey(session.ownerId, session.conversationId),
        session.id,
      );
    }
  }

  #deleteConversationMapping(session: TerminalSession): void {
    if (session.conversationId === undefined) return;
    const key = conversationKey(session.ownerId, session.conversationId);
    if (this.#sessionByOwnerConversation.get(key) === session.id) {
      this.#sessionByOwnerConversation.delete(key);
    }
  }

  #sendAttached(session: TerminalSession): void {
    this.#send(session.ownerId, {
      type: 'attached',
      sessionId: session.id,
      cwd: session.cwd,
      shell: session.shell,
    });
  }

  #sendError(ownerId: string, sessionId: string, message: string): void {
    this.#send(ownerId, { type: 'error', sessionId, message });
  }

  #send(ownerId: string, event: TerminalEvent): void {
    for (const listener of this.#listenersByOwner.get(ownerId) ?? []) {
      try {
        listener(event);
      } catch {
        // A broken remote listener is removed by the AppHost service.
      }
    }
  }
}

function parseTerminalRequest(value: unknown): TerminalRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Terminal request must be an object');
  }
  const request = value as Record<string, unknown>;
  const hostId = request.hostId;
  if (hostId !== undefined && hostId !== null && hostId !== 'local') {
    throw new Error('Terminal host is unavailable');
  }
  return {
    ...(request.sessionId === undefined || request.sessionId === null
      ? {}
      : {
          sessionId: parseIdentifier(
            request.sessionId,
            'terminal session id',
            MAX_SESSION_ID_LENGTH,
          ),
        }),
    ...(request.conversationId === undefined || request.conversationId === null
      ? {}
      : {
          conversationId: parseIdentifier(
            request.conversationId,
            'conversation id',
            MAX_CONVERSATION_ID_LENGTH,
          ),
        }),
    ...(request.conversationTitle === undefined || request.conversationTitle === null
      ? {}
      : {
          conversationTitle: parseBoundedString(
            request.conversationTitle,
            'conversation title',
            4_096,
          ),
        }),
    hostId: hostId === 'local' ? 'local' : null,
    ...(request.cwd === undefined || request.cwd === null
      ? {}
      : { cwd: parseBoundedString(request.cwd, 'terminal working directory', 4_096) }),
    ...(request.cols === undefined
      ? {}
      : { cols: parseDimension(request.cols, 'terminal columns') }),
    ...(request.rows === undefined ? {} : { rows: parseDimension(request.rows, 'terminal rows') }),
    forceCwdSync: request.forceCwdSync === true,
  };
}

function parseIdentifier(value: unknown, label: string, maximum: number): string {
  const stringValue =
    typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (
    typeof stringValue !== 'string' ||
    stringValue.length === 0 ||
    stringValue.length > maximum ||
    stringValue.includes('\0')
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return stringValue;
}

function parseBoundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0')) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function parseDimension(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_DIMENSION) {
    throw new TypeError(`${label} must be an integer from 1 to ${MAX_DIMENSION}`);
  }
  return value as number;
}

function resolveShellPath(): string {
  const candidates = [process.env.SHELL, '/bin/bash', '/bin/sh'];
  for (const candidate of candidates) {
    if (candidate === undefined || !isAbsolute(candidate)) continue;
    if (isLoginRefusalProgram(candidate)) continue;
    try {
      const details = statSync(candidate);
      if (details.isFile() && (details.mode & 0o111) !== 0) return candidate;
    } catch {
      // Try the next qualified system shell.
    }
  }
  throw new Error('No executable system shell is available');
}

function isLoginRefusalProgram(candidate: string): boolean {
  const name = basename(candidate).toLowerCase();
  return name === 'nologin' || name === 'false';
}

function shellName(shellPath: string): string {
  return basename(shellPath).replace(/\.exe$/i, '') || 'Shell';
}

function conversationKey(ownerId: string, conversationId: string): string {
  return `${ownerId}\0${conversationId}`;
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n|\r|\n/g, '\n');
}

function assertInside(root: string, candidate: string, message: string): void {
  const difference = relative(root, candidate);
  if (difference === '' || (!difference.startsWith('..') && !isAbsolute(difference))) return;
  throw new Error(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function filterInitLog(value: string): string {
  let output = '';
  for (let index = 0; index < value.length;) {
    if (value[index] !== '\u001b') {
      output += value[index];
      index += 1;
      continue;
    }
    const next = value[index + 1];
    if (next === '[') {
      let end = index + 2;
      while (end < value.length) {
        const character = value[end];
        if (character !== undefined && character >= '@' && character <= '~') break;
        end += 1;
      }
      if (end >= value.length) {
        output += value.slice(index);
        break;
      }
      if (value[end] !== 'n') output += value.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (next === ']') {
      let end = index + 2;
      let terminatorLength = 0;
      while (end < value.length) {
        if (value[end] === '\u0007') {
          terminatorLength = 1;
          break;
        }
        if (value.startsWith('\u001b\\', end)) {
          terminatorLength = 2;
          break;
        }
        end += 1;
      }
      if (terminatorLength === 0) {
        output += value.slice(index);
        break;
      }
      const control = value.slice(index + 2, end);
      if (!/^\d+;\?$/.test(control)) {
        output += value.slice(index, end + terminatorLength);
      }
      index = end + terminatorLength;
      continue;
    }
    output += value[index];
    index += 1;
  }
  return output;
}
