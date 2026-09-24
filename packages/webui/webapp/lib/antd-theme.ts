import type { ThemeConfig } from "antd";

/**
 * antd theme — the desktop's own `ConfigProvider` theme, extracted verbatim.
 *
 * ## Why this file exists
 *
 * The desktop client runs the same antd v5 build as this webui, under the same
 * `mavis-*` skin. Its `ConfigProvider` theme object is the one place where antd's
 * design tokens are reconciled with the extracted design-token layer, and it is
 * not something to invent: the shipped `app.asar` carries it, and this file is
 * that object, transcribed.
 *
 * Provenance: `app.asar` → `out/_next/static/chunks/app/(pages)/(mavis)/layout-*.js`,
 * the `theme:{…}` literal handed to `(0,l.jsx)(tc.ZP,{theme:…})` inside the
 * pricing/deep-link provider (`rI`). Transcribed 2026-09-24 from
 * MiniMax Code 3.0.67 (`app-64`).
 *
 * ## The load-bearing idea: antd tokens are CSS variables, not colors
 *
 * Almost every value below is a `var(--token)` reference rather than a hex
 * literal. antd v5's cssinjs writes a token's value straight into the generated
 * declaration, so `colorBorder: "var(--border_default)"` emits
 * `border-color: var(--border_default)`. That single fact is what makes this
 * theme *free* of light/dark branching:
 *
 *   - `styles/tokens.css` defines every one of these variables twice — once on
 *     `:root` (light) and once on `.dark` (dark).
 *   - `app/layout.tsx` runs a blocking script before first paint that puts
 *     `light` / `dark` on `<html>`; `lib/theme.ts` flips that class afterwards.
 *   - Therefore a theme flip re-resolves every antd surface through the same
 *     cascade that already drives the `mavis-*` skin and the Tailwind utilities.
 *
 * The alternative — `theme.darkAlgorithm` plus a client-side `isDark` state fed
 * to `ConfigProvider` — would duplicate the light/dark decision in JS, and would
 * need its own first-paint discipline to avoid a flash, for no gain: the desktop
 * ships without it, and the extracted `app.asar` contains no `darkAlgorithm`,
 * `defaultAlgorithm` or `compactAlgorithm` reference anywhere.
 *
 * ## Why the seed is left alone
 *
 * antd's global `colorPrimary` seed is *not* overridden here, and neither does
 * the desktop override it. The base ramp antd derives from its own default seed
 * stays as-is; every surface the desktop actually paints is bound to a token
 * variable in the `components` block below (or by the `mavis-*` skin, which is
 * keyed off its own class names). Overriding the seed here would diverge from the
 * desktop's cascade and re-tint the derived steps the desktop leaves alone.
 *
 * ## The two tokens that must be repeated
 *
 * `colorPrimaryHover` / `colorPrimaryBorderHover` are derived by antd from
 * `colorPrimary` in JavaScript, which is why they would otherwise come out as
 * literal blues instead of following the theme. The desktop pins both to
 * `var(--border_heavy)`; the comment in the object below says so.
 */

/**
 * Verbatim from the desktop bundle.
 *
 * Preserved as-is even where a token is spelled the way antd's own type expects
 * but the desktop chose otherwise (e.g. `Segmented.borderRadius: 100` — antd's
 * own default is 6; the desktop wants the fully-round track). Deviating here
 * means the webui and the desktop disagree about the same widget.
 */
export const DESKTOP_ANTD_THEME: ThemeConfig = {
  token: {
    colorBorder: "var(--border_default)",
    // Derived from `colorPrimary` in JS, so they cannot be left to the default
    // ramp — the desktop pins them to the token layer.
    colorPrimaryHover: "var(--border_heavy)",
    colorPrimaryBorderHover: "var(--border_heavy)",
  },
  components: {
    Segmented: {
      itemActiveBg: "var(--bg_default_primary)",
      itemSelectedColor: "var(--text_default_primary)",
      itemColor: "var(--text_default_secondary)",
      itemHoverBg: "var(--bg_default_primary)",
      itemHoverColor: "var(--text_default_primary)",
      borderRadius: 100,
      trackBg: "var(--bg_default_tertiary)",
    },
    Switch: {
      trackHeight: 16,
      trackMinWidth: 28,
      handleSize: 12,
      colorPrimary: "var(--icon_interaction_accent_accent)",
      colorPrimaryHover: "var(--icon_interaction_accent_accent)",
      colorPrimaryBorder: "var(--icon_interaction_accent_accent)",
      colorTextQuaternary: "var(--bg_interaction_tertiary_press)",
      colorTextTertiary: "var(--bg_interaction_tertiary_press)",
    },
    Form: {
      verticalLabelPadding: "0 0 6px",
      itemMarginBottom: 12,
    },
    Radio: {
      buttonBg: "transparent",
    },
    Input: {
      colorBorder: "var(--border_default)",
      activeBorderColor: "var(--border_heavy)",
      hoverBorderColor: "var(--border_heavy)",
    },
    Select: {
      colorPrimary: "var(--text_default_primary)",
      colorBorder: "var(--border_default)",
      colorPrimaryBorder: "var(--border_heavy)",
      colorBorderSecondary: "var(--border_heavy)",
      hoverBorderColor: "var(--border_heavy)",
    },
    Popover: {
      padding: 0,
      borderRadius: 12,
      colorBgElevated: "var(--bg_grouped_secondary_elevated)",
      colorBorder: "var(--border_default)",
      boxShadow: "0px 2px 8px 0px var(--shadow_default)",
    },
  },
};
