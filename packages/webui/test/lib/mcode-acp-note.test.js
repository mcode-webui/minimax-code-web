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

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const absPath = (rel) => pathToFileURL(join(import.meta.dirname, "..", "..", "server", rel)).href;
const {
  buildEmptyTurnNote,
  applyToolUpdate,
  applyConfigOptionUpdate,
  // v0.5.by: pre-session model apply — resolution helpers.
  findModelOption,
  matchesModelId,
  resolveModelId,
  lastSegment,
  applyRecordedModel,
} = await import(absPath("lib/mcode-acp.js"));
// Same module instance the runtime graph uses — see the teardown below.
const { getMcodeAcpClient, shutdownMcodeAcpSingleton } = await import(
  absPath("lib/acp-client.js")
);

// Importing server/lib/mcode-acp.js pulls in the webui runtime graph,
// and on a machine where the mcode engine resolves (dev checkouts, and
// CI after the build gate produces dist/cli.js) that graph starts the
// resident ACP singleton child process during module load — a state-bus
// snapshot warms the mcode-sessions cache, whose fetch spawns the
// engine. The child's stdio keeps this test process's pipes open, so
// `node --test` never sees the file finish: every test passes, zero
// failures, and the job is killed at the timeout. Await the shared
// init promise (so the teardown cannot race the in-flight start) and
// stop the child once the suite settles.
after(async () => {
  try {
    await getMcodeAcpClient();
  } catch {
    // engine never started (e.g. no resolvable mcode binary) — nothing to stop
  }
  try {
    shutdownMcodeAcpSingleton();
  } catch {
    // nothing was started
  }
  // Give the child a beat to exit before the runner moves on.
  await new Promise((r) => setTimeout(r, 50));
});

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

// ============================================================
// Ticket 04 — applyConfigOptionUpdate also propagates
// `thinkingEffort.currentValue` into `cs.model.thinking`. The field is
// dropped when the engine clears it (empty currentValue) so the picker
// shows "off" rather than a stale level.
// ============================================================

describe("applyConfigOptionUpdate — propagate thinkingEffort (ticket 04)", () => {
  function optsWithThinking(thinking) {
    return [
      { id: "model", type: "select", currentValue: "minimax_api:MiniMax-M3", options: [] },
      { id: "thinkingEffort", type: "select", currentValue: thinking, options: [] },
    ];
  }

  test("propagates a thinkingEffort change into cs.model.thinking", () => {
    const cs = { model: { name: "minimax_api:MiniMax-M3", thinking: "low" }, permissions: "Full access" };
    applyConfigOptionUpdate(cs, { configOptions: optsWithThinking("high") });
    assert.equal(cs.model.thinking, "high");
    assert.equal(cs.model.name, "minimax_api:MiniMax-M3");
  });

  test("clears cs.model.thinking when the engine clears its currentValue", () => {
    const cs = { model: { name: "minimax_api:MiniMax-M3", thinking: "high" }, permissions: "Full access" };
    applyConfigOptionUpdate(cs, { configOptions: optsWithThinking("") });
    assert.equal(
      Object.prototype.hasOwnProperty.call(cs.model, "thinking"),
      false,
      "thinking field dropped — picker shows no override",
    );
    assert.equal(cs.model.name, "minimax_api:MiniMax-M3");
  });

  test("leaves cs.model alone when no thinkingEffort option is in the update", () => {
    const cs = { model: { name: "minimax_api:MiniMax-M3", thinking: "low" }, permissions: "Full access" };
    applyConfigOptionUpdate(cs, {
      configOptions: [{ id: "model", type: "select", currentValue: "minimax_api:MiniMax-M3", options: [] }],
    });
    assert.equal(cs.model.thinking, "low", "untouched when option absent");
  });
});

// ============================================================
// v0.5.by: pre-session model apply — resolution helpers.
//
// The full integration (applyRecordedModel calling client.request) needs
// the engine side; these tests pin the resolution rules in isolation.
// Regression pin: a future refactor that drops `/`-vs-`:` normalization,
// or accepts a recorded id without checking it against the engine's
// options, would re-introduce "engine ran on default while chip showed
// the user's pick".
// ============================================================

