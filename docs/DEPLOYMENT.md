# Versioned deployment and rollback

Application code, official package bytes, runtime tools, user state, and secrets
use separate roots. A release is copied and fully tested under an `.incomplete`
name. Only a finished release can be atomically selected by the `current`
symbolic link.

`ops/install-release.sh RELEASE SOURCE --stage` prepares an immutable release
without changing service state. `ops/promote-release.sh RELEASE` verifies it
again, updates `current`, restarts the service, checks readiness for up to 90 seconds,
and restores the previous link on failure. The production gate allows up to 90
seconds for a cold start but still requires five consecutive healthy checks.
`ops/rollback-release.sh RELEASE`
performs the same guarded operation for an explicit previous release.

Promotion also reads `/ops/background-work` from the active loopback service.
If any official turn or server request is still active, promotion exits with
code 75 before stopping the service. The one-time upgrade from a legacy release
that lacks this endpoint requires the operator to verify that release is idle
and set `CODEXAPP_CONFIRMED_LEGACY_IDLE=1`; later releases fail closed without an
override.

## Browser loss and background turns

The browser connection is not the lifetime owner of an official Codex turn.
`turn/started` acquires a runtime lease, and only `turn/completed` releases it.
An unresolved approval, dynamic tool call, MCP elicitation, or user-input
request also holds the lease. Closing the tab, putting a laptop to sleep, or
losing the network therefore cannot trigger the ordinary idle runtime stop.

The bridge still keeps a bounded reconnect buffer. If that buffer expires or
overflows, the browser reloads from the official persisted thread state instead
of retaining unlimited memory. Unresolved app-server requests are separately
retained and replayed with the original JSON-RPC id, so a returning browser can
answer the same approval rather than stranding the turn. After the turn and all
requests finish, the normal `IDLE_RUNTIME_SECONDS` countdown resumes.

The production systemd drop-in sets that idle countdown to 24 hours so a large
completed thread remains fast across ordinary page closes and browser restarts.
Active turns are protected separately and never depend on this timer. The host
still bounds the in-process resume cache to 32 idle responses, 8 MiB each, and
the service keeps its 6 GiB memory limit.

This protects tasks from application idle collection and normal guarded
deployments. It does not claim that an in-flight upstream model stream can
survive a kernel crash, VPS power loss, process OOM kill, or forced
administrator kill; completed conversation state remains covered by the
backup/restart recovery gates.

Prepared official-package and runtime-tool snapshots must remain root-owned,
readable and executable by the service, and unwritable by every service account.
The official source tree may be world-readable, but the qualification directory
must use the service group because its source manifest is intentionally not
public:

```sh
chmod -R a+rX,a-w /srv/aialra/codexapp-official/releases/VERSION
chmod -R a+rX,a-w /srv/aialra/codexapp-official/runtime-tools
chown -R root:codexappweb /srv/aialra/codexapp-official/releases/VERSION/qualification
find /srv/aialra/codexapp-official/releases/VERSION/qualification -type d -exec chmod 0750 {} +
find /srv/aialra/codexapp-official/releases/VERSION/qualification -type f -exec chmod 0640 {} +
```

Ubuntu 24.04 restricts unprivileged user namespaces through AppArmor. Codex uses
the official Linux `bwrap` sandbox, so production must install the repository's
scoped `bwrap` policy instead of globally disabling that protection:

```sh
APPLICATION_ROOT=/srv/aialra/releases/codexapp-official-web-host/VERSION \
  /srv/aialra/releases/codexapp-official-web-host/VERSION/ops/install-bwrap-apparmor.sh
APPLICATION_ROOT=/srv/aialra/releases/codexapp-official-web-host/VERSION \
  /srv/aialra/releases/codexapp-official-web-host/VERSION/ops/install-electron-network-apparmor.sh
install -o root -g root -m 0644 \
  /srv/aialra/releases/codexapp-official-web-host/VERSION/ops/systemd/codexapp-official-sandbox-policy.service \
  /etc/systemd/system/codexapp-official-sandbox-policy.service
install -o root -g root -m 0644 \
  /srv/aialra/releases/codexapp-official-web-host/VERSION/ops/systemd/codexapp-official-browser-display.service \
  /etc/systemd/system/codexapp-official-browser-display.service
```

