# Design — Desktop design system and Web UI alignment contract

> **Scope.** This document is the design system of record for the MiniMax Code Web UI. It was
> extracted from the shipped desktop client, and it defines the tokens, typography, theme
> protocol, layout constants, and component contracts the Web UI must adopt.
>
> **Authority.** The **desktop client's colour system is the source of truth**. Where the Web
> UI's current theme differs, the desktop value wins and the Web UI value is to be migrated —
> see [§12](#12-migrating-the-web-ui-theme-to-the-desktop-system), which lists the current
> Web UI tokens, their desktop replacements, and the exact values.
>
> **Not in scope.** `packages/webui/server/trajectory/DESIGN.md` documents a different
> subject: the Trajectory Studio plugin's design (data sources, MCP vs Mini App, panel
> revisions). It shares a file name, not a subject. Neither document should absorb the other.
>
> **Companion.** [`ARCHITECTURE.md`](ARCHITECTURE.md) covers the measured desktop and TUI
> architecture, and the boundary between this alignment work and the Web UI's own runtime.

## 1. Evidence

Every value below was read from the desktop artifact.

| Item | Value |
| --- | --- |
| Package | `@mmx-agent/electron 3.0.73-inside.84` |
| Token source | `out/_next/static/css/5ab6aa8aadb6fce6.css` (266 KB, holds every `:root` / `.dark` mapping) |
| Theme engine | `out/_next/static/chunks/58430-c85e4e67ab933a3f.js` (injects `--mavis-*` tokens and the `data-*` protocol at runtime) |
| Syntax theme | the 35 `--code-theme-*` tokens in the same stylesheet |
| TUI palette | `packages/tui/src/tui/theme/palettes.ts`, `contracts.ts`, `syntax.ts` |

Extraction is read-only; see `ARCHITECTURE.md` §1 for the asar header format and the reader
snippet. Current Web UI values in §12 come from
`packages/webui/public/styles/main.css`.

## 2. Design principles

The desktop stylesheet is a **three-layer system**. Reproduce the layering, or alignment
degrades into copying colours.

```
① Primitive    numeric scale  --{hue}_{step}      8 families × 13 steps, identical across themes
        ↓
② Semantic     role tokens    --{role}_{...}_{state}   light and dark map to different steps
        ↓
③ Component    the mavis-* skin over antd v5 / antd-mobile
```

Five rules:

1. **Application code uses semantic tokens only.** No bare hex, no direct `--blue_400`
   reference outside the semantic definitions. This is what makes light and dark isomorphic.
2. **Every semantic token defines both light and dark.** The desktop has no dark-only token.
3. **Interaction states are complete**: `default / hover / press / inactive / selected`
   (plus `disabled` where applicable). A component missing states is unfinished.
4. **Platform and surface differences are carried by attributes**, not by stacked media
   queries — see §8.
5. **The numeric scale is a shared contract.** The TUI already uses it (§13.1), so the brand
   blue is one value across all three surfaces.

## 3. Primitive: the numeric scale

Eight colour families × 13 steps (`gray` also has `_0`), constant across light and dark.
**This is the only place a hex literal is allowed.**

```css
:root {
  /* blue — brand family */
  --blue_25: #f5fbff;  --blue_50: #e5f5ff;  --blue_75: #c4e7ff;
  --blue_100: #93d2ff; --blue_200: #68c0ff; --blue_300: #3daeff;
  --blue_400: #0094fc; --blue_500: #0077d9; --blue_600: #005fb8;
  --blue_700: #004b96; --blue_800: #00244d; --blue_900: #001226;
  --blue_1000: #000c14;

  /* cyan — orbit / decorative (the TUI's `orbit`) */
  --cyan_25: #f0fbfb;  --cyan_50: #dcf5f5;  --cyan_75: #ace7e9;
  --cyan_100: #75dcdf; --cyan_200: #1ccdd2; --cyan_300: #00bdc1;
  --cyan_400: #00a8ae; --cyan_500: #008e94; --cyan_600: #00767d;
  --cyan_700: #005e63; --cyan_800: #003a3e; --cyan_900: #001d1f;
  --cyan_1000: #000f0f;

  /* gray — the neutral axis; the only family with _0 */
  --gray_0: #fff;      --gray_50: #fafafa;  --gray_75: #f5f5f5;
  --gray_100: #ededed; --gray_200: #ccc;    --gray_300: #adadad;
  --gray_400: #949494; --gray_500: #666;    --gray_600: #4a4a4a;
  --gray_700: #303030; --gray_800: #262626; --gray_900: #1c1c1c;
  --gray_1000: #171717;

  /* green — success, diff additions */
  --green_25: #edfaf2;  --green_50: #d9f4e4;  --green_75: #a5e5bf;
  --green_100: #80e0a6; --green_200: #4ed082; --green_300: #28c567;
  --green_400: #04b54b; --green_500: #009c3d; --green_600: #008635;
  --green_700: #00692a; --green_800: #004f1f; --green_900: #082614;
  --green_1000: #001207;

  /* orange — warning */
  --orange_25: #fff6f0;  --orange_50: #ffeee3;  --orange_75: #ffd0b2;
  --orange_100: #ffb485; --orange_200: #ff9452; --orange_300: #fa8237;
  --orange_400: #f56811; --orange_500: #e25507; --orange_600: #b9480d;
  --orange_700: #923b0f; --orange_800: #4d200b; --orange_900: #311908;
  --orange_1000: #1a0a00;

  /* purple — code types and functions, video-generation status */
  --purple_25: #f9f8fe;  --purple_50: #f3f0fc;  --purple_75: #e1d7f9;
  --purple_100: #ceb9f5; --purple_200: #c29ff0; --purple_300: #b887ec;
  --purple_400: #b06add; --purple_500: #9a55c2; --purple_600: #8144a2;
  --purple_700: #693584; --purple_800: #331842; --purple_900: #1b0d27;
  --purple_1000: #090514;

  /* red — error, danger, diff deletions */
  --red_25: #fef6f7;  --red_50: #feedee;  --red_75: #ffc9ce;
  --red_100: #ffa3ab; --red_200: #ff828c; --red_300: #ff5e6c;
  --red_400: #f73646; --red_500: #e31937; --red_600: #bf152f;
  --red_700: #9e0e24; --red_800: #4d0610; --red_900: #33030a;
  --red_1000: #140003;

  /* yellow — quota and caution */
  --yellow_25: #fff9ed;  --yellow_50: #fff3d9;  --yellow_75: #ffe9b8;
  --yellow_100: #ffdb8c; --yellow_200: #ffcf66; --yellow_300: #ffc340;
  --yellow_400: #ffae00; --yellow_500: #e09900; --yellow_600: #ba7f00;
  --yellow_700: #916300; --yellow_800: #4d3400; --yellow_900: #261a00;
  --yellow_1000: #120e00;

  /* single accent, reserved for video generation */
  --violet_500: #8147f6;
}
```

