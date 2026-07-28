#!/usr/bin/env bash
set -Eeuo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

for forbidden in .official node_modules runtime state secrets artifacts; do
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    && git ls-files --error-unmatch "$forbidden" >/dev/null 2>&1; then
    echo "forbidden runtime/build path is tracked: $forbidden" >&2
    exit 1
  fi
done

unexpected_sensitive_files="$(
  find . \
    -path './.git' -prune -o \
    -path './node_modules' -prune -o \
    -path './.official' -prune -o \
    -type f \
    \( -name '.env' -o -name '*.pem' -o -name '*.key' -o -name 'auth.json' \) \
    -print
)"
if [[ -n "$unexpected_sensitive_files" ]]; then
  echo "source tree contains forbidden credential-shaped files:" >&2
  printf '%s\n' "$unexpected_sensitive_files" >&2
  exit 1
fi

secret_matches="$(
  rg -l --hidden \
    -g '!.git/**' \
    -g '!node_modules/**' \
    -g '!.official/**' \
    -g '!*.tsbuildinfo' \
    -e 'sk-[A-Za-z0-9_-]{20,}' \
    -e 'gh[pousr]_[A-Za-z0-9]{20,}' \
    -e 'AKIA[0-9A-Z]{16}' \
    -e '-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----' \
    . || true
)"
if [[ -n "$secret_matches" ]]; then
  echo "source tree contains credential-shaped content in:" >&2
  printf '%s\n' "$secret_matches" >&2
  exit 1
fi

oversized_sources="$(
  find . \
    -path './.git' -prune -o \
    -path './node_modules' -prune -o \
    -path './.official' -prune -o \
    -type f -size +5M -print
)"
if [[ -n "$oversized_sources" ]]; then
  echo "source tree contains unexpected files larger than 5 MiB:" >&2
  printf '%s\n' "$oversized_sources" >&2
  exit 1
fi

echo "source boundary and credential scan passed"
