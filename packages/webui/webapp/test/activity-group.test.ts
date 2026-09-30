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
//   - the slice-06 subagent badge: when a `→ task` line has a matching
//     `recentSubagents[]` entry the summary row grows a real `<button>`
//     carrying the child session id, the localized 「glyph + agent label」
//     text and the status colour; with no match the card stays button-free;
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
import type { RecentSubagent, WebuiState } from "../lib/types";

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
const { SessionProvider, __testSnapshot } = await import("../lib/store");
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

// --- slice 06 (Agent Team) subagent badge fixtures -------------------------
//
// How the badge fixture reaches the renderer, and why it is not
// `__testApplyAction`. `useSession()` reads
// `useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)`, and
// `renderToStaticMarkup` runs the SERVER branch — `getServerSnapshot`,
// which returns the store's `INITIAL` constant. The live `snapshot` that
// `__testApplyAction` writes is never consulted on that path, so pushing a
// `state` action leaves `ToolCard` with `state === null` and the badge
// absent (verified by probe, not assumed). `INITIAL` is still reachable
// from the test side: `lib/store.tsx` initialises `let snapshot` FROM that
// same constant, so the object `__testSnapshot()` returns before any action
// has been applied IS `INITIAL`. Swapping its `state` field in place puts a
// `recentSubagents` list in front of the renderer, and `runWithSubagents`
// restores the field in a `finally` so the rest of the suite keeps seeing
// the no-subagent baseline. No production backdoor is added: the hook used
// here (`__testSnapshot`) is already exported for tests.
const serverSnapshot = __testSnapshot();

/** A subagent row as `WebuiState.recentSubagents` carries it — see
 *  `lib/types.ts#RecentSubagent`. `status` is the UI vocabulary, never a
 *  raw db string. */
function subagentEntry(overrides: Partial<RecentSubagent> = {}): RecentSubagent {
  return {
    toolCallId: "tc-1",
    sessionId: "child-session-a",
    agentName: "verifier",
    status: "running",
    ...overrides,
  };
}

/** A `→ task` dispatch block — the only tool family that can carry a
 *  subagent badge (`findSubagentForBlock` gates on the name), with the
 *  `toolCallId` the decoder attaches from the server's `##tc:` marker. */
function taskBlock(toolCallId: string, overrides: Partial<TranscriptBlock> = {}): TranscriptBlock {
  return {
    role: "tool",
    text: "→ task",
    toolName: "task",
    toolArgs: '{"subagent_type":"verifier"}',
    toolOutput: [],
    toolPaths: [],
    toolStatus: "completed",
    toolCallId,
    ...overrides,
  };
}

/** Render one ActivityGroup with a `recentSubagents` list in the store's
 *  server snapshot, restoring the previous state afterwards. */
function renderWithSubagents(
  blocks: TranscriptBlock[],
  recent: RecentSubagent[] | undefined,
  summary: ActivitySummary = toolsOnlySummary,
): string {
  const saved = serverSnapshot.state;
  // Only the fields `ToolCard` reads are populated; the badge path never
  // touches the rest of the snapshot.
  serverSnapshot.state = { recentSubagents: recent } as unknown as WebuiState;
  try {
    return renderGroup(blocks, summary);
  } finally {
    serverSnapshot.state = saved;
  }
}

/** The badge's own opening tag (attributes included) — the unit every
 *  colour / jump-target assertion is made against. */
function badgeTag(html: string): string {
  const tag = html.match(/<button[^>]*data-testid="tool-card-subagent-badge"[^>]*>/)?.[0];
  assert.ok(tag, "tool-card-subagent-badge button missing");
  return tag;
}

