// webapp/test/composer-thinking-tripwire.test.ts
//
// Static-source tripwire for the thinking controls (ticket 36).
//
// What is pinned here is the WIRING, not the decision table. The
// tri-state `isThinkingOn` and the shape predicate `effortControlShape`
// are driven as product functions in composer-context-window.test.ts;
// a unit test cannot see whether the selector CALLS them, so a component
// that inlined `value !== "off"` would colour the engine default blue
// with every unit test still green. The i18n tables are the other thing
// no import can prove — `thinkingPicker.on` has to exist in BOTH
// language buckets or the zh UI renders a raw English glyph.
//
// There are three elements to keep apart — the binary model's brain
// toggle, the depth model's brain indicator, and the level dropdown —
// and telling them apart IS the contract, so each is collected by its
// own data-testid. A single match over `data-testid=` pins whichever
// comes first in the file, which after the split is the toggle.
//
// Same rationale as composer-submit-tripwire.test.ts: a tripwire that
// cannot fail on a plausible revert is decoration. Two guards in this
// file needed a second pass for exactly that reason, and the comments
// at each one say what the first version let through.

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

describe("the thinking controls: the brain says whether, the level says which", () => {
  /**
   * Three elements now, and telling them apart IS the contract:
   *
   * - `thinking-toggle`   — the binary model's brain, a button
   * - `thinking-state`    — the depth-scale model's brain, a plain span
   * - `thinking-effort-trigger` — the level dropdown, word + chevron
   *
   * Each is collected by its own testid so an assertion about one cannot
   * silently pass on another. A single `match` over `data-testid=` would
   * pin whichever comes first in the file, which after this change is the
   * toggle — and the level control's shape would go unchecked.
   */
  const toggle = composerSource.match(
    /data-testid="thinking-toggle"[\s\S]*?\n        <\/button>/,
  )?.[0];
  /**
   * The opening tag is part of the capture, not just the testid: a guard
   * that starts at `data-testid=` cannot see that the element became a
   * `<button>`, because `aria-pressed` and `onClick` are attributes that
   * sit BEFORE the testid. That is how the first version of this guard
   * passed a brain that had quietly become a button.
   */
  const indicator = composerSource.match(
    /<span\b[^>]*data-testid="thinking-state"[\s\S]*?\n        <\/span>/,
  )?.[0];
  const level = composerSource.match(
    /data-testid="thinking-effort-trigger"[\s\S]*?\n          <\/button>/,
  )?.[0];

  test("all three exist and are distinguishable", () => {
    assert.ok(toggle, "the binary model's brain toggle must exist");
    assert.ok(indicator, "the depth model's brain indicator must exist");
    assert.ok(level, "the level dropdown must exist");
    // The depth model's brain must NOT have become a button: a clickable
    // glyph there could only guess which level to pick.
    assert.doesNotMatch(indicator, /aria-pressed|onClick/);
    // And the level control is its own button, not the brain's.
    assert.doesNotMatch(level, /<Icon\s+name="brain"/);
  });

  test("the state is read from the product function, not re-derived inline", () => {
    // The decision table itself is unit-tested as behaviour
    // (composer-context-window.test.ts drives isThinkingOn). What only a
    // source pin can prove is that the TRIGGER calls it — a component
    // that inlined `value !== "off"` would colour the engine default blue
    // while every unit test stayed green.
    assert.match(composerSource, /const thinkingOn = isThinkingOn\(levels, value\);/);
    assert.match(
      composerSource,
      /const reading = thinkingOn === null \? "unknown" : thinkingOn \? "on" : "off";/,
      "the tri-state must be read ONCE and published, not restated per element",
    );
  });

  test("both brains read the same published value", () => {
    // If either element re-derived the colour from `value` directly, the
    // two brains on a depth model could disagree — the one that is a
    // button and the one that is not.
    const readings = composerSource.match(/data-thinking=\{reading\}/g) ?? [];
    assert.equal(readings.length, 2, "the toggle and the indicator both publish `reading`");
    for (const [name, shape] of [
      ["toggle", toggle],
      ["indicator", indicator],
    ] as const) {
      assert.ok(shape, `${name} must exist`);
      assert.match(shape, /data-thinking=\{reading\}/);
    }
  });

  test("blue and grey are accent tokens, not hard-coded hex", () => {
    // One expression feeds both brains, so one assertion covers the pair.
    assert.match(
      composerSource,
      /thinkingOn\s*\?\s*"text-icon_default_accent"\s*:\s*"text-text_default_secondary"/,
    );
    const brainClass = composerSource.match(/const brainClass = [\s\S]*?;/)?.[0];
    assert.ok(brainClass, "the colour expression must be a named binding");
    assert.doesNotMatch(brainClass, /#[0-9a-fA-F]{3,6}/);
  });

  test("the toggle flips, and it has no menu behind it", () => {
    assert.ok(toggle, "the toggle must exist");
    assert.match(toggle, /onClick=\{\(\) => \{\s*onPick\(thinkingOn \? "off" : "on"\);/);
    assert.doesNotMatch(
      toggle,
      /chevron/,
      "a toggle has nothing to disclose — the menu it replaced is the point",
    );
    // Pressed means ON, matching the blue. `null` is not pressed, which is
    // the same grey the icon shows.
    assert.match(toggle, /aria-pressed=\{thinkingOn === true\}/);
  });

  test("the toggle names itself, because an icon-only button must", () => {
    // `Icon` is aria-hidden everywhere else (it sits next to real text),
    // so with the text gone the button announces as an unnamed button
    // unless it names itself. Nothing else in the suite would catch it.
    assert.ok(toggle);
    assert.match(toggle, /aria-label=\{t\("thinkingPicker\.label"\)\}/);
    assert.match(toggle, /title=\{levelLabel\}/);
  });

  test("the level control names the level and offers the menu", () => {
    assert.ok(level, "the level dropdown must exist");
    // The word IS the control's job: 「启用什么等级」 is a position on a
    // scale, and the brain's on/off colour cannot name one.
    //
    // Only the BODY counts. `title={levelLabel}` also contains the token,
    // so a whole-element match would be satisfied by the hover hint alone
    // and the visible word could vanish with every guard still green.
    const body = level.slice(level.indexOf(">") + 1);
    assert.match(body, /\{levelLabel\}/, "the level word is rendered, not only in the title");
    assert.doesNotMatch(level, /aria-pressed/, "it is a menu, not a toggle");
    assert.match(level, /aria-haspopup="menu"/);
    assert.match(level, /title=\{levelLabel\}/);
  });

  test("the level word resolves like its own menu row, not like the old title", () => {
    // The trigger used to label an unrecognised level 「默认」 — which is a
    // DIFFERENT state, and now that the word is visible rather than a
    // hover hint it would be a wrong answer on screen. An unknown level
    // falls through to its raw string, the way its menu row does.
    assert.match(
      composerSource,
      /const levelLabel = value\s*\n\s*\? currentKey\s*\n\s*\? t\(currentKey\)\s*\n\s*: value\s*\n\s*: t\("thinkingPicker\.none"\);/,
    );
  });

  test("the chevron stays tertiary — colour marks state, not the affordance", () => {
    assert.ok(level, "the level dropdown must exist");
    const chevron = level.match(/name=\{open \? "chevronUp" : "chevronDown"\}[\s\S]*?\/>/);
    assert.ok(chevron, "the chevron must still be there");
    assert.match(chevron[0]!, /text-icon_default_tertiary/);
    assert.doesNotMatch(chevron[0]!, /accent/);
  });

  test("only the depth-scale branch renders a level control", () => {
    // The whole point of the split: a two-state model must not grow the
    // menu back. `binary ? null :` is what keeps it gone.
    assert.match(composerSource, /\{binary \? null : \(\s*\n\s*<Dropdown/);
    assert.match(
      composerSource,
      /const binary = effortControlShape\(levels\) === "switch";/,
      "the split must be the one predicate that already exists",
    );
  });
});

describe("the binary model loses the chip's level word", () => {
  test("the 「· 开启」 suffix is suppressed exactly for on/off models", () => {
    // The word and the brain were the same answer in the same toolbar,
    // two controls apart. A depth scale keeps the word: "High" is a
    // position on a scale, and an on/off colour cannot express one.
    assert.match(
      composerSource,
      /const binaryThinking = effortControlShape\(activeModel\?\.thinkingLevels \?\? \[\]\) === "switch";/,
    );
    assert.match(
      composerSource,
      /const suffix = binaryThinking \? "" : chipLevelSuffix\(t, thinking, activeModel\);/,
    );
  });

  test("the binary test reads the SHAPE, not a re-derived off/on pair", () => {
    // If the chip re-checked `levels.length === 2 && includes("off")` its
    // own way, it could disagree with the control's shape and the word
    // would come back for exactly the models that need it gone.
    const binary = composerSource.match(
      /const binaryThinking = [\s\S]*?;\n\s*const suffix = [^;]+;/,
    );
    assert.ok(binary, "the chip's binary decision must be a single expression");
    assert.doesNotMatch(binary[0]!, /includes\("off"\)/);
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
