import { randomUUID } from 'node:crypto';

import { connectOfficialBridge, createIdentityHeaders } from './lib/official-bridge-client.mjs';

const baseUrl = process.env.SMOKE_BASE_URL;
const publicOrigin = process.env.SMOKE_PUBLIC_ORIGIN;
const proxySecret = process.env.SMOKE_PROXY_SECRET;
if (baseUrl === undefined || publicOrigin === undefined || proxySecret === undefined) {
  throw new Error('SMOKE_BASE_URL, SMOKE_PUBLIC_ORIGIN, and SMOKE_PROXY_SECRET are required');
}

const identityHeaders = createIdentityHeaders({
  email: 'desktop-tools-smoke@example.invalid',
  proxySecret,
  subject: 'desktop-tools-smoke-subject',
  username: 'desktop-tools-smoke',
});
const otherIdentityHeaders = createIdentityHeaders({
  email: 'desktop-tools-other@example.invalid',
  proxySecret,
  subject: 'desktop-tools-smoke-other-subject',
  username: 'desktop-tools-smoke-other',
});
const bridge = await connectOfficialBridge({
  baseUrl,
  identityHeaders,
  publicOrigin,
});
let appHostConnection;
let terminalSessionId;

try {
  appHostConnection = await bridge.connectAppHost();
  const services = appHostConnection.appHost.services;
  const primaryRuntime = await services.primaryRuntime.get();
  const workspaceRoot = requiredString(primaryRuntime?.cwd, 'primary runtime workspace');
  const appHostWorkspace = await services.workspaceFiles.root();
  if (appHostWorkspace !== workspaceRoot) {
    throw new Error('AppHost and desktop workspace roots diverged');
  }

  const smokeId = randomUUID();
  const smokeRoot = `${workspaceRoot}/.codexapp-desktop-tools-${smokeId}`;
  await bridge.desktopFetch('ensure-directory', {
    hostId: 'local',
    path: smokeRoot,
  });

  const textMarker = `desktop-tools-${smokeId}`;
  const commandResult = await bridge.mcpRequest('command/exec', {
    command: ['/bin/sh', '-c', `printf '${textMarker}\\n'`],
    cwd: smokeRoot,
    timeoutMs: 10_000,
  });
  if (
    commandResult?.exitCode !== 0 ||
    commandResult.stdout !== `${textMarker}\n` ||
    commandResult.stderr !== ''
  ) {
    throw new Error(`app-server command execution changed: ${JSON.stringify(commandResult)}`);
  }
  const [skills, permissionProfiles, models] = await Promise.all([
    bridge.mcpRequest('skills/list', { cwds: [smokeRoot], forceReload: true }),
    bridge.mcpRequest('permissionProfile/list', { cwd: smokeRoot, limit: 100 }),
    bridge.mcpRequest('model/list', { includeHidden: false, limit: 100 }),
  ]);
  if (
    !Array.isArray(skills?.data) ||
    !Array.isArray(permissionProfiles?.data) ||
    !Array.isArray(models?.data)
  ) {
    throw new Error('app-server skills, permission profiles, or model catalog changed');
  }

  const textPath = `${smokeRoot}/qualification.txt`;
  const initialWrite = await services.workspaceFiles.write({
    bytes: new TextEncoder().encode(`${textMarker}\n`),
    hostId: 'local',
    ifMatch: null,
    path: textPath,
  });
  if (initialWrite?.outcome !== 'saved') throw new Error('workspace file was not saved');
  const initialRead = await services.workspaceFiles.read({
    hostId: 'local',
    path: textPath,
    representation: 'text',
  });
  if (initialRead?.text !== `${textMarker}\n`) {
    throw new Error('workspace file contents changed');
  }
  const conflict = await services.workspaceFiles.write({
    bytes: new TextEncoder().encode('must not be written\n'),
    hostId: 'local',
    ifMatch: 'wrong-etag',
    path: textPath,
  });
  if (conflict?.outcome !== 'conflict') {
    throw new Error('workspace optimistic-write conflict was not detected');
  }
  const folderCount = await services.fileAttachments.countFolderFiles({
    folderPath: smokeRoot,
    hostId: 'local',
  });
  if (folderCount !== 1) throw new Error(`attachment folder count changed: ${String(folderCount)}`);

  const imageBytes = Uint8Array.from(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  const imagePath = await services.fileAttachments.persistImageFileToTemp({
    bytes: imageBytes,
    mimeType: 'image/png',
  });
  const persistedImagePath = requiredString(imagePath, 'persisted image path');
  const persistedImage = await services.workspaceFiles.read({
    hostId: 'local',
    path: persistedImagePath,
    representation: 'blob',
  });
  if (persistedImage?.blob !== Buffer.from(imageBytes).toString('base64')) {
    throw new Error('persisted image contents changed');
  }

  const temporary = await services.workspaceFiles.createTemporaryFile({
    bytes: new TextEncoder().encode(textMarker),
    fileName: 'preview.txt',
  });
  const temporaryPath = requiredString(temporary?.path, 'temporary preview path');
  const temporaryRead = await services.workspaceFiles.read({
    hostId: 'local',
    path: temporaryPath,
    representation: 'text',
  });
  if (temporaryRead?.text !== textMarker) throw new Error('temporary preview contents changed');
  await services.workspaceFiles.releaseTemporaryFile({ path: temporaryPath });

  const uploadId = randomUUID();
  const uploadName = 'browser-upload.txt';
  const uploadBody = `browser-upload-${smokeId}\n`;
  const uploadResponse = await fetch(
    `${baseUrl}/api/uploads/${uploadId}/${encodeURIComponent(uploadName)}`,
    {
      method: 'PUT',
      headers: {
        ...identityHeaders,
        'content-type': 'text/plain; charset=utf-8',
      },
      body: uploadBody,
    },
  );
  if (uploadResponse.status !== 201) {
    throw new Error(`browser upload failed: ${String(uploadResponse.status)}`);
  }
  const uploadPath = `${bridge.bootstrap.uploadPathPrefix}/${uploadId}/${uploadName}`;
  const uploaded = await services.workspaceFiles.read({
    hostId: 'local',
    path: uploadPath,
    representation: 'text',
  });
  if (uploaded?.text !== uploadBody) throw new Error('browser upload contents changed');

  const downloadMessage = bridge.waitForViewMessage(
    (message) => message?.type === '__browser-download' && message.fileName === 'qualification.txt',
  );
  await services.workspaceFiles.downloadCopy({
    hostId: 'local',
    path: textPath,
  });
  const download = await downloadMessage;
  const downloadUrl = `${baseUrl}/api/downloads/${encodeURIComponent(
    requiredString(download.token, 'download token'),
  )}/${encodeURIComponent(requiredString(download.fileName, 'download filename'))}`;
  const crossIdentityDownload = await fetch(downloadUrl, {
    headers: otherIdentityHeaders,
    redirect: 'manual',
  });
  if (crossIdentityDownload.status !== 404) {
    throw new Error('cross-identity download token was accepted');
  }
  const downloaded = await fetch(downloadUrl, { headers: identityHeaders });
  if (!downloaded.ok || (await downloaded.text()) !== `${textMarker}\n`) {
    throw new Error('browser download did not return the exact file');
  }
  const replayedDownload = await fetch(downloadUrl, { headers: identityHeaders });
  if (replayedDownload.status !== 404) {
    throw new Error('single-use download token was reusable');
  }

  const terminalEvents = [];
  await services.terminal.subscribe((event) => {
    terminalEvents.push(event);
  });
  terminalSessionId = `desktop-tools-${smokeId}`;
  await services.terminal.create({
    cols: 100,
    conversationId: smokeId,
    conversationTitle: 'Desktop tools smoke',
    cwd: smokeRoot,
    forceCwdSync: false,
    hostId: 'local',
    rows: 30,
    sessionId: terminalSessionId,
  });
  await waitForTerminalEvent(
    terminalEvents,
    (event) => event?.type === 'attached' && event.sessionId === terminalSessionId,
    'terminal attach',
  );
  const terminalMarker = `terminal-${smokeId}`;
  await services.terminal.write(terminalSessionId, `printf '${terminalMarker}\\n'\n`);
  await waitForTerminalEvent(
    terminalEvents,
    (event) =>
      event?.type === 'data' &&
      event.sessionId === terminalSessionId &&
      event.data.includes(terminalMarker),
    'terminal output',
  );
  await services.terminal.resize(terminalSessionId, 120, 40);
  const terminalSnapshot = await services.terminal.getThreadSnapshot(smokeId);
  if (
    terminalSnapshot?.cwd !== smokeRoot ||
    !requiredString(terminalSnapshot?.buffer, 'terminal buffer').includes(terminalMarker)
  ) {
    throw new Error('terminal snapshot did not contain the exact command output');
  }

  const repositoryReadyMarker = `git-ready-${smokeId}`;
  await services.terminal.runAction(
    terminalSessionId,
    smokeRoot,
    [
      'git init --initial-branch=main .',
      'git config user.name "CodexApp Qualification"',
      'git config user.email "qualification@example.invalid"',
      'git add qualification.txt',
      'git commit -m "qualification"',
      'git remote add origin https://example.invalid/qualification.git',
      `printf '${repositoryReadyMarker}\\n'`,
    ].join(' && '),
  );
  await waitForTerminalEvent(
    terminalEvents,
    (event) =>
      event?.type === 'data' &&
      event.sessionId === terminalSessionId &&
      event.data.includes(repositoryReadyMarker),
    'Git repository setup',
  );

  const metadata = await bridge.workerRequest('git', 'stable-metadata', {
    cwd: smokeRoot,
    operationSource: 'qualification',
  });
  const repositoryRoot = requiredString(metadata?.root, 'official Git repository root');
  const branch = await bridge.workerRequest('git', 'current-branch-snapshot', {
    operationSource: 'qualification',
    root: repositoryRoot,
  });
  if (branch?.branch !== 'main') throw new Error('official Git worker returned another branch');
  const origins = await bridge.workerRequest('git', 'git-origins', {
    dirs: [smokeRoot],
    operationSource: 'qualification',
  });
  if (
    !JSON.stringify(origins).includes('https://example.invalid/qualification.git') ||
    !JSON.stringify(origins).includes(repositoryRoot)
  ) {
    throw new Error('official Git worker did not return the exact origin');
  }

  const modified = await services.workspaceFiles.write({
    bytes: new TextEncoder().encode(`${textMarker}\nmodified\n`),
    hostId: 'local',
    ifMatch: initialRead.etag,
    path: textPath,
  });
  if (modified?.outcome !== 'saved') throw new Error('workspace modification was not saved');
  const status = await bridge.workerRequest('git', 'status-summary', {
    cwd: smokeRoot,
    operationSource: 'qualification',
  });
  if (status?.type !== 'success' || status.unstagedCount !== 1) {
    throw new Error(`official Git status omitted the modified file: ${JSON.stringify(status)}`);
  }

  const worktree = await bridge.workerRequest('git', 'create-worktree', {
    cwd: smokeRoot,
    localEnvironmentConfigPath: null,
    operationSource: 'qualification',
    startingState: { type: 'branch', branchName: 'main' },
    streamId: `desktop-tools-${smokeId}`,
    worktreesRoot: '',
  });
  if (worktree?.setupError !== null) {
    throw new Error(`official worktree setup failed: ${String(worktree?.setupError)}`);
  }
  const worktreeRoot = requiredString(worktree?.worktreeGitRoot, 'official worktree Git root');
  const worktreeWorkspace = requiredString(
    worktree?.worktreeWorkspaceRoot,
    'official worktree workspace root',
  );
  const worktreeFile = await services.workspaceFiles.read({
    hostId: 'local',
    path: `${worktreeWorkspace}/qualification.txt`,
    representation: 'text',
  });
  if (worktreeFile?.text !== `${textMarker}\n`) {
    throw new Error('official worktree did not contain the committed file');
  }
  const owner = await bridge.workerRequest('git', 'set-worktree-owner-thread', {
    conversationId: smokeId,
    operationSource: 'worktree_set_owner_thread',
    worktree: worktreeRoot,
  });
  if (owner?.success !== true) throw new Error('official worktree owner was not recorded');
  const deleted = await bridge.workerRequest('git', 'delete-worktree', {
    force: true,
    operationSource: 'worktree_archive_cleanup',
    reason: 'archive-cleanup',
    worktree: worktreeRoot,
  });
  if (deleted?.success !== true) throw new Error('official worktree was not deleted');

  const githubRequest = await services.github.request(
    'gh-cli-status',
    { hostId: 'local', hostname: 'github.com' },
    'qualification',
  );
  const githubStatus = await githubRequest.wait();
  if (
    typeof githubStatus?.isInstalled !== 'boolean' ||
    typeof githubStatus?.isAuthenticated !== 'boolean'
  ) {
    throw new Error('official GitHub CLI status response changed');
  }

  const firstClaim = await services.dynamicToolCalls.tryClaimExecution({
    callId: 'call',
    hostId: 'local',
    threadId: smokeId,
    turnId: 'turn',
  });
  const repeatedClaim = await services.dynamicToolCalls.tryClaimExecution({
    callId: 'call',
    hostId: 'local',
    threadId: smokeId,
    turnId: 'turn',
  });
  if (firstClaim !== true || repeatedClaim !== false) {
    throw new Error('dynamic tool execution claim was not single-owner');
  }

  const permissions = await services.browserUsePermissions.updateOriginRules([
    {
      action: 'add',
      kind: 'allowed',
      origin: 'https://desktop-tools.example.invalid/path',
      resource: 'origin',
    },
  ]);
  if (!permissions?.allowedOrigins?.includes('https://desktop-tools.example.invalid')) {
    throw new Error('browser permission origin was not normalized');
  }
  await services.browserUsePermissions.updateOriginRules([
    {
      action: 'remove',
      kind: 'allowed',
      origin: 'https://desktop-tools.example.invalid',
      resource: 'origin',
    },
  ]);

  await services.terminal.close(terminalSessionId);
  terminalSessionId = undefined;
  await services.terminal.unsubscribe();

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      rendererVersion: bridge.bootstrap.rendererVersion,
      appServer: ['command-exec', 'skills-list', 'permission-profiles', 'model-list'],
      appHost: true,
      workspaceFiles: ['write', 'read', 'etag-conflict', 'temporary-preview'],
      attachments: ['browser-upload', 'folder-count', 'clipboard-image'],
      downloads: ['exact-bytes', 'cross-identity-rejected', 'single-use'],
      terminal: ['create', 'output', 'resize', 'snapshot', 'close'],
      git: [
        'repository-metadata',
        'branch',
        'origin',
        'status-diff',
        'worktree-create',
        'worktree-own',
        'worktree-delete',
      ],
      githubCli: githubStatus,
      dynamicToolClaim: 'single-owner',
      browserPermissions: 'persisted-and-normalized',
    })}\n`,
  );
} finally {
  if (terminalSessionId !== undefined && appHostConnection !== undefined) {
    await appHostConnection.appHost.services.terminal
      .close(terminalSessionId)
      .catch(() => undefined);
  }
  appHostConnection?.close();
  bridge.close();
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is missing`);
  return value;
}

async function waitForTerminalEvent(events, predicate, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const event = events.find(predicate);
    if (event !== undefined) return event;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label} timed out; observed ${String(events.length)} terminal events`);
}
