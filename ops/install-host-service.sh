#!/usr/bin/env bash
set -Eeuo pipefail

umask 022

if [[ "$(id -u)" -ne 0 ]]; then
  echo "host service installer must run as root" >&2
  exit 77
fi

application_root="${APPLICATION_ROOT:-/srv/aialra/apps/codexapp-official-web-host/current}"
source_unit="$application_root/ops/systemd/codexapp-official-web-host.service"
target_unit="/etc/systemd/system/codexapp-official-web-host.service"
source_drop_in="$application_root/ops/systemd/codexapp-official-web-host.service.d/idle-runtime.conf"
target_drop_in_directory="/etc/systemd/system/codexapp-official-web-host.service.d"
target_drop_in="$target_drop_in_directory/idle-runtime.conf"
service_home="/srv/aialra/state/codexapp-official/service-home"

if [[ ! -f "$source_unit" || -L "$source_unit" ]]; then
  echo "host service unit is missing or symbolic" >&2
  exit 1
fi
if [[ ! -f "$source_drop_in" || -L "$source_drop_in" ]]; then
  echo "host service idle runtime drop-in is missing or symbolic" >&2
  exit 1
fi
if ! getent passwd codexappweb >/dev/null || ! getent group codexappweb >/dev/null; then
  echo "codexappweb service account is missing" >&2
  exit 1
fi

install -d -o codexappweb -g codexappweb -m 0700 \
  "$service_home" \
  "$service_home/.cache" \
  "$service_home/.config" \
  "$service_home/.local" \
  "$service_home/.local/share" \
  "$service_home/.local/share/applications"
install -o root -g root -m 0644 "$source_unit" "$target_unit"
install -d -o root -g root -m 0755 "$target_drop_in_directory"
install -o root -g root -m 0644 "$source_drop_in" "$target_drop_in"
systemctl daemon-reload
systemctl enable codexapp-official-web-host.service >/dev/null

printf '{"ok":true,"idleRuntimeSeconds":86400,"serviceHome":"%s","unitInstalled":true,"serviceRestarted":false}\n' \
  "$service_home"
