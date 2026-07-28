#!/usr/bin/env bash
set -Eeuo pipefail

umask 022

if [[ "$(id -u)" -ne 0 ]]; then
  echo "bubblewrap AppArmor policy installation must run as root" >&2
  exit 77
fi

application_root="${APPLICATION_ROOT:-/srv/aialra/apps/codexapp-official-web-host/current}"
source_profile="$application_root/ops/apparmor/bwrap-userns-restrict"
target_profile="/etc/apparmor.d/bwrap-userns-restrict"
service_user="${CODEXAPP_SERVICE_USER:-codexappweb}"

if [[ ! -f "$source_profile" || -L "$source_profile" ]]; then
  echo "managed bubblewrap AppArmor profile is missing or symbolic" >&2
  exit 1
fi
if [[ -e "$target_profile" || -L "$target_profile" ]]; then
  if [[ ! -f "$target_profile" || -L "$target_profile" ]]; then
    echo "existing bubblewrap AppArmor profile is not a regular file" >&2
    exit 1
  fi
fi
if ! id "$service_user" >/dev/null 2>&1; then
  echo "CodexApp service user does not exist" >&2
  exit 1
fi

staged_profile="$(mktemp /etc/apparmor.d/.bwrap-userns-restrict.XXXXXXXX)"
backup_profile=""
cleanup() {
  local exit_code=$?
  trap - EXIT
  if [[ -n "$staged_profile" ]]; then
    rm -f -- "$staged_profile"
  fi
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
    backup_profile="$(mktemp /etc/apparmor.d/.bwrap-userns-restrict.backup.XXXXXXXX)"
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
    echo "bubblewrap AppArmor profile could not be loaded" >&2
    exit 1
  fi
fi

grep -q '^bwrap (enforce)' /sys/kernel/security/apparmor/profiles
grep -q '^unpriv_bwrap (enforce)' /sys/kernel/security/apparmor/profiles
runuser -u "$service_user" -- \
  bwrap \
  --unshare-user \
  --uid 0 \
  --gid 0 \
  --unshare-net \
  --proc /proc \
  --dev /dev \
  --ro-bind / / \
  -- ip -brief link show lo |
  grep -q '<LOOPBACK,UP,LOWER_UP>'

printf '{"ok":true,"profile":"%s","globalUserNamespaceRestrictionPreserved":true}\n' \
  "$target_profile"
