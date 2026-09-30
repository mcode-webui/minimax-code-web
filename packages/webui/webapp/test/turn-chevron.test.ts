// webapp/test/turn-chevron.test.ts
//
// The turn bar's expand chevron (webui-parity 61, G4) and the turn layout it
// coordinates with.
//
// What this pins, and why each one is a behaviour rather than a restatement
// of the source:
//
//   - the chevron is GATED. A turn with no thought and no tool call has
//     nothing to expand, so the reference renders a plain summary line
//     (`hasExpandableContent` false → no `turn-process-trigger`). Asserting
//     the chevron's absence there is the half of the rule that a "the glyph
//     exists" test can never catch.
//   - the chevron is a real control: a `<button>` carrying `aria-expanded`,
//     with the rotation class following the state.
//   - the coordination key is the TURN ordinal, not the unit index. This is
//     the property that survives streaming: activity runs are re-cut on every
//     frame, so a per-unit key would make the chevron lose the groups it
//     drives the moment a tool header lands.
//   - a turn's pre-chevron expansion is read off the groups' own defaults, so
//     the first click always inverts something the reader can see.
//   - the chat.tsx wiring passes the state down to BOTH ends — the bar and the
//     groups — because a chevron wired to only one of them is a dead control.
//
// createElement, not JSX: the test:webapp glob is `**/*.test.ts` and the tsx
// loader only transpiles JSX in `.tsx`. The React global stub is the one
// activity-group.test.ts documents.

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

const { ActivityGroup, TurnProcessDisclosure } = await import("../components/activity-group");
const { translate } = await import("../lib/i18n");
const { computeTurnLayout, hasExpandableTurnContent } = await import("../lib/turn-stats");
const { decodeTranscript: realDecode, groupActivity } = await import("../lib/transcript");
const { SessionProvider } = await import("../lib/store");
import type { ActivitySummary, RenderUnit, TranscriptBlock } from "../lib/transcript";

const here = dirname(fileURLToPath(import.meta.url));
const chatSource = readFileSync(resolve(here, "../components/chat.tsx"), "utf8");
const activitySource = readFileSync(
  resolve(here, "../components/activity-group.tsx"),
  "utf8",
);
const turnStatsSource = readFileSync(resolve(here, "../lib/turn-stats.ts"), "utf8");

const t = (key: Parameters<typeof translate>[1]) => translate("zh", key);
const noop = () => {};

/** The settled-turn shape: a turn that thought once and called two tools. */
const processStats = { thinking: 1, tools: 2, answerChars: 600 };
/** A plain ping/pong turn — prose only, no process steps. */
const proseOnlyStats = { thinking: 0, tools: 0, answerChars: 42 };

const renderBar = (props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(TurnProcessDisclosure, {
      stats: processStats,
      processedDurationMs: 125000,
      t,
      ...props,
    }),
  );

