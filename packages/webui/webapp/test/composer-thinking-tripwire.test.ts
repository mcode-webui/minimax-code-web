// webapp/test/composer-thinking-tripwire.test.ts
//
// Static-source tripwire for the two-state thinking toggle (ticket 36).
//
// Why this exists: switchable builtin MiniMax models (MiniMax-M3)
// carry thinkingLevels ["off","on"] projected from the engine's
// variant schema, and the i18n key must exist in BOTH language buckets
// or the zh UI renders a raw English glyph. The pure-mirror test in
// composer-models.test.ts used to copy the function and so could not
// catch a revert at all; that derivation now lives in
// `webapp/lib/model-groups.ts` and composer.tsx imports it, so the
// unit tests are real coverage. What a static pin still buys over that
// import is the WIRING side: that the extracted function is the one
// the selector actually calls (a dead export would pass a
// unit test), plus the i18n tables, which no import can prove.
// Same rationale as composer-submit-tripwire.test.ts (a tripwire that
// cannot fail on a plausible revert is decoration).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const composerSource = readFileSync(
  resolve(here, "../components/composer.tsx"),
  "utf8",
);
const modelGroupsSource = readFileSync(
  resolve(here, "../lib/model-groups.ts"),
  "utf8",
);
const i18nSource = readFileSync(resolve(here, "../lib/i18n.ts"), "utf8");

describe("two-state thinking toggle — ticket 36 wiring tripwire", () => {
  test("lib/model-groups thinkingLevelKey maps the variant-channel 'on' to its i18n key", () => {
    const idx = modelGroupsSource.indexOf("export function thinkingLevelKey");
    assert.ok(idx >= 0, "thinkingLevelKey present in lib/model-groups.ts");
    const body = modelGroupsSource.slice(idx, idx + 900);
    assert.match(
      body,
      /case "on":\s*\n\s*return "thinkingPicker\.on";/,
      "thinkingLevelKey must map 'on' → thinkingPicker.on (the two-state toggle's on label)",
    );
  });

  test("composer.tsx consumes the extracted level map (a dead export must not pass)", () => {
    assert.match(
      composerSource,
      /import \{[^}]*\bthinkingLevelKey\b[^}]*\} from "@\/lib\/model-groups";/s,
      "composer.tsx must import thinkingLevelKey from lib/model-groups",
    );
    assert.ok(
      !/^function thinkingLevelKey/m.test(composerSource),
      "the level map must not be duplicated back into composer.tsx",
    );
  });

  test("i18n carries thinkingPicker.on in BOTH language buckets", () => {
    // Count occurrences of the key assignment in the file: the en
    // bucket and the zh bucket each declare it once.
    const hits = i18nSource.match(/"thinkingPicker\.on":/g) ?? [];
    assert.equal(
      hits.length,
      2,
      `thinkingPicker.on must appear exactly twice (en + zh); found ${hits.length}`,
    );
    // And the zh bucket's value must not be the English word (a
    // copy-paste "On" in the zh bucket would silently ship).
    const zh = i18nSource.match(/"thinkingPicker\.on": "([^"]+)"/g) ?? [];
    assert.equal(zh.length, 2);
    assert.notEqual(zh[0], zh[1], "en and zh values must differ (hand-written, not copied)");
  });

  test("the stale 'M3 thinkingLevels=[off,low,medium,high]' comment is gone", () => {
    // Ticket 36: that comment contradicted the observed behaviour
    // (builtin models carried NO thinkingLevels at all). It must not
    // come back and mislead the next reader.
    assert.ok(
      !composerSource.includes("thinkingLevels=[off,low,medium,high]"),
      "composer.tsx must not claim M3 has four depth levels",
    );
  });
});
