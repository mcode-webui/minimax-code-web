// webapp/test/composer-context-window.test.ts
//
// U6 — the model selector's context-window detail area (radio group).
//
// Two layers, matching the suite's established style (see
// composer-models.test.ts for the pure-mirror rationale and
// composer-thinking-tripwire.test.ts for the tripwire rationale):
//
//   1. Pure-mirror unit tests for the derivations the detail area
//      renders from — option normalisation, the `>= 2` mount gate,
//      and the compact window label. The copies live next to the test
//      so the decision table reads as a table.
//   2. Static-source tripwires for the wiring the mirrors cannot see:
//      the radio group in composer.tsx (role/aria/testids, the pick
//      handler, the stale-pick clear on model switch), the api.ts
//      contract field, and the i18n keys in BOTH language buckets.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
// P3 (acceptance): the A3 decisions are tested through the PRODUCT
// functions imported from lib/effort-control — the module
// composer.tsx itself imports. An earlier revision kept mirrors here,
// and acceptance probes showed a broken product function still passed
// green, so the table had drifted off the code it claimed to pin.
import {
  effortControlShape,
  effortOptionsWithDefault,
  resolveEffortCurrent as effortCurrent,
} from "../lib/effort-control";

const here = dirname(fileURLToPath(import.meta.url));
const composerSource = readFileSync(
  resolve(here, "../components/composer.tsx"),
  "utf8",
);
// The provider grouping and the thinking-level derivations moved out of
// composer.tsx into `lib/model-groups.ts` (same code, named inputs) so
// the unit tests could drive the product functions instead of a copy.
// The tripwires below follow the code: they pin the derivation where it
// now lives AND pin that composer.tsx actually imports it, so a
// half-done extraction cannot pass.
const modelGroupsSource = readFileSync(
  resolve(here, "../lib/model-groups.ts"),
  "utf8",
);
const i18nSource = readFileSync(resolve(here, "../lib/i18n.ts"), "utf8");
const apiSource = readFileSync(resolve(here, "../lib/api.ts"), "utf8");

/** Mirror of composer.tsx normalizeContextWindowOptions. */
function normalizeContextWindowOptions(options: unknown): number[] {
  if (!Array.isArray(options)) return [];
  return [...new Set(options.filter((v) => Number.isSafeInteger(v) && v > 0))];
}