describe("the chevron is gated on the turn actually having process steps", () => {
  test("a turn with thoughts and tools renders the trigger and the chevron", () => {
    const html = renderBar({ onExpandedChange: noop });
    assert.match(html, /data-testid="turn-process-trigger"/);
    assert.match(html, /data-testid="turn-process-chevron"/);
    assert.match(html, /aria-expanded="true"/);
  });

  test("a prose-only turn renders a plain summary line and NO chevron", () => {
    // The reference's own rule: `hasExpandableProcessContent` false means
    // `WebuiTurnProcess` renders the duration summary as text, with no
    // toggle. A bar whose only content is 「共执行 2 分 5 秒」 has nothing to
    // disclose, so offering the control would be a lie about the page.
    const html = renderBar({
      stats: proseOnlyStats,
      onExpandedChange: noop,
    });
    assert.match(html, /data-testid="turn-process-summary-text"/);
    assert.doesNotMatch(html, /turn-process-trigger/);
    assert.doesNotMatch(html, /turn-process-chevron/);
    assert.doesNotMatch(html, /aria-expanded/);
  });

  test("one of the two counts is enough — a tools-only turn still discloses", () => {
    const toolsOnly = renderBar({
      stats: { thinking: 0, tools: 1, answerChars: 0 },
      onExpandedChange: noop,
    });
    assert.match(toolsOnly, /turn-process-chevron/);
    const thoughtsOnly = renderBar({
      stats: { thinking: 1, tools: 0, answerChars: 0 },
      onExpandedChange: noop,
    });
    assert.match(thoughtsOnly, /turn-process-chevron/);
  });

  test("the live bar never offers the toggle", () => {
    // The reference reaches this through `forceExpanded` / `disabled`, whose
    // docblock says those modes "suppress the toggle and keep available
    // details open". It is also the only honest choice here: a group holding a
    // running tool is force-open and cannot be collapsed, so a live chevron
    // would be a control that cannot act.
    const html = renderBar({ active: true, startedAtMs: 1, onExpandedChange: noop });
    assert.match(html, /data-testid="turn-process-summary-text"/);
    assert.doesNotMatch(html, /turn-process-trigger/);
    assert.doesNotMatch(html, /turn-process-chevron/);
  });

  test("an unwired bar renders no toggle either", () => {
    // No handler means nothing to drive (the live bar's call site). A
    // chevron that renders and goes nowhere is the dead control the
    // reference's `canToggle` guard exists to prevent.
    const html = renderBar();
    assert.doesNotMatch(html, /turn-process-trigger/);
  });
});

describe("the chevron reports and follows the expansion state", () => {
  test("collapsed state: aria-expanded false and no rotation class", () => {
    const html = renderBar({ expanded: false, onExpandedChange: noop });
    assert.match(html, /aria-expanded="false"/);
    const chevron = html.match(/<span[^>]*data-testid="turn-process-chevron"[^>]*>/)?.[0] ?? "";
    assert.ok(chevron.length > 0, "chevron span must exist");
    assert.doesNotMatch(chevron, /rotate-90/);
  });

  test("expanded state: aria-expanded true and the glyph rotates", () => {
    const html = renderBar({ expanded: true, onExpandedChange: noop });
    assert.match(html, /aria-expanded="true"/);
    const chevron = html.match(/<span[^>]*data-testid="turn-process-chevron"[^>]*>/)?.[0] ?? "";
    assert.match(chevron, /rotate-90/);
  });

  test("untouched turn: aria-expanded reports the turn's own default", () => {
    // `expanded` is undefined until the user clicks, so the state the button
    // advertises has to come from `defaultExpanded` — otherwise a mixed run
    // that is visibly open would still answer "collapsed" to a screen reader.
    const openByDefault = renderBar({
      expanded: undefined,
      defaultExpanded: true,
      onExpandedChange: noop,
    });
    assert.match(openByDefault, /aria-expanded="true"/);
    const closedByDefault = renderBar({
      expanded: undefined,
      defaultExpanded: false,
      onExpandedChange: noop,
    });
    assert.match(closedByDefault, /aria-expanded="false"/);
  });

  test("the summary text and the rate survive the button wrapper", () => {
    // The reference puts the same summary markup inside the trigger; the
    // separator and the output rate must not move when it becomes a button.
    const html = renderBar({ onExpandedChange: noop });
    assert.match(html, /思考 1 次，用了 2 次工具，共执行 2 分 5 秒/);
    assert.match(html, /data-testid="turn-output-rate"/);
    assert.match(html, /data-testid="turn-process-separator"/);
    assert.equal((html.match(/<button/g) ?? []).length, 1, "exactly one control in the bar");
  });
});

