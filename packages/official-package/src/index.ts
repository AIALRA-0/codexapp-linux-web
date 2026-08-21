import { createHash } from 'node:crypto';
import {
  createReadStream,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { extractAll, extractFile, listPackage, statFile } from '@electron/asar';
import { CONTRACT_VERSION, preloadContractSchema, type PreloadContract } from '@codexapp/contracts';
import ts from 'typescript';
import { z } from 'zod';

const packageMetadataSchema = z.object({
  version: z.string().min(1),
  codexBuildNumber: z.string().min(1),
  codexBuildFlavor: z.string().min(1),
  codexAppBrand: z.string().min(1),
});

const sourceManifestSchema = z.object({
  formatVersion: z.literal(3),
  package: z.object({
    asarPath: z.string(),
    asarSize: z.number().int().positive(),
    asarSha256: z.string().regex(/^[a-f0-9]{64}$/),
    fileCount: z.number().int().positive(),
    version: z.string(),
    buildNumber: z.string(),
    buildFlavor: z.string(),
    brand: z.string(),
  }),
  renderer: z.object({
    root: z.string().refine((path) => !isAbsolute(path), 'renderer root must be relative'),
    fileCount: z.number().int().positive(),
    totalBytes: z.number().int().positive(),
    treeSha256: z.string().regex(/^[a-f0-9]{64}$/),
    files: z.record(
      z.string(),
      z.object({
        bytes: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    ),
  }),
  host: z.object({
    root: z.string().refine((path) => !isAbsolute(path), 'host root must be relative'),
    fileCount: z.number().int().positive(),
    totalBytes: z.number().int().positive(),
    treeSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  preload: preloadContractSchema,
});

export type SourceManifest = z.infer<typeof sourceManifestSchema>;

const CHANNEL_PATTERN = /codex_desktop:[A-Za-z0-9_:-]+/gu;

export interface InspectOptions {
  asarPath: string;
}

export interface PrepareOptions extends InspectOptions {
  outputRoot: string;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  const input = createReadStream(path);
  for await (const chunk of input) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export function sha256Buffer(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function extractElectronBridgeMethods(preloadSource: string): string[] {
  const source = ts.createSourceFile(
    'preload.js',
    preloadSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const variableInitializers = new Map<string, ts.Expression>();
  let bridgeExpression: ts.Expression | undefined;

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      variableInitializers.set(node.name.text, node.initializer);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'exposeInMainWorld' &&
      node.arguments.length >= 2
    ) {
      const [worldName, exposedValue] = node.arguments;
      if (
        worldName !== undefined &&
        ts.isStringLiteralLike(worldName) &&
        worldName.text === 'electronBridge' &&
        exposedValue !== undefined
      ) {
        bridgeExpression = exposedValue;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  const resolveExpression = (
    expression: ts.Expression,
    seen = new Set<string>(),
  ): ts.Expression => {
    if (!ts.isIdentifier(expression) || seen.has(expression.text)) return expression;
    const initializer = variableInitializers.get(expression.text);
    if (initializer === undefined) return expression;
    seen.add(expression.text);
    return resolveExpression(initializer, seen);
  };

  if (bridgeExpression === undefined) {
    throw new Error('official preload did not expose electronBridge');
  }
  const bridgeObject = resolveExpression(bridgeExpression);
  if (!ts.isObjectLiteralExpression(bridgeObject)) {
    throw new Error('official electronBridge exposure is not an object literal');
  }

  const methods: string[] = [];
  for (const property of bridgeObject.properties) {
    if (ts.isMethodDeclaration(property)) {
      const name = propertyName(property.name);
      if (name !== undefined) methods.push(name);
      continue;
    }
    if (ts.isPropertyAssignment(property)) {
      const name = propertyName(property.name);
      const value = resolveExpression(property.initializer);
      if (name !== undefined && (ts.isArrowFunction(value) || ts.isFunctionExpression(value))) {
        methods.push(name);
      }
      continue;
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      const value = resolveExpression(property.name);
      if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
        methods.push(property.name.text);
      }
    }
  }
  return [...new Set(methods)].sort();
}

export function extractPreloadChannels(preloadSource: string): string[] {
  return [...new Set(preloadSource.match(CHANNEL_PATTERN) ?? [])].sort();
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return undefined;
}

function normalizedAsarPath(path: string): string {
  return path.replace(/^\/+/u, '');
}

export async function inspectOfficialPackage(options: InspectOptions): Promise<SourceManifest> {
  const asarPath = resolve(options.asarPath);
  const packageBytes = extractFile(asarPath, 'package.json');
  const packageMetadata = packageMetadataSchema.parse(JSON.parse(packageBytes.toString('utf8')));
  const preloadBytes = extractFile(asarPath, '.vite/build/preload.js');
  const preloadSource = preloadBytes.toString('utf8');
  const files = listPackage(asarPath, { isPack: false });
  const rendererFiles = files.map(normalizedAsarPath).filter((path) => {
    if (!path.startsWith('webview/')) return false;
    const entry = statFile(asarPath, path, false);
    return !('files' in entry) && !('link' in entry);
  });
  const hostFiles = files.map(normalizedAsarPath).filter((path) => {
    if (path.startsWith('webview/')) return false;
    const entry = statFile(asarPath, path, false);
    return !('files' in entry) && !('link' in entry);
  });
  const renderer = buildVirtualRendererManifest(asarPath, rendererFiles);
  const host = buildVirtualHostManifest(asarPath, hostFiles);
  const methods = extractElectronBridgeMethods(preloadSource);
  const channels = extractPreloadChannels(preloadSource);

  return sourceManifestSchema.parse({
    formatVersion: 3,
    package: {
      asarPath,
      asarSize: statSync(asarPath).size,
      asarSha256: await sha256File(asarPath),
      fileCount: files.length,
      version: packageMetadata.version,
      buildNumber: packageMetadata.codexBuildNumber,
      buildFlavor: packageMetadata.codexBuildFlavor,
      brand: packageMetadata.codexAppBrand,
    },
    renderer: {
      ...renderer,
      root: 'webview',
    },
    host: {
      ...host,
      root: '.',
    },
    preload: {
      contractVersion: CONTRACT_VERSION,
      rendererVersion: packageMetadata.version,
      appBuildNumber: packageMetadata.codexBuildNumber,
      windowType: 'electron',
      methods: [...new Set(methods)].sort(),
      channels,
      sourceSha256: sha256Buffer(preloadBytes),
    } satisfies PreloadContract,
  });
}

function buildVirtualHostManifest(asarPath: string, files: string[]): SourceManifest['host'] {
  let totalBytes = 0;
  const treeHash = createHash('sha256');
  for (const path of files.sort()) {
    const value = extractFile(asarPath, path);
    const digest = sha256Buffer(value);
    totalBytes += value.length;
    treeHash.update(`${path}\0${value.length}\0${digest}\n`);
  }
  return {
    root: dirname(asarPath),
    fileCount: files.length,
    totalBytes,
    treeSha256: treeHash.digest('hex'),
  };
}

function buildVirtualRendererManifest(
  asarPath: string,
  files: string[],
): SourceManifest['renderer'] {
  const entries: SourceManifest['renderer']['files'] = {};
  let totalBytes = 0;
  const treeHash = createHash('sha256');
  for (const path of files.sort()) {
    const value = extractFile(asarPath, path);
    const rendererPath = path.slice('webview/'.length);
    const digest = sha256Buffer(value);
    entries[rendererPath] = { bytes: value.length, sha256: digest };
    totalBytes += value.length;
    treeHash.update(`${rendererPath}\0${value.length}\0${digest}\n`);
  }
  return {
    root: 'webview',
    fileCount: files.length,
    totalBytes,
    treeSha256: treeHash.digest('hex'),
    files: entries,
  };
}

export async function prepareOfficialPackage(options: PrepareOptions): Promise<SourceManifest> {
  const inspected = await inspectOfficialPackage(options);
  const releaseRoot = resolve(options.outputRoot, inspected.package.version);
  const manifestPath = join(releaseRoot, 'qualification', 'source-manifest.json');
  const temporaryRoot = `${releaseRoot}.prepare-${String(process.pid)}`;

  if (lstatSync(options.outputRoot, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
    throw new Error('official output root must not be a symbolic link');
  }

  rmSync(temporaryRoot, { force: true, recursive: true });
  mkdirSync(join(temporaryRoot, 'qualification'), { recursive: true, mode: 0o750 });
  extractAll(resolve(options.asarPath), join(temporaryRoot, 'source'));
  const extractedRenderer = buildExtractedRendererManifest(
    join(temporaryRoot, 'source', 'webview'),
  );
  const extractedHost = buildExtractedHostManifest(join(temporaryRoot, 'source'));
  if (extractedRenderer.treeSha256 !== inspected.renderer.treeSha256) {
    rmSync(temporaryRoot, { force: true, recursive: true });
    throw new Error('renderer hash changed during extraction');
  }
  if (extractedHost.treeSha256 !== inspected.host.treeSha256) {
    rmSync(temporaryRoot, { force: true, recursive: true });
    throw new Error('host runtime hash changed during extraction');
  }
  const finalManifest: SourceManifest = {
    ...inspected,
    renderer: {
      ...inspected.renderer,
      root: join('..', 'source', 'webview'),
    },
    host: {
      ...inspected.host,
      root: join('..', 'source'),
    },
  };
  writeFileSync(
    join(temporaryRoot, 'qualification', 'source-manifest.json'),
    `${JSON.stringify(finalManifest, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o640 },
  );

  mkdirSync(dirname(releaseRoot), { recursive: true, mode: 0o750 });
  if (lstatSync(releaseRoot, { throwIfNoEntry: false }) !== undefined) {
    const existing = sourceManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
    if (existing.package.asarSha256 === inspected.package.asarSha256) {
      rmSync(temporaryRoot, { force: true, recursive: true });
      return existing;
    }
    rmSync(temporaryRoot, { force: true, recursive: true });
    throw new Error(`release already exists with different bytes: ${releaseRoot}`);
  }
  renameSync(temporaryRoot, releaseRoot);
  return finalManifest;
}

export function verifyPreparedRelease(manifestPath: string): SourceManifest {
  const absoluteManifestPath = resolve(manifestPath);
  const storedManifest = sourceManifestSchema.parse(
    JSON.parse(readFileSync(absoluteManifestPath, 'utf8')),
  );
  const releaseRoot = resolve(dirname(absoluteManifestPath), '..');
  const rendererRoot = resolveQualifiedRoot(
    absoluteManifestPath,
    releaseRoot,
    storedManifest.renderer.root,
  );
  const hostRoot = resolveQualifiedRoot(
    absoluteManifestPath,
    releaseRoot,
    storedManifest.host.root,
  );
  const manifest: SourceManifest = {
    ...storedManifest,
    renderer: { ...storedManifest.renderer, root: rendererRoot },
    host: { ...storedManifest.host, root: hostRoot },
  };
  const actual = buildExtractedRendererManifest(rendererRoot);
  const actualHost = buildExtractedHostManifest(hostRoot);
  if (
    actual.fileCount !== manifest.renderer.fileCount ||
    actual.totalBytes !== manifest.renderer.totalBytes ||
    actual.treeSha256 !== manifest.renderer.treeSha256
  ) {
    throw new Error(
      `official renderer verification failed: expected ${manifest.renderer.treeSha256}, got ${actual.treeSha256}`,
    );
  }
  for (const [path, expected] of Object.entries(manifest.renderer.files)) {
    const observed = actual.files[path];
    if (observed?.sha256 !== expected.sha256 || observed.bytes !== expected.bytes) {
      throw new Error(`official renderer file changed: ${path}`);
    }
  }
  if (
    actualHost.fileCount !== manifest.host.fileCount ||
    actualHost.totalBytes !== manifest.host.totalBytes ||
    actualHost.treeSha256 !== manifest.host.treeSha256
  ) {
    throw new Error(
      `official host runtime verification failed: expected ${manifest.host.treeSha256}, got ${actualHost.treeSha256}`,
    );
  }
  return manifest;
}

function resolveQualifiedRoot(manifestPath: string, releaseRoot: string, path: string): string {
  const resolved = resolve(dirname(manifestPath), path);
  const relativePath = relative(releaseRoot, resolved);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error('official source root escaped its release directory');
  }
  return resolved;
}

function buildExtractedRendererManifest(root: string): SourceManifest['renderer'] {
  const paths = walkFiles(root);
  const files: SourceManifest['renderer']['files'] = {};
  const treeHash = createHash('sha256');
  let totalBytes = 0;
  for (const absolutePath of paths) {
    const path = relative(root, absolutePath).split(sep).join('/');
    const value = readFileSync(absolutePath);
    const digest = sha256Buffer(value);
    files[path] = { bytes: value.length, sha256: digest };
    totalBytes += value.length;
    treeHash.update(`${path}\0${value.length}\0${digest}\n`);
  }
  return {
    root,
    fileCount: paths.length,
    totalBytes,
    treeSha256: treeHash.digest('hex'),
    files,
  };
}

function buildExtractedHostManifest(root: string): SourceManifest['host'] {
  const paths = walkFiles(root, (path) => path !== 'webview' && !path.startsWith(`webview${sep}`));
  const treeHash = createHash('sha256');
  let totalBytes = 0;
  for (const absolutePath of paths) {
    const path = relative(root, absolutePath).split(sep).join('/');
    const value = readFileSync(absolutePath);
    const digest = sha256Buffer(value);
    totalBytes += value.length;
    treeHash.update(`${path}\0${value.length}\0${digest}\n`);
  }
  return {
    root,
    fileCount: paths.length,
    totalBytes,
    treeSha256: treeHash.digest('hex'),
  };
}

function walkFiles(root: string, include: (path: string) => boolean = () => true): string[] {
  const output: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relativePath = relative(root, path);
      if (!include(relativePath)) continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink())
        throw new Error(`symbolic link found in official source tree: ${path}`);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) output.push(path);
      else throw new Error(`unsupported filesystem entry in official source tree: ${path}`);
    }
  };
  visit(root);
  // ASAR manifests are hashed in globally sorted path order. Recursive
  // directory traversal is deterministic, but it is not the same ordering
  // when one entry is a prefix of another (for example `pkg-linux/` and
  // `pkg/`). Normalize the extracted tree to the same global order before
  // hashing so identical package bytes cannot be rejected after extraction.
  return output.sort((left, right) => {
    const leftPath = relative(root, left).split(sep).join('/');
    const rightPath = relative(root, right).split(sep).join('/');
    return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
  });
}

export function locateAsar(applicationOrAsarPath: string): string {
  const path = resolve(applicationOrAsarPath);
  if (basename(path) === 'app.asar') return path;
  return join(path, 'Contents', 'Resources', 'app.asar');
}
