# Capabilities

**English** | [简体中文](CAPABILITIES.zh-CN.md)

> Source of truth for what this webui can and cannot do. Every row has
> a status (✅ works · ⚠ partial · ❌ blocked), a why, and where to
> look in the code.

The webui is bound by three constraints:
1. What the engine's acp exposes via JSON-RPC (the engine reports its
   version through the `agentInfo` payload of the `initialize` reply;
   see `/api/protocol/capabilities`).
2. What the Node `http` / `child_process` APIs can do.
3. What the browser's `EventSource` and `fetch` can do.

Anything outside these three is either ❌ blocked (no workaround) or
⚠ partial (workaround exists, with caveats).

## 0. Capabilities index

The 13 capabilities declared in `package.json#mcodeWebui.capabilities`
are cross-referenced below. Each row links to the section in this
doc where the feature is broken down by status.

| Capability | Detailed in |
|---|---|
| `chat-streaming` | §1 Core chat |
| `tool-execution` | §1 Core chat |
| `plan-mode` | §2 Plan mode |
| `ask-user-tool` | §4 Ask-user tool |
| `permission-prompts` | §3 Permission prompts |
| `workspace-switching` | §6 Workspaces |
| `session-management` | §7 Sessions |
| `file-attachments` | §9 Attachments |
| `quota-usage` | §8 Token usage & quota |
| `bilingual-ui` | §10 UI / UX |
| `lan-sharing` | §11 Network & access control |
| `token-auth` | §11 Network & access control |
| `git-panel` | §12 Git panel |
| `mobile-responsive` | §10 UI / UX |
| `bounded-workspace-search` | §6 Workspaces |
| `credential-file-preview-guard` | §11 Network & access control |
| `four-column-shell` | §10 UI / UX |

CI asserts on every one of these names appearing in this document
(see `scripts/check-docs-alignment.mjs`); the table above is the
single index that satisfies the check.

## 1. Core chat

