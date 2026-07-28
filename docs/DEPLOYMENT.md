# Versioned deployment and rollback

Application code, official package bytes, runtime tools, user state, and secrets
use separate roots. A release is copied and fully tested under an `.incomplete`
name. Only a finished release can be atomically selected by the `current`
symbolic link.

`ops/install-release.sh RELEASE SOURCE --stage` prepares an immutable release
without changing service state. `ops/promote-release.sh RELEASE` verifies it
again, updates `current`, restarts the service, checks readiness for 30 seconds,
and restores the previous link on failure. `ops/rollback-release.sh RELEASE`
performs the same guarded operation for an explicit previous release.

Prepared official-package and runtime-tool snapshots must remain root-owned,
readable and executable by the service, and unwritable by every account:

```sh
chmod -R a+rX,a-w /srv/aialra/codexapp-official/releases/VERSION
chmod -R a+rX,a-w /srv/aialra/codexapp-official/runtime-tools
```

Ubuntu 24.04 restricts unprivileged user namespaces through AppArmor. Codex uses
the official Linux `bwrap` sandbox, so production must install the repository's
scoped `bwrap` policy instead of globally disabling that protection:

```sh
APPLICATION_ROOT=/srv/aialra/releases/codexapp-official-web-host/VERSION \
  /srv/aialra/releases/codexapp-official-web-host/VERSION/ops/install-bwrap-apparmor.sh
install -o root -g root -m 0644 \
  /srv/aialra/releases/codexapp-official-web-host/VERSION/ops/systemd/codexapp-official-sandbox-policy.service \
  /etc/systemd/system/codexapp-official-sandbox-policy.service
```

The host unit deliberately allows only `AF_NETLINK` and the `@mount` syscall
group in addition to its previous restrictions. They are required for
`bwrap` to configure loopback and namespace-local mounts. The AppArmor child
profile removes capabilities from programs running inside the sandbox.

Do not use `chmod -R a-w` alone: extraction may preserve owner-only source
manifest files and cause a production-only startup failure.

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
scripts. Their default remains the active `current` release for post-promotion
verification.

Interrupted copies cannot become current. User state is never stored below an
application release and is not converted by rollback.

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
   both decisions return to the model, and both turns complete.
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
