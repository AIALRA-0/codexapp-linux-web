# Production user-journey audit — 2026-07-29

## Final production baseline

- URL: `https://codexapp.aialra.online`
- Release: `20260730.08-official-26.721.31836`
- Renderer: the unmodified official renderer `26.721.31836`
- Runtime: official `codex-cli 0.146.0-alpha.3.1`
- Authentication: Authentik at the reverse-proxy boundary plus the official
  OpenAI/Codex account inside the isolated user runtime
- Protected systems: OpenCodexApp and its state were not changed
- Rollback target: `20260730.07-official-26.721.31836`

The production release passed the official-renderer, authentication-isolation,
task-start, desktop-tools, approval, backup/restore, core-lifecycle, MCP,
browser-runtime, large-thread, concurrent-invocation, and service-restart
persistence gates. The local and Linux candidate suites contain 205 passing
tests in 42 files.

The 2026-07-30 release was staged and qualified separately before promotion.
The same official-window, task-start, authentication-isolation, desktop-tools,
approval, core-lifecycle, MCP, browser-runtime, backup/restore, and
service-restart persistence gates passed before and after the atomic switch.
See [`VALIDATION-2026-07-30.md`](./VALIDATION-2026-07-30.md).

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

Sites, Scheduled tasks, and Plugins loaded real data. The production user's
GitHub device authorization was completed, and `gh auth status` now succeeds
inside that user's isolated server home.

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

The ChatGPT Projects sidebar is a separate official endpoint. A normal Node.js
request from the VPS receives the same Cloudflare 403 challenge, but Electron
43.2.0 with Chromium 150 returns HTTP 200 for the same authenticated account.
Production now routes only that exact official GET request through one shared,
persistent Electron worker. The worker keeps Chromium's user-namespace sandbox,
inherits no host secrets, receives the token only through its pipe, and accepts
no generic URL. Automatic Cookie credentials and response caching are disabled,
so no reusable account state crosses authenticated requests. WARP was removed from the application dependency after the
renderer host route returned HTTP 200 with valid JSON. The post-promotion `.08`
sample completed the full gateway route in about 893 ms.

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

## Performance investigation and release .18

### Root cause separated by layer

The real signed-in browser was observed through command/result metadata without
reading conversation payloads. A trivial browser-to-host command took 456 ms at
p50 and 978 ms at p95 over the then-current public client path. The same bridge
operation on VPS loopback took about 10–14 ms at p50. Nginx already used an
unbuffered WebSocket proxy, so neither response buffering nor the host bridge was
responsible for the approximately half-second public round trip.

The official renderer sends multiple independent Electron-style invocations
during startup, thread opening, branching, and sending. The host gateway had
incorrectly placed every incoming WebSocket frame behind one global promise
queue. A slow `/wham/usage` request therefore blocked unrelated local calls such
as `codex-home`, global state, directory checks, and eventually `turn/start`.
Release .18 preserves frame parsing and sequence validation in order, but runs
independent `command` and `worker-command` invocations concurrently, capped at
128 per connection. Acknowledgements and host-port messages remain ordered. This
matches independent Electron `ipcRenderer.invoke`/`ipcMain.handle` semantics and
does not add a cache, private index, or replacement protocol.

The production concurrency qualification issued the same slow official usage
request alongside a fast local `codex-home` request ten times. The fast request
finished first in 10/10 samples, with 20 ms p50 and 27 ms p95. The slow request
was 245 ms p50 and 329 ms p95. Post-release loopback no-op latency was 13.0 ms
p50 and 25.9 ms p95, compared with 13.8 ms and 37.9 ms immediately before
promotion.

### Public network remains visible

From the Mac, five unauthenticated HTTPS handshakes through the current
transparent path took 2.13–3.16 seconds end to end. The explicit direct SOCKS
path took 1.01–1.62 seconds for four warm samples, with one cold outlier at 6.62
seconds. These measurements stop at the Authentik redirect and contain no
conversation data. They show that client routing and TLS currently dominate the
remaining public-path variability after the server-side queue was removed.

### Large-thread boundary

An isolated copy of a real 442,034,684-byte rollout was tested on the VPS using
the exact official app-server:

