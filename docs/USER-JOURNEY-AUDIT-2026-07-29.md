# Production user-journey audit — 2026-07-29

## Final production baseline

- URL: `https://codexapp.aialra.online`
- Release: `20260729.11-official-26.721.31836`
- Renderer: the unmodified official renderer `26.721.31836`
- Runtime: official `codex-cli 0.146.0-alpha.3.1`
- Authentication: Authentik at the reverse-proxy boundary plus the official
  OpenAI/Codex account inside the isolated user runtime
- Protected systems: OpenCodexApp and its state were not changed
- Rollback target: `20260729.10-official-26.721.31836`

The production release passed the official-renderer, authentication-isolation,
task-start, desktop-tools, approval, backup/restore, core-lifecycle, MCP,
browser-runtime, and service-restart persistence gates. The local test suite
contains 179 passing tests in 38 files.

## How this audit was performed

The audit combined three layers:

1. Real signed-in browser interaction against production.
2. Host-contract tests for every browser-to-desktop and browser-to-app-server
   request exposed by the official renderer.
3. Destructive or stateful lifecycle tests against isolated synthetic users and
   temporary workspaces, followed by cleanup.

Existing user conversations were not edited, archived, renamed, or deleted.
Reversible settings were restored after each test. Synthetic conversations were
deleted through the official app-server API.

## Real browser coverage

### Shell, navigation, history, and composer

- Cold reload and repeated warm reload.
- Sidebar collapse and restore.
- Codex/ChatGPT mode switch and restoration to Codex.
- New-task route, projectless composer, prompt editing, and draft clearing.
- Model and reasoning picker open/close.
- Permission picker open/close.
- Attachment menu open/close.
- Project selector, Create Project dialog, name input, and cancel.
- Task search palette and exact historical result lookup.
- Recent-history rendering after service restart.
- Back, forward, profile, help, and bottom-panel controls.

### Main routes

- New task.
- Pull requests.
- Sites.
- Scheduled tasks.
- Plugins.
- Task search and historical task opening.

Sites, Scheduled tasks, and Plugins loaded real data. Pull requests correctly
reported that GitHub CLI is installed but not authenticated; this is an account
configuration dependency, not a renderer or host failure.

### Settings

Every settings section was opened and allowed to settle:

- General
- Profile
- Appearance
- Voice
- Config
- Personalization
- Pets
- Keyboard shortcuts
- Usage and billing
- Account
- Plugins
- Browser
- Computer Use
- Hooks
- Connections
- Git
- Environment
- Worktrees
- Archived tasks

The following reversible interactions were also exercised:

- Browser approval: Always Ask → Always Allow → Always Ask.
- Add and remove a synthetic browser origin.
- Full CDP access: on → off.
- Browser cache clear.
- Settings search input and clear.
- ChatGPT/Codex mode switch.
- Terminal open, command output, extra tab, close, and panel restore.
- Project name input and dialog cancellation.
- Task draft input and clearing.

The final browser policy remains:

```toml
approval_mode = "always_ask"
full_cdp_access_enabled = false

[origins]
allowed = []
denied = []
```

### Plugins, Apps, MCP, and tools

- Plugin catalog, categories, installed list, details, search, and settings load.
- Eight installed Apps are enabled and callable.
- `app/read` resolves all eight installed Apps with no missing IDs.
- The installed Apps expose 201 official tool summaries.
- A real projectless Codex task invoked the Sites App read-only and returned
  `APPS_TOOL_OK 4`.
- The synthetic Apps task was deleted afterward through `thread/delete`.
- A real MCP server handshake and tool call pass in the isolated MCP gate.
- App-server MCP status enumeration passes.

The VPS's direct refresh of the public ChatGPT Apps directory receives an OpenAI
Cloudflare 403 challenge. The same account and the same Codex binary return 2,445
Apps from a non-datacenter network. This isolates the cause to VPS egress
reputation. It does not prevent installed Apps from being discovered or called,
and it does not prevent the renderer's plugin catalog from loading. An official
Codex-generated directory cache is present on the server, but online public
directory refresh will remain dependent on a trusted egress route.

