// webapp/test/activity-group-body.test.ts
//
// The activity group's body box (webui-parity 61, G7): no height cap, no
// nested scrollbar, and the reference's row metrics.
//
// The defect is a property of the emitted class list, so most of this is a
// source tripwire — but a tripwire on the CLASS is not a tripwire on the
// element, so the suite also renders a real group and reads the box out of
// the markup. A `max-h` that arrived through a stylesheet instead of a
// utility class would survive a class-only assertion, and the reduced-motion
// cascade work in this repo has already been bitten by exactly that shape
// (official-utilities.css re-declaring an animation at equal specificity), so
// the stylesheets are swept for a second declaration too.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

{
  const reactModule = React;
  Object.defineProperty(globalThis, "React", {
    value: reactModule,
    configurable: true,
    writable: true,
  });
}

const { ActivityGroup } = await import("../components/activity-group");
const { translate } = await import("../lib/i18n");
const { SessionProvider } = await import("../lib/store");
import type { ActivitySummary, TranscriptBlock } from "../lib/transcript";

const here = dirname(fileURLToPath(import.meta.url));
const activitySource = readFileSync(
  resolve(here, "../components/activity-group.tsx"),
  "utf8",
);
const globalsCss = readFileSync(resolve(here, "../app/globals.css"), "utf8");
const layoutSource = readFileSync(resolve(here, "../app/layout.tsx"), "utf8");

// A deliberately small CSS reader — the same shape as
// message-enter-animation.test.ts uses for `.message-animate-in`, reused here
// because the question is the same one: does a hand-written rule actually
// reach the browser, and does a later stylesheet re-declare it? It descends
// into `@layer` and records the layer name (so "not inside a layer" is an
// assertion, not an inference), skips `@keyframes`, and follows layout.tsx's
// import order — the cascade order.
type FoundRule = { sheet: string; selector: string; layer: string | null; body: string };

const stripCssComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

function braceSlice(text: string, open: number): { inner: string; end: number } {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return { inner: text.slice(open + 1, i), end: i };
    }
  }
  throw new Error("unbalanced braces in css");
}

/** Every rule in `css` whose selector list contains `selector`, with context. */
function rulesForSelector(css: string, sheet: string, selector: string): FoundRule[] {
  const out: FoundRule[] = [];
  const walk = (text: string, layer: string | null): void => {
    let i = 0;
    while (i < text.length) {
      if (/\s/.test(text[i] ?? "")) {
        i += 1;
        continue;
      }
      if (text[i] === "@") {
        const brace = text.indexOf("{", i);
        const semi = text.indexOf(";", i);
        if (semi >= 0 && (brace < 0 || semi < brace)) {
          i = semi + 1;
          continue;
        }
        if (brace < 0) return;
        const prelude = text.slice(i, brace);
        const block = braceSlice(text, brace);
        if (/^@layer\b/.test(prelude)) {
          walk(block.inner, prelude.replace(/^@layer\s*/, "").trim() || "(anonymous)");
        }
        // @media / @keyframes / anything else: skipped, by design.
        i = block.end + 1;
        continue;
      }
      const open = text.indexOf("{", i);
      if (open < 0) return;
      const selectorText = text.slice(i, open).trim();
      const block = braceSlice(text, open);
      if (selectorText.split(",").some((s) => s.trim() === selector)) {
        out.push({ sheet, selector: selectorText, layer, body: block.inner });
      }
      i = block.end + 1;
    }
  };
  walk(stripCssComments(css), null);
  return out;
}

/** Every stylesheet the app loads, in layout.tsx import (cascade) order. */
function loadedStylesheets(): { sheet: string; css: string }[] {
  const out: { sheet: string; css: string }[] = [];
  for (const match of layoutSource.matchAll(/import\s+"(\.[^"]*\.css)";/g)) {
    const specifier = match[1] as string;
    out.push({
      sheet: specifier,
      css: readFileSync(resolve(here, "../app", specifier), "utf8"),
    });
  }
  assert.ok(out.length > 0, "layout.tsx must import at least one stylesheet");
  return out;
}

const t = (key: Parameters<typeof translate>[1]) => translate("zh", key);
const noop = () => {};

/** Twelve tool calls — the "long tool run" the desktop shows as one long
 *  column rather than a box with its own scrollbar. */
const longRun: TranscriptBlock[] = Array.from({ length: 12 }, (_, index) => ({
  role: "tool",
  toolName: "bash",
  text: `line ${index}`,
  toolStatus: "completed",
})) as unknown as TranscriptBlock[];

const summary: ActivitySummary = {
  thinking: 0,
  tools: 12,
  contributions: [{ category: "command", count: 12, iconType: "command" }],
  iconType: "command",
};