describe("hasExpandableTurnContent — the gate, on its own", () => {
  test("false for a prose-only turn, true for either count", () => {
    assert.equal(hasExpandableTurnContent(proseOnlyStats), false);
    assert.equal(hasExpandableTurnContent({ thinking: 1, tools: 0, answerChars: 0 }), true);
    assert.equal(hasExpandableTurnContent({ thinking: 0, tools: 1, answerChars: 0 }), true);
  });

  test("the source computes it from the two counts and nothing else", () => {
    // A gate that also consulted, say, the duration would light the chevron
    // on a turn whose only "process" is a clock.
    assert.match(
      turnStatsSource,
      /export function hasExpandableTurnContent\(stats: TurnStats\): boolean \{\s*return stats\.thinking > 0 \|\| stats\.tools > 0;/,
    );
  });
});

describe("computeTurnLayout — the coordination key", () => {
  const units = (lines: readonly string[]): RenderUnit[] =>
    groupActivity(realDecode(lines, {}));

  test("a user prompt opens a new turn and belongs to it", () => {
    const layout = computeTurnLayout(units(["› q", "▲ think", "● answer"]));
    assert.deepEqual([...layout.turnIndexByUnit], [1, 1, 1]);
  });

  test("turn ordinals are stable while a streaming turn grows", () => {
    // The property the chevron depends on. Activity runs are re-cut on every
    // frame, so the unit indices move; a per-unit key would detach the
    // chevron from its groups here.
    const early = computeTurnLayout(units(["› q", "▲ think", "  [completed]"]));
    const late = computeTurnLayout(
      units(["› q", "▲ think", "  [completed]", "● partial", "● more"]),
    );
    for (const index of early.turnIndexByUnit) {
      assert.equal(late.turnIndexByUnit[index], index, `unit ${index} changed turn`);
    }
  });

  test("a second prompt starts turn 2 and leaves turn 1 alone", () => {
    const layout = computeTurnLayout(
      units(["› q1", "▲ think", "● a1", "› q2", "→ bash", "  [completed]", "● a2"]),
    );
    const turns = [...new Set(layout.turnIndexByUnit)];
    assert.deepEqual(turns, [1, 2]);
    assert.equal(layout.turnIndexByUnit[0], 1);
    assert.equal(layout.turnIndexByUnit.at(-1), 2);
  });

  test("the pre-chevron expansion reads the groups' own defaults", () => {
    // A mixed run (thoughts AND tools) opens by default; a pure-tool run does
    // not. The chevron's first click inverts this, so a click on a pure-tool
    // turn expands rather than appearing to do nothing.
    const mixed = computeTurnLayout(units(["› q", "▲ think", "→ bash", "  [completed]"]));
    assert.equal(mixed.defaultExpandedByTurn.get(1), true);
    const toolsOnly = computeTurnLayout(units(["› q", "→ bash", "  [completed]"]));
    assert.equal(toolsOnly.defaultExpandedByTurn.get(1), false);
    // A turn with no process steps at all has no groups and no default —
    // which is exactly the case where no chevron renders.
    const prose = computeTurnLayout(units(["› q", "● a"]));
    assert.equal(prose.defaultExpandedByTurn.has(1), false);
  });

  test("one open group in a turn is enough to make the turn read as open", () => {
    // A turn can hold several runs; the bar has a single aria state, so it
    // takes the OR rather than pretending the turn is uniformly one or the
    // other.
    const layout = computeTurnLayout(
      units(["› q", "→ bash", "  [completed]", "▲ think", "→ bash", "  [completed]"]),
    );
    assert.equal(layout.defaultExpandedByTurn.get(1), true);
  });
});

describe("the group honours a turn-level intent and keeps its own otherwise", () => {
  const summary: ActivitySummary = {
    thinking: 1,
    tools: 1,
    contributions: [{ category: "thinking", count: 1, iconType: "thinking" }],
    iconType: "thinking",
  };
  const blocks = [
    { role: "thinking", text: "considering" },
    { role: "tool", toolName: "bash", text: "ok", toolStatus: "completed" },
  ] as unknown as TranscriptBlock[];

  const renderGroup = (props: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      createElement(
        // The tool card reads the session store for its subagent badge, so the
        // group only renders inside a provider — same shape as
        // activity-group.test.ts's helper.
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

  test("controlled + expanded: the group renders open", () => {
    const html = renderGroup({ expanded: true, onExpandedChange: noop });
    assert.match(html, /data-testid="activity-group"[^>]*open=""|open=""[^>]*data-testid="activity-group"/);
  });

  test("controlled + collapsed: the group renders closed", () => {
    const html = renderGroup({ expanded: false, onExpandedChange: noop });
    assert.doesNotMatch(html, /data-testid="activity-group"[^>]*\sopen/);
  });

  test("uncontrolled: the mixed run keeps its own open default", () => {
    const html = renderGroup();
    assert.match(html, /data-testid="activity-group"[^>]*open=""|open=""[^>]*data-testid="activity-group"/);
  });

  test("a forced-open run ignores a collapsed intent", () => {
    // A run holding a running tool cannot be collapsed — the rule predates
    // the chevron and must not regress into "the bar can hide it".
    const running = [
      { role: "thinking", text: "considering" },
      { role: "tool", toolName: "bash", text: "", toolStatus: "in_progress" },
    ] as unknown as TranscriptBlock[];
    const html = renderToStaticMarkup(
      createElement(
        SessionProvider,
        null,
        createElement(ActivityGroup, {
          blocks: running,
          summary,
          t,
          onOpenFile: noop,
          expanded: false,
          onExpandedChange: noop,
        }),
      ),
    );
    assert.match(html, /data-active="true"/);
    assert.match(html, /data-testid="activity-group"[^>]*open=""|open=""[^>]*data-testid="activity-group"/);
  });

  test("an `expanded` prop with no handler is not a controlled group", () => {
    // Half a contract is not a contract: with no handler the group falls back
    // to its own state rather than freezing on a prop nobody can change.
    const html = renderGroup({ expanded: false });
    assert.match(html, /data-testid="activity-group"[^>]*open=""|open=""[^>]*data-testid="activity-group"/);
  });
});

describe("chat.tsx wiring — the chevron reaches both ends", () => {
  test("the turn layout and the intent map are derived once per units pass", () => {
    assert.match(chatSource, /const \{ turnIndexByUnit, defaultExpandedByTurn \} = useMemo\(\s*\(\) => computeTurnLayout\(units\),\s*\[units\],\s*\)/);
    assert.match(chatSource, /const \[turnProcessExpanded, setTurnProcessExpanded\] = useState</);
    assert.match(chatSource, /const setTurnExpanded = useCallback\(\(turnIndex: number, next: boolean\) => \{/);
  });

  test("each rendered unit is keyed to its turn ordinal", () => {
    assert.match(chatSource, /const turnIndex = turnIndexByUnit\[originalIndex\] \?\? 0;/);
    assert.match(chatSource, /const turnExpanded = turnProcessExpanded\.get\(turnIndex\)/);
  });

  test("the activity group receives the intent and the setter", () => {
    assert.match(chatSource, /expanded=\{turnExpanded\}/);
    assert.match(
      chatSource,
      /onExpandedChange=\{turnExpanded === undefined \? undefined : \(next\) => setTurnExpanded\(turnIndex, next\)\}/,
    );
  });

  test("the settled turn bar receives the same intent through Block", () => {
    // The bar is rendered by `Block`, not by the unit map, so the state has
    // to be threaded through it — a chevron that only the groups can see (or
    // only the bar) is a dead control.
    assert.match(chatSource, /turnProcessExpanded=\{turnExpanded\}/);
    assert.match(chatSource, /turnProcessDefaultExpanded=\{defaultExpandedByTurn\.get\(turnIndex\) \?\? true\}/);
    assert.match(chatSource, /onTurnProcessExpandedChange=\{setTurnExpanded\}/);
    assert.match(chatSource, /expanded=\{turnProcessExpanded\}/);
    assert.match(chatSource, /defaultExpanded=\{turnProcessDefaultExpanded\}/);
  });

  test("the live bar is left unwired, so it renders no toggle", () => {
    const live = chatSource.slice(
      chatSource.indexOf("<TurnProcessDisclosure"),
      chatSource.indexOf("<TurnProcessDisclosure") + 400,
    );
    assert.doesNotMatch(live, /onExpandedChange/);
  });

  test("the group renders `open` from the controlled state, and reports toggles", () => {
    assert.match(activitySource, /open=\{forcedOpen \|\| expandedState\}/);
    assert.match(activitySource, /if \(controlled\) onExpandedChange\(next\);\s*else setOwnExpanded\(next\);/);
  });
});
