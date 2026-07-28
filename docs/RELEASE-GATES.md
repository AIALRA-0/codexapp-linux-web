# Release gates

| Gate           | Pass condition                                                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Provenance     | Official signature/notarization, version, ASAR integrity, and SHA-256 recorded                                                                                                                   |
| Zero UI drift  | Every official renderer source byte equals the signed qualification manifest; only the audited runtime bootstrap tag may differ in served HTML                                                   |
| Contract       | Every observed preload and host method is implemented or explicitly classified unavailable                                                                                                       |
| App-server     | Client and server versions match; generated schema diff is reviewed and clean                                                                                                                    |
| Core           | New/open/list/search/archive/resume threads and streamed turns pass                                                                                                                              |
| Task start     | Browser bridge performs workspace, directory, Git, MCP, developer-instruction, thread-start, turn-start, and thread-read chain                                                                   |
| Persistence    | `ops/run-host-persistence-smoke.sh` proves a committed turn survives browser disconnect and full host-service restart                                                                            |
| History        | 10k-thread synthetic list is paginated and bounded; no eager full-history load                                                                                                                   |
| Reconnect      | Sequence/ack/replay produces no duplicates or gaps                                                                                                                                               |
| Isolation      | Cross-user filesystem, process, token, socket, and thread access tests fail closed                                                                                                               |
| Auth           | Authentik identity and OpenAI account state remain separate and auditable                                                                                                                        |
| Login UX       | official device-code card shows the server-issued code; completion reaches the main window without a reload                                                                                      |
| MCP            | Official app-server discovers a required stdio server and directly calls its advertised tool with an exact result                                                                                |
| Tools          | Isolated browser-to-AppHost upload/download, terminal, Git status/worktree, GitHub CLI, attachments/images, permissions, and dynamic-tool gates pass; app-server approvals, MCP, and skills pass |
| Desktop parity | Every feature in the version-specific matrix has evidence                                                                                                                                        |
| Performance    | startup, list, open, send, stream, and resume budgets pass at p95                                                                                                                                |
| Security       | CSP, origin, CSRF, websocket ticket, rate, audit, and dependency checks pass                                                                                                                     |
| Recovery       | Isolated clean-shutdown archive/erase/restore recovers an exact committed turn; app-server crash, disk pressure, interrupted upgrade pass                                                        |
| Rollback       | previous version restores within the runbook target without state conversion loss                                                                                                                |
| Visible UI     | real Chrome renders nonblank official pixels and receives bridge-ready through the same proxy boundary used by production                                                                        |

Production promotion requires all mandatory gates. Unsupported native-only features
are release blockers unless OpenAI provides a supported browser/host route or the
product owner explicitly changes the parity requirement.
