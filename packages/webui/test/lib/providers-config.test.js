// webui/test/lib/providers-config.test.js
// Unit tests for server/lib/providers-config.js — schema parsing,
// layered resolution + deep merge, masking, and the protocol probe.
//
// Why this test exists: providers-config is the load-bearing module
// for the v2 supplier configuration system (ticket 01). The masking
// contract is security-critical (apiKey must never appear in
// plaintext in any response path), and the layered merge has three
// independent rules — same-id provider deep merge, model dedupe by
// id with higher layer winning, and the env > cwd > user priority
// order. A regression in any of those is silent (a stale catalogue,
// a leaked credential).
//
// Test strategy: pure-function unit tests. The module has its own
// state (the user-level file path comes from `MCODE_WEBUI_DATA_DIR`),
// so each test sets / restores the env and writes to a tmp dir. The
// `validateKeyFormat` and `maskKey` paths are pure functions and
// don't need FS setup.

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const absPath = (rel) =>
  pathToFileURL(join(import.meta.dirname, "..", "..", "server", rel)).href;

const providersConfig = await import(absPath("lib/providers-config.js"));

let _tmpDataDir;
let _tmpCwd;
let _origDataDir;
let _origCwdEnv;
let _origCwd;

before(async () => {
  _tmpDataDir = mkdtempSync(join(tmpdir(), "webui-providers-test-"));
  _tmpCwd = mkdtempSync(join(tmpdir(), "webui-providers-cwd-"));
  _origDataDir = process.env.MCODE_WEBUI_DATA_DIR;
  _origCwdEnv = process.env.MCODE_WEBUI_MODELS_CONFIG;
  _origCwd = process.cwd();
  process.env.MCODE_WEBUI_DATA_DIR = _tmpDataDir;
  process.env.MCODE_WEBUI_MODELS_CONFIG = "";
  // chdir into the cwd tmp so cwd-layer reads are scoped.
  process.chdir(_tmpCwd);
});

