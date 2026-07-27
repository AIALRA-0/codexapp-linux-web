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
cp -a "$source_root/." "$incomplete/"
(
  cd "$incomplete"
  qualified_official_source_root="${QUALIFIED_OFFICIAL_SOURCE_ROOT:?QUALIFIED_OFFICIAL_SOURCE_ROOT is required}"
  npm run ci
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

previous_target=""
if [[ -L "$current_link" ]]; then
  previous_target="$(readlink -f "$current_link")"
fi
next_link="$application_root/.current.${release_id}.next"
ln -s "$target" "$next_link"
mv -Tf "$next_link" "$current_link"

rollback() {
  local exit_code=$?
  if (( exit_code != 0 )); then
    if [[ -n "$previous_target" && -d "$previous_target" ]]; then
      rollback_link="$application_root/.current.rollback"
      ln -s "$previous_target" "$rollback_link"
      mv -Tf "$rollback_link" "$current_link"
      systemctl restart "$service_name" || true
    elif [[ -L "$current_link" && "$(readlink -f "$current_link")" == "$target" ]]; then
      rm -- "$current_link"
      systemctl stop "$service_name" || true
    fi
  fi
  exit "$exit_code"
}
trap rollback EXIT

systemctl restart "$service_name"
for _attempt in $(seq 1 30); do
  if curl -fs "$health_url" >/dev/null 2>&1; then
    trap - EXIT
    printf '{"ok":true,"active":"%s","previous":"%s"}\n' "$target" "$previous_target"
    exit 0
  fi
  sleep 1
done
echo "new release did not become ready" >&2
exit 1
