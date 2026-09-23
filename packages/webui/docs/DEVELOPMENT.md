# Development

**English** | [简体中文](DEVELOPMENT.zh-CN.md)

> How to work on this codebase. Audience: someone who has the repo
> cloned and wants to add a feature, fix a bug, or understand the
> codebase well enough to review PRs.

## Setup

Requirements:
- Node 22.19+ or 24+ (project enforces in `package.json` `engines`)
- mcode 0.1.4+ installed and on `PATH` (or pointed to via `MCODE_CMD`)
- For SQLite (used in session cleanup): `better-sqlite3` is loaded
  lazily, so it's not required at install, only at runtime when you
  hit the cleanup endpoint. The `SQLITE3_BIN` env var points to a
  precompiled binary if you need to read the db manually.

Zero npm install. Clone, run:
```bash
cd packages/webui
node server.js
# → http://127.0.0.1:18090 (or the next free port; see below)
```

`packages/webui/server.js` is the source-mode bootstrap: it registers
the `tsx` loader and a resolver that maps every `@mavis/*` specifier to
the workspace's TypeScript sources, then delegates to
`server/bootstrap.js`. The shipped archive runs `dist/webui/server.js`
instead (the esbuild bundle of `bootstrap.js`); both entry points
share the same startup code.

If you want a debug session (verbose SSE, no cache, injectable events):
```powershell
$env:DEBUG_INJECT = '1'
node server.js
```

## Code structure (recap from ARCHITECTURE.md)

- `server.js` — bootstrap only (registers the workspace import resolver,
  then delegates to `server/bootstrap.js`). Don't add features here.
- `server/router.js` — declarative route table. Add your route here.
- `server/routes/*.js` — one file per URL family. Each exports
  `async function handleXxx(req, res, ctx, pathname)`.
- `server/lib/*.js` — pure modules. One concern each.
- `webapp/` — Next.js 14 (React 18 + Tailwind) frontend. App Router
  under `webapp/app/`, components under `webapp/components/`, non-visual
  logic under `webapp/lib/`, design tokens under `webapp/styles/`, and
  the static export written to `webapp/out/`.
- `public/trajectory/` — standalone Trajectory Studio (its own backend,
  CSP, token posture). Mounted at `/trajectory/` by the router.

## Adding a new HTTP endpoint

1. Create `server/routes/foo.js`:

   ```js
   // server/routes/foo.js
   import { pushStateFor, getClient } from '../lib/state-bus.js'
   import { fail, ok } from '../lib/util.js'  // if you have one

   export async function handleFoo(req, res, ctx, pathname) {
     const cid = ctx.cid
     if (!cid) return fail(res, 400, 'cid required')

     const body = await readJsonBody(req)
     if (!body) return fail(res, 400, 'invalid JSON')

     // do the work…

     // if it mutates state:
     pushStateFor(cid, { /* delta */ })
     // for one-off SSE messages, see `pushOnlineCount` / `broadcastTokenRotated`

     return ok(res, { /* response */ })
   }
   ```

2. Wire it in `server/router.js`:

   ```js
   import * as fooRoute from './routes/foo.js'
   …
   { method: 'POST', match: (p) => p === '/api/foo', handler: fooRoute.handleFoo },
   ```

3. If the webui calls it, add a helper in `webapp/lib/api.ts`:

   ```ts
   export async function apiFoo(payload: unknown): Promise<…> {
     const r = await fetch('/api/foo' + API_SUFFIX, {
       method: 'POST',
       headers: { 'Content-Type': 'application/json', ...HEADERS },
       body: JSON.stringify(payload),
     })
     return r.json()
   }
   ```

4. **Don't write to `clientState.state` directly** from a route handler.
   Use `pushStateFor(cid, …)` so the change is broadcast on the SSE
   channel and the client is the source of truth.

## Adding a new SSE event type

