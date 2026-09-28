// webapp/test/activity-group.test.ts
//
// Render + wiring tests for the activity-rendering family (webui ticket 46,
// PR2 — thinking block D2 + activity group D3), lifted into
// `components/activity-group.tsx` so this suite can drive the real markup
// through `renderToStaticMarkup` (the same SSR shape Next uses) without
// pulling `chat.tsx`'s `@/`-aliased import graph, which the node test
// runner cannot resolve. Precedent: `loading-skeleton.test.ts` (ticket U8).
//
// What is pinned here, and why:
//
//   - the native `<details>`/`<summary>` folding: the group header is ONE
//     toggle (not a text button plus a separate chevron button), and the
//     thinking block folds through the same native mechanism — keyboard
//     reachability and the `open` semantics come from the platform;
//   - the forced-open rules: a run holding a running/pending tool (or a
//     streaming thought) renders with `open` and `data-active`, and the
//     onToggle handler snaps the DOM back open because React will not
//     re-apply an unchanged `open` attribute after a user click;
//   - the timeline spine on the group body's left edge;
//   - the thinking summary row: icon + status copy + seconds + chevron, with
//     「推理中...」 while streaming and 「已完成推理」 once settled;
//   - the thinking body renders through the Markdown pipeline (bold text
//     arrives as <strong>, not as literal asterisks);
//   - the clamp plumbing: `is-clamped` / the expand button only appear after
//     a client-side measurement, so the static markup must NOT carry them;
//   - the chat.tsx call site still passes `streaming` / `startedAtMs` (the
//     tail-run derivation), and the retired two-button header is gone;
//   - the i18n tables carry both locales for the four new keys.
//
// createElement, not JSX: this suite is a `.test.ts` file (the test:webapp
// glob is `**/*.test.ts`), and the tsx loader only transpiles JSX in `.tsx`.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ActivitySummary, TranscriptBlock } from "../lib/transcript";

// components/icons.tsx (pulled in through the component graph) compiles its
// JSX under the classic runtime in this process, which resolves a bare
// `React` identifier. Stub the ambient global through a typed alias rather
// than re-declaring it (a `var React` narrower than the lib's fails tsc).
// The stub must be in place BEFORE the component modules load, so the
// component imports below are dynamic — a static import would hoist above
// the stub and evaluate the graph with `React` still missing.
{
  const reactModule = React;
  Object.defineProperty(globalThis, "React", {
    value: reactModule,
    configurable: true,
    writable: true,
  });
}

const { ActivityGroup, isActivityGroupActive } = await import(
  "../components/activity-group"
);
const { SessionProvider } = await import("../lib/store");
const { translate } = await import("../lib/i18n");

const here = dirname(fileURLToPath(import.meta.url));
const chatSource = readFileSync(resolve(here, "../components/chat.tsx"), "utf8");
const activitySource = readFileSync(
  resolve(here, "../components/activity-group.tsx"),
  "utf8",
);
const globalsCss = readFileSync(resolve(here, "../app/globals.css"), "utf8");

const t = (key: Parameters<typeof translate>[1]) => translate("zh", key);
const noop = () => {};

/** A thoughts-only summary fixture — the shape `summarizeActivity` returns
 *  for a run of adjacent thinking blocks with no tool blocks. */
const thoughtsOnlySummary: ActivitySummary = {
  thinking: 1,
  tools: 0,
  contributions: [{ category: "thinking", count: 1, iconType: "thinking" }],
  iconType: "thinking",
};

/** A mixed run summary — thoughts AND tools, the case upstream expands by
 *  default (`AssistantBody` renderActivityParts: `initiallyExpanded`). */
const mixedSummary: ActivitySummary = {
  thinking: 1,
  tools: 1,
  contributions: [
    { category: "thinking", count: 1, iconType: "thinking" },
    { category: "command", count: 1, iconType: "command" },
  ],
  iconType: "thinking",
};

/** A pure-tool run summary — upstream starts these collapsed. */
const toolsOnlySummary: ActivitySummary = {
  thinking: 0,
  tools: 1,
  contributions: [{ category: "command", count: 1, iconType: "command" }],
  iconType: "command",
};

function thinkingBlock(text: string): TranscriptBlock {
  return { role: "thinking", text };
}

function toolBlock(status?: string): TranscriptBlock {
  return {
    role: "tool",
    text: "→ bash",
    toolName: "bash",
    toolArgs: "",
    toolOutput: [],
    toolPaths: [],
    ...(status ? { toolStatus: status } : {}),
  };
}

/** Render an ActivityGroup inside the store provider — ToolCard reads the
 *  session context (subagent badges), and the SSR store snapshot is the
 *  stable `INITIAL` (state null), so tool rows render their no-subagent
 *  branch without any transport. */
function renderGroup(
  blocks: TranscriptBlock[],
  summary: ActivitySummary,
  props: Record<string, unknown> = {},
): string {
  return renderToStaticMarkup(
    createElement(
      SessionProvider,
      null,
      createElement(ActivityGroup, {
        blocks,
        summary,
        t,
        onOpenFile: noop,
        ...props,
      }),
    ),
  );
}

