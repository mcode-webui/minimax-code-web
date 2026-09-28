// webapp/test/loading-skeleton.test.ts
//
// Loading-state rendering tests (webui ticket U8 — transcript skeleton +
// streaming activity indicator).
//
// Why this test exists: the loading branches replaced a bare three-dot
// spinner with a transcript-shaped shimmer skeleton, and the streaming tail
// indicator gained the same shimmer bar. The suite has no DOM render harness
// (no jsdom/happy-dom by policy), so the "does it render" half runs through
// react-dom/server's renderToStaticMarkup against the pure display
// components — the same SSR shape Next uses, no browser needed — and the
// "does the wiring stay put" half is a static-source tripwire on the two
// call sites and the CSS motion rules, in the style of
// composer-thinking-tripwire.test.ts.
//
// The components live in components/loading-states.tsx (import-clean: React
// only) so this file never pulls chat.tsx's mermaid/api graph into the test
// process.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ActivityPulse,
  TranscriptSkeleton,
  isSessionActivityActive,
} from "../components/loading-states";

// createElement, not JSX: this suite is a `.test.ts` file (the test:webapp
// glob is `**/*.test.ts`), and the tsx loader only transpiles JSX in `.tsx`.
const renderSkeleton = () => renderToStaticMarkup(createElement(TranscriptSkeleton));
const renderPulse = () => renderToStaticMarkup(createElement(ActivityPulse, { label: "思考中" }));

const here = dirname(fileURLToPath(import.meta.url));
const globalsCss = readFileSync(resolve(here, "../app/globals.css"), "utf8");
const pageSource = readFileSync(resolve(here, "../app/page.tsx"), "utf8");
const chatSource = readFileSync(resolve(here, "../components/chat.tsx"), "utf8");

/** Extract the `@media (prefers-reduced-motion: reduce) { ... }` block. */
function reducedMotionBlock(css: string): string {
  const marker = "@media (prefers-reduced-motion: reduce)";
  const start = css.indexOf(marker);
  assert.ok(start >= 0, "globals.css must carry a prefers-reduced-motion block");
  // Brace-walk from the block's opening brace — nested at-rules would break
  // a naive regex, and none of this file's blocks nest deeper than one level.
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced braces in globals.css reduced-motion block");
}

describe("TranscriptSkeleton — rendered markup", () => {
  const html = renderSkeleton();

  test("renders the skeleton testid once", () => {
    assert.equal(html.split('data-testid="transcript-skeleton"').length - 1, 1);
  });

  test("every placeholder bar carries the shimmer class", () => {
    const bars = html.split("mavis-skeleton-bar").length - 1;
    assert.ok(bars >= 10, `expected >=10 skeleton bars, found ${bars}`);
  });

  test("user-row placeholders are right-aligned bubbles (rounded 16px)", () => {
    // The real user row is `flex w-full justify-end` + a rounded-[16px]
    // bubble; the skeleton must mirror that shape so the first paint of the
    // real bubble lands on the same box.
    assert.match(html, /justify-end[^>]*>\s*<div aria-hidden="true" class="[^"]*rounded-\[16px\]/);
  });

  test("assistant-row placeholders mirror the reading widths", () => {
    // Widths track the desktop transcript skeleton (76/53/63%) so the
    // placeholder reads as a paragraph, not a form.
    assert.match(html, /w-\[76%\]/);
    assert.match(html, /w-\[53%\]/);
    assert.match(html, /w-\[63%\]/);
  });

  test("tool-row placeholder: icon dash + indented output lines", () => {
    assert.match(html, /h-4 w-4/);
    assert.match(html, /pl-6/);
  });

  test("tail groups dissolve with the vertical gradient mask", () => {
    assert.match(html, /mask-image:\s*linear-gradient\(180deg/);
  });

  test("skeleton is hidden from the accessibility tree", () => {
    assert.match(html, /aria-hidden="true"/);
  });
});

describe("ActivityPulse — rendered markup", () => {
  const html = renderPulse();

  test("renders the activity-indicator testid with role=status", () => {
    assert.match(html, /data-testid="activity-indicator"/);
    assert.match(html, /role="status"/);
  });

  test("carries the label text", () => {
    assert.match(html, /思考中/);
  });

  test("keeps the three-dot loader and adds the shimmer bar", () => {
    assert.match(html, /mavis-loading/);
    assert.match(html, /mavis-dot mavis-dot-c/);
    assert.match(html, /mavis-skeleton-bar/);
  });

  test("decorative bars are aria-hidden, the label is not", () => {
    // SSR reorders attributes (class first) — assert both, not their order.
    const dotsTag = html.match(/<span\b[^>]*mavis-loading[^>]*>/)?.[0] ?? "";
    assert.match(dotsTag, /aria-hidden="true"/);
  });
});

