// webui/test/lib/engine/model-writes.test.js
//
// M3-B10 — the MODEL / PERMISSION WRITE family (#58 set-model,
// #59 permissions).
//
// B10 is a MOVE, so this file is organised around the equivalence claim
// rather than around the code: every case names which side of it it
// pins.
//
//   THE WIRE FORM. What the ENGINE receives —
//   `m:<provider>:<model>:u` or `m:<provider>:<model>:v:<variant>` for
//   the model, a bare level for `thinkingEffort`, an engine vocabulary
//   word for `permissionMode`. Pushed through the same
//   `lib/mcode-rpc.js#setConfigOption` wrapper, in the same order, with
//   the same warnings, as the pre-B10 route.
//
//   THE RECORDED FORM. What WEBUI keeps — `cs.model.name` in
//   `<providerKey>/<engineModelKey>`, `cs.model.thinking`, the
//   `*PickedAt` stamps, `cs.permissions` as a label — plus the
//   `mcodeSynced` / `thinkingSynced` / `warning` triple the response
//   body carries.
//
// The two are not the same data and were never supposed to be; what must
// not change is the MAPPING between them. So the central test is a
// table: one row per (engine option shape × request shape), asserting
// both sides field by field. A rewrite that gets the recorded form right
// while pushing the wrong wire form fails it, and so does the reverse.
//
// The second half of the equivalence is the SSE race window. Its reader
// (`server/lib/mcode-acp.js`, ticket 08) is not this batch's to change,
// so this file imports it and pins the WRITER against it — including
// both reverse halves, because the failure this guards against is
// symmetric: a stamp written for a pick the user never made is as wrong
// as no stamp at all.
//
// Env is injected at MODULE scope, before any engine import, and the
// engine data dir points at a `mkTmpDir` fixture — the builtin tree
// `variantChannelFor` reads is the real file format, so a variant case
// that booted against the host's `~/.minimax/config.yaml` would be
// testing the operator's machine.

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import yaml from "js-yaml";

import { setupMocks, absPath, registerRpcMock } from "../../helpers/_setup.js";
import { mkTmpDir, rmTmpDir } from "../../helpers/tmp.js";

// Pinned BEFORE any engine/engine-catalogue import below reads them.
const tmpBase = mkTmpDir("webui-model-writes-");
process.env.MINIMAX_DATA_DIR = tmpBase;
process.env.MCODE_WEBUI_DATA_DIR = tmpBase;
process.env.MCODE_WEBUI_SETTINGS_PATH = `${tmpBase}/settings.json`;
process.env.MCODE_WEBUI_EVENTS_PATH = `${tmpBase}/events.jsonl`;
process.env.MCODE_WEBUI_SESSIONS_DB = `${tmpBase}/sessions.db`;
process.env.MCODE_WEBUI_UPLOAD_DIR = `${tmpBase}/uploads`;

// The REAL permission mappers, captured at module scope — i.e. before
// any test context has registered the dispatch-through mock for
// `lib/mcode-rpc.js`. `setupMocks` replaces that module wholesale, so a
// mapping test that read `webuiPermissionToMcode` from it would be
// asserting the mock. This binding is the real function, and the mock's
// wrapper is pointed at it below.
const realRpc = await import(absPath("lib/mcode-rpc.js"));
const { variantChannelFor } = await import(absPath("lib/engine-catalogue.js"));

/** Every name `engine/model-writes.js` exports. The namespace, not a subset. */
const FACADE_EXPORTS = [
  "NO_SESSION_MODEL_WARNING",
  "NO_SESSION_PERMISSION_WARNING",
  "applyThinkingEffortMirror",
  "modelSelectionTarget",
  "planModelPickStamps",
  "planModelSelectionPush",
  "pushEngineModelSelection",
  "pushEnginePermissionMode",
  "resolveEngineModelConfigValue",
  "resolvePermissionSelection",
];

let bust = 0;

