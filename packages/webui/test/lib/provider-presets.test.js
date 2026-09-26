// webui/test/lib/provider-presets.test.js
// Unit tests for server/lib/provider-presets.js — the 10-template
// preset gallery + the materialise helper.
//
// Why this test exists: presets are the user-facing "one-click
// enable" surface for provider configuration. Two contracts must
// hold across the catalogue:
//
//   1. Every template passes the v2 schema (`normaliseProvider`).
//      A bad template that silently fails to load would surface
//      as a missing button in the UI rather than a 4xx — a
//      regression that's easy to miss.
//
//   2. Templates never carry key material. A regression that
//      bundled a vendor key into the source would ship a
//      credential anyone can read from the public file.
//      Pinned by an explicit scan of every `auth.apiKey` field.
//
// Plus the cross-cutting concerns (id uniqueness, protocol
// whitelist coverage, model metadata sanity) the rest of the
// product takes for granted.
//
// Test strategy: pure unit tests. The module is data + a couple of
// small lookup helpers; no I/O needed. The materialise tests
// still go through `normaliseProvider` so a future schema change
// shows up here too.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const absPath = (rel) =>
  pathToFileURL(join(import.meta.dirname, "..", "..", "server", rel)).href;

const presets = await import(absPath("lib/provider-presets.js"));
const providersConfig = await import(absPath("lib/providers-config.js"));

// ---------------------------------------------------------------------
// Catalogue invariants.
// ---------------------------------------------------------------------

describe("PROVIDER_PRESETS — catalogue shape", () => {
  test("the catalogue carries exactly 11 presets (per ticket 02 + ticket 06)", () => {
    assert.equal(presets.PROVIDER_PRESETS.length, 11);
  });

  test("every template id is unique (no collisions inside the gallery)", () => {
    const ids = presets.PROVIDER_PRESETS.map((p) => p.id);
    const set = new Set(ids);
    assert.equal(set.size, ids.length, `duplicate ids: ${ids.join(", ")}`);
  });

  test("every id matches the v2 schema regex", () => {
    // The same regex that normaliseProvider enforces — keeps a
    // future template id that uses a forbidden character from
    // slipping into the gallery.
    const re = /^[A-Za-z0-9][A-Za-z0-9_.\-]*$/;
    for (const p of presets.PROVIDER_PRESETS) {
      assert.match(p.id, re, `preset id '${p.id}' must match the v2 schema regex`);
    }
  });

  test("every template's protocol is in the v2 whitelist", () => {
    const allowed = new Set(providersConfig.ALLOWED_PROTOCOLS);
    for (const p of presets.PROVIDER_PRESETS) {
      assert.ok(allowed.has(p.protocol), `preset '${p.id}' has unknown protocol '${p.protocol}'`);
    }
  });

  test("every template's auth.type is in the v2 whitelist", () => {
    const allowed = new Set(providersConfig.ALLOWED_AUTH_TYPES);
    for (const p of presets.PROVIDER_PRESETS) {
      assert.ok(allowed.has(p.auth.type), `preset '${p.id}' has unknown auth.type '${p.auth.type}'`);
    }
  });

  test("the catalogue covers the 11 ticket-named providers", () => {
    // The ticket explicitly lists the 10 (ticket 02) + 1 (ticket 06,
    // deepseek) ids by display name. We assert the canonical id set
    // so a refactor that renames an id (e.g. `minimax` →
    // `minimax-internal`) is forced to revisit the gallery
    // contract.
    const expected = new Set([
      "zhipu",
      "kimi",
      "bailian",
      "volcano",
      "mimo",
      "minimax",
      "opencode-go",
      "openrouter",
      "claude-code",
      "codex",
      "deepseek",
    ]);
    const actual = new Set(presets.getPresetIds());
    assert.deepEqual(actual, expected);
  });

  test("every template has at least one model", () => {
    for (const p of presets.PROVIDER_PRESETS) {
      assert.ok(
        Array.isArray(p.models) && p.models.length > 0,
        `preset '${p.id}' has no models`,
      );
    }
  });

  test("every model's id is non-empty and unique within its preset", () => {
    for (const p of presets.PROVIDER_PRESETS) {
      const seen = new Set();
      for (const m of p.models) {
        assert.ok(typeof m.id === "string" && m.id.length > 0, `preset '${p.id}' has a model with empty id`);
        assert.ok(!seen.has(m.id), `preset '${p.id}' has duplicate model id '${m.id}'`);
        seen.add(m.id);
      }
    }
  });
});

// ---------------------------------------------------------------------
// The security-critical contract: presets NEVER carry key material.
// ---------------------------------------------------------------------

