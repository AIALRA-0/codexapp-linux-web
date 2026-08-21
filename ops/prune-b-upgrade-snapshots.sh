#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

backup_root="${CODEXAPP_B_UPGRADE_BACKUP_ROOT:-/srv/aialra/backups/codexapp-b-upgrades}"
current_link="${CODEXAPP_B_CURRENT_LINK:-/srv/aialra/apps/codexapp-official-web-host/current}"
lock_file="${CODEXAPP_B_RELEASE_LOCK:-/run/lock/codexapp-b-release.lock}"

if [[ "$backup_root" != "/srv/aialra/backups/codexapp-b-upgrades" ]] &&
  [[ "${CODEXAPP_RETENTION_ALLOW_TEST_ROOT:-0}" != "1" ]]; then
  echo "a non-production backup root is allowed only during an explicit test" >&2
  exit 64
fi
if [[ ! -d "$backup_root" || -L "$backup_root" ]]; then
  echo "B upgrade backup root is missing or symbolic" >&2
  exit 1
fi
if [[ ! -L "$current_link" ]]; then
  echo "B current-release link is missing" >&2
  exit 1
fi

exec 9>"$lock_file"
if ! flock -n 9; then
  echo '{"ok":true,"skipped":"release-in-progress"}'
  exit 0
fi

backup_root_real="$(realpath -e "$backup_root")"
current_release="$(basename -- "$(readlink -f "$current_link")")"
snapshots=()
shopt -s nullglob
for candidate in "$backup_root"/*; do
  [[ -d "$candidate" && ! -L "$candidate" ]] || continue
  candidate_name="$(basename -- "$candidate")"
  [[ "$candidate_name" =~ ^[0-9]{8}T[0-9]{6}Z-before-[0-9A-Za-z._+-]{3,100}$ ]] || continue
  [[ -f "$candidate/SNAPSHOT.json" && ! -L "$candidate/SNAPSHOT.json" ]] || continue
  snapshots+=("$candidate")
done

if (( ${#snapshots[@]} <= 1 )); then
  printf '{"ok":true,"kept":%d,"deleted":0}\n' "${#snapshots[@]}"
  exit 0
fi

mapfile -t snapshots < <(printf '%s\n' "${snapshots[@]}" | LC_ALL=C sort)
keep="${snapshots[${#snapshots[@]} - 1]}"
manifest="$keep/SNAPSHOT.json"
checksums="$keep/STATE-SHA256SUMS"
environment="$keep/environment"

jq -e '
  .formatVersion == 1
  and .cleanShutdown == true
  and .verified == true
  and (.targetRelease | type == "string")
  and (.stateManifestSha256 | test("^[0-9a-f]{64}$"))
  and (.environmentSha256 | test("^[0-9a-f]{64}$"))
' "$manifest" >/dev/null
if [[ "$(jq -er '.targetRelease' "$manifest")" != "$current_release" ]]; then
  echo "newest verified snapshot does not belong to the active B release" >&2
  exit 1
fi
if [[ ! -f "$checksums" || -L "$checksums" ]] ||
  [[ "$(sha256sum "$checksums" | cut -d' ' -f1)" != "$(jq -er '.stateManifestSha256' "$manifest")" ]]; then
  echo "newest B snapshot checksum manifest is invalid" >&2
  exit 1
fi
if [[ ! -f "$environment" || -L "$environment" ]] ||
  [[ "$(sha256sum "$environment" | cut -d' ' -f1)" != "$(jq -er '.environmentSha256' "$manifest")" ]]; then
  echo "newest B snapshot environment copy is invalid" >&2
  exit 1
fi
previous_application="$(jq -er '.previousApplication' "$manifest")"
previous_official="$(jq -er '.previousOfficial' "$manifest")"
if [[ ! -d "$previous_application" || -L "$previous_application" ]] ||
  [[ ! -d "$previous_official" || -L "$previous_official" ]]; then
  echo "newest B snapshot no longer has a complete rollback release pair" >&2
  exit 1
fi

deleted=0
for candidate in "${snapshots[@]:0:${#snapshots[@]}-1}"; do
  candidate_real="$(realpath -e "$candidate")"
  case "$candidate_real" in
    "$backup_root_real"/*) ;;
    *)
      echo "refusing to delete a snapshot outside the B backup root" >&2
      exit 1
      ;;
  esac
  ionice -c3 nice -n 19 find "$candidate_real" -xdev -depth -delete
  deleted=$((deleted + 1))
done

printf '{"ok":true,"kept":"%s","deleted":%d}\n' "$(basename -- "$keep")" "$deleted"
