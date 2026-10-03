"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useSessionContext } from "@/lib/store";
import {
  contextBreakdownRows,
  formatPercent,
  quotaPlanRows,
  showPlanSection,
} from "@/lib/context-breakdown";
import { Icon } from "./icons";
import { UsageBar, resetCaption } from "./usage-models-cards";
import type { MessageKey } from "@/lib/i18n";

/**
 * Context-window meter, sat next to the composer.
 *
 * The desktop client puts a context-window readout beside the input box: a
 * small ring that opens a panel titled 上下文窗口 carrying the used
 * percentage, one bar, the per-category breakdown, and the plan's quota
 * windows. That panel is the reference this file replicates, row for row.
 *
 * The three things it draws come from three different places, and the split
 * is the reason none of them can drift from their own source:
 *
 * - the window itself (`used` / `limit` / `percent` / `breakdown`) from the
 *   state snapshot's `context` block;
 * - the quota rows from the SAME `quota` store the settings page reads, drawn
 *   through the SAME `UsageBar` component — this panel used to read
 *   `context.plan`, which nothing populates, so the 套餐 section could not
 *   render at all;
 * - the plan's own name from `state.usage.plan`, printed after 套餐用量.
 *
 * Nothing is invented. All six breakdown rows are always listed — that is the
 * reference's set, and a category the engine did not report prints a dash
 * rather than a share, which is the one claim this process is entitled to
 * about it. A missing quota figure likewise stays a placeholder rather than
 * becoming 0%.
 *
 * The pure parts — the percentage format, the breakdown rows, the quota rows —
 * live in `lib/context-breakdown.ts` so the tests drive the same functions
 * this component calls instead of a copy of them.
 *
 * The panel is portalled and `fixed`, for the same reason the composer's other
 * popups are: the composer card and the content column are `overflow-hidden`,
 * so an anchored child gets clipped by its ancestors.
 */

// Upstream's values. The ring is drawn on a 14x14 frame with r=6 and strokeWidth=2 —
// 6 + 2/2 = 7 = half the frame, so the stroke sits flush inside it — and the trigger is
// a bare 30x30 square: the percentage lives in the panel, not next to the ring.
const PANEL_WIDTH = 400;
const RING_SIZE = 14;
const RING_STROKE = 2;
const RING_RADIUS = 6;
const TRACK_COLOR = "var(--bg_interaction_secondary_hover)";

