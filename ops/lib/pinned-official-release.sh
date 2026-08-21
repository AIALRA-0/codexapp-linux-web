#!/usr/bin/env bash

codexapp_load_pinned_official_release() {
  local application_root="$1"
  local descriptor="$application_root/manifests/current-official.json"
  local version_descriptor
  local codex_cli_version
  local codex_bin
  local source_manifest

  if [[ ! -f "$descriptor" || -L "$descriptor" ]]; then
    echo "pinned official release descriptor is missing or symbolic" >&2
    return 1
  fi
  CODEXAPP_PINNED_RENDERER_VERSION="$(
    jq -er '.version | select(test("^[0-9]+([.][0-9]+)+$"))' "$descriptor"
  )"
  CODEXAPP_PINNED_BUILD_NUMBER="$(
    jq -er '.buildNumber | select(test("^[0-9]+$"))' "$descriptor"
  )"
  CODEXAPP_PINNED_OFFICIAL_ROOT="/srv/aialra/codexapp-official/releases/$CODEXAPP_PINNED_RENDERER_VERSION"
  version_descriptor="$application_root/manifests/official-${CODEXAPP_PINNED_RENDERER_VERSION}.json"
  source_manifest="$CODEXAPP_PINNED_OFFICIAL_ROOT/qualification/source-manifest.json"

  if [[ ! -d "$CODEXAPP_PINNED_OFFICIAL_ROOT/source" ]] ||
    [[ -L "$CODEXAPP_PINNED_OFFICIAL_ROOT/source" ]] ||
    [[ ! -f "$version_descriptor" ]] ||
    [[ -L "$version_descriptor" ]] ||
    [[ ! -f "$source_manifest" ]] ||
    [[ -L "$source_manifest" ]]; then
    echo "pinned qualified official release is unavailable" >&2
    return 1
  fi
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
    "$descriptor" >/dev/null

  codex_cli_version="$(
    jq -er '.codexCli | select(test("^[0-9]+([.][0-9A-Za-z+-]+)+$"))' "$version_descriptor"
  )"
  codex_bin="/srv/aialra/codexapp-official/runtime-tools-${codex_cli_version}/node_modules/.bin/codex"
  if [[ ! -x "$codex_bin" ]] ||
    [[ "$(realpath "$codex_bin")" != "/srv/aialra/codexapp-official/runtime-tools-${codex_cli_version}"/* ]] ||
    [[ "$($codex_bin --version 2>/dev/null)" != "codex-cli $codex_cli_version" ]]; then
    echo "pinned qualified Codex runtime is unavailable or changed" >&2
    return 1
  fi

  CODEXAPP_PINNED_OFFICIAL_ENV=(
    "OFFICIAL_SOURCE_ROOT=$CODEXAPP_PINNED_OFFICIAL_ROOT/source"
    "OFFICIAL_ROOT=$CODEXAPP_PINNED_OFFICIAL_ROOT/source/webview"
    "SOURCE_MANIFEST=$source_manifest"
    "EXPECTED_RENDERER_VERSION=$CODEXAPP_PINNED_RENDERER_VERSION"
    "EXPECTED_BUILD_NUMBER=$CODEXAPP_PINNED_BUILD_NUMBER"
    "CODEX_BIN=$codex_bin"
    "EXPECTED_CODEX_VERSION=codex-cli $codex_cli_version"
  )
}
