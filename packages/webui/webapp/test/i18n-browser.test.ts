// webapp/test/i18n-browser.test.ts
// Unit tests for lib/i18n-browser.ts — the bilingual strings the
// Built-in Browser panel relies on.
//
// Coverage contract (every line is a documented acceptance fix):
//
//   1. The slice-04 i18n file MUST NOT be orphaned — every key added
//      to en MUST also exist in zh, and vice versa. The agent team
//      slice shipped this same file with hardcoded English strings
//      and zero consumers; these tests lock the keys, the resolution,
//      and the locale symmetry so the next contributor cannot silently
//      regress.
//
//   2. `tBrowser(locale, key)` returns the locale-specific string,
//      falls back to en for unknown locales, and never throws on
//      missing keys.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { tBrowser, BROWSER_STRINGS, type BrowserKey } from "../lib/i18n-browser";

describe("i18n-browser — bilingual symmetry (no orphan keys)", () => {
  test("every key in en is also in zh", () => {
    const enKeys = Object.keys(BROWSER_STRINGS.en);
    const zhKeys = new Set(Object.keys(BROWSER_STRINGS.zh));
    for (const key of enKeys) {
      assert.ok(zhKeys.has(key), `${key} missing in zh bucket`);
    }
  });

  test("every key in zh is also in en (reverse direction)", () => {
    const zhKeys = Object.keys(BROWSER_STRINGS.zh);
    const enKeys = new Set(Object.keys(BROWSER_STRINGS.en));
    for (const key of zhKeys) {
      assert.ok(enKeys.has(key), `${key} missing in en bucket`);
    }
  });

  test("every localised string is non-empty", () => {
    for (const locale of ["en", "zh"] as const) {
      for (const [key, value] of Object.entries(BROWSER_STRINGS[locale])) {
        assert.ok(typeof value === "string" && value.length > 0, `${locale}.${key} must be non-empty`);
      }
    }
  });

  test("the user-visible labels are actually localised (en !== zh)", () => {
    // A regression where someone adds a key in only one locale would
    // ship English text to a Chinese-locale user. The exact text will
    // drift, but the two locales MUST NOT agree on every visible label.
    const visibleKeys: BrowserKey[] = [
      "browser.title",
      "browser.subtitle",
      "browser.addressPlaceholder",
      "browser.go",
      "browser.back",
      "browser.forward",
      "browser.refresh",
      "browser.empty.title",
      "browser.empty.body",
      "browser.error.containment",
      "browser.error.notHtml",
      "browser.error.tooLarge",
      "browser.error.notFile",
      "browser.error.absolute",
      "browser.loading",
    ];
    for (const key of visibleKeys) {
      assert.notEqual(
        BROWSER_STRINGS.en[key],
        BROWSER_STRINGS.zh[key],
        `${key} must differ between en and zh`,
      );
    }
  });
});

describe("tBrowser — locale resolution", () => {
  test("resolves to the requested locale", () => {
    assert.equal(tBrowser("zh", "browser.title"), "内置浏览器");
    assert.equal(tBrowser("en", "browser.title"), "Built-in browser");
    assert.equal(tBrowser("zh", "browser.go"), "转到");
    assert.equal(tBrowser("en", "browser.go"), "Go");
  });

  test("falls back to en for unknown locales (defensive)", () => {
    // The webui only ships zh / en today, but a future locale switcher
    // could pass through an unknown value. Resolve defensively.
    assert.equal(
      tBrowser("fr" as unknown as "zh" | "en", "browser.title"),
      "Built-in browser",
    );
  });

  test("falls back to the raw key when the bucket is missing the entry (debug visibility)", () => {
    // A new key added to en but missed in zh would otherwise render an
    // empty bar in Chinese — show the key name instead, so a regression
    // is loud in the UI rather than silently empty.
    assert.equal(
      tBrowser("zh", "browser.not.a.real.key" as unknown as never),
      "browser.not.a.real.key",
    );
  });
});

describe("i18n-browser — interpolation placeholders survive", () => {
  test("the 'unknown error' key carries the {{error}} placeholder", () => {
    // The component substitutes {{error}} at render time; the lock
    // pins that both locales ship the placeholder so the substitution
    // does not silently produce the raw '{{error}}' string.
    assert.match(BROWSER_STRINGS.en["browser.error.unknown"], /\{\{error\}\}/);
    assert.match(BROWSER_STRINGS.zh["browser.error.unknown"], /\{\{error\}\}/);
  });
});