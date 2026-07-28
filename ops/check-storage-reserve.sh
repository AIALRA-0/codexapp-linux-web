#!/usr/bin/env bash
set -Eeuo pipefail

state_root="${CODEXAPP_STATE_ROOT:-/srv/aialra/state/codexapp-official}"
reserve_file="${CODEXAPP_RESERVE_FILE:-$state_root/.emergency-storage-reserve}"
minimum_free_kib="${CODEXAPP_MINIMUM_FREE_KIB:-5242880}"
status_file="${CODEXAPP_STORAGE_STATUS_FILE:-$state_root/storage-status.json}"

mkdir -p "$state_root"
available_kib="$(df -Pk "$state_root" | awk 'NR == 2 {print $4}')"
released=false
if (( available_kib < minimum_free_kib )) && [[ -f "$reserve_file" && ! -L "$reserve_file" ]]; then
  rm -- "$reserve_file"
  released=true
  available_kib="$(df -Pk "$state_root" | awk 'NR == 2 {print $4}')"
fi

temporary_status="${status_file}.tmp"
printf '{"ok":%s,"available_kib":%s,"minimum_free_kib":%s,"reserve_released":%s,"checked_at":"%s"}\n' \
  "$([[ "$available_kib" -ge "$minimum_free_kib" ]] && echo true || echo false)" \
  "$available_kib" \
  "$minimum_free_kib" \
  "$released" \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  >"$temporary_status"
chmod 600 "$temporary_status"
mv "$temporary_status" "$status_file"

if (( available_kib < minimum_free_kib )); then
  echo "CodexApp storage remains below its safety threshold" >&2
  exit 1
fi