/** Mirror of composer.tsx formatContextWindow. */
function formatContextWindow(value: number): string {
  if (value >= 1_000_000) return `${value / 1_000_000}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

/**
 * Mirror of the detail-area mount decision (composer.tsx
 * `contextDetail`): normalised options, `>= 2` distinct entries, and
 * the stale-pick rule (a current value outside the options is not
 * highlighted). Ticket 49 adds the follow-focus dimension: when the
 * detail area describes a model that is NOT the active one
 * (`interactive === false`, the hover preview), no recorded pick is
 * highlighted either — the record belongs to the active model.
 */
function contextDetail(
  options: unknown,
  current: number | null | undefined,
  interactive = true,
): { options: number[]; current: number | null } | null {
  const normalized = normalizeContextWindowOptions(options);
  if (normalized.length < 2) return null;
  return {
    options: normalized,
    current:
      interactive && typeof current === "number" && normalized.includes(current)
        ? current
        : null,
  };
}

describe("normalizeContextWindowOptions — payload hygiene", () => {
  test("dedupes, keeps engine order, drops unsafe entries", () => {
    assert.deepEqual(
      normalizeContextWindowOptions([512000, 1000000]),
      [512000, 1000000],
    );
    assert.deepEqual(
      normalizeContextWindowOptions([128000, 128000, 0, -1, 1.5, "64000"]),
      [128000],
    );
  });

  test("undefined / wrong shapes collapse to []", () => {
    assert.deepEqual(normalizeContextWindowOptions(undefined), []);
    assert.deepEqual(normalizeContextWindowOptions(null), []);
    assert.deepEqual(normalizeContextWindowOptions("512000"), []);
    assert.deepEqual(normalizeContextWindowOptions({ a: 1 }), []);
  });
});

describe("formatContextWindow — compact labels", () => {
  test("the engine catalogue's values land on clean labels", () => {
    assert.equal(formatContextWindow(1000000), "1M");
    assert.equal(formatContextWindow(512000), "512K");
    assert.equal(formatContextWindow(128000), "128K");
    assert.equal(formatContextWindow(200000), "200K");
    assert.equal(formatContextWindow(8000), "8K");
    assert.equal(formatContextWindow(999), "999");
  });
});

describe("contextDetail — render-branch decision table", () => {
  test("model with >= 2 options mounts the control; current inside options is highlighted", () => {
    const detail = contextDetail([512000, 1000000], 512000);
    assert.ok(detail, "M3-shaped model mounts the control");
    assert.deepEqual(detail.options, [512000, 1000000]);
    assert.equal(detail.current, 512000);
  });

  test("recorded current outside the options is NOT highlighted (stale pick)", () => {
    const detail = contextDetail([512000, 1000000], 128000);
    assert.ok(detail);
    assert.equal(detail.current, null);
  });

  test("models without usable options mount NO control (acceptance: no blank block)", () => {
    assert.equal(contextDetail(undefined, null), null, "field absent");
    assert.equal(contextDetail([], null), null, "empty list");
    assert.equal(contextDetail([512000], 512000), null, "a single option is a no-op choice");
  });

  test("null current renders the control with nothing highlighted", () => {
    const detail = contextDetail([512000, 1000000], null);
    assert.ok(detail);
    assert.equal(detail.current, null);
  });

  test("ticket 49 preview (focused ≠ active): options show, nothing highlighted", () => {
    // The recorded 512000 belongs to the ACTIVE model; the previewed
    // model's radio group renders its own options with no highlight.
    const detail = contextDetail([512000, 1000000], 512000, false);
    assert.ok(detail, "preview mounts the control for its options");
    assert.deepEqual(detail.options, [512000, 1000000]);
    assert.equal(detail.current, null, "a preview never claims the active record");
  });
});

describe("U6 wiring tripwires — composer.tsx / api.ts / i18n.ts", () => {
  test("composer renders the context window as a single-select listbox", () => {
    // The reference draws the context window as ONE control: the current
    // value with a chevron, opening to the option rows — not two window
    // buttons permanently side by side. The testids derive from the
    // placement prefix, and the picker has exactly one placement now.
    assert.match(
      composerSource,
      /testIdPrefix=\{contextPrefix\}/,
      "the select is handed the placement prefix",
    );
    assert.match(
      composerSource,
      /data-testid=\{`\$\{testIdPrefix\}-select`\}/,
      "the select wrapper testid derives from the placement prefix",
    );
    assert.match(
      composerSource,
      /contextPrefix="model-panel-context"/,
      "the settings column keeps its own prefix",
    );
    assert.match(
      composerSource,
      /role="listbox"/,
      "the option list carries role=listbox",
    );
    assert.match(
      composerSource,
      /data-testid=\{`\$\{testIdPrefix\}-option-\$\{windowValue\}`\}/,
      "each option carries a per-value testid",
    );
    assert.match(
      composerSource,
      /aria-selected=\{active\}/,
      "options are aria-selected listbox options",
    );
  });

  test("the radio pick rides the onContextPick → api.setModel chain", () => {
    assert.match(
      composerSource,
      /onContextPick\?\.\(windowValue\)/,
      "option click hands the value up to the parent handler",
    );
    assert.match(
      composerSource,
      /contextWindow: windowValue/,
      "the parent handler sends contextWindow through /api/set-model",
    );
  });

  test("model switch clears a recorded window the new model does not advertise", () => {
    assert.match(
      composerSource,
      /contextWindow: null/,
      "the documented null sentinel must be wired in the onPick cascade",
    );
    assert.match(
      composerSource,
      /normalizeContextWindowOptions\(\s*newModel\?\.contextWindowOptions,\s*\)\.includes\(recordedWindow\)/,
      "the stale check must normalise the new model's options first",
    );
  });

  test("the mount gate is >= 2 normalised options, mirroring the engine's own picker", () => {
    assert.match(
      composerSource,
      /const contextReady = contextOptions\.length >= 2;/,
      "the detail area must refuse to mount for fewer than two options",
    );
  });

  test("api.ts setModel carries the contextWindow field (number | null)", () => {
    assert.match(
      apiSource,
      /contextWindow\?: number \| null/,
      "the wire contract must declare the field",
    );
  });

  test("i18n carries both keys in BOTH language buckets with distinct values", () => {
    for (const key of [
      "modelSelector.contextWindow",
      "modelSelector.contextWindowHigherUsage",
    ]) {
      const hits = i18nSource.match(new RegExp(`"${key}":`, "g")) ?? [];
      assert.equal(
        hits.length,
        2,
        `${key} must appear exactly twice (en + zh); found ${hits.length}`,
      );
    }
    const zh = i18nSource.match(/"modelSelector\.contextWindow": "([^"]+)"/g) ?? [];
    assert.equal(zh.length, 2);
    assert.notEqual(zh[0], zh[1], "en and zh values must differ (hand-written, not copied)");
  });
});

describe("ticket 49 batch 2 (A3) — effort control shape decision table (product functions)", () => {
  test("binary off/on levels render a switch, everything else a radio group", () => {
    assert.equal(effortControlShape([]), null, "no levels → no control");
    assert.equal(effortControlShape(["off", "on"]), "switch");
    assert.equal(effortControlShape(["on", "off"]), "switch", "order-independent");
    assert.equal(effortControlShape(["off", "low", "high"]), "radiogroup", "off + depth is a scale");
    assert.equal(effortControlShape(["low", "medium", "high"]), "radiogroup");
    assert.equal(effortControlShape(["on", "low"]), "radiogroup", "not the off/on pair");
  });

  test("the radio group always offers default first (engine-default reset)", () => {
    assert.deepEqual(effortOptionsWithDefault(["low", "high"]), ["default", "low", "high"]);
    // Defensive: a catalogue that ever ships a literal "default" level
    // must not produce a duplicate radio.
    assert.deepEqual(effortOptionsWithDefault(["default", "low"]), ["default", "low"]);
  });

  test("current highlight: preview none, empty→default, stale none (product resolveEffortCurrent)", () => {
    assert.equal(effortCurrent(["low", "high"], "", false), "default");
    assert.equal(effortCurrent(["low", "high"], "high", false), "high");
    assert.equal(effortCurrent(["low", "high"], "xhigh", false), null, "stale record highlights nothing");
    assert.equal(effortCurrent(["low", "high"], "high", true), null, "preview highlights nothing");
    // The switch form's checked state derives from the same decision —
    // pin the regression where the stale check read the radio-group's
    // option list (empty for the switch) and "on" read as off.
    assert.equal(effortCurrent(["off", "on"], "on", false), "on", "recorded on reads as on (switch form)");
    assert.equal(effortCurrent(["off", "on"], "", false), "default", "engine default reads as off position");
  });
});

describe("ticket 49 batch 1 — follow-focus wiring survives batch 2 (kept tripwires)", () => {
  test("the detail containers are polite live regions (A6, both placements)", () => {
    assert.match(
      composerSource,
      /<div data-testid=\{containerTestId\} aria-live="polite" className=\{className\}>/,
      "ModelSettingsDetail renders the live region",
    );
    assert.match(
      composerSource,
      /containerTestId="model-panel-detail"/,
      "the settings column carries the container testid",
    );
  });

  test("the model selector trigger claims dialog semantics (A8)", () => {
    assert.match(
      composerSource,
      /data-testid="model-selector-trigger"\s*\n\s*aria-haspopup="dialog"/,
      "the two-area picker trigger must advertise aria-haspopup=dialog",
    );
  });

  test("hover/keyboard focus on a model row feeds the settings column (A2)", () => {
    // The report used to come from the cascade's `onItemFocus`. With the
    // models IN the list, the row itself reports: the list is one level
    // shallower, and a follow-focus column that only tracked a fly-out
    // would freeze.
    assert.match(
      composerSource,
      /const \[focusedModelId, setFocusedModelId\] = useState<string \| null>\(null\);/,
      "ModelSelect keeps a focused-row state",
    );
    assert.match(
      composerSource,
      /onMouseEnter\?: \(\) => void;/,
      "SelectRow accepts an optional onMouseEnter prop",
    );
    assert.match(
      composerSource,
      /onFocus\?: \(\) => void;/,
      "SelectRow accepts an optional onFocus prop",
    );
    assert.match(
      composerSource,
      /onMouseEnter=\{\(\) => \{\s*if \(!disabled\) setFocusedModelId\(model\.id\);/,
      "row mouseenter reports the hovered model",
    );
    assert.match(
      composerSource,
      /onFocus=\{\(\) => \{\s*if \(!disabled\) setFocusedModelId\(model\.id\);/,
      "row focus reports the keyboard-focused model",
    );
    assert.match(
      composerSource,
      /const isDetailPreview = detailTarget != null && detailTarget\.id !== value;/,
      "the preview predicate must compare the detail target to the active id",
    );
    assert.match(
      composerSource,
      /target=\{detailTarget\}\s*\n\s+preview=\{isDetailPreview\}/,
      "the settings column describes the follow-focus target",
    );
  });

  test("previewed (focused ≠ active) controls render disabled; picks stay active-model-only", () => {
    assert.match(
      composerSource,
      /disabled=\{preview\}/,
      "the shared detail's radios disable while previewing a non-active model",
    );
    assert.match(
      composerSource,
      /disabled=\{preview \|\| thinkingDisabled\}/,
      "the adaptive effort control disables on preview AND while running",
    );
    assert.match(
      composerSource,
      /if \(value == null\) return;/,
      "the pick handlers guard on an active model existing",
    );
  });

  test("empty states carry per-placement testids (A5); no-settings names the model (QA ②)", () => {
    assert.match(
      composerSource,
      /data-testid=\{`\$\{detailPrefix\}-empty`\}/,
      "the no-target hint derives its testid from the placement prefix",
    );
    assert.match(
      composerSource,
      /data-testid=\{`\$\{detailPrefix\}-no-settings`\}/,
      "the per-model hint derives its testid from the placement prefix",
    );
    assert.match(
      composerSource,
      /t\("modelSelector\.detailEmpty"\)/,
      "the no-target hint reads its copy from i18n",
    );
    assert.match(
      composerSource,
      /t\("modelSelector\.detailNoSettings"\)/,
      "the per-model hint reads its copy from i18n",
    );
    // QA item ②: the no-settings branch renders the model NAME next to
    // the hint — inside an aria-live region the bare sentence leaves a
    // screen-reader user without the context of WHICH model.
    assert.match(
      composerSource,
      /\{modelDisplayName\(target\.label\) \|\| target\.id\}\s*\n\s*<\/div>\s*\n\s*<div className="text-caption-small text-text_default_tertiary">\s*\n\s*\{t\("modelSelector\.detailNoSettings"\)\}/,
      "the no-settings branch renders the model name above the hint",
    );
  });

  test("one level control, and it highlights only a recorded level (no badge twin)", () => {
    // The picker used to render the active model's levels TWICE — an
    // editable adaptive control in the column and a read-only badge row
    // in a panel-bottom area. One settings surface means one level
    // control; two renderings of the same fact is not a feature, and a
    // badge that says "high" next to a list that says "low" is a lie
    // nobody has to author to ship.
    assert.doesNotMatch(
      composerSource,
      /effortControl=/,
      "the read-only badge variant is gone with its only caller",
    );
    const mounts = composerSource.match(/<ModelSettingsDetail/g) ?? [];
    assert.equal(mounts.length, 1, "exactly one settings surface");
    assert.match(
      composerSource,
      /data-testid=\{`\$\{detailPrefix\}-level-list`\}/,
      "the levels render as the reference's vertical list of rows",
    );
    assert.match(
      composerSource,
      /const effortCurrent = resolveEffortCurrent\(levels, thinking, preview\);/,
      "the highlight still comes from the preview-aware product function",
    );
  });

  test("i18n carries the four ticket-49 keys in BOTH language buckets", () => {
    for (const key of [
      "modelSelector.detailEmpty",
      "modelSelector.detailNoSettings",
      "modelSelector.detailPreview",
      "modelSelector.detailPreviewHint",
    ]) {
      const hits = i18nSource.match(new RegExp(`"${key}":`, "g")) ?? [];
      assert.equal(
        hits.length,
        2,
        `${key} must appear exactly twice (en + zh); found ${hits.length}`,
      );
    }
  });

  test("red lines intact: provider grouping and all three thinking displays survive", () => {
    // B1 — provider grouping with sticky headers and the Other bucket.
    // The bucketing now lives in lib/model-groups.ts; assert the
    // `__other` bucket is still the anchor there AND that the selector
    // renders it from that function (a dead export would pass the
    // first half alone).
    assert.match(modelGroupsSource, /OTHER_PROVIDER_ID = "__other"/);
    assert.match(
      modelGroupsSource,
      /const key = model\.provider \?\? OTHER_PROVIDER_ID;/,
      "the grouping key is still `provider` with the `__other` fallback",
    );
    assert.match(
      composerSource,
      /groupModelsByProvider\(models, groups, t\("modelSelector\.other"\)\)/,
      "composer.tsx must build `grouped` through the product grouping function",
    );
    assert.match(composerSource, /data-testid=\{`model-select-group-label-\$\{group\.id\}`\}/);
    assert.match(composerSource, /sticky top-0 z-10/);
    // B2 ① — the active model row's level badge.
    assert.match(
      composerSource,
      /data-testid=\{`model-select-row-level-badge-\$\{modelSlug\(model\.id\)\}`\}/,
    );
    // B2 ③ — the editable composer-level control stays outside the picker.
    assert.match(composerSource, /data-testid="thinking-effort-trigger"/);
    // B10 — the U6 testids survive through the prefix family.
    for (const anchor of [
      'contextPrefix="model-panel-context"',
      '${testIdPrefix}-select',
      '${testIdPrefix}-option-${windowValue}',
      '${testIdPrefix}-select-value',
      '${testIdPrefix}-hint-higher-usage',
    ]) {
      assert.ok(composerSource.includes(anchor), `anchor must survive: ${anchor}`);
    }
  });
});

describe("ticket 49 batch 2 (A1) — two-column fly-out wiring", () => {
  test("one flat list beside one settings column — no fly-out, no bottom twin", () => {
    // The picker used to be three surfaces: a provider row that opened a
    // positioned fly-out of models, a follow-focus column inside that
    // fly-out, and a panel-bottom area describing the active model. The
    // reference has one list and one settings column, so the fly-out and
    // the bottom area are gone — and with them the clamping and scrolling
    // they needed, because two columns inside ONE popup cannot occlude
    // each other. The two-column container is the whole layout now.
    assert.doesNotMatch(composerSource, /CascadeSubmenu/, "no fly-out remains");
    assert.doesNotMatch(composerSource, /<CascadeSubmenu/);
    assert.doesNotMatch(
      composerSource,
      /maxHeight: "calc\(100vh - 16px\)"/,
      "the fly-out's viewport clamp left with it",
    );
    assert.match(
      composerSource,
      /data-testid="model-select-panel-detail-column"/,
      "the settings column is part of the panel, not a fly-out",
    );
    assert.match(
      composerSource,
      /className="thin-scrollbar max-h-\[60vh\] w-64 shrink-0 self-stretch overflow-y-auto border-l border-border_default py-1 pl-1"/,
      "the settings column owns its own vertical scroll",
    );
    assert.match(
      composerSource,
      /className="thin-scrollbar max-h-\[60vh\] w-60 overflow-y-auto"/,
      "the list owns its own vertical scroll",
    );
    assert.match(
      composerSource,
      /onKeyDown=\{handleListKeyDown\}/,
      "the list carries the arrow-key engine the fly-out used to own",
    );
  });

  test("A3 adaptive control: switch for off/on, radio group with default otherwise", () => {
    assert.match(
      composerSource,
      /role="switch"/,
      "the binary form renders a switch",
    );
    assert.match(
      composerSource,
      /aria-checked=\{effortCurrent === "on"\}/,
      "the switch is checked exactly for the recorded on state",
    );
    assert.match(
      composerSource,
      /onThinkingPick\?\.\(effortCurrent === "on" \? "off" : "on"\)/,
      "the switch toggles the recorded level",
    );
    assert.match(
      composerSource,
      /data-testid=\{`\$\{detailPrefix\}-level-list`\}/,
      "the multi-level form renders the reference's vertical level list",
    );
    assert.match(
      composerSource,
      /onThinkingPick\?\.\(option === "default" \? "" : option\);/,
      "the default option submits the empty string (engine default stands)",
    );
    assert.match(
      composerSource,
      /option === "default"\s*\n?\s*\?\s*t\("thinkingPicker\.none"\)\s*\n?\s*:\s*thinkingLevelLabel\(t, option\)/,
      "the default option reuses the composer control's label",
    );
  });

  test("A3 wiring: the side column's pick rides the unchanged wire path", () => {
    assert.match(
      composerSource,
      /onThinkingPick\?: \(level: string\) => void;/,
      "ModelSelect accepts the level pick",
    );
    assert.match(
      composerSource,
      /void api\.setModel\(\{ thinking: level \}\);/,
      "the parent sends {thinking} — the SAME payload the composer-level control sends",
    );
    // Picks never close the menu: the pick handlers must not touch `open`.
    const handlerBlock = composerSource.match(
      /const handleDetailThinkingPick = useCallback\([\s\S]*?\[value, onThinkingPick\],/,
    );
    assert.ok(handlerBlock, "the thinking pick handler must exist");
    assert.ok(
      !handlerBlock[0].includes("setOpen(false)"),
      "a setting pick must not close the menu (A4)",
    );
  });
});

describe("ticket 49 batch 2 (A7) — draft mirror wiring", () => {
  test("drafts live in a useState map keyed by model id, cleared on close", () => {
    assert.match(
      composerSource,
      /const \[drafts, setDrafts\] = useState<\s*Record<string, \{ thinking\?: string; contextWindow\?: number \}>\s*>\(\{\}\);/,
      "the mirror is a useState map",
    );
    assert.match(
      composerSource,
      /useEffect\(\(\) => \{\s*\n\s*if \(!open\) setDrafts\(\{\}\);\s*\n\s*\}, \[open\]\);/,
      "closing the picker drops the mirror",
    );
  });

  test("the highlighted values read the mirror first (refresh-proof)", () => {
    assert.match(
      composerSource,
      /const activeThinking = activeDraft\?\.thinking \?\? thinking;/,
      "the level highlight prefers the draft",
    );
    assert.match(
      composerSource,
      /const activeContextWindow =\s*\n\s*activeDraft\?\.contextWindow !== undefined \? activeDraft\.contextWindow : contextWindow;/,
      "the window highlight prefers the draft (null vs undefined kept distinct)",
    );
    assert.match(
      composerSource,
      /setDrafts\(\(prev\) => \(\{ \.\.\.prev, \[value\]: \{ \.\.\.prev\[value\], thinking: level \} \}\)\);/,
      "a level pick records its draft before the wire round-trip",
    );
    assert.match(
      composerSource,
      /setDrafts\(\(prev\) => \(\{\s*\n\s*\.\.\.prev,\s*\n\s*\[value\]: \{ \.\.\.prev\[value\], contextWindow: windowValue \},\s*\n\s*\}\)\);/,
      "a window pick records its draft before the wire round-trip",
    );
  });
});

describe("ticket 49 batch 2 — QA registry pins", () => {
  test("QA ① — every focusedModelId cleanup path stays wired (delete any one and this goes red)", () => {
    // Six cleanup sites existed at batch-2 time, all but one belonging to
    // the cascade's hover grace, the cascade's back path, and the
    // cross-provider hover. With the models in the list there is no
    // fly-out to leave, so the remaining three are the whole set: a
    // stale preview surviving a pick, a session switch, or the panel
    // closing would leave the settings column describing a model the
    // user is no longer looking at.
    const pins: [name: string, re: RegExp][] = [
      [
        "active model change effect",
        /useEffect\(\(\) => \{\s*\n\s*setFocusedModelId\(null\);\s*\n\s*\}, \[value\]\);/,
      ],
      [
        "session switch",
        /setFocusedModelId\(null\);\s*\n\s*setDrafts\(\{\}\);/,
      ],
      [
        "dropdown close",
        /if \(!next\) setFocusedModelId\(null\);/,
      ],
      [
        "model pick",
        /setOpen\(false\);\s*\n\s*setFocusedModelId\(null\);/,
      ],
    ];
    for (const [name, re] of pins) {
      assert.match(composerSource, re, `cleanup path must survive: ${name}`);
    }
  });

  test("QA ④ — arrow keys on the closed trigger open the panel and move focus in", () => {
    assert.match(
      composerSource,
      /event\.key !== "ArrowDown" &&\s*\n\s*event\.key !== "ArrowUp" &&\s*\n\s*event\.key !== "ArrowRight"/,
      "the trigger handles ArrowDown/ArrowUp/ArrowRight",
    );
    assert.match(
      composerSource,
      /if \(!open\) setOpen\(true\);/,
      "a closed picker opens on the arrow key",
    );
    assert.match(
      composerSource,
      /\(event\.key === "ArrowUp" \? rows\[rows\.length - 1\]! : rows\[0\]!\)\.focus\(\);/,
      "ArrowDown/Right focus the first row; ArrowUp the last",
    );
    assert.match(
      composerSource,
      /'\[data-testid\^="model-select-model-option-"\]:not\(\[disabled\]\)'/,
      "focus lands on a MODEL row and skips a no-key provider's disabled ones",
    );
    // The list carries the between-rows engine the fly-out used to own:
    // without it, removing the cascade would quietly remove
    // keyboard-only reachability with it. Home/End matter more now, not
    // less — a flat list of every model is longer than one provider's
    // cascade ever was.
    assert.match(
      composerSource,
      /event\.key === "ArrowDown" \? 1 : event\.key === "ArrowUp" \? -1 : 0;/,
      "the list engine moves by row",
    );
    assert.match(
      composerSource,
      /event\.key === "Home" \? "first" : event\.key === "End" \? "last" : null/,
      "Home/End still jump to the ends of a long catalogue",
    );
  });
});