describe("PROVIDER_PRESETS — no key material in templates", () => {
  test("every template's auth.apiKey is the empty string", () => {
    for (const p of presets.PROVIDER_PRESETS) {
      assert.equal(p.auth.apiKey, "", `preset '${p.id}' carries non-empty apiKey`);
    }
  });

  test("the preset-to-materialised helper produces an empty apiKey", () => {
    for (const id of presets.getPresetIds()) {
      const m = presets.presetToMaterialised(id);
      assert.equal(m.auth.apiKey, "", `materialised '${id}' has non-empty apiKey`);
    }
  });

  test("publicPresetView never includes apiKey or apiKeyMasked", () => {
    for (const p of presets.PROVIDER_PRESETS) {
      const view = presets.publicPresetView(p);
      assert.equal(view.auth.apiKey, undefined);
      assert.equal(view.auth.apiKeyMasked, undefined);
      assert.equal(view.auth.hasKey, undefined);
    }
  });

  test("a deep JSON.stringify scan finds no key-shaped strings", () => {
    // Defense in depth: even if the helpers above regressed,
    // a literal scan of the serialised form catches a vendor
    // key (any 16+ char token starting with the conventional
    // "sk-" or "sk_" prefixes).
    const dump = JSON.stringify(presets.PROVIDER_PRESETS);
    assert.equal(/sk-[A-Za-z0-9]{16,}/.test(dump), false, "sk- token in template");
    assert.equal(/sk_[A-Za-z0-9]{16,}/.test(dump), false, "sk_ token in template");
    assert.equal(/xoxb-[A-Za-z0-9]{16,}/.test(dump), false, "xoxb token in template");
  });
});

// ---------------------------------------------------------------------
// Per-preset protocol + auth mapping. Locks the contract from the
// header comment of the module so a refactor can't silently change
// the wire shape without breaking the test.
// ---------------------------------------------------------------------

describe("PROVIDER_PRESETS — protocol/auth mapping", () => {
  // The expected mapping table mirrors the table at the top of
  // provider-presets.js. Any change here MUST be reflected in
  // both places; the test enforces consistency.
  const EXPECTED = [
    ["zhipu", "openai", "byok"],
    ["kimi", "openai", "byok"],
    ["bailian", "openai", "byok"],
    ["volcano", "openai", "byok"],
    ["mimo", "openai", "byok"],
    ["minimax", "openai", "byok"],
    ["opencode-go", "openai", "coding-plan"],
    ["openrouter", "openai", "byok"],
    ["claude-code", "anthropic", "coding-plan"],
    ["codex", "openai", "coding-plan"],
    ["deepseek", "openai", "byok"],
  ];

  for (const [id, protocol, authType] of EXPECTED) {
    test(`${id} → ${protocol} + ${authType}`, () => {
      const p = presets.getPresetById(id);
      assert.ok(p, `preset '${id}' missing from catalogue`);
      assert.equal(p.protocol, protocol);
      assert.equal(p.auth.type, authType);
    });
  }
});

// ---------------------------------------------------------------------
// Schema acceptance — every template round-trips through
// normaliseProvider() so a future schema tightening surfaces here
// rather than at the UI's "Enable" click.
// ---------------------------------------------------------------------

describe("PROVIDER_PRESETS — schema acceptance", () => {
  test("every template passes normaliseProvider()", () => {
    for (const p of presets.PROVIDER_PRESETS) {
      const r = providersConfig.normaliseProvider(p);
      assert.equal(r.ok, true, `preset '${p.id}' failed validation: ${r.error}`);
    }
  });

  test("every template has a non-empty label", () => {
    for (const p of presets.PROVIDER_PRESETS) {
      assert.ok(typeof p.label === "string" && p.label.length > 0, `preset '${p.id}' has empty label`);
    }
  });

  test("contextLimit is a positive integer when present", () => {
    for (const p of presets.PROVIDER_PRESETS) {
      for (const m of p.models) {
        if (m.contextLimit !== undefined) {
          assert.equal(
            Number.isInteger(m.contextLimit) && m.contextLimit > 0,
            true,
            `preset '${p.id}' model '${m.id}' has non-positive contextLimit`,
          );
        }
      }
    }
  });

  test("thinkingLevels is a non-empty string array when present", () => {
    for (const p of presets.PROVIDER_PRESETS) {
      for (const m of p.models) {
        if (m.thinkingLevels !== undefined) {
          assert.ok(
            Array.isArray(m.thinkingLevels) && m.thinkingLevels.length > 0,
            `preset '${p.id}' model '${m.id}' has empty thinkingLevels`,
          );
          for (const lvl of m.thinkingLevels) {
            assert.equal(typeof lvl, "string", `non-string thinking level in '${p.id}/${m.id}'`);
          }
        }
      }
    }
  });

  test("modalities is a non-empty string array when present", () => {
    for (const p of presets.PROVIDER_PRESETS) {
      for (const m of p.models) {
        if (m.modalities !== undefined) {
          assert.ok(
            Array.isArray(m.modalities) && m.modalities.length > 0,
            `preset '${p.id}' model '${m.id}' has empty modalities`,
          );
          for (const mod of m.modalities) {
            assert.equal(typeof mod, "string", `non-string modality in '${p.id}/${m.id}'`);
          }
        }
      }
    }
  });
});

// ---------------------------------------------------------------------
// getPresetById / presetToMaterialised helpers.
// ---------------------------------------------------------------------