const renderGroup = () =>
  renderToStaticMarkup(
    createElement(
      SessionProvider,
      null,
      createElement(ActivityGroup, {
        blocks: longRun,
        summary,
        t,
        onOpenFile: noop,
        expanded: true,
        onExpandedChange: noop,
      }),
    ),
  );

describe("the group body has no cap and no scrollbar of its own", () => {
  test("the rendered box carries neither a max-height nor an overflow utility", () => {
    const html = renderGroup();
    const box = html.match(/<div[^>]*data-testid="activity-group-detail"[^>]*>/)?.[0] ?? "";
    assert.ok(box.length > 0, "activity-group-detail must render");
    assert.doesNotMatch(box, /max-h-\[/, "the group body must not cap its height");
    assert.doesNotMatch(box, /overflow-y-auto|overflow-auto|overflow-scroll|overflow-y-scroll/);
    assert.doesNotMatch(box, /scrollbar-hide/);
  });

  test("the rendered box is a zero-gap column", () => {
    const box = renderGroup().match(/<div[^>]*data-testid="activity-group-detail"[^>]*>/)?.[0] ?? "";
    assert.match(box, /activity-group-items/);
    assert.match(box, /gap-0/);
    assert.doesNotMatch(box, /gap-1\.5|gap-2|gap-3/);
  });

  test("the long run renders all twelve rows, not a windowed subset", () => {
    // The cap never saved render work — a collapsed `<details>` keeps its body
    // in the DOM — so removing it cannot have cost anything, and the visible
    // consequence is that every step is in the list.
    const html = renderGroup();
    assert.equal((html.match(/data-testid="tool-card"/g) ?? []).length, 12);
  });

  test("no stylesheet re-introduces a cap or a scrollbar on the box", () => {
    // A class-only tripwire cannot see a property that arrives from a
    // stylesheet, and globals.css is not the last one loaded.
    const sheets = loadedStylesheets();
    const found = sheets.flatMap(({ sheet, css }) =>
      rulesForSelector(css, sheet, ".activity-group-items"),
    );
    assert.ok(found.length > 0, "the box class must be styled somewhere");
    for (const rule of found) {
      assert.doesNotMatch(rule.body, /max-height/, `${rule.sheet} caps the group body`);
      assert.doesNotMatch(rule.body, /overflow/, `${rule.sheet} gives the group body a scrollbar`);
    }
  });

  test("the reference's 28px row floor is defined outside any @layer", () => {
    // `.activity-group-items > *` rather than a class per row: the children
    // are native <details> elements with no class in common. Outside every
    // @layer so Tailwind's purge cannot drop it (the rule
    // `.message-animate-in` follows).
    const sheets = loadedStylesheets();
    const found = sheets.flatMap(({ sheet, css }) =>
      rulesForSelector(css, sheet, ".activity-group-items > *"),
    );
    assert.equal(found.length, 1, "exactly one declaration of the row floor");
    assert.match(found[0]?.body ?? "", /min-height:\s*28px/);
    assert.equal(
      found[0]?.layer ?? null,
      null,
      "the rule must not sit inside an @layer (Tailwind purges those)",
    );
  });

  test("the source keeps the cap off the component too", () => {
    const box = activitySource.slice(
      activitySource.indexOf('data-testid="activity-group-detail"') - 200,
      activitySource.indexOf('data-testid="activity-group-detail"') + 200,
    );
    assert.doesNotMatch(box, /max-h-\[230px\]/);
    assert.doesNotMatch(box, /overflow-y-auto/);
  });
});

describe("the tool detail keeps the one scroll container the desktop has", () => {
  test("the detail pre is capped at 180px, not 320px", () => {
    assert.match(activitySource, /thin-scrollbar max-h-\[180px\] overflow-auto/);
    assert.doesNotMatch(activitySource, /max-h-\[320px\]/);
  });

  test("the rendered pre carries the 180px cap", () => {
    const html = renderToStaticMarkup(
      createElement(
        SessionProvider,
        null,
        createElement(ActivityGroup, {
          blocks: [
            {
              role: "tool",
              toolName: "bash",
              text: "x".repeat(50),
              toolArgs: '{"cmd":"ls"}',
              toolStatus: "completed",
            },
          ] as unknown as TranscriptBlock[],
          summary: { ...summary, tools: 1, contributions: [{ category: "command", count: 1, iconType: "command" }] },
          t,
          onOpenFile: noop,
          expanded: true,
          onExpandedChange: noop,
        }),
      ),
    );
    const pre = html.match(/<pre[^>]*>/)?.[0] ?? "";
    assert.ok(pre.length > 0, "the tool detail must render a pre");
    assert.match(pre, /max-h-\[180px\]/);
    assert.match(pre, /overflow-auto/);
  });
});