**Step selection follows the desktop's own habits** — do not invent new pairings:

| Purpose | light steps | dark steps |
| --- | --- | --- |
| Primary text / icon | `_1000`, `_800` | `_100`, `_75` |
| Secondary text | `_500` | `_400` |
| Tertiary / placeholder | `_300`, `_200` | `_500`, `_600` |
| Solid primary button | `_1000` (near black) | `_0` (white) |
| Status (success / warning / error) | `_400` | `_500` |
| Status tint (tag, banner) | `_50`, `_25` | `_900`, `_800` |

## 4. Scales: radius, size, spacing

Three independent token families. Do not substitute Tailwind's default scales — the values do
not coincide.

```css
:root {
  /* radius — the number is the pixel value */
  --radius_4: 4px;   --radius_8: 8px;    --radius_12: 12px; --radius_16: 16px;
  --radius_20: 20px; --radius_24: 24px;  --radius_32: 32px; --radius_full: 999px;

  /* size — icon, control, avatar heights */
  --size_12: 12px; --size_14: 14px; --size_16: 16px; --size_20: 20px;
  --size_24: 24px; --size_32: 32px; --size_40: 40px; --size_48: 48px;
  --size_64: 64px;

  /* spacing — a 4-based scale with 2/6 granularity and 90/128 for large gutters */
  --spacing_0: 0px;   --spacing_2: 2px;   --spacing_4: 4px;   --spacing_6: 6px;
  --spacing_8: 8px;   --spacing_12: 12px; --spacing_16: 16px; --spacing_20: 20px;
  --spacing_24: 24px; --spacing_32: 32px; --spacing_40: 40px; --spacing_48: 48px;
  --spacing_64: 64px; --spacing_90: 90px; --spacing_128: 128px;
}
```

There is exactly one elevation. It is deliberately faint:

```css
/* the .shadow-s1 utility */
box-shadow: 0px var(--shadow-s1-offset-y, 4px) 16px #0000000f;
/* --shadow_default is the shadow/outline colour token, not a box-shadow value */
--shadow_default: <light #0a0a0a14 / dark #0a0a0a80>;
```

`--shadow-s1-offset-y` defaults to 4px, but the desktop sets it to 0 inside nested scroll
containers. Do the same for cards inside a scrolling list.

## 5. Semantic tokens

### 5.1 Naming

```
--{role}_{variant?}_{state?}

role    ∈ bg | text | icon | border | utility | opacity | reference | code-theme | mavis-*
variant ∈ default | grouped | interaction | status | reference | label | on
state   ∈ default | hover | press | inactive | selected
```

The three background families are the easiest thing to get wrong:

| Family | Use | Distinction |
| --- | --- | --- |
| `--bg_default_*` | page-level containers | `primary` is the page, `secondary` a block within it, `tertiary` a higher-contrast block |
| `--bg_grouped_*` | grouped lists and cards | **inverse of `default`** — in light, `default` is white and `grouped` is grey. This is how "page" and "card" are distinguished |
| `--bg_interaction_*` | interactive elements | split by semantics (`primary`, `secondary`, `tertiary`, `accent`, `danger`, `positive`, `warning`) then multiplied by state |
| `*_elevated` | the same token inside an overlay | remapped for dialogs and drawers; see §5.4 |

### 5.2 Background

**default / grouped** (`*_elevated` differs only in dark):

| Token | Light | Dark |
| --- | --- | --- |
| `--bg_default_primary` | `#fff` | `#171717` |
| `--bg_default_primary_elevated` | `#fff` | `#1c1c1c` |
| `--bg_default_scrim` | `#fafafa` | `#171717` |
| `--bg_default_secondary` | `#f5f5f5` | `#1c1c1c` |
| `--bg_default_secondary_elevated` | `#f5f5f5` | `#262626` |
| `--bg_default_tertiary` | `#fff` | `#262626` |
| `--bg_default_tertiary_elevated` | `#fff` | `#303030` |
| `--bg_grouped_primary` | `#f5f5f5` | `#171717` |
| `--bg_grouped_primary_elevated` | `#f5f5f5` | `#1c1c1c` |
| `--bg_grouped_secondary` | `#fff` | `#1c1c1c` |
| `--bg_grouped_secondary_elevated` | `#fff` | `#262626` |
| `--bg_grouped_tertiary` | `#f5f5f5` | `#262626` |
| `--bg_grouped_tertiary_elevated` | `#f5f5f5` | `#303030` |

**interaction** (39 tokens in total; the most used are listed):

| Token | Light | Dark | Note |
| --- | --- | --- | --- |
| `--bg_interaction_primary_default` | `#171717` | `#fff` | solid primary button (inverted) |
| `--bg_interaction_primary_hover` | `#0a0a0acc` | `#fffc` | |
| `--bg_interaction_primary_press` | `#0a0a0ae5` | `#ffffffe5` | |
| `--bg_interaction_primary_inactive` | `#adadad` | `#949494` | disabled |
| `--bg_interaction_secondary_default` | `#0a0a0a0a` | `#ffffff0a` | ~4% overlay |
| `--bg_interaction_secondary_hover` | `#0a0a0a14` | `#ffffff12` | |
| `--bg_interaction_secondary_selected` | `#fafafa` | `#262626` | list selection |
| `--bg_interaction_tertiary_default` | `#0a0a0a00` | `#fff0` | text button, transparent |
| `--bg_interaction_tertiary_hover` | `#0a0a0a0a` | `#ffffff0a` | |
| `--bg_interaction_accent_hover` | `#0094fc0a` | `#0064ab1a` | brand at 4% / 10% |
| `--bg_interaction_accent_press` | `#0094fc14` | `#0064ab26` | |
| `--bg_interaction_accent_focus_highlight` | `#c4e7ff` | `#00244d` | focus highlight |
| `--bg_interaction_danger_primary_default` | `#f73646` | `#e31937` | |
| `--bg_interaction_positive_default` | `#04b54b` | `#009c3d` | |
| `--bg_interaction_warning_default` | `#fa8237` | `#e25507` | |
| `--bg_interaction_video_generation_hover` | `#8147f6` | `#8147f6` | violet, video only |

