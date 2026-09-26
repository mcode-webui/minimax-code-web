// webui/test/lib/engine-catalogue.test.js
// Unit tests for server/lib/engine-catalogue.js — the read-only
// projection of the engine's `custom_provider` tree into the webui
// v2 shape (ticket 06 — engine-catalogue-parity).
//
// What we pin here:
//   - readEngineCatalogue: foreign + webui-owned entries BOTH surface;
//     apiKey / apiKeyMasked / baseURL NEVER appear in the projection;
//     missing file / parse error / wrong-shape `custom_provider` are
//     non-fatal (returns []); keys (`webui_owned` marker, etc.) we
//     DO NOT preserve.
//   - engineApiToWebuiProtocol: openai-completions + openai-responses
//     map to openai; anthropic-messages maps to anthropic; anything
//     else falls back to openai.
//   - fromEngineCustomProviderEntry: skips non-custom kinds and
//     disabled entries; carries thinking.effortOptions /
//     modalities.input / limit.context into the webui model shape;
//     filters out non-string entries inside the engine's array
//     fields.
//   - mergeEngineAndWebuiProviders: webui wins on scalar fields;
//     same-id models union by id with the webui model winning on
//     collision; engine-only providers pass through verbatim;
//     `hasKey` is OR'd across layers (either layer says
//     "configured" → merged says "configured"); no apiKey leak
//     anywhere (engine-side hasKey is a boolean only).
//
// Test strategy: pure unit tests + tmp engine config fixtures via
// `opts.configPath`. The helper resolves the engine data dir from
// `MINIMAX_DATA_DIR` (mirrored from the real engine), so the suite
// NEVER touches the host's `~/.minimax`. Every fixture is an
// isolated tmp file passed via `opts.configPath`.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";

const {
  engineApiToWebuiProtocol,
  fromEngineCustomProviderEntry,
  readEngineCatalogue,
  mergeEngineAndWebuiProviders,
} = await import(
  new URL("../../server/lib/engine-catalogue.js", import.meta.url).href
);

// Resolve the data dir once — the engine-side helpers expect it
// to be set, but we pass every test fixture via opts.configPath so
// the resolver is irrelevant for read paths. We still set it to
// a tmp dir so a stray "no configPath" call in some helper never
// reaches the host's real engine tree.
const _origMinimax = process.env.MINIMAX_DATA_DIR;
const _origMavis = process.env.MAVIS_DATA_DIR;
const _tmpDataDir = mkdtempSync(join(tmpdir(), "minimax-code-engine-cat-"));
process.env.MINIMAX_DATA_DIR = _tmpDataDir;
delete process.env.MAVIS_DATA_DIR;

after(() => {
  if (_origMinimax === undefined) delete process.env.MINIMAX_DATA_DIR;
  else process.env.MINIMAX_DATA_DIR = _origMinimax;
  if (_origMavis === undefined) delete process.env.MAVIS_DATA_DIR;
  else process.env.MAVIS_DATA_DIR = _origMavis;
  rmSync(_tmpDataDir, { recursive: true, force: true });
});

function writeConfig(obj) {
  const path = join(_tmpDataDir, `config-${Math.random().toString(36).slice(2, 10)}.yaml`);
  writeFileSync(path, yaml.dump(obj), "utf8");
  return path;
}

// ---------------------------------------------------------------------
// engineApiToWebuiProtocol
// ---------------------------------------------------------------------

describe("engineApiToWebuiProtocol", () => {
  test("anthropic-messages → anthropic", () => {
    assert.equal(engineApiToWebuiProtocol("anthropic-messages"), "anthropic");
  });
  test("openai-completions → openai", () => {
    assert.equal(engineApiToWebuiProtocol("openai-completions"), "openai");
  });
  test("openai-responses → openai (engine-internal detail, picker doesn't differentiate)", () => {
    assert.equal(engineApiToWebuiProtocol("openai-responses"), "openai");
  });
  test("unknown api → openai (most permissive fallback)", () => {
    assert.equal(engineApiToWebuiProtocol("gibberish"), "openai");
  });
  test("missing api → openai", () => {
    assert.equal(engineApiToWebuiProtocol(undefined), "openai");
    assert.equal(engineApiToWebuiProtocol(null), "openai");
    assert.equal(engineApiToWebuiProtocol(""), "openai");
  });
});

// ---------------------------------------------------------------------
// fromEngineCustomProviderEntry — pure entry projection
// ---------------------------------------------------------------------

