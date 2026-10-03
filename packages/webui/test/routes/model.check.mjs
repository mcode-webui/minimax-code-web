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
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setupMocks, absPath } from "../helpers/_setup.js";
import { mkTmpDir } from "../helpers/tmp.js";
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
const _engineDataDir = mkTmpDir("webui-model-engine-cat-");
const _webuiDataDir = mkTmpDir("webui-model-user-level-");
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

describe("handleAnswer — /api/answer (removed capability tombstone)", () => {
  // Ticket 70: this route used to answer 200 {ok:true, deprecated:true}
  // while doing nothing. The webapp's plan modal (three buttons) and the
  // ask modal's Skip button all posted here, so a click looked
  // successful and the prompt stayed pending. It now refuses explicitly:
  // a caller that reaches it gets a status it can act on, and a caller
  // that does not is unaffected.
  test("answers 410 with ok:false rather than claiming success", async () => {
    const res = fakeRes();
    await modelRoute.handleAnswer(fakeReq({ type: "plan", option: "agree" }), res, {});
    assert.equal(res._status, 410);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, false);
    assert.equal(body.removed, true);
    assert.match(body.error, /isAskAnswer/);
  });

  test("an empty body still gets the 410, not a 500", async () => {
    // The route kept `readJson(req)` for the MCODE_USAGE_DEBUG log line.
    // readJson normalises an unparseable body to `{}`, so a client that
    // posts nothing is refused on the same terms as any other caller.
    const res = fakeRes();
    await modelRoute.handleAnswer(Readable.from([]), res, {});
    assert.equal(res._status, 410);
    assert.equal(JSON.parse(res._body).ok, false);
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
import {writeFileSync, rmSync, mkdirSync} from "node:fs";

import { join } from "node:path";

function withModelsConfig(contents, body) {
  const dir = mkTmpDir("webui-models-merge-");
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
        // Ticket 09-02: the webui id is always `<providerKey>/<engineModelKey>`,
        // so the upstream-style id `deepseek/deepseek-v4.1-flash` lives
        // under `nousresearch` as `nousresearch/deepseek/deepseek-v4.1-flash`.
        // The first segment is the provider key (used for grouping); the
        // rest is the engine model key verbatim (the engine allows `/`
        // inside model ids; the wire form `<provider>/<model>` uses `/`
        // as the structural separator only).
        assert.ok(
          ids.includes("nousresearch/deepseek/deepseek-v4.1-flash"),
          `model id must surface as <providerKey>/<engineModelKey>; got: ${ids.join(", ")}`,
        );
        const group = body.groups.find((g) => g.id === "nousresearch");
        assert.ok(group, "foreign provider group present");
        assert.equal(group.label, "Nous Research");
        assert.equal(group.models[0].contextLimit, 1000000);
        // Grouping attribution: the entry's `provider` field is the
        // explicit provider id (not the first `/` segment of the id).
        assert.equal(group.models[0].provider, "nousresearch");
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

// ============================================================
// Ticket 09-02 — model grouping attribution.
//
// The user reported `nousresearch` had 8 models with upstream-style
// ids (`deepseek/x`, `z-ai/y`, `openai/gpt-5.6-sol`, ...) and a
// sibling `zai-max` lost its own `glm-5.3` to the bare-id dedupe.
//
// Root cause (ticket 09-02):
//   - `m.id.includes("/") ? m.id : p.id + "/" + m.id` kept the
//     upstream id verbatim, so a model with id `deepseek/x` lived in
//     `/api/models` as `deepseek/x` with `provider = "deepseek"` —
//     picked up under the wrong group's label and deduped against any
//     other provider's same-named model.
//   - `providerOf(id)` derived the group from the first `/` segment,
//     not from the directory layer's explicit provider metadata.
//
// Fix (server/routes/model.js + server/lib/mcode-acp.js +
// server/lib/engine-provider-sync.js):
//   - The webui id is always `<providerKey>/<engineModelKey>` where
//     `engineModelKey` may itself contain `/`. The grouping uses the
//     entry's explicit `provider` field (set to `p.id`); the
//     `providerOf(id)` helper is preserved for engine session
//     entries whose ids are the engine wire form.
//   - The `seen` dedupe uses the full prefixed id, so two providers
//     with overlapping upstream ids stay distinct.
//   - `resolveModelId` adds a `<providerKey>/<engineModelKey>` name
//     match against the engine's `option.name`, so a session boot
//     replay (and the mid-session set-model push) lands on the right
//     engine option even when the model id contains `/`.
//
// These tests pin the load-bearing pieces. The end-to-end live
// self-check is the dev server with a synthetic engine config that
// carries the bug-triggering shape; this file isolates the route-layer
// regressions so the test runtime doesn't have to spin up an engine.
// ============================================================

describe("handleGetModels — ticket 09-02: grouping attribution", () => {
  test("upstream-style engine id is prefixed with its provider key", () => {
    setBuiltinModelsMock([]);
    return withEngineConfig(
      {
        nousresearch: {
          name: "Nous Research",
          kind: "custom",
          enabled: true,
          api: "openai-completions",
          options: { apiKey: "sk-nous", baseURL: "https://x/v1" },
          models: {
            "deepseek/deepseek-v4.1-flash": {
              name: "DeepSeek V4.1 Flash",
              limit: { context: 1000000 },
            },
          },
        },
      },
      () => {
        const cs = fakeCs();
        const res = fakeRes();
        modelRoute.handleGetModels(null, res, { cs, cid: "cid-0902-a" });
        const body = JSON.parse(res._body);
        const ids = body.models.map((m) => m.id);
        // The webui id is `<providerKey>/<engineModelKey>` — the upstream
        // id `deepseek/deepseek-v4.1-flash` lives under `nousresearch`
        // as `nousresearch/deepseek/deepseek-v4.1-flash`. The first
        // segment is the provider key (the grouping anchor); the rest
        // is the engine model key verbatim.
        assert.ok(
          ids.includes("nousresearch/deepseek/deepseek-v4.1-flash"),
          `webui id must be <providerKey>/<engineModelKey>; got: ${ids.join(", ")}`,
        );
        // The bare upstream id (the pre-fix bug) must NOT appear.
        assert.ok(
          !ids.includes("deepseek/deepseek-v4.1-flash"),
          `bare upstream id must not surface (pre-fix bug); got: ${ids.join(", ")}`,
        );
      },
    );
  });

  test("entry.provider is the explicit provider id (not the first segment of the id)", () => {
    // Grouping attribution: the bug was that `providerOf(id)` derived
    // the group from the first `/` segment of the (bare) id, putting
    // `deepseek/deepseek-v4.1-flash` into the `deepseek` group. With
    // the fix, the entry's `provider` field is the directory-layer
    // provider id (here `nousresearch`).
    setBuiltinModelsMock([]);
    return withEngineConfig(
      {
        nousresearch: {
          name: "Nous Research",
          kind: "custom",
          enabled: true,
          api: "openai-completions",
          options: { apiKey: "sk-nous", baseURL: "https://x/v1" },
          models: {
            "deepseek/deepseek-v4.1-flash": {},
            "openai/gpt-5.6-sol": {},
            "qwen/qwen3.8-max-0902": {},
          },
        },
      },
      () => {
        const cs = fakeCs();
        const res = fakeRes();
        modelRoute.handleGetModels(null, res, { cs, cid: "cid-0902-b" });
        const body = JSON.parse(res._body);
        const group = body.groups.find((g) => g.id === "nousresearch");
        assert.ok(group, "nousresearch group present");
        // Every model in the group carries `provider: "nousresearch"` —
        // not the upstream-namespace's first segment.
        for (const m of group.models) {
          assert.equal(
            m.provider,
            "nousresearch",
            `entry.provider must be the directory-layer provider; got: ${m.id} provider=${m.provider}`,
          );
        }
        assert.equal(group.models.length, 3);
      },
    );
  });

  test("dedupe key is per-provider: sibling providers with overlapping upstream ids do not collide", () => {
    // The pre-fix bug: `seen.add("z-ai/glm-5.3")` swallowed the sibling
    // `zai-max/glm-5.3` because both end up as the bare id
    // `z-ai/glm-5.3` (or `glm-5.3`, depending on how upstream shape
    // overlaps). After the fix the webui id is `<providerKey>/<modelId>`
    // and the dedupe is per-provider.
    setBuiltinModelsMock([]);
    return withEngineConfig(
      {
        nousresearch: {
          name: "Nous Research",
          kind: "custom",
          enabled: true,
          api: "openai-completions",
          options: { apiKey: "sk-nous", baseURL: "https://x/v1" },
          models: {
            // Same bare upstream style that triggers the collision.
            "z-ai/glm-5.3": {},
            "openai/gpt-5.6-sol": {},
          },
        },
        "zai-max": {
          name: "ZAI Max",
          kind: "custom",
          enabled: true,
          api: "openai-completions",
          options: { apiKey: "sk-zai", baseURL: "https://x/v1" },
          models: {
            "glm-5.3": {},
          },
        },
      },
      () => {
        const cs = fakeCs();
        const res = fakeRes();
        modelRoute.handleGetModels(null, res, { cs, cid: "cid-0902-c" });
        const body = JSON.parse(res._body);
        const ids = body.models.map((m) => m.id);
        // Both the upstream-namespace form and the plain sibling
        // survive — neither ate the other.
        assert.ok(
          ids.includes("nousresearch/z-ai/glm-5.3"),
          `upstream-namespace form must survive; got: ${ids.join(", ")}`,
        );
        assert.ok(
          ids.includes("zai-max/glm-5.3"),
          `sibling plain form must survive; got: ${ids.join(", ")}`,
        );
        // Each group carries only its own models.
        const ns = body.groups.find((g) => g.id === "nousresearch");
        const zm = body.groups.find((g) => g.id === "zai-max");
        assert.ok(ns && zm, "both groups present");
        assert.equal(ns.models.length, 2);
        assert.equal(zm.models.length, 1);
        // Cross-pollination pin: no model lands in the wrong group.
        for (const m of ns.models) {
          assert.ok(m.id.startsWith("nousresearch/"));
        }
        for (const m of zm.models) {
          assert.ok(m.id.startsWith("zai-max/"));
        }
      },
    );
  });

  test("every model lands in its configured provider's group (cross-group pollution)", () => {
    // The user's headline complaint: "第一个供应商 minimax 下有很多不是 minimax 的"
    // — the engine config has a `minimax_api` group AND a separate
    // provider with non-minimax models, but the picker put everything
    // under minimax. The fix is that each model's group is its
    // configured provider (explicit `entry.provider`), not derived
    // from the first segment of the id.
    setBuiltinModelsMock([]);
    return withEngineConfig(
      {
        "zai-max": {
          name: "ZAI Max",
          kind: "custom",
          enabled: true,
          api: "openai-completions",
          options: { apiKey: "sk-zai", baseURL: "https://x/v1" },
          models: {
            "glm-5.3": {},
            "glm-5.3-flash": {},
          },
        },
        "deepseek-cn": {
          name: "DeepSeek CN",
          kind: "custom",
          enabled: true,
          api: "openai-completions",
          options: { apiKey: "sk-deep", baseURL: "https://x/v1" },
          models: {
            "deepseek-flash": {},
          },
        },
        "kimi-taozi": {
          name: "Kimi",
          kind: "custom",
          enabled: true,
          api: "openai-completions",
          options: { apiKey: "sk-kimi", baseURL: "https://x/v1" },
          models: {
            "kimi-k2": {},
          },
        },
      },
      () => {
        const cs = fakeCs();
        const res = fakeRes();
        modelRoute.handleGetModels(null, res, { cs, cid: "cid-0902-d" });
        const body = JSON.parse(res._body);
        const expected = {
          "zai-max": 2,
          "deepseek-cn": 1,
          "kimi-taozi": 1,
        };
        for (const [gid, count] of Object.entries(expected)) {
          const group = body.groups.find((g) => g.id === gid);
          assert.ok(group, `${gid} group must be present`);
          assert.equal(
            group.models.length,
            count,
            `${gid} must carry ${count} models; got: ${group.models.map((m) => m.id).join(", ")}`,
          );
          for (const m of group.models) {
            assert.equal(
              m.provider,
              gid,
              `entry.provider must equal its group id; got: ${m.id} provider=${m.provider}`,
            );
            assert.ok(
              m.id.startsWith(`${gid}/`),
              `model id must start with its provider key; got: ${m.id}`,
            );
          }
        }
      },
    );
  });

  test("builtins stay under `minimax_api` even when the recorded pick's first segment is another provider (acceptance replay)", () => {
    // Ticket 09-02 acceptance replay: a recorded pick of
    // `nousresearch/openai/gpt-5.6-sol` previously dragged the
    // builtin MiniMax shell into the `nousresearch` group (the
    // derived `currentProvider = currentName.split("/")[0]` keyed
    // the builtin shell by the pick's first segment). The fix keys
    // the builtin shell by the BUILTIN_PROVIDER (`minimax_api`)
    // unconditionally — the builtins belong to the cli-bundle
    // extraction and are not the user's recorded pick.
    setBuiltinModelsMock(["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.5"]);
    return withEngineConfig(
      {
        nousresearch: {
          name: "Nous Research",
          kind: "custom",
          enabled: true,
          api: "openai-completions",
          options: { apiKey: "sk-nous", baseURL: "https://x/v1" },
          models: {
            "deepseek/deepseek-v4.1-flash": {},
            "openai/gpt-5.6-sol": {},
            "qwen/qwen3.8-max-0902": {},
            "z-ai/glm-5.3": {},
          },
        },
      },
      () => {
        const cs = fakeCs("nousresearch/openai/gpt-5.6-sol");
        const res = fakeRes();
        modelRoute.handleGetModels(null, res, { cs, cid: "cid-0902-builtins" });
        const body = JSON.parse(res._body);
        // The `nousresearch` group must carry ONLY its configured
        // models — the 3 builtins stay under `minimax_api`.
        const ns = body.groups.find((g) => g.id === "nousresearch");
        assert.ok(ns, "nousresearch group present");
        assert.equal(ns.models.length, 4, "nousresearch shows exactly its 4 config models");
        for (const m of ns.models) {
          assert.ok(
            m.id.startsWith("nousresearch/"),
            `nousresearch model id must start with 'nousresearch/'; got: ${m.id}`,
          );
          assert.ok(
            !m.source || m.source !== "builtin",
            `nousresearch must not contain any builtin-sourced model; got: ${m.id} source=${m.source}`,
          );
        }
        // The `minimax_api` group carries the builtin shell (3
        // models). The count depends on the mock — the loader can
        // add additional builtins via the bundled cli.js; pin the
        // minimum count + presence.
        const builtin = body.groups.find((g) => g.id === "minimax_api");
        assert.ok(builtin, "minimax_api builtin group present");
        assert.ok(
          builtin.models.length >= 3,
          `minimax_api must carry the 3+ builtin models; got: ${builtin.models.length}`,
        );
        for (const m of builtin.models) {
          assert.equal(m.source, "builtin", "builtin group models must be source=builtin");
          assert.ok(
            m.id.startsWith("minimax_api/"),
            `builtin id must start with 'minimax_api/'; got: ${m.id}`,
          );
        }
      },
    );
  });
});

// ============================================================
// Ticket 36 — builtin MiniMax models get thinking levels.
//
// The engine materialises its builtin catalogue into the engine
// config.yaml under `provider.minimax.models` with the variant-style
// thinking schema (thinking_config + variants), while the webui's
// /api/models only projected the custom_provider shape
// (`thinking.effortOptions`). Result: every `minimax_api` builtin
// carried NO thinkingLevels and the composer never mounted the
// thinking control for MiniMax's own models.
//
// These tests pin the fixed projection AND the wire channel:
//   - switchable (M3) → thinkingLevels ["off","on"], driven through
//     the engine's VARIANT model-selection values (m:...:v:thinking /
//     m:...:v:none-thinking), because the engine rejects
//     `thinkingEffort` for models without effortOptions
//     ("Thinking effort is not advertised for the selected model").
//   - forced_on + effortOptions (M3.1-Flash) → effortOptions verbatim
//     through the existing thinkingEffort channel.
//   - forced_on with no effort dimension (M2.7 on a materialised
//     host) → NO thinkingLevels — a control would be a no-op.
// ============================================================

/**
 * Like withEngineConfig but takes a full config document (not just
 * custom_provider) — ticket 36 fixtures need `provider.minimax.models`
 * and `custom_provider` side by side in one file.
 */
async function withEngineConfigDoc(doc, body) {
  const path = join(_engineDataDir, "config.yaml");
  writeFileSync(path, yaml.dump(doc), "utf8");
  // `return await` — an async body must be HELD inside the try, or the
  // finally deletes the fixture the moment the body first awaits
  // (returning the pending promise runs the finally immediately).
  try {
    return await body();
  } finally {
    try { rmSync(path, { force: true }); } catch {}
  }
}

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
      "MiniMax-M2.7": {
        name: "MiniMax-M2.7",
        reasoning: true,
        thinking_config: { mode: "forced_on" },
      },
    },
  },
};

describe("handleGetModels — builtin thinkingLevels (ticket 36)", () => {
  test("switchable builtin (MiniMax-M3) carries thinkingLevels [off, on] — not a fabricated depth scale", () => {
    setBuiltinModelsMock(["MiniMax-M3", "MiniMax-M3.1-Flash-Preview", "MiniMax-M2.7"]);
    return withEngineConfigDoc({ provider: BUILTIN_MINIMAX_TREE }, () => {
      const cs = fakeCs();
      const res = fakeRes();
      modelRoute.handleGetModels(null, res, { cs, cid: "cid-t36-1" });
      const body = JSON.parse(res._body);
      const m3 = body.models.find((m) => m.id === "minimax_api/MiniMax-M3");
      assert.ok(m3, "builtin M3 entry present");
      assert.deepEqual(m3.thinkingLevels, ["off", "on"]);
    });
  });

  test("forced_on + effortOptions builtin (M3.1-Flash) carries the engine's efforts verbatim", () => {
    setBuiltinModelsMock(["MiniMax-M3", "MiniMax-M3.1-Flash-Preview", "MiniMax-M2.7"]);
    return withEngineConfigDoc({ provider: BUILTIN_MINIMAX_TREE }, () => {
      const cs = fakeCs();
      const res = fakeRes();
      modelRoute.handleGetModels(null, res, { cs, cid: "cid-t36-2" });
      const body = JSON.parse(res._body);
      const flash = body.models.find((m) => m.id === "minimax_api/MiniMax-M3.1-Flash-Preview");
      assert.ok(flash, "builtin M3.1-Flash entry present");
      assert.deepEqual(flash.thinkingLevels, ["default", "low", "medium", "high", "xhigh", "max"]);
    });
  });

  test("forced_on with no effort dimension (M2.7) gets NO thinkingLevels — counter-example", () => {
    // The control must not appear for a model with nothing to choose.
    // This is the ticket's honesty rule: never fabricate a control.
    setBuiltinModelsMock(["MiniMax-M3", "MiniMax-M3.1-Flash-Preview", "MiniMax-M2.7"]);
    return withEngineConfigDoc({ provider: BUILTIN_MINIMAX_TREE }, () => {
      const cs = fakeCs();
      const res = fakeRes();
      modelRoute.handleGetModels(null, res, { cs, cid: "cid-t36-3" });
      const body = JSON.parse(res._body);
      const m27 = body.models.find((m) => m.id === "minimax_api/MiniMax-M2.7");
      assert.ok(m27, "builtin M2.7 entry present");
      assert.equal(m27.thinkingLevels, undefined, "no thinkingLevels on a no-dimension model");
    });
  });

  test("engine-session entries in variant wire form also carry thinkingLevels", () => {
    // applyConfigOptionUpdate mirrors the engine's wire-form
    // currentValue into cs.model.name outside the pick window; the
    // composer matches the active model by id, so the ENGINE-sourced
    // entries must be annotated too or the control would disappear
    // after a cross-client change.
    setBuiltinModelsMock([]);
    return withEngineConfigDoc({ provider: BUILTIN_MINIMAX_TREE }, () => {
      const cs = fakeCs(undefined, [
        {
          type: "select",
          id: "model",
          name: "Model",
          currentValue: "m:minimax_api:MiniMax-M3:v:thinking",
          options: [
            { value: "m:minimax_api:MiniMax-M3:v:thinking", name: "MiniMax-M3 · thinking" },
            { value: "m:minimax_api:MiniMax-M3:v:none-thinking", name: "MiniMax-M3 · none-thinking" },
          ],
        },
      ]);
      const res = fakeRes();
      modelRoute.handleGetModels(null, res, { cs, cid: "cid-t36-4" });
      const body = JSON.parse(res._body);
      const on = body.models.find((m) => m.id === "m:minimax_api:MiniMax-M3:v:thinking");
      const off = body.models.find((m) => m.id === "m:minimax_api:MiniMax-M3:v:none-thinking");
      assert.ok(on && off, "both variant wire entries present");
      assert.deepEqual(on.thinkingLevels, ["off", "on"]);
      assert.deepEqual(off.thinkingLevels, ["off", "on"]);
    });
  });

  test("custom_provider thinkingLevels stay verbatim next to the builtin tree — regression", () => {
    setBuiltinModelsMock(["MiniMax-M3"]);
    return withEngineConfigDoc(
      {
        provider: BUILTIN_MINIMAX_TREE,
        custom_provider: {
          "deepseek-cn": {
            kind: "custom",
            enabled: true,
            api: "anthropic-messages",
            options: { apiKey: "sk-x", baseURL: "https://x" },
            models: {
              "deepseek-flash": {
                name: "DeepSeek V4.1 Flash",
                thinking: { effortOptions: ["max", "high", "low", "none"] },
              },
            },
          },
        },
      },
      () => {
        const cs = fakeCs();
        const res = fakeRes();
        modelRoute.handleGetModels(null, res, { cs, cid: "cid-t36-5" });
        const body = JSON.parse(res._body);
        const ds = body.models.find((m) => m.id === "deepseek-cn/deepseek-flash");
        assert.ok(ds, "custom_provider model present");
        // Item-by-item identical to the engine's effortOptions — the
        // ticket-06 path must not have moved.
        assert.deepEqual(ds.thinkingLevels, ["max", "high", "low", "none"]);
        const m3 = body.models.find((m) => m.id === "minimax_api/MiniMax-M3");
        assert.deepEqual(m3.thinkingLevels, ["off", "on"]);
      },
    );
  });

  test("no engine config → builtin entries stay metadata-free (fresh-install regression)", () => {
    setBuiltinModelsMock(["MiniMax-M3"]);
    const cs = fakeCs();
    const res = fakeRes();
    modelRoute.handleGetModels(null, res, { cs, cid: "cid-t36-6" });
    const body = JSON.parse(res._body);
    const m3 = body.models.find((m) => m.id === "minimax_api/MiniMax-M3");
    assert.ok(m3);
    assert.equal(m3.thinkingLevels, undefined);
  });
});

describe("handleSetModel — variant-channel wire (ticket 36)", () => {
  /** Engine model option advertising M3 in variant wire form (what uniqueModelValues emits). */
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

  test("model + thinking:'off' on a switchable builtin → ONE model push carrying the none-thinking variant, no thinkingEffort push", () => {
    const calls = [];
    registerRpcMock({
      setConfigOption: async (_sid, configId, value) => {
        calls.push({ configId, value });
        return { ok: true, data: {} };
      },
    });
    return withEngineConfigDoc({ provider: BUILTIN_MINIMAX_TREE }, async () => {
      const cs = fakeCs("minimax_api/MiniMax-M3", [VARIANT_MODEL_OPTION]);
      cs.mcodeSessionId = "mvs_t36";
      const res = fakeRes();
      const { existsSync: ex1 } = await import("node:fs");
      await modelRoute.handleSetModel(
        fakeReq({ model: "minimax_api/MiniMax-M3", thinking: "off" }),
        res,
        { cs, cid: "cid-t36-w1" },
      );
      const body = JSON.parse(res._body);
      assert.equal(body.ok, true);
      assert.equal(cs.model.thinking, "off");
      assert.equal(calls.length, 1, "variant channel folds thinking into the model selection");
      assert.deepEqual(calls[0], {
        configId: "model",
        value: "m:minimax_api:MiniMax-M3:v:none-thinking",
      });
      assert.equal(body.thinkingSynced, true, "thinking carried by the model push");
    });
  });

  test("thinking-only update flips the variant: {thinking:'on'} → model push with v:thinking", () => {
    const calls = [];
    registerRpcMock({
      setConfigOption: async (_sid, configId, value) => {
        calls.push({ configId, value });
        return { ok: true, data: {} };
      },
    });
    return withEngineConfigDoc({ provider: BUILTIN_MINIMAX_TREE }, async () => {
      const cs = fakeCs("minimax_api/MiniMax-M3", [VARIANT_MODEL_OPTION]);
      cs.mcodeSessionId = "mvs_t36";
      cs.model.thinking = "off";
      const res = fakeRes();
      await modelRoute.handleSetModel(fakeReq({ thinking: "on" }), res, { cs, cid: "cid-t36-w2" });
      const body = JSON.parse(res._body);
      assert.equal(cs.model.name, "minimax_api/MiniMax-M3", "recorded name untouched");
      assert.equal(cs.model.thinking, "on");
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0], { configId: "model", value: "m:minimax_api:MiniMax-M3:v:thinking" });
      assert.equal(body.thinkingSynced, true);
    });
  });

  test("model-only pick on a switchable builtin uses the engine default variant (default_value 'true' → thinking)", () => {
    const calls = [];
    registerRpcMock({
      setConfigOption: async (_sid, configId, value) => {
        calls.push({ configId, value });
        return { ok: true, data: {} };
      },
    });
    return withEngineConfigDoc({ provider: BUILTIN_MINIMAX_TREE }, async () => {
      const cs = fakeCs(undefined, [VARIANT_MODEL_OPTION]);
      cs.mcodeSessionId = "mvs_t36";
      cs.model.thinking = "";
      const res = fakeRes();
      await modelRoute.handleSetModel(fakeReq({ model: "minimax_api/MiniMax-M3" }), res, {
        cs,
        cid: "cid-t36-w3",
      });
      const body = JSON.parse(res._body);
      assert.equal(body.mcodeSynced, true);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0], { configId: "model", value: "m:minimax_api:MiniMax-M3:v:thinking" });
      // No user-chosen level → nothing to report as thinking-synced.
      assert.equal(body.thinkingSynced, false);
    });
  });

  test("effort-channel builtin (M3.1-Flash) keeps the model→thinkingEffort two-push contract", () => {
    const calls = [];
    registerRpcMock({
      setConfigOption: async (_sid, configId, value) => {
        calls.push({ configId, value });
        return { ok: true, data: {} };
      },
    });
    return withEngineConfigDoc({ provider: BUILTIN_MINIMAX_TREE }, async () => {
      const cs = fakeCs(undefined, [
        {
          type: "select",
          id: "model",
          name: "Model",
          currentValue: "m:minimax_api:MiniMax-M3.1-Flash-Preview:u",
          options: [
            { value: "m:minimax_api:MiniMax-M3.1-Flash-Preview:u", name: "M3.1-Flash-Preview" },
          ],
        },
      ]);
      cs.mcodeSessionId = "mvs_t36";
      const res = fakeRes();
      await modelRoute.handleSetModel(
        fakeReq({ model: "minimax_api/MiniMax-M3.1-Flash-Preview", thinking: "high" }),
        res,
        { cs, cid: "cid-t36-w4" },
      );
      const body = JSON.parse(res._body);
      assert.equal(body.thinkingSynced, true);
      assert.equal(calls.length, 2, "model first, then thinkingEffort — engine contract");
      assert.deepEqual(calls[0], { configId: "model", value: "m:minimax_api:MiniMax-M3.1-Flash-Preview:u" });
      assert.deepEqual(calls[1], { configId: "thinkingEffort", value: "high" });
    });
  });

  test("third-party (config) model with effort levels keeps the two-push contract — regression", () => {
    const calls = [];
    registerRpcMock({
      setConfigOption: async (_sid, configId, value) => {
        calls.push({ configId, value });
        return { ok: true, data: {} };
      },
    });
    return withEngineConfigDoc({ provider: BUILTIN_MINIMAX_TREE }, async () => {
      const cs = fakeCs(undefined, [
        {
          type: "select",
          id: "model",
          name: "Model",
          currentValue: "m:custom_provider%3Azai-pro:glm-5.3:u",
          options: [
            { value: "m:custom_provider%3Azai-pro:glm-5.3:u", name: "glm-5.3" },
          ],
        },
      ]);
      cs.mcodeSessionId = "mvs_t36";
      const res = fakeRes();
      await modelRoute.handleSetModel(
        fakeReq({ model: "zai-pro/glm-5.3", thinking: "high" }),
        res,
        { cs, cid: "cid-t36-w5" },
      );
      const body = JSON.parse(res._body);
      assert.equal(body.thinkingSynced, true);
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0], { configId: "model", value: "m:custom_provider%3Azai-pro:glm-5.3:u" });
      assert.deepEqual(calls[1], { configId: "thinkingEffort", value: "high" });
    });
  });
});

