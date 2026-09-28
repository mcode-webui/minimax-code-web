# Web UI

**English** | [简体中文](webui.zh-CN.md)

The Web UI (`packages/webui`) is the browser frontend for MiniMax Code. It uses the same engine as the TUI — the CLI's ACP server (`mcode acp`, JSON-RPC 2.0 over stdio) — so terminal, browser, and desktop clients run against one runtime. Each turn runs over ACP by default; two conditions switch it to the one-shot `mcode exec` CLI (see [Transport selection](#transport-selection-acp-or-exec)). It is not a plugin: it ships inside the repository and is launched by the CLI.

This document describes **what the shipped webui does today, against the source tree**. Every claim links to the file or test that backs it. When something is partial or a placeholder, the row below says so plainly. The shape and limits recorded here come from `packages/webui/{server,webapp}` as of the file-level ages noted in each subsection.

## Launch

```bash
mcode-web                     # http://127.0.0.1:18090
mcode web                     # equivalent — `web` and `webui` both resolve
mcode webui --port 8123 --host 127.0.0.1
mcode webui --token "$(openssl rand -hex 16)" --host 0.0.0.0   # LAN, token-gated
pnpm mcode-web                # from a source checkout (built)
node packages/webui/server.js # direct, from a checkout
```

The command resolves the webui package (installed `dist/webui/` or source `packages/webui/`), spawns the server as a child process, and points it back at the running CLI through `MCODE_WEBUI_SELF_ENTRY`. The webui then spawns `node <cli> acp` per active browser tab.

Without `--port` the server starts on 18090 and moves to the next free port when 18090 is taken, logging the URL it bound — the launcher opens that one. An explicit `--port` (or `PORT`) is pinned: it never moves, so a taken port exits with EADDRINUSE instead. (See `packages/webui/server/lib/config.js#PORT` and the launcher in `packages/webui/server.js`.)

## Running a development build

The development Web UI runs alongside an installed official mcode without
conflicts: the dev webui always spawns the checkout's own `dist/cli.js` as its
engine (detection order: `MCODE_CMD` > `MCODE_WEBUI_SELF_ENTRY` > repo
`dist/cli.js` > `~/.minimax-code` > PATH), and it shares the host's
`~/.minimax` sessions and `~/.mcode-webui` state.

From a checkout of this repository:

```bash
corepack pnpm install && corepack pnpm build   # once, and after engine changes
node dist/cli.js webui                         # dev Web UI on 127.0.0.1:18090
node dist/cli.js webui --port 8123             # keep the installed one free
```

### One-shot dev launcher (frontend + backend, hot reload)

When iterating on the Next.js frontend in `packages/webui/webapp/` you want both
the Node backend (port 18090, serves `/api/*`) and the Next dev server (port
18091, with HMR, proxies `/api/*` → 18090) running at once. `pnpm run webui:dev`
boots both in a single shell, prefixes their output so you can tell which side
is talking, and tears them down together on Ctrl+C:

```bash
pnpm run webui:dev        # http://127.0.0.1:18091/  ← open this in the browser
```

It is a thin wrapper over `node scripts/dev-webui.mjs` with no extra
dependencies. Stop the official `mcode` runtime first if port 18090 is busy
(`pkill -f "dist/cli.js webui"`), or pass `--port 28090` to `mcode webui` and
export `MCODE_WEBUI_ORIGIN=http://127.0.0.1:28090` so the dev proxy targets
the right backend.

### Day-to-day webui commands (Next-aligned)

| Command                  | What it does                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `pnpm run webui:dev`      | Start both the backend (`:18090`) and Next dev (`:18091`, HMR) together; Ctrl+C cleans up both. |
| `pnpm run webui:build`    | `next build` the webapp (`packages/webui/webapp/out/` is the static export).                       |
| `pnpm run webui:start`    | Serve the already-built webui via `node packages/webui/server.js` on `:18090` (no HMR).          |
| `pnpm run webui:typecheck`| `tsc --noEmit` over the webapp's TS sources.                                                      |
| `pnpm run webui:test`     | Run all webui unit tests — backend (`test:webui`) + frontend (`test:webapp`).                     |

`next start` is intentionally omitted: the webui ships as a `next export` static
build and the backend serves those files directly, so there is no Next server
runtime to start. ESLint is also not wired into the webapp yet — add it via
`npx next lint` once a `.eslintrc` is in place.

### Docker

The repository's Docker setup runs the branch in a **clean environment**: no
host home directories are mounted, so host models/tools/sessions never leak in
(and container state never leaks out). Model credentials come from the
environment — each collaborator tests with their own key:

```bash
MINIMAX_CN_API_KEY=...  docker compose up webui   # MiniMax cn region
MINIMAX_API_KEY=...     docker compose up webui   # MiniMax global region
# open http://localhost:18080/?token=dev-token
docker compose down                                # reset to factory state
```

The image runs as a non-root `user` (uid 1000) with a realistic home at `/home/user` (Desktop/Documents/Downloads/Pictures/Music/Videos/projects + XDG config), so the directory picker's well-known-folder keywords behave as on a desktop. `docker/entrypoint.sh` seeds a fresh in-container `~/.minimax/config.yaml`
(`minimaxModelSource: minimax_api_key` + the key + `minimax_api/MiniMax-M3`
as the default model); `MAVIS_REGION` is derived from which variable you set
and can be overridden explicitly. Because the host browser is a non-local
client from the container's perspective, every URL carries `?token=…`
(`WEBUI_TOKEN`, default `dev-token`); the port is `WEBUI_PORT` (default
18080). A container without either key variable starts fine but chat has no
model credentials until one is provided.

For interactive development over the mounted source (same env-key flow):

```bash
docker compose run --rm -p 18080:18080 dev
# inside the container:
pnpm install --no-frozen-lockfile && pnpm build
node dist/cli.js webui --host 0.0.0.0 --no-open   # PORT defaults to 18080
```

## Security posture