**status** (tinted tags and banners):

| Token | Light | Dark |
| --- | --- | --- |
| `--bg_status_error` | `#feedee` | `#33030a` |
| `--bg_status_positive` | `#d9f4e4` | `#082614` |
| `--bg_status_warning` | `#ffeee3` | `#311908` |
| `--bg_status_blue` | `#e5f5ff` | `#0078ff1a` |
| `--bg_status_tag` | `#171717` | `#fff` |
| `--bg_status_video_generation` | `#9a55c21a` | `#9a55c21a` |

### 5.3 Text, icon, border

`text` and `icon` are separate token families with identical values. Do not merge them; they
exist so icon contrast can be tuned independently.

**`--text_default_*` / `--icon_default_*`** (hierarchy axis):

| Token | Light | Dark |
| --- | --- | --- |
| `--text_default_primary` | `#171717` | `#ededed` |
| `--text_default_secondary` | `#666` | `#949494` |
| `--text_default_tertiary` | `#adadad` | `#666` |
| `--text_default_quaternary` | `#ccc` | `#4a4a4a` |
| `--text_default_accent` | `#0094fc` | `#0077d9` |
| `--text_default_inverted` | `#fff` | `#171717` |

**`--text_label_*`** (text on buttons and labels, by semantics × state):

| Token | Light | Dark |
| --- | --- | --- |
| `--text_label_primary_default` | `#fff` | `#171717` |
| `--text_label_secondary_default` | `#666` | `#f5f5f5` |
| `--text_label_secondary_hover` | `#0a0a0a80` | `#ffffffe5` |
| `--text_label_tertiary_default` | `#adadad` | `#949494` |
| `--text_label_accent_default` | `#0094fc` | `#0077d9` |
| `--text_label_danger_secondary_default` | `#f73646` | `#e31937` |
| `--text_label_positive_secondary_default` | `#009c3d` | `#04b54b` |
| `--text_label_warning_secondary_default` | `#f56811` | `#e25507` |

**status / reference**:

| Token | Light | Dark |
| --- | --- | --- |
| `--text_status_success` | `#04b54b` | `#009c3d` |
| `--text_status_warning` | `#f56811` | `#e25507` |
| `--text_status_error` | `#f73646` | `#e31937` |
| `--text_status_blue` | `#0094fc` | `#0077d9` |
| `--text_status_banana` | `#ffae00` | `#e09900` |
| `--text_status_video_generation` | `#9a55c2` | `#9a55c2` |
| `--text_reference_neutral` | `#595959` | `#a6a6a6` |
| `--text_reference_blue` | `#0e7dcb` | `#0164aa` |
| `--text_reference_cyan` | `#008e94` | `#01767b` |
| `--text_reference_gold` | `#c97603` | `#a8670c` |
| `--text_reference_green` | `#2da55d` | `#068539` |
| `--text_reference_orange` | `#e25600` | `#bd4800` |
| `--text_reference_purple` | `#9244bf` | `#7c26ad` |
| `--text_reference_red` | `#dc3341` | `#a81c28` |

`--text_reference_*` is a deliberately desaturated set for quotations and Markdown source
annotations. Use it there; use `--text_status_*` for semantic states. They are not
interchangeable.

**border** — built from **translucent overlays, not solid greys**:

| Token | Light | Dark |
| --- | --- | --- |
| `--border_default` | `#0a0a0a14` (8% black) | `#ffffff12` (8% white) |
| `--border_light` | `#0a0a0a0a` (4%) | `#ffffff0a` (4%) |
| `--border_heavy` | `#0a0a0af2` (95%) | `#fffffff2` (95%) |
| `--border_accent` | `#0094fc` | `#0077d9` |
| `--border_status_error` | `#feedee` | `#33030a` |
| `--border_status_success` | `#d9f4e4` | `#082614` |
| `--border_status_warning` | `#ffeee3` | `#311908` |
| `--border_status_blue` | `#e5f5ff` | `#004b96` |

The base colour is `#0a0a0a`, not pure black, and alpha comes from the `--opacity_black_1_*`
family.

### 5.4 Overlay remapping

Inside an overlay (`dialog`, `[role=dialog]`, `.ant-modal-content`, …) the desktop remaps
`--bg_default_*` and `--bg_grouped_*` to their `*_elevated` variants:

```css
:root[data-mavis-desktop-palette]
  :is(dialog,[role=dialog],[role=alertdialog],.ant-modal-content,...) {
  --bg_default_primary: var(--mavis-overlay-bg_default_primary);
  /* … the whole bg_* family */
}
```

The overlay layer itself is derived with CSS relative colour syntax, so it inherits the theme
automatically:

```css
--mavis-overlay-bg_default_primary:
  rgb(from var(--bg_default_primary) r g b / <alpha>);
```

**Web UI implementation:** put a `data-surface="overlay"` scope on the root element of modal,
drawer, and popover components, and remap `--bg_*` to the elevated variants inside it. One
card definition then works both inline and inside a dialog.

### 5.5 Utility and opacity

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--utility_overlay` | `#00000040` | `#0000003d` | scrim behind modals |
| `--utility_scrim` | `#ffffff80` | `#00000080` | frosted background |
| `--utility_popover` | `#0a0a0ae5` | `#fffffff2` | popover surface |
| `--utility_tootip` | `#0a0a0af2` | `#0a0a0af2` | tooltip surface (spelling preserved from source) |
| `--utility_scrollbar` | `#0a0a0a26` | `#ffffff26` | scrollbar thumb |

Opacity scale, based on `#0a0a0a` rather than `#000`:

```
--opacity_black_1_{0,2,4,8,15,20,25,50,70,80,90,95}
--opacity_white_0_{0,2,4,8,15,20,25,50,70,80,90,95}
--opacity_purple_500_10: #9a55c21a
```

The suffix is the alpha percentage: `--opacity_black_1_8` is 8% black.

## 6. Typography

### 6.1 Families

