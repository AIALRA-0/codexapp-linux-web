#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

if [[ "$(id -u)" -ne 0 ]]; then
  echo "production handoff creation must run as root" >&2
  exit 77
fi

user_key="${1:-}"
archive_thread_id="${2:-}"
handoff_path="${3:-}"
target_cwd="${4:-}"
thread_name="${5:-}"
application_root="${HANDOFF_APPLICATION_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
environment_file="${HANDOFF_ENVIRONMENT_FILE:-/srv/aialra/config/secrets/newcodexapp-controller.env}"
auth_database="${HANDOFF_AUTH_DATABASE:-/srv/aialra/state/auth-gateway/sessions.sqlite}"
base_url="${HANDOFF_BASE_URL:-http://127.0.0.1:13024}"
public_origin="${HANDOFF_PUBLIC_ORIGIN:-https://newcodexapp.aialra.online}"

if [[ ! "$user_key" =~ ^[0-9a-f]{64}$ ]] ||
  [[ ! "$archive_thread_id" =~ ^[0-9a-f-]{36}$ ]] ||
  [[ "$handoff_path" != /* ]] || [[ ! -f "$handoff_path" || -L "$handoff_path" ]] ||
  [[ "$target_cwd" != /* ]] || [[ ! -d "$target_cwd" || -L "$target_cwd" ]] ||
  [[ -z "$thread_name" ]]; then
  echo "invalid production handoff arguments" >&2
  exit 64
fi
for required in "$environment_file" "$auth_database" \
  "$application_root/scripts/create-handoff-thread.mjs"; do
  if [[ ! -f "$required" || -L "$required" ]]; then
    echo "required production handoff input is missing or symbolic: $required" >&2
    exit 66
  fi
done

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

proxy_secret_file="$(read_environment_value AUTH_PROXY_SECRET_FILE)"
proxy_secret_header="$(read_environment_value AUTH_PROXY_SECRET_HEADER)"
if [[ -z "$proxy_secret_header" || ! "$proxy_secret_header" =~ ^[A-Za-z0-9-]+$ ]] ||
  [[ -z "$proxy_secret_file" || ! -f "$proxy_secret_file" || -L "$proxy_secret_file" ]]; then
  echo "A proxy proof configuration is invalid" >&2
  exit 65
fi
proxy_secret="$(tr -d '\r\n' <"$proxy_secret_file")"
if [[ ! "$proxy_secret" =~ ^[0-9A-Fa-f]{64,}$ ]]; then
  echo "A proxy proof is invalid" >&2
  exit 65
fi

subject=""
username=""
email=""
while IFS=$'\t' read -r candidate_subject candidate_username candidate_email; do
  if [[ "$(printf '%s' "$candidate_subject" | sha256sum | cut -d' ' -f1)" == "$user_key" ]]; then
    subject="$candidate_subject"
    username="$candidate_username"
    email="$candidate_email"
    break
  fi
done < <(sqlite3 -separator $'\t' "$auth_database" \
  'select subject,username,email from sessions order by last_seen_at desc;')
if [[ -z "$subject" || -z "$username" || -z "$email" ]]; then
  echo "no authenticated A session matches the requested user" >&2
  exit 65
fi

background_snapshot="$(curl -fsS --max-time 5 "$base_url/ops/background-work")"
if ! jq -e '.ok == true and .active == false' <<<"$background_snapshot" >/dev/null; then
  echo "A has active work; handoff creation refused" >&2
  exit 75
fi

HANDOFF_BASE_URL="$base_url" \
HANDOFF_PUBLIC_ORIGIN="$public_origin" \
HANDOFF_PROXY_SECRET="$proxy_secret" \
HANDOFF_PROXY_SECRET_HEADER="$proxy_secret_header" \
HANDOFF_SUBJECT="$subject" \
HANDOFF_USERNAME="$username" \
HANDOFF_EMAIL="$email" \
HANDOFF_CWD="$target_cwd" \
HANDOFF_PATH="$handoff_path" \
HANDOFF_THREAD_NAME="$thread_name" \
HANDOFF_ARCHIVE_THREAD_ID="$archive_thread_id" \
  node "$application_root/scripts/create-handoff-thread.mjs"