- Loopback bind by default; LAN exposure requires `--host`/`HOST` env or the persisted `lanBind` setting.
- Trusted-origin CORS + a browser Origin/CSRF gate that applies even to loopback requests.
- Token auth (`?token=` / `Authorization: Bearer`) for non-local requests; local requests bypass.
- Read-only mode for non-local sessions; per-request `authorize()` gate with fail-closed audit; rate limiting; workspace containment; bounded uploads; no telemetry.
- **Credential-shaped file previews are refused by default** (slice 16). A basename match against `.env` / `.env.*`, `*.pem` / `*.key`, `id_rsa` / `id_ed25519` / `id_ecdsa` / `id_dsa`, `known_hosts`, `authorized_keys`, `.npmrc`, `.pypirc`, `.netrc`, `.pgpass`, `credentials*`, plus the backup-suffix set (`.bak` / `.old` / `.orig` / `.backup` / `.save` / `.swp`) returns HTTP `403 {code: "credential"}` from `GET /api/fs/read-file`. The webapp renders a "仍要打开？" second-confirmation; reopening the same URL with `?confirm=1` gets the plaintext. The shared predicate lives in `packages/webui/server/lib/credential-file.js` and is mirrored verbatim in `packages/webui/webapp/lib/credential-file.ts`; the test suite (`packages/webui/webapp/test/credential-file.test.ts`) walks both implementations on the same fixtures so they cannot drift. Tree listing, `/api/fs/search`, and OS-default open/reveal do not bypass the gate, but they are not plaintext previews and remain available — search flags matches (`credential: true`) but never returns contents. The predicate is name-based and therefore **does not defend against hardlink aliasing** (two names that share an inode — e.g. `config.txt → .env` — are indistinguishable by basename; the kernel does not expose the "primary" name from the inode). The defence covers symlinks (resolved by `realpathSync`) but not hardlinks — operators concerned about hardlink aliasing must keep the workspace tree uncluttered.

The canonical disclosure is [`packages/webui/references/SECURITY-NOTES.md`](../packages/webui/references/SECURITY-NOTES.md).

## Transport selection (ACP or exec)

Every turn is sent to the engine over one of two transports. The choice is made server-side, per turn, before the engine spawns — and it is decided in two different places, evaluated in this order:

1. `process.env.MCODE_USE_ACP === "0"` forces the exec transport (`packages/webui/server/routes/chat.js#handleSend`; the code comment there calls it the escape hatch for an ACP protocol regression). This is the only read of the variable in the codebase.
2. Otherwise the turn is handed to `runMcodeAcp` (`packages/webui/server/lib/mcode-acp.js`), which **silently re-routes to `runMcodeExec`** in its first branch when `cs.permissions` is set and is anything other than `"Full access"`.
3. Only when neither applies does the turn actually run over ACP.

| Turn condition | Transport | Decided at |
| --- | --- | --- |
| `MCODE_USE_ACP=0` in the server environment | exec | `routes/chat.js#handleSend` |
| `cs.permissions` is `Ask`, `Auto`, or `Read` (not `Full access`) | exec (silent re-route) | `mcode-acp.js#runMcodeAcp` |
| otherwise — factory default is `permissions: "Full access"` (`server/lib/state-bus.js` initial state) | ACP | `mcode-acp.js#runMcodeAcp` |

Contract notes:

- **There is no `/exec` command.** The webui-local command set is `WEBUI_LOCAL_COMMANDS` — `new`, `clear`, `status`, `sessions`, `usage`, `help`, `stop` (`server/lib/acp-client.js`). Transport is never switched by a slash command; the two conditions above are the whole rule.
- The permission mode is selectable in the composer (Ask / Auto / Full access; `webapp/components/composer.tsx#PERMISSION_MODES`) or via `POST /api/permissions`, which also accepts `read`. The route writes the label into `cs.permissions` unconditionally (`server/routes/model.js#handleSetPermissions`) — that label is what steers the **next** turn's transport.
- An exec turn is not a degraded permission mode: the mode still reaches the engine as the `--permission` spawn flag (Ask→`ask`, Auto→`auto`, Read→`read`, else `full`; the mode mapping in `mcode-exec.js`), the session continues via `--session`, and the recorded model is passed via `--model`.
- A live exec child has no RPC surface: `session/set_config_option` calls (model, permission) return `no_acp_session` and take effect on the next turn (`server/lib/mcode-rpc.js#noLiveClientFailure`); the same call lands on the live child immediately on an ACP turn. Warning semantics are documented in [`packages/webui/docs/API.md`](../packages/webui/docs/API.md) under `POST /api/permissions`.

Known costs of an exec turn — all of these are current behaviour of this tree, not planned fixes:

- No tool-call lines: `collectExecResult` consumes only `delta` / `message` / `exec.result` stream events, so `→` tool rows never appear (the ACP path renders them via `applyToolUpdate`).
- The thinking-effort pick is not transferred: `applyRecordedModel` runs only on the ACP path, and `buildExecArgs` has no thinking flag — the engine runs its own default.
- No session-title write-back: `getMcodeSessionTitle` is called only in the ACP finalize path.
- No interactive channel: the child's stdin is closed immediately after the prompt is written, so engine-side questions cannot reach the browser; questionnaire-type turn errors surface as alerts with a hint to re-ask via the composer (`routes/chat.js#handleSend` error branch).

This section records what the current source tree does, not a frozen contract. During a turn the two transports are distinguishable in the process list: an `mcode … acp` child is an ACP turn, an `mcode … exec --input -` child is exec. The operator-facing view — when you hit each transport, what it costs, and what to do — is the transport section of [`webui.zh-CN.md`](webui.zh-CN.md).

## Thinking levels (which models can be tuned, and how)

The composer mounts a thinking control only for models whose `/api/models` entry carries `thinkingLevels`. A model with no list never shows one — by design, a no-op control is worse than none. Where the list comes from, and what a pick actually does on the wire, depends on which of the engine's two thinking schemas describes the model:

