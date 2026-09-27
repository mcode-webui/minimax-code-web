// webapp/test/i18n-file-open.test.ts
//
// Unit tests for lib/i18n-file-open.ts — the bilingual strings the
// slice-14 unsupported-state actions rely on.
//
// Coverage contract:
//
//   1. The slice-14 i18n file MUST NOT be orphaned — every key added
//      to en MUST also exist in zh, and vice versa. Missing a locale
//      would ship English text to a Chinese-locale user; the agent team
//      slice shipped such an i18n file with hardcoded English strings
//      and zero consumers, and these tests lock the keys, the resolution,
//      and the locale symmetry so the next contributor cannot silently
//      regress.
//
//   2. `tFileOpen(locale, key, params)` returns the locale-specific
//      string, interpolates `{{name}}` placeholders, falls back to en
//      for unknown locales, and never throws on missing keys.
//
//   3. The visible labels are actually localised — en and zh MUST
//      disagree on every user-facing string. A regression where a key
//      has the same value in both buckets ships "still in English" to
//      the panel.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { tFileOpen, FILE_OPEN_STRINGS, type FileOpenKey } from "../lib/i18n-file-open";

describe("i18n-file-open — bilingual symmetry (no orphan keys)", () => {
  test("every key in en is also in zh", () => {
    const enKeys = Object.keys(FILE_OPEN_STRINGS.en);
    const zhKeys = new Set(Object.keys(FILE_OPEN_STRINGS.zh));
    for (const key of enKeys) {
      assert.ok(zhKeys.has(key), `${key} missing in zh bucket`);
    }
  });

  test("every key in zh is also in en (reverse direction)", () => {
    const zhKeys = Object.keys(FILE_OPEN_STRINGS.zh);
    const enKeys = new Set(Object.keys(FILE_OPEN_STRINGS.en));
    for (const key of zhKeys) {
      assert.ok(enKeys.has(key), `${key} missing in en bucket`);
    }
  });

  test("every localised string is non-empty", () => {
    for (const locale of ["en", "zh"] as const) {
      for (const [key, value] of Object.entries(FILE_OPEN_STRINGS[locale])) {
        assert.ok(
          typeof value === "string" && value.length > 0,
          `${locale}.${key} must be non-empty`,
        );
      }
    }
  });

  test("the user-visible labels are actually localised (en !== zh)", () => {
    const visibleKeys: FileOpenKey[] = [
      "fileOpen.reason.binary",
      "fileOpen.reason.oversize",
      "fileOpen.reason.outOfBounds",
      "fileOpen.reason.unknown",
      "fileOpen.action.openDefault",
      "fileOpen.action.openDefault.aria",
      "fileOpen.action.reveal",
      "fileOpen.action.reveal.aria",
      "fileOpen.failure.openDefault",
      "fileOpen.failure.reveal",
      "fileOpen.button.disabledHint",
      "fileOpen.header.unsupported",
    ];
    for (const key of visibleKeys) {
      assert.notEqual(
        FILE_OPEN_STRINGS.en[key],
        FILE_OPEN_STRINGS.zh[key],
        `${key} must differ between en and zh`,
      );
    }
  });
});

describe("tFileOpen — locale resolution", () => {
  test("resolves to the requested locale", () => {
    assert.equal(
      tFileOpen("zh", "fileOpen.action.openDefault"),
      "用默认应用打开",
    );
    assert.equal(
      tFileOpen("en", "fileOpen.action.openDefault"),
      "Open with default app",
    );
    assert.equal(
      tFileOpen("zh", "fileOpen.action.reveal"),
      "在文件管理器中显示",
    );
    assert.equal(
      tFileOpen("en", "fileOpen.action.reveal"),
      "Show in file manager",
    );
  });

  test("falls back to en for unknown locales (defensive)", () => {
    assert.equal(
      tFileOpen("fr" as unknown as "zh" | "en", "fileOpen.action.openDefault"),
      "Open with default app",
    );
  });

  test("falls back to the raw key when the bucket is missing the entry (debug visibility)", () => {
    assert.equal(
      tFileOpen("zh", "fileOpen.not.a.real.key" as unknown as never),
      "fileOpen.not.a.real.key",
    );
  });
});

describe("tFileOpen — placeholder interpolation", () => {
  test("replaces a {{mime}} placeholder in the binary reason", () => {
    assert.equal(
      tFileOpen("en", "fileOpen.reason.binary", { mime: "application/pdf" }),
      "This file is binary (application/pdf); the preview only renders text.",
    );
    // Chinese full-width characters around "application/pdf" — match
    // the bare token rather than a Latin dot so the locale doesn't
    // matter.
    assert.match(
      tFileOpen("zh", "fileOpen.reason.binary", { mime: "application/pdf" }),
      /application\/pdf/,
    );
  });

  test("replaces a {{error}} placeholder in the unknown reason", () => {
    assert.equal(
      tFileOpen("en", "fileOpen.reason.unknown", { error: "ENOENT" }),
      "Cannot preview this file (ENOENT).",
    );
  });

  test("replaces a {{error}} placeholder in the failure copy", () => {
    assert.equal(
      tFileOpen("zh", "fileOpen.failure.openDefault", { error: "spawn failed" }),
      "打开文件失败：spawn failed",
    );
  });

  test("replaces every occurrence of a placeholder (string is reused)", () => {
    // The failure keys interpolate one placeholder today; the helper
    // uses `replaceAll` so a future key with two `{{error}}` tokens
    // (e.g. a longer sentence that repeats the verb) still
    // substitutes correctly.
    const interpolated = tFileOpen(
      "en",
      "fileOpen.failure.openDefault",
      { error: "boom" },
    );
    assert.equal(interpolated.indexOf("{{error}}"), -1, "no raw placeholder leaked");
    assert.ok(interpolated.includes("boom"));
  });

  test("an absent or null parameter leaves the placeholder empty", () => {
    // Regression guard for the UI's "mime unknown" branch: payload.mime
    // is the empty string, and `tFileOpen` substitutes the empty
    // string rather than leaking the literal `{{mime}}`.
    const interpolated = tFileOpen("en", "fileOpen.reason.binary", {
      mime: null,
    });
    assert.equal(interpolated.indexOf("{{mime}}"), -1, "raw placeholder must be substituted");
    assert.match(interpolated, /\(\)/, "parentheses around the empty mime must remain");
  });
});
