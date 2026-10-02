// webui/test/lib/engine/model-reads.test.js
//
// M3-B4: the model-catalogue read's engine facade (#57).
//
// This is the batch's red line. #57 is the largest projection in webui
// and the one a refactor can damage most quietly: three sources, a
// dedupe key that has changed shape twice, two projections of one
// engine file annotating entries from two different sources, and three
// derived "what is active" figures — none of which is compared against
// anything at runtime. So the four things pinned here are:
//
//   1. THE FULL SNAPSHOT (section 5). One rich fixture — engine session
//      option, engine `custom_provider` layer, webui config layer,
//      builtin layer, a builtin that COLLIDES with a config entry, a
//      switchable variant model, an effort-list model, a forced_on
//      model, two providers with overlapping upstream model ids, a
//      provider with a key and one without — projected to the exact
//      response body the pre-refactor route produced. The expected
//      value below was captured from the implementation at 3362c9be
//      (B3's rebase tip) and pasted in longhand: it is NOT recomputed
//      by the functions under test, because a snapshot whose oracle is
//      the implementation proves nothing. The two `minimax_api` models
//      that are ABSENT from the builtin half of the `minimax_api`
//      group are the load-bearing part: the config layer took those
//      slots wholesale, which is ticket 09-02's dedupe rule.
//
//   2. THE PURE PROJECTIONS ON THEIR INPUTS (sections 3–4). Each rule
//      the snapshot exercises incidentally is also asserted on a
//      minimal input of its own, so a failure names the RULE that broke
//      rather than pointing at a 280-line diff.
//
//   3. THE VARIANT / CONTEXT PERTURBATION (section 6). The thinking
//      levels and the context-window options are two projections of one
//      engine file, and the interesting failure is a cross-wiring: an
//      annotation attached to the wrong entry, or the builtin tree read
//      twice so the two sites disagree. The test perturbs one engine
//      model at a time and records exactly which entries move.
//
//   4. THE GATE IS SOFT, AND THE MOCK IS REAL. The registered provider
//      declares `authCredentials` `full`, so only this file can prove
//      the soft gate reports what it claims; and node:test's
//      `mock.module` re-evaluates only the MOCKED specifier, so every
//      route test re-imports the route under a fresh `?bust=N`, and
//      section 7 ends with the control that proves the mock took.
//
// Fixture ordering is load-bearing, not stylistic. `lib/config.js`
// resolves `MCODE_WEBUI_DATA_DIR` / `MINIMAX_DATA_DIR` at MODULE LOAD,
// and `engine/model-reads.js` imports it statically — so the fixture
// directories and the env are built at module top level, BEFORE the
// first import that reaches a server module. A `before()` that set the
// env would be too late: the first import would already have frozen the
// real ~/.minimax path, and every case below would read the developer's
// own config instead of the fixture.
//
// Test style follows test/lib/engine/usage-reads.test.js (B3) and
// test/lib/engine/account-reads.test.js (B4 #20): table-driven, one row
// per case.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { mkTmpDir, rmTmpDir } from "../../helpers/tmp.js";
import { setupMocks, absPath, setBuiltinModelsMock } from "../../helpers/_setup.js";

// ---------------------------------------------------------------------------
// Fixture — built BEFORE any server module is imported (see the header).
//
// One root, three children, one registered prefix: the engine's data
// dir (its `config.yaml` — both the `custom_provider` tree and the
// materialised `provider.minimax.models` builtin tree), the webui data
// dir (where the user-level `providers.json` would live), and the env
// layer file. The prefix is registered in
// scripts/test-tmp-leak.check.mjs#KNOWN_PREFIXES; a new prefix without
// that entry fails the test:release-tools gate.
// ---------------------------------------------------------------------------

const root = mkTmpDir("webui-model-reads-");
const engineDir = join(root, "engine");
const webuiDir = join(root, "webui");
mkdirSync(engineDir, { recursive: true });
mkdirSync(webuiDir, { recursive: true });

// The engine's own config: a materialised builtin tree (one switchable
// variant model, one effort-list model, one forced_on model with
// nothing user-settable) and a `custom_provider` tree with two
// providers whose model ids OVERLAP (`z-ai/glm-5.3` is deliberately the
// kind of id that used to make one provider swallow another's entry).
writeFileSync(
  join(engineDir, "config.yaml"),
  `provider:
  minimax:
    models:
      MiniMax-M3:
        thinking_config:
          mode: switchable
          default_value: 'true'
        variants:
          none-thinking: { thinking: { type: disabled } }
          thinking: { thinking: { type: adaptive } }
        contextWindowOptions: [512000, 1000000]
        contextWindowOptionHints: { "1000000": "higher_usage" }
        limit: { context: 512000 }
      MiniMax-M2.7:
        thinking:
          effortOptions: [low, medium, high]
        contextWindowOptions: [128000, 256000]
        limit: { context: 128000 }
      MiniMax-M2.5:
        thinking_config:
          mode: forced_on
custom_provider:
  deepseek-cn:
    api: openai-completions
    kind: custom
    options: { apiKey: "sk-secret-should-never-leak" }
    models:
      deepseek-chat:
        name: DeepSeek Chat
        thinking: { effortOptions: [low, high] }
        modalities: { input: [text, image] }
        limit: { context: 64000 }
      deepseek-reasoner: {}
  nousresearch:
    api: openai-responses
    kind: custom
    options: { apiKey: "" }
    models:
      z-ai/glm-5.3: {}
      openai/gpt-5.6-sol: {}
`,
  "utf8",
);

// The webui's env layer. `minimax_api` is present ON PURPOSE: its
// `MiniMax-M3` entry collides with the builtin of the same name, so the
// `seen` dedupe has to let the config layer win wholesale — which is
// why the builtin half of that group is missing the entry, the
// `thinkingLevels`, and the `contextWindowOptions`.
const modelsConfigPath = join(root, "models.json");
writeFileSync(
  modelsConfigPath,
  JSON.stringify({
    providers: [
      {
        id: "minimax_api",
        label: "MiniMax builtins",
        auth: { type: "byok", apiKey: "sk-webui-fixture-key-0001" },
        protocol: "anthropic",
        models: [
          { id: "MiniMax-M3", label: "M3 config override", contextLimit: 123456 },
          { id: "MiniMax-Text-01", thinkingLevels: ["off", "on"], modalities: ["text", "image"] },
        ],
      },
      { id: "local-ollama", models: [{ id: "qwen3:8b" }] },
    ],
  }),
  "utf8",
);

process.env.MINIMAX_DATA_DIR = engineDir;
delete process.env.MAVIS_DATA_DIR;
process.env.MCODE_WEBUI_DATA_DIR = webuiDir;
process.env.MCODE_WEBUI_MODELS_CONFIG = modelsConfigPath;

/** The builtin list the mocked `getBuiltinModelsFromMcode` answers with. */
const BUILTINS = ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.5", "MiniMax-M2.7-highspeed"];

