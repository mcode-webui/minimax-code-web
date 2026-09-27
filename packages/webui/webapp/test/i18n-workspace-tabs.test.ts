// webapp/test/i18n-workspace-tabs.test.ts
//
// Slice 15 string keys are registered in lib/i18n.ts (the central
// dictionary), so the bilingual-coverage tests ride on the central
// translate() function. The slice-15 helper module pins its key
// list here so a future contributor who adds a string must also
// add it to WORKSPACE_TAB_KEYS — a static tripwire that the
// renderer can iterate over without re-typing the keys by hand.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { tWorkspaceTab, WORKSPACE_TAB_KEYS } from "../lib/i18n-workspace-tabs";
import { translate } from "../lib/i18n";

describe("i18n-workspace-tabs — key coverage", () => {
  test("every registered key resolves in BOTH locales", () => {
    for (const key of WORKSPACE_TAB_KEYS) {
      const en = translate("en", key);
      const zh = translate("zh", key);
      assert.notEqual(en, "", `en value for ${key} is empty`);
      assert.notEqual(zh, "", `zh value for ${key} is empty`);
      assert.notEqual(en, key, `en value for ${key} is the raw key — fallback fired`);
      assert.notEqual(zh, key, `zh value for ${key} is the raw key — fallback fired`);
    }
  });
});

describe("tWorkspaceTab — locale resolution", () => {
  test("returns the locale-specific value", () => {
    assert.equal(tWorkspaceTab("en", "workspaceTabs.tab.files"), "Files");
    assert.equal(tWorkspaceTab("zh", "workspaceTabs.tab.files"), "文件");
  });

  test("file-tab close aria carries the file name placeholder", () => {
    // The previous version reused the surface-tab close label
    // and leaked "Close Files tab" on a file tab. The slice-15
    // acceptance flagged that — the file variant now owns its
    // own label and the {name} placeholder is what the renderer
    // substitutes.
    const en = tWorkspaceTab("en", "workspaceTabs.tab.file.aria");
    const zh = tWorkspaceTab("zh", "workspaceTabs.tab.file.aria");
    assert.ok(en.includes("file"));
    assert.ok(zh.includes("文件"));
    assert.ok(en.includes("{name}"));
    assert.ok(zh.includes("{name}"));
  });
});