describe("ActivityGroup — native <details> folding (D3)", () => {
  const html = renderGroup([thinkingBlock("想一下 **加粗** 的地方")], thoughtsOnlySummary);

  test("the group is one native details whose summary carries the header testid", () => {
    assert.match(html, /<details[^>]*data-testid="activity-group"[^>]*>/);
    assert.match(html, /<summary[^>]*data-testid="activity-group-header"[^>]*>/);
    // The retired construction had a separate chevron-only button with the
    // activity.detail aria-label; the native summary replaces both buttons.
    assert.doesNotMatch(activitySource, /aria-label=\{t\("activity\.detail"\)\}/);
  });

  test("the retained data-testids keep their names", () => {
    assert.match(html, /data-testid="activity-group-header-shell"/);
    assert.match(html, /data-testid="activity-group-header-icon"/);
    assert.match(html, /data-testid="activity-group-detail"/);
  });

  test("the body carries the timeline spine", () => {
    // SSR reorders attributes (class first) — assert the tag carries both,
    // not their order.
    const spineTag = html.match(/<span\b[^>]*timeline-spine[^>]*>/)?.[0] ?? "";
    assert.ok(spineTag.length > 0, "timeline-spine span missing");
    assert.match(spineTag, /aria-hidden="true"/);
  });

  test("a thoughts-only run defaults expanded; a pure-tool run defaults collapsed", () => {
    assert.match(html, /<details[^>]*\bopen\b/);
    const toolsHtml = renderGroup([toolBlock("completed")], toolsOnlySummary);
    assert.doesNotMatch(toolsHtml, /<details[^>]*\bopen\b/);
  });

  test("a mixed run (thoughts + tools) defaults expanded", () => {
    const mixedHtml = renderGroup(
      [thinkingBlock("先想一想"), toolBlock("completed")],
      mixedSummary,
    );
    assert.match(mixedHtml, /<details[^>]*\bopen\b/);
  });

  test("a settled tool run carries no data-active attribute", () => {
    const toolsHtml = renderGroup([toolBlock("completed")], toolsOnlySummary);
    assert.doesNotMatch(toolsHtml, /data-active="true"/);
  });

  test("a run holding an in-flight tool forces open and marks data-active", () => {
    // No status line yet = the call is running (the summarizer's own rule).
    const runningHtml = renderGroup([toolBlock(undefined)], toolsOnlySummary);
    assert.match(runningHtml, /data-active="true"/);
    assert.match(runningHtml, /<details[^>]*\bopen\b/);
    // Explicit [in_progress] counts as running too.
    const inProgressHtml = renderGroup([toolBlock("in_progress")], toolsOnlySummary);
    assert.match(inProgressHtml, /data-active="true"/);
    assert.match(inProgressHtml, /<details[^>]*\bopen\b/);
  });

  test("the onToggle handler snaps the DOM back open while forced", () => {
    // React does not re-apply an unchanged `open` attribute, so the handler
    // must reset it itself — this is the "cannot collapse while running"
    // rule and the single most revertable line in the lift.
    assert.match(activitySource, /forcedOpen && !next[\s\S]{0,400}currentTarget\.open = true/);
    assert.match(activitySource, /const forcedOpen = active \|\| streaming/);
  });
});

describe("isActivityGroupActive — the forced-open predicate", () => {
  test("no status line (call still streaming) is active", () => {
    assert.equal(isActivityGroupActive([toolBlock(undefined)]), true);
  });

  test("in_progress is active", () => {
    assert.equal(isActivityGroupActive([toolBlock("in_progress")]), true);
  });

  test("terminal statuses are not active", () => {
    assert.equal(isActivityGroupActive([toolBlock("completed")]), false);
    assert.equal(isActivityGroupActive([toolBlock("failed")]), false);
  });

  test("thinking blocks never make a run active", () => {
    assert.equal(isActivityGroupActive([thinkingBlock("…")]), false);
  });

  test("one in-flight tool among settled ones is active", () => {
    assert.equal(
      isActivityGroupActive([toolBlock("completed"), toolBlock(undefined)]),
      true,
    );
  });
});