| Model kind | `thinkingLevels` | A pick travels as |
| --- | --- | --- |
| Provider catalogue with `thinking.effortOptions` (custom providers, `MiniMax-M3.1-Flash-Preview`) | the engine's effort list, verbatim (e.g. `default/low/medium/high/xhigh/max`); thinking itself cannot be turned off (engine marks the model `forced_on`), only the depth is pickable | `session/set_config_option{configId:"thinkingEffort"}` after the model selection |
| Switchable builtin (`thinking_config.mode: switchable` + on/off variants, today `MiniMax-M3`) | `["off","on"]` — a two-state toggle, never a depth scale | one `set_config_option{configId:"model"}` whose value carries the variant (`m:minimax_api:MiniMax-M3:v:none-thinking` / `:v:thinking`) |
| `forced_on` with no effort dimension (`MiniMax-M2.7`, `MiniMax-M2.7-highspeed`) | absent — no control | n/a |

Why two channels: the engine's `thinkingEffort` option only accepts values the selected model advertises as `effortOptions`. A switchable builtin has none — the engine rejects every effort value for it (`Thinking effort is not advertised for the selected model`). Its on/off state is the model *variant* dimension, so the webui folds the level into the model selection. `variantChannelFor` (`server/lib/engine-catalogue.js`) derives the level→variant map from the engine's own variant tree (which variant disables thinking), never from hard-coded names.

Source of the builtin metadata: the engine materialises its builtin catalogue into `<engine data dir>/config.yaml` under `provider.minimax.models` (with `thinking_config`, `variants`, `thinking.effortOptions`). `GET /api/models` reads that tree on every request (`readEngineBuiltinThinking`) and annotates both the builtin shell entries and the engine-session wire-form entries — the latter because `applyConfigOptionUpdate` mirrors the engine's wire-form `currentValue` into `cs.model.name` outside the pick window, and the composer matches the active model by id.

Contract details:

- `POST /api/set-model` `{model, thinking?}` records `thinking` in `cs.model.thinking` whatever the channel; `thinkingSynced` reports the pick actually reaching the engine — for the variant channel it is the model push carrying the level, and `mcodeSynced`/`thinkingSynced` describe that one push from both angles.
- Session boot replays the pick (`applyRecordedModel`): effort models push model-then-effort; variant models push one variant-carrying model selection and skip the effort push. A stale recorded level that the new model does not list is cleared by the composer on model switch (ticket 11 wire half).
- `default_value` from `thinking_config` is not a response field. The control's initial state is "Use engine default" (`thinkingPicker.none`) until the user picks; for variant models an unpicked boot selects the engine's default variant (`default_value: 'true'` → thinking on).
- Engine-session entries appear in variant wire form (`m:...:v:thinking` / `:v:none-thinking`) because that is what the engine advertises for switchable models; both carry the same `thinkingLevels`.
- A pick while a turn is running takes effect on the next turn (same semantics as a model switch mid-run).
- An operator's providers-config entry with the same id as a builtin wins wholesale (existing merge rule); such an entry shows levels only if the operator wrote them.

The operator-facing view — which models show what control, and why MiniMax-M3 only has on/off — is the thinking section of [`webui.zh-CN.md`](webui.zh-CN.md).

## File tree (delivered UI)

Every shipped file tree, panel and column evidence is `grep`-able. The list
below cites the component file and one `data-testid` per surface.

| Surface | Component | Anchor `data-testid` |
| --- | --- | --- |
| Sidebar (rail) | `components/shell.tsx` | `sidebar-scroll-viewport` |
| Sidebar session tree | `components/session-tree.tsx` | `sidebar-session-row` |
| Sidebar context/usage popover | `components/shell.tsx` | `sidebar-user-usage-popover` |
| Sidebar inbox (alerts flyout) | `components/inbox.tsx` | `inbox-flyout` |
| Toolbar (top bar with model selector) | `components/toolbar.tsx` | `toolbar-session-status` |
| Composer + drop overlay | `components/composer.tsx` | `composer-drop-overlay`, `composer-send-button` |
| Chat (virtual list ≥ 200 messages) | `components/chat.tsx` + `chat-virtual-list.tsx` | `chat-virtual-top-spacer` |
| Turn summary / disclosure | `components/chat.tsx` | `turn-process-disclosure` |
| Activity group (collapsible tool turns) | `components/chat.tsx` | `activity-group-header` |
| File preview (right preview column body) | `components/file-preview.tsx` + `file-preview-pane.tsx` | `file-preview` |
| File tree column (column 4) | `components/workspace-tree-column.tsx` + `panels.tsx#FilesPanel` | `files-tree-root` |
| File tree search (server-driven, slice 19a; wired in 19b) | `components/panels.tsx` | `files-tree-filter` |
| Sidebar tree-column "搜索" surface (slice 19b) | `components/workspace-tree-column.tsx#SearchSurface` | `tree-surface-search-input` |
| Code preview (slice 22 IDE-grade: gutter + lazy hljs + byte-faithful copy) | `components/code-view.tsx` | `code-view` (rendered inside `file-preview`) |
| Three-state appearance picker (slice 18) | `components/appearance-card-picker.tsx` | `appearance-card-picker` |
| Git panel (slice 03) | `components/panels.tsx#GitPanel` | `git-panel` |
| Browser panel (slice 04, sandboxed iframe over `/api/fs/raw`) | `components/browser-panel.tsx` | `browser-panel` |
| Workspace picker (modal) | `components/workspace-picker.tsx` | `workspace-picker` |
| Provider management | `components/provider-management.tsx` | `providers-panel` |
| Context meter / panel | `components/context-meter.tsx` | `context-meter` |
| Settings modal | `components/panels.tsx#SettingsModal` | `settings-modal` |
| Error boundaries (global + per-route) | `app/error.tsx` + `app/global-error.tsx` | `global-error-page` |

