#!/usr/bin/env node
/**
 * Regenerates `webapp/styles/desktop-typography.css` from the desktop client's
 * extracted stylesheet.
 *
 * Why this exists: the desktop client does not ship its typography preset as CSS.
 * The renderer resolves the preset in JavaScript and writes the resulting custom
 * properties onto <html> at runtime, then gates a set of stylesheet rules on the
 * `mavis-desktop-typography-enabled` class. Neither half can be observed in a
 * stylesheet alone, so this script re-derives the rule set and the stylesheet
 * carries the (much smaller) computed preset block by hand.
 *
 * The desktop bundle is not part of this repository, so this script takes its
 * location as an argument and is not wired into any CI gate. Same posture as
 * `desktop-reference.mjs`, which needs the running desktop app instead.
 *
 * Usage:
 *   node packages/webui/scripts/desktop-typography.mjs \
 *     <unpacked>/out/_next/static/css \
 *     packages/webui/webapp/styles/desktop-typography.css
 *
 * Findings and the unpacking recipe live in the alignment working notes outside
 * the repository (see webapp/README.md, "Re-derive evidence").
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const [CSS_DIR, OUT] = process.argv.slice(2);
if (!CSS_DIR || !OUT) {
  console.error(
    "usage: desktop-typography.mjs <unpacked>/out/_next/static/css <out.css>",
  );
  process.exit(2);
}
for (const dir of [CSS_DIR, path.dirname(OUT)]) {
  if (!statSync(dir).isDirectory()) {
    console.error(`not a directory: ${dir}`);
    process.exit(2);
  }
}
const MARKER = "mavis-desktop-typography-enabled";

/** Split a stylesheet into top-level blocks, recursing into at-rules. */
function blocks(css, at = "") {
  const out = [];
  let depth = 0;
  let prelude = "";
  let body = "";
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === "{") {
      if (depth === 0) {
        prelude = prelude.trim();
        body = "";
      } else {
        body += ch;
      }
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        if (prelude.startsWith("@")) {
          out.push(...blocks(body, at ? `${at} ${prelude}` : prelude));
        } else {
          out.push({ at, selector: prelude.replace(/\s+/g, " ").trim(), body: body.trim() });
        }
        prelude = "";
        body = "";
      } else {
        body += ch;
      }
    } else if (depth === 0) {
      prelude += ch;
    } else {
      body += ch;
    }
    i += 1;
  }
  return out;
}

// Widgets bundled upstream but outside this frontend's dependency boundary
// (same exclusion list as official-utilities.css). Selectors are filtered per
// comma-separated fragment so a mixed rule keeps its first-party half.
const THIRD_PARTY = /ant-|\.adm-|xterm|katex|mermaid/;
// Upstream also carries the "typography disabled" fallback branch, spelled
// `:not(.mavis-desktop-typography-enabled)`. It matches the marker string but is
// the opposite of what we port, so those fragments are excluded up front.
const LEGACY_BRANCH = /not\(\.mavis-desktop-typography-enabled\)/;

