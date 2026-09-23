# Web UI

**English** | [简体中文](webui.zh-CN.md)

The Web UI (`packages/webui`) is the browser frontend for MiniMax Code. It uses the same engine as the TUI — the CLI's ACP server (`mcode acp`, JSON-RPC 2.0 over stdio) — so terminal, browser, and desktop clients run against one runtime. It is not a plugin: it ships inside the repository and is launched by the CLI.

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

Without `--port` the server starts on 18090 and moves to the next free port when 18090 is taken, logging the URL it bound — the launcher opens that one. An explicit `--port` (or `PORT`) is pinned: it never moves, so a taken port exits with EADDRINUSE instead.

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

The canonical disclosure is [`packages/webui/references/SECURITY-NOTES.md`](../packages/webui/references/SECURITY-NOTES.md).

## Architecture

See [`packages/webui/docs/ARCHITECTURE.md`](../packages/webui/docs/ARCHITECTURE.md) for the runtime topology, request lifecycle, and SSE contract. In short: `packages/webui/server.js` registers the workspace import resolver and delegates to `server/bootstrap.js`; `server/router.js` applies the gate chain (CORS → origin/CSRF → LAN → token → rate limit → read-only) and dispatches to `server/routes/*`; `server/lib/*` holds one-concern modules; `acp.mjs` is the ACP client spawning the engine; `webapp/out/` (the Next static export) is the UI, with `public/trajectory/` and `public/auth-gate.html` (served from the export root) as the only remaining legacy assets.

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

The package has three runtime dependencies (`hono` + `@hono/node-server` for the HTTP layer, `@mavis/shared` for the workspace path contract) and requires Node 22.19+ (the trajectory studio additionally needs `node:sqlite`, floor 22.13).

## Origin

The package migrates the community mcode-webui plugin (v1.0.0 → v2.0.0, MiniMax-Code-Plugins PRs #16/#23/#31/#55) and the mcode-trajectory-studio plugin (PR #56) into the product. The full people and history record is [co-builders.md](../co-builders.md).