```css
:root {
  --mcode-font-family-ui:
    "HarmonyOS Sans", "Segoe UI", "SF Pro Display", -apple-system,
    BlinkMacSystemFont, Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans",
    "Helvetica Neue", sans-serif;
  --mcode-font-family-code:
    Hack, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
    "HarmonyOS Sans SC", "PingFang SC", monospace;
}
```

- **UI**: HarmonyOS Sans first, then platform UI fonts.
- **Code**: Hack first, then the generic mono stack. The desktop also ships a **JetBrains Mono**
  webfont (`out/fonts/jetbrains-mono/`); prefer it for code blocks.
- **CJK**: the mono stack explicitly lists `HarmonyOS Sans SC` and `PingFang SC`. Keep both —
  without them, mixed Chinese/English text falls back to a serif for the Chinese runs.
- Decorative faces (`Home Hover WenKai`, `Home Hover Caveat`, `SourceSerif`) are for the
  desktop home page only and are not part of this contract.

### 6.2 Type scale

The desktop injects its type scale at runtime as `--mavis-*` tokens, derived from a scale
object (`body`, `small`, `assist`, `h1`–`h6`, `tableHeader`, `tableCell`, `titleMedium`,
`remoteGoal`, `block`, each with `fontSize` and `lineHeight`).

Measured values in **desktop typography mode**:

| Role | Size | Line height | Token |
| --- | --- | --- | --- |
| body | 14px | 22.75px | `--mavis-markdown-body-size` / `-line-height` |
| h1 | 21px | — | `--mavis-markdown-h1-size` |
| h2 | 17.5px | — | `--mavis-markdown-h2-size` |
| h3 | 15.75px | — | `--mavis-markdown-h3-size` |
| table cell | 13px | — | `--mavis-markdown-table-cell-size` |
| code block | 12px | 20px | `--mavis-code-block-font-size` / `--mavis-code-line-height` |
| inline code | `1em` scale | — | `--mavis-inline-code-font-size` |
| caption | 12px | — | `--text-caption-size` fallback |

Compact variants used inside the chat transcript:

| Variant | body | h1/h2/h3 | code |
| --- | --- | --- | --- |
| `.matrix-markdown--compact` | 13px / 20px | 13px | 12px |
| `.matrix-markdown--thinking` | 14px | 14px | 13px |

Weights:

```css
--mavis-font-weight-normal:   <400>;
--mavis-font-weight-default:  <400>;
--mavis-font-weight-medium:   <500>;
--mavis-font-weight-semibold: <600>;   /* headings */
--mavis-font-weight-bold:     <700>;
--mavis-font-weight-ui-normal: var(--mavis-body-font-weight, <400>);
```

Markdown spacing inside chat (separate from the global spacing scale):

| Token | Value |
| --- | --- |
| `--md-chat-gap-code` | 14px |
| `--md-chat-gap-related` | 10px |
| `--md-chat-gap-short-paragraph` | 11px |
| `--md-chat-blockquote-indent` | 24px |
| `--md-block-gap` | `--md-spacing-lg` (`--md-spacing-md` in the thinking variant) |
| `--md-letter-spacing-*` | all `0` |

Every letter-spacing token is `0`. The desktop deliberately does **not** apply negative
tracking; do not add `letter-spacing: -0.02em` for a "modern" look.

### 6.3 Locale changes layout

```css
:root {
  --chat-input-height-en: 110px;
  --chat-input-height-zh: 146px;
  --chat-list-width: 792px;
}
```

The Chinese input area is 36px taller than the English one, to accommodate candidate and
multi-line input. Reproduce this branch: a single height leaves Chinese users cramped and
English users with dead space.

## 7. Theme protocol

The desktop applies themes at runtime by writing CSS custom properties onto
`document.documentElement` and switching scope with `data-*` attributes.

### 7.1 State model

```
theme             : 'light' | 'dark' | 'system'
themePackId       : string            default 'mcode-default'
visualThemeSource : 'pack' | 'wallpaper'
appearancePreferences: {
  colors: { light: { accentPreset }, dark: { accentPreset } },
  uiFontFamily, codeFontFamily, uiFontWeight, codeFontWeight,
  density: 'comfortable' | ...,
  chatContentWidth: 'standard' | ...,
}
```

### 7.2 DOM application

```js
// 1) appearance: html class AND colorScheme — both are required
document.documentElement.classList.toggle('dark', isDark);
document.documentElement.classList.toggle('light', !isDark);
document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';

// 2) semantic tokens, cached by revision, written one by one
for (const [k, v] of Object.entries(resolveTokens(mode))) root.style.setProperty(`--${k}`, v);
for (const [k, v] of Object.entries(codeTheme)) root.style.setProperty(`--code-theme-${k}`, v);

// 3) hand the appearance to the native layer (Electron only)
window.electronAPI?.setNativeThemeSource?.(theme);
```

### 7.3 The `data-mavis-*` attribute protocol

| Attribute | Values | Meaning |
| --- | --- | --- |
| `data-mavis-theme-pack` | pack id | active theme pack |
| `data-mavis-default-accent` | `"true"` \| absent | using the default accent |
| `data-mavis-theme-recipe` | `"active"` \| absent | theme recipe follows the pack |
| `data-mavis-icon-style` | style id | icon style follows the recipe |
| `data-mavis-theme-density` | `comfortable`, … | density |
| `data-mavis-chat-width` | `standard`, … | chat content width (omitted when standard) |
| `data-mavis-ui-font-family` | `"custom"` \| absent | UI font overridden |
| `data-mavis-code-font-family` | `"custom"` \| absent | code font overridden |
| `data-mavis-ui-font-weight` | `"custom"` \| absent | UI weight overridden |
| `data-mavis-code-font-weight` | `"custom"` \| absent | code weight overridden |
| `data-mavis-desktop-palette` | revision string | desktop palette injected (overlay scope) |
| `data-mavis-surface` | `web` \| `native` | **surface type** |
| `data-mavis-wallpaper` | `"active"` | wallpaper mode |
| `data-mavis-stream-reveal-active` | `"true"` | streaming reveal in progress |
| `data-mavis-stream-reveal-owner` | `waapi` | reveal driven by the Web Animations API |

Platform classes on `html`: `mavis-platform-electron` (349 uses),
`mavis-desktop-typography-enabled` (283), `mavis-desktop-palette` (470).

### 7.4 `data-mavis-surface` — the three-surface anchor

The desktop stylesheet **already contains a web surface variant**:

```css
:where(:root[data-mavis-surface=web]) .message-container-chat-content .matrix-markdown {
  --md-chat-gap-code: 14px;
  --md-chat-gap-related: 10px;
  --md-chat-gap-short-paragraph: 11px;
  --md-chat-blockquote-indent: 24px;
}
```

Measured: 68 references to `data-mavis-surface=web`, 10 to `=native`. The design system was
built for multiple surfaces. The Web UI should therefore declare it:

```html
<html data-theme="dark" data-mavis-surface="web" style="color-scheme: dark">
```

The attribute has no effect until the desktop stylesheet is present, but declaring it now
keeps the door open for reusing those rules, and it makes the surface explicit in the DOM.

### 7.5 What the Web UI already has

`packages/webui/public/styles/main.css` implements its own equivalent: `data-theme="light|dark"`
on `:root`, a `@media (prefers-color-scheme: dark)` fallback guarded by
`:root:not([data-theme="light"])`, and `localStorage["webui-theme"]`.

Keep that mechanism. It already solves the flash-of-wrong-theme problem and is dependency-free.
The migration in §12 changes token **values and names**, not this mechanism. Adding
`style.colorScheme` alongside `data-theme` is the one behavioural improvement worth making,
because it fixes native form controls and scrollbars.

## 8. Layout

### 8.1 Application shell

| Token | Value | Note |
| --- | --- | --- |
| `--header-height` | `60px` | a compact `:root` override sets `54px` |
| `--left-model-width` | `280px` | override `331px` |
| `--right-model-width` | `480px` | right panel |
| `--chat-list-width` | `792px` | session list |
| `--chat-input-height-en` | `110px` | |
| `--chat-input-height-zh` | `146px` | |
| `--share-top-bar-height` | `70px` | share view |
| `--share-bottom-bar-height` | `70px` | share view |
| `--screen` | `100vh` | |
| `--harmony-bottom-bar` | `0px` → `env(safe-area-inset-bottom)` | mobile safe area |

### 8.2 Sidebar

Measured behaviour from the renderer:

- Default width **220px** (a 240px variant exists); the file-panel sidebar
  (`--file-panel-sidebar-width`) defaults to **320px**, or 220px when no file panel is open.
- **Minimum width 220px**: dragging clamps with `Math.max(220, Math.min(max, next))`.
- Collapsed width is **0**.
- Layout gutter is **16px** (`sidebarLayoutGutter`), 0 in some contexts.
- **Minimum content width 460px** (`minContentWidth`).
- The drag result is written back with
  `document.documentElement.style.setProperty('--file-panel-sidebar-width', …)` and removed
  when collapsed.

Write the width to a CSS variable during drag rather than to component state — the desktop
does this to avoid re-rendering on every frame.

### 8.3 Reading width

The chat area sizes itself with **container query units**:

```css
--chat-table-viewport-width: calc(100cqi - 32px);
--chat-table-reading-width: 736px;
--chat-table-gutter: max(0px, calc((100cqi - 768px) / 2));
```

Reading width is 736px, centred once the container exceeds 768px, with 16px inline padding.
Tables add scroll affordances:

```css
--table-fade-left: 0px | 32px;    /* becomes 32px when overflowing */
--table-fade-right: 0px | 32px;
--table-scrollbar-max-thumb-width: 160px;
```

Use `100cqi`, not `100vw`: with a sidebar present the viewport width is not the content width.
The chat container needs `container-type: inline-size`.

### 8.4 Settings modal

| Context | Width | Sidebar | Height | Class |
| --- | --- | --- | --- | --- |
| Web | 940px | 220px | 600px | `mavis-settings-modal-web` |
| Electron | 940px | 220px | **700px** | `mavis-settings-modal-electron` |
| Narrow / mobile | `100vw` | 260px | `100vh` | |

Use the web row: 940 × 600 with a 220px sidebar.

## 9. Components

```
mavis-* skin (application code uses this layer)
    ├── over antd v5 (Button, Modal, Select, Dropdown, Picker, Checkbox, Input,
    │                 Progress, Tooltip, Popover, Message)
    └── over antd-mobile (Grid, Selector, Mask) for compact surfaces
```

Measured `mavis-*` classes, by reference count:

| Class | Count | Base |
| --- | --- | --- |
| `mavis-button` | 218 | antd `Button` |
| `mavis-dropdown`, `-root-sub-menu` | 117, 67 | antd `Dropdown` |
| `mavis-chat-markdown-flow` | 106 | custom |
| `mavis-modal-wrap` | 103 | antd `Modal` |
| `mavis-settings-modal-electron` | 97 | custom |
| `mavis-surface` | 78 | custom |
| `mavis-input`, `-no-border` | 71, 20 | antd `Input` |
| `mavis-select`, `-popup` | 61, 42 | antd `Select` |
| `mavis-textarea`, `-no-border` | 61, 30 | antd `Input.TextArea` |
| `mavis-checkbox`, `--round` | 54, 51 | antd `Checkbox` |
| `mavis-popover-overlay` | 34 | antd `Popover` |
| `mavis-radio` | 20 | antd `Radio` |
| `mavis-compact-switch` | 16 | antd `Switch` |
| `mavis-time-picker-popup` | 17 | antd `TimePicker` |
| `mavis-settings-content-body`, `-control` | 27, 23 | custom |
| `mavis-theme-pack-trigger`, `-menu-option` | 24, 29 | custom |

The Web UI does not need antd. It **does** need the same semantic layer: each component binds
its states to the token table below, so the visual result matches rather than merely
resembling the desktop.

| Component semantics | default | hover | press | inactive | selected |
| --- | --- | --- | --- | --- | --- |
| Primary button | `--bg_interaction_primary_default` | `_hover` | `_press` | `_inactive` | — |
| Secondary button | `--bg_interaction_secondary_default` | `_hover` | `_press` | `_inactive` | `_selected` |
| Text button | `--bg_interaction_tertiary_default` | `_hover` | `_press` | `_inactive` | `_selected` |
| Brand / link | `--bg_interaction_accent_default` | `_hover` | `_press` | `_inactive` | — |
| Danger | `--bg_interaction_danger_primary_default` | `_hover` | `_press` | `_inactive` | — |
| Primary label | `--text_label_primary_default` | `_hover` | `_press` | `_inactive` | `_selected` |
| Secondary label | `--text_label_secondary_default` | `_hover` | `_press` | `_inactive` | `_selected` |
| Button icon | `--icon_interaction_primary_default` | `_hover` | `_press` | `_inactive` | `_selected` |
| Outline | `--border_default` | — | — | `--border_light` | — |
| Focus ring | `--bg_interaction_accent_focus_blue` / `--border_accent` | — | — | — | — |

