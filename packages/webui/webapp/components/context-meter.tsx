"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useSessionContext } from "@/lib/store";
import { Icon } from "./icons";
import type { MessageKey } from "@/lib/i18n";

/**
 * Context-window meter, sat next to the composer.
 *
 * The desktop client puts a context-window readout beside the input box: a
 * small control that opens a panel titled 上下文窗口 with the used percentage,
 * a progress bar, and a breakdown of what is filling the window.
 *
 * What is drawn comes straight from the state snapshot's `context` block —
 * `used`, `limit`, `percent`, `tps`, optionally `breakdown` (a per-category
 * composition like { systemPrompt: 12, memory: 4, tools: 30, skills: 2,
 * messages: 50, other: 2 } in absolute tokens, summing to `used`) and `plan`
 * (a { title, rows[] } describing the active subscription tier). Nothing is
 * invented: when breakdown / plan are absent, the segmented progress bar
 * collapses to the single-segment fallback and the per-category rows are not
 * rendered, exactly as SPEC §E row 138 ('else 单段') and row 139
 * ('依赖后端数据') specify.
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

/**
 * Format a context-window percentage for the panel header.
 *
 *   0            → "0%"          (no usage reported yet)
 *   0 < p < 1    → "<1%"         (used > 0 but rounds to 0; never collapse to "0%")
 *   1 ≤ p < 10   → "3.5%"        (1-decimal place, matches server-side rounding)
 *   p ≥ 10       → "47%"         (integer; sub-percent digits are noise)
 *
 * The server sends it rounded to 1 decimal (`computeContextPercent` in
 * server/lib/sessions.js), so the intermediate band (1–9.9%) shows real
 * precision instead of two-decimal noise like "3.4567%".
 */
function formatPercent(p: number, t: (key: MessageKey) => string): string {
  if (p <= 0) return "0%";
  if (p < 1) return t("context.lessThanOne");
  if (p < 10) return `${p.toFixed(1)}%`;
  return `${Math.round(p)}%`;
}

// SPEC §E row 140 — canonical category order, drawn top-to-bottom in the panel.
// Each entry maps the snake_case `data-kind` key (which the engine will send)
// to its label key and to a colour swatch drawn from the upstream palette.
//
// The colour index follows upstream's `n7` family (context-window segment
// palette); we render with a CSS variable indirection so the test harness
// does not need to know hex values.
const BREAKDOWN_CATEGORIES = [
  { key: "systemPrompt", labelKey: "context.breakdown.systemPrompt", color: "var(--swatch-c1, #3b82f6)" },
  { key: "memory",       labelKey: "context.breakdown.memory",       color: "var(--swatch-c2, #a855f7)" },
  { key: "tools",        labelKey: "context.breakdown.tools",        color: "var(--swatch-c3, #ec4899)" },
  { key: "skills",       labelKey: "context.breakdown.skills",       color: "var(--swatch-c4, #f97316)" },
  { key: "messages",     labelKey: "context.breakdown.messages",     color: "var(--swatch-c5, #14b8a6)" },
  { key: "other",        labelKey: "context.breakdown.other",        color: "var(--swatch-c6, #6b7280)" },
] as const;

type BreakdownCategoryKey = typeof BREAKDOWN_CATEGORIES[number]["key"];