## Four-column workspace (main, slices 17 + 21)

On the right side of the sidebar, the shell renders a flex row that can
hold up to three **visible columns**: `conversation | preview | tree`. The
sidebar is owned by `AppShell`, lives outside the row, and is allocated
zero width inside the wrapper (`workspace-tabs-state.ts:738-744`).

### Column widths — the source of truth

Every width number below comes from `COLUMN_SPECS` in
`packages/webui/webapp/lib/workspace-tabs-state.ts:412-456`. Change a
default here, and the corresponding `DEFAULT_COLUMN_LAYOUT` follows;
change a `minWidth` / `maxWidth`, and `clampWidth`
(`workspace-tabs-state.ts:511-515`) plus `computeColumnLayout`
(`workspace-tabs-state.ts:724-854`) pick it up on the next render.

| Column | Role | Default | Min | Max | Flow |
| --- | --- | --- | --- | --- | --- |
| `sidebar` | AppShell chrome — outside the column row | 240 | 220 | 400 | fixed |
| `conversation` | Elastic — absorbs leftover, never caps the growth path | 720 | 280 | 2400 | fluid |
| `preview` | On demand — viewing surface (`file:<path>`, `browser`) | 400 | 320 | 720 | fixed |
| `tree` | On demand — navigation surface (`files`, `git`, `tasks`, `search`, `plugins`) | 340 | 320 | 600 | fixed |

The only `maxWidth` that does **not** cap what the user actually sees on
screen is `conversation.maxWidth = 2400`. It bounds the value the user
can write into the layout by dragging the divider
(`workspace-tabs-state.ts:511-528`); the layout algorithm explicitly
ignores it and lets `conversation` absorb every leftover pixel after
the fixed columns have grown to their caps
(`workspace-tabs-state.ts:805-823`, commentary at `:438-443` and
`:702-720`). `COLUMN_SPECS.conversation.maxWidth` is therefore **not**
a viewport ceiling — past 1920 the column just keeps growing, and the
readable measure on the chat content (960 px, centred —
`components/chat.tsx:38-52`, applied at `:255` and `composer.tsx:532`)
takes over the visual constraint.

### What the layout algorithm does, in invariant form

`computeColumnLayout` (`workspace-tabs-state.ts:724-854`) is a pure
function that returns a `ColumnLayoutSummary`. The flow is:

1. Each column starts at its stored width (clamped to its `[min, max]`
   band). `conversation`'s stored width is the user's drag target;
   `preview` / `tree` start at 0 when collapsed (slice 21 on-demand
   model — `workspace-tabs-state.ts:494-504`).
2. **Overflow** → fixed columns shrink toward their minimums in the
   order `preview → tree`. If still over, `conversation` shrinks
   toward its minimum (280). Last resort: `conversation` shrinks below
   its minimum and the renderer hides it.
3. **Leftover** → fixed columns grow toward their maximums in the
   order `tree → preview` (the fold order reversed). Whatever is left
   after that goes to `conversation`, **unconditionally** — slice 25
   removed the previous growth-path ceiling, and the source comment
   pins the decision (`workspace-tabs-state.ts:805-823`).

Two invariants follow directly:

- **Row sums to exactly the container width**, every render (modulo
  zero-width hidden segments). No dead gutter is reachable.
- **When `conversation` is the only visible column, its rendered width
  stays ≥ 280 px whenever the container can fit 280 px** — the fold
  ladder in step 2 shrinks `preview` and `tree` first, so `conversation`
  only shrinks past 280 when nothing else gives. At very narrow
  viewports the renderer hides it entirely
  (`workspace-tabs-state.ts:774-780`).

### Idle path — what the user sees at common viewports

When both `preview` and `tree` are closed (the shipped default on first
paint — `workspace-tabs-state.ts:494-504`), `conversation` absorbs
every pixel the row has after `sidebar` has taken its default 240 px.
The conversation width is therefore `viewport − sidebar`, a computed
remainder, **not** a configured cap:

| Viewport | Sidebar | Conversation (idle) | Notes |
| --- | --- | --- | --- |
| 1280 px | 240 | **1040** | `1280 − 240` |
| 1920 px | 240 | **1680** | `1920 − 240` |
| 2560 px | 240 | **2320** | `2560 − 240` |

The chat content's 960 px centred measure (`components/chat.tsx:38-52`,
applied at `:255` and `composer.tsx:532`) is a hard CSS cap on the
content, not a threshold on the column. As soon as the column reaches
960 px the cap starts biting: the content stays at 960 and the slack
above it splits evenly between left and right inside the column. The
column itself keeps absorbing leftover up to the algorithm's only
limit, which is the container width.

### Fixed columns open — what gets the leftover

When at least one fixed column is open, leftover after the user's
stored widths flows into the fixed columns first, bounded by their
`maxWidth`s (`workspace-tabs-state.ts:793-815`). At a 1920 px viewport
with both fixed columns open at their defaults, the container is
`1920 − sidebar 240 = 1680` — the same `1680` figure the idle table
and the "only preview" example use (`workspace-tabs-state.test.ts:1028`).
The stored widths (`preview` 400, `tree` 340, `conversation` 720) sum to
**1460**, so:

- container leftover = `1680 − 1460 = 220`
- `tree` grows 340 → **560** (eats 220 px, falling short of its 600 max
  because that is all the leftover there is)
- `preview` stays at **400** (no leftover left)
- `conversation` ends at its stored **720** — no leftover reaches it

If only `preview` is open at 1920, `tree` is skipped (collapsed). The
container is still `1680`; the stored widths sum to **1120**, so the
leftover is `560`:

- `preview` grows 400 → **720** (its max, eats 320 px)
- `conversation` absorbs the remaining **240 px** on top of its stored
  720 → ends at **960** (the locked value in
  `workspace-tabs-state.test.ts:1077`).

