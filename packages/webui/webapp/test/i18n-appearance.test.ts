// webapp/test/i18n-appearance.test.ts
//
// Slice 18 string keys are registered in lib/i18n.ts (the central
// dictionary), so the bilingual-coverage tests ride on the central
// translate() function. The slice-18 helper module pins its key list
// here so a future contributor who adds a string must also add it to
// APPEARANCE_KEYS — a static tripwire that the renderer can iterate
// over without re-typing the keys by hand.
//
// Both locales ship a complete set. A missing translation silently
// falls back to the en value (or the raw key name), and the panel
// ships Chinese by default, so a missing zh entry ships English text
// to a Chinese-locale user — that's the regression this test pins.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  tAppearance,
  APPEARANCE_KEYS,
  APPEARANCE_STRINGS,
} from "../lib/i18n-appearance";
import { translate } from "../lib/i18n";

describe("i18n-appearance — key coverage", () => {
  test("every registered key resolves in BOTH locales", () => {
    for (const key of APPEARANCE_KEYS) {
      const en = translate("en", key);
      const zh = translate("zh", key);
      assert.notEqual(en, "", `en value for ${key} is empty`);
      assert.notEqual(zh, "", `zh value for ${key} is empty`);
      assert.notEqual(
        en,
        key,
        `en value for ${key} is the raw key — fallback fired`,
      );
      assert.notEqual(
        zh,
        key,
        `zh value for ${key} is the raw key — fallback fired`,
      );
    }
  });

  test("the central dictionary exposes exactly the same keys the helper claims", () => {
    // Defensive: a future edit to lib/i18n.ts could drop a key without
    // updating the helper's APPEARANCE_KEYS list. Pin both directions so
    // the test fails on either side.
    const enKeys = Object.keys(APPEARANCE_STRINGS.en);
    const zhKeys = Object.keys(APPEARANCE_STRINGS.zh);
    assert.deepEqual(
      [...enKeys].sort(),
      [...APPEARANCE_KEYS].sort(),
      "en bucket has unexpected keys",
    );
    assert.deepEqual(
      [...zhKeys].sort(),
      [...APPEARANCE_KEYS].sort(),
      "zh bucket has unexpected keys",
    );
  });
});

describe("tAppearance — locale resolution", () => {
  test("returns the locale-specific value", () => {
    assert.equal(tAppearance("en", "appearance.choice.light"), "Light");
    assert.equal(tAppearance("zh", "appearance.choice.light"), "浅色");
    assert.equal(tAppearance("en", "appearance.choice.dark"), "Dark");
    assert.equal(tAppearance("zh", "appearance.choice.dark"), "深色");
    assert.equal(
      tAppearance("en", "appearance.choice.system"),
      "Follow system",
    );
    assert.equal(tAppearance("zh", "appearance.choice.system"), "跟随系统");
  });

  test("aria variants carry the qualifier phrase", () => {
    // The aria strings are what screen readers announce; they need to
    // include a verb (Light / Dark / Follow) so a screen-reader user
    // can tell which card is which without seeing the visual label.
    for (const key of [
      "appearance.choice.light.aria",
      "appearance.choice.dark.aria",
      "appearance.choice.system.aria",
    ] as const) {
      const en = tAppearance("en", key);
      const zh = tAppearance("zh", key);
      assert.ok(en.length > 8, `en aria for ${key} too short: "${en}"`);
      assert.ok(zh.length > 4, `zh aria for ${key} too short: "${zh}"`);
    }
  });

  test("hint text is non-empty in both locales", () => {
    assert.ok(tAppearance("en", "appearance.hint.fixed").length > 8);
    assert.ok(tAppearance("zh", "appearance.hint.fixed").length > 4);
    assert.ok(tAppearance("en", "appearance.hint.system").length > 8);
    assert.ok(tAppearance("zh", "appearance.hint.system").length > 4);
  });
});