function breakdownRows(
  breakdown: Record<string, number> | null | undefined,
  total: number,
): { key: BreakdownCategoryKey; tokens: number; percent: number; color: string; labelKey: string }[] {
  if (!breakdown || total <= 0) return [];
  return BREAKDOWN_CATEGORIES
    .map((entry) => {
      const tokens = Math.max(0, breakdown[entry.key] ?? 0);
      return tokens === 0
        ? null
        : {
            key: entry.key as BreakdownCategoryKey,
            tokens,
            percent: (tokens / total) * 100,
            color: entry.color,
            labelKey: entry.labelKey,
          };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);
}

export function ContextMeter({ t }: { t: (key: MessageKey) => string }) {
  const { state } = useSessionContext();
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

  // SPEC §E row 137 — the title row is a clickable disclosure. Collapsed it
  // shows the percentage and a chevron-right hint; expanded reveals the
  // per-category breakdown and flips to a chevron-down. Upstream's
  // `t_rendered` button uses `chevronRight` collapsed / `chevronDown`
  // expanded; we mirror that with the existing icons.
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="flex items-center">
      <button
        ref={triggerRef}
        type="button"
        aria-label={t("context.show")}
        title={t("context.show")}
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
              {/* Upstream's header is `desktop-text-ui-body` (14/21/430) with the
                  percentage right-aligned in tabular figures, followed by a
                  chevron that expands/collapses the per-category breakdown.
                  Per SPEC §E row 137 the title is a `<button>` that toggles
                  `expanded`; the chevron mirrors `chevronRight`/`chevronDown`.
                  `data-testid="context-usage-expand-icon"` + `data-state`
                  mirror upstream's test harness. */}
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
                    name={expanded ? "chevronDown" : "chevronRight"}
                    size={16}
                    className="text-icon_default_tertiary"
                  />
                </span>
              </button>

              {/* SPEC §E row 138 — segmented progress bar when breakdown is
                  available, single bar otherwise. We key off breakdown as the
                  single source of truth: if it has any non-zero entry, the
                  engine is committed to per-category reporting and the
                  segmented bar is shown. */}
              <div
                className="h-1 w-full overflow-hidden rounded-full bg-bg_grouped_tertiary_elevated"
                role="progressbar"
                aria-valuenow={Math.round(percent)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                {(() => {
                  const rows = breakdownRows(context.breakdown, used);
                  if (rows.length === 0) {
                    return (
                      <div
                        className="h-full rounded-full bg-icon_default_accent"
                        style={{ width: `${percent}%` }}
                        data-testid="context-progress-single"
                      />
                    );
                  }
                  return (
                    <div className="flex h-full w-full" data-testid="context-progress-segmented">
                      {rows.map((row) => (
                        <div
                          key={row.key}
                          className="h-full"
                          style={{
                            width: `${row.percent}%`,
                            backgroundColor: row.color,
                          }}
                          data-kind={row.key}
                          data-context-window-progress-segment="true"
                          title={`${row.key}: ${row.tokens.toLocaleString()}`}
                        />
                      ))}
                    </div>
                  );
                })()}
              </div>

              {/* SPEC §E row 139 — per-category breakdown rows. Hidden until
                  the user opens the disclosure AND breakdown is non-empty, so we
                  never show a fabricated row. */}
              {(() => {
                const rows = breakdownRows(context.breakdown, used);
                if (rows.length === 0 || !expanded) return null;
                return (
                  <dl className="desktop-text-ui-small flex flex-col gap-1.5" data-testid="context-breakdown">
                    {rows.map((row) => (
                      <div key={row.key} className="flex items-center justify-between gap-4">
                        <dt className="flex min-w-0 items-center gap-2 text-text_default_tertiary">
                          <span
                            className="size-2 rounded-[2px]"
                            style={{ backgroundColor: row.color }}
                            aria-hidden="true"
                          />
                          <span className="truncate">{t(row.labelKey as MessageKey)}</span>
                        </dt>
                        <dd className="tabular-nums text-text_default_secondary">
                          {row.percent.toFixed(1)}%
                        </dd>
                      </div>
                    ))}
                  </dl>
                );
              })()}

              <dl className="desktop-text-ui-small flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-text_default_tertiary">{t("context.used")}</dt>
                  <dd className="tabular-nums text-text_default_secondary">
                    {used.toLocaleString()} / {limit.toLocaleString()}
                  </dd>
                </div>
                {context.tps ? (
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-text_default_tertiary">{t("context.speed")}</dt>
                    <dd className="tabular-nums text-text_default_secondary">
                      {Math.round(context.tps)} token/s
                    </dd>
                  </div>
                ) : null}
              </dl>

              {/* SPEC §E row 141 — plan usage section. Hidden until the engine
                  reports a non-empty plan. */}
              {context.plan && Array.isArray(context.plan.rows) && context.plan.rows.length > 0 ? (
                <section
                  className="mt-3 border-t-[0.5px] border-border_default pt-3"
                  data-testid="context-plan-section"
                >
                  <div className="desktop-text-ui-body mb-2 flex w-full items-center justify-between gap-4 text-sm leading-5">
                    <span className="text-text_default_secondary">
                      {t("context.planTitle")}
                      {context.plan.title ? ` · ${context.plan.title}` : ""}
                    </span>
                  </div>
                  <dl className="desktop-text-ui-small flex flex-col gap-1.5">
                    {context.plan.rows.map((row, index) => (
                      <div
                        key={index}
                        className="flex items-center justify-between gap-4"
                        data-context-usage-plan-row="true"
                      >
                        <dt className="text-text_default_tertiary">
                          {row.label ?? ""}
                        </dt>
                        <dd className="tabular-nums text-text_default_secondary">
                          {row.value ?? ""}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
