#!/usr/bin/env bash

codexapp_release_root="/srv/aialra/releases/codexapp-official-web-host"
codexapp_application_root="/srv/aialra/apps/codexapp-official-web-host"
codexapp_official_release_root="/srv/aialra/codexapp-official/releases"
codexapp_official_application_root="/srv/aialra/codexapp-official"
codexapp_environment_file="/srv/aialra/config/secrets/codexapp-official-web-host.env"
codexapp_service_name="codexapp-official-web-host.service"
codexapp_service_user="codexappweb"
codexapp_health_url="http://127.0.0.1:13014/readyz"
codexapp_background_work_url="http://127.0.0.1:13014/ops/background-work"
codexapp_controller_health_url="http://127.0.0.1:13024/readyz"
codexapp_controller_background_work_url="http://127.0.0.1:13024/ops/background-work"
codexapp_state_root="/srv/aialra/state/codexapp-official"
codexapp_backup_root="/srv/aialra/backups/codexapp-b-upgrades"

codexapp_pressure_avg60() {
  local resource="$1"
  awk '/^full / {
    for (field_index = 1; field_index <= NF; field_index += 1) {
      if ($field_index ~ /^avg60=/) {
        split($field_index, value, "=")
        print value[2]
        exit
      }
    }
  }' "/proc/pressure/$resource"
}

codexapp_assert_controller_safe() {
  local snapshot
  local memory_pressure
  local io_pressure
  curl -fsS --max-time 5 "$codexapp_controller_health_url" >/dev/null || {
    echo "stable A controller is not ready; B release refused" >&2
    return 75
  }
  snapshot="$(curl -fsS --max-time 5 "$codexapp_controller_background_work_url")" || {
    echo "cannot inspect stable A controller work; B release refused" >&2
    return 75
  }
  if ! jq -e \
    '.ok == true and .pendingServerRequestCount == 0 and .activeTurnCount <= 1' \
    <<<"$snapshot" >/dev/null; then
    jq -c '{activeTurnCount,pendingServerRequestCount,oldestStartedAtMs}' <<<"$snapshot" >&2
    echo "stable A controller is busy; B release refused" >&2
    return 75
  fi
  memory_pressure="$(codexapp_pressure_avg60 memory)"
  io_pressure="$(codexapp_pressure_avg60 io)"
  if ! awk -v value="$memory_pressure" 'BEGIN { exit !(value < 1) }' ||
    ! awk -v value="$io_pressure" 'BEGIN { exit !(value < 2) }'; then
    printf 'memory_full_avg60=%s io_full_avg60=%s\n' "$memory_pressure" "$io_pressure" >&2
    echo "shared host pressure is too high; B release refused" >&2
    return 75
  fi
}

codexapp_wait_for_controller_safe() {
  local samples="${1:-11}"
  local interval_seconds="${2:-30}"
  local previous_swap_in
  local previous_swap_out
  local current_swap_in
  local current_swap_out
  local swap_in_delta
  local swap_out_delta

  previous_swap_in="$(awk '$1 == "pswpin" { print $2 }' /proc/vmstat)"
  previous_swap_out="$(awk '$1 == "pswpout" { print $2 }' /proc/vmstat)"
  for sample in $(seq 1 "$samples"); do
    codexapp_assert_controller_safe
    current_swap_in="$(awk '$1 == "pswpin" { print $2 }' /proc/vmstat)"
    current_swap_out="$(awk '$1 == "pswpout" { print $2 }' /proc/vmstat)"
    if (( sample > 1 )); then
      swap_in_delta=$((current_swap_in - previous_swap_in))
      swap_out_delta=$((current_swap_out - previous_swap_out))
      if (( swap_in_delta > 256 || swap_out_delta > 256 )); then
        printf 'swap_in_pages=%s swap_out_pages=%s\n' "$swap_in_delta" "$swap_out_delta" >&2
        echo "shared host is actively swapping; B release refused" >&2
        return 75
      fi
    fi
    previous_swap_in="$current_swap_in"
    previous_swap_out="$current_swap_out"
    if (( sample < samples )); then
      sleep "$interval_seconds"
    fi
  done
}

