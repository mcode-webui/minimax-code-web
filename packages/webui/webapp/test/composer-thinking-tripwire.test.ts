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

describe("the thinking trigger's brain + on/off colour", () => {
  const trigger = composerSource.match(
    /data-testid="thinking-effort-trigger"[\s\S]*?\n      <\/button>/,
  );

  test("the trigger renders the brain glyph", () => {
    assert.ok(trigger, "the thinking-effort-trigger button must exist");
    // `name="brain"` on its own would also match a comment; the Icon call
    // is what proves it renders.
    assert.match(trigger[0]!, /<Icon\s+name="brain"/);
  });

  test("the state is read from the product function, not re-derived inline", () => {
    // The decision table itself is unit-tested as behaviour
    // (composer-context-window.test.ts drives isThinkingOn). What only a
    // source pin can prove is that the TRIGGER calls it — a component
    // that inlined `value !== "off"` would colour the engine default blue
    // while every unit test stayed green.
    assert.match(composerSource, /const thinkingOn = isThinkingOn\(levels, value\);/);
  });

  test("blue and grey are accent tokens, not hard-coded hex", () => {
    assert.ok(trigger, "the thinking-effort-trigger button must exist");
    assert.match(trigger[0]!, /text-icon_default_accent/);
    assert.doesNotMatch(trigger[0]!, /#[0-9a-fA-F]{3,6}/);
  });

  test("the trigger is the icon alone — the level word is not repeated", () => {
    // The level is already spelled out in the model chip beside this
    // control ("MiniMax-M3 · 开启"), so a second copy was the same answer
    // in two places and the copy a user had to read to see a state the
    // icon already shows.
    assert.ok(trigger, "the thinking-effort-trigger button must exist");
    // Only the button's BODY counts: `aria-label={t(...)}` is an
    // attribute, and forbidding `t(` across the whole element would ban
    // the accessible name this very change has to add.
    const body = trigger[0]!.slice(trigger[0]!.indexOf(">") + 1);
    assert.equal(
      (body.match(/<Icon/g) ?? []).length,
      2,
      "the button holds exactly the brain and the chevron",
    );
    assert.doesNotMatch(body, /<span/, "no text element in the trigger");
    assert.doesNotMatch(body, /\{\s*t\(/, "no translated string rendered in the trigger");
    assert.doesNotMatch(body, /currentLabel/, "the level word is not rendered here");
  });

  test("an icon-only button still has an accessible name", () => {
    // `Icon` is aria-hidden everywhere else (it sits next to real text),
    // so with the text gone the button announces as an unnamed button
    // unless it names itself. Nothing else in the suite would catch it.
    assert.ok(trigger, "the thinking-effort-trigger button must exist");
    assert.match(trigger[0]!, /aria-label=\{t\("thinkingPicker\.label"\)\}/);
    // The level stays reachable: as the hover title, and as the menu's ✓.
    assert.match(trigger[0]!, /title=\{currentLabel\}/);
  });

  test("the state is exposed to the DOM, so a probe can read it", () => {
    assert.match(
      composerSource,
      /data-thinking=\{thinkingOn === null \? "unknown" : thinkingOn \? "on" : "off"\}/,
    );
  });

  test("the chevron stays tertiary — colour marks state, not the affordance", () => {
    assert.ok(trigger, "the thinking-effort-trigger button must exist");
    const chevron = trigger[0]!.match(
      /name=\{open \? "chevronUp" : "chevronDown"\}[\s\S]*?\/>/,
    );
    assert.ok(chevron, "the chevron must still be there");
    assert.match(chevron[0]!, /text-icon_default_tertiary/);
    assert.doesNotMatch(chevron[0]!, /accent/);
  });
});

describe("the brain glyph is a real, complete drawing", () => {
  const iconsSource = readFileSync(
    resolve(here, "../components/icons.tsx"),
    "utf8",
  );

  test("it is registered, and it draws eight paths", () => {
    const spec = iconsSource.match(/\n  brain: \{[\s\S]*?\n  \},/);
    assert.ok(spec, "brain must exist in the ICONS registry");
    // lucide's brain is 8 paths in its 24×24 frame. A truncated import is
    // a shape nobody recognises, and every path is load-bearing: the
    // hemispheres, the stem, and the five convolutions.
    assert.equal(
      (spec[0]!.match(/<path /g) ?? []).length,
      8,
      "the brain glyph must carry all eight of lucide's paths",
    );
    assert.match(spec[0]!, /viewBox: "0 0 20 20"/);
  });

  test("it is stroked, and its arcs kept lucide's boolean flags", () => {
    // The reason the path data was scaled by script rather than retyped:
    // an arc's large-arc / sweep flags share the number stream with its
    // coordinates. A hand "scale" turns a sweep of 1 into 0.833 and the
    // glyph renders subtly wrong with nothing to catch it.
    const strokeList = iconsSource.match(
      /const STROKE_ICONS = new Set<IconName>\(\[([\s\S]*?)\]\);/,
    );
    assert.ok(strokeList, "STROKE_ICONS must exist");
    assert.match(strokeList[1]!, /"brain"/);

    const spec = iconsSource.match(/\n  brain: \{[\s\S]*?\n  \},/);
    assert.ok(spec);

    const ds = [...spec[0]!.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]!);

    /**
     * An arc is `rx ry x-rotation large-arc sweep x y`, so tokens 2..4 of
     * every group are NOT coordinates — they are a rotation and two
     * booleans. A sweep flag of 0.833 is invalid SVG: Chromium drops the
     * arc instead of drawing it wrong, so the glyph quietly loses a
     * convolution with no error anywhere. Hence a token comparison, not a
     * numeric one.
     */
    const isBool = (token: string | undefined) => token === "0" || token === "1";
    let arcCount = 0;
    for (const d of ds) {
      const arcs = d.match(/[Aa][^A-Za-z]*/g) ?? [];
      for (const arc of arcs) {
        const tokens = arc.slice(1).match(/-?\d*\.?\d+/g) ?? [];
        assert.equal(
          tokens.length % 7,
          0,
          `an arc's number stream is not a whole number of (rx ry rot laf sf x y) groups: ${arc}`,
        );
        for (let i = 0; i < tokens.length; i += 7) {
          arcCount += 1;
          const flags = [tokens[i + 2], tokens[i + 3], tokens[i + 4]];
          const names = ["x-rotation", "large-arc", "sweep"];
          flags.forEach((flag, k) => {
            assert.ok(
              isBool(flag),
              `arc ${names[k]} flag is "${flag}"; it must stay a literal 0 or 1 ` +
                `(a scaled flag silently drops the arc): ${arc.trim()}`,
            );
          });
        }
      }
    }
    assert.ok(
      arcCount >= 5,
      `expected the brain's arcs (two hemispheres plus their convolutions), found ${arcCount}`,
    );
  });
});
