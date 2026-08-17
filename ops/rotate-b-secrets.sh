#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

if [[ "$(id -u)" -ne 0 ]]; then
  echo "B secret rotation must run as root" >&2
  exit 77
fi

script_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_root/lib/release-switch.sh"

exec 9>/run/lock/codexapp-b-release.lock
if ! flock -n 9; then
  echo "another B release transaction is running" >&2
  exit 75
fi

session_key="/srv/aialra/config/secrets/codexapp-official-session.key"
proxy_key="/srv/aialra/config/secrets/codexapp-official-proxy-secret"
proxy_snippet="/srv/aialra/config/nginx/snippets/codexapp-official-proxy-secret.conf"
backup_root="/srv/aialra/backups/codexapp-b-upgrades/$(date -u +%Y%m%dT%H%M%SZ)-secret-rotation"

codexapp_wait_for_controller_safe
codexapp_assert_no_background_work
for required_path in "$session_key" "$proxy_key" "$proxy_snippet" "$codexapp_environment_file"; do
  if [[ ! -f "$required_path" || -L "$required_path" ]]; then
    echo "B secret rotation input is missing or symbolic: $required_path" >&2
    exit 1
  fi
done

mkdir -p "$backup_root"
chmod 0700 "$backup_root"
cp -a -- "$session_key" "$proxy_key" "$proxy_snippet" "$backup_root/"
session_next="$(mktemp "$(dirname "$session_key")/.codexapp-session.XXXXXXXX")"
proxy_next="$(mktemp "$(dirname "$proxy_key")/.codexapp-proxy.XXXXXXXX")"
snippet_next="$(mktemp "$(dirname "$proxy_snippet")/.codexapp-snippet.XXXXXXXX")"
openssl rand -hex 64 >"$session_next"
openssl rand -hex 64 >"$proxy_next"
proxy_header="$(awk -F= '$1 == "AUTH_PROXY_SECRET_HEADER" { sub(/^[^=]*=/, ""); print }' "$codexapp_environment_file")"
if [[ ! "$proxy_header" =~ ^[A-Za-z0-9-]+$ ]]; then
  echo "B proxy proof header is invalid" >&2
  exit 1
fi
proxy_value="$(tr -d '\r\n' <"$proxy_next")"
printf 'proxy_set_header %s "%s";\n' "$proxy_header" "$proxy_value" >"$snippet_next"
chown root:codexappsecrets "$session_next" "$proxy_next"
chmod 0640 "$session_next" "$proxy_next"
chown root:root "$snippet_next"
chmod 0600 "$snippet_next"

restore_secrets() {
  local exit_code=$?
  trap - EXIT
  systemctl stop "$codexapp_service_name" >/dev/null 2>&1 || true
  cp -a -- "$backup_root/$(basename "$session_key")" "$session_key"
  cp -a -- "$backup_root/$(basename "$proxy_key")" "$proxy_key"
  cp -a -- "$backup_root/$(basename "$proxy_snippet")" "$proxy_snippet"
  nginx -t >/dev/null 2>&1 && systemctl reload nginx >/dev/null 2>&1 || true
  systemctl start "$codexapp_service_name" >/dev/null 2>&1 || true
  codexapp_wait_for_health 90 || true
  exit "$exit_code"
}
trap restore_secrets EXIT

systemctl stop "$codexapp_service_name"
mv -f -- "$session_next" "$session_key"
mv -f -- "$proxy_next" "$proxy_key"
mv -f -- "$snippet_next" "$proxy_snippet"
nginx -t
systemctl reload nginx
systemctl start "$codexapp_service_name"
codexapp_wait_for_health 90
codexapp_assert_controller_safe

trap - EXIT
jq -n --arg backup "$backup_root" '{ok:true,rotated:true,backup:$backup}'