// ============================================================
// U6 — context-window options. The engine's materialised builtin tree
// (`provider.minimax.models`) is the only source that carries
// `contextWindowOptions` / `contextWindowOptionHints`; the route
// annotates the builtin-shell and engine-session minimax_api entries
// with them and reports the recorded choice as `currentContextWindow`.
// `handleSetModel` validates + records `contextWindow` (null clears).
// ============================================================

/** Write a `provider.minimax.models` tree into the per-file engine data dir. */
function withEngineBuiltinTree(models, body) {
  const path = join(_engineDataDir, "config.yaml");
  writeFileSync(path, yaml.dump({ provider: { minimax: { models } } }), "utf8");
  try {
    return body();
  } finally {
    try { rmSync(path, { force: true }); } catch {}
  }
}

describe("handleGetModels — builtin context-window options (U6)", () => {
  test("minimax_api builtin entries carry options/hints/contextLimit; models without options stay field-free", () => {
    setBuiltinModelsMock(["MiniMax-M3", "MiniMax-M2.7"]);
    return withEngineBuiltinTree(
      {
        "MiniMax-M3": {
          name: "M3",
          limit: { context: 512000, output: 128000 },
          contextWindowOptions: [512000, 1000000],
          contextWindowOptionHints: { "1000000": "higher_usage" },
        },
        "MiniMax-M2.7": { name: "M2.7", limit: { context: 200000 } },
      },
      () => {
        const cs = fakeCs("minimax_api/MiniMax-M3");
        const res = fakeRes();
        modelRoute.handleGetModels(null, res, { cs, cid: "cid-u6-1" });
        const body = JSON.parse(res._body);
        assert.equal(body.ok, true);
        const m3 = body.models.find((m) => m.id === "minimax_api/MiniMax-M3");
        const m27 = body.models.find((m) => m.id === "minimax_api/MiniMax-M2.7");
        assert.ok(m3 && m27, "both builtins surface");
        assert.deepEqual(m3.contextWindowOptions, [512000, 1000000]);
        assert.deepEqual(m3.contextWindowOptionHints, { "1000000": "higher_usage" });
        assert.equal(m3.contextLimit, 512000, "engine tree limit.context → contextLimit fallback");
        assert.equal(
          m27.contextWindowOptions,
          undefined,
          "a model without options must stay field-free (the composer mounts no control)",
        );
        assert.equal(m27.contextWindowOptionHints, undefined);
        // currentContextWindow: recorded pick absent → the catalogue
        // contextLimit of the current model is the fallback.
        assert.equal(body.currentContextWindow, 512000);
      },
    );
  });

  test("a recorded cs.model.contextWindow wins over the catalogue fallback", () => {
    setBuiltinModelsMock(["MiniMax-M3"]);
    return withEngineBuiltinTree(
      {
        "MiniMax-M3": {
          limit: { context: 512000 },
          contextWindowOptions: [512000, 1000000],
        },
      },
      () => {
        const cs = fakeCs("minimax_api/MiniMax-M3");
        cs.model.contextWindow = 1000000;
        const res = fakeRes();
        modelRoute.handleGetModels(null, res, { cs, cid: "cid-u6-2" });
        const body = JSON.parse(res._body);
        assert.equal(body.currentContextWindow, 1000000);
      },
    );
  });

  test("engine-session minimax_api wire entries are annotated too (cross-client model change)", () => {
    setBuiltinModelsMock([]);
    return withEngineBuiltinTree(
      {
        "MiniMax-M3": {
          limit: { context: 512000 },
          contextWindowOptions: [512000, 1000000],
          contextWindowOptionHints: { "1000000": "higher_usage" },
        },
      },
      () => {
        const cs = fakeCs(undefined, [
          {
            ...MODEL_OPTION,
            options: [
              { value: "m:minimax_api:MiniMax-M3:u", name: "MiniMax-M3" },
            ],
          },
        ]);
        const res = fakeRes();
        modelRoute.handleGetModels(null, res, { cs, cid: "cid-u6-3" });
        const body = JSON.parse(res._body);
        const wire = body.models.find((m) => m.id === "m:minimax_api:MiniMax-M3:u");
        assert.ok(wire, "engine wire entry present");
        assert.deepEqual(wire.contextWindowOptions, [512000, 1000000]);
        assert.deepEqual(wire.contextWindowOptionHints, { "1000000": "higher_usage" });
      },
    );
  });
});

