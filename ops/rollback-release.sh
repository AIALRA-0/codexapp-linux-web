#!/usr/bin/env bash
set -Eeuo pipefail

release_id="${1:-}"
script_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_root/lib/release-switch.sh"

if [[ ! "$release_id" =~ ^[0-9A-Za-z._+-]{3,100}$ ]]; then
  echo "release id is invalid" >&2
  exit 64
fi

"$script_root/promote-release.sh" "$release_id"
