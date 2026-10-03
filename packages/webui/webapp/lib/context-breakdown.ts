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
 *   ■ 消息        71.9%            ← the six categories, always listed
 *   ■ 工具        13.1%               in the reference's order; a category
 *     …                               the engine did not report prints a
 *   ────────────────────────────         dash rather than a share
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
 *    field itself), and nothing in this stack can reconstruct it: the runtime
 *    records `input_tokens` / `output_tokens` / `cache_read_tokens`, and those
 *    three are wire-level counters, not the six semantic buckets below. So the
 *    rows list all six and say "not reported" for each. Drawing `0.0%` would
 *    be a different claim — that the engine told us the category is empty —
 *    and it is not one this process gets to make. When the engine starts
 *    sending the block, the same six rows fill in with no change here.
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
  /**
   * The engine's token count for this category, or `null` when the engine
   * said nothing about it. `null` and `0` are different facts and stay
   * different all the way to the DOM: `0` is "the engine reported this
   * category and it holds no tokens", `null` is "we were not told".
   */
  tokens: number | null;
  /**
   * Share of the used window, or `null` when it cannot be computed —
   * either the engine never reported the category, or it reported one but
   * `total` is 0, so every share would be a division by zero.
   */
  percent: number | null;
}

/**
 * The breakdown rows to draw: always all six, in the reference's order.
 *
 * The panel lists the same categories the reference does whether or not the
 * engine has numbers for them, and a category it has not reported prints a
 * dash instead of a figure. That is the whole reason this returns a full list
 * rather than filtering: a category drawn as `0.0%` claims the engine said
 * "this holds no tokens", which is a claim this process cannot make on the
 * engine's behalf. A dash claims only what is true — nothing arrived.
 *
 * So the three states stay distinguishable end to end:
 *
 *   breakdown absent      → all six rows, every share `null`
 *   category absent       → that row `null`, the reported ones keep their shares
 *   category reported `0` → that row `0`, and `0.0%` is drawn
 */
export function contextBreakdownRows(
  breakdown: Record<string, number> | null | undefined,
  total: number,
): ContextBreakdownRow[] {
  return CONTEXT_BREAKDOWN_CATEGORIES.map((entry) => {
    const raw = breakdown?.[entry.key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return { key: entry.key, labelKey: entry.labelKey, color: entry.color, tokens: null, percent: null };
    }
    const tokens = Math.max(0, raw);
    return {
      key: entry.key,
      labelKey: entry.labelKey,
      color: entry.color,
      tokens,
      percent: total > 0 ? (tokens / total) * 100 : null,
    };
  });
}

/**
 * The provider id the engine files its own MiniMax models under — the same
 * `BUILTIN_PROVIDER` the server's catalogue uses (`server/engine/
 * model-reads.js`). It is the prefix of a wire model id
 * (`minimax_api/MiniMax-M3`).
 */
export const MINIMAX_PROVIDER_ID = "minimax_api";

/**
 * Whether the panel's 套餐 section belongs to the model in play.
 *
 * Token Plan is MiniMax's subscription: its 5-hour and weekly quotas meter
 * *MiniMax* usage, so they are meaningless — and quietly wrong — beside a
 * BYOK model from another provider. A user on a Token Plan who switches to
 * `zhipu-ai-coding-plan/glm-5.3` would be reading MiniMax's allowance
 * against a model that does not spend it.
 *
 * The wire id's provider prefix decides it, not the account. An account may
 * be subscribed and still be driving a foreign model, and vice versa, and
 * only the second is what this section has anything to say about.
 *
 * The failure directions are not symmetric, so the default is chosen: an
 * unrecognised shape (no `/`, an empty prefix, no model at all) HIDES the
 * section. Hiding it costs a missing block; showing MiniMax's plan next to
 * someone else's model is a factually wrong one.
 */
export function showPlanSection(modelName: string | null | undefined): boolean {
  const value = (modelName ?? "").trim();
  if (!value) return false;
  const slash = value.indexOf("/");
  // Both halves have to be there. A missing separator means the id is not in
  // `<provider>/<model>` form, and a trailing separator means it names no
  // model at all — neither identifies anything the section could belong to.
  if (slash <= 0 || slash === value.length - 1) return false;
  return value.slice(0, slash) === MINIMAX_PROVIDER_ID;
}

export interface QuotaPlanRow {  key: "fiveHour" | "weekly";
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
