// webui/test/lib/mcode-acp-note.test.js
// buildEmptyTurnNote — the v2.3 note appended when a turn ends with no
// assistant message (e.g. thinking consumed the output budget,
// stopReason=max_tokens). Pure function tests; the wiring is exercised by
// the browser E2E (long-turn chat in the Docker dev container).
//
// Also covers the two pure helpers extracted alongside it:
//   - applyToolUpdate — handles tool_update events, synthesizing a → name
//     header when the matching tool_call never arrived (defect #1).
//   - applyConfigOptionUpdate — handles config_option_update events,
//     propagating both permissionMode and model from the engine's
//     authoritative state (defect #2).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const absPath = (rel) => pathToFileURL(join(import.meta.dirname, "..", "..", "server", rel)).href;
const {
  buildEmptyTurnNote,
  applyToolUpdate,
  applyConfigOptionUpdate,
} = await import(absPath("lib/mcode-acp.js"));

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

describe("applyToolUpdate — synthetic header when the tool_call never arrived (defect #1)", () => {
  // The bug shape: a tool_update arrives for a toolCallId that the server
  // never saw a tool_call for. Without an owner, decodeTranscript routes
  // the two-space-indented body lines into a stray chat.system block.
  // applyToolUpdate must synthesize a `→ name` header so the body has
  // an owner; subsequent updates for the same toolCallId must insert
  // their body after the synthesized header.

  test("the first frame for an unknown toolCallId synthesizes a → name header", () => {
    const cs = { chat: ["› hi"] };
    const r = {};
    applyToolUpdate(r, cs, {
      toolCallId: "tc-orphan",
      title: "Read",
      status: "in_progress",
    });
    assert.deepEqual(cs.chat, ["› hi", "→ Read", "  [in_progress]"]);
    assert.equal(r.toolIndexById.get("tc-orphan"), 1);
  });

  test("a second update for the same orphan toolCallId appends after the synthesized header", () => {
    const cs = { chat: [] };
    const r = {};
    applyToolUpdate(r, cs, { toolCallId: "tc-1", title: "Bash", status: "in_progress" });
    applyToolUpdate(r, cs, { toolCallId: "tc-1", status: "completed", rawOutput: { content: [{ type: "text", text: "ok" }] } });
    applyToolUpdate(r, cs, {
      toolCallId: "tc-1",
      status: "completed",
      locations: [{ path: "/home/u/.agents/rule.md" }],
    });
    // Header is written once; subsequent bodies insert at insertAfter+1, so
    // each new body's status line lands right after the header and pushes
    // the prior body deeper. This matches the existing known-tool behaviour
    // and pins it for the synthetic-header path.
    assert.deepEqual(cs.chat, [
      "→ Bash",
      "  [completed]",
      "  @ /home/u/.agents/rule.md",
      "  [completed]",
      "  ok",
      "  [in_progress]",
    ]);
    // The user's transcript showed a doubled @ path: deduplication still applies.
    applyToolUpdate(r, cs, {
      toolCallId: "tc-1",
      status: "completed",
      locations: [{ path: "/home/u/.agents/rule.md" }],
    });
    // The newly-added body landed at index 1 (right after the header). The
    // prior body lines (the duplicate path, the prior "ok" output) shifted
    // by two positions.
    assert.equal(cs.chat[1], "  [completed]");
    assert.equal(cs.chat[2], "  @ /home/u/.agents/rule.md");
  });

  test("a known toolCallId (prior tool_call arrived) inserts after the existing header", () => {
    const cs = { chat: [] };
    const r = {};
    r.toolIndexById = new Map();
    // Simulate a tool_call that arrived before the update.
    cs.chat = ["→ Read  {}", "  [in_progress]"];
    r.toolIndexById.set("tc-known", 0);
    applyToolUpdate(r, cs, { toolCallId: "tc-known", status: "completed" });
    // The body lines are inserted at insertAfter+1 — right after the header —
    // so the new status line lands between the header and the prior in_progress
    // body. Existing behaviour from before this fix; pinning it so the
    // synthetic-header path doesn't regress it.
    assert.deepEqual(cs.chat, ["→ Read  {}", "  [completed]", "  [in_progress]"]);
  });

  test("an update with no title falls back to a generic → tool header", () => {
    const cs = { chat: [] };
    const r = {};
    applyToolUpdate(r, cs, { toolCallId: "tc-x", status: "completed" });
    assert.equal(cs.chat[0], "→ tool");
  });
});

