// webapp/test/turn-stats.test.ts
//
// Tests for the turn-level statistics behind the turn-process bar
// (ticket 46, PR3 — D6). Both entry points drive the same counting
// rules: a turn is everything between two user blocks; `thinking`
// counts thought RUNS (adjacent thinking blocks merge — the same rule
// the activity-group header uses, so the bar and the group can never
// disagree); `answerChars` sums the assistant prose lengths, which is
// the output-rate estimate the bar derives its `token/s` figure from.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { computeTurnStatsByUnit, summarizeTurn } from "../lib/turn-stats";
import { decodeTranscript, groupActivity } from "../lib/transcript";
import type { RenderUnit } from "../lib/transcript";

/** Decode + fold the way the Chat component does. */
const unitsOf = (lines: readonly string[]): RenderUnit[] =>
  groupActivity(decodeTranscript(lines, {}));

describe("summarizeTurn — the live turn's backward scan", () => {
  test("counts the whole span between the previous user block and the tail", () => {
    const units = unitsOf([
      "› first question",
      "▲ think one",
      "→ bash  {}",
      "  [completed]",
      "● first answer",
      "› second question",
      "▲ think two",
      "▲ still the same thought",
      "→ read  {\"file_path\":\"/a\"}",
      "  [completed]",
      "● second answer",
    ]);
    // Tail index = the last unit (the second answer's block).
    const stats = summarizeTurn(units, units.length - 1);
    // One thought RUN (two adjacent ▲ lines merge) + one tool + the
    // answer's characters.
    assert.equal(stats.thinking, 1);
    assert.equal(stats.tools, 1);
    assert.equal(stats.answerChars, "second answer".length);
  });

  test("stops at the user block — the previous turn does not leak in", () => {
    const units = unitsOf([
      "› q1",
      "▲ earlier thought",
      "● a1",
      "› q2",
      "● a2",
    ]);
    const stats = summarizeTurn(units, units.length - 1);
    assert.equal(stats.thinking, 0);
    assert.equal(stats.tools, 0);
    assert.equal(stats.answerChars, "a2".length);
  });

  test("thought runs separated by prose count separately", () => {
    const units = unitsOf([
      "› q",
      "▲ first thought",
      "● middle prose",
      "▲ second thought",
      "→ bash  {}",
      "  [completed]",
    ]);
    const stats = summarizeTurn(units, units.length - 1);
    assert.equal(stats.thinking, 2);
    assert.equal(stats.tools, 1);
  });

  test("an out-of-range tail index clamps instead of throwing", () => {
    const units = unitsOf(["› q", "● a"]);
    const stats = summarizeTurn(units, 99);
    assert.equal(stats.answerChars, "a".length);
    assert.equal(summarizeTurn([], 0).thinking, 0);
  });

  test("a transcript that ends on the user block yields an empty turn", () => {
    const units = unitsOf(["› q", "● a", "› next"]);
    const stats = summarizeTurn(units, units.length - 1);
    assert.deepEqual(stats, { thinking: 0, tools: 0, answerChars: 0 });
  });
});

describe("computeTurnStatsByUnit — the settled turns' forward pass", () => {
  test("keys every assistant block to its OWN turn's stats", () => {
    const units = unitsOf([
      "› q1",
      "▲ t1",
      "→ bash  {}",
      "  [completed]",
      "● a1",
      "› q2",
      "→ grep  {}",
      "  [completed]",
      "→ read  {}",
      "  [completed]",
      "● a2",
    ]);
    const stats = computeTurnStatsByUnit(units);
    assert.equal(stats.size, 2);
    const indices = [...stats.keys()];
    const first = stats.get(indices[0] ?? -1);
    const second = stats.get(indices[1] ?? -1);
    assert.deepEqual(first, {
      thinking: 1,
      tools: 1,
      answerChars: "a1".length,
    });
    assert.deepEqual(second, {
      thinking: 0,
      tools: 2,
      answerChars: "a2".length,
    });
  });

  test("matches summarizeTurn on the same tail", () => {
    const units = unitsOf([
      "› q",
      "▲ thought",
      "▲ more thought",
      "→ bash  {}",
      "  [failed]",
      "● answer text",
    ]);
    const forward = computeTurnStatsByUnit(units);
    const tailStats = [...forward.values()].pop();
    const backward = summarizeTurn(units, units.length - 1);
    assert.deepEqual(tailStats, backward);
  });

  test("non-assistant prose blocks are neither keys nor counters", () => {
    const units = unitsOf(["› q", "[info] system note", "● a"]);
    const stats = computeTurnStatsByUnit(units);
    assert.equal(stats.size, 1);
    assert.equal([...stats.values()][0]?.answerChars, "a".length);
  });
});
