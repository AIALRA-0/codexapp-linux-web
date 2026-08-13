#!/usr/bin/env bash
set -Eeuo pipefail

umask 022

if [[ "$(id -u)" -ne 0 ]]; then
  echo "official Linux pair installer must run as root" >&2
  exit 77
fi

deb_path="${1:-}"
application_root="${APPLICATION_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
descriptor="$application_root/manifests/current-official.json"
if [[ ! -f "$deb_path" || -L "$deb_path" ]] ||
  [[ ! -f "$descriptor" || -L "$descriptor" ]]; then
  echo "usage: APPLICATION_ROOT=RELEASE install-qualified-linux-pair.sh OFFICIAL_DEB" >&2
  exit 64
fi

version="$(jq -er '.version | select(test("^[0-9]+([.][0-9]+)+$"))' "$descriptor")"
build_number="$(jq -er '.buildNumber | select(test("^[0-9]+$"))' "$descriptor")"
official_descriptor="$application_root/manifests/official-$version.json"
if [[ ! -f "$official_descriptor" || -L "$official_descriptor" ]]; then
  echo "official Linux release descriptor is missing or symbolic" >&2
  exit 1
fi
codex_cli_version="$(jq -er '.codexCli' "$official_descriptor")"
expected_codex_sha="$(jq -er '.codexBinarySha256 | select(test("^[a-f0-9]{64}$"))' "$official_descriptor")"

official_release_root="/srv/aialra/codexapp-official/releases"
official_target="$official_release_root/$version"
official_incomplete="$official_release_root/.$version.incomplete"
runtime_target="/srv/aialra/codexapp-official/runtime-tools-$codex_cli_version"
runtime_incomplete="/srv/aialra/codexapp-official/.runtime-tools-$codex_cli_version.incomplete"
for target_path in \
  "$official_target" \
  "$official_incomplete" \
  "$runtime_target" \
  "$runtime_incomplete"; do
  if [[ -e "$target_path" || -L "$target_path" ]]; then
    echo "qualified official pair target already exists: $target_path" >&2
    exit 1
  fi
done

temporary_root="$(mktemp -d /tmp/codex-qualified-linux-pair.XXXXXXXX)"
cleanup() {
  local exit_code=$?
  trap - EXIT
  if [[ -d "$temporary_root" && ! -L "$temporary_root" ]]; then
    find "$temporary_root" -depth -delete
  fi
  for incomplete_path in "$official_incomplete" "$runtime_incomplete"; do
    if [[ -d "$incomplete_path" && ! -L "$incomplete_path" ]]; then
      find "$incomplete_path" -depth -delete
    fi
  done
  exit "$exit_code"
}
trap cleanup EXIT

locked_deb="$temporary_root/chatgpt.deb"
cp --reflink=auto -- "$deb_path" "$locked_deb"
chown root:root "$locked_deb"
chmod 0400 "$locked_deb"
"$application_root/ops/verify-official-linux-deb.sh" "$locked_deb" "$version" \
  >"$temporary_root/verified-deb.json"
dpkg-deb -x "$locked_deb" "$temporary_root/extracted"
asar_path="$temporary_root/extracted/usr/lib/chatgpt/resources/app.asar"
codex_binary="$temporary_root/extracted/usr/lib/chatgpt/resources/codex"
if [[ ! -f "$asar_path" || -L "$asar_path" ]] ||
  [[ ! -x "$codex_binary" || -L "$codex_binary" ]]; then
  echo "official Linux package layout changed" >&2
  exit 1
fi
if [[ "$(sha256sum "$codex_binary" | cut -d' ' -f1)" != "$expected_codex_sha" ]] ||
  [[ "$($codex_binary --version 2>/dev/null)" != "codex-cli $codex_cli_version" ]]; then
  echo "official Linux Codex binary does not match its qualified descriptor" >&2
  exit 1
fi

ionice -c3 nice -n 15 npm --prefix "$application_root" run official:prepare -- \
  --asar "$asar_path" \
  --output "$temporary_root/prepared"
prepared_release="$temporary_root/prepared/$version"
source_manifest="$prepared_release/qualification/source-manifest.json"
if [[ ! -f "$source_manifest" || -L "$source_manifest" ]]; then
  echo "qualified official source manifest was not produced" >&2
  exit 1
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
if [[ "$(jq -r '.package.buildNumber' "$source_manifest")" != "$build_number" ]]; then
  echo "official Linux build number changed during qualification" >&2
  exit 1
fi

mkdir -p "$official_release_root" "$official_incomplete"
ionice -c3 nice -n 15 rsync -aHAXx --numeric-ids \
  "$prepared_release/" "$official_incomplete/"
chown -R root:root "$official_incomplete"
chmod -R a+rX,a-w "$official_incomplete"
chown -R root:codexappweb "$official_incomplete/qualification"
find "$official_incomplete/qualification" -type d -exec chmod 0750 {} +
find "$official_incomplete/qualification" -type f -exec chmod 0640 {} +

mkdir -p "$runtime_incomplete/bin" "$runtime_incomplete/node_modules/.bin"
install -o root -g root -m 0555 "$codex_binary" "$runtime_incomplete/bin/codex"
ln -s ../../bin/codex "$runtime_incomplete/node_modules/.bin/codex"
jq -n \
  --arg name "codexapp-qualified-runtime" \
  --arg version "$codex_cli_version" \
  '{name:$name,private:true,version:$version}' \
  >"$runtime_incomplete/package.json"
(
  cd "$runtime_incomplete"
  find . -type f -print0 | sort -z | xargs -0 sha256sum >RUNTIME-SHA256SUMS
  sha256sum -c --quiet RUNTIME-SHA256SUMS
)
chown -R root:root "$runtime_incomplete"
chmod -R a+rX,a-w "$runtime_incomplete"
if [[ "$($runtime_incomplete/node_modules/.bin/codex --version 2>/dev/null)" != "codex-cli $codex_cli_version" ]]; then
  echo "staged Codex runtime failed its version probe" >&2
  exit 1
fi

mv "$official_incomplete" "$official_target"
mv "$runtime_incomplete" "$runtime_target"
trap - EXIT
find "$temporary_root" -depth -delete
jq -n \
  --arg version "$version" \
  --arg official "$official_target" \
  --arg codexCli "$codex_cli_version" \
  --arg runtime "$runtime_target" \
  '{ok:true,stagedOnly:true,version:$version,official:$official,codexCli:$codexCli,runtime:$runtime}'
