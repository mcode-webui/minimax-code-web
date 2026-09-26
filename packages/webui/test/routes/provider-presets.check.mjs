// webui/test/routes/provider-presets.check.mjs
// Route-level tests for server/routes/providers.js — preset
// gallery + one-click enable (ticket 02).
//
// Why this test exists:
//   - The enable endpoint materialises a preset into the
//     user-level providers.json. The materialisation is the only
//     API surface that wraps `writeProvidersConfig` from outside
//     the route, so its masking + atomic-write + SSE-broadcast
//     contracts must be tested at the route layer (the underlying
//     lib tests cover the building blocks).
//   - Idempotency: a second call to enable for the same id must
//     return 200 with `alreadyEnabled: true` and the existing
//     record. A naive "always write" implementation would clobber
//     the user's later edits to apiKey / baseURL.
//   - Custom-vs-preset id clash: a user with a custom provider
//     named "zhipu" must not be silently overwritten by the
//     enable handler. The handler preserves the existing record
//     (idempotent).
//
// Test strategy: same isolation pattern as `routes/providers.check.mjs` —
// per-test tmp paths for MCODE_WEBUI_DATA_DIR, no shared state.

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const absPath = (rel) =>
  pathToFileURL(join(import.meta.dirname, "..", "..", "server", rel)).href;

const providersRoute = await import(absPath("routes/providers.js"));
const providersConfig = await import(absPath("lib/providers-config.js"));
const presets = await import(absPath("lib/provider-presets.js"));

let _tmpDataDir;
let _tmpCwd;
let _origDataDir;
let _origCwdEnv;
let _origCwd;

before(async () => {
  _tmpDataDir = mkdtempSync(join(tmpdir(), "webui-presets-route-"));
  _tmpCwd = mkdtempSync(join(tmpdir(), "webui-presets-route-cwd-"));
  _origDataDir = process.env.MCODE_WEBUI_DATA_DIR;
  _origCwdEnv = process.env.MCODE_WEBUI_MODELS_CONFIG;
  _origCwd = process.cwd();
  process.env.MCODE_WEBUI_DATA_DIR = _tmpDataDir;
  process.env.MCODE_WEBUI_MODELS_CONFIG = "";
  process.chdir(_tmpCwd);
});