const MODEL_OPTION = {
  type: "select",
  id: "model",
  currentValue: "minimax_api:MiniMax-M3",
  options: [
    { value: "minimax_api:MiniMax-M3", name: "MiniMax-M3" },
    { value: "minimax_api:MiniMax-M2.7", name: "MiniMax-M2.7" },
    { value: "minimax_api:MiniMax-M2.5", name: "MiniMax-M2.5" },
  ],
};

describe("lastSegment — id parser", () => {
  test("returns the bare model name for slash-separated ids", () => {
    assert.equal(lastSegment("minimax_api/MiniMax-M3"), "MiniMax-M3");
  });
  test("returns the bare model name for colon-separated ids", () => {
    assert.equal(lastSegment("minimax_api:MiniMax-M3"), "MiniMax-M3");
  });
  test("returns the id unchanged when no separator is present", () => {
    assert.equal(lastSegment("MiniMax-M3"), "MiniMax-M3");
  });
});

describe("findModelOption — locate the engine's model option", () => {
  test("returns the option when cs.configOptions carries it", () => {
    const cs = { configOptions: [MODEL_OPTION] };
    assert.equal(findModelOption(cs), MODEL_OPTION);
  });
  test("returns null when cs.configOptions is missing or empty", () => {
    assert.equal(findModelOption({}), null);
    assert.equal(findModelOption({ configOptions: [] }), null);
    assert.equal(findModelOption(null), null);
  });
  test("returns null when no option has id === 'model'", () => {
    const cs = {
      configOptions: [{ id: "permissionMode", type: "select", options: [] }],
    };
    assert.equal(findModelOption(cs), null);
  });
});

describe("matchesModelId — recorded vs engine currentValue", () => {
  test("matches exact engine-encoded value", () => {
    assert.equal(
      matchesModelId(
        "minimax_api:MiniMax-M3",
        "minimax_api:MiniMax-M3",
        MODEL_OPTION,
      ),
      true,
    );
  });
  test("a recorded engine-encoded id still matches an option even when the engine is on something else", () => {
    // matchesModelId's purpose is "does this recorded id need an apply?"
    // — true means the engine already has it (or another option of the
    // same id, which can't happen here) and we can skip. The recorded id
    // matching an `option.value` is enough; currentValue is consulted
    // separately for the early-return shortcut only.
    assert.equal(
      matchesModelId(
        "minimax_api:MiniMax-M2.5",
        "minimax_api:MiniMax-M3",
        MODEL_OPTION,
      ),
      true,
    );
  });
  test("an id unknown to the engine's option list does not match", () => {
    assert.equal(
      matchesModelId(
        "minimax_api:MiniMax-UNKNOWN",
        "minimax_api:MiniMax-M3",
        MODEL_OPTION,
      ),
      false,
    );
  });
  test("matches against any option.value (not just currentValue)", () => {
    // Engine-encoded recorded id matches option.value even when currentValue
    // is on a different option.
    assert.equal(
      matchesModelId(
        "minimax_api:MiniMax-M2.7",
        "minimax_api:MiniMax-M3",
        MODEL_OPTION,
      ),
      true,
    );
  });
  test("returns false when modelOption is null and recorded differs from current", () => {
    // The first guard (recorded === engineCurrent) wins regardless of
    // modelOption; only fall through to the modelOption check when the
    // recorded id is not the engine's current.
    assert.equal(
      matchesModelId("minimax_api:MiniMax-M2.5", "minimax_api:MiniMax-M3", null),
      false,
    );
  });
});

