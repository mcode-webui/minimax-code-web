# Moving the web UI onto antd v5

> Status: in progress. Phase 0 (the dependency boundary), Phase 0.1 (the account
> menu's panel, rebuilt on the desktop's own anatomy), Phase 2 (the composer's two
> selectors) and Phase 3a (the blocking prompts) are done and verified; the phases
> below are the agreed order for the rest.

## Why

The desktop client is **antd v5** (plus antd-mobile for compact surfaces) under a
`mavis-*` skin — measured, not assumed: `DESKTOP-ARCHITECTURE.md` §2 records 283
extracted `.ant-*` classes and the `cssinjs` / `colorPrimary` markers in its
renderer chunks, and `DESIGN.md` maps its own class names onto the components
(`mavis-button` → antd `Button`, `mavis-dropdown` → antd `Dropdown`,
`mavis-modal-wrap` → antd `Modal`, `mavis-select` → antd `Select`, …).

This frontend re-implemented antd's **behaviour** by hand. Every interaction
defect found so far lives in that half:

- the account submenu closed in the same tick the pointer set off toward its panel,
- the usage popover is portalled, so a mousedown inside it closed the account menu
  and unmounted the button before the click dispatched,
- the submenu flyout was laid out from the wrong edge and opened off-screen.

None of those are styling gaps. They are the hover / portal / focus / placement
semantics that antd already owns, re-derived by hand and re-broken one instance at
a time. Adopting the library the desktop already uses removes the class.

## Invariants

These do not move during the migration:

1. **Every `data-testid` keeps working** (66 today). They are the behaviour
   contract the tests assert; a component swap that renames them silently drops
   the coverage.
2. **The HTTP/SSE contracts do not move.** `webapp/lib/api.ts` and the server
   routes are out of scope.
3. **Tailwind stays for layout**, antd is the component layer. That is exactly the
   desktop's split.
4. **No global `.ant-*` overrides.** Theming goes through `ConfigProvider` tokens
   first, then component-level `classNames` / `styles` — the antd priority order.

## Version: antd v5, not v6

`packages/webui` pins `next 14.2.35`, `react 18.3.1`, `react-dom 18.3.1`,
`tailwindcss 3.4.19` — the desktop's measured versions, deliberately. The ported
token layer and the ported skin are v5-shaped, and React 18.3.1 is inside v5's
supported range (no React 19 patch needed). v6 would move the appearance away from
the desktop, which is the one thing this migration is for.

## Provider

`app/layout.tsx` gains, in this order:

- `<AntdRegistry>` from `@ant-design/nextjs-registry`, wrapping the tree.
- one root `<ConfigProvider theme={…}>`.

The registry is not optional here: the app is `output: "export"` (a static export
served by `server.js`), and v5 styles are CSS-in-JS — without style-order
registration the export can hydrate with the wrong cascade.

No `hashPriority` is set, and that is load-bearing. antd's default wraps its
generated hash class in `:where()`, so the desktop's runtime output reads

```
:where(.css-hash).ant-dropdown .ant-dropdown-menu .ant-dropdown-menu-item
```

— three effective classes. The desktop's `mavis-*` skin rules are one class
longer and therefore win without needing `!important`. Raising the priority drops
the `:where()` and makes antd's rule four classes: a tie with the skin, decided by
document order, and antd's stylesheet is inserted last, so antd wins and the skin
silently stops applying. Measured on the running client; the extracted
stylesheets say nothing about it, because they are the skin and Tailwind, not
antd's generated CSS.

## The theme

`webapp/lib/antd-theme.ts` is the desktop's own `ConfigProvider` theme object,
transcribed verbatim from the shipped `app.asar`
(`out/_next/static/chunks/app/(pages)/(mavis)/layout-*.js`, MiniMax Code
3.0.67). It is not a reconstruction.

The load-bearing decision: **its tokens are `var(--token)` references, not hex
literals.** antd v5's cssinjs writes a token's value straight into the generated
declaration, so `colorBorder: "var(--border_default)"` emits
`border-color: var(--border_default)`. That makes the theme free of light/dark
branching:

- `styles/tokens.css` defines every referenced variable twice — once on `:root`,
  once on `.dark`;
- `app/layout.tsx` runs a blocking script before first paint that puts
  `light` / `dark` on `<html>`, and `lib/theme.ts` flips that class afterwards;
- so a theme flip re-resolves every antd surface through the same cascade that
  already drives the `mavis-*` skin and the Tailwind utilities.

