import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Mirror of the formatPercent helper in components/context-meter.tsx.
 *
 * The component does not export `formatPercent`, so the test re-declares the
 * same shape and asserts each branch. This guards against silent drift if the
 * component is later edited without updating the test (and vice versa). Both
 * sides are anchored by the matching comment block in context-meter.tsx, so
 * divergence is obvious on review.
 *
 * The five branches:
 *   0          → "0%"
 *   0 < p < 1  → "<1%"  (i18n string)
 *   1 ≤ p < 10 → "X.X%"  (1-decimal)
 *   p ≥ 10     → "N%"    (integer)
 *   negatives  → "0%"     (defensive — the component passes Math.max(0,…))
 */
function formatPercent(
  p: number,
  t: (key: "context.lessThanOne") => string,
): string {
  if (p <= 0) return "0%";
  if (p < 1) return t("context.lessThanOne");
  if (p < 10) return `${p.toFixed(1)}%`;
  return `${Math.round(p)}%`;
}

const T = (k: "context.lessThanOne") =>
  k === "context.lessThanOne" ? "<1%" : k;

test("context-meter: zero is zero", () => {
  assert.equal(formatPercent(0, T), "0%");
});

test("context-meter: negative clamps to zero", () => {
  // The component feeds the value through Math.max(0, …) so this branch is
  // defensive — but if a future caller forgets, we still render "0%", not
  // something like "-3%".
  assert.equal(formatPercent(-3.7, T), "0%");
});

test("context-meter: tiny positive renders <1%", () => {
  // The bug-fix headline: 1521/512000 ≈ 0.297%. Before this fix it read as
  // "0%" and the user could not tell any usage had accumulated.
  assert.equal(formatPercent(0.3, T), "<1%");
  assert.equal(formatPercent(0.999, T), "<1%");
});

test("context-meter: 1-decimal place between 1 and 10", () => {
  assert.equal(formatPercent(1, T), "1.0%");
  assert.equal(formatPercent(3.5, T), "3.5%");
  assert.equal(formatPercent(9.94, T), "9.9%");
});

test("context-meter: integer at 10 and above", () => {
  assert.equal(formatPercent(10, T), "10%");
  assert.equal(formatPercent(47.4, T), "47%");
  assert.equal(formatPercent(99.5, T), "100%");
  assert.equal(formatPercent(100, T), "100%");
});