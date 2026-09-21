# MiniMax Code Web UI

> **Browser frontend for the MiniMax Code agent runtime.**
> Streams `mcode acp` / `mcode exec` sessions over HTTP/SSE. Zero npm
> dependencies; runs on Node 22.19+.

The Web UI is a first-class part of this repository — the same engine that
powers the TUI (`mcode acp`, Agent Client Protocol over stdio) drives the
browser frontend, coexisting with the terminal UI and the desktop clients.

It originates from the community **mcode-webui** plugin by Wzdhehe and
contributors (plugin v1.0.0 → v2.0.0, MiniMax-Code-Plugins PRs #16/#23/#31/#55,
plus the trajectory studio from PR #56) and was migrated into the product
as `packages/webui`. See [`co-builders.md`](../../co-builders.md) at the
repository root for the full people & history record.

## Quick start

```bash
# From a built checkout (or an installed mcode CLI):
mcode webui                     # http://127.0.0.1:8080
mcode webui --port 8123 --host 127.0.0.1

# Direct launch (development):
node packages/webui/server.js
```

The server binds loopback by default. LAN exposure is explicit opt-in
(`--host` / `HOST` env, or the persisted `lanBind` setting). On first start a
token is generated and delivered to the browser over SSE; non-local requests
must carry `?token=<value>` or `Authorization: Bearer <value>`.

Recommended on non-loopback networks:

```bash
export TOKEN="$(openssl rand -hex 16)"
mcode webui --host 0.0.0.0
# open http://<lan-ip>:8080/?token=$TOKEN
```

## What's in the box

| File | What |
|------|------|
| `server.js` | HTTP + SSE server bootstrap |
| `server/` | Router, route modules, and pure libs (`server/lib/`) |
| `acp.mjs` | `mcode acp` JSON-RPC client (spawns the engine over stdio) |
| `public/` | Static frontend SPA |
| `server/trajectory/` | Session trajectory studio (read-only SQLite inspection) |
| `references/SECURITY-NOTES.md` | **Canonical security disclosure** (read before exposing beyond loopback) |
| `docs/` | ARCHITECTURE, API, CAPABILITIES, DEVELOPMENT, TROUBLESHOOTING, CHANGELOG |
| `test/` | `node:test` suites |
| `checks/` | mocked unit checks (`t.mock.module`; need the module-mocks flag) |
| `scripts/` | docs-alignment checker, SBOM generator, test-db fixture builder |
| `package.json` | Package metadata + manifest (`mcodeWebui.capabilities`) |

## Screenshots

Real captures taken against a running v2.0.0 server — see
[`docs/screenshots/`](docs/screenshots/).

| # | What it shows |
|---|---|
| 1 | **Startup** — empty chat view on first launch |
| 2 | **Mid-stream chat** — history restored, SSE deltas in flight, tok/s meter |
| 3 | **Settings panel** — Appearance / Language / LAN Access toggles |
| 4 | **Chat input** — prompt typed, send/stop affordances, `/` and `@file` hints |
| 5 | **Post-send + tool call** — assistant streaming, tool-call block auto-collapse |

## Capabilities

This package exposes 13 capabilities, declared in
[`package.json`](package.json) under `mcodeWebui.capabilities` and described
in full detail in [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md). The names
below are canonical identifiers — keep them stable; external registries and
IDE integrations match on these strings.

| Capability | One-line |
|---|---|
| `chat-streaming` | SSE deltas from `mcode acp` rendered token-by-token |
| `tool-execution` | Bash / Read / Write / Edit forwarded from acp `tool_call` events |
| `plan-mode` | Plan review modal with `agree` / `skip` / `add context` options |
| `ask-user-tool` | 2-4 option question modal with `Other` free-text fallback |
| `permission-prompts` | `ask` / `auto` / `full` approval modal for tool calls |
| `workspace-switching` | Workspace picker + recent list + last-used restore |
| `session-management` | List / create / switch / delete webui sessions |
| `file-attachments` | Drag-drop / click / paste upload + `@path` injection |
| `quota-usage` | `mmx quota show` + per-turn context window display |
| `bilingual-ui` | zh-CN / en locale toggle via `t(key)` lookup tables |
| `lan-sharing` | Loopback default; LAN exposure via explicit opt-in (`HOST` env / `lanBind` setting) + runtime on/off toggle |
| `token-auth` | `?token=` / `Authorization: Bearer` for non-local requests |
| `mobile-responsive` | Drawer at <900px, single column at <600px |

CI asserts every one of these names is mentioned in this README and in
[`docs/CAPABILITIES.md`](docs/CAPABILITIES.md) (see
`scripts/check-docs-alignment.mjs`).

## Trajectory Studio

`server/trajectory/` is the migrated **mcode-trajectory-studio** (PR #56,
author weekbin): a read-only inspector for local MiniMax Code sessions backed
by the runtime SQLite projection (`~/.minimax/v2/sqlite/runtime-state.sqlite`),
with `messages.jsonl` fallback. It offers turns / duration / tool arguments /
token / compaction / subagent views, redacted for display.

```bash
node packages/webui/server/trajectory/main.mjs --doctor   # data-source diagnostics
node packages/webui/server/trajectory/main.mjs --serve    # standalone panel (loopback)
node packages/webui/server/trajectory/main.mjs            # MCP over stdio (7 tools)
```

When the webui server runs, the studio is also mounted at `/trajectory/`
behind the webui's own origin/token/readonly gates.

Node requirements: the studio needs `node:sqlite`, so nothing below Node
**22.13** can run it; the verified range (where bundled SQLite always ships
FTS5) is **>=22.19 <23 || >=24 <27**, matching the runtime's own engines.
Outside that range — e.g. Node 23.x — FTS5 search may be absent and the panel
degrades to sequential scans.

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — runtime topology, request lifecycle, module contracts
- [`docs/API.md`](docs/API.md) — HTTP/SSE surface
- [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md) — capability deep-dive
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) — dev workflow, tests
- [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) — common failures
- [`docs/HTTPS-REVERSE-PROXY.md`](docs/HTTPS-REVERSE-PROXY.md) — TLS termination recipes
- [`docs/CHANGELOG.md`](docs/CHANGELOG.md) — plugin-era release history

## Security

Read [`references/SECURITY-NOTES.md`](references/SECURITY-NOTES.md) before
binding to anything other than loopback. Highlights: loopback bind by default,
trusted-origin CORS, per-request `authorize()` gate (fail-closed audit),
independent anomaly SSE channel, workspace containment, bounded uploads,
rate limiting, no telemetry.

## License

MIT, as part of the MiniMax Code repository. The plugin-era project carried
the same MIT license with attribution to Wzdhehe and contributors — preserved
in [`co-builders.md`](../../co-builders.md).