The host unit deliberately allows only `AF_NETLINK` and the `@mount` syscall
group in addition to its previous restrictions. They are required for
`bwrap` to configure loopback and namespace-local mounts. The AppArmor child
profile removes capabilities from programs running inside the sandbox.

Linux browser-tool plugins use a separate Xvfb virtual display. Xvfb exposes
its X11 transport only to localhost through the unit's systemd IP policy, while
the host keeps `PrivateTmp=true` and connects through `DISPLAY=127.0.0.1:99`.
This lets unmodified visible-Chrome plugins run on the server without disabling
Chromium's sandbox or weakening the host's filesystem isolation. The display is
a wanted sidecar rather than a required dependency, so a display failure cannot
restart or take down the main web host.

Create the two owner-only shopping-browser directories under the runtime root
and set all five `AIALRA_SHOPPING_BROWSER_*` values from the environment example.
The plugin manifest imports those values by name; copying the plugin without
them makes the server appear in the MCP list but leaves its tools unavailable.
Keep the plugin cache byte-for-byte unchanged, then add the server-only display,
proxy environment names, and startup window to each user's Codex config with:

```sh
node ops/configure-shopping-browser-mcp.mjs \
  --codex-home /srv/aialra/state/codexapp-official/users/USER_KEY/codex-home \
  --plugin-root /srv/aialra/state/codexapp-official/users/USER_KEY/codex-home/plugins/cache/personal/aialra-shopping-browser/VERSION
```

The migrated GitHub, Gmail, Google Drive, and Outlook skill packages remain
official plugin bytes in the user's cache. Enable them through the user config
without modifying the packages themselves:

```sh
node ops/enable-migrated-skill-plugins.mjs \
  --codex-home /srv/aialra/state/codexapp-official/users/USER_KEY/codex-home
```

Both config helpers create one owner-only backup, replace only the tables they
manage, write atomically, and are safe to run again after an upgrade.

The migrated local Google MCP launcher is pinned to the user's server workspace.
Keep Google account metadata and refresh credentials outside that workspace and
outside Git, then configure the server with:

```sh
node ops/configure-migrated-local-mcp.mjs \
  --codex-home /srv/aialra/state/codexapp-official/users/USER_KEY/codex-home \
  --project-root /srv/aialra/state/codexapp-official/users/USER_KEY/workspace/projects/aialra-email \
  --private-root /srv/aialra/state/codexapp-official/users/USER_KEY/private/mcp
```

The helper also removes the retired `aialra_microsoft_email` table. Its source
RPI Microsoft 365 account is no longer active, so that local connection must not
remain visible or block deployment. This does not disable the official Outlook
plugin or a separately connected active Outlook account.

The pre-promotion capability gate uses
`manifests/server-capabilities-26.730.61639.json`. It fails if any of the 45
migrated Skills, four MCP servers, or required representative tools are absent:

```sh
VERIFY_CAPABILITIES_MANIFEST="$APPLICATION_ROOT/manifests/server-capabilities-26.730.61639.json" \
  node "$APPLICATION_ROOT/scripts/verify-codex-capabilities.mjs"
```

The official Codex app-server also opens the ChatGPT Apps MCP and OpenAI
Developer Docs MCP itself. Datacenter egress can reject or stall those requests
before local MCP tools finish loading. Production uses the Ubuntu `privoxy`
package as a loopback HTTP CONNECT bridge on port 40001 and Cloudflare WARP in
local SOCKS proxy mode on port 40000. Privoxy forwards only `.chatgpt.com` and
`.openai.com` into WARP; every other hostname remains direct. Set `HTTPS_PROXY`
and `NO_PROXY` as shown in the environment example. This changes no official
Codex endpoint, request, token, or MCP protocol.

After accepting the WARP terms and configuring proxy mode, install the checked-in
bridge with:

