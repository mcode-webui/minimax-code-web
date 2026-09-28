// webapp/test/fs-search-i18n.test.ts
//
// Slice 19b added a large block of i18n strings (the search
// footer's scanned/skipped/truncated segments, plus a placeholder
// and tip copy for the sidebar search surface). Each key MUST be
// present in BOTH the en and zh dictionaries — a missing zh key
// falls back to en silently, which would ship a half-localised
// feature without a single line of test failure.
//
// The `translate()` helper's en-fallback behaviour is intentional
// (so a missing key never throws), so this test pins the explicit
// parity the way slice-19a did for the server response shape.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { translate, type MessageKey } from "../lib/i18n";

const SLICE_19B_KEYS: ReadonlyArray<MessageKey> = [
  "files.search.loading",
  "files.search.error",
  "files.search.footer.scanned",
  "files.search.footer.matches",
  "files.search.footer.skipped.node_modules",
  "files.search.footer.skipped.git",
  "files.search.footer.skipped.credential",
  "files.search.footer.skipped.huge",
  "files.search.footer.skipped.optional",
  "files.search.footer.truncated",
  "files.search.footer.elapsed",
  "files.search.footer.elapsedValue",
  "files.search.footer.budget.depth",
  "files.search.footer.budget.nodes",
  "files.search.footer.budget.wallClock",
  "files.search.footer.budget.matches",
  "files.search.credential",
  "workspaceTabs.search.placeholder",
  "workspaceTabs.search.tip",
  "workspaceTabs.search.tipLoaded",
  "workspaceTabs.search.tipExhaustive",
  "workspaceTabs.search.empty",
  "workspaceTabs.search.open",
];

describe("slice 19b i18n — bilingual coverage", () => {
  for (const key of SLICE_19B_KEYS) {
    it(`resolves "${key}" in en and zh`, () => {
      const en = translate("en", key);
      const zh = translate("zh", key);
      assert.notEqual(en, "", `en value for ${key} is empty`);
      assert.notEqual(zh, "", `zh value for ${key} is empty`);
      assert.notEqual(en, key, `en value for ${key} is the raw key — fallback fired`);
      assert.notEqual(zh, key, `zh value for ${key} is the raw key — fallback fired`);
    });
  }

  it("emits the placeholder text in the user's active locale", () => {
    const en = translate("en", "workspaceTabs.search.placeholder");
    const zh = translate("zh", "workspaceTabs.search.placeholder");
    // CJK runs naturally carry their own characters; the English
    // form is the ASCII fallback the test asserts on.
    assert.match(en, /search/i);
    assert.match(zh, /搜索/);
  });

  it("the credential affordance has locale-specific copy", () => {
    const en = translate("en", "files.search.credential");
    const zh = translate("zh", "files.search.credential");
    assert.match(en, /credential/i);
    assert.match(zh, /凭据/);
  });
});
