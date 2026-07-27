#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

codex_home="${OLD_CODEX_HOME:-/srv/aialra/state/root-home/.codex}"
old_app_state="${OLD_CODEXAPP_STATE:-/srv/aialra/apps/codexapp/state}"
backup_root="${CODEXAPP_BACKUP_ROOT:-/srv/aialra/backups/codexapp-official}"
recipient_cert="${CODEXAPP_BACKUP_RECIPIENT_CERT:-/srv/aialra/config/backup/unified-backup-recipient.crt}"
minimum_free_kib="${CODEXAPP_BACKUP_MINIMUM_FREE_KIB:-8388608}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
label="${1:-preliminary}"

case "$label" in
  preliminary | final) ;;
  *)
    echo "usage: $0 [preliminary|final]" >&2
    exit 64
    ;;
esac

for required in "$codex_home" "$old_app_state" "$recipient_cert"; do
  if [[ ! -e "$required" ]]; then
    echo "required backup source is missing: $required" >&2
    exit 1
  fi
done

mkdir -p "$backup_root/.work"
chmod 700 "$backup_root" "$backup_root/.work"
exec 9>"/run/lock/codexapp-old-conversations-backup.lock"
if ! flock -n 9; then
  echo "another old CodexApp conversation backup is already running" >&2
  exit 75
fi

available_kib="$(df -Pk "$backup_root" | awk 'NR == 2 {print $4}')"
if (( available_kib < minimum_free_kib )); then
  echo "less than 8 GiB is available before the conversation backup" >&2
  exit 1
fi

work_dir="$backup_root/.work/${stamp}-${label}.incomplete"
bundle_tmp="$backup_root/.codexapp-old-conversations-${stamp}-${label}.tar.cms.incomplete"
bundle="$backup_root/codexapp-old-conversations-${stamp}-${label}.tar.cms"
mkdir -p "$work_dir/sqlite" "$work_dir/state"

cleanup() {
  local exit_code=$?
  rm -f -- "$bundle_tmp"
  if (( exit_code != 0 )); then
    rm -rf -- "$work_dir"
  fi
  exit "$exit_code"
}
trap cleanup EXIT

conversation_paths=()
for relative_path in \
  sessions \
  archived_sessions \
  recovery-backups \
  recovered \
  attachments \
  generated_images \
  memories \
  rules \
  config.toml \
  auth.json \
  installation_id; do
  [[ -e "$codex_home/$relative_path" ]] && conversation_paths+=("$relative_path")
done

if (( ${#conversation_paths[@]} == 0 )); then
  echo "no old CodexApp conversation data was found" >&2
  exit 1
fi

for attempt in 1 2 3; do
  rm -f "$work_dir/conversations.tar.gz"
  if tar -C "$codex_home" -cf - "${conversation_paths[@]}" \
    | gzip -1 >"$work_dir/conversations.tar.gz"; then
    break
  fi
  if (( attempt == 3 )); then
    echo "conversation files kept changing during all backup attempts" >&2
    exit 1
  fi
done
gzip -t "$work_dir/conversations.tar.gz"

while IFS= read -r -d '' database; do
  relative_path="${database#"$codex_home"/}"
  label_path="${relative_path//\//__}"
  output="$work_dir/sqlite/${label_path}"
  sqlite3 "$database" ".backup '$output'"
  if [[ "$(sqlite3 "$output" 'PRAGMA integrity_check;')" != "ok" ]]; then
    echo "SQLite integrity check failed for $relative_path" >&2
    exit 1
  fi
done < <(
  find "$codex_home" -xdev -type f \( -name '*.sqlite' -o -name '*.db' \) -print0
)

find "$old_app_state" -maxdepth 1 -type f \
  \( -name '*.json' -o -name '*.json.bak*' \) \
  -exec cp --preserve=mode,timestamps --target-directory="$work_dir/state" -- {} +

{
  printf 'created_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'kind=%s\n' "$label"
  printf 'source_codex_home=%s\n' "$codex_home"
  printf 'session_files='
  find "$codex_home/sessions" -type f -name '*.jsonl' -printf . 2>/dev/null | wc -c
  printf 'conversation_bytes='
  du -sb "${conversation_paths[@]/#/$codex_home/}" | awk '{sum += $1} END {print sum}'
  printf 'excluded_old_application_workspace=%s\n' "/srv/aialra/apps/codexapp/state/browser-workspaces"
  printf 'excluded_opencodexapp=%s\n' "/srv/aialra/apps/codexapp/state/browser-workspaces/2026-06-10-opencodexapp"
} >"$work_dir/MANIFEST"

(
  cd "$work_dir"
  find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum >SHA256SUMS
  sha256sum -c SHA256SUMS
  tar -tzf conversations.tar.gz >/dev/null
  if tar -tzf conversations.tar.gz | grep -Fq '2026-06-10-opencodexapp'; then
    echo "forbidden OpenCodexApp path entered the backup" >&2
    exit 1
  fi
)

tar -C "$work_dir" -cf - . \
  | openssl cms -encrypt -binary -aes-256-cbc -outform DER \
      -recip "$recipient_cert" -out "$bundle_tmp"
test -s "$bundle_tmp"
mv "$bundle_tmp" "$bundle"
(
  cd "$backup_root"
  sha256sum "$(basename "$bundle")" >"$(basename "${bundle}.sha256")"
  sha256sum -c "$(basename "${bundle}.sha256")"
)

bundle_size="$(stat -c %s "$bundle")"
cp "$work_dir/MANIFEST" "${bundle}.manifest"
rm -rf -- "$work_dir"
trap - EXIT
printf '{"ok":true,"kind":"%s","bundle":"%s","bytes":%s}\n' \
  "$label" "$bundle" "$bundle_size"
