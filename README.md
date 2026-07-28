# CodexApp Official Web Host

This repository replaces the old custom CodexApp web client. It hosts the
**unchanged, version-locked official ChatGPT/Codex desktop renderer** behind a
browser compatibility layer and the matching official Codex app-server. It does
not reimplement the user interface.

## Non-negotiable invariants

- Official renderer JavaScript, CSS, images, fonts, and source HTML are immutable
  build inputs. A byte-for-byte manifest is checked before serving. The host may
  produce a deterministic runtime copy of the HTML containing only the audited
  bridge bootstrap tag; the signed source remains untouched.
- Official packages, extracted assets, user conversations, credentials, traces,
  and generated runtime state are never committed to Git.
- Every browser-to-host method is explicit and versioned. Unknown methods fail
  loudly and block promotion.
- Each authenticated user gets one isolated runtime and one `CODEX_HOME`.
- The existing OpenCodexApp is outside this project's ownership and deletion scope.
- Releases promote from qualification to staging to production; production always
  has a tested rollback version.

The official ChatGPT application, renderer, images, fonts, and Codex binaries are
not part of this repository and are not covered by this repository's MIT license.
Operators must supply and qualify their own authorized official package.

## Qualified version

- ChatGPT/Codex renderer: `26.721.31836`, build `5828`
- Electron/Chromium declared by the package: `42.3.0` / `150.0.7871.128`
- Codex app-server: `0.146.0-alpha.3.1`
- Preload surface: 19 methods, pinned in
  `manifests/preload-contracts/preload-26.721.31836.json`

The host fails closed if package identity, renderer bytes, host bytes, preload
contract, or app-server version differs from qualification.

## Architecture

1. Existing AIALRA unified authentication verifies the outer browser session.
2. Nginx forwards an immutable Authentik subject plus a private proxy proof.
3. Each subject receives an isolated runtime, workspace, `CODEX_HOME`, browser
   profile, terminal set, and app-server process.
4. The unchanged official renderer calls a versioned browser bridge that
   reproduces the qualified desktop preload contract.
5. Official app-server owns conversations, turns, approvals, MCP, skills,
   models, login, and configuration. Host-only desktop services are explicit,
   audited adapters.

Outer AIALRA login and the official OpenAI account login remain separate. The
OpenAI flow uses the official device authorization route and does not depend on
a browser callback to a developer laptop. The unmodified official renderer
receives the official `chatgptDeviceCode` result directly, displays its device
code, and opens the verification page only when the user selects its own
**Open browser** action.

## Validation

```sh
npm ci
npm run ci
npm run contracts:check
```

The repository also contains real-runtime smoke suites for the official main
window, in-app browser, authenticated user isolation, and app-server
conversation lifecycle:

```sh
npm run smoke:official-ui
npm run smoke:browser
npm run smoke:auth-isolation
npm run smoke:core-lifecycle
npm run smoke:desktop-tools
npm run smoke:approvals
```

They require the qualified private package and are executed in staging before
promotion. The main-window smoke requires a loopback reverse proxy because the
browser must never possess the private Nginx-to-host proof header; the same rule
applies to production WebSocket upgrades.

The approval smoke uses the real, version-locked app-server and complete browser
bridge in an isolated runtime. It proves that approval executes the proposed
command, rejection does not execute it, both responses return to the model, and
both turns complete without touching the production runtime.

## Operations

See:

- [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md)
- [`docs/RELEASE-GATES.md`](docs/RELEASE-GATES.md)
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)
- [`docs/OLD-CODEXAPP-BACKUP.md`](docs/OLD-CODEXAPP-BACKUP.md)

Production uses immutable releases and an atomic `current` link. A failed
promotion automatically restores the previous version. User state lives outside
release directories. The old CodexApp and OpenCodexApp are outside this
project's deletion boundary.
