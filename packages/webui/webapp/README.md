# `webapp/` — the Web UI frontend

A Next.js 14.2.35 application (React 18.3.1, TypeScript, Tailwind CSS 3.4.19) that
renders the Web UI. It is compiled to a **static export** and served by
`../server.js`, which itself stays dependency-free — see
[`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) §7 for the runtime/build split.

## Commands

```bash
pnpm --filter @mavis/webui webapp:dev        # next dev on :18091, proxies /api/* to :18090
pnpm --filter @mavis/webui webapp:build      # next build → webapp/out
pnpm --filter @mavis/webui webapp:typecheck  # tsc -p webapp/tsconfig.json
pnpm --filter @mavis/webui test:webapp       # node:test over lib/*.ts (via tsx)
```

`pnpm build` at the repository root runs `webapp:build` and copies the export into
`dist/webui/webapp/out`, which is where `../server/lib/static.js` looks for it — the
export sits at the same relative path in a checkout and in the built layout, so the
server needs no layout branch.

To run the whole thing the way it ships:

```bash
pnpm --filter @mavis/webui webapp:build
node packages/webui/server.js      # serves the export at / , API on the same origin
```

## Layout

| Path | Role |
| --- | --- |
| `app/` | App Router entry: `layout.tsx` (theme bootstrap + global styles), `page.tsx` (composition) |
| `components/` | `shell` (frame + sidebar), `chat`, `composer`, `toolbar`, `panels`, `modals`, `icons` |
| `lib/` | Non-visual logic: `transcript`, `sse`, `api`, `cid`, `store`, `markdown`, `i18n`, `theme`, `types` |
| `styles/tokens.css` | Design tokens, generated from the desktop stylesheet |
| `styles/official-utilities.css` | Upstream's hand-written utility classes, copied |
| `styles/desktop-typography.css` | The typography-preset cascade: preset custom properties + the gated rules, derived from the desktop stylesheet |
| `test/` | `node:test` suites for the `lib/` modules |

## How the alignment was derived

The components are not designed from screenshots; they are copied from the official
desktop client's **running DOM**. The stack was identified from the shipped
`app.asar`, and the markup, class strings, measurements and icons were read out of
the live renderer over the Chrome DevTools Protocol.

To redo that extraction:

```bash
cd "/opt/MiniMax Code"
LD_PRELOAD=/tmp/minimax-fmod-shim.so ./electron/dist/electron \
  --no-sandbox --disable-gpu --in-process-gpu \
  --remote-debugging-port=9333 --remote-allow-origins='*' \
  --user-data-dir="$HOME/.config/MiniMax-Code" \
  app/app-64/resources/app.asar
```

Then read structure out of `http://127.0.0.1:9333/json` with any CDP client
(`Runtime.evaluate` returning `outerHTML`/`getComputedStyle` is enough — no browser
automation library is required, Node's global `WebSocket` works).

That ad-hoc route is now scripted, which is the supported way to re-derive a
component:

```bash
node scripts/desktop-reference.mjs --list                 # which surfaces it knows
node scripts/desktop-reference.mjs --surface sidebar      # markup + computed styles
node scripts/desktop-reference.mjs --all --tokens         # everything, plus the token sets
```

It writes JSON to `$TMPDIR/mcode-desktop-reference` — **outside the repository**,
because the dumps are review material and contain the user's own session titles.
`--tokens` is the one to reach for before touching colours: it reports what the
running client *resolves*, which is what actually paints.

Two traps this script exists to avoid:

- **Do not read tokens out of the packaged CSS by hand.** Its light/dark blocks are
  emitted as a single minified line without selectors, so a naive slice mis-attributes
  values to the wrong block.
- **Version-skew.** The build inside `linux-mcode-desktop/unpacked` can be several
  versions behind the installed client (observed: 3.0.67 vs a running 3.0.73). Reading
  it produced twelve "differences" that were really just an older design. Compare
  against the running client, not the extracted one.

The typography preset is the one subsystem the live DOM cannot give you. Upstream
resolves it in JavaScript and writes the result onto `<html>` at runtime, so a
computed-style dump shows the *values* but not the rules or the ramp behind them.
That half comes from the extracted stylesheet instead:

```bash
node scripts/desktop-typography.mjs \
  <unpacked>/out/_next/static/css \
  webapp/styles/desktop-typography.css
```

It also writes outside the repository by default in spirit: the input is the
unpacked desktop bundle, which is not part of this repo. Splitting a selector list
naively breaks `:is(a, b)`, so the script does a parenthesis-aware split — keep that
if you ever reimplement it.

Three consequences worth knowing before changing a component:

- **Class strings are the upstream ones**, including the naming rule that the utility
  is the token name (`bg-bg_default_primary`, `text-caption-small-strong`,
  `message-container-user-text`). `tailwind.config.mjs` derives its theme from
  `styles/tokens.css` so the two cannot drift.
- **`pre` is neutralised upstream.** `pre:not(.codeblock-pre)` clears padding and
  background, so code must be emitted inside the `codeblock-shell` / `codeblock-pre` /
  `codeblock-code` structure that the copied rules expect. `lib/markdown.ts` does that
  in a `marked` renderer override.
- **Upstream's right panel hosts a file/diff preview** which this server has no
  feature for, so the shell carries the panels the server does back (workspace, usage,
  settings, alerts). Same container, real content.

## Dependency boundary

Only build-time tooling is added: `next`, `react`, `react-dom`, `tailwindcss`,
`postcss`, `autoprefixer`, `typescript` and the React type packages, all as
`devDependencies`. Nothing new is imported at runtime by `server.js`.

`marked` is used for assistant-message rendering and is **already a workspace
dependency** (`packages/tui`), so it adds no edge to the lockfile, the licence
inventory or the standalone boundary. Two upstream behaviours are deliberately not
reproduced because they need libraries outside this boundary, and each is documented
where it appears: the composer is a `textarea` styled with upstream's
`rich-text-editor` class rather than a Tiptap/ProseMirror instance, and dropdowns are
hand-rolled against the token layer rather than antd.

## Not ported: the Trajectory Studio

`../public/trajectory/` (the Trajectory Studio) stays as it is. It is a separate tool,
not part of the desktop UI: it has its own backend under `../server/trajectory/`, its
own security posture (loopback-only, a capability token, payload redaction, its own
CSP), its own tests under `../test/trajectory/`, and it is served from a single
documented location (`http.mjs` → `WEB_ROOT`) so that one asset tree feeds both the
standalone panel and the mounted `/trajectory` route.

Porting its ~2.9k lines of vanilla JS into this app would break that "one asset tree,
two modes" arrangement, and there is no upstream design to align it to — so it is a
rewrite with regression risk and no user-visible gain. `/trajectory` is handled by the
router before any static lookup and is unaffected by the frontend move; that is
verified by `../test/trajectory/panel-security.test.mjs` and by requesting
`/trajectory/`, `/trajectory/style.css` and `/trajectory/js/api.js` against a running
server.