after(async () => {
  if (_origDataDir === undefined) delete process.env.MCODE_WEBUI_DATA_DIR;
  else process.env.MCODE_WEBUI_DATA_DIR = _origDataDir;
  if (_origCwdEnv === undefined) delete process.env.MCODE_WEBUI_MODELS_CONFIG;
  else process.env.MCODE_WEBUI_MODELS_CONFIG = _origCwdEnv;
  try {
    process.chdir(_origCwd);
  } catch {}
  if (_tmpDataDir) try { rmSync(_tmpDataDir, { recursive: true, force: true }); } catch {}
  if (_tmpCwd) try { rmSync(_tmpCwd, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  // Reset the cwd-layer file between cases so prior tests don't leak.
  const cwdFile = join(_tmpCwd, "models.json");
  if (existsSync(cwdFile)) rmSync(cwdFile);
  // Reset the user-level file too (read + clear).
  const userFile = join(_tmpDataDir, "providers.json");
  if (existsSync(userFile)) rmSync(userFile);
});

// ---------------------------------------------------------------------
// maskKey — the security-critical pure function.
// ---------------------------------------------------------------------

describe("maskKey — apiKey masking", () => {
  test("empty string returns empty string (no field on the wire)", () => {
    assert.equal(providersConfig.maskKey(""), "");
  });

  test("non-string returns empty string", () => {
    assert.equal(providersConfig.maskKey(undefined), "");
    assert.equal(providersConfig.maskKey(null), "");
    assert.equal(providersConfig.maskKey(123), "");
  });

  test("very short keys (length < 8) round-trip to ***", () => {
    // Any key shorter than 8 chars is fully hidden — the first/last
    // framing has no visible budget to spend on. Pinned because
    // accidental leaks of a 4-char secret would otherwise show
    // "abcd" verbatim.
    assert.equal(providersConfig.maskKey("abcd"), "***");
    assert.equal(providersConfig.maskKey("1234567"), "***");
  });

  test("8-12 char keys show first 2 + *** + last 2", () => {
    assert.equal(providersConfig.maskKey("abcdefgh"), "ab***gh");
    assert.equal(providersConfig.maskKey("abcdefghij"), "ab***ij");
    assert.equal(providersConfig.maskKey("abcdefghijkl"), "ab***kl");
  });

  test("long keys (> 12) show first 4 + *** + last 4", () => {
    assert.equal(
      providersConfig.maskKey("sk-realkey-abcdefgh12345"),
      "sk-r***2345",
    );
    assert.equal(
      providersConfig.maskKey("x7y8z9abcdefgh1234567890"),
      "x7y8***7890",
    );
  });

  test("masking is NOT idempotent (idempotence not required by the contract)", () => {
    // The masking rule is "first N + *** + last M", which is
    // deliberately lossy. Calling it twice on a long key produces a
    // tighter mask the second time — that is FINE: the only contract
    // is that the plaintext NEVER appears in any output. A client
    // that PUTs a masked key back is not a real use case (the key
    // material lives on disk, not on the wire).
    const once = providersConfig.maskKey("sk-realkey-abcdefgh12345");
    const twice = providersConfig.maskKey(once);
    assert.equal(twice.includes("realkey"), false, "no plaintext leaks");
    assert.equal(once.includes("realkey"), false, "no plaintext in first mask");
  });

  test("whitespace is trimmed before framing", () => {
    // Surrounding whitespace stripped before the length check; a
    // 14-char payload with whitespace frames as a 14-char payload
    // without it.
    assert.equal(
      providersConfig.maskKey("  sk-abcdefgh1234  "),
      "sk-a***1234",
    );
    // Trimmed-but-still-short keys collapse to *** as usual.
    assert.equal(providersConfig.maskKey("  abcdefg  "), "***");
  });
});

// ---------------------------------------------------------------------
// validateKeyFormat — the no-network contract.
// ---------------------------------------------------------------------

describe("validateKeyFormat — no-network local validation", () => {
  test("missing auth returns ok:false with reason", () => {
    assert.equal(providersConfig.validateKeyFormat(null).ok, false);
    assert.equal(providersConfig.validateKeyFormat({}).ok, false);
  });

  test("unknown auth type rejected", () => {
    assert.equal(
      providersConfig.validateKeyFormat({ type: "oauth", apiKey: "sk-realkey-aaa" })
        .ok,
      false,
    );
  });

  test("byok: empty key rejected", () => {
    const r = providersConfig.validateKeyFormat({ type: "byok", apiKey: "" });
    assert.equal(r.ok, false);
    assert.match(r.reason, /required/);
  });

  test("byok: short key (< 8) rejected", () => {
    const r = providersConfig.validateKeyFormat({ type: "byok", apiKey: "short" });
    assert.equal(r.ok, false);
    assert.match(r.reason, /too short/);
  });

  test("byok: long key (>= 8) accepted", () => {
    const r = providersConfig.validateKeyFormat({
      type: "byok",
      apiKey: "sk-realkey-abcdefgh",
    });
    assert.equal(r.ok, true);
  });

  test("coding-plan: empty key with baseURL accepted (no credential probe)", () => {
    // coding-plan auth can be opaque — the provider may not even
    // expose an apiKey. baseURL alone is enough to fire a probe.
    const r = providersConfig.validateKeyFormat({
      type: "coding-plan",
      baseURL: "https://proxy.example.com",
    });
    assert.equal(r.ok, true);
  });

  test("byok: oversized key (> 4096) rejected", () => {
    const big = "a".repeat(4097);
    const r = providersConfig.validateKeyFormat({ type: "byok", apiKey: big });
    assert.equal(r.ok, false);
    assert.match(r.reason, /too long/);
  });
});

// ---------------------------------------------------------------------
// normaliseProvider — v1 / v2 record normalisation.
// ---------------------------------------------------------------------

describe("normaliseProvider — schema acceptance", () => {
  test("v2 record round-trips with the same field names", () => {
    const r = providersConfig.normaliseProvider({
      id: "openai_compat",
      label: "OpenAI Compat",
      enabled: true,
      protocol: "openai",
      auth: { type: "byok", apiKey: "sk-realkey-aaa", baseURL: "https://api.openai.com" },
      models: [
        {
          id: "gpt-4o-mini",
          label: "GPT-4o mini",
          contextLimit: 128000,
          thinkingLevels: ["low", "high"],
          modalities: ["text"],
        },
      ],
    });
    assert.equal(r.ok, true);
    assert.equal(r.value.id, "openai_compat");
    assert.equal(r.value.protocol, "openai");
    assert.equal(r.value.auth.apiKey, "sk-realkey-aaa");
    assert.equal(r.value.models.length, 1);
    assert.deepEqual(r.value.models[0].thinkingLevels, ["low", "high"]);
  });

  test("v1 record is accepted (protocol defaults to openai)", () => {
    // v1 didn't carry a `protocol` field. We default to "openai"
    // so a legacy config still loads — the operator can flip it via
    // a PUT later.
    const r = providersConfig.normaliseProvider({
      id: "legacy",
      label: "Legacy",
      models: [{ id: "m1", label: "M1", contextLimit: 4096 }],
    });
    assert.equal(r.ok, true);
    assert.equal(r.value.protocol, "openai");
  });

  test("missing id is rejected", () => {
    const r = providersConfig.normaliseProvider({ protocol: "openai", models: [] });
    assert.equal(r.ok, false);
    assert.match(r.error, /id is required/);
  });

  test("invalid id characters are rejected", () => {
    const r = providersConfig.normaliseProvider({
      id: "bad id with spaces",
      protocol: "openai",
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /must match/);
  });

  test("unknown protocol is rejected", () => {
    const r = providersConfig.normaliseProvider({
      id: "x",
      protocol: "ollama",
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /protocol/);
  });

  test("duplicate model id within one provider is deduped (first wins)", () => {
    const r = providersConfig.normaliseProvider({
      id: "p",
      protocol: "openai",
      auth: { type: "byok", apiKey: "sk-realkey-aaa" },
      models: [
        { id: "m1", label: "first" },
        { id: "m1", label: "second" },
      ],
    });
    assert.equal(r.ok, true);
    assert.equal(r.value.models.length, 1);
    assert.equal(r.value.models[0].label, "first");
  });

  test("models with non-positive contextLimit are dropped", () => {
    const r = providersConfig.normaliseProvider({
      id: "p",
      protocol: "openai",
      auth: { type: "byok", apiKey: "sk-realkey-aaa" },
      models: [
        { id: "m1", contextLimit: 0 },
        { id: "m2", contextLimit: 128000 },
      ],
    });
    assert.equal(r.ok, true);
    const m1 = r.value.models.find((m) => m.id === "m1");
    const m2 = r.value.models.find((m) => m.id === "m2");
    assert.equal(m1.contextLimit, undefined, "contextLimit dropped when 0");
    assert.equal(m2.contextLimit, 128000);
  });
});

// ---------------------------------------------------------------------
// mergeProviderLists — env > cwd > user precedence.
// ---------------------------------------------------------------------

describe("mergeProviderLists — layered precedence + dedupe", () => {
  test("single layer passes through unchanged", () => {
    const out = providersConfig.mergeProviderLists([
      [
        {
          id: "p",
          label: "L",
          protocol: "openai",
          enabled: true,
          auth: { type: "byok", apiKey: "sk-aaaa", baseURL: "" },
          models: [{ id: "m" }],
        },
      ],
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "p");
    assert.equal(out[0].models[0].id, "m");
  });

  test("higher layer overrides same-id provider fields; models deep-merge by id", () => {
    // Ticket contract: "同 id provider 深合并" — same-id provider is
    // a deep merge (label / protocol / enabled / auth from higher
    // layer; models deduped by id with higher layer winning on
    // collision). Wholesale replacement is NOT the rule.
    const lower = [
      {
        id: "p",
        label: "lower",
        protocol: "openai",
        enabled: false,
        auth: { type: "byok", apiKey: "sk-lower", baseURL: "https://lower.example.com" },
        models: [{ id: "m", label: "lower-m" }],
      },
    ];
    const higher = [
      {
        id: "p",
        label: "higher",
        protocol: "anthropic",
        enabled: true,
        auth: { type: "byok", apiKey: "sk-higher-key", baseURL: "" },
        models: [],
      },
    ];
    const out = providersConfig.mergeProviderLists([lower, higher]);
    assert.equal(out.length, 1);
    assert.equal(out[0].label, "higher", "label comes from higher layer");
    assert.equal(out[0].protocol, "anthropic", "protocol comes from higher layer");
    assert.equal(out[0].enabled, true, "enabled comes from higher layer");
    assert.equal(out[0].auth.apiKey, "sk-higher-key", "apiKey comes from higher layer");
    // The lower layer's model survives even though the higher
    // layer's models list is empty — that's the deep-merge contract
    // (NOT wholesale replacement).
    assert.equal(out[0].models.length, 1, "deep merge keeps lower's models");
    assert.equal(out[0].models[0].id, "m");
  });

  test("model dedupe by id with higher layer winning", () => {
    const lower = [
      {
        id: "p",
        label: "L",
        protocol: "openai",
        enabled: true,
        auth: { type: "byok", apiKey: "sk-realkey-aaaa", baseURL: "" },
        models: [
          { id: "m1", label: "l-m1" },
          { id: "m2", label: "l-m2" },
        ],
      },
    ];
    const higher = [
      {
        id: "p",
        label: "H",
        protocol: "openai",
        enabled: true,
        auth: { type: "byok", apiKey: "sk-realkey-aaaa", baseURL: "" },
        models: [
          { id: "m1", label: "h-m1" },
          { id: "m3", label: "h-m3" },
        ],
      },
    ];
    const out = providersConfig.mergeProviderLists([lower, higher]);
    const byId = Object.fromEntries(out[0].models.map((m) => [m.id, m.label]));
    assert.equal(byId.m1, "h-m1", "higher layer wins model-level collision");
    assert.equal(byId.m2, "l-m2", "lower-only models preserved");
    assert.equal(byId.m3, "h-m3", "higher-only models preserved");
  });

  test("three-layer precedence: env > cwd > user", () => {
    // env layer (top), cwd layer (middle), user layer (bottom).
    // We pass [user, cwd, env] to mergeProviderLists — the helper
    // iterates lowest→highest so later layers overwrite earlier
    // ones on scalar fields. Model union by id.
    const user = [
      {
        id: "user-only",
        label: "user-only",
        protocol: "openai",
        enabled: true,
        auth: { type: "byok", apiKey: "sk-realkey-user", baseURL: "" },
        models: [],
      },
      {
        id: "shared",
        label: "user-label",
        protocol: "openai",
        enabled: true,
        auth: { type: "byok", apiKey: "sk-realkey-user", baseURL: "" },
        models: [{ id: "user-m" }],
      },
    ];
    const cwd = [
      {
        id: "cwd-only",
        label: "cwd-only",
        protocol: "openai",
        enabled: true,
        auth: { type: "byok", apiKey: "sk-realkey-cwd", baseURL: "" },
        models: [],
      },
      {
        id: "shared",
        label: "cwd-label",
        protocol: "openai",
        enabled: true,
        auth: { type: "byok", apiKey: "sk-realkey-cwd", baseURL: "" },
        models: [{ id: "cwd-m" }],
      },
    ];
    const env = [
      {
        id: "env-only",
        label: "env-only",
        protocol: "openai",
        enabled: true,
        auth: { type: "byok", apiKey: "sk-realkey-env", baseURL: "" },
        models: [],
      },
      {
        id: "shared",
        label: "env-label",
        protocol: "openai",
        enabled: true,
        auth: { type: "byok", apiKey: "sk-realkey-env", baseURL: "" },
        models: [{ id: "env-m" }, { id: "user-m" }], // user-m collides with user-layer entry
      },
    ];
    const out = providersConfig.mergeProviderLists([user, cwd, env]);
    const byId = Object.fromEntries(out.map((p) => [p.id, p]));
    assert.equal(byId["user-only"].label, "user-only");
    assert.equal(byId["cwd-only"].label, "cwd-only");
    assert.equal(byId["env-only"].label, "env-only");
    assert.equal(byId["shared"].label, "env-label", "env wins same-id scalar");
    // 'shared' models are unioned by id across all three layers:
    // user-m + cwd-m + env-m (env's user-m collides with user's
    // user-m, but it's the same id → kept once). The deep merge is
    // a UNION, not a replacement.
    const sharedModels = byId["shared"].models.map((m) => m.id).sort();
    assert.deepEqual(sharedModels, ["cwd-m", "env-m", "user-m"]);
  });
});

// ---------------------------------------------------------------------
// loadProvidersConfig — full layered resolution from disk.
// ---------------------------------------------------------------------

describe("loadProvidersConfig — full layered resolution", () => {
  beforeEach(() => {
    // each test starts with no files in any layer
  });

  test("missing files in every layer returns an empty config", () => {
    const cfg = providersConfig.loadProvidersConfig();
    assert.equal(cfg.providers.length, 0);
    assert.equal(cfg.version, providersConfig.SCHEMA_VERSION);
  });

  test("user-level layer is read on every call (no in-process cache)", () => {
    const userPath = providersConfig.getUserLevelPath();
    writeFileSync(
      userPath,
      JSON.stringify({
        version: 2,
        providers: [
          {
            id: "user1",
            label: "User1",
            protocol: "openai",
            auth: { type: "byok", apiKey: "sk-realkey-aaaa" },
            models: [{ id: "m1" }],
          },
        ],
      }),
    );
    const cfg = providersConfig.loadProvidersConfig();
    assert.equal(cfg.providers.length, 1);
    assert.equal(cfg.providers[0].id, "user1");
  });

  test("v1 cwd file is upgraded in place (no protocol field)", () => {
    // v1 records omitted the `protocol` field; the parser defaults
    // it to "openai" so legacy configs keep loading. Operators who
    // care about protocol fidelity can PUT the v2 form afterwards.
    writeFileSync(
      join(_tmpCwd, "models.json"),
      JSON.stringify({
        providers: [
          { id: "v1prov", label: "V1", models: [{ id: "v1m", contextLimit: 4096 }] },
        ],
      }),
    );
    const cfg = providersConfig.loadProvidersConfig();
    const v1 = cfg.providers.find((p) => p.id === "v1prov");
    assert.ok(v1, "v1 provider present");
    assert.equal(v1.protocol, "openai", "v1 default protocol is openai");
    assert.equal(v1.models[0].contextLimit, 4096, "v1 contextLimit preserved");
  });

  test("env override (MCODE_WEBUI_MODELS_CONFIG) wins over cwd", () => {
    // Write a cwd-layer file with one provider and an env-layer
    // file with another, then point the env override at the env
    // file. The env provider should win.
    writeFileSync(
      join(_tmpCwd, "models.json"),
      JSON.stringify({
        providers: [
          {
            id: "cwd-prov",
            label: "Cwd",
            protocol: "openai",
            auth: { type: "byok", apiKey: "sk-realkey-cwd" },
            models: [],
          },
        ],
      }),
    );
    const envFile = join(_tmpCwd, "env-layer.json");
    writeFileSync(
      envFile,
      JSON.stringify({
        providers: [
          {
            id: "env-prov",
            label: "Env",
            protocol: "anthropic",
            auth: { type: "byok", apiKey: "sk-realkey-env" },
            models: [],
          },
        ],
      }),
    );
    process.env.MCODE_WEBUI_MODELS_CONFIG = envFile;
    try {
      const cfg = providersConfig.loadProvidersConfig();
      const ids = cfg.providers.map((p) => p.id).sort();
      // env override path is honoured; cwd-layer file is NOT read
      // (the env override IS the cwd path under the rule).
      assert.deepEqual(ids, ["env-prov"]);
    } finally {
      delete process.env.MCODE_WEBUI_MODELS_CONFIG;
    }
  });

  test("env override + cwd file collision: only the env file is read", () => {
    // env override points at file A; cwd/models.json is file B.
    // Per the rule (the env override IS the cwd path), only file A
    // is read.
    const fileA = join(_tmpCwd, "a.json");
    const fileB = join(_tmpCwd, "b.json");
    writeFileSync(
      fileA,
      JSON.stringify({
        providers: [
          { id: "A", label: "A", protocol: "openai", auth: { type: "byok", apiKey: "sk-realkey-aaaa" }, models: [] },
        ],
      }),
    );
    writeFileSync(
      fileB,
      JSON.stringify({
        providers: [
          { id: "B", label: "B", protocol: "openai", auth: { type: "byok", apiKey: "sk-realkey-bbbb" }, models: [] },
        ],
      }),
    );
    process.env.MCODE_WEBUI_MODELS_CONFIG = fileA;
    try {
      const cfg = providersConfig.loadProvidersConfig();
      const ids = cfg.providers.map((p) => p.id);
      assert.deepEqual(ids, ["A"]);
    } finally {
      delete process.env.MCODE_WEBUI_MODELS_CONFIG;
    }
  });
});

// ---------------------------------------------------------------------
// publicView — masking is applied EVERYWHERE.
// ---------------------------------------------------------------------

describe("publicView — apiKey masked in every response path", () => {
  test("apiKey becomes apiKeyMasked; plaintext is gone", () => {
    const view = providersConfig.publicView({
      id: "p",
      label: "L",
      protocol: "openai",
      enabled: true,
      auth: { type: "byok", apiKey: "sk-realkey-abcdefghij", baseURL: "https://api.openai.com" },
      models: [{ id: "m1", label: "M1" }],
    });
    // 23-char payload (> 12) → first 4 + *** + last 4
    assert.equal(view.auth.apiKeyMasked, "sk-r***ghij");
    assert.equal(view.auth.hasKey, true);
    assert.equal(view.auth.type, "byok");
    // Pinned: the plaintext MUST NOT appear anywhere in the view.
    const json = JSON.stringify(view);
    assert.equal(json.includes("realkey"), false, "plaintext apiKey never appears in publicView");
  });

  test("hasKey is false when apiKey is empty", () => {
    const view = providersConfig.publicView({
      id: "p",
      label: "L",
      protocol: "openai",
      enabled: true,
      auth: { type: "byok", apiKey: "", baseURL: "" },
      models: [],
    });
    assert.equal(view.auth.hasKey, false);
    assert.equal(view.auth.apiKeyMasked, "");
  });

  test("model fields pass through; contextLimit and arrays only when present", () => {
    const view = providersConfig.publicView({
      id: "p",
      label: "L",
      protocol: "anthropic",
      enabled: true,
      auth: { type: "byok", apiKey: "sk-abcdefghij", baseURL: "" },
      models: [
        { id: "m1", label: "M1", thinkingLevels: ["low", "high"], modalities: ["text"] },
        { id: "m2", label: "M2" }, // no extras
      ],
    });
    assert.deepEqual(view.models[0].thinkingLevels, ["low", "high"]);
    assert.deepEqual(view.models[0].modalities, ["text"]);
    assert.equal(view.models[1].thinkingLevels, undefined);
    assert.equal(view.models[1].modalities, undefined);
  });
});

// ---------------------------------------------------------------------
// writeProvidersConfig — atomic persistence.
// ---------------------------------------------------------------------

describe("writeProvidersConfig — atomic persistence", () => {
  test("writes the user-level file with v2 schema", () => {
    const r = providersConfig.writeProvidersConfig({
      version: 2,
      providers: [
        {
          id: "p",
          label: "L",
          protocol: "openai",
          auth: { type: "byok", apiKey: "sk-realkey-aaa" },
          models: [{ id: "m1" }],
        },
      ],
    });
    assert.equal(r.ok, true);
    const written = JSON.parse(
      readFileSync(providersConfig.getUserLevelPath(), "utf8"),
    );
    assert.equal(written.version, 2);
    assert.equal(written.providers[0].id, "p");
    // Pinned: plaintext key persists to disk (it has to, the engine
    // needs it) — but the masking contract only governs RESPONSES.
    assert.equal(written.providers[0].auth.apiKey, "sk-realkey-aaa");
  });

  test("rejects unknown protocol in any provider", () => {
    const r = providersConfig.writeProvidersConfig({
      version: 2,
      providers: [{ id: "p", protocol: "ollama", auth: { type: "byok" } }],
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "BAD_BODY");
  });

  test("rejects duplicate provider id", () => {
    const r = providersConfig.writeProvidersConfig({
      version: 2,
      providers: [
        { id: "p", protocol: "openai", auth: { type: "byok", apiKey: "sk-aaaa" }, models: [] },
        { id: "p", protocol: "openai", auth: { type: "byok", apiKey: "sk-bbbb" }, models: [] },
      ],
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "BAD_BODY");
  });

  test("rejects empty body", () => {
    const r1 = providersConfig.writeProvidersConfig(null);
    assert.equal(r1.ok, false);
    const r2 = providersConfig.writeProvidersConfig({});
    assert.equal(r2.ok, false);
  });

  test("atomic write leaves no .tmp file behind", () => {
    providersConfig.writeProvidersConfig({
      version: 2,
      providers: [
        {
          id: "p",
          protocol: "openai",
          auth: { type: "byok", apiKey: "sk-realkey-aaa" },
          models: [],
        },
      ],
    });
    const tmp = `${providersConfig.getUserLevelPath()}.tmp`;
    assert.equal(existsSync(tmp), false, "no leftover .tmp file");
  });
});

// ---------------------------------------------------------------------
// testProvider — local validation gate BEFORE network.
// ---------------------------------------------------------------------

describe("testProvider — no network for malformed inputs", () => {
  test("unknown protocol returns BAD_PROTOCOL without a fetch", async () => {
    const r = await providersConfig.testProvider({
      protocol: "ollama",
      auth: { type: "byok", apiKey: "sk-realkey-aaa" },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "BAD_PROTOCOL");
  });

  test("missing apiKey on byok returns INVALID_KEY without a fetch", async () => {
    const r = await providersConfig.testProvider({
      protocol: "openai",
      auth: { type: "byok", apiKey: "" },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "INVALID_KEY");
  });

  test("short apiKey on byok returns INVALID_KEY without a fetch", async () => {
    const r = await providersConfig.testProvider({
      protocol: "openai",
      auth: { type: "byok", apiKey: "short" },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "INVALID_KEY");
  });

  test("coding-plan with no apiKey but a baseURL passes local validation", async () => {
    // We can't reach a real network in this test, so we point at a
    // port that won't accept connections (port 1, reserved).
    // PROBE_FAILED is expected (no server), but the test confirms
    // that INVALID_KEY was NOT the gate — i.e. local validation
    // allowed the probe to fire. The structured error code is the
    // discriminator. `timeoutMs: 200` keeps the suite fast when
    // the OS refuses the connection instantly (TCP RST → fetch
    // rejects with ECONNREFUSED) — without it, a silent blackhole
    // would burn the full 8s default.
    const r = await providersConfig.testProvider({
      protocol: "openai",
      auth: { type: "coding-plan", apiKey: "", baseURL: "http://127.0.0.1:1" },
      timeoutMs: 200,
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "PROBE_FAILED", "validation passed → fetch attempted → probe failed");
  });
});

// ---------------------------------------------------------------------
// applyKeepKeyConvention — ticket 03 keep-existing-key convention.
// ---------------------------------------------------------------------
//
// The UI GETs the masked catalogue (apiKey is `apiKeyMasked: "sk-aa***bb"`),
// then PUTs the same shape back. Without a convention, the masked
// placeholder would replace the plaintext on every edit. The
// convention: an incoming `auth.apiKey === ""` means "do not change the
// existing key for this provider id". The PUT handler is the only caller.

describe("applyKeepKeyConvention — ticket 03 keep-existing-key convention", () => {
  test("incoming apiKey='' copies the existing key when one is on disk", () => {
    const existing = [
      {
        id: "p1",
        label: "P1",
        protocol: "openai",
        auth: { type: "byok", apiKey: "sk-realkey-on-disk-aaaa" },
        models: [],
      },
    ];
    const incoming = [
      {
        id: "p1",
        label: "P1 renamed",
        protocol: "openai",
        auth: { type: "byok", apiKey: "" }, // sentinel
        models: [{ id: "m" }],
      },
    ];
    const merged = providersConfig.applyKeepKeyConvention(existing, incoming);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].auth.apiKey, "sk-realkey-on-disk-aaaa");
    // Other fields untouched by the convention.
    assert.equal(merged[0].label, "P1 renamed");
    assert.deepEqual(merged[0].models, [{ id: "m" }]);
  });

  test("incoming apiKey non-empty is NOT replaced (the user is overwriting)", () => {
    const existing = [
      { id: "p1", auth: { type: "byok", apiKey: "sk-on-disk" } },
    ];
    const incoming = [
      { id: "p1", auth: { type: "byok", apiKey: "sk-new-plaintext" } },
    ];
    const merged = providersConfig.applyKeepKeyConvention(existing, incoming);
    assert.equal(merged[0].auth.apiKey, "sk-new-plaintext");
  });

  test("incoming apiKey='' with NO existing record keeps empty (new provider fails byok validation)", () => {
    // The provider is brand new — there is nothing to keep. The empty
    // key stays, and the normal validation rejects a `byok` record
    // with an empty apiKey. This is the right behaviour: a UI that
    // hits Save without filling the key must not silently inherit
    // some other provider's credential.
    const merged = providersConfig.applyKeepKeyConvention(
      [{ id: "other", auth: { type: "byok", apiKey: "sk-something" } }],
      [{ id: "brand-new", auth: { type: "byok", apiKey: "" } }],
    );
    assert.equal(merged[0].id, "brand-new");
    assert.equal(merged[0].auth.apiKey, "");
  });

  test("absent auth.apiKey on an incoming record copies the user-level key", () => {
    // The convention treats BOTH `auth.apiKey === ""` AND a missing
    // `auth.apiKey` field as the sentinel. A PUT that drops the key
    // field is the normal "no change" gesture from the editor form
    // (which only ever sets the controlled value when the user types).
    // Without this, the API would silently wipe a stored credential
    // whenever a caller forgot to send the field — the v2 normaliser
    // coerces a missing apiKey to "" anyway, so the on-disk write
    // would land as empty. Pinning the behaviour here so a future
    // "absent !== empty" change does not regress to the silent wipe.
    const merged = providersConfig.applyKeepKeyConvention(
      [{ id: "p1", auth: { type: "byok", apiKey: "sk-disk" } }],
      [{ id: "p1", auth: { type: "byok" } }],
    );
    assert.equal(merged[0].auth.apiKey, "sk-disk", "absent key inherits from user-level");
  });

  test("absent auth.apiKey with NO existing record keeps the empty key", () => {
    // Brand-new provider with no key — the empty stays empty, and
    // the normal validation flow rejects a `byok` record with an
    // empty key. Coding-plan records (which allow empty keys) pass
    // through unchanged.
    const merged = providersConfig.applyKeepKeyConvention(
      [{ id: "other", auth: { type: "byok", apiKey: "sk-something" } }],
      [{ id: "brand-new", auth: { type: "byok" } }],
    );
    assert.equal(merged[0].id, "brand-new");
    assert.equal(merged[0].auth.apiKey, "");
  });

  test("returns a new array — the incoming body is not mutated", () => {
    const incoming = [
      { id: "p1", auth: { type: "byok", apiKey: "" } },
    ];
    const merged = providersConfig.applyKeepKeyConvention(
      [{ id: "p1", auth: { type: "byok", apiKey: "sk-disk" } }],
      incoming,
    );
    assert.notEqual(merged, incoming, "new array");
    assert.equal(incoming[0].auth.apiKey, "", "incoming untouched");
  });

  test("a provider with no matching id in existing keeps its empty key", () => {
    const merged = providersConfig.applyKeepKeyConvention(
      [{ id: "other", auth: { type: "byok", apiKey: "sk-disk" } }],
      [{ id: "brand-new", auth: { type: "byok", apiKey: "" } }],
    );
    assert.equal(merged[0].auth.apiKey, "");
  });

  test("absent auth.apiKey on existing record: copies the user-layer key", () => {
    // Acceptance hardening (ticket 03 round 2): a PUT whose body
    // omits the `auth.apiKey` field used to fall through validation
    // and silently land on disk as "" — wiping the stored key. The
    // convention now treats absent the same as empty.
    const merged = providersConfig.applyKeepKeyConvention(
      [{ id: "p1", auth: { type: "byok", apiKey: "sk-on-disk-aaaa" } }],
      [{ id: "p1", auth: { type: "byok" } }],
    );
    assert.equal(merged[0].auth.apiKey, "sk-on-disk-aaaa");
  });

  test("absent auth.apiKey with auth itself omitted: still copies the user-layer key", () => {
    // Defensive: the helper must not throw when `auth` is entirely
    // absent from the incoming record. A bug here would 500 the
    // entire PUT handler on a malformed body.
    const merged = providersConfig.applyKeepKeyConvention(
      [{ id: "p1", auth: { type: "byok", apiKey: "sk-on-disk" } }],
      [{ id: "p1", protocol: "openai", models: [] }],
    );
    assert.equal(merged[0].auth.apiKey, "sk-on-disk");
  });

  test("deliberate key clearing is impossible: no input shape wipes a stored key", () => {
    // The contract: once a key is on disk, no wire shape can clear
    // it. The convention copies the previous key onto EVERY incoming
    // shape that lacks an explicit value ("" or absent). A non-empty
    // value replaces — there is no API call that means "delete the
    // stored key and accept the consequence". Operators who need to
    // rotate put a new key; the convention preserves only on "no
    // change" gestures.
    const existing = [{ id: "p1", auth: { type: "byok", apiKey: "sk-stored" } }];
    const shapes = [
      // explicit empty
      { id: "p1", auth: { type: "byok", apiKey: "" } },
      // absent field
      { id: "p1", auth: { type: "byok" } },
      // absent auth entirely
      { id: "p1", protocol: "openai" },
    ];
    for (const shape of shapes) {
      const merged = providersConfig.applyKeepKeyConvention(existing, [shape]);
      assert.equal(
        merged[0].auth.apiKey,
        "sk-stored",
        `shape ${JSON.stringify(shape.auth)} should keep existing key`,
      );
    }
  });
});

// ---------------------------------------------------------------------
// loadUserLevelProviders — user-layer-only loader (ticket 03 round 2).
// ---------------------------------------------------------------------
//
// The convention reads THIS, not the merged `loadProvidersConfig()`
// result, so editing an env-defined provider does not materialise
// the deployment secret onto the operator-managed user-level file.
// The merged view still wins for the engine — only the on-disk
// write is scoped to the user layer.

describe("loadUserLevelProviders — user-layer-only loader", () => {
  test("returns [] when the user-level file is missing", () => {
    // beforeEach cleared it. Sanity check on the contract.
    assert.deepEqual(providersConfig.loadUserLevelProviders(), []);
  });

  test("returns only the user-level records (not env/cwd)", async () => {
    // Seed the user-level file. The cwd layer is empty in this test
    // because MCODE_WEBUI_MODELS_CONFIG is unset, so what we seed
    // IS the only thing loadUserLevelProviders can see — and it
    // must NOT include any merged material from other layers.
    writeFileSync(
      providersConfig.getUserLevelPath(),
      JSON.stringify({
        version: 2,
        providers: [
          { id: "u1", auth: { type: "byok", apiKey: "sk-user-only-aaaa" } },
        ],
      }),
    );
    const result = providersConfig.loadUserLevelProviders();
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "u1");
    assert.equal(result[0].auth.apiKey, "sk-user-only-aaaa");
  });

  test("env-layer key is NOT visible to loadUserLevelProviders", () => {
    // Set an env-layer file with a key. The user-level file is
    // empty (cleared by beforeEach). loadUserLevelProviders must
    // return [] — the env secret does not leak into the user-layer
    // loader. The convention then has nothing to copy.
    const envPath = join(_tmpCwd, "env-only.json");
    writeFileSync(
      envPath,
      JSON.stringify({
        providers: [
          { id: "envprov", auth: { type: "byok", apiKey: "sk-env-only-aaaa" } },
        ],
      }),
    );
    process.env.MCODE_WEBUI_MODELS_CONFIG = envPath;
    try {
      const result = providersConfig.loadUserLevelProviders();
      assert.deepEqual(result, [], "env-only secrets must not be visible here");
    } finally {
      delete process.env.MCODE_WEBUI_MODELS_CONFIG;
    }
  });
});