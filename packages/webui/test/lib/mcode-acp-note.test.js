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
    // Slice 06: applyToolUpdate emits a `##tc:<toolCallId>` marker
    // immediately before the synthetic `→ name` header so the
    // decoder can correlate the block with its recentSubagents[].
    // The marker is the +1 shift relative to the pre-slice-06 shape.
    assert.deepEqual(cs.chat, ["› hi", "##tc:tc-orphan", "→ Read", "  [in_progress]"]);
    assert.equal(r.toolIndexById.get("tc-orphan"), 2);
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
    // Header is written once (slice 06 also wrote the `##tc:` marker
    // on the synthetic path; subsequent updates insert body lines
    // AFTER the marker+header pair). The marker carries no UI weight —
    // the decoder consumes it - so its only effect is a +1 line
    // shift relative to the pre-slice-06 shape.
    assert.deepEqual(cs.chat, [
      "##tc:tc-1",
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
    // The newly-added body landed at index 2 (right after the
    // marker+header pair). The prior body lines (the duplicate path,
    // the prior "ok" output) shifted by two positions.
    assert.equal(cs.chat[2], "  [completed]");
    assert.equal(cs.chat[3], "  @ /home/u/.agents/rule.md");
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
    // Slice 06: applyToolUpdate emits a `##tc:<toolCallId>` marker
    // immediately before the `→ name` header so the decoder can
    // correlate the block with the matching recentSubagents[] entry.
    // cs.chat[0] is now the marker; the header lands at cs.chat[1].
    assert.equal(cs.chat[0], "##tc:tc-x");
    assert.equal(cs.chat[1], "→ tool");
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
        // Engine wire format (m:<provider>:<model>:u|v:<variant>); see
        // packages/tui/src/acp/control-state.ts#modelConfigValue.
        options: [
          { value: "m:minimax:MiniMax-M3:u", name: "MiniMax-M3" },
          { value: "m:minimax:MiniMax-M2.7:u", name: "MiniMax-M2.7" },
        ],
      });
    }
    return list;
  }

  test("propagates a model change into cs.model.name", () => {
    const cs = {
      model: { name: "m:minimax:MiniMax-M3:u" },
      permissions: "Full access",
    };
    applyConfigOptionUpdate(cs, {
      configOptions: optsFor({ model: "m:minimax:MiniMax-M2.7:u" }),
    });
    assert.equal(cs.model.name, "m:minimax:MiniMax-M2.7:u");
  });

  test("propagates both model and permissionMode in the same update", () => {
    const cs = {
      model: { name: "m:minimax:MiniMax-M3:u" },
      permissions: "Full access",
    };
    applyConfigOptionUpdate(cs, {
      configOptions: optsFor({
        model: "m:minimax:MiniMax-M2.7:u",
        permissionMode: "default",
      }),
    });
    assert.equal(cs.model.name, "m:minimax:MiniMax-M2.7:u");
    assert.equal(cs.permissions, "Ask");
  });

  test("leaves cs.model alone when the model option is absent", () => {
    const cs = { model: { name: "m:minimax:MiniMax-M3:u" }, permissions: "Full access" };
    applyConfigOptionUpdate(cs, {
      configOptions: optsFor({ permissionMode: "default" }),
    });
    assert.equal(cs.model.name, "m:minimax:MiniMax-M3:u", "no model option → model untouched");
    assert.equal(cs.permissions, "Ask");
  });

  test("leaves cs.model alone when the model option has no currentValue", () => {
    const cs = { model: { name: "m:minimax:MiniMax-M3:u" }, permissions: "Full access" };
    applyConfigOptionUpdate(cs, {
      configOptions: [
        { id: "model", type: "select", currentValue: null, options: [] },
        { id: "permissionMode", type: "select", currentValue: "default" },
      ],
    });
    assert.equal(cs.model.name, "m:minimax:MiniMax-M3:u", "empty currentValue → model untouched");
  });

  test("initialises cs.model when only the model option arrived (no prior cs.model)", () => {
    const cs = { permissions: "Full access" };
    applyConfigOptionUpdate(cs, {
      configOptions: optsFor({ model: "m:minimax:MiniMax-M2.7:u" }),
    });
    assert.deepEqual(cs.model, { name: "m:minimax:MiniMax-M2.7:u" });
  });

  test("ignores an update with no configOptions array", () => {
    const cs = { model: { name: "m:minimax:MiniMax-M3:u" }, permissions: "Full access" };
    applyConfigOptionUpdate(cs, { /* no configOptions */ });
    assert.equal(cs.model.name, "m:minimax:MiniMax-M3:u");
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
      { id: "model", type: "select", currentValue: "m:minimax:MiniMax-M3:v:", options: [] },
      { id: "thinkingEffort", type: "select", currentValue: thinking, options: [] },
    ];
  }

  test("propagates a thinkingEffort change into cs.model.thinking", () => {
    const cs = { model: { name: "m:minimax:MiniMax-M3:v:", thinking: "low" }, permissions: "Full access" };
    applyConfigOptionUpdate(cs, { configOptions: optsWithThinking("high") });
    assert.equal(cs.model.thinking, "high");
    assert.equal(cs.model.name, "m:minimax:MiniMax-M3:v:");
  });

  test("clears cs.model.thinking when the engine clears its currentValue", () => {
    const cs = { model: { name: "m:minimax:MiniMax-M3:v:", thinking: "high" }, permissions: "Full access" };
    applyConfigOptionUpdate(cs, { configOptions: optsWithThinking("") });
    assert.equal(
      Object.prototype.hasOwnProperty.call(cs.model, "thinking"),
      false,
      "thinking field dropped — picker shows no override",
    );
    assert.equal(cs.model.name, "m:minimax:MiniMax-M3:v:");
  });

  test("leaves cs.model alone when no thinkingEffort option is in the update", () => {
    const cs = { model: { name: "m:minimax:MiniMax-M3:v:", thinking: "low" }, permissions: "Full access" };
    applyConfigOptionUpdate(cs, {
      configOptions: [{ id: "model", type: "select", currentValue: "m:minimax:MiniMax-M3:v:", options: [] }],
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
//
// Wire format note (ticket 05): the engine sends `option.value` in the
// `m:<encodedProvider>:<encodedModel>:u` (or `:v:<variant>`) shape —
// see packages/tui/src/acp/control-state.ts#modelConfigValue. The webui
// records `cs.model.name` in the user-facing `provider/model` form. The
// resolution logic below pins both shapes so a future test refactor
// cannot silently regress either direction.
const MODEL_OPTION = {
  type: "select",
  id: "model",
  currentValue: "m:minimax:MiniMax-M3:v:",
  options: [
    { value: "m:minimax:MiniMax-M3:v:", name: "MiniMax-M3" },
    { value: "m:minimax:MiniMax-M3:v:thinking", name: "MiniMax-M3 · thinking" },
    { value: "m:minimax:MiniMax-M2.7:u", name: "MiniMax-M2.7" },
    { value: "m:minimax:MiniMax-M2.5:u", name: "MiniMax-M2.5" },
    // Ticket 05: a custom_provider option the engine advertises because
    // webui synced it into the engine's `custom_provider` registry.
    // The wire value is `m:custom_provider%3A<key>:<modelId>:u` — the
    // `:` after the provider prefix is URL-encoded.
    {
      value: "m:custom_provider%3Abyok-zhipu:glm-5.3:u",
      name: "glm-5.3",
    },
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
        "m:minimax:MiniMax-M3:v:",
        "m:minimax:MiniMax-M3:v:",
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
        "m:minimax:MiniMax-M2.5:u",
        "m:minimax:MiniMax-M3:v:",
        MODEL_OPTION,
      ),
      true,
    );
  });
  test("an id unknown to the engine's option list does not match", () => {
    assert.equal(
      matchesModelId(
        "m:minimax:MiniMax-UNKNOWN:u",
        "m:minimax:MiniMax-M3:v:",
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
        "m:minimax:MiniMax-M2.7:u",
        "m:minimax:MiniMax-M3:v:",
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
      matchesModelId("m:minimax:MiniMax-M2.5:u", "m:minimax:MiniMax-M3:v:", null),
      false,
    );
  });
});

describe("resolveModelId — recorded id → engine option.value", () => {
  test("engine-encoded value matches as-is (no rewrite)", () => {
    assert.equal(
      resolveModelId("m:minimax:MiniMax-M2.5:u", MODEL_OPTION),
      "m:minimax:MiniMax-M2.5:u",
    );
  });
  test("builtin-catalogue id (`/` separator) matches by bare name", () => {
    // The user picked from the builtin catalogue (slash separator) and
    // the engine's option uses `:`; resolve by `option.name`.
    assert.equal(
      resolveModelId("minimax/MiniMax-M2.5", MODEL_OPTION),
      "m:minimax:MiniMax-M2.5:u",
    );
  });
  test("bare model name with one matching option resolves to that option", () => {
    assert.equal(
      resolveModelId("MiniMax-M2.5", MODEL_OPTION),
      "m:minimax:MiniMax-M2.5:u",
    );
  });
  test("custom-provider id (`custom_provider:<key>/<model>`) resolves to the registered engine value", () => {
    // Ticket 05 — the cross-provider flow: after PUT /api/providers syncs
    // the webui catalogue into the engine's `custom_provider` registry,
    // the engine advertises the new model in its `model` config option
    // with the URL-encoded `m:custom_provider%3A<key>:<model>:u` value.
    // The dialog-stored `cs.model.name` is `custom_provider:byok-zhipu/glm-5.3`;
    // `resolveModelId` strips to the bare name `glm-5.3` (the only segment
    // after the `/`) and finds the unique option.value.
    assert.equal(
      resolveModelId("custom_provider:byok-zhipu/glm-5.3", MODEL_OPTION),
      "m:custom_provider%3Abyok-zhipu:glm-5.3:u",
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
        { value: "m:minimax:MiniMax-M3:v:other", name: "MiniMax-M3" },
      ],
    };
    // Two options share the same `name` → caller skips rather than pick
    // the wrong one.
    assert.equal(resolveModelId("MiniMax-M3", ambiguous), null);
  });
  // Ticket 09-02: the webui id for an engine-sourced model is
  // `<providerKey>/<engineModelKey>` where `engineModelKey` may itself
  // contain `/` (upstream-namespace ids). The engine populates
  // `option.name` from `displayName ?? modelId`, so for models
  // without a separate displayName `option.name === engineModelKey`
  // verbatim — including the `/`. The resolution must extract the
  // engine model key as the segment-after-FIRST-`/`, not the
  // segment-after-LAST-`/` (the pre-fix `lastSegment` returned just
  // the last segment, missing multi-segment keys).
  test("multi-segment webui id (`<providerKey>/<a>/<b>`) resolves via the segment-after-first-`/`", () => {
    const upstreamIds = {
      ...MODEL_OPTION,
      options: [
        ...MODEL_OPTION.options,
        {
          value: "m:custom_provider%3Anousresearch:deepseek%2Fdeepseek-v4.1-flash:u",
          name: "deepseek/deepseek-v4.1-flash",
        },
        {
          value: "m:custom_provider%3Anousresearch:z-ai%2Fglm-5.3:u",
          name: "z-ai/glm-5.3",
        },
      ],
    };
    // The pre-fix `lastSegment("nousresearch/deepseek/deepseek-v4.1-flash")`
    // returns `"deepseek-v4.1-flash"` — which does NOT match the
    // engine's `option.name = "deepseek/deepseek-v4.1-flash"`. The
    // fix extracts the segment-after-FIRST-`/` (the engine model
    // key, with `/` preserved) and matches against `option.name`.
    assert.equal(
      resolveModelId("nousresearch/deepseek/deepseek-v4.1-flash", upstreamIds),
      "m:custom_provider%3Anousresearch:deepseek%2Fdeepseek-v4.1-flash:u",
    );
    assert.equal(
      resolveModelId("nousresearch/z-ai/glm-5.3", upstreamIds),
      "m:custom_provider%3Anousresearch:z-ai%2Fglm-5.3:u",
    );
  });
  test("legacy `custom_provider:<key>/<model>` form still resolves (last-segment fallback)", () => {
    // The pre-ticket-09-02 form — the webui recorded `cs.model.name`
    // as `custom_provider:byok-zhipu/glm-5.3`. `resolveModelId` must
    // keep resolving this for backward compat; the last-segment
    // path (`glm-5.3`) lands on the same engine option as before.
    assert.equal(
      resolveModelId("custom_provider:byok-zhipu/glm-5.3", MODEL_OPTION),
      "m:custom_provider%3Abyok-zhipu:glm-5.3:u",
    );
  });
  test("legacy `minimax_api/MiniMax-M3` form still resolves", () => {
    // Pin the `MiniMax-M3` option's actual wire value — the model
    // option set in MODEL_OPTION is the variant form
    // (`m:minimax:MiniMax-M3:v:`), not the `:u` form. The legacy
    // resolution must match the engine's first option carrying that
    // name.
    assert.equal(
      resolveModelId("minimax_api/MiniMax-M3", MODEL_OPTION),
      "m:minimax:MiniMax-M3:v:",
    );
  });
  // The engine composes `option.name` as
  // `${displayName ?? modelId}${variant ? " · " + variant : ""}`
  // (packages/tui/src/acp/control-state.ts#uniqueModelValues). A
  // recorded webui id carries the bare model id only — it doesn't
  // surface the variant. When the engine is offering only the
  // variant form of a model (no bare form), the resolver must
  // strip the suffix before matching. The exact-match pass wins
  // first so a model that has both forms prefers the bare form
  // (the engine's default).
  test("variant-only form: suffix is stripped to match the bare webui id", () => {
    const variantOnly = {
      ...MODEL_OPTION,
      options: [
        // The engine only advertises the variant form. The bare
        // form is gone (engine upstream lost it). The recorded
        // webui id is the bare name; the resolver must find the
        // variant option by stripping ` · thinking`.
        { value: "m:custom_provider%3Anousresearch:deepseek%2Fx:v:thinking", name: "deepseek/x · thinking" },
      ],
    };
    assert.equal(
      resolveModelId("nousresearch/deepseek/x", variantOnly),
      "m:custom_provider%3Anousresearch:deepseek%2Fx:v:thinking",
    );
  });
  test("bare + variant: exact match wins (engine's default)", () => {
    // The engine offers BOTH forms. The bare form is the default;
    // a recorded bare webui id must land on the bare option, not
    // get collapsed into an ambiguous answer. (The resolver used
    // to collapse via the suffix strip — that made the engine's
    // variant pair ambiguous.)
    const both = {
      ...MODEL_OPTION,
      options: [
        { value: "m:custom_provider%3Anousresearch:x:v:", name: "x" },
        { value: "m:custom_provider%3Anousresearch:x:v:thinking", name: "x · thinking" },
      ],
    };
    assert.equal(
      resolveModelId("nousresearch/x", both),
      "m:custom_provider%3Anousresearch:x:v:",
    );
  });
  // Ticket 09-02: the engine populates `option.name` as
  // `displayName ?? modelId`. Upstream catalogues commonly carry
  // both — a router-style model id (`deepseek/deepseek-v4.1-flash`)
  // and a separate friendly display name (`DeepSeek V4.1 Flash`).
  // The webui records the model id verbatim (the wire form's
  // segment-after-FIRST-`/`), so the bare-name match against the
  // friendly `option.name` fails. The third pass recovers the
  // model id by URL-decoding the wire value — the segment the
  // engine carries in `m:<encodedProvider>:<encodedModel>:u|v:<v>`.
  test("wire-decode fallback: displayName differs from model id", () => {
    // The engine advertises a model whose `option.name` is the
    // displayName (with friendly spaces + capitalisation) and
    // whose wire value's encoded model segment is the router-style
    // upstream id. The webui form `nousresearch/deepseek/deepseek-v4.1-flash`
    // matches the wire-decode segment (after URL decoding) — the
    // third-pass fallback recovers it.
    const engine = {
      type: "select",
      id: "model",
      currentValue: "m:custom_provider%3Anousresearch:deepseek%2Fdeepseek-v4.1-flash:v:thinking",
      options: [
        {
          value: "m:custom_provider%3Anousresearch:deepseek%2Fdeepseek-v4.1-flash:v:thinking",
          name: "DeepSeek V4.1 Flash · thinking",
        },
      ],
    };
    assert.equal(
      resolveModelId("nousresearch/deepseek/deepseek-v4.1-flash", engine),
      "m:custom_provider%3Anousresearch:deepseek%2Fdeepseek-v4.1-flash:v:thinking",
    );
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
      model: { name: "minimax/MiniMax-M2.5" }, // builtin-catalogue form (slash)
      configOptions: [MODEL_OPTION],
    };
    await applyRecordedModel(fakeClient, "sid-1", cs, "cid-1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "session/set_config_option");
    assert.deepEqual(calls[0][1], {
      sessionId: "sid-1",
      configId: "model",
      value: "m:minimax:MiniMax-M2.5:u", // resolved to engine wire form
    });
    // The local configOptions snapshot reflects the new currentValue, so
    // the next /api/models reads the same model the engine is running.
    assert.equal(cs.configOptions[0].currentValue, "m:minimax:MiniMax-M2.5:u");
  });

  test("skips when the recorded id already matches the engine's currentValue", async () => {
    const calls = [];
    const fakeClient = { request: async (m) => { calls.push([m]); return {}; } };
    const cs = {
      model: { name: "m:minimax:MiniMax-M3:v:" },
      configOptions: [MODEL_OPTION],
    };
    await applyRecordedModel(fakeClient, "sid-1", cs, "cid-1");
    assert.deepEqual(calls, [], "no reapply when already on the recorded model");
  });

  test("skips when the recorded id is unknown to the engine", async () => {
    const calls = [];
    const fakeClient = { request: async (m) => { calls.push([m]); return {}; } };
    const cs = {
      model: { name: "minimax/MiniMax-XYZ" },
      configOptions: [MODEL_OPTION],
    };
    await applyRecordedModel(fakeClient, "sid-1", cs, "cid-1");
    assert.deepEqual(calls, [], "unknown id → engine default stands");
  });

  test("ticket 05 — cross-provider switching: recorded `custom_provider:<key>/<model>` resolves and applies", async () => {
    const calls = [];
    const fakeClient = {
      request: async (m, p) => { calls.push([m, p]); return {}; },
    };
    const cs = {
      model: { name: "custom_provider:byok-zhipu/glm-5.3" },
      configOptions: [MODEL_OPTION],
    };
    await applyRecordedModel(fakeClient, "sid-1", cs, "cid-1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "session/set_config_option");
    assert.deepEqual(calls[0][1], {
      sessionId: "sid-1",
      configId: "model",
      // The engine's URL-encoded form is what the runtime accepts on the
      // wire (`packages/tui/src/acp/control-state.ts#modelConfigValue`).
      value: "m:custom_provider%3Abyok-zhipu:glm-5.3:u",
    });
    assert.equal(cs.configOptions[0].currentValue, "m:custom_provider%3Abyok-zhipu:glm-5.3:u");
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
    const cs = csWithOptions("minimax/MiniMax-M2.5", "high");
    await applyRecordedModel(client, "sid-1", cs, "cid-1");
    assert.equal(calls.length, 2, "model then effort");
    assert.equal(calls[0][0], "session/set_config_option");
    assert.equal(calls[0][1].configId, "model");
    assert.equal(calls[1][1].configId, "thinkingEffort");
    assert.equal(calls[1][1].value, "high");
    // Local config-options mirror reflects both applies (engine wire format).
    assert.equal(cs.configOptions[0].currentValue, "m:minimax:MiniMax-M2.5:u");
    assert.equal(cs.configOptions[1].currentValue, "high");
  });

  test("applies only the effort when the recorded model already matches the engine", async () => {
    const { calls, client } = clientRecorder();
    const cs = csWithOptions("m:minimax:MiniMax-M3:v:", "medium");
    await applyRecordedModel(client, "sid-1", cs, "cid-1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].configId, "thinkingEffort");
    assert.equal(calls[0][1].value, "medium");
  });

  test("applies only the model when no thinking level is recorded", async () => {
    const { calls, client } = clientRecorder();
    const cs = csWithOptions("minimax/MiniMax-M2.5", "");
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
      cs = csWithOptions("minimax/MiniMax-M2.5", "turbo");
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