/** Split a selector list on top-level commas only, so `:is(a, b)` stays intact. */
function splitTopLevel(selector) {
  const out = [];
  let depth = 0;
  let current = "";
  for (const ch of selector) {
    if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

const files = readdirSync(CSS_DIR).filter((f) => f.endsWith(".css")).sort();
const collected = [];
const seen = new Set();
let droppedFragments = 0;
for (const file of files) {
  const css = readFileSync(path.join(CSS_DIR, file), "utf8");
  for (const rule of blocks(css)) {
    if (!rule.selector.includes(MARKER)) continue;
    const allFragments = splitTopLevel(rule.selector);
    const fragments = allFragments.filter(
      (fragment) => fragment.includes(MARKER) && !LEGACY_BRANCH.test(fragment),
    );
    droppedFragments += allFragments.length - fragments.length;
    const firstParty = fragments.filter((fragment) => !THIRD_PARTY.test(fragment));
    // A rule whose only marker-bearing fragments are third-party widgets is
    // dropped outright: those libraries are outside this frontend's boundary,
    // so the rule could never match anything we render.
    droppedFragments += fragments.length - firstParty.length;
    if (firstParty.length === 0) continue;
    const selected = firstParty;
    const selector = selected.join(",");
    const key = `${rule.at}\u0000${selector}\u0000${rule.body}`;
    if (seen.has(key)) continue;
    seen.add(key);
    collected.push({ ...rule, selector, file });
  }
}

const HEADER = `/* Desktop typography preset — the cascade the Electron client applies.
 *
 * Upstream does NOT ship this in a stylesheet. The renderer resolves a typography
 * preset in JavaScript (\`resolveDesktopTypographyPreset\`) and writes ~40 CSS custom
 * properties onto <html> as inline style, then gates a set of stylesheet rules on
 * \`mavis-desktop-typography-enabled\` (plus \`mavis-platform-electron\`) to consume them.
 *
 * We replicate that contract instead of approximating it:
 *   1. the preset block below emits the same custom properties for the \`standard\`
 *      size preset (14px UI base / 12px code) that upstream computes,
 *   2. the rules after it are copied verbatim from the official stylesheet,
 *   3. app/layout.tsx puts both gate classes on <html>.
 *
 * Emitting the properties is what makes the copied rules resolve: they reference
 * \`var(--mavis-type-ui-body-font-size)\`, \`var(--mavis-markdown-body-size)\` and
 * friends without fallbacks in most cases.
 *
 * \`standard\` is the preset the desktop client defaults to
 * (\`DEFAULT_PRESET = { uiFontWeight: "theme", density: "comfortable", … }\` with no
 * stored size override). Other presets would only change the block below.
 *
 * __RULE_COUNT__ rules follow. Do not edit the "copied" half by hand — regenerate the whole file with
 * \`scripts/desktop-typography.mjs\`. Provenance: see webapp/README.md.
 */

/* ---------------------------------------------------------------------------
 * 1. Preset emission — computed values for the "standard" preset.
 *
 *    uiBaseFontSize 14 → ui scale; codeFontSize 12 → code scale.
 *    Derived exactly as upstream does:
 *      ui/assist  12  / 16     / 430      chat/body  14 / 22.75 / 430
 *      ui/small   13  / 18.57  / 430      markdown   h1 6u .. h6, u = bodySize/4 = 3.5
 *      ui/body    14  / 21     / 430      table      cell 13 / 22.75, header 13 / 14
 *      ui/large   16  / 24.89  / 430      code       block 12 / 20, diff 12 / 21.6
 * ------------------------------------------------------------------------- */
:root.mavis-desktop-typography-enabled {
  --mavis-letter-spacing-normal: 0px;

  /* Font-weight ladder. Every weight above reads \`var(--mavis-font-weight-*, <n>)\`,
   * so a product-level override can retune without touching the rules. */
  --mavis-font-weight-normal: 400;
  --mavis-font-weight-default: var(--mavis-body-font-weight, 430);
  --mavis-font-weight-medium: var(--mavis-label-font-weight, 500);
  --mavis-font-weight-semibold: var(--mavis-heading-font-weight, 600);
  --mavis-font-weight-bold: var(--mavis-bold-font-weight, 700);

  /* UI scale. */
  --mavis-ui-font-size: 14px;
  --mavis-ui-assist-size: 12px;
  --mavis-ui-assist-line-height: 16px;
  --mavis-ui-small-size: 13px;
  --mavis-ui-small-line-height: 18.57px;
  --mavis-ui-body-size: 14px;
  --mavis-ui-body-line-height: 21px;
  --mavis-ui-large-size: 16px;
  --mavis-ui-large-line-height: 24.89px;

  /* Tailwind-compatible aliases of the same scale. */
  --mavis-text-xs: 12px;
  --mavis-text-xs-line-height: 16px;
  --mavis-text-sm: 13px;
  --mavis-text-sm-line-height: 18.57px;
  --mavis-text-base: 14px;
  --mavis-text-base-line-height: 21px;
  --mavis-text-lg: 16px;
  --mavis-text-lg-line-height: 24.89px;
  --mavis-body-size: 14px;
  --mavis-body-line-height: 21px;
  --mavis-body-small-size: 13px;
  --mavis-body-small-line-height: 18.57px;
  --mavis-caption-size: 12px;
  --mavis-caption-line-height: 16px;
  --mavis-caption-small-size: 12px;
  --mavis-caption-small-line-height: 16px;

  /* Markdown headings, derived from the spacing unit below. */
  --mavis-heading1-size: 21px;
  --mavis-heading1-line-height: 28px;
  --mavis-heading2-size: 17.5px;
  --mavis-heading2-line-height: 24.5px;
  --mavis-heading3-size: 15.75px;
  --mavis-heading3-line-height: 24.5px;
  --mavis-heading-sm: 15.75px;
  --mavis-heading-md: 17.5px;
  --mavis-heading-lg: 21px;

  /* Chat body — the transcript's reading size. */
  --mavis-chat-body-size: 14px;
  --mavis-chat-body-line-height: 22.75px;

  /* Markdown. spacingUnit = bodySize / 4 = 3.5, and every gap is a multiple. */
  --mavis-markdown-spacing-unit: 3.5px;
  --mavis-markdown-space-1: 3.5px;
  --mavis-markdown-space-2: 7px;
  --mavis-markdown-space-3: 10.5px;
  --mavis-markdown-space-4: 14px;
  --mavis-markdown-space-5: 17.5px;
  --mavis-markdown-space-6: 21px;
  --mavis-markdown-space-7: 24.5px;
  --mavis-markdown-body-size: 14px;
  --mavis-markdown-body-line-height: 22.75px;
  --mavis-markdown-h1-size: 21px;
  --mavis-markdown-h1-line-height: 28px;
  --mavis-markdown-h2-size: 17.5px;
  --mavis-markdown-h2-line-height: 24.5px;
  --mavis-markdown-h3-size: 15.75px;
  --mavis-markdown-h3-line-height: 24.5px;
  --mavis-markdown-h4-size: 14px;
  --mavis-markdown-h4-line-height: 21px;
  --mavis-markdown-h5-size: 14px;
  --mavis-markdown-h5-line-height: 22.75px;
  --mavis-markdown-h6-size: 14px;
  --mavis-markdown-h6-line-height: 22.75px;
  --mavis-markdown-table-header-size: 13px;
  --mavis-markdown-table-header-line-height: 14px;
  --mavis-markdown-table-cell-size: 13px;
  --mavis-markdown-table-cell-line-height: 22.75px;

  /* Dialogs. */
  --mavis-dialog-title-size: 20px;
  --mavis-dialog-title-line-height: 28px;
  --mavis-dialog-title-letter-spacing: -0.36px;
  --mavis-remote-goal-size: 16px;

  /* Code. */
  --mavis-inline-code-font-size: 0.92em;
  --mavis-code-font-size: 12px;
  --mavis-code-line-height: 20px;
  --mavis-code-block-font-size: 12px;
  --mavis-code-block-line-height: 20px;
  --mavis-code-compact-font-size: 12px;
  --mavis-diff-font-size: 12px;
  --mavis-diff-line-height: 21.6px;
  --mavis-terminal-font-size: 12px;
  --mavis-terminal-line-height: 1.2;

  /* Per-role shorthands (\`cP()\` upstream) — the \`.desktop-text-*\` utilities read these. */
  --mavis-type-brand-slogan-font-size: 28px;
  --mavis-type-brand-slogan-line-height: 35px;
  --mavis-type-brand-slogan-font-weight: var(--mavis-font-weight-semibold, 600);
  --mavis-type-brand-slogan-letter-spacing: 0px;
  --mavis-type-composer-disclaimer-font-size: 10px;
  --mavis-type-composer-disclaimer-line-height: 14px;
  --mavis-type-composer-disclaimer-font-weight: var(--mavis-font-weight-default, 430);
  --mavis-type-composer-disclaimer-letter-spacing: 0px;
  --mavis-type-ui-assist-font-size: 12px;
  --mavis-type-ui-assist-line-height: 16px;
  --mavis-type-ui-assist-font-weight: var(--mavis-font-weight-default, 430);
  --mavis-type-ui-assist-letter-spacing: 0px;
  --mavis-type-ui-assist-strong-font-size: 12px;
  --mavis-type-ui-assist-strong-line-height: 16px;
  --mavis-type-ui-assist-strong-font-weight: var(--mavis-font-weight-medium, 500);
  --mavis-type-ui-assist-strong-letter-spacing: 0px;
  --mavis-type-ui-small-font-size: 13px;
  --mavis-type-ui-small-line-height: 18.57px;
  --mavis-type-ui-small-font-weight: var(--mavis-font-weight-default, 430);
  --mavis-type-ui-small-letter-spacing: 0px;
  --mavis-type-ui-small-strong-font-size: 13px;
  --mavis-type-ui-small-strong-line-height: 18.57px;
  --mavis-type-ui-small-strong-font-weight: var(--mavis-font-weight-medium, 500);
  --mavis-type-ui-small-strong-letter-spacing: 0px;
  --mavis-type-ui-body-font-size: 14px;
  --mavis-type-ui-body-line-height: 21px;
  --mavis-type-ui-body-font-weight: var(--mavis-font-weight-default, 430);
  --mavis-type-ui-body-letter-spacing: 0px;
  --mavis-type-ui-body-strong-font-size: 14px;
  --mavis-type-ui-body-strong-line-height: 21px;
  --mavis-type-ui-body-strong-font-weight: var(--mavis-font-weight-medium, 500);
  --mavis-type-ui-body-strong-letter-spacing: 0px;
  --mavis-type-ui-large-font-size: 16px;
  --mavis-type-ui-large-line-height: 24.89px;
  --mavis-type-ui-large-font-weight: var(--mavis-font-weight-default, 430);
  --mavis-type-ui-large-letter-spacing: 0px;
  --mavis-type-ui-large-strong-font-size: 16px;
  --mavis-type-ui-large-strong-line-height: 24.89px;
  --mavis-type-ui-large-strong-font-weight: var(--mavis-font-weight-medium, 500);
  --mavis-type-ui-large-strong-letter-spacing: 0px;
  --mavis-type-chat-body-font-size: 14px;
  --mavis-type-chat-body-line-height: 22.75px;
  --mavis-type-chat-body-font-weight: var(--mavis-font-weight-default, 430);
  --mavis-type-chat-body-letter-spacing: 0px;
  --mavis-type-chat-body-strong-font-size: 14px;
  --mavis-type-chat-body-strong-line-height: 22.75px;
  --mavis-type-chat-body-strong-font-weight: var(--mavis-font-weight-semibold, 600);
  --mavis-type-chat-body-strong-letter-spacing: 0px;
  --mavis-type-markdown-body-font-size: 14px;
  --mavis-type-markdown-body-line-height: 22.75px;
  --mavis-type-markdown-body-font-weight: var(--mavis-font-weight-default, 430);
  --mavis-type-markdown-body-letter-spacing: 0px;
  --mavis-type-markdown-h1-font-size: 21px;
  --mavis-type-markdown-h1-line-height: 28px;
  --mavis-type-markdown-h2-font-size: 17.5px;
  --mavis-type-markdown-h2-line-height: 24.5px;
  --mavis-type-markdown-h3-font-size: 15.75px;
  --mavis-type-markdown-h3-line-height: 24.5px;
  --mavis-type-markdown-h4-font-size: 14px;
  --mavis-type-markdown-h4-line-height: 21px;
  --mavis-type-markdown-h5-font-size: 14px;
  --mavis-type-markdown-h5-line-height: 22.75px;
  --mavis-type-markdown-h6-font-size: 14px;
  --mavis-type-markdown-h6-line-height: 22.75px;
  --mavis-type-markdown-h1-font-weight: var(--mavis-font-weight-semibold, 600);
  --mavis-type-markdown-h2-font-weight: var(--mavis-font-weight-semibold, 600);
  --mavis-type-markdown-h3-font-weight: var(--mavis-font-weight-semibold, 600);
  --mavis-type-markdown-h4-font-weight: var(--mavis-font-weight-semibold, 600);
  --mavis-type-markdown-h5-font-weight: var(--mavis-font-weight-semibold, 600);
  --mavis-type-markdown-h6-font-weight: var(--mavis-font-weight-semibold, 600);
  --mavis-type-markdown-h1-letter-spacing: 0px;
  --mavis-type-markdown-h2-letter-spacing: 0px;
  --mavis-type-markdown-h3-letter-spacing: 0px;
  --mavis-type-markdown-h4-letter-spacing: 0px;
  --mavis-type-markdown-h5-letter-spacing: 0px;
  --mavis-type-markdown-h6-letter-spacing: 0px;
  --mavis-type-markdown-body-letter-spacing: 0px;
  --mavis-type-markdown-table-header-font-size: 13px;
  --mavis-type-markdown-table-header-line-height: 14px;
  --mavis-type-markdown-table-header-font-weight: var(--mavis-font-weight-semibold, 600);
  --mavis-type-markdown-table-header-letter-spacing: 0px;
  --mavis-type-markdown-table-cell-font-size: 13px;
  --mavis-type-markdown-table-cell-line-height: 22.75px;
  --mavis-type-markdown-table-cell-font-weight: var(--mavis-font-weight-default, 430);
  --mavis-type-markdown-table-cell-letter-spacing: 0px;
  --mavis-type-dialog-medium-font-size: 20px;
  --mavis-type-dialog-medium-line-height: 28px;
  --mavis-type-dialog-medium-font-weight: var(--mavis-font-weight-medium, 500);
  --mavis-type-dialog-medium-letter-spacing: -0.36px;
  --mavis-type-dialog-semibold-font-size: 20px;
  --mavis-type-dialog-semibold-line-height: 28px;
  --mavis-type-dialog-semibold-font-weight: var(--mavis-font-weight-semibold, 600);
  --mavis-type-dialog-semibold-letter-spacing: -0.36px;
  --mavis-type-code-block-font-size: 12px;
  --mavis-type-code-block-line-height: 20px;
  --mavis-type-code-block-font-weight: var(--mavis-code-font-weight, 400);
  --mavis-type-code-block-letter-spacing: 0px;
  --mavis-type-code-diff-font-size: 12px;
  --mavis-type-code-diff-line-height: 21.6px;
  --mavis-type-code-diff-font-weight: var(--mavis-code-font-weight, 400);
  --mavis-type-code-diff-letter-spacing: 0px;
  --mavis-type-code-terminal-font-size: 12px;
  --mavis-type-code-terminal-line-height: 14.4px;
  --mavis-type-code-terminal-font-weight: var(--mavis-code-font-weight, 400);
  --mavis-type-code-terminal-letter-spacing: 0px;
}

/* Integer font-size/line-height ramp upstream also emits: \`--mavis-font-size-N\`
 * resolves to N rounded through the ui scale, and several markdown rules fall back
 * to \`var(--mavis-font-size-14, 14px)\`. Only the 8..64 range is ever referenced. */
:root.mavis-desktop-typography-enabled {
`;

// The integer ramp is written out so the fallbacks above resolve identically.
const ramp = [];
for (let n = 8; n <= 64; n += 1) {
  const scaled = Math.round(((n * 14) / 14) * 100) / 100;
  ramp.push(`  --mavis-font-size-${n}: ${scaled}px;\n  --mavis-line-height-${n}: ${scaled}px;`);
}

const COPIED_HEADER = `}

/* ---------------------------------------------------------------------------
 * 2. Rules copied verbatim from the official stylesheet.
 *
 *    Selected by the single predicate "does the selector mention
 *    \`mavis-desktop-typography-enabled\`", which is exactly the set upstream turns
 *    on when the typography preset is active. Nothing here was retyped or
 *    reordered; only the surrounding whitespace between rules was normalised.
 * ------------------------------------------------------------------------- */
`;

const HEADER_FINAL = HEADER.replace("__RULE_COUNT__", String(collected.length));
const parts = [HEADER_FINAL, ramp.join("\n"), COPIED_HEADER];
for (const rule of collected) {
  const body = rule.body.replace(/\s*;\s*/g, ";").replace(/;+$/, "");
  if (rule.at) {
    parts.push(`${rule.at} {\n  ${rule.selector} {\n    ${body.replace(/;/g, ";\n    ")}\n  }\n}`);
  } else {
    parts.push(`${rule.selector} {\n  ${body.replace(/;/g, ";\n  ")}\n}`);
  }
}
writeFileSync(OUT, `${parts.join("\n")}\n`);

const byFile = {};
for (const rule of collected) byFile[rule.file] = (byFile[rule.file] ?? 0) + 1;
console.log(`rules: ${collected.length}`);
console.log(
  Object.entries(byFile)
    .sort((a, b) => b[1] - a[1])
    .map(([f, n]) => `  ${n}\t${f}`)
    .join("\n"),
);
console.log(`at-rules: ${new Set(collected.map((r) => r.at).filter(Boolean)).size}`);
console.log(`dropped third-party/non-marker fragments: ${droppedFragments}`);
console.log(`out: ${OUT}`);