describe("handleSetModel — contextWindow (U6)", () => {
  test("a valid number is recorded on cs.model and echoed", async () => {
    const cs = fakeCs();
    const res = fakeRes();
    await modelRoute.handleSetModel(
      fakeReq({ model: "minimax_api/MiniMax-M3", contextWindow: 1000000 }),
      res,
      { cs, cid: "cid-u6-s1" },
    );
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.contextWindow, 1000000);
    assert.equal(cs.model.contextWindow, 1000000);
    assert.equal(typeof cs.model.contextWindowPickedAt, "number", "pick-stamp mirrors the ticket-08 pattern");
  });

  test("contextWindow-only payload works and does not touch the model", async () => {
    const cs = fakeCs("minimax_api/MiniMax-M3");
    const before = cs.model.name;
    const res = fakeRes();
    await modelRoute.handleSetModel(
      fakeReq({ contextWindow: 512000 }),
      res,
      { cs, cid: "cid-u6-s2" },
    );
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.contextWindow, 512000);
    assert.equal(body.model, undefined, "model-only fields stay out of the response");
    assert.equal(cs.model.name, before);
    assert.equal(cs.model.contextWindow, 512000);
  });

  test("null clears the recorded choice", async () => {
    const cs = fakeCs();
    cs.model.contextWindow = 1000000;
    const res = fakeRes();
    await modelRoute.handleSetModel(
      fakeReq({ model: "minimax_api/MiniMax-M2.7", contextWindow: null }),
      res,
      { cs, cid: "cid-u6-s3" },
    );
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.contextWindow, null);
    assert.equal("contextWindow" in cs.model, false, "clear deletes the field, not zero it");
  });

  test("invalid values are a 400, never a silent drop", async () => {
    for (const bad of [0, -512000, 1.5, "1000000", Number.MAX_SAFE_INTEGER + 1]) {
      const cs = fakeCs();
      const res = fakeRes();
      await modelRoute.handleSetModel(
        fakeReq({ contextWindow: bad }),
        res,
        { cs, cid: "cid-u6-s4" },
      );
      assert.equal(res._status, 400, `expected 400 for ${JSON.stringify(bad)}`);
      const body = JSON.parse(res._body);
      assert.equal(body.ok, false);
      assert.equal(cs.model.contextWindow, undefined);
    }
  });

  test("absent field leaves the recorded value alone (independence from model/thinking)", async () => {
    const cs = fakeCs();
    cs.model.contextWindow = 1000000;
    const res = fakeRes();
    await modelRoute.handleSetModel(
      fakeReq({ thinking: "high" }),
      res,
      { cs, cid: "cid-u6-s5" },
    );
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.contextWindow, undefined, "absent field not echoed");
    assert.equal(cs.model.contextWindow, 1000000);
  });
});

