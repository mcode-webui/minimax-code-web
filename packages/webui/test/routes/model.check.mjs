// webui/test/routes/model.check.mjs
// Unit tests for server/routes/model.js — handleGetModels, handleSetModel,
// handleSetPermissions, handleListPermissionModes, handleAnswer.
//
// Why this test exists: routes/model.js is the API surface for model selection
// + permission mode. handleSetPermissions has 5 mode mappings (ask/auto/read/
// off/full) that map webui labels to internal strings. handleListPermissionModes
// returns both webui-side and mcode-side enum values, used by the dropdown.
//
// Test strategy: USE setupMocks to mock lib/acp-client.js. Without this mock,
// pushStateFor (called inside handleSetModel) would trigger a real mcode acp
// client spawn via getMcodeSessionsForWorkspace on cache miss, hanging the test.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { setupMocks, absPath } from "../helpers/_setup.js";
import yaml from "js-yaml";

// Engine data dir isolation (ticket 06). The /api/models route reads
// the engine's `custom_provider` tree via `MINIMAX_DATA_DIR`; point
// that env at an isolated tmp dir for this test file so the route
// NEVER reads the host's real `~/.minimax/config.yaml`. Each test
// that wants a populated engine catalogue writes a fixture into
// this dir via `withEngineConfig`; tests that want an empty engine
// catalogue just leave the dir empty (readEngineCatalogue returns
// [] when config.yaml is missing).
//
// Webui data dir isolation — same hygiene for `MCODE_WEBUI_DATA_DIR`.
// The /api/models route also reads the user-level providers.json
// from this dir; the test file would otherwise leak the host's
// real config into the response. Tests that want a populated
// webui layer use `withModelsConfig` (env override) which beats
// the user-level path in precedence.
const _origMinimax = process.env.MINIMAX_DATA_DIR;
const _origMavis = process.env.MAVIS_DATA_DIR;
const _origWebuiDataDir = process.env.MCODE_WEBUI_DATA_DIR;
const _origModelsConfig = process.env.MCODE_WEBUI_MODELS_CONFIG;
const _engineDataDir = mkdtempSync(join(tmpdir(), "webui-model-engine-cat-"));
const _webuiDataDir = mkdtempSync(join(tmpdir(), "webui-model-user-level-"));
process.env.MINIMAX_DATA_DIR = _engineDataDir;
delete process.env.MAVIS_DATA_DIR;
process.env.MCODE_WEBUI_DATA_DIR = _webuiDataDir;
delete process.env.MCODE_WEBUI_MODELS_CONFIG;

after(async () => {
  if (_origMinimax === undefined) delete process.env.MINIMAX_DATA_DIR;
  else process.env.MINIMAX_DATA_DIR = _origMinimax;
  if (_origMavis === undefined) delete process.env.MAVIS_DATA_DIR;
  else process.env.MAVIS_DATA_DIR = _origMavis;
  if (_origWebuiDataDir === undefined) delete process.env.MCODE_WEBUI_DATA_DIR;
  else process.env.MCODE_WEBUI_DATA_DIR = _origWebuiDataDir;
  if (_origModelsConfig === undefined) delete process.env.MCODE_WEBUI_MODELS_CONFIG;
  else process.env.MCODE_WEBUI_MODELS_CONFIG = _origModelsConfig;
  if (_engineDataDir) rmSync(_engineDataDir, { recursive: true, force: true });
  if (_webuiDataDir) rmSync(_webuiDataDir, { recursive: true, force: true });
});

let modelRoute;
before(async (t) => {
  await setupMocks(t, {
    acp: {
      getMcodeSessionsForWorkspace: async () => [],
      getMcodeSessionsCacheSync: () => [],
      getCachedMcodeCommands: () => ({ mcode: [], webui: [], fetchedAt: 0, source: "test" }),
    },
  });
  modelRoute = await import(absPath("routes/model.js"));
});

function fakeReq(body) {
  return Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
}
function fakeRes() {
  const res = {
    _status: 200,
    _headers: {},
    _body: null,
    writeHead(s, h) {
      this._status = s;
      if (h) this._headers = h;
    },
    end(b) {
      this._body = b;
    },
  };
  return res;
}
function fakeCs(modelName = "minimax_api/MiniMax-M3", configOptions) {
  return {
    model: { name: modelName, thinking: "On", ctx: "512k" },
    permissions: "Full access",
    ...(configOptions === undefined ? {} : { configOptions }),
  };
}

/** A `model` config option, shaped like the engine's (control-state.ts#sessionModelOption). */
const MODEL_OPTION = {
  type: "select",
  id: "model",
  name: "Model",
  category: "model",
  currentValue: "minimax_api:MiniMax-M3",
  options: [
    { value: "minimax_api:MiniMax-M3", name: "MiniMax-M3" },
    { value: "minimax_api:MiniMax-M2.7", name: "MiniMax-M2.7" },
  ],
};