describe("isSessionActivityActive — the on/off gate", () => {
  test("false before the snapshot arrives (null/undefined)", () => {
    assert.equal(isSessionActivityActive(null), false);
    assert.equal(isSessionActivityActive(undefined), false);
  });

  test("false for an idle session shape", () => {
    assert.equal(isSessionActivityActive({}), false);
    assert.equal(isSessionActivityActive({ running: { active: false } }), false);
  });

  test("true while the engine streams a turn", () => {
    assert.equal(isSessionActivityActive({ running: { active: true } }), true);
  });
});

describe("reduced-motion — globals.css static rules", () => {
  const block = reducedMotionBlock(globalsCss);

  test("skeleton shimmer is explicitly switched off", () => {
    // Not just the generic duration hack: a reduce user must never see the
    // sweep even if the catch-all below is retuned.
    assert.match(block, /\.mavis-skeleton-bar\s*\{\s*animation:\s*none;?\s*\}/);
  });

  test("loading dots are explicitly switched off", () => {
    // !important is load-bearing (ticket 43): official-utilities.css loads
    // after globals.css and re-declares the animation-name at equal
    // specificity — see the cascade-aware suite below for the proof.
    assert.match(block, /\.mavis-loading \.mavis-dot\s*\{\s*animation:\s*none\s*!important;?\s*\}/);
  });

  test("the generic duration catch-all is still present", () => {
    assert.match(block, /animation-duration:\s*0\.001ms\s*!important/);
    assert.match(block, /animation-iteration-count:\s*1\s*!important/);
  });

  test("the shimmer keyframes exist for the non-reduced path", () => {
    assert.match(globalsCss, /@keyframes mavis-skeleton-shimmer/);
    assert.match(globalsCss, /\.mavis-skeleton-bar\s*\{[^}]*animation:\s*mavis-skeleton-shimmer/s);
  });
});

describe("wiring tripwire — the loading branches stay put", () => {
  test("page.tsx `!state` branch renders TranscriptSkeleton", () => {
    // The shell-level loading branch: if this reverts to the bare dots the
    // requirement regresses silently, so pin the real call site.
    const branch = pageSource.slice(pageSource.indexOf("if (!state) {"));
    assert.ok(branch.length > 0, "`!state` branch missing from page.tsx");
    assert.match(branch, /<TranscriptSkeleton \/>/);
    assert.doesNotMatch(branch, /mavis-dot/);
    // The connection copy stays — it is the only "why" on that screen.
    assert.match(branch, /app\.connecting/);
  });

  test("chat.tsx ThinkingIndicator gates on the pure function and returns null when idle", () => {
    const idx = chatSource.indexOf("function ThinkingIndicator");
    assert.ok(idx >= 0, "ThinkingIndicator present in chat.tsx");
    const body = chatSource.slice(idx, idx + 1400);
    assert.match(body, /if \(!isSessionActivityActive\(state\)\) return null;/);
    assert.match(body, /<ActivityPulse label=\{label\} \/>/);
  });
});

// ---------------------------------------------------------------------------
// Cascade-aware resolution (ticket 43). The regex tripwires above prove the
// reduced-motion rule *exists*; they cannot prove it *wins*. What broke the
// intent of the U8 comment was a cascade loss, not a missing rule:
// app/layout.tsx imports ../styles/official-utilities.css after globals.css,
// and that sheet re-declares `animation-name` on `.mavis-dot-a/b/c` at the
// same specificity (0,2,0), so a plain `animation: none` in the
// reduced-motion block is overridden and the dots only look still through
// the catch-all duration hack. The suite below replays the browser's
// cascade for animation-name over both sheets in import order — enough of
// the real algorithm (import order → specificity → declaration order,
// !important first) to see both the fix and the regression.
//
// The parser is deliberately tiny: only the shapes these two sheets use
// (class selectors, one level of @media, @keyframes/@layer/@tailwind blocks
// it must skip). Anything it cannot classify fails closed — a selector it
// does not understand matches nothing, so an exotic future rule cannot
// silently flip the verdict.

type CascadeDecl = { prop: string; value: string; important: boolean };
type CascadeRule = {
  selectors: string[];
  decls: CascadeDecl[];
  media: string | null;
  order: number;
};
type CascadeSheet = { name: string; rules: CascadeRule[] };

/** Remove CSS comment blocks before parsing (the ";" split would trip on them). */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Slice the balanced `{ ... }` block starting at `open` (index of "{"). */
function braceSlice(text: string, open: number): { inner: string; end: number } {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return { inner: text.slice(open + 1, i), end: i };
    }
  }
  throw new Error(`unbalanced braces in css (open at ${open})`);
}

