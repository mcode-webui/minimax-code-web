# Architecture — Desktop and TUI reference for Web UI alignment

> **Scope.** This document records the measured architecture of the **MiniMax Code desktop
> client** (`@mmx-agent/electron`) and the **TUI/CLI** (`@minimax/code`), and defines what the
> Web UI inherits from each. It exists to keep the browser frontend visually and
> behaviourally aligned with the desktop client.
>
> **Not in scope.** The Web UI's own runtime topology — server bootstrap, router, request
> lifecycle, module contracts, `clientState.state`, the SSE event schema, and failure
> modes — is documented in [`ARCHITECTURE.md`](ARCHITECTURE.md).
> That document is the single source of truth for how the Web UI is built; this one does not
> restate it. See [§6](#6-what-the-web-ui-inherits-and-what-it-does-not) for the boundary.
>
> **Companion.** [`DESIGN.md`](DESIGN.md) covers the visual layer (design tokens, theme
> protocol, layout constants, and the current Web UI theme mapping).

## 1. Evidence and reproducibility

Every version number and structural fact below was read from shipped artifacts, not inferred.

| Item | Value |
| --- | --- |
| Desktop package | `@mmx-agent/electron 3.0.73-inside.84` |
| Artifact | `app.asar` (587.7 MB) inside the Windows NSIS installer |
| Renderer output | `out/` (Next.js static export) |
| Main process | `dist/main/` (TypeScript build output) |
| TUI package | `@minimax/code 0.4.12` (`packages/tui`) |

The installer is unpacked in two 7z steps: the outer NSIS shell first, which yields
`$PLUGINSDIR/app-64.7z`, then that inner archive, whose contents land flat and are moved into
an `app-64/` directory. Reading a single file out of `app.asar` requires only the asar header:
four little-endian `uint32` values (magic `4`, pickle size, payload size, JSON header size)
followed by the JSON directory and the data section at offset `8 + pickleSize`. Each file
entry carries `offset`/`size` relative to that data section.

```python
import json, struct
f = open("app.asar", "rb")
_, pickle_size, _, json_size = struct.unpack("<IIII", f.read(16))
header = json.loads(f.read(json_size))
data_start = 8 + pickle_size            # per-file offset is relative to this

def read(path):                          # path is "/"-joined, no leading slash
    node = header
    for part in path.strip("/").split("/"):
        node = node["files"][part]
    f.seek(data_start + int(node["offset"]))
    return f.read(node["size"])
```

## 2. Desktop renderer stack

| Layer | Choice | Version | Evidence |
| --- | --- | --- | --- |
| Framework | **Next.js** | **14.2.35** | `window.next={version:"14.2.35",appDir:!0}` in `out/_next/static/chunks/1528-*.js` |
| Routing | **App Router** (Pages Router retained for `_app`/`_error`) | — | chunk paths contain route groups `app/(pages)/(mavis)/…` |
| Rendering | **React Server Components, statically exported** | — | `out/index.txt` is an RSC flight payload (`2:I[55092,[],""]` … `["",{"children":["(pages)",…]}]`) |
| UI runtime | **React** | **18.3.1** | `version:"18.3.1",rendererPackageName:"react-dom"` in the framework chunk |
| App Router React | React canary bundled with Next 14 | `18.3.0-canary-178c267a4e-20241218` | `t.version="18.3.0-canary-…"` in `1dd3208c-*.js` |
| Language | **TypeScript** | — | type-only modules compile to empty exports and keep their source comments, e.g. `dist/main/modules/terminal/types.js` |
| Styling | **Tailwind CSS** | **3.4.19** | CSS banner `! tailwindcss v3.4.19 \| MIT License`; 845 `--tw-*` custom properties |
| Components (desktop) | **antd v5** | — | 283 extracted `.ant-*` classes (`.ant-btn`, `.ant-modal`, `.ant-picker`, `.ant-select`, `.ant-progress-circle`); `cssinjs` / `hashPriority` / `colorPrimary` markers in JS |
| Components (compact) | **antd-mobile** | — | 43 `.adm-*` classes (`.adm-grid`, `.adm-mask`, `.adm-selector`) |
| Icons | `@ant-design/icons`, `@ant-design/fast-color` | — | separate chunks `2175-*.js`, `7393.*.js` |
| HTTP | `axios` | — | 3 chunks |
| i18n | `i18next` | — | 2 chunks |
| State | **React Context + `useSyncExternalStore`** | — | 17 chunks each; no state library |
| Not used | zustand, jotai, redux, `@tanstack/react-query`, SWR, framer-motion, styled-components, emotion, CSS Modules, styled-jsx | — | zero matches across all renderer chunks |

Editors and rich media bundled in the renderer: monaco-editor, xterm, echarts, katex,
highlight.js, pdfjs, jszip, lottie, lodash, dayjs.

> Renderer dependencies are bundled into the chunks. `node_modules/` (448 packages) serves the
> main process only.

### 2.1 A symbol that is easy to misread

The renderer contains `Symbol.for("react.transitional.element")`, the React 19 element
symbol. This is **not** evidence of React 19: it is a third-party `isValidElement`
compatibility check that accepts both `react.element` and `react.transitional.element`. The
authoritative version is `rendererPackageName:"react-dom"` → **18.3.1**.

## 3. Desktop main process

```
app.asar
├── package.json                 @mmx-agent/electron 3.0.73-inside.84  (main: dist/main/index.js)
├── dist/main/                   main process
│   ├── index.js                 entry
│   ├── preload.js               renderer bridge (window.electronAPI)
│   ├── model-menu-preload.js
│   ├── config/                  app-identity, build-env, env, routes, constants
│   ├── ipc/                     29 IPC modules
│   ├── lifecycle/               bootstrap, kernel, quit-coordinator, crash-evidence, telemetry
│   ├── modules/                 29 feature modules (§3.2)
│   ├── windows/                 window factories (§3.1)
│   └── utils/
├── dist/model-menu/index.html   standalone popup (not a Next route)
├── out/                         Next.js static export
├── public/                      static assets
└── node_modules/                448 main-process packages
```

### 3.1 Windows

`mainWindow`, `loginWindow`, `onboardingWindow`, `archonChatWindow`,
`archonMiniChatWindow`, `logViewerWindow`, `desktopRendererWindow`, `model-menu-popup`,
plus `manager.js`, `initial-auth.js`, `window-state`.

### 3.2 Modules

```
auth                browser             browser-profile-import   cors
deeplink            desktop-appearance  desktop-typography       developer-options
diagnostics         dock                document-preview         file
hotUpdate           local-runtime       local-servers            mcode-tools
menu                observability       oss                      power
ppt-preview         protocol            remote-control-bridge    runtime-fetch-devtools
screenshot          terminal            tracking-recorder        tray
updater             window-state
```

Modules relevant to Web UI alignment:

| Module | Role | Web UI relationship |
| --- | --- | --- |
| `desktop-appearance.js`, `desktop-typography.js` | push appearance and typography tokens to the renderer | the behaviour `DESIGN.md` §8 reproduces |
| `local-runtime/` | start the local runtime, V2 data-dir migration, `state.db`, login shell env | same runtime the Web UI drives through ACP |
| `mcode-tools/` | mcode-tools host integration | shared with the TUI |
| `document-preview/`, `ppt-preview/` | document and slide preview (OOXML sanitizer, LibreOffice backend, artifact protocol) | not ported; the Web UI renders Markdown only |
| `terminal/` | node-pty, OSC parser, ring buffer | not ported |
| `browser/` | embedded browser, CDP, semantic tree, element map | not ported |

### 3.3 Renderer bridge (`preload.js`)

The renderer reaches the main process through `window.electronAPI`. Measured method set
(25 entries):

```
account   checkAuthStatus  getUser  setUser  startAuthLogin  navigateToLogin
          onAccountChanged  onAuthDeviceAuthorization
runtime   checkRuntimeReady  onRuntimeReady  onRuntimeFailed
window    onBeforeQuit  onMenuOpenSettings  onMenuOpenFeedback  setNativeThemeSource
files     selectFile  selectDirectory  getPathForFile  openFileInFolder  openDir
system    showNotification  showImageContextMenu  openExternal  screenshotStart
other     proxyFetch  getDesktopConfig  terminal
```

Treat this list as the desktop's capability contract. The Web UI already covers the
equivalent surface with HTTP routes and SSE (see `packages/webui/docs/API.md`); anything not
covered there has no desktop counterpart to align with.

### 3.4 Routes

| Route | Purpose |
| --- | --- |
| `/` | main UI |
| `/login` | sign-in |
| `/onboarding` | first-run |
| `/archon` | primary conversation |
| `/archon-mini-chat` | compact conversation window |
| `/log-viewer` | log viewer |
| `/doc`, `/docx`, `/pdf` | policies, DOCX preview, PDF preview |
| `/404` | not found |

`out/docx/index.html` is an exception: a standalone static page that loads jszip and
docx-preview from a CDN, outside the Next application.

### 3.5 Shared runtime packages (`@mavis/*`, 29)

```
agent-core  agent-extension  agent-runtime  agent-tools  background-task
browser-core  config  context-manager  conversation-contract  cron  goal
local-runtime  local-runtime-v2  mcode-tools-host  mcp  oauth-core
oauth-lease-protocol  permission  plugin-hooks  protocol  remote-control-bridge
runaway-guard  session-report  shared  skills  system-reminder  team
thrift-gen  thrift-gen-client
```

This is the layer the desktop, the TUI, and the Web UI genuinely share. In this repository
these packages resolve to source under `packages/`; see `docs/architecture.md` for the
source boundaries.

## 4. TUI stack

| Item | Value |
| --- | --- |
| Package | `@minimax/code` **0.4.12** (`packages/tui`) — CLI and TUI product entry |
| Node | `>=22.19 <23 \|\| >=24.2 <27` |
| Renderer | `@earendil-works/pi-coding-agent` plus the `pi-tui` engine (with native modules) |
| Protocol | `@agentclientprotocol/sdk` **1.3.0** (ACP) |
| Terminal | `chalk` ^5, `cli-highlight`, `get-east-asian-width`, `marked` |
| Other | `commander`, `ajv`, `gpt-tokenizer`, `jszip`, `saxes`, `undici`, `cross-spawn` |

### 4.1 Ports

The TUI abstracts every runtime capability behind a port interface (`packages/tui/src/runtime/port.ts`),
so the UI layer is replaceable:

```
TuiSessionPort          TuiSessionForkPort      TuiSessionTurnPort
TuiConversationPort     TuiConfigurationPort    TuiInspectionPort
TuiInteractionPort      TuiRuntimeEventPort     TuiQueuePort
TuiGoalPort             TuiDelegationPort
```

The ACP adapter (`packages/tui/src/acp/runtime.ts`) is the intersection of all of them: it
exposes the full runtime as one protocol endpoint.

### 4.2 ACP server

```bash
mcode acp                                # ACP server over stdio (NDJSON)
mcode acp login --region cn|global [--no-browser]
```

`packages/tui/src/cli/run-acp-command.ts` creates the runtime with an explicit
`surface: 'acp'` and serves it via `serveTuiAcpStdio`, which wraps `acp.ndJsonStream` around
`stdin`/`stdout`. Console output is redirected to stderr so stdout carries protocol frames
only.

### 4.3 Layout

```
packages/tui/src/
├── tui/engine/        layout, layout-node, keys, keybindings, terminal, terminal-colors,
│                      terminal-image, autocomplete, fuzzy, latex, kill-ring, stdin-buffer
│   └── components/    box, stack, v-stack, h-stack, text, truncated-text, input, editor,
│                      markdown, scroll-view, select-list, settings-list, loader,
│                      cancellable-loader, image, spacer, alt-screen-flash
├── tui/controller/    chat-controller, session-flow, session-fork-flow, delegation-flow,
│                      projection, run, runtime, interaction, product
├── tui/agent-team/    model, panel, summary
├── tui/background-work/panel
├── tui/commands/      catalog (40 slash commands), bash-input, bash-autocomplete,
│                      input-intent, side-session
├── tui/automation/    turn-result, result-writer, status-store
├── acp/               agent, commands, control-state, extensions, interactions,
│                      model-selection, paths, prompt-continuation, runtime, stdio, updates
├── headless/          runner, supervisor, events, contract, output, progress, settlement
├── application/       turn and session application layer
└── runtime/           ports, lifecycle, stream-events, runtime-events
```

### 4.4 Theme

`packages/tui/src/tui/theme/` holds `palettes.ts` (dark and light palettes, 20 semantic
colours each), `contracts.ts` (`TuiThemeColors`, `TuiColorLevel = 0|1|2|3`, detection source
`terminal-report | osc11 | colorfgbg | fallback`), `syntax.ts` (Catppuccin tone table with an
ANSI16 degradation map), and `ansi16.ts`, `detection.ts`, `controller.ts`,
`render-binding.ts`, `runtime.ts`.

The TUI palette values are drawn from the same numeric scale as the desktop client
(`#68C0FF` = `--blue_200`, `#0094FC` = `--blue_400`, `#303030` = `--gray_700`,
`#28C567` = `--green_300`). The full comparison, including three genuine divergences, is in
`DESIGN.md` §10.

## 5. What the Web UI inherits, and what it does not

The Web UI is **not** a second desktop client and **not** a browser skin over the TUI. It is
a third frontend on the same runtime, and the ACP integration already exists:

- `docs/webui.md` — "It uses the same engine as the TUI — the CLI's ACP server (`mcode acp`,
  JSON-RPC 2.0 over stdio) — so terminal, browser, and desktop clients run against one runtime."
