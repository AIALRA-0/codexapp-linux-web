#!/usr/bin/env bash
set -Eeuo pipefail

umask 022

release_id="${1:-}"
source_root="${2:-}"
activate="${3:-}"
release_root="/srv/aialra/releases/codexapp-official-web-host"
application_root="/srv/aialra/apps/codexapp-official-web-host"
current_link="$application_root/current"
service_name="codexapp-official-web-host.service"
health_url="http://127.0.0.1:13014/readyz"

if [[ ! "$release_id" =~ ^[0-9A-Za-z._+-]{3,100}$ ]]; then
  echo "release id is invalid" >&2
  exit 64
fi
if [[ ! -d "$source_root" || -L "$source_root" ]]; then
  echo "source release directory is missing or symbolic" >&2
  exit 64
fi
if [[ "$activate" != "--stage" && "$activate" != "--activate" ]]; then
  echo "usage: $0 RELEASE_ID SOURCE_DIRECTORY <--stage|--activate>" >&2
  exit 64
fi

mkdir -p "$release_root" "$application_root"
target="$release_root/$release_id"
incomplete="$release_root/.${release_id}.incomplete"
if [[ -e "$target" || -L "$target" || -e "$incomplete" || -L "$incomplete" ]]; then
  echo "release id already exists" >&2
  exit 1
fi

cleanup() {
  local exit_code=$?
  if (( exit_code != 0 )) && [[ -d "$incomplete" && ! -L "$incomplete" ]]; then
    rm -rf --one-file-system -- "$incomplete"
  fi
  exit "$exit_code"
}
trap cleanup EXIT

mkdir "$incomplete"
if ! command -v rsync >/dev/null 2>&1; then
  echo "rsync is required to prepare a release" >&2
  exit 1
fi
rsync -a \
  --exclude='/.git/' \
  --exclude='/.git' \
  --exclude='/.official/' \
  --exclude='/artifacts/' \
  --exclude='/coverage/' \
  --exclude='/reports/generated/' \
  --exclude='/runtime/' \
  --exclude='/secrets/' \
  --exclude='/state/' \
  "$source_root/" "$incomplete/"
# rsync preserves the source directory mode on the destination root. Sources
# prepared with mktemp are intentionally private, so normalize only the release
# root before making the completed tree immutable.
chmod 0755 "$incomplete"
for forbidden_path in .git .official artifacts coverage runtime secrets state; do
  if [[ -e "$incomplete/$forbidden_path" || -L "$incomplete/$forbidden_path" ]]; then
    echo "forbidden build input entered the release: $forbidden_path" >&2
    exit 1
  fi
done
(
  cd "$incomplete"
  qualified_official_source_root="${QUALIFIED_OFFICIAL_SOURCE_ROOT:?QUALIFIED_OFFICIAL_SOURCE_ROOT is required}"
  qualified_source_manifest="$(
    realpath "$qualified_official_source_root/../qualification/source-manifest.json"
  )"
  if [[ ! -f "$qualified_source_manifest" || -L "$qualified_source_manifest" ]]; then
    echo "qualified official source manifest is missing or symbolic" >&2
    exit 1
  fi
  jq -e \
    --slurpfile source "$qualified_source_manifest" \
    '
      .version == $source[0].package.version
      and .buildNumber == $source[0].package.buildNumber
      and .asarSha256 == $source[0].package.asarSha256
      and .rendererTreeSha256 == $source[0].renderer.treeSha256
      and .hostTreeSha256 == $source[0].host.treeSha256
      and .preloadSourceSha256 == $source[0].preload.sourceSha256
    ' \
    manifests/current-official.json >/dev/null
  npm run ci
  OFFICIAL_TEST_SOURCE_ROOT="$qualified_official_source_root" npm test
  OFFICIAL_SOURCE_ROOT="$qualified_official_source_root" npm run contracts:check
  npm audit --audit-level=high
  npm audit --omit=dev --audit-level=high
  find . -type f ! -name RELEASE-SHA256SUMS -print0 \
    | sort -z \
    | xargs -0 sha256sum >RELEASE-SHA256SUMS
  sha256sum -c --quiet RELEASE-SHA256SUMS
)
chown -R root:root "$incomplete"
chmod -R a-w "$incomplete"
mv "$incomplete" "$target"

if [[ "$activate" == "--stage" ]]; then
  trap - EXIT
  printf '{"ok":true,"staged":"%s"}\n' "$target"
  exit 0
fi

trap - EXIT
APPLICATION_ROOT="$target" "$target/ops/install-host-service.sh"
exec "$target/ops/promote-release.sh" "$release_id"