Drag behaviour on `conversation` itself is bounded by `[280, 2400]` via
`clampToConversation` (`workspace-tabs-state.ts:856-861`); the
algorithm may then re-distribute any overflow into `preview` first
(`workspace-tabs-state.ts:747-762`).

Each column hosts its own independent `activeId` (`previewActiveId`,
`treeActiveId`) so opening a tree surface does not steal focus from the
preview column, and vice versa. The surface vocabulary
(`SurfaceTabKind`) is six values — `files | git | tasks | search |
plugins` on the tree side, `browser | file:<path>` on the preview side
— and is the single source of truth in
`lib/workspace-tabs-state.ts#SURFACE_TAB_KINDS`. **The sidebar's
"搜索" surface is real as of slice 19b** — the
`SearchSurface` component in `workspace-tree-column.tsx` wires a
200 ms-debounced request to `GET /api/fs/search` (`api.searchFs`),
reuses the same `searchFootSegments` footer as the file-tree filter
(scanned / matches / skipped / truncated / budget), and on click
sends an expand-to-hit request through the shared `fs-tree-reveal`
channel so the file tree panel applies the same expand + highlight.
**The "插件" surface is still a placeholder** (`PluginsSurface`) —
the engine has not yet shipped the plugin-install contract; the
surface renders an i18n "this is coming" card rather than a silent
no-op.

Surface kinds go through `openSurfaceTab("…")`; the right-panel kinds
(`PanelKind`) are a separately-trimmed union: `"workspace" | "files" |
"git" | "plugins" | "browser"`. The previously-shipped `search`, `alerts`,
and `progress` kinds have been **removed from the `PanelKind` union**
(`packages/webui/webapp/lib/persist.ts#PanelKind`); `alerts` is reached via
the separate bell-icon `InboxFlyout` component, and `progress` had no live
entry point at all.

Dividers between columns are 8 px wide and support drag-resize (clamped
to `[minWidth, maxWidth]` per column) and double-click reset.

### Code preview (slice 22, IDE-grade)

The file preview tab uses `components/code-view.tsx` (`data-testid`
`file-preview`). It layers three slice-22 affordances on top of the
plain `<pre>` view that shipped in slice 02:

- **Line-number gutter**, aligned to code lines and independent of
  horizontal scroll — line numbers never move when the user scrolls
  right on a long line. `splitHighlightedLines` (`webapp/lib/code-highlight.ts`)
  walks the highlight.js HTML output and balances any `<span>` that
  crossed a line boundary, so each line is hover-stable and copy-faithful.
- **Per-language lazy syntax highlighting**. The grammar for the open
  file's language is the only grammar loaded — `loadHljsLanguage` is
  a switch / if-ladder of literal `import("highlight.js/lib/languages/<name>.js")`
  branches so webpack code-splits each grammar into its own chunk (the
  alternative — a Record-driven dynamic import — would have bundled
  all 191 grammars). Unknown or unloaded languages fall through to a
  plain monospace view (the contract is total: bad inputs must not
  blow up). The hard byte cap is **32 KiB** with a **1500-line**
  cap; larger files are truncated before the highlight step so a
  multi-megabyte file cannot freeze the tab, and the UI renders an
  honest `truncated` notice. The map is in `LANGUAGE_TO_HLJS` —
  `html` is an alias of `xml`, `jsonc` shares `json`, and `toml` /
  `plain` deliberately have no entry (the caller treats them as plain
  monospace).
- **Byte-faithful copy**. The copy path restores the trailing
  newline (`endsWithNewline` is tracked across the highlight → split
  → copy chain so the clipboard text round-trips to the file bytes
  for `cp file.js file.js.bak; copy in panel; paste back`) and never
  leaks the gutter line numbers into the copied text.

## Markdown rendering and Mermaid diagrams (slice 23)

Assistant messages and Markdown file previews render through
`webapp/lib/markdown.ts` (`marked`, already a workspace dependency — no
CDN). A fenced code block whose language token is `mermaid` renders as a
diagram instead of a code block. The behaviour is a contract, not an
implementation accident:

