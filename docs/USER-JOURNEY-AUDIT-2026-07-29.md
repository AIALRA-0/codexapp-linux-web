# Production user-journey audit — 2026-07-29

## Scope

- Production URL: `https://codexapp.aialra.online`
- Official renderer: `26.721.31836`
- Test identity: the signed-in Authentik user exposed to the official renderer
- Safety boundary: use only synthetic tasks, chats, files, projects, automations, and
  browser sessions whose names start with `E2E-20260729`.
- Protected data: existing user conversations, legacy CodexApp backup, and all
  OpenCodexApp services and state.

## Result vocabulary

- `PASS`: the visible user action completed and its result was verified.
- `PASS (repeat)`: the action completed in at least two independent attempts.
- `PARTIAL`: the path works, but one or more official sub-features are unavailable.
- `FAIL`: the action did not produce the official expected result.
- `BLOCKED`: the action requires a capability or credential that is not available to
  the signed-in test user.
- `PENDING`: not yet executed.

## Coverage matrix

| Area          | User path                                                        |        Repetitions | Result        | Evidence / notes                                                                                                                                             |
| ------------- | ---------------------------------------------------------------- | -----------------: | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shell         | Load production through Authentik                                |                  2 | PASS (repeat) | Official shell, account, model, and recent items rendered.                                                                                                   |
| Shell         | Switch Codex → ChatGPT → Codex                                   |                  1 | PASS          | Both official composer variants rendered.                                                                                                                    |
| ChatGPT       | Start Chat mode conversation                                     |                  1 | PASS          | `E2E-CHATGPT-20260729-A` returned `CHATGPT_PATH_OK`.                                                                                                         |
| ChatGPT       | Work mode without a selected project                             |                  1 | PASS          | Composer correctly required a run location instead of sending.                                                                                               |
| ChatGPT       | Project list                                                     |                  1 | FAIL          | Sidebar displayed `无法加载项目`; investigate and retest.                                                                                                    |
| ChatGPT       | Model picker                                                     |                  1 | PASS          | All currently exposed official models rendered; a temporary selection was restored.                                                                          |
| ChatGPT       | Copy response                                                    |                  1 | PASS          | Copy control changed to `已复制`.                                                                                                                            |
| ChatGPT       | Positive and negative feedback                                   |             1 each | PASS          | Both feedback dialogs accepted a category and synthetic comment.                                                                                             |
| ChatGPT       | Edit message and regenerate                                      |                  1 | FAIL          | Backend completed in 4.027 s with `EDIT_PATH_OK`, but the renderer remained at `正在思考` for more than 27 s and required Stop.                              |
| ChatGPT       | Share and conversation actions                                   |                  0 | PENDING       |                                                                                                                                                              |
| Codex         | Create projectless task                                          |                  1 | FAIL          | Backend returned `CODEX_PATH_OK` and completed in 3.517 s, but the renderer remained at `正在思考`; root cause is the obsolete nested notification envelope. |
| Codex         | Create project-backed task                                       |                  1 | FAIL          | Official Create Project dialog renders, but the source-folder picker has no browser-host implementation and empty creation returns `创建项目失败`.           |
| Codex         | Prompt presets                                                   | 16 visible actions | PASS          | Four top-level preset groups and all four second-level actions in each rendered; third-level connector variants remain to be enumerated.                     |
| Codex         | Model, reasoning and speed selection                             |             1 each | PASS          | Models, reasoning levels and Standard/Fast speed changed successfully and were restored.                                                                     |
| Codex         | Access-mode selection                                            |                  1 | PASS          | Approval-request mode and Full access both selected correctly; final value restored to Full access.                                                          |
| Codex         | Approve and decline commands                                     |                  0 | PENDING       |                                                                                                                                                              |
| Codex         | Interrupt and resume turn                                        |                  0 | PENDING       |                                                                                                                                                              |
| Codex         | Pin, rename, archive, restore, delete task                       |                  0 | PENDING       |                                                                                                                                                              |
| Files         | Upload attachment                                                |                  1 | FAIL          | Attachment control produces no picker and the official page exposes no file input.                                                                           |
| Files         | Download generated file                                          |                  0 | PENDING       |                                                                                                                                                              |
| Files         | Image preview                                                    |                  0 | PENDING       |                                                                                                                                                              |
| Projects      | Add, select, open, remove project                                |                  1 | FAIL          | Create dialog, name, all marker colors and icons work; selecting a server folder does nothing, so no synthetic project can be created.                       |
| Projects      | Git status and diff                                              |                  0 | PENDING       |                                                                                                                                                              |
| Projects      | Managed worktree                                                 |                  0 | PENDING       |                                                                                                                                                              |
| Search        | Search tasks and chats                                           |                  1 | PASS          | Command menu opens and returns the expected synthetic task.                                                                                                  |
| Search        | Filter by mode/project                                           |                  0 | PENDING       |                                                                                                                                                              |
| Pull requests | Open list and empty/error states                                 |                  2 | BLOCKED       | Route renders a recoverable error because the server GitHub CLI is not authenticated; Retry returns the same state.                                          |
| Sites         | Open site workspace and empty/error states                       |                  1 | PASS          | Existing Sites workspace and search rendered; publication terms were not accepted or changed.                                                                |
| Automations   | List, create and delete                                          |                  1 | PASS          | A synthetic Daily Brief was created from the official suggestion and immediately deleted; the list returned to empty.                                        |
| Automations   | Edit, run and archive                                            |                  0 | PENDING       |                                                                                                                                                              |
| Plugins       | Catalog, search, installed list and details                      |                  2 | PASS (repeat) | Public catalog, categories, installed plugins and GitHub detail all loaded; first catalog load took about 4–6 s.                                             |
| Plugins       | Skill disable/enable and dependency behavior                     |                  1 | PASS          | GitHub Review Follow-up and dependent CI Debug were disabled and both restored.                                                                              |
| Plugins       | Share and “Try now”                                              |             1 each | PASS          | Share changed to `已复制`; Try now populated a new composer with the plugin skill.                                                                           |
| MCP           | Add, edit, restart, disable/enable and remove custom HTTP server |                  1 | PASS          | Synthetic `E2E-20260729-http` persisted all URL/token/header fields, toggled, restarted and was removed; list returned to MCP 0.                             |
| MCP           | Successful handshake and tool invocation                         |                  0 | PENDING       | A known-good synthetic server is still required.                                                                                                             |
| Browser       | Settings/provider availability                                   |                  2 | FAIL          | Official settings report `应用内浏览器插件不可用`; website permissions cannot load.                                                                          |
| Browser       | Approval policy persistence                                      |                  1 | FAIL          | Changing Always ask → Always allow returned `无法保存审批设置`.                                                                                              |
| Browser       | Data controls and screenshot mode                                |                  1 | PASS          | Individual data controls expanded; screenshot policy toggled and restored. Destructive data deletion was not executed.                                       |
| Computer use  | Provider availability                                            |                  1 | FAIL          | Official settings report `Computer Use 插件不可用`.                                                                                                          |
| Voice         | Voice settings, dictation, voice chat and microphone discovery   |                  2 | FAIL          | Voice settings cannot load; dictation does not record; voice chat reports unavailable; Retry fails; no microphone is found.                                  |
| Voice         | Dictionary add/remove and hotkey cancel                          |                  1 | PASS          | Synthetic dictionary term was added and removed; hotkey capture Cancel worked.                                                                               |
| Bottom panel  | Toggle, terminal tabs, resize/close                              |                  2 | PASS (repeat) | Terminal ran `pwd` on the VPS, returned the server workspace, and multiple terminal tabs opened and closed.                                                  |
| Bottom panel  | Files and Git                                                    |                  0 | PENDING       |                                                                                                                                                              |
| Bottom panel  | Browser panel                                                    |                  1 | FAIL          | Panel opens and accepts a URL, but page content stays blank at `开始浏览 / 输入 URL`.                                                                        |
| Settings      | Profile menu and all 19 settings sections                        |                  1 | PASS          | Every section and every profile-menu branch rendered and was inventoried. Functional failures are listed separately.                                         |
| Settings      | General switches, selectors and confirmation dialogs             |             1 each | PASS          | Eight switches and all visible selector groups were changed and restored.                                                                                    |
| Settings      | Language change                                                  |                  1 | FAIL          | Selecting English did not change the locale from Chinese.                                                                                                    |
| Settings      | Third-party license view                                         |                  1 | FAIL          | Page opens but reports `找不到第三方声明`.                                                                                                                   |
| Settings      | Appearance controls                                              |             1 each | PASS          | Theme, pointer, reduced motion, font sizes, diff style, six colors and four custom fonts were changed and restored.                                          |
| Settings      | Contrast sliders                                                 |                  1 | FAIL          | Keyboard adjustment produced no value change; pointer adjustment remains pending.                                                                            |
| Settings      | Config approval/sandbox/reasoning/dependencies                   |             1 each | PASS          | Editable values persisted and were restored; five reasoning strengths remain selected.                                                                       |
| Settings      | Ultra reasoning visibility                                       |                  2 | FAIL          | Switch click does not change its checked state.                                                                                                              |
| Settings      | Workspace dependency diagnose/install                            |             1 each | FAIL          | Diagnose reports `无法诊断 Codex 依赖项`; reinstall gives no result and version remains `未安装`.                                                            |
| Settings      | Personalization/personality/memory                               |             1 each | PARTIAL       | Memory toggles and restores; personality menu renders, but custom instructions report `无法加载 agents.md`.                                                  |
| Settings      | Built-in pets                                                    |                  9 | PASS          | All nine built-in pets selected successfully; final selection restored to Codex.                                                                             |
| Settings      | Custom pet creation                                              |                  1 | FAIL          | Returns `无法开始创建宠物`.                                                                                                                                  |
| Settings      | Keyboard shortcut search/set/clear/reset                         |             1 each | PASS          | Synthetic Environment Action 9 shortcut was set, cleared and reset to default.                                                                               |
| Settings      | Usage and billing                                                |                  2 | PARTIAL       | Plan and weekly usage load; credit balance is unavailable.                                                                                                   |
| Settings      | Account route                                                    |                  1 | FAIL          | Account navigation incorrectly renders the Usage and billing page.                                                                                           |
| Settings      | Hooks refresh                                                    |                  1 | PASS          | Empty state rendered and refresh returned `钩子已刷新`.                                                                                                      |
| Settings      | Connections / remote devices / SSH                               |             1 each | FAIL          | Pairing dialogs incorrectly identify the Linux server as a Mac; SSH list remains `正在加载` indefinitely.                                                    |
| Settings      | Git preferences and instruction save                             |             1 each | PASS          | Prefix, merge mode, force push, draft PR, review layout and both instruction fields were changed, saved and restored.                                        |
| Settings      | Worktree preferences                                             |             1 each | PASS          | Root, auto-delete confirmation and limit were changed and restored to default / enabled / 15.                                                                |
| Settings      | Archived task list                                               |                  1 | PASS          | Empty state renders; archive/restore lifecycle remains pending.                                                                                              |
| Help          | Mobile setup                                                     |                  1 | FAIL          | Route opens but incorrectly says the Linux server is a Mac.                                                                                                  |
| Help          | Chrome extension setup                                           |                  1 | FAIL          | Routes to Computer Use settings, which reports the required plugin unavailable.                                                                              |
| Help          | Keyboard shortcuts                                               |                  1 | PASS          | Modal and shortcut search both work.                                                                                                                         |
| Help          | New Features and Help                                            |             1 each | FAIL          | Both controls produce no visible browser result.                                                                                                             |
| Reliability   | Reload during idle and active turn                               |                  0 | PENDING       |                                                                                                                                                              |
| Reliability   | Browser disconnect/reconnect                                     |                  0 | PENDING       |                                                                                                                                                              |
| Reliability   | Service restart and exact-thread recovery                        |                  0 | PENDING       |                                                                                                                                                              |
| Reliability   | Two concurrent browser sessions                                  |                  0 | PENDING       |                                                                                                                                                              |
| Security      | Anonymous and invalid identity rejected                          |                  0 | PENDING       |                                                                                                                                                              |
| Security      | Cross-subject state isolation                                    |                  0 | PENDING       |                                                                                                                                                              |
| Performance   | Cold load, warm load, history, search, composer latency          |                  0 | PENDING       |                                                                                                                                                              |

