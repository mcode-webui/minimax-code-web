// webapp/test/transcript-tc-marker.test.ts
// Regression for slice 06's `##tc:<id>` marker consumption by the
// transcript decoder.
//
// What this locks. The decoder reads chat lines and produces
// `TranscriptBlock` values for the renderer. The `toolCallId` field
// on a tool block is the only way the ToolCard can match the block
// with the right `recentSubagents[]` entry — without it, every
// `→ task` line in a multi-dispatch session would badge the newest
// child. The marker is consumed (it never appears in the chat body)
// and attached to the next tool block.
//
// Coverage contract:
//   1. `##tc:<id>` immediately before a `→ name` header attaches the
//      id to that block.
//   2. The marker is NOT emitted as a block on its own — it's a
//      metadata line, consumed by the decoder.
//   3. Multiple dispatches in the same chat each carry their own id
//      — proves the multi-dispatch correctness fix end-to-end on the
//      decoder side.
//   4. Older chat that lacks the marker still parses cleanly; the
//      block has no `toolCallId` and the lookup falls back.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { decodeTranscript, type TranscriptBlock } from "../lib/transcript";

function toolBlocks(blocks: TranscriptBlock[]) {
  return blocks.filter((b) => b.role === "tool");
}

/** Pick the first tool block and assert it exists. */
function firstTool(blocks: TranscriptBlock[]): TranscriptBlock {
  const tools = toolBlocks(blocks);
  if (tools.length !== 1) {
    throw new Error(`expected exactly one tool block, got ${tools.length}`);
  }
  return tools[0] as TranscriptBlock;
}

describe("decodeTranscript — consumes ##tc:<id> marker (slice 06)", () => {
  test("attaches toolCallId to the next tool block", () => {
    const blocks = decodeTranscript([
      "##tc:abc",
      "→ task { \"agent\": \"explore\" }",
      "  [completed]",
    ]);
    const tool = firstTool(blocks);
    assert.equal(tool.toolCallId, "abc");
    assert.equal(tool.toolName, "task");
  });

  test("the marker itself is NOT emitted as a block (consumed metadata)", () => {
    // A regression that emitted the marker as its own block would
    // pollute the chat with `##tc:abc` rows. The decoder MUST
    // consume it before the next block opens.
    const blocks = decodeTranscript([
      "##tc:abc",
      "→ task { }",
      "  [completed]",
    ]);
    assert.equal(blocks.length, 1, "the marker must not appear as its own block");
    assert.equal(blocks[0]?.role, "tool");
  });

  test("two dispatches in one session each carry their own toolCallId", () => {
    // The exact shape the multi-dispatch correctness fix is about.
    // A session that spawned two subagents has TWO recentSubagents
    // entries; without toolCallId matching, every `→ task` line
    // would badge the newest. The decoder proves both blocks are
    // distinct, and the lookup test (agent-team-lookup.test.ts)
    // pins the matching contract.
    const blocks = decodeTranscript([
      "##tc:a",
      "→ task { \"agent\": \"explore\" }",
      "  [completed]",
      "##tc:b",
      "→ task { \"agent\": \"verifier\" }",
      "  [in_progress]",
    ]);
    const tools = toolBlocks(blocks);
    assert.equal(tools.length, 2);
    const a = tools[0];
    const b = tools[1];
    assert.ok(a && b, "test fixture expects exactly two tool blocks");
    assert.equal(a.toolCallId, "a");
    assert.equal(b.toolCallId, "b");
    // Sanity: the renderer can tell them apart. If both came out the
    // same the lookup test would fail too — this is the decoder-side
    // half of the same property.
    assert.notEqual(a.toolCallId, b.toolCallId);
  });

  test("a marker without a following tool block is dropped, not stored", () => {
    // Defensive: a stray marker (engine bug, or mid-stream attach
    // race) must not pollute the block stream. The decoder parks
    // it but never sees a tool block to attach to, so the next
    // marker would replace it.
    const blocks = decodeTranscript([
      "##tc:orphan",
      "● some other block",
      "##tc:abc",
      "→ task { }",
    ]);
    const tool = firstTool(blocks);
    assert.equal(tool.toolCallId, "abc");
  });

  test("older chat without the marker still parses cleanly", () => {
    // The marker is additive — older sessions (and tests written
    // before slice 06) do not have it, and the lookup falls back
    // to the newest entry.
    const blocks = decodeTranscript([
      "→ task { }",
      "  [completed]",
    ]);
    const tool = firstTool(blocks);
    assert.equal(tool.toolCallId, undefined);
    assert.equal(tool.toolName, "task");
  });

  test("a blank line between the marker and the header still attaches", () => {
    // The decoder skips blank lines without consuming them as
    // blocks, but the marker carries across — the parked id is
    // only reset by the next tool block opening.
    const blocks = decodeTranscript([
      "##tc:abc",
      "",
      "→ task { }",
      "  [completed]",
    ]);
    const tool = firstTool(blocks);
    assert.equal(tool.toolCallId, "abc");
  });
});
