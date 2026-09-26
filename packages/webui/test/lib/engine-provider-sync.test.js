// webui/test/lib/engine-provider-sync.test.js
// Pure helpers + sync flow for `lib/engine-provider-sync.js` (ticket 05).
//
// What we pin here:
//   - providerKeyFromId: reserved engine ids get a `-byok` suffix;
//     everything else round-trips; non-conforming ids return "".
//   - modelKeyFromId: same shape as providerKeyFromId, no reserved handling.
//   - toEngineCustomProvider: every field of the v2 schema is mapped; the
//     four ineligible shapes (coding-plan, disabled, empty apiKey,
//     missing baseURL, unknown protocol) yield null; the engine api
//     format is picked by protocol.
//   - syncProvidersToEngine: writes an atomic YAML that preserves the
//     operator's other sections (provider.*, defaultModel, …), only
//     `custom_provider` is owned by the helper; an empty eligible list is
//     a no-op (operator's manual entries are kept); engine-config read
//     failures are surfaced as a structured error.
//   - syncProvidersFromPutBody: applies the keep-key convention before
//     the sync (same path the routes use for the user-level write), so
//     the engine sees the resolved apiKey.

import { test, describe, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";

const absPath = (rel) =>
  import.meta.resolve
    ? import.meta.resolve(rel)
    : new URL(rel, import.meta.url).href;

const {
  resolveEngineDataDir,
  providerKeyFromId,
  modelKeyFromId,
  toEngineCustomProvider,
  syncProvidersToEngine,
  syncProvidersFromPutBody,
} = await import(
  new URL("../../server/lib/engine-provider-sync.js", import.meta.url).href
);

// temp data dir scoped to this test file so the helper's
// `resolveEngineDataDir()` (env-driven) does not point at the host's
// real engine config. Set at module load time — the helper reads
// `process.env` at call time, but Node's test runner may run setup
// before `before()` fires, and a stable env at import time is the
// safest contract.
const _origMinimax = process.env.MINIMAX_DATA_DIR;
const _origMavis = process.env.MAVIS_DATA_DIR;
const _tmpDataDir = mkdtempSync(join(tmpdir(), "minimax-code-engine-sync-"));
process.env.MINIMAX_DATA_DIR = _tmpDataDir;
delete process.env.MAVIS_DATA_DIR;

after(() => {
  if (_origMinimax === undefined) delete process.env.MINIMAX_DATA_DIR;
  else process.env.MINIMAX_DATA_DIR = _origMinimax;
  if (_origMavis === undefined) delete process.env.MAVIS_DATA_DIR;
  else process.env.MAVIS_DATA_DIR = _origMavis;
  rmSync(_tmpDataDir, { recursive: true, force: true });
});

describe("resolveEngineDataDir — env precedence", () => {
  test("MINIMAX_DATA_DIR wins", () => {
    const prev = process.env.MINIMAX_DATA_DIR;
    process.env.MINIMAX_DATA_DIR = "/tmp/env-wins";
    try {
      assert.equal(resolveEngineDataDir(), "/tmp/env-wins");
    } finally {
      // Restore so the sync tests downstream still resolve to the
      // file-scoped `_tmpDataDir`.
      if (prev === undefined) delete process.env.MINIMAX_DATA_DIR;
      else process.env.MINIMAX_DATA_DIR = prev;
    }
  });
  test("falls back to ~/.minimax when neither env is set", () => {
    // Restore the per-test env to the no-env state only for this test;
    // every other test in the file relies on the `before` hook's
    // `_tmpDataDir` so we MUST put it back before returning, or the
    // sync tests downstream would resolve to the host's real config.
    const prev = process.env.MINIMAX_DATA_DIR;
    const prevMavis = process.env.MAVIS_DATA_DIR;
    delete process.env.MINIMAX_DATA_DIR;
    delete process.env.MAVIS_DATA_DIR;
    try {
      assert.match(resolveEngineDataDir(), /[/\\]\.minimax$/);
    } finally {
      if (prev === undefined) delete process.env.MINIMAX_DATA_DIR;
      else process.env.MINIMAX_DATA_DIR = prev;
      if (prevMavis === undefined) delete process.env.MAVIS_DATA_DIR;
      else process.env.MAVIS_DATA_DIR = prevMavis;
    }
  });
});

describe("providerKeyFromId", () => {
  test("round-trips a normal id", () => {
    assert.equal(providerKeyFromId("byok-zhipu"), "byok-zhipu");
    assert.equal(providerKeyFromId("kimi"), "kimi");
  });
  test("disambiguates engine-internal reserved ids with -byok suffix", () => {
    // The webui id validator allows these names (the engine just would
    // not — operators might already have one in their providers.json).
    // Projection must not collide with the engine's internal providers.
    assert.equal(providerKeyFromId("minimax"), "minimax-byok");
    assert.equal(providerKeyFromId("minimax_api"), "minimax_api-byok");
    assert.equal(providerKeyFromId("provider"), "provider-byok");
    assert.equal(providerKeyFromId("custom_provider"), "custom_provider-byok");
  });
  test("rejects ids outside the provider-key character class", () => {
    assert.equal(providerKeyFromId(""), "");
    assert.equal(providerKeyFromId("spaces are bad"), "");
    assert.equal(providerKeyFromId("slashes/are/bad"), "");
    // Underscores / hyphens / dots in the middle are fine (matches the
    // webui v2 validator's provider id contract).
    assert.equal(providerKeyFromId("a_b.c-d"), "a_b.c-d");
  });
});

describe("modelKeyFromId", () => {
  test("round-trips a normal id", () => {
    assert.equal(modelKeyFromId("glm-5.3"), "glm-5.3");
    assert.equal(modelKeyFromId("claude-sonnet-4-5"), "claude-sonnet-4-5");
  });
  test("rejects ids outside the model-key character class", () => {
    assert.equal(modelKeyFromId(""), "");
    assert.equal(modelKeyFromId("with space"), "");
  });
});

describe("toEngineCustomProvider — eligibility", () => {
  const base = {
    id: "byok-zhipu",
    label: "Zhipu BYOK",
    enabled: true,
    protocol: "openai",
    auth: { type: "byok", apiKey: "sk-fake", baseURL: "https://example.com/v1" },
    models: [{ id: "glm-5.3" }],
  };

  test("eligible byok provider maps cleanly", () => {
    const out = toEngineCustomProvider(base);
    assert.ok(out, "eligible");
    assert.equal(out.key, "byok-zhipu");
    assert.equal(out.entry.name, "Zhipu BYOK");
    assert.equal(out.entry.kind, "custom");
    assert.equal(out.entry.enabled, true);
    assert.equal(out.entry.api, "openai-completions");
    assert.equal(out.entry.options.apiKey, "sk-fake");
    assert.equal(out.entry.options.baseURL, "https://example.com/v1");
    assert.equal(out.entry.options.authMode, "api-key");
    assert.deepEqual(out.entry.models, { "glm-5.3": {} });
  });

  test("coding-plan providers are skipped (out of scope for byok projection)", () => {
    const p = { ...base, auth: { type: "coding-plan", apiKey: "tk-fake", baseURL: "https://example.com" } };
    assert.equal(toEngineCustomProvider(p), null);
  });

  test("disabled providers are skipped", () => {
    const p = { ...base, enabled: false };
    assert.equal(toEngineCustomProvider(p), null);
  });

  test("providers without an apiKey are skipped", () => {
    const p = { ...base, auth: { type: "byok", baseURL: "https://example.com/v1" } };
    assert.equal(toEngineCustomProvider(p), null);
    // Also: apiKey must be a non-empty trimmed string.
    const p2 = { ...base, auth: { type: "byok", apiKey: "   ", baseURL: "https://example.com/v1" } };
    assert.equal(toEngineCustomProvider(p2), null);
  });

  test("providers without a baseURL are skipped", () => {
    const p = { ...base, auth: { type: "byok", apiKey: "sk-fake" } };
    assert.equal(toEngineCustomProvider(p), null);
    const p2 = { ...base, auth: { type: "byok", apiKey: "sk-fake", baseURL: "  " } };
    assert.equal(toEngineCustomProvider(p2), null);
  });

  test("unknown protocol → skipped", () => {
    const p = { ...base, protocol: "cohere" };
    assert.equal(toEngineCustomProvider(p), null);
  });

  test("null / non-object → null", () => {
    assert.equal(toEngineCustomProvider(null), null);
    assert.equal(toEngineCustomProvider("string"), null);
    assert.equal(toEngineCustomProvider(undefined), null);
  });

  test("id that hits an engine-reserved word gets the -byok suffix", () => {
    const p = {
      ...base,
      id: "minimax",
      label: "Custom MiniMax-shaped alias",
    };
    const out = toEngineCustomProvider(p);
    assert.ok(out);
    assert.equal(out.key, "minimax-byok");
  });

  test("non-conforming id (spaces) → skipped", () => {
    const p = { ...base, id: "byok with space" };
    assert.equal(toEngineCustomProvider(p), null);
  });
});

describe("toEngineCustomProvider — protocol → engine api mapping", () => {
  test("openai → openai-completions", () => {
    const p = { ...base({ id: "p1", protocol: "openai" }) };
    assert.equal(toEngineCustomProvider(p).entry.api, "openai-completions");
  });
  test("anthropic → anthropic-messages", () => {
    const p = { ...base({ id: "p2", protocol: "anthropic" }) };
    assert.equal(toEngineCustomProvider(p).entry.api, "anthropic-messages");
  });
  test("gemini → openai-completions (Gemini OpenAI-compat endpoint)", () => {
    const p = { ...base({ id: "p3", protocol: "gemini" }) };
    assert.equal(toEngineCustomProvider(p).entry.api, "openai-completions");
  });
  test("missing protocol defaults to openai-completions", () => {
    const p = {
      id: "p4",
      label: "P4",
      enabled: true,
      auth: { type: "byok", apiKey: "sk", baseURL: "https://x/v1" },
      models: [],
    };
    assert.equal(toEngineCustomProvider(p).entry.api, "openai-completions");
  });

  function base(overrides) {
    return {
      label: "x",
      enabled: true,
      protocol: "openai",
      auth: { type: "byok", apiKey: "sk-fake", baseURL: "https://x/v1" },
      models: [],
      ...overrides,
    };
  }
});

describe("toEngineCustomProvider — model metadata mapping", () => {
  test("contextLimit → limit.context", () => {
    const p = {
      id: "p1",
      label: "p1",
      enabled: true,
      protocol: "openai",
      auth: { type: "byok", apiKey: "sk", baseURL: "https://x/v1" },
      models: [{ id: "m1", contextLimit: 128000 }],
    };
    assert.deepEqual(toEngineCustomProvider(p).entry.models.m1, {
      limit: { context: 128000 },
    });
  });

  test("thinkingLevels → thinking.effortOptions", () => {
    const p = {
      id: "p1",
      label: "p1",
      enabled: true,
      protocol: "openai",
      auth: { type: "byok", apiKey: "sk", baseURL: "https://x/v1" },
      models: [{ id: "m1", thinkingLevels: ["low", "high"] }],
    };
    assert.deepEqual(toEngineCustomProvider(p).entry.models.m1, {
      thinking: { effortOptions: ["low", "high"] },
    });
  });

  test("modalities → modalities.input", () => {
    const p = {
      id: "p1",
      label: "p1",
      enabled: true,
      protocol: "openai",
      auth: { type: "byok", apiKey: "sk", baseURL: "https://x/v1" },
      models: [{ id: "m1", modalities: ["text", "image"] }],
    };
    assert.deepEqual(toEngineCustomProvider(p).entry.models.m1, {
      modalities: { input: ["text", "image"] },
    });
  });

  test("label different from id → name; label === id → no name (engine default)", () => {
    const p = {
      id: "p1",
      label: "p1",
      enabled: true,
      protocol: "openai",
      auth: { type: "byok", apiKey: "sk", baseURL: "https://x/v1" },
      models: [
        { id: "m1", label: "m1" },
        { id: "m2", label: "Model Two" },
      ],
    };
    const out = toEngineCustomProvider(p);
    assert.equal(out.entry.models.m1.name, undefined);
    assert.equal(out.entry.models.m2.name, "Model Two");
  });

  test("non-string thinkingLevels entries are filtered out", () => {
    const p = {
      id: "p1",
      label: "p1",
      enabled: true,
      protocol: "openai",
      auth: { type: "byok", apiKey: "sk", baseURL: "https://x/v1" },
      models: [{ id: "m1", thinkingLevels: ["low", 42, "", "high"] }],
    };
    // Empty string entries are dropped; non-strings cause the array to
    // fail the every-check and the whole thinkingLevels field is omitted.
    assert.equal(toEngineCustomProvider(p).entry.models.m1.thinking, undefined);
  });

  test("non-positive contextLimit is dropped", () => {
    const p = {
      id: "p1",
      label: "p1",
      enabled: true,
      protocol: "openai",
      auth: { type: "byok", apiKey: "sk", baseURL: "https://x/v1" },
      models: [{ id: "m1", contextLimit: 0 }],
    };
    assert.equal(toEngineCustomProvider(p).entry.models.m1.limit, undefined);
  });

  test("provider with no models still gets an entry (operators can add later)", () => {
    const p = {
      id: "p1",
      label: "p1",
      enabled: true,
      protocol: "openai",
      auth: { type: "byok", apiKey: "sk", baseURL: "https://x/v1" },
      models: [],
    };
    const out = toEngineCustomProvider(p);
    assert.ok(out);
    assert.equal(out.entry.models, undefined);
  });
});

describe("syncProvidersToEngine — atomic YAML write + operator preservation", () => {
  beforeEach(() => {
    // Reset the per-test engine config.
    rmSync(join(_tmpDataDir, "config.yaml"), { force: true });
  });

  test("writes custom_provider from the merged catalogue", async () => {
    const providers = [
      {
        id: "byok-zhipu",
        label: "Zhipu",
        enabled: true,
        protocol: "openai",
        auth: { type: "byok", apiKey: "sk-fake", baseURL: "https://example.com/v1" },
        models: [{ id: "glm-5.3" }],
      },
    ];
    const r = await syncProvidersToEngine(providers);
    assert.equal(r.ok, true);
    assert.equal(r.written, true);
    assert.deepEqual(r.keys, ["byok-zhipu"]);
    assert.ok(existsSync(join(_tmpDataDir, "config.yaml")), "file must exist");

    const written = yaml.load(readFileSync(join(_tmpDataDir, "config.yaml"), "utf8"));
    assert.ok(written.custom_provider);
    assert.equal(written.custom_provider["byok-zhipu"].options.apiKey, "sk-fake");
    assert.equal(written.custom_provider["byok-zhipu"].options.baseURL, "https://example.com/v1");
    assert.equal(written.custom_provider["byok-zhipu"].kind, "custom");
    // Acceptance: the entry carries the ownership marker so a future
    // sync knows it is webui-managed and a foreign entry does not.
    assert.equal(written.custom_provider["byok-zhipu"]._webui_owned, true);
  });

  test("preserves the operator's provider.minimax + defaultModel sections", async () => {
    // Pre-populate the engine config as an operator would.
    const seed = {
      logLevel: "info",
      defaultModel: "minimax/MiniMax-M3",
      provider: {
        minimax: {
          options: { apiKey: "sk-existing", authMode: "api-key", baseURL: "https://x/v1" },
        },
      },
      // Foreign (operator-managed) entry — no ownership marker, so the
      // sync must NOT touch it. Ticket 05 acceptance: merge-over-replace,
      // not replace-everything.
      custom_provider: { existing_byok: { name: "Existing", kind: "custom", enabled: true } },
    };
    const fs = await import("node:fs/promises");
    await fs.mkdir(_tmpDataDir, { recursive: true });
    await fs.writeFile(join(_tmpDataDir, "config.yaml"), yaml.dump(seed), "utf8");

    const r = await syncProvidersToEngine([
      {
        id: "byok-new",
        label: "New",
        enabled: true,
        protocol: "anthropic",
        auth: { type: "byok", apiKey: "sk-new", baseURL: "https://y/v1" },
        models: [],
      },
    ]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.keys, ["byok-new"]);
    assert.deepEqual(r.preserved, ["existing_byok"]);
    const after = yaml.load(readFileSync(join(_tmpDataDir, "config.yaml"), "utf8"));
    // Provider tree survives — operator's manual config is not touched.
    assert.equal(after.provider.minimax.options.apiKey, "sk-existing");
    assert.equal(after.defaultModel, "minimax/MiniMax-M3");
    // Foreign entry survives (no marker, untouched by webui).
    assert.deepEqual(after.custom_provider["existing_byok"], {
      name: "Existing",
      kind: "custom",
      enabled: true,
    });
    // New webui entry is added with its ownership marker.
    assert.equal(after.custom_provider["byok-new"].options.apiKey, "sk-new");
    assert.equal(after.custom_provider["byok-new"]._webui_owned, true);
  });

  test("empty eligible list keeps a foreign entry intact (no destructive wipe)", async () => {
    const fs = await import("node:fs/promises");
    await fs.mkdir(_tmpDataDir, { recursive: true });
    const seed = {
      defaultModel: "minimax/MiniMax-M3",
      custom_provider: {
        // Foreign (operator-managed) — pre-existing, no marker.
        manual_only: {
          name: "Manual",
          kind: "custom",
          enabled: true,
          api: "openai-completions",
          options: { apiKey: "sk-manual", baseURL: "https://manual.example/v1", authMode: "api-key" },
        },
      },
    };
    await fs.writeFile(join(_tmpDataDir, "config.yaml"), yaml.dump(seed), "utf8");

    // Empty eligible (every provider is ineligible) — must NOT wipe the
    // foreign entry. Ticket 05 acceptance: the destruction class
    // closed here is "removing a webui provider silently drops a foreign
    // entry". The same destruction class applies to "PUTting an
    // ineligible-only catalogue silently drops a foreign entry".
    const r = await syncProvidersToEngine([
      { id: "x", label: "x", enabled: true, protocol: "openai", auth: { type: "coding-plan" }, models: [] },
      { id: "y", label: "y", enabled: true, protocol: "openai", auth: { type: "byok", baseURL: "https://z" }, models: [] },
    ]);
    assert.equal(r.ok, true);
    // No eligible providers AND the merged tree is byte-identical to
    // what's on disk (foreign was already there and is preserved
    // verbatim). The helper short-circuits the write — no mtime churn,
    // no needless chmod. The route can still surface the `preserved`
    // list to the operator via the response.
    assert.equal(r.written, false);
    assert.deepEqual(r.keys, []);
    assert.deepEqual(r.preserved, ["manual_only"]);

    const after = yaml.load(readFileSync(join(_tmpDataDir, "config.yaml"), "utf8"));
    assert.deepEqual(after.custom_provider.manual_only, seed.custom_provider.manual_only);
    // The defaultModel is not touched either.
    assert.equal(after.defaultModel, "minimax/MiniMax-M3");
  });

  test("webui-managed entry whose provider is removed is dropped, foreign entry is kept", async () => {
    const fs = await import("node:fs/promises");
    await fs.mkdir(_tmpDataDir, { recursive: true });
    // Pre-populate: a webui-managed entry from a previous sync AND a
    // foreign entry.
    const seed = {
      custom_provider: {
        byok_old: {
          name: "Old webui",
          kind: "custom",
          enabled: true,
          api: "openai-completions",
          options: { apiKey: "sk-old", baseURL: "https://old.example/v1", authMode: "api-key" },
          _webui_owned: true,
        },
        manual_only: {
          name: "Manual",
          kind: "custom",
          enabled: true,
          api: "openai-completions",
          options: { apiKey: "sk-manual", baseURL: "https://manual.example/v1", authMode: "api-key" },
        },
      },
    };
    await fs.writeFile(join(_tmpDataDir, "config.yaml"), yaml.dump(seed), "utf8");

    // Sync with no eligible providers — byok_old should be dropped
    // (webui owned it, webui no longer claims it), manual_only survives.
    const r = await syncProvidersToEngine([]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.keys, []);
    assert.deepEqual(r.preserved, ["manual_only"]);

    const after = yaml.load(readFileSync(join(_tmpDataDir, "config.yaml"), "utf8"));
    assert.equal(after.custom_provider["byok_old"], undefined);
    assert.deepEqual(after.custom_provider.manual_only, seed.custom_provider.manual_only);
  });

  test("webui-managed entry update replaces the entry's data, keeps the marker", async () => {
    const fs = await import("node:fs/promises");
    await fs.mkdir(_tmpDataDir, { recursive: true });
    const seed = {
      custom_provider: {
        "byok-zhipu": {
          name: "Old label",
          kind: "custom",
          enabled: true,
          api: "openai-completions",
          options: { apiKey: "sk-old", baseURL: "https://old.example/v1", authMode: "api-key" },
          _webui_owned: true,
        },
      },
    };
    await fs.writeFile(join(_tmpDataDir, "config.yaml"), yaml.dump(seed), "utf8");

    // Re-sync with new apiKey/baseURL for the same id — entry is replaced
    // in place, marker is preserved.
    const r = await syncProvidersToEngine([
      {
        id: "byok-zhipu",
        label: "New label",
        enabled: true,
        protocol: "openai",
        auth: { type: "byok", apiKey: "sk-new", baseURL: "https://new.example/v1" },
        models: [],
      },
    ]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.keys, ["byok-zhipu"]);

    const after = yaml.load(readFileSync(join(_tmpDataDir, "config.yaml"), "utf8"));
    assert.equal(after.custom_provider["byok-zhipu"].options.apiKey, "sk-new");
    assert.equal(after.custom_provider["byok-zhipu"].options.baseURL, "https://new.example/v1");
    assert.equal(after.custom_provider["byok-zhipu"].name, "New label");
    assert.equal(after.custom_provider["byok-zhipu"]._webui_owned, true);
  });

  test("writes custom_provider when at least one eligible provider exists; otherwise no-op write when nothing changes", async () => {
    // 1) Empty eligible, no foreign — there's nothing to write, and
    //    the engine already treats "no custom_provider key" as "no
    //    custom providers". The helper reports written: false (no-op).
    const r1 = await syncProvidersToEngine([]);
    assert.equal(r1.ok, true);
    assert.equal(r1.written, false);
    assert.deepEqual(r1.keys, []);
    assert.deepEqual(r1.preserved, []);

    // 2) Re-run with the same empty eligible list — byte-identical to
    //    what's on disk; the helper reports `written: false` and
    //    skips the rewrite (no mtime churn, no needless chmod).
    const r2 = await syncProvidersToEngine([]);
    assert.equal(r2.ok, true);
    assert.equal(r2.written, false);
  });

  test("missing engine config file → creates one", async () => {
    rmSync(join(_tmpDataDir, "config.yaml"), { force: true });
    const r = await syncProvidersToEngine([
      {
        id: "byok-zhipu",
        label: "z",
        enabled: true,
        protocol: "openai",
        auth: { type: "byok", apiKey: "sk", baseURL: "https://x/v1" },
        models: [],
      },
    ]);
    assert.equal(r.ok, true);
    assert.equal(existsSync(join(_tmpDataDir, "config.yaml")), true);
  });

  test("atomic write: no half-written file on success", async () => {
    rmSync(join(_tmpDataDir, "config.yaml"), { force: true });
    await syncProvidersToEngine([
      {
        id: "byok-zhipu",
        label: "z",
        enabled: true,
        protocol: "openai",
        auth: { type: "byok", apiKey: "sk", baseURL: "https://x/v1" },
        models: [],
      },
    ]);
    // No `.config-tmp-` leftover should exist next to config.yaml.
    const fs = await import("node:fs");
    const siblings = fs.readdirSync(_tmpDataDir);
    const tmps = siblings.filter((n) => n.startsWith(".config-tmp-"));
    assert.equal(tmps.length, 0);
  });

  test("skips ineligible records but writes eligible ones from the same list", async () => {
    const r = await syncProvidersToEngine([
      { id: "eligible", label: "ok", enabled: true, protocol: "openai", auth: { type: "byok", apiKey: "sk", baseURL: "https://x/v1" }, models: [] },
      { id: "no-key", label: "nokey", enabled: true, protocol: "openai", auth: { type: "byok", baseURL: "https://x/v1" }, models: [] },
      { id: "disabled", label: "off", enabled: false, protocol: "openai", auth: { type: "byok", apiKey: "sk", baseURL: "https://x/v1" }, models: [] },
    ]);
    assert.equal(r.ok, true);
    assert.equal(r.written, true);
    assert.deepEqual(r.keys, ["eligible"]);
    const after = yaml.load(readFileSync(join(_tmpDataDir, "config.yaml"), "utf8"));
    assert.ok(after.custom_provider.eligible);
    assert.equal(after.custom_provider["no-key"], undefined);
    assert.equal(after.custom_provider["disabled"], undefined);
  });

  test("config.yaml is written with mode 0600 (plaintext apiKey)", async () => {
    const fs = await import("node:fs/promises");
    await syncProvidersToEngine([
      {
        id: "byok-zhipu",
        label: "z",
        enabled: true,
        protocol: "openai",
        auth: { type: "byok", apiKey: "sk", baseURL: "https://x/v1" },
        models: [],
      },
    ]);
    const stat = await fs.stat(join(_tmpDataDir, "config.yaml"));
    // POSIX mode 0600 — owner read/write only. The engine's own
    // `updateLocalByokConfig` does the same (see
    // packages/config/src/local-model-provider-write.ts).
    if (process.platform !== "win32") {
      assert.equal(stat.mode & 0o777, 0o600);
    }
  });
});

describe("syncProvidersFromPutBody — keep-key convention applied", () => {
  beforeEach(() => {
    rmSync(join(_tmpDataDir, "config.yaml"), { force: true });
  });

  test("absent apiKey on an existing record is filled from the previous user-level entry", async () => {
    const existing = [
      {
        id: "byok-zhipu",
        label: "Zhipu",
        enabled: true,
        protocol: "openai",
        auth: { type: "byok", apiKey: "sk-from-user-level", baseURL: "https://x/v1" },
        models: [],
      },
    ];
    const body = {
      providers: [
        {
          id: "byok-zhipu",
          label: "Zhipu",
          enabled: true,
          protocol: "openai",
          // No auth.apiKey — convention: keep the existing one.
          auth: { type: "byok", baseURL: "https://x/v1" },
          models: [],
        },
      ],
    };
    const r = await syncProvidersFromPutBody(body, existing);
    assert.equal(r.ok, true);
    const after = yaml.load(readFileSync(join(_tmpDataDir, "config.yaml"), "utf8"));
    assert.equal(after.custom_provider["byok-zhipu"].options.apiKey, "sk-from-user-level");
  });

  test("non-array providers in the body surfaces a BAD_BODY error", async () => {
    const r = await syncProvidersFromPutBody({ providers: "not-an-array" }, []);
    assert.equal(r.ok, false);
    assert.equal(r.code, "BAD_BODY");
  });

  test("explicit apiKey in the PUT body replaces the existing key", async () => {
    const existing = [
      {
        id: "byok-zhipu",
        label: "z",
        enabled: true,
        protocol: "openai",
        auth: { type: "byok", apiKey: "sk-old", baseURL: "https://x/v1" },
        models: [],
      },
    ];
    const body = {
      providers: [
        {
          id: "byok-zhipu",
          label: "z",
          enabled: true,
          protocol: "openai",
          auth: { type: "byok", apiKey: "sk-new", baseURL: "https://x/v1" },
          models: [],
        },
      ],
    };
    const r = await syncProvidersFromPutBody(body, existing);
    assert.equal(r.ok, true);
    const after = yaml.load(readFileSync(join(_tmpDataDir, "config.yaml"), "utf8"));
    assert.equal(after.custom_provider["byok-zhipu"].options.apiKey, "sk-new");
  });
});