- startup: 14.9 seconds
- recent thread list: 24 ms
- metadata-only read: 15 ms
- resume with 10 recent summary turns: 19.5 seconds
- latest 10 summary turns: 15.4 seconds
- previous 10 summary turns: 15.5 seconds
- full read: 16.1 seconds
- app-server process-tree peak: 1.12 GB

The same class of rollout reads in a few seconds on the Mac. VPS disk was not
busy during the tests; the official app-server reparses the large JSONL for each
page and saturates a CPU core. Release .18 deliberately does not introduce a
private conversation index or alternate history store. Old conversations remain
backup-only, as agreed, and very large rollouts are an upstream app-server/CPU
limit rather than a web-host bridge defect.

### Cold-start gate correction

The first .17 candidate cold-started correctly but the visual smoke captured its
official login route before visible content appeared. The old gate waited a
fixed three seconds after bridge readiness. Release .18 instead waits up to 30
seconds for a mounted official root with visible, non-empty content and still
rejects blank pixels, page errors, local asset failures, or a missing bridge.
Two consecutive isolated official-window runs passed before promotion.

### Post-promotion recovery

Promotion was atomic and retained .16 as the rollback target. The production
persistence gate created and committed a synthetic turn, disconnected the
browser bridge, restarted the full service, reconnected with the same subject,
read back the exact turn, and deleted the synthetic thread. The service
subsequently reported zero restarts, no warning-or-higher journal entries, an
unchanged official renderer tree hash, and healthy storage.

### Signed-in post-promotion browser qualification

The real public browser completed the Authentik sign-in flow and loaded the
official production renderer. All mutations below were restricted to synthetic
performance-test threads:

- a warm switch to `确认性能封测2` made the target content visible in 162 ms
- a later switch to `确认性能封测3` made the target content visible in 44 ms
- a synthetic send displayed the exact assistant reply in 2.03 seconds,
  including model generation time
- branching from the latest synthetic reply completed in 364 ms
- archiving that new synthetic branch completed in 771 ms and returned to the
  official new-task screen
- hiding and restoring the conversation sidebar both worked, with the original
  thread content preserved

The browser-control layer itself repeatedly waited 10 seconds for its own
`ab.chatgpt.com` Statsig requests and could make an automation call appear to
take about 30 seconds. In-page clocks showed that the production renderer had
already changed in 44--162 ms. Those controller waits are therefore excluded
from CodexApp product latency. After these operations, the production service
still had zero restarts, no warning-or-higher journal entries, the same official
renderer hash, and a healthy readiness response.

## Defects found and fixed during the audit

- Obsolete renderer notification envelope left completed turns visually running.
- Missing host lifecycle messages could produce a white page.
- A global WebSocket frame queue serialized independent official Electron
  invocations behind slow network requests.
- The visual release gate guessed readiness with a fixed delay instead of
  waiting for visible official content.
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
- The Node.js network stack and WARP both triggered a Cloudflare challenge on
  the authenticated Projects endpoint; a version-pinned Chromium network worker
  now carries only that request.
- The first worker candidate disabled Chromium's sandbox and inherited the host
  environment. The release gate rejected it. The promoted worker keeps the
  namespace sandbox and starts with a sealed environment.

Each fix has a regression test and was rechecked against the real official
renderer before promotion.

## Remaining external dependencies

1. Live refresh of the entire public Apps directory requires a trusted
   non-datacenter egress route or a change in OpenAI's Cloudflare treatment.
   Installed Apps, cached official catalog data, and real App tool calls already
   work. The separate Projects endpoint now passes through the pinned Electron
   route and is no longer blocked.
2. Voice capture and Computer Use depend on browser/device capabilities and
   permissions available to the connecting client. Their settings routes and host
   contracts load, but unattended microphone/camera consent was not granted.
3. Logout, account deletion, memory deletion, plugin uninstall, paid actions, and
   production deployment of a new Site were intentionally not executed because
   they are not safely reversible.
4. The Mac's current transparent routing path adds material TLS and public
   round-trip variance. This is outside the VPS application architecture and
   should be optimized in the local proxy/routing layer.

These limitations are explicitly separated from renderer parity: the production
host uses the official renderer and official app-server protocols; no replacement
web UI or cloned interaction layer was introduced.