## Automated end-to-end coverage

### Official UI gate

- The exact official renderer loads.
- Browser bridge connects and becomes ready.
- Page is visibly non-blank.
- Local assets have zero failures.
- Page errors are zero.
- Auth isolation and real task start execute in the same gate.

### Authentication and isolation

- Anonymous requests return 401.
- Spoofed identities return 401.
- Requests without reverse-proxy proof return 401.
- A ticket cannot cross identities.
- Renaming an Authentik user while retaining the stable subject preserves access.
- User workspaces, Codex homes, terminals, downloads, and browser policies remain
  isolated by stable subject.

### Conversation lifecycle and reliability

- Start, read, list, search, archive, restore, and delete.
- Start a real turn and receive the committed result.
- Stop/restart the production service.
- Reconnect the browser bridge.
- Recover the exact committed turn after restart.
- Delete the synthetic persistence task.
- Browser disconnect/reconnect and host restart recovery.
- Correct official notification and server-request envelopes.

### Files and attachments

- File write/read.
- ETag conflict protection.
- Temporary preview.
- Browser upload.
- Folder attachment enumeration.
- Clipboard image path.
- Exact-byte download.
- Single-use download ticket.
- Cross-identity download rejection.

### Terminal, Git, projects, and worktrees

- Terminal create, output, resize, snapshot, and close.
- Unset locale values are omitted; no `LC_ALL=undefined` warning remains.
- Repository metadata, branch, origin, status, and diff.
- Managed worktree create, ownership, and delete.
- `~` and `~/…` resolve to the isolated server workspace.
- Projectless task CWD and directory creation.

### Browser and permissions

- Browser permission persistence and normalization.
- Allowed/denied origin round trip.
- Full-CDP policy round trip.
- Approval request, approve, decline, cancellation, and cleanup.
- Permission profiles and model lists.

### Backup and deployment

- Encrypted backup creation and restore verification.
- Source-boundary check.
- Minimum-storage-reserve check.
- Immutable release staging.
- Official renderer contract check.
- Linux dependency install in the release itself.
- Health check before promotion.
- Atomic current/previous symlink promotion.
- Automatic rollback target retention.

A staging attempt that accidentally contained macOS native Node dependencies was
rejected before promotion by the immutable release gate. The final release was
built from the Linux release base and passed all gates.

## Defects found and fixed during the audit

- Obsolete renderer notification envelope left completed turns visually running.
- Missing host lifecycle messages could produce a white page.
- Missing file picker, attachment, terminal, Git, worktree, browser-permission,
  approval, and task-start host contracts.
- Missing official discovery responses for recommended skills, imported
  connectors, mail provider, ambient suggestions, and fast-mode metrics.
- `~` was passed to Linux `realpath` literally instead of resolving to the
  isolated workspace.
- Expected `fs/readFile` not-found responses were logged as host capability
  failures.
- Undefined locale values were injected into terminal environments.
- Candidate releases could contain native dependencies from the build machine.

Each fix has a regression test and was rechecked against the real official
renderer before promotion.

## Remaining external dependencies

1. GitHub pull-request operations require `gh auth login` for the server user.
2. Live refresh of the entire public Apps directory requires a trusted
   non-datacenter egress route or a change in OpenAI's Cloudflare treatment.
3. Voice capture and Computer Use depend on browser/device capabilities and
   permissions available to the connecting client. Their settings routes and host
   contracts load, but unattended microphone/camera consent was not granted.
4. Logout, account deletion, memory deletion, plugin uninstall, paid actions, and
   production deployment of a new Site were intentionally not executed because
   they are not safely reversible.

These limitations are explicitly separated from renderer parity: the production
host uses the official renderer and official app-server protocols; no replacement
web UI or cloned interaction layer was introduced.