describe("resolveModelId — recorded id → engine option.value", () => {
  test("engine-encoded value matches as-is (no rewrite)", () => {
    assert.equal(
      resolveModelId("minimax_api:MiniMax-M2.5", MODEL_OPTION),
      "minimax_api:MiniMax-M2.5",
    );
  });
  test("builtin-catalogue id (`/` separator) matches by bare name", () => {
    // The user picked from the builtin catalogue (slash separator) and the
    // engine uses colon separator; resolve by `option.name`.
    assert.equal(
      resolveModelId("minimax_api/MiniMax-M2.5", MODEL_OPTION),
      "minimax_api:MiniMax-M2.5",
    );
  });
  test("bare model name with one matching option resolves to that option", () => {
    assert.equal(
      resolveModelId("MiniMax-M2.5", MODEL_OPTION),
      "minimax_api:MiniMax-M2.5",
    );
  });
  test("returns null when no option matches (ambiguous or unknown)", () => {
    // "MiniMax-XYZ" is not in the option list — null skips the apply,
    // letting the engine's currentValue stand.
    assert.equal(resolveModelId("MiniMax-XYZ", MODEL_OPTION), null);
  });
  test("returns null when the bare name matches multiple options (ambiguous)", () => {
    const ambiguous = {
      ...MODEL_OPTION,
      options: [
        ...MODEL_OPTION.options,
        { value: "minimax_api:MiniMax-M3-other", name: "MiniMax-M3" },
      ],
    };
    // Two options share the same `name` → caller skips rather than pick
    // the wrong one.
    assert.equal(resolveModelId("MiniMax-M3", ambiguous), null);
  });
});

