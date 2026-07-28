#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

if [[ "$(id -u)" -ne 0 ]]; then
  echo "desktop tools smoke must run as root" >&2
  exit 77
fi

application_root="${APPLICATION_ROOT:-/srv/aialra/apps/codexapp-official-web-host/current}"
environment_file="/srv/aialra/config/secrets/codexapp-official-web-host.env"
runtime_parent="/srv/aialra/state"
runtime_root="$(mktemp -d "$runtime_parent/codexapp-desktop-tools-smoke.XXXXXXXX")"
service_name="codexapp-desktop-tools-smoke-$$.service"
app_port="13019"
public_origin="http://127.0.0.1:$app_port"

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

cleanup() {
  local exit_code=$?
  trap - EXIT
  systemctl stop "$service_name" >/dev/null 2>&1 || true
  systemctl reset-failed "$service_name" >/dev/null 2>&1 || true
  if [[ -d "$runtime_root" && ! -L "$runtime_root" ]]; then
    find "$runtime_root" -depth -delete
  fi
  if (( exit_code != 0 )); then
    journalctl -u "$service_name" --no-pager -n 120 >&2 || true
  fi
  exit "$exit_code"
}
trap cleanup EXIT

if [[ ! -d "$application_root" || ! -f "$environment_file" ]]; then
  echo "desktop tools smoke application or environment is missing" >&2
  exit 1
fi
if port_is_listening; then
  echo "desktop tools smoke port is already in use" >&2
  exit 1
fi
case "$runtime_root" in
  "$runtime_parent"/codexapp-desktop-tools-smoke.*) ;;
  *)
    echo "desktop tools smoke runtime path is unsafe" >&2
    exit 1
    ;;
esac

service_user="codexappweb"
service_group="codexappweb"
chown "$service_user:$service_group" "$runtime_root"
chmod 0700 "$runtime_root"

proxy_secret_file="$(read_environment_value AUTH_PROXY_SECRET_FILE)"
if [[ -z "$proxy_secret_file" || ! -f "$proxy_secret_file" ]]; then
  echo "desktop tools smoke proxy proof file is missing" >&2
  exit 1
fi
proxy_secret="$(tr -d '\r\n' <"$proxy_secret_file")"
if [[ "${#proxy_secret}" -lt 32 ]]; then
  echo "desktop tools smoke proxy proof is invalid" >&2
  exit 1
fi

systemd-run \
  --quiet \
  --unit "$service_name" \
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
  /usr/bin/node "$application_root/apps/host/dist/main.js"

for _attempt in $(seq 1 45); do
  if curl -fs "http://127.0.0.1:$app_port/readyz" >/dev/null 2>&1; then
    break
  fi
  if [[ "$_attempt" -eq 45 ]]; then
    echo "isolated desktop tools host did not become ready" >&2
    exit 1
  fi
  sleep 1
done

(
  cd "$application_root"
  SMOKE_BASE_URL="http://127.0.0.1:$app_port" \
    SMOKE_PUBLIC_ORIGIN="$public_origin" \
    SMOKE_PROXY_SECRET="$proxy_secret" \
    npm run smoke:desktop-tools
)

printf '{"ok":true,"isolated":true,"runtimeCleanup":"armed","productionPortUntouched":true}\n'
