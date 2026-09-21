# Web UI

The Web UI (`packages/webui`) is the browser frontend for MiniMax Code. It uses the same engine as the TUI — the CLI's ACP server (`mcode acp`, JSON-RPC 2.0 over stdio) — so terminal, browser, and desktop clients run against one runtime. It is not a plugin: it ships inside the repository and is launched by the CLI.

## Launch

```bash
mcode webui                   # http://127.0.0.1:8080
mcode webui --port 8123 --host 127.0.0.1
mcode webui --token "$(openssl rand -hex 16)" --host 0.0.0.0   # LAN, token-gated
node packages/webui/server.js # direct, from a checkout
```

The command resolves the webui package (installed `dist/webui/` or source `packages/webui/`), spawns the server as a child process, and points it back at the running CLI through `MCODE_WEBUI_SELF_ENTRY`. The webui then spawns `node <cli> acp` per active browser tab.

## Security posture

- Loopback bind by default; LAN exposure requires `--host`/`HOST` env or the persisted `lanBind` setting.
- Trusted-origin CORS + a browser Origin/CSRF gate that applies even to loopback requests.
- Token auth (`?token=` / `Authorization: Bearer`) for non-local requests; local requests bypass.
- Read-only mode for non-local sessions; per-request `authorize()` gate with fail-closed audit; rate limiting; workspace containment; bounded uploads; no telemetry.

The canonical disclosure is [`packages/webui/references/SECURITY-NOTES.md`](../packages/webui/references/SECURITY-NOTES.md).

## Architecture

See [`packages/webui/docs/ARCHITECTURE.md`](../packages/webui/docs/ARCHITECTURE.md) for the runtime topology, request lifecycle, and SSE contract. In short: `server.js` bootstraps an HTTP server; `server/router.js` applies the gate chain (CORS → origin/CSRF → LAN → token → rate limit → read-only) and dispatches to `server/routes/*`; `server/lib/*` holds one-concern modules; `acp.mjs` is the ACP client spawning the engine; `public/` is the SPA.

## Trajectory studio

`server/trajectory/` (migrated from the mcode-trajectory-studio plugin) inspects local sessions read-only via the runtime SQLite projection with `messages.jsonl` fallback, offering turn/duration/token/compaction/subagent views. It is mounted at `/trajectory/` behind the webui's gates and can also run standalone:

```bash
node packages/webui/server/trajectory/main.mjs --serve   # loopback panel
node packages/webui/server/trajectory/main.mjs --doctor  # data-source diagnostics
node packages/webui/server/trajectory/main.mjs           # MCP over stdio (7 tools)
```

## Development and tests

```bash
pnpm --filter @mavis/webui test      # full node:test suite (unit + mocked + integration + matrix + trajectory)
pnpm test:webui                      # same, from the repository root (CI gate)
node packages/webui/scripts/check-docs-alignment.mjs
```

The package has zero npm runtime dependencies and requires Node 22.19+ (the trajectory studio additionally needs `node:sqlite`, floor 22.13).

## Origin

The package migrates the community mcode-webui plugin (v1.0.0 → v2.0.0, MiniMax-Code-Plugins PRs #16/#23/#31/#55) and the mcode-trajectory-studio plugin (PR #56) into the product. The full people and history record is [co-builders.md](../co-builders.md).
