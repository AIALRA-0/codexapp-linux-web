import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

const sourceJsonl = process.env.SOURCE_JSONL;
const destinationDirectory = process.env.DESTINATION_DIRECTORY;
const maximumAttachmentBytes = Number(process.env.MAXIMUM_ATTACHMENT_BYTES ?? 32 * 1024 * 1024);
const clipboardNamePattern = /codex-clipboard-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.png/giu;
const pngDataPrefix = 'data:image/png;base64,';

if (sourceJsonl === undefined || destinationDirectory === undefined) {
  throw new Error('SOURCE_JSONL and DESTINATION_DIRECTORY are required');
}
if (!Number.isSafeInteger(maximumAttachmentBytes) || maximumAttachmentBytes <= 0) {
  throw new Error('MAXIMUM_ATTACHMENT_BYTES must be a positive safe integer');
}

await mkdir(destinationDirectory, { mode: 0o700, recursive: true });

const extracted = new Map();
let parsedLines = 0;
let matchedLines = 0;
const input = createInterface({
  crlfDelay: Number.POSITIVE_INFINITY,
  input: createReadStream(sourceJsonl, { encoding: 'utf8' }),
});

for await (const line of input) {
  parsedLines += 1;
  if (!line.includes('codex-clipboard-') || !line.includes(pngDataPrefix)) continue;
  const value = JSON.parse(line);
  const strings = collectStrings(value);
  const names = unique(
    strings.flatMap((entry) =>
      entry.startsWith('data:')
        ? []
        : [...entry.matchAll(clipboardNamePattern)].map((match) => match[0]),
    ),
  );
  const dataUrls = unique(strings.filter((entry) => entry.startsWith(pngDataPrefix)));
  if (names.length === 0 || dataUrls.length === 0) continue;
  if (names.length !== dataUrls.length && !(names.length === 1 && dataUrls.length >= 1)) {
    throw new Error(
      `Cannot safely associate ${String(names.length)} clipboard names with ${String(dataUrls.length)} embedded images on line ${String(parsedLines)}`,
    );
  }
  matchedLines += 1;
  for (let index = 0; index < names.length; index += 1) {
    const name = basename(names[index]);
    const dataUrl = dataUrls[Math.min(index, dataUrls.length - 1)];
    const bytes = Buffer.from(dataUrl.slice(pngDataPrefix.length), 'base64');
    if (bytes.byteLength === 0 || bytes.byteLength > maximumAttachmentBytes) {
      throw new Error(`Embedded attachment ${name} has an invalid size`);
    }
    if (!isPng(bytes)) throw new Error(`Embedded attachment ${name} is not a PNG`);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const previous = extracted.get(name);
    if (previous !== undefined && previous.sha256 !== sha256) {
      throw new Error(`Embedded attachment ${name} has conflicting contents`);
    }
    const destination = join(destinationDirectory, name);
    try {
      await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      const existing = await readFile(destination);
      const existingSha256 = createHash('sha256').update(existing).digest('hex');
      if (existingSha256 !== sha256) {
        throw new Error(`Existing attachment ${name} does not match embedded history`);
      }
    }
    extracted.set(name, { bytes: bytes.byteLength, sha256 });
  }
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    parsedLines,
    matchedLines,
    attachments: [...extracted.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, details]) => ({ name, ...details })),
  })}\n`,
);

function collectStrings(value) {
  const strings = [];
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') {
      strings.push(current);
      continue;
    }
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) pending.push(current[index]);
      continue;
    }
    if (current !== null && typeof current === 'object') {
      const values = Object.values(current);
      for (let index = values.length - 1; index >= 0; index -= 1) pending.push(values[index]);
    }
  }
  return strings;
}

function unique(values) {
  return [...new Set(values)];
}

function isPng(bytes) {
  return (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

function errorCode(error) {
  return error !== null &&
    typeof error === 'object' &&
    !Array.isArray(error) &&
    typeof error.code === 'string'
    ? error.code
    : null;
}
