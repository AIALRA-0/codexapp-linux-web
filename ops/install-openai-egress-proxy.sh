#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "run as root" >&2
  exit 1
fi

application_root="${APPLICATION_ROOT:-/srv/aialra/apps/codexapp-official-web-host/current}"
source_config="$application_root/ops/privoxy/codexapp-openai-egress.config"
source_unit="$application_root/ops/systemd/codexapp-openai-egress-proxy.service"
target_config="/etc/privoxy/codexapp-openai-egress.config"
target_unit="/etc/systemd/system/codexapp-openai-egress-proxy.service"

if ! command -v privoxy >/dev/null 2>&1; then
  echo "install the Ubuntu privoxy package before running this installer" >&2
  exit 1
fi
if ! command -v warp-cli >/dev/null 2>&1; then
  echo "Cloudflare WARP is not installed" >&2
  exit 1
fi
for source_file in "$source_config" "$source_unit"; do
  if [[ ! -f "$source_file" || -L "$source_file" ]]; then
    echo "managed egress proxy file is missing or symbolic: $source_file" >&2
    exit 1
  fi
done

install -o root -g root -m 0644 "$source_config" "$target_config"
install -o root -g root -m 0644 "$source_unit" "$target_unit"
privoxy --config-test "$target_config"
systemctl daemon-reload
systemctl enable --now warp-svc.service

warp_status="$(warp-cli --accept-tos status)"
if [[ "$warp_status" != *"Connected"* ]]; then
  echo "Cloudflare WARP proxy is not connected" >&2
  exit 1
fi

systemctl enable --now codexapp-openai-egress-proxy.service
systemctl is-active --quiet codexapp-openai-egress-proxy.service

echo '{"ok":true,"listen":"127.0.0.1:40001","warp":"connected"}'
