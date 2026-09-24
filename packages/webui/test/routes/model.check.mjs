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

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupMocks, absPath } from "../helpers/_setup.js";

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
    assert.equal(body.models[0].name, "MiniMax-M3");
    // The engine's encoded value, so it round-trips through /api/set-model.
    assert.equal(body.current, "minimax_api:MiniMax-M3");
  });

  test("before a session exists: no catalogue and no claimed current model", () => {
    // `current` is null rather than webui's DEFAULT_MODEL: the engine has not
    // named a session model yet, and DEFAULT_MODEL is a different encoding
    // (`minimax_api/MiniMax-M3`) from the engine's (`m:<provider>:<model>:...`),
    // so reporting it claimed a model the session was not running.
    const cs = fakeCs("minimax_api/MiniMax-M3");
    const ctx = { cs };
    const res = fakeRes();
    modelRoute.handleGetModels(null, res, ctx);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.deepEqual(body.models, []);
    assert.equal(body.current, null);
    assert.equal(body.reason, "no_session_config");
    // and it must not write that value back into the state a prompt would use
    assert.equal(cs.model.name, "minimax_api/MiniMax-M3");
  });

  test("partitions the catalogue by provider, parsed out of the engine id", () => {
    const ctx = {
      cs: fakeCs(undefined, [
        {
          ...MODEL_OPTION,
          options: [
            { value: "m:minimax_api:MiniMax-M3:v:default", name: "MiniMax-M3" },
            { value: "m:anthropic_api:claude-opus:v:default", name: "claude-opus" },
            { value: "m:minimax_api:MiniMax-M2.7:v:default", name: "MiniMax-M2.7" },
          ],
        },
      ]),
    };
    const res = fakeRes();
    modelRoute.handleGetModels(null, res, ctx);
    const body = JSON.parse(res._body);
    assert.deepEqual(
      body.groups.map((g) => g.id),
      ["minimax_api", "anthropic_api"],
    );
    // Partitioning necessarily reorders an interleaved catalogue, so the
    // contract is: every entry appears exactly once, and each group keeps the
    // catalogue's relative order within itself.
    assert.deepEqual(
      [...new Set(body.groups.flatMap((g) => g.models.map((m) => m.id)))].sort(),
      [...new Set(body.models.map((m) => m.id))].sort(),
    );
    assert.equal(
      body.groups.flatMap((g) => g.models).length,
      body.models.length,
      "grouping must not drop or duplicate entries",
    );
    assert.deepEqual(
      body.groups[0].models.map((m) => m.id),
      ["m:minimax_api:MiniMax-M3:v:default", "m:minimax_api:MiniMax-M2.7:v:default"],
      "a group preserves the catalogue order of its own entries",
    );
    assert.equal(body.models[0].provider, "minimax_api");
    // No overlay on disk → the group label falls back to the provider id.
    assert.equal(body.groups[0].label, "minimax_api");
  });

  test("an id outside the m:<provider>:<model> encoding still groups, by its provider/ prefix", () => {
    const ctx = {
      cs: fakeCs(undefined, [
        {
          ...MODEL_OPTION,
          options: [
            { value: "minimax_api/MiniMax-M3", name: "MiniMax-M3" },
            { value: "openai/gpt-5", name: "gpt-5" },
          ],
        },
      ]),
    };
    const res = fakeRes();
    modelRoute.handleGetModels(null, res, ctx);
    const body = JSON.parse(res._body);
    assert.deepEqual(
      body.groups.map((g) => g.id),
      ["minimax_api", "openai"],
    );
  });

  test("models.json overlay renames a group and enriches an entry, without inventing models", () => {
    const dir = mkdtempSync(join(tmpdir(), "webui-models-"));
    const cfg = join(dir, "models.json");
    writeFileSync(
      cfg,
      JSON.stringify({
        providers: [
          {
            id: "minimax_api",
            label: "MiniMax",
            models: [{ id: "MiniMax-M3", label: "M3 (国内)", contextLimit: 1000000 }],
          },
        ],
      }),
    );
    process.env.MCODE_WEBUI_MODELS_CONFIG = cfg;
    try {
      // The engine's own encoding, as routes/model.js documents it. The
      // overlay matches on the model segment, so the `m:`/`:v:` framing is
      // stripped before lookup.
      const res = fakeRes();
      modelRoute.handleGetModels(null, res, {
        cs: fakeCs(undefined, [
          {
            ...MODEL_OPTION,
            options: [
              { value: "m:minimax_api:MiniMax-M3:v:default", name: "MiniMax-M3" },
              { value: "m:minimax_api:MiniMax-M2.7:v:default", name: "MiniMax-M2.7" },
            ],
          },
        ]),
      });
      const body = JSON.parse(res._body);
      assert.equal(body.source, "acp-session-config+overlay");
      const byId = Object.fromEntries(body.groups.flatMap((g) => g.models).map((m) => [m.id, m]));
      const m3 = byId["m:minimax_api:MiniMax-M3:v:default"];
      assert.equal(m3.label, "M3 (国内)");
      assert.equal(m3.contextLimit, 1000000);
      // `name` still carries the engine's own label so older clients are unaffected.
      assert.equal(m3.name, "MiniMax-M3");
      // An entry the overlay does not mention is still offered, unrenamed.
      assert.equal(byId["m:minimax_api:MiniMax-M2.7:v:default"].label, "MiniMax-M2.7");
      assert.equal(body.groups[0].label, "MiniMax");
      // An overlay entry the engine does not list must not be offered.
      assert.equal(body.models.length, 2);
    } finally {
      delete process.env.MCODE_WEBUI_MODELS_CONFIG;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing or malformed models.json is not an error", () => {
    process.env.MCODE_WEBUI_MODELS_CONFIG = join(tmpdir(), "webui-does-not-exist.json");
    try {
      const res = fakeRes();
      modelRoute.handleGetModels(null, res, { cs: fakeCs(undefined, [MODEL_OPTION]) });
      const body = JSON.parse(res._body);
      assert.equal(body.source, "acp-session-config");
      assert.equal(body.models.length, 2);
    } finally {
      delete process.env.MCODE_WEBUI_MODELS_CONFIG;
    }
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
