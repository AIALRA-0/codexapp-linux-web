#!/usr/bin/env bash
set -Eeuo pipefail

umask 022

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Electron network AppArmor policy installation must run as root" >&2
  exit 77
fi

application_root="${APPLICATION_ROOT:-/srv/aialra/apps/codexapp-official-web-host/current}"
source_profile="$application_root/ops/apparmor/codexapp-electron-network"
target_profile="/etc/apparmor.d/codexapp-electron-network"
electron_bin="/srv/aialra/codexapp-official/electron-runtime/43.2.0/node_modules/electron/dist/electron"
rollback_electron_bin="/srv/aialra/codexapp-official/electron-runtime/42.3.0/node_modules/electron/dist/electron"
service_user="${CODEXAPP_SERVICE_USER:-codexappweb}"

validate_electron_bin() {
  local candidate="$1"
  if [[ ! -x "$candidate" || -L "$candidate" ]]; then
    echo "pinned Electron network runtime is missing or symbolic: $candidate" >&2
    exit 1
  fi
  if [[ "$(stat -c '%U:%G' "$candidate")" != "root:root" ]]; then
    echo "pinned Electron network runtime is not root-owned: $candidate" >&2
    exit 1
  fi
  if find "$(dirname "$candidate")" -maxdepth 1 -perm /022 -print -quit | grep -q .; then
    echo "pinned Electron network runtime directory is writable by group or other: $candidate" >&2
    exit 1
  fi
}

if [[ ! -f "$source_profile" || -L "$source_profile" ]]; then
  echo "managed Electron network AppArmor profile is missing or symbolic" >&2
  exit 1
fi
validate_electron_bin "$electron_bin"
validate_electron_bin "$rollback_electron_bin"
if [[ -e "$target_profile" || -L "$target_profile" ]]; then
  if [[ ! -f "$target_profile" || -L "$target_profile" ]]; then
    echo "existing Electron network AppArmor profile is not a regular file" >&2
    exit 1
  fi
fi
if ! id "$service_user" >/dev/null 2>&1; then
  echo "CodexApp service user does not exist" >&2
  exit 1
fi

staged_profile="$(mktemp /etc/apparmor.d/.codexapp-electron-network.XXXXXXXX)"
backup_profile=""
cleanup() {
  local exit_code=$?
  trap - EXIT
  rm -f -- "$staged_profile"
  if [[ -n "$backup_profile" ]]; then
    rm -f -- "$backup_profile"
  fi
  exit "$exit_code"
}
trap cleanup EXIT

install -o root -g root -m 0644 "$source_profile" "$staged_profile"
apparmor_parser -Q -p "$staged_profile" >/dev/null

if [[ -f "$target_profile" ]] && cmp -s "$staged_profile" "$target_profile"; then
  apparmor_parser -T -r "$target_profile"
else
  if [[ -f "$target_profile" ]]; then
    backup_profile="$(mktemp /etc/apparmor.d/.codexapp-electron-network.backup.XXXXXXXX)"
    cp -a "$target_profile" "$backup_profile"
  fi
  mv -f -- "$staged_profile" "$target_profile"
  staged_profile=""
  if ! apparmor_parser -T -r "$target_profile"; then
    if [[ -n "$backup_profile" && -f "$backup_profile" ]]; then
      cp -a "$backup_profile" "$target_profile"
      apparmor_parser -T -r "$target_profile" || true
    else
      rm -f -- "$target_profile"
    fi
    echo "Electron network AppArmor profile could not be loaded" >&2
    exit 1
  fi
fi

grep -q '^codexapp_electron_network ' /sys/kernel/security/apparmor/profiles

printf '{"ok":true,"profile":"%s","globalUserNamespaceRestrictionPreserved":true}\n' \
  "$target_profile"
