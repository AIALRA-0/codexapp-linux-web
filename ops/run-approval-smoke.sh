#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

if [[ "$(id -u)" -ne 0 ]]; then
  echo "approval smoke must run as root" >&2
  exit 77
fi

application_root="${APPLICATION_ROOT:-/srv/aialra/apps/codexapp-official-web-host/current}"
environment_file="${ENVIRONMENT_FILE:-/srv/aialra/config/secrets/codexapp-official-web-host.env}"
runtime_parent="/srv/aialra/state"
runtime_root="$(mktemp -d "$runtime_parent/codexapp-approval-smoke.XXXXXXXX")"
host_service_name="codexapp-approval-smoke-host-$$.service"
fixture_service_name="codexapp-approval-smoke-fixture-$$.service"
host_port="13020"
fixture_port="13021"
public_origin="http://127.0.0.1:$host_port"
fixture_url="http://127.0.0.1:$fixture_port"
service_user="codexappweb"
service_group="codexappweb"
user_key="$(printf %s 'approval-smoke-subject' | sha256sum | awk '{print $1}')"
user_root="$runtime_root/users/$user_key"
codex_home="$user_root/codex-home"
workspace_root="$user_root/workspace"
accepted_marker="$workspace_root/approval-accepted.txt"
declined_marker="$workspace_root/approval-declined.txt"

source "$application_root/ops/lib/systemd-host-hardening.sh"
source "$application_root/ops/lib/pinned-official-release.sh"
codexapp_load_pinned_official_release "$application_root"
codexapp_prepare_host_hardening "$runtime_root" "$service_user" "$service_group"

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
  systemctl stop "$host_service_name" >/dev/null 2>&1 || true
  systemctl stop "$fixture_service_name" >/dev/null 2>&1 || true
  systemctl reset-failed "$host_service_name" >/dev/null 2>&1 || true
  systemctl reset-failed "$fixture_service_name" >/dev/null 2>&1 || true
  if [[ -d "$runtime_root" && ! -L "$runtime_root" ]]; then
    find "$runtime_root" -depth -delete
  fi
  if (( exit_code != 0 )); then
    journalctl -u "$host_service_name" --no-pager -n 120 >&2 || true
    journalctl -u "$fixture_service_name" --no-pager -n 120 >&2 || true
  fi
  exit "$exit_code"
}
trap cleanup EXIT

if [[ ! -d "$application_root" || ! -f "$environment_file" ]]; then
  echo "approval smoke application or environment is missing" >&2
  exit 1
fi
if port_is_listening "$host_port" || port_is_listening "$fixture_port"; then
  echo "approval smoke port is already in use" >&2
  exit 1
fi
case "$runtime_root" in
  "$runtime_parent"/codexapp-approval-smoke.*) ;;
  *)
    echo "approval smoke runtime path is unsafe" >&2
    exit 1
    ;;
esac

install -d -o "$service_user" -g "$service_group" -m 0700 \
  "$runtime_root" \
  "$runtime_root/users" \
  "$user_root" \
  "$codex_home" \
  "$workspace_root"
config_file="$codex_home/config.toml"
{
  printf '%s\n' \
    'model = "gpt-5.4"' \
    'approval_policy = "untrusted"' \
    'sandbox_mode = "workspace-write"' \
    'model_provider = "approval_fixture"' \
    'disable_response_storage = true' \
    '' \
    '[model_providers.approval_fixture]' \
    'name = "CodexApp approval qualification fixture"' \
    "base_url = \"$fixture_url/v1\"" \
    'wire_api = "responses"' \
    'requires_openai_auth = false' \
    'supports_websockets = false' \
    'request_max_retries = 0' \
    'stream_max_retries = 0' \
    '' \
    '[features]' \
    'plugins = false'
} >"$config_file"
chown "$service_user:$service_group" "$config_file"
chmod 0600 "$config_file"

proxy_secret_file="$(read_environment_value AUTH_PROXY_SECRET_FILE)"
if [[ -z "$proxy_secret_file" || ! -f "$proxy_secret_file" ]]; then
  echo "approval smoke proxy proof file is missing" >&2
  exit 1
fi
proxy_secret="$(tr -d '\r\n' <"$proxy_secret_file")"
if [[ "${#proxy_secret}" -lt 32 ]]; then
  echo "approval smoke proxy proof is invalid" >&2
  exit 1
fi

systemd-run \
  --quiet \
  --unit "$fixture_service_name" \
  --uid "$service_user" \
  --gid "$service_group" \
  --working-directory "$application_root" \
  -- \
  /usr/bin/env \
  "APPROVAL_FIXTURE_PORT=$fixture_port" \
  "APPROVAL_ACCEPTED_MARKER=$accepted_marker" \
  "APPROVAL_DECLINED_MARKER=$declined_marker" \
  /usr/bin/node "$application_root/scripts/fixtures/responses-approval-server.mjs"

for _attempt in $(seq 1 30); do
  if curl -fs "$fixture_url/healthz" >/dev/null 2>&1; then
    break
  fi
  if [[ "$_attempt" -eq 30 ]]; then
    echo "approval fixture did not become ready" >&2
    exit 1
  fi
  sleep 1
done

systemd-run \
  --quiet \
  --unit "$host_service_name" \
  --uid "$service_user" \
  --gid "$service_group" \
  --working-directory "$application_root" \
  --property "EnvironmentFile=$environment_file" \
  "${CODEXAPP_HOST_HARDENING_ARGS[@]}" \
  -- \
  /usr/bin/env \
  "${CODEXAPP_PINNED_OFFICIAL_ENV[@]}" \
  "${CODEXAPP_HOST_SERVICE_ENV[@]}" \
  "PORT=$host_port" \
  "PUBLIC_ORIGIN=$public_origin" \
  "RUNTIME_ROOT=$runtime_root" \
  "BRIDGE_RECONNECT_SECONDS=1" \
  "IDLE_RUNTIME_SECONDS=60" \
  "BROWSER_BRIDGE_SCRIPT=$application_root/packages/browser-bridge/dist/index.js" \
  "ELECTRON_NET_WORKER=$application_root/scripts/electron-net-worker.cjs" \
  "ELECTRON_NET_USER_DATA_DIR=$runtime_root/electron-network" \
  "NO_PROXY=127.0.0.1,localhost" \
  "no_proxy=127.0.0.1,localhost" \
  /usr/bin/node "$application_root/apps/host/dist/main.js"

for _attempt in $(seq 1 45); do
  if curl -fs "http://127.0.0.1:$host_port/readyz" >/dev/null 2>&1; then
    break
  fi
  if [[ "$_attempt" -eq 45 ]]; then
    echo "isolated approval host did not become ready" >&2
    exit 1
  fi
  sleep 1
done

(
  cd "$application_root"
  SMOKE_BASE_URL="http://127.0.0.1:$host_port" \
    SMOKE_PUBLIC_ORIGIN="$public_origin" \
    SMOKE_PROXY_SECRET="$proxy_secret" \
    APPROVAL_FIXTURE_URL="$fixture_url" \
    SMOKE_BACKGROUND_RETENTION_MS=65000 \
    npm run smoke:approvals
)

printf '{"ok":true,"isolated":true,"runtimeCleanup":"armed","productionPortUntouched":true}\n'
