// webui/test/lib/models.test.js
// Unit tests for server/lib/models.js — getMcodeModelLimit (model context limit)
// and getBuiltinModelsFromMcode (cli.js bundle catalogue extraction).
//
// Why this test exists: getMcodeModelLimit maps a model name to its real
// context limit (extracted from mcode's cli.js bundle). The wrong limit
// means the webui "context used %" bar shows wrong % — users see "0%" or
// "200%" depending on which way it's wrong. The fuzzy-match fallback
// (M2.7-highspeed → M2.7's 200k) is non-obvious and easy to break.
//
// getBuiltinModelsFromMcode reads mcode's own cli.js bundle and the
// sibling chunks/*.js, harvesting MiniMax-M* ids. Tests focus on the
// "missing bundle" path: a fresh install (no dist/cli.js) must return []
// rather than throw, so /api/models can still answer without a built mcode.
//
// Test strategy: NO mock.module. models.js only imports ./config.js.
// getMcodeModelLimit is a pure function on its input string;
// getBuiltinModelsFromMcode reads node:fs through the MCODE_CMD config
// (which resolves to whatever PACKAGE_ROOT/../../dist/cli.js points at
// or, failing that, "mcode" — the test environment has no cli.js so
// the resolver returns null and the extractor returns []).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const absPath = (rel) => pathToFileURL(join(import.meta.dirname, "..", "..", "server", rel)).href;

const models = await import(absPath("lib/models.js"));

describe("getBuiltinModelsFromMcode — cli.js bundle extraction", () => {
  test("returns a MiniMax-M* array (the bundle shape) when dist/cli.js is built, [] otherwise", () => {
    // Two acceptable outcomes:
    //   - dist/cli.js is present (post-`pnpm build`): an array of
    //     MiniMax-M* ids harvested from the bundle + its chunks.
    //   - dist/cli.js is absent (cold test env): [].
    // Both must NOT throw. The route handler relies on the empty-array
    // branch to keep answering /api/models without a built mcode.
    const result = models.getBuiltinModelsFromMcode();
    if (result.length > 0) {
      assert.ok(
        result.every((id) => typeof id === "string" && /^MiniMax-M/.test(id)),
        "every harvested id matches the MiniMax-M* pattern",
      );
    } else {
      assert.deepEqual(result, []);
    }
  });

  test("result is cached — repeated calls return the same array reference", () => {
    // The CACHED_BUILTIN_MODELS latching is load-bearing: per-request
    // callers (routes/model.js#handleGetModels) re-read on every call,
    // but the underlying extraction runs once per process. A fresh
    // install where dist/cli.js appears mid-process would otherwise
    // hit the filesystem on every listModels. We pin the cache by
    // reference identity here.
    const first = models.getBuiltinModelsFromMcode();
    const second = models.getBuiltinModelsFromMcode();
    assert.equal(first, second, "cached reference identity preserved");
  });
});

describe("getMcodeModelLimit — known models (exact match)", () => {
  test("'MiniMax-M3' returns 512000", () => {
    assert.equal(models.getMcodeModelLimit("MiniMax-M3"), 512000);
  });

  test("'MiniMax-M2.7' returns 200000", () => {
    assert.equal(models.getMcodeModelLimit("MiniMax-M2.7"), 200000);
  });

  test("'MiniMax-M2.7-highspeed' returns 200000 (exact match)", () => {
    // The hardcoded MCODE_MODEL_LIMITS table has this entry directly
    assert.equal(models.getMcodeModelLimit("MiniMax-M2.7-highspeed"), 200000);
  });
});

describe("getMcodeModelLimit — fully qualified name (provider/model)", () => {
  test("'minimax_api/MiniMax-M3' strips provider and returns 512000", () => {
    assert.equal(models.getMcodeModelLimit("minimax_api/MiniMax-M3"), 512000);
  });

  test("'someprovider/MiniMax-M2.7' strips any provider", () => {
    assert.equal(models.getMcodeModelLimit("someprovider/MiniMax-M2.7"), 200000);
  });

  test("'minimax_api/MiniMax-M2.7-highspeed' returns 200000", () => {
    assert.equal(
      models.getMcodeModelLimit("minimax_api/MiniMax-M2.7-highspeed"),
      200000,
    );
  });
});

describe("getMcodeModelLimit — empty / null / unknown", () => {
  test("empty string returns 0", () => {
    assert.equal(models.getMcodeModelLimit(""), 0);
  });

  test("null returns 0", () => {
    assert.equal(models.getMcodeModelLimit(null), 0);
  });

  test("undefined returns 0", () => {
    assert.equal(models.getMcodeModelLimit(undefined), 0);
  });

  test("unknown model returns 0", () => {
    assert.equal(models.getMcodeModelLimit("gpt-4-unknown"), 0);
  });
});

describe("getMcodeModelLimit — fuzzy match (suffix variants)", () => {
  test("'MiniMax-M3-turbo' should match 'MiniMax-M3' via prefix fuzzy (M3 startsWith short)", () => {
    // The fuzzy logic iterates keys: if short.startsWith(k) || k.startsWith(short)
    // "MiniMax-M3-turbo".startsWith("MiniMax-M3") → true → 512000
    assert.equal(models.getMcodeModelLimit("MiniMax-M3-turbo"), 512000);
  });

  test("'MiniMax-M2.7-something' matches 'MiniMax-M2.7' via prefix (200k)", () => {
    // short = "MiniMax-M2.7-something", key = "MiniMax-M2.7"
    // short.startsWith(key) → true → 200000
    assert.equal(models.getMcodeModelLimit("MiniMax-M2.7-something"), 200000);
  });

  test("fully-qualified with unknown suffix falls back via prefix match", () => {
    // "minimax_api/MiniMax-M3-experimental" → short = "MiniMax-M3-experimental"
    // short.startsWith("MiniMax-M3") → true → 512000
    assert.equal(
      models.getMcodeModelLimit("minimax_api/MiniMax-M3-experimental"),
      512000,
    );
  });
});
