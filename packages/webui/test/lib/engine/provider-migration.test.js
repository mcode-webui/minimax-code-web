// webui/test/lib/engine/provider-migration.test.js
//
// M3-B11 (= plan item A5), the batch's DEATH LINE: the one-shot
// migration of the deprecated `<webuiDataDir>/providers.json` into the
// engine's `config.yaml#custom_provider`, and the fallback that keeps
// the old format readable when it does not go through.
//
// The two properties this file exists to prove, stated as the plan
// states them:
//
//   1. 存量迁移无损 — "the existing `providers.json` must enter the new
//      store without loss". Proven field by field, on a fixture built
//      to break every assumption the migration could be quietly making:
//      several providers, every schema field, and the boundary values
//      (empty label, absent preset, disabled, coding-plan auth, the
//      gemini protocol, a zero context limit, empty thinking levels,
//      an unprojectable model id, unicode, a 4096-character key, a
//      custom header map).
//   2. 迁移失败回退 — "a failed migration must fall back to the old
//      format staying readable". Proven for each failure mode, and the
//      fallback is asserted through the PUBLIC read, not through an
//      internal, because a fallback nobody can observe is not one.
//
// Isolation: both the webui data dir and the engine data dir are
// per-run tmp dirs, pinned before any import — the store writes to
// MINIMAX_DATA_DIR, and a suite that leaves it on ~/.minimax writes
// plaintext keys into the developer's real engine config.