/** The badge's rendered text, glyph included. */
function badgeText(html: string): string {
  return html.match(
    /data-testid="tool-card-subagent-badge"[^>]*>([^<]*)</,
  )?.[1] ?? "";
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

// The badge is the slice-06 answer to the "main/sub-agent communication must
// not degrade" red line: the parent turn's `→ task` line is the ONLY place
// the user can reach the child session. Everything below pins the render,
// the copy, the colour, the jump target and the HTML legality of that
// affordance.
describe("ToolCard — the subagent badge (slice 06 Agent Team)", () => {
  test("a task block with a matching recentSubagents entry renders the badge", () => {
    const html = renderWithSubagents([taskBlock("tc-1")], [subagentEntry()]);
    const tag = badgeTag(html);
    // The status the renderer read off the entry, verbatim.
    assert.match(tag, /data-subagent-status="running"/);
    // The badge is a real <button>, not a span pretending to be one.
    assert.match(tag, /type="button"/);
    // The card still folds natively — the badge did not replace <summary>.
    assert.match(html, /<summary[^>]*>/);
  });

  test("no recentSubagents — absent or empty — means no badge at all", () => {
    const absent = renderWithSubagents([taskBlock("tc-1")], undefined);
    assert.doesNotMatch(absent, /tool-card-subagent-badge/);
    const empty = renderWithSubagents([taskBlock("tc-1")], []);
    assert.doesNotMatch(empty, /tool-card-subagent-badge/);
    // …and the card is back to the button-free markup the ToolCard block
    // above pins, so a stray badge cannot leak into an unlinked run.
    assert.doesNotMatch(absent, /<button/);
  });

  test("a non-dispatch tool never badges, even with live subagents in state", () => {
    // findSubagentForBlock gates on the tool name: a read / bash / write
    // line has no child session to jump to.
    const html = renderWithSubagents(
      [richToolBlock({ toolName: "bash", text: "→ bash", toolCallId: "tc-1" })],
      [subagentEntry()],
    );
    assert.doesNotMatch(html, /tool-card-subagent-badge/);
  });

  test("the badge text is the localized glyph plus the agent label", () => {
    // zh is the default SSR locale (useLocale initialises to "zh"), so the
    // badge must read 「▶ 验证者」 — glyph from the status table, label from
    // the agent-name table, both through tAgentTeam.
    const running = renderWithSubagents(
      [taskBlock("tc-1")],
      [subagentEntry({ status: "running", agentName: "verifier" })],
    );
    assert.equal(badgeText(running), "▶ 验证者");
    const done = renderWithSubagents(
      [taskBlock("tc-1")],
      [subagentEntry({ status: "done", agentName: "explore" })],
    );
    assert.equal(badgeText(done), "✓ 探查者");
    const failed = renderWithSubagents(
      [taskBlock("tc-1")],
      [subagentEntry({ status: "failed", agentName: "coder" })],
    );
    assert.equal(badgeText(failed), "✗ 编码者");
    // An unmapped agent token falls back to the stored English name rather
    // than rendering an empty badge.
    const custom = renderWithSubagents(
      [taskBlock("tc-1")],
      [subagentEntry({ agentName: "archivist" })],
    );
    assert.equal(badgeText(custom), "▶ archivist");
  });

  test("a status outside the badge vocabulary renders no label and no crash", () => {
    // badgeLabelAndGlyph returns null for an unknown status; the card must
    // still render the button (the session is still reachable) with an
    // empty body rather than print a raw i18n key.
    const html = renderWithSubagents(
      [taskBlock("tc-1")],
      [subagentEntry({ status: "hibernating" })],
    );
    badgeTag(html);
    assert.equal(badgeText(html), "");
    assert.doesNotMatch(html, /agentTeam\./);
  });

  test("status colour follows the three-way vocabulary", () => {
    const running = badgeTag(
      renderWithSubagents([taskBlock("tc-1")], [subagentEntry({ status: "running" })]),
    );
    assert.match(running, /\bbg-bg_status_accent\b/);
    assert.match(running, /\btext-text_default_accent\b/);
    const failed = badgeTag(
      renderWithSubagents([taskBlock("tc-1")], [subagentEntry({ status: "failed" })]),
    );
    assert.match(failed, /\bbg-bg_status_error\b/);
    assert.match(failed, /\btext-text_status_error\b/);
    // Every settled status shares the neutral chip — the third branch.
    const done = badgeTag(
      renderWithSubagents([taskBlock("tc-1")], [subagentEntry({ status: "done" })]),
    );
    assert.match(done, /\bbg-bg_grouped_tertiary_elevated\b/);
    assert.match(done, /\btext-text_default_secondary\b/);
    assert.doesNotMatch(done, /\bbg-bg_status_error\b/);
  });

  test("the jump target is the child session id, on the badge and its title", () => {
    const html = renderWithSubagents(
      [taskBlock("tc-1")],
      [subagentEntry({ sessionId: "child-session-xyz" })],
    );
    const tag = badgeTag(html);
    assert.match(tag, /data-subagent-session="child-session-xyz"/);
    assert.match(tag, /title="child-session-xyz"/);
    // The click handler navigates to that same field — the badge's jump
    // target is the CHILD session, never the parent's own id and never the
    // toolCallId. (A static read: renderToStaticMarkup drops onClick, and
    // this suite has no DOM to dispatch a real click on.)
    assert.match(
      activitySource,
      /switchSession\(subagent\.sessionId\)/,
    );
    // The handler also stops the click from toggling the enclosing
    // <details> — without it a badge click would fold the card open/closed
    // and read as a navigation failure.
    assert.match(
      activitySource,
      /data-testid="tool-card-subagent-badge"[\s\S]{0,600}event\.stopPropagation\(\)/,
    );
  });

  test("two task lines in one run badge their OWN child", () => {
    // The regression the lookup module exists for: matching by tool NAME
    // badges every `→ task` line with the newest child, so clicking an
    // older dispatch jumps to the wrong subagent session.
    const html = renderWithSubagents(
      [taskBlock("tc-1"), taskBlock("tc-2")],
      [
        subagentEntry({ toolCallId: "tc-1", sessionId: "child-one" }),
        subagentEntry({ toolCallId: "tc-2", sessionId: "child-two", agentName: "coder" }),
      ],
    );
    const sessions = [...html.matchAll(/data-subagent-session="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(sessions, ["child-one", "child-two"]);
  });

  test("the badge is a legal interactive descendant of <summary>, not nested in a button", () => {
    // HTML forbids a <button> inside a <button>. The header is a native
    // <summary> precisely so the badge can be a real button beside it.
    const html = renderWithSubagents([taskBlock("tc-1")], [subagentEntry()]);
    // Scope to the TOOL CARD's own summary — the group header above it is a
    // <summary> too, and matching the first one would test the wrong row.
    const cardStart = html.indexOf('data-testid="tool-card"');
    assert.ok(cardStart >= 0, "tool card missing");
    const summaryStart = html.indexOf("<summary", cardStart);
    const summaryEnd = html.indexOf("</summary>", cardStart);
    assert.ok(summaryStart >= 0 && summaryEnd > summaryStart, "tool card has no <summary>");
    const summaryRow = html.slice(summaryStart, summaryEnd);
    // The badge lives INSIDE the summary row…
    assert.match(summaryRow, /data-testid="tool-card-subagent-badge"/);
    // …and it is the row's ONLY button, so nothing wraps it.
    assert.equal(
      (summaryRow.match(/<button/g) ?? []).length,
      1,
      "the summary row must hold exactly one <button> — the badge",
    );
    // No other button in the card either (the fixture has no paths, so the
    // body's path buttons stay out of the picture).
    assert.equal((html.match(/<button/g) ?? []).length, 1);
    // The retired regression — a header <button> holding the badge — is
    // gone at the source level too.
    assert.doesNotMatch(activitySource, /<summary[^>]*>\s*<button/);
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
