#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

if [[ "$(id -u)" -ne 0 ]]; then
  echo "controller installer must run as root" >&2
  exit 77
fi

application_release="${1:-}"
official_release="${2:-/srv/aialra/codexapp-official/releases/26.730.61639}"
source_root="${APPLICATION_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
application_root="/srv/aialra/apps/newcodexapp-controller"
state_root="/srv/aialra/state/newcodexapp-controller"
runtime_root="/srv/aialra/newcodexapp-controller/runtime-tools"
stable_environment="/srv/aialra/config/secrets/codexapp-official-web-host.env"
environment_file="/srv/aialra/config/secrets/newcodexapp-controller.env"
session_key="/srv/aialra/config/secrets/newcodexapp-controller-session.key"
proxy_key="/srv/aialra/config/secrets/newcodexapp-controller-proxy-secret"
proxy_snippet="/srv/aialra/config/nginx/snippets/newcodexapp-controller-proxy-secret.conf"
unit_target="/etc/systemd/system/newcodexapp-controller.service"
nginx_available="/srv/aialra/config/nginx/sites-available/newcodexapp.aialra.online.conf"
nginx_enabled="/srv/aialra/config/nginx/sites-enabled/newcodexapp.aialra.online.conf"

if [[ ! -d "$application_release" || -L "$application_release" ]]; then
  echo "a pinned controller application release is required" >&2
  exit 64
fi
if [[ ! -d "$official_release/source" || -L "$official_release/source" ]]; then
  echo "the pinned official release is missing" >&2
  exit 64
fi
stable_codex_bin="$(sed -n 's/^CODEX_BIN=//p' "$stable_environment")"
source_runtime="$(dirname "$(dirname "$(dirname "$stable_codex_bin")")")"
if [[ ! -x "$stable_codex_bin" || "$source_runtime" != /srv/aialra/codexapp-official/runtime-tools-* ]]; then
  echo "the stable Codex runtime is missing" >&2
  exit 64
fi

if ! getent group newcodexapp >/dev/null; then
  groupadd --system newcodexapp
fi
if ! getent passwd newcodexapp >/dev/null; then
  useradd --system --gid newcodexapp --home-dir "$state_root/service-home" --shell /usr/sbin/nologin newcodexapp
fi

install -d -o root -g root -m 0755 "$application_root" "/srv/aialra/newcodexapp-controller"
install -d -o newcodexapp -g newcodexapp -m 0700 \
  "$state_root" \
  "$state_root/service-home" \
  "$state_root/service-home/.cache" \
  "$state_root/service-home/.config" \
  "$state_root/electron-network" \
  "$state_root/shopping-browser" \
  "$state_root/shopping-browser/profile" \
  "$state_root/shopping-browser/mcp" \
  "$state_root/users"

if [[ ! -d "$runtime_root" ]]; then
  runtime_incomplete="${runtime_root}.incomplete"
  rm -rf --one-file-system -- "$runtime_incomplete"
  install -d -o root -g root -m 0755 "$runtime_incomplete"
  rsync -a "$source_runtime/" "$runtime_incomplete/"
  chown -R root:root "$runtime_incomplete"
  chmod -R a-w "$runtime_incomplete"
  mv "$runtime_incomplete" "$runtime_root"
fi

controller_target="$(realpath "$application_release")"
controller_link="$application_root/current"
if [[ -L "$controller_link" ]]; then
  if [[ "$(readlink -f "$controller_link")" != "$controller_target" ]]; then
    echo "the controller is already pinned to a different release" >&2
    exit 1
  fi
elif [[ -e "$controller_link" ]]; then
  echo "the controller current path is not a symbolic link" >&2
  exit 1
else
  ln -s "$controller_target" "$controller_link"
fi

if [[ ! -f "$environment_file" ]]; then
  install -o root -g root -m 0600 "$source_root/ops/newcodexapp-controller.env.example" "$environment_file"
fi
if [[ ! -f "$session_key" ]]; then
  openssl rand -hex 32 >"$session_key"
fi
if [[ ! -f "$proxy_key" ]]; then
  openssl rand -hex 32 >"$proxy_key"
fi
chown root:newcodexapp "$session_key" "$proxy_key"
chmod 0640 "$session_key" "$proxy_key"

proxy_value="$(tr -d '\r\n' <"$proxy_key")"
if [[ ! "$proxy_value" =~ ^[0-9a-f]{64}$ ]]; then
  echo "the controller proxy secret is invalid" >&2
  exit 1
fi
printf 'proxy_set_header X-Aialra-Controller-Proxy-Secret "%s";\n' "$proxy_value" >"$proxy_snippet"
chown root:root "$proxy_snippet"
chmod 0600 "$proxy_snippet"

install -o root -g root -m 0644 "$source_root/ops/systemd/newcodexapp-controller.service" "$unit_target"
install -o root -g root -m 0644 "$source_root/ops/nginx/newcodexapp.aialra.online.conf" "$nginx_available"
ln -sfn "$nginx_available" "$nginx_enabled"
systemctl daemon-reload
systemctl enable newcodexapp-controller.service >/dev/null

printf '{"ok":true,"controllerRelease":"%s","officialRelease":"%s","serviceStarted":false}\n' \
  "$controller_target" \
  "$(realpath "$official_release")"
