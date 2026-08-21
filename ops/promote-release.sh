#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

release_id="${1:-}"
script_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_root/lib/release-switch.sh"

exec 9>/run/lock/codexapp-b-release.lock
if ! flock -n 9; then
  echo "another B release transaction is running" >&2
  exit 75
fi

if [[ ! "$release_id" =~ ^[0-9A-Za-z._+-]{3,100}$ ]]; then
  echo "release id is invalid" >&2
  exit 64
fi

target="$codexapp_release_root/$release_id"
codexapp_verify_release_pair "$target"
codexapp_wait_for_controller_safe
codexapp_assert_no_background_work
next_official_version="$CODEXAPP_PAIR_OFFICIAL_VERSION"
next_build_number="$CODEXAPP_PAIR_BUILD_NUMBER"
next_official_target="$CODEXAPP_PAIR_OFFICIAL_TARGET"
next_codex_cli_version="$CODEXAPP_PAIR_CODEX_CLI_VERSION"
next_codex_bin="$CODEXAPP_PAIR_CODEX_BIN"

current_link="$codexapp_application_root/current"
official_current_link="$codexapp_official_application_root/current"
previous_target=""
previous_official_target=""
[[ -L "$current_link" ]] && previous_target="$(readlink -f "$current_link")"
[[ -L "$official_current_link" ]] &&
  previous_official_target="$(readlink -f "$official_current_link")"
environment_backup="$(mktemp "$(dirname -- "$codexapp_environment_file")/.codexapp-env.backup.XXXXXXXX")"
cp -a -- "$codexapp_environment_file" "$environment_backup"
snapshot_root=""
switched=0

rollback() {
  local exit_code=$?
  trap - EXIT
  if (( switched == 1 )); then
    systemctl stop "$codexapp_service_name" >/dev/null 2>&1 || true
    if [[ -n "$previous_target" && -d "$previous_target" ]]; then
      codexapp_switch_link "$current_link" "$previous_target" "current-rollback"
    fi
    if [[ -n "$previous_official_target" && -d "$previous_official_target" ]]; then
      codexapp_switch_link \
        "$official_current_link" \
        "$previous_official_target" \
        "official-current-rollback"
    fi
    cp -a -- "$environment_backup" "$codexapp_environment_file"
    if [[ -n "$snapshot_root" ]]; then
      codexapp_restore_state_snapshot "$snapshot_root" || true
    fi
    systemctl start "$codexapp_service_name" || true
    codexapp_wait_for_health 90 || true
  elif [[ -n "$snapshot_root" ]]; then
    codexapp_discard_unfinalized_snapshot "$snapshot_root" "$release_id" || true
  fi
  rm -f -- "$environment_backup"
  exit "$exit_code"
}
trap rollback EXIT

codexapp_prepare_state_snapshot "$release_id"
snapshot_root="$CODEXAPP_PREPARED_SNAPSHOT_ROOT"
# The low-priority pre-copy can raise the 60-second I/O PSI average by itself.
# Wait for the shared host to settle again before entering the brief stopped-
# service final sync instead of either bypassing the gate or failing every
# release with a production-sized state tree.
codexapp_wait_for_controller_recovery
codexapp_assert_no_background_work
systemctl stop "$codexapp_service_name"
switched=1
codexapp_finalize_state_snapshot \
  "$snapshot_root" \
  "$previous_target" \
  "$previous_official_target" \
  "$release_id"
codexapp_switch_link "$official_current_link" "$next_official_target" "official-current"
codexapp_switch_link "$current_link" "$target" "current-${release_id}"
codexapp_set_expected_official_version \
  "$next_official_version" \
  "$next_build_number" \
  "$next_codex_cli_version" \
  "$next_codex_bin"
codexapp_set_operational_limits
systemctl start "$codexapp_service_name"
if ! codexapp_wait_for_health 90; then
  journalctl -u "$codexapp_service_name" --no-pager -n 120 >&2 || true
  echo "promoted release did not become ready" >&2
  exit 1
fi
codexapp_assert_controller_work_safe

trap - EXIT
rm -f -- "$environment_backup"
printf '{"ok":true,"active":"%s","official":"%s","previous":"%s","previousOfficial":"%s","snapshot":"%s"}\n' \
  "$target" \
  "$next_official_target" \
  "$previous_target" \
  "$previous_official_target" \
  "$snapshot_root"
