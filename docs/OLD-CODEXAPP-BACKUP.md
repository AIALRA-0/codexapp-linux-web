# Old CodexApp retirement backup

The old CodexApp remains live until production cutover. Its authoritative
conversation data is `/srv/aialra/state/root-home/.codex`, not the browser
workspace directory.

Run `ops/backup-old-codexapp.sh preliminary` while qualification continues. Run
it again with `final` only after the old app-server is stopped during cutover.
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
