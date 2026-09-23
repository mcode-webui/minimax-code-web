import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Tailwind resolves `content` globs against the process working directory, which
// for this project is `packages/webui` (the Next CLI is invoked as
// `next build webapp`). Absolute globs derived from this file's own location keep
// the scan correct no matter where the build is started from.
const dir = path.dirname(fileURLToPath(import.meta.url));

// The Tailwind theme is derived from `styles/tokens.css` rather than duplicating the
// token list here. tokens.css is the verbatim upstream design system (see its
// header); with one source, a token can never exist in the stylesheet but be
// missing from the utilities, or vice versa.
const tokensCss = readFileSync(path.join(dir, "styles/tokens.css"), "utf8");

const tokenNames = [
  ...new Set([...tokensCss.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)].map((m) => m[1])),
];

/** Token name without the leading `--`, e.g. `bg_default_primary`. */
const tokenName = (token) => token.slice(2);
const withPrefix = (prefix) => tokenNames.filter((t) => tokenName(t).startsWith(prefix));

// One naming rule for every namespace: **the utility class is the token name**.
//
//   --bg_default_primary  -> bg-bg_default_primary
//   --spacing_16          -> gap-spacing_16 / px-spacing_16
//   --radius_12           -> rounded-radius_12
//   --size_20             -> w-size_20 / h-size_20
//   --line_height_22      -> leading-line_height_22
//   --weight_medium       -> font-weight_medium
//   --shadow_default      -> shadow-shadow_default
//
// The upstream renderer follows the same rule for colours (`text-text_default_primary`
// appears in its markup). Keeping it for the numeric scales too means the class names
// are greppable back to tokens.css, and — unlike mapping `--spacing_16` onto the bare
// key `16` — it cannot silently override Tailwind's built-in scale, so a stock utility
// such as `mt-4` keeps its standard meaning.
const namespace = (prefix) =>
  Object.fromEntries(withPrefix(prefix).map((t) => [tokenName(t), `var(${t})`]));

/** @type {import('tailwindcss').Config} */
export default {
  // Upstream drives the theme with a `light` / `dark` class on <html>, not with
  // `prefers-color-scheme`. See app/layout.tsx.
  darkMode: ["class", ".dark"],
  content: [
    `${dir}/app/**/*.{ts,tsx}`,
    `${dir}/components/**/*.{ts,tsx}`,
    `${dir}/lib/**/*.{ts,tsx}`,
  ],
  theme: {
    extend: {
      colors: {
        // Colour tokens land in `colors` as a whole, so the `bg-`, `text-`,
        // `border-`, `fill-` and `stroke-` utilities each cover the full set —
        // the same convention upstream uses.
        ...namespace("bg_"),
        ...namespace("text_"),
        ...namespace("icon_"),
        ...namespace("border_"),
        ...namespace("terminal_"),
        ...namespace("utility_"),
      },
      spacing: namespace("spacing_"),
      borderRadius: namespace("radius_"),
      width: namespace("size_"),
      height: namespace("size_"),
      size: namespace("size_"),
      lineHeight: namespace("line_height_"),
      fontWeight: namespace("weight_"),
      boxShadow: namespace("shadow_"),
      // Responsive thresholds. These are not design tokens — they are the
      // breakpoints the pre-existing UI documented (drawer under 900px, single
      // column under 600px), kept so the responsive behaviour is unchanged.
      screens: { wide: "900px", compact: "600px" },
    },
  },
  plugins: [],
};
