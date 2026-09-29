// webapp/test/i18n-settings-parity.test.ts
//
// Bilingual-coverage pins for the settings-page parity rework (ticket 37).
//
// The i18n dictionary is typed (MessageKey = keyof typeof en), so a key
// referenced by a component but missing from the dictionary is a
// compile error — but nothing forces a NEW key to exist in the first
// place, and nothing at all notices a key whose zh entry was never
// added (translate falls back to en, so an English string ships to a
// Chinese-locale user). Same pattern as i18n-appearance.test.ts: pin
// both locales' values through translate().
//
// What this file pins beyond mere presence:
//   - settings.tab.usageModels is exactly 「用量与模型」 in zh — that
//     name is the desktop reference's, and the nav is the user-visible
//     contract of decision #3 (usage lives in the settings page).
//   - the usagePopover.* keys are GONE from both dictionaries. The
//     hover flyout was deleted along with its surface; leaving the
//     strings behind would be a ghost vocabulary for a widget that no
//     longer exists. translate() returns undefined for a key missing
//     from en, which is the observable form of "deleted".
//   - settings.appearance and toolbar.usage survive — the appearance
//     row label inside 通用 and the user-menu row label both still
//     read them.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { translate, type MessageKey } from "../lib/i18n";

const NEW_KEYS = [
  "settings.appearanceHint",
  "settings.languageHint",
  "settings.tab.usageModels",
  "usage.title",
  "usage.fiveHour",
  "usage.weekly",
  "usage.refresh",
  "usage.unavailable",
  "usage.errorTitle",
  "usage.errorBody",
  // Ticket 48 — General-page section titles, localStorage-backed row
  // labels/hints, the back label, and the search-clear aria label.
  "settings.clearSearch",
  "settings.section.application",
  "settings.section.file",
  "settings.section.sessionManagement",
  "settings.section.preference",
  "settings.file.openInNewTab",
  "settings.file.openInNewTabHint",
  "settings.file.lineWrap",
  "settings.file.lineWrapHint",
  "settings.session.contextWindowUsage",
  "settings.followUp.title",
  "settings.followUp.hint",
  "settings.followUp.queue",
  "settings.followUp.steer",
] as const;

const RETIRED_POPOVER_KEYS = [
  "usagePopover.title",
  "usagePopover.fiveHour",
  "usagePopover.weekly",
  "usagePopover.refresh",
  "usagePopover.unavailable",
  "usagePopover.errorTitle",
  "usagePopover.errorBody",
] as const;

describe("i18n settings parity (ticket 37)", () => {
  test("every new settings key resolves in BOTH locales", () => {
    for (const key of NEW_KEYS) {
      const messageKey = key as MessageKey;
      const en = translate("en", messageKey);
      const zh = translate("zh", messageKey);
      assert.notEqual(en, "", `en value for ${key} is empty`);
      assert.notEqual(zh, "", `zh value for ${key} is empty`);
      assert.notEqual(en, key, `en value for ${key} is the raw key — fallback fired`);
      assert.notEqual(zh, key, `zh value for ${key} is the raw key — fallback fired`);
      assert.notEqual(zh, undefined, `zh value for ${key} is missing entirely`);
    }
  });

  test("the usage-and-models tab keeps the desktop reference's Chinese name", () => {
    assert.equal(translate("zh", "settings.tab.usageModels" as MessageKey), "用量与模型");
  });

  test("ticket 48: the back label is the reference's Back to app, in both locales", () => {
    assert.equal(translate("zh", "settings.back" as MessageKey), "返回应用");
    assert.equal(translate("en", "settings.back" as MessageKey), "Back to app");
  });

  test("the retired usagePopover.* vocabulary is gone from the dictionary", () => {
    for (const key of RETIRED_POPOVER_KEYS) {
      const en = translate("en", key as unknown as MessageKey);
      const zh = translate("zh", key as unknown as MessageKey);
      assert.equal(en, undefined, `${key} must be removed from the en dictionary`);
      assert.equal(zh, undefined, `${key} must be removed from the zh dictionary`);
    }
  });

  test("surviving keys: the appearance row label and the menu usage label", () => {
    for (const key of ["settings.appearance", "toolbar.usage"] as const) {
      const messageKey = key as MessageKey;
      assert.notEqual(translate("en", messageKey), undefined, `${key} missing from en`);
      assert.notEqual(translate("zh", messageKey), undefined, `${key} missing from zh`);
      assert.notEqual(translate("zh", messageKey), "", `${key} empty in zh`);
    }
  });
});
