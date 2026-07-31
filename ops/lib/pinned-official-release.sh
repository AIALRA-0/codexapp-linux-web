#!/usr/bin/env bash

codexapp_load_pinned_official_release() {
  local application_root="$1"
  local descriptor="$application_root/manifests/current-official.json"
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
  source_manifest="$CODEXAPP_PINNED_OFFICIAL_ROOT/qualification/source-manifest.json"

  if [[ ! -d "$CODEXAPP_PINNED_OFFICIAL_ROOT/source" ]] ||
    [[ -L "$CODEXAPP_PINNED_OFFICIAL_ROOT/source" ]] ||
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

  CODEXAPP_PINNED_OFFICIAL_ENV=(
    "OFFICIAL_SOURCE_ROOT=$CODEXAPP_PINNED_OFFICIAL_ROOT/source"
    "OFFICIAL_ROOT=$CODEXAPP_PINNED_OFFICIAL_ROOT/source/webview"
    "SOURCE_MANIFEST=$source_manifest"
    "EXPECTED_RENDERER_VERSION=$CODEXAPP_PINNED_RENDERER_VERSION"
    "EXPECTED_BUILD_NUMBER=$CODEXAPP_PINNED_BUILD_NUMBER"
  )
}