## Observations

1. ChatGPT telemetry calls to `chatgpt.com/ces` receive Cloudflare challenge
   responses. This is noisy but did not block a real Chat-mode completion.
2. The ChatGPT project list currently reports `无法加载项目`. This is a functional
   failure until the underlying request path is identified, fixed, and retested.
3. Edited ChatGPT turns and a new projectless Codex turn expose the same bridge
   synchronization defect. The app-server records the final agent message and
   `task_complete`, while the renderer remains in a running state. Inspection of the
   exact bundled renderer established the root cause: current notifications require
   `{type, hostId, method, params}`, but the host sent the obsolete
   `{type, hostId, message: {method, params}}` envelope. Server requests likewise
   require `request`, not `message`. Release `20260729.1` contains the corrected
   official contract and dedicated regression tests; production verification is
   pending.
4. Several desktop-only bridges are currently exposed as controls instead of being
   backed by server equivalents: browser use, computer use, voice, workspace
   dependencies, custom pets, remote-device pairing, SSH discovery, and opening local
   files/folders.
5. Existing values were restored after all reversible setting tests. Destructive
   controls that would remove user data (memory reset, browser-data deletion, plugin
   uninstall, task deletion, and logout) are excluded until a synthetic target exists.
6. Quick Chat produces no visible action from either the home route or a plugin detail
   route. It remains a functional failure.
7. The terminal bridge is genuinely server-backed and usable. Its only visible defect
   is a harmless locale warning: `LC_ALL` is currently set to `undefined`.