| Aspect | Contract | Backed by |
| --- | --- | --- |
| Fence language | The bare token after the fence opener must be `mermaid`, case-insensitive; trailing metadata (```` ```mermaid {theme: dark} ````) still matches | `webapp/lib/markdown.ts:133-136` |
| Renderer seam | Fence languages dispatch through a language→renderer registry; the markdown main flow never branches on a language name. Any other fence language can be taken over the same way — one `registerLanguageRenderer(...)` call. That is the seam a future `minimax-code-plugin` renderer will install through | `webapp/lib/markdown.ts:54-113`, `webapp/lib/mermaid-renderer.ts:64-71` |
| Theme | Diagrams re-render when the app switches light/dark: the host watches `<html>`'s class and mermaid is re-initialised per theme | `components/markdown-html.tsx:52-66`, `components/mermaid-block.tsx:156-166` + `223-229` |
| Failure state | A syntax error does not blank the page. The failing diagram shows its error text plus the **original source in a copyable `<pre>`** — the copy round-trips byte-exact, including `-->|label|` edge syntax — and the rest of the document renders normally. (If the chart library itself fails to load — offline, say — the same failure card appears with the source still copyable. If a language renderer throws, the fence falls back to the plain code block — same "never blank the document" rule at the parser level.) | `components/mermaid-block.tsx:285-307`, `components/markdown-html.tsx:183-230`, `webapp/lib/markdown.ts:149-165` |
| Sizing | Diagrams scale to the column width; a diagram wider than its card scrolls inside the card | `webapp/styles/mermaid.css:62-80` |
| CJK labels | Node and edge labels render through a font stack with PingFang SC / Microsoft YaHei / Noto Sans CJK SC fallbacks, so Chinese text does not come out as tofu | `components/mermaid-block.tsx:109` |
| Loading | The chart library is several megabytes and is `import()`-ed when the **first** diagram of a page mounts; the chunk ships with a one-year immutable cache, so later page loads fetch it from the browser cache. A page with no mermaid fence never requests the chunk | `components/mermaid-block.tsx:54-66`, `server/lib/static.js:64-66` |
| Outline | A diagram is never a heading: the fence emits a `<pre>`/`<div>` placeholder pair, not `h1`–`h6`, so diagrams appear in no heading-derived outline (the webui itself renders no Markdown outline today) | `webapp/lib/mermaid-renderer.ts:44-57` |

The `mermaid` dependency (11.12.1, MIT) is recorded in
`release/dependency-licenses.json`.

## Persistence keys (client-side `localStorage` / `sessionStorage`)

| Key | Channel | Owner | Introduced by | Shape |
| --- | --- | --- | --- | --- |
| `webui:ui:v1:<cid>` | `localStorage` | `webapp/lib/persist.ts#uiStateKey` | slice 07 (reopen state) | `{version:1, cid, state:{panel, panelTab, sidebarCollapsed, lastSessionId, appearance}}` — `appearance` (slice 18) is the three-state picker choice (`"light" \| "dark" \| "system"`); `applyAppearance` writes through this envelope |
| `webui:scroll:v1:<cid>:<sessionId>` | `localStorage` | `webapp/lib/persist.ts#scrollKey` | slice 07 | `{version:1, cid, sessionId, scrollTop, savedAt}` |
| `webui:workspace-tabs:v1:<cid>` | `localStorage` | `webapp/lib/persist.ts#workspaceTabsKey` | slice 15 (workspace columns) | version-discriminated state (`WORKSPACE_TABS_VERSION`) — see `lib/workspace-tabs-state.ts` |
| `webui:open-file:path` | `localStorage` | `webapp/lib/open-file.ts#STORAGE_KEY` | slice 12 (file preview) | bare path string or absent |
| `webui:files-tree:<workspaceDir>` | `sessionStorage` | `webapp/components/panels.tsx` (slice 01) | slice 01 (file tree) | `{version:1, workspace, expanded[], filter, showHidden}` |

All keys share the `webui:` prefix and are best-effort writes (debounced
150 ms for `ui` and `workspace-tabs`; immediate for the others). A failed
write leaves the in-memory state correct and the persistence silent — the
failure mode we care about is the `app/global-error.tsx` crash, not a quota
error here. Per-session scroll keys are deliberate: a refresh restores
the user's place in each conversation independently.

## Endpoint catalog (against current source)

Every `/api/*` endpoint listed below is registered either by Hono
(`packages/webui/server/app.js`) or by the legacy dispatcher
(`packages/webui/server/router.js`); the file path is the implementation
of record. `OWNED_ROUTES` (Hono) is the ledger (60 routes), and the legacy
dispatcher owns the two SSE channels (`/api/events`, `/api/alerts`) plus
the static + trajectory mounts.

### Hono-owned routes (`server/app.js` — `OWNED_ROUTES`)

| Method | Path | Handler file | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/health` | `routes/health.js` | `200` `{ok, port, defaultModel, defaultWorkspace, mcodeCmd, mcodeVersion, maxConcurrent}` |
| `GET` | `/api/account` | `routes/account.js` | `200` engine-projected card; `{ok:false, reason:"no_client"\|"rpc_error"\|"account_unavailable"}` when the engine hasn't answered |
| `GET` | `/api/state` | `routes/state.js` | full `state` projection (snapshot) |
| `GET` | `/api/sessions` | `routes/sessions.js#handleListSessions` | merged webui + mcode session list |
| `POST` | `/api/sessions` | `routes/sessions.js#handleNewSession` | creates a webui session record |
| `POST` | `/api/sessions/switch` | `routes/sessions.js#handleSwitchSession` | swaps the active conversation |
| `POST` | `/api/sessions/rename` | `routes/sessions.js#handleRenameSession` | retitles a session (B03 authorize-gated) |
| `GET` | `/api/sessions/search` | `routes/sessions.js#handleSearchSessions` | cross-workspace fuzzy search (B03 authorize-gated) |
| `POST` | `/api/sessions/cleanup-orphans` | `routes/sessions.js#handleCleanupOrphans` | drops mcode sessions no webui record references (`scope=orphans\|all`) |
| `DELETE` | `/api/sessions/:id` | `routes/sessions.js#handleDeleteSession` | B03 authorize-gated; deletes from webui + mcode sqlite |
| `GET` | `/api/session-tree` | `routes/sessions.js#handleSessionTree` | sidebar tree projection |
| `GET` | `/api/acp-sessions` | `routes/sessions.js#handleAcpSessions` | mcode acp session list |
| `GET` | `/api/acp-session-title` | `routes/sessions.js#handleAcpSessionTitle` | title helper for `?sid=...` |
| `GET` | `/api/sessions/:id/export` | `routes/export.js` | `?format=md\|json[&download=true]`; `400` on bad format; `403` on authorize decline; `404` on missing session |
| `POST` | `/api/send` | `routes/chat.js#handleSend` | fire-and-forget; `200 {ok}`; `400 content required`; `409 {reason:"cid-busy"\|"session-busy"\|"at-capacity", running?, limit?}` |
| `POST` | `/api/stop` | `routes/chat.js#handleStop` | `200 {ok, wasRunning, cancelled, hardKilled, note}` |
| `POST` | `/api/cmd` | `routes/chat.js#handleCmd` | webui button-driven commands |
| `POST` | `/api/usage` | `routes/usage.js#handleUsage` | record-only + projection |
| `POST` | `/api/usage-trigger` | `routes/usage.js#handleUsage` | alias kept for legacy clients |
| `GET` | `/api/usage-real` | `routes/usage.js#handleUsageReal` | real-token snapshot |
| `POST` | `/api/refresh` | `routes/usage.js#handleRefresh` | force a refresh |
| `GET` | `/api/usage/forecast` | `routes/usage.js#handleForecast` | linear + Huber extrapolation of exhaustion time |
| `POST` | `/api/workspace` | `routes/workspace.js#handleWorkspace` | `{ok, error}` of the workspace change |
| `GET` | `/api/workspace/browse` | `routes/workspace.js#handleWorkspaceBrowse` | `?path=<abs>`; `400` on bad path |
| `GET` | `/api/workspace/tree` | `routes/workspace.js#handleWorkspaceTree` | full workspace → sessions tree |
| `GET` | `/api/workspace/resolve` | `routes/workspace.js#handleWorkspaceResolve` | `?name=<folder>` → candidate absolute paths |
| `GET` | `/api/workspace/recent` | `routes/workspace.js#handleWorkspaceRecent` | `?search=&limit=` (limit clamped ≤ 20) |
| `GET` | `/api/fs/read` | `routes/fs.js#handleFsRead` | `?path=&showHidden=1`; containment gate; `400` missing path |
| `GET` | `/api/fs/read-file` | `routes/fs.js#handleFsReadFile` | `?path=&confirm=1`; `200` text/JSON; `403 {code:"credential"}` on a credential shape (unless `confirm=1`); `413` oversize (fs-util `DEFAULT_FILE_READ_MAX = 512 KiB`); `415` binary / non-regular |
| `GET` | `/api/fs/raw` | `routes/fs.js#rawStreamToWebResponse` | `?path=&download=1&confirm=1`; streaming 20 MiB cap; same credential gate; mime-by-extension table including `.html/.htm`, `.svg`, `.png/.jpg/.gif/.webp`, `.js/.mjs/.css/.json` |
| `POST` | `/api/fs/mkdir` | `routes/fs.js#handleFsMkdir` | `{path}`; parent in allowed roots; `403` on containment fail |
| `POST` | `/api/fs/open-default` | `routes/fs.js#handleFsOpenDefault` | `{path}`; `400 {code:"missing-path"}` / `403 {code:"out-of-bounds"}` / `400 {code:"not-a-regular-file"}` / `503 {code:"no-opener"}` / `502 {code:"spawn-failed"}` |
| `POST` | `/api/fs/reveal` | `routes/fs.js#handleFsReveal` | `{path}`; same code → status map as `open-default` |
| `GET` | `/api/fs/search` | `routes/fs.js#handleFsSearch` | `?root=&q=&depth=&maxNodes=&wallMs=&limit=&includeHidden=1`; `400 {code:"missing-root"\|"missing-q"\|"not-a-directory"\|"stat-failed"}`; success envelope: `{ok, root, q, matches:[{path,name,type,ancestors,credential?,credentialReason?}], scanned:{dirs,files,total}, skipped:{node_modules,n,.git,n,credential,n,huge,n,optional:{dist,build,…}}, truncated, truncatedReason: null\|"depth"\|"nodes"\|"wallClock"\|"matches", elapsedMs, budgets}`. Walker defaults: `maxDepth=8`, `maxNodes=5000`, `wallMs=1500`, `maxMatches=200`; absolute limits: `16/50_000/5_000/1_000` (`packages/webui/server/lib/fs-search.js`). `node_modules` and `.git` are non-overridable skips. |
| `GET` | `/api/git/status` | `routes/git.js#handleGitStatus` | `?dir=`; `400 {error:"missing dir"}` |
| `GET` | `/api/git/branches` | `routes/git.js#handleGitBranches` | `?dir=`, leading `* ` → `current` flag |
| `GET` | `/api/git/diff` | `routes/git.js#handleGitDiff` | `?dir=&file=`; `400 {error:"missing dir/file"}`; falls back to `--no-index` for untracked |
| `POST` | `/api/git/checkout` | `routes/git.js#handleGitCheckout` | `{dir, branch}`; branch allow-list `^[A-Za-z0-9._/-]+$` + leading-dash guard; `400 {error:"missing dir/branch"}`; `413 {code:"BODY_TOO_LARGE"}` on cap |
| `GET` | `/api/settings` | `routes/settings.js#handleGetSettings` | full settings projection |
| `POST` | `/api/settings` | `routes/settings.js#handlePostSettings` | `500 {error:"audit write failed"}` if event log fails; B03 authorize gates within the handler |
| `POST` | `/api/auth/decision` | `lib/authorize.js#handleAuthDecision` | `{requestId, approve}`; `200` resolved; `404` no such pending request; `400` bad body; idempotency guard via resolved-set delete |
| `POST` | `/api/upload` | `routes/upload.js` | multipart required; `400` if not; `413 {code:"UPLOAD_REQ_TOO_LARGE"\|"UPLOAD_FILE_TOO_LARGE"\|"UPLOAD_QUOTA_EXCEEDED"}`; `400 {code:"UPLOAD_MALFORMED"\|"UPLOAD_ABORTED"}`; write-ahead audit `upload.create.intent` before disk, `upload.create` after; `200 {ok, path, name, size}` |
| `GET` | `/api/models` | `routes/model.js#handleGetModels` | engine model + webui label/limit projection; `thinkingLevels` from both engine thinking schemas (effort list verbatim, switchable builtins as `["off","on"]`) |
| `POST` | `/api/set-model` | `routes/model.js#handleSetModel` | `{model, thinking?}`; `400` on empty; effort models push model+`thinkingEffort`, variant models fold the on/off level into one model selection |
| `POST` | `/api/permissions` | `routes/model.js#handleSetPermissions` | `{mode}`; mapped to engine mode via `WEBUI_TO_MCODE_PERMISSION` |
| `GET` | `/api/permissions-modes` | `routes/model.js#handleListPermissionModes` | engine's current `availableModes` |
| `POST` | `/api/answer` | `routes/model.js#handleAnswer` | ask-user modal answer |
| `GET` | `/api/providers` | `routes/providers.js#handleGetProviders` | masked catalogue |
| `PUT` | `/api/providers` | `routes/providers.js#handlePutProviders` | full replace; `400` on validate, `500` on write failure |
| `POST` | `/api/providers/test` | `routes/providers.js#handleTestProvider` | `{provider}`; structured codes → status |
| `GET` | `/api/providers/presets` | `routes/providers.js#handleGetPresets` | gallery |
| `POST` | `/api/providers/preset/:id/enable` | `routes/providers.js#handleEnablePreset` | one-click enable |
| `POST` | `/api/debug/inject` | `routes/debug.js#handleDebugInject` | `DEBUG_INJECT=1` gate |
| `GET` | `/api/debug/state` | `routes/debug.js#handleDebugState` | same gate |
| `POST` | `/api/protocol/set-mode` | `routes/protocol.js#handleSetMode` | mid-session mode change |
| `POST` | `/api/protocol/set-config-option` | `routes/protocol.js#handleSetConfigOption` | with `configId:'permissionMode'` this becomes the mid-session mode switch |
| `POST` | `/api/protocol/cancel` | `routes/protocol.js#handleCancel` | acp `session/cancel` notification |
| `POST` | `/api/protocol/load-session` | `routes/protocol.js#handleLoadSession` | `?cwd=`, fallback to current |
| `POST` | `/api/protocol/activate-session` | `routes/protocol.js#handleActivateSession` | one acp client tracks one active session |
| `GET` | `/api/protocol/list-sessions` | `routes/protocol.js#handleListSessions` | `?cwd=` filtered |
| `GET` | `/api/protocol/capabilities` | `routes/protocol.js#handleCapabilities` | `{mcodeVersion, mcodeName?, mcodeTitle?, capabilities: MCODE_ACP_CAPABILITIES, notes}` |

### Legacy dispatcher (`server/router.js`)

| Method | Path | Reason it stays here |
| --- | --- | --- |
| `GET` | `/api/events` | SSE channel: writer held by `lib/state-bus.js` across pushes (Hono streaming lands in P2) |
| `GET` | `/api/alerts` | Independent anomaly SSE channel (bell icon + audit log) |
| `GET` | `/trajectory`, `/trajectory/...` | Separate panel; SPA fallback to `/trajectory/` |
| `GET` | `/` and `/index.html` | `serveIndex` / `auth-gate.html` |
| `GET` | `*.<ext>` | static (webapp/out) |
| `OPTIONS` | `*` | 204 short-circuit (CORS preflight) |

The Hono layer still owns `/api/health` and `/api/settings` for every real
consumer; the legacy copies exist only so gate tests
(`checks/router-origin-gate.check.mjs`) have a route to assert against.

### `authorize()` action whitelist (`lib/authorize.js#AUTHORIZE_ACTIONS`)

Every HTTP request that crosses a destructive boundary waits on a per-cid
authorize round-trip (5-minute default timeout, fail-closed):

- `session.delete` — `DELETE /api/sessions/:id`
- `sessions.cleanup-orphans`
- `session.cleanup-all` (extension hook)
- `session.export` — `GET /api/sessions/:id/export`
- `session.search` — `GET /api/sessions/search`
- `token.reset`
- `slash.clear` — `/clear` and `/new` on the chat stream
- `startup.cleanup` — boot-time orphan sweep

The whitelist is the only source of truth — anything not on this list
cannot be gated via the modal flow.

## Architecture

See [`packages/webui/docs/ARCHITECTURE.md`](../packages/webui/docs/ARCHITECTURE.md) for the runtime topology, request lifecycle, and SSE contract. In short: `packages/webui/server.js` registers the workspace import resolver and delegates to `server/bootstrap.js`; `server/router.js` applies the gate chain (CORS → origin/CSRF → LAN → token → rate limit → read-only) and dispatches to `server/routes/*`; `server/lib/*` holds one-concern modules; `acp.mjs` is the ACP client spawning the engine; `webapp/out/` (the Next static export) is the UI, with `public/trajectory/` and `public/auth-gate.html` (served from the export root) as the only remaining legacy assets.

The HTTP layer is split: legacy routes cover the streaming/SSE surfaces and the auth-gate/html fallback; everything else is on a Hono app (`server/app.js`). `OWNED_ROUTES` is the literal-source greppable ledger; `ownsRequest(method, pathname)` resolves the runtime dispatch decision against the Hono router table.

## Trajectory studio

`server/trajectory/` (migrated from the mcode-trajectory-studio plugin) inspects local sessions read-only via the runtime SQLite projection with `messages.jsonl` fallback, offering turn/duration/token/compaction/subagent views. It is mounted at `/trajectory/` behind the webui's gates and can also run standalone:

```bash
node packages/webui/server/trajectory/main.mjs --serve   # loopback panel
node packages/webui/server/trajectory/main.mjs --doctor  # data-source diagnostics
node packages/webui/server/trajectory/main.mjs --stdio   # MCP over stdio (7 tools)
```

The seven MCP tools are registered in `packages/webui/server/trajectory/mcp.mjs`:
`trajectory_list`, `trajectory_summary`, `trajectory_get`, `trajectory_search`,
`trajectory_tasks`, `trajectory_task_output`, `trajectory_studio`. Server
name: `mcode-trajectory-studio`, version `0.1.1`. Protocols supported:
`2025-06-18`, `2025-03-26`, `2024-11-05` (newest first).

## Development and tests

```bash
pnpm --filter @mavis/webui test      # full node:test suite (unit + mocked + integration + matrix + trajectory)
pnpm test:webui                      # same, from the repository root (CI gate)
node packages/webui/scripts/check-docs-alignment.mjs
```

The package has three runtime dependencies (`hono` + `@hono/node-server` for the HTTP layer, `@mavis/shared` for the workspace path contract) and requires Node 22.19+ (the trajectory studio additionally needs `node:sqlite`, floor 22.13).

## Origin

The package migrates the community mcode-webui plugin (v1.0.0 → v2.0.0, MiniMax-Code-Plugins PRs #16/#23/#31/#55) and the mcode-trajectory-studio plugin (PR #56) into the product. The full people and history record is [co-builders.md](../co-builders.md).