## 10. Code blocks and syntax highlighting

The desktop defines **35 independent `--code-theme-*` tokens**, mapped to the numeric scale
per theme. Do not ship a third-party default theme.

| Token | Light | Dark |
| --- | --- | --- |
| `--code-theme-default` | `--gray_800` `#262626` | `--gray_100` `#ededed` |
| `--code-theme-muted` | `--gray_500` `#666` | `--gray_400` `#949494` |
| `--code-theme-comment` | `--gray_500` `#666` | `--gray_400` `#949494` |
| `--code-theme-keyword` | `--red_500` `#e31937` | `--red_300` `#ff5e6c` |
| `--code-theme-tag` | `--red_500` `#e31937` | `--red_300` `#ff5e6c` |
| `--code-theme-string` | `--green_700` `#00692a` | `--green_300` `#28c567` |
| `--code-theme-number` | `--blue_500` `#0077d9` | `--blue_200` `#68c0ff` |
| `--code-theme-attribute` | `--blue_500` `#0077d9` | `--blue_200` `#68c0ff` |
| `--code-theme-regex` | `--blue_700` `#004b96` | `--blue_300` `#3daeff` |
| `--code-theme-function` | `--purple_600` `#8144a2` | `--purple_300` `#b887ec` |
| `--code-theme-type` | `--purple_600` `#8144a2` | `--purple_300` `#b887ec` |
| `--code-theme-decorator` | `--purple_600` `#8144a2` | `--purple_300` `#b887ec` |
| `--code-theme-property` | `--orange_700` `#923b0f` | `--orange_200` `#ff9452` |
| `--code-theme-builtin` | `--orange_700` `#923b0f` | `--orange_200` `#ff9452` |
| `--code-theme-constant` | `--orange_700` `#923b0f` | `--orange_200` `#ff9452` |
| `--code-theme-invalid` | `--red_500` `#e31937` | `--red_400` `#f73646` |
| `--code-theme-addition-background` | `--green_25` `#edfaf2` | `--green_900` `#082614` |
| `--code-theme-addition-foreground` | `--green_500` `#009c3d` | `--green_400` `#04b54b` |
| `--code-theme-deletion-background` | `--red_50` `#feedee` | `--red_900` `#33030a` |
| `--code-theme-deletion-foreground` | `--red_500` `#e31937` | `--red_400` `#f73646` |

The remaining tokens (`class`, `method`, `namespace`, `enum-member`, `operator`, `parameter`,
`punctuation`, `variable`, `variable-constant`, `variable-default-library`) **alias** the
tokens above; do not define them twice:

```css
--code-theme-class: var(--code-theme-type);
--code-theme-method: var(--code-theme-function);
--code-theme-namespace: var(--code-theme-property);
--code-theme-variable: var(--code-theme-property);
--code-theme-operator: var(--code-theme-muted);
--code-theme-punctuation: var(--code-theme-muted);
--code-theme-parameter: var(--code-theme-muted);
```

## 11. TUI to Web UI mapping

The Web UI's **feature structure** comes from the TUI; its **visual language** comes from the
desktop. This section joins the two.

### 11.1 TUI theme contract to desktop tokens

The TUI's `TuiThemeColors` (`packages/tui/src/tui/theme/contracts.ts`) has 20 semantic
colours. Measured: **the TUI palette is drawn from the same numeric scale as the desktop**,
which is the existing basis for cross-surface consistency.

| TUI token | TUI dark | Scale | TUI light | Scale | Desktop target |
| --- | --- | --- | --- | --- | --- |
| `brand` | `#68C0FF` | `--blue_200` | `#0094FC` | `--blue_400` | `--text_default_accent` / `--icon_default_accent` |
| `wordmarkHighlight` | `#93D2FF` | `--blue_100` | `#3DAEFF` | `--blue_300` | wordmark highlight |
| `wordmarkShadow` | `#3DAEFF` | `--blue_300` | `#0077D9` | `--blue_500` | wordmark shadow |
| `signal` | `#68C0FF` | `--blue_200` | `#0094FC` | `--blue_400` | running indicator |
| `orbit` | `#1CCDD2` | `--cyan_200` | `#00767D` | `--cyan_600` | no desktop equivalent; keep as its own token |
| `accent` | `#68C0FF` | `--blue_200` | `#0094FC` | `--blue_400` | `--bg_interaction_accent_*` |
| `markdownHeading` | `#CBA6F7` | Catppuccin mauve | `#8839EF` | Catppuccin | `--text_default_primary` (desktop headings are not tinted) |
| `markdownCode` | `#A6E3A1` | Catppuccin green | `#267A3F` | custom | `--code-theme-string` |
| `markdownLink` | `#68C0FF` | `--blue_200` | `#0066CC` | custom | `--text_default_accent` |
| `userMessageBg` | `#262626` | `--gray_800` | `#F5F5F5` | `--gray_75` | `--bg_default_secondary` |
| `diffAddedBg` | `#213A2B` | custom | `#DAFBE1` | custom | `--code-theme-addition-background` |
| `diffRemovedBg` | `#4A221D` | custom | `#FFEBE9` | custom | `--code-theme-deletion-background` |
| `text` | `#D6D6D6` | custom | `#303030` | `--gray_700` | `--text_default_primary` |
| `muted` | `#ADADAD` | `--gray_300` | `#666666` | `--gray_500` | `--text_default_secondary` |
| `dim` | `#666666` | `--gray_500` | `#949494` | `--gray_400` | `--text_default_tertiary` |
| `border` | `#303030` | `--gray_700` | `#EDEDED` | `--gray_100` | `--border_default` |
| `line` | `#666666` | `--gray_500` | `#949494` | `--gray_400` | `--border_default` (dividers) |
| `success` | `#28C567` | `--green_300` | `#008635` | `--green_600` | `--text_status_success` |
| `warning` | `#FFC340` | `--yellow_300` | `#916300` | `--yellow_700` | `--text_status_warning` |
| `error` | `#FF5E6C` | `--red_300` | `#E31937` | `--red_500` | `--text_status_error` |