import { test, describe, before, after, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

import { mkTmpDir } from "../../helpers/tmp.js";

const tmpBase = mkTmpDir("minimax-code-engine-migration-");
const engineDir = join(tmpBase, "engine");
const webuiDir = join(tmpBase, "webui");
const cwdDir = join(tmpBase, "cwd");
const legacyFile = join(webuiDir, "providers.json");
const configPath = join(engineDir, "config.yaml");
process.env.MINIMAX_DATA_DIR = engineDir;
process.env.MAVIS_DATA_DIR = "";
process.env.MCODE_WEBUI_DATA_DIR = webuiDir;
process.env.MCODE_WEBUI_MODELS_CONFIG = "";
process.env.MCODE_WEBUI_SETTINGS_PATH = join(tmpBase, "settings.json");
process.env.MCODE_WEBUI_EVENTS_PATH = join(tmpBase, "events.jsonl");
process.env.MCODE_WEBUI_SESSIONS_DB = join(tmpBase, "sessions.db");
process.env.MCODE_WEBUI_UPLOAD_DIR = join(tmpBase, "uploads");

const { migrateLegacyProviderStore, _resetProviderStoreMigration } = await import(
  "../../../server/engine/provider-store.js"
);
const { readEngineProviderCatalogue } = await import("../../../server/engine/provider-reads.js");
const { loadUserLevelProviders, normaliseProvider } = await import(
  "../../../server/lib/providers-config.js"
);

const _origCwd = process.cwd();

// =====================================================================
// The fixture. Every field the v2 schema has, plus the values that a
// lossy projection would drop, silently, on the way to the engine.
// =====================================================================

const MAX_KEY = "k".repeat(4096);

const LEGACY = {
  version: 2,
  providers: [
    {
      id: "gateway",
      label: "Acme Gateway",
      preset: "openai",
      enabled: true,
      protocol: "openai",
      auth: {
        type: "byok",
        apiKey: "sk-gateway-key-aaaa",
        baseURL: "https://api.acme.test/v1",
        headers: { "X-Tenant": "acme", "X-Trace": "01H" },
      },
      models: [
        { id: "m1", label: "M1", contextLimit: 128000, thinkingLevels: ["low", "high"], modalities: ["text", "image"] },
        { id: "z-ai/glm-5.3", label: "GLM", contextLimit: 1 },
        { id: "m-no-ctx", label: "M No Ctx" },
      ],
    },
    {
      // The record the OLD engine projection could not express: the
      // gemini protocol and the disabled switch both vanish on the way
      // to a bare custom_provider entry.
      id: "gem",
      label: "Gemini Endpoint",
      enabled: false,
      protocol: "gemini",
      auth: { type: "byok", apiKey: "sk-gemini-key-bbbb", baseURL: "https://generativelanguage.test" },
      models: [{ id: "gem-2.5", label: "Gem", contextLimit: 1048576 }],
    },
    {
      // Coding-plan auth is OMITTED from the engine projection entirely.
      id: "plan",
      label: "订阅方案",
      preset: "claude-code",
      enabled: true,
      protocol: "anthropic",
      auth: { type: "coding-plan", apiKey: "", baseURL: "" },
      models: [],
    },
    // Boundary values: an empty label (which the engine projection
    // replaces with the key), a unicode label, no baseURL, a key at
    // the 4096 ceiling, a model id the engine key grammar rejects, and
    // empty thinking / modality lists the normaliser drops.
    {
      id: "edge",
      label: "",
      enabled: true,
      protocol: "openai",
      auth: { type: "byok", apiKey: MAX_KEY, baseURL: "" },
      models: [{ id: "has space", label: "Unprojectable" }, { id: "ok", thinkingLevels: [], modalities: [] }],
    },
  ],
};

/**
 * The expected post-migration records: exactly what the schema says,
 * computed from the fixture through the SAME normaliser the store
 * uses. Deriving the expectation from the fixture (rather than
 * hand-writing it) is what keeps this a round-trip test: a field added
 * to the schema is compared here without anyone updating this file.
 *
 * @param {object} parsed
 * @returns {object[]}
 */
function expectedRecords(parsed) {
  const seen = new Set();
  const out = [];
  for (const p of parsed.providers) {
    const n = normaliseProvider(p);
    assert.equal(n.ok, true, `fixture must normalise: ${n.error}`);
    assert.equal(seen.has(n.value.id), false, "fixture ids are unique");
    seen.add(n.value.id);
    // Through JSON, because that is the form a FILE can hold:
    // `normaliseProvider` emits `preset: undefined` for a record with
    // no preset, and neither JSON nor YAML can represent an undefined
    // value, so the deprecated file dropped the key too. Measuring
    // on-disk equivalence against the JSON form is the honest
    // comparison — comparing against the in-memory object would report
    // a difference the pre-B11 store did not have either.
    out.push(JSON.parse(JSON.stringify(n.value)));
  }
  return out;
}

/**
 * The expected records as a CLIENT sees them, through the catalogue
 * read. This is the in-memory normalised form rather than the JSON
 * form, because the read path re-normalises and therefore carries the
 * `preset: undefined` key — which is exactly what the pre-B11 route
 * returned, since it read the same normaliser's output. Equivalence
 * is measured against the shape the endpoint had BEFORE this batch.
 *
 * @param {object} parsed
 * @returns {object[]}
 */
function expectedPublicRecords(parsed) {
  return (parsed.providers || []).map((p) => {
    const n = normaliseProvider(p);
    assert.equal(n.ok, true, `fixture must normalise: ${n.error}`);
    return n.value;
  });
}

function writeLegacy(doc) {
  writeFileSync(legacyFile, JSON.stringify(doc, null, 2), "utf8");
}

function readStoreRecords() {
  if (!existsSync(configPath)) return [];
  const doc = yaml.load(readFileSync(configPath, "utf8")) || {};
  return Object.values(doc.custom_provider || {})
    .map((entry) => entry && entry._webui_provider)
    .filter(Boolean);
}

before(() => {
  mkdirSync(engineDir, { recursive: true });
  mkdirSync(webuiDir, { recursive: true });
  mkdirSync(cwdDir, { recursive: true });
  process.chdir(cwdDir);
});

after(() => {
  try {
    process.chdir(_origCwd);
  } catch {}
  try {
    rmSync(tmpBase, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  _resetProviderStoreMigration();
  for (const f of [configPath, legacyFile, join(cwdDir, "models.json")]) {
    if (existsSync(f)) rmSync(f, { recursive: true, force: true });
  }
});

// =====================================================================
// DEATH LINE 1 — field-by-field equivalence
// =====================================================================

describe("legacy migration — the records are equivalent, field by field", () => {
  test("a rich legacy file survives the migration with EVERY field intact", async () => {
    writeLegacy(LEGACY);
    const before = JSON.parse(JSON.stringify(loadUserLevelProviders()));
    assert.equal(before.length, 4, "the deprecated loader sees four providers");

    const r = await migrateLegacyProviderStore(before);
    assert.equal(r.ok, true);
    assert.equal(r.migrated, true);
    assert.equal(r.count, 4);

    // ---- FIELD BY FIELD, NOT BY A SUBSET --------------------------
    const after = readStoreRecords();
    assert.equal(after.length, before.length, "provider count is preserved");
    for (let i = 0; i < before.length; i++) {
      const b = before[i];
      const a = after[i];
      assert.equal(a.id, b.id, "id");
      assert.equal(a.label, b.label, `${b.id}: label`);
      assert.equal(a.preset, b.preset, `${b.id}: preset`);
      assert.equal(a.enabled, b.enabled, `${b.id}: enabled`);
      assert.equal(a.protocol, b.protocol, `${b.id}: protocol`);
      assert.equal(a.auth.type, b.auth.type, `${b.id}: auth.type`);
      assert.equal(a.auth.apiKey, b.auth.apiKey, `${b.id}: auth.apiKey`);
      assert.equal(a.auth.baseURL, b.auth.baseURL, `${b.id}: auth.baseURL`);
      assert.deepEqual(a.auth.headers, b.auth.headers, `${b.id}: auth.headers`);
      assert.equal(a.models.length, b.models.length, `${b.id}: model count`);
      for (let j = 0; j < b.models.length; j++) {
        assert.equal(a.models[j].id, b.models[j].id, `${b.id}/${b.models[j].id}: model id`);
        assert.equal(a.models[j].label, b.models[j].label, `${b.id}/${b.models[j].id}: model label`);
        assert.equal(a.models[j].contextLimit, b.models[j].contextLimit, `${b.id}: contextLimit`);
        assert.deepEqual(a.models[j].thinkingLevels, b.models[j].thinkingLevels, `${b.id}: thinkingLevels`);
        assert.deepEqual(a.models[j].modalities, b.models[j].modalities, `${b.id}: modalities`);
      }
    }
    // And the whole-array form, so a future field added to the schema
    // fails HERE rather than silently at the next `assert.equal`.
    assert.deepEqual(after, before);
  });

  test("the records a reader gets back are the same ones, through the public read", async () => {
    // The equivalence that matters is not on-disk-to-on-disk; it is
    // what a client sees. This is the assertion that would have caught
    // a migration that lost the gemini protocol or dropped a disabled
    // provider on the way through the engine's shape.
    writeLegacy(LEGACY);
    const expected = expectedPublicRecords(LEGACY);
    const first = await readEngineProviderCatalogue();
    assert.equal(first.catalogueSource, "engine-store");
    assert.equal(first.migration.migrated, true);
    assert.deepEqual(first.providers, expected);
    // A SECOND read must produce the identical catalogue — the marker
    // has flipped the authority, and the deprecated file must no longer
    // be consulted.
    const second = await readEngineProviderCatalogue();
    assert.equal(second.catalogueSource, "engine-store");
    assert.equal(second.migration.attempted, false, "no second migration attempt");
    assert.deepEqual(second.providers, expected);
  });

  test("the provider ORDER is preserved — the store is a mapping, the catalogue is not", async () => {
    writeLegacy(LEGACY);
    const expected = expectedRecords(LEGACY).map((r) => r.id);
    const c = await readEngineProviderCatalogue();
    assert.deepEqual(c.providers.map((r) => r.id), expected, "insertion order, not alphabetical");
    // And it survives a full YAML round trip, which is where a mapping
    // would be tempted to reorder.
    const again = await readEngineProviderCatalogue();
    assert.deepEqual(again.providers.map((r) => r.id), expected);
  });

  test("an INELIGIBLE provider is migrated anyway, record only", async () => {
    // `plan` is coding-plan and `gem` is disabled — the two the old
    // projection dropped. They must be in the store, marked, with no
    // engine fields, and readable back.
    writeLegacy(LEGACY);
    await migrateLegacyProviderStore(loadUserLevelProviders());
    const doc = yaml.load(readFileSync(configPath, "utf8"));
    for (const key of ["gem", "plan"]) {
      const entry = doc.custom_provider[key];
      assert.ok(entry, `${key} is in the store`);
      assert.equal(entry._webui_owned, true);
      assert.equal(entry.api, undefined, `${key} has no engine projection`);
      assert.ok(entry._webui_provider, `${key} keeps its record`);
    }
    // The eligible one still gets a real projection, so the engine
    // keeps advertising what it always advertised.
    assert.equal(doc.custom_provider.gateway.api, "openai-completions");
    assert.equal(doc.custom_provider.gateway.options.apiKey, "sk-gateway-key-aaaa");
  });

  test("the migration preserves the operator's OTHER engine config sections", async () => {
    const seed = {
      provider: { minimax: { name: "MiniMax", models: { "MiniMax-M3": {} } } },
      defaultModel: "m:minimax:MiniMax-M3:u",
    };
    writeFileSync(configPath, yaml.dump(seed), "utf8");
    writeLegacy(LEGACY);
    await migrateLegacyProviderStore(loadUserLevelProviders());
    const doc = yaml.load(readFileSync(configPath, "utf8"));
    assert.deepEqual(doc.provider, seed.provider);
    assert.equal(doc.defaultModel, seed.defaultModel);
  });

  test("an operator's hand-written custom provider survives the migration", async () => {
    writeFileSync(
      configPath,
      yaml.dump({
        custom_provider: {
          manual: { name: "Mine", kind: "custom", api: "openai-completions", options: { apiKey: "sk-op" } },
        },
      }),
      "utf8",
    );
    writeLegacy(LEGACY);
    await migrateLegacyProviderStore(loadUserLevelProviders());
    const doc = yaml.load(readFileSync(configPath, "utf8"));
    assert.deepEqual(doc.custom_provider.manual, {
      name: "Mine",
      kind: "custom",
      api: "openai-completions",
      options: { apiKey: "sk-op" },
    });
  });

  test("the migration is idempotent — a second call is a no-op", async () => {
    writeLegacy(LEGACY);
    const first = await migrateLegacyProviderStore(loadUserLevelProviders());
    assert.equal(first.migrated, true);
    const afterFirst = readFileSync(configPath, "utf8");
    const second = await migrateLegacyProviderStore(loadUserLevelProviders());
    assert.equal(second.migrated, false, "the marker says it is done");
    assert.equal(readFileSync(configPath, "utf8"), afterFirst, "and the file is not rewritten");
  });

  test("an EMPTY legacy file still closes the deprecated source", async () => {
    writeLegacy({ version: 2, providers: [] });
    const r = await migrateLegacyProviderStore([]);
    assert.equal(r.ok, true);
    assert.equal(r.migrated, true);
    const doc = yaml.load(readFileSync(configPath, "utf8"));
    assert.ok(doc._webui_provider_migration, "an empty catalogue is a decision, not an absence");
  });

  test("a v1 file (no `version`, no auth) migrates like any other", async () => {
    writeLegacy({ providers: [{ id: "legacy1", label: "L1", models: [{ id: "m", contextLimit: 2048 }] }] });
    const r = await migrateLegacyProviderStore(loadUserLevelProviders());
    assert.equal(r.ok, true);
    const rec = readStoreRecords()[0];
    assert.equal(rec.id, "legacy1");
    assert.equal(rec.protocol, "openai", "v1 defaults to the most permissive protocol");
    assert.equal(rec.auth.type, "byok");
  });
});

// =====================================================================
// DEATH LINE 2 — the fallback
// =====================================================================

describe("legacy migration — failure falls back to the old format, readable", () => {
  test("an unparseable config.yaml: the migration fails and the file still answers", async () => {
    writeLegacy(LEGACY);
    const broken = "custom_provider:\\n  - [unbalanced\\n";
    writeFileSync(configPath, broken, "utf8");

    const r = await migrateLegacyProviderStore(loadUserLevelProviders());
    assert.equal(r.ok, false, "the migration reports its failure");
    assert.equal(r.migrated, false);
    assert.equal(r.code, "ENGINE_CONFIG_UNREADABLE");

    // The fallback: the deprecated file answers, in its own format,
    // with the full catalogue — and the broken engine config is left
    // exactly as it was, because overwriting it would destroy every
    // section the store does not own.
    const c = await readEngineProviderCatalogue();
    assert.equal(c.catalogueSource, "legacy-file");
    assert.deepEqual(c.providers, expectedPublicRecords(LEGACY));
    assert.equal(readFileSync(configPath, "utf8"), broken, "the operator's file is untouched");
  });

  test("a WRITE failure: the marker is not written, so the file stays authoritative", async () => {
    writeLegacy(LEGACY);
    // A config path whose parent is a regular file: the read finds
    // nothing and the tmp write then fails with ENOTDIR.
    writeFileSync(join(engineDir, "not-a-dir"), "x", "utf8");
    const blocked = join(engineDir, "not-a-dir", "config.yaml");

    const r = await migrateLegacyProviderStore(loadUserLevelProviders(), { configPath: blocked });
    assert.equal(r.ok, false);
    assert.equal(r.code, "ENGINE_STORE_WRITE_FAILED");

    // The public read, pointed at the same broken path, falls back.
    const c = await readEngineProviderCatalogue({ configPath: blocked });
    assert.equal(c.catalogueSource, "legacy-file");
    assert.deepEqual(c.providers, expectedPublicRecords(LEGACY));
    assert.equal(c.migration.code, "ENGINE_STORE_WRITE_FAILED", "the reason travels with the result");
  });

  test("a failed migration is retried on the next read, and can succeed", async () => {
    // The retry is the recovery path, and it is only possible because
    // the failed attempt left no marker behind.
    writeLegacy(LEGACY);
    const blocked = join(engineDir, "not-a-dir", "config.yaml");
    writeFileSync(join(engineDir, "not-a-dir"), "x", "utf8");
    assert.equal((await migrateLegacyProviderStore(loadUserLevelProviders(), { configPath: blocked })).ok, false);

    // The obstruction clears.
    rmSync(join(engineDir, "not-a-dir"), { force: true });
    const retry = await migrateLegacyProviderStore(loadUserLevelProviders());
    assert.equal(retry.ok, true);
    assert.equal(retry.migrated, true);
    assert.deepEqual(readStoreRecords(), expectedRecords(LEGACY));
  });

  test("NO deprecated file means no migration and no write", async () => {
    // A fresh install must not acquire a config.yaml because a browser
    // polled #62. The read is a pure function of an empty world.
    const c = await readEngineProviderCatalogue();
    assert.equal(c.catalogueSource, "legacy-file");
    assert.deepEqual(c.providers, []);
    assert.equal(c.migration.attempted, false);
    assert.equal(existsSync(configPath), false, "a GET never writes");
  });

  test("a corrupt deprecated file yields an empty catalogue and still closes", async () => {
    // Nothing to migrate and nothing to preserve: the operator gets an
    // empty catalogue they can rebuild, rather than a permanently
    // failing one.
    writeFileSync(legacyFile, "{ not json", "utf8");
    const c = await readEngineProviderCatalogue();
    assert.deepEqual(c.providers, []);
    assert.equal(c.catalogueSource, "engine-store", "the marker was still stamped");
  });

  test("after the store is authoritative, the deprecated file is ignored entirely", async () => {
    writeLegacy(LEGACY);
    await readEngineProviderCatalogue();
    assert.equal(existsSync(configPath), true);
    // Someone edits the deprecated file by hand. The store is the
    // authority now, so the edit is invisible — which is the whole
    // point of the marker, and the reason a stale file cannot fight a
    // live one.
    writeFileSync(legacyFile, JSON.stringify({ version: 2, providers: [{ id: "intruder", auth: {} }] }), "utf8");
    const c = await readEngineProviderCatalogue();
    assert.deepEqual(c.providers, expectedPublicRecords(LEGACY));
    assert.equal(c.catalogueSource, "engine-store");
  });

  test("the env and cwd layers still win over a migrated catalogue", async () => {
    // The migration replaces the USER layer only. A deployment-owned
    // file that overrides a provider must keep overriding it.
    writeLegacy(LEGACY);
    await readEngineProviderCatalogue();
    writeFileSync(
      join(cwdDir, "models.json"),
      JSON.stringify({ providers: [{ id: "gateway", label: "From cwd", auth: { type: "byok", apiKey: "sk-cwd-override" } }] }),
      "utf8",
    );
    const c = await readEngineProviderCatalogue();
    const gw = c.providers.find((p) => p.id === "gateway");
    assert.equal(gw.label, "From cwd", "the cwd layer still outranks the store");
    assert.equal(gw.auth.apiKey, "sk-cwd-override");
  });
});

// =====================================================================
// The deprecated file is never written again
// =====================================================================

describe("the deprecated file is read-only from here on", () => {
  test("a migration leaves providers.json byte-identical", async () => {
    writeLegacy(LEGACY);
    const before = readFileSync(legacyFile, "utf8");
    await readEngineProviderCatalogue();
    assert.equal(readFileSync(legacyFile, "utf8"), before, "the file is never rewritten, only read");
  });

  test("a PUT leaves providers.json byte-identical", async () => {
    // The write path is the store; the deprecated file keeps whatever
    // it had, which is what makes the fallback story readable after a
    // downgrade.
    const { commitProviderCatalogueWrite } = await import("../../../server/engine/provider-writes.js");
    writeLegacy(LEGACY);
    const before = readFileSync(legacyFile, "utf8");
    await commitProviderCatalogueWrite({ records: expectedRecords(LEGACY) });
    assert.equal(readFileSync(legacyFile, "utf8"), before);
  });

  test("deleting every provider does not resurrect the deprecated file", async () => {
    // The reason the marker is a field rather than an inference: after
    // this write the store is EMPTY and has no webui entries, and an
    // inferred marker would hand authority back to the stale file.
    const { commitProviderCatalogueWrite } = await import("../../../server/engine/provider-writes.js");
    writeLegacy(LEGACY);
    await readEngineProviderCatalogue();
    await commitProviderCatalogueWrite({ records: [] });
    const c = await readEngineProviderCatalogue();
    assert.equal(c.catalogueSource, "engine-store");
    assert.deepEqual(c.providers, [], "the four providers the operator deleted stay deleted");
  });
});
