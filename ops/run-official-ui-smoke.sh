#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

if [[ "$(id -u)" -ne 0 ]]; then
  echo "official UI smoke must run as root" >&2
  exit 77
fi

application_root="${APPLICATION_ROOT:-/srv/aialra/apps/codexapp-official-web-host/current}"
environment_file="/srv/aialra/config/secrets/codexapp-official-web-host.env"
runtime_parent="/srv/aialra/state"
runtime_root="$(mktemp -d "$runtime_parent/codexapp-official-ui-smoke.XXXXXXXX")"
nginx_source="$application_root/ops/nginx/codexapp-official-loopback-smoke.conf"
nginx_target="/etc/nginx/conf.d/codexapp-official-loopback-smoke.conf"
service_name="codexapp-official-ui-smoke-$$.service"
screenshot_path="/tmp/codexapp-official-ui-smoke-$$.png"
app_port="13017"
proxy_port="13016"
proxy_enabled=0

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
  local port="$1"
  ss -H -ltn | awk -v suffix=":${port}" '$4 ~ suffix "$" { found = 1 } END { exit !found }'
}

cleanup() {
  local exit_code=$?
  trap - EXIT

  systemctl stop "$service_name" >/dev/null 2>&1 || true
  systemctl reset-failed "$service_name" >/dev/null 2>&1 || true

  if [[ "$proxy_enabled" -eq 1 && -f "$nginx_target" && ! -L "$nginx_target" ]]; then
    rm -- "$nginx_target"
    nginx -t >/dev/null 2>&1 && systemctl reload nginx >/dev/null 2>&1 || true
  fi

  if [[ -d "$runtime_root" && ! -L "$runtime_root" ]]; then
    find "$runtime_root" -depth -delete
  fi
  rm -f -- "$screenshot_path"

  if (( exit_code != 0 )); then
    journalctl -u "$service_name" --no-pager -n 80 >&2 || true
  fi
  exit "$exit_code"
}
trap cleanup EXIT

for required_path in "$application_root" "$environment_file" "$nginx_source"; do
  if [[ ! -e "$required_path" ]]; then
    echo "required smoke path is missing: $required_path" >&2
    exit 1
  fi
done
if [[ -e "$nginx_target" || -L "$nginx_target" ]]; then
  echo "temporary Nginx smoke configuration already exists" >&2
  exit 1
fi
if port_is_listening "$app_port" || port_is_listening "$proxy_port"; then
  echo "official UI smoke ports are already in use" >&2
  exit 1
fi

service_user="codexappweb"
service_group="codexappweb"
chown "$service_user:$service_group" "$runtime_root"
chmod 0700 "$runtime_root"

browser_executable="$(read_environment_value BROWSER_EXECUTABLE)"
renderer_version="$(read_environment_value EXPECTED_RENDERER_VERSION)"
proxy_secret_file="$(read_environment_value AUTH_PROXY_SECRET_FILE)"
if [[ -z "$browser_executable" || -z "$renderer_version" || -z "$proxy_secret_file" ]]; then
  echo "browser executable, renderer version, or proxy proof file is missing" >&2
  exit 1
fi
if [[ ! -f "$proxy_secret_file" || -L "$proxy_secret_file" ]]; then
  echo "proxy proof file is missing or symbolic" >&2
  exit 1
fi
proxy_secret=""
IFS= read -r proxy_secret <"$proxy_secret_file" || true
if [[ -z "$proxy_secret" ]]; then
  echo "proxy proof is empty" >&2
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
  "PUBLIC_ORIGIN=http://127.0.0.1:$proxy_port" \
  "RUNTIME_ROOT=$runtime_root" \
  "BROWSER_BRIDGE_SCRIPT=$application_root/packages/browser-bridge/dist/index.js" \
  /usr/bin/node "$application_root/apps/host/dist/main.js"

for _attempt in $(seq 1 45); do
  if curl -fs "http://127.0.0.1:$app_port/readyz" >/dev/null 2>&1; then
    break
  fi
  if [[ "$_attempt" -eq 45 ]]; then
    echo "isolated official UI host did not become ready" >&2
    exit 1
  fi
  sleep 1
done

install -o root -g root -m 0644 "$nginx_source" "$nginx_target"
proxy_enabled=1
nginx -t
systemctl reload nginx

for _attempt in $(seq 1 15); do
  if curl -fs "http://127.0.0.1:$proxy_port/" >/dev/null 2>&1; then
    break
  fi
  if [[ "$_attempt" -eq 15 ]]; then
    echo "loopback authentication proxy did not become ready" >&2
    exit 1
  fi
  sleep 1
done

(
  cd "$application_root"
  SMOKE_BASE_URL="http://127.0.0.1:$proxy_port" \
    BROWSER_EXECUTABLE="$browser_executable" \
    SMOKE_RENDERER_VERSION="$renderer_version" \
    SMOKE_SCREENSHOT_PATH="$screenshot_path" \
    npm run smoke:official-ui
  SMOKE_BASE_URL="http://127.0.0.1:$app_port" \
    SMOKE_PUBLIC_ORIGIN="http://127.0.0.1:$proxy_port" \
    SMOKE_PROXY_SECRET="$proxy_secret" \
    npm run smoke:auth-isolation
  SMOKE_BASE_URL="http://127.0.0.1:$app_port" \
    SMOKE_PUBLIC_ORIGIN="http://127.0.0.1:$proxy_port" \
    SMOKE_PROXY_SECRET="$proxy_secret" \
    npm run smoke:task-start
)

printf '{"ok":true,"isolated":true,"proxyBoundary":true,"authIsolation":true,"taskStart":true,"cleanup":"armed"}\n'
