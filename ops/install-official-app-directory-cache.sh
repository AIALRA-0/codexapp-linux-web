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
install -d -m 700 -- "$target_directory"
temporary_file=$(mktemp "$target_directory/.${cache_name}.XXXXXXXX")
trap 'rm -f -- "$temporary_file"' EXIT

install -m 600 -- "$source_json" "$temporary_file"
mv -f -- "$temporary_file" "$target_directory/$cache_name"
trap - EXIT

jq -cn \
  --arg cache "$target_directory/$cache_name" \
  --argjson connectorCount "$connector_count" \
  '{ok:true, cache:$cache, connectorCount:$connectorCount}'
