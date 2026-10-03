/**
 * The context-window panel's pure logic (roadmap H, 模型与用量).
 *
 * Split out of `components/context-meter.tsx` so the tests drive THIS code
 * rather than a hand-copied mirror of it. That mirror used to exist and was
 * free to drift: the component was edited and the test kept passing because it
 * was asserting its own copy. The same reason `lib/effort-control.ts` and
 * `lib/model-groups.ts` exist for the thinking controls.
 *
 * The panel is a 1:1 replica of the reference's context-window popover:
 *
 *   上下文窗口                    29% ⌄     ← title + percent, a disclosure
 *   ▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░              ← one bar, one colour
 *   ■ 消息        71.9%            ← the breakdown, only when the engine
 *   ■ 工具        13.1%               actually reports it
 *     …
 *   ────────────────────────────
 *   套餐用量 · Explore
 *   5 小时限额          0% / 100%   ← the same two rows the settings page
 *   ▓░░░░░░░░░░░░░░░░░░░░░░         draws, through the same `UsageBar`
 *   4小时57分后重置
 *   周限额              16% / 100%
 *   ▓▓▓░░░░░░░░░░░░░░░░░░░
 *   4天2小时后重置
 *
 * Two rules the shape above depends on, and why they are here rather than
 * inline in the component:
 *
 * 1. **The breakdown is never invented.** `context.breakdown` is `null` today
 *    — the engine does not emit it (`server/lib/state-bus.js` says so at the
 *    field itself). A row is drawn only for a category the engine reported a
 *    non-zero token count for, so the panel never shows a percentage this
 *    process invented. When the engine starts sending the block, the rows
 *    appear with no change here.
 * 2. **The quota rows are the settings page's rows.** Same two figures, same
 *    "remaining → used" inversion, same reset caption. The panel used to read
 *    `context.plan`, which nothing ever populates, so the 套餐 section could
 *    not render at all.
 */

import type { QuotaSnapshot } from "./api";
import type { MessageKey } from "./i18n";

/**
 * A context-window percentage, the way the panel header prints it.
 *
 *   p ≤ 0      → "0%"        (no usage reported yet)
 *   0 < p < 1  → "<1%"       (used > 0 but rounds to 0; never collapse to "0%")
 *   1 ≤ p < 10 → "3.5%"      (1-decimal place, matches server-side rounding)
 *   p ≥ 10     → "47%"       (integer; sub-percent digits are noise)
 *
 * The server sends it rounded to 1 decimal (`computeContextPercent` in
 * server/lib/sessions.js), so the intermediate band shows real precision
 * instead of two-decimal noise like "3.4567%".
 */
export function formatPercent(
  p: number,
  t: (key: MessageKey) => string,
): string {
  if (p <= 0) return "0%";
  if (p < 1) return t("context.lessThanOne");
  if (p < 10) return `${p.toFixed(1)}%`;
  return `${Math.round(p)}%`;
}

// The category order the reference draws, top to bottom. This is the
// `data-kind` order the engine's own payload uses, so the panel and the wire
// format cannot disagree about what "first" means.
//
// The swatch colours are the upstream `n7` context-window palette (see
// `icons`/`surface` tokens); the reference screenshot's swatches are too small
// to sample a distinct colour from, so the palette is kept and only the ORDER
// was taken from the screenshot.
export const CONTEXT_BREAKDOWN_CATEGORIES = [
  { key: "messages", labelKey: "context.breakdown.messages", color: "var(--swatch-c1, #3b82f6)" },
  { key: "tools", labelKey: "context.breakdown.tools", color: "var(--swatch-c2, #ec4899)" },
  { key: "memory", labelKey: "context.breakdown.memory", color: "var(--swatch-c3, #a855f7)" },
  { key: "skills", labelKey: "context.breakdown.skills", color: "var(--swatch-c4, #f97316)" },
  { key: "other", labelKey: "context.breakdown.other", color: "var(--swatch-c5, #6b7280)" },
  { key: "systemPrompt", labelKey: "context.breakdown.systemPrompt", color: "var(--swatch-c6, #14b8a6)" },
] as const;

export type ContextBreakdownKey =
  (typeof CONTEXT_BREAKDOWN_CATEGORIES)[number]["key"];

export interface ContextBreakdownRow {
  key: ContextBreakdownKey;
  labelKey: MessageKey;
  color: string;
  tokens: number;
  percent: number;
}

/**
 * The breakdown rows to draw, in the reference's order.
 *
 * Empty array means "the engine told us nothing", and the caller must then
 * draw no rows at all rather than a set of zeroes. A zero row is not a
 * neutral absence here — it is a claim that the category occupies no tokens,
 * which is exactly the kind of fact this process cannot make up.
 */
export function contextBreakdownRows(
  breakdown: Record<string, number> | null | undefined,
  total: number,
): ContextBreakdownRow[] {
  if (!breakdown || total <= 0) return [];
  const rows: ContextBreakdownRow[] = [];
  for (const entry of CONTEXT_BREAKDOWN_CATEGORIES) {
    const raw = breakdown[entry.key];
    const tokens = typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, raw) : 0;
    if (tokens === 0) continue;
    rows.push({
      key: entry.key,
      labelKey: entry.labelKey,
      color: entry.color,
      tokens,
      percent: (tokens / total) * 100,
    });
  }
  return rows;
}

export interface QuotaPlanRow {
  key: "fiveHour" | "weekly";
  labelKey: MessageKey;
  /** Used percent, or null when there is no figure to draw a gauge from. */
  used: number | null;
  /** The 5-hour row prints "used% / 100%"; the weekly row prints "used%". */
  withTotal: boolean;
  resetAt?: number;
  /** The standing line for the figure slot when `used` is null. */
  placeholderKey: MessageKey;
}

/**
 * The two quota rows the reference's 套餐 section carries.
 *
 * `remaining` is what is left; the bar reports what was used — the same
 * inversion the settings page's `UsageCard` applies, so the two surfaces cannot
 * print different numbers for the same plan. A missing figure stays `null`
 * ("no gauge to draw") and never becomes 0%, because "we know nothing" and
 * "you have used nothing" are different facts.
 *
 * The 视频限额 row the settings card carries is deliberately NOT here: the
 * reference's popover shows two rows, and the third is a video figure this
 * edition has no source for in a context flyout.
 */
export function quotaPlanRows(quota: QuotaSnapshot | null | undefined): QuotaPlanRow[] {
  const ok = quota?.ok === true;
  const usedFromRemaining = (remaining: number | undefined) =>
    typeof remaining === "number" ? Math.max(0, Math.min(100, 100 - remaining)) : null;

  return [
    {
      key: "fiveHour",
      labelKey: "usage.fiveHour",
      used: usedFromRemaining(ok ? quota?.remaining : undefined),
      withTotal: true,
      resetAt: ok ? quota?.resetAt : undefined,
      placeholderKey: "usage.unavailable",
    },
    {
      key: "weekly",
      labelKey: "usage.weekly",
      used: usedFromRemaining(ok ? quota?.weeklyRemaining : undefined),
      withTotal: false,
      resetAt: ok ? quota?.weeklyResetAt : undefined,
      placeholderKey: "usage.unavailable",
    },
  ];
}