describe("handleGetModels — /api/models", () => {
  test("reports the engine's model config option verbatim", () => {
    const ctx = { cs: fakeCs(undefined, [MODEL_OPTION]) };
    const res = fakeRes();
    modelRoute.handleGetModels(null, res, ctx);
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.source, "acp-session-config");
    assert.deepEqual(
      body.models.map((m) => m.id),
      ["minimax_api:MiniMax-M3", "minimax_api:MiniMax-M2.7"],
    );
    // Both `name` (legacy callers) and `label` (the new provider-grouped
    // panel) carry the engine's display name.
    assert.equal(body.models[0].name, "MiniMax-M3");
    assert.equal(body.models[0].label, "MiniMax-M3");
    // The engine's encoded value, so it round-trips through /api/set-model.
    assert.equal(body.current, "minimax_api:MiniMax-M3");
    // No builtin catalogue was provided by this test, and the engine
    // already covered the catalogue — groups[] should reflect only the
    // engine source.
    assert.equal(body.groups.length, 1);
    assert.equal(body.groups[0].id, "__engine");
  });

  test("before a session exists: recorded pre-session choice surfaces as `current`", () => {
    // The engine has not named a session model yet, but `cs.model.name`
    // is a recorded pre-session choice (handleSetModel writes it).
    // That value is now surfaced as `current` instead of `null` — the
    // chip should reflect what the user has actually picked, not blank
    // out under the "no engine session" reading.
    const cs = fakeCs("minimax_api/MiniMax-M3");
    const ctx = { cs };
    const res = fakeRes();
    modelRoute.handleGetModels(null, res, ctx);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    // Mock default builtin catalogue is []; no providers config either.
    // Models list is therefore empty in this default-mock test setup.
    assert.deepEqual(body.models, []);
    assert.equal(body.current, "minimax_api/MiniMax-M3");
    // and it must not write that value back into the state a prompt would use
    assert.equal(cs.model.name, "minimax_api/MiniMax-M3");
  });
});

describe("handleSetModel — /api/set-model", () => {
  test("updates cs.model.name with the new model", async () => {
    const cs = fakeCs("minimax_api/MiniMax-M3");
    const ctx = { cs, cid: "cid-1" };
    const res = fakeRes();
    await modelRoute.handleSetModel(
      fakeReq({ model: "minimax_api/MiniMax-M2" }),
      res,
      ctx,
    );
    assert.equal(res._status, 200);
    assert.equal(cs.model.name, "minimax_api/MiniMax-M2");
  });

  test("returns 400 if model is empty", async () => {
    const cs = fakeCs();
    const ctx = { cs, cid: "cid-1" };
    const res = fakeRes();
    await modelRoute.handleSetModel(fakeReq({ model: "" }), res, ctx);
    assert.equal(res._status, 400);
  });

  test("returns 400 if model is missing", async () => {
    const cs = fakeCs();
    const ctx = { cs, cid: "cid-1" };
    const res = fakeRes();
    await modelRoute.handleSetModel(fakeReq({}), res, ctx);
    assert.equal(res._status, 400);
  });

  test("trims whitespace from the model name", async () => {
    const cs = fakeCs();
    const ctx = { cs, cid: "cid-1" };
    const res = fakeRes();
    await modelRoute.handleSetModel(
      fakeReq({ model: "  minimax_api/MiniMax-M3  " }),
      res,
      ctx,
    );
    assert.equal(cs.model.name, "minimax_api/MiniMax-M3");
  });
});

// ============================================================
// Ticket 04 — thinking-effort payload on /api/set-model.
//
// Body shape: { model: string, thinking?: string }.
//   * thinking absent → keep cs.model.thinking untouched (model-only update).
//   * thinking === "" → clear cs.model.thinking (no override).
//   * thinking === "low"/"medium"/"high"/"off" → persist + push.
// The engine contract is "model first, then thinkingEffort"; with no
// session, both writes are local + carry the warning string.
// ============================================================

import { registerRpcMock } from "../helpers/_setup.js";

