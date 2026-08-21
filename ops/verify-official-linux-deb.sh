#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

deb_path="${1:-}"
expected_version="${2:-}"
expected_fingerprint="3BFA0E4AE8B8CC16A2D9BA684A3B4A566C4660E4"
repository_root="https://persistent.oaistatic.com/codex-app-prod/linux/deb"

if [[ ! -f "$deb_path" || -L "$deb_path" ]] ||
  [[ ! "$expected_version" =~ ^[0-9]+([.][0-9]+)+$ ]]; then
  echo "usage: verify-official-linux-deb.sh DEB_PATH EXPECTED_VERSION" >&2
  exit 64
fi

temporary_root="$(mktemp -d /tmp/codex-linux-deb-verify.XXXXXXXX)"
cleanup() {
  if [[ -d "$temporary_root" && ! -L "$temporary_root" ]]; then
    find "$temporary_root" -depth -delete
  fi
}
trap cleanup EXIT

dpkg-deb -e "$deb_path" "$temporary_root/control"
package_name="$(dpkg-deb -f "$deb_path" Package)"
package_version="$(dpkg-deb -f "$deb_path" Version)"
package_architecture="$(dpkg-deb -f "$deb_path" Architecture)"
if [[ "$package_name" != "chatgpt" || "$package_version" != "$expected_version" ]] ||
  [[ "$package_architecture" != "amd64" ]]; then
  echo "official Linux package metadata does not match the requested release" >&2
  exit 1
fi

key_base64="$(
  sed -n "s/^SIGNING_KEY_BASE64='\\(.*\\)'$/\\1/p" "$temporary_root/control/postinst"
)"
if [[ -z "$key_base64" ]]; then
  echo "official Linux package repository key is missing" >&2
  exit 1
fi
printf '%s' "$key_base64" | base64 -d >"$temporary_root/keyring.gpg"
fingerprint="$(
  gpg --batch --with-colons --show-keys "$temporary_root/keyring.gpg" \
    | awk -F: '$1 == "fpr" { print $10; exit }'
)"
if [[ "$fingerprint" != "$expected_fingerprint" ]]; then
  echo "official Linux repository key fingerprint changed" >&2
  exit 1
fi

curl -fsS "$repository_root/dists/stable/InRelease" -o "$temporary_root/InRelease"
gpgv --keyring "$temporary_root/keyring.gpg" "$temporary_root/InRelease" \
  >"$temporary_root/gpgv.out" 2>&1
curl -fsS \
  "$repository_root/dists/stable/main/binary-amd64/Packages.gz" \
  -o "$temporary_root/Packages.gz"
gzip -dc "$temporary_root/Packages.gz" >"$temporary_root/Packages"

package_record="$(
  awk -v expected_version="$expected_version" '
    BEGIN { RS="" }
    {
      package = ""
      version = ""
      for (line_index = 1; line_index <= NF; line_index += 1) {
        if ($line_index == "Package:") {
          package = $(line_index + 1)
        }
        if ($line_index == "Version:") {
          version = $(line_index + 1)
        }
      }
      if (package == "chatgpt" && version == expected_version) {
        print
        exit
      }
    }
  ' "$temporary_root/Packages"
)"
if [[ -z "$package_record" ]]; then
  echo "requested ChatGPT version is absent from the signed repository index" >&2
  exit 1
fi
indexed_sha256="$(printf '%s\n' "$package_record" | awk '/^SHA256:/ { print $2 }')"
indexed_size="$(printf '%s\n' "$package_record" | awk '/^Size:/ { print $2 }')"
indexed_filename="$(printf '%s\n' "$package_record" | awk '/^Filename:/ { print $2 }')"
actual_sha256="$(sha256sum "$deb_path" | cut -d' ' -f1)"
actual_size="$(stat -c %s "$deb_path")"
if [[ "$actual_sha256" != "$indexed_sha256" || "$actual_size" != "$indexed_size" ]]; then
  echo "official Linux package differs from its signed repository record" >&2
  exit 1
fi

jq -n \
  --arg package "$package_name" \
  --arg version "$package_version" \
  --arg architecture "$package_architecture" \
  --arg fingerprint "$fingerprint" \
  --arg sha256 "$actual_sha256" \
  --arg filename "$indexed_filename" \
  --argjson size "$actual_size" \
  '{
    ok: true,
    package: $package,
    version: $version,
    architecture: $architecture,
    repositoryFingerprint: $fingerprint,
    sha256: $sha256,
    bytes: $size,
    repositoryFilename: $filename
  }'
