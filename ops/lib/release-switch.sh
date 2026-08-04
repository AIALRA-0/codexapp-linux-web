#!/usr/bin/env bash

codexapp_release_root="/srv/aialra/releases/codexapp-official-web-host"
codexapp_application_root="/srv/aialra/apps/codexapp-official-web-host"
codexapp_official_release_root="/srv/aialra/codexapp-official/releases"
codexapp_official_application_root="/srv/aialra/codexapp-official"
codexapp_environment_file="/srv/aialra/config/secrets/codexapp-official-web-host.env"
codexapp_service_name="codexapp-official-web-host.service"
codexapp_service_user="codexappweb"
codexapp_health_url="http://127.0.0.1:13014/readyz"

codexapp_verify_release_pair() {
  local target="$1"
  local release_id
  local descriptor
  local official_version
  local build_number
  local official_target
  local source_manifest

  release_id="$(basename -- "$target")"
  if [[ ! -d "$target" || -L "$target" || ! -s "$target/RELEASE-SHA256SUMS" ]]; then
    echo "application release is missing or unverified" >&2
    return 1
  fi
  if ! runuser -u "$codexapp_service_user" -- test -x "$target" ||
    ! runuser -u "$codexapp_service_user" -- test -r "$target/apps/host/dist/main.js"; then
    echo "application release is inaccessible to the service account" >&2
    return 1
  fi
  (
    cd "$target"
    sha256sum -c --quiet RELEASE-SHA256SUMS
  )

  descriptor="$target/manifests/current-official.json"
  if [[ -f "$descriptor" && ! -L "$descriptor" ]]; then
    official_version="$(jq -er '.version | select(test("^[0-9]+([.][0-9]+)+$"))' "$descriptor")"
    build_number="$(jq -er '.buildNumber | select(test("^[0-9]+$"))' "$descriptor")"
  else
    if [[ "$release_id" =~ -official-([0-9]+([.][0-9]+)+)$ ]]; then
      official_version="${BASH_REMATCH[1]}"
    else
      echo "legacy application release does not identify its official version" >&2
      return 1
    fi
    descriptor="$target/manifests/official-${official_version}.json"
    if [[ ! -f "$descriptor" || -L "$descriptor" ]]; then
      echo "legacy official descriptor is missing" >&2
      return 1
    fi
    build_number="$(jq -er '.buildNumber | select(test("^[0-9]+$"))' "$descriptor")"
  fi

  official_target="$codexapp_official_release_root/$official_version"
  source_manifest="$official_target/qualification/source-manifest.json"
  if [[ ! -d "$official_target" || -L "$official_target" ]]; then
    echo "qualified official release is missing" >&2
    return 1
  fi
  if [[ ! -d "$official_target/source" || -L "$official_target/source" ]]; then
    echo "qualified official source is missing or symbolic" >&2
    return 1
  fi
  if [[ ! -f "$source_manifest" || -L "$source_manifest" ]]; then
    echo "qualified official source manifest is missing or symbolic" >&2
    return 1
  fi

  jq -e \
    --arg version "$official_version" \
    --arg build "$build_number" \
    '.package.version == $version and .package.buildNumber == $build' \
    "$source_manifest" >/dev/null
  if [[ -f "$target/manifests/current-official.json" ]]; then
    jq -e \
      --slurpfile source "$source_manifest" \
      '
        .version == $source[0].package.version
        and .buildNumber == $source[0].package.buildNumber
        and .asarSha256 == $source[0].package.asarSha256
        and .rendererTreeSha256 == $source[0].renderer.treeSha256
        and .hostTreeSha256 == $source[0].host.treeSha256
        and .preloadSourceSha256 == $source[0].preload.sourceSha256
      ' \
      "$target/manifests/current-official.json" >/dev/null
  fi

  CODEXAPP_PAIR_OFFICIAL_VERSION="$official_version"
  CODEXAPP_PAIR_BUILD_NUMBER="$build_number"
  CODEXAPP_PAIR_OFFICIAL_TARGET="$official_target"
}

codexapp_switch_link() {
  local link="$1"
  local target="$2"
  local label="$3"
  local next_link

  if [[ ! -d "$target" || -L "$target" ]]; then
    echo "link target is missing or symbolic: $target" >&2
    return 1
  fi
  next_link="$(dirname -- "$link")/.${label}.$$.next"
  ln -s "$target" "$next_link"
  mv -Tf "$next_link" "$link"
}

codexapp_set_expected_official_version() {
  local version="$1"
  local build="$2"
  local temporary

  if [[ ! -f "$codexapp_environment_file" || -L "$codexapp_environment_file" ]]; then
    echo "production environment file is missing or symbolic" >&2
    return 1
  fi
  if [[ "$(grep -c '^EXPECTED_RENDERER_VERSION=' "$codexapp_environment_file")" -ne 1 ]] ||
    [[ "$(grep -c '^EXPECTED_BUILD_NUMBER=' "$codexapp_environment_file")" -ne 1 ]]; then
    echo "production expected-version settings are not unique" >&2
    return 1
  fi

  temporary="$(mktemp "$(dirname -- "$codexapp_environment_file")/.codexapp-env.XXXXXXXX")"
  awk \
    -v version="$version" \
    -v build="$build" \
    '
      /^EXPECTED_RENDERER_VERSION=/ {
        print "EXPECTED_RENDERER_VERSION=" version
        next
      }
      /^EXPECTED_BUILD_NUMBER=/ {
        print "EXPECTED_BUILD_NUMBER=" build
        next
      }
      { print }
    ' \
    "$codexapp_environment_file" >"$temporary"
  chown --reference="$codexapp_environment_file" "$temporary"
  chmod --reference="$codexapp_environment_file" "$temporary"
  mv -f -- "$temporary" "$codexapp_environment_file"
}

codexapp_wait_for_health() {
  local attempts="${1:-45}"
  local required_consecutive="${2:-5}"
  local attempt
  local consecutive=0
  local main_pid
  for attempt in $(seq 1 "$attempts"); do
    main_pid="$(systemctl show --property=MainPID --value "$codexapp_service_name" 2>/dev/null || true)"
    if systemctl is-active --quiet "$codexapp_service_name" &&
      [[ "$main_pid" =~ ^[1-9][0-9]*$ ]] &&
      kill -0 "$main_pid" 2>/dev/null &&
      curl -fs "$codexapp_health_url" >/dev/null 2>&1; then
      consecutive=$((consecutive + 1))
      if (( consecutive >= required_consecutive )); then
        return 0
      fi
    else
      consecutive=0
    fi
    sleep 1
  done
  return 1
}
