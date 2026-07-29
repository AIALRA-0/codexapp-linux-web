#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 OFFICIAL_CACHE_JSON TARGET_CODEX_HOME" >&2
  exit 64
fi

source_json=$1
target_codex_home=${2%/}
cache_name=$(basename -- "$source_json")

if [[ ! -f "$source_json" ]]; then
  echo "official Apps directory cache does not exist: $source_json" >&2
  exit 66
fi

if [[ ! "$cache_name" =~ ^[a-f0-9]{40}\.json$ ]]; then
  echo "cache filename must be the official 40-character cache key: $cache_name" >&2
  exit 65
fi
if [[ ! -d "$target_codex_home" || -L "$target_codex_home" ]]; then
  echo "target Codex home must be an existing physical directory: $target_codex_home" >&2
  exit 66
fi

connector_count=$(
  jq -er '
    select(.schema_version == 1)
    | select(.connectors | type == "array")
    | select(all(.connectors[]; (.id | type == "string") and (.name | type == "string")))
    | .connectors
    | length
    | select(. > 0)
  ' "$source_json"
)

target_directory="$target_codex_home/cache/codex_app_directory"
target_uid=$(stat -c '%u' -- "$target_codex_home")
target_gid=$(stat -c '%g' -- "$target_codex_home")
install -d -o "$target_uid" -g "$target_gid" -m 700 -- "$target_directory"
temporary_file=$(mktemp "$target_directory/.${cache_name}.XXXXXXXX")
trap 'rm -f -- "$temporary_file"' EXIT

install -o "$target_uid" -g "$target_gid" -m 600 -- "$source_json" "$temporary_file"
mv -f -- "$temporary_file" "$target_directory/$cache_name"
trap - EXIT

jq -cn \
  --arg cache "$target_directory/$cache_name" \
  --argjson connectorCount "$connector_count" \
  '{ok:true, cache:$cache, connectorCount:$connectorCount}'
