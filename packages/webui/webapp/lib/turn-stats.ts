/**
 * Turn-level statistics for the turn-process bar (ticket 46, PR3 — D6).
 *
 * A "turn" is everything the engine produced between two user blocks:
 * the folded activity runs plus the assistant prose blocks. The bar's
 * composite summary — 「思考 N 次，用了 M 次工具，共执行 X 分 Y 秒」 —
 * counts exactly that span, matching how the reference flattens the
 * turn's segments before counting (`AssistantBody.tsx`
 * `processSummaryParts`).
 *
 * `thinking` counts thought *runs*, not thinking blocks: the same
 * `summarizeActivity` rule the activity-group header uses, so the bar
 * and the group never disagree about how many thoughts a turn had.
 *
 * `answerChars` is the sum of the turn's assistant text lengths. The
 * wire transcript carries no per-turn token count (the usage event only
 * accumulates session totals server-side), so the output-rate figure
 * derives from characters — the same fallback formula the reference
 * applies when its runtime reports no `usage.outputTokens`
 * (`answers.reduce((sum, a) => sum + a.length, 0)`). See
 * `components/activity-group.tsx#TurnProcessDisclosure`.
 */

import { summarizeActivity, type RenderUnit } from "./transcript";

export interface TurnStats {
  /** Thought runs in the turn (adjacent thinking blocks merge). */
  readonly thinking: number;
  /** Tool calls in the turn (one `→ name` header each). */
  readonly tools: number;
  /** Assistant answer characters in the turn (output-rate estimate). */
  readonly answerChars: number;
}

/**
 * Stats for the turn that ENDS at `tailIndex` — scan back to the
 * previous user block (exclusive). Used for the live bar while the
 * engine is still streaming THIS turn (there is no settled assistant
 * tail block yet to key a precomputed map by).
 */
export function summarizeTurn(
  units: readonly RenderUnit[],
  tailIndex: number,
): TurnStats {
  let thinking = 0;
  let tools = 0;
  let answerChars = 0;
  for (let i = Math.min(tailIndex, units.length - 1); i >= 0; i -= 1) {
    const unit = units[i];
    if (!unit) break;
    if (unit.kind === "block" && unit.block.role === "user") break;
    if (unit.kind === "activity") {
      const summary = summarizeActivity(unit.blocks);
      thinking += summary.thinking;
      tools += summary.tools;
    } else if (unit.kind === "block" && unit.block.role === "assistant") {
      answerChars += unit.block.text.length;
    }
  }
  return { thinking, tools, answerChars };
}

/**
 * Turn stats keyed by the unit index of each assistant block — one
 * forward pass, reset at every user block. The Chat component uses this
 * to hand every settled assistant tail block (the blocks that carry
 * `processedDuration`) its turn's counts without an O(units × turn)
 * re-scan per render.
 */
export function computeTurnStatsByUnit(
  units: readonly RenderUnit[],
): Map<number, TurnStats> {
  const stats = new Map<number, TurnStats>();
  let thinking = 0;
  let tools = 0;
  let answerChars = 0;
  units.forEach((unit, index) => {
    if (unit.kind === "block" && unit.block.role === "user") {
      thinking = 0;
      tools = 0;
      answerChars = 0;
      return;
    }
    if (unit.kind === "activity") {
      const summary = summarizeActivity(unit.blocks);
      thinking += summary.thinking;
      tools += summary.tools;
      return;
    }
    if (unit.kind === "block" && unit.block.role === "assistant") {
      answerChars += unit.block.text.length;
      stats.set(index, { thinking, tools, answerChars });
    }
  });
  return stats;
}

/**
 * True when the turn has process steps a disclosure could reveal — thought
 * runs or tool calls (webui-parity 61, G4).
 *
 * This is the reference's own gate for the chevron. `AssistantBody.tsx` in the
 * reference package computes
 * `hasExpandableProcessContent = Boolean(thinking?.trim() || tools?.length ||
 * processSegments?.some(s => s.activityParts?.length))` and hands it to
 * `WebuiTurnProcess` as `hasExpandableContent`; when it is false the desktop
 * renders the duration summary as plain text with no toggle. Our equivalent
 * is the pair of counts `computeTurnStatsByUnit` already produces for the
 * bar's composite summary — the same events, reduced to the same question.
 */
export function hasExpandableTurnContent(stats: TurnStats): boolean {
  return stats.thinking > 0 || stats.tools > 0;
}

/** Per-turn layout the turn-bar disclosure coordinates with (G4).
 *
 *  - `turnIndexByUnit[i]` is the ordinal of the turn unit `i` belongs to,
 *    counting from 0 and incrementing at every user block. Turn ordinals —
 *    not unit indices — are the coordination key: activity runs are re-cut
 *    on every streaming frame, so a unit index moves while its turn does not.
 *  - `defaultExpandedByTurn` is the expansion the turn's activity groups
 *    already have before the user touches the chevron: true when at least one
 *    of them opens by default (a mixed run opens, a pure-tool run does not —
 *    `ActivityGroup`'s own rule). It is what the chevron's first click
 *    inverts, so the first click always changes something visible.
 */
export interface TurnLayout {
  readonly turnIndexByUnit: readonly number[];
  readonly defaultExpandedByTurn: ReadonlyMap<number, boolean>;
}

export function computeTurnLayout(units: readonly RenderUnit[]): TurnLayout {
  const turnIndexByUnit: number[] = [];
  const defaultExpandedByTurn = new Map<number, boolean>();
  let turnIndex = 0;
  units.forEach((unit, index) => {
    // A user block is a turn boundary, not a member: it belongs to the turn it
    // opens, which is the one after the running counter.
    if (unit.kind === "block" && unit.block.role === "user") {
      turnIndex += 1;
    }
    turnIndexByUnit[index] = turnIndex;
    if (unit.kind === "activity") {
      const opensByDefault = summarizeActivity(unit.blocks).thinking > 0;
      defaultExpandedByTurn.set(
        turnIndex,
        (defaultExpandedByTurn.get(turnIndex) ?? false) || opensByDefault,
      );
    }
  });
  return { turnIndexByUnit, defaultExpandedByTurn };
}