function parseDecls(text: string): CascadeDecl[] {
  const out: CascadeDecl[] = [];
  for (const part of text.split(";")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    const prop = part.slice(0, colon).trim();
    let value = part.slice(colon + 1).trim();
    let important = false;
    if (/!important$/i.test(value)) {
      important = true;
      value = value.replace(/!important$/i, "").trim();
    }
    if (prop && value) out.push({ prop, value, important });
  }
  return out;
}

/** Parse the subset of CSS these two sheets contain into flat rules. */
function parseCss(css: string, name: string): CascadeSheet {
  const rules: CascadeRule[] = [];
  let order = 0;
  const walk = (text: string, media: string | null): void => {
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === undefined) break;
      if (/\s/.test(ch)) {
        i += 1;
        continue;
      }
      if (ch === "@") {
        // Statement at-rules (`@tailwind base;`) end at ";".
        const semi = text.indexOf(";", i);
        const brace = text.indexOf("{", i);
        if (semi >= 0 && (brace < 0 || semi < brace)) {
          i = semi + 1;
          continue;
        }
        if (brace < 0) break;
        const prelude = text.slice(i, brace);
        const block = braceSlice(text, brace);
        if (/^@media\b/.test(prelude)) {
          // One level of nesting is all these files use; a nested @media
          // would still be walked with the OUTER condition here, which is
          // wrong in general — assert it does not happen.
          if (media !== null) throw new Error("nested @media is not modelled");
          walk(block.inner, prelude.replace(/^@media\s*/, "").trim());
        }
        // @keyframes / @layer / anything else: skip the whole block.
        i = block.end + 1;
        continue;
      }
      const open = text.indexOf("{", i);
      if (open < 0) break;
      const selectorText = text.slice(i, open).trim();
      const block = braceSlice(text, open);
      const decls = parseDecls(block.inner);
      if (selectorText && !selectorText.startsWith("@") && decls.length > 0) {
        rules.push({
          selectors: selectorText.split(",").map((s) => s.trim()).filter(Boolean),
          decls,
          media,
          order: order++,
        });
      }
      i = block.end + 1;
    }
  };
  walk(stripCssComments(css), null);
  return { name, rules };
}

const NON_NAME_KEYWORDS = new Set([
  "linear", "ease", "ease-in", "ease-out", "ease-in-out", "step-start",
  "step-end", "infinite", "normal", "alternate", "reverse", "alternate-reverse",
  "forwards", "backwards", "both", "running", "paused", "initial", "inherit",
  "unset", "revert", "revert-layer",
]);

/** animation-name out of an `animation` shorthand value ("none" stays "none"). */
function shorthandAnimationName(value: string): string {
  for (const token of value.trim().split(/\s+/)) {
    if (/^(\d*\.?\d+)(ms|s)$/i.test(token)) continue; // duration / delay
    if (NON_NAME_KEYWORDS.has(token.toLowerCase())) continue;
    return token;
  }
  return "none"; // empty shorthand resets to the initial value
}

function selectorMatches(
  selector: string,
  ownClasses: Set<string>,
  ancestorClasses: Set<string>,
): boolean {
  return selector.split(/\s+/).filter(Boolean).every((part) => {
    if (part === "*") return true;
    if (part.startsWith(".")) {
      const cls = part.slice(1);
      return ownClasses.has(cls) || ancestorClasses.has(cls);
    }
    return false; // unknown simple selector — fail closed
  });
}

const classCount = (selector: string): number =>
  selector.split(/\s+/).filter((p) => p.startsWith(".")).length;

type ComputedAnimationName = {
  name: string;
  winner: { sheet: string; selector: string; important: boolean };
};

/**
 * Replay the cascade for animation-name over the sheets in import order and
 * return the computed value plus the winning declaration. Sort key:
 * !important first, then specificity, then later sheet, then later rule,
 * then later declaration within the rule (shorthand vs longhand order).
 */