| Feature | Status | Why / where |
|---|---|---|
| Multi-turn conversation with streaming deltas | ✅ | `mcode-acp.js` reads newline-delimited JSON; `state-bus.pushStateFor` broadcasts `delta` events |
| Multi-line assistant responses | ✅ | `parseChatLines` joins delta chunks per turn |
| Tool calls (Bash, Read, Write, Edit, …) | ✅ | forwarded from acp `tool_call` events |
| Auto-collapse of completed tool output | ✅ | CSS-only, no logic |
| Long chat list virtualization (≥ 200 messages) | ✅ | `webapp/lib/transcript.ts` virtual-window branch (N ≥ 200) with scroll/resize rAF handler; covered by `webapp/test/transcript.test.ts`. |
| Markdown rendering (headings, lists, code) | ✅ | `webapp/lib/markdown.ts` wrapping the workspace `marked` package (`packages/tui` already depends on it; no CDN) |
| Syntax highlighting in code blocks | ✅ | `marked` code renderer (`webapp/lib/markdown.ts`) + CSS classes from `webapp/styles/official-utilities.css` |
| Cancel mid-run | ✅ | acp `session/cancel` is sent as a notification, pinned on the cid's active child (`/api/protocol/cancel` → `server/lib/mcode-rpc.js#cancelSession`). The hard-kill fallback (`/api/stop` → SIGTERM/SIGKILL) is only used when the notification cannot be delivered. The acp session may emit a few extra events before draining. |
| Rewind / fork a message | ⚠ | The engine implements `session/fork` and `session/resume` (`MCODE_ACP_CAPABILITIES.fork / .resume = true`), but no webui route exposes them yet — see [§13](CAPABILITIES.md#13-what-mcode-would-need-to-add-to-enable-the--rows). |
| Edit a sent message and resend | ❌ | Not exposed by the acp protocol |
| Regenerate the last assistant response | ❌ | No acp method to discard a turn |
| Stream intermediate thinking (`<thinking>`) | ⚠ | Rendered if present in delta, but the engine emits them as plain text — no structured separation |

## 2. Plan mode

| Feature | Status | Why / where |
|---|---|---|
| Enter plan mode (`/plan` slash) | ✅ | webui adds a `Plan: ` prefix to the prompt; mcode acp responds with a structured plan event |
| Plan review modal with options | ✅ | the Next shell renders the plan modal in `webapp/components/modals.tsx`; user choice goes through `/api/answer` |
| Plan with three or more options | ✅ | server returns `options` array; client renders N buttons |
| "Add context to revise" plan option | ✅ | the modal exposes a free-text "add context" field when the user picks the "revise" option |
| Plan summary preview while still streaming | ⚠ | mcode acp emits `plan_summary` only on finalization. The webui shows the modal only after the plan event arrives. |
| Skip plan and go directly to execution | ✅ | the "Skip" button on the plan modal |

## 3. Permission prompts

| Feature | Status | Why / where |
|---|---|---|
| Session-level permission mode (`ask`/`auto`/`read`/`full`) | ✅ | the typed `state.permissions`; webui sends `setConfigOption {configId:'permissionMode'}` through `/api/permissions {mode}`, which routes via the cid's active child to `session/set_config_option`. The route also writes the chosen label back into `cs.permissions` so the UI updates without waiting for the next SSE state push. |
| Per-tool permission prompt modal | ✅ | when acp emits a `permission` event, `webapp/components/modals.tsx` opens the permission modal |
| Approve / deny / always-allow-this-tool | ✅ | three options: `ask`, `auto`, `full`; sent via `/api/answer` |
| Pre-grant a tool for the rest of the session | ⚠ | per-call only — there is no per-tool whitelist yet |
| Custom rules (e.g. "Bash on /tmp is auto, rest is ask") | ❌ | the acp protocol has no rule language |

## 4. Ask-user tool

| Feature | Status | Why / where |
|---|---|---|
| Modal question with 2-4 options | ✅ | `webapp/components/modals.tsx` builds the modal from acp's `ask` event |
| Multi-select (checkboxes) | ✅ | acp `multiSelect: true` → webapp renders checkboxes |
| Free-text "Other" input | ✅ | per-question "Other" field; sends via `/api/send {isAskAnswer:true}` |
| Skip / dismiss an ask | ✅ | the close button stores the question id in the session-local dismissal set so it never re-appears in the same session |
| Re-show a dismissed question | ✅ | the dismissal set is per-session and per-CID; opening a new session or new CID starts fresh, and the same question can be re-asked |
| Re-prompt the same question | ⚠ | once a question id is dismissed in the current session, the webui silently drops it. Clearing the set is a manual gesture (new session or new CID). |
| Nested questions (one ask containing sub-questions) | ⚠ | the protocol supports a `questions` array; the webui renders them as separate modals queued one after another, not nested in a single modal. |
| Optional / required flag | ❌ | the engine does not expose the optional flag — every question is treated as required |

## 5. Slash commands

| Feature | Status | Why / where |
|---|---|---|
| Built-in command list (`/help`, `/compact`, `/model`, …) | ✅ | mcode acp `session/commands` is fetched at connect; cached in `mcodeCommandsCache` |
| Command autocomplete on `/` | ✅ | `filterSlash()` builds the overlay; matches against `cmd` and `description_*` |
| Local (webui-side) commands | ✅ | `/exec` switches transport to mcode exec; `/clear` clears the chat UI without touching mcode |
| Hidden / experimental commands | ⚠ | the acp `commands` list returns everything mcode knows about. The webui has no `hidden` flag yet. |

## 6. Workspaces

| Feature | Status | Why / where |
|---|---|---|
| Switch workspace via picker | ✅ | `webapp/components/workspace-picker.tsx` (slice 15) — modal opens from `WorkspaceTabsLauncher` and the chip dropdown; posts to `POST /api/workspace`. Picker content is loaded via `GET /api/workspace/tree` and resolved folder names via `GET /api/workspace/resolve`; recents (last N) come from `GET /api/workspace/recent`. The native OS picker (`zenity` / `kdialog` / `osascript` / `PowerShell`) was removed in slice 14 (in-product picker only). |
| Visual directory-tree browser (Windows drive roots) | ✅ | `/api/workspace/browse` lists children; the Next shell renders the tree in `webapp/components/panels.tsx` |
| Recent workspaces (last 5) | ✅ | the typed store's recents slice, populated on workspace change |
| Restore last workspace on reload | ✅ | the typed store persists the last workspace to `localStorage` and replays it on next load |
| Lock workspace for the duration of a chat | ❌ | the server has no lock to set — this described the removed chip's own hiding rule, so nothing implements it now |
| Per-workspace git status (branch, dirty) | ⚠ | best-effort; the server shells out to `git status` once on workspace change. Errors are silently swallowed → the chip shows "—". |
| Symlink resolution in the directory browser | ❌ | `fs.readdir(..., {withFileTypes:true})` returns symlinks as `Dirent`; webui shows them as files. No symlink-follow option yet. |
| WSL path support | ❌ | `/api/workspace/browse` uses `path.join`, which on Windows is `\\`-aware but doesn't translate WSL `\\wsl$\…` paths |
| Bounded workspace search (slice 19a) | ✅ | `GET /api/fs/search` — `server/lib/fs-search.js#searchWorkspace`. Same containment gate as the other `/api/fs/*` routes; budgets (depth / nodes / wall-clock / matches) are clamped to absolute limits and exceeding one returns `truncated: true` with a `truncatedReason` rather than silently. `node_modules` and `.git` are non-overridable skips; the build/cache set is overridable. Credential predicate re-uses `lib/credential-file.js` (slice 16) — matches are flagged with `credential: true`, never omitted, never content. The response carries paths and types only — no body, no `size` sample, no `mtime`. |

## 7. Sessions

| Feature | Status | Why / where |
|---|---|---|
| Session list (sidebar) | ✅ | merged from `state.sessions` (webui JSON) + `state.mcodeSessions` (mcode sqlite) |
| Per-workspace session grouping | ✅ | the session tree in `webapp/components/session-tree.tsx` groups by `workspace` |
| Switch session on click | ✅ | clicking a session row triggers `/api/sessions/switch` |
| New chat from button | ✅ | opens the workspace picker first if no workspace is set |
| Delete session from sidebar | ✅ | two-tap confirm: `session-delete` button → 5-second confirm bar |
| Delete session in mcode sqlite too | ✅ | `/api/sessions/:id` DELETE handler calls `deleteMcodeSessionFromDb` (`server/lib/mcode-session-delete.js`, the function lifted out of the old `db.js`) |
| Cleanup orphaned mcode sessions | ✅ | `/api/sessions/cleanup-orphans` lists mcode sessions not referenced by any webui session, then deletes them (scope: `orphans` or `all`) |
| Resume an mcode session opened in the TUI | ❌ | the acp session has a single owner; the webui shows a read-only banner when it detects a foreign owner |
| Cross-workspace session search | ✅ | the sidebar search input calls `GET /api/sessions/search` which aggregates matches across every workspace with a title (case-insensitive fuzzy match + per-workspace dedup). B03-gated. |
| Export a session to Markdown / JSON | ✅ | `GET /api/sessions/:id/export?format=md|json[&download=true]` (v2.0.0, lease C06) reads `$WEBUI_DATA_DIR/sessions.json` (primary) + `runtime-state.sqlite` (best-effort secondary). B03 authorize-gated. `server/routes/export.js` + `test/routes/export.check.mjs`. |

## 8. Token usage & quota

| Feature | Status | Why / where |
|---|---|---|
| Per-turn context window (% used) | ✅ | SSE `delta` events accumulate into `state.context`; per-turn percentage is computed in `server/lib/context-percent.js` |
| Cache read ratio | ✅ | parsed from acp `cache_read_input_tokens` |
| tok/s (current stream speed) | ✅ | computed over a rolling 2-second window from `delta` events |
| `mavis` runtime db per-turn context (last turn) | ✅ | `server/lib/mavis-usage.js` reads `local_runtime_token_usage` |
| Token Plan quota (5h + weekly) | ✅ | the engine reads it and reports it over ACP as `mcode/account/status`; `server/lib/usage.js` maps the projection, `webapp/components/shell.tsx` renders the popover. webui stores no Subscription Key of its own |
| Time-until-reset (5-hour + weekly) | ✅ | the Next shell renders the bilingual countdown ("n小时m分" / "n天m小时") |
| Forecast exhaustion time | ✅ | `GET /api/usage/forecast` returns linear + robust (huber) extrapolation from rolling 5h/weekly reset deltas (v2.0.0, lease C07). `server/lib/quota-forecast.js` + `test/lib/quota-forecast.test.js`. UI displays a countdown. |

## 9. Attachments

| Feature | Status | Why / where |
|---|---|---|
| Click-to-upload button | ✅ | the composer (`webapp/components/composer.tsx`) renders a styled upload button |
| Drag & drop into the chat area | ✅ | drag-and-drop is wired in the chat panel |
| Paste image from clipboard (Ctrl+V) | ✅ | the composer reads `clipboardData.files` on paste |
| File path injection as `@file` | ✅ | `server/routes/upload.js` saves to `MCODE_WEBUI_UPLOAD_DIR`; client injects `@/absolute/path` into the prompt |
| Image preview before send | ⚠ | filename only, no inline thumbnail. mcode acp accepts `@file` and decides rendering. |
| Multi-file attach (≥ 2 in one drop) | ✅ | `dataTransfer.files` iteration |
| Per-message attachment delete (×) | ✅ | each attachment chip has a remove control |
| Resume upload after disconnect | ❌ | upload is sync (one-shot POST); no chunked upload support |

## 10. UI / UX

| Feature | Status | Why / where |
|---|---|---|
| Bilingual UI (zh-CN / en) | ✅ | `webapp/lib/i18n.ts` (`en`/`zh-CN` tables); typed `t(MessageKey)` lookup |
| Light / dark theme | ✅ | `applyTheme()` in `webapp/lib/theme.ts` toggles the `data-theme` attribute on `<html>`; `prefers-color-scheme` is the initial value |
| Mobile responsive (< 900 px) | ✅ | Tailwind responsive utilities; drawer layout for sidebar + right panel |
| Single column at < 600 px | ✅ | `flex-direction: column` |
| In-page debug log panel | ✅ | bottom-right black panel; copy / clear; 30-line ring buffer |
| Toast notifications | ✅ | 3-second auto-dismiss toast surface rendered by `webapp/components/action-error-banner.tsx` |
| Keyboard shortcuts (Ctrl+K focus, Esc close, …) | ✅ | global keydown handler in `webapp/components/shell.tsx` |
| Slash-command keyboard navigation (↑↓ Enter Tab) | ✅ | the composer's slash overlay uses a keydown listener |
| Dark mode respecting OS preference | ✅ | `prefers-color-scheme` media query at boot |
| Custom CSS themes | ❌ | no theme loader; would need a CSS-vars system |
| User-defined hotkeys | ❌ | shortcuts are hard-coded |
| Four-column shell (sidebar · conversation · preview · tree) | ✅ | slice 17 (`webapp/components/workspace-columns.tsx`). Conversation column is fluid in `[280, 768]` px; preview and tree columns are persistent as of main. Surface kinds are split by `columnRoleForKind` — `file:<path> \| browser` lives on the preview column, `files \| git \| tasks \| search \| plugins` on the tree column. The previously-shipped `search`, `alerts`, and `progress` `PanelKind` values were removed from the union (`webapp/lib/persist.ts#PanelKind`). The two surface placeholders (`search`, `plugins`) are explicitly disclosed; the engine contract for plugins is not yet shipped, so the Plugins surface renders an i18n "this is coming" card rather than a silent no-op. |

## 11. Network & access control

| Feature | Status | Why / where |
|---|---|---|
| HTTP server | ✅ | Node `http.createServer` |
| LAN sharing with on/off toggle | ✅ | runtime state in `settings.lanBroadcastEnabled`; closed by default for non-local IPs |
| Friendly 403 page when LAN is off | ✅ | `LAN_REJECT_HTML` template in `settings.js`; v1.0.1: single bilingual page (zh + en stacked), dynamic `PORT` (was hardcoded `7890` which broke at v0.5 default change) |
| Token auth (`?token=` or `Authorization: Bearer`) | ✅ | `server/router.js` validates `req.url` and `req.headers.authorization`; if set, every request must include the token |
| **Token auth: default-on (v1.0.1)** | ✅ | First start with no `TOKEN` env auto-generates a 32-hex token, persists to `~/.mcode-webui/settings.json` (mode 0600, atomic write via `.tmp` + rename). **v2.0.0 (lease C08)**: token no longer printed to stdout in 14-line ASCII box; instead a `token.first_run` SSE event is broadcast to all connected tabs and a single neutral `token persisted to: <path>` line is printed to stdout (gated by `MCODE_WEBUI_TOKEN_STDOUT=1`). The settings card shows the token until the operator clicks "我已保存 / I have saved it". `MCODE_WEBUI_SETTINGS_PATH` env overrides the file location. `TOKEN` env still wins (escape hatch). |
| **Token auth: reset + live broadcast (v1.0.1)** | ✅ | "重置 token" button generates a new 32-hex value, persists it, and broadcasts an `auth.token_rotated` SSE event with the new token. Each connected client updates its `localStorage` and the live `HEADERS.Authorization` object **in place** — subsequent `fetch()` calls use the new token automatically, no reload required. Crash-safe: disk write first, in-memory state committed only on success. |
| **Token auth: acknowledged state machine (v1.0.1)** | ✅ | After "我已保存", the server records `tokenAcknowledged=true` and stops including `currentToken` in subsequent `GET /api/settings` responses and SSE state pushes. UI replaces the value/mask row with a `✓ 已保存 — 查看请点"重置" / Saved — click "Reset" to view again` placeholder. Resetting triggers a new rotation. Persisted across restarts. |
| **Token auth: settings persistence (v1.0.1)** | ✅ | Token + readOnly + tokenEnabled + tokenAcknowledged + tokenRotatedAt + allowedInterfaces (no-op stub) all persist to `~/.mcode-webui/settings.json`. `lanBroadcast` remains in-memory only (intentional — reboot re-enables LAN so admins don't get locked out). |
| Read-only mode (v1.0.1) | ✅ | When on, non-local `POST` / `DELETE` to `/api/*` return `403 {"error": "read-only mode"}`. `GET` / `HEAD` / `OPTIONS` exempt. Local requests always exempt. `/api/settings` exempt (escape hatch). Persisted. Top-bar shows a red pulsing "只读 / READ ONLY" chip when on. |
| Per-cid SSE channel | ✅ | one EventSource per browser tab; one mcode subprocess per cid |
| HTTPS | ⚠ | v2.0.0 (lease C03) — HTTPS itself requires a reverse proxy; **fully documented** in `docs/HTTPS-REVERSE-PROXY.md` (387 lines, nginx / caddy / Traefik 2 configurations with SSE long-connection notes). No code change in webui. |
| mTLS / client cert | ❌ | same as above; documentation in `docs/HTTPS-REVERSE-PROXY.md` |
| Rate limiting | ✅ | v2.0.0 (lease C03): `server/lib/rate-limit.js` (252 lines) — token-bucket per-ip with 60/min default + 100 burst + 2× multiplier for token holders. Router gate 4 returns 429 when exceeded. `lib-rate-limit.test.js` (339 lines, 21 unit tests). |
| Credential-file preview guard | ✅ | slice 16 — basename match against `.env` / `.env.*` / `*.pem` / `*.key` / `id_*` SSH keys / `known_hosts` / `authorized_keys` / `.npmrc` / `.pypirc` / `.netrc` / `.pgpass` / `credentials*` and the backup-suffix set (`.bak` / `.old` / `.orig` / `.backup` / `.save` / `.swp`) returns `403 {code:"credential"}` from `GET /api/fs/read-file` unless `?confirm=1` is appended. The shared predicate (`server/lib/credential-file.js`) is mirrored verbatim in `webapp/lib/credential-file.ts`; `webapp/test/credential-file.test.ts` walks both implementations on the same fixtures so they cannot drift. `GET /api/fs/search` re-uses the same predicate and flags matches with `credential: true` but never omits or returns content; `GET /api/fs/raw` uses the same gate in streaming form. |

## 12. Git panel

| Feature | Status | Why / where |
|---|---|---|
| Workspace status (`git status --porcelain=v1 -b`) | ✅ | `GET /api/git/status` — `server/lib/git.js#gitStatus`. Returns branch + upstream + ahead/behind + per-file `{x, y, path, origPath, staged}`. Non-git directories answer `{ok:false, isRepo:false}` and the panel renders an empty state, not a red toast. |
| Local-branch list + current marker | ✅ | `GET /api/git/branches` — `server/lib/git.js#gitBranches`. `branch --list --format=%(refname:short)`; the leading `* ` (the default `--list` marker) becomes the `current` flag. |
| Single-file diff against HEAD | ✅ | `GET /api/git/diff?dir=&file=` — `server/lib/git.js#gitDiff`. Tries `git diff HEAD -- <file>` first; falls back to `git diff --no-index -- /dev/null <file>` for untracked files (synthetic all-add diff). The `--` separator is the option-injection boundary. |
| Branch switch (destructive, confirmed client-side) | ✅ | `POST /api/git/checkout {dir, branch}` — `server/lib/git.js#gitCheckout`. Branch name matched against `^[A-Za-z0-9._/-]+$` and rejected when it starts with `-`; containment gate enforces an allowed root; `execFile` keeps `git`'s argv literal. |
| Right-panel Git surface (`GitPanel`) | ✅ | `webapp/components/panels.tsx#GitPanel` (slice 03). Current branch + changed-file list with click-to-preview diff; branch switcher with a confirmation prompt; non-git or out-of-root directory shows an empty state. |
| `/review` slash command (TUI parity) | ✅ | `server/lib/interaction/commands.js#bodyReview` + `handleLocalSlash`/`handleCmdCommand`. Emits a `staged / unstaged / untracked` overview into the chat, sourced from the shared `gitStatus` helper. |
| Containment gate shared with `/api/fs/*` | ✅ | `assertWorkspacePath` (server/lib/workspace.js). Every git entry point funnels the requested `dir` through it; out-of-root answers `{ok:false, error:"…不在允许根内…"}` and the panel reads `ok` rather than the HTTP code. |
| execFile, no shell | ✅ | `run(dir, args)` in `lib/git.js` uses `execFile('git', ['-C', dir, ...args], …)` so every argv element is a literal child argv. No shell, no metacharacter surface. |
| Local-branch allow-list (regex + leading-dash guard) | ✅ | `BRANCH_RE` and `branch.startsWith('-')` in `gitCheckout`. The panel only offers branches from the server's `/api/git/branches` list; the server-side allow-list is the defence-in-depth that survives a forged request. |

## 13. Operations

| Feature | Status | Why / where |
|---|---|---|
| Zero npm install | ✅ | Only two runtime deps (`hono`, `@hono/node-server` for the HTTP layer, and `@mavis/shared` for the workspace path contract); the rest is Node stdlib. The `pnpm install` step is part of the standard workspace bootstrap, not a webui-specific installer. |
| Configurable port via `PORT` env | ✅ | `server/lib/config.js#PORT` (default `18090`; when free, walks forward; pinned ports stay put). |
| Configurable host via `HOST` env | ✅ | `server/lib/config.js#resolveBindHost` (env > persisted `lanBind` > loopback). |
| Configurable default model via `MCODE_MODEL` env | ✅ | `server/lib/config.js#DEFAULT_MODEL`. |
| Uncaught exception sink (`$WEBUI_DATA_DIR/.server.err`) | ✅ | `installGlobalErrorHandlers` in `server/lib/config.js`. |
| Graceful shutdown on SIGTERM / SIGINT | ✅ | `server/bootstrap.js` forwards signals to the child + closes the listener |
| systemd / Windows Service manifest | ❌ | out of scope; user is expected to use `pm2`, `nssm`, or run in a terminal |
| Hot reload of code | ❌ | restart the server |
| Health check endpoint | ✅ | `GET /api/health` returns `{ok:true, port, defaultModel, defaultWorkspace, mcodeCmd, mcodeVersion, maxConcurrent}` |
| Append-only event audit log (`events.ndjson`) | ✅ | `server/lib/events.js` — NDJSON append with SHA-256 hash chain, monotonic `seq`, 200ms write-behind. Write-points: settings.js / sessions.js / upload.js / slash.js / mcode-session-delete.js / export.js / alerts.js (dynamic). Tests: `test/lib/events.test.js` + `test/lib/events-hash.test.js`. `$WEBUI_DATA_DIR/events.ndjson`. |
| Independent anomaly SSE channel | ✅ | `server/lib/alerts.js` + `GET /api/alerts` SSE + frontend bell icon + unread count. 3 levels (info/warn/error), 100-entry ring buffer, 60s dedup window. |
| Per-request authorize gate | ✅ | `server/lib/authorize.js` — `authorize(action, ctx, opts)` Promise with 5-minute default timeout (fail-closed), 8-action whitelist (`session.delete`, `sessions.cleanup-orphans`, `session.cleanup-all`, `session.export`, `session.search`, `token.reset`, `slash.clear`, `startup.cleanup`). Tests: `test/lib/authorize.check.mjs`. |
| SBOM + local CVE gates | ✅ | `pnpm --filter @mavis/webui sbom` → CycloneDX 1.5 (`scripts/gen-sbom.mjs`) + `pnpm audit --omit=dev` + the repo-level `docs/verification.md` matrix. The webui itself has no plugin-level CI workflow; the only enforcement is `pnpm --filter @mavis/webui check` (the docs-alignment gate) plus the monorepo `pnpm verify`. |
| `token.first_run` SSE event | ✅ | `server/lib/state-bus.js#pushTokenFirstRun` broadcasts `{event: "token.first_run", data: {token, persistPath}}` to all `sseByCid` on first boot. Replay-guarded by `auth.js#isFirstRun()` + persistent `tokenAcknowledged` flag. |

## 14. What mcode would need to add to enable the ❌ rows

- `set_mode` / `set_config_option` → mid-session permission switch in the UI
- `cancel` → true mid-flight cancellation, not just SIGTERM
- `fork` / `resume` / `rewind` → rewind/regenerate UI
- `request_permission` with structured rules → per-tool whitelist
- `session/message.delete` → "edit and resend"
- `session/export` → export to MD/JSON
- `tool_call.input.thumbnail` → inline image preview
- A quota metric with rate-of-use → forecast exhaustion time
- An optional flag on ask questions → optional questions
- A path-prefix resolver for WSL symlinks → WSL path support

These are upstream asks. See [docs/acp-goal-plan-status.md](acp-goal-plan-status.md)
for the historical list and the response from the mcode team.
