# codexapp-linux-web

CodexApp Linux Web is a browser surface for Codex on a Linux host. It keeps the official Codex app-server responsible for execution, while the web layer owns fast thread lists, long-history windows, rendering, attachments, status polling, and submit reliability.

![CodexApp Linux Web overview](docs/assets/codexapp-overview.png)

## Highlights

- **Official execution path**: delegates resume, start, steer, interrupt, permissions, model settings, and tool execution to `codex app-server`.
- **Single web conversation surface**: `/local/<thread-id>` uses one CodexApp Web UI for sidebar, transcript, composer, attachments, and status.
- **Windowed long-history loading**: opens huge threads from a small latest window, loads older pages by cursor, and keeps the DOM capped.
- **Stable scroll anchors**: prepending history restores the first visible turn by id, so the viewport does not jump.
- **Reliable submit state machine**: text, image-only messages, plan, goal, and steer share one idempotent `/submit` endpoint.
- **Safe public defaults**: README, screenshots, and APIs avoid exposing local absolute paths, private domains, or tokens.

![Windowed long-thread history](docs/assets/long-thread-history.png)

## Architecture

```text
Browser
  |
  | HTTP / WebSocket
  v
CodexApp Web
  |-- thread index and status APIs
  |-- canonical history window adapter
  |-- bounded transcript renderer
  |-- idempotent submit and attachment APIs
  |-- optional device-auth/login wrapper
  |
  v
codex app-server --remote-control
  |
  v
Codex sessions, auth, tools, and workspaces
```

The web process can restart independently. Keep the app-server process alive to avoid interrupting running Codex tasks.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Liveness probe. |
| `GET /api/threads?limit=` | Lightweight thread index for the sidebar. |
| `GET /api/threads/:threadId/window?cursor=&direction=&limit=` | Canonical transcript window with `olderCursor` / `hasOlder`. |
| `GET /api/threads/:threadId/status` | Running, queued, permission, failure, and submission state. |
| `POST /api/threads/:threadId/submit` | Idempotent text, image, plan, goal, and steer submission. |
| `POST /api/attachments` | Upload browser attachments without exposing local filesystem paths. |
| `GET /api/attachments/:id` | Read-only attachment rendering. |
| `POST /auth/device/start` | Optional wrapper around official Codex device auth. |
| `GET /auth/device/status` | Sanitized device-auth status. |
| `POST /auth/logout` | Official Codex logout wrapper. |

Canonical history data is never truncated. Large text items return preview metadata and can be expanded on demand; image-only user messages are valid messages.

## Requirements

- Linux host
- Node.js 20+
- Codex CLI with `codex app-server`
- Persistent `CODEX_HOME`
- TLS reverse proxy for public deployments
- Secrets stored outside the repository, for example in an environment file

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

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `CODEXAPP_SINGLE_SURFACE` | `true` | Serve the CodexApp Web conversation surface at `/local/<thread-id>`. |
| `CODEXAPP_CANONICAL_WINDOW_LIMIT` | `8` | Turn window size per history fetch. |
| `CODEXAPP_CANONICAL_WINDOW_CACHE_LIMIT` | `32` | Maximum turn nodes kept near the viewport. |
| `CODEXAPP_EXTERNAL_APP_SERVER` | `false` | Use an already-running Codex app-server. |
| `CODEXAPP_WEB_PORT` | `13913` | HTTP port for the web bridge. |
| `CODEXAPP_STATE_DIR` | `./state` | Runtime state directory; do not commit it. |

## Production

Run the app-server and web bridge as separate services. Example systemd units live in `systemd/`.

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

The app-server supervisor adopts an existing listener instead of killing active work. Restart the web service for UI/API changes; leave the app-server running unless you intentionally want to stop active tasks.

## Verification

Current browser verification uses a real Chromium session against the web app:

- Long thread first readable window: under 1 second locally.
- Body height locked to viewport; transcript is the only scroll container.
- Upward history paging: 16 consecutive pages, anchor delta `0px`.
- Sliding window: DOM capped at 32 turns while history continues by cursor.
- Downward cache restore: newer window returns without duplicate turns.
- Console errors: `0`.
- Failed requests: `0` after a clean run.
- Text submit: double click produced one optimistic user message, composer cleared immediately.
- Image-only submit: accepted with one `user_image` item and no text item.
- Plan, goal, and steer: all accepted through the same `/submit` path.
- Guardrails: `npm run check` rejects old exposed fast routes, text-only user filtering, and visible truncation markers.

## Security

- Do not commit `CODEX_HOME`, auth files, logs, browser traces, `.env`, local sync scripts, or runtime state.
- OpenAI login is delegated to Codex CLI device auth; this project does not implement Google OAuth, scrape cookies, or return access tokens.
- Attachment responses expose stable attachment ids, not local file paths.
- Run a diff and secret scan before publishing:

```bash
git diff --cached --no-color | rg -n "sk-|ghp_|github_pat_|BEGIN .*PRIVATE|Authorization: Bearer|OPENAI_API_KEY|api[_-]?key" || true
```

## License

MIT