/**
 * A `model` config option shaped like the engine's, in the wire form
 * `m:<provider>:<model>[:v:<variant>]` that `control-state.ts` emits for
 * the builtin tree. The model segment is the BARE engine-side model key,
 * which is what makes the two builtin-tree projections reachable from
 * this source at all (see section 6).
 */
const MODEL_OPTION = {
  type: "select",
  id: "model",
  name: "Model",
  category: "model",
  currentValue: "m:minimax_api:MiniMax-M3:v:thinking",
  options: [
    { value: "m:minimax_api:MiniMax-M3:v:thinking", name: "MiniMax-M3" },
    { value: "m:minimax_api:MiniMax-M2.7:u", name: "MiniMax-M2.7" },
  ],
};

/** The `cs` the snapshot runs against. */
const SNAPSHOT_CS = {
  model: { name: "minimax_api/MiniMax-M3", thinking: "on", contextWindow: 1000000 },
  configOptions: [MODEL_OPTION, { id: "thinkingEffort", currentValue: "high" }],
};

/** The REAL wire-form parser, so the snapshot exercises the real parse. */
const { parseEngineModelWireValue, readEngineBuiltinThinking, readEngineBuiltinContextWindows } =
  await import("../../../server/lib/engine-catalogue.js");
// `capabilities.js` directly, NOT `engine/index.js`: the facade re-exports
// `model-reads.js`, so importing it at module scope would evaluate the
// module under test — and its STATIC import of `lib/models.js` — BEFORE
// `before()` registers the builtin-catalogue mock, and the snapshot
// would then read whatever `mcode` bundle the host has installed.
const { ENGINE_CAPABILITY_KEYS } = await import("../../../server/engine/capabilities.js");

// --- now, and only now, the modules under test ---------------------------
let engine;
let modelRouteBaseline;
before(async (t) => {
  // `setupMocks` must precede the SUT import: `engine/model-reads.js`
  // imports `lib/models.js` STATICALLY, and the builtin catalogue must
  // come from the mock rather than from whatever `mcode` bundle happens
  // to be installed on the host.
  await setupMocks(t, { acp: {} });
  setBuiltinModelsMock(BUILTINS);
  engine = await import(absPath("engine/model-reads.js"));
  modelRouteBaseline = await import(absPath("routes/model.js"));
});

after(() => {
  rmTmpDir(root);
  delete process.env.MINIMAX_DATA_DIR;
  delete process.env.MAVIS_DATA_DIR;
  delete process.env.MCODE_WEBUI_DATA_DIR;
  delete process.env.MCODE_WEBUI_MODELS_CONFIG;
});

const RUNTIME = "runtime";
const ACP = "acp";

// ---------------------------------------------------------------------------
// 1. The endpoint → capability declaration table
// ---------------------------------------------------------------------------

describe("MODEL_READ_ENDPOINTS — this batch's declaration table", () => {
  test("covers exactly the one endpoint of the model family", () => {
    assert.deepEqual(Object.keys(engine.MODEL_READ_ENDPOINTS), ["GET /api/models"]);
  });

  test("GET /api/models declares authCredentials.listModelProviders, enforced SOFT", () => {
    // Table-driven: editing this row is a capability decision and must be
    // reviewed as one, so the table IS the assertion.
    const row = {
      capability: "authCredentials",
      subItem: "listModelProviders",
      enforcement: "soft",
    };
    assert.deepEqual(engine.MODEL_READ_ENDPOINTS["GET /api/models"], row);
    assert.ok(ENGINE_CAPABILITY_KEYS.includes(row.capability));
  });

  test("it shares the capability KEY with the account family, and differs in the other two fields", async () => {
    // Both families ride `authCredentials` because the 14 matrix keys
    // have no separate "models" row — the engine's model/provider
    // surface is declared there. What differs is the sub-item and the
    // enforcement, and both differences are asserted rather than
    // assumed: a models read gated on `getAccountStatus` would let a
    // provider that cannot report a plan still be trusted for a
    // catalogue, and vice versa.
    const { ACCOUNT_READ_ENDPOINTS } = await import("../../../server/engine/account-reads.js");
    assert.equal(
      engine.MODEL_READ_ENDPOINTS["GET /api/models"].capability,
      ACCOUNT_READ_ENDPOINTS["GET /api/account"].capability,
    );
    assert.notEqual(
      engine.MODEL_READ_ENDPOINTS["GET /api/models"].subItem,
      ACCOUNT_READ_ENDPOINTS["GET /api/account"].subItem,
    );
    assert.equal(ACCOUNT_READ_ENDPOINTS["GET /api/account"].enforcement, undefined);
  });
});

// ---------------------------------------------------------------------------
// 2. Provider resolution + the SOFT gate
// ---------------------------------------------------------------------------