- `packages/webui/docs/ARCHITECTURE.md` §3 — `acp-client.js` (`McodeAcpClient`,
  `getMcodeAcpClient()`), `mcode-rpc.js`, `mcode-acp.js` vs `mcode-exec.js`.
- `packages/webui/package.json` — one `mcode acp` subprocess per active browser tab.

So there is no transport decision left to make here. What this document adds is the
**desktop-facing contract** that the Web UI does not yet satisfy:

| Inherited | Source | Status in the Web UI |
| --- | --- | --- |
| Runtime, sessions, permissions, tools | `@mavis/*`, `mcode acp` | implemented |
| Conversation, queue, goal, delegation | TUI ports via ACP | partially — see `packages/webui/docs/CAPABILITIES.md` |
| Design tokens and theme protocol | desktop renderer CSS + theme engine | **gap** — the Web UI has its own token set; see `DESIGN.md` §12 |
| Typography scale and CJK handling | desktop `--mavis-*` typography tokens | **gap** |
| Layout constants (header, sidebar, reading width) | desktop `:root` tokens | partially — the Web UI uses its own values |
| Code syntax theme | desktop `--code-theme-*` | **gap** — the Web UI styles code with its own palette |
| Status line item semantics, 40 slash commands | TUI `docs/status-line-config.md`, `commands/catalog.ts` | **gap** — command coverage differs |

