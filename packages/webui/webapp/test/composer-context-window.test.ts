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

const here = dirname(fileURLToPath(import.meta.url));
const composerSource = readFileSync(
  resolve(here, "../components/composer.tsx"),
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
  test("composer renders a radiogroup with radio roles and per-option testids", () => {
    assert.ok(
      composerSource.includes('data-testid="model-context-group"'),
      "the radio group testid must exist",
    );
    assert.match(
      composerSource,
      /role="radiogroup"/,
      "the group carries role=radiogroup (a11y semantics, not decoration)",
    );
    assert.match(
      composerSource,
      /data-testid=\{`model-context-option-\$\{windowValue\}`\}/,
      "each option carries a per-value testid",
    );
    assert.match(
      composerSource,
      /aria-checked=\{active\}/,
      "options are aria-checked radios",
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
      /if \(options\.length < 2\) return null;/,
      "contextDetail must refuse to mount for fewer than two options",
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

describe("ticket 49 batch 1 — follow-focus detail area wiring tripwires", () => {
  test("the detail container is a polite live region (A6)", () => {
    assert.match(
      composerSource,
      /data-testid="model-context-detail"\s*\n\s*aria-live="polite"/,
      "the detail container must carry aria-live=polite for SR announcements",
    );
  });

  test("the model selector trigger claims dialog semantics (A8)", () => {
    assert.match(
      composerSource,
      /data-testid="model-selector-trigger"\s*\n\s*aria-haspopup="dialog"/,
      "the two-area picker trigger must advertise aria-haspopup=dialog",
    );
  });

  test("hover/keyboard focus on a cascade row feeds the detail area (A2)", () => {
    assert.match(
      composerSource,
      /const \[focusedModelId, setFocusedModelId\] = useState<string \| null>\(null\);/,
      "ModelSelect keeps a focused-row state",
    );
    assert.match(
      composerSource,
      /onItemFocus\?: \(id: string\) => void;/,
      "CascadeSubmenu accepts an optional onItemFocus prop",
    );
    assert.match(
      composerSource,
      /onMouseEnter=\{\(\) => \{ if \(!item\.disabled\) onItemFocus\?\.\(item\.id\); \}\}/,
      "row mouseenter reports the hovered item",
    );
    assert.match(
      composerSource,
      /onFocus=\{\(\) => \{ if \(!item\.disabled\) onItemFocus\?\.\(item\.id\); \}\}/,
      "row focus reports the keyboard-focused item",
    );
    assert.match(
      composerSource,
      /onItemFocus=\{setFocusedModelId\}/,
      "the model cascade hands focus reports to the focused-row state",
    );
  });

  test("previewed (focused ≠ active) radios render disabled, picks stay active-model-only", () => {
    assert.match(
      composerSource,
      /const isDetailPreview = detailTarget != null && detailTarget\.id !== value;/,
      "the preview predicate must compare the detail target to the active id",
    );
    assert.match(
      composerSource,
      /disabled=\{isDetailPreview\}/,
      "context radios are disabled while previewing a non-active model",
    );
    assert.match(
      composerSource,
      /onContextPick\?\.\(windowValue\)/,
      "the active-model pick path is unchanged",
    );
  });

  test("empty states carry testids (A5): no-target and no-adjustable-settings", () => {
    assert.match(composerSource, /data-testid="model-select-detail-empty"/);
    assert.match(composerSource, /data-testid="model-select-detail-no-settings"/);
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
  });

  test("the focused model's thinking levels render as read-only badges in the detail area", () => {
    assert.match(
      composerSource,
      /const detailLevels = detailTarget\?\.thinkingLevels \?\? \[\];/,
      "the detail levels derive from the focused model, not the active one",
    );
    assert.match(
      composerSource,
      /data-testid=\{`model-select-detail-level-\$\{level\}`\}/,
      "each level badge carries a per-level testid",
    );
    assert.match(
      composerSource,
      /!isDetailPreview && detailTarget\.id === value && thinking === level/,
      "a level is highlighted only for the active model with a supported record",
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
    assert.match(composerSource, /model\.provider \?\? "__other"/);
    assert.match(composerSource, /data-testid=\{`model-select-group-label-\$\{group\.id\}`\}/);
    assert.match(composerSource, /sticky top-0 z-10/);
    // B2 ① — the active model row's level badge.
    assert.match(composerSource, /data-testid=\{`model-select-row-level-badge-\$\{modelSlug\(m\.id\)\}`\}/);
    // B2 ③ — the editable control stays outside the picker.
    assert.match(composerSource, /data-testid="thinking-effort-trigger"/);
    // B10 — the untouched U6 testids.
    for (const anchor of [
      'data-testid="model-context-group"',
      "model-context-option-${windowValue}",
      "model-context-value-${windowValue}",
      'data-testid="model-context-hint-higher-usage"',
    ]) {
      assert.ok(composerSource.includes(anchor), `anchor must survive: ${anchor}`);
    }
  });
});
