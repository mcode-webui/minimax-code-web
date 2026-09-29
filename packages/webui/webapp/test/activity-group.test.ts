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

const { ActivityGroup, TurnProcessDisclosure, isActivityGroupActive, assignActivityBlockKeys } = await import(
  "../components/activity-group"
);
const { ToolIcon } = await import("../components/tool-icon");
const { SessionProvider } = await import("../lib/store");
const { translate } = await import("../lib/i18n");
const { groupActivity, decodeTranscript: realDecode } = await import("../lib/transcript");

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

/** A tool block with a full body — the PR3 (D4) render fixture. */
function richToolBlock(overrides: Partial<TranscriptBlock> = {}): TranscriptBlock {
  return {
    role: "tool",
    text: "→ bash  {}",
    toolName: "bash",
    toolArgs: '{"command":"ls"}',
    toolOutput: ["total 0"],
    toolPaths: [],
    toolStatus: "completed",
    ...overrides,
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

describe("ToolCard — the tool row (D4, PR3)", () => {
  // No subagent fixture, no paths → the card contains zero <button>
  // elements, which is also the no-nested-buttons proof (see below).
  const html = renderGroup([richToolBlock()], toolsOnlySummary);

  test("folds through a native details/summary — the header is not a button", () => {
    assert.match(html, /<details[^>]*data-testid="tool-card"[^>]*>/);
    assert.match(html, /<summary[^>]*>/);
    // The retired header was a <button> whose body sometimes held the
    // subagent badge — another <button> — i.e. invalid HTML. With the
    // native summary this fixture renders no button at all; a badge
    // would be a legal interactive descendant of <summary>.
    assert.doesNotMatch(html, /<button/);
  });

  test("the summary shows the human label, not the raw tool name", () => {
    assert.match(html, />终端</);
    assert.doesNotMatch(html, />bash</);
  });

  test("a completed call renders no status chip (reference rule)", () => {
    assert.doesNotMatch(html, /data-testid="tool-card-status"/);
    assert.doesNotMatch(html, /已完成/);
    assert.match(html, /data-tool-status="completed"/);
  });

  test("the body splits into 输入 / 结果; args moved off the summary row", () => {
    assert.match(html, /输入/);
    assert.match(html, /结果/);
    assert.doesNotMatch(html, /错误/);
    // The args appear exactly once — in the 输入 section of the body,
    // no longer on the summary row (ticket 46 P4 decision). Match the
    // ESCAPED args form (&quot;command&quot;) so the icon-type attribute
    // value "command" cannot collide with the assertion.
    const cardStart = html.indexOf('data-testid="tool-card"');
    const cardHtml = cardStart >= 0 ? html.slice(cardStart) : html;
    const summaryRow = cardHtml.match(/<summary[\s\S]*?<\/summary>/)?.[0] ?? "";
    assert.doesNotMatch(summaryRow, /&quot;command/);
    assert.match(html, /&quot;command/);
  });

  test("status copy follows the five-state vocabulary", () => {
    const running = renderGroup(
      [richToolBlock({ toolStatus: "in_progress" })],
      toolsOnlySummary,
    );
    assert.match(running, /data-testid="tool-card-status"/);
    assert.match(running, /运行中/);
    assert.match(running, /data-tool-status="running"/);
    const cancelled = renderGroup(
      [richToolBlock({ toolStatus: "cancelled" })],
      toolsOnlySummary,
    );
    assert.match(cancelled, /已取消/);
    assert.match(cancelled, /data-tool-status="cancelled"/);
  });

  test("a failed call renders its output as the red 错误 section", () => {
    const failed = renderGroup(
      [richToolBlock({ toolStatus: "failed", toolOutput: ["boom"] })],
      toolsOnlySummary,
    );
    assert.match(failed, /data-tool-status="error"/);
    assert.match(failed, /失败/);
    assert.match(failed, /data-testid="tool-card-error-section"/);
    // The result section is suppressed for errors — 错误 replaces 结果.
    assert.doesNotMatch(failed, /结果/);
    // Both the section label and the body carry the error colour.
    const errorSection = failed.match(
      /<section[^>]*tool-card-error-section[\s\S]*?<\/section>/,
    )?.[0];
    assert.ok(errorSection, "error section missing");
    assert.match(errorSection, /text-text_status_error/);
    assert.match(errorSection, /错误/);
    assert.match(errorSection, /boom/);
    // The leading icon turns error-coloured too.
    assert.match(failed, /<svg[^>]*text-text_status_error/);
  });

  test("a failed call with no output falls back to 执行失败", () => {
    const failed = renderGroup(
      [richToolBlock({ toolStatus: "failed", toolOutput: [] })],
      toolsOnlySummary,
    );
    assert.match(failed, /执行失败/);
  });

  test("a running call with no output shows the running placeholder", () => {
    const running = renderGroup(
      [richToolBlock({ toolStatus: "in_progress", toolArgs: "", toolOutput: [] })],
      toolsOnlySummary,
    );
    assert.match(running, /data-testid="tool-card-running"/);
    assert.match(running, /运行中…/);
  });

  test("read-style calls lift the resource path onto the summary (title = full path)", () => {
    const readHtml = renderGroup(
      [
        richToolBlock({
          text: "→ read",
          toolName: "read",
          // Live-verified wire shape: the read header carries NO args;
          // the path arrives as a `@ path` line the decoder collects.
          toolArgs: "",
          toolPaths: ["/ws/packages/a.ts"],
          toolOutput: ["file body"],
        }),
      ],
      toolsOnlySummary,
    );
    const pathSpan = readHtml.match(
      /<span[^>]*data-testid="tool-card-resource-path"[^>]*>/,
    )?.[0];
    assert.ok(pathSpan, "resource-path span missing");
    assert.match(pathSpan, /title="\/ws\/packages\/a\.ts"/);
    assert.match(readHtml, />a\.ts</);
    // 读取文件 — the read label.
    assert.match(readHtml, /读取文件/);
    // The args-less card still has a body (the output section).
    assert.match(readHtml, /结果/);
  });

  test("over-long bodies clamp at 2000 characters with ...", () => {
    const long = renderGroup(
      [richToolBlock({ toolOutput: ["x".repeat(2500)] })],
      toolsOnlySummary,
    );
    // Exactly 2000 kept characters then "..." inside the body pre —
    // and not one character more of the 2500 that were fed in.
    assert.match(long, /<pre[^>]*>x{2000}\.\.\.<\/pre>/);
    assert.doesNotMatch(long, /<pre[^>]*>x{2001}/);
  });

  test("icons are 16×16 SVGs from the catalog, not unicode glyphs", () => {
    assert.match(html, /<svg[^>]*viewBox="0 0 16 16"/);
    assert.doesNotMatch(activitySource, /CATEGORY_GLYPH/);
    // The catalog itself renders the reference stroke style and keys
    // every SummaryIconType.
    const catalog = renderToStaticMarkup(createElement(ToolIcon, { type: "command" }));
    assert.match(catalog, /<svg[^>]*viewBox="0 0 16 16"/);
    assert.match(catalog, /stroke-width="1\.25"/);
    assert.match(catalog, /data-tool-icon-type="command"/);
  });

  test("the orphan data-message-collapse-trigger marker is gone", () => {
    // QA-registered leftover: the attribute had no consumer anywhere in
    // the repo (grep-verified) — removed rather than carried forward.
    assert.doesNotMatch(activitySource, /data-message-collapse-trigger/);
  });
});

describe("TurnProcessDisclosure — the turn bar (D6, PR3)", () => {
  const stats = { thinking: 1, tools: 2, answerChars: 600 };
  const renderBar = (props: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      createElement(TurnProcessDisclosure, {
        stats,
        processedDurationMs: 125000,
        t,
        ...props,
      }),
    );

  test("settled: composite summary with M 分 N 秒 and the output rate", () => {
    const html = renderBar();
    assert.match(html, /思考 1 次，用了 2 次工具，共执行 2 分 5 秒/);
    assert.match(html, /data-testid="turn-process-disclosure"/);
    assert.match(html, /data-testid="turn-process-summary-text"/);
    // 600 chars / 125s = 4.8 → 5 token/s (character estimate — the wire
    // carries no per-turn token count; see the component docblock).
    assert.match(html, /data-testid="turn-output-rate"/);
    assert.match(html, /5 token\/s/);
  });

  test("settled under a minute: bare seconds, zero-count parts drop out", () => {
    const html = renderBar({
      processedDurationMs: 42000,
      stats: { thinking: 0, tools: 0, answerChars: 0 },
    });
    assert.match(html, /共执行 42 秒/);
    assert.doesNotMatch(html, /思考/);
    assert.doesNotMatch(html, /用了/);
    assert.doesNotMatch(html, /turn-output-rate/);
  });

  test("live: 已执行 renders 0 on the first frame and no rate", () => {
    // SSR/hydration frame: the tick starts in an effect, so the first
    // render is deterministic 0 regardless of startedAtMs.
    const html = renderBar({ active: true, startedAtMs: Date.now() - 30000 });
    assert.match(html, /已执行 0 秒/);
    assert.match(html, /思考 1 次，用了 2 次工具/);
    assert.doesNotMatch(html, /turn-output-rate/);
  });

  test("a 0.5px separator closes the bar from below", () => {
    const html = renderBar();
    assert.match(html, /data-testid="turn-process-separator"/);
    assert.match(html, /border-b-\[0\.5px\]/);
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
    assert.match(chatSource, /import \{ ActivityGroup, TurnProcessDisclosure, assignActivityBlockKeys \} from "\.\/activity-group"/);
    assert.doesNotMatch(chatSource, /function ActivityGroup\(/);
    assert.doesNotMatch(chatSource, /function ThinkingRow\(/);
    assert.doesNotMatch(chatSource, /function ToolCard\(/);
    // PR3: the turn bar moved here too — chat.tsx keeps only the wiring.
    assert.doesNotMatch(chatSource, /function TurnProcessDisclosure\(/);
  });

  test("the turn-process bar is wired with turn stats (PR3 D6)", () => {
    // Settled turns: every assistant tail block renders the bar with its
    // precomputed stats; the live turn renders the active bar at the
    // transcript tail.
    assert.match(chatSource, /processedDurationMs=\{block\.processedDuration\}/);
    assert.match(chatSource, /stats=\{turnStats \?\? \{ thinking: 0, tools: 0, answerChars: 0 \}\}/);
    assert.match(chatSource, /const turnStatsByUnit = useMemo\(\(\) => computeTurnStatsByUnit\(units\), \[units\]\)/);
    assert.match(chatSource, /const activeTurnStats = useMemo\(/);
    assert.match(chatSource, /startedAtMs=\{runningStartedAt\}/);
  });

  test("the stable block keys are assigned once per units pass and forwarded (P3-1)", () => {
    assert.match(chatSource, /const activityBlockKeys = useMemo\(\(\) => assignActivityBlockKeys\(units\), \[units\]\)/);
    assert.match(chatSource, /blockKeys=\{activityBlockKeys\.get\(originalIndex\)\}/);
    // The rows consume the stable key, not their within-group position.
    assert.match(activitySource, /key=\{blockKeys\?\.\[index\] \?\? index\}/);
  });
});

describe("assignActivityBlockKeys — stable birth-order keys (P3-1)", () => {
  // Frames replay the mid-turn reality the fix targets: a tool header only
  // lands when the tool completes (verified against the live engine in the
  // P2-1 probe), and prose lines stream in between, so consecutive frames
  // of the SAME turn re-cut the activity runs. The keys must not move a
  // block when the groups around it do.
  const decodeUnits = (lines: readonly string[]) => groupActivity(realDecode(lines, {}));

  test("append-only growth keeps every existing block's key", () => {
    const before = decodeUnits(["› q", "▲ think one", "  [completed]"]);
    const after = decodeUnits(["› q", "▲ think one", "  [completed]", "● answer"]);
    const kb = assignActivityBlockKeys(before);
    const ka = assignActivityBlockKeys(after);
    const keysBefore = [...kb.values()][0] ?? [];
    const keysAfter = [...ka.values()][0] ?? [];
    assert.deepEqual(keysAfter.slice(0, keysBefore.length), keysBefore);
  });

  test("re-cutting the runs (tool header lands late) moves no key", () => {
    // Frame A: the thought streams, tool header not yet written.
    const frameA = ["› q", "▲ think step"];
    // Frame B: the tool completed (header + status land together) and prose
    // follows, so the run is re-cut into [thought, tool] + prose.
    const frameB = ["› q", "▲ think step", "→ bash  {}", "  [completed]", "● done"];
    const keysA = [...assignActivityBlockKeys(decodeUnits(frameA)).values()][0] ?? [];
    const keysB = [...assignActivityBlockKeys(decodeUnits(frameB)).values()][0] ?? [];
    // The thought is decode-block 1 in both frames → key b1 in both; the
    // late-landing tool becomes b2 without disturbing it.
    assert.deepEqual(keysA, ["b1"]);
    assert.deepEqual(keysB, ["b1", "b2"]);
  });

  test("a prose line between thoughts keeps each thought's key stable", () => {
    const frameA = ["› q", "▲ one", "→ bash  {}", "  [completed]"];
    // Frame B: prose streamed in after the tool and a second thought began,
    // re-cutting into [thought, tool] | prose | [thought].
    const frameB = ["› q", "▲ one", "→ bash  {}", "  [completed]", "● mid", "▲ two"];
    const unitsB = decodeUnits(frameB);
    const mapB = [...assignActivityBlockKeys(unitsB).entries()];
    // Frame A: one activity unit [b1(thought), b2(tool)].
    assert.deepEqual([...assignActivityBlockKeys(decodeUnits(frameA)).values()][0], ["b1", "b2"]);
    // Frame B: the first unit is unchanged; the new thought is b4 (the
    // prose line consumed b3 in birth order).
    assert.deepEqual(mapB[0]?.[1], ["b1", "b2"]);
    assert.deepEqual(mapB[mapB.length - 1]?.[1], ["b4"]);
  });
});


// Known test boundary (acceptance P3-2): the elapsed-seconds rendering has
// no positive assertion in this suite. `renderToStaticMarkup` never runs
// effects, so the interval-driven `elapsed` state is always null in SSR
// output — the existing assertions can only pin its absence. The behaviour
// is covered by the live-instance evidence (ticking 1s→4s captured in the
// acceptance run) and by the key-stability tests above, which protect the
// state that carries the frozen total.

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
    // PR3 (D4/D6) keys.
    assert.equal(translate("zh", "tool.status.pending"), "等待中");
    assert.equal(translate("zh", "tool.status.cancelled"), "已取消");
    assert.equal(translate("zh", "tool.status.in_progress"), "运行中");
    assert.equal(translate("zh", "tool.section.input"), "输入");
    assert.equal(translate("zh", "tool.section.result"), "结果");
    assert.equal(translate("zh", "tool.section.error"), "错误");
    assert.equal(translate("zh", "tool.executionFailed"), "执行失败");
    assert.equal(translate("zh", "turn.usedTools"), "用了 {{count}} 次工具");
    assert.equal(translate("zh", "turn.elapsedActive"), "已执行 {{duration}}");
    assert.equal(translate("zh", "turn.elapsedTotal"), "共执行 {{duration}}");
    assert.equal(translate("zh", "turn.duration.minutes"), "{{minutes}} 分 {{seconds}} 秒");
    assert.equal(translate("zh", "turn.duration.seconds"), "{{seconds}} 秒");
  });

  test("en", () => {
    assert.equal(translate("en", "activity.thinkingLive"), "Thinking...");
    assert.equal(translate("en", "activity.thinkingDone"), "Finished thinking");
    assert.equal(translate("en", "activity.expand"), "Expand");
    assert.equal(translate("en", "activity.collapse"), "Collapse");
    // PR3 (D4/D6) keys — equal weight, not a translation afterthought.
    assert.equal(translate("en", "tool.status.pending"), "pending");
    assert.equal(translate("en", "tool.status.cancelled"), "cancelled");
    assert.equal(translate("en", "tool.section.input"), "Input");
    assert.equal(translate("en", "tool.section.result"), "Result");
    assert.equal(translate("en", "tool.section.error"), "Error");
    assert.equal(translate("en", "tool.executionFailed"), "Execution failed");
    assert.equal(translate("en", "turn.usedTools"), "used {{count}} tools");
    assert.equal(translate("en", "turn.elapsedActive"), "Elapsed {{duration}}");
    assert.equal(translate("en", "turn.elapsedTotal"), "Completed in {{duration}}");
    assert.equal(translate("en", "turn.duration.minutes"), "{{minutes}}m {{seconds}}s");
    assert.equal(translate("en", "turn.duration.seconds"), "{{seconds}}s");
  });
});