// ============================================================
// M3-B14 — THE GATE, AS THE ROUTE SEES IT.
//
// The executor-level tests in `test/lib/engine/model-writes.test.js`
// cover the verdict, the channel precision and the 501 payload against
// synthetic providers. What is left for this file is the two properties
// only the route can be wrong about:
//
//   1. THE ROUTE DOES NOT CATCH THE GATE. If it did, a provider that
//      cannot perform an effort write would produce a 200 with a
//      `warning` string — #110's fake success in the exact shape the
//      capability gate was built to prevent, and harder to notice than
//      a 501 because the picker would still move.
//   2. THE GATE'S REPORT NEVER REACHES THE WIRE. The executors gained a
//      `gate` field in M3-B14; the response body is byte-identical to
//      the pre-B14 one, and this is what says so.
//
// The refusal path itself is NOT driven from here. Reaching it needs a
// provider that denies the dedicated writers, and no registered provider
// does — the file boots the real registry once, without a `?bust=`
// parameter, so there is no seam to swap one in. Asserting a 501 here
// would mean inventing a fake registry, and the real-registry
// "still 200 under both transports" assertion below is the fact that
// actually matters for a shipped user.
// ============================================================

const ENV_TRANSPORT = process.env.MCODE_WEBUI_TRANSPORT || "acp";