Three real differences to resolve:

1. **Dark status colours**: the TUI uses `_300` (`#28C567`, `#FFC340`, `#FF5E6C`); the desktop
   uses `_500` (`#009c3d`, `#e25507`, `#e31937`). Bright colours read better in a terminal;
   on the web, follow the desktop.
2. **Markdown headings**: the TUI tints headings, code, and links (Catppuccin); the desktop
   does not tint headings at all.
3. **`text` and `diff*Bg` are hand-tuned** and sit outside the scale. Replace them with the
   desktop tokens.

### 11.2 Syntax theme

The TUI uses **Catppuccin** for `cli-highlight` (`packages/tui/src/tui/theme/syntax.ts`):

```
tone:  blue flamingo green mauve overlay2 peach pink red sapphire subtext0 teal text yellow
dark:  #89B4FA #F2CDCD #A6E3A1 #CBA6F7 #9399B2 #FAB387 #F5C2E7 #F38BA8 #74C7EC #A6ADC8 #94E2D5 #CDD6F4 #F9E2AF
light: #1E66F5 #DD7878 #40A02B #8839EF #7C7F93 #FE640B #EA76CB #D20F39 #209FB5 #6C6F85 #179299 #4C4F69 #DF8E1D
```

It also maps down to ANSI16, because pastel colours collapse to white there.

The desktop and the TUI therefore ship **two different code themes**. Per the authority rule at
the top of this document, the Web UI uses the desktop's `--code-theme-*` (§10). Converging the
TUI is a separate change.

### 11.3 TUI components to web components

| TUI component | Semantics | Web UI |
| --- | --- | --- |
| `box.ts` | bordered container | card / panel — `--radius_12`, `--border_default` |
| `stack.ts`, `v-stack.ts`, `h-stack.ts` | layout primitives | flex containers, `--spacing_*` |
| `text.ts`, `truncated-text.ts` | text, truncation | text / `truncate`, keep a tooltip when truncated |
| `input.ts` | single-line input | input |
| `editor.ts` | multi-line editor | textarea |
| `markdown.ts` | Markdown rendering | Markdown renderer, `--md-*` spacing, `--code-theme-*` |
| `scroll-view.ts` | scroll region | scroll container, `--utility_scrollbar` |
| `select-list.ts` | selection list | select / command palette |
| `settings-list.ts` | settings rows | settings panel (940 × 600) |
| `loader.ts`, `cancellable-loader.ts` | loading | spinner / skeleton; cancellable work needs a visible cancel |
| `image.ts` | terminal image | `<img>` |
| `spacer.ts` | spacer | spacer |
| `alt-screen-flash.ts` | full-screen flash | toast |

### 11.4 Status line

The TUI status line is a configurable item list (`packages/tui/docs/status-line-config.md`,
key `tui.statusLine`; array order is display order). Mirror the item catalogue and its
ordering semantics:

| Item ID | Display | Web UI placement |
| --- | --- | --- |
| `current-dir` | working directory | left of the status bar |
| `session-title` | session title | top bar |
| `git-branch` | current branch | status bar |
| `review-link` | linked PR/MR | status bar (clickable) |
| `plan-mode` | plan mode | status bar badge |
| `approval-mode` | permission / approval mode | status bar badge |
| `model`, `model-with-reasoning` | model and reasoning level | above the composer, or the status bar |
| `context-window` | context capacity | ring or bar |
| `subagent` | subagent indicator | status bar |
| `token-quota` | quota / plan | status bar |
| `build-mode` | `[V]` machine-readable protocol | automation mode; **owns the entire line** |

Preserve the rules: unlisted items are hidden; an empty array hides the line; duplicate IDs
keep the first; unknown IDs are ignored silently; `build-mode` owns the whole line.

### 11.5 Command palette

The TUI's 40 slash commands (`packages/tui/src/tui/commands/catalog.ts`) map to command
palette entries, keeping their grouping:

```
sessions   sessions history fork rewind rename archive transcript copy retry edit
tasks      tasks queue stop steer goal plan decision
permissions permission permissions allow always deny
config     config settings statusline hotkeys provider plugins add-dir reload
account    login logout checkin
feedback   feedback btw
other      update changelog review parent
```

### 11.6 Panels

| TUI source | Feature | Web UI |
| --- | --- | --- |
| `tui/agent-team/{model,panel,summary}.ts` | multi-agent team | agent-team panel |
| `tui/background-work/panel.ts` | background work | background tasks drawer |
| `tui/automation/*` | turn results | task result cards + status store |
| `tui/controller/*` | session, delegation, projection | client state (see `packages/webui/docs/ARCHITECTURE.md`) |

## 12. Migrating the Web UI theme to the desktop system

`packages/webui/public/styles/main.css` currently implements a theme it calls **"Ink & Paper"
v3**: a deliberately monochrome palette — neutral surfaces, a near-black / near-white accent,
and desaturated semantic colours (`--success` and `--warning` are greys).

**Under this document's authority rule, that palette is replaced by the desktop's.** The table
below is the migration: current Web UI token → desktop token → the value to adopt.