after(async () => {
  if (_origDataDir === undefined) delete process.env.MCODE_WEBUI_DATA_DIR;
  else process.env.MCODE_WEBUI_DATA_DIR = _origDataDir;
  if (_origCwdEnv === undefined) delete process.env.MCODE_WEBUI_MODELS_CONFIG;
  else process.env.MCODE_WEBUI_MODELS_CONFIG = _origCwdEnv;
  try { process.chdir(_origCwd); } catch {}
  if (_tmpDataDir) try { rmSync(_tmpDataDir, { recursive: true, force: true }); } catch {}
  if (_tmpCwd) try { rmSync(_tmpCwd, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  const cwdFile = join(_tmpCwd, "models.json");
  if (existsSync(cwdFile)) rmSync(cwdFile);
  const userFile = join(_tmpDataDir, "providers.json");
  if (existsSync(userFile)) rmSync(userFile);
});

function fakeReq(url) {
  return { url };
}
function fakeRes() {
  return {
    _status: null,
    _headers: null,
    _body: null,
    writeHead(s, h) { this._status = s; if (h) this._headers = h; },
    end(b) { this._body = b; },
  };
}
function getBody(res) {
  return JSON.parse(res._body);
}

// =====================================================================
// GET /api/providers/presets — gallery surface.
// =====================================================================

describe("handleGetPresets — /api/providers/presets GET", () => {
  test("returns all 10 presets with enabled=false when nothing is configured", () => {
    const res = fakeRes();
    providersRoute.handleGetPresets(null, res, {});
    assert.equal(res._status, 200);
    const body = getBody(res);
    assert.equal(body.ok, true);
    assert.equal(body.version, 2);
    assert.equal(body.presets.length, 10);
    for (const p of body.presets) {
      assert.equal(p.enabled, false, `preset '${p.id}' should start as enabled=false`);
    }
    assert.deepEqual(body.enabledIds, []);
  });

  test("preset entries carry id, label, protocol, auth (no key), models", () => {
    const res = fakeRes();
    providersRoute.handleGetPresets(null, res, {});
    const body = getBody(res);
    const zhipu = body.presets.find((p) => p.id === "zhipu");
    assert.ok(zhipu);
    assert.equal(zhipu.label, "智谱 (Zhipu / GLM)");
    assert.equal(zhipu.protocol, "openai");
    assert.equal(zhipu.auth.type, "byok");
    assert.equal(zhipu.auth.baseURL, "https://open.bigmodel.cn/api/paas/v4/");
    // apiKey / apiKeyMasked MUST NOT appear in the gallery payload.
    assert.equal(zhipu.auth.apiKey, undefined);
    assert.equal(zhipu.auth.apiKeyMasked, undefined);
    assert.equal(zhipu.auth.hasKey, undefined);
    assert.ok(zhipu.models.length > 0);
  });

  test("enabled=true once the preset id is configured", () => {
    // Pre-populate the user-level file with a provider that
    // matches a preset id.
    writeFileSync(
      join(_tmpDataDir, "providers.json"),
      JSON.stringify({
        version: 2,
        providers: [
          {
            id: "zhipu",
            label: "Custom label",
            protocol: "openai",
            auth: { type: "byok", apiKey: "sk-realkey-aaaa" },
            models: [{ id: "glm-4-plus" }],
          },
        ],
      }),
    );
    const res = fakeRes();
    providersRoute.handleGetPresets(null, res, {});
    const body = getBody(res);
    const zhipu = body.presets.find((p) => p.id === "zhipu");
    assert.equal(zhipu.enabled, true);
    assert.ok(body.enabledIds.includes("zhipu"));
  });

  test("custom (non-preset) configured providers do NOT show as enabled", () => {
    writeFileSync(
      join(_tmpDataDir, "providers.json"),
      JSON.stringify({
        version: 2,
        providers: [
          {
            id: "my-custom",
            label: "Custom",
            protocol: "openai",
            auth: { type: "byok", apiKey: "sk-realkey-aaaa" },
            models: [],
          },
        ],
      }),
    );
    const res = fakeRes();
    providersRoute.handleGetPresets(null, res, {});
    const body = getBody(res);
    assert.equal(body.enabledIds.length, 0, "custom providers are not preset-flagged");
    for (const p of body.presets) {
      assert.equal(p.enabled, false);
    }
  });
});

// =====================================================================
// POST /api/providers/preset/:id/enable — materialise + hot apply.
// =====================================================================

describe("handleEnablePreset — /api/providers/preset/:id/enable POST", () => {
  test("unknown preset id returns 400 UNKNOWN_PRESET", async () => {
    const res = fakeRes();
    await providersRoute.handleEnablePreset(
      fakeReq("/api/providers/preset/does-not-exist/enable"),
      res,
      {},
    );
    assert.equal(res._status, 400);
    const body = getBody(res);
    assert.equal(body.ok, false);
    assert.equal(body.code, "UNKNOWN_PRESET");
    assert.match(body.error, /not in the catalogue/);
  });

  test("valid preset id materialises with enabled=true and empty apiKey", async () => {
    const res = fakeRes();
    await providersRoute.handleEnablePreset(
      fakeReq("/api/providers/preset/zhipu/enable"),
      res,
      {},
    );
    assert.equal(res._status, 200);
    const body = getBody(res);
    assert.equal(body.ok, true);
    assert.equal(body.alreadyEnabled, false);
    assert.equal(body.provider.id, "zhipu");
    assert.equal(body.provider.enabled, true);
    assert.equal(body.provider.preset, "zhipu");
    // Masked shape — the persisted record must not echo the key
    // because templates never carry one.
    assert.equal(body.provider.auth.hasKey, false);
    assert.equal(body.provider.auth.apiKeyMasked, "");
    // Template models carried through.
    assert.ok(body.provider.models.length >= 1);
    const glm = body.provider.models.find((m) => m.id === "glm-4-plus");
    assert.ok(glm);
    assert.equal(glm.contextLimit, 128000);
  });

  test("materialisation persists to the user-level file (atomic)", async () => {
    await providersRoute.handleEnablePreset(
      fakeReq("/api/providers/preset/kimi/enable"),
      fakeRes(),
      {},
    );
    const onDisk = JSON.parse(
      readFileSync(providersConfig.getUserLevelPath(), "utf8"),
    );
    const kimi = onDisk.providers.find((p) => p.id === "kimi");
    assert.ok(kimi, "kimi persisted");
    assert.equal(kimi.enabled, true);
    assert.equal(kimi.preset, "kimi");
    assert.equal(kimi.auth.apiKey, "");
    assert.equal(kimi.protocol, "openai");
    assert.ok(kimi.models.length > 0);
  });

  test("hot reload: a follow-up GET /api/providers sees the new preset", async () => {
    await providersRoute.handleEnablePreset(
      fakeReq("/api/providers/preset/bailian/enable"),
      fakeRes(),
      {},
    );
    const res = fakeRes();
    providersRoute.handleGetProviders(null, res, {});
    const body = getBody(res);
    const bailian = body.providers.find((p) => p.id === "bailian");
    assert.ok(bailian, "bailian visible after enable");
    assert.equal(bailian.preset, "bailian");
    assert.ok(bailian.models.length > 0);
  });

  test("idempotent: a second enable returns alreadyEnabled=true", async () => {
    const res1 = fakeRes();
    await providersRoute.handleEnablePreset(
      fakeReq("/api/providers/preset/volcano/enable"),
      res1,
      {},
    );
    assert.equal(res1._status, 200);
    const body1 = getBody(res1);
    assert.equal(body1.alreadyEnabled, false);

    const res2 = fakeRes();
    await providersRoute.handleEnablePreset(
      fakeReq("/api/providers/preset/volcano/enable"),
      res2,
      {},
    );
    assert.equal(res2._status, 200);
    const body2 = getBody(res2);
    assert.equal(body2.ok, true);
    assert.equal(body2.alreadyEnabled, true);
    // Same id returned, masked as usual.
    assert.equal(body2.provider.id, "volcano");
    assert.equal(body2.provider.auth.hasKey, false);
  });

  test("user-edited apiKey survives a second enable (no clobber)", async () => {
    // First enable — fresh template.
    await providersRoute.handleEnablePreset(
      fakeReq("/api/providers/preset/mimo/enable"),
      fakeRes(),
      {},
    );
    // User fills the apiKey via a normal PUT.
    const onDiskPath = providersConfig.getUserLevelPath();
    let onDisk = JSON.parse(readFileSync(onDiskPath, "utf8"));
    const mimoIdx = onDisk.providers.findIndex((p) => p.id === "mimo");
    onDisk.providers[mimoIdx].auth.apiKey = "sk-realkey-user-filled-key";
    writeFileSync(onDiskPath, JSON.stringify(onDisk, null, 2), "utf8");

    // Second enable must NOT clobber the key.
    const res = fakeRes();
    await providersRoute.handleEnablePreset(
      fakeReq("/api/providers/preset/mimo/enable"),
      res,
      {},
    );
    assert.equal(res._status, 200);
    const body = getBody(res);
    assert.equal(body.alreadyEnabled, true);

    onDisk = JSON.parse(readFileSync(onDiskPath, "utf8"));
    const mimo = onDisk.providers.find((p) => p.id === "mimo");
    assert.equal(
      mimo.auth.apiKey,
      "sk-realkey-user-filled-key",
      "user apiKey must survive a second enable",
    );
  });

  test("id clash: enabling a preset that shares an id with a custom provider is a no-op", async () => {
    // Pre-populate with a custom provider named "minimax" — the
    // preset template's id. The enable handler must preserve the
    // existing record rather than overwrite it.
    writeFileSync(
      join(_tmpDataDir, "providers.json"),
      JSON.stringify({
        version: 2,
        providers: [
          {
            id: "minimax",
            label: "My Custom minimax",
            protocol: "openai",
            auth: { type: "byok", apiKey: "sk-realkey-custom" },
            models: [{ id: "custom-model" }],
          },
        ],
      }),
    );

    const res = fakeRes();
    await providersRoute.handleEnablePreset(
      fakeReq("/api/providers/preset/minimax/enable"),
      res,
      {},
    );
    assert.equal(res._status, 200);
    const body = getBody(res);
    assert.equal(body.alreadyEnabled, true);
    assert.equal(body.provider.label, "My Custom minimax");
    assert.equal(body.provider.models[0].id, "custom-model");

    // The file on disk still has the custom record unchanged.
    const onDisk = JSON.parse(readFileSync(providersConfig.getUserLevelPath(), "utf8"));
    const minimax = onDisk.providers.find((p) => p.id === "minimax");
    assert.equal(minimax.label, "My Custom minimax");
    assert.equal(minimax.auth.apiKey, "sk-realkey-custom");
  });

  test("enabling a preset that does NOT yet exist preserves any other user providers", async () => {
    // Pre-populate with a custom provider alongside the one
    // we're about to enable.
    writeFileSync(
      join(_tmpDataDir, "providers.json"),
      JSON.stringify({
        version: 2,
        providers: [
          {
            id: "my-other-custom",
            label: "Other",
            protocol: "openai",
            auth: { type: "byok", apiKey: "sk-realkey-other" },
            models: [{ id: "om" }],
          },
        ],
      }),
    );

    await providersRoute.handleEnablePreset(
      fakeReq("/api/providers/preset/openrouter/enable"),
      fakeRes(),
      {},
    );

    const onDisk = JSON.parse(readFileSync(providersConfig.getUserLevelPath(), "utf8"));
    const ids = onDisk.providers.map((p) => p.id).sort();
    assert.deepEqual(ids, ["my-other-custom", "openrouter"]);
    // Other-custom record untouched.
    const other = onDisk.providers.find((p) => p.id === "my-other-custom");
    assert.equal(other.auth.apiKey, "sk-realkey-other");
  });

  test("the Hono-style call (params.id) resolves the right preset", async () => {
    // The Hono layer passes `{ id }` via params rather than
    // letting the handler parse req.url. The handler accepts
    // both forms — assert the params form works.
    const res = fakeRes();
    await providersRoute.handleEnablePreset(
      { url: "/api/providers/preset/anything/else" }, // wrong URL
      res,
      {},
      { id: "codex" }, // right id
    );
    assert.equal(res._status, 200);
    const body = getBody(res);
    assert.equal(body.provider.id, "codex");
    assert.equal(body.provider.protocol, "openai");
  });

  test("the SSE broadcast frame carries the masked materialised record", async () => {
    // The enable handler reuses pushProvidersUpdated. We can't
    // intercept the SSE write without a real socket, so the
    // masking contract is pinned here by reading the persisted
    // record via the public view (the SSE frame shape mirrors
    // publicView).
    await providersRoute.handleEnablePreset(
      fakeReq("/api/providers/preset/claude-code/enable"),
      fakeRes(),
      {},
    );
    const res = fakeRes();
    providersRoute.handleGetProviders(null, res, {});
    const body = getBody(res);
    const claude = body.providers.find((p) => p.id === "claude-code");
    assert.ok(claude);
    assert.equal(claude.protocol, "anthropic");
    assert.equal(claude.preset, "claude-code");
    // No plaintext key on the wire.
    assert.equal(res._body.includes("realkey"), false);
    assert.equal(claude.auth.apiKey, undefined);
    assert.equal(claude.auth.apiKeyMasked, "");
  });

  test("empty id returns 400", async () => {
    const res = fakeRes();
    await providersRoute.handleEnablePreset(
      { url: "/api/providers/preset//enable" },
      res,
      {},
      { id: "" },
    );
    assert.equal(res._status, 400);
    const body = getBody(res);
    assert.equal(body.code, "UNKNOWN_PRESET");
  });
});