describe("fromEngineCustomProviderEntry", () => {
  test("a normal entry projects to the v2 shape with full metadata", () => {
    const out = fromEngineCustomProviderEntry("deepseek-cn", {
      name: "DeepSeek CN",
      kind: "custom",
      enabled: true,
      api: "anthropic-messages",
      options: { apiKey: "sk-SECRET", baseURL: "https://api.deepseek.com/anthropic", authMode: "api-key" },
      models: {
        "deepseek-flash": {
          name: "DeepSeek V4.1 Flash",
          limit: { context: 1000000 },
          thinking: { effortOptions: ["max", "high", "low", "none"] },
          modalities: { input: ["text", "image"] },
        },
      },
    });
    assert.ok(out);
    assert.equal(out.id, "deepseek-cn");
    assert.equal(out.label, "DeepSeek CN");
    assert.equal(out.protocol, "anthropic");
    assert.equal(out.auth.type, "byok");
    assert.equal(out.auth.hasKey, true);
    // apiKey / apiKeyMasked / baseURL NEVER appear.
    assert.equal(out.auth.apiKey, undefined);
    assert.equal(out.auth.apiKeyMasked, undefined);
    assert.equal(out.auth.baseURL, undefined);
    assert.equal(JSON.stringify(out).includes("sk-SECRET"), false, "no plaintext key");
    assert.equal(JSON.stringify(out).includes("api.deepseek.com"), false, "no engine baseURL");
    // Model metadata round-trips.
    const m = out.models[0];
    assert.equal(m.id, "deepseek-flash");
    assert.equal(m.label, "DeepSeek V4.1 Flash");
    assert.equal(m.contextLimit, 1000000);
    assert.deepEqual(m.thinkingLevels, ["max", "high", "low", "none"]);
    assert.deepEqual(m.modalities, ["text", "image"]);
  });

  test("non-custom kind is excluded (engine internal providers live elsewhere)", () => {
    const out = fromEngineCustomProviderEntry("minimax", {
      kind: "internal",
      enabled: true,
      api: "anthropic-messages",
    });
    assert.equal(out, null);
  });

  test("explicitly disabled entries are excluded", () => {
    const out = fromEngineCustomProviderEntry("p", {
      kind: "custom",
      enabled: false,
      api: "openai-completions",
      options: { apiKey: "sk-x", baseURL: "https://x/v1" },
      models: { m: {} },
    });
    assert.equal(out, null);
  });

  test("entry without options.apiKey has hasKey=false (no mask needed)", () => {
    const out = fromEngineCustomProviderEntry("p", {
      kind: "custom",
      enabled: true,
      api: "openai-completions",
      models: { m: {} },
    });
    assert.ok(out);
    assert.equal(out.auth.hasKey, false);
  });

  test("models with only `name` (no thinking / modalities / limit) project cleanly", () => {
    const out = fromEngineCustomProviderEntry("p", {
      kind: "custom",
      enabled: true,
      api: "openai-completions",
      options: { apiKey: "sk-x", baseURL: "https://x/v1" },
      models: { m: { name: "M" } },
    });
    const m = out.models[0];
    assert.equal(m.id, "m");
    assert.equal(m.label, "M");
    assert.equal(m.contextLimit, undefined);
    assert.equal(m.thinkingLevels, undefined);
    assert.equal(m.modalities, undefined);
  });

  test("non-string thinking level entries are filtered (engine already validates)", () => {
    const out = fromEngineCustomProviderEntry("p", {
      kind: "custom",
      enabled: true,
      api: "openai-completions",
      options: { apiKey: "sk-x", baseURL: "https://x/v1" },
      models: { m: { thinking: { effortOptions: ["low", 42, "", "high"] } } },
    });
    const m = out.models[0];
    // Empty / non-string entries are filtered out so the picker
    // never sees a malformed level. Mixed-type array is preserved
    // (the engine accepts it; the projection only drops empties +
    // non-strings, then keeps the survivors).
    assert.deepEqual(m.thinkingLevels, ["low", "high"]);
  });

  test("all-empty thinking.effortOptions → thinkingLevels is omitted (no empty arrays in the wire shape)", () => {
    const out = fromEngineCustomProviderEntry("p", {
      kind: "custom",
      enabled: true,
      api: "openai-completions",
      options: { apiKey: "sk-x", baseURL: "https://x/v1" },
      models: { m: { thinking: { effortOptions: [] } } },
    });
    const m = out.models[0];
    assert.equal(m.thinkingLevels, undefined);
  });

  test("non-positive limit.context is dropped", () => {
    const out = fromEngineCustomProviderEntry("p", {
      kind: "custom",
      enabled: true,
      api: "openai-completions",
      options: { apiKey: "sk-x", baseURL: "https://x/v1" },
      models: { m: { limit: { context: 0 } } },
    });
    assert.equal(out.models[0].contextLimit, undefined);
  });

  test("model name === id → name field is dropped (no spurious redundancy)", () => {
    const out = fromEngineCustomProviderEntry("p", {
      kind: "custom",
      enabled: true,
      api: "openai-completions",
      options: { apiKey: "sk-x", baseURL: "https://x/v1" },
      models: { m: { name: "m" } },
    });
    assert.equal(out.models[0].label, "m");
  });

  test("null / non-object input → null", () => {
    assert.equal(fromEngineCustomProviderEntry("k", null), null);
    assert.equal(fromEngineCustomProviderEntry("k", undefined), null);
    assert.equal(fromEngineCustomProviderEntry("k", "string"), null);
    assert.equal(fromEngineCustomProviderEntry("k", 42), null);
  });

  test("an entry with no `models` key still produces a usable provider", () => {
    const out = fromEngineCustomProviderEntry("p", {
      kind: "custom",
      enabled: true,
      api: "openai-completions",
      options: { apiKey: "sk-x", baseURL: "https://x/v1" },
    });
    assert.ok(out);
    assert.deepEqual(out.models, []);
  });
});

