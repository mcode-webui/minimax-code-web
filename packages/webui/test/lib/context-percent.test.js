// webui/test/lib/context-percent.test.js
// Unit tests for the context-percent rounding helper
// (computeContextPercent in server/lib/context-percent.js).
//
// The helper rounds to 1 decimal place (with a `<1%` display fallback
// in the client), so 1521/512000 → 0.3 instead of 0. These tests pin:
//   - exact 1-decimal rounding for the headline case (1521/512000 → 0.3)
//   - the boundary 0/0.05/1/9.95/10 to catch off-by-one drift
//   - defensive guards: limit<=0, negative used, NaN
//   - clamping at 100% so 110%-of-USE-rounding can't escape the bar

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeContextPercent } from "../../server/lib/context-percent.js";

test("computeContextPercent: 1-decimal rounding for the headline case", () => {
  // 1521 / 512000 * 100 = 0.297… → 0.3 (not 0)
  assert.equal(computeContextPercent(1521, 512000), 0.3);
});

test("computeContextPercent: zero usage is exactly 0", () => {
  assert.equal(computeContextPercent(0, 512000), 0);
});

test("computeContextPercent: negative used is clamped to 0", () => {
  // The component gates on Math.max(0, used), but a misuse path or a future
  // refactor could still produce a negative input. Zero is the safe answer.
  assert.equal(computeContextPercent(-100, 512000), 0);
});

test("computeContextPercent: limit<=0 returns 0 (defensive)", () => {
  // Divide-by-zero guard. The webui never paints percent without a valid
  // limit, but the helper must remain total — SSE / JSON consumers can call
  // it during reset windows where limit is still 0.
  assert.equal(computeContextPercent(1521, 0), 0);
  assert.equal(computeContextPercent(1521, -100), 0);
});

test("computeContextPercent: 100% clamps exactly at 100", () => {
  assert.equal(computeContextPercent(512000, 512000), 100);
  // Over-limit (a misbehaving engine reporting more than window) clamps too:
  // 110% of the bar width is a lie.
  assert.equal(computeContextPercent(563200, 512000), 100);
});

test("computeContextPercent: 1-decimal boundary at the integer % marks", () => {
  // 950 / 1000 = 95% — the integer band should round to 95 (integer band).
  assert.equal(computeContextPercent(950, 1000), 95);
  // 99.5% stays at 99.5 (1-decimal precision, NOT clamped to 100 — clamp only
  // fires at ratio ≥ 100% i.e. `used > limit`).
  assert.equal(computeContextPercent(995, 1000), 99.5);
  // Just under 10% (9.94%) should round to 9.9, not 10.
  assert.equal(computeContextPercent(994, 10000), 9.9);
  // Just over 10% rounds up to 10.
  assert.equal(computeContextPercent(995, 10000), 10);
});

test("computeContextPercent: tiny positive ratio is non-zero", () => {
  // Below 1% the client renders "<1%". The helper still emits a numeric value
  // (e.g. 0.1) so callers that DO want the exact number have it; the < 1%
  // display fallback lives in the client. This test pins that contract.
  assert.equal(computeContextPercent(1, 1000), 0.1);
  assert.equal(computeContextPercent(512, 512000), 0.1);
});