#!/usr/bin/env bash
set -Eeuo pipefail

umask 022

if [[ "$(id -u)" -ne 0 ]]; then
  echo "B backup-retention installer must run as root" >&2
  exit 77
fi

application_root="${APPLICATION_ROOT:-/srv/aialra/apps/codexapp-official-web-host/current}"
source_script="$application_root/ops/prune-b-upgrade-snapshots.sh"
source_service="$application_root/ops/systemd/codexapp-b-backup-retention.service"
source_timer="$application_root/ops/systemd/codexapp-b-backup-retention.timer"
target_script="/usr/local/sbin/codexapp-b-backup-retention"
target_service="/etc/systemd/system/codexapp-b-backup-retention.service"
target_timer="/etc/systemd/system/codexapp-b-backup-retention.timer"

for source_file in "$source_script" "$source_service" "$source_timer"; do
  if [[ ! -f "$source_file" || -L "$source_file" ]]; then
    echo "B backup-retention source is missing or symbolic: $source_file" >&2
    exit 1
  fi
done

bash -n "$source_script"
install -o root -g root -m 0755 "$source_script" "$target_script"
systemd-analyze verify "$source_service" "$source_timer"
install -o root -g root -m 0644 "$source_service" "$target_service"
install -o root -g root -m 0644 "$source_timer" "$target_timer"
systemctl daemon-reload
systemctl enable --now codexapp-b-backup-retention.timer >/dev/null

printf '{"ok":true,"retainedSnapshots":1,"timerEnabled":true}\n'
