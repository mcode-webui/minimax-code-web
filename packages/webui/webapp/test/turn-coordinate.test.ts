// webapp/test/turn-coordinate.test.ts
//
// webui-parity 83 — the `§§ turn_msg=<assistantMessageId>` marker end to end
// through the webapp's own decoder, and the honesty rules around it.
//
// The marker is the whole coordinate system: the server writes it at prompt
// finalise (live) or synthesises it from the runtime's `turn_id` / `msg_id`
// columns (restore), and `decodeTranscript` hangs the id off the turn's
// assistant block.
//
// Three properties are load-bearing, so they are what this file pins:
//
//   1. the marker never becomes visible text — it is consumed, exactly like
//      the `§§ processed_duration` marker it sits next to;
//   2. the id lands on the turn's LAST assistant block, the one the engine
//      filed the turn's record under, not on an earlier one;
//   3. a transcript WITHOUT the marker decodes exactly as it did before the
//      feature shipped — every session older than the marker has to keep
//      rendering, and a decode that assumed the marker would throw on all of
//      them.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { decodeTranscript } from "../lib/transcript";

const TURN_A = "ed8b9ddd-9bb0-4b06-a8fc-e863036830e3";
const TURN_B = "8c3ac6a7-3fb7-483a-99a5-233467adfc31";

/** A one-turn transcript the way the server writes it, marker included. */
function transcript(turnMessageId?: string): string[] {
  const lines = [
    "› 改一下文件",
    "▲ 我先看看",
    "● 我先看看",
    "→ edit_file  {\"path\":\"/ws/a.ts\"}",
    "  [completed]",
    "● 改好了",
  ];
  if (turnMessageId) lines.push("§§ processed_duration=1200ms", `§§ turn_msg=${turnMessageId}`);
  else lines.push("§§ processed_duration=1200ms");
  return lines;
}

function assistantBlocks(lines: string[]) {
  return decodeTranscript(lines).filter((b) => b.role === "assistant");
}

// --- 1. the marker is consumed, never rendered ------------------------------

describe("the turn_msg marker is metadata, not content", () => {
  test("it does not appear in any block's text", () => {
    for (const block of decodeTranscript(transcript(TURN_A))) {
      assert.ok(!block.text.includes("turn_msg"), `leaked into a ${block.role} block`);
      assert.ok(!block.text.includes("§§"), "no marker glyph survives into the body");
    }
  });

  test("it does not become a system block either", () => {
    const blocks = decodeTranscript(transcript(TURN_A));
    assert.equal(
      blocks.filter((b) => b.role === "system").length,
      0,
      "an unconsumed marker would render as a system notice",
    );
  });

  test("the sibling processed_duration marker still resolves", () => {
    // Both markers are written by the same finalize and must keep their
    // independent behaviour: a turn carries a duration AND a coordinate.
    const blocks = decodeTranscript(transcript(TURN_A));
    const withDuration = blocks.filter((b) => b.processedDuration !== undefined);
    assert.equal(withDuration.length, 1);
    assert.equal(withDuration[0]?.processedDuration, 1200);
  });
});

// --- 2. the id lands on the turn's last assistant block --------------------

describe("the id lands on the turn's last assistant block", () => {
  test("a turn's FINAL assistant block carries the id", () => {
    // `transcript()` is the real live shape: a `▲`+`●` pair, a tool call, then
    // the answer. The id belongs on the answer — the last assistant prose of
    // the turn, which is the message the engine filed the record under.
    const assistants = assistantBlocks(transcript(TURN_A));
    assert.equal(assistants.length, 2);
    assert.equal(assistants[0]?.assistantMessageId, undefined);
    assert.equal(assistants[1]?.assistantMessageId, TURN_A);
  });

  test("a turn split by a tool call gets the id on the LAST block, not the first", () => {
    // An id attached to an earlier block would select a record the engine
    // never wrote, and the endpoint would answer empty with no explanation.
    // The tool line is what keeps the two assistant blocks apart: the decoder
    // merges CONSECUTIVE `●` lines into one block, so a test that wrote them
    // back to back would be testing the merge, not the marker.
    const lines = [
      "› q",
      "● 第一个片段",
      "→ bash  {}",
      "  [completed]",
      "● 第二个片段",
      `§§ turn_msg=${TURN_A}`,
    ];
    const assistants = assistantBlocks(lines);
    assert.equal(assistants.length, 2);
    assert.equal(assistants[0]?.assistantMessageId, undefined);
    assert.equal(assistants[1]?.assistantMessageId, TURN_A);
  });

  test("each turn keeps its own id", () => {
    const lines = [
      ...transcript(TURN_A),
      "› 再改一次",
      "● 第二回合",
      `§§ turn_msg=${TURN_B}`,
    ];
    const ids = assistantBlocks(lines)
      .map((b) => b.assistantMessageId)
      .filter((id): id is string => typeof id === "string");
    assert.deepEqual(ids, [TURN_A, TURN_B]);
  });

  test("a marker after a trailing system note still finds the turn's block", () => {
    // The real shape when a turn ends with the engine's empty-turn note: the
    // note is written BEFORE finalize, so the marker arrives with a system
    // block open. The decoder then has to look BACKWARD for the turn's
    // assistant block — scanning forward instead would land the id on an
    // earlier turn's block, i.e. the wrong turn's record.
    const lines = [
      "› q1",
      "● 第一回合的答案",
      `§§ turn_msg=${TURN_A}`,
      "› q2",
      "● 第二回合没有正文",
      "○ 本回合没有输出正文。",
      `§§ turn_msg=${TURN_B}`,
    ];
    const ids = assistantBlocks(lines).map((b) => b.assistantMessageId);
    assert.deepEqual(ids, [TURN_A, TURN_B]);
  });

  test("a marker with no assistant block above it attaches to nothing", () => {
    // A transcript whose turn produced no assistant prose. There is no block
    // to own the id, and attaching it to an unrelated earlier turn's block
    // would point the card at the wrong turn.
    const blocks = decodeTranscript(["› 只有用户消息", "○ 系统提示", `§§ turn_msg=${TURN_A}`]);
    assert.equal(blocks.filter((b) => b.assistantMessageId !== undefined).length, 0);
  });
});

// --- 3. old transcripts are untouched --------------------------------------

describe("a transcript without the marker decodes exactly as before", () => {
  const old = ["› 问题", "▲ 思考", "● 回答", "→ edit_file  {\"path\":\"/ws/a.ts\"}", "  [completed]"];

  test("no block gains a coordinate", () => {
    for (const block of decodeTranscript(old)) {
      assert.equal(block.assistantMessageId, undefined, `a ${block.role} block invented a coordinate`);
    }
  });

  test("the decoded blocks are structurally identical to the marked run's", () => {
    const withoutMarker = decodeTranscript(old);
    const withMarker = decodeTranscript([...old, `§§ turn_msg=${TURN_A}`]);
    const strip = (blocks: ReturnType<typeof decodeTranscript>) =>
      blocks.map(({ assistantMessageId, ...rest }) => rest);
    assert.deepEqual(strip(withMarker), strip(withoutMarker));
  });

  test("a lone marker line mid-transcript does not swallow the next block", () => {
    const blocks = decodeTranscript(["› q", `§§ turn_msg=${TURN_A}`, "● 之后的回答"]);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[1]?.role, "assistant");
    assert.equal(blocks[1]?.text, "之后的回答");
  });
});
