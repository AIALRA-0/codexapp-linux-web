#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

if [[ "$(id -u)" -ne 0 ]]; then
  echo "production UI smoke must run as root" >&2
  exit 77
fi

user_key="${1:-}"
thread_id="${2:-}"
expected_text="${3:-}"
if [[ ! "$user_key" =~ ^[0-9a-f]{64}$ ]] ||
  [[ ! "$thread_id" =~ ^[0-9a-f-]{36}$ ]] ||
  [[ -z "$expected_text" ]]; then
  echo "usage: run-production-ui-smoke.sh USER_KEY THREAD_ID EXPECTED_TEXT" >&2
  exit 64
fi

application_root="${CODEXAPP_APPLICATION_ROOT:-/srv/aialra/apps/codexapp-official-web-host/current}"
environment_file="${CODEXAPP_ENVIRONMENT_FILE:-/srv/aialra/config/secrets/codexapp-official-web-host.env}"
runtime_root="${CODEXAPP_RUNTIME_ROOT:-/srv/aialra/state/codexapp-official}"
production_service="${CODEXAPP_SERVICE_NAME:-codexapp-official-web-host.service}"
production_port="${CODEXAPP_PRODUCTION_PORT:-13014}"
service_user="${CODEXAPP_SERVICE_USER:-codexappweb}"
service_group="${CODEXAPP_SERVICE_GROUP:-codexappweb}"
supplementary_groups="${CODEXAPP_SUPPLEMENTARY_GROUPS:-}"
temporary_service="codexapp-production-ui-smoke-$$.service"
nginx_source="${SMOKE_NGINX_SOURCE:-$application_root/ops/nginx/codexapp-production-loopback-smoke.conf}"
ui_smoke_script="${SMOKE_UI_SCRIPT:-$application_root/scripts/smoke-official-ui.mjs}"
nginx_target="/etc/nginx/conf.d/codexapp-production-loopback-smoke.conf"
auth_database="/srv/aialra/state/auth-gateway/sessions.sqlite"
identity_file="/run/codexapp-production-ui-smoke-$$.identity"
screenshot_path="${SMOKE_SCREENSHOT_PATH:-/tmp/codexapp-production-ui-smoke-$$.png}"
app_port="${CODEXAPP_SMOKE_APP_PORT:-13017}"
proxy_port="${CODEXAPP_SMOKE_PROXY_PORT:-13018}"
production_stopped=0
proxy_enabled=0
supplementary_group_arguments=()
if [[ -n "$supplementary_groups" ]]; then
  supplementary_group_arguments=(--property "SupplementaryGroups=$supplementary_groups")
fi

source "$application_root/ops/lib/systemd-host-hardening.sh"
source "$application_root/ops/lib/pinned-official-release.sh"
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

proxy_secret_header="$(read_environment_value AUTH_PROXY_SECRET_HEADER)"
proxy_secret_file="$(read_environment_value AUTH_PROXY_SECRET_FILE)"
if [[ -z "$proxy_secret_header" || ! "$proxy_secret_header" =~ ^[A-Za-z0-9-]+$ ]] ||
  [[ -z "$proxy_secret_file" || ! -f "$proxy_secret_file" || -L "$proxy_secret_file" ]]; then
  echo "production UI smoke proxy proof configuration is invalid" >&2
  exit 65
fi
proxy_secret="$(tr -d '\r\n' <"$proxy_secret_file")"
if [[ ! "$proxy_secret" =~ ^[0-9A-Fa-f]{64,}$ ]]; then
  echo "production UI smoke proxy proof is invalid" >&2
  exit 65
fi

pinned_official_environment=()
if [[ "${CODEXAPP_USE_ENVIRONMENT_OFFICIAL:-0}" == "1" ]]; then
  renderer_version="$(read_environment_value EXPECTED_RENDERER_VERSION)"
else
  codexapp_load_pinned_official_release "$application_root"
  pinned_official_environment=("${CODEXAPP_PINNED_OFFICIAL_ENV[@]}")
  renderer_version="$CODEXAPP_PINNED_RENDERER_VERSION"
fi

port_is_listening() {
  local port="$1"
  ss -H -ltn | awk -v suffix=":${port}" '$4 ~ suffix "$" { found = 1 } END { exit !found }'
}

wait_for_production_ready() {
  for attempt in $(seq 1 45); do
    if curl -fsS --max-time 2 "http://127.0.0.1:$production_port/readyz" >/dev/null; then
      production_stopped=0
      return 0
    fi
    sleep 1
  done
  return 1
}