### 5.1 Constraint: the Web UI is dependency-free

`packages/webui/docs/ARCHITECTURE.md` §7 states the Web UI is intentionally dependency-free:
Node stdlib only, no framework, no build step, `node server.js` to start.

**This document does not propose changing that.** The desktop's stack (Next.js, React, antd,
Tailwind) is recorded above as *evidence of what the desktop is*, so that alignment decisions
can be made with the real facts. The alignment work it implies is limited to things that need
no dependencies:

- CSS custom properties and a `data-*` attribute protocol (plain CSS and DOM).
- Token names and values.
- Layout constants.
- Command and status-line coverage.

Adopting a component framework would be a separate architectural decision with its own
review, and nothing in this document depends on it.

## 6. Divergences and risks

| # | Divergence / risk | Impact | Handling |
| --- | --- | --- | --- |
| 1 | The Web UI is dependency-free by design; the desktop uses a full framework stack | Any "align the stack" reading is wrong | Keep the alignment to CSS/DOM-level contracts (§5.1) |
| 2 | The desktop renderer runs in Electron with `window.electronAPI`; the browser has no such bridge | 25 desktop APIs have no direct equivalent | Already replaced by HTTP routes and SSE; document the mapping, do not port the bridge |
| 3 | The desktop and the TUI are separate product lines (`3.0.73-inside.84` vs `0.4.12`) | Feature drift over time | Treat `@mavis/*` as the shared layer; record differences instead of assuming parity |
| 4 | ACP SDK version (`1.3.0`) is pinned by the TUI | An SDK bump can break the Web UI's shim | Keep the version check; the `UNSUPPORTED` set in `mcode-rpc.js` already handles missing methods |
| 5 | The TUI syntax theme is Catppuccin; the desktop has its own `--code-theme-*` | Three surfaces, two code themes | Decide once; see `DESIGN.md` §11 |
| 6 | TUI dark status colours are lighter (`_300`) than the desktop's (`_500`) | Same semantic, two appearances | Align the Web UI to the desktop; converge the TUI separately |
| 7 | `pi-tui` ships native modules (darwin/win32 prebuilds) | Anything importing TUI internals is platform-bound | Depend on the ACP protocol only, never on TUI internals |
| 8 | Desktop `@trycua/cua-driver` and `@ubjs/node` have no Linux or web prebuilds | Computer-use capability cannot be reused | Out of scope for the Web UI; document as unsupported |
| 9 | Locale changes layout in the desktop (Chinese input area is 36 px taller) | Easy to miss | Covered by the `DESIGN.md` §13 checklist |

## 7. Verification

This document is descriptive; it changes no runtime behaviour. The checks that apply to the
pull request that introduced it are recorded in that pull request's Validation section.

To re-derive the version facts:

```bash
# Desktop: unpack the installer (see the linux-mcode-desktop pipeline doc), then read
# a single file out of app.asar with the snippet in §1, e.g.:
python3 - <<'EOF'
import json, struct
f = open("unpacked/app-64/resources/app.asar", "rb")
_, pickle, _, n = struct.unpack("<IIII", f.read(16))
hdr = json.loads(f.read(n)); base = 8 + pickle
node = hdr["files"]["package.json"]
f.seek(base + int(node["offset"]))
print(f.read(node["size"]).decode())
EOF

# TUI: read the package manifest and the ACP entry point
cat packages/tui/package.json
sed -n '100,115p' packages/tui/src/cli/program.ts
```