describe("applyRecordedModel — integration with a fake acp client", () => {
  test("skips silently when no pre-session pick is recorded", async () => {
    const calls = [];
    const fakeClient = { request: async (m, p) => { calls.push([m, p]); return {}; } };
    const cs = { model: {}, configOptions: [MODEL_OPTION] };
    await applyRecordedModel(fakeClient, "sid-1", cs, "cid-1");
    assert.deepEqual(calls, [], "no set_config_option issued");
  });

  test("applies when the recorded id differs from the engine's currentValue", async () => {
    const calls = [];
    const fakeClient = {
      request: async (m, p) => {
        calls.push([m, p]);
        return {};
      },
    };
    const cs = {
      model: { name: "minimax_api/MiniMax-M2.5" }, // builtin-catalogue form
      configOptions: [MODEL_OPTION],
    };
    await applyRecordedModel(fakeClient, "sid-1", cs, "cid-1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "session/set_config_option");
    assert.deepEqual(calls[0][1], {
      sessionId: "sid-1",
      configId: "model",
      value: "minimax_api:MiniMax-M2.5", // resolved to engine form
    });
    // The local configOptions snapshot reflects the new currentValue, so
    // the next /api/models reads the same model the engine is running.
    assert.equal(cs.configOptions[0].currentValue, "minimax_api:MiniMax-M2.5");
  });

  test("skips when the recorded id already matches the engine's currentValue", async () => {
    const calls = [];
    const fakeClient = { request: async (m) => { calls.push([m]); return {}; } };
    const cs = {
      model: { name: "minimax_api:MiniMax-M3" },
      configOptions: [MODEL_OPTION],
    };
    await applyRecordedModel(fakeClient, "sid-1", cs, "cid-1");
    assert.deepEqual(calls, [], "no reapply when already on the recorded model");
  });

  test("skips when the recorded id is unknown to the engine", async () => {
    const calls = [];
    const fakeClient = { request: async (m) => { calls.push([m]); return {}; } };
    const cs = {
      model: { name: "minimax_api/MiniMax-XYZ" },
      configOptions: [MODEL_OPTION],
    };
    await applyRecordedModel(fakeClient, "sid-1", cs, "cid-1");
    assert.deepEqual(calls, [], "unknown id → engine default stands");
  });
});

// ============================================================
// Ticket 04 — pre-session apply of the recorded thinking-effort
// level. The engine contract requires a model to be selected before
// `thinkingEffort` is accepted; the helper pushes model first (when
// recorded) and effort second (when recorded).
// ============================================================

describe("applyRecordedModel — thinkingEffort pre-session apply (ticket 04)", () => {
  function clientRecorder() {
    const calls = [];
    return {
      calls,
      client: { request: async (m, p) => { calls.push([m, p]); return {}; } },
    };
  }
  // Deep-clone the shared option constants per cs so the in-place
  // mutations `applyRecordedModel` performs on `currentValue` do not
  // bleed across tests in this file (the test that asserts the local
  // mirror stays at "low" after a failed effort apply would otherwise
  // see "medium" left behind by an earlier passing test).
  function csWithOptions(model, thinking) {
    return {
      model: { name: model, thinking },
      configOptions: [
        JSON.parse(JSON.stringify(MODEL_OPTION)),
        {
          type: "select",
          id: "thinkingEffort",
          currentValue: "low",
          options: [
            { value: "low", name: "Low" },
            { value: "medium", name: "Medium" },
            { value: "high", name: "High" },
          ],
        },
      ],
    };
  }

  test("applies recorded thinkingEffort after the model when both are recorded", async () => {
    const { calls, client } = clientRecorder();
    const cs = csWithOptions("minimax_api/MiniMax-M2.5", "high");
    await applyRecordedModel(client, "sid-1", cs, "cid-1");
    assert.equal(calls.length, 2, "model then effort");
    assert.equal(calls[0][0], "session/set_config_option");
    assert.equal(calls[0][1].configId, "model");
    assert.equal(calls[1][1].configId, "thinkingEffort");
    assert.equal(calls[1][1].value, "high");
    // Local config-options mirror reflects both applies.
    assert.equal(cs.configOptions[0].currentValue, "minimax_api:MiniMax-M2.5");
    assert.equal(cs.configOptions[1].currentValue, "high");
  });

  test("applies only the effort when the recorded model already matches the engine", async () => {
    const { calls, client } = clientRecorder();
    const cs = csWithOptions("minimax_api:MiniMax-M3", "medium");
    await applyRecordedModel(client, "sid-1", cs, "cid-1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].configId, "thinkingEffort");
    assert.equal(calls[0][1].value, "medium");
  });

  test("applies only the model when no thinking level is recorded", async () => {
    const { calls, client } = clientRecorder();
    const cs = csWithOptions("minimax_api/MiniMax-M2.5", "");
    await applyRecordedModel(client, "sid-1", cs, "cid-1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].configId, "model");
  });

  test("skips entirely when nothing is recorded", async () => {
    const { calls, client } = clientRecorder();
    const cs = { model: { name: "", thinking: "" }, configOptions: [
      JSON.parse(JSON.stringify(MODEL_OPTION)),
      { type: "select", id: "thinkingEffort", currentValue: "low", options: [] },
    ] };
    await applyRecordedModel(client, "sid-1", cs, "cid-1");
    assert.deepEqual(calls, []);
  });

  test("skips entirely when no modelOption has been reported (engine still booting)", async () => {
    const { calls, client } = clientRecorder();
    // No MODEL_OPTION in configOptions → engine hasn't reported its
    // model option yet. The effort apply would be rejected by the
    // engine contract anyway.
    const cs = {
      model: { name: "minimax_api/MiniMax-M3", thinking: "high" },
      configOptions: [{ id: "permissionMode", type: "select", options: [] }],
    };
    await applyRecordedModel(client, "sid-1", cs, "cid-1");
    assert.deepEqual(calls, []);
  });

  test("logs a warning when the engine rejects the effort level (unknown effort)", async () => {
    const calls = [];
    const client = {
      request: async (m, p) => {
        calls.push([m, p]);
        if (p && p.configId === "thinkingEffort") {
          throw new Error("Thinking effort is not advertised for the selected model: turbo");
        }
        return {};
      },
    };
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (msg) => warnings.push(msg);
    let cs;
    try {
      cs = csWithOptions("minimax_api/MiniMax-M2.5", "turbo");
      await applyRecordedModel(client, "sid-1", cs, "cid-1");
    } finally {
      console.warn = origWarn;
    }
    // Model still went through; effort was rejected and logged.
    assert.equal(calls.length, 2);
    assert.equal(calls[0][1].configId, "model");
    assert.equal(calls[1][1].configId, "thinkingEffort");
    assert.ok(warnings.some((w) => /turbo/.test(w)));
    // Local mirror not updated on the failed effort.
    assert.equal(cs.configOptions[1].currentValue, "low");
  });
});