recover_production() {
  if [[ "$production_stopped" -ne 1 ]]; then
    return 0
  fi
  systemctl start "$production_service" >/dev/null 2>&1 || true
  if wait_for_production_ready; then
    return 0
  fi
  systemctl restart "$production_service" >/dev/null 2>&1 || true
  wait_for_production_ready
}

cleanup() {
  local exit_code=$?
  local recovery_failed=0
  trap - EXIT
  systemctl stop "$temporary_service" >/dev/null 2>&1 || true
  systemctl reset-failed "$temporary_service" >/dev/null 2>&1 || true
  if [[ "$proxy_enabled" -eq 1 && -f "$nginx_target" && ! -L "$nginx_target" ]]; then
    rm -- "$nginx_target"
    nginx -t >/dev/null 2>&1 && systemctl reload nginx >/dev/null 2>&1 || true
  fi
  rm -f -- "$identity_file"
  if ! recover_production; then
    recovery_failed=1
    systemctl status "$production_service" --no-pager -l >&2 || true
  fi
  if (( exit_code != 0 )); then
    journalctl -u "$temporary_service" --no-pager -n 100 >&2 || true
  fi
  if (( recovery_failed != 0 && exit_code == 0 )); then
    exit_code=1
  fi
  exit "$exit_code"
}
trap cleanup EXIT

for required in "$application_root" "$environment_file" "$runtime_root" "$nginx_source" \
  "$ui_smoke_script" "$auth_database" \
  "$runtime_root/users/$user_key/codex-home/state_5.sqlite"; do
  if [[ ! -e "$required" ]]; then
    echo "required production UI smoke path is missing: $required" >&2
    exit 66
  fi
done
if [[ -e "$nginx_target" || -L "$nginx_target" ]]; then
  echo "temporary production UI smoke proxy already exists" >&2
  exit 1
fi
if port_is_listening "$app_port" || port_is_listening "$proxy_port"; then
  echo "production UI smoke ports are already in use" >&2
  exit 1
fi
if ! systemctl is-active --quiet "$production_service"; then
  echo "production service is not healthy before the smoke" >&2
  exit 69
fi
background_snapshot="$(curl -fsS --max-time 5 "http://127.0.0.1:$production_port/ops/background-work")"
if ! jq -e '.ok == true and .active == false' <<<"$background_snapshot" >/dev/null; then
  echo "production has active background work; UI smoke refused" >&2
  exit 75
fi

explicit_subject="${SMOKE_IDENTITY_SUBJECT:-}"
explicit_username="${SMOKE_IDENTITY_USERNAME:-}"
explicit_email="${SMOKE_IDENTITY_EMAIL:-}"
if [[ -n "$explicit_subject" || -n "$explicit_username" || -n "$explicit_email" ]]; then
  if [[ -z "$explicit_subject" || -z "$explicit_username" || -z "$explicit_email" ]] ||
    [[ "$(printf '%s' "$explicit_subject" | sha256sum | cut -d' ' -f1)" != "$user_key" ]]; then
    echo "explicit smoke identity is incomplete or does not match the requested user" >&2
    exit 65
  fi
  printf '%s\t%s\t%s\n' "$explicit_subject" "$explicit_username" "$explicit_email" >"$identity_file"
else
  while IFS=$'\t' read -r subject username email; do
    if [[ "$(printf '%s' "$subject" | sha256sum | cut -d' ' -f1)" == "$user_key" ]]; then
      printf '%s\t%s\t%s\n' "$subject" "$username" "$email" >"$identity_file"
      break
    fi
  done < <(
    sqlite3 -separator $'\t' "$auth_database" \
      'select subject,username,email from sessions order by last_seen_at desc;'
  )
fi
if [[ ! -s "$identity_file" ]]; then
  echo "no active authenticated session matches the requested user" >&2
  exit 65
fi
IFS=$'\t' read -r subject username email <"$identity_file"
if [[ ! "$subject" =~ ^[0-9A-Za-z._:@+-]+$ ]]; then
  echo "the authenticated subject cannot be encoded safely in the loopback proxy" >&2
  exit 65
fi

browser_executable="$(read_environment_value BROWSER_EXECUTABLE)"
if [[ -z "$browser_executable" || -z "$renderer_version" ]]; then
  echo "browser executable or renderer version is missing" >&2
  exit 1
fi

systemctl stop "$production_service"
production_stopped=1
if systemctl is-active --quiet "$production_service"; then
  echo "production service did not stop cleanly" >&2
  exit 70
fi

