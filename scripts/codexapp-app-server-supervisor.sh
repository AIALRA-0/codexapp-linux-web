#!/usr/bin/env bash
set -euo pipefail

codex_cli="${CODEXAPP_CODEX_CLI:-codex}"
listen="${CODEXAPP_APP_SERVER_LISTEN:-ws://127.0.0.1:12911}"
adopt_existing="${CODEXAPP_ADOPT_EXISTING_APP_SERVER:-1}"
poll_seconds="${CODEXAPP_ADOPT_POLL_SECONDS:-5}"
analytics_default="${CODEXAPP_APP_SERVER_ANALYTICS_DEFAULT_ENABLED:-1}"

read -r listen_host listen_port < <(node - "$listen" <<'NODE'
const raw = process.argv[2];
try {
  const url = new URL(raw);
  const port = url.port || (url.protocol === "wss:" ? "443" : "80");
  console.log(`${url.hostname || "127.0.0.1"} ${port}`);
} catch {
  console.error(`Invalid CODEXAPP_APP_SERVER_LISTEN: ${raw}`);
  process.exit(2);
}
NODE
)

port_is_open() {
  node - "$listen_host" "$listen_port" <<'NODE'
const net = require("node:net");
const host = process.argv[2];
const port = Number(process.argv[3]);
const socket = net.createConnection({ host, port });
const done = (code) => {
  socket.destroy();
  process.exit(code);
};
socket.setTimeout(500);
socket.once("connect", () => done(0));
socket.once("timeout", () => done(1));
socket.once("error", () => done(1));
NODE
}

start_app_server() {
  args=(app-server --remote-control --listen "$listen")
  if [[ "$analytics_default" != "0" && "$analytics_default" != "false" ]]; then
    args+=(--analytics-default-enabled)
  fi
  exec "$codex_cli" "${args[@]}"
}

if port_is_open; then
  if [[ "$adopt_existing" != "1" && "$adopt_existing" != "true" ]]; then
    echo "Codex app-server port is already in use at $listen; refusing to start." >&2
    exit 1
  fi
  echo "Codex app-server already listens at $listen; adopting existing process without interruption." >&2
  while port_is_open; do
    sleep "$poll_seconds"
  done
  echo "Adopted Codex app-server listener disappeared; starting a new app-server." >&2
fi

start_app_server
