import { randomUUID } from 'node:crypto';

export const OFFICIAL_CHUNKED_MESSAGE_MARKER = 'codex-host-chunked-message-v1' as const;
export const DEFAULT_CHUNK_THRESHOLD_BYTES = 1024 * 1024;
// One MiB keeps every browser frame far below the WebSocket payload ceiling while
// avoiding thousands of acknowledgement round trips for very large conversations.
export const DEFAULT_CHUNK_WIRE_BYTES = 1024 * 1024;
const MAX_STRING_TOKEN_CODE_UNITS = 32 * 1024;

export type OfficialChunkToken =
  | { type: 'array-start' }
  | { type: 'object-start' }
  | { type: 'container-end' }
  | { type: 'key'; value: string }
  | { type: 'value'; value?: null | boolean | number | string }
  | { type: 'string-start'; target: 'key' | 'value' }
  | { type: 'string-chunk'; value: string }
  | { type: 'string-end' };

export type OfficialChunkedMessage =
  | {
      marker: typeof OFFICIAL_CHUNKED_MESSAGE_MARKER;
      transferId: string;
      sequence: number;
      kind: 'start' | 'end';
    }
  | {
      marker: typeof OFFICIAL_CHUNKED_MESSAGE_MARKER;
      transferId: string;
      sequence: number;
      kind: 'chunk';
      tokens: OfficialChunkToken[];
    };

export function hostMessageNeedsChunking(
  value: unknown,
  thresholdBytes = DEFAULT_CHUNK_THRESHOLD_BYTES,
): boolean {
  if (!Number.isSafeInteger(thresholdBytes) || thresholdBytes < 1) {
    throw new Error('chunk threshold must be a positive safe integer');
  }
  let observedBytes = 0;
  const pending: unknown[] = [value];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') {
      observedBytes += Buffer.byteLength(current, 'utf8') + 2;
    } else if (
      current === null ||
      current === undefined ||
      typeof current === 'boolean' ||
      typeof current === 'number'
    ) {
      observedBytes += 16;
    } else if (Array.isArray(current)) {
      if (visited.has(current)) throw new Error('chunked host message contains a cycle');
      visited.add(current);
      observedBytes += current.length + 2;
      for (const entry of current) pending.push(entry);
    } else if (typeof current === 'object') {
      if (visited.has(current)) throw new Error('chunked host message contains a cycle');
      visited.add(current);
      const entries = Object.entries(current);
      observedBytes += entries.length + 2;
      for (const [key, entryValue] of entries) {
        observedBytes += Buffer.byteLength(key, 'utf8') + 3;
        pending.push(entryValue);
      }
    } else {
      throw new Error(`chunked host message contains unsupported ${typeof current}`);
    }
    if (observedBytes > thresholdBytes) return true;
  }
  return false;
}

export function* chunkOfficialHostMessage(
  value: unknown,
  options: { transferId?: string; wireBytes?: number } = {},
): Generator<OfficialChunkedMessage> {
  const transferId = options.transferId ?? randomUUID();
  const wireBytes = options.wireBytes ?? DEFAULT_CHUNK_WIRE_BYTES;
  if (!Number.isSafeInteger(wireBytes) || wireBytes < 1024) {
    throw new Error('chunk wire size must be a safe integer of at least 1024 bytes');
  }
  let sequence = 0;
  yield {
    marker: OFFICIAL_CHUNKED_MESSAGE_MARKER,
    transferId,
    sequence: sequence++,
    kind: 'start',
  };
  let tokens: OfficialChunkToken[] = [];
  let tokenBytes = 0;
  for (const token of tokenizeJsonValue(value)) {
    const nextTokenBytes = Buffer.byteLength(JSON.stringify(token), 'utf8') + 1;
    if (tokens.length > 0 && tokenBytes + nextTokenBytes > wireBytes) {
      yield {
        marker: OFFICIAL_CHUNKED_MESSAGE_MARKER,
        transferId,
        sequence: sequence++,
        kind: 'chunk',
        tokens,
      };
      tokens = [];
      tokenBytes = 0;
    }
    tokens.push(token);
    tokenBytes += nextTokenBytes;
  }
  if (tokens.length > 0) {
    yield {
      marker: OFFICIAL_CHUNKED_MESSAGE_MARKER,
      transferId,
      sequence: sequence++,
      kind: 'chunk',
      tokens,
    };
  }
  yield {
    marker: OFFICIAL_CHUNKED_MESSAGE_MARKER,
    transferId,
    sequence,
    kind: 'end',
  };
}

function* tokenizeJsonValue(value: unknown): Generator<OfficialChunkToken> {
  const visited = new WeakSet<object>();
  yield* visit(value, 'value', visited);
}

function* visit(
  value: unknown,
  target: 'key' | 'value',
  visited: WeakSet<object>,
): Generator<OfficialChunkToken> {
  if (typeof value === 'string') {
    if (value.length <= MAX_STRING_TOKEN_CODE_UNITS) {
      yield target === 'key' ? { type: 'key', value } : { type: 'value', value };
      return;
    }
    yield { type: 'string-start', target };
    for (let offset = 0; offset < value.length; offset += MAX_STRING_TOKEN_CODE_UNITS) {
      yield {
        type: 'string-chunk',
        value: value.slice(offset, offset + MAX_STRING_TOKEN_CODE_UNITS),
      };
    }
    yield { type: 'string-end' };
    return;
  }
  if (target === 'key') throw new Error('object key is not a string');
  if (value === undefined) {
    yield { type: 'value' };
    return;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('chunked host message contains a non-finite number');
    }
    yield { type: 'value', value };
    return;
  }
  if (Array.isArray(value)) {
    assertUnvisited(value, visited);
    yield { type: 'array-start' };
    for (const entry of value) yield* visit(entry, 'value', visited);
    yield { type: 'container-end' };
    return;
  }
  if (typeof value === 'object') {
    assertUnvisited(value, visited);
    yield { type: 'object-start' };
    for (const [key, entryValue] of Object.entries(value)) {
      yield* visit(key, 'key', visited);
      yield* visit(entryValue, 'value', visited);
    }
    yield { type: 'container-end' };
    return;
  }
  throw new Error(`chunked host message contains unsupported ${typeof value}`);
}

function assertUnvisited(value: object, visited: WeakSet<object>): void {
  if (visited.has(value)) throw new Error('chunked host message contains a cycle');
  visited.add(value);
}