describe("getPresetById / presetToMaterialised", () => {
  test("getPresetById returns null for unknown ids", () => {
    assert.equal(presets.getPresetById("not-a-real-preset"), null);
    assert.equal(presets.getPresetById(""), null);
    assert.equal(presets.getPresetById(null), null);
    assert.equal(presets.getPresetById(undefined), null);
    assert.equal(presets.getPresetById(123), null);
  });

  test("getPresetById returns the frozen template for known ids", () => {
    const p = presets.getPresetById("zhipu");
    assert.ok(p);
    assert.equal(p.id, "zhipu");
    assert.equal(p.label, "智谱 (Zhipu / GLM)");
  });

  test("presetToMaterialised sets enabled=true and tags the preset", () => {
    const m = presets.presetToMaterialised("kimi");
    assert.equal(m.enabled, true);
    assert.equal(m.preset, "kimi");
    assert.equal(m.id, "kimi");
    assert.equal(m.auth.apiKey, "");
  });

  test("presetToMaterialised returns null for unknown ids", () => {
    assert.equal(presets.presetToMaterialised("not-a-real-preset"), null);
    assert.equal(presets.presetToMaterialised(""), null);
  });

  test("presetToMaterialised returns a fresh clone (mutations don't leak)", () => {
    const m1 = presets.presetToMaterialised("zhipu");
    m1.label = "MUTATED";
    m1.models.push({ id: "rogue", label: "R" });
    const m2 = presets.presetToMaterialised("zhipu");
    assert.equal(m2.label, "智谱 (Zhipu / GLM)", "label leak");
    assert.equal(m2.models.length, 3, "model array leak");
  });
});

// ---------------------------------------------------------------------
// publicPresetView — what the gallery endpoint serialises.
// ---------------------------------------------------------------------

describe("publicPresetView — gallery serialisation", () => {
  test("every preset round-trips with id, label, protocol, auth, models", () => {
    for (const p of presets.PROVIDER_PRESETS) {
      const v = presets.publicPresetView(p);
      assert.equal(v.id, p.id);
      assert.equal(v.label, p.label);
      assert.equal(v.protocol, p.protocol);
      assert.equal(v.auth.type, p.auth.type);
      assert.equal(v.auth.baseURL, p.auth.baseURL || "");
      assert.equal(v.models.length, p.models.length);
    }
  });

  test("publicPresetView is JSON-clean (no functions, no circular refs)", () => {
    for (const p of presets.PROVIDER_PRESETS) {
      const v = presets.publicPresetView(p);
      const dump = JSON.stringify(v);
      assert.equal(typeof dump, "string");
      assert.ok(dump.length > 0);
    }
  });

  test("opencode-go's auth.type is coding-plan (subscription shape, not BYOK)", () => {
    const p = presets.getPresetById("opencode-go");
    assert.equal(p.auth.type, "coding-plan");
  });

  test("Claude Code uses the anthropic protocol, not openai", () => {
    const p = presets.getPresetById("claude-code");
    assert.equal(p.protocol, "anthropic");
  });
});

// ---------------------------------------------------------------------
// Ticket 06 — DeepSeek preset.
//
// The engine's operator-managed `deepseek-cn` entry is reached via
// the anthropic-messages endpoint; the webui preset exposes the
// public OpenAI-compatible path at api.deepseek.com so a user
// without operator-managed keys can still bring up DeepSeek through
// the dialog. deepseek-reasoner advertises reasoning-effort levels
// so the picker renders the effort toggle.
// ---------------------------------------------------------------------

describe("PROVIDER_PRESETS — DeepSeek (ticket 06)", () => {
  test("deepseek preset uses openai protocol + byok", () => {
    const p = presets.getPresetById("deepseek");
    assert.ok(p, "deepseek preset must be in the catalogue");
    assert.equal(p.protocol, "openai");
    assert.equal(p.auth.type, "byok");
  });

  test("deepseek baseURL is https://api.deepseek.com", () => {
    const p = presets.getPresetById("deepseek");
    assert.equal(p.auth.baseURL, "https://api.deepseek.com");
  });

  test("deepseek carries deepseek-chat + deepseek-reasoner", () => {
    const p = presets.getPresetById("deepseek");
    const ids = p.models.map((m) => m.id).sort();
    assert.deepEqual(ids, ["deepseek-chat", "deepseek-reasoner"]);
  });

  test("deepseek-reasoner advertises thinkingLevels (so picker shows effort toggle)", () => {
    const p = presets.getPresetById("deepseek");
    const reasoner = p.models.find((m) => m.id === "deepseek-reasoner");
    assert.ok(reasoner);
    assert.ok(Array.isArray(reasoner.thinkingLevels));
    assert.ok(reasoner.thinkingLevels.length > 0);
    // Stable subset of levels the engine accepts on its
    // `thinkingEffort` config option.
    assert.ok(reasoner.thinkingLevels.includes("high"));
  });

  test("DeepSeek preset materialises with empty apiKey + preset tag", () => {
    const m = presets.presetToMaterialised("deepseek");
    assert.equal(m.id, "deepseek");
    assert.equal(m.preset, "deepseek");
    assert.equal(m.enabled, true);
    assert.equal(m.auth.apiKey, "");
    assert.equal(m.auth.baseURL, "https://api.deepseek.com");
  });
});
