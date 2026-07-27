# Filesystem ownership and deletion boundary

The new project may own only these server paths:

- `/srv/aialra/apps/codexapp-official-web-host`
- `/srv/aialra/codexapp-official`
- `/srv/aialra/releases/codexapp-official-web-host`
- `/srv/aialra/state/codexapp-official`
- `/srv/aialra/backups/codexapp-official`
- its explicitly named systemd units and reverse-proxy route

It must never recursively delete:

- `/srv/aialra/apps/codexapp`
- `/srv/aialra/apps/codexapp/state/browser-workspaces`
- `/srv/aialra/apps/codexapp/state/browser-workspaces/2026-06-10-opencodexapp`
- `/srv/aialra/apps/open-codex-app-web-gateway`
- `/srv/aialra/state/opencodexapp-codex-home`

Old CodexApp retirement is a separate, inventory-driven operation. Every removal
target must be compared with an approved ownership manifest and backed up first.