describe("handleSetModel — /api/set-model thinking payload", () => {
  test("persists thinkingEffort alongside the model and pushes to the engine", async () => {
    const calls = [];
    registerRpcMock({
      setConfigOption: async (_sid, configId, value, _cid) => {
        calls.push({ configId, value });
        return { ok: true, data: {} };
      },
    });
    const cs = fakeCs("minimax_api/MiniMax-M3");
    cs.mcodeSessionId = "mvs_test";
    const ctx = { cs, cid: "cid-1" };
    const res = fakeRes();
    await modelRoute.handleSetModel(
      fakeReq({ model: "minimax_api/MiniMax-M2.7", thinking: "high" }),
      res,
      ctx,
    );
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.model, "minimax_api/MiniMax-M2.7");
    assert.equal(body.thinking, "high");
    assert.equal(body.mcodeSynced, true);
    assert.equal(body.thinkingSynced, true);
    assert.equal(cs.model.name, "minimax_api/MiniMax-M2.7");
    assert.equal(cs.model.thinking, "high");
    // Engine contract: model before effort.
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], { configId: "model", value: "minimax_api/MiniMax-M2.7" });
    assert.deepEqual(calls[1], { configId: "thinkingEffort", value: "high" });
  });

  test("thinking-only update (no model in payload) leaves cs.model.name alone", async () => {
    const calls = [];
    registerRpcMock({
      setConfigOption: async (_sid, configId, value, _cid) => {
        calls.push({ configId, value });
        return { ok: true, data: {} };
      },
    });
    const cs = fakeCs("minimax_api/MiniMax-M3");
    cs.mcodeSessionId = "mvs_test";
    const ctx = { cs, cid: "cid-1" };
    const res = fakeRes();
    await modelRoute.handleSetModel(fakeReq({ thinking: "medium" }), res, ctx);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.model, undefined, "no model field echoed");
    assert.equal(body.thinking, "medium");
    assert.equal(cs.model.name, "minimax_api/MiniMax-M3", "model untouched");
    assert.equal(cs.model.thinking, "medium");
    // Only one engine call — no model push, just the effort push.
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { configId: "thinkingEffort", value: "medium" });
  });

  test("thinking:'' clears the recorded effort", async () => {
    const calls = [];
    registerRpcMock({
      setConfigOption: async (_sid, configId, value, _cid) => {
        calls.push({ configId, value });
        return { ok: true, data: {} };
      },
    });
    const cs = fakeCs("minimax_api/MiniMax-M3");
    cs.model.thinking = "high";
    cs.mcodeSessionId = "mvs_test";
    const ctx = { cs, cid: "cid-1" };
    const res = fakeRes();
    await modelRoute.handleSetModel(fakeReq({ model: "minimax_api/MiniMax-M3", thinking: "" }), res, ctx);
    assert.equal(cs.model.thinking, "");
    // Empty effort → no engine call (the engine's default stands).
    assert.equal(calls.length, 1, "no effort push on clear");
    assert.equal(calls[0].configId, "model", "model still pushed");
  });

  test("missing model with no thinking still 400s (payload was empty)", async () => {
    const cs = fakeCs();
    const ctx = { cs, cid: "cid-1" };
    const res = fakeRes();
    await modelRoute.handleSetModel(fakeReq({}), res, ctx);
    assert.equal(res._status, 400);
  });

  test("without a session, thinking persists locally and the warning is set", async () => {
    registerRpcMock({
      setConfigOption: async () => {
        throw new Error("should not be called without a session");
      },
    });
    const cs = fakeCs("minimax_api/MiniMax-M3");
    // mcodeSessionId intentionally absent.
    const ctx = { cs, cid: "cid-1" };
    const res = fakeRes();
    await modelRoute.handleSetModel(
      fakeReq({ model: "minimax_api/MiniMax-M2.7", thinking: "low" }),
      res,
      ctx,
    );
    assert.equal(cs.model.name, "minimax_api/MiniMax-M2.7");
    assert.equal(cs.model.thinking, "low");
    const body = JSON.parse(res._body);
    assert.equal(body.mcodeSynced, false);
    assert.equal(body.thinkingSynced, false);
    assert.match(body.warning, /no mcode session/);
  });

  test("engine rejection of the effort surfaces in the response without dropping the model apply", async () => {
    const calls = [];
    registerRpcMock({
      setConfigOption: async (_sid, configId, value, _cid) => {
        calls.push({ configId, value });
        if (configId === "thinkingEffort") {
          return { ok: false, error: "Thinking effort is not advertised for the selected model: turbo" };
        }
        return { ok: true, data: {} };
      },
    });
    const cs = fakeCs("minimax_api/MiniMax-M3");
    cs.mcodeSessionId = "mvs_test";
    const ctx = { cs, cid: "cid-1" };
    const res = fakeRes();
    await modelRoute.handleSetModel(
      fakeReq({ model: "minimax_api/MiniMax-M2.7", thinking: "turbo" }),
      res,
      ctx,
    );
    assert.equal(cs.model.name, "minimax_api/MiniMax-M2.7", "model still applied");
    assert.equal(cs.model.thinking, "turbo", "local record preserved for next session boot");
    const body = JSON.parse(res._body);
    assert.equal(body.mcodeSynced, true);
    assert.equal(body.thinkingSynced, false);
    assert.match(body.warning, /turbo/);
  });

  test("engine acceptance updates cs.configOptions in lockstep (synchronous mirror)", async () => {
    registerRpcMock({
      setConfigOption: async () => ({ ok: true, data: {} }),
    });
    const cs = fakeCs("minimax_api/MiniMax-M3");
    cs.mcodeSessionId = "mvs_test";
    cs.configOptions = [
      { id: "model", type: "select", currentValue: "minimax_api/MiniMax-M3" },
      { id: "thinkingEffort", type: "select", currentValue: "low" },
    ];
    const ctx = { cs, cid: "cid-1" };
    const res = fakeRes();
    await modelRoute.handleSetModel(
      fakeReq({ model: "minimax_api/MiniMax-M3", thinking: "high" }),
      res,
      ctx,
    );
    assert.equal(cs.configOptions[0].currentValue, "minimax_api/MiniMax-M3");
    assert.equal(cs.configOptions[1].currentValue, "high");
  });
});