function computedAnimationName(
  sheets: CascadeSheet[],
  ownClasses: Set<string>,
  ancestorClasses: Set<string>,
  reducedMotion: boolean,
): ComputedAnimationName {
  let bestKey: number[] | null = null;
  let best: ComputedAnimationName | null = null;
  for (const [sheetIdx, sheet] of sheets.entries()) {
    for (const rule of sheet.rules) {
      // Activation: unconditional rules always apply; the reduce block adds
      // on top for reduced-motion users (base + reduce, not reduce alone —
      // the negative-control test catches exactly this mistake).
      const isReduceBlock = rule.media !== null && /prefers-reduced-motion:\s*reduce/.test(rule.media);
      if (rule.media !== null && isReduceBlock !== reducedMotion) continue;
      for (const [declIdx, decl] of rule.decls.entries()) {
        const name =
          decl.prop === "animation-name" ? decl.value
          : decl.prop === "animation" ? shorthandAnimationName(decl.value)
          : null;
        if (name === null) continue;
        for (const selector of rule.selectors) {
          if (!selectorMatches(selector, ownClasses, ancestorClasses)) continue;
          const key = [
            decl.important ? 1 : 0,
            classCount(selector),
            sheetIdx,
            rule.order,
            declIdx,
          ];
          if (bestKey === null || key > bestKey) {
            bestKey = key;
            best = { name, winner: { sheet: sheet.name, selector, important: decl.important } };
          }
        }
      }
    }
  }
  if (best === null) throw new Error("no animation-name declaration matched the element");
  return best;
}

describe("reduced-motion — cascade-aware animation-name (ticket 43)", () => {
  const layoutSource = readFileSync(resolve(here, "../app/layout.tsx"), "utf8");
  const utilitiesCss = readFileSync(resolve(here, "../styles/official-utilities.css"), "utf8");
  const globalsSheet = parseCss(globalsCss, "globals.css");
  const utilitiesSheet = parseCss(utilitiesCss, "official-utilities.css");
  const sheets: CascadeSheet[] = [globalsSheet, utilitiesSheet];
  const variants = ["a", "b", "c"] as const;
  const dotClasses = (variant: string) => new Set(["mavis-dot", `mavis-dot-${variant}`]);
  const ancestor = new Set(["mavis-loading"]);

  test("layout.tsx imports official-utilities.css after globals.css (the cascade direction)", () => {
    const globalsAt = layoutSource.indexOf('"./globals.css"');
    const utilitiesAt = layoutSource.indexOf('"../styles/official-utilities.css"');
    assert.ok(globalsAt >= 0, "globals.css import present");
    assert.ok(utilitiesAt >= 0, "official-utilities.css import present");
    assert.ok(globalsAt < utilitiesAt, "official-utilities.css must load after globals.css");
  });

  test("the cascade pressure is real: the later sheet re-declares each variant's animation-name", () => {
    // If upstream ever drops this duplicate block, the !important on the
    // globals.css rule becomes unnecessary — this tripwire says "revisit",
    // it does not block the removal.
    const utilities = utilitiesSheet;
    for (const variant of variants) {
      const redeclared = utilities.rules.some(
        (rule) =>
          rule.media === null &&
          rule.decls.some((d) => d.prop === "animation-name" && d.value === `mavis-dot-${variant}`) &&
          rule.selectors.includes(`.mavis-loading .mavis-dot-${variant}`),
      );
      assert.ok(redeclared, `official-utilities.css re-declares animation-name for mavis-dot-${variant}`);
    }
  });

  test("reduced: every dot computes animation-name none by winning the cascade, not the duration hack", () => {
    for (const variant of variants) {
      const { name, winner } = computedAnimationName(sheets, dotClasses(variant), ancestor, true);
      assert.equal(name, "none", `mavis-dot-${variant}: computed animation-name under reduce`);
      assert.equal(winner.sheet, "globals.css", "the explicit reduced-motion rule must win");
      assert.equal(winner.selector, ".mavis-loading .mavis-dot");
      assert.equal(winner.important, true, "only an !important declaration beats the later sheet");
    }
  });

  test("motion on: the same cascade still resolves the desktop names (model sanity)", () => {
    for (const variant of variants) {
      const { name } = computedAnimationName(sheets, dotClasses(variant), ancestor, false);
      assert.equal(name, `mavis-dot-${variant}`);
    }
  });

  test("negative control: stripping the !important reproduces the ticket's bug", () => {
    // Exactly the regression this suite exists to catch: without !important
    // the same-specificity re-declaration in the later sheet wins again and
    // the dots go back to depending on the catch-all duration hack.
    const broken = globalsCss.replace("animation: none !important", "animation: none");
    assert.notEqual(broken, globalsCss, "fixture: the !important must exist to be stripped");
    const brokenSheets: CascadeSheet[] = [parseCss(broken, "globals.css"), utilitiesSheet];
    for (const variant of variants) {
      const { name, winner } = computedAnimationName(brokenSheets, dotClasses(variant), ancestor, true);
      assert.equal(name, `mavis-dot-${variant}`, "the later sheet wins — the bug ticket 43 describes");
      assert.equal(winner.sheet, "official-utilities.css");
    }
  });
});