codexapp_wait_for_controller_recovery() {
  local attempts="${1:-21}"
  local interval_seconds="${2:-30}"
  local attempt

  for attempt in $(seq 1 "$attempts"); do
    if codexapp_assert_controller_safe; then
      codexapp_wait_for_controller_safe 11 30
      return 0
    fi
    if (( attempt < attempts )); then
      sleep "$interval_seconds"
    fi
  done
  echo "shared host did not recover before the release deadline" >&2
  return 75
}

codexapp_discard_unfinalized_snapshot() {
  local snapshot_root="$1"
  local release_id="$2"

  if [[ -z "$snapshot_root" || -L "$snapshot_root" || ! -d "$snapshot_root" ]] ||
    [[ -f "$snapshot_root/SNAPSHOT.json" ]]; then
    return 0
  fi
  case "$snapshot_root" in
    "$codexapp_backup_root"/*-before-"$release_id") ;;
    *)
      echo "refusing to discard an unexpected snapshot path: $snapshot_root" >&2
      return 1
      ;;
  esac
  find "$snapshot_root" -xdev -depth -delete
}

codexapp_prepare_state_snapshot() {
  local release_id="$1"
  local stamp
  local snapshot_root
  local state_bytes
  local available_bytes
  local required_bytes

  if [[ ! -d "$codexapp_state_root" || -L "$codexapp_state_root" ]]; then
    echo "B production state root is missing or symbolic" >&2
    return 1
  fi
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  snapshot_root="$codexapp_backup_root/$stamp-before-$release_id"
  mkdir -p "$codexapp_backup_root"
  chmod 0700 "$codexapp_backup_root"
  if [[ -e "$snapshot_root" || -L "$snapshot_root" ]]; then
    echo "B production snapshot path already exists" >&2
    return 1
  fi
  state_bytes="$(du -sx --block-size=1 "$codexapp_state_root" | awk '{print $1}')"
  available_bytes="$(df -PB1 "$codexapp_backup_root" | awk 'NR == 2 {print $4}')"
  required_bytes=$((state_bytes + 30 * 1024 * 1024 * 1024))
  if (( available_bytes < required_bytes )); then
    printf 'state_bytes=%s available_bytes=%s required_bytes=%s\n' \
      "$state_bytes" "$available_bytes" "$required_bytes" >&2
    echo "not enough space for a verified B production snapshot" >&2
    return 1
  fi
  mkdir -p "$snapshot_root/state"
  chmod 0700 "$snapshot_root" "$snapshot_root/state"
  ionice -c3 nice -n 15 rsync -aHAXx --numeric-ids \
    "$codexapp_state_root/" "$snapshot_root/state/"
  CODEXAPP_PREPARED_SNAPSHOT_ROOT="$snapshot_root"
}

codexapp_finalize_state_snapshot() {
  local snapshot_root="$1"
  local previous_target="$2"
  local previous_official_target="$3"
  local release_id="$4"
  local manifest="$snapshot_root/SNAPSHOT.json"

  ionice -c3 nice -n 15 rsync -aHAXx --delete --numeric-ids \
    "$codexapp_state_root/" "$snapshot_root/state/"
  cp -a -- "$codexapp_environment_file" "$snapshot_root/environment"
  (
    cd "$snapshot_root/state"
    ionice -c3 nice -n 15 find . -type f -print0 \
      | sort -z \
      | ionice -c3 nice -n 15 xargs -0 -r sha256sum >"$snapshot_root/STATE-SHA256SUMS"
  )
  (
    cd "$snapshot_root/state"
    sha256sum -c --quiet "$snapshot_root/STATE-SHA256SUMS"
  )
  jq -n \
    --arg createdAt "$(date -u +%FT%TZ)" \
    --arg targetRelease "$release_id" \
    --arg previousApplication "$previous_target" \
    --arg previousOfficial "$previous_official_target" \
    --arg environmentSha256 "$(sha256sum "$snapshot_root/environment" | cut -d' ' -f1)" \
    --arg stateManifestSha256 "$(sha256sum "$snapshot_root/STATE-SHA256SUMS" | cut -d' ' -f1)" \
    '{
      formatVersion: 1,
      createdAt: $createdAt,
      targetRelease: $targetRelease,
      previousApplication: $previousApplication,
      previousOfficial: $previousOfficial,
      environmentSha256: $environmentSha256,
      stateManifestSha256: $stateManifestSha256,
      cleanShutdown: true,
      verified: true
    }' >"$manifest"
  chmod -R go-rwx "$snapshot_root"
  CODEXAPP_FINALIZED_SNAPSHOT_ROOT="$snapshot_root"
}

codexapp_restore_state_snapshot() {
  local snapshot_root="$1"
  local expected_manifest_sha
  local actual_manifest_sha

  if [[ ! -d "$snapshot_root/state" || -L "$snapshot_root/state" ]] ||
    [[ ! -f "$snapshot_root/SNAPSHOT.json" || -L "$snapshot_root/SNAPSHOT.json" ]] ||
    [[ ! -f "$snapshot_root/STATE-SHA256SUMS" || -L "$snapshot_root/STATE-SHA256SUMS" ]]; then
    echo "verified B production snapshot is incomplete" >&2
    return 1
  fi
  expected_manifest_sha="$(jq -er '.stateManifestSha256' "$snapshot_root/SNAPSHOT.json")"
  actual_manifest_sha="$(sha256sum "$snapshot_root/STATE-SHA256SUMS" | cut -d' ' -f1)"
  if [[ "$expected_manifest_sha" != "$actual_manifest_sha" ]]; then
    echo "B production snapshot manifest changed" >&2
    return 1
  fi
  (
    cd "$snapshot_root/state"
    sha256sum -c --quiet "$snapshot_root/STATE-SHA256SUMS"
  )
  ionice -c3 nice -n 15 rsync -aHAXx --delete --numeric-ids \
    "$snapshot_root/state/" "$codexapp_state_root/"
}

codexapp_assert_no_background_work() {
  local snapshot
  if ! systemctl is-active --quiet "$codexapp_service_name"; then
    return 0
  fi
  if ! snapshot="$(curl -fsS --max-time 5 "$codexapp_background_work_url")"; then
    if [[ "${CODEXAPP_CONFIRMED_LEGACY_IDLE:-0}" == "1" ]]; then
      echo "warning: legacy host has no background-work endpoint; operator confirmed it is idle" >&2
      return 0
    fi
    echo "cannot verify whether the active host has background work; promotion refused" >&2
    return 75
  fi
  if ! jq -e '.ok == true and .active == false' <<<"$snapshot" >/dev/null; then
    jq -c \
      '{active,activeRuntimeCount,activeTurnCount,pendingServerRequestCount,oldestStartedAtMs}' \
      <<<"$snapshot" >&2 || true
    echo "active Codex work exists; promotion refused so no task is interrupted" >&2
    return 75
  fi
}

codexapp_verify_release_pair() {
  local target="$1"
  local release_id
  local descriptor
  local official_version
  local build_number
  local codex_cli_version
  local codex_bin
  local codex_runtime_root
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

  codex_cli_version="$(
    jq -er '.codexCli | select(test("^[0-9]+([.][0-9A-Za-z+-]+)+$"))' \
      "$target/manifests/official-${official_version}.json"
  )"
  codex_bin="/srv/aialra/codexapp-official/runtime-tools-${codex_cli_version}/node_modules/.bin/codex"
  codex_runtime_root="/srv/aialra/codexapp-official/runtime-tools-${codex_cli_version}"
  if [[ ! -x "$codex_bin" ]] ||
    [[ "$(realpath "$codex_bin")" != "$codex_runtime_root"/* ]]; then
    echo "qualified Codex runtime is missing or escapes its immutable root: $codex_bin" >&2
    return 1
  fi
  if [[ "$(stat -c '%U:%G' "$codex_runtime_root")" != "root:root" ]] ||
    find "$codex_runtime_root" -maxdepth 1 -perm /022 -print -quit | grep -q .; then
    echo "qualified Codex runtime ownership or permissions are unsafe" >&2
    return 1
  fi
  if [[ "$($codex_bin --version 2>/dev/null)" != "codex-cli $codex_cli_version" ]]; then
    echo "qualified Codex runtime version changed" >&2
    return 1
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
  CODEXAPP_PAIR_CODEX_CLI_VERSION="$codex_cli_version"
  CODEXAPP_PAIR_CODEX_BIN="$codex_bin"
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
  local codex_cli_version="$3"
  local codex_bin="$4"
  local official_release_root="$codexapp_official_release_root/$version"
  local temporary

  if [[ ! -f "$codexapp_environment_file" || -L "$codexapp_environment_file" ]]; then
    echo "production environment file is missing or symbolic" >&2
    return 1
  fi
  if [[ "$(grep -c '^EXPECTED_RENDERER_VERSION=' "$codexapp_environment_file")" -ne 1 ]] ||
    [[ "$(grep -c '^EXPECTED_BUILD_NUMBER=' "$codexapp_environment_file")" -ne 1 ]] ||
    [[ "$(grep -c '^EXPECTED_CODEX_VERSION=' "$codexapp_environment_file")" -ne 1 ]] ||
    [[ "$(grep -c '^CODEX_BIN=' "$codexapp_environment_file")" -ne 1 ]] ||
    [[ "$(grep -c '^OFFICIAL_SOURCE_ROOT=' "$codexapp_environment_file")" -ne 1 ]] ||
    [[ "$(grep -c '^OFFICIAL_ROOT=' "$codexapp_environment_file")" -ne 1 ]] ||
    [[ "$(grep -c '^SOURCE_MANIFEST=' "$codexapp_environment_file")" -ne 1 ]]; then
    echo "production expected-version settings are not unique" >&2
    return 1
  fi

  temporary="$(mktemp "$(dirname -- "$codexapp_environment_file")/.codexapp-env.XXXXXXXX")"
  awk \
    -v version="$version" \
    -v build="$build" \
    -v codex_cli_version="$codex_cli_version" \
    -v codex_bin="$codex_bin" \
    -v official_release_root="$official_release_root" \
    '
      /^EXPECTED_RENDERER_VERSION=/ {
        print "EXPECTED_RENDERER_VERSION=" version
        next
      }
      /^EXPECTED_BUILD_NUMBER=/ {
        print "EXPECTED_BUILD_NUMBER=" build
        next
      }
      /^EXPECTED_CODEX_VERSION=/ {
        print "EXPECTED_CODEX_VERSION=codex-cli " codex_cli_version
        next
      }
      /^CODEX_BIN=/ {
        print "CODEX_BIN=" codex_bin
        next
      }
      /^OFFICIAL_SOURCE_ROOT=/ {
        print "OFFICIAL_SOURCE_ROOT=" official_release_root "/source"
        next
      }
      /^OFFICIAL_ROOT=/ {
        print "OFFICIAL_ROOT=" official_release_root "/source/webview"
        next
      }
      /^SOURCE_MANIFEST=/ {
        print "SOURCE_MANIFEST=" official_release_root "/qualification/source-manifest.json"
        next
      }
      { print }
    ' \
    "$codexapp_environment_file" >"$temporary"
  chown --reference="$codexapp_environment_file" "$temporary"
  chmod --reference="$codexapp_environment_file" "$temporary"
  mv -f -- "$temporary" "$codexapp_environment_file"
}

codexapp_set_operational_limits() {
  local temporary
  if [[ "$(grep -c '^MAX_SESSIONS=' "$codexapp_environment_file")" -ne 1 ]] ||
    [[ "$(grep -c '^MAX_SESSIONS_PER_USER=' "$codexapp_environment_file")" -ne 1 ]]; then
    echo "B production session settings are not unique" >&2
    return 1
  fi
  temporary="$(mktemp "$(dirname -- "$codexapp_environment_file")/.codexapp-limits.XXXXXXXX")"
  awk '
    /^MAX_SESSIONS=/ {
      print "MAX_SESSIONS=10"
      next
    }
    /^MAX_SESSIONS_PER_USER=/ {
      print "MAX_SESSIONS_PER_USER=4"
      next
    }
    { print }
  ' "$codexapp_environment_file" >"$temporary"
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
