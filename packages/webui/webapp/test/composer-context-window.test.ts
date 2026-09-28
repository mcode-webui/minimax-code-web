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
 * highlighted).
 */
function contextDetail(
  options: unknown,
  current: number | null | undefined,
): { options: number[]; current: number | null } | null {
  const normalized = normalizeContextWindowOptions(options);
  if (normalized.length < 2) return null;
  return {
    options: normalized,
    current:
      typeof current === "number" && normalized.includes(current) ? current : null,
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
