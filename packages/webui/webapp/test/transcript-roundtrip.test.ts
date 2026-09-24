import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { decodeTranscript } from "../lib/transcript";
// The server-side mapper that turns runtime-DB messages into the chat-line
// grammar the decoder consumes. Imported across the package boundary on purpose:
// the bug this pins lived exactly at that seam (server flattened newlines, so the
// browser could never render a table).
import { messagesToChatLines } from "../../server/lib/transcript.js";

/**
 * Round-trip: a message with markdown structure must survive
 * `messagesToChatLines` → `decodeTranscript` with its newlines intact.
 *
 * `_oneLine()` used to replace every newline with a space, so a table arrived at
 * `marked` as a single `| a | b | | --- | | 1 | 2 |` line and rendered as raw
 * pipes, and every paragraph merged into one dense block.
 */
describe("transcript round-trip — line structure", () => {
  const table = "| a | b |\n| --- | --- |\n| 1 | 2 |";

  test("an assistant message keeps its newlines and renders the table shape", () => {
    const { lines } = messagesToChatLines([{ role: "assistant", content: table }], { maxLines: 400 });
    const blocks = decodeTranscript(lines);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.role, "assistant");
    assert.equal(blocks[0]?.text, table);

    // The parser must be able to see a real table: header row, delimiter row, row.
    const rows = (blocks[0]?.text ?? "").split("\n");
    assert.equal(rows.length, 3);
    assert.ok(rows[1]?.includes("---"), "the delimiter row survives on its own line");
  });

  test("paragraph breaks between prose lines are preserved", () => {
    const { lines } = messagesToChatLines([{ role: "assistant", content: "first\n\nsecond" }], {
      maxLines: 400,
    });
    const blocks = decodeTranscript(lines);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.text, "first\n\nsecond");
  });

  test("a multi-line user message keeps its newlines", () => {
    const { lines } = messagesToChatLines([{ role: "user", content: "one\ntwo" }], { maxLines: 400 });
    const blocks = decodeTranscript(lines);
    assert.equal(blocks[0]?.role, "user");
    assert.equal(blocks[0]?.text, "one\ntwo");
  });

  test("thinking keeps its own line structure, ahead of the answer", () => {
    const { lines } = messagesToChatLines(
      [{ role: "assistant", thinking: "step 1\nstep 2", content: "done" }],
      { maxLines: 400 },
    );
    const blocks = decodeTranscript(lines);
    assert.equal(blocks[0]?.role, "thinking");
    assert.equal(blocks[0]?.text, "step 1\nstep 2");
    assert.equal(blocks[1]?.role, "assistant");
    assert.equal(blocks[1]?.text, "done");
  });

  test("tool output stays indented one line per row (unchanged)", () => {
    const { lines } = messagesToChatLines(
      [{ role: "assistant", tool_calls: [{ name: "bash", arguments: "{}", result: "a\nb" }] }],
      { maxLines: 400 },
    );
    assert.ok(lines.some((line: string) => line.startsWith("→ bash")));
    assert.ok(lines.includes("  a"));
    assert.ok(lines.includes("  b"));
  });
});
