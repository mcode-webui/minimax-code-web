// webui/test/lib/engine/provider-store.test.js
//
// M3-B11 (= plan item A5): the consolidated provider store —
// `server/engine/provider-store.js`.
//
// This file replaces `test/lib/engine-provider-sync.test.js`, whose
// subject (`lib/engine-provider-sync.js`) the batch deleted. Every
// assertion the old suite made about the double write is made here
// about the single write, and the ones that CHANGED are the ones worth
// reading twice:
//
//   - ownership (foreign entries survive, webui-owned ones are deleted
//     when the operator removes the provider) — unchanged, and the
//     marker is the same field;
//   - 0600, atomic rename, no `.config-tmp-` leftover — unchanged;
//   - an unparseable `config.yaml` is refused rather than overwritten —
//     unchanged, and now load-bearing for a second reason (it is the
//     fallback trigger on the read path);
//   - "the webui catalogue is the `providers.json` file" — GONE. That
//     was the dual source. The catalogue is the store, and the file is
//     deprecated; `provider-migration.test.js` carries the migration
//     and fallback contracts.
//
// Isolation: `MINIMAX_DATA_DIR` AND `MCODE_WEBUI_DATA_DIR` are both
// pinned to a per-run tmp dir BEFORE any import, for the same reason
// test/lib/engine/capability-snapshot.test.js states: setting only the
// webui dir leaves the engine dir on ~/.minimax, and this suite writes
// there.