describe("handleSetPermissions — /api/permissions (5 mode mappings)", () => {
  test("'ask' maps to 'Ask' label", async () => {
    const cs = fakeCs();
    const ctx = { cs, cid: "cid-1" };
    const res = fakeRes();
    await modelRoute.handleSetPermissions(fakeReq({ mode: "ask" }), res, ctx);
    assert.equal(cs.permissions, "Ask");
  });

  test("'auto' maps to 'Auto' label", async () => {
    const cs = fakeCs();
    const ctx = { cs, cid: "cid-1" };
    const res = fakeRes();
    await modelRoute.handleSetPermissions(fakeReq({ mode: "auto" }), res, ctx);
    assert.equal(cs.permissions, "Auto");
  });

  test("'read' maps to 'Read' label", async () => {
    const cs = fakeCs();
    const ctx = { cs, cid: "cid-1" };
    const res = fakeRes();
    await modelRoute.handleSetPermissions(fakeReq({ mode: "read" }), res, ctx);
    assert.equal(cs.permissions, "Read");
  });

  test("'off' maps to 'Off' label", async () => {
    const cs = fakeCs();
    const ctx = { cs, cid: "cid-1" };
    const res = fakeRes();
    await modelRoute.handleSetPermissions(fakeReq({ mode: "off" }), res, ctx);
    assert.equal(cs.permissions, "Off");
  });

  test("'full' maps to 'Full access' label", async () => {
    const cs = fakeCs();
    const ctx = { cs, cid: "cid-1" };
    const res = fakeRes();
    await modelRoute.handleSetPermissions(fakeReq({ mode: "full" }), res, ctx);
    assert.equal(cs.permissions, "Full access");
  });

  test("unknown mode defaults to 'Full access'", async () => {
    const cs = fakeCs();
    const ctx = { cs, cid: "cid-1" };
    const res = fakeRes();
    await modelRoute.handleSetPermissions(fakeReq({ mode: "gibberish" }), res, ctx);
    assert.equal(cs.permissions, "Full access");
  });

  test("empty mode defaults to 'full'", async () => {
    const cs = fakeCs();
    const ctx = { cs, cid: "cid-1" };
    const res = fakeRes();
    await modelRoute.handleSetPermissions(fakeReq({}), res, ctx);
    assert.equal(cs.permissions, "Full access");
  });

  test("without a session the change is local and says so", async () => {
    const cs = fakeCs();
    const ctx = { cs, cid: "cid-1" };
    const res = fakeRes();
    await modelRoute.handleSetPermissions(fakeReq({ mode: "ask" }), res, ctx);
    const body = JSON.parse(res._body);
    assert.equal(body.mcodeSynced, false);
    assert.match(body.warning, /no mcode session/);
  });

  test("with a session the mode goes through session/set_config_option", async () => {
    const cs = fakeCs();
    cs.mcodeSessionId = "mvs_aabb000000000000000000000000abcd";
    const ctx = { cs, cid: "cid-1" };
    const res = fakeRes();
    await modelRoute.handleSetPermissions(fakeReq({ mode: "ask" }), res, ctx);
    const body = JSON.parse(res._body);
    assert.equal(body.mcodeSynced, true);
    assert.equal(body.warning, undefined);
    assert.equal(cs.permissions, "Ask");
  });
});

describe("handleListPermissionModes — /api/permissions-modes", () => {
  test("returns ok + webui (4 entries) + mcode arrays", () => {
    const res = fakeRes();
    modelRoute.handleListPermissionModes(null, res);
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.webui));
    assert.ok(Array.isArray(body.mcode));
    assert.equal(body.webui.length, 4);
  });

  test("webui entries have value/label/mcodeValue", () => {
    const res = fakeRes();
    modelRoute.handleListPermissionModes(null, res);
    const body = JSON.parse(res._body);
    for (const entry of body.webui) {
      assert.ok(entry.value, "webui entry must have value");
      assert.ok(entry.label, "webui entry must have label");
      assert.ok(entry.mcodeValue, "webui entry must have mcodeValue");
    }
  });

  test("webui includes 'full' mapped to 'bypassPermissions'", () => {
    const res = fakeRes();
    modelRoute.handleListPermissionModes(null, res);
    const body = JSON.parse(res._body);
    const full = body.webui.find((e) => e.value === "full");
    assert.ok(full);
    assert.equal(full.mcodeValue, "bypassPermissions");
  });
});

describe("handleAnswer — /api/answer (legacy no-op)", () => {
  test("returns deprecated:true (legacy endpoint)", async () => {
    const res = fakeRes();
    await modelRoute.handleAnswer(fakeReq({ type: "x", option: 1 }), res, {});
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.deprecated, true);
  });
});

// ============================================================
// Catalogue merge — engine config option vs providers config vs
// mcode cli-bundle builtin. The builtin mock dispatches through a
// mutable wrapper (see helpers/_setup.js) so a per-test list flip
// takes effect on the next call without re-importing the route.
// ============================================================

