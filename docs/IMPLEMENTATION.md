# End-to-end implementation

## Runtime path

1. The existing AIALRA unified gateway authenticates the outer web session through
   Authentik and Nginx replaces all trusted identity headers.
2. The host requires the gateway's verified marker and maps the immutable Authentik
   subject to an isolated runtime. A private Nginx-to-host proof prevents another
   local service from forging those headers. Username changes do not move or
   orphan data.
3. The unchanged official renderer loads with a version-matched compatibility
   bootstrap.
4. The browser bridge reproduces the official preload contract and sends framed,
   sequenced messages to the Host Gateway.
5. The Host Gateway owns the user's official `codex app-server` process over stdio.
6. App-server owns thread persistence, pagination, turns, approvals, MCP, skills,
   models, configuration, authentication status, and account operations.
7. Host-only features (filesystem, PTY, Git, menus, file drag, system integration)
   are delegated through explicit capability handlers.
8. An optional credential-free loopback HTTP CONNECT proxy can carry only the
   official ChatGPT projects-sidebar request when OpenAI challenges datacenter
   egress. The official URL and protocol stay unchanged, and normal model turns
   keep the direct route.

## Delivery order

1. Pin and verify the official package.
2. Extract it into a private build workspace.
3. Generate byte and preload-contract manifests.
4. Qualify renderer boot without modifying official files.
5. Qualify the same-version app-server schema.
6. Implement browser transport, gateway, and per-user runtime.
7. Close every contract item in the parity matrix.
8. Run functional, performance, security, recovery, and upgrade suites.
9. Deploy staging, soak, promote, and retain rollback.
10. Archive old CodexApp state and remove only its verified owned paths.

No gate is waived by substituting a fake response or a custom UI.