```sh
apt-get install privoxy
APPLICATION_ROOT=/srv/aialra/releases/codexapp-official-web-host/VERSION \
  /srv/aialra/releases/codexapp-official-web-host/VERSION/ops/install-openai-egress-proxy.sh
```

Install the host unit before promotion. This also creates the stable owner-only
service home used by Chrome and other desktop-compatible tools. It deliberately
does not restart the active host; the guarded promotion performs that step:

```sh
APPLICATION_ROOT=/srv/aialra/releases/codexapp-official-web-host/VERSION \
  /srv/aialra/releases/codexapp-official-web-host/VERSION/ops/install-host-service.sh
```

Do not use `chmod -R a-w` alone: extraction may preserve owner-only source
manifest files and cause a production-only startup failure. Do not make the
qualification manifest world-readable merely to avoid that failure.

The production Nginx candidate continues to use the existing AIALRA unified
authentication snippets and forwards only to loopback port 13014. It replaces
the old site's upstream only during the scheduled cutover.

Nginx injects the private proxy-proof header on both HTTP and WebSocket requests.
The value is stored in a root-only include file and is never delivered to
browser JavaScript. `ops/nginx/codexapp-official-loopback-smoke.conf` reproduces
that boundary on loopback for the real official-window smoke. Run
`ops/run-official-ui-smoke.sh` as root on the VPS: it starts a separate host on
port 13017 with an isolated runtime root, installs the loopback proxy on port
13016, renders and screenshots the official window in real Chromium, and removes
the temporary service, proxy, screenshot, and runtime state on exit. The active
port 13014 service is never restarted or reused by this gate.

Before promotion, set `APPLICATION_ROOT` to the immutable staged release when
running the official-window, desktop-tools, approval, and backup-restore smoke
scripts. Their isolated host services use the same systemd filesystem, device,
privilege, namespace, address-family, syscall, task, and memory restrictions as
production. Their default remains the active `current` release for
post-promotion verification.

Interrupted copies cannot become current. User state is never stored below an
application release and is not converted by rollback.

The installer copies dependencies but excludes `.git`, `.official`, artifacts,
coverage, generated reports, runtime state, and secrets. The qualified official
package is selected through its separate immutable root; it must never be
duplicated below the application release.

The public ChatGPT Apps directory may reject datacenter egress even while normal
Codex turns and installed Apps remain healthy. Codex stores that directory as
official metadata under `cache/codex_app_directory`; it contains no login token.
When a cache is refreshed by the same Codex version and account on a trusted
network, install it atomically into the isolated server Codex home with:

```sh
ops/install-official-app-directory-cache.sh \
  /secure-transfer/e448a982a703ae90fd8068f6b73a30f24c3bff0d.json \
  /srv/aialra/state/codexapp-official/users/USER_KEY/codex-home
```

The installer accepts only the official 40-character cache filename, validates
the schema and connector records, and preserves owner-only permissions. This is
a directory-refresh fallback, not a proxy and not a replacement Apps API.

Official ChatGPT backend requests used by the renderer can receive an OpenAI
Cloudflare challenge when they are fetched through Node.js from the VPS.
Production therefore uses one persistent, version-pinned Electron process for
the renderer's complete `https://chatgpt.com/backend-api/` boundary. It does not
replace any endpoint and does not route app-server model turns, arbitrary
downloads, SSH, or other VPS traffic.

Install Electron 43.2.0 under the path shown in
`ops/codexapp-official-web-host.env.example`, make the complete runtime
root-owned and non-writable, and configure all five `ELECTRON_NET_*` values.
The host refuses a partial configuration and verifies both Electron and Chromium
versions before sending a token.

Ubuntu keeps its global unprivileged-user-namespace restriction enabled. The
repository AppArmor installer opens `userns` only for the exact immutable
Electron binary. The service uses Chromium's namespace sandbox and never passes
`--no-sandbox`.

The worker:

- accepts only credential-free HTTPS URLs on the exact `chatgpt.com` host below
  `/backend-api/`, with no custom port or fragment;