There is deliberately **no `theme.darkAlgorithm`** and no client-side
`isDark` state. The desktop ships without either — the extracted bundle contains
no `darkAlgorithm` / `defaultAlgorithm` / `compactAlgorithm` reference anywhere —
and adding one would duplicate the light/dark decision in JavaScript and need its
own first-paint discipline to avoid a flash, for no gain.

Two global tokens are pinned that antd would otherwise derive from
`colorPrimary` in JavaScript (`colorPrimaryHover`,
`colorPrimaryBorderHover`); the desktop pins both to `var(--border_heavy)`, and
so does this. The `colorPrimary` **seed** is left alone, exactly as the desktop
leaves it — overriding it would re-tint the derived ramp the desktop keeps as-is.

Component tokens cover `Segmented`, `Switch`, `Form`, `Radio`, `Input`, `Select`
and `Popover`. Measured effect, with no hand-written CSS involved:

| Surface | antd rule | Resolves to (light → dark) |
| --- | --- | --- |
| `Switch` (unchecked) | `background: var(--bg_interaction_tertiary_press)` | `rgba(10,10,10,.08)` → `rgba(255,255,255,.07)` |
| `Switch` (checked) | `background: var(--icon_interaction_accent_accent)` | `#0094fc` → `#0077d9` |
| `Input` border | `border-color: var(--border_default)` | `#0a0a0a14` → `#ffffff12` |
| `Input` hover/focus | `border-color: var(--border_heavy)` | follows the token layer |
| `Popover` surface | `background-color: var(--bg_grouped_secondary_elevated)` | follows the token layer |

Switch geometry comes from the same theme (`trackHeight: 16`,
`trackMinWidth: 28`, `handleSize: 12`) rather than from a local override: the
desktop ships no `.mavis-switch` class at all. An earlier revision of this
frontend added one (36×20 track, grayscale fill) and it was **wrong** — it
silently overrode the desktop's accent-coloured switch. The file was deleted;
`styles/mavis-dropdown.css` remains the only ported skin, and it exists because
the desktop's own bundle has those rules under class names this frontend had to
reproduce.

## The skin

`webapp/styles/official-utilities.css` is the desktop's own utility layer — the
semantic type scale, markdown presentation, and **skin overrides**. It is not
antd's base CSS, and it is not what makes antd components look right:

- 91 of its rules mention an `.ant-*` class, and 86 of those are scoped under a
  `.mavis-*` ancestor (`mavis-checkbox`, `mavis-select-popup`, …); the other 5 sit
  under `.stock-auth-modal-wrap`. There is no bare `.ant-*` rule in the file.
- It carries no `mavis-user-dropdown` / `mavis-user-menu-*` rules at all, so it is
  a partial extraction: a surface's skin is only present once a ported screen
  needed it.

`.mavis-input` and `.mavis-segmented` are in that file and are byte-identical to
the desktop's own rules (checked against the extracted bundle), so components
opt into them by class alone. `.mavis-dropdown` had to be ported: the desktop
keeps it under class names this frontend had to reproduce, and the rules are not
in the utility layer.

Two consequences worth stating, because an earlier version of this document got
both wrong:

1. Those `.ant-*` blocks style our components only where we reproduce the
   ancestor class. They are skin, not cascade, so deleting one does not by itself
   change how a component renders.
2. When a surface does need the desktop's skin, the skin is **ported**: the rules
   are copied into a file next to the component that opts into them, and the JSX
   carries the same class names the desktop carries. `styles/mavis-dropdown.css`
   is the first one — the account menu's panel, rows and usage flyout, plus the
   `mavis-dropdown-custom-content` wrapper the composer's selectors need (which
   is what makes an antd `Dropdown` stop drawing its own card so the panel inside
   can draw one). Its source chunks and the live measurements are in its header.

## Component map

| Surface | Today | Target |
| --- | --- | --- |
| Account menu (trigger + rows) | absolute-positioned `div` + `MenuRow` | `Dropdown` + `Menu` — done (Phase 0 / 0.1) |
| Usage popover | hand-rolled portal + hover area | `Popover` (hover) — done (Phase 0 / 0.1) |
| Submenus (Contact us / Learn more) | hand-rolled flyout | `Menu` submenu — currently removed; re-add with `Menu` |
| Composer permission / model pickers | hand-rolled dropdown + `Menu` | `Dropdown` — done (Phase 2) |
| Attachment button | bare file input | **not converted** — see Phase 2 |
| Permission / ask / plan prompts | hand-rolled dialog | `Modal` — done (Phase 3a) |
| Right extension area | hand-rolled panel | `Drawer` |
| Context meter | hand-rolled bars | `Progress` |
| Settings card controls | hand-rolled inputs | `Input`, `Checkbox`, `Switch` |
| Session tree | hand-rolled nested list | `Tree` (or a virtualized list) |
| Alerts / inbox rows | hand-rolled list | `List` |
| Toasts | `ActionErrorBanner` | `message` / `notification` |