systemd-run \
  --quiet \
  --unit "$temporary_service" \
  --uid "$service_user" \
  --gid "$service_group" \
  --working-directory "$application_root" \
  --property "EnvironmentFile=$environment_file" \
  "${supplementary_group_arguments[@]}" \
  "${CODEXAPP_HOST_HARDENING_ARGS[@]}" \
  -- \
  /usr/bin/env \
  "${pinned_official_environment[@]}" \
  "${CODEXAPP_HOST_SERVICE_ENV[@]}" \
  "PORT=$app_port" \
  "PUBLIC_ORIGIN=http://127.0.0.1:$proxy_port" \
  "RUNTIME_ROOT=$runtime_root" \
  "BROWSER_BRIDGE_SCRIPT=$application_root/packages/browser-bridge/dist/index.js" \
  "ELECTRON_NET_WORKER=$application_root/scripts/electron-net-worker.cjs" \
  "ELECTRON_NET_USER_DATA_DIR=$runtime_root/electron-network" \
  "LOG_LEVEL=${SMOKE_LOG_LEVEL:-info}" \
  /usr/bin/node "$application_root/apps/host/dist/main.js"

for attempt in $(seq 1 45); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$app_port/readyz" >/dev/null; then
    break
  fi
  if [[ "$attempt" -eq 45 ]]; then
    echo "temporary production UI host did not become ready" >&2
    exit 1
  fi
  sleep 1
done

sed \
  -e "s/__CODEXAPP_SMOKE_SUBJECT__/$subject/g" \
  -e "/include \/srv\/aialra\/config\/nginx\/snippets\/codexapp-official-proxy-secret.conf;/c\\        proxy_set_header $proxy_secret_header \"$proxy_secret\";" \
  "$nginx_source" >"$nginx_target"
chown root:root "$nginx_target"
chmod 0600 "$nginx_target"
proxy_enabled=1
nginx -t
systemctl reload nginx

(
  cd "$application_root"
  for smoke_attempt in $(seq 1 "${SMOKE_REPEAT_COUNT:-1}"); do
    SMOKE_BASE_URL="http://127.0.0.1:$proxy_port" \
      BROWSER_EXECUTABLE="$browser_executable" \
      SMOKE_RENDERER_VERSION="$renderer_version" \
      SMOKE_SCREENSHOT_PATH="$screenshot_path" \
      SMOKE_INITIAL_PATH="${SMOKE_INITIAL_PATH:-/local/$thread_id}" \
      SMOKE_EXPECTED_TEXT="${SMOKE_EXPECTED_TEXT:-$expected_text}" \
      SMOKE_EXPECTED_CONVERSATION_TEXT="${SMOKE_EXPECTED_CONVERSATION_TEXT:-}" \
      SMOKE_CLICK_TEXT="${SMOKE_CLICK_TEXT:-}" \
      SMOKE_AFTER_CLICK_TEXT="${SMOKE_AFTER_CLICK_TEXT:-}" \
      SMOKE_EXPECTED_LOCALE="${SMOKE_EXPECTED_LOCALE:-}" \
      SMOKE_WAIT_FOR_TEXT_GONE="${SMOKE_WAIT_FOR_TEXT_GONE:-}" \
      SMOKE_POST_ASSERT_WAIT_MS="${SMOKE_POST_ASSERT_WAIT_MS:-0}" \
      SMOKE_SUBJECT="$subject" \
      SMOKE_USERNAME="$username" \
      SMOKE_EMAIL="$email" \
      SMOKE_ATTEMPT="$smoke_attempt" \
      SMOKE_INSPECT_SETTINGS_MENU="${SMOKE_INSPECT_SETTINGS_MENU:-}" \
      SMOKE_SWITCH_LOCALES_JSON="${SMOKE_SWITCH_LOCALES_JSON:-}" \
      SMOKE_SWITCH_LOCALE_LABEL="${SMOKE_SWITCH_LOCALE_LABEL:-}" \
      SMOKE_SWITCH_LOCALE_EXPECTED="${SMOKE_SWITCH_LOCALE_EXPECTED:-}" \
      SMOKE_VERIFY_LOCALE_AFTER_RELOAD="${SMOKE_VERIFY_LOCALE_AFTER_RELOAD:-0}" \
      SMOKE_REQUIRE_COMPRESSED_MAIN_ASSET="${SMOKE_REQUIRE_COMPRESSED_MAIN_ASSET:-0}" \
      timeout --signal=TERM --kill-after=10s "${SMOKE_BROWSER_TIMEOUT_SECONDS:-300}s" \
      node "$ui_smoke_script"
  done
)

systemctl stop "$temporary_service"
rm -- "$nginx_target"
proxy_enabled=0
nginx -t
systemctl reload nginx
if ! recover_production; then
  echo "production service did not recover after the UI smoke" >&2
  exit 1
fi

printf '{"ok":true,"exactProductionState":true,"threadId":"%s","expectedTextVisible":true,"screenshotPath":"%s"}\n' \
  "$thread_id" "$screenshot_path"