describe("applyConfigOptionUpdate — propagate model + permissionMode (defect #2)", () => {
  // Defect #2: a config_option_update carrying the model option
  // (a model change made by another client, e.g. the TUI) used to update
  // cs.permissions only; cs.model stayed at its previous value, so the
  // webui chip showed the old model and the next prompt was sent with
  // the wrong model id. The fix reads option.currentValue for the model
  // option — the same field routes/model.js#handleGetModels uses.

  function optsFor({ permissionMode, model }) {
    const list = [];
    if (permissionMode !== undefined) {
      list.push({ id: "permissionMode", type: "select", currentValue: permissionMode });
    }
    if (model !== undefined) {
      list.push({
        id: "model",
        type: "select",
        currentValue: model,
        options: [
          { value: "minimax_api:MiniMax-M3", name: "MiniMax-M3" },
          { value: "minimax_api:MiniMax-M2.7", name: "MiniMax-M2.7" },
        ],
      });
    }
    return list;
  }

  test("propagates a model change into cs.model.name", () => {
    const cs = {
      model: { name: "minimax_api:MiniMax-M3" },
      permissions: "Full access",
    };
    applyConfigOptionUpdate(cs, {
      configOptions: optsFor({ model: "minimax_api:MiniMax-M2.7" }),
    });
    assert.equal(cs.model.name, "minimax_api:MiniMax-M2.7");
  });

  test("propagates both model and permissionMode in the same update", () => {
    const cs = {
      model: { name: "minimax_api:MiniMax-M3" },
      permissions: "Full access",
    };
    applyConfigOptionUpdate(cs, {
      configOptions: optsFor({
        model: "minimax_api:MiniMax-M2.7",
        permissionMode: "default",
      }),
    });
    assert.equal(cs.model.name, "minimax_api:MiniMax-M2.7");
    assert.equal(cs.permissions, "Ask");
  });

  test("leaves cs.model alone when the model option is absent", () => {
    const cs = { model: { name: "minimax_api:MiniMax-M3" }, permissions: "Full access" };
    applyConfigOptionUpdate(cs, {
      configOptions: optsFor({ permissionMode: "default" }),
    });
    assert.equal(cs.model.name, "minimax_api:MiniMax-M3", "no model option → model untouched");
    assert.equal(cs.permissions, "Ask");
  });

  test("leaves cs.model alone when the model option has no currentValue", () => {
    const cs = { model: { name: "minimax_api:MiniMax-M3" }, permissions: "Full access" };
    applyConfigOptionUpdate(cs, {
      configOptions: [
        { id: "model", type: "select", currentValue: null, options: [] },
        { id: "permissionMode", type: "select", currentValue: "default" },
      ],
    });
    assert.equal(cs.model.name, "minimax_api:MiniMax-M3", "empty currentValue → model untouched");
  });

  test("initialises cs.model when only the model option arrived (no prior cs.model)", () => {
    const cs = { permissions: "Full access" };
    applyConfigOptionUpdate(cs, {
      configOptions: optsFor({ model: "minimax_api:MiniMax-M2.7" }),
    });
    assert.deepEqual(cs.model, { name: "minimax_api:MiniMax-M2.7" });
  });

  test("ignores an update with no configOptions array", () => {
    const cs = { model: { name: "minimax_api:MiniMax-M3" }, permissions: "Full access" };
    applyConfigOptionUpdate(cs, { /* no configOptions */ });
    assert.equal(cs.model.name, "minimax_api:MiniMax-M3");
    assert.equal(cs.permissions, "Full access");
  });
});