/** The exported names read out of the SOURCE, so a new one cannot slip past. */
function exportedNamesOf(relative) {
  const fileUrl = absPath(relative);
  const src = readFileSync(fileURLToPath(fileUrl), "utf8");
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Fixtures — the engine's own shapes, transcribed
// ---------------------------------------------------------------------------

/** A switchable builtin, advertised as the variant wire pair (control-state.ts#uniqueModelValues). */
const VARIANT_MODEL_OPTION = {
  type: "select",
  id: "model",
  name: "Model",
  currentValue: "m:minimax_api:MiniMax-M3:v:thinking",
  options: [
    { value: "m:minimax_api:MiniMax-M3:v:thinking", name: "MiniMax-M3 · thinking" },
    { value: "m:minimax_api:MiniMax-M3:v:none-thinking", name: "MiniMax-M3 · none-thinking" },
    { value: "m:minimax_api:MiniMax-M2.7:u", name: "MiniMax-M2.7" },
  ],
};

/** A forced_on builtin with an effort vocabulary: one bare wire form. */
const EFFORT_MODEL_OPTION = {
  type: "select",
  id: "model",
  name: "Model",
  currentValue: "m:minimax_api:MiniMax-M3.1-Flash-Preview:u",
  options: [
    { value: "m:minimax_api:MiniMax-M3.1-Flash-Preview:u", name: "M3.1-Flash-Preview" },
  ],
};

/** A custom-provider model: the provider segment is percent-encoded. */
const CUSTOM_MODEL_OPTION = {
  type: "select",
  id: "model",
  name: "Model",
  currentValue: "m:custom_provider%3Azai-pro:glm-5.3:u",
  options: [{ value: "m:custom_provider%3Azai-pro:glm-5.3:u", name: "glm-5.3" }],
};

/** The engine's materialised builtin tree, verbatim shapes. */
const BUILTIN_MINIMAX_TREE = {
  minimax: {
    models: {
      "MiniMax-M3": {
        name: "MiniMax-M3",
        reasoning: true,
        thinking_config: { mode: "switchable", default_value: "true" },
        variants: {
          "none-thinking": { thinking: { type: "disabled" } },
          thinking: { thinking: { type: "adaptive" } },
        },
      },
      "MiniMax-M3.1-Flash-Preview": {
        name: "M3.1-Flash-Preview",
        reasoning: true,
        thinking_config: { mode: "forced_on" },
        thinking: {
          effortOptions: ["default", "low", "medium", "high", "xhigh", "max"],
          defaultEffort: "default",
        },
        variants: {
          "none-thinking": { thinking: { type: "disabled" } },
          thinking: { thinking: { type: "adaptive" } },
        },
      },
      "MiniMax-M2.7": { name: "MiniMax-M2.7", reasoning: true, thinking_config: { mode: "forced_on" } },
    },
  },
};

/**
 * Run a body with the engine's builtin tree on disk. The tree is written
 * ONCE for the whole file (see `before`) and lives until `after` removes
 * the tmp dir: `variantChannelFor` reads it on every call, so a
 * write-then-delete wrapper would make the plan cases order-dependent for
 * no gain — every case here wants the same tree.
 */
const withBuiltinTree = (body) => body();

/** A client state, shaped like the live one. */
function fakeCs(overrides = {}) {
  return {
    model: { name: "minimax_api/MiniMax-M3", thinking: "", ...(overrides.model || {}) },
    permissions: "Full access",
    ...(overrides.configOptions === undefined ? {} : { configOptions: overrides.configOptions }),
    ...(overrides.mcodeSessionId === undefined ? {} : { mcodeSessionId: overrides.mcodeSessionId }),
  };
}

/** Client state with a live session — the only shape that pushes. */
function fakeCsWithSession(overrides = {}) {
  return fakeCs({ mcodeSessionId: "mvs_b10_0000000000000000000000", ...overrides });
}

// ---------------------------------------------------------------------------
// Booting the facade
// ---------------------------------------------------------------------------

/**
 * Boot `engine/model-writes.js` with the standard webui mocks and an
 * RPC recorder. `?bust=N` gives every boot its own module instance, which
 * is what lets a test change a mock and still see the new one.
 *
 * The recorder is the ONLY thing the executor's engine half touches, so
 * every assertion about "what the engine received" is a value read back
 * from this list rather than a spy count.
 */
async function bootWithRpc(t, impl = {}) {
  await setupMocks(t, {});
  const calls = [];
  registerRpcMock({
    webuiPermissionToMcode: realRpc.webuiPermissionToMcode,
    setConfigOption: async (sid, configId, value, cid) => {
      calls.push({ sid, configId, value, cid });
      if (typeof impl.setConfigOption === "function") return impl.setConfigOption({ sid, configId, value, cid });
      return { ok: true, data: {} };
    },
  });
  const facade = await import(`${absPath("engine/model-writes.js")}?bust=${bust++}`);
  return { facade, calls };
}

/** Boot without the RPC mock — for the pure derivations and the mappers. */
async function bootPure(t) {
  await setupMocks(t, {});
  return import(`${absPath("engine/model-writes.js")}?bust=${bust++}`);
}

// The real SSE-race reader, imported with no mocks in play. Its module
// load may start the resident acp singleton, which `after` shuts down —
// the same teardown `test/lib/mcode-acp-ownership.check.mjs` documents.
let raceReader;
before(async () => {
  raceReader = await import(absPath("lib/mcode-acp.js"));
  // The engine's materialised builtin tree, in the real file format, for
  // the whole run. Written AFTER the reader import so the reader is the
  // real one with no fixture in its way.
  writeFileSync(join(tmpBase, "config.yaml"), yaml.dump({ provider: BUILTIN_MINIMAX_TREE }), "utf8");
});
after(async () => {
  const acp = await import(absPath("lib/acp-client.js"));
  try { await acp.getMcodeAcpClient(); } catch { /* engine never started */ }
  try { acp.shutdownMcodeAcpSingleton(); } catch { /* nothing to stop */ }
  rmTmpDir(tmpBase);
});

beforeEach(() => {
  registerRpcMock({
    setConfigOption: async () => ({ ok: true, data: {} }),
    webuiPermissionToMcode: realRpc.webuiPermissionToMcode,
  });
});

// ---------------------------------------------------------------------------
// The export surface
// ---------------------------------------------------------------------------

describe("model-writes facade — export surface", () => {
  test("exports exactly the names this file pins, no more and no fewer", async () => {
    const module = await import(absPath("engine/model-writes.js"));
    const actual = Object.keys(module).filter((k) => k !== "default").sort();
    assert.deepEqual(actual, FACADE_EXPORTS);
  });

  test("the name list is derived from the SOURCE, so a new export cannot slip past the sweep", () => {
    assert.deepEqual([...exportedNamesOf("engine/model-writes.js")].sort(), FACADE_EXPORTS);
  });

  test("routes/model.js imports the module DIRECTLY, and the facade index does not re-export it", () => {
    // The same call B4 made for `model-reads.js`: this module statically
    // reaches `lib/engine-catalogue.js` (and through it js-yaml), and
    // `engine/index.js` is the one import site the whole server shares.
    const route = readFileSync(fileURLToPath(absPath("routes/model.js")), "utf8");
    assert.match(route, /from "\.\.\/engine\/model-writes\.js"/);
    const index = readFileSync(fileURLToPath(absPath("engine/index.js")), "utf8");
    assert.equal(index.includes("model-writes.js"), false, "engine/index.js must not pull it in");
  });

  test("the RPC wrapper is reached through a dynamic import, never a static one", () => {
    // The boot-path rule every engine family follows: mcode-rpc.js pulls
    // the ACP client, and a static import here would put it on the
    // import graph of anything that loads the facade.
    const src = readFileSync(fileURLToPath(absPath("engine/model-writes.js")), "utf8");
    assert.equal(/^import .*mcode-rpc/m.test(src), false, "no static import of mcode-rpc.js");
    assert.match(src, /import\("\.\.\/lib\/mcode-rpc\.js"\)/, "the wrapper is reached through import()");
  });
});

// ---------------------------------------------------------------------------
// The two warning strings — wire values, pinned
// ---------------------------------------------------------------------------

describe("the no-session warnings", () => {
  test("each endpoint keeps its OWN sentence, and they are not the same string", async (t) => {
    const { NO_SESSION_MODEL_WARNING, NO_SESSION_PERMISSION_WARNING } = await bootPure(t);
    assert.equal(NO_SESSION_MODEL_WARNING, "no mcode session yet — recorded for the next one");
    assert.equal(NO_SESSION_PERMISSION_WARNING, "no mcode session yet — applies to the next one");
    assert.notEqual(NO_SESSION_MODEL_WARNING, NO_SESSION_PERMISSION_WARNING);
  });
});

// ---------------------------------------------------------------------------
// modelSelectionTarget
// ---------------------------------------------------------------------------

describe("modelSelectionTarget", () => {
  test("the requested model wins; the recorded one is the fallback; empty is empty", async (t) => {
    const { modelSelectionTarget } = await bootPure(t);
    const cs = fakeCs({ model: { name: "minimax_api/MiniMax-M3" } });
    assert.equal(modelSelectionTarget(cs, "zai-pro/glm-5.3"), "zai-pro/glm-5.3");
    assert.equal(modelSelectionTarget(cs, ""), "minimax_api/MiniMax-M3", "thinking-only update");
    assert.equal(modelSelectionTarget({ model: {} }, ""), "");
    assert.equal(modelSelectionTarget(null, ""), "", "a client state that is not there yet");
  });
});

// ---------------------------------------------------------------------------
// resolveEngineModelConfigValue — the wire form
// ---------------------------------------------------------------------------

describe("resolveEngineModelConfigValue — webui id → engine wire value", () => {
  const cases = [
    { name: "bare builtin form", cs: { configOptions: [VARIANT_MODEL_OPTION] }, id: "minimax_api/MiniMax-M2.7", want: "m:minimax_api:MiniMax-M2.7:u" },
    { name: "custom provider, percent-encoded", cs: { configOptions: [CUSTOM_MODEL_OPTION] }, id: "zai-pro/glm-5.3", want: "m:custom_provider%3Azai-pro:glm-5.3:u" },
    { name: "a multi-segment model key", cs: { configOptions: [{ id: "model", options: [{ value: "m:nousresearch:deepseek/x:u", name: "deepseek/x" }] }] }, id: "nousresearch/deepseek/x", want: "m:nousresearch:deepseek/x:u" },
    { name: "a display name that differs from the model id", cs: { configOptions: [{ id: "model", options: [{ value: "m:p:deepseek/deepseek-v4.1-flash:u", name: "DeepSeek V4.1 Flash" }] }] }, id: "p/deepseek/deepseek-v4.1-flash", want: "m:p:deepseek/deepseek-v4.1-flash:u" },
    { name: "an id that is already the wire value", cs: { configOptions: [CUSTOM_MODEL_OPTION] }, id: "m:custom_provider%3Azai-pro:glm-5.3:u", want: "m:custom_provider%3Azai-pro:glm-5.3:u" },
  ];

  for (const c of cases) {
    test(`${c.name}`, async (t) => {
      const { resolveEngineModelConfigValue } = await bootPure(t);
      assert.equal(resolveEngineModelConfigValue(c.cs, c.id), c.want);
    });
  }

  test("preferVariant narrows the deliberate ambiguity of a switchable builtin", async (t) => {
    const { resolveEngineModelConfigValue } = await bootPure(t);
    const cs = { configOptions: [VARIANT_MODEL_OPTION] };
    const id = "minimax_api/MiniMax-M3";
    // Both options carry the same bare name, so without a preference this
    // is ambiguous and the answer is null — the caller then pushes the
    // recorded id rather than picking the wrong variant.
    assert.equal(resolveEngineModelConfigValue(cs, id), null);
    assert.equal(resolveEngineModelConfigValue(cs, id, { preferVariant: "none-thinking" }), "m:minimax_api:MiniMax-M3:v:none-thinking");
    assert.equal(resolveEngineModelConfigValue(cs, id, { preferVariant: "thinking" }), "m:minimax_api:MiniMax-M3:v:thinking");
    // A variant the engine does not advertise falls through to the
    // pre-ticket-36 outcome rather than inventing a wire form.
    assert.equal(resolveEngineModelConfigValue(cs, id, { preferVariant: "nonsense" }), null);
  });

  test("null whenever the engine has not advertised the model yet, and for a junk id", async (t) => {
    const { resolveEngineModelConfigValue } = await bootPure(t);
    // No `model` option at all (the state before the first session event).
    assert.equal(resolveEngineModelConfigValue({ configOptions: [] }, "minimax_api/MiniMax-M3"), null);
    assert.equal(resolveEngineModelConfigValue({}, "minimax_api/MiniMax-M3"), null);
    assert.equal(resolveEngineModelConfigValue({ configOptions: [VARIANT_MODEL_OPTION] }, ""), null);
    assert.equal(resolveEngineModelConfigValue({ configOptions: [VARIANT_MODEL_OPTION] }, 42), null);
    assert.equal(resolveEngineModelConfigValue({ configOptions: [VARIANT_MODEL_OPTION] }, null), null);
  });
});

// ---------------------------------------------------------------------------
// planModelSelectionPush — the two channels, field by field
// ---------------------------------------------------------------------------

describe("planModelSelectionPush — the variant channel", () => {
  test("model + thinking:'off' folds the level into ONE model push and drops the effort push", async (t) => {
    const facade = await bootPure(t);
    const cs = fakeCs({ model: { name: "minimax_api/MiniMax-M3" }, configOptions: [VARIANT_MODEL_OPTION] });
    const plan = facade.planModelSelectionPush({
      cs,
      modelId: "minimax_api/MiniMax-M3",
      thinkingWasProvided: true,
      thinking: "off",
      variantPlan: variantChannelFor("minimax_api/MiniMax-M3"),
    });
    assert.equal(plan.channel, "variant");
    assert.equal(plan.target, "minimax_api/MiniMax-M3");
    assert.deepEqual(plan.modelPush, { value: "m:minimax_api:MiniMax-M3:v:none-thinking" });
    assert.equal(plan.thinkingPush, null);
    assert.equal(plan.reportsModelSynced, true);
    assert.equal(plan.carriedThinking, true);
  });

  test("a thinking-only update attaches the level to the RECORDED model", async (t) => {
    const facade = await bootPure(t);
    const cs = fakeCs({ model: { name: "minimax_api/MiniMax-M3", thinking: "off" }, configOptions: [VARIANT_MODEL_OPTION] });
    const plan = facade.planModelSelectionPush({
      cs,
      thinkingWasProvided: true,
      thinking: "on",
      variantPlan: variantChannelFor(cs.model.name),
    });
    assert.equal(plan.modelPush.value, "m:minimax_api:MiniMax-M3:v:thinking");
    // No model in the request, so the model-sync field stays false even
    // though the model push itself succeeded. Pre-B10 behaviour.
    assert.equal(plan.reportsModelSynced, false);
    assert.equal(plan.carriedThinking, true);
  });

  test("no user-chosen level falls back to the engine's DEFAULT variant and reports nothing synced", async (t) => {
    const facade = await bootPure(t);
    const cs = fakeCs({ model: { name: "minimax_api/MiniMax-M3", thinking: "" }, configOptions: [VARIANT_MODEL_OPTION] });
    const plan = facade.planModelSelectionPush({
      cs,
      modelId: "minimax_api/MiniMax-M3",
      variantPlan: variantChannelFor("minimax_api/MiniMax-M3"),
    });
    assert.equal(plan.modelPush.value, "m:minimax_api:MiniMax-M3:v:thinking", "default_value true → thinking");
    assert.equal(plan.carriedThinking, false, "an engine-default variant is not a sync");
  });

  test("a CLEARED level is not a carried level, and means the ENGINE DEFAULT variant", async (t) => {
    // The level normaliser only knows "on" and "off"; a cleared level is
    // neither, so it lands on the engine's default variant — which is
    // "thinking" for a `default_value: "true"` model. Reading the clear
    // as "off" would be a plausible rewrite and a behaviour change, so
    // it is pinned from both sides.
    const facade = await bootPure(t);
    const cs = fakeCs({ model: { name: "minimax_api/MiniMax-M3", thinking: "on" }, configOptions: [VARIANT_MODEL_OPTION] });
    const plan = facade.planModelSelectionPush({
      cs,
      thinkingWasProvided: true,
      thinking: "",
      variantPlan: variantChannelFor(cs.model.name),
    });
    assert.equal(plan.modelPush.value, "m:minimax_api:MiniMax-M3:v:thinking");
    assert.equal(plan.carriedThinking, false);
  });

  test("a MODEL-only pick carries a RECORDED level — the absent field is not the same as an empty one", async (t) => {
    // The engine's own wire form is chosen from the variant the session
    // already has, so a model-only pick on a switchable builtin still
    // carries that level — and reports it as synced. Reading the absent
    // field as "nothing carried" is a plausible rewrite that would flip
    // `thinkingSynced` on a real, successful push.
    const facade = await bootPure(t);
    const cs = fakeCs({ model: { name: "minimax_api/MiniMax-M2.7", thinking: "off" }, configOptions: [VARIANT_MODEL_OPTION] });
    const plan = facade.planModelSelectionPush({
      cs,
      modelId: "minimax_api/MiniMax-M3",
      variantPlan: variantChannelFor("minimax_api/MiniMax-M3"),
    });
    assert.equal(plan.modelPush.value, "m:minimax_api:MiniMax-M3:v:none-thinking");
    assert.equal(plan.carriedThinking, true, "the recorded level rode the model push");
  });

  test("a target the engine has not advertised falls back to the recorded id, not to null", async (t) => {
    const facade = await bootPure(t);
    const cs = fakeCs({ model: { name: "minimax_api/MiniMax-M3" }, configOptions: [] });
    const plan = facade.planModelSelectionPush({
      cs,
      modelId: "minimax_api/MiniMax-M3",
      thinkingWasProvided: true,
      thinking: "off",
      variantPlan: variantChannelFor("minimax_api/MiniMax-M3"),
    });
    assert.equal(plan.modelPush.value, "minimax_api/MiniMax-M3", "the raw webui id, unchanged");
  });

  test("a NON-builtin id never rides the variant channel", async (t) => {
    const facade = await bootPure(t);
    // `variantChannelFor` returns null for anything outside the builtin
    // provider, even a model that shares a bare name with a builtin.
    assert.equal(variantChannelFor("zai-pro/glm-5.3"), null);
    const cs = fakeCs({ model: { name: "zai-pro/glm-5.3" }, configOptions: [CUSTOM_MODEL_OPTION] });
    const plan = facade.planModelSelectionPush({ cs, modelId: "zai-pro/glm-5.3", thinkingWasProvided: true, thinking: "high" });
    assert.equal(plan.channel, "effort");
  });
});

describe("planModelSelectionPush — the effort channel", () => {
  test("model first, then effort — the engine's own contract", async (t) => {
    const facade = await bootPure(t);
    const cs = fakeCs({ model: { name: "minimax_api/MiniMax-M2.7" }, configOptions: [EFFORT_MODEL_OPTION] });
    const plan = facade.planModelSelectionPush({ cs, modelId: "minimax_api/MiniMax-M3.1-Flash-Preview", thinkingWasProvided: true, thinking: "high" });
    assert.equal(plan.channel, "effort");
    assert.deepEqual(plan.modelPush, { value: "m:minimax_api:MiniMax-M3.1-Flash-Preview:u" });
    assert.deepEqual(plan.thinkingPush, { value: "high" });
    assert.equal(plan.reportsModelSynced, true);
    assert.equal(plan.carriedThinking, true);
  });

  test("a thinking-only update pushes ONLY the effort, and reports no model sync", async (t) => {
    // The asymmetry with the variant channel, and it is pre-existing: a
    // non-switchable model has no wire form that carries an effort, so
    // the level travels on its own config id. `mcodeSynced` stays false
    // because no model was in the request.
    const facade = await bootPure(t);
    const cs = fakeCs({ model: { name: "minimax_api/MiniMax-M3.1-Flash-Preview" }, configOptions: [EFFORT_MODEL_OPTION] });
    const plan = facade.planModelSelectionPush({ cs, thinkingWasProvided: true, thinking: "high" });
    assert.equal(plan.modelPush, null, "no model push — nothing in the request names a model");
    assert.deepEqual(plan.thinkingPush, { value: "high" });
    assert.equal(plan.reportsModelSynced, false);
    assert.equal(plan.carriedThinking, true);
  });

  test("a cleared level plans no effort push, and the model id is left alone", async (t) => {
    const facade = await bootPure(t);
    const cs = fakeCs({ model: { name: "minimax_api/MiniMax-M3.1-Flash-Preview", thinking: "high" }, configOptions: [EFFORT_MODEL_OPTION] });
    const plan = facade.planModelSelectionPush({ cs, thinkingWasProvided: true, thinking: "" });
    assert.equal(plan.modelPush, null);
    assert.equal(plan.thinkingPush, null);
    assert.equal(plan.carriedThinking, false);
  });

  test("an absent thinking field is NOT the same as a cleared one", async (t) => {
    const facade = await bootPure(t);
    const cs = fakeCs({ model: { name: "minimax_api/MiniMax-M3.1-Flash-Preview", thinking: "high" }, configOptions: [EFFORT_MODEL_OPTION] });
    const absent = facade.planModelSelectionPush({ cs, modelId: "minimax_api/MiniMax-M3.1-Flash-Preview" });
    assert.equal(absent.thinkingPush, null, "the recorded level is not pushed on a model-only pick");
    assert.equal(absent.carriedThinking, false);
  });

  test("the model value falls back to the recorded id when the engine advertises nothing yet", async (t) => {
    const facade = await bootPure(t);
    const cs = fakeCs({ model: { name: "minimax_api/MiniMax-M2.7" }, configOptions: [] });
    const plan = facade.planModelSelectionPush({ cs, modelId: "minimax_api/MiniMax-M2.7" });
    assert.deepEqual(plan.modelPush, { value: "minimax_api/MiniMax-M2.7" });
  });
});

// ---------------------------------------------------------------------------
// THE TWO FORMS, FIELD BY FIELD
// ---------------------------------------------------------------------------

describe("wire form ↔ recorded selection — field by field", () => {
  /**
   * One row per (engine option shape × request shape). `wire` is what the
   * engine must receive, in order; `recorded` is what webui must keep; the
   * rest is the response triple. Every field is asserted on every row —
   * a row that only checked the wire form would let the recorded form rot
   * while the suite stayed green, which is the half of the equivalence
   * nobody looks at.
   */
  const ROWS = [
    {
      name: "bare builtin, model only",
      channel: "effort",
      configOptions: [VARIANT_MODEL_OPTION],
      cs: { model: { name: "minimax_api/MiniMax-M2.7", thinking: "" } },
      request: { model: "minimax_api/MiniMax-M2.7" },
      wire: [{ configId: "model", value: "m:minimax_api:MiniMax-M2.7:u" }],
      recorded: { name: "minimax_api/MiniMax-M2.7", thinking: "" },
      result: { mcodeSynced: true, thinkingSynced: false, warning: null },
    },
    {
      name: "bare builtin, model + effort",
      channel: "effort",
      configOptions: [EFFORT_MODEL_OPTION],
      cs: { model: { name: "minimax_api/MiniMax-M3.1-Flash-Preview", thinking: "" } },
      request: { model: "minimax_api/MiniMax-M3.1-Flash-Preview", thinking: "high" },
      wire: [
        { configId: "model", value: "m:minimax_api:MiniMax-M3.1-Flash-Preview:u" },
        { configId: "thinkingEffort", value: "high" },
      ],
      recorded: { name: "minimax_api/MiniMax-M3.1-Flash-Preview", thinking: "high" },
      result: { mcodeSynced: true, thinkingSynced: true, warning: null },
    },
    {
      name: "custom provider, model + effort",
      channel: "effort",
      configOptions: [CUSTOM_MODEL_OPTION],
      cs: { model: { name: "zai-pro/glm-5.3", thinking: "" } },
      request: { model: "zai-pro/glm-5.3", thinking: "high" },
      wire: [
        { configId: "model", value: "m:custom_provider%3Azai-pro:glm-5.3:u" },
        { configId: "thinkingEffort", value: "high" },
      ],
      recorded: { name: "zai-pro/glm-5.3", thinking: "high" },
      result: { mcodeSynced: true, thinkingSynced: true, warning: null },
    },
    {
      name: "switchable builtin, model + level off — ONE push",
      channel: "variant",
      configOptions: [VARIANT_MODEL_OPTION],
      cs: { model: { name: "minimax_api/MiniMax-M3", thinking: "" } },
      request: { model: "minimax_api/MiniMax-M3", thinking: "off" },
      wire: [{ configId: "model", value: "m:minimax_api:MiniMax-M3:v:none-thinking" }],
      recorded: { name: "minimax_api/MiniMax-M3", thinking: "off" },
      result: { mcodeSynced: true, thinkingSynced: true, warning: null },
    },
    {
      name: "switchable builtin, level only — the recorded model carries it",
      channel: "variant",
      configOptions: [VARIANT_MODEL_OPTION],
      cs: { model: { name: "minimax_api/MiniMax-M3", thinking: "off" } },
      request: { thinking: "on" },
      wire: [{ configId: "model", value: "m:minimax_api:MiniMax-M3:v:thinking" }],
      recorded: { name: "minimax_api/MiniMax-M3", thinking: "on" },
      // No model in the request, so the model-sync field is false even
      // though the model push succeeded. Pinned because it reads like a
      // bug and is not one.
      result: { mcodeSynced: false, thinkingSynced: true, warning: null },
    },
    {
      name: "switchable builtin, model only — engine default variant, nothing synced",
      channel: "variant",
      configOptions: [VARIANT_MODEL_OPTION],
      cs: { model: { name: "minimax_api/MiniMax-M3", thinking: "" } },
      request: { model: "minimax_api/MiniMax-M3" },
      wire: [{ configId: "model", value: "m:minimax_api:MiniMax-M3:v:thinking" }],
      recorded: { name: "minimax_api/MiniMax-M3", thinking: "" },
      result: { mcodeSynced: true, thinkingSynced: false, warning: null },
    },
    {
      name: "switchable builtin, model only, recorded level carried",
      channel: "variant",
      configOptions: [VARIANT_MODEL_OPTION],
      cs: { model: { name: "minimax_api/MiniMax-M2.7", thinking: "off" } },
      request: { model: "minimax_api/MiniMax-M3" },
      wire: [{ configId: "model", value: "m:minimax_api:MiniMax-M3:v:none-thinking" }],
      recorded: { name: "minimax_api/MiniMax-M3", thinking: "off" },
      result: { mcodeSynced: true, thinkingSynced: true, warning: null },
    },
    {
      name: "engine advertises no model option yet — the recorded id goes out verbatim",
      channel: "variant",
      configOptions: [],
      cs: { model: { name: "minimax_api/MiniMax-M2.7", thinking: "" } },
      request: { model: "minimax_api/MiniMax-M3" },
      wire: [{ configId: "model", value: "minimax_api/MiniMax-M3" }],
      recorded: { name: "minimax_api/MiniMax-M3", thinking: "" },
      result: { mcodeSynced: true, thinkingSynced: false, warning: null },
    },
  ];

  for (const row of ROWS) {
    test(row.name, async (t) => {
      const { facade, calls } = await bootWithRpc(t);
      const cs = fakeCsWithSession({ model: row.cs.model, configOptions: row.configOptions });
      await withBuiltinTree(async () => {
        // The row's `request` is the route's BODY; this is the route's own
        // translation of it, so the recorded-form half of the row is a
        // simulation of `handleSetModel` rather than a second truth.
        const body = { ...row.request };
        const modelId = typeof body.model === "string" ? body.model.trim() : "";
        const thinkingWasProvided = Object.prototype.hasOwnProperty.call(body, "thinking");
        const thinking = thinkingWasProvided ? body.thinking.trim() : undefined;
        if (modelId) cs.model.name = modelId;
        if (thinkingWasProvided) cs.model.thinking = thinking;
        const r = await facade.pushEngineModelSelection({ cs, cid: "cid-b10", modelId, thinkingWasProvided, thinking });
        // --- the wire form, in order -------------------------------------
        assert.deepEqual(
          calls.map((c) => ({ configId: c.configId, value: c.value })),
          row.wire,
          "what the engine receives",
        );
        assert.ok(calls.every((c) => c.sid === "mvs_b10_0000000000000000000000"));
        assert.ok(calls.every((c) => c.cid === "cid-b10"), "the cid reaches the wrapper on every push");
        // --- the response triple ------------------------------------------
        assert.equal(r.mcodeSynced, row.result.mcodeSynced, "mcodeSynced");
        assert.equal(r.thinkingSynced, row.result.thinkingSynced, "thinkingSynced");
        assert.equal(r.warning, row.result.warning, "warning");
        assert.equal(r.channel, row.channel, "which channel the plan took");
        // --- the recorded form (the route's writes, above) ----------------
        assert.equal(cs.model.name, row.recorded.name, "cs.model.name");
        assert.equal(cs.model.thinking, row.recorded.thinking, "cs.model.thinking");
      });
    });
  }

  test("a rejected model push surfaces the engine's error and never invents a sync", async (t) => {
    const { facade, calls } = await bootWithRpc(t, {
      setConfigOption: ({ configId }) =>
        configId === "model"
          ? { ok: false, error: "unknown model" }
          : { ok: true, data: {} },
    });
    const cs = fakeCsWithSession({ model: { name: "minimax_api/MiniMax-M2.7" }, configOptions: [EFFORT_MODEL_OPTION] });
    await withBuiltinTree(async () => {
      const r = await facade.pushEngineModelSelection({
        cs,
        cid: "cid-b10",
        modelId: "minimax_api/MiniMax-M3.1-Flash-Preview",
        thinkingWasProvided: true,
        thinking: "high",
      });
      assert.equal(r.mcodeSynced, false);
      assert.equal(r.thinkingSynced, true, "the effort push was accepted on its own");
      // The MODEL rejection stays the warning; the accepted effort does
      // not overwrite it.
      assert.equal(r.warning, "unknown model");
      assert.equal(calls.length, 2);
    });
  });

  test("a REJECTED variant push reports the engine's error and claims nothing synced", async (t) => {
    const { facade, calls } = await bootWithRpc(t, { setConfigOption: () => ({ ok: false, error: "variant refused" }) });
    const cs = fakeCsWithSession({ model: { name: "minimax_api/MiniMax-M3" }, configOptions: [VARIANT_MODEL_OPTION] });
    const r = await facade.pushEngineModelSelection({ cs, cid: "cid-b10", modelId: "minimax_api/MiniMax-M3", thinkingWasProvided: true, thinking: "off" });
    assert.equal(r.channel, "variant");
    assert.equal(r.mcodeSynced, false);
    assert.equal(r.thinkingSynced, false, "a rejected push synced nothing, not even the level");
    assert.equal(r.warning, "variant refused");
    assert.equal(r.thinkingMirror, null, "the variant channel never mirrors the effort option");
    assert.equal(calls.length, 1, "and it is still ONE push");
  });

  test("a rejected effort push takes the warning only when the model push did not take it", async (t) => {
    const { facade } = await bootWithRpc(t, {
      setConfigOption: ({ configId }) =>
        configId === "thinkingEffort" ? { ok: false, error: "effort refused" } : { ok: true, data: {} },
    });
    const cs = fakeCsWithSession({ model: { name: "minimax_api/MiniMax-M2.7" }, configOptions: [EFFORT_MODEL_OPTION] });
    await withBuiltinTree(async () => {
      const r = await facade.pushEngineModelSelection({
        cs,
        cid: "cid-b10",
        modelId: "minimax_api/MiniMax-M3.1-Flash-Preview",
        thinkingWasProvided: true,
        thinking: "high",
      });
      assert.equal(r.mcodeSynced, true);
      assert.equal(r.thinkingSynced, false);
      assert.equal(r.warning, "effort refused");
    });
  });

  test("no session: nothing is pushed, and the warning is this endpoint's own sentence", async (t) => {
    const { facade, calls } = await bootWithRpc(t);
    const cs = fakeCs({ model: { name: "minimax_api/MiniMax-M2.7" }, configOptions: [VARIANT_MODEL_OPTION] });
    const r = await facade.pushEngineModelSelection({ cs, cid: "cid-b10", modelId: "minimax_api/MiniMax-M2.7" });
    assert.equal(r.channel, "no-session");
    assert.equal(r.mcodeSynced, false);
    assert.equal(r.thinkingSynced, false);
    assert.equal(r.thinkingMirror, null);
    assert.equal(r.warning, facade.NO_SESSION_MODEL_WARNING);
    assert.deepEqual(calls, []);
  });
});

// ---------------------------------------------------------------------------
// The SSE 4s race window — the writer (this batch) against the real reader
// ---------------------------------------------------------------------------

describe("the SSE race window — writer and reader, pinned together", () => {
  const FRESH = () => Date.now();

  test("a pick inside the window defers the engine mirror, for every field it carried", async (t) => {
    const facade = await bootPure(t);
    const pickAt = FRESH();
    const cs = fakeCs({ model: { name: "minimax_api/MiniMax-M3" } });
    Object.assign(cs.model, facade.planModelPickStamps({ modelId: "minimax_api/MiniMax-M3", thinkingWasProvided: true, contextWindowWasProvided: true }, pickAt));
    const engine = { currentValue: "m:minimax_api:MiniMax-M3:v:thinking" };
    assert.equal(raceReader.shouldMirrorToModelName(cs, engine), false, "model mirror deferred");
    assert.equal(raceReader.shouldMirrorToThinkingField(cs), false, "thinking mirror deferred");
  });

  test("REVERSE HALF — a pick OLDER than the window does not defer: engine truth wins again", async (t) => {
    const facade = await bootPure(t);
    // A cross-client pick that landed 10s ago, or a sluggish engine
    // answering late, must be allowed to catch up. This is the half a
    // "always stamp" simplification breaks.
    const pickAt = Date.now() - raceReader.PICK_DEFER_WINDOW_MS - 1000;
    const cs = fakeCs({ model: { name: "minimax_api/MiniMax-M3" } });
    Object.assign(cs.model, facade.planModelPickStamps({ modelId: "minimax_api/MiniMax-M3", thinkingWasProvided: true }, pickAt));
    const engine = { currentValue: "m:minimax_api:MiniMax-M3:v:thinking" };
    assert.equal(raceReader.shouldMirrorToModelName(cs, engine), true, "model mirror reactivated");
    assert.equal(raceReader.shouldMirrorToThinkingField(cs), true, "thinking mirror reactivated");
  });

  test("REVERSE HALF — a field the request did NOT carry keeps its old stamp and mirrors immediately", async (t) => {
    const facade = await bootPure(t);
    // A thinking-only pick must not suppress a later cross-client MODEL
    // change. Stamping every field would, and the per-field independence
    // that ticket 08 bought would be lost with it.
    const pickAt = FRESH();
    const cs = fakeCs({ model: { name: "minimax_api/MiniMax-M3" } });
    Object.assign(cs.model, facade.planModelPickStamps({ thinkingWasProvided: true }, pickAt));
    assert.equal(cs.model.modelPickedAt, undefined, "the model field was not stamped");
    assert.equal(raceReader.shouldMirrorToModelName(cs, { currentValue: "m:z:p:u" }), true, "model mirror NOT deferred");
    assert.equal(raceReader.shouldMirrorToThinkingField(cs), false, "thinking mirror deferred");
  });

  test("REVERSE HALF — a context-window-only pick defers nothing the reader looks at", async (t) => {
    const facade = await bootPure(t);
    const cs = fakeCs({ model: { name: "minimax_api/MiniMax-M3" } });
    Object.assign(cs.model, facade.planModelPickStamps({ contextWindowWasProvided: true }, FRESH()));
    assert.equal(raceReader.shouldMirrorToModelName(cs, { currentValue: "m:z:p:u" }), true);
    assert.equal(raceReader.shouldMirrorToThinkingField(cs), true);
  });

  test("ONE timestamp for the whole request — the window is a race window, not three", async (t) => {
    const facade = await bootPure(t);
    const pickAt = 1_700_000_000_000;
    const stamps = facade.planModelPickStamps({ modelId: "minimax_api/MiniMax-M3", thinkingWasProvided: true, contextWindowWasProvided: true }, pickAt);
    assert.deepEqual(stamps, {
      modelPickedAt: pickAt,
      thinkingPickedAt: pickAt,
      contextWindowPickedAt: pickAt,
    });
    assert.equal(new Set(Object.values(stamps)).size, 1, "all three fields share one instant");
  });

  test("a request that carried nothing stamps nothing", async (t) => {
    const facade = await bootPure(t);
    assert.deepEqual(facade.planModelPickStamps({}, Date.now()), {});
    assert.deepEqual(facade.planModelPickStamps({ modelId: "" }, Date.now()), {}, "an empty model id is not a pick");
  });
});

// ---------------------------------------------------------------------------
// applyThinkingEffortMirror — the local snapshot rule
// ---------------------------------------------------------------------------

describe("applyThinkingEffortMirror", () => {
  test("set claims the engine's new value; clear DROPS it; null does nothing", async (t) => {
    const { applyThinkingEffortMirror } = await bootPure(t);
    const opts = [
      { id: "model", currentValue: "m:minimax_api:MiniMax-M3:u" },
      { id: "thinkingEffort", currentValue: "low" },
    ];
    assert.equal(applyThinkingEffortMirror(opts, { kind: "set", value: "high" }), 1);
    assert.equal(opts[1].currentValue, "high");
    assert.equal(opts[0].currentValue, "m:minimax_api:MiniMax-M3:u", "the model option is untouched");
    assert.equal(applyThinkingEffortMirror(opts, { kind: "clear" }), 1);
    assert.equal("currentValue" in opts[1], false, "cleared, not emptied — an empty string means the engine's default");
    assert.equal(applyThinkingEffortMirror(opts, null), 0);
  });

  test("a snapshot with no thinkingEffort option is a no-op, and says so", async (t) => {
    const { applyThinkingEffortMirror } = await bootPure(t);
    assert.equal(applyThinkingEffortMirror([{ id: "model" }], { kind: "set", value: "high" }), 0);
    assert.equal(applyThinkingEffortMirror(undefined, { kind: "set", value: "high" }), 0);
    assert.equal(applyThinkingEffortMirror(null, { kind: "clear" }), 0);
    assert.equal(applyThinkingEffortMirror("not an array", { kind: "clear" }), 0);
  });

  test("the route applies exactly the mirror the executor asked for", async (t) => {
    const { facade, calls } = await bootWithRpc(t);
    const cs = fakeCsWithSession({
      model: { name: "minimax_api/MiniMax-M2.7" },
      configOptions: [{ id: "thinkingEffort", currentValue: "low" }, { id: "model" }],
    });
    await withBuiltinTree(async () => {
      const r = await facade.pushEngineModelSelection({ cs, cid: "c", modelId: "minimax_api/MiniMax-M2.7", thinkingWasProvided: true, thinking: "high" });
      assert.deepEqual(r.thinkingMirror, { kind: "set", value: "high" });
      facade.applyThinkingEffortMirror(cs.configOptions, r.thinkingMirror);
      assert.equal(cs.configOptions[0].currentValue, "high");
      // A model-only pick changes nothing here: the engine has not
      // reported a new effort, so the mirror must not invent one.
      const other = fakeCsWithSession({
        model: { name: "minimax_api/MiniMax-M2.7" },
        configOptions: [{ id: "thinkingEffort", currentValue: "low" }],
      });
      const r2 = await facade.pushEngineModelSelection({ cs: other, cid: "c", modelId: "minimax_api/MiniMax-M2.7" });
      assert.equal(r2.thinkingMirror, null);
      assert.equal(other.configOptions[0].currentValue, "low", "untouched");
    });
    assert.ok(calls.length >= 1);
  });

  test("a REFUSED effort push mirrors nothing, and a cleared one drops the value", async (t) => {
    const { facade } = await bootWithRpc(t, {
      setConfigOption: ({ configId }) =>
        configId === "thinkingEffort" ? { ok: false, error: "no" } : { ok: true, data: {} },
    });
    const cs = fakeCsWithSession({
      model: { name: "minimax_api/MiniMax-M2.7" },
      configOptions: [{ id: "thinkingEffort", currentValue: "low" }],
    });
    await withBuiltinTree(async () => {
      const refused = await facade.pushEngineModelSelection({ cs, cid: "c", modelId: "minimax_api/MiniMax-M2.7", thinkingWasProvided: true, thinking: "high" });
      assert.equal(refused.thinkingMirror, null, "an unaccepted push is not mirrored");
      assert.equal(cs.configOptions[0].currentValue, "low", "untouched");
      // Model changed AND effort cleared → the mirror is dropped, and it
      // does NOT depend on the model push having succeeded.
      const cleared = await facade.pushEngineModelSelection({ cs, cid: "c", modelId: "minimax_api/MiniMax-M2.7", thinkingWasProvided: true, thinking: "" });
      assert.deepEqual(cleared.thinkingMirror, { kind: "clear" });
      facade.applyThinkingEffortMirror(cs.configOptions, cleared.thinkingMirror);
      assert.equal("currentValue" in cs.configOptions[0], false);
    });
  });

  test("a clear with NO model change mirrors nothing — the next config_option_update reports it", async (t) => {
    const { facade } = await bootWithRpc(t);
    const cs = fakeCsWithSession({
      model: { name: "minimax_api/MiniMax-M2.7" },
      configOptions: [{ id: "thinkingEffort", currentValue: "low" }],
    });
    await withBuiltinTree(async () => {
      const r = await facade.pushEngineModelSelection({ cs, cid: "c", thinkingWasProvided: true, thinking: "" });
      assert.equal(r.thinkingMirror, null);
      assert.equal(cs.configOptions[0].currentValue, "low", "untouched");
    });
  });
});

// ---------------------------------------------------------------------------
// resolvePermissionSelection — both forms of one mode
// ---------------------------------------------------------------------------

describe("resolvePermissionSelection — the two forms of one mode", () => {
  const TABLE = [
    { mode: "ask", label: "Ask", mcodeValue: "default" },
    { mode: "auto", label: "Auto", mcodeValue: "auto" },
    { mode: "read", label: "Read", mcodeValue: "read" },
    { mode: "off", label: "Off", mcodeValue: "off" },
    { mode: "full", label: "Full access", mcodeValue: "bypassPermissions" },
  ];

  for (const row of TABLE) {
    test(`${row.mode} → label "${row.label}", engine value "${row.mcodeValue}"`, async (t) => {
      const { resolvePermissionSelection } = await bootPure(t);
      assert.deepEqual(await resolvePermissionSelection(row.mode), { label: row.label, mcodeValue: row.mcodeValue });
    });
  }

  test("case is folded, and an unknown mode still gets a label", async (t) => {
    const { resolvePermissionSelection } = await bootPure(t);
    assert.deepEqual(await resolvePermissionSelection("FULL"), { label: "Full access", mcodeValue: "bypassPermissions" });
    assert.deepEqual(await resolvePermissionSelection("AsK"), { label: "Ask", mcodeValue: "default" });
  });

  test("an unknown or missing mode has NO engine value — the two mappers disagree on purpose", async (t) => {
    // The label mapper falls back to `full` so the UI always has
    // something to show; the engine mapper returns null because there is
    // no engine word for a mode the user invented. So the endpoint
    // records a label and does NOT push — which is exactly why
    // `pushEnginePermissionMode` guards on the value and not only on the
    // session. Pinned as a value because "unknown → Full access" reads
    // like it should also push `bypassPermissions`, and it must not.
    const { resolvePermissionSelection } = await bootPure(t);
    // Only a NON-EMPTY unknown string: `""` and `undefined` are falsy and
    // fold to the `full` default before either mapper sees them.
    for (const mode of ["nonsense", "nope", "Ask!"]) {
      assert.deepEqual(
        await resolvePermissionSelection(mode),
        { label: "Full access", mcodeValue: null },
        JSON.stringify(mode),
      );
    }
    for (const mode of ["", undefined, null]) {
      assert.deepEqual(
        await resolvePermissionSelection(mode),
        { label: "Full access", mcodeValue: "bypassPermissions" },
        JSON.stringify(mode),
      );
    }
  });

  test("label and engine value come from TWO different mappers, and both are in play", async (t) => {
    // The seam's whole reason: a fifth form added to one mapper and not
    // the other would be a mode webui records and never delivers.
    const { resolvePermissionSelection } = await bootPure(t);
    const { webuiModeToLabel } = await import(absPath("lib/interaction/permission-presets.js"));
    for (const row of TABLE) {
      const got = await resolvePermissionSelection(row.mode);
      assert.equal(got.label, webuiModeToLabel(row.mode), "label from permission-presets");
      assert.equal(got.mcodeValue, realRpc.webuiPermissionToMcode(row.mode), "engine value from mcode-rpc");
    }
  });
});

// ---------------------------------------------------------------------------
// pushEnginePermissionMode
// ---------------------------------------------------------------------------

describe("pushEnginePermissionMode", () => {
  test("a live session gets exactly one permissionMode push, on this cid", async (t) => {
    const { facade, calls } = await bootWithRpc(t);
    const cs = fakeCsWithSession();
    const r = await facade.pushEnginePermissionMode({ cs, cid: "cid-b10", mcodeValue: "default" });
    assert.deepEqual(calls, [{ sid: "mvs_b10_0000000000000000000000", configId: "permissionMode", value: "default", cid: "cid-b10" }]);
    assert.deepEqual(r, { mcodeSynced: true, warning: null });
  });

  test("no session: local only, and THIS endpoint's warning sentence", async (t) => {
    const { facade, calls } = await bootWithRpc(t);
    const cs = fakeCs();
    const r = await facade.pushEnginePermissionMode({ cs, cid: "cid-b10", mcodeValue: "default" });
    assert.deepEqual(calls, []);
    assert.equal(r.mcodeSynced, false);
    assert.equal(r.warning, facade.NO_SESSION_PERMISSION_WARNING);
  });

  test("a mode with no engine value is recorded but not pushed, and claims no sync", async (t) => {
    // Not a shape today's mapper produces; the guard is the difference
    // between "the engine is in this mode" and "we hope it is".
    const { facade, calls } = await bootWithRpc(t);
    const cs = fakeCsWithSession();
    const r = await facade.pushEnginePermissionMode({ cs, cid: "cid-b10", mcodeValue: null });
    assert.deepEqual(calls, []);
    assert.equal(r.mcodeSynced, false);
    assert.equal(r.warning, null, "nothing went wrong; there was simply nothing to say");
  });

  test("a rejected push surfaces the engine's error verbatim", async (t) => {
    const { facade } = await bootWithRpc(t, { setConfigOption: () => ({ ok: false, error: "mode refused" }) });
    const cs = fakeCsWithSession();
    const r = await facade.pushEnginePermissionMode({ cs, cid: "cid-b10", mcodeValue: "auto" });
    assert.equal(r.mcodeSynced, false);
    assert.equal(r.warning, "mode refused");
  });
});
