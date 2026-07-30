#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

if [[ "$(id -u)" -ne 0 ]]; then
  echo "backup restore smoke must run as root" >&2
  exit 77
fi

application_root="${APPLICATION_ROOT:-/srv/aialra/apps/codexapp-official-web-host/current}"
environment_file="/srv/aialra/config/secrets/codexapp-official-web-host.env"
runtime_parent="/srv/aialra/state"
runtime_root="$(mktemp -d "$runtime_parent/codexapp-backup-restore-smoke.XXXXXXXX")"
state_file="/tmp/codexapp-backup-restore-smoke-$$.json"
archive="/tmp/codexapp-backup-restore-smoke-$$.tar"
archive_checksum="/tmp/codexapp-backup-restore-smoke-$$.tar.sha256"
app_port="13018"
public_origin="http://127.0.0.1:$app_port"
service_user="codexappweb"
service_group="codexappweb"
active_unit=""

source "$application_root/ops/lib/systemd-host-hardening.sh"
codexapp_prepare_host_hardening "$runtime_root"

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

port_is_listening() {
  ss -H -ltn | awk -v suffix=":${app_port}" '$4 ~ suffix "$" { found = 1 } END { exit !found }'
}

stop_isolated_host() {
  if [[ -z "$active_unit" ]]; then
    return
  fi
  systemctl stop "$active_unit" >/dev/null 2>&1 || true
  systemctl reset-failed "$active_unit" >/dev/null 2>&1 || true
  active_unit=""
}

cleanup() {
  local exit_code=$?
  trap - EXIT
  stop_isolated_host
  rm -f -- "$state_file" "$state_file".*.tmp "$archive" "$archive_checksum"
  if [[ -d "$runtime_root" && ! -L "$runtime_root" ]]; then
    find "$runtime_root" -depth -delete
  fi
  exit "$exit_code"
}
trap cleanup EXIT

if [[ ! -d "$application_root" || ! -f "$environment_file" ]]; then
  echo "backup restore smoke application or environment is missing" >&2
  exit 1
fi
if port_is_listening; then
  echo "backup restore smoke port is already in use" >&2
  exit 1
fi
case "$runtime_root" in
  "$runtime_parent"/codexapp-backup-restore-smoke.*) ;;
  *)
    echo "backup restore smoke runtime path is unsafe" >&2
    exit 1
    ;;
esac

chown "$service_user:$service_group" "$runtime_root"
chmod 0700 "$runtime_root"
proxy_secret_file="$(read_environment_value AUTH_PROXY_SECRET_FILE)"
if [[ -z "$proxy_secret_file" || ! -f "$proxy_secret_file" ]]; then
  echo "backup restore smoke proxy proof file is missing" >&2
  exit 1
fi
proxy_secret="$(tr -d '\r\n' <"$proxy_secret_file")"

start_isolated_host() {
  local phase="$1"
  active_unit="codexapp-backup-restore-smoke-${phase}-$$.service"
  systemd-run \
    --quiet \
    --unit "$active_unit" \
    --uid "$service_user" \
    --gid "$service_group" \
    --working-directory "$application_root" \
    --property "EnvironmentFile=$environment_file" \
    "${CODEXAPP_HOST_HARDENING_ARGS[@]}" \
    -- \
    /usr/bin/env \
    "PORT=$app_port" \
    "PUBLIC_ORIGIN=$public_origin" \
    "RUNTIME_ROOT=$runtime_root" \
    "BROWSER_BRIDGE_SCRIPT=$application_root/packages/browser-bridge/dist/index.js" \
    "ELECTRON_NET_WORKER=$application_root/scripts/electron-net-worker.cjs" \
    "ELECTRON_NET_USER_DATA_DIR=$runtime_root/electron-network" \
    /usr/bin/node "$application_root/apps/host/dist/main.js"

  for _attempt in $(seq 1 45); do
    if curl -fs "http://127.0.0.1:$app_port/readyz" >/dev/null 2>&1; then
      return
    fi
    if [[ "$_attempt" -eq 45 ]]; then
      journalctl -u "$active_unit" --no-pager -n 100 >&2 || true
      echo "isolated backup restore host did not become ready" >&2
      exit 1
    fi
    sleep 1
  done
}

run_phase() {
  local action="$1"
  (
    cd "$application_root"
    SMOKE_PERSISTENCE_ACTION="$action" \
      SMOKE_BASE_URL="http://127.0.0.1:$app_port" \
      SMOKE_PUBLIC_ORIGIN="$public_origin" \
      SMOKE_PROXY_SECRET="$proxy_secret" \
      SMOKE_PERSISTENCE_STATE_FILE="$state_file" \
      npm run smoke:host-persistence
  )
}

start_isolated_host create
run_phase create
stop_isolated_host

if ! find "$runtime_root" -mindepth 1 -print -quit | grep -q .; then
  echo "isolated runtime contained no state to back up" >&2
  exit 1
fi
tar -C "$runtime_root" --numeric-owner -cpf "$archive" .
tar -tf "$archive" >/dev/null
sha256sum "$archive" >"$archive_checksum"
sha256sum -c "$archive_checksum"

find "$runtime_root" -mindepth 1 -depth -delete
if find "$runtime_root" -mindepth 1 -print -quit | grep -q .; then
  echo "isolated runtime loss simulation did not empty the state root" >&2
  exit 1
fi
tar -C "$runtime_root" --numeric-owner -xpf "$archive"

start_isolated_host restore
run_phase verify
stop_isolated_host

printf '{"ok":true,"cleanShutdown":true,"archiveVerified":true,"lossSimulated":true,"stateRestored":true,"committedTurnRecovered":true}\n'