describe("resolveModelReadProvider / checkModelReadCapability", () => {
  // Table-driven. The gate values are `session-export.js`'s vocabulary,
  // reused rather than re-invented.
  const TRANSPORTS = [
    [RUNTIME, true, "checked", "local-runtime-v2"],
    [ACP, false, "unregistered-transport", null],
    ["exec", false, "unregistered-transport", null],
    ["", false, "unregistered-transport", null],
  ];
  for (const [transport, hasProvider, gate, providerId] of TRANSPORTS) {
    test(`transport=${JSON.stringify(transport)} → ${gate}`, () => {
      const provider = engine.resolveModelReadProvider(transport);
      assert.equal(!!provider, hasProvider);
      const g = engine.checkModelReadCapability("GET /api/models", transport);
      assert.equal(g.gate, gate);
      assert.equal(g.provider, providerId);
      assert.equal(g.capability, "authCredentials");
      assert.equal(g.subItem, "listModelProviders");
      assert.equal(g.enforcement, "soft");
    });
  }

  test("the gate NEVER throws, under any transport or endpoint key", () => {
    // The whole reason this family's gate is soft: the catalogue's
    // primary sources are files webui owns. A provider that declared no
    // model surface would still leave a working picker, so a hard gate
    // here would REMOVE working functionality — the #11 reasoning,
    // reused.
    for (const transport of [RUNTIME, ACP, "exec", "", "nonsense"]) {
      assert.doesNotThrow(() => engine.checkModelReadCapability("GET /api/models", transport));
    }
  });

  test("an unknown endpoint key is a plain Error, not 501 material", () => {
    assert.throws(
      () => engine.checkModelReadCapability("GET /api/nope", RUNTIME),
      (err) => {
        assert.equal(err.code, "unknown_model_read_endpoint");
        assert.match(err.message, /not part of the model family/);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// 3. The two id helpers
// ---------------------------------------------------------------------------

describe("providerOfModelId / webuiFullModelId", () => {
  // Table-driven: [modelId, fallback, expected]. The bare-id fallback to
  // `minimax_api` is what keeps a user-typed short id out of a phantom
  // group; the `i <= 0` guard is what keeps a leading `/` from
  // producing an empty provider key.
  const PROVIDER_CASES = [
    ["minimax_api/MiniMax-M3", "minimax_api", "minimax_api"],
    ["nousresearch/deepseek/x", "minimax_api", "nousresearch"],
    ["/leading-slash", "minimax_api", "minimax_api"],
    ["MiniMax-M3", "minimax_api", "minimax_api"],
    ["", "minimax_api", "minimax_api"],
    [null, "minimax_api", "minimax_api"],
    [undefined, "minimax_api", "minimax_api"],
    // An explicit fallback is honoured for a bare id and for an empty
    // one — the engine builtin provider is a DEFAULT, not a constant.
    ["minimax_api/MiniMax-M3", "fallback-provider", "minimax_api"],
    ["", "fallback-provider", "fallback-provider"],
    [null, "fallback-provider", "fallback-provider"],
  ];
  for (const [modelId, fallback, expected] of PROVIDER_CASES) {
    test(`providerOfModelId(${JSON.stringify(modelId)}, ${JSON.stringify(fallback)}) → ${expected}`, () => {
      assert.equal(engine.providerOfModelId(modelId, fallback), expected);
    });
  }

  // The webui id is ALWAYS two segments, even when the upstream model
  // id already contains `/`. That is ticket 09-02: skipping the prefix
  // put the picker in the wrong group and let overlapping upstream ids
  // collide on the dedupe.
  const ID_CASES = [
    ["minimax_api", "MiniMax-M3", "minimax_api/MiniMax-M3"],
    ["nousresearch", "z-ai/glm-5.3", "nousresearch/z-ai/glm-5.3"],
    ["minimax_api", "MiniMax-M2.7-highspeed", "minimax_api/MiniMax-M2.7-highspeed"],
  ];
  for (const [providerKey, modelId, expected] of ID_CASES) {
    test(`webuiFullModelId(${providerKey}, ${modelId})`, () => {
      assert.equal(engine.webuiFullModelId(providerKey, modelId), expected);
    });
  }
});

describe("attachContextWindowOptions", () => {
  // Table-driven. Each row is a rule with a failure mode: a missing
  // projection must leave the entry field-free (so the composer mounts
  // no control), an existing `contextLimit` must NOT be overwritten (a
  // config layer's value wins), and both the array and the hints object
  // must be COPIED so a caller mutating the entry cannot corrupt the
  // engine projection for the next entry.
  const entry = () => ({ id: "x", label: "x" });
  const CASES = [
    ["no projection at all", null, {}, null],
    ["options only", { options: [1, 2] }, {}, { contextWindowOptions: [1, 2] }],
    [
      "options + currentLimit, entry has no limit",
      { options: [1, 2], currentLimit: 9 },
      {},
      { contextWindowOptions: [1, 2], contextLimit: 9 },
    ],
    [
      "options + currentLimit, entry KEEPS its own limit",
      { options: [1, 2], currentLimit: 9 },
      { contextLimit: 5 },
      { contextWindowOptions: [1, 2] },
    ],
    [
      "hints ride along only when present",
      { options: [1, 2], hints: { 2: "higher_usage" } },
      {},
      { contextWindowOptions: [1, 2], contextWindowOptionHints: { 2: "higher_usage" } },
    ],
    [
      "currentLimit of 0 is still attached (the projection decided)",
      { options: [1], currentLimit: 0 },
      {},
      { contextWindowOptions: [1], contextLimit: 0 },
    ],
  ];
  for (const [name, projection, pre, expected] of CASES) {
    test(name, () => {
      const e = { ...entry(), ...pre };
      engine.attachContextWindowOptions(e, projection);
      assert.deepEqual(e, { ...entry(), ...pre, ...expected });
    });
  }

  test("the array and the hints are copies, not aliases of the projection", () => {
    const projection = { options: [1, 2], hints: { 1: "higher_usage" } };
    const e = {};
    engine.attachContextWindowOptions(e, projection);
    e.contextWindowOptions.push(3);
    e.contextWindowOptionHints[1] = "tampered";
    assert.deepEqual(projection.options, [1, 2]);
    assert.deepEqual(projection.hints, { 1: "higher_usage" });
  });
});

// ---------------------------------------------------------------------------
// 4. The projections, rule by rule
// ---------------------------------------------------------------------------

const THINKING_M3 = new Map([["MiniMax-M3", { levels: ["off", "on"] }]]);
const WINDOWS_M3 = new Map([
  ["MiniMax-M3", { options: [512000, 1000000], hints: { 1000000: "higher_usage" }, currentLimit: 512000 }],
]);

describe("projectModelCatalogue — grouping, dedupe and the empty shell", () => {
  // Table-driven: [name, options, expected]. `list` and `groups` are the
  // ordered id lists, written out longhand rather than recomputed.
  const wire = parseEngineModelWireValue;
  const CASES = [
    [
      "no sources at all: the empty builtin shell is dropped, list is empty",
      { providers: null, builtins: [], sessionOption: null },
      { list: [], groups: [] },
    ],
    [
      "a providers config with no models still emits its (empty) group",
      { providers: { providers: [{ id: "p", label: "P", models: [] }] }, builtins: [] },
      {
        list: [],
        groups: ["p", "minimax_api"],
        group: { id: "p", label: "P", auth: { hasKey: false, type: "byok" }, protocol: "openai", models: [] },
      },
    ],
    [
      "a providers config with no models KEEPS the empty builtin shell next to it",
      { providers: { providers: [{ id: "p", models: [] }] }, builtins: ["MiniMax-M3"] },
      { list: ["minimax_api/MiniMax-M3"], groups: ["p", "minimax_api"] },
    ],
    [
      "a builtin is attributed to minimax_api, and only to it",
      { providers: null, builtins: ["MiniMax-M3"] },
      { list: ["minimax_api/MiniMax-M3"], groups: ["minimax_api"] },
    ],
    [
      "a config entry COLLIDING with a builtin wins wholesale",
      {
        providers: { providers: [{ id: "minimax_api", models: [{ id: "MiniMax-M3", label: "override" }] }] },
        builtins: ["MiniMax-M3"],
      },
      { list: ["minimax_api/MiniMax-M3"], groups: ["minimax_api"], labels: { "minimax_api/MiniMax-M3": "override" } },
    ],
    [
      "two providers with the same upstream model id stay distinct",
      {
        providers: {
          providers: [
            { id: "nousresearch", models: [{ id: "z-ai/glm-5.3" }] },
            { id: "zai-max", models: [{ id: "z-ai/glm-5.3" }] },
          ],
        },
        builtins: [],
      },
      { list: ["nousresearch/z-ai/glm-5.3", "zai-max/z-ai/glm-5.3"], groups: ["nousresearch", "zai-max", "minimax_api"] },
    ],
    [
      "an engine option with an empty value list yields NO group",
      { sessionOption: { options: [] }, providers: null, builtins: [] },
      { list: [], groups: [] },
    ],
    [
      "entries with no usable value are skipped; a duplicate value is deduped",
      {
        sessionOption: { options: [{ value: "a" }, { value: null }, null, { value: "a" }] },
        providers: null,
        builtins: [],
      },
      { list: ["a"], groups: ["__engine"] },
    ],
  ];
  for (const [name, options, expected] of CASES) {
    test(name, () => {
      const { list, groups } = engine.projectModelCatalogue({
        ...options,
        parseEngineModelWireValue: wire,
      });
      assert.deepEqual(list.map((e) => e.id), expected.list, "flat list");
      assert.deepEqual(groups.map((g) => g.id), expected.groups, "group ids");
      if (expected.group) {
        assert.deepEqual(groups.find((g) => g.id === expected.group.id), expected.group);
      }
      if (expected.labels) {
        for (const [id, label] of Object.entries(expected.labels)) {
          assert.equal(list.find((e) => e.id === id).label, label);
        }
      }
    });
  }

  test("a builtin already present from the config layer is deduped, not appended twice", () => {
    // The `seen` set is per `(providerKey, modelId)`, and it is what keeps
    // the picker from showing `MiniMax-M3` twice when the operator has
    // configured the same builtin id. Removing the check on the builtin
    // side would duplicate the row in BOTH the flat list and the group.
    const { list, groups } = engine.projectModelCatalogue({
      providers: { providers: [{ id: "minimax_api", models: [{ id: "MiniMax-M3", label: "config" }] }] },
      builtins: ["MiniMax-M3", "MiniMax-M3"],
      parseEngineModelWireValue: wire,
    });
    assert.deepEqual(list.map((e) => e.id), ["minimax_api/MiniMax-M3"]);
    assert.deepEqual(groups.find((g) => g.id === "minimax_api").models.map((e) => e.id), [
      "minimax_api/MiniMax-M3",
    ]);
    // And the surviving entry is the CONFIG one — the operator's layer
    // wins wholesale, it does not merge with the builtin.
    assert.equal(list[0].source, "config");
    assert.equal(list[0].label, "config");
    assert.equal("thinkingLevels" in list[0], false);
  });

  test("the engine group id and label are the endpoint's, not the provider's", () => {
    const { groups } = engine.projectModelCatalogue({
      sessionOption: MODEL_OPTION,
      providers: null,
      builtins: [],
      parseEngineModelWireValue: wire,
    });
    assert.equal(groups.length, 1);
    assert.equal(groups[0].id, "__engine");
    assert.equal(groups[0].label, "Engine session");
    // The engine group carries NO auth block — a session option is not
    // a provider the operator configured.
    assert.equal("auth" in groups[0], false);
    assert.equal("protocol" in groups[0], false);
  });

  test("engine-session entries carry BOTH `name` and `label`, and the same value", () => {
    // Pre-existing callers (the composer chip) read `name`; the
    // provider-grouped panel reads `label`. Dropping either is a
    // frontend break that a single-key test would miss.
    const { list } = engine.projectModelCatalogue({
      sessionOption: MODEL_OPTION,
      providers: null,
      builtins: [],
      parseEngineModelWireValue: wire,
    });
    for (const e of list) {
      assert.equal(e.name, e.label);
      assert.equal(typeof e.name, "string");
    }
    // And an option with no `name` falls back to the value itself.
    const { list: l2 } = engine.projectModelCatalogue({
      sessionOption: { options: [{ value: "m:x:y:u" }] },
      providers: null,
      builtins: [],
      parseEngineModelWireValue: () => null,
    });
    assert.equal(l2[0].name, "m:x:y:u");
    assert.equal(l2[0].label, "m:x:y:u");
  });

  test("the config group reports hasKey from EITHER signal, and never a key", () => {
    // The security contract: the group reports whether a key is
    // configured, never the key. Both signals mean "configurable from
    // the picker" — a webui-side plaintext apiKey and an engine-side
    // boolean alike.
    const { groups } = engine.projectModelCatalogue({
      providers: {
        providers: [
          { id: "webui-key", auth: { apiKey: "sk-secret" }, models: [] },
          { id: "engine-key", auth: { hasKey: true }, models: [] },
          { id: "no-key", auth: { hasKey: false }, models: [] },
          { id: "no-auth", models: [] },
        ],
      },
      builtins: [],
      parseEngineModelWireValue: wire,
    });
    // The empty `minimax_api` shell is also a group and has no `auth`,
    // so the comparison is over the four CONFIG groups.
    const byId = Object.fromEntries(groups.filter((g) => g.auth).map((g) => [g.id, g.auth]));
    assert.deepEqual(byId, {
      "webui-key": { hasKey: true, type: "byok" },
      "engine-key": { hasKey: true, type: "byok" },
      "no-key": { hasKey: false, type: "byok" },
      "no-auth": { hasKey: false, type: "byok" },
    });
    // And the secret itself is nowhere in the group.
    assert.equal(JSON.stringify(groups).includes("sk-secret"), false);
  });

  test("contextLimit rides along only for a positive number", () => {
    const { list } = engine.projectModelCatalogue({
      providers: {
        providers: [
          { id: "p", models: [{ id: "a", contextLimit: 1000 }, { id: "b", contextLimit: 0 }, { id: "c", contextLimit: -5 }] },
        ],
      },
      builtins: [],
      parseEngineModelWireValue: wire,
    });
    assert.equal("contextLimit" in list.find((e) => e.id === "p/a"), true);
    assert.equal("contextLimit" in list.find((e) => e.id === "p/b"), false);
    assert.equal("contextLimit" in list.find((e) => e.id === "p/c"), false);
  });

  test("empty thinkingLevels / modalities are omitted, not sent as []", () => {
    // An empty array would make a consumer mount a control with no
    // choices; the endpoint has always omitted the key.
    const { list } = engine.projectModelCatalogue({
      providers: {
        providers: [{ id: "p", models: [{ id: "a", thinkingLevels: [], modalities: [] }, { id: "b", thinkingLevels: ["x"], modalities: ["text"] }] }],
      },
      builtins: [],
      parseEngineModelWireValue: wire,
    });
    assert.deepEqual(Object.keys(list[0]), ["id", "label", "provider", "source"]);
    assert.deepEqual(list[1].thinkingLevels, ["x"]);
    assert.deepEqual(list[1].modalities, ["text"]);
  });
});

describe("deriveModelSelection — the three derived figures", () => {
  // Table-driven. Each row is a resolution rule, including the two
  // "never invent" rules (a null `current`, a null window) that the
  // composer depends on to render a neutral chip.
  const entry = (id, contextLimit) => (contextLimit === undefined ? { id } : { id, contextLimit });
  const CASES = [
    [
      "the engine's currentValue wins over the recorded name",
      { sessionOption: { currentValue: "wire" }, cs: { model: { name: "recorded" } } },
      { current: "wire", currentThinking: null, currentContextWindow: null },
    ],
    [
      "the recorded name is the fallback, and null when there is none",
      { sessionOption: null, cs: { model: { name: "recorded" } } },
      { current: "recorded", currentThinking: null, currentContextWindow: null },
    ],
    [
      "no engine value and no record → null, never a default model",
      { sessionOption: null, cs: {} },
      { current: null, currentThinking: null, currentContextWindow: null },
    ],
    [
      "the engine's thinkingEffort wins over the recorded level",
      { cs: { configOptions: [{ id: "thinkingEffort", currentValue: "high" }], model: { thinking: "low" } } },
      { currentThinking: "high" },
    ],
    [
      "the recorded level is the fallback",
      { cs: { model: { thinking: "low" } } },
      { currentThinking: "low" },
    ],
    [
      "a non-string recorded level is ignored, not coerced",
      { cs: { model: { thinking: 7 } } },
      { currentThinking: null },
    ],
    [
      "a non-string engine level falls through to the record",
      { cs: { configOptions: [{ id: "thinkingEffort", currentValue: 7 }], model: { thinking: "low" } } },
      { currentThinking: "low" },
    ],
    [
      "the recorded window wins over the catalogue limit",
      { cs: { model: { name: "m", contextWindow: 1000000 } }, list: [entry("m", 512000)] },
      { currentContextWindow: 1000000 },
    ],
    [
      "the current model's catalogue limit is the fallback",
      { cs: { model: { name: "m" } }, list: [entry("m", 512000)] },
      { currentContextWindow: 512000 },
    ],
    [
      "a recorded window is reported even when the model no longer advertises it",
      { cs: { model: { name: "m", contextWindow: 1000000 } }, list: [entry("m")] },
      { currentContextWindow: 1000000 },
    ],
    [
      "a non-positive or non-integer recorded window is not a window",
      { cs: { model: { name: "m", contextWindow: 0 } }, list: [entry("m", 512000)] },
      { currentContextWindow: 512000 },
    ],
    [
      "a model with no limit and no record → null",
      { cs: { model: { name: "m" } }, list: [entry("m")] },
      { currentContextWindow: null },
    ],
  ];
  for (const [name, options, expected] of CASES) {
    test(name, () => {
      const got = engine.deriveModelSelection({ list: [], ...options });
      for (const [k, v] of Object.entries(expected)) assert.equal(got[k], v, k);
    });
  }

  test("the result has exactly the three figures, in order", () => {
    assert.deepEqual(
      Object.keys(engine.deriveModelSelection({ cs: {}, list: [] })),
      ["current", "currentThinking", "currentContextWindow"],
    );
  });
});

describe("catalogueSourceLabel", () => {
  // Table-driven. The label is the endpoint's answer to "which layer
  // won", and it keys off the OPTION LIST's length, not off the
  // option's existence — an engine that advertises the option with no
  // choices has not contributed anything.
  const CASES = [
    [{ sessionOption: { options: [{ value: "a" }] }, providers: null }, "acp-session-config"],
    [{ sessionOption: { options: [] }, providers: null }, "mcode-cli-bundle"],
    [{ sessionOption: null, providers: { providers: [] } }, "config+mcode-cli-bundle"],
    [{ sessionOption: null, providers: null }, "mcode-cli-bundle"],
    [{}, "mcode-cli-bundle"],
  ];
  for (const [options, expected] of CASES) {
    test(`${JSON.stringify(options).slice(0, 60)} → ${expected}`, () => {
      assert.equal(engine.catalogueSourceLabel(options), expected);
    });
  }
});

// ---------------------------------------------------------------------------
// 5. THE FULL SNAPSHOT — the red line
// ---------------------------------------------------------------------------

describe("readEngineModelCatalogue — the full projection, end to end", () => {
  /**
   * The response body the PRE-refactor `routes/model.js#handleGetModels`
   * produced for the fixture above, captured from the implementation at
   * 3362c9be and pasted in longhand. Not recomputed by the functions
   * under test.
   *
   * Read it as the batch's contract, in this order:
   *
   *   - 2 engine-session entries FIRST, under `__engine`, ids kept in
   *     the engine's wire form so `POST /api/set-model` round-trips —
   *     and BOTH annotated from the builtin tree, because the wire
   *     form's model segment is the bare engine model key. This is the
   *     second of the two annotation sites, and the only place the
   *     snapshot shows both of them at once.
   *   - 2 providers projected from the engine's `custom_provider` tree
   *     (`deepseek-cn`, `nousresearch`), each with `auth.hasKey`
   *     answering the engine's own `options.apiKey` (true / false) and
   *     `protocol` mapped from the engine's `api` (openai / openai).
   *   - 3 webui config entries, including `minimax_api/MiniMax-M3` with
   *     the operator's label and `contextLimit` — the entry that TOOK
   *     the builtin's slot, which is why the builtin `MiniMax-M3` is
   *     absent below and carries no `thinkingLevels` and no
   *     `contextWindowOptions`.
   *   - 3 surviving builtins: the effort-list model with its context
   *     windows, and the two bare ones. `MiniMax-M2.5` is the
   *     forced_on model — the engine's tree has nothing user-settable,
   *     so the entry stays field-free and the composer mounts no
   *     control.
   *   - The three derived figures, and the `source` label.
   */
const EXPECTED = {
  ok: true,
  models: [
      {"id": "m:minimax_api:MiniMax-M3:v:thinking", "name": "MiniMax-M3", "label": "MiniMax-M3", "provider": "minimax_api", "source": "engine", "thinkingLevels": ["off", "on"], "contextWindowOptions": [512000, 1000000], "contextWindowOptionHints": {"1000000": "higher_usage"}, "contextLimit": 512000},
      {"id": "m:minimax_api:MiniMax-M2.7:u", "name": "MiniMax-M2.7", "label": "MiniMax-M2.7", "provider": "minimax_api", "source": "engine", "thinkingLevels": ["low", "medium", "high"], "contextWindowOptions": [128000, 256000], "contextLimit": 128000},
      {"id": "deepseek-cn/deepseek-chat", "label": "DeepSeek Chat", "provider": "deepseek-cn", "source": "config", "contextLimit": 64000, "protocol": "openai", "thinkingLevels": ["low", "high"], "modalities": ["text", "image"]},
      {"id": "deepseek-cn/deepseek-reasoner", "label": "deepseek-reasoner", "provider": "deepseek-cn", "source": "config", "protocol": "openai"},
      {"id": "nousresearch/z-ai/glm-5.3", "label": "z-ai/glm-5.3", "provider": "nousresearch", "source": "config", "protocol": "openai"},
      {"id": "nousresearch/openai/gpt-5.6-sol", "label": "openai/gpt-5.6-sol", "provider": "nousresearch", "source": "config", "protocol": "openai"},
      {"id": "minimax_api/MiniMax-M3", "label": "M3 config override", "provider": "minimax_api", "source": "config", "contextLimit": 123456, "protocol": "anthropic"},
      {"id": "minimax_api/MiniMax-Text-01", "label": "MiniMax-Text-01", "provider": "minimax_api", "source": "config", "protocol": "anthropic", "thinkingLevels": ["off", "on"], "modalities": ["text", "image"]},
      {"id": "local-ollama/qwen3:8b", "label": "qwen3:8b", "provider": "local-ollama", "source": "config", "protocol": "openai"},
      {"id": "minimax_api/MiniMax-M2.7", "label": "MiniMax-M2.7", "provider": "minimax_api", "source": "builtin", "thinkingLevels": ["low", "medium", "high"], "contextWindowOptions": [128000, 256000], "contextLimit": 128000},
      {"id": "minimax_api/MiniMax-M2.5", "label": "MiniMax-M2.5", "provider": "minimax_api", "source": "builtin"},
      {"id": "minimax_api/MiniMax-M2.7-highspeed", "label": "MiniMax-M2.7-highspeed", "provider": "minimax_api", "source": "builtin"},
    ],
    groups: [
      { ...{"id": "__engine", "label": "Engine session"}, models: [
        {"id": "m:minimax_api:MiniMax-M3:v:thinking", "name": "MiniMax-M3", "label": "MiniMax-M3", "provider": "minimax_api", "source": "engine", "thinkingLevels": ["off", "on"], "contextWindowOptions": [512000, 1000000], "contextWindowOptionHints": {"1000000": "higher_usage"}, "contextLimit": 512000},
        {"id": "m:minimax_api:MiniMax-M2.7:u", "name": "MiniMax-M2.7", "label": "MiniMax-M2.7", "provider": "minimax_api", "source": "engine", "thinkingLevels": ["low", "medium", "high"], "contextWindowOptions": [128000, 256000], "contextLimit": 128000},
      ] },
      { ...{"id": "deepseek-cn", "label": "deepseek-cn", "auth": {"hasKey": true, "type": "byok"}, "protocol": "openai"}, models: [
        {"id": "deepseek-cn/deepseek-chat", "label": "DeepSeek Chat", "provider": "deepseek-cn", "source": "config", "contextLimit": 64000, "protocol": "openai", "thinkingLevels": ["low", "high"], "modalities": ["text", "image"]},
        {"id": "deepseek-cn/deepseek-reasoner", "label": "deepseek-reasoner", "provider": "deepseek-cn", "source": "config", "protocol": "openai"},
      ] },
      { ...{"id": "nousresearch", "label": "nousresearch", "auth": {"hasKey": false, "type": "byok"}, "protocol": "openai"}, models: [
        {"id": "nousresearch/z-ai/glm-5.3", "label": "z-ai/glm-5.3", "provider": "nousresearch", "source": "config", "protocol": "openai"},
        {"id": "nousresearch/openai/gpt-5.6-sol", "label": "openai/gpt-5.6-sol", "provider": "nousresearch", "source": "config", "protocol": "openai"},
      ] },
      { ...{"id": "minimax_api", "label": "MiniMax builtins", "auth": {"hasKey": true, "type": "byok"}, "protocol": "anthropic"}, models: [
        {"id": "minimax_api/MiniMax-M3", "label": "M3 config override", "provider": "minimax_api", "source": "config", "contextLimit": 123456, "protocol": "anthropic"},
        {"id": "minimax_api/MiniMax-Text-01", "label": "MiniMax-Text-01", "provider": "minimax_api", "source": "config", "protocol": "anthropic", "thinkingLevels": ["off", "on"], "modalities": ["text", "image"]},
        {"id": "minimax_api/MiniMax-M2.7", "label": "MiniMax-M2.7", "provider": "minimax_api", "source": "builtin", "thinkingLevels": ["low", "medium", "high"], "contextWindowOptions": [128000, 256000], "contextLimit": 128000},
        {"id": "minimax_api/MiniMax-M2.5", "label": "MiniMax-M2.5", "provider": "minimax_api", "source": "builtin"},
        {"id": "minimax_api/MiniMax-M2.7-highspeed", "label": "MiniMax-M2.7-highspeed", "provider": "minimax_api", "source": "builtin"},
      ] },
      { ...{"id": "local-ollama", "label": "local-ollama", "auth": {"hasKey": false, "type": "byok"}, "protocol": "openai"}, models: [
        {"id": "local-ollama/qwen3:8b", "label": "qwen3:8b", "provider": "local-ollama", "source": "config", "protocol": "openai"},
      ] },
    ],
    current: "m:minimax_api:MiniMax-M3:v:thinking",
    currentThinking: "high",
    currentContextWindow: 1000000,
    source: "acp-session-config",
  };

  test("the payload is the pre-refactor body, field for field and key for key", () => {
    const read = engine.readEngineModelCatalogue({ cs: SNAPSHOT_CS, transport: RUNTIME });
    assert.equal(read.source, "config");
    assert.equal(read.gate.gate, "checked");
    assert.deepEqual(read.payload, EXPECTED);
  });

  test("the payload's key order is the endpoint's", () => {
    // A key-set check alone lets a body that carries the right fields
    // in a different order pass; JSON key order is what a snapshot
    // diff and a careless consumer both depend on.
    const read = engine.readEngineModelCatalogue({ cs: SNAPSHOT_CS, transport: RUNTIME });
    assert.deepEqual(Object.keys(read.payload), [
      "ok",
      "models",
      "groups",
      "current",
      "currentThinking",
      "currentContextWindow",
      "source",
    ]);
  });

  test("the projection is DETERMINISTIC — two reads are deep-equal", () => {
    // Every source is re-read per call, so a read that leaked state
    // between calls (a shared `seen` set, a mutated projection) would
    // show up here and nowhere else.
    const a = engine.readEngineModelCatalogue({ cs: SNAPSHOT_CS, transport: RUNTIME });
    const b = engine.readEngineModelCatalogue({ cs: SNAPSHOT_CS, transport: RUNTIME });
    assert.deepEqual(a.payload, b.payload);
  });

  test("the `minimax_api` group is the builtins' group, and the config entry took the slot", () => {
    // The two facts red line five is really about: grouping is BY
    // PROVIDER, and the dedupe is per provider, so an operator's
    // override of a builtin id does not leave two `MiniMax-M3` rows in
    // the picker.
    const { payload } = engine.readEngineModelCatalogue({ cs: SNAPSHOT_CS, transport: RUNTIME });
    const group = payload.groups.find((g) => g.id === "minimax_api");
    const ids = group.models.map((m) => m.id);
    assert.deepEqual(ids, [
      "minimax_api/MiniMax-M3",
      "minimax_api/MiniMax-Text-01",
      "minimax_api/MiniMax-M2.7",
      "minimax_api/MiniMax-M2.5",
      "minimax_api/MiniMax-M2.7-highspeed",
    ]);
    assert.equal(new Set(ids).size, ids.length, "no id may appear twice in a group");
    // Every group holds the SAME entry objects as the flat list — a
    // second copy would let the picker and the chip disagree.
    for (const g of payload.groups) {
      for (const m of g.models) {
        assert.equal(payload.models.includes(m), true, `${m.id} is not the same object as the flat entry`);
      }
    }
  });

  test("no apiKey ever reaches the payload", () => {
    // The security contract, end to end: the engine stores its key in
    // plaintext and the webui stores one too, and neither may travel.
    const { payload } = engine.readEngineModelCatalogue({ cs: SNAPSHOT_CS, transport: RUNTIME });
    const serialised = JSON.stringify(payload);
    assert.equal(serialised.includes("sk-secret-should-never-leak"), false);
    assert.equal(serialised.includes("sk-webui-fixture-key-0001"), false);
    assert.equal(serialised.includes("apiKey"), false);
  });

  test("an empty catalogue answers the soft marker LAST, not an error", () => {
    // The endpoint's long-standing hint: with no engine tree, no
    // providers config and no builtins, the picker renders "nothing
    // attached" and the caller still gets `ok:true` — plus `reason`,
    // which is spread AFTER `source` so a consumer reading the body
    // positionally sees the same order as on a populated catalogue.
    //
    // Every source is re-read per call, so pointing the three env vars
    // at empty directories for the duration of ONE call is enough; no
    // module reload and no test-ordering constraint.
    const emptyEngine = mkTmpDir("webui-model-reads-", { parent: root });
    const emptyWebui = mkTmpDir("webui-model-reads-", { parent: root });
    const prev = {
      engine: process.env.MINIMAX_DATA_DIR,
      webui: process.env.MCODE_WEBUI_DATA_DIR,
      config: process.env.MCODE_WEBUI_MODELS_CONFIG,
    };
    process.env.MINIMAX_DATA_DIR = emptyEngine;
    process.env.MCODE_WEBUI_DATA_DIR = emptyWebui;
    process.env.MCODE_WEBUI_MODELS_CONFIG = join(emptyWebui, "absent.json");
    try {
      setBuiltinModelsMock([]);
      const read = engine.readEngineModelCatalogue({ cs: {}, transport: RUNTIME });
      assert.deepEqual(read.payload, {
        ok: true,
        models: [],
        groups: [],
        current: null,
        currentThinking: null,
        currentContextWindow: null,
        source: "mcode-cli-bundle",
        reason: "no_catalogue",
      });
      assert.deepEqual(Object.keys(read.payload), [
        "ok",
        "models",
        "groups",
        "current",
        "currentThinking",
        "currentContextWindow",
        "source",
        "reason",
      ]);
      // And the soft gate still reports — a soft gate is not a missing
      // gate.
      assert.equal(read.gate.gate, "checked");
    } finally {
      process.env.MINIMAX_DATA_DIR = prev.engine;
      process.env.MCODE_WEBUI_DATA_DIR = prev.webui;
      process.env.MCODE_WEBUI_MODELS_CONFIG = prev.config;
      setBuiltinModelsMock(BUILTINS);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Variant / context perturbation — which input moves which annotation
// ---------------------------------------------------------------------------

describe("the variant and context projections are two views of ONE engine read", () => {
  // The engine tree is read twice per request — once for thinking, once
  // for context windows — and both are consumed at two sites (the
  // engine-session entries and the builtin shell). The failure this
  // section exists for is a CROSS-WIRING: one annotation attached to the
  // wrong entry, or the two sites disagreeing about the same model.
  test("the two real readers agree on the set of models they know", () => {
    const thinking = readEngineBuiltinThinking();
    const windows = readEngineBuiltinContextWindows();
    // Same keys, same order — the two readers project the same record.
    assert.deepEqual([...thinking.keys()], [...windows.keys()]);
    assert.deepEqual([...thinking.keys()], ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.5"]);
  });

  // Table-driven: [model, expected thinkingLevels-or-undefined,
  // expected contextWindowOptions-or-undefined, expected contextLimit-or-undefined].
  // Each row is one engine record; the projection must attach EXACTLY
  // what that record says, and a record with nothing user-settable
  // (the forced_on `MiniMax-M2.5`) must stay field-free.
  const TABLE = [
    ["MiniMax-M3", ["off", "on"], [512000, 1000000], 512000],
    ["MiniMax-M2.7", ["low", "medium", "high"], [128000, 256000], 128000],
    ["MiniMax-M2.5", undefined, undefined, undefined],
    ["not-in-the-tree", undefined, undefined, undefined],
  ];
  for (const [model, levels, options, limit] of TABLE) {
    test(`${model}: levels=${JSON.stringify(levels)} windows=${JSON.stringify(options)}`, () => {
      const { list } = engine.projectModelCatalogue({
        providers: null,
        builtins: [model],
        builtinThinking: readEngineBuiltinThinking(),
        builtinContextWindows: readEngineBuiltinContextWindows(),
        parseEngineModelWireValue,
      });
      const entry = list[0];
      if (levels === undefined) assert.equal("thinkingLevels" in entry, false);
      else assert.deepEqual(entry.thinkingLevels, levels);
      if (options === undefined) assert.equal("contextWindowOptions" in entry, false);
      else assert.deepEqual(entry.contextWindowOptions, options);
      if (limit === undefined) assert.equal("contextLimit" in entry, false);
      else assert.equal(entry.contextLimit, limit);
    });
  }

  test("the same annotations reach the ENGINE-SESSION site, keyed by the wire form's model id", () => {
    // The two annotation sites exist because the engine's ACP `model`
    // option advertises wire ids, not bare ids. If the lookup used the
    // wire VALUE instead of the parsed model id, a cross-client model
    // change would silently lose the composer's controls.
    // A wire form whose MODEL SEGMENT is the bare builtin id — which is
    // what the engine emits for `provider.minimax.models` entries. A
    // wire form whose model segment is itself prefixed (or one that
    // does not parse at all) misses the builtin tree, and the entry
    // stays field-free; that is a miss, not a crash.
    const { list } = engine.projectModelCatalogue({
      sessionOption: { options: [{ value: "m:minimax_api:MiniMax-M3:v:thinking", name: "MiniMax-M3" }, { value: "m:minimax_api:MiniMax-M2.7:u", name: "MiniMax-M2.7" }] },
      providers: null,
      builtins: [],
      builtinThinking: THINKING_M3,
      builtinContextWindows: WINDOWS_M3,
      parseEngineModelWireValue,
    });
    const m3 = list.find((e) => e.id.includes("MiniMax-M3"));
    assert.deepEqual(m3.thinkingLevels, ["off", "on"]);
    assert.deepEqual(m3.contextWindowOptions, [512000, 1000000]);
    assert.deepEqual(m3.contextWindowOptionHints, { 1000000: "higher_usage" });
    // A model that is NOT in the tree gets nothing: the BARE id is
    // looked up, and a miss is a miss rather than a partial annotation.
    const m27 = list.find((e) => e.id.includes("MiniMax-M2.7"));
    assert.equal("thinkingLevels" in m27, false);
    assert.equal("contextWindowOptions" in m27, false);
  });

  test("a non-minimax wire form is never annotated from the minimax builtin tree", () => {
    // The engine-session annotation is gated on the wire form's
    // providerId. A BYOK provider that happens to have a model id
    // colliding with a builtin name must not inherit the builtin's
    // context windows.
    const { list } = engine.projectModelCatalogue({
      sessionOption: { options: [{ value: "m:nousresearch%3Anousresearch%2FMiniMax-M3:u", name: "x" }] },
      providers: null,
      builtins: [],
      builtinThinking: THINKING_M3,
      builtinContextWindows: WINDOWS_M3,
      parseEngineModelWireValue,
    });
    assert.deepEqual(Object.keys(list[0]), ["id", "name", "label", "provider", "source"]);
  });
});

// ---------------------------------------------------------------------------
// 7. The route
// ---------------------------------------------------------------------------

describe("handleGetModels — the route asks the facade", () => {
  // No `setupMocks` in these cases: the file-level `before` hook already
  // registered the shared mocks, and node:test's file-level `before` and
  // its subtests share ONE MockTracker — a second `setupMocks` here is
  // ERR_INVALID_STATE ("already mocked"), not a re-registration.
  let bust = 0;
  const loadRoute = async () => import(`${absPath("routes/model.js")}?bust=${bust++}`);

  // `mock.module` REPLACES the whole namespace, so a partial mock makes
  // the route fail to instantiate on the exports it did not stub.
  const NOT_STUBBED = (name) => async () => {
    throw new Error(`B4 test called ${name}, which this case did not stub`);
  };
  function mockFacade(t, overrides) {
    t.mock.module(absPath("engine/model-reads.js"), {
      namedExports: { readEngineModelCatalogue: NOT_STUBBED("readEngineModelCatalogue"), ...overrides },
    });
  }

  function mkRes() {
    const written = [];
    return {
      written,
      writeHead(status, headers) {
        written.push({ status, headers });
        return this;
      },
      end(body) {
        written.push({ body });
        return this;
      },
    };
  }

  test("the handler is still SYNCHRONOUS — the body is complete when it returns", () => {
    // The route's signature is part of its contract: an async handler
    // would leave `res._body` null for any caller that does not await,
    // and the pre-M3 handler was sync. This is the assertion that keeps
    // the next reader from "simplifying" the facade to an async one.
    const res = mkRes();
    const returned = modelRouteBaseline.handleGetModels(null, res, { cs: SNAPSHOT_CS });
    assert.equal(typeof returned.then, "undefined");
    assert.equal(res.written.length, 2);
    assert.equal(res.written[0].status, 200);
  });

  test("the response body is the facade's payload, byte-for-byte", async (t) => {
    const payload = { ok: true, models: [], groups: [], current: null, currentThinking: null, currentContextWindow: null, source: "mcode-cli-bundle" };
    mockFacade(t, { readEngineModelCatalogue: () => ({ payload, source: "config", gate: {}, transport: RUNTIME }) });
    const route = await loadRoute();
    const res = mkRes();
    await route.handleGetModels(null, res, { cs: {} });
    assert.equal(res.written[0].headers["Content-Type"], "application/json; charset=utf-8");
    assert.equal(res.written[1].body, JSON.stringify(payload));
  });

  test("the route hands its ctx through and does not read cs itself", async (t) => {
    const seen = [];
    mockFacade(t, {
      readEngineModelCatalogue: (o) => {
        seen.push(o);
        return { payload: { ok: true, models: [], groups: [], current: null, currentThinking: null, currentContextWindow: null, source: "mcode-cli-bundle" }, source: "config", gate: {}, transport: RUNTIME };
      },
    });
    const route = await loadRoute();
    for (const ctx of [{ cs: SNAPSHOT_CS }, { cs: null }, undefined, {}]) {
      await route.handleGetModels(null, mkRes(), ctx);
    }
    assert.equal(seen.length, 4);
    assert.deepEqual(seen[0].cs, SNAPSHOT_CS);
    assert.equal(seen[1].cs, null);
    assert.equal(seen[2].cs, undefined);
    assert.equal(seen[3].cs, undefined);
    for (const o of seen) assert.equal(o.endpoint, undefined);
  });

  test("a gate error PROPAGATES (it is soft, but it must not be swallowed silently)", async (t) => {
    // The model's gate never throws today, so this row pins the
    // ROUTE's half of the contract: if a future family decision makes
    // this gate hard, the route must not grow a catch that turns the
    // 501 into a silent empty catalogue — the #110 fake-success
    // failure mode, and the one this batch's soft gate exists to avoid
    // reaching for.
    const marker = new Error("model-gate-refused");
    mockFacade(t, {
      readEngineModelCatalogue: () => {
        throw marker;
      },
    });
    const route = await loadRoute();
    let caught = null;
    try {
      await route.handleGetModels(null, mkRes(), { cs: {} });
    } catch (err) {
      caught = err;
    }
    assert.equal(caught, marker);
  });

  // ---- proof the mock actually took ------------------------------------

  test("PROOF the facade mock took: a marker error escapes the untouched route", async (t) => {
    const marker = new Error("B4-MODEL-MOCK-WAS-NOT-HONOURED");
    mockFacade(t, {
      readEngineModelCatalogue: () => {
        throw marker;
      },
    });
    const route = await loadRoute();
    let caught = null;
    try {
      await route.handleGetModels(null, mkRes(), { cs: {} });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "the route swallowed the facade error — either the mock did not take, or the route grew a catch");
    assert.equal(caught, marker, "the error is the mock's, by identity");
  });

  test("CONTROL: with no facade mock, the route answers from the real projection", async (t) => {
    // The other half of the proof: a fresh `?bust=` re-import binds the
    // route to the REAL facade, so the body is the fixture projection —
    // the same one the snapshot above pins, now through the route.
    setBuiltinModelsMock(BUILTINS);
    const route = await loadRoute();
    const res = mkRes();
    await route.handleGetModels(null, res, { cs: SNAPSHOT_CS });
    const body = JSON.parse(res.written[1].body);
    assert.equal(body.ok, true);
    assert.equal(body.models.length, 12);
    assert.deepEqual(body.groups.map((g) => g.id), [
      "__engine",
      "deepseek-cn",
      "nousresearch",
      "minimax_api",
      "local-ollama",
    ]);
    assert.equal(body.current, MODEL_OPTION.currentValue);
    assert.equal(body.currentThinking, "high");
    assert.equal(body.currentContextWindow, 1000000);
    assert.equal(body.source, "acp-session-config");
  });
});
