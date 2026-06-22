# codexapp-linux-web

CodexApp Linux Web serves the Codex desktop webview from a Linux host and connects it to a persistent `codex app-server`. It keeps long-running agent sessions usable in a browser: fast project lists, lightweight long-thread windows, cursor-based history, managed permissions, official Codex device login, and resilient send handling.

![CodexApp Linux Web overview](docs/assets/codexapp-overview.png)

## Highlights

- **Native Codex surface**: serves the bundled Codex webview and fills the host APIs expected by the desktop app.
- **Persistent backend**: runs `codex app-server --remote-control` separately so web bridge restarts do not stop active tasks.
- **Large-thread rescue window**: opens very large rollout files through a lightweight browser page first, avoiding the full app bundle and full transcript hydrate.
- **Cursor history**: loads older turns in bounded pages and keeps the scroll position stable while the DOM window stays small.
- **Reliable sends**: coalesces duplicate clicks, clears the composer immediately, and queues large-thread sends until app-server resume is ready.
- **Official login path**: wraps `codex login --device-auth`; OpenAI and Google sign-in happen on OpenAI’s verification page.

![Long thread history mode](docs/assets/long-thread-history.png)

## Architecture

```text
browser
  |
  | HTTP / WebSocket
  v
web-server.js
  |-- Codex webview asset server
  |-- browser bridge and host API shim
  |-- large rollout cursor reader
  |-- permission and request normalizers
  |-- official device-auth wrapper
  |
  v
codex app-server --remote-control
  |
  v
CODEX_HOME sessions, config, auth, tools, workspaces
```

Runtime state is intentionally outside the repository.

| Path | Purpose |
| --- | --- |
| `web-server.js` | HTTP/WebSocket bridge, asset patcher, long-thread fast path, host API shim. |
| `login-proxy.js` | Optional outer username/password guard for restricted deployments. |
| `systemd/` | Example units for the persistent app-server and web bridge. |
| `docs/assets/` | Redacted README screenshots. |

## Requirements

- Linux host with Node.js 20+
- Global Codex CLI (`@openai/codex`), verified with `0.141.0`
- Persistent `CODEX_HOME`
- TLS reverse proxy for public deployments
- Secrets stored outside this repository, for example in an `EnvironmentFile`

## Quick Start

```bash
npm install
npm run check

export CODEX_HOME="$HOME/.codex"
export CODEXAPP_EXTERNAL_APP_SERVER=1
export CODEXAPP_WEB_PORT=13913
export CODEXAPP_WEBVIEW_DIR=/opt/codex-desktop/content/webview
export CODEXAPP_CODEX_PACKAGE_JSON=/usr/lib/node_modules/@openai/codex/package.json

codex app-server --remote-control --listen ws://127.0.0.1:12911
node web-server.js
```

Open `http://127.0.0.1:13913`.

## Production

The app-server and bridge are separate services. Restart the bridge for web changes; leave app-server running to preserve active tasks. The app-server unit uses `scripts/codexapp-app-server-supervisor.sh`: if an existing Codex app-server is already listening, it adopts that listener instead of killing active work, then starts a fresh app-server only after the listener exits.

```bash
sudo install -d -m 0755 \
  /opt/codexapp-linux-web \
  /var/lib/codexapp-linux-web \
  /var/log/codexapp-linux-web \
  /etc/codexapp-linux-web

sudo install -m 0644 systemd/codexapp-app-server.service /etc/systemd/system/
sudo install -m 0644 systemd/codexapp-web-green.service /etc/systemd/system/

sudo systemctl daemon-reload
sudo systemctl enable --now codexapp-app-server.service
sudo systemctl enable --now codexapp-web-green.service

curl -fsS http://127.0.0.1:13913/health
```

## Long Threads

Large persisted threads are detected from the rollout file size. The default `/local/<thread-id>` route serves a lightweight long-thread window instead of forcing the full Codex app bundle to hydrate a huge transcript. Add `?codexapp_official=1` to open the full official UI when needed.

The lightweight window:

- fetches only the latest bounded turn window;
- loads older history through cursor pages;
- skips overlapping rollout pages automatically;
- keeps at most a small DOM window visible;
- preserves scroll position when prepending history;
- keeps the composer available while app-server resume happens in the background.

The app-server resume path still uses Codex protocol shape with `excludeTurns: true` and `initialTurnsPage`.

## Public Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Liveness probe. |
| `POST /auth/device/start` | Starts official `codex login --device-auth` and returns OpenAI verification URL plus user code. |
| `GET /auth/device/status` | Returns device-auth state and sanitized `codex login status`. |
| `POST /auth/logout` | Runs official `codex logout`. |
| `GET /codexapp-thread-fast` | Internal lightweight latest-window endpoint for very large local threads. |
| `GET /codexapp-thread-turns` | Internal cursor history endpoint for very large local threads. |
| `GET /codexapp-thread-status` | Internal status endpoint for very large local threads. |

MCP/WebSocket requests continue to use Codex app-server methods such as `thread/read`, `thread/resume`, `thread/status`, `thread/turns/list`, `turn/start`, and `turn/steer`.

## Verification

Latest production-style browser checks, June 22, 2026:

- Codex CLI local version and npm latest both `0.141.0`.
- Long thread default route returns a 736-byte lightweight HTML shell with no `app-main` bundle.
- Read-only large thread open: visible shell at `563ms` in browser marks; later repeat remained under `3s`.
- Long thread history paging: two cursor HTTP pages loaded in `235ms` and `158ms`; DOM stayed bounded and scroll offset was compensated.
- Disposable large-thread send: input cleared immediately, one optimistic message rendered, server ACK arrived, no duplicate bubble.
- Device login wrapper returned OpenAI official `auth.openai.com` verification URL and a one-time code without exposing tokens.
- `npm run check` passes.
- `npm audit` reports `0` vulnerabilities.

## Security

- Do not commit `CODEX_HOME`, auth files, logs, browser traces, `.env`, or local sync scripts.
- OpenAI login is delegated to Codex CLI device auth; this project does not implement Google OAuth, scrape cookies, or return access tokens.
- The optional `login-proxy.js` cookie uses `HttpOnly`, `SameSite=Lax`, and `Secure` when served through HTTPS.
- Run a diff and secret scan before publishing:

```bash
git diff --cached --no-color | rg -n "sk-|ghp_|github_pat_|BEGIN .*PRIVATE|Authorization: Bearer|OPENAI_API_KEY|api[_-]?key" || true
```

## License

MIT
