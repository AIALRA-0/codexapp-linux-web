# Old CodexApp retirement backup

The old CodexApp web framework was retired on 2026-07-30 after the official web
host passed candidate, production, persistence, and Projects-route gates.

Its authoritative conversation data remains
`/srv/aialra/state/root-home/.codex`, not the retired browser workspace
directory.

The verified final encrypted backup contains 211 session files and
3,879,929,776 bytes of source conversation data. Its ciphertext and SHA-256
sidecar remain under `/srv/aialra/backups/codexapp-official`.

The retired `/srv/aialra/apps/codexapp` framework, its disabled systemd units,
temporary output, and logs were removed. OpenCodexApp was not removed. Its
legacy 40 KiB browser-workspace marker was moved into
`/srv/aialra/data/opencodexapp/legacy-browser-workspaces` before the old parent
directory was deleted.

For a future retirement rehearsal, run `ops/backup-old-codexapp.sh preliminary`
while qualification continues. Run it again with `final` only after the old
app-server is stopped during cutover.
The output is encrypted to the existing unified-backup recipient certificate and
the plaintext inputs are verified before encryption. The completed ciphertext is
hashed before the plaintext work directory is removed. The private decryption
key remains offline, so the VPS does not attempt to load a multi-gigabyte CMS
payload into memory merely to parse it.

The backup intentionally excludes:

- old downloadable Codex binaries and package caches;
- plugin caches that can be installed again;
- browser workspaces;
- `/srv/aialra/apps/codexapp/state/browser-workspaces/2026-06-10-opencodexapp`.

No old path is deleted by this script.