import { test, describe, before, after, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

import { mkTmpDir } from "../../helpers/tmp.js";

const tmpBase = mkTmpDir("minimax-code-engine-store-");
const engineDir = join(tmpBase, "engine");
const webuiDir = join(tmpBase, "webui");
process.env.MINIMAX_DATA_DIR = engineDir;
process.env.MAVIS_DATA_DIR = "";
process.env.MCODE_WEBUI_DATA_DIR = webuiDir;
process.env.MCODE_WEBUI_MODELS_CONFIG = "";
process.env.MCODE_WEBUI_SETTINGS_PATH = join(tmpBase, "settings.json");
process.env.MCODE_WEBUI_EVENTS_PATH = join(tmpBase, "events.jsonl");
process.env.MCODE_WEBUI_SESSIONS_DB = join(tmpBase, "sessions.db");
process.env.MCODE_WEBUI_UPLOAD_DIR = join(tmpBase, "uploads");

const {
  PROVIDER_STORE_MIGRATION_MARKER,
  WEBUI_OWNED_MARKER,
  WEBUI_PROVIDER_MARKER,
  atomicWriteYaml0600,
  buildProviderStoreWrite,
  commitProviderStoreWrite,
  getEngineConfigPath,
  modelKeyFromId,
  projectRecordToEngine,
  protocolFromEngineApi,
  providerKeyFromId,
  providerRecordsFromTree,
  readEngineConfigRaw,
  readProviderStore,
  recordFromEngineEntry,
  resolveEngineDataDir,
  _resetProviderStoreMigration,
} = await import("../../../server/engine/provider-store.js");
const { normaliseProvider } = await import("../../../server/lib/providers-config.js");

const configPath = join(engineDir, "config.yaml");

/** A normalised record, from a raw v2 provider. */
function rec(raw) {
  const n = normaliseProvider(raw);
  assert.equal(n.ok, true, `fixture must normalise: ${n.error}`);
  return n.value;
}

const BYOK = {
  id: "gw",
  label: "Gateway",
  protocol: "openai",
  auth: { type: "byok", apiKey: "sk-store-key-aaaa", baseURL: "https://api.example.com" },
  models: [{ id: "m1", label: "M1", contextLimit: 128000 }],
};

before(() => {
  mkdirSync(engineDir, { recursive: true });
  mkdirSync(webuiDir, { recursive: true });
});

beforeEach(() => {
  _resetProviderStoreMigration();
  for (const f of [configPath, join(webuiDir, "providers.json")]) {
    // `recursive` because one test deliberately turns config.yaml into
    // a directory to force a write failure, and the hook must be able
    // to clean that up for the next test.
    if (existsSync(f)) rmSync(f, { recursive: true, force: true });
  }
});

after(() => {
  try {
    rmSync(tmpBase, { recursive: true, force: true });
  } catch {}
});

// =====================================================================
// Location
// =====================================================================

describe("resolveEngineDataDir — precedence", () => {
  test("MINIMAX_DATA_DIR wins, then MAVIS_DATA_DIR, then ~/.minimax", () => {
    const before = { min: process.env.MINIMAX_DATA_DIR, mav: process.env.MAVIS_DATA_DIR };
    try {
      process.env.MINIMAX_DATA_DIR = "/tmp/a";
      process.env.MAVIS_DATA_DIR = "/tmp/b";
      assert.equal(resolveEngineDataDir(), "/tmp/a");
      process.env.MINIMAX_DATA_DIR = "   ";
      assert.equal(resolveEngineDataDir(), "/tmp/b", "blank MINIMAX_DATA_DIR falls through");
      process.env.MAVIS_DATA_DIR = "";
      assert.match(resolveEngineDataDir(), /\.minimax$/, "falls back to the home dir");
    } finally {
      if (before.min === undefined) delete process.env.MINIMAX_DATA_DIR;
      else process.env.MINIMAX_DATA_DIR = before.min;
      if (before.mav === undefined) delete process.env.MAVIS_DATA_DIR;
      else process.env.MAVIS_DATA_DIR = before.mav;
    }
  });

  test("getEngineConfigPath is the engine config inside that dir", () => {
    assert.equal(getEngineConfigPath(), configPath);
  });
});

// =====================================================================
// Pure key mapping
// =====================================================================

describe("providerKeyFromId — engine key safety", () => {
  test("a legal id passes through unchanged", () => {
    assert.equal(providerKeyFromId("gw"), "gw");
    assert.equal(providerKeyFromId("  gw  "), "gw");
    assert.equal(providerKeyFromId("a.b_c-d1"), "a.b_c-d1");
  });

  test("a reserved engine id is suffixed, never shadowed", () => {
    // `minimax` is the engine's builtin managed provider. Writing a
    // webui entry under that key would either shadow it or be dropped
    // by the engine's own reserved-key filter.
    for (const id of ["minimax", "minimax_api", "provider", "custom_provider"]) {
      assert.equal(providerKeyFromId(id), `${id}-byok`);
    }
  });

  test("an empty or illegal id has no key", () => {
    assert.equal(providerKeyFromId(""), "");
    assert.equal(providerKeyFromId("   "), "");
    assert.equal(providerKeyFromId(undefined), "");
    assert.equal(providerKeyFromId("-leading-dash"), "");
    assert.equal(providerKeyFromId("has space"), "");
    assert.equal(providerKeyFromId("has/slash"), "");
  });
});

describe("modelKeyFromId — namespace ids survive, YAML tokens do not", () => {
  test("a namespaced model id keeps its slash", () => {
    // The engine splits the wire form on the FIRST `/` only, so
    // `z-ai/glm-5.3` survives as one model key. Rejecting it (as an
    // earlier revision did) silently dropped the model from the store.
    assert.equal(modelKeyFromId("z-ai/glm-5.3"), "z-ai/glm-5.3");
    assert.equal(modelKeyFromId("deepseek/x"), "deepseek/x");
  });

  test("YAML structural tokens and whitespace are rejected", () => {
    for (const bad of ["a b", "a:b", "a#b", "a{b", "a}b", "a[b", "a]b", "a@b", "a&b", "a*b", "a!b", "a|b", "a>b", "a'b", 'a"b', "a%b", "a`b", "a,b"]) {
      assert.equal(modelKeyFromId(bad), "", `must reject ${JSON.stringify(bad)}`);
    }
  });

  test("a leading YAML indicator is rejected", () => {
    assert.equal(modelKeyFromId("-list"), "");
    assert.equal(modelKeyFromId("&anchor"), "");
    assert.equal(modelKeyFromId("*alias"), "");
  });

  test("an empty id has no key", () => {
    assert.equal(modelKeyFromId(""), "");
    assert.equal(modelKeyFromId("  "), "");
    assert.equal(modelKeyFromId(null), "");
  });
});

describe("protocolFromEngineApi — the reverse map is many-to-one, and says so", () => {
  test("anthropic-messages maps back to anthropic", () => {
    assert.equal(protocolFromEngineApi("anthropic-messages"), "anthropic");
  });

  test("everything else reads back as openai, gemini included", () => {
    // The forward map sends BOTH openai and gemini to
    // `openai-completions`, so the reverse cannot recover the
    // distinction. That is why the store keeps the webui record beside
    // the engine fields instead of reconstructing from them.
    assert.equal(protocolFromEngineApi("openai-completions"), "openai");
    assert.equal(protocolFromEngineApi("gemini"), "openai");
    assert.equal(protocolFromEngineApi(undefined), "openai");
  });
});

// =====================================================================
// Pure projection: record → engine fields
// =====================================================================

describe("projectRecordToEngine — eligibility", () => {
  test("a complete byok record projects every engine field", () => {
    const out = projectRecordToEngine(rec(BYOK));
    assert.equal(out.name, "Gateway");
    assert.equal(out.kind, "custom");
    assert.equal(out.enabled, true);
    assert.equal(out.api, "openai-completions");
    assert.deepEqual(out.options, {
      apiKey: "sk-store-key-aaaa",
      baseURL: "https://api.example.com",
      authMode: "api-key",
    });
    assert.deepEqual(out.models, { m1: { name: "M1", limit: { context: 128000 } } });
  });

  test("protocol maps to the engine's api format", () => {
    assert.equal(projectRecordToEngine(rec({ ...BYOK, protocol: "anthropic" })).api, "anthropic-messages");
    // gemini has no engine-native format; its OpenAI-compat endpoint is
    // what a byok caller points at.
    assert.equal(projectRecordToEngine(rec({ ...BYOK, protocol: "gemini" })).api, "openai-completions");
  });

  test("an empty header map is omitted, never emitted as {}", () => {
    // `normaliseProvider` always materialises `auth.headers`, and `{}`
    // is TRUTHY — a truthiness test would stamp `headers: {}` on every
    // provider that never configured one.
    const out = projectRecordToEngine(rec({ ...BYOK, auth: { ...BYOK.auth } }));
    assert.equal("headers" in out.options, false);
    const withHeaders = projectRecordToEngine(
      rec({ ...BYOK, auth: { ...BYOK.auth, headers: { "X-Tenant": "acme" } } }),
    );
    assert.deepEqual(withHeaders.options.headers, { "X-Tenant": "acme" });
  });

  test("ineligible records project to {} — and the reason is each one", () => {
    const cases = [
      ["coding-plan auth", { ...BYOK, auth: { ...BYOK.auth, type: "coding-plan" } }],
      ["disabled", { ...BYOK, enabled: false }],
      ["no apiKey", { ...BYOK, auth: { type: "byok", baseURL: "https://x" } }],
      ["no baseURL", { ...BYOK, auth: { type: "byok", apiKey: "sk-aaaaaaaaa" } }],
    ];
    for (const [why, raw] of cases) {
      assert.deepEqual(projectRecordToEngine(rec(raw)), {}, `must be ineligible: ${why}`);
    }
    assert.deepEqual(projectRecordToEngine(null), {});
    assert.deepEqual(projectRecordToEngine("nope"), {});
  });

  test("a model whose label equals its id carries no name", () => {
    const out = projectRecordToEngine(
      rec({ ...BYOK, models: [{ id: "m1" }] }),
    );
    assert.deepEqual(out.models, { m1: {} });
  });

  test("thinking levels and modalities become the engine's own shapes", () => {
    const out = projectRecordToEngine(
      rec({ ...BYOK, models: [{ id: "m", thinkingLevels: ["low", "high"], modalities: ["text", "image"] }] }),
    );
    assert.deepEqual(out.models.m.thinking, { effortOptions: ["low", "high"] });
    assert.deepEqual(out.models.m.modalities, { input: ["text", "image"] });
  });
});

// =====================================================================
// Pure projection: engine entry → record (the read side)
// =====================================================================

describe("recordFromEngineEntry — the lossless path and the legacy path", () => {
  test("a foreign entry is never a catalogue record", () => {
    // No ownership marker means the operator wrote it; it has never
    // been in the catalogue and must not start being.
    assert.equal(recordFromEngineEntry("manual", { name: "Manual", api: "openai-completions" }), null);
  });

  test("the embedded record is returned verbatim, re-normalised", () => {
    const original = rec({
      id: "gw",
      label: "Gateway",
      protocol: "gemini",
      auth: { type: "byok", apiKey: "sk-store-key-aaaa", baseURL: "https://x" },
      models: [{ id: "z-ai/glm-5.3", contextLimit: 1 }],
    });
    const entry = { ...projectRecordToEngine(original), [WEBUI_OWNED_MARKER]: true, [WEBUI_PROVIDER_MARKER]: original };
    const back = recordFromEngineEntry("gw", entry);
    assert.deepEqual(back, original);
    // The gemini protocol is the proof the record path is lossless: the
    // engine fields say `openai-completions`, so a reconstruction would
    // have said `openai`.
    assert.equal(back.protocol, "gemini");
  });

  test("a hand-tampered record cannot put a malformed row on the wire", () => {
    const entry = {
      api: "openai-completions",
      options: { apiKey: "sk-aaaaaaaaa" },
      [WEBUI_OWNED_MARKER]: true,
      [WEBUI_PROVIDER_MARKER]: { id: "not a legal id", protocol: "nope" },
    };
    // The record is rejected, and reconstruction from the engine
    // fields takes over rather than the bad record reaching the API.
    const back = recordFromEngineEntry("gw", entry);
    assert.equal(back.id, "gw");
    assert.equal(back.protocol, "openai");
  });

  test("a pre-B11 entry (marker but no record) is reconstructed", () => {
    // This is the real upgrade path: an installation that has been
    // running webui since ticket 05 has `_webui_owned` entries with NO
    // record beside them. Reconstructing is lossy by the reverse map,
    // and the alternative is an empty catalogue.
    const entry = {
      name: "Old",
      kind: "custom",
      enabled: true,
      api: "anthropic-messages",
      options: { apiKey: "sk-old-key-aaaaa", baseURL: "https://old", authMode: "api-key" },
      models: { m: { name: "M", limit: { context: 4096 }, thinking: { effortOptions: ["low"] } } },
      [WEBUI_OWNED_MARKER]: true,
    };
    const back = recordFromEngineEntry("old", entry);
    assert.equal(back.id, "old");
    assert.equal(back.label, "Old");
    assert.equal(back.protocol, "anthropic");
    assert.equal(back.auth.apiKey, "sk-old-key-aaaaa");
    assert.equal(back.auth.baseURL, "https://old");
    assert.deepEqual(back.models, [
      { id: "m", label: "M", contextLimit: 4096, thinkingLevels: ["low"] },
    ]);
  });

  test("a pre-B11 entry with no apiKey is not a record at all", () => {
    // The old sync never wrote a key-less entry, so this cannot happen
    // from webui — but a hand edit can, and a key-less provider is not
    // something the catalogue can serve.
    assert.equal(
      recordFromEngineEntry("x", { api: "openai-completions", options: {}, [WEBUI_OWNED_MARKER]: true }),
      null,
    );
  });

  test("providerRecordsFromTree keeps tree order and skips foreign keys", () => {
    const tree = {
      zz: { [WEBUI_OWNED_MARKER]: true, options: { apiKey: "sk-aaaaaaaaa" }, api: "openai-completions" },
      foreign: { name: "Manual" },
      aa: { [WEBUI_OWNED_MARKER]: true, options: { apiKey: "sk-bbbbbbbbb" }, api: "openai-completions" },
    };
    assert.deepEqual(providerRecordsFromTree(tree).map((r) => r.id), ["zz", "aa"]);
    assert.deepEqual(providerRecordsFromTree(null), []);
  });
});

// =====================================================================
// Pure merge: the ownership rule
// =====================================================================

describe("buildProviderStoreWrite — ownership", () => {
  test("a foreign entry survives a write that does not mention it", () => {
    const foreign = { name: "Manual", kind: "custom", api: "openai-completions", options: { apiKey: "sk-op" } };
    const plan = buildProviderStoreWrite({ manual: foreign }, [rec(BYOK)]);
    assert.deepEqual(plan.tree.manual, foreign, "verbatim, not re-projected");
    assert.deepEqual(plan.preserved, ["manual"]);
  });

  test("a webui-owned entry the operator removed is deleted", () => {
    const plan = buildProviderStoreWrite(
      { gone: { [WEBUI_OWNED_MARKER]: true, [WEBUI_PROVIDER_MARKER]: rec(BYOK) } },
      [],
    );
    assert.equal("gone" in plan.tree, false);
  });

  test("records come FIRST, in the caller's order; foreign entries follow", () => {
    // The catalogue API returns this order verbatim, and the order an
    // operator sees in the dialog has always been the order they PUT.
    const plan = buildProviderStoreWrite(
      { manual: { name: "Manual" } },
      [rec({ ...BYOK, id: "b" }), rec({ ...BYOK, id: "a" })],
    );
    assert.deepEqual(Object.keys(plan.tree), ["b", "a", "manual"]);
    assert.deepEqual(plan.records, ["b", "a"]);
  });

  test("an INELIGIBLE record still occupies its key, marked, with no engine fields", () => {
    // This is the difference from the double write: the old sync dropped
    // a disabled provider and a coding-plan provider from the engine
    // tree entirely, so they lived in one file and not the other. Here
    // the record survives; only the engine projection is absent.
    const plan = buildProviderStoreWrite({}, [rec({ ...BYOK, enabled: false })]);
    const entry = plan.tree.gw;
    assert.equal(entry[WEBUI_OWNED_MARKER], true);
    assert.equal(entry.api, undefined, "no engine fields");
    assert.equal(entry[WEBUI_PROVIDER_MARKER].enabled, false);
  });

  test("a record with an illegal engine key is still stored", () => {
    // `normaliseProvider` enforces a stricter id grammar than the store
    // key needs, so this can only arrive from a direct engine-module
    // caller. Dropping it would be the one loss this batch cannot have.
    const plan = buildProviderStoreWrite({}, [{ id: "a b", label: "L", auth: {}, models: [] }]);
    assert.equal(Object.keys(plan.tree).length, 1);
    assert.equal(plan.records[0], "a b");
  });

  test("a pre-B11 owned entry is replaced by the record, not kept", () => {
    const plan = buildProviderStoreWrite(
      { gw: { [WEBUI_OWNED_MARKER]: true, api: "openai-completions", options: { apiKey: "sk-stale" } } },
      [rec(BYOK)],
    );
    assert.equal(plan.tree.gw[WEBUI_PROVIDER_MARKER].auth.apiKey, "sk-store-key-aaaa");
    assert.deepEqual(plan.preserved, []);
  });

  test("a webui key that collides with a foreign entry overwrites it (pinned debt)", () => {
    // KNOWN DEBT 3 in `engine/provider-writes.js`: the key IS the
    // runtime id, so silently suffixing it would break a recorded
    // model pick. The pre-existing behaviour is pinned here so the
    // choice stays visible rather than drifting.
    const plan = buildProviderStoreWrite(
      { gw: { name: "Operator's own gw", options: { apiKey: "sk-operator" } } },
      [rec(BYOK)],
    );
    assert.equal(plan.tree.gw[WEBUI_OWNED_MARKER], true);
    assert.equal(plan.tree.gw[WEBUI_PROVIDER_MARKER].auth.apiKey, "sk-store-key-aaaa");
  });

  test("a non-object entry in the existing tree is not carried", () => {
    const plan = buildProviderStoreWrite({ junk: "not-an-object" }, []);
    assert.deepEqual(plan.tree, {});
  });
});

// =====================================================================
// Read: raw document
// =====================================================================

describe("readEngineConfigRaw — refusal, not overwrite", () => {
  test("a missing file is an empty document, not an error", () => {
    const r = readEngineConfigRaw(join(engineDir, "absent.yaml"));
    assert.equal(r.ok, true);
    assert.deepEqual(r.raw, {});
    assert.equal(r.exists, false);
  });

  test("an unparseable file is refused, and the file is left alone", () => {
    writeFileSync(configPath, "custom_provider:\n  - [unbalanced\n", "utf8");
    const before = readFileSync(configPath, "utf8");
    const r = readEngineConfigRaw(configPath);
    assert.equal(r.ok, false);
    assert.equal(r.code, "ENGINE_CONFIG_UNREADABLE");
    assert.equal(readFileSync(configPath, "utf8"), before, "the refusal must not touch it");
  });

  test("a YAML document that is not a mapping is refused", () => {
    writeFileSync(configPath, "- just\n- a\n- list\n", "utf8");
    const r = readEngineConfigRaw(configPath);
    assert.equal(r.ok, false);
    assert.equal(r.code, "ENGINE_CONFIG_UNREADABLE");
  });

  test("an empty file is an empty document", () => {
    writeFileSync(configPath, "", "utf8");
    const r = readEngineConfigRaw(configPath);
    assert.equal(r.ok, true);
    assert.deepEqual(r.raw, {});
  });
});

// =====================================================================
// Read: the store
// =====================================================================

describe("readProviderStore — which file is the authority", () => {
  test("no marker means the store contributes nothing", () => {
    writeFileSync(
      configPath,
      yaml.dump({
        custom_provider: {
          old: { [WEBUI_OWNED_MARKER]: true, api: "openai-completions", options: { apiKey: "sk-old-key" } },
        },
      }),
      "utf8",
    );
    const s = readProviderStore({ configPath });
    assert.equal(s.ok, true);
    assert.equal(s.migrationDone, false);
    assert.deepEqual(s.records, [], "a store with no marker is not the catalogue");
  });

  test("the marker makes the store the catalogue, in tree order", () => {
    writeFileSync(
      configPath,
      yaml.dump({
        custom_provider: {
          b: { [WEBUI_OWNED_MARKER]: true, api: "openai-completions", options: { apiKey: "sk-bbbbbbbbb" } },
          a: { [WEBUI_OWNED_MARKER]: true, api: "openai-completions", options: { apiKey: "sk-aaaaaaaaa" } },
        },
        [PROVIDER_STORE_MIGRATION_MARKER]: { schema: 1, at: "2026-01-01T00:00:00.000Z" },
      }),
      "utf8",
    );
    const s = readProviderStore({ configPath });
    assert.equal(s.migrationDone, true);
    assert.deepEqual(s.records.map((r) => r.id), ["b", "a"]);
  });

  test("an unreadable store reports the failure instead of pretending to be empty", () => {
    writeFileSync(configPath, "{{{ not yaml\n", "utf8");
    const s = readProviderStore({ configPath });
    assert.equal(s.ok, false);
    assert.equal(s.code, "ENGINE_CONFIG_UNREADABLE");
    // `migrationDone: true` on the failure branch: an unreadable store
    // must never send the read path back to a deprecated file it is
    // about to overwrite on the next write.
    assert.equal(s.migrationDone, true);
  });

  test("an explicit marker with an EMPTY tree is authoritative — no resurrection", () => {
    // The reason the marker is a field rather than an inference: an
    // operator who deletes every provider leaves a store with no
    // webui entries, and inferring "never migrated" from that would
    // make a stale deprecated file authoritative again.
    writeFileSync(
      configPath,
      yaml.dump({ custom_provider: {}, [PROVIDER_STORE_MIGRATION_MARKER]: { schema: 1 } }),
      "utf8",
    );
    const s = readProviderStore({ configPath });
    assert.equal(s.migrationDone, true);
    assert.deepEqual(s.records, []);
  });
});

// =====================================================================
// Commit: one atomic rename
// =====================================================================

describe("commitProviderStoreWrite — one write, one rename", () => {
  test("a write stamps the marker and lands the records", async () => {
    const r = await commitProviderStoreWrite({
      configPath,
      raw: {},
      tree: {},
      records: [rec(BYOK)],
      migrated: true,
    });
    assert.equal(r.ok, true);
    assert.equal(r.written, true);
    const doc = yaml.load(readFileSync(configPath, "utf8"));
    assert.ok(doc[PROVIDER_STORE_MIGRATION_MARKER], "the marker rides the same rename");
    assert.equal(doc.custom_provider.gw[WEBUI_PROVIDER_MARKER].auth.apiKey, "sk-store-key-aaaa");
  });

  test("sections the store does not own are preserved verbatim", async () => {
    // The operator's `provider.minimax`, their `defaultModel`, any
    // section a future engine version adds: all of it rides through.
    const seed = {
      provider: { minimax: { name: "MiniMax", models: { "MiniMax-M3": {} } } },
      defaultModel: "m:minimax:MiniMax-M3:u",
      somethingNewInTheEngine: { keep: [1, 2, 3] },
    };
    writeFileSync(configPath, yaml.dump(seed), "utf8");
    await commitProviderStoreWrite({ configPath, raw: seed, tree: {}, records: [rec(BYOK)] });
    const doc = yaml.load(readFileSync(configPath, "utf8"));
    assert.deepEqual(doc.provider, seed.provider);
    assert.equal(doc.defaultModel, seed.defaultModel);
    assert.deepEqual(doc.somethingNewInTheEngine, seed.somethingNewInTheEngine);
  });

  test("an unreadable store is refused and left byte-identical", async () => {
    // The failure an operator actually hits: a config.yaml a future
    // engine version, or a hand edit, made unparseable. The write must
    // refuse it — overwriting would destroy every section the store
    // does not own — and must not so much as re-chmod it.
    const broken = "custom_provider:\n  - [unbalanced\n";
    writeFileSync(configPath, broken, "utf8");
    const r = await commitProviderStoreWrite({ configPath, raw: {}, tree: {}, records: [rec(BYOK)], migrated: true });
    assert.equal(r.ok, false);
    assert.equal(r.code, "ENGINE_STORE_UNREADABLE");
    assert.equal(readFileSync(configPath, "utf8"), broken, "byte-identical after the refusal");
  });

  test("a pre-write failure leaves nothing behind", async () => {
    // A config path whose parent is a regular file: the read finds
    // nothing and the tmp write fails with ENOTDIR, before the tmp
    // file exists.
    const blocked = join(engineDir, "not-a-dir", "config.yaml");
    writeFileSync(join(engineDir, "not-a-dir"), "x", "utf8");
    const r = await commitProviderStoreWrite({ configPath: blocked, raw: {}, tree: {}, records: [rec(BYOK)] });
    assert.equal(r.code, "ENGINE_STORE_WRITE_FAILED");
    assert.deepEqual(readdirSync(engineDir).filter((f) => f.startsWith(".config-tmp-")), []);
    rmSync(join(engineDir, "not-a-dir"), { force: true });
  });

  test("a POST-WRITE failure leaves NO temp file holding plaintext keys", async () => {
    // The tmp file is mode 0600 and carries every apiKey in the
    // catalogue. A failure AFTER it is written — the rename, or the
    // final chmod — must remove it: the old double write had exactly
    // this gap and only ever tested the success path, so one leaked
    // copy of every operator credential accumulated per failed write.
    //
    // `atomicWriteYaml0600` is called directly because the only
    // post-write failure a caller can reach through
    // `commitProviderStoreWrite` is a filesystem race, and a race is
    // not a test. The target here is a NON-EMPTY directory: `rename`
    // onto one fails with ENOTEMPTY on every POSIX filesystem, while
    // the tmp file itself has already been written in full.
    const dirTarget = join(engineDir, "config.yaml");
    mkdirSync(dirTarget, { recursive: true });
    writeFileSync(join(dirTarget, "occupant"), "x", "utf8");
    await assert.rejects(
      () => atomicWriteYaml0600(dirTarget, { custom_provider: { gw: { options: { apiKey: "sk-store-key-aaaa" } } } }),
      "a rename onto a non-empty directory must fail",
    );
    assert.deepEqual(
      readdirSync(engineDir).filter((f) => f.startsWith(".config-tmp-")),
      [],
      "the tmp file carrying the plaintext key must not survive",
    );
  });

  test("the write is 0600 — the document carries plaintext keys", async () => {
    await commitProviderStoreWrite({ configPath, raw: {}, tree: {}, records: [rec(BYOK)], migrated: true });
    const mode = statSync(configPath).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  });

  test("no `.config-tmp-` file survives a successful write", async () => {
    await commitProviderStoreWrite({ configPath, raw: {}, tree: {}, records: [rec(BYOK)], migrated: true });
    assert.deepEqual(readdirSync(engineDir), ["config.yaml"]);
  });

  test("a write that would change nothing does not touch the file", async () => {
    const first = await commitProviderStoreWrite({ configPath, raw: {}, tree: {}, records: [rec(BYOK)], migrated: true });
    assert.equal(first.written, true);
    const mtime = statSync(configPath).mtimeMs;
    await new Promise((r) => setTimeout(r, 12));
    const second = await commitProviderStoreWrite({
      configPath,
      raw: yaml.load(readFileSync(configPath, "utf8")),
      tree: yaml.load(readFileSync(configPath, "utf8")).custom_provider,
      records: [rec(BYOK)],
    });
    assert.equal(second.written, false, "a no-op PUT must not rewrite the operator's file");
    assert.equal(statSync(configPath).mtimeMs, mtime);
  });

  test("the marker is stamped even when the catalogue is emptied", async () => {
    writeFileSync(
      configPath,
      yaml.dump({
        custom_provider: {
          gw: { [WEBUI_OWNED_MARKER]: true, [WEBUI_PROVIDER_MARKER]: rec(BYOK) },
        },
      }),
      "utf8",
    );
    const raw = yaml.load(readFileSync(configPath, "utf8"));
    const r = await commitProviderStoreWrite({ configPath, raw, tree: raw.custom_provider, records: [], migrated: true });
    assert.equal(r.ok, true);
    const doc = yaml.load(readFileSync(configPath, "utf8"));
    assert.deepEqual(doc.custom_provider, {});
    assert.ok(doc[PROVIDER_STORE_MIGRATION_MARKER], "an emptied catalogue still closes the deprecated file");
  });
});