## Phases

Each phase is one reviewable unit: replace the hand-rolled code, keep the testids,
port the desktop's skin for the surface if it needs one, verify.

- **Phase 0 — prove the boundary. DONE.** Dependency + registry + provider, and the
  account menu converted whole (trigger, rows, usage popover). Verified: the build
  is still a static export; the browser console reports no hydration or style-order
  warning; the menu renders five items (two disabled, one a divider) with antd's
  own styling; Escape and an outside click both dismiss it; the usage popover opens
  on hover, lands inside the viewport, and shows both quota windows. What this
  deleted: ~30 lines of outside-click/Escape listener and ~80 lines of
  hover-tracking plus manual placement.

  Two implementation notes worth keeping: `MenuProps` rejects arbitrary
  attributes, so the `sidebar-user-menu` testid is attached with `popupRender`;
  and antd does not publish `aria-expanded` on a `div` child, so the trigger
  still sets it (and `aria-haspopup`) itself.
- **Phase 0.1 — the panel is the desktop's, not an approximation. DONE.** The rows
  moved onto the desktop's anatomy: antd owns the `li` (padding reset to zero,
  8px radius, hover, focus, disabled) and the row carries `.matrix-menu-item`
  plus the `p-1.5` that supplies the padding, the 18px `mavis-user-menu-icon` box,
  and the `matrix-menu-item` flex shape. The divider became a disabled item
  wrapping the desktop's hairline rather than antd's own `type: "divider"`, the
  usage row became a `Popover` on the desktop's placement and delays, and the
  flyout's rows became the desktop's two-line form (label + used% over reset) with
  the hand-rolled progress bar deleted — the desktop draws none. All of it checked
  against the running client rather than against a screenshot: panel 244×4px
  padding/12px radius/`0 0 10px 0` shadow, item 32px tall with zero padding and an
  8px radius, row 6px padding, icon box 18px, divider 8px tall with `0 8px`
  padding, flyout 222 wide with a 4px-padded 12px-radius inner and a
  `0 0 20px 0` shadow.
- **Phase 1 — the account area.** Re-add Contact us / Learn more as real `Menu`
  submenus when they have targets; the submenu skin is already ported.
- **Phase 2 — the composer's selectors. DONE.** Both pickers moved onto
  `Dropdown`, and the ~90-line hand-rolled popup they shared is gone: the portal,
  the fixed positioning, the viewport clamp, the outside-click and Escape
  listeners, and the scroll/resize repositioning were all re-implementations of
  what the library owns. `Select` was the plan and `Dropdown` is what the desktop
  uses: its composer popups are `mavis-dropdown-custom-content` — a transparent
  antd wrapper around a panel that draws its own chrome — and its rows are plain
  buttons rather than `Menu` items, so the panel is ported as custom content and
  only the shell comes from antd.

  Verified on the running client: trigger 124×32 with `0 8px` padding, a 4px gap,
  a 10px radius and 14/20 type; the chevron flips to point up while the menu shows
  (measured both states on the desktop); the wrapper resolves to transparent, no
  border, no shadow, `overflow: visible`; the panel is 160 wide with 4px padding, a
  12px radius, the elevated background, a 1px `--border_default` hairline and a
  `0 0 20px 0` shadow; rows are 28px tall with `4px 8px` padding, an 8px gap and an
  8px radius; the selected row's tick sits in a fixed 14px trailing slot. Three
  glyphs the panel needs were not in `icons.tsx` and were added from the client's
  own paths (`permissionAsk`, `permissionAuto`, `checkSmall`, plus `chevronUp`).

  The attachment button was **left as it is**, and that is a decision rather than
  an omission. Its trigger is an antd dropdown on the desktop, but what it opens is
  a seven-entry product surface — add file or image, Skills (with the skill list),
  Plugins (with the plugin list), Goal mode, Plan mode, Computer use, Browser use.
  This server backs none of those, so converting the trigger would trade one click
  for a menu with one live row out of seven and call it alignment. Recorded here so
  the next reader does not rediscover it as a bug. Its *geometry* was aligned
  (`w-8 h-8`, 32px) because that is measurable.