import {
  setBuiltinModelsMock,
} from "../helpers/_setup.js";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function withModelsConfig(contents, body) {
  const dir = mkdtempSync(join(tmpdir(), "webui-models-merge-"));
  const file = join(dir, "models.json");
  writeFileSync(file, JSON.stringify(contents));
  const prev = process.env.MCODE_WEBUI_MODELS_CONFIG;
  // Read every call: changing cwd is enough for the route's default,
  // but we also explicitly point env at the temp file so the path is
  // independent of cwd (the route prefers env over cwd/models.json).
  process.env.MCODE_WEBUI_MODELS_CONFIG = file;
  try {
    return body();
  } finally {
    if (prev === undefined) delete process.env.MCODE_WEBUI_MODELS_CONFIG;
    else process.env.MCODE_WEBUI_MODELS_CONFIG = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("handleGetModels — catalogue merge", () => {
  test("before a session exists: falls back to providers config + builtin catalogue", () => {
    // Pre-session: no engine configOption. The merged response should
    // source its models from MCODE_WEBUI_MODELS_CONFIG plus the mcode
    // cli-bundle builtin catalogue, grouped by provider.
    setBuiltinModelsMock(["MiniMax-M3", "MiniMax-M2.7"]);
    return withModelsConfig(
      {
        providers: [
          {
            id: "openai_compat",
            label: "OpenAI-compat",
            models: [
              { id: "gpt-4o-mini", label: "GPT-4o mini", contextLimit: 128000 },
            ],
          },
        ],
      },
      () => {
        const cs = fakeCs("minimax_api/MiniMax-M3");
        const res = fakeRes();
        modelRoute.handleGetModels(null, res, { cs, cid: "cid-merge1" });
        const body = JSON.parse(res._body);
        assert.equal(body.ok, true);
        assert.equal(body.source, "config+mcode-cli-bundle");
        // providers-config model surfaces in the flat list
        assert.ok(
          body.models.find((m) => m.id === "openai_compat/gpt-4o-mini"),
          "providers config model present",
        );
        assert.equal(
          body.models.find((m) => m.id === "openai_compat/gpt-4o-mini")
            .contextLimit,
          128000,
          "contextLimit surfaces from config",
        );
        // and in the matching group
        const cfgGroup = body.groups.find((g) => g.id === "openai_compat");
        assert.ok(cfgGroup, "providers config group present");
        assert.equal(cfgGroup.label, "OpenAI-compat");
        // builtin models folded into the minimax_api group
        const builtins = body.groups.find((g) => g.id === "minimax_api");
        assert.ok(builtins, "builtin group present");
        const builtinIds = builtins.models.map((m) => m.id);
        assert.ok(builtinIds.includes("minimax_api/MiniMax-M3"));
        assert.ok(builtinIds.includes("minimax_api/MiniMax-M2.7"));
        // current reflects the recorded pre-session choice rather than
        // the engine's null/blank value
        assert.equal(body.current, "minimax_api/MiniMax-M3");
      },
    );
  });

  test("before a session, no providers config: builtin catalogue only", () => {
    setBuiltinModelsMock(["MiniMax-M3"]);
    // Explicitly unset the env so the route's cwd/models.json fallback
    // does not silently pick up a real file. (Most CI cwd has none, but
    // be defensive.)
    const prev = process.env.MCODE_WEBUI_MODELS_CONFIG;
    process.env.MCODE_WEBUI_MODELS_CONFIG = join(
      tmpdir(),
      "definitely-not-existing-models.json",
    );
    try {
      const cs = fakeCs("minimax_api/MiniMax-M3");
      const res = fakeRes();
      modelRoute.handleGetModels(null, res, { cs, cid: "cid-merge2" });
      const body = JSON.parse(res._body);
      assert.equal(body.source, "mcode-cli-bundle");
      const builtinGroup = body.groups.find((g) => g.id === "minimax_api");
      assert.ok(builtinGroup, "builtin group present");
      assert.deepEqual(
        builtinGroup.models.map((m) => m.id),
        ["minimax_api/MiniMax-M3"],
      );
      assert.equal(body.current, "minimax_api/MiniMax-M3");
    } finally {
      if (prev === undefined) delete process.env.MCODE_WEBUI_MODELS_CONFIG;
      else process.env.MCODE_WEBUI_MODELS_CONFIG = prev;
    }
  });

  test("engine config option stays authoritative when present", () => {
    setBuiltinModelsMock([]);
    const cs = fakeCs(undefined, [MODEL_OPTION]);
    const res = fakeRes();
    modelRoute.handleGetModels(null, res, { cs, cid: "cid-merge3" });
    const body = JSON.parse(res._body);
    assert.equal(body.source, "acp-session-config");
    // engine-encoded ids round-trip
    assert.deepEqual(
      body.models.map((m) => m.id),
      ["minimax_api:MiniMax-M3", "minimax_api:MiniMax-M2.7"],
    );
    assert.equal(body.current, "minimax_api:MiniMax-M3");
  });

  test("surfaces the engine's thinkingEffort currentValue as `currentThinking`", () => {
    setBuiltinModelsMock([]);
    const cs = fakeCs(undefined, [
      MODEL_OPTION,
      {
        id: "thinkingEffort",
        type: "select",
        currentValue: "high",
        options: [
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
        ],
      },
    ]);
    const res = fakeRes();
    modelRoute.handleGetModels(null, res, { cs, cid: "cid-thinking1" });
    const body = JSON.parse(res._body);
    assert.equal(body.currentThinking, "high");
  });

  test("falls back to cs.model.thinking when the engine has no thinkingEffort option yet", () => {
    // Pre-session record: cs.model.thinking is set by handleSetModel,
    // the engine hasn't pushed its configOption list yet.
    setBuiltinModelsMock(["MiniMax-M3"]);
    const cs = fakeCs("minimax_api/MiniMax-M3");
    cs.model.thinking = "low";
    const res = fakeRes();
    modelRoute.handleGetModels(null, res, { cs, cid: "cid-thinking2" });
    const body = JSON.parse(res._body);
    assert.equal(body.currentThinking, "low");
  });

  test("currentThinking is null when neither the engine nor cs.model.thinking has a value", () => {
    setBuiltinModelsMock(["MiniMax-M3"]);
    const cs = fakeCs("minimax_api/MiniMax-M3");
    cs.model.thinking = ""; // explicit "no override" — the runtime default
    const res = fakeRes();
    modelRoute.handleGetModels(null, res, { cs, cid: "cid-thinking3" });
    const body = JSON.parse(res._body);
    assert.equal(body.currentThinking, null);
  });

  test("providers config id wins over builtin id collision", () => {
    // Same provider prefix + same model id from both sources: the
    // config entry is added first, so the builtin pass sees the id
    // already in `seen` and skips it.
    setBuiltinModelsMock(["MiniMax-M3"]);
    return withModelsConfig(
      {
        providers: [
          {
            id: "minimax_api",
            label: "MiniMax (config)",
            models: [
              {
                id: "MiniMax-M3",
                label: "MiniMax-M3 (config override)",
                contextLimit: 64000,
              },
            ],
          },
        ],
      },
      () => {
        const cs = fakeCs("minimax_api/MiniMax-M3");
        const res = fakeRes();
        modelRoute.handleGetModels(null, res, { cs, cid: "cid-merge4" });
        const body = JSON.parse(res._body);
        // Only one entry for this id; its label/contextLimit come from
        // the config rather than the builtin catalogue.
        const ids = body.models
          .filter((m) => m.id === "minimax_api/MiniMax-M3")
          .map((m) => m);
        assert.equal(ids.length, 1, "config id wins the collision");
        assert.equal(ids[0].label, "MiniMax-M3 (config override)");
        assert.equal(ids[0].contextLimit, 64000);
      },
    );
  });

  test("empty catalogue (no config, no builtin, no session) reports reason:no_catalogue and current is null", () => {
    setBuiltinModelsMock([]);
    const prev = process.env.MCODE_WEBUI_MODELS_CONFIG;
    process.env.MCODE_WEBUI_MODELS_CONFIG = join(
      tmpdir(),
      "definitely-not-existing-models.json",
    );
    try {
      const cs = { model: {} }; // no cs.model.name recorded
      const res = fakeRes();
      modelRoute.handleGetModels(null, res, { cs, cid: "cid-merge5" });
      const body = JSON.parse(res._body);
      assert.deepEqual(body.models, []);
      assert.equal(body.reason, "no_catalogue");
      // `null` rather than `DEFAULT_MODEL`: the chip must not claim a model
      // the engine never confirmed (the original behaviour was the
      // "no_session_config → DEFAULT_MODEL" bug). composer.tsx renders a
      // neutral label when `current` is null.
      assert.equal(body.current, null);
    } finally {
      if (prev === undefined) delete process.env.MCODE_WEBUI_MODELS_CONFIG;
      else process.env.MCODE_WEBUI_MODELS_CONFIG = prev;
    }
  });
});

// ============================================================
// Ticket 06 — engine `custom_provider` tree surfaces in /api/models.
//
// Before this ticket, the route only knew about the engine session
// configOption, the webui's own providers.json (env > cwd > user),
// and the mcode cli-bundle builtin extraction. An operator who
// configured providers in `~/.minimax/config.yaml` (via
// `mcode provider add` or by hand) saw an empty picker in the
// webui even though the engine had 9+ providers ready.
//
// The fix reads the engine's `custom_provider` tree as a catalogue
// source and merges it with the webui layers (webui wins on id
// collision). The read is BEST-EFFORT — a missing config.yaml is
// not an error. The apiKey / baseURL on the engine side are
// projection-time stripped (display only).
// ============================================================

/**
 * Helper: write a fake engine config to the per-file engine data
 * dir, run `body()`, then drop the file. The dir itself is shared
 * across the file (cleaned in `after`) so the route's
 * `getEngineConfigPath()` always points at a real path.
 */
function withEngineConfig(customProvider, body) {
  const path = join(_engineDataDir, "config.yaml");
  writeFileSync(path, yaml.dump({ custom_provider: customProvider }), "utf8");
  try {
    return body();
  } finally {
    try { rmSync(path, { force: true }); } catch {}
  }
}

describe("handleGetModels — engine custom_provider catalogue (ticket 06)", () => {
  test("engine-side providers surface in /api/models without a session", () => {
    // The bug this ticket closes: an operator with 9 entries in
    // `~/.minimax/config.yaml#custom_provider` saw an empty picker.
    setBuiltinModelsMock([]);
    return withEngineConfig(
      {
        "deepseek-cn": {
          name: "DeepSeek CN (anthropic)",
          kind: "custom",
          enabled: true,
          api: "anthropic-messages",
          options: { apiKey: "sk-foreign-deepseek", baseURL: "https://api.deepseek.com/anthropic", authMode: "api-key" },
          models: {
            "deepseek-flash": {
              name: "DeepSeek V4.1 Flash",
              limit: { context: 1000000 },
              thinking: { effortOptions: ["max", "high", "low", "none"] },
              modalities: { input: ["text", "image"] },
            },
          },
        },
      },
      () => {
        // No session configOption, no providers config, no builtin.
        // The engine catalogue is the only source — and it MUST
        // show up.
        const cs = fakeCs();
        const res = fakeRes();
        modelRoute.handleGetModels(null, res, { cs, cid: "cid-eng1" });
        const body = JSON.parse(res._body);
        assert.equal(body.ok, true);
        const ids = body.models.map((m) => m.id);
        assert.ok(
          ids.includes("deepseek-cn/deepseek-flash"),
          `deepseek-flash must surface; got: ${ids.join(", ")}`,
        );
        const group = body.groups.find((g) => g.id === "deepseek-cn");
        assert.ok(group, "engine provider group must be present");
        assert.equal(group.label, "DeepSeek CN (anthropic)");
        assert.equal(group.protocol, "anthropic");
        assert.equal(group.auth.hasKey, true);
        assert.equal(group.auth.type, "byok");
        // Model metadata surfaces from the engine side.
        const m = group.models[0];
        assert.equal(m.label, "DeepSeek V4.1 Flash");
        assert.equal(m.contextLimit, 1000000);
        assert.deepEqual(m.thinkingLevels, ["max", "high", "low", "none"]);
        assert.deepEqual(m.modalities, ["text", "image"]);
      },
    );
  });

  test("engine apiKey NEVER appears in any field of the /api/models response", () => {
    setBuiltinModelsMock([]);
    return withEngineConfig(
      {
        "secret-provider": {
          kind: "custom",
          enabled: true,
          api: "openai-completions",
          options: { apiKey: "sk-PRIVATE-NEVER-LEAK", baseURL: "https://secret.example/v1", authMode: "api-key" },
          models: { "m1": { name: "M1" } },
        },
      },
      () => {
        const cs = fakeCs();
        const res = fakeRes();
        modelRoute.handleGetModels(null, res, { cs, cid: "cid-eng2" });
        const body = JSON.parse(res._body);
        const dump = res._body; // the entire serialised response
        assert.equal(dump.includes("sk-PRIVATE-NEVER-LEAK"), false, "no plaintext key");
        assert.equal(dump.includes("secret.example"), false, "no engine baseURL");
        assert.equal(dump.includes("authMode"), false, "no engine authMode");
        // hasKey is the only signal that survives masking.
        const group = body.groups.find((g) => g.id === "secret-provider");
        assert.ok(group);
        assert.equal(group.auth.hasKey, true);
        // The auth shape is exactly the masked contract — type +
        // hasKey, nothing else.
        assert.deepEqual(Object.keys(group.auth).sort(), ["hasKey", "type"]);
      },
    );
  });

  test("engine-side webui_owned entries ALSO surface (ticket 05's own writes)", () => {
    // After ticket 05's sync, every entry the webui wrote carries
    // `_webui_owned: true`. The catalogue reader must surface those
    // alongside the foreign ones — the picker shows the union.
    setBuiltinModelsMock([]);
    return withEngineConfig(
      {
        "byok-zhipu": {
          name: "Zhipu (webui-synced)",
          kind: "custom",
          enabled: true,
          api: "openai-completions",
          options: { apiKey: "sk-webui-zhipu", baseURL: "https://x/v1" },
          models: { "glm-5.3": { name: "GLM-5.3" } },
          _webui_owned: true,
        },
      },
      () => {
        const cs = fakeCs();
        const res = fakeRes();
        modelRoute.handleGetModels(null, res, { cs, cid: "cid-eng3" });
        const body = JSON.parse(res._body);
        const ids = body.models.map((m) => m.id);
        assert.ok(ids.includes("byok-zhipu/glm-5.3"));
        // Marker field does NOT leak into the response (the projection
        // strips engine-internal fields).
        assert.equal(res._body.includes("_webui_owned"), false);
      },
    );
  });

  test("merge rule: webui layer overrides engine-side label/scalar for same-id provider", () => {
    // Same provider id exists in both the engine config and the
    // webui's providers.json. The webui layer's label/protocol/etc.
    // wins (per the merge rule in lib/engine-catalogue.js).
    setBuiltinModelsMock([]);
    return withEngineConfig(
      {
        "zai-max": {
          name: "ZAI Max (engine)",
          kind: "custom",
          enabled: true,
          api: "anthropic-messages",
          options: { apiKey: "sk-zai", baseURL: "https://x/v1" },
          models: { "glm-5.3": { name: "Engine GLM" } },
        },
      },
      () => withModelsConfig(
        {
          providers: [
            {
              id: "zai-max",
              label: "ZAI Max (operator override)",
              protocol: "openai",
              auth: { type: "byok", apiKey: "sk-from-webui" },
              models: [
                { id: "glm-5.3", label: "Webui GLM", contextLimit: 999000 },
                { id: "glm-5.3-flash", label: "Webui Flash", contextLimit: 500000 },
              ],
            },
          ],
        },
        () => {
          const cs = fakeCs();
          const res = fakeRes();
          modelRoute.handleGetModels(null, res, { cs, cid: "cid-eng4" });
          const body = JSON.parse(res._body);
          const group = body.groups.find((g) => g.id === "zai-max");
          assert.ok(group);
          // Webui scalar wins.
          assert.equal(group.label, "ZAI Max (operator override)");
          assert.equal(group.protocol, "openai");
          // Webui model wins on id collision (glm-5.3).
          // The route composes `<providerId>/<modelId>` for ids
          // that don't already contain a slash.
          const glm = group.models.find((m) => m.id === "zai-max/glm-5.3");
          assert.ok(glm, "merged glm-5.3 model present");
          assert.equal(glm.label, "Webui GLM");
          assert.equal(glm.contextLimit, 999000);
          // Engine-only model passes through (glm-5.3-flash from webui
          // is the new one; engine doesn't have it).
          const flash = group.models.find((m) => m.id === "zai-max/glm-5.3-flash");
          assert.ok(flash, "webui-only model surfaces");
          assert.equal(flash.label, "Webui Flash");
        },
      ),
    );
  });

  test("merge rule: engine-side fields fill in undefined webui values (foreign provider)", () => {
    // A foreign engine provider the webui doesn't know about — the
    // webui layer is missing it, but the engine's view passes
    // through.
    setBuiltinModelsMock([]);
    return withEngineConfig(
      {
        "nousresearch": {
          name: "Nous Research",
          kind: "custom",
          enabled: true,
          api: "openai-completions",
          options: { apiKey: "sk-nous", baseURL: "https://x/v1" },
          models: {
            "deepseek/deepseek-v4.1-flash": {
              name: "DeepSeek V4.1 Flash",
              limit: { context: 1000000 },
              thinking: { effortOptions: ["max", "high", "low", "none"] },
              modalities: { input: ["text", "image"] },
            },
          },
        },
      },
      () => {
        // No providers config — the engine catalogue is the only
        // source. The foreign entry's label + models must appear
        // even though the webui layer has nothing to say about it.
        const cs = fakeCs();
        const res = fakeRes();
        modelRoute.handleGetModels(null, res, { cs, cid: "cid-eng5" });
        const body = JSON.parse(res._body);
        const ids = body.models.map((m) => m.id);
        // The engine-side model id already contains a slash
        // (`deepseek/deepseek-v4.1-flash` — a router-style upstream
        // id); the route uses it verbatim rather than prepending
        // the provider id. That's by design — see routes/model.js.
        assert.ok(
          ids.includes("deepseek/deepseek-v4.1-flash"),
          `model id must surface verbatim; got: ${ids.join(", ")}`,
        );
        const group = body.groups.find((g) => g.id === "nousresearch");
        assert.ok(group, "foreign provider group present");
        assert.equal(group.label, "Nous Research");
        assert.equal(group.models[0].contextLimit, 1000000);
      },
    );
  });

  test("disabled engine entries are excluded from /api/models", () => {
    setBuiltinModelsMock([]);
    return withEngineConfig(
      {
        "active-provider": {
          kind: "custom",
          enabled: true,
          api: "openai-completions",
          options: { apiKey: "sk-x", baseURL: "https://x/v1" },
          models: { m: {} },
        },
        "off-provider": {
          kind: "custom",
          enabled: false,
          api: "openai-completions",
          options: { apiKey: "sk-x", baseURL: "https://x/v1" },
          models: { m: {} },
        },
      },
      () => {
        const cs = fakeCs();
        const res = fakeRes();
        modelRoute.handleGetModels(null, res, { cs, cid: "cid-eng6" });
        const body = JSON.parse(res._body);
        const ids = body.groups.map((g) => g.id);
        assert.ok(ids.includes("active-provider"));
        assert.ok(!ids.includes("off-provider"), "disabled engine entry must NOT surface");
      },
    );
  });

  test("YAML parse error in engine config is non-fatal (empty engine layer)", () => {
    // The route must not 500 when the engine's config.yaml is
    // malformed — ticket 06 explicitly closes the "engine config
    // breaks /api/models" failure mode.
    setBuiltinModelsMock([]);
    const path = join(_engineDataDir, "config.yaml");
    writeFileSync(path, "this: is: not: valid: yaml: [\n", "utf8");
    try {
      const cs = fakeCs();
      const res = fakeRes();
      modelRoute.handleGetModels(null, res, { cs, cid: "cid-eng7" });
      const body = JSON.parse(res._body);
      // The route returns ok; the engine catalogue contributes nothing.
      assert.equal(body.ok, true);
      // No engine-sourced models appeared.
      const engineSourced = body.models.filter((m) => /^[a-z]/.test(m.id));
      assert.equal(engineSourced.length, 0);
    } finally {
      try { rmSync(path, { force: true }); } catch {}
    }
  });
});