export function ContextMeter({ t }: { t: (key: MessageKey) => string }) {
  const { state, quota } = useSessionContext();
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<{ left: number; bottom: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const place = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.min(
      Math.max(8, rect.right - PANEL_WIDTH),
      Math.max(8, window.innerWidth - PANEL_WIDTH - 8),
    );
    setPlacement({ left, bottom: window.innerHeight - rect.top + 8 });
  }, []);

  useEffect(() => {
    if (open) place();
    else setPlacement(null);
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);

  const context = state?.context;
  // Nothing to report before the first snapshot, or when the engine has not told
  // us a window size.
  if (!context || !context.limit) return null;

  const used = Math.max(0, context.used ?? context.tokens ?? 0);
  const limit = context.limit;
  // Server's `context.percent` is already rounded to 1 decimal (see
  // server/lib/sessions.js computeContextPercent). Use it as-is when present
  // so 1521/512000 (≈0.297%) lands on 0.3 instead of being collapsed again to
  // 0 by a second client-side round. Fall back to recomputing from used/limit
  // when the server hasn't reported it yet.
  const percent = Math.max(
    0,
    Math.min(100, context.percent ?? (used / limit) * 100),
  );
  const dash = 2 * Math.PI * ((RING_SIZE - RING_STROKE) / 2);

  // The title row is a disclosure. The reference's collapsed state carries a
  // chevron DOWN and its expanded state a chevron UP — the panel grows upward
  // (it opens above the composer), so the arrow points the way the content
  // went. It used to be chevronRight/chevronDown, which reads as a sideways
  // affordance for a vertical one.
  const [expanded, setExpanded] = useState(false);
  const breakdown = contextBreakdownRows(context.breakdown, used);
  // Token Plan meters MiniMax usage, so the section belongs to the model in
  // play and not to the account — see `showPlanSection`. The rows are still
  // built unconditionally (they cost nothing) so the decision stays in one
  // testable place rather than being spread across the JSX.
  const planRows = quotaPlanRows(quota);
  const showPlan = showPlanSection(state?.model?.name);
  const planTitle = state?.usage?.plan;

  return (
    <div className="flex items-center">
      <button
        ref={triggerRef}
        type="button"
        aria-label={t("context.show")}
        // The hover text NAMES the control ("上下文窗口"); the aria-label
        // states the ACTION ("显示上下文窗口用量"). The panel's own title
        // already says 上下文窗口, so a tooltip repeating the action told the
        // user nothing they could not read off the button they were pointing at.
        title={t("context.title")}
        aria-expanded={open}
        data-testid="context-meter"
        onClick={() => setOpen((value) => !value)}
        className="flex size-[30px] shrink-0 items-center justify-center rounded-[10px] text-icon_default_secondary transition-colors hover:bg-bg_interaction_tertiary_hover"
      >
        <svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} aria-hidden="true">
          <circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            stroke={TRACK_COLOR}
            strokeWidth={RING_STROKE}
          />
          <circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth={RING_STROKE}
            strokeLinecap="round"
            strokeDasharray={`${(percent / 100) * dash} ${dash}`}
            transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
          />
        </svg>
      </button>

      {open && placement && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={panelRef}
              role="dialog"
              aria-label={t("context.title")}
              data-testid="context-panel"
              style={{ left: placement.left, bottom: placement.bottom, width: PANEL_WIDTH }}
              className="fixed z-[200] flex max-w-[calc(100vw-32px)] flex-col gap-3 rounded-[16px] border-[0.5px] border-border_default bg-bg_grouped_secondary_elevated p-4 shadow-[0_0_24px_0_var(--shadow_default)]"
            >
              {/* The reference's header: the title on the left, the percentage
                  and the disclosure chevron on the right, both in one row. */}
              <button
                type="button"
                aria-expanded={expanded}
                aria-label={expanded ? t("context.collapseAria") : t("context.expandAria")}
                onClick={() => setExpanded((value) => !value)}
                className="desktop-text-ui-body flex w-full items-center justify-between gap-4 text-sm leading-5"
              >
                <span className="text-text_default_secondary">{t("context.title")}</span>
                <span
                  className="flex items-center gap-0.5 text-text_default_primary"
                  data-testid="context-usage-expand-icon"
                  data-state={expanded ? "expanded" : "collapsed"}
                >
                  <span className="tabular-nums">{formatPercent(percent, t)}</span>
                  <Icon
                    name={expanded ? "chevronUp" : "chevronDown"}
                    size={16}
                    className="text-icon_default_tertiary"
                  />
                </span>
              </button>

              {/* One bar, one colour. The reference does not segment it even
                  when it has a breakdown to draw underneath — the rows carry
                  the composition, and a second encoding of the same fact in a
                  4px strip is not readable at that size anyway. */}
              <div
                className="h-1 w-full overflow-hidden rounded-full bg-border_default"
                role="progressbar"
                aria-label={t("context.title")}
                aria-valuenow={Math.round(percent)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className="h-full rounded-full bg-icon_default_accent"
                  style={{ width: `${percent}%` }}
                  data-testid="context-progress-bar"
                />
              </div>

              {/* The composition, in the reference's order, all six rows
                  whether or not the engine reported any of them. A category
                  with no share prints a dash — see
                  `contextBreakdownRows` for why that is not a zero. */}
              {expanded ? (
                <dl
                  className="desktop-text-ui-small flex flex-col gap-1.5"
                  data-testid="context-breakdown"
                >
                  {breakdown.map((row) => (
                    <div key={row.key} className="flex items-center justify-between gap-4">
                      <dt className="flex min-w-0 items-center gap-2 text-text_default_tertiary">
                        <span
                          className="size-2 rounded-[2px]"
                          style={{ backgroundColor: row.color }}
                          aria-hidden="true"
                        />
                        <span className="truncate">{t(row.labelKey)}</span>
                      </dt>
                      <dd className="tabular-nums text-text_default_secondary">
                        {row.percent === null ? (
                          <>
                            <span aria-hidden="true">—</span>
                            <span className="sr-only">{t("context.breakdown.unreported")}</span>
                          </>
                        ) : (
                          `${row.percent.toFixed(1)}%`
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}

              {context.tps ? (
                <dl className="desktop-text-ui-small flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-text_default_tertiary">{t("context.speed")}</dt>
                    <dd className="tabular-nums text-text_default_secondary">
                      {Math.round(context.tps)} token/s
                    </dd>
                  </div>
                </dl>
              ) : null}

              {/* The plan's quota windows — the settings page's two rows,
                  through the settings page's own `UsageBar`, so a figure can
                  never read differently in the two places it appears. The
                  section renders even with no figure: `UsageBar` then prints
                  its placeholder, which is what the settings card does too.
                  It is a MINIMAX section though: a Token Plan meters MiniMax
                  usage, so showing it beside a BYOK model from another
                  provider would be reading one plan's allowance against a
                  model that does not spend it. */}
              {showPlan ? (
                <section
                  className="border-t-[0.5px] border-border_default pt-3"
                  data-testid="context-plan-section"
                >
                  <div className="desktop-text-ui-body mb-2 flex w-full items-center justify-between gap-4 text-sm leading-5">
                    <span className="text-text_default_secondary">
                      {t("context.planTitle")}
                      {planTitle ? ` · ${planTitle}` : ""}
                    </span>
                  </div>
                  <div className="flex flex-col gap-3">
                    {planRows.map((row) => (
                      <UsageBar
                        key={row.key}
                        testId={`context-quota-${row.key}`}
                        label={t(row.labelKey)}
                        used={row.used}
                        withTotal={row.withTotal}
                        placeholder={t(row.placeholderKey)}
                        caption={row.used !== null && row.resetAt ? resetCaption(row.resetAt, t) : null}
                      />
                    ))}
                  </div>
                </section>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
