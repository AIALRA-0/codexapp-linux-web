#!/usr/bin/env bash

codexapp_prepare_host_hardening() {
  local writable_runtime_root="${1:?writable runtime root is required}"
  local service_user="${2:-codexappweb}"
  local service_group="${3:-codexappweb}"

  if [[ "$writable_runtime_root" != /srv/aialra/state/* ]]; then
    echo "host hardening runtime root is outside /srv/aialra/state" >&2
    return 1
  fi

  CODEXAPP_HOST_SERVICE_HOME="$writable_runtime_root/service-home"
  install -d -o "$service_user" -g "$service_group" -m 0700 \
    "$CODEXAPP_HOST_SERVICE_HOME" \
    "$CODEXAPP_HOST_SERVICE_HOME/.cache" \
    "$CODEXAPP_HOST_SERVICE_HOME/.config" \
    "$CODEXAPP_HOST_SERVICE_HOME/.local" \
    "$CODEXAPP_HOST_SERVICE_HOME/.local/share" \
    "$CODEXAPP_HOST_SERVICE_HOME/.local/share/applications"
  CODEXAPP_HOST_SERVICE_ENV=(
    "HOME=$CODEXAPP_HOST_SERVICE_HOME"
    "XDG_CACHE_HOME=$CODEXAPP_HOST_SERVICE_HOME/.cache"
    "XDG_CONFIG_HOME=$CODEXAPP_HOST_SERVICE_HOME/.config"
    "DISPLAY=127.0.0.1:99"
  )

  CODEXAPP_HOST_HARDENING_ARGS=(
    --property=UMask=0077
    --property=TasksMax=2048
    --property=MemoryMax=6G
    --property=NoNewPrivileges=true
    --property=PrivateTmp=true
    --property=PrivateDevices=true
    --property=ProtectSystem=strict
    --property=ProtectHome=true
    --property=ProtectKernelTunables=true
    --property=ProtectKernelModules=true
    --property=ProtectKernelLogs=true
    --property=ProtectControlGroups=true
    --property=ProtectClock=true
    --property=RestrictSUIDSGID=true
    --property=RestrictRealtime=true
    --property=LockPersonality=true
    --property=CapabilityBoundingSet=
    --property=AmbientCapabilities=
    "--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK"
    --property=SystemCallArchitectures=native
    "--property=SystemCallFilter=@system-service @sandbox @pkey @mount"
    "--property=ReadWritePaths=$writable_runtime_root"
  )
}
