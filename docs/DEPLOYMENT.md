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

Do not use `chmod -R a-w` alone: extraction may preserve owner-only source
manifest files and cause a production-only startup failure.

The production Nginx candidate continues to use the existing AIALRA unified
authentication snippets and forwards only to loopback port 13014. It replaces
the old site's upstream only during the scheduled cutover.

Nginx injects the private proxy-proof header on both HTTP and WebSocket requests.
The value is stored in a root-only include file and is never delivered to
browser JavaScript. `ops/nginx/codexapp-official-loopback-smoke.conf` reproduces
that boundary on loopback for the real official-window smoke and must not be
left enabled after the test.

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
3. The hardened in-app browser smoke passes under the production system-call,
   filesystem, device, and privilege restrictions.
4. Anonymous, forged, missing-proof, and cross-subject authentication attempts
   fail closed.
5. A deliberately broken release is rejected and automatically returns to the
   previous healthy release.
6. A failed installation leaves neither a selectable target nor an incomplete
   directory.
7. The final old-CodexApp conversation backup is made only after its writers are
   stopped. OpenCodexApp paths remain excluded.