describe("ThinkingRow — the thinking block (D2)", () => {
  const html = renderGroup(
    [thinkingBlock("先想 **加粗** 的结论，再列条目：\n\n- 一\n- 二")],
    thoughtsOnlySummary,
  );

  test("folds through a native details with its own summary row", () => {
    assert.match(html, /<details[^>]*data-testid="thinking-block"[^>]*>/);
    assert.match(html, /<summary[^>]*data-testid="thinking-summary"[^>]*>/);
  });

  test("the summary row shows the icon, the settled copy, and the chevron", () => {
    assert.match(html, /data-testid="thinking-summary-icon"/);
    assert.match(html, /data-tool-icon-type="thinking"/);
    assert.match(html, /已完成推理/);
    assert.doesNotMatch(html, /思考过程/);
  });

  test("the body renders through the Markdown pipeline, not plain text", () => {
    // In Node (no DOMParser) the sanitiser's safety fallback entity-escapes
    // the entire parsed HTML — see markdown-html-render.test.ts:80 — so the
    // SSR markup carries the ESCAPED parse result. That is still proof the
    // text went through marked + the sanitiser: the literal source would
    // keep its asterisks, the pipeline's output never does.
    assert.match(html, /&lt;strong&gt;加粗&lt;\/strong&gt;/);
    assert.match(html, /&lt;li&gt;/);
    assert.doesNotMatch(html, /\*\*加粗\*\*/);
  });

  test("no seconds, no live status, no clamp in the settled static markup", () => {
    // Duration data does not exist on a cold-loaded thought (the wire has no
    // per-thinking timestamps), and the clamp needs a client measurement —
    // neither may be fabricated server-side.
    assert.doesNotMatch(html, /thinking-live-status/);
    assert.doesNotMatch(html, /is-clamped/);
    assert.doesNotMatch(html, /data-testid="thinking-expand"/);
    assert.doesNotMatch(html, /webui-thinking-elapsed/);
  });

  test("streaming forces the block open and shows the live status row", () => {
    const streamingHtml = renderGroup(
      [thinkingBlock("正在推理…")],
      thoughtsOnlySummary,
      { streaming: true, startedAtMs: Date.now() - 5000 },
    );
    assert.match(streamingHtml, /data-testid="thinking-live-status"/);
    assert.match(streamingHtml, /推理中\.\.\./);
    assert.match(streamingHtml, /thinking-live-dot/);
    // The streaming thinking details is force-open…
    const openDetails = streamingHtml.match(/<details[^>]*data-testid="thinking-block"[^>]*>/)?.[0] ?? "";
    assert.match(openDetails, /\bopen\b/);
    // …and like the group, its onToggle handler snaps the DOM back open.
    assert.match(activitySource, /streaming && !next[\s\S]{0,400}currentTarget\.open = true/);
  });
});

describe("chat.tsx wiring — the streaming derivation stays put", () => {
  test("the tail-run derivation feeds streaming and startedAtMs into the group", () => {
    assert.match(chatSource, /const streamingActivityIndex = useMemo/);
    assert.match(
      chatSource,
      /streaming=\{originalIndex === streamingActivityIndex\}/,
    );
    assert.match(chatSource, /startedAtMs=\{runningStartedAt\}/);
    // The derivation itself: tail unit is an activity run ending on a thought.
    assert.match(chatSource, /last\?\.role === "thinking" \? units\.length - 1 : -1/);
    assert.match(chatSource, /const runningStartedAt = state\?\.running\.startedAt \?\? null/);
  });

  test("the moved components are imported, not duplicated", () => {
    assert.match(chatSource, /import \{ ActivityGroup \} from "\.\/activity-group"/);
    assert.doesNotMatch(chatSource, /function ActivityGroup\(/);
    assert.doesNotMatch(chatSource, /function ThinkingRow\(/);
    assert.doesNotMatch(chatSource, /function ToolCard\(/);
  });

  test("the turn-process disclosure is untouched", () => {
    assert.match(chatSource, /data-testid="turn-process-disclosure"/);
  });
});

describe("globals.css — spine, clamp, marker suppression, pulse", () => {
  test("the timeline spine rule exists with the upstream offsets", () => {
    assert.match(globalsCss, /\.timeline-spine\s*\{[^}]*position:\s*absolute/s);
    assert.match(globalsCss, /\.timeline-spine\s*\{[^}]*left:\s*7px/s);
  });

  test("the clamp caps at 224px with a gradient mask", () => {
    assert.match(globalsCss, /\.webui-thinking-detail-content\.is-clamped\s*\{[^}]*max-height:\s*224px/s);
    assert.match(globalsCss, /\.is-clamped::after/);
  });

  test("native summary markers are suppressed for both details kinds", () => {
    assert.match(globalsCss, /details\[data-testid="activity-group"\] > summary/);
    assert.match(globalsCss, /details\.webui-thinking-block > summary/);
  });

  test("the live dot pulses and is switched off under reduced motion", () => {
    assert.match(globalsCss, /@keyframes thinking-live-pulse/);
    const reduceBlock = globalsCss.slice(
      globalsCss.indexOf("@media (prefers-reduced-motion: reduce)"),
    );
    assert.match(reduceBlock, /\.thinking-live-dot\s*\{\s*animation:\s*none;?\s*\}/);
  });
});

describe("i18n — both locales carry the thinking-block copy", () => {
  test("zh", () => {
    assert.equal(translate("zh", "activity.thinkingLive"), "推理中...");
    assert.equal(translate("zh", "activity.thinkingDone"), "已完成推理");
    assert.equal(translate("zh", "activity.expand"), "展开");
    assert.equal(translate("zh", "activity.collapse"), "收起");
  });

  test("en", () => {
    assert.equal(translate("en", "activity.thinkingLive"), "Thinking...");
    assert.equal(translate("en", "activity.thinkingDone"), "Finished thinking");
    assert.equal(translate("en", "activity.expand"), "Expand");
    assert.equal(translate("en", "activity.collapse"), "Collapse");
  });
});