/** A live session on the effort channel: the shape #58 really gates. */
function gatedCs() {
  const cs = fakeCs("minimax_api/MiniMax-M3.1-Flash-Preview", [
    {
      type: "select",
      id: "model",
      name: "Model",
      currentValue: "minimax_api/MiniMax-M3.1-Flash-Preview",
      options: [
        { value: "minimax_api/MiniMax-M3.1-Flash-Preview", name: "M3.1-Flash-Preview" },
      ],
    },
    { type: "select", id: "thinkingEffort", name: "Thinking effort", currentValue: "low" },
  ]);
  cs.mcodeSessionId = "mvs_b14_0000000000000000000000";
  return cs;
}

describe("handleSetModel — the M3-B14 gate, from the route", () => {
  test("an effort write on a live session is 200 under the real registry, on both transports", async () => {
    // The shipped behaviour change, stated as the half that must NOT
    // change: no registered provider denies `setThinkingEffort`, so
    // adding the gate removes nothing for any user today.
    const cs = gatedCs();
    const res = fakeRes();
    await modelRoute.handleSetModel(
      fakeReq({ model: "minimax_api/MiniMax-M3.1-Flash-Preview", thinking: "high" }),
      res,
      { cs, cid: "cid-b14" },
    );
    assert.equal(res._status, 200, ENV_TRANSPORT);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.mcodeSynced, true);
    assert.equal(body.thinkingSynced, true);
    assert.equal(body.warning, undefined, "no refusal was invented");
  });

  test("the response body is byte-identical to the pre-M3-B14 one — no `gate` field", async () => {
    // Asserted as a KEY SET rather than a snapshot string, because the
    // keys are the contract and the order is not: what must not appear is
    // a new field, and the one this batch could most plausibly have added
    // is the gate's own report.
    const cs = gatedCs();
    const res = fakeRes();
    await modelRoute.handleSetModel(
      fakeReq({ model: "minimax_api/MiniMax-M3.1-Flash-Preview", thinking: "high" }),
      res,
      { cs, cid: "cid-b14" },
    );
    assert.deepEqual(
      Object.keys(JSON.parse(res._body)).sort(),
      ["mcodeSynced", "model", "ok", "thinking", "thinkingSynced"],
    );
  });

  test("neither handler catches — a gate refusal must reach app.js, not a 200", () => {
    // Static-source tripwire, and the only kind available without a
    // render/registry seam. The thing it forbids is specific: a `catch`
    // around the push. A `catch` here would turn the engine gate's 501
    // into `warning: <message>` on a 200 — the one outcome B9's module
    // header calls the purest form of fake success, and the one a reader
    // cannot spot because the picker would still move.
    const src = readFileSync(fileURLToPath(absPath("routes/model.js")), "utf8");
    for (const handler of ["handleSetModel", "handleSetPermissions"]) {
      const start = src.indexOf(`export async function ${handler}`);
      assert.ok(start > 0, `${handler} not found`);
      // The handler ends at the next top-level `export` (or EOF).
      const next = src.indexOf("\nexport ", start + 1);
      const body = src.slice(start, next === -1 ? undefined : next);
      assert.doesNotMatch(body, /\bcatch\b/, `${handler} must not catch the gate's error`);
    }
  });
});

describe("handleSetPermissions — the M3-B14 gate, from the route", () => {
  test("a permission write is 200 under the real registry, unchanged", async () => {
    const cs = gatedCs();
    const res = fakeRes();
    await modelRoute.handleSetPermissions(fakeReq({ mode: "ask" }), res, { cs, cid: "cid-b14" });
    assert.equal(res._status, 200, ENV_TRANSPORT);
    const body = JSON.parse(res._body);
    assert.deepEqual(Object.keys(body).sort(), ["mcodeSynced", "ok", "permissions"]);
    assert.equal(body.mcodeSynced, true);
    assert.equal(body.warning, undefined);
  });

  test("no session is still 200 with the local-only warning, gate or no gate", async () => {
    // The path that returns before the gate. A 501 here would be a
    // regression the other way: a request that never reaches the engine
    // cannot be a fake success, so there is nothing for the capability to
    // be honest about, and the recorded pick is the truthful answer.
    const cs = fakeCs();
    const res = fakeRes();
    await modelRoute.handleSetPermissions(fakeReq({ mode: "ask" }), res, { cs, cid: "cid-b14" });
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.mcodeSynced, false);
    assert.equal(body.warning, "no mcode session yet — applies to the next one");
  });
});