// ---------------------------------------------------------------------
// readEngineCatalogue — file IO + projection, with a tmp config
// ---------------------------------------------------------------------

describe("readEngineCatalogue", () => {
  test("missing file → [] (not an error)", () => {
    const out = readEngineCatalogue({
      configPath: join(_tmpDataDir, "does-not-exist.yaml"),
    });
    assert.deepEqual(out, []);
  });

  test("YAML parse error → [] (not an error)", () => {
    const path = join(_tmpDataDir, "broken.yaml");
    writeFileSync(path, "this: is: not: valid: yaml: [\n", "utf8");
    assert.deepEqual(readEngineCatalogue({ configPath: path }), []);
  });

  test("file without custom_provider → []", () => {
    const path = writeConfig({ logLevel: "info" });
    assert.deepEqual(readEngineCatalogue({ configPath: path }), []);
  });

  test("custom_provider shaped wrong (array) → []", () => {
    const path = writeConfig({ custom_provider: ["not", "an", "object"] });
    assert.deepEqual(readEngineCatalogue({ configPath: path }), []);
  });

  test("a foreign entry (operator-managed, no _webui_owned) surfaces", () => {
    const path = writeConfig({
      custom_provider: {
        "manual-only": {
          name: "Manual",
          kind: "custom",
          enabled: true,
          api: "openai-completions",
          options: { apiKey: "sk-foreign", baseURL: "https://manual/v1", authMode: "api-key" },
          models: { "m1": { name: "M1" } },
        },
      },
    });
    const [entry] = readEngineCatalogue({ configPath: path });
    assert.equal(entry.id, "manual-only");
    assert.equal(entry.label, "Manual");
    assert.equal(entry.protocol, "openai");
    assert.equal(entry.auth.hasKey, true);
    assert.equal(entry.models.length, 1);
    // No key in the projection.
    assert.equal(entry.auth.apiKey, undefined);
    assert.equal(JSON.stringify(entry).includes("sk-foreign"), false);
  });

  test("a webui-owned entry (the `_webui_owned: true` marker is set) ALSO surfaces", () => {
    // After ticket 05's sync, every entry the webui wrote carries
    // `_webui_owned: true`. The catalogue reader must surface those
    // alongside the foreign ones — the engine's view of "configured
    // providers" is the union.
    const path = writeConfig({
      custom_provider: {
        "byok-zhipu": {
          name: "Zhipu",
          kind: "custom",
          enabled: true,
          api: "openai-completions",
          options: { apiKey: "sk-webui", baseURL: "https://x/v1", authMode: "api-key" },
          models: { "glm-5.3": {} },
          _webui_owned: true,
        },
      },
    });
    const [entry] = readEngineCatalogue({ configPath: path });
    assert.equal(entry.id, "byok-zhipu");
    assert.equal(entry.auth.hasKey, true);
    // The marker is consumed, NOT passed through (the projection
    // shape doesn't have a field for it — webui's own layer owns
    // ownership semantics).
    assert.equal(entry._webui_owned, undefined);
  });

  test("the entry's `options.apiKey` is NEVER present in the projection output (any field)", () => {
    const path = writeConfig({
      custom_provider: {
        "k": {
          kind: "custom",
          enabled: true,
          api: "anthropic-messages",
          options: { apiKey: "sk-PRIVATE-KEY-MUST-NOT-LEAK", baseURL: "https://secret.example/v1", authMode: "api-key" },
          models: { m: { name: "M" } },
        },
      },
    });
    const [entry] = readEngineCatalogue({ configPath: path });
    const dump = JSON.stringify(entry);
    assert.equal(dump.includes("sk-PRIVATE-KEY-MUST-NOT-LEAK"), false, "no plaintext key");
    assert.equal(dump.includes("secret.example"), false, "no engine baseURL");
    assert.equal(dump.includes("authMode"), false, "no engine authMode (engine-internal detail)");
    // Only the auth fields we deliberately surface:
    assert.deepEqual(Object.keys(entry.auth).sort(), ["hasKey", "type"]);
  });

  test("mixed foreign + webui-owned entries all surface", () => {
    const path = writeConfig({
      custom_provider: {
        foreign: {
          kind: "custom",
          enabled: true,
          api: "openai-completions",
          options: { apiKey: "sk-f", baseURL: "https://f/v1" },
          models: { m: {} },
        },
        webui_owned: {
          kind: "custom",
          enabled: true,
          api: "openai-completions",
          options: { apiKey: "sk-w", baseURL: "https://w/v1" },
          models: { m: {} },
          _webui_owned: true,
        },
      },
    });
    const out = readEngineCatalogue({ configPath: path });
    const ids = out.map((p) => p.id).sort();
    assert.deepEqual(ids, ["foreign", "webui_owned"]);
  });
});

