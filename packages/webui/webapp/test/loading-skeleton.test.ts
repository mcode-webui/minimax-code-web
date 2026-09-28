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
    assert.match(block, /\.mavis-loading \.mavis-dot\s*\{\s*animation:\s*none;?\s*\}/);
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