| Current Web UI token | Light now | Dark now | Desktop token | Light | Dark |
| --- | --- | --- | --- | --- | --- |
| `--bg` | `#fafafa` | `#0b0b0c` | `--bg_default_primary` | `#fff` | `#171717` |
| `--bg-elevated` | `#ffffff` | `#141416` | `--bg_default_primary_elevated` | `#fff` | `#1c1c1c` |
| `--bg-sidebar` | `#f4f4f5` | `#101012` | `--bg_default_secondary` | `#f5f5f5` | `#1c1c1c` |
| `--bg-hover` | `#ededee` | `#1c1c1f` | `--bg_interaction_secondary_hover` | `#0a0a0a14` | `#ffffff12` |
| `--bg-active` | `#e2e2e4` | `#26262a` | `--bg_interaction_secondary_press` | `#0a0a0a26` | `#ffffff0a` |
| `--bg-input` | `#ffffff` | `#131315` | `--bg_default_tertiary` | `#fff` | `#262626` |
| `--text` | `#1a1a1c` | `#ececee` | `--text_default_primary` | `#171717` | `#ededed` |
| `--text-secondary` | `#5f5f66` | `#a2a2a8` | `--text_default_secondary` | `#666` | `#949494` |
| `--text-tertiary` | `#98989e` | `#6d6d74` | `--text_default_tertiary` | `#adadad` | `#666` |
| `--border` | `#e2e2e4` | `#26262a` | `--border_default` | `#0a0a0a14` | `#ffffff12` |
| `--border-light` | `#ededee` | `#1d1d20` | `--border_light` | `#0a0a0a0a` | `#ffffff0a` |
| **`--accent`** | `#17171a` | `#f4f4f5` | **`--text_default_accent`** | **`#0094fc`** | **`#0077d9`** |
| `--accent-hover` | `#000000` | `#ffffff` | `--text_label_accent_hover` | `#3daeff` | `#0094fc` |
| `--accent-bg` | `#ededee` | `rgba(244,244,245,.10)` | `--bg_interaction_accent_hover` | `#0094fc0a` | `#0064ab1a` |
| `--accent-text` | `#2a2a2e` | `#e4e4e7` | `--text_label_accent_default` | `#0094fc` | `#0077d9` |
| `--on-accent` | `#ffffff` | `#101012` | `--text_label_primary_default` | `#fff` | `#171717` |
| **`--success`** | `#75757c` | `#9d9da3` | **`--text_status_success`** | **`#04b54b`** | **`#009c3d`** |
| **`--warning`** | `#4f4f56` | `#c8c8cd` | **`--text_status_warning`** | **`#f56811`** | **`#e25507`** |
| **`--danger`** | `#bf5645` | `#cc6b5c` | **`--text_status_error`** | **`#f73646`** | **`#e31937`** |
| `--status-on` | `#1e9e5a` | `#3fbf7f` | `--text_status_success` | `#04b54b` | `#009c3d` |
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,.05)` | `…0.35` | `.shadow-s1` | `0 4px 16px #0000000f` | same |
| `--shadow-md` | `0 4px 14px rgba(0,0,0,.09)` | `…0.45` | `.shadow-s1` | same | same |
| `--shadow-lg` | `0 14px 38px rgba(0,0,0,.14)` | `…0.55` | — | desktop has one elevation | — |
| `--user-accent` | `#17171a` | `#f4f4f5` | `--text_default_accent` | `#0094fc` | `#0077d9` |
| `--accent-glow` | `rgba(23,23,26,.10)` | `rgba(244,244,245,.12)` | `--bg_interaction_accent_press` | `#0094fc14` | `#0064ab26` |
| `--hairline` | `rgba(26,26,28,.08)` | `rgba(236,236,238,.08)` | `--border_default` | `#0a0a0a14` | `#ffffff12` |
| `--font-mono` | `ui-monospace, "Cascadia Code", …` | same | `--mcode-font-family-code` | `Hack, ui-monospace, …` | same |
| `--radius-sm` | `6px` | `6px` | `--radius_8` | `8px` | `8px` |
| `--radius-md` | `10px` | `10px` | `--radius_12` | `12px` | `12px` |
| `--radius-lg` | `14px` | `14px` | `--radius_16` | `16px` | `16px` |

The four rows in bold are the visible identity change: the accent becomes brand blue instead
of near-black, and success / warning / danger become real colours instead of greys. Everything
else is a value refinement that keeps the layout intact.

### 12.1 Migration order

1. Add the primitive scale (§3) and the scales (§4) to `main.css` under `:root`.
2. Add the semantic tokens (§5) with both theme values.
3. Repoint existing component rules from the current names to the semantic names. Keeping the
   old names as aliases for one release reduces the diff and lets the change be reviewed
   incrementally:

   ```css
   :root[data-theme="light"] {
     --bg: var(--bg_default_primary);
     --text: var(--text_default_primary);
     --accent: var(--text_default_accent);
     --success: var(--text_status_success);
     /* … */
   }
   ```

4. Adopt the typography scale (§6), including the CJK font stack and the locale-dependent
   input height.
5. Replace the code block theme with `--code-theme-*` (§10).
6. Remove the aliases once no rule references them.

### 12.2 What does not change

- The theme mechanism: `data-theme` on `:root`, the `prefers-color-scheme` fallback, and
  `localStorage["webui-theme"]` stay as they are (§7.5).
- The zero-dependency constraint: this is plain CSS and DOM. See `ARCHITECTURE.md` §5.1.
- Layout structure and component markup. This is a token and value change.

## 13. Acceptance checklist

- [ ] The primitive scale, radius, size, and spacing tokens exist under `:root`.
- [ ] Application rules reference semantic tokens only — `grep` for bare hex and for direct
      `--blue_*` / `--gray_*` references outside the token definitions returns nothing.
- [ ] Every semantic token defines both light and dark.
- [ ] Every interactive component covers `default / hover / press / inactive / selected`.
- [ ] Overlays remap `--bg_*` to the `*_elevated` variants (§5.4).
- [ ] Borders use translucent `--border_default`, not solid greys.
- [ ] The accent is the brand blue, not a near-black or near-white value.
- [ ] `--success` / `--warning` / `--danger` are real semantic colours.
- [ ] The Chinese locale uses the taller input area (146px) and the English locale 110px.
- [ ] The chat area sizes with container query units, reading width 736px.
- [ ] Code blocks use `--code-theme-*`, not a third-party default theme.
- [ ] Mixed Chinese/English text falls back to `HarmonyOS Sans SC` / `PingFang SC`.
- [ ] Status line items follow the TUI ordering, hiding, and exclusivity rules.
- [ ] The command palette covers the TUI's 40 slash commands.
- [ ] `style.colorScheme` is set alongside `data-theme`.
- [ ] `data-mavis-surface="web"` is declared on `html`.

## Appendix: token inventory

| Family | Count | Notes |
| --- | --- | --- |
| Primitive scale | 136 | 8 families × 13 steps + `violet_500` |
| `--bg_*` | 61 | default / grouped / interaction / status / reference |
| `--text_*` | 64 | default / label / status / reference |
| `--icon_*` | 54 | default / interaction / status |
| `--border_*` | 16 | |
| `--utility_*` | 5 | |
| `--opacity_*` | 25 | |
| `--reference_*` | 16 | |
| `--code-theme-*` | 35 | syntax highlighting |
| `--radius_*`, `--size_*`, `--spacing_*` | 7, 9, 15 | scales |
| `--md-*` | ~30 | Markdown and chat typography |
| `--mavis-*` (runtime) | ~60 | type scale, overlay, search, selection, turn navigator |
