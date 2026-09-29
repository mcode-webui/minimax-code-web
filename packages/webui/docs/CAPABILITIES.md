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
| `on-demand-columns` | §10 UI / UX |
| `three-state-appearance` | §10 UI / UX |
| `ide-grade-code-preview` | §10 UI / UX |
| `preview-toolbar-edit-save` | §10 UI / UX |

CI asserts on every one of these names appearing in this document
(see `scripts/check-docs-alignment.mjs`); the table above is the
single index that satisfies the check.

## 1. Core chat

| Feature | Status | Why / where |
|---|---|---|
| Multi-turn conversation with streaming deltas | ✅ | `mcode-acp.js` reads newline-delimited JSON; `state-bus.pushStateFor` broadcasts `delta` events |
| Multi-line assistant responses | ✅ | `parseChatLines` joins delta chunks per turn |
| Tool calls (Bash, Read, Write, Edit, …) | ✅ | forwarded from acp `tool_call` events. The turn-summary file chip row is derived from `tool_update.locations` first, then **from the tool's own JSON arguments** via `webapp/lib/tool-paths.ts#extractToolPaths` (slice 20) — `read`/`read_file`/`view` → `path`; `write`/`create_file`/`write_file` → `path`; `edit`/`apply_patch`/`str_replace`/`multi_edit`/`file_edit`/`notebook_edit` → `file_path`; `grep`/`search`/`find`/`workspace_semantic_search` → `path` (the search **scope**, not the term). `glob` and `bash`-family tools deliberately emit no chip (their `pattern`/`command` is not a single file). Read-family tool cards sometimes carry no arguments — the engine does not always populate them — so the chip row may be **absent** for a `read` call whose `path` argument is empty. The decode caps the row at `TOOL_PATHS_PER_CALL` (10) and dedupes first-occurrence wins. |
| Auto-collapse of completed tool output | ✅ | CSS-only, no logic |
| Long chat list virtualization (≥ 200 messages) | ✅ | `webapp/lib/transcript.ts` virtual-window branch (N ≥ 200) with scroll/resize rAF handler; covered by `webapp/test/transcript.test.ts`. |
| Markdown rendering (headings, lists, code) | ✅ | `webapp/lib/markdown.ts` wrapping the workspace `marked` package (`packages/tui` already depends on it; no CDN) |
| Syntax highlighting in code blocks | ✅ | `marked` code renderer (`webapp/lib/markdown.ts`) + CSS classes from `webapp/styles/official-utilities.css` |
| Mermaid diagrams in markdown (slice 23) | ✅ | a fenced code block whose language token is `mermaid` renders as a diagram instead of a code block. Fence languages dispatch through the language→renderer registry (`webapp/lib/markdown.ts#registerLanguageRenderer`, lines 107-113); mermaid self-registers on import (`webapp/lib/mermaid-renderer.ts:64-71`), and a renderer for any other fence language plugs into the same seam — the markdown main flow never branches on a language name. The chart library is `import()`-ed on the first diagram of a page (`webapp/components/mermaid-block.tsx:62-66`) and its chunk is served with a one-year immutable cache (`server/lib/static.js:66`); a page without a mermaid fence never requests it. Diagrams follow the light/dark theme (`components/markdown-html.tsx:52-66` re-renders on the `<html>` class flip; `components/mermaid-block.tsx:156-166,223-229` re-initialises mermaid per theme). A syntax error renders a legible failure card — error text plus the original source in a copyable `<pre>` (`components/mermaid-block.tsx:285-307`) — while the rest of the document renders normally. Limits: diagrams scale to the column width and scroll when wider (`webapp/styles/mermaid.css:62-80`); CJK labels render via the font stack at `components/mermaid-block.tsx:109`; a diagram is never a heading, so it appears in no heading-derived outline (the fence emits a `<pre>`/`<div>` pair, not `h1`-`h6` — `lib/mermaid-renderer.ts:44-57`). Dependency `mermaid` 11.12.1 (MIT) is recorded in `release/dependency-licenses.json`. |
| Math formulas via KaTeX (inline `$…$`, display `$$…$$`, ```` ```math ```` fences) | ✅ | the same pipeline as Mermaid: an inline marked extension (`webuiMath`) tokenises `$…$`/`$$…$$` and the ```math fence dispatches through the language→renderer registry (`webapp/lib/math-renderer.ts`, self-registered on import), so neither fence language can shadow the other. A single `$` is math only with a closing delimiter on one line and a non-digit start — `costs $5 and $10`, `$HOME`, unclosed `$` stay prose. A formula KaTeX cannot parse degrades to the original source as code (inline `<code class="inline-code">`, fence → the plain codeblock shell) — the page never blanks. KaTeX runs with `output: "html"` (emits only `span`/`svg`/`path`, which the sanitiser allowlist admits with a fixed attribute set; `<math>`/MathML stays a DROP tag) and `trust: false` (`\href` renders as red warning text, never a link). Inline `style` survives only on `span` and only when the value clears `isSafeStyleValue` — no parentheses (no `url()`/`expression()`), and `position`/`background`/`behavior` are refused; `components/markdown-html.tsx` converts the style attribute to a React style object (`parseInlineStyle`), since React rejects a string style prop. CSS is vendored at `webapp/styles/katex.css` (from `katex/dist/katex.min.css`, `@font-face` repointed to `/fonts/katex/…`) and loaded from `app/layout.tsx`; fonts (60 files + MIT notice) are vendored at `webapp/public/fonts/katex/`. Formulas are inheriting text — both themes work without a re-render. Known cost: `katex` JS ships in the client bundle rather than lazy-loading like mermaid (the math pipeline is synchronous `renderToString`). Dependency `katex` 0.18.7 (MIT) is recorded in `release/dependency-licenses.json`. Tests: `webapp/test/markdown-math.test.ts`. |
| Preview toolbar: refresh / edit / save (slice 27) | ✅ | the preview header carries ↻ refresh (re-read from disk, scroll position restored; a deleted/renamed file keeps the last content and shows an explicit banner — `components/file-preview.tsx` refresh handler), a 预览/编辑 toggle (text previews only, `lib/preview-edit.ts#canEditPreview`; credential-shaped paths must pass an explicit confirmation card first — `editRequiresCredentialConfirm` on the slice-16 predicate), and ✓ save (never automatic; success shows "saved at HH:MM", failure keeps the buffer and states the server's reason). Saves go through `POST /api/fs/write` (`api.ts#saveFsFile`) carrying the `(expectedMtime, expectedSize)` baseline from the load; a drifted baseline answers a conflict card (overwrite / reload) rather than a silent overwrite. The write answers with the **realpath-normalised absolute path** (the shared gate resolves symlinks before anything else — the same slice-16 form every `/api/fs/*` route returns; on macOS a `/var/...` fixture therefore answers `/private/var/...`). |
| Markdown outline panel (slice 27) | ✅ | `webapp/components/markdown-toc.tsx` + `webapp/lib/markdown-toc.ts`. The outline is extracted from the RENDERED DOM (`querySelectorAll("h1,…,h6")`), never a second markdown parse; heading ids are assigned onto those nodes (stable slugs, `-2`/`-3` dedupe suffixes — `headingSlug`/`extractOutline`, pinned by `webapp/test/markdown-toc.test.ts`). A click `preventDefault`s the anchor and smooth-scrolls the heading into view via `scrollIntoView`; the panel is sticky within the scroll viewport (max-height pinned to the viewport's height) and the active entry follows the scroll position. Documents without headings render no panel; a heading nested inside a `.mermaid-block` is excluded defensively (`isOutlineHeading`); entries are readable in both themes via design tokens. Below ~300px of content width the outline hides (observing the stable `.file-preview-body` width, not the markdown host — watching the host creates a show/hide feedback loop) rather than squeezing the document. |
| Cancel mid-run | ✅ | acp `session/cancel` is sent as a notification, pinned on the cid's active child (`/api/protocol/cancel` → `server/lib/mcode-rpc.js#cancelSession`). The hard-kill fallback (`/api/stop` → SIGTERM/SIGKILL) is only used when the notification cannot be delivered. The acp session may emit a few extra events before draining. |
| Rewind / fork a message | ⚠ | The engine implements `session/fork` and `session/resume` (`MCODE_ACP_CAPABILITIES.fork / .resume = true`), but no webui route exposes them yet — see [§14](CAPABILITIES.md#14-what-mcode-would-need-to-add-to-enable-the--rows). |
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
| Local (webui-side) commands | ✅ | `WEBUI_LOCAL_COMMANDS` (`server/lib/acp-client.js`): `new`, `clear`, `status`, `sessions`, `usage`, `help`, `stop`; `/clear` clears the chat UI without touching mcode. There is no `/exec` command — transport is chosen per turn by the environment (`MCODE_USE_ACP=0`) or the permission mode (≠ Full access), never by a slash command. |
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
| Bounded workspace search (slice 19a, wired in slice 19b) | ✅ | `GET /api/fs/search` — `server/lib/fs-search.js#searchWorkspace`. Same containment gate as the other `/api/fs/*` routes; budgets (depth / nodes / wall-clock / matches) are clamped to absolute limits and exceeding one returns `truncated: true` with a `truncatedReason` rather than silently. `node_modules` and `.git` are non-overridable skips; the build/cache set is overridable. Credential predicate re-uses `lib/credential-file.js` (slice 16) — matches are flagged with `credential: true`, never omitted, never content. The response carries paths and types only — no body, no `size` sample, no `mtime`. The file-tree filter (slice 19a) and the sidebar tree-column "搜索" surface (slice 19b) both call this endpoint via `api.searchFs`. The file-tree filter is **loaded-first**: it tries `filterAncestors` against the in-memory tree first, and only fires the server request when the loaded set has zero hits — so the search walks **unloaded directories** too. The sidebar tree-column surface uses the same 200 ms-debounce + `AbortController` + generation-counter pattern; on hit it routes through `fs-tree-reveal` to expand the match in the file tree. The response footer carries `scanned`, `matches`, `skipped` (per reason: `node_modules` / `.git` / `credential` / `huge` / `optional`), `truncated`, `truncatedReason`, `elapsedMs`, and the budget values — see `searchFootSegments` in `webapp/lib/fs-search.ts` for the exact i18n templates. |

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
| Three-state appearance picker (slice 18 — light / dark / follow system) | ✅ | `webapp/components/appearance-card-picker.tsx` (`data-testid="appearance-card-picker"`). The picker is a `role="radiogroup"` of three cards that mirror the desktop reference (`refs/ui/04-settings-general.jpg`). The choice lives on the slice-07 `webui:ui:v1:<cid>` envelope as `appearance` (`"light" \| "dark" \| "system"`); `system` resolves live against `matchMedia('(prefers-color-scheme: dark)')` via `subscribeSystemTheme` in `webapp/lib/theme.ts` so an OS theme flip paints immediately without a reload or a settings open. Picker placement is inside the Settings modal's appearance section (`webapp/components/panels.tsx#SettingsModal`); this differs from the desktop reference, which surfaces it on a dedicated settings page — same component, different host surface. The three cards are `role="radio"` with `aria-checked`; arrow-key navigation is not implemented, deviating from the ARIA radio-group convention. |
| On-demand preview / tree columns (slice 21) | ✅ | `webapp/lib/workspace-tabs-state.ts#syncColumnVisibility` re-derives `collapsed.preview` / `collapsed.tree` from the tab strip on every change. Each column appears when at least one matching-role tab is open and auto-closes when the last tab in that role closes. The deserializer normalises a stale "column open but empty" payload to closed so a stale disk write cannot conjure an empty column on hydration. Idle state with both columns folded: the conversation column takes the full remainder (1040 px at 1280 / 240-px chrome; 1680 px at 1920). Tests: `webapp/test/workspace-tabs-state.test.ts#computeColumnLayout — slice 21 idle state`. |
| Mobile responsive (< 900 px) | ✅ | Tailwind responsive utilities; drawer layout for sidebar + right panel |
| Single column at < 600 px | ✅ | `flex-direction: column` |
| In-page debug log panel | ✅ | bottom-right black panel; copy / clear; 30-line ring buffer |
| Toast notifications | ✅ | 3-second auto-dismiss toast surface rendered by `webapp/components/action-error-banner.tsx` |
| Keyboard shortcuts (Ctrl+K focus, Esc close, …) | ✅ | global keydown handler in `webapp/components/shell.tsx` |
| Slash-command keyboard navigation (↑↓ Enter Tab) | ✅ | the composer's slash overlay uses a keydown listener |
| Dark mode respecting OS preference | ✅ | `prefers-color-scheme` media query at boot |
| Transcript skeleton + streaming activity indicator (ticket U8) | ✅ | cold-load `!state` branch renders `TranscriptSkeleton` (shimmer bars shaped like real message rows, `webapp/components/loading-states.tsx`); the streaming tail indicator (`ActivityPulse`) shows the three-dot loader plus a shimmer bar while `running.active`; every animated class is explicitly static under `prefers-reduced-motion: reduce` (`webapp/app/globals.css`). Tests: `webapp/test/loading-skeleton.test.ts`. |
| Custom CSS themes | ❌ | no theme loader; would need a CSS-vars system |
| User-defined hotkeys | ❌ | shortcuts are hard-coded |
| Four-column shell (sidebar · conversation · preview · tree) | ✅ | slice 17 + slice 21 (`webapp/components/workspace-columns.tsx`). Conversation column is fluid in `[280, 768]` px while at least one fixed column is visible; with **both** on-demand columns folded the conversation column lifts past 768 and takes the full remainder — measured at 1280 / 240-px chrome = 1040 px, at 1920 = 1680 px (`webapp/test/workspace-tabs-state.test.ts#computeColumnLayout — slice 21 idle state`). The preview and tree columns are **on demand** (slice 21): each appears when at least one matching-role tab is open and auto-closes when the last tab in that role closes. `syncColumnVisibility(tabStrip, layout)` re-derives the visibility flags on every change; the deserializer normalises a stale "column open but empty" payload to closed so a stale disk write cannot conjure an empty column. Surface kinds are split by `columnRoleForKind` — `file:<path> \| browser` lives on the preview column, `files \| git \| tasks \| search \| plugins` on the tree column. The previously-shipped `search`, `alerts`, and `progress` `PanelKind` values were removed from the union (`webapp/lib/persist.ts#PanelKind`). The sidebar tree column's "搜索" surface is **real as of slice 19b** (`webapp/components/workspace-tree-column.tsx#SearchSurface`); the engine contract for plugins is not yet shipped, so the Plugins surface still renders an i18n "this is coming" card rather than a silent no-op. |
| IDE-grade code preview (slice 22 — line gutter, per-language lazy syntax highlighting, byte-faithful copy) | ✅ | `webapp/components/code-view.tsx` is mounted inside `file-preview`. (1) **Line-number gutter** via `splitHighlightedLines` (`webapp/lib/code-highlight.ts`) — line numbers are aligned to code lines and independent of horizontal scroll; cross-line `<span>` from highlight.js is balanced per-line so each row is hover-stable and copy-faithful. (2) **Per-language lazy highlighting** via `loadHljsLanguage` — only the open file's grammar is imported. The switch / if-ladder of literal `import("highlight.js/lib/languages/<name>.js")` branches is what lets webpack code-split each grammar into its own chunk (a Record-driven dynamic import would have bundled all 191 grammars). Bounded work: 32 KiB / 1500 lines; larger files are truncated before highlight and the UI renders an honest `truncated` notice. Unknown languages fall through to a plain monospace view — the contract is total. (3) **Byte-faithful copy** — `endsWithNewline` is tracked across the highlight → split → copy chain so the clipboard text round-trips to the file bytes (`cp file.js file.js.bak; copy in panel; paste back`); line numbers never leak into the copied text. The server labels the file via `EXT_LANGUAGE` (`server/lib/fs-util.js#languageForExtension`); the view does not re-guess. |

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
| Credential-file preview guard | ✅ | slice 16 — basename match against `.env` / `.env.*` / `*.pem` / `*.key` / `id_*` SSH keys / `known_hosts` / `authorized_keys` / `.npmrc` / `.pypirc` / `.netrc` / `.pgpass` / `credentials*` and the backup-suffix set (`.bak` / `.old` / `.orig` / `.backup` / `.save` / `.swp`) returns `403 {code:"credential"}` from `GET /api/fs/read-file` unless `?confirm=1` is appended. The shared predicate (`server/lib/credential-file.js`) is mirrored verbatim in `webapp/lib/credential-file.ts`; `webapp/test/credential-file.test.ts` walks both implementations on the same fixtures so they cannot drift. `GET /api/fs/search` re-uses the same predicate and flags matches with `credential: true` but never omits or returns content; `GET /api/fs/raw` uses the same gate in streaming form. **Slice 27 extends the guard to the write side**: `POST /api/fs/write` applies the same predicate — default-refuse `403 {code:"credential"}`, `confirm:true` releases the write and emits the `credential.override` stderr audit line with `endpoint:"write"` — because a web-editable `.env` over a LAN broadcast makes every LAN peer an author of the local machine's config. The predicate is name-based and therefore **does not defend against hardlink aliasing** — two names that share an inode (`config.txt → .env`) are indistinguishable by basename; the kernel does not expose the "primary" name from the inode. The defence covers symlinks (resolved by `realpathSync`) but not hardlinks. Operators concerned about hardlink aliasing must keep the workspace tree uncluttered. |

## 12. Git panel

| Feature | Status | Why / where |
|---|---|---|
| Workspace status (`git status --porcelain=v1 -b`) | ✅ | `GET /api/git/status` — `server/lib/git.js#gitStatus`. Returns branch + upstream + ahead/behind + per-file `{x, y, path, origPath, staged}`. Non-git directories answer `{ok:false, isRepo:false}` and the panel renders an empty state, not a red toast. |
| Local-branch list + current marker | ✅ | `GET /api/git/branches` — `server/lib/git.js#gitBranches`. `branch --list --format=%(refname:short)`; the leading `* ` (the default `--list` marker) becomes the `current` flag. |
| Single-file diff against HEAD | ✅ | `GET /api/git/diff?dir=&file=` — `server/lib/git.js#gitDiff`. Tries `git diff HEAD -- <file>` first; falls back to `git diff --no-index -- /dev/null <file>` for untracked files (synthetic all-add diff). The `--` separator is the option-injection boundary. |
| Branch switch (destructive, confirmed client-side) | ✅ | `POST /api/git/checkout {dir, branch}` — `server/lib/git.js#gitCheckout`. Branch name matched against `^[A-Za-z0-9._/-]+$` and rejected when it starts with `-`; containment gate enforces an allowed root; `execFile` keeps `git`'s argv literal. |
| Right-panel Git surface (`GitPanel`) | ✅ | `webapp/components/panels.tsx#GitPanel` (slice 03). Current branch + changed-file list with click-to-preview diff; branch switcher with a confirmation prompt; non-git or out-of-root directory shows an empty state. |
| `/review` slash command (TUI parity) | ✅ | `server/lib/interaction/commands.js#bodyReview` + `handleLocalSlash`/`handleCmdCommand`. Emits a `staged / unstaged / untracked` overview into the chat, sourced from the shared `gitStatus` helper. |
| Containment gate shared with `/api/fs/*` | ✅ | `assertWorkspacePath` (server/lib/workspace.js). Every git entry point funnels the requested `dir` through it; out-of-root answers `{ok:false, error:"…不在任何允许根内…"}` and the panel reads `ok` rather than the HTTP code. |
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
