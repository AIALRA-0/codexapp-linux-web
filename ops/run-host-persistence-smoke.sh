#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

if [[ "$(id -u)" -ne 0 ]]; then
  echo "host persistence smoke must run as root" >&2
  exit 77
fi

application_root="/srv/aialra/apps/codexapp-official-web-host/current"
environment_file="/srv/aialra/config/secrets/codexapp-official-web-host.env"
service_name="codexapp-official-web-host.service"
state_file="/tmp/codexapp-host-persistence-$$.json"
health_url="http://127.0.0.1:13014/readyz"

read_environment_value() {
  local key="$1"
  awk -F= -v key="$key" '
    $1 == key {
      sub(/^[^=]*=/, "")
      print
      exit
    }
  ' "$environment_file"
}

cleanup() {
  local exit_code=$?
  trap - EXIT
  rm -f -- "$state_file" "$state_file".*.tmp
  if (( exit_code != 0 )); then
    journalctl -u "$service_name" --no-pager -n 100 >&2 || true
  fi
  exit "$exit_code"
}
trap cleanup EXIT

proxy_secret_file="$(read_environment_value AUTH_PROXY_SECRET_FILE)"
public_origin="$(read_environment_value PUBLIC_ORIGIN)"
if [[ -z "$proxy_secret_file" || ! -f "$proxy_secret_file" || -z "$public_origin" ]]; then
  echo "persistence smoke authentication configuration is incomplete" >&2
  exit 1
fi
proxy_secret="$(tr -d '\r\n' <"$proxy_secret_file")"
if [[ "${#proxy_secret}" -lt 32 ]]; then
  echo "persistence smoke proxy proof is invalid" >&2
  exit 1
fi

run_phase() {
  local action="$1"
  (
    cd "$application_root"
    SMOKE_PERSISTENCE_ACTION="$action" \
      SMOKE_BASE_URL="http://127.0.0.1:13014" \
      SMOKE_PUBLIC_ORIGIN="$public_origin" \
      SMOKE_PROXY_SECRET="$proxy_secret" \
      SMOKE_PERSISTENCE_STATE_FILE="$state_file" \
      npm run smoke:host-persistence
  )
}

run_phase create
systemctl restart "$service_name"
for _attempt in $(seq 1 45); do
  if curl -fs "$health_url" >/dev/null 2>&1; then
    break
  fi
  if [[ "$_attempt" -eq 45 ]]; then
    echo "candidate service did not recover after the persistence restart" >&2
    exit 1
  fi
  sleep 1
done
run_phase verify

printf '{"ok":true,"browserDisconnect":true,"serviceRestart":true,"committedTurnRecovered":true}\n'