// ---------------------------------------------------------------------
// mergeEngineAndWebuiProviders — the merge-rule matrix.
// ---------------------------------------------------------------------

describe("mergeEngineAndWebuiProviders", () => {
  test("empty engine + empty webui → []", () => {
    assert.deepEqual(mergeEngineAndWebuiProviders([], []), []);
  });

  test("engine-only providers pass through verbatim", () => {
    const engine = [
      { id: "p1", label: "P1", enabled: true, protocol: "openai", auth: { type: "byok", hasKey: true }, models: [] },
    ];
    const merged = mergeEngineAndWebuiProviders(engine, []);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, "p1");
  });

  test("webui-only providers pass through verbatim", () => {
    const webui = [
      { id: "p1", label: "P1", enabled: true, protocol: "openai", auth: { type: "byok", hasKey: false }, models: [] },
    ];
    const merged = mergeEngineAndWebuiProviders([], webui);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, "p1");
  });

  test("same id, webui scalar fields win (label / protocol / enabled)", () => {
    const engine = [
      { id: "p1", label: "Engine label", enabled: true, protocol: "anthropic", auth: { type: "byok", hasKey: true }, models: [] },
    ];
    const webui = [
      { id: "p1", label: "Webui label", enabled: false, protocol: "openai", auth: { type: "coding-plan", hasKey: false }, models: [] },
    ];
    const [m] = mergeEngineAndWebuiProviders(engine, webui);
    assert.equal(m.label, "Webui label");
    assert.equal(m.enabled, false);
    assert.equal(m.protocol, "openai");
    assert.equal(m.auth.type, "coding-plan");
  });

  test("same id, webui model wins on id collision (union by id)", () => {
    const engine = [
      {
        id: "p1",
        label: "P1",
        enabled: true,
        protocol: "anthropic",
        auth: { type: "byok", hasKey: true },
        models: [
          { id: "m1", label: "Engine M1", contextLimit: 100000 },
          { id: "m2", label: "Engine M2", contextLimit: 200000 },
        ],
      },
    ];
    const webui = [
      {
        id: "p1",
        label: "P1",
        enabled: true,
        protocol: "anthropic",
        auth: { type: "byok", hasKey: false },
        models: [
          { id: "m1", label: "Webui M1", contextLimit: 128000 },
        ],
      },
    ];
    const [m] = mergeEngineAndWebuiProviders(engine, webui);
    const byId = Object.fromEntries(m.models.map((mm) => [mm.id, mm]));
    // m1: webui label wins, webui contextLimit wins.
    assert.equal(byId.m1.label, "Webui M1");
    assert.equal(byId.m1.contextLimit, 128000);
    // m2: only engine has it; passes through.
    assert.equal(byId.m2.label, "Engine M2");
    assert.equal(byId.m2.contextLimit, 200000);
  });

  test("`hasKey` is OR'd across layers — engine says has-key + webui says no-key → merged says has-key", () => {
    // Rationale: the engine has its own apiKey (foreign entry) and
    // the webui layer may not have one yet (operator hasn't filled
    // the dialog form). The merged view must reflect "this provider
    // is configurable from the picker" — otherwise the picker would
    // grey it out despite the engine being able to drive it.
    const engine = [
      { id: "p1", label: "P1", enabled: true, protocol: "openai", auth: { type: "byok", hasKey: true }, models: [] },
    ];
    const webui = [
      { id: "p1", label: "P1", enabled: true, protocol: "openai", auth: { type: "byok", hasKey: false }, models: [] },
    ];
    const [m] = mergeEngineAndWebuiProviders(engine, webui);
    assert.equal(m.auth.hasKey, true, "engine hasKey true → merged hasKey true");
  });

  test("`hasKey` is OR'd across layers — webui says has-key + engine says no-key → merged says has-key", () => {
    // Reverse: operator filled the webui form, the engine's stale
    // view still says no key. Merged reflects "the dialog knows
    // about a key".
    const engine = [
      { id: "p1", label: "P1", enabled: true, protocol: "openai", auth: { type: "byok", hasKey: false }, models: [] },
    ];
    const webui = [
      { id: "p1", label: "P1", enabled: true, protocol: "openai", auth: { type: "byok", hasKey: true }, models: [] },
    ];
    const [m] = mergeEngineAndWebuiProviders(engine, webui);
    assert.equal(m.auth.hasKey, true);
  });

  test("engine-side fields fill in undefined webui values (label fallback)", () => {
    // Webui layer is missing the provider entirely (a foreign
    // entry that the webui doesn't know about) — engine's view
    // passes through.
    const engine = [
      { id: "p1", label: "Engine only", enabled: true, protocol: "anthropic", auth: { type: "byok", hasKey: true }, models: [] },
    ];
    const webui = [
      { id: "p2", label: "Webui only", enabled: true, protocol: "openai", auth: { type: "byok", hasKey: false }, models: [] },
    ];
    const merged = mergeEngineAndWebuiProviders(engine, webui);
    const byId = Object.fromEntries(merged.map((p) => [p.id, p]));
    assert.equal(byId.p1.label, "Engine only");
    assert.equal(byId.p2.label, "Webui only");
  });

  test("merged view carries no apiKey field anywhere — projection is read-only display", () => {
    const engine = [
      { id: "p1", label: "P1", enabled: true, protocol: "openai", auth: { type: "byok", hasKey: true }, models: [] },
    ];
    const webui = [
      { id: "p1", label: "P1", enabled: true, protocol: "openai", auth: { type: "byok", hasKey: true }, models: [] },
    ];
    const [m] = mergeEngineAndWebuiProviders(engine, webui);
    const dump = JSON.stringify(m);
    // No plaintext / masked key shape — the merge helper sees only
    // the public `hasKey` boolean on each layer's auth.
    assert.equal(dump.includes("apiKey"), false);
    assert.equal(dump.includes("apiKeyMasked"), false);
    assert.equal(dump.includes("baseURL"), false);
  });

  test("preserves webui's `preset` tag when merging (engine-side doesn't carry it)", () => {
    const engine = [
      { id: "deepseek", label: "Engine", enabled: true, protocol: "openai", auth: { type: "byok", hasKey: true }, models: [] },
    ];
    const webui = [
      { id: "deepseek", label: "Webui", preset: "deepseek", enabled: true, protocol: "openai", auth: { type: "byok", hasKey: false }, models: [] },
    ];
    const [m] = mergeEngineAndWebuiProviders(engine, webui);
    assert.equal(m.preset, "deepseek");
  });

  test("engine-only providers preserve their full metadata when no webui layer exists", () => {
    const engine = [
      {
        id: "zai-max",
        label: "ZAI Max",
        enabled: true,
        protocol: "anthropic",
        auth: { type: "byok", hasKey: true },
        models: [
          { id: "glm-5.3", label: "GLM-5.3", contextLimit: 1000000, thinkingLevels: ["max", "high", "medium", "low"], modalities: ["text"] },
        ],
      },
    ];
    const [m] = mergeEngineAndWebuiProviders(engine, []);
    assert.equal(m.id, "zai-max");
    assert.equal(m.models[0].contextLimit, 1000000);
    assert.deepEqual(m.models[0].thinkingLevels, ["max", "high", "medium", "low"]);
    assert.deepEqual(m.models[0].modalities, ["text"]);
  });
});