- **Phase 3a — the blocking prompts. DONE.** The plan / ask / authorize dialogs moved
  onto `Modal`, wearing the desktop's confirm-modal skin, which was already ported
  verbatim into `official-utilities.css`. Verified by rendering it: mask
  `rgba(0,0,0,.25)` (`#00000040`) with 10px padding, surface 520×240 with a 20px
  radius, no border and a `rgba(10,10,10,.5) 0 0 48px -12px` shadow, no close button,
  no footer, and the meta slot reading `1/2`. Blocking semantics checked as
  behaviour, not as code: Escape leaves it open and a real click on the backdrop
  leaves it open.

  Getting there needed two corrections that only a render could have found, and both
  are worth keeping:

  1. **antd's own surfaces are light.** The header came out as a white band with
     white title text on the desktop's dark panel, because the header is painted with
     antd's `colorBgElevated` and the desktop's theme object does not configure
     `Modal`. (The desktop does not need to: its own `mavis-confirm-modal-compact`
     skin already carries `background: var(--bg_grouped_secondary_elevated)`, and its
     header is covered by the same file.) This frontend already ports that skin, so
     the equivalent fix here is a local
     `styles={{ header: { background: "transparent" } }}`.
     Tokenizing the theme later did **not** change this: a token the theme does not
     name is still antd's default, and `Modal` is not among the components the desktop
     themes. If a future surface needs a dark-correct antd surface the desktop does
     not itself theme, that is a real divergence to record, not something to paper
     over with `darkAlgorithm`.
  2. **A Tailwind utility cannot override antd.** `bg-transparent` did not win: it is
     one class, while antd's rule is `:where(.css-hash).ant-modal .ant-modal-header`
     — two effective classes, because `hashPriority` is low. This is the same cascade
     fact that lets the ported skin win, from the other side: reach for `styles`,
     `classNames` on a slot antd does not paint, or a component token, never a
     utility class.

  How it was rendered matters for the next phase: the prompts are engine-driven, so
  `POST /api/debug/inject` (`DEBUG_INJECT=1`, documented as "mock state fields to
  test UI rendering in the browser") was used to drive `state.ask` through the real
  store and render the real component. That is the reachable verification path for
  every engine-driven surface.
- **Phase 3 — the surfaces around the conversation.** `Drawer` for the right
  extension area, `Progress` for the context meter, `Input` / `Checkbox` / `Switch`
  in settings. Two blockers are recorded rather than guessed at: the desktop's
  settings surface is not reachable from this build's account menu (its Settings row
  routes into an in-app section, and the one modal that does open — the update
  notice — is a hand-rolled `div`, not antd), and the confirm-modal DOM cannot be
  triggered on demand. Port the skin from the rules and verify by render, as in
  Phase 3a.
- **Phase 4 — the lists.** Session tree, alerts, panels' tables.

## Dependency procedure

1. `pnpm --filter @mavis/webui add -D antd@5.29.3 @ant-design/nextjs-registry@1.3.0`
   (pinned exactly, like every other frontend dependency in that manifest)
   (devDependencies: the webapp is compiled into the static export, nothing
   imports it at server runtime).
2. Regenerate `release/dependency-licenses.json` (its `generatedFrom` is
   `pnpm licenses list --json`) and note the additions in `THIRD_PARTY_NOTICES.md`.
   The lockfile is public; every dependency it records is published.
3. Gates: `pnpm verify`. `check:webui-bundle` guards the *server* bundle and
   rejects undeclared externals, so antd must stay out of it.

## Risks

- **Weight.** antd brings its `rc-*` tree, `@ant-design/cssinjs` and `dayjs`.
  Measured per phase: `/` went 65.3 kB → **139 kB** (Phase 0), → 140 kB (0.1), →
  141 kB (Phase 2), → **157 kB** (Phase 3a, First Load JS 258 → 274 kB). Phase 2's
  share is mostly glyphs (the permission panel's hand icon is one ~3 kB path);
  Phase 3a's 16 kB is `Modal` and the `rc-dialog` / `rc-motion` behind it. Accepted
  for parity, but re-measure each phase — a dialog shell costing 16 kB is worth
  knowing about before Phase 3's `Drawer` and `Progress` land.
- **The cascade is a three-way race.** antd's generated CSS, the desktop's ported
  skin, and Tailwind all target these elements. The skin wins by being one class
  longer — which holds only while `hashPriority` stays at its default. Change it
  and the skin stops applying with no error, which is why the measurement above is
  recorded rather than assumed.
- **Hydration.** The classic v5 + App Router pitfall is style order. The registry
  addresses it; every phase must still check the console.
- **Look drift.** The desktop's `mavis-*` classes are the skin, so the fix for a
  component that looks different after a swap is, in order: a component token, a
  `classNames` prop, or — when the desktop expresses the difference as skin rather
  than as a token — porting that surface's `mavis-*` rules next to the component.
  Never a global `.ant-*` override.