1. Define the event shape in `docs/ARCHITECTURE.md § 5` (SSE event schema).
2. In the transport layer (`mcode-acp.js` or `mcode-exec.js`), translate
   the raw mcode event to your normalized event:
   ```js
   yield { type: 'foo', … }
   ```
3. The transport layer pushes events via `pushStateFor(cid, …)` (state
   snapshots) or `broadcastTokenRotated(token)` (one-off event) which
   go onto the SSE channel.
4. In `webapp/lib/sse.ts`, handle the event in the SSE message handler
   and update the typed store (`store.foo`).
5. If the event needs UI, add a render function `renderFoo()` (or wire
   it into the existing component) and call it from the page's render
   path.

## Adding a new UI panel

1. Add the panel as a component under `webapp/components/` (and register
   it in `webapp/app/page.tsx` if it's a new top-level surface, or
   inline it inside `webapp/components/shell.tsx` if it lives in the
   shell's right-hand drawer).
2. Add i18n keys to both `webapp/lib/i18n.ts` tables (use a consistent
   prefix: `panel.foo.title`, `panel.foo.empty`).
3. In the component:
   - Read state via the typed context hook (`useSessionContext` from
     `webapp/lib/store.tsx`) and subscribe to the relevant slice.
   - Render with Tailwind classes derived from `webapp/styles/tokens.css`.
4. If the component needs bespoke styles, add them to
   `webapp/styles/official-utilities.css` (or scope them in the
   component via Tailwind's `@apply`).

## Adding a slash command (webui-side)

These are commands the webui handles itself without forwarding to mcode
(used for things like `/clear`, `/exec`).

1. In `server/lib/slash.js`, add an entry:
   ```js
   { cmd: '/foo', handler: handleFoo, hidden: false }
   ```
2. `handleFoo` receives `(content, ctx)` and returns either:
   - `null` (not handled, forward to mcode)
   - `{ handled: true, response: '…' }` (handled, send to user as a
     synthetic message)
3. The webui displays `response` as if it came from mcode.

## Adding a mcode-translated slash command

If you want a slash command that maps to an mcode command, you don't
add code — mcode returns the command list via `session/commands` and
the webui already renders it. Just make sure mcode knows about the
command; the webui picks it up on connect.

## Testing without mcode

1. Set `$env:DEBUG_INJECT = '1'` before `node server.js`.
2. Open `http://127.0.0.1:18090/?debug=1` (or just check the right
   panel — the debug panel is always visible).
3. In the browser console:
   ```js
   await fetch('/api/debug/inject' + API_SUFFIX, {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ type: 'delta', text: 'hello from test' })
   })
   ```
4. The injected event appears in the right panel and in the SSE
   stream.

You can also call `__DBG.log('whatever')` from the console — it shows
up in the bottom-right debug panel.

## Database inspection

The webui-side session store is plain JSON under `WEBUI_DATA_DIR`
(default `~/.mcode-webui`, override with `MCODE_WEBUI_DATA_DIR`):
```bash
cat "$HOME/.mcode-webui/sessions.json" | jq .
```

The mcode-side session store is SQLite under the runtime data dir
(default `~/.minimax`, override with `MINIMAX_DATA_DIR` or
`MAVIS_DATA_DIR`; `config.js` resolves the precedence):
```bash
sqlite3 "$HOME/.minimax/v2/sqlite/runtime-state.sqlite" ".tables"
sqlite3 "$HOME/.minimax/v2/sqlite/runtime-state.sqlite" \
  "SELECT id, title, cwd FROM local_runtime_sessions ORDER BY updated_at DESC LIMIT 10"
```

## Common tasks

### Bump the cache-bust
Next's static export content-addresses every chunk under `_next/static/<hash>/…`
(§ ARCHITECTURE.md §7 cache policy), so the runtime never depends on a manual
`?v=N` bump — the hash changes on every edit. The legacy `?v=N` query-string
cache-bust from the vanilla-JS SPA no longer applies; the only thing to do
after a frontend change is to rebuild (`pnpm run webui:build`) and re-export.

### Change the default port
18090 is a default, not a pinned value: when it is taken the server walks
forward to the next free port and logs the one it bound. Setting `PORT` (or
passing `--port` to `mcode-web`) pins the port instead — a taken pinned port
exits with EADDRINUSE rather than moving, so docker port publishing and
healthchecks keep addressing the configured value.

```bash
# default port: 18090, or the next free port when 18090 is taken
node server.js

# pinned to 7891 — never moves
PORT=7891 node server.js
```

### Enable LAN sharing
Two options:
- Web UI: bottom-left "局域网访问" button
- API: `POST /api/settings {lanBroadcast: true}`

### Debug a stuck mcode subprocess
The webui keeps one subprocess per CID. If it's stuck:
```powershell
# find the cid
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like "*acp*" } |
  Select-Object ProcessId, CommandLine

# kill it (replace PID)
Stop-Process -Id 12345 -Force
```

The webui will spawn a fresh one on the next send.

### Re-enable LAN after locking yourself out
The `/api/settings` endpoint is exempt from the LAN guard by design.
From any machine on the LAN, even with `lanBroadcast: false`:
```bash
curl -X POST http://192.168.1.50:18090/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"lanBroadcast": true}'
```

## Style guide

- **Server**: no semicolons, single quotes, 2-space indent, ESM.
  - Use `import` not `require`.
  - Top-level `await` is fine in scripts, not in modules — wrap in
    `async function main()` if needed.
- **Client** (`webapp/`): same conventions. The frontend is a Next.js
  14 / React 18 / Tailwind App Router project; new pages and components
  live under `webapp/app/`, `webapp/components/`, and `webapp/lib/`.
  See `webapp/README.md` for the file-by-file walk-through.
- **Comments**: explain *why*, not *what*. If the code does what its
  name says, no comment needed. If a workaround is needed, the
  comment should reference the upstream issue. The webui removed the
  legacy `public/app/*.js` vanilla-JS frontend entirely; do not
  reintroduce it.
- **i18n**: any user-visible string goes through the typed
  `t(MessageKey)` lookup in `webapp/lib/i18n.ts`. Both English and
  Chinese tables are kept in lockstep; never hard-code a literal in
  a component.
- **CSS**: the Next export uses Tailwind utility classes against the
  design tokens in `webapp/styles/tokens.css`. Use `data-theme` on the
  `<html>` element (`applyTheme` in `webapp/lib/theme.ts`) to toggle
  between the light and dark token tables.

## Code review checklist

Before sending a PR:

- [ ] `pnpm --filter @mavis/webui test` passes (server unit + routes + tooling)
- [ ] `pnpm --filter @mavis/webui webapp:typecheck` passes
- [ ] `pnpm --filter @mavis/webui check` passes (the docs-alignment gate)
- [ ] No new hard-coded user-visible strings (everything via `t(MessageKey)`)
- [ ] No direct writes to `clientState.state` (use `pushStateFor`)
- [ ] If a new endpoint, documented in `docs/API.md` (the
      `check-docs-alignment` script enforces that the path is registered
      in `server/router.js`)
- [ ] If a new event type, documented in `docs/ARCHITECTURE.md § 5`
- [ ] If a new UI panel, both `zh` and `en` i18n keys present
- [ ] Frontend change rebuilt (`pnpm --filter @mavis/webui webapp:build`)
      before testing the bundled layout
- [ ] No new npm deps without discussion; the tiered dependency policy
      in `docs/ARCHITECTURE.md § 7.1` applies

## Repository hygiene

- Don't commit `.server.err`, `.server.log`, `node_modules`, etc.
  The `.gitignore` covers these.
- Don't commit probe scripts to the root. The `probes/` directory
  is a scratch space for one-off diagnostic scripts; clean it
  after use.
- Commit messages: imperative mood, present tense ("add X", not
  "added X"). Reference the issue if there is one.