- supports the official renderer's `DELETE`, `GET`, `HEAD`, `OPTIONS`, `PATCH`,
  `POST`, and `PUT` requests, including request bodies and streaming responses;
- receives authentication through the parent-child pipe instead of disk or
  command-line arguments;
- starts with a sealed environment that excludes host secrets;
- omits browser credentials and response caching so a shared worker carries no
  reusable account state between authenticated requests;
- rejects forbidden hop-by-hop and cookie headers, and limits header count,
  header bytes, request bytes, response bytes, concurrent requests, and idle
  duration;
- stays alive for warm requests and restarts on the next request after failure.

The ordinary Node.js egress path remains available only as a narrow fallback for
the projects-sidebar GET. It is not a generic proxy. Renderer diagnostics record
only method, route family, query-key names, status, response type, and duration;
they never record query values, bodies, tokens, or resource identifiers.

`OPENAI_EGRESS_PROXY_URL` remains an optional loopback-only fallback in the
configuration schema, but it is not configured in production. The Projects
route therefore does not use Cloudflare WARP. This is separate from the scoped
`HTTPS_PROXY` loopback bridge above: the official Apps and Developer Docs MCP
still use that bridge for OpenAI-owned hosts, while Projects and all unrelated
VPS traffic remain outside it.

The service readiness endpoint becomes unhealthy below 5 GiB free, while
history reads stay available and new conversation-growing operations are
blocked. A separately allocated emergency reserve can be released by
`ops/check-storage-reserve.sh` to leave room for SQLite recovery and an orderly
shutdown; the script never deletes user data.

Before public cutover, all of the following are mandatory:

1. `readyz`, immutable renderer hash, dependency audit, and contract checks pass.
2. The official-window smoke renders nonblank pixels and receives a bridge-ready
   frame through the loopback Nginx boundary.
3. `ops/run-host-persistence-smoke.sh` creates and commits a synthetic turn
   through the browser bridge, disconnects that browser client, restarts the
   candidate service, reconnects as the same subject, reads the exact turn back,
   and deletes the synthetic thread.
4. `smoke:mcp` starts a required stdio MCP server from the isolated Codex home,
   discovers its advertised tool through `mcpServerStatus/list`, calls that tool
   through `mcpServer/tool/call`, and verifies the exact structured result.
5. `ops/run-backup-restore-smoke.sh` creates an isolated committed turn, cleanly
   stops that host, archives and checksums its complete state, erases only the
   isolated state root, restores it, and proves the exact turn is readable.
6. `ops/run-desktop-tools-smoke.sh` uses the production browser bridge and
   official AppHost path to prove file upload/download, attachment images,
   optimistic writes, cross-identity download rejection, PTY terminal I/O,
   official Git status and managed worktrees, GitHub CLI status, dynamic tool
   ownership, and browser permission persistence inside an isolated runtime.
7. `ops/run-approval-smoke.sh` uses the real version-locked app-server, a
   deterministic isolated Responses endpoint, and the production browser bridge
   to prove accept executes the exact command, decline does not execute it,
   both decisions return to the model, and both turns complete. Its accepted
   turn disconnects before approval, waits longer than the isolated reconnect
   and idle windows, reconnects, receives the same pending approval id, and
   completes the original turn.
8. The hardened in-app browser smoke passes under the production system-call,
   filesystem, device, and privilege restrictions.
9. Anonymous, forged, missing-proof, and cross-subject authentication attempts
   fail closed.
10. The official device-code card displays the server-issued code and successful
    OpenAI authorization reaches the main window without a reload.
11. A deliberately broken release is rejected and automatically returns to the
    previous healthy release.
12. A failed installation leaves neither a selectable target nor an incomplete
    directory.
13. The final old-CodexApp conversation backup is made only after its writers are
    stopped. OpenCodexApp paths remain excluded.
14. `smoke:core-lifecycle` creates a real `thread/fork`, reads and lists the
    fork, then deletes both the fork and source thread.
15. `/ops/background-work` is inactive before every production promotion; an
    active-turn fixture proves the promotion guard refuses to stop the service.
