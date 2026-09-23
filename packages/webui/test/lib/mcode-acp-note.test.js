// webui/test/lib/mcode-acp-note.test.js
// buildEmptyTurnNote — the v2.3 note appended when a turn ends with no
// assistant message (e.g. thinking consumed the output budget,
// stopReason=max_tokens). Pure function tests; the wiring is exercised by
// the browser E2E (long-turn chat in the Docker dev container).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const absPath = (rel) => pathToFileURL(join(import.meta.dirname, "..", "..", "server", rel)).href;
const { buildEmptyTurnNote } = await import(absPath("lib/mcode-acp.js"));

describe("buildEmptyTurnNote (v2.3)", () => {
  test("normal turn with an answer → no note", () => {
    assert.equal(buildEmptyTurnNote("end_turn", "好的"), null);
    assert.equal(buildEmptyTurnNote("max_tokens", "<svg>…</svg>"), null);
  });

  test("max_tokens with no answer → note names the cause and the way out", () => {
    const note = buildEmptyTurnNote("max_tokens", null);
    assert.ok(note.startsWith("! "), "renders as a system note block");
    assert.match(note, /max_tokens/);
    assert.match(note, /输出预算/);
    assert.match(note, /继续/);
  });

  test("whitespace-only answer counts as empty", () => {
    const note = buildEmptyTurnNote("end_turn", "   \n");
    assert.ok(note);
  });

  test("unknown/missing stopReason still explains the outcome", () => {
    const note = buildEmptyTurnNote(undefined, "");
    assert.match(note, /end_turn/);
    assert.match(note, /未产出正文/);
  });
});
