#!/usr/bin/env bash
set -Eeuo pipefail

release_id="${1:-}"
release_root="/srv/aialra/releases/codexapp-official-web-host"
application_root="/srv/aialra/apps/codexapp-official-web-host"
current_link="$application_root/current"
service_name="codexapp-official-web-host.service"
health_url="http://127.0.0.1:13014/readyz"

if [[ ! "$release_id" =~ ^[0-9A-Za-z._+-]{3,100}$ ]]; then
  echo "release id is invalid" >&2
  exit 64
fi
target="$release_root/$release_id"
if [[ ! -d "$target" || -L "$target" || ! -s "$target/RELEASE-SHA256SUMS" ]]; then
  echo "rollback release does not exist or is unverified" >&2
  exit 1
fi
(
  cd "$target"
  sha256sum -c --quiet RELEASE-SHA256SUMS
)

previous_target=""
if [[ -L "$current_link" ]]; then
  previous_target="$(readlink -f "$current_link")"
fi
next_link="$application_root/.current.rollback.next"
ln -s "$target" "$next_link"
mv -Tf "$next_link" "$current_link"

restore_previous() {
  local exit_code=$?
  if (( exit_code != 0 )) && [[ -n "$previous_target" && -d "$previous_target" ]]; then
    failed_link="$application_root/.current.failed-rollback"
    ln -s "$previous_target" "$failed_link"
    mv -Tf "$failed_link" "$current_link"
    systemctl restart "$service_name" || true
  fi
  exit "$exit_code"
}
trap restore_previous EXIT

systemctl restart "$service_name"
for _attempt in $(seq 1 30); do
  if curl -fs "$health_url" >/dev/null 2>&1; then
    trap - EXIT
    printf '{"ok":true,"active":"%s"}\n' "$target"
    exit 0
  fi
  sleep 1
done
echo "rollback release did not become ready" >&2
exit 1
